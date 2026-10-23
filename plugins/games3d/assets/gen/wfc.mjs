// Wave Function Collapse, both models: the simple tiled model (tiles with edge sockets,
// rotated copies, weights) and the overlapping model (NxN patterns learned from a sample
// grid of characters or colours). Lowest-entropy observation, arc-consistency propagation,
// and fresh attempts from derived seeds on a contradiction.

import { rng } from '../util/rng.mjs';

const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0]; // north, east, south, west
const OPP = [2, 3, 0, 1];

/**
 * The solver over T patterns. propagator[d][t] lists the patterns allowed next to t in
 * direction d. Returns the chosen pattern per cell, or null after `retries` contradictions.
 */
function solve({ width, height, T, weights, propagator, seed, periodic = false, retries = 10, fixed = [] }) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = rng(attempt ? `${seed}#${attempt}` : seed);
    const N = width * height;
    const wave = new Uint8Array(N * T).fill(1);
    const counts = new Int32Array(N * T * 4);
    const left = new Int32Array(N).fill(T);
    for (let i = 0; i < N; i++) for (let t = 0; t < T; t++) for (let d = 0; d < 4; d++) counts[(i * T + t) * 4 + d] = propagator[OPP[d]][t].length;
    const wlw = weights.map((w) => w * Math.log(w));
    const sumW = new Float64Array(N).fill(weights.reduce((a, b) => a + b, 0));
    const sumWL = new Float64Array(N).fill(wlw.reduce((a, b) => a + b, 0));
    const stack = [];
    let dead = false;
    const ban = (i, t) => {
      if (!wave[i * T + t]) return;
      wave[i * T + t] = 0;
      for (let d = 0; d < 4; d++) counts[(i * T + t) * 4 + d] = 0;
      left[i]--; sumW[i] -= weights[t]; sumWL[i] -= wlw[t];
      if (left[i] === 0) dead = true;
      stack.push([i, t]);
    };
    const propagate = () => {
      while (stack.length && !dead) {
        const [i, t] = stack.pop();
        const x = i % width, y = Math.floor(i / width);
        for (let d = 0; d < 4; d++) {
          let nx = x + DX[d], ny = y + DY[d];
          if (periodic) { nx = (nx + width) % width; ny = (ny + height) % height; } else if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const j = ny * width + nx;
          for (const t2 of propagator[d][t]) {
            const c = (j * T + t2) * 4 + d;
            if (--counts[c] === 0) ban(j, t2);
          }
        }
      }
    };
    for (const { x, y, allow } of fixed) {
      const i = y * width + x;
      for (let t = 0; t < T; t++) if (!allow.includes(t)) ban(i, t);
    }
    propagate();
    while (!dead) {
      // The undecided cell of least entropy (a little noise breaks ties).
      let best = -1, be = Infinity;
      for (let i = 0; i < N; i++) {
        if (left[i] <= 1) continue;
        const e = Math.log(sumW[i]) - sumWL[i] / sumW[i] + r.next() * 1e-6;
        if (e < be) { be = e; best = i; }
      }
      if (best < 0) break;
      const opts = [], ws = [];
      for (let t = 0; t < T; t++) if (wave[best * T + t]) { opts.push(t); ws.push(weights[t]); }
      const pick = r.weighted(opts, ws);
      for (const t of opts) if (t !== pick) ban(best, t);
      propagate();
    }
    if (dead) continue;
    const out = new Int32Array(N);
    for (let i = 0; i < N; i++) { out[i] = -1; for (let t = 0; t < T; t++) if (wave[i * T + t]) { out[i] = t; break; } }
    return { cells: out, attempts: attempt + 1 };
  }
  return null;
}

// ---------- simple tiled model ----------

/** Built-in tile sets: sockets are read clockwise along each edge (north, east, south, west). */
export const TILESETS = {
  // Roads on grass: 'g' grass edge, 'grg' an edge with a road in its middle.
  roads: [
    { name: 'grass', sockets: ['ggg', 'ggg', 'ggg', 'ggg'], weight: 6, color: '#5fae4a' },
    { name: 'straight', sockets: ['grg', 'ggg', 'grg', 'ggg'], weight: 2, rotate: true },
    { name: 'corner', sockets: ['grg', 'grg', 'ggg', 'ggg'], weight: 1, rotate: true },
    { name: 'tee', sockets: ['grg', 'grg', 'ggg', 'grg'], weight: 0.4, rotate: true },
    { name: 'cross', sockets: ['grg', 'grg', 'grg', 'grg'], weight: 0.2 },
    { name: 'end', sockets: ['grg', 'ggg', 'ggg', 'ggg'], weight: 0.15, rotate: true },
  ],
  // Coastlines: water, sand and grass with sand between them; 'ws' is water then sand clockwise.
  coast: [
    { name: 'water', sockets: ['www', 'www', 'www', 'www'], weight: 4, color: '#3b78c4' },
    { name: 'sand', sockets: ['sss', 'sss', 'sss', 'sss'], weight: 2, color: '#e0cf8f' },
    { name: 'grass', sockets: ['ggg', 'ggg', 'ggg', 'ggg'], weight: 5, color: '#5fae4a' },
    { name: 'forest', sockets: ['fff', 'fff', 'fff', 'fff'], weight: 3, color: '#2f7a3a' },
    { name: 'shore', sockets: ['sss', 'ssw', 'www', 'wss'], weight: 1, rotate: true },
    { name: 'shore-out', sockets: ['sss', 'sss', 'ssw', 'wss'], weight: 0.5, rotate: true },
    { name: 'shore-in', sockets: ['ssw', 'www', 'www', 'wss'], weight: 0.5, rotate: true },
    { name: 'meadow', sockets: ['ggg', 'ggs', 'sss', 'sgg'], weight: 1, rotate: true },
    { name: 'meadow-out', sockets: ['ggg', 'ggg', 'ggs', 'sgg'], weight: 0.5, rotate: true },
    { name: 'meadow-in', sockets: ['ggs', 'sss', 'sss', 'sgg'], weight: 0.5, rotate: true },
    { name: 'edge', sockets: ['fff', 'ffg', 'ggg', 'gff'], weight: 1, rotate: true },
    { name: 'edge-out', sockets: ['fff', 'fff', 'ffg', 'gff'], weight: 0.5, rotate: true },
    { name: 'edge-in', sockets: ['ffg', 'ggg', 'ggg', 'gff'], weight: 0.5, rotate: true },
  ],
};

const reverse = (s) => [...String(s)].reverse().join('');

/** Tiles with their rotated copies (rotation r turns the tile r x 90 degrees clockwise). */
export function expandTiles(tiles) {
  const out = [];
  for (const t of tiles) {
    const seen = new Set();
    const copies = [];
    for (let rot = 0; rot < (t.rotate ? 4 : 1); rot++) {
      const s = [0, 1, 2, 3].map((d) => t.sockets[(d - rot + 4) % 4]);
      const k = s.join('|');
      if (seen.has(k)) continue;
      seen.add(k);
      copies.push({ ...t, rotation: rot, sockets: s, id: rot ? `${t.name}@${rot * 90}` : t.name });
    }
    // A tile's weight is shared by its rotated copies.
    for (const c of copies) out.push({ ...c, weight: (t.weight ?? 1) / copies.length });
  }
  return out;
}

/**
 * The simple tiled model: tiles (or a built-in set's name) on a width x height grid. Two
 * tiles may touch where one edge's socket is the other's reversed (they meet head to tail).
 */
export function wfcTiled({ tiles = 'roads', width = 16, height = 16, seed = 0, periodic = false, retries = 20 } = {}) {
  const base = typeof tiles === 'string' ? TILESETS[tiles] : tiles;
  if (!Array.isArray(base) || !base.length) throw new Error(`tiles must be a list of {name, sockets:[n,e,s,w]} or one of ${Object.keys(TILESETS).join(', ')}`);
  for (const t of base) if (!Array.isArray(t.sockets) || t.sockets.length !== 4) throw new Error(`tile ${t.name}: sockets must be [north, east, south, west]`);
  const list = expandTiles(base);
  const T = list.length;
  const propagator = [0, 1, 2, 3].map((d) => list.map((a) => list.map((b, j) => (a.sockets[d] === reverse(b.sockets[OPP[d]]) ? j : -1)).filter((j) => j >= 0)));
  const res = solve({ width, height, T, weights: list.map((t) => t.weight), propagator, seed, periodic, retries });
  if (!res) return { ok: false, reason: `contradiction in every one of ${retries + 1} attempts: the tiles may not fit together` };
  const grid = [];
  for (let y = 0; y < height; y++) grid.push(Array.from({ length: width }, (_, x) => list[res.cells[y * width + x]].id));
  return { ok: true, type: 'wfc-tiled', width, height, grid, tiles: list.map(({ id, name, rotation, sockets, color }) => ({ id, name, rotation, sockets, color })), attempts: res.attempts, seed };
}

// ---------- overlapping model ----------

/**
 * The overlapping model: learns every NxN pattern of a sample (rows of characters, or a grid
 * of values) with rotations and reflections (symmetry 1-8), and makes a width x height grid
 * whose every NxN window is one of them.
 */
export function wfcOverlapping({ sample, n = 3, width = 32, height = 32, seed = 0, symmetry = 8, periodicInput = true, periodic = false, retries = 10 } = {}) {
  const src = (Array.isArray(sample) ? sample : String(sample ?? '').split('\n')).map((r) => (typeof r === 'string' ? [...r] : r));
  const SH = src.length, SW = Math.max(...src.map((r) => r.length));
  if (!SH || !SW) throw new Error('sample is empty');
  const values = [...new Set(src.flat())];
  const idx = src.map((r) => Array.from({ length: SW }, (_, x) => values.indexOf(r[x] ?? r[r.length - 1])));
  const pat = (f) => { const p = []; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) p.push(f(x, y)); return p; };
  const rotate = (p) => pat((x, y) => p[n - 1 - y + x * n]);
  const reflect = (p) => pat((x, y) => p[n - 1 - x + y * n]);
  const patterns = [], weights = [], index = new Map();
  const maxX = periodicInput ? SW : SW - n + 1, maxY = periodicInput ? SH : SH - n + 1;
  for (let y = 0; y < maxY; y++) for (let x = 0; x < maxX; x++) {
    const ps = [pat((dx, dy) => idx[(y + dy) % SH][(x + dx) % SW])];
    ps[1] = reflect(ps[0]); ps[2] = rotate(ps[0]); ps[3] = reflect(ps[2]); ps[4] = rotate(ps[2]); ps[5] = reflect(ps[4]); ps[6] = rotate(ps[4]); ps[7] = reflect(ps[6]);
    for (let k = 0; k < Math.max(1, Math.min(8, symmetry)); k++) {
      const key = ps[k].join(',');
      if (index.has(key)) weights[index.get(key)]++;
      else { index.set(key, patterns.length); patterns.push(ps[k]); weights.push(1); }
    }
  }
  const T = patterns.length;
  const agrees = (p1, p2, dx, dy) => {
    for (let y = Math.max(0, dy); y < Math.min(n, n + dy); y++) for (let x = Math.max(0, dx); x < Math.min(n, n + dx); x++) if (p1[x + n * y] !== p2[x - dx + n * (y - dy)]) return false;
    return true;
  };
  const propagator = [0, 1, 2, 3].map((d) => patterns.map((p1) => patterns.map((p2, j) => (agrees(p1, p2, DX[d], DY[d]) ? j : -1)).filter((j) => j >= 0)));
  // The output grid of patterns: windows that would leave the grid are not needed unless periodic.
  const gw = periodic ? width : width - n + 1, gh = periodic ? height : height - n + 1;
  const res = solve({ width: gw, height: gh, T, weights, propagator, seed, periodic, retries });
  if (!res) return { ok: false, reason: `contradiction in every one of ${retries + 1} attempts: try a smaller n, more symmetry, or a periodic output` };
  const out = [];
  for (let y = 0; y < height; y++) {
    const row = [];
    for (let x = 0; x < width; x++) {
      const cx = Math.min(x, gw - 1), cy = Math.min(y, gh - 1);
      const p = patterns[res.cells[(periodic ? y : cy) * gw + (periodic ? x : cx)]];
      row.push(values[p[(periodic ? 0 : x - cx) + n * (periodic ? 0 : y - cy)]]);
    }
    out.push(row);
  }
  const allChars = values.every((v) => typeof v === 'string' && v.length === 1);
  return { ok: true, type: 'wfc-overlapping', width, height, rows: allChars ? out.map((r) => r.join('')) : undefined, grid: allChars ? undefined : out, patterns: T, attempts: res.attempts, seed };
}
