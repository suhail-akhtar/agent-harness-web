// The game driver: how the AI player, the bots and the playtests play any game Studio builds.
//
//   const session = await startSession(host, { engine?, game?, query?, seed?, clock?, viewport? }, ctx?)
//   session.info                      { engine, game, seed, clock, inputs?, controls?, ... }
//   session.observe({frame?, width?}) { t (ms of game time), state?, events: [{t, type, detail}],
//                                       errors: [new uncaught errors], frame?: {png, width, height,
//                                       stats, hash}, hash?, crashed?, loopStopped? }
//   session.act(inputs)               apply inputs now
//   session.step(inputs, ms, {frame}) apply inputs, run ms of game time, observe
//   session.metrics()                 { fpsAvg, fpsMin, frameMsP95 | cpuFrameMs*, memoryMb, ... }
//   session.recording()               the input timeline and what replays it (seed, clock, game)
//   session.stop()                    { metrics, errors, console, recording }
//
// Inputs: [{key: 'ArrowRight', ms: 400}] holds a key, [{key: 'Space'}] taps it, {down|up: true}
// holds or lets go; {action: 'jump'} uses the game's named controls; {mouse: [x, y], click |
// down | up | move: true} in the pixels of the last frame; `at` delays one input inside a step.
//
// Engines: the web driver (web-driver.mjs) is built in. Godot, Unreal and Unity plug in two ways:
//  1. a module plugins/engine-<engine>/driver.mjs exporting createDriver(host, opts) that returns
//     { start(game, opts) -> session } with the session interface above (preferred: bots and
//     gates use it with no model and no tool call);
//  2. the engine's own tool with a step mode: <engine> {action: 'play', mode: 'step', session?,
//     project?, inputs, ms, frame} returning an EngineResult (sdk/engine.mjs) whose data is
//     {session, t, state?, events?, errors?, crashed?} and whose files hold the frame PNG; the
//     tool ends a session with {action: 'play', mode: 'stop', session}. Used only from a tool
//     call (game_play), where the agent's own tools can be called.
// Neither there: the engine is unavailable for play, and says so.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareFrame } from './frames.mjs';
import { startWebSession } from './web-driver.mjs';

export const PLAY_ENGINES = ['web', 'godot', 'unreal', 'unity'];
const exists = (f) => fsp.stat(f).then(() => true, () => false);

/** Which engine a game folder is for: .studio/project.json, else the files there. */
export async function detectEngine(root, game) {
  try {
    const p = JSON.parse(await fsp.readFile(path.join(root, '.studio', 'project.json'), 'utf8'));
    if (PLAY_ENGINES.includes(p.engine)) return p.engine;
  } catch { /* no project file */ }
  if (game && /\.html?$/i.test(game)) return 'web';
  if (await exists(path.join(root, 'project.godot'))) return 'godot';
  try { if ((await fsp.readdir(root)).some((f) => f.endsWith('.uproject'))) return 'unreal'; } catch { /* unreadable */ }
  if (await exists(path.join(root, 'ProjectSettings', 'ProjectVersion.txt'))) return 'unity';
  return 'web';
}

/** The page of a web game: the one named, the project's, or index.html at the root or in public/ or dist/. */
export async function webEntry(root, game) {
  if (game) return String(game);
  try {
    const p = JSON.parse(await fsp.readFile(path.join(root, '.studio', 'project.json'), 'utf8'));
    if (typeof p.entry === 'string') return p.entry;
  } catch { /* no project file */ }
  for (const f of ['index.html', 'public/index.html', 'dist/index.html', 'build/index.html']) if (await exists(path.join(root, f))) return f;
  return null;
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** An engine plugin's driver module, when it has one (plugins/engine-<engine>/driver.mjs). */
export async function engineDriverModule(engine) {
  const file = process.env[`HARNESS_${engine.toUpperCase()}_DRIVER`] || path.resolve(here, '..', '..', `engine-${engine}`, 'driver.mjs');
  if (!(await exists(file))) return null;
  const mod = await import(pathToFileURL(file).href);
  return typeof mod.createDriver === 'function' ? mod : null;
}

export class Unavailable extends Error {
  constructor(engine, why) { super(why); this.engine = engine; this.unavailable = true; }
}

/**
 * Starts a session on the game in the workspace (or `root`, a server folder of it).
 * ctx: a tool call's context, so an engine tool with a step mode can be the driver.
 */
export async function startSession(host, opts = {}, ctx) {
  const root = opts.root ?? host.root;
  const engine = opts.engine && opts.engine !== 'auto' ? String(opts.engine) : await detectEngine(root, opts.game);
  if (engine === 'web') {
    const game = await webEntry(root, opts.game);
    if (!game) throw new Error('No web game here: no index.html at the workspace root (or public/, dist/), and no "game" path given.');
    return startWebSession({ ...opts, root, game });
  }
  if (!PLAY_ENGINES.includes(engine)) throw new Unavailable(engine, `Studio cannot play ${engine} games (engines: ${PLAY_ENGINES.join(', ')}).`);
  const mod = await engineDriverModule(engine);
  if (mod) {
    const driver = await mod.createDriver(host, opts);
    if (driver?.unavailable) throw new Unavailable(engine, String(driver.unavailable));
    return normalize(await driver.start(opts.game, opts), engine);
  }
  if (ctx?.callTool && ctx.toolNames?.().includes(engine)) return startToolSession(engine, host, opts, ctx);
  throw new Unavailable(engine, `${engine} games cannot be played yet: the engine-${engine} plugin is not on, or it has no play driver (plugins/engine-${engine}/driver.mjs or a "play" step mode in its ${engine} tool).`);
}

/** Fills what an engine session leaves out, so bots and tools see one shape. */
function normalize(s, engine) {
  const timeline = [];
  return {
    engine,
    get info() { return { engine, clock: 'engine', ...(s.info ?? {}) }; },
    get t() { return s.t ?? 0; },
    async observe(o = {}) { return fill(await s.observe(o)); },
    async act(inputs) { timeline.push({ t: s.t ?? 0, inputs }); return s.act ? s.act(inputs) : s.step(inputs, 0); },
    async step(inputs, ms, o = {}) { timeline.push({ t: s.t ?? 0, inputs, ms }); return fill(await s.step(inputs, ms, o)); },
    async metrics() { return (await s.metrics?.()) ?? {}; },
    recording() { return s.recording?.() ?? { version: 1, engine, game: s.info?.game, seed: s.info?.seed, clock: 'engine', steps: timeline }; },
    async stop() { const r = (await s.stop?.()) ?? {}; return { metrics: r.metrics ?? {}, errors: r.errors ?? [], console: r.console ?? [], recording: r.recording ?? this.recording() }; },
  };
  function fill(o) {
    const out = { t: o?.t ?? s.t ?? 0, state: o?.state, events: o?.events ?? [], errors: o?.errors ?? [], crashed: !!o?.crashed, hash: o?.hash ?? o?.frame?.hash };
    if (o?.frame?.png && !o.frame.stats) out.frame = { ...prepareFrame(o.frame.png, o.frame.width ?? 512), t: out.t };
    else if (o?.frame) out.frame = o.frame;
    return out;
  }
}

/** A session through the engine's tool: {action: 'play', mode: 'step'} calls, the frame read from the file it wrote. */
async function startToolSession(engine, host, opts, ctx) {
  let id = null;
  let t = 0;
  let last;
  const timeline = [];
  const call = async (input) => {
    const r = await ctx.callTool(engine, { action: 'play', ...input });
    const data = /(?:^|\n)Data: (.*)/.exec(r.content)?.[1];
    let parsed = {};
    try { parsed = data ? JSON.parse(data) : {}; } catch { /* the tool clipped it */ }
    if (r.is_error && !parsed.session) {
      if (/unavailable/i.test(r.content)) throw new Unavailable(engine, r.content.split('\n')[0]);
      throw new Error(r.content.split('\n').slice(0, 6).join('\n'));
    }
    const files = (/(?:^|\n)Files: (.*)/.exec(r.content)?.[1] ?? '').split(', ').filter((f) => /\.png$/i.test(f));
    return { parsed, files };
  };
  const observeFrom = async ({ parsed, files }, frame = true, width = 512) => {
    id = parsed.session ?? id;
    t = Number(parsed.t) || t;
    const o = { t, state: parsed.state, events: parsed.events ?? [], errors: parsed.errors ?? [], crashed: !!parsed.crashed };
    if (frame && files[0]) {
      try { o.frame = { ...prepareFrame(await fsp.readFile(path.join(host.root, files[0])), width), t }; o.hash = o.frame.hash; } catch { /* the frame is on another machine */ }
    }
    last = o;
    return o;
  };
  const first = await call({ mode: 'step', project: opts.project ?? opts.game, seed: opts.seed, inputs: [], ms: opts.bootMs ?? 500, frame: true });
  await observeFrom(first);
  return {
    engine,
    get info() { return { engine, clock: 'engine', game: opts.game ?? opts.project, seed: opts.seed, via: `${engine} tool` }; },
    get t() { return t; },
    async observe({ frame = true, width } = {}) { return observeFrom(await call({ mode: 'step', session: id, inputs: [], ms: 0, frame }), frame, width); },
    async act(inputs) { timeline.push({ t, inputs }); await observeFrom(await call({ mode: 'step', session: id, inputs, ms: 0, frame: false }), false); },
    async step(inputs, ms, { frame = true, width } = {}) { timeline.push({ t, inputs, ms }); return observeFrom(await call({ mode: 'step', session: id, inputs, ms, frame }), frame, width); },
    async metrics() { return {}; },
    recording() { return { version: 1, engine, game: opts.game ?? opts.project, seed: opts.seed, clock: 'engine', steps: timeline.slice() }; },
    async stop() {
      await ctx.callTool(engine, { action: 'play', mode: 'stop', session: id }).catch(() => {});
      return { metrics: {}, errors: last?.errors ?? [], console: [], recording: this.recording() };
    },
  };
}
