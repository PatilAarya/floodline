/**
 * Forward checking.
 *
 * Idea: as soon as a variable is assigned, look one step ahead. Every value
 * of an UNASSIGNED neighbour that is no longer compatible with the new
 * assignment is removed from that neighbour's current domain. If some
 * neighbour is left with an empty domain (a "wipeout"), this branch can
 * never lead to a solution, so we back up at once instead of discovering the
 * dead end many levels deeper.
 *
 * For the two constraint kinds in model.ts:
 *   - binary: remove b from dom(y) when compatible(x, v, y, b) is false
 *     (map colouring: y can no longer use x's colour);
 *   - capacity: after x = v uses size[x] places in v, remove v from every
 *     unassigned y that no longer fits in what is left of v.
 *
 * Every removal is pushed onto the state's trail so `undoTo` can restore the
 * domains exactly when the search backtracks. Cost per call: O(sum over
 * neighbours of their domain size).
 */
import { UNASSIGNED, type SearchState } from './model';

export interface Pruned {
  /** Variable whose domain lost a value, and the value. */
  y: number;
  v: number;
}

/**
 * Prune after x = v has been assigned (load already updated). Returns the
 * first variable whose domain was wiped out, or -1. `onPrune` sees every removal.
 */
export function forwardCheck(st: SearchState, x: number, v: number, onPrune?: (p: Pruned) => void): number {
  const { csp, m, alive, count, assign, trail } = st;
  const left = csp.capacity ? csp.capacity[v] - st.load[v] : Infinity;
  for (const y of csp.neighbours[x]) {
    if (assign[y] !== UNASSIGNED) continue;
    const base = y * m;
    // Binary constraints: drop every value of y that clashes with x = v.
    if (csp.compatible) {
      for (const b of csp.domains[y]) {
        if (alive[base + b] === 1 && !csp.compatible(x, v, y, b)) remove(y, b);
      }
    }
    // Capacity: drop v from y if y no longer fits in what is left of v.
    if (csp.size && alive[base + v] === 1 && csp.size[y] > left + 1e-9) remove(y, v);
    if (count[y] === 0) return y;
  }
  return -1;

  function remove(y: number, b: number) {
    alive[y * m + b] = 0;
    count[y]--;
    trail.push(y, b);
    onPrune?.({ y, v: b });
  }
}

/** Restore every removal made after the trail had length `mark`. */
export function undoTo(st: SearchState, mark: number): void {
  const { trail, alive, count, m } = st;
  while (trail.length > mark) {
    const b = trail.pop()!;
    const y = trail.pop()!;
    alive[y * m + b] = 1;
    count[y]++;
  }
}
