/**
 * Builds the agent simulation inputs from a World (main thread), as flat
 * typed arrays that can be posted to the flood worker.
 *
 * Groups: each neighbourhood's evacuation demand is split into groups of at
 * most `groupSize` people (so a relief centre's capacity can actually be
 * met by whole groups). Groups start at the lowest-lying junctions of their
 * neighbourhood and leave in a staggered order after the warning: the
 * lowest neighbourhoods first.
 */
import { maxSpeed } from '../ai/search/cost';
import type { World } from '../world/types';
import type { AgentSetup, GroupSpec, NetData, Strategy } from './agents';
import type { TravelMode } from './hydrology';

/**
 * Evacuation buses in monsoon traffic move at roughly a third of free-flow
 * speed (Mumbai rush hour in rain is 10-20 km/h). Applied to the agents'
 * network only; the Algorithms page uses free-flow speeds.
 */
export const MONSOON_TRAFFIC = 0.35;

/** Minute the evacuation warning is issued (strategy 3 assigns centres then). */
export const WARNING_AT = 45;

/** Minutes to load a group of evacuees before it can leave. */
export const BOARDING_MINUTES = 15;

export function buildNet(w: World, mode: TravelMode): NetData {
  const g = w.graph;
  const E = g.edges;
  const geomOffset = new Int32Array(E.length + 1);
  let total = 0;
  E.forEach((e, i) => {
    total += e.geom.length;
    geomOffset[i + 1] = total;
  });
  const geom = new Float32Array(total);
  E.forEach((e, i) => geom.set(e.geom, geomOffset[i]));
  return {
    nodeX: Float32Array.from(g.nodes, (n) => n.x),
    nodeY: Float32Array.from(g.nodes, (n) => n.y),
    adjStart: g.adjStart,
    adjNode: g.adjNode,
    adjEdge: g.adjEdge,
    edgeA: Int32Array.from(E, (e) => e.a),
    edgeB: Int32Array.from(E, (e) => e.b),
    length: Float32Array.from(E, (e) => e.length),
    speed: Float32Array.from(E, (e) => e.speed * (mode === 'vehicle' ? MONSOON_TRAFFIC : 1)),
    geomOffset,
    geom,
    vmax: maxSpeed(w, mode) * (mode === 'vehicle' ? MONSOON_TRAFFIC : 1),
  };
}

export interface GroupOptions {
  /** Minute the evacuation warning is issued. */
  warningAt: number;
  /** Minutes over which departures are spread. */
  spread: number;
}

export function buildGroups(w: World, o: GroupOptions = { warningAt: WARNING_AT, spread: 150 }): GroupSpec[] {
  const out: GroupSpec[] = [];
  const G = w.groupSize;
  // Lowest neighbourhoods first.
  const order = [...w.hoods].filter((h) => h.population > 0).sort((a, b) => a.meanElev - b.meanElev);
  const queue: { hood: number; size: number; node: number }[] = [];
  for (const h of order) {
    const k = Math.ceil(h.population / G);
    // Start nodes: the hood's junctions from lowest up (where water arrives first).
    const nodes = h.nodes.length ? [...h.nodes].sort((a, b) => w.graph.nodes[a].elev - w.graph.nodes[b].elev) : [];
    for (let i = 0; i < k; i++) {
      const size = i < k - 1 ? G : h.population - G * (k - 1);
      const node = h.accessNode < 0 ? -1 : nodes.length ? nodes[i % Math.min(nodes.length, 6)] : h.accessNode;
      queue.push({ hood: h.id, size, node });
    }
  }
  queue.forEach((q, i) => out.push({ ...q, departAt: Math.round(o.warningAt + BOARDING_MINUTES + (i / Math.max(1, queue.length - 1)) * o.spread) }));
  return out;
}

export function buildAgentSetup(w: World, strategy: Strategy, mode: TravelMode, lambda = 2, seed = 'mumbai'): AgentSetup {
  return {
    net: buildNet(w, mode),
    shelters: w.shelters.map((s) => ({ node: s.node, capacity: s.capacity })),
    groups: buildGroups(w),
    strategy,
    mode,
    lambda,
    seed,
    warningAt: WARNING_AT,
  };
}
