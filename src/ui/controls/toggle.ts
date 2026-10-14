/**
 * Typographic toggle: the words "On / Off" with a sliding underline under the
 * active word. role="switch" so screen readers announce it as on/off.
 */
import { h, placeUnderline } from '../dom';

export interface ToggleOptions {
  label: string;
  value: boolean;
  onChange?: (v: boolean) => void;
  onWord?: string;
  offWord?: string;
}

export interface Toggle {
  el: HTMLElement;
  get(): boolean;
  set(v: boolean, silent?: boolean): void;
}

export function createToggle(o: ToggleOptions): Toggle {
  let value = o.value;
  const on = h('span', { class: 'opt' }, o.onWord ?? 'On');
  const off = h('span', { class: 'opt' }, o.offWord ?? 'Off');
  const line = h('span', { class: 'u-line' });
  const btn = h('button', { class: 'toggle', type: 'button', role: 'switch', 'aria-label': o.label }, on, h('span', { class: 'sep', 'aria-hidden': 'true' }, '/'), off, line);
  const el = h('div', { class: 'ctl toggle-row' }, h('span', { class: 'ctl-label', 'aria-hidden': 'true' }, o.label), btn);

  const render = () => {
    btn.setAttribute('aria-checked', String(value));
    on.dataset.active = String(value);
    off.dataset.active = String(!value);
    placeUnderline(line, btn, value ? on : off);
  };

  btn.addEventListener('click', () => {
    value = !value;
    render();
    o.onChange?.(value);
  });

  // Underline needs layout; re-place whenever size changes (fonts load, resize).
  new ResizeObserver(render).observe(btn);
  render();

  return {
    el,
    get: () => value,
    set(v, silent = true) {
      if (v === value) return;
      value = v;
      render();
      if (!silent) o.onChange?.(value);
    },
  };
}
