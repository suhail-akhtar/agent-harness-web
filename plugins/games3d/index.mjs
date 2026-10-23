// Games and 3D: agents, skills and workflows live in their folders; this adds
// the gltf-valid and model-preview gates (and a model_info tool) for exported
// models, and the blender and godot tools with their gates (blender-file,
// godot-project, godot-selftest).
// Blender and Godot run where the session's commands run, so in a sandbox
// they come from its image (docker/Dockerfile.sandbox-3d).

import fsp from 'node:fs/promises';
import path from 'node:path';
import { defineTool } from '../../src/plugins/api.ts';
import { resolveIn } from '../../src/tools/paths.ts';
import {
  blendCheckArgs, blenderArgs, checkGodot, findFiles, findRemote, godotArgs, godotProblems, listIn, locate, missingIn, mkdirIn,
  newId, PRESET_KINDS, presetsIn, readIn, readTextIn, relIn, removeIn, runIn, runtimePath, SELFTEST_FRAMES, selftestGodot, tail,
  withDisplay, withPreset, writeIn,
} from './lib-engines.mjs';
import { describeGltf, inspectGltf } from './lib-gltf.mjs';
import { pngStats } from './lib-png.mjs';
import { setupAssets } from './assets/index.mjs';
import { setupPlayer } from './player/index.mjs';

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const seconds = (v, def) => Math.min(Math.max(Number(v) || def, 10), 1800) * 1000;
const isBlend = (n) => /\.blend$/i.test(n);
const isProject = (n) => n === 'project.godot';
const isPng = (n) => /\.png$/i.test(n);

/** Images the agent asked to see after a run (a preview render), as tool images. */
async function showImages(host, list, signal) {
  const images = [];
  const notes = [];
  for (const p of (Array.isArray(list) ? list : []).slice(0, 4)) {
    const rel = await relIn(host, String(p));
    const type = IMAGE_TYPES[path.extname(rel).toLowerCase()];
    if (!type) { notes.push(`${rel}: not an image (png, jpg, webp)`); continue; }
    try {
      const data = await readIn(host, rel, signal);
      if (data.length > 5_000_000) notes.push(`${rel}: over 5 MB, not shown`);
      else images.push({ media_type: type, data: data.toString('base64') });
    } catch { notes.push(`${rel}: not found after the run`); }
  }
  return { images, notes };
}

/** Folders with a project.godot in the workspace (max 3). */
async function godotProjects(host, signal) {
  const files = host.kind === 'companion'
    ? await findRemote(host, '**/project.godot', isProject, signal)
    : await findFiles(host.root, isProject, { max: 3, depth: 3 });
  return files.slice(0, 3).map((f) => path.posix.dirname(f));
}

async function blendFiles(host, signal) {
  return host.kind === 'companion' ? (await findRemote(host, '**/*.blend', isBlend, signal)).slice(0, 8) : findFiles(host.root, isBlend, { max: 8 });
}

/** A gate cannot check without the program: it says so and does not fail the run. */
const notChecked = (host, name) => ({ pass: false, severity: 'advisory', summary: `not checked: ${name === 'blender' ? 'Blender' : 'Godot'} is not installed in this runtime`, details: missingIn(host, name) });

async function runGodot(input, host, signal) {
  const action = String(input.action ?? 'check');
  const project = await relIn(host, String(input.project ?? '.'));
  if (host.kind !== 'companion') {
    try { await fsp.access(path.join(host.root, project, 'project.godot')); } catch { return { content: `No project.godot in ${project}. Create the project first (see the godot-essentials skill).`, is_error: true }; }
  }
  const bin = await locate(host, 'godot', signal);
  if (!bin) return { content: missingIn(host, 'godot'), is_error: true };
  const timeoutMs = seconds(input.timeoutSec, 300);
  const frames = Math.min(Math.max(Math.round(Number(input.frames) || (action === 'run' ? 120 : 60)), 1), 3000);

  if (action === 'check') {
    const r = await checkGodot(host, bin, project, signal);
    return r.problems.length
      ? { content: `godot check: ${r.problems.length} problem(s) in ${project}:\n${r.problems.slice(0, 30).join('\n')}`, is_error: true }
      : `godot check: ${project} imports cleanly; ${Number.isNaN(r.checked) ? 'its' : r.checked} scripts and scenes load without errors.`;
  }

  if (action === 'export') return exportGodot(input, host, bin, project, signal);
  if (!['run', 'screenshot'].includes(action)) return { content: `Unknown action ${action}: use check, run, screenshot or export.`, is_error: true };
  const imp = await runIn(host, bin, godotArgs('import', { project }), { timeoutMs: 300_000, signal });
  if (imp.timedOut) return { content: 'godot: the import timed out after 5 minutes', is_error: true };

  if (action === 'run') {
    const r = await runIn(host, bin, godotArgs('run', { project, frames, scene: input.scene, args: input.args }), { timeoutMs, signal });
    const problems = godotProblems(r.output);
    const head = r.timedOut ? `godot run: timed out after ${timeoutMs / 1000}s` : `godot run: ${frames} frames headless in ${r.took}, exit ${r.code}, ${problems.length ? `${problems.length} error(s)` : 'no errors'}`;
    return { content: `${head}${problems.length ? `\n${problems.slice(0, 30).join('\n')}` : ''}\n\nOutput (end):\n${tail(r.output, 40)}`, is_error: r.timedOut || problems.length > 0 || r.code !== 0 };
  }

  if (action === 'screenshot') {
    // Godot draws where it runs - in the sandbox, the server folder, or on the
    // companion's computer - and writes the frames into the workspace there;
    // the last one is brought back (a companion sends that one file).
    const out = await relIn(host, String(input.out ?? '.harness/godot/screenshot.png'));
    if (path.extname(out).toLowerCase() !== '.png') return { content: 'out must be a .png file', is_error: true };
    const framesDir = `.harness/godot/frames-${newId()}`;
    await mkdirIn(host, framesDir, signal);
    try {
      const r = await runIn(host, bin, godotArgs('screenshot', { project, frames, scene: input.scene, args: input.args, movie: runtimePath(host, `${framesDir}/frame.png`) }), { timeoutMs, signal, prefix: withDisplay(host) });
      const shots = (await listIn(host, framesDir, signal)).filter((f) => /^frame\d+\.png$/.test(f)).sort();
      const problems = godotProblems(r.output);
      if (!shots.length) return { content: `godot screenshot: no frame was drawn (exit ${r.code}${r.timedOut ? ', timed out' : ''}). A display is needed: Xvfb on Linux (the 3D sandbox image has it).${problems.length ? `\n${problems.slice(0, 20).join('\n')}` : ''}\n\nOutput (end):\n${tail(r.output, 40)}`, is_error: true };
      const png = await readIn(host, `${framesDir}/${shots.at(-1)}`, signal);
      await writeIn(host, out, png, signal);
      return {
        content: `godot screenshot: frame ${shots.length} of ${frames} saved to ${out} (${r.took}).${problems.length ? `\n${problems.length} error(s) while running:\n${problems.slice(0, 20).join('\n')}` : ' No errors while running.'}`,
        is_error: problems.length > 0,
        images: [{ media_type: 'image/png', data: png.toString('base64') }],
      };
    } finally { await removeIn(host, framesDir, signal).catch(() => {}); }
  }
  throw new Error(`unreachable: ${action}`);
}

const templatesMissing = (host) => (host.kind === 'docker'
  ? 'Godot\'s export templates are not in this sandbox image. The operator builds the image with them (npm run sandbox:image:3d-export: harness-sandbox-3d:export, Linux and Web templates), allows it with HARNESS_SANDBOX_IMAGES, and a new session picks it.'
  : 'Godot\'s export templates are not installed for this Godot version. Install them (Editor > Manage Export Templates, or unpack Godot_v<version>-stable_export_templates.tpz into ~/.local/share/godot/export_templates/<version>.stable/; on Windows %APPDATA%\\Godot\\export_templates\\<version>.stable\\).');

/**
 * Exports with a preset from export_presets.cfg. A missing preset is an
 * error that names the ones there; only with createPreset ("linux" or "web")
 * does the tool add a minimal one, and it says so.
 */
async function exportGodot(input, host, bin, project, signal) {
  const kind = input.createPreset === undefined || input.createPreset === '' ? undefined : String(input.createPreset).toLowerCase();
  if (kind && !PRESET_KINDS[kind]) return { content: 'createPreset must be "linux" or "web".', is_error: true };
  const preset = String(input.preset ?? (kind ? PRESET_KINDS[kind].name : ''));
  const outputIn = input.output ?? (kind ? PRESET_KINDS[kind].output : undefined);
  if (!preset || !outputIn) return { content: 'export needs preset (a name in export_presets.cfg) and output (the file to write, e.g. build/linux/game.x86_64 or build/web/index.html); or createPreset ("linux" or "web") to add a minimal preset when the project has none.', is_error: true };
  const output = await relIn(host, String(outputIn));
  const cfgRel = project === '.' ? 'export_presets.cfg' : `${project}/export_presets.cfg`;
  const cfg = await readTextIn(host, cfgRel, signal);
  const presets = cfg === null ? [] : presetsIn(cfg);
  let note = '';
  if (!presets.some((p) => p.name === preset)) {
    if (!kind) {
      const there = presets.length ? `The presets there: ${presets.map((p) => `"${p.name}" (${p.platform})`).join(', ')}.` : cfg === null ? `${cfgRel} does not exist.` : `${cfgRel} has no presets.`;
      return { content: `godot export: no preset named "${preset}". ${there} Add one to export_presets.cfg (godot-essentials has minimal Linux and Web presets), or call export again with createPreset: "linux" or "web" to have a minimal one written.`, is_error: true };
    }
    const exportPath = path.posix.relative(project === '.' ? '' : project, output);
    await writeIn(host, cfgRel, withPreset(cfg ?? '', kind, preset, exportPath), signal);
    note = `\nWrote a minimal ${PRESET_KINDS[kind].platform} preset "${preset}" to ${cfgRel} (it was not there).`;
  } else if (kind) note = `\nUsed the preset "${preset}" already in ${cfgRel} (createPreset changed nothing).`;
  const imp = await runIn(host, bin, godotArgs('import', { project }), { timeoutMs: 300_000, signal });
  if (imp.timedOut) return { content: `godot: the import timed out after 5 minutes${note}`, is_error: true };
  await mkdirIn(host, path.posix.dirname(output), signal);
  const r = await runIn(host, bin, godotArgs('export', { project, preset, output: runtimePath(host, output), debug: input.debug === true }), { timeoutMs: seconds(input.timeoutSec, 600), signal });
  if (/No export template found/i.test(r.output)) return { content: `godot export: ${templatesMissing(host)} Everything else can still be checked with check, run and screenshot.${note}\n\n${tail(r.output, 12)}`, is_error: true };
  if (/presets were detected|Invalid export preset name|no export_presets/i.test(r.output)) return { content: `godot export: Godot did not find the preset "${preset}" in export_presets.cfg.${note}\n\n${tail(r.output, 12)}`, is_error: true };
  const problems = godotProblems(r.output);
  if (r.code !== 0 || r.timedOut) return { content: `godot export failed (exit ${r.code}${r.timedOut ? ', timed out' : ''}):${note}\n${problems.length ? `${problems.slice(0, 20).join('\n')}\n\n` : ''}${tail(r.output, 40)}`, is_error: true };
  // What was written: the files beside the output (a Linux binary and its .pck, a Web page and its .wasm/.pck/.js).
  const dir = path.posix.dirname(output);
  const base = path.posix.basename(output).replace(/\.[^.]+$/, '');
  const written = (await listIn(host, dir, signal)).filter((f) => f === path.posix.basename(output) || f.startsWith(`${base}.`)).sort();
  if (!written.includes(path.posix.basename(output))) return { content: `godot export: Godot exited 0 but ${output} was not written.${note}\n\n${tail(r.output, 40)}`, is_error: true };
  let sizes = '';
  if (host.kind !== 'companion') {
    const st = await Promise.all(written.map(async (f) => `${f} ${((await fsp.stat(path.join(host.root, dir, f))).size / 1048576).toFixed(1)} MB`));
    sizes = st.join(', ');
  }
  return `godot export: ${preset} -> ${output} in ${r.took}${input.debug === true ? ' (debug)' : ''}.${note}\nWritten in ${dir}: ${sizes || written.join(', ')}`;
}

const SKIP = new Set(['node_modules', '.git', 'vendor', '.harness', 'dist', 'build']);
async function findModels(root, rel = '', depth = 4, out = []) {
  let entries = [];
  try { entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (depth > 0 && !SKIP.has(e.name) && !e.name.startsWith('.')) await findModels(root, r, depth - 1, out); }
    else if (/\.(glb|gltf)$/i.test(e.name)) out.push(r);
    if (out.length >= 20) break;
  }
  return out;
}

export default {
  name: 'games3d',
  setup(api) {
    setupAssets(api);
    setupPlayer(api);
    api.registerTool(defineTool({
      name: 'model_info',
      description: 'Inspect a glTF model (.glb/.gltf) in the workspace: valid or not, meshes, triangles, materials, textures, animations and approximate size in metres (glTF units are metres).',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      kind: 'read',
      parallelSafe: true,
      summarize: (i) => String(i.path),
      async run(input, { host }) {
        if (host.kind === 'companion') return { content: 'model_info runs on the server; not available in companion sessions.', is_error: true };
        const file = await resolveIn(host, String(input.path));
        try { return describeGltf(String(input.path), await inspectGltf(file)); } catch (e) { return { content: `${input.path} is not a valid glTF model: ${e.message}`, is_error: true }; }
      },
    }));

    api.registerGate({
      name: 'gltf-valid',
      description: 'Every glTF model in the workspace (.glb/.gltf) is a valid glTF 2.0 file with geometry and a plausible size.',
      applies: async (host) => host.kind !== 'companion' && (await findModels(host.root)).length > 0,
      async run({ host }) {
        const files = await findModels(host.root);
        const bad = [];
        const ok = [];
        for (const f of files) {
          try {
            const g = await inspectGltf(path.join(host.root, f));
            if (!g.meshes || !g.triangles) bad.push(`${f}: no geometry`);
            else if (g.size && (Math.max(...g.size) > 1000 || Math.max(...g.size) < 0.001)) bad.push(`${f}: implausible size ${g.size.join(' x ')} m (glTF units are metres)`);
            else ok.push(describeGltf(f, g));
          } catch (e) { bad.push(`${f}: ${e.message}`); }
        }
        return bad.length
          ? { pass: false, summary: `${bad.length} of ${files.length} model(s) invalid`, details: bad.join('\n') }
          : { pass: true, summary: `${files.length} valid model(s)`, details: ok.join('\n') };
      },
    });

    api.registerTool(defineTool({
      name: 'blender',
      description: 'Run a Blender Python (bpy) script headless in the workspace: blender -b [file.blend] --factory-startup --python script -- args. Build a model procedurally and export .glb, open a .blend and export glb/fbx/obj, or render a PNG preview (Cycles on the CPU with few samples, or Workbench; Eevee needs a GPU). Relative paths in the script are relative to the workspace root. A Python error fails the run. Returns the exit status, the end of the output, and the images listed in show. Load the blender-scripting skill first.',
      parameters: {
        type: 'object',
        properties: {
          script: { type: 'string', description: 'A .py file in the workspace' },
          code: { type: 'string', description: 'Python to run instead of a file (kept in .harness/blender while it runs)' },
          file: { type: 'string', description: 'A .blend file to open first' },
          args: { type: 'array', items: { type: 'string' }, description: 'Arguments for the script: sys.argv after "--"' },
          show: { type: 'array', items: { type: 'string' }, description: 'Images the script writes (e.g. a preview render) to look at after the run, up to 4' },
          timeoutSec: { type: 'number', description: 'Default 300, at most 1800' },
        },
      },
      kind: 'exec',
      summarize: (i) => `${i.script ?? 'inline script'}${i.file ? ` on ${i.file}` : ''}${Array.isArray(i.args) && i.args.length ? ` -- ${i.args.join(' ')}` : ''}`,
      async run(input, { host, signal }) {
        if (!input.script === !input.code) return { content: 'Give either script (a .py file in the workspace) or code (Python), not both.', is_error: true };
        const file = input.file ? await relIn(host, String(input.file)) : undefined;
        let script = input.script ? await relIn(host, String(input.script)) : undefined;
        const bin = await locate(host, 'blender', signal);
        if (!bin) return { content: missingIn(host, 'blender'), is_error: true };
        let temp;
        if (input.code) {
          temp = `.harness/blender/run-${newId()}.py`;
          await writeIn(host, temp, String(input.code), signal);
          script = temp;
        }
        const timeoutMs = seconds(input.timeoutSec, 300);
        try {
          const r = await runIn(host, bin, blenderArgs({ script, file, args: Array.isArray(input.args) ? input.args : [] }), { timeoutMs, signal });
          const shown = await showImages(host, input.show, signal);
          const head = r.timedOut ? `blender: timed out after ${timeoutMs / 1000}s` : `blender exited ${r.code} in ${r.took}${r.code === 0 ? '' : ' (a Python error or a file Blender could not read)'}`;
          return { content: [head, ...shown.notes, `Output (end):\n${tail(r.output)}`].join('\n'), is_error: r.timedOut || r.code !== 0, images: shown.images };
        } finally { if (temp && host.kind !== 'companion') await fsp.rm(path.join(host.root, temp), { force: true }); }
      },
    }));

    api.registerTool(defineTool({
      name: 'godot',
      description: 'Run Godot 4 headless on a project in the workspace (the folder with project.godot). action: "check" imports the project and loads every script and scene, reporting parse errors and missing resources; "run" plays N frames headless at a fixed 60 per second (default 120: two seconds of game time, as fast as the machine runs) and reports script errors; "screenshot" draws N frames (default 60) and saves the last as a PNG you see; "export" builds with a preset from export_presets.cfg (needs Godot\'s export templates; a missing preset is an error unless you pass createPreset "linux" or "web", which writes a minimal one). Load the godot-essentials skill first.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['check', 'run', 'screenshot', 'export'] },
          project: { type: 'string', description: 'Folder with project.godot (default the workspace root)' },
          scene: { type: 'string', description: 'run/screenshot: scene to play, e.g. res://levels/level_1.tscn (default the main scene)' },
          frames: { type: 'number', description: 'run/screenshot: frames to play (60 per second of game time)' },
          args: { type: 'array', items: { type: 'string' }, description: 'run/screenshot: arguments for the game, read with OS.get_cmdline_user_args() (e.g. ["--selftest"])' },
          out: { type: 'string', description: 'screenshot: PNG path in the workspace (default .harness/godot/screenshot.png)' },
          preset: { type: 'string', description: 'export: preset name in export_presets.cfg (with createPreset, default "Linux" or "Web")' },
          output: { type: 'string', description: 'export: file to write, e.g. build/linux/game.x86_64 or build/web/index.html (the default with createPreset)' },
          createPreset: { type: 'string', enum: ['linux', 'web'], description: 'export: when export_presets.cfg has no preset of that name, write a minimal Linux (x86_64) or Web (no threads) one first. Never done without this.' },
          debug: { type: 'boolean', description: 'export: a debug build' },
          timeoutSec: { type: 'number', description: 'Default 300 (export 600), at most 1800' },
        },
        required: ['action'],
      },
      kind: 'exec',
      summarize: (i) => `${i.action} ${i.project ?? '.'}${i.scene ? ` ${i.scene}` : ''}${i.preset ? ` preset ${i.preset}` : ''}`,
      run: (input, { host, signal }) => runGodot(input, host, signal),
    }));

    api.registerGate({
      name: 'godot-project',
      description: 'Each Godot project (project.godot) imports, every script and scene loads, and it runs 30 frames headless with no script errors.',
      applies: async (host, signal) => { try { return (await godotProjects(host, signal)).length > 0; } catch { return false; } },
      async run({ host, signal }) {
        const projects = await godotProjects(host, signal);
        if (!projects.length) return { pass: true, summary: 'no Godot project (project.godot) in the workspace' };
        const bin = await locate(host, 'godot', signal);
        if (!bin) return notChecked(host, 'godot');
        const bad = [];
        for (const project of projects) {
          const c = await checkGodot(host, bin, project, signal);
          let problems = c.problems;
          if (!problems.length) {
            const r = await runIn(host, bin, godotArgs('run', { project, frames: 30 }), { timeoutMs: 180_000, signal });
            problems = r.timedOut ? ['30 frames did not finish in 3 minutes'] : godotProblems(r.output);
          }
          if (problems.length) bad.push(`${project}:\n  ${problems.slice(0, 15).join('\n  ')}`);
        }
        return bad.length
          ? { pass: false, summary: `${bad.length} of ${projects.length} Godot project(s) have errors`, details: `${bad.join('\n')}\nRun the godot tool (check, run) to see them.` }
          : { pass: true, summary: `${projects.length} Godot project(s) import, load and run cleanly: ${projects.join(', ')}` };
      },
    });

    api.registerGate({
      name: 'godot-selftest',
      description: `Each Godot project that has a --selftest mode runs it headless (up to ${SELFTEST_FRAMES} frames): it must print SELFTEST PASS and report no errors.`,
      applies: async (host, signal) => {
        try {
          if (host.kind === 'companion') return false; // decided by name in a workflow; a listing cannot see the scripts' text
          for (const p of await godotProjects(host, signal)) {
            for (const f of await findFiles(path.join(host.root, p), (n) => n.endsWith('.gd'), { max: 50, depth: 4 })) {
              if ((await fsp.readFile(path.join(host.root, p, f), 'utf8')).includes('--selftest')) return true;
            }
          }
        } catch { /* not applicable */ }
        return false;
      },
      async run({ host, signal }) {
        const projects = await godotProjects(host, signal);
        if (!projects.length) return { pass: false, summary: 'no Godot project (project.godot) in the workspace to self-test' };
        const bin = await locate(host, 'godot', signal);
        if (!bin) return notChecked(host, 'godot');
        const bad = [];
        const ok = [];
        for (const project of projects) {
          const r = await selftestGodot(host, bin, project, signal);
          if (r.passed) ok.push(`${project} (${r.took})`);
          else bad.push(`${project}:\n  ${r.problems.slice(0, 15).join('\n  ')}\n  Output (end):\n  ${tail(r.output, 15, 1500).replace(/\n/g, '\n  ')}`);
        }
        return bad.length
          ? { pass: false, summary: `${bad.length} of ${projects.length} Godot self-test(s) failed`, details: `${bad.join('\n')}\nRun it with the godot tool: {"action": "run", "args": ["--selftest"], "frames": ${SELFTEST_FRAMES}}.` }
          : { pass: true, summary: `${projects.length} Godot self-test(s) passed: ${ok.join(', ')}` };
      },
    });

    api.registerGate({
      name: 'model-preview',
      description: 'Rendered previews of the models (PNG files in previews/) exist, were rendered after the last export, and show something (not one colour).',
      applies: async (host) => {
        if (host.kind === 'companion') return false;
        return (await findModels(host.root)).length > 0 && (await findFiles(path.join(host.root, 'previews'), isPng, { max: 1, depth: 2 })).length > 0;
      },
      async run({ host, signal }) {
        const root = host.kind === 'companion' ? await host.mirror?.(signal) : host.root;
        if (!root) return { pass: false, summary: 'this companion cannot send files to the server' };
        const models = await findModels(root);
        if (!models.length) return { pass: false, summary: 'no model (.glb/.gltf) to preview', details: 'Export the model first (model.glb).' };
        const shots = (await findFiles(path.join(root, 'previews'), isPng, { max: 20, depth: 2 })).sort();
        const how = 'Render previews of the exported model into previews/ (e.g. previews/front.png, side.png, top.png) after the last export, and look at them (blender-scripting: previews).';
        if (!shots.length) return { pass: false, summary: 'no preview renders in previews/', details: how };
        const newest = Math.max(...await Promise.all(models.map(async (m) => (await fsp.stat(path.join(root, m))).mtimeMs)));
        const bad = [];
        const ok = [];
        for (const s of shots) {
          const file = path.join(root, 'previews', s);
          try {
            const st = await fsp.stat(file);
            const p = pngStats(await fsp.readFile(file));
            // A companion's copy has the copy's times, not the originals': there the order is not checked.
            if (host.kind !== 'companion' && st.mtimeMs + 2000 < newest) bad.push(`previews/${s}: older than the last model export (render it again)`);
            else if (p.width < 64 || p.height < 64) bad.push(`previews/${s}: ${p.width}x${p.height} is too small to judge`);
            else if (p.blank) bad.push(`previews/${s}: blank (${p.colours} colour(s)): the model is not in view or not lit`);
            else ok.push(`previews/${s} ${p.width}x${p.height}${p.colours === null ? '' : `, ${p.colours} colours`}`);
          } catch (e) { bad.push(`previews/${s}: ${e.message}`); }
        }
        return bad.length
          ? { pass: false, summary: `${bad.length} of ${shots.length} preview(s) unusable`, details: `${bad.join('\n')}\n${how}` }
          : { pass: true, summary: `${shots.length} preview(s) of ${models.length} model(s): ${ok.join(', ')}` };
      },
    });

    api.registerGate({
      name: 'blender-file',
      description: 'Every .blend file in the workspace opens in Blender headless without errors.',
      applies: async (host, signal) => { try { return (await blendFiles(host, signal)).length > 0; } catch { return false; } },
      async run({ host, signal }) {
        const files = await blendFiles(host, signal);
        if (!files.length) return { pass: true, summary: 'no .blend files in the workspace' };
        const bin = await locate(host, 'blender', signal);
        if (!bin) return notChecked(host, 'blender');
        const bad = [];
        const ok = [];
        for (const f of files) {
          const r = await runIn(host, bin, blendCheckArgs(f), { timeoutMs: 180_000, signal });
          const m = /HARNESS_BLEND OK (\d+)/.exec(r.output);
          if (r.code === 0 && m) ok.push(`${f} (${m[1]} objects)`);
          else bad.push(`${f}: ${r.timedOut ? 'timed out' : `exit ${r.code}`}\n  ${tail(r.output, 8, 800).replace(/\n/g, '\n  ')}`);
        }
        return bad.length
          ? { pass: false, summary: `${bad.length} of ${files.length} .blend file(s) do not open`, details: bad.join('\n') }
          : { pass: true, summary: `${files.length} .blend file(s) open: ${ok.join(', ')}` };
      },
    });
  },
};
