// Process the raw downloads in scripts/.cache into src/data/mumbai.json.
//
//   node scripts/build-mumbai.mjs
//
// What it does
//   - Projects lat/lon to local metres (x east, y south from the NW corner).
//   - Roads: splits main roads (tertiary and above, plus links) at shared OSM
//     nodes into a routing graph, keeps the largest connected component, and
//     simplifies each edge's geometry (Douglas-Peucker). Bridges over water,
//     flyovers and subways/underpasses are tagged, because they flood very
//     differently. Residential streets are kept only as background lines.
//   - Water: river/nallah/drain centrelines, lakes, creeks and mangrove areas.
//   - Places: suburbs become neighbourhoods; schools/colleges become shelter
//     candidates; hospitals are recorded.
//   - Elevation: the SRTM grid, stored in decimetres.
//
// Data (c) OpenStreetMap contributors (ODbL). Elevation: NASA SRTM 30 m
// (public domain) via OpenTopoData.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cache = join(here, '.cache');
const outDir = join(here, '..', 'src', 'data');

const BBOX = { south: 19.025, west: 72.822, north: 19.115, east: 72.917 };
const LAT0 = ((BBOX.south + BBOX.north) / 2) * (Math.PI / 180);
const MX = 111320 * Math.cos(LAT0); // metres per degree longitude
const MY = 110574; // metres per degree latitude
const W = (BBOX.east - BBOX.west) * MX;
const H = (BBOX.north - BBOX.south) * MY;

const proj = (lat, lon) => [(lon - BBOX.west) * MX, (BBOX.north - lat) * MY];
const inside = (x, y, m = 0) => x >= -m && y >= -m && x <= W + m && y <= H + m;
const r1 = (v) => Math.round(v * 10) / 10;

const MAIN = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified']);
const MINOR = new Set(['residential', 'living_street']);

// ── Douglas-Peucker polyline simplification ──
function simplify(pts, tol) {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-9;
    let best = -1, bestD = tol * tol;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let t = ((px - ax) * dx + (py - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const qx = ax + t * dx - px, qy = ay + t * dy - py;
      const d = qx * qx + qy * qy;
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

const polyLen = (pts) => {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return s;
};

/** Clip a projected polyline to the bbox: returns the inside pieces. */
function clipPolyline(pts) {
  const pieces = [];
  let cur = [];
  for (const p of pts) {
    if (inside(p[0], p[1])) cur.push(p);
    else {
      if (cur.length >= 2) pieces.push(cur);
      cur = [];
    }
  }
  if (cur.length >= 2) pieces.push(cur);
  return pieces;
}

const flat = (pts) => pts.flatMap(([x, y]) => [r1(x), r1(y)]);
/** Integer-metre flat coordinates, for background geometry where 1 m is plenty. */
const flatInt = (pts) => pts.flatMap(([x, y]) => [Math.round(x), Math.round(y)]);

// ─────────────────────────── Roads ───────────────────────────
async function buildRoads(waterLines, waterPolys) {
  const raw = JSON.parse(await readFile(join(cache, 'roads.json'), 'utf8'));
  const ways = raw.elements.filter((e) => e.type === 'way' && e.geometry && e.nodes);

  // Count how many main ways use each OSM node: shared nodes are junctions.
  const use = new Map();
  for (const w of ways) {
    if (!MAIN.has(w.tags.highway)) continue;
    w.nodes.forEach((id, i) => {
      const k = use.get(id) ?? 0;
      // Endpoints count double so they always become graph nodes.
      use.set(id, k + (i === 0 || i === w.nodes.length - 1 ? 2 : 1));
    });
  }

  const nodeIndex = new Map(); // osm id -> graph index
  const nodes = []; // [x, y]
  const getNode = (id, x, y) => {
    let k = nodeIndex.get(id);
    if (k === undefined) {
      k = nodes.length;
      nodeIndex.set(id, k);
      nodes.push([x, y]);
    }
    return k;
  };

  let edges = [];
  const minor = [];
  for (const w of ways) {
    const hw = w.tags.highway;
    const pts = w.geometry.map((g) => proj(g.lat, g.lon));
    if (MINOR.has(hw)) {
      for (const piece of clipPolyline(pts)) minor.push(simplify(piece, 4));
      continue;
    }
    if (!MAIN.has(hw)) continue;
    const isTunnel = w.tags.tunnel === 'yes' || w.tags.tunnel === 'building_passage' || /subway|underpass/i.test(w.tags.name ?? '');
    const isBridge = w.tags.bridge !== undefined && w.tags.bridge !== 'no';
    // Walk the way, cutting at junctions and wherever it leaves the bbox.
    let start = -1;
    let seg = [];
    for (let i = 0; i < w.nodes.length; i++) {
      const [x, y] = pts[i];
      const inBox = inside(x, y);
      if (!inBox) {
        start = -1;
        seg = [];
        continue;
      }
      seg.push([x, y]);
      const junction = (use.get(w.nodes[i]) ?? 0) >= 2;
      if (start < 0) {
        start = getNode(w.nodes[i], x, y);
        seg = [[x, y]];
        continue;
      }
      if (junction || i === w.nodes.length - 1 || !inside(...(pts[i + 1] ?? [-1, -1]))) {
        const end = getNode(w.nodes[i], x, y);
        if (end !== start && seg.length >= 2) {
          edges.push({ a: start, b: end, hw, name: w.tags.name ?? w.tags.ref ?? '', bridge: isBridge, tunnel: isTunnel, pts: seg });
        }
        start = end;
        seg = [[x, y]];
      }
    }
  }

  // Merge junctions closer than 6 m (OSM often has tiny gaps at dual carriageways).
  const parent = nodes.map((_, i) => i);
  const find = (a) => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]];
    return a;
  };
  const cell = 12;
  const grid = new Map();
  nodes.forEach(([x, y], i) => {
    const k = `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)).push(i);
  });
  nodes.forEach(([x, y], i) => {
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        for (const j of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
          if (j <= i) continue;
          if (Math.hypot(nodes[j][0] - x, nodes[j][1] - y) < 6) parent[find(j)] = find(i);
        }
  });
  edges = edges.map((e) => ({ ...e, a: find(e.a), b: find(e.b) })).filter((e) => e.a !== e.b);

  // Keep only the largest connected component.
  const adj = new Map();
  for (const e of edges) {
    (adj.get(e.a) ?? adj.set(e.a, []).get(e.a)).push(e.b);
    (adj.get(e.b) ?? adj.set(e.b, []).get(e.b)).push(e.a);
  }
  const comp = new Map();
  let best = -1, bestSize = 0, cid = 0;
  for (const v of adj.keys()) {
    if (comp.has(v)) continue;
    let size = 0;
    const stack = [v];
    comp.set(v, cid);
    while (stack.length) {
      const u = stack.pop();
      size++;
      for (const w of adj.get(u)) if (!comp.has(w)) {
        comp.set(w, cid);
        stack.push(w);
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = cid;
    }
    cid++;
  }
  const dropped = edges.filter((e) => comp.get(e.a) !== best).length;
  edges = edges.filter((e) => comp.get(e.a) === best);

  // Remove duplicate parallel edges (keep the shortest).
  const pair = new Map();
  for (const e of edges) {
    e.len = polyLen(e.pts);
    const k = e.a < e.b ? `${e.a}-${e.b}` : `${e.b}-${e.a}`;
    const prev = pair.get(k);
    if (!prev || e.len < prev.len) pair.set(k, e);
  }
  edges = [...pair.values()];

  // Bridges over water vs flyovers over roads/rail.
  const crossesWater = (pts) => {
    for (let i = 1; i < pts.length; i++) {
      for (const L of waterLines) {
        if (L.kind === 'drain') continue;
        for (let j = 1; j < L.pts.length; j++) if (segX(pts[i - 1], pts[i], L.pts[j - 1], L.pts[j])) return true;
      }
    }
    // Midpoint inside a water polygon (creek, lake).
    const m = pts[Math.floor(pts.length / 2)];
    return waterPolys.some((p) => p.kind !== 'wetland' && p.rings.some((r) => pip(m[0], m[1], r)));
  };

  // Renumber used nodes compactly.
  const used = new Map();
  const outNodes = [];
  const id = (v) => {
    let k = used.get(v);
    if (k === undefined) {
      k = outNodes.length;
      used.set(v, k);
      outNodes.push(nodes[v]);
    }
    return k;
  };
  const outEdges = edges.map((e) => {
    const pts = simplify(e.pts, 3);
    const a = id(e.a), b = id(e.b);
    // Snap geometry ends to the (possibly merged) junction positions.
    pts[0] = outNodes[a];
    pts[pts.length - 1] = outNodes[b];
    const kind = e.tunnel ? 'tunnel' : e.bridge ? (crossesWater(e.pts) ? 'bridge' : 'flyover') : 'road';
    return { a, b, hw: e.hw.replace('_link', ''), link: e.hw.endsWith('_link') ? 1 : 0, name: e.name, kind, len: Math.round(polyLen(pts) * 10) / 10, g: flatInt(pts.slice(1, -1)) };
  });

  return { nodes: outNodes.map(([x, y]) => [r1(x), r1(y)]), edges: outEdges, minor: minor.map(flatInt), stats: { droppedSmallComponents: dropped } };
}

function segX(p1, p2, p3, p4) {
  const o = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = o(p3, p4, p1), d2 = o(p3, p4, p2), d3 = o(p1, p2, p3), d4 = o(p1, p2, p4);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function pip(x, y, ring) {
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}

// ─────────────────────────── Water ───────────────────────────

/** Join open member ways of a multipolygon into closed rings. */
function assembleRings(parts) {
  const rings = [];
  const open = parts.map((p) => p.slice());
  while (open.length) {
    let ring = open.pop();
    let guard = 0;
    while (guard++ < 5000) {
      const first = ring[0], last = ring[ring.length - 1];
      if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 0.5) break;
      const i = open.findIndex((p) => {
        const a = p[0], b = p[p.length - 1];
        return Math.hypot(a[0] - last[0], a[1] - last[1]) < 0.5 || Math.hypot(b[0] - last[0], b[1] - last[1]) < 0.5;
      });
      if (i < 0) break;
      let next = open.splice(i, 1)[0];
      if (Math.hypot(next[0][0] - last[0], next[0][1] - last[1]) >= 0.5) next = next.reverse();
      ring = ring.concat(next.slice(1));
    }
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}

async function buildWater() {
  const raw = JSON.parse(await readFile(join(cache, 'water.json'), 'utf8'));
  const lines = [];
  const polys = [];
  const coast = [];
  for (const e of raw.elements) {
    const t = e.tags ?? {};
    if (e.type === 'way' && e.geometry) {
      const pts = e.geometry.map((g) => proj(g.lat, g.lon));
      if (t.waterway) {
        for (const piece of clipPolyline(pts)) lines.push({ name: t.name ?? '', kind: t.waterway, pts: simplify(piece, 4) });
      } else if (t.natural === 'coastline') {
        for (const piece of clipPolyline(pts)) coast.push(simplify(piece, 4));
      } else if (t.natural || t.landuse === 'reservoir') {
        const closed = pts.length > 3 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 0.5;
        if (!closed) continue;
        const kind = t.natural === 'wetland' ? (t.wetland === 'mangrove' ? 'mangrove' : 'wetland') : 'water';
        polys.push({ name: t.name ?? '', kind, rings: [simplify(pts, 4)] });
      }
    } else if (e.type === 'relation' && e.members) {
      const outer = e.members.filter((m) => m.type === 'way' && m.geometry && m.role !== 'inner').map((m) => m.geometry.map((g) => proj(g.lat, g.lon)));
      const rings = assembleRings(outer).map((r) => simplify(r, 4));
      if (!rings.length) continue;
      const kind = t.natural === 'wetland' ? (t.wetland === 'mangrove' ? 'mangrove' : 'wetland') : 'water';
      polys.push({ name: t.name ?? '', kind, rings });
    }
  }
  return { lines, polys, coast };
}

// ─────────────────────────── Places ───────────────────────────
async function buildPlaces() {
  const raw = JSON.parse(await readFile(join(cache, 'places.json'), 'utf8'));
  const suburbs = [];
  const localities = [];
  const facilities = [];
  const seen = new Set();
  for (const e of raw.elements) {
    const t = e.tags ?? {};
    const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
    if (lat === undefined) continue;
    const [x, y] = proj(lat, lon);
    if (!inside(x, y)) continue;
    if (t.place === 'suburb') {
      if (seen.has(t.name)) continue;
      seen.add(t.name);
      suburbs.push({ name: t.name, x: r1(x), y: r1(y) });
    } else if (t.place) localities.push({ name: t.name, x: r1(x), y: r1(y) });
    else if (t.amenity) facilities.push({ name: t.name, kind: t.amenity, x: r1(x), y: r1(y) });
  }
  return { suburbs, localities, facilities };
}

// ─────────────────────────── Elevation ───────────────────────────
async function buildDem() {
  const raw = JSON.parse(await readFile(join(cache, 'dem.json'), 'utf8'));
  const n = raw.n;
  const dm = new Int16Array(n * n);
  let missing = 0;
  for (let k = 0; k < n * n; k++) {
    const h = raw.heights[k];
    if (typeof h !== 'number' || !Number.isFinite(h)) missing++;
    dm[k] = Math.round((Number.isFinite(h) ? h : 0) * 10);
  }
  return { n, decimetres: Buffer.from(dm.buffer).toString('base64'), missing };
}

// ─────────────────────────── Main ───────────────────────────
const water = await buildWater();
const roads = await buildRoads(water.lines, water.polys);
const places = await buildPlaces();
const dem = await buildDem();

const out = {
  meta: {
    name: 'Mithi River basin, Mumbai',
    bbox: BBOX,
    width: Math.round(W),
    height: Math.round(H),
    attribution: 'Map data (c) OpenStreetMap contributors (ODbL). Elevation: NASA SRTM via OpenTopoData.',
    built: new Date().toISOString().slice(0, 10),
  },
  dem: { n: dem.n, decimetres: dem.decimetres },
  roads: { nodes: roads.nodes, edges: roads.edges },
  minor: roads.minor,
  water: {
    lines: water.lines.map((l) => ({ name: l.name, kind: l.kind, pts: flatInt(l.pts) })),
    polys: water.polys.map((p) => ({ name: p.name, kind: p.kind, rings: p.rings.map(flatInt) })),
    coast: water.coast.map(flatInt),
  },
  places,
};
await mkdir(outDir, { recursive: true });
const text = JSON.stringify(out);
await writeFile(join(outDir, 'mumbai.json'), text);

const kinds = {};
for (const e of roads.edges) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
console.log(`map ${Math.round(W)} x ${Math.round(H)} m`);
console.log(`roads: ${roads.nodes.length} junctions, ${roads.edges.length} segments`, kinds, roads.stats);
console.log(`minor streets: ${roads.minor.length}`);
console.log(`water: ${water.lines.length} lines, ${water.polys.length} areas, ${water.coast.length} coastline pieces`);
console.log(`places: ${places.suburbs.length} suburbs, ${places.localities.length} localities, ${places.facilities.length} facilities`);
console.log(`dem: ${dem.n}x${dem.n}, ${dem.missing} missing`);
console.log(`output: ${(text.length / 1e6).toFixed(2)} MB`);
