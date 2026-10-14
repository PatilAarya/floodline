/**
 * Live flood risk: the Bayesian network fed by the simulation.
 *
 * Every READ_EVERY simulated minutes the two gauges report:
 *   - the rain gauge sees the true rain rate, classed light/moderate/heavy;
 *   - the river gauge sees the Mithi stage at the gauge cell, classed
 *     low/normal/high relative to the channel bed and bank.
 * Each sensor then MISREADS with exactly the probabilities in its CPT
 * (P(RainGauge | Rain), P(RiverGauge | RiverLevel)): the reading is drawn
 * from that CPT row with a random stream seeded by (seed, sensor, minute).
 * That makes the readings a pure function of (seed, minute, flood state), so
 * rewinding and replaying the simulation gives identical readings.
 *
 * Inference: with both readings as evidence, the posterior
 * P(FloodRisk | RainGauge, RiverGauge, Drainage = d, Elevation = e) is
 * computed by variable elimination for each of the 9 (d, e) combinations.
 * A neighbourhood looks up its own (drainage, elevation) row; so does each
 * road, using its neighbourhood's drainage and its own lowest point.
 *
 * Road risk fed to risk-aware A*:
 *   P_flood(edge) = 1 - (1 - P_bn) * (1 - depthTerm)
 * a noisy-OR of the network's P(FloodRisk = high) for that road and how close
 * the water already on it is to the closing depth. Flyovers never flood
 * (risk 0); subways count as low ground wherever they are.
 */
import { V, drainClassIndex, elevClass, riverClass, rainClass } from '../ai/bayes/cpt';
import { variableElimination } from '../ai/bayes/exact';
import type { Evidence, Network } from '../ai/bayes/network';
import { Rng } from '../core/rng';
import type { World } from '../world/types';
import { THRESHOLDS, type TravelMode } from './hydrology';

/** Minutes between gauge reports. */
export const READ_EVERY = 10;
/** Marks a road that never floods (flyover). */
export const NO_RISK = 255;

export interface RiskSetup {
  seed: string;
  /** Per neighbourhood: drainage state (0 poor, 1 fair, 2 good) and elevation state (0 low, 1 mid, 2 high). */
  hoodDrain: Uint8Array;
  hoodElev: Uint8Array;
  /** Per road segment: the same two states, or NO_RISK for flyovers. */
  edgeDrain: Uint8Array;
  edgeElev: Uint8Array;
  /** River gauge: channel bed and bank top, metres above sea. */
  gaugeBed: number;
  gaugeBank: number;
}

export function buildRiskSetup(w: World, seed: string, gaugeCell: number): RiskSetup {
  const hoodDrain = Uint8Array.from(w.hoods, (h) => drainClassIndex(h.drainageClass));
  const hoodElev = Uint8Array.from(w.hoods, (h) => elevClass(h.meanElev));
  const E = w.graph.edges;
  const edgeDrain = new Uint8Array(E.length);
  const edgeElev = new Uint8Array(E.length);
  E.forEach((e, i) => {
    let hd = w.graph.nodes[e.a].hood;
    if (hd < 0) hd = w.graph.nodes[e.b].hood;
    if (hd < 0 && e.cells.length) hd = w.cellHood[e.cells[0]];
    edgeDrain[i] = hd >= 0 ? hoodDrain[hd] : 1;
    edgeElev[i] = e.kind === 'flyover' ? NO_RISK : e.kind === 'tunnel' ? 0 : elevClass(e.minElev);
  });
  const g = gaugeCell >= 0 ? gaugeCell : 0;
  return { seed, hoodDrain, hoodElev, edgeDrain, edgeElev, gaugeBed: w.terrain.height[g], gaugeBank: w.ground[g] };
}

/**
 * A sensor report: the true state goes in, a possibly wrong reading comes
 * out, drawn from the sensor's CPT row. Deterministic in (seed, sensor, minute).
 */
export function sensorReading(net: Network, sensor: number, trueState: number, seed: string, minute: number): number {
  const v = net.vars[sensor];
  const k = v.states.length;
  let u = new Rng(`${seed}::gauge::${v.name}::${minute}`).next();
  for (let s = 0; s < k - 1; s++) {
    const p = v.cpt[trueState * k + s];
    if (u < p) return s;
    u -= p;
  }
  return k - 1;
}

export interface RiskReadings {
  minute: number;
  /** What each gauge reported (-1 = no reading). */
  rain: number;
  river: number;
  /** The truth, for the events log ("the rain gauge misread"). */
  rainTrue: number;
  riverTrue: number;
}

export interface RiskPosterior {
  /** P(FloodRisk = s | gauges, Drainage = d, Elevation = e) at [(d * 3 + e) * 3 + s]. */
  table: Float64Array;
  /** P(Rain | gauges) and P(RiverLevel | gauges). */
  pRain: Float64Array;
  pRiver: Float64Array;
}

/** Take readings for the current minute from the simulated truth. */
export function readGauges(net: Network, s: RiskSetup, minute: number, rainMmH: number, stage: number): RiskReadings {
  const rainTrue = rainClass(rainMmH);
  const riverTrue = riverClass(stage, s.gaugeBed, s.gaugeBank);
  return {
    minute,
    rainTrue,
    riverTrue,
    rain: sensorReading(net, V.RainGauge, rainTrue, s.seed, minute),
    river: sensorReading(net, V.RiverGauge, riverTrue, s.seed, minute),
  };
}

/** Posteriors for every (drainage, elevation) combination, given the gauge readings (-1 = unknown). */
export function riskPosterior(net: Network, rainReading: number, riverReading: number): RiskPosterior {
  const ev: Evidence = new Map();
  if (rainReading >= 0) ev.set(V.RainGauge, rainReading);
  if (riverReading >= 0) ev.set(V.RiverGauge, riverReading);
  const table = new Float64Array(27);
  for (let d = 0; d < 3; d++)
    for (let e = 0; e < 3; e++) {
      const full = new Map(ev);
      full.set(V.Drainage, d);
      full.set(V.Elevation, e);
      const r = variableElimination(net, V.FloodRisk, full);
      // Default CPTs have no zeros, so readings are never impossible; be safe anyway.
      const dist = r.dist ?? Float64Array.of(1 / 3, 1 / 3, 1 / 3);
      table.set(dist, (d * 3 + e) * 3);
    }
  const pRain = variableElimination(net, V.Rain, ev).dist ?? Float64Array.of(1 / 3, 1 / 3, 1 / 3);
  const pRiver = variableElimination(net, V.RiverLevel, ev).dist ?? Float64Array.of(1 / 3, 1 / 3, 1 / 3);
  return { table, pRain, pRiver };
}

/** Per neighbourhood: the full FloodRisk distribution, 3 numbers each (low, medium, high). */
export function hoodRisk(s: RiskSetup, p: RiskPosterior, out: Float32Array = new Float32Array(s.hoodDrain.length * 3)): Float32Array {
  for (let h = 0; h < s.hoodDrain.length; h++) {
    const o = (s.hoodDrain[h] * 3 + s.hoodElev[h]) * 3;
    out[h * 3] = p.table[o];
    out[h * 3 + 1] = p.table[o + 1];
    out[h * 3 + 2] = p.table[o + 2];
  }
  return out;
}

/** P_flood per road: noisy-OR of the network's P(high) and the water already on the road. */
export function edgeRisk(s: RiskSetup, p: RiskPosterior, depth: Float32Array, mode: TravelMode, out: Float32Array): Float32Array {
  const blocked = THRESHOLDS[mode].blocked;
  for (let i = 0; i < out.length; i++) {
    if (s.edgeElev[i] === NO_RISK) {
      out[i] = 0;
      continue;
    }
    const pBn = p.table[(s.edgeDrain[i] * 3 + s.edgeElev[i]) * 3 + 2];
    const wet = Math.min(1, Math.max(0, depth[i] / blocked));
    out[i] = 1 - (1 - pBn) * (1 - wet);
  }
  return out;
}
