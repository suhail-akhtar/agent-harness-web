// Grid levels: rows of characters (studio_procgen dungeons, caves, mazes and maps, or hand-made),
// walls, shortest paths, and the waypoint the hook offers as "where to head next".

/** A grid over rows: at(x, y), passable(x, y) by a set of wall characters. */
export class Grid {
  constructor(rows, walls = ['#']) {
    this.rows = rows.map((r) => [...r]);
    this.H = this.rows.length;
    this.W = Math.max(...this.rows.map((r) => r.length));
    this.walls = new Set(walls);
  }
  at(x, y) { return x < 0 || y < 0 || x >= this.W || y >= this.H ? '#' : this.rows[y][x] ?? '#'; }
  set(x, y, c) { if (this.rows[y]) this.rows[y][x] = c; }
  wall(x, y) { return this.walls.has(this.at(x, y)); }
  /** The cells of a character, cleared to `floor` (they become entities). */
  take(ch, floor = '.') {
    const out = [];
    this.rows.forEach((r, y) => r.forEach((c, x) => { if (c === ch) { out.push({ x, y }); r[x] = floor; } }));
    return out;
  }

  /** The shortest 4-way path from a cell to the nearest goal cell: [[x, y], ...] (start included), or null. */
  path(from, goals, blocked = (x, y) => this.wall(x, y)) {
    if (!goals.length) return null;
    const W = this.W, key = (x, y) => y * W + x;
    const want = new Set(goals.map((g) => key(g.x, g.y)));
    const prev = new Map([[key(from.x, from.y), -1]]);
    const q = [[from.x, from.y]];
    for (let i = 0; i < q.length; i++) {
      const [x, y] = q[i];
      if (want.has(key(x, y))) {
        const out = [];
        for (let k = key(x, y); k !== -1; k = prev.get(k)) out.push([k % W, Math.floor(k / W)]);
        return out.reverse();
      }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy, k = key(nx, ny);
        if (nx < 0 || ny < 0 || nx >= W || ny >= this.H || prev.has(k) || (blocked(nx, ny) && !want.has(k))) continue;
        prev.set(k, key(x, y));
        q.push([nx, ny]);
      }
    }
    return null;
  }
}

/** Every cell reachable from a cell (4-way), as [{x, y, d}] with d the steps to it. */
Grid.prototype.reachable = function reachable(from, blocked = (x, y) => this.wall(x, y)) {
  const seen = new Set([`${from.x},${from.y}`]);
  const out = [{ x: from.x, y: from.y, d: 0 }];
  for (let i = 0; i < out.length; i++) {
    const { x, y, d } = out[i];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, k = `${nx},${ny}`;
      if (seen.has(k) || nx < 0 || ny < 0 || nx >= this.W || ny >= this.H || blocked(nx, ny)) continue;
      seen.add(k);
      out.push({ x: nx, y: ny, d: d + 1 });
    }
  }
  return out;
};

/**
 * Where to head next: a cell `ahead` steps along the shortest path to the nearest goal (its
 * centre), or the goal itself when it is closer. null when no goal is reachable.
 */
export function waypoint(grid, from, goals, { ahead = 3, blocked } = {}) {
  const p = grid.path({ x: Math.floor(from.x), y: Math.floor(from.y) }, goals, blocked);
  if (!p) return null;
  const [x, y] = p[Math.min(p.length - 1, ahead)];
  return { x: x + 0.5, y: y + 0.5, steps: p.length - 1, goal: { x: p.at(-1)[0] + 0.5, y: p.at(-1)[1] + 0.5 } };
}

/** Moves a circle (centre x, y, radius r, in cells) by (dx, dy) against wall cells, sliding along them. */
export function moveCircle(grid, b, dx, dy, r = 0.35, blocked = (x, y) => grid.wall(x, y)) {
  const hits = (x, y) => {
    for (let cy = Math.floor(y - r); cy <= Math.floor(y + r); cy++) for (let cx = Math.floor(x - r); cx <= Math.floor(x + r); cx++) if (blocked(cx, cy)) {
      const nx = Math.max(cx, Math.min(x, cx + 1)), ny = Math.max(cy, Math.min(y, cy + 1));
      if ((nx - x) ** 2 + (ny - y) ** 2 < r * r) return true;
    }
    return false;
  };
  if (!hits(b.x + dx, b.y)) b.x += dx;
  if (!hits(b.x, b.y + dy)) b.y += dy;
}
