import fs from 'node:fs/promises';
import path from 'node:path';
import { Session, type SessionDeps, type SessionMeta } from './session.ts';
import type { Effort } from './models.ts';
import type { PermissionMode } from './types.ts';

export class SessionManager {
  private sessions = new Map<string, Session>();
  private deps: SessionDeps;
  private idleTimer?: NodeJS.Timeout;

  constructor(deps: SessionDeps) {
    this.deps = deps;
  }

  get registry() { return this.deps.registry; }

  async load(): Promise<void> {
    const dir = path.join(this.deps.dataDir, 'sessions');
    await fs.mkdir(dir, { recursive: true });
    const resume: Session[] = [];
    for (const id of await fs.readdir(dir)) {
      try {
        const s = await Session.load(this.deps, id);
        this.sessions.set(id, s);
        // Mid-turn when the server stopped: close the turn out cleanly.
        if (await s.recoverInterrupted()) resume.push(s);
        await s.recoverRuns();
      } catch { /* not a session */ }
    }
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

  list(): SessionMeta[] {
    return [...this.sessions.values()].map((s) => s.meta).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  statusOf(id: string): string {
    return this.sessions.get(id)?.status ?? 'idle';
  }

  async create(opts: { title?: string; model: string; effort?: Effort; mode?: PermissionMode; runtime: SessionMeta['runtime']; gitUrl?: string }): Promise<Session> {
    const s = await Session.create(this.deps, opts);
    this.sessions.set(s.meta.id, s);
    return s;
  }

  async remove(id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    await s.destroy();
    this.sessions.delete(id);
    return true;
  }

  async close(): Promise<void> {
    clearInterval(this.idleTimer);
    for (const s of this.sessions.values()) s.abort();
  }
}
