/**
 * Dynamic re-planning rules for evacuee groups. Pure functions; the agent
 * simulation (src/sim/agents.ts) calls them every simulated minute.
 *
 * When does a group re-plan?
 *   1. Mandatory: a road on its remaining route has become BLOCKED. The old
 *      plan is impossible, so it re-plans at once.
 *   2. Optional: a road on its route became DEGRADED, or a periodic check
 *      comes round. It re-plans only if the new route is clearly better.
 *
 * Hysteresis (against "thrashing" between two similar routes):
 *   - an optional switch needs the new route to be at least MARGIN cheaper
 *     than what is left of the current one, and
 *   - at least MIN_INTERVAL minutes must have passed since the last switch.
 *
 * Mid-edge: if the road under a group blocks while it is part-way along,
 *   it pushes on when the end is close (water has only just arrived),
 *   otherwise it turns back to the nearer end and re-plans from there.
 *
 * Shelter choice: a multi-goal Uniform Cost Search from the group's position
 * that stops at the first relief centre with free capacity, skipping any it
 * was recently turned away from (so two groups cannot ping-pong between a
 * full centre and another).
 */
import { MinHeap } from '../../core/pq';
import { astar } from './astar';
import type { SearchGraph, SearchResult } from './types';

export const MARGIN = 0.12;
export const MIN_INTERVAL = 10;
export const PERIODIC_EVERY = 20;
/** Push on through a newly blocked edge if at most this much of it is left. */
export const PUSH_ON_METRES = 120;
export const PUSH_ON_FRACTION = 0.3;

export function shouldAdoptOptional(newCost: number, remainingCost: number, minute: number, lastSwitch: number): boolean {
  if (!Number.isFinite(newCost)) return false;
  if (minute - lastSwitch < MIN_INTERVAL) return false;
  if (!Number.isFinite(remainingCost)) return true;
  return newCost < remainingCost * (1 - MARGIN);
}

/** Decide what to do when the edge a group is on becomes blocked. */
export function midEdgeDecision(position: number, length: number): 'continue' | 'turnBack' {
  const left = length - position;
  return left <= PUSH_ON_METRES || left <= length * PUSH_ON_FRACTION ? 'continue' : 'turnBack';
}

/** Cost of the rest of a route (edges from index `from` on) under current costs. */
export function remainingCost(edges: number[], from: number, cost: (e: number) => number): number {
  let c = 0;
  for (let i = from; i < edges.length; i++) c += cost(edges[i]);
  return c;
}

export interface ShelterSlot {
  node: number;
  capacity: number;
  /** People already inside or on their way (reserved). */
  load: number;
}

/**
 * Nearest relief centre with room for `size` people, by current travel cost.
 * Returns the shelter index and the route to it, or null if none is reachable.
 */
export function nearestShelter(
  g: SearchGraph,
  start: number,
  cost: (e: number) => number,
  shelters: ShelterSlot[],
  size: number,
  skip: (shelter: number) => boolean,
  ignoreCapacity = false,
): { shelter: number; nodes: number[]; edges: number[]; cost: number } | null {
  const shelterAt = new Map<number, number[]>();
  shelters.forEach((s, i) => {
    if (skip(i)) return;
    if (!ignoreCapacity && s.load + size > s.capacity) return;
    shelterAt.set(s.node, [...(shelterAt.get(s.node) ?? []), i]);
  });
  if (shelterAt.size === 0) return null;
  const best = new Float64Array(g.n).fill(Infinity);
  const pn = new Int32Array(g.n).fill(-1);
  const pe = new Int32Array(g.n).fill(-1);
  const done = new Uint8Array(g.n);
  const pq = new MinHeap<number>();
  best[start] = 0;
  pq.push(start, 0);
  while (!pq.isEmpty()) {
    const d = pq.peekPriority();
    const v = pq.pop()!;
    if (done[v] || d > best[v]) continue;
    done[v] = 1;
    const here = shelterAt.get(v);
    if (here) {
      const nodes: number[] = [], edges: number[] = [];
      let u = v;
      while (u !== -1) {
        nodes.push(u);
        if (u === start) break;
        edges.push(pe[u]);
        u = pn[u];
      }
      return { shelter: here[0], nodes: nodes.reverse(), edges: edges.reverse(), cost: d };
    }
    for (let i = g.adjStart[v]; i < g.adjStart[v + 1]; i++) {
      const w = g.adjNode[i], e = g.adjEdge[i];
      const c = cost(e);
      if (!Number.isFinite(c) || done[w]) continue;
      if (d + c < best[w]) {
        best[w] = d + c;
        pn[w] = v;
        pe[w] = e;
        pq.push(w, d + c);
      }
    }
  }
  return null;
}

/** Route to a specific relief centre with A*. */
export function routeTo(g: SearchGraph, start: number, goal: number, cost: (e: number) => number, vmax: number): SearchResult {
  const gx = g.x[goal], gy = g.y[goal];
  return astar({ graph: g, start, goal, cost, heuristic: (v) => Math.hypot(g.x[v] - gx, g.y[v] - gy) / vmax });
}
