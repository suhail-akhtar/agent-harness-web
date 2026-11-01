import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { FileWatch, readJson, withFileLock, writeFileAtomic } from '../util/shared-file.ts';
import { dayOf, decideAlert, type Held, type Interruptions } from './initiative.ts';
import type { InboxItem, InboxStore, NoticedDraft } from './inbox.ts';
import { normalizeError, normCmd } from './progress.ts';
import type { Schedule, Scheduler } from './scheduler.ts';
import type { HarnessEvent, TurnEndReason } from './types.ts';

// Agents that notice things themselves, without anyone setting up a schedule or a watch
// (docs/proactive/NOTICING.md). Watching costs nothing: every session's events are counted into a small
// activity log of fingerprints (a command's hash, an error's hash, whether a check passed, a prompt's word
// hashes), never their content. Four fixed detectors read it at natural pauses (a turn's end, once an
// hour); no model watches. A finding passes cheap gates (muted, cooling down, already in the inbox, held
// back to measure, over the day's budget: dropped, never queued) and only then reaches the person: in
// their inbox, or as one quiet line in the conversation it is about. The person's dismissals only ever
// make it quieter; a detector whose findings are mostly unwanted moves to the digest, then turns itself
// off, and only the person turns it on again. It starts in practice: findings are written down, not
// shown, until the person has looked at what it would have said and turned it on.

export type DetectorId = 'away_failure' | 'routine_health' | 'stuck' | 'repeated_task';
export const DETECTORS: Array<{ id: DetectorId; title: string; blurb: string }> = [
  { id: 'away_failure', title: 'Failed while you were away', blurb: 'A long conversation stopped on an error or a limit while you were not looking at it' },
  { id: 'routine_health', title: 'Schedules in trouble', blurb: 'A schedule keeps failing, being skipped or hitting its spend limit, or a watch cannot check' },
  { id: 'stuck', title: 'Stuck on the same failure', blurb: 'The same command failed the same way 3 times, with no edits in between' },
  { id: 'repeated_task', title: 'A task you repeat', blurb: 'You asked for the same thing on 3 different days: it offers a schedule in your own words' },
];
const IDS = new Set<string>(DETECTORS.map((d) => d.id));

/** off: nothing is observed; practice: findings are written down, not shown; on: they are shown. */
export type NoticeMode = 'off' | 'practice' | 'on';

export interface NoticingSettings {
  mode: NoticeMode;
  /** A detector the person switched off (absent: on). */
  detectors?: Partial<Record<DetectorId, boolean>>;
  /** When practice began (its first finding or the person's choice). */
  practiceSince?: number;
}

/** One line of the activity log: a fingerprint of something that happened, never what was said or shown. */
export interface Activity {
  at: number;
  owner?: string;
  sid: string;
  project?: string;
  k: 'cmd' | 'edit' | 'turn';
  turn?: number;
  /** cmd: the command's hash, its error's hash when it failed. */
  cmd?: string;
  err?: string;
  ok?: boolean;
  /** turn: typed by the person; its prompt's word hashes; how it ended; how long it took; nobody was looking at it. */
  person?: boolean;
  sig?: string[];
  end?: TurnEndReason;
  ms?: number;
  away?: boolean;
}

/** What became of a finding. */
export type Outcome = 'shown' | 'practice' | 'holdout' | 'muted' | 'budget' | 'off';

/** A finding, as written down (every one, shown or not: the review page and the measures read these). */
export interface Finding {
  at: number;
  owner?: string;
  detector: DetectorId;
  fingerprint: string;
  outcome: Outcome;
  title: string;
  body: string;
  level: InboxItem['level'];
  sessionId?: string;
  scheduleId?: string;
  project?: string;
  itemId?: string;
  sig?: string[];
  inline?: boolean;
  draft?: NoticedDraft;
  action?: { label: string; prompt: string };
}

/** Muted by the person's dismissal: a fingerprint, a prompt's words (repeated tasks), or a detector in a project. */
interface Mute { detector: DetectorId; fingerprint?: string; sig?: string[]; project?: string; until?: number; why: string }

/** A detector's state: on, moved to the digest, or off (by itself, with why, or by the person). */
interface DetectorState { state: 'on' | 'digest' | 'off'; why?: string; at?: number; since?: number }

interface OwnerState { settings?: NoticingSettings; detectors?: Partial<Record<DetectorId, DetectorState>>; mutes?: Mute[]; lastReviewInvite?: number }

export interface DetectorStats { shown: number; acted: number; notUseful: number; badTiming: number; ignored: number; holdout: number; selfFound: number; practice: number }

export interface NoticingOverview {
  enabled: boolean;
  mode: NoticeMode;
  practiceSince?: number;
  practiceDays: number;
  /** Practice has run its days: time to look at what it would have said. */
  ready: boolean;
  detectors: Array<{ id: DetectorId; title: string; blurb: string; enabled: boolean; state: DetectorState['state']; why?: string; stats: DetectorStats }>;
  /** What it would have said (practice), newest first. */
  practice: Array<Pick<Finding, 'at' | 'detector' | 'title' | 'body' | 'level' | 'sessionId' | 'scheduleId' | 'draft'>>;
  observed: { commands: number; failed: number; edits: number; turns: number; typed: number; projects: number; since?: number; days: number };
  today: { shown: number; alerts: number };
  limits: { perDay: number; alertsPerDay: number; keepDays: number };
}

const DAY = 86_400_000;
const KEEP_DAYS = 14;
const FINDINGS_DAYS = 30;
const PER_DAY = 3;
const ALERTS_PER_DAY = 1;
const COOLDOWN = 72 * 3600_000;
const STUCK_WINDOW = 20 * 60_000;
const STUCK_TIMES = 3;
const REPEAT_DAYS = 3;
const REPEAT_SIM = 0.6;
const AWAY_ENDS = new Set<TurnEndReason>(['error', 'budget', 'time', 'max_steps', 'refusal', 'max_tokens']);
const env = (k: string, d: number) => { const v = Number(process.env[k]); return Number.isFinite(v) && process.env[k] !== '' && process.env[k] !== undefined ? v : d; };

const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12);
const STOP = new Set('a an and are as at be by can could do for from have i in is it its me my of on or please so that the this to us we what when with you your'.split(' '));

/** A prompt's word hashes (words and word pairs, numbers and paths masked): compared, never read back. */
export function promptSig(text: string): string[] {
  const words = text.toLowerCase().replace(/[a-z]:\\[^\s]+|\/[^\s]+/g, ' path ').replace(/\d+/g, '#').split(/[^\p{L}\p{N}#_-]+/u).filter((w) => w.length > 1 && !STOP.has(w));
  if (words.length < 3) return [];
  const grams = new Set([...words, ...words.slice(1).map((w, i) => `${words[i]} ${w}`)]);
  return [...grams].map((g) => createHash('sha1').update(g).digest('hex').slice(0, 8)).sort().slice(0, 64);
}

/** How alike two prompts are (their word hashes, Jaccard). */
export function similarity(a: string[] = [], b: string[] = []): number {
  if (!a.length || !b.length) return 0;
  const B = new Set(b);
  const both = a.filter((x) => B.has(x)).length;
  return both / (a.length + b.length - both);
}

/** The usual time a task was asked, as a cron, when the times agree (within two hours): weekdays only when they all were. */
export function cronFrom(times: number[], tz?: string): string | undefined {
  if (times.length < 2) return undefined;
  const parts = times.map((t) => {
    const p: Record<string, string> = {};
    for (const x of new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(t)) p[x.type] = x.value;
    return { m: (Number(p.hour) % 24) * 60 + Number(p.minute), wd: p.weekday ?? '' };
  });
  const ms = parts.map((p) => p.m).sort((a, b) => a - b);
  if (ms[ms.length - 1]! - ms[0]! > 120) return undefined;
  // A little before the earliest: the result is ready when they would have asked.
  const at = Math.max(0, Math.floor(ms[0]! / 15) * 15);
  const weekdays = parts.every((p) => !['Sat', 'Sun'].includes(p.wd));
  return `${at % 60} ${Math.floor(at / 60)} * * ${weekdays ? '1-5' : '*'}`;
}

interface Turn { start: number; person: boolean; prompt?: string; turn: number; steps: number; calls: Map<string, string> }

export interface NoticerDeps {
  dataDir: string;
  inbox: InboxStore;
  scheduler?: Scheduler;
  /** The kind of a tool (an edit, a command...). */
  kindOf: (name: string) => string | undefined;
  /** Whether the person has this conversation open now. */
  watching: (sessionId: string, owner: string | undefined) => boolean;
  log: (msg: string) => void;
  now?: () => number;
  /** Told when what the owner sees of noticing changed (a finding written down, a detector's state). */
  onChange?: (owner: string | undefined) => void;
}

/** The parts of a session the noticer reads. */
export interface NoticedSession {
  meta: { id: string; owner?: string; title: string; model: string; scheduleId?: string; startedBy?: string; runtime: { kind: string; path?: string; worktree?: { repo: string } } };
  unattendedSchedule?: string;
}

export class Noticer {
  readonly enabled = process.env.HARNESS_NOTICING !== 'off';
  private activityFile: string;
  private findingsFile: string;
  private stateFile: string;
  private activity: Activity[] = [];
  private findings: Finding[] = [];
  private activityWatch: FileWatch;
  private findingsWatch: FileWatch;
  private turns = new Map<string, Turn>();
  private timer?: NodeJS.Timeout;
  private queue: Promise<unknown> = Promise.resolve();
  private now: () => number;
  private deps: NoticerDeps;

  constructor(deps: NoticerDeps) {
    this.deps = deps;
    this.activityFile = path.join(deps.dataDir, 'activity.jsonl');
    this.findingsFile = path.join(deps.dataDir, 'noticed.jsonl');
    this.stateFile = path.join(deps.dataDir, 'noticing.json');
    this.activityWatch = new FileWatch(this.activityFile);
    this.findingsWatch = new FileWatch(this.findingsFile);
    this.now = deps.now ?? Date.now;
  }

  get practiceDays(): number { return env('HARNESS_NOTICE_PRACTICE_DAYS', 7); }
  private get awayMs(): number { return env('HARNESS_NOTICE_AWAY_MINUTES', 5) * 60_000; }
  private get holdoutRate(): number { return env('HARNESS_NOTICE_HOLDOUT', 0.1); }

  async load(): Promise<this> {
    await this.prune();
    return this;
  }

  /** Checks schedules every hour (and prunes the logs), until close. */
  start(): void {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => { void this.checkRoutines().then(() => this.prune()).catch((e: Error) => this.deps.log(`noticing: ${e.message}`)); }, 3600_000);
    this.timer.unref();
  }
  close(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  /** Work in order (events arrive faster than files are written). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch((e: Error) => this.deps.log(`noticing: ${e.message}`));
    return p;
  }
  /** Settles when what was given so far is done (tests). */
  settled(): Promise<unknown> { return this.queue; }

  // ---------- reading and writing ----------

  private async lines<T>(file: string): Promise<T[]> {
    const text = await fs.readFile(file, 'utf8').catch(() => '');
    return text.split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as T]; } catch { return []; } });
  }
  private async sync(): Promise<void> {
    if (await this.activityWatch.changed()) { this.activity = await this.lines<Activity>(this.activityFile); await this.activityWatch.mark(); }
    if (await this.findingsWatch.changed()) { this.findings = await this.lines<Finding>(this.findingsFile); await this.findingsWatch.mark(); }
  }
  private async append(a: Activity): Promise<void> {
    this.activity.push(a);
    await fs.mkdir(path.dirname(this.activityFile), { recursive: true });
    await fs.appendFile(this.activityFile, JSON.stringify(a) + '\n');
    await this.activityWatch.mark();
  }
  private async record(f: Finding): Promise<void> {
    this.findings.push(f);
    await fs.appendFile(this.findingsFile, JSON.stringify(f) + '\n');
    await this.findingsWatch.mark();
    if (f.outcome === 'practice') this.told(f.owner);
  }
  private told(owner: string | undefined): void { try { this.deps.onChange?.(owner); } catch { /* a listener never breaks noticing */ } }
  /** Drops activity older than 14 days and findings older than 30. */
  async prune(): Promise<void> {
    const now = this.now();
    for (const [file, keep, set] of [[this.activityFile, KEEP_DAYS, (x: unknown[]) => { this.activity = x as Activity[]; }], [this.findingsFile, FINDINGS_DAYS, (x: unknown[]) => { this.findings = x as Finding[]; }]] as const) {
      await withFileLock(file, async () => {
        const all = await this.lines<{ at: number }>(file);
        const kept = all.filter((x) => now - x.at < keep * DAY);
        if (kept.length !== all.length) await writeFileAtomic(file, kept.map((x) => JSON.stringify(x) + '\n').join(''));
        set(kept);
      }).catch(() => {});
    }
    await this.activityWatch.mark();
    await this.findingsWatch.mark();
  }

  private async state(): Promise<Record<string, OwnerState>> { return readJson(this.stateFile, {}); }
  private async change(owner: string | undefined, fn: (s: OwnerState) => void): Promise<OwnerState> {
    return withFileLock(this.stateFile, async () => {
      const all = await this.state();
      const mine = all[owner ?? ''] ?? {};
      fn(mine);
      all[owner ?? ''] = mine;
      await writeFileAtomic(this.stateFile, JSON.stringify(all, null, 1));
      return mine;
    });
  }

  async settings(owner: string | undefined): Promise<NoticingSettings> {
    return { mode: 'practice', ...((await this.state())[owner ?? '']?.settings ?? {}) };
  }

  /** The person's choices: the mode, and detectors on or off. Turning a detector on again clears what turned it off. */
  async setSettings(owner: string | undefined, patch: { mode?: unknown; detectors?: unknown }): Promise<NoticingSettings> {
    if (patch.mode !== undefined && !['off', 'practice', 'on'].includes(String(patch.mode))) throw new Error('mode is off, practice or on');
    const det = patch.detectors && typeof patch.detectors === 'object' ? patch.detectors as Record<string, unknown> : {};
    for (const [k, v] of Object.entries(det)) {
      if (!IDS.has(k)) throw new Error(`no detector "${k}" (${[...IDS].join(', ')})`);
      if (typeof v !== 'boolean') throw new Error(`detectors.${k} is true or false`);
    }
    const now = this.now();
    const s = await this.change(owner, (o) => {
      const cur: NoticingSettings = { mode: 'practice', ...(o.settings ?? {}) };
      if (patch.mode !== undefined) {
        cur.mode = patch.mode as NoticeMode;
        if (cur.mode === 'practice') cur.practiceSince = now;
      }
      for (const [k, v] of Object.entries(det)) {
        cur.detectors = { ...(cur.detectors ?? {}), [k]: v as boolean };
        // On again by the person: what turned it off is forgotten, and it is judged afresh from now.
        if (v) o.detectors = { ...(o.detectors ?? {}), [k]: { state: 'on', since: now } };
      }
      o.settings = cur;
    });
    return { mode: 'practice', ...s.settings };
  }

  /** Forgets everything observed of the owner's (the activity log); findings and choices stay. */
  async clear(owner: string | undefined): Promise<number> {
    let n = 0;
    await withFileLock(this.activityFile, async () => {
      const all = await this.lines<Activity>(this.activityFile);
      const kept = all.filter((a) => a.owner !== owner);
      n = all.length - kept.length;
      await writeFileAtomic(this.activityFile, kept.map((x) => JSON.stringify(x) + '\n').join(''));
      this.activity = kept;
    });
    await this.activityWatch.mark();
    return n;
  }

  // ---------- observing ----------

  private projectOf(s: NoticedSession): string | undefined {
    const rt = s.meta.runtime;
    // A worktree's project is its repository's (the same task in two worktrees is one task).
    return rt.kind === 'local' ? rt.worktree?.repo ?? rt.path : undefined;
  }

  /** Every event of every session (the harness's one hook). Scheduled, triggered and plugin work is not the person's: not observed. */
  onEvent(s: NoticedSession, e: HarnessEvent): void {
    if (!this.enabled || s.unattendedSchedule || s.meta.scheduleId || s.meta.startedBy) return;
    // The person's conversation: the main agent's events (it names itself "main"), not sub-agents'.
    if ('agent' in e && e.agent && e.agent !== 'main') return;
    if (e.kind !== 'user_message' && e.kind !== 'tool_call' && e.kind !== 'tool_result' && e.kind !== 'turn_end') return;
    const sid = s.meta.id;
    const now = this.now();
    if (e.kind === 'user_message') {
      const prev = this.turns.get(sid);
      // A finding's own message, sent by the person's click, is not a task they typed.
      const ours = this.expected.get(sid) === e.text;
      if (ours) this.expected.delete(sid);
      const person = !e.origin && !ours;
      this.turns.set(sid, { start: now, person, prompt: person ? e.text : undefined, turn: (prev?.turn ?? 0) + 1, steps: 0, calls: new Map() });
      return;
    }
    const t = this.turns.get(sid) ?? (() => { const x: Turn = { start: now, person: false, turn: 1, steps: 0, calls: new Map() }; this.turns.set(sid, x); return x; })();
    if (e.kind === 'tool_call') {
      t.steps++;
      if (e.name === 'bash' && typeof e.input.command === 'string') t.calls.set(e.id, normCmd(e.input.command));
      else if (this.deps.kindOf(e.name) === 'edit') { const at = now; void this.serial(() => this.observe(s, { at, k: 'edit', turn: t.turn })); }
      return;
    }
    if (e.kind === 'tool_result') {
      const cmd = t.calls.get(e.id);
      if (cmd === undefined) return;
      t.calls.delete(e.id);
      const at = now;
      void this.serial(() => this.observe(s, { at, k: 'cmd', turn: t.turn, cmd: hash(cmd), ok: !e.is_error, ...(e.is_error ? { err: hash(normalizeError(e.content)) } : {}) }, { cmd, error: e.is_error ? normalizeError(e.content) : undefined }));
      return;
    }
    if (e.kind === 'turn_end') {
      const at = now;
      const away = !this.deps.watching(sid, s.meta.owner);
      const sig = t.person && t.prompt ? promptSig(t.prompt) : [];
      const turn: Omit<Activity, 'sid'> = { at, k: 'turn', turn: t.turn, person: t.person, end: e.reason, ms: Math.max(0, at - t.start), ...(sig.length ? { sig } : {}), ...(away ? { away } : {}) };
      const prompt = t.prompt;
      void this.serial(() => this.turnEnded(s, turn, prompt));
    }
  }

  private expected = new Map<string, string>();
  /** The next message to this conversation is a finding's (accepted by the person), not one they typed. */
  expect(sessionId: string, text: string): void { this.expected.set(sessionId, text); }

  private lastCmd = new Map<string, { cmd: string; error?: string }>();
  private async observe(s: NoticedSession, a: Omit<Activity, 'owner' | 'sid' | 'project'>, text?: { cmd: string; error?: string }): Promise<void> {
    const settings = await this.settings(s.meta.owner);
    if (settings.mode === 'off') return;
    await this.sync();
    const project = this.projectOf(s);
    await this.append({ ...a, owner: s.meta.owner, sid: s.meta.id, ...(project ? { project } : {}) } as Activity);
    if (text && a.k === 'cmd' && !a.ok) {
      // Only for the finding's words (the log keeps hashes); the oldest go first on a long-running server.
      this.lastCmd.delete(`${s.meta.id}\0${a.cmd}`);
      this.lastCmd.set(`${s.meta.id}\0${a.cmd}`, text);
      if (this.lastCmd.size > 1000) this.lastCmd.delete(this.lastCmd.keys().next().value!);
    }
  }

  private async turnEnded(s: NoticedSession, a: Omit<Activity, 'sid'>, prompt?: string): Promise<void> {
    const owner = s.meta.owner;
    const settings = await this.settings(owner);
    if (settings.mode === 'off') return;
    await this.sync();
    const project = this.projectOf(s);
    const turn: Activity = { ...a, owner, sid: s.meta.id, ...(project ? { project } : {}) };
    await this.append(turn);
    await this.detectStuck(s, turn);
    await this.detectAway(s, turn);
    if (turn.person && turn.sig && prompt) await this.detectRepeat(s, turn, prompt);
  }

  // ---------- detectors ----------

  /** The same command failing the same way 3 times in 20 minutes, over more than one turn, with no edits in between. */
  private async detectStuck(s: NoticedSession, turn: Activity): Promise<void> {
    const sid = s.meta.id;
    const since = turn.at - STUCK_WINDOW;
    const mine = this.activity.filter((x) => x.sid === sid && x.at >= since);
    // The person is driving it: they typed in it in the last hour.
    if (!this.activity.some((x) => x.sid === sid && x.k === 'turn' && x.person && x.at >= turn.at - 3600_000)) return;
    const groups = new Map<string, Activity[]>();
    for (const x of mine) if (x.k === 'cmd' && !x.ok && x.err) groups.set(`${x.cmd}:${x.err}`, [...(groups.get(`${x.cmd}:${x.err}`) ?? []), x]);
    for (const [key, fails] of groups) {
      if (fails.length < STUCK_TIMES || new Set(fails.map((f) => f.turn)).size < 2) continue;
      const first = fails[0]!.at, last = fails[fails.length - 1]!.at;
      if (mine.some((x) => x.k === 'edit' && x.at > first && x.at < last)) continue;
      // It passed since: not stuck.
      if (mine.some((x) => x.k === 'cmd' && x.ok && x.cmd === fails[0]!.cmd && x.at > last)) continue;
      const text = this.lastCmd.get(`${sid}\0${fails[0]!.cmd}`);
      const cmd = text?.cmd ?? 'A command';
      const mins = Math.max(1, Math.round((last - first) / 60_000));
      await this.consider({
        detector: 'stuck', owner: s.meta.owner, fingerprint: `stuck:${sid}:${key}`, sessionId: sid, project: turn.project, inline: true, level: 'info',
        title: `The same command failed ${fails.length} times`,
        body: `“${cmd.length > 120 ? `${cmd.slice(0, 117)}…` : cmd}” gave the same error each time, ${fails.length} times in ${mins} minute${mins === 1 ? '' : 's'}, with no edits in between.${text?.error ? `\n\nThe error: ${text.error}` : ''}`,
        action: { label: 'Find the cause', prompt: `This command has now failed the same way ${fails.length} times: \`${cmd.slice(0, 300)}\`. Stop retrying it. Find the root cause first, then tell me what it is before changing anything else.` },
      });
    }
  }

  /** A long turn that stopped on an error or a limit while nobody had the conversation open. */
  private async detectAway(s: NoticedSession, turn: Activity): Promise<void> {
    if (!turn.end || !AWAY_ENDS.has(turn.end) || !turn.away || (turn.ms ?? 0) < this.awayMs) return;
    const why: Record<string, string> = { error: 'it hit an error', budget: 'it reached its spend limit', time: 'it ran out of time', max_steps: 'it reached its step limit', refusal: 'the model refused to go on', max_tokens: 'its answer was cut off' };
    const mins = Math.round((turn.ms ?? 0) / 60_000);
    await this.consider({
      detector: 'away_failure', owner: s.meta.owner, fingerprint: `away:${s.meta.id}:${turn.turn}`, sessionId: s.meta.id, project: turn.project, level: 'warn',
      title: `"${s.meta.title}" stopped while you were away`,
      body: `After ${mins >= 1 ? `${mins} minute${mins === 1 ? '' : 's'}` : 'a while'} of work, ${why[turn.end] ?? turn.end}. Open the conversation to see where it got to and carry on.`,
    });
  }

  /** The person asked for the same thing on 3 different days (in 14), and no schedule does it. */
  private async detectRepeat(s: NoticedSession, turn: Activity, prompt: string): Promise<void> {
    const owner = s.meta.owner;
    const tz = (await this.deps.inbox.interruptions(owner)).timeZone;
    const alike = this.activity.filter((x) => x.k === 'turn' && x.person && x.owner === owner && x.project === turn.project && turn.at - x.at < KEEP_DAYS * DAY && similarity(x.sig, turn.sig) >= REPEAT_SIM);
    const days = new Set(alike.map((x) => dayOf(x.at, tz)));
    if (days.size < REPEAT_DAYS) return;
    if (this.deps.scheduler?.list(owner).some((x) => similarity(promptSig(x.prompt), turn.sig) >= REPEAT_SIM)) return;
    // One time a day (the first), for the usual time.
    const firsts = [...days].map((d) => alike.filter((x) => dayOf(x.at, tz) === d).sort((a, b) => a.at - b.at)[0]!.at);
    const cron = cronFrom(firsts, tz);
    const words = prompt.replace(/\s+/g, ' ').trim();
    // A title of whole words.
    const title = words.length > 60 ? `${words.slice(0, 58).replace(/\s+\S*$/, '')}…` : words;
    await this.consider({
      detector: 'repeated_task', owner, fingerprint: `repeat:${turn.project ?? ''}:${turn.sig!.slice(0, 4).join('')}`, sig: turn.sig, sessionId: s.meta.id, project: turn.project, level: 'info',
      title: `You asked for this on ${days.size} days`,
      body: `"${words.slice(0, 300)}"\n\nA schedule could do it for you${cron ? ' at the time you usually ask' : ''} and leave the result in your Inbox. Check it and make it if you want it; nothing is set up until you do.`,
      draft: { title, prompt, ...(cron ? { cron } : {}), ...(tz ? { timeZone: tz } : {}), ...(turn.project ? { folder: turn.project } : {}), model: s.meta.model },
    });
  }

  /** Schedules in trouble (every hour, and when a run ends): failing, skipped, hitting their spend limit, or a watch that cannot check. */
  async checkRoutines(owner?: string): Promise<void> {
    const sch = this.deps.scheduler;
    if (!this.enabled || !sch) return;
    await this.serial(async () => {
      const now = this.now();
      for (const s of sch.list(owner).filter((x) => x.enabled && (owner === undefined || x.owner === owner))) await this.checkRoutine(s, now);
    });
  }
  /** One schedule's health (after its run ended). */
  async checkRoutineOf(id: string): Promise<void> {
    const s = this.deps.scheduler?.get(id);
    if (!this.enabled || !s?.enabled) return;
    await this.serial(() => this.checkRoutine(s, this.now()));
  }
  private async checkRoutine(s: Schedule, now: number): Promise<void> {
    if ((await this.settings(s.owner)).mode === 'off') return;
    const runs = (await this.deps.scheduler!.runs.list({ scheduleId: s.id, limit: 3, all: true })).filter((r) => r.status !== 'running');
    const recent = runs.length === 3 && now - (runs[0]!.endedAt ?? runs[0]!.startedAt) < 7 * DAY;
    const base = { detector: 'routine_health' as const, owner: s.owner, scheduleId: s.id, level: 'warn' as const };
    if (recent && runs.every((r) => r.status === 'failed' || r.status === 'interrupted' || (r.status === 'stopped' && !/spend|budget|cost/i.test(r.reason ?? '')))) {
      return this.consider({ ...base, fingerprint: `health:${s.id}:failing:${runs[2]!.id}`, title: `"${s.title}" keeps failing`, body: `Its last 3 runs failed${runs[0]!.reason ? `; the last: ${runs[0]!.reason.slice(0, 200)}` : ''}. Check its prompt, folder and approvals, or switch it off.` });
    }
    if (recent && runs.every((r) => r.status === 'skipped')) {
      return this.consider({ ...base, fingerprint: `health:${s.id}:skipped:${runs[2]!.id}`, title: `"${s.title}" keeps being skipped`, body: `Its last 3 runs did not run${runs[0]!.reason ? `: ${runs[0]!.reason.slice(0, 200)}` : ''}.` });
    }
    const capped = runs.slice(0, 2);
    if (capped.length === 2 && capped.every((r) => r.status === 'stopped' && /spend|budget|cost/i.test(r.reason ?? ''))) {
      return this.consider({ ...base, fingerprint: `health:${s.id}:capped:${capped[1]!.id}`, title: `"${s.title}" keeps hitting its spend limit`, body: `Its last 2 runs were stopped at their spend limit${s.maxCostUsd ? ` ($${s.maxCostUsd})` : ''} before they finished. Raise the limit or make the task smaller.` });
    }
    const w = s.watchState;
    if (s.watch && w?.error && w.errorSince && now - w.errorSince >= 3 * s.watch.everyMinutes * 60_000) {
      return this.consider({ ...base, fingerprint: `health:${s.id}:check:${w.errorSince}`, title: `"${s.title}" cannot check what it watches`, body: `Its check has failed since ${new Date(w.errorSince).toISOString().slice(0, 16).replace('T', ' ')} UTC: ${w.error.slice(0, 200)}. Until it works, it notices nothing.` });
    }
  }

  // ---------- the gates, and delivery ----------

  private holdout(fp: string): boolean {
    const r = this.holdoutRate;
    return r > 0 && parseInt(hash(`holdout:${fp}`).slice(0, 8), 16) / 0xffffffff < r;
  }

  private async consider(c: Omit<Finding, 'at' | 'outcome'>): Promise<void> {
    const now = this.now();
    const all = await this.state();
    const st = all[c.owner ?? ''] ?? {};
    const settings: NoticingSettings = { mode: 'practice', ...(st.settings ?? {}) };
    const write = async (outcome: Outcome, extra: Partial<Finding> = {}) => { await this.record({ ...c, at: now, outcome, ...extra }); return outcome; };
    if (settings.mode === 'off') return;
    const ds = st.detectors?.[c.detector];
    if (settings.detectors?.[c.detector] === false || ds?.state === 'off') { await write('off'); return; }
    // Muted by the person's dismissals.
    const muted = (st.mutes ?? []).some((m) => m.detector === c.detector && (m.until === undefined || m.until > now)
      && ((m.fingerprint && m.fingerprint === c.fingerprint) || (m.sig && c.sig && similarity(m.sig, c.sig) >= REPEAT_SIM) || (!m.fingerprint && !m.sig && m.project === c.project)));
    if (muted) { await write('muted'); return; }
    // Already said (or would have been), lately; still open in the inbox.
    const same = this.findings.filter((f) => f.owner === c.owner && f.detector === c.detector && (f.fingerprint === c.fingerprint || (c.sig && f.sig && similarity(f.sig, c.sig) >= REPEAT_SIM)));
    // (Repeats are not written down: the same finding at every turn's end would fill the log.)
    if (same.some((f) => (f.outcome === 'shown' || f.outcome === 'practice' || f.outcome === 'holdout') && now - f.at < COOLDOWN)) return;
    if (same.some((f) => f.outcome === 'shown' && f.itemId && ['new', 'read'].includes(this.deps.inbox.get(f.itemId)?.status ?? ''))) return;
    if (settings.mode === 'practice') {
      if (!settings.practiceSince) await this.change(c.owner, (o) => { o.settings = { mode: 'practice', ...(o.settings ?? {}), practiceSince: now }; });
      await write('practice');
      return;
    }
    if (this.holdout(c.fingerprint)) { await write('holdout'); return; }
    const prefs = await this.deps.inbox.interruptions(c.owner);
    const today = dayOf(now, prefs.timeZone);
    const shownToday = this.findings.filter((f) => f.owner === c.owner && f.outcome === 'shown' && dayOf(f.at, prefs.timeZone) === today);
    // Past the day's budget: dropped, not queued (it would come late and out of context).
    if (shownToday.length >= PER_DAY) { await write('budget'); return; }
    const alertsToday = this.deps.inbox.noticed(c.owner).filter((i) => i.alert && dayOf(i.at, prefs.timeZone) === today).length;
    const d = c.inline ? { alert: false, held: 'policy' as const } : this.decide(c, ds?.state === 'digest', prefs, this.deps.inbox.alertsToday(c.owner, prefs.timeZone, now), alertsToday, now);
    const item = await this.deps.inbox.add({
      kind: 'noticed', owner: c.owner, title: c.title, body: c.body, level: c.level, detector: c.detector, fingerprint: c.fingerprint,
      ...(c.sessionId ? { sessionId: c.sessionId } : {}), ...(c.scheduleId ? { scheduleId: c.scheduleId } : {}), ...(c.project ? { project: c.project } : {}),
      ...(c.inline ? { inline: true } : {}), ...(c.draft ? { draft: c.draft } : {}), ...(c.action ? { action: c.action } : {}),
      alert: d.alert, ...(d.held ? { held: d.held } : {}), at: now,
    });
    await write('shown', { itemId: item.id });
    await this.judge(c.owner, c.detector);
  }

  /**
   * Whether a finding interrupts: like a schedule's in the digest (a warning may, the rest waits), within the
   * person's limits, and at most one finding a day; none once its detector was moved to the digest.
   */
  private decide(c: Pick<Finding, 'level'>, quieted: boolean, prefs: Interruptions, alertsToday: number, noticedToday: number, now: number): { alert: boolean; held?: Held } {
    if (quieted) return { alert: false, held: 'digest' };
    const d = decideAlert({ kind: 'noticed', level: c.level }, 'digest', prefs, alertsToday, now);
    if (d.alert && noticedToday >= ALERTS_PER_DAY) return { alert: false, held: 'budget' };
    return d;
  }

  /** The person answered a finding: a dismissal mutes what it was about (never louder). */
  onInbox(type: 'added' | 'changed', item: InboxItem): void {
    if (type !== 'changed' || item.kind !== 'noticed' || item.status !== 'dismissed' || !item.detector || !IDS.has(item.detector)) return;
    const detector = item.detector as DetectorId;
    const now = this.now();
    void this.serial(async () => {
      const f = this.findings.find((x) => x.itemId === item.id);
      const mute: Mute | undefined = item.reason === 'wrong' ? { detector, fingerprint: item.fingerprint, ...(f?.sig ? { sig: f.sig } : {}), why: 'wrong' }
        : item.reason === 'not_useful' ? { detector, ...(item.project ? { project: item.project } : {}), until: now + 30 * DAY, why: 'not useful' }
          : item.reason === 'bad_timing' ? { detector, fingerprint: item.fingerprint, until: now + DAY, why: 'bad timing' }
            : { detector, fingerprint: item.fingerprint, ...(f?.sig ? { sig: f.sig } : {}), until: now + 30 * DAY, why: item.reason ?? 'dismissed' };
      await this.change(item.owner, (o) => { o.mutes = [...(o.mutes ?? []).filter((m) => m.until === undefined || m.until > now), mute].slice(-500); });
      await this.judge(item.owner, detector);
    });
  }

  /** A detector's measures over 14 days, from what it showed and what the person did with it. */
  private async stats(owner: string | undefined, detector: DetectorId, since = 0): Promise<DetectorStats & { shownToday: number }> {
    const now = this.now();
    const from = Math.max(since, now - KEEP_DAYS * DAY);
    const items = this.deps.inbox.noticed(owner, detector).filter((i) => i.at >= from);
    const fb = (await this.deps.inbox.feedbackLog()).filter((x) => x.detector === detector && x.owner === owner);
    const opened = new Set(fb.filter((x) => x.action === 'open' || x.action === 'done').map((x) => x.itemId));
    const tz = (await this.deps.inbox.interruptions(owner)).timeZone;
    const mine = this.findings.filter((f) => f.owner === owner && f.detector === detector && f.at >= from);
    const holdouts = mine.filter((f) => f.outcome === 'holdout');
    return {
      shown: items.length,
      acted: items.filter((i) => opened.has(i.id) || i.status === 'done').length,
      notUseful: items.filter((i) => i.status === 'dismissed' && (i.reason === 'not_useful' || i.reason === 'wrong')).length,
      badTiming: items.filter((i) => i.status === 'dismissed' && i.reason === 'bad_timing').length,
      ignored: items.filter((i) => i.status === 'new' && now - i.at > 72 * 3600_000).length,
      holdout: holdouts.length,
      selfFound: holdouts.filter((f) => this.foundAnyway(f)).length,
      practice: mine.filter((f) => f.outcome === 'practice').length,
      shownToday: items.filter((i) => dayOf(i.at, tz) === dayOf(now, tz)).length,
    };
  }

  /** A finding held back to measure: did the person get to it anyway (within a day; a week for a schedule)? */
  private foundAnyway(f: Finding): boolean {
    if (f.detector === 'stuck') { const cmd = f.fingerprint.split(':')[2]; return this.activity.some((a) => a.sid === f.sessionId && a.k === 'cmd' && a.ok && a.cmd === cmd && a.at > f.at && a.at - f.at < DAY); }
    if (f.detector === 'away_failure') return this.activity.some((a) => a.sid === f.sessionId && a.k === 'turn' && a.person && a.at > f.at && a.at - f.at < DAY);
    if (f.detector === 'repeated_task') return !!this.deps.scheduler?.list(f.owner).some((s) => s.createdAt > f.at && s.createdAt - f.at < 7 * DAY && similarity(promptSig(s.prompt), f.sig) >= REPEAT_SIM);
    return false;
  }

  /**
   * Turns a detector quieter by itself when its findings are unwanted (14 days, at least 5 shown): 30% dismissed
   * as not useful or wrong (an unread one after 3 days counts half) moves it to the digest; 50% there, or under 15%
   * acted on after 10, turns it off; more than 5 in a day is a fault and turns it off. Only the person turns it on.
   */
  private async judge(owner: string | undefined, detector: DetectorId): Promise<void> {
    const all = await this.state();
    const ds: DetectorState = all[owner ?? '']?.detectors?.[detector] ?? { state: 'on' };
    if (ds.state === 'off') return;
    const st = await this.stats(owner, detector, ds.since);
    let next: DetectorState | undefined;
    const title = DETECTORS.find((d) => d.id === detector)!.title;
    if (st.shownToday > 5) next = { state: 'off', why: `it found more than 5 things in a day, which is a fault` };
    else if (st.shown >= 5) {
      const unwanted = (st.notUseful + st.ignored * 0.5) / st.shown;
      if (st.shown >= 10 && st.acted / st.shown < 0.15) next = { state: 'off', why: `you acted on ${st.acted} of its last ${st.shown} findings` };
      else if (ds.state === 'digest' && unwanted >= 0.5) next = { state: 'off', why: `even in the digest, ${Math.round(unwanted * 100)}% of its findings were not wanted` };
      else if (ds.state === 'on' && unwanted >= 0.3) next = { state: 'digest', why: `${Math.round(unwanted * 100)}% of its findings were not wanted` };
    }
    if (!next) return;
    const now = this.now();
    await this.change(owner, (o) => { o.detectors = { ...(o.detectors ?? {}), [detector]: { ...next!, at: now, since: ds.since } }; });
    this.told(owner);
    if (next.state === 'off') {
      await this.deps.inbox.add({ kind: 'noticed', owner, detector, level: 'info', alert: false, held: 'policy', title: `Turned off: ${title}`, body: `It turned itself off because ${next.why}. Turn it on again in Noticing (the eye in the Inbox) if you want it back.` });
    }
  }

  // ---------- what the person sees of it ----------

  async overview(owner: string | undefined): Promise<NoticingOverview> {
    await this.sync();
    const all = await this.state();
    const st = all[owner ?? ''] ?? {};
    const settings: NoticingSettings = { mode: 'practice', ...(st.settings ?? {}) };
    const now = this.now();
    const prefs = await this.deps.inbox.interruptions(owner);
    const today = dayOf(now, prefs.timeZone);
    const mine = this.activity.filter((a) => a.owner === owner);
    const detectors = [];
    for (const d of DETECTORS) {
      const ds = st.detectors?.[d.id] ?? { state: 'on' as const };
      const { shownToday: _, ...stats } = await this.stats(owner, d.id);
      detectors.push({ ...d, enabled: settings.detectors?.[d.id] !== false, state: ds.state, ...(ds.why ? { why: ds.why } : {}), stats });
    }
    return {
      enabled: this.enabled,
      mode: settings.mode,
      ...(settings.practiceSince ? { practiceSince: settings.practiceSince } : {}),
      practiceDays: this.practiceDays,
      ready: settings.mode === 'practice' && !!settings.practiceSince && now - settings.practiceSince >= this.practiceDays * DAY,
      detectors,
      practice: this.findings.filter((f) => f.owner === owner && f.outcome === 'practice').slice(-50).reverse()
        .map((f) => ({ at: f.at, detector: f.detector, title: f.title, body: f.body, level: f.level, ...(f.sessionId ? { sessionId: f.sessionId } : {}), ...(f.scheduleId ? { scheduleId: f.scheduleId } : {}), ...(f.draft ? { draft: f.draft } : {}) })),
      observed: {
        commands: mine.filter((a) => a.k === 'cmd').length, failed: mine.filter((a) => a.k === 'cmd' && !a.ok).length,
        edits: mine.filter((a) => a.k === 'edit').length, turns: mine.filter((a) => a.k === 'turn').length, typed: mine.filter((a) => a.k === 'turn' && a.person).length,
        projects: new Set(mine.map((a) => a.project).filter(Boolean)).size, ...(mine.length ? { since: mine[0]!.at } : {}),
        days: new Set(mine.map((a) => dayOf(a.at, prefs.timeZone))).size,
      },
      today: {
        shown: this.findings.filter((f) => f.owner === owner && f.outcome === 'shown' && dayOf(f.at, prefs.timeZone) === today).length,
        alerts: this.deps.inbox.noticed(owner).filter((i) => i.alert && dayOf(i.at, prefs.timeZone) === today).length,
      },
      limits: { perDay: PER_DAY, alertsPerDay: ALERTS_PER_DAY, keepDays: KEEP_DAYS },
    };
  }
}
