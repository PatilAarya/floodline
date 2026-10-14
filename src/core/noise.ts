/**
 * Seeded 2D simplex noise (after Stefan Gustavson's public-domain reference)
 * plus fractal helpers. Output of `simplex` is roughly in [-1, 1].
 */
import { Rng } from './rng';

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
// 12 gradient directions, evenly spread.
const GRAD = new Float32Array(24);
for (let i = 0; i < 12; i++) {
  const a = (i / 12) * Math.PI * 2;
  GRAD[i * 2] = Math.cos(a);
  GRAD[i * 2 + 1] = Math.sin(a);
}

export interface Noise2D {
  simplex(x: number, y: number): number;
  /** Fractal Brownian motion: sum of octaves, normalised to about [-1, 1]. */
  fbm(x: number, y: number, octaves?: number, lacunarity?: number, gain?: number): number;
  /** Ridged multifractal in [0, 1]: sharp crests, good for ridgelines. */
  ridged(x: number, y: number, octaves?: number): number;
}

export function createNoise(seed: string): Noise2D {
  const rng = new Rng(`noise::${seed}`);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  const perm = new Uint8Array(512);
  const permMod12 = new Uint8Array(512);
  for (let i = 0; i < 512; i++) {
    perm[i] = p[i & 255];
    permMod12[i] = perm[i] % 12;
  }

  function simplex(xin: number, yin: number): number {
    // Skew input space to find which simplex (triangle) cell we are in.
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    // Which of the two triangles?
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;

    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = permMod12[ii + perm[jj]] * 2;
      t0 *= t0;
      n += t0 * t0 * (GRAD[g] * x0 + GRAD[g + 1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = permMod12[ii + i1 + perm[jj + j1]] * 2;
      t1 *= t1;
      n += t1 * t1 * (GRAD[g] * x1 + GRAD[g + 1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = permMod12[ii + 1 + perm[jj + 1]] * 2;
      t2 *= t2;
      n += t2 * t2 * (GRAD[g] * x2 + GRAD[g + 1] * y2);
    }
    return 70 * n;
  }

  function fbm(x: number, y: number, octaves = 5, lacunarity = 2, gain = 0.5): number {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      // Offset each octave so lattice artefacts don't line up.
      sum += amp * simplex(x * freq + o * 17.31, y * freq - o * 11.07);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  function ridged(x: number, y: number, octaves = 4): number {
    let amp = 0.5, freq = 1, sum = 0, norm = 0, prev = 1;
    for (let o = 0; o < octaves; o++) {
      let n = 1 - Math.abs(simplex(x * freq + o * 5.3, y * freq + o * 9.1));
      n *= n;
      sum += n * amp * prev;
      norm += amp;
      prev = n;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  }

  return { simplex, fbm, ridged };
}

export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
