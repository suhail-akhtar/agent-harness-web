import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { describeCron, describeSchedule, nextRuns } from '../src/core/scheduler.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { createApp } from '../src/server/app.ts';
import { UserStore } from '../src/server/users.ts';
import { FakeProvider, results, tempDir } from './helpers.ts';

// Setting proactive work up, for the person and by an agent: schedules in plain words with their next
// runs before they are made, an agent setting up a routine in new conversations (and trying it), and
// schedules that run a workflow (proactive agentic workflows).

const until = async (f: () => boolean | Promise<boolean>, what: string, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!(await f())) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 20)); }
};

test('a cron in plain words', () => {
  const cases: Array<[string, string]> = [
    ['0 9 * * 1-5', 'Every weekday at 09:00'],
    ['*/15 * * * *', 'Every 15 minutes'],
    ['30 18 * * 1,4', 'Every Monday and Thursday at 18:30'],
    ['0 8 1 * *', 'On the 1st of every month at 08:00'],
    ['0 * * * *', 'Every hour'],
    ['15 * * * *', 'Every hour at minute 15'],
    ['0 */6 * * *', 'Every 6 hours'],
    ['0 9,13,17 * * *', 'Every day at 09:00, 13:00 and 17:00'],
    ['0 10 * * 0,6', 'Every weekend day at 10:00'],
    ['0 12 25 12 *', 'Every December 25th at 12:00'],
    ['0 7 * 1-3 1', 'Every Monday in January, February and March at 07:00'],
    ['*/10 9-17 * * 1-5', 'Every weekday, every 10 minutes of hours 9 to 17'],
    ['0 0 1,15 * *', 'On the 1st and 15th of every month at 00:00'],
    ['0 6 22 * *', 'On the 22nd of every month at 06:00'],
  ];
  for (const [cron, words] of cases) assert.equal(describeCron(cron), words, cron);
  assert.throws(() => describeCron('every day'), /five fields/);
  assert.equal(describeSchedule({ cron: '0 9 * * 1-5', timeZone: 'Asia/Tokyo' }), 'Every weekday at 09:00 (Asia/Tokyo)');
  assert.equal(describeSchedule({ triggerHash: 'x' }), 'When its URL is called');
  const runs = nextRuns('0 9 * * *', 3, 'UTC', Date.parse('2026-05-01T10:00:00Z'));
  assert.deepEqual(runs.map((t) => new Date(t).toISOString()), ['2026-05-02T09:00:00.000Z', '2026-05-03T09:00:00.000Z', '2026-05-04T09:00:00.000Z']);
});

const WORKFLOW = { name: 'daily-report', description: 'Write the daily report', inputs: { topic: { description: 'What it is about', required: true } }, start: 'write', nodes: { write: { type: 'agent', prompt: 'Write the daily report on {{input.topic}}.', next: 'done' }, done: { type: 'end' } } };

test('an agent sets up a routine for the person: a new conversation each time, like its own, asking in the Inbox, in a time zone; it lists it, tries it now, and only it can delete it', async () => {
  const h = await createHarness({ dataDir: await tempDir(), search: null, memory: 'off' });
  const fake = new FakeProvider([
    { calls: [{ name: 'schedule', input: { action: 'create', prompt: 'Summarise what changed in this folder since yesterday.', cron: '0 9 * * 1-5', time_zone: 'Europe/Berlin', new_conversation: true, asks: 'inbox' } }] },
    { text: 'Set up: weekdays at 9 Berlin time.' },
    { calls: [{ name: 'schedule', input: { action: 'list' } }] },
    { text: 'Here it is.' },
    { text: 'Nothing changed. [nothing to report]' },
  ]);
  h.registry.setProviderInstance('deepseek', fake);
  const work = await tempDir();
  try {
    const s = await h.sessions.create({ title: 'Setup', model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: work }, owner: 'al' });
    await s.send('every weekday morning summarise what changed here');
    await until(() => s.status === 'idle' && s.history.length >= 4, 'the first turn');
    assert.match(results(s.history[2])[0]!.content, /^Scheduled [0-9a-f]+: Every weekday at 09:00 \(Europe\/Berlin\), next run .*, each time in a new conversation\. The user sees it on the Scheduled page and its results in their Inbox; run_now tries it\.$/);
    const [made] = h.scheduler!.list();
    assert.equal(made!.owner, 'al');
    assert.equal(made!.createdBy, s.meta.id);
    assert.equal(made!.sessionId, undefined);
    assert.deepEqual(made!.newSession, { model: 'deepseek-flash', runtime: { kind: 'local', network: 'none', path: work }, mode: 'acceptEdits' });
    assert.equal(made!.timeZone, 'Europe/Berlin');
    await s.send('show my schedules');
    await until(() => s.status === 'idle' && s.history.length >= 8, 'the list turn');
    assert.match(results(s.history[6])[0]!.content, new RegExp(`^${made!.id}: Every weekday at 09:00 \\(Europe/Berlin\\), next .*, a new conversation each time - Summarise what changed`));
    // Its first run (run_now's path is the next test's).
    await h.scheduler!.runNow(made!.id);
    await h.scheduler!.settled();
    const [run] = await h.scheduler!.runs.list({ scheduleId: made!.id });
    assert.equal(run!.status, 'completed');
    assert.equal(run!.noOp, true);
    assert.equal(h.sessions.get(run!.sessionId!)!.meta.title, 'Scheduled: Summarise what changed in this folder since yesterday.');
    // Another conversation of the person's does not see or delete it.
    const other = await h.sessions.create({ title: 'Other', model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: work }, owner: 'al' });
    fake.requests.length = 0;
    h.registry.setProviderInstance('deepseek', new FakeProvider([{ calls: [{ name: 'schedule', input: { action: 'delete', id: made!.id } }] }, { text: 'Could not.' }]));
    await other.send('delete that schedule');
    await until(() => other.status === 'idle' && other.history.length >= 4, 'the other turn');
    assert.match(results(other.history[2])[0]!.content, /^No schedule [0-9a-f]+ from this conversation\./);
    assert.ok(h.scheduler!.get(made!.id), 'still there');
  } finally { await h.close(); }
});

test('the schedule tool: run_now tries a routine it set up; a schedule that comes back to this conversation is not run now; a workflow by name', async () => {
  const h = await createHarness({ dataDir: await tempDir(), search: null, memory: 'off' });
  const work = await tempDir();
  await fs.mkdir(path.join(work, '.harness', 'workflows'), { recursive: true });
  await fs.writeFile(path.join(work, '.harness', 'workflows', 'daily-report.json'), JSON.stringify(WORKFLOW));
  h.registry.setProviderInstance('deepseek', new FakeProvider([
    { calls: [{ name: 'schedule', input: { action: 'create', workflow: 'daily-report', input: { topic: 'sales' }, cron: '0 18 * * *', new_conversation: true } }] },
    { text: 'Set.' },
    { calls: [{ name: 'schedule', input: { action: 'create', prompt: 'look again', in_minutes: 30 } }] },
    { text: 'Set here.' },
  ]));
  try {
    const s = await h.sessions.create({ title: 'Setup', model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: work }, owner: 'al' });
    await s.send('every evening write the daily report on sales');
    await until(() => s.status === 'idle' && s.history.length >= 4, 'the first turn');
    await s.send('and look again in half an hour');
    await until(() => s.status === 'idle' && s.history.length >= 8, 'the second turn');
    const wf = h.scheduler!.list().find((x) => x.workflow)!;
    assert.deepEqual(wf.workflow, { name: 'daily-report', input: { topic: 'sales' } });
    assert.equal(wf.prompt, 'Run the workflow daily-report');
    assert.equal(wf.newSession?.mode, 'auto', 'a checker decides, the rest waits: the default');
    const here = h.scheduler!.list().find((x) => x.sessionId === s.meta.id)!;
    // run_now: the tool's own check.
    const { scheduleTool } = await import('../src/tools/schedule.ts');
    h.registry.setProviderInstance('deepseek', new FakeProvider([{ text: 'Daily report on sales: revenue up 4%.' }]));
    const ctx = { services: { schedules: { runNow: async (id: string) => (id === wf.id ? h.scheduler!.runNow(id) : undefined), list: async () => [], create: async () => { throw new Error('x'); }, remove: async () => false } } } as never;
    const ok = await scheduleTool.run({ action: 'run_now', id: wf.id }, ctx);
    assert.match(ok.content, /^Started [0-9a-f]+ now \(started\)/);
    const no = await scheduleTool.run({ action: 'run_now', id: here.id }, ctx);
    assert.equal(no.is_error, true);
    await h.scheduler!.settled();
    const [run] = await h.scheduler!.runs.list({ scheduleId: wf.id });
    assert.equal(run!.status, 'completed');
    assert.equal(run!.summary, 'Daily report on sales: revenue up 4%.');
    const session = h.sessions.get(run!.sessionId!)!;
    const runs = await session.listRuns();
    assert.equal(runs[0]!.workflow, 'daily-report');
    assert.equal(runs[0]!.status, 'succeeded');
  } finally { await h.close(); }
});

test('a workflow schedule through the API: the workflows a folder offers, made, run, written down; a broken workflow name fails the run and says why; the preview says when in words and the next runs, or why not', async () => {
  const data = await tempDir();
  const users = await new UserStore(data).load();
  const harness = await createHarness({ dataDir: data, search: null, memory: 'off' });
  const fake = new FakeProvider([{ text: 'Report written: 3 open incidents.' }]);
  harness.registry.setProviderInstance('deepseek', fake);
  const work = await tempDir();
  await fs.mkdir(path.join(work, '.harness', 'workflows'), { recursive: true });
  await fs.writeFile(path.join(work, '.harness', 'workflows', 'daily-report.json'), JSON.stringify(WORKFLOW));
  await fs.writeFile(path.join(work, '.harness', 'workflows', 'deploy.json'), JSON.stringify({ name: 'deploy', description: 'shell', start: 'sh', nodes: { sh: { type: 'shell', command: 'echo hi', next: 'done' }, done: { type: 'end' } } }));
  const { server } = createApp({ harness, token: 'op', loopback: true, localRoots: [work], uiDir: path.join(data, 'ui'), appRoot: data, users });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (token: string, method: string, p: string, body?: unknown) => {
    const res = await fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-harness': '1' } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    const wfs = await call('op', 'GET', `/api/workflows?path=${encodeURIComponent(work)}`);
    assert.equal(wfs.status, 200);
    const names = (wfs.body as Array<{ name: string; inputs: Record<string, unknown> }>).map((w) => w.name);
    assert.ok(names.includes('daily-report'));
    assert.ok(!names.includes('deploy'), 'a project workflow with shell steps is not offered');
    assert.deepEqual((wfs.body as Array<{ name: string; inputs: Record<string, unknown> }>).find((w) => w.name === 'daily-report')!.inputs, WORKFLOW.inputs);
    assert.equal((await call('op', 'GET', `/api/workflows?path=${encodeURIComponent(path.dirname(work))}`)).status, 400, 'only folders under HARNESS_LOCAL_ROOTS');
    const ns = { model: 'deepseek-flash', runtime: 'local', path: work, mode: 'dontAsk' };
    const made = await call('op', 'POST', '/api/schedules', { title: 'Daily report', cron: '0 18 * * *', timeZone: 'UTC', workflow: { name: 'daily-report', input: { topic: 'incidents' } }, newSession: ns });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.when, 'Every day at 18:00 (UTC)');
    assert.equal(made.body.upcoming.length, 3);
    assert.equal(made.body.prompt, 'Run the workflow daily-report');
    const listed = (await call('op', 'GET', '/api/schedules')).body as Array<{ id: string; when: string; workflow: { name: string } }>;
    assert.equal(listed.find((x) => x.id === made.body.id)!.workflow.name, 'daily-report');
    await call('op', 'POST', `/api/schedules/${made.body.id}/run`);
    await harness.scheduler!.settled();
    const [run] = (await call('op', 'GET', `/api/schedules/${made.body.id}/runs`)).body as Array<{ status: string; summary: string; sessionId: string }>;
    assert.deepEqual([run!.status, run!.summary], ['completed', 'Report written: 3 open incidents.']);
    assert.ok(fake.snapshots.some((x) => x.includes('Write the daily report on incidents.')), 'its agent step got its input');
    assert.equal((await harness.sessions.get(run!.sessionId)!.listRuns())[0]!.workflow, 'daily-report');
    // A name that is not a workflow there: the run fails with why.
    const bad = await call('op', 'POST', '/api/schedules', { cron: '0 18 * * *', workflow: { name: 'nope' }, newSession: ns });
    assert.equal(bad.status, 201);
    await call('op', 'POST', `/api/schedules/${bad.body.id}/run`);
    const [fail] = (await call('op', 'GET', `/api/schedules/${bad.body.id}/runs`)).body as Array<{ status: string; reason: string }>;
    assert.equal(fail!.status, 'failed');
    assert.match(fail!.reason, /No workflow named "nope"/);
    assert.equal((await call('op', 'POST', '/api/schedules', { cron: '0 18 * * *', workflow: { name: '../etc' }, newSession: ns })).status, 400);
    // The preview.
    const p1 = (await call('op', 'POST', '/api/schedules/preview', { cron: '0 9 * * 1-5', timeZone: 'Asia/Tokyo' })).body as { when: string; next: number[] };
    assert.equal(p1.when, 'Every weekday at 09:00 (Asia/Tokyo)');
    assert.equal(p1.next.length, 3);
    assert.ok(p1.next[0]! < p1.next[1]! && p1.next[1]! < p1.next[2]!);
    for (const t of p1.next) assert.equal(new Date(t).getUTCHours(), 0, '9:00 in Tokyo');
    assert.match((await call('op', 'POST', '/api/schedules/preview', { cron: '* * * * *' })).body.error, /at most every 5 minutes/);
    assert.match((await call('op', 'POST', '/api/schedules/preview', { cron: '0 9 * * *', timeZone: 'Moon/Base' })).body.error, /not a time zone/);
    assert.match((await call('op', 'POST', '/api/schedules/preview', { cron: 'soon' })).body.error, /five fields/);
    const once = (await call('op', 'POST', '/api/schedules/preview', { inMinutes: 90 })).body as { when: string; next: number[] };
    assert.ok(once.next[0]! > Date.now() + 89 * 60_000 && /^Once, /.test(once.when));
  } finally { await new Promise<void>((r) => (server as http.Server).close(() => r())); await harness.close(); }
});
