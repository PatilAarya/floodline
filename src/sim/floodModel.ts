/**
 * Shallow-water flood model: the "virtual pipes" method.
 *
 * The terrain is a grid of water columns. Each cell has four outflow pipes
 * to its neighbours. Every sub-step:
 *
 *   1. Sources and sinks: rain is added, storm drains and infiltration
 *      remove water, the upstream Mithi inflow enters at its inflow cells.
 *   2. Pipe flux update. The pipe from cell k to neighbour m accelerates when
 *      k's water surface is higher than m's:
 *          q <- (q + dt * g * hf * (H_k - H_m) / l) / (1 + dt * g * n^2 * q / hf^(7/3))
 *      q is discharge per metre of pipe width (m^2/s), H = bed + depth is the
 *      water surface, hf is the flow depth at the pipe (higher surface minus
 *      higher bed), n is Manning's roughness. The denominator is friction.
 *      This is the local-inertial form used by LISFLOOD-FP (Bates et al. 2010)
 *      written as directional, non-negative pipes (Mei et al. 2007).
 *   3. Outflow scaling. If a cell's four pipes would drain more water than it
 *      holds this step, all four are scaled down by K = volume / outflow.
 *      Depth can therefore never go negative, and no water is created.
 *   4. Depth update: d += dt * (sum of inflows - sum of outflows) / l.
 *   5. Sea cells are held at the tide level (a fixed-level boundary); the
 *      water this adds or removes is booked as "sea exchange".
 *   Land cells on the map edge drain freely outwards (water keeps flowing
 *   beyond the mapped area); this is booked as "outflow". The river inflow
 *   cells are walled so incoming water does not leak straight back out.
 *
 * Stability: the time step obeys the CFL condition dt <= alpha * l / sqrt(g * hmax).
 * The model always advances in whole simulated minutes, each split into
 * equal sub-steps, so the state at minute m is identical however you got
 * there (playing, scrubbing back, or seeking forward).
 *
 * Mass bookkeeping: total water = initial + rain + inflow - drained
 * - infiltrated - outflow + sea exchange. The test suite checks this.
 */
import { rainAt, tideAt, type StormSpec } from './rainfall';

export const G = 9.81;

export interface FloodSetup {
  n: number;
  /** Cell size, metres. */
  cell: number;
  /** Bed elevation (terrain with carved channels), metres. */
  bed: Float32Array;
  /** 1 = sea cell (fixed level = tide). */
  sea: Uint8Array;
  /** Storm-drain capacity per cell, m/s of water depth. */
  drainRate: Float32Array;
  /** Infiltration capacity per cell, m/s. */
  infil: Float32Array;
  /** Manning roughness per cell. */
  manning: Float32Array;
  /** Cells receiving the upstream inflow. */
  inflowCells: Int32Array;
  /** Water already present at t = 0 (lakes), metres. */
  initialDepth?: Float32Array;
}

export interface Forcing {
  storm: StormSpec;
  /** Upstream catchment area above the inflow, m^2, and runoff coefficient. */
  upstreamArea: number;
  runoffCoeff: number;
  /** Lag of upstream runoff, minutes. */
  lag: number;
  /** Dry-weather base flow, m^3/s. */
  baseFlow: number;
  tideOffset: number;
  drainScale: number;
  /** Rain multiplier changes during the run (the live rain slider), sorted by minute. */
  rainOverrides: { minute: number; scale: number }[];
}

export interface Budget {
  rain: number;
  inflow: number;
  drained: number;
  infiltrated: number;
  /** Water leaving across the land edges of the map. */
  outflow: number;
  sea: number;
}

export interface FloodState {
  minute: number;
  d: Float32Array;
  qL: Float32Array;
  qR: Float32Array;
  qU: Float32Array;
  qD: Float32Array;
  budget: Budget;
}

export class FloodModel {
  readonly n: number;
  readonly N: number;
  readonly l: number;
  readonly area: number;
  readonly s: FloodSetup;
  f: Forcing;

  d: Float32Array;
  qL: Float32Array; // pipe to the west neighbour (k - 1)
  qR: Float32Array; // east (k + 1)
  qU: Float32Array; // north (k - n)
  qD: Float32Array; // south (k + n)
  /** Simulated time, whole minutes. */
  minute = 0;
  budget: Budget = { rain: 0, inflow: 0, drained: 0, infiltrated: 0, outflow: 0, sea: 0 };
  /** Sub-steps used for the last minute (diagnostic). */
  lastSubsteps = 0;
  private initialVolume = 0;
  private scratchOut: Float32Array;
  /** 1 where a land cell on the map edge may drain outwards. */
  private open: Uint8Array;

  constructor(setup: FloodSetup, forcing: Forcing) {
    this.s = setup;
    this.f = forcing;
    this.n = setup.n;
    this.N = setup.n * setup.n;
    this.l = setup.cell;
    this.area = setup.cell * setup.cell;
    this.d = new Float32Array(this.N);
    this.qL = new Float32Array(this.N);
    this.qR = new Float32Array(this.N);
    this.qU = new Float32Array(this.N);
    this.qD = new Float32Array(this.N);
    this.scratchOut = new Float32Array(this.N);
    this.open = new Uint8Array(this.N);
    const n = this.n;
    for (let k = 0; k < this.N; k++) {
      const i = k % n, j = (k - i) / n;
      if ((i === 0 || j === 0 || i === n - 1 || j === n - 1) && !setup.sea[k]) this.open[k] = 1;
    }
    for (const k of setup.inflowCells) this.open[k] = 0;
    this.reset();
  }

  reset(): void {
    this.minute = 0;
    this.qL.fill(0);
    this.qR.fill(0);
    this.qU.fill(0);
    this.qD.fill(0);
    if (this.s.initialDepth) this.d.set(this.s.initialDepth);
    else this.d.fill(0);
    this.applySea(tideAt(this.f.storm, 0) + this.f.tideOffset, false);
    this.budget = { rain: 0, inflow: 0, drained: 0, infiltrated: 0, outflow: 0, sea: 0 };
    this.initialVolume = this.volume();
  }

  /** Total water volume on the grid, m^3 (sea included). */
  volume(): number {
    let v = 0;
    for (let k = 0; k < this.N; k++) v += this.d[k];
    return v * this.area;
  }

  /** Volume expected from the bookkeeping; equals volume() up to float error. */
  expectedVolume(): number {
    const b = this.budget;
    return this.initialVolume + b.rain + b.inflow - b.drained - b.infiltrated - b.outflow + b.sea;
  }

  rainScaleAt(minute: number): number {
    let s = 1;
    for (const o of this.f.rainOverrides) if (o.minute <= minute) s = o.scale;
    return s;
  }

  /** Rain intensity in m/s at a time in minutes. */
  rainRate(t: number): number {
    return (rainAt(this.f.storm, t) * this.rainScaleAt(Math.floor(t))) / 1000 / 3600;
  }

  seaLevel(t: number): number {
    return tideAt(this.f.storm, t) + this.f.tideOffset;
  }

  /** Upstream inflow, m^3/s: lagged rain on the catchment above the map plus base flow. */
  inflowRate(t: number): number {
    return this.f.baseFlow + this.f.upstreamArea * this.f.runoffCoeff * this.rainRate(t - this.f.lag);
  }

  /**
   * Drainage efficiency at a sea level: Mumbai's outfalls have flap gates
   * that shut when the tide is high, so drains stop emptying to the sea.
   */
  drainEfficiency(seaLevel: number): number {
    return Math.min(1, Math.max(0.12, (1.8 - seaLevel) / 1.2));
  }

  /** Deepest water on land. Sea cells are reset to the tide every sub-step,
   *  so waves inside the sea don't matter and they are left out of the CFL limit. */
  private maxDepthSurface(): number {
    let m = 0;
    const sea = this.s.sea;
    for (let k = 0; k < this.N; k++) if (!sea[k] && this.d[k] > m) m = this.d[k];
    return m;
  }

  /** Advance one simulated minute (several equal CFL-limited sub-steps). */
  stepMinute(): void {
    const hmax = Math.max(0.05, this.maxDepthSurface() + 0.5);
    const dtCfl = (0.7 * this.l) / Math.sqrt(G * hmax);
    const sub = Math.max(1, Math.ceil(60 / Math.min(dtCfl, 15)));
    const dt = 60 / sub;
    for (let s = 0; s < sub; s++) this.substep(dt, this.minute + (s + 0.5) / sub);
    this.lastSubsteps = sub;
    this.minute++;
  }

  advanceTo(minute: number): void {
    while (this.minute < minute) this.stepMinute();
  }

  private applySea(level: number, book: boolean): void {
    const { bed, sea } = this.s;
    let delta = 0;
    for (let k = 0; k < this.N; k++) {
      if (!sea[k]) continue;
      const target = Math.max(0, level - bed[k]);
      delta += target - this.d[k];
      this.d[k] = target;
    }
    if (book) this.budget.sea += delta * this.area;
  }

  private substep(dt: number, tMin: number): void {
    const { n, N, l, area } = this;
    const { bed, sea, drainRate, infil, manning, inflowCells } = this.s;
    const d = this.d, qL = this.qL, qR = this.qR, qU = this.qU, qD = this.qD;
    const out = this.scratchOut;

    // 1. Sources and sinks (land cells only).
    const rain = this.rainRate(tMin) * dt;
    const level = this.seaLevel(tMin);
    const eff = this.drainEfficiency(level) * this.f.drainScale;
    let drained = 0, infiltrated = 0, rained = 0;
    for (let k = 0; k < N; k++) {
      if (sea[k]) continue;
      d[k] += rain;
      rained += rain;
      const inf = Math.min(d[k], infil[k] * dt);
      d[k] -= inf;
      infiltrated += inf;
      const dr = Math.min(d[k], drainRate[k] * eff * dt);
      d[k] -= dr;
      drained += dr;
    }
    const inflowVol = this.inflowRate(tMin) * dt;
    if (inflowCells.length > 0) {
      const per = inflowVol / inflowCells.length / area;
      for (let i = 0; i < inflowCells.length; i++) d[inflowCells[i]] += per;
      this.budget.inflow += inflowVol;
    }
    this.budget.rain += rained * area;
    this.budget.drained += drained * area;
    this.budget.infiltrated += infiltrated * area;

    // 2. Pipe fluxes from surface differences, with friction.
    //    (Written out longhand for speed: this loop runs millions of times.)
    const gdt = G * dt;
    const lInv = 1 / l;
    const open = this.open;
    let outflow = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const dk = d[k];
        // A dry cell has nothing to give: every outflow pipe is zero.
        if (dk <= 0) {
          qL[k] = qR[k] = qU[k] = qD[k] = 0;
          out[k] = 0;
          continue;
        }
        const bk = bed[k], Hk = bk + dk, fr = gdt * manning[k] * manning[k];
        let a = 0, b = 0, c2 = 0, e = 0;
        // Pipes across the map edge lead to a dry "ghost" cell at the same
        // bed level (free outfall); walled where the edge is closed.
        const op = open[k] === 1;
        if (i > 0 || op) {
          const m = k - 1, bm = i > 0 ? bed[m] : bk, Hm = i > 0 ? bm + d[m] : bk;
          const hf = (Hk > Hm ? Hk : Hm) - (bk > bm ? bk : bm);
          if (hf > 1e-4) {
            const q = qL[k];
            a = (q + gdt * hf * (Hk - Hm) * lInv) / (1 + (fr * q) / (hf * hf * Math.cbrt(hf)));
            if (a < 0) a = 0;
          }
        }
        if (i < n - 1 || op) {
          const m = k + 1, bm = i < n - 1 ? bed[m] : bk, Hm = i < n - 1 ? bm + d[m] : bk;
          const hf = (Hk > Hm ? Hk : Hm) - (bk > bm ? bk : bm);
          if (hf > 1e-4) {
            const q = qR[k];
            b = (q + gdt * hf * (Hk - Hm) * lInv) / (1 + (fr * q) / (hf * hf * Math.cbrt(hf)));
            if (b < 0) b = 0;
          }
        }
        if (j > 0 || op) {
          const m = k - n, bm = j > 0 ? bed[m] : bk, Hm = j > 0 ? bm + d[m] : bk;
          const hf = (Hk > Hm ? Hk : Hm) - (bk > bm ? bk : bm);
          if (hf > 1e-4) {
            const q = qU[k];
            c2 = (q + gdt * hf * (Hk - Hm) * lInv) / (1 + (fr * q) / (hf * hf * Math.cbrt(hf)));
            if (c2 < 0) c2 = 0;
          }
        }
        if (j < n - 1 || op) {
          const m = k + n, bm = j < n - 1 ? bed[m] : bk, Hm = j < n - 1 ? bm + d[m] : bk;
          const hf = (Hk > Hm ? Hk : Hm) - (bk > bm ? bk : bm);
          if (hf > 1e-4) {
            const q = qD[k];
            e = (q + gdt * hf * (Hk - Hm) * lInv) / (1 + (fr * q) / (hf * hf * Math.cbrt(hf)));
            if (e < 0) e = 0;
          }
        }
        // 3. Outflow scaling: never drain more than the cell holds.
        const vOut = (a + b + c2 + e) * l * dt;
        const vHave = dk * area;
        if (vOut > vHave) {
          const K = vHave / vOut;
          a *= K;
          b *= K;
          c2 *= K;
          e *= K;
        }
        qL[k] = a;
        qR[k] = b;
        qU[k] = c2;
        qD[k] = e;
        out[k] = a + b + c2 + e;
        if (op) {
          // Water through edge pipes leaves the map.
          let leave = 0;
          if (i === 0) leave += a;
          if (i === n - 1) leave += b;
          if (j === 0) leave += c2;
          if (j === n - 1) leave += e;
          outflow += leave * l * dt;
        }
      }
    }
    this.budget.outflow += outflow;

    // 4. Depth update from net pipe flow.
    const c = dt / l;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        let inflow = 0;
        if (i > 0) inflow += qR[k - 1];
        if (i < n - 1) inflow += qL[k + 1];
        if (j > 0) inflow += qD[k - n];
        if (j < n - 1) inflow += qU[k + n];
        const nd = d[k] + c * (inflow - out[k]);
        d[k] = nd > 0 ? nd : 0; // only float rounding can push this below zero
      }
    }

    // 5. Sea boundary at tide level.
    this.applySea(level, true);
  }

  snapshot(): FloodState {
    return {
      minute: this.minute,
      d: this.d.slice(),
      qL: this.qL.slice(),
      qR: this.qR.slice(),
      qU: this.qU.slice(),
      qD: this.qD.slice(),
      budget: { ...this.budget },
    };
  }

  restore(s: FloodState): void {
    this.minute = s.minute;
    this.d.set(s.d);
    this.qL.set(s.qL);
    this.qR.set(s.qR);
    this.qU.set(s.qU);
    this.qD.set(s.qD);
    this.budget = { ...s.budget };
  }

  /** Cell-centred flow (unit discharge, m^2/s) for drawing flow streaks. */
  flowField(out = new Float32Array(this.N * 2)): Float32Array {
    const { n, qL, qR, qU, qD } = this;
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const inR = i > 0 ? qR[k - 1] : 0, inL = i < n - 1 ? qL[k + 1] : 0;
        const inD = j > 0 ? qD[k - n] : 0, inU = j < n - 1 ? qU[k + n] : 0;
        out[k * 2] = 0.5 * (qR[k] - qL[k] + inR - inL);
        out[k * 2 + 1] = 0.5 * (qD[k] - qU[k] + inD - inU);
      }
    return out;
  }

  /** Dev-mode check: no NaN, Infinity or negative depth anywhere. */
  assertFinite(): string | null {
    for (let k = 0; k < this.N; k++) {
      const v = this.d[k];
      if (!Number.isFinite(v) || v < 0) return `invalid depth ${v} at cell ${k}, minute ${this.minute}`;
    }
    return null;
  }
}
