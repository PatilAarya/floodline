/** Small DOM helpers: no framework, just less typing. */

type Attrs = Record<string, string | number | boolean | null | undefined>;
type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs | null = null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'html') el.innerHTML = String(v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: Element, children: (Child | Child[])[]): void {
  for (const c of children) {
    if (Array.isArray(c)) append(el, c);
    else if (c === null || c === undefined || c === false) continue;
    else el.append(c instanceof Node ? c : String(c));
  }
}

/** Parse a trusted, static HTML string (e.g. a glyph) into a node. */
export function fromHTML(html: string): Element {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild!;
}

let idSeq = 0;
export const uid = (prefix = 'fl'): string => `${prefix}-${++idSeq}`;

/** Write a sentence to the shared polite live region for screen readers. */
export function announce(text: string): void {
  const el = document.getElementById('sr-status');
  if (!el) return;
  el.textContent = '';
  // Next frame, so repeated identical messages are still announced.
  requestAnimationFrame(() => (el.textContent = text));
}

/**
 * Position a sliding underline element under `target`, relative to `container`.
 * Used by the toggle, segmented control and nav.
 */
export function placeUnderline(line: HTMLElement, container: HTMLElement, target: HTMLElement | null): void {
  if (!target) {
    line.style.opacity = '0';
    return;
  }
  const c = container.getBoundingClientRect();
  const r = target.getBoundingClientRect();
  line.style.opacity = '1';
  line.style.width = `${r.width}px`;
  line.style.transform = `translateX(${r.left - c.left}px)`;
  // Follow the word vertically too, so wrapped segmented controls still work.
  line.style.top = `${r.bottom - c.top + 1}px`;
  line.style.bottom = 'auto';
}
