import { describe, expect, it } from 'vitest';
import { countComponents, generateWorld } from '../src/world/cityGen';
import { makeParams, PRESET_IDS } from '../src/world/presets';

describe('world generation', () => {
  it.each(PRESET_IDS)('preset %s: road graph is connected and has shelters and bridges', (preset) => {
    const w = generateWorld(makeParams(preset));
    expect(countComponents(w.graph)).toBe(1);
    expect(w.shelters.length).toBeGreaterThanOrEqual(4);
    expect(w.graph.edges.some((e) => e.isBridge)).toBe(true);
    // Every shelter sits on a node that has at least one road.
    for (const s of w.shelters) expect(w.graph.adjStart[s.node + 1] - w.graph.adjStart[s.node]).toBeGreaterThan(0);
  });

  it('is deterministic for a seed, and independent of grid resolution', () => {
    const a = generateWorld(makeParams('calm', 'repeat-me'));
    const b = generateWorld(makeParams('calm', 'repeat-me'));
    const c = generateWorld(makeParams('calm', 'repeat-me', { gridSize: 128 }));
    const sig = (w: typeof a) => w.graph.edges.map((e) => `${e.a}-${e.b}`).join(',') + '|' + w.hoods.map((h) => h.population).join(',');
    expect(sig(a)).toBe(sig(b));
    expect(sig(a)).toBe(sig(c));
    expect(Array.from(a.terrain.height.slice(0, 500))).toEqual(Array.from(b.terrain.height.slice(0, 500)));
  });

  it('stays connected across many random seeds', () => {
    for (let i = 0; i < 12; i++) {
      const w = generateWorld(makeParams(PRESET_IDS[i % PRESET_IDS.length], `sweep-${i}`, { gridSize: 128 }));
      expect(countComponents(w.graph)).toBe(1);
    }
  });
});
