import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import type http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { createHarness } from '../src/kernel/harness.ts';
import type { Provider, ProviderRequest, ProviderResponse } from '../src/providers/types.ts';
import { checkSandboxRuntime, DockerHost, dockerAvailable, imageExists, runtimeArgs, sandboxRuntime } from '../src/runtime/docker.ts';
import { createApp } from '../src/server/app.ts';
import { concurrencyLimits, concurrencyRefusal, UserStore } from '../src/server/users.ts';
import { tempDir } from './helpers.ts';

const hasDocker = (await dockerAvailable()) && (await imageExists('harness-sandbox:latest'));

/** A provider whose replies wait for the test to let them go: a turn that stays running. */
class GatedProvider implements Provider {
  private gates: (() => void)[] = [];
  started = 0;
  async send(req: ProviderRequest): Promise<ProviderResponse> {
    this.started++;
    await new Promise<void>((r) => this.gates.push(r));
    return { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], raw: { provider: 'deepseek', model: req.model.id, payload: { role: 'assistant', content: 'ok' } } }, stop: 'end', usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0 } };
  }
  release() { for (const g of this.gates.splice(0)) g(); }
}

test('per-account limits: the numbers, and who they count', () => {
  assert.deepEqual(concurrencyLimits({}), { running: 4, sandboxes: 8 });
  assert.deepEqual(concurrencyLimits({ HARNESS_USER_MAX_RUNNING: '2', HARNESS_USER_MAX_SANDBOXES: '0' }), { running: 2, sandboxes: 0 });
  assert.deepEqual(concurrencyLimits({ HARNESS_USER_MAX_RUNNING: 'lots' }), { running: 4, sandboxes: 8 });
  const s = [{ owner: 'a', busy: true, sandbox: true }, { owner: 'a', busy: false, sandbox: true }, { owner: 'b', busy: true, sandbox: false }];
  assert.match(concurrencyRefusal('running', 'a', s, { running: 1, sandboxes: 9 }) ?? '', /already has 1 session working.*HARNESS_USER_MAX_RUNNING/);
  assert.equal(concurrencyRefusal('running', 'a', s, { running: 2, sandboxes: 9 }), undefined);
  assert.match(concurrencyRefusal('sandboxes', 'a', s, { running: 9, sandboxes: 2 }) ?? '', /2 sandbox sessions.*HARNESS_USER_MAX_SANDBOXES/);
  assert.equal(concurrencyRefusal('sandboxes', 'a', s, { running: 9, sandboxes: 0 }), undefined, '0 is no limit');
  assert.equal(concurrencyRefusal('running', undefined, s, { running: 1, sandboxes: 1 }), undefined, 'the operator\'s own token is not limited');
});

test('per-account limits: a second running session, or one sandbox too many, is refused with 429 and why', async () => {
  const data = await tempDir();
  const users = await new UserStore(data).load();
  const harness = await createHarness({ dataDir: data, search: null });
  const gated = new GatedProvider();
  harness.registry.setProviderInstance('deepseek', gated);
  const work = await tempDir();
  const { server } = createApp({ harness, token: 'op', loopback: true, localRoots: [work], uiDir: path.join(data, 'ui'), appRoot: data, users, limits: { running: 1, sandboxes: 1 } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = (token: string, method: string, p: string, body?: unknown) => fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-harness': '1' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) as Record<string, unknown> }));
  try {
    const alice = await users.add('Alice');
    const mk = () => harness.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: work }, owner: alice.user.id });
    const [a, b] = [await mk(), await mk()];
    assert.equal((await call(alice.token, 'POST', `/api/sessions/${a.meta.id}/messages`, { text: 'one' })).status, 202);
    await new Promise((r) => setTimeout(r, 100));
    assert.notEqual(harness.sessions.statusOf(a.meta.id), 'idle');
    const refused = await call(alice.token, 'POST', `/api/sessions/${b.meta.id}/messages`, { text: 'two' });
    assert.equal(refused.status, 429);
    assert.match(String(refused.body.error), /already has 1 session working, the most it may run at once \(1, HARNESS_USER_MAX_RUNNING\)/);
    assert.equal((await call(alice.token, 'POST', `/api/sessions/${b.meta.id}/workflows`, { name: 'x' })).status, 429, 'a workflow start counts too');
    assert.equal((await call(alice.token, 'POST', `/api/sessions/${a.meta.id}/messages`, { text: 'more' })).status, 202, 'a message to the session already working joins its turn');
    // The operator's own sessions are not counted against anyone.
    const opSession = await harness.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: work } });
    assert.equal((await call('op', 'POST', `/api/sessions/${opSession.meta.id}/messages`, { text: 'hi' })).status, 202);
    // Let every waiting request through until Alice's first session is done (not a fixed wait: a loaded machine is slow).
    for (const t0 = Date.now(); harness.sessions.statusOf(a.meta.id) !== 'idle' && Date.now() - t0 < 20_000;) {
      gated.release();
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(harness.sessions.statusOf(a.meta.id), 'idle');
    assert.equal((await call(alice.token, 'POST', `/api/sessions/${b.meta.id}/messages`, { text: 'now' })).status, 202, 'once the first is done');
    gated.release();
    // Sandboxes: one Docker session is all Alice may keep.
    await harness.sessions.create({ model: 'deepseek-flash', runtime: { kind: 'docker', network: 'none' }, owner: alice.user.id });
    const second = await call(alice.token, 'POST', '/api/sessions', { runtime: 'docker', model: 'deepseek-flash' });
    assert.equal(second.status, 429);
    assert.match(String(second.body.error), /1 sandbox session, the most it may keep \(1, HARNESS_USER_MAX_SANDBOXES\)/);
  } finally {
    gated.release();
    await new Promise<void>((r) => (server as http.Server).close(() => r()));
    await harness.close();
  }
});

test('a stronger sandbox runtime (HARNESS_SANDBOX_RUNTIME): checked by name, refused clearly when Docker lacks it, passed as --runtime', { skip: !hasDocker && 'no Docker or sandbox image' }, async () => {
  assert.equal(sandboxRuntime({}), undefined);
  assert.equal(sandboxRuntime({ HARNESS_SANDBOX_RUNTIME: 'runsc' }), 'runsc');
  assert.throws(() => sandboxRuntime({ HARNESS_SANDBOX_RUNTIME: 'runsc --privileged' }), /not a runtime name/);
  assert.throws(() => sandboxRuntime({ HARNESS_SANDBOX_RUNTIME: '-v' }), /not a runtime name/);
  await assert.rejects(checkSandboxRuntime('harness-no-such-runtime'), /The sandbox runtime "harness-no-such-runtime" \(HARNESS_SANDBOX_RUNTIME\) is not installed in Docker; it has: .*runc/);
  assert.deepEqual(await runtimeArgs('runc'), ['--runtime', 'runc']);
  // A sandbox asked to use a missing runtime never starts (and never falls back to runc).
  const id = `rt${Date.now().toString(16)}`;
  const missing = new DockerHost(id, await tempDir(), { image: 'harness-sandbox:latest', network: 'none', memory: '256m', cpus: '1', runtime: 'harness-no-such-runtime' });
  await assert.rejects(missing.exec('echo hi', { timeoutMs: 30_000 }), /is not installed in Docker/);
  assert.notEqual(spawnSync('docker', ['inspect', `harness-${id}`]).status, 0, 'no container was made');
  // One Docker has: the container really runs under it.
  const id2 = `rt2${Date.now().toString(16)}`;
  const host = new DockerHost(id2, await tempDir(), { image: 'harness-sandbox:latest', network: 'none', memory: '256m', cpus: '1', runtime: 'runc' });
  try {
    const r = await host.exec('echo ran', { timeoutMs: 60_000 });
    assert.equal(r.stdout.trim(), 'ran', r.stderr);
    assert.equal(spawnSync('docker', ['inspect', '-f', '{{.HostConfig.Runtime}}', `harness-${id2}`], { encoding: 'utf8' }).stdout.trim(), 'runc');
  } finally { await host.close(); }
});
