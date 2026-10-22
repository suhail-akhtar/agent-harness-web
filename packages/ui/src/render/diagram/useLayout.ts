/**
 * Laying a diagram out from React: ELK in the worker, results cached by their inputs, and the last
 * layout of each diagram remembered (by a stable key: an artifact's id) so the next version keeps
 * its boxes where they were. On the server (tests, no window) the layered layout runs at once.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { DiagramSpec } from '@harness/plugin-ui';
import { elkLayout } from './elk.ts';
import { layoutDiagram, layoutDiagramSync, layoutKey, type Scene } from './layout.ts';

const cache = new Map<string, Scene>();
const memory = new Map<string, Scene>();
/** Layouts in flight per stable key: the next version of a diagram waits for the one before, so it can keep its places. */
const inflight = new Map<string, Promise<unknown>>();
const remember = <K, V>(m: Map<K, V>, k: K, v: V, max: number) => { m.delete(k); m.set(k, v); if (m.size > max) m.delete(m.keys().next().value as K); };

/** The last overview layout of a diagram (by its stable key). */
export function rememberedLayout(key: string | undefined): Scene | undefined { return key ? memory.get(key) : undefined; }
export function rememberLayout(key: string | undefined, scene: Scene): void { if (key) remember(memory, key, scene, 60); }
export function forgetLayout(key: string | undefined): void { if (key) memory.delete(key); }

export interface UseLayout { scene: Scene | null; busy: boolean; error?: string }

export function useDiagramLayout(spec: DiagramSpec | undefined, o: { collapsed?: ReadonlySet<string>; stableKey?: string; fresh?: number } = {}): UseLayout {
  const collapsedKey = o.collapsed ? [...o.collapsed].sort().join('\u0000') : null;
  const key = useMemo(() => (spec ? `${layoutKey(spec, o.collapsed)}|${o.fresh ?? 0}` : ''), [spec, collapsedKey, o.fresh]); // eslint-disable-line react-hooks/exhaustive-deps
  const server = typeof window === 'undefined';
  const sync = useMemo(() => {
    if (!spec || !server) return null;
    return layoutDiagramSync(spec, { collapsed: o.collapsed });
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const [state, setState] = useState<UseLayout & { key: string }>(() => ({ key, scene: (spec && cache.get(key)) ?? sync, busy: !!spec && !cache.has(key) && !sync }));
  const live = useRef(0);
  useEffect(() => {
    if (!spec || server) return;
    const hit = cache.get(key);
    if (hit) { setState({ key, scene: hit, busy: false }); if (!o.fresh) rememberLayout(o.stableKey, hit); return; }
    const mine = ++live.current;
    setState((s) => ({ ...s, key, busy: true }));
    const before = o.stableKey ? inflight.get(o.stableKey) : undefined;
    const run = (before ?? Promise.resolve()).catch(() => {}).then(() => {
      const again = cache.get(key);
      if (again) return again;
      const previous = o.fresh ? undefined : rememberedLayout(o.stableKey);
      return layoutDiagram(spec, { collapsed: o.collapsed, previous, elk: elkLayout, fresh: !!o.fresh });
    });
    if (o.stableKey) { inflight.set(o.stableKey, run); void run.finally(() => { if (inflight.get(o.stableKey!) === run) inflight.delete(o.stableKey!); }).catch(() => {}); }
    run.then((scene) => {
      remember(cache, key, scene, 40);
      rememberLayout(o.stableKey, scene);
      if (mine === live.current) setState({ key, scene, busy: false });
    }, (e: unknown) => { if (mine === live.current) setState((s) => ({ ...s, key, busy: false, error: e instanceof Error ? e.message : String(e) })); });
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (server) return { scene: sync, busy: false };
  // Until the layout for these inputs is in, the one before stays on screen, marked busy.
  return { scene: state.scene, busy: state.busy || state.key !== key, ...(state.error ? { error: state.error } : {}) };
}
