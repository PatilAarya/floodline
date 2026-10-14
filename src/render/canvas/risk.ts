/**
 * Flood-risk overlay: each neighbourhood is hatched with diagonal lines whose
 * DENSITY follows the Bayesian network's P(FloodRisk = high). Sparse hatching
 * = low risk, dense = high; above 2 in 3 the boundary is also drawn heavier.
 * No hue is involved, so it reads the same in greyscale and over the water.
 *
 * The hatching is rendered into an offscreen canvas and reused until the
 * camera or the risk changes, so playback (which redraws every frame) only
 * pays for one drawImage.
 */
import type { World } from '../../world/types';
import { css } from '../theme';
import { hoodPath } from './overlays';
import type { DrawCtx } from './types';

/** Below this probability a neighbourhood is left clear. */
export const RISK_MIN = 0.1;

/** Hatch line opacity: faint for low risk so the map stays readable, darker as risk rises. */
export function hatchAlpha(p: number): number {
  return 0.1 + 0.42 * Math.min(1, Math.max(0, p));
}

/** Hatch spacing in CSS pixels for a probability: about 18 px at 10%, 4 px at 100%. */
export function hatchSpacing(p: number): number {
  return 3.8 + 16 * Math.pow(1 - Math.min(1, Math.max(0, p)), 1.3);
}

export class RiskLayer {
  private pHigh: Float32Array | null = null;
  private version = 0;
  private key = '';
  private cache: HTMLCanvasElement | null = null;

  /** P(FloodRisk = high) per neighbourhood, or null to hide. */
  setRisk(pHigh: Float32Array | null): void {
    this.pHigh = pHigh;
    this.version++;
  }

  get(h: number): number {
    return this.pHigh ? this.pHigh[h] : NaN;
  }

  draw(d: DrawCtx, w: World): void {
    if (!this.pHigh) return;
    const { ctx, cam } = d;
    const W = ctx.canvas.width, H = ctx.canvas.height;
    const dpr = W / Math.max(1, cam.width);
    const [ox, oy] = cam.toScreen(0, 0);
    const key = `${W}x${H}|${cam.scale.toFixed(6)}|${ox.toFixed(2)}|${oy.toFixed(2)}|${this.version}`;
    if (key !== this.key || !this.cache) {
      this.key = key;
      this.cache ??= document.createElement('canvas');
      if (this.cache.width !== W || this.cache.height !== H) {
        this.cache.width = W;
        this.cache.height = H;
      }
      const c = this.cache.getContext('2d');
      if (!c) return;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, W, H);
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.render({ ...d, ctx: c }, w);
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.cache, 0, 0);
    ctx.restore();
  }

  private render(d: DrawCtx, w: World): void {
    const { ctx, cam, pal } = d;
    const p = this.pHigh!;
    for (const hd of w.hoods) {
      const pr = p[hd.id];
      if (!(pr >= RISK_MIN)) continue;
      // Screen bounding box, clipped to the viewport.
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of hd.polygon) {
        const [sx, sy] = cam.toScreen(x, y);
        if (sx < x0) x0 = sx;
        if (sy < y0) y0 = sy;
        if (sx > x1) x1 = sx;
        if (sy > y1) y1 = sy;
      }
      x0 = Math.max(x0, 0);
      y0 = Math.max(y0, 0);
      x1 = Math.min(x1, cam.width);
      y1 = Math.min(y1, cam.height);
      if (x1 <= x0 || y1 <= y0) continue;
      const path = hoodPath(d, hd.polygon);
      ctx.save();
      ctx.clip(path);
      const s = hatchSpacing(pr);
      // Lines x - y = c, spaced s apart along x, anchored to the screen so
      // neighbouring areas line up.
      const hatch = new Path2D();
      const start = Math.floor((x0 - y1) / s) * s;
      for (let c = start; c <= x1 - y0; c += s) {
        hatch.moveTo(c + y0, y0);
        hatch.lineTo(c + y1, y1);
      }
      ctx.strokeStyle = css(pal.text, hatchAlpha(pr));
      ctx.lineWidth = 0.9;
      ctx.stroke(hatch);
      ctx.restore();
      if (pr >= 2 / 3) {
        ctx.strokeStyle = css(pal.text, 0.55);
        ctx.lineWidth = 1.6;
        ctx.stroke(path);
      }
    }
  }
}
