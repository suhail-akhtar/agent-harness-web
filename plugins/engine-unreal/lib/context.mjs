// The project a call is about, the engine that runs it, and running editor Python on it.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId } from '@harness/plugins/games3d/lib-engines.mjs';
import { commandletPythonArgs, editorPythonArgs } from './args.mjs';
import { detect, hostSys } from './detect.mjs';
import { problemsIn, resultsIn } from './logs.mjs';
import { findUprojects } from './project.mjs';
import { runUE } from './run.mjs';

export const PY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'python');
/** The helper modules copied into each project's Content/Python (on the editor's sys.path). */
export const PY_FILES = ['harness_ue.py', 'harness_step.py', 'harness_capture_game.py'];

let cached = null;
/** The detect report, kept for a minute (an install does not move while a session runs). sysOverride for tests. */
export async function engineReport({ fresh = false, projectDir, sys } = {}) {
  if (!fresh && cached && Date.now() - cached.at < 60_000 && !sys) return cached.report;
  const report = await detect(sys ?? hostSys(), { projectDir });
  if (!sys) cached = { at: Date.now(), report };
  return report;
}

/** The install to use: HARNESS_UNREAL_ROOT's, else the newest with Python. */
export async function engine() {
  const r = await engineReport();
  if (!r.installed) return null;
  const root = r.path;
  const { binaries } = await import('./detect.mjs');
  return { root, version: r.version, association: r.installs.find((i) => i.root === root)?.association ?? null, bin: binaries(root, process.platform), report: r };
}

/** Workspace-relative (forward slashes) for an absolute path inside the workspace. */
export const relTo = (host, abs) => path.relative(host.root, abs).split(path.sep).join('/');

/**
 * The Unreal project of a call: the .uproject given (a file or a folder holding one, or a
 * Studio folder whose .studio/project.json names it), else the only one in the workspace.
 */
export async function projectOf(host, given) {
  let file;
  if (given) {
    const abs = path.resolve(host.root, String(given));
    const rel = relTo(host, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${given} is outside the workspace`);
    if (abs.endsWith('.uproject')) file = abs;
    else {
      const studio = await readJson(path.join(abs, '.studio', 'project.json'));
      if (studio?.engineProject) file = path.join(abs, studio.engineProject);
      else {
        const found = await findUprojects(abs, { max: 2, depth: 1 });
        if (found.length !== 1) throw new Error(found.length ? `${given} holds several .uproject files: ${found.join(', ')}` : `no .uproject in ${given}`);
        file = path.join(abs, found[0]);
      }
    }
  } else {
    const found = await findUprojects(host.root, { max: 6, depth: 3 });
    if (!found.length) throw new Error('no Unreal project (.uproject) in the workspace: make one with {"action": "project.create", "name": "MyGame"}');
    if (found.length > 1) throw new Error(`several Unreal projects in the workspace; say which with project: ${found.join(', ')}`);
    file = path.join(host.root, found[0]);
  }
  try { await fsp.access(file); } catch { throw new Error(`${relTo(host, file)} does not exist`); }
  const dir = path.dirname(file);
  const name = path.basename(file, '.uproject');
  // The Studio folder: the project's own folder or one above it holding .studio/project.json.
  let studioDir = null;
  for (let d = dir, i = 0; i < 3 && relTo(host, d) !== '..' && !relTo(host, d).startsWith('../'); i++, d = path.dirname(d)) {
    if (await exists(path.join(d, '.studio', 'project.json'))) { studioDir = d; break; }
    if (d === host.root) break;
  }
  return { file, dir, name, rel: relTo(host, file), studioDir, studioRel: studioDir ? relTo(host, studioDir) || '.' : null };
}

export const exists = (p) => fsp.access(p).then(() => true, () => false);
export async function readJson(p) { try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch { return null; } }
export async function writeJson(p, v) { await fsp.mkdir(path.dirname(p), { recursive: true }); await fsp.writeFile(p, `${JSON.stringify(v, null, 2)}\n`); }

/** Copies the helper modules into the project's Content/Python when they changed. */
export async function installHelpers(projectDir) {
  const to = path.join(projectDir, 'Content', 'Python');
  await fsp.mkdir(to, { recursive: true });
  for (const f of PY_FILES) {
    const src = await fsp.readFile(path.join(PY_DIR, f));
    const cur = await fsp.readFile(path.join(to, f)).catch(() => null);
    if (!cur || !cur.equals(src)) await fsp.writeFile(path.join(to, f), src);
  }
  return to;
}

/** Where a run's files go: <workspace>/.harness/unreal/<kind>/<id>... */
export async function runDir(host, kind) {
  const id = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')}-${newId().slice(0, 4)}`;
  const dir = path.join(host.root, '.harness', 'unreal', kind, id);
  await fsp.mkdir(dir, { recursive: true });
  return { id, dir, rel: relTo(host, dir) };
}

const pyStr = (s) => `r"""${String(s).replace(/"""/g, '\\"\\"\\"')}"""`;

/**
 * The wrapper the editor runs: the helpers on sys.path, the agent's file run as __main__ with
 * its own line numbers in tracebacks, an error reported as HARNESS_PROBLEM, HARNESS_DONE last.
 */
export function wrapperScript({ helperDir, userFile, args = [], keepAlive = false }) {
  return [
    '# Written by the harness (engine-unreal): runs the script below in the editor.',
    'import sys, runpy, traceback',
    `sys.path.insert(0, ${pyStr(helperDir.replace(/\\/g, '/'))})`,
    'import unreal',
    `sys.argv = [${pyStr(userFile.replace(/\\/g, '/'))}] + ${JSON.stringify(args.map(String))}`,
    ...(keepAlive ? ['unreal.EditorPythonScripting.set_keep_python_script_alive(True)'] : []),
    'try:',
    `    runpy.run_path(${pyStr(userFile.replace(/\\/g, '/'))}, run_name="__main__")`,
    'except SystemExit:',
    '    pass',
    'except Exception as e:',
    '    unreal.log_error(traceback.format_exc())',
    '    unreal.log_error("HARNESS_PROBLEM %s: %s" % (type(e).__name__, e))',
    'print("HARNESS_DONE")',
    '',
  ].join('\n');
}

/**
 * Runs Python in the editor, headless: code (or a workspace file) wrapped as above. mode
 * 'editor' (default: the whole editor, levels and subsystems) or 'commandlet'. rendering for
 * captures and renders. Returns { code, took, problems, results, output, logFile, failed }.
 */
export async function runPython(host, eng, proj, { code, file, args = [], mode = 'editor', rendering = false, keepAlive = false, timeoutMs = 600_000, signal, kind = 'script', onLine }) {
  const helperDir = await installHelpers(proj.dir);
  const rd = await runDir(host, kind);
  let userFile = file ? path.resolve(host.root, file) : path.join(rd.dir, 'script.py');
  if (!file) await fsp.writeFile(userFile, code);
  const wrapper = path.join(rd.dir, 'run.py');
  await fsp.writeFile(wrapper, wrapperScript({ helperDir, userFile, args, keepAlive }));
  const logFile = path.join(rd.dir, 'editor.log');
  const argv = mode === 'commandlet'
    ? commandletPythonArgs({ uproject: proj.file, script: wrapper, log: logFile })
    : editorPythonArgs({ uproject: proj.file, script: wrapper, log: logFile, rendering });
  const r = await runUE(host, eng.bin.editorCmd, argv, { timeoutMs, signal, onLine });
  const text = (await fsp.readFile(logFile, 'utf8').catch(() => '')) || r.output;
  const problems = problemsIn(text).map((p) => (p.file && p.file.replace(/\\/g, '/') === userFile.replace(/\\/g, '/') ? { ...p, file: file ? String(file) : `${rd.rel}/script.py` } : p));
  const results = resultsIn(text);
  const done = /HARNESS_DONE/.test(text);
  const fatal = problems.filter((p) => p.severity === 'error' && /^(Python:|LogPython|LogBlueprint|LogEditorPythonExecuter|Blueprint |check failed|[A-Z]\w+Error:)/.test(p.message));
  const failed = r.timedOut || r.code !== 0 || fatal.length > 0 || (!done && mode === 'editor');
  return { ...r, text, problems, fatal, results, done, logFile: relTo(host, logFile), dir: rd, failed };
}
