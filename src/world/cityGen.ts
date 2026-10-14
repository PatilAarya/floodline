/**
 * City generation: road graph, bridges, neighbourhoods and shelters.
 *
 * Roads
 *   1. Poisson-disc nodes, rejected in the river and (probabilistically) on
 *      steep or high ground, so streets cluster on flatter land.
 *   2. Delaunay triangulation gives candidate streets.
 *   3. Edges crossing water are removed; a few short crossings, spread out
 *      along the river, become bridges.
 *   4. Prune to the Relative Neighbourhood Graph (an edge pq survives only if
 *      no point r is closer to both p and q than they are to each other). The
 *      RNG contains the minimum spanning tree, so it stays connected, and it
 *      looks like a real street grid. Some Gabriel-graph edges are kept back
 *      as alternative routes.
 *   5. Connectivity is checked with union-find and repaired if needed.
 */
import { Delaunay } from 'd3-delaunay';
import { DisjointSet, poissonDisc, polygonArea, polygonCentroid, type Vec2 } from '../core/geometry';
import { MinHeap } from '../core/pq';
import { Rng } from '../core/rng';
import { smoothstep } from '../core/noise';
import { buildTerrainField, rasterizeTerrain, terrainProblem, type TerrainField } from './terrain';
import type { DrainageClass, Graph, Neighbourhood, RoadEdge, RoadNode, Shelter, Terrain, World, WorldParams } from './types';

// Free-flow speeds (m/s) and capacities (vehicles/hour) by road class.
export const SPEED = { arterial: 13.9, local: 8.3, bridge: 11.1 } as const;
export const CAPACITY = { arterial: 1800, local: 700, bridge: 1500 } as const;

interface CandidateEdge {
  a: number;
  b: number;
  len: number;
  crosses: boolean;
}

export function generateWorld(params: WorldParams): World {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const notes: string[] = [];
  let seed = params.seed;

  // Degenerate seeds are retried with a derived seed, up to a few times.
  for (let attempt = 0; attempt < 6; attempt++) {
    const result = tryGenerate({ ...params, seed }, notes);
    if (typeof result !== 'string') {
      result.effectiveSeed = seed;
      result.params = params;
      result.genMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
      return result;
    }
    const next = `${params.seed}~${attempt + 1}`;
    notes.push(`Seed "${seed}" was regenerated as "${next}" because ${result}.`);
    seed = next;
  }
  throw new Error('World generation failed after several attempts');
}

function tryGenerate(p: WorldParams, notes: string[]): World | string {
  const rng = new Rng(p.seed);
  const field = buildTerrainField(p, rng.fork('terrain'));
  const terrain = rasterizeTerrain(field, p);
  const problem = terrainProblem(field, p, terrain);
  if (problem) return problem;

  const localNotes: string[] = [];
  const graph = buildRoads(p, field, terrain, rng.fork('roads'), localNotes);
  if (typeof graph === 'string') return graph;

  const { hoods, cellHood } = buildNeighbourhoods(p, field, terrain, graph, rng.fork('hoods'), localNotes);
  const shelters = placeShelters(p, field, graph, hoods, rng.fork('shelters'), localNotes);
  if (typeof shelters === 'string') return shelters;

  notes.push(...localNotes);
  const totalPopulation = hoods.reduce((s, h) => s + h.population, 0);
  const sea = new Uint8Array(terrain.n * terrain.n);
  return {
    source: 'synthetic',
    title: `Synthetic city "${p.seed}"`,
    params: p,
    effectiveSeed: p.seed,
    terrain,
    river: field.river,
    graph,
    hoods,
    cellHood,
    shelters,
    totalPopulation,
    totalCapacity: shelters.reduce((s, x) => s + x.capacity, 0),
    notes,
    bounds: { minX: 0, minY: 0, maxX: p.mapSize, maxY: p.mapSize },
    genMs: 0,
    sea,
    waterLines: field.river.lines.map((pts, i) => ({ name: i === 0 ? 'River' : 'Branch', kind: 'river', pts, halfWidth: p.riverHalfWidth })),
    waterAreas: [],
    minorStreets: [],
    ground: terrain.height,
    residents: totalPopulation,
    groupSize: 250,
    attribution: 'Procedurally generated city.',
  };
}

// ─────────────────────────────── Roads ───────────────────────────────

function slopeAt(field: TerrainField, x: number, y: number): number {
  const e = 30;
  const dx = (field.height(x + e, y) - field.height(x - e, y)) / (2 * e);
  const dy = (field.height(x, y + e) - field.height(x, y - e)) / (2 * e);
  return Math.hypot(dx, dy);
}

function buildRoads(p: WorldParams, field: TerrainField, terrain: Terrain, rng: Rng, notes: string[]): Graph | string {
  const S = p.mapSize;
  const margin = 70;
  const hw = p.riverHalfWidth;

  // 1. Nodes: flatter, lower land is more likely to be built on.
  const pts = poissonDisc(S, S, p.nodeSpacing, rng.fork('poisson'), (x, y) => {
    if (x < margin || y < margin || x > S - margin || y > S - margin) return false;
    if (field.riverDist(x, y) < hw * 2.1) return false;
    const slope = slopeAt(field, x, y);
    if (slope > 0.22) return false;
    const h = field.height(x, y) - field.bank(x, y);
    const pAccept = (1 - smoothstep(0.06, 0.22, slope)) * (1 - 0.45 * smoothstep(10, p.hillHeight, h));
    return rng.next() < pAccept;
  });
  if (pts.length < 60) return 'too few buildable road nodes';

  // Remove accidental duplicates (should not occur with Poisson sampling).
  const uniq: Vec2[] = [];
  const seen = new Set<string>();
  for (const q of pts) {
    const key = `${Math.round(q.x)}:${Math.round(q.y)}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniq.push(q);
    }
  }
  if (uniq.length < pts.length) notes.push(`Merged ${pts.length - uniq.length} duplicate road nodes.`);

  const n = uniq.length;
  const coords = new Float64Array(n * 2);
  uniq.forEach((q, i) => {
    coords[i * 2] = q.x;
    coords[i * 2 + 1] = q.y;
  });
  const del = new Delaunay(coords);

  // 2. Candidate edges from the triangulation (each undirected edge once).
  const cand: CandidateEdge[] = [];
  const { triangles, halfedges } = del;
  for (let e = 0; e < triangles.length; e++) {
    const opp = halfedges[e];
    if (opp !== -1 && opp < e) continue;
    const a = triangles[e];
    const b = triangles[e % 3 === 2 ? e - 2 : e + 1];
    const ax = uniq[a].x, ay = uniq[a].y, bx = uniq[b].x, by = uniq[b].y;
    const len = Math.hypot(bx - ax, by - ay);
    cand.push({ a, b, len, crosses: crossesWater(field, ax, ay, bx, by, hw) });
  }

  // Spatial hash of nodes for the lune / circle emptiness tests.
  const cellSz = p.nodeSpacing;
  const gw = Math.ceil(S / cellSz);
  const buckets = new Map<number, number[]>();
  uniq.forEach((q, i) => {
    const k = Math.floor(q.y / cellSz) * gw + Math.floor(q.x / cellSz);
    let arr = buckets.get(k);
    if (!arr) buckets.set(k, (arr = []));
    arr.push(i);
  });
  const near = (x: number, y: number, r: number, fn: (i: number) => boolean): boolean => {
    const gx0 = Math.floor((x - r) / cellSz), gx1 = Math.floor((x + r) / cellSz);
    const gy0 = Math.floor((y - r) / cellSz), gy1 = Math.floor((y + r) / cellSz);
    for (let gy = gy0; gy <= gy1; gy++)
      for (let gx = gx0; gx <= gx1; gx++) {
        const arr = buckets.get(gy * gw + gx);
        if (arr) for (const i of arr) if (fn(i)) return true;
      }
    return false;
  };

  const isRNG = (c: CandidateEdge) => {
    const A = uniq[c.a], B = uniq[c.b];
    const d2 = c.len * c.len;
    return !near((A.x + B.x) / 2, (A.y + B.y) / 2, c.len, (r) => {
      if (r === c.a || r === c.b) return false;
      const R = uniq[r];
      const da = (R.x - A.x) ** 2 + (R.y - A.y) ** 2;
      const db = (R.x - B.x) ** 2 + (R.y - B.y) ** 2;
      return Math.max(da, db) < d2;
    });
  };
  const isGabriel = (c: CandidateEdge) => {
    const A = uniq[c.a], B = uniq[c.b];
    const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
    const r2 = (c.len / 2) ** 2;
    return !near(mx, my, c.len / 2, (r) => r !== c.a && r !== c.b && (uniq[r].x - mx) ** 2 + (uniq[r].y - my) ** 2 < r2);
  };

  // 3. Keep land edges: RNG always, Gabriel sometimes; skip very long ones.
  const maxLen = p.nodeSpacing * 2.4;
  const kept: CandidateEdge[] = [];
  const bridgeSet = new Set<CandidateEdge>();
  for (const c of cand) {
    if (c.crosses || c.len > maxLen) continue;
    if (isRNG(c) || (p.extraEdges > 0 && isGabriel(c) && rng.next() < p.extraEdges)) kept.push(c);
  }

  // 4. Bridges: short crossings, spread along the river.
  const crossings = cand.filter((c) => c.crosses && c.len < p.nodeSpacing * 2.6).sort((x, y) => x.len - y.len);
  const chosenAlong: number[] = [];
  const minGap = (S / (p.bridges + 1)) * 0.7;
  for (const c of crossings) {
    if (bridgeSet.size >= p.bridges) break;
    const A = uniq[c.a], B = uniq[c.b];
    const u = field.along((A.x + B.x) / 2, (A.y + B.y) / 2);
    if (u < S * 0.06 || u > S * 0.94) continue;
    if (chosenAlong.some((v) => Math.abs(v - u) < minGap)) continue;
    chosenAlong.push(u);
    bridgeSet.add(c);
  }
  kept.push(...bridgeSet);

  // Sparser network: drop some edges that are not in the minimum spanning tree.
  if (p.removeEdges > 0) {
    const mst = new Set<CandidateEdge>();
    const ds = new DisjointSet(n);
    for (const c of [...kept].sort((x, y) => x.len - y.len)) if (ds.union(c.a, c.b)) mst.add(c);
    for (let i = kept.length - 1; i >= 0; i--) {
      const c = kept[i];
      if (!mst.has(c) && !bridgeSet.has(c) && rng.next() < p.removeEdges) kept.splice(i, 1);
    }
  }

  // 5. Connectivity repair: join components with the shortest candidate edge.
  let repairs = 0, extraBridges = 0;
  for (;;) {
    const ds = new DisjointSet(n);
    for (const c of kept) ds.union(c.a, c.b);
    const roots = new Set<number>();
    for (let i = 0; i < n; i++) roots.add(ds.find(i));
    if (roots.size <= 1) break;
    let best: CandidateEdge | null = null;
    for (const c of cand) {
      if (ds.find(c.a) === ds.find(c.b)) continue;
      // Prefer land links; a crossing is accepted (as a bridge) only if it is much shorter.
      const score = c.len * (c.crosses ? 1.6 : 1);
      if (!best || score < best.len * (best.crosses ? 1.6 : 1)) best = c;
    }
    if (!best) return 'the road network could not be connected';
    kept.push(best);
    if (best.crosses) {
      bridgeSet.add(best);
      extraBridges++;
    } else repairs++;
  }
  if (repairs > 0) notes.push(`The generated road network was disconnected; ${repairs} link${repairs > 1 ? 's were' : ' was'} added to reconnect it.`);
  if (extraBridges > 0) notes.push(`${extraBridges} extra bridge${extraBridges > 1 ? 's were' : ' was'} needed to reach land cut off by water.`);

  // Build nodes.
  const nodes: RoadNode[] = uniq.map((q, id) => ({
    id,
    x: q.x,
    y: q.y,
    elev: field.height(q.x, q.y),
    cell: cellIndex(terrain, q.x, q.y),
    hood: -1,
  }));

  // Arterials: edges used most by shortest paths between spread-out sources.
  const usage = edgeUsage(nodes, kept, rng.fork('arterial'));
  const threshold = [...usage].sort((x, y) => y - x)[Math.floor(kept.length * 0.22)] ?? Infinity;

  // Bridges are named B1..Bk in downstream order.
  const bridgeOrder = [...bridgeSet].sort((x, y) => field.along(mid(uniq, x).x, mid(uniq, x).y) - field.along(mid(uniq, y).x, mid(uniq, y).y));

  const edges: RoadEdge[] = kept.map((c, id) => {
    const A = nodes[c.a], B = nodes[c.b];
    const isBridge = bridgeSet.has(c);
    const cls = isBridge || usage[id] >= threshold ? 'arterial' : 'local';
    const { cells, minElev } = sampleEdge(terrain, field, A.x, A.y, B.x, B.y, isBridge, hw);
    const m = mid(uniq, c);
    return {
      id,
      a: c.a,
      b: c.b,
      length: c.len,
      speed: isBridge ? SPEED.bridge : SPEED[cls],
      capacity: isBridge ? CAPACITY.bridge : CAPACITY[cls],
      cls,
      minElev,
      isBridge,
      // Deck sits above bank-full level; it closes when the river overtops it.
      deckLevel: isBridge ? field.bank(m.x, m.y) + p.channelDepth * 0.35 + 1.3 : Infinity,
      cells,
      name: isBridge ? `B${bridgeOrder.indexOf(c) + 1}` : `R${id}`,
      geom: new Float32Array(0),
      kind: isBridge ? 'bridge' : 'road',
      street: '',
    };
  });

  return { nodes, edges, ...buildCSR(n, edges) };
}

const mid = (pts: Vec2[], c: CandidateEdge): Vec2 => ({ x: (pts[c.a].x + pts[c.b].x) / 2, y: (pts[c.a].y + pts[c.b].y) / 2 });

function crossesWater(field: TerrainField, ax: number, ay: number, bx: number, by: number, hw: number): boolean {
  const len = Math.hypot(bx - ax, by - ay);
  const steps = Math.max(2, Math.ceil(len / 15));
  for (let s = 1; s < steps; s++) {
    const t = s / steps;
    if (field.riverDist(ax + (bx - ax) * t, ay + (by - ay) * t) < hw * 1.15) return true;
  }
  return false;
}

export function cellIndex(t: Terrain, x: number, y: number): number {
  const i = Math.min(t.n - 1, Math.max(0, Math.floor(x / t.cell)));
  const j = Math.min(t.n - 1, Math.max(0, Math.floor(y / t.cell)));
  return j * t.n + i;
}

/** Grid cells along an edge and the lowest ground on it. Bridge decks skip water cells. */
function sampleEdge(t: Terrain, field: TerrainField, ax: number, ay: number, bx: number, by: number, isBridge: boolean, hw: number): { cells: Int32Array; minElev: number } {
  const len = Math.hypot(bx - ax, by - ay);
  const steps = Math.max(2, Math.ceil(len / (t.cell * 0.5)));
  const cells: number[] = [];
  let minElev = Infinity;
  for (let s = 0; s <= steps; s++) {
    const x = ax + ((bx - ax) * s) / steps, y = ay + ((by - ay) * s) / steps;
    const k = cellIndex(t, x, y);
    if (isBridge && t.channel[k]) continue;
    if (cells[cells.length - 1] !== k && !cells.includes(k)) cells.push(k);
    const h = field.height(x, y);
    if (!isBridge || field.riverDist(x, y) > hw * 1.6) minElev = Math.min(minElev, h);
  }
  if (!Number.isFinite(minElev)) minElev = Math.min(field.height(ax, ay), field.height(bx, by));
  return { cells: Int32Array.from(cells), minElev };
}

/** Dijkstra from a handful of spread-out sources; count how often each edge is used. */
function edgeUsage(nodes: RoadNode[], edges: CandidateEdge[], rng: Rng): Float64Array {
  const n = nodes.length;
  const adj: [number, number][][] = Array.from({ length: n }, () => []);
  edges.forEach((e, i) => {
    adj[e.a].push([e.b, i]);
    adj[e.b].push([e.a, i]);
  });
  const usage = new Float64Array(edges.length);
  const sources = 8;
  for (let s = 0; s < sources; s++) {
    const src = rng.int(0, n - 1);
    const dist = new Float64Array(n).fill(Infinity);
    const via = new Int32Array(n).fill(-1);
    dist[src] = 0;
    const pq = new MinHeap<number>();
    pq.push(src, 0);
    while (!pq.isEmpty()) {
      const d = pq.peekPriority();
      const v = pq.pop()!;
      if (d > dist[v]) continue;
      for (const [w, ei] of adj[v]) {
        const nd = d + edges[ei].len;
        if (nd < dist[w]) {
          dist[w] = nd;
          via[w] = ei;
          pq.push(w, nd);
        }
      }
    }
    // Walk every node's path back to the source.
    for (let v = 0; v < n; v++) {
      let cur = v, guard = 0;
      while (cur !== src && via[cur] >= 0 && guard++ < n) {
        const e = edges[via[cur]];
        usage[via[cur]]++;
        cur = e.a === cur ? e.b : e.a;
      }
    }
  }
  return usage;
}

export function buildCSR(n: number, edges: RoadEdge[]): Pick<Graph, 'adjStart' | 'adjNode' | 'adjEdge'> {
  const deg = new Int32Array(n);
  for (const e of edges) {
    deg[e.a]++;
    deg[e.b]++;
  }
  const adjStart = new Int32Array(n + 1);
  for (let v = 0; v < n; v++) adjStart[v + 1] = adjStart[v] + deg[v];
  const fill = adjStart.slice(0, n);
  const adjNode = new Int32Array(adjStart[n]);
  const adjEdge = new Int32Array(adjStart[n]);
  for (const e of edges) {
    adjNode[fill[e.a]] = e.b;
    adjEdge[fill[e.a]++] = e.id;
    adjNode[fill[e.b]] = e.a;
    adjEdge[fill[e.b]++] = e.id;
  }
  return { adjStart, adjNode, adjEdge };
}

/** Number of connected components (used by tests and the UI). */
export function countComponents(g: Graph): number {
  const ds = new DisjointSet(g.nodes.length);
  for (const e of g.edges) ds.union(e.a, e.b);
  const roots = new Set<number>();
  for (let i = 0; i < g.nodes.length; i++) roots.add(ds.find(i));
  return roots.size;
}

// ─────────────────────────── Neighbourhoods ───────────────────────────

const PREFIX = ['Ash', 'Bel', 'Cor', 'Dun', 'Elm', 'Fair', 'Glen', 'Hart', 'Iver', 'Kings', 'Lang', 'Mill', 'North', 'Oak', 'Pen', 'Ray', 'Stone', 'Thorn', 'Wey', 'Wil', 'Brack', 'Cold', 'Hollow', 'Marsh', 'Rush', 'Sand', 'Wood', 'Lark'];
const SUFFIX = ['brook', 'bury', 'combe', 'dale', 'field', 'ford', 'gate', 'ham', 'hurst', 'ley', 'mead', 'more', 'port', 'stead', 'ton', 'well', 'wick', 'worth', 'side', 'bank'];

function buildNeighbourhoods(p: WorldParams, field: TerrainField, t: Terrain, g: Graph, rng: Rng, notes: string[]): { hoods: Neighbourhood[]; cellHood: Int16Array } {
  const S = p.mapSize;
  const r = Math.sqrt((S * S) / (p.neighbourhoods * 1.45));
  let centres = poissonDisc(S, S, r, rng.fork('centres'), (x, y) => field.riverDist(x, y) > p.riverHalfWidth * 3 && x > 120 && y > 120 && x < S - 120 && y < S - 120);
  if (centres.length > p.neighbourhoods) centres = rng.shuffle(centres).slice(0, p.neighbourhoods);
  const K = centres.length;

  const del = Delaunay.from(centres, (c) => c.x, (c) => c.y);
  const vor = del.voronoi([0, 0, S, S]);

  // Raster: each land cell belongs to its nearest centre (that is the Voronoi cell).
  const N = t.n * t.n;
  const cellHood = new Int16Array(N).fill(-1);
  const area = new Int32Array(K);
  let last = 0;
  for (let j = 0; j < t.n; j++) {
    for (let i = 0; i < t.n; i++) {
      const k = j * t.n + i;
      if (t.channel[k]) continue;
      const h = del.find((i + 0.5) * t.cell, (j + 0.5) * t.cell, last);
      last = h;
      cellHood[k] = h;
      area[h]++;
    }
  }

  // Mean elevation from the continuous field on a fixed lattice, so
  // populations (which depend on it) are the same at every grid resolution.
  const L = 72;
  const sumH = new Float64Array(K), cnt = new Int32Array(K);
  for (let j = 0; j < L; j++) {
    for (let i = 0; i < L; i++) {
      const x = ((i + 0.5) / L) * S, y = ((j + 0.5) / L) * S;
      if (field.riverDist(x, y) < p.riverHalfWidth) continue;
      const h = del.find(x, y, last);
      last = h;
      sumH[h] += field.height(x, y);
      cnt[h]++;
    }
  }

  const names = new Set<string>();
  const nameFor = () => {
    for (let tries = 0; tries < 50; tries++) {
      const nm = rng.pick(PREFIX) + rng.pick(SUFFIX);
      if (!names.has(nm)) {
        names.add(nm);
        return nm;
      }
    }
    return `Ward ${names.size + 1}`;
  };

  const elevs = Array.from({ length: K }, (_, h) => (cnt[h] > 0 ? sumH[h] / cnt[h] : field.height(centres[h].x, centres[h].y)));
  const eMin = Math.min(...elevs), eMax = Math.max(...elevs);

  const hoods: Neighbourhood[] = centres.map((c, id) => {
    const raw = vor.cellPolygon(id) as [number, number][] | null;
    const polygon = raw ? raw.slice(0, -1).map(([x, y]) => [x, y] as [number, number]) : [[c.x, c.y]] as [number, number][];
    const cen = polygon.length >= 3 ? polygonCentroid(polygon) : c;
    const meanElev = elevs[id];
    const lowness = 1 - (meanElev - eMin) / Math.max(1e-6, eMax - eMin);
    // People live where it is flat and close to the river, which is why floods hurt.
    const pop = Math.max(0, Math.round((p.meanPopulation * Math.exp(rng.normal(0, 0.42)) * (0.6 + 0.75 * lowness)) / 10) * 10);
    const drainage = Math.min(1, Math.max(0, 0.58 + 0.28 * Math.sin(c.x / 1300 + c.y / 1700) + rng.normal(0, 0.16) - 0.18 * lowness));
    const drainageClass: DrainageClass = drainage < 0.38 ? 'poor' : drainage < 0.66 ? 'fair' : 'good';
    return {
      id,
      name: nameFor(),
      residents: pop,
      polygon,
      cx: cen.x,
      cy: cen.y,
      population: pop,
      meanElev,
      drainage,
      drainageClass,
      accessNode: -1,
      nodes: [],
      hasHospital: false,
      hasSchool: rng.next() < 0.3,
      area: area[id],
    };
  });

  // Zero-population edge case: the smallest cell becomes a park if none is empty.
  if (!hoods.some((h) => h.population === 0) && hoods.length > 4) {
    const parkArea = (h: Neighbourhood) => Math.abs(polygonArea(h.polygon));
    const park = hoods.reduce((a, b) => (parkArea(b) < parkArea(a) ? b : a));
    park.population = 0;
    park.residents = 0;
    park.hasSchool = false;
    notes.push(`${park.name} is parkland with no residents.`);
  }
  // Two hospitals in the most populous low-lying neighbourhoods.
  [...hoods].sort((a, b) => b.population - a.population).slice(0, 2).forEach((h) => (h.hasHospital = true));

  // Road nodes inside each neighbourhood, and its pick-up (access) node.
  for (const nd of g.nodes) {
    const h = del.find(nd.x, nd.y);
    nd.hood = h;
    hoods[h].nodes.push(nd.id);
  }
  for (const h of hoods) {
    let best = -1, bestD = Infinity;
    const pool = h.nodes.length > 0 ? h.nodes : g.nodes.map((n) => n.id);
    for (const id of pool) {
      const nd = g.nodes[id];
      if (g.adjStart[id + 1] - g.adjStart[id] === 0) continue; // isolated node
      const d = Math.hypot(nd.x - h.cx, nd.y - h.cy);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    if (h.nodes.length === 0) {
      if (best >= 0 && bestD < 700) notes.push(`${h.name} has no streets of its own; residents walk to the nearest junction ${Math.round(bestD)} m away.`);
      else {
        best = -1;
        if (h.population > 0) notes.push(`${h.name} has no road access, so its residents cannot be evacuated by road.`);
      }
    }
    h.accessNode = best;
  }

  return { hoods, cellHood };
}

// ───────────────────────────── Shelters ─────────────────────────────

const SHELTER_NAMES = ['Ridge School', 'Hill Hall', 'Upland Arena', 'Crest Centre', 'Summit Gym', 'Heights Library', 'Tor Pavilion', 'Beacon Hall'];

function placeShelters(p: WorldParams, field: TerrainField, g: Graph, hoods: Neighbourhood[], rng: Rng, notes: string[]): Shelter[] | string {
  const S = p.mapSize;
  const deg = (v: number) => g.adjStart[v + 1] - g.adjStart[v];
  const rel = (v: number) => g.nodes[v].elev - field.bank(g.nodes[v].x, g.nodes[v].y);
  const cands = g.nodes.filter((nd) => deg(nd.id) > 0 && rel(nd.id) > 6).map((nd) => nd.id);
  if (cands.length < 4) return 'there was no high ground with road access for shelters';

  const maxRel = Math.max(...cands.map(rel));
  const chosen: number[] = [];
  const score = (v: number) => {
    const nd = g.nodes[v];
    const md = chosen.length === 0 ? S : Math.min(...chosen.map((c) => Math.hypot(g.nodes[c].x - nd.x, g.nodes[c].y - nd.y)));
    return 0.5 * (rel(v) / maxRel) + 0.5 * Math.min(1, md / (S * 0.45));
  };
  // Make sure both sides of the river get a shelter if possible.
  for (const side of [-1, 1]) {
    const own = cands.filter((v) => field.side(g.nodes[v].x, g.nodes[v].y) === side);
    if (own.length) chosen.push(own.reduce((a, b) => (score(b) > score(a) ? b : a)));
  }
  while (chosen.length < p.shelters) {
    const pool = cands.filter((v) => !chosen.includes(v));
    if (!pool.length) break;
    chosen.push(pool.reduce((a, b) => (score(b) > score(a) ? b : a)));
  }
  if (chosen.length < p.shelters) notes.push(`Only ${chosen.length} suitable shelter sites were found (asked for ${p.shelters}).`);

  let lowIdx = -1;
  if (p.lowShelter) {
    // Edge case: a shelter in the floodplain (e.g. a school on low ground).
    const low = g.nodes.filter((nd) => deg(nd.id) > 1 && rel(nd.id) < 1.6 && field.riverDist(nd.x, nd.y) > p.riverHalfWidth * 4 && !chosen.includes(nd.id));
    if (low.length) {
      const pick = rng.pick(low).id;
      lowIdx = chosen.length - 1;
      chosen[lowIdx] = pick;
    }
  }

  const totalPop = hoods.reduce((s, h) => s + h.population, 0);
  const total = Math.round(totalPop * p.capacityRatio);
  const w = chosen.map(() => rng.range(0.65, 1.35));
  const wSum = w.reduce((a, b) => a + b, 0);
  const names = rng.shuffle([...SHELTER_NAMES]);
  const shelters: Shelter[] = chosen.map((node, id) => ({
    id,
    name: `S${id + 1} ${names[id % names.length]}`,
    node,
    capacity: Math.max(10, Math.round((total * w[id]) / wSum / 10) * 10),
    elev: g.nodes[node].elev,
    lowGround: id === lowIdx,
  }));
  if (lowIdx >= 0) notes.push(`${shelters[lowIdx].name} stands on low ground and may itself flood.`);
  return shelters;
}
