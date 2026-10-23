import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { formatGates, runGates } from '../src/gates/gates.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { DockerHost, dockerAvailable, dockerDefaults, imageExists } from '../src/runtime/docker.ts';
import { type ExecOptions, type ExecResult, LocalHost, type ToolHost } from '../src/runtime/host.ts';
import { skillsIn } from '../src/skills/skills.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { fakeGodot, glbBytes, pngBytes, tempDir, testPicture } from './helpers.ts';

// Blender and Godot, now the engine-blender and engine-godot plugins (games3d keeps
// model_info and the model gates). The unit tests use stub hosts; the integration tests
// run the real programs: Blender on this machine when it is installed, and both inside
// the 3D sandbox image when Docker has it. More in engine-godot*.test.ts and
// engine-blender*.test.ts.

const here = path.dirname(fileURLToPath(import.meta.url));
// @ts-expect-error plain JS module
const E = await import('../plugins/games3d/lib-engines.mjs');
// @ts-expect-error plain JS module
const { inspectGltf } = await import('../plugins/games3d/lib-gltf.mjs');
// @ts-expect-error plain JS module
const { findBinary } = await import('../plugins/visual/lib/binaries.mjs');

const blenderBin = findBinary('blender') as string | null;
const IMAGE_3D = 'harness-sandbox-3d:latest';
const has3dImage = (await dockerAvailable()) && (await imageExists(IMAGE_3D));
// The 3D image with Godot's export templates (npm run sandbox:image:3d-export).
const IMAGE_EXPORT = 'harness-sandbox-3d:export';
const hasExportImage = (await dockerAvailable()) && (await imageExists(IMAGE_EXPORT));

/** A host whose commands are answered by `answer` and recorded. */
function stubHost(kind: 'docker' | 'local' | 'companion', root: string, answer: (cmd: string) => Partial<ExecResult>): ToolHost & { cmds: string[] } {
  const cmds: string[] = [];
  return {
    kind, root, displayRoot: kind === 'docker' ? '/workspace' : root, platform: 'linux', shell: 'bash', sandboxed: kind === 'docker', networkPolicy: 'none', cmds,
    async exec(cmd: string, _o: ExecOptions): Promise<ExecResult> { cmds.push(cmd); return { stdout: '', stderr: '', code: 0, timedOut: false, ...answer(cmd) }; },
  };
}

const ctxOf = (host: ToolHost) => ({ host, signal: new AbortController().signal, readFiles: new Map(), todos: [], setTodos() {}, emit() {} }) as unknown as ToolContext;

const PROJECT = 'config_version=5\n\n[application]\n\nconfig/name="Demo"\nrun/main_scene="res://main.tscn"\n';
const MAIN_TSCN = '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://main.gd" id="1"]\n\n[node name="Main" type="Node2D"]\nscript = ExtResource("1")\n';
const MAIN_GD = 'extends Node2D\n\nvar frames := 0\n\nfunc _ready() -> void:\n\tprint("ARGS ", OS.get_cmdline_user_args())\n\nfunc _process(_delta: float) -> void:\n\tframes += 1\n\tqueue_redraw()\n\nfunc _draw() -> void:\n\tdraw_rect(Rect2(100, 100, 200, 120), Color(1, 0.6, 0.1))\n';

async function harness() {
  return createHarness({ dataDir: await tempDir(), plugins: [path.join(here, '..', 'plugins')] });
}

test('the engine plugins register the blender and godot tools, their gates and skills; the agents know when to use them', async () => {
  const h = await harness();
  for (const t of ['blender', 'godot', 'model_info']) assert.ok(h.registry.tools.has(t), t);
  for (const g of ['blender-file', 'godot-project', 'godot-selftest', 'godot-export', 'gltf-valid', 'model-preview']) assert.ok(h.registry.gates.has(g), g);
  const names = [
    ...await skillsIn(path.join(here, '..', 'plugins', 'games3d', 'skills'), 'games3d'),
    ...await skillsIn(path.join(here, '..', 'plugins', 'engine-blender', 'skills'), 'engine-blender'),
    ...await skillsIn(path.join(here, '..', 'plugins', 'engine-godot', 'skills'), 'engine-godot'),
  ].map((s: { name: string }) => s.name);
  for (const s of ['blender-scripting', 'blender-sprites', 'godot-essentials', 'godot-2d', 'godot-gdscript-testing', 'threejs-essentials']) assert.ok(names.includes(s), s);
  for (const a of ['blender-artist', 'godot-engineer']) assert.ok(h.registry.agents.has(a), a);
  assert.match(h.registry.agents.get('3d-artist')!.prompt, /blender-scripting/);
  assert.match(h.registry.agents.get('game-engineer')!.prompt, /godot-essentials/);
  await h.close();
});

// ---------- commands ----------

test('blender and godot command lines: argument order, quoting for bash and PowerShell, a display for frames on Linux', () => {
  assert.deepEqual(E.blenderArgs({ script: 'tools/make.py', file: 'art/ship.blend', args: ['out.glb', 2] }),
    ['-b', '--factory-startup', '-noaudio', 'art/ship.blend', '--python-exit-code', '1', '--python', 'tools/make.py', '--', 'out.glb', '2']);
  assert.deepEqual(E.blenderArgs({ script: 's.py' }), ['-b', '--factory-startup', '-noaudio', '--python-exit-code', '1', '--python', 's.py']);
  assert.deepEqual(E.godotArgs('import', { project: 'game' }), ['--headless', '--path', 'game', '--import']);
  assert.deepEqual(E.godotArgs('run', { project: '.', frames: 60, scene: 'levels/one.tscn' }), ['--headless', '--path', '.', '--fixed-fps', '60', '--quit-after', '60', 'res://levels/one.tscn']);
  assert.deepEqual(E.godotArgs('run', { project: 'g', frames: 5, args: ['--selftest'] }), ['--headless', '--path', 'g', '--fixed-fps', '60', '--quit-after', '5', '--', '--selftest']);
  const shot = E.godotArgs('screenshot', { project: '.', frames: 30, movie: '/workspace/.harness/godot/f/frame.png' });
  assert.ok(!shot.includes('--headless'), 'frames need a renderer, not the headless display');
  assert.deepEqual(shot.slice(shot.indexOf('--write-movie'), shot.indexOf('--write-movie') + 2), ['--write-movie', '/workspace/.harness/godot/f/frame.png']);
  assert.ok(shot.includes('opengl3') && shot.includes('gl_compatibility'));
  assert.deepEqual(E.godotArgs('export', { project: '.', preset: 'Linux', output: '/workspace/build/g.x86_64' }), ['--headless', '--path', '.', '--export-release', 'Linux', '/workspace/build/g.x86_64']);

  const win = 'C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe';
  assert.equal(E.commandLine(win, ['-b', "it's.py"], 'bash'), `'${win}' -b 'it'\\''s.py'`);
  assert.equal(E.commandLine(win, ['-b', "it's.py"], 'powershell'), `& '${win}' '-b' 'it''s.py'`);
  assert.equal(E.commandLine('/usr/local/bin/godot', ['--path', 'my game'], 'bash'), "/usr/local/bin/godot --path 'my game'");
  // Every Python check expression survives both shells' quoting (no double quotes for PowerShell 5 to drop).
  assert.ok(!E.BLEND_CHECK.includes('"'));

  const linux = { platform: 'linux', shell: 'bash' } as ToolHost;
  const wrapped = E.withDisplay(linux)('godot --path .');
  assert.match(wrapped, /command -v xvfb-run .* command -v xauth[^\n]*\n  xvfb-run -a .* godot --path \./, 'xvfb-run only with xauth');
  assert.match(wrapped, /Xvfb ":\$n"[\s\S]*DISPLAY=":\$n" godot --path \./, 'else an Xvfb of its own');
  assert.match(wrapped, /\nelse\n  godot --path \.\nfi$/);
  assert.equal(E.withDisplay({ platform: 'win32', shell: 'bash' } as ToolHost), undefined);
});

test('godot output: script errors with their location are problems; warnings and exit bookkeeping are not', () => {
  const out = [
    'Godot Engine v4.7.2.stable.official - https://godotengine.org',
    '\x1b[1;31mSCRIPT ERROR: Parse Error: Expected parameter name.\x1b[0m',
    '          at: GDScript::reload (res://bad.gd:3)',
    'ERROR: Failed to load script "res://bad.gd" with error "Parse error".',
    '   at: load (modules/gdscript/gdscript_resource_format.cpp:46)',
    'WARNING: Could not set V-Sync mode.',
    'ERROR: 2 resources still in use at exit.',
    'SCRIPT ERROR: Parse Error: Expected parameter name.',
    '          at: GDScript::reload (res://bad.gd:3)',
    'ERROR: score went negative',
    '   at: push_error (core/variant/variant_utility.cpp:1023)',
    '   GDScript backtrace (most recent call first):',
    '       [0] _ready (res://main.gd:4)',
    'WARNING: just a warning',
  ].join('\n');
  assert.deepEqual(E.godotProblems(out), [
    'SCRIPT ERROR: Parse Error: Expected parameter name. (at: GDScript::reload (res://bad.gd:3))',
    'ERROR: Failed to load script "res://bad.gd" with error "Parse error". (at: load (modules/gdscript/gdscript_resource_format.cpp:46))',
    'ERROR: score went negative (at: _ready (res://main.gd:4))',
  ]);
});

// ---------- discovery ----------

test('discovery in a sandbox or companion runs inside it (host.exec), never on the server; a server folder uses the server finder', async () => {
  const root = await tempDir();
  const serverFinder = (n: string) => `/server/${n}`;
  const docker = stubHost('docker', root, (cmd) => (cmd.includes('HARNESS_GODOT') ? { stdout: '/usr/local/bin/godot\n' } : { code: 1 }));
  assert.equal(await E.locate(docker, 'godot', undefined, serverFinder), '/usr/local/bin/godot');
  assert.match(docker.cmds[0]!, /command -v "\$c"/);
  assert.match(docker.cmds[0]!, /godot4/);
  assert.match(docker.cmds[0]!, /Godot_v4|godot_v4/i);
  // Remembered once found.
  await E.locate(docker, 'godot', undefined, serverFinder);
  assert.equal(docker.cmds.length, 1);
  // Missing in the sandbox: null, even though the server has it, and the message points at the 3D image.
  assert.equal(await E.locate(docker, 'blender', undefined, serverFinder), null);
  assert.match(docker.cmds[1]!, /\/opt\/blender\/blender/);
  assert.match(E.missingIn(docker, 'blender'), /3D sandbox image.*sandbox:image:3d.*HARNESS_SANDBOX_IMAGES/);
  const local = stubHost('local', root, () => { throw new Error('a server folder must not probe with a command'); });
  assert.equal(await E.locate(local, 'blender', undefined, serverFinder), '/server/blender');
  // A PowerShell companion is asked with Get-Command.
  const ps = { ...stubHost('companion', root, () => ({ stdout: 'C:\\Godot\\godot.exe\r\n' })), shell: 'powershell' };
  assert.equal(await E.locate(ps, 'godot', undefined, serverFinder), 'C:\\Godot\\godot.exe');
  assert.match(ps.cmds[0]!, /Get-Command godot,godot4/);
});

test('blender and godot tools refuse paths outside the workspace before running anything', async () => {
  const h = await harness();
  const root = await tempDir();
  const host = stubHost('local', root, () => ({ code: 1 }));
  const tool = (n: string) => h.registry.tools.get(n)!;
  assert.equal(tool('blender').kind, 'exec');
  assert.equal(tool('godot').kind, 'exec');
  await assert.rejects(tool('blender').run({ script: '../evil.py' }, ctxOf(host)), /outside the workspace/);
  await assert.rejects(tool('blender').run({ code: 'pass', file: '../x.blend' }, ctxOf(host)), /outside the workspace/);
  await assert.rejects(tool('godot').run({ action: 'check', project: '../elsewhere' }, ctxOf(host)), /outside the workspace/);
  const both = await tool('blender').run({ script: 'a.py', code: 'pass' }, ctxOf(host));
  assert.equal(both.is_error, true);
  const none = await tool('godot').run({ action: 'check' }, ctxOf(host));
  assert.match(none.content, /No project\.godot in \./);
  // A companion's folder is on the user's computer: checked by the path's shape.
  const comp = { ...stubHost('companion', '', () => ({ code: 1 })), displayRoot: '/home/me/game' };
  assert.equal(await E.relIn(comp, '/home/me/game/art/a.blend'), 'art/a.blend');
  await assert.rejects(E.relIn(comp, '/home/me/other.py'), /outside the workspace/);
  await assert.rejects(E.relIn(comp, 'a/../../x.py'), /outside the workspace/);
  assert.equal(host.cmds.length, 0, 'nothing ran');
  await h.close();
});

test('godot-project and blender-file gates apply only to their files, and without the program they warn instead of failing', async () => {
  const h = await harness();
  const root = await tempDir();
  const sandbox = stubHost('docker', root, () => ({ code: 1 })); // the probe finds nothing
  const signal = new AbortController().signal;
  let r = await runGates(h.registry, sandbox, 'applicable', signal);
  assert.ok(!r.some((g) => g.name === 'godot-project' || g.name === 'blender-file'), 'no Godot project or .blend: the gates do not apply');
  await fs.writeFile(path.join(root, 'project.godot'), 'config_version=5\n');
  await fs.mkdir(path.join(root, 'art'));
  await fs.writeFile(path.join(root, 'art', 'ship.blend'), 'BLENDER');
  await fs.mkdir(path.join(root, 'node_modules', 'x'), { recursive: true });
  await fs.writeFile(path.join(root, 'node_modules', 'x', 'skip.blend'), 'BLENDER');
  r = await runGates(h.registry, sandbox, ['godot-project', 'blender-file'], signal);
  for (const g of r) {
    assert.equal(g.pass, false);
    assert.equal(g.severity, 'advisory', `${g.name} must not block the run`);
    assert.match(g.summary, /not checked: (Godot|Blender) is not installed in this runtime/);
    assert.match(g.details ?? '', /3D sandbox image/);
  }
  assert.match(formatGates(r), /^All blocking gates passed\.\nWARN (blender-file|godot-project)/);
  assert.ok((await E.findFiles(root, (n: string) => n.endsWith('.blend'))).every((f: string) => !f.includes('node_modules')));
  await h.close();
});

// ---------- Godot export presets, self-tests and previews (with a stand-in Godot) ----------

test('export presets: read from export_presets.cfg; a minimal Linux or Web preset is written only when asked', () => {
  const cfg = '[preset.0]\n\nname="Linux \\"x\\""\nplatform="Linux"\nrunnable=true\n\n[preset.0.options]\n\nname="not a preset name"\n\n[preset.3]\nname="Web"\nplatform="Web"\n';
  assert.deepEqual(E.presetsIn(cfg), [{ index: 0, name: 'Linux "x"', platform: 'Linux' }, { index: 3, name: 'Web', platform: 'Web' }]);
  assert.deepEqual(E.presetsIn(''), []);
  const linux = E.withPreset('', 'linux', 'Linux', 'build/linux/game.x86_64');
  assert.match(linux, /^\[preset\.0\]\n\nname="Linux"\nplatform="Linux"\nrunnable=true\n[\s\S]*export_path="build\/linux\/game\.x86_64"\n\n\[preset\.0\.options\]\n\nbinary_format\/embed_pck=false\nbinary_format\/architecture="x86_64"\n$/);
  const both = E.withPreset(cfg, 'web', 'Web build', '../build/web/index.html');
  assert.ok(both.startsWith(cfg.trimEnd()), 'what was there is kept as it was');
  assert.deepEqual(E.presetsIn(both).map((p: { index: number; name: string }) => `${p.index}:${p.name}`), ['0:Linux "x"', '3:Web', '4:Web build']);
  assert.match(both, /\[preset\.4\.options\]\n\nvariant\/extensions_support=false\nvariant\/thread_support=false/);
  assert.throws(() => E.minimalPreset('android', 0, 'A', 'a.apk'), /unknown preset kind/);
});

test('PNG reader: size and blank detection through every row filter, RGB and RGBA', async () => {
  // @ts-expect-error plain JS module
  const { pixels, pngStats } = await import('../plugins/games3d/lib-png.mjs');
  const pic = pngStats(testPicture());
  assert.deepEqual([pic.width, pic.height, pic.blank], [96, 64, false]);
  assert.ok(pic.colours > 50 && pic.stddev > 10, JSON.stringify(pic));
  const flat = pngStats(pngBytes(80, 80, () => [40, 40, 40, 255], true));
  assert.deepEqual([flat.colours, flat.blank], [1, true]);
  // Two colours only (a tiny object lost in the background) still counts as blank, like the browser's check.
  assert.equal(pngStats(pngBytes(80, 80, (x) => (x < 2 ? [255, 255, 255] : [0, 0, 0]))).blank, true);
  // Decoded values are exact: seven rows (each PNG filter at least once) read back byte for byte.
  const px = (x: number, y: number) => [x, (x * y * 7) & 255, 255 - x, (x + y) & 255];
  const decoded = pixels(pngBytes(200, 7, px, true));
  const want = Buffer.from(Array.from({ length: 7 }, (_, y) => Array.from({ length: 200 }, (_, x) => px(x, y))).flat(2));
  assert.ok(decoded.data.equals(want), 'every pixel decodes to what was encoded');
  assert.equal(pngStats(pngBytes(200, 7, px, true)).blank, false);
  assert.throws(() => pngStats(Buffer.from('not a png at all, really not at all')), /not a PNG/);
});

test('godot export with a stand-in Godot: a missing preset is an error naming the ones there; createPreset writes one and says so', async () => {
  const fake = await fakeGodot();
  process.env.HARNESS_GODOT = fake.bin;
  const h = await harness();
  const root = await tempDir();
  const host = new LocalHost(root);
  const godot = (input: Record<string, unknown>) => h.registry.tools.get('godot')!.run(input, ctxOf(host));
  try {
    await fs.mkdir(path.join(root, 'game'));
    await fs.writeFile(path.join(root, 'game', 'project.godot'), PROJECT);
    let r = await godot({ action: 'export', project: 'game', preset: 'Linux', output: 'build/g.x86_64' });
    assert.equal(r.is_error, true);
    assert.match(r.content, /no preset named "Linux"\. game\/export_presets\.cfg does not exist\..*createPreset: "windows", "linux" or "web"/);
    await assert.rejects(fs.stat(path.join(root, 'game', 'export_presets.cfg')), 'nothing written without being asked');
    assert.deepEqual(await fake.calls(), [], 'Godot did not run');

    r = await godot({ action: 'export', project: 'game', createPreset: 'linux' });
    assert.ok(!r.is_error, r.content);
    assert.match(r.content, /godot export: Linux -> build\/linux\/game\.x86_64 in [\d.]+s\.\nWrote a minimal Linux preset "Linux" to game\/export_presets\.cfg \(it was not there\)\.\nWritten in build\/linux: game\.pck [\d.]+ MB, game\.x86_64 [\d.]+ MB/);
    let cfg = await fs.readFile(path.join(root, 'game', 'export_presets.cfg'), 'utf8');
    assert.deepEqual(E.presetsIn(cfg), [{ index: 0, name: 'Linux', platform: 'Linux' }]);
    assert.match(cfg, /export_path="\.\.\/build\/linux\/game\.x86_64"/);
    const calls = await fake.calls();
    assert.match(calls.at(-2)!, /--headless --path game --import$/);
    assert.match(calls.at(-1)!, /--headless --path game --export-release Linux .*\/build\/linux\/game\.x86_64$/);

    r = await godot({ action: 'export', project: 'game', createPreset: 'web', debug: true });
    assert.match(r.content, /Web -> build\/web\/index\.html .*\(debug\)\.\nWrote a minimal Web preset "Web"/);
    cfg = await fs.readFile(path.join(root, 'game', 'export_presets.cfg'), 'utf8');
    assert.deepEqual(E.presetsIn(cfg).map((p: { name: string }) => p.name), ['Linux', 'Web']);
    assert.match((await fake.calls()).at(-1)!, /--export-debug Web /);

    // Asked again for a preset that is there: used as it is, the file unchanged.
    r = await godot({ action: 'export', project: 'game', preset: 'Linux', createPreset: 'linux', output: 'build/again.x86_64' });
    assert.match(r.content, /Used the preset "Linux" already in game\/export_presets\.cfg \(createPreset changed nothing\)/);
    assert.equal(await fs.readFile(path.join(root, 'game', 'export_presets.cfg'), 'utf8'), cfg);

    r = await godot({ action: 'export', project: 'game', preset: 'Mac', output: 'build/m.zip' });
    assert.match(r.content, /no preset named "Mac"\. The presets there: "Linux" \(Linux\), "Web" \(Web\)\./);
    r = await godot({ action: 'export', project: 'game', createPreset: 'android' });
    assert.match(r.content, /createPreset must be "windows", "linux" or "web"/);
    await assert.rejects(godot({ action: 'export', project: 'game', preset: 'Linux', output: '../outside.x86_64' }), /outside the workspace/);

    process.env.FAKE_NO_TEMPLATES = '1';
    r = await godot({ action: 'export', project: 'game', preset: 'Linux', output: 'build/g.x86_64' });
    assert.equal(r.is_error, true);
    assert.match(r.content, /export templates are not installed for this Godot version/);
    const docker = { ...host, kind: 'docker', displayRoot: root, exec: host.exec.bind(host) } as unknown as ToolHost;
    r = await h.registry.tools.get('godot')!.run({ action: 'export', project: 'game', preset: 'Linux', output: 'build/g.x86_64' }, ctxOf(docker));
    assert.match(r.content, /not in this sandbox image.*npm run sandbox:image:3d-export/);
  } finally {
    delete process.env.HARNESS_GODOT;
    delete process.env.FAKE_NO_TEMPLATES;
    await h.close();
  }
});

test('godot-selftest gate: passes on SELFTEST PASS, fails on a push_error or on silence, applies only to projects with a --selftest mode', async () => {
  const fake = await fakeGodot();
  process.env.HARNESS_GODOT = fake.bin;
  const h = await harness();
  const root = await tempDir();
  const host = new LocalHost(root);
  const signal = new AbortController().signal;
  const gate = h.registry.gates.get('godot-selftest')!;
  try {
    await fs.mkdir(path.join(root, 'game'));
    await fs.writeFile(path.join(root, 'game', 'project.godot'), PROJECT);
    await fs.writeFile(path.join(root, 'game', 'main.gd'), MAIN_GD);
    assert.equal(await gate.applies!(host, signal), false, 'no --selftest mode: not applicable');
    let [g] = await runGates(h.registry, host, ['godot-selftest'], signal);
    assert.equal(g!.pass, false);
    assert.match(g!.details ?? '', /never printed SELFTEST PASS in 600 frames/);
    await fs.writeFile(path.join(root, 'game', 'main.gd'), `${MAIN_GD}\nvar selftest := "--selftest" in OS.get_cmdline_user_args()\n# print("SELFTEST PASS")\n`);
    assert.equal(await gate.applies!(host, signal), true);
    [g] = await runGates(h.registry, host, ['godot-selftest'], signal);
    assert.equal(g!.pass, true, g!.details ?? '');
    assert.match(g!.summary, /1 Godot self-test\(s\) passed: game/);
    assert.match((await fake.calls()).at(-1)!, /--headless --path game --fixed-fps 60 --quit-after 600 -- --selftest$/);
    await fs.appendFile(path.join(root, 'game', 'main.gd'), '# FAKE_FAIL\n');
    [g] = await runGates(h.registry, host, ['godot-selftest'], signal);
    assert.equal(g!.pass, false);
    assert.match(g!.details ?? '', /ERROR: selftest: the player did not move \(at: _physics_process \(res:\/\/main\.gd:9\)\)/);
  } finally {
    delete process.env.HARNESS_GODOT;
    await h.close();
  }
});

test('model-preview gate: previews must exist, be newer than the model and show something', async () => {
  const h = await harness();
  const root = await tempDir();
  const host = new LocalHost(root);
  const signal = new AbortController().signal;
  const check = async () => (await runGates(h.registry, host, ['model-preview'], signal))[0]!;
  try {
    let g = await check();
    assert.equal(g.pass, false);
    assert.match(g.summary, /no model/);
    await fs.writeFile(path.join(root, 'model.glb'), glbBytes());
    assert.equal(await h.registry.gates.get('model-preview')!.applies!(host, signal), false, 'no previews yet: not applicable on its own');
    g = await check();
    assert.match(g.summary, /no preview renders in previews\//);
    await fs.mkdir(path.join(root, 'previews'));
    await fs.writeFile(path.join(root, 'previews', 'front.png'), testPicture());
    await fs.writeFile(path.join(root, 'previews', 'top.png'), pngBytes(128, 128, () => [90, 90, 90]));
    g = await check();
    assert.equal(g.pass, false);
    assert.match(g.details ?? '', /previews\/top\.png: blank \(1 colour\(s\)\)/);
    await fs.writeFile(path.join(root, 'previews', 'top.png'), testPicture(128, 128));
    g = await check();
    assert.equal(g.pass, true, g.details ?? '');
    assert.match(g.summary, /^2 preview\(s\) of 1 model\(s\): previews\/front\.png 96x64, \d+ colours, previews\/top\.png 128x128/);
    // The model exported again after the renders: the previews are stale.
    const later = new Date(Date.now() + 60_000);
    await fs.utimes(path.join(root, 'model.glb'), later, later);
    g = await check();
    assert.equal(g.pass, false);
    assert.match(g.details ?? '', /front\.png: older than the last model export/);
  } finally { await h.close(); }
});

test('readIn on a companion asks for the one file (its mirror skips .harness), falling back to the mirror for old companions', async () => {
  const asked: string[] = [];
  const comp = { kind: 'companion', root: '', displayRoot: '/home/me/game', readFile: async (rel: string) => { asked.push(rel); return rel.endsWith('a.png') ? Buffer.from('PNG') : null; }, mirror: async () => { throw new Error('mirror used'); } } as unknown as ToolHost;
  assert.equal((await E.readIn(comp, '.harness/godot/f/a.png')).toString(), 'PNG');
  await assert.rejects(E.readIn(comp, 'missing.png'), (e: Error & { code?: string }) => e.code === 'ENOENT');
  assert.equal(await E.readTextIn(comp, 'missing.cfg'), null);
  assert.deepEqual(asked, ['.harness/godot/f/a.png', 'missing.png', 'missing.cfg']);
  const mirrored = await tempDir();
  await fs.writeFile(path.join(mirrored, 'x.txt'), 'from the mirror');
  const old = { kind: 'companion', root: '', displayRoot: '/home/me/game', mirror: async () => mirrored } as unknown as ToolHost;
  assert.equal(await E.readTextIn(old, 'x.txt'), 'from the mirror');
  // Folder commands go to the companion's own shell.
  const cmds: string[] = [];
  const ps = { kind: 'companion', shell: 'powershell', exec: async (c: string) => { cmds.push(c); return { code: 0, stdout: 'frame00000001.png\r\nframe00000000.png\r\n', stderr: '', timedOut: false }; } } as unknown as ToolHost;
  await E.mkdirIn(ps, ".harness/it's");
  assert.deepEqual(await E.listIn(ps, '.harness/f'), ['frame00000001.png', 'frame00000000.png']);
  await E.removeIn(ps, '.harness/f');
  assert.deepEqual(cmds, ["New-Item -ItemType Directory -Force -Path '.harness/it''s' | Out-Null", "if (Test-Path -LiteralPath '.harness/f') { Get-ChildItem -Name -LiteralPath '.harness/f' }", "Remove-Item -Recurse -Force -LiteralPath '.harness/f' -ErrorAction SilentlyContinue"]);
});

// ---------- Blender on this machine ----------

const CRATE = `import bpy, os, sys
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
out = argv[0] if argv else 'crate.glb'
os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.5))
crate = bpy.context.active_object
crate.name = 'Crate'
mat = bpy.data.materials.new('Wood')
mat.use_nodes = True
mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.6, 0.4, 0.2, 1)
crate.data.materials.append(mat)
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_yup=True)
bpy.ops.wm.save_as_mainfile(filepath='crate.blend')
scene = bpy.context.scene
cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam'))
scene.collection.objects.link(cam)
cam.location = (2.5, -2.5, 2.0)
cam.rotation_euler = (1.1, 0.0, 0.785)
scene.camera = cam
sun = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN'))
scene.collection.objects.link(sun)
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 8
scene.render.resolution_x = 160
scene.render.resolution_y = 120
# Absolute: Blender does not resolve a render path against the working folder (on Windows it lands in C:\\).
scene.render.filepath = os.path.abspath('preview.png')
bpy.ops.render.render(write_still=True)
print('MADE', out)
`;

/** Runs the crate script with the blender tool on a host, then checks the model, the preview and the blender-file gate. */
async function blenderEndToEnd(host: ToolHost, root: string) {
  const h = await harness();
  const tool = (n: string) => h.registry.tools.get(n)!;
  await fs.mkdir(path.join(root, 'tools'), { recursive: true });
  await fs.writeFile(path.join(root, 'tools', 'crate.py'), CRATE);
  const r = await tool('blender').run({ script: 'tools/crate.py', args: ['out/crate.glb'], show: ['preview.png'], timeoutSec: 600 }, ctxOf(host));
  assert.equal(r.is_error, false, r.content);
  assert.match(r.content, /blender exited 0/);
  assert.match(r.content, /MADE out\/crate\.glb/);
  assert.equal(r.images?.length, 1, 'the preview render is shown');
  assert.equal(Buffer.from(r.images![0]!.data, 'base64').subarray(1, 4).toString(), 'PNG');
  const g = await inspectGltf(path.join(root, 'out', 'crate.glb'));
  assert.equal(g.meshes, 1);
  assert.equal(g.triangles, 12);
  assert.deepEqual(g.size.map((v: number) => Math.round(v * 1000) / 1000), [1, 1, 1], 'one metre in Blender is one metre in glTF');
  const info = await tool('model_info').run({ path: 'out/crate.glb' }, ctxOf(host));
  assert.match(info.content, /1 mesh\(es\), 12 triangles, 1 material\(s\)/);

  // Inline code, and a Python error fails the call.
  const bad = await tool('blender').run({ code: 'import bpy\nraise RuntimeError("boom")' }, ctxOf(host));
  assert.equal(bad.is_error, true);
  assert.match(bad.content, /blender exited 1[\s\S]*RuntimeError: boom/);
  assert.deepEqual(await fs.readdir(path.join(root, '.harness', 'blender')), [], 'the inline script is removed');

  // The gate opens every .blend: the saved one passes, a broken one fails.
  const signal = new AbortController().signal;
  let [gate] = await runGates(h.registry, host, ['blender-file'], signal);
  assert.equal(gate!.pass, true, gate!.details ?? '');
  assert.match(gate!.summary, /crate\.blend \(1 objects\)/);
  await fs.writeFile(path.join(root, 'broken.blend'), 'not a blend file');
  [gate] = await runGates(h.registry, host, ['blender-file'], signal);
  assert.equal(gate!.pass, false);
  assert.match(gate!.details ?? '', /broken\.blend: exit/);
  await h.close();
}

test('blender on this machine: a crate built procedurally, exported to .glb (validated), a PNG preview, and the blender-file gate', { skip: !blenderBin && 'no Blender', timeout: 600_000 }, async () => {
  const root = await tempDir();
  await blenderEndToEnd(new LocalHost(root), root);
});

// ---------- Blender and Godot in the 3D sandbox image ----------

async function sandbox3d() {
  const root = await tempDir();
  const host = new DockerHost(`test-3d-${Date.now()}`, root, { ...dockerDefaults(), image: IMAGE_3D, network: 'none' });
  return { root, host };
}

test('3D sandbox image: blender builds, exports and renders inside the container', { skip: !has3dImage && `no Docker or no ${IMAGE_3D} (npm run sandbox:image:3d)`, timeout: 600_000 }, async () => {
  const { root, host } = await sandbox3d();
  try {
    assert.equal(await E.locate(host, 'blender'), '/usr/local/bin/blender');
    await blenderEndToEnd(host, root);
  } finally { await host.close(); }
});

test('3D sandbox image: a Godot 4 project is checked, run, screenshotted and gated inside the container', { skip: !has3dImage && `no Docker or no ${IMAGE_3D} (npm run sandbox:image:3d)`, timeout: 600_000 }, async () => {
  const { root, host } = await sandbox3d();
  const h = await harness();
  const godot = (input: Record<string, unknown>) => h.registry.tools.get('godot')!.run(input, ctxOf(host));
  const signal = new AbortController().signal;
  try {
    const game = path.join(root, 'game');
    await fs.mkdir(game);
    await fs.writeFile(path.join(game, 'project.godot'), PROJECT);
    await fs.writeFile(path.join(game, 'main.tscn'), MAIN_TSCN);
    await fs.writeFile(path.join(game, 'main.gd'), MAIN_GD);

    let r = await godot({ action: 'check', project: 'game' });
    assert.equal(r.is_error, undefined, r.content);
    assert.match(r.content, /imports cleanly; 2 scripts and scenes load without errors/);

    r = await godot({ action: 'run', project: 'game', frames: 20, args: ['--hello'] });
    assert.equal(r.is_error, false, r.content);
    assert.match(r.content, /20 frames headless .* no errors/);
    assert.match(r.content, /ARGS \["--hello"\]/, 'the game gets its own arguments');

    r = await godot({ action: 'screenshot', project: 'game', frames: 10, out: 'shots/main.png' });
    assert.equal(r.is_error, false, r.content);
    assert.match(r.content, /frame 10 of 10 saved to shots\/main\.png/);
    const png = await fs.readFile(path.join(root, 'shots', 'main.png'));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(r.images?.[0]?.data, png.toString('base64'));
    assert.deepEqual((await fs.readdir(path.join(root, '.harness', 'godot'))).filter((f) => f.startsWith('frames-')), [], 'the frames are cleaned up');

    let [gate] = await runGates(h.registry, host, 'applicable', signal).then((all) => all.filter((g) => g.name === 'godot-project'));
    assert.equal(gate?.pass, true, gate?.details ?? '');

    // A parse error is found by check and fails the gate; a runtime error is found by run.
    await fs.writeFile(path.join(game, 'broken.gd'), 'extends Node\n\nfunc broken(:\n\tpass\n');
    r = await godot({ action: 'check', project: 'game' });
    assert.equal(r.is_error, true);
    assert.match(r.content, /Parse Error.*res:\/\/broken\.gd:3/);
    [gate] = await runGates(h.registry, host, ['godot-project'], signal);
    assert.equal(gate!.pass, false);
    assert.match(gate!.details ?? '', /broken\.gd/);
    await fs.rm(path.join(game, 'broken.gd'));
    await fs.writeFile(path.join(game, 'rt.gd'), 'extends Node\n\nfunc _ready() -> void:\n\tvar d: Dictionary = {}\n\tprint(d["missing"].foo)\n');
    await fs.writeFile(path.join(game, 'rt.tscn'), MAIN_TSCN.replace('res://main.gd', 'res://rt.gd').replace('type="Node2D"', 'type="Node"'));
    r = await godot({ action: 'run', project: 'game', scene: 'rt.tscn', frames: 5 });
    assert.equal(r.is_error, true);
    assert.match(r.content, /SCRIPT ERROR: Invalid access to property or key 'missing'.*res:\/\/rt\.gd:5/);

    // The scripted self-test, with real Godot: silence fails, SELFTEST PASS passes, a push_error fails.
    await fs.rm(path.join(game, 'rt.gd'));
    await fs.rm(path.join(game, 'rt.tscn'));
    [gate] = await runGates(h.registry, host, ['godot-selftest'], signal);
    assert.equal(gate!.pass, false);
    assert.match(gate!.details ?? '', /never printed SELFTEST PASS/);
    const selftest = (check: string) => `${MAIN_GD}\nvar ticks := 0\n\nfunc _physics_process(_delta: float) -> void:\n\tticks += 1\n\tif "--selftest" in OS.get_cmdline_user_args() and ticks == 20:\n\t\t${check}\n\t\tget_tree().quit()\n`;
    await fs.writeFile(path.join(game, 'main.gd'), selftest('if frames > 0: print("SELFTEST PASS")\n\t\telse: push_error("selftest: nothing was drawn")'));
    assert.equal(await h.registry.gates.get('godot-selftest')!.applies!(host, signal), true);
    [gate] = await runGates(h.registry, host, ['godot-selftest'], signal);
    assert.equal(gate!.pass, true, gate!.details ?? '');
    await fs.writeFile(path.join(game, 'main.gd'), selftest('push_error("selftest: the score did not go up")'));
    [gate] = await runGates(h.registry, host, ['godot-selftest'], signal);
    assert.equal(gate!.pass, false);
    assert.match(gate!.details ?? '', /ERROR: selftest: the score did not go up \(at: _physics_process \(res:\/\/main\.gd:\d+\)\)/);
    await fs.writeFile(path.join(game, 'main.gd'), MAIN_GD);

    // Export without templates says what is missing, and where to get them.
    await fs.writeFile(path.join(game, 'export_presets.cfg'), '[preset.0]\n\nname="Linux"\nplatform="Linux"\nrunnable=true\nexport_filter="all_resources"\nexport_path="build/demo.x86_64"\n\n[preset.0.options]\n\nbinary_format/architecture="x86_64"\n');
    r = await godot({ action: 'export', project: 'game', preset: 'Linux', output: 'build/demo.x86_64' });
    assert.equal(r.is_error, true);
    assert.match(r.content, /export templates are not in this sandbox image.*npm run sandbox:image:3d-export/);
  } finally {
    await host.close();
    await h.close();
  }
});

// ---------- Godot export templates: the export image ----------

test('3D export image: a Godot project exports to Linux (and the build runs) and to the Web, presets written on request', { skip: !hasExportImage && `no Docker or no ${IMAGE_EXPORT} (npm run sandbox:image:3d-export)`, timeout: 900_000 }, async () => {
  const root = await tempDir();
  const host = new DockerHost(`test-3d-export-${Date.now()}`, root, { ...dockerDefaults(), image: IMAGE_EXPORT, network: 'none' });
  const h = await harness();
  const godot = (input: Record<string, unknown>) => h.registry.tools.get('godot')!.run(input, ctxOf(host));
  try {
    const game = path.join(root, 'game');
    await fs.mkdir(game);
    await fs.writeFile(path.join(game, 'project.godot'), PROJECT);
    await fs.writeFile(path.join(game, 'main.tscn'), MAIN_TSCN);
    await fs.writeFile(path.join(game, 'main.gd'), MAIN_GD);

    let r = await godot({ action: 'export', project: 'game', preset: 'Linux', output: 'build/linux/demo.x86_64' });
    assert.equal(r.is_error, true);
    assert.match(r.content, /no preset named "Linux"\. game\/export_presets\.cfg does not exist/);

    r = await godot({ action: 'export', project: 'game', createPreset: 'linux', output: 'build/linux/demo.x86_64', timeoutSec: 600 });
    assert.ok(!r.is_error, r.content);
    assert.match(r.content, /godot export: Linux -> build\/linux\/demo\.x86_64 in [\d.]+s\.\nWrote a minimal Linux preset/);
    assert.match(r.content, /demo\.pck [\d.]+ MB, demo\.x86_64 [\d.]+ MB/);
    // The exported game runs (headless, on the release template) and gets its arguments.
    const played = await host.exec('./build/linux/demo.x86_64 --headless --quit-after 30 -- --hello', { timeoutMs: 120_000 });
    assert.equal(played.code, 0, played.stdout + played.stderr);
    assert.match(played.stdout, /ARGS \["--hello"\]/);

    r = await godot({ action: 'export', project: 'game', createPreset: 'web', timeoutSec: 600 });
    assert.ok(!r.is_error, r.content);
    assert.match(r.content, /godot export: Web -> build\/web\/index\.html .*\nWrote a minimal Web preset "Web"/);
    const web = await fs.readdir(path.join(root, 'build', 'web'));
    for (const f of ['index.html', 'index.js', 'index.wasm', 'index.pck']) assert.ok(web.includes(f), `${f} in ${web.join(', ')}`);
    assert.match(await fs.readFile(path.join(root, 'build', 'web', 'index.html'), 'utf8'), /index\.js/);
    const presets = E.presetsIn(await fs.readFile(path.join(game, 'export_presets.cfg'), 'utf8')) as { name: string; platform: string }[];
    assert.deepEqual(presets.map((p) => `${p.name}/${p.platform}`), ['Linux/Linux', 'Web/Web']);
  } finally {
    await host.close();
    await h.close();
  }
});
