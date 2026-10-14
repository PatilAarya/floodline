import { describe, expect, it } from 'vitest';
import { mumbaiNetwork, V } from '../src/ai/bayes/cpt';
import { dSeparated, explainTrails } from '../src/ai/bayes/dsep';
import { enumerationAsk, variableElimination } from '../src/ai/bayes/exact';
import { cloneNetwork, validate, type Evidence } from '../src/ai/bayes/network';
import { likelihoodWeighting } from '../src/ai/bayes/sampling';
import { Rng } from '../src/core/rng';

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

  it('likelihood weighting converges to the exact answer', () => {
    const e = ev([[V.RainGauge, 2], [V.Elevation, 0]]);
    const exact = variableElimination(net, V.FloodRisk, e).dist!;
    const lw = likelihoodWeighting(net, V.FloodRisk, e, 50000, new Rng('lw-test'));
    for (let s = 0; s < 3; s++) expect(Math.abs(lw.dist![s] - exact[s])).toBeLessThan(0.02);
  });

  it('d-separation: collider, fork and agreement with trail enumeration', () => {
    const none = new Set<number>();
    // Rain -> FloodRisk <- Drainage: independent until FloodRisk is observed.
    expect(dSeparated(net, V.Rain, V.Drainage, none).separated).toBe(true);
    expect(dSeparated(net, V.Rain, V.Drainage, new Set([V.FloodRisk])).separated).toBe(false);
    // The two gauges share the cause Rain; observing Rain blocks every trail.
    expect(dSeparated(net, V.RainGauge, V.RiverGauge, none).separated).toBe(false);
    expect(dSeparated(net, V.RainGauge, V.RiverGauge, new Set([V.Rain])).separated).toBe(true);
    for (let a = 0; a < net.vars.length; a++)
      for (let b = 0; b < net.vars.length; b++) {
        if (a === b) continue;
        for (const z of [none, new Set([V.FloodRisk]), new Set([V.Rain, V.RiverLevel])]) {
          if (z.has(a) || z.has(b)) continue;
          const active = explainTrails(net, a, b, z).some((t) => t.active);
          expect(dSeparated(net, a, b, z).separated).toBe(!active);
        }
      }
  });
});
