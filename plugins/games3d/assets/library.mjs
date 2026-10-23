// The asset library: asset folders in the project (.studio/assets/<id>/asset.json, see
// sdk/FORMATS.md) and the shared library in the harness home (~/.harness/assets/<id>/), with
// manifests (source, licence, hashes) written for every asset, search by kind, tags, style
// and text, and copies between the two that check every hash.

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { resolveHome } from '../../../src/util/home.ts';
import { listIn, readIn, relIn, writeIn } from '../lib-engines.mjs';

export const ASSET_KINDS = ['model', 'sprite', 'spritesheet', 'tileset', 'texture', 'material', 'audio', 'music', 'font', 'ui', 'level', 'heightmap', 'background', 'particles', 'icon', 'pack'];
export const SOURCE_TYPES = ['procedural', 'import', 'library', 'generated'];
export const PROCEDURAL_LICENSE = { id: 'CC0-1.0', author: 'Studio procedural generator', note: 'made by a procedural generator for this project: free to use, no attribution needed' };

export const sha256 = (data) => `sha256:${crypto.createHash('sha256').update(data).digest('hex')}`;
export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'asset';
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;

/** The shared library folder: <harness home>/assets (HARNESS_HOME, else ~/.harness). */
export const libraryRoot = () => path.join(resolveHome(), 'assets');

// ---------- the project ----------

/**
 * The project folder (holding .studio/project.json): the one given, else the workspace root
 * when it has one, else the first one found two levels down, else the workspace root.
 */
export async function projectOf(host, given) {
  if (given) return relIn(host, String(given));
  if (host.kind === 'companion') return '.';
  try { await fsp.access(path.join(host.root, '.studio', 'project.json')); return '.'; } catch { /* look deeper */ }
  for (const d of await fsp.readdir(host.root, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory() || d.name.startsWith('.') || d.name === 'node_modules') continue;
    try { await fsp.access(path.join(host.root, d.name, '.studio', 'project.json')); return d.name; } catch { /* next */ }
  }
  return '.';
}

const join = (...p) => path.posix.join(...p.filter((x) => x && x !== '.'));
export const assetsDir = (project) => join(project, '.studio', 'assets');

/** The project's settings (.studio/project.json), or {} when there is none. */
export async function projectJson(host, project, signal) {
  try { return JSON.parse((await readIn(host, join(project, '.studio', 'project.json'), signal)).toString('utf8')); } catch { return {}; }
}

/**
 * Writes an asset folder: its files and asset.json with hashes, source and licence. Files are
 * { path, role, data } (data a Buffer or string); an existing asset of that id is replaced
 * (its created time kept). Returns { dir, manifest }.
 */
export async function writeAsset(host, project, a, signal) {
  const id = a.id ?? slug(`${a.kind}-${a.name}`);
  if (!ID.test(id)) throw new Error(`asset id "${id}" must be lowercase letters, digits, . _ - (up to 80)`);
  if (!ASSET_KINDS.includes(a.kind)) throw new Error(`asset kind ${a.kind} is not one of ${ASSET_KINDS.join(', ')}`);
  const dir = join(assetsDir(project), id);
  let created = new Date().toISOString();
  try { created = JSON.parse((await readIn(host, `${dir}/asset.json`, signal)).toString('utf8')).created ?? created; } catch { /* new */ }
  const hashes = {};
  for (const f of a.files) {
    if (!f.path || f.path.includes('..') || path.posix.isAbsolute(f.path)) throw new Error(`bad file path in asset ${id}: ${f.path}`);
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data));
    await writeIn(host, `${dir}/${f.path}`, data, signal);
    hashes[f.path] = sha256(data);
  }
  const manifest = {
    id, name: a.name ?? id, kind: a.kind, dimension: a.dimension ?? (a.kind === 'model' || a.kind === 'material' ? '3d' : '2d'),
    files: a.files.map((f) => ({ path: f.path, role: f.role ?? 'main' })),
    source: a.source ?? { type: 'procedural' }, license: a.license ?? PROCEDURAL_LICENSE, hashes,
    tags: [...new Set((a.tags ?? []).map(String))], ...(a.style ? { style: a.style } : {}), meta: a.meta ?? {},
    ...(a.checks ? { checks: a.checks } : {}), ...(a.engines ? { engines: a.engines } : {}),
    created, updated: new Date().toISOString(),
  };
  await writeIn(host, `${dir}/asset.json`, `${JSON.stringify(manifest, null, 2)}\n`, signal);
  return { dir, manifest };
}

/** Problems with a manifest on its own (fields, kinds, licence, files listed and hashed). */
export function manifestProblems(m, folderId) {
  const p = [];
  if (!m || typeof m !== 'object') return ['asset.json is not a JSON object'];
  if (!m.id || !ID.test(m.id)) p.push(`id "${m.id}" is missing or not a valid id`);
  else if (folderId && m.id !== folderId) p.push(`id "${m.id}" does not match its folder "${folderId}"`);
  if (!m.name) p.push('no name');
  if (!ASSET_KINDS.includes(m.kind)) p.push(`kind "${m.kind}" is not one of ${ASSET_KINDS.join(', ')}`);
  if (!Array.isArray(m.files) || !m.files.length) p.push('no files listed');
  if (!m.license?.id) p.push('no license.id (every asset records its licence: CC0-1.0, CC-BY-4.0, LicenseRef-..., or "proprietary")');
  if (m.license?.id && /^CC-BY/i.test(m.license.id) && !m.license.author) p.push(`licence ${m.license.id} needs an author to credit`);
  if (!SOURCE_TYPES.includes(m.source?.type)) p.push(`source.type "${m.source?.type}" is not one of ${SOURCE_TYPES.join(', ')}`);
  if (m.source?.type === 'generated' && !m.source.provider) p.push('a generated asset names its provider (source.provider)');
  if (m.source?.type === 'library' && !m.source.provider) p.push('a library asset names where it came from (source.provider, url)');
  for (const f of m.files ?? []) if (!m.hashes?.[f.path]) p.push(`no hash for ${f.path}`);
  return p;
}

/** Every asset folder in a directory: [{ id, dir, manifest | null, error? }]. */
async function readAll(host, dir, signal, { local = false } = {}) {
  const names = local ? await fsp.readdir(dir).catch(() => []) : await listIn(host, dir, signal);
  const out = [];
  for (const id of names) {
    try {
      const raw = local ? await fsp.readFile(path.join(dir, id, 'asset.json')) : await readIn(host, `${dir}/${id}/asset.json`, signal);
      out.push({ id, dir: local ? path.join(dir, id) : `${dir}/${id}`, manifest: JSON.parse(raw.toString('utf8')) });
    } catch (e) { out.push({ id, dir: local ? path.join(dir, id) : `${dir}/${id}`, manifest: null, error: e.code === 'ENOENT' ? 'no asset.json' : e.message }); }
  }
  return out;
}

export const projectAssets = (host, project, signal) => readAll(host, assetsDir(project), signal);
export const libraryAssets = () => readAll(null, libraryRoot(), undefined, { local: true });

/** Recomputes an asset's hashes: the files missing and the ones that changed. */
export async function verifyAsset(read, m) {
  const missing = [], changed = [];
  for (const f of m.files ?? []) {
    let data;
    try { data = await read(f.path); } catch { missing.push(f.path); continue; }
    if (m.hashes?.[f.path] && m.hashes[f.path] !== sha256(data)) changed.push(f.path);
  }
  return { ok: !missing.length && !changed.length, missing, changed };
}

/** A score for a manifest against a query (0: not a match). */
function score(m, q) {
  if (q.kind && m.kind !== q.kind) return 0;
  if (q.dimension && m.dimension !== q.dimension) return 0;
  if (q.style && String(m.style ?? '').toLowerCase() !== String(q.style).toLowerCase()) return 0;
  if (q.license && String(m.license?.id ?? '').toLowerCase() !== String(q.license).toLowerCase()) return 0;
  const tags = (m.tags ?? []).map((t) => String(t).toLowerCase());
  const want = [].concat(q.tags ?? []).map((t) => String(t).toLowerCase());
  if (want.some((t) => !tags.includes(t))) return 0;
  let s = 1;
  if (q.text) {
    const hay = `${m.id} ${m.name} ${tags.join(' ')} ${m.style ?? ''} ${m.kind}`.toLowerCase();
    const words = String(q.text).toLowerCase().split(/\s+/).filter(Boolean);
    const hits = words.filter((w) => hay.includes(w)).length;
    if (!hits) return 0;
    s += hits * 2 + (String(m.name).toLowerCase().includes(String(q.text).toLowerCase()) ? 3 : 0);
  }
  return s;
}

/** Searches the project, the shared library or both: [{ where, id, name, kind, tags, style, license, files }]. */
export async function searchAssets(host, project, q = {}, signal) {
  const where = q.where ?? 'both';
  const lists = [];
  if (where !== 'library') lists.push(['project', await projectAssets(host, project, signal)]);
  if (where !== 'project') lists.push(['library', await libraryAssets()]);
  const out = [];
  for (const [w, list] of lists) for (const a of list) {
    if (!a.manifest) continue;
    const s = score(a.manifest, q);
    if (s) out.push({ s, where: w, id: a.manifest.id, name: a.manifest.name, kind: a.manifest.kind, tags: a.manifest.tags, style: a.manifest.style, license: a.manifest.license?.id, source: a.manifest.source?.type, files: a.manifest.files.map((f) => f.path) });
  }
  return out.sort((a, b) => b.s - a.s || a.id.localeCompare(b.id)).slice(0, q.limit ?? 50).map(({ s, ...r }) => r);
}

/** Copies a project asset into the shared library (its hashes checked first). */
export async function publishAsset(host, project, id, { overwrite = false } = {}, signal) {
  const dir = `${assetsDir(project)}/${id}`;
  const m = JSON.parse((await readIn(host, `${dir}/asset.json`, signal)).toString('utf8'));
  const v = await verifyAsset((p) => readIn(host, `${dir}/${p}`, signal), m);
  if (!v.ok) throw new Error(`asset ${id} does not match its manifest (missing: ${v.missing.join(', ') || 'none'}; changed: ${v.changed.join(', ') || 'none'}): run the asset-manifest gate`);
  const to = path.join(libraryRoot(), id);
  if (!overwrite && await fsp.access(path.join(to, 'asset.json')).then(() => true, () => false)) throw new Error(`the library already has ${id}: pass overwrite to replace it`);
  for (const f of m.files) { const out = path.join(to, ...f.path.split('/')); await fsp.mkdir(path.dirname(out), { recursive: true }); await fsp.writeFile(out, await readIn(host, `${dir}/${f.path}`, signal)); }
  await fsp.writeFile(path.join(to, 'asset.json'), `${JSON.stringify({ ...m, updated: new Date().toISOString() }, null, 2)}\n`);
  return { id, to, files: m.files.length };
}

/** Copies a library asset into the project (as `as`, default its id), checking every hash after the copy. */
export async function copyToProject(host, project, id, { overwrite = false, as } = {}, signal) {
  const from = path.join(libraryRoot(), id);
  const m = JSON.parse(await fsp.readFile(path.join(from, 'asset.json'), 'utf8').catch(() => { throw new Error(`the library has no asset ${id}`); }));
  const v = await verifyAsset((p) => fsp.readFile(path.join(from, ...p.split('/'))), m);
  if (!v.ok) throw new Error(`library asset ${id} does not match its manifest (missing: ${v.missing.join(', ') || 'none'}; changed: ${v.changed.join(', ') || 'none'})`);
  const newId = as ?? id;
  if (!ID.test(newId)) throw new Error(`asset id "${newId}" is not valid`);
  const dir = `${assetsDir(project)}/${newId}`;
  if (!overwrite) { try { await readIn(host, `${dir}/asset.json`, signal); throw Object.assign(new Error(`the project already has ${newId}: pass overwrite, or "as" for another id`), { exists: true }); } catch (e) { if (e.exists) throw e; } }
  for (const f of m.files) await writeIn(host, `${dir}/${f.path}`, await fsp.readFile(path.join(from, ...f.path.split('/'))), signal);
  await writeIn(host, `${dir}/asset.json`, `${JSON.stringify({ ...m, id: newId, updated: new Date().toISOString(), copiedFrom: { library: id } }, null, 2)}\n`, signal);
  const after = await verifyAsset((p) => readIn(host, `${dir}/${p}`, signal), m);
  if (!after.ok) throw new Error(`the copy of ${id} does not match (missing: ${after.missing.join(', ')}; changed: ${after.changed.join(', ')})`);
  return { id: newId, dir, files: m.files.length };
}

/** Registers files already in the workspace as an asset (copied into its folder), with a licence. */
export async function importFiles(host, project, { id, name, kind, files, license, source, tags, style, meta }, signal) {
  if (!license?.id) throw new Error('importing needs license: { id, author?, url? } (who made it and on what terms)');
  const list = [];
  for (const f of files) {
    const rel = await relIn(host, String(f.path ?? f));
    list.push({ path: f.as ?? path.posix.basename(rel), role: f.role ?? (list.length ? 'extra' : 'main'), data: await readIn(host, rel, signal) });
  }
  return writeAsset(host, project, { id: id ?? slug(name ?? path.posix.basename(list[0].path)), name: name ?? list[0].path, kind, files: list, license, source: source ?? { type: 'import', from: files.map((f) => String(f.path ?? f)) }, tags, style, meta }, signal);
}

/** Every asset folder under a project (for the gates), with a way to read its files. */
export async function assetsForGate(host, signal) {
  const roots = new Set([await projectOf(host)]);
  // Other projects one folder down (a workspace holding several games).
  if (host.kind !== 'companion') {
    for (const d of await fsp.readdir(host.root, { withFileTypes: true }).catch(() => [])) {
      if (d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules' && await fsp.access(path.join(host.root, d.name, '.studio', 'assets')).then(() => true, () => false)) roots.add(d.name);
    }
  }
  const out = [];
  for (const project of roots) for (const a of await projectAssets(host, project, signal)) out.push({ ...a, project, read: (p) => readIn(host, `${a.dir}/${p}`, signal) });
  return out;
}
