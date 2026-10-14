/**
 * Segmented control as plain words with a sliding underline. Implements the
 * ARIA radiogroup pattern: one tab stop, arrow keys move and select.
 */
import { h, placeUnderline } from '../dom';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Longer description for screen readers / tooltips. */
  hint?: string;
}

export interface SegmentedOptions<T extends string> {
  label: string;
  options: SegmentedOption<T>[];
  value: T;
  onChange?: (v: T) => void;
  /** Hide the visible label (still labelled for assistive tech). */
  hideLabel?: boolean;
}

export interface Segmented<T extends string> {
  el: HTMLElement;
  get(): T;
  set(v: T, silent?: boolean): void;
}

export function createSegmented<T extends string>(o: SegmentedOptions<T>): Segmented<T> {
  let value = o.value;
  const line = h('span', { class: 'u-line' });
  const group = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': o.label });
  const buttons = o.options.map((opt) =>
    h('button', { class: 'opt', type: 'button', role: 'radio', 'data-value': opt.value, title: opt.hint ?? null }, opt.label),
  );
  group.append(...buttons, line);

  const el = h('div', { class: 'ctl' });
  if (!o.hideLabel) el.append(h('div', { class: 'ctl-row' }, h('span', { class: 'ctl-label', 'aria-hidden': 'true' }, o.label)));
  el.append(group);

  const render = () => {
    let active: HTMLElement | null = null;
    for (const b of buttons) {
      const on = b.dataset.value === value;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on) active = b;
    }
    placeUnderline(line, group, active);
  };

  const select = (v: T, focus: boolean) => {
    const changed = v !== value;
    value = v;
    render();
    if (focus) buttons.find((b) => b.dataset.value === v)?.focus();
    if (changed) o.onChange?.(value);
  };

  buttons.forEach((b, i) => {
    b.addEventListener('click', () => select(o.options[i].value, false));
    b.addEventListener('keydown', (e) => {
      let j = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % buttons.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + buttons.length) % buttons.length;
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = buttons.length - 1;
      if (j >= 0) {
        e.preventDefault();
        select(o.options[j].value, true);
      }
    });
  });

  new ResizeObserver(render).observe(group);
  render();

  return {
    el,
    get: () => value,
    set(v, silent = true) {
      if (silent) {
        value = v;
        render();
      } else select(v, false);
    },
  };
}
