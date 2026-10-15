/**
 * Backtracking search for a CSP, with optional forward checking and the
 * MRV / degree / LCV heuristics (each can be switched on or off).
 *
 *   BACKTRACK(assignment):
 *     if every variable is assigned: return the assignment
 *     x <- SELECT-UNASSIGNED-VARIABLE            (first, or MRV + degree)
 *     for each value v in ORDER-DOMAIN-VALUES(x)  (as listed, or LCV)
 *       if x = v is consistent with the assignment:
 *         assign x = v
 *         if forward checking: prune neighbours' domains;
 *           on a wipeout, undo and try the next value
 *         result <- BACKTRACK(assignment)
 *         if result != failure: return result
 *         undo x = v (and its pruning)
 *     return failure                               ("backtrack")
 *
 * Plain backtracking is "chronological": it only discovers a dead end when
 * it reaches a variable with no consistent value left. Forward checking
 * notices the empty domain right after the assignment that caused it.
 *
 * Budgets: a node limit (deterministic) and a time limit (safety). If either
 * runs out the search stops and returns the best partial assignment seen
 * (the one placing the most units, e.g. people), so the UI never freezes.
 *
 * Every step is reported through `onEvent`, so the page can draw the search
 * tree without the algorithm knowing anything about drawing.
 */
import { forwardCheck, undoTo } from './forwardChecking';
import { orderValues, selectVariable, type OrderOptions } from './heuristics';
import { consistent, createState, UNASSIGNED, type CSP } from './model';

export interface SolveOptions {
  forwardChecking: boolean;
  mrv: boolean;
  degree: boolean;
  lcv: boolean;
  /** Stop after this many nodes (value tries). */
  maxNodes?: number;
  /** Stop after this many milliseconds. */
  maxMs?: number;
  /** Warm start: try these values first (the previous plan, when the world changes). */
  prefer?: Int32Array;
}

export type CSPEvent =
  /** x = v was tried and accepted; the search goes one level deeper. */
  | { type: 'assign'; x: number; v: number; depth: number }
  /** x = v was tried and rejected as inconsistent (plain backtracking). */
  | { type: 'reject'; x: number; v: number; depth: number; reason: 'capacity' | 'conflict' }
  /** Forward checking removed value v from y's domain because of x. */
  | { type: 'prune'; x: number; y: number; v: number }
  /** x = v emptied y's domain: forward checking rejects x = v. */
  | { type: 'wipeout'; x: number; v: number; y: number; depth: number }
  /** x = v is being undone (its subtree failed or it caused a wipeout). */
  | { type: 'unassign'; x: number; v: number; depth: number }
  /** Every value of x failed: back up to the previous variable. */
  | { type: 'backtrack'; x: number; depth: number }
  | { type: 'solution' }
  | { type: 'fail'; reason: string }
  | { type: 'budget'; reason: string };

export interface CSPCounters {
  /** Values tried (each is a node of the search tree). */
  nodes: number;
  /** Values accepted and assigned. */
  assignments: number;
  /** Times every value of a variable failed and the search backed up. */
  backtracks: number;
  /** Values removed by forward checking. */
  prunes: number;
  /** Assignments rejected because they emptied a domain. */
  wipeouts: number;
  /** Deepest level reached. */
  maxDepth: number;
  ms: number;
}

export interface CSPResult extends CSPCounters {
  status: 'solved' | 'infeasible' | 'budget';
  /** The solution, or the best partial assignment when not solved. */
  assignment: Int32Array;
  /** Units placed by `assignment` (people, or variables when there are no sizes). */
  placed: number;
  /** Why it failed, in words. */
  reason?: string;
  /** A variable whose domain was empty before any search (node consistency failed). */
  emptyDomain?: number;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function solveCSP(csp: CSP, opts: SolveOptions, onEvent?: (e: CSPEvent) => void): CSPResult {
  const t0 = now();
  const n = csp.names.length;
  const maxNodes = opts.maxNodes ?? 200_000;
  const maxMs = opts.maxMs ?? 2_000;
  const st = createState(csp);
  const order: OrderOptions = { mrv: opts.mrv, degree: opts.degree, lcv: opts.lcv, fc: opts.forwardChecking, prefer: opts.prefer };
  const c: CSPCounters = { nodes: 0, assignments: 0, backtracks: 0, prunes: 0, wipeouts: 0, maxDepth: 0, ms: 0 };
  const unit = (x: number) => (csp.size ? csp.size[x] : 1);
  let best = new Int32Array(n).fill(UNASSIGNED);
  let bestPlaced = 0, placed = 0;
  let stop: string | null = null;

  const finish = (status: CSPResult['status'], assignment: Int32Array, reason?: string, emptyDomain?: number): CSPResult => {
    c.ms = now() - t0;
    let p = 0;
    for (let x = 0; x < n; x++) if (assignment[x] !== UNASSIGNED) p += unit(x);
    return { ...c, status, assignment, placed: p, reason, emptyDomain };
  };

  // Node consistency already happened when the domains were built; an empty
  // domain means no search can help.
  for (let x = 0; x < n; x++) {
    if (csp.domains[x].length === 0) {
      const reason = `${csp.names[x]} has no allowed value at all, so no complete assignment exists.`;
      onEvent?.({ type: 'fail', reason });
      return finish('infeasible', best, reason, x);
    }
  }

  const onPrune = onEvent ? (p: { y: number; v: number }, x: number) => onEvent({ type: 'prune', x, y: p.y, v: p.v }) : null;

  function backtrack(depth: number): boolean {
    if (st.assigned === n) return true;
    const x = selectVariable(st, order);
    for (const v of orderValues(st, x, order)) {
      if (c.nodes >= maxNodes) stop = `node budget of ${maxNodes.toLocaleString('en-GB')} reached`;
      else if ((c.nodes & 255) === 0 && now() - t0 > maxMs) stop = `time budget of ${maxMs} ms reached`;
      if (stop) return false;
      c.nodes++;
      const ok = consistent(csp, st.assign, st.load, x, v);
      if (ok !== 'ok') {
        onEvent?.({ type: 'reject', x, v, depth, reason: ok });
        continue;
      }
      // Assign.
      st.assign[x] = v;
      if (csp.size) st.load[v] += csp.size[x];
      st.assigned++;
      placed += unit(x);
      c.assignments++;
      if (depth + 1 > c.maxDepth) c.maxDepth = depth + 1;
      onEvent?.({ type: 'assign', x, v, depth });
      if (placed > bestPlaced) {
        bestPlaced = placed;
        best = st.assign.slice();
      }
      // Look ahead.
      const mark = st.trail.length;
      let wiped = -1;
      if (opts.forwardChecking) {
        const before = st.trail.length;
        wiped = forwardCheck(st, x, v, onPrune ? (p) => onPrune(p, x) : undefined);
        c.prunes += (st.trail.length - before) / 2;
      }
      if (wiped >= 0) {
        c.wipeouts++;
        onEvent?.({ type: 'wipeout', x, v, y: wiped, depth });
      } else if (backtrack(depth + 1)) {
        return true;
      }
      // Undo.
      undoTo(st, mark);
      st.assign[x] = UNASSIGNED;
      if (csp.size) st.load[v] -= csp.size[x];
      st.assigned--;
      placed -= unit(x);
      onEvent?.({ type: 'unassign', x, v, depth });
      if (stop) return false;
    }
    c.backtracks++;
    onEvent?.({ type: 'backtrack', x, depth });
    return false;
  }

  const found = backtrack(0);
  if (found) {
    onEvent?.({ type: 'solution' });
    return finish('solved', st.assign.slice());
  }
  if (stop) {
    const reason = `Search budget exceeded (${stop}); returning the best partial assignment found.`;
    onEvent?.({ type: 'budget', reason });
    return finish('budget', best, reason);
  }
  const reason = 'Every branch of the search tree failed: no assignment satisfies all the constraints.';
  onEvent?.({ type: 'fail', reason });
  return finish('infeasible', best, reason);
}
