import type { Session } from '../core/session.ts';
import type { Schedule } from '../core/scheduler.ts';
import type { HarnessEvent } from '../core/types.ts';

// One stream for everything a person may see across the server (GET /api/events):
// session list changes, status and titles, requests waiting for a person in any
// session, schedules firing, plugins changing, notices. Kept in memory: a ring of the
// last events for replay (Last-Event-ID), numbered from 1 each time the server starts.
// With several servers on one data folder, each streams what happens on it.

export const EVENT_TOPICS = ['sessions', 'session', 'approvals', 'schedules', 'plugins', 'notices', 'proposals', 'linked', 'artifacts', 'chapters', 'client', 'data'] as const;
export type EventTopic = typeof EVENT_TOPICS[number];

/** Who may see an event: everyone signed in, or whoever may use what `owner` owns (administrators see all of it). */
export type Audience = { all: true } | { owner: string | undefined };

export interface HubEvent { seq: number; at: number; topic: EventTopic; payload: unknown; audience: Audience }

/** What a waiting request looks like in the inbox (and in the approvals topic's "added"). */
export interface ApprovalItem { sessionId: string; requestId: string; kind: string; title?: string; summary?: string; tool?: string; at: number }

const APPROVAL_KINDS = new Set(['permission_request', 'question', 'plan_proposed', 'approval_request']);

export class EventHub {
  private ring: HubEvent[] = [];
  private seq = 0;
  private subs = new Set<(e: HubEvent) => void>();
  /** When each waiting request was asked (for GET /api/approvals). */
  private asked = new Map<string, number>();
  private titles = new Map<string, string>();
  readonly size: number;

  constructor(size = Number(process.env.HARNESS_EVENTS_RING ?? 1000) || 1000) { this.size = size; }

  get lastSeq(): number { return this.seq; }

  publish(topic: EventTopic, payload: unknown, audience: Audience): HubEvent {
    const e: HubEvent = { seq: ++this.seq, at: Date.now(), topic, payload, audience };
    this.ring.push(e);
    if (this.ring.length > this.size) this.ring.splice(0, this.ring.length - this.size);
    for (const fn of this.subs) { try { fn(e); } catch { /* one listener never stops the others */ } }
    return e;
  }

  /**
   * Replays what is still in the ring after `after`, then everything new. An id from before
   * this server started (larger than any here) replays the whole ring.
   */
  subscribe(after: number, fn: (e: HubEvent) => void): () => void {
    const from = after > this.seq ? 0 : after;
    for (const e of this.ring) if (e.seq > from) fn(e);
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  }

  // ---- what the sessions, the scheduler and the plugins report ----

  /** A session's event: status and title changes, requests asked and answered, warnings. */
  fromSession(s: Session, ev: HarnessEvent): void {
    if (ev.kind === 'text_delta' || ev.kind === 'reasoning_delta') return;
    const owner = { owner: s.meta.owner };
    const titled = this.titles.get(s.meta.id);
    const titleChanged = titled !== undefined && titled !== s.meta.title;
    this.titles.set(s.meta.id, s.meta.title);
    if (ev.kind === 'status' || titleChanged) {
      this.publish('session', { id: s.meta.id, status: ev.kind === 'status' ? ev.status : s.status, ...(titleChanged || ev.kind === 'status' ? { title: s.meta.title } : {}), lastSeq: s.lastSeq }, owner);
      if (titleChanged) this.sessionChanged('updated', s);
    }
    if (APPROVAL_KINDS.has(ev.kind)) {
      const at = Date.now();
      const id = (ev as { requestId: string }).requestId;
      this.asked.set(id, at);
      this.publish('approvals', { type: 'added', ...approvalItem(s, ev, at) }, owner);
    } else if (ev.kind === 'request_resolved') {
      this.asked.delete(ev.requestId);
      this.publish('approvals', { type: 'resolved', sessionId: s.meta.id, requestId: ev.requestId, at: Date.now(), decision: ev.decision }, owner);
    } else if (ev.kind === 'notice' && ev.level !== 'info') {
      this.publish('notices', { level: ev.level, text: ev.text, sessionId: s.meta.id }, owner);
    } else if (ev.kind === 'session_proposal') {
      const { kind: _k, ...p } = ev;
      this.publish('proposals', { type: 'added', sessionId: s.meta.id, ...p }, owner);
    } else if (ev.kind === 'proposal_resolved') {
      this.publish('proposals', { type: ev.status, sessionId: s.meta.id, id: ev.id, ...(ev.sessionId ? { childId: ev.sessionId } : {}) }, owner);
    } else if (ev.kind === 'side_session') {
      // A linked session started, reported or got a message: on the parent's (or the receiver's) behalf.
      this.publish('linked', { type: ev.phase, sessionId: s.meta.id, id: ev.id, title: ev.title, ...(ev.reason ? { reason: ev.reason } : {}), ...(ev.preview ? { preview: ev.preview } : {}) }, owner);
    } else if (ev.kind === 'artifact') {
      this.publish('artifacts', { sessionId: s.meta.id, ...ev.artifact }, owner);
    } else if (ev.kind === 'chapter') {
      this.publish('chapters', { sessionId: s.meta.id, index: ev.index, title: ev.title, ...(ev.summary ? { summary: ev.summary } : {}) }, owner);
    } else if (ev.kind === 'client_call' || ev.kind === 'client_call_end') {
      // For an app attached through this stream rather than the session's own.
      const { kind, ...c } = ev;
      this.publish('client', { type: kind === 'client_call' ? 'call' : 'end', sessionId: s.meta.id, ...c }, owner);
    }
  }

  /** The session list changed: made, changed (title, archive, pin, group) or deleted. */
  sessionChanged(type: 'created' | 'updated' | 'deleted', s: Session): void {
    if (type === 'deleted') { this.titles.delete(s.meta.id); this.publish('sessions', { type, session: { id: s.meta.id, title: s.meta.title, ...(s.meta.owner ? { owner: s.meta.owner } : {}) } }, { owner: s.meta.owner }); return; }
    this.titles.set(s.meta.id, s.meta.title);
    this.publish('sessions', { type, session: { ...s.meta, status: s.status } }, { owner: s.meta.owner });
  }

  scheduleEvent(type: 'fired' | 'changed', s: Schedule, run?: { sessionId?: string; result: string }): void {
    // Never the trigger's hash or the prompt's full text: what a list needs.
    this.publish('schedules', { type, id: s.id, title: s.title, enabled: s.enabled, ...(s.cron ? { cron: s.cron } : {}), ...(s.nextRun ? { nextRun: s.nextRun } : {}), ...(s.lastRun ? { lastRun: s.lastRun } : {}), ...(s.lastResult ? { lastResult: s.lastResult } : {}), ...(s.triggerHash ? { trigger: true } : {}), ...(run?.sessionId ?? s.sessionId ? { sessionId: run?.sessionId ?? s.sessionId } : {}), ...(run ? { result: run.result } : {}) }, { owner: s.owner });
  }

  /** When a waiting request was asked (now, for one this server did not see asked). */
  askedAt(requestId: string): number { return this.asked.get(requestId) ?? Date.now(); }
}

/** A waiting request as the inbox shows it. */
export function approvalItem(s: Session, ev: HarnessEvent, at: number): ApprovalItem {
  const e = ev as { kind: string; requestId: string; tool?: string; summary?: string; question?: string; plan?: string; title?: string; message?: string };
  const summary = e.kind === 'permission_request' ? e.summary : e.kind === 'question' ? e.question : e.kind === 'plan_proposed' ? e.plan : e.kind === 'approval_request' ? `${e.title ?? ''}${e.message ? `: ${e.message}` : ''}` : undefined;
  return { sessionId: s.meta.id, requestId: e.requestId, kind: e.kind, title: s.meta.title, ...(summary ? { summary: summary.slice(0, 500) } : {}), ...(e.tool ? { tool: e.tool } : {}), at };
}
