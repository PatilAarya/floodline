/**
 * Canvas/WebGL side of the design system. Reads the five CSS colour tokens at
 * runtime and derives every other shade by mixing in OKLab, the same space the
 * CSS uses (color-mix(in oklab, ...)), so canvas and DOM shades agree.
 *
 */

/** sRGB colour, channels in 0..1. */
export type RGB = readonly [number, number, number];

export interface Palette {
  text: RGB;
  background: RGB;
  primary: RGB;
  secondary: RGB;
  accent: RGB;
}

const TOKENS = ['text', 'background', 'primary', 'secondary', 'accent'] as const;
type TokenName = (typeof TOKENS)[number];

// Fallbacks are the token values themselves, used only if CSS can't be read.
const FALLBACK: Record<TokenName, string> = { text: '#101816', background: '#f9fbfb', primary: '#6c998d', secondary: '#a8b1c2', accent: '#8a8ead' };

export function parseColor(input: string): RGB | null {
  const s = input.trim().toLowerCase();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
  if (m) return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255];
  return null;
}

export function readPalette(el: Element = document.documentElement): Palette {
  const cs = getComputedStyle(el);
  const out = {} as Record<TokenName, RGB>;
  for (const t of TOKENS) out[t] = parseColor(cs.getPropertyValue(`--${t}`)) ?? parseColor(FALLBACK[t])!;
  return out;
}

// ── OKLab conversion (Björn Ottosson's reference matrices) ──

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

export function rgbToOklab(c: RGB): [number, number, number] {
  const r = toLinear(c[0]), g = toLinear(c[1]), b = toLinear(c[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToRgb(lab: readonly [number, number, number]): RGB {
  const [L, A, B] = lab;
  const l = Math.pow(L + 0.3963377774 * A + 0.2158037573 * B, 3);
  const m = Math.pow(L - 0.1055613458 * A - 0.0638541728 * B, 3);
  const s = Math.pow(L - 0.0894841775 * A - 1.291485548 * B, 3);
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const b = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  const cl = (v: number) => Math.min(1, Math.max(0, toGamma(Math.min(1, Math.max(0, v)))));
  return [cl(r), cl(g), cl(b)];
}

/** Mix like color-mix(in oklab, a (1-t), b t). */
export function mix(a: RGB, b: RGB, t: number): RGB {
  const la = rgbToOklab(a), lb = rgbToOklab(b);
  return oklabToRgb([la[0] + (lb[0] - la[0]) * t, la[1] + (lb[1] - la[1]) * t, la[2] + (lb[2] - la[2]) * t]);
}

/** Relative luminance (WCAG), useful for greyscale-safety checks. */
export function luminance(c: RGB): number {
  return 0.2126 * toLinear(c[0]) + 0.7152 * toLinear(c[1]) + 0.0722 * toLinear(c[2]);
}

export function css(c: RGB, alpha = 1): string {
  const r = Math.round(c[0] * 255), g = Math.round(c[1] * 255), b = Math.round(c[2] * 255);
  return alpha >= 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${Math.max(0, alpha).toFixed(3)})`;
}

export function lerpPalette(a: Palette, b: Palette, t: number): Palette {
  const out = {} as Palette;
  for (const k of TOKENS) (out as unknown as Record<TokenName, RGB>)[k] = mix(a[k], b[k], t);
  return out;
}

/**
 * Holds the palette read from CSS. The site has one (light) theme, so this is
 * read once; `refresh()` re-reads it if tokens ever change at runtime, and
 * subscribers get told so they can redraw.
 */
class PaletteSource {
  private current: Palette | null = null;
  private listeners = new Set<(p: Palette) => void>();

  get(): Palette {
    if (!this.current) this.current = readPalette();
    return this.current;
  }

  refresh(): void {
    this.current = readPalette();
    for (const fn of [...this.listeners]) fn(this.current);
  }

  subscribe(fn: (p: Palette) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const paletteAnimator = new PaletteSource();
