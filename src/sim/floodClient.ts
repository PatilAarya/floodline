/**
 * Main-thread handle on the flood engine. Prefers a Web Worker; if workers
 * are unavailable or the worker fails to start, runs the same engine on the
 * main thread (slower, but everything still works). A worker crash is
 * reported so the page can offer a restart.
 */
import { Emitter } from '../core/store';
import { FloodEngine, type FrameMsg, type InMsg, type OutMsg, type RoutesMsg } from './floodEngine';

type Events = {
  ready: { duration: number };
  frame: FrameMsg;
  routes: RoutesMsg;
  series: { from: number; stage: Float32Array; flooded: Float32Array };
  seriesTruncate: { keep: number };
  busy: { target: number; at: number };
  error: { message: string; fatal: boolean };
};

let live: FloodClient[] = [];

export class FloodClient extends Emitter<Events> {
  private worker: Worker | null = null;
  private local: FloodEngine | null = null;
  private disposed = false;
  readonly usingWorker: boolean;

  constructor() {
    super();
    let w: Worker | null = null;
    try {
      w = new Worker(new URL('./floodWorker.ts', import.meta.url), { type: 'module' });
    } catch {
      w = null;
    }
    this.usingWorker = !!w;
    if (w) {
      this.worker = w;
      w.onmessage = (e: MessageEvent<OutMsg>) => this.receive(e.data);
      w.onerror = (e) => {
        e.preventDefault();
        this.emit('error', { message: 'The flood simulation stopped unexpectedly.', fatal: true });
      };
      w.onmessageerror = () => this.emit('error', { message: 'A simulation message could not be read.', fatal: false });
    } else {
      this.local = new FloodEngine((m) => queueMicrotask(() => this.receive(m)), import.meta.env.DEV);
    }
    live.push(this);
  }

  send(m: InMsg, transfer: Transferable[] = []): void {
    if (this.disposed) return;
    if (this.worker) this.worker.postMessage(m, transfer);
    else this.local?.handle(m);
  }

  private receive(m: OutMsg): void {
    if (this.disposed) return;
    switch (m.type) {
      case 'ready':
        this.emit('ready', { duration: m.duration });
        break;
      case 'frame':
        this.emit('frame', m);
        break;
      case 'routes':
        this.emit('routes', m);
        break;
      case 'series':
        this.emit('series', m);
        break;
      case 'seriesTruncate':
        this.emit('seriesTruncate', m);
        break;
      case 'busy':
        this.emit('busy', m);
        break;
      case 'error':
        this.emit('error', { message: m.message, fatal: false });
        break;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    try {
      this.send({ type: 'dispose' });
    } catch {
      /* worker already gone */
    }
    this.disposed = true;
    this.worker?.terminate();
    this.worker = null;
    this.local = null;
    this.clear();
    live = live.filter((c) => c !== this);
  }
}

// Hot reload: terminate workers from the old module so they don't leak.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const c of [...live]) c.dispose();
  });
}
