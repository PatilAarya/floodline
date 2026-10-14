/** Helpers shared by pages: a standard open page head and a placeholder body. */
import { h } from '../ui/dom';

export function pageHead(eyebrow: string, title: string, lede?: string): HTMLElement {
  return h('header', { class: 'page-head' }, h('p', { class: 'eyebrow' }, eyebrow), h('h1', null, title), lede ? h('p', { class: 'lede' }, lede) : null);
}

/** Body for pages that are built in a later phase. Open layout, no boxes. */
export function comingInPhase(phase: number, what: string[]): HTMLElement {
  return h(
    'div',
    { class: 'margin-grid' },
    h('p', { class: 'marker' }, `phase ${String(phase).padStart(2, '0')}`),
    h('div', null, h('p', null, 'This page is built in a later phase. It will contain:'), h('ul', null, ...what.map((w) => h('li', null, w)))),
    h('p', { class: 'annot' }, 'Work happens phase by phase, so each step can be checked and committed on its own.'),
  );
}
