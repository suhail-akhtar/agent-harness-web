// Bots that play with no model, on any driver session (driver.mjs):
//   random    a random input (or two together) held for a random time
//   explore   novelty search: a graph of the places (or pictures) it has seen, every input tried
//             from each, then the shortest known way to the nearest place with inputs left to try
//   goal      explore, pulled toward the target the game exposes (state.target / targets): the
//             input that moved the player that way before, unless it stopped helping here
//   monkey    stress: bursts of rapid taps and clicks, several keys at once
//   scripted  a recording (exact replay, clock fixed) or a list of steps
// All of them report events (pickups, state changes, errors), stuck and softlock moments with
// evidence frames, coverage, and the recording of what they pressed.

import { dist, isLost, isWon, modeOf, positionOf, signature, stateEvents, StuckDetector, targetOf } from './analysis.mjs';
import { sample } from './verdicts.mjs';

export const BOT_MODES = ['random', 'explore', 'goal', 'monkey', 'scripted'];
const DEFAULT_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'Enter'];
const HORIZONTAL = ['ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD'];
const JUMP = ['Space', 'ArrowUp', 'KeyW', 'KeyZ', 'KeyX'];
const MENU = ['Enter', 'Space', 'KeyR', 'KeyP', 'Escape'];
const NOTABLE = new Set(['pickup', 'goal', 'lose', 'death', 'level', 'stuck', 'softlock', 'error', 'crash', 'loop-stopped']);

export function rng(seed = 1) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The inputs a bot tries: the game's keys (state.inputs) or a default set, a run-and-jump for each direction, and waiting. */
export function actionSpace(info, extra = []) {
  const keys = [...new Set([...(info?.inputs?.length ? info.inputs : DEFAULT_KEYS), ...extra])].slice(0, 14);
  const list = keys.map((k) => [k]);
  const h = keys.filter((k) => HORIZONTAL.includes(k));
  const j = keys.filter((k) => JUMP.includes(k));
  for (const a of h) for (const b of j) if (a !== b) list.push([a, b]);
  const moves = list.filter((k) => k.some((x) => !MENU.includes(x) || JUMP.includes(x)));
  const out = list.map((k) => ({ keys: k, hold: 1 }));
  // Long holds too: a whole jump arc, or a corridor in one go, is one step to the explorer.
  for (const k of moves) out.push({ keys: k, hold: 4 });
  out.push({ keys: [], hold: 1 });
  return out.map((a, id) => ({ ...a, id, label: `${a.keys.join('+') || 'wait'}${a.hold > 1 ? ' (long)' : ''}` }));
}

const inputsOf = (a, ms) => a.keys.map((key) => ({ key, ms: ms * (a.hold ?? 1) }));
const lengthOf = (a, ms) => ms * (a?.hold ?? 1);
const sec = (ms) => Math.round(ms) / 1000;

/** Novelty search over cells (grid squares of the player's position, or pictures), shared by explore and goal. */
export class Explorer {
  constructor(actions, random, { goal = false, retryMs = 20_000, plateauMs = 3000, exploreMs = 6000, gridScale = 1.8 } = {}) {
    Object.assign(this, { actions, random, goal, retryMs, plateauMs, exploreMs, gridScale });
    this.cells = new Map();
    this.grid = null;
    this.moves = [];
    this.effects = actions.map(() => ({ x: 0, y: 0, z: 0, n: 0 }));
    this.places = new Set();
  }

  keyOf(obs) {
    const pos = positionOf(obs.state);
    const mode = modeOf(obs.state);
    if (pos && this.grid) {
      const p = obs.state?.player;
      const ground = p && (p.ground === true || p.onGround === true || p.grounded === true) ? 'g' : '';
      return `${this.place(mode, pos)}${ground}`;
    }
    return `${mode}|${pos ? 'p' : ''}${obs.hash ?? ''}`;
  }

  place(mode, pos) {
    const g = this.grid;
    return `${mode}|${Math.floor(pos.x / g)},${Math.floor(pos.y / g)},${Math.floor(pos.z / g)}`;
  }

  /**
   * Whether an input from here may find somewhere new: untried here, and (once the bot knows what
   * the input does) the place it usually leads to is not visited yet. Saves trying all inputs everywhere.
   */
  open(c, a, t, mode) {
    const e = c.tried.get(a.id);
    if (e && t - e.lastT <= this.retryMs) return false;
    if (!a.keys.length && this.grid) return false;
    const f = this.effects[a.id];
    if (!c.pos || !this.grid || f.n < 2) return true;
    const to = { x: c.pos.x + f.x / f.n, y: c.pos.y + f.y / f.n, z: c.pos.z + f.z / f.n };
    return !this.places.has(this.place(mode, to));
  }

  cell(key, pos) {
    let c = this.cells.get(key);
    if (!c) { c = { key, visits: 0, tried: new Map(), pos }; this.cells.set(key, c); }
    if (pos) c.pos = pos;
    return c;
  }

  score(a, from, target) {
    const e = this.effects[a.id];
    if (!from || !target || !e.n) return 0;
    const dx = target.x - from.x, dy = target.y - from.y, dz = target.z - from.z;
    const d = Math.hypot(dx, dy, dz) || 1;
    const m = Math.hypot(e.x, e.y, e.z) / e.n || 1;
    return (e.x * dx + e.y * dy + e.z * dz) / e.n / d / m;
  }

  next(obs, t) {
    const pos = positionOf(obs.state);
    const key = this.keyOf(obs);
    const c = this.cell(key, pos);
    c.visits++;
    this.lastKey = key;
    const mode = modeOf(obs.state);
    if (pos && this.grid) this.places.add(this.place(mode, pos));
    const fresh = (a) => this.open(c, a, t, mode);
    const target = this.goal ? targetOf(obs.state, pos) : null;
    if (this.goal && isLost(obs.state)) {
      const restart = this.actions.find((a) => a.keys.length === 1 && MENU.includes(a.keys[0]) && fresh(a));
      if (restart) return restart;
    }
    if (target && pos) {
      // Getting no closer for plateauMs: explore for a while, for novelty alone (the target can mislead).
      const tk = `${Math.round(target.x)},${Math.round(target.y)},${Math.round(target.z)}`;
      const d = dist(pos, target);
      if (!this.best || this.best.tk !== tk) this.best = { tk, d, t };
      else if (d < this.best.d - 0.25 * (this.grid ?? 1)) { this.best.d = d; this.best.t = t; }
      if (t - this.best.t > this.plateauMs) { this.greedyOffUntil = t + this.exploreMs; this.best.t = t + this.exploreMs; }
    }
    const exploring = t < (this.greedyOffUntil ?? 0);
    if (target && pos && !exploring) {
      // Pulled toward the target: the input that moved the player that way, while it helps here.
      const ranked = this.actions.filter((a) => a.keys.length).map((a) => ({ a, s: this.score(a, pos, target) })).filter((x) => x.s > 0.35).sort((x, y) => y.s - x.s);
      for (const { a } of ranked.slice(0, 3)) {
        const e = c.tried.get(a.id);
        if (!e || e.n < 2 || e.gain / e.n > 0.2 * (this.grid ?? 1)) return a;
      }
    }
    const untried = this.actions.filter(fresh);
    if (untried.length) {
      if (target && pos && !exploring) return untried.reduce((best, a) => (this.score(a, pos, target) > this.score(best, pos, target) ? a : best));
      // Long moves first: they find new places sooner.
      const longest = Math.max(...untried.map((a) => a.hold ?? 1));
      const pick = untried.filter((a) => (a.hold ?? 1) === longest);
      return pick[Math.floor(this.random() * pick.length)];
    }
    const step = this.towardFrontier(key, t, exploring ? null : target);
    if (step) return step;
    let best = null, n = Infinity;
    for (const a of this.actions) { const k = (c.tried.get(a.id)?.n ?? 0) + this.random(); if (k < n) { n = k; best = a; } }
    return best;
  }

  /** The first input on the shortest known way to a cell with inputs left to try (near the target, for goal). */
  towardFrontier(start, t, target) {
    const seen = new Map([[start, null]]);
    const queue = [start];
    let bestKey = null, bestScore = Infinity;
    for (let qi = 0; qi < queue.length && qi < 4000; qi++) {
      const k = queue[qi];
      const c = this.cells.get(k);
      if (!c) continue;
      const depth = depthOf(seen, k);
      if (k !== start && this.actions.some((a) => this.open(c, a, t, k.split('|')[0]))) {
        const s = depth + (target && c.pos ? dist(c.pos, target) / (this.grid ?? 1) : 0);
        if (s < bestScore) { bestScore = s; bestKey = k; }
        if (!target) break;
      }
      for (const [id, e] of c.tried) {
        let to = null, most = 0;
        // The usual outcome; an input that mostly goes nowhere from here is no way out.
        for (const [tk, cnt] of e.to) if (cnt > most) { most = cnt; to = tk; }
        if (to && to !== k && !seen.has(to)) { seen.set(to, { from: k, action: id }); queue.push(to); }
      }
    }
    if (!bestKey) return null;
    let k = bestKey, first = null;
    while (seen.get(k)) { first = seen.get(k).action; k = seen.get(k).from; }
    return first === null ? null : this.actions[first];
  }

  learn(before, a, after, t) {
    const p0 = positionOf(before.state), p1 = positionOf(after.state);
    const fromKey = this.keyOf(before);
    if (p0 && p1 && modeOf(before.state) === modeOf(after.state)) {
      // What an input does when it does something (a wall in the way says nothing about it).
      const m = dist(p0, p1);
      const e = this.effects[a.id];
      if (m > 1e-3) { e.x += p1.x - p0.x; e.y += p1.y - p0.y; e.z += p1.z - p0.z; e.n++; }
      // Cells about two short moves wide: small enough to tell places apart, big enough that
      // a short move from one cell lands in the next one.
      if (m > 1e-3 && !this.grid) {
        this.moves.push(m / (a.hold ?? 1));
        if (this.moves.length >= 6) {
          const s = [...this.moves].sort((x, y) => x - y);
          this.grid = s[Math.floor(s.length / 2)] * this.gridScale;
          this.cells = new Map();
          this.places = new Set();
          return;
        }
      }
    }
    const c = this.cell(fromKey, p0);
    const e = c.tried.get(a.id) ?? { n: 0, gain: 0, to: new Map(), lastT: 0 };
    e.n++;
    e.lastT = t;
    const toKey = this.keyOf(after);
    e.to.set(toKey, (e.to.get(toKey) ?? 0) + 1);
    const target = this.goal ? targetOf(before.state, p0) : null;
    if (target && p0 && p1) e.gain += dist(p0, target) - dist(p1, target);
    c.tried.set(a.id, e);
    this.cell(toKey, p1);
    // Blocked: where the input would have gone is known now (a wall), for every cell that would try it.
    const f = this.effects[a.id];
    if (p0 && p1 && this.grid && f.n && dist(p0, p1) < this.grid * 0.25) {
      this.places.add(this.place(modeOf(before.state), { x: p0.x + f.x / f.n, y: p0.y + f.y / f.n, z: p0.z + f.z / f.n }));
    }
  }
}

const depthOf = (seen, k) => { let d = 0; while (seen.get(k)) { d++; k = seen.get(k).from; } return d; };

/**
 * Runs a bot on a session for `seconds` of game time. Returns the run: events, frames (evidence
 * and a frame every frameEveryMs), stuck and softlock moments, errors, coverage, the final state.
 */
export async function runBot(session, opts = {}) {
  const mode = BOT_MODES.includes(opts.mode) ? opts.mode : 'explore';
  const seconds = Math.min(Math.max(Number(opts.seconds) || 30, 1), 900);
  const macroMs = Math.min(Math.max(Number(opts.macroMs) || 150, 20), 2000);
  const random = rng(Number(opts.seed) || 1);
  const frameWidth = opts.frameWidth ?? 480;
  const frameEveryMs = opts.frameEveryMs ?? 1000;
  const maxFrames = opts.maxFrames ?? 80;
  const stopOnGoal = opts.stopOnGoal !== false;
  const stopOnSoftlock = opts.stopOnSoftlock !== false;
  const wallMs = opts.wallMs ?? 5 * 60_000;
  const wallEnd = Date.now() + wallMs;
  const run = { mode, events: [], frames: [], steps: 0, errors: [], crashed: false, goalReached: false, stuck: [], softlocks: [], startT: session.t };

  const frame = async (label, obs) => {
    if (run.frames.length >= maxFrames) return null;
    const o = obs?.frame ? obs : await session.observe({ frame: true, width: frameWidth });
    if (!o.frame) return null;
    const f = { t: o.t, label, png: o.frame.png, img: o.frame.img, stats: o.frame.stats };
    run.frames.push(f);
    return f;
  };
  const addEvent = async (e, evidence = true) => {
    run.events.push(e);
    if (evidence && NOTABLE.has(e.type)) { const f = await frame(`${e.type}: ${e.detail}`.slice(0, 80)); if (f) e.frame = run.frames.length - 1; }
  };

  let obs = await session.observe({ frame: true, width: frameWidth });
  await frame('start', obs);
  run.samples = [sample(obs.t, obs.state, run)];
  const info = session.info;
  const actions = actionSpace(info);
  const explorer = mode === 'explore' || mode === 'goal' ? new Explorer(actions, random, { goal: mode === 'goal' }) : null;
  // A replay presses what was recorded: there, a softlock is nothing changing for softlockS.
  const stuck = new StuckDetector({ stuckS: opts.stuckS ?? 3, softlockS: opts.softlockS ?? 8, actionCount: mode === 'scripted' ? 0 : actions.length });
  const end = session.t + seconds * 1000;
  let nextFrameAt = session.t + frameEveryMs;
  let stillSince = session.t;
  let escape = [];
  const visited = new Set();

  // Scripted: the recording's events go in at their times; the bot only watches.
  let script = null;
  if (mode === 'scripted') {
    const rec = opts.recording;
    if (rec?.events?.length && session.inject) { session.inject(rec.events); script = { until: Math.max(rec.durationMs ?? 0, ...rec.events.map((e) => e.t)) }; }
    else script = { steps: (rec?.steps ?? opts.steps ?? []).slice() };
  }
  // A replay runs to where the recording ended, so it ends in the same state.
  const scriptedEnd = script?.until !== undefined ? Math.min(end, script.until) : end;

  while (session.t < (script?.until !== undefined ? scriptedEnd : end) - 8 && Date.now() < wallEnd && !opts.signal?.aborted) {
    let a = null;
    let inputs = [];
    let ms = macroMs;
    if (mode === 'scripted') {
      if (script.steps) {
        const s = script.steps.shift();
        if (!s) break;
        inputs = s.inputs ?? (s.key ? [s] : []);
        ms = Number(s.ms ?? s.wait) || macroMs;
      } else ms = Math.min(macroMs, Math.max(17, scriptedEnd - session.t));
    } else if (session.t - stillSince > 1000) {
      // Nothing changes: try every input once, in a random order, before anything else.
      if (!escape.length) escape = [...actions].sort(() => random() - 0.5);
      a = escape.shift();
      inputs = inputsOf(a, macroMs);
      ms = lengthOf(a, macroMs);
    } else if (mode === 'random') {
      a = actions[Math.floor(random() * actions.length)];
      ms = Math.round(macroMs * (0.5 + random() * 2.5));
      inputs = inputsOf(a, ms);
    } else if (mode === 'monkey') {
      const keys = [...new Set([...(info.inputs ?? DEFAULT_KEYS), ...MENU])];
      ms = 100;
      for (let i = 0, n = 2 + Math.floor(random() * 5); i < n; i++) inputs.push({ key: keys[Math.floor(random() * keys.length)], ms: 16 + Math.floor(random() * 60), at: Math.floor(random() * 80) });
      if (random() < 0.3 && obs.frame) inputs.push({ mouse: [Math.floor(random() * obs.frame.width), Math.floor(random() * obs.frame.height)], click: true, at: Math.floor(random() * 80) });
    } else {
      a = explorer.next(obs, session.t);
      inputs = inputsOf(a, macroMs);
      ms = lengthOf(a, macroMs);
    }
    const before = obs;
    obs = await session.step(inputs, ms, { frame: false });
    run.steps++;
    if (explorer && a && mode !== 'scripted') explorer.learn(before, a, obs, session.t);
    const pos = positionOf(obs.state);
    const g = explorer?.grid ?? 16;
    visited.add(pos ? `${modeOf(obs.state)}|${Math.floor(pos.x / g)},${Math.floor(pos.y / g)},${Math.floor(pos.z / g)}` : `${modeOf(obs.state)}|${obs.hash ?? ''}`);

    // The game's own events first; a change of state says the same thing less well.
    const own = obs.events ?? [];
    for (const e of own) await addEvent({ ...e, source: 'game' });
    for (const e of stateEvents(before.state, obs.state, obs.t)) if (!own.some((x) => x.type === e.type)) await addEvent(e, e.type !== 'state' && e.type !== 'score');
    for (const err of obs.errors ?? []) { run.errors.push(err); await addEvent({ t: sec(obs.t), type: 'error', detail: err.split('\n')[0].slice(0, 200) }); }
    if (obs.crashed || (obs.loopStopped && run.errors.length)) {
      run.crashed = true;
      await addEvent({ t: sec(obs.t), type: 'crash', detail: obs.crashed ? 'the page crashed' : `the game loop stopped after an uncaught error: ${run.errors[0].split('\n')[0].slice(0, 160)}` });
      break;
    }
    if (obs.loopStopped && !run.events.some((e) => e.type === 'loop-stopped')) await addEvent({ t: sec(obs.t), type: 'loop-stopped', detail: 'the game stopped asking for frames' });

    if (run.samples.length < 6000) run.samples.push(sample(obs.t, obs.state, run));
    const sig = signature(obs);
    const changes = stuck.update(obs.t, sig, a?.id ?? JSON.stringify(inputs));
    if (stuck.anchor === sig) { stillSince = session.t; escape = []; }
    for (const e of changes) {
      if (e.type === 'stuck') run.stuck.push({ t: e.t, detail: e.detail, pos: sig.pos });
      if (e.type === 'softlock') run.softlocks.push({ t: e.t, detail: e.detail, pos: sig.pos });
      await addEvent(e);
    }
    if (isWon(obs.state) && !run.goalReached) {
      run.goalReached = true;
      if (!run.events.some((e) => e.type === 'goal')) await addEvent({ t: sec(obs.t), type: 'goal', detail: 'the game says the goal is reached' });
      if (stopOnGoal && mode !== 'scripted') break;
    }
    if (run.softlocks.length && stopOnSoftlock && mode !== 'scripted') break;
    if (session.t >= nextFrameAt) { await frame(`t=${(session.t / 1000).toFixed(1)}s`); nextFrameAt = session.t + frameEveryMs; }
  }
  const last = await session.observe({ frame: true, width: frameWidth });
  for (const err of last.errors ?? []) { run.errors.push(err); run.events.push({ t: sec(last.t), type: 'error', detail: err.split('\n')[0].slice(0, 200) }); }
  await frame('end', last);
  run.final = last.state;
  run.samples.push(sample(last.t, last.state, run));
  run.durationS = Math.round(session.t - run.startT) / 1000;
  run.coverage = { cells: visited.size, grid: explorer?.grid ? Math.round(explorer.grid * 100) / 100 : null };
  run.timedOut = Date.now() >= wallEnd;
  return run;
}
