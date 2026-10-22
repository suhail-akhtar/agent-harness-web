import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTOCOL, type Capability } from '../packages/plugin-ui/src/index.ts';
import { badParams, handleFrameCall, type FrameCallContext } from '../apps/desktop/renderer/src/registry/frame-host.ts';
import { APP_CSP, APP_ORIGIN, apiRequestAllowed, appFrameAllowed, backoffMs, parseDeepLink, pluginCsp, pluginFilePath, previewCsp } from '../apps/desktop/electron/policy.ts';

const call = (method: string, params?: unknown, gesture = false, id = 1) => ({ protocol: PROTOCOL, kind: 'call', id, method, params, gesture });

function ctx(granted: Capability[], o: Partial<FrameCallContext> = {}): FrameCallContext & { calls: string[]; asked: string[] } {
  const calls: string[] = [];
  const asked: string[] = [];
  const impl = new Proxy({}, { get: (_t, m: string) => (p: unknown) => { calls.push(m); return { method: m, p }; } });
  return { plugin: 'acme', granted, gestureSeen: () => false, confirm: async (q) => { asked.push(q); return false; }, impl, calls, asked, ...o } as FrameCallContext & { calls: string[]; asked: string[] };
}

test('frame host: what every frame may call works; anything not granted is refused with the reason', async () => {
  const c = ctx([]);
  assert.deepEqual(await handleFrameCall(call('theme.get'), c), { protocol: PROTOCOL, kind: 'result', id: 1, ok: true, value: { method: 'theme.get', p: {} } });
  const r = await handleFrameCall(call('sessions.list', {}, false, 2), c);
  assert.equal(r!.ok, false);
  assert.match(r!.error!, /needs the "sessions.read" capability/);
  assert.match((await handleFrameCall(call('approvals.list'), c))!.error!, /approvals.respond/);
  assert.match((await handleFrameCall(call('routes.call', { path: 'x' }), c))!.error!, /routes.call/);
  assert.match((await handleFrameCall(call('evil.method'), c))!.error!, /unknown method/);
  assert.match((await handleFrameCall(call('__proto__'), c))!.error!, /unknown method/);
  assert.equal(await handleFrameCall({ kind: 'call', id: 1, method: 'theme.get' }, c), undefined, 'not our protocol: no answer');
  assert.equal(await handleFrameCall('hello', c), undefined);
  assert.equal((await handleFrameCall({ protocol: PROTOCOL, kind: 'call', id: 'x', method: 'theme.get' }, c)), undefined, 'no id to answer');
  assert.deepEqual(c.calls, ['theme.get'], 'nothing refused reached the implementation');
});

test('frame host: gestures the host did not see, bad arguments and declined confirmations are refused', async () => {
  const granted: Capability[] = ['approvals.respond', 'clipboard.write', 'external.open', 'routes.call', 'sessions.start'];
  const c = ctx(granted);
  // The frame claims a gesture but the host saw none.
  assert.match((await handleFrameCall(call('approvals.respond', { sessionId: 's', requestId: 'r', decision: 'allow' }, true), c))!.error!, /right after a click/);
  assert.match((await handleFrameCall(call('clipboard.write', { text: 'x' }, false), ctx(granted, { gestureSeen: () => true })))!.error!, /right after a click/, 'the host saw one but the frame did not report it');
  const clicked = ctx(granted, { gestureSeen: () => true });
  assert.equal((await handleFrameCall(call('clipboard.write', { text: 'x' }, true), clicked))!.ok, true);
  assert.match((await handleFrameCall(call('external.open', { url: 'javascript:alert(1)' }, true), clicked))!.error!, /http\(s\)/);
  assert.match((await handleFrameCall(call('routes.call', { path: '../admin' }), c))!.error!, /own route paths/);
  assert.match((await handleFrameCall(call('routes.call', { path: 'x', method: 'DELETE' }), c))!.error!, /GET or POST/);
  // sessions.start without a click: the person is asked, and here they say no.
  const r = await handleFrameCall(call('sessions.start', { title: 'T', prompt: 'do it' }), c);
  assert.equal(r!.error, 'the person declined');
  assert.match(c.asked[0]!, /acme wants to start a conversation "T"/);
  // With a click it goes ahead without asking.
  assert.equal((await handleFrameCall(call('sessions.start', { title: 'T' }, true), clicked))!.ok, true);
  assert.deepEqual(c.calls, []);
});

test('frame host: argument checks', () => {
  assert.match(badParams('storage.set', { key: '../other', value: 1 })!, /storage keys/);
  assert.match(badParams('storage.set', { key: 'k', value: 'x'.repeat(300_000) })!, /limited/);
  assert.equal(badParams('storage.set', { key: 'k.v-1', value: { a: 1 } }), undefined);
  assert.match(badParams('events.subscribe', { topic: 'secrets' })!, /topic is one of/);
  assert.match(badParams('sessions.get', { id: '../../etc' })!, /not a session id/);
  assert.match(badParams('badge.set', { name: 'x', value: { a: 1 } })!, /badge/);
  assert.match(badParams('frame.resize', { height: 1e9 })!, /height/);
});

test('scheme policies: the app, plugin frames and previews', () => {
  assert.match(APP_CSP, /form-action 'none'/);
  assert.match(APP_CSP, /object-src 'none'/);
  assert.doesNotMatch(APP_CSP, /'unsafe-eval'/, 'no eval for the app (wasm-unsafe-eval only)');
  const p = pluginCsp('acme');
  assert.match(p, /connect-src 'none'/);
  assert.match(p, /sandbox allow-scripts allow-forms/);
  assert.match(p, new RegExp(`script-src 'unsafe-inline' ${APP_ORIGIN}/plugins/acme/ ${APP_ORIGIN}/sdk/`));
  assert.doesNotMatch(p, /harness:\s|harness:;|'self'/, 'no scheme-wide source that would reach the API');
  assert.doesNotMatch(p, /allow-same-origin/);
  const v = previewCsp('tok');
  assert.match(v, /connect-src 'none'/);
  assert.match(v, /sandbox allow-scripts;?$/);
  assert.doesNotMatch(v, /allow-same-origin|unsafe-eval/);
});

test('API proxy: only the app\'s own fetches reach the engine', () => {
  const h = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null });
  assert.deepEqual(apiRequestAllowed(h({})), { ok: true });
  assert.deepEqual(apiRequestAllowed(h({ origin: APP_ORIGIN, 'sec-fetch-dest': 'empty', 'sec-fetch-site': 'same-origin' })), { ok: true });
  assert.equal(apiRequestAllowed(h({ origin: 'null' })).ok, false, 'an opaque frame');
  assert.equal(apiRequestAllowed(h({ 'sec-fetch-dest': 'image' })).ok, false, 'an <img> aimed at the API');
  assert.equal(apiRequestAllowed(h({ 'sec-fetch-dest': 'iframe' })).ok, false);
  assert.equal(apiRequestAllowed(h({ 'sec-fetch-site': 'cross-site' })).ok, false);
  assert.equal(apiRequestAllowed(h({ origin: 'https://evil.example' })).ok, false);
});

test('IPC answers only the app\'s top frame; plugin file paths stay inside the plugin; deep links', () => {
  assert.ok(appFrameAllowed({ url: 'harness://app/', isTopFrame: true }));
  assert.ok(!appFrameAllowed({ url: 'harness://app/plugins/acme/ui/index.html', isTopFrame: false }), 'a plugin frame');
  assert.ok(!appFrameAllowed({ url: 'harness://preview/x/index.html', isTopFrame: true }));
  assert.ok(!appFrameAllowed({ url: 'https://example.com/', isTopFrame: true }));
  assert.ok(!appFrameAllowed(null));
  assert.deepEqual(pluginFilePath('/plugins/acme/ui/index.html'), { plugin: 'acme', file: 'ui/index.html' });
  assert.equal(pluginFilePath('/plugins/acme/../../etc/passwd'), null);
  assert.equal(pluginFilePath('/plugins/acme/ui/%2e%2e/x'), null);
  assert.equal(pluginFilePath('/plugins/acme/C:%5Cwin'), null);
  assert.equal(pluginFilePath('/plugins/../x'), null);
  assert.deepEqual(parseDeepLink('harness://open?session=0123456789abcdef'), { action: 'open', params: { session: '0123456789abcdef' } });
  assert.deepEqual(parseDeepLink('harness://new?prompt=hi%20there'), { action: 'new', params: { prompt: 'hi there' } });
  assert.equal(parseDeepLink('harness://app/api/sessions'), null, 'never the app origin');
  assert.equal(parseDeepLink('https://example.com'), null);
  assert.deepEqual([1, 2, 3, 6, 9].map(backoffMs), [1000, 2000, 4000, 30000, 30000]);
});
