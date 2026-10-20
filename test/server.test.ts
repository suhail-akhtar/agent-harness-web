import assert from 'node:assert/strict';
import type http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { createHarness } from '../src/kernel/harness.ts';
import { createApp } from '../src/server/app.ts';
import { RateLimiter, SpendLedger, UserStore } from '../src/server/users.ts';
import { FakeProvider, tempDir } from './helpers.ts';

const OPERATOR = 'operator-token-for-tests';

async function setup(opts: { messageRateLimit?: number; dailyCap?: number } = {}) {
  const data = await tempDir();
  const users = await new UserStore(data).load();
  const spend = await new SpendLedger(data, opts.dailyCap).load();
  const harness = await createHarness({ dataDir: data, search: null, spend });
  const fake = new FakeProvider(Array.from({ length: 20 }, () => ({ text: 'ok' })));
  harness.registry.setProviderInstance('deepseek', fake);
  const work = await tempDir();
  const { server } = createApp({ harness, token: OPERATOR, loopback: true, localRoots: [work], uiDir: path.join(data, 'ui'), appRoot: data, users, spend, messageRateLimit: opts.messageRateLimit });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (token: string | undefined, method: string, p: string, body?: unknown) => {
    const res = await fetch(base + p, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-harness': '1' } : {}) }, body: body === undefined ? (method !== 'GET' ? '{}' : undefined) : JSON.stringify(body) });
    const text = await res.text();
    let json: unknown; try { json = JSON.parse(text); } catch { json = text; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: json as any, headers: res.headers };
  };
  const close = async () => { await new Promise<void>((r) => (server as http.Server).close(() => r())); await harness.close(); };
  return { harness, users, spend, call, work, close, fake };
}

test('accounts: tokens, roles, and members kept to what they own', async () => {
  const t = await setup();
  assert.equal((await t.call(undefined, 'GET', '/api/sessions')).status, 401);
  assert.equal((await t.call('hwu_nonsense', 'GET', '/api/sessions')).status, 401);
  assert.equal((await t.call(OPERATOR, 'GET', '/api/me')).body.role, 'admin');

  // The operator creates accounts; the token is shown once.
  const alice = (await t.call(OPERATOR, 'POST', '/api/users', { name: 'Alice' })).body as { id: string; token: string; role: string };
  const bob = (await t.call(OPERATOR, 'POST', '/api/users', { name: 'Bob' })).body as { id: string; token: string };
  assert.equal(alice.role, 'member');
  assert.match(alice.token, /^hwu_/);
  assert.equal((await t.call(OPERATOR, 'POST', '/api/users', { name: 'alice' })).status, 409, 'names are unique');
  assert.ok(!JSON.stringify((await t.call(OPERATOR, 'GET', '/api/users')).body).includes('tokenHash'));
  assert.equal((await t.call(alice.token, 'GET', '/api/users')).status, 403, 'members cannot manage accounts');
  assert.equal((await t.call(alice.token, 'GET', '/api/me')).body.name, 'Alice');

  // Sessions belong to whoever made them.
  const sa = await t.harness.sessions.create({ model: 'deepseek-flash', runtime: { kind: 'local', network: 'none', path: t.work }, owner: alice.id });
  const sb = await t.harness.sessions.create({ model: 'deepseek-flash', runtime: { kind: 'local', network: 'none', path: t.work }, owner: bob.id });
  const ids = (tok: string) => t.call(tok, 'GET', '/api/sessions').then((r) => (r.body as { id: string }[]).map((s) => s.id).sort());
  assert.deepEqual(await ids(alice.token), [sa.meta.id]);
  assert.deepEqual(await ids(OPERATOR), [sa.meta.id, sb.meta.id].sort());
  assert.equal((await t.call(alice.token, 'GET', `/api/sessions/${sb.meta.id}`)).status, 404, "someone else's session reads as missing");
  assert.equal((await t.call(alice.token, 'POST', `/api/sessions/${sb.meta.id}/messages`, { text: 'hi' })).status, 404);
  assert.equal((await t.call(alice.token, 'DELETE', `/api/sessions/${sb.meta.id}`)).status, 404);
  assert.equal((await t.call(alice.token, 'GET', `/api/sessions/${sa.meta.id}`)).status, 200);

  // Members may not run commands on the server itself, or install code.
  const local = await t.call(alice.token, 'POST', '/api/sessions', { runtime: 'local', path: t.work, model: 'deepseek-flash' });
  assert.equal(local.status, 403);
  assert.equal((await t.call(alice.token, 'GET', '/api/config')).body.runtimes && ((await t.call(alice.token, 'GET', '/api/config')).body.runtimes as { local: boolean }).local, false);
  assert.equal((await t.call(alice.token, 'POST', '/api/plugins/install', { name: 'x' })).status, 403);
  const made = await t.call(OPERATOR, 'POST', '/api/sessions', { runtime: 'local', path: t.work, model: 'deepseek-flash' });
  assert.equal(made.status, 201);

  // Companions too.
  const cmp = (await t.call(alice.token, 'POST', '/api/companions', { name: 'laptop' })).body as { id: string };
  assert.deepEqual(((await t.call(bob.token, 'GET', '/api/companions')).body as unknown[]).length, 0);
  assert.equal((await t.call(bob.token, 'POST', '/api/sessions', { runtime: 'companion', companionId: cmp.id, model: 'deepseek-flash' })).status, 400);
  assert.equal((await t.call(bob.token, 'DELETE', `/api/companions/${cmp.id}`)).status, 404);
  assert.equal((await t.call(alice.token, 'POST', '/api/sessions', { runtime: 'companion', companionId: cmp.id, model: 'deepseek-flash' })).status, 201);

  // A rotated token replaces the old one; a disabled account is refused.
  const rotated = (await t.call(OPERATOR, 'POST', `/api/users/${bob.id}/rotate`)).body.token as string;
  assert.equal((await t.call(bob.token, 'GET', '/api/me')).status, 401);
  assert.equal((await t.call(rotated, 'GET', '/api/me')).status, 200);
  await t.call(OPERATOR, 'POST', `/api/users/${bob.id}/disable`);
  assert.equal((await t.call(rotated, 'GET', '/api/me')).status, 401);

  await t.close();
});

test('rate limits: messages per minute per person, with Retry-After', async () => {
  const t = await setup({ messageRateLimit: 2 });
  const s = (await t.call(OPERATOR, 'POST', '/api/sessions', { runtime: 'local', path: t.work, model: 'deepseek-flash' })).body as { id: string };
  const send = () => t.call(OPERATOR, 'POST', `/api/sessions/${s.id}/messages`, { text: 'hello' });
  assert.equal((await send()).status, 202);
  assert.equal((await send()).status, 202);
  const third = await send();
  assert.equal(third.status, 429);
  assert.ok(Number(third.headers.get('retry-after')) >= 1);
  // The bucket refills evenly.
  const l = new RateLimiter(60);
  for (let i = 0; i < 60; i++) assert.equal(l.take('k', 0).ok, true);
  assert.equal(l.take('k', 0).ok, false);
  assert.equal(l.take('k', 1000).ok, true, 'one more after a second at 60/min');
  assert.equal(new RateLimiter(0).take('k').ok, true, '0 = no limit');
  await t.close();
});

test('a daily spend cap per account stops new messages and running turns', async () => {
  const t = await setup({ dailyCap: 0.01 });
  const alice = await t.users.add('Alice');
  const s = await t.harness.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: t.work }, owner: alice.user.id });
  t.spend.add(alice.user.id, 0.02);
  const r = await t.call(alice.token, 'POST', `/api/sessions/${s.meta.id}/messages`, { text: 'hi' });
  assert.equal(r.status, 429);
  assert.match(String(r.body.error), /daily spend limit of \$0\.01/);
  // A turn already running stops at its next step.
  const ended = new Promise<string>((res) => s.subscribe(0, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) res(event.reason); }));
  await s.send('go');
  assert.equal(await ended, 'budget');
  // Usage is recorded against the owner.
  const t2 = await setup();
  const carol = await t2.users.add('Carol');
  const s2 = await t2.harness.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: t2.work }, owner: carol.user.id });
  const done = new Promise<void>((res) => s2.subscribe(0, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) res(); }));
  await s2.send('hello');
  await done;
  assert.ok(t2.spend.spentToday(carol.user.id) > 0);
  assert.equal(t2.spend.spentToday(undefined), 0);
  await t.close();
  await t2.close();
});

test('memory API: the owner reads, edits and deletes what the agent remembers; guarded like the tool', async () => {
  const t = await setup();
  const alice = await t.users.add('Alice');
  const bob = await t.users.add('Bob');
  const s = await t.harness.sessions.create({ model: 'deepseek-flash', runtime: { kind: 'local', network: 'none', path: t.work }, owner: alice.user.id });
  const q = (p: string) => `/api/memory/file?session=${s.meta.id}&path=${encodeURIComponent(p)}`;
  assert.equal((await t.call(alice.token, 'PUT', q('/memories/user/prefs.md'), { content: 'Prefers short answers.' })).status, 200);
  assert.equal((await t.call(alice.token, 'GET', q('/memories/user/prefs.md'))).body.content, 'Prefers short answers.');
  const list = (await t.call(alice.token, 'GET', `/api/memory?session=${s.meta.id}`)).body as { files: { path: string }[]; changes: { session: string }[]; scopes: { scope: string }[] };
  assert.deepEqual(list.files.map((f) => f.path), ['/memories/user/prefs.md']);
  assert.equal(list.changes[0]!.session, 'user:Alice');
  assert.deepEqual(list.scopes.map((x) => x.scope), ['user', 'project']);
  assert.equal((await t.call(alice.token, 'PUT', q('/memories/user/key.md'), { content: `aws AKIA${'A'.repeat(16)}` })).status, 400);
  assert.equal((await t.call(alice.token, 'PUT', q('/memories/../../etc/x'), { content: 'x' })).status, 400);
  assert.equal((await t.call(bob.token, 'GET', q('/memories/user/prefs.md'))).status, 404, "another person's memory is not reachable");
  assert.equal((await t.call(alice.token, 'DELETE', q('/memories/user/prefs.md'))).status, 200);
  assert.equal(((await t.call(alice.token, 'GET', `/api/memory?session=${s.meta.id}`)).body as { files: unknown[] }).files.length, 0);
  // Each account has its own user memory.
  const sb = await t.harness.sessions.create({ model: 'deepseek-flash', runtime: { kind: 'local', network: 'none', path: t.work }, owner: bob.user.id });
  await t.call(alice.token, 'PUT', q('/memories/user/a.md'), { content: 'alice only' });
  const bobFiles = (await t.call(bob.token, 'GET', `/api/memory?session=${sb.meta.id}`)).body as { files: { path: string }[] };
  assert.deepEqual(bobFiles.files.map((f) => f.path), [], 'user memory is per account (project memory is shared by the project)');
  await t.close();
});

test('sign in with an account token: the browser cookie works like the operator\'s', async () => {
  const t = await setup();
  const alice = await t.users.add('Alice');
  const res = await t.call(undefined, 'POST', '/api/login', { token: alice.token });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  assert.ok(cookie.startsWith('hw_token=hwu_'));
  assert.equal((await t.call(undefined, 'POST', '/api/login', { token: 'hwu_wrong' })).status, 401);
  await t.close();
});

test('network API: an allowlist session\'s hosts are read and changed by its owner, cleaned on the way in', async () => {
  const t = await setup();
  const s = await t.harness.sessions.create({ model: 'deepseek-flash', runtime: { kind: 'docker', network: 'allowlist' }, allowHosts: ['registry.npmjs.org'] });
  assert.deepEqual((await t.call(OPERATOR, 'GET', `/api/sessions/${s.meta.id}/network`)).body, { network: 'allowlist', hosts: ['registry.npmjs.org'] });
  const put = await t.call(OPERATOR, 'PUT', `/api/sessions/${s.meta.id}/network`, { hosts: ['PyPI.org', '*.github.com', 'bad host', 'x.io:8443', 'pypi.org', 'http://evil'] });
  assert.deepEqual(put.body.hosts, ['pypi.org', '*.github.com', 'x.io:8443']);
  const policy = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(t.harness.dataDir, 'sessions', s.meta.id, 'egress', 'allow.json'), 'utf8'));
  assert.deepEqual(policy.hosts, ['pypi.org', '*.github.com', 'x.io:8443'], 'the proxy reads the same file');
  const plain = await t.harness.sessions.create({ model: 'deepseek-flash', runtime: { kind: 'local', network: 'none', path: t.work } });
  assert.equal((await t.call(OPERATOR, 'PUT', `/api/sessions/${plain.meta.id}/network`, { hosts: ['a.io'] })).status, 409);
  await t.close();
});
