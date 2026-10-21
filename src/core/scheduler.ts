import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SessionMeta } from './session.ts';

// Scheduled prompts: "every weekday at 9, check the nightly build and fix what
// broke", or "in 20 minutes, see whether the deploy finished". Like Claude Code's
// cron tools and Codex's background runs, the prompt goes to a session - an
// existing one (the agent's own, when it scheduled it) or a new one each time -
// and runs whether or not anyone is watching. Every run goes through the same
// permissions and spend limits as a typed message.

export interface Schedule {
  id: string;
  owner?: string;
  title: string;
  prompt: string;
  /** Five-field cron (minute hour day-of-month month day-of-week), in the server's time zone. */
  cron?: string;
  /** Run once at this time (ms). */
  at?: number;
  /** The session the prompt goes to; absent: a new session each run, made from `newSession`. */
  sessionId?: string;
  newSession?: { model: string; runtime: SessionMeta['runtime']; mode?: SessionMeta['mode'] };
  enabled: boolean;
  createdAt: number;
  nextRun?: number;
  lastRun?: number;
  lastResult?: string;
  runs: number;
}

export class ScheduleError extends Error {}

const FIELDS: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
const MAX_PER_OWNER = Number(process.env.HARNESS_MAX_SCHEDULES ?? 50);

/** The values one cron field allows ("*", "5", "1-5", "*\/15", "1,3,5", "9-17/2"). */
function field(spec: string, [lo, hi]: [number, number]): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new ScheduleError(`cron field "${spec}" is not understood`);
    const step = m[2] ? Number(m[2]) : 1;
    let a = lo, b = hi;
    if (m[1] !== '*') {
      const [x, y] = m[1]!.split('-').map(Number) as [number, number?];
      a = x; b = y ?? (m[2] ? hi : x);
    }
    if (a < lo || b > hi || a > b || step < 1) throw new ScheduleError(`cron field "${spec}" is out of range (${lo}-${hi})`);
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

/** A cron expression as a test on a time (minute resolution). Day-of-week 7 is Sunday too. */
export function parseCron(expr: string): (d: Date) => boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new ScheduleError('cron needs five fields: minute hour day-of-month month day-of-week (e.g. "0 9 * * 1-5")');
  const [min, hour, dom, mon, dow] = parts.map((p, i) => field(i === 4 ? p.replace(/\b7\b/g, '0') : p, FIELDS[i]!));
  // As in cron: when both day fields are restricted, either one matching is enough.
  const domAny = parts[2] === '*', dowAny = parts[4] === '*';
  return (d) => min!.has(d.getMinutes()) && hour!.has(d.getHours()) && mon!.has(d.getMonth() + 1)
    && (domAny || dowAny ? dom!.has(d.getDate()) && dow!.has(d.getDay()) : dom!.has(d.getDate()) || dow!.has(d.getDay()));
}

/** The first minute after `after` that the expression matches (within about a year). */
export function nextCron(expr: string, after: number): number | undefined {
  const test = parseCron(expr);
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 527_040; i++) {
    if (test(d)) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  return undefined;
}

export interface ScheduleRunner {
  /** Sends the prompt; returns which session it went to, or why it did not run. */
  run(s: Schedule): Promise<{ sessionId?: string; result: string }>;
}

export class Scheduler {
  private file: string;
  private items = new Map<string, Schedule>();
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private runner: ScheduleRunner;
  private log: (m: string) => void;

  constructor(dataDir: string, runner: ScheduleRunner, log: (m: string) => void = () => {}) {
    this.file = path.join(dataDir, 'schedules.json');
    this.runner = runner;
    this.log = log;
  }

  async load(): Promise<void> {
    try {
      for (const s of JSON.parse(await fs.readFile(this.file, 'utf8')) as Schedule[]) this.items.set(s.id, s);
    } catch { /* none yet */ }
  }

  /** Checks every 30 s; runs missed while the server was down fire once on start. */
  start(intervalMs = 30_000): void {
    this.timer = setInterval(() => { void this.tick(); }, intervalMs);
    this.timer.unref();
    void this.tick();
  }

  stop(): void { clearInterval(this.timer); }

  list(owner?: string): Schedule[] {
    return [...this.items.values()].filter((s) => owner === undefined || s.owner === owner).sort((a, b) => (a.nextRun ?? Infinity) - (b.nextRun ?? Infinity));
  }

  get(id: string): Schedule | undefined { return this.items.get(id); }

  async create(spec: { owner?: string; title?: string; prompt: string; cron?: string; at?: number; inMinutes?: number; sessionId?: string; newSession?: Schedule['newSession'] }, now = Date.now()): Promise<Schedule> {
    const prompt = spec.prompt?.trim();
    if (!prompt) throw new ScheduleError('a schedule needs a prompt');
    if (prompt.length > 20_000) throw new ScheduleError('the prompt is limited to 20,000 characters');
    const at = spec.at ?? (spec.inMinutes !== undefined ? now + Math.max(1, spec.inMinutes) * 60_000 : undefined);
    if (!spec.cron === (at === undefined)) throw new ScheduleError('give either cron (repeating) or a time (at / in_minutes), not both or neither');
    if (at !== undefined && at <= now) throw new ScheduleError('that time has passed');
    if (!spec.sessionId && !spec.newSession) throw new ScheduleError('a schedule goes to a session, or makes a new one');
    if (this.list(spec.owner).length >= MAX_PER_OWNER) throw new ScheduleError(`at most ${MAX_PER_OWNER} schedules per person; delete some first`);
    const nextRun = spec.cron ? nextCron(spec.cron, now) : at;
    if (nextRun === undefined) throw new ScheduleError('that cron expression never matches');
    const s: Schedule = {
      id: crypto.randomBytes(6).toString('hex'), owner: spec.owner, title: (spec.title?.trim() || prompt.split('\n')[0]!).slice(0, 80), prompt,
      ...(spec.cron ? { cron: spec.cron.trim() } : { at }), ...(spec.sessionId ? { sessionId: spec.sessionId } : { newSession: spec.newSession }),
      enabled: true, createdAt: now, nextRun, runs: 0,
    };
    this.items.set(s.id, s);
    await this.save();
    return s;
  }

  async remove(id: string): Promise<boolean> {
    const ok = this.items.delete(id);
    if (ok) await this.save();
    return ok;
  }

  async setEnabled(id: string, enabled: boolean, now = Date.now()): Promise<Schedule | undefined> {
    const s = this.items.get(id);
    if (!s) return undefined;
    s.enabled = enabled;
    if (enabled && s.cron) s.nextRun = nextCron(s.cron, now);
    await this.save();
    return s;
  }

  /** Runs what is due. A run is one at a time per schedule; a one-time schedule ends after it. */
  async tick(now = Date.now()): Promise<Schedule[]> {
    if (this.ticking) return [];
    this.ticking = true;
    const fired: Schedule[] = [];
    try {
      for (const s of this.items.values()) {
        if (!s.enabled || s.nextRun === undefined || s.nextRun > now) continue;
        fired.push(s);
        await this.fire(s, now);
      }
      if (fired.length) await this.save();
    } finally { this.ticking = false; }
    return fired;
  }

  /** Runs one schedule now (the "run now" button), outside its timing. */
  async runNow(id: string, now = Date.now()): Promise<Schedule | undefined> {
    const s = this.items.get(id);
    if (!s) return undefined;
    await this.fire(s, now, true);
    await this.save();
    return s;
  }

  private async fire(s: Schedule, now: number, manual = false): Promise<void> {
    let r: { sessionId?: string; result: string };
    try { r = await this.runner.run(s); } catch (e) { r = { result: `failed: ${(e as Error).message}` }; }
    s.lastRun = now;
    s.lastResult = r.result;
    s.runs++;
    if (r.sessionId && !s.sessionId && s.newSession) this.log(`schedule ${s.id} ran in new session ${r.sessionId}`);
    if (!manual) {
      if (s.cron) s.nextRun = nextCron(s.cron, now);
      else { s.enabled = false; s.nextRun = undefined; }
    }
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify([...this.items.values()], null, 1));
    await fs.rename(tmp, this.file);
  }
}
