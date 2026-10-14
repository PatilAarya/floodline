/// <reference lib="webworker" />
/**
 * Web Worker host for the flood engine. All heavy computation (the shallow
 * water model, edge states) happens here; frames are sent to the main
 * thread with their typed arrays transferred, not copied.
 */
import { FloodEngine, type InMsg, type OutMsg } from './floodEngine';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const engine = new FloodEngine((m: OutMsg, transfer?: Transferable[]) => scope.postMessage(m, transfer ?? []), import.meta.env.DEV);
scope.onmessage = (e: MessageEvent<InMsg>) => engine.handle(e.data);
