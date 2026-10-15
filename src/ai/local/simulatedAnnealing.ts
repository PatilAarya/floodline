/**
 * Simulated annealing on the group -> centre assignment.
 *
 *   current <- start (the CSP solution);  best <- current
 *   for k = 0 .. K-1:
 *     T <- temperature(k)                       (cooling.ts)
 *     next <- a random neighbour (reassign one group, or swap two)
 *     dE <- E(next) - E(current)
 *     if dE <= 0, or with probability exp(-dE / T): current <- next
 *     if E(current) < E(best): best <- current
 *   return best
 *
 * Accepting some uphill moves lets the search climb out of local minima
 * that would trap hill climbing; as T falls it behaves more and more like
 * hill climbing and settles into a good minimum. With restarts, the K
 * iterations are split into R runs, each starting again from the CSP
 * solution with a fresh temperature, and the best plan overall is kept.
 *
 * The annealer is a stepper: `step(n)` advances n iterations, so the page
 * can animate it frame by frame. It is deterministic for a given seed.
 */
import { Rng } from '../../core/rng';
import { acceptProbability, autoT0, temperature, type Cooling } from './cooling';
import { AssignmentState, randomMove, type AssignmentModel } from './objective';

export interface SAOptions {
  iterations: number;
  cooling: Cooling;
  /** Starting temperature; omit for automatic (from sampled uphill moves). */
  T0?: number;
  /** Final temperature as a fraction of T0. */
  endRatio?: number;
  seed: string;
  /** Share of moves that are swaps (the rest are reassignments). */
  swapProb?: number;
  /** Independent runs from the start, best kept. */
  restarts?: number;
  /** Trace points to keep (for the plot). */
  tracePoints?: number;
}

export interface TracePoint {
  /** Moves evaluated so far. */
  i: number;
  energy: number;
  best: number;
  T: number;
}

export class Annealer {
  readonly model: AssignmentModel;
  readonly T0: number;
  readonly trace: TracePoint[] = [];
  /** Uphill moves that were accepted (sampled, for markers on the plot). */
  readonly uphill: { i: number; energy: number }[] = [];
  bestAssign: Int32Array;
  bestEnergy: number;
  iteration = 0;
  accepted = 0;
  acceptedUphill = 0;
  rejected = 0;
  run = 0;

  private st: AssignmentState;
  private rng: Rng;
  private start: Int32Array;
  private opts: Required<Omit<SAOptions, 'T0'>>;
  private perRun: number;
  private every: number;
  private uphillEvery: number;
  private uphillSeen = 0;

  constructor(model: AssignmentModel, start: Int32Array, o: SAOptions) {
    this.model = model;
    this.start = start.slice();
    this.opts = { endRatio: 1e-3, swapProb: 0.3, restarts: 1, tracePoints: 600, ...o };
    this.rng = new Rng(`sa::${o.seed}`);
    this.st = new AssignmentState(model, this.start);
    this.T0 = o.T0 ?? autoT0(this.st, new Rng(`sa-t0::${o.seed}`), 300, 0.6, this.opts.swapProb);
    this.bestAssign = this.st.assign.slice();
    this.bestEnergy = this.st.energy;
    this.perRun = Math.max(1, Math.floor(o.iterations / Math.max(1, this.opts.restarts)));
    this.every = Math.max(1, Math.floor(o.iterations / this.opts.tracePoints));
    this.uphillEvery = Math.max(1, Math.floor(o.iterations / 4000));
    this.trace.push({ i: 0, energy: this.st.energy, best: this.bestEnergy, T: this.T0 });
  }

  get done(): boolean {
    return this.iteration >= this.opts.iterations;
  }

  get energy(): number {
    return this.st.energy;
  }

  get temperatureNow(): number {
    const k = this.done ? this.perRun : this.iteration % this.perRun;
    return temperature(this.opts.cooling, k, this.perRun, this.T0, this.opts.endRatio);
  }

  /** Advance up to n iterations. Returns true when finished. */
  step(n: number): boolean {
    const { opts, st, rng } = this;
    const end = Math.min(opts.iterations, this.iteration + n);
    while (this.iteration < end) {
      const k = this.iteration % this.perRun;
      // Restart: back to the CSP solution with a fresh temperature.
      if (k === 0 && this.iteration > 0) {
        this.run++;
        st.apply(diffMove(st.assign, this.start));
      }
      const T = temperature(opts.cooling, k, this.perRun, this.T0, opts.endRatio);
      const mv = randomMove(st, rng, opts.swapProb);
      this.iteration++;
      if (mv) {
        const before = st.energy;
        const undo = st.apply(mv);
        const dE = st.energy - before;
        if (dE <= 0 || rng.next() < acceptProbability(dE, T)) {
          this.accepted++;
          if (dE > 1e-9) {
            this.acceptedUphill++;
            if (this.uphillSeen++ % this.uphillEvery === 0) this.uphill.push({ i: this.iteration, energy: st.energy });
          }
          if (st.energy < this.bestEnergy - 1e-9) {
            this.bestEnergy = st.energy;
            this.bestAssign = st.assign.slice();
          }
        } else {
          st.apply(undo);
          this.rejected++;
        }
      } else {
        this.rejected++;
      }
      if (this.iteration % this.every === 0 || this.iteration === opts.iterations) this.trace.push({ i: this.iteration, energy: st.energy, best: this.bestEnergy, T });
    }
    if (this.done) st.recompute();
    return this.done;
  }

  /** Run to the end. */
  finish(): this {
    this.step(Infinity);
    return this;
  }
}

/** The move that turns assignment `from` into `to`. */
export function diffMove(from: Int32Array, to: Int32Array): [number, number][] {
  const mv: [number, number][] = [];
  for (let g = 0; g < from.length; g++) if (from[g] !== to[g]) mv.push([g, to[g]]);
  return mv;
}
