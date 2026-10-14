/**
 * Bespoke geometric glyphs, drawn by hand as SVG. They use currentColor so
 * they inherit text colour, and are always paired with a text label or an
 * aria-label: no glyph carries meaning on its own.
 */

const svg = (body: string, vb = '0 0 24 24', extra = '') =>
  `<svg class="glyph" viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"${extra}>${body}</svg>`;

export const glyphs = {
  /** The Floodline mark: an open arch above two water lines. */
  mark: () =>
    svg(
      `<path d="M7 15.5V10a5 5 0 0 1 10 0v5.5" stroke-width="2.2"/>` +
        `<path d="M2.5 17.5c1.9-1.6 3.8-1.6 5.7 0s3.8 1.6 5.7 0 3.8-1.6 5.7 0 1.9 1.1 1.9 1.1" stroke="var(--primary)" stroke-width="2"/>` +
        `<path d="M5 21c1.5-1.2 3-1.2 4.5 0s3 1.2 4.5 0 3-1.2 4.5 0" stroke="var(--primary)" stroke-width="1.6" opacity=".6"/>`,
    ),
  /** Shelter: a small open arch on a ground line. */
  shelter: () => svg(`<path d="M6 19V11a6 6 0 0 1 12 0v8"/><path d="M3.5 19h17"/>`),
  /** Pump: two nested arcs over a stem. */
  pump: () => svg(`<path d="M5 13a7 7 0 0 1 14 0"/><path d="M8.5 13a3.5 3.5 0 0 1 7 0"/><path d="M12 13v7"/>`),
  /** Blocked road: a bar broken in the middle, with offset ends. */
  blocked: () => svg(`<path d="M2.5 12h6.5"/><path d="M15 12h6.5"/><path d="M10.5 8.5l3 7"/><path d="M13.5 8.5l-3 7" opacity=".55"/>`),
  /** Open road: a continuous bar with a centre dash. */
  road: () => svg(`<path d="M2.5 9h19"/><path d="M2.5 15h19"/><path d="M6 12h3M11 12h2M15 12h3" stroke-width="1.2"/>`),
  /** Bridge: a deck over a shallow arch. */
  bridge: () => svg(`<path d="M2.5 10h19"/><path d="M5 10v3M19 10v3"/><path d="M5 13a7 5 0 0 1 14 0"/><path d="M2.5 19c2-1.4 4-1.4 6 0s4 1.4 6 0 4-1.4 6 0" opacity=".6"/>`),
  /** Evacuee group: a filled dot inside a ring. */
  agent: () => svg(`<circle cx="12" cy="12" r="3" fill="currentColor"/><circle cx="12" cy="12" r="7.5"/>`),
  /** Neighbourhood: a hexagonal cell. */
  cell: () => svg(`<path d="M12 3.5l7.4 4.25v8.5L12 20.5l-7.4-4.25v-8.5z"/>`),
  /** Gauge / sensor: a staff with a water level. */
  gauge: () => svg(`<path d="M12 3v18"/><path d="M9 7h3M9 11h3M9 15h3"/><path d="M4 16c2.7-1.6 5.3-1.6 8 0s5.3 1.6 8 0"/>`),
  /** Rain: three slanted strokes. */
  rain: () => svg(`<path d="M8 5l-2 6M13 4l-2.5 8M18 6l-2 6M10.5 14l-2 6M15.5 14l-1.5 5"/>`),
  /** Hazard: a hatched square (density = risk). */
  hazard: () => svg(`<path d="M4 4h16v16H4z"/><path d="M4 12l8-8M4 20L20 4M12 20l8-8" stroke-width="1.2"/>`),
  /** Arrow: a long stem and a narrow head, for "go" links. */
  arrow: () => svg(`<path d="M3 12h17"/><path d="M15 7l5 5-5 5"/>`),
  /** Close: two short crossing strokes, used only beside the word "Close". */
  cross: () => svg(`<path d="M6 6l12 12M18 6L6 18"/>`),
} as const;

export type GlyphName = keyof typeof glyphs;

export function glyph(name: GlyphName): string {
  return glyphs[name]();
}
