// Studio web game engine: the loop, the scenes, randomness, events and the window.__game hook.
// Shared by every web template (plugins/games3d/templates/web); plain ES modules, no build step,
// nothing from the network. A game:
//
//   const game = new Game({ canvas, width: 640, height: 360, config, scenes: { loading, title, play, paused, won, gameover } });
//   game.expose(() => ({ score, player: { x, y }, targets: [...], won }));   // what window.__game shows
//   game.start('loading');
//
// A scene is { enter(game, data), update(dt, game), draw(ctx, game), exit(game) } (each optional).
// The loop runs update at a fixed 60 per second and draws every animation frame; a slow frame
// never changes the rules. ?seed=N seeds game.random, ?autostart=1 skips the title, ?level=N starts there.

export const DT = 1 / 60;
export const query = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');

/** mulberry32: the same seed gives the same game. */
export function rng(seed = 1) {
  let s = (Number(seed) >>> 0) || 1;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
const round = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);

/** Loads game.json (the game's config: title, controls, assets, levels, tuning). */
export async function loadConfig(url = 'game.json') {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status}`);
    return await r.json();
  } catch (e) {
    console.warn(`studio: ${url} did not load (${e.message}); the template's defaults are used`);
    return {};
  }
}

// The fields window.__game always has (the player reads these: plugins/games3d/player/analysis.mjs).
const HOOK_KEYS = ['state', 'scene', 'score', 'lives', 'health', 'coins', 'collected', 'total', 'won', 'lost', 'gameOver', 'player', 'targets', 'exitOpen', 'level', 'levels', 'time', 'flags', 'paused'];

export class Game {
  constructor({ canvas, width, height, config = {}, scenes = {}, pixelArt = true }) {
    this.canvas = canvas;
    this.width = width;
    this.height = height;
    this.config = config;
    this.scenes = scenes;
    this.seed = Number(query.get('seed') ?? config.seed ?? 1) || 1;
    this.random = rng(this.seed);
    this.events = [];
    this.flags = {};
    this.time = 0;
    this.ticks = 0;
    this.scene = null;
    this.sceneName = '';
    this.data = {};
    this.missing = [];
    if (canvas && canvas.getContext && !canvas.dataset.webgl) {
      canvas.width = width;
      canvas.height = height;
      this.ctx = canvas.getContext('2d');
      if (pixelArt) this.ctx.imageSmoothingEnabled = false;
    }
  }

  /** Records what happened: the player's playtests read these (pickup, hit, death, goal, level...). */
  emit(type, detail = '') {
    this.events.push({ type, detail: String(detail), t: Math.round(this.time * 100) / 100 });
    if (this.events.length > 400) this.events.splice(0, 200);
    this.onEvent?.(type, detail);
  }

  /** Goes to a scene (its enter gets data). */
  go(name, data = {}) {
    const next = this.scenes[name];
    if (!next) throw new Error(`no scene "${name}"`);
    this.scene?.exit?.(this);
    // The clock starts once the files are in: however long loading took, the game is the same.
    if (this.sceneName === 'loading') { this.time = 0; this.events.length = 0; }
    this.scene = next;
    this.sceneName = name;
    this.sceneTime = 0;
    next.enter?.(this, data);
  }

  start(first = 'loading') {
    this.go(first);
    let last = performance.now();
    let acc = 0;
    const frame = (now) => {
      acc += Math.min(0.25, Math.max(0, (now - last) / 1000));
      last = now;
      while (acc >= DT) {
        this.ticks++;
        this.time += DT;
        this.sceneTime += DT;
        this.input?.beginStep?.();
        this.scene?.update?.(DT, this);
        this.input?.endStep?.();
        acc -= DT;
      }
      if (this.ctx) this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.scene?.draw?.(this.ctx, this);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  /**
   * window.__game: the template's own fields (fn() returns them, read once per step) over the
   * standard ones. Static: inputs (the keys a bot may press) and controls (named actions).
   */
  expose(fn, { inputs, controls } = {}) {
    let cache = null, at = -1;
    const hook = { inputs: inputs ?? this.input?.botKeys() ?? [], controls: controls ?? this.input?.controls() ?? {} };
    const defined = new Set();
    const define = (k) => { if (defined.has(k) || k === 'inputs' || k === 'controls') return; defined.add(k); Object.defineProperty(hook, k, { get: () => now()[k], enumerable: true }); };
    // Fields a template adds once it plays (its fn may return fewer while loading) appear as they come.
    const now = () => { if (at !== this.ticks || !cache) { cache = { ...this.standard(), ...fn() }; at = this.ticks; for (const k of Object.keys(cache)) define(k); } return cache; };
    Object.defineProperty(hook, 'events', { get: () => this.events, enumerable: true });
    for (const k of new Set([...HOOK_KEYS, ...Object.keys(fn() ?? {})])) define(k);
    // Tests and agents can drive the game a step at a time and read its config.
    const step = (n = 1) => { for (let i = 0; i < n; i++) { this.ticks++; this.time += DT; this.scene?.update?.(DT, this); } return now(); };
    Object.defineProperty(hook, 'step', { value: step, enumerable: false });
    Object.defineProperty(hook, 'config', { value: this.config, enumerable: false });
    window.__game = hook;
    return hook;
  }

  standard() {
    const s = this.sceneName;
    return { state: s, scene: s, won: s === 'won', lost: s === 'gameover', gameOver: s === 'gameover', paused: s === 'paused', time: round(this.time), flags: { ...this.flags } };
  }
}

/** Rounds a point for the hook. */
export const pt = (p) => (p ? (p.z === undefined ? { x: round(p.x), y: round(p.y) } : { x: round(p.x), y: round(p.y), z: round(p.z) }) : null);

/**
 * The standard scenes around a game's play scene: loading (runs load(), then title, or play with
 * ?autostart=1), title (Enter or Space starts), paused (P or Escape resumes), won and gameover
 * (Enter plays again). draw(ctx, game, lines) draws a card with lines of text; the 3D templates
 * pass their own (a DOM overlay).
 */
export function standardScenes({ load, play, title = 'Game', subtitle = 'Press Enter to start', card, onRestart }) {
  const startPlay = (game, data) => { onRestart?.(game); game.go('play', data); };
  return {
    loading: {
      enter(game) {
        game.loaded = false;
        Promise.resolve(load(game)).then(() => { game.loaded = true; }, (e) => { console.warn(`studio: loading failed: ${e?.message ?? e}`); game.loaded = true; });
      },
      update(_dt, game) {
        if (!game.loaded) return;
        if (query.get('autostart') === '1') startPlay(game, { level: Number(query.get('level') ?? 0) || 0 });
        else game.go('title');
      },
      draw(ctx, game) { card(ctx, game, ['Loading...']); },
    },
    title: {
      update(_dt, game) { if (game.input.pressed('start') || game.input.pressed('jump') || game.input.pressed('action')) startPlay(game, { level: Number(query.get('level') ?? 0) || 0 }); },
      draw(ctx, game) { card(ctx, game, [title, subtitle, game.config.help ?? '']); },
    },
    play,
    paused: {
      update(_dt, game) { if (game.input.pressed('pause')) { game.scene = play; game.sceneName = 'play'; } },
      draw(ctx, game) { play.draw?.(ctx, game); card(ctx, game, ['Paused', 'P to resume']); },
    },
    won: {
      enter(game) { game.emit('goal', 'the game is won'); },
      update(_dt, game) { if (game.sceneTime > 0.5 && (game.input.pressed('start') || game.input.pressed('restart'))) startPlay(game, { level: 0 }); },
      draw(ctx, game) { play.draw?.(ctx, game); card(ctx, game, ['You win!', `Score ${game.data.score ?? 0}`, 'Enter to play again']); },
    },
    gameover: {
      enter(game) { game.emit('lose', 'game over'); },
      update(_dt, game) { if (game.sceneTime > 0.5 && (game.input.pressed('start') || game.input.pressed('restart') || game.input.pressed('jump'))) startPlay(game, { level: 0 }); },
      draw(ctx, game) { play.draw?.(ctx, game); card(ctx, game, ['Game over', `Score ${game.data.score ?? 0}`, 'Enter to try again']); },
    },
  };
}

/** Pauses from the play scene (P or Escape): call in play.update. */
export function pauseCheck(game) {
  if (!game.input.pressed('pause')) return false;
  game.scene = game.scenes.paused;
  game.sceneName = 'paused';
  return true;
}
