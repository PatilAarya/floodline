/**
 * World data model. Plain data with typed arrays so it can be posted to
 * workers cheaply and regenerated identically from (seed, params).
 *
 * Coordinates: metres, origin at the top-left corner, x right, y down.
 * Grid cell (i, j) covers [i*cell, (i+1)*cell) x [j*cell, (j+1)*cell);
 * index = j * n + i.
 */

export type PresetId = 'calm' | 'twobridges' | 'delta' | 'overcrowded' | 'broken';

export interface WorldParams {
  seed: string;
  preset: PresetId;
  /** Heightmap resolution (cells per side): 256, 192 or 128. */
  gridSize: number;
  /** Side length of the square map, metres. */
  mapSize: number;
  /** Peak hill height above the floodplain, metres. */
  hillHeight: number;
  /** Half-width of the flat floodplain either side of the river, metres. */
  floodplainWidth: number;
  /** Half-width of the river channel, metres. */
  riverHalfWidth: number;
  /** Bank-full channel depth, metres. */
  channelDepth: number;
  /** Meander amplitude as a fraction of map size. */
  meander: number;
  /** Split the river into a second channel downstream (delta). */
  delta: boolean;
  /** Target road-node spacing (Poisson-disc radius), metres. */
  nodeSpacing: number;
  /** Fraction of extra (non-RNG, Gabriel) edges kept as alternative routes. */
  extraEdges: number;
  /** Fraction of non-essential edges removed afterwards (sparser network). */
  removeEdges: number;
  bridges: number;
  neighbourhoods: number;
  shelters: number;
  /** Total shelter capacity as a fraction of total population. */
  capacityRatio: number;
  /** Place one shelter deliberately on low ground (edge case). */
  lowShelter: boolean;
  /** Mean population per neighbourhood. */
  meanPopulation: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Terrain {
  n: number;
  /** Cell size, metres. */
  cell: number;
  size: number;
  /** Ground elevation, metres. */
  height: Float32Array;
  /** Distance to the nearest river centreline, metres. */
  riverDist: Float32Array;
  /** 1 where the cell is river channel. */
  channel: Uint8Array;
  /** River bank (bank-full water) level at that cell's position along the river, metres. */
  bankLevel: Float32Array;
  minH: number;
  maxH: number;
}

export interface River {
  /** Centreline polylines in world coordinates [x0,y0,x1,y1,...]. Main channel first. */
  lines: Float32Array[];
  /** Grid cells on the inflow edge where the river enters. */
  inflowCells: Int32Array;
  /** Which map edge the river leaves through. */
  outflowEdge: 'n' | 'e' | 's' | 'w';
  inflowEdge: 'n' | 'e' | 's' | 'w';
}

export type RoadClass = 'arterial' | 'local';

/** How a road segment meets the ground; this decides how it floods. */
export type RoadKind = 'road' | 'bridge' | 'flyover' | 'tunnel';

export interface RoadNode {
  id: number;
  x: number;
  y: number;
  elev: number;
  /** Grid cell index under the node. */
  cell: number;
  /** Neighbourhood id, or -1. */
  hood: number;
}

export interface RoadEdge {
  id: number;
  a: number;
  b: number;
  length: number;
  /** Free-flow speed, m/s. */
  speed: number;
  /** Capacity, vehicles per hour. */
  capacity: number;
  cls: RoadClass;
  /** Lowest ground elevation along the edge (flood vulnerability), metres. */
  minElev: number;
  isBridge: boolean;
  /** Deck level for bridges (blocks when river stage exceeds it), metres. */
  deckLevel: number;
  /** Grid cells sampled along the edge, for flood depth lookups. */
  cells: Int32Array;
  /** Short display name, e.g. "B2" for bridges, "R114" otherwise. */
  name: string;
  /** Interior polyline points [x0,y0,...] between a and b (empty for straight segments). */
  geom: Float32Array;
  /** road, bridge over water, flyover (never floods) or tunnel/subway (floods first). */
  kind: RoadKind;
  /** Street name from OpenStreetMap, if any. */
  street: string;
}

export interface Graph {
  nodes: RoadNode[];
  edges: RoadEdge[];
  /** CSR adjacency: neighbours of node v are adjNode[adjStart[v] .. adjStart[v+1]). */
  adjStart: Int32Array;
  adjNode: Int32Array;
  adjEdge: Int32Array;
}

export type DrainageClass = 'poor' | 'fair' | 'good';

export interface Neighbourhood {
  id: number;
  name: string;
  /** Estimated residents (Mumbai map); equals population for synthetic cities. */
  residents: number;
  /** Voronoi polygon, [[x,y], ...]. */
  polygon: [number, number][];
  cx: number;
  cy: number;
  population: number;
  meanElev: number;
  /** 0 (poor) .. 1 (good). */
  drainage: number;
  drainageClass: DrainageClass;
  /** Road node used as the pick-up point, or -1 when there is no road access. */
  accessNode: number;
  nodes: number[];
  hasHospital: boolean;
  hasSchool: boolean;
  /** Number of grid cells inside the cell. */
  area: number;
}

export interface Shelter {
  id: number;
  name: string;
  node: number;
  capacity: number;
  elev: number;
  /** True when deliberately placed on low ground (edge case). */
  lowGround: boolean;
}

/** Parameters for the real Mumbai map. */
export interface MumbaiParams {
  seed: string;
  gridSize: number;
  /** Total shelter capacity as a fraction of evacuation demand. */
  capacityRatio: number;
  shelters: number;
  /** Share of low-lying residents who seek a shelter (the rest stay with family, upper floors...). */
  participation: number;
}

export interface WaterArea {
  name: string;
  kind: 'water' | 'wetland' | 'mangrove';
  rings: Float32Array[];
}

export interface WaterLine {
  name: string;
  kind: string;
  pts: Float32Array;
  /** Channel half-width used for carving and drawing, metres. */
  halfWidth: number;
}

export interface World {
  source: 'mumbai' | 'synthetic';
  /** Display name of the map. */
  title: string;
  params: WorldParams | MumbaiParams;
  /** The seed actually used (may differ if the original was degenerate). */
  effectiveSeed: string;
  terrain: Terrain;
  river: River;
  graph: Graph;
  hoods: Neighbourhood[];
  /** Neighbourhood id per grid cell (-1 outside any). */
  cellHood: Int16Array;
  shelters: Shelter[];
  totalPopulation: number;
  totalCapacity: number;
  /** Plain-sentence notes about generation (repairs, regenerations, edge cases). */
  notes: string[];
  bounds: Bounds;
  /** Generation time, ms (diagnostic). */
  genMs: number;
  /** 1 where the cell is sea (fixed water level = tide). */
  sea: Uint8Array;
  /** Named waterways (rivers, nallahs, drains) for drawing and labels. */
  waterLines: WaterLine[];
  waterAreas: WaterArea[];
  /** Background residential streets (drawn only, not routed). */
  minorStreets: Float32Array[];
  /** Ground height before channels were carved (roads sit on this). */
  ground: Float32Array;
  /** Residents (estimate) in total; `population` on a neighbourhood is the evacuation demand. */
  residents: number;
  /** People per evacuee group. */
  groupSize: number;
  /** Data credit line shown on the map. */
  attribution: string;
}
