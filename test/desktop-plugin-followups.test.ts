// What the domain plugins (sdlc, aiops) needed from the core, for any plugin: a frame asking what
// is installed (registry.has / registry.list) and drawing with a host renderer (render.show); its
// account-scope settings, the scope enforced in the app and on the server; badge sources the host
// reads while no page of the plugin is open; the aiops inventory gates only in operations projects.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PROTOCOL, validateUiManifest, type UiManifest } from '../packages/plugin-ui/src/index.ts';
import { badParams, handleFrameCall, registryAnswer } from '../apps/desktop/renderer/src/registry/frame-host.ts';
import { buildRegistry, type PluginEntry } from '../apps/desktop/renderer/src/registry/registry.ts';
import { hasAccountKeys, mergedSettings, settingKeys, settingWrite } from '../apps/desktop/renderer/src/registry/plugin-settings.ts';
import { badgePlan, badgeValues, runBadges } from '../apps/desktop/renderer/src/state/badges.ts';
import { cleanPluginSettings } from '../src/server/settings-api.ts';
import type { PluginEntry as ServerPluginEntry } from '../src/kernel/harness.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { LocalHost } from '../src/runtime/host.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir } from './helpers.ts';
import { pluginDir } from '../src/plugins/test-fixtures.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = async (name: string) => validateUiManifest(JSON.parse(await fs.readFile(path.join(pluginDir(name), 'harness-plugin.json'), 'utf8')).ui);
const entry = (name: string, ui: UiManifest, source = 'bundled'): PluginEntry => ({ name, source, enabled: true, ui });

test('registry.has / registry.list: what else is installed, ids and yes/no only; any frame may ask', async () => {
  const diagrams = validateUiManifest({ trust: 'frame', contributes: { renderers: [{ id: 'canvas', for: { fence: 'diagram' }, kind: 'frame', entry: 'ui/d.html' }], views: [{ id: 'board', title: 'Board (secret title)', kind: 'frame', entry: 'ui/b.html' }] } });
  const r = buildRegistry([entry('aiops', await manifest('aiops')), entry('acme-diagrams', diagrams)]);
  assert.equal(registryAnswer(r, 'aiops', 'registry.has', { renderer: 'diagram' }), true);
  assert.equal(registryAnswer(r, 'aiops', 'registry.has', { renderer: 'fence:diagram' }), true);
  assert.equal(registryAnswer(r, 'aiops', 'registry.has', { renderer: 'artifact:diagram' }), false);
  assert.equal(registryAnswer(r, 'aiops', 'registry.has', { plugin: 'acme-diagrams' }), true);
  assert.equal(registryAnswer(r, 'aiops', 'registry.has', { plugin: 'core.diagrams' }), false);
  assert.equal(registryAnswer(r, 'aiops', 'registry.has', { view: 'topology' }), true, 'its own, unprefixed');
  assert.equal(registryAnswer(r, 'aiops', 'registry.has', { view: 'acme-diagrams:board' }), true);
  assert.equal(registryAnswer(r, 'aiops', 'registry.has', { command: 'open-incident' }), true);
  assert.equal(registryAnswer(r, 'aiops', 'registry.has', { panel: 'incident' }), true);
  assert.deepEqual(registryAnswer(r, 'aiops', 'registry.list', { kind: 'plugins' }), ['aiops', 'acme-diagrams']);
  assert.ok((registryAnswer(r, 'aiops', 'registry.list', { kind: 'renderers' }) as string[]).includes('fence:diagram'));
  assert.ok(!JSON.stringify(registryAnswer(r, 'aiops', 'registry.list', { kind: 'views' })).includes('secret title'), 'no third-party text');
  // The arguments are checked; no capability is needed.
  assert.match(badParams('registry.has', {})!, /exactly one/);
  assert.match(badParams('registry.has', { plugin: 'a', view: 'b' })!, /exactly one/);
  assert.match(badParams('registry.has', { view: '<script>' })!, /must be an id/);
  assert.match(badParams('registry.list', { kind: 'secrets' })!, /kind is one of/);
  assert.equal(badParams('registry.list', { kind: 'renderers' }), undefined);
  const call = (method: string, params: unknown) => ({ protocol: PROTOCOL, kind: 'call', id: 7, method, params });
  const impl = { 'registry.has': (p: Record<string, unknown>) => registryAnswer(r, 'aiops', 'registry.has', p) };
  const res = await handleFrameCall(call('registry.has', { renderer: 'diagram' }), { plugin: 'aiops', granted: [], gestureSeen: () => false, confirm: async () => false, impl });
  assert.deepEqual(res, { protocol: PROTOCOL, kind: 'result', id: 7, ok: true, value: true });
  // render.show: a fence language, the source, a rectangle.
  assert.equal(badParams('render.show', { fence: 'diagram', source: '{}', rect: { x: 0, y: 10, width: 400, height: 300 } }), undefined);
  assert.match(badParams('render.show', { fence: 'Diagram!', source: '{}', rect: { x: 0, y: 0, width: 1, height: 1 } })!, /fence/);
  assert.match(badParams('render.show', { fence: 'diagram', source: '{}', rect: { x: 0, y: 0, width: 1e9, height: 1 } })!, /rect/);
  assert.match(badParams('render.show', { fence: 'diagram', source: 7, rect: { x: 0, y: 0, width: 1, height: 1 } })!, /source/);
});

test('badge sources in the manifest: the plugin\'s own routes, at least every 15 seconds, routes.call declared', async () => {
  const base = { trust: 'frame', capabilities: ['routes.call'], contributes: { views: [{ id: 'v', title: 'V', kind: 'frame', entry: 'ui/v.html' }] } };
  const ok = validateUiManifest({ ...base, badges: [{ name: 'open', route: 'console/badges', every: 30, signal: true }, { name: 'firing', route: 'console/badges' }] });
  assert.deepEqual(ok.badges, [{ name: 'open', route: 'console/badges', every: 30, signal: true }, { name: 'firing', route: 'console/badges' }]);
  assert.equal(validateUiManifest(base).badges, undefined, 'optional: older manifests are unchanged');
  assert.throws(() => validateUiManifest({ ...base, capabilities: [], badges: [{ name: 'a', route: 'x' }] }), /routes\.call/);
  assert.throws(() => validateUiManifest({ ...base, badges: [{ name: 'a', route: 'x', every: 5 }] }), /15 to 86400/);
  assert.throws(() => validateUiManifest({ ...base, badges: [{ name: 'a', route: '../x' }] }), /route paths/);
  assert.throws(() => validateUiManifest({ ...base, badges: [{ name: 'a', route: 'x' }, { name: 'a', route: 'y' }] }), /Duplicate/);
  assert.throws(() => validateUiManifest({ ...base, badges: [{ name: 'a b', route: 'x' }] }), /"name"/);
  // Operations: its open-incidents and firing badges come from one route, every 30 s and on its signal.
  const aiops = await manifest('aiops');
  assert.deepEqual(aiops.badges!.map((b) => b.name), ['open', 'firing']);
  const r = buildRegistry([entry('aiops', aiops), entry('sdlc', await manifest('sdlc'))]);
  assert.deepEqual(badgePlan(r), [{ plugin: 'aiops', route: 'console/badges', method: 'GET', everyMs: 30_000, names: ['open', 'firing'], signal: true }]);
  assert.deepEqual(badgeValues(['open', 'firing'], { open: 2, firing: null, other: 9 }), { open: 2, firing: null });
  assert.deepEqual(badgeValues(['n'], 4), { n: 4 });
  assert.deepEqual(badgeValues(['n'], 'a very long text that is cut'), { n: 'a very long text tha' });
  assert.deepEqual(badgeValues(['n'], { n: { evil: true } }), {}, 'anything else sets nothing');
});

test('badge polling: read at once, again on the plugin\'s signal, paused while the window is hidden', async () => {
  const calls: string[] = []; const set: Record<string, unknown> = {};
  let hidden = false; let vis: () => void = () => {};
  let n = 0;
  const host = {
    call: async (plugin: string, route: string) => { calls.push(`${plugin}/${route}`); n++; return { open: n, firing: 1 }; },
    set: (k: string, v: unknown) => { set[k] = v; },
    hidden: () => hidden,
    onVisibility: (fn: () => void) => { vis = fn; return () => { vis = () => {}; }; },
  };
  const run = runBadges([{ plugin: 'aiops', route: 'console/badges', method: 'GET', everyMs: 15_000, names: ['open', 'firing'], signal: true }], host);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls, ['aiops/console/badges'], 'once for both badges');
  assert.deepEqual(set, { 'aiops.open': 1, 'aiops.firing': 1 });
  run.signal('aiops'); await new Promise((r) => setTimeout(r, 20));
  assert.equal(set['aiops.open'], 2, 'the signal reads again');
  run.signal('other'); await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 2, 'another plugin\'s signal does not');
  hidden = true; vis();
  run.signal('aiops'); await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 2, 'nothing while hidden');
  hidden = false; vis(); await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 3, 'shown again: read at once');
  run.stop();
});

test('a frame\'s settings: account keys with the account (checked), app keys on this computer, operator keys read-only', async () => {
  const keys = settingKeys(validateUiManifest({ trust: 'frame', capabilities: ['settings.read', 'settings.write'], contributes: { settings: [
    { id: 'mine', title: 'Mine', scope: 'account', schema: { type: 'object', properties: { model: { type: 'string', maxLength: 10 }, strict: { type: 'string', enum: ['a', 'b'] } } } },
    { id: 'here', title: 'Here', scope: 'app', schema: { type: 'object', properties: { refresh: { type: 'integer', minimum: 5 } } } },
    { id: 'policy', title: 'Policy', scope: 'operator', schema: { type: 'object', properties: { cap: { type: 'number' } } } },
  ] } }));
  assert.equal(hasAccountKeys(keys), true);
  assert.deepEqual(mergedSettings(keys, { refresh: 30, model: 'old-local', strict: 'a' }, { model: 'acct' }), { refresh: 30, strict: 'a', model: 'acct' }, 'the account wins; a key not yet in the account falls back to this computer');
  assert.deepEqual(settingWrite(keys, 'model', 'x'), { target: 'account' });
  assert.match((settingWrite(keys, 'model', 'much-too-long-a-name') as { error: string }).error, /at most 10/);
  assert.match((settingWrite(keys, 'strict', 'c') as { error: string }).error, /one of/);
  assert.deepEqual(settingWrite(keys, 'refresh', 3), { target: 'app' });
  assert.match((settingWrite(keys, 'cap', 1) as { error: string }).error, /operator/);
  assert.deepEqual(settingWrite(keys, 'undeclared', 1), { target: 'app' }, 'an undeclared key stays on this computer, as before');
  // Engineering and Operations: the person's choices (models, review strictness) follow the account; display choices stay here.
  const sdlc = settingKeys(await manifest('sdlc'));
  for (const k of ['approval', 'stack', 'strictness', 'analystModel', 'engineerModel', 'reviewerModel']) assert.equal(sdlc.get(k)?.scope, 'account', k);
  for (const k of ['gates', 'advisory']) assert.equal(sdlc.get(k)?.scope, 'app', k);
  const aiops = settingKeys(await manifest('aiops'));
  for (const k of ['evidenceModel', 'refuterModel']) assert.equal(aiops.get(k)?.scope, 'account', k);
  for (const k of ['refreshSeconds', 'minSeverity']) assert.equal(aiops.get(k)?.scope, 'app', k);
});

test('the server keeps only a plugin\'s account keys, checked against their schemas (PUT /api/me/settings plugins)', async () => {
  const plugins = [{ name: 'sdlc', ui: await manifest('sdlc'), enabled: true }, { name: 'aiops', ui: await manifest('aiops'), enabled: false }] as unknown as ServerPluginEntry[];
  const r = cleanPluginSettings({ sdlc: { strictness: 'strict', reviewerModel: 'claude-sonnet-5-5', gates: ['node-test'], hacker: 'x' }, aiops: { evidenceModel: 'deepseek-flash', refreshSeconds: 5 }, gone: { a: 1 } }, plugins, { gone: { a: 0 }, unknown: { b: 2 } });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.plugins.sdlc, { strictness: 'strict', reviewerModel: 'claude-sonnet-5-5' }, 'app keys and unknown keys are not stored with the account');
  assert.deepEqual(r.plugins.aiops, { evidenceModel: 'deepseek-flash' }, 'a plugin switched off keeps its scope rule');
  assert.deepEqual(r.plugins.gone, { a: 0 }, 'a plugin the server does not know keeps what it had');
  assert.deepEqual(r.plugins.unknown, { b: 2 });
  const bad = cleanPluginSettings({ sdlc: { strictness: 'extreme' } }, plugins, undefined);
  assert.match(bad.errors.join(), /plugins\.sdlc\.strictness: must be one of/);
});

test('aiops inventory gates: in operations projects only (a workspace inventory, or a session that used the ops tools), not in a software project', async () => {
  const dir = await tempDir();
  const opFile = path.join(dir, 'operator.yaml');
  await fs.writeFile(opFile, 'services:\n  - name: api\n    health: http://127.0.0.1:9/health\nalerts:\n  - name: ApiDown\n    expr: up{job="api"} == 0\n    service: api\n');
  const before = process.env.HARNESS_OPS_INVENTORY;
  process.env.HARNESS_OPS_INVENTORY = opFile;
  const h = await createHarness({ dataDir: await tempDir(), plugins: [pluginDir('aiops')], search: null, memory: 'off', scheduler: false, backgroundWork: false });
  try {
    const gate = (n: string) => h.registry.gates.get(n)!;
    const applies = (n: string, ws: string) => gate(n).applies!(new LocalHost(ws), new AbortController().signal);
    // A slugify repository: the operator's inventory alone does not make it an operations project.
    const slugify = await tempDir();
    await fs.writeFile(path.join(slugify, 'package.json'), '{"name":"slugify","scripts":{"test":"node --test"}}');
    assert.equal(await applies('inventory-valid', slugify), false);
    assert.equal(await applies('alerts-valid', slugify), false);
    // A workspace with its own inventory is one.
    const ops = await tempDir();
    await fs.mkdir(path.join(ops, '.harness', 'ops'), { recursive: true });
    await fs.writeFile(path.join(ops, '.harness', 'ops', 'inventory.json'), JSON.stringify({ services: [{ name: 'web', health: 'http://127.0.0.1:9/' }], alerts: [{ name: 'WebDown', probe: { type: 'http', url: 'http://127.0.0.1:9/' } }] }));
    assert.equal(await applies('inventory-valid', ops), true);
    assert.equal(await applies('alerts-valid', ops), true);
    // A session that used the ops tools in a folder makes it one (the operator's inventory is what it works on).
    const triage = await tempDir();
    const ctx = { host: new LocalHost(triage), signal: new AbortController().signal, readFiles: new Map(), todos: [], setTodos() {}, emit() {} } as unknown as ToolContext;
    await h.registry.tools.get('ops_inventory')!.run({ action: 'validate' }, ctx);
    assert.equal(await applies('inventory-valid', triage), true);
    assert.equal(await applies('alerts-valid', triage), true);
    assert.equal(await applies('inventory-valid', slugify), false, 'still not the software project');
  } finally {
    await h.close();
    if (before === undefined) delete process.env.HARNESS_OPS_INVENTORY; else process.env.HARNESS_OPS_INVENTORY = before;
  }
});
