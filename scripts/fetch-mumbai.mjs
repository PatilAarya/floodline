// One-time download of real map data for the Mithi River basin, Mumbai.
//
//   node scripts/fetch-mumbai.mjs
//
// Sources
//   OpenStreetMap via the Overpass API (roads, waterways, water/wetland areas,
//   place names, schools/colleges). Data (c) OpenStreetMap contributors, ODbL.
//   Elevation: NASA SRTM 30 m (public domain) via the OpenTopoData API.
//
// Raw responses are cached in scripts/.cache/ and are not shipped with the site.
// Run scripts/build-mumbai.mjs afterwards to produce src/data/mumbai.json.

import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BBOX = { south: 19.025, west: 72.822, north: 19.115, east: 72.917 };
export const DEM_N = 128; // elevation samples per side

const here = dirname(fileURLToPath(import.meta.url));
const cache = join(here, '.cache');
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const UA = 'Floodline-student-project/1.0 (educational flood evacuation simulator)';
const force = process.argv.includes('--force');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bb = `${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east}`;

const QUERIES = {
  roads: `[out:json][timeout:180];
way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service)$"](${bb});
out body geom;`,
  water: `[out:json][timeout:180];
(
  way["waterway"~"^(river|stream|canal|drain|ditch)$"](${bb});
  way["natural"~"^(water|wetland|coastline|bay)$"](${bb});
  relation["natural"~"^(water|wetland|bay)$"](${bb});
  way["landuse"="reservoir"](${bb});
);
out body geom;`,
  places: `[out:json][timeout:120];
(
  node["place"~"^(suburb|neighbourhood|quarter|locality)$"]["name"](${bb});
  nwr["amenity"~"^(school|college|university|community_centre|hospital)$"]["name"](${bb});
);
out center tags;`,
};

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function overpass(name, query) {
  const out = join(cache, `${name}.json`);
  if (!force && (await exists(out))) {
    console.log(`  ${name}: cached`);
    return;
  }
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(OVERPASS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: 'data=' + encodeURIComponent(query),
    });
    if (res.ok) {
      const text = await res.text();
      JSON.parse(text); // validate before saving
      await writeFile(out, text);
      console.log(`  ${name}: ${(text.length / 1e6).toFixed(2)} MB`);
      return;
    }
    console.log(`  ${name}: HTTP ${res.status}, retrying in ${attempt * 10}s`);
    await sleep(attempt * 10000);
  }
  throw new Error(`Overpass query "${name}" failed`);
}

async function elevation() {
  const out = join(cache, 'dem.json');
  if (!force && (await exists(out))) {
    console.log('  dem: cached');
    return;
  }
  // Sample cell centres of a DEM_N x DEM_N lattice, north to south, west to east.
  const pts = [];
  for (let j = 0; j < DEM_N; j++) {
    const lat = BBOX.north - ((j + 0.5) / DEM_N) * (BBOX.north - BBOX.south);
    for (let i = 0; i < DEM_N; i++) {
      const lon = BBOX.west + ((i + 0.5) / DEM_N) * (BBOX.east - BBOX.west);
      pts.push([lat, lon]);
    }
  }
  // Progress is saved after every batch so a rate-limited run can resume.
  const partial = join(cache, 'dem.partial.json');
  const heights = (await exists(partial)) ? JSON.parse(await readFile(partial, 'utf8')) : new Array(pts.length).fill(null);
  const batch = 100;
  for (let k = 0; k < pts.length; k += batch) {
    if (heights[k] !== null && heights[Math.min(pts.length, k + batch) - 1] !== null) continue;
    const chunk = pts.slice(k, k + batch);
    const url = `https://api.opentopodata.org/v1/srtm30m?locations=${chunk.map((p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join('|')}`;
    let data = null;
    for (let attempt = 1; attempt <= 8 && !data; attempt++) {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.ok) data = await res.json();
      else {
        console.log(`  dem: HTTP ${res.status} at ${k}, waiting ${attempt * 20}s`);
        await sleep(attempt * 20000);
      }
    }
    if (!data || !Array.isArray(data.results)) throw new Error('elevation request failed');
    data.results.forEach((r, i) => (heights[k + i] = r.elevation));
    await writeFile(partial, JSON.stringify(heights));
    if ((k / batch) % 20 === 0) console.log(`  dem: ${k + chunk.length} / ${pts.length}`);
    await sleep(1100); // public API limit: 1 request per second
  }
  await writeFile(out, JSON.stringify({ n: DEM_N, bbox: BBOX, heights }));
  console.log('  dem: done');
}

await mkdir(cache, { recursive: true });
console.log('Fetching OpenStreetMap data (Overpass)...');
for (const [name, q] of Object.entries(QUERIES)) {
  await overpass(name, q);
  await sleep(2000);
}
console.log('Fetching elevation (OpenTopoData, SRTM 30 m)...');
await elevation();
console.log('Done. Now run: node scripts/build-mumbai.mjs');
