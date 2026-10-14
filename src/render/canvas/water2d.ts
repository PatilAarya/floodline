/**
 * Canvas 2D fallback for water: the depth field becomes an image (one pixel
 * per grid cell) coloured by the same token depth ramp as the WebGL shader,
 * and is drawn scaled with smoothing over the relief.
 */
import { mix, type Palette, type RGB } from '../theme';

const BINS = 64;
const MAX_D = 4;

function rampLUT(p: Palette): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(BINS * 4);
  const ss = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const shallow = mix(p.background, p.secondary, 0.55);
  const deep = mix(p.primary, p.text, 0.28);
  const mid = mix(p.accent, p.primary, 0.35);
  for (let i = 0; i < BINS; i++) {
    const d = (i / (BINS - 1)) * MAX_D;
    let c: RGB = mix(shallow, p.secondary, ss(0, 0.35, d));
    c = mix(c, mid, ss(0.25, 1.4, d));
    c = mix(c, deep, ss(1.1, 4, d));
    const a = ss(0.008, 0.1, d) * (0.78 + 0.2 * ss(0.25, 1.4, d));
    lut[i * 4] = c[0] * 255;
    lut[i * 4 + 1] = c[1] * 255;
    lut[i * 4 + 2] = c[2] * 255;
    lut[i * 4 + 3] = a * 255;
  }
  return lut;
}

export class WaterImage {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private img: ImageData | null = null;
  private lut: Uint8ClampedArray | null = null;
  private n = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
  }

  setPalette(p: Palette): void {
    this.lut = rampLUT(p);
  }

  update(depth: Float32Array, n: number): void {
    if (!this.ctx || !this.lut) return;
    if (n !== this.n) {
      this.n = n;
      this.canvas.width = this.canvas.height = n;
      this.img = this.ctx.createImageData(n, n);
    }
    const data = this.img!.data, lut = this.lut;
    for (let k = 0; k < n * n; k++) {
      const d = depth[k];
      const b = d <= 0.008 ? 0 : Math.min(BINS - 1, Math.round((d / MAX_D) * (BINS - 1)));
      const s = b * 4, o = k * 4;
      data[o] = lut[s];
      data[o + 1] = lut[s + 1];
      data[o + 2] = lut[s + 2];
      data[o + 3] = d <= 0.008 ? 0 : lut[s + 3];
    }
    this.ctx.putImageData(this.img!, 0, 0);
  }
}
