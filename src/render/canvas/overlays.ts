/**
 * Static overlays: river ribbon, neighbourhood boundaries, shelters and the
 * selection highlight. Coordinates are converted with the camera each frame.
 */
import { clamp } from '../../core/units';
import type { Contours } from './contours';
import type { World } from '../../world/types';
import { css, mix } from '../theme';
import type { DrawCtx } from './types';

export function drawContours(d: DrawCtx, c: Contours): void {
  const { ctx, cam, pal } = d;
  const stroke = (segs: Float32Array, alpha: number, width: number) => {
    const p = new Path2D();
    for (let i = 0; i < segs.length; i += 4) {
      const [x0, y0] = cam.toScreen(segs[i], segs[i + 1]);
      const [x1, y1] = cam.toScreen(segs[i + 2], segs[i + 3]);
      p.moveTo(x0, y0);
      p.lineTo(x1, y1);
    }
    ctx.strokeStyle = css(pal.text, alpha);
    ctx.lineWidth = width;
    ctx.stroke(p);
  };
  ctx.save();
  // Minor contours fade out when zoomed out, so the map doesn't get noisy.
  const minorAlpha = clamp((cam.zoom - 0.8) * 0.08, 0.035, 0.1);
  stroke(c.minor, minorAlpha, 0.6);
  stroke(c.major, 0.16, 0.9);
  ctx.restore();
}

/** Waterways as ribbons of their channel width (crisp banks at any zoom). */
export function drawRiver(d: DrawCtx, w: World): void {
  const { ctx, cam, pal } = d;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const line of w.waterLines) {
    const p = new Path2D();
    for (let i = 0; i < line.pts.length; i += 2) {
      const [x, y] = cam.toScreen(line.pts[i], line.pts[i + 1]);
      if (i === 0) p.moveTo(x, y);
      else p.lineTo(x, y);
    }
    const hw = line.halfWidth;
    ctx.strokeStyle = css(mix(pal.background, pal.primary, 0.5));
    ctx.lineWidth = Math.max(1.2, 2 * hw * 1.25 * cam.scale);
    ctx.stroke(p);
    ctx.strokeStyle = css(mix(pal.secondary, pal.primary, 0.75));
    ctx.lineWidth = Math.max(0.9, 2 * hw * 0.85 * cam.scale);
    ctx.stroke(p);
    if (hw >= 15) {
      ctx.strokeStyle = css(mix(pal.primary, pal.text, 0.25));
      ctx.lineWidth = Math.max(0.6, 2 * hw * 0.35 * cam.scale);
      ctx.stroke(p);
    }
  }
  ctx.restore();
}

export function hoodPath(d: DrawCtx, poly: [number, number][]): Path2D {
  const p = new Path2D();
  poly.forEach(([x, y], i) => {
    const [sx, sy] = d.cam.toScreen(x, y);
    if (i === 0) p.moveTo(sx, sy);
    else p.lineTo(sx, sy);
  });
  p.closePath();
  return p;
}

export function drawHoods(d: DrawCtx, w: World, selected = -1, hovered = -1): void {
  const { ctx, pal } = d;
  ctx.save();
  if (hovered >= 0 && hovered !== selected && w.hoods[hovered]) {
    ctx.fillStyle = css(pal.text, 0.05);
    ctx.fill(hoodPath(d, w.hoods[hovered].polygon));
  }
  ctx.setLineDash([2, 3]);
  ctx.strokeStyle = css(pal.text, 0.28);
  ctx.lineWidth = 1;
  for (const h of w.hoods) ctx.stroke(hoodPath(d, h.polygon));
  ctx.setLineDash([]);
  if (selected >= 0 && w.hoods[selected]) {
    const p = hoodPath(d, w.hoods[selected].polygon);
    ctx.fillStyle = css(pal.primary, 0.12);
    ctx.fill(p);
    ctx.strokeStyle = css(mix(pal.primary, pal.text, 0.3));
    ctx.lineWidth = 2;
    ctx.stroke(p);
  }
  ctx.restore();
}

/** Shelter glyph: a small open arch on a ground line, with a halo. */
export function shelterGlyph(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  ctx.beginPath();
  ctx.moveTo(x - 0.55 * s, y + 0.5 * s);
  ctx.lineTo(x - 0.55 * s, y - 0.05 * s);
  ctx.arc(x, y - 0.05 * s, 0.55 * s, Math.PI, 0);
  ctx.lineTo(x + 0.55 * s, y + 0.5 * s);
  ctx.moveTo(x - 0.85 * s, y + 0.5 * s);
  ctx.lineTo(x + 0.85 * s, y + 0.5 * s);
}

export function drawShelters(d: DrawCtx, w: World, selected = -1): void {
  const { ctx, cam, pal } = d;
  const s = clamp(13 * Math.sqrt(cam.zoom), 13, 26);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const sh of w.shelters) {
    const nd = w.graph.nodes[sh.node];
    const [x, y] = cam.toScreen(nd.x, nd.y);
    const yy = y - s * 0.35;
    // Halo
    shelterGlyph(ctx, x, yy, s);
    ctx.strokeStyle = css(pal.background);
    ctx.lineWidth = 6;
    ctx.stroke();
    shelterGlyph(ctx, x, yy, s);
    ctx.strokeStyle = css(pal.text);
    ctx.lineWidth = sh.id === selected ? 3 : 2.2;
    ctx.stroke();
    // Low-ground shelters get a dashed ring: a warning by pattern, not hue.
    if (sh.lowGround) {
      ctx.setLineDash([2, 2.5]);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(x, yy, s * 1.05, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (sh.id === selected) {
      ctx.strokeStyle = css(pal.primary);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, yy, s * 1.3, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Highlight one road edge (selection), following its real geometry. */
export function drawEdgeHighlight(d: DrawCtx, w: World, edge: number): void {
  const e = w.graph.edges[edge];
  if (!e) return;
  const { ctx, cam, pal } = d;
  const path = new Path2D();
  const A = w.graph.nodes[e.a], B = w.graph.nodes[e.b];
  const pts: [number, number][] = [[A.x, A.y]];
  for (let i = 0; i < e.geom.length; i += 2) pts.push([e.geom[i], e.geom[i + 1]]);
  pts.push([B.x, B.y]);
  pts.forEach(([x, y], i) => {
    const [sx, sy] = cam.toScreen(x, y);
    if (i === 0) path.moveTo(sx, sy);
    else path.lineTo(sx, sy);
  });
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Wide soft glow, a background casing, then a thick primary core.
  ctx.strokeStyle = css(pal.primary, 0.3);
  ctx.lineWidth = 16;
  ctx.stroke(path);
  ctx.strokeStyle = css(pal.background);
  ctx.lineWidth = 7;
  ctx.stroke(path);
  ctx.strokeStyle = css(mix(pal.primary, pal.text, 0.2));
  ctx.lineWidth = 4;
  ctx.stroke(path);
  ctx.strokeStyle = css(pal.text);
  ctx.lineWidth = 2;
  for (const [x, y] of [pts[0], pts[pts.length - 1]]) {
    const [sx, sy] = cam.toScreen(x, y);
    ctx.beginPath();
    ctx.arc(sx, sy, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = css(pal.background);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

let mangroveTile: { key: string; tile: HTMLCanvasElement } | null = null;

/** Mangroves and wetlands: a stipple fill (pattern, not hue), outlined lightly. */
export function drawWaterAreas(d: DrawCtx, w: World): void {
  const { ctx, cam, pal } = d;
  if (!w.waterAreas.length) return;
  const key = pal.primary.join(',');
  if (!mangroveTile || mangroveTile.key !== key) {
    const tile = document.createElement('canvas');
    tile.width = tile.height = 7;
    const t = tile.getContext('2d')!;
    t.fillStyle = css(mix(pal.primary, pal.text, 0.35), 0.55);
    t.fillRect(1, 1, 1.4, 1.4);
    t.fillRect(4.5, 4.5, 1.4, 1.4);
    mangroveTile = { key, tile };
  }
  const pattern = ctx.createPattern(mangroveTile.tile, 'repeat');
  ctx.save();
  for (const a of w.waterAreas) {
    if (a.kind === 'water') continue;
    const p = new Path2D();
    for (const r of a.rings) {
      for (let i = 0; i < r.length; i += 2) {
        const [x, y] = cam.toScreen(r[i], r[i + 1]);
        if (i === 0) p.moveTo(x, y);
        else p.lineTo(x, y);
      }
      p.closePath();
    }
    if (pattern) {
      ctx.fillStyle = pattern;
      ctx.fill(p, 'evenodd');
    }
    ctx.strokeStyle = css(pal.primary, 0.35);
    ctx.lineWidth = 0.8;
    ctx.stroke(p);
  }
  ctx.restore();
}
