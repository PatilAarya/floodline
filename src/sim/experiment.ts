/**
 * Batch experiments: one seeded storm, every strategy, the same water.
 *
 * The water does not depend on how people evacuate, so for each seed the
 * flood model runs ONCE and every strategy's agents step through the same
 * minute-by-minute road states and flood-risk estimates. That is a fair,
 * PAIRED comparison (same storm, same sensor misreads, same closures for
 * all three), and about three times cheaper than three separate runs.
 *
 * Each minute does exactly what the Simulator's engine does (floodEngine.ts):
 * water, then road states, then the Bayesian gauge readings every
 * READ_EVERY minutes, then the agents. So seed `mumbai` here reproduces the
 * Simulator's numbers for that seed exactly.
 *
 * Pure (no DOM); runs in experimentWorker.ts.
 */
import { mumbaiNetwork } from '../ai/bayes/cpt';
import type { RiskPosterior, RiskReadings } from './riskModel';
import { AgentSim, type Strategy } from './agents';
import { buildAgentSetup } from './agentSetup';
import { pickGaugeCell } from './floodEngine';
import { FloodModel, type FloodSetup } from './floodModel';
import { buildEdgeTable, buildFloodSetup, buildForcing, computeEdgeStates, type EdgeTable, type TravelMode } from './hydrology';
import { totalRain } from './rainfall';
import { buildRiskSetup, edgeRisk, READ_EVERY, readGauges, riskPosterior } from './riskModel';
import { resolveStorm, type ScenarioId } from './scenario';
import type { World } from '../world/types';

export const STRATEGIES: Strategy[] = ['naive', 'dynamic', 'risk'];

export interface ExperimentPrep {
  world: World;
  setup: FloodSetup;
  table: EdgeTable;
  gaugeCell: number;
  notLand: Uint8Array;
}

export function prepareExperiment(world: World): ExperimentPrep {
  const notLand = new Uint8Array(world.terrain.n * world.terrain.n);
  for (let k = 0; k < notLand.length; k++) notLand[k] = world.sea[k] || world.terrain.channel[k] ? 1 : 0;
  return { world, setup: buildFloodSetup(world), table: buildEdgeTable(world), gaugeCell: pickGaugeCell(world), notLand };
}

export interface SeedSpec {
  scenario: ScenarioId;
  seed: string;
  mode: TravelMode;
}

export interface StrategyResult {
  strategy: Strategy;
  sheltered: number;
  /** Demand that never reached a centre by the end of the storm. */
  unsheltered: number;
  /** Per sheltered group: minutes from leaving to arriving (mean and 95th percentile). */
  meanMinutes: number;
  p95Minutes: number;
  replans: number;
  assignRuns: number;
  reassigned: number;
  /** Minute when 90% of the demand was in a centre (NaN if never). */
  t90: number;
}

export interface SeedResult {
  seed: string;
  scenario: ScenarioId;
  mode: TravelMode;
  /** The storm as simulated. */
  rainMm: number;
  peakMmH: number;
  /** Worst moment of the flood. */
  maxFloodedKm2: number;
  maxClosedRoads: number;
  demand: number;
  results: StrategyResult[];
  ms: number;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Run one seed for every strategy. `onMinute` reports progress (every 30 minutes). */
export function runSeed(prep: ExperimentPrep, spec: SeedSpec, strategies: Strategy[] = STRATEGIES, onMinute?: (minute: number, duration: number) => void): SeedResult {
  const t0 = now();
  const { world, setup, table, gaugeCell, notLand } = prep;
  const sp = { scenario: spec.scenario, seed: spec.seed, rainScale: 1, tideOffset: 0, drainScale: 1 };
  const storm = resolveStorm(sp);
  const model = new FloodModel(setup, buildForcing(sp));
  model.reset();
  const agents = strategies.map((s) => new AgentSim(buildAgentSetup(world, s, spec.mode, 2, spec.seed)));
  const m0 = agents[0]?.metrics();
  const demand = m0 ? m0.sheltered + m0.enRoute + m0.waiting + m0.stranded + m0.noAccess : 0;
  const net = mumbaiNetwork();
  const rs = buildRiskSetup(world, spec.seed, gaugeCell);
  const nE = table.count;
  const state = new Uint8Array(nE), depth = new Float32Array(nE), risk = new Float32Array(nE);
  let readings: RiskReadings | null = null;
  let posterior: RiskPosterior | null = null;

  // Same as FloodEngine.updateRoads.
  const updateRoads = () => {
    computeEdgeStates(table, model.d, setup.bed, world.ground, spec.mode, state, depth);
    const t = model.minute;
    if (!posterior || !readings || t % READ_EVERY === 0 || t < readings.minute) {
      const stage = gaugeCell >= 0 ? setup.bed[gaugeCell] + model.d[gaugeCell] : rs.gaugeBed;
      readings = readGauges(net, rs, t, model.rainRate(t) * 1000 * 3600, stage);
      posterior = riskPosterior(net, readings.rain, readings.river);
    }
    edgeRisk(rs, posterior, depth, spec.mode, risk);
  };

  updateRoads();
  const t90 = strategies.map(() => NaN);
  let maxFlooded = 0, maxClosed = 0;
  const cellArea = setup.cell * setup.cell;
  const duration = storm.duration;
  while (model.minute < duration) {
    model.stepMinute();
    updateRoads();
    const m = model.minute;
    agents.forEach((a, i) => {
      a.step(m, state, depth, risk);
      if (Number.isNaN(t90[i]) && a.metrics().sheltered >= 0.9 * demand) t90[i] = m;
    });
    if (m % 10 === 0) {
      let closed = 0;
      for (let e = 0; e < nE; e++) if (state[e] === 2) closed++;
      let wet = 0;
      for (let k = 0; k < notLand.length; k++) if (!notLand[k] && setup.bed[k] + model.d[k] - world.ground[k] > 0.1) wet++;
      maxClosed = Math.max(maxClosed, closed);
      maxFlooded = Math.max(maxFlooded, (wet * cellArea) / 1e6);
    }
    if (onMinute && m % 30 === 0) onMinute(m, duration);
  }
  const results: StrategyResult[] = agents.map((a, i) => {
    const mt = a.metrics();
    return {
      strategy: strategies[i],
      sheltered: mt.sheltered,
      unsheltered: demand - mt.sheltered,
      meanMinutes: mt.meanMinutes,
      p95Minutes: mt.p95Minutes,
      replans: mt.replans,
      assignRuns: mt.assignRuns,
      reassigned: mt.reassigned,
      t90: t90[i],
    };
  });
  return {
    seed: spec.seed,
    scenario: spec.scenario,
    mode: spec.mode,
    rainMm: totalRain(storm),
    peakMmH: storm.peak,
    maxFloodedKm2: maxFlooded,
    maxClosedRoads: maxClosed,
    demand,
    results,
    ms: now() - t0,
  };
}
