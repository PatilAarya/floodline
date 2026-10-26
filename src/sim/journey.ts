/**
 * One journey through the flood: the Route page's model.
 *
 * A car leaves a start junction for a destination at a chosen time while the
 * storm runs. Every simulated minute:
 *
 *   before it leaves   the best route from the start is checked against the
 *                      current road states; if a road on it has closed, the
 *                      route is re-planned (the planner keeps an eye on the
 *                      trip before anyone sets off);
 *   on the way         the rest of the route is checked; if a road ahead is
 *                      closed the car re-plans from the next junction; if the
 *                      road under it closes it pushes on when nearly through,
 *                      otherwise it turns back (same rules as the evacuees,
 *                      see ai/search/replanner.ts); with no route at all it
 *                      waits at a junction and tries again each minute.
 *
 * Every plan uses the chosen search algorithm for the main route (so you can
 * see BFS, DFS or Greedy pick worse routes than A*) and records the order in
 * which junctions were explored, for the animation. Two ALTERNATIVE routes
 * are found by the penalty method: after each route is found, the roads it
 * uses are made more expensive and A* is run again, so the next route prefers
 * other roads. Near-duplicates are dropped.
 *
 * Pure (no DOM) and deterministic.
 */
import { astar } from '../ai/search/astar';
import { bfs } from '../ai/search/bfs';
import { makeCostFromArrays } from '../ai/search/cost';
import { dfs } from '../ai/search/dfs';
import { greedy } from '../ai/search/greedy';
import { midEdgeDecision } from '../ai/search/replanner';
import type { SearchEvent, SearchGraph, SearchProblem, SearchResult } from '../ai/search/types';
import { ucs } from '../ai/search/ucs';
import type { World } from '../world/types';
import { maxSpeed } from '../ai/search/cost';
import { speedFactor, type TravelMode } from './hydrology';

/**
 * Cars in a flooding Mumbai do not move at free-flow speed: rush hour in
 * monsoon rain is 10-20 km/h. Every road's speed is multiplied by this.
 */
export const MONSOON_TRAFFIC = 0.35;

export type Algo = 'astar' | 'ucs' | 'greedy' | 'bfs' | 'dfs';

export const ALGO_NAMES: Record<Algo, string> = { astar: 'A*', ucs: 'Uniform Cost', greedy: 'Greedy Best-First', bfs: 'Breadth-First', dfs: 'Depth-First' };

const RUN: Record<Algo, (p: SearchProblem, on?: (e: SearchEvent) => void) => SearchResult> = { astar, ucs, greedy, bfs, dfs };

/** The road network for a journey, with monsoon-traffic speeds. */
export function journeyNet(w: World, mode: TravelMode): JourneyNet {
  const g = w.graph;
  const k = mode === 'vehicle' ? MONSOON_TRAFFIC : 1;
  return {
    graph: { n: g.nodes.length, x: Float32Array.from(g.nodes, (v) => v.x), y: Float32Array.from(g.nodes, (v) => v.y), adjStart: g.adjStart, adjNode: g.adjNode, adjEdge: g.adjEdge },
    length: Float32Array.from(g.edges, (e) => e.length),
    speed: Float32Array.from(g.edges, (e) => e.speed * k),
    street: w.graph.edges.map((e) => e.street),
    code: w.graph.edges.map((e) => e.name),
    kind: w.graph.edges.map((e) => e.kind),
    vmax: maxSpeed(w, mode) * k,
    mode,
  };
}

export interface JourneyNet {
  graph: SearchGraph;
  /** Per edge: metres, speed in m/s (evacuation traffic), street name for labels. */
  length: Float32Array;
  speed: Float32Array;
  street: string[];
  code: string[];
  /** 'road' | 'bridge' | 'flyover' | 'tunnel' */
  kind: string[];
  vmax: number;
  mode: TravelMode;
}

/** Road conditions at one moment. */
export interface Conditions {
  state: Uint8Array;
  depth: Float32Array;
  risk: Float32Array | null;
  /** Risk weight: 0 = fastest route, 2 = avoid roads likely to flood. */
  lambda: number;
}

export interface RouteInfo {
  nodes: number[];
  edges: number[];
  /** Search cost (seconds, includes risk weighting and penalties). */
  cost: number;
  /** Plain driving time under current conditions, minutes. */
  minutes: number;
  km: number;
  /** The one or two main streets, e.g. "LBS Marg and Sion Road". */
  via: string;
  status: 'open' | 'slow' | 'blocked';
  /** First closed road on the route (edge id), or -1. */
  blockedAt: number;
}

export interface PlanResult {
  best: RouteInfo | null;
  alternatives: RouteInfo[];
  algo: Algo;
  /** Junctions the chosen algorithm explored, in order (for the animation). */
  explored: Int32Array;
  expanded: number;
  /** For comparison: what A* and Uniform Cost explore on the same problem. */
  astarExpanded: number;
  ucsExpanded: number;
  /** Optimal cost (UCS) for judging the chosen algorithm's route. */
  optimalCost: number;
}

export function makeCosts(net: JourneyNet, c: Conditions) {
  const cost = makeCostFromArrays(net.length, net.speed, { mode: net.mode, state: c.state, depth: c.depth, risk: c.risk ?? undefined, lambda: c.lambda });
  const time = (e: number) => {
    if (c.state[e] === 2) return Infinity;
    const base = net.mode === 'foot' ? 1.2 : net.speed[e];
    return net.length[e] / (base * (c.state[e] === 1 ? Math.max(0.2, speedFactor(c.depth[e], net.mode)) : 1));
  };
  return { cost, time };
}

function describe(net: JourneyNet, nodes: number[], edges: number[], cost: number, c: Conditions, time: (e: number) => number): RouteInfo {
  let seconds = 0, metres = 0, blockedAt = -1, slow = false;
  const byStreet = new Map<string, number>();
  for (const e of edges) {
    metres += net.length[e];
    const t = time(e);
    seconds += Number.isFinite(t) ? t : 0;
    if (c.state[e] === 2 && blockedAt < 0) blockedAt = e;
    if (c.state[e] === 1) slow = true;
    const name = net.street[e];
    if (name) byStreet.set(name, (byStreet.get(name) ?? 0) + net.length[e]);
  }
  const top = [...byStreet].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([n]) => n);
  return {
    nodes,
    edges,
    cost,
    minutes: seconds / 60,
    km: metres / 1000,
    via: top.length ? top.join(' and ') : 'unnamed roads',
    status: blockedAt >= 0 ? 'blocked' : slow ? 'slow' : 'open',
    blockedAt,
  };
}

/** Re-evaluate a known route under new conditions (status, time). */
export function reassess(net: JourneyNet, r: RouteInfo, c: Conditions, from = 0): RouteInfo {
  const { cost, time } = makeCosts(net, c);
  let total = 0;
  for (let i = from; i < r.edges.length; i++) total += cost(r.edges[i]);
  return describe(net, r.nodes.slice(from), r.edges.slice(from), total, c, time);
}

/** Share of b's length that is also on a. */
function overlap(net: JourneyNet, a: number[], b: number[]): number {
  const set = new Set(a);
  let shared = 0, total = 0;
  for (const e of b) {
    total += net.length[e];
    if (set.has(e)) shared += net.length[e];
  }
  return total > 0 ? shared / total : 1;
}

/** Best route with the chosen algorithm, plus up to two alternatives (penalty method, A*). */
export function planRoutes(net: JourneyNet, from: number, to: number, c: Conditions, algo: Algo): PlanResult {
  const g = net.graph;
  const { cost, time } = makeCosts(net, c);
  const gx = g.x[to], gy = g.y[to];
  const heuristic = (v: number) => Math.hypot(g.x[v] - gx, g.y[v] - gy) / net.vmax;
  const explored: number[] = [];
  const main = RUN[algo]({ graph: g, start: from, goal: to, cost, heuristic }, (e) => {
    if (e.type === 'expand' && explored.length < 8000) explored.push(e.node);
  });
  const opt = algo === 'ucs' ? main : ucs({ graph: g, start: from, goal: to, cost });
  const ast = algo === 'astar' ? main : astar({ graph: g, start: from, goal: to, cost, heuristic });
  const out: PlanResult = {
    best: null,
    alternatives: [],
    algo,
    explored: Int32Array.from(explored),
    expanded: main.expanded,
    astarExpanded: ast.expanded,
    ucsExpanded: opt.expanded,
    optimalCost: opt.found ? opt.cost : Infinity,
  };
  if (!main.found) return out;
  out.best = describe(net, main.path, main.edges, main.cost, c, time);
  // Alternatives: make the roads already used more expensive and search again.
  const used = new Map<number, number>();
  const mark = (edges: number[]) => edges.forEach((e) => used.set(e, (used.get(e) ?? 0) + 1));
  mark(main.edges);
  const penalised = (e: number) => cost(e) * (1 + 1.5 * (used.get(e) ?? 0));
  const taken = [main.edges];
  for (let k = 0; k < 8 && out.alternatives.length < 2; k++) {
    const r = astar({ graph: g, start: from, goal: to, cost: penalised, heuristic });
    if (!r.found) break;
    mark(r.edges);
    if (taken.some((t) => overlap(net, t, r.edges) > 0.55)) continue;
    let real = 0;
    for (const e of r.edges) real += cost(e);
    if (real > 2.5 * out.best.cost) continue;
    // Dual carriageways are separate edges of the same street: skip routes
    // whose main streets are the same as one already shown.
    const info = describe(net, r.path, r.edges, real, c, time);
    if (info.via === out.best.via || out.alternatives.some((a) => a.via === info.via)) continue;
    taken.push(r.edges);
    out.alternatives.push(info);
  }
  out.alternatives.sort((a, b) => a.cost - b.cost);
  return out;
}

export type JourneyEvent =
  /** A new route. `prev` = what is left of the route it replaces, under current conditions. */
  | { kind: 'plan'; minute: number; plan: PlanResult; reason: 'start' | 'blocked' | 'better' | 'retry'; prev?: RouteInfo }
  | { kind: 'blocked'; minute: number; edge: number; depth: number; route: RouteInfo }
  | { kind: 'depart'; minute: number }
  | { kind: 'turnback'; minute: number; edge: number }
  | { kind: 'pushon'; minute: number; edge: number }
  | { kind: 'stuck'; minute: number; node: number }
  | { kind: 'arrive'; minute: number; tripMinutes: number };

/** Re-plan when a clearly better route appears (checked every this many minutes). */
const BETTER_EVERY = 10;
const BETTER_MARGIN = 0.15;

export class Journey {
  status: 'planning' | 'driving' | 'stuck' | 'arrived' = 'planning';
  /** The route being followed (or planned, before departure). */
  route: RouteInfo | null = null;
  alternatives: RouteInfo[] = [];
  /** Routes that were given up because a road on them closed (for drawing). */
  abandoned: { route: RouteInfo; edge: number; minute: number }[] = [];
  /** Position: on route.edges[i], pos metres along it from route.nodes[i]. */
  i = 0;
  pos = 0;
  departedAt = -1;
  arrivedAt = -1;
  replans = 0;
  lastPlan: PlanResult | null = null;
  private lastBetterCheck = -1e9;
  /** Finishing or backing out of a road that closed under the car. */
  private recovering = false;
  /** Before departure, no route exists from the start (reported once). */
  private noRoute = false;

  constructor(
    readonly net: JourneyNet,
    readonly start: number,
    readonly goal: number,
    readonly departAt: number,
    readonly algo: Algo,
  ) {}

  /** The junction the car would re-plan from (the next one ahead, or where it is). */
  get from(): number {
    if (!this.route) return this.start;
    return this.route.nodes[this.pos > 0 ? this.i + 1 : this.i] ?? this.route.nodes[this.route.nodes.length - 1];
  }

  /** Position for drawing: [x, y] in metres. */
  position(): [number, number] {
    const g = this.net.graph;
    if (!this.route || this.status === 'planning') return [g.x[this.start], g.y[this.start]];
    if (this.status === 'arrived') return [g.x[this.goal], g.y[this.goal]];
    const a = this.route.nodes[this.i], b = this.route.nodes[this.i + 1];
    if (b === undefined) return [g.x[a], g.y[a]];
    const e = this.route.edges[this.i];
    const f = Math.min(1, this.pos / Math.max(1, this.net.length[e]));
    return [g.x[a] + (g.x[b] - g.x[a]) * f, g.y[a] + (g.y[b] - g.y[a]) * f];
  }

  /** Advance to `minute` (from the previous minute) under these conditions. */
  step(minute: number, dtMinutes: number, c: Conditions): JourneyEvent[] {
    const ev: JourneyEvent[] = [];
    if (this.status === 'arrived') return ev;
    const { time } = makeCosts(this.net, c);

    // First plan, or retrying while the start is cut off.
    if (!this.route && this.status === 'planning') {
      if (!this.noRoute) {
        this.plan(minute, c, 'start', ev);
        if (!this.route) this.noRoute = true;
        return ev;
      }
      const p = planRoutes(this.net, this.start, this.goal, c, this.algo);
      if (!p.best) return ev;
      this.noRoute = false;
      this.adopt(minute, p, 'retry', ev, 0);
    }

    if (this.status === 'planning') {
      // Before departure: keep the planned route valid.
      this.checkAhead(minute, c, ev, 0);
      if (minute >= this.departAt && this.route) {
        this.status = 'driving';
        this.departedAt = minute;
        this.i = 0;
        this.pos = 0;
        ev.push({ kind: 'depart', minute });
      } else {
        this.refreshAlternatives(c);
        return ev;
      }
    }

    if (this.status === 'stuck') {
      // Waiting at a junction: try again every minute.
      const at = this.from;
      const p = planRoutes(this.net, at, this.goal, c, this.algo);
      this.lastPlan = p;
      if (p.best) {
        this.route = p.best;
        this.alternatives = p.alternatives;
        this.i = 0;
        this.pos = 0;
        this.status = 'driving';
        this.replans++;
        ev.push({ kind: 'plan', minute, plan: p, reason: 'retry' });
      } else return ev;
    }

    // Driving.
    const r = this.route!;
    const e = r.edges[this.i];
    if (e !== undefined && this.pos > 0 && c.state[e] === 2 && !this.recovering) {
      // The road under the car just went under.
      if (midEdgeDecision(this.pos, this.net.length[e]) === 'turnBack') {
        const back = r.nodes[this.i], ahead = r.nodes[this.i + 1];
        this.route = { ...r, nodes: [ahead, back], edges: [e] };
        this.pos = this.net.length[e] - this.pos;
        this.i = 0;
        ev.push({ kind: 'turnback', minute, edge: e });
      } else ev.push({ kind: 'pushon', minute, edge: e });
      this.recovering = true;
    } else if (!this.recovering) {
      this.checkAhead(minute, c, ev, this.pos > 0 ? this.i + 1 : this.i);
    }
    if (!this.route) return ev;
    this.move(minute, dtMinutes * 60, c, time, ev);
    this.refreshAlternatives(c);
    return ev;
  }

  /** If a road ahead has closed, re-plan; every few minutes, take a clearly better route. */
  private checkAhead(minute: number, c: Conditions, ev: JourneyEvent[], fromIdx: number) {
    const r = this.route!;
    let blocked = -1;
    for (let k = fromIdx; k < r.edges.length; k++) {
      if (c.state[r.edges[k]] === 2) {
        blocked = r.edges[k];
        break;
      }
    }
    if (blocked >= 0) {
      const old = reassess(this.net, r, c, fromIdx);
      ev.push({ kind: 'blocked', minute, edge: blocked, depth: c.depth[blocked], route: old });
      this.abandoned.push({ route: old, edge: blocked, minute });
      if (this.abandoned.length > 3) this.abandoned.shift();
      this.plan(minute, c, 'blocked', ev, fromIdx, old);
      return;
    }
    if (minute - this.lastBetterCheck >= BETTER_EVERY) {
      this.lastBetterCheck = minute;
      const rest = reassess(this.net, r, c, fromIdx);
      const from = r.nodes[fromIdx];
      if (from === undefined) return;
      const p = planRoutes(this.net, from, this.goal, c, this.algo);
      if (p.best && p.best.cost < rest.cost * (1 - BETTER_MARGIN) && !sameRoute(p.best.edges, rest.edges)) this.adopt(minute, p, 'better', ev, fromIdx, rest);
    }
  }

  private plan(minute: number, c: Conditions, reason: 'start' | 'blocked', ev: JourneyEvent[], fromIdx = 0, prev?: RouteInfo) {
    const from = this.route ? (this.route.nodes[fromIdx] ?? this.start) : this.start;
    const p = planRoutes(this.net, from, this.goal, c, this.algo);
    this.lastPlan = p;
    if (!p.best) {
      // Nowhere to go: stop at the next junction and wait for the water to drop.
      if (this.route && this.status === 'driving') {
        this.route = { ...this.route, nodes: this.route.nodes.slice(0, fromIdx + 1), edges: this.route.edges.slice(0, fromIdx) };
        if (fromIdx === 0 || this.i >= this.route.edges.length) this.status = 'stuck';
      } else if (this.status === 'planning') {
        this.route = null;
        this.noRoute = true;
      }
      ev.push({ kind: 'plan', minute, plan: p, reason, prev });
      if (this.status === 'stuck' || !this.route) ev.push({ kind: 'stuck', minute, node: from });
      return;
    }
    this.adopt(minute, p, reason, ev, fromIdx, prev);
  }

  private adopt(minute: number, p: PlanResult, reason: 'start' | 'blocked' | 'better' | 'retry', ev: JourneyEvent[], fromIdx: number, prev?: RouteInfo) {
    this.lastPlan = p;
    if (this.route && this.status === 'driving') {
      // Keep the part already driven up to the junction we re-plan from.
      const kept = { nodes: this.route.nodes.slice(0, fromIdx), edges: this.route.edges.slice(0, fromIdx) };
      this.route = { ...p.best!, nodes: kept.nodes.concat(p.best!.nodes), edges: kept.edges.concat(p.best!.edges) };
    } else {
      this.route = p.best;
      this.i = 0;
      this.pos = 0;
    }
    this.alternatives = p.alternatives;
    if (reason !== 'start') this.replans++;
    ev.push({ kind: 'plan', minute, plan: p, reason, prev });
  }

  private refreshAlternatives(c: Conditions) {
    this.alternatives = this.alternatives.map((a) => reassess(this.net, a, c));
  }

  /** Drive for `seconds` along the route. */
  private move(minute: number, seconds: number, c: Conditions, time: (e: number) => number, ev: JourneyEvent[]) {
    let budget = seconds;
    while (budget > 1e-6 && this.route) {
      const r = this.route;
      if (this.i >= r.edges.length) {
        const at = r.nodes[r.nodes.length - 1];
        if (at === this.goal) {
          this.status = 'arrived';
          this.arrivedAt = minute;
          ev.push({ kind: 'arrive', minute, tripMinutes: minute - this.departedAt });
        } else {
          // End of a short route (after turning back or stopping): plan from here.
          const p = planRoutes(this.net, at, this.goal, c, this.algo);
          this.lastPlan = p;
          if (p.best) {
            this.route = p.best;
            this.alternatives = p.alternatives;
            this.i = 0;
            this.pos = 0;
            this.replans++;
            ev.push({ kind: 'plan', minute, plan: p, reason: 'retry' });
            continue;
          }
          this.status = 'stuck';
          this.route = { ...r, nodes: [at], edges: [] };
          this.i = 0;
          this.pos = 0;
          ev.push({ kind: 'stuck', minute, node: at });
        }
        return;
      }
      const e = r.edges[this.i];
      let t = time(e);
      // Pushing through (or backing out of) a road that just closed: very slowly.
      if (!Number.isFinite(t)) t = this.recovering ? this.net.length[e] / 0.8 : Infinity;
      if (!Number.isFinite(t)) {
        this.status = 'stuck';
        ev.push({ kind: 'stuck', minute, node: r.nodes[this.i] });
        return;
      }
      const speed = this.net.length[e] / t;
      const need = (this.net.length[e] - this.pos) / speed;
      if (need <= budget) {
        budget -= need;
        this.pos = 0;
        this.i++;
        this.recovering = false;
      } else {
        this.pos += speed * budget;
        budget = 0;
      }
    }
  }
}

function sameRoute(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((e, i) => e === b[i]);
}
