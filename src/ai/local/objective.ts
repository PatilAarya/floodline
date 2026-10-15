/**
 * The objective (energy) that local search minimises, for an assignment of
 * evacuee groups to relief centres. Everything is in PERSON-MINUTES so the
 * terms can be added and explained:
 *
 *   travel      sum over groups of  size * travel time to its centre
 *   risk        lambda * sum of size * exposure, where exposure is the
 *               flood probability of each road on the route times the
 *               minutes spent on it (the same lambda as risk-aware A*)
 *   overload    OVERLOAD per person above a centre's capacity. Local search
 *               may break the capacity constraint temporarily; this makes
 *               that very expensive, so final plans respect it
 *   imbalance   IMBALANCE * sum over centres of capacity * (fill - mean fill)^2
 *               crowded centres are slower to admit people and worse to stay in
 *   split       SPLIT per extra centre a neighbourhood is spread over
 *               (the soft "keep neighbourhoods together" constraint)
 *   change      CHANGE per person sent to a different centre than `prefer`
 *               (only when re-planning a running evacuation: people already
 *               told where to go should not be moved for a tiny gain)
 *   unsheltered UNSHELTERED per person left without a centre although some
 *               centre was allowed (only in relaxed plans). Groups with no
 *               allowed centre at all cannot be helped by any plan, so they
 *               are reported separately and add nothing to the energy
 *
 * `AssignmentState` keeps the running totals and can apply a move in
 * O(number of centres), so a neighbour's energy is cheap to evaluate:
 * apply the move, read the energy, apply the reverse move.
 */
import type { Rng } from '../../core/rng';

export interface Weights {
  /** Risk weight lambda (0 = ignore flood risk on the way). */
  lambda: number;
  /** Person-minutes per person over capacity. */
  overload: number;
  /** Person-minutes per unit of capacity * squared fill difference. */
  imbalance: number;
  /** Person-minutes per extra centre used by one neighbourhood. */
  split: number;
  /** Person-minutes per person left without a centre. */
  unsheltered: number;
  /** Person-minutes per person moved away from their previous centre (0 = no penalty). */
  change?: number;
}

export const DEFAULT_WEIGHTS: Weights = { lambda: 2, overload: 600, imbalance: 500, split: 15000, unsheltered: 1000 };

export interface AssignmentModel {
  /** Groups, centres, neighbourhoods. */
  G: number;
  S: number;
  H: number;
  size: Float64Array;
  capacity: Float64Array;
  /** Neighbourhood of each group, 0 .. H-1. */
  hood: Int32Array;
  /** Minutes from group g to centre s at [g * S + s]. */
  time: Float64Array;
  /** Risk-weighted minutes on flood-prone roads, same layout. */
  exposure: Float64Array;
  /** Centres each group may use (its CSP domain). */
  options: Int32Array[];
  weights: Weights;
  /** Previous centre of each group (-1 none); with weights.change, moving costs. */
  prefer?: Int32Array;
}

export interface EnergyParts {
  travel: number;
  risk: number;
  overload: number;
  imbalance: number;
  split: number;
  unsheltered: number;
  change: number;
}

/** A move: set group g to centre s (a reassignment is one change, a swap two). */
export type Move = [g: number, s: number][];

export class AssignmentState {
  readonly m: AssignmentModel;
  readonly assign: Int32Array;
  readonly load: Float64Array;
  /** People of neighbourhood h in centre s, at [h * S + s], and distinct centres per hood. */
  private hoodUse: Float64Array;
  private hoodDistinct: Int32Array;
  private groupSum = 0;
  private changeSum = 0;
  private riskSum = 0;
  private unshelteredSum = 0;
  private splitSum = 0;
  private shelterOverload = 0;
  private shelterImbalance = 0;
  private totalCap: number;

  constructor(m: AssignmentModel, start: Int32Array) {
    this.m = m;
    this.assign = new Int32Array(m.G).fill(-1);
    this.load = new Float64Array(m.S);
    this.hoodUse = new Float64Array(m.H * m.S);
    this.hoodDistinct = new Int32Array(m.H);
    this.totalCap = m.capacity.reduce((a, b) => a + b, 0);
    for (let g = 0; g < m.G; g++) this.unshelteredSum += this.penalty(g);
    for (let g = 0; g < m.G; g++) if (start[g] >= 0) this.set(g, start[g]);
    this.updateShelterTerms();
  }

  /** Total energy (person-minutes). */
  get energy(): number {
    return this.groupSum + this.changeSum + this.m.weights.lambda * this.riskSum + this.unshelteredSum + this.splitSum + this.shelterOverload + this.shelterImbalance;
  }

  parts(): EnergyParts {
    return { travel: this.groupSum, risk: this.m.weights.lambda * this.riskSum, overload: this.shelterOverload, imbalance: this.shelterImbalance, split: this.splitSum, unsheltered: this.unshelteredSum, change: this.changeSum };
  }

  /** Apply a move. Returns the move that undoes it. */
  apply(move: Move): Move {
    const undo: Move = move.map(([g]) => [g, this.assign[g]]);
    for (const [g, s] of move) this.set(g, s);
    this.updateShelterTerms();
    return undo.reverse();
  }

  /** Energy change a move would cause, without keeping it. */
  delta(move: Move): number {
    const before = this.energy;
    const undo = this.apply(move);
    const after = this.energy;
    this.apply(undo);
    return after - before;
  }

  /** Rebuild every total from scratch (removes floating-point drift). */
  recompute(): void {
    const a = this.assign.slice();
    this.assign.fill(-1);
    this.load.fill(0);
    this.hoodUse.fill(0);
    this.hoodDistinct.fill(0);
    this.groupSum = this.riskSum = this.splitSum = this.changeSum = 0;
    this.unshelteredSum = 0;
    for (let g = 0; g < this.m.G; g++) this.unshelteredSum += this.penalty(g);
    for (let g = 0; g < this.m.G; g++) if (a[g] >= 0) this.set(g, a[g]);
    this.updateShelterTerms();
  }

  /** Move group g to centre s (-1 = none), updating the per-group and per-hood terms. */
  private set(g: number, s: number): void {
    const m = this.m, S = m.S, size = m.size[g], h = m.hood[g];
    const old = this.assign[g];
    if (old === s) return;
    if (old >= 0) {
      this.groupSum -= size * m.time[g * S + old];
      this.changeSum -= this.changeCost(g, old);
      this.riskSum -= size * m.exposure[g * S + old];
      this.load[old] -= size;
      this.changeHood(h, old, -size);
    } else {
      this.unshelteredSum -= this.penalty(g);
    }
    if (s >= 0) {
      this.groupSum += size * m.time[g * S + s];
      this.changeSum += this.changeCost(g, s);
      this.riskSum += size * m.exposure[g * S + s];
      this.load[s] += size;
      this.changeHood(h, s, size);
    } else {
      this.unshelteredSum += this.penalty(g);
    }
    this.assign[g] = s;
  }

  /** Penalty for putting group g in centre s when it was told to go elsewhere. */
  private changeCost(g: number, s: number): number {
    const w = this.m.weights.change ?? 0, p = this.m.prefer;
    return w > 0 && p && p[g] >= 0 && p[g] !== s ? w * this.m.size[g] : 0;
  }

  /** Cost of leaving group g without a centre (0 if it has no allowed centre anyway). */
  private penalty(g: number): number {
    return this.m.options[g].length > 0 ? this.m.size[g] * this.m.weights.unsheltered : 0;
  }

  private changeHood(h: number, s: number, people: number): void {
    const k = h * this.m.S + s;
    const before = this.hoodUse[k] > 0.5;
    this.hoodUse[k] += people;
    const after = this.hoodUse[k] > 0.5;
    if (before === after) return;
    const d0 = this.hoodDistinct[h];
    const d1 = d0 + (after ? 1 : -1);
    this.hoodDistinct[h] = d1;
    this.splitSum += this.m.weights.split * (Math.max(0, d1 - 1) - Math.max(0, d0 - 1));
  }

  /** Overload and imbalance depend on every centre's load: O(S). */
  private updateShelterTerms(): void {
    const m = this.m;
    let over = 0, placed = 0;
    for (let s = 0; s < m.S; s++) {
      over += Math.max(0, this.load[s] - m.capacity[s]);
      placed += this.load[s];
    }
    const mean = this.totalCap > 0 ? placed / this.totalCap : 0;
    let imb = 0;
    for (let s = 0; s < m.S; s++) {
      if (m.capacity[s] <= 0) continue;
      const d = this.load[s] / m.capacity[s] - mean;
      imb += m.capacity[s] * d * d;
    }
    this.shelterOverload = m.weights.overload * over;
    this.shelterImbalance = m.weights.imbalance * imb;
  }
}

/**
 * A random neighbour of the current assignment:
 *   reassign: one group moves to another centre it is allowed to use;
 *   swap:     two groups in different centres trade places (each must be
 *             allowed at the other's centre). Swaps keep the loads nearly
 *             unchanged, so they can improve travel time without overloading.
 * Returns null when the drawn move is not possible (the caller just draws again).
 */
export function randomMove(st: AssignmentState, rng: Rng, swapProb: number): Move | null {
  const m = st.m;
  if (m.G === 0) return null;
  const g = rng.int(0, m.G - 1);
  const opts = m.options[g];
  if (opts.length === 0) return null;
  if (rng.next() < swapProb && m.G > 1) {
    const g2 = rng.int(0, m.G - 1);
    const a = st.assign[g], b = st.assign[g2];
    if (g2 === g || a === b || a < 0 || b < 0) return null;
    if (!allowed(m, g, b) || !allowed(m, g2, a)) return null;
    return [[g, b], [g2, a]];
  }
  const s = opts[rng.int(0, opts.length - 1)];
  if (s === st.assign[g]) return null;
  return [[g, s]];
}

export function allowed(m: AssignmentModel, g: number, s: number): boolean {
  const o = m.options[g];
  for (let i = 0; i < o.length; i++) if (o[i] === s) return true;
  return false;
}

/** Plain-language summary numbers of a plan. */
export interface PlanSummary {
  energy: number;
  parts: EnergyParts;
  sheltered: number;
  unsheltered: number;
  /** People-weighted mean and the longest travel time, minutes. */
  meanTime: number;
  maxTime: number;
  /** People-weighted mean exposure, risk-minutes. */
  meanExposure: number;
  overloadedCentres: number;
  splitHoods: number;
  /** Highest fill level (load / capacity). */
  maxFill: number;
}

export function summarise(m: AssignmentModel, assign: Int32Array): PlanSummary {
  const st = new AssignmentState(m, assign);
  let sheltered = 0, unsheltered = 0, tSum = 0, eSum = 0, tMax = 0;
  const hoodCentres = new Map<number, Set<number>>();
  for (let g = 0; g < m.G; g++) {
    const s = assign[g];
    if (s < 0) {
      unsheltered += m.size[g];
      continue;
    }
    sheltered += m.size[g];
    const t = m.time[g * m.S + s];
    tSum += m.size[g] * t;
    eSum += m.size[g] * m.exposure[g * m.S + s];
    tMax = Math.max(tMax, t);
    if (!hoodCentres.has(m.hood[g])) hoodCentres.set(m.hood[g], new Set());
    hoodCentres.get(m.hood[g])!.add(s);
  }
  let overloaded = 0, maxFill = 0;
  for (let s = 0; s < m.S; s++) {
    if (st.load[s] > m.capacity[s] + 1e-9) overloaded++;
    if (m.capacity[s] > 0) maxFill = Math.max(maxFill, st.load[s] / m.capacity[s]);
  }
  let split = 0;
  for (const set of hoodCentres.values()) if (set.size > 1) split++;
  return {
    energy: st.energy,
    parts: st.parts(),
    sheltered,
    unsheltered,
    meanTime: sheltered > 0 ? tSum / sheltered : NaN,
    maxTime: tMax,
    meanExposure: sheltered > 0 ? eSum / sheltered : NaN,
    overloadedCentres: overloaded,
    splitHoods: split,
    maxFill,
  };
}
