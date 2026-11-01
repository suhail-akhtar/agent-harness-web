import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withFileLock, writeFileAtomic } from '../util/shared-file.ts';

// What each run of a schedule or trigger came to: when it ran, how it ended, what it cost, a line of
// what it did, its conversation, and whether it found anything worth the person's attention. One
// JSON line per change of a run (it starts, then ends), appended under the file's lock so several
// servers on one data folder share it; read back newest first, the last line of a run winning.

export type RunStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'skipped' | 'interrupted';

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  owner?: string;
  title: string;
  /** What started it: its time (a cron or a one-time schedule), its trigger URL, Run now, or a change its watch saw. */
  by: 'schedule' | 'trigger' | 'manual' | 'watch';
  startedAt: number;
  endedAt?: number;
  status: RunStatus;
  /** Why it did not run, or what stopped it. */
  reason?: string;
  sessionId?: string;
  /** What the run cost (its conversation's cost from start to end). */
  costUsd?: number;
  /** The first lines of the agent's last reply. */
  summary?: string;
  /** Tool calls, and of those the ones that change something (edits, commands, sending). */
  tools?: number;
  actions?: number;
  /** It told the person something (notify_user). */
  notified?: boolean;
  /** Times it asked the person (approval, a question, a plan) and waited for them. */
  waited?: number;
  /** Work it offered the person (proposals: suggestions in their inbox). */
  proposed?: number;
  /** Steps it was refused (not allowed unattended, or answered no): it could not do everything it set out to. */
  refused?: number;
  /** The agent said nothing needs the person ([nothing to report]). */
  noOp?: boolean;
}

/** What the end of a run adds to its record. */
export type RunEnd = Pick<ScheduleRun, 'status' | 'reason' | 'costUsd' | 'summary' | 'tools' | 'actions' | 'notified' | 'noOp' | 'waited' | 'proposed' | 'refused'> & { endedAt?: number };

/** The words a scheduled agent ends its reply with when nothing needs the person. */
export const NOTHING_TO_REPORT = '[nothing to report]';

const KEEP = Number(process.env.HARNESS_SCHEDULE_RUNS_KEPT ?? 2000);

export class ScheduleRunLog {
  readonly file: string;
  constructor(dataDir: string) { this.file = path.join(dataDir, 'schedule-runs.jsonl'); }

  /** Writes a new run (or a skipped one) and returns it. */
  async start(r: Omit<ScheduleRun, 'id'>): Promise<ScheduleRun> {
    const run: ScheduleRun = { id: crypto.randomBytes(6).toString('hex'), ...r };
    await this.append(run);
    return run;
  }

  /** The end of a run: its record with what the end adds (it never ends before it started, whatever the clocks say). */
  async finish(run: ScheduleRun, end: RunEnd): Promise<ScheduleRun> {
    const done: ScheduleRun = { ...run, ...Object.fromEntries(Object.entries(end).filter(([, v]) => v !== undefined)), endedAt: end.endedAt ?? Math.max(Date.now(), run.startedAt) } as ScheduleRun;
    await this.append(done);
    return done;
  }

  /** Runs, newest first: of one schedule, of one owner, still running, at most `limit`. */
  async list(q: { scheduleId?: string; owner?: string; status?: RunStatus; limit?: number; all?: boolean } = {}): Promise<ScheduleRun[]> {
    const byId = await this.read();
    const out = [...byId.values()]
      .filter((r) => (q.scheduleId === undefined || r.scheduleId === q.scheduleId) && (q.all || q.owner === undefined || r.owner === q.owner) && (q.status === undefined || r.status === q.status))
      .sort((a, b) => b.startedAt - a.startedAt);
    return out.slice(0, Math.max(1, Math.min(q.limit ?? 50, 500)));
  }

  async get(id: string): Promise<ScheduleRun | undefined> { return (await this.read()).get(id); }

  /** Forgets the runs of a deleted schedule. */
  async forget(scheduleId: string): Promise<void> {
    await withFileLock(this.file, async () => {
      const keep = [...(await this.read()).values()].filter((r) => r.scheduleId !== scheduleId);
      await writeFileAtomic(this.file, keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''));
    });
  }

  private async read(): Promise<Map<string, ScheduleRun>> {
    const text = await fs.readFile(this.file, 'utf8').catch(() => '');
    const byId = new Map<string, ScheduleRun>();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as ScheduleRun;
        if (r && typeof r.id === 'string' && typeof r.scheduleId === 'string') byId.set(r.id, r);
      } catch { /* a line cut short by a crash: skipped */ }
    }
    return byId;
  }

  /** Appends a line; past the limit, keeps the newest runs only (one line each). */
  private async append(r: ScheduleRun): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await withFileLock(this.file, async () => {
      await fs.appendFile(this.file, JSON.stringify(r) + '\n');
      const lines = (await fs.readFile(this.file, 'utf8')).split('\n').filter(Boolean).length;
      if (lines <= KEEP * 1.5) return;
      const keep = [...(await this.read()).values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, KEEP).reverse();
      await writeFileAtomic(this.file, keep.map((x) => JSON.stringify(x)).join('\n') + '\n');
    });
  }
}
