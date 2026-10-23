// Side-on platformer physics in tile units, the same model studio_procgen's level solver proves
// levels with (jump height in tiles, run speed in tiles/s, gravity in tiles/s^2): a level the
// solver finishes is one this player can finish. Shared by the 2D platformer and the 2.5D
// side-scroller. Rows use the platformer legend: # ground, X block, - one-way platform,
// ^ spikes, S start, E exit, o coin, e enemy, . air (G is drawn ground with grass).

export const SOLID = new Set(['#', 'X', 'G']);

/** The physics from a level's (or the config's) numbers, with the solver's defaults. */
export function physicsOf(p = {}) {
  const jumpHeight = Number(p.jumpHeight ?? 3.2), runSpeed = Number(p.runSpeed ?? 6), gravity = Number(p.gravity ?? 40);
  return { jumpHeight, runSpeed, gravity, playerWidth: Number(p.playerWidth ?? 0.8), playerHeight: Number(p.playerHeight ?? 1.8), v0: Math.sqrt(2 * gravity * jumpHeight) };
}

export class PlatformWorld {
  constructor(rows, physics) {
    this.rows = rows.map((r) => [...r]);
    this.H = this.rows.length;
    this.W = Math.max(...this.rows.map((r) => r.length));
    this.p = physicsOf(physics);
  }
  at(x, y) { return y < 0 || y >= this.H ? '.' : x < 0 || x >= this.W ? '#' : this.rows[y][x] ?? '.'; }
  solid(x, y) { return y >= 0 && SOLID.has(this.at(x, y)); }
  /** Cells of a character (and clears them to air: they become entities). */
  take(ch) {
    const out = [];
    this.rows.forEach((r, y) => r.forEach((c, x) => { if (c === ch) { out.push({ x, y }); r[x] = '.'; } }));
    return out;
  }
}

/** A body: x is its centre, y its feet (tile units, y down). */
export class Body {
  constructor(x, y, w = 0.8, h = 1.8) { Object.assign(this, { x, y, w, h, vx: 0, vy: 0, ground: false, coyote: 0, buffer: 0, facing: 1 }); }
  get left() { return this.x - this.w / 2; }
  get right() { return this.x + this.w / 2; }
  get top() { return this.y - this.h; }
  overlaps(o) { return this.left < o.right && this.right > o.left && this.top < o.y && this.y > o.top; }
}

const EPS = 1e-4;

/**
 * One fixed step of a body: dir -1/0/1, jump (pressed this step), jumpHeld. Returns what happened:
 * { jumped, landed, bumped }. Coyote time (0.1 s) and a jump buffer (0.1 s) make it forgiving.
 */
export function stepBody(world, b, { dir = 0, jump = false, jumpHeld = false, dt = 1 / 60, speed } = {}) {
  const P = world.p;
  const out = { jumped: false, landed: false, bumped: false };
  b.vx = dir * (speed ?? P.runSpeed);
  if (dir) b.facing = dir;
  b.coyote = b.ground ? 0.1 : Math.max(0, b.coyote - dt);
  b.buffer = jump ? 0.1 : Math.max(0, b.buffer - dt);
  if (b.buffer > 0 && (b.ground || b.coyote > 0)) { b.vy = -P.v0; b.ground = false; b.coyote = 0; b.buffer = 0; out.jumped = true; }
  // A short hop when the jump is let go early.
  if (!jumpHeld && b.vy < -P.v0 * 0.45 && b.jumpCut) b.vy = -P.v0 * 0.45;
  b.vy = Math.min(b.vy + P.gravity * dt, 30);
  // Horizontal.
  b.x += b.vx * dt;
  const y0 = Math.floor(b.top + EPS), y1 = Math.floor(b.y - EPS);
  if (b.vx > 0) { const tx = Math.floor(b.right); for (let y = y0; y <= y1; y++) if (world.solid(tx, y)) { b.x = tx - b.w / 2 - EPS; b.vx = 0; break; } }
  else if (b.vx < 0) { const tx = Math.floor(b.left); for (let y = y0; y <= y1; y++) if (world.solid(tx, y)) { b.x = tx + 1 + b.w / 2 + EPS; b.vx = 0; break; } }
  // Vertical.
  const feet = b.y;
  b.y += b.vy * dt;
  const x0 = Math.floor(b.left + EPS), x1 = Math.floor(b.right - EPS);
  const wasGround = b.ground;
  b.ground = false;
  if (b.vy >= 0) {
    for (let ty = Math.floor(feet); ty <= Math.floor(b.y); ty++) {
      let hit = false;
      for (let x = x0; x <= x1; x++) if (world.solid(x, ty) || (world.at(x, ty) === '-' && feet <= ty + EPS)) hit = true;
      if (hit && b.y >= ty) { b.y = ty; b.vy = 0; b.ground = true; break; }
    }
  } else {
    const ty = Math.floor(b.top);
    for (let x = x0; x <= x1; x++) if (world.solid(x, ty)) { b.y = ty + 1 + b.h; b.vy = 0; out.bumped = true; break; }
  }
  if (b.ground && !wasGround) out.landed = true;
  return out;
}

/** Whether the body touches spikes (the lower half of a ^ cell) or fell out of the level. */
export function hazard(world, b) {
  if (b.top > world.H + 1) return 'fell';
  for (let y = Math.floor(b.top); y <= Math.floor(b.y - EPS); y++) {
    for (let x = Math.floor(b.left + 0.1); x <= Math.floor(b.right - 0.1); x++) if (world.at(x, y) === '^' && b.y > y + 0.45) return 'spikes';
  }
  return null;
}

/** A walking enemy: back and forth on its platform, turning at walls and ledges. */
export function stepWalker(world, e, dt, speed = 1.6) {
  if (!e.dir) e.dir = -1;
  const ahead = Math.floor(e.x + e.dir * (e.w / 2 + 0.05));
  const row = Math.floor(e.y - 0.5);
  if (world.solid(ahead, row) || !world.solid(ahead, Math.floor(e.y + 0.05))) e.dir = -e.dir;
  stepBody(world, e, { dir: e.dir, dt, speed });
}

/**
 * The solver's route through a level (level.json proof.moves: where the player stands after
 * each walk, jump or fall), for "where to head next": the next standing place along it, until
 * the objective (a coin, the exit) is the nearer thing to head for.
 */
export class Route {
  constructor(moves) {
    // A move's y is the row the player stands in: its feet are on the row below.
    this.points = (Array.isArray(moves) ? moves : []).filter((m) => Number.isFinite(m?.x) && Number.isFinite(m?.y)).map((m) => ({ x: m.x, y: m.y + 1 }));
    this.at = 0;
  }

  /**
   * Where along the route the player stands (forward or, after a respawn, back): the furthest
   * route point it is standing on. Returns that point when it is a new one (a safe checkpoint).
   */
  update(body) {
    if (!body.ground) return null;
    let hit = -1;
    this.points.forEach((p, i) => { if (Math.abs(body.x - p.x) < 0.7 && Math.abs(body.y - p.y) < 0.6) hit = i; });
    if (hit < 0 || hit === this.at) return null;
    this.at = hit;
    return this.points[hit];
  }

  /** The next standing place on the way to the objective, or the objective once it is the nearer. */
  next(body, objective) {
    const p = this.points[this.at + 1];
    if (!p || !objective) return objective;
    const ahead = Math.sign(objective.x - body.x) === Math.sign(p.x - body.x) && Math.abs(p.x - body.x) < Math.abs(objective.x - body.x);
    return ahead ? p : objective;
  }
}
