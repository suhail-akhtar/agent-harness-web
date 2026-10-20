import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import dns from 'node:dns/promises';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHarness } from '../src/kernel/harness.ts';
import { expand } from '../src/mcp/manager.ts';
import { hostAllowed, pluginFetch } from '../src/plugins/loader.ts';
import { tempDir } from './helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

test('a plugin reads only the secrets it declared: api.secret and ${VAR} in its MCP servers; servers never inherit the keys', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { FIXTURE_OK_TOKEN: 'ok-value', FIXTURE_SECRET_TOKEN: 'must-not-leak', FAKE_PROVIDER_API_KEY: 'sk-fake', PLAIN_SETTING: 'plain' });
  try {
    const root = await tempDir();
    const dir = path.join(root, 'perm');
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'harness-plugin.json'), JSON.stringify({
      name: 'perm', main: 'index.mjs',
      permissions: { secrets: ['FIXTURE_OK_TOKEN'], network: ['127.0.0.1'] },
      mcpServers: { permfix: { command: process.execPath, args: [path.join(here, 'fixtures', 'mcp-server.mjs')], env: { A: '${FIXTURE_OK_TOKEN}', B: '${FIXTURE_SECRET_TOKEN}${PLAIN_SETTING}' } } },
    }));
    await fs.writeFile(path.join(dir, 'index.mjs'), `export default { name: 'perm', setup(api) {
      globalThis.__permResults = { ok: api.secret('FIXTURE_OK_TOKEN') };
      try { api.secret('FIXTURE_SECRET_TOKEN'); } catch (e) { globalThis.__permResults.refused = e.message; }
    } };`);
    const h = await createHarness({ dataDir: await tempDir(), plugins: [root], search: null });
    const r = (globalThis as unknown as { __permResults: { ok: string; refused: string } }).__permResults;
    assert.equal(r.ok, 'ok-value');
    assert.match(r.refused, /FIXTURE_SECRET_TOKEN is not declared/);
    assert.deepEqual(h.registry.plugins.find((p) => p.name === 'perm')!.permissions, { network: ['127.0.0.1'], secrets: ['FIXTURE_OK_TOKEN'] });

    const { entries } = await h.mcp.serverEntries(new Map([['permfix', h.registry.mcpServers.get('permfix')!]]));
    const env = JSON.parse(((await entries[0]!.client.callTool('env', {}, new AbortController().signal)).content as { text: string }[])[0]!.text);
    assert.equal(env.A, 'ok-value', 'a declared secret is passed');
    assert.equal(env.B, 'plain', 'an undeclared secret expands to nothing; ordinary settings still expand');
    assert.ok(!env.secretish.includes('FAKE_PROVIDER_API_KEY') && !env.secretish.includes('FIXTURE_SECRET_TOKEN'), `inherited: ${env.secretish}`);
    await h.close();
    // The operator's own config may pass anything it names.
    assert.equal(expand('${FIXTURE_SECRET_TOKEN}'), 'must-not-leak');
    assert.equal(expand('${FIXTURE_SECRET_TOKEN}', []), '');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  }
});

test('api.fetch reaches only declared hosts; redirects are re-checked; a private host must be named exactly', async () => {
  assert.equal(hostAllowed('api.example.com', ['api.example.com']), true);
  assert.equal(hostAllowed('x.cdn.example.net', ['*.cdn.example.net']), true);
  assert.equal(hostAllowed('cdn.example.net', ['*.cdn.example.net']), false);
  assert.equal(hostAllowed('evil-example.com', ['*.example.com']), false);
  assert.equal(hostAllowed('example.com.evil.io', ['example.com']), false);

  const srv = http.createServer((req, res) => {
    if (req.url === '/hop') { res.writeHead(302, { location: 'http://localhost:1/elsewhere' }); return res.end(); }
    res.end('hello');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  const prev = process.env.NO_PROXY;
  process.env.NO_PROXY = '127.0.0.1,localhost';
  try {
    assert.equal(await (await pluginFetch('p', ['127.0.0.1'], `http://127.0.0.1:${port}/`)).text(), 'hello');
    await assert.rejects(pluginFetch('p', ['example.com'], `http://127.0.0.1:${port}/`), /not in the plugin's declared network hosts/);
    await assert.rejects(pluginFetch('p', ['127.0.0.1'], `http://127.0.0.1:${port}/hop`), /localhost is not in the plugin's declared/);
    await assert.rejects(pluginFetch('p', ['*.localhost'], 'http://a.localhost/'), /private host/);
  } finally {
    srv.close();
    if (prev === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = prev;
  }
});

test('a plugin named "config" is a plugin: it does not get the operator\'s reach into the server\'s variables', async () => {
  const saved = { ...process.env };
  process.env.FIXTURE_SECRET_TOKEN = 'must-not-leak';
  try {
    const root = await tempDir();
    const dir = path.join(root, 'config');
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'harness-plugin.json'), JSON.stringify({
      name: 'config',
      mcpServers: { cfgfix: { command: process.execPath, args: [path.join(here, 'fixtures', 'mcp-server.mjs')], env: { A: '${FIXTURE_SECRET_TOKEN}' }, operator: true } },
    }));
    const h = await createHarness({ dataDir: await tempDir(), plugins: [root], search: null });
    try {
      const { entries } = await h.mcp.serverEntries(new Map([['cfgfix', h.registry.mcpServers.get('cfgfix')!]]));
      const env = JSON.parse(((await entries[0]!.client.callTool('env', {}, new AbortController().signal)).content as { text: string }[])[0]!.text);
      assert.equal(env.A, '', 'neither the name nor an "operator" field in its manifest gives it the secret');
    } finally { await h.close(); }
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  }
});

test('api.fetch: a host name declared exactly is still checked in DNS (it could point inside)', async () => {
  // Any name this machine resolves to a loopback address stands in for a rebound one.
  const name = (await Promise.all(['vm', 'localhost.localdomain', 'ip6-localhost'].map(async (n) => ((await dns.lookup(n).catch(() => null))?.address ?? '').match(/^(127\.|::1$)/) ? n : null))).find(Boolean);
  if (!name) return;
  await assert.rejects(pluginFetch('p', [name], `http://${name}:9/`), /private/);
});
