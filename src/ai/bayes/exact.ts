/**
 * Exact inference: P(Query | evidence) by enumeration and by variable
 * elimination. Both must give the same numbers (a Vitest check enforces it
 * to 1e-9); they differ only in how much work they do.
 *
 * Enumeration (AIMA's ENUMERATION-ASK)
 *   P(q, e) = sum over every hidden variable of  prod_i P(x_i | parents(x_i))
 *   Walk the variables in topological order; at a hidden one, branch on each
 *   of its states and add up. Time O(n * d^h) for h hidden variables with d
 *   states: it recomputes the same sub-products again and again.
 *
 * Variable elimination
 *   Same sum, but push each sum inside the product as far as it goes:
 *   1. one factor per CPT, with evidence variables fixed (rows dropped);
 *   2. pick a hidden variable (min-neighbours order: the one that touches the
 *      fewest other variables, so the new factor stays small), multiply only
 *      the factors that mention it, sum it out, and put the result back;
 *   3. multiply what is left and normalise.
 *   Each sub-product is computed once. Variables that are neither queried,
 *   observed nor ancestors of those are "barren" and pruned first: summing
 *   out a leaf CPT always gives 1.
 *
 * Underflow: with long chains, products of many small probabilities can
 * underflow to 0. VE rescales every new factor so its largest entry is 1
 * (the scale cancels when we normalise); enumeration's sums here are short.
 *
 * Impossible evidence: if P(evidence) = 0 (e.g. a CPT entry the evidence
 * needs is 0), normalising would divide by zero. Both methods detect it and
 * return `{ impossible: true }` with no distribution.
 */
import { prob, topoOrder, type Evidence, type Network } from './network';

export interface Posterior {
  /** P(query = s | evidence), or null when the evidence is impossible. */
  dist: Float64Array | null;
  impossible: boolean;
  /** Multiplications and additions done: a rough cost measure for the UI. */
  ops: number;
}

export interface VEResult extends Posterior {
  /** Variables in the order they were summed out. */
  order: number[];
  /** Number of entries in the largest factor built (the cost driver). */
  maxFactor: number;
  /** Variables pruned as barren before elimination. */
  pruned: number[];
}

function finish(unnorm: Float64Array, ops: number): Posterior {
  let z = 0;
  for (const v of unnorm) z += v;
  if (!(z > 0) || !Number.isFinite(z)) return { dist: null, impossible: true, ops };
  const dist = new Float64Array(unnorm.length);
  for (let i = 0; i < unnorm.length; i++) dist[i] = unnorm[i] / z;
  return { dist, impossible: false, ops: ops + unnorm.length };
}

// ─────────────────────────── Enumeration ───────────────────────────

export function enumerationAsk(net: Network, query: number, evidence: Evidence): Posterior {
  const order = topoOrder(net);
  const a = new Int32Array(net.vars.length);
  let ops = 0;
  // The query itself is observed: the answer is certain (if possible at all).
  if (evidence.has(query)) {
    const out = new Float64Array(net.vars[query].states.length);
    out[evidence.get(query)!] = 1;
    for (const [x, s] of evidence) a[x] = s;
    // Still check the evidence is possible.
    const pe = enumerateAll(0);
    return pe > 0 ? { dist: out, impossible: false, ops } : { dist: null, impossible: true, ops };
  }

  // sum over the hidden variables from position i on in the order.
  function enumerateAll(i: number): number {
    if (i === order.length) return 1;
    const x = order[i];
    const fixed = evidence.has(x) ? evidence.get(x)! : x === query ? a[x] : -1;
    if (fixed >= 0) {
      a[x] = fixed;
      const p = prob(net, x, fixed, a);
      ops++;
      return p === 0 ? 0 : p * enumerateAll(i + 1);
    }
    let sum = 0;
    for (let s = 0; s < net.vars[x].states.length; s++) {
      a[x] = s;
      const p = prob(net, x, s, a);
      ops += 2;
      if (p !== 0) sum += p * enumerateAll(i + 1);
    }
    return sum;
  }

  for (const [x, s] of evidence) a[x] = s;
  const k = net.vars[query].states.length;
  const unnorm = new Float64Array(k);
  for (let s = 0; s < k; s++) {
    a[query] = s;
    unnorm[s] = enumerateAll(0);
  }
  return finish(unnorm, ops);
}

// ─────────────────────────── Factors ───────────────────────────

/**
 * A factor over some variables: a table of non-negative numbers, one per
 * joint assignment of `vars`, the LAST variable changing fastest.
 */
export interface Factor {
  vars: number[];
  card: number[];
  values: Float64Array;
}

function strides(card: number[]): number[] {
  const s = new Array<number>(card.length);
  let m = 1;
  for (let i = card.length - 1; i >= 0; i--) {
    s[i] = m;
    m *= card[i];
  }
  return s;
}

/** The CPT of x as a factor over (parents..., x), with evidence variables fixed and dropped. */
export function cptFactor(net: Network, x: number, evidence: Evidence): Factor {
  const all = [...net.vars[x].parents, x];
  const vars = all.filter((v) => !evidence.has(v));
  const card = vars.map((v) => net.vars[v].states.length);
  const size = card.reduce((m, c) => m * c, 1);
  const values = new Float64Array(size);
  const a = new Int32Array(net.vars.length);
  for (const [v, s] of evidence) a[v] = s;
  const st = strides(card);
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < vars.length; j++) a[vars[j]] = Math.floor(i / st[j]) % card[j];
    values[i] = prob(net, x, a[x], a);
  }
  return { vars, card, values };
}

/** Pointwise product of two factors. Returns the factor and the work done. */
export function multiply(f: Factor, g: Factor): { f: Factor; ops: number } {
  const vars = [...f.vars];
  const card = [...f.card];
  g.vars.forEach((v, i) => {
    if (!vars.includes(v)) {
      vars.push(v);
      card.push(g.card[i]);
    }
  });
  const size = card.reduce((m, c) => m * c, 1);
  const values = new Float64Array(size);
  const st = strides(card);
  const fs = strides(f.card), gs = strides(g.card);
  const fPos = f.vars.map((v) => vars.indexOf(v));
  const gPos = g.vars.map((v) => vars.indexOf(v));
  const assign = new Int32Array(vars.length);
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < vars.length; j++) assign[j] = Math.floor(i / st[j]) % card[j];
    let fi = 0, gi = 0;
    for (let j = 0; j < fPos.length; j++) fi += assign[fPos[j]] * fs[j];
    for (let j = 0; j < gPos.length; j++) gi += assign[gPos[j]] * gs[j];
    values[i] = f.values[fi] * g.values[gi];
  }
  return { f: { vars, card, values }, ops: size };
}

/** Sum a variable out of a factor. */
export function sumOut(f: Factor, x: number): { f: Factor; ops: number } {
  const pos = f.vars.indexOf(x);
  if (pos < 0) return { f, ops: 0 };
  const vars = f.vars.filter((_, i) => i !== pos);
  const card = f.card.filter((_, i) => i !== pos);
  const size = card.reduce((m, c) => m * c, 1);
  const values = new Float64Array(size);
  const st = strides(f.card), outSt = strides(card);
  for (let i = 0; i < f.values.length; i++) {
    let o = 0, jj = 0;
    for (let j = 0; j < f.vars.length; j++) {
      if (j === pos) continue;
      o += (Math.floor(i / st[j]) % f.card[j]) * outSt[jj++];
    }
    values[o] += f.values[i];
  }
  return { f: { vars, card, values }, ops: f.values.length };
}

/** Scale so the largest entry is 1 (guards against underflow; cancels on normalising). */
function rescale(f: Factor): void {
  let m = 0;
  for (const v of f.values) if (v > m) m = v;
  if (m > 0 && m !== 1) for (let i = 0; i < f.values.length; i++) f.values[i] /= m;
}

// ─────────────────────────── Variable elimination ───────────────────────────

/** Variables that matter: the query, the evidence and all their ancestors. The rest are barren. */
export function relevantVars(net: Network, query: number, evidence: Evidence): Set<number> {
  const keep = new Set<number>();
  const stack = [query, ...evidence.keys()];
  while (stack.length) {
    const v = stack.pop()!;
    if (keep.has(v)) continue;
    keep.add(v);
    stack.push(...net.vars[v].parents);
  }
  return keep;
}

/**
 * Min-neighbours elimination order: repeatedly pick the hidden variable with
 * the fewest neighbours in the current interaction graph (variables sharing
 * a factor), then connect its neighbours to each other (the new factor).
 * Ties go to the lower index, so the order is deterministic.
 */
export function minNeighboursOrder(factors: Factor[], hidden: number[]): number[] {
  const nb = new Map<number, Set<number>>();
  const touch = (v: number) => nb.get(v) ?? (nb.set(v, new Set()), nb.get(v)!);
  for (const f of factors) for (const a of f.vars) for (const b of f.vars) if (a !== b) touch(a).add(b);
  const left = new Set(hidden);
  const order: number[] = [];
  while (left.size) {
    let best = -1, bestN = Infinity;
    for (const v of [...left].sort((p, q) => p - q)) {
      const n = nb.get(v)?.size ?? 0;
      if (n < bestN) {
        bestN = n;
        best = v;
      }
    }
    const ns = [...(nb.get(best) ?? [])];
    for (const a of ns) {
      nb.get(a)!.delete(best);
      for (const b of ns) if (a !== b) touch(a).add(b);
    }
    nb.delete(best);
    left.delete(best);
    order.push(best);
  }
  return order;
}

export function variableElimination(net: Network, query: number, evidence: Evidence): VEResult {
  if (evidence.has(query)) {
    // Observed query: certain, if the evidence is possible at all.
    const rest = new Map(evidence);
    rest.delete(query);
    const check = variableElimination(net, query, rest);
    const s = evidence.get(query)!;
    if (check.impossible || !check.dist || check.dist[s] === 0) return { ...check, dist: null, impossible: true };
    const dist = new Float64Array(net.vars[query].states.length);
    dist[s] = 1;
    return { ...check, dist, impossible: false };
  }
  const keep = relevantVars(net, query, evidence);
  const pruned = net.vars.map((_, i) => i).filter((i) => !keep.has(i));
  let factors = [...keep].sort((a, b) => a - b).map((x) => cptFactor(net, x, evidence));
  const hidden = [...keep].filter((v) => v !== query && !evidence.has(v));
  const order = minNeighboursOrder(factors, hidden);
  let ops = 0, maxFactor = 1;
  for (const x of order) {
    const touching = factors.filter((f) => f.vars.includes(x));
    factors = factors.filter((f) => !f.vars.includes(x));
    if (!touching.length) continue;
    let prod = touching[0];
    for (let i = 1; i < touching.length; i++) {
      const r = multiply(prod, touching[i]);
      prod = r.f;
      ops += r.ops;
    }
    maxFactor = Math.max(maxFactor, prod.values.length);
    const r = sumOut(prod, x);
    ops += r.ops;
    rescale(r.f);
    factors.push(r.f);
  }
  // Multiply what is left: factors over the query only, or constants.
  let result: Factor = { vars: [], card: [], values: Float64Array.of(1) };
  for (const f of factors) {
    const r = multiply(result, f);
    result = r.f;
    ops += r.ops;
  }
  maxFactor = Math.max(maxFactor, result.values.length);
  const k = net.vars[query].states.length;
  let unnorm: Float64Array;
  if (result.vars.length === 0) unnorm = new Float64Array(k).fill(result.values[0]);
  else unnorm = result.values;
  const out = finish(unnorm, ops);
  return { ...out, order, maxFactor, pruned };
}

/** Posterior of every variable (observed ones are certain), by either method. */
export function allPosteriors(net: Network, evidence: Evidence, method: 'enumeration' | 've' = 've'): Posterior[] {
  return net.vars.map((_, x) => (method === 've' ? variableElimination(net, x, evidence) : enumerationAsk(net, x, evidence)));
}

/** P(evidence): handy for the "impossible evidence" message and for the UI. */
export function evidenceProbability(net: Network, evidence: Evidence): number {
  const order = topoOrder(net);
  const a = new Int32Array(net.vars.length);
  for (const [x, s] of evidence) a[x] = s;
  const rec = (i: number): number => {
    if (i === order.length) return 1;
    const x = order[i];
    if (evidence.has(x)) return prob(net, x, a[x], a) * rec(i + 1);
    let sum = 0;
    for (let s = 0; s < net.vars[x].states.length; s++) {
      a[x] = s;
      sum += prob(net, x, s, a) * rec(i + 1);
    }
    return sum;
  };
  return rec(0);
}

