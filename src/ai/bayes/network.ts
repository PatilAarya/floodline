/**
 * A discrete Bayesian network: variables with a few named states, a DAG of
 * parent links, and one conditional probability table (CPT) per variable.
 *
 * CPT layout
 *   For a variable X with parents P1..Pk (k may be 0), the table has one row
 *   per combination of parent states and one column per state of X:
 *     cpt[row * |X| + x] = P(X = x | parents = row)
 *   Rows are numbered in mixed radix with the FIRST parent most significant,
 *   exactly like reading the parent columns of a printed table left to right.
 *   A root variable has a single row: its prior.
 *
 * Everything here is pure data + small helpers: no DOM, no randomness.
 */

export interface Variable {
  /** Short identifier, e.g. "Rain". */
  name: string;
  /** Plain-English description for the UI and the viva notes. */
  about: string;
  states: string[];
  /** Indices of the parent variables in `Network.vars`. */
  parents: number[];
  /** Flat CPT, rows x |states| (see the layout note above). */
  cpt: Float64Array;
}

export interface Network {
  vars: Variable[];
}

/** Evidence: variable index -> observed state index. Unobserved variables are absent. */
export type Evidence = Map<number, number>;

/** Number of rows in X's CPT (product of parent cardinalities). */
export function rowCount(net: Network, x: number): number {
  let r = 1;
  for (const p of net.vars[x].parents) r *= net.vars[p].states.length;
  return r;
}

/**
 * Row of X's CPT selected by a full or partial assignment `a` (indexed by
 * variable). Only X's parents are read.
 */
export function rowOf(net: Network, x: number, a: ArrayLike<number>): number {
  let row = 0;
  for (const p of net.vars[x].parents) row = row * net.vars[p].states.length + a[p];
  return row;
}

/** P(X = state | parents as in assignment a). */
export function prob(net: Network, x: number, state: number, a: ArrayLike<number>): number {
  const k = net.vars[x].states.length;
  return net.vars[x].cpt[rowOf(net, x, a) * k + state];
}

/** The parent states for a given row index (inverse of rowOf), first parent first. */
export function rowParents(net: Network, x: number, row: number): number[] {
  const ps = net.vars[x].parents;
  const out = new Array<number>(ps.length);
  for (let i = ps.length - 1; i >= 0; i--) {
    const c = net.vars[ps[i]].states.length;
    out[i] = row % c;
    row = Math.floor(row / c);
  }
  return out;
}

export function children(net: Network, x: number): number[] {
  const out: number[] = [];
  net.vars.forEach((v, i) => {
    if (v.parents.includes(x)) out.push(i);
  });
  return out;
}

/**
 * A topological order (parents before children), by Kahn's algorithm.
 * Throws if the parent links contain a cycle (then it is not a BN).
 */
export function topoOrder(net: Network): number[] {
  const n = net.vars.length;
  const indeg = net.vars.map((v) => v.parents.length);
  const queue: number[] = [];
  for (let i = 0; i < n; i++) if (indeg[i] === 0) queue.push(i);
  const out: number[] = [];
  while (queue.length) {
    const v = queue.shift()!;
    out.push(v);
    for (const c of children(net, v)) if (--indeg[c] === 0) queue.push(c);
  }
  if (out.length !== n) throw new Error('The network has a cycle, so it is not a Bayesian network.');
  return out;
}

export function indexOf(net: Network, name: string): number {
  const i = net.vars.findIndex((v) => v.name === name);
  if (i < 0) throw new Error(`No variable called ${name}`);
  return i;
}

/** Deep copy (CPTs are copied, so the copy can be edited safely). */
export function cloneNetwork(net: Network): Network {
  return { vars: net.vars.map((v) => ({ ...v, states: [...v.states], parents: [...v.parents], cpt: Float64Array.from(v.cpt) })) };
}

// ─────────────────────────── Validation ───────────────────────────

/** Tolerance for "this row sums to 1". */
export const ROW_TOLERANCE = 1e-9;

export interface CptProblem {
  variable: number;
  row: number;
  /** What the row actually sums to (NaN if a cell is not a number). */
  sum: number;
  message: string;
}

/**
 * Every CPT row must be a probability distribution: all entries finite and
 * in [0, 1], summing to 1 within ROW_TOLERANCE. Returns every bad row so the
 * UI can mark them; an empty list means the network is valid.
 */
export function validate(net: Network): CptProblem[] {
  const out: CptProblem[] = [];
  net.vars.forEach((v, x) => {
    const k = v.states.length;
    const rows = rowCount(net, x);
    if (v.cpt.length !== rows * k) {
      out.push({ variable: x, row: -1, sum: NaN, message: `${v.name}: the table has ${v.cpt.length} numbers but needs ${rows * k}.` });
      return;
    }
    for (let r = 0; r < rows; r++) {
      let sum = 0, bad = false;
      for (let s = 0; s < k; s++) {
        const p = v.cpt[r * k + s];
        if (!Number.isFinite(p) || p < 0 || p > 1) bad = true;
        sum += p;
      }
      if (bad) out.push({ variable: x, row: r, sum, message: `${v.name}, row ${r + 1}: every entry must be a number between 0 and 1.` });
      else if (Math.abs(sum - 1) > ROW_TOLERANCE) out.push({ variable: x, row: r, sum, message: `${v.name}, row ${r + 1} sums to ${sum.toFixed(4)}; it must sum to 1.` });
    }
  });
  return out;
}
