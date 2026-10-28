// Reading a game from the outside: the state conventions bots and checks rely on, the events a
// change of state means, stuck and softlock detection, and frame-time metrics.
//
// State conventions (window.__game for web games; an engine driver's `state`), all optional:
//   player: {x, y, z?}            where the player is (novelty, stuck detection, goal-directed bots)
//   state | mode | scene: string  'title', 'playing', 'paused', 'gameover', 'won'...
//   score, lives, coins / collected / items, total / totalCoins
//   target: {x, y, z?} | targets: [{x, y, z?}]   what to move toward (remaining pickups, the exit)
//   won | done | finished | complete: true        the goal is reached
//   inputs: ['ArrowLeft', ...]                   the keys the game uses (else a default set)
//   controls: {jump: 'Space', ...}               named actions for {action: 'jump'} inputs
//   events: [{type, detail}]                      the game's own event log (drained as it grows)

export const WON_MODES = ['won', 'win', 'complete', 'completed', 'finished', 'victory', 'cleared', 'levelcomplete', 'success'];
export const LOST_MODES = ['gameover', 'game over', 'game-over', 'dead', 'lost', 'lose', 'failed'];

/** A value at a dotted path: "player.x", "targets.0.x", "targets.length". */
export function getPath(obj, p) {
  if (!p) return obj;
  let v = obj;
  for (const k of String(p).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) {
    if (v === null || v === undefined) return undefined;
    v = k === 'length' && (Array.isArray(v) || typeof v === 'string') ? v.length : v[k];
  }
  return v;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const asPoint = (p) => (p && typeof p === 'object' && isNum(p.x) && (isNum(p.y) || isNum(p.z)) ? { x: p.x, y: isNum(p.y) ? p.y : 0, z: isNum(p.z) ? p.z : 0, dims: isNum(p.z) ? 3 : 2 } : null);

/** Where the player is, from the conventions above (or null). */
export function positionOf(state) {
  if (!state || typeof state !== 'object') return null;
  return asPoint(state.player?.position) ?? asPoint(state.player?.pos) ?? asPoint(state.player) ?? asPoint(state.pos) ?? asPoint(state.position) ?? null;
}

/** What to move toward: target, or the nearest of targets (to `from`). */
export function targetOf(state, from) {
  if (!state || typeof state !== 'object') return null;
  const one = asPoint(state.target) ?? asPoint(state.goal) ?? asPoint(state.exit && state.exitOpen !== false ? state.exit : null);
  const many = Array.isArray(state.targets) ? state.targets.map(asPoint).filter(Boolean) : [];
  if (!many.length) return one;
  if (!from) return many[0];
  return many.reduce((a, b) => (dist(a, from) <= dist(b, from) ? a : b));
}

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));

export function modeOf(state) {
  if (!state || typeof state !== 'object') return '';
  const m = state.state ?? state.mode ?? state.scene ?? state.status ?? state.phase;
  return typeof m === 'string' ? m : '';
}

export function isWon(state) {
  if (!state || typeof state !== 'object') return false;
  if ([state.won, state.win, state.done, state.finished, state.complete, state.completed, state.levelComplete, state.victory].some((v) => v === true)) return true;
  return WON_MODES.includes(modeOf(state).toLowerCase().replace(/[\s_]/g, ''));
}

export function isLost(state) {
  if (!state || typeof state !== 'object') return false;
  if ([state.gameOver, state.gameover, state.dead, state.lost].some((v) => v === true)) return true;
  return LOST_MODES.includes(modeOf(state).toLowerCase());
}

const PICKUP_KEYS = ['coins', 'collected', 'items', 'pickups', 'gems', 'stars', 'keys', 'found'];

/** The events between two states (first state: none). */
export function stateEvents(prev, next, t) {
  const out = [];
  if (!prev || !next || typeof prev !== 'object' || typeof next !== 'object') return out;
  const ev = (type, detail) => out.push({ t: Math.round(t) / 1000, type, detail });
  const m0 = modeOf(prev), m1 = modeOf(next);
  if (m0 !== m1) ev('state', `${m0 || '?'} -> ${m1 || '?'}`);
  for (const k of PICKUP_KEYS) {
    const a = prev[k], b = next[k];
    const total = next.total ?? next[`total${k[0].toUpperCase()}${k.slice(1)}`] ?? next.totalCoins;
    if (isNum(a) && isNum(b) && b > a) ev('pickup', `${k} ${b}${isNum(total) ? `/${total}` : ''}`);
    if (Array.isArray(a) && Array.isArray(b) && b.length > a.length) ev('pickup', `${k} ${b.length}`);
  }
  if (isNum(prev.score) && isNum(next.score) && next.score !== prev.score) ev('score', `${prev.score} -> ${next.score}`);
  if (isNum(prev.lives) && isNum(next.lives) && next.lives < prev.lives) ev('death', `lives ${next.lives}`);
  if (isNum(prev.level) && isNum(next.level) && next.level !== prev.level) ev('level', `level ${next.level}`);
  if (!isWon(prev) && isWon(next)) ev('goal', 'the game says the goal is reached');
  if (!isLost(prev) && isLost(next)) ev('lose', m1 || 'game over');
  return out;
}

/** What "the game changed" compares: the player's position and mode, or the picture when there is no position. */
export function signature(obs) {
  const pos = positionOf(obs.state);
  return { pos, mode: modeOf(obs.state), hash: obs.hash ?? null };
}

function changed(a, b, eps) {
  if (a.mode !== b.mode) return true;
  if (a.pos && b.pos) return dist(a.pos, b.pos) > eps;
  if (a.pos || b.pos) return true;
  if (a.hash && b.hash) { let d = 0; for (let i = 0; i < a.hash.length; i++) if (a.hash[i] !== b.hash[i]) d++; return d >= 2; }
  return false;
}

/**
 * Stuck: nothing changed for stuckS seconds while inputs went in. Softlock: stuck for softlockS
 * with every action the bot has tried at least once in that time (no way forward, as far as the
 * bot can tell). update() returns the events that start or end now.
 */
export class StuckDetector {
  constructor({ stuckS = 3, softlockS = 8, eps = 0.01, actionCount = 0 } = {}) {
    Object.assign(this, { stuckS, softlockS, eps, actionCount });
    this.anchor = null;
    this.since = 0;
    this.tried = new Set();
    this.stuck = false;
    this.softlocked = false;
    this.stuckTime = 0;
  }

  update(t, sig, action) {
    const out = [];
    const s = t / 1000;
    if (!this.anchor || changed(this.anchor, sig, this.eps)) {
      if (this.stuck) { out.push({ t: s, type: 'unstuck', detail: `moving again after ${(s - this.since).toFixed(1)}s` }); this.stuckTime += s - this.since; }
      this.anchor = sig;
      this.since = s;
      this.tried = new Set();
      this.stuck = false;
      return out;
    }
    if (action !== undefined) this.tried.add(action);
    const still = s - this.since;
    if (!this.stuck && still >= this.stuckS) {
      this.stuck = true;
      out.push({ t: s, type: 'stuck', detail: `no change for ${still.toFixed(1)}s${sig.pos ? ` at (${fmt(sig.pos)})` : ''}${sig.mode ? ` in "${sig.mode}"` : ''}` });
    }
    const all = !this.actionCount || this.tried.size >= this.actionCount;
    if (!this.softlocked && still >= this.softlockS && all) {
      this.softlocked = true;
      out.push({ t: s, type: 'softlock', detail: `no input changed anything for ${still.toFixed(1)}s (${this.tried.size} different inputs tried)${sig.pos ? ` at (${fmt(sig.pos)})` : ''}${sig.mode ? ` in "${sig.mode}"` : ''}` });
    }
    return out;
  }
}

const fmt = (p) => [p.x, p.y, ...(p.dims === 3 ? [p.z] : [])].map((v) => Math.round(v * 100) / 100).join(', ');
export const formatPoint = fmt;

export function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

const r1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);

/**
 * Frame metrics. Real clock: from the intervals between frames (fpsMin is the worst
 * one-second window). Fixed clock: the real time each frame's work took (cpuFrameMs*), and an
 * fps the page could reach at that cost (fpsEstimate, capped at 60).
 */
export function frameMetrics({ intervals = [], cpu = [] } = {}) {
  const out = {};
  const iv = intervals.filter((x) => x > 0 && x < 5000);
  if (iv.length >= 5) {
    const mean = iv.reduce((a, b) => a + b, 0) / iv.length;
    let worst = Infinity, acc = 0, n = 0;
    for (const x of iv) { acc += x; n++; if (acc >= 1000) { worst = Math.min(worst, (n * 1000) / acc); acc = 0; n = 0; } }
    // The last half second or more counts as a window too.
    if (acc >= 500) worst = Math.min(worst, (n * 1000) / acc);
    if (worst === Infinity) worst = 1000 / Math.max(...iv);
    Object.assign(out, { fpsAvg: r1(1000 / mean), fpsMin: r1(worst), frameMsAvg: r1(mean), frameMsP95: r1(percentile(iv, 95)), frames: iv.length });
  }
  if (cpu.length >= 5) {
    const mean = cpu.reduce((a, b) => a + b, 0) / cpu.length;
    const p95 = percentile(cpu, 95);
    Object.assign(out, { cpuFrameMsAvg: r1(mean), cpuFrameMsP95: r1(p95), fpsEstimate: r1(Math.min(60, 1000 / Math.max(p95, 1000 / 60))) });
  }
  return out;
}
