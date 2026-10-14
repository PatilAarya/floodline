/**
 * Main-thread access to world building. Uses a worker when available and
 * falls back to building inline. Keeps a tiny cache keyed by params so
 * switching back to a recent setting is instant.
 */
import mumbaiUrl from '../data/mumbai.json?url';
import { generateWorld } from './cityGen';
import { buildMumbaiWorld, type MumbaiRaw } from './mumbai';
import type { MumbaiParams, World, WorldParams } from './types';

const cache = new Map<string, World>();
const CACHE_MAX = 3;

let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;
const pending = new Map<number, { resolve: (w: World) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (workerBroken) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./worldWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; world?: World; error?: string }>) => {
      const job = pending.get(e.data.id);
      if (!job) return;
      pending.delete(e.data.id);
      if (e.data.world) job.resolve(e.data.world);
      else job.reject(new Error(e.data.error ?? 'world generation failed'));
    };
    worker.onerror = () => {
      workerBroken = true;
      worker?.terminate();
      worker = null;
      for (const [, job] of pending) job.reject(new Error('worker crashed'));
      pending.clear();
    };
  } catch {
    workerBroken = true;
    worker = null;
  }
  return worker;
}

function remember(key: string, w: World): World {
  cache.delete(key);
  cache.set(key, w);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return w;
}

async function buildInline(kind: 'mumbai' | 'synthetic', params: MumbaiParams | WorldParams): Promise<World> {
  if (kind === 'synthetic') return generateWorld(params as WorldParams);
  const r = await fetch(mumbaiUrl);
  if (!r.ok) throw new Error(`map data failed to load (HTTP ${r.status})`);
  return buildMumbaiWorld((await r.json()) as MumbaiRaw, params as MumbaiParams);
}

function load(kind: 'mumbai' | 'synthetic', params: MumbaiParams | WorldParams): Promise<World> {
  const key = kind + JSON.stringify(params);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(remember(key, hit));
  const w = getWorker();
  if (!w) return buildInline(kind, params).then((world) => remember(key, world));
  const id = ++seq;
  return new Promise<World>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, kind, params });
  })
    .then((world) => remember(key, world))
    .catch(() => buildInline(kind, params).then((world) => remember(key, world)));
}

export const loadMumbai = (p: MumbaiParams) => load('mumbai', p);
export const loadWorld = (p: WorldParams) => load('synthetic', p);

// Hot-module reload: never leak a worker across reloads.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    worker?.terminate();
    worker = null;
  });
}
