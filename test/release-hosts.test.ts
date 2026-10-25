// A one-shot harness (evals, the CLI) stops its sessions' sandbox containers when it closes; seen live:
// every eval run that ran a command left its container running after the process ended.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { createHarness } from '../src/kernel/harness.ts';
import { FakeProvider, tempDir } from './helpers.ts';

const docker = (...a: string[]) => spawnSync('docker', a, { encoding: 'utf8', timeout: 60_000 });
const running = (name: string) => docker('ps', '--filter', `name=^/${name}$`, '--format', '{{.Names}}').stdout.trim() === name;

test('releaseHosts: closing the harness removes the sandbox container a session started', { timeout: 300_000 }, async (t) => {
  if (docker('image', 'inspect', 'harness-sandbox:latest').status !== 0) { t.skip('no Docker or no harness-sandbox image'); return; }
  const until = async (f: () => boolean, ms = 120_000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 100)); } };
  const fake = new FakeProvider([{ calls: [{ name: 'bash', input: { command: 'echo inside' } }] }, { text: 'done' }]);
  const h = await createHarness({ dataDir: await tempDir(), backgroundWork: false, scheduler: false, search: null, releaseHosts: true });
  let name = '';
  try {
    for (const id of h.registry.providers.keys()) h.registry.setProviderInstance(id, fake);
    const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: await tempDir(), sandbox: 'docker' } });
    name = `harness-${s.meta.id}`;
    await s.send('run it');
    await until(() => h.sessions.statusOf(s.meta.id) === 'idle' && fake.requests.length >= 2);
    assert.ok(running(name), 'the command ran in its container');
  } finally { await h.close(); }
  assert.equal(running(name), false, 'the container is gone after close');
});
