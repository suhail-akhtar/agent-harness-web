// Studio player: the AI game player, bots and playtests (registered by ../index.mjs).
//   game_play      a play session the agent drives: it sees small frames, reads the state, sends inputs
//   game_bot       a bot with no model: random, explore, goal, monkey, scripted (exact replays)
//   game_playtest  a full playtest: boot, bots, the agent's sessions, regressions -> report.json + GIF
// Gates: game-starts, no-softlock, playtest-pass, playtest-regressions.
// Web games play in the visual plugin's offline browser; engines plug in through driver.mjs.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { formatPoint, isWon, positionOf } from './analysis.mjs';
import { BOT_MODES, runBot } from './bots.mjs';
import { detectEngine, PLAY_ENGINES, startSession, webEntry } from './driver.mjs';
import { describeReport, latestReport, newPlaytestId, projectDir, readProject, regressionFile, replayRegression, resultOf, runPlaytest } from './report.mjs';
import { checkError, describeCheck, evaluateCheck, parseJudgement, sample } from './verdicts.mjs';

const MAX_SESSIONS = 4;
const IDLE_MS = 10 * 60_000;
const sessions = new Map();
let seq = 0;

/** Where the files are: the workspace, or for a companion session a server-side copy (results sent back). */
async function siteOf(host, signal) {
  if (host.kind !== 'companion') return { host, root: host.root, push: null };
  if (!host.mirror || !host.pushFile) throw new Error('This tool runs on the server and cannot see files on your computer with this companion: update the companion.');
  const root = await host.mirror(signal);
  return { host: { ...host, root, kind: 'local' }, root, push: (rel, data) => host.pushFile(rel, data, signal) };
}

function io(site, beforeWrite) {
  const abs = (rel) => path.join(site.root, ...rel.split('/'));
  return {
    async write(rel, data) {
      const f = abs(rel);
      if (/report\.json$|\.gif$|regressions\//.test(rel)) await beforeWrite?.(f);
      await fsp.mkdir(path.dirname(f), { recursive: true });
      await fsp.writeFile(f, data);
      await site.push?.(rel, data);
    },
    read: (rel) => fsp.readFile(abs(rel)).catch(() => null),
    list: (rel) => fsp.readdir(abs(rel)).catch(() => []),
  };
}

const img = (png) => ({ media_type: 'image/png', data: Buffer.from(png).toString('base64') });
const num = (v, def, lo, hi) => Math.min(Math.max(Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : def, lo), hi);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}...` : s);
const STATIC_KEYS = ['inputs', 'controls', 'keys'];

/** The state as text for the agent: static parts (inputs, controls) only when asked. */
function stateText(state, full = false) {
  if (state === undefined) return 'state: (the game exposes no window.__game; judge from the frame)';
  const s = state && typeof state === 'object' && !full ? Object.fromEntries(Object.entries(state).filter(([k]) => !STATIC_KEYS.includes(k))) : state;
  return `state: ${clip(JSON.stringify(s), 1800)}`;
}

function obsText(o, { full = false } = {}) {
  const lines = [`t=${(o.t / 1000).toFixed(2)}s`, stateText(o.state, full)];
  const pos = positionOf(o.state);
  if (pos) lines.push(`player at (${formatPoint(pos)})`);
  if (o.events?.length) lines.push(`events: ${o.events.map((e) => `${e.type} ${e.detail} @${e.t}s`).join('; ')}`);
  if (o.errors?.length) lines.push(`NEW ERRORS: ${o.errors.map((e) => e.split('\n')[0]).join(' | ')}`);
  if (o.crashed) lines.push('THE GAME CRASHED');
  else if (o.loopStopped && o.errors?.length) lines.push('THE GAME LOOP STOPPED after an error (a crash)');
  if (isWon(o.state)) lines.push('The game says the goal is reached.');
  if (o.frame) lines.push(`frame: ${o.frame.width}x${o.frame.height}${o.frame.stats.blank ? ' BLANK (one colour)' : ''} (mouse coordinates are in these pixels)`);
  return lines.join('\n');
}

async function gameOpts(input, root) {
  const engine = input.engine && input.engine !== 'auto' ? String(input.engine) : await detectEngine(root, input.game ? String(input.game) : undefined);
  const game = input.game ? String(input.game).replace(/\\/g, '/') : engine === 'web' ? await webEntry(root) : undefined;
  return {
    engine, game, query: typeof input.query === 'string' ? input.query : '', seed: num(input.seed, 1, 0, 2 ** 31),
    viewport: { width: num(input.width, 960, 320, 1920), height: num(input.height, 600, 240, 1200) },
  };
}

function touch(entry) {
  clearTimeout(entry.idle);
  entry.idle = setTimeout(() => { closePlay(entry.id).catch(() => {}); }, IDLE_MS);
  entry.idle.unref?.();
}

async function closePlay(id) {
  const e = sessions.get(id);
  if (!e) return null;
  sessions.delete(id);
  clearTimeout(e.idle);
  return e.session.stop();
}

/** The play session's summary, saved where game_playtest and game_bot (scripted) find it. */
async function savePlay(e, fin, files) {
  const won = e.goalReached || e.samples.some((s) => isWon(s.state));
  const summary = {
    id: e.id, player: 'ai', engine: e.session.engine, game: e.opts.game, durationS: Math.round((e.session.t - e.t0)) / 1000, steps: e.steps,
    goalReached: won, crashed: e.crashed, events: e.events.slice(0, 500), errors: [...new Set(e.errors)].slice(0, 20), verdicts: e.verdicts, frames: e.frames, metrics: fin?.metrics ?? null,
    note: e.note ?? null, created: new Date(e.created).toISOString(),
  };
  const rel = path.posix.join(e.projectDir, '.studio', 'recordings', `${e.id}.json`);
  await files.write(rel, Buffer.from(JSON.stringify({ summary, recording: fin?.recording ?? e.session.recording() }, null, 1)));
  return { rel, summary };
}

async function playTool(input, ctx) {
  const action = String(input.action ?? 'observe');
  if (action === 'list') {
    if (!sessions.size) return 'No play sessions are open.';
    return [...sessions.values()].map((e) => `${e.id}: ${e.opts.engine} ${e.opts.game ?? ''}, t=${(e.session.t / 1000).toFixed(1)}s, ${e.steps} steps`).join('\n');
  }
  if (action === 'start') {
    if (sessions.size >= MAX_SESSIONS) return { content: `${sessions.size} play sessions are open (the most at once). Stop one first (game_play stop).`, is_error: true };
    const site = await siteOf(ctx.host, ctx.signal);
    const opts = await gameOpts(input, site.root);
    const frameWidth = num(input.frameWidth, 512, 160, 1024);
    let session;
    try {
      session = await startSession(site.host, { ...opts, root: site.root, clock: input.clock === 'real' ? 'real' : 'fixed', frameWidth }, ctx);
    } catch (err) { return { content: `Could not start the game: ${err.message}`, is_error: true }; }
    const id = `play-${Date.now().toString(36)}-${++seq}`;
    const entry = { id, session, opts, site, frameWidth, projectDir: await projectDir(site.root, opts.game), steps: 0, events: [], errors: [], verdicts: [], frames: [], samples: [], crashed: false, created: Date.now(), t0: session.t, goal: typeof input.goal === 'string' ? input.goal : null };
    sessions.set(id, entry);
    touch(entry);
    const o = await session.observe({ frame: true, width: frameWidth });
    record(entry, o);
    const info = session.info;
    const head = [
      `Play session ${id} started: ${opts.engine} ${opts.game ?? ''}${opts.query}, seed ${opts.seed}, clock ${info.clock}${info.clock === 'fixed' ? ' (the game is paused between your steps)' : ''}.`,
      info.inputs ? `The game's inputs: ${info.inputs.join(', ')}` : 'The game names no inputs: try arrows, WASD, Space, Enter.',
      info.controls ? `Named controls: ${JSON.stringify(info.controls)}` : '',
      'Next: game_play step with inputs and ms (e.g. {"action":"step","session":"' + id + '","inputs":[{"key":"ArrowRight","ms":400}],"ms":400}).',
    ].filter(Boolean);
    return { content: `${head.join('\n')}\n\n${obsText(o, { full: true })}`, images: o.frame ? [img(o.frame.png)] : [] };
  }
  const id = String(input.session ?? (sessions.size === 1 ? [...sessions.keys()][0] : ''));
  const entry = sessions.get(id);
  if (!entry) return { content: `No open play session "${id}". Open ones: ${[...sessions.keys()].join(', ') || 'none'} (game_play start opens one).`, is_error: true };
  touch(entry);
  const s = entry.session;
  const files = io(entry.site, ctx.beforeWrite);
  try {
    if (action === 'observe') {
      const o = await s.observe({ frame: input.frame !== false, width: entry.frameWidth });
      record(entry, o);
      return { content: obsText(o), images: o.frame ? [img(o.frame.png)] : [] };
    }
    if (action === 'act' || action === 'step') {
      const inputs = Array.isArray(input.inputs) ? input.inputs : input.inputs ? [input.inputs] : [];
      for (const i of inputs) if (!i || typeof i !== 'object' || !(i.key || i.action || i.mouse)) return { content: `Each input needs key, action or mouse: ${JSON.stringify(i)}`, is_error: true };
      let o;
      if (action === 'act') { await s.act(inputs); o = await s.observe({ frame: input.frame === true, width: entry.frameWidth }); }
      else o = await s.step(inputs, input.ms === undefined ? undefined : num(input.ms, 250, 0, 10_000), { frame: input.frame !== false, width: entry.frameWidth });
      entry.steps++;
      record(entry, o);
      return { content: obsText(o), images: o.frame ? [img(o.frame.png)] : [] };
    }
    if (action === 'verdict') {
      // The agent's own judgement of what it sees, with the frame it judged as evidence.
      if (typeof input.claim !== 'string' || typeof input.pass !== 'boolean') return { content: 'verdict needs claim (text) and pass (true or false).', is_error: true };
      const o = await s.observe({ frame: true, width: entry.frameWidth });
      record(entry, o);
      const name = path.posix.join(entry.projectDir, '.studio', 'recordings', entry.id, `${String(entry.frames.length).padStart(4, '0')}.png`);
      await files.write(name, o.frame.png);
      entry.frames.push(`../../recordings/${entry.id}/${path.posix.basename(name)}`);
      const v = { by: 'vision', claim: input.claim, pass: input.pass, evidence: entry.frames.at(-1), detail: typeof input.note === 'string' ? input.note.slice(0, 300) : undefined, at: o.t / 1000 };
      entry.verdicts.push(v);
      if (input.pass && input.goal === true) entry.goalReached = true;
      return `Recorded: ${v.pass ? 'PASS' : 'FAIL'} "${v.claim}" (evidence ${name}).`;
    }
    if (action === 'check') {
      const checks = Array.isArray(input.checks) ? input.checks : [];
      if (!checks.length) return { content: 'check needs checks: [{"path": "coins", "op": ">=", "value": 5, "when": "ever"}]', is_error: true };
      const vs = checks.map((c) => evaluateCheck(c, entry.samples));
      entry.verdicts.push(...vs);
      return vs.map((v) => `${v.pass ? 'PASS' : 'FAIL'} ${v.claim}: ${v.detail}`).join('\n');
    }
    if (action === 'stop') {
      if (typeof input.note === 'string') entry.note = input.note.slice(0, 1000);
      if (input.goalReached === true) entry.goalReached = true;
      const fin = await closePlay(id);
      const { rel, summary } = await savePlay(entry, fin, files);
      return [
        `Stopped ${id} after ${summary.durationS}s of game time and ${summary.steps} steps. Goal reached: ${summary.goalReached ? 'yes' : 'no'}${summary.crashed ? '. The game CRASHED' : ''}.`,
        `Errors: ${summary.errors.length ? summary.errors.map((x) => x.split('\n')[0]).join(' | ') : 'none'}`,
        fin?.metrics ? `Metrics: ${Object.entries(fin.metrics).map(([k, v]) => `${k}=${v}`).join(', ')}` : '',
        `Saved ${rel}: replay it exactly with game_bot {"mode":"scripted","recording":"${rel}"}; put it in a playtest with game_playtest {"sessions":["${id}"]}.`,
      ].filter(Boolean).join('\n');
    }
    return { content: `Unknown action ${action}: start, observe, step, act, check, verdict, stop or list.`, is_error: true };
  } catch (err) {
    return { content: `game_play ${action} failed: ${String(err?.message ?? err).split('\n')[0]}`, is_error: true };
  }
}

function record(entry, o) {
  entry.events.push(...(o.events ?? []));
  entry.errors.push(...(o.errors ?? []));
  if (o.crashed || (o.loopStopped && entry.errors.length)) entry.crashed = true;
  if (entry.samples.length < 5000) entry.samples.push(sample(o.t, o.state, { errors: entry.errors, crashed: entry.crashed, goalReached: entry.goalReached }));
}

async function loadRecording(files, rel) {
  const raw = await files.read(String(rel).replace(/\\/g, '/'));
  if (!raw) throw new Error(`No recording at ${rel}`);
  const j = JSON.parse(raw.toString('utf8'));
  return { recording: j.recording ?? j, expect: j.expect };
}

async function botTool(input, ctx) {
  const mode = String(input.mode ?? 'explore');
  if (!BOT_MODES.includes(mode)) return { content: `mode must be one of ${BOT_MODES.join(', ')}`, is_error: true };
  const site = await siteOf(ctx.host, ctx.signal);
  const files = io(site, ctx.beforeWrite);
  let recording = null, expect = Array.isArray(input.expect) ? input.expect : null;
  if (mode === 'scripted') {
    if (input.recording) {
      try { ({ recording, expect = expect } = await loadRecording(files, input.recording)); } catch (err) { return { content: err.message, is_error: true }; }
    } else if (Array.isArray(input.steps)) recording = { steps: input.steps };
    else return { content: 'scripted needs recording (a .studio/recordings/*.json or .studio/regressions/*.json path) or steps ([{"inputs": [...], "ms": 300}]).', is_error: true };
  }
  for (const c of expect ?? []) { const bad = checkError(c); if (bad) return { content: `expect: ${bad}`, is_error: true }; }
  const opts = await gameOpts({ ...input, ...(recording?.game ? { game: recording.game, query: recording.query, seed: recording.seed, engine: recording.engine } : {}) }, site.root);
  if (recording?.viewport) opts.viewport = recording.viewport;
  let session;
  try { session = await startSession(site.host, { ...opts, root: site.root, clock: recording?.clock === 'real' || input.clock === 'real' ? 'real' : 'fixed', bootMs: recording?.bootMs ?? 500 }, ctx); } catch (err) { return { content: `Could not start the game: ${err.message}`, is_error: true }; }
  let run, fin;
  try {
    run = await runBot(session, {
      mode, recording, steps: recording?.steps, seconds: mode === 'scripted' ? (recording?.durationMs ? recording.durationMs / 1000 + 1 : num(input.seconds, 30, 1, 900)) : num(input.seconds, 30, 1, 900),
      seed: num(input.seed, 1, 0, 2 ** 31), macroMs: input.macroMs, stuckS: input.stuckSeconds, softlockS: input.softlockSeconds, stopOnGoal: input.stopOnGoal !== false, signal: ctx.signal,
      frameWidth: 384, maxFrames: 40,
    });
  } finally { fin = await session.stop(); }
  const pd = await projectDir(site.root, opts.game);
  const id = `bot-${mode}-${Date.now().toString(36)}`;
  const recRel = path.posix.join(pd, '.studio', 'recordings', `${id}.json`);
  const summary = { id, player: `bot:${mode}`, engine: session.engine, game: opts.game, durationS: run.durationS, steps: run.steps, goalReached: run.goalReached, crashed: run.crashed, events: run.events.slice(0, 500).map(({ frame, source, ...e }) => e), errors: [...new Set(run.errors)].slice(0, 20), coverage: run.coverage, metrics: fin.metrics };
  await files.write(recRel, Buffer.from(JSON.stringify({ summary, recording: fin.recording }, null, 1)));
  const verdicts = (expect ?? []).map((c) => evaluateCheck(c, run.samples));
  let saved = null;
  if (typeof input.saveAs === 'string' && input.saveAs.trim()) {
    const name = input.saveAs.trim().replace(/[^\w.-]+/g, '-').replace(/\.json$/, '');
    saved = path.posix.join(pd, '.studio', 'regressions', `${name}.json`);
    await files.write(saved, Buffer.from(JSON.stringify(regressionFile(fin.recording, expect ?? [{ path: '$errors', op: '>', value: 0, when: 'never' }], typeof input.note === 'string' ? input.note : null), null, 1)));
  }
  const kinds = {};
  for (const e of run.events) kinds[e.type] = (kinds[e.type] ?? 0) + 1;
  const notable = run.events.filter((e) => ['pickup', 'goal', 'stuck', 'softlock', 'crash', 'error', 'lose', 'death', 'level'].includes(e.type));
  const lines = [
    `Bot ${mode} on ${opts.engine} ${opts.game ?? ''}${opts.query}: ${run.durationS}s of game time, ${run.steps} steps${run.coverage.cells ? `, ${run.coverage.cells} places visited` : ''}.`,
    `Goal reached: ${run.goalReached ? 'yes' : 'no'}. Crashed: ${run.crashed ? 'YES' : 'no'}. Softlocks: ${run.softlocks.length}. Stuck moments: ${run.stuck.length}. Errors: ${run.errors.length}.`,
    Object.keys(kinds).length ? `Events: ${Object.entries(kinds).map(([k, n]) => `${k} x${n}`).join(', ')}` : 'No events.',
    ...notable.slice(0, 25).map((e) => `- ${e.t}s ${e.type}: ${e.detail}`),
    run.errors.length ? `Errors:\n${[...new Set(run.errors)].slice(0, 5).map((x) => `  ${x.split('\n').slice(0, 2).join(' | ')}`).join('\n')}` : '',
    `Final ${stateText(run.final)}`,
    fin.metrics ? `Metrics: ${Object.entries(fin.metrics).map(([k, v]) => `${k}=${v}`).join(', ')}` : '',
    ...verdicts.map((v) => `${v.pass ? 'PASS' : 'FAIL'} ${v.claim}: ${v.detail}`),
    `Recording: ${recRel} (replay exactly: game_bot {"mode":"scripted","recording":"${recRel}"}).`,
    saved ? `Regression saved: ${saved} (game_playtest and the playtest-regressions gate replay it).` : '',
  ].filter(Boolean);
  const pick = [run.frames.find((f) => /^(softlock|crash)/.test(f.label)), run.frames.find((f) => /^goal/.test(f.label)), run.frames.at(-1)].filter(Boolean);
  return { content: lines.join('\n'), is_error: false, images: [...new Set(pick)].slice(0, 3).map((f) => img(f.png)) };
}

async function playtestTool(input, ctx) {
  const action = String(input.action ?? 'run');
  const site = await siteOf(ctx.host, ctx.signal);
  const files = io(site, ctx.beforeWrite);
  const opts = await gameOpts(input, site.root);
  const pd = await projectDir(site.root, opts.game);
  if (action === 'report') {
    const got = input.id ? await readReport(site.root, pd, String(input.id)) : await latestReport(site.root, pd);
    if (!got) return { content: 'No playtest yet. Run game_playtest.', is_error: true };
    return describeReport(got.report, got.dir);
  }
  if (action === 'verdict' || action === 'judge') {
    const got = input.id ? await readReport(site.root, pd, String(input.id)) : await latestReport(site.root, pd);
    if (!got) return { content: 'No playtest yet. Run game_playtest first.', is_error: true };
    const r = got.report;
    if (action === 'verdict') {
      if (typeof input.claim !== 'string' || typeof input.pass !== 'boolean') return { content: 'verdict needs claim and pass; evidence names the frame you judged (e.g. "frames/0012.png").', is_error: true };
      r.verdicts.push({ by: 'vision', claim: input.claim, pass: input.pass, evidence: typeof input.evidence === 'string' ? input.evidence : undefined, detail: typeof input.note === 'string' ? input.note.slice(0, 300) : undefined });
    } else {
      const claims = (Array.isArray(input.claims) ? input.claims : [input.claim]).filter((c) => typeof c === 'string').slice(0, 5);
      if (!claims.length) return { content: 'judge needs claims (what the frames should show).', is_error: true };
      if (!ctx.runSubagent) return { content: 'judge needs a session that can start sub-agents (the main agent). Look at the frames yourself (read them) and record verdicts with action "verdict".', is_error: true };
      const frames = (Array.isArray(input.frames) ? input.frames.map(String) : pickFrames(r)).slice(0, 4);
      const paths = frames.map((f) => path.posix.join(got.dir, f));
      const report = await ctx.runSubagent({ type: 'vision-judge', description: 'Judge playtest frames', prompt: `Frames of a game (read each one; they are images):\n${paths.map((p) => `- ${p}`).join('\n')}\n\nFor each claim, say whether the frames show it. Answer with a JSON list only: [{"claim": "...", "pass": true|false, "frame": "<the path that shows it best>", "why": "one sentence"}].\nClaims:\n${claims.map((c) => `- ${c}`).join('\n')}` });
      parseJudgement(report, claims).forEach((j, i) => r.verdicts.push(j ? { by: 'model', claim: claims[i], pass: j.pass, evidence: j.frame ? path.posix.relative(got.dir, j.frame) : undefined, detail: j.why } : { by: 'model', claim: claims[i], pass: false, detail: 'the judge gave no answer for this claim' }));
    }
    r.result = resultOf(r);
    await files.write(path.posix.join(got.dir, 'report.json'), Buffer.from(JSON.stringify(r, null, 1)));
    return describeReport(r, got.dir);
  }
  if (action === 'regress') {
    const dir = path.posix.join(pd, '.studio', 'regressions');
    const list = (await files.list(dir)).filter((f) => f.endsWith('.json'));
    if (!list.length) return { content: `No regression files in ${dir}. Save one with game_bot {"mode":"scripted", "recording": ..., "saveAs": "name", "expect": [...]}.`, is_error: true };
    const lines = [];
    let failed = 0;
    for (const f of list) {
      const reg = JSON.parse((await files.read(path.posix.join(dir, f))).toString('utf8'));
      const r = await replayRegression((o) => startSession(site.host, { ...o, root: site.root }, ctx), reg, opts, ctx.signal);
      if (!r.pass) failed++;
      lines.push(`${r.pass ? 'PASS' : 'FAIL'} ${f}${r.run.crashed ? ' (crashed)' : ''}`, ...r.verdicts.map((v) => `  ${v.pass ? 'ok' : 'FAILED'} ${v.claim}: ${v.detail}`));
    }
    return { content: `${list.length - failed} of ${list.length} regression(s) pass.\n${lines.join('\n')}`, is_error: failed > 0 };
  }
  if (action !== 'run') return { content: `Unknown action ${action}: run, report, verdict, judge or regress.`, is_error: true };
  for (const c of Array.isArray(input.checks) ? input.checks : []) { const bad = checkError(c); if (bad) return { content: `checks: ${bad}`, is_error: true }; }
  const project = await readProject(site.root, pd);
  const id = await newPlaytestId(site.root, pd);
  let out;
  try {
    out = await runPlaytest({ start: (o) => startSession(site.host, { ...o, root: site.root }, ctx), ...files, signal: ctx.signal }, {
      ...opts, id, projectDir: pd, project, goal: typeof input.goal === 'string' ? input.goal : undefined, checks: Array.isArray(input.checks) ? input.checks : [],
      bots: Array.isArray(input.bots) ? input.bots : undefined, seconds: input.seconds, sessions: Array.isArray(input.sessions) ? input.sessions.map(String) : [],
      fpsBudget: input.fpsBudget, boot: input.boot !== false, bootSeconds: input.bootSeconds, regressions: input.regressions !== false, build: typeof input.build === 'string' ? input.build : undefined,
    });
  } catch (err) { return { content: `The playtest could not run: ${err.message}`, is_error: true }; }
  if (project) {
    project.playtests = [...(Array.isArray(project.playtests) ? project.playtests : []), id];
    await files.write(path.posix.join(pd, '.studio', 'project.json'), Buffer.from(`${JSON.stringify(project, null, 2)}\n`));
  }
  const r = out.report;
  const evidence = [...new Set([...r.issues.map((i) => i.evidence), ...r.events.filter((e) => e.type === 'goal').map((e) => e.frame)].filter(Boolean))].slice(0, 3);
  const images = [];
  for (const f of evidence) { const b = await files.read(path.posix.join(out.dir, f)); if (b) images.push(img(b)); }
  return { content: `${out.text}\n\nLook at the frames and the GIF (read ${out.dir}/frames/...), then record what you judged: game_playtest {"action":"verdict","claim":"...","pass":true,"evidence":"frames/0003.png"}.`, images };
}

function pickFrames(r) {
  const ev = r.events.filter((e) => e.frame && ['goal', 'pickup', 'softlock', 'crash'].includes(e.type)).map((e) => e.frame);
  const spread = r.frames.filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 3)) === 0);
  return [...new Set([...ev.slice(-2), ...spread, r.frames.at(-1)].filter(Boolean))];
}

async function readReport(root, pd, id) {
  const dir = path.posix.join(pd, '.studio', 'playtests', id);
  try { return { id, dir, report: JSON.parse(await fsp.readFile(path.join(root, dir, 'report.json'), 'utf8')) }; } catch { return null; }
}

/** A game here that Studio plays: a Studio project, or a web page with window.__game; an engine project with a driver. */
async function studioGame(root) {
  if (await fsp.stat(path.join(root, '.studio', 'project.json')).then(() => true, () => false)) return true;
  const entry = await webEntry(root);
  if (!entry) return false;
  try { return /__game/.test(await fsp.readFile(path.join(root, entry), 'utf8')); } catch { return false; }
}

const gameInput = { engine: { type: 'string', enum: ['auto', ...PLAY_ENGINES], description: 'Default: from .studio/project.json or the files' }, game: { type: 'string', description: 'The page (web) or project to play (default: index.html / the project)' }, query: { type: 'string', description: 'URL query for web games, e.g. "?autostart=1"' }, seed: { type: 'number', description: 'Seeds Math.random (and is passed on); same seed + same inputs = same game' }, width: { type: 'number' }, height: { type: 'number' } };
const checkSchema = { type: 'object', properties: { path: { type: 'string' }, op: { type: 'string' }, value: {}, when: { type: 'string', enum: ['ever', 'end', 'always', 'never'] } }, required: ['path'] };

export function setupPlayer(api) {
  api.registerTool({
    name: 'game_play',
    description: 'Play a game yourself, in short steps: you see a small frame of the game, its state (window.__game for web games) and the events since your last step, then choose the next inputs. The game is paused between your steps (clock "fixed"), so take your time. Actions: start (opens a session), step (inputs, then ms of game time, then a new frame), act (inputs now; no game time passes, so the game reacts on your next step), observe, check (state claims), verdict (record what you judged from the frame you see, with that frame as evidence), stop (saves the recording: it replays exactly with game_bot scripted), list. Inputs: {"key":"ArrowRight","ms":400} holds a key, {"key":"Space"} taps it, {"key":"KeyX","down":true} / {"up":true}, {"action":"jump"} uses the game\'s named controls, {"mouse":[x,y],"click":true} in the frame\'s pixels; "at": ms delays one input within the step. Web games run offline in a headless browser; Godot, Unreal and Unity play when their engine plugin offers a play driver.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'step', 'act', 'observe', 'check', 'verdict', 'stop', 'list'] },
        session: { type: 'string' }, ...gameInput,
        clock: { type: 'string', enum: ['fixed', 'real'], description: 'fixed (default): the game only runs during steps; real: it runs on its own' },
        inputs: { type: 'array', items: { type: 'object' } }, ms: { type: 'number', description: 'Game time a step runs (default: until its inputs end; max 10000)' },
        frame: { type: 'boolean', description: 'Return a frame (default true for step and observe)' }, frameWidth: { type: 'number', description: 'Frame width in pixels (default 512)' },
        checks: { type: 'array', items: checkSchema }, claim: { type: 'string' }, pass: { type: 'boolean' }, goal: { type: 'boolean', description: 'verdict: this claim is the goal being reached' },
        goalReached: { type: 'boolean' }, note: { type: 'string' },
      },
      required: ['action'],
    },
    kind: 'exec',
    kindsFor: (i) => (['stop', 'verdict'].includes(String(i.action)) ? ['exec', 'edit'] : ['exec']),
    summarize: (i) => `${i.action}${i.session ? ` ${i.session}` : ''}${Array.isArray(i.inputs) && i.inputs.length ? ` ${i.inputs.map((x) => x.key ?? x.action ?? 'mouse').join('+')}` : ''}${i.ms ? ` ${i.ms}ms` : ''}`,
    run: playTool,
  });

  api.registerTool({
    name: 'game_bot',
    description: 'Run a bot on the game with no model, for N seconds of game time (the game runs faster than real time): random, explore (novelty search: tries every input from every place it reaches, finds stuck and softlock states), goal (explore, pulled toward state.target / state.targets: proves the goal can be reached), monkey (rapid stress input), scripted (replay a recording exactly: a .studio/recordings/*.json from game_play or game_bot, or a .studio/regressions/*.json). Reports events (pickups, state changes, goal), errors, crashes, stuck and softlock moments with frames, coverage and the recording. saveAs with expect (state checks) turns the run into a regression file.',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: BOT_MODES }, seconds: { type: 'number', description: 'Game seconds (default 30, max 900)' }, ...gameInput,
        recording: { type: 'string', description: 'scripted: the recording or regression file' }, steps: { type: 'array', items: { type: 'object' }, description: 'scripted: [{"inputs": [...], "ms": 300}]' },
        expect: { type: 'array', items: checkSchema, description: 'State checks for this run, e.g. [{"path":"won","op":"==","value":true,"when":"end"}]' },
        saveAs: { type: 'string', description: 'Save the run as .studio/regressions/<saveAs>.json with expect' }, note: { type: 'string' },
        macroMs: { type: 'number' }, stuckSeconds: { type: 'number' }, softlockSeconds: { type: 'number' }, stopOnGoal: { type: 'boolean' }, clock: { type: 'string', enum: ['fixed', 'real'] },
      },
      required: ['mode'],
    },
    kind: 'exec',
    kindsFor: () => ['exec', 'edit'],
    summarize: (i) => `${i.mode} ${i.seconds ?? 30}s${i.recording ? ` ${i.recording}` : ''}${i.saveAs ? ` -> ${i.saveAs}` : ''}`,
    run: botTool,
  });

  api.registerTool({
    name: 'game_playtest',
    description: 'A full playtest that proves the game works, saved as .studio/playtests/<id>/report.json with frames, a playthrough.gif and replayable inputs: the game boots on the real clock (fps, boot errors, blank screen), then bots play from fresh starts (goal, explore, monkey by default), your own game_play sessions are added (sessions), every regression file replays, and checks (state claims) are judged. It lists issues with evidence frames and a result (pass, fail, crash). Other actions: report (show the latest or id), verdict (add your judgement of a frame: claim, pass, evidence), judge (a sub-agent judges up to 4 frames against claims; costs a little), regress (replay the regression files only).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['run', 'report', 'verdict', 'judge', 'regress'] }, id: { type: 'string' }, ...gameInput,
        goal: { type: 'string', description: 'What a player must achieve, in words (the result fails when no player reaches it; the game\'s won/done state says it is reached)' },
        checks: { type: 'array', items: checkSchema }, bots: { type: 'array', items: {}, description: 'Bot modes or {mode, seconds} (default goal, explore, monkey)' },
        seconds: { type: 'number', description: 'Game seconds per bot (default 60)' }, sessions: { type: 'array', items: { type: 'string' }, description: 'game_play session ids to include' },
        fpsBudget: { type: 'number' }, boot: { type: 'boolean', description: 'The real-clock boot segment (default true)' }, bootSeconds: { type: 'number' }, regressions: { type: 'boolean' }, build: { type: 'string' },
        claim: { type: 'string' }, claims: { type: 'array', items: { type: 'string' } }, pass: { type: 'boolean' }, evidence: { type: 'string' }, frames: { type: 'array', items: { type: 'string' } }, note: { type: 'string' },
      },
    },
    kind: 'exec',
    kindsFor: (i) => (i.action === 'report' ? ['read'] : ['exec', 'edit']),
    summarize: (i) => `${i.action ?? 'run'}${i.goal ? `: ${String(i.goal).slice(0, 60)}` : ''}`,
    run: playtestTool,
  });

  const gateSite = (host, signal) => siteOf(host, signal).catch(() => null);
  const playable = async (host, signal) => {
    if (host.kind === 'companion') return false;
    const root = host.root;
    const engine = await detectEngine(root);
    if (engine !== 'web') return false;
    return studioGame(root);
  };

  api.registerGate({
    name: 'game-starts',
    description: 'The game boots and draws a non-blank frame (pixel variance) within a few seconds on the real clock, with no uncaught errors.',
    applies: (h, signal) => playable(h, signal),
    async run({ host, signal }) {
      const site = await gateSite(host, signal);
      if (!site) return { pass: false, severity: 'advisory', summary: 'not checked: the workspace cannot be read here' };
      const project = await readProject(site.root);
      const seconds = num(process.env.HARNESS_STUDIO_BOOT_S ?? project?.playtest?.bootSeconds, 5, 1, 60);
      let s;
      try { s = await startSession(site.host, { root: site.root, clock: 'real', bootMs: 0 }); } catch (err) { return { pass: false, summary: `the game did not start: ${err.message}` }; }
      const seen = [];
      const errors = [];
      let state, crashed = false;
      try {
        for (let t = 0; t < seconds * 1000; t += 1000) {
          const o = await s.step([], 1000, { frame: true, width: 256 });
          errors.push(...(o.errors ?? []));
          state = o.state ?? state;
          crashed ||= !!o.crashed;
          // An engine run without a display (headless Godot) has no frames: its state says it runs.
          if (!o.frame) { if (crashed || t >= 1000) break; continue; }
          seen.push(o.frame.stats);
          if (!o.frame.stats.blank && t >= 1000) break;
        }
      } finally { errors.push(...((await s.stop())?.errors ?? [])); }
      const drawn = seen.findIndex((x) => !x.blank);
      const frameless = !seen.length;
      const problems = [
        ...(crashed ? ['the game crashed while starting'] : []),
        ...(frameless ? (state === undefined ? ['no frames (no display here) and no state from the game'] : []) : drawn < 0 ? [`every frame for ${seconds}s is blank (one colour)`] : []),
        ...[...new Set(errors)].map((e) => `uncaught: ${e.split('\n')[0]}`),
      ];
      return problems.length
        ? { pass: false, summary: `the game does not start cleanly: ${problems[0]}`, details: problems.join('\n') }
        : { pass: true, summary: frameless ? `the game runs (no display here, so no frames: its state ${JSON.stringify(state).slice(0, 120)}), no errors` : `the game draws within ${drawn + 1}s (${seen[drawn].colours} colours, contrast ${seen[drawn].stddev}), no errors` };
    },
  });

  api.registerGate({
    name: 'no-softlock',
    description: 'An explorer bot plays for a while (30 game seconds by default) and finds no state where no input changes anything for 8 seconds, and no crash (as far as a bot can tell).',
    applies: (h, signal) => playable(h, signal),
    async run({ host, signal }) {
      const site = await gateSite(host, signal);
      if (!site) return { pass: false, severity: 'advisory', summary: 'not checked: the workspace cannot be read here' };
      const project = await readProject(site.root);
      const seconds = num(process.env.HARNESS_STUDIO_SOFTLOCK_S ?? project?.playtest?.softlockSeconds, 30, 5, 600);
      let s;
      try { s = await startSession(site.host, { root: site.root, clock: 'fixed' }); } catch (err) { return { pass: false, summary: `the game did not start: ${err.message}` }; }
      let run, fin;
      try { run = await runBot(s, { mode: 'explore', seconds, stopOnGoal: false, frameWidth: 480, maxFrames: 20, signal }); } finally { fin = await s.stop(); }
      const bad = run.softlocks[0] ?? (run.crashed ? run.events.find((e) => e.type === 'crash') : null);
      if (!bad) return { pass: true, summary: `no softlock in ${run.durationS}s of exploring (${run.coverage.cells} places, ${run.steps} steps)${run.goalReached ? '; it even reached the goal' : ''}` };
      const files = io(site);
      const rel = '.studio/gates';
      const frame = run.frames.find((f) => /^(softlock|crash)/.test(f.label)) ?? run.frames.at(-1);
      const stamp = Date.now().toString(36);
      if (frame) await files.write(`${rel}/no-softlock-${stamp}.png`, frame.png);
      await files.write(`${rel}/no-softlock-${stamp}.json`, Buffer.from(JSON.stringify({ recording: fin.recording, expect: [{ path: '$softlocks', op: '>', value: 0, when: 'never' }, { path: '$crashed', op: 'truthy', when: 'never' }] }, null, 1)));
      return { pass: false, summary: `${run.softlocks[0] ? 'softlock' : 'crash'} at ${bad.t}s: ${bad.detail}`, details: `Evidence frame: ${rel}/no-softlock-${stamp}.png\nReplay it exactly: game_bot {"mode":"scripted","recording":"${rel}/no-softlock-${stamp}.json"}\nEvents before it:\n${run.events.filter((e) => e.t <= bad.t).slice(-8).map((e) => `  ${e.t}s ${e.type}: ${e.detail}`).join('\n')}` };
    },
  });

  api.registerGate({
    name: 'playtest-pass',
    description: 'The latest Studio playtest of the project passes: no crash, no uncaught or console errors, the goal reached by a bot or the AI player, fps at or above the budget, every verdict passing.',
    async applies(h) {
      if (h.kind === 'companion') return false;
      return fsp.stat(path.join(h.root, '.studio', 'project.json')).then(() => true, () => fsp.stat(path.join(h.root, '.studio', 'playtests')).then(() => true, () => false));
    },
    async run({ host, signal }) {
      const site = await gateSite(host, signal);
      if (!site) return { pass: false, severity: 'advisory', summary: 'not checked: the workspace cannot be read here' };
      const got = await latestReport(site.root);
      if (!got) return { pass: false, summary: 'no playtest yet', details: 'Run game_playtest (with goal) and fix what it finds.' };
      const r = got.report;
      const problems = [];
      if (r.result !== 'pass') problems.push(`result ${r.result}`);
      if (r.crashes?.length || r.events?.some((e) => e.type === 'crash')) problems.push('it crashed');
      if (r.metrics?.errors) problems.push(`${r.metrics.errors} uncaught error(s)`);
      if (r.metrics?.consoleErrors) problems.push(`${r.metrics.consoleErrors} console error(s)`);
      if (!r.goalReached) problems.push(r.goal ? `nobody reached the goal (${r.goal})` : 'no player reached the game\'s goal (give game_playtest a goal and make the game say when it is reached: window.__game.won)');
      const budget = r.metrics?.fpsBudget ?? 30;
      if (typeof r.metrics?.fpsAvg === 'number' && r.metrics.fpsAvg < budget) problems.push(`${r.metrics.fpsAvg} fps (budget ${budget})`);
      for (const v of r.verdicts ?? []) if (!v.pass) problems.push(`verdict failed: ${v.claim}`);
      return problems.length
        ? { pass: false, summary: `playtest ${r.id}: ${problems.slice(0, 3).join('; ')}`, details: describeReport(r, got.dir) }
        : { pass: true, summary: `playtest ${r.id} passes: goal reached by ${r.goalReachedBy ?? 'a player'}, no errors${typeof r.metrics?.fpsAvg === 'number' ? `, ${r.metrics.fpsAvg} fps` : ''}` };
    },
  });

  api.registerGate({
    name: 'playtest-regressions',
    description: 'Every recorded regression (.studio/regressions/*.json) replays exactly and its expectations hold.',
    async applies(h) {
      if (h.kind === 'companion') return false;
      try { return (await fsp.readdir(path.join(h.root, '.studio', 'regressions'))).some((f) => f.endsWith('.json')); } catch { return false; }
    },
    async run({ host, signal }) {
      const site = await gateSite(host, signal);
      if (!site) return { pass: false, severity: 'advisory', summary: 'not checked: the workspace cannot be read here' };
      const dir = path.join(site.root, '.studio', 'regressions');
      const list = (await fsp.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json'));
      const failed = [];
      for (const f of list) {
        const reg = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'));
        const r = await replayRegression((o) => startSession(site.host, { ...o, root: site.root }), reg, {}, signal);
        if (!r.pass) failed.push(`${f}: ${[...(r.run.crashed ? ['crashed'] : []), ...r.verdicts.filter((v) => !v.pass).map((v) => `${v.claim} - ${v.detail}`)].join('; ')}`);
      }
      return failed.length ? { pass: false, summary: `${failed.length} of ${list.length} regression(s) fail`, details: failed.join('\n') } : { pass: true, summary: `${list.length} regression(s) replay and pass` };
    },
  });
}

/** For tests: close every open play session. */
export async function closeAllPlay() {
  for (const id of [...sessions.keys()]) await closePlay(id).catch(() => {});
}

export { describeCheck };
