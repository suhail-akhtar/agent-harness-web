import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHarness } from '../src/kernel/harness.ts';
import { LocalHost } from '../src/runtime/host.ts';
import { FakeProvider, tempDir } from './helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const wf = JSON.parse(await fs.readFile(path.join(here, '..', 'plugins', 'sdlc', 'workflows', 'long-task.json'), 'utf8'));
const feature = (id: string, passes = false) => ({ id, category: 'core', description: `feature ${id}`, steps: [`check ${id}`], passes });

test('long-task check: what is left, and a feature list changed beyond its passes fields is caught', async () => {
  const ws = await tempDir();
  const host = new LocalHost(ws);
  const check = (wf.nodes.check as { command: string }).command;
  const d = path.join(ws, '.harness', 'long-task');
  await fs.mkdir(d, { recursive: true });
  let r = await host.exec(check, { timeoutMs: 20_000 });
  assert.equal(r.code, 2);
  assert.match(r.stdout, /missing or not valid JSON/);
  const list = [feature('F01', true), feature('F02'), feature('F03')];
  await fs.writeFile(path.join(d, 'features.json'), JSON.stringify(list));
  await fs.writeFile(path.join(d, 'features.lock.json'), JSON.stringify(list.map((f) => ({ ...f, passes: false }))));
  r = await host.exec(check, { timeoutMs: 20_000 });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /1\/3 features pass\. Next: F02 - feature F02/);
  // Weakening a feature's steps to make it "pass" is refused.
  await fs.writeFile(path.join(d, 'features.json'), JSON.stringify([feature('F01', true), { ...feature('F02', true), steps: [] }, feature('F03')]));
  r = await host.exec(check, { timeoutMs: 20_000 });
  assert.equal(r.code, 3);
  assert.match(r.stdout, /changed beyond its passes fields/);
  await fs.writeFile(path.join(d, 'features.json'), JSON.stringify(list.map((f) => ({ ...f, passes: true }))));
  r = await host.exec(check, { timeoutMs: 20_000 });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /3\/3 features pass$/m);
});

test('long-task runs feature by feature in fresh contexts until every feature passes, then reviews', async () => {
  const ws = await tempDir();
  execFileSync('git', ['init', '-q', ws]);
  const h = await createHarness({ dataDir: await tempDir(), plugins: [path.join(here, '..', 'plugins', 'sdlc')], search: null, memory: 'off' });
  assert.ok(h.registry.workflows.has('long-task'));
  const fl = (a: boolean, b: boolean) => JSON.stringify([feature('F01', a), feature('F02', b)], null, 1);
  const fake = new FakeProvider([
    { calls: [{ name: 'write', input: { path: '.harness/long-task/features.json', content: fl(false, false) } }, { name: 'write', input: { path: 'init.sh', content: '#!/bin/sh\necho ok\n' } }, { name: 'write', input: { path: '.harness/long-task/progress.md', content: '# Goal\n## Log\n' } }] },
    { text: 'planned 2 features' },
    { calls: [{ name: 'read', input: { path: '.harness/long-task/features.json' } }] },
    { calls: [{ name: 'write', input: { path: '.harness/long-task/features.json', content: fl(true, false) } }] },
    { text: 'F01 done' },
    { calls: [{ name: 'read', input: { path: '.harness/long-task/features.json' } }] },
    { calls: [{ name: 'write', input: { path: '.harness/long-task/features.json', content: fl(true, true) } }] },
    { text: 'F02 done' },
    { text: 'Looks right.\nAPPROVE' },
  ]);
  h.registry.setProviderInstance('deepseek', fake);
  const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws } });
  const done = new Promise<void>((r) => s.subscribe(0, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
  await s.startWorkflow('long-task', { goal: 'two features' });
  await done;
  const [run] = await s.listRuns();
  assert.equal(run!.status, 'succeeded', JSON.stringify(run!.history.map((x) => `${x.node}:${x.outcome ?? x.status}`)));
  assert.deepEqual(run!.history.map((x) => `${x.node}:${x.outcome ?? x.status}`), [
    'init:done', 'lock:ok', 'check:fail', 'build:done', 'gates:pass', 'check:fail', 'build:done', 'gates:pass', 'check:ok', 'final-gates:pass', 'review:APPROVE', 'done:done',
  ]);
  // Each build ran in a fresh context that was told what is left.
  const builds = fake.snapshots.filter((x) => x.includes('One feature only'));
  assert.equal(builds.length >= 2, true);
  assert.match(builds[0]!, /0\/2 features pass\. Next: F01/);
  assert.ok(fake.snapshots.some((x) => x.includes('1/2 features pass. Next: F02') && !x.includes('planned 2 features')), 'the second build does not carry the first one\'s conversation');
  assert.match(execFileSync('git', ['-C', ws, 'log', '--format=%s']).toString(), /long-task: plan/);
  await h.close();
});

test('long-task stops for a person when three sessions in a row pass no feature', async () => {
  const ws = await tempDir();
  execFileSync('git', ['init', '-q', ws]);
  const h = await createHarness({ dataDir: await tempDir(), plugins: [path.join(here, '..', 'plugins', 'sdlc')], search: null, memory: 'off' });
  const fake = new FakeProvider([
    { calls: [{ name: 'write', input: { path: '.harness/long-task/features.json', content: JSON.stringify([feature('F01')]) } }] },
    { text: 'planned' },
    { text: 'could not do it' }, { text: 'could not do it' }, { text: 'could not do it' },
  ]);
  h.registry.setProviderInstance('deepseek', fake);
  const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws } });
  const done = new Promise<void>((r) => s.subscribe(0, ({ event }) => {
    if (event.kind === 'approval_request') s.respond(event.requestId, { decision: 'reject', feedback: 'stop' });
    if (event.kind === 'turn_end' && !event.agent) r();
  }));
  await s.startWorkflow('long-task', { goal: 'g' });
  await done;
  const [run] = await s.listRuns();
  assert.equal(run!.status, 'failed');
  const path_ = run!.history.map((x) => `${x.node}:${x.outcome ?? x.status}`);
  assert.equal(path_.filter((x) => x === 'build:done').length, 3, path_.join(' > '));
  assert.ok(path_.includes('check:exit-4') && path_.includes('stuck:reject'), path_.join(' > '));
  await h.close();
});


test('long-task: approving "stuck" retries at most three times, so an unattended run cannot loop forever', async () => {
  const ws = await tempDir();
  execFileSync('git', ['init', '-q', ws]);
  const h = await createHarness({ dataDir: await tempDir(), plugins: [path.join(here, '..', 'plugins', 'sdlc')], search: null, memory: 'off' });
  const fake = new FakeProvider([
    { calls: [{ name: 'write', input: { path: '.harness/long-task/features.json', content: JSON.stringify([feature('F01')]) } }] },
    { text: 'planned' },
    ...Array.from({ length: 12 }, () => ({ text: 'could not do it' })),
  ]);
  h.registry.setProviderInstance('deepseek', fake);
  const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws } });
  const done = new Promise<void>((r) => s.subscribe(0, ({ event }) => {
    if (event.kind === 'approval_request') s.respond(event.requestId, { decision: 'approve' }); // as the eval runner does
    if (event.kind === 'turn_end' && !event.agent) r();
  }));
  await s.startWorkflow('long-task', { goal: 'g' });
  await done;
  const [run] = await s.listRuns();
  const path_ = run!.history.map((x) => `${x.node}:${x.outcome ?? x.status}`);
  assert.equal(run!.status, 'failed', path_.join(' > '));
  assert.equal(path_.filter((x) => x === 'build:done').length, 12, path_.join(' > '));
  assert.equal(path_.filter((x) => x.startsWith('unstick:')).at(-1), 'unstick:fail');
});
