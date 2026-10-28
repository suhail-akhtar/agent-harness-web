// Tiles: seamless terrain textures (grass, dirt, sand, stone, brick, water, wood, lava,
// snow, wall) and autotile sets between two terrains: the 16-tile corner set (marching
// squares) and the 47-tile blob set, with their rules as JSON, a Tiled wangset and a
// Godot 4 TileSet with terrain peering bits.

import { parseColor, ramp } from '../raster/color.mjs';
import { bayer, Image } from '../raster/image.mjs';
import { createNoise, noiseField } from '../gen/noise.mjs';
import { rng } from '../util/rng.mjs';

export const TERRAINS = {
  grass: { base: '#5fae4a' }, dirt: { base: '#9a6a42' }, sand: { base: '#e0c88a' }, stone: { base: '#8c8c96' }, brick: { base: '#a8543e' },
  water: { base: '#3a7ac8' }, wood: { base: '#a8743e' }, lava: { base: '#e8602a' }, snow: { base: '#e8eef8' }, wall: { base: '#5a5a6e' },
  path: { base: '#c8a878' }, darkgrass: { base: '#3f8a3a' },
};

/** A seamless square texture of a terrain (it tiles with itself in both directions). */
export function terrainTexture(type, size = 16, { seed = 0, color, frame = 0 } = {}) {
  const def = TERRAINS[type];
  if (!def) throw new Error(`unknown terrain ${type}: one of ${Object.keys(TERRAINS).join(', ')}`);
  const R = ramp(color ?? def.base, 5);
  const img = new Image(size, size);
  const r = rng(`${seed}:${type}`);
  const n = noiseField({ width: size, height: size, type: 'value', scale: size / 2, octaves: 3, seed: `${seed}:${type}`, tileable: true });
  const at = (x, y) => n[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  const put = (x, y, c) => img.set(((x % size) + size) % size, ((y % size) + size) % size, c);
  const shade = (v, lo = 1, hi = 3) => R[Math.max(0, Math.min(4, Math.round(lo + v * (hi - lo))))];
  if (type === 'grass' || type === 'darkgrass') {
    img.paint((x, y) => shade(at(x, y) + (bayer(x, y) - 0.5) * 0.35, 1.2, 2.8));
    for (let i = 0; i < size * size / 14; i++) {
      const x = r.int(0, size - 1), y = r.int(0, size - 1);
      put(x, y, R[3]); put(x, y - 1, R[3]); put(x + 1, y, R[1]);
      if (r.chance(0.3)) put(x - 1, y + 1, R[4]);
    }
  } else if (type === 'dirt' || type === 'path') {
    img.paint((x, y) => shade(at(x, y) + (bayer(x, y) - 0.5) * 0.3, 1.3, 2.7));
    for (let i = 0; i < size * size / 24; i++) { const x = r.int(0, size - 1), y = r.int(0, size - 1); put(x, y, R[3]); put(x + 1, y + 1, R[0]); }
  } else if (type === 'sand') {
    img.paint((x, y) => shade(at(x, y) * 0.6 + 0.3 + (bayer(x, y) - 0.5) * 0.3, 1.6, 3));
    for (let i = 0; i < size * size / 30; i++) put(r.int(0, size - 1), r.int(0, size - 1), R[1]);
  } else if (type === 'stone' || type === 'wall') {
    const cells = Math.max(2, Math.round(size / 6));
    const nz = createNoise(`${seed}:${type}:cells`);
    img.paint((x, y) => {
      const u = ((x + 0.5) / size) * cells, v = ((y + 0.5) / size) * cells;
      const e = nz.worley(u, v, cells, cells, 'f2-f1');
      const f1 = nz.worley(u, v, cells, cells, 'f1');
      if (e < 0.09) return R[0];
      return shade(0.75 - f1 * 0.6 + at(x, y) * 0.3, 1, 3.4);
    });
  } else if (type === 'brick') {
    const bh = Math.max(3, Math.round(size / 4)), bw = bh * 2;
    img.paint((x, y) => {
      const row = Math.floor(y / bh), off = row % 2 ? bw / 2 : 0, col = Math.floor((x + off) / bw);
      const lx = (x + off) % bw, ly = y % bh;
      if (ly === bh - 1 || lx === bw - 1) return R[0];
      const tone = (Math.sin(row * 12.9 + col * 78.2) * 43758.5453) % 1;
      if (ly === 0 || lx === 0) return R[3];
      return shade(Math.abs(tone) * 0.6 + at(x, y) * 0.4, 1.2, 2.8);
    });
  } else if (type === 'water') {
    img.paint((x, y) => {
      const w = Math.sin(((x + frame * size / 4) / size) * Math.PI * 2 * 2 + Math.sin((y / size) * Math.PI * 2) * 1.5) * 0.5 + 0.5;
      const v = at(x, y) * 0.5 + w * 0.5;
      return v > 0.82 ? R[4] : shade(v + (bayer(x, y) - 0.5) * 0.25, 1, 3);
    });
  } else if (type === 'wood') {
    const pw = Math.max(4, Math.round(size / 4));
    img.paint((x, y) => {
      const plank = Math.floor(x / pw);
      if (x % pw === pw - 1) return R[0];
      const grain = Math.sin((y / size) * Math.PI * 2 * 3 + plank * 2.1 + at(x, y) * 3) * 0.5 + 0.5;
      if ((y + plank * 5) % size === 0) return R[1];
      return shade(grain * 0.6 + 0.2, 1.4, 3);
    });
  } else if (type === 'lava') {
    const nz = createNoise(`${seed}:lava`);
    const cells = Math.max(2, Math.round(size / 8));
    img.paint((x, y) => {
      const e = nz.worley(((x + 0.5) / size) * cells, ((y + 0.5) / size) * cells, cells, cells, 'f2-f1');
      const glow = Math.max(0, 1 - e * 5);
      return glow > 0.6 ? parseColor('#ffe27a') : shade(glow + (bayer(x, y) - 0.5) * 0.3 + at(x, y) * 0.2, 0.4, 3.5);
    });
  } else if (type === 'snow') {
    img.paint((x, y) => shade(at(x, y) * 0.5 + 0.4 + (bayer(x, y) - 0.5) * 0.2, 2, 3.4));
    for (let i = 0; i < size * size / 40; i++) put(r.int(0, size - 1), r.int(0, size - 1), R[1]);
  }
  return img;
}

// ---------- autotiles ----------

const wob = (t, size, seed) => Math.sin((t / size) * Math.PI * 2 + seed) * 0.6 + Math.sin((t / size) * Math.PI * 4 + seed * 2.3) * 0.4;

/**
 * The 16-tile corner set: tile i has terrain A at its NW, NE, SW, SE corners where bits 1,
 * 2, 4, 8 of i are set (0 is all B, 15 all A). Between them a wavy edge; the A side gets
 * a rim and the B side below it a shadow.
 */
export function cornerTileset({ a = 'grass', b = 'dirt', size = 16, seed = 0 } = {}) {
  const ta = terrainTexture(a, size, { seed }), tb = terrainTexture(b, size, { seed: `${seed}b` });
  const ra = ramp(TERRAINS[a].base, 5), rb = ramp(TERRAINS[b].base, 5);
  const tiles = [];
  const s0 = rng(seed).range(0, 6);
  for (let i = 0; i < 16; i++) {
    const c = [i & 1, (i >> 1) & 1, (i >> 2) & 1, (i >> 3) & 1];
    const field = (x, y) => {
      const u = Math.min(1, Math.max(0, (x + 0.5) / size)), v = Math.min(1, Math.max(0, (y + 0.5) / size));
      const f = (c[0] * (1 - u) + c[1] * u) * (1 - v) + (c[2] * (1 - u) + c[3] * u) * v;
      return f + 0.12 * (wob(x + 0.5, size, s0) * 0.5 + wob(y + 0.5, size, s0 + 1) * 0.5) > 0.5;
    };
    tiles.push(compose(size, field, ta, tb, ra, rb));
  }
  const img = new Image(size * 4, size * 4);
  tiles.forEach((t, i) => img.draw(t, (i % 4) * size, Math.floor(i / 4) * size, { mode: 'replace' }));
  const wangtiles = tiles.map((_, i) => ({ tileid: i, wangid: [0, (i >> 1) & 1 ? 1 : 2, 0, (i >> 3) & 1 ? 1 : 2, 0, (i >> 2) & 1 ? 1 : 2, 0, i & 1 ? 1 : 2] }));
  return {
    image: img, tiles, columns: 4, count: 16, size,
    rules: { kind: 'corner-16', bits: { NW: 1, NE: 2, SW: 4, SE: 8 }, meaning: 'tile index = sum of the bits of the corners that are terrain A', a, b },
    wangset: { name: `${a}-${b}`, type: 'corner', tile: 15, colors: [{ name: a, color: '#5fae4a', tile: 15, probability: 1 }, { name: b, color: '#9a6a42', tile: 0, probability: 1 }], wangtiles },
  };
}

/** A tile from an A/B mask: textures, a rim on A's edge and a shadow on B under A. */
function compose(size, isA, ta, tb, ra, rb) {
  const t = new Image(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (isA(x, y)) {
      const edge = !isA(x + 1, y) || !isA(x - 1, y) || !isA(x, y + 1) || !isA(x, y - 1);
      t.set(x, y, edge ? (!isA(x, y + 1) ? ra[0] : ra[1]) : ta.get(x, y));
    } else {
      const under = isA(x, y - 1) || (isA(x, y - 2) && size >= 16);
      t.set(x, y, under ? rb[0] : tb.get(x, y));
    }
  }
  return t;
}

const N = 1, NE = 2, E = 4, SE = 8, S = 16, SW = 32, W = 64, NW = 128;

/** A neighbour mask with the corners that do not count (an edge beside them is missing) cleared. */
export function reduceBlob(m) {
  let r = m & (N | E | S | W);
  if ((m & NE) && (m & N) && (m & E)) r |= NE;
  if ((m & SE) && (m & S) && (m & E)) r |= SE;
  if ((m & SW) && (m & S) && (m & W)) r |= SW;
  if ((m & NW) && (m & N) && (m & W)) r |= NW;
  return r;
}

/** The 47 distinct reduced masks, in a fixed order (ascending). */
export const BLOB_MASKS = [...new Set(Array.from({ length: 256 }, (_, m) => reduceBlob(m)))].sort((a, b) => a - b);

/**
 * The 47-tile blob set: terrain A in the middle of every tile, reaching to each edge and
 * corner where that neighbour is A too (bits N=1 NE=2 E=4 SE=8 S=16 SW=32 W=64 NW=128).
 * Tile 47 is plain B. rules.lookup maps all 256 neighbour masks to a tile index.
 */
export function blobTileset({ a = 'grass', b = 'dirt', size = 16, seed = 0, border } = {}) {
  const ta = terrainTexture(a, size, { seed }), tb = terrainTexture(b, size, { seed: `${seed}b` });
  const ra = ramp(TERRAINS[a].base, 5), rb = ramp(TERRAINS[b].base, 5);
  const bw = border ?? size / 4;
  const s0 = rng(seed).range(0, 6);
  const tiles = BLOB_MASKS.map((m) => {
    const has = (bit) => (m & bit) !== 0;
    const isA = (x, y) => {
      const px = x + 0.5, py = y + 0.5;
      if (px < 0 || py < 0 || px > size || py > size) {
        // Beyond the tile: the neighbour on that side (its edge row is A where this edge is).
        const cx = Math.min(size - 0.5, Math.max(0.5, px)), cy = Math.min(size - 0.5, Math.max(0.5, py));
        return isA(cx - 0.5, cy - 0.5);
      }
      const west = px < size / 2, north = py < size / 2;
      const hEdge = has(west ? W : E), vEdge = has(north ? N : S), corner = has(north ? (west ? NW : NE) : (west ? SW : SE));
      const du = west ? px : size - px, dv = north ? py : size - py;
      const b1 = bw + 0.6 * wob(py, size, s0), b2 = bw + 0.6 * wob(px, size, s0 + 1);
      if (hEdge && vEdge) return corner || du * du + dv * dv >= bw * bw;
      if (vEdge) return du > b1;
      if (hEdge) return dv > b2;
      const rr = bw * 0.9, c = bw + rr;
      if (du <= bw || dv <= bw) return false;
      if (du < c && dv < c) return (du - c) ** 2 + (dv - c) ** 2 <= rr * rr;
      return true;
    };
    return compose(size, isA, ta, tb, ra, rb);
  });
  tiles.push(tb.clone());
  const columns = 8;
  const img = new Image(columns * size, Math.ceil(tiles.length / columns) * size);
  tiles.forEach((t, i) => img.draw(t, (i % columns) * size, Math.floor(i / columns) * size, { mode: 'replace' }));
  const lookup = Array.from({ length: 256 }, (_, m) => BLOB_MASKS.indexOf(reduceBlob(m)));
  const col = (bit, m) => ((m & bit) ? 1 : 2);
  const wangtiles = BLOB_MASKS.map((m, i) => ({ tileid: i, wangid: [col(N, m), col(NE, m), col(E, m), col(SE, m), col(S, m), col(SW, m), col(W, m), col(NW, m)] }));
  wangtiles.push({ tileid: 47, wangid: [2, 2, 2, 2, 2, 2, 2, 2] });
  return {
    image: img, tiles, columns, count: tiles.length, size,
    rules: { kind: 'blob-47', bits: { N, NE, E, SE, S, SW, W, NW }, masks: BLOB_MASKS, lookup, fillB: 47, meaning: 'for a cell of terrain A: mask = sum of the bits of the 8 neighbours that are A; tile = lookup[mask]. Cells of B use tile 47.', a, b },
    wangset: { name: `${a}-${b}`, type: 'mixed', tile: BLOB_MASKS.indexOf(255), colors: [{ name: a, color: '#5fae4a', tile: BLOB_MASKS.indexOf(255), probability: 1 }, { name: b, color: '#9a6a42', tile: 47, probability: 1 }], wangtiles },
  };
}

/** Which tile a cell of a boolean grid (true: terrain A) takes in a blob set: the autotiler. */
export function autotileBlob(grid) {
  const h = grid.length, w = grid[0].length;
  const A = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? true : grid[y][x]);
  return grid.map((row, y) => row.map((v, x) => {
    if (!v) return 47;
    let m = 0;
    if (A(x, y - 1)) m |= N; if (A(x + 1, y - 1)) m |= NE; if (A(x + 1, y)) m |= E; if (A(x + 1, y + 1)) m |= SE;
    if (A(x, y + 1)) m |= S; if (A(x - 1, y + 1)) m |= SW; if (A(x - 1, y)) m |= W; if (A(x - 1, y - 1)) m |= NW;
    return BLOB_MASKS.indexOf(reduceBlob(m));
  }));
}

const PEER = [['top_side', N], ['top_right_corner', NE], ['right_side', E], ['bottom_right_corner', SE], ['bottom_side', S], ['bottom_left_corner', SW], ['left_side', W], ['top_left_corner', NW]];

/**
 * A Godot 4 TileSet (.tres) for a blob set: one atlas source, terrain set 0 in "match corners
 * and sides" mode with terrains A (0) and B (1), every tile's peering bits from its mask.
 */
export function godotBlobTileset(set, { texturePath = 'res://tiles.png' } = {}) {
  const lines = [];
  set.rules.masks.forEach((m, i) => {
    const at = `${i % set.columns}:${Math.floor(i / set.columns)}/0`;
    lines.push(`${at} = 0`, `${at}/terrain_set = 0`, `${at}/terrain = 0`);
    for (const [name, bit] of PEER) lines.push(`${at}/terrains_peering_bit/${name} = ${(m & bit) ? 0 : 1}`);
  });
  const fb = `${47 % set.columns}:${Math.floor(47 / set.columns)}/0`;
  lines.push(`${fb} = 0`, `${fb}/terrain_set = 0`, `${fb}/terrain = 1`);
  for (const [name] of PEER) lines.push(`${fb}/terrains_peering_bit/${name} = 1`);
  return [
    '[gd_resource type="TileSet" load_steps=3 format=3]', '',
    `[ext_resource type="Texture2D" path="${texturePath}" id="1_tiles"]`, '',
    '[sub_resource type="TileSetAtlasSource" id="TileSetAtlasSource_1"]',
    'texture = ExtResource("1_tiles")',
    `texture_region_size = Vector2i(${set.size}, ${set.size})`,
    ...lines, '',
    '[resource]',
    `tile_size = Vector2i(${set.size}, ${set.size})`,
    'terrain_set_0/mode = 0',
    `terrain_set_0/terrain_0/name = "${set.rules.a}"`, 'terrain_set_0/terrain_0/color = Color(0.37, 0.68, 0.29, 1)',
    `terrain_set_0/terrain_1/name = "${set.rules.b}"`, 'terrain_set_0/terrain_1/color = Color(0.6, 0.42, 0.26, 1)',
    'sources/0 = SubResource("TileSetAtlasSource_1")', '',
  ].join('\n');
}
