/** Small descriptive statistics for the Experiments page. Pure functions. */

export function mean(v: number[]): number {
  const f = v.filter(Number.isFinite);
  return f.length ? f.reduce((a, b) => a + b, 0) / f.length : NaN;
}

export function sd(v: number[]): number {
  const f = v.filter(Number.isFinite);
  if (f.length < 2) return NaN;
  const m = mean(f);
  return Math.sqrt(f.reduce((a, b) => a + (b - m) ** 2, 0) / (f.length - 1));
}

/** Quantile by linear interpolation between order statistics (q in 0..1). */
export function quantile(v: number[], q: number): number {
  const f = v.filter(Number.isFinite).sort((a, b) => a - b);
  if (!f.length) return NaN;
  const pos = (f.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return f[lo] + (f[hi] - f[lo]) * (pos - lo);
}

export const median = (v: number[]): number => quantile(v, 0.5);

/**
 * Paired sign test. For each pair, did A beat B (by more than `tol`), lose,
 * or tie? Ties are dropped. Under "no difference" wins ~ Binomial(n, 1/2);
 * the two-sided p-value is the probability of a split at least this lopsided.
 * `better(a, b)` says whether a is better than b (e.g. a > b for sheltered).
 */
export function signTest(a: number[], b: number[], better: (x: number, y: number) => boolean, tol = 0): { wins: number; losses: number; ties: number; p: number } {
  let wins = 0, losses = 0, ties = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i]) || Math.abs(a[i] - b[i]) <= tol) ties++;
    else if (better(a[i], b[i])) wins++;
    else losses++;
  }
  const n = wins + losses;
  if (n === 0) return { wins, losses, ties, p: 1 };
  const k = Math.min(wins, losses);
  // P(X <= k) for X ~ Binomial(n, 0.5), doubled; summed in log space for large n.
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += Math.exp(logChoose(n, i) - n * Math.LN2);
  return { wins, losses, ties, p: Math.min(1, 2 * tail) };
}

function logChoose(n: number, k: number): number {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log((n - k + i) / i);
  return s;
}
