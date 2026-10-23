import crypto from 'node:crypto';
import { FileWatch, readJson, withFileLock, writeFileAtomic } from '../util/shared-file.ts';
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
  /** A trigger: started by a secret URL instead of a time (its hash; the URL is shown once). */
  triggerHash?: string;
  createdAt: number;
  nextRun?: number;
  lastRun?: number;
  lastResult?: string;
  runs: number;
  /** The plugin it was made for (by a session the plugin started): skipped while that plugin is switched off. */
  plugin?: string;
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
  /**
   * Sends the prompt; returns which session it went to, or why it did not run.
   * `outside` is text a trigger brought from outside (a chat message, a webhook):
   * it goes with the prompt as data, and the session counts as having read untrusted content.
   */
  run(s: Schedule, outside?: string): Promise<{ sessionId?: string; result: string }>;
}

const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

export class Scheduler {
  private file: string;
  private items = new Map<string, Schedule>();
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private runner: ScheduleRunner;
  private log: (m: string) => void;
  private watch: FileWatch;
  /** Whether an owner's account may still run work (set by the server: disabled accounts may not). */
  ownerActive?: (owner: string) => boolean;
  /** Why its owner may not start one more run now (their concurrency limits), set by the server; the run is skipped and says why. */
  mayRun?: (owner: string, s: Schedule) => string | undefined;
  /**
   * Several servers on one data folder: whether this one fires the schedules now
   * (it holds the scheduler lease). Absent: it always does.
   */
  leader?: () => Promise<boolean>;
  /**
   * Why a schedule does not run now because a plugin it belongs to is switched off (set by the
   * server): it is skipped, with the reason as its last result, and kept.
   */
  pluginOff?: (s: Schedule) => string | undefined;
  /** Told of every change and run here (the server's global event stream). */
  onEvent?: (type: 'fired' | 'changed', s: Schedule, run?: { sessionId?: string; result: string }) => void;
  private tell(type: 'fired' | 'changed', s: Schedule | undefined, run?: { sessionId?: string; result: string }): void {
    if (!s) return;
    try { this.onEvent?.(type, s, run); } catch { /* a listener never breaks the scheduler */ }
  }

  /** The runner, unless the schedule's owner can no longer run work. */
  private async launch(s: Schedule, outside?: string): Promise<{ sessionId?: string; result: string }> {
    if (s.owner && this.ownerActive && !this.ownerActive(s.owner)) return { result: 'not run: its owner\'s account is disabled' };
    const busy = s.owner ? this.mayRun?.(s.owner, s) : undefined;
    if (busy) return { result: `not run: ${busy}` };
    const off = this.pluginOff?.(s);
    if (off) return { result: `skipped: ${off}` };
    try { return await this.runner.run(s, outside); } catch (e) { return { result: `failed: ${(e as Error).message}` }; }
  }

  constructor(dataDir: string, runner: ScheduleRunner, log: (m: string) => void = () => {}) {
    this.file = path.join(dataDir, 'schedules.json');
    this.runner = runner;
    this.log = log;
    this.watch = new FileWatch(this.file);
  }

  async load(): Promise<void> {
    await this.reload();
  }

  /** The schedules as they are on disk now (another server may have changed them). */
  private async reload(): Promise<void> {
    const list = await readJson<Schedule[]>(this.file, []);
    this.items = new Map((Array.isArray(list) ? list : []).map((s) => [s.id, s]));
    await this.watch.mark();
  }

  /** Reads the schedules again when another server changed them (checked at most once a second unless `force`). */
  async sync(force = false): Promise<void> {
    if (await this.watch.changed(force)) await this.reload();
  }

  /**
   * One change, made under the file's lock on the schedules as they are on disk now
   * and written atomically, so changes from several servers never overwrite each other.
   */
  private async mutate<T>(fn: () => T): Promise<T> {
    return withFileLock(this.file, async () => {
      await this.reload();
      const r = fn();
      await writeFileAtomic(this.file, JSON.stringify([...this.items.values()], null, 1));
      await this.watch.mark();
      return r;
    });
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

  async create(spec: { owner?: string; title?: string; prompt: string; cron?: string; at?: number; inMinutes?: number; sessionId?: string; newSession?: Schedule['newSession']; plugin?: string }, now = Date.now()): Promise<Schedule> {
    const prompt = spec.prompt?.trim();
    if (!prompt) throw new ScheduleError('a schedule needs a prompt');
    if (prompt.length > 20_000) throw new ScheduleError('the prompt is limited to 20,000 characters');
    const at = spec.at ?? (spec.inMinutes !== undefined ? now + Math.max(1, spec.inMinutes) * 60_000 : undefined);
    if (!spec.cron === (at === undefined)) throw new ScheduleError('give either cron (repeating) or a time (at / in_minutes), not both or neither');
    if (at !== undefined && at <= now) throw new ScheduleError('that time has passed');
    if (!spec.sessionId && !spec.newSession) throw new ScheduleError('a schedule goes to a session, or makes a new one');
    const nextRun = spec.cron ? nextCron(spec.cron, now) : at;
    if (nextRun === undefined) throw new ScheduleError('that cron expression never matches');
    const s: Schedule = {
      id: crypto.randomBytes(6).toString('hex'), owner: spec.owner, title: (spec.title?.trim() || prompt.split('\n')[0]!).slice(0, 80), prompt,
      ...(spec.cron ? { cron: spec.cron.trim() } : { at }), ...(spec.sessionId ? { sessionId: spec.sessionId } : { newSession: spec.newSession }),
      enabled: true, createdAt: now, nextRun, runs: 0, ...(spec.plugin ? { plugin: spec.plugin } : {}),
    };
    const made = await this.mutate(() => {
      if (this.list(spec.owner).length >= MAX_PER_OWNER) throw new ScheduleError(`at most ${MAX_PER_OWNER} schedules per person; delete some first`);
      this.items.set(s.id, s);
      return s;
    });
    this.tell('changed', made);
    return made;
  }

  /**
   * A trigger: the same prompt and target as a schedule, started by POSTing to a secret
   * URL (from Slack, a GitHub webhook, a phone shortcut). The token is returned once and
   * stored only as a hash.
   */
  async createTrigger(spec: { owner?: string; title?: string; prompt: string; sessionId?: string; newSession?: Schedule['newSession'] }, now = Date.now()): Promise<{ schedule: Schedule; token: string }> {
    const prompt = spec.prompt?.trim();
    if (!prompt) throw new ScheduleError('a trigger needs a prompt');
    if (!spec.sessionId && !spec.newSession) throw new ScheduleError('a trigger goes to a session, or makes a new one');
    const token = `hwt_${crypto.randomBytes(24).toString('base64url')}`;
    const s: Schedule = {
      id: crypto.randomBytes(6).toString('hex'), owner: spec.owner, title: (spec.title?.trim() || prompt.split('\n')[0]!).slice(0, 80), prompt,
      ...(spec.sessionId ? { sessionId: spec.sessionId } : { newSession: spec.newSession }),
      enabled: true, triggerHash: hashToken(token), createdAt: now, runs: 0,
    };
    const made = await this.mutate(() => {
      if (this.list(spec.owner).length >= MAX_PER_OWNER) throw new ScheduleError(`at most ${MAX_PER_OWNER} schedules and triggers per person`);
      this.items.set(s.id, s);
      return { schedule: s, token };
    });
    this.tell('changed', made.schedule);
    return made;
  }

  /** Fires the trigger a token belongs to, with what the caller sent; undefined for an unknown or disabled one. */
  async fireTrigger(token: string, outside: string, now = Date.now()): Promise<{ sessionId?: string; result: string } | undefined> {
    await this.sync(true);
    const h = hashToken(token);
    const s = [...this.items.values()].find((x) => x.triggerHash && crypto.timingSafeEqual(Buffer.from(x.triggerHash), Buffer.from(h)));
    if (!s || !s.enabled) return undefined;
    const r = await this.launch(s, outside.slice(0, 20_000));
    await this.record(s.id, now, r);
    return r;
  }

  async remove(id: string): Promise<boolean> {
    const s = this.items.get(id);
    const ok = await this.mutate(() => this.items.delete(id));
    if (ok) this.tell('changed', s && { ...s, enabled: false });
    return ok;
  }

  async setEnabled(id: string, enabled: boolean, now = Date.now()): Promise<Schedule | undefined> {
    const done = await this.mutate(() => {
      const s = this.items.get(id);
      if (!s) return undefined;
      // A one-time schedule that already ran (or whose time passed) has nothing left to run.
      if (enabled && !s.cron && !s.triggerHash && (s.at === undefined || s.at <= now)) throw new Error('This one-time schedule has already run or its time has passed; create a new one.');
      s.enabled = enabled;
      if (enabled && s.cron) s.nextRun = nextCron(s.cron, now);
      if (enabled && !s.cron && s.at !== undefined) s.nextRun = s.at;
      return s;
    });
    this.tell('changed', done);
    return done;
  }

  /**
   * Runs what is due. A run is one at a time per schedule; a one-time schedule ends
   * after it. Each run is claimed on disk first (its next time moved on), so with
   * several servers it fires once even if the leadership changes hands.
   */
  async tick(now = Date.now()): Promise<Schedule[]> {
    if (this.ticking) return [];
    this.ticking = true;
    const fired: Schedule[] = [];
    try {
      if (this.leader && !(await this.leader())) return [];
      await this.sync(true);
      for (const due of [...this.items.values()]) {
        if (!due.enabled || due.nextRun === undefined || due.nextRun > now) continue;
        // Its plugin is switched off: skipped with a note, kept. A one-time schedule stays due (it runs when the plugin is back).
        const off = this.pluginOff?.(due);
        if (off) {
          const note = `skipped: ${off}`;
          if (due.cron || due.lastResult !== note) {
            const skipped = await this.mutate(() => {
              const s = this.items.get(due.id);
              if (!s) return undefined;
              if (s.cron) s.nextRun = nextCron(s.cron, now);
              s.lastRun = now;
              s.lastResult = note;
              return s;
            });
            this.tell('fired', skipped, { result: note });
          }
          continue;
        }
        const claimed = await this.mutate(() => {
          const s = this.items.get(due.id);
          if (!s || !s.enabled || s.nextRun === undefined || s.nextRun > now) return undefined;
          const copy = { ...s };
          if (s.cron) s.nextRun = nextCron(s.cron, now);
          else { s.enabled = false; s.nextRun = undefined; }
          return copy;
        });
        if (!claimed) continue;
        const r = await this.launch(claimed);
        const done = await this.record(claimed.id, now, r);
        if (done) fired.push(done);
      }
    } finally { this.ticking = false; }
    return fired;
  }

  /** Runs one schedule now (the "run now" button), outside its timing. */
  async runNow(id: string, now = Date.now()): Promise<Schedule | undefined> {
    await this.sync(true);
    const s = this.items.get(id);
    if (!s) return undefined;
    const r = await this.launch(s);
    return this.record(id, now, r);
  }

  /** Writes down a run's outcome. */
  private async record(id: string, now: number, r: { sessionId?: string; result: string }): Promise<Schedule | undefined> {
    const done = await this.mutate(() => {
      const s = this.items.get(id);
      if (!s) return undefined;
      s.lastRun = now;
      s.lastResult = r.result;
      s.runs++;
      if (r.sessionId && !s.sessionId && s.newSession) this.log(`schedule ${s.id} ran in new session ${r.sessionId}`);
      return s;
    });
    this.tell('fired', done, r);
    return done;
  }
}
