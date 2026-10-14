/**
 * A tiny observable store. No framework: state is a plain object, `set`
 * shallow-merges a patch, and subscribers are called synchronously with the
 * new and previous state. `select` subscribes to one derived value and only
 * fires when it changes (Object.is).
 */
export type Listener<T> = (state: T, prev: T) => void;

export interface Store<T extends object> {
  get(): T;
  set(patch: Partial<T> | ((s: T) => Partial<T>)): void;
  subscribe(fn: Listener<T>): () => void;
  select<U>(pick: (s: T) => U, fn: (value: U, prev: U) => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<Listener<T>>();

  return {
    get: () => state,
    set(patch) {
      const p = typeof patch === 'function' ? patch(state) : patch;
      let changed = false;
      for (const k in p) {
        if (!Object.is((state as Record<string, unknown>)[k], (p as Record<string, unknown>)[k])) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
      const prev = state;
      state = { ...state, ...p };
      for (const fn of [...listeners]) fn(state, prev);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    select(pick, fn) {
      let last = pick(state);
      const l: Listener<T> = (s) => {
        const next = pick(s);
        if (!Object.is(next, last)) {
          const prev = last;
          last = next;
          fn(next, prev);
        }
      };
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

/** Minimal typed event emitter for things that are events, not state. */
export class Emitter<E extends Record<string, unknown>> {
  private map = new Map<keyof E, Set<(payload: never) => void>>();

  on<K extends keyof E>(type: K, fn: (payload: E[K]) => void): () => void {
    let set = this.map.get(type);
    if (!set) this.map.set(type, (set = new Set()));
    set.add(fn as (payload: never) => void);
    return () => set!.delete(fn as (payload: never) => void);
  }

  emit<K extends keyof E>(type: K, payload: E[K]): void {
    const set = this.map.get(type);
    if (!set) return;
    for (const fn of [...set]) (fn as (p: E[K]) => void)(payload);
  }

  clear(): void {
    this.map.clear();
  }
}
