import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runGates } from '../src/gates/gates.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { LocalHost } from '../src/runtime/host.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir } from './helpers.ts';

// The asset studio (plugins/games3d/assets): the pure-JS raster core, 2D builders,
// procedural generation, audio, the library and its gates, and the optional sources with
// fake fetches. Blender runs in studio-assets-blender.test.ts (HARNESS_REAL_BLENDER=1).

const here = path.dirname(fileURLToPath(import.meta.url));
const A = path.join(here, '..', 'plugins', 'games3d', 'assets');
const mod = (p: string) => import(new URL(`file:///${path.join(A, p).replace(/\\/g, '/')}`).href);
const { Image, normalMap } = await mod('raster/image.mjs');
const { encodePNG, decodePNG, encodeGray16 } = await mod('raster/png.mjs');
const { parseColor, ramp } = await mod('raster/color.mjs');
const { quantize, paletteOf, medianCut } = await mod('raster/palette.mjs');
const { fontAtlas, drawText, measureText } = await mod('raster/font.mjs');
const { noiseField } = await mod('gen/noise.mjs');
const { heightmap, splatMap } = await mod('gen/heightmap.mjs');
const L = await mod('gen/levels.mjs');
const { platformer, solvePlatformer, physicsOf } = await mod('gen/platformer.mjs');
const { wfcTiled, wfcOverlapping } = await mod('gen/wfc.mjs');
const { expand, turtle3d, PRESETS } = await mod('gen/lsystem.mjs');
const { names } = await mod('gen/names.mjs');
const { toTiled, checkTiled } = await mod('gen/tiled.mjs');
const { renderSprite } = await mod('sprites/sprite.mjs');
const { KINDS } = await mod('sprites/kinds.mjs');
const { packSheet, asepriteJson, godotSpriteFrames, framesJson, checkSheet } = await mod('sprites/sheet.mjs');
const { blobTileset, cornerTileset, autotileBlob, BLOB_MASKS, reduceBlob, terrainTexture, TERRAINS } = await mod('sprites/tiles.mjs');
const { uiKit } = await mod('sprites/ui.mjs');
const { parallax, isoTile, particle, PARTICLES } = await mod('sprites/scenery.mjs');
const { synth, preset, SFX_PRESETS } = await mod('audio/sfxr.mjs');
const { music, parseProgression } = await mod('audio/music.mjs');
const { encodeWav, decodeWav, analyze, loudness, normalize } = await mod('audio/wav.mjs');
const { readZip, writeZip } = await mod('sources/zip.mjs');
const { estimateImageUsd, costFromUsage, SpendLedger } = await mod('sources/generators.mjs');
const { setupAssets } = await mod('index.mjs');

const ctxOf = (root: string, services?: unknown) => ({ host: new LocalHost(root), signal: new AbortController().signal, readFiles: new Map(), todos: [], setTodos() {}, emit() {}, services }) as unknown as ToolContext;
const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

type Tool = { name: string; run: (i: Record<string, unknown>, c: ToolContext) => Promise<{ content: string; is_error?: boolean; images?: unknown[] } | string> };
type Gate = { name: string; run: (c: { host: LocalHost; signal: AbortSignal }) => Promise<{ pass: boolean; summary: string; details?: string }>; applies?: (h: LocalHost, s: AbortSignal) => Promise<boolean> };

/** setupAssets against a fake plugin API: the tools and gates it registers, a fetch and secrets the test controls. */
async function fakeApi(fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>, secrets: Record<string, string> = {}) {
  const tools = new Map<string, Tool>();
  const gates = new Map<string, Gate>();
  const dataDir = await tempDir('studio-data-');
  const api = {
    pluginName: 'games3d', pluginDir: path.dirname(A), dataDir,
    registerTool: (t: { spec: { name: string }; run: Tool['run'] }) => tools.set(t.spec.name, { name: t.spec.name, run: t.run }),
    registerGate: (g: Gate) => gates.set(g.name, g),
    secret: (n: string) => secrets[n],
    fetch: fetchImpl ?? (async () => { throw new Error('no network in this test'); }),
    log() {},
  };
  setupAssets(api);
  return { tools, gates, dataDir };
}
const out = async (p: Promise<unknown>) => { const r = await p as { content: string; is_error?: boolean } | string; return typeof r === 'string' ? { content: r, is_error: false } : r; };

// ---------- raster core ----------

test('PNG: RGBA round trip, 16-bit greyscale samples, palette and interlaced decoding', async () => {
  const img = new Image(37, 21);
  img.paint((x: number, y: number) => [x * 6, y * 12, (x * y) % 256, (x + y) % 3 ? 255 : 90], { blend: false });
  const back = decodePNG(encodePNG(img));
  assert.equal(back.width, 37);
  assert.ok(sameBytes(back.data, img.data), 'every pixel survives');
  const h = new Float32Array(9 * 5).map((_, i) => i / 44);
  const d = decodePNG(encodeGray16(h, 9, 5), { samples: true });
  assert.equal(d.depth, 16);
  assert.ok(Math.abs(d.samples[44] - 1) < 1e-4 && Math.abs(d.samples[22] - 0.5) < 1e-4, 'full 16-bit precision');
  assert.throws(() => decodePNG(Buffer.from('nope')), /not a PNG/);
});

test('drawing: shapes, gradients, outline, scale, blur, colour key, quantize, normal map', () => {
  const img = new Image(32, 32);
  img.rect(4, 4, 8, 8, '#ff0000');
  img.circle(20, 20, 6, '#00ff00');
  img.polygon([[2, 30], [10, 18], [16, 30]], '#0000ff');
  img.line(0, 0, 31, 31, '#ffffff');
  assert.deepEqual(img.get(5, 9), [255, 0, 0, 255]);
  assert.deepEqual(img.get(22, 17), [0, 255, 0, 255]);
  const o = img.outline('#000000');
  assert.deepEqual(o.get(3, 6), [0, 0, 0, 255], 'outline around the rect');
  assert.equal(img.scale(64, 64).width, 64);
  assert.deepEqual(img.scale(64, 64).get(10, 18), [255, 0, 0, 255], 'nearest keeps pixels');
  const g = new Image(16, 4); g.linearGradient(0, 0, 16, 0, [[0, '#000000'], [1, '#ffffff']], { steps: 4 });
  assert.ok(g.colors().size <= 4, 'banded into 4 colours');
  const bg = new Image(20, 20, '#ff00ff'); bg.rect(5, 5, 10, 10, '#ff00ff'); bg.rect(7, 7, 6, 6, '#123456');
  const keyed = bg.colorKey('auto' === 'auto' ? bg.borderColor() : '#000');
  assert.equal(keyed.alpha(0, 0), 0); assert.equal(keyed.alpha(10, 10), 255);
  const q = quantize(img, paletteOf('pico8'));
  for (const c of q.colors()) assert.ok(paletteOf('pico8').some((p: [number, number, number]) => ((p[0] << 16) | (p[1] << 8) | p[2]) === c), 'only palette colours');
  assert.equal(medianCut(img, 4).length, 4);
  const blurred = img.blur(2);
  assert.ok(blurred.alpha(3, 6) > 0 && blurred.alpha(3, 6) < 255, 'blur softens edges');
  const n = normalMap(new Float32Array(64).map((_, i) => (i % 8) / 7), 8, 8, { wrap: false });
  const c = n.get(4, 4);
  assert.ok(c[0] < 128 && c[2] > 128, 'a slope rising to the right tilts the normal left (OpenGL)');
  assert.deepEqual(parseColor('#abc'), [170, 187, 204, 255]);
  assert.equal(ramp('#3d7fd0', 5).length, 5);
});

test('bitmap font: text measures and draws; the atlas, BMFont and JSON agree', () => {
  const m = measureText('HELLO');
  assert.ok(m.width > 20 && m.height === 7);
  const img = new Image(40, 10); drawText(img, 'Hi!', 1, 1, '#fff');
  assert.ok(img.colors().size === 1 && img.bounds());
  const f = fontAtlas({ scale: 2, outline: '#000' });
  assert.equal(f.json.chars.length, 95);
  assert.match(f.fnt, /^info face="Studio5x7"/);
  assert.match(f.fnt, /chars count=95/);
  const a = f.json.chars.find((c: { char: string }) => c.char === 'A');
  assert.ok(a.x + a.width <= f.image.width && a.y + a.height <= f.image.height);
});

// ---------- 2D builders ----------

test('sprites: every kind renders deterministically by seed, with transparent corners and an outline', () => {
  for (const kind of Object.keys(KINDS)) {
    const a = renderSprite({ kind, seed: 7 }), b = renderSprite({ kind, seed: 7 }), c = renderSprite({ kind, seed: 8 });
    const fa = Object.values(a.frames)[0] as InstanceType<typeof Image>[];
    const fb = Object.values(b.frames)[0] as InstanceType<typeof Image>[];
    assert.ok(sameBytes(fa[0].data, fb[0].data), `${kind}: same seed, same pixels`);
    const img = fa[0];
    assert.equal(img.alpha(0, 0), 0, `${kind}: transparent corner`);
    assert.ok(img.bounds(), `${kind}: draws something`);
    assert.ok(img.colors().size >= 4, `${kind}: shaded (${img.colors().size} colours)`);
    void c;
  }
  const s1 = renderSprite({ kind: 'character', seed: 1 }), s2 = renderSprite({ kind: 'character', seed: 2 });
  assert.ok(!sameBytes(s1.frames.idle[0].data, s2.frames.idle[0].data), 'another seed, another character');
  assert.deepEqual(Object.keys(s1.frames), ['idle', 'walk', 'jump', 'attack', 'hurt']);
  assert.equal(s1.frames.walk.length, 6);
  assert.ok(!sameBytes(s1.frames.walk[0].data, s1.frames.walk[1].data), 'walk frames differ');
  const big = renderSprite({ kind: 'slime', seed: 1, size: 64 });
  assert.equal(big.frames.idle[0].width, 64);
  const pal = renderSprite({ kind: 'gem', seed: 1, palette: 'db16' });
  assert.ok(pal.frames.idle[0].colors().size <= 16);
  assert.throws(() => renderSprite({ kind: 'dragon' }), /unknown sprite kind/);
});

test('sprite sheets: Aseprite JSON, Godot SpriteFrames and frames JSON describe the packed frames', () => {
  const s = renderSprite({ kind: 'character', seed: 3, anims: ['idle', 'walk'] });
  const sheet = packSheet(s.frames, { padding: 1, fps: 8 });
  assert.equal(sheet.frames.length, 10);
  assert.equal(sheet.image.width, 6 * 33 - 1);
  const ase = asepriteJson(sheet);
  assert.equal(Object.keys(ase.frames).length, 10);
  assert.deepEqual(ase.meta.frameTags.map((t: { name: string }) => t.name), ['idle', 'walk']);
  assert.deepEqual(checkSheet(ase, sheet.image, [32, 32]).problems, []);
  assert.deepEqual(checkSheet(framesJson(sheet), sheet.image, [32, 32]).problems, []);
  assert.match(checkSheet(ase, { width: 50, height: 50 }, [32, 32]).problems.join(' '), /outside/);
  const tres = godotSpriteFrames(sheet, { texturePath: 'res://a/sheet.png' });
  assert.match(tres, /^\[gd_resource type="SpriteFrames" load_steps=12 format=3\]/);
  assert.equal((tres.match(/\[sub_resource type="AtlasTexture"/g) ?? []).length, 10);
  assert.match(tres, /"name": &"walk"/);
  assert.match(tres, /region = Rect2\(33, 0, 32, 32\)/);
});

test('tilesets: seamless terrain, 16-corner and 47-blob sets whose neighbouring tiles match at the edges', () => {
  for (const t of Object.keys(TERRAINS)) {
    const img = terrainTexture(t, 16, { seed: 1 });
    assert.equal(img.width, 16);
  }
  assert.equal(BLOB_MASKS.length, 47);
  assert.equal(reduceBlob(0b11111111), 255);
  assert.equal(reduceBlob(2), 0, 'a lone corner does not count');
  const set = blobTileset({ a: 'grass', b: 'dirt', size: 16, seed: 2 });
  assert.equal(set.count, 48);
  assert.equal(set.rules.lookup.length, 256);
  assert.equal(set.wangset.wangtiles.length, 48);
  // Autotile a random map and check the colour of every shared edge pixel pair is the same terrain.
  const grid = Array.from({ length: 10 }, (_, y) => Array.from({ length: 12 }, (_, x) => ((x * 7 + y * 13) % 5) > 1));
  const idx = autotileBlob(grid);
  const map = new Image(12 * 16, 10 * 16);
  idx.forEach((row: number[], y: number) => row.forEach((t: number, x: number) => map.draw(set.tiles[t], x * 16, y * 16, { mode: 'replace' })));
  const greenish = (c: [number, number, number, number]) => c[1] > c[0];
  let mismatches = 0, edges = 0;
  for (let ty = 0; ty < 10; ty++) for (let tx = 0; tx < 11; tx++) for (let k = 4; k < 12; k++) {
    edges++;
    if (greenish(map.get(tx * 16 + 15, ty * 16 + k)) !== greenish(map.get(tx * 16 + 16, ty * 16 + k))) mismatches++;
  }
  assert.ok(mismatches / edges < 0.12, `seams: ${mismatches} of ${edges} edge pixel pairs change terrain`);
  const cs = cornerTileset({ a: 'grass', b: 'water', size: 16 });
  assert.equal(cs.count, 16);
  assert.ok(cs.tiles[15].colors().size > 2 && cs.tiles[0].colors().size > 2);
});

test('UI kit, parallax, iso and particles build at their sizes', () => {
  const k = uiKit({ scales: [1, 2] });
  assert.ok(k.files.some((f: { path: string }) => f.path === 'button_normal@2x.png'));
  assert.ok(k.files.some((f: { path: string }) => f.path === 'icon_star.svg'));
  assert.deepEqual(k.kit.panels.bevel.slice, { left: 4, top: 4, right: 4, bottom: 4 });
  const p = parallax({ width: 128, height: 72, seed: 1 });
  assert.deepEqual(p.layers.map((l: { name: string }) => l.name), ['sky', 'far', 'mid', 'clouds', 'hills', 'trees']);
  // Layers tile horizontally: the first and last columns are close.
  const far = p.layers[1].image;
  let diff = 0;
  for (let y = 0; y < 72; y++) diff += Math.abs(far.alpha(0, y) - far.alpha(127, y));
  assert.ok(diff / 72 < 40, `far mountains wrap (${diff / 72})`);
  const iso = isoTile('grass', { width: 32, depth: 16 });
  assert.deepEqual([iso.width, iso.height], [32, 32]);
  assert.equal(iso.alpha(0, 0), 0);
  for (const kind of PARTICLES) assert.ok(particle(kind)[0].bounds(), kind);
});

// ---------- procedural generation ----------

test('noise and heightmaps: deterministic, in range, tileable when asked', () => {
  const a = noiseField({ width: 64, height: 64, seed: 3, tileable: true, scale: 16 });
  const b = noiseField({ width: 64, height: 64, seed: 3, tileable: true, scale: 16 });
  assert.ok(a.every((v: number, i: number) => v === b[i]));
  assert.ok(Math.min(...a) === 0 && Math.max(...a) > 0.9999);
  let edge = 0;
  for (let y = 0; y < 64; y++) edge += Math.abs(a[y * 64] - a[y * 64 + 63]);
  assert.ok(edge / 64 < 0.08, `left and right edges meet (${edge / 64})`);
  for (const type of ['value', 'simplex', 'worley', 'ridged']) assert.equal(noiseField({ width: 16, height: 16, type, seed: 1 }).length, 256);
  const h = heightmap({ size: 65, seed: 1, island: true });
  assert.equal(h.length, 65 * 65);
  assert.ok(h[0] < 0.3, 'an island is low at its edge');
  const s = splatMap(h, 65);
  for (let i = 0; i < 65 * 65; i += 97) assert.equal(s.data[i * 4] + s.data[i * 4 + 1] + s.data[i * 4 + 2] + s.data[i * 4 + 3], 255);
});

test('dungeons, caves, mazes and maps connect start to exit for many seeds; same seed, same level', () => {
  for (let seed = 1; seed <= 12; seed++) {
    for (const [type, level] of [['dungeon', L.dungeon({ seed })], ['cave', L.caves({ seed })], ['maze', L.maze({ seed, algorithm: ['backtracker', 'prim', 'kruskal', 'binary'][seed % 4], braid: seed % 3 ? 0 : 0.4 })], ['topdown', L.topdown({ seed })]] as const) {
      const r = L.checkConnected(level.rows, type);
      assert.ok(r.ok, `${type} seed ${seed}: ${r.reason}`);
      if (type !== 'topdown') assert.ok(r.reachable > 0.99, `${type} seed ${seed}: all floor reachable (${r.reachable})`);
    }
  }
  assert.deepEqual(L.dungeon({ seed: 5 }).rows, L.dungeon({ seed: 5 }).rows);
  assert.notDeepEqual(L.dungeon({ seed: 5 }).rows, L.dungeon({ seed: 6 }).rows);
  assert.equal(L.checkConnected(['S#E'], 'maze').ok, false);
});

test('platformer: generated levels are proven finishable by the solver; impossible ones are refused', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const lv = platformer({ seed, length: 90, difficulty: (seed % 5) / 5 });
    assert.ok(lv.proof.ok, `seed ${seed}`);
    assert.ok(solvePlatformer(lv.rows, lv.physics).ok, `seed ${seed}: solving again agrees`);
    assert.equal(lv.rows[0].length >= 90, true);
  }
  // A gap of 12 tiles cannot be jumped with 3.2 tiles of jump height at 6 tiles/s.
  const wide = ['..........................', 'S.......................E.', '######............########'];
  assert.equal(solvePlatformer(wide, {}).ok, false);
  // With a faster run (a 14.4-tile jump) it can.
  assert.equal(solvePlatformer(wide, { runSpeed: 18 }).ok, true);
  // A wall two tiles higher than the jump.
  const wall = ['.....#....', '.....#....', '.....#....', '.....#....', 'S....#...E', '##########'];
  assert.equal(solvePlatformer(wall, {}).ok, false);
  assert.equal(solvePlatformer(wall, { jumpHeight: 5.5 }).ok, true);
  // Spikes are deadly: a floor of spikes with no way over.
  const spikes = ['S^^^^^^^^^^^^^^E', '################'];
  assert.equal(solvePlatformer(spikes, {}).ok, false);
  // One-way platforms carry the player from below.
  const oneway = ['..........E', '.......----', '...........', '...----....', 'S..........', '###########'];
  assert.equal(solvePlatformer(oneway, {}).ok, true);
  const P = physicsOf({ jumpHeight: 3.2, runSpeed: 6, gravity: 40 });
  assert.ok(Math.abs(P.jumpDistance - 6 * 2 * Math.sqrt(2 * 40 * 3.2) / 40) < 1e-9);
});

test('Wave Function Collapse: tiled sets respect their sockets; the overlapping model reproduces sample patterns', () => {
  for (const tiles of ['roads', 'coast']) {
    const r = wfcTiled({ tiles, width: 14, height: 10, seed: 4 });
    assert.ok(r.ok, `${tiles}: ${r.reason}`);
    const byId = Object.fromEntries(r.tiles.map((t: { id: string }) => [t.id, t]));
    const rev = (s: string) => [...s].reverse().join('');
    for (let y = 0; y < 10; y++) for (let x = 0; x < 14; x++) {
      const t = byId[r.grid[y][x]];
      if (x < 13) assert.equal(t.sockets[1], rev(byId[r.grid[y][x + 1]].sockets[3]), `${tiles} ${x},${y} east`);
      if (y < 9) assert.equal(t.sockets[2], rev(byId[r.grid[y + 1][x]].sockets[0]), `${tiles} ${x},${y} south`);
    }
  }
  const sample = ['........', '..####..', '..#..#..', '..####..', '........'];
  const o = wfcOverlapping({ sample, n: 2, width: 16, height: 12, seed: 1, periodicInput: true });
  assert.ok(o.ok, o.reason);
  assert.equal(o.rows.length, 12);
  assert.ok(o.rows.every((r: string) => /^[.#]+$/.test(r)));
  assert.deepEqual(wfcTiled({ tiles: 'roads', width: 8, height: 8, seed: 2 }).grid, wfcTiled({ tiles: 'roads', width: 8, height: 8, seed: 2 }).grid);
});

test('L-systems, names and Tiled export', () => {
  const s = expand({ ...PRESETS.tree, seed: 1 });
  assert.ok(s.length > 100);
  assert.equal(s, expand({ ...PRESETS.tree, seed: 1 }));
  const t = turtle3d(s, { ...PRESETS.tree, seed: 1 });
  assert.ok(t.segments.length > 20 && t.leaves.length > 5);
  assert.ok(Math.max(...t.segments.map((x: { b: number[] }) => x.b[2])) > 2, 'the tree grows up (+Z)');
  const n = names({ style: 'elven', count: 20, seed: 1 });
  assert.equal(new Set(n).size, 20);
  assert.deepEqual(n, names({ style: 'elven', count: 20, seed: 1 }));
  assert.match(names({ style: 'tavern', count: 1, seed: 2 })[0], /^The /);
  const tmj = toTiled({ rows: ['#S.E', '####'], tileSize: 16, tiles: ['#', '.'], objects: { S: { type: 'start', under: '.' }, E: { type: 'exit', under: '.' } } });
  assert.deepEqual(checkTiled(tmj, 2), []);
  assert.deepEqual(tmj.layers[0].data, [1, 2, 2, 2, 1, 1, 1, 1]);
  assert.equal(tmj.layers[1].objects.length, 2);
  assert.equal(tmj.layers[1].objects[0].x, 24);
});

// ---------- audio ----------

test('audio: every sfx preset makes a valid, audible, unclipped WAV; same seed, same sound', () => {
  for (const p of SFX_PRESETS) for (const seed of [1, 2, 3]) {
    const s = synth(preset(p, seed), { seed });
    assert.ok(s.length > 1000, `${p} ${seed}: ${s.length} samples`);
    const n = normalize([s], 44100, { target: -14 });
    const w = decodeWav(encodeWav(n.channels, 44100));
    const a = analyze(w.channels, w.sampleRate);
    assert.ok(a.peakDb > -30 && a.peakDb <= -0.9, `${p}: peak ${a.peakDb}`);
    assert.equal(a.clipped, 0);
  }
  assert.ok(sameBytes(encodeWav([synth(preset('laser', 9), { seed: 9 })]), encodeWav([synth(preset('laser', 9), { seed: 9 })])));
});

test('loudness is BS.1770: a full-scale 1 kHz sine reads -3 LUFS; normalization hits the target under the ceiling', () => {
  const sine = new Float32Array(44100 * 2).map((_, i) => Math.sin((i / 44100) * 2 * Math.PI * 1000));
  assert.ok(Math.abs(loudness([sine], 44100) + 3.01) < 0.05);
  assert.ok(Math.abs(loudness([sine.map((v) => v * 0.1)], 44100) + 23.01) < 0.05);
  const n = normalize([sine.map((v) => v * 0.05)], 44100, { target: -16 });
  assert.ok(Math.abs(n.after.lufs + 16) < 0.2);
  const loud = normalize([sine.map((v) => v * 0.05)], 44100, { target: 0, ceiling: -1 });
  assert.ok(loud.limited && loud.after.peakDb <= -0.99);
  const w = decodeWav(encodeWav([sine, sine], 48000));
  assert.equal(w.channels.length, 2); assert.equal(w.sampleRate, 48000);
  assert.throws(() => decodeWav(Buffer.from('RIFF0000WAVE')), /fmt|data/);
});

test('music: chord progressions parse; loops have the length of their bars and are seamless', () => {
  assert.deepEqual(parseProgression('I V vi IV', 'C').map((c: { notes: number[] }) => c.notes), [[60, 64, 67], [67, 71, 74], [69, 72, 76], [65, 69, 72]]);
  assert.deepEqual(parseProgression('Am F', 'C').map((c: { notes: [number] }) => c.notes[0] % 12), [9, 5]);
  assert.deepEqual(parseProgression('i VI', 'A', 'minor').map((c: { notes: [number] }) => c.notes[0] % 12), [9, 5]);
  const m = music({ style: 'chiptune', seed: 1, bpm: 120, repeats: 1 });
  assert.equal(m.duration, 8);
  assert.equal(m.samples.length, 8 * 44100);
  const a = analyze([m.samples], 44100);
  assert.ok(a.peakDb > -20 && Number.isFinite(a.lufs));
  // Seamless: the last and first samples are close (no click at the loop point).
  assert.ok(Math.abs(m.samples[0] - m.samples[m.samples.length - 1]) < 0.15);
  const amb = music({ style: 'ambient', seed: 2, progression: 'Am F C G', repeats: 1 });
  assert.ok(amb.duration > 10);
});

// ---------- zip and cost ----------

test('zip: reads stored and deflated entries; refuses unsafe paths', () => {
  const z = writeZip([{ name: 'a/b.txt', data: 'hello' }, { name: 'c.png', data: Buffer.from([1, 2, 3]) }]);
  const e = readZip(z);
  assert.deepEqual(e.map((x: { name: string }) => x.name), ['a/b.txt', 'c.png']);
  assert.equal(e[0].data().toString(), 'hello');
  assert.throws(() => readZip(writeZip([{ name: '../evil', data: 'x' }])), /unsafe/);
});

test('image cost: estimated from the price table before a call, computed from usage after', async () => {
  const est = estimateImageUsd({ model: 'gpt-image-1', quality: 'low', size: '1024x1024', prompt: 'x'.repeat(400) });
  assert.ok(Math.abs(est - (272 * 40 + 100 * 5) / 1e6) < 1e-9);
  assert.equal(estimateImageUsd({ model: 'mystery-model' }), null);
  assert.ok(Math.abs(costFromUsage('gpt-image-1', { input_tokens: 50, input_tokens_details: { text_tokens: 50, image_tokens: 0 }, output_tokens: 272 }) - (50 * 5 + 272 * 40) / 1e6) < 1e-12);
  const ledger = new SpendLedger(await tempDir());
  await ledger.add({ workspace: 'w', project: '.', provider: 'openai', kind: 'image', usd: 0.45 });
  await assert.rejects(ledger.check('w', '.', 0.1), /refused/);
  await ledger.check('other', '.', 0.1);
});

// ---------- tools, library and gates through the plugin ----------

test('the games3d plugin registers the studio tools and gates', async () => {
  const h = await createHarness({ dataDir: await tempDir(), plugins: [path.join(here, '..', 'plugins', 'games3d')], search: null, memory: 'off' });
  try {
    for (const t of ['studio_image', 'studio_sprite', 'studio_procgen', 'studio_audio', 'studio_model', 'studio_library', 'studio_source']) assert.ok(h.registry.tools.has(t), t);
    for (const g of ['asset-manifest', 'asset-budget', 'asset-3d', 'asset-2d', 'audio-valid', 'level-playable']) assert.ok(h.registry.gates.has(g), g);
    assert.equal(h.registry.tools.get('studio_sprite')!.sendsOut, false, 'a local builder does not count as sending data out');
  } finally { await h.close(); }
});

test('builders save assets with manifests, licences and hashes; the gates pass them; previews come back', async () => {
  const { tools, gates } = await fakeApi();
  const root = await tempDir();
  await fs.mkdir(path.join(root, '.studio'), { recursive: true });
  await fs.writeFile(path.join(root, '.studio', 'project.json'), JSON.stringify({ name: 'T', engine: 'godot', dimension: '2d', budgets: { textureMax: 2048 } }));
  const ctx = ctxOf(root);
  const call = (t: string, i: Record<string, unknown>) => out(tools.get(t)!.run(i, ctx));
  const runs = [
    ['studio_sprite', { action: 'sheet', kind: 'character', seed: 4 }],
    ['studio_sprite', { action: 'sprite', kind: 'gem', seed: 2, palette: 'db16', svg: true }],
    ['studio_sprite', { action: 'tileset', mode: 'blob', a: 'grass', b: 'dirt' }],
    ['studio_sprite', { action: 'tileset', mode: 'texture', terrain: 'water', frames: 4 }],
    ['studio_sprite', { action: 'ui', icons: ['star', 'heart'], scales: [1, 2] }],
    ['studio_sprite', { action: 'parallax', width: 160, height: 90 }],
    ['studio_sprite', { action: 'iso', types: ['grass', 'stone'] }],
    ['studio_sprite', { action: 'particles', types: ['soft', 'flame'] }],
    ['studio_procgen', { action: 'platformer', seed: 3, length: 60 }],
    ['studio_procgen', { action: 'dungeon', seed: 3 }],
    ['studio_procgen', { action: 'maze', seed: 3, cols: 8, rows: 6 }],
    ['studio_procgen', { action: 'heightmap', seed: 3, size: 65 }],
    ['studio_procgen', { action: 'wfc', tiles: 'coast', width: 10, height: 8, seed: 2 }],
    ['studio_procgen', { action: 'lsystem', preset: 'tree', seed: 1 }],
    ['studio_audio', { action: 'sfx', preset: 'jump', seed: 2, variants: 2 }],
    ['studio_audio', { action: 'music', style: 'chiptune', seed: 1, repeats: 1 }],
    ['studio_image', { action: 'font', scale: 2 }],
  ] as const;
  for (const [t, i] of runs) {
    const r = await call(t, i as Record<string, unknown>);
    assert.ok(!r.is_error, `${t} ${JSON.stringify(i)}: ${r.content}`);
    assert.match(r.content, /Asset [a-z0-9.-]+ \(/);
  }
  const ids = (await fs.readdir(path.join(root, '.studio', 'assets'))).sort();
  assert.match(await fs.readFile(path.join(root, '.studio', 'assets', 'sprite-gem-2', 'sprite.svg'), 'utf8'), /^<svg [^>]*shape-rendering="crispEdges"><rect /);
  assert.ok(ids.includes('sheet-character-4') && ids.includes('level-platformer-3') && ids.includes('sfx-jump-2'), ids.join(' '));
  const m = JSON.parse(await fs.readFile(path.join(root, '.studio', 'assets', 'sheet-character-4', 'asset.json'), 'utf8'));
  assert.equal(m.license.id, 'CC0-1.0');
  assert.equal(m.source.type, 'procedural');
  assert.match(m.hashes['sheet.png'], /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(m.meta.frameSize, [32, 32]);
  // Deterministic: building the same sheet again writes the same bytes.
  const before = await fs.readFile(path.join(root, '.studio', 'assets', 'sheet-character-4', 'sheet.png'));
  await call('studio_sprite', { action: 'sheet', kind: 'character', seed: 4 });
  assert.ok(before.equals(await fs.readFile(path.join(root, '.studio', 'assets', 'sheet-character-4', 'sheet.png'))));
  const host = new LocalHost(root);
  const signal = new AbortController().signal;
  for (const name of ['asset-manifest', 'asset-budget', 'asset-2d', 'audio-valid', 'level-playable']) {
    const g = gates.get(name)!;
    assert.ok(await g.applies!(host, signal), `${name} applies`);
    const r = await g.run({ host, signal });
    assert.ok(r.pass, `${name}: ${r.summary}\n${r.details}`);
  }
  // The library tool lists and verifies them.
  const list = await call('studio_library', { action: 'list' });
  assert.match(list.content, /sheet-character-4 \[spritesheet\]/);
  assert.doesNotMatch((await call('studio_library', { action: 'verify' })).content, /missing|changed/);
});

test('gates fail what is wrong: a changed file, a missing licence, an opaque sprite, a clipped WAV, an unfinishable level, a budget', async () => {
  const { tools, gates } = await fakeApi();
  const root = await tempDir();
  await fs.mkdir(path.join(root, '.studio'), { recursive: true });
  await fs.writeFile(path.join(root, '.studio', 'project.json'), JSON.stringify({ name: 'T', budgets: { textureMax: 64 } }));
  const ctx = ctxOf(root);
  const host = new LocalHost(root);
  const signal = new AbortController().signal;
  const call = (t: string, i: Record<string, unknown>) => out(tools.get(t)!.run(i, ctx));
  const gate = (n: string) => gates.get(n)!.run({ host, signal });
  await call('studio_sprite', { action: 'sprite', kind: 'coin', seed: 1 });
  await call('studio_audio', { action: 'sfx', preset: 'hit', seed: 1 });
  await call('studio_procgen', { action: 'platformer', seed: 1, length: 50 });
  await call('studio_sprite', { action: 'parallax', width: 128, height: 72 });
  const dir = (id: string) => path.join(root, '.studio', 'assets', id);
  // Changed file -> manifest gate fails; rehash fixes it.
  const sp = path.join(dir('sprite-coin-1'), 'sprite.png');
  const img = decodePNG(await fs.readFile(sp));
  img.fill('#ff00ff');
  await fs.writeFile(sp, encodePNG(img));
  let r = await gate('asset-manifest');
  assert.equal(r.pass, false);
  assert.match(r.details!, /sprite-coin-1: changed since recorded/);
  // ... and that opaque sprite fails the 2D gate.
  r = await gate('asset-2d');
  assert.equal(r.pass, false);
  assert.match(r.details!, /opaque background/);
  await call('studio_library', { action: 'rehash', id: 'sprite-coin-1' });
  assert.equal((await gate('asset-manifest')).pass, true);
  // No licence.
  const mf = path.join(dir('sfx-hit-1'), 'asset.json');
  const m = JSON.parse(await fs.readFile(mf, 'utf8'));
  delete m.license;
  await fs.writeFile(mf, JSON.stringify(m));
  r = await gate('asset-manifest');
  assert.match(r.details!, /sfx-hit-1: no license.id/);
  // A clipped WAV.
  const loud = new Float32Array(44100).map((_, i) => (Math.sin(i / 10) > 0 ? 1 : -1));
  await fs.writeFile(path.join(dir('sfx-hit-1'), 'hit.wav'), encodeWav([loud]));
  r = await gate('audio-valid');
  assert.equal(r.pass, false);
  assert.match(r.details!, /clipped/);
  // An unfinishable level: the exit moved behind a wall.
  const lf = path.join(dir('level-platformer-1'), 'level.json');
  const lv = JSON.parse(await fs.readFile(lf, 'utf8'));
  lv.rows = ['S.......#......E', '........#.......', '........#.......', '........#.......', '........#.......', '################'];
  await fs.writeFile(lf, JSON.stringify(lv));
  r = await gate('level-playable');
  assert.equal(r.pass, false);
  assert.match(r.details!, /cannot be reached/);
  // Budget: a 128 px parallax layer over textureMax 64.
  r = await gate('asset-budget');
  assert.equal(r.pass, false);
  assert.match(r.details!, /textureMax 64/);
});

/** A one-quad glTF (two triangles, 1 m): normals and UVs optional, one degenerate triangle optional. */
function quadGltf({ normals = true, uvs = true, degenerate = false } = {}) {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const nor = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const uv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  const idx = new Uint16Array(degenerate ? [0, 1, 2, 0, 2, 3, 1, 1, 2] : [0, 1, 2, 0, 2, 3]);
  const parts = [Buffer.from(pos.buffer), ...(normals ? [Buffer.from(nor.buffer)] : []), ...(uvs ? [Buffer.from(uv.buffer)] : []), Buffer.from(idx.buffer)];
  const views: { buffer: number; byteOffset: number; byteLength: number }[] = [];
  let off = 0;
  for (const p of parts) { views.push({ buffer: 0, byteOffset: off, byteLength: p.length }); off += p.length; }
  const acc: Record<string, unknown>[] = [{ bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }];
  const attributes: Record<string, number> = { POSITION: 0 };
  if (normals) { attributes.NORMAL = acc.length; acc.push({ bufferView: acc.length, componentType: 5126, count: 4, type: 'VEC3' }); }
  if (uvs) { attributes.TEXCOORD_0 = acc.length; acc.push({ bufferView: acc.length, componentType: 5126, count: 4, type: 'VEC2' }); }
  const indices = acc.length;
  acc.push({ bufferView: acc.length, componentType: 5123, count: idx.length, type: 'SCALAR' });
  const bin = Buffer.concat(parts);
  const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes, indices }] }], accessors: acc, bufferViews: views, buffers: [{ byteLength: bin.length, uri: 'quad.bin' }] };
  return { json, bin };
}

/** The quad as a .glb (JSON and BIN chunks, 4-byte aligned). */
function glbOf({ json, bin }: ReturnType<typeof quadGltf>) {
  const j = { ...json, buffers: [{ byteLength: bin.length }] };
  let js = Buffer.from(JSON.stringify(j));
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const b = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  const head = Buffer.alloc(12); head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + b.length, 8);
  const c1 = Buffer.alloc(8); c1.writeUInt32LE(js.length, 0); c1.writeUInt32LE(0x4e4f534a, 4);
  const c2 = Buffer.alloc(8); c2.writeUInt32LE(b.length, 0); c2.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, c1, js, c2, b]);
}

test('asset-3d: a .gltf with its buffer beside it passes; missing normals, UVs or degenerate triangles fail', async () => {
  const { tools, gates } = await fakeApi();
  const root = await tempDir();
  const host = new LocalHost(root);
  const signal = new AbortController().signal;
  const add = async (id: string, o: Parameters<typeof quadGltf>[0]) => {
    const q = quadGltf(o);
    await fs.writeFile(path.join(root, `${id}.gltf`), JSON.stringify(q.json));
    await fs.writeFile(path.join(root, 'quad.bin'), q.bin);
    const r = await out(tools.get('studio_library')!.run({ action: 'import', id, kind: 'model', files: [`${id}.gltf`, 'quad.bin'], license: { id: 'CC0-1.0' } }, ctxOf(root)));
    assert.ok(!r.is_error, r.content);
  };
  await add('good', {});
  let r = await gates.get('asset-3d')!.run({ host, signal });
  assert.ok(r.pass, `${r.summary}\n${r.details}`);
  await add('nonormals', { normals: false });
  await add('nouvs', { uvs: false });
  await add('degen', { degenerate: true });
  r = await gates.get('asset-3d')!.run({ host, signal });
  assert.equal(r.pass, false);
  assert.match(r.details!, /nonormals: .*no normals/);
  assert.match(r.details!, /nouvs: .*no UVs/);
  assert.match(r.details!, /degen: .*1 of 3 triangles are degenerate/);
  assert.doesNotMatch(r.details!, /good:/);
});

test('library: publish to the shared library, search by kind and tags, copy into another project with hashes checked', async () => {
  const home = await tempDir('studio-home-');
  const prev = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = home;
  try {
    const { tools } = await fakeApi();
    const p1 = await tempDir(), p2 = await tempDir();
    const call = (root: string, t: string, i: Record<string, unknown>) => out(tools.get(t)!.run(i, ctxOf(root)));
    await call(p1, 'studio_sprite', { action: 'sprite', kind: 'slime', seed: 5, tags: ['enemy'] });
    let r = await call(p1, 'studio_library', { action: 'publish', id: 'sprite-slime-5' });
    assert.ok(!r.is_error, r.content);
    assert.ok((await fs.stat(path.join(home, 'assets', 'sprite-slime-5', 'asset.json'))).isFile());
    r = await call(p2, 'studio_library', { action: 'search', kind: 'sprite', tags: ['enemy'], where: 'library' });
    assert.match(r.content, /library: sprite-slime-5/);
    r = await call(p2, 'studio_library', { action: 'search', text: 'dragon', where: 'library' });
    assert.match(r.content, /No matching/);
    r = await call(p2, 'studio_library', { action: 'copy', id: 'sprite-slime-5', as: 'slime' });
    assert.ok(!r.is_error, r.content);
    const m = JSON.parse(await fs.readFile(path.join(p2, '.studio', 'assets', 'slime', 'asset.json'), 'utf8'));
    assert.equal(m.id, 'slime');
    assert.deepEqual(m.copiedFrom, { library: 'sprite-slime-5' });
    r = await call(p2, 'studio_library', { action: 'copy', id: 'sprite-slime-5', as: 'slime' });
    assert.match(r.content, /already has slime/);
    // A tampered library copy is refused.
    await fs.writeFile(path.join(home, 'assets', 'sprite-slime-5', 'sprite.png'), 'broken');
    r = await call(p2, 'studio_library', { action: 'copy', id: 'sprite-slime-5', as: 'slime2' });
    assert.match(r.content, /does not match its manifest/);
    // Import needs a licence.
    await fs.writeFile(path.join(p2, 'thing.png'), encodePNG(new Image(4, 4, '#ff0000')));
    r = await call(p2, 'studio_library', { action: 'import', files: ['thing.png'], kind: 'texture' });
    assert.match(r.content, /needs license/);
    r = await call(p2, 'studio_library', { action: 'import', files: ['thing.png'], kind: 'texture', license: { id: 'CC-BY-4.0', author: 'Someone' }, id: 'thing' });
    assert.ok(!r.is_error, r.content);
  } finally { if (prev === undefined) delete process.env.HARNESS_HOME; else process.env.HARNESS_HOME = prev; }
});

test('image tool: process a PNG (colour key, trim, quantize, slice) and draw shapes', async () => {
  const { tools } = await fakeApi();
  const root = await tempDir();
  const ctx = ctxOf(root);
  const src = new Image(40, 20, '#00ff00');
  src.rect(4, 4, 12, 12, '#cc2222'); src.rect(24, 4, 12, 12, '#2222cc');
  await fs.writeFile(path.join(root, 'in.png'), encodePNG(src));
  let r = await out(tools.get('studio_image')!.run({ action: 'process', input: 'in.png', ops: [{ op: 'colorKey', color: 'auto' }, { op: 'slice', cols: 2, rows: 1 }], output: 'out/frames.png' }, ctx));
  assert.ok(!r.is_error, r.content);
  const keyed = decodePNG(await fs.readFile(path.join(root, 'out', 'frames.png')));
  assert.equal(keyed.alpha(0, 0), 0);
  assert.ok((await fs.stat(path.join(root, 'out', 'frames_1.png'))).isFile());
  r = await out(tools.get('studio_image')!.run({ action: 'draw', width: 16, height: 16, shapes: [{ type: 'circle', cx: 8, cy: 8, r: 6, color: '#ffcc00' }, { type: 'text', text: 'A', x: 6, y: 5, color: '#000' }], id: 'drawn' }, ctx));
  assert.ok(!r.is_error, r.content);
  r = await out(tools.get('studio_image')!.run({ action: 'info', path: 'in.png' }, ctx));
  assert.match(r.content, /40x20, 3 opaque colours/);
});

// ---------- sources with fake fetches ----------

/** A fetch that answers from a table of URL prefixes, recording every call. */
function fakeFetch(routes: [RegExp, (url: string, init?: RequestInit) => Response | Promise<Response>][]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const r = routes.find(([re]) => re.test(u));
    if (!r) return new Response('not found', { status: 404 });
    return r[1](u, init);
  };
  return { fn, calls };
}
const pngBytes = () => encodePNG(new Image(8, 8, '#884422'));

test('sources are off unless configured; status says how to turn them on', async () => {
  const { tools } = await fakeApi();
  const root = await tempDir();
  const prev = process.env.HARNESS_STUDIO_SOURCES;
  delete process.env.HARNESS_STUDIO_SOURCES;
  try {
    const r = await out(tools.get('studio_source')!.run({ action: 'search', source: 'polyhaven', query: 'barrel' }, ctxOf(root)));
    assert.equal(r.is_error, true);
    assert.match(r.content, /off.*HARNESS_STUDIO_SOURCES=polyhaven/);
    assert.match((await out(tools.get('studio_source')!.run({ action: 'status' }, ctxOf(root)))).content, /Sources on: none/);
  } finally { if (prev !== undefined) process.env.HARNESS_STUDIO_SOURCES = prev; }
});

test('Poly Haven, ambientCG and Kenney: search and download through the given fetch, CC0 recorded', async () => {
  const zipAcg = writeZip([{ name: 'Bricks059_1K-PNG_Color.png', data: pngBytes() }, { name: 'Bricks059_1K-PNG_NormalGL.png', data: pngBytes() }, { name: 'Bricks059_1K-PNG_Roughness.png', data: pngBytes() }]);
  const zipKenney = writeZip([{ name: 'kenney_tiny/Tiles/tile_0000.png', data: pngBytes() }, { name: 'kenney_tiny/License.txt', data: 'Creative Commons Zero, CC0' }]);
  const f = fakeFetch([
    [/api\.polyhaven\.com\/assets\?type=models/, () => Response.json({ barrel_01: { name: 'Barrel 01', tags: ['barrel', 'wood'], categories: ['props'], authors: { 'Jane Doe': 'All' }, download_count: 9 }, lamp_02: { name: 'Lamp', tags: ['light'], categories: [] } })],
    [/api\.polyhaven\.com\/info\/barrel_01/, () => Response.json({ name: 'Barrel 01', authors: { 'Jane Doe': 'All' }, tags: ['barrel'] })],
    [/api\.polyhaven\.com\/files\/barrel_01/, () => Response.json({ gltf: { '1k': { gltf: { url: 'https://dl.polyhaven.org/barrel_01_1k.gltf', include: { 'barrel_01.bin': { url: 'https://dl.polyhaven.org/barrel_01.bin' }, 'textures/barrel_diff_1k.jpg': { url: 'https://dl.polyhaven.org/barrel_diff.jpg' } } } } } })],
    [/dl\.polyhaven\.org/, (u) => new Response(u.endsWith('.gltf') ? JSON.stringify({ asset: { version: '2.0' } }) : 'bin')],
    [/ambientcg\.com\/api\/v2\/full_json\?type=/, () => Response.json({ foundAssets: [{ assetId: 'Bricks059', displayName: 'Bricks 059', dataType: 'Material', tags: ['bricks'], downloadFolders: { default: { downloadFiletypeCategories: { zip: { downloads: [{ attribute: '1K-PNG', downloadLink: 'https://ambientcg.com/get?file=Bricks059_1K-PNG.zip' }] } } } } }] })],
    [/ambientcg\.com\/api\/v2\/full_json\?id=Bricks059/, () => Response.json({ foundAssets: [{ assetId: 'Bricks059', displayName: 'Bricks 059', tags: ['bricks'], downloadFolders: { default: { downloadFiletypeCategories: { zip: { downloads: [{ attribute: '1K-PNG', downloadLink: 'https://ambientcg.com/get?file=Bricks059_1K-PNG.zip' }] } } } } }] })],
    [/ambientcg\.com\/get/, () => new Response(zipAcg)],
    [/kenney\.nl\/assets\?search=/, () => new Response("<a href='https://kenney.nl/assets/tiny-dungeon'>x</a><a href='https://kenney.nl/assets/category'>c</a>")],
    [/kenney\.nl\/assets\/tiny-dungeon/, () => new Response("<a href='https://kenney.nl/media/pages/assets/tiny-dungeon/abc/kenney_tiny-dungeon.zip'>Download</a>")],
    [/kenney\.nl\/media/, () => new Response(zipKenney)],
  ]);
  const { tools } = await fakeApi(f.fn as never);
  const root = await tempDir();
  const ctx = ctxOf(root);
  const prev = process.env.HARNESS_STUDIO_SOURCES;
  process.env.HARNESS_STUDIO_SOURCES = 'polyhaven,ambientcg,kenney';
  try {
    const call = (i: Record<string, unknown>) => out(tools.get('studio_source')!.run(i, ctx));
    let r = await call({ action: 'search', source: 'polyhaven', query: 'barrel' });
    assert.match(r.content, /barrel_01: Barrel 01/);
    assert.doesNotMatch(r.content, /lamp_02/);
    r = await call({ action: 'download', source: 'polyhaven', id: 'barrel_01' });
    assert.ok(!r.is_error, r.content);
    assert.match(r.content, /Asset polyhaven-barrel-01/);
    const m = JSON.parse(await fs.readFile(path.join(root, '.studio', 'assets', 'polyhaven-barrel-01', 'asset.json'), 'utf8'));
    assert.equal(m.license.id, 'CC0-1.0');
    assert.equal(m.license.author, 'Jane Doe');
    assert.equal(m.source.provider, 'polyhaven');
    assert.deepEqual(m.files.map((x: { path: string }) => x.path).sort(), ['barrel_01.bin', 'barrel_01.gltf', 'textures/barrel_diff_1k.jpg']);
    r = await call({ action: 'search', source: 'ambientcg', query: 'bricks' });
    assert.match(r.content, /Bricks059: Bricks 059.*1K-PNG/);
    r = await call({ action: 'download', source: 'ambientcg', id: 'Bricks059' });
    assert.ok(!r.is_error, r.content);
    const am = JSON.parse(await fs.readFile(path.join(root, '.studio', 'assets', 'ambientcg-bricks059', 'asset.json'), 'utf8'));
    assert.deepEqual(am.files.map((x: { role: string }) => x.role), ['main', 'normal', 'roughness']);
    r = await call({ action: 'search', source: 'kenney', query: 'dungeon' });
    assert.match(r.content, /tiny-dungeon/);
    assert.doesNotMatch(r.content, /category/);
    r = await call({ action: 'download', source: 'kenney', id: 'tiny-dungeon' });
    assert.ok(!r.is_error, r.content);
    const km = JSON.parse(await fs.readFile(path.join(root, '.studio', 'assets', 'kenney-tiny-dungeon', 'asset.json'), 'utf8'));
    assert.equal(km.license.id, 'CC0-1.0');
    assert.ok(km.files.some((x: { path: string }) => x.path === 'Tiles/tile_0000.png'));
    assert.ok(f.calls.every((c) => /polyhaven|ambientcg|kenney/.test(c.url)));
  } finally { if (prev === undefined) delete process.env.HARNESS_STUDIO_SOURCES; else process.env.HARNESS_STUDIO_SOURCES = prev; }
});

test('OpenAI images (fake): costed from usage, post-processed into a sprite, refused past the cap', async () => {
  const gen = new Image(1024, 1024, '#ffffff');
  gen.circle(512, 560, 300, '#3a8ae8'); gen.rect(470, 200, 84, 120, '#2a2a2a');
  const f = fakeFetch([[/api\.openai\.com\/v1\/images\/generations/, (_u, init) => {
    const body = JSON.parse(String(init!.body));
    assert.equal(body.quality, 'low');
    return Response.json({ data: [{ b64_json: encodePNG(gen).toString('base64') }], usage: { input_tokens: 40, input_tokens_details: { text_tokens: 40, image_tokens: 0 }, output_tokens: 272, total_tokens: 312 } });
  }]]);
  const { tools, dataDir } = await fakeApi(f.fn as never, { OPENAI_API_KEY: 'sk-test' });
  const root = await tempDir();
  const ctx = ctxOf(root);
  const prevS = process.env.HARNESS_STUDIO_SOURCES, prevB = process.env.HARNESS_STUDIO_IMAGE_BUDGET;
  process.env.HARNESS_STUDIO_SOURCES = 'openai';
  process.env.HARNESS_STUDIO_IMAGE_BUDGET = '0.025';
  try {
    const call = (i: Record<string, unknown>) => out(tools.get('studio_source')!.run(i, ctx));
    let r = await call({ action: 'image', prompt: 'a blue slime', purpose: 'sprite', spriteSize: 32, palette: 'db32', assetId: 'slime-gen' });
    assert.ok(!r.is_error, r.content);
    assert.match(r.content, /Cost USD 0\.0111/);
    const m = JSON.parse(await fs.readFile(path.join(root, '.studio', 'assets', 'slime-gen', 'asset.json'), 'utf8'));
    assert.equal(m.source.type, 'generated');
    assert.equal(m.source.provider, 'openai');
    assert.ok(Math.abs(m.source.costUsd - (40 * 5 + 272 * 40) / 1e6) < 1e-9);
    const sprite = decodePNG(await fs.readFile(path.join(root, '.studio', 'assets', 'slime-gen', 'sprite.png')));
    assert.deepEqual([sprite.width, sprite.height], [32, 32]);
    assert.equal(sprite.alpha(0, 0), 0, 'the white background was keyed out');
    assert.ok(sprite.colors().size <= 33);
    r = await call({ action: 'image', prompt: 'grass texture', purpose: 'texture', textureSize: 64, normal: true, assetId: 'grass-gen' });
    assert.ok(!r.is_error, r.content);
    // A third call would cross USD 0.025.
    r = await call({ action: 'image', prompt: 'one more', purpose: 'texture' });
    assert.equal(r.is_error, true);
    assert.match(r.content, /refused.*cap/);
    assert.equal(f.calls.length, 2, 'the refused call never reached the API');
    const ledger = JSON.parse(await fs.readFile(path.join(dataDir, 'studio-spend.json'), 'utf8'));
    assert.equal(ledger.entries.length, 2);
    assert.match((await call({ action: 'spend' })).content, /openai gpt-image-1 image USD 0\.0111/);
  } finally {
    if (prevS === undefined) delete process.env.HARNESS_STUDIO_SOURCES; else process.env.HARNESS_STUDIO_SOURCES = prevS;
    if (prevB === undefined) delete process.env.HARNESS_STUDIO_IMAGE_BUDGET; else process.env.HARNESS_STUDIO_IMAGE_BUDGET = prevB;
  }
});

test('text to 3D (fake Meshy and Tripo): start, poll, download; resumable; a task cap', async () => {
  const glb = glbOf(quadGltf({}));
  let polls = 0;
  const f = fakeFetch([
    [/api\.meshy\.ai\/openapi\/v2\/text-to-3d$/, () => Response.json({ result: 'task-m1' })],
    [/api\.meshy\.ai\/openapi\/v2\/text-to-3d\/task-m1/, () => Response.json(++polls < 2 ? { status: 'IN_PROGRESS', progress: 40 } : { status: 'SUCCEEDED', progress: 100, model_urls: { glb: 'https://assets.meshy.ai/m1.glb' } })],
    [/assets\.meshy\.ai\/m1\.glb/, () => new Response(glb)],
    [/api\.tripo3d\.ai\/v2\/openapi\/task$/, () => Response.json({ code: 0, data: { task_id: 't-1' } })],
    [/api\.tripo3d\.ai\/v2\/openapi\/task\/t-1/, () => Response.json({ code: 0, data: { status: 'failed' } })],
  ]);
  const { tools } = await fakeApi(f.fn as never, { MESHY_API_KEY: 'm', TRIPO_API_KEY: 't' });
  const root = await tempDir();
  const ctx = ctxOf(root);
  const prev = process.env.HARNESS_STUDIO_SOURCES, prevT = process.env.HARNESS_STUDIO_3D_TASKS;
  process.env.HARNESS_STUDIO_SOURCES = 'meshy,tripo';
  process.env.HARNESS_STUDIO_3D_TASKS = '2';
  try {
    const call = (i: Record<string, unknown>) => out(tools.get('studio_source')!.run(i, ctx));
    let r = await call({ action: 'text3d', provider: 'meshy', prompt: 'a wooden barrel', wait: 0 });
    assert.match(r.content, /task-m1 is still running \(40%\)/);
    const startCall = f.calls.find((c) => /text-to-3d$/.test(c.url))!;
    assert.equal(JSON.parse(String(startCall.init!.body)).mode, 'preview');
    assert.equal((startCall.init!.headers as Record<string, string>).Authorization, 'Bearer m');
    r = await call({ action: 'text3d', provider: 'meshy', task: 'task-m1', wait: 5 });
    // Blender may or may not be here: either way an asset comes out, with the provider's terms as its licence.
    const dirs = await fs.readdir(path.join(root, '.studio', 'assets')).catch(() => []);
    assert.ok(dirs.some((d) => d.startsWith('gen3d-')), r.content);
    const g3 = JSON.parse(await fs.readFile(path.join(root, '.studio', 'assets', dirs.find((d) => d.startsWith('gen3d-'))!, 'asset.json'), 'utf8'));
    assert.equal(g3.source.provider, 'meshy');
    assert.equal(g3.license.id, 'LicenseRef-Meshy-Terms');
    r = await call({ action: 'text3d', provider: 'tripo', prompt: 'a lamp', wait: 5 });
    assert.equal(r.is_error, true);
    assert.match(r.content, /t-1 failed/);
    r = await call({ action: 'text3d', provider: 'tripo', prompt: 'a third one', wait: 0 });
    assert.match(r.content, /refused.*2 of its 2 tasks/);
  } finally {
    if (prev === undefined) delete process.env.HARNESS_STUDIO_SOURCES; else process.env.HARNESS_STUDIO_SOURCES = prev;
    if (prevT === undefined) delete process.env.HARNESS_STUDIO_3D_TASKS; else process.env.HARNESS_STUDIO_3D_TASKS = prevT;
  }
});

test('studio_model without Blender answers unavailable with how to get it', async () => {
  const { tools } = await fakeApi();
  const root = await tempDir();
  const prev = process.env.HARNESS_BLENDER;
  // A host whose runtime has no Blender: a stub that runs nothing.
  const host = { kind: 'docker', root, displayRoot: '/workspace', platform: 'linux', shell: 'bash', sandboxed: true, networkPolicy: 'none', async exec() { return { stdout: '', stderr: '', code: 1, timedOut: false }; } };
  try {
    const r = await out(tools.get('studio_model')!.run({ action: 'build', generator: 'barrel' }, { ...ctxOf(root), host } as unknown as ToolContext));
    assert.equal(r.is_error, true);
    assert.match(r.content, /Blender is not installed.*winget install BlenderFoundation/);
    assert.match((await out(tools.get('studio_model')!.run({ action: 'generators' }, ctxOf(root)))).content, /barrel: height 0\.9/);
  } finally { if (prev !== undefined) process.env.HARNESS_BLENDER = prev; }
});

void runGates;
