import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { cronGapMinutes, nextCron, Scheduler, ScheduleError } from '../src/core/scheduler.ts';
import { NOTHING_TO_REPORT, ScheduleRunLog } from '../src/core/schedule-runs.ts';
import { summaryOf } from '../src/core/schedule-track.ts';
import { createHarness } from '../src/kernel/harness.ts';
import type { HubEvent } from '../src/kernel/events.ts';
import type { Provider, ProviderRequest, ProviderResponse } from '../src/providers/types.ts';
import { createApp } from '../src/server/app.ts';
import { UserStore } from '../src/server/users.ts';
import { FakeProvider, tempDir } from './helpers.ts';

// Phase 1 of proactive work: every run of a schedule or trigger is written down - how it ended, what it
// cost, what it said and did, whether it found anything - and schedules keep time in a time zone, skip
// runs missed while the server was down when asked to, are not run too often, and stop at a cost.

const MIN = 60_000;
const until = async (f: () => boolean | Promise<boolean>, what: string, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!(await f())) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 20)); }
};

async function harness(steps: ConstructorParameters<typeof FakeProvider>[0] | Provider) {
  const h = await createHarness({ dataDir: await tempDir(), search: null, memory: 'off' });
  h.registry.setProviderInstance('deepseek', steps instanceof Array ? new FakeProvider(steps) : steps);
  const events: HubEvent[] = [];
  const off = h.events.subscribe(0, (e) => { if (e.topic === 'schedules') events.push(e); });
  const work = await tempDir();
  const newSession = { model: 'deepseek-flash', runtime: { kind: 'local' as const, network: 'none' as const, path: work }, mode: 'bypass' as const };
  return { h, sch: h.scheduler!, events, work, newSession, close: async () => { off(); await h.close(); } };
}

test('a run is written down from start to end: completed, its cost, a summary of its reply, its tool calls and actions, its conversation; the event stream has both ends', async () => {
  const t = await harness([
    { calls: [{ name: 'write', input: { path: 'report.md', content: '# Build\nGreen.\n' } }], usage: { input: 2000, cacheRead: 0, cacheWrite: 0, output: 100, reasoning: 0 } },
    { text: '## Build report\nThe nightly build is **green**; I wrote `report.md`.', usage: { input: 2500, cacheRead: 0, cacheWrite: 0, output: 60, reasoning: 0 } },
  ]);
  try {
    const s = await t.sch.create({ title: 'Nightly', prompt: 'check the build and write a report', cron: '0 2 * * *', newSession: t.newSession });
    await t.sch.tick(s.nextRun! + 1000);
    await t.sch.settled();
    const [run, ...rest] = await t.sch.runs.list({ scheduleId: s.id });
    assert.equal(rest.length, 0);
    assert.equal(run!.status, 'completed');
    assert.equal(run!.by, 'schedule');
    assert.equal(run!.title, 'Nightly');
    assert.equal(run!.tools, 1);
    assert.equal(run!.actions, 1, 'a write changes something');
    assert.equal(run!.noOp, false);
    assert.equal(run!.notified, false);
    assert.equal(run!.summary, 'Build report The nightly build is green; I wrote report.md.');
    assert.ok(run!.costUsd! > 0, 'its cost');
    assert.ok(run!.endedAt! >= run!.startedAt);
    const session = t.h.sessions.get(run!.sessionId!)!;
    assert.equal(run!.costUsd, Math.round(session.meta.cost * 1e6) / 1e6, 'all of a new conversation\'s cost is the run\'s');
    assert.match(JSON.stringify(session.history[0]), /Nobody is watching: if, when you finish, nothing needs the person's attention, end your reply with \[nothing to report\]/);
    assert.equal(await fs.readFile(path.join(t.work, 'report.md'), 'utf8'), '# Build\nGreen.\n');
    assert.equal(t.sch.get(s.id)!.lastResult, 'completed');
    const fired = t.events.find((e) => (e.payload as { type: string }).type === 'fired')!.payload as { run: { status: string; id: string } };
    const ended = t.events.find((e) => (e.payload as { type: string }).type === 'ended')!.payload as { run: { status: string; id: string }; lastResult: string };
    assert.equal(fired.run.status, 'running');
    assert.equal(ended.run.status, 'completed');
    assert.equal(ended.run.id, fired.run.id, 'one run, two ends');
    assert.equal(ended.lastResult, 'completed');
  } finally { await t.close(); }
});

test('nothing to report: the agent says so, the run is marked as finding nothing, and the words are not in its summary', async () => {
  const t = await harness([{ text: `Checked the inbox: nothing new. ${NOTHING_TO_REPORT}` }]);
  try {
    const s = await t.sch.create({ prompt: 'check the inbox', inMinutes: 5, newSession: t.newSession });
    await t.sch.runNow(s.id);
    await t.sch.settled();
    const [run] = await t.sch.runs.list({ scheduleId: s.id });
    assert.equal(run!.by, 'manual');
    assert.equal(run!.noOp, true);
    assert.equal(run!.summary, 'Checked the inbox: nothing new.');
    assert.equal(t.sch.get(s.id)!.lastResult, 'completed: nothing to report');
  } finally { await t.close(); }
});

test('a run that tells the person is not "nothing to report"; a run with no reply and no action is', async () => {
  const t = await harness([
    { calls: [{ name: 'notify_user', input: { message: 'Disk is 95% full.' } }] }, { text: 'Told them.' },
    { text: '' },
  ]);
  try {
    const a = await t.sch.create({ prompt: 'watch the disk', inMinutes: 5, newSession: t.newSession });
    await t.sch.runNow(a.id);
    await t.sch.settled();
    const [ra] = await t.sch.runs.list({ scheduleId: a.id });
    assert.equal(ra!.notified, true);
    assert.equal(ra!.actions, 0, 'telling the person is not an action on anything');
    assert.equal(ra!.noOp, false);
    const b = await t.sch.create({ prompt: 'watch again', inMinutes: 5, newSession: t.newSession });
    await t.sch.runNow(b.id);
    await t.sch.settled();
    const [rb] = await t.sch.runs.list({ scheduleId: b.id });
    assert.equal(rb!.noOp, true);
  } finally { await t.close(); }
});

test('a run stops at its own spend limit; the record says why, and the next turn in that conversation is not limited', async () => {
  const big = { input: 400_000, cacheRead: 0, cacheWrite: 0, output: 20_000, reasoning: 0 };
  const t = await harness([
    { calls: [{ name: 'glob', input: { pattern: '*' } }], usage: big },
    { calls: [{ name: 'glob', input: { pattern: '*' } }], usage: big },
    { calls: [{ name: 'glob', input: { pattern: '*' } }], usage: big },
    { text: 'never reached', usage: big },
    { text: 'a later turn runs', usage: big },
  ]);
  try {
    const s = await t.sch.create({ prompt: 'expensive work', inMinutes: 5, newSession: t.newSession, maxCostUsd: 0.01 });
    assert.equal(s.maxCostUsd, 0.01);
    await t.sch.runNow(s.id);
    await t.sch.settled();
    const [run] = await t.sch.runs.list({ scheduleId: s.id });
    assert.equal(run!.status, 'stopped');
    assert.match(run!.reason!, /^Stopped: this scheduled run reached its spend limit of \$0\.01/);
    assert.match(t.sch.get(s.id)!.lastResult!, /^Stopped: this scheduled run reached its spend limit/, 'said once');
    const session = t.h.sessions.get(run!.sessionId!)!;
    // The limit was for that run only.
    await session.send('carry on');
    await until(() => session.status === 'idle' && JSON.stringify(session.history).includes('never reached'), 'a later turn');
  } finally { await t.close(); }
});

class Failing implements Provider {
  async send(_r: ProviderRequest): Promise<ProviderResponse> { throw Object.assign(new Error('the provider refused the key'), { status: 401 }); }
}

test('a run whose model fails is written down as failed, with the error', async () => {
  const t = await harness(new Failing());
  try {
    const s = await t.sch.create({ prompt: 'anything', inMinutes: 5, newSession: t.newSession });
    await t.sch.runNow(s.id);
    await t.sch.settled();
    const [run] = await t.sch.runs.list({ scheduleId: s.id });
    assert.equal(run!.status, 'failed');
    assert.match(run!.reason ?? '', /refused the key|error/i);
    assert.match(t.sch.get(s.id)!.lastResult!, /^failed/);
  } finally { await t.close(); }
});

test('runs that did not start are written down too: a busy conversation, a missing one; a trigger\'s runs say they came from it', async () => {
  const t = await harness(Array.from({ length: 6 }, () => ({ text: 'ok' })));
  try {
    const target = await t.h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: t.newSession.runtime });
    const s = await t.sch.create({ prompt: 'into it', inMinutes: 5, sessionId: target.meta.id });
    (target as unknown as { setStatus: (x: string) => void }).setStatus('running');
    await t.sch.runNow(s.id);
    (target as unknown as { setStatus: (x: string) => void }).setStatus('idle');
    const [busy] = await t.sch.runs.list({ scheduleId: s.id });
    assert.equal(busy!.status, 'skipped');
    assert.equal(busy!.reason, 'skipped: the session was busy');
    assert.ok(busy!.endedAt);
    const gone = await t.sch.create({ prompt: 'into nothing', inMinutes: 5, sessionId: 'deadbeefdeadbeef' });
    await t.sch.runNow(gone.id);
    assert.equal((await t.sch.runs.list({ scheduleId: gone.id }))[0]!.reason, 'not run: its session no longer exists');
    const trig = await t.sch.createTrigger({ prompt: 'on push', newSession: t.newSession });
    await t.sch.fireTrigger(trig.token, 'payload');
    await t.sch.settled();
    const [tr] = await t.sch.runs.list({ scheduleId: trig.schedule.id });
    assert.equal(tr!.by, 'trigger');
    assert.equal(tr!.status, 'completed');
    // Newest first, across schedules.
    const all = await t.sch.runs.list({ all: true });
    assert.equal(all.length, 3);
    assert.ok(all[0]!.startedAt >= all[1]!.startedAt && all[1]!.startedAt >= all[2]!.startedAt);
  } finally { await t.close(); }
});

test('missed runs: by default a run missed while the server was down runs once when it is back; with misfire "skip" it is written down as missed and the next time is kept', async () => {
  const t = await harness(Array.from({ length: 4 }, () => ({ text: 'ok' })));
  try {
    const once = await t.sch.create({ prompt: 'default', cron: '0 9 * * *', newSession: t.newSession });
    const skip = await t.sch.create({ prompt: 'skip it', cron: '0 9 * * *', newSession: t.newSession, misfire: 'skip' });
    const late = once.nextRun! + 6 * 3600_000;
    // Within the grace a late tick still counts as on time.
    const onTime = await t.sch.create({ prompt: 'just late', cron: '0 9 * * *', newSession: t.newSession, misfire: 'skip' });
    await t.sch.tick(late);
    await t.sch.settled();
    assert.equal((await t.sch.runs.list({ scheduleId: once.id }))[0]!.status, 'completed', 'run once');
    const missed = (await t.sch.runs.list({ scheduleId: skip.id }))[0]!;
    assert.equal(missed.status, 'skipped');
    assert.match(missed.reason!, /^skipped: missed: it was due at .* while this server was not running/);
    assert.equal(missed.sessionId, undefined, 'no conversation was started');
    assert.equal(t.sch.get(skip.id)!.nextRun, nextCron('0 9 * * *', late), 'its next time is kept');
    assert.equal((await t.sch.runs.list({ scheduleId: onTime.id }))[0]!.status, 'skipped', 'the same tick, six hours late');
    const g = await t.sch.create({ prompt: 'grace', cron: '30 9 * * *', newSession: t.newSession, misfire: 'skip' });
    await t.sch.tick(g.nextRun! + 2 * MIN);
    await t.sch.settled();
    assert.equal((await t.sch.runs.list({ scheduleId: g.id }))[0]!.status, 'completed', 'two minutes late is on time');
  } finally { await t.close(); }
});

test('a run left open by a server that stopped is closed as interrupted when the next one starts; one still at work is left alone', async () => {
  const dir = await tempDir();
  const log = new ScheduleRunLog(dir);
  const sch = new Scheduler(dir, { run: async () => ({ result: 'started' }) });
  await sch.load();
  const s = await sch.create({ prompt: 'x', cron: '0 9 * * *', sessionId: 'aaaa' });
  const a = await log.start({ scheduleId: s.id, title: 'x', by: 'schedule', startedAt: 1000, status: 'running', sessionId: 'aaaa' });
  const b = await log.start({ scheduleId: s.id, title: 'x', by: 'schedule', startedAt: 2000, status: 'running', sessionId: 'bbbb' });
  await (sch as unknown as { mutate: (f: () => void) => Promise<void> }).mutate(() => { sch.get(s.id)!.lastRun = 1000; });
  const n = await sch.closeInterrupted(async (sid) => sid === 'bbbb', 5000);
  assert.equal(n, 1);
  assert.equal((await log.get(a.id))!.status, 'interrupted');
  assert.equal((await log.get(a.id))!.endedAt, 5000);
  assert.equal((await log.get(b.id))!.status, 'running');
  assert.match(sch.get(s.id)!.lastResult!, /^interrupted: the server stopped/);
});

test('time zones: a cron is read on the wall clock of its zone, through daylight saving (a skipped time does not run, a repeated one runs once), and in half-hour zones', () => {
  const at = (iso: string) => Date.parse(iso);
  const iso = (t: number | undefined) => (t === undefined ? 'never' : new Date(t).toISOString());
  // 9:00 in New York is 14:00 UTC in winter, 13:00 in summer.
  assert.equal(iso(nextCron('0 9 * * *', at('2026-01-15T12:00:00Z'), 'America/New_York')), '2026-01-15T14:00:00.000Z');
  assert.equal(iso(nextCron('0 9 * * *', at('2026-07-15T12:00:00Z'), 'America/New_York')), '2026-07-15T13:00:00.000Z');
  // 2026-03-08: clocks go from 2:00 to 3:00 in New York. 2:30 does not exist that day.
  assert.equal(iso(nextCron('30 2 * * *', at('2026-03-07T12:00:00Z'), 'America/New_York')), '2026-03-09T06:30:00.000Z');
  // 2026-11-01: clocks go back from 2:00 to 1:00. 1:30 happens twice: it runs at the first, then the next day.
  const first = nextCron('30 1 * * *', at('2026-10-31T12:00:00Z'), 'America/New_York');
  assert.equal(iso(first), '2026-11-01T05:30:00.000Z');
  assert.equal(iso(nextCron('30 1 * * *', first!, 'America/New_York')), '2026-11-02T06:30:00.000Z');
  // India is UTC+5:30, Nepal UTC+5:45.
  assert.equal(iso(nextCron('0 9 * * *', at('2026-05-01T00:00:00Z'), 'Asia/Kolkata')), '2026-05-01T03:30:00.000Z');
  assert.equal(iso(nextCron('15 6 * * 1', at('2026-05-01T00:00:00Z'), 'Asia/Kathmandu')), '2026-05-04T00:30:00.000Z');
  // Weekdays and days of the month are the zone's: Monday 0:30 in Tokyo is Sunday 15:30 UTC.
  assert.equal(iso(nextCron('30 0 * * 1', at('2026-05-01T00:00:00Z'), 'Asia/Tokyo')), '2026-05-03T15:30:00.000Z');
  assert.equal(iso(nextCron('0 0 1 * *', at('2026-05-15T00:00:00Z'), 'Pacific/Auckland')), '2026-05-31T12:00:00.000Z');
  // The 29th of February, years ahead.
  assert.equal(iso(nextCron('0 12 29 2 *', at('2026-03-01T00:00:00Z'), 'UTC')), '2028-02-29T12:00:00.000Z');
  assert.equal(nextCron('0 0 31 2 *', at('2026-01-01T00:00:00Z'), 'UTC'), undefined);
});

test('making and changing schedules: the time zone, misfire and cost limit are checked; a schedule may not run more often than every few minutes', async () => {
  const dir = await tempDir();
  const sch = new Scheduler(dir, { run: async () => ({ result: 'started' }) });
  await sch.load();
  const target = { sessionId: 'aaaa' };
  await assert.rejects(sch.create({ prompt: 'x', cron: '*/2 * * * *', ...target }), /runs every 2 minutes; a schedule may run at most every 5 minutes/);
  await assert.rejects(sch.create({ prompt: 'x', cron: '* * * * *', ...target }), /every 1 minute;/);
  await assert.rejects(sch.create({ prompt: 'x', cron: '0,1 9 * * *', ...target }), /every 1 minute/, 'two runs a minute apart, once a day');
  await assert.rejects(sch.create({ prompt: 'x', cron: '0 9 * * *', ...target, timeZone: 'Mars/Olympus' }), /not a time zone this server knows/);
  await assert.rejects(sch.create({ prompt: 'x', cron: '0 9 * * *', ...target, maxCostUsd: -1 }), /maxCostUsd/);
  await assert.rejects(sch.create({ prompt: 'x', cron: '0 9 * * *', ...target, misfire: 'later' as never }), /misfire is once or skip/);
  assert.equal(cronGapMinutes('*/5 * * * *'), 5);
  assert.equal(cronGapMinutes('0 9 * * 1-5'), 1440);
  const s = await sch.create({ title: 'Morning', prompt: 'x', cron: '0 9 * * *', ...target, timeZone: 'Europe/Berlin', misfire: 'skip', maxCostUsd: 2 });
  const now = Date.parse('2026-06-01T00:00:00Z');
  assert.equal(new Date(nextCron('0 9 * * *', now, 'Europe/Berlin')!).toISOString(), '2026-06-01T07:00:00.000Z');
  // Changing the time recomputes the next run in the zone; null clears the zone and the limit.
  const u = (await sch.update(s.id, { cron: '0 18 * * *', timeZone: 'Asia/Tokyo' }, now))!;
  assert.equal(new Date(u.nextRun!).toISOString(), '2026-06-01T09:00:00.000Z');
  assert.equal(u.timeZone, 'Asia/Tokyo');
  const c = (await sch.update(s.id, { timeZone: null, maxCostUsd: null, prompt: '  new prompt  ', title: '' }, now))!;
  assert.equal(c.timeZone, undefined);
  assert.equal(c.maxCostUsd, undefined);
  assert.equal(c.prompt, 'new prompt');
  assert.equal(c.title, 'new prompt', 'an empty title falls back to the prompt');
  assert.equal(c.misfire, 'skip', 'kept');
  await assert.rejects(sch.update(s.id, { cron: '*/1 * * * *' }, now), /at most every 5 minutes/);
  await assert.rejects(sch.update(s.id, { prompt: ' ' }), /needs a prompt/);
  // A one-time schedule that ran gets a new time and runs again.
  const once = await sch.create({ prompt: 'once', inMinutes: 10, ...target }, now);
  await sch.tick(once.nextRun! + 1000);
  assert.equal(sch.get(once.id)!.enabled, false);
  const again = (await sch.update(once.id, { inMinutes: 30 }, once.nextRun! + 2000))!;
  assert.equal(again.enabled, true);
  assert.equal(again.nextRun, once.nextRun! + 2000 + 30 * MIN);
  // A trigger has no time.
  const trig = await sch.createTrigger({ prompt: 'on push', ...target });
  await assert.rejects(sch.update(trig.schedule.id, { cron: '0 9 * * *' }), /a trigger runs when its URL is called/);
  assert.equal((await sch.update(trig.schedule.id, { prompt: 'on any push' }))!.prompt, 'on any push');
  assert.ok(ScheduleError);
});

test('the run log: newest first, a line cut short is skipped, a deleted schedule\'s runs go with it, and it is kept to its size', async () => {
  const dir = await tempDir();
  const log = new ScheduleRunLog(dir);
  const a = await log.start({ scheduleId: 'aa', title: 'a', by: 'manual', startedAt: 1, status: 'running' });
  await log.finish(a, { status: 'completed', summary: 'done', endedAt: 5 });
  await log.start({ scheduleId: 'bb', title: 'b', by: 'manual', startedAt: 2, status: 'skipped', reason: 'busy' });
  await fs.appendFile(log.file, '{"id":"cut","scheduleId":"aa","sta');
  const list = await log.list({ all: true });
  assert.deepEqual(list.map((r) => [r.scheduleId, r.status]), [['bb', 'skipped'], ['aa', 'completed']]);
  assert.equal((await log.get(a.id))!.summary, 'done');
  await log.forget('aa');
  assert.deepEqual((await log.list({ all: true })).map((r) => r.scheduleId), ['bb']);
  assert.equal(summaryOf('# Title\n\nSome **bold** text\n\n```js\ncode()\n```\nend [nothing to report]'), 'Title Some bold text end');
  assert.equal(summaryOf('x'.repeat(400)).length, 280);
});

test('the schedules API: edit, run history and every run of mine; nobody else\'s; a trigger\'s hash never leaves the server', async () => {
  const data = await tempDir();
  const users = await new UserStore(data).load();
  const harness = await createHarness({ dataDir: data, search: null, memory: 'off' });
  harness.registry.setProviderInstance('deepseek', new FakeProvider(Array.from({ length: 10 }, () => ({ text: 'ok' }))));
  const work = await tempDir();
  const { server } = createApp({ harness, token: 'op', loopback: true, localRoots: [work], uiDir: path.join(data, 'ui'), appRoot: data, users });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (token: string, method: string, p: string, body?: unknown) => {
    const res = await fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-harness': '1' } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    const alice = (await call('op', 'POST', '/api/users', { name: 'alice' })).body as { id: string; token: string };
    const bob = (await call('op', 'POST', '/api/users', { name: 'bob' })).body as { id: string; token: string };
    const made = await call('op', 'POST', '/api/schedules', { title: 'Mine', prompt: 'p', cron: '0 9 * * *', timeZone: 'Europe/Berlin', misfire: 'skip', maxCostUsd: 1.5, newSession: { runtime: 'local', path: work } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.timeZone, 'Europe/Berlin');
    assert.equal(made.body.misfire, 'skip');
    assert.equal(made.body.maxCostUsd, 1.5);
    assert.equal((await call('op', 'POST', '/api/schedules', { prompt: 'p', cron: '* * * * *', newSession: { runtime: 'local', path: work } })).status, 400);
    const edited = await call('op', 'PATCH', `/api/schedules/${made.body.id}`, { title: 'Renamed', timeZone: '', maxCostUsd: null });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.title, 'Renamed');
    assert.equal(edited.body.timeZone, undefined);
    assert.equal(edited.body.maxCostUsd, undefined);
    assert.equal((await call('op', 'PATCH', `/api/schedules/${made.body.id}`, { timeZone: 'Nowhere/City' })).status, 400);
    assert.equal((await call(bob.token, 'PATCH', `/api/schedules/${made.body.id}`, { title: 'x' })).status, 404, 'someone else\'s');
    await call('op', 'POST', `/api/schedules/${made.body.id}/run`);
    await harness.scheduler!.settled();
    const runs = await call('op', 'GET', `/api/schedules/${made.body.id}/runs`);
    assert.equal(runs.body.length, 1);
    assert.equal(runs.body[0].status, 'completed');
    assert.equal(runs.body[0].by, 'manual');
    assert.equal((await call(bob.token, 'GET', `/api/schedules/${made.body.id}/runs`)).status, 404);
    // A trigger of alice's: its URL once; never its hash.
    const trig = await call(alice.token, 'POST', '/api/schedules', { prompt: 'on push', trigger: true, newSession: { runtime: 'docker' } });
    assert.equal(trig.status, 201);
    assert.ok(trig.body.url && trig.body.trigger === true && trig.body.triggerHash === undefined);
    const listed = await call(alice.token, 'GET', '/api/schedules');
    assert.equal(listed.body[0].trigger, true);
    assert.equal(JSON.stringify(listed.body).includes('triggerHash'), false);
    assert.equal(JSON.stringify((await call(alice.token, 'GET', `/api/schedules/${trig.body.id}`)).body).includes('triggerHash'), false);
    // Every run of mine: the operator's run, not alice's (she has none yet); limit is respected.
    assert.deepEqual((await call(alice.token, 'GET', '/api/schedule-runs')).body, []);
    assert.equal((await call('op', 'GET', '/api/schedule-runs?limit=1')).body.length, 1);
    assert.equal((await call(bob.token, 'GET', '/api/schedule-runs')).body.length, 0);
  } finally { await new Promise<void>((r) => (server as http.Server).close(() => r())); await harness.close(); }
});

class Hanging implements Provider {
  started = 0;
  async send(req: ProviderRequest): Promise<ProviderResponse> {
    this.started++;
    return new Promise((_res, rej) => { req.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }); });
  }
}

test('a run still at work when the server shuts down is written down as interrupted, not as stopped by the person; the next server finds it so and runs the schedule on', async () => {
  const data = await tempDir();
  const work = await tempDir();
  const hanging = new Hanging();
  const h1 = await createHarness({ dataDir: data, search: null, memory: 'off' });
  h1.registry.setProviderInstance('deepseek', hanging);
  const s = await h1.scheduler!.create({ title: 'Long job', prompt: 'work for a long time', cron: '0 3 * * *', newSession: { model: 'deepseek-flash', runtime: { kind: 'local', network: 'none', path: work }, mode: 'bypass' } });
  await h1.scheduler!.runNow(s.id);
  await until(() => hanging.started > 0, 'the run is at work');
  assert.equal((await h1.scheduler!.runs.list({ scheduleId: s.id }))[0]!.status, 'running');
  await h1.close();
  const h2 = await createHarness({ dataDir: data, search: null, memory: 'off' });
  try {
    const [run] = await h2.scheduler!.runs.list({ scheduleId: s.id });
    assert.equal(run!.status, 'interrupted');
    assert.equal(run!.reason, 'interrupted: the server stopped before the run ended');
    assert.equal(h2.scheduler!.get(s.id)!.lastResult, 'interrupted: the server stopped before the run ended');
    assert.equal(h2.scheduler!.get(s.id)!.enabled, true, 'it keeps its schedule');
    // Stopped by the person is still that.
    h2.registry.setProviderInstance('deepseek', new Hanging());
    await h2.scheduler!.runNow(s.id);
    const sid = (await h2.scheduler!.runs.list({ scheduleId: s.id }))[0]!.sessionId!;
    await until(() => h2.sessions.get(sid)?.status === 'running', 'running');
    h2.sessions.get(sid)!.abort();
    await h2.scheduler!.settled();
    const [stopped] = await h2.scheduler!.runs.list({ scheduleId: s.id });
    assert.equal(stopped!.status, 'stopped');
    assert.equal(stopped!.reason, 'stopped by the person');
  } finally { await h2.close(); }
});
