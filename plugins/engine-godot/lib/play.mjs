// play, step, describe, test and capture: Godot started on the harness's boot scene
// (gd/boot.gd), which adds the controller (gd/play.gd) or the test runner beside the
// project's autoloads and then runs the game. Configs, reports and frames go through
// workspace files, so this works wherever the session's commands run.

import fs from 'node:fs/promises';
import path from 'node:path';
import { godotArgs, godotProblems, listIn, mkdirIn, newId, readIn, readTextIn, removeIn, runIn, runtimePath, stripAnsi, tail, withDisplay, writeIn } from '@harness/plugins/games3d/lib-engines.mjs';
import { PLUGIN_DIR } from './templates.mjs';

export const HARNESS_DIR = '.godot/harness';
const BOOT_TSCN = '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://.godot/harness/boot.gd" id="1"]\n\n[node name="HarnessBoot" type="Node"]\nscript = ExtResource("1")\n';
const GD_FILES = ['boot.gd', 'play.gd', 'test_runner.gd', 'error_log.gd'];

export const inProject = (project, rel) => (project === '.' ? rel : `${project}/${rel}`);

/** Writes the harness's scripts into <project>/.godot/harness/ (Godot's own cache folder, never committed). */
export async function writeHarnessFiles(host, project, signal) {
  await writeIn(host, inProject(project, `${HARNESS_DIR}/boot.tscn`), BOOT_TSCN, signal);
  for (const f of GD_FILES) await writeIn(host, inProject(project, `${HARNESS_DIR}/${f}`), await fs.readFile(path.join(PLUGIN_DIR, 'gd', f)), signal);
}

/**
 * Inputs as the controller wants them: [{f, action | key | button/x/y, down}], sorted.
 * Accepts {t: seconds | f: frame, action | key | button (1 left, 2 right) with x, y,
 * down | up, hold: seconds (a press and its release)}.
 */
export function timeline(inputs, fps = 60) {
  if (inputs === undefined || inputs === null) return [];
  if (!Array.isArray(inputs)) throw new Error('inputs must be an array of {t, action | key | button, down | up | hold}');
  if (inputs.length > 10_000) throw new Error('at most 10000 inputs');
  const out = [];
  for (const [i, e] of inputs.entries()) {
    if (!e || typeof e !== 'object') throw new Error(`inputs[${i}] is not an object`);
    const f = e.f !== undefined ? Math.round(Number(e.f)) : Math.round(Number(e.t ?? 0) * fps);
    if (!Number.isFinite(f) || f < 0) throw new Error(`inputs[${i}]: t (seconds) or f (frame) must be 0 or more`);
    const what = {};
    if (e.action !== undefined) what.action = String(e.action);
    else if (e.key !== undefined) what.key = String(e.key);
    else if (e.button !== undefined || e.x !== undefined || e.y !== undefined) {
      if (e.button !== undefined) what.button = Number(e.button);
      if (e.x !== undefined) what.x = Number(e.x);
      if (e.y !== undefined) what.y = Number(e.y);
    } else throw new Error(`inputs[${i}] needs action, key, or button / x, y`);
    const down = e.up === true ? false : e.down === undefined ? true : e.down !== false;
    out.push({ f, ...what, down });
    if (e.hold !== undefined && down) {
      const hold = Math.max(1, Math.round(Number(e.hold) * fps));
      out.push({ f: f + hold, ...what, down: false });
    }
  }
  return out.sort((a, b) => a.f - b.f);
}

/** The display a run needs: headless for state only, a window (on Linux: Xvfb) for frames. */
export function displayArgs(host, { windowed, size, uncapped, renderer, position }) {
  if (!windowed) return ['--headless'];
  const args = [];
  // A container or a Linux server without a GPU draws with OpenGL on the CPU (llvmpipe).
  const compat = renderer === 'compatibility' || (renderer !== 'project' && (host.kind === 'docker' || host.platform === 'linux'));
  if (compat) args.push('--rendering-driver', 'opengl3', '--rendering-method', 'gl_compatibility');
  if (size) args.push('--resolution', `${size[0]}x${size[1]}`);
  // A window the person need not see (the AI player's bots): placed off the screen, still drawing.
  if (position) args.push('--position', `${Math.round(position[0])},${Math.round(position[1])}`);
  if (uncapped) args.push('--disable-vsync');
  args.push('--audio-driver', 'Dummy');
  return args;
}

export function sizeOf(v) {
  if (v === undefined) return undefined;
  const m = Array.isArray(v) ? v.map(Number) : /^(\d+)x(\d+)$/.exec(String(v))?.slice(1).map(Number);
  if (!m || m.length !== 2 || m.some((n) => !(n >= 64 && n <= 4096))) throw new Error('size is [width, height] (or "1280x720"), 64 to 4096');
  return m;
}

/** Boot command line: Godot on the boot scene with the config file. */
export function bootArgs(project, display, cfgPath, { fixed = true, args = [] } = {}) {
  return ['--path', project, ...display, ...(fixed ? ['--fixed-fps', '60'] : []), 'res://.godot/harness/boot.tscn', '--', `--harness=${cfgPath}`, ...args.map(String)];
}

/**
 * Runs the boot scene once with a config (play, describe, test) and reads the report.
 * Returns { r (the run), report (parsed or null), problems, cfg }.
 */
export async function bootRun(host, bin, project, cfg, { windowed = false, size, uncapped, renderer, fixed = true, args = [], timeoutMs = 300_000, signal } = {}) {
  const id = newId();
  const cfgRel = inProject(project, `${HARNESS_DIR}/run-${id}.json`);
  const reportRel = inProject(project, `${HARNESS_DIR}/run-${id}-report.json`);
  await writeHarnessFiles(host, project, signal);
  const full = { ...cfg, report: runtimePath(host, reportRel) };
  await writeIn(host, cfgRel, JSON.stringify(full), signal);
  const display = displayArgs(host, { windowed, size, uncapped, renderer });
  const r = await runIn(host, bin, bootArgs(project, display, runtimePath(host, cfgRel), { fixed, args }), { timeoutMs, signal, prefix: windowed ? withDisplay(host) : undefined });
  const text = await readTextIn(host, reportRel, signal);
  let report = null;
  try { report = text ? JSON.parse(text) : null; } catch { /* a broken report */ }
  await removeIn(host, cfgRel, signal).catch(() => {});
  await removeIn(host, reportRel, signal).catch(() => {});
  return { r, report, problems: godotProblems(r.output).filter((p) => !/^ERROR: harness: (no input action|unknown key)/.test(p)), id };
}

/** Imports the project (a fresh one has no .godot cache): the import's problems. */
export async function importProject(host, bin, project, signal) {
  const imp = await runIn(host, bin, godotArgs('import', { project }), { timeoutMs: 300_000, signal });
  if (imp.timedOut) return ['the import timed out after 5 minutes'];
  return godotProblems(imp.output);
}

/** Up to n images out of the files, spread evenly, last one included. */
export async function someFrames(host, files, n, signal) {
  if (!files.length || n <= 0) return [];
  const pick = files.length <= n ? files : Array.from({ length: n }, (_, i) => files[Math.round((i * (files.length - 1)) / (n - 1 || 1))]);
  const out = [];
  for (const f of [...new Set(pick)]) {
    try { out.push({ media_type: 'image/png', data: (await readIn(host, f, signal)).toString('base64') }); } catch { /* gone */ }
  }
  return out;
}

/** A runtime path the controller wrote, back as a workspace path. */
export function workspaceRel(host, p) {
  const base = host.displayRoot.replace(/\\/g, '/').replace(/\/$/, '');
  const s = String(p).replace(/\\/g, '/');
  return s.startsWith(`${base}/`) ? s.slice(base.length + 1) : s;
}

const METRIC_KEYS = ['fps', 'frameMsAvg', 'frameMsP95', 'frameMsMax', 'memoryMb', 'memoryPeakMb', 'drawCalls', 'frames', 'realSeconds', 'gameSeconds', 'nodes'];
export function metricsOf(m = {}, extra = {}) {
  const out = {};
  for (const k of METRIC_KEYS) if (typeof m[k] === 'number') out[k] = m[k];
  return { ...out, ...extra };
}

// ---------- step mode: one long-lived Godot per session ----------

const KEY = Symbol.for('harness.engine-godot.steps');
const steps = globalThis[KEY] ??= new Map();
const IDLE_MS = 15 * 60_000;

/** Every step session (for close and status). */
export const stepSessions = () => steps;

/**
 * Starts Godot in step mode: it runs the first frame, answers with the state (and a frame
 * when windowed), and then waits for each step. Needs a host that keeps a process with
 * pipes (a server folder or a sandbox; not a companion).
 */
export async function startStep(host, bin, project, o, signal) {
  if (!host.spawnStream) throw new Error('step mode needs a long-lived Godot process, which this runtime cannot keep (a companion): use play with an input timeline instead');
  if (steps.size >= 4) throw new Error('four step sessions are open already: stop one (step.stop) first');
  await writeHarnessFiles(host, project, signal);
  const id = `step-${newId()}`;
  const framesRel = o.out ?? `.harness/godot/${id}`;
  await mkdirIn(host, framesRel, signal);
  const cfgRel = inProject(project, `${HARNESS_DIR}/${id}.json`);
  await writeIn(host, cfgRel, JSON.stringify({ mode: 'step', scene: o.scene ? (String(o.scene).startsWith('res://') ? o.scene : `res://${o.scene}`) : '', out: o.windowed ? runtimePath(host, framesRel) : '', inputs: [] }), signal);
  const display = displayArgs(host, o);
  const args = bootArgs(project, display, runtimePath(host, cfgRel), { fixed: true, args: o.args ?? [] });
  const proc = await host.spawnStream(bin, args, {});
  const s = { id, proc, host, project, framesRel, cfgRel, log: [], waiters: [], replies: [], closed: false, started: Date.now(), last: Date.now(), windowed: !!o.windowed, steps: 0 };
  let buf = '';
  const onLine = (line) => {
    const l = stripAnsi(line).replace(/\r$/, '');
    if (l.startsWith('HARNESS_STEP ')) {
      let msg;
      try { msg = JSON.parse(l.slice(13)); } catch { msg = { ok: false, error: `a broken reply: ${l.slice(0, 200)}` }; }
      const w = s.waiters.shift();
      if (w) w.resolve(msg); else s.replies.push(msg);
    } else if (l.trim()) {
      s.log.push(l);
      if (s.log.length > 400) s.log.splice(0, s.log.length - 400);
    }
  };
  proc.stdout.on('data', (d) => { buf += d.toString('utf8'); let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  proc.stderr.on('data', (d) => { for (const l of d.toString('utf8').split('\n')) onLine(l); });
  proc.on('exit', (code) => {
    s.closed = true;
    s.exitCode = code;
    for (const w of s.waiters.splice(0)) w.reject(new Error(`Godot exited (code ${code}) during the step${s.log.length ? `:\n${s.log.slice(-15).join('\n')}` : ''}`));
    steps.delete(id);
    clearTimeout(s.idle);
  });
  proc.stdin.on('error', () => {});
  steps.set(id, s);
  touch(s);
  try {
    const first = await reply(s, o.timeoutMs ?? 120_000);
    return { session: s, reply: first };
  } catch (e) { await stopStep(id); throw e; }
}

function touch(s) {
  s.last = Date.now();
  clearTimeout(s.idle);
  s.idle = setTimeout(() => { stopStep(s.id).catch(() => {}); }, IDLE_MS);
  s.idle.unref?.();
}

function reply(s, timeoutMs) {
  if (s.replies.length) return Promise.resolve(s.replies.shift());
  if (s.closed) return Promise.reject(new Error(`the step session ${s.id} has ended`));
  return new Promise((resolve, reject) => {
    const w = { resolve: (m) => { clearTimeout(t); resolve(m); }, reject: (e) => { clearTimeout(t); reject(e); } };
    const t = setTimeout(() => { s.waiters = s.waiters.filter((x) => x !== w); reject(new Error(`no answer from Godot in ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
    s.waiters.push(w);
  });
}

/** One step: the inputs (frame offsets from now), then N frames; the reply with the frame read back. */
export async function step(id, { inputs, frames = 1, capture = true, timeoutMs = 120_000 }) {
  const s = steps.get(id);
  if (!s) throw new Error(`no step session ${id} (it ended, or timed out after 15 idle minutes): start one with step.start`);
  touch(s);
  const cmd = { cmd: 'step', inputs: timeline(inputs), frames: Math.min(Math.max(Math.round(Number(frames) || 1), 1), 3600), capture };
  s.proc.stdin.write(`${JSON.stringify(cmd)}\n`);
  s.steps++;
  return reply(s, timeoutMs);
}

/** The state without advancing. */
export async function stepState(id) {
  const s = steps.get(id);
  if (!s) throw new Error(`no step session ${id}`);
  touch(s);
  s.proc.stdin.write('{"cmd":"state"}\n');
  return reply(s, 30_000);
}

/** Ends a step session (asks Godot to quit, then kills it). */
export async function stopStep(id) {
  const s = steps.get(id);
  if (!s) return false;
  steps.delete(id);
  clearTimeout(s.idle);
  if (!s.closed) {
    try { s.proc.stdin.write('{"cmd":"quit"}\n'); } catch { /* closed */ }
    await new Promise((r) => { const t = setTimeout(r, 5000); s.proc.once('exit', () => { clearTimeout(t); r(); }); });
    if (!s.closed) s.proc.kill();
  }
  await removeIn(s.host, s.cfgRel).catch(() => {});
  return true;
}

export async function stopAllSteps() {
  await Promise.all([...steps.keys()].map((id) => stopStep(id).catch(() => {})));
}

export { listIn, tail };
