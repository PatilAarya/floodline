/**
 * 2D camera for the map: world metres <-> CSS pixels, plus pointer/touch/
 * wheel/keyboard controls. Shared by the Canvas and WebGL renderers.
 *
 *   screenX = (worldX - cx) * scale + width / 2
 */
import { clamp } from '../core/units';
import type { Bounds } from '../world/types';

export class Camera {
  cx = 0;
  cy = 0;
  /** CSS pixels per metre. */
  scale = 1;
  width = 1;
  height = 1;
  private fitScale = 1;
  private bounds: Bounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 };

  setViewport(w: number, h: number): void {
    const wasFit = Math.abs(this.scale - this.fitScale) < 1e-9;
    this.width = Math.max(1, w);
    this.height = Math.max(1, h);
    const prevFit = this.fitScale;
    this.fitScale = this.computeFit();
    // Keep the same relative zoom across resizes and orientation changes.
    this.scale = wasFit ? this.fitScale : this.scale * (this.fitScale / prevFit);
    this.clampView();
  }

  setBounds(b: Bounds): void {
    this.bounds = b;
    this.fitScale = this.computeFit();
  }

  private computeFit(): number {
    const bw = this.bounds.maxX - this.bounds.minX, bh = this.bounds.maxY - this.bounds.minY;
    return Math.min(this.width / bw, this.height / bh) * 0.96;
  }

  fit(): void {
    this.fitScale = this.computeFit();
    this.scale = this.fitScale;
    this.cx = (this.bounds.minX + this.bounds.maxX) / 2;
    this.cy = (this.bounds.minY + this.bounds.maxY) / 2;
  }

  get zoom(): number {
    return this.scale / this.fitScale;
  }

  toScreen(x: number, y: number): [number, number] {
    return [(x - this.cx) * this.scale + this.width / 2, (y - this.cy) * this.scale + this.height / 2];
  }

  toWorld(sx: number, sy: number): [number, number] {
    return [(sx - this.width / 2) / this.scale + this.cx, (sy - this.height / 2) / this.scale + this.cy];
  }

  /** Zoom by factor k keeping the world point under (sx, sy) fixed. */
  zoomAt(k: number, sx: number, sy: number): void {
    const [wx, wy] = this.toWorld(sx, sy);
    this.scale = clamp(this.scale * k, this.fitScale * 0.85, this.fitScale * 14);
    const [nx, ny] = this.toWorld(sx, sy);
    this.cx += wx - nx;
    this.cy += wy - ny;
    this.clampView();
  }

  panBy(dxPx: number, dyPx: number): void {
    this.cx -= dxPx / this.scale;
    this.cy -= dyPx / this.scale;
    this.clampView();
  }

  /** Keep the map from being dragged entirely off screen. */
  private clampView(): void {
    const b = this.bounds;
    const halfW = this.width / 2 / this.scale, halfH = this.height / 2 / this.scale;
    const bw = b.maxX - b.minX, bh = b.maxY - b.minY;
    this.cx = bw <= halfW * 2 ? (b.minX + b.maxX) / 2 : clamp(this.cx, b.minX + halfW, b.maxX - halfW);
    this.cy = bh <= halfH * 2 ? (b.minY + b.maxY) / 2 : clamp(this.cy, b.minY + halfH, b.maxY - halfH);
  }

  /** Visible world rectangle (with a margin in px), for culling. */
  visible(marginPx = 0): Bounds {
    const [x0, y0] = this.toWorld(-marginPx, -marginPx);
    const [x1, y1] = this.toWorld(this.width + marginPx, this.height + marginPx);
    return { minX: x0, minY: y0, maxX: x1, maxY: y1 };
  }
}

export interface CameraControlOptions {
  onChange: () => void;
  onTap?: (wx: number, wy: number, sx: number, sy: number) => void;
  onHover?: (wx: number, wy: number, sx: number, sy: number) => void;
  onLeave?: () => void;
  onDragState?: (dragging: boolean) => void;
}

/** Wire mouse, touch (pinch), wheel and keyboard to a camera. Returns a disposer. */
export function attachCameraControls(el: HTMLElement, cam: Camera, o: CameraControlOptions): () => void {
  const pointers = new Map<number, { x: number; y: number }>();
  let downAt: { x: number; y: number; t: number } | null = null;
  let moved = false;
  let pinchDist = 0;
  let pinchMid = { x: 0, y: 0 };

  const local = (e: PointerEvent | WheelEvent | MouseEvent) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const pinchState = () => {
    const [a, b] = [...pointers.values()];
    return { d: Math.hypot(b.x - a.x, b.y - a.y), m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  };

  const onDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const p = local(e);
    pointers.set(e.pointerId, p);
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (pointers.size === 1) {
      downAt = { ...p, t: performance.now() };
      moved = false;
    } else if (pointers.size === 2) {
      const s = pinchState();
      pinchDist = s.d;
      pinchMid = s.m;
      moved = true; // a pinch is never a tap
    }
  };

  const onMove = (e: PointerEvent) => {
    const p = local(e);
    const prev = pointers.get(e.pointerId);
    if (!prev) {
      if (e.pointerType === 'mouse' && o.onHover) {
        const [wx, wy] = cam.toWorld(p.x, p.y);
        o.onHover(wx, wy, p.x, p.y);
      }
      return;
    }
    if (pointers.size === 1) {
      if (downAt && Math.hypot(p.x - downAt.x, p.y - downAt.y) > 5) {
        if (!moved) o.onDragState?.(true);
        moved = true;
      }
      if (moved) {
        cam.panBy(p.x - prev.x, p.y - prev.y);
        o.onChange();
      }
      pointers.set(e.pointerId, p);
    } else if (pointers.size === 2) {
      pointers.set(e.pointerId, p);
      const s = pinchState();
      if (pinchDist > 0) cam.zoomAt(s.d / pinchDist, s.m.x, s.m.y);
      cam.panBy(s.m.x - pinchMid.x, s.m.y - pinchMid.y);
      pinchDist = s.d;
      pinchMid = s.m;
      o.onChange();
    }
  };

  const onUp = (e: PointerEvent) => {
    const p = local(e);
    const had = pointers.delete(e.pointerId);
    if (!had) return;
    if (pointers.size === 0) {
      if (!moved && downAt && performance.now() - downAt.t < 500 && o.onTap) {
        const [wx, wy] = cam.toWorld(p.x, p.y);
        o.onTap(wx, wy, p.x, p.y);
      }
      if (moved) o.onDragState?.(false);
      downAt = null;
    } else if (pointers.size === 1) {
      // Pinch ended with one finger still down: continue as a pan from here.
      const [only] = [...pointers.values()];
      downAt = { ...only, t: 0 };
    }
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = local(e);
    // Trackpads send small pixel deltas, mice send lines; normalise both.
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    cam.zoomAt(Math.exp(-dy * 0.0016), p.x, p.y);
    o.onChange();
  };

  const onDbl = (e: MouseEvent) => {
    const p = local(e);
    cam.zoomAt(e.shiftKey ? 0.5 : 2, p.x, p.y);
    o.onChange();
  };

  const onKey = (e: KeyboardEvent) => {
    const step = 60;
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft': cam.panBy(step, 0); break;
      case 'ArrowRight': cam.panBy(-step, 0); break;
      case 'ArrowUp': cam.panBy(0, step); break;
      case 'ArrowDown': cam.panBy(0, -step); break;
      case '+': case '=': cam.zoomAt(1.25, cam.width / 2, cam.height / 2); break;
      case '-': case '_': cam.zoomAt(0.8, cam.width / 2, cam.height / 2); break;
      case '0': cam.fit(); break;
      default: handled = false;
    }
    if (handled) {
      e.preventDefault();
      o.onChange();
    }
  };

  const onLeave = () => o.onLeave?.();

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
  el.addEventListener('pointerleave', onLeave);
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('dblclick', onDbl);
  el.addEventListener('keydown', onKey);
  return () => {
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onUp);
    el.removeEventListener('pointerleave', onLeave);
    el.removeEventListener('wheel', onWheel);
    el.removeEventListener('dblclick', onDbl);
    el.removeEventListener('keydown', onKey);
  };
}
