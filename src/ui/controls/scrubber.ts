/**
 * Timeline scrubber with a hydrograph (river stage or rainfall over time)
 * drawn behind it. Acts as a slider for assistive tech. The "buffer" bar shows
 * how far the simulation has been computed; scrubbing past it is clamped.
 */
import { clamp, fmtClock } from '../../core/units';
import { css, mix, paletteAnimator, type Palette } from '../../render/theme';
import { h } from '../dom';

export interface ScrubberOptions {
  label: string;
  /** Total timeline length (minutes). */
  duration: number;
  value?: number;
  format?: (t: number) => string;
  /** `final` is true on release / keyboard commit. */
  onScrub?: (t: number, final: boolean) => void;
}

export interface Scrubber {
  el: HTMLElement;
  set(t: number): void;
  get(): number;
  setDuration(d: number): void;
  /** Fraction 0..1 of the timeline that has been computed. */
  setBuffered(f: number): void;
  /** Series sampled evenly over the timeline; normalised internally. */
  setHydrograph(series: ArrayLike<number>, secondary?: ArrayLike<number>): void;
  destroy(): void;
}

export function createScrubber(o: ScrubberOptions): Scrubber {
  const fmt = o.format ?? fmtClock;
  let duration = Math.max(1, o.duration);
  let value = clamp(o.value ?? 0, 0, duration);
  let buffered = 1;
  let series: ArrayLike<number> = [];
  let series2: ArrayLike<number> | undefined;

  const canvas = h('canvas', { 'aria-hidden': 'true' });
  const buffer = h('div', { class: 'scrubber-buffer' });
  const head = h('div', { class: 'scrubber-head' });
  const time = h('div', { class: 'scrubber-time' });
  const el = h('div', {
    class: 'scrubber',
    role: 'slider',
    tabindex: 0,
    'aria-label': o.label,
    'aria-valuemin': 0,
  });
  el.append(canvas, h('div', { class: 'scrubber-base' }), buffer, head, time);

  const ctx = canvas.getContext('2d');

  const draw = (p: Palette = paletteAnimator.get()) => {
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = el.clientWidth, hgt = el.clientHeight;
    if (w === 0 || hgt === 0) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hgt * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    const top = 6, base = hgt - 1;
    const plot = (s: ArrayLike<number>, stroke: string, fill: string | null, dash: number[]) => {
      const n = s.length;
      if (n < 2) return;
      let max = -Infinity;
      for (let i = 0; i < n; i++) if (Number.isFinite(s[i]) && s[i] > max) max = s[i];
      if (!Number.isFinite(max) || (fill && max <= 0)) max = 1;
      let min = Infinity;
      for (let i = 0; i < n; i++) if (Number.isFinite(s[i]) && s[i] < min) min = s[i];
      if (!Number.isFinite(min) || fill) min = 0;
      const span = Math.max(1e-6, max - min);
      // Unknown samples (NaN, e.g. not simulated yet) break the line.
      const trace = () => {
        ctx.beginPath();
        let pen = false;
        for (let i = 0; i < n; i++) {
          if (!Number.isFinite(s[i])) {
            pen = false;
            continue;
          }
          const x = (i / (n - 1)) * w;
          const y = base - ((s[i] - min) / span) * (base - top);
          if (!pen) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
          pen = true;
        }
      };
      if (fill) {
        trace();
        ctx.lineTo(w, base);
        ctx.lineTo(0, base);
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
      }
      trace();
      ctx.setLineDash(dash);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.25;
      ctx.stroke();
      ctx.setLineDash([]);
    };
    plot(series, css(p.primary), css(mix(p.background, p.primary, 0.16)), []);
    if (series2) plot(series2, css(mix(p.background, p.text, 0.45)), null, [3, 3]);

    // Shade the past lightly so "now" reads at a glance.
    const x = (value / duration) * w;
    ctx.fillStyle = css(p.text, 0.045);
    ctx.fillRect(0, 0, x, hgt);
  };

  const render = () => {
    const f = clamp(value / duration, 0, 1);
    head.style.left = `${f * 100}%`;
    time.style.left = `${clamp(f, 0.04, 0.96) * 100}%`;
    time.textContent = fmt(value);
    buffer.style.width = `${clamp(buffered, 0, 1) * 100}%`;
    el.setAttribute('aria-valuemax', String(Math.round(duration)));
    el.setAttribute('aria-valuenow', String(Math.round(value)));
    el.setAttribute('aria-valuetext', fmt(value));
    draw();
  };

  const maxReach = () => buffered * duration;
  const setFromUser = (t: number, final: boolean) => {
    value = clamp(t, 0, maxReach());
    render();
    o.onScrub?.(value, final);
  };

  const fromPointer = (clientX: number) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 ? clamp((clientX - r.left) / r.width, 0, 1) * duration : 0;
  };

  let dragging = false;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    el.focus({ preventScroll: true });
    setFromUser(fromPointer(e.clientX), false);
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (dragging) setFromUser(fromPointer(e.clientX), false);
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    o.onScrub?.(value, true);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('lostpointercapture', end);

  el.addEventListener('keydown', (e) => {
    const step = Math.max(1, duration / 100);
    let t: number | null = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') t = value - step;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') t = value + step;
    else if (e.key === 'PageDown') t = value - duration / 10;
    else if (e.key === 'PageUp') t = value + duration / 10;
    else if (e.key === 'Home') t = 0;
    else if (e.key === 'End') t = maxReach();
    if (t !== null) {
      e.preventDefault();
      setFromUser(t, true);
    }
  });

  const ro = new ResizeObserver(() => draw());
  ro.observe(el);
  const unsub = paletteAnimator.subscribe((p) => draw(p));
  render();

  return {
    el,
    get: () => value,
    set(t) {
      value = clamp(t, 0, duration);
      render();
    },
    setDuration(d) {
      duration = Math.max(1, d);
      value = clamp(value, 0, duration);
      render();
    },
    setBuffered(f) {
      buffered = clamp(f, 0, 1);
      render();
    },
    setHydrograph(s, s2) {
      series = s;
      series2 = s2;
      draw();
    },
    destroy() {
      ro.disconnect();
      unsub();
    },
  };
}
