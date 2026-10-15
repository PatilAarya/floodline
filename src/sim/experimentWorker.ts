/// <reference lib="webworker" />
/**
 * One worker of the experiment pool. It builds the Mumbai world once (the
 * map data is fetched here, then cached by the browser), then runs seeds one
 * at a time as the page hands them out, reporting progress every 30
 * simulated minutes and the result at the end.
 */
import mumbaiUrl from '../data/mumbai.json?url';
import { DEFAULT_MUMBAI, buildMumbaiWorld, type MumbaiRaw } from '../world/mumbai';
import { prepareExperiment, runSeed, type ExperimentPrep, type SeedResult, type SeedSpec } from './experiment';

export type ExpIn = { type: 'init'; grid: number } | { type: 'run'; id: number; spec: SeedSpec };
export type ExpOut =
  | { type: 'ready' }
  | { type: 'progress'; id: number; minute: number; duration: number }
  | { type: 'result'; id: number; result: SeedResult }
  | { type: 'error'; id: number; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
let prep: Promise<ExperimentPrep> | null = null;

scope.onmessage = async (e: MessageEvent<ExpIn>) => {
  const m = e.data;
  if (m.type === 'init') {
    prep = fetch(mumbaiUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`map data failed to load (HTTP ${r.status})`);
        return r.json() as Promise<MumbaiRaw>;
      })
      .then((raw) => prepareExperiment(buildMumbaiWorld(raw, { ...DEFAULT_MUMBAI, gridSize: m.grid })));
    try {
      await prep;
      post({ type: 'ready' });
    } catch (err) {
      post({ type: 'error', id: -1, message: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  try {
    if (!prep) throw new Error('worker not initialised');
    const p = await prep;
    const result = runSeed(p, m.spec, undefined, (minute, duration) => post({ type: 'progress', id: m.id, minute, duration }));
    post({ type: 'result', id: m.id, result });
  } catch (err) {
    post({ type: 'error', id: m.id, message: err instanceof Error ? err.message : String(err) });
  }
};

function post(m: ExpOut) {
  scope.postMessage(m);
}
