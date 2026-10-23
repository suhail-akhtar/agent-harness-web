// Finding Unity where the session's commands run: the Hub (its settings name its program
// and the extra install folder; `--headless editors -i` lists what it installed), the
// editors in the install folders, HARNESS_UNITY_EDITOR, the build support modules each
// editor has, its project templates, and whether a licence is activated (by the files an
// activation leaves; never their contents). On a companion the same facts come from a
// probe run on the person's computer. Nothing is installed or accepted here.

import fs from 'node:fs/promises';
import path from 'node:path';
import { execIn, quote } from '../games3d/lib-engines.mjs';
import {
  compareVersions, editorDataDir, editorExecutable, editorInFolder, editorRoots, hubCandidates, hubConfigDir, isUnity6, licensePlaces, licenseStatus,
  mergeEditors, modulesFrom, parseHubEditors, parseHubEditorsJson, parseSecondaryInstallPath, pickEditor, versionFromPath,
} from './lib-unity.mjs';

export const INSTALL_HELP = 'In Unity Hub: Installs > Install Editor > the newest Unity 6 LTS (6000.x), with the modules "Windows Build Support (Mono)" (IL2CPP optional) and "WebGL Build Support"; then Preferences > Licenses > Add (Personal is free) while signed in. The harness never installs an editor or accepts a licence for you.';

/** The file system calls discovery uses (a fake in tests). */
export const nodeFs = {
  exists: async (p) => { try { await fs.access(p); return true; } catch { return false; } },
  readText: async (p) => { try { return await fs.readFile(p, 'utf8'); } catch { return null; } },
  readdir: async (p) => { try { return await fs.readdir(p); } catch { return []; } },
};

const join = (platform, ...parts) => (platform === 'win32' ? path.win32.join(...parts) : path.posix.join(...parts));

/**
 * Everything about Unity on this machine. deps: { platform, env, fs, hubList(exe) -> stdout or null }.
 * Returns { hub, editors, license, gaps, notes }.
 */
export async function discover({ platform = process.platform, env = process.env, fs: f = nodeFs, hubList } = {}) {
  const cfg = hubConfigDir(platform, env);
  let hubInfo = null;
  if (cfg) { try { hubInfo = JSON.parse((await f.readText(join(platform, cfg, 'hubInfo.json'))) ?? 'null'); } catch { hubInfo = null; } }
  let hubExe = null;
  for (const c of [env.HARNESS_UNITY_HUB, hubInfo?.executablePath, ...hubCandidates(platform, env)].filter(Boolean)) {
    if (await f.exists(c)) { hubExe = c; break; }
  }
  const secondary = cfg ? parseSecondaryInstallPath(await f.readText(join(platform, cfg, 'secondaryInstallPath.json'))) : null;
  const notes = [];

  // What the Hub says it installed (its own list), when it answers.
  let hubEditors = [];
  let hubAnswered = false;
  if (hubExe && hubList) {
    const out = await hubList(hubExe).catch(() => null);
    if (out !== null && out !== undefined) { hubAnswered = true; hubEditors = parseHubEditors(out); }
  }
  const located = cfg ? [...parseHubEditorsJson(await f.readText(join(platform, cfg, 'editors-v2.json'))), ...parseHubEditorsJson(await f.readText(join(platform, cfg, 'editors.json')))] : [];

  // The install folders, scanned.
  const scanned = [];
  for (const root of editorRoots(platform, env, { secondary, hubExe })) {
    for (const v of await f.readdir(root)) {
      if (!versionFromPath(v)) continue;
      const exe = editorInFolder(platform, join(platform, root, v));
      if (await f.exists(exe)) scanned.push({ version: versionFromPath(v), path: exe, source: 'folder' });
    }
  }
  const override = [];
  if (env.HARNESS_UNITY_EDITOR) {
    let p = editorExecutable(env.HARNESS_UNITY_EDITOR);
    if (!(await f.exists(p)) && versionFromPath(p)) p = editorInFolder(platform, p);
    if (await f.exists(p)) override.push({ version: versionFromPath(p) ?? 'unknown', path: p, source: 'HARNESS_UNITY_EDITOR' });
    else notes.push(`HARNESS_UNITY_EDITOR is set but ${env.HARNESS_UNITY_EDITOR} is not an editor`);
  }

  const all = mergeEditors([override, hubEditors, located, scanned]);
  const editors = [];
  for (const e of all) {
    if (!(await f.exists(e.path))) continue;
    const data = editorDataDir(platform, e.path);
    const engines = await f.readdir(join(platform, data, 'PlaybackEngines'));
    const modules = modulesFrom(engines);
    let il2cpp = false;
    for (const pe of engines.filter((n) => /windowsstandalonesupport|linuxstandalonesupport|macstandalonesupport/i.test(n))) {
      if ((await f.readdir(join(platform, data, 'PlaybackEngines', pe, 'Variations'))).some((v) => /il2cpp/i.test(v))) il2cpp = true;
    }
    const templates = (await f.readdir(join(platform, data, 'Resources', 'PackageManager', 'ProjectTemplates'))).filter((n) => n.endsWith('.tgz'));
    const complete = await f.exists(join(platform, data, 'Managed'));
    editors.push({ version: e.version, path: e.path, sources: e.sources, registered: e.sources.some((s) => s === 'hub' || s === 'hub-located'), modules, il2cpp, templates, complete, dataDir: data });
  }
  editors.sort((a, b) => compareVersions(a.version, b.version));

  // The licence: what an activation leaves on disk.
  const places = licensePlaces(platform, env);
  const lic = { files: [], entitlements: [], server: [] };
  for (const p of places.files) if (await f.exists(p)) lic.files.push(p);
  for (const d of places.dirs) for (const n of await f.readdir(d)) if (/\.(xml|ulf)$/i.test(n)) lic.entitlements.push(join(platform, d, n));
  for (const p of places.server) if (await f.exists(p)) lic.server.push(p);
  const license = licenseStatus(lic);

  const gaps = [];
  if (!hubExe && !editors.length) gaps.push(`Unity is not installed: install Unity Hub (unity.com/download), then an editor. ${INSTALL_HELP}`);
  else if (!editors.length) gaps.push(`Unity Hub found, no editor installed: install one in Unity Hub (a 6000.x LTS). ${INSTALL_HELP}`);
  if (editors.length && license.status === 'not-activated') gaps.push('license not activated: open Unity Hub, sign in, and add a licence (Preferences > Licenses > Add; Personal is free). Batch runs fail until then.');
  const best = pickEditor(editors).editor;
  if (best) {
    if (!best.complete) gaps.push(`the editor at ${best.path} looks incomplete (no Data/Managed): repair or reinstall it in Unity Hub`);
    if (!isUnity6(best.version)) gaps.push(`the newest editor is ${best.version}; the tool is written for Unity 6 (6000.x LTS): install one in Unity Hub`);
    if (platform === 'win32' && !best.modules.includes('windows')) gaps.push(`no Windows Build Support in ${best.version}: add it in Unity Hub (Installs > ${best.version} > Add modules)`);
    if (!best.modules.includes('webgl')) gaps.push(`no WebGL Build Support in ${best.version}: add it in Unity Hub (Installs > ${best.version} > Add modules) to build for the web`);
    if (!best.il2cpp) notes.push(`no IL2CPP module in ${best.version} (optional: Mono builds work; add "Windows Build Support (IL2CPP)" for IL2CPP)`);
    if (hubAnswered && !best.registered) notes.push(`Unity Hub does not list the editor at ${best.path}: add it in Hub (Installs > Locate) to manage its modules and licence there`);
  }
  return { hub: hubExe ? { path: hubExe, version: hubInfo?.version, configDir: cfg, secondaryInstallPath: secondary, answered: hubAnswered } : null, editors, license, gaps, notes };
}

/** The Hub's own list of installed editors (`Unity Hub -- --headless editors -i`), run where the session runs. */
export function hubLister(host, signal) {
  return async (exe) => {
    const cmd = host.shell === 'powershell'
      ? `& ${quote(exe, 'powershell')} -- --headless editors -i`
      : `${quote(exe, 'bash')} -- --headless editors -i`;
    const r = await execIn(host, cmd, { timeoutMs: 60_000, signal });
    return r.timedOut ? null : `${r.stdout}\n${r.stderr}`;
  };
}

/**
 * A probe for a companion (the person's computer): prints the facts discover needs as
 * lines (EXISTS <path>, DIR <path>|<names>, TEXT <path>|<base64>) for the paths asked.
 */
export function probeScript(paths, dirs, texts, shell) {
  if (shell === 'powershell') {
    const arr = (l) => `@(${l.map((p) => quote(p, 'powershell')).join(',')})`;
    return [
      `foreach ($p in ${arr(paths)}) { if (Test-Path -LiteralPath $p) { "EXISTS $p" } }`,
      `foreach ($d in ${arr(dirs)}) { if (Test-Path -LiteralPath $d) { "DIR $d|" + ((Get-ChildItem -Name -LiteralPath $d) -join '/') } }`,
      `foreach ($t in ${arr(texts)}) { if (Test-Path -LiteralPath $t) { "TEXT $t|" + [Convert]::ToBase64String([IO.File]::ReadAllBytes($t)) } }`,
    ].join('\n');
  }
  const words = (l) => l.map((p) => quote(p, 'bash')).join(' ');
  return [
    `for p in ${words(paths)}; do [ -e "$p" ] && echo "EXISTS $p"; done`,
    `for d in ${words(dirs)}; do [ -d "$d" ] && echo "DIR $d|$(ls -1A "$d" | tr '\\n' '/')"; done`,
    `for t in ${words(texts)}; do [ -f "$t" ] && echo "TEXT $t|$(base64 < "$t" | tr -d '\\n')"; done`,
    'true',
  ].join('\n');
}

/** Reads a probe's output into an fs for discover. */
export function probeFs(out) {
  const exists = new Set(); const dirs = new Map(); const texts = new Map();
  for (const line of String(out ?? '').replace(/\r/g, '').split('\n')) {
    if (line.startsWith('EXISTS ')) exists.add(line.slice(7));
    else if (line.startsWith('DIR ')) { const [p, names] = line.slice(4).split('|'); dirs.set(p, (names ?? '').split('/').filter(Boolean)); exists.add(p); }
    else if (line.startsWith('TEXT ')) { const i = line.indexOf('|'); texts.set(line.slice(5, i), Buffer.from(line.slice(i + 1), 'base64').toString('utf8')); }
  }
  return { exists: async (p) => exists.has(p) || dirs.has(p) || texts.has(p), readText: async (p) => texts.get(p) ?? null, readdir: async (p) => dirs.get(p) ?? [] };
}

/**
 * Discovery on a companion: two probes (the Hub's settings and the install folders first,
 * then each editor's folders), each one command on the person's computer.
 */
export async function discoverRemote(host, signal) {
  const platform = host.platform;
  const envProbe = host.shell === 'powershell'
    ? 'Write-Output "APPDATA=$env:APPDATA"; Write-Output "LOCALAPPDATA=$env:LOCALAPPDATA"; Write-Output "ProgramFiles=$env:ProgramFiles"; Write-Output "ProgramData=$env:ProgramData"; Write-Output "HOME=$HOME"; Write-Output "HARNESS_UNITY_EDITOR=$env:HARNESS_UNITY_EDITOR"; Write-Output "HARNESS_UNITY_HUB=$env:HARNESS_UNITY_HUB"'
    : 'for v in APPDATA LOCALAPPDATA ProgramFiles ProgramData HOME HARNESS_UNITY_EDITOR HARNESS_UNITY_HUB; do echo "$v=$(printenv $v)"; done';
  const e = await execIn(host, envProbe, { timeoutMs: 30_000, signal });
  const env = {};
  for (const l of e.stdout.replace(/\r/g, '').split('\n')) { const i = l.indexOf('='); if (i > 0 && l.slice(i + 1)) env[l.slice(0, i)] = l.slice(i + 1); }
  const cfg = hubConfigDir(platform, env);
  const texts = cfg ? ['hubInfo.json', 'secondaryInstallPath.json', 'editors-v2.json', 'editors.json'].map((n) => join(platform, cfg, n)) : [];
  const first = probeFs((await execIn(host, probeScript([...hubCandidates(platform, env)], [], texts, host.shell), { timeoutMs: 30_000, signal })).stdout);
  let hubInfo = null;
  try { hubInfo = JSON.parse((await first.readText(texts[0])) ?? 'null'); } catch { /* none */ }
  const hubExe = [env.HARNESS_UNITY_HUB, hubInfo?.executablePath, ...hubCandidates(platform, env)].filter(Boolean)[0];
  const secondary = cfg ? parseSecondaryInstallPath(await first.readText(texts[1])) : null;
  const roots = editorRoots(platform, env, { secondary, hubExe });
  const second = probeFs((await execIn(host, probeScript(hubInfo?.executablePath ? [hubInfo.executablePath] : [], roots, [], host.shell), { timeoutMs: 30_000, signal })).stdout);
  const versions = [];
  for (const r of roots) for (const v of await second.readdir(r)) if (versionFromPath(v)) versions.push(join(platform, r, v));
  if (env.HARNESS_UNITY_EDITOR) versions.push(env.HARNESS_UNITY_EDITOR);
  const exes = versions.map((v) => (/Unity(\.exe)?$/i.test(v) ? v : editorInFolder(platform, v)));
  const dataDirs = exes.map((x) => editorDataDir(platform, x));
  const editorDirs = dataDirs.flatMap((d) => [join(platform, d, 'PlaybackEngines'), join(platform, d, 'Resources', 'PackageManager', 'ProjectTemplates'), ...['windowsstandalonesupport', 'WindowsStandaloneSupport', 'LinuxStandaloneSupport', 'MacStandaloneSupport'].map((pe) => join(platform, d, 'PlaybackEngines', pe, 'Variations'))]);
  const places = licensePlaces(platform, env);
  const third = probeFs((await execIn(host, probeScript([...exes, ...dataDirs.map((d) => join(platform, d, 'Managed')), ...places.files, ...places.server], [...editorDirs, ...places.dirs], [], host.shell), { timeoutMs: 30_000, signal })).stdout);
  const merged = {
    exists: async (p) => (await first.exists(p)) || (await second.exists(p)) || (await third.exists(p)) || (hubExe === p && Boolean(hubInfo)),
    readText: async (p) => (await first.readText(p)) ?? null,
    readdir: async (p) => { const a = await second.readdir(p); return a.length ? a : third.readdir(p); },
  };
  return discover({ platform, env, fs: merged, hubList: hubLister(host, signal) });
}
