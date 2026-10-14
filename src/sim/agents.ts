/**
 * Evacuee groups moving through the flooding road network.
 *
 * Runs inside the flood engine, one step per simulated minute, right after
 * the water moves, so agents and flood stay in lock-step and rewinding the
 * timeline restores both exactly (agent state is part of every keyframe).
 *
 * Strategies (the comparison on the Experiments page):
 *   naive    Plan once at departure with the dry, free-flow shortest path
 *            to the nearest centre (ignoring capacity). Never re-plans: at a
 *            closed road it waits for the water to go down.
 *   dynamic  A* on current road states, capacity-aware nearest centre, and
 *            live re-planning with hysteresis (see ai/search/replanner.ts).
 *   risk     As dynamic, but the cost also weighs flood risk on each road
 *            (lambda * P_flood), so routes keep away from roads about to go
 *            under. (Phase 7 adds CSP + simulated annealing assignment.)
 */
import { makeCostFromArrays } from '../ai/search/cost';
import { midEdgeDecision, nearestShelter, PERIODIC_EVERY, remainingCost, routeTo, shouldAdoptOptional, type ShelterSlot } from '../ai/search/replanner';
import type { SearchGraph } from '../ai/search/types';
import { speedFactor, type TravelMode } from './hydrology';

export type Strategy = 'naive' | 'dynamic' | 'risk';

/** Status codes, also sent to the renderer. */
export const Status = { Waiting: 0, Moving: 1, Sheltered: 2, Stranded: 3, Stuck: 4, Recovering: 5, NoAccess: 6 } as const;
type StatusCode = (typeof Status)[keyof typeof Status];

export interface NetData {
  nodeX: Float32Array;
  nodeY: Float32Array;
  adjStart: Int32Array;
  adjNode: Int32Array;
  adjEdge: Int32Array;
  edgeA: Int32Array;
  edgeB: Int32Array;
  length: Float32Array;
  speed: Float32Array;
  /** Interior polyline of edge e: geom[geomOffset[e] .. geomOffset[e+1]) as x,y pairs. */
  geomOffset: Int32Array;
  geom: Float32Array;
  vmax: number;
}

export interface GroupSpec {
  hood: number;
  size: number;
  /** Starting junction, or -1 when the neighbourhood has no road access. */
  node: number;
  departAt: number;
}

export interface AgentSetup {
  net: NetData;
  shelters: { node: number; capacity: number }[];
  groups: GroupSpec[];
  strategy: Strategy;
  mode: TravelMode;
  lambda: number;
}

interface Group {
  spec: GroupSpec;
  status: StatusCode;
  route: number[];
  edges: number[];
  /** Index of the edge being travelled in `edges` (route[i] -> route[i+1]). */
  i: number;
  /** Metres travelled along the current edge. */
  pos: number;
  shelter: number;
  replans: number;
  lastSwitch: number;
  lastCheck: number;
  /** Shelter index -> minute until which it is avoided (after being turned away). */
  taboo: Record<number, number>;
  arrivedAt: number;
  startedAt: number;
  /** Set while finishing or backing off a road that blocked under the group. */
  recovering: boolean;
  routeVersion: number;
}

export interface AgentMetrics {
  sheltered: number;
  enRoute: number;
  waiting: number;
  stranded: number;
  noAccess: number;
  meanMinutes: number;
  p95Minutes: number;
  replans: number;
  groups: number;
}

export interface AgentSnapshot {
  groups: Group[];
  loads: number[];
  prevState: Uint8Array | null;
}

export class AgentSim {
  readonly s: AgentSetup;
  private g: SearchGraph;
  private groups: Group[] = [];
  private slots: ShelterSlot[];
  private prevState: Uint8Array | null = null;
  /** Free-flow (dry) cost, used by the naive strategy. */
  private dryCost: (e: number) => number;
  private cum: Float32Array[] = [];
  /** Groups whose route changed since the last call to takeRouteChanges(). */
  private changed = new Set<number>();

  constructor(setup: AgentSetup) {
    this.s = setup;
    const n = setup.net;
    this.g = { n: n.nodeX.length, x: n.nodeX, y: n.nodeY, adjStart: n.adjStart, adjNode: n.adjNode, adjEdge: n.adjEdge };
    this.slots = setup.shelters.map((s) => ({ node: s.node, capacity: s.capacity, load: 0 }));
    this.dryCost = makeCostFromArrays(n.length, n.speed, { mode: setup.mode });
    this.reset();
  }

  reset(): void {
    this.groups = this.s.groups.map((spec) => ({
      spec,
      status: spec.node < 0 ? Status.NoAccess : Status.Waiting,
      route: spec.node >= 0 ? [spec.node] : [],
      edges: [],
      i: 0,
      pos: 0,
      shelter: -1,
      replans: 0,
      lastSwitch: -1e9,
      lastCheck: 0,
      taboo: {},
      arrivedAt: -1,
      startedAt: -1,
      recovering: false,
      routeVersion: 0,
    }));
    for (const s of this.slots) s.load = 0;
    this.prevState = null;
    this.changed = new Set(this.groups.map((_, i) => i));
  }

  snapshot(): AgentSnapshot {
    return { groups: structuredClone(this.groups), loads: this.slots.map((s) => s.load), prevState: this.prevState ? this.prevState.slice() : null };
  }

  restore(s: AgentSnapshot): void {
    this.groups = structuredClone(s.groups);
    s.loads.forEach((l, i) => (this.slots[i].load = l));
    this.prevState = s.prevState ? s.prevState.slice() : null;
    this.changed = new Set(this.groups.map((_, i) => i));
  }

  /** One simulated minute. `state`/`depth` are the road states after this minute's water. */
  step(minute: number, state: Uint8Array, depth: Float32Array, risk: Float32Array | null): void {
    const { strategy, mode, lambda } = this.s;
    const live = makeCostFromArrays(this.s.net.length, this.s.net.speed, { mode, state, depth, risk: risk ?? undefined, lambda: strategy === 'risk' ? lambda : 0 });
    const prev = this.prevState;
    const blockedNow = (e: number) => state[e] === 2;
    const becameBlocked = (e: number) => state[e] === 2 && (!prev || prev[e] !== 2);
    const becameWorse = (e: number) => !!prev && state[e] > prev[e];

    for (let gi = 0; gi < this.groups.length; gi++) {
      const G = this.groups[gi];
      switch (G.status) {
        case Status.Sheltered:
        case Status.NoAccess:
          continue;
        case Status.Waiting:
          if (minute >= G.spec.departAt) this.plan(gi, minute, live, true);
          continue;
        case Status.Stranded:
          // Keep trying every 10 minutes: roads reopen as the water drains.
          if ((minute - G.spec.departAt) % 10 === 0) this.plan(gi, minute, live, false);
          continue;
      }

      // ── Moving, stuck or recovering ──
      const e = G.edges[G.i];
      if (e !== undefined && G.pos > 0 && becameBlocked(e) && !G.recovering) {
        // The road under the group just went under.
        const decision = midEdgeDecision(G.pos, this.s.net.length[e]);
        G.recovering = true;
        G.status = Status.Recovering;
        if (decision === 'turnBack') {
          // Reverse along the same edge to the node we came from.
          const back = G.route[G.i];
          const ahead = G.route[G.i + 1];
          G.route = [ahead, back];
          G.edges = [e];
          G.i = 0;
          G.pos = this.s.net.length[e] - G.pos;
          this.markChanged(gi);
        }
      }

      if (strategy !== 'naive' && !G.recovering) {
        // Mandatory re-plan if any road ahead is now blocked; optional on worsening or periodically.
        let mandatory = false, optional = false;
        for (let k = G.i + (G.pos > 0 ? 1 : 0); k < G.edges.length; k++) {
          const ek = G.edges[k];
          if (blockedNow(ek)) {
            mandatory = true;
            break;
          }
          if (becameWorse(ek)) optional = true;
        }
        if (minute - G.lastCheck >= PERIODIC_EVERY) optional = true;
        if (mandatory || optional) this.replan(gi, minute, live, mandatory);
      }

      this.advance(gi, minute, state, depth, live);
    }
    this.prevState = state.slice();
  }

  private markChanged(gi: number): void {
    this.groups[gi].routeVersion++;
    this.changed.add(gi);
  }

  /** First plan (or a retry when stranded). */
  private plan(gi: number, minute: number, live: (e: number) => number, first: boolean): void {
    const G = this.groups[gi];
    const at = G.route[G.route.length - 1] ?? G.spec.node;
    const naive = this.s.strategy === 'naive';
    const cost = naive ? this.dryCost : live;
    const skip = (s: number) => (G.taboo[s] ?? -1) > minute;
    const r = nearestShelter(this.g, at, cost, this.slots, G.spec.size, skip, naive);
    if (first) G.startedAt = minute;
    if (!r) {
      G.status = Status.Stranded;
      return;
    }
    this.assign(gi, r.shelter);
    G.route = r.nodes;
    G.edges = r.edges;
    G.i = 0;
    G.pos = 0;
    G.status = Status.Moving;
    G.lastCheck = minute;
    if (!first) G.replans++;
    this.markChanged(gi);
  }

  private assign(gi: number, shelter: number): void {
    const G = this.groups[gi];
    // Naive groups do not book places; they just turn up.
    const books = this.s.strategy !== 'naive';
    if (books && G.shelter >= 0) this.slots[G.shelter].load -= G.spec.size;
    G.shelter = shelter;
    if (books) this.slots[shelter].load += G.spec.size;
  }

  /** Re-plan from the next junction (a group on a road finishes that road first). */
  private replan(gi: number, minute: number, live: (e: number) => number, mandatory: boolean): void {
    const G = this.groups[gi];
    G.lastCheck = minute;
    const k = G.pos > 0 ? G.i + 1 : G.i;
    const from = G.route[k];
    if (from === undefined || G.shelter < 0) return;
    const current = remainingCost(G.edges, k, live);
    let next: { shelter: number; nodes: number[]; edges: number[]; cost: number } | null = null;
    const r = routeTo(this.g, from, this.slots[G.shelter].node, live, this.s.net.vmax);
    if (r.found) next = { shelter: G.shelter, nodes: r.path, edges: r.edges, cost: r.cost };
    if (!next || (mandatory && !Number.isFinite(next.cost))) {
      // The centre itself is cut off: look for another with room.
      const skip = (s: number) => s === G.shelter || (G.taboo[s] ?? -1) > minute;
      next = nearestShelter(this.g, from, live, this.slots, G.spec.size, skip);
    }
    if (!next) {
      if (mandatory) {
        // Nowhere to go from here: stop at the next junction and wait.
        G.route = G.route.slice(0, k + 1);
        G.edges = G.edges.slice(0, k);
        this.markChanged(gi);
      }
      return;
    }
    if (!mandatory && !shouldAdoptOptional(next.cost, current, minute, G.lastSwitch)) return;
    if (next.shelter !== G.shelter) {
      G.taboo[G.shelter] = minute + 60;
      this.assign(gi, next.shelter);
    }
    G.route = G.route.slice(0, k).concat(next.nodes);
    G.edges = G.edges.slice(0, k).concat(next.edges);
    G.replans++;
    G.lastSwitch = minute;
    this.markChanged(gi);
  }

  /** Move a group for one minute along its route. */
  private advance(gi: number, minute: number, state: Uint8Array, depth: Float32Array, live: (e: number) => number): void {
    const G = this.groups[gi];
    const net = this.s.net;
    let budget = 60; // seconds
    while (budget > 1e-6) {
      if (G.i >= G.edges.length) {
        // At the end of the route.
        const at = G.route[G.route.length - 1];
        if (G.recovering) {
          // Back on a junction after a road blocked under us: plan afresh.
          G.recovering = false;
          G.status = Status.Moving;
          this.plan(gi, minute, live, false);
          if (G.status !== Status.Moving) return;
          continue;
        }
        if (G.shelter >= 0 && at === this.slots[G.shelter].node) {
          this.arrive(gi, minute, live);
          return;
        }
        // Route ended short of the centre (cut off): try again next minute.
        G.status = Status.Stranded;
        return;
      }
      const e = G.edges[G.i];
      const len = net.length[e];
      const s = state[e];
      let speed: number;
      if (G.recovering) speed = 0.8; // wading / pushing through slowly
      else if (s === 2) {
        // A closed road ahead. Dynamic groups have re-planned already; naive ones wait.
        G.status = Status.Stuck;
        return;
      } else {
        // Free-flow speed, slowed by water over the road.
        const base = this.s.mode === 'foot' ? 1.2 : net.speed[e];
        speed = base * (s === 1 ? Math.max(0.2, speedFactor(depth[e], this.s.mode)) : 1);
      }
      if (G.status === Status.Stuck) G.status = Status.Moving;
      const need = (len - G.pos) / speed;
      if (need <= budget) {
        budget -= need;
        G.pos = 0;
        G.i++;
        if (G.recovering && G.i >= G.edges.length) continue;
      } else {
        G.pos += speed * budget;
        budget = 0;
      }
    }
  }

  private arrive(gi: number, minute: number, live: (e: number) => number): void {
    const G = this.groups[gi];
    const slot = this.slots[G.shelter];
    const books = this.s.strategy !== 'naive';
    const fits = books ? slot.load <= slot.capacity : slot.load + G.spec.size <= slot.capacity;
    if (fits) {
      if (!books) slot.load += G.spec.size;
      G.status = Status.Sheltered;
      G.arrivedAt = minute;
      return;
    }
    // Full on arrival (naive groups don't book): go to the next nearest centre.
    G.taboo[G.shelter] = minute + 120;
    if (books) slot.load -= G.spec.size;
    G.shelter = -1;
    G.route = [slot.node];
    G.edges = [];
    G.i = 0;
    G.pos = 0;
    this.plan(gi, minute, this.s.strategy === 'naive' ? this.dryCost : live, false);
  }

  // ─────────────── Read-outs ───────────────

  /** Positions for drawing: [x, y, status, size, shelter, replans] per group. */
  positions(out: Float32Array = new Float32Array(this.groups.length * 6)): Float32Array {
    const net = this.s.net;
    this.groups.forEach((G, gi) => {
      let x = 0, y = 0;
      const node = G.route[Math.min(G.i, G.route.length - 1)] ?? G.spec.node;
      if (G.status === Status.Sheltered && G.shelter >= 0) {
        const s = this.slots[G.shelter].node;
        x = net.nodeX[s];
        y = net.nodeY[s];
      } else if (G.i < G.edges.length && G.pos > 0) {
        [x, y] = this.pointOnEdge(G.edges[G.i], G.route[G.i], G.pos);
      } else if (node >= 0) {
        x = net.nodeX[node];
        y = net.nodeY[node];
      }
      const o = gi * 6;
      out[o] = x;
      out[o + 1] = y;
      out[o + 2] = G.status;
      out[o + 3] = G.spec.size;
      out[o + 4] = G.shelter;
      out[o + 5] = G.replans;
    });
    return out;
  }

  /** Remaining route of each group whose plan changed, since the last call. */
  takeRouteChanges(): { ids: Int32Array; offsets: Int32Array; nodes: Int32Array } | null {
    if (this.changed.size === 0) return null;
    const ids = [...this.changed].sort((a, b) => a - b);
    this.changed.clear();
    const offsets = new Int32Array(ids.length + 1);
    const all: number[] = [];
    ids.forEach((gi, k) => {
      const G = this.groups[gi];
      if (G.status !== Status.Sheltered) for (let j = G.i; j < G.route.length; j++) all.push(G.route[j]);
      offsets[k + 1] = all.length;
    });
    return { ids: Int32Array.from(ids), offsets, nodes: Int32Array.from(all) };
  }

  metrics(): AgentMetrics {
    let sheltered = 0, enRoute = 0, waiting = 0, stranded = 0, noAccess = 0, replans = 0;
    const times: number[] = [];
    for (const G of this.groups) {
      const p = G.spec.size;
      replans += G.replans;
      switch (G.status) {
        case Status.Sheltered:
          sheltered += p;
          times.push(G.arrivedAt - G.startedAt);
          break;
        case Status.Waiting:
          waiting += p;
          break;
        case Status.Stranded:
          stranded += p;
          break;
        case Status.NoAccess:
          noAccess += p;
          break;
        default:
          enRoute += p;
      }
    }
    times.sort((a, b) => a - b);
    const mean = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;
    const p95 = times.length ? times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] : 0;
    return { sheltered, enRoute, waiting, stranded, noAccess, meanMinutes: mean, p95Minutes: p95, replans, groups: this.groups.length };
  }

  private pointOnEdge(e: number, from: number, dist: number): [number, number] {
    const net = this.s.net;
    let cum = this.cum[e];
    const forward = net.edgeA[e] === from;
    // Build the polyline from `from` to the other end.
    const pts: number[] = [];
    const a = net.edgeA[e], b = net.edgeB[e];
    pts.push(net.nodeX[a], net.nodeY[a]);
    for (let i = net.geomOffset[e]; i < net.geomOffset[e + 1]; i += 2) pts.push(net.geom[i], net.geom[i + 1]);
    pts.push(net.nodeX[b], net.nodeY[b]);
    if (!cum) {
      cum = new Float32Array(pts.length / 2);
      for (let i = 1; i < cum.length; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
      this.cum[e] = cum;
    }
    const total = cum[cum.length - 1] || 1;
    // Distance measured from node a.
    const d = Math.min(total, Math.max(0, (forward ? dist : net.length[e] - dist) * (total / Math.max(1e-6, net.length[e]))));
    for (let i = 1; i < cum.length; i++) {
      if (cum[i] >= d) {
        const t = (d - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
        return [pts[i * 2 - 2] + (pts[i * 2] - pts[i * 2 - 2]) * t, pts[i * 2 - 1] + (pts[i * 2 + 1] - pts[i * 2 - 1]) * t];
      }
    }
    return [pts[pts.length - 2], pts[pts.length - 1]];
  }
}
