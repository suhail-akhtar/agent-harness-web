import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { type InboxItem, InboxStore } from '../src/core/inbox.ts';
import { cronFrom, Noticer, type NoticedSession, promptSig, similarity } from '../src/core/noticing.ts';
import type { Scheduler } from '../src/core/scheduler.ts';
import type { HarnessEvent } from '../src/core/types.ts';
import { tempDir } from './helpers.ts';

// Agents that notice things themselves (docs/proactive/NOTICING.md): the harness counts fingerprints of the
// person's work, four fixed detectors read them, and a finding passes cheap gates before it is shown (or,
// in practice, only written down). Dismissals only make it quieter; a detector whose findings are unwanted
// moves to the digest, then turns itself off. These drive the noticer with a session's events on a clock.

const at = (iso: string) => Date.parse(iso);
const MIN = 60_000, HOUR = 3600_000, DAY = 86_400_000;

interface Rig { n: Noticer; inbox: InboxStore; dir: string; clock: { t: number }; watching: Set<string>; schedules: Array<Record<string, unknown>>; runs: Array<Record<string, unknown>> }

async function rig(o: { mode?: 'practice' | 'on' | 'off'; holdout?: number } = {}): Promise<Rig> {
  process.env.HARNESS_NOTICE_HOLDOUT = String(o.holdout ?? 0);
  const dir = await tempDir();
  const inbox = await new InboxStore(dir).load();
  const clock = { t: at('2026-11-02T09:00:00Z') };
  const watching = new Set<string>();
  const schedules: Rig['schedules'] = [];
  const runs: Rig['runs'] = [];
  const scheduler = {
    list: (owner?: string) => schedules.filter((s) => owner === undefined || s.owner === owner),
    get: (id: string) => schedules.find((s) => s.id === id),
    runs: { list: async (q: { scheduleId?: string; limit?: number }) => runs.filter((r) => r.scheduleId === q.scheduleId).sort((a, b) => (b.startedAt as number) - (a.startedAt as number)).slice(0, q.limit ?? 50) },
  } as unknown as Scheduler;
  const n = await new Noticer({
    dataDir: dir, inbox, scheduler, log: () => {}, now: () => clock.t,
    kindOf: (name) => (name === 'edit' || name === 'write' ? 'edit' : name === 'bash' ? 'exec' : 'read'),
    watching: (sid) => watching.has(sid),
  }).load();
  inbox.onChange = (type, item) => n.onInbox(type, item);
  await inbox.setInterruptions('al', { timeZone: 'UTC' });
  if (o.mode && o.mode !== 'practice') await n.setSettings('al', { mode: o.mode });
  return { n, inbox, dir, clock, watching, schedules, runs };
}

const session = (id: string, o: Partial<NoticedSession['meta']> & { unattended?: string } = {}): NoticedSession => ({
  meta: { id, owner: 'al', title: o.title ?? `Conversation ${id}`, model: 'deepseek-flash', runtime: { kind: 'local', path: o.runtime?.path ?? 'E:/work/app' }, ...(o.scheduleId ? { scheduleId: o.scheduleId } : {}) },
  ...(o.unattended ? { unattendedSchedule: o.unattended } : {}),
});

let callId = 0;
/** One turn: the person's message (or not), then commands (failing with `err`, or passing) and edits, then its end. */
async function turn(r: Rig, s: NoticedSession, o: { text?: string; origin?: 'auto' | 'link'; cmds?: Array<{ cmd: string; err?: string }>; edit?: boolean; end?: 'done' | 'error' | 'budget' | 'aborted'; minutes?: number }) {
  const ev = (e: HarnessEvent) => r.n.onEvent(s, e);
  ev({ kind: 'user_message', text: o.text ?? 'run the tests', ...(o.origin ? { origin: o.origin } : {}) });
  for (const c of o.cmds ?? []) {
    const id = `c${++callId}`;
    r.clock.t += 1000;
    ev({ kind: 'tool_call', id, name: 'bash', input: { command: c.cmd } });
    // As the bash tool says it (src/tools/exec.ts): its exit code and stderr lines are not the error.
    ev({ kind: 'tool_result', id, name: 'bash', content: c.err ? ['exit code: 1', 'stderr:', c.err].join(String.fromCharCode(10)) : 'exit code: 0', is_error: !!c.err, ms: 5 });
  }
  if (o.edit) { r.clock.t += 1000; ev({ kind: 'tool_call', id: `c${++callId}`, name: 'edit', input: { path: 'src/a.ts' } }); }
  r.clock.t += (o.minutes ?? 1) * MIN;
  ev({ kind: 'turn_end', reason: o.end ?? 'done' });
  await r.n.settled();
}
const FAIL = 'Error: Cannot find module "./config" (code 7)\n    at load (src/index.ts:12)';
const noticed = (r: Rig) => r.inbox.list('al', { view: 'all' }).filter((i) => i.kind === 'noticed');
const lines = async (file: string) => (await fs.readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('prompt fingerprints: alike asks match, different ones and acknowledgements do not; the usual time as a cron', () => {
  const a = promptSig('Check the CI status for the main branch and summarise the failing tests');
  assert.ok(a.length > 5);
  assert.ok(a.every((x) => /^[0-9a-f]{8}$/.test(x)), 'hashes, not words');
  assert.equal(similarity(a, promptSig('check the CI status for the main branch and summarise the failing tests')), 1);
  assert.ok(similarity(a, promptSig('Check CI status on the main branch and summarise failing tests please')) >= 0.6, 'a rewording');
  assert.ok(similarity(a, promptSig('Write a haiku about autumn leaves falling softly')) < 0.1);
  assert.deepEqual(promptSig('yes do it'), [], 'too short to be a task');
  assert.equal(similarity(promptSig('Summarise build log 1234 at E:\\logs\\a.txt'), promptSig('Summarise build log 9876 at E:\\logs\\b.txt')), 1, 'numbers and paths masked');
  assert.equal(cronFrom([at('2026-11-02T08:55:00Z'), at('2026-11-03T09:20:00Z'), at('2026-11-04T09:05:00Z')], 'UTC'), '45 8 * * 1-5', 'weekdays, a little before the earliest');
  assert.equal(cronFrom([at('2026-11-07T08:55:00Z'), at('2026-11-08T09:20:00Z')], 'UTC'), '45 8 * * *', 'a weekend: every day');
  assert.equal(cronFrom([at('2026-11-02T08:00:00Z'), at('2026-11-03T15:00:00Z')], 'UTC'), undefined, 'no usual time');
  assert.equal(cronFrom([at('2026-11-02T07:55:00Z'), at('2026-11-03T08:10:00Z')], 'Europe/Berlin'), '45 8 * * 1-5', 'on the person\'s clock');
});

test('practice by default: a finding is written down, not shown; what is kept is fingerprints, never the commands or prompts', async () => {
  const r = await rig();
  const s = session('s1');
  await turn(r, s, { text: 'please run the payment service tests for me', cmds: [{ cmd: 'npm test -- payments', err: FAIL }, { cmd: 'npm test -- payments', err: FAIL }] });
  await turn(r, s, { text: 'try that again', cmds: [{ cmd: 'npm test -- payments', err: FAIL }] });
  assert.equal(noticed(r).length, 0, 'nothing shown in practice');
  const o = await r.n.overview('al');
  assert.equal(o.mode, 'practice');
  assert.equal(o.ready, false, 'a week of practice first');
  assert.equal(o.practice.length, 1);
  assert.equal(o.practice[0]!.detector, 'stuck');
  assert.match(o.practice[0]!.body, /npm test -- payments.*3 times/);
  assert.deepEqual([o.observed.commands, o.observed.failed, o.observed.turns, o.observed.typed, o.observed.projects], [3, 3, 2, 2, 1]);
  const log = await fs.readFile(path.join(r.dir, 'activity.jsonl'), 'utf8');
  assert.ok(!/npm|payment|config|tests for me/i.test(log), 'no command, error or prompt text in the activity log');
  r.clock.t += 7 * DAY;
  assert.equal((await r.n.overview('al')).ready, true, 'after 7 days: time to review');
});

test('stuck: 3 identical failures over 2 turns in 20 minutes, shown in its conversation with an offer; not for edits between, one turn, different errors, a pass, or work nobody typed', async () => {
  const r = await rig({ mode: 'on' });
  const s = session('s1');
  await turn(r, s, { cmds: [{ cmd: 'npm test 2>&1 | tail -20', err: FAIL }, { cmd: 'npm test', err: FAIL }] });
  assert.equal(noticed(r).length, 0, 'one turn: the agent\'s own retry loop, which the turn already watches');
  await turn(r, s, { text: 'again', cmds: [{ cmd: 'npm test', err: FAIL.replace('7', '9') }] });
  const [it] = noticed(r);
  assert.ok(it, 'the same command (output trimming aside) and the same error (numbers aside), 3 times');
  assert.equal(it.detector, 'stuck');
  assert.equal(it.inline, true);
  assert.equal(it.sessionId, 's1');
  assert.equal(it.alert, false, 'it never pops up');
  assert.equal(it.action?.label, 'Find the cause');
  assert.match(it.action!.prompt, /Stop retrying it\. Find the root cause first/);
  assert.ok(!it.action!.prompt.includes('Cannot find module'), 'the message it sends holds no tool output');
  await turn(r, s, { text: 'again', cmds: [{ cmd: 'npm test', err: FAIL }] });
  assert.equal(noticed(r).length, 1, 'said once');

  // Edits between the failures: the person (or agent) is working on it.
  const e = session('s2');
  await turn(r, e, { cmds: [{ cmd: 'npm test', err: FAIL }] });
  await turn(r, e, { text: 'fix it', edit: true, cmds: [{ cmd: 'npm test', err: FAIL }] });
  await turn(r, e, { text: 'again', cmds: [{ cmd: 'npm test', err: FAIL }] });
  assert.equal(noticed(r).filter((i) => i.sessionId === 's2').length, 0, 'edits between');
  // Different errors: progress.
  const d = session('s3');
  await turn(r, d, { cmds: [{ cmd: 'npm test', err: 'Error: one' }, { cmd: 'npm test', err: 'Error: two' }] });
  await turn(r, d, { text: 'again', cmds: [{ cmd: 'npm test', err: 'Error: three' }] });
  assert.equal(noticed(r).filter((i) => i.sessionId === 's3').length, 0, 'different errors');
  // Too slow: over 20 minutes.
  const w = session('s4');
  await turn(r, w, { cmds: [{ cmd: 'npm test', err: FAIL }, { cmd: 'npm test', err: FAIL }] });
  r.clock.t += 25 * MIN;
  await turn(r, w, { text: 'again', cmds: [{ cmd: 'npm test', err: FAIL }] });
  assert.equal(noticed(r).filter((i) => i.sessionId === 's4').length, 0, 'outside 20 minutes');
  // Nobody typed in it: a linked session's own work.
  const l = session('s5');
  await turn(r, l, { origin: 'link', cmds: [{ cmd: 'npm test', err: FAIL }, { cmd: 'npm test', err: FAIL }] });
  await turn(r, l, { origin: 'auto', cmds: [{ cmd: 'npm test', err: FAIL }] });
  assert.equal(noticed(r).filter((i) => i.sessionId === 's5').length, 0, 'not driven by the person');
  // A scheduled run: its own reporting covers it, and it is not observed at all.
  const u = session('s6', { unattended: 'sch_1' });
  await turn(r, u, { cmds: [{ cmd: 'npm test', err: FAIL }, { cmd: 'npm test', err: FAIL }] });
  await turn(r, u, { text: 'again', cmds: [{ cmd: 'npm test', err: FAIL }] });
  assert.equal(noticed(r).filter((i) => i.sessionId === 's6').length, 0);
  assert.ok(!(await lines(path.join(r.dir, 'activity.jsonl'))).some((a) => a.sid === 's6'), 'scheduled work is not observed');
});

test('away: a long turn that stopped on an error or a limit while the conversation was not open; at most one interruption a day', async () => {
  const r = await rig({ mode: 'on' });
  await turn(r, session('a1', { title: 'Migrate the database' }), { text: 'migrate the orders table to the new schema', end: 'error', minutes: 12 });
  const [first] = noticed(r);
  assert.ok(first);
  assert.equal(first.detector, 'away_failure');
  assert.equal(first.level, 'warn');
  assert.match(first.title, /"Migrate the database" stopped while you were away/);
  assert.match(first.body, /After 12 minutes of work, it hit an error/);
  assert.equal(first.alert, true, 'a warning may interrupt (the digest policy)');
  await turn(r, session('a2'), { text: 'refactor the billing module into smaller files', end: 'budget', minutes: 30 });
  const second = noticed(r).find((i) => i.sessionId === 'a2')!;
  assert.match(second.body, /it reached its spend limit/);
  assert.deepEqual([second.alert, second.held], [false, 'budget'], 'one interruption a day from noticing');
  // Not: the person had it open, it was short, they stopped it, it finished.
  r.watching.add('a3');
  await turn(r, session('a3'), { end: 'error', minutes: 20 });
  await turn(r, session('a4'), { end: 'error', minutes: 2 });
  await turn(r, session('a5'), { end: 'aborted', minutes: 20 });
  await turn(r, session('a6'), { end: 'done', minutes: 40 });
  assert.equal(noticed(r).length, 2);
});

test('a repeated task: the same ask on 3 days (14 at most) offers a schedule in the person\'s own words at their usual time; not on 2 days, in another project, or when a schedule already does it', async () => {
  const r = await rig({ mode: 'on' });
  const ask = (day: string, time: string, text: string, sid: string, p?: string) => { r.clock.t = at(`2026-11-${day}T${time}:00Z`); return turn(r, session(sid, p ? { runtime: { kind: 'local', path: p } } : {}), { text }); };
  await ask('02', '08:52', 'Check the CI status for the main branch and summarise the failing tests', 'r1');
  await ask('02', '15:00', 'check the CI status for the main branch and summarise the failing tests', 'r2');
  await ask('03', '09:10', 'Check CI status on the main branch and summarise failing tests please', 'r3');
  assert.equal(noticed(r).length, 0, 'two days only');
  await ask('03', '09:30', 'Check the CI status for the main branch and summarise the failing tests', 'x1', 'E:/work/other');
  await ask('04', '09:30', 'Check the CI status for the main branch and summarise the failing tests', 'x2', 'E:/work/other');
  assert.equal(noticed(r).length, 0, 'another project counts on its own');
  await ask('05', '09:05', 'Check the CI status for the main branch and summarise failing tests', 'r4');
  const [it] = noticed(r);
  assert.ok(it);
  assert.equal(it.detector, 'repeated_task');
  assert.match(it.title, /You asked for this on 3 days/);
  assert.equal(it.alert, false, 'info: it waits for the digest');
  assert.equal(it.held, 'digest');
  assert.deepEqual(it.draft, { title: 'Check the CI status for the main branch and summarise…', prompt: 'Check the CI status for the main branch and summarise failing tests', cron: '45 8 * * 1-5', timeZone: 'UTC', folder: 'E:/work/app', model: 'deepseek-flash' });

  // A schedule that already does it: nothing to offer.
  const q = await rig({ mode: 'on' });
  q.schedules.push({ id: 'sch_1', owner: 'al', enabled: true, prompt: 'Summarise the overnight error logs of the payment service', createdAt: 0 });
  for (const [d, sid] of [['02', 'q1'], ['03', 'q2'], ['04', 'q3']] as const) { q.clock.t = at(`2026-11-${d}T10:00:00Z`); await turn(q, session(sid), { text: 'summarise the overnight error logs of the payment service' }); }
  assert.equal(noticed(q).length, 0, 'a schedule does it already');
  // Over 14 days apart: not a habit.
  const o = await rig({ mode: 'on' });
  for (const [d, sid] of [['2026-10-01', 'o1'], ['2026-10-10', 'o2'], ['2026-10-20', 'o3']] as const) { o.clock.t = at(`${d}T10:00:00Z`); await turn(o, session(sid), { text: 'draft the weekly status update for the platform team' }); }
  assert.equal(noticed(o).length, 0, 'the first is older than 14 days');
});

test('the gates: a finding cools down for 72 hours; past 3 a day it is dropped, not queued; one held back to measure counts whether the person got there anyway', async () => {
  const r = await rig({ mode: 'on' });
  for (let i = 1; i <= 5; i++) await turn(r, session(`b${i}`), { end: 'error', minutes: 10 });
  assert.equal(noticed(r).length, 3, '3 a day');
  const dropped = (await lines(path.join(r.dir, 'noticed.jsonl'))).filter((f) => f.outcome === 'budget');
  assert.equal(dropped.length, 2, 'written down as dropped');
  r.clock.t += DAY;
  await turn(r, session('b9'), { end: 'error', minutes: 10 });
  assert.equal(noticed(r).length, 4, 'tomorrow is a new day; nothing dropped comes back');
  assert.ok(!noticed(r).some((i) => i.sessionId === 'b4' || i.sessionId === 'b5'));

  const h = await rig({ mode: 'on', holdout: 1 });
  const s = session('h1');
  await turn(h, s, { cmds: [{ cmd: 'npm test', err: FAIL }, { cmd: 'npm test', err: FAIL }] });
  await turn(h, s, { text: 'again', cmds: [{ cmd: 'npm test', err: FAIL }] });
  assert.equal(noticed(h).length, 0, 'held back');
  await turn(h, s, { text: 'I fixed the config', edit: true, cmds: [{ cmd: 'npm test' }] });
  const st = (await h.n.overview('al')).detectors.find((d) => d.id === 'stuck')!.stats;
  assert.deepEqual([st.holdout, st.selfFound], [1, 1], 'the person fixed it without being told');
});

test('dismissals only make it quieter: wrong mutes that finding for good, not useful mutes the detector in that project for 30 days, bad timing a day', async () => {
  const r = await rig({ mode: 'on' });
  const stuck = async (sid: string) => { const s = session(sid); await turn(r, s, { cmds: [{ cmd: 'make', err: FAIL }, { cmd: 'make', err: FAIL }] }); await turn(r, s, { text: 'again', cmds: [{ cmd: 'make', err: FAIL }] }); };
  await stuck('m1');
  const [one] = noticed(r);
  await r.inbox.act(one!.id, 'dismiss', { reason: 'bad_timing', now: r.clock.t });
  await r.n.settled();
  r.clock.t += 4 * DAY;
  await turn(r, session('m1'), { text: 'again', cmds: [{ cmd: 'make', err: FAIL }, { cmd: 'make', err: FAIL }] });
  await turn(r, session('m1'), { text: 'again', cmds: [{ cmd: 'make', err: FAIL }] });
  const again = noticed(r).filter((i) => i.status === 'new');
  assert.equal(again.length, 1, 'bad timing: back after a day (and its cooldown)');
  await r.inbox.act(again[0]!.id, 'dismiss', { reason: 'wrong', now: r.clock.t });
  await r.n.settled();
  r.clock.t += 40 * DAY;
  await turn(r, session('m1'), { text: 'again', cmds: [{ cmd: 'make', err: FAIL }, { cmd: 'make', err: FAIL }] });
  await turn(r, session('m1'), { text: 'again', cmds: [{ cmd: 'make', err: FAIL }] });
  assert.equal(noticed(r).filter((i) => i.status === 'new').length, 0, 'wrong: never again');
  await stuck('m2');
  const other = noticed(r).find((i) => i.sessionId === 'm2')!;
  assert.ok(other, 'another conversation\'s failure is another finding');
  await r.inbox.act(other.id, 'dismiss', { reason: 'not_useful', now: r.clock.t });
  await r.n.settled();
  r.clock.t += 4 * DAY;
  await stuck('m3');
  assert.equal(noticed(r).filter((i) => i.sessionId === 'm3').length, 0, 'not useful: the detector is muted in this project');
  await turn(r, session('m4', { runtime: { kind: 'local', path: 'E:/work/other' } }), { cmds: [{ cmd: 'make', err: FAIL }, { cmd: 'make', err: FAIL }] });
  await turn(r, session('m4', { runtime: { kind: 'local', path: 'E:/work/other' } }), { text: 'again', cmds: [{ cmd: 'make', err: FAIL }] });
  assert.equal(noticed(r).filter((i) => i.sessionId === 'm4').length, 1, 'not in another project');
});

test('a detector whose findings are unwanted goes to the digest by itself, then off (saying so); only the person turns it on again', async () => {
  const r = await rig({ mode: 'on' });
  const away = async (sid: string) => { await turn(r, session(sid), { end: 'error', minutes: 10 }); return noticed(r).find((i) => i.sessionId === sid)!; };
  const items = [];
  // Each read when it came (one left unread for 3 days would count as half a no).
  for (let d = 0; d < 5; d++) { const i = await away(`k${d}`); await r.inbox.act(i.id, 'read', { now: r.clock.t }); items.push(i); r.clock.t += DAY; }
  // "Wrong" mutes only that finding ("not useful" would mute the detector in this project at once).
  await r.inbox.act(items[0]!.id, 'dismiss', { reason: 'wrong', now: r.clock.t });
  await r.inbox.act(items[1]!.id, 'open', { now: r.clock.t });
  await r.n.settled();
  let det = (await r.n.overview('al')).detectors.find((x) => x.id === 'away_failure')!;
  assert.equal(det.state, 'on', '1 of 5 unwanted');
  await r.inbox.act(items[2]!.id, 'dismiss', { reason: 'wrong', now: r.clock.t });
  await r.n.settled();
  det = (await r.n.overview('al')).detectors.find((x) => x.id === 'away_failure')!;
  assert.equal(det.state, 'digest', '2 of 5 (40%) unwanted: to the digest');
  assert.match(det.why!, /40% of its findings were not wanted/);
  const quiet = await away('k9');
  assert.deepEqual([quiet.alert, quiet.held], [false, 'digest'], 'in the digest even a warning waits');
  for (const i of [items[3]!, items[4]!]) await r.inbox.act(i.id, 'dismiss', { reason: 'wrong', now: r.clock.t });
  await r.n.settled();
  det = (await r.n.overview('al')).detectors.find((x) => x.id === 'away_failure')!;
  assert.equal(det.state, 'off');
  const note = noticed(r).find((i) => i.title === 'Turned off: Failed while you were away');
  assert.ok(note, 'it says so');
  assert.match(note.body, /turned itself off because even in the digest/);
  r.clock.t += DAY;
  await turn(r, session('k10'), { end: 'error', minutes: 10 });
  assert.equal(noticed(r).filter((i) => i.sessionId === 'k10').length, 0, 'off');
  await r.n.setSettings('al', { detectors: { away_failure: true } });
  det = (await r.n.overview('al')).detectors.find((x) => x.id === 'away_failure')!;
  assert.deepEqual([det.state, det.enabled], ['on', true]);
  await turn(r, session('k11'), { end: 'error', minutes: 10 });
  assert.equal(noticed(r).filter((i) => i.sessionId === 'k11').length, 1, 'on again, judged afresh');
  await r.n.setSettings('al', { detectors: { away_failure: false } });
  await turn(r, session('k12'), { end: 'error', minutes: 10 });
  assert.equal(noticed(r).filter((i) => i.sessionId === 'k12').length, 0, 'the person switched it off');
  await assert.rejects(() => r.n.setSettings('al', { detectors: { mind_reading: true } }), /no detector "mind_reading"/);
  await assert.rejects(() => r.n.setSettings('al', { mode: 'loud' }), /mode is off, practice or on/);
});

test('schedules in trouble: failing, skipped or capped 3 (2) times running, a watch that cannot check; not a healthy one', async () => {
  const r = await rig({ mode: 'on' });
  const t0 = r.clock.t;
  const run = (scheduleId: string, i: number, status: string, reason?: string) => r.runs.push({ id: `${scheduleId}_r${i}`, scheduleId, startedAt: t0 - (10 - i) * HOUR, endedAt: t0 - (10 - i) * HOUR + MIN, status, ...(reason ? { reason } : {}) });
  r.schedules.push({ id: 'fail', owner: 'al', title: 'Nightly report', enabled: true, prompt: 'x' }, { id: 'skip', owner: 'al', title: 'Morning brief', enabled: true, prompt: 'y' }, { id: 'cap', owner: 'al', title: 'Big review', enabled: true, prompt: 'z', maxCostUsd: 0.5 }, { id: 'ok', owner: 'al', title: 'Fine one', enabled: true, prompt: 'w' }, { id: 'mixed', owner: 'al', title: 'Mixed', enabled: true, prompt: 'v' });
  r.schedules.push({ id: 'watch', owner: 'al', title: 'Watch the API', enabled: true, prompt: 'u', watch: { kind: 'url', everyMinutes: 5 }, watchState: { error: 'ECONNREFUSED 127.0.0.1:9', errorSince: t0 - 20 * MIN, checkedAt: t0 } });
  r.schedules.push({ id: 'blip', owner: 'al', title: 'Brief blip', enabled: true, prompt: 't', watch: { kind: 'url', everyMinutes: 5 }, watchState: { error: 'timeout', errorSince: t0 - 6 * MIN, checkedAt: t0 } });
  r.schedules.push({ id: 'paused', owner: 'al', title: 'Paused', enabled: false, prompt: 's' });
  for (let i = 0; i < 3; i++) { run('fail', i, 'failed', 'the model is not available'); run('skip', i, 'skipped', 'over the daily spend limit'); run('ok', i, 'completed'); run('paused', i, 'failed'); }
  run('cap', 0, 'completed'); run('cap', 1, 'stopped', 'it reached its spend limit'); run('cap', 2, 'stopped', 'it reached its spend limit');
  run('mixed', 0, 'failed'); run('mixed', 1, 'completed'); run('mixed', 2, 'failed');
  await r.n.checkRoutines();
  assert.deepEqual(noticed(r).map((i) => i.scheduleId).sort(), ['cap', 'fail', 'skip'], '3 a day: the 4th waits for a check the next day');
  r.clock.t += DAY;
  // The blip recovered (a watch still failing a day later would be in trouble).
  r.schedules.find((x) => x.id === 'blip')!.watchState = { checkedAt: r.clock.t };
  await r.n.checkRoutines();
  const got = Object.fromEntries(noticed(r).map((i) => [i.scheduleId, i]));
  assert.deepEqual(Object.keys(got).sort(), ['cap', 'fail', 'skip', 'watch'], 'not the healthy, the mixed, the brief blip or the paused one');
  assert.match(got.fail!.title, /"Nightly report" keeps failing/);
  assert.match(got.fail!.body, /the model is not available/);
  assert.match(got.skip!.body, /over the daily spend limit/);
  assert.match(got.cap!.body, /spend limit \(\$0\.5\)/);
  assert.match(got.watch!.body, /ECONNREFUSED/);
  assert.ok((Object.values(got) as InboxItem[]).every((i) => i.detector === 'routine_health' && i.level === 'warn'));
  await r.n.checkRoutines();
  assert.equal(noticed(r).length, 4, 'each said once');
});

test('whose work: the main agent\'s commands count (it names itself "main"), a sub-agent\'s do not', async () => {
  const r = await rig();
  const s = session('w1');
  r.n.onEvent(s, { kind: 'user_message', text: 'build it and check the output' });
  for (const [id, agent] of [['m1', 'main'], ['x1', 'explore'], ['m2', undefined]] as const) {
    r.n.onEvent(s, { kind: 'tool_call', id, name: 'bash', input: { command: 'make' }, ...(agent ? { agent } : {}) });
    r.n.onEvent(s, { kind: 'tool_result', id, name: 'bash', content: 'ok', is_error: false, ms: 1, ...(agent ? { agent } : {}) });
  }
  r.n.onEvent(s, { kind: 'turn_end', reason: 'done', agent: 'explore' });
  r.n.onEvent(s, { kind: 'turn_end', reason: 'done' });
  await r.n.settled();
  const got = await lines(path.join(r.dir, 'activity.jsonl'));
  assert.deepEqual(got.map((a) => [a.k, a.turn]), [['cmd', 1], ['cmd', 1], ['turn', 1]], 'two of the main agent\'s commands, one turn (the first)');
});

test('off: nothing is observed; clearing forgets what was observed of that person only', async () => {
  const r = await rig({ mode: 'off' });
  await turn(r, session('o1'), { cmds: [{ cmd: 'npm test', err: FAIL }] });
  assert.deepEqual(await lines(path.join(r.dir, 'activity.jsonl')), []);
  await r.n.setSettings('al', { mode: 'practice' });
  await turn(r, session('o1'), { cmds: [{ cmd: 'npm test', err: FAIL }] });
  r.n.onEvent({ meta: { ...session('b1').meta, owner: 'bo' } }, { kind: 'turn_end', reason: 'done' });
  await r.n.settled();
  assert.equal((await lines(path.join(r.dir, 'activity.jsonl'))).length, 3);
  assert.equal(await r.n.clear('al'), 2);
  assert.deepEqual((await lines(path.join(r.dir, 'activity.jsonl'))).map((a) => a.owner), ['bo']);
  assert.equal((await r.n.overview('al')).observed.commands, 0);
});

test('end to end through the harness and its API: a real conversation running a failing command; practice, then on; the line in the conversation; Find the cause sends its own message as the person\'s', async () => {
  const { createHarness } = await import('../src/kernel/harness.ts');
  const { createApp } = await import('../src/server/app.ts');
  const { UserStore } = await import('../src/server/users.ts');
  const { FakeProvider } = await import('./helpers.ts');
  delete process.env.HARNESS_NOTICE_HOLDOUT;
  process.env.HARNESS_NOTICE_HOLDOUT = '0';
  const data = await tempDir();
  const users = await new UserStore(data).load();
  const harness = await createHarness({ dataDir: data, search: null, memory: 'off' });
  const fail = { name: 'bash', input: { command: 'node -e "console.error(\'Error: config.json is missing\'); process.exit(3)"' } };
  // Each conversation: 2 failing runs in its first turn, 1 in its second; then (the second) the person's click.
  const convo = [{ calls: [fail] }, { calls: [fail] }, { text: 'It failed twice.' }, { calls: [fail] }, { text: 'Still failing.' }];
  const fake = new FakeProvider([...convo, ...convo, { text: 'The cause: config.json was never created by the setup script.' }]);
  harness.registry.setProviderInstance('deepseek', fake);
  const work = await tempDir();
  const { server } = createApp({ harness, token: 'op', loopback: true, localRoots: [work], uiDir: path.join(data, 'ui'), appRoot: data, users });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(base + p, { method, headers: { authorization: 'Bearer op', ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-harness': '1' } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const idle = async (id: string, n: number) => { const end = Date.now() + 30_000; while (!(harness.sessions.get(id)!.status === 'idle' && harness.sessions.get(id)!.history.length >= n)) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 30)); } await harness.noticer.settled(); };
  const twoTurns = async () => {
    const s = (await call('POST', '/api/sessions', { model: 'deepseek-flash', runtime: 'local', path: work, mode: 'bypass', title: 'Set up the app' })).body;
    await call('POST', `/api/sessions/${s.id}/messages`, { text: 'set up the app and run it' });
    await idle(s.id, 6);
    await call('POST', `/api/sessions/${s.id}/messages`, { text: 'try once more' });
    await idle(s.id, 10);
    return s.id as string;
  };
  try {
    const first = await twoTurns();
    let o = (await call('GET', '/api/noticing')).body;
    assert.equal(o.mode, 'practice');
    assert.equal(o.practice.length, 1, 'practice: written down');
    assert.equal(o.practice[0].detector, 'stuck');
    assert.match(o.practice[0].body, /config\.json is missing/);
    assert.equal(o.observed.failed, 3);
    assert.equal(harness.inbox.list(undefined, { view: 'all', all: true }).filter((i) => i.kind === 'noticed').length, 0, 'nothing shown');
    assert.ok(first);
    assert.equal((await call('PUT', '/api/noticing', { mode: 'loud' })).status, 400);
    o = (await call('PUT', '/api/noticing', { mode: 'on' })).body;
    assert.equal(o.mode, 'on');
    const second = await twoTurns();
    const it = harness.inbox.list(undefined, { view: 'all', all: true }).find((i) => i.kind === 'noticed' && i.sessionId === second)!;
    assert.ok(it, 'shown');
    assert.deepEqual([it.detector, it.inline, it.alert], ['stuck', true, false]);
    // The inbox's own actions still check theirs; accept is only for an open finding.
    const other = await harness.inbox.add({ kind: 'message', title: 'Hello', body: 'x' });
    assert.equal((await call('POST', `/api/inbox/${other.id}`, { action: 'accept' })).status, 400);
    const acc = await call('POST', `/api/inbox/${it.id}`, { action: 'accept', prompt: 'rm -rf /' });
    assert.equal(acc.status, 200);
    assert.equal(acc.body.status, 'done');
    await idle(second, 12);
    const h = harness.sessions.get(second)!.history;
    const sent = JSON.stringify(h.at(-2));
    assert.match(sent, /Stop retrying it\. Find the root cause first/, 'its own message, not what the client sent');
    assert.ok(!sent.includes('rm -rf'));
    assert.match(JSON.stringify(h.at(-1)), /The cause: config\.json/);
    const turns = (await fs.readFile(path.join(data, 'activity.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((a) => a.sid === second && a.k === 'turn');
    assert.deepEqual(turns.map((t) => t.person), [true, true, false], 'the finding\'s message is not a task the person typed');
    assert.equal((await call('POST', `/api/inbox/${it.id}`, { action: 'accept' })).status, 400, 'once');
    const fb = (await harness.inbox.feedbackLog()).find((f) => f.itemId === it.id)!;
    assert.deepEqual([fb.action, fb.detector], ['done', 'stuck'], 'feedback says which detector');
    o = (await call('POST', '/api/noticing/check')).body;
    assert.equal(o.detectors.find((d: { id: string }) => d.id === 'stuck').stats.acted, 1);
    assert.equal((await call('POST', '/api/noticing/clear')).body.cleared > 0, true);
    assert.equal((await call('GET', '/api/noticing')).body.observed.commands, 0);
  } finally {
    server.close();
    await harness.close();
  }
});
