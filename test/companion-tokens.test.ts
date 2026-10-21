import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import type http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHarness } from '../src/kernel/harness.ts';
import { CompanionHub } from '../src/runtime/companion.ts';
import { createApp } from '../src/server/app.ts';
import { tempDir } from './helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const DAY = 86_400_000;

test('companion tokens expire, are replaced while the companion polls, and the replaced one stops working after a grace period', async () => {
  const data = await tempDir();
  let now = 1_000_000;
  const hub = new CompanionHub(data, { tokenDays: 30, graceMs: 60_000, now: () => now });
  const { id, token } = await hub.create('laptop');
  assert.deepEqual(hub.authenticateToken(token), { id, previous: false });
  assert.equal(await hub.renew(id), undefined, 'nothing due while most of its life is left');
  // Half its life gone: a poll's reply carries a fresh one.
  now += 16 * DAY;
  const fresh = (await hub.renew(id))!;
  assert.match(fresh, /^hwc_/);
  assert.deepEqual(hub.authenticateToken(fresh), { id, previous: false });
  assert.deepEqual(hub.authenticateToken(token), { id, previous: true }, 'the old one still works for the grace period');
  // The reply was lost: the companion polls with the old one again, and gets another.
  const again = (await hub.renew(id, true))!;
  assert.equal(hub.authenticateToken(fresh), undefined, 'the token it never received is dropped');
  assert.deepEqual(hub.authenticateToken(again), { id, previous: false });
  now += 61_000;
  assert.equal(hub.authenticateToken(token), undefined, 'after the grace period the old one is refused');
  // It survives a restart of the server, expiry included.
  const hub2 = new CompanionHub(data, { tokenDays: 30, now: () => now });
  await hub2.load();
  assert.deepEqual(hub2.authenticateToken(again), { id, previous: false });
  now += 31 * DAY;
  assert.equal(hub2.authenticateToken(again), undefined, 'a companion offline past expiry needs a new token');
  // A new token from the web app replaces it at once.
  const manual = await hub2.rotate(id);
  assert.deepEqual(hub2.authenticateToken(manual), { id, previous: false });
  assert.equal((hub2.list()[0]!.expiresAt ?? 0) > now, true);
  // A token from before expiry existed gets a full lifetime from now.
  const legacyDir = await tempDir();
  await fs.writeFile(path.join(legacyDir, 'companions.json'), JSON.stringify([{ id: 'cmp_aaaaaaaaaaaa', name: 'old', tokenHash: (await import('node:crypto')).createHash('sha256').update('hwc_legacy').digest('hex'), createdAt: 1 }]));
  const hub3 = new CompanionHub(legacyDir, { tokenDays: 30, now: () => now });
  await hub3.load();
  assert.deepEqual(hub3.authenticateToken('hwc_legacy'), { id: 'cmp_aaaaaaaaaaaa', previous: false });
});

/** Waits until `check` holds (polling), or fails with `what`. */
async function until(check: () => Promise<boolean> | boolean, what: string, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await new Promise((r) => setTimeout(r, 200)); }
  throw new Error(`timed out waiting for ${what}`);
}

test('the real companion keeps the fresh token it is sent, uses it from then on, and a revoked token stops it', async () => {
  const saved = { days: process.env.HARNESS_COMPANION_TOKEN_DAYS, grace: process.env.HARNESS_COMPANION_TOKEN_GRACE_MIN };
  // 40 seconds of life, so the first long poll's reply (25 s) is due a fresh one; a 1-second grace.
  process.env.HARNESS_COMPANION_TOKEN_DAYS = String(40 / 86_400);
  process.env.HARNESS_COMPANION_TOKEN_GRACE_MIN = String(1 / 60);
  const data = await tempDir();
  const harness = await createHarness({ dataDir: data, search: null });
  const { server } = createApp({ harness, token: 'op', loopback: true, localRoots: [], uiDir: path.join(data, 'ui'), appRoot: data });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const api = (method: string, p: string, body?: unknown) => fetch(base + p, { method, headers: { authorization: 'Bearer op', 'content-type': 'application/json', 'x-harness': '1' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) as Record<string, unknown> }));
  const poll = (token: string) => fetch(`${base}/api/companion/poll`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ info: { platform: 'linux' } }), signal: AbortSignal.timeout(40_000) });
  const procs: ReturnType<typeof spawn>[] = [];
  const start = (token: string, tokenFile: string) => {
    const p = spawn(process.execPath, [path.join(here, '..', 'scripts', 'run.mjs'), 'src/companion/main.ts', '--server', base, '--token', token, '--token-file', tokenFile, '--dir', data, '--sandbox', 'off'], { cwd: path.join(here, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout!.on('data', (d) => (out += d)); p.stderr!.on('data', (d) => (out += d));
    procs.push(p);
    return { p, out: () => out, exited: new Promise<number | null>((r) => p.on('exit', r)) };
  };
  try {
    const c = (await api('POST', '/api/companions', { name: 'laptop' })).body as { id: string; token: string };
    const tokenFile = path.join(await tempDir(), 'companion.token');
    const comp = start(c.token, tokenFile);
    // The first poll's reply carries a fresh token; the companion writes it down and polls with it.
    await until(async () => (await fs.readFile(tokenFile, 'utf8').catch(() => '')).trim().startsWith('hwc_'), 'the companion to keep a fresh token');
    const kept = (await fs.readFile(tokenFile, 'utf8')).trim();
    assert.notEqual(kept, c.token);
    if (process.platform !== 'win32') assert.equal((await fs.stat(tokenFile)).mode & 0o777, 0o600);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await poll(c.token)).status, 401, 'the original token is refused after the grace period');
    assert.match(comp.out(), /received a fresh token/);
    await until(async () => ((await api('GET', '/api/companions')).body as unknown as { online: boolean }[])[0]?.online === true, 'the companion to be online');
    // Restarted with the original (now dead) token: it falls back to the one it kept.
    comp.p.kill();
    await comp.exited;
    const restarted = start(c.token, tokenFile);
    await until(() => /serving/.test(restarted.out()), 'the companion to start');
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal(restarted.p.exitCode, null, `it kept running: ${restarted.out()}`);
    // A new token from the web app revokes every earlier one at once: the companion stops.
    const rotated = await api('POST', `/api/companions/${c.id}/token`);
    assert.equal(rotated.status, 200);
    assert.match(String(rotated.body.token), /^hwc_/);
    assert.equal(await Promise.race([restarted.exited, new Promise((r) => setTimeout(() => r('still running'), 40_000))]), 1);
    assert.match(restarted.out(), /rejected this token \(unknown, revoked, or expired\)/);
    // Removing the companion revokes its token too.
    assert.equal((await api('DELETE', `/api/companions/${c.id}`)).status, 200);
    assert.equal((await poll(String(rotated.body.token))).status, 401);
  } finally {
    for (const p of procs) p.kill();
    await new Promise<void>((r) => (server as http.Server).close(() => r()));
    await harness.close();
    for (const [k, v] of [['HARNESS_COMPANION_TOKEN_DAYS', saved.days], ['HARNESS_COMPANION_TOKEN_GRACE_MIN', saved.grace]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
