/**
 * Hand-drawn SVG charts for the Experiments page. No hue: the three
 * strategies are told apart by MARKER SHAPE and weight (open circle, open
 * square, filled diamond), so the charts read the same in greyscale.
 *
 *   boxStrip     one row per strategy: whiskers (min to max), a box for the
 *                middle half, a heavy tick at the median, and every seed as a dot
 *   pairedSeeds  one column per seed, its strategies joined by a hairline:
 *                the paired view (same storm, different plans)
 *   diffStrip    per-seed differences between two strategies around zero
 */
import { quantile } from '../../core/stats';
import { h } from '../dom';

export type Marker = 'circle' | 'square' | 'diamond';

export interface Series {
  label: string;
  marker: Marker;
  values: number[];
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function markerPath(m: Marker, x: number, y: number, r: number): string {
  if (m === 'circle') return `<circle class="mk mk-circle" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}"/>`;
  if (m === 'square') return `<rect class="mk mk-square" x="${(x - r * 0.9).toFixed(1)}" y="${(y - r * 0.9).toFixed(1)}" width="${(r * 1.8).toFixed(1)}" height="${(r * 1.8).toFixed(1)}"/>`;
  return `<path class="mk mk-diamond" d="M${x.toFixed(1)} ${(y - r * 1.25).toFixed(1)}l${(r * 1.15).toFixed(1)} ${(r * 1.25).toFixed(1)}l${(-r * 1.15).toFixed(1)} ${(r * 1.25).toFixed(1)}l${(-r * 1.15).toFixed(1)} ${(-r * 1.25).toFixed(1)}z"/>`;
}

/** Legend item as inline SVG. */
export function markerSwatch(m: Marker): string {
  return `<svg viewBox="0 0 16 16" width="16" height="16" class="exp-chart" aria-hidden="true">${markerPath(m, 8, 8, 4.5)}</svg>`;
}

function svg(W: number, H: number, label: string, body: string): SVGSVGElement {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', `0 0 ${W} ${H}`);
  s.setAttribute('role', 'img');
  s.setAttribute('aria-label', label);
  s.setAttribute('class', 'exp-chart');
  s.innerHTML = body;
  return s;
}

function ticks(lo: number, hi: number, n = 5): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / n;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * p).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

/** Deterministic small offset for dot i (so the jitter never changes between renders). */
const jitter = (i: number) => (((i * 2654435761) >>> 0) / 4294967296 - 0.5) * 2;

export function boxStrip(title: string, rows: Series[], o: { format: (v: number) => string; note?: string; better?: 'low' | 'high' }): HTMLElement {
  const W = 680, rowH = 46, L = 168, R = 24, T = 8, B = 30;
  const H = T + rows.length * rowH + B;
  const all = rows.flatMap((r) => r.values).filter(Number.isFinite);
  let lo = all.length ? Math.min(...all) : 0, hi = all.length ? Math.max(...all) : 1;
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  const pad = (hi - lo) * 0.06;
  lo -= pad;
  hi += pad;
  const x = (v: number) => L + ((v - lo) / (hi - lo)) * (W - L - R);
  const parts: string[] = [];
  for (const t of ticks(lo, hi)) parts.push(`<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="${T}" y2="${H - B}"/><text class="tick" x="${x(t)}" y="${H - B + 16}" text-anchor="middle">${o.format(t)}</text>`);
  rows.forEach((r, i) => {
    const cy = T + i * rowH + rowH / 2;
    const v = r.values.filter(Number.isFinite);
    parts.push(`<text class="row-label" x="${L - 14}" y="${cy + 4}" text-anchor="end">${esc(r.label)}</text>`);
    if (!v.length) {
      parts.push(`<text class="tick" x="${L}" y="${cy + 4}">no value (never reached)</text>`);
      return;
    }
    const q0 = Math.min(...v), q1 = quantile(v, 0.25), q2 = quantile(v, 0.5), q3 = quantile(v, 0.75), q4 = Math.max(...v);
    parts.push(`<line class="whisker" x1="${x(q0)}" x2="${x(q4)}" y1="${cy}" y2="${cy}"/>`);
    parts.push(`<line class="whisker" x1="${x(q0)}" x2="${x(q0)}" y1="${cy - 6}" y2="${cy + 6}"/><line class="whisker" x1="${x(q4)}" x2="${x(q4)}" y1="${cy - 6}" y2="${cy + 6}"/>`);
    parts.push(`<rect class="box" x="${x(q1)}" y="${cy - 12}" width="${Math.max(1, x(q3) - x(q1))}" height="24"/>`);
    v.forEach((val, k) => parts.push(markerPath(r.marker, x(val), cy + jitter(k) * 8, 3.2)));
    parts.push(`<line class="median" x1="${x(q2)}" x2="${x(q2)}" y1="${cy - 15}" y2="${cy + 15}"/>`);
  });
  const caption = `${title}${o.better ? ` (${o.better === 'low' ? 'lower' : 'higher'} is better)` : ''}`;
  const label = `${caption}. ${rows.map((r) => `${r.label}: median ${o.format(quantile(r.values, 0.5))}`).join('; ')}.`;
  return h('figure', { class: 'chart exp-figure' }, h('figcaption', { class: 'chart-title' }, caption), svg(W, H, label, parts.join('')), o.note ? h('p', { class: 'small muted' }, o.note) : null);
}

export function pairedSeeds(title: string, seeds: string[], series: Series[], o: { format: (v: number) => string; sortBy?: number; note?: string }): HTMLElement {
  const n = seeds.length;
  const W = Math.max(680, 60 + n * 13), H = 280, L = 58, R = 16, T = 12, B = 34;
  const order = [...Array(n).keys()];
  const key = series[o.sortBy ?? 0]?.values ?? [];
  order.sort((a, b) => (key[a] ?? 0) - (key[b] ?? 0) || a - b);
  const all = series.flatMap((s) => s.values).filter(Number.isFinite);
  let lo = all.length ? Math.min(...all) : 0, hi = all.length ? Math.max(...all) : 1;
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  const pad = (hi - lo) * 0.06;
  lo -= pad;
  hi += pad;
  const x = (k: number) => L + (n <= 1 ? 0.5 : k / (n - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const parts: string[] = [];
  for (const t of ticks(lo, hi)) parts.push(`<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${o.format(t)}</text>`);
  order.forEach((s, k) => {
    const vals = series.map((sr) => sr.values[s]).filter(Number.isFinite);
    if (vals.length > 1) parts.push(`<line class="pair" x1="${x(k)}" x2="${x(k)}" y1="${y(Math.min(...vals))}" y2="${y(Math.max(...vals))}"/>`);
  });
  for (const sr of series) order.forEach((s, k) => Number.isFinite(sr.values[s]) && parts.push(markerPath(sr.marker, x(k), y(sr.values[s]), 3.4)));
  parts.push(`<text class="tick" x="${(L + W - R) / 2}" y="${H - 6}" text-anchor="middle">storms (seeds), sorted by ${esc(series[o.sortBy ?? 0]?.label ?? '')}</text>`);
  const label = `${title}: ${n} seeds, each a vertical line joining the three strategies.`;
  return h('figure', { class: 'chart exp-figure' }, h('figcaption', { class: 'chart-title' }, title), h('div', { class: 'exp-scroll' }, svg(W, H, label, parts.join(''))), o.note ? h('p', { class: 'small muted' }, o.note) : null);
}

export function diffStrip(title: string, diffs: number[], o: { format: (v: number) => string; good: string; bad: string; marker: Marker }): HTMLElement {
  const W = 680, H = 92, L = 24, R = 24, cy = 40;
  const v = diffs.filter(Number.isFinite);
  const m = Math.max(1e-9, ...v.map(Math.abs)) * 1.08;
  const x = (d: number) => L + ((d + m) / (2 * m)) * (W - L - R);
  const parts: string[] = [];
  parts.push(`<rect class="good-side" x="${x(0)}" y="${cy - 22}" width="${W - R - x(0)}" height="44"/>`);
  parts.push(`<line class="zero" x1="${x(0)}" x2="${x(0)}" y1="${cy - 26}" y2="${cy + 26}"/>`);
  v.forEach((d, k) => parts.push(markerPath(o.marker, x(d), cy + jitter(k) * 12, 3.2)));
  parts.push(`<text class="tick" x="${x(0) + 8}" y="${H - 6}">${esc(o.good)} →</text><text class="tick" x="${x(0) - 8}" y="${H - 6}" text-anchor="end">← ${esc(o.bad)}</text>`);
  parts.push(`<text class="tick" x="${L}" y="${cy + 4}">${o.format(-m)}</text><text class="tick" x="${W - R}" y="${cy + 4}" text-anchor="end">${o.format(m)}</text>`);
  return h('figure', { class: 'chart exp-figure' }, h('figcaption', { class: 'chart-title' }, title), svg(W, H, `${title}: ${v.filter((d) => d > 0).length} seeds on the better side, ${v.filter((d) => d < 0).length} on the worse side.`, parts.join('')));
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
