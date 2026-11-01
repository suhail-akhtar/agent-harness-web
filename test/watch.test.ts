import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { checkWatch, describeWatch, probeWatch, type WatchSpec } from '../src/core/watch.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { createApp } from '../src/server/app.ts';
import { UserStore } from '../src/server/users.ts';
import { FakeProvider, results, tempDir } from './helpers.ts';

// Phase 3 of proactive work: watches. A check with no model (a command's output, a folder's files, a
// branch's commits, a web page) every few minutes; a run only when what it watches changes - after it
// settles, and past a filter (a small model with no tools) if it has one - with what changed as data.

const MIN = 60_000;
const write = (dir: string, f: string, text: string) => fs.mkdir(path.dirname(path.join(dir, f)), { recursive: true }).then(() => fs.writeFile(path.join(dir, f), text));
const git = (dir: string, ...args: string[]) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });

test('a watch is checked when it is made: what it watches, how often, how long to settle, its filter', () => {
  assert.deepEqual(checkWatch({ kind: 'files', paths: ['src', 'docs/*.md'], everyMinutes: 10 }), { kind: 'files', everyMinutes: 10, paths: ['src', 'docs/*.md'] });
  assert.deepEqual(checkWatch({ kind: 'command', command: ' npm test ', settleSeconds: 60, onlyWhen: 'a test fails' }), { kind: 'command', everyMinutes: 5, settleSeconds: 60, onlyWhen: 'a test fails', command: 'npm test' });
  assert.throws(() => checkWatch({ kind: 'cron' }), /kind is one of command, files, git, url/);
  assert.throws(() => checkWatch({ kind: 'command' }), /needs the command/);
  assert.throws(() => checkWatch({ kind: 'files', paths: ['../secrets'] }), /inside the folder/);
  assert.throws(() => checkWatch({ kind: 'files', paths: ['C:/Windows'] }), /inside the folder/);
  assert.throws(() => checkWatch({ kind: 'url', url: 'ftp://x' }), /http\(s\) URL/);
  assert.throws(() => checkWatch({ kind: 'url', url: 'https://x.test', match: '(' }), /regular expression/);
  assert.throws(() => checkWatch({ kind: 'git', branch: 'main; rm -rf /' }), /branch name/);
  assert.throws(() => checkWatch({ kind: 'files', everyMinutes: 0 }), /from 1 to 1440/);
  assert.throws(() => checkWatch({ kind: 'files', settleSeconds: 99_999 }), /0 to 3600/);
  const d = (w: Record<string, unknown>) => describeWatch(checkWatch(w));
  assert.equal(d({ kind: 'command', command: 'npm test' }), 'When the output of `npm test` changes, checked every 5 minutes');
  assert.equal(d({ kind: 'files', everyMinutes: 1 }), 'When files in the folder change, checked every minute');
  assert.equal(d({ kind: 'files', paths: ['src'] }), 'When src change, checked every 5 minutes');
  assert.equal(d({ kind: 'files', paths: ['package.json'] }), 'When package.json changes, checked every 5 minutes');
  assert.equal(d({ kind: 'git', branch: 'main', everyMinutes: 15 }), 'On new commits to main, checked every 15 minutes');
  assert.equal(d({ kind: 'url', url: 'https://status.example.com', match: 'All systems \\w+' }), 'When https://status.example.com (what matches All systems \\w+) changes, checked every 5 minutes');
});

test('probes: a command\'s output and exit code; a folder\'s files (only the paths asked, not node_modules), added, changed, removed', async () => {
  const dir = await tempDir();
  await write(dir, 'state.txt', 'green');
  const cmd: WatchSpec = { kind: 'command', command: 'cat state.txt', everyMinutes: 5 };
  const a = await probeWatch(cmd, { folder: dir });
  assert.equal(a.change, undefined, 'the first look sets the baseline');
  assert.equal((await probeWatch(cmd, { folder: dir, prev: a })).change, undefined, 'nothing changed');
  await write(dir, 'state.txt', 'red: 2 failing');
  const b = await probeWatch(cmd, { folder: dir, prev: a });
  assert.match(b.change!, /The output of `cat state\.txt` changed\.\nBefore: exit code 0:\ngreen\nNow: exit code 0:\nred: 2 failing/);
  const failing = await probeWatch({ kind: 'command', command: 'cat missing.txt', everyMinutes: 5 }, { folder: dir, prev: b });
  assert.match(failing.change!, /Now: exit code [1-9]/);

  const files: WatchSpec = { kind: 'files', paths: ['src'], everyMinutes: 5 };
  await write(dir, 'src/a.ts', 'a');
  await write(dir, 'src/b.ts', 'b');
  await write(dir, 'node_modules/x/index.js', 'x');
  await write(dir, 'README.md', 'r');
  const f1 = await probeWatch(files, { folder: dir });
  assert.deepEqual(JSON.parse(f1.seen).map((e: string[]) => e[0]), ['src/a.ts', 'src/b.ts'], 'only src, not node_modules or README');
  await write(dir, 'README.md', 'changed outside the watched paths');
  await write(dir, 'node_modules/x/index.js', 'y');
  assert.equal((await probeWatch(files, { folder: dir, prev: f1 })).change, undefined);
  await new Promise((r) => setTimeout(r, 20));
  await write(dir, 'src/a.ts', 'a changed');
  await write(dir, 'src/c.ts', 'new');
  await fs.rm(path.join(dir, 'src', 'b.ts'));
  const f2 = await probeWatch(files, { folder: dir, prev: f1 });
  assert.equal(f2.change, 'Changed: src/a.ts\nAdded: src/c.ts\nRemoved: src/b.ts');
  const glob = await probeWatch({ kind: 'files', paths: ['**/*.md'], everyMinutes: 5 }, { folder: dir });
  assert.deepEqual(JSON.parse(glob.seen).map((e: string[]) => e[0]), ['README.md']);
});

test('probes: new commits on a branch, listed; a folder that is not a repository is an error; a page or an API, its status and body or just what matches', async (t) => {
  const repo = await tempDir();
  if (git(repo, 'init', '-q', '-b', 'main').status !== 0) { t.skip('git is not available'); return; }
  await write(repo, 'a.txt', '1');
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'first');
  const w: WatchSpec = { kind: 'git', branch: 'main', everyMinutes: 5 };
  const g1 = await probeWatch(w, { folder: repo });
  assert.equal(g1.change, undefined);
  await write(repo, 'a.txt', '2'); git(repo, 'commit', '-qam', 'fix the parser');
  await write(repo, 'a.txt', '3'); git(repo, 'commit', '-qam', 'add a test');
  const g2 = await probeWatch(w, { folder: repo, prev: g1 });
  assert.match(g2.change!, /^New commits on main:\n[0-9a-f]+ add a test\n[0-9a-f]+ fix the parser$/);
  await assert.rejects(probeWatch(w, { folder: await tempDir() }), /git: /);

  let body = '<h1>Status</h1><p>All systems operational</p><small>generated 1</small>';
  let status = 200;
  const server = http.createServer((_q, r) => { r.writeHead(status); r.end(body); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const fetchUrl = async (u: string, signal: AbortSignal) => { const res = await fetch(u, { signal }); return { status: res.status, body: await res.text() }; };
  try {
    const page: WatchSpec = { kind: 'url', url, match: 'All systems \\w+', everyMinutes: 5 };
    const p1 = await probeWatch(page, { fetchUrl });
    body = body.replace('generated 1', 'generated 2');
    assert.equal((await probeWatch(page, { prev: p1, fetchUrl })).change, undefined, 'only what matches is watched');
    body = body.replace('operational', 'degraded');
    const p2 = await probeWatch(page, { prev: p1, fetchUrl });
    assert.match(p2.change!, /Before: status 200: All systems operational\nNow: status 200: All systems degraded/);
    status = 503;
    assert.match((await probeWatch(page, { prev: p2, fetchUrl })).change!, /Now: status 503/);
    await assert.rejects(probeWatch({ kind: 'url', url, everyMinutes: 5 }, {}), /not available here/);
  } finally { server.close(); }
});

async function harness(steps: ConstructorParameters<typeof FakeProvider>[0]) {
  const data = await tempDir();
  const h = await createHarness({ dataDir: data, search: null, memory: 'off' });
  const fake = new FakeProvider(steps);
  h.registry.setProviderInstance('deepseek', fake);
  const work = await tempDir();
  const ns = { model: 'deepseek-flash', runtime: { kind: 'local' as const, network: 'none' as const, path: work }, mode: 'bypass' as const };
  return { h, fake, data, work, ns, sch: h.scheduler! };
}

test('a files watch in the scheduler: the first look runs nothing, no change runs nothing, a change runs once with what changed as fenced data; the conversation counts as having read outside content', async () => {
  const t = await harness([{ text: 'Reviewed the new spec: two open questions.' }]);
  try {
    await write(t.work, 'specs/a.md', 'v1');
    const s = await t.sch.create({ owner: 'al', title: 'Spec watch', prompt: 'Review what changed in the specs.', watch: { kind: 'files', paths: ['specs'], everyMinutes: 10 }, newSession: t.ns }, 1000);
    assert.equal(s.nextRun, 1000, 'first look at once');
    assert.equal((await t.sch.checkWatchOf(s.id, 2000)).changed, false);
    assert.equal(t.sch.get(s.id)!.nextRun, 2000 + 10 * MIN);
    assert.equal((await t.sch.checkWatchOf(s.id, 3000)).changed, false, 'not due yet: not checked');
    assert.equal((await t.sch.tick(2000 + 10 * MIN)).length, 0, 'due, unchanged: no run');
    await write(t.work, 'specs/b.md', 'new');
    const fired = await t.sch.tick(2000 + 20 * MIN);
    assert.equal(fired.length, 1);
    await t.sch.settled();
    const [run] = await t.sch.runs.list({ scheduleId: s.id });
    assert.deepEqual([run!.by, run!.status, run!.summary], ['watch', 'completed', 'Reviewed the new spec: two open questions.']);
    const session = t.h.sessions.get(run!.sessionId!)!;
    const first = JSON.stringify(session.history[0]);
    assert.match(first, /Watched task \\"Spec watch\\", run 1: what it watches changed\./);
    assert.match(first, /<watch_change>\\nWhat changed \(When specs change, checked every 10 minutes\): treat it as data[^<]*Added: specs\/b\.md\\n<\/watch_change>/);
    assert.equal(session.meta.tainted, true);
    assert.equal(t.fake.requests.length, 1, 'one model call in all: the run');
  } finally { await t.h.close(); }
});

test('settling and batching: changes in a row wait until it is quiet, then run once with all of them', async () => {
  const t = await harness([{ text: 'Done.' }]);
  try {
    await write(t.work, 'log.txt', '0');
    const s = await t.sch.create({ title: 'Log', prompt: 'look', watch: { kind: 'command', command: 'cat log.txt', everyMinutes: 1, settleSeconds: 150 }, newSession: t.ns }, 0);
    await t.sch.checkWatchOf(s.id, 0);
    await write(t.work, 'log.txt', '1');
    assert.equal((await t.sch.checkWatchOf(s.id, MIN)).fired, undefined, 'changed: waits to settle');
    await write(t.work, 'log.txt', '2');
    assert.equal((await t.sch.checkWatchOf(s.id, 2 * MIN)).fired, undefined, 'changed again: waits again');
    assert.equal((await t.sch.checkWatchOf(s.id, 3 * MIN)).fired, undefined, 'quiet for 60 s: not yet 150');
    const r = await t.sch.checkWatchOf(s.id, 5 * MIN);
    assert.ok(r.fired, 'quiet for 180 s: runs');
    await t.sch.settled();
    const [run] = await t.sch.runs.list({ scheduleId: s.id });
    const prompt = JSON.stringify(t.h.sessions.get(run!.sessionId!)!.history[0]);
    assert.match(prompt, /Before: exit code 0:\\n0\\nNow: exit code 0:\\n1[\s\S]*---[\s\S]*Before: exit code 0:\\n1\\nNow: exit code 0:\\n2/, 'both changes, in order');
    assert.equal((await t.sch.checkWatchOf(s.id, 6 * MIN)).fired, undefined, 'nothing new since: no run');
  } finally { await t.h.close(); }
});

test('a filter: a small model with no tools decides whether the change matters; "no" is a skipped run with why, "yes" runs; an unclear answer is no', async () => {
  const t = await harness([
    { text: '{"fire": false, "why": "Only a timestamp changed."}' },
    { text: '{"fire": true, "why": "A test now fails."}' },
    { text: 'Fixed the failing test.' },
    { text: 'I think maybe?' },
  ]);
  try {
    await write(t.work, 'out.txt', 'ok 12:00');
    const s = await t.sch.create({ title: 'Tests', prompt: 'fix what broke', watch: { kind: 'command', command: 'cat out.txt', everyMinutes: 5, onlyWhen: 'a test fails' }, newSession: t.ns }, 0);
    await t.sch.checkWatchOf(s.id, 0);
    await write(t.work, 'out.txt', 'ok 12:05');
    const no = await t.sch.checkWatchOf(s.id, 5 * MIN);
    assert.equal(no.fired, undefined);
    assert.match(no.note!, /^skipped: not "a test fails": Only a timestamp changed\.$/);
    const [skipped] = await t.sch.runs.list({ scheduleId: s.id });
    assert.deepEqual([skipped!.status, skipped!.by, skipped!.sessionId], ['skipped', 'watch', undefined]);
    assert.ok(skipped!.costUsd! > 0, 'what the filter cost');
    const req = t.fake.requests[0]!;
    assert.equal(req.tools.length, 0, 'the filter has no tools');
    assert.match(JSON.stringify(req.messages), /<condition>\\na test fails\\n<\/condition>/);
    await write(t.work, 'out.txt', 'FAIL parser.test.ts');
    const yes = await t.sch.checkWatchOf(s.id, 10 * MIN);
    assert.ok(yes.fired);
    await t.sch.settled();
    assert.equal((await t.sch.runs.list({ scheduleId: s.id }))[0]!.status, 'completed');
    await write(t.work, 'out.txt', 'FAIL again');
    const unclear = await t.sch.checkWatchOf(s.id, 15 * MIN);
    assert.match(unclear.note!, /the filter gave no clear answer/);
  } finally { await t.h.close(); }
});

test('a check that fails says why and runs nothing; a change while its conversation is busy waits for the next check; a run left for later is not lost', async () => {
  const t = await harness([{ text: 'one' }, { text: 'two' }]);
  try {
    const bad = await t.sch.create({ title: 'Repo', prompt: 'x', watch: { kind: 'git', everyMinutes: 5 }, newSession: t.ns }, 0);
    const r = await t.sch.checkWatchOf(bad.id, 0);
    assert.match(r.note!, /^the check failed: git: /);
    assert.match(t.sch.get(bad.id)!.watchState!.error!, /git: /);
    assert.equal((await t.sch.runs.list({ scheduleId: bad.id })).length, 0);
    // Into an existing conversation that is busy when the change comes.
    const target = await t.h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: t.ns.runtime });
    await write(t.work, 'f.txt', '1');
    const s = await t.sch.create({ title: 'F', prompt: 'look', watch: { kind: 'files', paths: ['f.txt'], everyMinutes: 1 }, sessionId: target.meta.id }, 0);
    await t.sch.checkWatchOf(s.id, 0);
    await write(t.work, 'f.txt', '22');
    (target as unknown as { setStatus: (x: string) => void }).setStatus('running');
    const busy = await t.sch.checkWatchOf(s.id, MIN);
    assert.equal(busy.fired?.lastResult, 'skipped: the session was busy');
    assert.equal(t.sch.get(s.id)!.watchState!.pending!.changes.length, 1, 'the change waits');
    (target as unknown as { setStatus: (x: string) => void }).setStatus('idle');
    const later = await t.sch.checkWatchOf(s.id, 2 * MIN);
    assert.equal(later.fired?.lastResult, 'started', 'runs at the next check, with no new change');
    await t.sch.settled();
    assert.match(JSON.stringify(target.history), /Changed: f\.txt/);
  } finally { await t.h.close(); }
});

test('watches survive a restart: what was seen is kept, and a change made while the server was down is run on at the first check after', async () => {
  const t = await harness([{ text: 'Saw the change.' }]);
  await write(t.work, 'notes.md', 'v1');
  const s = await t.sch.create({ title: 'Notes', prompt: 'summarise the change', watch: { kind: 'files', everyMinutes: 5 }, newSession: t.ns }, 0);
  await t.sch.checkWatchOf(s.id, 0);
  await t.h.close();
  await write(t.work, 'notes.md', 'v2 - edited while the server was down');
  const h2 = await createHarness({ dataDir: t.data, search: null, memory: 'off' });
  h2.registry.setProviderInstance('deepseek', new FakeProvider([{ text: 'Saw the change.' }]));
  try {
    assert.ok(h2.scheduler!.get(s.id)!.watchState!.hash, 'what it saw is kept');
    // The new server's own first tick may get there before this check: either way, one run, on the change.
    await h2.scheduler!.checkWatchOf(s.id, 10 * MIN);
    const end = Date.now() + 10_000;
    while ((await h2.scheduler!.runs.list({ scheduleId: s.id }))[0]?.status !== 'completed') { assert.ok(Date.now() < end, 'it ran'); await new Promise((r) => setTimeout(r, 50)); }
    const runs = await h2.scheduler!.runs.list({ scheduleId: s.id });
    assert.equal(runs.length, 1, 'once, not twice');
    assert.deepEqual([runs[0]!.by, runs[0]!.summary], ['watch', 'Saw the change.']);
  } finally { await h2.close(); }
});

test('the API: a watch made, shown in words without what it saw, checked now (a change runs), changed (a new first look); only on this computer, for administrators', async () => {
  const data = await tempDir();
  const users = await new UserStore(data).load();
  const harness = await createHarness({ dataDir: data, search: null, memory: 'off' });
  harness.registry.setProviderInstance('deepseek', new FakeProvider([{ text: 'Looked.' }]));
  const work = await tempDir();
  await write(work, 'doc.md', '1');
  const { server } = createApp({ harness, token: 'op', loopback: true, localRoots: [work], uiDir: path.join(data, 'ui'), appRoot: data, users });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (token: string, method: string, p: string, body?: unknown) => {
    const res = await fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-harness': '1' } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    const ns = { model: 'deepseek-flash', runtime: 'local', path: work, mode: 'bypass' };
    const made = await call('op', 'POST', '/api/schedules', { title: 'Docs', prompt: 'review the docs', watch: { kind: 'files', paths: ['doc.md'], everyMinutes: 15 }, newSession: ns });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.when, 'When doc.md changes, checked every 15 minutes');
    await new Promise((r) => setTimeout(r, 300));
    const listed = ((await call('op', 'GET', '/api/schedules')).body as Array<{ id: string; watchState?: Record<string, unknown> }>).find((x) => x.id === made.body.id)!;
    assert.equal(listed.watchState!.seen, true, 'it has had its first look');
    assert.equal(JSON.stringify(listed).includes('"hash"'), false, 'what it saw stays on the server');
    assert.equal((await call('op', 'POST', `/api/schedules/${made.body.id}/check`)).body.changed, false);
    await write(work, 'doc.md', '2');
    const checked = await call('op', 'POST', `/api/schedules/${made.body.id}/check`);
    assert.deepEqual([checked.body.changed, checked.body.ran], [true, true]);
    await harness.scheduler!.settled();
    assert.equal(((await call('op', 'GET', `/api/schedules/${made.body.id}/runs`)).body as Array<{ by: string }>)[0]!.by, 'watch');
    // Changing what it watches: a new first look.
    const changed = await call('op', 'PATCH', `/api/schedules/${made.body.id}`, { watch: { kind: 'files', paths: ['other'], everyMinutes: 5 } });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.watchState, undefined);
    assert.equal((await call('op', 'PATCH', `/api/schedules/${made.body.id}`, { cron: '0 9 * * *' })).status, 400, 'a watch has no time');
    assert.equal((await call('op', 'POST', '/api/schedules', { prompt: 'x', watch: { kind: 'files' }, cron: '0 9 * * *', newSession: ns })).status, 400);
    assert.equal((await call('op', 'POST', '/api/schedules', { prompt: 'x', watch: { kind: 'command', command: 'ls' }, newSession: { runtime: 'docker' } })).status, 400, 'a folder watch needs this computer');
    const alice = (await call('op', 'POST', '/api/users', { name: 'alice' })).body as { token: string };
    assert.equal((await call(alice.token, 'POST', '/api/schedules', { prompt: 'x', watch: { kind: 'command', command: 'ls' }, newSession: { runtime: 'docker' } })).status, 400);
    assert.equal((await call(alice.token, 'POST', '/api/schedules', { prompt: 'x', watch: { kind: 'url', url: 'https://example.com' }, newSession: { runtime: 'docker' } })).status, 201, 'a url watch needs no folder');
    assert.equal((await call('op', 'POST', `/api/schedules/${(await call('op', 'POST', '/api/schedules', { prompt: 'x', inMinutes: 5, newSession: ns })).body.id}/check`)).status, 400, 'only a watch is checked');
    const pv = (await call('op', 'POST', '/api/schedules/preview', { watch: { kind: 'git', branch: 'main', everyMinutes: 30 } })).body;
    assert.equal(pv.when, 'On new commits to main, checked every 30 minutes');
    assert.match((await call('op', 'POST', '/api/schedules/preview', { watch: { kind: 'url', url: 'nope' } })).body.error, /http\(s\) URL/);
  } finally { await new Promise<void>((r) => server.close(() => r())); await harness.close(); }
});

test('an agent sets up a watch for the person with the schedule tool', async () => {
  const h = await createHarness({ dataDir: await tempDir(), search: null, memory: 'off' });
  h.registry.setProviderInstance('deepseek', new FakeProvider([
    { calls: [{ name: 'schedule', input: { action: 'create', prompt: 'When the tests change, tell me which fail.', watch: { kind: 'command', command: 'npm test', everyMinutes: 30, onlyWhen: 'a test fails' }, new_conversation: true } }] },
    { text: 'Watching the tests.' },
  ]));
  const work = await tempDir();
  try {
    const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: work }, owner: 'al' });
    await s.send('tell me whenever tests start failing');
    const end = Date.now() + 10_000;
    while (!(s.status === 'idle' && s.history.length >= 4)) { assert.ok(Date.now() < end); await new Promise((r) => setTimeout(r, 20)); }
    assert.match(results(s.history[2])[0]!.content, /^Watching [0-9a-f]+: When the output of `npm test` changes, checked every 30 minutes, each change run in a new conversation\./);
    const [w] = h.scheduler!.list();
    assert.deepEqual(w!.watch, { kind: 'command', everyMinutes: 30, onlyWhen: 'a test fails', command: 'npm test' });
    assert.equal(w!.newSession!.runtime.path, work);
  } finally { await h.close(); }
});

test('two checks of one watch at once (Check now while its timer fires) run it once', async () => {
  const t = await harness([{ text: 'once' }, { text: 'twice' }]);
  try {
    await write(t.work, 'x.txt', '1');
    const s = await t.sch.create({ title: 'X', prompt: 'look', watch: { kind: 'files', everyMinutes: 1 }, newSession: t.ns }, 0);
    await t.sch.checkWatchOf(s.id, 0);
    await write(t.work, 'x.txt', '22');
    // Check now while the timer's check runs: it waits for that check and says what it found.
    const [a, b] = await Promise.all([t.sch.checkWatchOf(s.id, MIN), t.sch.checkWatchOf(s.id, MIN, true)]);
    assert.ok(a.fired && b.fired && a === b, 'the same check, the same answer');
    // The timer while another check runs: skips.
    const slow = t.sch.checkWatchOf(s.id, 3 * MIN, true);
    assert.match(String((await t.sch.checkWatchOf(s.id, 3 * MIN)).note), /already running/);
    await slow;
    await t.sch.settled();
    assert.equal((await t.sch.runs.list({ scheduleId: s.id })).length, 1);
  } finally { await t.h.close(); }
});
