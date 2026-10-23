import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runGates } from '../src/gates/gates.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { LocalHost, type ToolHost } from '../src/runtime/host.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir } from './helpers.ts';

// engine-godot with the real Godot (HARNESS_REAL_GODOT=1). The godot tool installs it
// itself: the official build and export templates from Godot's GitHub releases, checked
// against SHA512-SUMS.txt, into the engines folder (HARNESS_ENGINES_DIR keeps it between
// runs; without it the run's temporary harness home gets a fresh 1.3 GB download). Then
// 2D, 2.5D and 3D projects are created, checked, tested, played with inputs and frames,
// stepped, built for Windows (or Linux) and the Web, and driven through the editor bridge.
// With Blender too (and HARNESS_REAL_BLENDER=1), a Blender sprite sheet goes into the 2.5D game.

const here = path.dirname(fileURLToPath(import.meta.url));
// @ts-expect-error plain JS module
const { findBinary } = await import('../plugins/visual/lib/binaries.mjs');
// @ts-expect-error plain JS module
const { inspectGltf } = await import('../plugins/games3d/lib-gltf.mjs');
// @ts-expect-error plain JS module
const { pngStats } = await import('../plugins/games3d/lib-png.mjs');
// @ts-expect-error plain JS module
const { zipEntries } = await import('../plugins/engine-godot/lib/zip.mjs');

const skip = process.env.HARNESS_REAL_GODOT !== '1' ? 'set HARNESS_REAL_GODOT=1 to install and run Godot for real' : false;
const desktop = process.platform === 'win32' ? 'windows' : 'linux';
const ctxOf = (host: ToolHost) => ({ host, signal: new AbortController().signal, readFiles: new Map(), todos: [], setTodos() {}, emit() {} }) as unknown as ToolContext;
type Out = { content: string; is_error?: boolean; images?: { data: string }[]; details?: { data?: Record<string, unknown>; metrics?: Record<string, number>; files?: string[] } };

const root = skip ? '' : await tempDir('hw-real-godot-');
const h = skip ? null : await createHarness({ dataDir: await tempDir(), plugins: [path.join(here, '..', 'plugins')], search: null, memory: 'off' });
let godotBin = '';

async function call(t: { diagnostic(s: string): void }, input: Record<string, unknown>, ok = true): Promise<Out> {
  const t0 = Date.now();
  const r = await h!.registry.tools.get('godot')!.run(input, ctxOf(new LocalHost(root))) as Out;
  t.diagnostic(`${input.action} ${String(input.project ?? '')} ${((Date.now() - t0) / 1000).toFixed(1)}s: ${r.content.split('\n')[0].slice(0, 300)}`);
  if (ok) assert.ok(!r.is_error, r.content);
  return r;
}

test.after(async () => { await h?.close(); });

test('real Godot: the godot tool installs the official build and export templates (SHA-512 checked), and detect finds them', { skip, timeout: 3_600_000 }, async (t) => {
  delete process.env.HARNESS_GODOT;
  let r = await call(t, { action: 'install', timeoutSec: 3600 });
  assert.match(r.content, /godot install: ok - Godot 4\.\d+(\.\d+)? in .*(downloaded and verified \(SHA-512\)|nothing to download)/);
  r = await call(t, { action: 'detect' });
  const d = r.details!.data as { source: string; version: string; templates: string[]; path: string; gaps: string[] };
  assert.equal(d.source, 'harness', 'locate finds the harness-installed Godot');
  for (const k of ['windows', 'web', 'linux']) assert.ok(d.templates.includes(k), `${k} templates`);
  godotBin = d.path;

  // A fresh install of one build (no templates) into another folder: download, checksum, unpack.
  const prev = process.env.HARNESS_ENGINES_DIR;
  process.env.HARNESS_ENGINES_DIR = await tempDir();
  try {
    r = await call(t, { action: 'install', platforms: [desktop], templates: false });
    assert.match(r.content, /downloaded and verified \(SHA-512\) Godot_v[\d.]+-stable_(win64\.exe|linux\.x86_64)\.zip/);
    r = await call(t, { action: 'install', platforms: [desktop], templates: false });
    assert.match(r.content, /nothing to download; already there/);
  } finally { if (prev === undefined) delete process.env.HARNESS_ENGINES_DIR; else process.env.HARNESS_ENGINES_DIR = prev; }
});

for (const [template, moved] of [['2d', 'x'], ['2.5d', 'xz'], ['3d', 'x']] as const) {
  test(`real Godot: a ${template} project is created, checked, tested, described and played with inputs and frames`, { skip, timeout: 900_000 }, async (t) => {
    const project = `game-${template.replace('.', '')}`;
    let r = await call(t, { action: 'project.create', template, project, name: `Real ${template}` });
    assert.match(r.content, /Verified: it imports and its self-test passes/);
    r = await call(t, { action: 'check', project });
    assert.match(r.content, /imports cleanly/);
    r = await call(t, { action: 'test', project, selftest: true });
    const m = r.details!.metrics!;
    assert.equal(m.failed, 0, r.content);
    assert.ok(m.passed >= 4, r.content);
    r = await call(t, { action: 'describe', project });
    assert.ok((r.details!.data as { nodes: number }).nodes > 5);
    const right = template === '2.5d' ? 'move_up' : 'move_right';
    r = await call(t, { action: 'play', project, seconds: 3, every: 60, inputs: [{ t: 0.5, action: right, hold: 1 }] });
    const pm = r.details!.metrics!;
    assert.equal(pm.frames, 180);
    assert.ok(pm.fps > 5, `fps ${pm.fps}`);
    assert.equal(pm.errors, 0);
    assert.equal(pm.captures, 3, r.content);
    assert.equal(r.images?.length, 3);
    const shot = pngStats(Buffer.from(r.images![0]!.data, 'base64'));
    assert.equal(shot.blank, false, 'a real frame');
    const data = r.details!.data as { captures: { state: { game: { player: number[] } } }[] };
    const start = data.captures[0]!.state.game.player;
    const end = data.captures.at(-1)!.state.game.player;
    assert.notDeepEqual(start, end, `the player moved (${moved}): ${start} -> ${end}`);
    t.diagnostic(`play metrics: ${JSON.stringify(pm)}`);
    const [gp, gs] = await runGates(h!.registry, new LocalHost(root), ['godot-project', 'godot-selftest'], new AbortController().signal);
    assert.equal(gp!.pass, true, gp!.details ?? '');
    assert.equal(gs!.pass, true, gs!.details ?? '');
  });
}

test('real Godot: step mode advances the 2D game a step at a time and sends frames and state back', { skip, timeout: 300_000 }, async (t) => {
  let r = await call(t, { action: 'step.start', project: 'game-2d', size: [640, 360] });
  const session = (r.details!.data as { session: string }).session;
  const x0 = ((r.details!.data as { state: { game: { player: number[] } } }).state.game.player)[0]!;
  assert.equal(r.images?.length, 1);
  r = await call(t, { action: 'step', session, inputs: [{ action: 'move_right' }], frames: 30 });
  const x1 = ((r.details!.data as { state: { game: { player: number[] } } }).state.game.player)[0]!;
  assert.ok(x1 > x0 + 30, `${x0} -> ${x1}`);
  assert.equal(r.images?.length, 1);
  r = await call(t, { action: 'step', session, inputs: [{ action: 'move_right', up: true }], frames: 10 });
  const x2 = ((r.details!.data as { state: { game: { player: number[] } } }).state.game.player)[0]!;
  r = await call(t, { action: 'step', session, frames: 10 });
  const x3 = ((r.details!.data as { state: { game: { player: number[] } } }).state.game.player)[0]!;
  assert.equal(x3, x2, 'released: the player stops');
  t.diagnostic(`x: ${x0} -> ${x1} -> ${x2} -> ${x3}`);
  r = await call(t, { action: 'step.stop', session });
});

test('real Godot: the 2D game builds for the desktop and the Web, the build runs its self-test, packages, and passes the godot-export gate', { skip, timeout: 900_000 }, async (t) => {
  let r = await call(t, { action: 'build', project: 'game-2d', platform: desktop });
  const exe = desktop === 'windows' ? 'build/windows/game.exe' : 'build/linux/game.x86_64';
  assert.ok(r.details!.files!.includes(exe), r.content);
  const run = await new LocalHost(root).exec(`'./${exe}' --headless --fixed-fps 60 --quit-after 600 -- --selftest`, { timeoutMs: 120_000 });
  assert.match(run.stdout + run.stderr, /SELFTEST PASS/, 'the exported game passes its own self-test (sprite sheets and all)');
  r = await call(t, { action: 'build', project: 'game-2d', platform: 'web' });
  const web = await fs.readdir(path.join(root, 'build', 'web'));
  for (const f of ['index.html', 'index.js', 'index.wasm', 'index.pck']) assert.ok(web.includes(f), `${f} in ${web.join(', ')}`);
  r = await call(t, { action: 'package', project: 'game-2d', platform: 'web', name: 'real-2d' });
  const names = (await zipEntries(path.join(root, 'build', 'real-2d-web.zip'))).map((e: { name: string }) => e.name);
  assert.ok(names.includes('index.wasm') && names.includes('index.html'), names.join(', '));
  const studio = JSON.parse(await fs.readFile(path.join(root, '.studio', 'project.json'), 'utf8'));
  assert.ok(studio.builds.length >= 3);
  const [g] = await runGates(h!.registry, new LocalHost(root), ['godot-export'], new AbortController().signal);
  assert.equal(g!.pass, true, g!.details ?? '');
  t.diagnostic(g!.summary);
});

test('real Godot: the 3D level exports as glTF and renders frames', { skip, timeout: 300_000 }, async (t) => {
  let r = await call(t, { action: 'asset.export', project: 'game-3d', output: 'exports/level.glb' });
  const g = await inspectGltf(path.join(root, 'exports', 'level.glb'));
  assert.ok(g.meshes >= 4, `${g.meshes} meshes`);
  r = await call(t, { action: 'render', project: 'game-3d', frames: 20, out: 'renders/level' });
  assert.equal((await fs.readdir(path.join(root, 'renders', 'level'))).filter((f) => f.endsWith('.png')).length, 20);
  r = await call(t, { action: 'capture', project: 'game-3d', frames: 30, out: 'shots/3d.png' });
  assert.equal(pngStats(await fs.readFile(path.join(root, 'shots', '3d.png'))).blank, false);
});

test('real Godot: the editor bridge in a headless editor: status, tree, add_node, set, GDScript, remove', { skip, timeout: 300_000 }, async (t) => {
  let r = await call(t, { action: 'bridge.install', project: 'game-2d' });
  const ed = spawn(godotBin, ['--headless', '--editor', '--path', 'game-2d', 'res://scenes/main.tscn'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  ed.stdout.on('data', (d) => { log += d; });
  ed.stderr.on('data', (d) => { log += d; });
  try {
    const t0 = Date.now();
    for (let i = 0; i < 240 && !(await fs.stat(path.join(root, 'game-2d', '.godot', 'harness_bridge.json')).catch(() => null)); i++) await new Promise((res) => setTimeout(res, 500));
    t.diagnostic(`editor bridge up in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    for (let i = 0; i < 20; i++) {
      r = await call(t, { action: 'bridge.status', project: 'game-2d' });
      if ((r.details!.data as { connected: boolean }).connected) break;
      await new Promise((res) => setTimeout(res, 500));
    }
    assert.match(r.content, /connected to Godot 4\.\d+.*: project "Real 2d", scene res:\/\/scenes\/main\.tscn/, log);
    r = await call(t, { action: 'describe', project: 'game-2d', live: true });
    assert.equal((r.details!.data as { tree: { name: string } }).tree.name, 'Main');
    r = await call(t, { action: 'bridge.call', project: 'game-2d', command: 'add_node', params: { parent: '.', type: 'Marker2D', name: 'Spawn', props: { position: 'Vector2(64, 32)' } } });
    r = await call(t, { action: 'bridge.call', project: 'game-2d', command: 'set', params: { path: 'Spawn', props: { rotation_degrees: 90 } } });
    r = await call(t, { action: 'script', project: 'game-2d', live: true, code: 'var s = root.get_node("Spawn")\nreturn [s.position, s.rotation_degrees]' });
    assert.match(r.content, /returned \[Vector2\(64, 32\), 90\.0\]/);
    r = await call(t, { action: 'bridge.call', project: 'game-2d', command: 'remove', params: { path: 'Spawn' } });
    r = await call(t, { action: 'capture', project: 'game-2d', live: true }, false);
    assert.match(r.content, /a headless editor draws nothing/);
  } finally { ed.kill(); }
});

const blender = findBinary('blender') as string | null;
test('real Godot and Blender: a Blender sprite sheet of a model becomes the 2.5D game\'s animated billboard', { skip: skip || (process.env.HARNESS_REAL_BLENDER !== '1' || !blender ? 'needs HARNESS_REAL_BLENDER=1 and Blender too' : false), timeout: 600_000 }, async (t) => {
  const b = h!.registry.tools.get('blender')!;
  await fs.mkdir(path.join(root, 'tools'), { recursive: true });
  await fs.writeFile(path.join(root, 'tools', 'pillar.py'), `import bpy, os, math\nbpy.ops.wm.read_factory_settings(use_empty=True)\nbpy.ops.mesh.primitive_cylinder_add(radius=0.3, depth=1.2, location=(0, 0, 0.6))\nbpy.ops.mesh.primitive_cube_add(size=0.2, location=(0, -0.35, 1.0))\nc = bpy.context.active_object\nc.keyframe_insert('location', frame=1)\nc.location.z = 0.4\nc.keyframe_insert('location', frame=12)\nos.makedirs('art', exist_ok=True)\nbpy.ops.wm.save_as_mainfile(filepath=os.path.abspath('art/pillar.blend'))\n`);
  let r = await b.run({ script: 'tools/pillar.py' }, ctxOf(new LocalHost(root))) as Out;
  assert.ok(!r.is_error, r.content);
  r = await b.run({ action: 'sprites', file: 'art/pillar.blend', id: 'pillar', directions: 4, frames: 3, cell: 48 }, ctxOf(new LocalHost(root))) as Out;
  assert.ok(!r.is_error, r.content);
  t.diagnostic(r.content.split('\n')[0]!);
  r = await call(t, { action: 'asset.import', project: 'game-25d', asset: 'pillar' });
  r = await call(t, { action: 'script', project: 'game-25d', code: 'var f = load("res://harness/sprite_sheet.gd").load_frames("res://assets/pillar")\nprint("ANIMS ", ",".join(f.get_animation_names()))\nprint("FRAMES ", f.get_frame_count("walk_e"))' });
  assert.match(r.content, /ANIMS walk_s,walk_w,walk_n,walk_e|ANIMS (walk_[swne],?){4}/);
  assert.match(r.content, /FRAMES 3/);
});
