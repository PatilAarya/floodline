/**
 * Depth-First Search.
 *
 * Follows one road as far as it can before backtracking, using a LIFO
 * stack. Memory-light, but the path it returns is simply the first one it
 * stumbles into: often long and winding. Shown for comparison; nobody should
 * route an evacuation this way.
 *
 * To keep it deterministic and a little less erratic, neighbours are pushed
 * so that the one closest to the goal is explored first (a common tweak);
 * this does not make it optimal.
 *
 * Time O(V + E), space O(V). Complete on a finite graph with a visited set;
 * not optimal.
 */
import { now, reconstruct, trivial, type OnEvent, type SearchProblem, type SearchResult } from './types';

export function dfs(problem: SearchProblem, onEvent?: OnEvent): SearchResult {
  const t0 = now();
  const early = trivial(problem, onEvent);
  if (early) return early;
  const { graph: g, start, goal, cost } = problem;
  const parentNode = new Int32Array(g.n).fill(-1);
  const parentEdge = new Int32Array(g.n).fill(-1);
  const visited = new Uint8Array(g.n);
  const stack: number[] = [start];
  const depth = new Int32Array(g.n);
  let expanded = 0, generated = 1, frontierMax = 1;
  const budget = problem.maxExpansions ?? Infinity;
  const gx = g.x[goal], gy = g.y[goal];
  const distToGoal = (v: number) => Math.hypot(g.x[v] - gx, g.y[v] - gy);

  while (stack.length) {
    const v = stack.pop()!;
    if (visited[v]) continue;
    visited[v] = 1;
    expanded++;
    onEvent?.({ type: 'expand', node: v, g: depth[v], f: depth[v] });
    if (v === goal) {
      const r = reconstruct(problem, parentNode, parentEdge);
      onEvent?.({ type: 'goal', path: r.path, cost: r.cost });
      return { found: true, ...r, ms: now() - t0, expanded, generated, frontierMax };
    }
    if (expanded >= budget) break;
    // Collect unvisited neighbours, push the farthest first so the nearest
    // to the goal is on top of the stack.
    const next: [number, number][] = [];
    for (let i = g.adjStart[v]; i < g.adjStart[v + 1]; i++) {
      const w = g.adjNode[i], e = g.adjEdge[i];
      if (visited[w] || !Number.isFinite(cost(e))) continue;
      next.push([w, e]);
    }
    next.sort((a, b) => distToGoal(b[0]) - distToGoal(a[0]) || b[0] - a[0]);
    for (const [w, e] of next) {
      // A node may be pushed again from a later parent; the latest push
      // (deepest path) wins, which is what makes this depth-first.
      parentNode[w] = v;
      parentEdge[w] = e;
      depth[w] = depth[v] + 1;
      stack.push(w);
      generated++;
      onEvent?.({ type: 'frontier', node: w, from: v, g: depth[w], f: depth[w] });
    }
    if (stack.length > frontierMax) frontierMax = stack.length;
  }
  const reason = expanded >= budget ? 'search budget exceeded' : 'no open road connects start and goal';
  onEvent?.({ type: 'fail', reason });
  return { found: false, path: [], edges: [], cost: Infinity, ms: now() - t0, expanded, generated, frontierMax, reason };
}
