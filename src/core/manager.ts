import fs from 'node:fs/promises';
import path from 'node:path';
import { Session, SessionElsewhereError, type SessionDeps, type SessionMeta } from './session.ts';
import type { Effort } from './models.ts';
import type { PermissionMode } from './types.ts';
import type { LeaseRecord } from '../util/lease.ts';

export class SessionManager {
  private sessions = new Map<string, Session>();
  private deps: SessionDeps;
  private idleTimer?: NodeJS.Timeout;
  private synced = 0;
  private syncing?: Promise<void>;

  constructor(deps: SessionDeps) {
    this.deps = deps;
  }

  get registry() { return this.deps.registry; }

  private get dir(): string { return path.join(this.deps.dataDir, 'sessions'); }

  async load(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const resume: Session[] = [];
    for (const id of await fs.readdir(this.dir)) {
      try {
        const s = await Session.load(this.deps, id);
        this.sessions.set(id, s);
        // Another server sharing the data folder is working on it: not ours to recover.
        if (await this.heldElsewhere(id)) continue;
        // Mid-turn when the server stopped: close the turn out cleanly.
        if (await s.recoverInterrupted()) resume.push(s);
        await s.recoverRuns();
      } catch { /* not a session */ }
    }
    this.synced = Date.now();
    if (process.env.HARNESS_AUTO_RESUME === '1') {
      for (const s of resume) s.send('The server restarted while you were working. Continue the task from where you left off.').catch(() => {});
    }
    // Stop idle sandboxes; they restart on demand and the workspace persists.
    this.idleTimer = setInterval(() => {
      const cutoff = Date.now() - Number(process.env.HARNESS_SANDBOX_IDLE_MS ?? 30 * 60_000);
      for (const s of this.sessions.values()) if (s.status === 'idle' && s.meta.updatedAt < cutoff) s.stopSandbox().catch(() => {});
    }, 5 * 60_000);
    this.idleTimer.unref();
  }

  /** The live lease another server holds on a session (several servers on one data folder), or undefined. */
  async heldElsewhere(id: string): Promise<LeaseRecord | undefined> {
    return this.deps.leases?.heldElsewhere(`session-${id}`);
  }

  /**
   * Several servers on one data folder: picks up sessions other servers made or
   * deleted, and reads again the idle ones another server changed. At most once a
   * second (HARNESS_SYNC_MS) unless `force`; a no-op on a single server.
   */
  async sync(force = false): Promise<void> {
    if (!this.deps.leases) return;
    if (!force && Date.now() - this.synced < Number(process.env.HARNESS_SYNC_MS ?? 1000)) return;
    this.syncing ??= (async () => {
      try {
        const ids = new Set(await fs.readdir(this.dir).catch(() => [] as string[]));
        for (const id of ids) {
          const s = this.sessions.get(id);
          if (!s) {
            try { this.sessions.set(id, await Session.load(this.deps, id)); } catch { /* being written, or not a session */ }
          } else await s.syncFromDisk().catch(() => false);
        }
        // Deleted by another server: forgotten here, unless it is working here.
        for (const [id, s] of this.sessions) if (!ids.has(id) && s.status === 'idle') this.sessions.delete(id);
        this.synced = Date.now();
      } finally { this.syncing = undefined; }
    })();
    return this.syncing;
  }

  list(): SessionMeta[] {
    return [...this.sessions.values()].map((s) => s.meta).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** Its status here; a session another server is working on (meta.running, servers sharing a data folder) reads as running. */
  statusOf(id: string): string {
    const s = this.sessions.get(id);
    if (!s) return 'idle';
    if (s.status === 'idle' && this.deps.leases && s.meta.running) return 'running';
    return s.status;
  }

  async create(opts: Parameters<typeof Session.create>[1]): Promise<Session> {
    const s = await Session.create(this.deps, opts);
    this.sessions.set(s.meta.id, s);
    return s;
  }

  async remove(id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    const elsewhere = await this.heldElsewhere(id);
    if (elsewhere) throw new SessionElsewhereError(elsewhere);
    await s.destroy();
    this.sessions.delete(id);
    return true;
  }

  /** Live sessions an account owns (undefined: the single-user server's, or the operator's). */
  ownedBy(owner: string | undefined): Session[] {
    return [...this.sessions.values()].filter((s) => s.meta.owner === owner);
  }

  /** Server shutdown: stop every turn, then SessionEnd hooks (reason "shutdown") for sessions that ran. */
  async close(): Promise<void> {
    clearInterval(this.idleTimer);
    for (const s of this.sessions.values()) s.abort();
    await Promise.all([...this.sessions.values()].map((s) => s.end('shutdown').catch(() => {})));
  }
}
