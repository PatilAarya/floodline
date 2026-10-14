/**
 * Map labels with simple greedy collision avoidance: higher-priority labels
 * are placed first and any later label overlapping a placed one is skipped.
 */
import { fmtInt } from '../../core/units';
import type { World } from '../../world/types';
import { css, mix } from '../theme';
import { FONT_BODY, FONT_MONO, type DrawCtx } from './types';

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function drawLabels(d: DrawCtx, w: World): void {
  const { ctx, cam, pal } = d;
  const placed: Box[] = [];
  const free = (b: Box) => !placed.some((p) => b.x0 < p.x1 && b.x1 > p.x0 && b.y0 < p.y1 && b.y1 > p.y0);
  const halo = css(pal.background, 0.92);

  const text = (s: string, x: number, y: number, font: string, color: string, align: CanvasTextAlign = 'center') => {
    ctx.font = font;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = halo;
    ctx.lineWidth = 3.5;
    ctx.strokeText(s, x, y);
    ctx.fillStyle = color;
    ctx.fillText(s, x, y);
  };

  ctx.save();
  // Shelters first: they matter most.
  const sFont = `600 12px ${FONT_BODY}`;
  for (const sh of w.shelters) {
    const nd = w.graph.nodes[sh.node];
    const [x, y] = cam.toScreen(nd.x, nd.y);
    ctx.font = sFont;
    // Long real names are shortened on the map; the inspector shows them in full.
    const label = sh.name.length > 34 ? sh.name.slice(0, 32) + '…' : sh.name;
    const tw = ctx.measureText(label).width;
    const box = { x0: x + 14, y0: y - 16, x1: x + 18 + tw, y1: y + 12 };
    if (!free(box)) continue;
    placed.push(box);
    text(label, x + 16, y - 6, sFont, css(pal.text), 'left');
    text(`${fmtInt(sh.capacity)} places`, x + 16, y + 7, `400 11px ${FONT_MONO}`, css(mix(pal.text, pal.background, 0.35)), 'left');
  }
  // Subways and underpasses, by street name, when zoomed in.
  if (cam.zoom > 2.2) for (const e of w.graph.edges) {
    if (e.kind !== 'tunnel') continue;
    const A = w.graph.nodes[e.a], B = w.graph.nodes[e.b];
    const [x, y] = cam.toScreen((A.x + B.x) / 2, (A.y + B.y) / 2);
    const label = e.street ? `${e.street} (subway)` : 'Subway';
    ctx.font = `500 11px ${FONT_BODY}`;
    const tw = ctx.measureText(label).width;
    const box = { x0: x - tw / 2, y0: y + 6, x1: x + tw / 2, y1: y + 20 };
    if (!free(box)) continue;
    placed.push(box);
    text(label, x, y + 13, `500 11px ${FONT_BODY}`, css(pal.text));
  }

  // Waterway names along the larger channels (once each, at the midpoint).
  const named = new Set<string>();
  for (const l of w.waterLines) {
    if (!l.name || l.halfWidth < 8 || named.has(l.name) || l.pts.length < 8) continue;
    named.add(l.name);
    const m = Math.floor(l.pts.length / 4) * 2;
    const [x, y] = cam.toScreen(l.pts[m], l.pts[m + 1]);
    const font = `italic 500 12px ${FONT_BODY}`;
    ctx.font = font;
    const tw = ctx.measureText(l.name).width;
    const box = { x0: x - tw / 2, y0: y - 8, x1: x + tw / 2, y1: y + 8 };
    if (!free(box)) continue;
    placed.push(box);
    text(l.name, x, y, font, css(mix(pal.primary, pal.text, 0.55)));
  }

  // Bridges (only when zoomed in enough for the codes to be useful).
  for (const e of w.graph.edges) {
    if (!e.isBridge || (w.source === 'mumbai' && cam.zoom < 1.6)) continue;
    const A = w.graph.nodes[e.a], B = w.graph.nodes[e.b];
    const [x, y] = cam.toScreen((A.x + B.x) / 2, (A.y + B.y) / 2);
    const box = { x0: x - 12, y0: y - 22, x1: x + 12, y1: y - 8 };
    if (!free(box)) continue;
    placed.push(box);
    text(e.name, x, y - 15, `500 11px ${FONT_MONO}`, css(pal.text));
  }

  // Neighbourhoods, most populous first.
  const showPop = cam.zoom > 1.5;
  const hFont = `500 ${cam.zoom > 2.5 ? 13 : 12}px ${FONT_BODY}`;
  const order = [...w.hoods].sort((a, b) => b.population - a.population);
  for (const h of order) {
    const [x, y] = cam.toScreen(h.cx, h.cy);
    if (x < -50 || y < -20 || x > cam.width + 50 || y > cam.height + 20) continue;
    ctx.font = hFont;
    const tw = ctx.measureText(h.name).width;
    const box = { x0: x - tw / 2 - 3, y0: y - 9, x1: x + tw / 2 + 3, y1: y + (showPop ? 20 : 8) };
    if (!free(box)) continue;
    placed.push(box);
    text(h.name, x, y, hFont, css(mix(pal.text, pal.background, 0.2)));
    if (showPop) {
      const sub = w.source === 'mumbai' ? (h.population > 0 ? `${fmtInt(h.population)} at risk` : 'high ground') : h.population > 0 ? fmtInt(h.population) : 'parkland';
      text(sub, x, y + 13, `400 11px ${FONT_MONO}`, css(mix(pal.text, pal.background, 0.42)));
    }
  }
  ctx.restore();
}
