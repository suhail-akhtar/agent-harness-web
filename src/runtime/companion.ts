import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ExecOptions, ExecResult, ToolHost, ToolOutcome } from './host.ts';

// The companion is a small process the user runs on their own machine. It
// connects OUT to this server (long-poll over HTTPS: no inbound port, works
// behind NAT), picks up tool calls for its sessions, runs them in its folder
// with the same tool code, and posts the results back. Permission checks and
// hooks decisions happen on the server before a call is dispatched.

export type { CompanionJob } from '../companion/handler.ts';
import type { CompanionJob } from '../companion/handler.ts';

/** How much a companion folder may hold for server-side tools (render, browser). */
const MIRROR_MAX = Number(process.env.HARNESS_MIRROR_MAX_MB ?? 100) * 1024 * 1024;
/** File data per pull reply: base64 of this (and of one file up to 20 MB) stays under the result route's limit. */
const MIRROR_CHUNK = 16 * 1024 * 1024;
export const COMPANION_RESULT_LIMIT = 48_000_000;

/**
 * A path from a companion as a path inside `root`, or undefined. A companion is
 * someone's computer: on Windows "..\\x" or "C:x" are paths too, so anything but
 * plain forward-slash segments is refused, and the result is checked to be inside.
 */
export function mirrorPath(root: string, p: unknown): string | undefined {
  if (typeof p !== 'string' || !p || p.length > 1000 || /[\\:\0]/.test(p) || p.startsWith('/')) return undefined;
  const parts = p.split('/');
  if (parts.some((s) => !s || s === '.' || s === '..')) return undefined;
  const target = path.resolve(root, ...parts);
  return target.startsWith(path.resolve(root) + path.sep) ? target : undefined;
}

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
  private dataDir: string;
  /** Per session: what the server's copy of the companion folder holds. */
  private mirrors = new Map<string, { known: Record<string, [number, number]>; queue: Promise<unknown> }>();
  private records = new Map<string, CompanionRecord>();
  private live = new Map<string, Live>();

  private chunkBytes: number;

  constructor(dataDir: string, opts: { mirrorChunkBytes?: number } = {}) {
    this.file = path.join(dataDir, 'companions.json');
    this.dataDir = dataDir;
    this.chunkBytes = opts.mirrorChunkBytes ?? MIRROR_CHUNK;
  }

  /**
   * A server-side copy of a companion session's folder for tools that run on
   * the server (render, browser): only files that changed are copied, and
   * files gone from the folder are removed. Calls for one session queue.
   */
  async mirror(id: string, sessionId: string, signal?: AbortSignal): Promise<string> {
    const root = path.join(this.dataDir, 'mirrors', sessionId);
    const m = this.mirrors.get(sessionId) ?? { known: {}, queue: Promise.resolve() };
    this.mirrors.set(sessionId, m);
    const next = m.queue.catch(() => {}).then(async () => {
      const seen = new Set<string>();
      let total = 0;
      for (let round = 0; ; round++) {
        const r = await this.dispatch<{ files: { path: string; size: number; mtime: number; data?: string }[]; more?: boolean }>(id, { kind: 'pull', sessionId, known: m.known, maxBytes: MIRROR_MAX, chunkBytes: this.chunkBytes }, signal, 10 * 60_000);
        for (const f of r.files) {
          const target = mirrorPath(root, f.path);
          if (!target) continue; // a companion only ever sends plain relative paths
          seen.add(f.path);
          if (f.data === undefined) continue;
          const data = Buffer.from(f.data, 'base64');
          total += data.length;
          if (total > MIRROR_MAX) throw new Error(`the folder has more than ${Math.round(MIRROR_MAX / 1048576)} MB to copy for this tool (node_modules, .git and build output are skipped)`);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, data);
          m.known[f.path] = [f.size, f.mtime];
        }
        if (!r.more || round > 1000) break;
      }
      for (const rel of Object.keys(m.known)) {
        if (!seen.has(rel)) { delete m.known[rel]; const t = mirrorPath(root, rel); if (t) await fs.rm(t, { force: true }); }
      }
      await fs.mkdir(root, { recursive: true });
      return root;
    });
    m.queue = next;
    return next;
  }

  /** Drops a session's server-side copy (the session is gone). */
  async forget(sessionId: string): Promise<void> {
    if (!/^[\w-]+$/.test(sessionId)) return;
    await this.mirrors.get(sessionId)?.queue.catch(() => {});
    this.mirrors.delete(sessionId);
    await fs.rm(path.join(this.dataDir, 'mirrors', sessionId), { recursive: true, force: true });
  }

  /** Writes a file the server made (an export, a saved render) into the companion folder. */
  async push(id: string, sessionId: string, rel: string, data: Buffer, signal?: AbortSignal): Promise<void> {
    await this.dispatch(id, { kind: 'push', sessionId, path: rel, data: data.toString('base64') }, signal, 5 * 60_000);
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
      mirror: (signal?: AbortSignal) => hub.mirror(id, sessionId, signal),
      pushFile: (rel: string, data: Buffer, signal?: AbortSignal) => hub.push(id, sessionId, rel, data, signal),
    } as ToolHost;
  }
}
