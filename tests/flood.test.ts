import { describe, expect, it } from 'vitest';
import { FloodModel, type FloodSetup, type Forcing } from '../src/sim/floodModel';

/** A small tilted basin with a sea strip along the west edge. */
function basin(n = 48, withSea = true): FloodSetup {
  const N = n * n;
  const bed = new Float32Array(N), sea = new Uint8Array(N);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      // Slopes down to the west, with a bowl in the middle that ponds.
      bed[k] = 0.05 * i + 1.5 * Math.exp(-((i - n / 2) ** 2 + (j - n / 2) ** 2) / 60) * -1 + 0.3 * Math.sin(j / 3);
      if (withSea && i < 3) {
        sea[k] = 1;
        bed[k] = -2;
      }
    }
  return {
    n,
    cell: 30,
    bed,
    sea,
    drainRate: new Float32Array(N).fill(10 / 1000 / 3600),
    infil: new Float32Array(N).fill(2 / 1000 / 3600),
    manning: new Float32Array(N).fill(0.04),
    inflowCells: Int32Array.of(n * Math.floor(n / 2) + n - 2),
  };
}

const forcing = (): Forcing => ({
  storm: { duration: 240, peak: 120, peakAt: 60, rise: 30, fall: 40, background: 10, tideAmp: 1.5, highTideAt: 90 },
  upstreamArea: 2e6,
  runoffCoeff: 0.6,
  lag: 20,
  baseFlow: 2,
  tideOffset: 0,
  drainScale: 1,
  rainOverrides: [],
});

describe('flood model', () => {
  it('conserves mass: volume = initial + rain + inflow - drained - infiltrated + sea exchange', () => {
    const m = new FloodModel(basin(), forcing());
    for (let i = 0; i < 180; i++) {
      m.stepMinute();
      expect(m.assertFinite()).toBeNull();
    }
    const v = m.volume(), e = m.expectedVolume();
    expect(m.budget.rain).toBeGreaterThan(0);
    expect(Math.abs(v - e) / Math.max(1, e)).toBeLessThan(1e-4);
  });

  it('conserves mass with no sea and no drains: volume = rain + inflow - edge outflow', () => {
    const s = basin(40, false);
    s.drainRate.fill(0);
    s.infil.fill(0);
    const m = new FloodModel(s, forcing());
    for (let i = 0; i < 120; i++) m.stepMinute();
    const expected = m.budget.rain + m.budget.inflow - m.budget.outflow;
    expect(m.budget.outflow).toBeGreaterThan(0);
    expect(Math.abs(m.volume() - expected) / expected).toBeLessThan(1e-4);
  });

  it('is deterministic: rewinding to a snapshot and replaying gives identical depths', { timeout: 30000 }, () => {
    const m = new FloodModel(basin(), forcing());
    m.advanceTo(40);
    const snap = m.snapshot();
    m.advanceTo(90);
    const first = m.d.slice();
    m.restore(snap);
    m.advanceTo(90);
    expect(Array.from(m.d)).toEqual(Array.from(first));
  });
});
