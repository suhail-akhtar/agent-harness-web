// Playtests: a run that proves a game works, written as .studio/playtests/<id>/ (sdk/FORMATS.md):
// report.json, frames/NNNN.png (evidence and samples), playthrough.gif, and inputs-<n>.json for
// each segment, so any bug it found replays exactly (game_bot mode scripted).
//
// Segments, in order:
//   boot     web games: the real clock for a few seconds with light input: fps, boot errors, a blank screen
//   bots     each bot mode (default goal, then explore, then monkey) on the fixed clock, from a fresh start
//   ai       game_play sessions the agent played (their saved summaries in .studio/recordings)
//   replays  every .studio/regressions/*.json: the recording again, and its expectations
// Then the checks (state claims), the issues with evidence, and the result.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { encodeGif } from './gif.mjs';
import { resize } from './frames.mjs';
import { runBot, BOT_MODES } from './bots.mjs';
import { describeCheck, evaluateCheck, frameNear, sample } from './verdicts.mjs';

export const RESULTS = ['pass', 'fail', 'crash', 'timeout'];
export const SEVERITIES = ['blocker', 'major', 'minor'];
const exists = (f) => fsp.stat(f).then(() => true, () => false);
const r1 = (v) => Math.round(v * 10) / 10;

/** The project folder for a game: the nearest folder up from it holding .studio/project.json, else the workspace root. */
export async function projectDir(root, game) {
  let dir = game ? path.posix.dirname(String(game).replace(/\\/g, '/')) : '.';
  for (;;) {
    if (await exists(path.join(root, dir, '.studio', 'project.json'))) return dir;
    if (dir === '.' || dir === '' || dir === '/') return '.';
    dir = path.posix.dirname(dir);
  }
}

export async function readProject(root, dir = '.') {
  try { return JSON.parse(await fsp.readFile(path.join(root, dir, '.studio', 'project.json'), 'utf8')); } catch { return null; }
}

/** A new playtest id: pt-YYYYMMDD-N. */
export async function newPlaytestId(root, dir = '.') {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  let names = [];
  try { names = await fsp.readdir(path.join(root, dir, '.studio', 'playtests')); } catch { /* none yet */ }
  const n = names.filter((x) => x.startsWith(`pt-${day}-`)).map((x) => Number(x.split('-')[2]) || 0);
  return `pt-${day}-${(n.length ? Math.max(...n) : 0) + 1}`;
}

/** The latest playtest of a project: the last in project.json's list that exists, else the newest folder. */
export async function latestReport(root, dir = '.') {
  const base = path.join(root, dir, '.studio', 'playtests');
  const project = await readProject(root, dir);
  const listed = Array.isArray(project?.playtests) ? [...project.playtests].reverse() : [];
  let ids = listed;
  try {
    const all = (await fsp.readdir(base, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    const stats = await Promise.all(all.map(async (id) => ({ id, m: (await fsp.stat(path.join(base, id, 'report.json')).catch(() => null))?.mtimeMs ?? 0 })));
    const byTime = stats.filter((s) => s.m).sort((a, b) => b.m - a.m).map((s) => s.id);
    ids = [...new Set([...(byTime.length ? [byTime[0]] : []), ...listed, ...byTime])];
  } catch { /* no folder */ }
  for (const id of ids) {
    try { return { id, dir: path.posix.join(dir, '.studio', 'playtests', id), report: JSON.parse(await fsp.readFile(path.join(base, id, 'report.json'), 'utf8')) }; } catch { /* missing or broken */ }
  }
  return null;
}

/** What is wrong with a report's shape (FORMATS.md), as a list; empty when it is fine. */
export function validateReport(r) {
  const bad = [];
  if (!r || typeof r !== 'object') return ['not an object'];
  if (typeof r.id !== 'string' || !/^pt-/.test(r.id)) bad.push('id: a string starting with pt-');
  if (typeof r.engine !== 'string') bad.push('engine: a string');
  if (typeof r.player !== 'string' || !/^(ai|person|bot:[a-z]+)$/.test(r.player)) bad.push('player: ai | person | bot:<mode>');
  if (!RESULTS.includes(r.result)) bad.push(`result: one of ${RESULTS.join(', ')}`);
  if (typeof r.durationS !== 'number') bad.push('durationS: a number');
  if (!Number.isInteger(r.steps)) bad.push('steps: an integer');
  if (!Array.isArray(r.events) || r.events.some((e) => typeof e?.t !== 'number' || typeof e?.type !== 'string')) bad.push('events: [{t, type, detail}]');
  if (!r.metrics || typeof r.metrics !== 'object' || typeof r.metrics.errors !== 'number') bad.push('metrics: {..., errors: number}');
  if (!Array.isArray(r.frames) || r.frames.some((f) => typeof f !== 'string')) bad.push('frames: [paths]');
  if (r.recording !== undefined && r.recording !== null && typeof r.recording !== 'string') bad.push('recording: a path');
  if (!Array.isArray(r.issues) || r.issues.some((i) => !SEVERITIES.includes(i?.severity) || typeof i?.title !== 'string')) bad.push('issues: [{severity: blocker|major|minor, title, evidence?}]');
  if (!Array.isArray(r.verdicts) || r.verdicts.some((v) => typeof v?.by !== 'string' || typeof v?.claim !== 'string' || typeof v?.pass !== 'boolean')) bad.push('verdicts: [{by, claim, pass, evidence?}]');
  return bad;
}

/** pass, fail or crash from what a report holds. */
export function resultOf(r) {
  if (r.crashes?.length || r.events?.some((e) => e.type === 'crash')) return 'crash';
  if (r.issues.some((i) => i.severity === 'blocker' || i.severity === 'major')) return 'fail';
  if (r.verdicts.some((v) => !v.pass)) return 'fail';
  if (r.goal && !r.goalReached) return 'fail';
  if (r.timedOut && !r.goalReached) return 'timeout';
  return 'pass';
}

/** A one-line-per-thing summary agents and gates read. */
export function describeReport(r, dir) {
  const lines = [`Playtest ${r.id}: ${r.result.toUpperCase()} (${r.engine}, ${r.players?.join(' + ') ?? r.player}, ${r.durationS}s of play, ${r.steps} steps)${dir ? ` - ${dir}/report.json` : ''}`];
  if (r.goal) lines.push(`Goal: ${r.goal} - ${r.goalReached ? `reached${r.goalReachedBy ? ` by ${r.goalReachedBy}` : ''}` : 'NOT reached'}`);
  const m = r.metrics;
  lines.push(`Metrics: ${Object.entries(m).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  for (const s of r.segments ?? []) lines.push(`- ${s.player}: ${s.durationS}s, ${s.steps} steps${s.coverage ? `, ${s.coverage} places` : ''}${s.goalReached ? ', goal reached' : ''}${s.crashed ? ', CRASHED' : ''}${s.softlocks ? `, ${s.softlocks} softlock(s)` : ''}${s.recording ? ` (replay: ${s.recording})` : ''}`);
  const kinds = {};
  for (const e of r.events) kinds[e.type] = (kinds[e.type] ?? 0) + 1;
  if (Object.keys(kinds).length) lines.push(`Events: ${Object.entries(kinds).map(([k, n]) => `${k} x${n}`).join(', ')}`);
  if (r.issues.length) lines.push('Issues:', ...r.issues.map((i) => `- [${i.severity.toUpperCase()}] ${i.title}${i.evidence ? ` (evidence: ${i.evidence})` : ''}${i.replay ? ` (replay: ${i.replay})` : ''}`));
  if (r.verdicts.length) lines.push('Verdicts:', ...r.verdicts.map((v) => `- ${v.pass ? 'PASS' : 'FAIL'} [${v.by}] ${v.claim}${v.detail ? `: ${v.detail}` : ''}${v.evidence ? ` (${v.evidence})` : ''}`));
  if (r.errors?.length) lines.push(`Errors (${r.errors.length}):`, ...r.errors.slice(0, 5).map((e) => `  ${e.split('\n')[0]}`));
  if (r.recording) lines.push(`Recording: ${dir ? `${dir}/` : ''}${r.recording}`);
  return lines.join('\n');
}

/** An animated GIF of run frames: up to `max`, evenly spread, `width` wide, timed by game time. */
export function recordingGif(frames, { max = 60, width = 320 } = {}) {
  const usable = frames.filter((f) => f.img);
  if (!usable.length) return null;
  const step = Math.max(1, usable.length / max);
  const picked = [];
  for (let i = 0; i < usable.length && picked.length < max; i += step) picked.push(usable[Math.floor(i)]);
  const imgs = picked.map((f) => resize(f.img, width));
  const delays = picked.map((f, i) => Math.min(600, Math.max(80, ((picked[i + 1]?.t ?? f.t + 300) - f.t) / 2)));
  return encodeGif(imgs, { delays });
}

/**
 * Runs a playtest. start(opts) opens a driver session; write(rel, data) writes a workspace file;
 * read(rel) reads one (or null). Returns { report, dir, text }.
 */
export async function runPlaytest({ start, write, read, list, signal }, opts = {}) {
  const t0 = Date.now();
  const dirProject = opts.projectDir ?? '.';
  const id = opts.id ?? `pt-${Date.now()}`;
  const rel = path.posix.join(dirProject, '.studio', 'playtests', id);
  const project = opts.project ?? null;
  const fpsBudget = Number(opts.fpsBudget ?? project?.budgets?.fps ?? 30);
  const seconds = Math.min(Math.max(Number(opts.seconds) || 60, 5), 600);
  const bots = (opts.bots ?? ['goal', 'explore', 'monkey']).map((b) => (typeof b === 'string' ? { mode: b } : b)).filter((b) => BOT_MODES.includes(b.mode) && b.mode !== 'scripted');
  const base = { game: opts.game, query: opts.query, seed: opts.seed ?? 1, viewport: opts.viewport, engine: opts.engine };
  const segments = [];
  const allFrames = [];
  const events = [];
  const errors = [];
  const verdicts = [];
  const issues = [];
  const console_ = [];
  let engine = opts.engine ?? 'web';
  let metrics = { errors: 0 };
  let goalReached = false, goalReachedBy = null;
  let timedOut = false;
  const wallEnd = t0 + (opts.wallMs ?? 10 * 60_000);
  const perCheck = [];
  const addFrames = (frames, seg) => frames.map((f) => { allFrames.push({ ...f, seg }); return allFrames.length - 1; });

  // 1. Boot on the real clock: fps, errors while starting, a blank screen.
  if (opts.boot !== false && (opts.engine ?? 'web') === 'web') {
    const s = await start({ ...base, clock: 'real', bootMs: 0 });
    engine = s.engine ?? engine;
    try {
      const bootS = Math.min(Math.max(Number(opts.bootSeconds) || 4, 1), 20);
      const run = await runBot(s, { mode: 'monkey', seconds: bootS, seed: base.seed, frameEveryMs: 1000, maxFrames: 6, frameWidth: 480, signal });
      const fin = await s.stop();
      Object.assign(metrics, fin.metrics ?? {});
      console_.push(...(fin.console ?? []));
      const idx = addFrames(run.frames, segments.length);
      const blank = run.frames.length && run.frames.every((f) => f.stats?.blank);
      segments.push({ player: 'bot:monkey', mode: 'boot', clock: 'real', durationS: run.durationS, steps: run.steps, crashed: run.crashed });
      for (const e of run.events) events.push({ ...e, segment: 'boot', ...(e.frame !== undefined ? { frame: idx[e.frame] } : {}) });
      errors.push(...run.errors);
      if (blank) issues.push({ severity: 'blocker', title: `The screen stays blank for the first ${bootS}s`, evidence: idx[0], segment: 'boot' });
      if (fin.missing?.length) issues.push({ severity: 'major', title: `Files are missing: ${fin.missing.slice(0, 3).join(', ')}`, segment: 'boot' });
      if (fin.blocked?.length) issues.push({ severity: 'major', title: `The game needs the network (blocked offline): ${fin.blocked.slice(0, 2).join(', ')}`, segment: 'boot' });
    } catch (e) { await s.stop().catch(() => {}); throw e; }
  }

  // 2. Bots on the fixed clock, each from a fresh start.
  for (const [n, b] of bots.entries()) {
    if (signal?.aborted || Date.now() > wallEnd) { timedOut = true; break; }
    const s = await start({ ...base, clock: 'fixed' });
    engine = s.engine ?? engine;
    let run, fin;
    try {
      run = await runBot(s, { mode: b.mode, seconds: b.seconds ?? (b.mode === 'monkey' ? Math.min(20, seconds) : seconds), seed: (base.seed ?? 1) + n, stopOnGoal: b.mode !== 'monkey', frameWidth: 480, maxFrames: 60, wallMs: Math.max(10_000, wallEnd - Date.now()), signal });
    } finally { fin = await s.stop(); }
    const recName = `inputs-${segments.length + 1}.json`;
    await write(path.posix.join(rel, recName), Buffer.from(JSON.stringify(fin.recording, null, 1)));
    const idx = addFrames(run.frames, segments.length);
    const seg = { player: `bot:${b.mode}`, mode: b.mode, clock: 'fixed', durationS: run.durationS, steps: run.steps, coverage: run.coverage.cells, goalReached: run.goalReached, crashed: run.crashed, softlocks: run.softlocks.length, stuck: run.stuck.length, recording: recName };
    segments.push(seg);
    for (const e of run.events) events.push({ ...e, segment: seg.player, ...(e.frame !== undefined ? { frame: idx[e.frame] } : {}) });
    errors.push(...run.errors);
    console_.push(...(fin.console ?? []));
    if (run.goalReached && !goalReached) { goalReached = true; goalReachedBy = seg.player; }
    if (run.timedOut) timedOut = true;
    for (const [k, c] of (opts.checks ?? []).entries()) (perCheck[k] ??= []).push({ ...evaluateCheck(c, run.samples), segment: seg.player });
    const crash = run.events.find((e) => e.type === 'crash');
    if (crash) issues.push({ severity: 'blocker', title: `The game crashes at ${crash.t}s: ${crash.detail}`, evidence: idx[crash.frame] ?? idx.at(-1), segment: seg.player, replay: recName, at: crash.t });
    for (const sl of run.softlocks) {
      const e = run.events.find((x) => x.type === 'softlock' && x.t === sl.t);
      issues.push({ severity: 'blocker', title: `Softlock at ${sl.t}s: ${sl.detail}`, evidence: idx[e?.frame] ?? idx.at(-1), segment: seg.player, replay: recName, at: sl.t });
    }
    if (b.mode === 'monkey' && run.stuck.length && !run.softlocks.length) issues.push({ severity: 'minor', title: `Rapid input left the game unresponsive for a while (${run.stuck[0].detail})`, segment: seg.player, replay: recName });
    if (fin.metrics) for (const k of ['cpuFrameMsAvg', 'cpuFrameMsP95', 'fpsEstimate']) if (fin.metrics[k] !== undefined) metrics[k] = Math.max(metrics[k] ?? 0, fin.metrics[k]);
    if (fin.metrics?.memoryMb) metrics.memoryMb = Math.max(metrics.memoryMb ?? 0, fin.metrics.memoryMb);
  }

  // A check holds for the playtest when some player made it hold (ever, end), or when it held
  // for every player (always, never).
  for (const [k, c] of (opts.checks ?? []).entries()) {
    const list = perCheck[k] ?? [];
    const all = ['always', 'never'].includes(c.when);
    const hit = all ? list.find((v) => !v.pass) : list.find((v) => v.pass);
    const v = hit ?? list[0] ?? { by: 'state', claim: describeCheck(c), pass: false, detail: 'no bot ran' };
    verdicts.push({ ...v, pass: all ? !hit && list.length > 0 : !!hit, detail: `${v.segment ? `${v.segment}: ` : ''}${v.detail}` });
  }

  // 3. The agent's own play sessions (game_play), from their saved summaries.
  for (const sid of opts.sessions ?? []) {
    const raw = await read(path.posix.join(dirProject, '.studio', 'recordings', `${sid}.json`));
    if (!raw) { issues.push({ severity: 'minor', title: `No recording of play session ${sid}` }); continue; }
    const rec = JSON.parse(raw.toString('utf8'));
    const seg = { player: 'ai', mode: 'ai', clock: rec.recording?.clock, durationS: rec.summary?.durationS ?? r1((rec.recording?.durationMs ?? 0) / 1000), steps: rec.summary?.steps ?? 0, goalReached: !!rec.summary?.goalReached, crashed: !!rec.summary?.crashed, recording: `../../recordings/${sid}.json` };
    segments.push(seg);
    for (const e of rec.summary?.events ?? []) events.push({ ...e, segment: 'ai' });
    errors.push(...(rec.summary?.errors ?? []));
    for (const v of rec.summary?.verdicts ?? []) verdicts.push({ ...v, segment: 'ai' });
    for (const f of rec.summary?.frames ?? []) allFrames.push({ path: f, seg: segments.length - 1, t: 0 });
    if (seg.goalReached && !goalReached) { goalReached = true; goalReachedBy = 'ai'; }
    if (seg.crashed) issues.push({ severity: 'blocker', title: `The game crashed while the AI player played (session ${sid})`, segment: 'ai' });
  }

  // 4. Regression replays.
  for (const file of opts.regressions === false ? [] : await list(path.posix.join(dirProject, '.studio', 'regressions'))) {
    if (!file.endsWith('.json')) continue;
    const reg = JSON.parse((await read(path.posix.join(dirProject, '.studio', 'regressions', file))).toString('utf8'));
    const r = await replayRegression(start, reg, base, signal);
    for (const v of r.verdicts) verdicts.push({ ...v, by: 'regression', claim: `${file}: ${v.claim}` });
    if (r.run.crashed) issues.push({ severity: 'blocker', title: `Regression ${file} crashes the game`, segment: 'replay' });
  }

  // Frames to files (evidence first), then the GIF from the bot segments.
  const frameFiles = [];
  const fileOf = new Map();
  const wanted = new Set([...events.filter((e) => e.frame !== undefined).map((e) => e.frame), ...issues.map((i) => i.evidence).filter((x) => typeof x === 'number')]);
  for (const [i, f] of allFrames.entries()) {
    if (f.path) { frameFiles.push(f.path); continue; }
    if (!f.png || (!wanted.has(i) && frameFiles.length >= 80)) continue;
    const name = `frames/${String(frameFiles.length).padStart(4, '0')}.png`;
    await write(path.posix.join(rel, name), f.png);
    fileOf.set(i, name);
    frameFiles.push(name);
  }
  const gif = recordingGif(allFrames.filter((f) => f.img && segments[f.seg]?.mode !== 'boot' && segments[f.seg]?.mode !== 'monkey'), { max: 60, width: 320 })
    ?? recordingGif(allFrames.filter((f) => f.img), { max: 60, width: 320 });
  if (gif) await write(path.posix.join(rel, 'playthrough.gif'), gif);
  for (const e of events) if (e.frame !== undefined) { e.frame = fileOf.get(e.frame); if (!e.frame) delete e.frame; }
  for (const i of issues) if (typeof i.evidence === 'number') i.evidence = fileOf.get(i.evidence);
  for (const v of verdicts) if (v.at !== undefined && !v.evidence) {
    const segFrames = allFrames.map((f, i) => ({ ...f, i })).filter((f) => segments[f.seg]?.player === v.segment);
    const k = frameNear(segFrames, v.at);
    if (k >= 0) v.evidence = fileOf.get(segFrames[k].i);
  }

  // Issues from the totals.
  const uniqueErrors = [...new Set(errors)];
  metrics.errors = uniqueErrors.length;
  if (uniqueErrors.length && !issues.some((i) => i.severity === 'blocker' && /crash/.test(i.title))) {
    const first = events.find((e) => e.type === 'error');
    issues.push({ severity: 'major', title: `Uncaught error${uniqueErrors.length > 1 ? `s (${uniqueErrors.length})` : ''}: ${uniqueErrors[0].split('\n')[0].slice(0, 160)}`, evidence: first?.frame, segment: first?.segment });
  }
  const consoleErrors = [...new Set(console_.filter((c) => c.startsWith('error:')))];
  metrics.consoleErrors = consoleErrors.length;
  if (consoleErrors.length) issues.push({ severity: 'major', title: `Console errors (${consoleErrors.length}): ${consoleErrors[0].slice(7, 160)}` });
  if (metrics.fpsAvg !== undefined && metrics.fpsAvg < fpsBudget) issues.push({ severity: 'major', title: `Frame rate ${metrics.fpsAvg} fps on average (budget ${fpsBudget}; worst second ${metrics.fpsMin})` });
  if (opts.goal && !goalReached && !issues.some((i) => i.severity === 'blocker')) issues.push({ severity: 'major', title: `No player reached the goal: ${opts.goal}` });
  const stuckOnly = segments.filter((s) => s.mode !== 'monkey' && s.stuck && !s.softlocks);
  if (stuckOnly.length && !goalReached) issues.push({ severity: 'minor', title: `A bot got stuck for a while (${stuckOnly.map((s) => s.player).join(', ')}); see the stuck events` });

  const playerOf = segments.find((s) => s.mode !== 'boot')?.player ?? segments[0]?.player ?? 'bot:explore';
  const report = {
    id, engine, build: opts.build ?? null, game: opts.game ?? null, query: opts.query ?? '', seed: base.seed,
    player: segments.some((s) => s.player === 'ai') ? 'ai' : playerOf, players: [...new Set(segments.map((s) => s.player))],
    goal: opts.goal ?? null, goalReached, goalReachedBy, result: 'pass',
    durationS: r1(segments.reduce((a, s) => a + (s.durationS ?? 0), 0)), steps: segments.reduce((a, s) => a + (s.steps ?? 0), 0),
    events: events.slice(0, 2000).map(({ source, ...e }) => e),
    metrics: Object.fromEntries(Object.entries({ fpsAvg: metrics.fpsAvg, fpsMin: metrics.fpsMin, frameMsP95: metrics.frameMsP95, cpuFrameMsAvg: metrics.cpuFrameMsAvg, cpuFrameMsP95: metrics.cpuFrameMsP95, memoryMb: metrics.memoryMb, errors: metrics.errors, consoleErrors: metrics.consoleErrors, fpsBudget }).filter(([, v]) => v !== undefined)),
    crashes: events.filter((e) => e.type === 'crash').map((e) => ({ t: e.t, detail: e.detail, segment: e.segment, frame: e.frame })),
    stuck: events.filter((e) => e.type === 'stuck' || e.type === 'softlock').map((e) => ({ t: e.t, type: e.type, detail: e.detail, segment: e.segment, frame: e.frame })),
    frames: frameFiles, recording: gif ? 'playthrough.gif' : null,
    segments, issues: issues.map(({ at, ...i }) => i), verdicts, errors: uniqueErrors.slice(0, 20), timedOut,
    created: new Date().toISOString(), tookS: r1((Date.now() - t0) / 1000),
  };
  report.result = resultOf(report);
  await write(path.posix.join(rel, 'report.json'), Buffer.from(JSON.stringify(report, null, 1)));
  return { report, dir: rel, text: describeReport(report, rel) };
}

/** Replays a regression file ({recording, expect: [checks]}) and checks its expectations. */
export async function replayRegression(start, reg, base = {}, signal) {
  const rec = reg.recording ?? reg;
  const s = await start({ ...base, game: rec.game ?? base.game, query: rec.query ?? base.query, seed: rec.seed ?? base.seed, viewport: rec.viewport ?? base.viewport, clock: rec.clock === 'real' ? 'real' : 'fixed', bootMs: rec.bootMs ?? 500 });
  let run;
  try {
    run = await runBot(s, { mode: 'scripted', recording: rec, seconds: Math.max(1, (rec.durationMs ?? 10_000) / 1000 + 1), frameEveryMs: 2000, maxFrames: 10, stopOnSoftlock: false, signal });
  } finally { await s.stop(); }
  const verdicts = (reg.expect ?? []).map((c) => evaluateCheck(c, run.samples));
  return { run, verdicts, pass: verdicts.every((v) => v.pass) && !run.crashed };
}

/** A regression file from a recording and what must hold when it replays. */
export function regressionFile(recording, expect, note) {
  return { version: 1, note: note ?? null, created: new Date().toISOString(), recording, expect: expect.map((c) => ({ ...c, claim: c.claim ?? describeCheck(c) })) };
}

export { sample };
