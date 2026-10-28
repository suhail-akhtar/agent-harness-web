import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHarness, shippedPlugins } from '@harness/plugin-sdk/testing';
import { LocalHost } from '@harness/plugin-sdk/testing';
import { skillsIn } from '@harness/plugin-sdk/testing';
import { tempDir } from '@harness/plugin-sdk/testing';

// engine-unreal without Unreal: command lines, log and report parsing, detection over a fake
// machine, project files from a fake template, the Remote Control client and the step
// protocol against fakes. The real engine runs in engine-unreal-real.test.ts.

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plugin = path.join(pluginDir);
// @ts-expect-error plain JS module
const P = await import('../lib/project.mjs');
// @ts-expect-error plain JS module
const A = await import('../lib/args.mjs');
// @ts-expect-error plain JS module
const L = await import('../lib/logs.mjs');
// @ts-expect-error plain JS module
const D = await import('../lib/detect.mjs');
// @ts-expect-error plain JS module
const R = await import('../lib/run.mjs');
// @ts-expect-error plain JS module
const C = await import('../lib/context.mjs');
// @ts-expect-error plain JS module
const B = await import('../lib/bridge.mjs');
// @ts-expect-error plain JS module
const PL = await import('../lib/play.mjs');

test('engine-unreal registers the unreal tool, its gates, skills, agent and a valid UI section with its guide', async () => {
  const h = await createHarness({ dataDir: await tempDir(), plugins: shippedPlugins() });
  try {
    assert.ok(h.registry.tools.has('unreal'));
    for (const g of ['unreal-project', 'unreal-package', 'unreal-automation']) assert.ok(h.registry.gates.has(g), g);
    const names = (await skillsIn(path.join(plugin, 'skills'), 'engine-unreal')).map((s: { name: string }) => s.name);
    for (const s of ['unreal-essentials', 'unreal-python', 'unreal-blueprints', 'unreal-levels', 'unreal-packaging']) assert.ok(names.includes(s), s);
    assert.match(h.registry.agents.get('unreal-engineer')!.prompt, /unreal-essentials/);
    const entry = h.plugins.list().find((p: { name: string }) => p.name === 'engine-unreal') as Record<string, unknown> | undefined;
    assert.ok(entry, 'listed');
    assert.equal(entry.uiError, undefined, String(entry.uiError));
    assert.equal(entry.error, undefined, String(entry.error));
    const tool = h.registry.tools.get('unreal')!;
    const actions = (tool.spec.input_schema as unknown as { properties: { action: { enum: string[] } } }).properties.action.enum;
    for (const a of ['detect', 'project.create', 'describe', 'script', 'capture', 'render', 'test', 'build', 'package', 'play', 'play.step', 'bridge.connect', 'asset.import', 'asset.export']) assert.ok(actions.includes(a), a);
    // Unreal runs on this machine: no sandbox image has it, so a Docker session does not get the tool.
    assert.equal(await tool.availableIn?.({ kind: 'docker' } as never), false);
    assert.equal(await tool.availableIn?.({ kind: 'local' } as never), true);
  } finally { await h.close(); }
});

// ---------- command lines ----------

test('Unreal command lines: editor Python, the commandlet, Automation, BuildCookRun without a compile, the game with a timeline', () => {
  const py = A.editorPythonArgs({ uproject: 'C:/p/G.uproject', script: 'C:/p/run.py', log: 'C:/l.log' });
  assert.deepEqual(py.slice(0, 2), ['C:/p/G.uproject', '-ExecutePythonScript=C:/p/run.py']);
  assert.ok(py.includes('-nullrhi') && py.includes('-unattended') && py.includes('-abslog=C:/l.log'));
  assert.ok(!A.editorPythonArgs({ uproject: 'u', script: 's', log: 'l', rendering: true }).includes('-nullrhi'), 'captures render');
  assert.deepEqual(A.commandletPythonArgs({ uproject: 'u', script: 's', log: 'l' }).slice(0, 3), ['u', '-run=pythonscript', '-script=s']);
  const auto = A.automationArgs({ uproject: 'u', filter: 'Project.Functional Tests', reportDir: 'r', log: 'l' });
  assert.ok(auto.includes('-ExecCmds=Automation RunTests Project.Functional Tests; Quit'));
  assert.ok(auto.includes('-ReportExportPath=r') && auto.includes('-TestExit=Automation Test Queue Empty'));
  const bcr = A.buildCookRunArgs({ uproject: 'u', archiveDir: 'out', config: 'Shipping' });
  assert.equal(bcr[0], 'BuildCookRun');
  for (const a of ['-project=u', '-platform=Win64', '-clientconfig=Shipping', '-cook', '-stage', '-pak', '-archive', '-archivedirectory=out', '-skipbuildeditor']) assert.ok(bcr.includes(a), a);
  assert.ok(!bcr.includes('-build'), 'a Blueprint project runs on the precompiled game: no compile');
  const game = A.gameArgs({ uproject: 'u', map: '/Game/L', timeline: '0|quit', width: 800, height: 600 });
  assert.deepEqual(game.slice(0, 3), ['u', '/Game/L', '-game']);
  assert.ok(game.includes('-ResX=800') && game.includes('-HarnessTimeline=0|quit'));
  const packaged = A.gameArgs({ packaged: true, timeline: '0|quit' });
  assert.ok(!packaged.includes('-game') && !packaged.includes('u'));
  const rc = A.remoteControlArgs({ httpPort: 30110, wsPort: 30120 });
  assert.ok(rc.includes('-RCWebControlEnable'));
  assert.match(rc.find((a: string) => a.startsWith('-ini:RemoteControl:'))!, /RemoteControlHttpServerPort=30110,.*RemoteControlWebSocketServerPort=30120,.*BindAddress=127\.0\.0\.1/);
  assert.ok(rc.includes('-ini:Engine:[HTTPServer.Listeners]:DefaultBindAddress=127.0.0.1'), 'this machine only');
});

test('Unreal quoting: a value with spaces is quoted after the equals sign, as Unreal parses it', () => {
  assert.equal(R.ueArg('-nullrhi'), '-nullrhi');
  assert.equal(R.ueArg('-ExecutePythonScript=C:/a b/x.py'), '-ExecutePythonScript="C:/a b/x.py"');
  assert.equal(R.ueArg('-ExecCmds=py C:/x.py --port 5'), '-ExecCmds="py C:/x.py --port 5"');
  assert.equal(R.ueArg('C:/My Games/G.uproject'), '"C:/My Games/G.uproject"');
  assert.equal(R.ueArg('-HarnessTimeline=0|say "hi"'), '-HarnessTimeline="0|say \\"hi\\""');
  assert.equal(R.ueCommandLine(['u', '-a=b c']), 'u -a="b c"');
  const bat = R.batchCommand('D:/UE 5/RunUAT.bat', ['BuildCookRun', '-project=E:/a b/G.uproject'], 'cmd.exe');
  assert.equal(bat.exe, 'cmd.exe');
  assert.deepEqual(bat.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(bat.args[3], '""D:/UE 5/RunUAT.bat" BuildCookRun -project="E:/a b/G.uproject""');
  assert.equal(bat.raw, true);
});

test('the play timeline: keys held and released, frames, a CSV profile and the quit, in time order', () => {
  const tl = A.timeline({ inputs: [{ at: 300, key: 'w', ms: 2000 }, { at: 500, key: 'jump' }, { at: 1000, action: 'IA_Jump', value: 'true', ms: 50 }, { at: 1200, console: 'stat fps' }], seconds: 3, captureEveryMs: 1000, width: 640, height: 360 });
  const entries = tl.split(';');
  assert.deepEqual(entries, [
    '0|CsvProfile Start', '300|Input.+key W', '500|Input.+key SpaceBar', '600|Input.-key SpaceBar', '1000|Input.+action IA_Jump true', '1000|HighResShot 640x360',
    '1050|Input.-action IA_Jump', '1200|stat fps', '2000|HighResShot 640x360', '2300|Input.-key W', '2800|CsvProfile Stop', '3000|quit',
  ]);
  assert.throws(() => A.timeline({ inputs: [{ at: 0, console: 'a;b' }] }), /cannot contain/);
  assert.equal(A.timeline({ seconds: 1, profile: false, quit: false }), '');
});

// ---------- logs ----------

const LOG = [
  '[2026.10.23-12.36.56:655][  2]LogBlueprint: Error: [AssetLog] E:\\p\\Content\\CoinKit\\BP_CoinHUD.uasset: [Compiler] This blueprint (self) is not compatible with \' Target \'',
  '[2026.10.23-12.36.56:700][  2]LogTemp: Error test: UE::UnifiedErrorTest::Empty: [Empty error]',
  "LogWindows: Failed to load 'aqProf.dll' (GetLastError=126)",
  '[2026.10.23-12.36.56:764][  2]LogPython: Error: Traceback (most recent call last):',
  '  File "E:/w/build.py", line 23, in <module>',
  '    h.set_default_maps(game_map="/Game/L")',
  '  File "E:/w/Content/Python/harness_ue.py", line 705, in set_default_maps',
  '    settings.save_config()',
  "AttributeError: 'GameMapsSettings' object has no attribute 'save_config'",
  '[2026.10.23-12.36.56:765][  2]LogPython: Error: HARNESS_PROBLEM AttributeError: no save_config',
  '[2026.10.23-12.36.57:000][  3]LogBlueprint: Warning: No event node ReceiveDrawHUD for in /Game/X.X:EventGraph',
  '[2026.10.23-12.36.57:001][  3]LogCook: Warning: /Game/Big texture is 8192 wide',
  '[2026.10.23-12.36.57:002][  3]LogRenderer: Warning: not interesting',
  'ERROR: Missing precompiled manifest for \'Foo\'',
  'E:\\p\\Source\\G.cpp(12): error C2065: undeclared identifier',
  '[2026.10.23-12.36.58:000][  4]LogPython: HARNESS_JSON {"tag": "made", "data": {"floor": 1}}',
  '[2026.10.23-12.45.18:028][  0]LogBlueprintUserMessages: [BP_HarnessDriver_C_0] HARNESS_EVENT driver ready',
  '[2026.10.23-12.45.21:046][ 82]LogBlueprintUserMessages: [BP_CoinGameMode_C_0] HARNESS_EVENT score 1',
].join('\n');

test('problems from an Unreal log: Blueprint errors with the asset, a Python traceback at the script\'s line, UAT and compiler errors; engine noise left out', () => {
  const ps = L.problemsIn(LOG);
  const msgs = ps.map((p: { message: string }) => p.message);
  assert.ok(ps.find((p: { message: string; file?: string }) => /BP_CoinHUD/.test(p.message) && /BP_CoinHUD\.uasset$/.test(p.file ?? '')), 'Blueprint error with its asset');
  const py = ps.find((p: { message: string }) => /^Python: AttributeError/.test(p.message));
  assert.equal(py.file, 'E:/w/build.py', 'the agent\'s script, not the helper');
  assert.equal(py.line, 23);
  assert.ok(msgs.includes('AttributeError: no save_config'), 'HARNESS_PROBLEM');
  assert.ok(ps.find((p: { severity: string; message: string }) => p.severity === 'warning' && /LogCook/.test(p.message)));
  assert.ok(!msgs.some((m: string) => /UnifiedErrorTest|aqProf|No event node|LogRenderer/.test(m)), msgs.join('\n'));
  assert.ok(msgs.some((m: string) => /Missing precompiled manifest/.test(m)));
  const cpp = ps.find((p: { message: string }) => /C2065/.test(p.message));
  assert.equal(cpp.line, 12);
  assert.ok(!L.problemsIn(LOG, { warnings: false }).some((p: { severity: string }) => p.severity === 'warning'));
});

test('results and events: HARNESS_JSON data by tag, HARNESS_EVENT with seconds since the log began', () => {
  const r = L.resultsIn(LOG);
  assert.deepEqual(r.made, { floor: 1 });
  assert.equal(r.all.length, 1);
  const ev = L.eventsIn(LOG);
  assert.deepEqual(ev.map((e: { type: string; detail: string }) => `${e.type} ${e.detail}`), ['driver ready', 'score 1']);
  assert.ok(ev[1].t > 500 && ev[1].t < 600, `${ev[1].t}s after the first stamped line`);
});

test('UAT progress: stages and the cook\'s package counts as one percentage', () => {
  const s = { stage: 'queued', pct: 0, done: [] };
  assert.ok(L.uatProgress(s, '********** COOK COMMAND STARTED **********'));
  assert.equal(s.stage, 'cook');
  L.uatProgress(s, 'LogCook: Display: Cooked packages 285 Packages Remain 285 Total 570');
  assert.equal(s.pct, 35);
  L.uatProgress(s, '********** COOK COMMAND COMPLETED **********');
  L.uatProgress(s, '********** STAGE COMMAND STARTED **********');
  assert.equal(s.pct, 70);
  for (const st of ['STAGE', 'PACKAGE', 'ARCHIVE']) L.uatProgress(s, `********** ${st} COMMAND COMPLETED **********`);
  assert.equal(s.pct, 95);
  assert.equal(L.uatProgress(s, 'nothing'), false);
});

test('an Automation report (index.json) as structured results', () => {
  const report = {
    succeeded: 1, succeededWithWarnings: 0, failed: 1, notRun: 0, totalDuration: 2.34,
    tests: [
      { testDisplayName: 'FT_CoinCount', fullTestPath: 'Project.Functional Tests.Levels.Lvl_Coins.FT_CoinCount', state: 'Success', duration: 0.78, entries: [] },
      { testDisplayName: 'FT_Exit', fullTestPath: 'Project.Functional Tests.Levels.Lvl_Coins.FT_Exit', state: 'Fail', duration: 1.2, entries: [
        { event: { type: 'Error', message: 'Expected exit count to be 1, but it was 0' }, filename: 'FunctionalTest.cpp', lineNumber: 1288 },
        { event: { type: 'Warning', message: 'slow' }, filename: '', lineNumber: -1 },
      ] },
    ],
  };
  const r = L.parseAutomationReport(`\uFEFF${JSON.stringify(report)}`);
  assert.equal(r.passed, 1);
  assert.equal(r.failed, 1);
  assert.equal(r.durationS, 2.3);
  assert.deepEqual(r.tests[1].errors, [{ message: 'Expected exit count to be 1, but it was 0', file: 'FunctionalTest.cpp', line: 1288 }]);
  assert.equal(r.tests[1].warnings.length, 1);
});

test('a CSV profiler capture as metrics: the EVENTS column is empty, a capture cut at exit ends in a partial row', () => {
  const head = 'EVENTS,FrameTime,GameThreadTime,RenderThreadTime,RHIThreadTime,GPUTime,PhysicalUsedMB';
  const rows = Array.from({ length: 100 }, (_, i) => `,${i === 60 ? 100 : 16},8,4,2,5,${1500 + i}`);
  const csv = [head, ...rows, ',16,8'].join('\n');
  const m = L.parseCsvProfile(csv);
  assert.equal(m.frames, 70, '30 loading frames skipped');
  assert.ok(m.fpsAvg > 50 && m.fpsAvg < 62, String(m.fpsAvg));
  assert.equal(m.frameMsP95, 16);
  assert.equal(m.gpuMs, 5);
  assert.equal(m.memoryMb, 1599);
  assert.equal(L.parseCsvProfile('EVENTS,Other\n,1'), null);
});

// ---------- detection ----------

function fakeSys(files: Record<string, string>, o: { reg?: Record<string, string>; vswhere?: string | null; free?: number; env?: Record<string, string> } = {}) {
  const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase();
  const has = (p: string) => Object.keys(files).some((f) => norm(f) === norm(p));
  return {
    platform: 'win32', env: o.env ?? {},
    exists: async (p: string) => has(p),
    readFile: async (p: string) => { const k = Object.keys(files).find((f) => norm(f) === norm(p)); return k ? files[k] : null; },
    listDir: (p: string) => [...new Set(Object.keys(files).filter((f) => norm(f).startsWith(`${norm(p)}\\`)).map((f) => f.slice(p.length + 1).split(/[\\/]/)[0]))],
    regQuery: async (k: string) => o.reg?.[k] ?? null,
    vswhere: async () => o.vswhere ?? null,
    freeBytes: async () => o.free ?? 500e9,
  };
}

const ENGINE = (root: string, version = { MajorVersion: 5, MinorVersion: 8, PatchVersion: 4 }) => ({
  [`${root}\\Engine\\Binaries\\Win64\\UnrealEditor.exe`]: '',
  [`${root}\\Engine\\Binaries\\Win64\\UnrealGame.exe`]: '',
  [`${root}\\Engine\\Build\\BatchFiles\\RunUAT.bat`]: '',
  [`${root}\\Engine\\Build\\InstalledBuild.txt`]: '',
  [`${root}\\Engine\\Build\\Build.version`]: JSON.stringify({ ...version, Changelist: 1, BranchName: '++UE5+Release' }),
  [`${root}\\Engine\\Plugins\\Experimental\\PythonScriptPlugin\\PythonScriptPlugin.uplugin`]: '{}',
  [`${root}\\Engine\\Plugins\\VirtualProduction\\RemoteControl\\RemoteControl.uplugin`]: '{}',
  [`${root}\\Engine\\Plugins\\MovieScene\\MovieRenderPipeline\\MovieRenderPipeline.uplugin`]: '{}',
  [`${root}\\Templates\\TP_ThirdPersonBP\\TP_ThirdPersonBP.uproject`]: '{}',
});

test('detect: a custom build from the registry, the version from Build.version, no MSVC as the gap, the actions offered', async () => {
  const reg = { 'HKCU\\SOFTWARE\\Epic Games\\Unreal Engine\\Builds': 'HKEY_CURRENT_USER\\SOFTWARE\\Epic Games\\Unreal Engine\\Builds\r\n    {D5F4E910-4FEB-CC2B-EADE-7ABC571AA3E8}    REG_SZ    D:/UnrealEngine/UE_5.8\r\n' };
  const r = await D.detect(fakeSys(ENGINE('D:\\UnrealEngine\\UE_5.8'), { reg, vswhere: '' }));
  assert.equal(r.installed, true);
  assert.equal(r.version, '5.8.4');
  assert.equal(r.path, 'D:\\UnrealEngine\\UE_5.8');
  assert.equal(r.installs[0].association, '{D5F4E910-4FEB-CC2B-EADE-7ABC571AA3E8}');
  assert.match(r.gaps[0], /^no MSVC/);
  for (const a of ['package', 'render', 'bridge.connect', 'play.step']) assert.ok(r.actions.includes(a), a);
  assert.deepEqual(r.installs[0].templates, ['TP_ThirdPersonBP']);
  const withVs = await D.detect(fakeSys(ENGINE('D:\\UnrealEngine\\UE_5.8'), { reg, vswhere: 'C:\\VS\\2022\r\n' }));
  assert.equal(withVs.gaps.length, 0);
  assert.equal(withVs.compiler.found, true);
});

test('detect: the launcher list, HARNESS_UNREAL_ROOT first, low disk space, and nothing installed', async () => {
  const dat = JSON.stringify({ InstallationList: [{ InstallLocation: 'C:\\Program Files\\Epic Games\\UE_5.7', AppName: 'UE_5.7' }, { InstallLocation: 'D:\\Games\\Fortnite', AppName: 'Fortnite' }] });
  const files = { ...ENGINE('C:\\Program Files\\Epic Games\\UE_5.7', { MajorVersion: 5, MinorVersion: 7, PatchVersion: 1 }), ...ENGINE('E:\\UE\\Mine'), 'C:\\ProgramData\\Epic\\UnrealEngineLauncher\\LauncherInstalled.dat': dat };
  const r = await D.detect(fakeSys(files, { env: { HARNESS_UNREAL_ROOT: 'E:\\UE\\Mine' }, free: 12e9 }));
  assert.equal(r.path, 'E:\\UE\\Mine', 'the override is the one used');
  assert.deepEqual(r.installs.map((i: { source: string }) => i.source).sort(), ['HARNESS_UNREAL_ROOT', 'launcher']);
  assert.equal(r.installs.find((i: { source: string }) => i.source === 'launcher').association, '5.7');
  assert.ok(r.gaps.some((g: string) => /low disk space: 12 GB/.test(g)));
  const none = await D.detect(fakeSys({}));
  assert.equal(none.installed, false);
  assert.match(none.gaps[0], /not installed/);
  assert.deepEqual(none.actions, ['detect']);
  assert.deepEqual(D.parseRegQuery('HKEY_LOCAL_MACHINE\\SOFTWARE\\EpicGames\\Unreal Engine\\5.8\n    InstalledDirectory    REG_SZ    C:\\UE\n'), [{ key: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\EpicGames\\Unreal Engine\\5.8', name: 'InstalledDirectory', value: 'C:\\UE' }]);
});

// ---------- projects ----------

const DEFS = `[/Script/GameProjectGeneration.TemplateProjectDefs]
FoldersToIgnore=Binaries
FoldersToIgnore=Media
FilesToIgnore="%TEMPLATENAME%.uproject"
FilesToIgnore="Config/TemplateDefs.ini"
FilesToIgnore="Config/config.ini"
SharedContentPacks=(MountName="LevelPrototyping",DetailLevels=("High"))
SharedContentPacks=(MountName="Characters",DetailLevels=("High"))
;SharedContentPacks=(MountName="Variant_Combat",DetailLevels=("Standard"))
Variants=(Name="SideScroller",LocalizedDisplayNames=((Language="en",Text="Side Scroller")),LocalizedDescriptions=((Language="en",Text="A 2.5D game, with (parens).")),SharedContentPacks=((DetailLevels=(Standard),MountName="Variant_SideScroller")))
Variants=(Name="TwinStick",SharedContentPacks=((DetailLevels=(Standard),MountName="Variant_TwinStick"),(MountName="Input",DetailLevels=("High"))))
`;

test('template definitions: what to skip, the shared packs, each variant\'s packs', () => {
  const d = P.parseTemplateDefs(DEFS);
  assert.deepEqual(d.foldersToIgnore, ['Binaries', 'Media']);
  assert.deepEqual(d.filesToIgnore, ['%TEMPLATENAME%.uproject', 'Config/TemplateDefs.ini', 'Config/config.ini']);
  assert.deepEqual(d.packs, [{ mount: 'LevelPrototyping', level: 'High' }, { mount: 'Characters', level: 'High' }]);
  assert.deepEqual(d.variants.SideScroller, [{ mount: 'Variant_SideScroller', level: 'Standard' }]);
  assert.deepEqual(d.variants.TwinStick, [{ mount: 'Variant_TwinStick', level: 'Standard' }, { mount: 'Input', level: 'High' }]);
  assert.equal(P.packTarget('Content/Meshes/a.uasset', 'LevelPrototyping'), 'Content/LevelPrototyping/Meshes/a.uasset');
  assert.equal(P.packTarget('__ExternalActors__/Lvl/0/a.uasset', 'Variant_X'), 'Content/__ExternalActors__/Variant_X/Lvl/0/a.uasset');
  assert.equal(P.packTarget('FeaturePack/manifest.json', 'X'), null);
});

test('project files: names, the template name replaced, ini keys set (array entries once), a ProjectID, plugins for the editor only', () => {
  assert.equal(P.projectName('Coin Escape!'), 'CoinEscape');
  assert.throws(() => P.projectName('9lives'), /start with a letter/);
  assert.throws(() => P.projectName('A'.repeat(21)), /20 characters/);
  assert.equal(P.replaceTemplateName('GameName=TP_ThirdPersonBP\nX=tp_thirdpersonbp Y=TP_THIRDPERSONBP', 'TP_ThirdPersonBP', 'CoinEscape'), 'GameName=CoinEscape\nX=coinescape Y=COINESCAPE');
  let ini = P.setIni('[A]\nk=1\n\n[B]\nz=2\n', 'A', 'k', '3');
  assert.equal(ini, '[A]\nk=3\n\n[B]\nz=2\n');
  ini = P.setIni(ini, 'A', 'n', 'new');
  assert.match(ini, /\[A\]\nk=3\nn=new\n\n\[B\]/);
  ini = P.setIni(ini, 'C', '+Dirs', '(Path="/X")');
  ini = P.setIni(ini, 'C', '+Dirs', '(Path="/X")');
  ini = P.setIni(ini, 'C', '+Dirs', '(Path="/Y")');
  assert.equal(ini.match(/\+Dirs=/g)!.length, 2);
  assert.match(P.projectId(Buffer.alloc(16, 1)), /^\(A=16843009,B=16843009,C=16843009,D=16843009\)$/);
  const u = JSON.parse(P.uprojectWith('{"FileVersion":3,"EngineAssociation":"","Plugins":[{"Name":"GameplayStateTree","Enabled":true},{"Name":"ModelingToolsEditorMode","Enabled":true,"TargetAllowList":["Editor"]}]}', { association: '5.8' }));
  assert.equal(u.EngineAssociation, '5.8');
  for (const name of [...P.PROJECT_PLUGINS, 'GameplayStateTree']) assert.deepEqual(u.Plugins.find((p: { Name: string }) => p.Name === name).TargetAllowList, ['Editor'], name);
  assert.deepEqual(P.runtimePlugins(u), [], 'nothing that needs a compiler to package');
  const kept = JSON.parse(P.uprojectWith('{"Plugins":[{"Name":"GameplayStateTree","Enabled":true}]}', { keepRuntime: ['GameplayStateTree'] }));
  assert.deepEqual(P.runtimePlugins(kept), ['GameplayStateTree']);
});

/** A fake engine: one template with content, external actors, a config and two shared packs. */
async function fakeEngine() {
  const root = await tempDir('ue-fake-');
  const w = async (rel: string, text = 'x') => { const f = path.join(root, rel); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, text); };
  await w('Engine/Binaries/Win64/UnrealEditor.exe');
  await w('Engine/Build/Build.version', JSON.stringify({ MajorVersion: 5, MinorVersion: 8, PatchVersion: 4 }));
  const t = 'Templates/TP_ThirdPersonBP';
  await w(`${t}/TP_ThirdPersonBP.uproject`, JSON.stringify({ FileVersion: 3, EngineAssociation: '', Plugins: [{ Name: 'GameplayStateTree', Enabled: true }] }));
  await w(`${t}/Config/TemplateDefs.ini`, DEFS);
  await w(`${t}/Config/config.ini`, 'ignored');
  await w(`${t}/Config/DefaultEngine.ini`, '[URL]\nGameName=TP_ThirdPersonBP\n\n[/Script/EngineSettings.GameMapsSettings]\nGameDefaultMap=/Game/ThirdPerson/Lvl_ThirdPerson.Lvl_ThirdPerson\n');
  await w(`${t}/Config/DefaultGame.ini`, '[/Script/EngineSettings.GeneralProjectSettings]\nProjectID=(A=1,B=2,C=3,D=4)\nProjectName=Third Person BP Game Template\n');
  await w(`${t}/Content/ThirdPerson/Lvl_ThirdPerson.umap`);
  await w(`${t}/Content/__ExternalActors__/ThirdPerson/Lvl_ThirdPerson/0/A.uasset`);
  await w(`${t}/Media/preview.png`);
  await w('Templates/TemplateResources/High/Characters/Content/Mannequins/Meshes/SKM_Manny.uasset');
  await w('Templates/TemplateResources/High/Characters/FeaturePack/manifest.json', JSON.stringify({ AdditionalFiles: { DestinationFilesFolder: 'Characters' } }));
  await w('Templates/TemplateResources/High/LevelPrototyping/Content/Meshes/SM_Cube.uasset');
  await w('Templates/TemplateResources/Standard/Variant_SideScroller/Content/Lvl_SideScrolling.umap');
  await w('Templates/TemplateResources/Standard/Variant_SideScroller/__ExternalActors__/Lvl_SideScrolling/0/B.uasset');
  await w('Templates/TemplateResources/Standard/Variant_SideScroller/FeaturePack/manifest.json', JSON.stringify({ AdditionalFiles: { DestinationFilesFolder: 'Variant_SideScroller' } }));
  return root;
}

test('a project from a template, as the New Project dialog makes it: content and packs copied, names replaced, a new id, editor-only plugins, never-cook folders', async () => {
  const engineRoot = await fakeEngine();
  const dir = path.join(await tempDir('ue-proj-'), 'Game');
  const r = await P.createFromTemplate({ engineRoot, template: 'TP_ThirdPersonBP', name: 'CoinEscape', dir, association: '{GUID}' });
  const has = (rel: string) => fs.access(path.join(dir, rel)).then(() => true, () => false);
  assert.ok(await has('CoinEscape.uproject'));
  assert.ok(!await has('TP_ThirdPersonBP.uproject') && !await has('Config/TemplateDefs.ini') && !await has('Config/config.ini') && !await has('Media'));
  assert.ok(await has('Content/ThirdPerson/Lvl_ThirdPerson.umap') && await has('Content/__ExternalActors__/ThirdPerson/Lvl_ThirdPerson/0/A.uasset'));
  assert.ok(await has('Content/Characters/Mannequins/Meshes/SKM_Manny.uasset') && await has('Content/LevelPrototyping/Meshes/SM_Cube.uasset'));
  assert.equal(r.map, '/Game/ThirdPerson/Lvl_ThirdPerson.Lvl_ThirdPerson');
  assert.match(await fs.readFile(path.join(dir, 'Config/DefaultEngine.ini'), 'utf8'), /GameName=CoinEscape/);
  const game = await fs.readFile(path.join(dir, 'Config/DefaultGame.ini'), 'utf8');
  assert.ok(!/A=1,B=2,C=3,D=4/.test(game), 'a new ProjectID');
  assert.match(game, /ProjectName=CoinEscape/);
  assert.match(game, /\+DirectoriesToNeverCook=\(Path="\/MovieRenderPipeline"\)/);
  const u = JSON.parse(await fs.readFile(path.join(dir, 'CoinEscape.uproject'), 'utf8'));
  assert.equal(u.EngineAssociation, '{GUID}');
  assert.deepEqual(r.runtimePlugins, []);
  await assert.rejects(P.createFromTemplate({ engineRoot, template: 'TP_ThirdPersonBP', name: 'CoinEscape', dir }), /already exists/);
  await assert.rejects(P.createFromTemplate({ engineRoot, template: 'TP_Nope', name: 'X', dir: `${dir}2` }), /no template TP_Nope/);

  const vdir = path.join(await tempDir('ue-proj-'), 'Game');
  const v = await P.createFromTemplate({ engineRoot, template: 'TP_ThirdPersonBP', variant: 'SideScroller', name: 'Side', dir: vdir });
  assert.equal(v.map, '/Game/Variant_SideScroller/Lvl_SideScrolling.Lvl_SideScrolling');
  assert.ok(await fs.access(path.join(vdir, 'Content/__ExternalActors__/Variant_SideScroller/Lvl_SideScrolling/0/B.uasset')).then(() => true));
  assert.deepEqual(v.runtimePlugins, ['GameplayStateTree'], 'a variant keeps its runtime plugins (and needs a compiler to package)');
  await assert.rejects(P.createFromTemplate({ engineRoot, template: 'TP_ThirdPersonBP', variant: 'Nope', name: 'N', dir: `${vdir}2` }), /no variant Nope/);
  const s = P.studioProject({ name: 'CoinEscape', engineProject: 'Game/CoinEscape.uproject', template: 'TP_ThirdPersonBP' });
  assert.equal(s.engine, 'unreal');
  assert.deepEqual([s.builds, s.playtests, s.stages], [[], [], []]);
});

test('the project of a call: a .uproject, a Studio folder, the only one in the workspace; several need naming', async () => {
  const ws = await tempDir('ue-ws-');
  const host = new LocalHost(ws);
  await assert.rejects(C.projectOf(host), /no Unreal project/);
  await fs.mkdir(path.join(ws, 'Coin', 'Game'), { recursive: true });
  await fs.mkdir(path.join(ws, 'Coin', '.studio'), { recursive: true });
  await fs.writeFile(path.join(ws, 'Coin', 'Game', 'Coin.uproject'), '{}');
  await fs.writeFile(path.join(ws, 'Coin', '.studio', 'project.json'), JSON.stringify({ engine: 'unreal', engineProject: 'Game/Coin.uproject' }));
  const a = await C.projectOf(host);
  assert.equal(a.rel, 'Coin/Game/Coin.uproject');
  assert.equal(a.name, 'Coin');
  assert.equal(a.studioRel, 'Coin');
  assert.equal((await C.projectOf(host, 'Coin')).rel, 'Coin/Game/Coin.uproject', 'by its Studio folder');
  assert.equal((await C.projectOf(host, 'Coin/Game')).rel, 'Coin/Game/Coin.uproject', 'by its own folder');
  await fs.mkdir(path.join(ws, 'Other'), { recursive: true });
  await fs.writeFile(path.join(ws, 'Other', 'Other.uproject'), '{}');
  await assert.rejects(C.projectOf(host), /several Unreal projects/);
  assert.equal((await C.projectOf(host, 'Other/Other.uproject')).studioDir, null);
  await assert.rejects(C.projectOf(host, '../x.uproject'), /outside the workspace/);
});

test('the wrapper the editor runs: helpers on the path, the agent\'s file as __main__, errors as HARNESS_PROBLEM', () => {
  const w = C.wrapperScript({ helperDir: 'C:\\p\\Content\\Python', userFile: 'C:\\w\\s.py', args: ['a b', 2], keepAlive: true });
  assert.match(w, /sys\.path\.insert\(0, r"""C:\/p\/Content\/Python"""\)/);
  assert.match(w, /runpy\.run_path\(r"""C:\/w\/s\.py""", run_name="__main__"\)/);
  assert.match(w, /sys\.argv = \[r"""C:\/w\/s\.py"""\] \+ \["a b","2"\]/);
  assert.match(w, /set_keep_python_script_alive\(True\)/);
  assert.match(w, /HARNESS_PROBLEM/);
  assert.match(w, /print\("HARNESS_DONE"\)/);
  assert.ok(!/keep_python_script_alive/.test(C.wrapperScript({ helperDir: 'h', userFile: 'u' })));
});

// ---------- the bridge ----------

test('the Remote Control client: calls, properties and Python on the routes Unreal serves, errors with their message', async () => {
  const calls: { url: string; method: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = async (url: string, init: { method: string; body?: string }) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    if (url.endsWith('/remote/object/property')) return new Response(JSON.stringify({ errorMessage: 'Property is not readable' }), { status: 400 });
    if (calls.at(-1)!.body?.functionName === 'ExecutePythonCommandEx') return new Response(JSON.stringify({ ReturnValue: true, CommandResult: 'None', LogOutput: [{ Type: 'Info', Output: 'hello' }, { Type: 'Error', Output: 'oops' }] }));
    return new Response(JSON.stringify({ ReturnValue: '5.8.4' }));
  };
  const c = B.rcClient(30110, { fetchImpl });
  assert.deepEqual(await c.call('/Script/Engine.Default__KismetSystemLibrary', 'GetEngineVersion'), { ReturnValue: '5.8.4' });
  assert.equal(calls[0]!.url, 'http://127.0.0.1:30110/remote/object/call');
  assert.equal(calls[0]!.method, 'PUT');
  assert.deepEqual(calls[0]!.body, { objectPath: '/Script/Engine.Default__KismetSystemLibrary', functionName: 'GetEngineVersion', parameters: {}, generateTransaction: false });
  await assert.rejects(c.set('/Game/L.L:PersistentLevel.A', 'bHidden', true), /400 Property is not readable/);
  assert.deepEqual(calls[1]!.body, { objectPath: '/Game/L.L:PersistentLevel.A', propertyName: 'bHidden', propertyValue: { bHidden: true }, access: 'WRITE_TRANSACTION_ACCESS' });
  const py = await c.python('print("hello")');
  assert.deepEqual(py, { ok: true, result: 'None', output: 'hello\nError: oops' });
  assert.equal(calls[2]!.body.objectPath, '/Script/PythonScriptPlugin.Default__PythonScriptLibrary');
  const port = await B.freePort();
  assert.ok(port > 0);
  await assert.rejects(B.waitForRc(B.rcClient(port, { timeoutMs: 200 }), { timeoutMs: 300, every: 100 }), /did not answer/);
});

// ---------- playing ----------

test('the step client speaks JSON lines to the step server, one answer per request', async () => {
  const server = net.createServer((s) => {
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const req = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        s.write(`${JSON.stringify(req.op === 'step' ? { ok: true, state: { gameMs: req.ms }, frame: 'f.png' } : { ok: true, state: { ready: true } })}\n`);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as net.AddressInfo;
  const c = PL.stepClient(port);
  await c.connect();
  const [a, b] = await Promise.all([c.request({ op: 'state' }), c.request({ op: 'step', ms: 500 })]);
  assert.deepEqual(a, { ok: true, state: { ready: true } });
  assert.deepEqual(b, { ok: true, state: { gameMs: 500 }, frame: 'f.png' });
  c.close();
  server.close();
});

test('a level holds the play driver: in its .umap or one of its one-file-per-actor packages', async () => {
  const proj = await tempDir('ue-lvl-');
  await fs.mkdir(path.join(proj, 'Content', 'Levels'), { recursive: true });
  await fs.writeFile(path.join(proj, 'Content', 'Levels', 'L.umap'), 'header');
  assert.equal(await PL.levelHasDriver(proj, '/Game/Levels/L.L'), false);
  const ext = path.join(proj, 'Content', '__ExternalActors__', 'Levels', 'L', '0', 'AB');
  await fs.mkdir(ext, { recursive: true });
  await fs.writeFile(path.join(ext, 'X.uasset'), Buffer.from('....BP_HarnessDriver_C....'));
  assert.equal(await PL.levelHasDriver(proj, '/Game/Levels/L'), true);
  assert.equal(await PL.levelHasDriver(proj, '/Game/Levels/Missing'), false);
  await fs.mkdir(path.join(proj, 'Config'), { recursive: true });
  await fs.writeFile(path.join(proj, 'Config', 'DefaultEngine.ini'), '[/Script/EngineSettings.GameMapsSettings]\nGameDefaultMap=/Game/Levels/L.L\n');
  assert.equal(await PL.defaultMap(proj), '/Game/Levels/L');
});

test('a playtest report: pass, fail on a missing expected event or errors, crash and timeout', () => {
  const host = { root: 'E:/w' } as never;
  const base = { run: { took: 15.2, timedOut: false }, timeline: '0|a;1|b', frames: ['E:/w/pt/frames/0000.png'], metrics: { fpsAvg: 73.7 }, events: [{ t: 2.7, type: 'driver' }, { t: 9.2, type: 'win', detail: 'YOU WIN' }], problems: [], crashed: false, logFile: 'E:/w/pt/game.log', startupS: 2.7 };
  const ok = PL.playReport({ id: 'pt-1', build: 'b2', goal: 'win', seconds: 12, play: base, expect: ['win'], host, outDir: 'E:/w/pt' });
  assert.equal(ok.result, 'pass');
  assert.deepEqual(ok.frames, ['frames/0000.png']);
  assert.equal(ok.metrics.fpsAvg, 73.7);
  assert.equal(ok.player, 'bot:scripted');
  assert.equal(PL.playReport({ id: 'x', seconds: 1, play: base, expect: ['lose'], host, outDir: 'E:/w/pt' }).result, 'fail');
  assert.equal(PL.playReport({ id: 'x', seconds: 1, play: { ...base, problems: [{ severity: 'error', message: 'LogScript: Error: Accessed None' }] }, host, outDir: 'E:/w/pt' }).result, 'fail');
  assert.equal(PL.playReport({ id: 'x', seconds: 1, play: { ...base, crashed: true }, host, outDir: 'E:/w/pt' }).result, 'crash');
  assert.equal(PL.playReport({ id: 'x', seconds: 1, play: { ...base, run: { took: 1, timedOut: true } }, host, outDir: 'E:/w/pt' }).result, 'timeout');
});

test('the AI player driver: browser and person key names as Unreal keys, steps with keys held across steps', async () => {
  // @ts-expect-error plain JS module
  const DR = await import('../driver.mjs');
  assert.deepEqual(['ArrowRight', 'Space', 'KeyW', 'w', 'jump', 'Digit1', 'LeftShift'].map(DR.unrealKey), ['Right', 'SpaceBar', 'W', 'W', 'SpaceBar', 'One', 'LeftShift']);
  const held = new Set<string>();
  assert.deepEqual(DR.stepRequest([{ key: 'KeyW', down: true }, { action: 'IA_Jump' }, { look: [15, -5] }], 500, held), { op: 'step', keys: ['W'], actions: [{ name: 'IA_Jump', value: 'true' }], look: [15, -5], ms: 500 });
  assert.deepEqual(DR.stepRequest([{ key: 'Space', ms: 200 }], undefined, held).keys, ['W', 'SpaceBar'], 'W is still held');
  assert.equal(DR.stepRequest([{ key: 'Space', ms: 200 }], undefined, held).ms, 200);
  assert.deepEqual(DR.stepRequest([{ key: 'w', up: true }], 100, held).keys, []);
  assert.equal(DR.stepRequest([], 99_999).ms, 10_000);
  const off = await DR.createDriver({ kind: 'docker' });
  assert.match(off.unavailable, /server folder/);
});

test('the tool says what is missing when Unreal is not there, and checks its input before starting anything', async () => {
  // @ts-expect-error plain JS module
  const { runUnreal } = await import('../index.mjs');
  const ws = await tempDir('ue-tool-');
  const host = new LocalHost(ws);
  const ctx = { host, signal: new AbortController().signal };
  const bad = await runUnreal({ action: 'nope' }, ctx);
  assert.equal(bad.status, 'failed');
  assert.match(bad.summary, /unknown action nope/);
  const d = await runUnreal({ action: 'detect' }, ctx);
  assert.ok(['ok', 'unavailable'].includes(d.status));
  assert.equal(d.engine, 'unreal');
  const jobs = await runUnreal({ action: 'jobs' }, ctx);
  assert.equal(jobs.status, 'ok');
});
