/**
 * Ordering heuristics for backtracking search. None of them changes WHICH
 * solutions exist; they only change the order in which the search tries
 * things, which can shrink the search tree enormously.
 *
 * Which variable next?
 *   MRV (minimum remaining values, "fail first"): pick the variable with the
 *     fewest legal values left. If one is about to run out, we find out now,
 *     near the root, where backing up is cheap.
 *   Degree: among ties (or on its own), pick the variable involved in the
 *     most constraints with unassigned variables. It constrains the rest
 *     the most, so deciding it early shrinks the remaining problem.
 *
 * Which value first?
 *   LCV (least constraining value, "succeed first"): try first the value that
 *   removes the fewest options from the neighbours. Ties go to the cheaper
 *   value (shorter travel time), then to the variable's own preferred order.
 *
 * Without MRV/degree the next variable is simply the first unassigned one;
 * without LCV values are tried in the order the domain lists them.
 */
import { consistent, UNASSIGNED, type SearchState } from './model';

export interface OrderOptions {
  mrv: boolean;
  degree: boolean;
  lcv: boolean;
  /** Forward checking on: the current domains are already pruned. */
  fc: boolean;
  /** Warm start: try this value first for each variable (e.g. the previous plan). */
  prefer?: Int32Array;
}

/** Number of legal values left for x. With forward checking this is just the domain size. */
export function legalCount(st: SearchState, x: number, fc: boolean): number {
  if (fc) return st.count[x];
  let k = 0;
  for (const v of st.csp.domains[x]) if (consistent(st.csp, st.assign, st.load, x, v) === 'ok') k++;
  return k;
}

/** Constraints x shares with variables that are still unassigned. */
export function dynamicDegree(st: SearchState, x: number): number {
  let d = 0;
  for (const y of st.csp.neighbours[x]) if (st.assign[y] === UNASSIGNED) d++;
  return d;
}

/** Choose the next variable to assign, or -1 if all are assigned. */
export function selectVariable(st: SearchState, o: OrderOptions): number {
  const n = st.assign.length;
  if (!o.mrv && !o.degree) {
    for (let x = 0; x < n; x++) if (st.assign[x] === UNASSIGNED) return x;
    return -1;
  }
  let best = -1, bestR = Infinity, bestD = -1;
  for (let x = 0; x < n; x++) {
    if (st.assign[x] !== UNASSIGNED) continue;
    const r = o.mrv ? legalCount(st, x, o.fc) : 0;
    if (r > bestR) continue;
    const d = o.degree ? dynamicDegree(st, x) : 0;
    // Strictly fewer values wins; on a tie, more constraints wins; then the lower index.
    if (r < bestR || d > bestD) {
      best = x;
      bestR = r;
      bestD = d;
    }
  }
  return best;
}

/**
 * How many options x = v would take away from x's unassigned neighbours
 * (the quantity LCV minimises).
 */
export function constrainingScore(st: SearchState, x: number, v: number): number {
  const { csp, m, alive, assign } = st;
  const leftAfter = csp.capacity && csp.size ? csp.capacity[v] - st.load[v] - csp.size[x] : Infinity;
  let removed = 0;
  for (const y of csp.neighbours[x]) {
    if (assign[y] !== UNASSIGNED) continue;
    if (csp.compatible) for (const b of csp.domains[y]) if (alive[y * m + b] === 1 && !csp.compatible(x, v, y, b)) removed++;
    if (csp.size && alive[y * m + v] === 1 && csp.size[y] > leftAfter + 1e-9) removed++;
  }
  return removed;
}

/** The values to try for x, in order. */
export function orderValues(st: SearchState, x: number, o: OrderOptions): number[] {
  const { csp, m, alive } = st;
  // With forward checking only the surviving values are tried; plain
  // backtracking tries the whole domain and rejects the inconsistent ones.
  const values = o.fc ? csp.domains[x].filter((v) => alive[x * m + v] === 1) : csp.domains[x].slice();
  if (o.lcv) {
    const score = new Map(values.map((v) => [v, constrainingScore(st, x, v)]));
    const rank = new Map(values.map((v, i) => [v, i]));
    const cost = (v: number) => (csp.cost ? csp.cost(x, v) : 0);
    values.sort((a, b) => score.get(a)! - score.get(b)! || cost(a) - cost(b) || rank.get(a)! - rank.get(b)!);
  }
  const p = o.prefer ? o.prefer[x] : UNASSIGNED;
  if (p !== UNASSIGNED) {
    const i = values.indexOf(p);
    if (i > 0) values.unshift(values.splice(i, 1)[0]);
  }
  return values;
}
