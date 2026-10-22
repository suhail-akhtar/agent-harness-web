/**
 * Reading the harness's event streams.
 *
 * Two streams: one per session (`/api/sessions/:id/events`, `data:{seq,event}`) and, on servers
 * that have it, one for everything a person may see (`/api/events`, `data:{seq,topic,payload}`).
 * Both are Server-Sent Events read with fetch (not EventSource) so the same code runs in the
 * desktop renderer, in Node (tests, the live smoke run) and with any headers a caller needs.
 *
 * A dropped stream reconnects with backoff from the last sequence number it saw, so nothing is
 * missed and nothing is applied twice. When the server has no global stream (a 404), the
 * `GlobalEvents` reader falls back to polling and synthesises the same topics.
 */

import type { Approval, GlobalEvent, HarnessEvent, SessionEventEnvelope, SessionMeta } from './types.ts';

/** One parsed SSE message. */
export interface SseMessage { id?: string; event?: string; data: string; retry?: number }

/**
 * An incremental SSE parser: feed it chunks as they arrive (split anywhere, even inside a line
 * or a CRLF), get back the complete messages. Comments (`: ping`) are dropped.
 */
export class SseParser {
  private buf = '';
  private data: string[] = [];
  private id: string | undefined;
  private event: string | undefined;
  private retry: number | undefined;

  feed(chunk: string): SseMessage[] {
    this.buf += chunk;
    const out: SseMessage[] = [];
    for (;;) {
      const nl = this.buf.search(/\r\n|\r|\n/);
      if (nl < 0) break;
      // A lone \r at the very end might be the first half of \r\n: wait for more.
      if (this.buf[nl] === '\r' && nl === this.buf.length - 1) break;
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + (this.buf.startsWith('\r\n', nl) ? 2 : 1));
      if (line === '') {
        if (this.data.length) out.push({ data: this.data.join('\n'), ...(this.id !== undefined ? { id: this.id } : {}), ...(this.event ? { event: this.event } : {}), ...(this.retry !== undefined ? { retry: this.retry } : {}) });
        this.data = []; this.event = undefined; this.retry = undefined;
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') this.data.push(value);
      else if (field === 'id') this.id = value;
      else if (field === 'event') this.event = value;
      else if (field === 'retry' && /^\d+$/.test(value)) this.retry = Number(value);
    }
    return out;
  }
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface StreamOptions {
  fetch: Fetch;
  url: () => string;
  headers?: () => Record<string, string>;
  onMessage: (m: SseMessage) => void;
  /** Called when a connection is established / lost (for "reconnecting" indicators). */
  onState?: (s: 'open' | 'retrying' | 'closed' | 'missing') => void;
  /** Stop retrying after a 404 (the endpoint does not exist). Default true. */
  stopOn404?: boolean;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

/** Reads an SSE endpoint until closed, reconnecting with backoff. Returns a function that stops it. */
export function readStream(o: StreamOptions): () => void {
  let stopped = false;
  let ctrl: AbortController | undefined;
  let attempt = 0;
  const min = o.minBackoffMs ?? 500;
  const max = o.maxBackoffMs ?? 15_000;
  const loop = async () => {
    while (!stopped) {
      ctrl = new AbortController();
      try {
        const res = await o.fetch(o.url(), { headers: { accept: 'text/event-stream', ...(o.headers?.() ?? {}) }, signal: ctrl.signal });
        if (res.status === 404 && o.stopOn404 !== false) { o.onState?.('missing'); return; }
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        attempt = 0;
        o.onState?.('open');
        const parser = new SseParser();
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const m of parser.feed(dec.decode(value, { stream: true }))) o.onMessage(m);
        }
      } catch {
        if (stopped) break;
      }
      if (stopped) break;
      o.onState?.('retrying');
      const wait = Math.min(max, min * 2 ** Math.min(attempt++, 6));
      await new Promise((r) => setTimeout(r, wait));
    }
    o.onState?.('closed');
  };
  void loop();
  return () => { stopped = true; ctrl?.abort(); };
}

/**
 * A session's live events from `after` on. Envelopes carry `seq`; the reader resumes from the
 * last one it delivered after a reconnect and drops duplicates.
 */
export function sessionEvents(o: { fetch: Fetch; base: string; id: string; after: number; headers?: () => Record<string, string>; onEvent: (e: HarnessEvent, seq: number) => void; onState?: StreamOptions['onState'] }): () => void {
  let last = o.after;
  return readStream({
    fetch: o.fetch, headers: o.headers, onState: o.onState,
    url: () => `${o.base}/api/sessions/${o.id}/events?after=${last}`,
    onMessage: (m) => {
      let env: SessionEventEnvelope;
      try { env = JSON.parse(m.data) as SessionEventEnvelope; } catch { return; }
      if (!env || typeof env !== 'object' || !env.event) return;
      if (typeof env.seq === 'number') { if (env.seq <= last) return; last = env.seq; }
      o.onEvent(env.event, env.seq);
    },
  });
}

/** Parses one global-stream message; undefined when it is not one. */
export function parseGlobal(m: SseMessage): GlobalEvent | undefined {
  try {
    const j = JSON.parse(m.data) as Partial<GlobalEvent>;
    if (!j || typeof j !== 'object' || typeof j.topic !== 'string') return undefined;
    return { seq: typeof j.seq === 'number' ? j.seq : 0, topic: j.topic, payload: j.payload };
  } catch { return undefined; }
}

export interface GlobalEventsOptions {
  fetch: Fetch;
  base: string;
  headers?: () => Record<string, string>;
  /** For the polling fallback. */
  listSessions: () => Promise<SessionMeta[]>;
  listApprovals: () => Promise<Approval[]>;
  pollMs?: number;
}

/**
 * Everything a person may see, as one stream of `{topic, payload}`: the server's /api/events when
 * it has one, otherwise polling the sessions list and the pending requests every few seconds and
 * emitting `sessions` and `approvals` when they change.
 */
export class GlobalEvents {
  private listeners = new Set<(e: GlobalEvent) => void>();
  private stateListeners = new Set<(s: 'stream' | 'polling' | 'retrying' | 'stopped') => void>();
  private stopStream?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private lastSessions = '';
  private lastApprovals = '';
  private seq = 0;
  mode: 'stream' | 'polling' | 'retrying' | 'stopped' = 'stopped';
  private o: GlobalEventsOptions;
  constructor(o: GlobalEventsOptions) { this.o = o; }

  on(fn: (e: GlobalEvent) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onState(fn: (s: GlobalEvents['mode']) => void): () => void { this.stateListeners.add(fn); return () => this.stateListeners.delete(fn); }

  private emit(e: GlobalEvent) { for (const f of this.listeners) { try { f(e); } catch { /* a listener's bug is its own */ } } }
  private setMode(m: GlobalEvents['mode']) { if (this.mode === m) return; this.mode = m; for (const f of this.stateListeners) f(m); }

  start(): void {
    this.stop();
    let lastSeq = 0;
    this.stopStream = readStream({
      fetch: this.o.fetch, headers: this.o.headers,
      url: () => `${this.o.base}/api/events${lastSeq ? `?after=${lastSeq}` : ''}`,
      onState: (s) => {
        if (s === 'open') this.setMode('stream');
        else if (s === 'retrying') this.setMode('retrying');
        else if (s === 'missing') this.startPolling();
      },
      onMessage: (m) => {
        const e = parseGlobal(m);
        if (!e) return;
        if (e.seq) { if (e.seq <= lastSeq) return; lastSeq = e.seq; }
        this.emit(e);
      },
    });
  }

  /** Poll now (after the person did something, to show its effect at once). */
  async poke(): Promise<void> { if (this.mode === 'polling') await this.pollOnce(); }

  private startPolling() {
    this.setMode('polling');
    const tick = async () => {
      await this.pollOnce();
      if (this.mode === 'polling') this.timer = setTimeout(tick, this.o.pollMs ?? 3000);
    };
    void tick();
  }

  private async pollOnce(): Promise<void> {
    try {
      const sessions = await this.o.listSessions();
      const sig = JSON.stringify(sessions.map((s) => [s.id, s.status, s.updatedAt, s.title, s.archived, s.pinned]));
      if (sig !== this.lastSessions) { this.lastSessions = sig; this.emit({ seq: ++this.seq, topic: 'sessions', payload: { sessions } }); }
      // Pending requests only live in waiting sessions: skip the second call when none is.
      const approvals = sessions.some((s) => s.status === 'waiting') || this.lastApprovals !== '[]' ? await this.o.listApprovals() : [];
      const asig = JSON.stringify(approvals.map((a) => [a.sessionId, a.request.requestId]));
      if (asig !== this.lastApprovals) { this.lastApprovals = asig; this.emit({ seq: ++this.seq, topic: 'approvals', payload: { approvals } }); }
    } catch { /* the engine is down or restarting: the next tick tries again */ }
  }

  stop(): void {
    this.stopStream?.();
    this.stopStream = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.setMode('stopped');
  }
}
