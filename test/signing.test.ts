import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHarness } from '../src/kernel/harness.ts';
import { generateKeyPair, loadTrustedKeys, signPlugin, verifyPlugin } from '../src/plugins/signing.ts';
import { FakeProvider, tempDir } from './helpers.ts';
import { shippedPluginDirs } from '../src/plugins/shipped.ts';
import { pluginDir } from '../src/plugins/test-fixtures.ts';

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
    dataDir: await tempDir(), plugins: [pluginDir('sdlc'), extra, unsignedRoot],
    shippedPlugins: shippedPluginDirs(path.join(here, '..')), pluginKeys: keysDir, log: (m) => logs.push(m),
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

test('archives: a folder packs to the same bytes every time and unpacks intact; unsafe archives are refused', async () => {
  const { pack, unpack } = await import('../src/plugins/archive.ts');
  const zlib = await import('node:zlib');
  const dir = await copyAcme(path.join(await tempDir(), 'acme'));
  const a = await pack(dir);
  assert.deepEqual(a, await pack(dir), 'deterministic');
  const out = path.join(await tempDir(), 'x');
  const files = await unpack(a, out);
  assert.ok(files.includes('harness-plugin.json') && files.includes('index.mjs'));
  assert.equal(await fs.readFile(path.join(out, 'index.mjs'), 'utf8'), await fs.readFile(path.join(dir, 'index.mjs'), 'utf8'));
  // Hand-made hostile archives: a path out of the folder, and a symbolic link.
  const entry = (name: string, type: string, body = '') => {
    const h = Buffer.alloc(512);
    h.write(name, 0); h.write('0000644\0', 100); h.write(body.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136);
    h.write(type, 156); if (type === '2') h.write('/etc/passwd', 157); h.write('ustar\0', 257); h.write('00', 263);
    h.write('        ', 148); let sum = 0; for (const b of h) sum += b; h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    const data = Buffer.alloc(Math.ceil(body.length / 512) * 512); data.write(body);
    return Buffer.concat([h, data]);
  };
  const tgz = (...e: Buffer[]) => zlib.gzipSync(Buffer.concat([...e, Buffer.alloc(1024)]));
  await assert.rejects(unpack(tgz(entry('../../evil.txt', '0', 'x')), path.join(await tempDir(), 'a')), /unsafe path/);
  await assert.rejects(unpack(tgz(entry('/etc/evil', '0', 'x')), path.join(await tempDir(), 'b')), /unsafe path/);
  await assert.rejects(unpack(tgz(entry('link', '2')), path.join(await tempDir(), 'c')), /not a plain file or folder/);
});

test('remote catalogue: lists from index.json, installs only what matches its hash and signature', async () => {
  const { pack } = await import('../src/plugins/archive.ts');
  const crypto = await import('node:crypto');
  const { keysDir, k } = await setupKeys();
  const src = await copyAcme(path.join(await tempDir(), 'acme'));
  await signPlugin(src, k.privatePem);
  const good = await pack(src);
  await fs.appendFile(path.join(src, 'index.mjs'), '\n// changed after signing\n');
  const resigned = await pack(src); // signature no longer matches the files
  const served: Record<string, Buffer> = { '/good.tgz': good, '/tampered.tgz': resigned };
  let index = { plugins: [{ name: 'acme', version: '1.0.0', description: 'Word counts', url: 'good.tgz', sha256: crypto.createHash('sha256').update(good).digest('hex') }] };
  const srv = http.createServer((req, res) => {
    if (req.url === '/catalogue/index.json') return res.end(JSON.stringify(index));
    const body = served[req.url!.replace('/catalogue', '')];
    if (!body) { res.writeHead(404); return res.end(); }
    res.end(body);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/catalogue/index.json`;
  const prev = process.env.NO_PROXY;
  process.env.NO_PROXY = '127.0.0.1';
  try {
    const h = await createHarness({ dataDir: await tempDir(), catalogue: url, pluginKeys: keysDir, search: null });
    assert.deepEqual((await h.catalogue()).map((e) => [e.name, e.remote, e.installed]), [['acme', true, false]]);
    // A download that does not match its hash is refused before anything is unpacked.
    index = { plugins: [{ ...index.plugins[0]!, url: 'tampered.tgz' }] };
    await assert.rejects(h.install('acme'), /does not match the catalogue's sha256/);
    // A matching hash is not enough: the files must match the plugin's signature.
    index = { plugins: [{ ...index.plugins[0]!, sha256: crypto.createHash('sha256').update(resigned).digest('hex') }] };
    await assert.rejects(h.install('acme'), /Refused: files differ[\s\S]*index\.mjs/);
    index = { plugins: [{ name: 'acme', version: '1.0.0', description: 'Word counts', url: 'good.tgz', sha256: crypto.createHash('sha256').update(good).digest('hex') }] };
    const p = await h.install('acme');
    assert.match(p.signature ?? '', /signed by acme/);
    assert.ok(h.registry.tools.has('acme_word_count'));
    assert.equal((await h.catalogue())[0]!.installed, true);
    await h.close();
  } finally {
    srv.close();
    if (prev === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = prev;
  }
});
