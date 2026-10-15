/**
 * When there is no solution: explain why, then relax.
 *
 * Explanations (cheap, no search needed):
 *   1. Empty domain: some variable has no allowed value at all (a group
 *      that cannot reach any relief centre in time). Nothing can fix that
 *      except changing the constraints.
 *   2. Capacity argument (Hall's condition): take any set T of values. The
 *      variables whose WHOLE domain lies inside T can only go to T, so their
 *      total size must fit in the capacity of T. If it does not, no
 *      assignment exists. With m values there are 2^m sets T; for 10 relief
 *      centres that is 1,024 checks, which is instant. We report the
 *      smallest violating T (the most specific explanation). T = all values
 *      is the plain "total demand > total capacity" argument.
 *
 * Upper bound on how much can be placed (max-flow / min-cut): think of a
 * flow network source -> variable (size) -> allowed value -> sink (capacity).
 * Every cut either pays a value's capacity or a variable's size, and for a
 * set T of "cut" values the cheapest cut costs
 *     capacity(T) + size of the variables whose domain is NOT inside T.
 * The minimum over all T equals the maximum flow, i.e. the most people that
 * could be sheltered if groups could be split. No assignment of whole groups
 * can beat it, so it tells us how good a partial plan is.
 *
 * Relaxations:
 *   - maximisePartial: shelter as many people as possible (greedy fill,
 *     fewest options first, then a one-step "move someone over" repair),
 *     and report the unsheltered count honestly against the bound.
 *   - smallestRelaxation: loosen a parameter (the deadline) step by step
 *     until the problem becomes solvable.
 */
import { solveCSP, type CSPResult, type SolveOptions } from './backtracking';
import { consistent, UNASSIGNED, valueCount, type CSP } from './model';

export interface CapacityViolation {
  /** The set T of values. */
  values: number[];
  /** Variables that can only use values in T. */
  vars: number[];
  demand: number;
  capacity: number;
}

export interface Explanation {
  feasibleByCounting: boolean;
  /** Variables with an empty domain. */
  emptyDomains: number[];
  /** Smallest capacity violation, or null if Hall's condition holds for every T. */
  capacity: CapacityViolation | null;
  /** Units that must be placed (all variables) and units that could be placed (min-cut bound). */
  demand: number;
  bound: number;
  /** Units belonging to variables with an empty domain. */
  stranded: number;
}

/** Hall's condition and the min-cut bound. Needs a capacity constraint and at most 20 values. */
export function explainInfeasibility(csp: CSP): Explanation {
  const n = csp.names.length, m = valueCount(csp);
  const size = (x: number) => (csp.size ? csp.size[x] : 1);
  const emptyDomains: number[] = [];
  let demand = 0, stranded = 0;
  const masks = new Int32Array(n);
  for (let x = 0; x < n; x++) {
    demand += size(x);
    if (csp.domains[x].length === 0) {
      emptyDomains.push(x);
      stranded += size(x);
    }
    for (const v of csp.domains[x]) masks[x] |= 1 << v;
  }
  if (!csp.capacity || m > 20) {
    return { feasibleByCounting: emptyDomains.length === 0, emptyDomains, capacity: null, demand, bound: demand - stranded, stranded };
  }
  const cap = csp.capacity;
  let violation: CapacityViolation | null = null;
  let bound = Infinity;
  for (let T = 0; T < 1 << m; T++) {
    let capT = 0;
    for (let v = 0; v < m; v++) if (T & (1 << v)) capT += cap[v];
    let inside = 0, outside = 0;
    for (let x = 0; x < n; x++) {
      if (masks[x] === 0) continue;
      if ((masks[x] & ~T) === 0) inside += size(x);
      else outside += size(x);
    }
    bound = Math.min(bound, capT + outside);
    if (inside > capT + 1e-9) {
      const k = popcount(T);
      // Prefer the smallest set; among equals, the biggest shortfall.
      if (!violation || k < violation.values.length || (k === violation.values.length && inside - capT > violation.demand - violation.capacity)) {
        const values: number[] = [];
        for (let v = 0; v < m; v++) if (T & (1 << v)) values.push(v);
        const vars: number[] = [];
        for (let x = 0; x < n; x++) if (masks[x] !== 0 && (masks[x] & ~T) === 0) vars.push(x);
        violation = { values, vars, demand: inside, capacity: capT };
      }
    }
  }
  return { feasibleByCounting: emptyDomains.length === 0 && !violation, emptyDomains, capacity: violation, demand, bound, stranded };
}

function popcount(v: number): number {
  let c = 0;
  while (v) {
    v &= v - 1;
    c++;
  }
  return c;
}

export interface PartialResult {
  assignment: Int32Array;
  placed: number;
  unplaced: number;
  /** Min-cut bound: nobody can place more than this. */
  bound: number;
}

/**
 * Relaxation 1: place as much as possible. Greedy in "fewest options first,
 * biggest first" order, each to its cheapest value with room; then try to
 * fit every unplaced variable by moving ONE placed variable out of the way.
 * Not guaranteed optimal (the problem is a multiple-knapsack), but compared
 * against the min-cut bound so the gap is visible.
 */
export function maximisePartial(csp: CSP, start?: Int32Array): PartialResult {
  const n = csp.names.length, m = valueCount(csp);
  const size = (x: number) => (csp.size ? csp.size[x] : 1);
  const cap = csp.capacity ?? new Array(m).fill(Infinity);
  const cost = (x: number, v: number) => (csp.cost ? csp.cost(x, v) : 0);
  const assign = new Int32Array(n).fill(UNASSIGNED);
  const load = new Float64Array(m);
  // Keep a previous plan's placements where they are still valid.
  if (start) {
    for (let x = 0; x < n; x++) {
      const v = start[x];
      if (v !== UNASSIGNED && csp.domains[x].includes(v) && consistent(csp, assign, load, x, v) === 'ok') {
        assign[x] = v;
        load[v] += size(x);
      }
    }
  }
  const order = [...Array(n).keys()].sort((a, b) => csp.domains[a].length - csp.domains[b].length || size(b) - size(a) || a - b);
  for (const x of order) {
    if (assign[x] !== UNASSIGNED) continue;
    let best = -1;
    for (const v of csp.domains[x]) {
      if (consistent(csp, assign, load, x, v) !== 'ok') continue;
      if (best < 0 || cost(x, v) < cost(x, best)) best = v;
    }
    if (best >= 0) {
      assign[x] = best;
      load[best] += size(x);
    }
  }
  // Repair: for an unplaced x and a value v it allows, move one placed y out
  // of v (to another value with room) if that frees enough space for x.
  if (!csp.compatible) {
    for (const x of order) {
      if (assign[x] !== UNASSIGNED) continue;
      repair: for (const v of csp.domains[x]) {
        const need = size(x) - (cap[v] - load[v]);
        if (need <= 0) {
          assign[x] = v;
          load[v] += size(x);
          break;
        }
        for (let y = 0; y < n; y++) {
          if (assign[y] !== v || size(y) < need) continue;
          for (const w of csp.domains[y]) {
            if (w === v || cap[w] - load[w] < size(y)) continue;
            assign[y] = w;
            load[v] -= size(y);
            load[w] += size(y);
            assign[x] = v;
            load[v] += size(x);
            break repair;
          }
        }
      }
    }
  }
  let placed = 0, total = 0;
  for (let x = 0; x < n; x++) {
    total += size(x);
    if (assign[x] !== UNASSIGNED) placed += size(x);
  }
  const bound = Math.min(total, explainInfeasibility(csp).bound);
  return { assignment: assign, placed, unplaced: total - placed, bound };
}

/**
 * Relaxation 2: loosen one parameter. `levels` are tried in order (e.g.
 * deadlines 60, 70, 80 ... minutes); `make(level)` builds the CSP for that
 * level. The first level that passes the counting check AND is solved by
 * the search is returned.
 */
export function smallestRelaxation(levels: number[], make: (level: number) => CSP, opts: SolveOptions): { level: number; csp: CSP; result: CSPResult } | null {
  for (const level of levels) {
    const csp = make(level);
    if (!explainInfeasibility(csp).feasibleByCounting) continue;
    const result = solveCSP(csp, opts);
    if (result.status === 'solved') return { level, csp, result };
  }
  return null;
}
