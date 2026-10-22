/**
 * One open conversation, live: its stored history folded into transcript items, then kept current
 * by its event stream (resuming from the last sequence after a drop). Also the pending requests,
 * background tasks, workflow runs, usage and status. A cache keeps the last state of recently opened
 * conversations so going back to one is instant.
 */

import { useEffect, useRef, useState } from 'react';
import { apply, fromHistory, isPending, type HarnessEvent, type Live, type PendingRequest, type SessionDetail, type SessionMeta, type SessionStatus, type TaskView, type Usage } from '@harness/client';
import { client, useData } from '../../state/data';

export interface SessionLive {
  meta: SessionMeta | null;
  status: SessionStatus;
  live: Live;
  pending: PendingRequest[];
  tasks: TaskView[];
  error: string;
  loaded: boolean;
  stream: 'open' | 'retrying' | 'closed' | 'missing' | 'connecting';
}

const EMPTY: SessionLive = { meta: null, status: 'idle', live: { items: [], contextTokens: 0, contextWindow: 0 }, pending: [], tasks: [], error: '', loaded: false, stream: 'connecting' };
const cache = new Map<string, SessionLive>();

function addUsage(m: SessionMeta, e: Extract<HarnessEvent, { kind: 'usage' }>): SessionMeta {
  const u = m.usage;
  const add: Usage = { input: u.input + e.usage.input, cacheRead: u.cacheRead + e.usage.cacheRead, cacheWrite: u.cacheWrite + e.usage.cacheWrite, output: u.output + e.usage.output, reasoning: u.reasoning + e.usage.reasoning };
  return { ...m, usage: add, cost: m.cost + e.cost };
}

/** Folds one event into the conversation's state (pure; also used by the tests). */
export function reduce(s: SessionLive, e: HarnessEvent, now = Date.now()): SessionLive {
  let next: SessionLive = { ...s, live: apply(s.live, e, now) };
  switch (e.kind) {
    case 'status': next.status = e.status; break;
    case 'permission_request': case 'question': case 'plan_proposed': case 'approval_request': next.pending = [...s.pending.filter((p) => p.requestId !== e.requestId), e]; break;
    case 'request_resolved': next.pending = s.pending.filter((p) => p.requestId !== e.requestId); break;
    case 'task': next.tasks = [...s.tasks.filter((t) => t.id !== e.task.id), e.task]; break;
    case 'usage': if (s.meta && (!e.agent || e.agent === 'main')) next.meta = addUsage(s.meta, e); break;
    case 'todos': if (s.meta) next.meta = { ...s.meta, todos: e.todos }; break;
    case 'mode': if (s.meta) next.meta = { ...s.meta, mode: e.mode }; break;
    case 'turn_start': if (next.status === 'idle') next.status = 'running'; break;
  }
  return next;
}

export function useSessionLive(id: string): [SessionLive, (f: (s: SessionLive) => SessionLive) => void] {
  const [state, setState] = useState<SessionLive>(() => cache.get(id) ?? EMPTY);
  const ref = useRef(state);
  const set = (f: (s: SessionLive) => SessionLive) => { ref.current = f(ref.current); cache.set(id, ref.current); setState(ref.current); };
  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    ref.current = cache.get(id) ?? EMPTY;
    setState(ref.current);
    const models = useData.getState().models;
    client.sessions.get(id).then((d: SessionDetail) => {
      if (cancelled) return;
      const spec = models.find((m) => m.id === d.meta.model);
      set(() => ({ meta: d.meta, status: d.status, live: { items: fromHistory(d.history), contextTokens: d.meta.lastPromptTokens, contextWindow: spec?.compactAt ?? spec?.contextWindow ?? 0 }, pending: d.pending.filter(isPending), tasks: d.tasks ?? [], error: '', loaded: true, stream: 'connecting' }));
      // A workflow run still going gets its card back.
      client.sessions.workflows(id).then((r) => { if (!cancelled) for (const run of r.runs.filter((x) => x.status === 'running' || x.status === 'waiting')) set((s) => ({ ...s, live: apply(s.live, { kind: 'workflow', phase: 'started', run }) })); }).catch(() => {});
      stop = client.sessions.events(id, d.lastSeq, (e) => {
        set((s) => reduce(s, e));
        if (e.kind === 'turn_end' && !e.agent) client.sessions.get(id).then((dd) => set((s) => ({ ...s, meta: dd.meta, status: dd.status, tasks: dd.tasks ?? s.tasks }))).catch(() => {});
      }, (st) => set((s) => ({ ...s, stream: st })));
    }).catch((e: Error) => { if (!cancelled) set((s) => ({ ...s, error: e.message, loaded: true })); });
    return () => { cancelled = true; stop?.(); };
  }, [id]);
  return [state, set];
}
