/**
 * Contour lines by marching squares over the heightmap. Produces flat
 * segment lists in world coordinates (computed once per world) that the
 * renderer strokes with the current camera transform.
 */
import type { Terrain } from '../../world/types';

export interface Contours {
  minor: Float32Array;
  major: Float32Array;
  interval: number;
}

export function buildContours(t: Terrain, interval = 2.5, majorEvery = 4): Contours {
  const n = t.n, H = t.height, c = t.cell;
  const minor: number[] = [];
  const major: number[] = [];
  const first = Math.ceil(t.minH / interval) * interval;

  for (let level = first, idx = Math.round(first / interval); level <= t.maxH; level += interval, idx++) {
    const out = idx % majorEvery === 0 ? major : minor;
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const k = j * n + i;
        const a = H[k], b = H[k + 1], d = H[k + n], e = H[k + n + 1];
        // Corner bits: 1 top-left, 2 top-right, 4 bottom-right, 8 bottom-left.
        const code = (a >= level ? 1 : 0) | (b >= level ? 2 : 0) | (e >= level ? 4 : 0) | (d >= level ? 8 : 0);
        if (code === 0 || code === 15) continue;
        // Cell-centre world coordinates of the four corners.
        const x0 = (i + 0.5) * c, y0 = (j + 0.5) * c, x1 = x0 + c, y1 = y0 + c;
        const lerp = (h0: number, h1: number) => (level - h0) / (h1 - h0 || 1e-9);
        const top = () => [x0 + lerp(a, b) * c, y0];
        const right = () => [x1, y0 + lerp(b, e) * c];
        const bottom = () => [x0 + lerp(d, e) * c, y1];
        const left = () => [x0, y0 + lerp(a, d) * c];
        const seg = (p: number[], q: number[]) => out.push(p[0], p[1], q[0], q[1]);
        switch (code) {
          case 1: case 14: seg(left(), top()); break;
          case 2: case 13: seg(top(), right()); break;
          case 3: case 12: seg(left(), right()); break;
          case 4: case 11: seg(right(), bottom()); break;
          case 6: case 9: seg(top(), bottom()); break;
          case 7: case 8: seg(left(), bottom()); break;
          case 5: seg(left(), top()); seg(right(), bottom()); break; // saddles: pick one resolution
          case 10: seg(top(), right()); seg(bottom(), left()); break;
        }
      }
    }
  }
  return { minor: Float32Array.from(minor), major: Float32Array.from(major), interval };
}
