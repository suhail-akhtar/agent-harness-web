// Studio's desktop module, server side: the routes its pages call (routes.call, auth "user": signed
// in like the rest of the API). They read the files Studio's parts share (sdk/FORMATS.md) in the
// person's folders - .studio/project.json, .studio/assets/<id>/asset.json, .studio/playtests/<id>/
// report.json - the shared asset library (~/.harness/assets), the heavy-job queue (sdk/jobs.mjs)
// and what is installed on this machine. The only writes: a stage's approval or comment in a
// project.json (the person's own click, or an agent's command they allowed), and cancelling a job.
//
//   studio/summary        the home: recent projects, jobs, engines, counts
//   studio/projects       every project in the folders (newest first)
//   studio/project        one project: stages, design doc, builds, playtests, assets
//   studio/project/stage  (POST) approve, request changes, comment on or reopen a stage
//   studio/assets         assets of every project and the library, with filters and facets
//   studio/asset          one asset: provenance, license, checks, files
//   studio/file           a file as base64 (models, images, audio; text with text: true)
//   studio/scenes         engine scenes and levels of the projects
//   studio/scene          a scene's outline (Godot .tscn nodes)
//   studio/renders        renders, previews and captures, newest first
//   studio/builds         builds of every project
//   studio/build          one build with its log and the problems in it (linked to files)
//   studio/source         lines of a source file around a line (a build problem's)
//   studio/playtests      playtest reports, newest first
//   studio/playtest       one report: events, metrics, issues, verdicts, frames
//   studio/jobs           the heavy-job queue (running, waiting, the last hour's)
//   studio/jobs/cancel    (POST) cancel a job
//   studio/engines        what each engine has on this machine: installed, version, toolchain gaps
//   studio/badges         { jobs }: running and waiting jobs (the Jobs badge)
//
// Where it looks: the folders local sessions may work in (the harness home's workspaces and tmp,
// HARNESS_LOCAL_ROOTS: the desktop's projects), the server's own session folders and the library.
// Every path a page or an agent names is checked: relative, no "..", and its real path (links and
// junctions followed) inside one of those folders. They are the server's folders, so an
// administrator (or the operator's own token: the desktop) sees them; a member does not.

import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { harnessPaths } from '@harness/plugin-sdk/runtime';
import { writeFileAtomic } from '@harness/plugin-sdk/runtime';
import { within } from '@harness/plugin-sdk/runtime';
import { findBinary } from '@harness/plugins/visual/lib/binaries.mjs';
import { ENGINES } from '../sdk/engine.mjs';
import { cancelJob, listJobs } from '../sdk/jobs.mjs';

export class StudioError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new StudioError(400, m);
const notFound = (m) => new StudioError(404, m);

const SKIP = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', 'coverage', '.venv', 'venv', '__pycache__', 'target',
  'Intermediate', 'Saved', 'DerivedDataCache', 'Binaries', 'Library', 'Temp', 'Logs', 'obj', 'Builds', '.godot', '.import']);
const MAX_FILE = 48 * 1024 * 1024;
const MAX_TEXT = 2 * 1024 * 1024;
const MIME = {
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ktx2': 'image/ktx2', '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.json': 'application/json', '.tmj': 'application/json',
  '.md': 'text/markdown', '.txt': 'text/plain', '.log': 'text/plain', '.tscn': 'text/plain', '.gd': 'text/plain',
};
const IMAGE = /\.(png|jpe?g|webp|gif)$/i;
const MODEL = /\.(glb|gltf)$/i;
const AUDIO = /\.(wav|mp3|ogg|flac)$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SID = /^[a-f0-9]{16}$/;
const PID = /^[a-f0-9]{12}$/;

const clip = (s, n) => { const t = typeof s === 'string' ? s : s === undefined || s === null ? '' : String(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const str = (v, n = 200) => (typeof v === 'string' ? clip(v, n) : undefined);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const toPosix = (p) => p.split(path.sep).join('/');
const pidOf = (realDir) => crypto.createHash('sha1').update(realDir.toLowerCase()).digest('hex').slice(0, 12);
const mimeOf = (f) => MIME[path.extname(f).toLowerCase()] ?? 'application/octet-stream';

async function readJsonFile(file, max = MAX_TEXT) {
  const st = await fsp.stat(file).catch(() => null);
  if (!st?.isFile()) return undefined;
  if (st.size > max) throw bad(`${path.basename(file)} is over ${Math.round(max / 1048576)} MB`);
  try { return { value: JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, '')), mtime: st.mtimeMs, size: st.size }; } catch (e) { return { error: `not valid JSON: ${e.message}`, mtime: st.mtimeMs, size: st.size }; }
}

// ---------------- where Studio may look ----------------

/** The folders Studio reads (real paths, existing ones only): workspaces, session folders and the library. */
export function studioRoots(env = process.env) {
  const p = harnessPaths({ env });
  const real = (d) => { try { return fs.realpathSync.native(d); } catch { return null; } };
  const workspaces = [...new Set([...p.localRoots, path.join(p.dataDir, 'workspaces')].map(real).filter(Boolean))];
  const libraryDir = path.join(p.layout.home, 'assets');
  return { workspaces, library: real(libraryDir), libraryDir, dataWorkspaces: path.join(p.dataDir, 'workspaces') };
}

/** A path from a page or an agent, relative and clean: forward slashes, no "..", not absolute. */
export function cleanRel(rel) {
  const s = String(rel ?? '').replace(/\\/g, '/').trim();
  if (!s) throw bad('a path is needed');
  if (s.length > 1000 || s.includes('\0')) throw bad('not a path');
  if (s.startsWith('/') || /^[a-z]:/i.test(s) || s.startsWith('~')) throw bad(`${clip(s, 80)}: a path relative to its folder is needed`);
  const segs = s.split('/').filter((x) => x && x !== '.');
  if (segs.some((x) => x === '..')) throw new StudioError(403, `${clip(s, 80)}: ".." is not allowed`);
  if (!segs.length) throw bad('a path is needed');
  return segs.join('/');
}

/** The real path of base/rel, when it exists and stays inside base after links and junctions. */
export async function insideBase(base, rel, { mustExist = true } = {}) {
  const r = cleanRel(rel);
  const realBase = await fsp.realpath(base).catch(() => null);
  if (!realBase) throw notFound('that folder is not there');
  const target = path.join(realBase, ...r.split('/'));
  const real = await fsp.realpath(target).catch(() => null);
  if (!real) { if (mustExist) throw notFound(`${r} is not there`); return target; }
  if (!within(realBase, real)) throw new StudioError(403, `${r} leads outside its folder`);
  return real;
}

/** An absolute folder or file a page or an agent names: allowed only inside one of Studio's folders. */
export async function allowedAbsolute(p, roots) {
  const s = String(p ?? '');
  if (!path.isAbsolute(s) || s.includes('\0')) throw bad('an absolute path is needed');
  const real = await fsp.realpath(s).catch(() => null);
  if (!real) throw notFound(`${clip(s, 120)} is not there`);
  const all = [...roots.workspaces, ...(roots.library ? [roots.library] : [])];
  if (!all.some((r) => within(r, real))) throw new StudioError(403, `${clip(s, 120)} is outside the folders Studio may read (the projects and workspaces of this app)`);
  return real;
}

// ---------------- projects ----------------

/** A Studio project: a folder with .studio/project.json, or with Studio assets only (what asset-pack makes). */
const isProjectDir = (dir) => fs.existsSync(path.join(dir, '.studio', 'project.json')) || fs.existsSync(path.join(dir, '.studio', 'assets'));

/** Studio projects under the roots (not inside another project; links not followed). */
export async function findProjectDirs(roots, { depth = 3, maxDirs = 6000 } = {}) {
  const found = new Set();
  let seen = 0;
  for (const root of roots) {
    const queue = [{ dir: root, d: 0 }];
    while (queue.length && seen < maxDirs) {
      const { dir, d } = queue.shift();
      seen++;
      if (isProjectDir(dir)) { found.add(dir); continue; }
      if (d >= depth) continue;
      let entries = [];
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.') && !SKIP.has(e.name)) queue.push({ dir: path.join(dir, e.name), d: d + 1 });
    }
  }
  return [...found];
}

const STAGE_STATUS = new Set(['pending', 'active', 'in-progress', 'review', 'done', 'approved', 'changes-requested', 'skipped', 'failed']);

function normProject(v, dir, root, mtime) {
  const p = obj(v);
  const id = pidOf(dir);
  return {
    id, dir, root, folder: path.basename(dir), rel: toPosix(path.relative(root, dir)) || '.',
    name: str(p.name, 120) || path.basename(dir), engine: str(p.engine, 20) || 'web', dimension: str(p.dimension, 8) || '', genre: str(p.genre, 160) || '',
    created: str(p.created, 40), updated: mtime, engineProject: str(p.engineProject, 400), design: str(p.design, 400),
    budgets: Object.fromEntries(Object.entries(obj(p.budgets)).filter(([, x]) => typeof x === 'number').slice(0, 20)),
    stages: arr(p.stages).filter((s) => s && typeof s.id === 'string').slice(0, 40).map((s) => ({
      id: clip(s.id, 60), title: str(s.title, 120), status: STAGE_STATUS.has(s.status) ? s.status : str(s.status, 30) || 'pending',
      approvedAt: str(s.approvedAt, 40), approvedBy: str(s.approvedBy, 80), note: str(s.note ?? s.summary, 2000),
      comments: arr(s.comments).slice(-50).map((c) => ({ by: str(c?.by, 80) || 'someone', at: str(c?.at, 40), text: str(c?.text, 2000) || '' })),
    })),
    builds: arr(p.builds).filter((b) => b && typeof b.id === 'string').slice(-100).map((b) => normBuild(b)),
    playtests: arr(p.playtests).filter((x) => typeof x === 'string').slice(-200),
  };
}

function normBuild(b) {
  return {
    id: clip(b.id, 80), platform: str(b.platform, 40) || '', config: str(b.config, 40), path: str(b.path, 400), status: str(b.status, 30) || 'unknown',
    at: str(b.at, 40), took: num(b.took) ?? num(b.durationS), size: num(b.size), engine: str(b.engine, 20),
    log: str(b.log ?? b.logFile, 400), summary: str(b.summary, 400),
    problems: arr(b.problems).slice(0, 200).map((x) => ({ severity: x?.severity === 'warning' ? 'warning' : 'error', message: str(x?.message, 600) || '', file: str(x?.file, 400), line: num(x?.line) })),
  };
}

async function countDirs(dir, file) {
  try { return (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, file))).length; } catch { return 0; }
}

// ---------------- assets ----------------

const KINDS = ['model', 'sprite', 'spritesheet', 'tileset', 'texture', 'material', 'audio', 'music', 'font', 'ui', 'level', 'heightmap'];

function normAsset(v, folder, where) {
  const a = obj(v);
  const files = arr(a.files).filter((f) => f && typeof f.path === 'string').slice(0, 60).map((f) => ({ path: clip(f.path, 400), role: str(f.role, 40) || 'file' }));
  const lic = obj(a.license);
  const src = obj(a.source);
  const checks = arr(a.checks).slice(0, 60).map((c) => ({ gate: str(c?.gate, 80) || 'check', pass: c?.pass === true, summary: str(c?.summary, 400), at: str(c?.at, 40), severity: str(c?.severity, 20) }));
  const meta = obj(a.meta);
  return {
    id: str(a.id, 100) || path.basename(folder), name: str(a.name, 160) || str(a.id, 100) || path.basename(folder), kind: KINDS.includes(a.kind) ? a.kind : str(a.kind, 30) || 'file',
    dimension: str(a.dimension, 8) || '', style: str(a.style, 80) || '', tags: arr(a.tags).filter((t) => typeof t === 'string').slice(0, 20).map((t) => clip(t, 40)),
    license: { id: str(lic.id, 60) || (typeof a.license === 'string' ? clip(a.license, 60) : ''), author: str(lic.author, 120), url: str(lic.url, 400) },
    source: { type: str(src.type, 30) || '', generator: str(src.generator, 120), provider: str(src.provider, 80), model: str(src.model, 120), prompt: str(src.prompt, 2000), seed: num(src.seed) ?? str(src.seed, 40), url: str(src.url, 400), id: str(src.id, 120), params: src.params && typeof src.params === 'object' && JSON.stringify(src.params).length <= 4000 ? src.params : undefined },
    hashes: Object.fromEntries(Object.entries(obj(a.hashes)).filter(([, x]) => typeof x === 'string').slice(0, 60).map(([k, x]) => [clip(k, 200), clip(x, 100)])),
    meta: Object.fromEntries(Object.entries(meta).slice(0, 40).filter(([, x]) => ['number', 'string', 'boolean'].includes(typeof x) || Array.isArray(x) || (x && typeof x === 'object')).map(([k, x]) => [clip(k, 60), typeof x === 'string' ? clip(x, 400) : Array.isArray(x) ? x.slice(0, 64) : x])),
    checks, checksPassed: checks.filter((c) => c.pass).length, checksFailed: checks.filter((c) => !c.pass).length,
    engines: Object.fromEntries(Object.entries(obj(a.engines)).slice(0, 10).map(([k, e]) => [clip(k, 20), { path: str(obj(e).path, 400), importedAt: str(obj(e).importedAt, 40) }])),
    created: str(a.created, 40), updated: str(a.updated, 40),
    files, ...where,
  };
}

/** The file of a role (preview, main, lodN...), else the first that fits. */
function pick(files, roles, test) {
  for (const r of roles) { const f = files.find((x) => x.role === r && (!test || test.test(x.path))); if (f) return f.path; }
  return test ? files.find((x) => test.test(x.path))?.path : undefined;
}

function assetViews(a) {
  const main = pick(a.files, ['main'], undefined) ?? a.files[0]?.path;
  const preview = pick(a.files, ['preview', 'thumbnail', 'thumb'], IMAGE) ?? (['sprite', 'spritesheet', 'tileset', 'texture', 'ui', 'heightmap'].includes(a.kind) ? pick(a.files, ['main', 'sheet', 'atlas'], IMAGE) : undefined);
  const model = MODEL.test(main ?? '') ? main : pick(a.files, ['main', 'lod0'], MODEL);
  const lods = a.files.filter((f) => /^lod\d+$/.test(f.role) && MODEL.test(f.path)).sort((x, y) => x.role.localeCompare(y.role, 'en', { numeric: true }));
  const audio = AUDIO.test(main ?? '') ? main : pick(a.files, ['main', 'preview'], AUDIO);
  // A level: its Tiled map when it has one (it names its tileset), else its level JSON.
  const level = a.kind === 'level' ? (pick(a.files, ['tiled', 'main', 'level'], /\.tmj$/i) ?? pick(a.files, ['level', 'main'], /\.json$/i) ?? main) : undefined;
  const viewer = model ? '3d' : audio ? 'audio' : a.kind === 'level' ? 'level' : IMAGE.test(main ?? '') || preview ? '2d' : null;
  return { main, preview, model, audio, level, lods: lods.map((f) => ({ role: f.role, path: f.path })), viewer };
}

async function readAssetsIn(dir, where) {
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries.slice(0, 2000)) {
    if (!e.isDirectory() || e.isSymbolicLink()) continue;
    const folder = path.join(dir, e.name);
    const r = await readJsonFile(path.join(folder, 'asset.json')).catch(() => undefined);
    if (!r) continue;
    if (r.error) { out.push({ ...normAsset({ id: e.name }, folder, where), error: r.error, folder, mtime: r.mtime }); continue; }
    const a = normAsset(r.value, folder, where);
    // Files are relative to the asset's folder (the library's layout); a project's may name a project path instead.
    const files = [];
    for (const f of a.files) {
      let base = 'asset';
      let st = await fsp.stat(path.join(folder, ...f.path.split('/'))).catch(() => null);
      if (!st && where.projectDir) { st = await fsp.stat(path.join(where.projectDir, ...f.path.split('/'))).catch(() => null); if (st) base = 'project'; }
      files.push({ ...f, base, exists: !!st?.isFile(), size: st?.size });
    }
    out.push({ ...a, files, folder, folderName: e.name, mtime: r.mtime, ...assetViews({ ...a, files }) });
  }
  return out;
}

// ---------------- builds ----------------

/**
 * Problems in a build or run log, with the file and line when the line names one: MSVC and Unreal
 * ("File.cpp(12): error C2065: ..."), GCC, Clang and TypeScript ("file.ts:12:5: error ..."), Godot
 * ("SCRIPT ERROR: ... at: f (res://player.gd:12)", "res://x.gd:3 - Parse Error: ..."), Unity C#
 * ("Assets/P.cs(3,9): error CS0103: ..."), Unreal logs ("LogBlueprint: Error: ..."), Python tracebacks.
 */
export function parseProblems(log, max = 300) {
  const out = [];
  const lines = String(log ?? '').replace(/\r/g, '').split('\n');
  const push = (severity, message, file, line, i) => { if (out.length < max) out.push({ severity, message: clip(message.trim(), 600), ...(file ? { file: file.replace(/\\/g, '/') } : {}), ...(line ? { line } : {}), logLine: i + 1 }); };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if ((m = /^\s*(.+?\.(?:cpp|h|hpp|c|cs|inl|usf|ush))\((\d+)(?:,\d+)?\)\s*:\s*(fatal error|error|warning)\s*([A-Z]*\d*)?\s*:?\s*(.*)$/i.exec(l))) { push(/warning/i.test(m[3]) ? 'warning' : 'error', `${m[4] ? `${m[4]}: ` : ''}${m[5]}`, m[1], Number(m[2]), i); continue; }
    if ((m = /^\s*((?:[A-Za-z]:)?[^\s:()]+\.[A-Za-z0-9]{1,6}):(\d+)(?::\d+)?\s*[:-]\s*(fatal error|error|warning)\b:?\s*(.*)$/i.exec(l))) { push(/warning/i.test(m[3]) ? 'warning' : 'error', m[4], m[1], Number(m[2]), i); continue; }
    if ((m = /^\s*(res:\/\/[^\s:]+):(\d+)\s*-\s*(.*)$/.exec(l))) { push(/warn/i.test(m[3]) ? 'warning' : 'error', m[3], m[1], Number(m[2]), i); continue; }
    if ((m = /^\s*(SCRIPT ERROR|ERROR|USER ERROR|WARNING|USER WARNING):\s*(.*)$/.exec(l))) {
      const at = /\(?(res:\/\/[^\s:()]+):(\d+)\)?/.exec(lines[i + 1] ?? '') ?? /\(?(res:\/\/[^\s:()]+):(\d+)\)?/.exec(l);
      push(/WARNING/.test(m[1]) ? 'warning' : 'error', m[2], at?.[1], at ? Number(at[2]) : undefined, i);
      continue;
    }
    if ((m = /^\s*(?:\[[^\]]*\])*\s*Log\w+:\s*(Error|Warning):\s*(.*)$/.exec(l))) { const f = /([A-Za-z]:[\\/][^:\s]+\.\w+|\/Game\/[^\s:]+)(?::(\d+))?/.exec(m[2]); push(m[1] === 'Warning' ? 'warning' : 'error', m[2], f?.[1], f?.[2] ? Number(f[2]) : undefined, i); continue; }
    if ((m = /^\s*File "([^"]+)", line (\d+)/.exec(l))) { const msg = lines.slice(i + 1, i + 4).find((x) => /^\w*(Error|Exception)\b/.test(x.trim())) ?? 'Python error'; push('error', msg, m[1], Number(m[2]), i); continue; }
    if (/\b(BUILD FAILED|Build failed|error: )/.test(l) && !/0 error/.test(l)) push('error', l, undefined, undefined, i);
  }
  return out;
}

// ---------------- engines ----------------

const ENGINE_INFO = {
  web: { title: 'Web (Three.js, Canvas)', plugin: 'games3d', uses: 'Browser games in 2D (Canvas) or 3D (Three.js, vendored), played and checked in a headless browser. Nothing to install.' },
  blender: { title: 'Blender', plugin: 'engine-blender', uses: 'Modeling, materials, rigging, animation and rendering (Cycles, EEVEE), glTF and FBX export: the hub assets go through.' },
  godot: { title: 'Godot 4', plugin: 'engine-godot', uses: '2D, 2.5D and 3D games: headless checks, runs, screenshots, exports for Linux, Windows and the web.' },
  unreal: { title: 'Unreal Engine', plugin: 'engine-unreal', uses: 'High-end 3D: levels, Blueprints and editor Python, Movie Render Queue, BuildCookRun packaging for Win64.' },
  unity: { title: 'Unity', plugin: 'engine-unity', uses: '2D and 3D games in C#: batch mode, the Test Framework, BuildPipeline.' },
};

const defaultRun = (bin, args, timeoutMs) => new Promise((resolve) => {
  execFile(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? null : String(stdout)));
});
const newestDir = (names) => [...names].sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));

/**
 * What each engine has on this machine, from files alone (no engine is started): the program,
 * its version, and the gaps that limit what it can do here (Unreal without the MSVC toolchain:
 * Blueprints and Python only). The engine plugins' own detect action is the full report.
 */
export async function probeEngines(o = {}) {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const exists = o.exists ?? fs.existsSync;
  const listDir = o.listDir ?? ((d) => { try { return fs.readdirSync(d); } catch { return []; } });
  const readText = o.readText ?? ((f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } });
  const run = o.run ?? defaultRun;
  const home = o.home ?? harnessPaths({ env }).layout.home;
  const win = platform === 'win32';
  const P = win ? path.win32 : path.posix;
  const engines = path.join(home, 'engines');
  const out = {};

  // Blender
  const blender = findBinary('blender', { platform, env, exists, listDir });
  out.blender = { installed: !!blender, path: blender ?? undefined, version: /blender[ _-]?v?(\d+\.\d+(?:\.\d+)?)/i.exec(blender ?? '')?.[1], gaps: [] };
  if (blender && !out.blender.version) out.blender.notes = ['version: run the blender tool with detect for it'];

  // Godot (also a copy fetched into ~/.harness/engines by the engine's install action)
  let godot = findBinary('godot', { platform, env, exists, listDir });
  if (!godot) {
    const hit = newestDir(listDir(engines).filter((d) => /^godot/i.test(d))).flatMap((d) => [P.join(engines, d), ...newestDir(listDir(P.join(engines, d)).filter((f) => /^godot_v4[\w.-]*(\.exe)?$/i.test(f) && !/\.(zip|tpz)$/i.test(f))).map((f) => P.join(engines, d, f))]).find((p) => /godot_v4[^\\/]*$/i.test(p) && exists(p));
    if (hit) godot = hit;
  }
  if (!godot) {
    // What the engine's install action writes: engines/godot/<version>/engine.json names its program per platform.
    const key = `${platform}-${o.arch ?? process.arch}`;
    for (const v of newestDir(listDir(P.join(engines, 'godot')))) {
      let meta = null;
      try { meta = JSON.parse(readText(P.join(engines, 'godot', v, 'engine.json')) ?? 'null'); } catch { /* not ours */ }
      const rel = meta?.binaries?.[key];
      if (typeof rel === 'string' && exists(P.join(engines, 'godot', v, rel))) { godot = P.join(engines, 'godot', v, rel); break; }
    }
  }
  out.godot = { installed: !!godot, path: godot ?? undefined, version: /godot[_ -]?v?(\d+\.\d+(?:\.\d+)?)/i.exec(godot ?? '')?.[1], gaps: [], source: godot && godot.startsWith(engines) ? 'harness' : godot ? 'host' : undefined };
  if (godot) {
    const v = out.godot.version;
    const tpl = win ? P.join(env.APPDATA ?? '', 'Godot', 'export_templates') : platform === 'darwin' ? P.join(os.homedir(), 'Library', 'Application Support', 'Godot', 'export_templates') : P.join(os.homedir(), '.local', 'share', 'godot', 'export_templates');
    const have = listDir(tpl);
    if (!have.length || (v && !have.some((d) => d.startsWith(v)))) out.godot.gaps.push('no export templates: check, run and screenshot work; exporting a build needs the templates (Editor > Manage Export Templates)');
  }

  // Unreal Engine: HARNESS_UNREAL, else the usual install folders (Epic Games Launcher, a source build).
  const ueRoots = [];
  if (env.HARNESS_UNREAL) ueRoots.push(env.HARNESS_UNREAL);
  if (win) {
    for (const base of ['D:\\UnrealEngine', 'C:\\UnrealEngine', P.join(env.ProgramFiles ?? 'C:\\Program Files', 'Epic Games'), 'D:\\Program Files\\Epic Games', 'D:\\Epic Games']) {
      for (const d of newestDir(listDir(base).filter((x) => /^UE_\d/i.test(x)))) ueRoots.push(P.join(base, d));
    }
  } else if (platform === 'darwin') {
    for (const d of newestDir(listDir('/Users/Shared/Epic Games').filter((x) => /^UE_\d/i.test(x)))) ueRoots.push(P.join('/Users/Shared/Epic Games', d));
  } else {
    for (const base of [P.join(os.homedir(), 'UnrealEngine'), '/opt/UnrealEngine', '/opt/unreal']) ueRoots.push(base);
  }
  const editorOf = (r) => (win ? ['Engine/Binaries/Win64/UnrealEditor-Cmd.exe', 'Engine/Binaries/Win64/UnrealEditor.exe'] : platform === 'darwin' ? ['Engine/Binaries/Mac/UnrealEditor.app/Contents/MacOS/UnrealEditor'] : ['Engine/Binaries/Linux/UnrealEditor']).map((x) => P.join(r, ...x.split('/'))).find((x) => exists(x));
  const ueRoot = ueRoots.find((r) => editorOf(r));
  out.unreal = { installed: !!ueRoot, path: ueRoot ? editorOf(ueRoot) : undefined, root: ueRoot, gaps: [] };
  if (ueRoot) {
    try { const b = JSON.parse(readText(P.join(ueRoot, 'Engine', 'Build', 'Build.version')) ?? 'null'); if (b?.MajorVersion) out.unreal.version = `${b.MajorVersion}.${b.MinorVersion ?? 0}${b.PatchVersion ? `.${b.PatchVersion}` : ''}`; } catch { /* no version file */ }
    out.unreal.version ??= /UE_(\d+\.\d+)/i.exec(ueRoot)?.[1];
    const has = (...rel) => rel.some((r) => exists(P.join(ueRoot, ...r.split('/'))));
    out.unreal.features = { python: has('Engine/Plugins/Experimental/PythonScriptPlugin', 'Engine/Plugins/Scripting/PythonScriptPlugin'), remoteControl: has('Engine/Plugins/VirtualProduction/RemoteControl', 'Engine/Plugins/Experimental/RemoteControl') };
    if (!out.unreal.features.python) out.unreal.gaps.push('no PythonScriptPlugin: editor scripting is not available');
    if (win) {
      const vswhere = P.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
      const msvc = exists(vswhere) ? await run(vswhere, ['-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath', '-format', 'value'], 8000) : null;
      out.unreal.features.msvc = !!msvc?.trim();
      if (!out.unreal.features.msvc) out.unreal.gaps.push('no MSVC: C++ cannot compile (Visual Studio 2022 with "Game development with C++" is needed); Blueprints and Python only');
    }
  }

  // Unity: HARNESS_UNITY, else Unity Hub's editors.
  const hub = win ? [P.join(env.ProgramFiles ?? 'C:\\Program Files', 'Unity', 'Hub', 'Editor')] : platform === 'darwin' ? ['/Applications/Unity/Hub/Editor'] : [P.join(os.homedir(), 'Unity', 'Hub', 'Editor')];
  const unityExe = (d) => (win ? P.join(d, 'Editor', 'Unity.exe') : platform === 'darwin' ? P.join(d, 'Unity.app', 'Contents', 'MacOS', 'Unity') : P.join(d, 'Editor', 'Unity'));
  let unity = env.HARNESS_UNITY && exists(env.HARNESS_UNITY) ? env.HARNESS_UNITY : undefined;
  let unityVersion;
  for (const h of hub) for (const d of newestDir(listDir(h))) if (!unity && exists(unityExe(P.join(h, d)))) { unity = unityExe(P.join(h, d)); unityVersion = d; }
  out.unity = { installed: !!unity, path: unity, version: unityVersion ?? /(\d{4}\.\d+\.\d+\w*)/.exec(unity ?? '')?.[1], gaps: unity ? ['a Unity license is activated by you in Unity Hub (the agent never accepts it)'] : [] };

  // Web: always there (Three.js is vendored); games are played in a headless Chromium when one is installed.
  let chromium;
  try { chromium = (await import('@harness/plugins/visual/lib/browser.mjs')).chromiumPath(); } catch { chromium = undefined; }
  out.web = { installed: true, version: 'Three.js and Canvas', path: chromium, gaps: chromium ? [] : ['no headless Chromium: games build, but cannot be played and checked headless (npx playwright install chromium)'] };

  return ENGINES.map((e) => ({ engine: e, ...ENGINE_INFO[e], source: 'host', ...out[e] }));
}

// ---------------- the routes ----------------

const may = (user) => !!user && (user.role === 'admin' || !user.id);

export function setupUiRoutes(api) {
  let engineCache = null;
  const projectCache = { at: 0, key: '', list: [] };
  const roots = () => studioRoots();

  async function projects(force = false) {
    const r = roots();
    const key = r.workspaces.join('|');
    if (!force && projectCache.key === key && Date.now() - projectCache.at < 4000) return projectCache.list;
    const dirs = await findProjectDirs(r.workspaces);
    const list = [];
    for (const dir of dirs) {
      // Assets with no project.json yet: listed under the folder's name, so what was made shows up.
      const file = await readJsonFile(path.join(dir, '.studio', 'project.json')).catch(() => undefined)
        ?? { value: {}, mtime: (await fsp.stat(path.join(dir, '.studio', 'assets')).catch(() => null))?.mtimeMs ?? 0 };
      const root = r.workspaces.find((w) => within(w, dir)) ?? path.dirname(dir);
      const p = normProject(file.value, dir, root, file.mtime);
      if (file.error) p.error = file.error;
      p.counts = { assets: await countDirs(path.join(dir, '.studio', 'assets'), 'asset.json'), playtests: await countDirs(path.join(dir, '.studio', 'playtests'), 'report.json'), builds: p.builds.length };
      list.push(p);
    }
    list.sort((a, b) => b.updated - a.updated);
    Object.assign(projectCache, { at: Date.now(), key, list });
    return list;
  }

  /** A project by its id, or by its folder (an absolute path, as an agent knows it). */
  async function project(id) {
    if (typeof id === 'string' && path.isAbsolute(id)) {
      const real = await allowedAbsolute(id, roots());
      id = pidOf(isProjectDir(real) ? real : path.dirname(real));
    }
    if (typeof id !== 'string' || !PID.test(id)) throw bad('project is a project id (from studio/projects) or the project\'s folder');
    let p = (await projects()).find((x) => x.id === id);
    if (!p) p = (await projects(true)).find((x) => x.id === id);
    if (!p) throw notFound('no such project in the folders Studio reads');
    return p;
  }

  const pidArg = async (v) => (typeof v === 'string' && v ? (await project(v)).id : undefined);

  /** The folder a request's file is in: an asset's, a project's, a session's, the library or a named root. */
  async function baseOf(a) {
    const r = roots();
    if (a.asset !== undefined) {
      const ref = parseAssetRef(a.asset, a.project);
      if (ref.library) { if (!r.library) throw notFound('there is no asset library yet'); return insideBase(r.library, ref.id); }
      const p = await project(ref.project);
      return insideBase(path.join(p.dir, '.studio', 'assets'), ref.id);
    }
    if (a.project !== undefined) return (await project(a.project)).dir;
    if (a.library === true) { if (!r.library) throw notFound('there is no asset library yet'); return r.library; }
    if (a.session !== undefined && a.root === undefined) {
      if (typeof a.session !== 'string' || !SID.test(a.session)) throw bad('session is a conversation id');
      return allowedAbsolute(path.join(r.dataWorkspaces, a.session), r);
    }
    if (a.root !== undefined) return allowedAbsolute(a.root, r);
    return undefined;
  }

  async function fileOf(a) {
    const base = await baseOf(a);
    if (base) {
      // An asset's file may be relative to the project instead (FORMATS: project-relative paths).
      try { return await insideBase(base, a.path); } catch (e) {
        if (e.status === 404 && a.asset !== undefined && a.project !== undefined && !parseAssetRef(a.asset, a.project).library) return insideBase((await project(parseAssetRef(a.asset, a.project).project)).dir, a.path);
        throw e;
      }
    }
    if (typeof a.path === 'string' && path.isAbsolute(a.path)) return allowedAbsolute(a.path, roots());
    throw bad('name the file: project and path, asset and path, root and path, or an absolute path');
  }

  async function allAssets(filter = {}) {
    const r = roots();
    const list = [];
    for (const p of await projects()) {
      if (filter.project && p.id !== filter.project) continue;
      list.push(...await readAssetsIn(path.join(p.dir, '.studio', 'assets'), { project: p.id, projectName: p.name, projectDir: p.dir, ref: undefined }));
    }
    if (r.library && (!filter.project || filter.project === 'library')) list.push(...await readAssetsIn(r.library, { project: null, projectName: 'Library', library: true }));
    for (const a of list) { a.ref = a.library ? `library:${a.folderName}` : `${a.project}:${a.folderName}`; delete a.projectDir; }
    return list;
  }

  async function playtestsOf(p) {
    const dir = path.join(p.dir, '.studio', 'playtests');
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const e of entries.slice(0, 1000)) {
      if (!e.isDirectory() || e.isSymbolicLink() || !ID.test(e.name)) continue;
      const r = await readJsonFile(path.join(dir, e.name, 'report.json')).catch(() => undefined);
      if (!r) continue;
      out.push(normPlaytest(r.value, e.name, p, r.mtime, r.error));
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  const read = (p, handler) => {
    for (const method of ['GET', 'POST']) {
      api.registerRoute({
        method, path: `studio/${p}`, auth: 'user',
        handler: async (req) => {
          if (!may(req.user)) return { status: 403, body: { error: 'Studio reads the projects and workspaces in this server\'s folders, which only an administrator sees.' } };
          let args = { ...req.query };
          if (method === 'POST' && req.body?.length) { try { args = { ...args, ...obj(JSON.parse(req.body.toString('utf8'))) }; } catch { return { status: 400, body: { error: 'the body is not JSON' } }; } }
          try { return { status: 200, body: await handler(args, req) }; } catch (e) {
            if (e instanceof StudioError) return { status: e.status, body: { error: e.message } };
            api.log(`studio ${p}: ${e?.stack ?? e}`);
            return { status: 500, body: { error: `Studio could not read that: ${e?.message ?? e}` } };
          }
        },
      });
    }
  };
  const write = (p, handler) => api.registerRoute({
    method: 'POST', path: `studio/${p}`, auth: 'user',
    handler: async (req) => {
      if (!may(req.user)) return { status: 403, body: { error: 'Studio changes projects in this server\'s folders, which only an administrator may do.' } };
      let args = {};
      try { args = obj(JSON.parse(req.body?.toString('utf8') || '{}')); } catch { return { status: 400, body: { error: 'the body is not JSON' } }; }
      try { return { status: 200, body: await handler(args, req) }; } catch (e) {
        if (e instanceof StudioError) return { status: e.status, body: { error: e.message } };
        api.log(`studio ${p}: ${e?.stack ?? e}`);
        return { status: 500, body: { error: e?.message ?? String(e) } };
      }
    },
  });

  const jobsView = () => listJobs().map((j) => ({ ...j, title: clip(j.title, 200), took: j.startedAt ? (j.endedAt ?? Date.now()) - j.startedAt : undefined })).sort((a, b) => (b.startedAt ?? b.queuedAt) - (a.startedAt ?? a.queuedAt));
  const busy = () => listJobs().filter((j) => j.status === 'running' || j.status === 'waiting').length;
  const engines = async (force) => {
    if (!force && engineCache && Date.now() - engineCache.at < 60_000) return engineCache.list;
    engineCache = { at: Date.now(), list: await probeEngines() };
    return engineCache.list;
  };

  read('summary', async () => {
    const list = await projects();
    const assets = await allAssets();
    let playtests = [];
    for (const p of list.slice(0, 20)) playtests.push(...await playtestsOf(p));
    playtests = playtests.sort((a, b) => b.mtime - a.mtime);
    return {
      projects: list.slice(0, 8).map(projectCard), counts: { projects: list.length, assets: assets.length, playtests: playtests.length, builds: list.reduce((n, p) => n + p.builds.length, 0), jobs: busy() },
      jobs: jobsView().slice(0, 8), engines: await engines(false), playtests: playtests.slice(0, 5), assets: assets.sort((a, b) => b.mtime - a.mtime).slice(0, 8).map(assetCard),
      roots: roots().workspaces.length,
    };
  });

  read('projects', async () => ({ projects: (await projects(true)).map(projectCard), roots: roots().workspaces }));

  read('project', async (a) => {
    const p = await project(a.project);
    let design;
    const designPath = p.design || ['design/GDD.md', 'docs/game-design.md', 'GDD.md'].find((x) => fs.existsSync(path.join(p.dir, ...x.split('/'))));
    if (designPath) {
      try {
        const f = await insideBase(p.dir, designPath);
        const st = await fsp.stat(f);
        design = { path: designPath, text: st.size > 400_000 ? `${(await fsp.readFile(f, 'utf8')).slice(0, 400_000)}\n\n…` : await fsp.readFile(f, 'utf8') };
      } catch (e) { design = { path: designPath, error: e.message }; }
    }
    const playtests = await playtestsOf(p);
    const assets = (await allAssets({ project: p.id })).map(assetCard);
    return { project: { ...p, counts: { ...p.counts, assets: assets.length, playtests: playtests.length } }, design, playtests, assets };
  });

  // A stage's approval, a request for changes, a comment, reopening: project/stage with an action,
  // or one route per action (what the agent-callable commands call, their args the body).
  const stageChange = (fixed) => async (a, req) => {
    const p = await project(a.project);
    const stage = typeof a.stage === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/.test(a.stage) ? a.stage : undefined;
    if (!stage) throw bad('stage is the id of one of the project\'s stages');
    const action = fixed ?? String(a.action ?? 'approve');
    if (!['approve', 'request-changes', 'comment', 'reopen'].includes(action)) throw bad('action is approve, request-changes, comment or reopen');
    const text = typeof a.comment === 'string' ? a.comment.trim().slice(0, 2000) : '';
    if ((action === 'comment' || action === 'request-changes') && !text) throw bad(`${action} needs a comment`);
    const file = path.join(p.dir, '.studio', 'project.json');
    const cur = await readJsonFile(file);
    if (!cur || cur.error) throw bad(`.studio/project.json cannot be read${cur?.error ? `: ${cur.error}` : ''}`);
    const json = obj(cur.value);
    json.stages = Array.isArray(json.stages) ? json.stages : [];
    let s = json.stages.find((x) => x && x.id === stage);
    if (!s) { if (action === 'comment') { s = { id: stage, status: 'pending' }; json.stages.push(s); } else throw notFound(`the project has no stage "${stage}"`); }
    const by = clip(req.user?.name || 'you', 80);
    const at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    if (action === 'approve') { s.status = 'approved'; s.approvedAt = at; s.approvedBy = by; }
    if (action === 'request-changes') { s.status = 'changes-requested'; delete s.approvedAt; delete s.approvedBy; }
    if (action === 'reopen') { s.status = 'active'; delete s.approvedAt; delete s.approvedBy; }
    if (text) { s.comments = Array.isArray(s.comments) ? s.comments : []; s.comments.push({ by, at, text }); }
    await writeFileAtomic(file, `${JSON.stringify(json, null, 2)}\n`);
    projectCache.at = 0;
    api.signal('projects');
    const verb = { approve: 'Approved', 'request-changes': 'Asked for changes to', comment: 'Commented on', reopen: 'Reopened' }[action];
    return { ok: true, text: `${verb} the ${stage} stage of ${p.name}.`, stage: normProject(json, p.dir, p.root, Date.now()).stages.find((x) => x.id === stage) };
  };
  write('project/stage', stageChange());
  for (const action of ['approve', 'request-changes', 'comment', 'reopen']) write(`project/${action}`, stageChange(action));

  read('assets', async (a) => {
    const want = a.project === 'library' ? 'library' : typeof a.project === 'string' && a.project ? (await project(a.project)).id : undefined;
    let list = await allAssets({ project: want });
    const facets = {};
    for (const k of ['kind', 'dimension', 'style', 'license', 'source']) {
      const counts = new Map();
      for (const x of list) { const v = k === 'license' ? x.license.id : k === 'source' ? x.source.type : x[k]; if (v) counts.set(v, (counts.get(v) ?? 0) + 1); }
      facets[k] = [...counts.entries()].sort((x, y) => y[1] - x[1]).map(([value, count]) => ({ value, count }));
    }
    const all = list.length;
    const eq = (v, want) => !want || String(v ?? '').toLowerCase() === String(want).toLowerCase();
    const q = typeof a.q === 'string' ? a.q.trim().toLowerCase() : '';
    list = list.filter((x) => eq(x.kind, a.kind) && eq(x.dimension, a.dimension) && eq(x.style, a.style) && eq(x.license.id, a.license) && eq(x.source.type, a.source)
      && (!q || [x.name, x.id, x.style, ...x.tags, x.projectName].join(' ').toLowerCase().includes(q)));
    return { assets: list.sort((x, y) => y.mtime - x.mtime).slice(0, 500).map(assetCard), facets, total: list.length, all };
  });

  read('asset', async (a) => {
    const ref = parseAssetRef(a.asset ?? a.id, a.project);
    const pid = ref.library ? 'library' : (await project(ref.project)).id;
    const list = await allAssets({ project: pid });
    const x = list.find((y) => (ref.library ? y.library : y.project === pid) && (y.folderName === ref.id || y.id === ref.id));
    if (!x) throw notFound(`no asset ${ref.id}${ref.library ? ' in the library' : ' in that project'}`);
    return { asset: { ...assetCard(x), dir: x.folder } };
  });

  read('file', async (a) => {
    const file = await fileOf(a);
    const st = await fsp.stat(file);
    if (!st.isFile()) throw bad('that is a folder, not a file');
    const wantText = a.text === true || a.text === 'true' || a.text === '1';
    if (wantText) {
      if (st.size > MAX_TEXT) throw bad(`${path.basename(file)} is over 2 MB: too big to show as text`);
      return { name: path.basename(file), size: st.size, mtime: st.mtimeMs, mime: mimeOf(file), text: await fsp.readFile(file, 'utf8') };
    }
    if (st.size > MAX_FILE) throw bad(`${path.basename(file)} is ${Math.round(st.size / 1048576)} MB: over the 48 MB Studio shows`);
    return { name: path.basename(file), size: st.size, mtime: st.mtimeMs, mime: mimeOf(file), base64: (await fsp.readFile(file)).toString('base64') };
  });

  read('scenes', async (a) => {
    const want = await pidArg(a.project);
    const out = [];
    for (const p of await projects()) {
      if (want && p.id !== want) continue;
      const files = await walkFiles(p.dir, (rel) => SCENE.test(rel) || (MODEL.test(rel) && /(^|\/)(scenes?|levels?|maps?)\//i.test(rel)) || (/\.json$/i.test(rel) && /(^|\/)levels?\//i.test(rel)), { depth: 6, max: 300 });
      for (const f of files) out.push({ project: p.id, projectName: p.name, engine: p.engine, ...f, kind: sceneKind(f.path) });
    }
    return { scenes: out.sort((x, y) => y.mtime - x.mtime).slice(0, 500) };
  });

  read('scene', async (a) => {
    const p = await project(a.project);
    const file = await insideBase(p.dir, a.path);
    if (!/\.t?scn$/i.test(file) && !/\.tscn$/i.test(file)) throw bad('only Godot text scenes (.tscn) have an outline here; open models in the 3D viewer and levels in the 2D viewer');
    const st = await fsp.stat(file);
    if (st.size > MAX_TEXT) throw bad('the scene is over 2 MB');
    return { path: cleanRel(a.path), nodes: tscnNodes(await fsp.readFile(file, 'utf8')) };
  });

  read('renders', async (a) => {
    const want = await pidArg(a.project);
    const out = [];
    for (const p of await projects()) {
      if (want && p.id !== want) continue;
      const files = await walkFiles(p.dir, (rel) => IMAGE.test(rel) && /(^|\/)(renders?|previews?|captures?|screenshots?|shots|turntables?|MovieRenders)\//i.test(rel), { depth: 7, max: 400, dots: ['.studio'] });
      for (const f of files) out.push({ project: p.id, projectName: p.name, ...f, group: path.posix.dirname(f.path) });
    }
    return { renders: out.sort((x, y) => y.mtime - x.mtime).slice(0, 300) };
  });

  read('builds', async (a) => {
    const want = await pidArg(a.project);
    const out = [];
    for (const p of await projects()) {
      if (want && p.id !== want) continue;
      for (const b of p.builds) out.push({ ...b, project: p.id, projectName: p.name, engine: b.engine || p.engine, problems: undefined, errors: b.problems.filter((x) => x.severity === 'error').length, warnings: b.problems.filter((x) => x.severity === 'warning').length });
    }
    return { builds: out.sort((x, y) => String(y.at ?? '').localeCompare(String(x.at ?? ''))) };
  });

  read('build', async (a) => {
    const p = await project(a.project);
    const b = p.builds.find((x) => x.id === a.id);
    if (!b) throw notFound(`the project has no build ${clip(String(a.id ?? ''), 60)}`);
    const candidates = [b.log, `.studio/builds/${b.id}/build.log`, b.path ? `${path.posix.dirname(b.path)}/build.log` : undefined].filter(Boolean);
    let log; let logPath;
    for (const c of candidates) {
      try {
        const f = await insideBase(p.dir, c);
        const st = await fsp.stat(f);
        const fd = await fsp.open(f, 'r');
        try {
          const n = Math.min(st.size, 600_000);
          const buf = Buffer.alloc(n);
          await fd.read(buf, 0, n, st.size - n);
          log = `${st.size > n ? '…\n' : ''}${buf.toString('utf8')}`;
        } finally { await fd.close(); }
        logPath = cleanRel(c);
        break;
      } catch { /* next */ }
    }
    let artifact;
    if (b.path) { try { const st = await fsp.stat(await insideBase(p.dir, b.path)); artifact = { path: b.path, size: st.size, exists: true }; } catch { artifact = { path: b.path, exists: false }; } }
    const parsed = log ? parseProblems(log) : [];
    const problems = [...b.problems, ...parsed.filter((x) => !b.problems.some((y) => y.message === x.message && y.line === x.line))];
    return { build: { ...b, engine: b.engine || p.engine }, project: projectCard(p), log, logPath, artifact, problems: problems.map((x) => ({ ...x, ...(x.file ? { link: linkFor(p, x.file) } : {}) })) };
  });

  read('source', async (a) => {
    const p = await project(a.project);
    const rel = resPath(p, a.path);
    const file = await insideBase(p.dir, rel);
    const st = await fsp.stat(file);
    if (st.size > MAX_TEXT) throw bad('the file is over 2 MB');
    const lines = (await fsp.readFile(file, 'utf8')).replace(/\r/g, '').split('\n');
    const line = Math.max(1, Math.min(lines.length, Number(a.line) || 1));
    const from = Math.max(1, line - 12);
    return { path: rel, line, from, lines: lines.slice(from - 1, from + 24).map((t) => clip(t, 400)), total: lines.length };
  });

  read('playtests', async (a) => {
    const want = await pidArg(a.project);
    const out = [];
    for (const p of await projects()) { if (want && p.id !== want) continue; out.push(...await playtestsOf(p)); }
    return { playtests: out.sort((x, y) => y.mtime - x.mtime).slice(0, 300).map(({ events, verdicts, issues, frames, ...rest }) => ({ ...rest, issues: issues.length, majorIssues: issues.filter((i) => /blocking|critical|major/i.test(i.severity)).length, frames: frames.length })) };
  });

  read('playtest', async (a) => {
    const p = await project(a.project);
    if (typeof a.id !== 'string' || !ID.test(a.id)) throw bad('id is a playtest id');
    const dir = path.join(p.dir, '.studio', 'playtests', a.id);
    await insideBase(path.join(p.dir, '.studio', 'playtests'), a.id);
    const r = await readJsonFile(path.join(dir, 'report.json'));
    if (!r) throw notFound(`no playtest ${a.id} in ${p.name}`);
    const t = normPlaytest(r.value, a.id, p, r.mtime, r.error);
    // Every image of the folder (the report names some; a player may write more).
    const frames = new Set(t.frames);
    for (const f of await walkFiles(dir, (rel) => /\.(png|jpe?g|webp)$/i.test(rel), { depth: 3, max: 600 })) frames.add(`.studio/playtests/${a.id}/${f.path}`);
    if (t.recording) frames.delete(t.recording);
    return { playtest: { ...t, frames: [...frames].sort() }, project: projectCard(p) };
  });

  read('jobs', async () => ({ jobs: jobsView(), running: busy() }));
  write('jobs/cancel', async (a) => {
    const id = typeof a.id === 'string' && /^job-\d{1,12}$/.test(a.id) ? a.id : undefined;
    if (!id) throw bad('id is a job id (job-N, from studio/jobs)');
    const job = listJobs().find((j) => j.id === id);
    if (!job) throw notFound(`no job ${id} in the last hour`);
    const ok = cancelJob(id);
    api.signal('jobs');
    return { ok, text: ok ? `Cancelled ${id} (${clip(job.title, 80)}).` : `${id} already finished (${job.status}).` };
  });

  read('engines', async (a) => {
    const list = await engines(a.refresh === true || a.refresh === 'true' || a.refresh === '1');
    const text = list.map((e) => `${e.title}: ${e.installed ? `${e.version ? `${e.version} ` : ''}installed${e.gaps.length ? ` (${e.gaps[0].split(':')[0]})` : ''}` : 'not installed'}`).join('; ');
    return { engines: list, checkedAt: engineCache?.at, text: `Engines on this machine: ${text}.` };
  });
  read('badges', async () => { const n = busy(); return { jobs: n || null }; });

  // The Jobs badge follows the queue: a signal when the number of running and waiting jobs changes.
  let last = 0;
  const t = setInterval(() => { const n = busy(); if (n !== last) { last = n; api.signal('jobs'); } }, 3000);
  t.unref?.();
}

// ---------------- helpers of the routes ----------------

function parseAssetRef(asset, project) {
  const s = String(asset ?? '');
  const m = /^(library|[a-f0-9]{12}):(.+)$/.exec(s);
  const id = m ? m[2] : s;
  if (!ID.test(id)) throw bad('asset is an asset id (or project:id, library:id)');
  if (m?.[1] === 'library' || project === 'library') return { library: true, id };
  const pid = m ? m[1] : project;
  if (typeof pid !== 'string' || !(PID.test(pid) || path.isAbsolute(pid))) throw bad('an asset of a project needs the project (its id or folder) as well');
  return { project: pid, id };
}

const SCENE = /\.(tscn|scn|umap|unity|blend|tmj|tmx)$/i;
function sceneKind(rel) {
  if (/\.t?scn$/i.test(rel)) return { kind: 'godot-scene', engine: 'godot', viewer: /\.tscn$/i.test(rel) ? 'outline' : null };
  if (/\.umap$/i.test(rel)) return { kind: 'unreal-level', engine: 'unreal', viewer: null };
  if (/\.unity$/i.test(rel)) return { kind: 'unity-scene', engine: 'unity', viewer: null };
  if (/\.blend$/i.test(rel)) return { kind: 'blender-file', engine: 'blender', viewer: null };
  if (MODEL.test(rel)) return { kind: 'gltf-scene', engine: 'web', viewer: '3d' };
  if (/\.tmx$/i.test(rel)) return { kind: 'tiled-map', engine: 'web', viewer: null };
  return { kind: 'level', engine: 'web', viewer: 'level' };
}

/** The node tree of a Godot text scene: [node name="..." type="..." parent="..."]. */
export function tscnNodes(text) {
  const out = [];
  for (const m of String(text).matchAll(/^\[node\s+([^\]]*)\]/gm)) {
    const attr = (k) => new RegExp(`\\b${k}="([^"]*)"`).exec(m[1])?.[1];
    const name = attr('name');
    if (!name) continue;
    const parent = attr('parent');
    out.push({ name: clip(name, 120), type: clip(attr('type') ?? (/instance=/.test(m[1]) ? 'instance' : 'Node'), 80), path: parent === undefined ? '.' : parent === '.' ? name : `${parent}/${name}` });
    if (out.length >= 2000) break;
  }
  return out;
}

async function walkFiles(dir, match, { depth = 5, max = 300, dots = [] } = {}) {
  const out = [];
  const walk = async (rel, d) => {
    if (out.length >= max) return;
    let entries = [];
    try { entries = await fsp.readdir(rel ? path.join(dir, ...rel.split('/')) : dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= max) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (d < depth && (!e.name.startsWith('.') || dots.includes(e.name) || (rel.startsWith('.studio') && !['.git'].includes(e.name))) && !SKIP.has(e.name)) await walk(r, d + 1); }
      else if (e.isFile() && match(r)) { const st = await fsp.stat(path.join(dir, ...r.split('/'))).catch(() => null); if (st) out.push({ path: r, size: st.size, mtime: st.mtimeMs }); }
    }
  };
  await walk('', 0);
  return out;
}

/** A path a log names, as a path in the project (res:// is the Godot project's folder; an absolute path inside the project too). */
function resPath(p, file) {
  let f = String(file ?? '').replace(/\\/g, '/');
  if (f.startsWith('res://')) {
    const godotDir = p.engineProject && /project\.godot$/.test(p.engineProject) ? path.posix.dirname(p.engineProject) : '';
    f = `${godotDir && godotDir !== '.' ? `${godotDir}/` : ''}${f.slice(6)}`;
  } else if (path.isAbsolute(f) || /^[a-z]:\//i.test(f)) {
    const rel = path.relative(p.dir, path.resolve(f));
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new StudioError(403, 'that file is outside the project');
    f = toPosix(rel);
  }
  return cleanRel(f);
}

function linkFor(p, file) { try { return resPath(p, file); } catch { return undefined; } }

function normPlaytest(v, id, p, mtime, error) {
  const r = obj(v);
  const rel = (f) => (typeof f === 'string' ? (() => { try { return `.studio/playtests/${id}/${cleanRel(f)}`; } catch { return undefined; } })() : undefined);
  const metrics = Object.fromEntries(Object.entries(obj(r.metrics)).filter(([, x]) => typeof x === 'number').slice(0, 40));
  return {
    id: str(r.id, 100) || id, folder: id, project: p.id, projectName: p.name, engine: str(r.engine, 20) || p.engine, build: str(r.build, 80), player: str(r.player, 40) || '',
    goal: str(r.goal, 400) || '', result: str(r.result, 20) || 'unknown', durationS: num(r.durationS), steps: num(r.steps), mtime, at: str(r.at ?? r.endedAt ?? r.startedAt, 40),
    ...(error ? { error } : {}),
    events: arr(r.events).slice(0, 2000).map((e) => ({ t: num(e?.t) ?? 0, type: str(e?.type, 40) || 'event', detail: str(e?.detail, 400) || '', frame: rel(e?.frame) })),
    metrics, series: Object.fromEntries(Object.entries(obj(r.series ?? r.timeline)).filter(([, x]) => Array.isArray(x)).slice(0, 8).map(([k, x]) => [clip(k, 40), x.slice(0, 2000).map((pt) => (Array.isArray(pt) ? [Number(pt[0]) || 0, Number(pt[1]) || 0] : [Number(pt?.t) || 0, Number(pt?.v ?? pt?.value) || 0]))])),
    frames: arr(r.frames).map(rel).filter(Boolean).slice(0, 2000), recording: rel(r.recording),
    issues: arr(r.issues).slice(0, 200).map((x) => ({ severity: str(x?.severity, 20) || 'minor', title: str(x?.title, 300) || '', detail: str(x?.detail, 2000), evidence: rel(x?.evidence), t: num(x?.t) })),
    verdicts: arr(r.verdicts).slice(0, 200).map((x) => ({ by: str(x?.by, 40) || '', claim: str(x?.claim, 400) || '', pass: x?.pass === true, evidence: rel(x?.evidence), reason: str(x?.reason, 1000) })),
  };
}

function projectCard(p) {
  const done = p.stages.filter((s) => s.status === 'done' || s.status === 'approved').length;
  const current = p.stages.find((s) => !['done', 'approved', 'skipped'].includes(s.status));
  const lastBuild = p.builds.at(-1);
  return {
    id: p.id, name: p.name, engine: p.engine, dimension: p.dimension, genre: p.genre, dir: p.dir, rel: p.rel, folder: p.folder, updated: p.updated, created: p.created,
    stages: p.stages, stagesDone: done, stage: current?.id, waiting: p.stages.filter((s) => s.status === 'review').map((s) => s.id),
    builds: p.builds, lastBuild, playtests: p.playtests, counts: p.counts, budgets: p.budgets, design: p.design, engineProject: p.engineProject, ...(p.error ? { error: p.error } : {}),
  };
}

function assetCard(a) {
  return {
    ref: a.ref, id: a.id, folder: a.folderName, name: a.name, kind: a.kind, dimension: a.dimension, style: a.style, tags: a.tags, license: a.license, source: a.source,
    project: a.project, projectName: a.projectName, library: !!a.library, meta: a.meta, checks: a.checks, checksPassed: a.checksPassed, checksFailed: a.checksFailed,
    files: a.files, hashes: a.hashes, engines: a.engines, created: a.created, updated: a.updated, mtime: a.mtime, main: a.main, preview: a.preview, model: a.model, audio: a.audio, level: a.level, lods: a.lods, viewer: a.viewer,
    ...(a.error ? { error: a.error } : {}),
  };
}
