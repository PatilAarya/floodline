/**
 * Breadth-First Search.
 *
 * Explores the graph in rings: first every node one road away from the
 * start, then every node two roads away, and so on, using a FIFO queue.
 * It finds the path with the FEWEST ROAD SEGMENTS, which is not the fastest
 * path: a short hop over a slow lane counts the same as a kilometre of
 * expressway. Blocked roads are skipped.
 *
 * Time O(V + E), space O(V). Complete; optimal only when every edge costs
 * the same.
 */
import { now, reconstruct, trivial, type OnEvent, type SearchProblem, type SearchResult } from './types';

export function bfs(problem: SearchProblem, onEvent?: OnEvent): SearchResult {
  const t0 = now();
  const early = trivial(problem, onEvent);
  if (early) return early;
  const { graph: g, start, goal, cost } = problem;
  const parentNode = new Int32Array(g.n).fill(-1);
  const parentEdge = new Int32Array(g.n).fill(-1);
  const depth = new Int32Array(g.n).fill(-1);
  // A plain array with a moving head is a fast FIFO queue.
  const queue = new Int32Array(g.n);
  let head = 0, tail = 0;
  queue[tail++] = start;
  depth[start] = 0;
  let expanded = 0, generated = 1, frontierMax = 1;
  const budget = problem.maxExpansions ?? Infinity;

  while (head < tail) {
    const v = queue[head++];
    expanded++;
    onEvent?.({ type: 'expand', node: v, g: depth[v], f: depth[v] });
    if (v === goal) {
      const r = reconstruct(problem, parentNode, parentEdge);
      onEvent?.({ type: 'goal', path: r.path, cost: r.cost });
      return { found: true, ...r, ms: now() - t0, expanded, generated, frontierMax };
    }
    if (expanded >= budget) break;
    for (let i = g.adjStart[v]; i < g.adjStart[v + 1]; i++) {
      const w = g.adjNode[i], e = g.adjEdge[i];
      // depth[w] >= 0 means w was already discovered: in BFS the first time
      // we see a node is through a shortest (fewest-hops) path.
      if (depth[w] >= 0 || !Number.isFinite(cost(e))) continue;
      depth[w] = depth[v] + 1;
      parentNode[w] = v;
      parentEdge[w] = e;
      queue[tail++] = w;
      generated++;
      onEvent?.({ type: 'frontier', node: w, from: v, g: depth[w], f: depth[w] });
    }
    if (tail - head > frontierMax) frontierMax = tail - head;
  }
  const reason = expanded >= budget ? 'search budget exceeded' : 'no open road connects start and goal';
  onEvent?.({ type: 'fail', reason });
  return { found: false, path: [], edges: [], cost: Infinity, ms: now() - t0, expanded, generated, frontierMax, reason };
}
