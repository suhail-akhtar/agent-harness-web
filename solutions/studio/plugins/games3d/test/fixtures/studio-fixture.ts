// A Studio project in the shapes of plugins/games3d/sdk/FORMATS.md, made from code (no binary
// fixtures in the repository): a third-person game project with stages, a design document,
// budgets, two builds (one failed, with its log), assets (a glTF barrel with a LOD and two
// animations, a pixel-art sprite sheet, a tileset and a level, a WAV sound effect, a library
// asset), a Godot scene, renders, and a playtest report with frames, events, metrics, issues,
// verdicts and an animated GIF recording. Used by test/studio-ui.test.ts and the Electron run.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// ---------------- encoders ----------------

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf: Buffer): number { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export type Pixel = (x: number, y: number) => [number, number, number, number];
/** An RGBA PNG drawn by a function of the pixel. */
export function png(width: number, height: number, px: Pixel): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) { const [r, g, b, a] = px(x, y); raw.set([r, g, b, a], y * (width * 4 + 1) + 1 + x * 4); }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** An animated GIF of indexed frames (a 256-colour palette given as [r,g,b] triples). */
export function gif(width: number, height: number, palette: number[][], frames: Uint8Array[], delayCs = 12): Buffer {
  const out: number[] = [];
  const u16 = (v: number) => { out.push(v & 255, (v >> 8) & 255); };
  out.push(...Buffer.from('GIF89a', 'latin1')); u16(width); u16(height); out.push(0xf7, 0, 0);
  for (let i = 0; i < 256; i++) out.push(...(palette[i] ?? [0, 0, 0]));
  out.push(0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0', 'latin1'), 3, 1, 0, 0, 0);
  for (const f of frames) {
    out.push(0x21, 0xf9, 4, 0); u16(delayCs); out.push(0, 0);
    out.push(0x2c); u16(0); u16(0); u16(width); u16(height); out.push(0);
    out.push(8);
    // LZW with 8-bit codes, restarting the table before it is full (simple and valid).
    const clear = 256; const eoi = 257;
    let size = 9; let next = 258; const dict = new Map<string, number>();
    const bits: number[] = []; let acc = 0; let nacc = 0;
    const emit = (code: number) => { acc |= code << nacc; nacc += size; while (nacc >= 8) { bits.push(acc & 255); acc >>>= 8; nacc -= 8; } };
    emit(clear);
    let w = String.fromCharCode(f[0]!);
    for (let i = 1; i < f.length; i++) {
      const c = String.fromCharCode(f[i]!);
      const wc = w + c;
      if (dict.has(wc) || wc.length === 1) { w = wc; continue; }
      emit(w.length === 1 ? w.charCodeAt(0) : dict.get(w)!);
      dict.set(wc, next++);
      if (next - 1 === 1 << size && size < 12) size++;
      if (next >= 4000) { emit(clear); dict.clear(); next = 258; size = 9; }
      w = c;
    }
    emit(w.length === 1 ? w.charCodeAt(0) : dict.get(w)!);
    emit(eoi);
    if (nacc > 0) bits.push(acc & 255);
    for (let i = 0; i < bits.length; i += 255) { const part = bits.slice(i, i + 255); out.push(part.length, ...part); }
    out.push(0);
  }
  out.push(0x3b);
  return Buffer.from(out);
}

/** A 16-bit mono WAV of samples in [-1, 1]. */
export function wav(samples: Float32Array, rate = 22050): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'latin1'); h.write('fmt ', 12, 'latin1');
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1'); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/**
 * A wooden barrel as a GLB: a bulging cylinder (wood) and two metal bands, normals and UVs, and
 * two animations of the root ("spin" about Y, "hop" up and down). `segments` makes the LODs.
 */
export function barrelGlb(segments = 24): { glb: Buffer; triangles: number } {
  const meshes: Array<{ pos: number[]; nrm: number[]; uv: number[]; idx: number[]; material: number }> = [];
  const ring = (y0: number, y1: number, r0: (y: number) => number, rows: number, material: number, caps: boolean) => {
    const pos: number[] = []; const nrm: number[] = []; const uv: number[] = []; const idx: number[] = [];
    for (let j = 0; j <= rows; j++) {
      const y = y0 + ((y1 - y0) * j) / rows; const r = r0(y);
      for (let i = 0; i <= segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        pos.push(Math.cos(a) * r, y, Math.sin(a) * r); nrm.push(Math.cos(a), 0, Math.sin(a)); uv.push(i / segments, j / rows);
      }
    }
    for (let j = 0; j < rows; j++) for (let i = 0; i < segments; i++) { const a = j * (segments + 1) + i; const b = a + segments + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
    if (caps) for (const [y, ny] of [[y0, -1], [y1, 1]] as const) {
      const c = pos.length / 3; pos.push(0, y, 0); nrm.push(0, ny, 0); uv.push(0.5, 0.5);
      for (let i = 0; i <= segments; i++) { const a = (i / segments) * Math.PI * 2; const r = r0(y); pos.push(Math.cos(a) * r, y, Math.sin(a) * r); nrm.push(0, ny, 0); uv.push(0.5 + Math.cos(a) / 2, 0.5 + Math.sin(a) / 2); }
      for (let i = 0; i < segments; i++) ny > 0 ? idx.push(c, c + 2 + i, c + 1 + i) : idx.push(c, c + 1 + i, c + 2 + i);
    }
    meshes.push({ pos, nrm, uv, idx, material });
  };
  const bulge = (y: number) => 0.3 + 0.045 * Math.sin((y / 0.9) * Math.PI);
  ring(0, 0.9, bulge, Math.max(4, Math.round(segments / 3)), 0, true);
  for (const yc of [0.16, 0.74]) ring(yc - 0.03, yc + 0.03, (y) => bulge(y) + 0.008, 1, 1, false);

  const bin: Buffer[] = []; let off = 0;
  const views: unknown[] = []; const accessors: unknown[] = [];
  const add = (buf: Buffer, target?: number) => { const pad = (4 - (buf.length % 4)) % 4; views.push({ buffer: 0, byteOffset: off, byteLength: buf.length, ...(target ? { target } : {}) }); bin.push(buf, Buffer.alloc(pad)); off += buf.length + pad; return views.length - 1; };
  const f32 = (a: number[]) => Buffer.from(new Float32Array(a).buffer);
  const glMeshes = meshes.map((m, mi) => {
    const mm = (k: number) => [Math.min(...m.pos.filter((_, i) => i % 3 === k)), Math.max(...m.pos.filter((_, i) => i % 3 === k))];
    const [x, y, z] = [mm(0), mm(1), mm(2)];
    accessors.push({ bufferView: add(f32(m.pos), 34962), componentType: 5126, count: m.pos.length / 3, type: 'VEC3', min: [x[0], y[0], z[0]], max: [x[1], y[1], z[1]] });
    accessors.push({ bufferView: add(f32(m.nrm), 34962), componentType: 5126, count: m.nrm.length / 3, type: 'VEC3' });
    accessors.push({ bufferView: add(f32(m.uv), 34962), componentType: 5126, count: m.uv.length / 2, type: 'VEC2' });
    accessors.push({ bufferView: add(Buffer.from(new Uint16Array(m.idx).buffer), 34963), componentType: 5123, count: m.idx.length, type: 'SCALAR' });
    const a = mi * 4;
    return { name: mi === 0 ? 'Staves' : `Band ${mi}`, primitives: [{ attributes: { POSITION: a, NORMAL: a + 1, TEXCOORD_0: a + 2 }, indices: a + 3, material: m.material }] };
  });
  // Animations: keyframes of the root node.
  const times = [0, 0.5, 1, 1.5, 2];
  const tAcc = accessors.length; accessors.push({ bufferView: add(f32(times)), componentType: 5126, count: times.length, type: 'SCALAR', min: [0], max: [2] });
  const rot = times.flatMap((t) => { const a = (t / 2) * Math.PI; return [0, Math.sin(a), 0, Math.cos(a)]; });
  const rAcc = accessors.length; accessors.push({ bufferView: add(f32(rot)), componentType: 5126, count: times.length, type: 'VEC4' });
  const hop = times.flatMap((t) => [0, Math.abs(Math.sin((t / 2) * Math.PI * 2)) * 0.25, 0]);
  const hAcc = accessors.length; accessors.push({ bufferView: add(f32(hop)), componentType: 5126, count: times.length, type: 'VEC3' });
  const binBuf = Buffer.concat(bin);
  const json = {
    asset: { version: '2.0', generator: 'studio-fixture' },
    scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Barrel', children: [1, 2, 3] }, { name: 'Staves', mesh: 0 }, { name: 'Band low', mesh: 1 }, { name: 'Band high', mesh: 2 }],
    meshes: glMeshes,
    materials: [
      { name: 'Oak', pbrMetallicRoughness: { baseColorFactor: [0.55, 0.33, 0.16, 1], metallicFactor: 0, roughnessFactor: 0.75 } },
      { name: 'Iron', pbrMetallicRoughness: { baseColorFactor: [0.32, 0.33, 0.36, 1], metallicFactor: 0.9, roughnessFactor: 0.4 } },
    ],
    animations: [
      { name: 'spin', channels: [{ sampler: 0, target: { node: 0, path: 'rotation' } }], samplers: [{ input: tAcc, output: rAcc, interpolation: 'LINEAR' }] },
      { name: 'hop', channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }], samplers: [{ input: tAcc, output: hAcc, interpolation: 'LINEAR' }] },
    ],
    buffers: [{ byteLength: binBuf.length }], bufferViews: views, accessors,
  };
  let jsonBuf = Buffer.from(JSON.stringify(json));
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binBuf.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(binBuf.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  return { glb: Buffer.concat([header, jh, jsonBuf, bh, binBuf]), triangles: meshes.reduce((n, m) => n + m.idx.length / 3, 0) };
}

// ---------------- pictures ----------------

const HERO = ['....hhhh....', '...hhhhhh...', '...hffffh...', '...fefefh...', '...ffffff...', '....ffff....', '..bbbbbbbb..', '.fbbbbbbbbf.', '.f.bbbbbb.f.', '...bbbbbb...', '...ll..ll...', '..ll....ll..'];
/** Eight frames of a 32x32 pixel-art walk cycle in one strip (256x32). */
export function heroSheet(): Buffer {
  const col: Record<string, [number, number, number, number]> = { h: [92, 52, 28, 255], f: [242, 196, 160, 255], e: [30, 30, 40, 255], b: [52, 112, 214, 255], l: [40, 40, 52, 255] };
  return png(256, 32, (x, y) => {
    const frame = Math.floor(x / 32); const fx = x % 32;
    const bob = frame % 2;
    const sy = Math.floor((y - 4 - bob) / 2); const sx = Math.floor((fx - 4) / 2);
    if (sy < 0 || sy >= 12 || sx < 0 || sx >= 12) return [0, 0, 0, 0];
    let ch = HERO[sy]![sx]!;
    if (sy >= 10) { const step = [0, 1, 2, 1, 0, -1, -2, -1][frame]!; const sx2 = sx - (sy === 11 ? step : Math.sign(step)); ch = HERO[sy]![Math.max(0, Math.min(11, sx2))]!; }
    return ch === '.' ? [0, 0, 0, 0] : col[ch]!;
  });
}

/** An 8x2 tileset of 16 px tiles: grass, dirt, stone, brick, water, a coin, a spike, a flag... */
export function tileset(): Buffer {
  const base: Array<[number, number, number]> = [[96, 170, 72], [134, 92, 56], [128, 132, 140], [170, 74, 58], [64, 132, 214], [34, 34, 44], [222, 186, 64], [190, 64, 64], [244, 244, 236], [80, 140, 96], [160, 120, 80], [100, 100, 110], [200, 100, 60], [90, 180, 220], [60, 60, 70], [240, 210, 120]];
  return png(128, 32, (x, y) => {
    const t = Math.floor(y / 16) * 8 + Math.floor(x / 16); const tx = x % 16; const ty = y % 16;
    const [r, g, b] = base[t]!;
    const edge = tx === 0 || ty === 0 || tx === 15 || ty === 15;
    const n = ((tx * 7 + ty * 13 + t * 5) % 9) - 4;
    if (t === 0 && ty < 4) return [70 + n * 3, 190 + n * 2, 64, 255];
    if (t === 6) { const d = Math.hypot(tx - 7.5, ty - 7.5); return d < 5 ? [250, 210, 70, 255] : d < 6 ? [180, 130, 30, 255] : [0, 0, 0, 0]; }
    if (t === 7) return ty > 15 - (8 - Math.abs(tx - 8)) * 1.6 ? [210, 210, 220, 255] : [0, 0, 0, 0];
    return [Math.max(0, r + n * 4 - (edge ? 24 : 0)), Math.max(0, g + n * 4 - (edge ? 24 : 0)), Math.max(0, b + n * 4 - (edge ? 24 : 0)), 255];
  });
}

/** A frame of the game at time t: sky, hills, a floor, coins, the player moving right. */
export function gameFrame(t: number, w = 320, h = 180): Buffer {
  const px = 30 + t * 2.6; const coins = [90, 150, 210, 270];
  return png(w, h, (x, y) => {
    const ground = 140 - Math.round(Math.sin(x / 40) * 4);
    if (y > ground) return (x + y) % 16 < 2 ? [88, 60, 40, 255] : [120, 84, 54, 255];
    if (y > ground - 6) return [86, 168, 70, 255];
    if (Math.abs(x - px) < 7 && y > ground - 26 && y <= ground - 6) return y < ground - 18 ? [242, 196, 160, 255] : [52, 112, 214, 255];
    for (const c of coins) if (c > px && Math.hypot(x - c, y - (ground - 22)) < 5) return [250, 206, 64, 255];
    if (x > 280 && x < 300 && y > ground - 46) return [120, 72, 40, 255];
    const hill = 112 + Math.round(Math.sin(x / 55 + 1) * 14);
    if (y > hill) return [150, 196, 150, 255];
    const k = y / h; return [Math.round(120 + 80 * k), Math.round(180 + 50 * k), 245, 255];
  });
}

/** A small animated GIF of the playthrough (indexed colours). */
export function playthroughGif(): Buffer {
  const W = 160; const H = 90;
  const pal = [[150, 200, 250], [86, 168, 70], [120, 84, 54], [52, 112, 214], [250, 206, 64], [242, 196, 160], [120, 72, 40]];
  const frames: Uint8Array[] = [];
  for (let f = 0; f < 6; f++) {
    const px = 14 + f * 22; const fr = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const g = 70 - Math.round(Math.sin(x / 20) * 2);
      let c = 0;
      if (y > g) c = 2; else if (y > g - 3) c = 1;
      else if (Math.abs(x - px) < 4 && y > g - 13) c = y < g - 9 ? 5 : 3;
      else if (x > 140 && x < 150 && y > g - 22) c = 6;
      else if ([45, 75, 105, 135].some((cx) => cx > px && Math.hypot(x - cx, y - (g - 11)) < 3)) c = 4;
      fr[y * W + x] = c;
    }
    frames.push(fr);
  }
  return gif(W, H, pal, frames, 25);
}

// ---------------- the project ----------------

export interface StudioSeed { projectDir: string; assets: string[]; playtest: string; library?: string; triangles: number }

const write = (file: string, data: string | Buffer) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/** Seeds a project "Coin Escape" in root/coin-escape (and, with home, a library asset in home/assets). */
export function seedStudio(root: string, o: { home?: string } = {}): StudioSeed {
  const dir = path.join(root, 'coin-escape');
  const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  write(path.join(dir, '.studio', 'project.json'), json({
    name: 'Coin Escape', engine: 'godot', dimension: '3d', genre: 'third-person collect-and-escape', created: at(600),
    engineProject: 'game/project.godot', design: 'design/GDD.md',
    budgets: { fps: 60, frameMs: 16.7, memoryMb: 2048, trianglesPerAsset: 20000, textureMax: 2048 },
    stages: [
      { id: 'brief', title: 'Brief', status: 'done', approvedAt: at(560) },
      { id: 'design', title: 'Design', status: 'approved', approvedAt: at(500), approvedBy: 'Suhail' },
      { id: 'prototype', title: 'Prototype', status: 'review', note: 'Graybox level with the core loop: collect ten coins, the exit door opens, reach it. Playtest pt-20261023-1 passed.' },
      { id: 'vertical-slice', title: 'Vertical slice', status: 'pending' },
      { id: 'content', title: 'Content', status: 'pending' },
      { id: 'package', title: 'Package', status: 'pending' },
    ],
    builds: [
      { id: 'b1', platform: 'linux', path: 'build/b1/coin-escape.x86_64', status: 'failed', at: at(90), log: '.studio/builds/b1/build.log' },
      { id: 'b2', platform: 'linux', path: 'build/b2/coin-escape.x86_64', status: 'ok', at: at(30), took: 48.2 },
    ],
    playtests: ['pt-20261023-1'],
  }));
  write(path.join(dir, 'design', 'GDD.md'), '# Coin Escape\n\nA third-person collect-and-escape game.\n\n## Core loop\n\n- Run and jump across the level\n- Collect **ten coins**\n- The exit door opens after the last coin; reach it to win\n\n## Controls\n\n| Key | Action |\n|---|---|\n| WASD | move |\n| Space | jump |\n\n## Art direction\n\nStylized low-poly, warm palette, readable silhouettes.\n');
  write(path.join(dir, 'game', 'project.godot'), '[application]\nconfig/name="Coin Escape"\nrun/main_scene="res://levels/level_1.tscn"\n');
  write(path.join(dir, 'game', 'scripts', 'player.gd'), 'extends CharacterBody3D\n\nconst SPEED = 6.0\n\nfunc _physics_process(delta):\n\tvar dir = Input.get_vector("left", "right", "up", "down")\n\tvelocity.x = dir.x * SPEED\n\tvelocity.z = dir.y * SPEED\n\tvelocty.y -= 9.8 * delta\n\tmove_and_slide()\n');
  write(path.join(dir, 'game', 'levels', 'level_1.tscn'), '[gd_scene load_steps=3 format=3]\n\n[node name="Level1" type="Node3D"]\n\n[node name="Player" type="CharacterBody3D" parent="."]\n\n[node name="Camera" type="Camera3D" parent="Player"]\n\n[node name="Coins" type="Node3D" parent="."]\n\n[node name="Coin1" type="Area3D" parent="Coins"]\n\n[node name="ExitDoor" type="StaticBody3D" parent="."]\n');
  write(path.join(dir, '.studio', 'builds', 'b1', 'build.log'), [
    'Godot Engine v4.3.stable.official - https://godotengine.org',
    'Exporting "Linux" to build/b1/coin-escape.x86_64',
    'SCRIPT ERROR: Parse Error: Identifier "velocty" not declared in the current scope.',
    '          at: GDScript::reload (res://scripts/player.gd:9)',
    'WARNING: res://levels/level_1.tscn has 2 unused resources',
    'ERROR: Failed to load script "res://scripts/player.gd" with error "Parse error".',
    'BUILD FAILED: export did not finish',
  ].join('\n'));

  // Assets.
  const A = (id: string) => path.join(dir, '.studio', 'assets', id);
  const barrel = barrelGlb(24); const lod = barrelGlb(8);
  write(path.join(A('barrel-wood-01'), 'barrel.glb'), barrel.glb);
  write(path.join(A('barrel-wood-01'), 'barrel_lod1.glb'), lod.glb);
  write(path.join(A('barrel-wood-01'), 'asset.json'), json({
    id: 'barrel-wood-01', name: 'Wooden barrel', kind: 'model', dimension: '3d',
    files: [{ path: 'barrel.glb', role: 'main' }, { path: 'barrel_lod1.glb', role: 'lod1' }],
    source: { type: 'procedural', generator: 'blender:barrel', seed: 42, params: { staves: 24, bands: 2 } },
    license: { id: 'CC0-1.0', author: 'Studio (procedural)' }, hashes: { 'barrel.glb': 'sha256:9f2c4e1d0b7a6c5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e' },
    tags: ['prop', 'wood'], style: 'stylized-lowpoly', meta: { triangles: barrel.triangles, sizeM: [0.69, 0.9, 0.69] },
    checks: [{ gate: 'asset-budget', pass: true, summary: `${barrel.triangles} tris <= 20000`, at: at(120) }, { gate: 'uv-present', pass: true, summary: 'every mesh has UVs', at: at(120) }, { gate: 'scale', pass: true, summary: '0.9 m tall: a barrel', at: at(120) }],
    engines: { godot: { path: 'res://assets/barrel.glb', importedAt: at(100) } }, created: at(130), updated: at(120),
  }));
  write(path.join(A('hero-walk'), 'hero_walk.png'), heroSheet());
  write(path.join(A('hero-walk'), 'asset.json'), json({
    id: 'hero-walk', name: 'Hero walk cycle', kind: 'spritesheet', dimension: '2d', files: [{ path: 'hero_walk.png', role: 'main' }],
    source: { type: 'generated', provider: 'pixel-lab', model: 'sprite-v2', prompt: 'a small hero in a blue tunic, 8-frame walk cycle, 32x32 pixel art' },
    license: { id: 'CC-BY-4.0', author: 'Studio', url: 'https://creativecommons.org/licenses/by/4.0/' }, tags: ['character', 'player'], style: 'pixel-art',
    meta: { frames: 8, frameSize: [32, 32], fps: 10 }, checks: [{ gate: 'frame-size', pass: true, summary: '8 frames of 32x32', at: at(80) }, { gate: 'palette', pass: false, summary: '41 colours (the style guide allows 32)', at: at(80) }], created: at(85),
  }));
  write(path.join(A('tiles-meadow'), 'tiles.png'), tileset());
  write(path.join(A('tiles-meadow'), 'asset.json'), json({ id: 'tiles-meadow', name: 'Meadow tileset', kind: 'tileset', dimension: '2d', files: [{ path: 'tiles.png', role: 'main' }], source: { type: 'procedural', generator: 'studio:tiles', seed: 7 }, license: { id: 'CC0-1.0' }, style: 'pixel-art', meta: { tile: 16 }, created: at(70) }));
  const W = 40; const H = 14;
  const ground = Array.from({ length: W * H }, (_, i) => { const x = i % W; const y = Math.floor(i / W); if (y === H - 1) return 2; if (y === H - 2) return x > 17 && x < 21 ? 0 : 1; if (y === 7 && x > 8 && x < 14) return 4; if (y === 5 && x > 24 && x < 31) return 4; return 0; });
  const items = Array.from({ length: W * H }, (_, i) => { const x = i % W; const y = Math.floor(i / W); if (y === 6 && x > 9 && x < 13) return 7; if (y === 4 && x > 25 && x < 30 && x % 2) return 7; if (y === H - 3 && (x === 15 || x === 33)) return 8; return 0; });
  write(path.join(A('level-1'), 'level_1.json'), json({ width: W, height: H, tilewidth: 16, tileheight: 16, tilesets: [{ firstgid: 1, image: '../tiles-meadow/tiles.png', tilewidth: 16, tileheight: 16, columns: 8 }],
    layers: [{ type: 'tilelayer', name: 'ground', width: W, height: H, data: ground }, { type: 'tilelayer', name: 'items', width: W, height: H, data: items }, { type: 'objectgroup', name: 'spawns', objects: [{ name: 'start', x: 16, y: 160, width: 16, height: 32 }, { name: 'goal', x: 592, y: 144, width: 16, height: 48 }] }] }));
  write(path.join(A('level-1'), 'asset.json'), json({ id: 'level-1', name: 'Meadow level 1', kind: 'level', dimension: '2d', files: [{ path: 'level_1.json', role: 'main' }], source: { type: 'procedural', generator: 'studio:level', seed: 3 }, license: { id: 'CC0-1.0' }, meta: { tile: 16 }, created: at(60) }));
  const rate = 22050; const n = Math.round(rate * 0.45);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / rate; const f = 520 + 900 * t; s[i] = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 7) * 0.8 + (i < 300 ? (Math.random() - 0.5) * 0.4 : 0); }
  write(path.join(A('sfx-coin'), 'coin.wav'), wav(s, rate));
  write(path.join(A('sfx-coin'), 'asset.json'), json({ id: 'sfx-coin', name: 'Coin pickup', kind: 'audio', dimension: '2d', files: [{ path: 'coin.wav', role: 'main' }], source: { type: 'procedural', generator: 'studio:sfx', seed: 11, params: { wave: 'sine', sweep: [520, 920] } }, license: { id: 'CC0-1.0' }, meta: { durationS: 0.45 }, created: at(50) }));

  // Renders.
  for (const [i, t] of [[1, 20], [2, 60]] as const) write(path.join(dir, 'renders', `level_1_v${i}.png`), gameFrame(t));

  // The playtest.
  const pt = path.join(dir, '.studio', 'playtests', 'pt-20261023-1');
  const times = [0, 12, 24, 36, 48, 60, 72, 84, 94];
  times.forEach((t, i) => write(path.join(pt, 'frames', `${String(i * 40).padStart(4, '0')}.png`), gameFrame(t)));
  write(path.join(pt, 'playthrough.gif'), playthroughGif());
  write(path.join(pt, 'report.json'), json({
    id: 'pt-20261023-1', engine: 'godot', build: 'b2', player: 'ai', goal: 'collect all coins and reach the exit', result: 'pass', durationS: 94.2, steps: 312,
    events: [
      { t: 0.4, type: 'start', detail: 'level 1 loaded', frame: 'frames/0000.png' }, { t: 3.2, type: 'pickup', detail: 'coin 1/10' }, { t: 12.5, type: 'pickup', detail: 'coin 3/10', frame: 'frames/0040.png' },
      { t: 24, type: 'pickup', detail: 'coin 5/10', frame: 'frames/0080.png' }, { t: 40.1, type: 'stuck', detail: 'no progress for 8s', frame: 'frames/0120.png' }, { t: 48, type: 'fall', detail: 'fell off the east ledge, respawned' },
      { t: 60, type: 'pickup', detail: 'coin 8/10', frame: 'frames/0200.png' }, { t: 84, type: 'pickup', detail: 'coin 10/10: the door opens', frame: 'frames/0280.png' }, { t: 93.8, type: 'win', detail: 'reached the exit', frame: 'frames/0320.png' },
    ],
    metrics: { fpsAvg: 59.8, fpsMin: 41, frameMsP95: 18.2, memoryMb: 640, errors: 0 },
    series: { fps: times.map((t, i) => [t, i === 4 ? 41 : 58 + (i % 3)]) },
    frames: times.map((_, i) => `frames/${String(i * 40).padStart(4, '0')}.png`), recording: 'playthrough.gif',
    issues: [{ severity: 'major', title: 'The player gets stuck on the crate stack at x=12', detail: 'Walking into the corner between the crates stops all progress for 8 s; jumping does not clear it.', evidence: 'frames/0120.png', t: 40.1 }, { severity: 'minor', title: 'The east ledge has no edge marker', evidence: 'frames/0160.png', t: 48 }],
    verdicts: [{ by: 'vision', claim: 'the exit door opens after the last coin', pass: true, evidence: 'frames/0280.png' }, { by: 'vision', claim: 'the score UI shows the coins collected', pass: true, evidence: 'frames/0200.png' }],
  }));

  let library: string | undefined;
  if (o.home) {
    library = path.join(o.home, 'assets', 'crate-kenney');
    write(path.join(library, 'crate.png'), png(64, 64, (x, y) => { const e = x < 4 || y < 4 || x > 59 || y > 59 || Math.abs(x - y) < 3 || Math.abs(63 - x - y) < 3; return e ? [110, 70, 36, 255] : [176, 124, 70, 255]; }));
    write(path.join(library, 'asset.json'), json({ id: 'crate-kenney', name: 'Wooden crate (sprite)', kind: 'sprite', dimension: '2d', files: [{ path: 'crate.png', role: 'main' }], source: { type: 'library', provider: 'kenney', url: 'https://kenney.nl/assets', id: 'crate' }, license: { id: 'CC0-1.0', author: 'Kenney', url: 'https://kenney.nl' }, style: 'flat' }));
  }
  return { projectDir: dir, assets: ['barrel-wood-01', 'hero-walk', 'tiles-meadow', 'level-1', 'sfx-coin'], playtest: 'pt-20261023-1', ...(library ? { library } : {}), triangles: barrel.triangles };
}
