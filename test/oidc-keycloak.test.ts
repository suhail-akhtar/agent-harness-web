import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { createHarness } from '../src/kernel/harness.ts';
import { dockerAvailable, imageExists } from '../src/runtime/docker.ts';
import { createApp } from '../src/server/app.ts';
import { BrowserSessions, OidcClient, type OidcConfig } from '../src/server/oidc.ts';
import { SpendLedger, UserStore } from '../src/server/users.ts';
import { docker, freePort, removeContainer, waitForHttp } from './real-services.ts';
import { tempDir } from './helpers.ts';

// Single sign-on against a real identity provider: Keycloak in Docker (dev
// mode). The realm, a confidential client with PKCE and three users are made
// through Keycloak's admin REST API; then a "browser" (fetch with a cookie jar)
// signs in through the harness: the harness redirects to Keycloak, the login
// form is fetched and posted with the password, Keycloak redirects back to the
// harness callback, which exchanges the code and checks the id_token.
//
// Runs when Docker has a Keycloak image (HARNESS_TEST_KEYCLOAK_IMAGE, else
// keycloak/keycloak:26.7.4 or quay.io/keycloak/keycloak:26.7.4; HARNESS_TEST_KEYCLOAK=1
// pulls the quay.io one). HARNESS_TEST_KEYCLOAK_URL (with HARNESS_TEST_KEYCLOAK_ADMIN_PASSWORD)
// uses a running dev-mode Keycloak instead.

const OPERATOR = 'operator-token-for-keycloak-test';
const ADMIN_PW = process.env.HARNESS_TEST_KEYCLOAK_ADMIN_PASSWORD ?? 'hwtest-admin-pw';
const external = process.env.HARNESS_TEST_KEYCLOAK_URL?.replace(/\/+$/, '');
const candidates = [process.env.HARNESS_TEST_KEYCLOAK_IMAGE, 'keycloak/keycloak:26.7.4', 'quay.io/keycloak/keycloak:26.7.4'].filter(Boolean) as string[];
let image: string | undefined;
if (!external && await dockerAvailable()) {
  for (const c of candidates) if (await imageExists(c)) { image = c; break; }
  if (!image && process.env.HARNESS_TEST_KEYCLOAK === '1') image = candidates.at(-1);
}
const enabled = !!external || !!image;

/** A browser's cookies, per host (paths ignored: every cookie goes back to its host). */
class Jar {
  private jar = new Map<string, Map<string, string>>();
  store(url: string, res: Response): void {
    const host = new URL(url).host;
    const m = this.jar.get(host) ?? new Map<string, string>();
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq).trim(), value = pair!.slice(eq + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || attrs.some((a) => /^\s*expires=Thu, 01 Jan 1970/i.test(a));
      if (expired || value === '') m.delete(name); else m.set(name, value);
    }
    this.jar.set(host, m);
  }
  header(url: string): string { return [...(this.jar.get(new URL(url).host) ?? new Map()).entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
  get(host: string, name: string): string | undefined { return this.jar.get(host)?.get(name); }
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(url, { ...init, redirect: 'manual', headers: { ...(init.headers as Record<string, string> ?? {}), cookie: this.header(url) } });
    this.store(url, res);
    return res;
  }
}

const unescapeHtml = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** The action URL of a form in Keycloak's HTML (the login form by default). */
function formAction(html: string, pageUrl: string, id = 'kc-form-login'): string {
  const form = new RegExp(`<form[^>]*id="${id}"[^>]*>`, 'i').exec(html)?.[0] ?? /<form[^>]*>/i.exec(html)?.[0];
  const action = form && /action="([^"]+)"/i.exec(form)?.[1];
  if (!action) throw new Error(`no form in Keycloak's page: ${html.slice(0, 600)}`);
  return new URL(unescapeHtml(action), pageUrl).toString();
}

test('single sign-on against a real Keycloak: login form, accounts, admin mapping, unverified refused, logout at Keycloak, signing key rotation', { skip: !enabled && 'no Docker or Keycloak image (HARNESS_TEST_KEYCLOAK=1 pulls quay.io/keycloak/keycloak)', timeout: 600_000 }, async () => {
  const name = `hwtest-keycloak-${process.pid}`;
  let kc = external;
  const data = await tempDir();
  let close = async () => {};
  let dropRealm = async () => {};
  try {
    if (!kc) {
      const port = await freePort();
      const r = await docker(['run', '-d', '--name', name, '-p', `127.0.0.1:${port}:8080`, '-e', 'KC_BOOTSTRAP_ADMIN_USERNAME=admin', '-e', `KC_BOOTSTRAP_ADMIN_PASSWORD=${ADMIN_PW}`, image!, 'start-dev'], { timeoutMs: 600_000 });
      assert.equal(r.code, 0, r.stderr);
      kc = `http://127.0.0.1:${port}`;
    }
    await waitForHttp(`${kc}/realms/master`, 240_000, (s) => s === 200);

    // The harness server first: its address is the client's redirect URI.
    const harnessPort = await freePort();
    const PUBLIC = `http://127.0.0.1:${harnessPort}`;
    const realm = `hwtest${Date.now().toString(36)}`;
    const issuer = `${kc}/realms/${realm}`;
    const SECRET = `secret-${Math.random().toString(36).slice(2)}`;

    // --- Keycloak set-up through its admin REST API ---
    const tokenRes = await fetch(`${kc}/realms/master/protocol/openid-connect/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: 'admin', password: ADMIN_PW }) });
    const adminToken = ((await tokenRes.json()) as { access_token: string }).access_token;
    assert.ok(adminToken, 'admin token');
    const admin = async (method: string, p: string, body?: unknown) => {
      const r = await fetch(`${kc}/admin/realms${p}`, { method, headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      if (!r.ok) throw new Error(`${method} ${p}: HTTP ${r.status} ${text}`);
      return text ? JSON.parse(text) : undefined;
    };
    await admin('POST', '', { realm, enabled: true, sslRequired: 'none', verifyEmail: false });
    dropRealm = async () => { await admin('DELETE', `/${realm}`).catch(() => {}); };
    await admin('POST', `/${realm}/clients`, {
      clientId: 'harness', name: 'Harness Web', enabled: true, protocol: 'openid-connect',
      publicClient: false, clientAuthenticatorType: 'client-secret', secret: SECRET,
      standardFlowEnabled: true, directAccessGrantsEnabled: false, implicitFlowEnabled: false,
      redirectUris: [`${PUBLIC}/auth/callback`], webOrigins: [PUBLIC],
      attributes: { 'pkce.code.challenge.method': 'S256', 'post.logout.redirect.uris': `${PUBLIC}/` },
    });
    const users = [
      { username: 'alice', email: 'alice@example.com', emailVerified: true, firstName: 'Alice', lastName: 'Member' },
      { username: 'bob', email: 'bob@example.com', emailVerified: false, firstName: 'Bob', lastName: 'Unverified' },
      { username: 'boss', email: 'boss@example.com', emailVerified: true, firstName: 'Boss', lastName: 'Admin' },
    ];
    for (const u of users) await admin('POST', `/${realm}/users`, { ...u, enabled: true, credentials: [{ type: 'password', value: `${u.username}-pw-1`, temporary: false }] });

    // --- the harness with single sign-on to that realm ---
    const userStore = await new UserStore(data).load();
    const spend = await new SpendLedger(data).load();
    const harness = await createHarness({ dataDir: data, search: null, spend, memory: 'off', scheduler: false });
    const cfg: OidcConfig = { issuer, clientId: 'harness', clientSecret: SECRET, publicUrl: PUBLIC, scopes: 'openid email profile', allowedDomains: ['example.com'], allowedEmails: [], admins: ['boss@example.com'], only: false };
    const client = new OidcClient(cfg);
    const sessions = await new BrowserSessions(data).load();
    const { server } = createApp({ harness, token: OPERATOR, loopback: true, localRoots: [], uiDir: path.join(data, 'ui'), appRoot: data, users: userStore, spend, sso: { client, sessions } });
    await new Promise<void>((r) => server.listen(harnessPort, '127.0.0.1', r));
    assert.equal((server.address() as AddressInfo).port, harnessPort);
    close = async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await sessions.flush();
      await harness.close();
    };

    /** One browser signing in with a password through Keycloak's real login form. */
    const signIn = async (username: string, jar = new Jar()) => {
      const start = await jar.fetch(`${PUBLIC}/auth/login`);
      assert.equal(start.status, 302, await start.text());
      const authUrl = start.headers.get('location')!;
      assert.ok(authUrl.startsWith(`${issuer}/protocol/openid-connect/auth?`), authUrl);
      const q = new URL(authUrl).searchParams;
      assert.equal(q.get('code_challenge_method'), 'S256');
      let page = await jar.fetch(authUrl);
      let location = page.headers.get('location');
      if (page.status === 200) {
        // Keycloak's login page: post the form as a browser would.
        const html = await page.text();
        assert.match(html, /kc-form-login|username/i, 'the login form');
        page = await jar.fetch(formAction(html, authUrl), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username, password: `${username}-pw-1`, credentialId: '' }).toString() });
        location = page.headers.get('location');
        if (page.status !== 302) throw new Error(`Keycloak did not accept the login (HTTP ${page.status}): ${(await page.text()).replace(/\s+/g, ' ').slice(0, 800)}`);
      }
      assert.equal(page.status, 302, 'Keycloak redirects back to the harness');
      assert.ok(location!.startsWith(`${PUBLIC}/auth/callback?`), location!);
      const back = new URL(location!);
      assert.equal(back.searchParams.get('iss'), issuer, 'RFC 9207: Keycloak names itself in the response');
      const done = await jar.fetch(location!);
      return { status: done.status, text: await done.text(), location: done.headers.get('location'), cookie: jar.get(new URL(PUBLIC).host, 'hw_sid'), jar };
    };
    const me = async (sid: string | undefined) => {
      const r = await fetch(`${PUBLIC}/api/me`, { headers: { cookie: `hw_sid=${sid}` } });
      return { status: r.status, body: await r.json() as Record<string, unknown> };
    };

    // 1. A verified member: the account is made, keyed by Keycloak's issuer and subject.
    const a = await signIn('alice');
    assert.equal(a.status, 302, a.text);
    assert.equal(a.location, `${PUBLIC}/`);
    assert.ok(a.cookie, 'signed in');
    const am = await me(a.cookie);
    assert.equal(am.body.email, 'alice@example.com');
    assert.equal(am.body.role, 'member');
    const alice = userStore.list().find((u) => u.sso?.email === 'alice@example.com')!;
    assert.equal(alice.sso!.iss, issuer);
    const kcAlice = (await admin('GET', `/${realm}/users?username=alice&exact=true`))[0] as { id: string };
    assert.equal(alice.sso!.sub, kcAlice.id, 'the subject is Keycloak\'s user id');

    // 2. The administrator mapping.
    const b = await signIn('boss');
    assert.equal(b.status, 302, b.text);
    assert.equal((await me(b.cookie)).body.role, 'admin');
    assert.equal((await fetch(`${PUBLIC}/api/users`, { headers: { cookie: `hw_sid=${b.cookie}` } })).status, 200);
    assert.equal((await fetch(`${PUBLIC}/api/users`, { headers: { cookie: `hw_sid=${a.cookie}` } })).status, 403);

    // 3. Keycloak signs bob in, but his address is not verified: the harness refuses.
    const bob = await signIn('bob');
    assert.equal(bob.status, 401, bob.text);
    assert.match(bob.text, /has not verified this e-mail address/);
    assert.equal(bob.cookie, undefined);
    assert.equal(userStore.list().filter((u) => u.sso).length, 2, 'no account for the refused sign-in');

    // 4. The same browser signs in again without a password (Keycloak's own session): same account.
    const again = await signIn('alice', a.jar);
    assert.equal(again.status, 302, again.text);
    assert.equal((await me(again.cookie)).body.id, alice.id);

    // 5. Logout: the harness session ends, and the browser goes to Keycloak's end_session endpoint,
    // which ends Keycloak's session and comes back to the harness.
    const disc = await (await fetch(`${issuer}/.well-known/openid-configuration`)).json() as { end_session_endpoint: string };
    const out = await fetch(`${PUBLIC}/auth/logout`, { method: 'POST', headers: { cookie: `hw_sid=${again.cookie}`, 'x-harness': '1', 'content-type': 'application/json' }, body: '{}' });
    const outBody = await out.json() as { providerLogout?: string };
    assert.equal(out.status, 200);
    assert.ok(outBody.providerLogout, 'Keycloak offers RP-initiated logout');
    const lo = new URL(outBody.providerLogout!);
    assert.equal(lo.origin + lo.pathname, disc.end_session_endpoint);
    assert.equal(lo.searchParams.get('post_logout_redirect_uri'), `${PUBLIC}/`);
    assert.equal((await me(again.cookie)).status, 401, 'the harness session is gone');
    // The id_token_hint lets Keycloak sign out without its "Do you want to log out?" page.
    assert.ok(lo.searchParams.get('id_token_hint'), 'the id_token is sent as the hint');
    const step = await a.jar.fetch(outBody.providerLogout!);
    assert.equal(step.status, 302, `Keycloak signs out and redirects back without asking: HTTP ${step.status} ${step.status === 200 ? (await step.text()).replace(/\s+/g, ' ').slice(0, 300) : ''}`);
    assert.equal(step.headers.get('location'), `${PUBLIC}/`);
    const sessionsLeft = await admin('GET', `/${realm}/users/${kcAlice.id}/sessions`) as unknown[];
    assert.equal(sessionsLeft.length, 0, 'Keycloak ended its own session for alice');
    // Signing in again needs the password again.
    const relog = await a.jar.fetch((await a.jar.fetch(`${PUBLIC}/auth/login`)).headers.get('location')!);
    assert.equal(relog.status, 200, 'the login form again, not a silent sign-in');
    await relog.text();

    // 6. Key rotation: a new signing key takes over and the old one is removed; the harness
    // has the old key cached, sees an unknown kid, fetches the JWKS again, and signs in.
    const certs = async () => ((await (await fetch(`${issuer}/protocol/openid-connect/certs`)).json()) as { keys: { kid: string; use?: string; alg?: string }[] }).keys.filter((k) => k.use !== 'enc' && k.alg === 'RS256').map((k) => k.kid);
    const before = await certs();
    const realmId = (await admin('GET', `/${realm}`) as { id: string }).id;
    const old = (await admin('GET', `/${realm}/components?type=org.keycloak.keys.KeyProvider`) as { id: string; providerId: string }[]).filter((c) => c.providerId === 'rsa-generated');
    await admin('POST', `/${realm}/components`, { name: 'rotated-rsa', providerId: 'rsa-generated', providerType: 'org.keycloak.keys.KeyProvider', parentId: realmId, config: { priority: ['500'], enabled: ['true'], active: ['true'], keySize: ['2048'], algorithm: ['RS256'] } });
    for (const c of old) await admin('DELETE', `/${realm}/components/${c.id}`);
    const after = await certs();
    assert.equal(after.length, 1);
    assert.ok(!before.includes(after[0]!), `a new key id (${before} -> ${after})`);
    const rotated = await signIn('boss');
    assert.equal(rotated.status, 302, rotated.text);
    assert.equal((await me(rotated.cookie)).body.role, 'admin');
    console.log(`# keycloak ${image ?? kc}: realm ${realm}, signing key ${before.join(',')} -> ${after.join(',')}`);
  } finally {
    await close();
    if (external) await dropRealm(); else await removeContainer(name);
  }
});
