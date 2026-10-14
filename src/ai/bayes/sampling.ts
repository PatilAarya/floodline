/**
 * Approximate inference by likelihood weighting (AIMA's
 * LIKELIHOOD-WEIGHTING).
 *
 * Draw N samples. For each one, walk the variables in topological order:
 *   - an evidence variable is NOT sampled: it is fixed to its observed state
 *     and the sample's weight is multiplied by P(observed | parents);
 *   - any other variable is sampled from its CPT row given its parents.
 * The estimate of P(q | e) is (total weight of samples with Query = q) /
 * (total weight). It is consistent: it converges to the exact answer as N
 * grows, with error shrinking roughly like 1 / sqrt(N_eff).
 *
 * Weakness: when the evidence is unlikely, most samples get tiny weights and
 * a few dominate, so the "effective sample size"
 *   N_eff = (sum w)^2 / sum w^2
 * is far below N. The UI shows N_eff next to N for that reason.
 *
 * Seeded: the same seed gives the same estimates (pass an Rng).
 */
import type { Rng } from '../../core/rng';
import { rowOf, topoOrder, type Evidence, type Network } from './network';

export interface LWCheckpoint {
  n: number;
  /** Estimated P(Query = s | evidence) after n samples (NaN while all weights are 0). */
  dist: Float64Array;
  ess: number;
}

export interface LWResult {
  dist: Float64Array | null;
  /** Every sample had weight 0: the evidence looks impossible. */
  impossible: boolean;
  ess: number;
  checkpoints: LWCheckpoint[];
}

/** Log-spaced checkpoints 10, 20, 50, 100, ... up to n (and n itself). */
export function logCheckpoints(n: number): number[] {
  const out: number[] = [];
  for (let p = 1; p <= 1e9; p *= 10) {
    for (const m of [1, 2, 5]) {
      const v = m * p * 10;
      if (v < n) out.push(v);
    }
    if (p * 10 >= n) break;
  }
  out.push(n);
  return [...new Set(out)].sort((a, b) => a - b);
}

export function likelihoodWeighting(net: Network, query: number, evidence: Evidence, n: number, rng: Rng, checkpoints: number[] = logCheckpoints(n)): LWResult {
  const order = topoOrder(net);
  const k = net.vars[query].states.length;
  const acc = new Float64Array(k);
  let total = 0, total2 = 0;
  const a = new Int32Array(net.vars.length);
  const out: LWCheckpoint[] = [];
  let next = 0;
  for (let i = 1; i <= n; i++) {
    let w = 1;
    for (const x of order) {
      const v = net.vars[x];
      const ks = v.states.length;
      const base = rowOf(net, x, a) * ks;
      const obs = evidence.get(x);
      if (obs !== undefined) {
        a[x] = obs;
        w *= v.cpt[base + obs];
      } else {
        // Sample from the CPT row by inverse transform.
        let u = rng.next(), s = 0;
        while (s < ks - 1 && u >= v.cpt[base + s]) {
          u -= v.cpt[base + s];
          s++;
        }
        a[x] = s;
      }
    }
    acc[a[query]] += w;
    total += w;
    total2 += w * w;
    while (next < checkpoints.length && checkpoints[next] === i) {
      const dist = new Float64Array(k);
      for (let s = 0; s < k; s++) dist[s] = total > 0 ? acc[s] / total : NaN;
      out.push({ n: i, dist, ess: total2 > 0 ? (total * total) / total2 : 0 });
      next++;
    }
  }
  if (!(total > 0)) return { dist: null, impossible: true, ess: 0, checkpoints: out };
  const dist = new Float64Array(k);
  for (let s = 0; s < k; s++) dist[s] = acc[s] / total;
  return { dist, impossible: false, ess: (total * total) / total2, checkpoints: out };
}
