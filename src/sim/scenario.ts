/**
 * Flood scenarios for the Mumbai map. Each preset is modelled on a real
 * event; a seed jitters intensity, timing and tide phase so the Experiments
 * page can run many comparable but different storms.
 *
 * Sources for the presets (rounded):
 *   - 26 July 2005: Santacruz recorded about 944 mm in 24 h, most of it in
 *     a few afternoon hours, coinciding with a high tide.
 *   - 29 August 2017: about 330 mm in 12 h at Santacruz.
 *   - 2 July 2019: about 375 mm in 24 h.
 * Mumbai's storm drains were designed for 25 mm/h at low tide; flap gates on
 * the outfalls close at high tide, so drainage collapses when rain and tide
 * peak together.
 */
import { Rng } from '../core/rng';
import { parseClamped, sanitizeSeed } from '../core/units';
import type { StormSpec } from './rainfall';

export type ScenarioId = 'jul2005' | 'aug2017' | 'jul2019' | 'shower';

export interface ScenarioInfo {
  id: ScenarioId;
  label: string;
  blurb: string;
  storm: StormSpec;
  /** Upstream Mithi inflow: catchment above the map (km^2) and runoff lag (min). */
  upstreamKm2: number;
  lag: number;
}

export const SCENARIOS: Record<ScenarioId, ScenarioInfo> = {
  jul2005: {
    id: 'jul2005',
    label: '26 July 2005',
    blurb: 'The deluge: about 700 mm in 12 hours, peaking near 150 mm/h as a 2 m high tide arrives. Over a thousand people died across the region.',
    storm: { duration: 720, peak: 150, peakAt: 300, rise: 90, fall: 110, background: 18, tideAmp: 2.0, highTideAt: 300 },
    upstreamKm2: 9,
    lag: 45,
  },
  aug2017: {
    id: 'aug2017',
    label: '29 August 2017',
    blurb: 'A long heavy day: about 330 mm in 12 hours. Trains stopped and low-lying roads went under.',
    storm: { duration: 720, peak: 62, peakAt: 330, rise: 120, fall: 150, background: 9, tideAmp: 1.7, highTideAt: 420 },
    upstreamKm2: 9,
    lag: 50,
  },
  jul2019: {
    id: 'jul2019',
    label: '2 July 2019',
    blurb: 'An overnight downpour of about 375 mm. Subways and the Kurla belt flooded first.',
    storm: { duration: 720, peak: 75, peakAt: 240, rise: 80, fall: 130, background: 10, tideAmp: 1.5, highTideAt: 120 },
    upstreamKm2: 9,
    lag: 45,
  },
  shower: {
    id: 'shower',
    label: 'Heavy shower',
    blurb: 'A typical heavy monsoon afternoon: about 120 mm in 4 hours at low tide. The drains mostly cope.',
    storm: { duration: 480, peak: 45, peakAt: 150, rise: 50, fall: 70, background: 4, tideAmp: 1.4, highTideAt: 520 },
    upstreamKm2: 9,
    lag: 40,
  },
};

export const SCENARIO_IDS = Object.keys(SCENARIOS) as ScenarioId[];

export interface ScenarioParams {
  scenario: ScenarioId;
  seed: string;
  /** Multiplier on rainfall intensity (the rain slider), 0..2. */
  rainScale: number;
  /** Extra tide height, metres (sea-level rise / surge), -1..2. */
  tideOffset: number;
  /** Multiplier on drain capacity (0 = blocked drains, 2 = upgraded). */
  drainScale: number;
}

export const DEFAULT_SCENARIO: ScenarioParams = { scenario: 'jul2005', seed: 'mumbai', rainScale: 1, tideOffset: 0, drainScale: 1 };

/** The storm actually simulated: the preset, jittered by the seed, scaled by sliders. */
export function resolveStorm(p: ScenarioParams): StormSpec {
  const base = SCENARIOS[p.scenario].storm;
  const r = new Rng(`storm::${p.scenario}::${p.seed}`);
  // The default seed reproduces the preset exactly; any other seed varies it.
  const jitter = p.seed === 'mumbai' ? 0 : 1;
  return {
    ...base,
    peak: base.peak * (1 + jitter * r.range(-0.15, 0.15)) * p.rainScale,
    background: base.background * p.rainScale,
    peakAt: base.peakAt + jitter * r.range(-45, 45),
    highTideAt: base.highTideAt + jitter * r.range(-120, 120),
    tideAmp: base.tideAmp,
  };
}

export function scenarioFromURL(q: URLSearchParams): ScenarioParams {
  const s = q.get('storm');
  return {
    scenario: s && s in SCENARIOS ? (s as ScenarioId) : DEFAULT_SCENARIO.scenario,
    seed: sanitizeSeed(q.get('seed'), DEFAULT_SCENARIO.seed),
    rainScale: parseClamped(q.get('rain'), 1, 0, 2),
    tideOffset: parseClamped(q.get('tide'), 0, -1, 2),
    drainScale: parseClamped(q.get('drains'), 1, 0, 2),
  };
}

export function scenarioToURL(p: ScenarioParams): Record<string, string> {
  const out: Record<string, string> = { storm: p.scenario, seed: p.seed };
  if (p.rainScale !== 1) out.rain = String(p.rainScale);
  if (p.tideOffset !== 0) out.tide = String(p.tideOffset);
  if (p.drainScale !== 1) out.drains = String(p.drainScale);
  return out;
}
