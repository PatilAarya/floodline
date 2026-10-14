/**
 * Canvas 2D terrain: a hillshaded relief image built from the heightmap,
 * coloured only from theme tokens. Rebuilt when the palette changes (cheap,
 * via a small colour lookup table) and drawn scaled under the vector layers.
 */
import type { Terrain } from '../../world/types';
import { mix, type Palette, type RGB } from '../theme';

const E_BINS = 28;
const S_BINS = 28;

/** Colour lookup table indexed by [elevation bin][shade bin], RGBA bytes. */
function buildLUT(p: Palette): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(E_BINS * S_BINS * 4);
  // Shadows mix towards the text token, highlights towards the background.
  const shadowK = 0.42, lightK = 1.4;
  for (let e = 0; e < E_BINS; e++) {
    const et = e / (E_BINS - 1);
    // Low land is close to the page background; high ground leans to secondary.
    const base = mix(p.background, p.secondary, 0.1 + 0.55 * Math.pow(et, 0.8));
    for (let s = 0; s < S_BINS; s++) {
      const st = s / (S_BINS - 1); // 0 = full shadow, 1 = full light
      let c: RGB;
      const flat = 0.72;
      if (st < flat) c = mix(base, p.text, (flat - st) * shadowK);
      else c = mix(base, p.background, (st - flat) * lightK);
      const k = (e * S_BINS + s) * 4;
      lut[k] = c[0] * 255;
      lut[k + 1] = c[1] * 255;
      lut[k + 2] = c[2] * 255;
      lut[k + 3] = 255;
    }
  }
  return lut;
}

/**
 * Render the relief at `res` x `res` pixels, sampling heights bilinearly so
 * the image is smoother than the grid. Returns a canvas to draw scaled.
 */
export function buildTerrainImage(t: Terrain, p: Palette, res = Math.min(1024, t.n * 3)): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = res;
  canvas.height = res;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const img = ctx.createImageData(res, res);
  const lut = buildLUT(p);
  const n = t.n, H = t.height;
  const range = Math.max(1e-6, t.maxH - t.minH);

  const at = (fx: number, fy: number) => {
    // Bilinear height lookup in grid space.
    const x = Math.min(n - 1.001, Math.max(0, fx)), y = Math.min(n - 1.001, Math.max(0, fy));
    const i = Math.floor(x), j = Math.floor(y);
    const u = x - i, v = y - j;
    const k = j * n + i;
    return (H[k] * (1 - u) + H[k + 1] * u) * (1 - v) + (H[k + n] * (1 - u) + H[k + n + 1] * u) * v;
  };

  // Light from the north-west, 40 degrees up; vertical exaggeration for legibility.
  const az = (315 * Math.PI) / 180, alt = (40 * Math.PI) / 180;
  const lx = Math.cos(alt) * Math.sin(az), ly = -Math.cos(alt) * Math.cos(az), lz = Math.sin(alt);
  const exag = 3.2;
  const scale = n / res; // grid cells per pixel
  const dpx = t.cell * scale * 2;
  const data = img.data;

  for (let py = 0; py < res; py++) {
    for (let px = 0; px < res; px++) {
      const gx = (px + 0.5) * scale - 0.5, gy = (py + 0.5) * scale - 0.5;
      const h = at(gx, gy);
      const dzdx = ((at(gx + scale, gy) - at(gx - scale, gy)) / dpx) * exag;
      const dzdy = ((at(gx, gy + scale) - at(gx, gy - scale)) / dpx) * exag;
      // Surface normal (-dzdx, -dzdy, 1), normalised; Lambertian shading.
      const inv = 1 / Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1);
      const shade = Math.max(0, (-dzdx * lx - dzdy * ly + lz) * inv);
      const e = Math.min(E_BINS - 1, Math.max(0, Math.round(((h - t.minH) / range) * (E_BINS - 1))));
      const s = Math.min(S_BINS - 1, Math.max(0, Math.round(shade * (S_BINS - 1))));
      const src = (e * S_BINS + s) * 4;
      const dst = (py * res + px) * 4;
      data[dst] = lut[src];
      data[dst + 1] = lut[src + 1];
      data[dst + 2] = lut[src + 2];
      data[dst + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
