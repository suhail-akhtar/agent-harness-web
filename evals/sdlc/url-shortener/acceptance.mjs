// Independent acceptance checks for a URL-shortener build: 25 HTTP checks, including
// persistence across a restart. Plain Node (fetch, child_process), so it runs the same
// on Linux, macOS and Windows - no curl, bash or python in between.
//   node acceptance.mjs <workspace> "<start command>" <port>
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [ws = '.', cmd = 'npm start', portArg = '4400'] = process.argv.slice(2);
const P = Number(portArg);
const base = `http://127.0.0.1:${P}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-'));
const F = path.join(tmp, 'links.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child;
async function start() {
  const env = { ...process.env, PORT: String(P), LINKS_FILE: F, DATA_FILE: F, STORE_PATH: F, DB_FILE: F, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
  child = spawn(cmd, { cwd: path.resolve(ws), env, shell: true, stdio: 'ignore', detached: process.platform !== 'win32' });
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${base}/links`); return; } catch { await sleep(250); }
  }
  console.log('server did not start');
}
async function stop() {
  if (!child) return;
  // The whole tree: npm start runs the server as a child of a shell.
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }
  child = undefined;
  for (let i = 0; i < 20; i++) { try { await fetch(`${base}/links`); await sleep(250); } catch { return; } }
}

let body;
async function req(p, init = {}) {
  try {
    const r = await fetch(base + p, { redirect: 'manual', ...init });
    const t = await r.text();
    try { body = JSON.parse(t); } catch { body = undefined; }
    return r;
  } catch (e) { body = undefined; return { status: `error ${e.cause?.code ?? e.message}`, headers: new Headers() }; }
}
const post = (b) => req('/links', { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof b === 'string' ? b : JSON.stringify(b) });
const link = () => (body && typeof body === 'object' && body.link) || body || {};

let ok = 0, bad = 0;
const check = (name, got, want) => { if (got === want) ok++; else { bad++; console.log(`FAIL ${name}: expected ${want} got ${got}`); } };

try {
  await start();
  check('create with slug', (await post({ url: 'https://example.com/a', slug: 'abc' })).status, 201);
  check('duplicate slug', (await post({ url: 'https://example.com/b', slug: 'abc' })).status, 409);
  check('generated slug', (await post({ url: 'http://example.org' })).status, 201);
  const gen = String(link().slug ?? '');
  check('generated slug is 6 chars [a-z0-9-]', /^[a-z0-9-]{6}$/.test(gen), true);
  check('bad scheme', (await post({ url: 'ftp://x.com' })).status, 400);
  check('relative url', (await post({ url: '/local' })).status, 400);
  check('slug too short', (await post({ url: 'https://x.com', slug: 'ab' })).status, 400);
  check('slug bad chars', (await post({ url: 'https://x.com', slug: 'AB_c' })).status, 400);
  check('url too long', (await post({ url: `https://x.com/${'a'.repeat(2100)}` })).status, 400);
  check('malformed json', (await post('{"url":')).status, 400);
  check('body over 10KB', (await post({ url: 'https://x.com', pad: 'a'.repeat(11000) })).status, 413);
  check('CRLF url', (await post({ url: 'https://x.com/\r\nSet-Cookie: a=b', slug: 'crlf' })).status, 400);
  let r = await req('/abc');
  check('redirect', r.status, 302);
  check('redirect target', r.headers.get('location'), 'https://example.com/a');
  // Three visits in all (as the first version of these checks made), then the count.
  await req('/abc'); await req('/abc');
  check('stats', (await req('/links/abc')).status, 200);
  check('clicks counted', link().clicks, 3);
  check('stats fields', ['slug', 'url', 'clicks', 'createdAt'].every((k) => k in link()), true);
  check('list', (await req('/links')).status, 200);
  const list = Array.isArray(body) ? body : body?.links ?? body?.items ?? [];
  check('list newest first', list[0]?.slug === gen && list.length === 2, true);
  r = await req('/nope1');
  check('unknown slug 404', r.status, 404);
  check('404 is json', body !== undefined, true);
  await stop(); await start();
  check('survives restart', (await req('/links/abc')).status, 200);
  check('clicks survive restart', link().clicks, 3);
  check('delete', (await req('/links/abc', { method: 'DELETE' })).status, 204);
  check('deleted is gone', (await req('/abc')).status, 404);
} finally {
  await stop();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`acceptance: ${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
