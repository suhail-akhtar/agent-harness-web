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

// engine-blender with the real Blender on this machine (HARNESS_REAL_BLENDER=1; skipped
// when Blender is not installed): a procedural model to .glb, describe, import and export,
// a capture, look-dev renders and a turntable, an 8-direction sprite sheet, the blender-file
// gate, and the bridge add-on's server run in background mode.

const here = path.dirname(fileURLToPath(import.meta.url));
// @ts-expect-error plain JS module
const { findBinary } = await import('../plugins/visual/lib/binaries.mjs');
// @ts-expect-error plain JS module
const { inspectGltf } = await import('../plugins/games3d/lib-gltf.mjs');
// @ts-expect-error plain JS module
const { pixels, pngStats } = await import('../plugins/games3d/lib-png.mjs');
// @ts-expect-error plain JS module
const EB = await import('../plugins/engine-blender/index.mjs');

const bin = findBinary('blender') as string | null;
const skip = process.env.HARNESS_REAL_BLENDER !== '1' ? 'set HARNESS_REAL_BLENDER=1 to run Blender for real' : !bin ? 'no Blender on this machine' : false;
const ctxOf = (host: ToolHost) => ({ host, signal: new AbortController().signal, readFiles: new Map(), todos: [], setTodos() {}, emit() {} }) as unknown as ToolContext;
type Out = { content: string; is_error?: boolean; images?: { data: string }[]; details?: { data?: Record<string, unknown>; metrics?: Record<string, number> } };

// A small robot: a body, a head, a nose on its front (-Y) and two legs that swing over frames 1-24.
const ROBOT = `import bpy, math, os, sys
argv = sys.argv[sys.argv.index('--') + 1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
def mat(n, c):
    m = bpy.data.materials.new(n); m.use_nodes = True
    m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (*c, 1); return m
bpy.ops.mesh.primitive_cube_add(size=0.6, location=(0, 0, 0.7)); b = bpy.context.active_object; b.name = 'Body'; b.data.materials.append(mat('Red', (0.8, 0.2, 0.15)))
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.22, location=(0, 0, 1.25)); h = bpy.context.active_object; h.name = 'Head'; h.data.materials.append(mat('Skin', (0.9, 0.75, 0.6)))
bpy.ops.mesh.primitive_cube_add(size=0.1, location=(0, -0.22, 1.28)); n = bpy.context.active_object; n.name = 'Nose'; n.data.materials.append(mat('Dark', (0.1, 0.1, 0.1)))
for s in (-1, 1):
    bpy.ops.mesh.primitive_cylinder_add(radius=0.08, depth=0.4, location=(s * 0.15, 0, 0.2)); l = bpy.context.active_object; l.name = 'Leg'; l.data.materials.append(mat('Blue', (0.15, 0.3, 0.8)))
    l.keyframe_insert('rotation_euler', frame=1); l.rotation_euler.x = math.radians(25 * s); l.keyframe_insert('rotation_euler', frame=12); l.rotation_euler.x = math.radians(-25 * s); l.keyframe_insert('rotation_euler', frame=24)
bpy.context.scene.frame_start, bpy.context.scene.frame_end = 1, 24
for p in argv:
    os.makedirs(os.path.dirname(os.path.abspath(p)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=os.path.abspath(argv[0]), export_format='GLB', export_yup=True)
bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(argv[1]))
print('MADE', argv)
`;

async function harness() {
  return createHarness({ dataDir: await tempDir(), plugins: [path.join(here, '..', 'plugins')], search: null, memory: 'off' });
}

test('real Blender: a procedural model to .glb, described, imported and exported, captured, rendered with presets and a turntable, and turned into an 8-direction sprite sheet', { skip, timeout: 900_000 }, async (t) => {
  const h = await harness();
  const root = await tempDir();
  const host = new LocalHost(root);
  const blender = async (input: Record<string, unknown>) => {
    const t0 = Date.now();
    const r = await h.registry.tools.get('blender')!.run(input, ctxOf(host)) as Out;
    t.diagnostic(`${input.action ?? 'script'} ${((Date.now() - t0) / 1000).toFixed(1)}s: ${r.content.split('\n')[0]}`);
    assert.ok(!r.is_error, r.content);
    return r;
  };
  try {
    let r = await blender({ action: 'detect' });
    assert.match(r.content, /blender detect: ok - Blender \d+\.\d+/);
    await fs.mkdir(path.join(root, 'tools'));
    await fs.writeFile(path.join(root, 'tools', 'robot.py'), ROBOT);
    r = await blender({ script: 'tools/robot.py', args: ['out/robot.glb', 'art/robot.blend'] });
    assert.match(r.content, /blender exited 0/);
    const g = await inspectGltf(path.join(root, 'out', 'robot.glb'));
    assert.equal(g.meshes, 5);
    assert.ok(g.triangles > 1000, `${g.triangles} triangles`);
    assert.ok(Math.abs(g.size[1] - 1.47) < 0.02, `1.47 m tall in glTF (Y up): ${g.size}`);

    r = await blender({ action: 'describe', file: 'art/robot.blend' });
    const d = r.details!.data as { count: number; triangles: number; frames: number[]; actions: string[]; bounds: { size: number[] } };
    assert.equal(d.count, 5);
    assert.deepEqual(d.frames, [1, 24]);
    assert.equal(d.actions.length, 2, 'the two legs are animated');
    assert.ok(Math.abs(d.bounds.size[2]! - 1.47) < 0.01, String(d.bounds.size));

    r = await blender({ action: 'asset.import', files: ['out/robot.glb'], normalise: true, height: 2, output: 'art/robot-2m.blend', exports: ['out/robot-unreal.fbx'], target: 'unreal' });
    const s = (r.details!.data as { scene: { bounds: { min: number[]; size: number[] } } }).scene;
    assert.ok(Math.abs(s.bounds.size[2]! - 2) < 0.01, `normalised to 2 m: ${s.bounds.size}`);
    assert.ok(Math.abs(s.bounds.min[2]!) < 0.001, 'standing on the floor');
    assert.ok((await fs.stat(path.join(root, 'out', 'robot-unreal.fbx'))).size > 1000);
    r = await blender({ action: 'asset.export', file: 'art/robot.blend', output: 'out/robot-godot.glb', target: 'godot' });
    assert.equal((await inspectGltf(path.join(root, 'out', 'robot-godot.glb'))).meshes, 5);

    r = await blender({ action: 'capture', file: 'art/robot.blend', view: 'front', out: 'previews/front.png' });
    const front = pngStats(await fs.readFile(path.join(root, 'previews', 'front.png')));
    assert.deepEqual([front.width, front.height, front.blank], [640, 480, false]);
    for (const [preset, engine] of [['studio', 'cycles'], ['outdoor', 'eevee'], ['night', 'workbench']] as const) {
      r = await blender({ action: 'render', file: 'art/robot.blend', preset, engine, samples: 16, size: [480, 360], out: `previews/${preset}.png` });
      const p = pngStats(await fs.readFile(path.join(root, 'previews', `${preset}.png`)));
      assert.deepEqual([p.width, p.height, p.blank], [480, 360, false], `${preset} ${engine}`);
    }
    r = await blender({ action: 'render', file: 'art/robot.blend', preset: 'studio', engine: 'eevee', size: [320, 240], turntable: 8, out: 'renders/turntable' });
    assert.equal((await fs.readdir(path.join(root, 'renders', 'turntable'))).filter((f) => f.endsWith('.png')).length, 8);
    t.diagnostic(`turntable: ${r.details!.metrics!.secondsPerFrame}s per frame`);
    const first = await fs.readFile(path.join(root, 'renders', 'turntable', 'turntable_0001.png'));
    const fifth = await fs.readFile(path.join(root, 'renders', 'turntable', 'turntable_0005.png'));
    assert.ok(!first.equals(fifth), 'the camera moved around the model');

    r = await blender({ action: 'sprites', file: 'art/robot.blend', id: 'robot', name: 'Robot', directions: 8, frames: 4, cell: 64 });
    const sheet = await fs.readFile(path.join(root, '.studio', 'assets', 'robot', 'robot.png'));
    const st = pngStats(sheet);
    assert.deepEqual([st.width, st.height, st.blank], [256, 512, false]);
    const px = pixels(sheet);
    assert.equal(px.data[3], 0, 'the background is transparent');
    // Some pixel in the first cell is the model (opaque).
    let opaque = 0;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (px.data[y * px.stride + x * 4 + 3] > 200) opaque++;
    assert.ok(opaque > 200, `${opaque} opaque pixels in the first cell`);
    const asset = JSON.parse(await fs.readFile(path.join(root, '.studio', 'assets', 'robot', 'asset.json'), 'utf8'));
    assert.deepEqual([asset.kind, asset.meta.frames, asset.meta.columns, asset.meta.rows], ['spritesheet', 32, 4, 8]);
    assert.deepEqual(Object.keys(asset.meta.animations), ['walk_s', 'walk_sw', 'walk_w', 'walk_nw', 'walk_n', 'walk_ne', 'walk_e', 'walk_se']);
    t.diagnostic(`sprites: ${r.content.split('\n')[0]}`);

    const [gate] = await runGates(h.registry, host, ['blender-file'], new AbortController().signal);
    assert.equal(gate!.pass, true, gate!.details ?? '');
    assert.match(gate!.summary, /2 \.blend file\(s\) open/);
  } finally { await h.close(); }
});

test('real Blender: the bridge add-on\'s server in background mode answers the tool (scene, operator, Python, capture, save, quit)', { skip, timeout: 300_000 }, async (t) => {
  const prev = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = await tempDir();
  const h = await harness();
  const root = await tempDir();
  const host = new LocalHost(root);
  const blender = (input: Record<string, unknown>) => h.registry.tools.get('blender')!.run(input, ctxOf(host)) as Promise<Out>;
  const addons = await tempDir();
  await EB.installAddon(addons);
  const proc = spawn(bin!, ['-b', '--factory-startup', '--python-expr', `import sys; sys.path.insert(0, r'${addons}'); import harness_bridge; harness_bridge.serve_forever()`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const exited = new Promise<number | null>((r) => proc.on('exit', (code) => r(code)));
  try {
    const t0 = Date.now();
    for (let i = 0; i < 120 && !(await fs.stat(EB.bridgeInfoFile()).catch(() => null)); i++) await new Promise((r) => setTimeout(r, 250));
    t.diagnostic(`bridge up in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    let r = await blender({ action: 'bridge.status' });
    assert.match(r.content, /connected to Blender \d+\.\d+.* on 127\.0\.0\.1:476\d\d: an unsaved file, scene Scene, 3 object\(s\) \(background\)/);
    r = await blender({ action: 'bridge.call', command: 'operator', params: { op: 'mesh.primitive_monkey_add', kwargs: { location: [0, 0, 1] } } });
    assert.ok(!r.is_error, r.content);
    r = await blender({ code: 'result = sorted(o.name for o in bpy.context.scene.objects)\nprint("objects", len(result))', live: true });
    assert.match(r.content, /result \["Camera","Cube","Light","Suzanne"\]/);
    assert.match(r.content, /objects 4/);
    r = await blender({ action: 'describe', live: true });
    assert.equal((r.details!.data as { count: number }).count, 4);
    r = await blender({ action: 'capture', live: true, out: 'previews/live.png' });
    assert.match(r.content, /scene \(a quick render\) saved to previews\/live\.png/);
    assert.equal(pngStats(await fs.readFile(path.join(root, 'previews', 'live.png'))).blank, false);
    r = await blender({ action: 'bridge.call', command: 'save', params: { path: path.join(root, 'live.blend') } });
    await fs.access(path.join(root, 'live.blend'));
    r = await blender({ action: 'bridge.call', command: 'exec', params: { code: 'raise ValueError("boom")' } });
    assert.equal(r.is_error, true);
    assert.match(r.content, /Blender refused exec: ValueError: boom/);
    r = await blender({ action: 'bridge.call', command: 'quit' });
    assert.equal(await exited, 0, log);
    r = await blender({ action: 'bridge.status' });
    assert.match(r.content, /no Blender with the Harness Bridge is running/, 'the connection file is removed on quit');
  } finally {
    if (proc.exitCode === null) proc.kill();
    if (prev === undefined) delete process.env.HARNESS_HOME; else process.env.HARNESS_HOME = prev;
    await h.close();
  }
});
