import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { createHarness } from '../src/kernel/harness.ts';
import { createApp } from '../src/server/app.ts';
import { BrowserSessions, NOBODY_ALLOWED, OidcClient, oidcConfigFromEnv, type OidcConfig, verifyIdToken } from '../src/server/oidc.ts';
import { SpendLedger, UserStore } from '../src/server/users.ts';
import { FakeProvider, tempDir } from './helpers.ts';

// Single sign-on against a fake OpenID provider on 127.0.0.1: discovery, a
// JWKS with generated keys, an authorize endpoint that redirects back with a
// code, and a token endpoint that checks the client, the redirect URI and the
// PKCE verifier before returning a signed id_token.

const OPERATOR = 'operator-token-for-tests';
const CLIENT = 'harness-client';
const SECRET = 'client-secret-for-tests';
const PUBLIC = 'http://harness.test';

function signJwt(alg: string, key: crypto.KeyObject, header: object, payload: object): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = Buffer.from(`${enc({ alg, typ: 'JWT', ...header })}.${enc(payload)}`);
  const sig = alg === 'PS256' ? crypto.sign('sha256', data, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST })
    : alg === 'ES256' ? crypto.sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' })
    : alg === 'EdDSA' ? crypto.sign(null, data, key)
    : crypto.sign('sha256', data, key);
  return `${data.toString()}.${sig.toString('base64url')}`;
}

function rsaKey(kid: string) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}

interface Knobs { email?: string; sub?: string; claims?: Record<string, unknown>; header?: Record<string, unknown>; signWith?: crypto.KeyObject; badSignature?: boolean; pkceMismatch?: boolean }

async function fakeIdp() {
  const idp = { issuer: '', next: {} as Knobs, keys: [rsaKey('k1')], jwksHits: 0, discoveryHits: 0, endSession: false, close: async () => {} };
  const codes = new Map<string, { challenge: string; nonce: string; redirect: string; knobs: Knobs }>();
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', idp.issuer);
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (u.pathname === '/.well-known/openid-configuration') {
      idp.discoveryHits++;
      return json(200, { issuer: idp.issuer, authorization_endpoint: `${idp.issuer}/authorize`, token_endpoint: `${idp.issuer}/token`, jwks_uri: `${idp.issuer}/jwks`, response_types_supported: ['code'], token_endpoint_auth_methods_supported: ['client_secret_basic'], ...(idp.endSession ? { end_session_endpoint: `${idp.issuer}/logout` } : {}) });
    }
    if (u.pathname === '/jwks') { idp.jwksHits++; return json(200, { keys: idp.keys.map((k) => k.jwk) }); }
    if (u.pathname === '/authorize') {
      const q = u.searchParams;
      if (q.get('response_type') !== 'code' || q.get('client_id') !== CLIENT || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('state') || !q.get('nonce') || q.get('scope') !== 'openid email profile') return json(400, { error: 'invalid_request' });
      const code = crypto.randomBytes(12).toString('hex');
      codes.set(code, { challenge: q.get('code_challenge')!, nonce: q.get('nonce')!, redirect: q.get('redirect_uri')!, knobs: idp.next });
      idp.next = {};
      res.writeHead(302, { location: `${q.get('redirect_uri')}?code=${code}&state=${encodeURIComponent(q.get('state')!)}` });
      return void res.end();
    }
    if (u.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      const body = new URLSearchParams(raw);
      if (req.headers.authorization !== `Basic ${Buffer.from(`${CLIENT}:${SECRET}`).toString('base64')}`) return json(401, { error: 'invalid_client' });
      const c = codes.get(body.get('code') ?? '');
      codes.delete(body.get('code') ?? '');
      if (!c || body.get('grant_type') !== 'authorization_code' || body.get('redirect_uri') !== c.redirect) return json(400, { error: 'invalid_grant' });
      // The knob stands for a code that was issued to a different sign-in (another verifier).
      const challenge = c.knobs.pkceMismatch ? crypto.createHash('sha256').update('another-verifier').digest('base64url') : c.challenge;
      if (crypto.createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url') !== challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      const now = Math.floor(Date.now() / 1000);
      const key = idp.keys[0]!;
      const payload = { iss: idp.issuer, sub: c.knobs.sub ?? 'sub-alice', aud: CLIENT, iat: now, exp: now + 300, nonce: c.nonce, email: c.knobs.email ?? 'alice@example.com', email_verified: true, name: 'Alice', ...c.knobs.claims };
      let token = signJwt('RS256', c.knobs.signWith ?? key.privateKey, { kid: key.kid, ...c.knobs.header }, payload);
      if (c.knobs.badSignature) {
        // Same signature, changed payload: someone edited the token on the way.
        const [h, , s] = token.split('.');
        token = `${h}.${Buffer.from(JSON.stringify({ ...payload, email: 'boss@example.com' })).toString('base64url')}.${s}`;
      }
      return json(200, { access_token: 'at', token_type: 'Bearer', id_token: token });
    }
    json(404, { error: 'not found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  idp.issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  idp.close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
  return idp;
}
type Idp = Awaited<ReturnType<typeof fakeIdp>>;

async function setup(idp: Idp, opts: { cfg?: Partial<OidcConfig>; data?: string; dailyCap?: number } = {}) {
  const data = opts.data ?? await tempDir();
  const users = await new UserStore(data).load();
  const spend = await new SpendLedger(data, opts.dailyCap).load();
  const harness = await createHarness({ dataDir: data, search: null, spend });
  harness.registry.setProviderInstance('deepseek', new FakeProvider(Array.from({ length: 5 }, () => ({ text: 'ok' }))));
  const cfg: OidcConfig = { issuer: idp.issuer, clientId: CLIENT, clientSecret: SECRET, publicUrl: PUBLIC, scopes: 'openid email profile', allowedDomains: ['example.com'], allowedEmails: ['guest@partner.example'], admins: ['boss@example.com'], only: false, ...opts.cfg };
  const sessions = await new BrowserSessions(data).load();
  const { server } = createApp({ harness, token: OPERATOR, loopback: true, localRoots: [], uiDir: path.join(data, 'ui'), appRoot: data, users, spend, sso: { client: new OidcClient(cfg), sessions } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const call = async (method: string, p: string, o: { cookie?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-harness': '1' } : {}), ...o.headers },
      body: method === 'GET' ? undefined : JSON.stringify(o.body ?? {}),
    });
    const text = await res.text();
    let json: unknown; try { json = JSON.parse(text); } catch { json = text; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: json as any, headers: res.headers };
  };

  /** A browser signing in: harness -> provider -> callback, carrying the cookies a browser would. */
  const signIn = async (knobs: Knobs = {}) => {
    idp.next = knobs;
    const start = await fetch(`${base}/auth/login`, { redirect: 'manual' });
    assert.equal(start.status, 302, await start.clone().text());
    const bindingCookie = start.headers.getSetCookie().find((c) => c.startsWith('hw_oidc='))!;
    const binding = bindingCookie.split(';')[0]!;
    const atIdp = await fetch(start.headers.get('location')!, { redirect: 'manual' });
    assert.equal(atIdp.status, 302, 'the provider accepted the authorization request (code, S256 challenge, state, nonce, scopes)');
    const back = new URL(atIdp.headers.get('location')!);
    assert.equal(`${back.origin}${back.pathname}`, `${PUBLIC}/auth/callback`);
    const callbackPath = back.pathname + back.search;
    const done = await fetch(base + callbackPath, { redirect: 'manual', headers: { cookie: binding } });
    const sid = done.headers.getSetCookie().find((c) => c.startsWith('hw_sid='));
    return { status: done.status, text: await done.text(), cookie: sid?.split(';')[0], setCookie: sid, location: done.headers.get('location'), callbackPath, binding, bindingCookie };
  };

  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await sessions.flush();
    await harness.close();
  };
  return { data, base, users, spend, harness, call, signIn, close };
}

test('single sign-on: the first sign-in makes the account and a cookie session that uses the API and the event stream; the next reuses it', async () => {
  const idp = await fakeIdp();
  const t = await setup(idp, { dailyCap: 0.01 });
  assert.deepEqual((await t.call('GET', '/auth/config')).body, { oidc: true, only: false, login: '/auth/login' });

  const a = await t.signIn();
  assert.equal(a.status, 302, a.text);
  assert.equal(a.location, `${PUBLIC}/`);
  assert.ok(a.cookie, 'a session cookie is set');
  for (const attr of ['HttpOnly', 'SameSite=Lax', 'Path=/']) assert.ok(a.setCookie!.includes(attr), attr);
  assert.ok(!a.setCookie!.includes('Secure'), 'not Secure on an http public URL');
  assert.match(a.cookie!, /^hw_sid=[\w-]{40,}$/, 'an opaque random id, not a token or claims');
  const me = (await t.call('GET', '/api/me', { cookie: a.cookie })).body;
  assert.equal(me.name, 'alice@example.com');
  assert.equal(me.email, 'alice@example.com');
  assert.equal(me.role, 'member');
  assert.equal(t.users.size, 1);
  const alice = t.users.list()[0]!;
  assert.deepEqual(alice.sso, { iss: idp.issuer, sub: 'sub-alice', email: 'alice@example.com' });
  assert.equal(idp.discoveryHits, 1, 'discovery is cached');

  // Ownership, spend limits and the event stream work exactly as for a token.
  const work = await tempDir();
  const mine = await t.harness.sessions.create({ model: 'deepseek-flash', runtime: { kind: 'local', network: 'none', path: work }, owner: alice.id });
  const theirs = await t.harness.sessions.create({ model: 'deepseek-flash', runtime: { kind: 'local', network: 'none', path: work }, owner: 'usr_someoneelse' });
  assert.deepEqual((await t.call('GET', '/api/sessions', { cookie: a.cookie })).body.map((s: { id: string }) => s.id), [mine.meta.id]);
  assert.equal((await t.call('GET', `/api/sessions/${theirs.meta.id}`, { cookie: a.cookie })).status, 404);
  assert.equal((await t.call('POST', '/api/sessions', { cookie: a.cookie, body: { runtime: 'local', path: work } })).status, 403, 'members get no server folders');
  const ac = new AbortController();
  const stream = fetch(`${t.base}/api/sessions/${mine.meta.id}/events`, { headers: { cookie: a.cookie! }, signal: ac.signal });
  assert.equal((await t.call('POST', `/api/sessions/${mine.meta.id}/messages`, { cookie: a.cookie, body: { text: 'hello' } })).status, 202);
  const ev = await stream;
  assert.equal(ev.status, 200);
  assert.match(ev.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = ev.body!.getReader();
  let seen = '';
  while (!seen.includes('"turn_end"')) { const { value, done } = await reader.read(); if (done) break; seen += new TextDecoder().decode(value); }
  assert.ok(seen.includes('"turn_end"'), 'the stream delivered the turn');
  ac.abort();
  t.spend.add(alice.id, 1);
  const over = await t.call('POST', `/api/sessions/${mine.meta.id}/messages`, { cookie: a.cookie, body: { text: 'again' } });
  assert.equal(over.status, 429);
  assert.match(String(over.body.error), /daily spend limit/);

  // The second sign-in reuses the account.
  const b = await t.signIn();
  assert.equal(b.status, 302);
  assert.notEqual(b.cookie, a.cookie);
  assert.equal(t.users.size, 1);
  assert.equal((await t.call('GET', '/api/me', { cookie: b.cookie })).body.id, alice.id);

  // An address in HARNESS_OIDC_ADMINS is an administrator; an allowed e-mail outside the domains gets in too.
  const boss = await t.signIn({ email: 'boss@example.com', sub: 'sub-boss' });
  assert.equal((await t.call('GET', '/api/me', { cookie: boss.cookie })).body.role, 'admin');
  assert.equal((await t.call('GET', '/api/users', { cookie: boss.cookie })).status, 200);
  assert.equal((await t.call('GET', '/api/users', { cookie: a.cookie })).status, 403);
  assert.equal((await t.signIn({ email: 'guest@partner.example', sub: 'sub-guest' })).status, 302);
  assert.equal(t.users.size, 3);
  await t.close();
  await idp.close();
});

test('single sign-on refuses: other domains, an unverified e-mail, a wrong nonce, audience, issuer or azp, expired tokens, bad signatures, unknown keys, replays, PKCE mismatches', async () => {
  const idp = await fakeIdp();
  const t = await setup(idp);
  const now = Math.floor(Date.now() / 1000);
  const refused = async (knobs: Knobs, pattern: RegExp, status?: number) => {
    const r = await t.signIn(knobs);
    assert.ok(r.status >= 400, `${pattern}: got ${r.status} ${r.text}`);
    if (status) assert.equal(r.status, status);
    assert.match(r.text, pattern);
    assert.equal(r.cookie, undefined, 'no session');
  };
  await refused({ email: 'eve@evil.example', sub: 'sub-eve' }, /eve@evil\.example may not sign in/, 403);
  await refused({ email: 'eve@sub.example.com', sub: 'sub-eve' }, /may not sign in/, 403);
  await refused({ claims: { email_verified: false } }, /not verified this e-mail/);
  // No claim at all is not a yes: the address decides the allowlist and the administrators.
  await refused({ claims: { email_verified: undefined } }, /did not say this e-mail address is verified/);
  await refused({ claims: { nonce: 'someone-elses-nonce' } }, /nonce/);
  await refused({ claims: { aud: 'another-client' } }, /another application \(aud\)/);
  await refused({ claims: { aud: [CLIENT, 'another-client'] } }, /azp/);
  await refused({ claims: { aud: CLIENT, azp: 'another-client' } }, /azp/);
  await refused({ claims: { iss: 'https://evil.example' } }, /comes from https:\/\/evil\.example/);
  await refused({ claims: { exp: now - 3600, iat: now - 7200 } }, /expired/);
  await refused({ claims: { iat: now + 3600, exp: now + 7200 } }, /issued in the future/);
  await refused({ claims: { nbf: now + 3600 } }, /not valid yet/);
  await refused({ claims: { email: undefined } }, /no e-mail address/);
  await refused({ badSignature: true }, /signature does not verify/);
  await refused({ pkceMismatch: true }, /PKCE verification failed/);
  // A key the provider does not publish: the JWKS is fetched again once, then refused.
  const hits = idp.jwksHits;
  await refused({ header: { kid: 'stranger' }, signWith: rsaKey('stranger').privateKey }, /does not publish \(kid stranger\)/);
  assert.equal(idp.jwksHits, hits + 1);
  // A key we do publish, but the token is signed by another: the signature check catches it.
  await refused({ signWith: rsaKey('k1').privateKey }, /signature does not verify/);
  assert.equal(t.users.size, 0, 'no refused sign-in made an account');

  // Several audiences with azp naming us are fine.
  assert.equal((await t.signIn({ claims: { aud: [CLIENT, 'another-client'], azp: CLIENT } })).status, 302);
  // The provider rotates its key: the unknown kid fetches the JWKS again and the sign-in works.
  idp.keys = [rsaKey('k2')];
  const rotated = await t.signIn();
  assert.equal(rotated.status, 302, rotated.text);

  // A state is good once; a callback without the browser's binding cookie is refused.
  const replay = await fetch(t.base + rotated.callbackPath, { redirect: 'manual', headers: { cookie: rotated.binding } });
  assert.equal(replay.status, 400);
  assert.match(await replay.text(), /expired or was already used/);
  idp.next = {};
  const start = await fetch(`${t.base}/auth/login`, { redirect: 'manual' });
  const back = new URL((await fetch(start.headers.get('location')!, { redirect: 'manual' })).headers.get('location')!);
  const foreign = await fetch(t.base + back.pathname + back.search, { redirect: 'manual' });
  assert.equal(foreign.status, 400);
  assert.match(await foreign.text(), /started in another browser/);
  const forged = await fetch(`${t.base}/auth/callback?code=x&state=made-up`, { redirect: 'manual', headers: { cookie: rotated.binding } });
  assert.equal(forged.status, 400);
  await t.close();
  await idp.close();
});

test('single sign-on: nobody gets in until the operator sets an allowlist; disabled accounts are refused and lose their sessions', async () => {
  const idp = await fakeIdp();
  const closed = await setup(idp, { cfg: { allowedDomains: [], allowedEmails: [] } });
  const r = await closed.signIn();
  assert.equal(r.status, 403);
  assert.ok(r.text.includes(NOBODY_ALLOWED), r.text);
  await closed.close();

  const t = await setup(idp);
  const a = await t.signIn();
  const id = (await t.call('GET', '/api/me', { cookie: a.cookie })).body.id as string;
  assert.equal((await t.call('POST', `/api/users/${id}/disable`, { token: OPERATOR })).status, 200);
  assert.equal((await t.call('GET', '/api/me', { cookie: a.cookie })).status, 401, 'the open session ends at once');
  const again = await t.signIn();
  assert.equal(again.status, 403);
  assert.match(again.text, /disabled/);
  await t.call('POST', `/api/users/${id}/enable`, { token: OPERATOR });
  assert.equal((await t.signIn()).status, 302);
  await t.close();
  await idp.close();
});

test('single sign-on: cookie-authenticated writes need the x-harness header and our own Origin; logout ends the session', async () => {
  const idp = await fakeIdp();
  const t = await setup(idp);
  const { cookie } = await t.signIn();
  // A cross-site form can send neither the header nor JSON.
  const form = await fetch(`${t.base}/api/companions`, { method: 'POST', headers: { cookie: cookie!, 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=x' });
  assert.equal(form.status, 403);
  assert.equal((await t.call('POST', '/api/companions', { cookie, body: { name: 'x' }, headers: { 'x-harness': '' } })).status, 403);
  assert.equal((await t.call('POST', '/api/companions', { cookie, body: { name: 'x' }, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await t.call('POST', '/api/companions', { cookie, body: { name: 'x' }, headers: { origin: PUBLIC } })).status, 201);
  assert.equal((await t.call('POST', '/api/companions', { cookie, body: { name: 'y' } })).status, 201);
  // Scripts with a Bearer token are not browsers: Origin does not apply to them.
  assert.equal((await t.call('POST', '/api/companions', { token: OPERATOR, body: { name: 'z' }, headers: { origin: 'https://elsewhere.example' } })).status, 201);

  // Logout: refused cross-site, then the session is gone on the server, not only in the browser.
  assert.equal((await t.call('POST', '/auth/logout', { cookie, headers: { 'x-harness': '' } })).status, 403);
  const out = await t.call('POST', '/auth/logout', { cookie });
  assert.equal(out.status, 200);
  assert.equal(out.body.providerLogout, undefined, 'a provider without a sign-out endpoint (like Google): only the harness session ends');
  assert.ok(out.headers.getSetCookie().some((c) => c.startsWith('hw_sid=;') && c.includes('Max-Age=0')));
  assert.equal((await t.call('GET', '/api/me', { cookie })).status, 401);
  await t.close();
  await idp.close();
});

test('signing out at the provider too, where it offers that (RP-initiated logout): back to this server afterwards', async () => {
  const idp = await fakeIdp();
  idp.endSession = true;
  const t = await setup(idp);
  const { cookie } = await t.signIn();
  const out = await t.call('POST', '/auth/logout', { cookie });
  const u = new URL(out.body.providerLogout);
  assert.equal(u.origin + u.pathname, `${idp.issuer}/logout`);
  assert.equal(u.searchParams.get('client_id'), CLIENT);
  assert.equal(u.searchParams.get('post_logout_redirect_uri'), `${PUBLIC}/`);
  // The id_token it signed in with is the hint (Keycloak then signs out without asking).
  assert.equal(JSON.parse(Buffer.from(u.searchParams.get('id_token_hint')!.split('.')[1]!, 'base64url').toString()).sub, 'sub-alice');
  // Without a provider session (a token sign-in), no provider sign-out is offered.
  const plain = await t.call('POST', '/auth/logout', { token: OPERATOR });
  assert.equal(plain.body.providerLogout, undefined);
  await t.close();
  await idp.close();
});

test('HARNESS_OIDC_ONLY: personal tokens are refused; the operator token and companion tokens keep working', async () => {
  const idp = await fakeIdp();
  const t = await setup(idp, { cfg: { only: true } });
  assert.deepEqual((await t.call('GET', '/auth/config')).body, { oidc: true, only: true, login: '/auth/login' });
  const tok = await t.users.add('Scripted');
  const bearer = await t.call('GET', '/api/me', { token: tok.token });
  assert.equal(bearer.status, 401);
  assert.match(String(bearer.body.error), /Personal access tokens are turned off/);
  assert.equal((await t.call('POST', '/api/login', { body: { token: tok.token } })).status, 401);
  assert.equal((await t.call('GET', '/api/me', { cookie: `hw_token=${tok.token}` })).status, 401);
  assert.equal((await t.call('GET', '/api/me', { token: OPERATOR })).body.role, 'admin');
  assert.equal((await t.call('POST', '/api/login', { body: { token: OPERATOR } })).status, 200);
  const cmp = (await t.call('POST', '/api/companions', { token: OPERATOR, body: { name: 'laptop' } })).body as { token: string };
  const res = await fetch(`${t.base}/api/companion/result`, { method: 'POST', headers: { authorization: `Bearer ${cmp.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jobId: 'none', ok: true }) });
  assert.equal(res.status, 404, 'the companion is recognised (an unknown job, not an unknown token)');
  // People still sign in through the provider.
  const a = await t.signIn();
  assert.equal((await t.call('GET', '/api/me', { cookie: a.cookie })).status, 200);
  await t.close();
  await idp.close();
});

test('single sign-on sessions survive a restart, and the cookie is Secure on an https public URL', async () => {
  const idp = await fakeIdp();
  const first = await setup(idp);
  const a = await first.signIn();
  const id = (await first.call('GET', '/api/me', { cookie: a.cookie })).body.id;
  await first.close();
  const second = await setup(idp, { data: first.data });
  const me = await second.call('GET', '/api/me', { cookie: a.cookie });
  assert.equal(me.status, 200);
  assert.equal(me.body.id, id);
  await second.close();

  const https = await setup(idp, { cfg: { publicUrl: 'https://harness.test' } });
  const start = await fetch(`${https.base}/auth/login`, { redirect: 'manual' });
  const binding = start.headers.getSetCookie().find((c) => c.startsWith('hw_oidc='))!;
  assert.ok(binding.includes('; Secure'), binding);
  assert.match(new URL(start.headers.get('location')!).searchParams.get('redirect_uri')!, /^https:\/\/harness\.test\/auth\/callback$/);
  await https.close();
  await idp.close();
});

test('browser sessions expire after 12 idle hours (use slides it) and after at most 7 days', async () => {
  let now = 1_000_000;
  const data = await tempDir();
  const s = await new BrowserSessions(data, { now: () => now }).load();
  const id = await s.create('usr_a');
  now += 11 * 3_600_000;
  assert.equal(s.get(id), 'usr_a');
  now += 11 * 3_600_000;
  assert.equal(s.get(id), 'usr_a', 'sliding: used 11 hours ago');
  now += 13 * 3_600_000;
  assert.equal(s.get(id), undefined, 'idle too long');
  const id2 = await s.create('usr_b');
  for (let i = 0; i < 15; i++) { now += 11 * 3_600_000; assert.equal(s.get(id2), 'usr_b', `kept alive at ${11 * (i + 1)} hours`); }
  now += 11 * 3_600_000;
  assert.equal(s.get(id2), undefined, 'past the 7-day cap even when used');
  assert.equal(s.get('not-a-session'), undefined);
  // Only hashes are stored.
  const id3 = await s.create('usr_c');
  await s.flush();
  const file = await (await import('node:fs/promises')).readFile(path.join(data, 'browser-sessions.json'), 'utf8');
  assert.ok(!file.includes(id3));
  assert.equal((await new BrowserSessions(data, { now: () => now }).load()).get(id3), 'usr_c');
});

test('id_token signatures: RS256, PS256, ES256 and EdDSA verify; none and HMAC are refused', async () => {
  const base = { iss: 'https://idp.example', aud: CLIENT, sub: 's', nonce: 'n', iat: 100, exp: 400 };
  const opts = (key: crypto.KeyObject) => ({ keyFor: async () => key, issuer: 'https://idp.example', clientId: CLIENT, nonce: 'n', nowSec: 200 });
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const ed = crypto.generateKeyPairSync('ed25519');
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  for (const [alg, pair] of [['RS256', rsa], ['PS256', rsa], ['ES256', ec], ['EdDSA', ed]] as const) {
    const good = signJwt(alg, pair.privateKey, {}, base);
    assert.equal((await verifyIdToken(good, opts(pair.publicKey))).sub, 's', alg);
    const [h, , s] = good.split('.');
    await assert.rejects(verifyIdToken(`${h}.${enc({ ...base, sub: 't' })}.${s}`, opts(pair.publicKey)), /signature does not verify/, alg);
  }
  // A key of the wrong type for the algorithm is not picked.
  const { pickKey } = await import('../src/server/oidc.ts');
  const jwk = { ...ec.publicKey.export({ format: 'jwk' }), kid: 'e' };
  assert.equal(pickKey([jwk], 'e', 'RS256'), undefined);
  assert.equal(pickKey([jwk], 'e', 'ES256'), jwk);
  assert.equal(pickKey([jwk], undefined, 'ES256'), jwk, 'no kid: the only fitting key');
  assert.equal(pickKey([{ ...jwk, use: 'enc' }], 'e', 'ES256'), undefined, 'encryption keys never verify');
  await assert.rejects(verifyIdToken(`${enc({ alg: 'none' })}.${enc(base)}.`, opts(rsa.publicKey)), /algorithm none is not accepted/);
  const hmac = `${enc({ alg: 'HS256' })}.${enc(base)}`;
  await assert.rejects(verifyIdToken(`${hmac}.${crypto.createHmac('sha256', 'secret').update(hmac).digest('base64url')}`, opts(rsa.publicKey)), /algorithm HS256 is not accepted/);
  await assert.rejects(verifyIdToken('not.a-jwt', opts(rsa.publicKey)), /not a signed JWT/);
  // Clock skew: a minute either way is tolerated.
  assert.ok(await verifyIdToken(signJwt('RS256', rsa.privateKey, {}, { ...base, exp: 170 }), opts(rsa.publicKey)));
  await assert.rejects(verifyIdToken(signJwt('RS256', rsa.privateKey, {}, { ...base, exp: 130 }), opts(rsa.publicKey)), /expired/);
});

test('single sign-on configuration from the environment', () => {
  assert.equal(oidcConfigFromEnv({}), undefined);
  assert.throws(() => oidcConfigFromEnv({ HARNESS_OIDC_ONLY: '1' }), /needs single sign-on/);
  assert.throws(() => oidcConfigFromEnv({ HARNESS_OIDC_ISSUER: 'https://idp.example' }), /HARNESS_OIDC_CLIENT_ID and HARNESS_PUBLIC_URL/);
  assert.throws(() => oidcConfigFromEnv({ HARNESS_OIDC_ISSUER: 'http://idp.example', HARNESS_OIDC_CLIENT_ID: 'c', HARNESS_PUBLIC_URL: 'https://h.example' }), /must be an https URL/);
  const c = oidcConfigFromEnv({
    HARNESS_OIDC_ISSUER: 'https://login.microsoftonline.com/tenant/v2.0', HARNESS_OIDC_CLIENT_ID: ' c ', HARNESS_PUBLIC_URL: 'https://harness.example.com/',
    HARNESS_OIDC_ALLOWED_DOMAINS: 'Example.com, @partner.example', HARNESS_OIDC_ALLOWED_EMAILS: 'Guest@Else.example', HARNESS_OIDC_ADMINS: 'Boss@Example.com', HARNESS_OIDC_ONLY: '1',
  })!;
  assert.deepEqual(c, {
    issuer: 'https://login.microsoftonline.com/tenant/v2.0', clientId: 'c', clientSecret: undefined, publicUrl: 'https://harness.example.com', scopes: 'openid email profile',
    allowedDomains: ['example.com', 'partner.example'], allowedEmails: ['guest@else.example'], admins: ['boss@example.com'], only: true, trustEmail: false,
  });
  assert.equal(new OidcClient(c).redirectUri, 'https://harness.example.com/auth/callback');
  assert.equal(oidcConfigFromEnv({ HARNESS_OIDC_ISSUER: 'http://127.0.0.1:9000/realms/x', HARNESS_OIDC_CLIENT_ID: 'c', HARNESS_PUBLIC_URL: 'http://127.0.0.1:4310', HARNESS_OIDC_SCOPES: 'openid email' })!.scopes, 'openid email');
});

test('without single sign-on, /auth/config says so and its routes do not exist', async () => {
  const data = await tempDir();
  const harness = await createHarness({ dataDir: data, search: null });
  const { server } = createApp({ harness, token: OPERATOR, loopback: true, localRoots: [], uiDir: path.join(data, 'ui'), appRoot: data, users: await new UserStore(data).load() });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  assert.deepEqual(await (await fetch(`${base}/auth/config`)).json(), { oidc: false, only: false, login: null });
  assert.equal((await fetch(`${base}/auth/login`, { redirect: 'manual' })).status, 404);
  await new Promise<void>((r) => server.close(() => r()));
  await harness.close();
});
