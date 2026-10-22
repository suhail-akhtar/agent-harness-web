/**
 * core.diagrams talking to the engine: read and save versions of a diagram artifact, follow new
 * versions as they arrive (the global event stream, with polling while an answer is awaited), the
 * message that asks the agent for a change, and the code map's import scan.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { withPositions } from '@harness/plugin-ui';
import { toast } from '@harness/ui';
import { client, globalBus } from '../../state/data';
import type { ImportScan } from './codemap';
import { changedBetween, type Changed } from './api-pure';

export { askMessage, changedBetween, type Changed } from './api-pure';

export interface ArtifactVersionDoc { meta: { id: string; title: string; kind: string; version: number }; version: number; content: string }

export function getArtifact(sessionId: string, id: string, version?: number): Promise<ArtifactVersionDoc> {
  return client.request<ArtifactVersionDoc>('GET', `/api/sessions/${sessionId}/artifacts/${encodeURIComponent(id)}${version ? `?version=${version}` : ''}`);
}

export function saveArtifact(sessionId: string, id: string, content: string, baseVersion?: number): Promise<{ version: number }> {
  return client.request<{ version: number }>('PUT', `/api/sessions/${sessionId}/artifacts/${encodeURIComponent(id)}`, { content, ...(baseVersion !== undefined ? { baseVersion } : {}) });
}

export function scanImports(sessionId: string, path = ''): Promise<ImportScan> {
  return client.request<ImportScan>('GET', `/api/sessions/${sessionId}/files/imports?path=${encodeURIComponent(path)}`);
}

export interface LiveArtifact {
  doc: ArtifactVersionDoc | null;
  error: string;
  changed: Changed | null;
  clearChanged(): void;
  /** Waits for the next version (after asking the agent): polls as well as listening. */
  expectNewVersion(): void;
  waiting: boolean;
  /** Saves positions as a new version (the canvas's drag), merging onto a newer version when there is one. */
  savePositions(p: Record<string, { x: number; y: number }>): void;
}

/** A diagram artifact, live: the latest version, updated in place with its changes marked. */
export function useLiveArtifact(sessionId: string, id: string, opts: { compareTo?: number } = {}): LiveArtifact {
  const [doc, setDoc] = useState<ArtifactVersionDoc | null>(null);
  const [error, setError] = useState('');
  const [changed, setChanged] = useState<Changed | null>(null);
  const [waiting, setWaiting] = useState(false);
  const cur = useRef<ArtifactVersionDoc | null>(null);
  const own = useRef(new Set<number>());
  /**
   * What the marks are counted from: the version the person last looked at (opened, or cleared the
   * marks on). An agent often changes a diagram in several small edits; the marks add up over them.
   */
  const baseline = useRef<ArtifactVersionDoc | null>(null);
  const take = useCallback((next: ArtifactVersionDoc, mark: boolean) => {
    const prev = cur.current;
    cur.current = next;
    if (!baseline.current) baseline.current = next;
    setDoc(next);
    if (mark && prev && next.version > prev.version && !own.current.has(next.version)) {
      const c = changedBetween(baseline.current.content, next.content, next.version);
      setChanged(c);
      if (c) toast(`${next.meta.title}: ${c.note}`, { kind: 'info' });
      setWaiting(false);
    }
  }, []);
  const refresh = useCallback(async (mark: boolean) => {
    try {
      const latest = await getArtifact(sessionId, id);
      if (!cur.current || latest.version !== cur.current.version) take(latest, mark);
      setError('');
    } catch (e) { setError((e as Error).message); }
  }, [sessionId, id, take]);
  useEffect(() => {
    cur.current = null; baseline.current = null; setDoc(null); setChanged(null);
    let alive = true;
    void (async () => {
      try {
        const latest = await getArtifact(sessionId, id);
        if (!alive) return;
        // Opened from an update: the marks count from the version before it.
        const before = opts.compareTo && opts.compareTo < latest.version ? await getArtifact(sessionId, id, opts.compareTo).catch(() => null) : null;
        if (!alive) return;
        if (before) baseline.current = before;
        take(latest, false);
        if (before) setChanged(changedBetween(before.content, latest.content, latest.version));
      } catch (e) { if (alive) setError((e as Error).message); }
    })();
    const off = globalBus.on((e) => {
      const p = (e.payload ?? {}) as { sessionId?: string; id?: string; version?: number };
      if (e.topic === 'artifacts' && p.sessionId === sessionId && p.id === id && (p.version ?? 0) > (cur.current?.version ?? 0)) void refresh(true);
    });
    return () => { alive = false; off(); };
  }, [sessionId, id]); // eslint-disable-line react-hooks/exhaustive-deps
  // While an answer is awaited: look every few seconds too (the stream may be polling, or down).
  useEffect(() => {
    if (!waiting) return;
    const started = Date.now();
    const t = setInterval(() => { if (Date.now() - started > 10 * 60_000) { setWaiting(false); return; } void refresh(true); }, 3000);
    return () => clearInterval(t);
  }, [waiting, refresh]);
  const pending = useRef<{ timer?: ReturnType<typeof setTimeout>; positions?: Record<string, { x: number; y: number }> }>({});
  const savePositions = useCallback((positions: Record<string, { x: number; y: number }>) => {
    pending.current.positions = positions;
    clearTimeout(pending.current.timer);
    pending.current.timer = setTimeout(async () => {
      const p = pending.current.positions;
      const base = cur.current;
      if (!p || !base) return;
      const write = async (on: ArtifactVersionDoc) => {
        const content = withPositions(on.content, p);
        const r = await saveArtifact(sessionId, id, content, on.version);
        own.current.add(r.version);
        take({ ...on, version: r.version, meta: { ...on.meta, version: r.version }, content }, false);
      };
      try { await write(base); } catch (e) {
        // The agent saved a newer version meanwhile: put the positions on that one.
        if ((e as { status?: number }).status === 409) {
          try { const latest = await getArtifact(sessionId, id); take(latest, true); await write(latest); return; } catch (e2) { toast(`The layout was not saved: ${(e2 as Error).message}`, { kind: 'warning' }); return; }
        }
        toast(`The layout was not saved: ${(e as Error).message}`, { kind: 'warning' });
      }
    }, 500);
  }, [sessionId, id, take]);
  return { doc, error, changed, clearChanged: () => { baseline.current = cur.current; setChanged(null); }, expectNewVersion: () => setWaiting(true), waiting, savePositions };
}
