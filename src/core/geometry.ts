/** Plane geometry helpers. World units are metres; y grows downward. */
import type { Rng } from './rng';

export interface Vec2 {
  x: number;
  y: number;
}

export const dist = (ax: number, ay: number, bx: number, by: number): number => Math.hypot(bx - ax, by - ay);

/** Squared distance from point p to segment ab, and the parameter t in [0,1]. */
export function pointSegDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): { d2: number; t: number } {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx - px, qy = ay + t * dy - py;
  return { d2: qx * qx + qy * qy, t };
}

/** Proper intersection test for segments ab and cd (touching counts). */
export function segmentsIntersect(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = o(cx, cy, dx, dy, ax, ay);
  const d2 = o(cx, cy, dx, dy, bx, by);
  const d3 = o(ax, ay, bx, by, cx, cy);
  const d4 = o(ax, ay, bx, by, dx, dy);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Shoelace area (signed) of a polygon given as [x0,y0,x1,y1,...] or point pairs. */
export function polygonArea(poly: ArrayLike<number>[]): number {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function polygonCentroid(poly: ArrayLike<number>[]): Vec2 {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    const f = p[0] * q[1] - q[0] * p[1];
    cx += (p[0] + q[0]) * f;
    cy += (p[1] + q[1]) * f;
    a += f;
  }
  if (Math.abs(a) < 1e-9) {
    // Degenerate: fall back to vertex mean.
    let sx = 0, sy = 0;
    for (const p of poly) {
      sx += p[0];
      sy += p[1];
    }
    return { x: sx / Math.max(1, poly.length), y: sy / Math.max(1, poly.length) };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

export function pointInPolygon(x: number, y: number, poly: ArrayLike<number>[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Bridson's Poisson-disc sampling: points at least `r` apart, filling the
 * rectangle. `accept(x, y)` can reject candidates (e.g. inside the river).
 * O(n) with a background grid of cell size r/sqrt(2).
 */
export function poissonDisc(width: number, height: number, r: number, rng: Rng, accept: (x: number, y: number) => boolean = () => true, k = 24): Vec2[] {
  const cell = r / Math.SQRT2;
  const gw = Math.ceil(width / cell), gh = Math.ceil(height / cell);
  const grid = new Int32Array(gw * gh).fill(-1);
  const pts: Vec2[] = [];
  const active: number[] = [];

  const fits = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    for (let j = Math.max(0, gy - 2); j <= Math.min(gh - 1, gy + 2); j++) {
      for (let i = Math.max(0, gx - 2); i <= Math.min(gw - 1, gx + 2); i++) {
        const idx = grid[j * gw + i];
        if (idx >= 0) {
          const p = pts[idx];
          if ((p.x - x) ** 2 + (p.y - y) ** 2 < r * r) return false;
        }
      }
    }
    return true;
  };
  const add = (x: number, y: number) => {
    pts.push({ x, y });
    grid[Math.floor(y / cell) * gw + Math.floor(x / cell)] = pts.length - 1;
    active.push(pts.length - 1);
  };

  // Seed with a few starting points so separated land areas all get filled.
  for (let tries = 0; tries < 60 && pts.length < 6; tries++) {
    const x = rng.range(0, width), y = rng.range(0, height);
    if (fits(x, y) && accept(x, y)) add(x, y);
  }

  while (active.length > 0) {
    const ai = Math.floor(rng.next() * active.length);
    const p = pts[active[ai]];
    let found = false;
    for (let t = 0; t < k; t++) {
      const a = rng.next() * Math.PI * 2;
      const d = r * (1 + rng.next());
      const x = p.x + Math.cos(a) * d, y = p.y + Math.sin(a) * d;
      if (fits(x, y)) {
        // Rejected candidates still occupy nothing, so the gap can be filled later.
        if (accept(x, y)) {
          add(x, y);
          found = true;
          break;
        }
      }
    }
    if (!found) {
      active[ai] = active[active.length - 1];
      active.pop();
    }
  }
  return pts;
}

/** Union-find with path halving and union by size. */
export class DisjointSet {
  private parent: Int32Array;
  private size: Int32Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
    this.size = new Int32Array(n).fill(1);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(a: number): number {
    while (this.parent[a] !== a) {
      this.parent[a] = this.parent[this.parent[a]];
      a = this.parent[a];
    }
    return a;
  }
  union(a: number, b: number): boolean {
    let ra = this.find(a), rb = this.find(b);
    if (ra === rb) return false;
    if (this.size[ra] < this.size[rb]) [ra, rb] = [rb, ra];
    this.parent[rb] = ra;
    this.size[ra] += this.size[rb];
    return true;
  }
}
