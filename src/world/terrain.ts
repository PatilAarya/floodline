/**
 * Terrain and river generation.
 *
 * The terrain is defined as a continuous function of (x, y) and then sampled
 * into the grid. The road graph samples the same function, so the city is
 * identical whatever grid resolution the device can afford.
 *
 * Construction, in a local frame where u runs downstream and v across:
 *   1. River centreline v(u): a smooth meander from two octaves of 1D noise.
 *      Delta preset: a second branch peels away downstream.
 *   2. Bank level falls linearly downstream, so water has somewhere to go.
 *   3. Height = bank + low floodplain relief near the river, blending into
 *      fractal hills (fBm + ridged noise) further away.
 *   4. A parabolic channel is carved inside the river half-width.
 */
import { createNoise, smoothstep } from '../core/noise';
import type { Rng } from '../core/rng';
import type { River, Terrain, WorldParams } from './types';

type Edge = 'n' | 'e' | 's' | 'w';

export interface TerrainField {
  /** Ground height at (x, y). */
  height(x: number, y: number): number;
  /** Distance to the nearest river centreline (capped). */
  riverDist(x: number, y: number): number;
  /** Bank-full water level at (x, y), by position along the river. */
  bank(x: number, y: number): number;
  /** Signed side of the main river: -1 or +1. */
  side(x: number, y: number): number;
  /** Local downstream coordinate u in [0, size]. */
  along(x: number, y: number): number;
  river: River;
  size: number;
}

const DIST_CAP = 2400;
const STEP = 30; // centreline sample spacing, metres

export function buildTerrainField(p: WorldParams, rng: Rng): TerrainField {
  const S = p.mapSize;
  const noise = createNoise(`${rng.seed}::terrain`);
  const orient = rng.int(0, 3); // 0: W->E, 1: E->W, 2: N->S, 3: S->N
  const edges: [Edge, Edge][] = [
    ['w', 'e'],
    ['e', 'w'],
    ['n', 's'],
    ['s', 'n'],
  ];
  const [inflowEdge, outflowEdge] = edges[orient];

  // Local (u along, v across) <-> world (x, y).
  const toWorld = (u: number, v: number): [number, number] => {
    switch (orient) {
      case 0: return [u, v];
      case 1: return [S - u, S - v];
      case 2: return [S - v, u];
      default: return [v, S - u];
    }
  };
  const toLocal = (x: number, y: number): [number, number] => {
    switch (orient) {
      case 0: return [x, y];
      case 1: return [S - x, S - y];
      case 2: return [y, S - x];
      default: return [S - y, x];
    }
  };

  // ── 1. River centrelines in local coordinates ──
  const v0 = S * rng.range(0.42, 0.58);
  const phase = rng.range(0, 100);
  const A = p.meander * S;
  const vMain = (u: number) => {
    const t = u / S;
    const v = v0 + A * (0.75 * noise.simplex(t * 2.1 + phase, 3.1) + 0.35 * noise.simplex(t * 5.2 + phase, 7.7));
    return Math.min(S * 0.8, Math.max(S * 0.2, v));
  };
  const nSeg = Math.ceil((S + 120) / STEP);
  const mainU = new Float32Array(nSeg + 1);
  const mainV = new Float32Array(nSeg + 1);
  for (let i = 0; i <= nSeg; i++) {
    const u = -60 + i * STEP;
    mainU[i] = u;
    mainV[i] = vMain(u);
  }

  const lines: { u: Float32Array; v: Float32Array }[] = [{ u: mainU, v: mainV }];
  if (p.delta) {
    // A second channel leaves the main one at uSplit and drifts towards the
    // side with more room, so both stay on the map.
    const uSplit = S * rng.range(0.42, 0.55);
    const sign = vMain(S) > S / 2 ? -1 : 1;
    const startIdx = Math.max(0, Math.floor((uSplit + 60) / STEP));
    const bu = new Float32Array(nSeg + 1 - startIdx);
    const bv = new Float32Array(nSeg + 1 - startIdx);
    for (let i = startIdx; i <= nSeg; i++) {
      const u = mainU[i];
      const k = smoothstep(uSplit, S * 1.05, u);
      bu[i - startIdx] = u;
      bv[i - startIdx] = Math.min(S * 0.92, Math.max(S * 0.08, mainV[i] + sign * S * 0.3 * Math.sqrt(k) + 0.03 * S * noise.simplex(u / 700, 41.2) * k));
    }
    lines.push({ u: bu, v: bv });
  }

  // ── 2. Bank level falls downstream ──
  const bankUp = p.delta ? 4.2 : 7.5;
  const bankDown = p.delta ? 0.8 : 1.6;
  const bankAt = (u: number) => bankUp + (bankDown - bankUp) * Math.min(1, Math.max(0, u / S));

  // Distance to the nearest centreline. Centrelines are monotone in u, so
  // only segments within a u-window of the query point can be closer than the
  // cap; that keeps this cheap enough to call for every grid cell.
  const riverDistLocal = (u: number, v: number): number => {
    let best = DIST_CAP * DIST_CAP;
    for (const L of lines) {
      const u0 = L.u[0];
      const i0 = Math.max(0, Math.floor((u - DIST_CAP - u0) / STEP));
      const i1 = Math.min(L.u.length - 2, Math.ceil((u + DIST_CAP - u0) / STEP));
      for (let i = i0; i <= i1; i++) {
        // Inlined point-to-segment distance (hot loop: no allocation).
        const ax = L.u[i], ay = L.v[i];
        const dx = L.u[i + 1] - ax, dy = L.v[i + 1] - ay;
        const len2 = dx * dx + dy * dy;
        let t = len2 > 0 ? ((u - ax) * dx + (v - ay) * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + t * dx - u, qy = ay + t * dy - v;
        const d2 = qx * qx + qy * qy;
        if (d2 < best) best = d2;
      }
    }
    return Math.sqrt(best);
  };

  const fp = p.floodplainWidth;
  const hw = p.riverHalfWidth;
  const valley = 950;

  const heightLocal = (u: number, v: number, x: number, y: number): number => {
    const d = riverDistLocal(u, v);
    const bank = bankAt(u);
    // Hills: fBm shaped with a power curve, modulated by ridges.
    const n1 = noise.fbm(x / 1900, y / 1900, 5);
    const ridge = noise.ridged(x / 2600 + 13.7, y / 2600 - 5.1, 4);
    const hills = p.hillHeight * Math.pow(Math.min(1, Math.max(0, 0.55 + 0.5 * n1)), 1.35) * (0.65 + 0.55 * ridge);
    // Floodplain: just above bank level with gentle micro-relief (pockets that pond).
    const micro = 0.9 * noise.fbm(x / 520 + 71.3, y / 520 - 19.9, 3);
    const plain = 0.45 + 1.7 * Math.min(1, d / Math.max(1, fp)) + micro;
    const s = smoothstep(fp * 0.55, fp + valley, d);
    // Upstream land sits a little higher so the whole valley drains downstream.
    const tilt = 4 * (1 - u / S);
    let h = bank + (1 - s) * plain + s * (hills + 2.5) + tilt * s;

    // Carve the channel: parabolic bed inside hw, sloped banks to 1.6*hw.
    if (d < hw) {
      const bed = bank - p.channelDepth * (1 - (d / hw) * (d / hw));
      h = Math.min(h, bed);
    } else if (d < hw * 1.6) {
      const k = (d - hw) / (hw * 0.6);
      h = Math.min(h, bank + (h - bank) * k);
    }
    return h;
  };

  // World-space centrelines for rendering and later lookups.
  const worldLines = lines.map((L) => {
    const out = new Float32Array(L.u.length * 2);
    for (let i = 0; i < L.u.length; i++) {
      const [x, y] = toWorld(L.u[i], L.v[i]);
      out[i * 2] = x;
      out[i * 2 + 1] = y;
    }
    return out;
  });

  const river: River = { lines: worldLines, inflowCells: new Int32Array(0), outflowEdge, inflowEdge };

  return {
    size: S,
    river,
    height(x, y) {
      const [u, v] = toLocal(x, y);
      return heightLocal(u, v, x, y);
    },
    riverDist(x, y) {
      const [u, v] = toLocal(x, y);
      return riverDistLocal(u, v);
    },
    bank(x, y) {
      return bankAt(toLocal(x, y)[0]);
    },
    side(x, y) {
      const [u, v] = toLocal(x, y);
      return v < vMain(u) ? -1 : 1;
    },
    along(x, y) {
      return toLocal(x, y)[0];
    },
  };
}

/** Sample the continuous field into the simulation grid. */
export function rasterizeTerrain(field: TerrainField, p: WorldParams): Terrain {
  const n = p.gridSize;
  const S = field.size;
  const cell = S / n;
  const N = n * n;
  const height = new Float32Array(N);
  const riverDist = new Float32Array(N);
  const channel = new Uint8Array(N);
  const bankLevel = new Float32Array(N);
  let minH = Infinity, maxH = -Infinity;

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) * cell, y = (j + 0.5) * cell;
      const k = j * n + i;
      const h = field.height(x, y);
      const d = field.riverDist(x, y);
      height[k] = h;
      riverDist[k] = d;
      // A cell is channel if its centre is within the half-width, or the
      // channel is narrower than a cell and passes through it.
      channel[k] = d < Math.max(p.riverHalfWidth, cell * 0.72) ? 1 : 0;
      bankLevel[k] = field.bank(x, y);
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
  }

  // Make sure narrow channels are carved at coarse resolutions too: a channel
  // cell must sit below bank level, or water could not flow along it.
  for (let k = 0; k < N; k++) {
    if (channel[k] && height[k] > bankLevel[k] - p.channelDepth * 0.5) {
      height[k] = bankLevel[k] - p.channelDepth * 0.5;
      if (height[k] < minH) minH = height[k];
    }
  }

  // Inflow cells: channel cells on the inflow edge.
  const inflow: number[] = [];
  const edge = field.river.inflowEdge;
  for (let t = 0; t < n; t++) {
    const k = edge === 'w' ? t * n : edge === 'e' ? t * n + (n - 1) : edge === 'n' ? t : (n - 1) * n + t;
    if (channel[k]) inflow.push(k);
  }
  field.river.inflowCells = Int32Array.from(inflow);

  return { n, cell, size: S, height, riverDist, channel, bankLevel, minH, maxH };
}

/**
 * Reasons a terrain is unusable, or null if it is fine. A degenerate seed is
 * regenerated with a derived seed (and the UI says so). The checks sample the
 * continuous field on a fixed lattice, so the decision does not depend on the
 * grid resolution of the device.
 */
export function terrainProblem(field: TerrainField, p: WorldParams, t: Terrain): string | null {
  const L = 64;
  const S = field.size;
  let minH = Infinity, maxH = -Infinity, wet = 0, high = 0;
  for (let j = 0; j < L; j++) {
    for (let i = 0; i < L; i++) {
      const x = ((i + 0.5) / L) * S, y = ((j + 0.5) / L) * S;
      const h = field.height(x, y);
      if (!Number.isFinite(h)) return 'the heightmap contained invalid numbers';
      minH = Math.min(minH, h);
      maxH = Math.max(maxH, h);
      if (field.riverDist(x, y) < p.riverHalfWidth * 2) wet++;
      if (h > field.bank(x, y) + 6) high++;
    }
  }
  if (!(maxH - minH > 8)) return 'the terrain came out almost flat';
  if (wet < L * L * 0.005) return 'the river channel was too short';
  if (high < L * L * 0.08) return 'there was no high ground for shelters';
  if (field.river.inflowCells.length === 0 || t.n * t.n === 0) return 'the river did not reach the map edge';
  return null;
}
