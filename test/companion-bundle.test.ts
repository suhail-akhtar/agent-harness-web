import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHarness } from '../src/kernel/harness.ts';
import { createApp } from '../src/server/app.ts';
import { SpendLedger, UserStore } from '../src/server/users.ts';
import { FakeProvider, results, tempDir } from './helpers.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the built companion (one file, as users download it) starts, connects to a server and runs the agent\'s commands', { timeout: 180_000 }, async () => {
  // The bundle as `npm run build` makes it: bundled CommonJS inside must find Node's own modules.
  execFileSync(process.execPath, [path.join(root, 'scripts', 'build.mjs')], { cwd: root, stdio: 'pipe' });
  const bundle = path.join(root, 'dist', 'companion.mjs');
  const usage = await new Promise<string>((r) => { const p = spawn(process.execPath, [bundle]); let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; }); p.on('exit', () => r(out)); });
  assert.match(usage, /usage: node harness-companion\.mjs/);
  assert.doesNotMatch(usage, /Dynamic require/);

  const data = await tempDir();
  const harness = await createHarness({ dataDir: data, search: null, memory: 'off', scheduler: false });
  harness.registry.setProviderInstance('deepseek', new FakeProvider([{ calls: [{ name: 'bash', input: { command: 'node -e "console.log(\'from-the-bundle\', process.platform)"' } }] }, { text: 'done' }]));
  const { server } = createApp({ harness, token: 'op', loopback: true, localRoots: [], uiDir: path.join(data, 'ui'), appRoot: data, users: await new UserStore(data).load(), spend: await new SpendLedger(data).load() });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { authorization: 'Bearer op', 'content-type': 'application/json', 'x-harness': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return r.json() as Promise<Record<string, unknown>>;
  };
  const folder = await tempDir();
  await fs.writeFile(path.join(folder, 'mine.txt'), 'on my computer');
  const c = await call('POST', '/api/companions', { name: 'test laptop' });
  const child = spawn(process.execPath, [bundle, '--server', base, '--token', String(c.token), '--dir', folder, '--sandbox', 'off'], { stdio: 'pipe' });
  let log = '';
  child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  try {
    for (let i = 0; i < 60; i++) {
      const list = await call('GET', '/api/companions') as unknown as { id: string; online?: boolean }[];
      if (list.find((x) => x.id === c.id)?.online) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const s = await call('POST', '/api/sessions', { model: 'deepseek-flash', mode: 'bypass', runtime: 'companion', companionId: c.id });
    const session = harness.sessions.get(String(s.id))!;
    const ended = new Promise<void>((r) => session.subscribe(0, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
    await call('POST', `/api/sessions/${s.id}/messages`, { text: 'run it' });
    await ended;
    const out = results(session.history[2])[0]!.content;
    assert.match(out, new RegExp(`from-the-bundle ${process.platform}`), `${out}\n--- companion log ---\n${log}`);
  } finally {
    child.kill();
    server.close();
    await harness.close();
  }
});

test('the built companion: its own policy command, and its lease - with the server gone mid-command it stops the command itself and takes no work', { timeout: 240_000 }, async () => {
  const bundle = path.join(root, 'dist', 'companion.mjs');
  try { await fs.access(bundle); } catch { execFileSync(process.execPath, [path.join(root, 'scripts', 'build.mjs')], { cwd: root, stdio: 'pipe' }); }
  const home = await tempDir();
  const policy = path.join(home, 'policy.json');
  // The machine's owner sets its policy with the companion itself (never the server).
  const set = execFileSync(process.execPath, [bundle, 'policy', '--policy', policy, '--swarm', 'on', '--kinds', 'read,edit,exec', '--max-jobs', '2', '--sandbox-required', 'off'], { encoding: 'utf8' });
  assert.match(set, /swarm work: allowed\n {2}kinds of tools for swarm agents: read, edit, exec\n {2}at most 2 swarm job/);
  assert.deepEqual(JSON.parse(await fs.readFile(policy, 'utf8')), { swarm: true, kinds: ['read', 'edit', 'exec'], maxJobs: 2, sandboxRequired: false });

  const data = await tempDir();
  const harness = await createHarness({ dataDir: data, search: null, memory: 'off', scheduler: false });
  harness.registry.setProviderInstance('deepseek', new FakeProvider([{ calls: [{ name: 'bash', input: { command: 'sleep 70; echo late > late.txt', timeout_ms: 300_000 } }] }, { text: 'done' }]));
  const { server } = createApp({ harness, token: 'op', loopback: true, localRoots: [], uiDir: path.join(data, 'ui'), appRoot: data, users: await new UserStore(data).load(), spend: await new SpendLedger(data).load() });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (method: string, p: string, body?: unknown) => (await fetch(base + p, { method, headers: { authorization: 'Bearer op', 'content-type': 'application/json', 'x-harness': '1' }, body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<Record<string, unknown>>;
  const folder = await tempDir();
  const c = await call('POST', '/api/companions', { name: 'leased' });
  const child = spawn(process.execPath, [bundle, '--server', base, '--token', String(c.token), '--dir', folder, '--sandbox', 'off', '--policy', policy, '--lease-seconds', '40'], { stdio: 'pipe' });
  let log = '';
  child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  try {
    for (let i = 0; i < 60; i++) {
      const list = await call('GET', '/api/companions') as unknown as { id: string; online?: boolean; info?: { policy?: { maxJobs?: number } } }[];
      const me = list.find((x) => x.id === c.id);
      if (me?.online) { assert.equal(me.info?.policy?.maxJobs, 2, 'the server shows what the machine allows'); break; }
      await new Promise((r) => setTimeout(r, 250));
    }
    const s = await call('POST', '/api/sessions', { model: 'deepseek-flash', mode: 'bypass', runtime: 'companion', companionId: c.id });
    await call('POST', `/api/sessions/${s.id}/messages`, { text: 'run it' });
    for (let i = 0; i < 80 && !/bash|sleep/.test(log); i++) await new Promise((r) => setTimeout(r, 250));
    // The server goes away mid-command, without a word (connections dropped).
    const t0 = Date.now();
    server.closeAllConnections(); server.close();
    for (let i = 0; i < 120 && !/no word from the server/.test(log); i++) await new Promise((r) => setTimeout(r, 1000));
    assert.match(log, /no word from the server for 40s: stopped everything running here/, log);
    const took = (Date.now() - t0) / 1000;
    assert.ok(took < 70, `stopped by the lease (${took.toFixed(0)}s), not by the command's end`);
    await new Promise((r) => setTimeout(r, 72_000 - (Date.now() - t0)));
    await assert.rejects(fs.access(path.join(folder, 'late.txt')), 'the command\'s processes were killed on the machine');
    const audit = (await fs.readFile(path.join(home, 'audit.log'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { kind: string; outcome: string });
    assert.ok(audit.some((e) => /^stopped: no word from the server/.test(e.outcome)), JSON.stringify(audit));
  } finally {
    child.kill();
    await harness.close();
  }
});
