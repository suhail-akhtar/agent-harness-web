import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { LocalHost } from '../src/runtime/host.ts';
import { tempDir } from './helpers.ts';

// Unity for real, behind HARNESS_REAL_UNITY=1 (each step runs the editor; the first open of a
// URP project takes minutes): a 3D URP project, a collect-and-escape level from a layout, a
// capture looked at, EditMode and PlayMode tests, a script, a Windows 64-bit build, 10 s of
// play with inputs and metrics, the AI player's step mode, and a 2D project with a tilemap
// level. Each step says why it is skipped: no HARNESS_REAL_UNITY, no editor, no licence.

// @ts-expect-error plain JS module
const D = await import('../plugins/engine-unity/detect.mjs');
// @ts-expect-error plain JS module
const U = await import('../plugins/engine-unity/unity.mjs');
// @ts-expect-error plain JS module
const DR = await import('../plugins/engine-unity/driver.mjs');
// @ts-expect-error plain JS module
const { pngStats } = await import('../plugins/games3d/lib-png.mjs');

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const REAL = process.env.HARNESS_REAL_UNITY === '1';
const found = REAL ? await D.discover({}) : null;
const skip: string | false = !REAL ? 'set HARNESS_REAL_UNITY=1 to run against a real Unity editor'
  : !found.editors.length ? (found.hub ? 'Unity Hub found, no editor installed: install one in Unity Hub (a 6000.x LTS)' : 'Unity is not installed')
    : found.license.status === 'not-activated' ? 'license not activated: add a licence in Unity Hub (Preferences > Licenses)'
      : false;
const win = process.platform === 'win32';
const MIN = 60_000;

let host: LocalHost;
const ready: Record<string, boolean> = {};
const signal = new AbortController().signal;
const call = async (input: Record<string, unknown>) => U.runUnity(input, { host, signal });
const needs = (step: string) => (skip || (ready[step] === false ? `the ${step} step did not pass` : false));

const LAYOUT = {
  name: 'Level1', dimension: '3d', cell: 2,
  grid: [
    '##########',
    '#C...E...#',
    '#..####..#',
    '#C......C#',
    '#...P....#',
    '##########',
  ],
  camera: { mode: 'follow' },
};

// Needs an editor but no licence: the editor's package cache has the Input System, the Test Framework
// and NUnit, and the 2D Sprite package is built in, so the bridge's optional parts (Input System
// injection, the test runner bridge, sprite sheet slicing) and the test assemblies project.create
// writes compile against them with the editor's own compiler.
const compileSkip: string | false = !REAL ? 'set HARNESS_REAL_UNITY=1 to run against a real Unity editor'
  : !found.editors.some((e: Any) => e.complete) ? 'no Unity editor installed' : false;

test('real Unity: the bridge\'s optional parts and the test assemblies compile against the editor\'s own packages (no licence needed)', { skip: compileSkip, timeout: 20 * MIN }, async () => {
  const { execFile } = await import('node:child_process');
  // @ts-expect-error plain JS module
  const { untar } = await import('../plugins/engine-unity/lib-archive.mjs');
  // @ts-expect-error plain JS module
  const P = await import('../plugins/engine-unity/project.mjs');
  const ed = found.editors.find((e: Any) => e.complete);
  const data = ed.dataDir;
  const cache = path.join(data, 'Resources', 'PackageManager', 'Editor');
  const names = await fs.readdir(cache).catch(() => [] as string[]);
  const tgz = (prefix: string) => names.find((n) => n.startsWith(`${prefix}-`) && n.endsWith('.tgz'));
  const want = { input: tgz('com.unity.inputsystem'), tf: tgz('com.unity.test-framework'), nunit: tgz('com.unity.ext.nunit') };
  if (Object.values(want).some((v) => !v)) { console.log(`# the editor's package cache lacks ${JSON.stringify(want)}; skipped`); return; }
  const out = await tempDir('unity-pkgs-');
  for (const [dir, file] of Object.entries(want)) {
    for (const e of untar(await fs.readFile(path.join(cache, file!)))) {
      if (e.type !== 'file' || e.name.includes('..')) continue;
      await fs.mkdir(path.dirname(path.join(out, dir, e.name)), { recursive: true });
      await fs.writeFile(path.join(out, dir, e.name), e.data);
    }
  }
  const exe = path.join(data, 'NetCoreRuntime', process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
  const csc = path.join(data, 'DotNetSdkRoslyn', 'csc.dll');
  const list = async (d: string) => (await fs.readdir(d).catch(() => [] as string[])).filter((f) => f.endsWith('.dll')).map((f) => path.join(d, f));
  const unity = [path.join(data, 'NetStandard', 'ref', '2.1.0', 'netstandard.dll'), ...await list(path.join(data, 'NetStandard', 'compat', '2.1.0', 'shims', 'netfx')), ...await list(path.join(data, 'Managed', 'UnityEngine'))];
  const years: string[] = [];
  for (let y = 2017; y <= 2023; y++) { years.push(`UNITY_${y}_OR_NEWER`); for (let m = 1; m <= 4; m++) years.push(`UNITY_${y}_${m}_OR_NEWER`); }
  const base = [...years, 'UNITY_6000_0_OR_NEWER', 'UNITY_EDITOR', 'UNITY_EDITOR_WIN', 'UNITY_STANDALONE_WIN', 'UNITY_STANDALONE', 'ENABLE_INPUT_SYSTEM', 'ENABLE_MONO', 'NET_STANDARD', 'UNITY_64'];
  const walk = async (d: string, skipDirs: string[] = []): Promise<string[]> => (await Promise.all((await fs.readdir(d, { withFileTypes: true })).map(async (e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) return e.name.endsWith('~') || skipDirs.includes(e.name) ? [] : walk(p, skipDirs);
    return e.name.endsWith('.cs') ? [p] : [];
  }))).flat();
  const compile = async (name: string, files: string[], refs: string[], defines: string[], unsafe = false) => {
    const rsp = path.join(out, `${name}.rsp`);
    const dll = path.join(out, `${name}.dll`);
    await fs.writeFile(rsp, ['-target:library', '-nostdlib+', '-langversion:9.0', '-nologo', '-nowarn:1591,0618,0649,0169,0414,0067', ...(unsafe ? ['-unsafe+'] : []), `-define:${[...base, ...defines].join(';')}`, `-out:"${dll}"`, ...[...unity, ...refs].map((r) => `-r:"${r}"`), ...files.map((f) => `"${f}"`)].join('\n'));
    const r = await new Promise<{ code: number; text: string }>((resolve) => execFile(exe, [csc, `@${rsp}`], { maxBuffer: 1 << 26 }, (err, so, se) => resolve({ code: err ? 1 : 0, text: `${so}${se}` })));
    assert.equal(r.code, 0, `${name} does not compile:\n${r.text.split('\n').filter((l) => /error/.test(l)).slice(0, 20).join('\n')}`);
    return dll;
  };
  const findFile = async (d: string, name: string): Promise<string | undefined> => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const hit = e.isDirectory() ? await findFile(p, name) : e.name === name ? p : undefined;
      if (hit) return hit;
    }
    return undefined;
  };
  const nunit = (await findFile(path.join(out, 'nunit'), 'nunit.framework.dll'))!;
  assert.ok(nunit, 'the NUnit package has nunit.framework.dll');
  const input = await compile('Unity.InputSystem', await walk(path.join(out, 'input', 'package', 'InputSystem'), ['InputForUI']), [], ['HAS_SET_LOCAL_POSITION_AND_ROTATION', 'UNITY_INPUT_SYSTEM_PROJECT_WIDE_ACTIONS', 'UNITY_INPUT_SYSTEM_ENABLE_PHYSICS', 'UNITY_INPUT_SYSTEM_ENABLE_PHYSICS2D'], true);
  const tfe = await compile('UnityEngine.TestRunner', await walk(path.join(out, 'tf', 'package', 'UnityEngine.TestRunner')), [nunit], ['UNITY_INCLUDE_TESTS']);
  const tfed = await compile('UnityEditor.TestRunner', await walk(path.join(out, 'tf', 'package', 'UnityEditor.TestRunner')), [nunit, tfe], ['UNITY_INCLUDE_TESTS']);
  const pkg = P.PACKAGE_DIR;
  const rt = await compile('Harness.Bridge', await walk(path.join(pkg, 'Runtime')), [input], ['HARNESS_INPUT_SYSTEM']);
  const rtLegacy = await compile('Harness.Bridge.Both', await walk(path.join(pkg, 'Runtime')), [input], ['HARNESS_INPUT_SYSTEM', 'ENABLE_LEGACY_INPUT_MANAGER']);
  void rtLegacy;
  const sprite = await compile('Unity.2D.Sprite.Editor', await walk(path.join(data, 'Resources', 'PackageManager', 'BuiltInPackages', 'com.unity.2d.sprite', 'Editor')), [], [], true);
  const edAsm = await compile('Harness.Bridge.Editor', await walk(path.join(pkg, 'Editor'), ['Tests', 'Recorder']), [rt, sprite], ['HARNESS_2D_SPRITE']);
  await compile('Harness.Bridge.Editor.Tests', await walk(path.join(pkg, 'Editor', 'Tests')), [rt, edAsm, nunit, tfe, tfed], ['HARNESS_TEST_FRAMEWORK']);
  const scaffold = P.testScaffold('Coin Escape').filter((f: Any) => f.rel.endsWith('.cs'));
  for (const f of scaffold) await fs.writeFile(path.join(out, path.basename(f.rel)), f.data);
  await compile('Tests.EditMode', [path.join(out, 'ProjectTests.cs')], [rt, nunit, tfe, tfed], ['UNITY_INCLUDE_TESTS']);
  await compile('Tests.PlayMode', [path.join(out, 'PlayTests.cs')], [rt, nunit, tfe], ['UNITY_INCLUDE_TESTS']);
});

test('real Unity: detect finds the editor, its modules and the licence', { skip }, async () => {
  host = new LocalHost(await tempDir('unity-real-'));
  const { r } = await call({ action: 'detect' });
  assert.equal(r.status, 'ok');
  assert.equal(r.data.installed, true, r.summary);
  console.log(`# ${r.summary}`);
});

test('real Unity: a 3D URP project from the editor\'s template, opened and set up headless', { skip, timeout: 60 * MIN }, async () => {
  ready.create = false;
  const { r } = await call({ action: 'project.create', project: 'Game', template: '3d-urp', name: 'Coin Escape', genre: 'collect-and-escape' });
  assert.equal(r.status, 'ok', `${r.summary}\n${r.log ?? ''}`);
  const version = await fs.readFile(path.join(host.root, 'Game/ProjectSettings/ProjectVersion.txt'), 'utf8');
  assert.match(version, /m_EditorVersion: \d+\.\d+\.\d+/);
  assert.equal(JSON.parse(await fs.readFile(path.join(host.root, '.studio/project.json'), 'utf8')).engine, 'unity');
  const open = await call({ action: 'project.open', live: false });
  assert.equal(open.r.status, 'ok', open.r.summary);
  ready.create = true;
});

test('real Unity: a collect-and-escape level from a layout, captured and looked at', { skip: needs('create'), timeout: 30 * MIN }, async () => {
  ready.level = false;
  const { r, images } = await call({ action: 'level.build', layout: LAYOUT, live: false, width: 800, height: 450 });
  assert.equal(r.status, 'ok', `${r.summary}\n${r.log ?? ''}`);
  assert.equal(r.data.counts.player, 1);
  assert.equal(r.data.counts.collectible, 4);
  assert.equal(images.length, 1);
  const stats = pngStats(Buffer.from(images[0].data, 'base64'));
  assert.equal(stats.width, 800);
  assert.equal(stats.blank, false, 'the level capture shows something');
  const over = await call({ action: 'capture', scene: 'Assets/Scenes/Level1.unity', view: 'overview', live: false });
  assert.equal(over.r.status, 'ok', over.r.summary);
  assert.equal(pngStats(Buffer.from(over.images[0].data, 'base64')).blank, false, 'the overview shows the level');
  ready.level = true;
});

test('real Unity: a script runs headless and reads the level', { skip: needs('level'), timeout: 20 * MIN }, async () => {
  const { r } = await call({
    action: 'script', name: 'CountCoins', live: false,
    code: 'EditorSceneManager.OpenScene("Assets/Scenes/Level1.unity");\nreturn Object.FindObjectsByType<Harness.Bridge.HarnessCollectible>(FindObjectsInactive.Include, FindObjectsSortMode.None).Length;',
  });
  assert.equal(r.status, 'ok', `${r.summary}\n${r.log ?? ''}`);
  assert.equal(r.data.value, 4);
});

test('real Unity: EditMode and PlayMode tests run and pass', { skip: needs('level'), timeout: 40 * MIN }, async () => {
  const { r } = await call({ action: 'test', platform: 'both', live: false });
  assert.equal(r.status, 'ok', `${r.summary}\n${JSON.stringify(r.problems)}`);
  assert.ok(r.metrics.total >= 4, r.summary);
  assert.equal(r.metrics.failed, 0);
});

test('real Unity: headless play mode with an input timeline: frames, metrics, the player moved', { skip: needs('level'), timeout: 30 * MIN }, async () => {
  const { r, images } = await call({ action: 'play', mode: 'batch', seconds: 5, scene: 'Assets/Scenes/Level1.unity', inputs: [{ t: 0.5, key: 'W', press: 1.5 }], record: false });
  assert.notEqual(r.status, 'unavailable', r.summary);
  assert.ok(images.length >= 2, r.summary);
  assert.ok(r.data.state.player, 'the rules publish the player position');
  assert.ok(r.data.events.some((e: Any) => e.type === 'level-start'));
});

test('real Unity: a Windows 64-bit build', { skip: skip || (!win && 'Windows builds are checked on Windows') || needs('level'), timeout: 60 * MIN }, async () => {
  ready.build = false;
  const { r } = await call({ action: 'build', target: 'win64', live: false });
  assert.equal(r.status, 'ok', `${r.summary}\n${JSON.stringify(r.problems)}\n${r.log ?? ''}`);
  await fs.access(path.join(host.root, 'Game/Builds/win64/Coin Escape.exe'));
  assert.ok(r.metrics.sizeMb > 1);
  ready.build = true;
});

test('real Unity: the built player plays 10 s with inputs; frames and metrics come back', { skip: skip || (!win && 'needs the Windows build') || needs('build'), timeout: 15 * MIN }, async () => {
  const { r, images } = await call({
    action: 'play', mode: 'player', seconds: 10, goal: 'move and pick up a coin',
    inputs: [{ t: 0.5, key: 'W', press: 1.2 }, { t: 2, key: 'A', press: 1.5 }, { t: 4, key: 'Space', press: 0.1 }, { t: 5, key: 'D', press: 2 }],
  });
  assert.equal(r.status, 'ok', `${r.summary}\n${JSON.stringify(r.problems)}`);
  assert.ok(images.length >= 3, r.summary);
  assert.ok(r.metrics.fpsAvg > 5, `fps ${r.metrics.fpsAvg}`);
  assert.ok(r.metrics.memoryMb > 0);
  assert.equal(r.metrics.errors, 0);
  const jumps = r.data.events.filter((e: Any) => e.type === 'jump').length;
  assert.ok(jumps >= 1, 'the Space press reached the player');
  assert.ok(r.data.playtest, 'a Studio playtest was written');
  console.log(`# ${r.summary}`);
});

test('real Unity: the AI player steps the built player: inputs in, frame and state out', { skip: skip || (!win && 'needs the Windows build') || needs('build'), timeout: 10 * MIN }, async () => {
  const d = DR.createDriver(host, { project: 'Game', mode: 'player', width: 640, height: 360 });
  try {
    const first = await d.start();
    assert.ok(first.frame && first.frame.length > 1000);
    const z0 = first.state.player?.[2];
    let o = first;
    for (let i = 0; i < 4; i++) o = await d.step({ keys: ['W'], frames: 15 });
    assert.equal(pngStats(o.frame).blank, false);
    assert.ok(o.state.player[2] > z0 + 0.3, `the player moved forward (${z0} -> ${o.state.player[2]})`);
  } finally { await d.stop(); }
});

test('real Unity: a 2D project with a tilemap level from a layout', { skip: needs('create'), timeout: 60 * MIN }, async () => {
  const made = await call({ action: 'project.create', project: 'Game2D', template: '2d-urp', name: 'Pixel Run', studio: 'studio2d' });
  assert.equal(made.r.status, 'ok', made.r.summary);
  const { r, images } = await call({
    action: 'level.build', project: 'Game2D', live: false,
    layout: { name: 'Level2D', dimension: '2d', grid: ['####################', '#..................#', '#.....C.....C....E.#', '#...======...===...#', '#P.................#', '####################'] },
  });
  assert.equal(r.status, 'ok', `${r.summary}\n${r.log ?? ''}`);
  assert.equal(pngStats(Buffer.from(images[0].data, 'base64')).blank, false);
});
