/** Helpers shared by pages: a standard open page head. */
import { h } from '../ui/dom';

export function pageHead(eyebrow: string, title: string, lede?: string): HTMLElement {
  return h('header', { class: 'page-head' }, h('p', { class: 'eyebrow' }, eyebrow), h('h1', null, title), lede ? h('p', { class: 'lede' }, lede) : null);
}
