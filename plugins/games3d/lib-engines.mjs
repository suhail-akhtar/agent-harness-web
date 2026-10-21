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
    const r = await host.exec(probeScript(name, host.shell), { timeoutMs: 30_000, signal });
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

/** Reads a workspace file the runtime wrote (a companion's through the server's mirror of the folder). */
export async function readIn(host, rel, signal) {
  const root = host.kind === 'companion' ? await host.mirror?.(signal) : host.root;
  if (!root) throw new Error('this companion cannot send files to the server');
  return fsp.readFile(path.join(root, rel));
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
  const r = await host.exec(cmd, { timeoutMs, signal });
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

/** On Linux without a display, frames are drawn on Xvfb when it is installed. */
export function withDisplay(host) {
  if (host.platform !== 'linux' || host.shell === 'powershell') return undefined;
  return (cmd) => `if [ -z "\${DISPLAY:-}" ] && command -v xvfb-run >/dev/null 2>&1; then xvfb-run -a -s '-screen 0 1280x720x24' ${cmd}; else ${cmd}; fi`;
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

export const newId = () => crypto.randomUUID().slice(0, 8);
