/**
 * Constraint satisfaction problems: the shared model.
 *
 * A CSP has
 *   - VARIABLES x = 0 .. n-1 (here: evacuee groups, or regions of a map),
 *   - a DOMAIN for each variable: the values it may take (relief centres,
 *     or colours). Values are small integers 0 .. m-1 shared by everybody;
 *     each variable's domain is the subset it may use, listed in a
 *     preferred order (nearest centre first, for example),
 *   - CONSTRAINTS that say which combinations are allowed.
 *
 * Two kinds of constraint are supported, which is all this project needs:
 *
 *   1. Binary constraints between NEIGHBOURS in the constraint graph, given
 *      by `compatible(xi, a, xj, b)`. Map colouring uses "a != b".
 *   2. One global CAPACITY constraint: variable x needs `size[x]` units of
 *      whatever value it takes, and value v has `capacity[v]` units in total.
 *      For shelters: the people sent to a relief centre must fit inside it.
 *      Variables whose domains share a value compete for its capacity, so
 *      they are neighbours too (this is what the degree heuristic counts).
 *
 * Unary constraints (reachability, deadline, centre risk) never need search:
 * they are applied once, up front, by removing the forbidden values from the
 * domains. That step is called node consistency.
 *
 * An assignment is an Int32Array with one entry per variable; -1 means
 * "not assigned yet".
 */

export interface CSP {
  /** Variable names, for messages and the search tree. */
  names: string[];
  /** Value names (shared by all variables). */
  valueNames: string[];
  /** Initial domain of each variable, in the preferred order. */
  domains: number[][];
  /** Constraint graph: the variables each variable shares a constraint with. */
  neighbours: number[][];
  /** Binary constraint between two neighbours. Omit when the only constraint is capacity. */
  compatible?: (xi: number, a: number, xj: number, b: number) => boolean;
  /** Units each variable consumes (people in a group). Omit for no capacity constraint. */
  size?: number[];
  /** Units available per value (places in a centre). */
  capacity?: number[];
  /** Cost of x = v, used only to break ties when ordering values (travel time). */
  cost?: (x: number, v: number) => number;
}

export const UNASSIGNED = -1;

/** Number of values in the shared value set. */
export const valueCount = (csp: CSP): number => csp.valueNames.length;

/** The usual binary constraint of colouring problems. */
export const notEqual = (_xi: number, a: number, _xj: number, b: number): boolean => a !== b;

/**
 * Map colouring: regions are variables, colours are values, and two regions
 * that share a border must get different colours.
 */
export function mapColouring(regions: string[], borders: [string, string][], colours: string[]): CSP {
  const index = new Map(regions.map((r, i) => [r, i]));
  const neighbours: number[][] = regions.map(() => []);
  for (const [a, b] of borders) {
    const i = index.get(a), j = index.get(b);
    if (i === undefined || j === undefined || i === j) throw new Error(`Unknown border ${a} - ${b}`);
    if (!neighbours[i].includes(j)) neighbours[i].push(j);
    if (!neighbours[j].includes(i)) neighbours[j].push(i);
  }
  return {
    names: regions.slice(),
    valueNames: colours.slice(),
    domains: regions.map(() => colours.map((_, c) => c)),
    neighbours,
    compatible: notEqual,
  };
}

/**
 * Neighbours under a capacity constraint: two variables interact if their
 * domains share at least one value (they could compete for the same centre).
 * Uses a bit mask per variable, so it needs at most 31 values.
 */
export function capacityNeighbours(domains: number[][]): number[][] {
  const mask = domains.map((d) => d.reduce((m, v) => m | (1 << v), 0));
  return domains.map((_, i) => {
    const out: number[] = [];
    for (let j = 0; j < domains.length; j++) if (j !== i && (mask[i] & mask[j]) !== 0) out.push(j);
    return out;
  });
}

/**
 * Is x = v consistent with the variables already assigned?
 * Checks the binary constraints with assigned neighbours and the capacity
 * left in v. `load[v]` is the capacity of v already used.
 */
export function consistent(csp: CSP, assign: Int32Array, load: Float64Array, x: number, v: number): 'ok' | 'capacity' | 'conflict' {
  if (csp.capacity && csp.size && load[v] + csp.size[x] > csp.capacity[v] + 1e-9) return 'capacity';
  if (csp.compatible) {
    for (const y of csp.neighbours[x]) {
      const b = assign[y];
      if (b !== UNASSIGNED && !csp.compatible(x, v, y, b)) return 'conflict';
    }
  }
  return 'ok';
}

/** Does a complete assignment satisfy every constraint? (Used by tests and as a final check.) */
export function isSolution(csp: CSP, assign: Int32Array): boolean {
  const m = valueCount(csp);
  const load = new Float64Array(m);
  for (let x = 0; x < assign.length; x++) {
    const v = assign[x];
    if (v === UNASSIGNED || !csp.domains[x].includes(v)) return false;
    if (csp.size) load[v] += csp.size[x];
    if (csp.compatible) for (const y of csp.neighbours[x]) if (assign[y] !== UNASSIGNED && !csp.compatible(x, v, y, assign[y])) return false;
  }
  if (csp.capacity) for (let v = 0; v < m; v++) if (load[v] > csp.capacity[v] + 1e-9) return false;
  return true;
}

/**
 * The live state of a search: the partial assignment, the capacity used per
 * value, and the CURRENT domains. Plain backtracking never shrinks the
 * domains; forward checking does, and records every removal on `trail` so
 * that it can be undone exactly when the search backs up.
 */
export interface SearchState {
  csp: CSP;
  assign: Int32Array;
  load: Float64Array;
  /** alive[x * m + v] = 1 while v is still in x's current domain. */
  alive: Uint8Array;
  /** Values left in each current domain. */
  count: Int32Array;
  /** Removals as pairs (x, v), most recent last. */
  trail: number[];
  m: number;
  assigned: number;
}

export function createState(csp: CSP): SearchState {
  const n = csp.names.length, m = valueCount(csp);
  const alive = new Uint8Array(n * m);
  const count = new Int32Array(n);
  csp.domains.forEach((d, x) => {
    for (const v of d) alive[x * m + v] = 1;
    count[x] = d.length;
  });
  return { csp, assign: new Int32Array(n).fill(UNASSIGNED), load: new Float64Array(m), alive, count, trail: [], m, assigned: 0 };
}

/** The current domain of x, in the variable's preferred order. */
export function currentDomain(st: SearchState, x: number): number[] {
  return st.csp.domains[x].filter((v) => st.alive[x * st.m + v] === 1);
}
