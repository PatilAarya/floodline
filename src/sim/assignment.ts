/**
 * The shelter-assignment problem on the real map: turns the World (and a
 * flood) into a CSP for src/ai/csp and a model for src/ai/local.
 *
 * Two stages, so moving a slider is cheap:
 *
 *   prepareNetwork(world, level, mode)   (expensive, once per flood level)
 *     - road states from the instant water level (open / degraded / blocked);
 *     - one Dijkstra search FROM EACH relief centre over the whole road
 *       graph (roads are two-way, so this gives the travel time from every
 *       junction TO that centre: 10 searches instead of one per group);
 *     - along the same shortest-path trees, the flood exposure of each
 *       route: sum of P_flood(road) x minutes on it, with P_flood from the
 *       Bayesian network (river gauge reading the water level) combined
 *       with the water already on the road, exactly as in the Simulator;
 *     - each centre's own state: flooded (water at its door) and its
 *       neighbourhood's P(FloodRisk = high).
 *
 *   buildInstance(prep, params)          (cheap)
 *     Variables = evacuee groups (buildGroups: each neighbourhood split into
 *     groups of at most 2,500 people). Domain of a group = the centres that
 *       - are open (not closed by hand, not flooded),
 *       - are reachable now,
 *       - have a flood risk no higher than the limit,
 *       - can be reached within the deadline.
 *     Each excluded (group, centre) pair keeps the REASON, so an empty domain
 *     can be explained in words. Domains are listed nearest-first.
 *     Capacity (the global constraint) = each centre's places x a scale.
 */
import { elevClass, mumbaiNetwork, riverClass } from '../ai/bayes/cpt';
import { capacityNeighbours, type CSP } from '../ai/csp/model';
import { DEFAULT_WEIGHTS, type AssignmentModel, type Weights } from '../ai/local/objective';
import { makeCostFromArrays } from '../ai/search/cost';
import { MinHeap } from '../core/pq';
import type { World } from '../world/types';
import { buildGroups, MONSOON_TRAFFIC } from './agentSetup';
import { pickGaugeCell } from './floodEngine';
import { buildEdgeTable, computeEdgeStates, THRESHOLDS, waterLevelFlood, type EdgeTable, type TravelMode } from './hydrology';
import { buildRiskSetup, edgeRisk, hoodRisk, riskPosterior } from './riskModel';

/** Why a centre is not in a group's domain. */
export const Reason = { Ok: 0, Closed: 1, Flooded: 2, Unreachable: 3, Risky: 4, TooFar: 5 } as const;
export type ReasonCode = (typeof Reason)[keyof typeof Reason];

export const REASON_TEXT: Record<ReasonCode, string> = {
  0: 'allowed',
  1: 'closed',
  2: 'flooded',
  3: 'cut off by water',
  4: 'too risky',
  5: 'beyond the deadline',
};

export interface PreparedNetwork {
  world: World;
  level: number;
  mode: TravelMode;
  table: EdgeTable;
  /** Water depth per grid cell and road state per edge (for drawing). */
  depth: Float32Array;
  edgeState: Uint8Array;
  edgeRisk: Float32Array;
  /** Per centre, per node: minutes to the centre (Infinity = no route) and exposure. */
  timeTo: Float64Array[];
  exposureTo: Float64Array[];
  /** Per centre, per node: the next node on the way to the centre (-1 at the centre). */
  nextHop: Int32Array[];
  centreFlooded: boolean[];
  centreRisk: number[];
  hoodRiskHigh: Float32Array;
}

export function prepareNetwork(w: World, level: number, mode: TravelMode, table: EdgeTable = buildEdgeTable(w)): PreparedNetwork {
  const nE = w.graph.edges.length;
  const depth = waterLevelFlood(w, level);
  const edgeState = new Uint8Array(nE);
  const edgeDepth = new Float32Array(nE);
  if (level > 0) computeEdgeStates(table, depth, w.terrain.height, w.ground, mode, edgeState, edgeDepth);
  // Bayesian risk, "what if" mode: no rain reading; the river gauge reads the level.
  const net = mumbaiNetwork();
  const rs = buildRiskSetup(w, w.params.seed, pickGaugeCell(w));
  const river = riverClass(Math.max(level, rs.gaugeBed + 0.6), rs.gaugeBed, rs.gaugeBank);
  const post = riskPosterior(net, -1, river);
  const risk = edgeRisk(rs, post, edgeDepth, mode, new Float32Array(nE));
  const hd = hoodRisk(rs, post);
  const hoodRiskHigh = new Float32Array(w.hoods.length);
  for (let i = 0; i < w.hoods.length; i++) hoodRiskHigh[i] = hd[i * 3 + 2];

  const E = w.graph.edges;
  const length = Float64Array.from(E, (e) => e.length);
  const speed = Float64Array.from(E, (e) => e.speed * (mode === 'vehicle' ? MONSOON_TRAFFIC : 1));
  const cost = makeCostFromArrays(length, speed, { mode, state: edgeState, depth: edgeDepth });

  const blocked = THRESHOLDS[mode].blocked;
  const timeTo: Float64Array[] = [], exposureTo: Float64Array[] = [], nextHop: Int32Array[] = [];
  const centreFlooded: boolean[] = [], centreRisk: number[] = [];
  for (const s of w.shelters) {
    const r = treeFrom(w, s.node, cost, risk);
    timeTo.push(r.time);
    exposureTo.push(r.exposure);
    nextHop.push(r.next);
    const nd = w.graph.nodes[s.node];
    centreFlooded.push(depth[nd.cell] > blocked);
    if (nd.hood >= 0) centreRisk.push(hoodRiskHigh[nd.hood]);
    else centreRisk.push(post.table[(1 * 3 + elevClass(s.elev)) * 3 + 2]);
  }
  return { world: w, level, mode, table, depth, edgeState, edgeRisk: risk, timeTo, exposureTo, nextHop, centreFlooded, centreRisk, hoodRiskHigh };
}

/**
 * Dijkstra from one centre. Times in minutes; exposure accumulates
 * P_flood x minutes along the same shortest-path tree; next[v] is v's parent
 * in the tree, i.e. the next junction on v's way to the centre.
 */
function treeFrom(w: World, source: number, cost: (e: number) => number, risk: Float32Array) {
  const n = w.graph.nodes.length;
  const { adjStart, adjNode, adjEdge } = w.graph;
  const time = new Float64Array(n).fill(Infinity);
  const exposure = new Float64Array(n).fill(Infinity);
  const next = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const pq = new MinHeap<number>();
  time[source] = 0;
  exposure[source] = 0;
  pq.push(source, 0);
  while (!pq.isEmpty()) {
    const d = pq.peekPriority();
    const v = pq.pop()!;
    if (done[v] || d > time[v]) continue;
    done[v] = 1;
    for (let i = adjStart[v]; i < adjStart[v + 1]; i++) {
      const u = adjNode[i], e = adjEdge[i];
      const c = cost(e);
      if (!Number.isFinite(c) || done[u]) continue;
      const t = d + c / 60;
      if (t < time[u]) {
        time[u] = t;
        exposure[u] = exposure[v] + risk[e] * (c / 60);
        next[u] = v;
        pq.push(u, t);
      }
    }
  }
  return { time, exposure, next };
}

export interface GroupInfo {
  /** Index in the full list of groups (stable across instances). */
  id: number;
  hood: number;
  name: string;
  size: number;
  node: number;
}

export interface CentreInfo {
  /** Index into world.shelters. */
  shelter: number;
  name: string;
  short: string;
  node: number;
  capacity: number;
  flooded: boolean;
  risk: number;
  closed: boolean;
}

export interface InstanceParams {
  /** Latest acceptable travel time, minutes. */
  deadline: number;
  /** Highest acceptable P(FloodRisk = high) at a centre (1 = no limit). */
  maxRisk: number;
  /** Multiplies every centre's capacity. */
  capacityScale: number;
  /** Centres closed by hand (world shelter indices). */
  closed: number[];
  /** Restrict to these neighbourhoods (the small lab instance). */
  hoods?: number[];
  /** Restrict to these centres (world shelter indices). */
  centres?: number[];
  /** Replace the capacities (same order as `centres`). */
  capacities?: number[];
  weights?: Weights;
}

export interface Instance {
  prep: PreparedNetwork;
  params: InstanceParams;
  groups: GroupInfo[];
  centres: CentreInfo[];
  G: number;
  S: number;
  /** [g * S + s]: minutes (Infinity = no route), exposure, and why s is not allowed. */
  time: Float64Array;
  exposure: Float64Array;
  reason: Uint8Array;
  csp: CSP;
  model: AssignmentModel;
  /** Model hood index (0..H-1) -> world hood id. */
  hoodIds: number[];
}

let groupCache: { world: World; groups: GroupInfo[] } | null = null;

/** All evacuee groups of the world, named "Dharavi 3" etc. */
export function allGroups(w: World): GroupInfo[] {
  if (groupCache?.world === w) return groupCache.groups;
  const counts = new Map<number, number>();
  const groups = buildGroups(w).map((g, id) => {
    const k = (counts.get(g.hood) ?? 0) + 1;
    counts.set(g.hood, k);
    return { id, hood: g.hood, name: `${w.hoods[g.hood].name} ${k}`, size: g.size, node: g.node };
  });
  groupCache = { world: w, groups };
  return groups;
}

export function buildInstance(prep: PreparedNetwork, p: InstanceParams): Instance {
  const w = prep.world;
  const hoodSet = p.hoods ? new Set(p.hoods) : null;
  const groups = allGroups(w).filter((g) => !hoodSet || hoodSet.has(g.hood));
  const centreIds = p.centres ?? w.shelters.map((_, i) => i);
  const centres: CentreInfo[] = centreIds.map((si, k) => {
    const s = w.shelters[si];
    return {
      shelter: si,
      name: s.name.replace(/^S\d+\s+/, ''),
      short: `S${si + 1}`,
      node: s.node,
      capacity: Math.round((p.capacities ? p.capacities[k] : s.capacity * p.capacityScale) / 100) * 100,
      flooded: prep.centreFlooded[si],
      risk: prep.centreRisk[si],
      closed: p.closed.includes(si),
    };
  });
  const G = groups.length, S = centres.length;
  const time = new Float64Array(G * S), exposure = new Float64Array(G * S), reason = new Uint8Array(G * S);
  const domains: number[][] = [];
  groups.forEach((g, gi) => {
    const dom: number[] = [];
    centres.forEach((c, s) => {
      const k = gi * S + s;
      const t = g.node >= 0 ? prep.timeTo[c.shelter][g.node] : Infinity;
      time[k] = t;
      exposure[k] = g.node >= 0 ? prep.exposureTo[c.shelter][g.node] : Infinity;
      let r: ReasonCode = Reason.Ok;
      if (c.closed) r = Reason.Closed;
      else if (c.flooded) r = Reason.Flooded;
      else if (!Number.isFinite(t)) r = Reason.Unreachable;
      else if (c.risk > p.maxRisk + 1e-9) r = Reason.Risky;
      else if (t > p.deadline) r = Reason.TooFar;
      reason[k] = r;
      if (r === Reason.Ok) dom.push(s);
    });
    dom.sort((a, b) => time[gi * S + a] - time[gi * S + b] || a - b);
    domains.push(dom);
  });
  const csp: CSP = {
    names: groups.map((g) => g.name),
    valueNames: centres.map((c) => c.short),
    domains,
    neighbours: capacityNeighbours(domains),
    size: groups.map((g) => g.size),
    capacity: centres.map((c) => (c.closed || c.flooded ? 0 : c.capacity)),
    cost: (x, v) => time[x * S + v],
  };
  const hoodIds = [...new Set(groups.map((g) => g.hood))];
  const hoodIndex = new Map(hoodIds.map((h, i) => [h, i]));
  // Unreachable pairs never appear in a domain, so infinities never reach the energy.
  const safe = (a: Float64Array) => a.map((x) => (Number.isFinite(x) ? x : 0));
  const model: AssignmentModel = {
    G,
    S,
    H: hoodIds.length,
    size: Float64Array.from(groups, (g) => g.size),
    capacity: Float64Array.from(csp.capacity!),
    hood: Int32Array.from(groups, (g) => hoodIndex.get(g.hood)!),
    time: safe(time),
    exposure: safe(exposure),
    options: domains.map((d) => Int32Array.from(d)),
    weights: p.weights ?? DEFAULT_WEIGHTS,
  };
  return { prep, params: p, groups, centres, G, S, time, exposure, reason, csp, model, hoodIds };
}

/** Road route (node list) from a group's start to a centre, from the shortest-path tree. */
export function routeNodes(prep: PreparedNetwork, shelter: number, start: number): number[] {
  const next = prep.nextHop[shelter];
  const out: number[] = [];
  let v = start, guard = next.length + 1;
  if (v < 0 || !Number.isFinite(prep.timeTo[shelter][v])) return out;
  while (v !== -1 && guard-- > 0) {
    out.push(v);
    v = next[v];
  }
  return out;
}

/** Why a group has no centre, in one sentence. */
export function explainGroup(inst: Instance, g: number): string {
  const counts = new Map<ReasonCode, string[]>();
  for (let s = 0; s < inst.S; s++) {
    const r = inst.reason[g * inst.S + s] as ReasonCode;
    if (r === Reason.Ok) continue;
    counts.set(r, [...(counts.get(r) ?? []), inst.centres[s].short]);
  }
  if (inst.groups[g].node < 0) return `${inst.groups[g].name} has no road access at all.`;
  const parts = [...counts].map(([r, list]) => (list.length === inst.S ? `every centre is ${REASON_TEXT[r]}` : `${list.join(', ')} ${list.length === 1 ? 'is' : 'are'} ${REASON_TEXT[r]}`));
  let nearest = Infinity;
  for (let s = 0; s < inst.S; s++) if (inst.reason[g * inst.S + s] === Reason.TooFar) nearest = Math.min(nearest, inst.time[g * inst.S + s]);
  return `${inst.groups[g].name}: ${parts.join('; ')}.${Number.isFinite(nearest) ? ` The nearest open centre is ${Math.round(nearest)} min away.` : ''}`;
}
