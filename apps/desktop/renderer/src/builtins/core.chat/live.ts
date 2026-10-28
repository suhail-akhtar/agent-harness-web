/**
 * One open conversation, live: its stored history folded into transcript items, then kept current
 * by its event stream (resuming from the last sequence after a drop). Also the pending requests,
 * background tasks, workflow runs, sub-agents, usage per model and status.
 *
 * One store per conversation, shared: the transcript, the Agents and Artifacts panels and a split
 * view of the same conversation read the same state over one event stream. A cache keeps the last
 * state of recently opened conversations so going back to one is instant.
 */

import { useEffect, useState } from 'react';
import { apply, fromHistory, isPending, type HarnessEvent, type Live, type Message, type WorkflowRunView, type PendingRequest, type SessionDetail, type SessionMeta, type SessionStatus, type TaskView, type Usage } from '@harness/client';
import { client, dispatchClientCall, useData } from '../../state/data';
import { addModelUsage, agentsFromItems, foldAgent, withTrace, type Agents } from '../../state/agents';

export interface SessionLive {
  meta: SessionMeta | null;
  status: SessionStatus;
  live: Live;
  pending: PendingRequest[];
  tasks: TaskView[];
  /** Sub-agents by name. */
  agents: Agents;
  /** Bumped on every artifact event (the Artifacts panel reloads its list). */
  artifactsSeq: number;
  /** Proposals resolved since the page opened: id -> started (with the new session) / dismissed / expired. */
  resolved: Record<string, { status: string; sessionId?: string }>;
  error: string;
  loaded: boolean;
  stream: 'open' | 'retrying' | 'closed' | 'missing' | 'connecting';
}

const EMPTY: SessionLive = { meta: null, status: 'idle', live: { items: [], contextTokens: 0, contextWindow: 0 }, pending: [], tasks: [], agents: {}, artifactsSeq: 0, resolved: {}, error: '', loaded: false, stream: 'connecting' };

function addUsage(m: SessionMeta, e: Extract<HarnessEvent, { kind: 'usage' }>): SessionMeta {
  const u = m.usage;
  const add: Usage = { input: u.input + e.usage.input, cacheRead: u.cacheRead + e.usage.cacheRead, cacheWrite: u.cacheWrite + e.usage.cacheWrite, output: u.output + e.usage.output, reasoning: u.reasoning + e.usage.reasoning };
  return { ...m, usage: add, cost: m.cost + e.cost };
}

/** Folds one event into the conversation's state (pure; also used by the tests). */
export function reduce(s: SessionLive, e: HarnessEvent, now = Date.now()): SessionLive {
  const next: SessionLive = { ...s, live: apply(s.live, e, now) };
  const agents = foldAgent(s.agents, e, now);
  if (agents !== s.agents) next.agents = agents;
  switch (e.kind) {
    case 'status': next.status = e.status; break;
    case 'permission_request': case 'question': case 'plan_proposed': case 'approval_request': next.pending = [...s.pending.filter((p) => p.requestId !== e.requestId), e]; break;
    case 'request_resolved': next.pending = s.pending.filter((p) => p.requestId !== e.requestId); break;
    case 'task': next.tasks = [...s.tasks.filter((t) => t.id !== e.task.id), e.task]; break;
    case 'usage':
      if (s.meta) {
        const m = !e.agent || e.agent === 'main' ? addUsage(s.meta, e) : { ...s.meta, cost: s.meta.cost + e.cost };
        next.meta = { ...m, byModel: addModelUsage(s.meta.byModel, e) };
      }
      break;
    case 'todos': if (s.meta) next.meta = { ...s.meta, todos: e.todos }; break;
    case 'mode': if (s.meta) next.meta = { ...s.meta, mode: e.mode }; break;
    case 'turn_start': if (next.status === 'idle' && (!e.agent || e.agent === 'main')) next.status = 'running'; break;
    case 'artifact': next.artifactsSeq = s.artifactsSeq + 1; break;
    case 'proposal_resolved': next.resolved = { ...s.resolved, [e.id]: { status: e.status, ...(e.sessionId ? { sessionId: e.sessionId } : {}) } }; break;
    case 'side_session': if (s.meta && e.phase === 'started' && !(s.meta.linked ?? []).includes(e.id)) next.meta = { ...s.meta, linked: [...(s.meta.linked ?? []), e.id] }; break;
    case 'chapter': if (s.meta) next.meta = { ...s.meta, chapters: [...(s.meta.chapters ?? []).filter((c) => c.index !== e.index), { index: e.index, title: e.title, ...(e.summary ? { summary: e.summary } : {}) }] }; break;
  }
  return next;
}

/**
 * The finished and running workflows of a conversation that was opened, each card where its run started
 * (run.at: the messages before it) rather than after the whole conversation; one without it (older servers)
 * at the end. A card already there (a live event came first) is updated in place.
 */
export function placeRuns(live: Live, runs: WorkflowRunView[], history: Message[]): Live {
  let out = live;
  // Oldest first: the cards placed before this one start no later, so they sit before it.
  const sorted = [...runs].sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
  let placed = 0;
  for (const run of sorted) {
    const there = out.items.some((i) => i.kind === 'workflow' && i.run.id === run.id);
    if (there || typeof run.at !== 'number' || run.at >= history.length) { out = apply(out, { kind: 'workflow', phase: 'started', run }); continue; }
    // The items the messages before it make, plus the cards placed among them.
    const idx = Math.min(out.items.length, fromHistory(history.slice(0, run.at)).length + placed);
    const card = apply({ ...out, items: [] }, { kind: 'workflow', phase: 'started', run }).items[0]!;
    out = { ...out, items: [...out.items.slice(0, idx), card, ...out.items.slice(idx)] };
    placed++;
  }
  return out;
}

/** The state of a conversation as its stored detail gives it. */
export function fromDetail(d: SessionDetail, contextWindow: number): SessionLive {
  const items = fromHistory(d.history);
  return { ...EMPTY, meta: d.meta, status: d.status, live: { items, contextTokens: d.meta.lastPromptTokens, contextWindow }, pending: d.pending.filter(isPending), tasks: d.tasks ?? [], agents: agentsFromItems(items, d.meta.model), loaded: true, stream: 'connecting' };
}

interface Store { state: SessionLive; listeners: Set<(s: SessionLive) => void>; refs: number; stop?: () => void; idle?: ReturnType<typeof setTimeout>; started: boolean }
const stores = new Map<string, Store>();
/** Conversations kept after their last view closed (instant back). */
const KEEP = 12;

function storeFor(id: string): Store {
  let st = stores.get(id);
  if (!st) {
    st = { state: EMPTY, listeners: new Set(), refs: 0, started: false };
    stores.set(id, st);
    // Forget the least recently used closed ones.
    const closed = [...stores.entries()].filter(([, x]) => x.refs === 0 && !x.stop);
    for (const [k] of closed.slice(0, Math.max(0, closed.length - KEEP))) if (k !== id) stores.delete(k);
  }
  return st;
}

function setState(id: string, f: (s: SessionLive) => SessionLive): void {
  const st = stores.get(id);
  if (!st) return;
  st.state = f(st.state);
  for (const l of st.listeners) l(st.state);
}

/** Changes a conversation's state from outside its stream (a patch the page made). */
export function updateSession(id: string, f: (s: SessionLive) => SessionLive): void { setState(id, f); }

/** The current state of a conversation, if a view has it. */
export function sessionState(id: string): SessionLive | undefined { return stores.get(id)?.state; }

function start(id: string): void {
  const st = storeFor(id);
  if (st.started) return;
  st.started = true;
  let cancelled = false;
  st.stop = () => { cancelled = true; };
  const models = useData.getState().models;
  client.sessions.get(id).then((d: SessionDetail) => {
    if (cancelled) return;
    const spec = models.find((m) => m.id === d.meta.model);
    setState(id, () => fromDetail(d, spec?.compactAt ?? spec?.contextWindow ?? 0));
    // Every workflow run gets its card back, finished ones too: a conversation a workflow started keeps its
    // work in the run, not the history, and would otherwise reopen empty.
    // Each card where its run started in the conversation (the messages before it), not after everything.
    client.sessions.workflows(id).then((r) => { if (!cancelled) setState(id, (s) => ({ ...s, live: placeRuns(s.live, [...r.runs].reverse(), d.history) })); }).catch(() => {});
    // Cost and model per sub-agent (the history keeps neither).
    if (Object.keys(stores.get(id)?.state.agents ?? {}).length || Object.keys(d.meta.byModel ?? {}).length > 1) client.sessions.trace(id).then((spans) => { if (!cancelled && Array.isArray(spans)) setState(id, (s) => ({ ...s, agents: withTrace(s.agents, spans) })); }).catch(() => {});
    const stopStream = client.sessions.events(id, d.lastSeq, (e) => {
      if (e.kind === 'client_call') dispatchClientCall(id, e.callId, e.tool, e.input);
      setState(id, (s) => reduce(s, e));
      if (e.kind === 'turn_end' && !e.agent) client.sessions.get(id).then((dd) => setState(id, (s) => ({ ...s, meta: dd.meta, status: dd.status, tasks: dd.tasks ?? s.tasks }))).catch(() => {});
    }, (state) => setState(id, (s) => ({ ...s, stream: state })));
    st.stop = () => { cancelled = true; stopStream(); };
  }).catch((e: Error) => { if (!cancelled) setState(id, (s) => ({ ...s, error: e.message, loaded: true })); });
}

/** The conversation's transcript again from the server (after it was cut back to an earlier message); the stream goes on. */
export async function reloadHistory(id: string): Promise<void> {
  const [d, runs] = await Promise.all([client.sessions.get(id), client.sessions.workflows(id).then((r) => r.runs, () => [] as WorkflowRunView[])]);
  setState(id, (s) => ({ ...s, meta: d.meta, status: d.status, live: placeRuns({ ...s.live, items: fromHistory(d.history) }, [...runs].reverse(), d.history), agents: agentsFromItems(fromHistory(d.history), d.meta.model) }));
}

function release(id: string): void {
  const st = stores.get(id);
  if (!st) return;
  st.refs--;
  if (st.refs > 0) return;
  // A moment's grace: a re-render that unmounts and mounts again keeps the stream.
  st.idle = setTimeout(() => { if (st.refs <= 0) { st.stop?.(); st.stop = undefined; st.started = false; } }, 1500);
}

/** A conversation's live state, shared by every view of it; the setter changes it for all of them. */
export function useSessionLive(id: string): [SessionLive, (f: (s: SessionLive) => SessionLive) => void] {
  const [state, set] = useState<SessionLive>(() => (id ? stores.get(id)?.state ?? EMPTY : EMPTY));
  useEffect(() => {
    if (!id) return;
    const st = storeFor(id);
    st.refs++;
    if (st.idle) { clearTimeout(st.idle); st.idle = undefined; }
    st.listeners.add(set);
    set(st.state);
    start(id);
    return () => { st.listeners.delete(set); release(id); };
  }, [id]);
  return [state, (f) => setState(id, f)];
}
