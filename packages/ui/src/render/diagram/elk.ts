/**
 * Running ELK: in a worker when the page can start one (the desktop), else on this thread (loaded
 * on first use). A layout that takes too long or fails is refused, and the caller falls back to
 * the layered layout, so a diagram always draws.
 */

import type { ElkGraph, ElkResult } from './layout.ts';

let worker: Worker | null | undefined;
let seq = 0;
const waiting = new Map<number, { resolve: (r: ElkResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

function startWorker(): Worker | null {
  if (worker !== undefined) return worker;
  worker = null;
  if (typeof Worker === 'undefined' || typeof window === 'undefined') return null;
  try {
    const w = new Worker(new URL('./elk.worker.ts', import.meta.url), { type: 'module', name: 'diagram-layout' });
    w.onmessage = (ev: MessageEvent<{ id: number; result?: ElkResult; error?: string }>) => {
      const p = waiting.get(ev.data.id);
      if (!p) return;
      waiting.delete(ev.data.id);
      clearTimeout(p.timer);
      if (ev.data.result) p.resolve(ev.data.result); else p.reject(new Error(ev.data.error ?? 'layout failed'));
    };
    w.onerror = (e) => {
      // A worker that cannot load: every waiting layout falls back, and later ones run on this thread.
      e.preventDefault?.();
      worker = null;
      for (const [id, p] of waiting) { clearTimeout(p.timer); p.reject(new Error('the layout worker stopped')); waiting.delete(id); }
      try { w.terminate(); } catch { /* gone */ }
    };
    worker = w;
  } catch { worker = null; }
  return worker;
}

let inThread: Promise<{ layout(g: unknown): Promise<unknown> }> | null = null;
async function elkHere(): Promise<{ layout(g: unknown): Promise<unknown> }> {
  inThread ??= import('elkjs/lib/elk.bundled.js').then((m) => {
    const Ctor = ((m as unknown as { default?: unknown }).default ?? m) as new () => { layout(g: unknown): Promise<unknown> };
    return new Ctor();
  });
  return inThread;
}

/** Lays a graph out with ELK; rejects after `timeoutMs` (the caller falls back). */
export function elkLayout(graph: ElkGraph, timeoutMs = 20_000): Promise<ElkResult> {
  const w = startWorker();
  if (!w) {
    return Promise.race([
      elkHere().then((elk) => elk.layout(graph) as Promise<ElkResult>),
      new Promise<ElkResult>((_, reject) => setTimeout(() => reject(new Error('the layout took too long')), timeoutMs)),
    ]);
  }
  const id = ++seq;
  return new Promise<ElkResult>((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error('the layout took too long')); }, timeoutMs);
    waiting.set(id, { resolve, reject, timer });
    w.postMessage({ id, graph });
  });
}
