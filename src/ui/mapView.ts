/**
 * The map: a full-bleed stack of three canvases sharing one camera.
 *
 *   base     WebGL2 terrain + water (or the Canvas 2D fallback when WebGL2
 *            is missing or its context is lost)
 *   static   Canvas 2D: streets, roads and their states, neighbourhoods,
 *            shelters, labels. Redrawn only when something changes.
 *   dynamic  Canvas 2D: pulsing blocked-road halos, selection, and extras
 *            (routes, agents) drawn every frame while animating.
 *
 * Quality: the base canvas renders at a fraction of device resolution. On
 * "auto" the fraction adapts to frame time; "high" and "low" fix it.
 */
import { pointInPolygon, pointSegDist2 } from '../core/geometry';
import { prefs, type Quality } from '../core/prefs';
import { clamp } from '../core/units';
import { attachCameraControls, Camera } from '../render/camera';
import { buildContours, type Contours } from '../render/canvas/contours';
import { drawLabels } from '../render/canvas/labels';
import { drawContours, drawEdgeHighlight, drawHoods, drawRiver, drawShelters, drawWaterAreas } from '../render/canvas/overlays';
import { RoadLayer } from '../render/canvas/roads';
import { buildTerrainImage } from '../render/canvas/terrain';
import type { DrawCtx } from '../render/canvas/types';
import { WaterImage } from '../render/canvas/water2d';
import { FloodGL } from '../render/gl/floodGL';
import { css, paletteAnimator, type Palette } from '../render/theme';
import type { World } from '../world/types';
import { h } from './dom';

export type Selection = { kind: 'hood' | 'shelter' | 'edge' | 'group'; id: number } | null;

export interface Layers {
  terrain: boolean;
  contours: boolean;
  water: boolean;
  hoods: boolean;
  roads: boolean;
  streets: boolean;
  shelters: boolean;
  labels: boolean;
}

export const DEFAULT_LAYERS: Layers = { terrain: true, contours: true, water: true, hoods: true, roads: true, streets: true, shelters: true, labels: true };

export interface MapViewOptions {
  label: string;
  onSelect?: (sel: Selection) => void;
  /** Extra drawing on the dynamic layer (routes, agents...). */
  drawExtra?: (d: DrawCtx) => void;
  /** Extra hit-testing (e.g. evacuee groups), checked before roads and areas. */
  hitExtra?: (sx: number, sy: number) => Selection;
  /** Raw tap in world coordinates; return true to skip normal selection. */
  onTap?: (wx: number, wy: number) => boolean;
}

export interface MapView {
  el: HTMLElement;
  camera: Camera;
  /** 'webgl' or 'canvas' (fallback). */
  readonly renderer: () => 'webgl' | 'canvas';
  setWorld(w: World | null): void;
  setLayers(l: Partial<Layers>): void;
  setSelection(sel: Selection): void;
  setEdgeState(s: Uint8Array | undefined): void;
  /** New water depth field. `intervalMs` is how long until the next frame (for interpolation). */
  setDepth(depth: Float32Array, flow: Float32Array | null, opts?: { reset?: boolean; intervalMs?: number }): void;
  /** 0..1, drives the rain streaks. */
  setRain(r: number): void;
  setQuality(q: Quality): void;
  /** Keep redrawing every frame (playback, pulses). */
  setAnimating(on: boolean): void;
  setSummary(text: string): void;
  requestRender(): void;
  destroy(): void;
}

export function createMapView(o: MapViewOptions): MapView {
  const baseGL = h('canvas', { class: 'map-canvas', 'aria-hidden': 'true' });
  const base2D = h('canvas', { class: 'map-canvas', 'aria-hidden': 'true' });
  const stat = h('canvas', { class: 'map-canvas', 'aria-hidden': 'true' });
  const dyn = h('canvas', { class: 'map-canvas map-input', tabindex: 0, role: 'img', 'aria-label': o.label });
  const summary = h('p', { class: 'visually-hidden', 'aria-live': 'polite' });
  const hint = h('p', { class: 'map-hint', 'aria-hidden': 'true' }, 'Drag to pan, scroll or pinch to zoom, tap to inspect. Keys: arrows, + and -, 0 to reset.');
  const credit = h('p', { class: 'map-credit' });
  const el = h('div', { class: 'map-view' }, baseGL, base2D, stat, dyn, hint, credit, summary);
  const cam = new Camera();

  let gl: FloodGL | null = FloodGL.create(baseGL);
  let useGL = !!gl;
  const sctx = stat.getContext('2d');
  const dctx = dyn.getContext('2d');
  const bctx = base2D.getContext('2d', { alpha: false });

  let world: World | null = null;
  let layers: Layers = { ...DEFAULT_LAYERS };
  let selection: Selection = null;
  let hover: Selection = null;
  let edgeState: Uint8Array | undefined;
  let contours: Contours | null = null;
  let roads: RoadLayer | null = null;
  let terrainImg: HTMLCanvasElement | null = null;
  const water2d = new WaterImage();
  let lastDepth: Float32Array | null = null;
  let frameAt = 0;
  let frameInterval = 500;
  let rain = 0;
  let quality: Quality = prefs.get().quality;
  let scale = quality === 'low' ? 0.55 : 1;
  const frameTimes: number[] = [];
  let animating = false;
  let staticDirty = true;
  let raf = 0;
  let dragging = false;
  const t0 = performance.now();

  const showBase = () => {
    baseGL.style.display = useGL ? 'block' : 'none';
    base2D.style.display = useGL ? 'none' : 'block';
  };
  showBase();

  if (gl) {
    gl.onLost = () => {
      useGL = false;
      showBase();
      if (world && !terrainImg) terrainImg = buildTerrainImage(world.terrain, paletteAnimator.get());
      if (lastDepth && world) water2d.update(lastDepth, world.terrain.n);
      staticDirty = true;
      requestRender();
    };
    gl.onRestored = () => {
      useGL = true;
      showBase();
      requestRender();
    };
  }

  // ── Custom cursor: a ring drawn as SVG in the text colour ──
  const setCursor = (state: 'idle' | 'hover' | 'drag') => {
    const p = paletteAnimator.get();
    const ink = css(p.text), bg = css(p.background);
    let body: string;
    if (state === 'drag') body = `<circle cx='12' cy='12' r='5' fill='${ink}' stroke='${bg}' stroke-width='1.5'/>`;
    else if (state === 'hover') body = `<circle cx='12' cy='12' r='9' fill='none' stroke='${bg}' stroke-width='3.5'/><circle cx='12' cy='12' r='9' fill='none' stroke='${ink}' stroke-width='1.6'/><circle cx='12' cy='12' r='2.6' fill='${ink}'/>`;
    else body = `<circle cx='12' cy='12' r='7' fill='none' stroke='${bg}' stroke-width='3.5'/><circle cx='12' cy='12' r='7' fill='none' stroke='${ink}' stroke-width='1.3'/><path d='M12 1v5M12 18v5M1 12h5M18 12h5' stroke='${ink}' stroke-width='1.3'/>`;
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24'>${body}</svg>`;
    dyn.style.cursor = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, ${state === 'drag' ? 'grabbing' : 'crosshair'}`;
  };

  const dprNow = () => Math.min(window.devicePixelRatio || 1, 2.5);

  const sizeCanvas = (c: HTMLCanvasElement, w: number, hgt: number, k: number) => {
    const W = Math.max(1, Math.round(w * k)), H = Math.max(1, Math.round(hgt * k));
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
  };

  const resize = () => {
    const r = el.getBoundingClientRect();
    const dpr = dprNow();
    cam.setViewport(r.width, r.height);
    sizeCanvas(baseGL, r.width, r.height, dpr * scale);
    sizeCanvas(base2D, r.width, r.height, dpr);
    sizeCanvas(stat, r.width, r.height, dpr);
    sizeCanvas(dyn, r.width, r.height, dpr);
    staticDirty = true;
    render();
  };

  const ctxFor = (ctx: CanvasRenderingContext2D, pal: Palette): DrawCtx => ({ ctx, cam, pal, time: (performance.now() - t0) / 1000, reducedMotion: prefs.get().reducedMotion });

  function drawBase(pal: Palette) {
    if (!world) return;
    const now = performance.now();
    const mixT = clamp((now - frameAt) / Math.max(16, frameInterval), 0, 1);
    if (useGL && gl) {
      gl.render(baseGL, cam, pal, {
        time: prefs.get().reducedMotion ? 0 : (now - t0) / 1000,
        mix: mixT,
        rain: layers.water ? rain : 0,
        motion: !prefs.get().reducedMotion,
        terrain: layers.terrain,
        water: layers.water,
        contours: layers.contours,
      });
      return;
    }
    if (!bctx) return;
    const dpr = dprNow();
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.fillStyle = css(pal.background);
    bctx.fillRect(0, 0, cam.width, cam.height);
    const S = world.terrain.size;
    const [x0, y0] = cam.toScreen(0, 0);
    const side = S * cam.scale;
    bctx.imageSmoothingEnabled = true;
    bctx.imageSmoothingQuality = 'high';
    if (layers.terrain && terrainImg) bctx.drawImage(terrainImg, x0, y0, side, side);
    const d = ctxFor(bctx, pal);
    if (layers.contours && contours) drawContours(d, contours);
    if (layers.water) {
      if (world.source === 'synthetic') drawRiver(d, world);
      if (lastDepth) bctx.drawImage(water2d.canvas, x0, y0, side, side);
    }
  }

  function drawStatic(pal: Palette) {
    if (!sctx) return;
    const dpr = dprNow();
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sctx.clearRect(0, 0, cam.width, cam.height);
    if (!world) return;
    const d = ctxFor(sctx, pal);
    const S = world.terrain.size;
    const [x0, y0] = cam.toScreen(0, 0);
    const side = S * cam.scale;
    sctx.save();
    sctx.beginPath();
    sctx.rect(x0, y0, side, side);
    sctx.clip();
    if (layers.water) drawWaterAreas(d, world);
    if (layers.hoods) drawHoods(d, world, selection?.kind === 'hood' ? selection.id : -1, hover?.kind === 'hood' ? hover.id : -1);
    if (layers.roads && roads) roads.draw(d, dpr, layers.streets);
    sctx.restore();
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sctx.strokeStyle = css(pal.text, 0.2);
    sctx.lineWidth = 1;
    sctx.strokeRect(x0 + 0.5, y0 + 0.5, side - 1, side - 1);
    if (layers.shelters) drawShelters(d, world, selection?.kind === 'shelter' ? selection.id : -1);
    if (layers.labels) drawLabels(d, world);
  }

  function drawDynamic(pal: Palette) {
    if (!dctx) return;
    const dpr = dprNow();
    dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dctx.clearRect(0, 0, cam.width, cam.height);
    if (!world) return;
    const d = ctxFor(dctx, pal);
    if (layers.roads && roads && roads.hasBlocked(edgeState)) roads.drawPulses(d, dpr);
    dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (selection?.kind === 'edge') drawEdgeHighlight(d, world, selection.id);
    o.drawExtra?.(d);
  }

  function render() {
    raf = 0;
    const start = performance.now();
    const pal = paletteAnimator.get();
    drawBase(pal);
    if (staticDirty) {
      drawStatic(pal);
      staticDirty = false;
    }
    drawDynamic(pal);
    adaptQuality(performance.now() - start);
    const pulsing = layers.roads && !!roads?.hasBlocked(edgeState) && !prefs.get().reducedMotion;
    const interpolating = performance.now() - frameAt < frameInterval;
    if ((animating || pulsing || interpolating) && !document.hidden) requestRender();
  }

  /** Auto quality: lower the base resolution when frames get slow, raise it when there is headroom. */
  function adaptQuality(ms: number) {
    if (quality !== 'auto' || !useGL) return;
    frameTimes.push(ms);
    if (frameTimes.length < 30) return;
    const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
    frameTimes.length = 0;
    const next = avg > 14 ? Math.max(0.5, scale - 0.15) : avg < 6 ? Math.min(1, scale + 0.1) : scale;
    if (next !== scale) {
      scale = next;
      const r = el.getBoundingClientRect();
      sizeCanvas(baseGL, r.width, r.height, dprNow() * scale);
    }
  }

  function requestRender() {
    if (!raf) raf = requestAnimationFrame(render);
  }
  const invalidate = () => {
    staticDirty = true;
    requestRender();
  };

  const hitTest = (wx: number, wy: number, sx: number, sy: number): Selection => {
    if (!world) return null;
    const extra = o.hitExtra?.(sx, sy);
    if (extra) return extra;
    if (layers.shelters) {
      for (const s of world.shelters) {
        const nd = world.graph.nodes[s.node];
        const [x, y] = cam.toScreen(nd.x, nd.y);
        if (Math.hypot(x - sx, y - sy + 5) < 16) return { kind: 'shelter', id: s.id };
      }
    }
    if (layers.roads) {
      let best = -1, bestD = 7 * 7;
      const vis = cam.visible(20);
      for (const e of world.graph.edges) {
        const A = world.graph.nodes[e.a], B = world.graph.nodes[e.b];
        if (Math.max(A.x, B.x) < vis.minX || Math.min(A.x, B.x) > vis.maxX || Math.max(A.y, B.y) < vis.minY || Math.min(A.y, B.y) > vis.maxY) continue;
        let px = A.x, py = A.y;
        const step = (x: number, y: number) => {
          const [ax, ay] = cam.toScreen(px, py);
          const [bx, by] = cam.toScreen(x, y);
          const { d2 } = pointSegDist2(sx, sy, ax, ay, bx, by);
          if (d2 < bestD) {
            bestD = d2;
            best = e.id;
          }
          px = x;
          py = y;
        };
        for (let i = 0; i < e.geom.length; i += 2) step(e.geom[i], e.geom[i + 1]);
        step(B.x, B.y);
      }
      if (best >= 0) return { kind: 'edge', id: best };
    }
    for (const hd of world.hoods) if (pointInPolygon(wx, wy, hd.polygon)) return { kind: 'hood', id: hd.id };
    return null;
  };

  const detach = attachCameraControls(dyn, cam, {
    onChange: invalidate,
    onTap(wx, wy, sx, sy) {
      if (o.onTap?.(wx, wy)) {
        requestRender();
        return;
      }
      selection = hitTest(wx, wy, sx, sy);
      o.onSelect?.(selection);
      invalidate();
    },
    onHover(wx, wy, sx, sy) {
      if (dragging) return;
      const hit = hitTest(wx, wy, sx, sy);
      if (hit?.kind !== hover?.kind || hit?.id !== hover?.id) {
        hover = hit;
        invalidate();
      }
      setCursor(hit && hit.kind !== 'hood' ? 'hover' : 'idle');
      if (hit?.kind === 'group') requestRender();
    },
    onLeave() {
      hover = null;
      invalidate();
    },
    onDragState(on) {
      dragging = on;
      setCursor(on ? 'drag' : 'idle');
    },
  });
  dyn.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && selection) {
      selection = null;
      o.onSelect?.(null);
      invalidate();
    }
  });

  const ro = new ResizeObserver(resize);
  ro.observe(el);
  window.addEventListener('orientationchange', resize);
  const unsubPal = paletteAnimator.subscribe((p) => {
    setCursor('idle');
    water2d.setPalette(p);
    if (world && !useGL) terrainImg = buildTerrainImage(world.terrain, p);
    invalidate();
  });
  const onVis = () => {
    if (!document.hidden) requestRender();
  };
  document.addEventListener('visibilitychange', onVis);
  setCursor('idle');
  water2d.setPalette(paletteAnimator.get());

  return {
    el,
    camera: cam,
    renderer: () => (useGL ? 'webgl' : 'canvas'),
    setWorld(w) {
      world = w;
      selection = null;
      hover = null;
      edgeState = undefined;
      lastDepth = null;
      contours = null;
      roads = w ? new RoadLayer(w) : null;
      terrainImg = null;
      credit.textContent = w ? w.attribution : '';
      if (w) {
        cam.setBounds(w.bounds);
        cam.fit();
        if (gl && useGL) gl.setWorld(w.terrain.height, w.terrain.n, w.terrain.size, w.terrain.minH, w.terrain.maxH);
        if (!useGL) terrainImg = buildTerrainImage(w.terrain, paletteAnimator.get());
        contours = buildContours(w.terrain, 2, 5);
      }
      invalidate();
    },
    setLayers(l) {
      layers = { ...layers, ...l };
      invalidate();
    },
    setSelection(sel) {
      selection = sel;
      invalidate();
    },
    setEdgeState(s) {
      edgeState = s;
      if (roads?.update(s)) invalidate();
      else requestRender();
    },
    setDepth(depth, flow, opts = {}) {
      if (!world) return;
      lastDepth = depth;
      frameAt = performance.now();
      frameInterval = opts.intervalMs ?? 500;
      if (gl && useGL) gl.uploadDepth(depth, flow, !!opts.reset);
      else water2d.update(depth, world.terrain.n);
      requestRender();
    },
    setRain(r) {
      rain = clamp(r, 0, 1);
    },
    setQuality(q) {
      quality = q;
      scale = q === 'low' ? 0.55 : q === 'high' ? 1 : scale;
      resize();
    },
    setAnimating(on) {
      animating = on;
      if (on) requestRender();
    },
    setSummary(text) {
      summary.textContent = text;
      dyn.setAttribute('aria-label', `${o.label}. ${text}`);
    },
    requestRender,
    destroy() {
      cancelAnimationFrame(raf);
      detach();
      ro.disconnect();
      unsubPal();
      window.removeEventListener('orientationchange', resize);
      document.removeEventListener('visibilitychange', onVis);
      gl = null;
    },
  };
}
