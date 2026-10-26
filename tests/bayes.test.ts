import { describe, expect, it } from 'vitest';
import { mumbaiNetwork, V } from '../src/ai/bayes/cpt';
import { enumerationAsk, variableElimination } from '../src/ai/bayes/exact';
import { cloneNetwork, validate, type Evidence } from '../src/ai/bayes/network';

const net = mumbaiNetwork();
const ev = (pairs: [number, number][]): Evidence => new Map(pairs);

const EVIDENCE_SETS: Evidence[] = [
  ev([]),
  ev([[V.RainGauge, 2]]),
  ev([[V.RainGauge, 2], [V.RiverGauge, 0]]),
  ev([[V.RainGauge, 0], [V.RiverGauge, 2], [V.Drainage, 0], [V.Elevation, 0]]),
  ev([[V.FloodRisk, 2]]),
  ev([[V.FloodRisk, 2], [V.Elevation, 2]]),
  ev([[V.RiverLevel, 1], [V.Drainage, 2]]),
];

describe('Bayesian network', () => {
  it('has valid CPTs (every row sums to 1)', () => {
    expect(validate(net)).toEqual([]);
  });

  it('enumeration == variable elimination for every variable and several evidence sets', () => {
    for (const e of EVIDENCE_SETS)
      for (let q = 0; q < net.vars.length; q++) {
        const a = enumerationAsk(net, q, e), b = variableElimination(net, q, e);
        expect(a.impossible).toBe(false);
        expect(b.impossible).toBe(false);
        for (let s = 0; s < a.dist!.length; s++) expect(Math.abs(a.dist![s] - b.dist![s])).toBeLessThan(1e-9);
      }
  });

  it('detects impossible evidence', () => {
    const n2 = cloneNetwork(net);
    // A gauge that can never read "heavy" when the rain is light.
    n2.vars[V.RainGauge].cpt.set([0.95, 0.05, 0], 0);
    const e = ev([[V.Rain, 0], [V.RainGauge, 2]]);
    expect(enumerationAsk(n2, V.FloodRisk, e).impossible).toBe(true);
    expect(variableElimination(n2, V.FloodRisk, e).impossible).toBe(true);
  });
});
