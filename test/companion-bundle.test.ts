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
