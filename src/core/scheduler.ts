import crypto from 'node:crypto';
import { FileWatch, readJson, withFileLock, writeFileAtomic } from '../util/shared-file.ts';
import path from 'node:path';
import type { SessionMeta } from './session.ts';
import { type RunEnd, type ScheduleRun, ScheduleRunLog } from './schedule-runs.ts';

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
  /** Five-field cron (minute hour day-of-month month day-of-week), in `timeZone` (else the server's). */
  cron?: string;
  /** An IANA time zone ("Europe/Berlin") the cron is read in; absent: the server's. */
  timeZone?: string;
  /** A run missed while the server was down: run it once when it is back (default), or skip it. */
  misfire?: 'once' | 'skip';
  /** The most one run may cost (USD): the run is stopped there. */
  maxCostUsd?: number;
  /**
   * How long a run waits for the person when it asks for approval or asks a question (it waits in their
   * inbox), in minutes; then the safe answer (no). Default 480 (8 hours). A Don't ask session never asks.
   */
  askTimeoutMinutes?: number;
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
  /** It runs this workflow (a graph of agent steps, gates and approvals) instead of sending its prompt. */
  workflow?: { name: string; input: Record<string, string> };
  /** The conversation whose agent set it up (the schedule tool), for that agent's list. */
  createdBy?: string;
}

export class ScheduleError extends Error {}

const FIELDS: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
const MAX_PER_OWNER = Number(process.env.HARNESS_MAX_SCHEDULES ?? 50);
/** The shortest time between two runs of a repeating schedule, in minutes: each run can cost a whole session. */
const MIN_GAP = Number(process.env.HARNESS_SCHEDULE_MIN_MINUTES ?? 5);
/** How late a run may start and still count as on time (the tick is every 30 s); later is a missed run. */
const MISFIRE_GRACE_MS = 3 * 60_000;
const MAX_RUN_USD = 1000;

/** The timing and limits a schedule may be made or changed with, checked. */
export function checkScheduleTiming(spec: Parameters<typeof checkTiming>[0], now = Date.now()): void { checkTiming(spec, now); }
function checkTiming(spec: { cron?: string; timeZone?: string; misfire?: string; maxCostUsd?: number; askTimeoutMinutes?: number }, now: number): void {
  if (spec.askTimeoutMinutes !== undefined && !(Number.isInteger(spec.askTimeoutMinutes) && spec.askTimeoutMinutes >= 1 && spec.askTimeoutMinutes <= 7 * 1440)) throw new ScheduleError('askTimeoutMinutes is a whole number of minutes from 1 to 10080 (a week)');
  if (spec.timeZone !== undefined && !validTimeZone(spec.timeZone)) throw new ScheduleError(`"${spec.timeZone}" is not a time zone this server knows (e.g. Europe/Berlin, America/New_York, UTC)`);
  if (spec.misfire !== undefined && spec.misfire !== 'once' && spec.misfire !== 'skip') throw new ScheduleError('misfire is once or skip');
  if (spec.maxCostUsd !== undefined && !(Number.isFinite(spec.maxCostUsd) && spec.maxCostUsd > 0 && spec.maxCostUsd <= MAX_RUN_USD)) throw new ScheduleError(`maxCostUsd is a number of dollars above 0 and at most ${MAX_RUN_USD}`);
  if (spec.cron) {
    const gap = cronGapMinutes(spec.cron, spec.timeZone, now);
    if (gap < MIN_GAP) throw new ScheduleError(`that runs every ${gap} minute${gap === 1 ? '' : 's'}; a schedule may run at most every ${MIN_GAP} minutes (HARNESS_SCHEDULE_MIN_MINUTES)`);
  }
}

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

/** A clock reading: the date and time a moment shows on a wall clock somewhere. */
interface Wall { y: number; mo: number; d: number; h: number; mi: number; dow: number }
const formats = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Whether the name is a time zone this runtime knows ("Europe/Berlin", "UTC"). */
export function validTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** The wall clock at `t` in the time zone (the server's own without one). */
function wallClock(t: number, tz?: string): Wall {
  if (!tz) { const d = new Date(t); return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), dow: d.getDay() }; }
  let f = formats.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' }); formats.set(tz, f); }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(t)) p[x.type] = x.value;
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute), dow: WEEKDAYS.indexOf(p.weekday!) };
}

interface Cron { min: Set<number>; hour: Set<number>; dom: Set<number>; mon: Set<number>; dow: Set<number>; domAny: boolean; dowAny: boolean }

function compileCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new ScheduleError('cron needs five fields: minute hour day-of-month month day-of-week (e.g. "0 9 * * 1-5")');
  const [min, hour, dom, mon, dow] = parts.map((p, i) => field(i === 4 ? p.replace(/\b7\b/g, '0') : p, FIELDS[i]!));
  return { min: min!, hour: hour!, dom: dom!, mon: mon!, dow: dow!, domAny: parts[2] === '*', dowAny: parts[4] === '*' };
}

// As in cron: when both day fields are restricted, either one matching is enough.
const dayMatches = (c: Cron, w: Wall) => c.mon.has(w.mo) && (c.domAny || c.dowAny ? c.dom.has(w.d) && c.dow.has(w.dow) : c.dom.has(w.d) || c.dow.has(w.dow));

/** A cron expression as a test on a time (minute resolution, the server's time zone). Day-of-week 7 is Sunday too. */
export function parseCron(expr: string): (d: Date) => boolean {
  const c = compileCron(expr);
  return (d) => { const w = wallClock(d.getTime()); return c.min.has(w.mi) && c.hour.has(w.h) && dayMatches(c, w); };
}

const wallKey = (w: Wall) => ((w.y * 100 + w.mo) * 100 + w.d) * 10_000 + w.h * 100 + w.mi;
const HORIZON_MS = 4 * 366 * 86_400_000;

/**
 * The first minute after `after` that the expression matches on the wall clock of `tz` (the server's
 * time zone without one), within four years (so the 29th of February is found). Daylight saving: a time
 * the clocks skip does not run that day, and a time they repeat runs once.
 */
export function nextCron(expr: string, after: number, tz?: string): number | undefined {
  const c = compileCron(expr);
  const since = wallKey(wallClock(after, tz));
  let t = Math.floor(after / 60_000) * 60_000 + 60_000;
  const minutes = [...c.min].sort((a, b) => a - b);
  while (t - after <= HORIZON_MS) {
    const w = wallClock(t, tz);
    const left = 1440 - (w.h * 60 + w.mi);
    // Whole days and hours are skipped in steps that never cross a daylight-saving change unseen
    // (clocks change on the hour or half hour): to an hour before midnight, then by half hours.
    if (!dayMatches(c, w)) { t += (left > 90 ? left - 60 : Math.max(1, 30 - (w.mi % 30))) * 60_000; continue; }
    if (!c.hour.has(w.h)) { t += Math.max(1, 30 - (w.mi % 30)) * 60_000; continue; }
    if (!c.min.has(w.mi) || wallKey(w) <= since) {
      const next = minutes.find((m) => m > w.mi);
      const toHalf = 30 - (w.mi % 30);
      t += Math.max(1, Math.min(next === undefined ? 60 - w.mi : next - w.mi, toHalf)) * 60_000;
      continue;
    }
    return t;
  }
  return undefined;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
const pad2 = (n: number) => String(n).padStart(2, '0');
const listOf = (xs: string[]) => (xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/**
 * A cron expression in plain words: "Every weekday at 09:00", "Every 15 minutes", "Every Monday and
 * Thursday at 18:30", "On the 1st of every month at 08:00". Unusual ones are described as best it can
 * ("At minute 5 and 35 of hours 9 to 17"); an invalid one throws.
 */
export function describeCron(expr: string): string {
  const c = compileCron(expr);
  const [mf, hf, domf, , dowf] = expr.trim().split(/\s+/) as [string, string, string, string, string];
  const mins = [...c.min].sort((a, b) => a - b), hours = [...c.hour].sort((a, b) => a - b);
  const allMin = mins.length === 60, allHour = hours.length === 24;
  const step = (f: string) => /^\*\/(\d+)$/.exec(f)?.[1];
  // The days part.
  const dows = [...c.dow].sort((a, b) => a - b);
  const weekdays = !c.dowAny && dows.join() === '1,2,3,4,5', weekend = !c.dowAny && dows.join() === '0,6';
  const months = [...c.mon].sort((a, b) => a - b);
  const monthPart = months.length === 12 ? '' : ` in ${listOf(months.map((m) => MONTH_NAMES[m - 1]!))}`;
  let days: string;
  if (c.domAny && c.dowAny) days = 'Every day';
  else if (c.domAny) days = weekdays ? 'Every weekday' : weekend ? 'Every weekend day' : `Every ${listOf(dows.map((d) => DAY_NAMES[d]!))}`;
  else if (c.dowAny && months.length === 1 && c.dom.size === 1) days = `Every ${MONTH_NAMES[months[0]! - 1]} ${ordinal([...c.dom][0]!)}`;
  else if (c.dowAny) days = `On the ${listOf([...c.dom].sort((a, b) => a - b).map(ordinal))} of ${months.length === 12 ? 'every month' : 'the month'}`;
  else days = `On the ${listOf([...c.dom].sort((a, b) => a - b).map(ordinal))}, and every ${listOf(dows.map((d) => DAY_NAMES[d]!))}`;
  if (!(c.dowAny && months.length === 1 && c.dom.size === 1 && !c.domAny)) days += monthPart;
  // The times part.
  if (allMin && allHour) return days === 'Every day' ? 'Every minute' : `${days}, every minute`;
  const ms = step(mf), hs = step(hf);
  if (ms && allHour && days === 'Every day') return `Every ${ms} minutes`;
  if (ms && allHour) return `${days}, every ${ms} minutes`;
  if (mins.length === 1 && allHour) return days === 'Every day' ? (mins[0] === 0 ? 'Every hour' : `Every hour at minute ${mins[0]}`) : `${days}, every hour${mins[0] ? ` at minute ${mins[0]}` : ''}`;
  if (mins.length === 1 && hs && hours[0] === 0) return `${days === 'Every day' ? 'Every' : `${days}, every`} ${hs} hours${mins[0] ? ` at minute ${mins[0]}` : ''}`;
  if (mins.length * hours.length <= 6) {
    const times = hours.flatMap((h) => mins.map((m) => `${pad2(h)}:${pad2(m)}`));
    return `${days} at ${listOf(times)}`;
  }
  const range = (xs: number[]) => (xs.length > 2 && xs.at(-1)! - xs[0]! === xs.length - 1 ? `${xs[0]} to ${xs.at(-1)}` : listOf(xs.map(String)));
  const minPart = ms ? `every ${ms} minutes` : `at minute ${range(mins)}`;
  return `${days}, ${minPart}${allHour ? '' : ` of hour${hours.length === 1 ? '' : 's'} ${range(hours)}`}`;
}

/** When a schedule runs, in words (its time zone named when it has one). */
export function describeSchedule(s: Pick<Schedule, 'cron' | 'at' | 'timeZone' | 'triggerHash'>): string {
  if (s.triggerHash) return 'When its URL is called';
  if (s.cron) { try { return `${describeCron(s.cron)}${s.timeZone ? ` (${s.timeZone})` : ''}`; } catch { return s.cron; } }
  return s.at ? `Once, at ${new Date(s.at).toISOString()}` : 'Once';
}

/** The next `n` times a cron expression runs (in its time zone), from `from`. */
export function nextRuns(expr: string, n: number, tz?: string, from = Date.now()): number[] {
  const out: number[] = [];
  let at = from;
  for (let i = 0; i < n; i++) { const t = nextCron(expr, at, tz); if (t === undefined) break; out.push(t); at = t; }
  return out;
}

/** A workflow target, checked: a name, and its inputs as strings. */
function checkWorkflow(w: unknown): Schedule['workflow'] {
  if (w === undefined || w === null) return undefined;
  const o = w as { name?: unknown; input?: unknown };
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  if (!name || !/^[\w.:-]{1,80}$/.test(name)) throw new ScheduleError('workflow.name is the name of a workflow (letters, digits, - _ . :)');
  const input = o.input && typeof o.input === 'object' && !Array.isArray(o.input) ? Object.fromEntries(Object.entries(o.input as Record<string, unknown>).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])) : {};
  if (JSON.stringify(input).length > 20_000) throw new ScheduleError("the workflow's inputs are limited to 20,000 characters");
  return { name, input };
}

/** The shortest time between two runs of a cron expression, in minutes (over its next runs). */
export function cronGapMinutes(expr: string, tz?: string, from = Date.now()): number {
  let gap = Infinity;
  let at = nextCron(expr, from, tz);
  for (let i = 0; i < 12 && at !== undefined; i++) {
    const n = nextCron(expr, at, tz);
    if (n === undefined) break;
    gap = Math.min(gap, (n - at) / 60_000);
    at = n;
  }
  return gap;
}

export interface ScheduleRunner {
  /**
   * Sends the prompt; returns which session it went to, or why it did not run.
   * `outside` is text a trigger brought from outside (a chat message, a webhook):
   * it goes with the prompt as data, and the session counts as having read untrusted content.
   * `finished`: settles with how the run ended (its turn's end), when it started.
   */
  run(s: Schedule, outside?: string): Promise<LaunchResult>;
}

export interface LaunchResult { sessionId?: string; result: string; finished?: Promise<RunEnd> }

/** A run's record status from what launching it said. */
const startStatus = (result: string): ScheduleRun['status'] => (result === 'started' ? 'running' : /^failed/.test(result) ? 'failed' : 'skipped');

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
  /** Told of every change and run here (the server's global event stream): fired when a run starts, ended with its record when it ends. */
  onEvent?: (type: 'fired' | 'changed' | 'ended', s: Schedule, run?: { sessionId?: string; result: string; record?: ScheduleRun }) => void;
  private tell(type: 'fired' | 'changed' | 'ended', s: Schedule | undefined, run?: { sessionId?: string; result: string; record?: ScheduleRun }): void {
    if (!s) return;
    try { this.onEvent?.(type, s, run); } catch { /* a listener never breaks the scheduler */ }
  }
  /** Every run's record: when, how it ended, what it cost, what it did. */
  readonly runs: ScheduleRunLog;
  /** Runs started here that have not ended yet (they end when their turn does). */
  private open = new Set<Promise<unknown>>();

  /** The runner, unless the schedule's owner can no longer run work. */
  private async launch(s: Schedule, outside?: string): Promise<LaunchResult> {
    if (s.owner && this.ownerActive && !this.ownerActive(s.owner)) return { result: 'not run: its owner\'s account is disabled' };
    const busy = s.owner ? this.mayRun?.(s.owner, s) : undefined;
    if (busy) return { result: `not run: ${busy}` };
    const off = this.pluginOff?.(s);
    if (off) return { result: `skipped: ${off}` };
    try { return await this.runner.run(s, outside); } catch (e) { return { result: `failed: ${(e as Error).message}` }; }
  }

  constructor(dataDir: string, runner: ScheduleRunner, log: (m: string) => void = () => {}) {
    this.file = path.join(dataDir, 'schedules.json');
    this.runs = new ScheduleRunLog(dataDir);
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

  /** The server is shutting down: turns it stops now end their runs as interrupted. */
  private closing = false;
  stop(o: { closing?: boolean } = {}): void { clearInterval(this.timer); if (o.closing) this.closing = true; }

  list(owner?: string): Schedule[] {
    return [...this.items.values()].filter((s) => owner === undefined || s.owner === owner).sort((a, b) => (a.nextRun ?? Infinity) - (b.nextRun ?? Infinity));
  }

  get(id: string): Schedule | undefined { return this.items.get(id); }

  async create(spec: { owner?: string; title?: string; prompt: string; cron?: string; at?: number; inMinutes?: number; sessionId?: string; newSession?: Schedule['newSession']; plugin?: string; timeZone?: string; misfire?: 'once' | 'skip'; maxCostUsd?: number; askTimeoutMinutes?: number; workflow?: Schedule['workflow']; createdBy?: string }, now = Date.now()): Promise<Schedule> {
    const workflow = checkWorkflow(spec.workflow);
    const prompt = spec.prompt?.trim() || (workflow ? `Run the workflow ${workflow.name}` : '');
    if (!prompt) throw new ScheduleError('a schedule needs a prompt');
    if (prompt.length > 20_000) throw new ScheduleError('the prompt is limited to 20,000 characters');
    const at = spec.at ?? (spec.inMinutes !== undefined ? now + Math.max(1, spec.inMinutes) * 60_000 : undefined);
    if (!spec.cron === (at === undefined)) throw new ScheduleError('give either cron (repeating) or a time (at / in_minutes), not both or neither');
    if (at !== undefined && !(at > now)) throw new ScheduleError('that time has passed');
    if (!spec.sessionId && !spec.newSession) throw new ScheduleError('a schedule goes to a session, or makes a new one');
    checkTiming(spec, now);
    const nextRun = spec.cron ? nextCron(spec.cron, now, spec.timeZone) : at;
    if (nextRun === undefined) throw new ScheduleError('that cron expression never matches');
    const s: Schedule = {
      id: crypto.randomBytes(6).toString('hex'), owner: spec.owner, title: (spec.title?.trim() || prompt.split('\n')[0]!).slice(0, 80), prompt,
      ...(spec.cron ? { cron: spec.cron.trim() } : { at }), ...(spec.sessionId ? { sessionId: spec.sessionId } : { newSession: spec.newSession }),
      ...(spec.cron && spec.timeZone ? { timeZone: spec.timeZone } : {}), ...(spec.misfire ? { misfire: spec.misfire } : {}), ...(spec.maxCostUsd ? { maxCostUsd: spec.maxCostUsd } : {}), ...(spec.askTimeoutMinutes ? { askTimeoutMinutes: spec.askTimeoutMinutes } : {}),
      ...(workflow ? { workflow } : {}), ...(spec.createdBy ? { createdBy: spec.createdBy } : {}),
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
  async createTrigger(spec: { owner?: string; title?: string; prompt: string; sessionId?: string; newSession?: Schedule['newSession']; maxCostUsd?: number; askTimeoutMinutes?: number; workflow?: Schedule['workflow'] }, now = Date.now()): Promise<{ schedule: Schedule; token: string }> {
    const workflow = checkWorkflow(spec.workflow);
    const prompt = spec.prompt?.trim() || (workflow ? `Run the workflow ${workflow.name}` : '');
    if (!prompt) throw new ScheduleError('a trigger needs a prompt');
    if (!spec.sessionId && !spec.newSession) throw new ScheduleError('a trigger goes to a session, or makes a new one');
    checkTiming({ maxCostUsd: spec.maxCostUsd, askTimeoutMinutes: spec.askTimeoutMinutes }, now);
    const token = `hwt_${crypto.randomBytes(24).toString('base64url')}`;
    const s: Schedule = {
      id: crypto.randomBytes(6).toString('hex'), owner: spec.owner, title: (spec.title?.trim() || prompt.split('\n')[0]!).slice(0, 80), prompt,
      ...(spec.sessionId ? { sessionId: spec.sessionId } : { newSession: spec.newSession }),
      enabled: true, triggerHash: hashToken(token), createdAt: now, runs: 0, ...(spec.maxCostUsd ? { maxCostUsd: spec.maxCostUsd } : {}), ...(spec.askTimeoutMinutes ? { askTimeoutMinutes: spec.askTimeoutMinutes } : {}), ...(workflow ? { workflow } : {}),
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
    await this.record(s.id, now, r, 'trigger');
    return { ...(r.sessionId ? { sessionId: r.sessionId } : {}), result: r.result };
  }

  /**
   * Changes a schedule's title, prompt, timing or limits (not where it runs). A new time recomputes the
   * next run; `null` clears an optional field (the time zone, the cost limit).
   */
  async update(id: string, patch: { title?: string; prompt?: string; cron?: string; at?: number; inMinutes?: number; timeZone?: string | null; misfire?: 'once' | 'skip'; maxCostUsd?: number | null; askTimeoutMinutes?: number | null; workflow?: Schedule['workflow'] }, now = Date.now()): Promise<Schedule | undefined> {
    const cur = this.items.get(id);
    if (!cur) return undefined;
    const workflow = patch.workflow === undefined ? cur.workflow : checkWorkflow(patch.workflow);
    const at = patch.at ?? (patch.inMinutes !== undefined ? now + Math.max(1, patch.inMinutes) * 60_000 : undefined);
    if (cur.triggerHash && (patch.cron || at !== undefined || patch.timeZone)) throw new ScheduleError('a trigger runs when its URL is called; it has no time');
    const prompt = patch.prompt === undefined ? cur.prompt : patch.prompt.trim();
    if (!prompt) throw new ScheduleError('a schedule needs a prompt');
    if (prompt.length > 20_000) throw new ScheduleError('the prompt is limited to 20,000 characters');
    if (patch.cron && at !== undefined) throw new ScheduleError('give either cron (repeating) or a time (at / in_minutes), not both');
    if (at !== undefined && !(at > now)) throw new ScheduleError('that time has passed');
    const cron = patch.cron?.trim() || (at !== undefined ? undefined : cur.cron);
    const timeZone = patch.timeZone === null ? undefined : patch.timeZone ?? cur.timeZone;
    const maxCostUsd = patch.maxCostUsd === null ? undefined : patch.maxCostUsd ?? cur.maxCostUsd;
    const misfire = patch.misfire ?? cur.misfire;
    const askTimeoutMinutes = patch.askTimeoutMinutes === null ? undefined : patch.askTimeoutMinutes ?? cur.askTimeoutMinutes;
    checkTiming({ cron, timeZone, misfire, maxCostUsd, askTimeoutMinutes }, now);
    const timing = !cur.triggerHash && (!!patch.cron || at !== undefined || patch.timeZone !== undefined);
    const nextRun = !timing ? cur.nextRun : cron ? nextCron(cron, now, timeZone) : at;
    if (timing && nextRun === undefined) throw new ScheduleError('that cron expression never matches');
    const done = await this.mutate(() => {
      const s = this.items.get(id);
      if (!s) return undefined;
      s.prompt = prompt;
      if (workflow) s.workflow = workflow;
      if (patch.title !== undefined) s.title = (patch.title.trim() || prompt.split('\n')[0]!).slice(0, 80);
      if (timing) {
        if (cron) { s.cron = cron; delete s.at; } else { s.at = at; delete s.cron; }
        if (cron && timeZone) s.timeZone = timeZone; else delete s.timeZone;
        s.nextRun = nextRun;
        // A new time for a one-time schedule that already ran makes it run again.
        if (!cron) s.enabled = true;
      }
      if (misfire) s.misfire = misfire; else delete s.misfire;
      if (maxCostUsd) s.maxCostUsd = maxCostUsd; else delete s.maxCostUsd;
      if (askTimeoutMinutes) s.askTimeoutMinutes = askTimeoutMinutes; else delete s.askTimeoutMinutes;
      return s;
    });
    this.tell('changed', done);
    return done;
  }

  async remove(id: string): Promise<boolean> {
    const s = this.items.get(id);
    const ok = await this.mutate(() => this.items.delete(id));
    if (ok) { this.tell('changed', s && { ...s, enabled: false }); await this.runs.forget(id).catch(() => {}); }
    return ok;
  }

  async setEnabled(id: string, enabled: boolean, now = Date.now()): Promise<Schedule | undefined> {
    const done = await this.mutate(() => {
      const s = this.items.get(id);
      if (!s) return undefined;
      // A one-time schedule that already ran (or whose time passed) has nothing left to run.
      if (enabled && !s.cron && !s.triggerHash && (s.at === undefined || s.at <= now)) throw new Error('This one-time schedule has already run or its time has passed; create a new one.');
      s.enabled = enabled;
      if (enabled && s.cron) s.nextRun = nextCron(s.cron, now, s.timeZone);
      if (enabled && !s.cron && s.at !== undefined) s.nextRun = s.at;
      return s;
    });
    this.tell('changed', done);
    return done;
  }

  /**
   * Runs what is due. A run is one at a time per schedule; a one-time schedule ends
   * after it. Each run is claimed on disk first (its next time moved on), so with
   * several servers it fires once even if the leadership changes hands. A run missed
   * while the server was down runs once now, or is skipped (misfire: skip).
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
        const missed = due.misfire === 'skip' && now - due.nextRun > MISFIRE_GRACE_MS ? `missed: it was due at ${new Date(due.nextRun).toISOString()}, while this server was not running` : undefined;
        if (off || missed) {
          const note = off ? `skipped: ${off}` : `skipped: ${missed}`;
          if (due.cron || missed || due.lastResult !== note) {
            const skipped = await this.mutate(() => {
              const s = this.items.get(due.id);
              if (!s) return undefined;
              if (s.cron) s.nextRun = nextCron(s.cron, now, s.timeZone);
              else if (missed) { s.enabled = false; s.nextRun = undefined; }
              s.lastRun = now;
              s.lastResult = note;
              return s;
            });
            const record = skipped ? await this.runs.start({ scheduleId: due.id, owner: due.owner, title: due.title, by: 'schedule', startedAt: now, endedAt: now, status: 'skipped', reason: note }).catch(() => undefined) : undefined;
            this.tell('fired', skipped, { result: note, ...(record ? { record } : {}) });
          }
          continue;
        }
        const claimed = await this.mutate(() => {
          const s = this.items.get(due.id);
          if (!s || !s.enabled || s.nextRun === undefined || s.nextRun > now) return undefined;
          const copy = { ...s };
          if (s.cron) s.nextRun = nextCron(s.cron, now, s.timeZone);
          else { s.enabled = false; s.nextRun = undefined; }
          return copy;
        });
        if (!claimed) continue;
        const r = await this.launch(claimed);
        const done = await this.record(claimed.id, now, r, 'schedule');
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
    return this.record(id, now, r, 'manual');
  }

  /** Runs written down as running that no longer are (their server stopped): ended as interrupted. */
  async closeInterrupted(stillRunning: (sessionId: string | undefined) => Promise<boolean>, now = Date.now()): Promise<number> {
    let n = 0;
    for (const r of await this.runs.list({ status: 'running', all: true, limit: 500 })) {
      if (await stillRunning(r.sessionId)) continue;
      const rec = await this.runs.finish(r, { status: 'interrupted', reason: 'interrupted: the server stopped before the run ended', endedAt: now });
      await this.mutate(() => { const x = this.items.get(r.scheduleId); if (x && x.lastRun === r.startedAt) x.lastResult = describeRun(rec); return x; });
      n++;
    }
    return n;
  }

  /** Waits until the runs started by this scheduler have ended and been written down (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.open.size) await Promise.all([...this.open]);
  }

  /** Writes down a run: the schedule's last run, and its record (ended already, or when its turn ends). */
  private async record(id: string, now: number, r: LaunchResult, by: ScheduleRun['by']): Promise<Schedule | undefined> {
    const done = await this.mutate(() => {
      const s = this.items.get(id);
      if (!s) return undefined;
      s.lastRun = now;
      s.lastResult = r.result;
      s.runs++;
      if (r.sessionId && !s.sessionId && s.newSession) this.log(`schedule ${s.id} ran in new session ${r.sessionId}`);
      return s;
    });
    if (!done) return done;
    const status = startStatus(r.result);
    const record = await this.runs.start({ scheduleId: id, owner: done.owner, title: done.title, by, startedAt: now, status, ...(status !== 'running' ? { reason: r.result, endedAt: now } : {}), ...(r.sessionId ? { sessionId: r.sessionId } : {}) }).catch((e: Error) => { this.log(`schedule ${id}: its run could not be written down: ${e.message}`); return undefined; });
    this.tell('fired', done, { sessionId: r.sessionId, result: r.result, ...(record ? { record } : {}) });
    if (record && r.finished) this.track(done, record, r.finished);
    return done;
  }

  /** When a started run ends: its record gets the outcome, and the schedule's last result says it. */
  private track(s: Schedule, run: ScheduleRun, finished: Promise<RunEnd>): void {
    const p: Promise<void> = finished
      .catch((e: Error): RunEnd => ({ status: 'failed', reason: `failed: ${e.message}` }))
      .then((end): RunEnd => (this.closing && end.status === 'stopped' ? { ...end, status: 'interrupted', reason: 'interrupted: the server stopped before the run ended' } : end))
      .then(async (end) => {
        const rec = await this.runs.finish(run, end);
        const result = describeRun(rec);
        const now = await this.mutate(() => {
          const x = this.items.get(s.id);
          // Only the latest run speaks for the schedule.
          if (x && x.lastRun === run.startedAt) x.lastResult = result;
          return x;
        });
        this.tell('ended', now ?? s, { ...(rec.sessionId ? { sessionId: rec.sessionId } : {}), result, record: rec });
      })
      .catch((e: Error) => this.log(`schedule ${s.id}: the end of its run could not be written down: ${e.message}`))
      .finally(() => { this.open.delete(p); });
    this.open.add(p);
  }
}

/** A run's outcome in a few words, for the schedule's last result. */
export function describeRun(r: ScheduleRun): string {
  if (r.status === 'completed') return r.noOp ? 'completed: nothing to report' : 'completed';
  // A reason that already names how it ended ("Stopped: this scheduled run reached ...", "skipped: ...") is said once.
  return r.reason && r.reason.toLowerCase().startsWith(`${r.status}:`) ? r.reason : `${r.status}${r.reason ? `: ${r.reason}` : ''}`;
}
