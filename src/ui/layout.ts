/**
 * Site shell: wordmark, text-only nav with a sliding underline, a full-screen text menu on small screens, and the water-line page
 * transition.
 */
import { prefs } from '../core/prefs';
import { h, fromHTML, placeUnderline } from './dom';
import { glyph } from './glyphs';

export interface NavItem {
  path: string;
  label: string;
}

export const NAV: NavItem[] = [
  { path: '/simulator', label: 'Simulator' },
  { path: '/algorithms', label: 'Algorithms' },
  { path: '/bayes', label: 'Bayes' },
  { path: '/assignment', label: 'Assignment' },
  { path: '/experiments', label: 'Experiments' },
  { path: '/viva', label: 'Viva' },
];

export interface Shell {
  setActive(path: string): void;
}

export function buildShell(header: HTMLElement): Shell {
  const mark = fromHTML(glyph('mark'));
  const wordmark = h('a', { class: 'wordmark', href: '#/', 'aria-label': 'Floodline, home' }, mark, h('span', null, 'Floodline'));

  const links = NAV.map((n) => h('a', { href: '#' + n.path, 'data-path': n.path }, n.label));
  const underline = h('span', { class: 'nav-underline', 'aria-hidden': 'true' });
  const nav = h('nav', { class: 'nav', 'aria-label': 'Main' }, ...links, underline);

  const menuBtn = h('button', { class: 'menu-button', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'menu-sheet' }, 'Menu');
  const tools = h('div', { class: 'header-tools' }, menuBtn);
  header.append(wordmark, nav, tools);

  // Small-screen menu: big words, numbered, separated by hairlines.
  const sheetLinks = [{ path: '/', label: 'Home' }, ...NAV].map((n, i) =>
    h('a', { href: '#' + n.path, 'data-path': n.path }, h('span', { class: 'mono' }, String(i).padStart(2, '0')), n.label),
  );
  const closeBtn = h('button', { class: 'btn', type: 'button' }, 'Close');
  const sheet = h(
    'div',
    { class: 'menu-sheet', id: 'menu-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Site menu', 'data-open': 'false' },
    h('div', { class: 'menu-sheet-top' }, h('span', { class: 'wordmark' }, fromHTML(glyph('mark')), h('span', null, 'Floodline')), closeBtn),
    h('nav', { 'aria-label': 'Site' }, ...sheetLinks),
  );
  document.body.append(sheet);

  let lastFocus: HTMLElement | null = null;
  const setOpen = (open: boolean) => {
    sheet.dataset.open = String(open);
    menuBtn.setAttribute('aria-expanded', String(open));
    document.body.style.overflow = open ? 'hidden' : '';
    if (open) {
      lastFocus = document.activeElement as HTMLElement | null;
      requestAnimationFrame(() => closeBtn.focus());
    } else lastFocus?.focus();
  };
  menuBtn.addEventListener('click', () => setOpen(true));
  closeBtn.addEventListener('click', () => setOpen(false));
  sheet.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('a')) setOpen(false);
  });
  sheet.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false);
    if (e.key === 'Tab') {
      // Keep focus inside the open menu.
      const f: HTMLElement[] = [closeBtn, ...sheetLinks];
      const i = f.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && i <= 0) {
        e.preventDefault();
        f[f.length - 1].focus();
      } else if (!e.shiftKey && i === f.length - 1) {
        e.preventDefault();
        f[0].focus();
      }
    }
  });
  window.matchMedia('(min-width: 861px)').addEventListener('change', (e) => {
    if (e.matches && sheet.dataset.open === 'true') setOpen(false);
  });

  let active = '/';
  const placeNav = () => placeUnderline(underline, nav, links.find((a) => a.dataset.path === active) ?? null);
  new ResizeObserver(placeNav).observe(nav);
  if (document.fonts) void document.fonts.ready.then(placeNav);

  return {
    setActive(path) {
      active = path;
      for (const a of [...links, ...sheetLinks]) {
        if (a.dataset.path === path) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
      }
      placeNav();
    },
  };
}

/**
 * Water-line wipe: the tinted water rises over the page, the page swaps
 * underneath, then the water drains upward. Skipped with reduced motion.
 */
export function waterWipe(el: HTMLElement) {
  return async (swap: () => Promise<void>): Promise<void> => {
    if (prefs.get().reducedMotion || document.hidden || typeof el.animate !== 'function') {
      await swap();
      return;
    }
    const ease = 'cubic-bezier(0.65, 0, 0.35, 1)';
    const below = 'translateY(calc(100% + 40px))';
    const above = 'translateY(calc(-100% - 40px))';
    const rising = el.animate([{ transform: below }, { transform: 'translateY(0)' }], { duration: 300, easing: ease, fill: 'forwards' });
    await settle(rising, 300);
    await swap();
    const draining = el.animate([{ transform: 'translateY(0)' }, { transform: above }], { duration: 380, easing: ease, fill: 'forwards' });
    await settle(draining, 380);
    rising.cancel();
    draining.cancel();
  };
}

/**
 * Wait for an animation, but never longer than its duration plus a margin:
 * hidden or throttled documents may never resolve `finished`, and navigation
 * must not hang on decoration.
 */
function settle(anim: Animation, ms: number): Promise<void> {
  return Promise.race([
    anim.finished.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((r) => window.setTimeout(r, ms + 150)),
  ]);
}
