// The plugin SDK end to end: `plugin new` writes a plugin that loads, passes its own tests (run by
// `plugin test`, '@harness/plugin-sdk' importable from a folder outside the checkout) and passes the deep
// review with no findings, in TypeScript and in JavaScript; the test kit calls tools (schema-checked as
// the agent does), routes over HTTP and a scripted conversation; and the review finds what a flawed
// plugin gets wrong, each finding with what to do.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { scaffold } from '../src/plugins/scaffold.ts';
import { reviewPlugin } from '../src/plugins/review.ts';
import { loadPlugin } from '../src/plugins/testkit.ts';
import { tempDir } from './helpers.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');

for (const js of [false, true]) {
  test(`plugin new (${js ? 'JavaScript' : 'TypeScript'}): it loads, its own tests pass, and the deep review finds nothing`, async () => {
    const dir = path.join(await tempDir(), 'task-board');
    const files = await scaffold(dir, 'task-board', { js, repoRoot });
    assert.ok(files.includes('harness-plugin.json') && files.includes(`index.${js ? 'mjs' : 'ts'}`) && files.includes(`test/plugin.test.${js ? 'mjs' : 'ts'}`));
    await assert.rejects(scaffold(dir, 'task-board', { js, repoRoot }), /is not empty/);
    const r = await reviewPlugin(dir);
    assert.deepEqual(r.findings, [], JSON.stringify(r.findings, null, 1) + (r.tests?.output ?? ''));
    assert.equal(r.ok, true);
    assert.equal(r.score, 100);
    assert.deepEqual(r.tests && [r.tests.files, r.tests.passed], [1, true]);
    assert.deepEqual([r.adds.tools.length, r.adds.routes.length, r.adds.skills, r.adds.pages], [3, 4, ['task-board'], 1]);
  });
}

test('the test kit: tools checked against their schema, routes over HTTP, a scripted conversation, signals', async () => {
  const dir = path.join(await tempDir(), 'kit-demo');
  await scaffold(dir, 'kit-demo', { repoRoot });
  const kit = await loadPlugin(dir);
  try {
    assert.deepEqual(await kit.tool('kit_demo_add', {}), { content: 'missing required parameter "title"', isError: true }, 'as the agent checks input');
    assert.match((await kit.tool('kit_demo_add', { title: 'One' })).content, /^Added \[ \] \w+ One$/);
    await assert.rejects(kit.tool('nope'), /No tool "nope"\. kit-demo adds: kit_demo_add, kit_demo_list, kit_demo_done|No tool "nope"/);
    const got = await kit.route('GET', 'items');
    assert.deepEqual([got.status, got.body.open], [200, 1]);
    assert.equal((await kit.route('GET', 'missing')).status, 404);
    assert.match(String((await kit.route('GET', 'missing')).body.error), /kit-demo|Kit Demo/);
    const chat = await kit.chat('what is on my list?', { script: [{ calls: [{ name: 'kit_demo_list' }] }, { text: 'One thing: One.' }] });
    assert.deepEqual(chat.calls.map((c) => [c.name, c.result]), [['kit_demo_list', chat.calls[0]!.result]]);
    assert.match(chat.calls[0]!.result, /One/);
    assert.equal(chat.text, 'One thing: One.');
    assert.equal(chat.cost, 0);
    assert.deepEqual(kit.signals, ['items']);
  } finally { await kit.close(); }
});

test('the review: what a flawed plugin gets wrong, with what to do', async () => {
  const dir = path.join(await tempDir(), 'flawed');
  await fs.mkdir(path.join(dir, 'ui'), { recursive: true });
  await fs.writeFile(path.join(dir, 'harness-plugin.json'), JSON.stringify({
    name: 'flawed', version: '1', main: 'index.mjs', permisions: {}, permissions: { routes: true, network: ['api.example.com'], secrets: ['UNUSED_KEY'] },
    ui: { apiVersion: 1, displayName: 'Flawed', capabilities: ['routes.call', 'clipboard.write'], contributes: {
      views: [{ id: 'main', title: 'Main', kind: 'frame', entry: 'ui/index.html' }, { id: 'gone', title: 'Gone', kind: 'frame', entry: 'ui/missing.html' }],
    } },
  }));
  await fs.writeFile(path.join(dir, 'index.mjs'), `import { execSync } from 'node:child_process';
export default { name: 'flawed', setup(api) {
  const key = process.env.SOME_KEY; const other = api.secret('OTHER_KEY');
  api.registerTool({ name: 'do_it', description: 'Does it', parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['y'] }, kind: 'read', run: async () => { const o = undefined; return o.boom; } });
  api.registerRoute({ method: 'GET', path: 'data', auth: 'user', handler: async () => { throw new Error('db down'); } });
  api.registerRoute({ method: 'POST', path: 'save', auth: 'none', handler: async (req) => ({ status: 200, body: { saved: JSON.parse(req.body.toString()).x.y } }) });
} };
`);
  await fs.writeFile(path.join(dir, 'ui', 'index.html'), `<!doctype html><script src="https://cdn.example.com/lib.js"></script><script>
HarnessPluginUI.connect().then(async (h) => { await h.routes.call('nothing-here'); await h.sessions.list(); fetch('https://api.example.com'); });
</script>`);
  await fs.writeFile(path.join(dir, 'secrets.txt'), 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789');
  const r = await reviewPlugin(dir);
  const has = (level: string, area: RegExp, msg: RegExp) => assert.ok(r.findings.some((f) => f.level === level && area.test(f.area) && msg.test(f.message)), `expected ${level} ${area} ${msg} in\n${r.findings.map((f) => `${f.level} [${f.area}] ${f.message}`).join('\n')}`);
  assert.equal(r.ok, false);
  has('warning', /manifest/, /Unknown field "permisions"/);
  has('warning', /manifest/, /"version" "1" is not a version/);
  has('error', /security/, /secrets\.txt holds what looks like an API key/);
  has('warning', /security/, /starts processes on the server/);
  has('warning', /security/, /reads the server's environment directly/);
  has('warning', /permissions/, /declares network hosts .* never calls api\.fetch/);
  has('error', /permissions/, /reads the secret OTHER_KEY but permissions\.secrets does not declare it/);
  has('warning', /permissions/, /declares the secret UNUSED_KEY but never reads it/);
  has('error', /load/, /did not load|could not be loaded/);
  has('error', /page ui\/missing\.html/, /not in the plugin folder/);
  has('error', /page ui\/index\.html/, /loads a script from the web/);
  has('error', /page ui\/index\.html/, /uses HarnessPluginUI but does not load the SDK/);
  has('error', /page ui\/index\.html/, /reaches the network/);
  has('error', /page ui\/index\.html/, /sessions\.list, which needs the "sessions\.read" capability/);
  has('warning', /pages/, /declares the "clipboard\.write" capability but no page uses it/);
  has('warning', /tests/, /no tests/);
  assert.ok(r.findings.every((f) => f.level !== 'error' || f.message.length > 20));
  assert.ok(r.score < 50);
});

test('the review: a plugin that loads, with tool, route and page problems', async () => {
  const dir = path.join(await tempDir(), 'shaky');
  await fs.mkdir(path.join(dir, 'ui'), { recursive: true });
  await fs.writeFile(path.join(dir, 'harness-plugin.json'), JSON.stringify({
    name: 'shaky', version: '1.0.0', description: 'A plugin with problems the review should find.', main: 'index.mjs', permissions: { routes: true },
    ui: { apiVersion: 1, displayName: 'Shaky', icon: 'bug', capabilities: ['routes.call'], contributes: { views: [{ id: 'main', title: 'Main', kind: 'frame', entry: 'ui/index.html' }] } },
  }));
  await fs.writeFile(path.join(dir, 'index.mjs'), `export default { name: 'shaky', setup(api) {
  api.registerTool({ name: 'shaky_read', description: 'Reads', parameters: { type: 'object', properties: { q: {} }, required: ['nope'] }, kind: 'read', run: async () => 'ok' });
  api.registerTool({ name: 'shaky_crash', description: 'Reads the shaky things for the agent; use it when asked about them.', parameters: { type: 'object', properties: {} }, kind: 'read', run: async () => { const o = undefined; return o.boom; } });
  api.registerRoute({ method: 'GET', path: 'data', auth: 'user', handler: async () => { throw new Error('db down'); } });
  api.registerRoute({ method: 'POST', path: 'save', auth: 'user', handler: async (req) => ({ status: 200, body: { saved: JSON.parse(req.body.toString()).x.y } }) });
} };
`);
  await fs.writeFile(path.join(dir, 'ui', 'index.html'), `<!doctype html><link rel="stylesheet" href="harness://app/sdk/plugin-ui.css"><script src="harness://app/sdk/plugin-ui.js"></script><script>
HarnessPluginUI.connect().then(async (h) => { await h.routes.call('nothing-here'); });
</script>`);
  const r = await reviewPlugin(dir, { runTests: false });
  const has = (level: string, area: RegExp, msg: RegExp) => assert.ok(r.findings.some((f) => f.level === level && area.test(f.area) && msg.test(f.message)), `expected ${level} ${area} ${msg} in\n${r.findings.map((f) => `${f.level} [${f.area}] ${f.message}`).join('\n')}`);
  has('warning', /tool shaky_read/, /description is very short/);
  has('error', /tool shaky_read/, /"nope" is required but is not among its properties/);
  has('warning', /tool shaky_read/, /without a description: q/);
  has('error', /tool shaky_crash/, /it crashed/);
  has('error', /route GET data/, /fails \(500\).*db down/);
  has('error', /route POST save/, /empty body makes it fail \(500\)/);
  has('error', /page ui\/index\.html/, /calls the route "nothing-here", which the plugin does not register/);
  assert.equal(r.ok, false);
});
