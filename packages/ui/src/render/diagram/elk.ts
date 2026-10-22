/**
 * Running ELK: in a worker when the page can start one (the desktop), else on this thread (loaded
 * on first use). A layout that takes too long or fails is refused, and the caller falls back to
 * the layered layout, so a diagram always draws.
 *
 * The worker is ELK's own worker build (elk.worker.ts) driven by elk-api; elk.bundled.js runs only
 * on a page (inside a worker it takes the worker for its host and has no ELK to give).
 */

import ElkApi from 'elkjs/lib/elk-api.js';
import type { ElkGraph, ElkResult } from './layout.ts';

type Elk = { layout(g: unknown): Promise<unknown> };
let viaWorker: Elk | null | undefined;
let broken = false;
let lastError = '';

/** ELK through a worker (elk-api posting to ELK's worker build), when the page can start one. */
function workerElk(): Elk | null {
  if (viaWorker !== undefined) return broken ? null : viaWorker;
  viaWorker = null;
  if (typeof Worker === 'undefined' || typeof window === 'undefined') return null;
  try {
    const Ctor = ((ElkApi as unknown as { default?: unknown }).default ?? ElkApi) as new (o: { workerFactory: () => Worker }) => Elk;
    viaWorker = new Ctor({
      workerFactory: () => {
        const w = new Worker(new URL('./elk.worker.ts', import.meta.url), { type: 'module', name: 'diagram-layout' });
        // A worker that cannot load: this layout falls back, later ones run on this thread.
        w.addEventListener('error', (e) => { e.preventDefault(); broken = true; lastError = e.message || 'it did not load'; });
        return w;
      },
    });
  } catch { viaWorker = null; }
  return viaWorker;
}

let inThread: Promise<Elk> | null = null;
async function elkHere(): Promise<Elk> {
  inThread ??= import('elkjs/lib/elk.bundled.js').then((m) => {
    const Ctor = ((m as unknown as { default?: unknown }).default ?? m) as new () => Elk;
    return new Ctor();
  });
  return inThread;
}

/** Lays a graph out with ELK; rejects after `timeoutMs`, or when the worker breaks (the caller falls back). */
export function elkLayout(graph: ElkGraph, timeoutMs = 20_000): Promise<ElkResult> {
  const w = workerElk();
  const run = (w ? w.layout(graph) : elkHere().then((elk) => elk.layout(graph))) as Promise<ElkResult>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  const stop = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('the layout took too long')), timeoutMs);
    if (w) poll = setInterval(() => { if (broken) reject(new Error(`the layout worker stopped: ${lastError}`)); }, 150);
  });
  return Promise.race([run, stop]).finally(() => { clearTimeout(timer); clearInterval(poll); });
}
