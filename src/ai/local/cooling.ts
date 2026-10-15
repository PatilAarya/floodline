/**
 * Cooling schedules for simulated annealing: the temperature T after k of K
 * iterations, starting from T0.
 *
 *   geometric:  T_k = T0 * alpha^k, with alpha chosen so that T_K = T0 * endRatio.
 *               Spends most of the run at low temperatures (fine tuning).
 *   linear:     T_k = T0 * (1 - k / K), floored at T0 * endRatio.
 *               Spends longer hot (more exploration), then drops quickly.
 *
 * At temperature T an uphill move of size dE > 0 is accepted with
 * probability exp(-dE / T): almost always when T >> dE, almost never when
 * T << dE. Downhill moves are always accepted.
 */
import type { AssignmentState } from './objective';
import { randomMove } from './objective';
import type { Rng } from '../../core/rng';

export type Cooling = 'geometric' | 'linear';

export function temperature(schedule: Cooling, k: number, K: number, T0: number, endRatio: number): number {
  const f = K > 0 ? Math.min(1, k / K) : 1;
  if (schedule === 'geometric') return T0 * Math.pow(endRatio, f);
  return Math.max(T0 * endRatio, T0 * (1 - f));
}

export function acceptProbability(dE: number, T: number): number {
  if (dE <= 0) return 1;
  if (T <= 0) return 0;
  return Math.exp(-dE / T);
}

/**
 * Starting temperature from the problem itself (Kirkpatrick's rule of thumb):
 * sample random moves, take a typical uphill step (the median, so the few
 * huge capacity-breaking moves do not dominate), and pick T0 so that such a
 * step is accepted with probability `p0` at the start:
 *   exp(-typical / T0) = p0   =>   T0 = -typical / ln(p0)
 */
export function autoT0(st: AssignmentState, rng: Rng, samples = 300, p0 = 0.6, swapProb = 0.3): number {
  const ups: number[] = [];
  for (let i = 0; i < samples * 6 && ups.length < samples; i++) {
    const mv = randomMove(st, rng, swapProb);
    if (!mv) continue;
    const d = st.delta(mv);
    if (d > 0 && Number.isFinite(d)) ups.push(d);
  }
  ups.sort((a, b) => a - b);
  const typical = ups.length ? ups[Math.floor(ups.length / 2)] : 1;
  return Math.max(1e-6, -typical / Math.log(p0));
}
