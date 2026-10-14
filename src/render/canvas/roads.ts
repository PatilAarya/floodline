/**
 * Road network. States are told apart without colour hue:
 *   open      solid line, weight by class (arterial thicker)
 *   degraded  thinner, short dashes, in accent ink
 *   blocked   broken long dashes over a cross-hatched halo that slowly pulses
 *   bridge    an outlined deck with end ticks
 *   flyover   an outlined deck without ticks (never floods)
 *   subway    a dotted core (floods first)
 *   route     thick, solid, glowing primary (drawn by drawRoute)
 * Every state differs in pattern or weight, so it reads in greyscale too.
 *
 * Performance: paths are built once in world coordinates and stroked under
 * the camera transform, so panning and zooming never rebuild geometry.
 * They are rebuilt only when road states change.
 */
import { clamp } from '../../core/units';
import type { Graph, RoadEdge, World } from '../../world/types';
import type { Camera } from '../camera';
import { css, mix } from '../theme';
import { EdgeState, type DrawCtx } from './types';

/** Add an edge's full polyline (a, interior points, b) to a path. */
export function edgeToPath(p: Path2D | CanvasRenderingContext2D, g: Graph, e: RoadEdge, reverse = false): void {
  const A = g.nodes[reverse ? e.b : e.a], B = g.nodes[reverse ? e.a : e.b];
  p.moveTo(A.x, A.y);
  const gm = e.geom;
  if (!reverse) for (let i = 0; i < gm.length; i += 2) p.lineTo(gm[i], gm[i + 1]);
  else for (let i = gm.length - 2; i >= 0; i -= 2) p.lineTo(gm[i], gm[i + 1]);
  p.lineTo(B.x, B.y);
}

/** Use world coordinates for subsequent drawing (1 unit = 1 metre). */
export function worldTransform(ctx: CanvasRenderingContext2D, cam: Camera, dpr: number): void {
  const s = cam.scale;
  ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (cam.width / 2 - cam.cx * s), dpr * (cam.height / 2 - cam.cy * s));
}

interface Paths {
  localOpen: Path2D;
  artOpen: Path2D;
  degraded: Path2D;
  blocked: Path2D;
  bridge: Path2D;
  bridgeBlocked: Path2D;
  flyover: Path2D;
  tunnel: Path2D;
}

export class RoadLayer {
  private world: World;
  private paths: Paths | null = null;
  private key = -1;
  private minor: Path2D | null = null;
  private hatch: { tile: HTMLCanvasElement; key: string } | null = null;

  constructor(world: World) {
    this.world = world;
    if (world.minorStreets.length) {
      const p = new Path2D();
      for (const s of world.minorStreets) {
        p.moveTo(s[0], s[1]);
        for (let i = 2; i < s.length; i += 2) p.lineTo(s[i], s[i + 1]);
      }
      this.minor = p;
    }
  }

  /** Rebuild paths if road states changed. Returns true if anything changed. */
  update(state?: Uint8Array): boolean {
    let key = 0;
    if (state) for (let i = 0; i < state.length; i++) if (state[i]) key = (key * 31 + i * 3 + state[i]) | 0;
    if (this.paths && key === this.key) return false;
    this.key = key;
    const g = this.world.graph;
    const P: Paths = { localOpen: new Path2D(), artOpen: new Path2D(), degraded: new Path2D(), blocked: new Path2D(), bridge: new Path2D(), bridgeBlocked: new Path2D(), flyover: new Path2D(), tunnel: new Path2D() };
    for (const e of g.edges) {
      const s = state ? state[e.id] : EdgeState.Open;
      let p: Path2D;
      if (e.kind === 'bridge') p = s === EdgeState.Blocked ? P.bridgeBlocked : P.bridge;
      else if (s === EdgeState.Blocked) p = P.blocked;
      else if (s === EdgeState.Degraded) p = P.degraded;
      else if (e.kind === 'flyover') p = P.flyover;
      else if (e.kind === 'tunnel') p = P.tunnel;
      else p = e.cls === 'arterial' ? P.artOpen : P.localOpen;
      edgeToPath(p, g, e);
    }
    this.paths = P;
    return true;
  }

  /** Static layer: everything except the pulsing halo. */
  draw(d: DrawCtx, dpr: number, showMinor: boolean): void {
    if (!this.paths) this.update();
    const P = this.paths!;
    const { ctx, cam, pal } = d;
    const px = 1 / cam.scale; // one CSS pixel in world units
    const z = clamp(Math.sqrt(cam.zoom), 1, 3.2);
    ctx.save();
    worldTransform(ctx, cam, dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (showMinor && this.minor) {
      ctx.strokeStyle = css(pal.text, clamp(0.06 + 0.04 * cam.zoom, 0.07, 0.22));
      ctx.lineWidth = 0.7 * px * Math.min(2, z);
      ctx.stroke(this.minor);
    }

    const casing = css(pal.background, 0.85);
    ctx.strokeStyle = casing;
    ctx.lineWidth = (1.1 * z + 1.6) * px;
    ctx.stroke(P.localOpen);
    ctx.lineWidth = (2.1 * z + 2.2) * px;
    ctx.stroke(P.artOpen);
    ctx.stroke(P.tunnel);

    ctx.strokeStyle = css(mix(pal.text, pal.background, 0.45));
    ctx.lineWidth = 1.1 * z * px;
    ctx.stroke(P.localOpen);
    ctx.strokeStyle = css(mix(pal.text, pal.background, 0.16));
    ctx.lineWidth = 2.1 * z * px;
    ctx.stroke(P.artOpen);

    // Flyovers: outlined decks, they stay above the water.
    ctx.strokeStyle = css(mix(pal.text, pal.background, 0.1));
    ctx.lineWidth = (2.6 * z + 2) * px;
    ctx.stroke(P.flyover);
    ctx.strokeStyle = css(mix(pal.background, pal.secondary, 0.25));
    ctx.lineWidth = 2.6 * z * px;
    ctx.stroke(P.flyover);

    // Subways and underpasses: a dotted core.
    ctx.setLineDash([1.5 * px, 3 * px]);
    ctx.strokeStyle = css(pal.text);
    ctx.lineWidth = 2 * z * px;
    ctx.stroke(P.tunnel);
    ctx.setLineDash([]);

    // Degraded: thinner short dashes in accent ink on a casing.
    ctx.strokeStyle = casing;
    ctx.lineWidth = (1.6 * z + 2) * px;
    ctx.stroke(P.degraded);
    ctx.setLineDash([3 * z * px, 3 * z * px]);
    ctx.strokeStyle = css(mix(pal.accent, pal.text, 0.4));
    ctx.lineWidth = 1.6 * z * px;
    ctx.stroke(P.degraded);

    // Blocked: a broken bar (the hatched halo pulses in the dynamic layer).
    ctx.setLineDash([6 * z * px, 5 * z * px]);
    ctx.lineCap = 'butt';
    ctx.strokeStyle = css(pal.text);
    ctx.lineWidth = 1.8 * z * px;
    ctx.stroke(P.blocked);
    ctx.setLineDash([]);

    // Bridges: text-coloured outline, background deck.
    ctx.strokeStyle = css(pal.text);
    ctx.lineWidth = (3 * z + 3) * px;
    ctx.stroke(P.bridge);
    ctx.strokeStyle = css(pal.background);
    ctx.lineWidth = 3 * z * px;
    ctx.stroke(P.bridge);
    // Closed bridge: outline only, broken.
    ctx.setLineDash([5 * z * px, 4 * z * px]);
    ctx.strokeStyle = css(pal.text);
    ctx.lineWidth = (3 * z + 3) * px;
    ctx.stroke(P.bridgeBlocked);
    ctx.setLineDash([]);
    ctx.restore();

    this.drawBridgeTicks(d);
  }

  private drawBridgeTicks(d: DrawCtx): void {
    const { ctx, cam, pal } = d;
    const g = this.world.graph;
    const z = clamp(Math.sqrt(cam.zoom), 1, 3.2);
    ctx.save();
    ctx.strokeStyle = css(pal.text);
    ctx.lineWidth = 1.3;
    for (const e of g.edges) {
      if (e.kind !== 'bridge') continue;
      const A = g.nodes[e.a], B = g.nodes[e.b];
      const [ax, ay] = cam.toScreen(A.x, A.y);
      const [bx, by] = cam.toScreen(B.x, B.y);
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 6) continue;
      const nx = -(by - ay) / len, ny = (bx - ax) / len;
      const half = 3 * z + 3.5;
      for (const t of [0.1, 0.9]) {
        const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
        ctx.beginPath();
        ctx.moveTo(x - nx * half, y - ny * half);
        ctx.lineTo(x + nx * half, y + ny * half);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** Dynamic layer: the cross-hatched halo under blocked roads, pulsing slowly. */
  drawPulses(d: DrawCtx, dpr: number): void {
    const P = this.paths;
    if (!P) return;
    const { ctx, cam } = d;
    const pattern = this.hatchPattern(d);
    if (!pattern) return;
    const z = clamp(Math.sqrt(cam.zoom), 1, 3.2);
    const px = 1 / cam.scale;
    ctx.save();
    worldTransform(ctx, cam, dpr);
    // Pattern units are world metres here; scale so a tile stays 10 CSS px at any zoom.
    pattern.setTransform(new DOMMatrix().scale(px, px));
    ctx.globalAlpha = d.reducedMotion ? 0.75 : 0.5 + 0.4 * (0.5 + 0.5 * Math.sin(d.time * 2.4));
    ctx.strokeStyle = pattern;
    ctx.lineCap = 'round';
    ctx.lineWidth = 8 * z * px;
    ctx.stroke(P.blocked);
    ctx.lineWidth = 10 * z * px;
    ctx.stroke(P.bridgeBlocked);
    ctx.restore();
  }

  hasBlocked(state?: Uint8Array): boolean {
    if (!state) return false;
    for (let i = 0; i < state.length; i++) if (state[i] === EdgeState.Blocked) return true;
    return false;
  }

  private hatchPattern(d: DrawCtx): CanvasPattern | null {
    const key = d.pal.text.join(',');
    if (!this.hatch || this.hatch.key !== key) {
      const tile = document.createElement('canvas');
      tile.width = tile.height = 10;
      const t = tile.getContext('2d');
      if (!t) return null;
      t.strokeStyle = css(d.pal.text, 0.62);
      t.lineWidth = 1.2;
      t.beginPath();
      t.moveTo(0, 10); t.lineTo(10, 0);
      t.moveTo(0, 0); t.lineTo(10, 10);
      t.stroke();
      this.hatch = { tile, key };
    }
    return d.ctx.createPattern(this.hatch.tile, 'repeat');
  }
}

/** Thick glowing route in primary, used for selected/planned routes. */
export function drawRoute(d: DrawCtx, g: Graph, nodePath: number[], strength = 1): void {
  if (nodePath.length < 2) return;
  const { ctx, cam, pal } = d;
  const z = clamp(Math.sqrt(cam.zoom), 1, 3.2);
  const p = new Path2D();
  nodePath.forEach((v, i) => {
    const [x, y] = cam.toScreen(g.nodes[v].x, g.nodes[v].y);
    if (i === 0) p.moveTo(x, y);
    else p.lineTo(x, y);
  });
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = css(pal.primary, 0.28 * strength);
  ctx.lineWidth = 9 * z;
  ctx.stroke(p);
  ctx.strokeStyle = css(pal.background, 0.9);
  ctx.lineWidth = 4.6 * z + 2;
  ctx.stroke(p);
  ctx.strokeStyle = css(mix(pal.primary, pal.text, 0.15));
  ctx.lineWidth = 4.6 * z;
  ctx.stroke(p);
  ctx.restore();
}
