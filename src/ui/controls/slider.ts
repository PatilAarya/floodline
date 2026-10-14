/**
 * Custom range slider: thin track, ring thumb, live value in mono.
 * role="slider" with full keyboard support (arrows, PageUp/Down, Home/End).
 * Pointer capture gives a large hit area and smooth dragging on touch.
 */
import { clamp, invLerp, snap } from '../../core/units';
import { h, uid } from '../dom';

export interface SliderOptions {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  /** Format the displayed value (also used for aria-valuetext). */
  format?: (v: number) => string;
  /** Fires continuously while dragging. */
  onInput?: (v: number) => void;
  /** Fires when the user releases or commits with the keyboard. */
  onChange?: (v: number) => void;
  ticks?: number;
  disabled?: boolean;
}

export interface Slider {
  el: HTMLElement;
  get(): number;
  set(v: number, silent?: boolean): void;
  setDisabled(d: boolean): void;
}

export function createSlider(o: SliderOptions): Slider {
  const fmt = o.format ?? ((v: number) => String(v));
  const id = uid('slider');
  let value = clamp(snap(o.value, o.min, o.step), o.min, o.max);
  let disabled = !!o.disabled;

  const valueEl = h('output', { class: 'ctl-value', for: id });
  const fill = h('div', { class: 'slider-fill' });
  const thumb = h('div', { class: 'slider-thumb' });
  const track = h('div', {
    class: 'slider',
    id,
    role: 'slider',
    tabindex: 0,
    'aria-label': o.label,
    'aria-valuemin': o.min,
    'aria-valuemax': o.max,
  });
  track.append(h('div', { class: 'slider-track' }), fill, thumb);

  if (o.ticks && o.ticks > 1) {
    const ticks = h('div', { class: 'slider-ticks' });
    for (let i = 0; i < o.ticks; i++) {
      const t = h('i');
      t.style.left = `${(i / (o.ticks - 1)) * 100}%`;
      ticks.append(t);
    }
    track.append(ticks);
  }

  const el = h('div', { class: 'ctl' }, h('div', { class: 'ctl-row' }, h('span', { class: 'ctl-label' }, o.label), valueEl), track);

  const render = () => {
    const f = clamp(invLerp(o.min, o.max, value), 0, 1);
    fill.style.width = `${f * 100}%`;
    thumb.style.left = `${f * 100}%`;
    const text = fmt(value);
    valueEl.textContent = text;
    track.setAttribute('aria-valuenow', String(value));
    track.setAttribute('aria-valuetext', text);
    track.setAttribute('aria-disabled', String(disabled));
    track.tabIndex = disabled ? -1 : 0;
  };

  const setValue = (v: number, emit: 'input' | 'change' | 'none') => {
    const nv = clamp(snap(v, o.min, o.step), o.min, o.max);
    const changed = nv !== value;
    value = nv;
    render();
    if (emit === 'input' && changed) o.onInput?.(value);
    if (emit === 'change') {
      if (changed) o.onInput?.(value);
      o.onChange?.(value);
    }
  };

  const fromPointer = (clientX: number) => {
    const r = track.getBoundingClientRect();
    const f = r.width > 0 ? clamp((clientX - r.left) / r.width, 0, 1) : 0;
    return o.min + f * (o.max - o.min);
  };

  let dragging = false;
  track.addEventListener('pointerdown', (e) => {
    if (disabled || e.button !== 0) return;
    dragging = true;
    track.dataset.dragging = 'true';
    try {
      track.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events */
    }
    track.focus({ preventScroll: true });
    setValue(fromPointer(e.clientX), 'input');
    e.preventDefault();
  });
  track.addEventListener('pointermove', (e) => {
    if (dragging) setValue(fromPointer(e.clientX), 'input');
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    track.dataset.dragging = 'false';
    o.onChange?.(value);
  };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);
  track.addEventListener('lostpointercapture', end);

  track.addEventListener('keydown', (e) => {
    if (disabled) return;
    const big = Math.max(o.step, (o.max - o.min) / 10);
    let v: number | null = null;
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        v = value - o.step;
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        v = value + o.step;
        break;
      case 'PageDown':
        v = value - big;
        break;
      case 'PageUp':
        v = value + big;
        break;
      case 'Home':
        v = o.min;
        break;
      case 'End':
        v = o.max;
        break;
    }
    if (v !== null) {
      e.preventDefault();
      setValue(v, 'change');
    }
  });

  render();

  return {
    el,
    get: () => value,
    set: (v, silent = true) => setValue(v, silent ? 'none' : 'change'),
    setDisabled(d) {
      disabled = d;
      render();
    },
  };
}
