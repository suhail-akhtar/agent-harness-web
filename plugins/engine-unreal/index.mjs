// Unreal Engine 5 for Studio: the `unreal` tool (the engine contract's actions), the
// unreal-project, unreal-package and unreal-automation gates, skills and an agent.
//
// Unreal runs on this machine (a server folder or the desktop's own; there is no sandbox
// image for it), Blueprint and Python first: a project from a template, editor Python with
// the harness_ue helpers, captures, Movie Render Queue renders, Automation tests, BuildCookRun
// packaging with the precompiled game binary (no C++ compiler needed), scripted plays with
// frames and a CSV profile, a step server for the AI player, and the Remote Control bridge to
// an editor this tool launched. It never touches an editor or a project it did not start or
// make, unless asked for by port.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { defineTool } from '@harness/plugin-sdk/runtime';
import { toToolResult, unavailable } from '@harness/plugins/games3d/sdk/engine.mjs';
import { cancelJob, listJobs, runJob } from '@harness/plugins/games3d/sdk/jobs.mjs';
import { tail } from '@harness/plugins/games3d/lib-engines.mjs';
import { automationArgs, buildCookRunArgs } from './lib/args.mjs';
import { launchEditor, rcClient, stopEditor, waitForRc } from './lib/bridge.mjs';
import { engine, engineReport, exists, installHelpers, projectOf, readJson, relTo, runDir, runPython, writeJson } from './lib/context.mjs';
import { parseAutomationReport, problemsIn, uatProgress } from './lib/logs.mjs';
import { defaultMap, levelHasDriver, playReport, playScripted, startStepSession, stopStepSession } from './lib/play.mjs';
import { createFromTemplate, SETUPS, studioProject, TEMPLATES, projectName } from './lib/project.mjs';
import { batchCommand, runUE, secs } from './lib/run.mjs';

const ENGINE = 'unreal';
const result = (action, status, summary, extra = {}) => ({ engine: ENGINE, action, status, summary, ...extra });
const seconds = (v, def, max = 4 * 3600) => Math.min(Math.max(Number(v) || def, 10), max) * 1000;
const py = (v) => JSON.stringify(v ?? null).replace(/\bnull\b/g, 'None').replace(/\btrue\b/g, 'True').replace(/\bfalse\b/g, 'False');

/** Bridge editors and step-mode games this plugin started, by key; stopped when the harness closes. */
const bridges = new Map();
const players = new Map();
/** Progress of running heavy jobs, by job title. */
const progress = new Map();

async function dirSize(dir) {
  let n = 0;
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) n += await dirSize(p);
    else n += (await fsp.stat(p).catch(() => ({ size: 0 }))).size;
  }
  return n;
}
const mb = (b) => Math.round(b / 1048576);

async function image(file) {
  const data = await fsp.readFile(file);
  return data.length > 5_000_000 ? null : { media_type: 'image/png', data: data.toString('base64') };
}

/** A few frames spread over a list (the first, the last, and between). */
function sample(list, n = 4) {
  if (list.length <= n) return list;
  return Array.from({ length: n }, (_, i) => list[Math.round((i * (list.length - 1)) / (n - 1))]);
}

// ---------- actions ----------

async function doDetect(input, host) {
  const r = await engineReport({ fresh: true, projectDir: host.root });
  if (!r.installed) return result('detect', 'unavailable', r.gaps[0], { data: r });
  const summary = `Unreal Engine ${r.version} at ${r.path}${r.compiler?.found ? `, ${r.compiler.what} found` : ''}; ${r.gaps.length ? `gaps: ${r.gaps.map((g) => g.split(':')[0]).join('; ')}` : 'no gaps'}`;
  return result('detect', 'ok', summary, { data: r });
}

async function doCreate(input, host, eng, signal) {
  const name = projectName(input.name);
  const setup = input.setup ? SETUPS[String(input.setup)] : null;
  if (input.setup && !setup) return result('project.create', 'failed', `unknown setup ${input.setup}: use ${Object.keys(SETUPS).join(' or ')}`);
  const template = String(input.template ?? setup?.template ?? 'TP_ThirdPersonBP');
  const variant = input.variant ?? setup?.variant ?? null;
  const studioRel = String(input.dir ?? name).replace(/\\/g, '/').replace(/\/$/, '');
  const studioAbs = path.resolve(host.root, studioRel);
  if (relTo(host, studioAbs).startsWith('..')) return result('project.create', 'failed', `${studioRel} is outside the workspace`);
  if (await exists(path.join(studioAbs, '.studio', 'project.json'))) return result('project.create', 'failed', `${studioRel} already holds a Studio project`);
  const t0 = Date.now();
  const gameDir = path.join(studioAbs, 'Game');
  const made = await createFromTemplate({ engineRoot: eng.root, template, variant: setup ? null : variant, name, dir: gameDir, association: eng.association ?? eng.version?.split('.').slice(0, 2).join('.'), description: input.description });
  const info = TEMPLATES[template] ?? { dimension: '3d', genre: template };
  const studio = studioProject({ name, dimension: setup?.dimension ?? info.dimension, genre: input.genre ?? info.genre, engineProject: `Game/${name}.uproject`, template, variant: setup ? null : variant });
  if (setup) studio.unreal.setup = input.setup;
  await writeJson(path.join(studioAbs, '.studio', 'project.json'), studio);
  await installHelpers(gameDir);
  const notes = [];
  if (made.runtimePlugins.length) notes.push(`plugins on for the game: ${made.runtimePlugins.join(', ')} (packaging this needs a C++ toolchain)`);
  let setupRun = null;
  if (setup || input.firstRun) {
    const proj = await projectOf(host, `${studioRel}/Game/${name}.uproject`);
    const code = setup?.camera === 'side' ? 'import harness_ue as h\nh.side_scroller_setup()\nh.save()\n'
      : setup?.camera === 'top' ? 'import harness_ue as h\nh.top_down_2d_setup()\nh.save()\n'
        : 'import harness_ue as h\nh.result("check", h.check_project())\n';
    setupRun = await runPython(host, eng, proj, { code, timeoutMs: 1_200_000, signal, kind: 'create' });
    if (setupRun.failed) return result('project.create', 'failed', `made ${name} from ${template}, but the ${input.setup ?? 'first'} run failed`, { problems: setupRun.problems, logFile: setupRun.logFile, log: tail(setupRun.text, 30) });
    notes.push(setup ? `${input.setup} setup applied (orthographic camera${setup.camera === 'side' ? ', movement locked to the X-Z plane' : ', looking down'})` : 'opened once in the editor');
  }
  const size = await dirSize(gameDir);
  return result('project.create', 'ok', `${name} made from ${template}${variant && !setup ? ` (${variant} variant)` : ''} in ${studioRel} (${mb(size)} MB, ${secs((Date.now() - t0) / 1000)})${notes.length ? `; ${notes.join('; ')}` : ''}`, {
    files: [`${studioRel}/Game/${name}.uproject`, `${studioRel}/.studio/project.json`],
    metrics: { took: Math.round((Date.now() - t0) / 100) / 10, sizeMb: mb(size), filesCopied: made.copied + made.packs.reduce((n, p) => n + p.files, 0) },
    data: { uproject: `${studioRel}/Game/${name}.uproject`, map: made.map, packs: made.packs.map((p) => `${p.level}/${p.mount}`), runtimePlugins: made.runtimePlugins },
    ...(setupRun ? { logFile: setupRun.logFile } : {}),
  });
}

async function doDescribe(input, host, eng, proj, signal) {
  const code = `import harness_ue as h\n${input.level ? `h.open_level(${py(input.level)})\n` : ''}h.result("describe", h.describe(max_actors=${Number(input.maxActors) || 300}))\n`;
  const r = await runPython(host, eng, proj, { code, timeoutMs: seconds(input.timeoutSec, 600), signal, kind: 'describe' });
  const d = r.results.describe;
  if (!d) return result('describe', 'failed', 'the editor did not describe the project', { problems: r.problems, logFile: r.logFile, log: tail(r.text, 30) });
  const full = path.join(r.dir.dir, 'describe.json');
  await writeJson(full, d);
  const bps = d.blueprints ?? [];
  return result('describe', 'ok', `${proj.name}: ${d.levels.length} level(s), open level ${d.openLevel} with ${d.actors.length} actor(s), ${d.assetCount} asset(s), ${bps.length} Blueprint(s) (in ${secs(r.took)})`, {
    files: [relTo(host, full)], logFile: r.logFile,
    problems: r.problems.filter((p) => p.severity === 'error').slice(0, 10),
    data: {
      levels: d.levels, openLevel: d.openLevel, levelGameMode: d.levelGameMode, settings: d.settings,
      actors: d.actors.map((a) => `${a.label} (${a.class.split('.').pop()}) at ${a.location.map((v) => Math.round(v)).join(',')}`).slice(0, 80),
      blueprints: bps.map((b) => ({ path: b.path, parent: b.parent?.split('.').pop(), variables: (b.variables ?? []).map((v) => `${v.name}:${v.type}=${JSON.stringify(v.default)}`), functions: b.functions, components: b.components, status: b.status })),
      assets: Object.fromEntries(Object.entries(d.assets).map(([k, v]) => [k, v.length])),
    },
  });
}

async function doScript(input, host, eng, proj, signal) {
  if (!input.code === !input.file) return result('script', 'failed', 'give code (Python) or file (a .py in the workspace), not both');
  if (input.live) {
    const s = bridges.get(proj.file);
    if (!s) return result('script', 'failed', 'no live editor for this project: start one with {"action": "bridge.connect"} first (or run without live: true)');
    const code = input.code ?? await fsp.readFile(path.resolve(host.root, String(input.file)), 'utf8');
    const r = await s.client.python(`import sys\nsys.path.insert(0, ${py(path.join(proj.dir, 'Content', 'Python').replace(/\\/g, '/'))})\n${code}`);
    const problems = problemsIn(r.output);
    return result('script', r.ok ? 'ok' : 'failed', `ran in the live editor (port ${s.httpPort})${r.ok ? '' : ': it raised'}`, { log: tail(`${r.output}\n${r.result}`, 60), problems, data: { result: r.result } });
  }
  if (input.file) {
    const abs = path.resolve(host.root, String(input.file));
    if (relTo(host, abs).startsWith('..')) return result('script', 'failed', `${input.file} is outside the workspace`);
  }
  const r = await runPython(host, eng, proj, { code: input.code, file: input.file, args: Array.isArray(input.args) ? input.args : [], mode: input.mode === 'commandlet' ? 'commandlet' : 'editor', rendering: input.rendering === true, keepAlive: input.keepAlive === true, timeoutMs: seconds(input.timeoutSec, 900), signal });
  const out = r.text.split(/\r?\n/).filter((l) => /LogPython: (?!Display: Running start-up|Using Python|Display: No pip|Python enabled via|registering <class)/.test(l) && !/HARNESS_JSON/.test(l)).map((l) => l.replace(/^\[[^\]]+\]\[\s*\d+\]LogPython: /, ''));
  const head = r.timedOut ? `timed out after ${secs(r.took)}` : r.failed ? `failed in ${secs(r.took)} (exit ${r.code}${r.fatal.length ? `, ${r.fatal.length} error(s)` : ''})` : `ran in ${secs(r.took)}`;
  const data = Object.fromEntries(Object.entries(r.results).filter(([k]) => k !== 'all'));
  return result('script', r.failed ? 'failed' : 'ok', `${head} on ${proj.rel} (${input.mode === 'commandlet' ? 'commandlet' : 'editor'}${input.rendering ? ', rendering' : ', -nullrhi'})`, {
    problems: r.problems.slice(0, 30), logFile: r.logFile, log: out.slice(-60).join('\n').slice(-6000),
    ...(Object.keys(data).length ? { data } : {}),
  });
}

async function doCapture(input, host, eng, proj, signal) {
  const view = input.view === 'editor' ? 'editor' : 'game';
  const rd = await runDir(host, 'captures');
  const outRel = input.out ? String(input.out) : `${rd.rel}/capture.png`;
  const outAbs = path.resolve(host.root, outRel);
  if (relTo(host, outAbs).startsWith('..') || !/\.png$/i.test(outAbs)) return result('capture', 'failed', 'out must be a .png path in the workspace');
  await fsp.mkdir(path.dirname(outAbs), { recursive: true });
  const w = Number(input.width) || 1280;
  const h = Number(input.height) || 720;
  const t0 = Date.now();
  let r;
  if (view === 'editor') {
    const code = `import harness_ue as h\nh.capture_editor(${py(outAbs.replace(/\\/g, '/'))}, width=${w}, height=${h}, camera=${py(input.camera)}, location=${py(input.at)}, rotation=${py(input.rotation)}, target=${py(input.target)}, fov=${Number(input.fov) || 70}, level=${py(input.level)}, frames=${Number(input.frames) || 90})\n`;
    r = await runPython(host, eng, proj, { code, rendering: true, timeoutMs: seconds(input.timeoutSec, 600), signal, kind: 'captures' });
  } else {
    await installHelpers(proj.dir);
    const map = input.level ?? await defaultMap(proj.dir);
    if (Array.isArray(input.at) && map && !await levelHasDriver(proj.dir, map, 'HarnessCamera')) {
      const r0 = await runPython(host, eng, proj, { code: `import harness_ue as h\nh.ensure_play_driver(${py(map)})\n`, timeoutMs: 900_000, signal, kind: 'captures' });
      if (r0.failed) return result('capture', 'failed', 'could not add the harness camera to the level', { problems: r0.problems, logFile: r0.logFile });
    }
    const script = path.join(proj.dir, 'Content', 'Python', 'harness_capture_game.py').replace(/\\/g, '/');
    const parts = [`py ${script} --out ${outAbs.replace(/\\/g, '/')}`, `--frames ${Number(input.frames) || 90}`, `--width ${w} --height ${h}`, `--fov ${Number(input.fov) || 70}`];
    // ExecCmds splits commands at commas: numbers are joined with ':'.
    if (Array.isArray(input.at)) parts.push(`--at ${input.at.join(':')}`);
    if (Array.isArray(input.rotation)) parts.push(`--rot ${input.rotation.join(':')}`);
    if (Array.isArray(input.target)) parts.push(`--target ${input.target.join(':')}`);
    const logFile = path.join(rd.dir, 'game.log');
    const { gameArgs } = await import('./lib/args.mjs');
    const args = gameArgs({ uproject: proj.file, map: input.level, width: w, height: h, log: logFile, extra: [`-ExecCmds=${parts.join(' ')}`] });
    const run = await runUE(host, eng.bin.editor, args, { timeoutMs: seconds(input.timeoutSec, 600), signal });
    const text = await fsp.readFile(logFile, 'utf8').catch(() => run.output);
    r = { ...run, text, problems: problemsIn(text, { warnings: false }), logFile: relTo(host, logFile) };
  }
  if (!await exists(outAbs)) return result('capture', 'failed', `no frame was written (${view} view, exit ${r.code}${r.timedOut ? ', timed out' : ''})`, { problems: r.problems?.slice(0, 20), logFile: r.logFile, log: tail(r.text ?? '', 30) });
  const img = await image(outAbs);
  const { pngStats } = await import('@harness/plugins/games3d/lib-png.mjs');
  let stats = null;
  try { stats = pngStats(await fsp.readFile(outAbs)); } catch { /* not decodable here */ }
  return {
    ...result('capture', 'ok', `${w}x${h} ${view} frame of ${input.level ?? 'the default level'} saved to ${outRel} in ${secs((Date.now() - t0) / 1000)}${stats?.blank ? ' (it looks blank: check the camera)' : ''}`, { files: [outRel], logFile: r.logFile, metrics: { took: Math.round((Date.now() - t0) / 100) / 10 } }),
    images: img ? [img] : [],
  };
}

async function doRender(input, host, eng, proj, signal) {
  const rd = await runDir(host, 'renders');
  const outRel = String(input.out ?? rd.rel);
  const outAbs = path.resolve(host.root, outRel);
  if (relTo(host, outAbs).startsWith('..')) return result('render', 'failed', 'out must be a folder in the workspace');
  const tt = input.turntable ?? (input.sequence ? null : {});
  const w = Number(input.width) || 1280;
  const h = Number(input.height) || 720;
  const lines = ['import harness_ue as h'];
  if (input.level) lines.push(`h.open_level(${py(input.level)})`);
  if (tt) lines.push(`seq = h.turntable_sequence(target=${py(tt.target ?? [0, 0, 100])}, radius=${Number(tt.radius) || 800}, height=${Number(tt.height) || 300}, seconds=${Number(tt.seconds) || 4}, fps=${Number(tt.fps) || 24})`);
  else lines.push(`seq = ${py(input.sequence)}`);
  lines.push(`h.render_sequence(seq, ${py(outAbs.replace(/\\/g, '/'))}, width=${w}, height=${h}, format=${py(input.format ?? 'png')})`);
  const title = `render ${proj.name}`;
  const t0 = Date.now();
  const r = await runJob(ENGINE, title, (sig) => runPython(host, eng, proj, { code: `${lines.join('\n')}\n`, rendering: true, timeoutMs: seconds(input.timeoutSec, 3600), signal: sig, kind: 'renders' }), { signal, timeoutMs: seconds(input.timeoutSec, 3600) + 60_000 });
  const frames = (await fsp.readdir(outAbs).catch(() => [])).filter((f) => /\.(png|jpe?g|exr)$/i.test(f)).sort();
  const ok = !r.failed && frames.length > 0 && r.results.render?.success !== false;
  const images = [];
  for (const f of sample(frames.filter((x) => /\.png$/i.test(x)), 3)) { const i = await image(path.join(outAbs, f)); if (i) images.push(i); }
  return {
    ...result('render', ok ? 'ok' : 'failed', ok ? `${frames.length} frame(s) rendered with Movie Render Queue to ${outRel} in ${secs((Date.now() - t0) / 1000)}` : `the render made ${frames.length} frame(s)${r.timedOut ? ' (timed out)' : ''}`, {
      files: frames.slice(0, 5).map((f) => `${outRel}/${f}`), logFile: r.logFile, problems: r.problems.slice(0, 20),
      metrics: { frames: frames.length, took: Math.round((Date.now() - t0) / 100) / 10 },
    }),
    images,
  };
}

async function doTest(input, host, eng, proj, signal) {
  const t0 = Date.now();
  const out = { automation: null, checks: null };
  const problems = [];
  let logFile;
  if (input.checks) {
    const code = `import harness_ue as h\n${String(input.checks)}\nh.report_checks()\n`;
    const r = await runPython(host, eng, proj, { code, timeoutMs: seconds(input.timeoutSec, 900), signal, kind: 'tests' });
    out.checks = r.results.checks ?? [];
    problems.push(...r.problems.filter((p) => p.severity === 'error'));
    logFile = r.logFile;
    if (r.failed && !out.checks.length) out.checks = [{ name: 'checks script', pass: false, detail: r.problems[0]?.message ?? `exit ${r.code}` }];
  }
  if (input.filter !== false && input.automation !== false) {
    const filter = String(input.filter ?? 'Project');
    const rd = await runDir(host, 'tests');
    const reportDir = path.join(rd.dir, 'report');
    const log = path.join(rd.dir, 'automation.log');
    const title = `test ${proj.name} ${filter}`;
    const r = await runJob(ENGINE, title, (sig) => runUE(host, eng.bin.editorCmd, automationArgs({ uproject: proj.file, filter, reportDir, log, rendering: input.rendering === true }), { timeoutMs: seconds(input.timeoutSec, 1800), signal: sig }), { signal, timeoutMs: seconds(input.timeoutSec, 1800) + 60_000 });
    const json = await fsp.readFile(path.join(reportDir, 'index.json'), 'utf8').catch(() => null);
    out.automation = json ? parseAutomationReport(json) : null;
    logFile = relTo(host, log);
    if (!out.automation) problems.push({ severity: 'error', message: `no Automation report (exit ${r.code}${r.timedOut ? ', timed out' : ''})` });
    else if (!out.automation.tests.length) problems.push({ severity: 'warning', message: `no Automation test matched "${filter}"` });
    for (const t of out.automation?.tests ?? []) for (const e of t.errors) problems.push({ severity: 'error', message: `${t.path}: ${e.message}`, ...(e.file ? { file: e.file, line: e.line } : {}) });
  }
  const a = out.automation;
  const failedChecks = (out.checks ?? []).filter((c) => !c.pass);
  const failed = (a && a.failed > 0) || failedChecks.length > 0 || problems.some((p) => p.severity === 'error');
  const ran = (a?.tests.length ?? 0) + (out.checks?.length ?? 0);
  const parts = [];
  if (a) parts.push(`Automation ${a.passed} passed, ${a.failed} failed${a.notRun ? `, ${a.notRun} not run` : ''} (${a.tests.length} test(s), ${a.durationS} s)`);
  if (out.checks) parts.push(`checks ${out.checks.length - failedChecks.length}/${out.checks.length} passed`);
  return result('test', failed || !ran ? 'failed' : 'ok', `${parts.join('; ') || 'nothing ran'} in ${secs((Date.now() - t0) / 1000)}`, {
    problems: problems.slice(0, 30), logFile,
    metrics: { tests: ran, failed: (a?.failed ?? 0) + failedChecks.length, took: Math.round((Date.now() - t0) / 100) / 10 },
    data: { automation: a ? { ...a, tests: a.tests.map((t) => ({ path: t.path, state: t.state, durationS: t.durationS, errors: t.errors.slice(0, 5) })) } : null, checks: out.checks },
  });
}

/** BuildCookRun as a heavy job. package: cook, stage, pak, archive; build: cook only. */
async function doPackage(input, host, eng, proj, signal, action) {
  const config = String(input.config ?? 'Development');
  if (!['Development', 'Shipping', 'DebugGame'].includes(config)) return result(action, 'failed', 'config is Development, Shipping or DebugGame');
  const platform = String(input.platform ?? 'Win64');
  const studio = proj.studioDir ? await readJson(path.join(proj.studioDir, '.studio', 'project.json')) : null;
  const buildId = input.id ? String(input.id) : `b${(studio?.builds?.length ?? 0) + 1}`;
  const base = proj.studioDir ?? proj.dir;
  const archiveAbs = input.out ? path.resolve(host.root, String(input.out)) : path.join(base, 'Builds', buildId);
  if (relTo(host, archiveAbs).startsWith('..')) return result(action, 'failed', 'out must be a folder in the workspace');
  const rd = await runDir(host, 'builds');
  const logFile = path.join(rd.dir, 'uat.log');
  const notes = [];
  const map = input.map ?? await defaultMap(proj.dir);
  // The play driver makes scripted plays work in the build; it does nothing without -HarnessTimeline.
  // Always run: it also brings an older driver up to date (a no-op when it is current).
  if (input.playDriver !== false && map) {
    const had = await levelHasDriver(proj.dir, map);
    const r = await runPython(host, eng, proj, { code: `import harness_ue as h\nh.ensure_play_driver(${py(map)})\n`, timeoutMs: 900_000, signal, kind: 'builds' });
    if (r.failed) return result(action, 'failed', 'could not add the play driver to the level before packaging', { problems: r.problems, logFile: r.logFile });
    if (!had) notes.push(`added the play driver to ${map}`);
  }
  const title = `${action} ${proj.name} ${platform} ${config}`;
  const state = { stage: 'queued', pct: 0, done: [] };
  progress.set(title, state);
  const t0 = Date.now();
  const extra = action === 'build' ? ['-skipstage'] : [];
  const uatArgs = buildCookRunArgs({ uproject: proj.file, platform, config, archiveDir: archiveAbs, clean: input.clean === true, extra });
  const argv = action === 'build' ? uatArgs.filter((a) => !/^-(stage|pak|archive|archivedirectory=)/.test(a)) : uatArgs;
  const cmd = process.platform === 'win32' ? batchCommand(eng.bin.uat, argv) : { exe: eng.bin.uat, args: argv, raw: false };
  const run = await runJob(ENGINE, title, (sig) => runUE(host, cmd.exe, cmd.args, { timeoutMs: seconds(input.timeoutSec, 7200, 6 * 3600), signal: sig, logFile, onLine: (l) => uatProgress(state, l), raw: cmd.raw }), { signal, timeoutMs: seconds(input.timeoutSec, 7200, 6 * 3600) + 60_000 }).finally(() => progress.delete(title));
  const text = run.output;
  const problems = problemsIn(text, { warnings: true }).filter((p) => p.severity === 'error' || /LogCook|LogBlueprint/.test(p.message)).slice(0, 40);
  const ok = run.code === 0 && /BUILD SUCCESSFUL/.test(text);
  const took = (Date.now() - t0) / 1000;
  if (!ok) {
    const hint = /treated as a code-based project/.test(text) ? ` ${/is being treated as a code-based project[^\n]*/.exec(text)[0]} - Blueprint-only packaging needs every runtime plugin that is not on by default limited to the Editor target ("TargetAllowList": ["Editor"] in the .uproject), or a C++ toolchain.` : '';
    return result(action, run.timedOut ? 'timed-out' : 'failed', `${action} failed after ${secs(took)} (exit ${run.code}, at ${state.stage}).${hint}`, { problems, logFile: relTo(host, logFile), log: tail(text, 40) });
  }
  if (action === 'build') return result('build', 'ok', `cooked ${proj.name} for ${platform} (${config}) in ${secs(took)}${notes.length ? `; ${notes.join('; ')}` : ''}`, { logFile: relTo(host, logFile), problems, metrics: { took: Math.round(took) } });
  const platDir = path.join(archiveAbs, platform === 'Win64' ? 'Windows' : platform);
  const exeFile = path.join(platDir, `${proj.name}${process.platform === 'win32' ? '.exe' : ''}`);
  const size = await dirSize(archiveAbs);
  if (!await exists(exeFile)) return result('package', 'failed', `UAT finished but ${relTo(host, exeFile)} is not there`, { logFile: relTo(host, logFile), log: tail(text, 30) });
  if (studio) {
    studio.builds = [...(studio.builds ?? []).filter((b) => b.id !== buildId), { id: buildId, platform: platform.toLowerCase(), config, path: path.relative(proj.studioDir, exeFile).split(path.sep).join('/'), status: 'ok', at: new Date().toISOString(), sizeMb: mb(size), took: Math.round(took) }];
    await writeJson(path.join(proj.studioDir, '.studio', 'project.json'), studio);
  }
  return result('package', 'ok', `packaged ${proj.name} for ${platform} (${config}) in ${secs(took)}: ${relTo(host, exeFile)}, ${mb(size)} MB${notes.length ? `; ${notes.join('; ')}` : ''}`, {
    files: [relTo(host, exeFile)], logFile: relTo(host, logFile), problems: problems.filter((p) => p.severity === 'error'),
    metrics: { took: Math.round(took), sizeMb: mb(size), cookedPackages: state.total ?? 0 },
    data: { build: buildId, exe: relTo(host, exeFile), archive: relTo(host, archiveAbs) },
  });
}

/** The build to play: a path, an id from project.json, or the latest; null for the editor. */
async function buildToPlay(host, proj, which) {
  if (which === false || which === 'editor') return null;
  const studio = proj.studioDir ? await readJson(path.join(proj.studioDir, '.studio', 'project.json')) : null;
  const builds = studio?.builds ?? [];
  let exe;
  if (typeof which === 'string' && which !== 'latest') {
    const b = builds.find((x) => x.id === which);
    exe = b ? path.join(proj.studioDir, b.path) : path.resolve(host.root, which);
  } else if (which === 'latest' || which === true) {
    const b = builds.filter((x) => x.status === 'ok').at(-1);
    if (!b) return null;
    exe = path.join(proj.studioDir, b.path);
  } else return null;
  if (!await exists(exe)) throw new Error(`the build ${relTo(host, exe)} is not there`);
  return { exe, id: builds.find((b) => path.join(proj.studioDir, b.path) === exe)?.id ?? null };
}

async function doPlay(input, host, eng, proj, signal) {
  const b = await buildToPlay(host, proj, input.build ?? (input.editor ? false : 'latest'));
  const map = input.level ?? await defaultMap(proj.dir);
  const notes = [];
  if (!b && map && !await levelHasDriver(proj.dir, map)) {
    const r = await runPython(host, eng, proj, { code: `import harness_ue as h\nh.ensure_play_driver(${py(map)})\n`, timeoutMs: 900_000, signal, kind: 'plays' });
    if (r.failed) return result('play', 'failed', 'could not add the play driver to the level', { problems: r.problems, logFile: r.logFile });
    notes.push(`added the play driver to ${map}`);
  } else if (b && map && !await levelHasDriver(proj.dir, map)) notes.push('the level may lack the play driver (package again to add it): inputs and frames need it');
  const id = `pt-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')}`;
  const outDir = path.join(proj.studioDir ?? path.join(host.root, '.harness', 'unreal'), '.studio', 'playtests', id);
  await fsp.mkdir(outDir, { recursive: true });
  const secondsToPlay = Math.min(Math.max(Number(input.seconds) || 10, 1), 1800);
  const target = b ? { kind: 'packaged', exe: b.exe, savedDir: path.join(path.dirname(b.exe), proj.name, 'Saved') } : { kind: 'editor', editor: eng.bin.editor, uproject: proj.file, projectDir: proj.dir };
  const title = `play ${proj.name} ${secondsToPlay}s`;
  const play = await runJob(ENGINE, title, (sig) => playScripted(host, target, {
    inputs: Array.isArray(input.inputs) ? input.inputs : [], seconds: secondsToPlay, captureEveryMs: input.captureEveryMs === undefined ? 1000 : Number(input.captureEveryMs),
    width: Number(input.width) || 1280, height: Number(input.height) || 720, map: b ? undefined : map, outDir,
  }, { signal: sig }), { signal, timeoutMs: secondsToPlay * 1000 + 600_000 });
  const report = playReport({ id, build: b?.id ?? (b ? relTo(host, b.exe) : 'editor'), goal: input.goal, seconds: secondsToPlay, play, expect: Array.isArray(input.expect) ? input.expect : [], host, outDir });
  await writeJson(path.join(outDir, 'report.json'), report);
  if (proj.studioDir) {
    const sp = path.join(proj.studioDir, '.studio', 'project.json');
    const studio = await readJson(sp);
    if (studio) { studio.playtests = [...new Set([...(studio.playtests ?? []), id])]; await writeJson(sp, studio); }
  }
  const images = [];
  for (const f of sample(play.frames, Number(input.show) || 4)) { const i = await image(f); if (i) images.push(i); }
  const m = report.metrics;
  const ev = play.events.filter((e) => e.type !== 'driver').map((e) => `${e.t}s ${e.type}${e.detail ? ` ${e.detail}` : ''}`);
  return {
    ...result('play', report.result === 'pass' ? 'ok' : 'failed', `${b ? 'packaged build' : 'editor -game'} played ${secondsToPlay} s: ${report.result}; ${play.frames.length} frame(s)${m.fpsAvg ? `, ${m.fpsAvg} fps avg (${m.fpsMin} min), ${m.frameMsP95} ms p95` : ''}${m.memoryMb ? `, ${m.memoryMb} MB` : ''}, ${m.errors} error(s)${ev.length ? `; events: ${ev.slice(0, 12).join(', ')}${ev.length > 12 ? '...' : ''}` : ''}${notes.length ? `; ${notes.join('; ')}` : ''}`, {
      files: [relTo(host, path.join(outDir, 'report.json')), ...play.frames.slice(0, 3).map((f) => relTo(host, f))],
      logFile: relTo(host, play.logFile), problems: play.problems.filter((p) => p.severity === 'error').slice(0, 20),
      metrics: Object.fromEntries(Object.entries({ ...m, took: Math.round(play.run.took) }).filter(([, v]) => typeof v === 'number')),
      data: { playtest: id, result: report.result, events: play.events, issues: report.issues },
    }),
    images,
  };
}

async function doPlayStart(input, host, eng, proj, signal) {
  void signal;
  const id = String(input.id ?? `play-${players.size + 1}`);
  if (players.has(id)) return result('play.start', 'failed', `a step session ${id} is already running: stop it first`);
  const rd = await runDir(host, 'steps');
  const s = await startStepSession(host, eng, proj, { map: input.level, width: input.width, height: input.height, watch: input.watch, logFile: path.join(rd.dir, 'game.log') });
  s.dir = rd;
  s.proj = proj;
  players.set(id, s);
  return result('play.start', 'ok', `step session ${id} started in ${s.startupS} s (port ${s.port}); the game is paused until a step`, { data: { id, state: s.state }, logFile: relTo(host, path.join(rd.dir, 'game.log')) });
}

function playerOf(input) {
  const id = input.id ? String(input.id) : [...players.keys()].at(-1);
  const s = id && players.get(id);
  if (!s) throw new Error('no step session: start one with {"action": "play.start"}');
  return { id, s };
}

async function doPlayStep(input, host) {
  const { id, s } = playerOf(input);
  if (s.child.exitCode !== null) { players.delete(id); return result('play.step', 'failed', `the game of ${id} has exited (code ${s.child.exitCode})`); }
  const keys = (Array.isArray(input.keys) ? input.keys : input.key ? [input.key] : []).map((k) => (k.toLowerCase?.() === 'jump' || k.toLowerCase?.() === 'space' ? 'SpaceBar' : String(k)));
  const req = { op: 'step', ms: Math.min(Math.max(Number(input.ms) || 250, 16), 10_000), keys, actions: Array.isArray(input.actions) ? input.actions : [], look: input.look, capture: input.capture !== false, width: input.width, height: input.height };
  const r = await s.client.request(req, 60_000 + req.ms);
  if (!r.ok) return result('play.step', 'failed', r.error ?? 'the step failed', { data: r });
  s.step += 1;
  const images = [];
  const files = [];
  if (r.frame) {
    const to = path.join(s.dir.dir, `step-${String(s.step).padStart(4, '0')}.png`);
    await fsp.rename(r.frame, to).catch(() => fsp.copyFile(r.frame, to));
    files.push(relTo(host, to));
    const i = await image(to);
    if (i) images.push(i);
  }
  const st = r.state ?? {};
  return {
    ...result('play.step', 'ok', `step ${s.step}: ${req.ms} ms with ${keys.join('+') || 'no keys'}${st.pawn ? `; pawn at ${st.pawn.location.join(', ')}` : ''}${st.vars && Object.keys(st.vars).length ? `; ${Object.entries(st.vars).map(([k, v]) => `${k}=${v}`).join(', ')}` : ''}`, { files, data: { id, state: st, wallMs: r.wallMs } }),
    images,
  };
}

// ---------- bridge ----------

async function doBridge(action, input, host, eng, proj, signal) {
  if (action === 'bridge.status') {
    const list = [];
    for (const [k, s] of bridges) {
      let alive = s.child ? s.child.exitCode === null : true;
      try { await s.client.info(); } catch { alive = false; }
      list.push({ project: relTo(host, k), httpPort: s.httpPort, wsPort: s.wsPort, alive, launched: !!s.child, upS: Math.round((Date.now() - s.startedAt) / 1000) });
    }
    return result('bridge.status', 'ok', list.length ? `${list.length} live editor(s): ${list.map((l) => `${l.project} on ${l.httpPort}${l.alive ? '' : ' (not answering)'}`).join(', ')}` : 'no live editor connected', { data: { editors: list, steps: [...players.keys()] } });
  }
  if (action === 'bridge.connect') {
    if (bridges.has(proj.file)) return result('bridge.connect', 'ok', `already connected to ${proj.rel} on port ${bridges.get(proj.file).httpPort}`);
    if (input.port) {
      // Attaching to an editor someone opened: only when asked for by port.
      const client = rcClient(Number(input.port));
      await client.info();
      bridges.set(proj.file, { client, httpPort: Number(input.port), startedAt: Date.now(), attached: true });
      return result('bridge.connect', 'ok', `attached to the Remote Control server on port ${input.port} (an editor this tool did not start: it will not be closed)`);
    }
    const rd = await runDir(host, 'bridge');
    const log = path.join(rd.dir, 'editor.log');
    await installHelpers(proj.dir);
    const t0 = Date.now();
    const s = await launchEditor({ editor: eng.bin.editor, uproject: proj.file, log, offscreen: input.window !== true });
    try { await waitForRc(s.client, { child: s.child, signal, timeoutMs: seconds(input.timeoutSec, 600) }); } catch (e) {
      await stopEditor(s).catch(() => {});
      return result('bridge.connect', 'failed', e.message, { logFile: relTo(host, log) });
    }
    bridges.set(proj.file, { ...s, startedAt: Date.now() });
    return result('bridge.connect', 'ok', `editor for ${proj.rel} is live on Remote Control port ${s.httpPort} (WebSocket ${s.wsPort}, bound to 127.0.0.1) after ${secs((Date.now() - t0) / 1000)}${input.window === true ? '' : '; it renders off screen'}`, { logFile: relTo(host, log), data: { httpPort: s.httpPort, wsPort: s.wsPort } });
  }
  const s = bridges.get(proj.file);
  if (!s) return result(action, 'failed', 'no live editor for this project: {"action": "bridge.connect"} first');
  if (action === 'bridge.disconnect') {
    bridges.delete(proj.file);
    if (s.attached) return result('bridge.disconnect', 'ok', 'detached (the editor keeps running: this tool did not start it)');
    return result('bridge.disconnect', 'ok', `editor ${await stopEditor(s)}`);
  }
  if (action === 'bridge.call') {
    const r = await s.client.call(String(input.objectPath), String(input.function), input.parameters ?? {}, input.transaction === true);
    return result('bridge.call', 'ok', `${input.function} on ${input.objectPath}`, { data: r });
  }
  if (action === 'bridge.property') {
    const r = input.value === undefined ? await s.client.get(String(input.objectPath), input.property ? String(input.property) : undefined) : await s.client.set(String(input.objectPath), String(input.property), input.value);
    return result('bridge.property', 'ok', `${input.value === undefined ? 'read' : 'set'} ${input.property ?? 'all properties'} of ${input.objectPath}`, { data: r });
  }
  if (action === 'bridge.python') {
    const code = String(input.code ?? '');
    const r = await s.client.python(`import sys\nsys.path.insert(0, ${py(path.join(proj.dir, 'Content', 'Python').replace(/\\/g, '/'))})\n${code}`);
    const { resultsIn } = await import('./lib/logs.mjs');
    const res = resultsIn(r.output);
    return result('bridge.python', r.ok ? 'ok' : 'failed', r.ok ? 'ran in the live editor' : 'raised in the live editor', { log: tail(`${r.output}\n${r.result}`, 60), data: { result: r.result, ...Object.fromEntries(Object.entries(res).filter(([k]) => k !== 'all')) } });
  }
  if (action === 'bridge.presets') {
    const r = input.name ? await s.client.preset(String(input.name)) : await s.client.presets();
    return result('bridge.presets', 'ok', input.name ? `preset ${input.name}` : 'Remote Control presets', { data: r });
  }
  return result(action, 'failed', `unknown bridge action ${action}`);
}

// ---------- assets ----------

async function doImport(input, host, eng, proj, signal) {
  const files = (Array.isArray(input.files) ? input.files : input.file ? [input.file] : []).map(String);
  if (!files.length) return result('asset.import', 'failed', 'files: workspace paths of .glb/.gltf/.fbx/.obj/.png/.jpg/.wav... to import');
  const abs = [];
  for (const f of files) {
    const a = path.resolve(host.root, f);
    if (relTo(host, a).startsWith('..')) return result('asset.import', 'failed', `${f} is outside the workspace`);
    if (!await exists(a)) return result('asset.import', 'failed', `${f} does not exist`);
    abs.push(a.replace(/\\/g, '/'));
  }
  const dest = String(input.dest ?? '/Game/Imported');
  if (!dest.startsWith('/Game')) return result('asset.import', 'failed', 'dest is a content folder under /Game');
  const r = await runPython(host, eng, proj, { code: `import harness_ue as h\nh.result("imported", h.import_files(${py(abs)}, ${py(dest)}, replace=${input.replace === false ? 'False' : 'True'}))\nh.save()\n`, timeoutMs: seconds(input.timeoutSec, 900), signal, kind: 'imports' });
  const got = r.results.imported ?? [];
  // Studio's asset manifests learn where each file went (FORMATS.md: engines.unreal).
  for (const f of abs) {
    const manifest = path.join(path.dirname(f), 'asset.json');
    const m = await readJson(manifest);
    if (m && got.length) { m.engines = { ...(m.engines ?? {}), unreal: { path: dest, assets: got.slice(0, 20), importedAt: new Date().toISOString() } }; await writeJson(manifest, m); }
  }
  return result('asset.import', !r.failed && got.length ? 'ok' : 'failed', `${got.length} asset(s) imported into ${dest} in ${secs(r.took)}`, { data: { assets: got }, problems: r.problems.slice(0, 20), logFile: r.logFile });
}

async function doExport(input, host, eng, proj, signal) {
  if (!input.asset || !input.out) return result('asset.export', 'failed', 'asset (/Game/...) and out (a workspace file: .fbx, .obj, .gltf, .glb, .png...) are needed');
  const out = path.resolve(host.root, String(input.out));
  if (relTo(host, out).startsWith('..')) return result('asset.export', 'failed', 'out must be in the workspace');
  await fsp.mkdir(path.dirname(out), { recursive: true });
  const r = await runPython(host, eng, proj, { code: `import harness_ue as h\nh.result("exported", h.export_asset(${py(input.asset)}, ${py(out.replace(/\\/g, '/'))}))\n`, timeoutMs: seconds(input.timeoutSec, 600), signal, kind: 'exports' });
  const ok = !r.failed && await exists(out);
  return result('asset.export', ok ? 'ok' : 'failed', ok ? `${input.asset} exported to ${input.out} (${Math.round((await fsp.stat(out)).size / 1024)} KB)` : `${input.asset} was not exported`, { files: ok ? [String(input.out)] : [], problems: r.problems.slice(0, 20), logFile: r.logFile });
}

function doJobs(input) {
  if (input.cancel) return result('jobs', cancelJob(String(input.cancel)) ? 'ok' : 'failed', `cancel ${input.cancel}`);
  const jobs = listJobs().filter((j) => j.engine === ENGINE).map((j) => ({ ...j, progress: progress.get(j.title) ?? null }));
  return result('jobs', 'ok', jobs.length ? jobs.map((j) => `${j.id} ${j.title}: ${j.status}${j.progress ? ` (${j.progress.stage} ${j.progress.pct}%)` : ''}`).join('; ') : 'no Unreal jobs in the last hour', { data: { jobs } });
}

// ---------- the tool ----------

const ACTIONS = ['detect', 'project.create', 'describe', 'script', 'capture', 'render', 'test', 'build', 'package', 'play', 'play.start', 'play.step', 'play.state', 'play.stop', 'bridge.connect', 'bridge.status', 'bridge.call', 'bridge.property', 'bridge.python', 'bridge.presets', 'bridge.disconnect', 'asset.import', 'asset.export', 'jobs'];

export async function runUnreal(input, { host, signal }) {
  const action = String(input.action ?? 'detect');
  if (!ACTIONS.includes(action)) return result(action, 'failed', `unknown action ${action}; actions: ${ACTIONS.join(', ')}`);
  if (action === 'detect') return doDetect(input, host);
  if (action === 'jobs') return doJobs(input);
  const eng = await engine();
  if (!eng) return unavailable(ENGINE, action, (await engineReport()).gaps[0]);
  if (action === 'project.create') return doCreate(input, host, eng, signal);
  if (action === 'bridge.status') return doBridge(action, input, host, eng, null, signal);
  if (action === 'play.step') return doPlayStep(input, host);
  if (action === 'play.state' || action === 'play.stop') {
    const { id, s } = playerOf(input);
    if (action === 'play.stop') { players.delete(id); const ok = await stopStepSession(s); return result('play.stop', 'ok', `step session ${id} ${ok ? 'closed' : 'killed'} after ${s.step} step(s)`); }
    const r = await s.client.request({ op: 'state' });
    return result('play.state', r.ok ? 'ok' : 'failed', r.ok ? `frame ${r.state.frame}, game time ${r.state.gameMs} ms` : r.error, { data: { id, state: r.state } });
  }
  const proj = await projectOf(host, input.project);
  switch (action) {
    case 'describe': return doDescribe(input, host, eng, proj, signal);
    case 'script': return doScript(input, host, eng, proj, signal);
    case 'capture': return doCapture(input, host, eng, proj, signal);
    case 'render': return doRender(input, host, eng, proj, signal);
    case 'test': return doTest(input, host, eng, proj, signal);
    case 'build': case 'package': return doPackage(input, host, eng, proj, signal, action);
    case 'play': return doPlay(input, host, eng, proj, signal);
    case 'play.start': return doPlayStart(input, host, eng, proj, signal);
    case 'asset.import': return doImport(input, host, eng, proj, signal);
    case 'asset.export': return doExport(input, host, eng, proj, signal);
    default: return doBridge(action, input, host, eng, proj, signal);
  }
}

const vec3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };

export const TOOL = {
  name: 'unreal',
  description: [
    'Unreal Engine 5 on this machine, Blueprint and Python first (load the unreal-essentials skill first). Actions:',
    'detect (installs, version, gaps such as no MSVC, actions offered);',
    'project.create {name, template: TP_ThirdPersonBP|TP_FirstPersonBP|TP_TopDownBP|TP_BlankBP, setup?: sidescroller|topdown-2d, dir?} (Python and Remote Control on, .studio/project.json);',
    'describe {level?} (levels, actors, assets, Blueprints with variables, functions and components, settings);',
    'script {code|file, args?, mode?: editor|commandlet, rendering?, live?} (editor Python with `import harness_ue as h`; h.result(tag, data) hands data back);',
    'capture {level?, at?, rotation?, target?, camera?, view: game|editor, width, height} (a PNG you see);',
    'render {turntable: {target, radius, height, seconds, fps} | sequence, level?} (Movie Render Queue, a heavy job);',
    'test {filter?: "Project.Functional Tests", checks?: Python using h.check(name, ok)} (Automation tests and checks, structured);',
    'build / package {config: Development|Shipping} (RunUAT BuildCookRun for Win64, a heavy job; package records the build);',
    'play {seconds, inputs: [{at, key, ms} | {at, console}], captureEveryMs, build?: latest|<id>|editor, expect?: ["win"]} (scripted run: frames, fps, memory, errors, a playtest report);',
    'play.start {level?, watch?} / play.step {keys, ms, look?, capture} / play.state / play.stop (the paused step server for an AI player);',
    'bridge.connect / bridge.status / bridge.call {objectPath, function, parameters} / bridge.property {objectPath, property, value?} / bridge.python {code} / bridge.presets / bridge.disconnect (Remote Control on an editor this tool launches);',
    'asset.import {files, dest} / asset.export {asset, out}; jobs {cancel?}.',
    'project: the .uproject or its Studio folder (default: the only one in the workspace). Editor runs take 20-60 s to start; a first cook several minutes.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ACTIONS },
      project: { type: 'string', description: 'The .uproject, its folder, or the Studio folder (default: the only one in the workspace)' },
      name: { type: 'string', description: 'project.create: the project name (letters, digits, _; at most 20)' },
      template: { type: 'string', description: 'project.create: TP_ThirdPersonBP (default), TP_FirstPersonBP, TP_TopDownBP, TP_BlankBP' },
      variant: { type: 'string', description: 'project.create: a template variant (Combat, Platforming, SideScroller...); variants with AI need a C++ toolchain to package' },
      setup: { type: 'string', enum: Object.keys(SETUPS), description: 'project.create: a 2D/2.5D setup applied with Python (orthographic camera; sidescroller locks movement to a plane)' },
      dir: { type: 'string', description: 'project.create: the Studio folder in the workspace (default: the name); the Unreal project goes in <dir>/Game' },
      code: { type: 'string', description: 'script: Python to run in the editor; bridge.python: Python for the live editor' },
      file: { type: 'string', description: 'script: a .py file in the workspace' },
      args: { type: 'array', items: { type: 'string' }, description: 'script: sys.argv[1:] for the script' },
      mode: { type: 'string', enum: ['editor', 'commandlet'], description: 'script: the whole editor (default) or the pythonscript commandlet' },
      rendering: { type: 'boolean', description: 'script/test: run with the GPU (default -nullrhi)' },
      keepAlive: { type: 'boolean', description: 'script: keep the editor running after the script returns, until it calls unreal.SystemLibrary.quit_editor() (for work over several frames)' },
      live: { type: 'boolean', description: 'script: run in the live editor (bridge.connect first)' },
      level: { type: 'string', description: 'A level (map) asset path, e.g. /Game/Levels/Lvl_Coins' },
      view: { type: 'string', enum: ['game', 'editor'], description: 'capture: the game as played (default; a camera put at `at` when given) or an editor scene capture' },
      at: { ...vec3, description: 'capture: camera location (cm)' },
      rotation: { ...vec3, description: 'capture: camera rotation [pitch, yaw, roll]' },
      target: { ...vec3, description: 'capture: a point the camera looks at' },
      camera: { type: 'string', description: 'capture (editor view): the label of a CameraActor in the level' },
      fov: { type: 'number' },
      frames: { type: 'number', description: 'capture: frames to wait before the shot (default 90)' },
      width: { type: 'number' }, height: { type: 'number' },
      out: { type: 'string', description: 'capture: the PNG to write; render/package: the folder; asset.export: the file' },
      turntable: { type: 'object', description: 'render: {target: [x,y,z], radius, height, seconds, fps}' },
      sequence: { type: 'string', description: 'render: a Level Sequence asset to render instead of a turntable' },
      format: { type: 'string', enum: ['png', 'jpg', 'exr'] },
      filter: { type: 'string', description: 'test: Automation filter (default "Project"; "Project.Functional Tests" for functional test actors)' },
      checks: { type: 'string', description: 'test: Python checks using h.check(name, ok, detail) (run in the editor before the Automation tests)' },
      automation: { type: 'boolean', description: 'test: false to run only the checks' },
      config: { type: 'string', enum: ['Development', 'Shipping', 'DebugGame'] },
      platform: { type: 'string', description: 'build/package: Win64 (default)' },
      clean: { type: 'boolean', description: 'package: a clean cook' },
      playDriver: { type: 'boolean', description: 'package: put the play driver in the default level first (default true; it is inert without -HarnessTimeline)' },
      id: { type: 'string', description: 'package: the build id (default b<n>); play.*: the step session' },
      build: { type: 'string', description: 'play: latest (default when a build exists), a build id, a path to the exe, or editor' },
      editor: { type: 'boolean', description: 'play: play in the editor (-game) even when a build exists' },
      seconds: { type: 'number', description: 'play: how long to play (default 10)' },
      inputs: { type: 'array', items: { type: 'object' }, description: 'play: [{at: ms, key: "W", ms: 1500}, {at, action: "IA_Jump"}, {at, console: "stat fps"}]' },
      captureEveryMs: { type: 'number', description: 'play: a frame every k ms (default 1000; 0 for none)' },
      expect: { type: 'array', items: { type: 'string' }, description: 'play: HARNESS_EVENT types that must happen (e.g. ["win"]) for a pass' },
      goal: { type: 'string', description: 'play: what the run should show (for the report)' },
      show: { type: 'number', description: 'play: frames to look at (default 4)' },
      keys: { type: 'array', items: { type: 'string' }, description: 'play.step: keys held for the step (W, A, S, D, SpaceBar...)' },
      actions: { type: 'array', items: { type: 'object' }, description: 'play.step: [{name: "IA_Jump", value: "true"}]' },
      look: { type: 'array', items: { type: 'number' }, description: 'play.step: [yaw, pitch] added to the view' },
      ms: { type: 'number', description: 'play.step: game time to play (default 250)' },
      capture: { type: 'boolean', description: 'play.step: take a frame after the step (default true)' },
      watch: { type: 'array', items: { type: 'string' }, description: 'play.start: Blueprint class paths whose actors each state counts, e.g. /Game/CoinKit/BP_Coin.BP_Coin_C' },
      objectPath: { type: 'string' }, function: { type: 'string' }, parameters: { type: 'object' }, property: { type: 'string' }, value: {}, transaction: { type: 'boolean' },
      port: { type: 'number', description: 'bridge.connect: attach to an editor already serving Remote Control on this port (only when the person asks)' },
      window: { type: 'boolean', description: 'bridge.connect: show the editor window (default off screen)' },
      files: { type: 'array', items: { type: 'string' }, description: 'asset.import: workspace files' },
      dest: { type: 'string', description: 'asset.import: /Game folder (default /Game/Imported)' },
      replace: { type: 'boolean' },
      asset: { type: 'string', description: 'asset.export: the asset path' },
      cancel: { type: 'string', description: 'jobs: a job id to cancel' },
      timeoutSec: { type: 'number' },
      maxActors: { type: 'number' },
      description: { type: 'string' }, genre: { type: 'string' }, firstRun: { type: 'boolean' },
    },
    required: ['action'],
  },
};

// ---------- gates ----------

async function uprojects(host) {
  const { findUprojects } = await import('./lib/project.mjs');
  return host.kind === 'local' ? findUprojects(host.root, { max: 4, depth: 3 }) : [];
}

const notChecked = (why) => ({ pass: false, severity: 'advisory', summary: `not checked: ${why}` });

export const GATES = [
  {
    name: 'unreal-project',
    description: 'Each Unreal project (.uproject) in the workspace loads in the editor: every level loads and every Blueprint under /Game compiles without errors.',
    applies: async (host) => (await uprojects(host)).length > 0,
    async run({ host, signal }) {
      const eng = await engine();
      if (!eng) return notChecked('Unreal Engine is not installed');
      const bad = [];
      const ok = [];
      for (const u of await uprojects(host)) {
        const proj = await projectOf(host, u);
        const r = await runPython(host, eng, proj, { code: 'import harness_ue as h\nh.result("check", h.check_project())\n', timeoutMs: 1_200_000, signal, kind: 'gates' });
        const c = r.results.check;
        const errs = [...(c?.errors ?? []), ...r.fatal.map((p) => p.message)];
        if (!c || errs.length) bad.push(`${u}: ${errs.length ? errs.slice(0, 15).join('; ') : `the check did not finish (exit ${r.code})`} (log ${r.logFile})`);
        else ok.push(`${u} (${c.levels} level(s), ${c.blueprints} Blueprint(s))`);
      }
      return bad.length ? { pass: false, summary: `${bad.length} Unreal project(s) with errors`, details: bad.join('\n') } : { pass: true, summary: `Unreal project(s) load and compile: ${ok.join(', ')}` };
    },
  },
  {
    name: 'unreal-package',
    description: 'The Unreal project has a packaged build (unreal package): the latest build in .studio/project.json exists and is newer than the content.',
    applies: async (host) => (await uprojects(host)).length > 0,
    async run({ host }) {
      const bad = [];
      const ok = [];
      for (const u of await uprojects(host)) {
        const proj = await projectOf(host, u);
        const studio = proj.studioDir ? await readJson(path.join(proj.studioDir, '.studio', 'project.json')) : null;
        const b = (studio?.builds ?? []).filter((x) => x.status === 'ok').at(-1);
        if (!b) { bad.push(`${u}: no packaged build; run {"action": "package"}`); continue; }
        const exe = path.join(proj.studioDir, b.path);
        if (!await exists(exe)) { bad.push(`${u}: build ${b.id} is recorded but ${relTo(host, exe)} is gone`); continue; }
        const built = (await fsp.stat(exe)).mtimeMs;
        const { filesSince } = await import('./lib/play.mjs');
        const newer = (await filesSince(path.join(proj.dir, 'Content'), built + 60_000, (n) => /\.(uasset|umap)$/.test(n))).length;
        if (newer) bad.push(`${u}: ${newer} content file(s) changed after build ${b.id}; package again`);
        else ok.push(`${u}: ${b.id} (${b.config}, ${b.sizeMb ?? '?'} MB)`);
      }
      return bad.length ? { pass: false, summary: `${bad.length} project(s) without a current build`, details: bad.join('\n') } : { pass: true, summary: `packaged: ${ok.join(', ')}` };
    },
  },
  {
    name: 'unreal-automation',
    description: 'The Unreal project\'s own Automation tests (filter "Project": functional tests in its levels and its Python tests) run and pass; at least one must exist.',
    applies: async (host) => (await uprojects(host)).length > 0,
    async run({ host, signal }) {
      const eng = await engine();
      if (!eng) return notChecked('Unreal Engine is not installed');
      const bad = [];
      const ok = [];
      for (const u of await uprojects(host)) {
        const r = await runUnreal({ action: 'test', project: u, filter: 'Project' }, { host, signal });
        const a = r.data?.automation;
        if (r.status !== 'ok') bad.push(`${u}: ${r.summary}${r.problems?.length ? `\n  ${r.problems.slice(0, 10).map((p) => p.message).join('\n  ')}` : ''}`);
        else ok.push(`${u}: ${a?.passed ?? 0} passed`);
      }
      return bad.length ? { pass: false, summary: `Automation failed for ${bad.length} project(s)`, details: bad.join('\n') } : { pass: true, summary: `Automation tests pass: ${ok.join(', ')}` };
    },
  },
];

export default {
  name: 'engine-unreal',
  setup(api) {
    api.registerTool(defineTool({
      ...TOOL,
      kind: 'exec',
      availableIn: (host) => host.kind === 'local',
      summarize: (i) => `${i.action}${i.project ? ` ${i.project}` : ''}${i.name ? ` ${i.name}` : ''}${i.level ? ` ${i.level}` : ''}`,
      async run(input, ctx) {
        try {
          const { images, ...r } = await runUnreal(input, ctx);
          return toToolResult(r, images ?? []);
        } catch (e) {
          return toToolResult(result(String(input.action ?? ''), 'failed', e.message));
        }
      },
    }));
    for (const g of GATES) api.registerGate(g);
  },
  async close() {
    for (const s of players.values()) await stopStepSession(s).catch(() => {});
    players.clear();
    for (const s of bridges.values()) if (!s.attached) await stopEditor(s).catch(() => {});
    bridges.clear();
  },
};
