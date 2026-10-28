// The AI player's driver for Godot (plugins/games3d/player/driver.mjs loads it): a Godot 4
// game in step mode (lib/play.mjs: one long-lived Godot, paused between steps), with the
// session interface the bots, playtests and gates use:
//
//   const d = createDriver(host, { project?, headless?, size?, position?, bin?, import? });
//   const s = await d.start(game, { seed, bootMs, frameWidth });
//   s.info                        { engine: 'godot', project, inputs, controls, actions, clock: 'engine' }
//   await s.observe({ frame })    { t (ms), state, events (new ones), errors (new ones), frame?: {png}, crashed }
//   await s.act(inputs)           inputs now (they take effect on the next frame)
//   await s.step(inputs, ms, { frame })
//   s.recording() / await s.metrics() / await s.stop()
//
// Inputs are the player's: {key: 'ArrowRight', ms: 400} holds a key, {key: 'Space'} taps it,
// {action: 'jump'} presses an input-map action, {key, down | up: true}, {mouse: [x, y], click}
// in the last frame's pixels, `at` (ms) delays one inside a step. Keys are web key codes
// (ArrowLeft, KeyA, Space, Enter); an input-map action name works as a key too.
//
// The state is what the game publishes through the StudioHook autoload (set_state), flattened,
// with vectors as {x, y(, z)}: {player: {x, y}, score, won, targets: [{x, y}], ...}. The bot's
// keys (info.inputs) are the game's own list (StudioHook.set_state("inputs", [...])) or one key
// per action of the project's input map.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { godotProblems, locate, missingIn, readIn, readTextIn, relIn, removeIn } from '@harness/plugins/games3d/lib-engines.mjs';
import { importProject, inProject, metricsOf, startStep, step as stepGodot, stepSessions, stepState, stopStep, workspaceRel } from './lib/play.mjs';

const FRAME_MS = 1000 / 60;
const TAP_FRAMES = 3;

// Web key codes -> the names OS.find_keycode_from_string knows.
const SPECIAL = {
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Space: 'Space', Enter: 'Enter', NumpadEnter: 'Enter', Escape: 'Escape',
  Tab: 'Tab', Backspace: 'Backspace', ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Ctrl', ControlRight: 'Ctrl', AltLeft: 'Alt', AltRight: 'Alt',
};
/** A web key code (or a plain key name) as a Godot key name. */
export function godotKey(k) {
  const s = String(k ?? '');
  if (SPECIAL[s]) return SPECIAL[s];
  const m = /^Key([A-Z])$/.exec(s) ?? /^Digit(\d)$/.exec(s);
  if (m) return m[1];
  if (/^[a-z]$/.test(s)) return s.toUpperCase();
  return s;
}

// Physical key codes in project.godot -> web key codes (for info.inputs).
const CODE_TO_WEB = { 32: 'Space', 4194309: 'Enter', 4194305: 'Escape', 4194306: 'Tab', 4194319: 'ArrowLeft', 4194320: 'ArrowUp', 4194321: 'ArrowRight', 4194322: 'ArrowDown', 4194325: 'ShiftLeft' };
const webOf = (code) => CODE_TO_WEB[code] ?? (code >= 65 && code <= 90 ? `Key${String.fromCharCode(code)}` : code >= 48 && code <= 57 ? `Digit${code - 48}` : null);
const PREFER = (k) => (/^Arrow|^Space$|^Enter$/.test(k) ? 0 : 1);

/** The input map of a project.godot: { action: [web key codes] } (keys only; ui_* actions are Godot's own). */
export function inputMapOf(text) {
  const out = {};
  const sec = /^\[input\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(text ?? '')?.[1] ?? '';
  for (const m of sec.matchAll(/^([A-Za-z_][\w]*)\s*=\s*\{([\s\S]*?)^\}/gm)) {
    if (m[1].startsWith('ui_')) continue;
    const keys = [...m[2].matchAll(/"physical_keycode":(\d+)|"keycode":(\d+)/g)].map((x) => Number(x[1] || x[2])).filter((c) => c > 0).map(webOf).filter(Boolean);
    out[m[1]] = [...new Set(keys)].sort((a, b) => PREFER(a) - PREFER(b));
  }
  return out;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const asVec = (v) => (Array.isArray(v) && (v.length === 2 || v.length === 3) && v.every(isNum) ? (v.length === 2 ? { x: v[0], y: v[1] } : { x: v[0], y: v[1], z: v[2] }) : v);
const VECTOR_KEYS = new Set(['player', 'position', 'pos', 'target', 'goal', 'exit', 'velocity']);

/** The state the controller sends ({frame, scene, game: {...}}) as the player reads it: flat, vectors as {x, y, z}. */
export function flattenState(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const game = raw.game && typeof raw.game === 'object' ? raw.game : {};
  const out = { ...game, frame: raw.frame, scenePath: raw.scene };
  if (!('player' in game) && raw.player !== undefined) out.player = raw.player;
  for (const k of Object.keys(out)) {
    if (VECTOR_KEYS.has(k)) out[k] = asVec(out[k]);
    else if (k === 'targets' && Array.isArray(out[k])) out[k] = out[k].map(asVec);
  }
  if (out.player && typeof out.player === 'object' && !Array.isArray(out.player)) for (const k of ['position', 'pos']) if (out.player[k]) out.player[k] = asVec(out.player[k]);
  return out;
}

/**
 * The player's inputs as the controller's timeline: [{f, action | key | button, x, y, down, hold}]
 * (frames from now). A key that is an input-map action goes in as that action.
 */
export function toTimeline(inputs, { actions = {}, scale = 1 } = {}) {
  const out = [];
  let span = 0;
  for (const raw of Array.isArray(inputs) ? inputs : inputs ? [inputs] : []) {
    if (!raw || typeof raw !== 'object') continue;
    const f = Math.max(0, Math.round((Number(raw.at) || 0) / FRAME_MS));
    if (raw.mouse) {
      const [x, y] = raw.mouse.map((v) => Number(v) * scale);
      const button = raw.button === 'right' ? 2 : 1;
      if (raw.click || raw.press) {
        const hold = Math.max(1, Math.round((Number(raw.ms) || 50) / FRAME_MS));
        out.push({ f, button, x, y, down: true, hold: hold / 60 });
        span = Math.max(span, f + hold);
      } else if (raw.down) out.push({ f, button, x, y, down: true });
      else if (raw.up) out.push({ f, button, x, y, up: true });
      else out.push({ f, x, y });
      continue;
    }
    const name = raw.action ?? raw.key;
    if (!name) continue;
    const what = raw.action !== undefined || actions[name] ? { action: String(name) } : { key: godotKey(name) };
    if (raw.down) { out.push({ f, ...what, down: true }); continue; }
    if (raw.up) { out.push({ f, ...what, up: true }); continue; }
    const hold = Math.max(1, raw.ms ? Math.round(Number(raw.ms) / FRAME_MS) : TAP_FRAMES);
    out.push({ f, ...what, down: true, hold: hold / 60 });
    span = Math.max(span, f + hold);
  }
  return { timeline: out.sort((a, b) => a.f - b.f), spanFrames: span };
}

/** Where the Godot project is: opts.project, the game path, .studio/project.json engineProject, the root, game/. */
export async function findProject(host, opts = {}) {
  const tryDir = async (d) => (d !== undefined && d !== null && (await readTextIn(host, inProject(d, 'project.godot')) !== null) ? d : null);
  for (const c of [opts.project, opts.game && !/\.(html?|tscn)$/i.test(String(opts.game)) ? opts.game : null]) {
    if (!c) continue;
    const rel = await relIn(host, String(c).replace(/\/project\.godot$/, ''));
    if (await tryDir(rel)) return rel;
  }
  try {
    const p = JSON.parse(await readTextIn(host, '.studio/project.json') ?? '{}');
    if (typeof p.engineProject === 'string') { const d = path.posix.dirname(p.engineProject.replace(/\\/g, '/')); if (await tryDir(d || '.')) return d || '.'; }
  } catch { /* no project file */ }
  for (const d of ['.', 'game']) if (await tryDir(d)) return d;
  return null;
}

/** Whether a project needs importing: no cache yet, or files newer than the last import the driver did. */
async function needsImport(host, project) {
  if (host.kind !== 'local') return true;
  const root = path.join(host.root, project);
  const marker = path.join(root, '.godot', 'harness', 'imported');
  const since = (await fsp.stat(marker).catch(() => null))?.mtimeMs;
  if (!since) return true;
  const walk = async (dir, depth) => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith('.') || e.name === 'build' || e.name === 'node_modules') continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth > 0 && await walk(f, depth - 1)) return true; } else if ((await fsp.stat(f)).mtimeMs > since) return true;
    }
    return false;
  };
  return walk(root, 6);
}

/** Opens a window the person need not see where there is a desktop; headless (state only) where there is none. */
function windowedByDefault(host) {
  if (process.env.HARNESS_GODOT_DRIVER_HEADLESS === '1') return false;
  if (host.kind === 'docker') return true; // the 3D sandbox has Xvfb
  return host.platform !== 'linux' || !!process.env.DISPLAY;
}

/**
 * The driver. opts: project (the folder with project.godot), headless (no frames: faster),
 * size [w, h] (default 960x540), position (default off the screen), scene, bin (a Godot binary),
 * import (false: do not import first), stepTimeoutMs.
 */
export function createDriver(host, opts = {}) {
  if (host.kind === 'companion') return { unavailable: 'the Godot driver keeps Godot running between steps, which a companion cannot: play it with the godot tool (play, with an input timeline) instead' };
  if (!host.spawnStream) return { unavailable: 'this runtime cannot keep a long-lived Godot process for step mode' };
  return {
    async start(game, startOpts = {}) {
      const o = { ...opts, ...startOpts, game: game ?? startOpts.game ?? opts.game };
      const project = await findProject(host, o);
      if (!project) throw new Error('no Godot project here: no project.godot at the root, in game/, or where .studio/project.json engineProject says (godot project.create makes one)');
      const bin = o.bin ?? await locate(host, 'godot', o.signal);
      if (!bin) throw new Error(missingIn(host, 'godot'));
      if (o.import !== false && await needsImport(host, project)) {
        const problems = await importProject(host, bin, project, o.signal);
        if (problems.length) throw new Error(`the project does not import cleanly: ${problems.slice(0, 5).join('; ')}`);
        if (host.kind === 'local') {
          const dir = path.join(host.root, project, '.godot', 'harness');
          await fsp.mkdir(dir, { recursive: true });
          await fsp.writeFile(path.join(dir, 'imported'), '');
        }
      }
      const actions = inputMapOf(await readTextIn(host, inProject(project, 'project.godot')));
      const windowed = o.headless === true ? false : o.headless === false ? true : windowedByDefault(host);
      const size = o.size ?? [960, 540];
      const position = o.position ?? (windowed && host.kind === 'local' && process.env.HARNESS_GODOT_DRIVER_VISIBLE !== '1' ? [-4000, -4000] : undefined);
      const seed = Number.isFinite(Number(o.seed)) ? Number(o.seed) : 1;
      const { session, reply } = await startStep(host, bin, project, { windowed, size, position, scene: o.scene, args: [`--seed=${seed}`, ...(o.args ?? [])], renderer: o.renderer, timeoutMs: o.startTimeoutMs ?? 180_000 }, o.signal);
      return new GodotSession({ host, project, session, reply, actions, windowed, size, seed, frameWidth: o.frameWidth ?? 512, stepTimeoutMs: o.stepTimeoutMs ?? 120_000, bootMs: o.bootMs ?? 500, game: o.game, deps: o.deps }).boot();
    },
  };
}

class GodotSession {
  constructor(o) {
    Object.assign(this, o);
    this.engine = 'godot';
    this.id = o.session.id;
    this.t = (o.reply.frame ?? 0) * FRAME_MS;
    this.timeline = [];
    this.eventsSeen = 0;
    this.errors = [];
    this.newErrors = [];
    this.lastFile = null;
    this.lastFileT = -1;
    this.closed = false;
    this.absorb(o.reply);
  }

  get info() {
    const st = this.state ?? {};
    const own = Array.isArray(st.inputs) ? st.inputs.filter((k) => typeof k === 'string') : null;
    const fromMap = [...new Set(Object.values(this.actions).map((keys) => keys[0]).filter(Boolean))];
    const controls = Object.fromEntries(Object.entries(this.actions).filter(([, k]) => k.length).map(([a, k]) => [a, k[0]]));
    return { engine: 'godot', game: this.game ?? this.project, project: this.project, seed: this.seed, clock: 'engine', windowed: this.windowed, inputs: own ?? (fromMap.length ? [...fromMap, ...(fromMap.includes('Enter') ? [] : ['Enter'])] : null), controls: st.controls && typeof st.controls === 'object' ? st.controls : controls, actions: Object.keys(this.actions), hasState: this.state !== undefined };
  }

  async boot() {
    // Not in the recording: a replay boots the same way before its steps.
    if (this.bootMs > 0) await this.send([], Math.max(1, Math.round(this.bootMs / FRAME_MS)), false);
    return this;
  }

  /** Takes in a reply: the state, new events, the frame file, new errors from Godot's output. */
  absorb(reply) {
    if (!reply) return;
    if (!reply.ok) { this.newErrors.push(`godot step: ${reply.error ?? 'failed'}`); return; }
    if (Number.isFinite(reply.frame)) this.t = reply.frame * FRAME_MS;
    this.state = flattenState(reply.state);
    this.metricsRaw = reply.metrics ?? this.metricsRaw;
    const evs = Array.isArray(reply.events) ? reply.events : [];
    if (evs.length < this.eventsSeen) this.eventsSeen = 0;
    this.pendingEvents = [...(this.pendingEvents ?? []), ...evs.slice(this.eventsSeen).map((e) => ({ t: Math.round(this.t) / 1000, type: String(e?.type ?? 'game'), detail: typeof e?.detail === 'string' ? e.detail : JSON.stringify(e?.detail ?? '') }))];
    this.eventsSeen = evs.length;
    if (reply.file) { this.lastFile = workspaceRel(this.host, reply.file); this.lastFileT = this.t; }
    const log = this.session.log ?? [];
    const fresh = godotProblems(log.join('\n')).filter((p) => !/^ERROR: harness: (no input action|unknown key)/.test(p));
    log.length = 0;
    for (const e of fresh) { this.errors.push(e); this.newErrors.push(e); }
  }

  async frameNow(width) {
    if (!this.windowed || !this.lastFile || this.lastFileT !== this.t) return undefined;
    try {
      const png = await readIn(this.host, this.lastFile);
      await removeIn(this.host, this.lastFile).catch(() => {});
      this.lastPng = png;
      this.lastFile = null;
      return { png, width: width ?? this.frameWidth };
    } catch { return undefined; }
  }

  observation(frame) {
    const out = { t: this.t, state: this.state, events: this.pendingEvents ?? [], errors: this.newErrors, crashed: this.crashed === true };
    this.pendingEvents = [];
    this.newErrors = [];
    if (frame) out.frame = frame;
    return out;
  }

  alive() { return !this.closed && stepSessions().has(this.id); }

  async send(timeline, frames, capture) {
    if (!this.alive()) {
      if (!this.closed) { this.closed = true; this.crashed = (this.session.exitCode ?? 1) !== 0; if (this.crashed) this.newErrors.push(`Godot exited (code ${this.session.exitCode ?? '?'})${this.session.log?.length ? `: ${this.session.log.slice(-5).join(' | ')}` : ''}`); }
      return;
    }
    try {
      this.absorb(await (this.deps?.step ?? stepGodot)(this.id, { inputs: timeline, frames, capture: capture && this.windowed, timeoutMs: this.stepTimeoutMs }));
    } catch (e) {
      this.closed = true;
      this.crashed = true;
      this.newErrors.push(String(e?.message ?? e).split('\n').slice(0, 4).join(' | '));
    }
  }

  /** Mouse pixels in the last frame -> window pixels. */
  scale() {
    const w = this.lastFrameWidth;
    return w ? this.size[0] / w : 1;
  }

  async observe({ frame = true, width } = {}) {
    if (frame && this.windowed && this.alive()) {
      let f = await this.frameNow(width);
      if (!f) { await this.send([], 1, true); f = await this.frameNow(width); }
      if (f) this.lastFrameWidth = f.width;
      return this.observation(f);
    }
    if (this.alive()) this.absorb(await stepState(this.id).catch((e) => { this.newErrors.push(e.message); return null; }));
    return this.observation();
  }

  async act(inputs) {
    const { timeline } = toTimeline(inputs, { actions: this.actions, scale: this.scale() });
    this.timeline.push({ t: this.t, inputs });
    await this.send(timeline, 1, false);
  }

  async step(inputs, ms, { frame = true, width } = {}) {
    const { timeline, spanFrames } = toTimeline(inputs, { actions: this.actions, scale: this.scale() });
    const frames = Math.max(1, Math.round(ms !== undefined && ms !== null ? Number(ms) / FRAME_MS : Math.max(spanFrames, 1)));
    this.timeline.push({ t: Math.round(this.t), inputs, ms: Math.round(frames * FRAME_MS) });
    await this.send(timeline, frames, frame);
    const f = frame ? await this.frameNow(width) : undefined;
    if (f) this.lastFrameWidth = f.width;
    return this.observation(f);
  }

  async metrics() {
    const m = metricsOf(this.metricsRaw ?? {});
    return { clock: 'engine', ...m, gameSeconds: Math.round(this.t) / 1000 };
  }

  recording() {
    return { version: 1, engine: 'godot', game: this.game ?? this.project, project: this.project, seed: this.seed, clock: 'engine', durationMs: Math.round(this.t), steps: this.timeline.slice() };
  }

  async stop() {
    const metrics = await this.metrics();
    if (!this.closed) { this.closed = true; await (this.deps?.stop ?? stopStep)(this.id).catch(() => {}); }
    await removeIn(this.host, this.session.framesRel).catch(() => {});
    return { metrics, errors: [...new Set(this.errors)], console: [], recording: this.recording() };
  }
}

export default createDriver;
