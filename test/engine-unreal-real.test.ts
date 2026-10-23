import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LocalHost } from '../src/runtime/host.ts';
import { glbBytes } from './helpers.ts';

// The real Unreal Engine, end to end, behind HARNESS_REAL_UNREAL=1 (skipped when Unreal is not
// installed): a TP_ThirdPersonBP project in a folder of its own, a coin level built with editor
// Python (10 coin Blueprints that score and destroy themselves, an exit that ends the game, a
// HUD score), a Blender glb imported and placed, captures looked at, Automation tests, a Win64
// package, the packaged game played with inputs, the AI player's driver, the live bridge, a
// Movie Render Queue turntable and the gates. Times and sizes are printed and written to
// <dir>/unreal-real-results.json. HARNESS_UNREAL_TEST_DIR picks where the project goes (default
// the OS temp folder); the folder is removed at the end (HARNESS_UNREAL_KEEP=1 keeps it).

const here = path.dirname(fileURLToPath(import.meta.url));
// @ts-expect-error plain JS module
const plugin = (await import('../plugins/engine-unreal/index.mjs')).default;
// @ts-expect-error plain JS module
const { engine } = await import('../plugins/engine-unreal/lib/context.mjs');
// @ts-expect-error plain JS module
const { createDriver } = await import('../plugins/engine-unreal/driver.mjs');
// @ts-expect-error plain JS module
const { pngStats } = await import('../plugins/games3d/lib-png.mjs');
// @ts-expect-error plain JS module
const { findBinary } = await import('../plugins/visual/lib/binaries.mjs');

const wanted = process.env.HARNESS_REAL_UNREAL === '1';
const eng = wanted ? await engine() : null;
const skip = !wanted ? 'set HARNESS_REAL_UNREAL=1 to run against the real Unreal Engine' : !eng ? 'Unreal Engine is not installed' : false;

type Out = { content: string; is_error?: boolean; images?: { data: string }[] };

/** Removes a folder this test made, refusing when anything inside is a link or junction. */
async function safeRemove(dir: string): Promise<string> {
  async function links(d: string): Promise<string | null> {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const st = await fs.lstat(p);
      if (st.isSymbolicLink()) return p;
      if (st.isDirectory()) { const l = await links(p); if (l) return l; }
    }
    return null;
  }
  const l = await links(dir);
  if (l) return `kept ${dir}: it holds a link (${l})`;
  await fs.rm(dir, { recursive: true, force: true });
  return `removed ${dir}`;
}

async function size(dir: string): Promise<number> {
  let n = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += await size(p); else n += (await fs.stat(p)).size;
  }
  return n;
}

const LEVEL = `import harness_ue as h
kit = h.coin_game_kit()
floor = h.color_material("/Game/CoinKit/M_Floor", (0.18, 0.2, 0.24), roughness=0.8)
plat = h.color_material("/Game/CoinKit/M_Platform", (0.85, 0.35, 0.15))
made = h.build_level({
    "map": "/Game/Levels/Lvl_Coins",
    "floor": {"size": [4400, 2400], "material": floor.get_path_name()},
    "walls": {"height": 300},
    "platforms": [{"at": [-200, 700, 100], "size": [400, 400, 200], "material": plat.get_path_name()}, {"at": [700, -700, 150], "size": [300, 300, 300], "material": plat.get_path_name()}],
    "pickups": {"class": kit["BP_Coin"], "label": "Coin", "at": [[300 * i - 1200, 0, 100] for i in range(10)]},
    "lights": {"sun": True, "sky": True, "fog": True},
    "player_start": {"at": [-1800, 0, 120], "yaw": 0},
    "exit": {"class": kit["BP_Exit"], "at": [1900, 0, 150]},
    "camera": {"at": [-2600, -1700, 1300], "rotation": [-32, 32, 0], "label": "ShotCam"},
    "game_mode": kit["BP_CoinGameMode"],
})
h.set_default_maps(game_map="/Game/Levels/Lvl_Coins", editor_map="/Game/Levels/Lvl_Coins")
h.functional_test_count("/Game/Tests/FT_CoinCount", kit["BP_Coin"], 10, label="FT_CoinCount")
h.save()
h.result("made", made)
h.result("blueprints", [h.describe_blueprint(h.load(kit[k])) for k in ("BP_Coin", "BP_Exit", "BP_CoinGameMode")])
`;

test('real Unreal: project, level, Blueprints, import, captures, tests, package, packaged play, AI driver, bridge, render, gates', { skip, timeout: 3 * 3600_000 }, async () => {
  const base = process.env.HARNESS_UNREAL_TEST_DIR || os.tmpdir();
  await fs.mkdir(base, { recursive: true });
  const ws = await fs.mkdtemp(path.join(base, 'unreal-real-'));
  const host = new LocalHost(ws);
  let tool: { run(i: Record<string, unknown>, c: unknown): Promise<Out> } | undefined;
  const gates: { name: string; run(c: unknown): Promise<{ pass: boolean; summary: string; details?: string }> }[] = [];
  plugin.setup({ registerTool: (t: never) => { tool = t; }, registerGate: (g: never) => gates.push(g) });
  const ctx = { host, signal: new AbortController().signal, readFiles: new Map(), todos: [], setTodos() {}, emit() {} };
  const times: Record<string, number> = {};
  const facts: Record<string, unknown> = {};
  const call = async (name: string, input: Record<string, unknown>, ok = true): Promise<Out> => {
    const t0 = Date.now();
    const r = await tool!.run(input, ctx);
    times[name] = Math.round((Date.now() - t0) / 100) / 10;
    console.log(`# ${name} (${times[name]} s): ${r.content.split('\n')[0]}`);
    if (ok) assert.ok(!r.is_error, `${name} failed:\n${r.content.slice(0, 4000)}`);
    return r;
  };
  const data = (r: Out) => JSON.parse(/(?:^|\n)Data: (.*)/.exec(r.content)?.[1] ?? '{}');
  const look = (r: Out, what: string) => {
    assert.ok(r.images?.length, `${what}: an image`);
    const st = pngStats(Buffer.from(r.images![0]!.data, 'base64'));
    assert.ok(!st.blank && st.width >= 640, `${what}: not blank (${st.width}x${st.height}, ${st.colours} colours)`);
    return st;
  };
  try {
    const d = await call('detect', { action: 'detect' });
    assert.match(d.content, /Unreal Engine 5\./);
    facts.detect = d.content.split('\n')[0];

    await call('project.create', { action: 'project.create', name: 'CoinEscape', template: 'TP_ThirdPersonBP' });
    const studio = JSON.parse(await fs.readFile(path.join(ws, 'CoinEscape', '.studio', 'project.json'), 'utf8'));
    assert.equal(studio.engineProject, 'Game/CoinEscape.uproject');

    const lv = await call('script: coin level and Blueprints', { action: 'script', code: LEVEL, timeoutSec: 1800 });
    const ld = data(lv);
    assert.equal(ld.made.pickups, 10);
    const coin = ld.blueprints.find((b: { path: string }) => b.path.endsWith('BP_Coin'));
    assert.deepEqual(Object.keys(coin.components).sort(), ['DefaultSceneRoot', 'Mesh', 'Spin', 'Trigger']);
    assert.ok(ld.blueprints.every((b: { status: string }) => b.status === 'BS_UP_TO_DATE'), JSON.stringify(ld.blueprints));

    // A model from Blender (or the test's own glb when Blender is not here), imported and placed.
    await fs.mkdir(path.join(ws, 'assets'), { recursive: true });
    const blender = findBinary('blender') as string | null;
    const glb = path.join(ws, 'assets', 'crate.glb');
    if (blender) {
      const py = path.join(ws, 'assets', 'make_crate.py');
      await fs.writeFile(py, 'import bpy, sys\nbpy.ops.wm.read_factory_settings(use_empty=True)\nbpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, 0.5))\nm = bpy.data.materials.new("CrateWood"); m.use_nodes = True\nm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.55, 0.33, 0.12, 1)\nbpy.context.active_object.data.materials.append(m)\nbpy.ops.export_scene.gltf(filepath=sys.argv[-1], export_format="GLB")\n');
      execFileSync(blender, ['-b', '--factory-startup', '-noaudio', '--python-exit-code', '1', '--python', py, '--', glb], { stdio: 'ignore', timeout: 180_000 });
    } else await fs.writeFile(glb, glbBytes());
    facts.glbFrom = blender ? 'Blender' : 'test glb';
    const imp = await call('asset.import', { action: 'asset.import', files: ['assets/crate.glb'], dest: '/Game/Imported/Crate' });
    const mesh = data(imp).assets.find((a: string) => /StaticMesh|crate\.crate$/.test(a));
    assert.ok(mesh, imp.content);
    await call('script: place crates', { action: 'script', code: `import harness_ue as h\nh.open_level("/Game/Levels/Lvl_Coins")\nm = h.mesh(${JSON.stringify(mesh)})\nfor i, at in enumerate([(-600, -500, 0), (-500, -620, 0), (300, -900, 0)]):\n    h.spawn("StaticMeshActor", location=at, label="Crate_%d" % i, folder="Level/Props", mesh_path=m.get_path_name())\nb = m.get_bounding_box()\nh.result("size", [b.max.x - b.min.x, b.max.z - b.min.z])\nh.save()\n` });

    const desc = data(await call('describe', { action: 'describe' }));
    assert.ok(desc.actors.some((a: string) => /^Crate_0 /.test(a)) && desc.actors.filter((a: string) => /^Coin_/.test(a)).length === 10);

    const cg = await call('capture: game view', { action: 'capture', at: [-2600, -1700, 1300], target: [0, 0, 0], width: 1280, height: 720 });
    facts.captureGame = look(cg, 'game capture');
    const ce = await call('capture: editor view', { action: 'capture', view: 'editor', camera: 'ShotCam', width: 1280, height: 720 });
    facts.captureEditor = look(ce, 'editor capture');

    const t = await call('test: automation + checks', { action: 'test', filter: 'Project.Functional Tests', checks: "h.open_level('/Game/Levels/Lvl_Coins')\nh.check('ten coins', len(h.find_actors(cls='/Game/CoinKit/BP_Coin')) == 10)\nh.check('three crates', len(h.find_actors(label='Crate')) == 3)\n" });
    const td = data(t);
    assert.equal(td.automation.passed, 1);
    assert.equal(td.automation.tests[0].path, 'Project.Functional Tests.Levels.Lvl_Coins.FT_CoinCount');
    const bad = await call('test: a failing check', { action: 'test', automation: false, checks: "h.check('eleven coins', len(h.find_actors(cls='/Game/CoinKit/BP_Coin')) == 11)\n" }, false);
    assert.ok(bad.is_error && /eleven coins/.test(bad.content), 'a failing check fails the test');

    const pk = await call('package Win64 Development', { action: 'package', config: 'Development' });
    const pd = data(pk);
    const exe = path.join(ws, pd.exe);
    facts.buildMb = Math.round((await size(path.join(ws, pd.archive))) / 1048576);
    assert.ok((await fs.stat(exe)).size > 0);

    const play = await call('play packaged 10 s', { action: 'play', seconds: 10, inputs: [{ at: 300, key: 'W', ms: 9500 }], captureEveryMs: 1500, expect: ['win'], goal: 'collect the 10 coins and reach the exit' });
    const pr = data(play);
    assert.equal(pr.result, 'pass');
    assert.equal(pr.events.filter((e: { type: string }) => e.type === 'score').length, 10);
    facts.play = /(?:^|\n)Metrics: (.*)/.exec(play.content)?.[1];
    look(play, 'a played frame');

    // The AI player's driver: paused steps in the editor's -game mode.
    const drv = await createDriver(host, { project: 'CoinEscape', watch: ['/Game/CoinKit/BP_Coin.BP_Coin_C'] });
    const t0 = Date.now();
    const s = await drv.start();
    times['driver start'] = Math.round((Date.now() - t0) / 100) / 10;
    const o0 = await s.observe();
    assert.ok(o0.frame?.png?.length > 1000, 'a frame');
    let last = o0;
    for (let i = 0; i < 4; i++) last = await s.step([{ key: 'KeyW' }], 1000);
    assert.ok(last.state.pawn.location[0] > o0.state.pawn.location[0] + 1000, 'the pawn moved forward');
    assert.ok(last.state.vars.Score >= 4, JSON.stringify(last.state));
    const stopped = await s.stop();
    facts.driver = { score: last.state.vars.Score, ...stopped.metrics };

    await call('bridge.connect', { action: 'bridge.connect' });
    const bp = data(await call('bridge.python', { action: 'bridge.python', code: "import harness_ue as h\nh.result('coins', len(h.find_actors(cls='/Game/CoinKit/BP_Coin')))\n" }));
    assert.equal(bp.coins, 10);
    const ver = data(await call('bridge.call', { action: 'bridge.call', objectPath: '/Script/Engine.Default__KismetSystemLibrary', function: 'GetEngineVersion' }));
    assert.match(ver.ReturnValue, /^5\./);
    await call('bridge.disconnect', { action: 'bridge.disconnect' });

    const rd = await call('render turntable', { action: 'render', level: '/Game/Levels/Lvl_Coins', turntable: { target: [0, 0, 0], radius: 2600, height: 1600, seconds: 2, fps: 8 }, width: 960, height: 540 });
    assert.match(rd.content, /Metrics: frames=16\b/);
    look(rd, 'a render');

    for (const g of gates) {
      const t1 = Date.now();
      const r = await g.run({ host, signal: ctx.signal });
      times[`gate ${g.name}`] = Math.round((Date.now() - t1) / 100) / 10;
      console.log(`# gate ${g.name}: ${r.pass ? 'pass' : 'FAIL'} - ${r.summary}`);
      assert.ok(r.pass, `${g.name}: ${r.summary}\n${r.details ?? ''}`);
    }
    facts.projectMb = Math.round((await size(path.join(ws, 'CoinEscape', 'Game'))) / 1048576);
    const summary = { engine: eng.version, times, facts };
    console.log(JSON.stringify(summary, null, 2));
    await fs.writeFile(path.join(base, 'unreal-real-results.json'), JSON.stringify(summary, null, 2));
  } finally {
    await plugin.close();
    if (process.env.HARNESS_UNREAL_KEEP !== '1') console.log(`# ${await safeRemove(ws)}`);
  }
});

void here;
