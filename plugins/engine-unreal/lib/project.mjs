// Unreal projects from the engine's own templates, made the way the editor's New Project
// dialog makes them (GameProjectUtils): the template folder copied without its ignored
// files, the template's name replaced in the config files, the shared content packs
// (Characters, Input, LevelPrototyping...) and an optional variant pack copied into
// Content, a new ProjectID, and the .uproject with Python and Remote Control enabled.
// Plain file work, so it needs no editor and no compiler.

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** The Blueprint templates agents may start from, and what each is for. */
export const TEMPLATES = {
  TP_ThirdPersonBP: { dimension: '3d', genre: 'third-person', variants: ['Combat', 'Platforming', 'SideScroller'] },
  TP_FirstPersonBP: { dimension: '3d', genre: 'first-person', variants: ['ArenaShooter', 'SurvivalHorror'] },
  TP_TopDownBP: { dimension: '3d', genre: 'top-down', variants: ['Strategy', 'TwinStick'] },
  TP_BlankBP: { dimension: '3d', genre: 'blank', variants: [] },
};

/** The 2D and 2.5D setups: a template, its variant and the camera the setup script puts in. */
export const SETUPS = {
  sidescroller: { template: 'TP_ThirdPersonBP', variant: 'SideScroller', dimension: '2.5d', camera: 'side' },
  'topdown-2d': { template: 'TP_TopDownBP', variant: null, dimension: '2d', camera: 'top' },
};

/**
 * Plugins every project gets: editor Python, the Remote Control API (HTTP and WebSocket) and
 * Movie Render Queue. All for the Editor target only: a plugin with runtime modules that is
 * not on by default makes UnrealBuildTool treat a Blueprint-only project as a code project
 * ("is being treated as a code-based project ... because: X plugin is enabled"), and that
 * needs a C++ compiler to package. Editor-only, the precompiled UnrealGame runs the game.
 */
export const PROJECT_PLUGINS = ['PythonScriptPlugin', 'EditorScriptingUtilities', 'RemoteControl', 'MovieRenderPipeline'];

/** Content of editor-only plugins the cook must skip: it imports editor types ("Failed to cook ... module that is not available"). */
export const NEVER_COOK = ['/MovieRenderPipeline'];

/** Template plugins with runtime modules the templates' own content does not use at runtime: made editor-only for the same reason. */
export const EDITOR_ONLY_TEMPLATE_PLUGINS = ['GameplayStateTree'];

/** A project name Unreal accepts: letters, digits and _, starting with a letter, at most 20 characters. */
export function projectName(name) {
  const n = String(name ?? '').replace(/[^A-Za-z0-9_]/g, '');
  if (!/^[A-Za-z]/.test(n)) throw new Error(`"${name}" is not a usable project name: start with a letter, then letters, digits or _ (e.g. CoinEscape)`);
  if (n.length > 20) throw new Error(`"${n}" is longer than 20 characters (Unreal limits project names)`);
  return n;
}

/** The values of one key in an ini file, in order (repeated keys and +Key= both count). */
export function iniValues(text, key) {
  const out = [];
  const re = new RegExp(`^\\s*[+]?${key}\\s*=\\s*(.*)$`, 'i');
  for (const line of String(text).replace(/\r/g, '').split('\n')) {
    if (/^\s*;/.test(line)) continue;
    const m = re.exec(line);
    if (m) out.push(m[1].trim().replace(/^"(.*)"$/, '$1'));
  }
  return out;
}

/** MountName and DetailLevels of each SharedContentPacks=(...) value. */
export function sharedPacks(values) {
  return values.map((v) => {
    const mount = /MountName="?([\w-]+)"?/.exec(v)?.[1];
    const level = /DetailLevels=\(\s*"?(\w+)"?/.exec(v)?.[1] ?? 'Standard';
    return mount ? { mount, level } : null;
  }).filter(Boolean);
}

/** A template's TemplateDefs.ini as data: what to skip, the packs, and each variant's packs. */
export function parseTemplateDefs(text) {
  const variants = {};
  for (const v of iniValues(text, 'Variants')) {
    const name = /^\(Name="?(\w+)"?/.exec(v)?.[1];
    if (!name) continue;
    const packs = /SharedContentPacks=\((.*)\)\)?\s*$/.exec(v)?.[1] ?? '';
    variants[name] = sharedPacks(packs.split(/\)\s*,\s*\(/).map((p) => p.replace(/^\(+|\)+$/g, '')));
  }
  return {
    foldersToIgnore: iniValues(text, 'FoldersToIgnore'),
    filesToIgnore: iniValues(text, 'FilesToIgnore'),
    packs: sharedPacks(iniValues(text, 'SharedContentPacks')),
    variants,
  };
}

/** The template's name replaced in one config file, as GameProjectUtils does (case-insensitive, after the upper and lower case forms). */
export function replaceTemplateName(text, template, name) {
  return String(text)
    .split(template.toUpperCase()).join(name.toUpperCase())
    .split(template.toLowerCase()).join(name.toLowerCase())
    .replace(new RegExp(template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), name);
}

/** A ProjectID line value: (A=..,B=..,C=..,D=..) as signed 32-bit ints, like the editor writes. */
export function projectId(bytes = crypto.randomBytes(16)) {
  const b = Buffer.from(bytes);
  return `(A=${b.readInt32LE(0)},B=${b.readInt32LE(4)},C=${b.readInt32LE(8)},D=${b.readInt32LE(12)})`;
}

/** Sets key=value in [section] of an ini text (adds the section or the key when missing). */
export function setIni(text, section, key, value) {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n');
  const head = `[${section}]`;
  let i = lines.findIndex((l) => l.trim() === head);
  if (i < 0) {
    while (lines.length && lines.at(-1) === '') lines.pop();
    return [...lines, ...(lines.length ? [''] : []), head, `${key}=${value}`, ''].join('\n');
  }
  let j = i + 1;
  const same = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`, 'i');
  // An array entry (+Key=) is added once per value; a plain key is replaced.
  const isArray = key.startsWith('+');
  for (; j < lines.length && !/^\s*\[/.test(lines[j]); j++) {
    if (isArray && lines[j].trim() === `${key}=${value}`) return lines.join('\n');
    if (!isArray && same.test(lines[j])) { lines[j] = `${key}=${value}`; return lines.join('\n'); }
  }
  while (j > i + 1 && lines[j - 1].trim() === '') j--;
  lines.splice(j, 0, `${key}=${value}`);
  return lines.join('\n');
}

/**
 * The .uproject with the engine association and the project plugins enabled for the editor
 * (others kept). editorOnly: template plugins to limit to the editor too (see above);
 * keepRuntime lists the ones a chosen variant needs in the game.
 */
export function uprojectWith(json, { association, plugins = PROJECT_PLUGINS, editorOnly = EDITOR_ONLY_TEMPLATE_PLUGINS, keepRuntime = [], description } = {}) {
  const u = typeof json === 'string' ? JSON.parse(json) : structuredClone(json);
  if (association !== undefined) u.EngineAssociation = association;
  if (description) u.Description = description;
  u.Plugins = Array.isArray(u.Plugins) ? u.Plugins : [];
  for (const name of plugins) {
    const p = u.Plugins.find((x) => x.Name === name);
    if (p) { p.Enabled = true; p.TargetAllowList = ['Editor']; } else u.Plugins.push({ Name: name, Enabled: true, TargetAllowList: ['Editor'] });
  }
  for (const p of u.Plugins) {
    if (editorOnly.includes(p.Name) && !keepRuntime.includes(p.Name) && p.Enabled) p.TargetAllowList = ['Editor'];
  }
  return JSON.stringify(u, null, '\t');
}

/** Plugins enabled for the game (not limited to the Editor target): what makes a Blueprint project need a compiler to package. */
export function runtimePlugins(json) {
  const u = typeof json === 'string' ? JSON.parse(json) : json;
  return (u.Plugins ?? []).filter((p) => p.Enabled && !(Array.isArray(p.TargetAllowList) && p.TargetAllowList.every((t) => t === 'Editor'))).map((p) => p.Name);
}

const exists = (p) => fsp.access(p).then(() => true, () => false);

/** Copies a folder tree (files only where `keep` says yes). Never follows a link out of it. */
async function copyTree(from, to, keep = () => true, rel = '') {
  let n = 0;
  const entries = await fsp.readdir(path.join(from, rel), { withFileTypes: true });
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) { if (keep(r, true)) n += await copyTree(from, to, keep, r); continue; }
    if (!keep(r, false)) continue;
    await fsp.mkdir(path.dirname(path.join(to, r)), { recursive: true });
    await fsp.copyFile(path.join(from, r), path.join(to, r));
    n++;
  }
  return n;
}

/** Where a shared pack's files go: Content/<Dest>/..., Content/__ExternalActors__/<Dest>/... (FeaturePackContentSource). */
export function packTarget(rel, dest) {
  const [top, ...rest] = rel.split('/');
  if (top === 'Content') return ['Content', dest, ...rest].join('/');
  if (top === '__ExternalActors__' || top === '__ExternalObjects__') return ['Content', top, dest, ...rest].join('/');
  return null;
}

async function copyPack(engineRoot, { mount, level }, projectDir) {
  const base = path.join(engineRoot, 'Templates', 'TemplateResources', level, mount);
  if (!await exists(base)) throw new Error(`the content pack ${level}/${mount} is not in ${path.dirname(path.dirname(base))}`);
  let dest = mount;
  try { dest = JSON.parse(await fsp.readFile(path.join(base, 'FeaturePack', 'manifest.json'), 'utf8')).AdditionalFiles?.DestinationFilesFolder || mount; } catch { /* the mount name */ }
  let n = 0;
  for (const top of ['Content', '__ExternalActors__', '__ExternalObjects__']) {
    if (!await exists(path.join(base, top))) continue;
    n += await copyTree(path.join(base, top), path.join(projectDir, packTarget(`${top}/x`, dest).slice(0, -2)));
  }
  return { mount, level, dest, files: n };
}

/**
 * Makes <dir>/<name>.uproject from an engine template. dir must not hold a project yet.
 * Returns what was copied and the maps; the editor is not started.
 */
export async function createFromTemplate({ engineRoot, template = 'TP_ThirdPersonBP', variant, name, dir, association, description }) {
  const tdir = path.join(engineRoot, 'Templates', template);
  if (!await exists(path.join(tdir, `${template}.uproject`))) throw new Error(`no template ${template} in ${path.join(engineRoot, 'Templates')}`);
  if (await exists(path.join(dir, `${name}.uproject`))) throw new Error(`${path.join(dir, `${name}.uproject`)} already exists`);
  const defs = parseTemplateDefs(await fsp.readFile(path.join(tdir, 'Config', 'TemplateDefs.ini'), 'utf8').catch(() => ''));
  const ignoreDirs = new Set(defs.foldersToIgnore.map((f) => f.toLowerCase()));
  const ignoreFiles = new Set(defs.filesToIgnore.map((f) => f.replace(/%TEMPLATENAME%/g, template).toLowerCase()));
  const keep = (rel, isDir) => (isDir ? !ignoreDirs.has(rel.toLowerCase()) : !ignoreFiles.has(rel.toLowerCase()) && !/^(Manifest\.json|contents\.txt)$/i.test(rel));
  await fsp.mkdir(dir, { recursive: true });
  const copied = await copyTree(tdir, dir, (rel, isDir) => keep(rel, isDir) && rel !== `${template}.uproject`);

  // Config files: the template's name becomes the project's.
  for (const f of await fsp.readdir(path.join(dir, 'Config')).catch(() => [])) {
    if (!f.endsWith('.ini')) continue;
    const p = path.join(dir, 'Config', f);
    await fsp.writeFile(p, replaceTemplateName(await fsp.readFile(p, 'utf8'), template, name));
  }
  if (variant && !defs.variants[variant]) throw new Error(`${template} has no variant ${variant}; it has: ${Object.keys(defs.variants).filter((v) => v !== 'All').join(', ') || 'none'}`);
  const packs = [];
  for (const p of [...defs.packs, ...(variant ? defs.variants[variant] : [])]) {
    if (packs.some((x) => x.mount === p.mount)) continue;
    packs.push(await copyPack(engineRoot, p, dir));
  }

  // A project of its own: a new id and name, and the variant's level as the start map.
  const gamePath = path.join(dir, 'Config', 'DefaultGame.ini');
  let game = await fsp.readFile(gamePath, 'utf8').catch(() => '');
  game = setIni(game, '/Script/EngineSettings.GeneralProjectSettings', 'ProjectID', projectId());
  game = setIni(game, '/Script/EngineSettings.GeneralProjectSettings', 'ProjectName', name);
  // Editor-only plugins' own content must not be cooked (Movie Render Queue's widgets import editor types).
  for (const dir of NEVER_COOK) game = setIni(game, '/Script/UnrealEd.ProjectPackagingSettings', '+DirectoriesToNeverCook', `(Path="${dir}")`);
  await fsp.writeFile(gamePath, game);
  const enginePath = path.join(dir, 'Config', 'DefaultEngine.ini');
  let engine = await fsp.readFile(enginePath, 'utf8').catch(() => '');
  let map = /GameDefaultMap=(\S+)/.exec(engine)?.[1];
  if (variant) {
    const vmap = await variantMap(dir, packs.find((p) => p.mount === `Variant_${variant}`)?.dest);
    if (vmap) {
      map = vmap;
      engine = setIni(engine, '/Script/EngineSettings.GameMapsSettings', 'EditorStartupMap', vmap);
      engine = setIni(engine, '/Script/EngineSettings.GameMapsSettings', 'GameDefaultMap', vmap);
    }
  }
  await fsp.writeFile(enginePath, engine);

  const uproject = path.join(dir, `${name}.uproject`);
  // A variant's content (AI with StateTree) uses the template's runtime plugins, so they stay on for the game.
  const keepRuntime = variant ? EDITOR_ONLY_TEMPLATE_PLUGINS : [];
  const text = uprojectWith(await fsp.readFile(path.join(tdir, `${template}.uproject`), 'utf8'), { association, description, keepRuntime });
  await fsp.writeFile(uproject, text);
  return { uproject, copied, packs, map, runtimePlugins: runtimePlugins(text) };
}

/** The level a variant pack brings (Content/<dest>/*.umap), as an object path. */
async function variantMap(dir, dest) {
  if (!dest) return null;
  const files = await fsp.readdir(path.join(dir, 'Content', dest)).catch(() => []);
  const umap = files.find((f) => f.endsWith('.umap'));
  if (!umap) return null;
  const base = umap.slice(0, -5);
  return `/Game/${dest}/${base}.${base}`;
}

/** .studio/project.json for an Unreal project (FORMATS.md). engineProject is relative to the Studio folder. */
export function studioProject({ name, dimension = '3d', genre, engineProject, created = new Date().toISOString(), template, variant }) {
  return {
    name, engine: 'unreal', dimension, genre: genre ?? 'third-person', created, engineProject,
    design: 'design/GDD.md',
    budgets: { fps: 60, frameMs: 16.7, memoryMb: 4096, trianglesPerAsset: 50000, textureMax: 2048 },
    stages: [], builds: [], playtests: [],
    unreal: { template, ...(variant ? { variant } : {}) },
  };
}

/** The projects (.uproject) in a folder tree, skipping what Unreal generates. */
export async function findUprojects(root, { max = 5, depth = 3, rel = '' } = {}) {
  const out = [];
  let entries = [];
  try { entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (out.length >= max) break;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isFile() && e.name.endsWith('.uproject')) out.push(r);
    else if (e.isDirectory() && depth > 0 && !/^(\.|node_modules$|Binaries$|Intermediate$|Saved$|DerivedDataCache$|Content$|Builds?$)/.test(e.name)) out.push(...await findUprojects(root, { max: max - out.length, depth: depth - 1, rel: r }));
  }
  return out;
}
