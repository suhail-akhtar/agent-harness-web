import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runGates } from '../src/gates/gates.ts';
import type { WorkflowDef } from '../src/graph/types.ts';
import { validateWorkflow } from '../src/graph/validate.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { LocalHost } from '../src/runtime/host.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { FakeProvider, fakeGodot, glbBytes, tempDir, testPicture } from './helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
// @ts-expect-error plain JS module
const { inspectGltf } = await import('../plugins/games3d/lib-gltf.mjs');
const { chromiumPath } = await import('../plugins/visual/lib/browser.mjs');
const hasChromium = await import('playwright-core').then(() => true, () => false) && !!chromiumPath();

/** Writes the minimal GLB from the helpers (one triangle mesh placed twice). */
const glb = (file: string) => fs.writeFile(file, glbBytes());

test('glTF inspection: transforms (rotation included) set the size; shared meshes count per instance', async () => {
  const dir = await tempDir();
  await glb(path.join(dir, 'm.glb'));
  const g = await inspectGltf(path.join(dir, 'm.glb'));
  assert.equal(g.meshes, 1);
  assert.equal(g.triangles, 2, 'one mesh placed twice');
  // Node 1 spans x 0..2, y 0..1; node 2 is rotated 90 degrees: x -1..0, y 0..2, at z 5.
  assert.deepEqual(g.size, [3, 2, 5]);
  await fs.writeFile(path.join(dir, 'bad.glb'), 'not a model');
  await assert.rejects(inspectGltf(path.join(dir, 'bad.glb')), /bad magic/);
});

test('gltf-valid fails on a broken model and passes on a good one', async () => {
  const h = await createHarness({ dataDir: await tempDir(), plugins: [path.join(here, '..', 'plugins')] });
  const root = await tempDir();
  const host = new LocalHost(root);
  await glb(path.join(root, 'good.glb'));
  let [g] = await runGates(h.registry, host, ['gltf-valid'], new AbortController().signal);
  assert.equal(g!.pass, true, g!.details ?? '');
  await fs.writeFile(path.join(root, 'broken.glb'), Buffer.alloc(40));
  [g] = await runGates(h.registry, host, ['gltf-valid'], new AbortController().signal);
  assert.equal(g!.pass, false);
  assert.match(g!.details ?? '', /broken\.glb: not a GLB file/);
  await h.close();
});

// ---------- workflows: the Blender and Godot branches ----------

const workflow = async (name: string) => JSON.parse(await fs.readFile(path.join(here, '..', 'plugins', 'games3d', 'workflows', `${name}.json`), 'utf8')) as WorkflowDef;
const trail = (run: { history: { node: string; outcome?: string; status: string }[] }) => run.history.map((x) => `${x.node}:${x.outcome ?? x.status}`);
/** A bash command that writes these bytes to a file (binary content: the write tool takes text). */
const writeBytes = (file: string, data: Buffer) => `mkdir -p "$(dirname ${file})" && printf '%s' '${data.toString('base64')}' | base64 -d > ${file}`;

test('model-3d and build-game: valid graphs with an engine choice, the browser path staying the default', async () => {
  const h = await createHarness({ dataDir: await tempDir(), plugins: ['games3d', 'engine-blender', 'engine-godot'].map((p) => path.join(here, '..', 'plugins', p)), search: null, memory: 'off' });
  try {
    for (const [name, def, other, branch] of [['model-3d', 'three', 'blender', 'build-blender'], ['build-game', 'browser', 'godot', 'build-godot']] as const) {
      const w = await workflow(name);
      assert.deepEqual(validateWorkflow(w), [], name);
      assert.ok(h.registry.workflows.has(name), `${name} loads`);
      assert.equal(w.inputs!.engine!.default, def);
      const engine = w.nodes.engine as { type: string; value: string; next: { on: Record<string, string>; default: string } };
      assert.equal(engine.type, 'branch');
      assert.equal(engine.value, '{{input.engine}}');
      assert.deepEqual(engine.next, { on: { [other]: branch }, default: 'build' }, 'anything but the other engine builds as before');
      // Both ways into the build (approval off, or approved) go through the engine choice.
      assert.equal((w.nodes['approval-mode'] as { next: { on: Record<string, string> } }).next.on.auto, 'engine');
    }
    const g = await workflow('build-game');
    assert.deepEqual((g.nodes['gates-godot'] as { gates: string[] }).gates, ['godot-project', 'godot-selftest']);
    const m = await workflow('model-3d');
    assert.deepEqual((m.nodes['checks-blender'] as { gates: string[] }).gates, ['gltf-valid', 'model-preview', 'blender-file']);
    assert.deepEqual((m.nodes.checks as { gates: string[] }).gates, ['web-console', 'gltf-valid'], 'the Three.js path is unchanged');
  } finally { await h.close(); }
});

test('model-3d with engine=blender: build in Blender, the preview gate sends it back once, art review, delivery', async () => {
  const ws = await tempDir();
  const h = await createHarness({ dataDir: await tempDir(), plugins: ['games3d', 'engine-blender', 'engine-godot'].map((p) => path.join(here, '..', 'plugins', p)), search: null, memory: 'off' });
  const fake = new FakeProvider([
    { calls: [{ name: 'write', input: { path: 'docs/model-plan.md', content: '# Crate\n1 x 1 x 1 m\n' } }] },
    { text: 'planned' },
    // The build exports the model but forgets the preview renders.
    { calls: [{ name: 'bash', input: { command: writeBytes('model.glb', glbBytes()) } }] },
    { text: 'built model.glb' },
    { calls: [{ name: 'bash', input: { command: writeBytes('previews/front.png', testPicture()) } }] },
    { text: 'rendered the previews' },
    { text: 'The crate reads well from the front.\nAPPROVE' },
    { calls: [{ name: 'write', input: { path: 'docs/delivery.md', content: 'A crate.\n' } }] },
    { text: 'delivered' },
  ]);
  h.registry.setProviderInstance('deepseek', fake);
  try {
    const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws } });
    const done = new Promise<void>((r) => s.subscribe(0, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
    await s.startWorkflow('model-3d', { subject: 'a wooden crate', engine: 'blender' });
    await done;
    const [run] = await s.listRuns();
    assert.deepEqual(trail(run!), [
      'plan:done', 'approval-mode:auto', 'engine:blender', 'build-blender:done', 'checks-blender:fail', 'fix-blender:done', 'checks-blender:pass', 'review-blender:APPROVE', 'deliver-blender:done', 'done:done',
    ]);
    assert.equal(run!.status, 'succeeded');
    assert.ok(fake.snapshots.some((x) => x.includes('Engine: blender')), 'the plan knows the engine');
    assert.ok(fake.snapshots.some((x) => x.includes('tools/model.py builds it') && x.includes('previews/front.png')), 'the build is briefed for Blender');
    const fix = fake.snapshots.find((x) => x.includes('The checks failed. Fix the Blender script'))!;
    assert.match(fix, /model-preview: no preview renders in previews\//, 'the fix step is told what failed');
    assert.match(run!.history.filter((x) => x.node === 'checks-blender').at(-1)!.summary!, /PASS gltf-valid: 1 valid model\(s\)\nPASS model-preview: 1 preview\(s\) of 1 model\(s\)/);
  } finally { await h.close(); }
});

test('build-game with engine=godot: a Godot project, the self-test gate sends it back once, playtest, README', async () => {
  const godot = await fakeGodot();
  process.env.HARNESS_GODOT = godot.bin;
  const ws = await tempDir();
  const h = await createHarness({ dataDir: await tempDir(), plugins: ['games3d', 'engine-blender', 'engine-godot'].map((p) => path.join(here, '..', 'plugins', p)), search: null, memory: 'off' });
  const project = 'config_version=5\n\n[application]\n\nconfig/name="Dodge"\nrun/main_scene="res://main.tscn"\n';
  const scene = '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://main.gd" id="1"]\n\n[node name="Main" type="Node2D"]\nscript = ExtResource("1")\n';
  const script = (body: string) => `extends Node2D\n\nvar selftest := "--selftest" in OS.get_cmdline_user_args()\n\nfunc _physics_process(_delta: float) -> void:\n${body}\n`;
  const fake = new FakeProvider([
    { calls: [{ name: 'write', input: { path: 'docs/game-design.md', content: '# Dodge\n## Self-test\n- holding right moves the player\n' } }] },
    { text: 'designed' },
    { calls: [
      { name: 'write', input: { path: 'game/project.godot', content: project } },
      { name: 'write', input: { path: 'game/main.tscn', content: scene } },
      { name: 'write', input: { path: 'game/main.gd', content: script('\tpass  # FAKE_FAIL: the player never moves') } },
    ] },
    { text: 'built the project' },
    { calls: [{ name: 'read', input: { path: 'game/main.gd' } }] },
    { calls: [{ name: 'write', input: { path: 'game/main.gd', content: script('\tif selftest:\n\t\tprint("SELFTEST PASS")') } }] },
    { text: 'fixed the movement' },
    { text: 'The self-test passes and the screenshots look right.\nAPPROVE' },
    { calls: [{ name: 'write', input: { path: 'README.md', content: '# Dodge\n' } }] },
    { text: 'wrote the README' },
  ]);
  h.registry.setProviderInstance('deepseek', fake);
  try {
    const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws } });
    const done = new Promise<void>((r) => s.subscribe(0, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
    await s.startWorkflow('build-game', { idea: 'dodge the falling rocks', engine: 'godot', approval: 'auto' });
    await done;
    const [run] = await s.listRuns();
    assert.deepEqual(trail(run!), [
      'design:done', 'approval-mode:auto', 'engine:godot', 'build-godot:done', 'gates-godot:fail', 'fix-godot:done', 'gates-godot:pass', 'playtest-godot:APPROVE', 'docs-godot:done', 'done:done',
    ]);
    assert.equal(run!.status, 'succeeded');
    const fix = fake.snapshots.find((x) => x.includes('The checks failed. Fix the game (change a self-test check'))!;
    assert.match(fix, /godot-selftest: 1 of 1 Godot self-test\(s\) failed/);
    assert.match(fix, /ERROR: selftest: the player did not move/);
    assert.match(run!.history.filter((x) => x.node === 'gates-godot').at(-1)!.summary!, /PASS godot-project: 1 Godot project\(s\) import, load and run cleanly: game\nPASS godot-selftest: 1 Godot self-test\(s\) passed: game/);
    // The gates ran Godot on the project: the self-test with its argument.
    assert.ok((await godot.calls()).some((c) => /--path game --fixed-fps 60 --quit-after 600 -- --selftest$/.test(c)));
  } finally {
    delete process.env.HARNESS_GODOT;
    await h.close();
  }
});

test('a model built in the browser is exported to .glb with browser save, inside the workspace only', { skip: !hasChromium && 'no Chromium' }, async () => {
  const h = await createHarness({ dataDir: await tempDir(), plugins: [path.join(here, '..', 'plugins')] });
  const root = await tempDir();
  const ctx = { host: new LocalHost(root), signal: new AbortController().signal, readFiles: new Map(), todos: [], setTodos() {}, emit() {} } as unknown as ToolContext;
  const tool = (n: string) => h.registry.tools.get(n)!;
  await tool('add_library').run({ name: 'three' }, ctx);
  await fs.writeFile(path.join(root, 'index.html'), `<script type="importmap">{"imports":{"three":"./vendor/three/build/three.module.js","three/addons/":"./vendor/three/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
const box = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 0.5), new THREE.MeshStandardMaterial({ name: 'Paint' }));
box.position.y = 1;
const g = new THREE.Group(); g.add(box);
window.exportGLB = () => new GLTFExporter().parseAsync(g, { binary: true });
</script>`);
  const r = await tool('browser').run({ screenshot: false, save: { path: 'out/box.glb', js: 'window.exportGLB()' } }, ctx);
  assert.match(r.content, /Saved out\/box\.glb: \d+ bytes/);
  const info = await tool('model_info').run({ path: 'out/box.glb' }, ctx);
  assert.match(info.content, /1 mesh\(es\), 12 triangles, 1 material\(s\), about 1 x 2 x 0\.5 m/);
  const outside = await tool('browser').run({ screenshot: false, save: { path: '../escape.glb', js: '"x"' } }, ctx).catch((e: Error) => ({ content: e.message }));
  assert.match(outside.content, /outside the workspace/);
  await h.close();
});
