// Blender and Godot for the games3d plugin. They run where the session's
// commands run - the Docker sandbox, a server folder, or the companion on the
// user's computer - so they are looked for there: on the server with the
// visual plugin's finder (PATH, install folders, HARNESS_BLENDER/HARNESS_GODOT),
// elsewhere with a probe run through host.exec.

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { findBinary, installPlaces, missingMessage, pathNames } from '../visual/lib/binaries.mjs';
import { PathError, resolveIn } from '../../src/tools/paths.ts';

export const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', '.harness', 'dist', 'build', 'coverage', '.venv', 'venv', '__pycache__', 'target']);

// ---------- commands ----------

/** One argument as a word for the host's shell. */
export function quote(s, shell) {
  const v = String(s);
  if (shell === 'powershell') return `'${v.replace(/'/g, "''")}'`;
  return /^[\w@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, "'\\''")}'`;
}

/** A command line for the host's shell (PowerShell needs & to run a quoted path). */
export function commandLine(bin, args, shell) {
  const words = args.map((a) => quote(a, shell)).join(' ');
  return shell === 'powershell' ? `& ${quote(bin, shell)} ${words}` : `${quote(bin, shell)} ${words}`;
}

/** The probe run inside a runtime: the override, the PATH, then the usual places. Prints the path. */
export function probeScript(name, shell) {
  const env = `HARNESS_${name.toUpperCase()}`;
  const names = pathNames(name);
  if (shell === 'powershell') {
    return `$c = @($env:${env}) + @(Get-Command ${names.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { $_.Source }) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1; if ($c) { $c } else { exit 1 }`;
  }
  const places = [...installPlaces(name, 'linux'), ...installPlaces(name, 'darwin')];
  const lines = [`for c in "\${${env}:-}" ${[...names, ...places].map((p) => quote(p, 'bash')).join(' ')}; do [ -n "$c" ] && command -v "$c" 2>/dev/null && exit 0; done`];
  // Godot is often only on the PATH under its download name (Godot_v4.x-stable_linux.x86_64).
  if (name === 'godot') lines.push(`c=$(compgen -c | grep -i '^godot_v4' | grep -viE '\\.(zip|tpz)$' | sort -r | head -n 1); [ -n "$c" ] && command -v "$c" && exit 0`);
  // A companion on Windows with Git Bash: the installer's folder is rarely on the PATH.
  if (name === 'blender') lines.push(`for c in "/c/Program Files/Blender Foundation/"Blender*/blender.exe; do [ -x "$c" ] && echo "$c" && exit 0; done`);
  return [...lines, 'exit 1'].join('\n');
}

/**
 * A command in the runtime. A companion runs commands for the server's tools
 * (these, like the quality gates) only when it was started with --allow-hooks;
 * its refusal is said in those terms.
 */
export async function execIn(host, cmd, opts) {
  try { return await host.exec(cmd, opts); } catch (e) {
    if (host.kind === 'companion' && /--allow-hooks/.test(e.message)) throw new Error('The blender and godot tools run Blender and Godot on the companion\'s computer, which it allows only when started with --allow-hooks (as for the quality gates). Ask the user to restart the companion with --allow-hooks.');
    throw e;
  }
}

const found = new WeakMap();

/**
 * Where Blender or Godot is in the session's runtime, or null. A server
 * folder runs commands on the server, so the server's finder answers; a
 * sandbox or companion is asked through host.exec. Only hits are remembered:
 * an agent may install the program later in the session.
 */
export async function locate(host, name, signal, find = findBinary) {
  let m = found.get(host);
  if (!m) found.set(host, (m = new Map()));
  if (m.has(name)) return m.get(name);
  let bin = null;
  if (host.kind === 'local') bin = find(name);
  else {
    const r = await execIn(host, probeScript(name, host.shell), { timeoutMs: 30_000, signal });
    bin = r.code === 0 ? r.stdout.trim().split(/\r?\n/).pop()?.trim() || null : null;
  }
  if (bin) m.set(name, bin);
  return bin;
}

/** Why a program is not there, and how to get it, for this kind of runtime. */
export function missingIn(host, name) {
  const what = name === 'blender' ? 'Blender' : 'Godot 4';
  if (host.kind === 'docker') return `${what} is not installed in this sandbox. Use the 3D sandbox image: the operator builds it (npm run sandbox:image:3d), allows it with HARNESS_SANDBOX_IMAGES=harness-sandbox-3d:latest, and a new session picks it.`;
  return missingMessage(name, host.platform) + (host.kind === 'companion' ? ' (on the computer the companion runs on)' : '');
}

// ---------- paths ----------

/** A workspace path from the model, as a path relative to the workspace (forward slashes). Throws outside it. */
export async function relIn(host, p) {
  if (host.kind === 'companion') {
    // The folder is on the user's computer: a lexical check (commands there run in it anyway).
    const posix = String(p ?? '').replace(/\\/g, '/');
    const disp = host.displayRoot.replace(/\\/g, '/').replace(/\/$/, '');
    const rel = path.posix.normalize(posix === disp ? '.' : posix.startsWith(disp + '/') ? posix.slice(disp.length + 1) : posix);
    if (!posix.trim() || path.posix.isAbsolute(rel) || /^[a-z]:/i.test(rel) || rel === '..' || rel.startsWith('../')) throw new PathError(`${p} is outside the workspace (${host.displayRoot})`);
    return rel;
  }
  const real = await resolveIn(host, String(p ?? ''));
  return path.relative(await fsp.realpath(host.root), real).split(path.sep).join('/') || '.';
}

/** The absolute path of a workspace file as the runtime sees it (/workspace/... in the sandbox). */
export function runtimePath(host, rel) {
  const base = host.displayRoot.replace(/\\/g, '/').replace(/\/$/, '');
  return rel === '.' ? base : `${base}/${rel}`;
}

/** Writes a helper file into the workspace (through the companion when the folder is on the user's computer). */
export async function writeIn(host, rel, data, signal) {
  if (host.kind === 'companion') {
    if (!host.pushFile) throw new Error('this companion cannot receive files: update it (download it again from the web app)');
    return host.pushFile(rel, Buffer.from(data), signal);
  }
  const file = path.join(host.root, rel);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, data);
}

/**
 * Reads a workspace file the runtime wrote. A companion sends that one file
 * (its mirror skips .harness, where frames and temporary files go); an older
 * companion without file reads falls back to the mirror.
 */
export async function readIn(host, rel, signal) {
  if (host.kind === 'companion' && host.readFile) {
    const data = await host.readFile(rel, signal);
    if (!data) throw Object.assign(new Error(`${rel} not found`), { code: 'ENOENT' });
    return data;
  }
  const root = host.kind === 'companion' ? await host.mirror?.(signal) : host.root;
  if (!root) throw new Error('this companion cannot send files to the server');
  return fsp.readFile(path.join(root, rel));
}

/** A workspace file's text, or null when it is not there. */
export async function readTextIn(host, rel, signal) {
  try { return (await readIn(host, rel, signal)).toString('utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

/** Runs a small file command on a companion in its own shell; throws with its output on failure. */
async function companionShell(host, bash, powershell, signal) {
  const r = await execIn(host, host.shell === 'powershell' ? powershell : bash, { timeoutMs: 60_000, signal });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `exit ${r.code}`);
  return r.stdout;
}

/** Makes a folder in the workspace (with the companion's shell when the folder is on the user's computer). */
export async function mkdirIn(host, rel, signal) {
  if (rel === '.' || !rel) return;
  if (host.kind !== 'companion') { await fsp.mkdir(path.join(host.root, rel), { recursive: true }); return; }
  await companionShell(host, `mkdir -p ${quote(rel, 'bash')}`, `New-Item -ItemType Directory -Force -Path ${quote(rel, 'powershell')} | Out-Null`, signal);
}

/** The names in a workspace folder ([] when it is not there). */
export async function listIn(host, rel, signal) {
  if (host.kind !== 'companion') return fsp.readdir(path.join(host.root, rel)).catch(() => []);
  const out = await companionShell(host, `ls -1A ${quote(rel, 'bash')} 2>/dev/null || true`, `if (Test-Path -LiteralPath ${quote(rel, 'powershell')}) { Get-ChildItem -Name -LiteralPath ${quote(rel, 'powershell')} }`, signal);
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** Removes a workspace folder and what is in it. */
export async function removeIn(host, rel, signal) {
  if (host.kind !== 'companion') { await fsp.rm(path.join(host.root, rel), { recursive: true, force: true }); return; }
  await companionShell(host, `rm -rf ${quote(rel, 'bash')}`, `Remove-Item -Recurse -Force -LiteralPath ${quote(rel, 'powershell')} -ErrorAction SilentlyContinue`, signal);
}

/** Files under the workspace with one of these names or extensions, skipping dependencies and build output. */
export async function findFiles(root, match, { max = 8, depth = 4, rel = '' } = {}) {
  const out = [];
  let entries = [];
  try { entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (out.length >= max) break;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (depth > 0 && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) out.push(...await findFiles(root, match, { max: max - out.length, depth: depth - 1, rel: r })); }
    else if (match(e.name)) out.push(r);
  }
  return out;
}

/** The same search on a companion's folder, by a glob on the user's computer. */
export async function findRemote(host, glob, match, signal) {
  if (!host.remoteTool) return [];
  const r = await host.remoteTool('glob', { pattern: glob }, signal);
  if (r.is_error || /^No files match/.test(r.content)) return [];
  return r.content.split('\n').map((l) => l.trim().replace(/\\/g, '/'))
    .filter((l) => l && match(path.posix.basename(l)) && l.split('/').slice(0, -1).every((d) => d && !SKIP_DIRS.has(d) && !d.startsWith('.')));
}

// ---------- output ----------

export const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** The last lines of a command's output, where errors and results are. */
export function tail(text, lines = 60, chars = 5000) {
  const t = stripAnsi(text).replace(/\r/g, '').trimEnd().split('\n').slice(-lines).join('\n');
  return t.length > chars ? `...${t.slice(-chars)}` : t;
}

const millis = (t0) => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

/** Runs one program in the runtime: exit code, time and combined output. */
export async function runIn(host, bin, args, { timeoutMs, signal, prefix }) {
  const t0 = Date.now();
  const cmd = prefix ? prefix(commandLine(bin, args, host.shell)) : commandLine(bin, args, host.shell);
  const r = await execIn(host, cmd, { timeoutMs, signal });
  return { ...r, output: stripAnsi(`${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`), took: millis(t0) };
}

// ---------- Blender ----------

/**
 * blender -b [file.blend] --python script -- args. Factory settings: the
 * user's add-ons and preferences cannot change the result. A Python error
 * makes Blender exit 1 (it exits 0 by default).
 */
export function blenderArgs({ script, file, args = [] }) {
  return ['-b', '--factory-startup', '-noaudio', ...(file ? [file] : []), '--python-exit-code', '1', '--python', script, ...(args.length ? ['--', ...args.map(String)] : [])];
}

/** Opens a .blend and confirms it loaded (Blender carries on with an empty scene when a file does not). */
export const BLEND_CHECK = "import bpy, sys; ok = bool(bpy.data.filepath); print('HARNESS_BLEND', 'OK' if ok else 'NOT-LOADED', len(bpy.data.objects), 'objects'); sys.exit(0 if ok else 3)";
export const blendCheckArgs = (file) => ['-b', '--factory-startup', '-noaudio', file, '--python-exit-code', '1', '--python-expr', BLEND_CHECK];

// ---------- Godot ----------

/** Loads every script and scene, so parse errors and broken references print. Run with --script. */
export const GODOT_CHECK = `extends SceneTree
# Written by the harness: loads every script and scene in the project so that
# parse errors and missing resources are printed. Safe to delete.

func _init() -> void:
	var files: Array[String] = []
	_walk("res://", files)
	for f in files:
		ResourceLoader.load(f, "", ResourceLoader.CACHE_MODE_IGNORE)
	print("HARNESS_CHECKED ", files.size())
	quit()

func _walk(dir: String, out: Array[String]) -> void:
	for d in DirAccess.get_directories_at(dir):
		if not d.begins_with(".") and d != "addons":
			_walk(dir.path_join(d), out)
	for f in DirAccess.get_files_at(dir):
		if f.get_extension() in ["gd", "tscn", "tres", "scn"]:
			out.append(dir.path_join(f))
`;
export const GODOT_CHECK_FILE = '.godot/harness/check.gd';

/** A scene to run: res://... as given, a project-relative path made res://. */
export function sceneArg(scene) {
  if (!scene) return [];
  const s = String(scene).replace(/\\/g, '/');
  return [s.startsWith('res://') ? s : `res://${s.replace(/^\.\//, '')}`];
}

/** The game's own arguments (OS.get_cmdline_user_args()), e.g. --selftest or --demo. */
const userArgs = (args) => (Array.isArray(args) && args.length ? ['--', ...args.map(String)] : []);

/** Godot's command line for each step. project is the folder with project.godot. */
export function godotArgs(step, o) {
  const p = ['--path', o.project];
  switch (step) {
    case 'import': return ['--headless', ...p, '--import'];
    case 'check': return ['--headless', ...p, '--script', `res://${GODOT_CHECK_FILE}`];
    case 'run': return ['--headless', ...p, '--fixed-fps', '60', '--quit-after', String(o.frames), ...sceneArg(o.scene), ...userArgs(o.args)];
    // A real (virtual) display and the OpenGL renderer: llvmpipe draws it on the CPU.
    case 'screenshot': return [...p, '--rendering-driver', 'opengl3', '--rendering-method', 'gl_compatibility', '--audio-driver', 'Dummy', '--fixed-fps', '60', '--write-movie', o.movie, '--quit-after', String(o.frames), ...sceneArg(o.scene), ...userArgs(o.args)];
    case 'export': return ['--headless', ...p, `--export-${o.debug ? 'debug' : 'release'}`, o.preset, o.output];
    default: throw new Error(`unknown step ${step}`);
  }
}

// ---------- export presets ----------

/** The presets the tool can write when asked (createPreset): the name, Godot's platform, a default output. */
export const PRESET_KINDS = {
  linux: { name: 'Linux', platform: 'Linux', output: 'build/linux/game.x86_64' },
  web: { name: 'Web', platform: 'Web', output: 'build/web/index.html' },
};

/** The presets in an export_presets.cfg: index, name and platform. */
export function presetsIn(cfg) {
  const out = [];
  let cur;
  for (const line of String(cfg ?? '').replace(/\r/g, '').split('\n')) {
    const sec = /^\s*\[preset\.(\d+)\]\s*$/.exec(line);
    if (sec) { cur = { index: Number(sec[1]), name: '', platform: '' }; out.push(cur); continue; }
    if (/^\s*\[/.test(line)) { cur = undefined; continue; }
    const kv = /^\s*(name|platform)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/.exec(line);
    if (cur && kv) cur[kv[1]] = kv[2].replace(/\\(.)/g, '$1');
  }
  return out;
}

const cfgString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * A minimal preset section for Linux (x86_64, the .pck beside the binary) or
 * the Web (no threads, so it runs from any static server without
 * cross-origin isolation headers). Options left out take Godot's defaults.
 */
export function minimalPreset(kind, index, name, exportPath) {
  const k = PRESET_KINDS[kind];
  if (!k) throw new Error(`unknown preset kind ${kind}`);
  const options = kind === 'linux'
    ? ['binary_format/embed_pck=false', 'binary_format/architecture="x86_64"']
    : ['variant/extensions_support=false', 'variant/thread_support=false', 'vram_texture_compression/for_desktop=true', 'vram_texture_compression/for_mobile=false'];
  return [
    `[preset.${index}]`, '',
    `name=${cfgString(name)}`, `platform=${cfgString(k.platform)}`, 'runnable=true', 'dedicated_server=false', 'custom_features=""',
    'export_filter="all_resources"', 'include_filter=""', 'exclude_filter=""', `export_path=${cfgString(exportPath)}`, '',
    `[preset.${index}.options]`, '', ...options, '',
  ].join('\n');
}

/** export_presets.cfg with a minimal preset added (a new file when there is none). */
export function withPreset(cfg, kind, name, exportPath) {
  const next = Math.max(-1, ...presetsIn(cfg).map((p) => p.index)) + 1;
  const head = cfg && cfg.trim() ? `${cfg.replace(/\s*$/, '')}\n\n` : '';
  return head + minimalPreset(kind, next, name, exportPath);
}

/**
 * On Linux without a display, frames are drawn on Xvfb when it is installed: through
 * xvfb-run when xauth is there too (xvfb-run needs it), else on an Xvfb started here
 * on a free display number and stopped afterwards.
 */
export function withDisplay(host) {
  if (host.platform !== 'linux' || host.shell === 'powershell') return undefined;
  return (cmd) => [
    'if [ -n "${DISPLAY:-}" ]; then', `  ${cmd}`,
    'elif command -v xvfb-run >/dev/null 2>&1 && command -v xauth >/dev/null 2>&1; then', `  xvfb-run -a -s '-screen 0 1280x720x24' ${cmd}`,
    'elif command -v Xvfb >/dev/null 2>&1; then',
    '  n=99; while [ -e "/tmp/.X$n-lock" ] && [ $n -lt 199 ]; do n=$((n+1)); done',
    '  Xvfb ":$n" -screen 0 1280x720x24 -nolisten tcp >/dev/null 2>&1 & xvfb_pid=$!',
    '  for i in 1 2 3 4 5 6 7 8 9 10; do [ -e "/tmp/.X11-unix/X$n" ] && break; sleep 0.2; done',
    `  DISPLAY=":$n" ${cmd}; rc=$?; kill $xvfb_pid 2>/dev/null; wait $xvfb_pid 2>/dev/null; (exit $rc)`,
    'else', `  ${cmd}`, 'fi',
  ].join('\n');
}

/** Errors Godot printed (script errors with where they happened); its exit code stays 0 for most of them. */
export function godotProblems(output) {
  const lines = stripAnsi(output).replace(/\r/g, '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!/^(USER )?(SCRIPT )?ERROR:/.test(l)) continue;
    // Shutdown bookkeeping, not the project's fault.
    if (/still in use at exit|leaked at exit/i.test(l)) continue;
    // Where: the first line of the trace that names a project file (push_error's "at:" is Godot's own C++).
    const trace = [];
    for (let j = i + 1; j < lines.length && /^(at:|GDScript backtrace|\[\d+\])/.test(lines[j].trim()); j++) trace.push(lines[j].trim());
    const at = (trace.find((x) => x.includes('res://')) ?? trace.find((x) => x.startsWith('at:')))?.replace(/^\[\d+\]\s*/, 'at: ');
    const item = at ? `${l} (${at})` : l;
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

/** Imports the project, then loads every script and scene: the problems found. */
export async function checkGodot(host, bin, project, signal) {
  const imp = await runIn(host, bin, godotArgs('import', { project }), { timeoutMs: 300_000, signal });
  if (imp.timedOut) return { problems: ['the import timed out after 5 minutes'], output: imp.output };
  await writeIn(host, project === '.' ? GODOT_CHECK_FILE : `${project}/${GODOT_CHECK_FILE}`, GODOT_CHECK, signal);
  const chk = await runIn(host, bin, godotArgs('check', { project }), { timeoutMs: 180_000, signal });
  const checked = Number(/HARNESS_CHECKED (\d+)/.exec(chk.output)?.[1] ?? NaN);
  const problems = [...godotProblems(imp.output), ...godotProblems(chk.output)];
  if (imp.code !== 0 && !problems.length) problems.push(`the import exited ${imp.code}`);
  if (chk.timedOut) problems.push('the script check timed out');
  else if (Number.isNaN(checked) && !problems.length) problems.push(`the script check did not finish (exit ${chk.code})`);
  return { problems, checked, output: `${imp.output}\n${chk.output}` };
}

/** Frames a self-test may take (ten seconds of game time); it may quit sooner. */
export const SELFTEST_FRAMES = 600;

/**
 * Runs a project's scripted self-test (the game's --selftest mode, see
 * godot-essentials): it passes when the game printed SELFTEST PASS and
 * reported no errors. Imports first, so a fresh project's resources load.
 */
export async function selftestGodot(host, bin, project, signal, frames = SELFTEST_FRAMES) {
  const imp = await runIn(host, bin, godotArgs('import', { project }), { timeoutMs: 300_000, signal });
  if (imp.timedOut) return { problems: ['the import timed out after 5 minutes'], output: imp.output };
  const r = await runIn(host, bin, godotArgs('run', { project, frames, args: ['--selftest'] }), { timeoutMs: 300_000, signal });
  const problems = godotProblems(r.output);
  const passed = /SELFTEST PASS/.test(r.output);
  if (r.timedOut) problems.push(`the self-test did not finish in 5 minutes (${frames} frames)`);
  else if (!passed && !problems.length) problems.push(`the self-test never printed SELFTEST PASS in ${frames} frames (exit ${r.code}): give the game a --selftest mode that drives it and prints SELFTEST PASS when every check holds (godot-essentials)`);
  return { problems, passed: passed && !problems.length, output: r.output, took: r.took };
}

export const newId = () => crypto.randomUUID().slice(0, 8);
