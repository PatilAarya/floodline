/**
 * Scenario presets. Each is a full WorldParams minus the seed, so a preset
 * plus a seed fully determines the city. URL params may override a few
 * numbers (validated and clamped in `paramsFromURL`).
 */
import { parseClamped, sanitizeSeed } from '../core/units';
import type { PresetId, WorldParams } from './types';

type PresetParams = Omit<WorldParams, 'seed' | 'preset' | 'gridSize'>;

const base: PresetParams = {
  mapSize: 6000,
  hillHeight: 46,
  floodplainWidth: 520,
  riverHalfWidth: 46,
  channelDepth: 3.2,
  meander: 0.12,
  delta: false,
  nodeSpacing: 250,
  extraEdges: 0.35,
  removeEdges: 0,
  bridges: 4,
  neighbourhoods: 30,
  shelters: 6,
  capacityRatio: 1.25,
  lowShelter: false,
  meanPopulation: 1400,
};

export interface PresetInfo {
  id: PresetId;
  label: string;
  blurb: string;
  defaultSeed: string;
  params: PresetParams;
}

export const PRESETS: Record<PresetId, PresetInfo> = {
  calm: {
    id: 'calm',
    label: 'Calm Valley',
    blurb: 'A broad valley with four bridges and plenty of shelter space. The baseline.',
    defaultSeed: 'calm-valley',
    params: { ...base },
  },
  twobridges: {
    id: 'twobridges',
    label: 'Two Bridges',
    blurb: 'Only two river crossings. When one closes, half the city depends on the other.',
    defaultSeed: 'two-bridges',
    params: { ...base, bridges: 2, meander: 0.16, floodplainWidth: 600 },
  },
  delta: {
    id: 'delta',
    label: 'Delta Town',
    blurb: 'Low, flat land where the river splits in two. One shelter sits on low ground.',
    defaultSeed: 'delta-town',
    params: { ...base, hillHeight: 22, floodplainWidth: 900, channelDepth: 2.4, delta: true, bridges: 3, lowShelter: true, meanPopulation: 1500 },
  },
  overcrowded: {
    id: 'overcrowded',
    label: 'Overcrowded',
    blurb: 'Shelter capacity is short of the population. Not everyone can be housed.',
    defaultSeed: 'overcrowded',
    params: { ...base, capacityRatio: 0.72, meanPopulation: 1800, neighbourhoods: 34 },
  },
  broken: {
    id: 'broken',
    label: 'Broken Network',
    blurb: 'A sparse, tree-like road network with few alternative routes.',
    defaultSeed: 'broken-network',
    params: { ...base, extraEdges: 0, removeEdges: 0.35, bridges: 2, nodeSpacing: 280 },
  },
};

export const PRESET_IDS = Object.keys(PRESETS) as PresetId[];

export function isPresetId(v: string | null): v is PresetId {
  return v !== null && v in PRESETS;
}

/** Pick a grid size suited to the device: fewer cells on weak hardware. */
export function autoGridSize(): number {
  try {
    const cores = navigator.hardwareConcurrency || 4;
    const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
    const small = Math.min(screen.width, screen.height) < 500;
    if (cores <= 2 || mem <= 1) return 128;
    if (cores <= 4 || mem <= 2 || small) return 192;
  } catch {
    /* non-browser */
  }
  return 256;
}

export function makeParams(preset: PresetId, seed?: string, overrides: Partial<WorldParams> = {}): WorldParams {
  const p = PRESETS[preset];
  return { ...p.params, seed: seed ?? p.defaultSeed, preset, gridSize: 256, ...overrides };
}

/** Build params from untrusted URL search params; everything validated and clamped. */
export function paramsFromURL(q: URLSearchParams, gridSize = 256): WorldParams {
  const preset = isPresetId(q.get('preset')) ? (q.get('preset') as PresetId) : 'calm';
  const p = PRESETS[preset];
  const seed = sanitizeSeed(q.get('seed'), p.defaultSeed);
  const grid = [128, 192, 256].includes(Number(q.get('grid'))) ? Number(q.get('grid')) : gridSize;
  return makeParams(preset, seed, {
    gridSize: grid,
    capacityRatio: parseClamped(q.get('cap'), p.params.capacityRatio, 0.2, 3),
    bridges: Math.round(parseClamped(q.get('bridges'), p.params.bridges, 1, 6)),
    shelters: Math.round(parseClamped(q.get('shelters'), p.params.shelters, 4, 8)),
  });
}

/** The URL params that describe a world (only non-default values are written). */
export function paramsToURL(w: WorldParams): Record<string, string> {
  const p = PRESETS[w.preset].params;
  const out: Record<string, string> = { preset: w.preset, seed: w.seed };
  if (w.capacityRatio !== p.capacityRatio) out.cap = String(w.capacityRatio);
  if (w.bridges !== p.bridges) out.bridges = String(w.bridges);
  if (w.shelters !== p.shelters) out.shelters = String(w.shelters);
  return out;
}
