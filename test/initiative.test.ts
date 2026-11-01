import assert from 'node:assert/strict';
import type http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { checkInterruptions, decideAlert, digestBody, digestDue, inQuietHours, type Interruptions } from '../src/core/initiative.ts';
import { scheduleStats } from '../src/core/schedule-stats.ts';
import type { InboxItem } from '../src/core/inbox.ts';
import type { ScheduleRun } from '../src/core/schedule-runs.ts';
import { createHarness } from '../src/kernel/harness.ts';
import type { HubEvent } from '../src/kernel/events.ts';
import { createApp } from '../src/server/app.ts';
import { UserStore } from '../src/server/users.ts';
import { FakeProvider, tempDir } from './helpers.ts';

// Phase 4 of proactive work: when unattended work may interrupt the person. Each schedule says what its
// results do (every time, only when it matters, the digest, or its history only); the person sets quiet
// hours, a most a day and a digest time; how useful each schedule has been is measured, and a schedule
// whose updates are mostly unwanted offers to be quieter - it is never made louder on its own.

const at = (iso: string) => Date.parse(iso);
const until = async (f: () => boolean | Promise<boolean>, what: string, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!(await f())) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 20)); }
};

test('what interrupts: by the schedule\'s policy, then quiet hours, then the day\'s budget (errors still come through it, never through quiet hours)', () => {
  const result = { kind: 'result' as const, level: 'info' as const };
  const failed = { kind: 'result' as const, level: 'error' as const };
  const message = { kind: 'message' as const, level: 'info' as const };
  const none: Interruptions = {};
  const noon = at('2026-05-01T12:00:00Z');
  assert.deepEqual(decideAlert(result, 'always', none, 0, noon), { alert: true });
  assert.deepEqual(decideAlert(result, 'important', none, 0, noon), { alert: false, held: 'policy' });
  assert.deepEqual(decideAlert(failed, 'important', none, 0, noon), { alert: true });
  assert.deepEqual(decideAlert(message, 'important', none, 0, noon), { alert: true }, 'what the agent chose to tell is important');
  assert.deepEqual(decideAlert(result, 'digest', none, 0, noon), { alert: false, held: 'digest' });
  assert.deepEqual(decideAlert(failed, 'digest', none, 0, noon), { alert: true });
  assert.deepEqual(decideAlert(result, 'silent', none, 0, noon), { alert: false, held: 'policy' });
  const quiet: Interruptions = { quietFrom: '22:00', quietTo: '07:00', timeZone: 'UTC' };
  assert.deepEqual(decideAlert(failed, 'always', quiet, 0, at('2026-05-01T23:30:00Z')), { alert: false, held: 'quiet' }, 'not even errors at night');
  assert.deepEqual(decideAlert(result, 'always', quiet, 0, at('2026-05-01T07:00:00Z')), { alert: true }, 'quiet ends at 07:00');
  const budget: Interruptions = { maxPerDay: 3 };
  assert.deepEqual(decideAlert(result, 'always', budget, 3, noon), { alert: false, held: 'budget' });
  assert.deepEqual(decideAlert(failed, 'always', budget, 3, noon), { alert: true }, 'an error still interrupts');
  assert.deepEqual(decideAlert(result, 'always', { maxPerDay: 0 }, 0, noon), { alert: false, held: 'budget' }, '0: never');
});

test('quiet hours over midnight and in a time zone; the limits are checked; when a digest is due', () => {
  const q: Interruptions = { quietFrom: '22:00', quietTo: '07:00', timeZone: 'Asia/Tokyo' };
  assert.equal(inQuietHours(q, at('2026-05-01T13:30:00Z')), true, '22:30 in Tokyo');
  assert.equal(inQuietHours(q, at('2026-05-01T21:59:00Z')), true, '06:59 in Tokyo');
  assert.equal(inQuietHours(q, at('2026-05-01T22:00:00Z')), false, '07:00 in Tokyo');
  assert.equal(inQuietHours({ quietFrom: '12:00', quietTo: '13:00', timeZone: 'UTC' }, at('2026-05-01T12:30:00Z')), true, 'within a day');
  assert.equal(inQuietHours({}, at('2026-05-01T03:00:00Z')), false);
  assert.deepEqual(checkInterruptions({ quietFrom: '22:00', quietTo: '07:00', maxPerDay: '5', digestAt: '08:30', timeZone: 'Europe/Berlin' }), { quietFrom: '22:00', quietTo: '07:00', digestAt: '08:30', timeZone: 'Europe/Berlin', maxPerDay: 5 });
  assert.throws(() => checkInterruptions({ quietFrom: '25:00', quietTo: '07:00' }), /quietFrom is a time/);
  assert.throws(() => checkInterruptions({ quietFrom: '22:00' }), /need both/);
  assert.throws(() => checkInterruptions({ timeZone: 'Atlantis/City' }), /not a time zone/);
  assert.throws(() => checkInterruptions({ maxPerDay: -1 }), /0 to 1000/);
  const d: Interruptions = { digestAt: '08:30', timeZone: 'UTC' };
  assert.equal(digestDue(d, undefined, at('2026-05-01T08:00:00Z')), false, 'not yet');
  assert.equal(digestDue(d, undefined, at('2026-05-01T08:31:00Z')), true);
  assert.equal(digestDue(d, at('2026-05-01T08:31:00Z'), at('2026-05-01T20:00:00Z')), false, 'made today');
  assert.equal(digestDue(d, at('2026-05-01T08:00:00Z'), at('2026-05-01T09:00:00Z')), true, 'the last was before today\'s time');
  assert.equal(digestDue(d, at('2026-05-01T08:31:00Z'), at('2026-05-02T08:30:00Z')), true, 'the next day');
  assert.equal(digestDue({}, undefined, at('2026-05-01T09:00:00Z')), false, 'no digest time');
  assert.match(digestBody([{ kind: 'result', title: 'Nightly', body: 'green', level: 'info' }, { kind: 'result', title: 'Deploy', body: 'failed', level: 'error' }]), /^2 updates waited for you:\n- Nightly: green\n- \(!\) Deploy: failed$/);
});

async function harness(steps: ConstructorParameters<typeof FakeProvider>[0]) {
  const h = await createHarness({ dataDir: await tempDir(), search: null, memory: 'off' });
  h.registry.setProviderInstance('deepseek', new FakeProvider(steps));
  const work = await tempDir();
  const ns = { model: 'deepseek-flash', runtime: { kind: 'local' as const, network: 'none' as const, path: work }, mode: 'bypass' as const };
  return { h, ns, sch: h.scheduler!, inbox: h.inbox };
}
const runOnce = async (t: Awaited<ReturnType<typeof harness>>, spec: Parameters<NonNullable<typeof t.sch>['create']>[0]) => {
  const s = await t.sch.create(spec);
  await t.sch.runNow(s.id);
  await t.sch.settled();
  // Its update (if any) is written just after the run ends: wait for the inbox file to be quiet.
  for (let i = 0, n = -1; i < 50; i++) { const now = t.inbox.list(undefined, { view: 'all', all: true }).length; if (now === n) break; n = now; await new Promise((r) => setTimeout(r, 60)); }
  return s;
};

test('each policy in the inbox: always interrupts; important keeps a plain result quiet but a failure loud; silent keeps it to its history; digest holds it for the digest, which comes once a day and interrupts', async () => {
  const t = await harness([{ text: 'A' }, { text: 'B' }, { text: 'C' }, { calls: [{ name: 'notify_user', input: { message: 'Heads up.' } }] }, { text: 'D' }, { text: 'E' }]);
  try {
    const always = await runOnce(t, { owner: 'al', title: 'Always', prompt: 'x', inMinutes: 5, newSession: t.ns });
    const important = await runOnce(t, { owner: 'al', title: 'Important', prompt: 'x', inMinutes: 5, newSession: t.ns, notify: 'important' });
    const silent = await runOnce(t, { owner: 'al', title: 'Silent', prompt: 'x', inMinutes: 5, newSession: t.ns, notify: 'silent' });
    const silentTold = await runOnce(t, { owner: 'al', title: 'Silent but told', prompt: 'x', inMinutes: 5, newSession: t.ns, notify: 'silent' });
    const digest = await runOnce(t, { owner: 'al', title: 'Digest', prompt: 'x', inMinutes: 5, newSession: t.ns, notify: 'digest' });
    const by = (id: string) => t.inbox.list('al', { view: 'all' }).filter((i) => i.scheduleId === id);
    assert.deepEqual(by(always.id).map((i) => [i.kind, i.alert, i.held]), [['result', true, undefined]]);
    assert.deepEqual(by(important.id).map((i) => [i.kind, i.alert, i.held]), [['result', false, 'policy']]);
    assert.deepEqual(by(silent.id), [], 'silent: only its run history');
    assert.equal((await t.sch.runs.list({ scheduleId: silent.id })).length, 1);
    assert.deepEqual(by(silentTold.id).map((i) => [i.kind, i.alert]), [['message', true]], 'what the agent chose to tell still reaches them');
    assert.deepEqual(by(digest.id).map((i) => [i.kind, i.alert, i.held]), [['result', false, 'digest']]);
    // The digest at 08:30 (UTC): what waited, once.
    await t.inbox.setInterruptions('al', { digestAt: '08:30', timeZone: 'UTC' });
    await t.h.makeDigests(at('2030-05-01T08:00:00Z'));
    assert.equal(t.inbox.list('al').filter((i) => i.kind === 'digest').length, 0, 'not yet');
    await t.h.makeDigests(at('2030-05-01T08:31:00Z'));
    const [dg] = t.inbox.list('al').filter((i) => i.kind === 'digest');
    assert.equal(dg!.alert, true);
    assert.match(dg!.body, /^2 updates waited for you:/);
    assert.match(dg!.body, /- Important: B/);
    assert.match(dg!.body, /- Digest: E/);
    await t.h.makeDigests(at('2030-05-01T12:00:00Z'));
    assert.equal(t.inbox.list('al').filter((i) => i.kind === 'digest').length, 1, 'once a day');
    await t.h.makeDigests(at('2030-05-02T08:31:00Z'));
    assert.equal(t.inbox.list('al').filter((i) => i.kind === 'digest').length, 1, 'nothing new waited: no empty digest');
  } finally { await t.h.close(); }
});

test('the person\'s limits: in quiet hours nothing interrupts; past the day\'s most, only errors do; their own inbox only', async () => {
  const t = await harness([{ calls: [{ name: 'notify_user', input: { message: 'one' } }] }, { text: 'ok' }, { calls: [{ name: 'notify_user', input: { message: 'two' } }] }, { text: 'ok' }, { calls: [{ name: 'notify_user', input: { message: 'three' } }] }, { text: 'ok' }]);
  try {
    await t.inbox.setInterruptions('al', { maxPerDay: 1 });
    await runOnce(t, { owner: 'al', title: 'A', prompt: 'x', inMinutes: 5, newSession: t.ns, notify: 'important' });
    await runOnce(t, { owner: 'al', title: 'B', prompt: 'x', inMinutes: 5, newSession: t.ns, notify: 'important' });
    const msgs = t.inbox.list('al', { view: 'all' }).filter((i) => i.kind === 'message').sort((a, b) => a.at - b.at);
    assert.deepEqual(msgs.map((m) => [m.body, m.alert, m.held]), [['one', true, undefined], ['two', false, 'budget']]);
    // Always quiet (from 00:00 to 23:59).
    await t.inbox.setInterruptions('bo', { quietFrom: '00:00', quietTo: '23:59' });
    await runOnce(t, { owner: 'bo', title: 'C', prompt: 'x', inMinutes: 5, newSession: t.ns, notify: 'important' });
    const [bm] = t.inbox.list('bo', { view: 'all' }).filter((i) => i.kind === 'message');
    assert.deepEqual([bm!.alert, bm!.held], [false, 'quiet']);
    assert.deepEqual(await t.inbox.interruptions('al'), { maxPerDay: 1 });
  } finally { await t.h.close(); }
});

test('a scheduled run\'s warnings are flagged as scheduled on the event stream (its inbox update speaks for it); a conversation\'s are not', async () => {
  const big = { input: 400_000, cacheRead: 0, cacheWrite: 0, output: 20_000, reasoning: 0 };
  const t = await harness([{ calls: [{ name: 'glob', input: { pattern: '*' } }], usage: big }, { calls: [{ name: 'glob', input: { pattern: '*' } }], usage: big }, { text: 'x', usage: big }]);
  const seen: HubEvent[] = [];
  const off = t.h.events.subscribe(0, (e) => { if (e.topic === 'notices') seen.push(e); });
  try {
    await runOnce(t, { owner: 'al', title: 'Costly', prompt: 'x', inMinutes: 5, newSession: t.ns, maxCostUsd: 0.01 });
    await until(() => seen.some((e) => /spend limit/.test(String((e.payload as { text: string }).text))) && t.inbox.list('al').some((i) => i.kind === 'result'), 'the warning and the update');
    const warn = seen.find((e) => /spend limit/.test(String((e.payload as { text: string }).text)))!;
    assert.equal((warn.payload as { scheduled?: boolean }).scheduled, true);
    const [r] = t.inbox.list('al').filter((i) => i.kind === 'result');
    assert.deepEqual([r!.level, r!.alert], ['warn', true]);
  } finally { off(); await t.h.close(); }
});

test('how useful a schedule has been: its runs and finds, what was opened, dismissed and left; mostly unwanted, it offers to be quieter', () => {
  const now = at('2026-05-10T12:00:00Z');
  const run = (status: ScheduleRun['status'], noOp = false, costUsd = 0.01): ScheduleRun => ({ id: Math.random().toString(36), scheduleId: 's', title: 't', by: 'schedule', startedAt: now - 3600_000, status, noOp, costUsd });
  const item = (id: string, status: InboxItem['status'], at: number, reason?: InboxItem['reason']): InboxItem => ({ id, kind: 'result', title: 't', body: 'b', at, level: 'info', status, ...(reason ? { reason } : {}) });
  const s = scheduleStats(
    [run('completed'), run('completed', true), run('failed'), run('skipped'), run('completed')],
    [item('a', 'read', now - 3 * 86_400_000), item('b', 'dismissed', now - 2 * 86_400_000, 'not_useful'), item('c', 'new', now - 2 * 86_400_000), item('d', 'dismissed', now - 86_400_000 * 1.5, 'wrong'), item('e', 'new', now - 3600_000)],
    [{ at: now, itemId: 'a', kind: 'result', action: 'open', latencyMs: 1 }],
    now,
  );
  assert.deepEqual({ ...s, quieter: undefined }, { runs: 4, found: 2, failed: 1, skipped: 1, updates: 5, opened: 1, dismissed: 2, notUseful: 2, ignored: 1, costUsd: 0.05, quieter: undefined });
  assert.equal(s.quieter, '3 of its last 5 updates were dismissed as not useful or left unread');
  const fine = scheduleStats([run('completed')], [item('a', 'read', now), item('b', 'read', now), item('c', 'read', now), item('d', 'new', now)], [], now);
  assert.equal(fine.quieter, undefined);
  assert.equal(scheduleStats([], [item('a', 'dismissed', now, 'not_useful')], [], now).quieter, undefined, 'too little to judge by');
});

test('the API: the person\'s limits read and set (checked), a schedule\'s policy set and checked, and each schedule\'s usefulness', async () => {
  const data = await tempDir();
  const users = await new UserStore(data).load();
  const harness = await createHarness({ dataDir: data, search: null, memory: 'off' });
  harness.registry.setProviderInstance('deepseek', new FakeProvider([{ text: 'Found a bug.' }, { text: 'Found another.' }]));
  const work = await tempDir();
  const { server } = createApp({ harness, token: 'op', loopback: true, localRoots: [work], uiDir: path.join(data, 'ui'), appRoot: data, users });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (token: string, method: string, p: string, body?: unknown) => {
    const res = await fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-harness': '1' } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    assert.deepEqual((await call('op', 'GET', '/api/inbox/settings')).body, {});
    assert.deepEqual((await call('op', 'PUT', '/api/inbox/settings', { quietFrom: '22:00', quietTo: '07:00', maxPerDay: 10, digestAt: '08:30' })).body, { quietFrom: '22:00', quietTo: '07:00', digestAt: '08:30', maxPerDay: 10 });
    assert.equal((await call('op', 'PUT', '/api/inbox/settings', { quietFrom: '9pm', quietTo: '7am' })).status, 400);
    const alice = (await call('op', 'POST', '/api/users', { name: 'alice' })).body as { token: string };
    assert.deepEqual((await call(alice.token, 'GET', '/api/inbox/settings')).body, {}, 'each person their own');
    const ns = { model: 'deepseek-flash', runtime: 'local', path: work, mode: 'bypass' };
    const made = await call('op', 'POST', '/api/schedules', { title: 'Bugs', prompt: 'find bugs', inMinutes: 30, newSession: ns, notify: 'important' });
    assert.equal(made.body.notify, 'important');
    assert.equal((await call('op', 'POST', '/api/schedules', { prompt: 'x', inMinutes: 30, newSession: ns, notify: 'loud' })).status, 400);
    assert.equal((await call('op', 'PATCH', `/api/schedules/${made.body.id}`, { notify: 'digest' })).body.notify, 'digest');
    assert.equal((await call('op', 'PATCH', `/api/schedules/${made.body.id}`, { notify: 'always' })).body.notify, undefined, 'always is the default');
    await call('op', 'POST', `/api/schedules/${made.body.id}/run`);
    await harness.scheduler!.settled();
    await call('op', 'POST', `/api/schedules/${made.body.id}/run`);
    await harness.scheduler!.settled();
    await until(() => harness.inbox.ofSchedule(made.body.id).length === 2, 'two updates');
    const [one, two] = harness.inbox.ofSchedule(made.body.id);
    await call('op', 'POST', `/api/inbox/${one!.id}`, { action: 'open' });
    await call('op', 'POST', `/api/inbox/${two!.id}`, { action: 'dismiss', reason: 'not_useful' });
    const stats = (await call('op', 'GET', '/api/schedules/stats')).body as Record<string, { runs: number; found: number; updates: number; opened: number; notUseful: number }>;
    assert.deepEqual([stats[made.body.id]!.runs, stats[made.body.id]!.found, stats[made.body.id]!.updates, stats[made.body.id]!.opened, stats[made.body.id]!.notUseful], [2, 2, 2, 1, 1]);
    assert.deepEqual((await call(alice.token, 'GET', '/api/schedules/stats')).body, {}, 'nobody else\'s');
  } finally { await new Promise<void>((r) => (server as http.Server).close(() => r())); await harness.close(); }
});
