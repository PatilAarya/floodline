/**
 * Hill climbing on the group -> centre assignment (the baseline that
 * simulated annealing is compared against). It only ever moves downhill,
 * so it stops at the first local minimum it reaches.
 *
 *   Steepest ascent ("descent" here, we minimise):
 *     repeat:
 *       look at EVERY neighbour (every reassignment and every swap)
 *       if the best one is not better than the current plan: stop
 *       move to the best one
 *
 *   First-choice:
 *     repeat:
 *       draw random neighbours until one is better, and take it
 *       stop after `patience` draws in a row with no improvement
 *
 * Steepest makes the best step each time but pays for a full scan of the
 * neighbourhood (thousands of evaluations per step); first-choice makes
 * cheap, good-enough steps. Neither can escape a local minimum.
 *
 * Like the annealer it is a stepper (`step(n)` = n evaluations), and the
 * trace uses "moves evaluated" on the x axis so both can share a plot.
 */
import { Rng } from '../../core/rng';
import { AssignmentState, allowed, randomMove, type AssignmentModel, type Move } from './objective';
import type { TracePoint } from './simulatedAnnealing';

export type HCVariant = 'steepest' | 'first';

export interface HCOptions {
  variant: HCVariant;
  seed: string;
  /** Hard cap on evaluations. */
  maxEvaluations: number;
  /** First-choice: give up after this many failed draws in a row. */
  patience?: number;
  swapProb?: number;
}

export class HillClimber {
  readonly model: AssignmentModel;
  readonly trace: TracePoint[] = [];
  evaluations = 0;
  steps = 0;
  /** True once a local minimum (or the budget) is reached. */
  done = false;
  stopReason = '';

  private st: AssignmentState;
  private rng: Rng;
  private o: Required<HCOptions>;
  private failures = 0;
  // Steepest: scan position and the best move found so far in this scan.
  private scanPos = 0;
  private scanBest: Move | null = null;
  private scanBestDelta = 0;
  private moves: Move[] | null = null;

  constructor(model: AssignmentModel, start: Int32Array, o: HCOptions) {
    this.model = model;
    this.o = { patience: 4000, swapProb: 0.3, ...o };
    this.st = new AssignmentState(model, start);
    this.rng = new Rng(`hc::${o.seed}`);
    this.trace.push({ i: 0, energy: this.st.energy, best: this.st.energy, T: 0 });
  }

  get energy(): number {
    return this.st.energy;
  }

  get assignment(): Int32Array {
    return this.st.assign.slice();
  }

  /** Advance by up to n evaluations. Returns true when finished. */
  step(n: number): boolean {
    const end = this.evaluations + n;
    while (!this.done && this.evaluations < end) {
      if (this.evaluations >= this.o.maxEvaluations) {
        this.finish('evaluation budget used up');
        break;
      }
      if (this.o.variant === 'steepest') this.steepestTick();
      else this.firstChoiceTick();
    }
    return this.done;
  }

  private finish(reason: string) {
    this.done = true;
    this.stopReason = reason;
    this.st.recompute();
    this.trace.push({ i: this.evaluations, energy: this.st.energy, best: this.st.energy, T: 0 });
  }

  /** One evaluation of the steepest scan; at the end of a scan, take the best move or stop. */
  private steepestTick() {
    if (!this.moves) {
      this.moves = allMoves(this.st);
      this.scanPos = 0;
      this.scanBest = null;
      this.scanBestDelta = -1e-9;
    }
    if (this.scanPos < this.moves.length) {
      const mv = this.moves[this.scanPos++];
      const d = this.st.delta(mv);
      this.evaluations++;
      if (d < this.scanBestDelta) {
        this.scanBestDelta = d;
        this.scanBest = mv;
      }
      return;
    }
    this.moves = null;
    if (!this.scanBest) {
      this.finish('local minimum: no neighbour is better');
      return;
    }
    this.st.apply(this.scanBest);
    this.steps++;
    this.trace.push({ i: this.evaluations, energy: this.st.energy, best: this.st.energy, T: 0 });
  }

  private firstChoiceTick() {
    const mv = randomMove(this.st, this.rng, this.o.swapProb);
    this.evaluations++;
    if (mv && this.st.delta(mv) < -1e-9) {
      this.st.apply(mv);
      this.steps++;
      this.failures = 0;
      this.trace.push({ i: this.evaluations, energy: this.st.energy, best: this.st.energy, T: 0 });
    } else if (++this.failures >= this.o.patience) {
      this.finish(`no better neighbour in ${this.o.patience.toLocaleString('en-GB')} random tries`);
    }
  }
}

/** Every reassignment and every useful swap from the current plan. */
function allMoves(st: AssignmentState): Move[] {
  const m = st.m;
  const out: Move[] = [];
  for (let g = 0; g < m.G; g++) for (const s of m.options[g]) if (s !== st.assign[g]) out.push([[g, s]]);
  for (let g = 0; g < m.G; g++) {
    const a = st.assign[g];
    if (a < 0) continue;
    for (let g2 = g + 1; g2 < m.G; g2++) {
      const b = st.assign[g2];
      if (b < 0 || a === b) continue;
      if (allowed(m, g, b) && allowed(m, g2, a)) out.push([[g, b], [g2, a]]);
    }
  }
  return out;
}
