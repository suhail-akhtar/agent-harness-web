// The asset gates: what proves Studio's assets are usable before a game takes them.
//   asset-manifest  every asset has asset.json, a licence, its files, and matching hashes
//   asset-budget    triangles, texture sizes, power-of-two textures, file sizes vs the budgets
//   asset-3d        glTF valid, plausible scale, normals and UVs, no degenerate meshes
//   asset-2d        sprite sheets match their JSON, transparent backgrounds, palette limits
//   audio-valid     WAVs parse, are not silent and not clipped
//   level-playable  levels can be finished (the platformer solver, or start-to-exit paths)

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectGltf } from '../lib-gltf.mjs';
import { analyze, decodeWav } from './audio/wav.mjs';
import { solvePlatformer } from './gen/platformer.mjs';
import { checkConnected } from './gen/levels.mjs';
import { checkGltf } from './gltf-check.mjs';
import { assetsForGate, manifestProblems, projectJson, verifyAsset } from './library.mjs';
import { decodePNG, pngSize } from './raster/png.mjs';
import { checkSheet } from './sprites/sheet.mjs';

export const DEFAULT_BUDGETS = { trianglesPerAsset: 20000, textureMax: 2048, assetMb: 64, powerOfTwo: true };
const POT = (n) => n > 0 && (n & (n - 1)) === 0;
const ext = (f) => path.posix.extname(f).toLowerCase();

/** A JPEG's size from its SOF marker. */
export function jpegSize(buf) {
  for (let o = 2; o + 9 < buf.length;) {
    if (buf[o] !== 0xff) { o++; continue; }
    const m = buf[o + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: buf.readUInt16BE(o + 7), height: buf.readUInt16BE(o + 5) };
    o += 2 + buf.readUInt16BE(o + 2);
  }
  throw new Error('no JPEG frame header');
}

const imageSize = (f, data) => (ext(f) === '.png' ? pngSize(data) : ext(f) === '.jpg' || ext(f) === '.jpeg' ? jpegSize(data) : null);

/** Runs `check(asset)` over the assets a filter picks; collects problems per asset. */
async function over(host, signal, pick, check, what) {
  const assets = (await assetsForGate(host, signal)).filter((a) => a.manifest && pick(a.manifest));
  if (!assets.length) return { pass: true, summary: `no ${what} assets` };
  const bad = [], ok = [];
  for (const a of assets) {
    try {
      const r = await check(a);
      if (r.problems.length) bad.push(`${a.project === '.' ? '' : `${a.project}/`}${a.id}: ${r.problems.slice(0, 8).join('; ')}`);
      else ok.push(`${a.id}${r.note ? ` (${r.note})` : ''}`);
    } catch (e) { bad.push(`${a.id}: ${e.message}`); }
  }
  return bad.length
    ? { pass: false, summary: `${bad.length} of ${assets.length} ${what} asset(s) fail`, details: bad.join('\n') }
    : { pass: true, summary: `${assets.length} ${what} asset(s) pass`, details: ok.join('\n') };
}

const anyAssets = async (host, signal, pick = () => true) => { try { return (await assetsForGate(host, signal)).some((a) => !a.manifest || pick(a.manifest)); } catch { return false; } };

/** A temporary copy of bytes as a file (lib-gltf reads files). */
async function withTemp(name, data, fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-gate-'));
  const f = path.join(dir, path.basename(name));
  try { await fsp.writeFile(f, data); return await fn(f); } finally { await fsp.rm(dir, { recursive: true, force: true }); }
}

export function registerGates(api) {
  api.registerGate({
    name: 'asset-manifest',
    description: 'Every Studio asset (.studio/assets/<id>) has an asset.json with a name, kind, source and licence, every file it lists exists, and every hash matches.',
    applies: (host, signal) => anyAssets(host, signal),
    async run({ host, signal }) {
      const assets = await assetsForGate(host, signal);
      if (!assets.length) return { pass: true, summary: 'no Studio assets' };
      const bad = [];
      for (const a of assets) {
        if (!a.manifest) { bad.push(`${a.id}: ${a.error}`); continue; }
        const p = manifestProblems(a.manifest, a.id);
        const v = await verifyAsset(a.read, a.manifest);
        if (v.missing.length) p.push(`missing files: ${v.missing.join(', ')}`);
        if (v.changed.length) p.push(`changed since recorded (hash differs): ${v.changed.join(', ')}`);
        if (p.length) bad.push(`${a.id}: ${p.join('; ')}`);
      }
      return bad.length
        ? { pass: false, summary: `${bad.length} of ${assets.length} asset manifest(s) have problems`, details: `${bad.join('\n')}\nFix the asset or rebuild it with its studio_* tool (which rewrites asset.json); for a file you changed on purpose, run studio_library {"action":"rehash"}.` }
        : { pass: true, summary: `${assets.length} asset(s): manifests complete, licences recorded, hashes match` };
    },
  });

  api.registerGate({
    name: 'asset-budget',
    description: 'Studio assets stay within the project budgets (.studio/project.json budgets: trianglesPerAsset, textureMax, assetMb; defaults 20000, 2048, 64): triangles per model and LOD, texture sizes, power-of-two textures, total file size.',
    applies: (host, signal) => anyAssets(host, signal),
    async run({ host, signal }) {
      const cache = new Map();
      return over(host, signal, () => true, async (a) => {
        if (!cache.has(a.project)) cache.set(a.project, { ...DEFAULT_BUDGETS, ...((await projectJson(host, a.project, signal)).budgets ?? {}) });
        const B = cache.get(a.project);
        const m = a.manifest, problems = [];
        let bytes = 0, mainTris = null;
        const notes = [];
        for (const f of m.files) {
          const data = await a.read(f.path);
          bytes += data.length;
          if (ext(f.path) === '.glb' || ext(f.path) === '.gltf') {
            const g = await withTemp(f.path, data, (file) => inspectGltf(file)).catch((e) => { problems.push(`${f.path}: ${e.message}`); return null; });
            if (!g) continue;
            const limit = f.role === 'main' ? B.trianglesPerAsset : mainTris ?? B.trianglesPerAsset;
            if (g.triangles > limit) problems.push(`${f.path}: ${g.triangles} triangles > ${limit}${f.role === 'main' ? ' (trianglesPerAsset)' : ' (an LOD must not have more than the main mesh)'}`);
            if (f.role === 'main') mainTris = g.triangles;
            notes.push(`${g.triangles} tris`);
          }
          const size = (() => { try { return imageSize(f.path, data); } catch { return null; } })();
          if (size && f.role !== 'preview') {
            if (Math.max(size.width, size.height) > B.textureMax) problems.push(`${f.path}: ${size.width}x${size.height} > textureMax ${B.textureMax}`);
            if (B.powerOfTwo && ['texture', 'material'].includes(m.kind) && (!POT(size.width) || !POT(size.height))) problems.push(`${f.path}: ${size.width}x${size.height} is not a power of two (textures that mipmap and compress need 2^n sides)`);
          }
        }
        if (bytes > B.assetMb * 1048576) problems.push(`${(bytes / 1048576).toFixed(1)} MB > assetMb ${B.assetMb}`);
        return { problems, note: [...notes, `${(bytes / 1024).toFixed(0)} KB`].join(', ') };
      }, 'budgeted');
    },
  });

  api.registerGate({
    name: 'asset-3d',
    description: 'Every Studio model asset is a valid glTF 2.0 with geometry at a plausible scale (0.01-500 m, and its recorded size), normals and UVs on every mesh, and no more than 1% degenerate triangles.',
    applies: (host, signal) => anyAssets(host, signal, (m) => m.kind === 'model'),
    run: ({ host, signal }) => over(host, signal, (m) => m.kind === 'model', async (a) => {
      const problems = [];
      const glbs = a.manifest.files.filter((f) => ['.glb', '.gltf'].includes(ext(f.path)));
      if (!glbs.length) return { problems: ['no .glb or .gltf file'] };
      let note = '';
      for (const f of glbs) {
        const data = await a.read(f.path);
        const g = await withTemp(f.path, data, (file) => inspectGltf(file));
        if (!g.meshes || !g.triangles) { problems.push(`${f.path}: no geometry`); continue; }
        const big = Math.max(...(g.size ?? [0]));
        if (g.size && (big > 500 || big < 0.01)) problems.push(`${f.path}: implausible size ${g.size.join(' x ')} m (glTF units are metres)`);
        const want = a.manifest.meta?.sizeM;
        if (f.role === 'main' && Array.isArray(want) && g.size) {
          // Recorded as x, y, z in Blender (Z up); glTF is Y up: compare the sorted extents.
          const s1 = [...g.size].sort((x, y) => x - y), s2 = [...want].sort((x, y) => x - y);
          if (s1.some((v, i) => Math.abs(v - s2[i]) > Math.max(0.05, s2[i] * 0.15))) problems.push(`${f.path}: size ${g.size.join(' x ')} m differs from the recorded ${want.join(' x ')} m`);
        }
        const c = await checkGltf(data, f.path);
        problems.push(...c.problems.map((p) => `${f.path}: ${p}`));
        if (f.role === 'main') note = `${g.triangles} tris, ${g.size?.join('x')} m${c.animations.length ? `, animations: ${c.animations.join(', ')}` : ''}`;
      }
      return { problems, note };
    }, 'model'),
  });

  api.registerGate({
    name: 'asset-2d',
    description: 'Studio 2D assets are usable: PNGs decode; sprite sheets\' frames lie inside the image at the recorded frame size; sprites, sheets, icons and particles have transparent backgrounds; colour counts stay within a recorded palette limit; tilesets are whole tiles.',
    applies: (host, signal) => anyAssets(host, signal, (m) => m.dimension === '2d' && ['sprite', 'spritesheet', 'tileset', 'ui', 'icon', 'particles', 'font', 'background', 'texture'].includes(m.kind)),
    run: ({ host, signal }) => over(host, signal, (m) => m.dimension === '2d' && ['sprite', 'spritesheet', 'tileset', 'ui', 'icon', 'particles', 'font', 'background', 'texture'].includes(m.kind), async (a) => {
      const m = a.manifest, problems = [];
      const pngs = m.files.filter((f) => ext(f.path) === '.png' && f.role !== 'preview');
      const transparent = ['sprite', 'spritesheet', 'icon', 'particles'].includes(m.kind);
      for (const f of pngs) {
        let img;
        try { img = decodePNG(await a.read(f.path)); } catch (e) { problems.push(`${f.path}: ${e.message}`); continue; }
        if (transparent && f.role === 'main') {
          const fw = m.meta?.frameSize?.[0] ?? img.width, fh = m.meta?.frameSize?.[1] ?? img.height;
          let cells = 0, opaqueCorners = 0;
          for (let y = 0; y + fh <= img.height; y += fh + (m.meta?.padding ?? 0)) for (let x = 0; x + fw <= img.width; x += fw + (m.meta?.padding ?? 0)) {
            cells++;
            if ([[x, y], [x + fw - 1, y], [x, y + fh - 1], [x + fw - 1, y + fh - 1]].filter(([px, py]) => img.alpha(px, py) > 0).length >= 3) opaqueCorners++;
          }
          if (cells && opaqueCorners / cells > 0.25) problems.push(`${f.path}: ${opaqueCorners} of ${cells} frame(s) have an opaque background (corners not transparent)`);
        }
        const limit = m.meta?.maxColors ?? (Array.isArray(m.meta?.palette) ? m.meta.palette.length + 1 : undefined);
        if (limit && f.role === 'main') { const n = img.colors().size; if (n > limit) problems.push(`${f.path}: ${n} colours, more than the palette limit ${limit}`); }
        if (m.kind === 'tileset' && m.meta?.tile && f.role === 'main' && (img.width % m.meta.tile || img.height % m.meta.tile)) problems.push(`${f.path}: ${img.width}x${img.height} is not whole ${m.meta.tile}px tiles`);
        if (m.kind === 'spritesheet' && f.role === 'main') {
          const descs = m.files.filter((d) => ext(d.path) === '.json' && /aseprite|frames|sheet/i.test(d.path));
          if (!descs.length) problems.push('a sprite sheet without its frames JSON');
          for (const d of descs) {
            const r = checkSheet(JSON.parse((await a.read(d.path)).toString('utf8')), img, m.meta?.frameSize);
            problems.push(...r.problems.map((p) => `${d.path}: ${p}`));
            if (m.meta?.frames && r.frames !== m.meta.frames) problems.push(`${d.path}: ${r.frames} frames, the asset says ${m.meta.frames}`);
          }
        }
      }
      if (!pngs.length && m.kind !== 'font') problems.push('no PNG image');
      return { problems };
    }, '2D'),
  });

  api.registerGate({
    name: 'audio-valid',
    description: 'Every Studio audio and music asset\'s WAV files parse, have length, are not silent (peak above -50 dBFS), are not clipped (under 0.1% of samples at full scale), and last about as long as recorded.',
    applies: (host, signal) => anyAssets(host, signal, (m) => m.kind === 'audio' || m.kind === 'music'),
    run: ({ host, signal }) => over(host, signal, (m) => m.kind === 'audio' || m.kind === 'music', async (a) => {
      const problems = [];
      const wavs = a.manifest.files.filter((f) => ext(f.path) === '.wav');
      if (!wavs.length) return { problems: ['no .wav file'] };
      let note = '';
      for (const f of wavs) {
        let w;
        try { w = decodeWav(await a.read(f.path)); } catch (e) { problems.push(`${f.path}: ${e.message}`); continue; }
        const s = analyze(w.channels, w.sampleRate);
        if (s.duration < 0.02) problems.push(`${f.path}: only ${(s.duration * 1000).toFixed(0)} ms long`);
        if (!(s.peakDb > -50)) problems.push(`${f.path}: silent (peak ${s.peakDb} dBFS)`);
        if (s.clippedRatio > 0.001) problems.push(`${f.path}: clipped (${s.clipped} samples at full scale)`);
        const want = a.manifest.meta?.durationS;
        if (want && f.role === 'main' && Math.abs(s.duration - want) > Math.max(0.05, want * 0.1)) problems.push(`${f.path}: ${s.duration.toFixed(2)} s, the asset says ${want} s`);
        note = `${s.duration.toFixed(2)} s, peak ${s.peakDb} dBFS, ${s.lufs} LUFS`;
      }
      return { problems, note };
    }, 'audio'),
  });

  api.registerGate({
    name: 'level-playable',
    description: 'Every Studio level asset can be finished: platformer levels by the solver with the level\'s own physics (jump height, run speed, gravity); dungeons, caves, mazes and maps by a path from start (S) to exit (E).',
    applies: (host, signal) => anyAssets(host, signal, (m) => m.kind === 'level'),
    run: ({ host, signal }) => over(host, signal, (m) => m.kind === 'level', async (a) => {
      const f = a.manifest.files.find((x) => x.role === 'level') ?? a.manifest.files.find((x) => x.path === 'level.json');
      if (!f) return { problems: ['no level.json (role "level")'] };
      const lv = JSON.parse((await a.read(f.path)).toString('utf8'));
      if (!Array.isArray(lv.rows)) return Array.isArray(lv.grid) ? { problems: [], note: 'a tile map (no start or exit to reach)' } : { problems: [`${f.path}: no rows`] };
      if (lv.type === 'platformer') {
        const r = solvePlatformer(lv.rows, lv.physics ?? {});
        return r.ok ? { problems: [], note: `solved in ${r.steps} moves, ${r.coinsReached}/${r.coins} coins reachable` } : { problems: [`${r.reason} (jump ${r.physics?.jumpHeight} tiles, run ${r.physics?.runSpeed} tiles/s; ${r.states ?? 0} places reached)`] };
      }
      if (!lv.rows.some((r) => r.includes('S'))) return { problems: [], note: 'no start marked: a texture-like map, nothing to finish' };
      const r = checkConnected(lv.rows, lv.type);
      return r.ok ? { problems: [], note: `start to exit in ${r.pathLength} steps, ${Math.round(r.reachable * 100)}% of the floor reachable` } : { problems: [r.reason] };
    }, 'level'),
  });
}
