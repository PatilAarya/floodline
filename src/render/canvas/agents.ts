/**
 * Evacuee groups and their routes on the dynamic map layer.
 *
 * Group states are told apart by shape, not hue:
 *   moving      filled dot inside a ring
 *   waiting     open ring (not left yet)
 *   stuck       ring with a pulsing dashed halo (waiting at a closed road)
 *   recovering  dot with a dashed ring (finishing or backing off a road that blocked)
 *   stranded    ring with a cross (no reachable relief centre right now)
 *   sheltered   not drawn; the centre's occupancy arc fills up instead
 * Positions arrive once per simulated minute and are interpolated between.
 */
import { clamp } from '../../core/units';
import { Status, STRIDE } from '../../sim/agents';
import type { World } from '../../world/types';
import { css, mix } from '../theme';
import type { DrawCtx } from './types';

export class AgentLayer {
  private prev: Float32Array | null = null;
  private cur: Float32Array | null = null;
  private routes = new Map<number, Int32Array>();
  private occupancy: number[] = [];
  /** People heading for (booked into) each centre but not there yet. */
  private booked: number[] = [];
  showRoutes = true;

  clear(): void {
    this.prev = this.cur = null;
    this.routes.clear();
    this.occupancy = [];
    this.booked = [];
  }

  /** New positions; `continuous` = the next minute after the previous frame (interpolate). */
  setPositions(p: Float32Array | null, continuous: boolean, shelters: number): void {
    this.prev = continuous && this.cur && p && this.cur.length === p.length ? this.cur : p;
    this.cur = p;
    this.occupancy = new Array(shelters).fill(0);
    this.booked = new Array(shelters).fill(0);
    if (!p) return;
    for (let o = 0; o < p.length; o += STRIDE) {
      if (p[o + 4] < 0) continue;
      if (p[o + 2] === Status.Sheltered) this.occupancy[p[o + 4]] += p[o + 3];
      else if (p[o + 2] !== Status.NoAccess) this.booked[p[o + 4]] += p[o + 3];
    }
  }

  setRoutes(ids: Int32Array, offsets: Int32Array, nodes: Int32Array): void {
    ids.forEach((id, k) => {
      const r = nodes.slice(offsets[k], offsets[k + 1]);
      if (r.length > 1) this.routes.set(id, r);
      else this.routes.delete(id);
    });
  }

  count(): number {
    return this.cur ? this.cur.length / STRIDE : 0;
  }

  group(id: number): { x: number; y: number; status: number; size: number; shelter: number; replans: number; eta: number; arrivedAt: number } | null {
    const p = this.cur;
    if (!p || id < 0 || id * STRIDE >= p.length) return null;
    const o = id * STRIDE;
    return { x: p[o], y: p[o + 1], status: p[o + 2], size: p[o + 3], shelter: p[o + 4], replans: p[o + 5], eta: p[o + 6], arrivedAt: p[o + 7] };
  }

  occupancyOf(shelter: number): number {
    return this.occupancy[shelter] ?? 0;
  }

  bookedFor(shelter: number): number {
    return this.booked[shelter] ?? 0;
  }

  /** Raw positions (STRIDE numbers per group), for per-neighbourhood summaries. */
  raw(): Float32Array | null {
    return this.cur;
  }

  /** Nearest visible group within 12 px of a screen point. */
  hitTest(d: { toScreen(x: number, y: number): [number, number] }, sx: number, sy: number, t: number): number {
    const p = this.cur;
    if (!p) return -1;
    let best = -1, bestD = 12 * 12;
    for (let o = 0; o < p.length; o += STRIDE) {
      if (p[o + 2] === Status.Sheltered || p[o + 2] === Status.NoAccess) continue;
      const [x, y] = this.at(o, t);
      const [px, py] = d.toScreen(x, y);
      const dd = (px - sx) ** 2 + (py - sy) ** 2;
      if (dd < bestD) {
        bestD = dd;
        best = o / STRIDE;
      }
    }
    return best;
  }

  private at(o: number, t: number): [number, number] {
    const c = this.cur!, p = this.prev ?? c;
    const tt = clamp(t, 0, 1);
    // Don't slide across the map on teleports (e.g. after re-planning a long way).
    const jump = Math.hypot(c[o] - p[o], c[o + 1] - p[o + 1]) > 1500;
    return jump ? [c[o], c[o + 1]] : [p[o] + (c[o] - p[o]) * tt, p[o + 1] + (c[o + 1] - p[o + 1]) * tt];
  }

  draw(d: DrawCtx, w: World, t: number, selected: number): void {
    const p = this.cur;
    const { ctx, cam, pal } = d;
    if (!p) return;
    const z = clamp(Math.sqrt(cam.zoom), 1, 3);
    const nodes = w.graph.nodes;

    // Routes: all active routes faintly, the selected one strongly.
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const routePath = (r: Int32Array) => {
      const path = new Path2D();
      for (let i = 0; i < r.length; i++) {
        const [x, y] = cam.toScreen(nodes[r[i]].x, nodes[r[i]].y);
        if (i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      }
      return path;
    };
    if (this.showRoutes) {
      const all = new Path2D();
      for (const [id, r] of this.routes) {
        if (id === selected) continue;
        const st = p[id * STRIDE + 2];
        if (st === Status.Sheltered || st === Status.Waiting) continue;
        all.addPath(routePath(r));
      }
      ctx.strokeStyle = css(pal.primary, 0.42);
      ctx.lineWidth = 1.6 * z;
      ctx.stroke(all);
    }
    const sel = this.routes.get(selected);
    if (sel) {
      const path = routePath(sel);
      ctx.strokeStyle = css(pal.primary, 0.3);
      ctx.lineWidth = 10 * z;
      ctx.stroke(path);
      ctx.strokeStyle = css(pal.background, 0.9);
      ctx.lineWidth = 4.5 * z + 2;
      ctx.stroke(path);
      ctx.strokeStyle = css(mix(pal.primary, pal.text, 0.2));
      ctx.lineWidth = 4.5 * z;
      ctx.stroke(path);
    }
    ctx.restore();

    // Occupancy arcs on relief centres (fill clockwise from the top).
    ctx.save();
    w.shelters.forEach((s, i) => {
      const occ = this.occupancy[i] ?? 0;
      if (occ <= 0) return;
      const nd = nodes[s.node];
      const [x, y] = cam.toScreen(nd.x, nd.y);
      const r = clamp(13 * Math.sqrt(cam.zoom), 13, 26) * 0.95;
      const f = clamp(occ / s.capacity, 0, 1);
      ctx.beginPath();
      ctx.arc(x, y - 4, r, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2);
      ctx.strokeStyle = css(mix(pal.primary, pal.text, 0.15));
      ctx.lineWidth = 3;
      ctx.stroke();
    });
    ctx.restore();

    // Groups.
    const pulse = d.reducedMotion ? 0.7 : 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(d.time * 3.2));
    ctx.save();
    for (let o = 0; o < p.length; o += STRIDE) {
      const st = p[o + 2];
      if (st === Status.Sheltered || st === Status.NoAccess) continue;
      const [wx, wy] = this.at(o, t);
      const [x, y] = cam.toScreen(wx, wy);
      if (x < -20 || y < -20 || x > cam.width + 20 || y > cam.height + 20) continue;
      const r = (2.6 + 2.2 * Math.sqrt(p[o + 3] / w.groupSize)) * Math.min(1.6, z);
      const isSel = o / STRIDE === selected;
      // Halo for contrast over water and roads.
      ctx.beginPath();
      ctx.arc(x, y, r + 2.6, 0, Math.PI * 2);
      ctx.fillStyle = css(pal.background, 0.85);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, r + 1.4, 0, Math.PI * 2);
      ctx.lineWidth = isSel ? 2.4 : 1.4;
      ctx.strokeStyle = css(st === Status.Waiting ? mix(pal.text, pal.background, 0.35) : mix(pal.primary, pal.text, 0.35));
      if (st === Status.Recovering) ctx.setLineDash([2, 2]);
      ctx.stroke();
      ctx.setLineDash([]);
      if (st === Status.Moving || st === Status.Recovering || st === Status.Stuck) {
        ctx.beginPath();
        ctx.arc(x, y, r * 0.6, 0, Math.PI * 2);
        ctx.fillStyle = css(pal.text);
        ctx.fill();
      }
      if (st === Status.Stuck) {
        ctx.globalAlpha = pulse;
        ctx.setLineDash([2.5, 2.5]);
        ctx.beginPath();
        ctx.arc(x, y, r + 5.5, 0, Math.PI * 2);
        ctx.strokeStyle = css(pal.text);
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
      if (st === Status.Stranded) {
        const k = r * 0.65;
        ctx.beginPath();
        ctx.moveTo(x - k, y - k);
        ctx.lineTo(x + k, y + k);
        ctx.moveTo(x + k, y - k);
        ctx.lineTo(x - k, y + k);
        ctx.strokeStyle = css(pal.text);
        ctx.lineWidth = 1.8;
        ctx.stroke();
      }
      if (isSel) {
        ctx.beginPath();
        ctx.arc(x, y, r + 7, 0, Math.PI * 2);
        ctx.strokeStyle = css(pal.primary);
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}
