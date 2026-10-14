/// <reference lib="webworker" />
/**
 * Builds worlds off the main thread so the UI never stalls. For the Mumbai
 * map the worker fetches the bundled map data itself (about 1 MB, cached by
 * the browser) and turns it into the World structure.
 */
import mumbaiUrl from '../data/mumbai.json?url';
import { generateWorld } from './cityGen';
import { buildMumbaiWorld, type MumbaiRaw } from './mumbai';
import type { MumbaiParams, WorldParams } from './types';

export type WorldRequest = { id: number; kind: 'mumbai'; params: MumbaiParams } | { id: number; kind: 'synthetic'; params: WorldParams };

let raw: Promise<MumbaiRaw> | null = null;
const loadRaw = () =>
  (raw ??= fetch(mumbaiUrl).then((r) => {
    if (!r.ok) throw new Error(`map data failed to load (HTTP ${r.status})`);
    return r.json() as Promise<MumbaiRaw>;
  }).catch((e) => {
    raw = null; // allow a retry
    throw e;
  }));

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = async (e: MessageEvent<WorldRequest>) => {
  const req = e.data;
  try {
    const world = req.kind === 'mumbai' ? buildMumbaiWorld(await loadRaw(), req.params) : generateWorld(req.params);
    scope.postMessage({ id: req.id, world });
  } catch (err) {
    scope.postMessage({ id: req.id, error: err instanceof Error ? err.message : String(err) });
  }
};
