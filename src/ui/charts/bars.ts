/**
 * Hand-drawn horizontal bar chart (SVG). Open layout: no box, hairline
 * baseline, mono values at the bar ends. Bars marked `flag` are hatched
 * instead of solid, so the distinction survives greyscale printing.
 */
import { h } from '../dom';

export interface Bar {
  label: string;
  value: number;
  /** Text shown at the end of the bar (defaults to the value). */
  text?: string;
  /** Hatched instead of solid (e.g. "not optimal"). */
  flag?: boolean;
}

let uid = 0;

export function barChart(title: string, bars: Bar[], opts: { width?: number; note?: string } = {}): HTMLElement {
  const W = opts.width ?? 560;
  const rowH = 26, labelW = 150, valueW = 90, top = 6;
  const H = top + bars.length * rowH + 6;
  const max = Math.max(1e-9, ...bars.filter((b) => Number.isFinite(b.value)).map((b) => b.value));
  const id = `hatch-${++uid}`;
  const plotW = W - labelW - valueW;
  const rows = bars
    .map((b, i) => {
      const y = top + i * rowH;
      const w = Number.isFinite(b.value) ? Math.max(1, (b.value / max) * plotW) : 0;
      const fill = b.flag ? `url(#${id})` : 'color-mix(in oklab, var(--primary) 85%, var(--text))';
      const stroke = b.flag ? 'stroke="color-mix(in oklab, var(--accent) 60%, var(--text))" stroke-width="1"' : '';
      return `<g>
        <text x="${labelW - 10}" y="${y + rowH / 2 + 4}" text-anchor="end" class="bar-label">${esc(b.label)}</text>
        <rect x="${labelW}" y="${y + 5}" width="${w.toFixed(1)}" height="${rowH - 10}" fill="${fill}" ${stroke}/>
        <text x="${labelW + w + 8}" y="${y + rowH / 2 + 4}" class="bar-value">${esc(b.text ?? (Number.isFinite(b.value) ? String(b.value) : 'n/a'))}</text>
      </g>`;
    })
    .join('');
  const svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(title)}" style="max-width:${W}px">
    <defs><pattern id="${id}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="color-mix(in oklab, var(--accent) 22%, var(--background))"/><path d="M0 0v6" stroke="color-mix(in oklab, var(--accent) 70%, var(--text))" stroke-width="2"/></pattern></defs>
    <line x1="${labelW}" y1="${top}" x2="${labelW}" y2="${H - 4}" stroke="var(--hairline-strong)"/>
    ${rows}
  </svg>`;
  return h('figure', { class: 'chart' }, h('figcaption', { class: 'chart-title' }, title), h('div', { html: svg }), opts.note ? h('p', { class: 'small muted' }, opts.note) : null);
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
