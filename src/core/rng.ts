/**
 * Seeded pseudo-random numbers. Everything random in Floodline flows from
 * one seed string, so a URL reproduces the exact same city and flood.
 *
 * - cyrb128 hashes a string into four 32-bit words (seed material).
 * - sfc32 ("Small Fast Counting") is the generator: 128-bit state, passes
 *   PractRand to large sizes, and is trivially fast in JS.
 * - mulberry32 is a tiny one-word generator, used for quick derived streams.
 *
 * `fork(label)` derives an independent stream from the same seed, so adding
 * a random call in terrain code does not shift every road and shelter.
 */

export function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

export function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  readonly seed: string;
  private next01: () => number;

  constructor(seed: string | number) {
    this.seed = String(seed);
    const [a, b, c, d] = cyrb128(this.seed);
    this.next01 = sfc32(a, b, c, d);
    // Discard the first few outputs; sfc32 mixes its state in ~12 steps.
    for (let i = 0; i < 12; i++) this.next01();
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.next01();
  }

  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next01();
  }

  /** Integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next01() * (hi - lo + 1));
  }

  bool(p = 0.5): boolean {
    return this.next01() < p;
  }

  /** Standard normal via Box-Muller. */
  normal(mean = 0, sd = 1): number {
    let u = 0;
    while (u === 0) u = this.next01();
    const v = this.next01();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next01() * arr.length)];
  }

  /** Fisher-Yates shuffle, in place. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next01() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /** An independent, reproducible stream derived from this seed and a label. */
  fork(label: string): Rng {
    return new Rng(`${this.seed}::${label}`);
  }
}

/** A short random seed for the "Random seed" button (not reproducible by design). */
export function randomSeedString(): string {
  const words = ['ash', 'bay', 'cove', 'dale', 'elm', 'fen', 'glen', 'holm', 'isle', 'jade', 'kiln', 'lea', 'mere', 'ness', 'oak', 'pool', 'quay', 'rill', 'sike', 'tarn', 'vale', 'weir', 'yew'];
  const r = Math.random;
  return `${words[Math.floor(r() * words.length)]}-${words[Math.floor(r() * words.length)]}-${Math.floor(r() * 900 + 100)}`;
}
