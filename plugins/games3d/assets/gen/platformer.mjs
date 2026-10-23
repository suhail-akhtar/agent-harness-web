// Side-scrolling platformer levels that can be finished: a generator that builds from the
// player's physics (jump height, run speed, gravity), and a solver that proves it by
// simulating the jumps, falls and walks a player can make (a search over standing places).
//
// Grid characters (row 0 is the top):
//   '#' solid ground   'X' solid block   '-' one-way platform (land on it from above)
//   '^' spikes (deadly)   'S' start   'E' exit   'o' coin   'e' enemy spawn (the solver ignores enemies)

import { rng } from '../util/rng.mjs';

export const LEGEND = { '#': 'ground', X: 'block', '-': 'one-way platform', '^': 'spikes', S: 'start', E: 'exit', o: 'coin', e: 'enemy', '.': 'air' };

/** The physics the generator and the solver share, in tiles and seconds. */
export function physicsOf(p = {}) {
  const jumpHeight = Number(p.jumpHeight ?? 3.2), runSpeed = Number(p.runSpeed ?? 6), gravity = Number(p.gravity ?? 40);
  const playerWidth = Number(p.playerWidth ?? 0.8), playerHeight = Number(p.playerHeight ?? 1.8);
  const v0 = Math.sqrt(2 * gravity * jumpHeight);
  return { jumpHeight, runSpeed, gravity, playerWidth, playerHeight, v0, airTime: (2 * v0) / gravity, jumpDistance: runSpeed * ((2 * v0) / gravity) };
}

const SOLID = new Set(['#', 'X']);

/**
 * Whether the level can be finished from S to E with these physics, the moves of one way
 * through, and how many coins a player can reach. Exhaustive over standing places: every
 * walk, every jump at seven horizontal speeds from three spots on a tile, and every fall.
 */
export function solvePlatformer(rows, physics = {}, { maxStates = 200000 } = {}) {
  const P = physicsOf(physics);
  const H = rows.length, W = Math.max(...rows.map((r) => r.length));
  const at = (x, y) => (y < 0 ? '.' : y >= H || x < 0 || x >= W ? '#' : rows[y][x] ?? '.');
  const solid = (x, y) => (x < 0 || x >= W ? true : y < 0 ? false : y >= H ? false : SOLID.has(at(x, y)));
  const find = (ch) => { for (let y = 0; y < H; y++) { const x = rows[y].indexOf(ch); if (x >= 0) return [x, y]; } return null; };
  const start = find('S'), exit = find('E');
  if (!start || !exit) return { ok: false, reason: `no ${start ? 'exit (E)' : 'start (S)'} in the level` };
  const coins = [];
  rows.forEach((r, y) => [...r].forEach((c, x) => { if (c === 'o') coins.push(`${x},${y}`); }));
  const hw = P.playerWidth / 2;

  // The box overlaps a solid tile: left, right, top and bottom in tile units (y down).
  const boxHits = (x, feet, test) => {
    const x0 = Math.floor(x - hw + 1e-6), x1 = Math.floor(x + hw - 1e-6), y0 = Math.floor(feet - P.playerHeight + 1e-6), y1 = Math.floor(feet - 1e-6);
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) if (test(tx, ty)) return [tx, ty];
    return null;
  };
  const supported = (x, feet) => {
    const ty = Math.round(feet);
    if (Math.abs(feet - ty) > 1e-6) return false;
    for (let tx = Math.floor(x - hw + 1e-6); tx <= Math.floor(x + hw - 1e-6); tx++) if (solid(tx, ty) || at(tx, ty) === '-') return true;
    return false;
  };
  const deadly = (x, feet) => !!boxHits(x, feet, (tx, ty) => at(tx, ty) === '^' && feet > ty + 0.45);
  const touches = (x, feet, ch) => boxHits(x, feet, (tx, ty) => at(tx, ty) === ch);

  /** Flies from (x, feet) with velocities until landing: the landing place, or null (death). */
  const fly = (x, feet, vx, vy, seen) => {
    const dt = 1 / 120;
    let won = false;
    for (let step = 0; step < 120 * 6; step++) {
      // Horizontal: blocked by walls (the player slides down them).
      if (vx) {
        const nx = x + vx * dt;
        if (nx - hw < 0 || nx + hw > W || boxHits(nx, feet, solid)) vx = 0; else x = nx;
      }
      vy += P.gravity * dt;
      const nf = feet + vy * dt;
      if (vy < 0) {
        const hit = boxHits(x, nf, solid);
        if (hit) { feet = hit[1] + 1 + P.playerHeight; vy = 0; } else feet = nf;
      } else {
        // Landing: the feet reach the top of a solid tile or a one-way platform (rows between the old and new feet).
        let landed = null;
        for (let ty = Math.ceil(feet - 1e-9); ty <= Math.floor(nf) && landed === null; ty++) {
          for (let tx = Math.floor(x - hw + 1e-6); tx <= Math.floor(x + hw - 1e-6); tx++) if (solid(tx, ty) || at(tx, ty) === '-') { landed = ty; break; }
        }
        if (landed !== null) {
          feet = landed;
          if (deadly(x, feet)) return null;
          seen?.(x, feet);
          if (touches(x, feet, 'E')) won = true;
          return { x, feet, won };
        }
        feet = nf;
      }
      if (feet - P.playerHeight > H + 1) return null;
      if (deadly(x, feet)) return null;
      seen?.(x, feet);
      if (touches(x, feet, 'E')) won = true;
      if (won) return { x, feet, won };
    }
    return null;
  };

  const key = (x, feet) => `${Math.floor(x)},${Math.round(feet)}`;
  const startX = start[0] + 0.5;
  let startFeet = start[1] + 1;
  for (let y = start[1] + 1; y < H && !solid(start[0], y) && at(start[0], y) !== '-'; y++) startFeet = y + 1;
  const q = [{ x: startX, feet: startFeet, prev: null, move: 'start' }];
  const seenStates = new Map([[key(startX, startFeet), q[0]]]);
  const reached = new Set();
  const markCoins = (x, feet) => { const hit = boxHits(x, feet, (tx, ty) => at(tx, ty) === 'o'); if (hit) reached.add(`${hit[0]},${hit[1]}`); };
  let goal = null;
  const push = (from, x, feet, move) => {
    const k = key(x, feet);
    if (seenStates.has(k)) return null;
    const s = { x: Math.floor(x) + 0.5, feet, prev: from, move };
    // A landing off-centre stands where it landed when the tile's centre is not supported.
    if (!supported(s.x, feet) || boxHits(s.x, feet, solid)) s.x = x;
    seenStates.set(k, s);
    q.push(s);
    return s;
  };
  for (let qi = 0; qi < q.length && !goal; qi++) {
    if (seenStates.size > maxStates) break;
    const s = q[qi];
    markCoins(s.x, s.feet);
    if (touches(s.x, s.feet, 'E')) { goal = s; break; }
    // Walks one tile either way (or off a ledge into a fall).
    for (const dir of [-1, 1]) {
      const nx = Math.floor(s.x) + 0.5 + dir;
      if (nx - hw < 0 || nx + hw > W || boxHits(nx, s.feet, solid)) continue;
      if (deadly(nx, s.feet)) continue;
      if (supported(nx, s.feet)) push(s, nx, s.feet, `walk ${dir < 0 ? 'left' : 'right'}`);
      else {
        // Off the ledge: from where the box has just left the tile it stood on.
        const ex = dir > 0 ? Math.floor(s.x) + 1 + hw + 0.01 : Math.floor(s.x) - hw - 0.01;
        const land = fly(ex, s.feet, dir * P.runSpeed, 0, markCoins);
        if (land) { const n = push(s, land.x, land.feet, `fall ${dir < 0 ? 'left' : 'right'}`); if (land.won) goal = n ?? seenStates.get(key(land.x, land.feet)); }
      }
    }
    if (goal) break;
    // Jumps: seven horizontal speeds, from the middle and both edges of the tile.
    for (const off of [0, -0.45 + hw, 0.45 - hw]) {
      const sx = Math.floor(s.x) + 0.5 + off;
      if (!supported(sx, s.feet) || boxHits(sx, s.feet, solid)) continue;
      for (const f of [-1, -2 / 3, -1 / 3, 0, 1 / 3, 2 / 3, 1]) {
        const land = fly(sx, s.feet, f * P.runSpeed, -P.v0, markCoins);
        if (!land) continue;
        const n = push(s, land.x, land.feet, `jump ${f < 0 ? 'left' : f > 0 ? 'right' : 'up'}${f && Math.abs(f) < 1 ? ` at ${Math.round(Math.abs(f) * 100)}% speed` : ''}`);
        if (land.won) { goal = n ?? seenStates.get(key(land.x, land.feet)); break; }
      }
      if (goal) break;
    }
  }
  const coinsReached = coins.filter((c) => reached.has(c)).length;
  if (!goal) return { ok: false, reason: 'the exit cannot be reached with these physics', states: seenStates.size, coins: coins.length, coinsReached, physics: P };
  const moves = [];
  for (let s = goal; s; s = s.prev) moves.push({ move: s.move, x: Math.round(s.x * 10) / 10, y: Math.round(s.feet - 1) });
  moves.reverse();
  return { ok: true, moves, steps: moves.length - 1, states: seenStates.size, coins: coins.length, coinsReached, physics: P };
}

/**
 * A level of about `length` columns built segment by segment within what the physics allow
 * (gaps, steps, platforms over pits, spikes, pillars), then proven by the solver; a level
 * the solver cannot finish is made again from the next seed (and gentler, after five).
 */
export function platformer({ length = 120, height = 18, seed = 0, difficulty = 0.5, physics = {}, coins = true, enemies = true } = {}) {
  const P = physicsOf(physics);
  for (let attempt = 0; attempt < 12; attempt++) {
    const d = attempt < 5 ? difficulty : Math.max(0, difficulty - 0.1 * (attempt - 4));
    const level = buildPlatformer({ length, height, seed: attempt ? `${seed}#${attempt}` : seed, difficulty: d, P, coins, enemies });
    const proof = solvePlatformer(level.rows, physics);
    if (proof.ok) return { type: 'platformer', width: level.rows[0].length, height, rows: level.rows, start: level.start, exit: level.exit, physics: P, proof, legend: LEGEND, seed, attempts: attempt + 1, difficulty: d };
  }
  throw new Error('could not make a finishable level with these physics: raise jumpHeight or runSpeed');
}

function buildPlatformer({ length, height, seed, difficulty, P, coins, enemies }) {
  const r = rng(seed);
  const g = Array.from({ length: height }, () => []);
  const maxUp = Math.max(1, Math.floor(P.jumpHeight - 0.7));
  const maxGap = Math.max(1, Math.floor(P.jumpDistance * (0.42 + 0.3 * difficulty) - P.playerWidth));
  const minGround = 4, maxGround = height - 3;
  let ground = height - 4;
  let x = 0;
  const column = (gh, fill = '#') => { for (let y = 0; y < height; y++) g[y][x] = y >= gh ? fill : '.'; x++; };
  const put = (cx, cy, ch) => { if (cy >= 0 && cy < height && g[cy][cx] === '.') g[cy][cx] = ch; };
  // A safe start.
  for (let i = 0; i < 5; i++) column(ground);
  const start = [2, ground - 1];
  g[ground - 1][2] = 'S';
  const kinds = ['flat', 'gap', 'up', 'down', 'platforms', 'spikes', 'pillar', 'gap', 'platforms'];
  while (x < length - 8) {
    const kind = r.pick(kinds);
    if (kind === 'flat') {
      const n = r.int(3, 7);
      for (let i = 0; i < n; i++) column(ground);
      if (enemies && n >= 5 && r.chance(0.5 + difficulty * 0.3)) put(x - 2, ground - 1, 'e');
      if (coins && r.chance(0.5)) for (let i = 1; i < n - 1; i++) put(x - n + i, ground - 2, 'o');
    } else if (kind === 'gap') {
      const n = r.int(Math.max(1, maxGap - 2), maxGap);
      const landing = Math.min(maxGround, Math.max(minGround, ground + r.int(-1, 1)));
      // Up and across at once asks for less distance.
      const w = landing < ground ? Math.max(1, n - 1) : n;
      for (let i = 0; i < w; i++) column(height + 1);
      if (coins) for (let i = 0; i < w; i++) put(x - w + i, Math.max(1, Math.min(ground, landing) - 2 - (i > 0 && i < w - 1 ? 1 : 0)), 'o');
      ground = landing;
      for (let i = 0; i < 3; i++) column(ground);
    } else if (kind === 'up') {
      ground = Math.max(minGround, ground - r.int(1, maxUp));
      for (let i = 0, n = r.int(3, 5); i < n; i++) column(ground);
    } else if (kind === 'down') {
      ground = Math.min(maxGround, ground + r.int(1, 3));
      for (let i = 0, n = r.int(3, 5); i < n; i++) column(ground);
    } else if (kind === 'platforms') {
      // Floating platforms over a pit, each within a jump of the last.
      let py = ground;
      const count = r.int(2, 3 + Math.round(difficulty * 2));
      const pitDepth = height + 1;
      for (let p = 0; p < count; p++) {
        const gap = r.int(Math.max(1, maxGap - 3), Math.max(1, maxGap - 1));
        for (let i = 0; i < gap; i++) column(pitDepth);
        py = Math.max(minGround, Math.min(ground + 1, py + r.int(-maxUp, 1)));
        const len = r.int(3, 5);
        const oneWay = r.chance(0.4);
        for (let i = 0; i < len; i++) {
          for (let y = 0; y < height; y++) g[y][x] = y === py ? (oneWay ? '-' : 'X') : '.';
          if (coins && i === 1) put(x, py - 1, 'o');
          x++;
        }
      }
      const gap = r.int(1, Math.max(1, maxGap - 1));
      for (let i = 0; i < gap; i++) column(pitDepth);
      ground = Math.max(minGround, Math.min(maxGround, py + r.int(0, 1)));
      for (let i = 0; i < 3; i++) column(ground);
    } else if (kind === 'spikes') {
      const n = r.int(1, Math.max(1, Math.min(3, maxGap - 1)));
      for (let i = 0; i < 2; i++) column(ground);
      for (let i = 0; i < n; i++) { column(ground); g[ground - 1][x - 1] = '^'; }
      for (let i = 0; i < 3; i++) column(ground);
      if (coins) put(x - 3 - Math.ceil(n / 2), Math.max(1, ground - 1 - maxUp), 'o');
    } else if (kind === 'pillar') {
      const hgt = r.int(1, maxUp);
      for (let i = 0; i < 2; i++) column(ground);
      column(Math.max(minGround - 2, ground - hgt), 'X');
      for (let y = ground; y < height; y++) g[y][x - 1] = '#';
      for (let i = 0; i < 3; i++) column(ground);
    }
  }
  for (let i = 0; i < 8; i++) column(ground);
  const exit = [x - 3, ground - 1];
  g[ground - 1][x - 3] = 'E';
  const rows = g.map((row) => row.join(''));
  return { rows, start, exit };
}
