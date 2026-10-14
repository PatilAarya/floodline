// Self-hosted fonts (latin subset only, font-display: swap).
import '@fontsource/instrument-sans/latin-400.css';
import '@fontsource/instrument-sans/latin-500.css';
import '@fontsource/instrument-sans/latin-600.css';
import '@fontsource/bricolage-grotesque/latin-700.css';
import '@fontsource/bricolage-grotesque/latin-800.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';

import './styles/tokens.css';
import './styles/base.css';
import './styles/type.css';
import './styles/layout.css';
import './styles/motion.css';

import { watchSystemPrefs } from './core/prefs';
import { Router, type PageLoader } from './core/router';
import { announce, h } from './ui/dom';
import { buildShell, waterWipe } from './ui/layout';

const routes: Record<string, PageLoader> = {
  '/': () => import('./pages/home'),
  '/simulator': () => import('./pages/simulator'),
  '/algorithms': () => import('./pages/algorithms'),
  '/bayes': () => import('./pages/bayes'),
  '/assignment': () => import('./pages/assignment'),
  '/experiments': () => import('./pages/experiments'),
  '/viva': () => import('./pages/viva'),
  '/kit': () => import('./pages/kit'),
};

function boot(): void {
  watchSystemPrefs();

  const header = document.getElementById('site-header')!;
  const main = document.getElementById('main')!;
  const wipeEl = document.getElementById('wipe')!;
  const shell = buildShell(header);
  const wipe = waterWipe(wipeEl);
  let first = true;

  const router = new Router(main, {
    routes,
    fallback: '/',
    transition: (swap) => wipe(swap),
    onRoute(route, page) {
      shell.setActive(route.path);
      document.title = route.path === '/' ? 'Floodline: dynamic flood evacuation planner' : `${page.title} | Floodline`;
      document.body.dataset.route = route.path.slice(1) || 'home';
      if (!first) {
        // Move focus to the new content for keyboard and screen-reader users.
        main.focus({ preventScroll: true });
        announce(`${page.title} page`);
      }
      first = false;
    },
    onError(err) {
      console.error(err);
      main.replaceChildren(
        h(
          'div',
          { class: 'page' },
          h('p', { class: 'eyebrow' }, 'Something went wrong'),
          h('h1', null, 'This page failed to load'),
          h('p', null, 'If you are offline, reconnect and try again. Otherwise reload the page; nothing you set is lost because scenarios live in the address bar.'),
          h('p', null, h('button', { class: 'btn btn-primary', type: 'button' }, 'Reload')),
        ),
      );
      main.querySelector('button')?.addEventListener('click', () => location.reload());
    },
  });
  void router.start();
}

boot();
