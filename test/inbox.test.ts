import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { InboxStore } from '../src/core/inbox.ts';
import { NOTHING_TO_REPORT } from '../src/core/schedule-runs.ts';
import { createHarness } from '../src/kernel/harness.ts';
import type { HubEvent } from '../src/kernel/events.ts';
import { createApp } from '../src/server/app.ts';
import { UserStore } from '../src/server/users.ts';
import { FakeProvider, tempDir } from './helpers.ts';

// Phase 2 of proactive work: the agent inbox. What unattended work leaves for the person (a run's
// result, what an agent told them, work an agent offered), read, snoozed or dismissed with a reason,
// every response written down; and a scheduled run that needs approval waits for the person in it
// (for a while, then the safe answer) instead of being refused.

const until = async (f: () => boolean | Promise<boolean>, what: string, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!(await f())) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 20)); }
};

test('the inbox store: items newest first, open and all, unread, read and unread again, snoozed out of sight until their time, dismissed with a reason; every response is in the feedback log', async () => {
  const dir = await tempDir();
  const inbox = await new InboxStore(dir).load();
  const seen: string[] = [];
  inbox.onChange = (type, i) => seen.push(`${type}:${i.title}:${i.status}`);
  const a = await inbox.add({ kind: 'result', owner: 'al', title: 'Nightly', body: 'green', at: 1000 });
  const b = await inbox.add({ kind: 'message', owner: 'al', title: 'Deploy', body: 'done', at: 2000 });
  await inbox.add({ kind: 'message', owner: 'bo', title: 'Not hers', body: 'x', at: 3000 });
  assert.deepEqual(inbox.list('al', { now: 5000 }).map((i) => i.title), ['Deploy', 'Nightly']);
  assert.equal(inbox.unread('al', 5000), 2);
  assert.equal((await inbox.act(a.id, 'read', { now: 6000 }))!.status, 'read');
  assert.equal(inbox.unread('al', 6000), 1);
  assert.equal((await inbox.act(a.id, 'unread', { now: 6500 }))!.status, 'new');
  await inbox.act(b.id, 'snooze', { until: 10_000, now: 7000 });
  assert.deepEqual(inbox.list('al', { now: 8000 }).map((i) => i.title), ['Nightly'], 'snoozed: out of sight');
  assert.deepEqual(inbox.list('al', { now: 11_000 }).map((i) => i.title), ['Deploy', 'Nightly'], 'and back at its time');
  await assert.rejects(inbox.act(b.id, 'snooze', { until: 5, now: 7000 }), /a time in the future/);
  await assert.rejects(inbox.act(a.id, 'dismiss', { reason: 'boring' }), /reason is one of not_useful, wrong, bad_timing, other/);
  const d = (await inbox.act(a.id, 'dismiss', { reason: 'not_useful', note: 'I check it myself', now: 9000 }))!;
  assert.deepEqual([d.status, d.reason, d.note, d.resolvedAt], ['dismissed', 'not_useful', 'I check it myself', 9000]);
  assert.deepEqual(inbox.list('al', { now: 11_000 }).map((i) => i.title), ['Deploy']);
  assert.deepEqual(inbox.list('al', { view: 'all', now: 11_000 }).map((i) => i.title), ['Deploy', 'Nightly']);
  assert.equal(await inbox.act('in_000000000000', 'read'), undefined);
  const log = await inbox.feedbackLog();
  assert.deepEqual(log.map((f) => [f.action, f.latencyMs]), [['read', 5000], ['unread', 5500], ['snooze', 5000], ['dismiss', 8000]]);
  assert.equal(log.at(-1)!.reason, 'not_useful');
  assert.ok(seen.includes('added:Nightly:new') && seen.includes('changed:Nightly:dismissed'));
  // Another server on the same folder sees the same inbox.
  const other = await new InboxStore(dir).load();
  assert.equal(other.get(a.id)!.status, 'dismissed');
  await other.add({ kind: 'result', owner: 'al', title: 'Weekly', body: 'ok', at: 10_500 });
  assert.equal(await other.readAll('al', 11_000), 1, 'only the new one (a snoozed item counts as seen)');
  await inbox.sync(true);
  assert.equal(inbox.unread('al', 11_000), 0);
});

test('the inbox keeps to its size, dropping first what the person is done with, then the oldest', async () => {
  process.env.HARNESS_INBOX_MAX = '3';
  try {
    const { InboxStore: Fresh } = await import(`../src/core/inbox.ts?max=${Date.now()}`) as typeof import('../src/core/inbox.ts');
    const inbox = await new Fresh(await tempDir()).load();
    const one = await inbox.add({ kind: 'message', owner: 'al', title: 'one', body: '', at: 1 });
    await inbox.add({ kind: 'message', owner: 'al', title: 'two', body: '', at: 2 });
    await inbox.add({ kind: 'message', owner: 'al', title: 'three', body: '', at: 3 });
    await inbox.act(one.id, 'dismiss');
    await inbox.add({ kind: 'message', owner: 'al', title: 'four', body: '', at: 4 });
    assert.deepEqual(inbox.list('al', { view: 'all' }).map((i) => i.title), ['four', 'three', 'two'], 'the dismissed one went, not the oldest new one');
    await inbox.add({ kind: 'message', owner: 'al', title: 'five', body: '', at: 5 });
    assert.deepEqual(inbox.list('al', { view: 'all' }).map((i) => i.title), ['five', 'four', 'three']);
  } finally { delete process.env.HARNESS_INBOX_MAX; }
});

async function harness(steps: ConstructorParameters<typeof FakeProvider>[0]) {
  const h = await createHarness({ dataDir: await tempDir(), search: null, memory: 'off' });
  const fake = new FakeProvider(steps);
  h.registry.setProviderInstance('deepseek', fake);
  const work = await tempDir();
  const events: HubEvent[] = [];
  const off = h.events.subscribe(0, (e) => { if (e.topic === 'inbox') events.push(e); });
  const ns = (mode: 'bypass' | 'dontAsk' | 'acceptEdits' | 'default' = 'bypass') => ({ model: 'deepseek-flash', runtime: { kind: 'local' as const, network: 'none' as const, path: work }, mode });
  return { h, fake, work, ns, events, close: async () => { off(); await h.close(); } };
}

test('a scheduled run that found something is a result in its owner\'s inbox; one that found nothing is not; a failed one is an error', async () => {
  const t = await harness([
    { text: 'The build is red: 3 tests fail in parser.ts.' },
    { text: `Nothing new. ${NOTHING_TO_REPORT}` },
  ]);
  try {
    const found = await t.h.scheduler!.create({ owner: 'al', title: 'Nightly', prompt: 'check', inMinutes: 5, newSession: t.ns() });
    await t.h.scheduler!.runNow(found.id);
    await t.h.scheduler!.settled();
    const quiet = await t.h.scheduler!.create({ owner: 'al', title: 'Quiet', prompt: 'check', inMinutes: 5, newSession: t.ns() });
    await t.h.scheduler!.runNow(quiet.id);
    await t.h.scheduler!.settled();
    await until(() => t.h.inbox.list('al').length >= 1, 'the result');
    await new Promise((r) => setTimeout(r, 100));
    const items = t.h.inbox.list('al');
    assert.equal(items.length, 1, 'nothing to report: no item');
    const [r] = items;
    assert.deepEqual([r!.kind, r!.title, r!.body, r!.level, r!.status, r!.scheduleId], ['result', 'Nightly', 'The build is red: 3 tests fail in parser.ts.', 'info', 'new', found.id]);
    const [run] = await t.h.scheduler!.runs.list({ scheduleId: found.id });
    assert.equal(r!.runId, run!.id);
    assert.equal(r!.sessionId, run!.sessionId);
    assert.deepEqual(t.events.map((e) => [(e.payload as { type: string }).type, e.audience]), [['added', { owner: 'al' }]]);
    // A run whose conversation is gone did not start: it is skipped, and a skipped run is not a result.
    const gone = await t.h.scheduler!.create({ owner: 'al', title: 'Gone', prompt: 'x', inMinutes: 5, sessionId: 'deadbeefdeadbeef' });
    await t.h.scheduler!.runNow(gone.id);
    assert.equal(t.h.inbox.list('al').length, 1);
  } finally { await t.close(); }
});

test('what an agent tells the person with notify_user is a message in their inbox, from any conversation; in a scheduled run it names the schedule', async () => {
  const t = await harness([
    { calls: [{ name: 'notify_user', input: { message: 'Disk is 95% full on web-1.' } }] }, { text: 'Told them.' },
    { calls: [{ name: 'notify_user', input: { message: 'Halfway through the migration.' } }] }, { text: 'Carrying on.' },
  ]);
  try {
    const s = await t.h.scheduler!.create({ owner: 'al', title: 'Disk watch', prompt: 'watch the disk', inMinutes: 5, newSession: t.ns() });
    await t.h.scheduler!.runNow(s.id);
    await t.h.scheduler!.settled();
    const chat = await t.h.sessions.create({ title: 'Migration', model: 'deepseek-flash', mode: 'bypass', runtime: t.ns().runtime, owner: 'al' });
    await chat.send('migrate the data');
    await until(() => chat.status === 'idle' && chat.history.length >= 4, 'the chat turn');
    await until(() => t.h.inbox.list('al').filter((i) => i.kind === 'message').length === 2, 'two messages');
    const msgs = t.h.inbox.list('al').filter((i) => i.kind === 'message');
    assert.deepEqual(msgs.map((m) => [m.title, m.body, m.scheduleId]), [['Migration', 'Halfway through the migration.', undefined], ['Scheduled: Disk watch', 'Disk is 95% full on web-1.', s.id]]);
    assert.equal(t.h.inbox.list('al').filter((i) => i.kind === 'result').length, 0, 'the run told them: its result is not a second item');
    assert.equal((await t.h.scheduler!.runs.list({ scheduleId: s.id }))[0]!.notified, true);
  } finally { await t.close(); }
});

test('work an agent offers while nobody is watching is a suggestion in the inbox: starting it marks it done, dismissing it with a reason declines the proposal; offers in a conversation the person is in stay there', async () => {
  const offer = (title: string) => ({ calls: [{ name: 'start_session', input: { title, prompt: `Do: ${title}`, context: 'fresh', initiation: 'own_initiative', share_workspace: true } }] });
  const t = await harness([offer('Fix the flaky test'), { text: 'Offered a fix.' }, offer('Bump the deps'), { text: 'Offered.' }, offer('Rename things'), { text: 'Offered in chat.' }, ...Array.from({ length: 4 }, () => ({ text: 'ok' }))]);
  try {
    const s = await t.h.scheduler!.create({ owner: 'al', title: 'Triage', prompt: 'triage the repo', cron: '0 6 * * *', newSession: t.ns() });
    await t.h.scheduler!.runNow(s.id);
    await t.h.scheduler!.settled();
    await t.h.scheduler!.runNow(s.id);
    await t.h.scheduler!.settled();
    await until(() => t.h.inbox.list('al').filter((i) => i.kind === 'suggestion').length === 2, 'two suggestions');
    const [bump, fix] = t.h.inbox.list('al').filter((i) => i.kind === 'suggestion');
    assert.equal(fix!.title, 'Fix the flaky test');
    assert.equal(fix!.body, 'Do: Fix the flaky test');
    assert.ok(fix!.proposalId?.startsWith('prop_'));
    assert.equal(fix!.scheduleId, s.id);
    // In a conversation the person is in (as the desktop's), the card is enough: a proposal, no inbox item.
    const chat = await t.h.sessions.create({ title: 'Chat', model: 'deepseek-flash', mode: 'bypass', runtime: t.ns().runtime, owner: 'al', client: { kind: 'desktop', version: '1', renderers: [], tools: [] } });
    await chat.send('anything to rename?');
    await until(() => chat.status === 'idle' && chat.history.length >= 4, 'the chat turn');
    await new Promise((r) => setTimeout(r, 100));
    const inChat = await t.h.sessions.linked.proposals(chat.meta.id);
    assert.deepEqual(inChat.map((p) => p.title), ['Rename things'], 'the agent did offer it');
    assert.equal(t.h.inbox.list('al', { view: 'all' }).filter((i) => i.kind === 'suggestion').length, 2, 'no third suggestion');
    // Started from its card in the conversation (or anywhere): the item is done.
    await t.h.sessions.linked.startProposal(fix!.proposalId!);
    await until(() => t.h.inbox.get(fix!.id)!.status === 'done', 'done');
    assert.equal(t.h.inbox.list('al').some((i) => i.id === fix!.id), false, 'no longer open');
    // Declined in the conversation's card: the item is dismissed (no reason: it was not asked).
    await t.h.sessions.linked.dismiss(bump!.proposalId!);
    await until(() => t.h.inbox.get(bump!.id)!.status === 'dismissed', 'dismissed');
  } finally { await t.close(); }
});

test('a scheduled run that needs approval waits for the person (the request is in their inbox, the run is still running), and goes on when they answer; the record says it waited', async () => {
  const t = await harness([
    { calls: [{ name: 'bash', input: { command: 'node -e "console.log(1 + 1)"' } }] },
    { text: 'Deployed.' },
  ]);
  try {
    // Edits allowed, commands asked: the deploy command is asked about.
    const s = await t.h.scheduler!.create({ owner: 'al', title: 'Deploy', prompt: 'deploy', inMinutes: 5, newSession: t.ns('acceptEdits'), askTimeoutMinutes: 60 });
    assert.equal(s.askTimeoutMinutes, 60);
    await t.h.scheduler!.runNow(s.id);
    const [running] = await t.h.scheduler!.runs.list({ scheduleId: s.id });
    const session = t.h.sessions.get(running!.sessionId!)!;
    await until(() => session.status === 'waiting', 'waiting for the person');
    assert.equal(session.unattendedSchedule, s.id);
    const pending = session.pendingRequests();
    assert.equal(pending.length, 1);
    assert.equal((pending[0] as { kind: string }).kind, 'permission_request');
    assert.equal((await t.h.scheduler!.runs.list({ scheduleId: s.id }))[0]!.status, 'running', 'still running while it waits');
    session.respond((pending[0] as { requestId: string }).requestId, { decision: 'allow' });
    await t.h.scheduler!.settled();
    const [run] = await t.h.scheduler!.runs.list({ scheduleId: s.id });
    assert.equal(run!.status, 'completed');
    assert.equal(run!.waited, 1);
    assert.equal(run!.summary, 'Deployed.');
    assert.equal(session.unattendedSchedule, undefined, 'the next turn is the person\'s again');
    // In Don't ask the same command is refused at once, as before.
    t.fake.requests.length = 0;
  } finally { await t.close(); }
});

test('nobody answers: after the wait the request gets the safe answer (no), with a note, and the run goes on; a Don\'t ask session never waits', async () => {
  const t = await harness([
    { calls: [{ name: 'bash', input: { command: 'rm -rf build' } }] },
    { text: 'Could not clean the build: nobody approved it.' },
    { calls: [{ name: 'bash', input: { command: 'rm -rf build' } }] },
    { text: 'Refused at once.' },
  ]);
  try {
    const s = await t.h.sessions.create({ title: 'Cleaner', model: 'deepseek-flash', mode: 'acceptEdits', runtime: t.ns().runtime, owner: 'al' });
    s.beginUnattended({ scheduleId: 'aaaa', askTimeoutMs: 300 });
    const started = Date.now();
    await s.send('clean the build');
    await until(() => s.status === 'idle' && s.history.length >= 4, 'the turn', 15_000);
    assert.ok(Date.now() - started >= 280, 'it waited');
    const result = JSON.stringify(s.history[2]);
    assert.match(result, /Nobody answered within 0\.3 seconds|Nobody answered within 300 ms|Nobody answered within/);
    s.endUnattended();
    const dont = await t.h.sessions.create({ title: 'Never asks', model: 'deepseek-flash', mode: 'dontAsk', runtime: t.ns().runtime, owner: 'al' });
    dont.beginUnattended({ scheduleId: 'bbbb', askTimeoutMs: 60_000 });
    const t0 = Date.now();
    await dont.send('clean the build');
    await until(() => dont.status === 'idle' && dont.history.length >= 4, 'the dontAsk turn');
    assert.ok(Date.now() - t0 < 5000, 'no wait');
    assert.match(JSON.stringify(dont.history[2]), /dontAsk/);
  } finally { await t.close(); }
});

test('the inbox API: my items and unread count, read, snooze, dismiss with a reason (a suggestion\'s proposal is declined, once), read all; nobody else\'s; reasons and times are checked', async () => {
  const data = await tempDir();
  const users = await new UserStore(data).load();
  const harness = await createHarness({ dataDir: data, search: null, memory: 'off' });
  harness.registry.setProviderInstance('deepseek', new FakeProvider([
    { calls: [{ name: 'start_session', input: { title: 'Tidy imports', prompt: 'Tidy them', context: 'fresh', initiation: 'own_initiative' } }] }, { text: 'Offered.' },
  ]));
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
    const a1 = await harness.inbox.add({ kind: 'result', owner: alice.id, title: 'Nightly', body: 'green' });
    const a2 = await harness.inbox.add({ kind: 'message', owner: alice.id, title: 'Deploy', body: 'done' });
    // A suggestion of alice's from a scheduled run.
    const s = await harness.scheduler!.create({ owner: alice.id, title: 'Triage', prompt: 'triage', inMinutes: 5, newSession: { model: 'deepseek-flash', runtime: { kind: 'local', network: 'none', path: work }, mode: 'bypass' } });
    await harness.scheduler!.runNow(s.id);
    await harness.scheduler!.settled();
    await until(async () => harness.inbox.list(alice.id).some((i) => i.kind === 'suggestion') && (await harness.scheduler!.runs.list({ scheduleId: s.id }))[0]?.status === 'completed', 'the suggestion and the end of the run');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(harness.inbox.list(alice.id).some((i) => i.kind === 'result' && i.scheduleId === s.id), false, 'the run offered work: its result is not a second item');
    assert.equal((await harness.scheduler!.runs.list({ scheduleId: s.id }))[0]!.proposed, 1);
    const sug = harness.inbox.list(alice.id).find((i) => i.kind === 'suggestion')!;
    const mine = await call(alice.token, 'GET', '/api/inbox');
    assert.equal(mine.status, 200);
    assert.equal(mine.body.unread, 3, `two items and the suggestion: ${JSON.stringify(mine.body.items.map((i: { kind: string; status: string; title: string }) => [i.kind, i.status, i.title]))}`);
    assert.deepEqual((await call(bob.token, 'GET', '/api/inbox')).body, { items: [], unread: 0 });
    assert.equal((await call(bob.token, 'POST', `/api/inbox/${a1.id}`, { action: 'read' })).status, 404, 'someone else\'s');
    assert.equal((await call('op', 'POST', `/api/inbox/${a1.id}`, { action: 'read' })).status, 404, 'an administrator does not read it for her');
    assert.equal((await call(alice.token, 'POST', `/api/inbox/${a1.id}`, { action: 'read' })).body.status, 'read');
    assert.equal((await call(alice.token, 'POST', `/api/inbox/${a1.id}`, { action: 'explode' })).status, 400);
    assert.equal((await call(alice.token, 'POST', `/api/inbox/${a1.id}`, { action: 'snooze', until: 1 })).status, 400);
    assert.equal((await call(alice.token, 'POST', `/api/inbox/${a2.id}`, { action: 'snooze', until: Date.now() + 3600_000 })).body.snoozedUntil > Date.now(), true);
    assert.equal((await call(alice.token, 'GET', '/api/inbox')).body.items.some((i: { id: string }) => i.id === a2.id), false, 'snoozed');
    assert.equal((await call(alice.token, 'POST', `/api/inbox/${sug.id}`, { action: 'dismiss', reason: 'great' })).status, 400);
    const d = await call(alice.token, 'POST', `/api/inbox/${sug.id}`, { action: 'dismiss', reason: 'wrong', note: 'imports are fine' });
    assert.deepEqual([d.body.status, d.body.reason, d.body.note], ['dismissed', 'wrong', 'imports are fine']);
    await until(async () => (await harness.sessions.linked.proposal(sug.proposalId!))?.status === 'dismissed', 'the proposal declined');
    await new Promise((r) => setTimeout(r, 100));
    const fb = (await harness.inbox.feedbackLog()).filter((f) => f.itemId === sug.id);
    assert.deepEqual(fb.map((f) => [f.action, f.reason]), [['dismiss', 'wrong']], 'one response, with its reason');
    assert.equal(harness.inbox.get(sug.id)!.reason, 'wrong');
    const extra = await harness.inbox.add({ kind: 'message', owner: alice.id, title: 'Later', body: 'one more' });
    assert.equal((await call(alice.token, 'POST', '/api/inbox/read-all')).body.read, 1, 'the one new item');
    assert.equal(harness.inbox.get(extra.id)!.status, 'read');
    assert.equal((await call(alice.token, 'GET', '/api/inbox')).body.unread, 0);
    assert.equal((await call(alice.token, 'GET', '/api/inbox?view=all')).body.items.length, 4, 'the dismissed one too');
    assert.ok((await fs.stat(harness.inbox.feedbackFile)).size > 0);
  } finally { await new Promise<void>((r) => (server as http.Server).close(() => r())); await harness.close(); }
});
