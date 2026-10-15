/**
 * A small pool of experiment workers. Seeds are handed out one at a time to
 * whichever worker is free, so fast and slow storms balance out. Results
 * stream back as they finish (in any order; each carries its job id).
 * `cancel()` terminates every worker at once.
 *
 * Without Web Workers, seeds run on the main thread one by one with a pause
 * between them, so the page stays usable between seeds (each seed still
 * blocks for a few seconds).
 */
import type { SeedResult, SeedSpec } from './experiment';
import type { ExpIn, ExpOut } from './experimentWorker';

export interface PoolCallbacks {
  onProgress(id: number, fraction: number): void;
  onResult(id: number, r: SeedResult): void;
  onError(id: number, message: string): void;
  onDone(): void;
}

export function defaultWorkerCount(): number {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  return Math.max(1, Math.min(6, cores - 1));
}

export class ExperimentPool {
  private workers: Worker[] = [];
  private queue: { id: number; spec: SeedSpec }[] = [];
  private busy = 0;
  private cancelled = false;
  private inline = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private grid: number,
    private size: number,
    private cb: PoolCallbacks,
  ) {}

  run(specs: SeedSpec[]): void {
    this.queue = specs.map((spec, id) => ({ id, spec }));
    try {
      for (let i = 0; i < Math.min(this.size, specs.length); i++) this.spawn();
    } catch {
      this.workers.forEach((w) => w.terminate());
      this.workers = [];
      this.inline = true;
      this.runInline();
    }
  }

  get usesWorkers(): boolean {
    return !this.inline;
  }

  cancel(): void {
    this.cancelled = true;
    this.queue = [];
    for (const w of this.workers) w.terminate();
    this.workers = [];
    if (this.timer) clearTimeout(this.timer);
  }

  private spawn(): void {
    const w = new Worker(new URL('./experimentWorker.ts', import.meta.url), { type: 'module' });
    this.workers.push(w);
    let current = -1;
    const next = () => {
      const job = this.queue.shift();
      if (!job) {
        w.terminate();
        this.workers = this.workers.filter((x) => x !== w);
        if (this.workers.length === 0 && !this.cancelled) this.cb.onDone();
        return;
      }
      current = job.id;
      this.busy++;
      w.postMessage({ type: 'run', id: job.id, spec: job.spec } satisfies ExpIn);
    };
    w.onmessage = (e: MessageEvent<ExpOut>) => {
      if (this.cancelled) return;
      const m = e.data;
      if (m.type === 'ready') next();
      else if (m.type === 'progress') this.cb.onProgress(m.id, m.minute / m.duration);
      else if (m.type === 'result') {
        this.busy--;
        this.cb.onResult(m.id, m.result);
        next();
      } else if (m.type === 'error') {
        if (m.id >= 0) this.busy--;
        this.cb.onError(m.id, m.message);
        if (m.id >= 0) next();
        else {
          w.terminate();
          this.workers = this.workers.filter((x) => x !== w);
          if (this.workers.length === 0 && !this.cancelled) this.cb.onDone();
        }
      }
    };
    w.onerror = (ev) => {
      ev.preventDefault();
      if (this.cancelled) return;
      this.cb.onError(current, 'an experiment worker crashed');
      w.terminate();
      this.workers = this.workers.filter((x) => x !== w);
      if (this.workers.length === 0) this.cb.onDone();
    };
    w.postMessage({ type: 'init', grid: this.grid } satisfies ExpIn);
  }

  /** Fallback: no workers. Load the world here and run seeds with breaks in between. */
  private async runInline(): Promise<void> {
    const [{ loadMumbai }, { DEFAULT_MUMBAI }, { prepareExperiment, runSeed }] = await Promise.all([import('../world/worldClient'), import('../world/mumbai'), import('./experiment')]);
    let prep;
    try {
      prep = prepareExperiment(await loadMumbai({ ...DEFAULT_MUMBAI, gridSize: this.grid }));
    } catch (err) {
      this.cb.onError(-1, err instanceof Error ? err.message : String(err));
      this.cb.onDone();
      return;
    }
    const p = prep;
    const step = () => {
      if (this.cancelled) return;
      const job = this.queue.shift();
      if (!job) {
        this.cb.onDone();
        return;
      }
      try {
        this.cb.onResult(job.id, runSeed(p, job.spec));
      } catch (err) {
        this.cb.onError(job.id, err instanceof Error ? err.message : String(err));
      }
      this.timer = setTimeout(step, 60);
    };
    this.timer = setTimeout(step, 60);
  }
}
