// The AI player's driver for Unity: the game runs paused between steps; each step holds
// some keys for a few frames, then the game pauses again and answers with the frame (PNG),
// the state the game publishes (HarnessState: score, won, the player's position...) and
// the events since the last step. Two ways in:
//   mode "editor": play mode in the editor that has the project open (the live bridge);
//   mode "player": a built player (Windows/Linux/Mac) started with -harnessBridgeFile, whose
//                  runtime bridge listens on 127.0.0.1 with a token written for it.
//
//   const d = createDriver(host, { project: 'Game', mode: 'player' });
//   let o = await d.start();                    // { frame, image, state, events, t, done, ... }
//   o = await d.step({ keys: ['W'], frames: 10 });
//   await d.act({ press: ['Space'] });          // advances without a frame
//   o = await d.observe();
//   await d.stop();

import crypto from 'node:crypto';
import net from 'node:net';
import { execIn, listIn, newId, readTextIn, relIn, runtimePath, commandLine, writeIn } from '../games3d/lib-engines.mjs';
import { alive, connect, readBridgeFile, waitFor } from './bridge.mjs';
import { keyName, playerArgs } from './lib-unity.mjs';

/** A free port on 127.0.0.1 for a player's runtime bridge. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** An observation from the bridge's answer: the PNG as bytes and as an image block. */
export function observation(raw) {
  const png = raw?.frame ? Buffer.from(raw.frame, 'base64') : null;
  return {
    frame: png, image: png ? { media_type: 'image/png', data: raw.frame } : null, width: raw?.width, height: raw?.height,
    state: raw?.state ?? {}, events: raw?.events ?? [], t: raw?.t ?? 0, frameCount: raw?.frameCount ?? 0, done: Boolean(raw?.done),
  };
}

/** A step's input for the bridge: held keys, keys pressed for this step only, axes, frames. */
export function stepArgs(input = {}, defaults = {}) {
  const keys = (list) => (Array.isArray(list) ? list : list ? [list] : []).map(keyName).filter(Boolean);
  const axes = {};
  for (const [k, v] of Object.entries(input.axes ?? {})) if (Number.isFinite(Number(v))) axes[k] = Math.max(-1, Math.min(1, Number(v)));
  return {
    hold: keys(input.keys ?? input.hold), press: keys(input.press), axes,
    frames: Math.min(Math.max(Math.round(Number(input.frames ?? defaults.frames ?? 6)), 1), 600),
    width: defaults.width ?? 960, height: defaults.height ?? 540, ...(defaults.camera ? { camera: defaults.camera } : {}),
  };
}

/**
 * The driver (start / observe / act / step / stop). opts: project (the Unity project folder),
 * mode ("editor" | "player", default player when a build exists), build (a player executable in the
 * workspace), scene (editor mode), width, height, framesPerStep, maxSeconds (the player's lifetime).
 */
export function createDriver(host, opts = {}) {
  const deps = opts.deps ?? {};
  const defaults = { frames: opts.framesPerStep ?? 6, width: opts.width ?? 960, height: opts.height ?? 540, camera: opts.camera };
  let bridge = null;
  let mode = opts.mode ?? null;
  let player = null;
  let started = false;
  const timeout = { timeoutMs: opts.stepTimeoutMs ?? 60_000 };

  const ready = () => { if (!started || !bridge) throw new Error('the driver is not started: call start() first'); };

  async function startEditor(project) {
    const file = await readBridgeFile(host, project, opts.signal);
    if (!file || !(deps.alive ?? alive)(file.pid)) throw new Error(`no editor has ${project} open with the harness bridge: open it in Unity, or use mode "player" with a build`);
    bridge = (deps.connect ?? connect)({ port: file.port, token: file.token });
    await bridge.call('play.enter', { stepMode: true, scene: opts.scene, discard: opts.discard === true }, { timeoutMs: 30_000, retryMs: 10_000 });
    // Entering play mode reloads scripts: the bridge comes back, then play mode is ready.
    await waitFor(bridge, 'play.status', (s) => s?.playing && s.ready && s.mode === 'steps', { timeoutMs: opts.enterTimeoutMs ?? 180_000, signal: opts.signal });
  }

  async function findBuild(project) {
    if (opts.build) return relIn(host, String(opts.build));
    const want = host.platform === 'linux' ? 'linux64' : host.platform === 'darwin' ? 'mac' : 'win64';
    const dir = `${project === '.' ? '' : `${project}/`}Builds/${want}`;
    const exe = (await listIn(host, dir, opts.signal)).find((n) => (want === 'win64' ? /\.exe$/i.test(n) && !/UnityCrashHandler/i.test(n) : /\.x86_64$/.test(n)));
    return exe ? `${dir}/${exe}` : null;
  }

  async function startPlayer(project) {
    const exe = await findBuild(project);
    if (!exe) throw new Error('no player build to drive: build one first (unity tool, action build, target win64), or pass build');
    const port = await (deps.freePort ?? freePort)();
    const token = crypto.randomBytes(16).toString('hex');
    const dir = `.harness/unity/driver/${newId()}`;
    await writeIn(host, `${dir}/bridge.json`, JSON.stringify({ port, token, step: true }), opts.signal);
    const ctl = new AbortController();
    const args = playerArgs({ log: runtimePath(host, `${dir}/player.log`), bridgeFile: runtimePath(host, `${dir}/bridge.json`), width: defaults.width, height: defaults.height });
    const run = deps.launch ? deps.launch(exe, args, ctl.signal) : execIn(host, commandLine(runtimePath(host, exe), args, host.shell), { timeoutMs: (opts.maxSeconds ?? 1800) * 1000, signal: ctl.signal });
    player = { ctl, exited: false, dir, run: Promise.resolve(run).then((r) => { player && (player.exited = true); return r; }, (e) => { player && (player.exited = true); throw e; }) };
    player.run.catch(() => {});
    bridge = (deps.connect ?? connect)({ port, token });
    const until = Date.now() + (opts.launchTimeoutMs ?? 90_000);
    for (;;) {
      try { await bridge.call('status', {}, { timeoutMs: 5000 }); break; } catch (e) {
        if (player.exited) throw new Error(`the player exited before its bridge answered: see ${dir}/player.log`);
        if (Date.now() > until) throw new Error(`the player's bridge did not answer in ${Math.round((opts.launchTimeoutMs ?? 90_000) / 1000)} s (${e.message}); see ${dir}/player.log`);
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  return {
    get mode() { return mode; },
    info: { engine: 'unity', keys: ['W', 'A', 'S', 'D', 'UpArrow', 'DownArrow', 'LeftArrow', 'RightArrow', 'Space', 'LeftShift', 'Return', 'Escape', 'E', 'Q', 'Mouse0'], axes: ['Horizontal', 'Vertical'] },

    async start() {
      if (started) return this.observe();
      if (host.kind !== 'local' && !deps.connect) throw new Error('the Unity driver runs the game on the server\'s own computer (a server folder session)');
      const project = opts.project ? await relIn(host, String(opts.project)) : '.';
      if (!mode) mode = (opts.build || await findBuild(project)) ? 'player' : 'editor';
      if (mode === 'editor') await startEditor(project); else await startPlayer(project);
      started = true;
      return this.observe();
    },

    async observe() {
      ready();
      return observation(await bridge.call('play.observe', { capture: true, width: defaults.width, height: defaults.height, camera: defaults.camera }, timeout));
    },

    /** Applies the input and advances its frames without drawing a frame: the state and events come back. */
    async act(input = {}) {
      ready();
      const o = observation(await bridge.call('play.step', { ...stepArgs(input, defaults), capture: false }, timeout));
      return { state: o.state, events: o.events, t: o.t, frameCount: o.frameCount, done: o.done };
    },

    /** Applies the input, advances its frames, pauses, and answers with the frame, the state and the events. */
    async step(input = {}) {
      ready();
      return observation(await bridge.call('play.step', { ...stepArgs(input, defaults), capture: true }, timeout));
    },

    async stop() {
      if (!bridge) return;
      try {
        if (mode === 'editor') await bridge.call('play.exit', {}, { timeoutMs: 10_000 }).catch(() => {});
        else await bridge.call('play.quit', {}, { timeoutMs: 5000 }).catch(() => {});
      } finally {
        bridge.close();
        bridge = null;
        started = false;
        if (player) {
          const p = player;
          await Promise.race([p.run.catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
          if (!p.exited) p.ctl.abort();
          player = null;
        }
      }
    },

    /** The player's log (mode player), for when something went wrong. */
    async log() { return player ? readTextIn(host, `${player.dir}/player.log`) : null; },
  };
}

export default createDriver;
