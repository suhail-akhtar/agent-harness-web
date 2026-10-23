// The AI player's driver for Unreal (games3d/player/driver.mjs loads it): built on the step
// server inside an editor -game session (python/harness_step.py). The game waits paused
// between steps; a step holds keys for some ms of game time, pauses again and answers with the
// frame, the state (pawn, game mode Score/Total/Won, counts of watched classes) and the
// HARNESS_EVENT lines the game logged since the last step.
//
//   const d = await createDriver(host, { project: 'CoinEscape', watch: ['/Game/CoinKit/BP_Coin.BP_Coin_C'] });
//   const s = await d.start();
//   let o = await s.step([{ key: 'W' }], 500);        // { t, frame: {png, width, height}, state, events, errors }
//   await s.act([{ key: 'Space' }]);                  // applies inputs, no frame
//   o = await s.observe();
//   const { metrics } = await s.stop();               // fps, frame ms, memory from a CSV profile of the session
//
// Inputs: {key, ms?} holds a key for the step (or ms), {key, down: true} holds it across steps
// until {key, up: true}, {action: 'IA_Jump'} drives an Enhanced Input action, {look: [yaw, pitch]}
// turns the view by degrees. Browser key names (ArrowRight, Space, KeyW) are mapped to Unreal's.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { keyName } from './lib/args.mjs';
import { engine, projectOf, runDir } from './lib/context.mjs';
import { eventsIn, parseCsvProfile, problemsIn } from './lib/logs.mjs';
import { filesSince, startStepSession, stopStepSession } from './lib/play.mjs';

const BROWSER_KEYS = { ArrowRight: 'Right', ArrowLeft: 'Left', ArrowUp: 'Up', ArrowDown: 'Down', Space: 'SpaceBar', ' ': 'SpaceBar', Enter: 'Enter', Escape: 'Escape', Shift: 'LeftShift', Control: 'LeftControl' };

/** An Unreal key name for a key as a person, a browser or Unreal names it. */
export function unrealKey(k) {
  const s = String(k);
  if (BROWSER_KEYS[s]) return BROWSER_KEYS[s];
  const code = /^Key([A-Z])$/.exec(s) ?? /^Digit(\d)$/.exec(s);
  if (code) return /\d/.test(code[1]) ? ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'][Number(code[1])] : code[1];
  return keyName(s.length === 1 ? s.toUpperCase() : s);
}

/** A step request for the step server from driver inputs and the keys held across steps. */
export function stepRequest(inputs = [], ms, held = new Set()) {
  const keys = new Set(held);
  const actions = [];
  let look = null;
  let longest = 0;
  for (const i of Array.isArray(inputs) ? inputs : [inputs]) {
    if (i.key !== undefined) {
      const k = unrealKey(i.key);
      if (i.up) { held.delete(k); keys.delete(k); continue; }
      if (i.down) held.add(k);
      keys.add(k);
      if (i.ms) longest = Math.max(longest, Number(i.ms));
    } else if (i.action) actions.push({ name: String(i.action), value: String(i.value ?? 'true') });
    else if (Array.isArray(i.look)) look = i.look.map(Number);
  }
  const span = Number.isFinite(Number(ms)) && ms !== undefined ? Number(ms) : longest || 100;
  return { op: 'step', keys: [...keys], actions, ...(look ? { look } : {}), ms: Math.min(Math.max(span, 0), 10_000) };
}

/** The driver, or { unavailable } with the reason. opts: project, level, watch, width, height. */
export async function createDriver(host, opts = {}) {
  if (host.kind !== 'local') return { unavailable: 'Unreal runs on the server\'s own computer: the Unreal driver needs a server folder session' };
  const eng = opts.engine ?? await engine();
  if (!eng) return { unavailable: 'Unreal Engine is not installed (or set HARNESS_UNREAL_ROOT)' };
  return {
    async start(game, more = {}) {
      const o = { ...opts, ...more };
      const proj = await projectOf(host, o.project ?? game);
      const rd = await runDir(host, 'driver');
      const logFile = path.join(rd.dir, 'game.log');
      const startedAt = Date.now();
      const s = await startStepSession(host, eng, proj, { map: o.level, width: o.width ?? 960, height: o.height ?? 540, watch: o.watch, logFile });
      const held = new Set();
      let offset = 0;
      let t = s.state?.gameMs ?? 0;
      let steps = 0;
      await s.client.request({ op: 'console', command: 'CsvProfile Start' }).catch(() => {});

      // What the game logged since the last look: its events and new errors.
      async function news() {
        const text = await fsp.readFile(logFile, 'utf8').catch(() => '');
        const fresh = text.slice(offset);
        offset = text.length;
        return { events: eventsIn(fresh).filter((e) => e.type !== 'step-server'), errors: problemsIn(fresh, { warnings: false }).map((p) => p.message) };
      }
      async function frameOf(file, keep) {
        if (!file) return undefined;
        const png = await fsp.readFile(file);
        const to = path.join(rd.dir, `frame-${String(steps).padStart(4, '0')}.png`);
        await fsp.rename(file, to).catch(() => {});
        return { png, width: o.width ?? 960, height: o.height ?? 540, ...(keep ? { file: to } : {}) };
      }
      async function run(req, capture) {
        if (s.child.exitCode !== null) return { t, crashed: true, events: [], errors: [`the game exited (code ${s.child.exitCode})`] };
        const r = await s.client.request({ ...req, capture }, 60_000 + req.ms);
        if (!r.ok) throw new Error(r.error ?? 'the step failed');
        steps += 1;
        t = r.state?.gameMs ?? t;
        return { t, state: r.state, frame: capture ? await frameOf(r.frame, false) : undefined, ...await news() };
      }
      return {
        info: { engine: 'unreal', game: proj.rel, clock: 'engine', level: o.level ?? null, startupS: s.startupS, keys: ['W', 'A', 'S', 'D', 'SpaceBar', 'Up', 'Down', 'Left', 'Right', 'LeftShift', 'E'], log: path.relative(host.root, logFile).split(path.sep).join('/') },
        get t() { return t; },
        async observe({ frame = true } = {}) {
          if (!frame) { const r = await s.client.request({ op: 'state' }); return { t, state: r.state, ...await news() }; }
          return run({ op: 'step', keys: [...held], actions: [], ms: 0 }, true);
        },
        async act(inputs) { return run(stepRequest(inputs, undefined, held), false); },
        async step(inputs, ms, { frame = true } = {}) { return run(stepRequest(inputs, ms, held), frame); },
        async metrics() { return { steps, gameMs: Math.round(t) }; },
        async stop() {
          await s.client.request({ op: 'console', command: 'CsvProfile Stop' }).catch(() => {});
          await new Promise((r) => setTimeout(r, 1500));
          const { errors } = await news();
          await stopStepSession(s);
          const csv = (await filesSince(path.join(proj.dir, 'Saved', 'Profiling', 'CSV'), startedAt, (n) => /\.csv$/i.test(n))).at(-1);
          const prof = csv ? parseCsvProfile(await fsp.readFile(csv.file, 'utf8'), { skip: 5 }) : null;
          return { metrics: { ...(prof ?? {}), steps, gameMs: Math.round(t), wallS: Math.round((Date.now() - startedAt) / 100) / 10 }, errors };
        },
      };
    },
  };
}
