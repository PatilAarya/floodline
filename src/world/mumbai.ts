/**
 * The real map: the Mithi River basin in Mumbai, built from OpenStreetMap
 * roads, waterways and places plus NASA SRTM elevation (see
 * scripts/build-mumbai.mjs). This turns the compact JSON into the same World
 * structure the synthetic generator produces, so rendering, flooding and the
 * AI modules work on either.
 *
 * Modelling decisions (all explained on the Viva page):
 *   - Terrain: SRTM is a surface model, so buildings show up as bumps. A
 *     grey-scale "opening" (5x5 min then max, ~400 m) removes them before
 *     upsampling to the simulation grid.
 *   - Sea: low cells connected to the map edge. Its level is the tide.
 *   - Channels: Mithi River, nallahs and drains are carved into the terrain,
 *     then "priority-flood filled" from the sea so every channel cell has a
 *     downhill path to the outfall. Without this, DEM noise would dam them.
 *   - Roads: flyovers never flood; subways and underpasses sit about 3.5 m
 *     below ground and flood first; bridges close when water tops the deck.
 *   - People: residents are estimated from suburb densities; the evacuation
 *     demand is the share of residents in low-lying cells who seek shelter.
 */
import { Delaunay } from 'd3-delaunay';
import { DisjointSet, polygonCentroid } from '../core/geometry';
import { MinHeap } from '../core/pq';
import { Rng } from '../core/rng';
import { buildCSR, cellIndex } from './cityGen';
import type { DrainageClass, Graph, MumbaiParams, Neighbourhood, River, RoadEdge, RoadKind, RoadNode, Shelter, Terrain, WaterArea, WaterLine, World } from './types';

// ─────────────────────────── Raw data shape ───────────────────────────

export interface MumbaiRaw {
  meta: { name: string; width: number; height: number; attribution: string };
  dem: { n: number; decimetres: string };
  roads: {
    nodes: [number, number][];
    edges: { a: number; b: number; hw: string; link: number; name: string; kind: RoadKind; len: number; g: number[] }[];
  };
  minor: number[][];
  water: {
    lines: { name: string; kind: string; pts: number[] }[];
    polys: { name: string; kind: 'water' | 'wetland' | 'mangrove'; rings: number[][] }[];
    coast: number[][];
  };
  places: {
    suburbs: { name: string; x: number; y: number }[];
    localities: { name: string; x: number; y: number }[];
    facilities: { name: string; kind: string; x: number; y: number }[];
  };
}

export const DEFAULT_MUMBAI: MumbaiParams = { seed: 'mumbai', gridSize: 256, capacityRatio: 1.1, shelters: 10, participation: 0.22 };

/** Free-flow speeds by OSM highway class, m/s (Mumbai traffic, not posted limits). */
const SPEED: Record<string, number> = { motorway: 16.7, trunk: 13.9, primary: 11.1, secondary: 9.7, tertiary: 8.3, unclassified: 6.9 };
const CAPACITY: Record<string, number> = { motorway: 3600, trunk: 2700, primary: 1800, secondary: 1200, tertiary: 900, unclassified: 600 };
const ARTERIAL = new Set(['motorway', 'trunk', 'primary']);

/** Channel half-width and carve depth by waterway kind (metres). */
function channelSpec(kind: string, name: string): { hw: number; depth: number } {
  if (/mithi/i.test(name) || kind === 'river') return { hw: 26, depth: 4 };
  if (kind === 'canal' || /nal+a|nallah|creek/i.test(name)) return { hw: 11, depth: 2.6 };
  if (kind === 'stream') return { hw: 8, depth: 2.2 };
  if (kind === 'drain') return { hw: 4, depth: 1.4 };
  return { hw: 3, depth: 1 };
}

/**
 * Approximate residential densities (people per km^2) for suburbs in the
 * basin, from census-ward figures rounded to a plausible level. Dharavi is
 * among the densest places on Earth; BKC is mostly offices.
 */
const DENSITY: [RegExp, number][] = [
  [/dharavi/i, 240000],
  [/kurla west/i, 85000],
  [/kurla east/i, 60000],
  [/golibar/i, 80000],
  [/saki naka/i, 70000],
  [/asalpha/i, 70000],
  [/kherwadi|bandra east/i, 55000],
  [/govandi/i, 60000],
  [/indira nagar/i, 55000],
  [/ghatkopar/i, 55000],
  [/sion/i, 45000],
  [/kalina/i, 45000],
  [/mahim/i, 40000],
  [/matunga/i, 35000],
  [/wadala/i, 32000],
  [/chembur|chheda/i, 30000],
  [/santacruz|vile parle|khar/i, 30000],
  [/vidya ?vihar/i, 30000],
  [/bandra west/i, 25000],
  [/chandivali/i, 25000],
  [/deonar/i, 25000],
  [/juhu/i, 15000],
  [/fertili[sz]er|bandra kurla|bkc/i, 7000],
];
const densityFor = (name: string) => DENSITY.find(([re]) => re.test(name))?.[1] ?? 35000;

const decodeDem = (b64: string, n: number): Float32Array => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const dm = new Int16Array(bytes.buffer, 0, n * n);
  const out = new Float32Array(n * n);
  for (let k = 0; k < n * n; k++) out[k] = dm[k] / 10;
  return out;
};

const flat32 = (a: number[]) => Float32Array.from(a);

// ─────────────────────────── Terrain ───────────────────────────

/**
 * Grey-scale opening (erode then dilate) with a (2r+1)^2 window. SRTM records
 * roof tops in dense areas; opening removes features narrower than the window
 * (building blocks) while keeping wider landforms (hills).
 */
function opening(src: Float32Array, n: number, r = 2): Float32Array {
  const pass = (a: Float32Array, pick: (x: number, y: number) => number) => {
    const out = new Float32Array(n * n);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        let v = a[j * n + i];
        for (let dj = -r; dj <= r; dj++)
          for (let di = -r; di <= r; di++) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
            v = pick(v, a[jj * n + ii]);
          }
        out[j * n + i] = v;
      }
    return out;
  };
  return pass(pass(src, Math.min), Math.max);
}

/** 3x3 box blur (edges clamped). */
function blur(src: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
          s += src[jj * n + ii];
          c++;
        }
      out[j * n + i] = s / c;
    }
  return out;
}

function bilinear(src: Float32Array, n: number, fx: number, fy: number): number {
  const x = Math.min(n - 1.0001, Math.max(0, fx)), y = Math.min(n - 1.0001, Math.max(0, fy));
  const i = Math.floor(x), j = Math.floor(y), u = x - i, v = y - j;
  const k = j * n + i;
  return (src[k] * (1 - u) + src[k + 1] * u) * (1 - v) + (src[k + n] * (1 - u) + src[k + n + 1] * u) * v;
}

/** Mark grid cells within `hw` of a polyline. Calls fn(cellIndex, distance). */
function rasterLine(pts: Float32Array, hw: number, n: number, cell: number, fn: (k: number, d: number) => void): void {
  const r = Math.max(hw, cell * 0.5);
  for (let p = 0; p + 3 < pts.length; p += 2) {
    const ax = pts[p], ay = pts[p + 1], bx = pts[p + 2], by = pts[p + 3];
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - r) / cell)), i1 = Math.min(n - 1, Math.floor((Math.max(ax, bx) + r) / cell));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - r) / cell)), j1 = Math.min(n - 1, Math.floor((Math.max(ay, by) + r) / cell));
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-9;
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const cx = (i + 0.5) * cell, cy = (j + 0.5) * cell;
        let t = ((cx - ax) * dx + (cy - ay) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(ax + t * dx - cx, ay + t * dy - cy);
        if (d <= r) fn(j * n + i, d);
      }
  }
}

function fillPolygon(rings: Float32Array[], n: number, cell: number, fn: (k: number) => void): void {
  // Scanline even-odd fill at cell centres.
  let minY = Infinity, maxY = -Infinity;
  for (const r of rings) for (let i = 1; i < r.length; i += 2) {
    minY = Math.min(minY, r[i]);
    maxY = Math.max(maxY, r[i]);
  }
  const j0 = Math.max(0, Math.floor(minY / cell)), j1 = Math.min(n - 1, Math.floor(maxY / cell));
  for (let j = j0; j <= j1; j++) {
    const y = (j + 0.5) * cell;
    const xs: number[] = [];
    for (const r of rings) {
      const m = r.length / 2;
      for (let a = 0, b = m - 1; a < m; b = a++) {
        const ya = r[a * 2 + 1], yb = r[b * 2 + 1];
        if (ya > y !== yb > y) xs.push(r[a * 2] + ((y - ya) / (yb - ya)) * (r[b * 2] - r[a * 2]));
      }
    }
    xs.sort((p, q) => p - q);
    for (let s = 0; s + 1 < xs.length; s += 2) {
      const i0 = Math.max(0, Math.ceil(xs[s] / cell - 0.5)), i1 = Math.min(n - 1, Math.floor(xs[s + 1] / cell - 0.5));
      for (let i = i0; i <= i1; i++) fn(j * n + i);
    }
  }
}

interface TerrainBuild {
  terrain: Terrain;
  ground: Float32Array;
  sea: Uint8Array;
  river: River;
  waterLines: WaterLine[];
  waterAreas: WaterArea[];
}

function buildTerrain(raw: MumbaiRaw, n: number): TerrainBuild {
  const S = Math.max(raw.meta.width, raw.meta.height);
  const cell = S / n;
  const N = n * n;
  const dn = raw.dem.n;
  // Opening leaves flat square plateaus; two box-blur passes round them off.
  const dem = blur(blur(opening(decodeDem(raw.dem.decimetres, dn), dn), dn), dn);
  const demCell = S / dn;

  // 1. Upsample to the simulation grid.
  const height = new Float32Array(N);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) * cell, y = (j + 0.5) * cell;
      height[j * n + i] = bilinear(dem, dn, x / demCell - 0.5, y / demCell - 0.5);
    }

  // 2. Sea: cells at or below 0.6 m connected to the map edge (flood fill).
  const sea = new Uint8Array(N);
  const stack: number[] = [];
  for (let t = 0; t < n; t++) for (const k of [t, (n - 1) * n + t, t * n, t * n + n - 1]) if (height[k] <= 0.6 && !sea[k]) {
    sea[k] = 1;
    stack.push(k);
  }
  while (stack.length) {
    const k = stack.pop()!;
    const i = k % n, j = (k - i) / n;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
      const q = jj * n + ii;
      if (!sea[q] && height[q] <= 0.6) {
        sea[q] = 1;
        stack.push(q);
      }
    }
  }
  for (let k = 0; k < N; k++) if (sea[k]) height[k] = Math.min(height[k], -2.5); // seabed

  // 2b. Limit enclosed pits to 1.2 m. A priority-flood fill from the sea and
  //     the map edge gives the level each pit would fill to before spilling;
  //     SRTM pits deeper than 1.2 m are almost always artefacts (shadows
  //     between tall buildings), while shallower real low spots still pond.
  {
    const filled = height.slice();
    const done = new Uint8Array(N);
    const pq = new MinHeap<number>();
    for (let k = 0; k < N; k++) {
      const i = k % n, j = (k - i) / n;
      if (sea[k] || i === 0 || j === 0 || i === n - 1 || j === n - 1) {
        done[k] = 1;
        pq.push(k, filled[k]);
      }
    }
    while (!pq.isEmpty()) {
      const hk = pq.peekPriority();
      const k = pq.pop()!;
      const i = k % n, j = (k - i) / n;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
        const q = jj * n + ii;
        if (done[q]) continue;
        done[q] = 1;
        if (filled[q] < hk) filled[q] = hk;
        pq.push(q, filled[q]);
      }
    }
    for (let k = 0; k < N; k++) if (!sea[k] && filled[k] - height[k] > 1.2) height[k] = filled[k] - 1.2;
  }

  const ground = height.slice();

  // 3. Water areas: lakes and creeks are lowered; mangroves are marked low ground.
  const waterAreas: WaterArea[] = raw.water.polys.map((p) => ({ name: p.name, kind: p.kind, rings: p.rings.map(flat32) }));
  for (const a of waterAreas) {
    if (a.kind !== 'water') continue;
    fillPolygon(a.rings, n, cell, (k) => {
      if (!sea[k]) height[k] = Math.min(height[k], ground[k] - 1.5);
    });
  }

  // 4. Carve channels: deeper at the centreline, sloping to the banks.
  const channel = new Uint8Array(N);
  const waterLines: WaterLine[] = raw.water.lines.map((l) => {
    const spec = channelSpec(l.kind, l.name);
    return { name: l.name, kind: l.kind, pts: flat32(l.pts), halfWidth: spec.hw };
  });
  for (const l of waterLines) {
    const spec = channelSpec(l.kind, l.name);
    rasterLine(l.pts, spec.hw, n, cell, (k, d) => {
      if (sea[k]) return;
      channel[k] = 1;
      const f = 1 - Math.min(1, d / Math.max(spec.hw, cell * 0.5)) * 0.5;
      height[k] = Math.min(height[k], ground[k] - spec.depth * f);
    });
  }

  // 5. Priority-flood fill over channel cells, seeded from the sea: every
  //    channel cell gets a non-increasing path to the outfall, so DEM noise
  //    cannot dam the drainage network. Land cells keep their real pits.
  const visited = new Uint8Array(N);
  const pq = new MinHeap<number>();
  for (let k = 0; k < N; k++) if (sea[k]) {
    visited[k] = 1;
    pq.push(k, height[k]);
  }
  while (!pq.isEmpty()) {
    const hk = pq.peekPriority();
    const k = pq.pop()!;
    const i = k % n, j = (k - i) / n;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
      const q = jj * n + ii;
      if (visited[q] || !channel[q]) continue;
      visited[q] = 1;
      if (height[q] < hk + 0.002) height[q] = hk + 0.002;
      pq.push(q, height[q]);
    }
  }

  // Bank level: for channel cells, the uncarved ground; elsewhere the ground.
  const bankLevel = ground.slice();
  const riverDist = new Float32Array(N).fill(5000);
  for (const l of waterLines) {
    if (l.halfWidth < 8) continue;
    rasterLine(l.pts, 500, n, cell, (k, d) => {
      if (d < riverDist[k]) riverDist[k] = d;
    });
  }

  // Inflow: where the Mithi River enters the map from upstream (Powai/Vihar lakes).
  const inflow: number[] = [];
  let inflowEdge: River['inflowEdge'] = 'n';
  const mithi = waterLines.filter((l) => /mithi/i.test(l.name));
  const edgeOf = (x: number, y: number): River['inflowEdge'] => {
    const d = [y, S - x, S - y, x];
    return (['n', 'e', 's', 'w'] as const)[d.indexOf(Math.min(...d))];
  };
  let bestD = Infinity, bx = 0, by = 0;
  for (const l of mithi) for (const p of [0, l.pts.length - 2]) {
    const x = l.pts[p], y = l.pts[p + 1];
    const dEdge = Math.min(x, y, S - x, S - y);
    // Upstream end: near the map edge and far from the sea (east side of the basin).
    const score = dEdge - x * 0.05;
    if (score < bestD) {
      bestD = score;
      bx = x;
      by = y;
    }
  }
  if (mithi.length) {
    inflowEdge = edgeOf(bx, by);
    rasterLine(Float32Array.of(bx, by, bx, by), 60, n, cell, (k) => {
      if (channel[k]) inflow.push(k);
    });
  }

  let minH = Infinity, maxH = -Infinity;
  for (let k = 0; k < N; k++) {
    minH = Math.min(minH, height[k]);
    maxH = Math.max(maxH, height[k]);
  }
  const river: River = { lines: waterLines.filter((l) => l.halfWidth >= 8).map((l) => l.pts), inflowCells: Int32Array.from(inflow), inflowEdge, outflowEdge: 'w' };
  return { terrain: { n, cell, size: S, height, riverDist, channel, bankLevel, minH, maxH }, ground, sea, river, waterLines, waterAreas };
}

// ─────────────────────────── Roads ───────────────────────────

function buildGraph(raw: MumbaiRaw, tb: TerrainBuild, notes: string[]): Graph {
  const t = tb.terrain;
  const ground = tb.ground;
  const nodes: RoadNode[] = raw.roads.nodes.map(([x, y], id) => {
    const cell = cellIndex(t, x, y);
    return { id, x, y, elev: ground[cell], cell, hood: -1 };
  });
  let bridgeNo = 0;
  const edges: RoadEdge[] = raw.roads.edges.map((e, id) => {
    const geom = flat32(e.g);
    const pts = [nodes[e.a].x, nodes[e.a].y, ...e.g, nodes[e.b].x, nodes[e.b].y];
    // Sample the polyline every half cell for flood lookups.
    const cells: number[] = [];
    let minElev = Infinity, maxEnd = Math.max(nodes[e.a].elev, nodes[e.b].elev);
    let maxBank = maxEnd;
    for (let p = 0; p + 3 < pts.length; p += 2) {
      const ax = pts[p], ay = pts[p + 1], bx = pts[p + 2], by = pts[p + 3];
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (t.cell * 0.5)));
      for (let s = 0; s <= steps; s++) {
        const k = cellIndex(t, ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps);
        // Flooding over a road is read on land cells only: roads cross small
        // drains on culverts, and big channels on bridges.
        if (t.channel[k] || tb.sea[k] || t.height[k] < ground[k] - 1) {
          if (t.channel[k] && !tb.sea[k]) maxBank = Math.max(maxBank, ground[k]);
          continue;
        }
        if (cells[cells.length - 1] !== k) cells.push(k);
        minElev = Math.min(minElev, ground[k]);
      }
    }
    if (!Number.isFinite(minElev)) minElev = maxEnd;
    let deckLevel = Infinity;
    let cellsOut = Int32Array.from(new Set(cells));
    if (e.kind === 'tunnel') minElev -= 3.5; // subways and underpasses sit below street level
    if (e.kind === 'flyover') {
      // Elevated: water never reaches the deck in this model.
      cellsOut = new Int32Array(0);
      minElev = maxEnd + 6;
    }
    if (e.kind === 'bridge') {
      bridgeNo++;
      // Deck: about 2 m above the higher of the bridge ends and the banks it spans.
      deckLevel = Math.max(maxEnd, maxBank) + 2;
    }
    const cls = ARTERIAL.has(e.hw) ? 'arterial' : 'local';
    const code = e.kind === 'bridge' ? `B${bridgeNo}` : e.kind === 'tunnel' ? `U${id}` : `R${id}`;
    return {
      id,
      a: e.a,
      b: e.b,
      // Never shorter than the straight line between the ends: the A*
      // heuristic relies on this (the stored length is rounded to 0.1 m).
      length: Math.max(1, e.len, Math.hypot(nodes[e.b].x - nodes[e.a].x, nodes[e.b].y - nodes[e.a].y)),
      speed: (SPEED[e.hw] ?? 6.9) * (e.link ? 0.8 : 1),
      capacity: CAPACITY[e.hw] ?? 600,
      cls,
      minElev,
      isBridge: e.kind === 'bridge',
      deckLevel,
      cells: cellsOut,
      name: code,
      geom,
      kind: e.kind,
      street: e.name,
    };
  });
  const tunnels = edges.filter((e) => e.kind === 'tunnel').length;
  notes.push(`${bridgeNo} road bridges cross water, ${edges.filter((e) => e.kind === 'flyover').length} flyovers stay above any flood, and ${tunnels} subways or underpasses flood first.`);
  return { nodes, edges, ...buildCSR(nodes.length, edges) };
}

// ───────────────────────── Neighbourhoods ─────────────────────────

function buildHoods(raw: MumbaiRaw, tb: TerrainBuild, g: Graph, p: MumbaiParams, rng: Rng, notes: string[]): { hoods: Neighbourhood[]; cellHood: Int16Array; residents: number } {
  const t = tb.terrain;
  const S = t.size;
  const subs = raw.places.suburbs;
  const del = Delaunay.from(subs, (s) => s.x, (s) => s.y);
  const vor = del.voronoi([0, 0, S, S]);
  const N = t.n * t.n;
  const cellHood = new Int16Array(N).fill(-1);
  const K = subs.length;
  const land = new Int32Array(K), low = new Int32Array(K), sumH = new Float64Array(K);
  const lowSumX = new Float64Array(K), lowSumY = new Float64Array(K);
  let last = 0;
  // A home is "low-lying" below 6 m above mean sea level: in Mumbai that is
  // roughly what floods when heavy rain meets a high tide.
  const LOW = 6;
  for (let j = 0; j < t.n; j++)
    for (let i = 0; i < t.n; i++) {
      const k = j * t.n + i;
      if (tb.sea[k] || t.channel[k]) continue;
      const x = (i + 0.5) * t.cell, y = (j + 0.5) * t.cell;
      const h = del.find(x, y, last);
      last = h;
      cellHood[k] = h;
      land[h]++;
      sumH[h] += tb.ground[k];
      if (tb.ground[k] < LOW) {
        low[h]++;
        lowSumX[h] += x;
        lowSumY[h] += y;
      }
    }
  for (const nd of g.nodes) nd.hood = del.find(nd.x, nd.y);
  const hospitals = raw.places.facilities.filter((f) => f.kind === 'hospital');
  const schools = raw.places.facilities.filter((f) => f.kind === 'school');
  const cellKm2 = (t.cell * t.cell) / 1e6;
  let residents = 0;

  const hoods: Neighbourhood[] = subs.map((s, id) => {
    const raw = vor.cellPolygon(id) as [number, number][] | null;
    const polygon = raw ? raw.slice(0, -1).map(([x, y]) => [x, y] as [number, number]) : ([[s.x, s.y]] as [number, number][]);
    const areaKm2 = land[id] * cellKm2;
    const res = Math.round((areaKm2 * densityFor(s.name) * (0.9 + 0.2 * rng.next())) / 100) * 100;
    residents += res;
    const lowShare = land[id] > 0 ? low[id] / land[id] : 0;
    const demand = Math.round((res * lowShare * p.participation) / 100) * 100;
    const meanElev = land[id] > 0 ? sumH[id] / land[id] : 0;
    // Drainage: Mumbai's storm drains are built for 25 mm/h at low tide;
    // older, denser and lower areas drain worse.
    const drainage = Math.min(1, Math.max(0, 0.75 - 0.35 * lowShare - 0.15 * Math.min(1, densityFor(s.name) / 100000) + rng.normal(0, 0.08)));
    const drainageClass: DrainageClass = drainage < 0.38 ? 'poor' : drainage < 0.62 ? 'fair' : 'good';
    const cen = polygon.length >= 3 ? polygonCentroid(polygon) : { x: s.x, y: s.y };
    // Pick-up point: the junction nearest the middle of the low-lying homes.
    const px = low[id] > 0 ? lowSumX[id] / low[id] : s.x, py = low[id] > 0 ? lowSumY[id] / low[id] : s.y;
    let access = -1, bestD = Infinity;
    for (const nd of g.nodes) {
      if (nd.hood !== id) continue;
      const d = Math.hypot(nd.x - px, nd.y - py);
      if (d < bestD) {
        bestD = d;
        access = nd.id;
      }
    }
    const within = (f: { x: number; y: number }) => del.find(f.x, f.y) === id;
    return {
      id,
      name: s.name,
      residents: res,
      polygon,
      cx: cen.x,
      cy: cen.y,
      population: demand,
      meanElev,
      drainage,
      drainageClass,
      accessNode: access,
      nodes: g.nodes.filter((nd) => nd.hood === id).map((nd) => nd.id),
      hasHospital: hospitals.some(within),
      hasSchool: schools.some(within),
      area: land[id],
    };
  });
  for (const h of hoods) if (h.accessNode < 0 && h.population > 0) notes.push(`${h.name} has no main road inside its area, so its residents cannot be evacuated by road.`);
  return { hoods, cellHood, residents };
}

// ───────────────────────────── Shelters ─────────────────────────────

function pickShelters(raw: MumbaiRaw, tb: TerrainBuild, g: Graph, hoods: Neighbourhood[], p: MumbaiParams, rng: Rng, notes: string[]): Shelter[] {
  const t = tb.terrain;
  const kinds: Record<string, number> = { university: 2.2, college: 1.6, school: 1, community_centre: 0.7 };
  // Snap each candidate facility to its nearest junction (within 300 m).
  const cands: { name: string; node: number; elev: number; weight: number }[] = [];
  const used = new Set<number>();
  for (const f of raw.places.facilities) {
    if (!(f.kind in kinds) || /abandon|closed|demolish/i.test(f.name)) continue;
    let best = -1, bestD = 300;
    for (const nd of g.nodes) {
      const d = Math.hypot(nd.x - f.x, nd.y - f.y);
      if (d < bestD && g.adjStart[nd.id + 1] > g.adjStart[nd.id]) {
        bestD = d;
        best = nd.id;
      }
    }
    if (best < 0 || used.has(best)) continue;
    used.add(best);
    const elev = tb.ground[cellIndex(t, f.x, f.y)];
    // Relief centres must stand above the low-lying zone.
    if (elev < 6) continue;
    cands.push({ name: f.name, node: best, elev, weight: kinds[f.kind] });
  }
  if (cands.length === 0) return [];
  const maxE = Math.max(...cands.map((c) => c.elev));
  const chosen: typeof cands = [];
  // Greedy: high ground first, then spread out across the basin.
  while (chosen.length < p.shelters && chosen.length < cands.length) {
    let best: (typeof cands)[number] | null = null, bestS = -Infinity;
    for (const c of cands) {
      if (chosen.includes(c)) continue;
      const nd = g.nodes[c.node];
      const md = chosen.length ? Math.min(...chosen.map((o) => Math.hypot(g.nodes[o.node].x - nd.x, g.nodes[o.node].y - nd.y))) : t.size;
      const s = 0.3 * Math.min(1, c.elev / Math.max(1, Math.min(maxE, 25))) + 0.7 * Math.min(1, md / (t.size * 0.3)) + 0.05 * c.weight;
      if (s > bestS) {
        bestS = s;
        best = c;
      }
    }
    if (!best) break;
    chosen.push(best);
  }
  const demand = hoods.reduce((s, h) => s + h.population, 0);
  const total = Math.round(demand * p.capacityRatio);
  const w = chosen.map((c) => c.weight * rng.range(0.8, 1.2));
  const wSum = w.reduce((a, b) => a + b, 0);
  const shelters = chosen.map((c, id) => ({
    id,
    name: `S${id + 1} ${c.name}`,
    node: c.node,
    capacity: Math.max(100, Math.round((total * w[id]) / wSum / 100) * 100),
    elev: c.elev,
    lowGround: c.elev < 8,
  }));
  for (const s of shelters) if (s.lowGround) notes.push(`${s.name} stands on low ground (${s.elev.toFixed(1)} m) and may itself flood.`);
  return shelters;
}

// ───────────────────────────── Build ─────────────────────────────

export function buildMumbaiWorld(raw: MumbaiRaw, params: MumbaiParams = DEFAULT_MUMBAI): World {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const notes: string[] = [];
  const rng = new Rng(`mumbai::${params.seed}`);
  const tb = buildTerrain(raw, params.gridSize);
  const graph = buildGraph(raw, tb, notes);
  const { hoods, cellHood, residents } = buildHoods(raw, tb, graph, params, rng.fork('hoods'), notes);
  const shelters = pickShelters(raw, tb, graph, hoods, params, rng.fork('shelters'), notes);

  // Sanity: the routing graph must be connected (the build script keeps the
  // largest component, but check rather than assume).
  const ds = new DisjointSet(graph.nodes.length);
  for (const e of graph.edges) ds.union(e.a, e.b);
  const roots = new Set(graph.nodes.map((n) => ds.find(n.id)));
  if (roots.size > 1) notes.push(`The road network has ${roots.size} separate parts; some areas cannot reach each other.`);

  const S = tb.terrain.size;
  return {
    source: 'mumbai',
    title: raw.meta.name,
    params,
    effectiveSeed: params.seed,
    terrain: tb.terrain,
    river: tb.river,
    graph,
    hoods,
    cellHood,
    shelters,
    totalPopulation: hoods.reduce((s, h) => s + h.population, 0),
    totalCapacity: shelters.reduce((s, x) => s + x.capacity, 0),
    notes,
    bounds: { minX: 0, minY: 0, maxX: S, maxY: S },
    genMs: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0,
    sea: tb.sea,
    waterLines: tb.waterLines,
    waterAreas: tb.waterAreas,
    minorStreets: raw.minor.map(flat32),
    ground: tb.ground,
    residents,
    groupSize: 2500,
    attribution: raw.meta.attribution,
  };
}
