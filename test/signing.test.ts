import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHarness } from '../src/kernel/harness.ts';
import { generateKeyPair, loadTrustedKeys, signPlugin, verifyPlugin } from '../src/plugins/signing.ts';
import { FakeProvider, tempDir } from './helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const ACME = path.join(here, '..', 'examples', 'plugins', 'acme');

async function setupKeys() {
  const dir = await tempDir();
  const k = generateKeyPair();
  await fs.writeFile(path.join(dir, 'acme.pub.pem'), k.publicPem);
  return { keysDir: dir, k };
}
async function copyAcme(to: string) { await fs.cp(ACME, to, { recursive: true }); return to; }

test('a signature covers every file: changed, added or removed files, other keys and links are refused', async () => {
  const { keysDir, k } = await setupKeys();
  const keys = await loadTrustedKeys(keysDir);
  const dir = await copyAcme(path.join(await tempDir(), 'acme'));
  assert.deepEqual(await verifyPlugin(dir, keys), { ok: false, reason: 'not signed' });
  await signPlugin(dir, k.privatePem);
  const ok = await verifyPlugin(dir, keys);
  assert.ok(ok.ok && ok.keyId === k.keyId && ok.files >= 3);

  await fs.appendFile(path.join(dir, 'index.mjs'), '\n// sneaky\n');
  assert.match((await verifyPlugin(dir, keys) as { reason: string }).reason, /changed: index\.mjs/);
  await signPlugin(dir, k.privatePem);
  await fs.writeFile(path.join(dir, 'extra.mjs'), 'export default 1');
  assert.match((await verifyPlugin(dir, keys) as { reason: string }).reason, /added: extra\.mjs/);
  await fs.rm(path.join(dir, 'extra.mjs'));
  await fs.rm(path.join(dir, 'skills'), { recursive: true });
  assert.match((await verifyPlugin(dir, keys) as { reason: string }).reason, /missing: skills\//);

  await signPlugin(dir, generateKeyPair().privatePem);
  assert.match((await verifyPlugin(dir, keys) as { reason: string }).reason, /untrusted key/);
  const sig = JSON.parse(await fs.readFile(path.join(dir, 'harness-plugin.sig'), 'utf8'));
  sig.keyId = k.keyId; // claim the trusted key
  await fs.writeFile(path.join(dir, 'harness-plugin.sig'), JSON.stringify(sig));
  assert.match((await verifyPlugin(dir, keys) as { reason: string }).reason, /signature does not match/);

  // Dependencies are code that runs too: node_modules is covered by the signature.
  await signPlugin(dir, k.privatePem);
  await fs.mkdir(path.join(dir, 'node_modules', 'dep'), { recursive: true });
  await fs.writeFile(path.join(dir, 'node_modules', 'dep', 'index.js'), 'module.exports = 1');
  assert.match((await verifyPlugin(dir, keys) as { reason: string }).reason, /added: node_modules\/dep\/index\.js/);
  await signPlugin(dir, k.privatePem);
  assert.ok((await verifyPlugin(dir, keys)).ok);
  await fs.writeFile(path.join(dir, 'node_modules', 'dep', 'index.js'), 'require("child_process").exec("evil")');
  assert.match((await verifyPlugin(dir, keys) as { reason: string }).reason, /changed: node_modules\/dep\/index\.js/);
  await fs.rm(path.join(dir, 'node_modules'), { recursive: true });

  await fs.symlink('/etc/hostname', path.join(dir, 'link.txt'));
  await assert.rejects(signPlugin(dir, k.privatePem), /symbolic link/);
  await fs.writeFile(path.join(keysDir, 'oops.pem'), k.privatePem);
  await assert.rejects(loadTrustedKeys(keysDir), /private key/);
});

test('with a trust list, unsigned plugins are refused; signed and shipped ones load and say how', async () => {
  const { keysDir, k } = await setupKeys();
  const extra = await tempDir();
  const signed = await copyAcme(path.join(extra, 'acme'));
  await signPlugin(signed, k.privatePem);
  const unsignedRoot = await tempDir();
  const unsigned = await copyAcme(path.join(unsignedRoot, 'acme2'));
  const mf = JSON.parse(await fs.readFile(path.join(unsigned, 'harness-plugin.json'), 'utf8'));
  await fs.writeFile(path.join(unsigned, 'harness-plugin.json'), JSON.stringify({ ...mf, name: 'acme2' }));
  const logs: string[] = [];
  const h = await createHarness({
    dataDir: await tempDir(), plugins: [path.join(here, '..', 'plugins', 'sdlc'), extra, unsignedRoot],
    shippedPlugins: [path.join(here, '..', 'plugins')], pluginKeys: keysDir, log: (m) => logs.push(m),
  });
  const by = Object.fromEntries(h.registry.plugins.map((p) => [p.name, p.signature]));
  assert.equal(by.sdlc, 'shipped with the harness');
  assert.match(by.acme ?? '', /^signed by acme \(/);
  assert.equal(by.acme2, undefined);
  assert.ok(logs.some((l) => /acme2.*refused: not signed/.test(l)));
  await h.close();
});

test('catalogue: lists what is offered, installs only verified plugins, and the install is live', async () => {
  const { keysDir, k } = await setupKeys();
  const catalogue = await tempDir();
  await signPlugin(await copyAcme(path.join(catalogue, 'acme')), k.privatePem);
  const bad = await copyAcme(path.join(catalogue, 'tampered'));
  const mf = JSON.parse(await fs.readFile(path.join(bad, 'harness-plugin.json'), 'utf8'));
  await fs.writeFile(path.join(bad, 'harness-plugin.json'), JSON.stringify({ ...mf, name: 'tampered' }));
  await signPlugin(bad, k.privatePem);
  await fs.appendFile(path.join(bad, 'index.mjs'), '\n// changed after signing\n');

  const none = await createHarness({ dataDir: await tempDir(), catalogue });
  await assert.rejects(none.install('acme'), /needs a trust list/);
  await none.close();

  const data = await tempDir();
  const h = await createHarness({ dataDir: data, catalogue, pluginKeys: keysDir });
  const list = await h.catalogue();
  assert.deepEqual(list.map((e) => [e.name, e.verified, e.installed]), [['acme', true, false], ['tampered', false, false]]);
  await assert.rejects(h.install('tampered'), /Refused: files differ[\s\S]*index\.mjs/);
  const p = await h.install('acme');
  assert.match(p.signature ?? '', /signed by acme/);
  assert.ok(h.registry.tools.has('acme_word_count'), 'new sessions get its tool');
  assert.equal((await h.catalogue())[0]!.installed, true);
  await assert.rejects(h.install('acme'), /already loaded/);
  await h.close();
  // Installed plugins load again on the next start (and are verified again).
  const h2 = await createHarness({ dataDir: data, pluginKeys: keysDir });
  assert.ok(h2.registry.plugins.some((x) => x.name === 'acme' && /signed by/.test(x.signature ?? '')));
  await h2.close();
});

test('OpenTelemetry: model and tool calls arrive as OTLP spans with GenAI attributes', async () => {
  const bodies: { resourceSpans: { scopeSpans: { spans: { name: string; traceId: string; attributes: { key: string; value: Record<string, unknown> }[] }[] }[] }[] }[] = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { if (req.url === '/v1/traces') bodies.push(JSON.parse(b)); res.end('{}'); });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  const prev = process.env.NO_PROXY;
  process.env.NO_PROXY = '127.0.0.1';
  const h = await createHarness({ dataDir: await tempDir(), otelEndpoint: `http://127.0.0.1:${port}` });
  h.registry.setProviderInstance('deepseek', new FakeProvider([{ calls: [{ name: 'bash', input: { command: 'echo hi' } }] }, { text: 'done' }]));
  const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: await tempDir() } });
  const ended = new Promise<void>((r) => s.subscribe(0, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
  await s.send('say hi');
  await ended;
  await h.close();
  srv.close();
  if (prev === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = prev;
  const spans = bodies.flatMap((b) => b.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((x) => x.spans)));
  assert.deepEqual(spans.map((x) => x.name), ['chat deepseek-flash', 'execute_tool bash', 'chat deepseek-flash']);
  assert.equal(new Set(spans.map((x) => x.traceId)).size, 1, 'one trace per session');
  const keys = spans[0]!.attributes.map((a) => a.key);
  for (const k of ['gen_ai.request.model', 'gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens', 'harness.cost_usd', 'harness.session.id']) assert.ok(keys.includes(k), k);
});
