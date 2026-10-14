/**
 * The flood engine: owns a FloodModel and runs playback, keyframes and
 * seeking. It talks only through `post(message, transfer)`, so the same code
 * runs inside the Web Worker (floodWorker.ts) or, if workers are
 * unavailable, on the main thread (floodClient.ts fallback).
 *
 * Time model
 *   The model advances in whole minutes. Playback at speed s means s
 *   simulated minutes per wall-clock second. If the CPU cannot keep up, the
 *   engine runs as fast as it can and says so (`lagging`).
 *
 * Scrubbing
 *   A full keyframe (depths and pipe fluxes) is stored every KEY_EVERY
 *   minutes. Seeking back restores the nearest keyframe at or before the
 *   target and recomputes forward, which gives identical results because the
 *   model is deterministic minute by minute.
 *
 * Live rain
 *   Changing the rain slider during a run records an override from the
 *   current minute on. Keyframes after that minute are discarded because the
 *   future has changed; the past is kept.
 */
import { computeEdgeStates, type EdgeTable, type TravelMode } from './hydrology';
import { FloodModel, type FloodSetup, type FloodState, type Forcing } from './floodModel';
import type { World } from '../world/types';

export const KEY_EVERY = 30;

export interface InitMsg {
  type: 'init';
  setup: FloodSetup;
  forcing: Forcing;
  edges: EdgeTable;
  ground: Float32Array;
  gaugeCell: number;
  mode: TravelMode;
  /** For flood stats: sea + channel mask (1 = not land). */
  notLand: Uint8Array;
}

export type InMsg =
  | InitMsg
  | { type: 'play'; speed: number }
  | { type: 'pause' }
  | { type: 'speed'; speed: number }
  | { type: 'seek'; minute: number }
  | { type: 'step'; minutes: number }
  | { type: 'rain'; scale: number }
  | { type: 'forcing'; tideOffset: number; drainScale: number }
  | { type: 'mode'; mode: TravelMode }
  | { type: 'ack' }
  | { type: 'dispose' };

export interface FrameStats {
  rain: number;
  tide: number;
  inflow: number;
  drainEff: number;
  floodedKm2: number;
  maxDepth: number;
  blocked: number;
  degraded: number;
  volume: number;
  massError: number;
  gaugeStage: number;
  substeps: number;
}

export interface FrameMsg {
  type: 'frame';
  minute: number;
  depth: Float32Array;
  flow: Float32Array;
  edgeState: Uint8Array;
  edgeDepth: Float32Array;
  stats: FrameStats;
  computed: number;
  playing: boolean;
  lagging: boolean;
}

export type OutMsg =
  | { type: 'ready'; duration: number }
  | FrameMsg
  | { type: 'series'; from: number; stage: Float32Array; flooded: Float32Array }
  /** Drop hydrograph samples from minute `keep` on (the future changed). */
  | { type: 'seriesTruncate'; keep: number }
  | { type: 'busy'; target: number; at: number }
  | { type: 'error'; message: string };

type Post = (m: OutMsg, transfer?: Transferable[]) => void;

export class FloodEngine {
  private post: Post;
  private model: FloodModel | null = null;
  private init: InitMsg | null = null;
  private keyframes = new Map<number, FloodState>();
  private computed = 0;
  private playing = false;
  private speed = 1;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastWall = 0;
  private carry = 0;
  private awaitingAck = false;
  private dirtyFrame = false;
  private lagging = false;
  private mode: TravelMode = 'vehicle';
  private edgeState!: Uint8Array;
  private edgeDepth!: Float32Array;
  /** River stage and flooded area per minute, for the hydrograph. */
  private stage: number[] = [];
  private flooded: number[] = [];
  private seriesSent = 0;
  private duration = 0;
  private dev = false;

  constructor(post: Post, dev = false) {
    this.post = post;
    this.dev = dev;
  }

  handle(m: InMsg): void {
    try {
      switch (m.type) {
        case 'init':
          this.start(m);
          break;
        case 'play':
          this.speed = m.speed;
          this.setPlaying(true);
          break;
        case 'pause':
          this.setPlaying(false);
          this.emitFrame(true);
          break;
        case 'speed':
          this.speed = m.speed;
          break;
        case 'seek':
          this.seek(m.minute);
          break;
        case 'step':
          this.setPlaying(false);
          this.seek((this.model?.minute ?? 0) + m.minutes);
          break;
        case 'rain':
          this.setRain(m.scale);
          break;
        case 'forcing':
          this.setForcing(m.tideOffset, m.drainScale);
          break;
        case 'mode':
          this.mode = m.mode;
          this.emitFrame(true);
          break;
        case 'ack':
          this.awaitingAck = false;
          if (this.dirtyFrame) this.emitFrame(true);
          break;
        case 'dispose':
          this.setPlaying(false);
          this.model = null;
          this.keyframes.clear();
          break;
      }
    } catch (err) {
      this.post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  private start(m: InitMsg): void {
    this.init = m;
    this.mode = m.mode;
    this.model = new FloodModel(m.setup, m.forcing);
    this.keyframes.clear();
    this.keyframes.set(0, this.model.snapshot());
    this.computed = 0;
    this.stage = [];
    this.flooded = [];
    this.seriesSent = 0;
    this.edgeState = new Uint8Array(m.edges.count);
    this.edgeDepth = new Float32Array(m.edges.count);
    this.duration = m.forcing.storm.duration;
    this.recordSeries();
    this.post({ type: 'ready', duration: this.duration });
    this.awaitingAck = false;
    this.emitFrame(true);
  }

  private setPlaying(on: boolean): void {
    this.playing = on && !!this.model;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.playing) {
      this.lastWall = now();
      this.carry = 0;
      this.loop();
    }
  }

  private loop = (): void => {
    if (!this.playing || !this.model) return;
    const t = now();
    const dtWall = Math.min(250, t - this.lastWall);
    this.lastWall = t;
    this.carry += (dtWall / 1000) * this.speed;
    // Simulate whole minutes, but never spend more than ~24 ms per tick so
    // messages (pause, seek) stay responsive.
    const budgetEnd = t + 24;
    let advanced = false;
    while (this.carry >= 1 && now() < budgetEnd) {
      if (this.model.minute >= this.duration) {
        this.carry = 0;
        this.setPlaying(false);
        break;
      }
      this.stepOne();
      this.carry -= 1;
      advanced = true;
    }
    // If we could not keep up, drop the backlog instead of racing forever.
    this.lagging = this.carry > 2;
    if (this.lagging) this.carry = 1;
    if (advanced) this.emitFrame(false);
    if (this.playing) this.timer = setTimeout(this.loop, 8);
  };

  private stepOne(): void {
    const m = this.model!;
    m.stepMinute();
    if (this.dev) {
      const bad = m.assertFinite();
      if (bad) throw new Error(bad);
    }
    if (m.minute % KEY_EVERY === 0 && !this.keyframes.has(m.minute)) this.keyframes.set(m.minute, m.snapshot());
    if (m.minute > this.computed) {
      this.computed = m.minute;
      this.recordSeries();
    }
  }

  private recordSeries(): void {
    const m = this.model!, init = this.init!;
    if (this.stage.length > m.minute) return;
    const g = init.gaugeCell;
    this.stage[m.minute] = g >= 0 ? init.setup.bed[g] + m.d[g] : 0;
    let wet = 0;
    const N = m.N, a = init.setup.cell * init.setup.cell;
    for (let k = 0; k < N; k++) if (!init.notLand[k] && init.setup.bed[k] + m.d[k] - init.ground[k] > 0.1) wet++;
    this.flooded[m.minute] = (wet * a) / 1e6;
  }

  private flushSeries(): void {
    if (this.stage.length <= this.seriesSent) return;
    const from = this.seriesSent;
    const stage = Float32Array.from(this.stage.slice(from));
    const flooded = Float32Array.from(this.flooded.slice(from));
    this.seriesSent = this.stage.length;
    this.post({ type: 'series', from, stage, flooded }, [stage.buffer, flooded.buffer]);
  }

  private seek(minute: number): void {
    const m = this.model;
    if (!m) return;
    const target = Math.max(0, Math.min(this.duration, Math.round(minute)));
    if (target < m.minute || target - m.minute > KEY_EVERY) {
      // Restore the latest keyframe at or before the target.
      let best = 0;
      for (const k of this.keyframes.keys()) if (k <= target && k > best) best = k;
      if (best > m.minute || target < m.minute) m.restore(this.keyframes.get(best)!);
    }
    const t0 = now();
    while (m.minute < target) {
      this.stepOne();
      if (now() - t0 > 400 && (m.minute & 3) === 0) {
        // Long fast-forward: keep the UI informed.
        this.post({ type: 'busy', target, at: m.minute });
      }
    }
    this.emitFrame(true);
  }

  private setRain(scale: number): void {
    const m = this.model;
    if (!m) return;
    const at = m.minute;
    // Replace any overrides from now on with the new value.
    m.f.rainOverrides = m.f.rainOverrides.filter((o) => o.minute < at).concat({ minute: at, scale });
    this.invalidateAfter(at);
  }

  private setForcing(tideOffset: number, drainScale: number): void {
    const m = this.model;
    if (!m) return;
    const at = m.minute;
    m.f.tideOffset = tideOffset;
    m.f.drainScale = drainScale;
    // Tide and drains apply from the start, so the whole run is recomputed up to now.
    this.keyframes.clear();
    m.reset();
    this.keyframes.set(0, m.snapshot());
    this.computed = 0;
    this.stage = [];
    this.flooded = [];
    this.seriesSent = 0;
    this.post({ type: 'seriesTruncate', keep: 0 });
    this.recordSeries();
    this.seek(at);
  }

  private invalidateAfter(minute: number): void {
    for (const k of [...this.keyframes.keys()]) if (k > minute) this.keyframes.delete(k);
    this.computed = minute;
    this.stage.length = minute + 1;
    this.flooded.length = minute + 1;
    if (this.seriesSent > minute + 1) this.seriesSent = minute + 1;
    this.post({ type: 'seriesTruncate', keep: minute + 1 });
  }

  /** Send the current state. Unless forced, wait for the main thread's ack (backpressure). */
  private emitFrame(force: boolean): void {
    const m = this.model, init = this.init;
    if (!m || !init) return;
    if (this.awaitingAck && !force) {
      this.dirtyFrame = true;
      return;
    }
    this.dirtyFrame = false;
    this.awaitingAck = true;
    const es = computeEdgeStates(init.edges, m.d, init.setup.bed, init.ground, this.mode, this.edgeState, this.edgeDepth);
    const depth = m.d.slice();
    const flow = m.flowField();
    const edgeState = this.edgeState.slice();
    const edgeDepth = this.edgeDepth.slice();
    const t = m.minute;
    const fs = statsFor(init, depth);
    const g = init.gaugeCell;
    const stats: FrameStats = {
      rain: (m.rainRate(t) * 1000 * 3600),
      tide: m.seaLevel(t),
      inflow: m.inflowRate(t),
      drainEff: m.drainEfficiency(m.seaLevel(t)) * m.f.drainScale,
      floodedKm2: fs.floodedKm2,
      maxDepth: fs.maxDepth,
      blocked: es.blocked,
      degraded: es.degraded,
      volume: m.volume(),
      massError: Math.abs(m.volume() - m.expectedVolume()) / Math.max(1, m.expectedVolume()),
      gaugeStage: g >= 0 ? init.setup.bed[g] + m.d[g] : 0,
      substeps: m.lastSubsteps,
    };
    this.flushSeries();
    this.post(
      { type: 'frame', minute: t, depth, flow, edgeState, edgeDepth, stats, computed: this.computed, playing: this.playing, lagging: this.lagging },
      [depth.buffer, flow.buffer, edgeState.buffer, edgeDepth.buffer],
    );
  }
}

function statsFor(init: InitMsg, depth: Float32Array): { floodedKm2: number; maxDepth: number } {
  const bed = init.setup.bed, ground = init.ground, notLand = init.notLand;
  const a = init.setup.cell * init.setup.cell;
  let wet = 0, maxDepth = 0;
  for (let k = 0; k < depth.length; k++) {
    if (notLand[k]) continue;
    const over = bed[k] + depth[k] - ground[k];
    if (over > 0.1) wet++;
    if (over > maxDepth) maxDepth = over;
  }
  return { floodedKm2: (wet * a) / 1e6, maxDepth };
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Pick a river gauge: the Mithi channel cell nearest the middle of the river. */
export function pickGaugeCell(w: World): number {
  const t = w.terrain;
  const lines = w.waterLines.filter((l) => /mithi/i.test(l.name));
  const src = lines.length ? lines : w.waterLines.filter((l) => l.halfWidth >= 8);
  let best = -1, bestD = Infinity;
  const pts: number[] = [];
  for (const l of src) for (let i = 0; i < l.pts.length; i += 2) pts.push(l.pts[i], l.pts[i + 1]);
  if (!pts.length) return -1;
  const mid = Math.floor(pts.length / 4) * 2;
  const mx = pts[mid], my = pts[mid + 1];
  for (let k = 0; k < t.n * t.n; k++) {
    if (!t.channel[k]) continue;
    const i = k % t.n, j = (k - i) / t.n;
    const d = Math.hypot((i + 0.5) * t.cell - mx, (j + 0.5) * t.cell - my);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}
