// Unity project files the tool writes: the harness bridge package (into Packages/, with
// stable .meta GUIDs so scenes keep their script references across reinstalls), a project
// from one of the editor's templates or a minimal one, test assemblies, and Studio's
// .studio/project.json.

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTextIn, writeIn } from '@harness/plugins/games3d/lib-engines.mjs';
import { untar } from './lib-archive.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_NAME = 'com.harness.bridge';
export const PACKAGE_DIR = path.join(here, 'package', PACKAGE_NAME);

/** The package's files, relative to its folder (forward slashes), sorted. */
export function packageFiles(dir = PACKAGE_DIR) {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (!e.name.endsWith('.meta')) out.push(r);
    }
  };
  walk('');
  return out.sort();
}

/** The folders of a list of files (each parent once), for their .meta files. */
export function packageFolders(files) {
  const set = new Set();
  for (const f of files) { let d = path.posix.dirname(f); while (d && d !== '.') { set.add(d); d = path.posix.dirname(d); } }
  return [...set].sort();
}

/** A GUID that is the same on every install: md5 of the package and the path. */
export const stableGuid = (rel) => crypto.createHash('md5').update(`${PACKAGE_NAME}/${rel}`).digest('hex');

/** The .meta Unity expects beside a file or folder (the importer by kind). */
export function metaFor(rel, folder = false) {
  const head = `fileFormatVersion: 2\nguid: ${stableGuid(rel)}\n`;
  const tail = '  userData: \n  assetBundleName: \n  assetBundleVariant: \n';
  if (folder) return `${head}folderAsset: yes\nDefaultImporter:\n  externalObjects: {}\n${tail}`;
  if (rel.endsWith('.cs')) return `${head}MonoImporter:\n  externalObjects: {}\n  serializedVersion: 2\n  defaultReferences: []\n  executionOrder: 0\n  icon: {instanceID: 0}\n${tail}`;
  if (rel.endsWith('.asmdef')) return `${head}AssemblyDefinitionImporter:\n  externalObjects: {}\n${tail}`;
  if (rel === 'package.json') return `${head}PackageManifestImporter:\n  externalObjects: {}\n${tail}`;
  if (/\.(md|txt|json)$/.test(rel)) return `${head}TextScriptImporter:\n  externalObjects: {}\n${tail}`;
  return `${head}DefaultImporter:\n  externalObjects: {}\n${tail}`;
}

/** Every file of the installed package with its contents (the .meta files included). */
export function bridgeFiles(dir = PACKAGE_DIR) {
  const files = packageFiles(dir);
  const out = files.map((f) => ({ rel: f, data: fs.readFileSync(path.join(dir, f)) }));
  for (const f of files) out.push({ rel: `${f}.meta`, data: Buffer.from(metaFor(f)) });
  for (const d of packageFolders(files)) out.push({ rel: `${d}.meta`, data: Buffer.from(metaFor(d, true)) });
  return out;
}

/** A hash of the package, so an install is skipped when the project already has this one. */
export function bridgeHash(files = bridgeFiles()) {
  const h = crypto.createHash('sha256');
  for (const f of [...files].sort((a, b) => a.rel.localeCompare(b.rel))) h.update(f.rel).update('\0').update(f.data);
  return h.digest('hex').slice(0, 16);
}

const STAMP = '.harness-installed';

/** Removes files an older package had and this one does not, one by one (links are left alone). */
async function pruneStale(dir, keep, rel = '') {
  let entries;
  try { entries = await fsp.readdir(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) await pruneStale(dir, keep, r);
    else if (e.isFile() && !keep.has(r) && r !== STAMP) await fsp.unlink(path.join(dir, r)).catch(() => {});
  }
}

/** Installs (or updates) the bridge package into <project>/Packages/com.harness.bridge. Returns whether it wrote. */
export async function installBridge(host, project, signal) {
  const files = bridgeFiles();
  const hash = bridgeHash(files);
  const base = `${project === '.' ? '' : `${project}/`}Packages/${PACKAGE_NAME}`;
  if ((await readTextIn(host, `${base}/${STAMP}`, signal))?.trim() === hash) return { installed: false, hash, path: base };
  if (host.kind !== 'companion') await pruneStale(path.join(host.root, base), new Set(files.map((f) => f.rel)));
  for (const f of files) await writeIn(host, `${base}/${f.rel}`, f.data, signal);
  await writeIn(host, `${base}/${STAMP}`, `${hash}\n`, signal);
  return { installed: true, hash, path: base };
}

// ---------- templates ----------

/** Studio's template names, what each is, and the editor templates that match (by package name). */
export const TEMPLATES = {
  '3d-urp': { dimension: '3d', urp: true, names: ['com.unity.template.urp-blank', 'com.unity.template.universal-3d', 'com.unity.template.3d-cross-platform'], title: '3D (URP)' },
  '2.5d-urp': { dimension: '2.5d', urp: true, names: ['com.unity.template.urp-blank', 'com.unity.template.universal-3d', 'com.unity.template.3d-cross-platform'], title: '2.5D (URP, isometric camera)' },
  '2d-urp': { dimension: '2d', urp: true, names: ['com.unity.template.universal-2d', 'com.unity.template.2d-cross-platform', 'com.unity.template.2d'], title: '2D (URP 2D renderer, tilemaps and sprites)' },
  '3d-builtin': { dimension: '3d', urp: false, names: ['com.unity.template.3d'], title: '3D (built-in render pipeline)' },
};

export function templateFor(name, dimension) {
  const key = String(name ?? (dimension === '2d' ? '2d-urp' : dimension === '2.5d' ? '2.5d-urp' : '3d-urp')).toLowerCase().replace(/\s+/g, '-');
  const alias = { '3d': '3d-urp', urp: '3d-urp', '2d': '2d-urp', '2.5d': '2.5d-urp', isometric: '2.5d-urp', builtin: '3d-builtin', 'built-in': '3d-builtin', '3d-built-in': '3d-builtin' }[key] ?? key;
  return TEMPLATES[alias] ? { id: alias, ...TEMPLATES[alias] } : null;
}

/** A template archive's package.json (name, displayName, version) without unpacking the rest. */
export function templateInfo(tgz) {
  const pkg = untar(tgz).find((e) => e.name === 'package/package.json');
  if (!pkg) throw new Error('not a Unity project template (no package/package.json)');
  return JSON.parse(pkg.data.toString('utf8'));
}

/** The project inside a template: ProjectData~/ (Assets, Packages, ProjectSettings; the Library cache is skipped). */
export function templateProject(tgz, { library = false } = {}) {
  const out = [];
  for (const e of untar(tgz)) {
    if (e.type !== 'file' || !e.name.startsWith('package/ProjectData~/')) continue;
    const rel = e.name.slice('package/ProjectData~/'.length);
    if (!rel || (!library && rel.startsWith('Library/')) || rel.split('/').some((p) => p === '..')) continue;
    out.push({ rel, data: e.data });
  }
  return out;
}

/** Picks the editor's template for a Studio template from [{ file, name, version }]. */
export function pickTemplate(available, tpl) {
  for (const n of tpl.names) {
    const hit = available.filter((t) => t.name === n).sort((a, b) => String(b.version).localeCompare(String(a.version), undefined, { numeric: true }))[0];
    if (hit) return hit;
  }
  return null;
}

// ---------- a minimal project ----------

const MODULES = ['ai', 'animation', 'audio', 'imageconversion', 'imgui', 'jsonserialize', 'particlesystem', 'physics', 'physics2d', 'screencapture', 'terrain', 'tilemap', 'ui', 'uielements', 'umbra', 'unitywebrequest', 'unitywebrequesttexture', 'video', 'vr', 'xr', 'director', 'unityanalytics'];

/** Versions that work with Unity 6.0 (6000.0 LTS); the editor's own templates and built-in packages win when present. */
export const DEFAULT_VERSIONS = {
  'com.unity.inputsystem': '1.11.2', 'com.unity.test-framework': '1.4.5', 'com.unity.ugui': '2.0.0',
  'com.unity.render-pipelines.universal': '17.0.3', 'com.unity.feature.2d': '2.0.1', 'com.unity.timeline': '1.8.7',
};

/**
 * Packages/manifest.json for a minimal project: the modules, the Input System, the Test Framework, uGUI,
 * and URP and the 2D feature set when asked. versions: names to versions known for this editor.
 */
export function minimalManifest({ urp, twoD, versions = {} }) {
  const v = { ...DEFAULT_VERSIONS, ...versions };
  const deps = {
    'com.unity.inputsystem': v['com.unity.inputsystem'], 'com.unity.test-framework': v['com.unity.test-framework'], 'com.unity.ugui': v['com.unity.ugui'],
    ...(urp ? { 'com.unity.render-pipelines.universal': v['com.unity.render-pipelines.universal'] } : {}),
    ...(twoD ? { 'com.unity.feature.2d': v['com.unity.feature.2d'] } : {}),
  };
  for (const m of MODULES) deps[`com.unity.modules.${m}`] = '1.0.0';
  return `${JSON.stringify({ dependencies: Object.fromEntries(Object.entries(deps).sort()) }, null, 2)}\n`;
}

/** Package versions from a template's manifest and the editor's built-in packages: { name: version }. */
export function knownVersions(manifests = [], builtIn = {}) {
  const out = {};
  for (const m of manifests) for (const [k, ver] of Object.entries(m?.dependencies ?? {})) if (/^\d/.test(String(ver))) out[k] = String(ver);
  return { ...out, ...builtIn };
}

/** ProjectSettings.asset with the product name (and company) set, as text. */
export function withProductName(text, name, company) {
  let t = String(text).replace(/^(\s*productName:).*$/m, `$1 ${name}`);
  if (company) t = t.replace(/^(\s*companyName:).*$/m, `$1 ${company}`);
  return t;
}

/** Edit mode and play mode test assemblies with one passing test each (the gates and the test action use them). */
export function testScaffold(name) {
  const ns = String(name).replace(/[^A-Za-z0-9_]/g, '') || 'Game';
  const asm = (n, editor) => `${JSON.stringify({
    name: n, rootNamespace: '', references: ['UnityEngine.TestRunner', 'UnityEditor.TestRunner', 'Harness.Bridge'],
    includePlatforms: editor ? ['Editor'] : [], excludePlatforms: [], allowUnsafeCode: false, overrideReferences: true,
    precompiledReferences: ['nunit.framework.dll'], autoReferenced: false, defineConstraints: ['UNITY_INCLUDE_TESTS'], versionDefines: [], noEngineReferences: false,
  }, null, 4)}\n`;
  const edit = `// Edit mode tests: run with the unity tool (action test, platform EditMode).
using NUnit.Framework;
using UnityEditor;
using UnityEngine;

namespace ${ns}.Tests
{
    public class ProjectTests
    {
        [Test]
        public void BuildHasAScene()
        {
            Assert.That(EditorBuildSettings.scenes.Length, Is.GreaterThan(0), "add the main scene to the build settings");
        }

        [Test]
        public void HarnessStateKeepsValues()
        {
            Harness.Bridge.HarnessState.Set("probe", 3);
            Assert.That(Harness.Bridge.HarnessState.Get("probe"), Is.EqualTo(3));
        }
    }
}
`;
  const play = `// Play mode tests: run with the unity tool (action test, platform PlayMode).
using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace ${ns}.Tests
{
    public class PlayTests
    {
        [UnityTest]
        public IEnumerator FramesAdvance()
        {
            int start = Time.frameCount;
            yield return null;
            yield return null;
            Assert.That(Time.frameCount, Is.GreaterThan(start));
        }

        [UnityTest]
        public IEnumerator InjectedKeysAreHeld()
        {
            Harness.Bridge.HarnessInput.SetKey("W", true);
            yield return null;
            Assert.That(Harness.Bridge.HarnessInput.GetAxis("Vertical"), Is.EqualTo(1f));
            Harness.Bridge.HarnessInput.Reset();
        }
    }
}
`;
  return [
    { rel: 'Assets/Tests/EditMode/Tests.EditMode.asmdef', data: asm(`${ns}.Tests.EditMode`, true) },
    { rel: 'Assets/Tests/EditMode/ProjectTests.cs', data: edit },
    { rel: 'Assets/Tests/PlayMode/Tests.PlayMode.asmdef', data: asm(`${ns}.Tests.PlayMode`, false) },
    { rel: 'Assets/Tests/PlayMode/PlayTests.cs', data: play },
  ];
}

export const GITIGNORE = ['/[Ll]ibrary/', '/[Tt]emp/', '/[Oo]bj/', '/[Bb]uild/', '/[Bb]uilds/', '/[Ll]ogs/', '/[Uu]ser[Ss]ettings/', '/[Mm]emoryCaptures/', '*.csproj', '*.sln', '*.user', '.vs/', ''].join('\n');

// ---------- Studio's project file ----------

/** .studio/project.json for a Unity project (FORMATS.md), merged into an existing one without dropping fields. */
export function studioProject(existing, { name, dimension, genre, engineProject, created = new Date().toISOString() }) {
  const base = existing && typeof existing === 'object' ? existing : {};
  return {
    budgets: { fps: 60, frameMs: 16.7, memoryMb: 2048, trianglesPerAsset: 20000, textureMax: 2048 },
    stages: [], builds: [], playtests: [],
    ...base,
    name: base.name ?? name,
    engine: base.engine && base.engine !== 'unity' ? base.engine : 'unity',
    dimension: base.dimension ?? dimension,
    ...(genre || base.genre ? { genre: base.genre ?? genre } : {}),
    created: base.created ?? created,
    engineProject: base.engine && base.engine !== 'unity' ? base.engineProject : engineProject,
  };
}

/** Adds a build to .studio/project.json (newest last), keeping every other field. */
export function withBuild(project, build) {
  const p = project && typeof project === 'object' ? project : {};
  return { ...p, builds: [...(Array.isArray(p.builds) ? p.builds : []).filter((b) => b.id !== build.id), build] };
}
