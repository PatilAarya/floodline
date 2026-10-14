/**
 * Turns the side rail into a bottom sheet on tablets and phones (<= 1024px).
 * Three snap points: peek (just the handle and title), half, and full.
 * Drag the handle to move it; tap or press Enter to toggle peek/half;
 * arrow keys step between snap points. On desktop the handle is hidden by CSS
 * and the rail is a normal column.
 */
import { h } from './dom';

type SheetState = 'peek' | 'half' | 'full';
const ORDER: SheetState[] = ['peek', 'half', 'full'];

export interface SheetController {
  /** On small screens, raise the sheet to at least this point; no-op on desktop. */
  reveal(target?: HTMLElement, at?: 'half' | 'full'): void;
  dispose(): void;
}

export function makeSheet(rail: HTMLElement, title: string): SheetController {
  const label = h('span', { class: 'sheet-title' }, title);
  const stateWord = h('span', { class: 'sheet-state mono' });
  const handle = h('button', { class: 'sheet-handle', type: 'button', 'aria-expanded': 'false', 'aria-label': `${title} panel` }, h('span', { class: 'sheet-grip', 'aria-hidden': 'true' }), label, stateWord);
  rail.prepend(handle);
  const mq = window.matchMedia('(max-width: 1024px)');

  let state: SheetState = 'peek';
  const words: Record<SheetState, string> = { peek: 'Open', half: 'Expand', full: 'Close' };

  const visibleHeight = (s: SheetState) => {
    const full = rail.getBoundingClientRect().height;
    if (s === 'full') return full;
    if (s === 'half') return Math.min(full, window.innerHeight * (window.innerWidth >= 768 ? 0.42 : 0.5));
    return handle.getBoundingClientRect().height + 8;
  };

  const apply = (s: SheetState, animate = true) => {
    state = s;
    rail.dataset.sheet = s;
    handle.setAttribute('aria-expanded', String(s !== 'peek'));
    stateWord.textContent = words[s];
    if (!mq.matches) {
      rail.style.transform = '';
      return;
    }
    const full = rail.getBoundingClientRect().height;
    rail.style.transition = animate ? '' : 'none';
    rail.style.transform = `translateY(${Math.max(0, full - visibleHeight(s))}px)`;
  };

  let startY = 0, startT = 0, dragging = false, moved = false;
  const currentOffset = () => {
    const m = /translateY\(([-\d.]+)px\)/.exec(rail.style.transform);
    return m ? Number(m[1]) : 0;
  };
  handle.addEventListener('pointerdown', (e) => {
    if (!mq.matches) return;
    dragging = true;
    moved = false;
    startY = e.clientY;
    startT = currentOffset();
    rail.style.transition = 'none';
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 4) moved = true;
    const full = rail.getBoundingClientRect().height;
    const max = full - visibleHeight('peek');
    rail.style.transform = `translateY(${Math.min(max, Math.max(0, startT + dy))}px)`;
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    rail.style.transition = '';
    if (!moved) return;
    // Snap to the nearest point.
    const full = rail.getBoundingClientRect().height;
    const off = currentOffset();
    let best: SheetState = 'peek', bestD = Infinity;
    for (const s of ORDER) {
      const d = Math.abs(full - visibleHeight(s) - off);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    apply(best);
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('click', () => {
    if (moved) return;
    apply(state === 'peek' ? 'half' : 'peek');
  });
  handle.addEventListener('keydown', (e) => {
    const i = ORDER.indexOf(state);
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      apply(ORDER[Math.min(2, i + 1)]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      apply(ORDER[Math.max(0, i - 1)]);
    } else if (e.key === 'Escape') apply('peek');
  });

  const onMQ = () => apply(state, false);
  mq.addEventListener('change', onMQ);
  const ro = new ResizeObserver(() => apply(state, false));
  ro.observe(rail);
  window.addEventListener('orientationchange', onMQ);
  apply('peek', false);

  return {
    reveal(target, at = 'half') {
      if (mq.matches && ORDER.indexOf(state) < ORDER.indexOf(at)) apply(at);
      if (target) {
        // Scroll inside the rail so the target sits just under the sticky handle.
        const top = target.offsetTop - handle.offsetHeight - 8;
        rail.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      }
    },
    dispose() {
      mq.removeEventListener('change', onMQ);
      window.removeEventListener('orientationchange', onMQ);
      ro.disconnect();
    },
  };
}
