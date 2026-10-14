/**
 * Hash router. URLs look like  #/simulator?seed=delta&rain=0.8
 * Hash routing means any static host works without rewrite rules.
 *
 * Pages are lazy modules exporting a default `Page`. Mounting returns an
 * optional cleanup function, called before the next page mounts. Each mount
 * also gets an AbortSignal that is aborted on unmount, so pages can tie
 * listeners, workers and animation loops to it.
 */
export interface PageContext {
  root: HTMLElement;
  params: URLSearchParams;
  signal: AbortSignal;
}

export interface Page {
  title: string;
  mount(ctx: PageContext): void | (() => void) | Promise<void | (() => void)>;
}

export type PageLoader = () => Promise<{ default: Page }>;

export interface Route {
  path: string;
  params: URLSearchParams;
}

export function parseHash(hash: string = location.hash): Route {
  let h = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!h.startsWith('/')) h = '/' + h;
  const q = h.indexOf('?');
  const rawPath = q === -1 ? h : h.slice(0, q);
  const query = q === -1 ? '' : h.slice(q + 1);
  // Normalise: lowercase, strip trailing slash, only allow safe characters.
  let path = rawPath.toLowerCase().replace(/\/+$/, '') || '/';
  if (!/^\/[a-z0-9\-/]*$/.test(path)) path = '/';
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(query);
  } catch {
    params = new URLSearchParams();
  }
  return { path, params };
}

export function buildHash(path: string, params?: URLSearchParams | Record<string, string | number | boolean>): string {
  const p = params instanceof URLSearchParams ? params : new URLSearchParams();
  if (params && !(params instanceof URLSearchParams)) {
    for (const [k, v] of Object.entries(params)) p.set(k, String(v));
  }
  const qs = p.toString();
  return '#' + path + (qs ? '?' + qs : '');
}

/** Replace the query part of the current hash without triggering navigation. */
export function replaceParams(params: URLSearchParams | Record<string, string | number | boolean>): void {
  const { path } = parseHash();
  const hash = buildHash(path, params);
  try {
    history.replaceState(history.state, '', hash);
  } catch {
    /* some sandboxes forbid history access; the URL simply won't update */
  }
}

export interface RouterOptions {
  routes: Record<string, PageLoader>;
  fallback: string;
  /** Called around a page swap so the shell can animate. */
  transition?: (swap: () => Promise<void>, from: string | null, to: string) => Promise<void>;
  onRoute?: (route: Route, page: Page) => void;
  onError?: (err: unknown, route: Route) => void;
}

export class Router {
  private current: { path: string; cleanup?: () => void; abort: AbortController } | null = null;
  private navSeq = 0;
  private root: HTMLElement;
  private opts: RouterOptions;

  constructor(root: HTMLElement, opts: RouterOptions) {
    this.root = root;
    this.opts = opts;
    window.addEventListener('hashchange', () => void this.resolve());
  }

  get path(): string | null {
    return this.current?.path ?? null;
  }

  start(): Promise<void> {
    return this.resolve();
  }

  navigate(path: string, params?: Record<string, string | number | boolean>): void {
    const hash = buildHash(path, params);
    if (location.hash === hash) void this.resolve();
    else location.hash = hash;
  }

  private async resolve(): Promise<void> {
    const route = parseHash();
    const known = route.path in this.opts.routes;
    const path = known ? route.path : this.opts.fallback;
    // A param-only change (e.g. the back button) remounts the same page, which
    // then reads its params afresh. Pages update params silently with
    // replaceParams(), which does not come through here.

    const seq = ++this.navSeq;
    const from = this.current?.path ?? null;

    // Start fetching the page chunk now, so it loads during the transition.
    const loading = this.opts.routes[path]();
    loading.catch(() => undefined);

    const swap = async () => {
      let mod: { default: Page };
      try {
        mod = await loading;
      } catch (err) {
        this.opts.onError?.(err, route);
        return;
      }
      if (seq !== this.navSeq) return; // a newer navigation won
      this.unmount();
      const abort = new AbortController();
      this.root.replaceChildren();
      this.root.scrollTop = 0;
      window.scrollTo(0, 0);
      let cleanup: void | (() => void) = undefined;
      try {
        cleanup = await mod.default.mount({ root: this.root, params: route.params, signal: abort.signal });
      } catch (err) {
        this.opts.onError?.(err, route);
      }
      this.current = { path, abort, cleanup: cleanup || undefined };
      this.opts.onRoute?.({ path, params: route.params }, mod.default);
    };

    if (this.opts.transition && from !== null && from !== path) await this.opts.transition(swap, from, path);
    else await swap();
  }

  private unmount(): void {
    if (!this.current) return;
    try {
      this.current.cleanup?.();
    } catch (err) {
      console.error('page cleanup failed', err);
    }
    this.current.abort.abort();
    this.current = null;
  }
}
