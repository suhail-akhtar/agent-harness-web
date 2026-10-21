import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runGates } from '../src/gates/gates.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { LocalHost, resolveShell } from '../src/runtime/host.ts';
import { tempDir } from './helpers.ts';

// Native Windows is exercised here with stubbed platforms, environments and file
// systems: this suite runs on Linux, so it proves the choices, not the binaries.

const here = path.dirname(fileURLToPath(import.meta.url));
// @ts-expect-error plain JS module
const { findBinary, missingMessage } = await import('../plugins/visual/lib/binaries.mjs');

const only = (...paths: string[]) => { const set = new Set(paths.map((p) => p.toLowerCase())); return (p: string) => set.has(p.toLowerCase()); };

test('shell: Git Bash on Windows, never the WSL bash in System32; PowerShell as the fallback; HARNESS_SHELL wins', () => {
  assert.deepEqual(resolveShell('linux', {}, () => false), { kind: 'bash', path: 'bash', why: 'default' });
  const env = { ProgramFiles: 'C:\\Program Files', Path: 'C:\\Windows\\System32;C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps' };
  const git = 'C:\\Program Files\\Git\\bin\\bash.exe';
  assert.equal(resolveShell('win32', env, only(git)).path, git);
  // Only the WSL launchers exist: they are not used.
  const wsl = only('C:\\Windows\\System32\\bash.exe', 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe');
  assert.equal(resolveShell('win32', env, wsl).kind, 'powershell');
  // A bash on the PATH that is not WSL (e.g. MSYS2) is fine.
  assert.equal(resolveShell('win32', { Path: 'C:\\msys64\\usr\\bin' }, only('C:\\msys64\\usr\\bin\\bash.exe')).path, 'C:\\msys64\\usr\\bin\\bash.exe');
  assert.equal(resolveShell('win32', { ...env, HARNESS_SHELL: 'powershell' }, only(git)).kind, 'powershell');
  assert.equal(resolveShell('win32', { HARNESS_SHELL: 'D:\\tools\\bash.exe' }, only('D:\\tools\\bash.exe')).path, 'D:\\tools\\bash.exe');
});

test('converters: found on the PATH, in the usual Windows and macOS install folders, or by override; missing ones say how to install', () => {
  const none = () => [];
  assert.equal(findBinary('pdftoppm', { platform: 'linux', env: { PATH: '/usr/bin' }, exists: only('/usr/bin/pdftoppm'), listDir: none }), '/usr/bin/pdftoppm');
  const soffice = 'C:\\Program Files\\LibreOffice\\program\\soffice.exe';
  assert.equal(findBinary('soffice', { platform: 'win32', env: { ProgramFiles: 'C:\\Program Files', Path: 'C:\\Windows' }, exists: only(soffice), listDir: none }), soffice);
  // PATHEXT: pandoc.EXE on the PATH.
  assert.equal(findBinary('pandoc', { platform: 'win32', env: { Path: 'C:\\bin', PATHEXT: '.COM;.EXE' }, exists: only('C:\\bin\\pandoc.exe'), listDir: none }), 'C:\\bin\\pandoc.exe');
  // poppler from winget lives in a versioned folder.
  const local = 'C:\\Users\\me\\AppData\\Local';
  const pkgs = `${local}\\Microsoft\\WinGet\\Packages`;
  const pkg = `${pkgs}\\oschwartz10612.Poppler_Microsoft.Winget.Source_8wekyb3d8bbwe`;
  const listDir = (d: string) => (d === pkgs ? ['oschwartz10612.Poppler_Microsoft.Winget.Source_8wekyb3d8bbwe'] : d === pkg ? ['poppler-24.08.0'] : []);
  const pdftoppm = `${pkg}\\poppler-24.08.0\\Library\\bin\\pdftoppm.exe`;
  assert.equal(findBinary('pdftoppm', { platform: 'win32', env: { LOCALAPPDATA: local, Path: '' }, exists: only(pdftoppm), listDir }), pdftoppm);
  assert.equal(findBinary('soffice', { platform: 'darwin', env: { PATH: '/usr/bin' }, exists: only('/Applications/LibreOffice.app/Contents/MacOS/soffice'), listDir: none }), '/Applications/LibreOffice.app/Contents/MacOS/soffice');
  assert.equal(findBinary('soffice', { platform: 'win32', env: { HARNESS_SOFFICE: 'E:\\lo\\soffice.exe' }, exists: () => false, listDir: none }), 'E:\\lo\\soffice.exe');
  assert.equal(findBinary('soffice', { platform: 'win32', env: { Path: 'C:\\Windows' }, exists: () => false, listDir: none }), null);
  assert.match(missingMessage('pdftoppm', 'win32'), /poppler is not installed.*winget install.*HARNESS_PDFTOPPM/);
  assert.match(missingMessage('soffice', 'darwin'), /LibreOffice.*brew install --cask libreoffice/);
});

test('blender and godot: found by override, on the PATH (godot4, Godot_v4.x downloads), and in the Windows, macOS and Linux install folders', () => {
  const none = () => [];
  // Windows: the installer's versioned folder, newest version first.
  const bf = 'C:\\Program Files\\Blender Foundation';
  const listBf = (d: string) => (d === bf ? ['Blender 3.6', 'Blender 4.10', 'Blender 4.2'] : []);
  const b42 = `${bf}\\Blender 4.2\\blender.exe`;
  const b410 = `${bf}\\Blender 4.10\\blender.exe`;
  const winEnv = { ProgramFiles: 'C:\\Program Files', Path: 'C:\\Windows' };
  assert.equal(findBinary('blender', { platform: 'win32', env: winEnv, exists: only(b42, `${bf}\\Blender 3.6\\blender.exe`), listDir: listBf }), b42);
  assert.equal(findBinary('blender', { platform: 'win32', env: winEnv, exists: only(b42, b410), listDir: listBf }), b410);
  assert.equal(findBinary('blender', { platform: 'win32', env: { HARNESS_BLENDER: 'D:\\b\\blender.exe' }, exists: () => false, listDir: none }), 'D:\\b\\blender.exe');
  assert.equal(findBinary('blender', { platform: 'linux', env: { PATH: '/usr/bin' }, exists: only('/opt/blender/blender'), listDir: none }), '/opt/blender/blender');
  assert.equal(findBinary('blender', { platform: 'linux', env: { PATH: '/usr/bin' }, exists: only('/usr/bin/blender', '/opt/blender/blender'), listDir: none }), '/usr/bin/blender');
  assert.equal(findBinary('blender', { platform: 'darwin', env: { PATH: '/usr/bin' }, exists: only('/Applications/Blender.app/Contents/MacOS/Blender'), listDir: none }), '/Applications/Blender.app/Contents/MacOS/Blender');
  assert.equal(findBinary('blender', { platform: 'win32', env: winEnv, exists: () => false, listDir: none }), null);

  // Godot: its alias, its download names on the PATH (newest, console build first, never the templates archive).
  assert.equal(findBinary('godot', { platform: 'linux', env: { PATH: '/usr/bin:/home/me/bin' }, exists: only('/home/me/bin/godot4'), listDir: none }), '/home/me/bin/godot4');
  const tools = ['Godot_v4.6-stable_win64.exe', 'Godot_v4.7.2-stable_win64.exe', 'Godot_v4.7.2-stable_win64_console.exe', 'Godot_v4.7.2-stable_export_templates.tpz'];
  assert.equal(findBinary('godot', { platform: 'win32', env: { Path: 'C:\\tools' }, exists: only(...tools.map((t) => `C:\\tools\\${t}`)), listDir: (d: string) => (d === 'C:\\tools' ? tools : []) }), 'C:\\tools\\Godot_v4.7.2-stable_win64_console.exe');
  assert.equal(findBinary('godot', { platform: 'linux', env: { PATH: '/opt/bin' }, exists: only('/opt/bin/Godot_v4.7.2-stable_linux.x86_64'), listDir: (d: string) => (d === '/opt/bin' ? ['Godot_v4.7.2-stable_linux.x86_64', 'Godot_v4.7.2-stable_linux.x86_64.zip'] : []) }), '/opt/bin/Godot_v4.7.2-stable_linux.x86_64');
  // winget keeps the portable download in its package folder.
  const local = 'C:\\Users\\me\\AppData\\Local';
  const pkgs = `${local}\\Microsoft\\WinGet\\Packages`;
  const pkg = `${pkgs}\\GodotEngine.GodotEngine_Microsoft.Winget.Source_8wekyb3d8bbwe`;
  const wingetGodot = `${pkg}\\Godot_v4.7.2-stable_win64.exe`;
  assert.equal(findBinary('godot', { platform: 'win32', env: { LOCALAPPDATA: local, Path: '' }, exists: only(wingetGodot), listDir: (d: string) => (d === pkgs ? ['GodotEngine.GodotEngine_Microsoft.Winget.Source_8wekyb3d8bbwe'] : d === pkg ? ['Godot_v4.7.2-stable_win64.exe'] : []) }), wingetGodot);
  assert.equal(findBinary('godot', { platform: 'darwin', env: { PATH: '/usr/bin' }, exists: only('/Applications/Godot.app/Contents/MacOS/Godot'), listDir: none }), '/Applications/Godot.app/Contents/MacOS/Godot');
  assert.equal(findBinary('godot', { platform: 'linux', env: { PATH: '/usr/bin' }, exists: only('/usr/local/bin/godot'), listDir: none }), '/usr/local/bin/godot');
  assert.equal(findBinary('godot', { platform: 'linux', env: { HARNESS_GODOT: '/x/godot' }, exists: () => false, listDir: none }), '/x/godot');
  assert.match(missingMessage('blender', 'win32'), /Blender is not installed.*winget install BlenderFoundation.*HARNESS_BLENDER/);
  assert.match(missingMessage('godot', 'linux'), /Godot 4 is not installed.*sandbox:image:3d.*HARNESS_GODOT/);
});

test('quality gates on a PowerShell host fail and say why, instead of all reading as "does not apply"', async () => {
  const h = await createHarness({ dataDir: await tempDir(), plugins: [path.join(here, '..', 'plugins', 'quality-gates')] });
  const host = new LocalHost(await tempDir());
  host.shell = 'powershell';
  const r = await runGates(h.registry, host, 'applicable', new AbortController().signal);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.pass, false);
  assert.match(r[0]!.details ?? '', /Git for Windows/);
  await h.close();
});

test('the npm launchers are plain node scripts (no inline env vars, which cmd and PowerShell cannot parse)', async () => {
  const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(here, '..', 'package.json'), 'utf8'));
  for (const [name, cmd] of Object.entries(pkg.scripts as Record<string, string>)) {
    assert.doesNotMatch(cmd, /(^|\s)[A-Z_]+=\S+\s/, `${name} sets an environment variable inline: ${cmd}`);
  }
  const out = execFileSync(process.execPath, [path.join(here, '..', 'scripts', 'run.mjs'), '--eval', 'console.log(process.env.NODE_USE_ENV_PROXY)'], { encoding: 'utf8' });
  assert.equal(out.trim(), '1');
});

test('the launcher reads keys from a .env file where it runs; variables already set win; no file is fine', async () => {
  const fsp = await import('node:fs/promises');
  const { tempDir } = await import('./helpers.ts');
  const dir = await tempDir();
  const run = (env: NodeJS.ProcessEnv) => execFileSync(process.execPath, [path.join(here, '..', 'scripts', 'run.mjs'), '--eval', 'console.log(process.env.HW_A, process.env.HW_B)'], { encoding: 'utf8', cwd: dir, env }).trim();
  const base = { ...process.env };
  delete base.HW_A; delete base.HW_B;
  assert.equal(run(base), 'undefined undefined');
  await fsp.writeFile(path.join(dir, '.env'), 'HW_A=from-file\nHW_B="quoted value"\n');
  assert.equal(run(base), 'from-file quoted value');
  assert.equal(run({ ...base, HW_A: 'from-env' }), 'from-env quoted value');
});
