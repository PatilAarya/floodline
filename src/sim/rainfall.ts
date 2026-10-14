/**
 * Storm and tide forcing for the flood model. Pure functions of time.
 *
 * Rain is a smooth storm hyetograph (mm/h over time): a skewed bell for the
 * main burst, optionally on top of steady background rain. Tide is a
 * semi-diurnal sine (period 12.42 h) around mean sea level; heights are in
 * metres relative to MSL, the same datum as the SRTM elevations.
 */

export interface StormSpec {
  /** Total simulated duration, minutes. */
  duration: number;
  /** Peak intensity of the main burst, mm/h. */
  peak: number;
  /** Time of the peak, minutes from start. */
  peakAt: number;
  /** Rising-limb and falling-limb widths (standard deviations), minutes. */
  rise: number;
  fall: number;
  /** Steady background rain, mm/h. */
  background: number;
  /** Tide amplitude (half the range), metres. */
  tideAmp: number;
  /** Minutes from start to the first high tide. */
  highTideAt: number;
}

const TIDE_PERIOD = 12.42 * 60; // minutes

/** Rainfall intensity at t minutes, mm/h. */
export function rainAt(s: StormSpec, t: number): number {
  if (t < 0 || t > s.duration) return 0;
  const w = t < s.peakAt ? s.rise : s.fall;
  const z = (t - s.peakAt) / Math.max(1, w);
  // Background rain tapers off in the last hour so the flood can recede.
  const tail = Math.min(1, Math.max(0, (s.duration - t) / 60));
  return s.peak * Math.exp(-0.5 * z * z) + s.background * tail;
}

/** Sea level at t minutes, metres above MSL. */
export function tideAt(s: StormSpec, t: number): number {
  return s.tideAmp * Math.cos((2 * Math.PI * (t - s.highTideAt)) / TIDE_PERIOD);
}

/** Total rain over the storm, mm (numerical integral, 1-minute steps). */
export function totalRain(s: StormSpec): number {
  let sum = 0;
  for (let t = 0; t < s.duration; t++) sum += rainAt(s, t + 0.5) / 60;
  return sum;
}

/** Sample the hyetograph at `n` evenly spaced times (for the scrubber). */
export function rainSeries(s: StormSpec, n = 240): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rainAt(s, (i / (n - 1)) * s.duration);
  return out;
}

export function tideSeries(s: StormSpec, n = 240): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = tideAt(s, (i / (n - 1)) * s.duration);
  return out;
}
