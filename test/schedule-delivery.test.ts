import assert from 'node:assert/strict';
import type http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { createHarness } from '../src/kernel/harness.ts';
import type { HubEvent } from '../src/kernel/events.ts';
import { createApp } from '../src/server/app.ts';
import { SpendLedger, UserStore } from '../src/server/users.ts';
import { FakeProvider, tempDir } from './helpers.ts';

// Schedules from the person's side: what the desktop sends is accepted and runs where it says, the daily
// spend limit holds for unattended runs too, and what a scheduled agent tells the person reaches them.

async function serve(o: { dailyUsd?: number; replies?: number } = {}) {
  const data = await tempDir();
  const users = await new UserStore(data).load();
  const spend = await new SpendLedger(data, o.dailyUsd).load();
  const harness = await createHarness({ dataDir: data, search: null, memory: 'off' });
  harness.registry.setProviderInstance('deepseek', new FakeProvider(Array.from({ length: o.replies ?? 10 }, () => ({ text: 'ok' }))));
  const work = await tempDir();
  const { server } = createApp({ harness, token: 'op', loopback: true, localRoots: [work], uiDir: path.join(data, 'ui'), appRoot: data, users, spend });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (token: string, method: string, p: string, body?: unknown) => {
    const res = await fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-harness': '1' } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const close = async () => { await new Promise<void>((r) => (server as http.Server).close(() => r())); await harness.close(); };
  return { harness, users, spend, work, call, close };
}

const until = async (f: () => boolean, what: string, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 20)); }
};

test('the desktop\'s schedule form: what it sent before (no target) is refused; what it sends now runs in a new conversation in its folder, unattended', async () => {
  const t = await serve();
  try {
    // The old form sent only the title, prompt and time: the server has always needed a target.
    const old = await t.call('op', 'POST', '/api/schedules', { title: 'Morning', prompt: 'summarise', cron: '0 9 * * 1-5' });
    assert.equal(old.status, 400);
    assert.match(old.body.error, /goes to a session, or makes a new one/);
    // The form now: a new conversation each run, its model and folder, Don't ask.
    const made = await t.call('op', 'POST', '/api/schedules', { title: 'Morning', prompt: 'summarise the folder', inMinutes: 30, newSession: { model: 'deepseek-flash', runtime: 'local', path: t.work, mode: 'dontAsk' } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.deepEqual(made.body.newSession, { model: 'deepseek-flash', runtime: { kind: 'local', network: 'none', path: t.work }, mode: 'dontAsk' });
    const ran = await t.call('op', 'POST', `/api/schedules/${made.body.id}/run`);
    assert.equal(ran.body.lastResult, 'started');
    const s = t.harness.sessions.list().find((m) => m.title === 'Scheduled: Morning');
    assert.ok(s, 'a new conversation for the run');
    assert.equal(s!.runtime.path, t.work);
    assert.equal(s!.mode, 'dontAsk');
    const session = t.harness.sessions.get(s!.id)!;
    await until(() => session.status === 'idle' && session.history.length >= 2, 'the run');
    assert.match(JSON.stringify(session.history[0]), /Scheduled task \\"Morning\\", run 1\. Nobody is watching[\s\S]*?say what stopped you instead\.\)\\n\\nsummarise the folder/);
    // The same conversation each time: the run goes into it, and no new one is made.
    const target = await t.harness.sessions.create({ model: 'deepseek-flash', mode: 'default', runtime: { kind: 'local', network: 'none', path: t.work } });
    const same = await t.call('op', 'POST', '/api/schedules', { title: 'Into it', prompt: 'carry on', inMinutes: 30, sessionId: target.meta.id });
    assert.equal(same.status, 201);
    const before = t.harness.sessions.list().length;
    assert.equal((await t.call('op', 'POST', `/api/schedules/${same.body.id}/run`)).body.lastResult, 'started');
    await until(() => target.status === 'idle' && target.history.length >= 2, 'the run in the same conversation');
    assert.equal(t.harness.sessions.list().length, before);
    assert.match(JSON.stringify(target.history[0]), /carry on/);
  } finally { await t.close(); }
});

test('the daily spend limit holds for unattended work: a schedule, a trigger and a plugin-started run are not started over it', async () => {
  const t = await serve({ dailyUsd: 1 });
  try {
    const alice = (await t.call('op', 'POST', '/api/users', { name: 'alice' })).body as { id: string; token: string };
    const made = await t.call(alice.token, 'POST', '/api/schedules', { title: 'Nightly', prompt: 'check', cron: '0 2 * * *', newSession: { runtime: 'docker' } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const trig = await t.call(alice.token, 'POST', '/api/schedules', { title: 'On push', prompt: 'look', trigger: true, newSession: { runtime: 'docker' } });
    assert.equal(trig.status, 201);
    // Under the limit the gate says nothing about spend.
    assert.doesNotMatch(String(t.harness.bridge.mayRun?.(alice.id) ?? ''), /spend/);
    t.spend.add(alice.id, 1.5);
    const before = t.harness.sessions.list().length;
    const ran = await t.call(alice.token, 'POST', `/api/schedules/${made.body.id}/run`);
    assert.match(ran.body.lastResult, /^not run: Stopped: this account reached its daily spend limit of \$1\.00/);
    const fired = await fetch(String(trig.body.url), { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'pushed' });
    assert.ok(fired.status < 500);
    assert.match(t.harness.scheduler!.get(trig.body.id)!.lastResult ?? '', /daily spend limit/);
    assert.match(String(t.harness.bridge.mayRun?.(alice.id)), /daily spend limit/, 'a plugin starting a session for alice is refused too');
    assert.equal(t.harness.sessions.list().length, before, 'nothing was started');
    // Another account is not affected.
    const bob = (await t.call('op', 'POST', '/api/users', { name: 'bob' })).body as { id: string };
    assert.doesNotMatch(String(t.harness.bridge.mayRun?.(bob.id) ?? ''), /spend/);
  } finally { await t.close(); }
});

test('notify_user reaches the person outside the conversation: a notice on the event stream with the conversation\'s title; other info notices stay in it', async () => {
  const h = await createHarness({ dataDir: await tempDir(), search: null, memory: 'off' });
  h.registry.setProviderInstance('deepseek', new FakeProvider([
    { calls: [{ name: 'notify_user', input: { message: 'The deploy finished.' } }] },
    { text: 'done' },
  ]));
  const seen: HubEvent[] = [];
  const off = h.events.subscribe(0, (e) => { if (e.topic === 'notices') seen.push(e); });
  try {
    const s = await h.sessions.create({ title: 'Deploy watch', model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: await tempDir() }, owner: 'alice' });
    await s.send('tell me when it is done');
    await until(() => s.status === 'idle' && s.history.length >= 4, 'the turn');
    await until(() => seen.length > 0, 'the notice');
    assert.deepEqual(seen.map((e) => e.payload), [{ level: 'info', text: 'The agent says: The deploy finished.', sessionId: s.meta.id, notify: true, title: 'Deploy watch' }]);
    assert.deepEqual(seen[0]!.audience, { owner: 'alice' }, 'only its owner hears it');
    // An ordinary info notice (a progress note) is not pushed to the person.
    (s as unknown as { emit: (e: unknown) => void }).emit({ kind: 'notice', level: 'info', text: 'Compacted the context' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(seen.length, 1);
  } finally { off(); await h.close(); }
});
