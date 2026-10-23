// studio_model: 3D assets made in Blender from Studio's parameterized generators
// (assets/blender/*.py): props, modular kits, buildings, terrain, L-system trees, a rigged
// and animated character, vehicles, baked PBR materials; with glb (+ fbx for Unreal), a
// preview render, LODs, AO/normal bakes, and sprites rendered from N directions for 2.5D.
// Blender runs where the session's commands run, through the heavy-job queue.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { locate, mkdirIn, readIn, readTextIn, relIn, removeIn, runIn, runtimePath, tail, writeIn, newId } from '../lib-engines.mjs';
import { inspectGltf } from '../lib-gltf.mjs';
import { runJob } from '../sdk/jobs.mjs';
import { guarded, int, num, preview, save, seedIn, unknownAction } from './common.mjs';
import { expand, PRESETS as LPRESETS, turtle3d } from './gen/lsystem.mjs';
import { checkGltf } from './gltf-check.mjs';
import { assetsDir, projectOf } from './library.mjs';
import { decodePNG, encodePNG } from './raster/png.mjs';
import { ramp } from './raster/color.mjs';
import { Image } from './raster/image.mjs';
import { rng } from './util/rng.mjs';
import { asepriteJson, framesJson, packSheet } from './sprites/sheet.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PY_DIR = path.join(here, 'blender');
const PY_FILES = ['studio.py', 'util.py', 'gen_props.py', 'gen_world.py', 'gen_character.py', 'gen_material.py'];

/** What each generator makes and its main parameters (metres, hex colours). */
export const GENERATORS = {
  barrel: 'height 0.9, radius 0.3, bulge 0.12, staves 16, wood, metal',
  crate: 'size 0.8, wood, frame',
  chest: 'width 0.9, depth 0.55, height 0.5, wood, band',
  coin: 'radius 0.12, thickness 0.02, color',
  gem: 'radius 0.15, facets 8, color',
  lamp: 'height 2.2, metal, light (emissive colour)',
  table: 'width 1.4, depth 0.8, height 0.76, wood',
  chair: 'seat 0.45, height 0.95, wood',
  fence: 'length 2, height 1, posts 3, wood',
  rock: 'size 0.8, color (seeded shape)',
  bush: 'size 0.9, clumps 6, color',
  grass: 'height 0.5, width 0.6, cards 3 (crossed quads; texture: a PNG with alpha)',
  tree: 'preset tree|pine|bush (an L-system), iterations, angle, scale 1, bark, leaf, leafSize',
  kit: 'grid 2 (m), wallHeight 3, thickness 0.2, pieces [floor, wall, corner, door, window, stairs, platform, pillar]: one glb per piece',
  building: 'width 6, depth 5, floors 2, floorHeight 3, wall, roof, trim, chimney, lit',
  terrain: 'heightmap (a heightmap asset id or a PNG), size 64 (m), heightM 12, resolution 128',
  character: 'skin, hair, shirt, pants, shoes: a blocky humanoid with an armature (15 bones) and actions idle, walk, run, jump',
  vehicle: 'length 4, width 1.8, height 1.4, color (wheels are separate objects wheel_FL...)',
  material: 'preset wood|stone|brick|metal|tiles|fabric|grass|sand|dirt, colors, size 512, scale 2: baked base colour, roughness and normal maps',
};

/** Blender in this runtime: the usual search, then the Windows install folders and HARNESS_BLENDER. */
export async function findBlender(host, signal) {
  const bin = await locate(host, 'blender', signal);
  if (bin) return bin;
  if (host.kind !== 'local') return null;
  const env = process.env.HARNESS_BLENDER;
  if (env && fs.existsSync(env)) return env;
  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles, 'C:\\Program Files'].filter(Boolean)) {
      const dir = path.join(base, 'Blender Foundation');
      const vers = (await fsp.readdir(dir).catch(() => [])).filter((d) => /^blender/i.test(d)).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
      for (const v of vers) { const f = path.join(dir, v, 'blender.exe'); if (fs.existsSync(f)) return f; }
    }
  }
  return null;
}

const HOW_TO_GET = 'Blender is not installed where this session runs commands. Install Blender 4.2 LTS (Windows: winget install BlenderFoundation.Blender.LTS.4.2; macOS: brew install --cask blender; Linux: the official build into /opt/blender), or point HARNESS_BLENDER at blender(.exe), or use the 3D sandbox image (npm run sandbox:image:3d). The 2D tools (studio_sprite, studio_procgen, studio_audio) work without it.';

/**
 * Runs one Blender job: copies the scripts and the job into the workspace (.harness/studio),
 * runs Blender through the heavy-job queue, and returns the report and the folder it wrote.
 */
export async function runBlenderJob(host, job, { signal, timeoutMs = 900_000, bin } = {}) {
  const blender = bin ?? await findBlender(host, signal);
  if (!blender) return { unavailable: true, message: HOW_TO_GET };
  const work = `.harness/studio/blender-${newId()}`;
  const scripts = '.harness/studio/blender-py';
  for (const f of PY_FILES) await writeIn(host, `${scripts}/${f}`, await fsp.readFile(path.join(PY_DIR, f)), signal);
  await mkdirIn(host, `${work}/out`, signal);
  const full = { ...job, out: runtimePath(host, `${work}/out`) };
  await writeIn(host, `${work}/job.json`, JSON.stringify(full), signal);
  const args = ['-b', '--factory-startup', '-noaudio', '--python-exit-code', '1', '--python', runtimePath(host, `${scripts}/studio.py`), '--', runtimePath(host, `${work}/job.json`)];
  const r = await runJob('blender', `studio ${job.generator ?? 'import'} ${job.name ?? ''}`, (sig) => runIn(host, blender, args, { timeoutMs, signal: sig }), { signal, timeoutMs: timeoutMs + 30_000 });
  const reportText = await readTextIn(host, `${work}/out/report.json`, signal);
  if (r.code !== 0 || !reportText) {
    await removeIn(host, work, signal).catch(() => {});
    const out = r.output.split('\n').filter((l) => !/^Fra:|^\s*$|TBBmalloc/.test(l)).join('\n');
    throw new Error(`Blender ${r.timedOut ? 'timed out' : `exited ${r.code}`} in ${r.took}:\n${tail(out, 25, 3000)}`);
  }
  return { report: JSON.parse(reportText), work, took: r.took };
}

/** A workspace file Blender wrote (its runtime path in the report) as a workspace-relative path. */
const relOut = (host, work, p) => `${work}/out/${String(p).replace(/\\/g, '/').split('/out/').pop()}`;

/** Packs rendered sprite frames (rows: directions x actions, columns: frames) into a sheet. */
async function spriteSheet(host, work, s, signal) {
  const anims = {};
  // Rows: every direction of the first action, then of the next (walk_0 ... walk_7, idle_0 ...).
  const order = [...s.files].sort((a, b) => s.actions.indexOf(a.action) - s.actions.indexOf(b.action) || a.direction - b.direction || a.frame - b.frame);
  for (const f of order) {
    const key = `${f.action}_${f.direction}`;
    (anims[key] ??= [])[f.frame] = decodePNG(await readIn(host, relOut(host, work, f.file), signal));
  }
  return packSheet(anims, { fps: 10 });
}

/** A grass-card texture: tapered blades in a green ramp on transparency, 128 px. */
export function grassTexture(seed = 1) {
  const r = rng(`${seed}:grass`);
  const R = ramp('#5fae4a', 5);
  const img = new Image(128, 128);
  for (let i = 0; i < 46; i++) {
    const x = r.range(6, 122), h = r.range(50, 124), lean = r.range(-18, 18), w = r.range(2.5, 5);
    img.polygon([[x - w, 128], [x + w, 128], [x + lean * 0.6 + w * 0.4, 128 - h * 0.6], [x + lean, 128 - h]], R[r.int(1, 3)], { aa: true });
  }
  return img;
}

const ACTIONS = ['status', 'generators', 'build', 'sprites', 'cleanup'];

export const modelTool = {
  name: 'studio_model',
  description: `3D game assets made in Blender (headless, through the heavy-job queue), each saved as a Studio asset (glb, preview render, manifest) and checked (valid glTF, normals, UVs, triangles). action: "status" says whether Blender is there; "generators" lists them with their parameters; "build" runs a generator: ${Object.keys(GENERATORS).join(', ')}, with params, a seed, and options fbx (also an .fbx for Unreal), lods ([0.5, 0.25]: decimated copies), bake (AO and normal maps from a subdivided copy), sprites ({directions: 8, size: 64, actions: ["walk"], frames: 8}: rendered from N directions for 2.5D, packed into a sheet); "sprites" renders an existing model asset (re-run from its recorded generator, so animations come along) or a workspace .glb/.fbx/.obj from N directions; "cleanup" takes an outside model (a download, a text-to-3D draft) and makes it game-ready: one mesh, transforms applied, doubles merged, normals outward, scaled to targetHeight (m), origin at the base, decimated to maxTriangles, UVs, then exported and checked. Units are metres, Blender Z up; the glb is Y up with the front toward +Z.`,
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ACTIONS },
      generator: { type: 'string', enum: Object.keys(GENERATORS) },
      params: { type: 'object', description: 'Generator parameters (see "generators")' },
      seed: { type: ['number', 'string'] },
      fbx: { type: 'boolean' }, lods: { type: 'array', items: { type: 'number' } }, bake: { type: 'boolean' }, bakeSize: { type: 'number' },
      sprites: { type: 'object', description: '{directions, size, actions, frames, elevation}' },
      directions: { type: 'number' }, size: { type: 'number' }, actions: { type: 'array', items: { type: 'string' } }, frames: { type: 'number' },
      file: { type: 'string', description: 'sprites/cleanup: a model file in the workspace (.glb, .gltf, .fbx, .obj)' },
      targetHeight: { type: 'number' }, maxTriangles: { type: 'number' },
      license: { type: 'object', description: 'cleanup: the outside model\'s licence {id, author, url}' },
      source: { type: 'object', description: 'cleanup: where the model came from (recorded in the manifest)' },
      previewSize: { type: 'number' }, timeoutSec: { type: 'number' },
      id: { type: 'string' }, project: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, style: { type: 'string' }, export: { type: 'string' },
    },
    required: ['action'],
  },
  kind: 'exec',
  sendsOut: false,
  summarize: (i) => `${i.action} ${i.generator ?? i.file ?? i.id ?? ''} ${i.seed ?? ''}`.trim(),
  run: guarded('studio_model', async (input, ctx) => {
    const { host, signal } = ctx;
    const a = String(input.action ?? '');
    if (a === 'generators') return Object.entries(GENERATORS).map(([k, v]) => `${k}: ${v}`).join('\n');
    if (a === 'status') {
      const bin = await findBlender(host, signal);
      if (!bin) return { content: HOW_TO_GET, is_error: true };
      const r = await runIn(host, bin, ['-b', '--factory-startup', '-noaudio', '--version'], { timeoutMs: 60_000, signal });
      return `Blender found: ${bin}\n${(r.output.match(/Blender \d[^\n]*/) ?? ['(version not printed)'])[0]}`;
    }
    if (!ACTIONS.includes(a)) return unknownAction('studio_model', a, ACTIONS);
    const seed = seedIn(input);
    const timeoutMs = Math.min(1800, Math.max(30, num(input.timeoutSec, 900))) * 1000;
    let job, asset;
    const sprites = input.sprites ?? (a === 'sprites' ? { directions: int(input.directions, 8, 1, 32), size: int(input.size, 64, 16, 512), actions: input.actions, frames: int(input.frames, 8, 1, 64) } : undefined);
    if (a === 'build') {
      const gen = String(input.generator ?? '');
      if (!GENERATORS[gen]) throw new Error(`build needs generator: one of ${Object.keys(GENERATORS).join(', ')}`);
      const params = { ...(input.params ?? {}) };
      if (gen === 'tree') {
        const p = { ...(LPRESETS[params.preset ?? 'tree'] ?? LPRESETS.tree), ...(params.iterations ? { iterations: params.iterations } : {}), ...(params.angle ? { angle: params.angle } : {}) };
        const t3 = turtle3d(expand({ ...p, seed }), { ...p, seed });
        Object.assign(params, { segments: t3.segments, leaves: t3.leaves });
      }
      if (gen === 'grass' && !params.texture) {
        // Blades on a transparent card, made here so the glb carries its own texture.
        const tex = grassTexture(typeof seed === 'number' ? seed : 1);
        const rel = `.harness/studio/grass-${newId()}.png`;
        await writeIn(host, rel, encodePNG(tex), signal);
        params.texture = runtimePath(host, rel);
      }
      if (gen === 'terrain' && params.heightmap) {
        const hm = String(params.heightmap);
        const rel = /\.png$/i.test(hm) ? await relIn(host, hm) : `${assetsDir(await projectOf(host, input.project))}/${hm}/height16.png`;
        params.heightmap = runtimePath(host, rel);
      }
      job = { generator: gen, params, seed: typeof seed === 'number' ? seed : [...String(seed)].reduce((s, c) => s + c.charCodeAt(0), 0), name: gen, fbx: !!input.fbx, lods: input.lods, bake: !!input.bake, bakeSize: input.bakeSize, sprites, preview: true, previewSize: input.previewSize };
      asset = { id: input.id ?? `model-${gen}-${seed}`, name: `${gen} ${seed}`, source: { type: 'procedural', generator: `blender:${gen}`, seed, params: input.params ?? {} }, tags: [gen, '3d'] };
    } else if (a === 'sprites' && input.id && !input.file) {
      const project = await projectOf(host, input.project);
      const m = JSON.parse((await readIn(host, `${assetsDir(project)}/${input.id}/asset.json`, signal)).toString('utf8'));
      const gen = String(m.source?.generator ?? '').replace(/^blender:/, '');
      if (!GENERATORS[gen]) throw new Error(`asset ${input.id} was not made by a Studio generator: pass file (its .glb) instead`);
      return modelTool.run({ ...input, action: 'build', generator: gen, params: m.source.params, seed: m.source.seed, sprites, id: `${input.id}-sprites` }, ctx);
    } else {
      if (!input.file) throw new Error(`${a} needs file: a .glb, .gltf, .fbx or .obj in the workspace`);
      const rel = await relIn(host, String(input.file));
      const name = path.posix.basename(rel).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      job = { import: runtimePath(host, rel), name, targetHeight: input.targetHeight, maxTriangles: input.maxTriangles, fbx: !!input.fbx, lods: input.lods, sprites: a === 'sprites' ? sprites : input.sprites, preview: true };
      asset = { id: input.id ?? `model-${name}`, name, source: input.source ?? { type: 'import', from: rel, cleaned: 'studio_model cleanup' }, license: input.license, tags: [...(input.tags ?? []), 'imported'] };
      if (a === 'cleanup' && !input.license?.id && !input.source) throw new Error('cleanup needs license {id, author, url} for an outside model (or source, when it came from studio_source, which records it)');
    }
    const res = await runBlenderJob(host, job, { signal, timeoutMs });
    if (res.unavailable) return { content: res.message, is_error: true };
    const { report, work } = res;
    try {
      const files = [];
      const base = (p) => path.posix.basename(String(p).replace(/\\/g, '/'));
      for (const f of report.files) files.push({ path: base(f), role: files.length && !report.pieces ? (base(f).endsWith('.fbx') ? 'fbx' : 'extra') : (report.pieces && files.length ? 'piece' : 'main'), data: await readIn(host, relOut(host, work, f), signal) });
      for (const [i, l] of (report.lods ?? []).entries()) files.push({ path: base(l.file), role: `lod${i + 1}`, data: await readIn(host, relOut(host, work, l.file), signal) });
      for (const [k, f] of Object.entries(report.textures ?? {})) files.push({ path: base(f), role: k, data: await readIn(host, relOut(host, work, f), signal) });
      for (const [k, f] of Object.entries(report.baked ?? {})) files.push({ path: base(f), role: k === 'glb' ? 'baked' : `bake-${k}`, data: await readIn(host, relOut(host, work, f), signal) });
      let sheet = null;
      if (report.sprites) {
        sheet = await spriteSheet(host, work, report.sprites, signal);
        files.push({ path: 'sprites.png', role: 'sprites', image: sheet.image }, { path: 'sprites.aseprite.json', role: 'data', data: JSON.stringify(asepriteJson(sheet, { image: 'sprites.png' }), null, 1) }, { path: 'sprites.frames.json', role: 'data', data: JSON.stringify(framesJson(sheet, { image: 'sprites.png' }), null, 1) });
      }
      let pv = null;
      if (report.preview) { const data = await readIn(host, relOut(host, work, report.preview), signal); files.push({ path: 'preview.png', role: 'preview', data }); pv = decodePNG(data); }
      // Checks now, recorded in the manifest (the gates repeat them).
      const checks = [];
      const notes = [];
      for (const f of files.filter((x) => /\.glb$/.test(x.path) && ['main', 'piece', 'lod1'].includes(x.role))) {
        const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-')), f.path);
        await fsp.writeFile(tmp, f.data);
        try {
          const g = await inspectGltf(tmp);
          const c = await checkGltf(f.data, tmp);
          checks.push({ gate: 'asset-3d', file: f.path, pass: !c.problems.length, summary: c.problems.length ? c.problems.join('; ') : `${g.triangles} tris, normals and UVs, ${c.degenerate} degenerate`, at: new Date().toISOString() });
          if (f.role === 'main') notes.push(`${f.path}: ${g.triangles} triangles, ${g.size?.join(' x ')} m (glTF Y up), ${g.materials} material(s)${c.animations.length ? `, animations ${c.animations.join(', ')}` : ''}${c.skins ? `, ${c.skins} skin` : ''}`);
          if (c.problems.length) notes.push(`problems in ${f.path}: ${c.problems.join('; ')}`);
        } finally { await fsp.rm(path.dirname(tmp), { recursive: true, force: true }); }
      }
      const kind = job.generator === 'material' ? 'material' : 'model';
      const saved = await save(ctx, input, {
        ...asset, kind, dimension: '3d', files,
        meta: { triangles: report.triangles, ...(report.pieces ? {} : { sizeM: report.size }), materials: report.materials, ...(report.bones ? { bones: report.bones, actions: report.actions } : {}), ...(report.pieces ? { pieces: report.pieces.map((p) => ({ piece: p.piece, file: base(p.file), triangles: p.triangles, sizeM: p.size })) } : {}), ...(report.lods ? { lods: report.lods.map((l) => ({ ratio: l.ratio, triangles: l.triangles })) } : {}), ...(sheet ? { frameSize: [sheet.frameWidth, sheet.frameHeight], spriteFrames: sheet.frames.length, directions: report.sprites.directions } : {}), ...(report.material ? { material: report.material } : {}), units: 'metres', up: 'Y (glTF)' },
        checks,
      });
      const lines = [...saved.lines, `Blender ${res.took}: ${report.triangles} triangles, ${report.size.join(' x ')} m (Blender x y z), materials ${report.materials.join(', ')}${report.bones ? `, ${report.bones} bones, actions ${report.actions.join(', ')}` : ''}${report.lods ? `, LODs ${report.lods.map((l) => l.triangles).join('/')} tris` : ''}${report.pieces ? `, pieces ${report.pieces.map((p) => p.piece).join(', ')}` : ''}${report.sprites ? `, sprites ${report.sprites.directions} directions x ${report.sprites.frames} frames (rows: action_direction)` : ''}.`, ...notes, ...(report.warnings?.length ? [`Warnings: ${report.warnings.join('; ')}`] : [])];
      const images = [];
      if (pv) images.push(preview(pv));
      if (sheet) images.push(preview(sheet.image, { min: 256, max: 1024 }));
      return { content: lines.join('\n'), images, is_error: checks.some((c) => !c.pass) };
    } finally { await removeIn(host, work, signal).catch(() => {}); }
  }),
};

