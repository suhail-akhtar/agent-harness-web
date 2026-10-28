// Level generators on character grids (rows of text, one character per tile):
// BSP dungeons with corridors, cellular-automata caves, mazes (four algorithms, optional
// loops) and top-down overworld maps. Every level has a start and an exit and is checked
// to connect them; the same seed always gives the same level.

import { rng } from '../util/rng.mjs';
import { noiseField } from './noise.mjs';

export const LEGENDS = {
  dungeon: { '#': 'wall', '.': 'floor', '+': 'door', S: 'start', E: 'exit', $: 'chest', m: 'monster' },
  cave: { '#': 'rock', '.': 'floor', S: 'start', E: 'exit', $: 'treasure', m: 'monster' },
  maze: { '#': 'wall', '.': 'path', S: 'start', E: 'exit' },
  topdown: { '~': 'deep water', w: 'water', s: 'sand', g: 'grass', f: 'forest', h: 'hills', M: 'mountain', '*': 'snow', '=': 'road', T: 'town', S: 'start', E: 'exit' },
};

/** Characters a walker can stand on, per level type. */
export const PASSABLE = {
  dungeon: new Set(['.', '+', 'S', 'E', '$', 'm']),
  cave: new Set(['.', 'S', 'E', '$', 'm']),
  maze: new Set(['.', 'S', 'E']),
  topdown: new Set(['s', 'g', 'f', 'h', '=', 'T', 'S', 'E']),
};

const grid = (w, h, ch) => Array.from({ length: h }, () => Array(w).fill(ch));
const toRows = (g) => g.map((r) => r.join(''));

/** Finds a character in rows: [x, y] or null. */
export function find(rows, ch) {
  for (let y = 0; y < rows.length; y++) { const x = rows[y].indexOf(ch); if (x >= 0) return [x, y]; }
  return null;
}

/** Breadth-first distances from a cell over passable characters (4-connected). */
export function bfs(rows, start, passable) {
  const h = rows.length, w = rows[0].length;
  const dist = new Int32Array(w * h).fill(-1);
  if (!start) return { dist, w, h };
  const q = [start];
  dist[start[1] * w + start[0]] = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const [x, y] = q[qi];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || dist[ny * w + nx] >= 0 || !passable.has(rows[ny][nx])) continue;
      dist[ny * w + nx] = dist[y * w + x] + 1;
      q.push([nx, ny]);
    }
  }
  return { dist, w, h };
}

/**
 * Whether a level's start reaches its exit, and how much of the walkable area is reachable.
 * The answer the level-playable gate gives for dungeons, caves, mazes and maps.
 */
export function checkConnected(rows, type) {
  const passable = PASSABLE[type] ?? PASSABLE.dungeon;
  const start = find(rows, 'S'), exit = find(rows, 'E');
  if (!start || !exit) return { ok: false, reason: `no ${start ? 'exit (E)' : 'start (S)'} in the level` };
  const { dist, w } = bfs(rows, start, passable);
  let walk = 0, reached = 0;
  rows.forEach((r, y) => [...r].forEach((c, x) => { if (passable.has(c)) { walk++; if (dist[y * w + x] >= 0) reached++; } }));
  const d = dist[exit[1] * w + exit[0]];
  return d < 0
    ? { ok: false, reason: 'the exit cannot be reached from the start', reachable: reached / (walk || 1) }
    : { ok: true, pathLength: d, reachable: reached / (walk || 1) };
}

/** The walkable cell farthest from a cell (for placing the exit). */
function farthest(rows, from, passable) {
  const { dist, w } = bfs(rows, from, passable);
  let best = from, bd = -1;
  for (let i = 0; i < dist.length; i++) if (dist[i] > bd) { bd = dist[i]; best = [i % w, Math.floor(i / w)]; }
  return best;
}

// ---------- BSP dungeon ----------

/**
 * Rooms in a binary space partition, joined sibling to sibling by L-shaped corridors with
 * doors where corridors meet rooms; start and exit in the rooms farthest apart, chests and
 * monsters in the others.
 */
export function dungeon({ width = 48, height = 32, seed = 0, minRoom = 4, maxRoom = 10, depth = 5, chests = 3, monsters = 5 } = {}) {
  const r = rng(seed);
  const g = grid(width, height, '#');
  const rooms = [];
  const split = (x, y, w, h, d) => {
    const canH = w >= 2 * (minRoom + 2), canV = h >= 2 * (minRoom + 2);
    if (d <= 0 || (!canH && !canV)) {
      const rw = r.int(minRoom, Math.min(maxRoom, w - 2)), rh = r.int(minRoom, Math.min(maxRoom, h - 2));
      const rx = x + r.int(1, w - rw - 1), ry = y + r.int(1, h - rh - 1);
      const room = { x: rx, y: ry, w: rw, h: rh, cx: rx + (rw >> 1), cy: ry + (rh >> 1) };
      rooms.push(room);
      return room;
    }
    const horizontal = canH && (!canV || (w > h ? r.chance(0.75) : r.chance(0.25)));
    let a, b;
    if (horizontal) {
      const s = r.int(minRoom + 2, w - minRoom - 2);
      a = split(x, y, s, h, d - 1); b = split(x + s, y, w - s, h, d - 1);
    } else {
      const s = r.int(minRoom + 2, h - minRoom - 2);
      a = split(x, y, w, s, d - 1); b = split(x, y + s, w, h - s, d - 1);
    }
    corridor(a, b);
    return r.chance(0.5) ? a : b;
  };
  const carve = (x, y) => { if (x > 0 && y > 0 && x < width - 1 && y < height - 1 && g[y][x] === '#') g[y][x] = 'c'; };
  const corridor = (a, b) => {
    const [x0, y0, x1, y1] = [a.cx, a.cy, b.cx, b.cy];
    if (r.chance(0.5)) { for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) carve(x, y0); for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) carve(x1, y); }
    else { for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) carve(x0, y); for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) carve(x, y1); }
  };
  split(0, 0, width, height, depth);
  for (const rm of rooms) for (let y = rm.y; y < rm.y + rm.h; y++) for (let x = rm.x; x < rm.x + rm.w; x++) g[y][x] = '.';
  // Doors: corridor cells on a room's edge (between a room cell and a corridor cell, walls either side).
  const inRoom = (x, y) => rooms.some((rm) => x >= rm.x && x < rm.x + rm.w && y >= rm.y && y < rm.y + rm.h);
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    if (g[y][x] !== 'c') continue;
    const horiz = g[y][x - 1] === '#' && g[y][x + 1] === '#' && (inRoom(x, y - 1) || inRoom(x, y + 1));
    const vert = g[y - 1][x] === '#' && g[y + 1][x] === '#' && (inRoom(x - 1, y) || inRoom(x + 1, y));
    g[y][x] = (horiz || vert) && r.chance(0.7) ? '+' : '.';
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (g[y][x] === 'c') g[y][x] = '.';
  let rows = toRows(g);
  const pass = PASSABLE.dungeon;
  const a = farthest(rows, [rooms[0].cx, rooms[0].cy], pass);
  const b = farthest(rows, a, pass);
  const roomOf = (p) => rooms.findIndex((rm) => p[0] >= rm.x && p[0] < rm.x + rm.w && p[1] >= rm.y && p[1] < rm.y + rm.h);
  const sRoom = rooms[roomOf(a)] ?? rooms[0], eRoom = rooms[roomOf(b)] ?? rooms[rooms.length - 1];
  g[sRoom.cy][sRoom.cx] = 'S';
  g[eRoom.cy][eRoom.cx] = 'E';
  const others = rooms.filter((rm) => rm !== sRoom && rm !== eRoom);
  const place = (ch, n) => {
    for (let k = 0; k < n && others.length; k++) {
      const rm = r.pick(others);
      for (let t = 0; t < 20; t++) { const x = r.int(rm.x, rm.x + rm.w - 1), y = r.int(rm.y, rm.y + rm.h - 1); if (g[y][x] === '.') { g[y][x] = ch; break; } }
    }
  };
  place('$', chests); place('m', monsters);
  rows = toRows(g);
  return { type: 'dungeon', width, height, rows, rooms: rooms.map(({ x, y, w, h }) => ({ x, y, w, h })), start: [sRoom.cx, sRoom.cy], exit: [eRoom.cx, eRoom.cy], legend: LEGENDS.dungeon, seed };
}

// ---------- cellular-automata caves ----------

/**
 * Random fill, then smoothing steps (a cell becomes rock with 5 or more rock neighbours);
 * the separate pockets are joined to the largest by tunnels, so every floor cell connects.
 */
export function caves({ width = 64, height = 40, seed = 0, fill = 0.46, steps = 5, treasure = 4, monsters = 6 } = {}) {
  const r = rng(seed);
  let g = grid(width, height, '#');
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) g[y][x] = r.chance(fill) ? '#' : '.';
  for (let s = 0; s < steps; s++) {
    const n = grid(width, height, '#');
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
      let walls = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && g[y + dy][x + dx] === '#') walls++;
      n[y][x] = walls >= 5 || (s < 2 && walls <= 1) ? '#' : '.';
    }
    g = n;
  }
  // Regions by flood fill.
  const label = new Int32Array(width * height).fill(-1);
  const regions = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (g[y][x] !== '.' || label[y * width + x] >= 0) continue;
    const cells = [];
    const st = [[x, y]];
    label[y * width + x] = regions.length;
    while (st.length) {
      const [cx, cy] = st.pop();
      cells.push([cx, cy]);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (g[ny]?.[nx] === '.' && label[ny * width + nx] < 0) { label[ny * width + nx] = regions.length; st.push([nx, ny]); }
      }
    }
    regions.push(cells);
  }
  if (!regions.length) return caves({ width, height, seed: `${seed}+`, fill: fill - 0.05, steps, treasure, monsters });
  regions.sort((a, b) => b.length - a.length);
  const main = regions[0];
  // Tiny pockets are filled; the others are tunnelled to the nearest main-region cell.
  for (const reg of regions.slice(1)) {
    if (reg.length < 8) { for (const [x, y] of reg) g[y][x] = '#'; continue; }
    const a = reg[Math.floor(r.next() * reg.length)];
    let b = main[0], bd = Infinity;
    for (const c of main) { const d = Math.abs(c[0] - a[0]) + Math.abs(c[1] - a[1]); if (d < bd) { bd = d; b = c; } }
    let [x, y] = a;
    while (x !== b[0] || y !== b[1]) {
      if (x !== b[0] && (y === b[1] || r.chance(0.5))) x += Math.sign(b[0] - x); else y += Math.sign(b[1] - y);
      g[y][x] = '.';
      if (r.chance(0.3) && y + 1 < height - 1) g[y + 1][x] = '.';
    }
    main.push(...reg);
  }
  let rows = toRows(g);
  const pass = PASSABLE.cave;
  const a = farthest(rows, main[0], pass), b = farthest(rows, a, pass);
  g[a[1]][a[0]] = 'S'; g[b[1]][b[0]] = 'E';
  const floor = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (g[y][x] === '.') floor.push([x, y]);
  r.shuffle(floor);
  floor.slice(0, treasure).forEach(([x, y]) => { g[y][x] = '$'; });
  floor.slice(treasure, treasure + monsters).forEach(([x, y]) => { g[y][x] = 'm'; });
  rows = toRows(g);
  return { type: 'cave', width, height, rows, start: a, exit: b, legend: LEGENDS.cave, seed };
}

// ---------- mazes ----------

/**
 * A maze of cols x rows cells drawn as a (2c+1) x (2r+1) grid. algorithm: backtracker (long
 * winding corridors), prim (many short dead ends), kruskal (uniform), binary (a bias to one
 * corner). braid in [0, 1] removes that share of dead ends, adding loops.
 */
export function maze({ cols = 16, rows: nRows = 12, seed = 0, algorithm = 'backtracker', braid = 0 } = {}) {
  const r = rng(seed);
  const W = cols * 2 + 1, H = nRows * 2 + 1;
  const g = grid(W, H, '#');
  const open = (cx, cy) => { g[cy * 2 + 1][cx * 2 + 1] = '.'; };
  const link = (ax, ay, bx, by) => { open(ax, ay); open(bx, by); g[ay + by + 1][ax + bx + 1] = '.'; };
  const nbrs = (cx, cy) => [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => [cx + dx, cy + dy]).filter(([x, y]) => x >= 0 && y >= 0 && x < cols && y < nRows);
  const seen = new Uint8Array(cols * nRows);
  if (algorithm === 'prim') {
    const front = [];
    const add = (x, y) => { seen[y * cols + x] = 1; open(x, y); for (const n of nbrs(x, y)) if (!seen[n[1] * cols + n[0]]) front.push([...n, x, y]); };
    add(r.int(0, cols - 1), r.int(0, nRows - 1));
    while (front.length) {
      const [x, y, px, py] = front.splice(Math.floor(r.next() * front.length), 1)[0];
      if (seen[y * cols + x]) continue;
      link(px, py, x, y);
      add(x, y);
    }
  } else if (algorithm === 'kruskal') {
    const parent = [...Array(cols * nRows).keys()];
    const root = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const edges = [];
    for (let y = 0; y < nRows; y++) for (let x = 0; x < cols; x++) { if (x + 1 < cols) edges.push([x, y, x + 1, y]); if (y + 1 < nRows) edges.push([x, y, x, y + 1]); open(x, y); }
    for (const [ax, ay, bx, by] of r.shuffle(edges)) {
      const a = root(ay * cols + ax), b = root(by * cols + bx);
      if (a !== b) { parent[a] = b; link(ax, ay, bx, by); }
    }
  } else if (algorithm === 'binary') {
    for (let y = 0; y < nRows; y++) for (let x = 0; x < cols; x++) {
      open(x, y);
      const opts = [];
      if (x + 1 < cols) opts.push([x + 1, y]);
      if (y + 1 < nRows) opts.push([x, y + 1]);
      if (opts.length) { const [bx, by] = r.pick(opts); link(x, y, bx, by); }
    }
  } else {
    const stack = [[0, 0]];
    seen[0] = 1; open(0, 0);
    while (stack.length) {
      const [x, y] = stack[stack.length - 1];
      const next = nbrs(x, y).filter(([nx, ny]) => !seen[ny * cols + nx]);
      if (!next.length) { stack.pop(); continue; }
      const [nx, ny] = r.pick(next);
      seen[ny * cols + nx] = 1;
      link(x, y, nx, ny);
      stack.push([nx, ny]);
    }
  }
  if (braid > 0) {
    for (let y = 0; y < nRows; y++) for (let x = 0; x < cols; x++) {
      const gx = x * 2 + 1, gy = y * 2 + 1;
      const walls = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => g[gy + dy][gx + dx] === '#');
      if (walls.length !== 3 || !r.chance(braid)) continue;
      const inner = walls.filter(([dx, dy]) => gx + dx * 2 > 0 && gy + dy * 2 > 0 && gx + dx * 2 < W - 1 && gy + dy * 2 < H - 1);
      if (inner.length) { const [dx, dy] = r.pick(inner); g[gy + dy][gx + dx] = '.'; }
    }
  }
  g[1][1] = 'S';
  g[H - 2][W - 2] = 'E';
  return { type: 'maze', width: W, height: H, rows: toRows(g), start: [1, 1], exit: [W - 2, H - 2], legend: LEGENDS.maze, algorithm, seed };
}

/** The shortest path between two cells as a list of [x, y], or null. */
export function shortestPath(rows, from, to, passable) {
  const { dist, w } = bfs(rows, from, passable);
  if (dist[to[1] * w + to[0]] < 0) return null;
  const path = [to];
  let [x, y] = to;
  while (dist[y * w + x] > 0) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (dist[ny * w + nx] === dist[y * w + x] - 1 && nx >= 0 && ny >= 0 && nx < w && ny < rows.length) { x = nx; y = ny; break; }
    }
    path.push([x, y]);
  }
  return path.reverse();
}

// ---------- top-down overworld ----------

/**
 * Biomes from height and moisture noise (deep water up to snowy peaks), towns on dry land,
 * roads between them by least-cost paths (A*), the start in one town and the exit in the
 * farthest one.
 */
export function topdown({ width = 64, height = 48, seed = 0, towns = 4, water = 0.32, scale } = {}) {
  const r = rng(seed);
  const sc = scale ?? Math.max(width, height) / 3;
  const hgt = noiseField({ width, height, type: 'perlin', scale: sc, octaves: 5, seed, warp: 0.5 });
  const wet = noiseField({ width, height, type: 'perlin', scale: sc * 0.8, octaves: 3, seed: `${seed}:moist` });
  const g = grid(width, height, 'g');
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const v = hgt[y * width + x], m = wet[y * width + x];
    g[y][x] = v < water - 0.1 ? '~' : v < water ? 'w' : v < water + 0.04 ? 's' : v > 0.9 ? '*' : v > 0.78 ? 'M' : v > 0.66 ? 'h' : m > 0.55 ? 'f' : 'g';
  }
  const land = [];
  for (let y = 2; y < height - 2; y++) for (let x = 2; x < width - 2; x++) if (g[y][x] === 'g') land.push([x, y]);
  r.shuffle(land);
  const placed = [];
  for (const p of land) {
    if (placed.length >= towns) break;
    if (placed.every((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) > Math.min(width, height) / 3.5)) placed.push(p);
  }
  const cost = { '~': Infinity, w: Infinity, s: 2, g: 1, f: 3, h: 4, M: 12, '*': Infinity, '=': 0.5, T: 0.5 };
  for (let i = 1; i < placed.length; i++) {
    // Join each town to the nearest one already joined.
    const from = placed[i];
    const to = placed.slice(0, i).sort((a, b) => Math.hypot(a[0] - from[0], a[1] - from[1]) - Math.hypot(b[0] - from[0], b[1] - from[1]))[0];
    const path = astar(g, from, to, (c) => cost[c] ?? 1);
    for (const [x, y] of path ?? []) if (g[y][x] !== 'T') g[y][x] = '=';
  }
  for (const [x, y] of placed) g[y][x] = 'T';
  let start = placed[0] ?? land[0], exit = placed[1] ?? land[1];
  const rows0 = toRows(g);
  if (placed.length >= 2) {
    const { dist, w } = bfs(rows0, placed[0], PASSABLE.topdown);
    exit = placed.slice(1).sort((a, b) => dist[b[1] * w + b[0]] - dist[a[1] * w + a[0]])[0];
  }
  if (start) g[start[1]][start[0]] = 'S';
  if (exit) g[exit[1]][exit[0]] = 'E';
  return { type: 'topdown', width, height, rows: toRows(g), towns: placed, start, exit, legend: LEGENDS.topdown, seed };
}

/** A* on a grid of characters with a cost per character (Infinity: blocked). */
export function astar(g, from, to, costOf) {
  const h = g.length, w = g[0].length;
  const key = (x, y) => y * w + x;
  const gs = new Float64Array(w * h).fill(Infinity), came = new Int32Array(w * h).fill(-1);
  const open = [[0, from[0], from[1]]];
  gs[key(...from)] = 0;
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i;
    const [, x, y] = open.splice(bi, 1)[0];
    if (x === to[0] && y === to[1]) break;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const c = costOf(g[ny][nx]);
      if (!Number.isFinite(c)) continue;
      const ng = gs[key(x, y)] + c;
      if (ng < gs[key(nx, ny)]) { gs[key(nx, ny)] = ng; came[key(nx, ny)] = key(x, y); open.push([ng + Math.abs(to[0] - nx) + Math.abs(to[1] - ny), nx, ny]); }
    }
  }
  if (!Number.isFinite(gs[key(...to)])) return null;
  const path = [];
  for (let k = key(...to); k >= 0; k = came[k]) path.push([k % w, Math.floor(k / w)]);
  return path.reverse();
}
