// Finding Unreal Engine installs and what they lack. Pure over a small `sys` (env, platform,
// files, the registry, vswhere, free disk), so the unit tests run it with fakes; `hostSys`
// is the real one for this machine.
//
// Where installs are listed, in order: HARNESS_UNREAL_ROOT; the Epic launcher's
// LauncherInstalled.dat (AppName UE_5.x); the registry (HKLM\SOFTWARE\EpicGames\Unreal
// Engine\<ver> InstalledDirectory, and HKCU\SOFTWARE\Epic Games\Unreal Engine\Builds for
// source and custom builds); then the usual folders (C:\Program Files\Epic Games\UE_5.x,
// D:\UnrealEngine\UE_5.x, /opt/UnrealEngine, ~/UnrealEngine, /Users/Shared/Epic Games/UE_5.x).

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Free space below which a project, its cook and a package do not fit comfortably (GB). */
export const MIN_FREE_GB = 30;

/** The editor, the console editor, UAT and the game binary of an install, per platform. */
export function binaries(root, platform) {
  const j = platform === 'win32' ? path.win32.join : path.posix.join;
  if (platform === 'win32') {
    return {
      editor: j(root, 'Engine', 'Binaries', 'Win64', 'UnrealEditor.exe'),
      editorCmd: j(root, 'Engine', 'Binaries', 'Win64', 'UnrealEditor-Cmd.exe'),
      uat: j(root, 'Engine', 'Build', 'BatchFiles', 'RunUAT.bat'),
      game: j(root, 'Engine', 'Binaries', 'Win64', 'UnrealGame.exe'),
      python: j(root, 'Engine', 'Binaries', 'ThirdParty', 'Python3', 'Win64', 'python.exe'),
    };
  }
  const dir = platform === 'darwin' ? 'Mac' : 'Linux';
  const editor = platform === 'darwin' ? j(root, 'Engine', 'Binaries', 'Mac', 'UnrealEditor.app', 'Contents', 'MacOS', 'UnrealEditor') : j(root, 'Engine', 'Binaries', 'Linux', 'UnrealEditor');
  return {
    editor,
    editorCmd: platform === 'darwin' ? editor : editor,
    uat: j(root, 'Engine', 'Build', 'BatchFiles', 'RunUAT.sh'),
    game: j(root, 'Engine', 'Binaries', dir, 'UnrealGame'),
    python: j(root, 'Engine', 'Binaries', 'ThirdParty', 'Python3', dir, 'bin', 'python3'),
  };
}

/** "5.8.4" from Engine/Build/Build.version. */
export function parseBuildVersion(text) {
  try {
    const v = JSON.parse(text);
    return { version: `${v.MajorVersion}.${v.MinorVersion}.${v.PatchVersion}`, major: v.MajorVersion, minor: v.MinorVersion, changelist: v.Changelist, branch: v.BranchName };
  } catch { return null; }
}

/** Value lines of `reg query`: [{ key, name, value }]. */
export function parseRegQuery(text) {
  const out = [];
  let key = '';
  for (const line of String(text ?? '').replace(/\r/g, '').split('\n')) {
    if (/^HKEY_/.test(line)) { key = line.trim(); continue; }
    const m = /^\s+(\S.*?)\s+REG_\w+\s+(.*)$/.exec(line);
    if (m) out.push({ key, name: m[1], value: m[2].trim() });
  }
  return out;
}

/** Engine roots the launcher lists (LauncherInstalled.dat). */
export function launcherRoots(text) {
  try {
    return (JSON.parse(text).InstallationList ?? []).filter((i) => /^UE_\d/.test(i.AppName ?? '')).map((i) => ({ root: i.InstallLocation, source: 'launcher', association: String(i.AppName).replace(/^UE_/, '') }));
  } catch { return []; }
}

/** Places people and the launcher put engines. */
export function commonRoots(platform, env, listDir) {
  const out = [];
  const add = (base, prefix = 'UE_') => { for (const d of listDir(base)) if (d.startsWith(prefix)) out.push(path.join(base, d)); };
  if (platform === 'win32') {
    for (const pf of [env.ProgramFiles, 'C:\\Program Files'].filter(Boolean)) add(path.win32.join(pf, 'Epic Games'));
    for (const drive of ['C:', 'D:', 'E:', 'F:']) {
      add(`${drive}\\UnrealEngine`);
      add(`${drive}\\Epic Games`);
      add(`${drive}\\Program Files\\Epic Games`);
    }
  } else if (platform === 'darwin') add('/Users/Shared/Epic Games');
  else {
    for (const base of ['/opt', env.HOME, env.HOME && path.posix.join(env.HOME, 'UnrealEngine')].filter(Boolean)) add(base, 'UnrealEngine');
    if (env.HOME) add(path.posix.join(env.HOME, 'UnrealEngine'));
  }
  return [...new Set(out)];
}

/**
 * Every install found: { root, version, association, source, binaries, installedBuild, plugins }.
 * sys: { platform, env, exists(p), readFile(p) -> string|null, listDir(p) -> string[], regQuery(key) -> string|null }.
 */
export async function findInstalls(sys) {
  const cands = [];
  if (sys.env.HARNESS_UNREAL_ROOT) cands.push({ root: sys.env.HARNESS_UNREAL_ROOT, source: 'HARNESS_UNREAL_ROOT' });
  if (sys.platform === 'win32') {
    const dat = await sys.readFile('C:\\ProgramData\\Epic\\UnrealEngineLauncher\\LauncherInstalled.dat');
    if (dat) cands.push(...launcherRoots(dat));
    for (const r of parseRegQuery(await sys.regQuery('HKLM\\SOFTWARE\\EpicGames\\Unreal Engine'))) {
      if (r.name === 'InstalledDirectory') cands.push({ root: r.value, source: 'registry', association: r.key.split('\\').pop() });
    }
    for (const r of parseRegQuery(await sys.regQuery('HKCU\\SOFTWARE\\Epic Games\\Unreal Engine\\Builds'))) {
      cands.push({ root: r.value.replace(/\//g, '\\'), source: 'registry (custom build)', association: r.name });
    }
  }
  for (const root of commonRoots(sys.platform, sys.env, sys.listDir)) cands.push({ root, source: 'folder' });
  const seen = new Map();
  for (const c of cands) {
    const root = c.root.replace(/[\\/]+$/, '');
    const key = sys.platform === 'win32' ? root.toLowerCase().replace(/\//g, '\\') : root;
    const known = seen.get(key);
    if (known) { if (!known.association && c.association) known.association = c.association; continue; }
    const bins = binaries(root, sys.platform);
    if (!await sys.exists(bins.editor)) continue;
    const ver = parseBuildVersion(await sys.readFile(path.join(root, 'Engine', 'Build', 'Build.version')));
    const plugin = (rel) => sys.exists(path.join(root, 'Engine', 'Plugins', ...rel.split('/')));
    const inst = {
      root, source: c.source, association: c.association ?? null,
      version: ver?.version ?? null, changelist: ver?.changelist ?? null,
      binaries: bins,
      installedBuild: await sys.exists(path.join(root, 'Engine', 'Build', 'InstalledBuild.txt')),
      precompiledGame: await sys.exists(bins.game),
      uat: await sys.exists(bins.uat),
      plugins: {
        python: await plugin('Experimental/PythonScriptPlugin/PythonScriptPlugin.uplugin'),
        remoteControl: await plugin('VirtualProduction/RemoteControl/RemoteControl.uplugin'),
        movieRenderQueue: await plugin('MovieScene/MovieRenderPipeline/MovieRenderPipeline.uplugin'),
        interchange: await plugin('Interchange/Runtime/Interchange.uplugin'),
      },
      templates: (sys.listDir(path.join(root, 'Templates')) ?? []).filter((t) => /^TP_/.test(t)),
    };
    seen.set(key, inst);
  }
  return [...seen.values()].sort((a, b) => String(b.version ?? '').localeCompare(String(a.version ?? ''), 'en', { numeric: true }));
}

/** The C++ toolchain: Visual Studio with the MSVC x64 tools (vswhere), or clang on Linux/macOS. */
export async function findCompiler(sys) {
  if (sys.platform === 'win32') {
    const out = await sys.vswhere?.();
    const paths = String(out ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return paths.length ? { found: true, what: 'MSVC', path: paths[0] } : { found: false, what: 'MSVC' };
  }
  const clang = await sys.which?.(sys.platform === 'darwin' ? 'xcrun' : 'clang++');
  return clang ? { found: true, what: sys.platform === 'darwin' ? 'Xcode' : 'clang', path: clang } : { found: false, what: sys.platform === 'darwin' ? 'Xcode' : 'clang' };
}

/** Everything the actions need to know, as the contract's DetectReport plus the installs and the gaps in words. */
export async function detect(sys, { projectDir } = {}) {
  const installs = await findInstalls(sys);
  // HARNESS_UNREAL_ROOT names the one to use; else the newest with Python.
  const best = installs.find((i) => i.source === 'HARNESS_UNREAL_ROOT') ?? installs.find((i) => i.plugins.python) ?? installs[0];
  const gaps = [];
  const notes = [];
  if (!best) {
    return {
      engine: 'unreal', installed: false, gaps: ['Unreal Engine is not installed (or not found): install it with the Epic Games Launcher, or set HARNESS_UNREAL_ROOT to the folder that holds Engine/'],
      actions: ['detect'], installs: [],
    };
  }
  const compiler = await findCompiler(sys);
  if (!compiler.found) {
    gaps.push(sys.platform === 'win32'
      ? 'no MSVC: Visual Studio 2022 with the "Game development with C++" workload is not installed, so C++ projects and C++ plugins cannot compile. Blueprint and Python projects work, and package with the precompiled game binary.'
      : `no ${compiler.what}: C++ projects cannot compile; Blueprint and Python projects work.`);
  }
  if (!best.plugins.python) gaps.push('the Python Editor Script Plugin is not in this engine: editor scripting (script, describe, project.create setups) is unavailable');
  if (!best.plugins.remoteControl) gaps.push('the Remote Control plugin is not in this engine: no live bridge');
  if (!best.plugins.movieRenderQueue) notes.push('Movie Render Queue is not in this engine: render uses scene captures only');
  if (!best.precompiledGame) gaps.push('no precompiled UnrealGame binary: Blueprint projects need a compiler to package');
  const free = await sys.freeBytes?.(projectDir ?? best.root);
  const freeGb = free == null ? null : Math.round(free / 1e9);
  if (freeGb != null && freeGb < MIN_FREE_GB) gaps.push(`low disk space: ${freeGb} GB free where projects go (a project with a cooked Win64 build takes 3-10 GB; the first cook fills the shared DDC with a few GB more)`);
  const actions = ['detect', 'project.create', 'describe', 'script', 'capture', 'test', 'asset.import', 'asset.export', 'play', 'play.start', 'play.step', 'play.state', 'play.stop', 'jobs'];
  if (best.uat && best.precompiledGame) actions.push('build', 'package');
  if (best.plugins.movieRenderQueue) actions.push('render');
  if (best.plugins.remoteControl) actions.push('bridge.connect', 'bridge.status', 'bridge.call', 'bridge.property', 'bridge.python', 'bridge.presets', 'bridge.disconnect');
  return {
    engine: 'unreal', installed: true, version: best.version, path: best.root, source: 'host', gaps, notes, actions,
    compiler, freeGb,
    installs: installs.map((i) => ({ root: i.root, version: i.version, source: i.source, association: i.association, installedBuild: i.installedBuild, plugins: i.plugins, templates: i.templates.filter((t) => /BP$/.test(t)) })),
  };
}

const run = (file, args) => new Promise((resolve) => execFile(file, args, { windowsHide: true, timeout: 20_000 }, (err, stdout) => resolve(err && !stdout ? null : stdout)));

/** The real `sys` for this machine. */
export function hostSys(env = process.env) {
  return {
    platform: process.platform,
    env,
    exists: (p) => fsp.access(p).then(() => true, () => false),
    readFile: (p) => fsp.readFile(p, 'utf8').catch(() => null),
    listDir: (p) => { try { return fs.readdirSync(p); } catch { return []; } },
    regQuery: (key) => (process.platform === 'win32' ? run('reg', ['query', key, '/s']) : Promise.resolve(null)),
    vswhere: async () => {
      const exe = path.win32.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
      if (!await fsp.access(exe).then(() => true, () => false)) return null;
      return run(exe, ['-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath']);
    },
    which: async (name) => (await run(process.platform === 'win32' ? 'where' : 'which', [name]))?.split(/\r?\n/)[0]?.trim() || null,
    freeBytes: async (p) => {
      try { const s = await fsp.statfs(p); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
    },
    homedir: os.homedir(),
  };
}
