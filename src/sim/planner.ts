/**
 * Strategy 3's planner: assign evacuee groups to relief centres with the CSP,
 * improve the plan with simulated annealing, inside the running simulation.
 *
 * Called by the agent simulation (agents.ts) at the evacuation warning and
 * again whenever a group's centre becomes unreachable. Pure and
 * deterministic: no clocks (the CSP search has a NODE budget only, never a
 * time budget, which would make results depend on the machine), and the
 * annealer is seeded with (scenario seed, minute). So rewinding the
 * timeline and replaying gives exactly the same plans.
 *
 *   1. From each centre, one Dijkstra search over the live road network
 *      (risk-aware cost) gives every junction's travel time to the centre,
 *      and the flood exposure (P_flood x minutes) along that route.
 *   2. CSP: a group's domain is the centres it can reach within the deadline;
 *      capacity is what is left after the people already inside. Counting
 *      first (Hall's condition); if that proves there is no full plan, or the
 *      search runs out of nodes, the relaxed plan places as many as possible.
 *   3. Simulated annealing from the CSP plan, same energy as the Assignment page.
 */
import { solveCSP } from '../ai/csp/backtracking';
import { capacityNeighbours, UNASSIGNED, type CSP } from '../ai/csp/model';
import { explainInfeasibility, maximisePartial } from '../ai/csp/relax';
import { DEFAULT_WEIGHTS, summarise, type AssignmentModel } from '../ai/local/objective';
import { Annealer } from '../ai/local/simulatedAnnealing';
import type { SearchGraph } from '../ai/search/types';
import { MinHeap } from '../core/pq';

/** Longest acceptable trip when assigning, minutes (monsoon traffic speeds). */
export const PLAN_DEADLINE = 150;
/** CSP node budget inside the simulation. */
export const PLAN_NODES = 6000;
/** Annealing iterations per (re-)assignment. */
export const PLAN_SA_ITERATIONS = 40_000;
/**
 * When re-planning, moving a group that already has a centre costs this many
 * person-minutes per person: a move must save at least that much travel or
 * risk. Keeps re-assignment to the groups that actually need it.
 */
export const CHANGE_COST = 30;

export interface PlanGroup {
  /** Junction the group will start from (its position, or the next junction ahead). */
  node: number;
  size: number;
  hood: number;
  /** Current centre, tried first (warm start); -1 for none. */
  prefer: number;
}

export interface PlanInput {
  graph: SearchGraph;
  shelterNodes: number[];
  /** Places left in each centre for these groups. */
  room: number[];
  /** Routing cost per edge, seconds (risk-aware; Infinity = closed). */
  cost: (e: number) => number;
  /** Plain travel time per edge, seconds (no risk weight, no penalty). */
  time: (e: number) => number;
  /** P_flood per edge. */
  risk: Float32Array | null;
  groups: PlanGroup[];
  seed: string;
  lambda: number;
}

export interface PlanOutput {
  /** Centre per input group, -1 = none. */
  assign: Int32Array;
  /** Minutes from each group to its centre (NaN when none). */
  minutes: Float64Array;
  status: 'solved' | 'relaxed';
  /** Why a full plan was impossible (relaxed only). */
  why: string;
  nodes: number;
  backtracks: number;
  wipeouts: number;
  people: number;
  placed: number;
  /** Groups with no reachable centre at all. */
  cutOff: number;
  /** Energy of the CSP plan and after annealing (person-minutes). */
  energyCSP: number;
  energySA: number;
}

/** Shortest-path tree from one centre: cost, plain minutes and exposure to every junction. */
function treeFrom(g: SearchGraph, source: number, cost: (e: number) => number, time: (e: number) => number, risk: Float32Array | null) {
  const n = g.n;
  const best = new Float64Array(n).fill(Infinity);
  const minutes = new Float64Array(n).fill(Infinity);
  const exposure = new Float64Array(n).fill(Infinity);
  const done = new Uint8Array(n);
  const pq = new MinHeap<number>();
  best[source] = 0;
  minutes[source] = 0;
  exposure[source] = 0;
  pq.push(source, 0);
  while (!pq.isEmpty()) {
    const d = pq.peekPriority();
    const v = pq.pop()!;
    if (done[v] || d > best[v]) continue;
    done[v] = 1;
    for (let i = g.adjStart[v]; i < g.adjStart[v + 1]; i++) {
      const u = g.adjNode[i], e = g.adjEdge[i];
      const c = cost(e);
      if (!Number.isFinite(c) || done[u]) continue;
      if (d + c < best[u]) {
        best[u] = d + c;
        const t = time(e) / 60;
        minutes[u] = minutes[v] + t;
        exposure[u] = exposure[v] + (risk ? risk[e] : 0) * t;
        pq.push(u, d + c);
      }
    }
  }
  return { minutes, exposure };
}

/** Is `target` reachable from `start` at all under `cost`? (Plain BFS over open roads.) */
export function reachable(g: SearchGraph, start: number, target: number, cost: (e: number) => number): boolean {
  if (start === target) return true;
  if (start < 0) return false;
  const seen = new Uint8Array(g.n);
  const queue = [start];
  seen[start] = 1;
  for (let q = 0; q < queue.length; q++) {
    const v = queue[q];
    for (let i = g.adjStart[v]; i < g.adjStart[v + 1]; i++) {
      const u = g.adjNode[i];
      if (seen[u] || !Number.isFinite(cost(g.adjEdge[i]))) continue;
      if (u === target) return true;
      seen[u] = 1;
      queue.push(u);
    }
  }
  return false;
}

export function planAssignment(p: PlanInput): PlanOutput {
  const S = p.shelterNodes.length, G = p.groups.length;
  const trees = p.shelterNodes.map((node) => treeFrom(p.graph, node, p.cost, p.time, p.risk));
  const time = new Float64Array(G * S), exposure = new Float64Array(G * S);
  const domains: number[][] = [];
  p.groups.forEach((gr, x) => {
    const dom: number[] = [];
    for (let s = 0; s < S; s++) {
      const t = gr.node >= 0 ? trees[s].minutes[gr.node] : Infinity;
      time[x * S + s] = Number.isFinite(t) ? t : 0;
      exposure[x * S + s] = gr.node >= 0 && Number.isFinite(t) ? trees[s].exposure[gr.node] : 0;
      if (Number.isFinite(t) && t <= PLAN_DEADLINE && p.room[s] > 0) dom.push(s);
    }
    dom.sort((a, b) => time[x * S + a] - time[x * S + b] || a - b);
    domains.push(dom);
  });
  const csp: CSP = {
    names: p.groups.map((_, x) => `group ${x + 1}`),
    valueNames: p.shelterNodes.map((_, s) => `S${s + 1}`),
    domains,
    neighbours: capacityNeighbours(domains),
    size: p.groups.map((g) => g.size),
    capacity: p.room.map((r) => Math.max(0, r)),
    cost: (x, v) => time[x * S + v],
  };
  const prefer = Int32Array.from(p.groups, (g, x) => (g.prefer >= 0 && domains[x].includes(g.prefer) ? g.prefer : UNASSIGNED));
  const ex = explainInfeasibility(csp);
  let assign: Int32Array;
  let status: PlanOutput['status'] = 'solved';
  let why = '';
  let nodes = 0, backtracks = 0, wipeouts = 0;
  if (ex.feasibleByCounting) {
    const r = solveCSP(csp, { forwardChecking: true, mrv: true, degree: true, lcv: true, maxNodes: PLAN_NODES, maxMs: Infinity, prefer });
    nodes = r.nodes;
    backtracks = r.backtracks;
    wipeouts = r.wipeouts;
    if (r.status === 'solved') assign = r.assignment;
    else {
      status = 'relaxed';
      why = 'the search ran out of its node budget';
      assign = maximisePartial(csp, prefer).assignment;
    }
  } else {
    status = 'relaxed';
    why = ex.emptyDomains.length
      ? `${ex.emptyDomains.length} group${ex.emptyDomains.length > 1 ? 's' : ''} cannot reach any centre with room`
      : 'there are not enough places in the centres these groups can reach';
    assign = maximisePartial(csp, prefer).assignment;
  }
  const model: AssignmentModel = {
    G,
    S,
    H: Math.max(1, ...p.groups.map((g) => g.hood + 1)),
    size: Float64Array.from(p.groups, (g) => g.size),
    capacity: Float64Array.from(csp.capacity!),
    hood: Int32Array.from(p.groups, (g) => Math.max(0, g.hood)),
    time,
    exposure,
    options: domains.map((d) => Int32Array.from(d)),
    weights: { ...DEFAULT_WEIGHTS, lambda: p.lambda, change: CHANGE_COST },
    prefer: Int32Array.from(p.groups, (g) => g.prefer),
  };
  const energyCSP = summarise(model, assign).energy;
  let energySA = energyCSP;
  if (G > 1) {
    const sa = new Annealer(model, assign, { iterations: PLAN_SA_ITERATIONS, cooling: 'geometric', seed: p.seed, tracePoints: 10 }).finish();
    // Keep the annealed plan only if it is better and still within capacity.
    const s = summarise(model, sa.bestAssign);
    if (sa.bestEnergy < energyCSP && s.overloadedCentres === 0) {
      assign = sa.bestAssign;
      energySA = sa.bestEnergy;
    }
  }
  const minutes = new Float64Array(G).fill(NaN);
  let people = 0, placed = 0;
  p.groups.forEach((g, x) => {
    people += g.size;
    if (assign[x] >= 0) {
      placed += g.size;
      minutes[x] = time[x * S + assign[x]];
    }
  });
  return { assign, minutes, status, why, nodes, backtracks, wipeouts, people, placed, cutOff: ex.emptyDomains.length, energyCSP, energySA };
}
