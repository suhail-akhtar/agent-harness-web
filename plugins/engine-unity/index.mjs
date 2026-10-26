// Unity for Studio: the unity tool (the engine contract: detect, project, describe,
// script, assets, capture, render, levels, tests, builds, play, the live bridge) and the
// unity-project, unity-tests and unity-build gates. Unity runs on the host (a server folder
// or the companion's computer), never in a sandbox; the person installs editors and
// activates the licence in Unity Hub. The AI player's driver is in driver.mjs.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { defineTool } from '@harness/plugin-sdk/runtime';
import { findFiles, readTextIn } from '@harness/plugins/games3d/lib-engines.mjs';
import { ACTIONS, READ_ACTIONS, discoverFor, runUnity, unityProjects, unityTool } from './unity.mjs';
import { pickEditor } from './lib-unity.mjs';

// Tests swap in a fake editor here (the tool and the gates read it on every call).
const testDeps = () => globalThis[Symbol.for('harness.engine-unity.deps')] ?? {};
const str = (v) => (v === undefined || v === null ? '' : String(v));

const PARAMS = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ACTIONS },
    project: { type: 'string', description: 'The Unity project folder (with Packages/ and Assets/). Default: the one .studio/project.json names, or the only one in the workspace. project.create: the folder to make (default "Game").' },
    live: { description: 'true: work in the editor that has the project open (the live bridge); false: headless batch mode; default: the open editor when its bridge answers, else batch.', type: 'boolean' },
    template: { type: 'string', enum: ['3d-urp', '2.5d-urp', '2d-urp', '3d-builtin'], description: 'project.create (default from dimension: 3d-urp)' },
    dimension: { type: 'string', enum: ['2d', '2.5d', '3d'] },
    name: { type: 'string', description: 'project.create: the product name; script: the class name' },
    genre: { type: 'string' },
    code: { type: 'string', description: 'script: C# - a method body (wrapped in Harness.Scripts.<name>.Run(), may return a value) or a whole file with a public static Run()' },
    file: { type: 'string', description: 'script: a .cs file in the workspace' },
    method: { type: 'string', description: 'script: the static method to call (default <Namespace>.<Class>.Run)' },
    args: { type: 'object', description: 'script: passed to Run(Dictionary<string, object>) when it takes one; bridge.call: the op\'s arguments' },
    files: { type: 'array', items: { type: 'object' }, description: 'asset.import: [{path (a workspace file), to? (Assets/...), kind? (sprite|texture|normal|ui|model|gltf|audio|music), ppu?, filter?, slice? [w,h], scale?, loadType?}]' },
    items: { type: 'array', items: { type: 'object' }, description: 'asset.export: [{source ("Assets/..." or "scene:Root/Child"), format (unitypackage|prefab|fbx|glb|gltf), out}]' },
    scene: { type: 'string', description: 'A scene path like Assets/Scenes/Level1.unity' },
    camera: { type: 'string', description: 'capture: a camera by name (default the main camera)' },
    view: { type: 'string', enum: ['game', 'scene', 'overview', 'iso', 'top', 'front', 'side'], description: 'capture: the game camera, or a camera framing the level from an angle' },
    position: { type: 'array', items: { type: 'number' } },
    lookAt: { type: 'array', items: { type: 'number' } },
    width: { type: 'number' },
    height: { type: 'number' },
    out: { type: 'string', description: 'capture/level.build: the PNG to write in the workspace' },
    preset: { type: 'string', enum: ['turntable', 'views'], description: 'render' },
    frames: { type: 'number', description: 'render: turntable frames' },
    outDir: { type: 'string' },
    layout: { type: 'object', description: 'level.build: {name, dimension, cell, grid: ["#####","#P.C#",...], legend?, objects?, camera?: {mode}, rules?, scene?} (# wall, . floor, P player, C collectible, E exit, H hazard, = platform, S spawn)' },
    layoutFile: { type: 'string', description: 'level.build: a JSON layout file in the workspace' },
    capture: { type: 'boolean', description: 'level.build: capture the level after building it (default true)' },
    platform: { type: 'string', description: 'test: EditMode, PlayMode or both (default both)' },
    filter: { type: 'string', description: 'test: a test name or a namespace/class prefix' },
    category: { type: 'string' },
    target: { type: 'string', description: 'build/package: win64 (default on Windows), webgl, linux64, mac' },
    output: { type: 'string', description: 'build: the player file (or folder for WebGL); default <project>/Builds/<target>/' },
    development: { type: 'boolean' },
    scriptingBackend: { type: 'string', enum: ['Mono', 'IL2CPP'] },
    options: { type: 'array', items: { type: 'string' }, description: 'build: BuildOptions names' },
    seconds: { type: 'number', description: 'play: how long (default 10)' },
    inputs: { type: 'array', items: { type: 'object' }, description: 'play: the timeline [{t, key, down|up|press}, {t, keys:[...], duration}, {t, axis, value}] (KeyCode names: W, Space, LeftArrow)' },
    captureEvery: { type: 'number', description: 'play: seconds between frames (default seconds/8)' },
    mode: { type: 'string', enum: ['player', 'editor', 'batch'], description: 'play: a built player, the open editor, or headless play mode (default: build given -> player, open editor -> editor, else batch)' },
    build: { type: 'string', description: 'play: the player executable to run' },
    goal: { type: 'string', description: 'play: what the run should show (recorded in the Studio playtest)' },
    expectWin: { type: 'boolean', description: 'play: the playtest fails unless the game reports won' },
    op: { type: 'string', description: 'bridge.call: an op of the live bridge (bridge.status lists them)' },
    waitSec: { type: 'number', description: 'bridge.connect: wait this long for the editor to start the bridge' },
    offline: { type: 'boolean', description: 'describe: read the project files only' },
    timeoutSec: { type: 'number' },
  },
  required: ['action'],
};

const DESCRIPTION = 'Unity (Unity 6 / 6000.x LTS) for Studio, on the host where Unity Hub is (never in a sandbox). action: "detect" finds the Hub, the editors, their build modules and the licence, and lists gaps; "project.create" makes a project from the editor\'s template (3d-urp, 2.5d-urp, 2d-urp, 3d-builtin) with the harness bridge package and test assemblies, writes .studio/project.json and opens it once; "project.open" imports and compiles (errors with file and line); "describe" the settings, packages, scenes, assets and hierarchy; "script" writes C# into Assets/Editor/Harness and runs it (headless, or live in the open editor); "asset.import"/"asset.export"; "capture" a PNG you see; "render" a turntable or views (the Unity Recorder in play mode when present); "level.build" a scene from a grid layout (2D tilemaps, 2.5D isometric, 3D) with collect-and-escape rules; "test" EditMode/PlayMode with results; "build"/"package" (win64, webgl) with the report; "play" N seconds with an input timeline (frames, fps, memory, events; a Studio playtest); "bridge.connect"/"bridge.status"/"bridge.call" for the live editor. Heavy work runs one at a time. Load the unity-essentials skill first.';

/** A gate cannot check without Unity: it says so and does not fail the run. */
const notChecked = (why) => ({ pass: false, severity: 'advisory', summary: `not checked: ${why}` });

async function testAssemblies(host, project) {
  if (host.kind === 'companion') return [];
  const out = [];
  for (const f of await findFiles(path.join(host.root, project, 'Assets'), (n) => n.endsWith('.asmdef'), { max: 50, depth: 6 })) {
    const t = await fsp.readFile(path.join(host.root, project, 'Assets', f), 'utf8').catch(() => '');
    if (/UNITY_INCLUDE_TESTS|TestRunner|nunit\.framework/.test(t)) out.push(f);
  }
  return out;
}

/** Runs the tool for a gate and turns its result into a gate result. */
async function gateRun(host, signal, input, pass) {
  const { r } = await runUnity(input, { host, signal }, testDeps());
  if (r.status === 'unavailable') return notChecked(r.summary);
  const details = [...(r.problems ?? []).slice(0, 25).map((p) => `${p.severity}: ${p.message}${p.file ? ` (${p.file}${p.line ? `:${p.line}` : ''})` : ''}`), r.logFile ? `Full log: ${r.logFile}` : ''].filter(Boolean).join('\n');
  return { pass: r.status === 'ok' && pass(r), summary: r.summary, ...(details ? { details } : {}) };
}

async function ready(host, signal) {
  const d = await discoverFor(host, signal, { deps: testDeps() }).catch(() => null);
  if (!d || !d.editors.length) return d?.hub ? 'Unity Hub found, no editor installed: install one in Unity Hub (a 6000.x LTS)' : 'Unity is not installed on this computer';
  if (d.license.status === 'not-activated') return 'license not activated: add a licence in Unity Hub (Preferences > Licenses)';
  return pickEditor(d.editors).editor ? null : 'no usable editor';
}

export default {
  name: 'engine-unity',
  setup(api) {
    api.registerTool(defineTool({
      name: 'unity',
      description: DESCRIPTION,
      parameters: PARAMS,
      kind: 'exec',
      kindsFor: (i) => [READ_ACTIONS.has(str(i.action)) ? 'read' : 'exec'],
      availableIn: (host) => host.kind !== 'docker',
      summarize: (i) => `${str(i.action)}${i.project ? ` ${i.project}` : ''}${i.target ? ` ${i.target}` : ''}${i.scene ? ` ${i.scene}` : ''}${i.op ? ` ${i.op}` : ''}`,
      run: (input, { host, signal }) => unityTool(input, { host, signal }, testDeps()),
    }));

    api.registerGate({
      name: 'unity-project',
      description: 'Each Unity project in the workspace opens headless and every script compiles with no errors.',
      applies: async (host, signal) => host.kind !== 'docker' && (await unityProjects(host, signal).catch(() => [])).length > 0,
      async run({ host, signal }) {
        const projects = await unityProjects(host, signal);
        if (!projects.length) return { pass: true, summary: 'no Unity project in the workspace' };
        const why = await ready(host, signal);
        if (why) return notChecked(why);
        const results = [];
        for (const project of projects) results.push(await gateRun(host, signal, { action: 'project.open', project, live: false }, () => true));
        const bad = results.filter((r) => !r.pass);
        if (results.some((r) => r.severity === 'advisory')) return results.find((r) => r.severity === 'advisory');
        return bad.length
          ? { pass: false, summary: `${bad.length} of ${projects.length} Unity project(s) do not compile`, details: bad.map((r) => `${r.summary}\n${r.details ?? ''}`).join('\n') }
          : { pass: true, summary: `${projects.length} Unity project(s) compile with no errors: ${projects.join(', ')}` };
      },
    });

    api.registerGate({
      name: 'unity-tests',
      description: 'Each Unity project with test assemblies passes its EditMode and PlayMode tests (Unity Test Framework).',
      applies: async (host, signal) => {
        if (host.kind === 'docker') return false;
        for (const p of await unityProjects(host, signal).catch(() => [])) if ((await testAssemblies(host, p)).length) return true;
        return false;
      },
      async run({ host, signal }) {
        const why = await ready(host, signal);
        if (why) return notChecked(why);
        const results = [];
        for (const project of await unityProjects(host, signal)) {
          if (!(await testAssemblies(host, project)).length) continue;
          results.push({ project, ...await gateRun(host, signal, { action: 'test', project, platform: 'both', live: false }, (r) => (r.metrics?.total ?? 0) > 0) });
        }
        if (results.some((r) => r.severity === 'advisory')) return results.find((r) => r.severity === 'advisory');
        const bad = results.filter((r) => !r.pass);
        return bad.length
          ? { pass: false, summary: `tests fail in ${bad.map((r) => r.project).join(', ')}`, details: bad.map((r) => `${r.project}: ${r.summary}\n${r.details ?? ''}`).join('\n') }
          : { pass: true, summary: results.map((r) => `${r.project}: ${r.summary}`).join('; ') || 'no test assemblies' };
      },
    });

    api.registerGate({
      name: 'unity-build',
      description: 'The Studio Unity project (.studio/project.json engine "unity") builds a player for this computer (Windows 64-bit on Windows) with no errors.',
      applies: async (host, signal) => {
        if (host.kind === 'docker') return false;
        const t = await readTextIn(host, '.studio/project.json', signal).catch(() => null);
        try { return Boolean(t) && JSON.parse(t).engine === 'unity'; } catch { return false; }
      },
      async run({ host, signal }) {
        const why = await ready(host, signal);
        if (why) return notChecked(why);
        const target = host.platform === 'linux' ? 'linux64' : host.platform === 'darwin' ? 'mac' : 'win64';
        return gateRun(host, signal, { action: 'build', target, live: false, record: false, output: `.harness/unity/gate-build/${target}/${target === 'win64' ? 'Game.exe' : target === 'linux64' ? 'Game.x86_64' : 'Game.app'}` }, () => true);
      },
    });
  },
};
