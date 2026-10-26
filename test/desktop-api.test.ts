import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getModel } from '../src/core/models.ts';
import type { Session } from '../src/core/session.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { EventHub } from '../src/kernel/events.ts';
import { uiHash } from '../src/plugins/ui.ts';
import { createApp } from '../src/server/app.ts';
import { UserStore } from '../src/server/users.ts';
import { validateUiManifest } from '../packages/plugin-ui/src/manifest.ts';
import { FakeProvider, tempDir, testPicture } from './helpers.ts';

// The HTTP API the desktop app codes against (docs/desktop/DESIGN.md section 7): health,
// the global event stream, providers, plugins with their UI halves, a session's files and
// git, session search/archive/fork/history/attachments and the effective settings. Every
// model call is a FakeProvider; no paid API is called.

const OPERATOR = 'operator-token-for-tests';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const HELLO = path.join(root, 'examples', 'plugins', 'hello-frame');
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The environment's keys would win over keys set through the API: none here.
for (const k of ['OPENAI_API_KEY', 'HW_TEST_FAKEPROV_KEY']) delete process.env[k];

async function setup(o: { data?: string; plugins?: string[]; bundled?: string[]; work?: string } = {}) {
  const data = o.data ?? await tempDir();
  const users = await new UserStore(data).load();
  // The two bundled plugins with a ui section are shipped ones; hello-frame is the operator's (HARNESS_PLUGINS).
  const bundled = o.bundled ?? [path.join(root, 'plugins', 'research'), path.join(root, 'plugins', 'quality-gates')];
  const harness = await createHarness({ dataDir: data, search: null, plugins: [...bundled, ...(o.plugins ?? [HELLO])], shippedPlugins: bundled });
  const fake = new FakeProvider(Array.from({ length: 20 }, () => ({ text: 'ok' })));
  harness.registry.setProviderInstance('deepseek', fake);
  const work = o.work ?? await tempDir();
  const { server } = createApp({ harness, token: OPERATOR, loopback: true, localRoots: [work], uiDir: path.join(data, 'ui'), appRoot: data, users });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const call = async (token: string | undefined, method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
    const raw = Buffer.isBuffer(body);
    const res = await fetch(base + p, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(method !== 'GET' ? { 'content-type': raw ? 'application/octet-stream' : 'application/json', 'x-harness': '1' } : {}), ...headers },
      body: method === 'GET' ? undefined : raw ? new Uint8Array(body as Buffer) : JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    let json: unknown; try { json = JSON.parse(text); } catch { json = text; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: json as any, headers: res.headers, text };
  };
  /** A request exactly as written (fetch would tidy "..", "%2e%2e" and the like away). */
  const rawGet = (p: string, token = OPERATOR) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers: { authorization: `Bearer ${token}` } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    req.on('error', reject); req.end();
  });
  const member = async (name: string) => (await call(OPERATOR, 'POST', '/api/users', { name })).body as { id: string; token: string };
  const close = async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await harness.close(); };
  return { data, harness, users, fake, work, base, call, rawGet, member, close };
}

/** The global event stream as a client reads it. */
async function events(base: string, token: string, o: { lastEventId?: number; query?: string } = {}) {
  const ctl = new AbortController();
  const res = await fetch(`${base}/api/events${o.query ?? ''}`, { headers: { authorization: `Bearer ${token}`, ...(o.lastEventId !== undefined ? { 'last-event-id': String(o.lastEventId) } : {}) }, signal: ctl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  const got: { seq: number; topic: string; payload: Record<string, unknown>; id: number }[] = [];
  const dec = new TextDecoder();
  let buf = '';
  (async () => {
    const reader = res.body!.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const id = /^id: (\d+)$/m.exec(chunk)?.[1];
          const data = /^data: (.*)$/m.exec(chunk)?.[1];
          if (data) got.push({ ...JSON.parse(data), id: Number(id) });
        }
      }
    } catch { /* closed */ }
  })();
  const until = async (pred: (e: (typeof got)[number]) => boolean, what = 'event', ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const e = got.find(pred); if (e) return e; await delay(20); }
    throw new Error(`no ${what} in ${JSON.stringify(got.map((e) => [e.topic, e.payload.type ?? '']))}`);
  };
  return { got, until, close: () => ctl.abort() };
}

const turnEnd = (s: Session) => new Promise<void>((res) => s.subscribe(s.lastSeq, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) res(); }));

test('health without signing in says only that the server is up and its version; version needs a sign-in', async () => {
  const t = await setup({ plugins: [], bundled: [] });
  const anon = await t.call(undefined, 'GET', '/api/health');
  assert.equal(anon.status, 200);
  assert.deepEqual(Object.keys(anon.body).sort(), ['apiVersion', 'ok', 'version']);
  assert.equal(anon.body.ok, true);
  assert.equal(anon.body.apiVersion, 1);
  assert.equal(anon.body.version, JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version);
  const signed = await t.call(OPERATOR, 'GET', '/api/health');
  assert.equal(typeof signed.body.uptimeSec, 'number');
  assert.equal(signed.body.node, process.version);
  assert.equal((await t.call('wrong', 'GET', '/api/health')).body.uptimeSec, undefined, 'a wrong token reads as signed out');
  assert.equal((await t.call(undefined, 'GET', '/api/version')).status, 401);
  assert.deepEqual((await t.call(OPERATOR, 'GET', '/api/version')).body, { version: anon.body.version, apiVersion: 1, uiApiVersion: 1 });
  await t.close();
});

test('events: one stream per person, filtered to the sessions they may use (administrators see all); approvals added and resolved; replay after Last-Event-ID', async () => {
  const t = await setup({ plugins: [], bundled: [] });
  const alice = await t.member('Alice');
  const bob = await t.member('Bob');
  const sa = await events(t.base, alice.token);
  const sb = await events(t.base, bob.token);
  const so = await events(t.base, OPERATOR);
  const s1 = await t.harness.sessions.create({ title: 'alice work', model: 'deepseek-flash', runtime: { kind: 'local', network: 'none', path: t.work }, owner: alice.id });
  const s2 = await t.harness.sessions.create({ title: 'bob work', model: 'deepseek-flash', runtime: { kind: 'local', network: 'none', path: t.work }, owner: bob.id });
  await sa.until((e) => e.topic === 'sessions' && e.payload.type === 'created' && (e.payload.session as { id: string }).id === s1.meta.id, 'alice created');
  await so.until((e) => e.topic === 'sessions' && (e.payload.session as { id: string }).id === s2.meta.id, 'operator sees bob');
  await sb.until((e) => e.topic === 'sessions' && (e.payload.session as { id: string }).id === s2.meta.id, 'bob created');

  // Alice's session asks before writing a file: the request reaches her stream and the inbox, not Bob's.
  t.harness.registry.setProviderInstance('deepseek', new FakeProvider([{ calls: [{ name: 'write', input: { path: 'x.txt', content: 'hi' } }] }, { text: 'written' }]));
  assert.equal((await t.call(alice.token, 'POST', `/api/sessions/${s1.meta.id}/messages`, { text: 'write x.txt' })).status, 202);
  const added = await sa.until((e) => e.topic === 'approvals' && e.payload.type === 'added', 'approval added');
  assert.equal(added.payload.sessionId, s1.meta.id);
  assert.equal(added.payload.kind, 'permission_request');
  assert.equal(added.payload.tool, 'write');
  assert.equal(added.payload.title, 'alice work');
  assert.equal(typeof added.payload.at, 'number');
  await sa.until((e) => e.topic === 'session' && e.payload.id === s1.meta.id && e.payload.status === 'waiting', 'status waiting');
  const inbox = (await t.call(alice.token, 'GET', '/api/approvals')).body as { requestId: string; sessionId: string; kind: string }[];
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0]!.requestId, added.payload.requestId);
  assert.deepEqual((await t.call(bob.token, 'GET', '/api/approvals')).body, [], 'Bob sees nothing of it');
  assert.equal(((await t.call(OPERATOR, 'GET', '/api/approvals')).body as unknown[]).length, 1);
  const done = turnEnd(s1);
  assert.equal((await t.call(alice.token, 'POST', `/api/sessions/${s1.meta.id}/respond`, { requestId: added.payload.requestId, decision: 'allow' })).status, 200);
  const resolved = await sa.until((e) => e.topic === 'approvals' && e.payload.type === 'resolved', 'resolved');
  assert.equal(resolved.payload.decision, 'allow');
  await done;
  assert.equal(await fs.readFile(path.join(t.work, 'x.txt'), 'utf8'), 'hi');
  // A title change reaches the list.
  assert.equal((await t.call(alice.token, 'PATCH', `/api/sessions/${s1.meta.id}`, { title: 'renamed' })).status, 200);
  await sa.until((e) => e.topic === 'sessions' && e.payload.type === 'updated' && (e.payload.session as { title: string }).title === 'renamed', 'renamed');

  await delay(200);
  assert.ok(!sb.got.some((e) => JSON.stringify(e.payload).includes(s1.meta.id)), 'nothing of Alice\'s session reached Bob');
  assert.ok(!sa.got.some((e) => JSON.stringify(e.payload).includes(s2.meta.id)), 'nothing of Bob\'s reached Alice');
  // ids increase; every event Alice got has a seq the stream labels it with.
  assert.ok(sa.got.every((e, i) => e.id === e.seq && (i === 0 || e.seq > sa.got[i - 1]!.seq)));

  // Replay: a new connection with Last-Event-ID gets what came after it (Alice's only), then live ones.
  const mid = sa.got[1]!.seq;
  const again = await events(t.base, alice.token, { lastEventId: mid });
  await again.until((e) => e.topic === 'sessions' && e.payload.type === 'updated', 'replayed update');
  assert.ok(again.got.every((e) => e.seq > mid), 'only what came after the id');
  assert.deepEqual(again.got.map((e) => e.seq), sa.got.filter((e) => e.seq > mid).map((e) => e.seq).slice(0, again.got.length));
  const viaQuery = await events(t.base, alice.token, { query: `?after=${mid}&topics=approvals` });
  await viaQuery.until((e) => e.payload.type === 'resolved', 'approvals only');
  assert.ok(viaQuery.got.every((e) => e.topic === 'approvals'));
  // Unsigned streams are refused.
  assert.equal((await fetch(`${t.base}/api/events`)).status, 401);
  for (const s of [sa, sb, so, again, viaQuery]) s.close();
  await t.close();
});

test('the event ring keeps the newest events; an id from before a restart replays the ring; schedules and plugins report', async () => {
  const hub = new EventHub(5);
  for (let i = 0; i < 8; i++) hub.publish('notices', { level: 'info', text: `n${i}` }, { all: true });
  const seen: number[] = [];
  const off = hub.subscribe(0, (e) => seen.push(e.seq));
  assert.deepEqual(seen, [4, 5, 6, 7, 8]);
  off();
  const after: number[] = [];
  hub.subscribe(999, (e) => after.push(e.seq))();
  assert.deepEqual(after, [4, 5, 6, 7, 8], 'an id this server never gave (a restart) replays what there is');

  const t = await setup({ plugins: [], bundled: [] });
  const so = await events(t.base, OPERATOR);
  const s = await t.harness.sessions.create({ model: 'deepseek-flash', runtime: { kind: 'local', network: 'none', path: t.work } });
  const made = await t.call(OPERATOR, 'POST', '/api/schedules', { title: 'later', prompt: 'do it', inMinutes: 30, sessionId: s.meta.id });
  assert.equal(made.status, 201);
  const ch = await so.until((e) => e.topic === 'schedules' && e.payload.type === 'changed', 'schedule changed');
  assert.equal(ch.payload.id, made.body.id);
  assert.equal(ch.payload.prompt, undefined, 'never the prompt or a trigger hash');
  await t.call(OPERATOR, 'POST', `/api/schedules/${made.body.id}/run`);
  const fired = await so.until((e) => e.topic === 'schedules' && e.payload.type === 'fired', 'schedule fired');
  assert.equal(fired.payload.sessionId, s.meta.id);
  so.close();
  await t.close();
});

test('providers: listed with where the key comes from; an administrator sets a key (kept in the vault, never returned) that takes effect at the next request; test calls the models list', async () => {
  const t = await setup({ plugins: [], bundled: [] });
  const alice = await t.member('Alice');
  // A stand-in API: the models list answers only the right key.
  const hits: string[] = [];
  const api = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`);
    const ok = req.headers.authorization === 'Bearer key-two-0987654321';
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? { data: [{ id: 'fake-model' }] } : { error: { message: 'invalid api key key-one-1234567890' } }));
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  const apiBase = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  // A provider whose instances say which key and address they were made with.
  const made: string[] = [];
  t.harness.registry.providers.set('fakeprov', {
    label: 'Fake provider', keyEnv: ['HW_TEST_FAKEPROV_KEY'], defaultBaseUrl: `${apiBase}/v1`,
    create: (key, o) => ({ send: async (req) => { made.push(`${key}@${o?.baseUrl ?? 'default'}`); return { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, stop: 'end', usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0 }, ...(req ? {} : {}) }; } }),
  });
  const model = { ...getModel('deepseek-flash'), id: 'fake-model', label: 'Fake', provider: 'fakeprov' };
  t.harness.registry.models.set(model.id, model);

  const list = (await t.call(alice.token, 'GET', '/api/providers')).body as { id: string; label: string; configured: boolean; source: string; models: string[]; keyEnv: string[]; baseUrl?: string }[];
  const fp = list.find((p) => p.id === 'fakeprov')!;
  assert.deepEqual({ label: fp.label, configured: fp.configured, source: fp.source, models: fp.models, keyEnv: fp.keyEnv, baseUrl: fp.baseUrl }, { label: 'Fake provider', configured: false, source: 'none', models: ['fake-model'], keyEnv: ['HW_TEST_FAKEPROV_KEY'], baseUrl: `${apiBase}/v1` });
  assert.ok(list.some((p) => p.id === 'anthropic' && p.label === 'Anthropic') && list.some((p) => p.id === 'openai') && list.some((p) => p.id === 'deepseek'));
  assert.equal((await t.call(OPERATOR, 'GET', '/api/models')).text, JSON.stringify((await t.call(OPERATOR, 'GET', '/api/config')).body.models), 'the same catalog as /api/config');
  assert.equal(((await t.call(OPERATOR, 'GET', '/api/models')).body as { id: string; available: boolean }[]).find((m) => m.id === 'fake-model')!.available, false);
  assert.throws(() => t.harness.registry.provider(model), /No API key for fakeprov/);

  // Members may not; a key must look like one.
  assert.equal((await t.call(alice.token, 'PUT', '/api/providers/fakeprov', { apiKey: 'key-one-1234567890' })).status, 403);
  assert.equal((await t.call(alice.token, 'DELETE', '/api/providers/fakeprov/key')).status, 403);
  assert.equal((await t.call(alice.token, 'POST', '/api/providers/fakeprov/test')).status, 403);
  assert.equal((await t.call(OPERATOR, 'PUT', '/api/providers/fakeprov', { apiKey: 'short' })).status, 400);
  assert.equal((await t.call(OPERATOR, 'PUT', '/api/providers/fakeprov', { baseUrl: 'ftp://x' })).status, 400);
  assert.equal((await t.call(OPERATOR, 'PUT', '/api/providers/nope', { apiKey: 'key-one-1234567890' })).status, 404);

  const set = await t.call(OPERATOR, 'PUT', '/api/providers/fakeprov', { apiKey: 'key-one-1234567890' });
  assert.equal(set.status, 200);
  assert.deepEqual(set.body, { id: 'fakeprov', configured: true, source: 'vault' });
  // A live session's provider is the same stand-in: the key in force is looked up per request.
  const p = t.harness.registry.provider(model);
  const req = { model, system: 's', tools: [], messages: [], effort: 'high' as const, cacheKey: 'k', signal: new AbortController().signal };
  await p.send(req);
  assert.deepEqual(made, ['key-one-1234567890@default']);
  // The key is an operator-scope vault entry, administrators only, and never comes back.
  const entries = (await t.call(OPERATOR, 'GET', '/api/vault/entries')).body.entries as { name: string; scope: string; allow?: string[] }[];
  assert.deepEqual(entries.filter((e) => e.name === 'provider-fakeprov-key').map((e) => [e.scope, e.allow]), [['operator', ['admins']]]);
  assert.ok(!((await t.call(alice.token, 'GET', '/api/vault/entries')).text.includes('provider-fakeprov-key')), 'members do not see it');
  for (const r of [await t.call(OPERATOR, 'GET', '/api/providers'), await t.call(OPERATOR, 'GET', '/api/config'), await t.call(OPERATOR, 'GET', '/api/vault/entries')]) assert.ok(!r.text.includes('key-one-1234567890'));
  const audit = JSON.stringify((await t.call(OPERATOR, 'GET', '/api/vault/audit')).body);
  assert.ok(audit.includes('provider-fakeprov-key') && !audit.includes('key-one-1234567890'));

  // A wrong key fails the test without echoing it; a new key and address apply to the next request.
  const bad = await t.call(OPERATOR, 'POST', '/api/providers/fakeprov/test');
  assert.equal(bad.body.ok, false);
  assert.match(bad.body.error, /HTTP 401/);
  assert.ok(!bad.text.includes('key-one-1234567890'), 'the key never appears in the answer');
  assert.equal((await t.call(OPERATOR, 'PUT', '/api/providers/fakeprov', { apiKey: 'key-two-0987654321', baseUrl: `${apiBase}/v2/` })).body.baseUrl, `${apiBase}/v2`);
  await p.send(req);
  assert.equal(made.at(-1), `key-two-0987654321@${apiBase}/v2`);
  const good = await t.call(OPERATOR, 'POST', '/api/providers/fakeprov/test');
  assert.deepEqual({ ok: good.body.ok, model: good.body.model }, { ok: true, model: 'fake-model' });
  assert.equal(typeof good.body.latencyMs, 'number');
  assert.equal(hits.at(-1), 'GET /v2/models Bearer key-two-0987654321');
  assert.equal(((await t.call(OPERATOR, 'GET', '/api/providers')).body as { id: string; baseUrl: string }[]).find((x) => x.id === 'fakeprov')!.baseUrl, `${apiBase}/v2`);

  // The environment's key wins; removing the stored key leaves the provider without one.
  process.env.HW_TEST_FAKEPROV_KEY = 'env-key-5555555555';
  assert.equal(((await t.call(OPERATOR, 'GET', '/api/providers')).body as { id: string; source: string }[]).find((x) => x.id === 'fakeprov')!.source, 'env');
  delete process.env.HW_TEST_FAKEPROV_KEY;
  assert.deepEqual((await t.call(OPERATOR, 'DELETE', '/api/providers/fakeprov/key')).body, { ok: true, source: 'none' });
  await assert.rejects(() => p.send(req), /No API key for fakeprov/);
  assert.equal(((await t.call(OPERATOR, 'GET', '/api/models')).body as { id: string; available: boolean }[]).find((m) => m.id === 'fake-model')!.available, false);
  // Another provider's test goes through its test instance (no network): the deepseek fake answers.
  const viaFake = await t.call(OPERATOR, 'POST', '/api/providers/deepseek/test');
  assert.equal(viaFake.body.ok, true);
  assert.equal(viaFake.body.model, 'deepseek-flash');

  // A restart reads the stored key back from the vault.
  assert.equal((await t.call(OPERATOR, 'PUT', '/api/providers/openai', { apiKey: 'sk-test-abcdefghijkl' })).status, 200);
  await t.close();
  api.close();
  const again = await setup({ data: t.data, plugins: [], bundled: [] });
  assert.equal(again.harness.registry.keyInfo('openai').source, 'vault');
  assert.equal(again.harness.registry.keyInfo('openai').key, 'sk-test-abcdefghijkl');
  await again.close();
});

test('plugins: listed with validated UI halves (trust by source), a bad ui section reported without stopping the server half', async () => {
  const extra = await tempDir();
  // A plugin whose ui names a contribution point that does not exist, and one asking for native UI unsigned.
  const bad = path.join(extra, 'bad-ui');
  await fs.mkdir(bad, { recursive: true });
  await fs.writeFile(path.join(bad, 'harness-plugin.json'), JSON.stringify({ name: 'bad-ui', main: 'index.mjs', ui: { contributes: { sidebarz: [] } } }));
  await fs.writeFile(path.join(bad, 'index.mjs'), "export default { name: 'bad-ui', setup(api) { api.registerTool({ name: 'bad_ui_tool', description: 'd', parameters: { type: 'object', properties: {} }, kind: 'read', run: async () => 'ok' }); } };\n");
  const native = path.join(extra, 'wants-native');
  await fs.mkdir(native, { recursive: true });
  await fs.writeFile(path.join(native, 'harness-plugin.json'), JSON.stringify({ name: 'wants-native', ui: { trust: 'native', contributes: { views: [{ id: 'v', title: 'V', kind: 'native', component: 'Thing' }] } } }));
  const t = await setup({ plugins: [HELLO, bad, native] });
  const list = (await t.call(OPERATOR, 'GET', '/api/plugins')).body as Record<string, any>[];
  const by = (n: string) => list.find((p) => p.name === n)!;
  assert.deepEqual(list.map((p) => p.name).sort(), ['bad-ui', 'hello-frame', 'quality-gates', 'research', 'wants-native']);
  const hello = by('hello-frame');
  assert.equal(hello.source, 'env');
  assert.equal(hello.enabled, true);
  assert.equal(hello.required, false);
  assert.equal(hello.ui.trust, 'frame');
  assert.deepEqual(hello.ui.capabilities, ['routes.call', 'sessions.read']);
  assert.equal(hello.ui.contributes.renderers[0].for.fence, 'hello');
  assert.match(hello.uiHash, /^[a-f0-9]{64}$/);
  assert.equal(hello.uiBase, '/api/plugins/hello-frame/ui/');
  assert.ok(hello.contributes.includes('route:GET greeting'));
  assert.equal(hello.dir, undefined, 'never the folder');
  assert.equal(by('research').source, 'bundled');
  assert.equal(by('research').ui.trust, 'declarative');
  assert.equal(by('research').ui.contributes.views[0].kind, 'prompt-board');
  assert.ok(by('research').ui.contributes.commands.length >= 1);
  assert.equal(by('quality-gates').ui.contributes.settings[0].scope, 'account');
  assert.match(by('bad-ui').uiError, /not a contribution point/);
  assert.equal(by('bad-ui').ui, undefined);
  assert.ok(t.harness.registry.tools.has('bad_ui_tool'), 'its server half loaded');
  assert.match(by('wants-native').uiError, /Native UI is only for plugins signed/);
  // Every bundled plugin's ui section is valid as shipped.
  for (const n of ['research', 'quality-gates']) {
    const m = JSON.parse(await fs.readFile(path.join(root, 'plugins', n, 'harness-plugin.json'), 'utf8'));
    assert.doesNotThrow(() => validateUiManifest(m.ui, { trustCeiling: 'native' }));
  }
  // Members see the list too (their desktop builds its UI from it).
  const alice = await t.member('Alice');
  assert.equal((await t.call(alice.token, 'GET', '/api/plugins')).status, 200);
  await t.close();
});

test('plugin UI files: only under the frames\' folders, with the frame CSP; no code, manifest, dotfile, traversal or link out', async () => {
  const dir = path.join(await tempDir(), 'hello-frame');
  await fs.cp(HELLO, dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'ui', '.env'), 'SECRET=1\n');
  await fs.mkdir(path.join(dir, 'ui', '.hidden'));
  await fs.writeFile(path.join(dir, 'ui', '.hidden', 'x.js'), 'x');
  await fs.writeFile(path.join(dir, 'secret.txt'), 'server secret');
  await fs.symlink(path.join(dir, 'secret.txt'), path.join(dir, 'ui', 'link.txt'));
  await fs.symlink(path.join(dir, 'index.mjs'), path.join(dir, 'ui', 'code.js'));
  const t = await setup({ plugins: [dir] });
  const ok = await t.rawGet('/api/plugins/hello-frame/ui/ui/index.html');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(ok.headers['cache-control'], 'no-cache');
  assert.equal(ok.headers['x-content-type-options'], 'nosniff');
  const csp = String(ok.headers['content-security-policy']);
  assert.ok(csp.startsWith("default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; frame-ancestors *"), csp);
  assert.match(csp, /sandbox allow-scripts allow-forms/);
  assert.match(ok.body, /harness-ui\/1/);
  const css = await t.rawGet('/api/plugins/hello-frame/ui/ui/style.css');
  assert.equal(css.status, 200);
  assert.equal(css.headers['content-type'], 'text/css; charset=utf-8');
  for (const p of [
    '/api/plugins/hello-frame/ui/index.mjs', '/api/plugins/hello-frame/ui/harness-plugin.json', '/api/plugins/hello-frame/ui/secret.txt',
    '/api/plugins/hello-frame/ui/ui/../index.mjs', '/api/plugins/hello-frame/ui/ui/%2e%2e/index.mjs', '/api/plugins/hello-frame/ui/ui%2f..%2findex.mjs',
    '/api/plugins/hello-frame/ui/ui/..%5cindex.mjs', '/api/plugins/hello-frame/ui/ui/.env', '/api/plugins/hello-frame/ui/ui/.hidden/x.js',
    '/api/plugins/hello-frame/ui/ui/link.txt', '/api/plugins/hello-frame/ui/ui/code.js', '/api/plugins/hello-frame/ui/ui/missing.html',
    '/api/plugins/hello-frame/ui/ui', '/api/plugins/hello-frame/ui/ui/', '/api/plugins/research/ui/skills/cite-sources/SKILL.md', '/api/plugins/nope/ui/ui/index.html',
  ]) {
    const r = await t.rawGet(p);
    assert.ok(r.status === 404 || r.status === 400, `${p}: ${r.status}`);
    assert.ok(!r.body.includes('registerRoute') && !r.body.includes('server secret') && !r.body.includes('SECRET=1'), p);
  }
  assert.equal((await t.call(undefined, 'GET', '/api/plugins/hello-frame/ui/ui/index.html')).status, 401, 'signed in only');
  // The hash covers the files: a changed file is a new hash (a grant asks again).
  const e = t.harness.plugins.get('hello-frame')!;
  const h1 = await uiHash(dir, e.ui!, JSON.parse(await fs.readFile(path.join(dir, 'harness-plugin.json'), 'utf8')).ui);
  assert.equal(h1, e.uiHash);
  await fs.appendFile(path.join(dir, 'ui', 'style.css'), '\n/* changed */\n');
  assert.notEqual(await uiHash(dir, e.ui!, JSON.parse(await fs.readFile(path.join(dir, 'harness-plugin.json'), 'utf8')).ui), h1);
  // A switched-off plugin serves nothing.
  assert.equal((await t.call(OPERATOR, 'POST', '/api/plugins/hello-frame/disable')).status, 200);
  assert.equal((await t.rawGet('/api/plugins/hello-frame/ui/ui/index.html')).status, 404);
  await t.close();
});

test('plugins switched off and on while the server runs: tools, routes and the list follow at once, the choice persists, required ones stay', async () => {
  const data = await tempDir();
  process.env.HARNESS_REQUIRED_PLUGINS = 'quality-gates';
  try {
    const t = await setup({ data });
    const alice = await t.member('Alice');
    const so = await events(t.base, alice.token);
    assert.equal((await t.call(undefined, 'GET', '/api/plugins/hello-frame/greeting')).status, 200, 'the route works');
    assert.ok(t.harness.registry.tools.has('check_citations'));
    assert.ok(t.harness.registry.workflows.has('deep-research'));
    assert.equal((await t.call(alice.token, 'POST', '/api/plugins/research/disable')).status, 403, 'administrators only');
    assert.equal((await t.call(OPERATOR, 'POST', '/api/plugins/quality-gates/disable')).status, 409, 'required');
    assert.equal(((await t.call(OPERATOR, 'GET', '/api/plugins')).body as { name: string; required: boolean }[]).find((p) => p.name === 'quality-gates')!.required, true);

    const off = await t.call(OPERATOR, 'POST', '/api/plugins/research/disable');
    assert.equal(off.status, 200);
    assert.equal(off.body.enabled, false);
    assert.ok(!t.harness.registry.tools.has('check_citations') && !t.harness.registry.tools.has('sources'), 'its tools are gone');
    assert.ok(!t.harness.registry.workflows.has('deep-research') && !t.harness.registry.agents.has('researcher'), 'and its workflows and agents');
    assert.ok(!t.harness.registry.plugins.some((p) => p.name === 'research'));
    await so.until((e) => e.topic === 'plugins' && e.payload.type === 'changed' && e.payload.name === 'research', 'plugins changed');
    // A new session goes without it.
    const s = await t.harness.sessions.create({ model: 'deepseek-flash', runtime: { kind: 'local', network: 'none', path: t.work } });
    const caps = await s.capabilities();
    assert.ok(!caps.tools.some((x) => x.name === 'check_citations'));
    assert.ok(caps.tools.some((x) => x.name === 'quality_gates'), 'other plugins stay');
    assert.equal((await t.call(OPERATOR, 'POST', '/api/plugins/hello-frame/disable')).status, 200);
    assert.equal((await t.call(undefined, 'GET', '/api/plugins/hello-frame/greeting')).status, 503, 'its route answers that it is switched off');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(data, 'plugins-state.json'), 'utf8')).disabled, ['hello-frame', 'research']);

    // Back on: everything returns.
    assert.equal((await t.call(OPERATOR, 'POST', '/api/plugins/research/enable')).body.enabled, true);
    assert.ok(t.harness.registry.tools.has('check_citations') && t.harness.registry.workflows.has('deep-research'));
    const s2 = await t.harness.sessions.create({ model: 'deepseek-flash', runtime: { kind: 'local', network: 'none', path: t.work } });
    assert.ok((await s2.capabilities()).tools.some((x) => x.name === 'check_citations'));
    so.close();
    await t.close();

    // After a restart the switched-off plugin is listed but not loaded; switching it on loads it then.
    const t2 = await setup({ data });
    const hello = ((await t2.call(OPERATOR, 'GET', '/api/plugins')).body as { name: string; enabled: boolean; contributes: string[]; ui?: unknown }[]).find((p) => p.name === 'hello-frame')!;
    assert.equal(hello.enabled, false);
    assert.deepEqual(hello.contributes, []);
    assert.ok(hello.ui, 'its UI is described (switched off)');
    assert.equal((await t2.call(undefined, 'GET', '/api/plugins/hello-frame/greeting')).status, 503, 'off since the start: switched off, not missing');
    assert.ok(t2.harness.registry.tools.has('check_citations'), 'research was switched back on');
    assert.equal((await t2.call(OPERATOR, 'POST', '/api/plugins/hello-frame/enable')).status, 200);
    assert.equal((await t2.call(undefined, 'GET', '/api/plugins/hello-frame/greeting')).status, 200);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(data, 'plugins-state.json'), 'utf8')).disabled, []);
    await t2.close();
  } finally { delete process.env.HARNESS_REQUIRED_PLUGINS; }
});

test('plugins: only catalogue-installed ones are uninstalled (their folder removed); a route path the server keeps is refused', async () => {
  const data = await tempDir();
  // A plugin in the install folder is one the catalogue installed.
  await fs.cp(HELLO, path.join(data, 'plugins', 'hello-frame'), { recursive: true });
  const reserved = path.join(await tempDir(), 'reserved');
  await fs.mkdir(reserved);
  await fs.writeFile(path.join(reserved, 'harness-plugin.json'), JSON.stringify({ name: 'reserved', main: 'index.mjs', permissions: { routes: true } }));
  await fs.writeFile(path.join(reserved, 'index.mjs'), "export default { name: 'reserved', setup(api) { api.registerRoute({ method: 'GET', path: 'ui/x', auth: 'none', handler: async () => ({ status: 200, body: 'mine' }) }); } };\n");
  const t = await setup({ data, plugins: [reserved] });
  const list = (await t.call(OPERATOR, 'GET', '/api/plugins')).body as { name: string; source: string; error?: string; contributes: string[] }[];
  assert.equal(list.find((p) => p.name === 'hello-frame')!.source, 'installed');
  // Its setup failed (ui/... is the server's): listed with why, nothing of it loaded.
  const refused = list.find((p) => p.name === 'reserved');
  assert.match(refused?.error ?? '', /route path "ui\/x" is reserved/);
  assert.deepEqual(refused?.contributes, []);
  const alice = await t.member('Alice');
  assert.equal((await t.call(alice.token, 'DELETE', '/api/plugins/hello-frame')).status, 403);
  assert.equal((await t.call(OPERATOR, 'DELETE', '/api/plugins/research')).status, 409, 'shipped with the harness: switch it off instead');
  assert.equal((await t.call(OPERATOR, 'DELETE', '/api/plugins/nope')).status, 404);
  assert.equal((await t.call(OPERATOR, 'DELETE', '/api/plugins/hello-frame')).status, 200);
  assert.equal(await fs.stat(path.join(data, 'plugins', 'hello-frame')).catch(() => null), null);
  assert.ok(!((await t.call(OPERATOR, 'GET', '/api/plugins')).body as { name: string }[]).some((p) => p.name === 'hello-frame'));
  assert.equal((await t.call(undefined, 'GET', '/api/plugins/hello-frame/greeting')).status, 404);
  await t.close();
});

test('files: a lazy tree (heavy folders listed, not walked), writes, renames, deletes, uploads and search, all inside the workspace; the agent hears of changes', async () => {
  const t = await setup({ plugins: [], bundled: [] });
  const w = t.work;
  await fs.mkdir(path.join(w, 'src', 'deep'), { recursive: true });
  await fs.mkdir(path.join(w, 'node_modules', 'pkg'), { recursive: true });
  await fs.writeFile(path.join(w, 'node_modules', 'pkg', 'index.js'), 'needle in a dependency');
  await fs.writeFile(path.join(w, 'README.md'), '# Title\nfind the needle here\n');
  await fs.writeFile(path.join(w, 'src', 'a.ts'), 'export const a = 1;\n// NEEDLE again\n');
  await fs.writeFile(path.join(w, 'src', 'blob.bin'), Buffer.from([0, 1, 2, 110, 101, 101, 100, 108, 101]));
  const outside = await tempDir();
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside');
  await fs.symlink(outside, path.join(w, 'out'), 'dir');
  const alice = await t.member('Alice');
  const s = await t.harness.sessions.create({ model: 'deepseek-flash', runtime: { kind: 'local', network: 'none', path: w } });
  const id = s.meta.id;

  const tree = (await t.call(OPERATOR, 'GET', `/api/sessions/${id}/files/tree`)).body as { path: string; entries: { name: string; type: string; heavy?: boolean; symlink?: boolean; children?: unknown[] }[] };
  assert.equal(tree.path, '.');
  assert.deepEqual(tree.entries.map((e) => e.name), ['node_modules', 'src', 'out', 'README.md']);
  assert.equal(tree.entries.find((e) => e.name === 'node_modules')!.heavy, true);
  assert.equal(tree.entries.find((e) => e.name === 'out')!.symlink, true);
  assert.equal(tree.entries.find((e) => e.name === 'src')!.children, undefined, 'depth 1');
  const deep = (await t.call(OPERATOR, 'GET', `/api/sessions/${id}/files/tree?depth=2`)).body as { entries: { name: string; children?: { name: string }[] }[] };
  assert.deepEqual(deep.entries.find((e) => e.name === 'src')!.children!.map((c) => c.name), ['deep', 'a.ts', 'blob.bin']);
  assert.equal(deep.entries.find((e) => e.name === 'node_modules')!.children, undefined, 'heavy folders are not walked');
  assert.equal((await t.call(OPERATOR, 'GET', `/api/sessions/${id}/files/tree?path=src`)).body.entries.length, 3);
  assert.equal((await t.call(OPERATOR, 'GET', `/api/sessions/${id}/files/tree?path=../`)).status, 400);
  assert.equal((await t.call(alice.token, 'GET', `/api/sessions/${id}/files/tree`)).status, 404, 'someone else\'s session');

  const so = await events(t.base, OPERATOR);
  const put = await t.call(OPERATOR, 'PUT', `/api/sessions/${id}/files?path=${encodeURIComponent('src/new/note.txt')}`, Buffer.from('written by me'));
  assert.equal(put.status, 200);
  assert.deepEqual(put.body, { path: 'src/new/note.txt', size: 13 });
  assert.equal(await fs.readFile(path.join(w, 'src', 'new', 'note.txt'), 'utf8'), 'written by me');
  const notice = await so.until((e) => e.topic === 'notices' && e.payload.sessionId === id, 'notice');
  assert.match(String(notice.payload.text), /operator wrote src\/new\/note\.txt/);
  // Writes outside, through a link out, into .git, or onto the workspace itself are refused.
  for (const [p, status] of [['../escape.txt', 400], [path.join(outside, 'abs.txt'), 400], ['out/secret.txt', 400], ['out/new.txt', 400], ['.git/config', 403], ['src/.GIT/hooks/pre-commit', 403], ['.', 400], ['', 400]] as const) {
    const r = await t.call(OPERATOR, 'PUT', `/api/sessions/${id}/files?path=${encodeURIComponent(p)}`, Buffer.from('x'));
    assert.equal(r.status, status, `${p}: ${r.text}`);
  }
  assert.equal(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8'), 'outside');
  assert.equal(await fs.stat(path.join(outside, 'new.txt')).catch(() => null), null);
  assert.equal(await fs.stat(path.join(w, '.git')).catch(() => null), null);
  const big = await t.call(OPERATOR, 'PUT', `/api/sessions/${id}/files?path=big.bin`, Buffer.alloc(10 * 1024 * 1024 + 1));
  assert.equal(big.status, 413);

  assert.deepEqual((await t.call(OPERATOR, 'POST', `/api/sessions/${id}/files/rename`, { from: 'src/new/note.txt', to: 'docs/note.txt' })).body, { from: 'src/new/note.txt', to: 'docs/note.txt' });
  assert.equal((await t.call(OPERATOR, 'POST', `/api/sessions/${id}/files/rename`, { from: 'docs/note.txt', to: 'README.md' })).status, 409, 'no silent overwrite');
  assert.equal((await t.call(OPERATOR, 'POST', `/api/sessions/${id}/files/rename`, { from: 'docs/note.txt', to: '../x.txt' })).status, 400);
  assert.equal((await t.call(OPERATOR, 'POST', `/api/sessions/${id}/files/rename`, { from: 'docs/note.txt', to: '.git/x' })).status, 403);
  const up = await t.call(OPERATOR, 'POST', `/api/sessions/${id}/files/upload`, { path: 'assets/pic.png', base64: testPicture(8, 8).toString('base64') });
  assert.equal(up.status, 201);
  assert.deepEqual(await fs.readFile(path.join(w, 'assets', 'pic.png')), testPicture(8, 8));
  assert.equal((await t.call(OPERATOR, 'POST', `/api/sessions/${id}/files/upload`, { path: '../up.png', base64: 'AAAA' })).status, 400);
  // Deleting a link removes the link, never what it points at.
  assert.equal((await t.call(OPERATOR, 'DELETE', `/api/sessions/${id}/files?path=out`)).status, 200);
  assert.equal(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8'), 'outside');
  assert.equal((await t.call(OPERATOR, 'DELETE', `/api/sessions/${id}/files?path=docs`)).status, 200);
  assert.equal(await fs.stat(path.join(w, 'docs')).catch(() => null), null);
  assert.equal((await t.call(OPERATOR, 'DELETE', `/api/sessions/${id}/files?path=..`)).status, 400);
  assert.equal((await t.call(OPERATOR, 'DELETE', `/api/sessions/${id}/files?path=nothing-here`)).status, 404);

  const names = (await t.call(OPERATOR, 'GET', `/api/sessions/${id}/files/search?q=A.T`)).body as { results: { path: string }[] };
  assert.deepEqual(names.results.map((r) => r.path), ['src/a.ts']);
  const content = (await t.call(OPERATOR, 'GET', `/api/sessions/${id}/files/search?q=needle&content=1`)).body as { results: { path: string; matches: { line: number; text: string }[] }[] };
  assert.deepEqual(content.results.map((r) => [r.path, r.matches.map((m) => m.line)]).sort(), [['README.md', [2]], ['src/a.ts', [2]]], 'no dependency folder, no binary file');
  assert.equal((await t.call(OPERATOR, 'GET', `/api/sessions/${id}/files/search?q=`)).status, 400);

  // The agent's next turn is told what the person changed.
  const done = turnEnd(s);
  await t.call(OPERATOR, 'POST', `/api/sessions/${id}/messages`, { text: 'what changed?' });
  await done;
  const sent = JSON.stringify(t.fake.requests.at(-1)!.messages);
  assert.match(sent, /Files changed by the user \(wrote\)[^"]*src\/new\/note\.txt/);
  assert.match(sent, /Files changed by the user \(deleted\)[^"]*docs/);
  so.close();
  await t.close();
});

test('files and git of a companion session answer 501: they live on that computer', async () => {
  const t = await setup({ plugins: [], bundled: [] });
  const c = await t.call(OPERATOR, 'POST', '/api/companions', { name: 'laptop' });
  const s = (await t.call(OPERATOR, 'POST', '/api/sessions', { runtime: 'companion', companionId: c.body.id, model: 'deepseek-flash' })).body as { id: string };
  for (const p of ['files/tree', 'files/search?q=x', 'git/status', 'git/log']) assert.equal((await t.call(OPERATOR, 'GET', `/api/sessions/${s.id}/${p}`)).status, 501, p);
  assert.equal((await t.call(OPERATOR, 'PUT', `/api/sessions/${s.id}/files?path=a.txt`, Buffer.from('x'))).status, 501);
  assert.equal((await t.call(OPERATOR, 'POST', `/api/sessions/${s.id}/fork`, {})).status, 501);
  await t.close();
});

test('git status, diff and log of a session\'s workspace, run where its commands run', async (ctx) => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { ctx.skip('git is not installed'); return; }
  const t = await setup({ plugins: [], bundled: [] });
  const s = await t.harness.sessions.create({ model: 'deepseek-flash', runtime: { kind: 'local', network: 'none', path: t.work } });
  assert.deepEqual((await t.call(OPERATOR, 'GET', `/api/sessions/${s.meta.id}/git/status`)).body, { repo: false, files: [] });
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd: t.work, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  assert.deepEqual((await t.call(OPERATOR, 'GET', `/api/sessions/${s.meta.id}/git/log`)).body, { repo: true, commits: [] });
  await fs.writeFile(path.join(t.work, 'a.txt'), 'one\n');
  await fs.writeFile(path.join(t.work, 'b c.txt'), 'two\n');
  git('add', '.'); git('commit', '-q', '-m', 'first commit');
  await fs.writeFile(path.join(t.work, 'a.txt'), 'one\nchanged\n');
  await fs.writeFile(path.join(t.work, 'new.txt'), 'new\n');
  await fs.writeFile(path.join(t.work, 'b c.txt'), 'two\nstaged\n');
  git('add', 'b c.txt');
  const st = (await t.call(OPERATOR, 'GET', `/api/sessions/${s.meta.id}/git/status`)).body;
  assert.equal(st.repo, true);
  assert.equal(st.branch, 'main');
  assert.equal(st.clean, false);
  assert.deepEqual(st.files.map((f: { path: string; index: string; worktree: string }) => `${f.index}${f.worktree} ${f.path}`).sort(), [' M a.txt', '?? new.txt', 'M  b c.txt']);
  const diff = (await t.call(OPERATOR, 'GET', `/api/sessions/${s.meta.id}/git/diff?path=a.txt`)).body;
  assert.equal(diff.path, 'a.txt');
  assert.match(diff.diff, /\+changed/);
  assert.doesNotMatch(diff.diff, /staged/);
  const staged = (await t.call(OPERATOR, 'GET', `/api/sessions/${s.meta.id}/git/diff?staged=1`)).body;
  assert.match(staged.diff, /\+staged/);
  assert.doesNotMatch(staged.diff, /\+changed/);
  assert.equal((await t.call(OPERATOR, 'GET', `/api/sessions/${s.meta.id}/git/diff?path=../x`)).status, 400);
  const log = (await t.call(OPERATOR, 'GET', `/api/sessions/${s.meta.id}/git/log?limit=5`)).body;
  assert.equal(log.commits.length, 1);
  assert.equal(log.commits[0].subject, 'first commit');
  assert.equal(log.commits[0].author, 'Test');
  assert.match(log.commits[0].hash, /^[0-9a-f]{40}$/);
  await t.close();
});

test('sessions: search over titles and first messages, archive, pin and group, paging with a cursor; the plain list stays as it was', async () => {
  const t = await setup({ plugins: [], bundled: [] });
  const alice = await t.member('Alice');
  const mk = async (title: string) => (await t.call(alice.token, 'POST', '/api/sessions', { runtime: 'companion', companionId: (await t.call(alice.token, 'POST', '/api/companions', { name: 'c' })).body.id, model: 'deepseek-flash', title })).body as { id: string };
  const a = await mk('Budget planning');
  const b = await mk('Kubernetes upgrade');
  const c = await mk('New session');
  // The first thing typed is searchable (its title comes from it too).
  t.harness.sessions.get(c.id)!.meta.firstPrompt = 'Find the flaky checkout test';
  await t.harness.sessions.get(c.id)!.saveMeta();
  const other = await t.harness.sessions.create({ title: 'budget of someone else', model: 'deepseek-flash', runtime: { kind: 'local', network: 'none', path: t.work } });

  const plain = await t.call(alice.token, 'GET', '/api/sessions');
  assert.ok(Array.isArray(plain.body), 'no parameters: the plain array');
  assert.equal(plain.body.length, 3);
  const q = async (s: string) => (await t.call(alice.token, 'GET', `/api/sessions?${s}`)).body as { sessions: { id: string; title: string; archived?: boolean; pinned?: boolean; group?: string }[]; next?: string };
  assert.deepEqual((await q('query=budget')).sessions.map((x) => x.id), [a.id], 'only her own');
  assert.deepEqual((await q('query=CHECKOUT')).sessions.map((x) => x.id), [c.id], 'the first message, case-insensitive');
  assert.equal((await q('query=nothing-like-it')).sessions.length, 0);

  assert.equal((await t.call(alice.token, 'POST', `/api/sessions/${b.id}/archive`)).body.archived, true);
  assert.equal((await t.call(alice.token, 'POST', `/api/sessions/${other.meta.id}/archive`)).status, 404);
  assert.deepEqual((await q('archived=0')).sessions.map((x) => x.id).sort(), [a.id, c.id].sort());
  assert.deepEqual((await q('archived=1')).sessions.map((x) => x.id), [b.id]);
  assert.equal((await t.call(alice.token, 'POST', `/api/sessions/${b.id}/unarchive`)).body.archived, undefined);

  const patched = await t.call(alice.token, 'PATCH', `/api/sessions/${a.id}`, { pinned: true, group: '  Finance   team ' });
  assert.equal(patched.body.pinned, true);
  assert.equal(patched.body.group, 'Finance team');
  assert.equal((await t.call(alice.token, 'PATCH', `/api/sessions/${a.id}`, { pinned: false, group: '' })).body.group, undefined);

  // Newest first, two at a time, then the rest after the cursor.
  const p1 = await q('limit=2');
  assert.equal(p1.sessions.length, 2);
  assert.ok(p1.next);
  const p2 = await q(`limit=2&before=${encodeURIComponent(p1.next!)}`);
  assert.equal(p2.sessions.length, 1);
  assert.equal(p2.next, undefined);
  assert.deepEqual([...p1.sessions, ...p2.sessions].map((x) => x.id).sort(), [a.id, b.id, c.id].sort());
  await t.close();
});

test('sessions: history in pages, and a fork at a turn gets that much of the conversation and a copy of the workspace, never the original folder', async () => {
  const t = await setup({ plugins: [], bundled: [] });
  const alice = await t.member('Alice');
  const s = await t.harness.sessions.create({ title: 'original', model: 'deepseek-flash', runtime: { kind: 'docker', network: 'none' }, owner: alice.id });
  const text = (role: 'user' | 'assistant', x: string) => ({ role, content: [{ type: 'text' as const, text: x }] });
  await s.adoptHistory({ history: [text('user', 'first question'), text('assistant', 'answer one'), text('user', 'second question'), text('assistant', 'answer two')], todos: [], tainted: true, contextStart: 0, compactions: 0, lastPromptTokens: 0 });
  await fs.writeFile(path.join(s.workspace, 'notes.txt'), 'workspace file');

  const h1 = (await t.call(alice.token, 'GET', `/api/sessions/${s.meta.id}/history?limit=3`)).body;
  assert.deepEqual({ total: h1.total, after: h1.after, n: h1.messages.length, next: h1.next }, { total: 4, after: 0, n: 3, next: 3 });
  const h2 = (await t.call(alice.token, 'GET', `/api/sessions/${s.meta.id}/history?after=3&limit=3`)).body;
  assert.deepEqual({ n: h2.messages.length, next: h2.next, text: h2.messages[0].content[0].text }, { n: 1, next: undefined, text: 'answer two' });

  const bob = await t.member('Bob');
  assert.equal((await t.call(bob.token, 'POST', `/api/sessions/${s.meta.id}/fork`, { turn: 1 })).status, 404);
  assert.equal((await t.call(alice.token, 'POST', `/api/sessions/${s.meta.id}/fork`, { turn: 3 })).status, 400);
  const f = await t.call(alice.token, 'POST', `/api/sessions/${s.meta.id}/fork`, { turn: 1 });
  assert.equal(f.status, 201, f.text);
  assert.deepEqual(f.body.forkedFrom, { id: s.meta.id, turn: 1 });
  assert.equal(f.body.owner, alice.id);
  assert.equal(f.body.tainted, true, 'what the original read still counts');
  const fork = t.harness.sessions.get(f.body.id)!;
  assert.deepEqual(fork.history.map((m) => (m.content[0] as { text: string }).text), ['first question', 'answer one']);
  assert.notEqual(fork.workspace, s.workspace);
  assert.equal(await fs.readFile(path.join(fork.workspace, 'notes.txt'), 'utf8'), 'workspace file');
  await fs.writeFile(path.join(fork.workspace, 'notes.txt'), 'changed in the fork');
  assert.equal(await fs.readFile(path.join(s.workspace, 'notes.txt'), 'utf8'), 'workspace file', 'the original is untouched');
  const whole = (await t.call(alice.token, 'POST', `/api/sessions/${s.meta.id}/fork`, {})).body;
  assert.equal(t.harness.sessions.get(whole.id)!.history.length, 4, 'no turn: all of it');
  // A server folder that is not a repository cannot be forked without sharing it.
  const local = await t.harness.sessions.create({ model: 'deepseek-flash', runtime: { kind: 'local', network: 'none', path: t.work } });
  assert.equal((await t.call(OPERATOR, 'POST', `/api/sessions/${local.meta.id}/fork`, {})).status, 409);
  await t.close();
});

test('attachments: images go to a model that sees images; other files, and images for one that does not, are saved under .harness/uploads', async () => {
  const t = await setup({ plugins: [], bundled: [] });
  t.harness.registry.models.set('deepseek-blind', { ...getModel('deepseek-flash'), id: 'deepseek-blind', label: 'Blind', vision: false });
  const png = testPicture(16, 16);
  const pdf = Buffer.from('%PDF-1.4\n% a test document\n');
  const atts = [{ name: 'shot.png', mediaType: 'image/png', base64: png.toString('base64') }, { name: '../../report.pdf', mediaType: 'application/pdf', base64: pdf.toString('base64') }];

  const seeing = await t.harness.sessions.create({ model: 'deepseek-flash', runtime: { kind: 'local', network: 'none', path: await tempDir() } });
  const f1 = new FakeProvider([{ text: 'I see it' }]);
  t.harness.registry.setProviderInstance('deepseek', f1);
  let done = turnEnd(seeing);
  const r1 = await t.call(OPERATOR, 'POST', `/api/sessions/${seeing.meta.id}/messages`, { text: 'look at these', attachments: atts });
  assert.equal(r1.status, 202, r1.text);
  assert.deepEqual(r1.body, { state: 'started', images: ['shot.png'], files: ['.harness/uploads/report.pdf'] });
  await done;
  const last = f1.requests[0]!.messages.filter((m) => m.role === 'user').at(-1)!;
  const img = last.content.find((b) => b.type === 'image') as { media_type: string; data: string } | undefined;
  assert.ok(img, 'an image block went to the model');
  assert.equal(img!.media_type, 'image/png');
  assert.equal(img!.data, png.toString('base64'));
  assert.match(JSON.stringify(last), /Files attached, saved in the workspace: \.harness\/uploads\/report\.pdf/);
  assert.deepEqual(await fs.readFile(path.join(seeing.workspace, '.harness', 'uploads', 'report.pdf')), pdf);
  assert.ok(seeing.history.some((m) => m.content.some((b) => b.type === 'image')), 'kept in the history');

  const blind = await t.harness.sessions.create({ model: 'deepseek-blind', runtime: { kind: 'local', network: 'none', path: await tempDir() } });
  const f2 = new FakeProvider([{ text: 'noted' }]);
  t.harness.registry.setProviderInstance('deepseek', f2);
  done = turnEnd(blind);
  const r2 = await t.call(OPERATOR, 'POST', `/api/sessions/${blind.meta.id}/messages`, { text: 'look', attachments: [atts[0]] });
  assert.deepEqual(r2.body, { state: 'started', images: [], files: ['.harness/uploads/shot.png'] });
  await done;
  assert.ok(!f2.requests[0]!.messages.some((m) => m.content.some((b) => b.type === 'image')), 'no image to a model that cannot see');
  assert.match(JSON.stringify(f2.requests[0]!.messages.filter((m) => m.role === 'user').at(-1)), /\.harness\/uploads\/shot\.png/);
  assert.deepEqual(await fs.readFile(path.join(blind.workspace, '.harness', 'uploads', 'shot.png')), png);
  // A second upload of the same name gets a free one; a fake image is a file, not an image block.
  const r3 = await t.call(OPERATOR, 'POST', `/api/sessions/${blind.meta.id}/messages`, { text: 'again', attachments: [{ name: 'shot.png', mediaType: 'image/png', base64: Buffer.from('not a png').toString('base64') }] });
  assert.deepEqual(r3.body.files, ['.harness/uploads/shot-2.png']);
  // Limits.
  assert.equal((await t.call(OPERATOR, 'POST', `/api/sessions/${blind.meta.id}/messages`, { text: 'x', attachments: Array.from({ length: 11 }, () => atts[1]) })).status, 400);
  assert.equal((await t.call(OPERATOR, 'POST', `/api/sessions/${blind.meta.id}/messages`, { text: 'x', attachments: [{ name: 'a' }] })).status, 400);
  assert.equal((await t.call(OPERATOR, 'POST', `/api/sessions/${blind.meta.id}/messages`, { text: 'x', attachments: [{ name: 'big.bin', mediaType: 'application/octet-stream', base64: Buffer.alloc(20 * 1024 * 1024 + 10).toString('base64') }] })).status, 413);
  await t.close();
});

test('effective settings: each value with its tier (default, operator, account, project) and whether the person can change it; plugins\' account sections', async () => {
  const opFile = path.join(await tempDir(), 'operator.json');
  await fs.writeFile(opFile, JSON.stringify({ maxSteps: 80, permissions: { deny: ['bash(rm -rf *)'] }, maxSubagentDepth: 2 }));
  process.env.HARNESS_SETTINGS = opFile;
  try {
    const t = await setup({ plugins: [] });
    const alice = await t.member('Alice');
    await t.call(alice.token, 'PUT', '/api/me/settings', { maxSteps: 40, maxCostUsd: 99, permissions: { deny: ['web_fetch'], allow: ['read'] }, plugins: { 'quality-gates': { timeoutMinutes: 3 } } });
    const s = await t.harness.sessions.create({ model: 'deepseek-flash', runtime: { kind: 'local', network: 'none', path: t.work }, owner: alice.id });
    await fs.mkdir(path.join(t.work, '.harness'), { recursive: true });
    await fs.writeFile(path.join(t.work, '.harness', 'settings.json'), JSON.stringify({ permissions: { ask: ['bash'] } }));
    const eff = (await t.call(alice.token, 'GET', `/api/settings/effective?session=${s.meta.id}`)).body as { settings: { key: string; value: unknown; source: string; locked: boolean; scope: string; max?: number; layers: Record<string, unknown> }[]; project: boolean };
    const k = (key: string) => eff.settings.find((x) => x.key === key)!;
    assert.equal(eff.project, true);
    assert.deepEqual([k('maxSteps').value, k('maxSteps').source, k('maxSteps').max, k('maxSteps').locked], [40, 'account', 80, false]);
    assert.deepEqual(k('maxSteps').layers, { default: 150, operator: 80, account: 40 });
    assert.deepEqual([k('maxCostUsd').value, k('maxCostUsd').source], [5, 'default'], 'a higher limit of hers does not count');
    assert.deepEqual([k('maxSubagentDepth').value, k('maxSubagentDepth').source, k('maxSubagentDepth').locked], [2, 'operator', true]);
    assert.deepEqual([k('maxParallelSubagents').source, k('maxParallelSubagents').locked], ['default', true]);
    assert.deepEqual(k('permissions.deny').value, ['bash(rm -rf *)', 'web_fetch']);
    assert.equal(k('permissions.deny').source, 'operator');
    assert.deepEqual(k('permissions.allow').layers, { account: ['read'] });
    assert.deepEqual([k('permissions.ask').value, k('permissions.ask').source], [['bash'], 'project']);
    assert.deepEqual([k('plugins.quality-gates.timeoutMinutes').value, k('plugins.quality-gates.timeoutMinutes').source, k('plugins.quality-gates.timeoutMinutes').scope], [3, 'account', 'account']);
    assert.deepEqual([k('plugins.quality-gates.advisory').value, k('plugins.quality-gates.advisory').source], ['report', 'default']);
    // Changing only the core settings keeps the plugins' sections.
    await t.call(alice.token, 'PUT', '/api/me/settings', { maxSteps: 30 });
    assert.equal(((await t.call(alice.token, 'GET', '/api/settings/effective')).body.settings as { key: string; value: unknown }[]).find((x) => x.key === 'plugins.quality-gates.timeoutMinutes')!.value, 3);
    const bob = await t.member('Bob');
    assert.equal((await t.call(bob.token, 'GET', `/api/settings/effective?session=${s.meta.id}`)).status, 404, 'not his session');
    assert.equal(((await t.call(bob.token, 'GET', '/api/settings/effective')).body.settings as { key: string; source: string }[]).find((x) => x.key === 'maxSteps')!.source, 'operator');
    await t.close();
  } finally { delete process.env.HARNESS_SETTINGS; }
});

test('a session the global stream reports: created and deleted through the API reach its owner', async () => {
  const t = await setup({ plugins: [], bundled: [] });
  const so = await events(t.base, OPERATOR);
  const made = await t.harness.sessions.create({ model: 'deepseek-flash', runtime: { kind: 'local', network: 'none', path: t.work } });
  assert.equal((await t.call(OPERATOR, 'DELETE', `/api/sessions/${made.meta.id}`)).status, 200);
  const del = await so.until((e) => e.topic === 'sessions' && e.payload.type === 'deleted', 'deleted');
  assert.equal((del.payload.session as { id: string }).id, made.meta.id);
  so.close();
  await t.close();
});
