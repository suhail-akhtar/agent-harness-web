import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LocalHost } from '../src/runtime/host.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir } from './helpers.ts';

// Studio's 3D builders in a real Blender (HARNESS_REAL_BLENDER=1): every generator exports a
// valid glb under budget with a preview render that shows something; the character carries
// its armature and four animations; sprites render from 8 directions; a material bakes;
// terrain takes a heightmap; an outside model is cleaned up. HARNESS_STUDIO_KEEP=<dir>
// copies the previews there to look at. One real image generation runs only with
// HARNESS_REAL_OPENAI=1 (and OPENAI_API_KEY): a single low-quality 1024x1024 texture.

const REAL = process.env.HARNESS_REAL_BLENDER === '1';
const here = path.dirname(fileURLToPath(import.meta.url));
const A = path.join(here, '..', 'plugins', 'games3d', 'assets');
const mod = (p: string) => import(new URL(`file:///${path.join(A, p).replace(/\\/g, '/')}`).href);
const { setupAssets } = await mod('index.mjs');
const { findBlender } = await mod('tools-model.mjs');
const { decodePNG } = await mod('raster/png.mjs');
const { checkGltf } = await mod('gltf-check.mjs');
// @ts-expect-error plain JS module
const { inspectGltf } = await import('../plugins/games3d/lib-gltf.mjs');
// @ts-expect-error plain JS module
const { pngStats } = await import('../plugins/games3d/lib-png.mjs');

type Run = (i: Record<string, unknown>, c: ToolContext) => Promise<{ content: string; is_error?: boolean } | string>;
const ctxOf = (root: string) => ({ host: new LocalHost(root), signal: new AbortController().signal, readFiles: new Map(), todos: [], setTodos() {}, emit() {} }) as unknown as ToolContext;

async function setup(secrets: Record<string, string> = {}, fetchImpl?: unknown) {
  const tools = new Map<string, Run>();
  const gates = new Map<string, { run: (c: { host: LocalHost; signal: AbortSignal }) => Promise<{ pass: boolean; summary: string; details?: string }> }>();
  setupAssets({ pluginName: 'games3d', pluginDir: path.dirname(A), dataDir: await tempDir('studio-data-'), registerTool: (t: { spec: { name: string }; run: Run }) => tools.set(t.spec.name, t.run), registerGate: (g: { name: string; run: never }) => gates.set(g.name, g), secret: (n: string) => secrets[n], fetch: fetchImpl ?? fetch, log() {} });
  const root = await tempDir('studio-blender-');
  await fs.mkdir(path.join(root, '.studio'), { recursive: true });
  await fs.writeFile(path.join(root, '.studio', 'project.json'), JSON.stringify({ name: 'Blender test', engine: 'godot', dimension: '3d', budgets: { trianglesPerAsset: 40000, textureMax: 2048 } }));
  const ctx = ctxOf(root);
  const call = async (t: string, i: Record<string, unknown>) => { const r = await tools.get(t)!(i, ctx); return typeof r === 'string' ? { content: r, is_error: false } : r; };
  return { root, call, gates, host: new LocalHost(root) };
}

const keep = async (root: string, id: string, file = 'preview.png') => {
  const dir = process.env.HARNESS_STUDIO_KEEP;
  if (!dir) return;
  await fs.mkdir(dir, { recursive: true });
  await fs.copyFile(path.join(root, '.studio', 'assets', id, file), path.join(dir, `${id}-${file}`));
};

/** The asset's main glb is valid, has normals and UVs, and is in budget; its preview shows something. */
async function checkModel(root: string, id: string, maxTris = 40000) {
  const dir = path.join(root, '.studio', 'assets', id);
  const m = JSON.parse(await fs.readFile(path.join(dir, 'asset.json'), 'utf8'));
  const main = m.files.find((f: { role: string }) => f.role === 'main').path;
  const g = await inspectGltf(path.join(dir, main));
  assert.ok(g.meshes > 0 && g.triangles > 0, `${id}: geometry`);
  assert.ok(g.triangles <= maxTris, `${id}: ${g.triangles} triangles`);
  const c = await checkGltf(await fs.readFile(path.join(dir, main)), path.join(dir, main));
  assert.deepEqual(c.problems, [], `${id}: ${c.problems.join('; ')}`);
  const p = pngStats(await fs.readFile(path.join(dir, 'preview.png')));
  assert.ok(!p.blank && p.width === 512, `${id}: preview ${p.width}x${p.height}, ${p.colours} colours`);
  return { m, g, c };
}

test('every Blender generator exports a valid glb under budget with a preview', { skip: !REAL && 'set HARNESS_REAL_BLENDER=1 (needs Blender)', timeout: 1_800_000 }, async () => {
  const { root, call, gates, host } = await setup();
  assert.ok(await findBlender(host), 'Blender is found');
  const sizes: Record<string, [number, number]> = { barrel: [0.85, 0.95], crate: [0.75, 0.85], chest: [0.4, 0.6], coin: [0.2, 0.3], gem: [0.15, 0.35], lamp: [2.1, 2.4], table: [0.7, 0.8], chair: [0.9, 1.0], fence: [1.0, 1.2], rock: [0.2, 1.2], bush: [0.4, 1.2], building: [7, 10], vehicle: [1.2, 1.7], grass: [0.45, 0.55] };
  for (const gen of ['barrel', 'crate', 'chest', 'coin', 'gem', 'lamp', 'table', 'chair', 'fence', 'rock', 'bush', 'building', 'vehicle', 'grass']) {
    const t0 = Date.now();
    const r = await call('studio_model', { action: 'build', generator: gen, seed: 3, ...(gen === 'barrel' ? { fbx: true, lods: [0.5, 0.25] } : {}) });
    assert.ok(!r.is_error, `${gen}: ${r.content}`);
    const { g } = await checkModel(root, `model-${gen}-3`);
    // glTF is Y up: the height is the second size.
    const [lo, hi] = sizes[gen]!;
    assert.ok(g.size[1] >= lo && g.size[1] <= hi, `${gen}: height ${g.size[1]} m`);
    console.log(`# ${gen}: ${g.triangles} tris, ${g.size.join(' x ')} m, ${g.materials} materials, ${Date.now() - t0} ms`);
    await keep(root, `model-${gen}-3`);
  }
  const barrel = path.join(root, '.studio', 'assets', 'model-barrel-3');
  for (const f of ['barrel.fbx', 'barrel_lod1.glb', 'barrel_lod2.glb']) assert.ok((await fs.stat(path.join(barrel, f))).size > 1000, f);
  const lod1 = await inspectGltf(path.join(barrel, 'barrel_lod1.glb')), main = await inspectGltf(path.join(barrel, 'barrel.glb'));
  assert.ok(lod1.triangles < main.triangles * 0.6, `LOD1 ${lod1.triangles} < ${main.triangles}`);
  for (const name of ['asset-manifest', 'asset-budget', 'asset-3d']) {
    const r = await gates.get(name)!.run({ host, signal: new AbortController().signal });
    assert.ok(r.pass, `${name}: ${r.summary}\n${r.details}`);
  }
});

test('the character: an armature, skinning and four animations; sprites from 8 directions', { skip: !REAL && 'set HARNESS_REAL_BLENDER=1 (needs Blender)', timeout: 1_800_000 }, async () => {
  const { root, call } = await setup();
  const r = await call('studio_model', { action: 'build', generator: 'character', seed: 2, fbx: true, sprites: { directions: 8, size: 64, actions: ['walk', 'idle'], frames: 6 } });
  assert.ok(!r.is_error, r.content);
  const { m, c, g } = await checkModel(root, 'model-character-2');
  assert.equal(c.skins, 1);
  assert.deepEqual([...c.animations].sort(), ['idle', 'jump', 'run', 'walk']);
  assert.ok(g.size[1] > 1.7 && g.size[1] < 2.0, `height ${g.size[1]}`);
  assert.equal(m.meta.bones, 15);
  // 2 actions x 8 directions = 16 rows of 6 frames of 64 px.
  const sheet = decodePNG(await fs.readFile(path.join(root, '.studio', 'assets', 'model-character-2', 'sprites.png')));
  assert.deepEqual([sheet.width, sheet.height], [6 * 64, 16 * 64]);
  const ase = JSON.parse(await fs.readFile(path.join(root, '.studio', 'assets', 'model-character-2', 'sprites.aseprite.json'), 'utf8'));
  assert.equal(Object.keys(ase.frames).length, 96);
  assert.equal(sheet.alpha(0, 0), 0, 'transparent background');
  assert.ok(sheet.bounds(), 'the frames show the character');
  await keep(root, 'model-character-2');
  await keep(root, 'model-character-2', 'sprites.png');
});

test('kit pieces, an L-system tree, terrain from a heightmap, a baked material, and a cleaned-up outside model', { skip: !REAL && 'set HARNESS_REAL_BLENDER=1 (needs Blender)', timeout: 1_800_000 }, async () => {
  const { root, call, gates, host } = await setup();
  let r = await call('studio_model', { action: 'build', generator: 'kit', seed: 1 });
  assert.ok(!r.is_error, r.content);
  const kit = JSON.parse(await fs.readFile(path.join(root, '.studio', 'assets', 'model-kit-1', 'asset.json'), 'utf8'));
  assert.deepEqual(kit.meta.pieces.map((p: { piece: string }) => p.piece), ['floor', 'wall', 'corner', 'door', 'window', 'stairs', 'platform', 'pillar']);
  const wall = kit.meta.pieces.find((p: { piece: string }) => p.piece === 'wall');
  assert.deepEqual(wall.sizeM.map((v: number) => Math.round(v * 10) / 10), [2, 0.2, 3], 'the wall is one 2 m grid cell wide and 3 m tall');
  await keep(root, 'model-kit-1');
  r = await call('studio_model', { action: 'build', generator: 'tree', seed: 4, params: { preset: 'tree' } });
  assert.ok(!r.is_error, r.content);
  await checkModel(root, 'model-tree-4', 40000);
  await keep(root, 'model-tree-4');
  r = await call('studio_procgen', { action: 'heightmap', seed: 7, size: 129, island: true });
  assert.ok(!r.is_error, r.content);
  r = await call('studio_model', { action: 'build', generator: 'terrain', seed: 7, params: { heightmap: 'heightmap-129-7', size: 60, heightM: 10, resolution: 96 } });
  assert.ok(!r.is_error, r.content);
  const t = await checkModel(root, 'model-terrain-7', 40000);
  assert.ok(Math.abs(t.g.size[0] - 60) < 0.5 && t.g.size[1] > 3 && t.g.size[1] <= 10.01, `terrain ${t.g.size}`);
  await keep(root, 'model-terrain-7');
  r = await call('studio_model', { action: 'build', generator: 'material', seed: 1, params: { preset: 'brick', size: 256 } });
  assert.ok(!r.is_error, r.content);
  for (const f of ['basecolor.png', 'roughness.png', 'normal.png']) {
    const p = decodePNG(await fs.readFile(path.join(root, '.studio', 'assets', 'model-material-1', f)));
    assert.equal(p.width, 256, f);
  }
  const base = decodePNG(await fs.readFile(path.join(root, '.studio', 'assets', 'model-material-1', 'basecolor.png')));
  assert.ok(base.colors().size > 50, 'the brick colour map has texture');
  await keep(root, 'model-material-1');
  await keep(root, 'model-material-1', 'basecolor.png');
  // An outside model: the barrel built here, exported at 10x scale, cleaned to 1.2 m and 400 triangles.
  r = await call('studio_model', { action: 'build', generator: 'barrel', seed: 1 });
  await fs.copyFile(path.join(root, '.studio', 'assets', 'model-barrel-1', 'barrel.glb'), path.join(root, 'outside.glb'));
  r = await call('studio_model', { action: 'cleanup', file: 'outside.glb', targetHeight: 1.2, maxTriangles: 400, license: { id: 'CC0-1.0', author: 'test' } });
  assert.ok(!r.is_error, r.content);
  const cl = await checkModel(root, 'model-outside', 400);
  assert.ok(Math.abs(cl.g.size[1] - 1.2) < 0.01, `cleaned height ${cl.g.size[1]}`);
  // Sprites of a static model asset (re-run from its recorded generator).
  r = await call('studio_model', { action: 'sprites', id: 'model-barrel-1', directions: 4, size: 48 });
  assert.ok(!r.is_error, r.content);
  for (const name of ['asset-manifest', 'asset-budget', 'asset-3d']) {
    const g = await gates.get(name)!.run({ host, signal: new AbortController().signal });
    assert.ok(g.pass, `${name}: ${g.summary}\n${g.details}`);
  }
});

test('one real OpenAI image: a low-quality 1024x1024 texture, costed and recorded', { skip: process.env.HARNESS_REAL_OPENAI !== '1' && 'set HARNESS_REAL_OPENAI=1 (one paid call, about USD 0.01)', timeout: 300_000 }, async () => {
  const key = process.env.OPENAI_API_KEY;
  assert.ok(key, 'OPENAI_API_KEY');
  const prev = process.env.HARNESS_STUDIO_SOURCES;
  process.env.HARNESS_STUDIO_SOURCES = 'openai';
  try {
    const { root, call } = await setup({ OPENAI_API_KEY: key! });
    const r = await call('studio_source', { action: 'image', prompt: 'mossy cobblestone ground, stylized hand-painted game texture', purpose: 'texture', quality: 'low', size: '1024x1024', textureSize: 512, normal: true, assetId: 'cobble-gen' });
    assert.ok(!r.is_error, r.content);
    console.log(`# ${r.content.replace(/\n/g, '\n# ')}`);
    const m = JSON.parse(await fs.readFile(path.join(root, '.studio', 'assets', 'cobble-gen', 'asset.json'), 'utf8'));
    assert.equal(m.source.provider, 'openai');
    assert.ok(m.source.costUsd > 0 && m.source.costUsd < 0.05, `cost ${m.source.costUsd}`);
    const tex = decodePNG(await fs.readFile(path.join(root, '.studio', 'assets', 'cobble-gen', 'texture.png')));
    assert.deepEqual([tex.width, tex.height], [512, 512]);
    await keep(root, 'cobble-gen', 'texture.png');
    await keep(root, 'cobble-gen', 'generated.png');
  } finally { if (prev === undefined) delete process.env.HARNESS_STUDIO_SOURCES; else process.env.HARNESS_STUDIO_SOURCES = prev; }
});
