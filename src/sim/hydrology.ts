/**
 * Hydrology glue between the world and the flood model:
 *   - per-cell drain capacity, infiltration and roughness from the map;
 *   - road states (open / degraded / blocked) from water depth;
 *   - the instant "water level" flood used by the slider.
 * Pure functions; shared by the worker and the main thread.
 */
import type { World } from '../world/types';
import type { FloodSetup, Forcing } from './floodModel';
import { SCENARIOS, resolveStorm, type ScenarioParams } from './scenario';

/** Storm drains: Mumbai's design standard is about 25 mm/h. */
const DRAIN_MM_H = 25;

export function buildFloodSetup(w: World): FloodSetup {
  const t = w.terrain;
  const N = t.n * t.n;
  const drainRate = new Float32Array(N);
  const infil = new Float32Array(N);
  const manning = new Float32Array(N);
  const initialDepth = new Float32Array(N);
  const quality = w.hoods.map((h) => h.drainage);
  for (let k = 0; k < N; k++) {
    if (w.sea[k]) {
      manning[k] = 0.025;
      continue;
    }
    if (t.channel[k]) {
      // Channels carry water; they don't have storm drains of their own.
      manning[k] = 0.032;
      infil[k] = 0;
      continue;
    }
    const h = w.cellHood[k];
    const q = h >= 0 ? quality[h] : 0.5;
    // Drain capacity scales with drainage quality (0.3x to 1.4x the design standard).
    drainRate[k] = ((DRAIN_MM_H * (0.3 + 1.1 * q)) / 1000) / 3600;
    // Paved city: little infiltration. Open ground on hills soaks more.
    const rel = w.ground[k];
    infil[k] = ((rel > 20 ? 6 : 2) / 1000) / 3600;
    // Dense built-up blocks slow water more than open ground.
    manning[k] = 0.05;
  }
  // Lakes start full; rivers and nallahs start at a normal dry-weather depth.
  for (let k = 0; k < N; k++) {
    if (w.sea[k]) continue;
    const carve = w.ground[k] - t.height[k];
    if (t.channel[k]) initialDepth[k] = Math.min(0.6, Math.max(0, carve));
    else if (carve > 1) initialDepth[k] = carve;
  }
  return { n: t.n, cell: t.cell, bed: t.height, sea: w.sea, drainRate, infil, manning, inflowCells: w.river.inflowCells, initialDepth };
}

export function buildForcing(p: ScenarioParams): Forcing {
  const info = SCENARIOS[p.scenario];
  return {
    storm: resolveStorm(p),
    upstreamArea: info.upstreamKm2 * 1e6,
    runoffCoeff: 0.65,
    lag: info.lag,
    baseFlow: 3,
    tideOffset: p.tideOffset,
    drainScale: p.drainScale,
    rainOverrides: [],
  };
}

// ─────────────────────────── Road states ───────────────────────────

export type TravelMode = 'vehicle' | 'foot';

/** Water depth over the road (m) at which a road becomes degraded / blocked. */
export const THRESHOLDS: Record<TravelMode, { degraded: number; blocked: number }> = {
  vehicle: { degraded: 0.15, blocked: 0.3 },
  foot: { degraded: 0.25, blocked: 0.5 },
};

/** Compact edge description that can be posted to a worker. */
export interface EdgeTable {
  count: number;
  /** cells of edge e are cells[offset[e] .. offset[e+1]). */
  offset: Int32Array;
  cells: Int32Array;
  /** 0 road, 1 bridge, 2 flyover, 3 tunnel */
  kind: Uint8Array;
  deck: Float32Array;
  /** For bridges: the water cells under the deck. */
  underOffset: Int32Array;
  underCells: Int32Array;
}

const KIND_CODE = { road: 0, bridge: 1, flyover: 2, tunnel: 3 } as const;

export function buildEdgeTable(w: World): EdgeTable {
  const E = w.graph.edges;
  const offset = new Int32Array(E.length + 1);
  const underOffset = new Int32Array(E.length + 1);
  const all: number[] = [];
  const under: number[] = [];
  const t = w.terrain;
  E.forEach((e, i) => {
    for (const c of e.cells) all.push(c);
    offset[i + 1] = all.length;
    if (e.kind === 'bridge') {
      // Water cells along the straight line between the bridge ends.
      const A = w.graph.nodes[e.a], B = w.graph.nodes[e.b];
      const steps = Math.max(2, Math.ceil(e.length / (t.cell * 0.5)));
      for (let s = 0; s <= steps; s++) {
        const x = A.x + ((B.x - A.x) * s) / steps, y = A.y + ((B.y - A.y) * s) / steps;
        const ci = Math.min(t.n - 1, Math.max(0, Math.floor(x / t.cell)));
        const cj = Math.min(t.n - 1, Math.max(0, Math.floor(y / t.cell)));
        const k = cj * t.n + ci;
        if ((t.channel[k] || w.sea[k]) && !under.includes(k)) under.push(k);
      }
    }
    underOffset[i + 1] = under.length;
  });
  return {
    count: E.length,
    offset,
    cells: Int32Array.from(all),
    kind: Uint8Array.from(E.map((e) => KIND_CODE[e.kind])),
    deck: Float32Array.from(E.map((e) => (Number.isFinite(e.deckLevel) ? e.deckLevel : 1e9))),
    underOffset,
    underCells: Int32Array.from(under),
  };
}

/**
 * Road states from the water field.
 *   road:    depth over the road = water surface minus the ground the road sits on
 *   tunnel:  water pours down into the dip, so it fills about 4x faster
 *   flyover: never floods
 *   bridge:  approaches flood like roads; the deck closes when the river
 *            surface under it rises above the deck level
 * Writes 0 open, 1 degraded, 2 blocked into `state` and the depth into `depthOut`.
 */
export function computeEdgeStates(
  tbl: EdgeTable,
  depth: Float32Array,
  bed: Float32Array,
  ground: Float32Array,
  mode: TravelMode,
  state: Uint8Array,
  depthOut: Float32Array,
): { blocked: number; degraded: number } {
  const th = THRESHOLDS[mode];
  let blocked = 0, degraded = 0;
  for (let e = 0; e < tbl.count; e++) {
    const kind = tbl.kind[e];
    let maxD = 0;
    if (kind !== 2) {
      for (let i = tbl.offset[e]; i < tbl.offset[e + 1]; i++) {
        const k = tbl.cells[i];
        const over = bed[k] + depth[k] - ground[k];
        if (over > maxD) maxD = over;
      }
      if (kind === 3) maxD = Math.min(3.5, maxD * 4);
    }
    let s = maxD >= th.blocked ? 2 : maxD >= th.degraded ? 1 : 0;
    if (kind === 1) {
      for (let i = tbl.underOffset[e]; i < tbl.underOffset[e + 1]; i++) {
        const k = tbl.underCells[i];
        if (depth[k] > 0.01 && bed[k] + depth[k] > tbl.deck[e]) {
          s = 2;
          maxD = Math.max(maxD, bed[k] + depth[k] - tbl.deck[e]);
        }
      }
    }
    state[e] = s;
    depthOut[e] = maxD;
    if (s === 2) blocked++;
    else if (s === 1) degraded++;
  }
  return { blocked, degraded };
}

/** Effective speed factor on a degraded road: slower as the water deepens. */
export function speedFactor(depth: number, mode: TravelMode): number {
  const th = THRESHOLDS[mode];
  if (depth < th.degraded) return 1;
  if (depth >= th.blocked) return 0;
  return Math.max(0.2, 1 - depth / th.blocked);
}

// ─────────────────────────── Instant water level ───────────────────────────

/**
 * "What if the water stood at L metres above sea level?" A connected
 * bathtub fill: water enters from the sea and the channel network, and
 * spreads to every cell reachable through ground lower than L. Isolated low
 * spots behind higher ground stay dry, which is what makes this better than
 * just thresholding the elevation. O(N) breadth-first search.
 */
export function waterLevelFlood(w: World, level: number, out = new Float32Array(w.terrain.n * w.terrain.n)): Float32Array {
  const t = w.terrain;
  const n = t.n, N = n * n, bed = t.height;
  out.fill(0);
  const seen = new Uint8Array(N);
  const queue = new Int32Array(N);
  let head = 0, tail = 0;
  for (let k = 0; k < N; k++) {
    if ((w.sea[k] || t.channel[k]) && bed[k] < level) {
      seen[k] = 1;
      queue[tail++] = k;
    }
  }
  while (head < tail) {
    const k = queue[head++];
    out[k] = level - bed[k];
    const i = k % n;
    if (i > 0 && !seen[k - 1] && bed[k - 1] < level) { seen[k - 1] = 1; queue[tail++] = k - 1; }
    if (i < n - 1 && !seen[k + 1] && bed[k + 1] < level) { seen[k + 1] = 1; queue[tail++] = k + 1; }
    if (k >= n && !seen[k - n] && bed[k - n] < level) { seen[k - n] = 1; queue[tail++] = k - n; }
    if (k < N - n && !seen[k + n] && bed[k + n] < level) { seen[k + n] = 1; queue[tail++] = k + n; }
  }
  return out;
}

/** Summary numbers for a depth field (land cells only). */
export function floodStats(w: World, depth: Float32Array): { floodedKm2: number; maxDepth: number; volume: number } {
  const t = w.terrain;
  const N = t.n * t.n;
  const a = t.cell * t.cell;
  let cells = 0, maxDepth = 0, volume = 0;
  for (let k = 0; k < N; k++) {
    if (w.sea[k] || t.channel[k]) continue;
    const over = t.height[k] + depth[k] - w.ground[k];
    if (over > 0.1) cells++;
    if (over > maxDepth) maxDepth = over;
    volume += depth[k] * a;
  }
  return { floodedKm2: (cells * a) / 1e6, maxDepth, volume };
}
