// Blender for Studio (engine-blender): the `blender` tool and the blender-file gate. Blender
// runs where the session's commands run (a sandbox, a server folder, a companion), found by
// lib-engines' locate (HARNESS_BLENDER, the PATH, the install folders such as
// C:\Program Files\Blender Foundation\Blender 4.2).
//
// The actions (sdk/engine.mjs): script (bpy, the default: script or code), detect, describe,
// asset.import / asset.export, capture, render (look-dev presets, turntables), sprites (a
// 3D model to a 2D sprite sheet for 2.5D games), bridge.install / status / connect / call
// (the Harness Bridge add-on in the person's Blender), jobs / job.cancel. Render and
// sprites go through the shared job queue (sdk/jobs.mjs).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool } from '../../src/plugins/api.ts';
import { resolveHome } from '../../src/util/home.ts';
import {
  blendCheckArgs, blenderArgs, findFiles, findRemote, locate, missingIn, mkdirIn, newId, readIn, readTextIn, relIn, removeIn, runIn, runtimePath, tail, writeIn,
} from '../games3d/lib-engines.mjs';
import { toToolResult } from '../games3d/sdk/engine.mjs';
import { cancelJob, listJobs, runJob } from '../games3d/sdk/jobs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ACTIONS = ['script', 'detect', 'describe', 'asset.import', 'asset.export', 'capture', 'render', 'sprites', 'bridge.install', 'bridge.status', 'bridge.connect', 'bridge.call', 'jobs', 'job.cancel'];
export const BRIDGE_COMMANDS = ['ping', 'scene', 'exec', 'operator', 'capture', 'save', 'quit'];
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const seconds = (v, def) => Math.min(Math.max(Number(v) || def, 10), 3600) * 1000;
const isBlend = (n) => /\.blend$/i.test(n);
const R = (action, status, summary, more = {}) => ({ engine: 'blender', action, status, summary, ...more });
const HELPER = '.harness/blender/harness_blender.py';

/** Images the agent asked to see after a run (a preview render), as tool images. */
async function showImages(host, list, signal) {
  const images = [];
  const notes = [];
  for (const p of (Array.isArray(list) ? list : []).slice(0, 4)) {
    const rel = await relIn(host, String(p));
    const type = IMAGE_TYPES[path.extname(rel).toLowerCase()];
    if (!type) { notes.push(`${rel}: not an image (png, jpg, webp)`); continue; }
    try {
      const data = await readIn(host, rel, signal);
      if (data.length > 5_000_000) notes.push(`${rel}: over 5 MB, not shown`);
      else images.push({ media_type: type, data: data.toString('base64') });
    } catch { notes.push(`${rel}: not found after the run`); }
  }
  return { images, notes };
}

async function blendFiles(host, signal) {
  return host.kind === 'companion' ? (await findRemote(host, '**/*.blend', isBlend, signal)).slice(0, 8) : findFiles(host.root, isBlend, { max: 8 });
}

/** A gate cannot check without the program: it says so and does not fail the run. */
const notChecked = (host) => ({ pass: false, severity: 'advisory', summary: 'not checked: Blender is not installed in this runtime', details: missingIn(host, 'blender') });

// ---------- script: as it always was ----------

async function runScript(input, host, signal) {
  if (!input.script === !input.code) return { content: 'Give either script (a .py file in the workspace) or code (Python), not both.', is_error: true };
  if (input.live) {
    if (!input.code) return { content: 'live scripts are code (Python run in the open Blender; set `result` to send a value back).', is_error: true };
    const r = await bridgeCall(await liveInfo(host), 'exec', { code: String(input.code) }, { timeoutMs: seconds(input.timeoutSec, 120) });
    return toToolResult(R('script', 'ok', `ran in the open Blender${r.result !== null && r.result !== undefined ? `: result ${JSON.stringify(r.result).slice(0, 300)}` : ''}`, { log: tail(r.stdout ?? '', 40), data: { result: r.result } }));
  }
  const file = input.file ? await relIn(host, String(input.file)) : undefined;
  let script = input.script ? await relIn(host, String(input.script)) : undefined;
  const bin = await locate(host, 'blender', signal);
  if (!bin) return { content: missingIn(host, 'blender'), is_error: true };
  let temp;
  if (input.code) {
    temp = `.harness/blender/run-${newId()}.py`;
    await writeIn(host, temp, String(input.code), signal);
    script = temp;
  }
  const timeoutMs = seconds(input.timeoutSec, 300);
  try {
    const r = await runIn(host, bin, blenderArgs({ script, file, args: Array.isArray(input.args) ? input.args : [] }), { timeoutMs, signal });
    const shown = await showImages(host, input.show, signal);
    const head = r.timedOut ? `blender: timed out after ${timeoutMs / 1000}s` : `blender exited ${r.code} in ${r.took}${r.code === 0 ? '' : ' (a Python error or a file Blender could not read)'}`;
    return { content: [head, ...shown.notes, `Output (end):\n${tail(r.output)}`].join('\n'), is_error: r.timedOut || r.code !== 0, images: shown.images };
  } finally { if (temp && host.kind !== 'companion') await fsp.rm(path.join(host.root, temp), { force: true }); }
}

// ---------- the helper (py/harness_blender.py) ----------

/**
 * Runs one helper command: the module and a config go into .harness/blender, Blender runs
 * them (on `file` when given, else an empty scene), and the JSON report comes back.
 */
async function helper(host, bin, cfg, { file, timeoutMs, signal }) {
  const id = newId();
  const cfgRel = `.harness/blender/cfg-${id}.json`;
  const reportRel = `.harness/blender/report-${id}.json`;
  await writeIn(host, HELPER, await fsp.readFile(path.join(here, 'py', 'harness_blender.py')), signal);
  await writeIn(host, cfgRel, JSON.stringify({ ...cfg, empty: !file && cfg.empty !== false, report: runtimePath(host, reportRel) }), signal);
  try {
    const r = await runIn(host, bin, blenderArgs({ script: HELPER, file, args: [runtimePath(host, cfgRel)] }), { timeoutMs, signal });
    const text = await readTextIn(host, reportRel, signal);
    let report = null;
    try { report = text ? JSON.parse(text) : null; } catch { /* broken */ }
    const errors = r.output.split('\n').filter((l) => /^(Traceback|\w*Error:|SystemExit|Error: )/.test(l.trim())).map((l) => l.trim());
    return { r, report, errors };
  } finally {
    await removeIn(host, cfgRel, signal).catch(() => {});
    await removeIn(host, reportRel, signal).catch(() => {});
  }
}

const failed = (action, h, what) => R(action, h.r.timedOut ? 'timed-out' : 'failed', `${what} did not finish (exit ${h.r.code}${h.r.timedOut ? ', timed out' : ''})${h.errors.length ? `: ${h.errors.at(-1)}` : ''}`, { log: tail(h.r.output, 30), problems: h.errors.slice(-5).map((m) => ({ severity: 'error', message: m })) });

const abs = (host, rel) => runtimePath(host, rel);

function sizeOf(v, def) {
  if (v === undefined) return def;
  const m = Array.isArray(v) ? v.map(Number) : /^(\d+)x(\d+)$/.exec(String(v))?.slice(1).map(Number);
  if (!m || m.length !== 2 || m.some((n) => !(n >= 16 && n <= 8192))) throw new Error('size is [width, height] (or "960x720"), 16 to 8192');
  return m;
}

// ---------- detect ----------

async function detect(host, signal) {
  const bin = await locate(host, 'blender', signal);
  if (!bin) return R('detect', 'unavailable', missingIn(host, 'blender'), { data: { engine: 'blender', installed: false, gaps: ['Blender is not installed'], actions: [] } });
  const r = await runIn(host, bin, ['-b', '--factory-startup', '--version'], { timeoutMs: 60_000, signal });
  const m = /Blender (\d+\.\d+(?:\.\d+)?)/.exec(r.output);
  const version = m?.[1];
  const gaps = [];
  if (!version) gaps.push(`could not read Blender's version (exit ${r.code})`);
  else if (Number(version.split('.')[0]) < 3) gaps.push(`Blender ${version} is older than 3.6: the helper scripts need 3.6 or later`);
  if (host.kind === 'docker' || (host.platform === 'linux' && host.kind !== 'local')) gaps.push('no GPU here: render with Cycles on the CPU or Workbench (EEVEE needs one)');
  if (host.kind !== 'local') gaps.push('the live bridge reaches a Blender on the server\'s own machine only');
  return R('detect', 'ok', `Blender ${version ?? '?'} (${host.kind === 'docker' ? 'sandbox' : 'host'}) at ${bin}${gaps.length ? `; ${gaps.length} gap(s)` : ''}`, {
    data: { engine: 'blender', installed: true, version, path: bin, source: host.kind === 'docker' ? 'sandbox' : 'host', gaps, actions: ACTIONS, engines: ['cycles', 'eevee', 'workbench'], presets: ['studio', 'outdoor', 'night', 'none'] },
  });
}

// ---------- the bridge (addon/harness_bridge) ----------

/** Where Blender keeps the person's add-ons for this version (HARNESS_BLENDER_ADDONS overrides). */
export function addonsDir(version, { env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (env.HARNESS_BLENDER_ADDONS) return env.HARNESS_BLENDER_ADDONS;
  const v = /^(\d+\.\d+)/.exec(String(version ?? ''))?.[1];
  if (!v) return null;
  if (platform === 'win32') return path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Blender Foundation', 'Blender', v, 'scripts', 'addons');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Blender', v, 'scripts', 'addons');
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'blender', v, 'scripts', 'addons');
}

/** The connection file the add-on writes (port, token). */
export const bridgeInfoFile = () => path.join(resolveHome(), 'bridges', 'blender.json');

/** Copies the add-on (and the helper it uses) into a Blender add-ons folder. */
export async function installAddon(dir, info = bridgeInfoFile()) {
  const dest = path.join(dir, 'harness_bridge');
  await fsp.mkdir(dest, { recursive: true });
  await fsp.copyFile(path.join(here, 'addon', 'harness_bridge', '__init__.py'), path.join(dest, '__init__.py'));
  await fsp.copyFile(path.join(here, 'py', 'harness_blender.py'), path.join(dest, 'harness_blender.py'));
  await fsp.writeFile(path.join(dest, 'config.json'), `${JSON.stringify({ info }, null, 1)}\n`);
  return dest;
}

async function liveInfo(host) {
  if (host.kind !== 'local') throw new Error('the Blender bridge reaches a Blender on the server\'s own machine (127.0.0.1): this session runs elsewhere');
  const info = readInfo();
  if (!info) throw new Error(`no Blender with the Harness Bridge add-on is running (no ${bridgeInfoFile()}): bridge.install, then enable "Harness Bridge" in Blender's Preferences > Add-ons`);
  return info;
}

function readInfo() {
  try {
    const j = JSON.parse(fs.readFileSync(bridgeInfoFile(), 'utf8'));
    return Number.isInteger(j.port) && typeof j.token === 'string' ? j : null;
  } catch { return null; }
}

/** One command to the add-on over its local socket: resolves with the result, rejects with its error. */
export function bridgeCall(info, cmd, params = {}, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port: info.port });
    let buf = '';
    const done = (fn, v) => { clearTimeout(timer); sock.destroy(); fn(v); };
    const timer = setTimeout(() => done(reject, new Error(`Blender did not answer ${cmd} in ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    sock.on('connect', () => sock.write(`${JSON.stringify({ id: 1, token: info.token, cmd, params })}\n`));
    sock.on('error', (e) => done(reject, new Error(`could not reach Blender's bridge on 127.0.0.1:${info.port} (${e.code ?? e.message}): is Blender open with the Harness Bridge add-on on?`)));
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      const i = buf.indexOf('\n');
      if (i < 0) return;
      let msg;
      try { msg = JSON.parse(buf.slice(0, i)); } catch { return done(reject, new Error('a broken reply from Blender')); }
      if (msg.ok) done(resolve, msg.result);
      else done(reject, new Error(`Blender refused ${cmd}: ${msg.error}`));
    });
  });
}

// ---------- the tool ----------

async function runBlender(input, host, signal) {
  const action = String(input.action ?? 'script');
  if (!ACTIONS.includes(action)) return { content: `Unknown action ${action}: use ${ACTIONS.join(', ')}.`, is_error: true };
  if (action === 'script') return runScript(input, host, signal);
  const out = (r, images) => toToolResult(r, images);
  if (action === 'detect') return out(await detect(host, signal));
  if (action === 'jobs') return out(R('jobs', 'ok', `${listJobs().filter((j) => j.engine === 'blender').length} Blender job(s) in the last hour`, { data: listJobs() }));
  if (action === 'job.cancel') return out(R('job.cancel', cancelJob(String(input.job)) ? 'ok' : 'failed', `job ${input.job}`));

  if (action.startsWith('bridge.')) {
    if (host.kind !== 'local') return out(R(action, 'unavailable', 'the Blender bridge reaches a Blender on the server\'s own machine: this session runs commands elsewhere'));
    if (action === 'bridge.install') {
      const bin = await locate(host, 'blender', signal);
      const d = bin ? await detect(host, signal) : null;
      const dir = addonsDir(d?.data?.version);
      if (!dir) return out(R(action, 'unavailable', `${bin ? 'could not read Blender\'s version' : missingIn(host, 'blender')}: set HARNESS_BLENDER_ADDONS to the add-ons folder`));
      const dest = await installAddon(dir);
      return out(R(action, 'ok', `the Harness Bridge add-on is in ${dest}. In Blender: Edit > Preferences > Add-ons, search "Harness Bridge" and tick it (it listens on 127.0.0.1 only, with a token in ${bridgeInfoFile()}); then bridge.status.`, { data: { dir: dest, info: bridgeInfoFile() } }));
    }
    const info = readInfo();
    if (!info) return out(R(action, action === 'bridge.status' ? 'ok' : 'unavailable', `no Blender with the Harness Bridge is running (no ${bridgeInfoFile()}): bridge.install, then enable the add-on in Blender`, { data: { connected: false } }));
    if (action === 'bridge.call') {
      const cmd = String(input.command ?? '');
      if (!BRIDGE_COMMANDS.includes(cmd)) return out(R(action, 'failed', `command must be one of ${BRIDGE_COMMANDS.join(', ')}`));
      const result = await bridgeCall(info, cmd, input.params && typeof input.params === 'object' ? input.params : {}, { timeoutMs: seconds(input.timeoutSec, 120) });
      const images = result?.png ? [{ media_type: 'image/png', data: result.png }] : [];
      return out(R(action, 'ok', `${cmd} in the open Blender`, { data: result?.png ? { ...result, png: `(${result.png.length} base64 chars, shown)` } : result }), images);
    }
    try {
      const ping = await bridgeCall(info, 'ping', {}, { timeoutMs: 10_000 });
      return out(R(action, 'ok', `connected to Blender ${ping.blender} (pid ${info.pid}) on 127.0.0.1:${info.port}: ${ping.file || 'an unsaved file'}, scene ${ping.scene}, ${ping.objects} object(s)${ping.background ? ' (background)' : ''}`, { data: { connected: true, ...ping, port: info.port } }));
    } catch (e) {
      return out(R(action, action === 'bridge.status' ? 'ok' : 'failed', `the bridge file is there but Blender does not answer (${e.message})`, { data: { connected: false, port: info.port } }));
    }
  }

  if (input.live && (action === 'describe' || action === 'capture')) {
    const info = await liveInfo(host);
    if (action === 'describe') return out(R('describe', 'ok', 'the scene open in Blender', { data: await bridgeCall(info, 'scene') }));
    const r = await bridgeCall(info, 'capture', { view: input.view, size: input.size });
    const o = await relIn(host, String(input.out ?? '.harness/blender/viewport.png'));
    await writeIn(host, o, Buffer.from(r.png, 'base64'), signal);
    return out(R('capture', 'ok', `Blender's ${r.source === 'viewport' ? 'viewport' : 'scene (a quick render)'} saved to ${o}`, { files: [o] }), [{ media_type: 'image/png', data: r.png }]);
  }

  const file = input.file ? await relIn(host, String(input.file)) : undefined;
  const bin = await locate(host, 'blender', signal);
  if (!bin) return out(R(action, 'unavailable', missingIn(host, 'blender')));
  const timeoutMs = seconds(input.timeoutSec, action === 'render' || action === 'sprites' ? 900 : 300);
  const heavy = (title, work) => runJob('blender', title, (sig) => work(sig), { signal, timeoutMs: timeoutMs + 60_000 });

  if (action === 'describe') {
    const h = await helper(host, bin, { cmd: 'describe' }, { file, timeoutMs, signal });
    if (!h.report) return out(failed(action, h, 'describe'));
    const d = h.report;
    return out(R(action, 'ok', `${file ?? 'an empty scene'}: ${d.count} object(s), ${d.triangles} triangles, ${d.materials.length} material(s)${d.bounds ? `, ${d.bounds.size.join(' x ')} m` : ''}; Blender ${d.blender}`, { data: d, metrics: { objects: d.count, triangles: d.triangles } }));
  }

  if (action === 'asset.import') {
    const list = (Array.isArray(input.files) ? input.files : input.source ? [input.source] : []).map(String);
    if (!list.length) return out(R(action, 'failed', 'give files (models to import: glb, gltf, fbx, obj, stl, ply, usd, abc, blend) and output (a .blend to save) and/or exports'));
    const rels = [];
    for (const p of list) rels.push(await relIn(host, p));
    const blend = input.output ? await relIn(host, String(input.output)) : undefined;
    if (blend && !isBlend(blend)) return out(R(action, 'failed', 'output is the .blend to save (exports: other formats)'));
    const exports = [];
    for (const p of Array.isArray(input.exports) ? input.exports : []) exports.push(await relIn(host, String(p)));
    const h = await helper(host, bin, { cmd: 'import', files: rels.map((r) => abs(host, r)), normalise: input.normalise === true, height: input.height ? Number(input.height) : undefined, blend: blend ? abs(host, blend) : undefined, exports: exports.map((r) => abs(host, r)), target: input.target }, { file, timeoutMs, signal });
    if (!h.report) return out(failed(action, h, 'the import'));
    const s = h.report.scene;
    return out(R(action, 'ok', `imported ${h.report.imported.length} object(s) from ${rels.join(', ')}${input.normalise ? ' (normalised: scale applied, on the floor, centred)' : ''}: ${s.triangles} triangles${s.bounds ? `, ${s.bounds.size.join(' x ')} m` : ''}${blend ? `; saved ${blend}` : ''}${exports.length ? `; exported ${exports.join(', ')}` : ''}`, { files: [...(blend ? [blend] : []), ...exports], data: { imported: h.report.imported, scene: s } }));
  }

  if (action === 'asset.export') {
    if (!input.output) return out(R(action, 'failed', 'give output: the file to write (.glb, .gltf, .fbx, .obj, .stl, .usd)'));
    const o = await relIn(host, String(input.output));
    const h = await helper(host, bin, { cmd: 'export', output: abs(host, o), objects: Array.isArray(input.objects) ? input.objects.map(String) : undefined, target: input.target, applyModifiers: input.applyModifiers !== false, empty: false }, { file, timeoutMs, signal });
    if (!h.report) return out(failed(action, h, 'the export'));
    return out(R(action, 'ok', `${file ?? 'the scene'} -> ${o} (${(h.report.bytes / 1024).toFixed(0)} KB${input.target ? `, for ${input.target}` : ''}): ${h.report.scene.triangles} triangles`, { files: [o], metrics: { bytes: h.report.bytes, triangles: h.report.scene.triangles } }));
  }

  if (action === 'capture') {
    const o = await relIn(host, String(input.out ?? '.harness/blender/capture.png'));
    if (!o.toLowerCase().endsWith('.png')) return out(R(action, 'failed', 'out must be a .png file'));
    const h = await helper(host, bin, { cmd: 'capture', output: abs(host, o), view: input.view, size: sizeOf(input.size, [640, 480]), engine: input.engine ?? 'workbench', ortho: input.ortho === true, empty: false }, { file, timeoutMs, signal });
    if (!h.report) return out(failed(action, h, 'the capture'));
    const png = await readIn(host, o, signal);
    return out(R(action, 'ok', `${input.view ?? 'three-quarter'} view of ${file ?? 'the scene'} (${h.report.engine}) saved to ${o}`, { files: [o] }), [{ media_type: 'image/png', data: png.toString('base64') }]);
  }

  if (action === 'render') {
    const turntable = Math.min(Math.max(Math.round(Number(input.turntable) || 0), 0), 720);
    const o = await relIn(host, String(input.out ?? (turntable ? `renders/turntable-${newId()}` : `renders/render-${newId()}.png`)));
    const engine = String(input.engine ?? 'cycles').toLowerCase();
    if (!['cycles', 'eevee', 'workbench'].includes(engine)) return out(R(action, 'failed', 'engine is cycles, eevee or workbench'));
    const preset = String(input.preset ?? 'studio');
    if (!['studio', 'outdoor', 'night', 'none'].includes(preset)) return out(R(action, 'failed', 'preset is studio, outdoor, night or none (the scene\'s own lights)'));
    const t0 = Date.now();
    const h = await heavy(`render ${turntable ? `turntable ${turntable}` : 'still'} (${engine})`, (sig) => helper(host, bin, { cmd: 'render', output: abs(host, o), preset, engine, samples: input.samples, size: sizeOf(input.size, [960, 720]), view: input.view, turntable, transparent: input.transparent === true, empty: false }, { file, timeoutMs, signal: sig }));
    if (!h.report) return out(failed(action, h, 'the render'));
    const files = h.report.files.map((f) => relFromRuntime(host, f));
    const show = files.length <= 3 ? files : [files[0], files[Math.floor(files.length / 3)], files[Math.floor((2 * files.length) / 3)]];
    const images = [];
    for (const f of show.slice(0, Math.min(Number(input.show ?? 3), 6))) images.push({ media_type: 'image/png', data: (await readIn(host, f, signal)).toString('base64') });
    const took = (Date.now() - t0) / 1000;
    return out(R(action, 'ok', `${turntable ? `a ${turntable}-frame turntable` : 'a still'} of ${file ?? 'the scene'} (${preset}, ${h.report.engine}, ${h.report.size.join('x')}) in ${took.toFixed(1)}s: ${turntable ? o : files[0]}`, { files: turntable ? [files[0], files.at(-1)] : files, metrics: { frames: files.length, seconds: Number(took.toFixed(1)), secondsPerFrame: Number((took / files.length).toFixed(2)) }, data: { files } }), images);
  }

  if (action === 'sprites') {
    const id = String(input.id ?? (file ? path.posix.basename(file, '.blend') : 'sprite')).replace(/[^\w.-]/g, '_');
    const dirs = Math.round(Number(input.directions ?? 8));
    if (![1, 2, 4, 8, 16].includes(dirs)) return out(R(action, 'failed', 'directions is 1, 2, 4, 8 or 16'));
    const frames = Math.min(Math.max(Math.round(Number(input.frames ?? 1)), 1), 64);
    const size = Math.min(Math.max(Math.round(Number(input.cell ?? input.size ?? 64)), 8), 1024);
    const o = await relIn(host, String(input.out ?? `.studio/assets/${id}`));
    await mkdirIn(host, o, signal);
    const t0 = Date.now();
    const h = await heavy(`sprites ${dirs}x${frames} ${id}`, (sig) => helper(host, bin, { cmd: 'sprites', output: abs(host, o), id, directions: dirs, frames, size, elevation: input.elevation ?? 30, engine: input.engine ?? 'eevee', preset: input.preset ?? 'studio', animation: input.animation, pixelArt: input.pixelArt === true, margin: input.margin, empty: false }, { file, timeoutMs, signal: sig }));
    if (!h.report) return out(failed(action, h, 'the sprite sheet'));
    const s = h.report;
    const now = new Date().toISOString();
    const asset = {
      id, name: String(input.name ?? id), kind: 'spritesheet', dimension: '2d',
      files: [{ path: `${id}.png`, role: 'main' }],
      source: { type: 'procedural', generator: 'blender:sprites', params: { from: file ?? null, directions: dirs, frames, cell: size, elevation: Number(input.elevation ?? 30), engine: s.engine, sampled: s.sampled } },
      license: input.license ?? { id: 'CC0-1.0', author: 'generated' },
      tags: ['sprite', `${dirs}-directions`], style: input.pixelArt ? 'pixel-art' : 'rendered',
      meta: { frames: s.frames, frameSize: s.frameSize, columns: s.columns, rows: s.rows, fps: Number(input.fps ?? 10), directions: dirs, directionNames: s.directionNames, animations: s.animations, cellMetres: s.cellMetres, elevation: Number(input.elevation ?? 30), triangles: s.triangles },
      engines: {}, created: now, updated: now,
    };
    await writeIn(host, `${o}/asset.json`, `${JSON.stringify(asset, null, 1)}\n`, signal);
    const png = await readIn(host, `${o}/${id}.png`, signal);
    return out(R(action, 'ok', `a ${s.columns * size}x${s.rows * size} sprite sheet: ${dirs} direction(s) x ${frames} frame(s) of ${size}x${size} (${s.engine}) in ${((Date.now() - t0) / 1000).toFixed(1)}s, in ${o} with asset.json (Studio's layout: kind spritesheet; godot asset.import takes it)`, { files: [`${o}/${id}.png`, `${o}/asset.json`], metrics: { cells: s.frames, cell: size }, data: { id, meta: asset.meta } }), [{ media_type: 'image/png', data: png.toString('base64') }]);
  }
  throw new Error(`unreachable: ${action}`);
}

/** A path the helper wrote (absolute, as the runtime sees it) as a workspace path. */
function relFromRuntime(host, p) {
  const base = host.displayRoot.replace(/\\/g, '/').replace(/\/$/, '');
  const s = String(p).replace(/\\/g, '/');
  return s.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? s.slice(base.length + 1) : s;
}

const DESCRIPTION = [
  'Blender where the session\'s commands run. Load blender-scripting first (blender-sprites for sprite sheets).',
  'Without an action (or "script"): run a bpy script headless - {"script": "tools/model.py", "args": [...], "show": ["previews/front.png"]} or {"code": "..."}, optionally on a .blend ("file"): blender -b [file.blend] --factory-startup --python script -- args. Relative paths in the script are relative to the workspace root; a Python error fails the run; show returns the images it wrote.',
  'Actions: "detect" (version, path, gaps); "describe" (a .blend\'s objects, meshes, materials, cameras, lights, animation, bounds as data); "asset.import" (files: glb, gltf, fbx, obj, stl, ply, usd, abc into a scene; normalise: scale applied, on the floor, centred; height in metres; output: a .blend; exports: other formats); "asset.export" (file, output .glb/.gltf/.fbx/.obj/.stl/.usd, objects, target godot | unreal | unity | web for the axes);',
  '"capture" (one quick framed view: view front | side | back | top | three-quarter | camera, Workbench by default); "render" (preset studio | outdoor | night | none, engine cycles | eevee | workbench, samples, size, turntable: N frames around the model, transparent; a heavy job);',
  '"sprites" (a model to a 2D sprite sheet for 2.5D games: directions 1-16 x frames of its animation, orthographic and transparent, cell size, elevation; writes <id>.png and asset.json in Studio\'s layout, by default in .studio/assets/<id>);',
  '"bridge.install" (the Harness Bridge add-on into the person\'s Blender add-ons folder, only when asked), "bridge.status" / "bridge.connect" / "bridge.call" (ping, scene, exec, operator, capture, save; live: true on script, describe, capture); "jobs" / "job.cancel".',
].join(' ');

export default {
  name: 'engine-blender',
  setup(api) {
    api.registerTool(defineTool({
      name: 'blender',
      description: DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ACTIONS, description: 'Default "script"' },
          script: { type: 'string', description: 'script: a .py file in the workspace' },
          code: { type: 'string', description: 'script: Python to run instead of a file (kept in .harness/blender while it runs); live: run in the open Blender' },
          file: { type: 'string', description: 'A .blend file to open first' },
          args: { type: 'array', items: { type: 'string' }, description: 'script: arguments, sys.argv after "--"' },
          show: { type: ['array', 'number'], items: { type: 'string' }, description: 'script: images the script writes to look at after the run, up to 4; render: how many frames to look at' },
          files: { type: 'array', items: { type: 'string' }, description: 'asset.import: the models to import' },
          output: { type: 'string', description: 'asset.import: the .blend to save; asset.export: the file to write' },
          exports: { type: 'array', items: { type: 'string' }, description: 'asset.import: also export to these files' },
          normalise: { type: 'boolean', description: 'asset.import: apply scale, rest on the floor, centre' },
          height: { type: 'number', description: 'asset.import with normalise: scale to this height in metres' },
          objects: { type: 'array', items: { type: 'string' }, description: 'asset.export: only these objects' },
          target: { type: 'string', enum: ['godot', 'unreal', 'unity', 'web'], description: 'asset.import/export: axes and scale for that engine' },
          applyModifiers: { type: 'boolean', description: 'asset.export: default true' },
          view: { type: 'string', enum: ['front', 'back', 'side', 'left', 'top', 'three-quarter', 'camera'], description: 'capture, render: where the camera looks from (camera: the scene\'s own)' },
          ortho: { type: 'boolean', description: 'capture: an orthographic camera' },
          engine: { type: 'string', enum: ['cycles', 'eevee', 'workbench'], description: 'capture (workbench), render (cycles), sprites (eevee)' },
          preset: { type: 'string', enum: ['studio', 'outdoor', 'night', 'none'], description: 'render, sprites: the light set (none: the scene\'s own)' },
          samples: { type: 'number', description: 'render: Cycles or EEVEE samples (default 32)' },
          size: { description: 'capture, render: [width, height]; sprites: the cell size in pixels' },
          turntable: { type: 'number', description: 'render: frames of a full turn around the model' },
          transparent: { type: 'boolean', description: 'render: a transparent background' },
          out: { type: 'string', description: 'capture: the .png; render: a .png or a folder (turntable); sprites: the asset folder' },
          id: { type: 'string', description: 'sprites: the asset id (default the .blend\'s name)' },
          name: { type: 'string', description: 'sprites: the asset\'s name' },
          directions: { type: 'number', description: 'sprites: 1, 2, 4, 8 (default) or 16, counter-clockwise from the front' },
          frames: { type: 'number', description: 'sprites: animation frames per direction (default 1), sampled over the action' },
          cell: { type: 'number', description: 'sprites: cell size in pixels (default 64)' },
          elevation: { type: 'number', description: 'sprites: camera angle above the ground in degrees (default 30; 90 top-down, 0 side)' },
          animation: { type: 'string', description: 'sprites: the animation\'s name in asset.json (default walk, or idle for one frame)' },
          fps: { type: 'number', description: 'sprites: playback speed in asset.json (default 10)' },
          pixelArt: { type: 'boolean', description: 'sprites: crisp pixels (no filtering)' },
          live: { type: 'boolean', description: 'script (code), describe, capture: in the person\'s open Blender (the bridge)' },
          command: { type: 'string', enum: BRIDGE_COMMANDS, description: 'bridge.call' },
          params: { type: 'object', description: 'bridge.call: {code} for exec, {op, kwargs} for operator, {path} for save, {view, size} for capture' },
          job: { type: 'string', description: 'job.cancel: the job id' },
          timeoutSec: { type: 'number', description: 'Default 300 (render and sprites 900), at most 3600' },
        },
      },
      kind: 'exec',
      // bridge.install writes into the person's Blender folder, outside the workspace: always asked about.
      kindsFor: (i) => (i.action === 'bridge.install' ? ['exec', 'external'] : ['exec']),
      summarize: (i) => (i.action && i.action !== 'script'
        ? `${i.action}${i.file ? ` ${i.file}` : ''}${i.output ? ` -> ${i.output}` : ''}${i.command ? ` ${i.command}` : ''}`
        : `${i.script ?? 'inline script'}${i.file ? ` on ${i.file}` : ''}${Array.isArray(i.args) && i.args.length ? ` -- ${i.args.join(' ')}` : ''}`),
      run: async (input, { host, signal }) => {
        try { return await runBlender(input, host, signal); } catch (e) {
          if (e?.name === 'PathError' || /outside the workspace/.test(e?.message ?? '')) throw e;
          return toToolResult(R(String(input.action ?? 'script'), signal.aborted ? 'cancelled' : 'failed', e.message ?? String(e)));
        }
      },
    }));

    api.registerGate({
      name: 'blender-file',
      description: 'Every .blend file in the workspace opens in Blender headless without errors.',
      applies: async (host, signal) => { try { return (await blendFiles(host, signal)).length > 0; } catch { return false; } },
      async run({ host, signal }) {
        const files = await blendFiles(host, signal);
        if (!files.length) return { pass: true, summary: 'no .blend files in the workspace' };
        const bin = await locate(host, 'blender', signal);
        if (!bin) return notChecked(host);
        const bad = [];
        const ok = [];
        for (const f of files) {
          const r = await runIn(host, bin, blendCheckArgs(f), { timeoutMs: 180_000, signal });
          const m = /HARNESS_BLEND OK (\d+)/.exec(r.output);
          if (r.code === 0 && m) ok.push(`${f} (${m[1]} objects)`);
          else bad.push(`${f}: ${r.timedOut ? 'timed out' : `exit ${r.code}`}\n  ${tail(r.output, 8, 800).replace(/\n/g, '\n  ')}`);
        }
        return bad.length
          ? { pass: false, summary: `${bad.length} of ${files.length} .blend file(s) do not open`, details: bad.join('\n') }
          : { pass: true, summary: `${files.length} .blend file(s) open: ${ok.join(', ')}` };
      },
    });
  },
};
