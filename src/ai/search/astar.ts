/**
 * A* search.
 *
 * Expands the frontier node with the lowest f(n) = g(n) + h(n): the cost
 * already paid plus an estimate of the cost still to go. With an admissible
 * heuristic (never overestimates) A* returns an optimal path; with a
 * consistent one (h(u) <= cost(u,v) + h(v)) every node is expanded at most
 * once and f never decreases along the search. Ours is straight-line
 * distance over the fastest speed, which is both (see cost.ts).
 *
 * Compared with UCS it finds the same cost but expands far fewer nodes,
 * because the heuristic pulls the search towards the goal instead of
 * rippling out in every direction.
 *
 * If the heuristic is inadmissible (the "bad heuristic" demo inflates it),
 * A* may return a worse path. To stay correct in that case too, a closed
 * node is reopened if a cheaper path to it turns up.
 *
 * Ties in f are broken towards larger g (deeper nodes), then by insertion
 * order, which is the usual way to make A* reach the goal sooner on flat
 * f-plateaus; costs within COST_EPS are treated as equal.
 *
 * Time O(E log V) in the worst case (much less in practice), space O(V).
 * Complete; optimal with an admissible heuristic.
 */
import { MinHeap } from '../../core/pq';
import { COST_EPS } from './ucs';
import { now, reconstruct, trivial, type OnEvent, type SearchProblem, type SearchResult } from './types';

export function astar(problem: SearchProblem, onEvent?: OnEvent): SearchResult {
  const t0 = now();
  const early = trivial(problem, onEvent);
  if (early) return early;
  const { graph: g, start, goal, cost } = problem;
  const h = problem.heuristic ?? (() => 0);
  const best = new Float64Array(g.n).fill(Infinity);
  const closed = new Uint8Array(g.n);
  const parentNode = new Int32Array(g.n).fill(-1);
  const parentEdge = new Int32Array(g.n).fill(-1);
  const pq = new MinHeap<number>();
  // Priority f, with a tiny tie-break towards larger g (scaled well below COST_EPS).
  const prio = (f: number, gv: number) => f - gv * 1e-12;
  best[start] = 0;
  pq.push(start, prio(h(start), 0));
  let expanded = 0, generated = 1, frontierMax = 1;
  const budget = problem.maxExpansions ?? Infinity;

  while (!pq.isEmpty()) {
    const v = pq.pop()!;
    if (closed[v]) continue; // stale entry for an already-expanded node
    const gv = best[v];
    closed[v] = 1;
    expanded++;
    onEvent?.({ type: 'expand', node: v, g: gv, f: gv + h(v) });
    if (v === goal) {
      const r = reconstruct(problem, parentNode, parentEdge);
      onEvent?.({ type: 'goal', path: r.path, cost: r.cost });
      return { found: true, ...r, ms: now() - t0, expanded, generated, frontierMax };
    }
    if (expanded >= budget) break;
    for (let i = g.adjStart[v]; i < g.adjStart[v + 1]; i++) {
      const w = g.adjNode[i], e = g.adjEdge[i];
      const c = cost(e);
      if (!Number.isFinite(c)) continue; // blocked road
      const ng = gv + c;
      if (ng + COST_EPS < best[w]) {
        best[w] = ng;
        parentNode[w] = v;
        parentEdge[w] = e;
        if (closed[w]) closed[w] = 0; // only happens with an inconsistent heuristic
        const f = ng + h(w);
        pq.push(w, prio(f, ng));
        generated++;
        onEvent?.({ type: 'frontier', node: w, from: v, g: ng, f });
      }
    }
    if (pq.size > frontierMax) frontierMax = pq.size;
  }
  const reason = expanded >= budget ? 'search budget exceeded' : 'no open road connects start and goal';
  onEvent?.({ type: 'fail', reason });
  return { found: false, path: [], edges: [], cost: Infinity, ms: now() - t0, expanded, generated, frontierMax, reason };
}
