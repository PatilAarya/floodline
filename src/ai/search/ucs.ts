/**
 * Uniform Cost Search (Dijkstra's algorithm with a goal test).
 *
 * Always expands the frontier node with the lowest path cost g so far,
 * using a min-priority queue. Because costs are non-negative, the first time
 * the goal is taken off the queue its g is the cheapest possible: UCS is
 * optimal. It knows nothing about where the goal is, so it spreads out in
 * every direction like a ripple.
 *
 * Lazy deletion: instead of decrease-key, a node is pushed again when a
 * cheaper path to it is found, and stale queue entries (g larger than the
 * best known) are skipped when popped.
 *
 * Time O((V + E) log V), space O(V). Complete and optimal.
 */
import { MinHeap } from '../../core/pq';
import { now, reconstruct, trivial, type OnEvent, type SearchProblem, type SearchResult } from './types';

/** Costs within this many seconds are treated as equal (float noise). */
export const COST_EPS = 1e-9;

export function ucs(problem: SearchProblem, onEvent?: OnEvent): SearchResult {
  const t0 = now();
  const early = trivial(problem, onEvent);
  if (early) return early;
  const { graph: g, start, goal, cost } = problem;
  const best = new Float64Array(g.n).fill(Infinity);
  const closed = new Uint8Array(g.n);
  const parentNode = new Int32Array(g.n).fill(-1);
  const parentEdge = new Int32Array(g.n).fill(-1);
  const pq = new MinHeap<number>();
  best[start] = 0;
  pq.push(start, 0);
  let expanded = 0, generated = 1, frontierMax = 1;
  const budget = problem.maxExpansions ?? Infinity;

  while (!pq.isEmpty()) {
    const gv = pq.peekPriority();
    const v = pq.pop()!;
    if (closed[v] || gv > best[v] + COST_EPS) continue; // stale entry
    closed[v] = 1;
    expanded++;
    onEvent?.({ type: 'expand', node: v, g: gv, f: gv });
    if (v === goal) {
      const r = reconstruct(problem, parentNode, parentEdge);
      onEvent?.({ type: 'goal', path: r.path, cost: r.cost });
      return { found: true, ...r, ms: now() - t0, expanded, generated, frontierMax };
    }
    if (expanded >= budget) break;
    for (let i = g.adjStart[v]; i < g.adjStart[v + 1]; i++) {
      const w = g.adjNode[i], e = g.adjEdge[i];
      if (closed[w]) continue;
      const c = cost(e);
      if (!Number.isFinite(c)) continue; // blocked road
      const ng = gv + c;
      if (ng + COST_EPS < best[w]) {
        best[w] = ng;
        parentNode[w] = v;
        parentEdge[w] = e;
        pq.push(w, ng);
        generated++;
        onEvent?.({ type: 'frontier', node: w, from: v, g: ng, f: ng });
      }
    }
    if (pq.size > frontierMax) frontierMax = pq.size;
  }
  const reason = expanded >= budget ? 'search budget exceeded' : 'no open road connects start and goal';
  onEvent?.({ type: 'fail', reason });
  return { found: false, path: [], edges: [], cost: Infinity, ms: now() - t0, expanded, generated, frontierMax, reason };
}
