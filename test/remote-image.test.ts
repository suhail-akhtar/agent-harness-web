import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import * as web from '../src/tools/web.ts';
import { OPERATOR, setupServer } from './multi-helpers.ts';

// An image on the web is never loaded by an interface on its own (the address is the model's: it can carry data
// out, or reach a device on the person's network). Asked for by the person, the server fetches it, guarded as
// web_fetch is. The interface's side (the placeholder, the policy that makes a direct load impossible) is in
// desktop-render.test.ts and desktop-security.test.ts; the app itself in desktop-e2e.test.ts.

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==', 'base64');
const answer = (status: number, headers: Record<string, string>, body: Uint8Array | string = '') => new Response(status === 204 || (status >= 300 && status < 400) ? null : body as BodyInit, { status, headers });
/** A scripted web: each address answers once with what the script says; every request made is kept. */
function scripted(pages: Record<string, () => Response>) {
  const asked: string[] = [];
  const fetch = (async (url: string | URL) => { asked.push(String(url)); const p = pages[String(url)]; if (!p) throw new Error(`nothing at ${url}`); return p(); }) as typeof web.publicFetch;
  const check = (async (raw: string) => { const u = new URL(raw); if (/^(127\.|10\.|192\.168\.|169\.254\.)|localhost|\.internal$/.test(u.hostname)) throw new Error(`${u.hostname} resolves to a private address`); return u; }) as typeof web.assertPublicUrl;
  return { asked, fetch, check };
}

test('remote image: an image comes back with its type; its redirects are followed and each one checked', async () => {
  const w = scripted({
    'https://cdn.example/a.png': () => answer(302, { location: '/b.png' }),
    'https://cdn.example/b.png': () => answer(301, { location: 'https://img.example/c.png' }),
    'https://img.example/c.png': () => answer(200, { 'content-type': 'image/png; charset=binary' }, PNG),
  });
  const r = await web.fetchPublicImage('https://cdn.example/a.png', w);
  assert.equal(r.type, 'image/png');
  assert.deepEqual(r.bytes, PNG);
  assert.equal(r.url, 'https://img.example/c.png');
  assert.equal(w.asked.length, 3);
});

test('remote image: a redirect to a private address is refused before it is asked', async () => {
  for (const to of ['http://127.0.0.1:8080/admin', 'http://192.168.1.1/reboot', 'http://169.254.169.254/latest/meta-data/', 'http://db.internal/x.png']) {
    const w = scripted({ 'https://cdn.example/a.png': () => answer(302, { location: to }) });
    await assert.rejects(web.fetchPublicImage('https://cdn.example/a.png', w), /private address/, to);
    assert.deepEqual(w.asked, ['https://cdn.example/a.png'], `${to} was never asked`);
  }
});

test('remote image: only images, of a bounded size, from an address that answers', async () => {
  const cases: [string, () => Response, RegExp][] = [
    ['a page', () => answer(200, { 'content-type': 'text/html' }, '<script>alert(1)</script>'), /did not send an image \(text\/html\)/],
    ['json', () => answer(200, { 'content-type': 'application/json' }, '{}'), /did not send an image/],
    ['no type', () => new Response(new Uint8Array([1, 2, 3]) as BodyInit, { status: 200 }), /did not send an image/],
    ['a type that only starts like one', () => answer(200, { 'content-type': 'image/pngx' }, PNG), /did not send an image/],
    ['an error', () => answer(404, { 'content-type': 'image/png' }, PNG), /answered 404/],
    ['too large', () => answer(200, { 'content-type': 'image/png' }, new Uint8Array(15 * 1024 * 1024 + 1)), /larger than 15 MB/],
  ];
  for (const [what, page, why] of cases) {
    const w = scripted({ 'https://x.example/i': page });
    await assert.rejects(web.fetchPublicImage('https://x.example/i', w), why, what);
  }
  const loop = scripted(Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`https://x.example/${i}`, () => answer(302, { location: `/${i + 1}` })])));
  await assert.rejects(web.fetchPublicImage('https://x.example/0', loop), /too many redirects/);
  assert.equal(loop.asked.length, 6);
  for (const bad of ['file:///etc/passwd', 'data:image/png;base64,AAAA', 'javascript:alert(1)', 'not a url', 'ftp://x.example/a.png'])
    await assert.rejects(web.fetchPublicImage(bad), /only http and https|not a valid URL/, bad);
});

test('remote image: the real guard never reaches this computer or its network, by name, by number or by rebinding', async () => {
  let hits = 0;
  const server = http.createServer((_q, r) => { hits++; r.writeHead(200, { 'content-type': 'image/png' }); r.end(PNG); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const saved = web.resolver.lookup;
  const proxy = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].map((k) => [k, process.env[k]] as const);
  for (const [k] of proxy) delete process.env[k];
  try {
    for (const url of [`http://127.0.0.1:${port}/p.png?d=secret`, `http://localhost:${port}/p.png`, `http://[::1]:${port}/p.png`, `http://0.0.0.0:${port}/p.png`, `http://2130706433:${port}/p.png`, `http://127.1:${port}/p.png`])
      await assert.rejects(web.fetchPublicImage(url), /private|not a valid URL/, url);
    // Public when checked, this computer when connected to.
    let calls = 0;
    web.resolver.lookup = async () => (calls++ === 0 ? [{ address: '93.184.215.14', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]);
    await assert.rejects(web.fetchPublicImage(`http://rebind.example:${port}/p.png`));
    assert.equal(hits, 0, 'the local server was never reached');
  } finally {
    web.resolver.lookup = saved;
    for (const [k, v] of proxy) if (v !== undefined) process.env[k] = v;
    server.close();
  }
});

test('remote image: the endpoint is for a signed-in person, says why an image was not loaded, and never returns a page', async () => {
  const t = await setupServer();
  try {
    assert.equal((await t.call('wrong-token', 'POST', '/api/remote-image', { url: 'https://example.com/a.png' })).status, 401);
    assert.equal((await t.call(OPERATOR, 'POST', '/api/remote-image', {})).status, 400);
    const r = await t.call(OPERATOR, 'POST', '/api/remote-image', { url: 'http://127.0.0.1:1/a.png' });
    assert.equal(r.status, 422);
    assert.match(r.body.error, /The image was not loaded: 127\.0\.0\.1 resolves to a private address/);
    // A plain page or a script cannot ask (no x-harness header: a cross-site form or <img> cannot set one).
    const bare = await fetch(`${t.base}/api/remote-image`, { method: 'POST', headers: { authorization: `Bearer ${OPERATOR}`, 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com/a.png' }) });
    assert.equal(bare.status, 403);
    assert.equal((await fetch(`${t.base}/api/remote-image?url=https://example.com/a.png`, { headers: { authorization: `Bearer ${OPERATOR}` } })).status, 404, 'no GET: an address in a query string is not a way in');
  } finally { await t.close(); }
});
