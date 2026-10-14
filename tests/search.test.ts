import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { astar } from '../src/ai/search/astar';
import { bfs } from '../src/ai/search/bfs';
import { graphOf, makeCost, makeHeuristic, maxSpeed } from '../src/ai/search/cost';
import { dfs } from '../src/ai/search/dfs';
import { greedy } from '../src/ai/search/greedy';
import { ucs } from '../src/ai/search/ucs';
import { MinHeap } from '../src/core/pq';
import { Rng } from '../src/core/rng';
import { buildEdgeTable, computeEdgeStates, waterLevelFlood } from '../src/sim/hydrology';
import { buildMumbaiWorld } from '../src/world/mumbai';

const world = buildMumbaiWorld(JSON.parse(readFileSync('src/data/mumbai.json', 'utf8')), { seed: 'mumbai', gridSize: 128, capacityRatio: 1.1, shelters: 10, participation: 0.22 });
const g = graphOf(world);
const vmax = maxSpeed(world, 'vehicle');

/** Exact cost from every node to `goal` (Dijkstra on the undirected graph). */
function allCostsTo(goal: number, cost: (e: number) => number): Float64Array {
  const d = new Float64Array(g.n).fill(Infinity);
  d[goal] = 0;
  const pq = new MinHeap<number>();
  pq.push(goal, 0);
  while (!pq.isEmpty()) {
    const dv = pq.peekPriority();
    const v = pq.pop()!;
    if (dv > d[v]) continue;
    for (let i = g.adjStart[v]; i < g.adjStart[v + 1]; i++) {
      const c = cost(g.adjEdge[i]);
      const w = g.adjNode[i];
      if (dv + c < d[w]) {
        d[w] = dv + c;
        pq.push(w, d[w]);
      }
    }
  }
  return d;
}

describe('search on the Mumbai road graph', () => {
  const rng = new Rng('search-test');
  const pairs = Array.from({ length: 25 }, () => [rng.int(0, g.n - 1), rng.int(0, g.n - 1)] as const);

  it('A* finds the same optimal cost as UCS (dry roads), with fewer expansions', () => {
    const cost = makeCost(world, { mode: 'vehicle' });
    let fewer = 0;
    for (const [s, t] of pairs) {
      const u = ucs({ graph: g, start: s, goal: t, cost });
      const a = astar({ graph: g, start: s, goal: t, cost, heuristic: makeHeuristic(g, t, vmax) });
      expect(a.found).toBe(u.found);
      if (u.found) expect(Math.abs(a.cost - u.cost)).toBeLessThan(1e-6 * Math.max(1, u.cost));
      if (a.expanded <= u.expanded) fewer++;
    }
    expect(fewer).toBe(pairs.length);
  });

  it('A* still matches UCS on a flooded network (blocked and degraded roads)', () => {
    const tbl = buildEdgeTable(world);
    const state = new Uint8Array(tbl.count), depth = new Float32Array(tbl.count);
    computeEdgeStates(tbl, waterLevelFlood(world, 3), world.terrain.height, world.ground, 'vehicle', state, depth);
    expect(state.some((s) => s === 2)).toBe(true);
    const cost = makeCost(world, { mode: 'vehicle', state, depth });
    for (const [s, t] of pairs) {
      const u = ucs({ graph: g, start: s, goal: t, cost });
      const a = astar({ graph: g, start: s, goal: t, cost, heuristic: makeHeuristic(g, t, vmax) });
      expect(a.found).toBe(u.found);
      if (u.found) expect(Math.abs(a.cost - u.cost)).toBeLessThan(1e-6 * Math.max(1, u.cost));
    }
  });

  it('the heuristic is admissible (never above the true cost) and consistent (on every edge)', () => {
    const cost = makeCost(world, { mode: 'vehicle' });
    for (const [, t] of pairs.slice(0, 5)) {
      const h = makeHeuristic(g, t, vmax);
      const truth = allCostsTo(t, cost);
      for (let v = 0; v < g.n; v++) if (Number.isFinite(truth[v])) expect(h(v)).toBeLessThanOrEqual(truth[v] + 1e-9);
      for (let v = 0; v < g.n; v++)
        for (let i = g.adjStart[v]; i < g.adjStart[v + 1]; i++) expect(h(v)).toBeLessThanOrEqual(cost(g.adjEdge[i]) + h(g.adjNode[i]) + 1e-9);
    }
  });

  it('BFS, DFS and Greedy find paths that are never cheaper than the optimum', () => {
    const cost = makeCost(world, { mode: 'vehicle' });
    for (const [s, t] of pairs.slice(0, 10)) {
      const u = ucs({ graph: g, start: s, goal: t, cost });
      for (const r of [bfs({ graph: g, start: s, goal: t, cost }), dfs({ graph: g, start: s, goal: t, cost }), greedy({ graph: g, start: s, goal: t, cost, heuristic: makeHeuristic(g, t, vmax) })]) {
        expect(r.found).toBe(u.found);
        if (u.found) expect(r.cost).toBeGreaterThanOrEqual(u.cost - 1e-6);
      }
    }
  });

  it('reports failure cleanly when every road out of the start is blocked', () => {
    const s = pairs[0][0], t = pairs[0][1];
    const blocked = new Set<number>();
    for (let i = g.adjStart[s]; i < g.adjStart[s + 1]; i++) blocked.add(g.adjEdge[i]);
    const cost = (e: number) => (blocked.has(e) ? Infinity : 1);
    for (const fn of [bfs, dfs, ucs, greedy, astar]) {
      const r = fn({ graph: g, start: s, goal: t, cost, heuristic: () => 0 });
      expect(r.found).toBe(false);
      expect(r.cost).toBe(Infinity);
    }
  });
});
