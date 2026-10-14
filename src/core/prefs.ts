/**
 * User preferences (quality). Persisted in localStorage when available;
 * every access is wrapped because storage can throw (private mode, blocked
 * site data, sandboxed previews). The app works fully without it.
 * The site uses a single light theme.
 */
import { createStore } from './store';

export type Quality = 'auto' | 'high' | 'low';

const KEY_QUALITY = 'floodline.quality';

export function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: preference lasts for this visit only */
  }
}

function initialQuality(): Quality {
  const q = safeGet(KEY_QUALITY);
  return q === 'high' || q === 'low' || q === 'auto' ? q : 'auto';
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export const prefs = createStore({
  quality: initialQuality(),
  reducedMotion: prefersReducedMotion(),
});

export function setQuality(quality: Quality): void {
  safeSet(KEY_QUALITY, quality);
  prefs.set({ quality });
}

/** Follow the OS reduced-motion setting live. */
export function watchSystemPrefs(): void {
  try {
    window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => {
      prefs.set({ reducedMotion: e.matches });
    });
  } catch {
    /* old browsers without addEventListener on MediaQueryList */
  }
}
