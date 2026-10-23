// The unity tool's actions (the Studio engine contract): detect, project.create/open,
// describe, script, asset.import/export, capture, render, level.build, test, build,
// package, play, bridge.connect/status/call. Headless work runs the editor in batch mode
// through the heavy-job queue (one Unity at a time); with the project open in the editor
// and its bridge running, the same work goes through the live bridge instead.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { toToolResult, unavailable } from '../games3d/sdk/engine.mjs';
import { runJob } from '../games3d/sdk/jobs.mjs';
import { findFiles, findRemote, listIn, newId, readIn, readTextIn, relIn, runIn, runtimePath, tail, writeIn } from '../games3d/lib-engines.mjs';
import { pngStats } from '../games3d/lib-png.mjs';
import { alive, connect, readBridgeFile, waitFor } from './bridge.mjs';
import { discover, discoverRemote, hubLister, INSTALL_HELP, nodeFs } from './detect.mjs';
import {
  buildResultFromLog, buildTarget, compileMessages, csharpBalanced, executeArgs, logProblems, markerResult, normalizeInputs,
  parseBuildReport, parseTestResults, pickEditor, playerArgs, projectVersion, scriptName, testArgs, validateLayout, wrapScript,
} from './lib-unity.mjs';
import {
  GITIGNORE, installBridge, knownVersions, minimalManifest, pickTemplate, studioProject, templateFor, templateInfo, templateProject,
  TEMPLATES, testScaffold, withBuild, withProductName,
} from './project.mjs';
import { zip } from './lib-archive.mjs';
import { PathError } from '../../src/tools/paths.ts';

export const ENGINE = 'unity';
export const ACTIONS = ['detect', 'install', 'project.create', 'project.open', 'describe', 'script', 'asset.import', 'asset.export', 'capture', 'render', 'level.build', 'test', 'build', 'package', 'play', 'bridge.connect', 'bridge.status', 'bridge.call'];
export const READ_ACTIONS = new Set(['detect', 'install', 'describe', 'bridge.status']);
const BATCH_TARGET = { StandaloneWindows64: 'Win64', WebGL: 'WebGL', StandaloneLinux64: 'Linux64', StandaloneOSX: 'OSXUniversal' };
const IMAGE = 'image/png';

const result = (action, status, summary, extra = {}) => ({ engine: ENGINE, action, status, summary, ...extra });
const rel = (project, p) => (project === '.' ? p : `${project}/${p}`);
const seconds = (v, def, max = 7200) => Math.min(Math.max(Number(v) || def, 10), max) * 1000;

// ---------- finding the editor ----------

const found = new WeakMap();

/** Unity in this session's runtime (remembered once an editor is found; a missing one is looked for again). */
export async function discoverFor(host, signal, { fresh = false, deps = {} } = {}) {
  if (!fresh && found.has(host)) return found.get(host);
  const d = deps.discover ? await deps.discover(host, signal)
    : host.kind === 'companion' ? await discoverRemote(host, signal)
      : await discover({ platform: host.platform ?? process.platform, env: process.env, fs: nodeFs, hubList: hubLister(host, signal) });
  if (d.editors.length) found.set(host, d);
  return d;
}

const dockerNote = 'Unity runs on the host, not in a sandbox (it has no Linux sandbox image and needs a licence): use a session on a server folder or the companion on the computer where Unity Hub is.';

// ---------- the project ----------

async function exists(host, p, signal) {
  if (host.kind === 'companion') return (await readTextIn(host, p, signal).catch(() => null)) !== null;
  try { await fsp.access(path.join(host.root, p)); return true; } catch { return false; }
}

/** Whether a folder is a Unity project (Packages/manifest.json, or ProjectSettings/ProjectVersion.txt). */
export async function isProject(host, p, signal) {
  return (await readTextIn(host, rel(p, 'Packages/manifest.json'), signal)) !== null || (await readTextIn(host, rel(p, 'ProjectSettings/ProjectVersion.txt'), signal)) !== null;
}

/** The Unity projects in the workspace (folders with ProjectSettings/ProjectVersion.txt or Packages/manifest.json beside Assets). */
export async function unityProjects(host, signal, max = 3) {
  const isVersion = (n) => n === 'ProjectVersion.txt' || n === 'manifest.json';
  const files = host.kind === 'companion'
    ? [...await findRemote(host, '**/ProjectSettings/ProjectVersion.txt', isVersion, signal), ...await findRemote(host, '**/Packages/manifest.json', isVersion, signal)]
    : await findFiles(host.root, isVersion, { max: 40, depth: 4 });
  const out = [];
  for (const f of files) {
    const parts = f.split('/');
    if (parts.length < 2 || !['ProjectSettings', 'Packages'].includes(parts.at(-2))) continue;
    if (parts.at(-2) === 'ProjectSettings' && parts.at(-1) !== 'ProjectVersion.txt') continue;
    if (parts.at(-2) === 'Packages' && parts.at(-1) !== 'manifest.json') continue;
    const dir = parts.slice(0, -2).join('/') || '.';
    if (!out.includes(dir)) out.push(dir);
  }
  return out.slice(0, max);
}

/** The project an action works on: the one asked for, the one .studio/project.json names, or the only one there. */
async function projectFor(host, input, signal) {
  if (input.project) {
    const p = await relIn(host, String(input.project));
    if (!(await isProject(host, p, signal))) throw new UserError(`${p} is not a Unity project (no Packages/manifest.json): make one with project.create`);
    return p;
  }
  const studio = await readStudio(host, '.', signal);
  if (studio?.engine === 'unity' && studio.engineProject) {
    const p = path.posix.dirname(path.posix.dirname(studio.engineProject)) || '.';
    if (await isProject(host, p, signal)) return p;
  }
  const all = await unityProjects(host, signal);
  if (all.length === 1) return all[0];
  if (!all.length) throw new UserError('no Unity project in the workspace: make one with project.create, or pass project');
  throw new UserError(`several Unity projects (${all.join(', ')}): pass project`);
}

class UserError extends Error {}

async function readStudio(host, root, signal) {
  const t = await readTextIn(host, rel(root, '.studio/project.json'), signal).catch(() => null);
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
}

// ---------- running the editor ----------

/**
 * Runs the editor in batch mode on a project, as a heavy job: an entry point of the bridge
 * package (method) with its arguments, or a command line of its own (args). Returns the
 * exit code, the log and its problems, and the entry point's result.
 */
export async function runEditor(ctx, { project, method, payload, args, title, timeoutMs, buildTarget: bt }) {
  const { host, signal, editor } = ctx;
  const id = newId();
  const dir = `.harness/unity/runs/${id}`;
  const rp = (p) => runtimePath(host, p);
  const log = `${dir}/unity.log`;
  let cmd = args?.({ rp, dir, log: rp(log) });
  // The package is needed by the entry points and by test assemblies that reference Harness.Bridge.
  if (project) await installBridge(host, project, signal);
  if (method) {
    await writeIn(host, `${dir}/args.json`, JSON.stringify(payload ?? {}, null, 1), signal);
    cmd = executeArgs({ project: rp(project), log: rp(log), method, argsFile: rp(`${dir}/args.json`), resultFile: rp(`${dir}/result.json`), buildTarget: bt });
  }
  const run = (s) => runIn(host, editor.path, cmd, { timeoutMs, signal: s });
  const r = await (ctx.deps?.runJob ?? runJob)(ENGINE, title ?? `Unity ${method ?? 'batch'}`, run, { signal, timeoutMs: timeoutMs + 60_000 });
  const logText = (await readTextIn(host, log, signal).catch(() => null)) ?? r.output ?? '';
  let res = null;
  const resText = method ? await readTextIn(host, `${dir}/result.json`, signal).catch(() => null) : null;
  if (resText) { try { res = JSON.parse(resText); } catch { res = null; } }
  if (!res && method) res = markerResult(logText);
  const { problems, kinds } = logProblems(logText);
  return { code: r.code, timedOut: r.timedOut, took: r.took, log: logText, logFile: log, result: res, problems, kinds, dir, id };
}

/** The status and summary prefix for a finished run: a licence or a locked project is the person's to fix. */
function runStatus(run, okWhen) {
  if (run.timedOut) return { status: 'timed-out', why: 'the editor did not finish in time' };
  if (run.kinds.includes('license')) return { status: 'unavailable', why: 'license not activated: open Unity Hub, sign in, and add a licence (Preferences > Licenses > Add; Personal is free)' };
  if (run.kinds.includes('locked')) return { status: 'failed', why: 'the project is open in another Unity editor: use the live bridge (bridge.connect) or close that editor' };
  return okWhen ? { status: 'ok' } : { status: 'failed' };
}

/** The end of a log for the result (the whole file stays in .harness/unity/runs). */
const logTail = (run) => tail(run.log, 30, 3000);

// ---------- the live bridge ----------

/** The bridge to the editor that has this project open, or null (live: false skips it; live: true requires it). */
export async function liveBridge(ctx, project, live) {
  const { host, signal } = ctx;
  if (live === false || live === 'false') return null;
  const required = live === true || live === 'true';
  if (host.kind !== 'local') {
    if (required) throw new UserError('the live bridge reaches an editor on the server\'s own computer (a server folder session); this session\'s editor is elsewhere');
    return null;
  }
  const file = await readBridgeFile(host, project, signal);
  if (!file || !(ctx.deps?.alive ?? alive)(file.pid)) {
    if (required) throw new UserError(`no editor has ${project} open with the bridge running: open the project in Unity (the package in Packages/com.harness.bridge starts the bridge), or run headless (live: false)`);
    return null;
  }
  const b = (ctx.deps?.connect ?? connect)({ port: file.port, token: file.token });
  try { await b.call('ping', {}, { timeoutMs: 5000, retryMs: 3000, signal }); return b; } catch (e) {
    b.close();
    if (required) throw new UserError(`the bridge in the open editor did not answer (${e.message})`);
    return null;
  }
}

/** Waits for the editor to finish compiling after a refresh (it reloads scripts, which drops the connection). */
async function compiled(b, signal, timeoutMs = 300_000) {
  await new Promise((r) => setTimeout(r, 300));
  const s = await waitFor(b, 'compile.status', (x) => x && !x.compiling && !x.updating, { timeoutMs, signal });
  return (s.messages ?? []).filter((m) => m.severity === 'error').map((m) => ({ severity: 'error', message: m.message, file: m.file ? m.file.replace(/^.*?((?:Assets|Packages)\/)/, '$1') : undefined, line: m.line }));
}

// ---------- images ----------

async function pngImage(host, p, signal) {
  try {
    const data = await readIn(host, p, signal);
    let stats = null;
    try { stats = pngStats(data); } catch { stats = null; }
    return { image: { media_type: IMAGE, data: data.toString('base64') }, stats, bytes: data.length };
  } catch { return null; }
}

function blankProblem(stats, what) {
  if (!stats?.blank) return [];
  return [{ severity: 'warning', message: `${what} is blank (${stats.colours} colour(s)): nothing is in view or lit; check the camera and the lights` }];
}

// ---------- the actions ----------

/** Runs one call of the unity tool: an EngineResult and the images to show. */
export async function runUnity(input, { host, signal }, deps = {}) {
  const action = String(input.action ?? 'detect');
  if (!ACTIONS.includes(action)) return { r: result(action, 'failed', `unknown action ${action}: use one of ${ACTIONS.join(', ')}`) };
  if (host.kind === 'docker') return { r: unavailable(ENGINE, action, dockerNote) };
  try {
    if (action === 'detect') return await detectAction(host, signal, deps);
    if (action === 'install') {
      const d = await discoverFor(host, signal, { fresh: true, deps });
      return { r: unavailable(ENGINE, 'install', `${d.editors.length ? `Unity ${pickEditor(d.editors).editor.version} is installed.` : 'No Unity editor is installed.'} ${INSTALL_HELP}${d.gaps.length ? ` Still to do: ${d.gaps.join(' ')}` : ''}`) };
    }
    if (action === 'bridge.status' || action === 'bridge.connect' || action === 'bridge.call') return await bridgeAction(action, input, { host, signal, deps });
    if (action === 'project.create') return await createAction(input, { host, signal, deps });

    const d = await discoverFor(host, signal, { deps });
    const project = await projectFor(host, input, signal);
    const want = projectVersion(await readTextIn(host, rel(project, 'ProjectSettings/ProjectVersion.txt'), signal));
    const { editor, exact } = pickEditor(d.editors, want);
    const ctx = { host, signal, editor, deps, project, discovery: d, versionNote: want && editor && !exact ? `the project was made with ${want}; using ${editor.version}` : null };
    if (action === 'describe' && (!editor || input.offline === true)) return await describeFiles(ctx, input, editor ? null : 'no editor: read from the project files');
    if (!editor && !['describe'].includes(action)) {
      return { r: unavailable(ENGINE, action, d.hub ? `Unity Hub found, no editor installed: install one in Unity Hub (a 6000.x LTS). ${INSTALL_HELP}` : `Unity is not installed. ${INSTALL_HELP}`) };
    }
    switch (action) {
      case 'project.open': return await openAction(input, ctx);
      case 'describe': return await describeAction(input, ctx);
      case 'script': return await scriptAction(input, ctx);
      case 'asset.import': return await importAction(input, ctx);
      case 'asset.export': return await exportAction(input, ctx);
      case 'capture': return await captureAction(input, ctx);
      case 'render': return await renderAction(input, ctx);
      case 'level.build': return await levelAction(input, ctx);
      case 'test': return await testAction(input, ctx);
      case 'build': case 'package': return await buildAction(input, ctx, action === 'package');
      case 'play': return await playAction(input, ctx);
      default: throw new Error(`unreachable ${action}`);
    }
  } catch (e) {
    if (e instanceof UserError || e instanceof PathError) return { r: result(action, 'failed', e.message) };
    if (/cancel/i.test(e.message) || signal?.aborted) return { r: result(action, 'cancelled', e.message) };
    if (/timed out/i.test(e.message)) return { r: result(action, 'timed-out', e.message) };
    throw e;
  }
}

async function detectAction(host, signal, deps) {
  const d = await discoverFor(host, signal, { fresh: true, deps });
  const { editor } = pickEditor(d.editors);
  const report = {
    engine: ENGINE, installed: Boolean(editor), version: editor?.version, path: editor?.path, source: 'host',
    gaps: d.gaps, actions: editor ? ACTIONS : ['detect', 'install', 'project.create', 'describe', 'bridge.status'],
  };
  const summary = editor
    ? `Unity ${editor.version} at ${editor.path} (modules: ${editor.modules.join(', ') || 'none'}${editor.il2cpp ? ', IL2CPP' : ''}); licence ${d.license.status}${d.hub ? `; Hub ${d.hub.version ?? ''} at ${d.hub.path}` : ''}`
    : d.hub ? `Unity Hub found at ${d.hub.path}, no editor installed` : 'Unity is not installed';
  return {
    r: result('detect', 'ok', summary + (d.gaps.length ? `. Gaps: ${d.gaps.length}` : ''), {
      problems: d.gaps.map((g) => ({ severity: 'warning', message: g })),
      data: { ...report, hub: d.hub, license: d.license, notes: d.notes, editors: d.editors.map(({ dataDir, ...e }) => e) },
    }),
  };
}

// ---------- project.create / open ----------

async function templatesOf(editor, host) {
  if (!editor || host.kind === 'companion') return [];
  const out = [];
  const dirs = [path.join(editor.dataDir, 'Resources', 'PackageManager', 'ProjectTemplates')];
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'UnityHub', 'Templates'));
  for (const dir of dirs) {
    for (const n of await fsp.readdir(dir).catch(() => [])) {
      // com.unity.template.3d-cross-platform-17.0.11.tgz: the name and version without unpacking 30 MB.
      const m = /^(com\.unity\.template\.[a-z0-9.-]+?)-(\d+\.\d+\.\d+[^/]*)\.tgz$/i.exec(n);
      if (m) out.push({ file: path.join(dir, n), name: m[1], version: m[2] });
    }
  }
  return out;
}

async function builtInVersions(editor, host) {
  if (!editor || host.kind === 'companion') return {};
  const out = {};
  for (const n of ['com.unity.render-pipelines.universal', 'com.unity.feature.2d', 'com.unity.ugui', 'com.unity.test-framework', 'com.unity.inputsystem']) {
    try { out[n] = JSON.parse(await fsp.readFile(path.join(editor.dataDir, 'Resources', 'PackageManager', 'BuiltInPackages', n, 'package.json'), 'utf8')).version; } catch { /* not built in */ }
  }
  return out;
}

async function createAction(input, { host, signal, deps }) {
  const action = 'project.create';
  const tpl = templateFor(input.template, input.dimension);
  if (!tpl) return { r: result(action, 'failed', `unknown template ${input.template}: use ${Object.keys(TEMPLATES).join(', ')}`) };
  const project = await relIn(host, String(input.project ?? 'Game'));
  if (project === '.') return { r: result(action, 'failed', 'make the Unity project in a folder of its own (project: "Game"), so the workspace keeps .studio and the rest beside it') };
  if (await isProject(host, project, signal)) return { r: result(action, 'failed', `${project} is already a Unity project: use project.open (or another folder)`) };
  const name = String(input.name ?? path.posix.basename(project)).slice(0, 60);
  const dimension = String(input.dimension ?? tpl.dimension);
  const d = await discoverFor(host, signal, { deps });
  const { editor } = pickEditor(d.editors);
  const written = [];
  const put = async (p, data) => { await writeIn(host, rel(project, p), data, signal); written.push(p); };

  // The editor's own template when it has one (its project folder, as the Hub copies it), else a minimal project.
  const templates = await (deps.templates ? deps.templates(editor) : templatesOf(editor, host));
  const chosen = pickTemplate(templates, tpl);
  let source;
  let mainScene = 'Assets/Scenes/Main.unity';
  if (chosen) {
    const buf = chosen.buf ?? await fsp.readFile(chosen.file);
    let info = {};
    try { info = templateInfo(buf); } catch { /* the file name said enough */ }
    const files = templateProject(buf);
    for (const f of files) {
      if (f.rel === 'ProjectSettings/ProjectSettings.asset') await put(f.rel, withProductName(f.data.toString('utf8'), name, input.company));
      else if (f.rel !== 'ProjectSettings/ProjectVersion.txt') await put(f.rel, f.data);
    }
    const scene = files.find((f) => /^Assets\/Scenes\/[^/]+\.unity$/.test(f.rel));
    if (scene) mainScene = scene.rel;
    source = `the editor's template ${info.displayName ?? chosen.displayName ?? chosen.name} ${chosen.version}`;
  } else {
    const versions = knownVersions([], await builtInVersions(editor, host));
    await put('Packages/manifest.json', minimalManifest({ urp: tpl.urp, twoD: dimension === '2d', versions }));
    await put('Assets/Scenes/.keep', '');
    source = tpl.id === '3d-builtin' ? 'a minimal built-in 3D project' : `a minimal project (${tpl.title}; URP set up on first open)`;
  }
  if (input.tests !== false) for (const f of testScaffold(name)) await put(f.rel, f.data);
  await put('.gitignore', GITIGNORE);
  const bridge = await installBridge(host, project, signal);

  // Studio's project file.
  const studioRoot = await relIn(host, String(input.studio ?? '.'));
  const prev = await readStudio(host, studioRoot, signal);
  const engineProject = path.posix.relative(studioRoot === '.' ? '' : studioRoot, rel(project, 'ProjectSettings/ProjectVersion.txt'));
  const sp = studioProject(prev, { name, dimension, genre: input.genre, engineProject });
  await writeIn(host, rel(studioRoot, '.studio/project.json'), `${JSON.stringify(sp, null, 2)}\n`, signal);
  const studioNote = prev?.engine && prev.engine !== 'unity' ? ` (.studio/project.json names ${prev.engine}; left as it is)` : '';

  const files = [rel(project, 'Packages/manifest.json'), rel(studioRoot, '.studio/project.json'), bridge.path];
  const data = { project, template: tpl.id, source, dimension, mainScene, bridge: bridge.path, written: written.length };
  if (!editor || input.open === false) {
    return {
      r: result(action, 'ok', `${project}: ${source}, written (${written.length} files)${editor ? '' : '; no editor yet, so it is not opened: install one in Unity Hub (a 6000.x LTS), then project.open'}${studioNote}`, {
        files, data, problems: editor ? [] : d.gaps.map((g) => ({ severity: 'warning', message: g })),
      }),
    };
  }
  // The first open imports everything and compiles; ConfigureProject sets the rest up.
  const ctx = { host, signal, editor, deps };
  const run = await runEditor(ctx, {
    project, method: 'ConfigureProject', title: `Unity: set up ${project}`, timeoutMs: seconds(input.timeoutSec, 2400),
    payload: { name, company: input.company, dimension, urp: tpl.urp, scene: mainScene },
  });
  const ok = run.code === 0 && run.result?.ok !== false;
  const st = runStatus(run, ok);
  return {
    r: result(action, st.status, `${project}: ${source}; ${ok ? `opened and set up in ${run.took} with Unity ${editor.version}` : st.why ?? `the first open failed (exit ${run.code})`}${studioNote}`, {
      files, logFile: run.logFile, problems: run.problems, data: { ...data, setup: run.result }, ...(ok ? {} : { log: logTail(run) }), metrics: { tookS: parseFloat(run.took) },
    }),
  };
}

async function openAction(input, ctx) {
  const run = await runEditor(ctx, { project: ctx.project, method: 'Check', title: `Unity: open ${ctx.project}`, timeoutMs: seconds(input.timeoutSec, 1800) });
  const errors = run.problems.filter((p) => p.severity === 'error');
  const ok = run.code === 0 && !errors.length;
  const st = runStatus(run, ok);
  const warnings = compileMessages(run.log).filter((m) => m.severity === 'warning').length;
  return {
    r: result('project.open', st.status, ok ? `${ctx.project} opens and every script compiles (Unity ${ctx.editor.version}, ${run.took}${warnings ? `, ${warnings} warning(s)` : ''})${ctx.versionNote ? `; ${ctx.versionNote}` : ''}` : st.why ?? `${errors.length} error(s) opening ${ctx.project}`, {
      problems: run.problems, logFile: run.logFile, data: run.result ?? undefined, ...(ok ? {} : { log: logTail(run) }),
    }),
  };
}

// ---------- describe ----------

/** What the files say without an editor: version, packages, settings, scenes and their objects, scripts. */
export async function describeFiles(ctx, input, note) {
  const { host, signal, project } = ctx;
  const read = (p) => readTextIn(host, rel(project, p), signal);
  const manifest = JSON.parse((await read('Packages/manifest.json')) ?? '{}');
  const settings = (await read('ProjectSettings/ProjectSettings.asset')) ?? '';
  const build = (await read('ProjectSettings/EditorBuildSettings.asset')) ?? '';
  const field = (k) => new RegExp(`^\\s*${k}:\\s*(.*)$`, 'm').exec(settings)?.[1]?.trim();
  const scenesInBuild = [...build.matchAll(/path:\s*(\S+\.unity)/g)].map((m) => m[1]);
  const files = host.kind === 'companion' ? [] : await findFiles(path.join(host.root, project, 'Assets'), (n) => /\.(unity|cs|prefab|mat|png|fbx|glb|gltf|wav|ogg|mp3|asset)$/i.test(n), { max: 2000, depth: 8 });
  const by = (re) => files.filter((f) => re.test(f)).map((f) => `Assets/${f}`);
  const scenes = by(/\.unity$/i);
  const sceneObjects = {};
  for (const s of scenes.slice(0, 5)) {
    const text = (await read(s)) ?? '';
    sceneObjects[s] = [...text.matchAll(/--- !u!1 &\d+\n(?:[^\n]*\n){0,12}?\s*m_Name: ([^\n]*)/g)].map((m) => m[1].trim()).slice(0, 200);
  }
  const data = {
    mode: 'files', unity: projectVersion(await read('ProjectSettings/ProjectVersion.txt')), productName: field('productName'),
    inputHandler: { 0: 'Input Manager', 1: 'Input System', 2: 'Both' }[field('activeInputHandler')] ?? undefined,
    packages: manifest.dependencies ? Object.fromEntries(Object.entries(manifest.dependencies).filter(([k]) => !k.startsWith('com.unity.modules.'))) : {},
    buildScenes: scenesInBuild, scenes, sceneObjects, scripts: by(/\.cs$/i).length, prefabs: by(/\.prefab$/i), models: by(/\.(fbx|glb|gltf)$/i), textures: by(/\.png$/i).length, audio: by(/\.(wav|ogg|mp3)$/i).length,
  };
  return { r: result('describe', 'ok', `${project}: Unity ${data.unity ?? '(not opened yet)'}, ${scenes.length} scene(s), ${data.scripts} script(s), ${Object.keys(data.packages).length} package(s)${note ? ` (${note})` : ''}`, { data }) };
}

async function describeAction(input, ctx) {
  const b = await liveBridge(ctx, ctx.project, input.live);
  if (b) {
    try {
      const data = await b.call('describe', { scene: input.scene, depth: input.depth, maxAssets: input.maxAssets }, { timeoutMs: 120_000, retryMs: 10_000 });
      return { r: result('describe', 'ok', `${ctx.project} (live, Unity ${data.settings?.unity}): ${data.buildScenes?.length ?? 0} scene(s) in the build, active ${data.activeScene || 'untitled'}`, { data: { mode: 'live', ...data } }) };
    } finally { b.close(); }
  }
  const run = await runEditor(ctx, { project: ctx.project, method: 'Describe', payload: { scene: input.scene, depth: input.depth ?? 4, maxAssets: input.maxAssets ?? 200 }, title: `Unity: describe ${ctx.project}`, timeoutMs: seconds(input.timeoutSec, 1200) });
  const ok = run.code === 0 && run.result?.ok;
  const st = runStatus(run, ok);
  if (!ok && st.status === 'unavailable') return describeFiles(ctx, input, st.why);
  return {
    r: result('describe', st.status, ok ? `${ctx.project} (headless, Unity ${run.result.settings?.unity}): ${run.result.buildScenes?.length ?? 0} scene(s) in the build, ${Object.values(run.result.assets ?? {}).reduce((n, a) => n + a.count, 0)} assets` : st.why ?? `describe failed (exit ${run.code})`, {
      data: ok ? { mode: 'batch', ...run.result } : run.result ?? undefined, problems: run.problems, logFile: run.logFile, ...(ok ? {} : { log: logTail(run) }),
    }),
  };
}

// ---------- script ----------

async function scriptAction(input, ctx) {
  const { host, signal, project } = ctx;
  if (!input.code === !input.file) return { r: result('script', 'failed', 'give code (C#: a method body, or a whole file with a class that has public static Run()) or file (a .cs in the workspace), not both') };
  const name = scriptName(input.name ?? `HarnessScript_${newId()}`);
  if (!name) return { r: result('script', 'failed', 'name is a C# identifier (letters, digits, _)') };
  let source;
  let method = input.method ? String(input.method) : null;
  let target;
  if (input.code) {
    const w = wrapScript(name, String(input.code));
    source = w.source;
    method ??= w.method;
    target = rel(project, `Assets/Editor/Harness/${name}.cs`);
  } else {
    const file = await relIn(host, String(input.file));
    if (!file.endsWith('.cs')) return { r: result('script', 'failed', 'file is a .cs file') };
    source = (await readTextIn(host, file, signal)) ?? '';
    const inAssets = file.startsWith(rel(project, 'Assets/'));
    target = inAssets ? file : rel(project, `Assets/Editor/Harness/${path.posix.basename(file)}`);
    method ??= wrapScript(name, source).method;
  }
  const shape = csharpBalanced(source);
  if (!shape.ok) return { r: result('script', 'failed', `the C# does not parse: ${shape.error}`, { problems: [{ severity: 'error', message: shape.error, file: target }] }) };
  if (!/^(.*\/)?Assets\//.test(target)) return { r: result('script', 'failed', 'scripts go under Assets/') };
  await writeIn(host, target, source, signal);
  const shown = path.posix.relative(project === '.' ? '' : project, target);

  const b = await liveBridge(ctx, project, input.live);
  if (b) {
    try {
      await b.call('assets.refresh', {}, { timeoutMs: 300_000, retryMs: 30_000 });
      const errors = await compiled(b, signal);
      if (errors.length) return { r: result('script', 'failed', `${errors.length} compile error(s) (live)`, { problems: errors, files: [target] }) };
      const out = await b.call('script.invoke', { method, args: input.args }, { timeoutMs: seconds(input.timeoutSec, 600), retryMs: 30_000 });
      return { r: result('script', 'ok', `${method} ran in the open editor in ${out.tookMs} ms`, { files: [target], data: out }) };
    } catch (e) {
      if (!e.bridge) throw e;
      return { r: result('script', 'failed', `${method} failed in the open editor: ${e.message.split('\n')[0]}`, { files: [target], problems: exceptionProblems(e.message) }) };
    } finally { b.close(); }
  }
  const run = await runEditor(ctx, { project, method: 'RunScript', payload: { method, args: input.args ?? null }, title: `Unity: script ${name}`, timeoutMs: seconds(input.timeoutSec, 900) });
  const ok = run.code === 0 && run.result?.ok;
  const st = runStatus(run, ok);
  const problems = [...run.problems];
  if (run.result?.error) problems.unshift(...exceptionProblems(`${run.result.error}\n${run.result.stack ?? ''}`));
  const compileErrors = problems.filter((p) => p.code);
  return {
    r: result('script', st.status, ok ? `${method} ran headless in ${run.took}` : st.why ?? (compileErrors.length ? `${compileErrors.length} compile error(s); ${shown} did not run` : `${method} failed: ${String(run.result?.error ?? `exit ${run.code}`).split('\n')[0]}`), {
      files: [target], data: run.result ?? undefined, problems, logFile: run.logFile, ...(ok ? {} : { log: logTail(run) }),
    }),
  };
}

/** An exception's message and its first project frame (file and line). */
function exceptionProblems(text) {
  const first = String(text).split('\n')[0];
  const at = /((?:Assets|Packages)\/[^:\s)]+\.cs):(\d+)/.exec(String(text)) ?? /in\s+(\S*?(?:Assets|Packages)[\\/][^:\s]+\.cs):(?:line\s*)?(\d+)/i.exec(String(text));
  return [{ severity: 'error', message: first.slice(0, 400), ...(at ? { file: at[1].replace(/\\/g, '/').replace(/^.*?((?:Assets|Packages)\/)/, '$1'), line: +at[2] } : {}) }];
}

// ---------- assets ----------

const DEST = (kind, ext) => (/\.(fbx|obj|glb|gltf|blend|dae)$/i.test(ext) || kind === 'model' || kind === 'gltf' ? 'Assets/Models' : /\.(wav|mp3|ogg|aif|aiff|flac)$/i.test(ext) || kind === 'audio' || kind === 'music' ? 'Assets/Audio' : 'Assets/Art');

async function importAction(input, ctx) {
  const { host, signal, project } = ctx;
  const list = Array.isArray(input.files) ? input.files : [];
  if (!list.length) return { r: result('asset.import', 'failed', 'files is a list of {path (a file in the workspace), to? (Assets/...), kind?, ...settings}') };
  const items = [];
  const studioAssets = [];
  for (const f of list) {
    const src = await relIn(host, String(f.path ?? f));
    const base = path.posix.basename(src);
    const to = f.to ? String(f.to).replace(/\\/g, '/') : `${DEST(f.kind, base)}/${base}`;
    if (!to.startsWith('Assets/') || to.includes('..')) return { r: result('asset.import', 'failed', `to must be under Assets/ (${to})`) };
    await writeIn(host, rel(project, to), await readIn(host, src, signal), signal);
    // A glTF's buffers and textures go beside it.
    if (/\.gltf$/i.test(base) && host.kind !== 'companion') {
      try {
        const g = JSON.parse(await readTextIn(host, src, signal));
        for (const u of [...(g.buffers ?? []), ...(g.images ?? [])].map((x) => x.uri).filter((u) => u && !u.startsWith('data:'))) {
          const side = path.posix.join(path.posix.dirname(src), decodeURIComponent(u));
          await writeIn(host, rel(project, path.posix.join(path.posix.dirname(to), decodeURIComponent(u))), await readIn(host, side, signal), signal);
        }
      } catch { /* the import reports what is missing */ }
    }
    const { path: _p, to: _t, ...settings } = typeof f === 'object' ? f : {};
    items.push({ ...settings, path: to });
    const m = /^\.studio\/assets\/([^/]+)\//.exec(src);
    if (m) studioAssets.push({ id: m[1], path: to });
  }
  const payload = { files: items, dimension: (await readStudio(host, '.', signal))?.dimension, addPackages: input.addPackages !== false };
  let out;
  let run;
  const b = await liveBridge(ctx, project, input.live);
  if (b) {
    try {
      await b.call('assets.refresh', {}, { timeoutMs: 300_000, retryMs: 30_000 });
      out = await b.call('assets.import', payload, { timeoutMs: 600_000, retryMs: 30_000 });
      if (out?.restart) { await compiled(b, signal); out = await b.call('assets.import', payload, { timeoutMs: 600_000, retryMs: 60_000 }); }
    } finally { b.close(); }
  } else {
    for (let i = 0; i < 2; i++) {
      run = await runEditor(ctx, { project, method: 'ImportAssets', payload, title: `Unity: import ${items.length} asset(s)`, timeoutMs: seconds(input.timeoutSec, 1800) });
      out = run.result;
      if (!out?.restart) break;
    }
  }
  const results = out?.results ?? [];
  const failed = results.filter((x) => !x.ok);
  const problems = [...failed.map((x) => ({ severity: 'error', message: `${x.path}: ${x.error}`, file: x.path })), ...(run?.problems ?? [])];
  if (out?.error) problems.unshift({ severity: 'error', message: out.error });
  // Studio's asset manifest records where the asset went in Unity.
  for (const s of studioAssets) {
    const okOne = results.find((x) => x.path === s.path)?.ok;
    if (!okOne) continue;
    const file = `.studio/assets/${s.id}/asset.json`;
    const t = await readTextIn(host, file, signal).catch(() => null);
    if (!t) continue;
    try { const a = JSON.parse(t); a.engines = { ...(a.engines ?? {}), unity: { path: rel(project, s.path), importedAt: new Date().toISOString() } }; a.updated = new Date().toISOString(); await writeIn(host, file, `${JSON.stringify(a, null, 2)}\n`, signal); } catch { /* not ours to fix */ }
  }
  const st = run ? runStatus(run, out?.ok === true) : { status: out?.ok ? 'ok' : 'failed' };
  return {
    r: result('asset.import', st.status, out?.ok ? `${results.length} asset(s) imported into ${project}${b ? ' (live)' : ''}: ${results.map((x) => `${x.path} (${x.type}${x.triangles !== undefined ? `, ${x.triangles} tris` : ''}${x.sprites ? `, ${x.sprites} sprites` : ''})`).join(', ')}` : st.why ?? `${failed.length || 'the'} import(s) failed`, {
      files: items.map((x) => rel(project, x.path)), problems, data: out ?? undefined, ...(run ? { logFile: run.logFile } : {}), ...(st.status === 'ok' || !run ? {} : { log: logTail(run) }),
    }),
  };
}

async function exportAction(input, ctx) {
  const { host, signal, project } = ctx;
  const list = Array.isArray(input.items) ? input.items : [];
  if (!list.length) return { r: result('asset.export', 'failed', 'items is a list of {source: "Assets/..." or "scene:Root/Child", format: unitypackage | prefab | fbx | glb | gltf, out}') };
  const items = [];
  for (const i of list) {
    const format = String(i.format ?? path.posix.extname(String(i.out ?? '')).slice(1)).toLowerCase();
    const out = format === 'prefab' ? String(i.out) : runtimePath(host, await relIn(host, String(i.out)));
    items.push({ ...i, format, out });
  }
  let out;
  let run;
  const b = await liveBridge(ctx, project, input.live);
  if (b) { try { out = await b.call('assets.export', { items }, { timeoutMs: 600_000, retryMs: 10_000 }); } finally { b.close(); } } else {
    run = await runEditor(ctx, { project, method: 'ExportAssets', payload: { items }, title: `Unity: export ${items.length} item(s)`, timeoutMs: seconds(input.timeoutSec, 1200) });
    out = run.result;
  }
  const failed = (out?.results ?? []).filter((x) => !x.ok);
  const st = run ? runStatus(run, out?.ok === true) : { status: out?.ok ? 'ok' : 'failed' };
  return {
    r: result('asset.export', st.status, out?.ok ? `${items.length} item(s) exported` : st.why ?? `${failed.length} export(s) failed`, {
      files: list.map((i) => String(i.out)), problems: [...failed.map((x) => ({ severity: 'error', message: `${x.source} -> ${x.format}: ${x.error}` })), ...(run?.problems ?? [])], data: out ?? undefined, ...(run ? { logFile: run.logFile } : {}),
    }),
  };
}

// ---------- capture, render, levels ----------

async function captureAction(input, ctx) {
  const { host, signal, project } = ctx;
  const out = await relIn(host, String(input.out ?? `.harness/unity/captures/${newId()}.png`));
  if (!out.endsWith('.png')) return { r: result('capture', 'failed', 'out is a .png file') };
  const payload = { scene: input.scene, camera: input.camera, view: input.view, width: input.width ?? 960, height: input.height ?? 540, position: input.position, lookAt: input.lookAt, out: runtimePath(host, out), inline: false };
  const b = await liveBridge(ctx, project, input.live);
  let data;
  let run;
  if (b) {
    try {
      const r = await b.call('capture', { ...payload, inline: true }, { timeoutMs: 120_000, retryMs: 10_000 });
      if (r?.frame) await writeIn(host, out, Buffer.from(r.frame, 'base64'), signal);
      data = { ...r, frame: undefined, mode: 'live' };
    } finally { b.close(); }
  } else {
    run = await runEditor(ctx, { project, method: 'Capture', payload, title: `Unity: capture ${input.scene ?? ''}`.trim(), timeoutMs: seconds(input.timeoutSec, 900) });
    data = run.result;
    const st = runStatus(run, run.code === 0 && data?.ok);
    if (st.status !== 'ok') return { r: result('capture', st.status, st.why ?? `no frame (exit ${run.code}): ${data?.error ?? 'see the log'}`, { problems: run.problems, logFile: run.logFile, log: logTail(run), data: data ?? undefined }) };
  }
  const img = await pngImage(host, out, signal);
  if (!img) return { r: result('capture', 'failed', `Unity said it drew the frame but ${out} is not there`, { data }) };
  return {
    r: result('capture', 'ok', `${data?.width}x${data?.height} frame from ${data?.camera ?? 'the camera'} saved to ${out}${img.stats?.blank ? ' (blank!)' : ''}`, {
      files: [out], problems: blankProblem(img.stats, 'the frame'), data: { ...data, colours: img.stats?.colours }, ...(run ? { logFile: run.logFile } : {}),
    }),
    images: [img.image],
  };
}

async function renderAction(input, ctx) {
  const { host, signal, project } = ctx;
  const outDir = await relIn(host, String(input.outDir ?? `.harness/unity/renders/${newId()}`));
  const b = input.recorder === false ? null : await liveBridge(ctx, project, input.live);
  if (b) {
    try {
      const status = await b.call('play.status', {}, { timeoutMs: 10_000 });
      const ops = (await b.call('ping', {}, { timeoutMs: 5000 })).ops ?? [];
      if (status.playing && ops.includes('render.record')) {
        const secs = Number(input.seconds ?? 5);
        await b.call('render.record', { outDir: runtimePath(host, outDir), seconds: secs, fps: input.fps ?? 30, width: input.width ?? 1280, height: input.height ?? 720 }, { timeoutMs: 30_000 });
        await waitFor(b, 'render.status', (s) => s && !s.recording, { timeoutMs: (secs + 120) * 1000, signal });
        return await renderResult(host, outDir, 'the Unity Recorder (play mode)', signal);
      }
    } finally { b.close(); }
  }
  const run = await runEditor(ctx, { project, method: 'Render', payload: { scene: input.scene, preset: input.preset ?? 'turntable', frames: input.frames ?? 12, width: input.width ?? 960, height: input.height ?? 540, outDir: runtimePath(host, outDir), pitch: input.pitch }, title: `Unity: render ${input.preset ?? 'turntable'}`, timeoutMs: seconds(input.timeoutSec, 1800) });
  const st = runStatus(run, run.code === 0 && run.result?.ok);
  if (st.status !== 'ok') return { r: result('render', st.status, st.why ?? `render failed (exit ${run.code}): ${run.result?.error ?? 'see the log'}`, { problems: run.problems, logFile: run.logFile, log: logTail(run) }) };
  return renderResult(host, outDir, `frame captures (${input.preset ?? 'turntable'})`, signal, run.logFile);
}

async function renderResult(host, outDir, how, signal, logFile) {
  const names = (await listIn(host, outDir, signal)).filter((n) => n.endsWith('.png')).sort();
  const files = names.map((n) => `${outDir}/${n}`);
  const pick = names.length <= 4 ? files : [0, Math.floor(names.length / 3), Math.floor((2 * names.length) / 3), names.length - 1].map((i) => files[i]);
  const images = [];
  const problems = [];
  for (const f of pick) { const img = await pngImage(host, f, signal); if (img) { images.push(img.image); problems.push(...blankProblem(img.stats, f)); } }
  return { r: result('render', files.length ? 'ok' : 'failed', files.length ? `${files.length} frame(s) in ${outDir} by ${how}` : `no frames were written to ${outDir}`, { files, problems, ...(logFile ? { logFile } : {}), metrics: { frames: files.length } }), images };
}

async function levelAction(input, ctx) {
  const { host, signal, project } = ctx;
  let layoutIn = input.layout;
  if (!layoutIn && input.layoutFile) {
    const t = await readTextIn(host, await relIn(host, String(input.layoutFile)), signal);
    if (t === null) return { r: result('level.build', 'failed', `no file ${input.layoutFile}`) };
    try { layoutIn = JSON.parse(t); } catch (e) { return { r: result('level.build', 'failed', `${input.layoutFile} is not JSON: ${e.message}`) }; }
  }
  const { layout, errors, counts } = validateLayout(layoutIn);
  if (errors.length) return { r: result('level.build', 'failed', `the layout has ${errors.length} problem(s)`, { problems: errors.slice(0, 30).map((m) => ({ severity: 'error', message: m })) }) };
  const out = await relIn(host, String(input.out ?? `.harness/unity/captures/${layout.name}-${newId()}.png`));
  const capture = input.capture === false ? undefined : { out: runtimePath(host, out), width: input.width ?? 960, height: input.height ?? 540, view: input.view ?? 'game' };
  const payload = { ...layout, capture, main: input.main !== false };
  let data;
  let run;
  const b = await liveBridge(ctx, project, input.live);
  if (b) { try { data = await b.call('layout.build', { ...payload, discard: input.discard === true }, { timeoutMs: 600_000, retryMs: 10_000 }); } finally { b.close(); } } else {
    run = await runEditor(ctx, { project, method: 'BuildLevelFromLayout', payload, title: `Unity: level ${layout.name}`, timeoutMs: seconds(input.timeoutSec, 1500) });
    data = run.result;
    const st = runStatus(run, run.code === 0 && data?.ok);
    if (st.status !== 'ok') return { r: result('level.build', st.status, st.why ?? `the level was not built (exit ${run.code}): ${data?.error ?? 'see the log'}`, { problems: run.problems, logFile: run.logFile, log: logTail(run), data: data ?? undefined }) };
  }
  const images = [];
  const problems = [];
  const files = [rel(project, data.scene)];
  if (capture) {
    const img = await pngImage(host, out, signal);
    if (img) { images.push(img.image); files.push(out); problems.push(...blankProblem(img.stats, 'the level capture')); }
  }
  const c = data.counts ?? counts;
  return {
    r: result('level.build', 'ok', `${data.scene} (${layout.dimension}, ${data.rows ?? '?'}x${data.cols ?? '?'} cells${b ? ', live' : ''}): ${Object.entries(c).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ')}; it is the first scene in the build`, {
      files, problems, data, ...(run ? { logFile: run.logFile } : {}),
    }),
    images,
  };
}

// ---------- tests ----------

async function testAction(input, ctx) {
  const { host, signal, project } = ctx;
  const which = String(input.platform ?? 'both');
  const platforms = which === 'both' ? ['EditMode', 'PlayMode'] : [which === 'playmode' || which === 'PlayMode' ? 'PlayMode' : 'EditMode'];
  const per = {};
  const problems = [];
  let logFile;
  let status = 'ok';
  let why;
  const b = await liveBridge(ctx, project, input.live);
  try {
    for (const platform of platforms) {
      const id = newId();
      const xml = `.harness/unity/runs/${id}/results-${platform}.xml`;
      let text;
      if (b) {
        await b.call('tests.run', { platform, results: runtimePath(host, xml), filter: input.filter, category: input.category }, { timeoutMs: 30_000, retryMs: 10_000 });
        const until = Date.now() + seconds(input.timeoutSec, 1800);
        while (Date.now() < until && (text = await readTextIn(host, xml, signal).catch(() => null)) === null) await new Promise((r) => setTimeout(r, 1000));
      } else {
        const run = await runEditor(ctx, {
          project, title: `Unity: ${platform} tests`, timeoutMs: seconds(input.timeoutSec, 1800),
          args: ({ rp, log }) => testArgs({ project: rp(project), log, platform, results: rp(xml), filter: input.filter, category: input.category }),
        });
        logFile = run.logFile;
        text = await readTextIn(host, xml, signal).catch(() => null);
        const st = runStatus(run, true);
        if (st.status !== 'ok') { status = st.status; why = st.why; problems.push(...run.problems); break; }
        if (text === null) { status = 'failed'; why = `no ${platform} results were written (exit ${run.code})`; problems.push(...run.problems); per[platform] = { error: why, log: logTail(run) }; continue; }
      }
      if (text === null) { status = 'timed-out'; why = `${platform} tests did not finish`; continue; }
      const t = parseTestResults(text);
      per[platform] = { total: t.total, passed: t.passed, failed: t.failed, skipped: t.skipped, durationS: t.durationS, results: xml, failures: t.failures.slice(0, 30) };
      problems.push(...t.failures.map((f) => ({ severity: 'error', message: `${platform} ${f.name}: ${String(f.message).split('\n')[0].slice(0, 300)}`, file: f.file, line: f.line })));
      if (t.failed) status = 'failed';
    }
  } finally { b?.close(); }
  const sum = (k) => Object.values(per).reduce((n, p) => n + (p[k] ?? 0), 0);
  const summary = why ?? `${sum('passed')}/${sum('total')} passed${sum('failed') ? `, ${sum('failed')} failed` : ''}${sum('skipped') ? `, ${sum('skipped')} skipped` : ''} (${Object.keys(per).join(' + ')}${b ? ', live' : ''})`;
  return { r: result('test', status, summary, { problems, metrics: { total: sum('total'), passed: sum('passed'), failed: sum('failed'), skipped: sum('skipped') }, data: per, ...(logFile ? { logFile } : {}), files: Object.values(per).map((p) => p.results).filter(Boolean) }) };
}

// ---------- build and package ----------

async function buildAction(input, ctx, pkg) {
  const { host, signal, project, editor } = ctx;
  const action = pkg ? 'package' : 'build';
  const t = buildTarget(input.target ?? input.platform ?? (host.platform === 'linux' ? 'linux64' : host.platform === 'darwin' ? 'mac' : 'win64'));
  if (!t) return { r: result(action, 'failed', `unknown target ${input.target}: use win64, webgl, linux64 or mac`) };
  if (editor.modules?.length && !editor.modules.includes(t.module)) {
    return { r: unavailable(ENGINE, action, `no ${t.module === 'webgl' ? 'WebGL' : t.module} build support in Unity ${editor.version}: add it in Unity Hub (Installs > ${editor.version} > Add modules)`) };
  }
  const settings = (await readTextIn(host, rel(project, 'ProjectSettings/ProjectSettings.asset'), signal)) ?? '';
  const product = (/^\s*productName:\s*(.+)$/m.exec(settings)?.[1] ?? path.posix.basename(project)).trim().replace(/[^\w .-]/g, '') || 'Game';
  const key = t.target === 'WebGL' ? 'webgl' : t.target === 'StandaloneWindows64' ? 'win64' : t.target === 'StandaloneLinux64' ? 'linux64' : 'mac';
  const outRel = input.output ? await relIn(host, String(input.output)) : rel(project, `Builds/${key}/${t.file(product) || ''}`.replace(/\/$/, ''));
  const payload = {
    target: t.target, output: runtimePath(host, outRel), development: pkg ? false : input.development === true, scenes: input.scenes,
    scriptingBackend: input.scriptingBackend, options: input.options, webglCompression: input.webglCompression ?? (t.target === 'WebGL' ? 'disabled' : undefined),
  };
  let report;
  let run;
  const b = await liveBridge(ctx, project, input.live);
  if (b) {
    try {
      const ops = (await b.call('ping', {}, { timeoutMs: 5000 })).ops ?? [];
      if (!ops.includes('build')) throw new UserError('the open editor\'s bridge cannot build: close the editor to build headless');
      report = await b.call('build', payload, { timeoutMs: seconds(input.timeoutSec, 3600, 14_400) });
    } finally { b.close(); }
  } else {
    run = await runEditor(ctx, { project, method: 'Build', payload, buildTarget: BATCH_TARGET[t.target], title: `Unity: ${action} ${key}`, timeoutMs: seconds(input.timeoutSec, 3600, 14_400) });
    report = run.result;
    if (!report && buildResultFromLog(run.log)) report = { result: buildResultFromLog(run.log) };
  }
  const parsed = parseBuildReport(report);
  const st = run ? runStatus(run, parsed.ok) : { status: parsed.ok ? 'ok' : 'failed' };
  if (report?.kind === 'module') return { r: unavailable(ENGINE, action, report.error) };
  const outDir = t.target === 'WebGL' ? outRel : path.posix.dirname(outRel);
  const written = parsed.ok ? (await listIn(host, outDir, signal)).map((n) => `${outDir}/${n}`) : [];
  const files = [...(parsed.ok ? [outRel] : [])];
  let zipFile;
  if (parsed.ok && pkg && host.kind !== 'companion') {
    zipFile = rel(project, `Builds/${product}-${key}.zip`);
    const entries = [];
    for (const f of await findFiles(path.join(host.root, outDir), () => true, { max: 20000, depth: 12 })) {
      if (/_BurstDebugInformation_DoNotShip|_BackUpThisFolder_ButDontShipItWithYourGame/.test(f)) continue;
      entries.push({ name: `${product}/${f}`, data: await fsp.readFile(path.join(host.root, outDir, f)) });
    }
    await writeIn(host, zipFile, zip(entries), signal);
    files.push(zipFile);
  }
  if (parsed.ok && input.record !== false) {
    const studio = await readStudio(host, '.', signal);
    if (studio) {
      const build = { id: `b-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`, platform: key, path: outRel, status: 'ok', at: new Date().toISOString(), engine: ENGINE, ...(zipFile ? { package: zipFile } : {}) };
      await writeIn(host, '.studio/project.json', `${JSON.stringify(withBuild(studio, build), null, 2)}\n`, signal);
    }
  }
  return {
    r: result(action, st.status, parsed.ok ? `${key} ${pkg ? 'package' : 'build'} of ${project}: ${outRel}${zipFile ? ` and ${zipFile}` : ''} (${parsed.metrics.sizeMb ?? '?'} MB in ${parsed.metrics.buildS ?? run?.took ?? '?'} s${parsed.metrics.warnings ? `, ${parsed.metrics.warnings} warning(s)` : ''})` : st.why ?? `the ${key} build failed: ${parsed.problems.find((p) => p.severity === 'error')?.message ?? 'see the log'}`, {
      files, problems: [...parsed.problems, ...(run?.problems ?? []).filter((p) => !parsed.problems.some((q) => q.message === p.message))], metrics: parsed.metrics,
      data: { target: t.target, output: outRel, written: written.slice(0, 40), steps: parsed.steps }, ...(run ? { logFile: run.logFile } : {}), ...(parsed.ok || !run ? {} : { log: logTail(run) }),
    }),
  };
}

// ---------- play ----------

/** The newest Windows (or this platform's) build: from .studio/project.json, else the Builds folder. */
async function latestBuild(host, project, signal) {
  const studio = await readStudio(host, '.', signal);
  const want = host.platform === 'linux' ? 'linux64' : host.platform === 'darwin' ? 'mac' : 'win64';
  const b = [...(studio?.builds ?? [])].reverse().find((x) => x.engine === ENGINE && x.platform === want && x.status === 'ok');
  if (b && await exists(host, b.path, signal)) return b.path;
  const dir = rel(project, `Builds/${want}`);
  const exe = (await listIn(host, dir, signal)).find((n) => (want === 'win64' ? /\.exe$/i.test(n) && !/UnityCrashHandler/i.test(n) : /\.x86_64$/.test(n)));
  return exe ? `${dir}/${exe}` : null;
}

async function playAction(input, ctx) {
  const { host, signal, project } = ctx;
  const secs = Math.min(Math.max(Number(input.seconds) || 10, 0.5), 1800);
  const inputs = normalizeInputs(input.inputs, secs);
  const id = newId();
  const outRel = `.harness/unity/plays/${id}`;
  const session = { seconds: secs, inputs, captureEvery: input.captureEvery ?? Math.max(1, secs / 8), width: input.width ?? 960, height: input.height ?? 540, scene: input.scene };
  let mode = input.mode ? String(input.mode) : null;
  let b = null;
  if (!mode) {
    if (input.build) mode = 'player';
    else { b = await liveBridge(ctx, project, input.live); mode = b ? 'editor' : 'batch'; }
  }
  let report = null;
  let run = null;
  let how;
  if (mode === 'player') {
    const exe = input.build ? await relIn(host, String(input.build)) : await latestBuild(host, project, signal);
    if (!exe) return { r: result('play', 'failed', 'no build to play: build first (action build, target win64), or pass build (the .exe), or play in the editor (mode batch)') };
    await writeIn(host, `${outRel}/play.json`, JSON.stringify({ ...session, outDir: runtimePath(host, outRel), quit: true }), signal);
    const log = `${outRel}/player.log`;
    const timeoutMs = (secs + 180) * 1000;
    const r = await (ctx.deps?.runJob ?? runJob)(ENGINE, `Unity: play ${path.posix.basename(exe)} ${secs}s`, (s) => runIn(host, runtimePath(host, exe), playerArgs({ log: runtimePath(host, log), playFile: runtimePath(host, `${outRel}/play.json`), width: session.width, height: session.height }), { timeoutMs, signal: s }), { signal, timeoutMs: timeoutMs + 30_000 });
    const logText = (await readTextIn(host, log, signal).catch(() => null)) ?? r.output;
    run = { log: logText, logFile: log, problems: logProblems(logText).problems, kinds: [], timedOut: r.timedOut, code: r.code, took: r.took };
    how = `the build ${exe}`;
  } else if (mode === 'editor') {
    b ??= await liveBridge(ctx, project, true);
    try {
      const started = await b.call('play.run', { ...session, outDir: runtimePath(host, outRel), exitAfter: input.exitAfter !== false, discard: input.discard === true }, { timeoutMs: 60_000, retryMs: 10_000 });
      const until = Date.now() + (secs + 300) * 1000;
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 1000));
        const t = await readTextIn(host, `${outRel}/report.json`, signal).catch(() => null);
        if (t) { report = JSON.parse(t); break; }
        const res = await b.call('play.result', { id: started.id }, { timeoutMs: 10_000, retryMs: 20_000 }).catch(() => null);
        if (res?.done) { report = res.report; break; }
      }
    } finally { b.close(); }
    how = 'play mode in the open editor';
  } else {
    b?.close();
    run = await runEditor(ctx, { project, method: 'Play', payload: { ...session, outDir: runtimePath(host, outRel) }, title: `Unity: play ${secs}s`, timeoutMs: (secs + 900) * 1000 });
    how = 'play mode, headless';
  }
  if (!report) {
    const t = await readTextIn(host, `${outRel}/report.json`, signal).catch(() => null);
    if (t) { try { report = JSON.parse(t); } catch { report = null; } }
    report ??= run?.result?.report ?? null;
  }
  if (!report) {
    const st = run ? runStatus(run, false) : { status: 'timed-out', why: 'the session did not finish' };
    return { r: result('play', st.status, st.why ?? `the session wrote no report (${run ? `exit ${run.code}` : 'no answer'})`, { problems: run?.problems ?? [], ...(run ? { logFile: run.logFile, log: logTail(run) } : {}) }) };
  }
  return playResult(input, ctx, report, { outRel, how, run, mode });
}

/** The play report as a result: metrics, events, errors as problems, frames shown; a Studio playtest when the workspace has one. */
async function playResult(input, ctx, report, { outRel, how, run, mode }) {
  const { host, signal } = ctx;
  const frames = (report.frames ?? []).map((f) => `${outRel}/${f}`);
  const pick = frames.length <= 4 ? frames : [0, Math.floor(frames.length / 3), Math.floor((2 * frames.length) / 3), frames.length - 1].map((i) => frames[i]);
  const images = [];
  const problems = [];
  for (const f of pick) { const img = await pngImage(host, f, signal); if (img) { images.push(img.image); problems.push(...blankProblem(img.stats, f)); } }
  for (const e of report.errors ?? []) problems.push(exceptionProblems(e)[0]);
  const m = report.metrics ?? {};
  const state = report.state ?? {};
  const events = report.events ?? [];
  const budget = ((await readStudio(host, '.', signal))?.budgets) ?? {};
  if (budget.fps && m.fpsAvg && m.fpsAvg < budget.fps * 0.9 && mode === 'player') problems.push({ severity: 'warning', message: `fps ${m.fpsAvg} is under the budget ${budget.fps}` });
  if (budget.memoryMb && m.memoryMb > budget.memoryMb) problems.push({ severity: 'warning', message: `memory ${m.memoryMb} MB is over the budget ${budget.memoryMb} MB` });
  const verdict = state.won === true ? 'pass' : (m.errors ?? 0) > 0 ? 'fail' : input.expectWin ? 'fail' : 'pass';
  let playtest;
  if (input.record !== false && await readStudio(host, '.', signal)) playtest = await recordPlaytest(host, signal, { report, frames, input, verdict, mode });
  const files = [`${outRel}/report.json`, ...frames.slice(0, 20), ...(playtest ? [playtest] : [])];
  const metrics = Object.fromEntries(Object.entries(m).filter(([, v]) => typeof v === 'number'));
  return {
    r: result('play', (m.errors ?? 0) > 0 ? 'failed' : 'ok', `${report.durationS ?? '?'} s of ${how}: ${frames.length} frame(s), ${events.length} event(s)${state.won !== undefined ? `, ${state.won ? 'won' : 'not won'} (${state.collected ?? '?'}/${state.total ?? '?'} collected)` : ''}, ${m.errors ?? 0} error(s), fps ${m.fpsAvg ?? '?'}`, {
      files, problems, metrics, data: { state, events: events.slice(-60), verdict, mode, playtest, errors: report.errors }, ...(run?.logFile ? { logFile: run.logFile } : {}),
    }),
    images,
  };
}

/** .studio/playtests/<id>/report.json in Studio's format, with the frames copied beside it. */
async function recordPlaytest(host, signal, { report, frames, input, verdict, mode }) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const id = `pt-${day}-${newId().slice(0, 4)}`;
  const dir = `.studio/playtests/${id}`;
  const copied = [];
  for (const [i, f] of frames.entries()) {
    try { await writeIn(host, `${dir}/frames/${String(i).padStart(4, '0')}.png`, await readIn(host, f, signal), signal); copied.push(`frames/${String(i).padStart(4, '0')}.png`); } catch { /* a frame went missing */ }
  }
  const m = report.metrics ?? {};
  const pt = {
    id, engine: ENGINE, build: mode === 'player' ? input.build ?? 'latest' : mode, player: 'bot:scripted', goal: input.goal ?? 'play the input timeline without errors',
    result: verdict, durationS: report.durationS, steps: (input.inputs ?? []).length,
    events: (report.events ?? []).map((e) => ({ t: e.t, type: e.type, detail: e.detail ?? undefined })),
    metrics: { fpsAvg: m.fpsAvg, fpsMin: m.fpsMin, frameMsP95: m.frameMsP95, memoryMb: m.memoryMb, errors: m.errors ?? 0, ...(m.drawCalls !== undefined ? { drawCalls: m.drawCalls } : {}) },
    frames: copied, issues: (report.errors ?? []).slice(0, 10).map((e) => ({ severity: 'major', title: String(e).split('\n')[0].slice(0, 200) })), verdicts: [],
  };
  await writeIn(host, `${dir}/report.json`, `${JSON.stringify(pt, null, 2)}\n`, signal);
  const studio = await readStudio(host, '.', signal);
  if (studio) await writeIn(host, '.studio/project.json', `${JSON.stringify({ ...studio, playtests: [...new Set([...(studio.playtests ?? []), id])] }, null, 2)}\n`, signal);
  return `${dir}/report.json`;
}

// ---------- the bridge actions ----------

async function bridgeAction(action, input, { host, signal, deps }) {
  if (host.kind !== 'local') return { r: unavailable(ENGINE, action, 'the live bridge reaches an editor on the server\'s own computer: use a server folder session (the companion runs batch mode only)') };
  const project = await projectFor(host, input, signal);
  const ctx = { host, signal, deps };
  if (action === 'bridge.connect') {
    const inst = await installBridge(host, project, signal);
    let file = await readBridgeFile(host, project, signal);
    if ((!file || !(deps.alive ?? alive)(file.pid)) && Number(input.waitSec ?? 0) > 0) {
      const until = Date.now() + Number(input.waitSec) * 1000;
      while (Date.now() < until && !(file && (deps.alive ?? alive)(file.pid))) { await new Promise((r) => setTimeout(r, 1000)); file = await readBridgeFile(host, project, signal); }
    }
    if (!file || !(deps.alive ?? alive)(file.pid)) {
      return { r: unavailable(ENGINE, action, `no editor has ${project} open with the bridge running${inst.installed ? ' (the bridge package was just installed into Packages/com.harness.bridge: an open editor imports it in a moment)' : ''}. Ask the person to open the project in Unity (Unity Hub > Add > ${project}); the bridge starts with it. Headless actions work without it.`) };
    }
  }
  let b;
  try { b = await liveBridge(ctx, project, action === 'bridge.status' ? undefined : true); } catch (e) { if (e instanceof UserError) return { r: unavailable(ENGINE, action, e.message) }; throw e; }
  if (!b) return { r: result(action, 'ok', `no live editor for ${project}: headless batch mode is used`, { data: { connected: false } }) };
  try {
    if (action === 'bridge.call') {
      if (!input.op) return { r: result(action, 'failed', 'op is required (bridge.status lists the ops)') };
      const out = await b.call(String(input.op), input.args ?? {}, { timeoutMs: seconds(input.timeoutSec, 120), retryMs: 15_000 });
      if (out?.frame) {
        const png = Buffer.from(out.frame, 'base64');
        const file = `.harness/unity/captures/${newId()}.png`;
        await writeIn(host, file, png, signal);
        return { r: result(action, 'ok', `${input.op}: a ${out.width}x${out.height} frame (${file})`, { files: [file], data: { ...out, frame: undefined } }), images: [{ media_type: IMAGE, data: out.frame }] };
      }
      return { r: result(action, 'ok', `${input.op} done`, { data: out }) };
    }
    const [status, ping] = [await b.call('status', {}, { timeoutMs: 10_000 }), await b.call('ping', {}, { timeoutMs: 5000 })];
    return { r: result(action, 'ok', `connected to Unity ${status.unity} with ${project} open (scene ${status.scene || 'untitled'}${status.playing ? ', playing' : ''})`, { data: { connected: true, ...status, ops: ping.ops } }) };
  } catch (e) {
    if (e.bridge) return { r: result(action, 'failed', `${input.op ?? action}: ${e.message.split('\n')[0]}`, { problems: exceptionProblems(e.message) }) };
    throw e;
  } finally { b.close(); }
}

/** The tool result for a call (toToolResult with the images). */
export async function unityTool(input, ctx, deps) {
  const { r, images = [] } = await runUnity(input, ctx, deps);
  return toToolResult(r, images);
}
