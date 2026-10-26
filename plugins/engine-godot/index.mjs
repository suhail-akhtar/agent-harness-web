// Godot 4 for Studio (engine-godot): the `godot` tool and the godot-project, godot-selftest
// and godot-export gates. Godot runs where the session's commands run (a sandbox, a server
// folder, a companion), found by lib-engines' locate (an explicit HARNESS_GODOT, what the
// install action put in <home>/engines, the PATH, the usual install folders).
//
// The actions (sdk/engine.mjs): detect, install, project.create, describe, check, script,
// asset.import / asset.export, run, capture (screenshot), render, build (export) / package,
// test, play, step.start / step / step.state / step.stop, bridge.install / status /
// connect / call, jobs / job.cancel. Heavy ones (install, build, package, render, play,
// test) go through the shared job queue (sdk/jobs.mjs).

import fsp from 'node:fs/promises';
import path from 'node:path';
import { defineTool } from '@harness/plugin-sdk/runtime';
import {
  checkGodot, enginesDir, findFiles, findRemote, godotArgs, godotProblems, listIn, locate, missingIn, mkdirIn, newId, presetsIn,
  readIn, readTextIn, relIn, removeIn, runIn, runtimePath, SELFTEST_FRAMES, selftestGodot, tail, withDisplay, WORKSPACE_ENGINES, writeIn,
} from '@harness/plugins/games3d/lib-engines.mjs';
import { toToolResult } from '@harness/plugins/games3d/sdk/engine.mjs';
import { cancelJob, listJobs, runJob } from '@harness/plugins/games3d/sdk/jobs.mjs';
import { bridgeCall, bridgeInfo, COMMANDS, installBridge } from './lib/bridge.mjs';
import { BUILDS, DEFAULT_TEMPLATES, defaultPlatforms, installGodot, NETWORK_HOSTS, templatesFor } from './lib/install.mjs';
import {
  bootRun, importProject, inProject, metricsOf, sizeOf, someFrames, startStep, step, stepSessions, stepState, stopAllSteps, stopStep, timeline, workspaceRel,
} from './lib/play.mjs';
import { addPreset, hostPreset, PRESETS } from './lib/presets.mjs';
import { PLUGIN_DIR, studioProject, TEMPLATE_ALIASES, TEMPLATES, templateFiles } from './lib/templates.mjs';
import { writeZip } from './lib/zip.mjs';

export const ACTIONS = ['detect', 'install', 'project.create', 'describe', 'check', 'script', 'asset.import', 'asset.export', 'run', 'capture', 'screenshot', 'render', 'build', 'export', 'package', 'test', 'play', 'step.start', 'step', 'step.state', 'step.stop', 'bridge.install', 'bridge.status', 'bridge.connect', 'bridge.call', 'jobs', 'job.cancel'];
const NO_PROJECT = new Set(['detect', 'install', 'project.create', 'jobs', 'job.cancel', 'step', 'step.state', 'step.stop']);

const seconds = (v, def) => Math.min(Math.max(Number(v) || def, 10), 3600) * 1000;
const isProject = (n) => n === 'project.godot';
const res = (rel) => (String(rel).startsWith('res://') ? String(rel) : `res://${String(rel).replace(/^\.\//, '')}`);
const R = (action, status, summary, more = {}) => ({ engine: 'godot', action, status, summary, ...more });
const asProblems = (list) => list.map((m) => ({ severity: 'error', message: m, ...(/\(res:\/\/([^:)]+):(\d+)\)/.exec(m) ? { file: /\(res:\/\/([^:)]+):(\d+)\)/.exec(m)[1], line: Number(/\(res:\/\/([^:)]+):(\d+)\)/.exec(m)[2]) } : {}) }));

/** Folders with a project.godot in the workspace (max 3). */
async function godotProjects(host, signal) {
  const files = host.kind === 'companion'
    ? await findRemote(host, '**/project.godot', isProject, signal)
    : await findFiles(host.root, isProject, { max: 3, depth: 3 });
  return files.slice(0, 3).map((f) => path.posix.dirname(f));
}

/** A gate cannot check without Godot: it says so and does not fail the run. */
const notChecked = (host) => ({ pass: false, severity: 'advisory', summary: 'not checked: Godot is not installed in this runtime', details: missingIn(host, 'godot') });

const notInstalled = (host, action) => R(action, 'unavailable', `${missingIn(host, 'godot')}${host.kind === 'companion' ? '' : ' Or have the harness install the official build: {"action": "install"} (asks first; checksums verified).'}`);

// ---------- detect ----------

async function detect(host, signal) {
  const bin = await locate(host, 'godot', signal);
  if (!bin) return { ...notInstalled(host, 'detect'), data: { engine: 'godot', installed: false, gaps: ['Godot 4 is not installed'], actions: ['detect', 'install', 'project.create'] } };
  const v = await runIn(host, bin, ['--headless', '--version'], { timeoutMs: 60_000, signal });
  const line = v.output.split('\n').map((l) => l.trim()).find((l) => /^\d+\.\d+/.test(l)) ?? '';
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?\.(\w+)/.exec(line);
  const version = m ? `${m[1]}.${m[2]}${m[3] ? `.${m[3]}` : ''}` : undefined;
  const channel = m?.[4] ?? 'stable';
  const unix = bin.replace(/\\/g, '/');
  const source = host.kind === 'docker' ? (unix.includes(`/${WORKSPACE_ENGINES}/`) ? 'harness' : 'sandbox') : unix.startsWith(enginesDir().replace(/\\/g, '/')) ? 'harness' : 'host';
  const gaps = [];
  if (!m) gaps.push(`could not read Godot's version (${line || `exit ${v.code}`})`);
  else if (Number(m[1]) < 4) gaps.push(`Godot ${version} is Godot 3: the godot tool needs Godot 4`);
  let templates = { targets: [], folder: '' };
  if (version && host.kind === 'local') templates = templatesFor(bin, `${version}.${channel}`);
  else if (version && host.kind === 'docker') {
    const dir = path.posix.dirname(unix);
    const r = await runIn(host, 'sh', ['-c', `ls -1 "$HOME/.local/share/godot/export_templates/${version}.${channel}" /opt/godot/export_templates/${version}.${channel} "${dir}/editor_data/export_templates/${version}.${channel}" 2>/dev/null; true`], { timeoutMs: 30_000, signal });
    const names = r.output.split('\n').map((l) => l.trim());
    templates = { folder: '', targets: Object.entries({ windows: /^windows_/, web: /^web_/, linux: /^linux_/, macos: /^macos\.zip$/ }).filter(([, re]) => names.some((n) => re.test(n))).map(([k]) => k) };
  }
  for (const t of ['windows', 'web', 'linux']) {
    if (host.kind !== 'companion' && version && !templates.targets.includes(t)) gaps.push(`no ${t} export templates for ${version} (build for ${t} needs them: {"action": "install"} adds them)`);
  }
  if (host.kind === 'docker' || (host.platform === 'linux' && host.kind !== 'local')) {
    const x = await runIn(host, 'sh', ['-c', 'command -v Xvfb || command -v xvfb-run || echo none'], { timeoutMs: 30_000, signal });
    if (/none/.test(x.output)) gaps.push('no display and no Xvfb: frames (capture, play with frames, render) need one; the 3D sandbox image has Xvfb');
  }
  if (host.kind === 'companion') gaps.push('step mode and the editor bridge need Godot on the server or in its sandbox (not on a companion)');
  const data = { engine: 'godot', installed: true, version, channel, path: bin, source, gaps, actions: ACTIONS, templates: templates.targets, templatesFolder: templates.folder || undefined };
  return R('detect', 'ok', `Godot ${version ?? '?'} (${source}) at ${bin}${gaps.length ? `; ${gaps.length} gap(s)` : '; nothing missing'}`, { data });
}

// ---------- install ----------

async function install(input, host, signal, api) {
  if (host.kind === 'companion') return R('install', 'unavailable', 'install puts Godot on the server; this session runs commands on the companion\'s computer. Install Godot there (winget install GodotEngine.GodotEngine, or download it from godotengine.org), or set HARNESS_GODOT there.');
  const platforms = Array.isArray(input.platforms) && input.platforms.length ? input.platforms.map(String) : host.kind === 'docker' ? ['linux'] : defaultPlatforms();
  const templates = input.templates === false ? [] : Array.isArray(input.templates) ? input.templates.map(String) : DEFAULT_TEMPLATES;
  const log = [];
  const { manifest, report } = await runJob('godot', `install Godot ${input.version ?? 'latest'}`, (sig) => installGodot({
    fetch: (u, init) => api.fetch(u, init), version: input.version ? String(input.version) : 'latest', platforms, templates, signal: sig,
    log: (m) => { log.push(m); api.log(`install: ${m}`); },
  }), { signal, timeoutMs: 90 * 60_000 });
  const files = [];
  let note = '';
  if (host.kind === 'docker') {
    // The sandbox runs Linux: its build goes into the workspace, where the sandbox sees it.
    const rel = manifest.binaries['linux-x64'];
    if (!rel) throw new Error('the Linux build was not installed');
    const dest = `${WORKSPACE_ENGINES}/godot/${manifest.version}/${rel}`;
    await writeIn(host, dest, await fsp.readFile(path.join(report.dir, rel)), signal);
    await writeIn(host, `${path.posix.dirname(dest)}/_sc_`, '', signal);
    if (templates.length && manifest.templates) {
      const tdir = `editor_data/export_templates/${manifest.templates.version}`;
      for (const f of manifest.templates.files.filter((x) => x.startsWith(`${path.posix.dirname(rel)}/${tdir}/`) && /(linux_|web_|version\.txt|icudt)/.test(x))) {
        await writeIn(host, `${WORKSPACE_ENGINES}/godot/${manifest.version}/${f}`, await fsp.readFile(path.join(report.dir, f)), signal);
      }
    }
    await runIn(host, 'chmod', ['+x', dest], { timeoutMs: 30_000, signal });
    files.push(dest);
    note = ` The Linux build is in the workspace at ${dest} for this sandbox.`;
  }
  const bins = Object.entries(manifest.binaries).map(([k, b]) => `${BUILDS[k]?.folder ?? k}: ${b}`).join(', ');
  const t = manifest.templates ? ` Export templates ${manifest.templates.version}: ${manifest.templates.sets.join(', ')}.` : '';
  const got = report.downloaded.length ? `downloaded and verified (SHA-512) ${report.downloaded.join(', ')}` : 'nothing to download';
  return R('install', 'ok', `Godot ${manifest.version} in ${report.dir}: ${got}${report.kept.length ? `; already there: ${report.kept.join(', ')}` : ''}.${t}${note}`, { files, data: { version: manifest.version, dir: report.dir, binaries: manifest.binaries, templates: manifest.templates, source: manifest.source } });
}

// ---------- project.create ----------

async function createProject(input, host, signal) {
  const template = TEMPLATE_ALIASES[String(input.template ?? '').toLowerCase()] ?? String(input.template ?? '').toLowerCase();
  if (!TEMPLATES[template]) return R('project.create', 'failed', `template must be one of ${Object.keys(TEMPLATES).join(', ')} (${Object.entries(TEMPLATES).map(([k, t]) => `${k}: ${t.what}`).join('; ')})`);
  const project = await relIn(host, String(input.project ?? 'game'));
  if (await readTextIn(host, inProject(project, 'project.godot'), signal) !== null) return R('project.create', 'failed', `${inProject(project, 'project.godot')} exists already: project.create never overwrites a project (choose another folder)`);
  const name = String(input.name ?? 'My Game').slice(0, 80);
  const files = [];
  for (const [rel, data] of await templateFiles(template, name)) {
    await writeIn(host, inProject(project, rel), data, signal);
    files.push(inProject(project, rel));
  }
  if (await readTextIn(host, '.studio/project.json', signal) === null) {
    await writeIn(host, '.studio/project.json', studioProject(name, template, inProject(project, 'project.godot')), signal);
    files.push('.studio/project.json');
  }
  const t = TEMPLATES[template];
  let verified = '';
  const problems = [];
  const bin = input.verify === false ? null : await locate(host, 'godot', signal);
  if (bin) {
    problems.push(...await importProject(host, bin, project, signal));
    const st = await selftestGodot(host, bin, project, signal);
    if (st.passed) verified = ` Verified: it imports and its self-test passes (${t.checks.join(', ')}) in ${st.took}.`;
    else problems.push(...st.problems);
  } else if (input.verify !== false) verified = ' Not verified: Godot is not installed here ({"action": "install"}).';
  return R('project.create', problems.length ? 'failed' : 'ok', `a ${template} project "${name}" in ${project}: ${t.what}; input map move_left/right/up/down, jump, action; the StudioHook autoload; tests in tests/; Windows, Web and Linux export presets.${verified} Next: check, test, play.`, { files, problems: asProblems(problems), data: { template, project, checks: t.checks } });
}

// ---------- describe, script, assets ----------

async function describe(input, host, bin, project, signal) {
  if (input.live) {
    const info = await liveInfo(host, project, signal);
    return R('describe', 'ok', 'the scene open in the editor', { data: await bridgeCall(info, 'tree', { depth: Number(input.depth) || 12 }) });
  }
  const problems = await importProject(host, bin, project, signal);
  const { r, report, problems: p2 } = await bootRun(host, bin, project, { mode: 'describe', frames: Math.min(Math.max(Number(input.frames) || 2, 1), 600), scene: input.scene ? res(input.scene) : '', depth: Number(input.depth) || 12 }, { timeoutMs: seconds(input.timeoutSec, 120), signal });
  problems.push(...p2);
  if (!report) return R('describe', 'failed', `the scene did not run to be described (exit ${r.code}${r.timedOut ? ', timed out' : ''})`, { problems: asProblems(problems), log: tail(r.output, 30) });
  return R('describe', 'ok', `${report.scene || 'the main scene'}: ${report.nodes} node(s)${report.truncated ? ' (first 400)' : ''} after ${input.frames ?? 2} frame(s); project "${report.project?.name}", ${Object.keys(report.project?.actions ?? {}).length} input action(s), autoloads: ${Object.keys(report.project?.autoloads ?? {}).join(', ') || 'none'}`, { problems: asProblems(problems), data: report });
}

async function liveInfo(host, project, signal) {
  if (host.kind !== 'local') throw new Error('the editor bridge reaches an editor on the server\'s own machine (127.0.0.1): this session runs elsewhere');
  const info = await bridgeInfo(host, project, signal);
  if (!info) throw new Error(`no Godot editor with the Harness Bridge has ${project} open (no ${inProject(project, '.godot/harness_bridge.json')}): bridge.install, then open the project in Godot and enable the plugin (Project > Project Settings > Plugins)`);
  return info;
}

/** Runs GDScript headless: a SceneTree script as given, or code wrapped in _initialize (root is the tree's root). */
async function script(input, host, bin, project, signal) {
  if (!input.script === !input.code) return R('script', 'failed', 'give either script (a .gd file extending SceneTree, res:// or project-relative) or code (GDScript), not both');
  if (input.live) {
    if (!input.code) return R('script', 'failed', 'live scripts are code (the body of run(root, editor), which may return a value)');
    const info = await liveInfo(host, project, signal);
    const out = await bridgeCall(info, 'run', { code: String(input.code) }, { timeoutMs: seconds(input.timeoutSec, 60) });
    return R('script', 'ok', `ran in the open editor${out.value !== null && out.value !== undefined ? `: returned ${String(out.value).slice(0, 300)}` : ''}`, { data: out });
  }
  let file = input.script ? res(input.script) : '';
  let temp;
  if (input.code) {
    const code = String(input.code);
    const src = /^\s*(@tool\s+)?extends\s/m.test(code.split('\n').find((l) => l.trim() && !l.trim().startsWith('#')) ?? '')
      ? code
      : `extends SceneTree\n# Written by the godot tool's script action. Safe to delete.\n\nfunc _initialize() -> void:\n${code.split('\n').map((l) => `\t${l}`).join('\n')}\n\tquit()\n`;
    temp = inProject(project, `.godot/harness/script-${newId()}.gd`);
    await writeIn(host, temp, src, signal);
    file = `res://${temp.slice(project === '.' ? 0 : project.length + 1)}`;
  }
  try {
    const problems = await importProject(host, bin, project, signal);
    const r = await runIn(host, bin, ['--headless', '--path', project, '--script', file, ...(Array.isArray(input.args) && input.args.length ? ['--', ...input.args.map(String)] : [])], { timeoutMs: seconds(input.timeoutSec, 120), signal });
    problems.push(...godotProblems(r.output));
    const status = r.timedOut ? 'timed-out' : problems.length || r.code !== 0 ? 'failed' : 'ok';
    return R('script', status, r.timedOut ? 'the script did not finish (call quit() at the end)' : `exit ${r.code} in ${r.took}, ${problems.length ? `${problems.length} error(s)` : 'no errors'}`, { problems: asProblems(problems), log: tail(r.output, 60) });
  } finally { if (temp) await removeIn(host, temp, signal).catch(() => {}); }
}

/**
 * Copies a workspace file, or a Studio asset folder (.studio/assets/<id> with asset.json),
 * into the project's assets/ and imports it. The asset.json records where it went.
 */
async function assetImport(input, host, bin, project, signal) {
  if (!input.file && !input.asset) return R('asset.import', 'failed', 'give file (a .glb, .gltf, .png, .wav, .ogg... in the workspace) or asset (a Studio asset id or folder: .studio/assets/<id>)');
  const copied = [];
  let assetRel;
  let id;
  if (input.asset) {
    const a = String(input.asset);
    const dir = await relIn(host, a.includes('/') ? a : `.studio/assets/${a}`);
    const text = await readTextIn(host, `${dir}/asset.json`, signal);
    if (text === null) return R('asset.import', 'failed', `no asset.json in ${dir}`);
    const asset = JSON.parse(text);
    id = String(asset.id ?? path.posix.basename(dir)).replace(/[^\w.-]/g, '_');
    const destDir = inProject(project, `assets/${id}`);
    for (const f of (asset.files ?? []).map((x) => String(x.path))) {
      await writeIn(host, `${destDir}/${f}`, await readIn(host, `${dir}/${f}`, signal), signal);
      copied.push(`${destDir}/${f}`);
    }
    const main = (asset.files ?? []).find((x) => x.role === 'main') ?? asset.files?.[0];
    const now = new Date().toISOString();
    const at = { path: `res://assets/${id}/${main?.path ?? ''}`, importedAt: now };
    asset.engines = { ...(asset.engines ?? {}), godot: at };
    asset.updated = now;
    await writeIn(host, `${destDir}/asset.json`, `${JSON.stringify(asset, null, 1)}\n`, signal);
    copied.push(`${destDir}/asset.json`);
    // The source records it too (FORMATS.md: the engines it was imported into).
    await writeIn(host, `${dir}/asset.json`, `${JSON.stringify(asset, null, 1)}\n`, signal);
    assetRel = at.path;
  } else {
    const src = await relIn(host, String(input.file));
    const base = path.posix.basename(src);
    const dest = inProject(project, input.dest ? String(input.dest).replace(/^res:\/\//, '') : `assets/${base}`);
    await writeIn(host, dest, await readIn(host, src, signal), signal);
    copied.push(dest);
    assetRel = res(dest.slice(project === '.' ? 0 : project.length + 1));
  }
  const problems = await importProject(host, bin, project, signal);
  return R('asset.import', problems.length ? 'failed' : 'ok', `imported into ${project}: ${assetRel}${id ? ` (asset ${id})` : ''}${problems.length ? ` with ${problems.length} problem(s)` : ''}`, { files: copied, problems: asProblems(problems), data: { path: assetRel } });
}

/** The running scene (after a few frames, so code-built nodes exist) as glTF. */
async function assetExport(input, host, bin, project, signal) {
  const out = await relIn(host, String(input.output ?? 'exports/scene.glb'));
  if (!/\.(glb|gltf)$/i.test(out)) return R('asset.export', 'failed', 'output must be a .glb or .gltf file');
  await mkdirIn(host, path.posix.dirname(out), signal);
  const problems = await importProject(host, bin, project, signal);
  const { r, report, problems: p2 } = await bootRun(host, bin, project, { mode: 'gltf', frames: Math.max(Number(input.frames) || 2, 1), scene: input.scene ? res(input.scene) : '', file: runtimePath(host, out) }, { timeoutMs: seconds(input.timeoutSec, 120), signal });
  problems.push(...p2);
  if (!report || report.error !== 0) return R('asset.export', 'failed', `the export did not finish (error ${report?.error ?? `exit ${r.code}`})`, { problems: asProblems(problems), log: tail(r.output, 30) });
  return R('asset.export', 'ok', `${input.scene ?? 'the main scene'} -> ${out}: ${report.meshes} mesh(es), ${report.nodes} node(s)`, { files: [out], problems: asProblems(problems), data: report });
}

// ---------- capture, render ----------

async function capture(input, host, bin, project, signal) {
  if (input.live) {
    const info = await liveInfo(host, project, signal);
    const r = await bridgeCall(info, 'capture', { viewport: input.viewport === '2d' ? '2d' : '3d' });
    const png = Buffer.from(r.png, 'base64');
    const out = await relIn(host, String(input.out ?? '.harness/godot/editor.png'));
    await writeIn(host, out, png, signal);
    return { result: R('capture', 'ok', `the editor's ${input.viewport === '2d' ? '2D' : '3D'} viewport, ${r.size.join('x')}, saved to ${out}`, { files: [out] }), images: [{ media_type: 'image/png', data: r.png }] };
  }
  const frames = Math.min(Math.max(Math.round(Number(input.frames) || 30), 1), 3600);
  const dirRel = `.harness/godot/capture-${newId()}`;
  const out = await relIn(host, String(input.out ?? '.harness/godot/capture.png'));
  if (!out.toLowerCase().endsWith('.png')) return { result: R('capture', 'failed', 'out must be a .png file') };
  const problems = await importProject(host, bin, project, signal);
  try {
    const { r, report, problems: p2 } = await bootRun(host, bin, project, { mode: 'play', frames, every: frames, out: runtimePath(host, dirRel), scene: input.scene ? res(input.scene) : '', inputs: timeline(input.inputs) }, { windowed: true, size: sizeOf(input.size), renderer: input.renderer, args: input.args ?? [], timeoutMs: seconds(input.timeoutSec, 180), signal });
    problems.push(...p2);
    const shot = report?.captures?.at(-1);
    if (!shot) return { result: R('capture', 'failed', `no frame was drawn (exit ${r.code}${r.timedOut ? ', timed out' : ''}).${host.platform === 'linux' ? ' A display is needed: Xvfb on Linux (the 3D sandbox image has it).' : ''}`, { problems: asProblems(problems), log: tail(r.output, 30) }) };
    const png = await readIn(host, workspaceRel(host, shot.file), signal);
    await writeIn(host, out, png, signal);
    return { result: R('capture', problems.length ? 'failed' : 'ok', `frame ${shot.frame} saved to ${out}${problems.length ? `; ${problems.length} error(s) while running` : ''}`, { files: [out], problems: asProblems(problems), data: { state: shot.state } }), images: [{ media_type: 'image/png', data: png.toString('base64') }] };
  } finally { await removeIn(host, dirRel, signal).catch(() => {}); }
}

/** Godot's movie maker: N frames at a fixed 60 per second, as PNGs in a folder or one .avi. */
async function render(input, host, bin, project, signal) {
  const frames = Math.min(Math.max(Math.round(Number(input.frames) || 120), 1), 36_000);
  const out = await relIn(host, String(input.out ?? `renders/godot-${newId()}`));
  const video = /\.avi$/i.test(out);
  const dir = video ? path.posix.dirname(out) : out;
  await mkdirIn(host, dir, signal);
  const problems = await importProject(host, bin, project, signal);
  const movie = video ? runtimePath(host, out) : runtimePath(host, `${out}/frame.png`);
  const size = sizeOf(input.size);
  // The project's own renderer on a machine with a GPU; OpenGL on the CPU in a container or on Linux.
  const compat = input.renderer === 'compatibility' || (input.renderer !== 'project' && (host.kind === 'docker' || host.platform === 'linux'));
  const user = Array.isArray(input.args) && input.args.length ? ['--', ...input.args.map(String)] : [];
  const args = ['--path', project, ...(compat ? ['--rendering-driver', 'opengl3', '--rendering-method', 'gl_compatibility'] : []), '--audio-driver', 'Dummy', ...(size ? ['--resolution', `${size[0]}x${size[1]}`] : []), '--fixed-fps', '60', '--write-movie', movie, '--quit-after', String(frames), ...(input.scene ? [res(input.scene)] : []), ...user];
  const r = await runJob('godot', `render ${frames} frames`, (sig) => runIn(host, bin, args, { timeoutMs: seconds(input.timeoutSec, 900), signal: sig, prefix: withDisplay(host) }), { signal, timeoutMs: seconds(input.timeoutSec, 900) + 60_000 });
  problems.push(...godotProblems(r.output));
  const written = video ? (await listIn(host, dir, signal)).filter((f) => f === path.posix.basename(out)).map((f) => `${dir}/${f}`) : (await listIn(host, out, signal)).filter((f) => /^frame\d+\.png$/.test(f)).sort().map((f) => `${out}/${f}`);
  if (!written.length) return { result: R('render', 'failed', `nothing was written (exit ${r.code}${r.timedOut ? ', timed out' : ''})`, { problems: asProblems(problems), log: tail(r.output, 30) }) };
  const images = video ? [] : await someFrames(host, written, Math.min(Number(input.show ?? 3), 6), signal);
  return { result: R('render', problems.length ? 'failed' : 'ok', `${video ? `a video of ${frames} frames: ${out}` : `${written.length} frame(s) in ${out}`} (${r.took})`, { files: video ? written : [written[0], written.at(-1)], problems: asProblems(problems), metrics: { frames: written.length || frames } }), images };
}

// ---------- build, export, package ----------

const templatesMissing = (host) => (host.kind === 'docker'
  ? 'Godot\'s export templates are not in this sandbox image. The operator builds the image with them (npm run sandbox:image:3d-export: harness-sandbox-3d:export, Linux and Web templates), allows it with HARNESS_SANDBOX_IMAGES, and a new session picks it; or {"action": "install"} puts the official Linux build with its templates into the workspace.'
  : 'Godot\'s export templates are not installed for this Godot version. Install them with {"action": "install"} (the official build and its Windows, Web and Linux templates, checksums verified; asks first), or in the editor (Editor > Manage Export Templates).');

const KIND_OF = { 'Windows Desktop': 'windows', Web: 'web', Linux: 'linux', 'Linux/X11': 'linux' };

/**
 * Exports with a preset from export_presets.cfg. A missing preset is an error that names
 * the ones there; only with createPreset ("windows", "linux" or "web") does the tool add one,
 * and it says so. Returns the legacy text (the export action) and the result (build).
 */
async function exportGodot(input, host, bin, project, signal, action = 'export') {
  let kind = input.createPreset === undefined || input.createPreset === '' || input.createPreset === false ? undefined : String(input.createPreset).toLowerCase();
  if (kind === 'true') kind = input.platform ? String(input.platform).toLowerCase() : hostPreset(host.platform);
  if (kind && !PRESETS[kind]) return { text: 'createPreset must be "windows", "linux" or "web".', ok: false };
  const cfgRel = inProject(project, 'export_presets.cfg');
  const cfg = await readTextIn(host, cfgRel, signal);
  const presets = cfg === null ? [] : presetsIn(cfg);
  const platform = input.platform ? String(input.platform).toLowerCase() : undefined;
  if (platform && !PRESETS[platform]) return { text: 'platform must be "windows", "web" or "linux".', ok: false };
  const byPlatform = platform ? presets.find((p) => KIND_OF[p.platform] === platform) : undefined;
  const preset = String(input.preset ?? byPlatform?.name ?? (kind ? PRESETS[kind].name : platform ? PRESETS[platform].name : ''));
  const chosen = presets.find((p) => p.name === preset);
  const outKind = kind ?? KIND_OF[chosen?.platform] ?? platform;
  const outputIn = input.output ?? (outKind ? PRESETS[outKind].output : undefined);
  if (!preset || !outputIn) return { text: 'export needs preset (a name in export_presets.cfg) and output (the file to write, e.g. build/windows/game.exe, build/web/index.html or build/linux/game.x86_64); or platform ("windows", "web", "linux"); or createPreset ("windows", "linux" or "web") to add a preset when the project has none.', ok: false };
  const output = await relIn(host, String(outputIn));
  let note = '';
  if (!chosen) {
    if (!kind) {
      const there = presets.length ? `The presets there: ${presets.map((p) => `"${p.name}" (${p.platform})`).join(', ')}.` : cfg === null ? `${cfgRel} does not exist.` : `${cfgRel} has no presets.`;
      return { text: `godot ${action}: no preset named "${preset}". ${there} Add one to export_presets.cfg (godot-essentials has minimal ones), or call ${action} again with createPreset: "windows", "linux" or "web" to have a minimal one written.`, ok: false };
    }
    const exportPath = path.posix.relative(project === '.' ? '' : project, output);
    await writeIn(host, cfgRel, addPreset(cfg ?? '', kind, preset, exportPath), signal);
    note = `\nWrote a minimal ${PRESETS[kind].platform} preset "${preset}" to ${cfgRel} (it was not there).`;
  } else if (kind) note = `\nUsed the preset "${preset}" already in ${cfgRel} (createPreset changed nothing).`;
  const imp = await runIn(host, bin, godotArgs('import', { project }), { timeoutMs: 300_000, signal });
  if (imp.timedOut) return { text: `godot: the import timed out after 5 minutes${note}`, ok: false };
  await mkdirIn(host, path.posix.dirname(output), signal);
  const timeoutMs = seconds(input.timeoutSec, 600);
  const r = await runJob('godot', `export ${preset}`, (sig) => runIn(host, bin, godotArgs('export', { project, preset, output: runtimePath(host, output), debug: input.debug === true }), { timeoutMs, signal: sig }), { signal, timeoutMs: timeoutMs + 60_000 });
  const logFile = `.harness/godot/build-${newId()}.log`;
  await writeIn(host, logFile, r.output, signal).catch(() => {});
  if (/No export template found/i.test(r.output)) return { text: `godot ${action}: ${templatesMissing(host)} Everything else can still be checked with check, run and screenshot.${note}\n\n${tail(r.output, 12)}`, ok: false, templates: false, logFile };
  if (/presets were detected|Invalid export preset name|no export_presets/i.test(r.output)) return { text: `godot ${action}: Godot did not find the preset "${preset}" in export_presets.cfg.${note}\n\n${tail(r.output, 12)}`, ok: false, logFile };
  const problems = godotProblems(r.output);
  if (r.code !== 0 || r.timedOut) return { text: `godot ${action} failed (exit ${r.code}${r.timedOut ? ', timed out' : ''}):${note}\n${problems.length ? `${problems.slice(0, 20).join('\n')}\n\n` : ''}${tail(r.output, 40)}`, ok: false, problems, logFile };
  // What was written: the files beside the output (a binary and its .pck, a Web page and its .wasm/.pck/.js).
  const dir = path.posix.dirname(output);
  const base = path.posix.basename(output).replace(/\.[^.]+$/, '');
  const written = (await listIn(host, dir, signal)).filter((f) => f === path.posix.basename(output) || f.startsWith(`${base}.`)).sort();
  if (!written.includes(path.posix.basename(output))) return { text: `godot ${action}: Godot exited 0 but ${output} was not written.${note}\n\n${tail(r.output, 40)}`, ok: false, logFile };
  let sizes = '';
  let bytes = 0;
  if (host.kind !== 'companion') {
    const st = await Promise.all(written.map(async (f) => { const s = (await fsp.stat(path.join(host.root, dir, f))).size; bytes += s; return `${f} ${(s / 1048576).toFixed(1)} MB`; }));
    sizes = st.join(', ');
  }
  return { text: `godot ${action}: ${preset} -> ${output} in ${r.took}${input.debug === true ? ' (debug)' : ''}.${note}\nWritten in ${dir}: ${sizes || written.join(', ')}`, ok: true, preset, platform: outKind, output, files: written.map((f) => `${dir}/${f}`), bytes, took: r.took, logFile, problems };
}

/** A build as Studio records it (FORMATS.md builds[]), when the workspace has .studio/project.json. */
async function recordBuild(host, b, signal) {
  const text = await readTextIn(host, '.studio/project.json', signal);
  if (text === null) return;
  try {
    const p = JSON.parse(text);
    p.builds = [...(Array.isArray(p.builds) ? p.builds : []), { id: `b${(p.builds?.length ?? 0) + 1}`, platform: b.platform, path: b.output, status: 'ok', at: new Date().toISOString(), engine: 'godot', preset: b.preset }];
    await writeIn(host, '.studio/project.json', `${JSON.stringify(p, null, 1)}\n`, signal);
  } catch { /* not ours to fix */ }
}

async function build(input, host, bin, project, signal, action) {
  const e = await exportGodot(input, host, bin, project, signal, action);
  if (!e.ok) return R(action, 'failed', e.text.split('\n')[0].replace(/^godot \w+: /, ''), { log: e.text, logFile: e.logFile, problems: asProblems(e.problems ?? []) });
  await recordBuild(host, e, signal);
  let files = e.files;
  let summary = e.text.split('\n')[0].replace(/^godot \w+: /, '').replace(/\.$/, '');
  if (action === 'package') {
    if (host.kind === 'companion') return R('package', 'failed', 'package zips on the server: in a companion session use build and zip the folder there');
    const zip = await relIn(host, String(input.zip ?? path.posix.join(path.posix.dirname(path.posix.dirname(e.output)), `${String(input.name ?? 'game').replace(/[^\w.-]/g, '_')}-${e.platform}.zip`)));
    const z = await writeZip(path.join(host.root, zip), e.files.map((f) => ({ name: path.posix.basename(f), file: path.join(host.root, f), executable: !/\.(pck|html|js|wasm|png|ico|svg|json)$/i.test(f) })));
    files = [zip, ...e.files];
    summary += `; packaged as ${zip} (${(z.bytes / 1048576).toFixed(1)} MB, ${z.files} files)`;
  }
  return R(action, 'ok', summary, { files, logFile: e.logFile, metrics: { bytes: e.bytes }, data: { preset: e.preset, platform: e.platform, output: e.output, note: e.text.split('\n').slice(1).join('\n') } });
}

// ---------- test, play, step ----------

async function test(input, host, bin, project, signal) {
  const base = inProject(project, 'addons/harness_test/test_case.gd');
  const notes = [];
  if (await readTextIn(host, base, signal) === null) {
    await writeIn(host, base, await fsp.readFile(path.join(PLUGIN_DIR, 'gd', 'test_case.gd')), signal);
    notes.push(`added the test base class ${base}`);
  }
  const problems = await importProject(host, bin, project, signal);
  const run = (sig) => bootRun(host, bin, project, { mode: 'test', dir: input.dir ? res(input.dir) : 'res://tests', filter: String(input.filter ?? ''), sceneFrames: Number(input.sceneFrames) || 600 }, { timeoutMs: seconds(input.timeoutSec, 600), signal: sig });
  const { r } = await runJob('godot', 'test', run, { signal, timeoutMs: seconds(input.timeoutSec, 600) + 60_000 });
  const tests = [];
  let summary = null;
  for (const l of r.output.split('\n')) {
    const t = /HARNESS_TEST (\{.*\})\s*$/.exec(l);
    if (t) { try { tests.push(JSON.parse(t[1])); } catch { /* broken line */ } }
    const s = /HARNESS_TESTS_DONE (\{.*\})\s*$/.exec(l);
    if (s) { try { summary = JSON.parse(s[1]); } catch { /* broken line */ } }
  }
  if (input.selftest) {
    const st = await selftestGodot(host, bin, project, signal);
    tests.push({ suite: '--selftest', name: 'selftest', status: st.passed ? 'passed' : 'failed', failures: st.problems.map((m) => ({ message: m })), ms: Math.round(parseFloat(st.took ?? '0') * 1000) });
  }
  const failed = tests.filter((t) => t.status === 'failed');
  const counts = { tests: tests.length, passed: tests.filter((t) => t.status === 'passed').length, failed: failed.length, skipped: tests.filter((t) => t.status === 'skipped').length };
  const errs = godotProblems(r.output).filter((p) => !tests.some((t) => t.failures?.some((f) => p.includes(String(f.message).replace(/^error: /, '').slice(0, 40)))));
  const testProblems = failed.flatMap((t) => (t.failures?.length ? t.failures : [{ message: 'failed' }]).map((f) => ({ severity: 'error', message: `${t.name}: ${f.message}`, file: f.file?.replace(/^res:\/\//, `${project === '.' ? '' : `${project}/`}`), line: f.line })));
  if (!summary && !tests.length) return R('test', r.timedOut ? 'timed-out' : 'failed', `the tests did not run (exit ${r.code}${r.timedOut ? ', timed out' : ''})`, { problems: asProblems([...problems, ...errs]), log: tail(r.output, 40) });
  if (!tests.length) return R('test', 'failed', 'no tests found: write res://tests/test_*.gd files that extend res://addons/harness_test/test_case.gd (godot-gdscript-testing)', { data: { summary } });
  return R('test', failed.length || problems.length ? 'failed' : 'ok', `${counts.passed} of ${counts.tests} test(s) passed${counts.failed ? `, ${counts.failed} failed` : ''}${counts.skipped ? `, ${counts.skipped} skipped` : ''} in ${summary?.ms ?? '?'} ms${notes.length ? ` (${notes.join('; ')})` : ''}`, { problems: [...testProblems, ...asProblems([...problems, ...(failed.length ? [] : errs)])], metrics: counts, data: { tests, summary } });
}

async function play(input, host, bin, project, signal) {
  const fps = 60;
  const secondsIn = Math.min(Math.max(Number(input.seconds) || 0, 0), 600);
  const frames = Math.min(Math.max(Math.round(Number(input.frames) || (secondsIn ? secondsIn * fps : 300)), 1), 36_000);
  const every = input.every === undefined ? 60 : Math.max(0, Math.round(Number(input.every)));
  const windowed = input.headless === true ? false : every > 0;
  const outRel = await relIn(host, String(input.out ?? `.harness/godot/play-${newId()}`));
  if (windowed) await mkdirIn(host, outRel, signal);
  const inputs = timeline(input.inputs, fps);
  const problems = await importProject(host, bin, project, signal);
  const timeoutMs = seconds(input.timeoutSec, Math.max(120, Math.ceil(frames / fps) * 4 + 60));
  const { r, report, problems: p2 } = await runJob('godot', `play ${frames} frames`, (sig) => bootRun(host, bin, project, { mode: 'play', frames, every: windowed ? every : 0, out: windowed ? runtimePath(host, outRel) : '', scene: input.scene ? res(input.scene) : '', inputs, fps }, { windowed, size: sizeOf(input.size), uncapped: input.uncapped === true, renderer: input.renderer, fixed: input.realtime !== true, args: input.args ?? [], timeoutMs, signal: sig }), { signal, timeoutMs: timeoutMs + 60_000 });
  problems.push(...p2);
  if (!report) return { result: R('play', r.timedOut ? 'timed-out' : 'failed', `the game did not finish ${frames} frames (exit ${r.code}${r.timedOut ? ', timed out' : ''})`, { problems: asProblems(problems), log: tail(r.output, 40) }) };
  const frameFiles = (report.captures ?? []).map((c) => workspaceRel(host, c.file));
  const images = await someFrames(host, frameFiles, Math.min(Number(input.show ?? 4), 8), signal);
  const m = metricsOf(report.metrics, { errors: problems.length, captures: frameFiles.length });
  const status = problems.length ? 'failed' : 'ok';
  const frameNote = windowed ? (report.noFrames ? ' No frames were drawn (no display?).' : ` ${frameFiles.length} frame(s) in ${outRel}.`) : ' Headless: state only, no frames.';
  return {
    result: R('play', status, `${report.metrics.frames} frames (${report.metrics.gameSeconds}s of game time) in ${report.metrics.realSeconds}s: ${report.metrics.fps} fps, frame ${report.metrics.frameMsAvg} ms avg / ${report.metrics.frameMsP95} p95, ${report.metrics.memoryMb} MB; ${report.applied} of ${report.inputs} input(s) applied; ${problems.length ? `${problems.length} error(s)` : 'no errors'}.${frameNote}`, {
      files: frameFiles, problems: asProblems(problems), metrics: m,
      data: { state: report.state, events: report.events, captures: (report.captures ?? []).map((c) => ({ frame: c.frame, file: workspaceRel(host, c.file), state: c.state })) },
    }),
    images,
  };
}

async function stepStart(input, host, bin, project, signal) {
  const problems = await importProject(host, bin, project, signal);
  if (problems.length) return { result: R('step.start', 'failed', 'the project does not import cleanly', { problems: asProblems(problems) }) };
  const windowed = input.headless !== true;
  const { session, reply } = await startStep(host, bin, project, { windowed, size: sizeOf(input.size ?? [960, 540]), scene: input.scene, args: input.args, renderer: input.renderer }, signal);
  return stepResult('step.start', session, reply, host, signal, `step session ${session.id} started (${windowed ? 'windowed: frames come back' : 'headless: state only'}): send {"action": "step", "session": "${session.id}", "inputs": [...], "frames": N}; stop it with step.stop`);
}

async function stepResult(action, s, reply, host, signal, lead) {
  if (!reply.ok) return { result: R(action, 'failed', reply.error ?? 'the step failed') };
  const images = [];
  const files = [];
  if (reply.file) {
    const rel = workspaceRel(host, reply.file);
    try { images.push({ media_type: 'image/png', data: (await readIn(host, rel, signal)).toString('base64') }); files.push(rel); } catch { /* not written */ }
  }
  const errs = godotProblems(s.log.join('\n'));
  s.log.length = 0;
  return { result: R(action, errs.length ? 'failed' : 'ok', `${lead ?? `step ${reply.step}`}: frame ${reply.frame}${reply.file || action === 'step.state' ? '' : s.windowed ? ' (no frame)' : ' (headless: no frame)'}`, { files, problems: asProblems(errs), metrics: metricsOf(reply.metrics), data: { session: s.id, frame: reply.frame, state: reply.state, events: reply.events } }), images };
}

// ---------- the tool ----------

async function runGodot(input, host, signal, api) {
  const action = String(input.action ?? 'check');
  if (!ACTIONS.includes(action)) return { content: `Unknown action ${action}: use ${ACTIONS.join(', ')}.`, is_error: true };
  const out = (r, images) => toToolResult(r, images);
  if (action === 'detect') return out(await detect(host, signal));
  if (action === 'jobs') return out(R('jobs', 'ok', `${listJobs().filter((j) => j.engine === 'godot').length} Godot job(s) in the last hour`, { data: listJobs() }));
  if (action === 'job.cancel') return out(R('job.cancel', cancelJob(String(input.job)) ? 'ok' : 'failed', `job ${input.job}`));
  if (action === 'install') return out(await install(input, host, signal, api));
  if (action === 'project.create') return out(await createProject(input, host, signal));
  if (action === 'step' || action === 'step.state' || action === 'step.stop') {
    const id = String(input.session ?? '');
    const s = stepSessions().get(id);
    if (action === 'step.stop') return out(R('step.stop', (await stopStep(id)) ? 'ok' : 'failed', `step session ${id || '(none given)'}${s ? ` ended after ${s.steps} step(s)` : ' is not open'}`));
    if (!s) return out(R(action, 'failed', `no step session ${id || '(give session)'}: open ones: ${[...stepSessions().keys()].join(', ') || 'none'}`));
    const reply = action === 'step.state' ? await stepState(id) : await step(id, { inputs: input.inputs, frames: input.frames, capture: input.capture !== false, timeoutMs: seconds(input.timeoutSec, 120) });
    const r = await stepResult(action, s, reply, host, signal);
    return out(r.result, r.images);
  }

  const project = await relIn(host, String(input.project ?? '.'));
  if (host.kind !== 'companion') {
    try { await fsp.access(path.join(host.root, project, 'project.godot')); } catch { return { content: `No project.godot in ${project}. Create the project first (project.create, or see the godot-essentials skill).`, is_error: true }; }
  }
  if (action === 'bridge.install') {
    const b = await installBridge(host, project, signal);
    return out(R('bridge.install', 'ok', `the Harness Bridge EditorPlugin is in ${inProject(project, 'addons/harness_bridge')}${b.enabledNow ? ' and enabled in project.godot' : ''}. Open the project in Godot (or, if it is open, enable it in Project > Project Settings > Plugins); then bridge.status.`, { files: b.files }));
  }
  if (action === 'bridge.status' || action === 'bridge.connect' || action === 'bridge.call') {
    if (host.kind !== 'local') return out(R(action, 'unavailable', 'the editor bridge reaches an editor on the server\'s own machine: this session runs commands elsewhere'));
    const info = await bridgeInfo(host, project, signal);
    if (!info) return out(R(action, action === 'bridge.status' ? 'ok' : 'unavailable', `no editor: ${inProject(project, '.godot/harness_bridge.json')} is not there (bridge.install, then open the project in Godot with the plugin on)`, { data: { connected: false } }));
    if (action === 'bridge.call') {
      const cmd = String(input.command ?? '');
      if (!COMMANDS.includes(cmd)) return out(R(action, 'failed', `command must be one of ${COMMANDS.join(', ')}`));
      const result = await bridgeCall(info, cmd, input.params && typeof input.params === 'object' ? input.params : {});
      const images = result?.png ? [{ media_type: 'image/png', data: result.png }] : [];
      return out(R(action, 'ok', `${cmd} in the open editor`, { data: result?.png ? { ...result, png: `(${result.png.length} base64 chars, shown)` } : result }), images);
    }
    try {
      const ping = await bridgeCall(info, 'ping', {}, { timeoutMs: 10_000 });
      return out(R(action, 'ok', `connected to Godot ${ping.godot} (pid ${info.pid}) on 127.0.0.1:${info.port}: project "${ping.project}", scene ${ping.scene || '(none open)'}${ping.playing ? ', playing' : ''}`, { data: { connected: true, ...ping, port: info.port } }));
    } catch (e) {
      return out(R(action, action === 'bridge.status' ? 'ok' : 'failed', `the bridge file is there but the editor does not answer (${e.message}): it was closed without removing it, or the plugin is off`, { data: { connected: false, port: info.port } }));
    }
  }

  const bin = await locate(host, 'godot', signal);
  if (!bin) {
    if (['check', 'run', 'screenshot', 'export'].includes(action)) return { content: missingIn(host, 'godot'), is_error: true };
    return out(notInstalled(host, action));
  }
  const timeoutMs = seconds(input.timeoutSec, 300);
  const frames = Math.min(Math.max(Math.round(Number(input.frames) || (action === 'run' ? 120 : 60)), 1), 3000);

  if (action === 'check') {
    const r = await checkGodot(host, bin, project, signal);
    return r.problems.length
      ? { content: `godot check: ${r.problems.length} problem(s) in ${project}:\n${r.problems.slice(0, 30).join('\n')}`, is_error: true }
      : `godot check: ${project} imports cleanly; ${Number.isNaN(r.checked) ? 'its' : r.checked} scripts and scenes load without errors.`;
  }
  if (action === 'export') {
    const e = await exportGodot(input, host, bin, project, signal);
    return e.ok ? e.text : { content: e.text, is_error: true };
  }
  if (action === 'build' || action === 'package') return out(await build(input, host, bin, project, signal, action));
  if (action === 'describe') return out(await describe(input, host, bin, project, signal));
  if (action === 'script') return out(await script(input, host, bin, project, signal));
  if (action === 'asset.import') return out(await assetImport(input, host, bin, project, signal));
  if (action === 'asset.export') return out(await assetExport(input, host, bin, project, signal));
  if (action === 'test') return out(await test(input, host, bin, project, signal));
  if (action === 'bridge.install') throw new Error('unreachable');
  if (action === 'capture' || action === 'render' || action === 'play' || action === 'step.start') {
    const r = action === 'capture' ? await capture(input, host, bin, project, signal) : action === 'render' ? await render(input, host, bin, project, signal) : action === 'play' ? await play(input, host, bin, project, signal) : await stepStart(input, host, bin, project, signal);
    return out(r.result, r.images);
  }

  // run and screenshot: as they always were.
  const imp = await runIn(host, bin, godotArgs('import', { project }), { timeoutMs: 300_000, signal });
  if (imp.timedOut) return { content: 'godot: the import timed out after 5 minutes', is_error: true };
  if (action === 'run') {
    const r = await runIn(host, bin, godotArgs('run', { project, frames, scene: input.scene, args: input.args }), { timeoutMs, signal });
    const problems = godotProblems(r.output);
    const head = r.timedOut ? `godot run: timed out after ${timeoutMs / 1000}s` : `godot run: ${frames} frames headless in ${r.took}, exit ${r.code}, ${problems.length ? `${problems.length} error(s)` : 'no errors'}`;
    return { content: `${head}${problems.length ? `\n${problems.slice(0, 30).join('\n')}` : ''}\n\nOutput (end):\n${tail(r.output, 40)}`, is_error: r.timedOut || problems.length > 0 || r.code !== 0 };
  }
  // screenshot: Godot draws where it runs and writes the frames into the workspace there;
  // the last one is brought back (a companion sends that one file).
  const shotOut = await relIn(host, String(input.out ?? '.harness/godot/screenshot.png'));
  if (path.extname(shotOut).toLowerCase() !== '.png') return { content: 'out must be a .png file', is_error: true };
  const framesDir = `.harness/godot/frames-${newId()}`;
  await mkdirIn(host, framesDir, signal);
  try {
    const r = await runIn(host, bin, godotArgs('screenshot', { project, frames, scene: input.scene, args: input.args, movie: runtimePath(host, `${framesDir}/frame.png`) }), { timeoutMs, signal, prefix: withDisplay(host) });
    const shots = (await listIn(host, framesDir, signal)).filter((f) => /^frame\d+\.png$/.test(f)).sort();
    const problems = godotProblems(r.output);
    if (!shots.length) return { content: `godot screenshot: no frame was drawn (exit ${r.code}${r.timedOut ? ', timed out' : ''}). A display is needed: Xvfb on Linux (the 3D sandbox image has it).${problems.length ? `\n${problems.slice(0, 20).join('\n')}` : ''}\n\nOutput (end):\n${tail(r.output, 40)}`, is_error: true };
    const png = await readIn(host, `${framesDir}/${shots.at(-1)}`, signal);
    await writeIn(host, shotOut, png, signal);
    return {
      content: `godot screenshot: frame ${shots.length} of ${frames} saved to ${shotOut} (${r.took}).${problems.length ? `\n${problems.length} error(s) while running:\n${problems.slice(0, 20).join('\n')}` : ' No errors while running.'}`,
      is_error: problems.length > 0,
      images: [{ media_type: 'image/png', data: png.toString('base64') }],
    };
  } finally { await removeIn(host, framesDir, signal).catch(() => {}); }
}

const DESCRIPTION = [
  'Godot 4 on a project in the workspace (the folder with project.godot), where the session\'s commands run. Load godot-essentials first (godot-2d for 2D and 2.5D, godot-gdscript-testing for tests).',
  'Actions: "detect" (version, path, export templates, gaps); "install" (the official Godot 4 build and export templates into the harness\'s engines folder, SHA-512 checked; asks first); "project.create" (template "2d", "2.5d" or "3d": a runnable project with an input map, a main scene, the StudioHook autoload with a --selftest, tests and export presets);',
  '"check" (import, load every script and scene); "run" (N frames headless, script errors); "describe" (the scene tree and project settings as data); "script" (GDScript headless: code or a SceneTree script);',
  '"asset.import" (a file or a Studio asset folder into assets/), "asset.export" (the running scene to .glb); "capture" (one rendered frame you see) and "screenshot" (the same with the movie writer); "render" (N frames as PNGs or an .avi);',
  '"build" / "export" (with a preset from export_presets.cfg, or platform "windows", "web", "linux"; createPreset writes a missing one), "package" (build, then a .zip); "test" (res://tests/test_*.gd suites and test scenes: structured results; selftest: true adds the --selftest run);',
  '"play" (N seconds with an input timeline [{t, action | key | button, down | up | hold}], a frame saved every k frames, metrics: fps, frame times, memory, errors, and the game\'s state from StudioHook); "step.start" / "step" / "step.state" / "step.stop" (a live game you advance N frames at a time with inputs, getting the frame and state back: for the AI player);',
  '"bridge.install" / "bridge.status" / "bridge.connect" / "bridge.call" (the person\'s open Godot editor through the Harness Bridge plugin: tree, add_node, set, remove, run, save, open, play, stop, capture; live: true on describe, script, capture uses it); "jobs" / "job.cancel" (the heavy-job queue).',
].join(' ');

const inputItem = { type: 'object', description: '{t: seconds (or f: frame), action: "move_right" | key: "Space" | button: 1 with x, y; down: true | up: true | hold: seconds}' };

export default {
  name: 'engine-godot',
  setup(api) {
    api.registerTool(defineTool({
      name: 'godot',
      description: DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ACTIONS },
          project: { type: 'string', description: 'Folder with project.godot (default the workspace root; project.create: the new folder, default "game")' },
          template: { type: 'string', enum: ['2d', '2.5d', '3d'], description: 'project.create' },
          name: { type: 'string', description: 'project.create: the game\'s name; package: the zip\'s base name' },
          verify: { type: 'boolean', description: 'project.create: import and self-test the new project (default true when Godot is there)' },
          scene: { type: 'string', description: 'The scene to run instead of the main one, e.g. res://levels/level_1.tscn' },
          frames: { type: 'number', description: 'Frames to run (60 per second of game time); step: frames to advance' },
          seconds: { type: 'number', description: 'play: seconds of game time (instead of frames)' },
          args: { type: 'array', items: { type: 'string' }, description: 'Arguments for the game, read with OS.get_cmdline_user_args() (e.g. ["--selftest"])' },
          inputs: { type: 'array', items: inputItem, description: 'play, capture, step: the input timeline (step: t/f are offsets from now)' },
          every: { type: 'number', description: 'play: save a frame every N frames (default 60; 0: none, headless)' },
          show: { type: 'number', description: 'play, render: frames to look at (default 4 / 3)' },
          headless: { type: 'boolean', description: 'play, step.start: no window and no frames, state only (faster)' },
          realtime: { type: 'boolean', description: 'play: real time instead of a fixed 60 frames per second of game time' },
          uncapped: { type: 'boolean', description: 'play: no vsync, so fps shows the headroom' },
          size: { type: 'array', items: { type: 'number' }, description: 'capture, play, step.start, render: window size [w, h]' },
          renderer: { type: 'string', enum: ['project', 'compatibility'], description: 'Frames with the project\'s renderer, or OpenGL compatibility (the default in containers and on Linux)' },
          session: { type: 'string', description: 'step, step.state, step.stop: the session from step.start' },
          capture: { type: 'boolean', description: 'step: bring back a frame (default true when windowed)' },
          out: { type: 'string', description: 'capture/screenshot: PNG path; render: a folder or an .avi; play: the frames folder' },
          code: { type: 'string', description: 'script: GDScript (a whole SceneTree script, or lines run in _initialize with root); live: the body of run(root, editor)' },
          script: { type: 'string', description: 'script: a .gd file extending SceneTree' },
          live: { type: 'boolean', description: 'describe, script, capture: in the person\'s open editor (the bridge)' },
          viewport: { type: 'string', enum: ['2d', '3d'], description: 'capture live: which editor viewport' },
          depth: { type: 'number', description: 'describe: tree depth (default 12)' },
          file: { type: 'string', description: 'asset.import: a workspace file' },
          asset: { type: 'string', description: 'asset.import: a Studio asset id (.studio/assets/<id>) or folder' },
          dest: { type: 'string', description: 'asset.import: where in the project (default assets/<file>)' },
          output: { type: 'string', description: 'export/build: the file to write (build/windows/game.exe, build/web/index.html, build/linux/game.x86_64); asset.export: the .glb' },
          preset: { type: 'string', description: 'export/build: a preset name in export_presets.cfg' },
          platform: { type: 'string', enum: ['windows', 'web', 'linux'], description: 'build/package: the preset for this platform' },
          createPreset: { type: ['string', 'boolean'], description: 'export/build: when there is no such preset, write a minimal one ("windows", "web", "linux", or true for platform). Never done without it.' },
          debug: { type: 'boolean', description: 'export/build: a debug build' },
          zip: { type: 'string', description: 'package: the zip to write' },
          filter: { type: 'string', description: 'test: only tests whose name or file contains this' },
          dir: { type: 'string', description: 'test: the tests folder (default res://tests)' },
          selftest: { type: 'boolean', description: 'test: also run the game\'s --selftest' },
          version: { type: 'string', description: 'install: a stable 4.x version (default the newest)' },
          platforms: { type: 'array', items: { type: 'string' }, description: 'install: windows, linux, macos (default this machine\'s and Linux)' },
          templates: { description: 'install: export template sets (windows, web, linux, macos), or false for none (default windows, web, linux)' },
          command: { type: 'string', enum: COMMANDS, description: 'bridge.call' },
          params: { type: 'object', description: 'bridge.call: the command\'s parameters' },
          job: { type: 'string', description: 'job.cancel: the job id' },
          timeoutSec: { type: 'number', description: 'Default per action (300; export 600), at most 3600' },
        },
        required: ['action'],
      },
      kind: 'exec',
      // install downloads onto the server: asked about as a network call too, even where commands are free (a sandbox).
      kindsFor: (i) => (i.action === 'install' ? ['exec', 'network'] : ['exec']),
      summarize: (i) => `${i.action} ${i.project ?? (i.action === 'project.create' ? 'game' : '.')}${i.template ? ` ${i.template}` : ''}${i.scene ? ` ${i.scene}` : ''}${i.preset ? ` preset ${i.preset}` : ''}${i.platform ? ` ${i.platform}` : ''}${i.session ? ` ${i.session}` : ''}`,
      run: async (input, { host, signal }) => {
        try { return await runGodot(input, host, signal, api); } catch (e) {
          if (e?.name === 'PathError' || /outside the workspace/.test(e?.message ?? '')) throw e;
          return toToolResult(R(String(input.action ?? 'check'), signal.aborted ? 'cancelled' : 'failed', e.message ?? String(e)));
        }
      },
    }));

    api.registerGate({
      name: 'godot-project',
      description: 'Each Godot project (project.godot) imports, every script and scene loads, and it runs 30 frames headless with no script errors.',
      applies: async (host, signal) => { try { return (await godotProjects(host, signal)).length > 0; } catch { return false; } },
      async run({ host, signal }) {
        const projects = await godotProjects(host, signal);
        if (!projects.length) return { pass: true, summary: 'no Godot project (project.godot) in the workspace' };
        const bin = await locate(host, 'godot', signal);
        if (!bin) return notChecked(host);
        const bad = [];
        for (const project of projects) {
          const c = await checkGodot(host, bin, project, signal);
          let problems = c.problems;
          if (!problems.length) {
            const r = await runIn(host, bin, godotArgs('run', { project, frames: 30 }), { timeoutMs: 180_000, signal });
            problems = r.timedOut ? ['30 frames did not finish in 3 minutes'] : godotProblems(r.output);
          }
          if (problems.length) bad.push(`${project}:\n  ${problems.slice(0, 15).join('\n  ')}`);
        }
        return bad.length
          ? { pass: false, summary: `${bad.length} of ${projects.length} Godot project(s) have errors`, details: `${bad.join('\n')}\nRun the godot tool (check, run) to see them.` }
          : { pass: true, summary: `${projects.length} Godot project(s) import, load and run cleanly: ${projects.join(', ')}` };
      },
    });

    api.registerGate({
      name: 'godot-selftest',
      description: `Each Godot project that has a --selftest mode runs it headless (up to ${SELFTEST_FRAMES} frames): it must print SELFTEST PASS and report no errors.`,
      applies: async (host, signal) => {
        try {
          if (host.kind === 'companion') return false; // decided by name in a workflow; a listing cannot see the scripts' text
          for (const p of await godotProjects(host, signal)) {
            for (const f of await findFiles(path.join(host.root, p), (n) => n.endsWith('.gd'), { max: 50, depth: 4 })) {
              if ((await fsp.readFile(path.join(host.root, p, f), 'utf8')).includes('--selftest')) return true;
            }
          }
        } catch { /* not applicable */ }
        return false;
      },
      async run({ host, signal }) {
        const projects = await godotProjects(host, signal);
        if (!projects.length) return { pass: false, summary: 'no Godot project (project.godot) in the workspace to self-test' };
        const bin = await locate(host, 'godot', signal);
        if (!bin) return notChecked(host);
        const bad = [];
        const ok = [];
        for (const project of projects) {
          const r = await selftestGodot(host, bin, project, signal);
          if (r.passed) ok.push(`${project} (${r.took})`);
          else bad.push(`${project}:\n  ${r.problems.slice(0, 15).join('\n  ')}\n  Output (end):\n  ${tail(r.output, 15, 1500).replace(/\n/g, '\n  ')}`);
        }
        return bad.length
          ? { pass: false, summary: `${bad.length} of ${projects.length} Godot self-test(s) failed`, details: `${bad.join('\n')}\nRun it with the godot tool: {"action": "run", "args": ["--selftest"], "frames": ${SELFTEST_FRAMES}}.` }
          : { pass: true, summary: `${projects.length} Godot self-test(s) passed: ${ok.join(', ')}` };
      },
    });

    api.registerGate({
      name: 'godot-export',
      description: 'Each Godot project with an export_presets.cfg builds with its presets (into .harness/godot/export-check, not the real build folder): the files are written and Godot reports no errors.',
      applies: async (host, signal) => {
        try {
          for (const p of await godotProjects(host, signal)) if (await readTextIn(host, inProject(p, 'export_presets.cfg'), signal) !== null) return true;
        } catch { /* not applicable */ }
        return false;
      },
      async run({ host, signal }) {
        const projects = await godotProjects(host, signal);
        const bin = await locate(host, 'godot', signal);
        if (!bin) return notChecked(host);
        const bad = [];
        const ok = [];
        const skipped = [];
        for (const project of projects) {
          const cfg = await readTextIn(host, inProject(project, 'export_presets.cfg'), signal);
          if (cfg === null) continue;
          const base = `.harness/godot/export-check/${project === '.' ? 'root' : project.replace(/[\\/]/g, '_')}`;
          for (const p of presetsIn(cfg).slice(0, 4)) {
            const kind = KIND_OF[p.platform];
            if (!kind) { skipped.push(`${project}: "${p.name}" (${p.platform}: not checked by this gate)`); continue; }
            const output = `${base}/${kind}/${path.posix.basename(PRESETS[kind].output)}`;
            const e = await exportGodot({ preset: p.name, output }, host, bin, project, signal, 'export');
            if (e.ok) ok.push(`${project}: "${p.name}" (${(e.bytes / 1048576).toFixed(1)} MB in ${e.took})`);
            else if (e.templates === false) skipped.push(`${project}: "${p.name}": no export templates for it here`);
            else bad.push(`${project}: "${p.name}":\n  ${e.text.split('\n').slice(0, 12).join('\n  ')}`);
          }
          await removeIn(host, base, signal).catch(() => {});
        }
        if (bad.length) return { pass: false, summary: `${bad.length} preset(s) do not build`, details: `${bad.join('\n')}${skipped.length ? `\nNot checked: ${skipped.join('; ')}` : ''}\nBuild with the godot tool (build) to see the whole log.` };
        if (!ok.length) return { pass: false, severity: 'advisory', summary: `not checked: ${skipped.join('; ') || 'no presets'}`, details: templatesMissing(host) };
        return { pass: true, summary: `${ok.length} preset(s) build: ${ok.join(', ')}${skipped.length ? `; not checked: ${skipped.join('; ')}` : ''}` };
      },
    });
  },
  close: () => stopAllSteps(),
};

export { NETWORK_HOSTS };
