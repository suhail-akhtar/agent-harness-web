// A plugin as a bundle: how it is shown (name, icon, tags, publisher, links, licence, changelog), which harness
// versions it runs on (a plugin made for others is not loaded, with what to do), and how it moves and changes:
// exported as a .tgz, imported on another server or computer, updated (the version before kept), rolled back.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { pack } from '../src/plugins/archive.ts';
import { bundleInfo, compareVersions, compatibility, HARNESS_VERSION, satisfies } from '../src/plugins/bundle.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { reviewPlugin } from '../src/plugins/review.ts';
import { tempDir } from './helpers.ts';

test('versions: npm-style ranges and ordering', () => {
  assert.equal(compareVersions('1.2.3', '1.10.0'), -1);
  assert.equal(compareVersions('2.0.0', '2.0.0-beta.1'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  const yes: Array<[string, string]> = [['0.1.0', '>=0.1.0'], ['1.4.2', '^1.2.0'], ['0.2.5', '^0.2.1'], ['1.2.9', '~1.2.3'], ['1.9.0', '1.x'], ['3.0.0', '>=1 <4'], ['5.0.0', '<2 || >=5'], ['1.5.0', '1.0.0 - 2.0.0'], ['7.7.7', '*']];
  const no: Array<[string, string]> = [['0.0.9', '>=0.1.0'], ['2.0.0', '^1.2.0'], ['0.3.0', '^0.2.1'], ['1.3.0', '~1.2.3'], ['2.0.0', '1.x'], ['4.0.0', '>=1 <4'], ['3.0.0', '<2 || >=5']];
  for (const [v, r] of yes) assert.equal(satisfies(v, r), true, `${v} in ${r}`);
  for (const [v, r] of no) assert.equal(satisfies(v, r), false, `${v} not in ${r}`);
  assert.equal(compatibility({ engines: { harness: '>=99.0.0' } }, '0.1.0').ok, false);
  assert.match(compatibility({ engines: { harness: '>=99.0.0' } }, '0.1.0').reason!, /runs on harness >=99\.0\.0; this one is 0\.1\.0/);
  assert.equal(compatibility({}).ok, true, 'no range: runs everywhere');
});

async function plugin(root: string, name: string, version: string, extra: Record<string, unknown> = {}, said = version): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'harness-plugin.json'), JSON.stringify({ name, version, description: `${name}: says which version it is, for the tests.`, main: 'index.mjs', ...extra }));
  await fs.writeFile(path.join(dir, 'index.mjs'), `export default { name: ${JSON.stringify(name)}, setup(api) { api.registerTool({ name: 'which_version', description: 'Says the version.', kind: 'read', parameters: { type: 'object', properties: {} }, run: async () => ${JSON.stringify(said)} }); } };\n`);
  return dir;
}

test('the bundle: display name, icon image, tags, publisher, https links only, changelog; the review checks them', async () => {
  const dir = await plugin(await tempDir(), 'pretty', '1.2.0', {
    displayName: 'Pretty Plugin', icon: 'icon.svg', tags: ['Lists', 'tasks'], keywords: ['tasks', 'todo'], category: 'Productivity',
    publisher: { name: 'Acme Ltd', url: 'https://acme.example' }, author: 'Ann Smith <ann@acme.example> (https://ann.example)', license: 'MIT',
    links: { docs: 'https://acme.example/docs', support: 'mailto:help@acme.example', privacy: 'javascript:alert(1)' }, homepage: 'https://acme.example',
    engines: { harness: `>=${HARNESS_VERSION}` }, updates: { url: 'http://insecure.example/index.json' },
  });
  await fs.writeFile(path.join(dir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>');
  await fs.writeFile(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 1.2.0\n\n- Prettier.\n');
  const info = await bundleInfo(JSON.parse(await fs.readFile(path.join(dir, 'harness-plugin.json'), 'utf8')), dir);
  assert.equal(info.displayName, 'Pretty Plugin');
  assert.match(info.iconData!, /^data:image\/svg\+xml;base64,/);
  assert.deepEqual(info.tags, ['lists', 'tasks', 'todo']);
  assert.deepEqual(info.publisher, { name: 'Acme Ltd', url: 'https://acme.example' });
  assert.deepEqual(info.author, { name: 'Ann Smith', email: 'ann@acme.example', url: 'https://ann.example' });
  assert.deepEqual(info.links, { homepage: 'https://acme.example', docs: 'https://acme.example/docs', support: 'mailto:help@acme.example' }, 'a javascript: link is dropped');
  assert.match(info.changelog!, /Prettier/);
  assert.equal(info.compat.ok, true);
  assert.equal(info.updatesUrl, undefined, 'updates only over https');
  const r = await reviewPlugin(dir, { runTests: false });
  const list = r.findings.map((f) => `${f.level} [${f.area}] ${f.message}`).join('\n');
  assert.ok(!/Unknown field/.test(list), list);
  assert.ok(r.findings.some((f) => f.area === 'bundle' && /"privacy" javascript:alert\(1\) is not an https/.test(f.message)), list);
  assert.ok(r.findings.some((f) => f.area === 'bundle' && /"updates" .* updates are not looked for there/.test(f.message)), list);
});

test('harness versions: a plugin made for other versions is not loaded, and says what to do; HARNESS_PLUGIN_IGNORE_ENGINES=1 loads it anyway', async () => {
  const root = await tempDir();
  await plugin(root, 'future', '1.0.0', { engines: { harness: '>=99.0.0' } });
  const data = await tempDir();
  let h = await createHarness({ dataDir: data, plugins: [root], backgroundWork: false, scheduler: false, search: null });
  try {
    const e = h.plugins.get('future');
    assert.equal(h.registry.tools.has('which_version'), false);
    assert.match(e?.error ?? '', /not for this harness: it runs on harness >=99\.0\.0; this one is \d+\.\d+\.\d+/);
  } finally { await h.close(); }
  process.env.HARNESS_PLUGIN_IGNORE_ENGINES = '1';
  try {
    h = await createHarness({ dataDir: await tempDir(), plugins: [root], backgroundWork: false, scheduler: false, search: null });
    assert.equal(h.registry.tools.has('which_version'), true);
    await h.close();
  } finally { delete process.env.HARNESS_PLUGIN_IGNORE_ENGINES; }
});

test('moving and changing a plugin: export, import on another server, update (the version before kept), roll back; the catalogue offers a newer version', async () => {
  const src = await tempDir();
  const v1 = await pack(await plugin(src, 'mover', '1.0.0', { publisher: { name: 'Acme' } }));
  const v2 = await pack(await plugin(path.join(src, 'v2'), 'mover', '2.0.0'));
  const catalogue = await tempDir();
  await plugin(catalogue, 'mover', '3.0.0');
  const data = await tempDir();
  const h = await createHarness({ dataDir: data, plugins: [], catalogue, backgroundWork: false, scheduler: false, search: null });
  const run = async () => { const r = await (h.registry.tools.get('which_version') as { run: (i: unknown, c: unknown) => Promise<unknown> }).run({}, {}); return typeof r === 'string' ? r : String((r as { content?: unknown }).content); };
  try {
    // Unsigned bundles: only on the person's own computer when the server has no trust list.
    await assert.rejects(h.plugins.importBundle(v1), (e: Error & { status?: number }) => e.status === 403 && /no trust list/.test(e.message));
    await assert.rejects(h.plugins.importBundle(Buffer.from('not a bundle'), { allowUnsigned: true }), /Not a plugin bundle/);
    const e1 = await h.plugins.importBundle(v1, { allowUnsigned: true });
    assert.deepEqual([e1.name, e1.version, e1.source, e1.info?.publisher?.name], ['mover', '1.0.0', 'installed', 'Acme']);
    assert.equal(await run(), '1.0.0');
    // The same version again, or an earlier one: refused.
    await assert.rejects(h.plugins.importBundle(v1, { allowUnsigned: true }), /1\.0\.0 is installed; this bundle is 1\.0\.0/);
    // A newer bundle updates it in place; the version before is kept.
    const e2 = await h.plugins.importBundle(v2, { allowUnsigned: true });
    assert.equal(e2.version, '2.0.0');
    assert.equal(await run(), '2.0.0', 'the new code runs');
    assert.deepEqual((await h.plugins.revisions('mover')).map((r) => r.version), ['1.0.0']);
    // The catalogue has 3.0.0.
    assert.deepEqual((await h.plugins.checkUpdates()).map((u) => [u.name, u.version, u.latest]), [['mover', '2.0.0', '3.0.0']]);
    assert.equal(h.plugins.get('mover')?.update?.latest, '3.0.0');
    const e3 = await h.plugins.update('mover');
    assert.deepEqual([e3.version, e3.update], ['3.0.0', undefined]);
    assert.equal(await run(), '3.0.0');
    assert.deepEqual((await h.plugins.revisions('mover')).map((r) => r.version), ['2.0.0', '1.0.0']);
    await assert.rejects(h.plugins.update('mover'), /3\.0\.0 is the newest version/);
    // Roll back to 1.0.0; 3.0.0 is kept in turn.
    const one = (await h.plugins.revisions('mover')).find((r) => r.version === '1.0.0')!;
    const back = await h.plugins.rollback('mover', one.id);
    assert.equal(back.version, '1.0.0');
    assert.equal(await run(), '1.0.0');
    assert.deepEqual((await h.plugins.revisions('mover')).map((r) => r.version).sort(), ['2.0.0', '3.0.0']);
    // Exported: the bundle is the plugin as it is now, ready for another server.
    const out = await h.plugins.exportBundle('mover');
    const h2 = await createHarness({ dataDir: await tempDir(), plugins: [], backgroundWork: false, scheduler: false, search: null });
    try {
      const moved = await h2.plugins.importBundle(out, { allowUnsigned: true });
      assert.deepEqual([moved.name, moved.version, h2.registry.tools.has('which_version')], ['mover', '1.0.0', true]);
    } finally { await h2.close(); }
    // A shipped plugin updates with the harness.
    await assert.rejects(h.plugins.update('nope'), /No plugin "nope"/);
  } finally { await h.close(); }
});

test('every plugin as its own bundle (plugin bundles): one .tgz each, signed in a copy, an index a server installs from and checks', async () => {
  const { writeBundles } = await import('../src/plugins/bundles.ts');
  const { generateKeyPair } = await import('../src/plugins/signing.ts');
  const { unpack } = await import('../src/plugins/archive.ts');
  const crypto = await import('node:crypto');
  const src = await tempDir();
  await plugin(src, 'alpha', '1.2.0', { publisher: { name: 'Acme' }, tags: ['one'], engines: { harness: '>=0.1.0' } });
  await plugin(src, 'beta', '0.3.0', { requires: ['alpha'] });
  const keys = await tempDir();
  const pair = generateKeyPair();
  await fs.writeFile(path.join(keys, 'test-publisher.pub.pem'), pair.publicPem);
  const out = path.join(await tempDir(), 'bundles');
  const r = await writeBundles({ from: src, out, key: pair.privatePem, base: 'https://plugins.example/' });
  assert.deepEqual(r.bundles.map((b) => [b.file, b.signed]), [['alpha-1.2.0.tgz', true], ['beta-0.3.0.tgz', true]]);
  assert.equal(await fs.stat(path.join(src, 'alpha', 'harness-plugin.sig')).then(() => true, () => false), false, 'the source folder is not changed');
  const index = JSON.parse(await fs.readFile(r.index, 'utf8')) as { plugins: Array<Record<string, unknown>> };
  assert.deepEqual(index.plugins.map((p) => [p.name, p.version, p.url, p.publisher ?? null, p.requires ?? null]), [['alpha', '1.2.0', 'https://plugins.example/alpha-1.2.0.tgz', 'Acme', null], ['beta', '0.3.0', 'https://plugins.example/beta-0.3.0.tgz', null, ['alpha']]]);
  const data = await fs.readFile(path.join(out, 'alpha-1.2.0.tgz'));
  assert.equal(index.plugins[0]!.sha256, crypto.createHash('sha256').update(data).digest('hex'));
  // A server with that publisher's key installs it (signature checked); one without the key refuses it.
  const h = await createHarness({ dataDir: await tempDir(), plugins: [], pluginKeys: keys, backgroundWork: false, scheduler: false, search: null });
  try {
    const e = await h.plugins.importBundle(data);
    assert.deepEqual([e.name, e.version, /^signed by test-publisher/.test(e.signature ?? '')], ['alpha', '1.2.0', true]);
  } finally { await h.close(); }
  const tampered = await tempDir();
  await unpack(data, path.join(tampered, 'alpha'));
  await fs.appendFile(path.join(tampered, 'alpha', 'index.mjs'), '\n// changed\n');
  const h2 = await createHarness({ dataDir: await tempDir(), plugins: [], pluginKeys: keys, backgroundWork: false, scheduler: false, search: null });
  try { await assert.rejects(h2.plugins.importBundle(await pack(path.join(tampered, 'alpha'))), /Refused/); } finally { await h2.close(); }
});

test("an official publisher (publisherKeys, the desktop product's trustedKeys): its signed bundle is official and verified; a changed one says so; the person's own plugins still load", async () => {
  const { signPlugin, generateKeyPair } = await import('../src/plugins/signing.ts');
  const { unpack } = await import('../src/plugins/archive.ts');
  const pair = generateKeyPair();
  const keys = await tempDir();
  await fs.writeFile(path.join(keys, 'acme.pub.pem'), pair.publicPem);
  const src = await tempDir();
  const official = await plugin(src, 'studio-like', '1.1.0');
  await signPlugin(official, pair.privatePem);
  const data = await pack(official);
  const mine = path.join(await tempDir(), 'my-own');
  await fs.mkdir(mine);
  await fs.writeFile(path.join(mine, 'harness-plugin.json'), JSON.stringify({ name: 'my-own', version: '0.1.0', description: 'A plugin of the person\'s own, unsigned, for the tests.' }));
  const changed = await tempDir();
  await unpack(data, path.join(changed, 'studio-like'));
  await fs.appendFile(path.join(changed, 'studio-like', 'index.mjs'), '\n// changed\n');
  // No trust list (a person's own computer): nothing is refused for its signature.
  const h = await createHarness({ dataDir: await tempDir(), plugins: [mine], publisherKeys: keys, backgroundWork: false, scheduler: false, search: null });
  try {
    const e = await h.plugins.importBundle(data, { allowUnsigned: true });
    assert.match(e.signature ?? '', /^signed by acme \([0-9a-f]{16}\)$/);
    const listed = h.plugins.list().find((p) => p.name === 'studio-like')!;
    assert.equal(listed.tier, 'official', 'official: signed by a publisher of this product');
    const own = h.plugins.list().find((p) => p.name === 'my-own')!;
    assert.deepEqual([own.tier, !!own.loaded, own.signature], ['custom', true, 'unsigned'], "the person's own plugin loads, as custom");
  } finally { await h.close(); }
  const h2 = await createHarness({ dataDir: await tempDir(), plugins: [], publisherKeys: keys, backgroundWork: false, scheduler: false, search: null });
  try {
    const e = await h2.plugins.importBundle(await pack(path.join(changed, 'studio-like')), { allowUnsigned: true });
    assert.match(e.signature ?? '', /^signed, not verified: /, 'changed after signing: not shown as verified');
    assert.equal(h2.plugins.list().find((p) => p.name === 'studio-like')!.tier, 'custom');
  } finally { await h2.close(); }
});

test('a solution as one file: its plugins installed in the order they require, signed each, all or none; again: nothing changes; a newer one updates; a changed file is refused', async () => {
  const { writeSolutionBundle, readSolutionManifest } = await import('../src/plugins/solution-bundle.ts');
  const { generateKeyPair } = await import('../src/plugins/signing.ts');
  const { unpack } = await import('../src/plugins/archive.ts');
  const solution = async (version: string, engines = '>=0.1.0') => {
    const dir = path.join(await tempDir(), 'kit');
    // Listed engine first: the file puts what it requires before it.
    await fs.mkdir(path.join(dir, 'plugins'), { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: '@acme/kit', version, description: 'A kit of two.', license: 'MIT', author: 'Acme', harness: { title: 'Kit', core: '>=0.1.0', plugins: ['kit-engine', 'kit-core'] } }));
    await plugin(path.join(dir, 'plugins'), 'kit-core', version, { engines: { harness: engines } }, `core ${version}`);
    const eng = path.join(dir, 'plugins', 'kit-engine');
    await fs.mkdir(eng, { recursive: true });
    await fs.writeFile(path.join(eng, 'harness-plugin.json'), JSON.stringify({ name: 'kit-engine', version, description: 'The engine of the kit, for the tests.', requires: ['kit-core'] }));
    return dir;
  };
  const pair = generateKeyPair();
  const keys = await tempDir();
  await fs.writeFile(path.join(keys, 'acme.pub.pem'), pair.publicPem);
  const out = await tempDir();
  const w = await writeSolutionBundle(await solution('1.0.0'), out, pair.privatePem);
  assert.deepEqual([w.file, w.plugins, w.signed], ['kit-1.0.0.tgz', ['kit-core', 'kit-engine'], true]);
  const data = await fs.readFile(path.join(out, w.file));
  const look = path.join(await tempDir(), 'kit');
  await unpack(data, look);
  assert.equal((await readSolutionManifest(look))!.title, 'Kit');
  assert.ok(await fs.stat(path.join(look, 'plugins', 'kit-core', 'harness-plugin.sig')), 'each plugin signed');

  const h = await createHarness({ dataDir: await tempDir(), plugins: [], pluginKeys: keys, backgroundWork: false, scheduler: false, search: null });
  try {
    const r = await h.plugins.importFile(data);
    assert.equal(r.kind, 'solution');
    if (r.kind !== 'solution') return;
    assert.deepEqual([r.solution, r.plugins.map((p) => p.name), r.unchanged], [{ name: 'kit', title: 'Kit', version: '1.0.0' }, ['kit-core', 'kit-engine'], []]);
    assert.ok(r.plugins.every((p) => p.source === 'installed' && !!p.loaded && /^signed by acme/.test(p.signature ?? '')));
    // The same file again: nothing changes.
    const again = await h.plugins.importFile(data);
    assert.deepEqual(again.kind === 'solution' && [again.plugins.length, again.unchanged], [0, ['kit-core', 'kit-engine']]);
    // A newer one: both updated, the versions before kept.
    const w2 = await writeSolutionBundle(await solution('1.1.0'), out, pair.privatePem);
    const r2 = await h.plugins.importFile(await fs.readFile(path.join(out, w2.file)));
    assert.deepEqual(r2.kind === 'solution' && r2.plugins.map((p) => `${p.name} ${p.version}`), ['kit-core 1.1.0', 'kit-engine 1.1.0']);
    assert.equal((await h.plugins.revisions('kit-core'))[0]?.version, '1.0.0');
    // One file changed after signing (of the version installed): refused, nothing changes.
    const changed = path.join(await tempDir(), 'kit');
    await unpack(await fs.readFile(path.join(out, w2.file)), changed);
    await fs.appendFile(path.join(changed, 'plugins', 'kit-engine', 'harness-plugin.json'), ' ');
    await assert.rejects(h.plugins.importFile(await pack(changed)), /Refused: kit-engine/);
  } finally { await h.close(); }

  // All or none: a plugin that does not run on this harness stops the whole solution before anything is added.
  const h2 = await createHarness({ dataDir: await tempDir(), plugins: [], backgroundWork: false, scheduler: false, search: null });
  try {
    const bad = await writeSolutionBundle(await solution('2.0.0', '>=99.0.0'), out);
    await assert.rejects(h2.plugins.importFile(await fs.readFile(path.join(out, bad.file)), { allowUnsigned: true }), /kit-core 2\.0\.0 is not for this harness/);
    assert.deepEqual(h2.plugins.list().filter((p) => p.name.startsWith('kit-')), []);
    // Unsigned, where the server has no trust list: only on the person's own computer.
    await assert.rejects(h2.plugins.importFile(data), /no trust list/);
  } finally { await h2.close(); }
});

test('bundles over the API: administrators export, import, check, update and roll back; a member may not; plugins may not take these paths', async () => {
  const { createApp } = await import('../src/server/app.ts');
  const { UserStore } = await import('../src/server/users.ts');
  const src = await tempDir();
  const v1 = new Uint8Array(await pack(await plugin(src, 'mover', '1.0.0')));
  const data = await tempDir();
  const h = await createHarness({ dataDir: data, plugins: [], backgroundWork: false, scheduler: false, search: null });
  const users = await new UserStore(data).load();
  const member = await users.add('Mia');
  const { server } = createApp({ harness: h, token: 'op-token', loopback: true, localRoots: [data], uiDir: data, appRoot: data, users });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = (method: string, p: string, body?: BodyInit, token = 'op-token', type = 'application/json') => fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, 'content-type': type, 'x-harness': '1' }, body });
  try {
    assert.equal((await call('POST', '/api/plugins/import', v1, member.token, 'application/gzip')).status, 403);
    const imp = await call('POST', '/api/plugins/import', v1, 'op-token', 'application/gzip');
    assert.equal(imp.status, 201);
    assert.equal((await imp.json() as { version: string }).version, '1.0.0');
    const list = await (await call('GET', '/api/plugins')).json() as Array<{ name: string; info?: { displayName: string; compat: { ok: boolean } } }>;
    assert.deepEqual(list.find((p) => p.name === 'mover')?.info?.displayName, 'mover');
    const exp = await call('GET', '/api/plugins/mover/export');
    assert.equal(exp.status, 200);
    assert.match(exp.headers.get('content-disposition') ?? '', /mover-1\.0\.0\.tgz/);
    assert.ok((await exp.arrayBuffer()).byteLength > 100);
    assert.equal((await call('GET', '/api/plugins/mover/export', undefined, member.token)).status, 403);
    assert.deepEqual(await (await call('GET', '/api/plugins/updates')).json(), []);
    assert.equal((await call('POST', '/api/plugins/mover/update', '{}')).status, 409);
    assert.deepEqual(await (await call('GET', '/api/plugins/mover/revisions')).json(), []);
    assert.equal((await call('POST', '/api/plugins/mover/rollback', '{}')).status, 404);
  } finally { await new Promise<void>((r) => server.close(() => r())); await h.close(); }
  // A plugin cannot register the server's own paths.
  const bad = await plugin(await tempDir(), 'squatter', '1.0.0', { permissions: { routes: true } });
  await fs.writeFile(path.join(bad, 'index.mjs'), "export default { name: 'squatter', setup(api) { api.registerRoute({ method: 'POST', path: 'update', auth: 'user', handler: async () => ({ status: 200, body: {} }) }); } };\n");
  const h3 = await createHarness({ dataDir: await tempDir(), plugins: [path.dirname(bad)], backgroundWork: false, scheduler: false, search: null });
  try { assert.match(h3.plugins.get('squatter')?.error ?? '', /route path "update" is reserved/); } finally { await h3.close(); }
});
