import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ExecOptions, ExecResult, ToolHost, ToolOutcome } from './host.ts';

// The companion is a small process the user runs on their own machine. It
// connects OUT to this server (long-poll over HTTPS: no inbound port, works
// behind NAT), picks up tool calls for its sessions, runs them in its folder
// with the same tool code, and posts the results back. Permission checks and
// hooks decisions happen on the server before a call is dispatched.

export type CompanionJob =
  | { id: string; kind: 'tool'; sessionId: string; name: string; input: Record<string, unknown> }
  | { id: string; kind: 'exec'; sessionId: string; command: string; timeoutMs: number; stdin?: string };

type NewJob = CompanionJob extends infer J ? (J extends CompanionJob ? Omit<J, 'id'> : never) : never;

interface Pending { resolve(v: unknown): void; reject(e: Error): void }

interface CompanionRecord {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: number;
  /** The account that added it (absent: the single-user server). */
  owner?: string;
}

interface Live {
  lastSeen: number;
  info: { platform: string; shell: string; root: string; version?: string };
  queue: CompanionJob[];
  waiter?: (job: CompanionJob | null) => void;
  pending: Map<string, Pending>;
}

const hash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

export class CompanionHub {
  private file: string;
  private records = new Map<string, CompanionRecord>();
  private live = new Map<string, Live>();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'companions.json');
  }

  async load(): Promise<void> {
    try {
      const list = JSON.parse(await fs.readFile(this.file, 'utf8')) as CompanionRecord[];
      for (const r of list) this.records.set(r.id, r);
    } catch { /* first run */ }
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify([...this.records.values()], null, 2), { mode: 0o600 });
  }

  async create(name: string, owner?: string): Promise<{ id: string; token: string }> {
    const id = `cmp_${crypto.randomBytes(6).toString('hex')}`;
    const token = `hwc_${crypto.randomBytes(24).toString('base64url')}`;
    this.records.set(id, { id, name: name.slice(0, 60) || 'My computer', tokenHash: hash(token), createdAt: Date.now(), ...(owner ? { owner } : {}) });
    await this.save();
    return { id, token };
  }

  async remove(id: string): Promise<void> {
    this.records.delete(id);
    const l = this.live.get(id);
    if (l) { l.waiter?.(null); for (const p of l.pending.values()) p.reject(new Error('companion removed')); }
    this.live.delete(id);
    await this.save();
  }

  list() {
    return [...this.records.values()].map((r) => {
      const l = this.live.get(r.id);
      return { id: r.id, name: r.name, owner: r.owner, online: !!l && Date.now() - l.lastSeen < 60_000, info: l?.info ?? null };
    });
  }

  authenticate(token: string): string | undefined {
    const h = hash(token);
    for (const r of this.records.values()) {
      if (crypto.timingSafeEqual(Buffer.from(r.tokenHash), Buffer.from(h))) return r.id;
    }
    return undefined;
  }

  private liveOf(id: string): Live {
    let l = this.live.get(id);
    if (!l) { l = { lastSeen: 0, info: { platform: 'unknown', shell: 'bash', root: '' }, queue: [], pending: new Map() }; this.live.set(id, l); }
    return l;
  }

  /** Long-poll: resolves with the next job, or null after waitMs. */
  poll(id: string, info: Live['info'], waitMs = 25_000): Promise<CompanionJob | null> {
    const l = this.liveOf(id);
    l.lastSeen = Date.now();
    l.info = info;
    const next = l.queue.shift();
    if (next) return Promise.resolve(next);
    l.waiter?.(null);
    return new Promise((resolve) => {
      const t = setTimeout(() => { if (l.waiter === done) l.waiter = undefined; resolve(null); }, waitMs);
      const done = (job: CompanionJob | null) => { clearTimeout(t); l.waiter = undefined; resolve(job); };
      l.waiter = done;
    });
  }

  complete(id: string, jobId: string, ok: boolean, value: unknown): boolean {
    const l = this.live.get(id);
    const p = l?.pending.get(jobId);
    if (!l || !p) return false;
    l.pending.delete(jobId);
    l.lastSeen = Date.now();
    if (ok) p.resolve(value); else p.reject(new Error(String((value as { error?: string })?.error ?? value)));
    return true;
  }

  dispatch<T>(id: string, job: NewJob, signal?: AbortSignal, timeoutMs = 15 * 60_000): Promise<T> {
    const l = this.liveOf(id);
    if (Date.now() - l.lastSeen > 60_000) return Promise.reject(new Error('The companion on the user\'s computer is offline. Ask the user to start it.'));
    const full = { ...job, id: crypto.randomUUID() } as CompanionJob;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => { l.pending.delete(full.id); reject(new Error('the companion did not answer in time')); }, timeoutMs);
      const onAbort = () => { clearTimeout(t); l.pending.delete(full.id); reject(new Error('aborted')); };
      signal?.addEventListener('abort', onAbort, { once: true });
      l.pending.set(full.id, {
        resolve: (v) => { clearTimeout(t); signal?.removeEventListener('abort', onAbort); resolve(v as T); },
        reject: (e) => { clearTimeout(t); signal?.removeEventListener('abort', onAbort); reject(e); },
      });
      if (l.waiter) l.waiter(full); else l.queue.push(full);
    });
  }

  host(id: string, sessionId: string): ToolHost {
    const l = this.liveOf(id);
    const hub = this;
    return {
      kind: 'companion',
      root: '',
      get displayRoot() { return l.info.root || '(companion folder)'; },
      get platform() { return l.info.platform; },
      get shell() { return l.info.shell; },
      sandboxed: false,
      networkPolicy: 'full',
      exec(command: string, opts: ExecOptions): Promise<ExecResult> {
        return hub.dispatch<ExecResult>(id, { kind: 'exec', sessionId, command, timeoutMs: opts.timeoutMs, stdin: opts.stdin }, opts.signal, opts.timeoutMs + 30_000);
      },
      remoteTool(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome> {
        return hub.dispatch<ToolOutcome>(id, { kind: 'tool', sessionId, name, input }, signal);
      },
    } as ToolHost;
  }
}
