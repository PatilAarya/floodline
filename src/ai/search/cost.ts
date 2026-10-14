/**
 * Edge costs and the heuristic.
 *
 *   cost(e) = length / v_eff * (1 + lambda * P_flood(e))   (+ penalty if degraded)
 *   cost(e) = Infinity                                      if blocked
 *
 * v_eff is the free-flow speed reduced by water depth (speedFactor). P_flood
 * is the flood probability of the edge (from the Bayesian network, or a
 * depth-based proxy). Degraded roads also carry a large finite penalty so
 * routes avoid them unless there is no alternative.
 *
 * Heuristic: straight-line distance to the goal divided by the fastest
 * free-flow speed in the network.
 *   Admissible: every route is at least as long as the straight line, no
 *     edge is faster than v_max, and every multiplier above is >= 1, so the
 *     true cost is never below h.
 *   Consistent: for an edge u->v, h(u) - h(v) <= |uv| / v_max <= length / v_max <= cost(u,v)
 *     by the triangle inequality, so f never decreases along a path and A*
 *     never needs to reopen a closed node.
 */
import type { World } from '../../world/types';
import { speedFactor, THRESHOLDS, type TravelMode } from '../../sim/hydrology';
import type { SearchGraph } from './types';

/** Extra seconds charged for using a degraded (partly flooded) road. */
export const DEGRADED_PENALTY = 300;

export interface CostOptions {
  mode: TravelMode;
  /** Road states: 0 open, 1 degraded, 2 blocked. Omit for a dry network. */
  state?: Uint8Array;
  /** Water depth over each road, metres. */
  depth?: Float32Array;
  /** Flood probability per edge, 0..1. */
  risk?: Float32Array;
  /** Risk weight. 0 = ignore risk (fastest route). */
  lambda?: number;
  /** Walking speed when on foot, m/s. */
  walkSpeed?: number;
}

export function graphOf(w: World): SearchGraph {
  const g = w.graph;
  return {
    n: g.nodes.length,
    x: Float64Array.from(g.nodes, (n) => n.x),
    y: Float64Array.from(g.nodes, (n) => n.y),
    adjStart: g.adjStart,
    adjNode: g.adjNode,
    adjEdge: g.adjEdge,
  };
}

/** Fastest possible speed for the mode: the bound used by the heuristic. */
export function maxSpeed(w: World, mode: TravelMode, walkSpeed = 1.2): number {
  if (mode === 'foot') return walkSpeed;
  let v = 0;
  for (const e of w.graph.edges) if (e.speed > v) v = e.speed;
  return v;
}

export function makeCost(w: World, o: CostOptions): (e: number) => number {
  const E = w.graph.edges;
  return makeCostFromArrays(Float64Array.from(E, (e) => e.length), Float64Array.from(E, (e) => e.speed), o);
}

/** The same cost model on plain arrays (used inside the flood worker). */
export function makeCostFromArrays(length: ArrayLike<number>, speed: ArrayLike<number>, o: CostOptions): (e: number) => number {
  const lambda = o.lambda ?? 0;
  const walk = o.walkSpeed ?? 1.2;
  const blockedAt = THRESHOLDS[o.mode].blocked;
  return (id: number) => {
    const s = o.state ? o.state[id] : 0;
    if (s === 2) return Infinity;
    const base = o.mode === 'foot' ? walk : speed[id];
    const d = o.depth ? o.depth[id] : 0;
    const f = s === 1 ? Math.max(0.2, speedFactor(Math.min(d, blockedAt * 0.999), o.mode)) : 1;
    let c = length[id] / (base * f);
    if (lambda > 0 && o.risk) c *= 1 + lambda * o.risk[id];
    if (s === 1) c += DEGRADED_PENALTY;
    return c;
  };
}

/** Straight-line distance to the goal / v_max. `inflate` > 1 makes it inadmissible (for the demo). */
export function makeHeuristic(g: SearchGraph, goal: number, vmax: number, inflate = 1): (v: number) => number {
  const gx = g.x[goal], gy = g.y[goal];
  const k = inflate / vmax;
  return (v: number) => Math.hypot(g.x[v] - gx, g.y[v] - gy) * k;
}

/**
 * Flood-risk proxy per edge when no Bayesian posterior is available: how
 * close the water over the road is to the blocking depth (0 dry, 1 blocked).
 */
export function riskFromDepth(depth: Float32Array, mode: TravelMode, out: Float32Array = new Float32Array(depth.length)): Float32Array {
  const b = THRESHOLDS[mode].blocked;
  for (let i = 0; i < depth.length; i++) out[i] = Math.min(1, Math.max(0, depth[i] / b));
  return out;
}
