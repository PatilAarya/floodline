/**
 * Greedy Best-First Search.
 *
 * Always expands the frontier node that LOOKS closest to the goal, using
 * only the heuristic h(n) and ignoring the cost already paid. It usually
 * reaches the goal after very few expansions, but it can be lured down a
 * road that points at the goal and then has to go the long way round (for
 * example along a creek with no bridge). Fast, not optimal.
 *
 * Time O(E log V) worst case, space O(V). Complete with a visited set on a
 * finite graph; not optimal.
 */
import { MinHeap } from '../../core/pq';
import { now, reconstruct, trivial, type OnEvent, type SearchProblem, type SearchResult } from './types';

export function greedy(problem: SearchProblem, onEvent?: OnEvent): SearchResult {
  const t0 = now();
  const early = trivial(problem, onEvent);
  if (early) return early;
  const { graph: g, start, goal, cost } = problem;
  const h = problem.heuristic ?? (() => 0);
  const seen = new Uint8Array(g.n);
  const closed = new Uint8Array(g.n);
  const parentNode = new Int32Array(g.n).fill(-1);
  const parentEdge = new Int32Array(g.n).fill(-1);
  const gCost = new Float64Array(g.n);
  const pq = new MinHeap<number>();
  pq.push(start, h(start));
  seen[start] = 1;
  let expanded = 0, generated = 1, frontierMax = 1;
  const budget = problem.maxExpansions ?? Infinity;

  while (!pq.isEmpty()) {
    const v = pq.pop()!;
    if (closed[v]) continue;
    closed[v] = 1;
    expanded++;
    onEvent?.({ type: 'expand', node: v, g: gCost[v], f: h(v) });
    if (v === goal) {
      const r = reconstruct(problem, parentNode, parentEdge);
      onEvent?.({ type: 'goal', path: r.path, cost: r.cost });
      return { found: true, ...r, ms: now() - t0, expanded, generated, frontierMax };
    }
    if (expanded >= budget) break;
    for (let i = g.adjStart[v]; i < g.adjStart[v + 1]; i++) {
      const w = g.adjNode[i], e = g.adjEdge[i];
      if (seen[w]) continue;
      const c = cost(e);
      if (!Number.isFinite(c)) continue;
      // Greedy keeps the FIRST parent it finds; it never revisits for a cheaper route.
      seen[w] = 1;
      parentNode[w] = v;
      parentEdge[w] = e;
      gCost[w] = gCost[v] + c;
      const f = h(w);
      pq.push(w, f);
      generated++;
      onEvent?.({ type: 'frontier', node: w, from: v, g: gCost[w], f });
    }
    if (pq.size > frontierMax) frontierMax = pq.size;
  }
  const reason = expanded >= budget ? 'search budget exceeded' : 'no open road connects start and goal';
  onEvent?.({ type: 'fail', reason });
  return { found: false, path: [], edges: [], cost: Infinity, ms: now() - t0, expanded, generated, frontierMax, reason };
}
