import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHarness, shippedPlugins } from '@harness/plugin-sdk/testing';
import type { ExecOptions, ExecResult, ToolHost } from '@harness/plugin-sdk/testing';
import { skillsIn } from '@harness/plugin-sdk/testing';
import { validateUiManifest } from '@harness/plugin-sdk/testing';
import { pngBytes, tempDir, testPicture } from '@harness/plugin-sdk/testing';

// The Unity engine plugin, with fakes: Hub output, editor folders, the editor itself (a
// stand-in that answers the batch command lines by writing logs and results), and the live
// bridge (a fake server speaking its protocol). test/engine-unity-real.test.ts runs a real
// editor behind HARNESS_REAL_UNITY=1.

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// @ts-expect-error plain JS module
const L = await import('../lib-unity.mjs');
// @ts-expect-error plain JS module
const A = await import('../lib-archive.mjs');
// @ts-expect-error plain JS module
const P = await import('../project.mjs');
// @ts-expect-error plain JS module
const D = await import('../detect.mjs');
// @ts-expect-error plain JS module
const B = await import('../bridge.mjs');
// @ts-expect-error plain JS module
const U = await import('../unity.mjs');
// @ts-expect-error plain JS module
const DR = await import('../driver.mjs');

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const signal = new AbortController().signal;
const W = path.win32;

// ---------- the plugin ----------

test('engine-unity registers the unity tool, its gates, skills and agent; the ui block is valid', async () => {
  const h = await createHarness({ dataDir: await tempDir(), plugins: shippedPlugins() });
  try {
    assert.ok(h.registry.tools.has('unity'));
    for (const g of ['unity-project', 'unity-tests', 'unity-build']) assert.ok(h.registry.gates.has(g), g);
    const skills = await skillsIn(path.join(pluginDir, 'skills'), 'engine-unity');
    const names = skills.map((s: { name: string }) => s.name).sort();
    assert.deepEqual(names, ['unity-2d', 'unity-build-test', 'unity-csharp', 'unity-essentials']);
    const agent = h.registry.agents.get('unity-engineer');
    assert.ok(agent);
    assert.match(agent!.prompt, /unity-essentials/);
    const tool = h.registry.tools.get('unity')!;
    assert.deepEqual(tool.kindsFor!({ action: 'detect' }), ['read']);
    assert.deepEqual(tool.kindsFor!({ action: 'build' }), ['exec']);
    assert.equal(await tool.availableIn!({ kind: 'docker' } as ToolHost), false);
  } finally { await h.close(); }
  const manifest = JSON.parse(await fs.readFile(path.join(pluginDir, 'harness-plugin.json'), 'utf8'));
  const ui = validateUiManifest(manifest.ui);
  assert.equal(ui.displayName, 'Unity');
  assert.equal(ui.icon, 'box');
  assert.equal(ui.category, 'Studio');
  assert.equal(ui.guide, 'GUIDE.md');
  assert.match(await fs.readFile(path.join(pluginDir, 'GUIDE.md'), 'utf8'), /^---\nname: engine-unity-guide\ndescription: /);
});

// ---------- the Hub and the editors ----------

test('Hub output: installed editors (Windows, Apple silicon), releases, the install path and located editors', () => {
  const out = [
    '6000.0.39f1 , installed at E:\\UnityHub\\Unity Hub\\Editor\\6000.0.39f1\\Editor\\Unity.exe',
    '2022.3.10f1 (Apple silicon) , installed at /Applications/Unity/Hub/Editor/2022.3.10f1-arm64/Unity.app',
    'some noise line', '',
  ].join('\r\n');
  assert.deepEqual(L.parseHubEditors(out), [
    { version: '6000.0.39f1', arch: undefined, path: 'E:\\UnityHub\\Unity Hub\\Editor\\6000.0.39f1\\Editor\\Unity.exe', source: 'hub' },
    { version: '2022.3.10f1', arch: 'Apple silicon', path: '/Applications/Unity/Hub/Editor/2022.3.10f1-arm64/Unity.app/Contents/MacOS/Unity', source: 'hub' },
  ]);
  assert.deepEqual(L.parseHubEditors(''), []);
  assert.deepEqual(L.parseHubReleases('6000.2.6f2\n6000.0.58f2 (Apple silicon)\n6000.0.39f1 , installed at X'), ['6000.2.6f2', '6000.0.58f2']);
  assert.equal(L.parseSecondaryInstallPath('"D:\\\\Unity"'), 'D:\\Unity');
  assert.equal(L.parseSecondaryInstallPath('""'), null);
  assert.equal(L.parseSecondaryInstallPath('not json'), null);
  assert.deepEqual(L.parseHubEditorsJson(JSON.stringify({ schema_version: 'v2', data: [{ version: '6000.1.2f1', location: ['C:\\U\\Editor\\Unity.exe'], manual: true }] })), [{ version: '6000.1.2f1', path: 'C:\\U\\Editor\\Unity.exe', source: 'hub-located' }]);
  assert.deepEqual(L.parseHubEditorsJson(JSON.stringify({ '2021.3.1f1': { version: '2021.3.1f1', location: 'D:/Unity/2021/Editor/Unity.exe' } })), [{ version: '2021.3.1f1', path: 'D:/Unity/2021/Editor/Unity.exe', source: 'hub-located' }]);
});

test('versions: Unity 6 finals first, the project\'s own version when it is there', () => {
  const eds = [{ version: '2022.3.40f1' }, { version: '6000.1.0b3' }, { version: '6000.0.39f1' }, { version: '6000.0.58f2' }];
  assert.deepEqual([...eds].sort((a, b) => L.compareVersions(a.version, b.version)).map((e) => e.version), ['6000.1.0b3', '6000.0.58f2', '6000.0.39f1', '2022.3.40f1']);
  assert.equal(L.pickEditor(eds).editor.version, '6000.0.58f2');
  assert.deepEqual(L.pickEditor(eds, '6000.0.39f1'), { editor: { version: '6000.0.39f1' }, exact: true });
  assert.equal(L.pickEditor(eds, '6000.3.1f1').exact, false);
  assert.equal(L.pickEditor([]).editor, null);
  assert.equal(L.projectVersion('m_EditorVersion: 6000.0.39f1\nm_EditorVersionWithRevision: 6000.0.39f1 (15ea7ed0b100)\n'), '6000.0.39f1');
  assert.equal(L.versionFromPath('C:/Program Files/Unity/Hub/Editor/6000.0.39f1/Editor/Unity.exe'), '6000.0.39f1');
  assert.equal(L.isUnity6('6000.2.1f1'), true);
  assert.equal(L.isUnity6('2022.3.1f1'), false);
});

/** A file system from a list of files and folders (Windows paths). */
function fakeFs(files: Record<string, string>, dirs: Record<string, string[]>) {
  return {
    exists: async (p: string) => p in files || p in dirs,
    readText: async (p: string) => files[p] ?? null,
    readdir: async (p: string) => dirs[p] ?? [],
  };
}

const APPDATA = 'C:\\Users\\me\\AppData\\Roaming';
const LOCAL = 'C:\\Users\\me\\AppData\\Local';
const winEnv = { APPDATA, LOCALAPPDATA: LOCAL, ProgramFiles: 'C:\\Program Files', ProgramData: 'C:\\ProgramData' };
const HUB = 'E:\\UnityHub\\Unity Hub\\Unity Hub.exe';
const ED_ROOT = 'E:\\UnityHub\\Unity Hub\\Editor';
const EXE = W.join(ED_ROOT, '6000.0.39f1', 'Editor', 'Unity.exe');
const DATA = W.join(ED_ROOT, '6000.0.39f1', 'Editor', 'Data');

function machine({ editor = true, license = false, hubLists = false } = {}) {
  const files: Record<string, string> = {
    [W.join(APPDATA, 'UnityHub', 'hubInfo.json')]: JSON.stringify({ version: '3.11.1', executablePath: HUB }),
    [W.join(APPDATA, 'UnityHub', 'secondaryInstallPath.json')]: '""',
    [HUB]: '',
  };
  const dirs: Record<string, string[]> = {};
  if (editor) {
    files[EXE] = '';
    dirs[ED_ROOT] = ['6000.0.39f1', 'not-a-version'];
    dirs[W.join(DATA, 'PlaybackEngines')] = ['windowsstandalonesupport', 'WebGLSupport'];
    dirs[W.join(DATA, 'PlaybackEngines', 'windowsstandalonesupport', 'Variations')] = ['win64_player_development_mono', 'win64_player_nondevelopment_il2cpp'];
    dirs[W.join(DATA, 'Resources', 'PackageManager', 'ProjectTemplates')] = ['com.unity.template.3d-cross-platform-17.0.11.tgz', 'libcache'];
    dirs[W.join(DATA, 'Managed')] = ['UnityEngine.dll'];
  }
  if (license) dirs[W.join(LOCAL, 'Unity', 'licenses')] = ['UnityEntitlementLicense.xml'];
  const hubList = async () => (hubLists && editor ? `6000.0.39f1 , installed at ${EXE}\n` : '');
  return { platform: 'win32', env: winEnv, fs: fakeFs(files, dirs), hubList };
}

test('discovery: the Hub from its settings, an editor beside it, modules, IL2CPP, templates, the licence and the gaps', async () => {
  const d = await D.discover(machine());
  assert.equal(d.hub.path, HUB);
  assert.equal(d.hub.version, '3.11.1');
  assert.equal(d.hub.answered, true);
  assert.equal(d.editors.length, 1);
  const e = d.editors[0];
  assert.equal(e.version, '6000.0.39f1');
  assert.equal(e.path, EXE);
  assert.deepEqual(e.modules, ['webgl', 'windows']);
  assert.equal(e.il2cpp, true);
  assert.deepEqual(e.templates, ['com.unity.template.3d-cross-platform-17.0.11.tgz']);
  assert.equal(e.complete, true);
  assert.equal(e.registered, false);
  assert.equal(d.license.status, 'not-activated');
  assert.deepEqual(d.gaps.map((g: string) => g.split(':')[0]), ['license not activated']);
  assert.ok(d.notes.some((n: string) => /does not list the editor/.test(n)), 'an editor the Hub does not know is said');

  const listed = await D.discover(machine({ license: true, hubLists: true }));
  assert.equal(listed.license.status, 'activated');
  assert.deepEqual(listed.gaps, []);
  assert.deepEqual(listed.editors[0].sources, ['hub', 'folder']);
  assert.equal(listed.editors[0].registered, true);

  const none = await D.discover(machine({ editor: false }));
  assert.equal(none.editors.length, 0);
  assert.match(none.gaps[0], /^Unity Hub found, no editor installed: install one in Unity Hub \(a 6000\.x LTS\)/);
  assert.ok(!none.gaps.some((g: string) => /license/.test(g)), 'no licence gap before there is an editor');

  const nothing = await D.discover({ platform: 'win32', env: winEnv, fs: fakeFs({}, {}), hubList: async () => '' });
  assert.equal(nothing.hub, null);
  assert.match(nothing.gaps[0], /^Unity is not installed: install Unity Hub/);
});

test('discovery: HARNESS_UNITY_EDITOR, missing modules and an older editor are gaps; macOS paths', async () => {
  const m = machine({ license: true });
  const custom = 'D:\\Engines\\2022.3.40f1\\Editor\\Unity.exe';
  const files = { ...((m.fs as Any).files ?? {}) };
  void files;
  const fsx = fakeFs({ [custom]: '', [W.join(APPDATA, 'UnityHub', 'hubInfo.json')]: 'null' }, { [W.join(LOCAL, 'Unity', 'licenses')]: ['x.xml'] });
  const d = await D.discover({ platform: 'win32', env: { ...winEnv, HARNESS_UNITY_EDITOR: custom }, fs: fsx, hubList: async () => null });
  assert.equal(d.editors[0].path, custom);
  assert.deepEqual(d.editors[0].sources, ['HARNESS_UNITY_EDITOR']);
  assert.ok(d.gaps.some((g: string) => /older|written for Unity 6/.test(g)));
  assert.ok(d.gaps.some((g: string) => /no Windows Build Support/.test(g)));
  assert.ok(d.gaps.some((g: string) => /no WebGL Build Support/.test(g)));
  assert.ok(d.gaps.some((g: string) => /incomplete/.test(g)));

  const mac = '/Applications/Unity/Hub/Editor/6000.0.39f1/Unity.app/Contents/MacOS/Unity';
  const md = await D.discover({
    platform: 'darwin', env: { HOME: '/Users/me' },
    fs: fakeFs({ [mac]: '', '/Applications/Unity Hub.app/Contents/MacOS/Unity Hub': '' }, { '/Applications/Unity/Hub/Editor': ['6000.0.39f1'], '/Applications/Unity/Hub/Editor/6000.0.39f1/Unity.app/Contents/PlaybackEngines': ['MacStandaloneSupport', 'WebGLSupport'], '/Applications/Unity/Hub/Editor/6000.0.39f1/Unity.app/Contents/Managed': ['x'] }),
    hubList: async () => '',
  });
  assert.equal(md.editors[0].path, mac);
  assert.deepEqual(md.editors[0].modules, ['mac', 'webgl']);
  assert.deepEqual(L.licensePlaces('darwin', { HOME: '/Users/me' }).dirs, ['/Users/me/Library/Unity/licenses']);
});

test('the companion probe: one script per batch of paths, its output read back as a file system', async () => {
  const ps = D.probeScript(['C:\\a b\\x.exe'], ['C:\\dir'], ['C:\\t.json'], 'powershell');
  assert.match(ps, /Test-Path -LiteralPath \$p/);
  assert.match(ps, /'C:\\a b\\x\.exe'/);
  const sh = D.probeScript(['/opt/u/Unity'], ['/opt'], ['/t.json'], 'bash');
  assert.match(sh, /for p in \/opt\/u\/Unity; do/);
  const f = D.probeFs(`EXISTS C:\\x.exe\r\nDIR C:\\Editor|6000.0.39f1/2022.3.1f1/\nTEXT C:\\t.json|${Buffer.from('{"a":1}').toString('base64')}\n`);
  assert.equal(await f.exists('C:\\x.exe'), true);
  assert.equal(await f.exists('C:\\nope'), false);
  assert.deepEqual(await f.readdir('C:\\Editor'), ['6000.0.39f1', '2022.3.1f1']);
  assert.equal(await f.readText('C:\\t.json'), '{"a":1}');
});

// ---------- command lines ----------

test('command lines: batch entry points (no -quit), tests, new projects, players, build targets', () => {
  assert.deepEqual(L.executeArgs({ project: 'C:/w/Game', log: 'C:/w/l.log', method: 'Build', argsFile: 'a.json', resultFile: 'r.json', buildTarget: 'Win64' }),
    ['-batchmode', '-projectPath', 'C:/w/Game', '-logFile', 'C:/w/l.log', '-buildTarget', 'Win64', '-executeMethod', 'Harness.Bridge.Batch.Build', '-harnessArgs', 'a.json', '-harnessResult', 'r.json']);
  assert.equal(L.executeArgs({ project: 'p', log: 'l', method: 'My.Tools.Run', argsFile: 'a', resultFile: 'r' })[6], 'My.Tools.Run');
  const t = L.testArgs({ project: 'p', log: 'l', platform: 'PlayMode', results: 'r.xml', filter: 'LevelTests' });
  assert.ok(!t.includes('-quit'), 'the test runner exits by itself; -quit would stop it');
  assert.deepEqual(t.slice(-7), ['-runTests', '-testPlatform', 'PlayMode', '-testResults', 'r.xml', '-testFilter', 'LevelTests']);
  assert.deepEqual(L.createArgs({ project: 'p', log: 'l' }), ['-batchmode', '-quit', '-createProject', 'p', '-logFile', 'l']);
  assert.deepEqual(L.openArgs({ project: 'p', log: 'l' }), ['-batchmode', '-quit', '-projectPath', 'p', '-logFile', 'l']);
  assert.deepEqual(L.playerArgs({ log: 'l', playFile: 'p.json', width: 640, height: 360 }), ['-logFile', 'l', '-screen-fullscreen', '0', '-screen-width', '640', '-screen-height', '360', '-harnessPlay', 'p.json']);
  assert.equal(L.buildTarget('win64').target, 'StandaloneWindows64');
  assert.equal(L.buildTarget('Win 64').file('Coin Escape'), 'Coin Escape.exe');
  assert.equal(L.buildTarget('webgl').target, 'WebGL');
  assert.equal(L.buildTarget('web').module, 'webgl');
  assert.equal(L.buildTarget('ps5'), null);
});

// ---------- logs ----------

const LICENSE_LOG = `[Licensing::Module] Trying to connect to existing licensing client channel...
[Licensing::Module] Successfully launched the LicensingClient (PId: 1234)
[Licensing::Module] Error: Access token is unavailable; failed to update
[Licensing::Client] Error: Code 500 while processing request (status: Unable to update licenses. Errors: No ULF license found.,Token not found in cache)
[Licensing::Module] Error: 'com.unity.editor.headless' was not found.
No valid Unity Editor license found. Please activate your license.
`;

test('logs: compile errors with file, line and column; the licence; a locked project; exceptions; the result marker', () => {
  const log = [
    'Assets/Scripts/Player.cs(12,5): error CS1002: ; expected',
    'Assets/Scripts/Player.cs(12,5): error CS1002: ; expected',
    'Assets\\Editor\\Tool.cs(3,1): warning CS0168: The variable \'x\' is declared but never used',
    'Scripts have compiler errors.',
    'NullReferenceException: Object reference not set to an instance of an object',
    '  at Game.Spawner.Start () [0x00012] in C:\\w\\Game\\Assets\\Scripts\\Spawner.cs:23 ',
    'HARNESS_RESULT {"ok":false,"error":"x"}',
  ].join('\r\n');
  const cm = L.compileMessages(log);
  assert.equal(cm.length, 2, 'repeated lines are one problem');
  assert.deepEqual(cm[0], { severity: 'error', code: 'CS1002', message: 'CS1002: ; expected', file: 'Assets/Scripts/Player.cs', line: 12, column: 5 });
  assert.equal(cm[1].file, 'Assets/Editor/Tool.cs');
  const { problems, kinds } = L.logProblems(log);
  assert.deepEqual(kinds, ['compile']);
  assert.equal(problems.filter((p: Any) => p.severity === 'error' && p.code).length, 1, 'warnings are left out unless asked');
  assert.ok(problems.some((p: Any) => p.message.startsWith('NullReferenceException') && p.file === 'Assets/Scripts/Spawner.cs' && p.line === 23));
  assert.deepEqual(L.markerResult(log), { ok: false, error: 'x' });
  assert.equal(L.markerResult('nothing'), null);

  const lic = L.logProblems(LICENSE_LOG);
  assert.deepEqual(lic.kinds, ['license']);
  assert.match(lic.problems[0].message, /^license not activated/);
  assert.deepEqual(L.logProblems('It looks like another Unity instance is running with this project open.').kinds, ['locked']);
  assert.deepEqual(L.logProblems('executeMethod class \'Harness.Bridge.Batch\' could not be found.').kinds, ['method']);
  assert.deepEqual(L.logProblems('Error building Player: Currently selected scripting backend (IL2CPP) is not installed.').kinds.sort(), ['build', 'module']);
});

const RESULTS_XML = `<?xml version="1.0" encoding="utf-8"?>
<test-run id="2" testcasecount="3" result="Failed(Child)" total="3" passed="1" failed="1" inconclusive="0" skipped="1" asserts="0" engine-version="3.5.0.0" clr-version="4.0.30319.42000" start-time="2026-10-23 10:00:00Z" end-time="2026-10-23 10:00:02Z" duration="1.84">
  <test-suite type="TestSuite" id="1000" name="Game" fullname="Game" runstate="Runnable" testcasecount="3" result="Failed" total="3" passed="1" failed="1" skipped="1">
    <test-suite type="Assembly" id="1001" name="Game.Tests.PlayMode.dll" fullname="C:/w/Game/Library/ScriptAssemblies/Game.Tests.PlayMode.dll" result="Failed">
      <test-suite type="TestFixture" id="1002" name="PlayTests" fullname="Game.Tests.PlayTests" classname="Game.Tests.PlayTests" result="Failed">
        <test-case id="1003" name="FramesAdvance" fullname="Game.Tests.PlayTests.FramesAdvance" methodname="FramesAdvance" classname="Game.Tests.PlayTests" result="Passed" duration="0.031" />
        <test-case id="1004" name="PlayerReachesExit" fullname="Game.Tests.PlayTests.PlayerReachesExit" methodname="PlayerReachesExit" classname="Game.Tests.PlayTests" result="Failed" duration="1.2">
          <failure>
            <message><![CDATA[  Expected: True
  But was:  False
the exit stayed closed & locked]]></message>
            <stack-trace><![CDATA[at Game.Tests.PlayTests+<PlayerReachesExit>d__2.MoveNext () [0x000a1] in C:\\w\\Game\\Assets\\Tests\\PlayMode\\PlayTests.cs:41
at UnityEngine.TestTools.TestEnumerator+<Execute>d__6.MoveNext () [0x0003a] in .\\Library\\PackageCache\\com.unity.test-framework\\UnityEngine.TestRunner\\NUnitExtensions\\Attributes\\TestEnumerator.cs:36]]></stack-trace>
          </failure>
          <output><![CDATA[spawned 3 coins]]></output>
        </test-case>
        <test-case id="1005" name="Later" fullname="Game.Tests.PlayTests.Later" result="Skipped" label="Ignored" duration="0"><reason><message><![CDATA[not yet]]></message></reason></test-case>
      </test-suite>
    </test-suite>
  </test-suite>
</test-run>`;

test('test results: counts, the duration, each failure with its message and the project file and line', () => {
  const r = L.parseTestResults(RESULTS_XML);
  assert.equal(r.result, 'Failed(Child)');
  assert.deepEqual([r.total, r.passed, r.failed, r.skipped, r.durationS], [3, 1, 1, 1, 1.84]);
  assert.equal(r.cases.length, 3);
  assert.equal(r.failures.length, 1);
  assert.equal(r.failures[0].name, 'Game.Tests.PlayTests.PlayerReachesExit');
  assert.match(r.failures[0].message, /Expected: True[\s\S]*closed & locked/);
  assert.equal(r.failures[0].file, 'Assets/Tests/PlayMode/PlayTests.cs');
  assert.equal(r.failures[0].line, 41);
  assert.equal(r.cases[1].output, 'spawned 3 coins');
  assert.equal(r.cases[2].message, 'not yet');
  assert.throws(() => L.parseTestResults('<nope/>'), /not an NUnit/);
  const x = L.parseXml('<a k="1 &amp; 2"><b>t&lt;x&gt;</b><!-- c --><c/></a>');
  assert.equal(x.children[0].attrs.k, '1 & 2');
  assert.equal(x.children[0].children[0].text, 't<x>');
  assert.equal(x.children[0].children.length, 2);
});

test('build reports: success with size and time, failure with the step\'s compile error', () => {
  const ok = L.parseBuildReport({ result: 'Succeeded', totalSize: 52428800, totalTimeS: 61.37, totalErrors: 0, totalWarnings: 2, outputPath: 'C:/w/Builds/win64/Game.exe', steps: [{ name: 'Build player', durationS: 50, messages: [{ type: 'Warning', content: 'Shader warning' }] }] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.metrics, { sizeMb: 50, buildS: 61.4, errors: 0, warnings: 2 });
  assert.equal(ok.problems[0].severity, 'warning');
  const bad = L.parseBuildReport({ result: 'Failed', steps: [{ name: 'Compile scripts', messages: [{ type: 'Error', content: 'Assets/Scripts/EditorThing.cs(3,7): error CS0246: The type or namespace name \'UnityEditor\' could not be found' }] }] });
  assert.equal(bad.ok, false);
  assert.equal(bad.problems[0].file, 'Assets/Scripts/EditorThing.cs');
  assert.equal(bad.problems[0].line, 3);
  assert.equal(L.parseBuildReport(null).ok, false);
  assert.match(L.parseBuildReport({ result: 'Failed', error: 'no scenes' }).problems[0].message, /no scenes/);
  assert.equal(L.buildResultFromLog('Build Finished, Result: Success.'), 'Succeeded');
  assert.equal(L.buildResultFromLog("Build completed with a result of 'Failed' in 3 seconds"), 'Failed');
});

// ---------- inputs, layouts, scripts ----------

test('input timelines: keys pressed for a time, held, released, axes; key names as KeyCodes', () => {
  const t = L.normalizeInputs([
    { t: 1, key: 'space', press: 0.2 },
    { t: 0, keys: ['w', 'left'], duration: 2 },
    { t: 3, axis: 'Horizontal', value: 4 },
    { t: 4, key: 'D', up: true },
    { t: 99, key: 'W', down: true },
    { t: 2, key: '!!' },
  ], 10);
  assert.deepEqual(t.map((e: Any) => [e.t, e.type, e.key ?? e.axis, e.down ?? e.value]), [
    [0, 'key', 'W', true], [0, 'key', 'LeftArrow', true], [1, 'key', 'Space', true], [1.2, 'key', 'Space', false],
    [2, 'key', 'W', false], [2, 'key', 'LeftArrow', false], [3, 'axis', 'Horizontal', 1], [4, 'key', 'D', false],
  ]);
  assert.equal(L.keyName('1'), 'Alpha1');
  assert.equal(L.keyName('UpArrow'), 'UpArrow');
  assert.equal(L.keyName('arrowdown'), 'DownArrow');
  assert.equal(L.keyName('enter'), 'Return');
  assert.equal(L.keyName('LeftShift'), 'LeftShift');
});

test('layouts: defaults per dimension, legend checks, one player, object checks', () => {
  const ok = L.validateLayout({ name: 'Level 1!', dimension: '2.5d', grid: ['#####', '#P.C#', '#..E#', '#####'] });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.layout.name, 'Level 1');
  assert.equal(ok.layout.scene, 'Assets/Scenes/Level1.unity');
  assert.equal(ok.layout.camera.mode, 'isometric');
  assert.equal(ok.counts.player, 1);
  assert.equal(ok.counts.collectible, 1);
  assert.equal(L.validateLayout({ dimension: '2d', grid: ['P'] }).layout.camera.mode, 'orthographic');
  assert.equal(L.validateLayout({ grid: ['P'] }).layout.camera.mode, 'follow');
  const bad = L.validateLayout({ dimension: '4d', grid: ['#X#', '#..'], objects: [{ type: 'player', position: [1] }, { type: 'prefab', prefab: 'Door' }, { type: 'nope' }, { type: 'wall', color: 'red' }] });
  const text = bad.errors.join('\n');
  for (const re of [/dimension must be/, /"X" is not in the legend/, /position is \[x, y\]/, /prefab is a path/, /type must be one of/, /color is #rrggbb/]) assert.match(text, re);
  assert.match(L.validateLayout({ grid: ['#.#'] }).errors.join(), /needs a player/);
  assert.match(L.validateLayout({ grid: ['PP'] }).errors.join(), /2 players/);
});

test('scripts: a body is wrapped in Harness.Scripts.<Name>.Run, a class is kept; the C# is checked structurally first', () => {
  const w = L.wrapScript('MakeTorches', 'var go = new GameObject("Torch");\nreturn go.name;');
  assert.equal(w.method, 'Harness.Scripts.MakeTorches.Run');
  assert.match(w.source, /public static class MakeTorches/);
  assert.match(w.source, /using Object = UnityEngine\.Object;/);
  assert.equal(L.csharpBalanced(w.source).ok, true);
  assert.match(L.wrapScript('X', 'Debug.Log(1);').source, /return null;/);
  const k = L.wrapScript('Ignored', 'namespace Tools.Level { public static class Build { public static void Run() { } } }');
  assert.deepEqual([k.method, k.wrapped], ['Tools.Level.Build.Run', false]);
  assert.deepEqual(L.csharpBalanced('class A { void F() { var s = "}"; var c = \'{\'; /* { */ // }\n var i = $"{x}"; var v = @"a""}"; } }'), { ok: true });
  assert.match(L.csharpBalanced('class A { void F() { }').error, /never closed/);
  assert.match(L.csharpBalanced('class A { void F() ) }').error, /unbalanced "\)"/);
  assert.equal(L.scriptName('Good_1'), 'Good_1');
  assert.equal(L.scriptName('bad name'), null);
});

// ---------- the UPM package ----------

async function packageSources() {
  const files: string[] = P.packageFiles();
  const out: Record<string, string> = {};
  for (const f of files) out[f] = await fs.readFile(path.join(P.PACKAGE_DIR, f), 'utf8');
  return out;
}

test('the bridge package: valid package.json and asmdefs, every C# file balanced and namespaced, MonoBehaviours named like their files', async () => {
  const src = await packageSources();
  const pkg = JSON.parse(src['package.json']!);
  assert.equal(pkg.name, 'com.harness.bridge');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.unity, '2022.3');
  assert.ok(pkg.displayName && pkg.description);
  const asmdefs = Object.keys(src).filter((f) => f.endsWith('.asmdef'));
  assert.deepEqual(asmdefs.sort(), ['Editor/Harness.Bridge.Editor.asmdef', 'Editor/Recorder/Harness.Bridge.Editor.Recorder.asmdef', 'Editor/Tests/Harness.Bridge.Editor.Tests.asmdef', 'Runtime/Harness.Bridge.asmdef']);
  const names = new Set<string>();
  for (const f of asmdefs) {
    const a = JSON.parse(src[f]!);
    assert.ok(/^Harness\.Bridge(\.Editor(\.\w+)?)?$/.test(a.name), `${f}: ${a.name}`);
    assert.ok(!names.has(a.name));
    names.add(a.name);
    assert.ok(Array.isArray(a.references));
    if (f.startsWith('Editor/')) assert.deepEqual(a.includePlatforms, ['Editor'], `${f} is editor-only`);
    for (const v of a.versionDefines ?? []) assert.ok(v.name && v.expression && v.define, f);
    for (const c of a.defineConstraints ?? []) assert.ok((a.versionDefines ?? []).some((v: Any) => v.define === c), `${f}: the constraint ${c} comes from its own versionDefines`);
  }
  const cs = Object.keys(src).filter((f) => f.endsWith('.cs'));
  assert.ok(cs.length >= 20, `${cs.length} C# files`);
  for (const f of cs) {
    const text = src[f]!;
    const b = L.csharpBalanced(text);
    assert.ok(b.ok, `${f}: ${b.error}`);
    assert.match(text, /^namespace Harness\.Bridge(\.Editor)?$/m, `${f} has a Harness.Bridge namespace`);
    assert.doesNotMatch(text, /\bFindObjectOfType\b|\bFindObjectsOfType\b/, `${f}: Unity 6 uses FindObjectsByType / FindFirstObjectByType`);
    const lines = text.split('\n');
    let inElse = false;
    for (const l of lines) {
      if (/^#else\b/.test(l.trim())) inElse = true;
      if (/^#endif\b/.test(l.trim())) inElse = false;
      if (/\.velocity\b/.test(l)) assert.ok(inElse, `${f}: Rigidbody.velocity only for editors before Unity 6 (#else)`);
    }
    for (const m of text.matchAll(/class\s+(\w+)\s*:\s*MonoBehaviour/g)) assert.equal(path.posix.basename(f, '.cs'), m[1], `${f}: a MonoBehaviour lives in a file of its own name`);
    // Preprocessor blocks pair up.
    assert.equal((text.match(/^\s*#if\b/gm) ?? []).length, (text.match(/^\s*#endif\b/gm) ?? []).length, `${f}: #if and #endif pair up`);
  }
});

// The editor ships its C# compiler and Unity's assemblies: the package compiles against them with
// no licence and without starting the editor (the Input System, Test Framework, Recorder and 2D
// Sprite parts need their packages, so they are compiled when a project has them).
const localEditor = (await D.discover({}).catch(() => ({ editors: [] }))).editors.find((e: Any) => e.complete);
const compilerOf = (e: Any) => {
  const dotnet = path.join(e.dataDir, 'NetCoreRuntime', process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
  const csc = path.join(e.dataDir, 'DotNetSdkRoslyn', 'csc.dll');
  return { dotnet, csc };
};
const hasCompiler = localEditor ? await Promise.all(Object.values(compilerOf(localEditor)).map((p) => fs.access(p).then(() => true, () => false))).then((x) => x.every(Boolean)) : false;

test('the bridge package and the scripts the tool writes compile with the editor\'s own C# compiler, without obsolete APIs', { skip: !hasCompiler && 'no Unity editor with its bundled compiler on this machine', timeout: 300_000 }, async () => {
  const { execFile } = await import('node:child_process');
  const { dotnet, csc } = compilerOf(localEditor);
  const managed = path.join(localEditor.dataDir, 'Managed', 'UnityEngine');
  const refs = [path.join(localEditor.dataDir, 'NetStandard', 'ref', '2.1.0', 'netstandard.dll'), ...(await fs.readdir(managed)).filter((f) => f.endsWith('.dll')).map((f) => path.join(managed, f))];
  const out = await tempDir('unity-csc-');
  const defines = 'UNITY_6000_0_OR_NEWER;UNITY_2023_1_OR_NEWER;UNITY_2022_3_OR_NEWER;UNITY_EDITOR;ENABLE_LEGACY_INPUT_MANAGER';
  const compile = async (name: string, files: string[], extra: string[] = []) => {
    const rsp = path.join(out, `${name}.rsp`);
    await fs.writeFile(rsp, ['-target:library', '-nostdlib+', '-langversion:9.0', '-nologo', '-warn:4', `-define:${defines}`, `-out:"${path.join(out, `${name}.dll`)}"`, ...[...refs, ...extra].map((r) => `-r:"${r}"`), ...files.map((f) => `"${f}"`)].join('\n'));
    const r = await new Promise<{ code: number; text: string }>((resolve) => execFile(dotnet, [csc, `@${rsp}`], { maxBuffer: 1 << 24 }, (err, stdout, stderr) => resolve({ code: err ? 1 : 0, text: `${stdout}${stderr}` })));
    assert.equal(r.code, 0, `${name} does not compile:\n${r.text}`);
    assert.doesNotMatch(r.text, /warning CS06(18|19)/, `${name} uses an obsolete Unity API:\n${r.text}`);
    return path.join(out, `${name}.dll`);
  };
  const cs = (dir: string, skipDirs: string[] = []) => P.packageFiles().filter((f: string) => f.startsWith(`${dir}/`) && f.endsWith('.cs') && !skipDirs.some((s) => f.startsWith(`${dir}/${s}/`))).map((f: string) => path.join(P.PACKAGE_DIR, f));
  const runtime = await compile('Harness.Bridge', cs('Runtime'));
  const editor = await compile('Harness.Bridge.Editor', cs('Editor', ['Tests', 'Recorder']), [runtime]);
  const scripts = path.join(out, 'scripts.cs');
  const a = L.wrapScript('CountCoins', 'EditorSceneManager.OpenScene("Assets/Scenes/Level1.unity");\nreturn Object.FindObjectsByType<Harness.Bridge.HarnessCollectible>(FindObjectsInactive.Include, FindObjectsSortMode.None).Length;');
  const b = L.wrapScript('AddTorch', 'var torch = new GameObject("Torch");\nvar light = torch.AddComponent<Light>();\nlight.type = LightType.Point;\nEditorSceneManager.MarkSceneDirty(SceneManager.GetActiveScene());');
  await fs.writeFile(scripts, `${a.source}\n${b.source.replace(/^\/\/.*\n(using .*\n)+/, '')}`);
  await compile('Scripts', [scripts], [runtime, editor]);
});

test('the bridge package offers what the harness calls: every batch entry point and every live op', async () => {
  const src = await packageSources();
  const batch = src['Editor/Batch.cs']!;
  const methods = [...batch.matchAll(/public static void (\w+)\(\)/g)].map((m) => m[1]);
  const js = await fs.readFile(path.join(pluginDir, 'unity.mjs'), 'utf8');
  const used = [...js.matchAll(/method: '(\w+)'/g)].map((m) => m[1]);
  assert.ok(used.length >= 10);
  for (const m of used) assert.ok(methods.includes(m), `Batch.${m} exists`);
  for (const m of ['BuildLevelFromLayout', 'ImportAssets', 'Capture', 'RunTests', 'Build', 'Describe']) assert.ok(methods.includes(m), `Batch.${m}`);
  const ops = new Set<string>();
  for (const text of Object.values(src)) for (const m of text.matchAll(/Register\("([a-z.]+)"/g)) ops.add(m[1]!);
  const driver = await fs.readFile(path.join(pluginDir, 'driver.mjs'), 'utf8');
  const calls = new Set([...`${js}\n${driver}`.matchAll(/\.call\('([a-z.]+)'/g)].map((m) => m[1]!));
  calls.delete('ping');
  for (const c of calls) assert.ok(ops.has(c), `the bridge has the op ${c}`);
  for (const c of ['scene.hierarchy', 'object.create', 'object.modify', 'component.set', 'prefab.create', 'play.enter', 'play.exit', 'capture', 'console.read', 'script.invoke']) assert.ok(ops.has(c), c);
});

test('bridge install: files with stable .meta GUIDs (folders too), skipped when unchanged, stale files pruned', async () => {
  const files = P.bridgeFiles();
  const metas = files.filter((f: Any) => f.rel.endsWith('.meta'));
  assert.ok(metas.some((f: Any) => f.rel === 'Runtime.meta' && /folderAsset: yes/.test(f.data.toString())));
  assert.ok(metas.some((f: Any) => f.rel === 'Runtime/HarnessCollectible.cs.meta' && /MonoImporter/.test(f.data.toString())));
  assert.ok(metas.some((f: Any) => f.rel === 'Runtime/Harness.Bridge.asmdef.meta' && /AssemblyDefinitionImporter/.test(f.data.toString())));
  const guids = metas.map((f: Any) => /guid: ([0-9a-f]{32})/.exec(f.data.toString())![1]);
  assert.equal(new Set(guids).size, guids.length, 'GUIDs are unique');
  assert.equal(P.stableGuid('Runtime/HarnessCollectible.cs'), P.stableGuid('Runtime/HarnessCollectible.cs'));
  const root = await tempDir('unity-pkg-');
  const host = stubHost(root, async () => ({}));
  const a = await P.installBridge(host, 'Game', signal);
  assert.equal(a.installed, true);
  assert.equal(a.path, 'Game/Packages/com.harness.bridge');
  await fs.access(path.join(root, 'Game/Packages/com.harness.bridge/Editor/Batch.cs'));
  await fs.access(path.join(root, 'Game/Packages/com.harness.bridge/Editor/Batch.cs.meta'));
  assert.equal((await P.installBridge(host, 'Game', signal)).installed, false);
  await fs.writeFile(path.join(root, 'Game/Packages/com.harness.bridge/Editor/Old.cs'), 'class Old {}');
  await fs.writeFile(path.join(root, 'Game/Packages/com.harness.bridge/.harness-installed'), 'older\n');
  assert.equal((await P.installBridge(host, 'Game', signal)).installed, true);
  await assert.rejects(fs.access(path.join(root, 'Game/Packages/com.harness.bridge/Editor/Old.cs')));
});

// ---------- archives and project files ----------

test('archives: templates read from .tgz (long names, ProjectData~ without Library), zips', () => {
  const long = `package/ProjectData~/Assets/${'deep/'.repeat(25)}file.txt`;
  const tgz = zlib.gzipSync(A.tar([
    { name: 'package/package.json', data: JSON.stringify({ name: 'com.unity.template.urp-blank', displayName: '3D URP', version: '17.0.11' }) },
    { name: 'package/ProjectData~/Assets/Scenes/SampleScene.unity', data: 'scene' },
    { name: 'package/ProjectData~/Library/ArtifactDB', data: 'cache' },
    { name: 'package/ProjectData~/ProjectSettings/ProjectSettings.asset', data: '  productName: com.unity.template.urp-blank\n  companyName: DefaultCompany\n' },
    { name: long, data: 'x' },
  ]));
  assert.equal(P.templateInfo(tgz).displayName, '3D URP');
  const files = P.templateProject(tgz);
  assert.deepEqual(files.map((f: Any) => f.rel).sort(), [long.slice('package/ProjectData~/'.length), 'Assets/Scenes/SampleScene.unity', 'ProjectSettings/ProjectSettings.asset'].sort());
  assert.ok(P.templateProject(tgz, { library: true }).some((f: Any) => f.rel === 'Library/ArtifactDB'));
  assert.match(P.withProductName(files.find((f: Any) => f.rel.endsWith('ProjectSettings.asset')).data.toString(), 'Coin Escape', 'Studio'), /productName: Coin Escape\n {2}companyName: Studio/);
  const z = A.zip([{ name: 'Game/Game.exe', data: Buffer.from('MZ') }, { name: 'Game\\Game_Data\\level0', data: Buffer.alloc(1000, 7) }]);
  assert.deepEqual(A.zipNames(z), ['Game/Game.exe', 'Game/Game_Data/level0']);
});

test('project files: templates by name, minimal manifests, test assemblies, .studio/project.json merges', () => {
  assert.equal(P.templateFor(undefined, '2d').id, '2d-urp');
  assert.equal(P.templateFor('Built-in').id, '3d-builtin');
  assert.equal(P.templateFor('isometric').id, '2.5d-urp');
  assert.equal(P.templateFor('vr'), null);
  const avail = [{ name: 'com.unity.template.3d-cross-platform', version: '17.0.11' }, { name: 'com.unity.template.2d-cross-platform', version: '5.1.0' }, { name: 'com.unity.template.3d-cross-platform', version: '17.0.2' }];
  assert.equal(P.pickTemplate(avail, P.TEMPLATES['3d-urp']).version, '17.0.11');
  assert.equal(P.pickTemplate(avail, P.TEMPLATES['2d-urp']).name, 'com.unity.template.2d-cross-platform');
  assert.equal(P.pickTemplate(avail, P.TEMPLATES['3d-builtin']), null);
  const m = JSON.parse(P.minimalManifest({ urp: true, twoD: true, versions: P.knownVersions([{ dependencies: { 'com.unity.inputsystem': '1.14.0', x: 'file:../x' } }], { 'com.unity.render-pipelines.universal': '17.0.4' }) }));
  assert.equal(m.dependencies['com.unity.render-pipelines.universal'], '17.0.4');
  assert.equal(m.dependencies['com.unity.inputsystem'], '1.14.0');
  assert.equal(m.dependencies['com.unity.feature.2d'], '2.0.1');
  assert.equal(m.dependencies['com.unity.modules.physics2d'], '1.0.0');
  assert.equal(JSON.parse(P.minimalManifest({ urp: false, twoD: false })).dependencies['com.unity.render-pipelines.universal'], undefined);
  for (const f of P.testScaffold('Coin Escape')) {
    if (f.rel.endsWith('.asmdef')) { const a = JSON.parse(f.data); assert.ok(a.defineConstraints.includes('UNITY_INCLUDE_TESTS')); assert.ok(a.precompiledReferences.includes('nunit.framework.dll')); }
    else assert.ok(L.csharpBalanced(f.data).ok, f.rel);
  }
  const sp = P.studioProject({ name: 'Kept', budgets: { fps: 30 }, playtests: ['pt-1'], extra: 1 }, { name: 'New', dimension: '3d', engineProject: 'Game/ProjectSettings/ProjectVersion.txt' });
  assert.deepEqual([sp.name, sp.engine, sp.dimension, sp.budgets.fps, sp.playtests[0], sp.extra, sp.engineProject], ['Kept', 'unity', '3d', 30, 'pt-1', 1, 'Game/ProjectSettings/ProjectVersion.txt']);
  const other = P.studioProject({ engine: 'godot', engineProject: 'g/project.godot' }, { name: 'x', dimension: '2d', engineProject: 'Game/ProjectSettings/ProjectVersion.txt' });
  assert.deepEqual([other.engine, other.engineProject], ['godot', 'g/project.godot']);
  const wb = P.withBuild({ builds: [{ id: 'b1' }], name: 'n' }, { id: 'b2', platform: 'win64' });
  assert.deepEqual(wb.builds.map((b: Any) => b.id), ['b1', 'b2']);
});

// ---------- a fake editor ----------

/** The words of a bash command line the plugin built (single quotes, '\'' escapes). */
function words(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let q = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (q) { if (c === "'") q = false; else cur += c; continue; }
    if (c === "'") { q = true; has = true; continue; }
    if (c === '\\' && i + 1 < cmd.length) { cur += cmd[++i]; has = true; continue; }
    if (c === ' ' || c === '\n') { if (has) { out.push(cur); cur = ''; has = false; } continue; }
    cur += c;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}

function stubHost(root: string, exec: (cmd: string, o: ExecOptions) => Promise<Partial<ExecResult>>): ToolHost & { cmds: string[] } {
  const cmds: string[] = [];
  return {
    kind: 'local', root, displayRoot: root, platform: 'win32', shell: 'bash', sandboxed: false, networkPolicy: 'none', cmds,
    async exec(cmd: string, o: ExecOptions): Promise<ExecResult> { cmds.push(cmd); return { stdout: '', stderr: '', code: 0, timedOut: false, ...await exec(cmd, o) }; },
  };
}

type Reply = { log?: string; result?: unknown; code?: number; files?: Record<string, string | Buffer> };
type Handler = (payload: Any, argv: string[]) => Reply | Promise<Reply>;

/** An editor stand-in: batch entry points by name (Harness.Bridge.Batch.<Name>), -runTests by platform. */
function fakeEditor(handlers: Record<string, Handler>) {
  const calls: { method: string; payload: Any; argv: string[] }[] = [];
  const exec = async (cmd: string) => {
    const argv = words(cmd);
    const get = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
    const method = argv.includes('-runTests') ? `runTests:${get('-testPlatform')}` : get('-executeMethod')?.split('.').pop() ?? 'open';
    const argsFile = get('-harnessArgs');
    const payload = argsFile ? JSON.parse(await fs.readFile(argsFile, 'utf8')) : {};
    calls.push({ method, payload, argv });
    const h = handlers[method] ?? handlers['*'];
    const r = h ? await h(payload, argv) : { code: 1, log: `executeMethod method ${method} could not be found` };
    const log = get('-logFile');
    if (log) { await fs.mkdir(path.dirname(log), { recursive: true }); await fs.writeFile(log, r.log ?? `[Harness] ${method} done\n`); }
    const res = get('-harnessResult');
    if (res && r.result !== undefined) await fs.writeFile(res, JSON.stringify(r.result));
    for (const [f, data] of Object.entries(r.files ?? {})) { await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, data); }
    return { code: r.code ?? 0 };
  };
  return { exec, calls };
}

const EDITOR = { version: '6000.0.40f1', path: 'C:/Fake/6000.0.40f1/Editor/Unity.exe', modules: ['webgl', 'windows'], il2cpp: false, templates: [], complete: true, dataDir: 'C:/Fake/Data', sources: ['hub'], registered: true };
const discovery = (editors: Any[] = [EDITOR], license = 'activated') => async () => ({ hub: { path: 'C:/Hub/Unity Hub.exe', version: '3.11.1' }, editors, license: { status: license, evidence: [] }, gaps: license === 'activated' ? [] : ['license not activated: ...'], notes: [] });

function templateTgz() {
  return zlib.gzipSync(A.tar([
    { name: 'package/package.json', data: JSON.stringify({ name: 'com.unity.template.urp-blank', displayName: '3D URP', version: '17.0.11' }) },
    { name: 'package/ProjectData~/Assets/Scenes/SampleScene.unity', data: '%YAML 1.1\n--- !u!1 &1\nGameObject:\n  m_Name: Main Camera\n' },
    { name: 'package/ProjectData~/Packages/manifest.json', data: JSON.stringify({ dependencies: { 'com.unity.render-pipelines.universal': '17.0.1', 'com.unity.inputsystem': '1.8.1' } }) },
    { name: 'package/ProjectData~/ProjectSettings/ProjectSettings.asset', data: '  productName: com.unity.template.urp-blank\n  companyName: DefaultCompany\n  activeInputHandler: 2\n' },
    { name: 'package/ProjectData~/ProjectSettings/ProjectVersion.txt', data: 'm_EditorVersion: 6000.0.25f1\n' },
    { name: 'package/ProjectData~/Library/big.cache', data: 'x' },
  ]));
}

const run = (input: Any, host: ToolHost, deps: Any) => U.runUnity(input, { host, signal }, deps);

/** A workspace with a project the fake editor can work on. */
async function workspace() {
  const root = await tempDir('unity-ws-');
  await fs.mkdir(path.join(root, 'Game', 'Assets', 'Scenes'), { recursive: true });
  await fs.mkdir(path.join(root, 'Game', 'ProjectSettings'), { recursive: true });
  await fs.writeFile(path.join(root, 'Game', 'Packages', 'manifest.json'), '{}').catch(async () => { await fs.mkdir(path.join(root, 'Game', 'Packages'), { recursive: true }); await fs.writeFile(path.join(root, 'Game', 'Packages', 'manifest.json'), JSON.stringify({ dependencies: { 'com.unity.inputsystem': '1.11.2', 'com.unity.modules.physics': '1.0.0' } })); });
  await fs.writeFile(path.join(root, 'Game', 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0.40f1\n');
  await fs.writeFile(path.join(root, 'Game', 'ProjectSettings', 'ProjectSettings.asset'), '  productName: Coin Escape\n  activeInputHandler: 2\n');
  await fs.writeFile(path.join(root, 'Game', 'ProjectSettings', 'EditorBuildSettings.asset'), '  m_Scenes:\n  - enabled: 1\n    path: Assets/Scenes/Level1.unity\n');
  await fs.writeFile(path.join(root, 'Game', 'Assets', 'Scenes', 'Level1.unity'), '--- !u!1 &10\nGameObject:\n  m_ObjectHideFlags: 0\n  m_Name: Player\n--- !u!1 &11\nGameObject:\n  m_Name: Coin\n');
  await fs.mkdir(path.join(root, '.studio'), { recursive: true });
  await fs.writeFile(path.join(root, '.studio', 'project.json'), JSON.stringify({ name: 'Coin Escape', engine: 'unity', dimension: '3d', engineProject: 'Game/ProjectSettings/ProjectVersion.txt', budgets: { fps: 60, memoryMb: 2048 }, builds: [], playtests: [] }));
  return root;
}

// ---------- the tool with a fake editor ----------

test('detect and install through the tool: the report, the gaps, and what to do in the Hub (nothing is installed)', async () => {
  const host = stubHost(await tempDir('unity-d-'), async () => ({}));
  const r = await run({ action: 'detect' }, host, { discover: discovery([EDITOR], 'not-activated') });
  assert.equal(r.r.status, 'ok');
  assert.match(r.r.summary, /Unity 6000\.0\.40f1 .*licence not-activated/);
  assert.equal(r.r.data.installed, true);
  assert.ok(r.r.data.actions.includes('build'));
  assert.equal(r.r.problems[0].severity, 'warning');
  const none = await run({ action: 'detect' }, host, { discover: discovery([]) });
  assert.equal(none.r.data.installed, false);
  assert.deepEqual(none.r.data.actions, ['detect', 'install', 'project.create', 'describe', 'bridge.status']);
  const inst = await run({ action: 'install' }, host, { discover: discovery([]) });
  assert.equal(inst.r.status, 'unavailable');
  assert.match(inst.r.summary, /Unity 6 LTS \(6000\.x\).*Windows Build Support.*WebGL Build Support.*never installs/);
  assert.equal(host.cmds.length, 0, 'nothing ran');
  const docker = await run({ action: 'build' }, { ...host, kind: 'docker' } as ToolHost, {});
  assert.equal(docker.r.status, 'unavailable');
  assert.match(docker.r.summary, /never|not in a sandbox/);
});

test('project.create without an editor: the files, the bridge package, tests and .studio/project.json, and the gap', async () => {
  const root = await tempDir('unity-c-');
  const host = stubHost(root, async () => ({}));
  const r = await run({ action: 'project.create', project: 'Game', template: '2d-urp', name: 'Pixel Run' }, host, { discover: discovery([]), templates: async () => [] });
  assert.equal(r.r.status, 'ok', r.r.summary);
  assert.match(r.r.summary, /no editor yet/);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'Game/Packages/manifest.json'), 'utf8'));
  assert.ok(manifest.dependencies['com.unity.feature.2d']);
  assert.ok(manifest.dependencies['com.unity.render-pipelines.universal']);
  await fs.access(path.join(root, 'Game/Packages/com.harness.bridge/Runtime/HarnessPlayback.cs'));
  await fs.access(path.join(root, 'Game/Assets/Tests/PlayMode/PlayTests.cs'));
  await fs.access(path.join(root, 'Game/.gitignore'));
  const studio = JSON.parse(await fs.readFile(path.join(root, '.studio/project.json'), 'utf8'));
  assert.deepEqual([studio.name, studio.engine, studio.dimension, studio.engineProject], ['Pixel Run', 'unity', '2d', 'Game/ProjectSettings/ProjectVersion.txt']);
  assert.equal(host.cmds.length, 0);
  const again = await run({ action: 'project.create', project: 'Game' }, host, { discover: discovery([]) });
  assert.equal(again.r.status, 'failed');
  assert.match(again.r.summary, /already a Unity project/);
  assert.match((await run({ action: 'project.create', project: '.' }, host, { discover: discovery([]) })).r.summary, /folder of its own/);
});

test('project.create with an editor: the editor\'s template unpacked (no Library), the product name, then ConfigureProject headless', async () => {
  const root = await tempDir('unity-t-');
  const ed = fakeEditor({ ConfigureProject: (p) => ({ result: { ok: true, productName: p.name, renderPipeline: 'PC_RPAsset', scenes: [p.scene] } }) });
  const host = stubHost(root, ed.exec);
  const r = await run({ action: 'project.create', project: 'Game', template: '3d-urp', name: 'Coin Escape' }, host, { discover: discovery(), templates: async () => [{ file: 'x.tgz', name: 'com.unity.template.3d-cross-platform', version: '17.0.11', buf: templateTgz() }] });
  assert.equal(r.r.status, 'ok', r.r.summary);
  assert.match(r.r.summary, /the editor's template 3D URP 17\.0\.11; opened and set up/);
  assert.match(await fs.readFile(path.join(root, 'Game/ProjectSettings/ProjectSettings.asset'), 'utf8'), /productName: Coin Escape/);
  await assert.rejects(fs.access(path.join(root, 'Game/Library/big.cache')), 'the template\'s Library cache is not copied');
  await assert.rejects(fs.access(path.join(root, 'Game/ProjectSettings/ProjectVersion.txt')), 'Unity writes its own version');
  assert.equal(ed.calls.length, 1);
  assert.equal(ed.calls[0]!.method, 'ConfigureProject');
  assert.deepEqual([ed.calls[0]!.payload.name, ed.calls[0]!.payload.urp, ed.calls[0]!.payload.scene], ['Coin Escape', true, 'Assets/Scenes/SampleScene.unity']);
  assert.ok(ed.calls[0]!.argv.includes('-batchmode') && !ed.calls[0]!.argv.includes('-quit'));
  assert.equal(r.r.data.setup.renderPipeline, 'PC_RPAsset');
});

test('a licence that is not activated, a locked project and compile errors come back as such', async () => {
  const root = await workspace();
  const lic = fakeEditor({ Check: () => ({ code: 1, log: LICENSE_LOG }) });
  let r = await run({ action: 'project.open' }, stubHost(root, lic.exec), { discover: discovery() });
  assert.equal(r.r.status, 'unavailable');
  assert.match(r.r.summary, /^license not activated/);
  const locked = fakeEditor({ Check: () => ({ code: 1, log: 'It looks like another Unity instance is running with this project open.\n' }) });
  r = await run({ action: 'project.open', project: 'Game' }, stubHost(root, locked.exec), { discover: discovery() });
  assert.equal(r.r.status, 'failed');
  assert.match(r.r.summary, /open in another Unity editor/);
  const broken = fakeEditor({ Check: () => ({ code: 1, log: 'Assets/Scripts/Player.cs(7,20): error CS0103: The name \'speeed\' does not exist in the current context\nScripts have compiler errors.\n' }) });
  r = await run({ action: 'project.open' }, stubHost(root, broken.exec), { discover: discovery() });
  assert.equal(r.r.status, 'failed');
  assert.deepEqual([r.r.problems[0].file, r.r.problems[0].line], ['Assets/Scripts/Player.cs', 7]);
  assert.match(r.r.logFile, /^\.harness\/unity\/runs\/[\w-]+\/unity\.log$/);
  await fs.access(path.join(root, r.r.logFile));
  const clean = fakeEditor({ Check: () => ({ result: { ok: true, compiled: true }, log: 'Assets/A.cs(1,1): warning CS0414: unused\n' }) });
  r = await run({ action: 'project.open' }, stubHost(root, clean.exec), { discover: discovery() });
  assert.equal(r.r.status, 'ok', r.r.summary);
  assert.match(r.r.summary, /every script compiles .*1 warning/);
  const old = await run({ action: 'project.open' }, stubHost(root, clean.exec), { discover: discovery([{ ...EDITOR, version: '6000.0.30f1' }]) });
  assert.match(old.r.summary, /made with 6000\.0\.40f1; using 6000\.0\.30f1/);
});

test('describe: from the files without an editor, headless with one', async () => {
  const root = await workspace();
  const host = stubHost(root, async () => ({}));
  let r = await run({ action: 'describe' }, host, { discover: discovery([]) });
  assert.equal(r.r.status, 'ok');
  assert.equal(r.r.data.mode, 'files');
  assert.equal(r.r.data.unity, '6000.0.40f1');
  assert.equal(r.r.data.productName, 'Coin Escape');
  assert.equal(r.r.data.inputHandler, 'Both');
  assert.deepEqual(r.r.data.buildScenes, ['Assets/Scenes/Level1.unity']);
  assert.deepEqual(r.r.data.sceneObjects['Assets/Scenes/Level1.unity'], ['Player', 'Coin']);
  const ed = fakeEditor({ Describe: () => ({ result: { ok: true, settings: { unity: '6000.0.40f1' }, buildScenes: [{ path: 'Assets/Scenes/Level1.unity' }], assets: { Scene: { count: 1 }, Prefab: { count: 2 } } } }) });
  r = await run({ action: 'describe', live: false }, stubHost(root, ed.exec), { discover: discovery() });
  assert.equal(r.r.status, 'ok', r.r.summary);
  assert.equal(r.r.data.mode, 'batch');
  assert.match(r.r.summary, /1 scene\(s\) in the build, 3 assets/);
});

test('script: written into Assets/Editor/Harness and run headless; a structural error stops it early; exceptions have file and line', async () => {
  const root = await workspace();
  const ed = fakeEditor({
    RunScript: (p) => (p.method === 'Harness.Scripts.Count.Run'
      ? { result: { ok: true, method: p.method, value: 7, tookMs: 4 } }
      : { code: 1, result: { ok: false, error: 'InvalidOperationException: no level', stack: '  at Harness.Scripts.Boom.Run () [0x0001] in C:\\w\\Game\\Assets\\Editor\\Harness\\Boom.cs:14' } }),
  });
  const host = stubHost(root, ed.exec);
  let r = await run({ action: 'script', name: 'Count', code: 'return Object.FindObjectsByType<Light>(FindObjectsSortMode.None).Length + 7;', live: false }, host, { discover: discovery() });
  assert.equal(r.r.status, 'ok', r.r.summary);
  assert.equal(r.r.data.value, 7);
  assert.match(await fs.readFile(path.join(root, 'Game/Assets/Editor/Harness/Count.cs'), 'utf8'), /public static object Run\(\)/);
  await fs.access(path.join(root, 'Game/Packages/com.harness.bridge/Editor/Batch.cs'));
  r = await run({ action: 'script', name: 'Boom', code: 'throw new System.InvalidOperationException("no level");', live: false }, host, { discover: discovery() });
  assert.equal(r.r.status, 'failed');
  assert.deepEqual([r.r.problems[0].file, r.r.problems[0].line], ['Assets/Editor/Harness/Boom.cs', 14]);
  const calls = ed.calls.length;
  r = await run({ action: 'script', name: 'Bad', code: 'if (x) { return 1;', live: false }, host, { discover: discovery() });
  assert.equal(r.r.status, 'failed');
  assert.match(r.r.summary, /does not parse: .*never closed/);
  assert.equal(ed.calls.length, calls, 'Unity is not started for C# that cannot compile');
  const both = await run({ action: 'script' }, host, { discover: discovery() });
  assert.match(both.r.summary, /give code .* or file/);
});

test('level.build: the layout is checked first, then the scene is built headless and its capture shown', async () => {
  const root = await workspace();
  const ed = fakeEditor({
    BuildLevelFromLayout: (p) => ({ result: { ok: true, scene: p.scene, dimension: p.dimension, rows: p.grid.length, cols: p.grid[0].length, counts: { wall: 4, player: 1, collectible: 2, exit: 1 }, capture: { out: p.capture.out } }, files: { [p.capture.out]: testPicture() } }),
  });
  const host = stubHost(root, ed.exec);
  const bad = await run({ action: 'level.build', layout: { grid: ['#..#'] } }, host, { discover: discovery() });
  assert.equal(bad.r.status, 'failed');
  assert.match(bad.r.problems[0].message, /needs a player/);
  assert.equal(ed.calls.length, 0);
  const r = await run({ action: 'level.build', live: false, layout: { name: 'Level1', dimension: '3d', cell: 2, grid: ['######', '#P.CE#', '#C...#', '######'] } }, host, { discover: discovery() });
  assert.equal(r.r.status, 'ok', r.r.summary);
  assert.match(r.r.summary, /Assets\/Scenes\/Level1\.unity \(3d, 4x6 cells\): 4 wall, 1 player, 2 collectible, 1 exit/);
  assert.equal(r.images.length, 1);
  assert.equal(ed.calls[0]!.payload.cell, 2);
  assert.equal(ed.calls[0]!.payload.camera.mode, 'follow');
});

test('capture: the frame comes back as an image; a blank one is a warning', async () => {
  const root = await workspace();
  let picture = testPicture();
  const ed = fakeEditor({ Capture: (p) => ({ result: { ok: true, width: p.width, height: p.height, camera: 'Main Camera', out: p.out }, files: { [p.out]: picture } }) });
  const host = stubHost(root, ed.exec);
  let r = await run({ action: 'capture', scene: 'Assets/Scenes/Level1.unity', out: 'shots/a.png', live: false }, host, { discover: discovery() });
  assert.equal(r.r.status, 'ok', r.r.summary);
  assert.deepEqual(r.r.files, ['shots/a.png']);
  assert.equal(r.images[0].media_type, 'image/png');
  assert.equal(r.r.problems.length, 0);
  picture = pngBytes(64, 64, () => [0, 0, 0]);
  r = await run({ action: 'capture', out: 'shots/b.png', live: false }, host, { discover: discovery() });
  assert.match(r.r.problems[0].message, /blank/);
  assert.match((await run({ action: 'capture', out: 'shots/b.jpg' }, host, { discover: discovery() })).r.summary, /\.png/);
});

test('test: EditMode and PlayMode through -runTests, results parsed, failures with file and line', async () => {
  const root = await workspace();
  const passing = RESULTS_XML.replace(/result="Failed\(Child\)" total="3" passed="1" failed="1"/, 'result="Passed" total="2" passed="2" failed="0"');
  const ed = fakeEditor({
    'runTests:EditMode': (_p, argv) => ({ files: { [argv[argv.indexOf('-testResults') + 1]!]: passing.replace(/<test-case id="1004"[\s\S]*?<\/test-case>/, '') }, code: 0 }),
    'runTests:PlayMode': (_p, argv) => ({ files: { [argv[argv.indexOf('-testResults') + 1]!]: RESULTS_XML }, code: 2 }),
  });
  const r = await run({ action: 'test', live: false }, stubHost(root, ed.exec), { discover: discovery() });
  assert.equal(r.r.status, 'failed');
  assert.deepEqual(ed.calls.map((c) => c.method), ['runTests:EditMode', 'runTests:PlayMode']);
  assert.equal(r.r.data.PlayMode.failed, 1);
  assert.equal(r.r.metrics.failed, 1);
  const f = r.r.problems.find((p: Any) => /PlayerReachesExit/.test(p.message));
  assert.deepEqual([f.file, f.line], ['Assets/Tests/PlayMode/PlayTests.cs', 41]);
  const missing = fakeEditor({ 'runTests:EditMode': () => ({ code: 3, log: 'Assets/A.cs(1,2): error CS1001: Identifier expected\n' }) });
  const m = await run({ action: 'test', platform: 'EditMode', live: false }, stubHost(root, missing.exec), { discover: discovery() });
  assert.equal(m.r.status, 'failed');
  assert.match(m.r.summary, /no EditMode results/);
  assert.equal(m.r.problems[0].file, 'Assets/A.cs');
});

test('build and package: the report, the files, the build recorded in .studio/project.json; a missing module is the person\'s', async () => {
  const root = await workspace();
  const ed = fakeEditor({
    Build: (p, argv) => {
      assert.equal(argv[argv.indexOf('-buildTarget') + 1], p.target === 'WebGL' ? 'WebGL' : 'Win64');
      const dir = p.target === 'WebGL' ? p.output : path.dirname(p.output);
      return { result: { ok: true, result: 'Succeeded', totalSize: 31457280, totalTimeS: 42, totalErrors: 0, totalWarnings: 1, outputPath: p.output, steps: [] }, files: { [p.target === 'WebGL' ? path.join(dir, 'index.html') : p.output]: 'MZ', [path.join(dir, 'UnityPlayer.dll')]: 'dll' } };
    },
  });
  const host = stubHost(root, ed.exec);
  let r = await run({ action: 'build', target: 'win64', live: false }, host, { discover: discovery() });
  assert.equal(r.r.status, 'ok', r.r.summary);
  assert.match(r.r.summary, /win64 build of Game: Game\/Builds\/win64\/Coin Escape\.exe \(30 MB in 42 s, 1 warning/);
  assert.equal(r.r.metrics.sizeMb, 30);
  const studio = JSON.parse(await fs.readFile(path.join(root, '.studio/project.json'), 'utf8'));
  assert.equal(studio.builds.at(-1).platform, 'win64');
  assert.equal(studio.builds.at(-1).path, 'Game/Builds/win64/Coin Escape.exe');
  assert.equal(studio.name, 'Coin Escape', 'other fields kept');
  r = await run({ action: 'package', target: 'win64', live: false }, host, { discover: discovery() });
  assert.equal(r.r.status, 'ok', r.r.summary);
  const zipFile = r.r.files.find((f: string) => f.endsWith('.zip'));
  assert.equal(zipFile, 'Game/Builds/Coin Escape-win64.zip');
  assert.deepEqual(A.zipNames(await fs.readFile(path.join(root, zipFile))).sort(), ['Coin Escape/Coin Escape.exe', 'Coin Escape/UnityPlayer.dll']);
  assert.equal(ed.calls.at(-1)!.payload.development, false);
  r = await run({ action: 'build', target: 'webgl', live: false }, host, { discover: discovery() });
  assert.equal(r.r.status, 'ok', r.r.summary);
  assert.equal(ed.calls.at(-1)!.payload.webglCompression, 'disabled');
  const noWeb = await run({ action: 'build', target: 'webgl' }, stubHost(root, ed.exec), { discover: discovery([{ ...EDITOR, modules: ['windows'] }]) });
  assert.equal(noWeb.r.status, 'unavailable');
  assert.match(noWeb.r.summary, /no WebGL build support .*Unity Hub/);
  const failing = fakeEditor({ Build: () => ({ code: 1, result: { ok: false, result: 'Failed', steps: [{ name: 'Compile', messages: [{ type: 'Error', content: 'Assets/Scripts/X.cs(2,3): error CS0234: The type or namespace name \'Editor\' does not exist' }] }] } }) });
  const fr = await run({ action: 'build', live: false }, stubHost(root, failing.exec), { discover: discovery() });
  assert.equal(fr.r.status, 'failed');
  assert.equal(fr.r.problems[0].file, 'Assets/Scripts/X.cs');
});

test('play headless: the timeline goes in, frames, metrics, state and events come out, and a Studio playtest is written', async () => {
  const root = await workspace();
  const ed = fakeEditor({
    Play: (p) => {
      const frames: Record<string, Buffer> = {};
      for (let i = 0; i < 3; i++) frames[path.join(p.outDir, 'frames', `000${i}.png`)] = testPicture();
      const report = { engine: 'unity', durationS: p.seconds, frames: ['frames/0000.png', 'frames/0001.png', 'frames/0002.png'], events: [{ seq: 1, t: 2.1, type: 'pickup', detail: 'Coin 1/2' }, { seq: 2, t: 6, type: 'win', detail: 'escaped' }], state: { won: true, collected: 2, total: 2 }, metrics: { fpsAvg: 58.2, fpsMin: 41, frameMsP95: 19.1, memoryMb: 410.5, drawCalls: 37, errors: 0 }, errors: [] };
      return { result: { ok: true, report }, files: { ...frames, [path.join(p.outDir, 'report.json')]: JSON.stringify(report) } };
    },
  });
  const r = await run({ action: 'play', seconds: 8, live: false, goal: 'collect both coins and escape', expectWin: true, inputs: [{ t: 0, key: 'w', press: 2 }, { t: 2, axis: 'Horizontal', value: 1 }] }, stubHost(root, ed.exec), { discover: discovery() });
  assert.equal(r.r.status, 'ok', r.r.summary);
  assert.match(r.r.summary, /8 s of play mode, headless: 3 frame\(s\), 2 event\(s\), won \(2\/2 collected\), 0 error\(s\), fps 58\.2/);
  assert.equal(r.images.length, 3);
  assert.equal(r.r.metrics.drawCalls, 37);
  const sent = ed.calls[0]!.payload;
  assert.deepEqual(sent.inputs.map((e: Any) => [e.t, e.key ?? e.axis, e.down ?? e.value]), [[0, 'W', true], [2, 'W', false], [2, 'Horizontal', 1]]);
  assert.equal(r.r.data.verdict, 'pass');
  const pt = JSON.parse(await fs.readFile(path.join(root, r.r.data.playtest), 'utf8'));
  assert.equal(pt.engine, 'unity');
  assert.equal(pt.result, 'pass');
  assert.equal(pt.player, 'bot:scripted');
  assert.equal(pt.frames.length, 3);
  await fs.access(path.join(root, path.dirname(r.r.data.playtest), pt.frames[0]));
  const studio = JSON.parse(await fs.readFile(path.join(root, '.studio/project.json'), 'utf8'));
  assert.ok(studio.playtests.includes(pt.id));
  const noBuild = await run({ action: 'play', mode: 'player' }, stubHost(root, ed.exec), { discover: discovery() });
  assert.match(noBuild.r.summary, /no build to play/);
});

test('asset.import: files copied into Assets with settings, imported headless (again after glTFast is added), the Studio asset updated', async () => {
  const root = await workspace();
  await fs.mkdir(path.join(root, '.studio/assets/barrel-01'), { recursive: true });
  await fs.writeFile(path.join(root, '.studio/assets/barrel-01/barrel.glb'), 'glTF');
  await fs.writeFile(path.join(root, '.studio/assets/barrel-01/asset.json'), JSON.stringify({ id: 'barrel-01', kind: 'model', engines: { godot: { path: 'res://b.glb' } } }));
  await fs.mkdir(path.join(root, 'art'), { recursive: true });
  await fs.writeFile(path.join(root, 'art/hero.png'), testPicture());
  let runs = 0;
  const ed = fakeEditor({
    ImportAssets: (p) => (++runs === 1 ? { result: { ok: true, restart: true, added: 'com.unity.cloud.gltfast@6.10.0' } } : { result: { ok: true, results: p.files.map((f: Any) => ({ path: f.path, ok: true, type: f.path.endsWith('.glb') ? 'GameObject' : 'Texture2D', ...(f.path.endsWith('.glb') ? { triangles: 812 } : { sprites: 8 }) })) } }),
  });
  const r = await run({ action: 'asset.import', live: false, files: [{ path: '.studio/assets/barrel-01/barrel.glb' }, { path: 'art/hero.png', kind: 'sprite', ppu: 16, slice: [16, 16] }] }, stubHost(root, ed.exec), { discover: discovery() });
  assert.equal(r.r.status, 'ok', r.r.summary);
  assert.equal(runs, 2, 'run again once glTFast compiled');
  assert.match(r.r.summary, /Assets\/Models\/barrel\.glb \(GameObject, 812 tris\), Assets\/Art\/hero\.png \(Texture2D, 8 sprites\)/);
  await fs.access(path.join(root, 'Game/Assets/Models/barrel.glb'));
  assert.deepEqual(ed.calls[1]!.payload.files[1], { kind: 'sprite', ppu: 16, slice: [16, 16], path: 'Assets/Art/hero.png' });
  const asset = JSON.parse(await fs.readFile(path.join(root, '.studio/assets/barrel-01/asset.json'), 'utf8'));
  assert.equal(asset.engines.unity.path, 'Game/Assets/Models/barrel.glb');
  assert.equal(asset.engines.godot.path, 'res://b.glb');
  assert.match((await run({ action: 'asset.import', files: [{ path: 'art/hero.png', to: 'Elsewhere/x.png' }] }, stubHost(root, ed.exec), { discover: discovery() })).r.summary, /under Assets/);
});

// ---------- the live bridge ----------

type Ops = Record<string, (args: Any, n: number) => unknown>;

/** A bridge server speaking the package's protocol (one JSON line each way, the token checked). */
async function fakeBridge(ops: Ops, token = 'secret-token') {
  const counts: Record<string, number> = {};
  const seen: { op: string; args: Any }[] = [];
  const state = { token, drops: new Set<string>() };
  const server = net.createServer((s) => {
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const req = JSON.parse(line);
        counts[req.op] = (counts[req.op] ?? 0) + 1;
        seen.push({ op: req.op, args: req.args });
        if (state.drops.has(req.op)) { state.drops.delete(req.op); s.destroy(); return; }
        if (req.token !== state.token) { s.write(`${JSON.stringify({ id: req.id, ok: false, error: 'unauthorized' })}\n`); continue; }
        if (req.op === 'ping') { s.write(`${JSON.stringify({ id: req.id, ok: true, result: { pong: true, ops: Object.keys(ops) } })}\n`); continue; }
        const h = ops[req.op];
        try {
          if (!h) throw new Error(`unknown op "${req.op}"`);
          s.write(`${JSON.stringify({ id: req.id, ok: true, result: h(req.args, counts[req.op]!) ?? null })}\n`);
        } catch (e) { s.write(`${JSON.stringify({ id: req.id, ok: false, error: (e as Error).message })}\n`); }
      }
    });
    s.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return { port, counts, seen, state, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function writeBridgeFile(root: string, project: string, port: number, token = 'secret-token') {
  const dir = path.join(root, project, 'Library', 'HarnessBridge');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'bridge.json'), JSON.stringify({ port, token, pid: process.pid, unity: '6000.0.40f1', version: '1.0.0' }));
}

test('the bridge client: results, errors, the token, retries across a script reload, waitFor', async () => {
  const fb = await fakeBridge({ status: () => ({ unity: '6000.0.40f1' }), boom: () => { throw new Error('NullReferenceException: x\n  at (Assets/Editor/Harness/X.cs:3)'); }, 'compile.status': (_a, n) => ({ compiling: n < 3 }) });
  try {
    const b = B.connect({ port: fb.port, token: 'secret-token' });
    assert.deepEqual(await b.call('status'), { unity: '6000.0.40f1' });
    await assert.rejects(b.call('boom'), (e: Any) => e.bridge && /NullReference/.test(e.message));
    await assert.rejects(b.call('nope'), /unknown op/);
    fb.state.drops.add('status');
    assert.deepEqual(await b.call('status', {}, { retryMs: 5000 }), { unity: '6000.0.40f1' }, 'a dropped connection (a reload) is retried');
    fb.state.drops.add('status');
    await assert.rejects(b.call('status', {}, { retryMs: 0 }), /closed/);
    const s = await B.waitFor(b, 'compile.status', (x: Any) => !x.compiling, { everyMs: 20, timeoutMs: 5000 });
    assert.equal(s.compiling, false);
    assert.equal(fb.counts['compile.status'], 3);
    b.close();
    const wrong = B.connect({ port: fb.port, token: 'wrong' });
    await assert.rejects(wrong.call('status'), /unauthorized/);
    wrong.close();
    assert.throws(() => B.connect({ port: 1, token: 'x', host: '10.0.0.5' }), /this machine only/);
    assert.equal(B.alive(process.pid), true);
    assert.equal(B.alive(-1), false);
  } finally { await fb.close(); }
});

test('live: with the project open in the editor, describe, scripts and bridge actions go through the bridge', async () => {
  const root = await workspace();
  let compileErrors: Any[] = [];
  const fb = await fakeBridge({
    status: () => ({ unity: '6000.0.40f1', scene: 'Assets/Scenes/Level1.unity', playing: false }),
    describe: () => ({ settings: { unity: '6000.0.40f1' }, buildScenes: [{ path: 'Assets/Scenes/Level1.unity' }], activeScene: 'Assets/Scenes/Level1.unity' }),
    'assets.refresh': () => ({ compiling: true }),
    'compile.status': (_a, n) => ({ compiling: n < 2, updating: false, messages: compileErrors }),
    'script.invoke': (a) => ({ method: a.method, value: 'ok', tookMs: 2 }),
    capture: () => ({ frame: testPicture().toString('base64'), width: 96, height: 64, camera: 'Main Camera' }),
  });
  try {
    await writeBridgeFile(root, 'Game', fb.port);
    const ed = fakeEditor({});
    const host = stubHost(root, ed.exec);
    let r = await run({ action: 'describe' }, host, { discover: discovery() });
    assert.equal(r.r.data.mode, 'live');
    r = await run({ action: 'script', name: 'Live1', code: 'return "ok";' }, host, { discover: discovery() });
    assert.equal(r.r.status, 'ok', r.r.summary);
    assert.match(r.r.summary, /ran in the open editor/);
    compileErrors = [{ severity: 'error', message: "CS0103: The name 'x' does not exist", file: 'C:/w/Game/Assets/Editor/Harness/Live2.cs', line: 9 }];
    r = await run({ action: 'script', name: 'Live2', code: 'return x;' }, host, { discover: discovery() });
    assert.equal(r.r.status, 'failed');
    assert.deepEqual([r.r.problems[0].file, r.r.problems[0].line], ['Assets/Editor/Harness/Live2.cs', 9]);
    r = await run({ action: 'capture', out: 'shots/live.png' }, host, { discover: discovery() });
    assert.equal(r.r.data.mode, 'live');
    await fs.access(path.join(root, 'shots/live.png'));
    r = await run({ action: 'bridge.status' }, host, { discover: discovery() });
    assert.equal(r.r.data.connected, true);
    assert.ok(r.r.data.ops.includes('script.invoke'));
    r = await run({ action: 'bridge.call', op: 'capture' }, host, { discover: discovery() });
    assert.equal(r.images.length, 1);
    assert.equal(ed.calls.length, 0, 'no batch run while the editor has the project');
    r = await run({ action: 'describe', live: false }, host, { discover: discovery() });
    assert.equal(ed.calls.length, 1, 'live: false runs headless');
  } finally { await fb.close(); }
  const off = await run({ action: 'bridge.connect' }, stubHost(root, async () => ({})), { discover: discovery(), alive: () => false });
  assert.equal(off.r.status, 'unavailable');
  assert.match(off.r.summary, /open the project in Unity/);
});

// ---------- the AI player's driver ----------

test('driver, editor mode: play mode with steps paused between them; frames, state and events per step', async () => {
  const root = await workspace();
  let x = 0;
  const fb = await fakeBridge({
    'play.enter': (a) => ({ entering: true, stepMode: a.stepMode }),
    'play.status': (_a, n) => ({ playing: n >= 2, ready: n >= 2, mode: 'steps' }),
    'play.step': (a) => { x += a.hold.includes('D') ? a.frames : 0; return { frame: a.capture ? testPicture().toString('base64') : null, width: a.width, height: a.height, state: { player: [x, 0, 0], won: x >= 20 }, events: x >= 20 ? [{ type: 'win' }] : [], t: x / 60, frameCount: x, done: x >= 20 }; },
    'play.observe': () => ({ frame: testPicture().toString('base64'), width: 96, height: 64, state: { player: [x, 0, 0] }, events: [], t: 0, frameCount: 0 }),
    'play.exit': () => ({ exiting: true }),
  });
  try {
    await writeBridgeFile(root, 'Game', fb.port);
    const d = DR.createDriver(stubHost(root, async () => ({})), { project: 'Game', mode: 'editor', framesPerStep: 10 });
    const o = await d.start();
    assert.ok(Buffer.isBuffer(o.frame));
    assert.equal(o.image.media_type, 'image/png');
    assert.equal(fb.seen.find((s) => s.op === 'play.enter')!.args.stepMode, true);
    const s1 = await d.step({ keys: ['d'] });
    assert.deepEqual(s1.state.player, [10, 0, 0]);
    assert.equal(s1.done, false);
    const a = await d.act({ keys: ['D'], press: ['space'] });
    assert.equal(a.done, true);
    assert.equal(a.events[0].type, 'win');
    const stepArgs = fb.seen.filter((s) => s.op === 'play.step').map((s) => s.args);
    assert.deepEqual([stepArgs[0].hold, stepArgs[0].frames, stepArgs[0].capture], [['D'], 10, true]);
    assert.deepEqual([stepArgs[1].press, stepArgs[1].capture], [['Space'], false]);
    await d.stop();
    assert.ok(fb.counts['play.exit']);
    await assert.rejects(d.step({}), /not started/);
  } finally { await fb.close(); }
});

test('driver, player mode: a build started with its bridge file, driven over the runtime bridge, quit at the end', async () => {
  const root = await workspace();
  await fs.mkdir(path.join(root, 'Game/Builds/win64'), { recursive: true });
  await fs.writeFile(path.join(root, 'Game/Builds/win64/Coin Escape.exe'), 'MZ');
  await fs.writeFile(path.join(root, 'Game/Builds/win64/UnityCrashHandler64.exe'), 'MZ');
  const fb = await fakeBridge({
    status: () => ({ unity: '6000.0.40f1', stepping: true }),
    'play.observe': () => ({ frame: testPicture().toString('base64'), width: 96, height: 64, state: { score: 0 }, events: [], t: 0 }),
    'play.step': (a) => ({ frame: testPicture().toString('base64'), state: { score: a.frames }, events: [], t: 0.1 }),
    'play.quit': () => null,
  }, 'unset');
  let launched: { exe: string; args: string[] } | null = null;
  let exit: () => void = () => {};
  try {
    const d = DR.createDriver(stubHost(root, async () => ({})), {
      project: 'Game', width: 640, height: 360,
      deps: {
        freePort: async () => fb.port,
        launch: async (exe: string, args: string[]) => {
          launched = { exe, args };
          const cfg = JSON.parse(await fs.readFile(args[args.indexOf('-harnessBridgeFile') + 1]!, 'utf8'));
          assert.equal(cfg.port, fb.port);
          assert.equal(cfg.step, true);
          fb.state.token = cfg.token;
          return new Promise((r) => { exit = () => r({ code: 0 }); });
        },
      },
    });
    const o = await d.start();
    assert.equal(d.mode, 'player');
    assert.equal(launched!.exe, 'Game/Builds/win64/Coin Escape.exe');
    assert.ok(launched!.args.includes('-screen-width') && launched!.args.includes('640'));
    assert.equal(o.state.score, 0);
    assert.equal((await d.step({ keys: ['W'], frames: 4 })).state.score, 4);
    const stopping = d.stop();
    setTimeout(() => exit(), 50);
    await stopping;
    assert.ok(fb.counts['play.quit']);
  } finally { await fb.close(); }
  assert.deepEqual(DR.stepArgs({ keys: 'w', axes: { Horizontal: 3, Bad: 'x' }, frames: 9999 }), { hold: ['W'], press: [], axes: { Horizontal: 1 }, frames: 600, width: 960, height: 540 });
});

// ---------- gates ----------

test('gates: they apply to Unity projects, and say "not checked" without an editor or a licence', async () => {
  const h = await createHarness({ dataDir: await tempDir(), plugins: shippedPlugins() });
  const key = Symbol.for('harness.engine-unity.deps');
  try {
    const root = await workspace();
    await fs.mkdir(path.join(root, 'Game/Assets/Tests/EditMode'), { recursive: true });
    await fs.writeFile(path.join(root, 'Game/Assets/Tests/EditMode/T.asmdef'), JSON.stringify({ name: 'T', defineConstraints: ['UNITY_INCLUDE_TESTS'] }));
    const host = stubHost(root, async () => ({}));
    const g = (n: string) => h.registry.gates.get(n)!;
    for (const n of ['unity-project', 'unity-tests', 'unity-build']) assert.equal(await g(n).applies!(host, signal), true, n);
    const empty = stubHost(await tempDir('unity-empty-'), async () => ({}));
    for (const n of ['unity-project', 'unity-tests', 'unity-build']) assert.equal(await g(n).applies!(empty, signal), false, n);
    (globalThis as Any)[key] = { discover: discovery([]) };
    let r = await g('unity-project').run({ host, signal });
    assert.deepEqual([r.pass, r.severity], [false, 'advisory']);
    assert.match(r.summary, /not checked: Unity Hub found, no editor installed/);
    (globalThis as Any)[key] = { discover: discovery([EDITOR], 'not-activated') };
    r = await g('unity-tests').run({ host: stubHost(root, async () => ({})), signal });
    assert.match(r.summary, /not checked: license not activated/);
    const ed = fakeEditor({ Check: () => ({ result: { ok: true } }) });
    (globalThis as Any)[key] = { discover: discovery() };
    r = await g('unity-project').run({ host: stubHost(root, ed.exec), signal });
    assert.equal(r.pass, true, r.summary);
    const broken = fakeEditor({ Check: () => ({ code: 1, log: 'Assets/S.cs(1,1): error CS1519: Invalid token\n' }) });
    r = await g('unity-project').run({ host: stubHost(root, broken.exec), signal });
    assert.equal(r.pass, false);
    assert.match(r.details!, /Assets\/S\.cs:1/);
  } finally { delete (globalThis as Any)[key]; await h.close(); }
});
