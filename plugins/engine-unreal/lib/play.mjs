// Playing a game: a scripted run (the play driver's timeline) in the editor's -game mode or a
// packaged build, with frames, a CSV profile and the log; and the step server an AI player
// drives (inputs in, a frame and the state out) inside an editor -game session.

import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { gameArgs, timeline as makeTimeline } from './args.mjs';
import { freePort } from './bridge.mjs';
import { exists, installHelpers, relTo } from './context.mjs';
import { eventsIn, parseCsvProfile, problemsIn } from './logs.mjs';
import { killTree, runUE, startDirect } from './run.mjs';

/** Files under a folder (recursively) changed since a time, oldest first. */
export async function filesSince(dir, since, match = () => true) {
  const out = [];
  async function walk(d) {
    let entries = [];
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (match(e.name)) {
        const st = await fsp.stat(p).catch(() => null);
        if (st && st.mtimeMs >= since) out.push({ file: p, mtime: st.mtimeMs, size: st.size });
      }
    }
  }
  await walk(dir);
  return out.sort((a, b) => a.mtime - b.mtime);
}

/** Whether a level (its .umap, or its one-file-per-actor folder) holds the play driver. */
export async function levelHasDriver(projectDir, mapPath, driver = 'BP_HarnessDriver') {
  const pkg = String(mapPath).split('.')[0].replace(/^\/Game\//, '');
  const umap = path.join(projectDir, 'Content', `${pkg}.umap`);
  const needle = Buffer.from(driver);
  try { if ((await fsp.readFile(umap)).includes(needle)) return true; } catch { return false; }
  const ext = path.join(projectDir, 'Content', '__ExternalActors__', pkg);
  for (const f of await filesSince(ext, 0, (n) => n.endsWith('.uasset'))) {
    if ((await fsp.readFile(f.file)).includes(needle)) return true;
  }
  return false;
}

/** The game's default map from DefaultEngine.ini (GameDefaultMap), as /Game/... */
export async function defaultMap(projectDir) {
  const ini = await fsp.readFile(path.join(projectDir, 'Config', 'DefaultEngine.ini'), 'utf8').catch(() => '');
  return /^\s*GameDefaultMap=(\S+)/m.exec(ini)?.[1]?.split('.')[0] ?? null;
}

/**
 * A scripted play: the game runs for `seconds` (from its first frame of play), the timeline
 * presses keys and takes frames, then everything is gathered into a playtest report.
 * target: { kind: 'editor', editor, uproject, projectDir } or { kind: 'packaged', exe, savedDir }.
 */
export async function playScripted(host, target, o, { signal, onLine } = {}) {
  const t0 = Date.now() - 2000;
  const tl = makeTimeline({ inputs: o.inputs ?? [], seconds: o.seconds ?? 10, captureEveryMs: o.captureEveryMs ?? 1000, width: o.width ?? 1280, height: o.height ?? 720 });
  const logFile = path.join(o.outDir, 'game.log');
  const args = gameArgs({
    uproject: target.uproject, map: o.map, width: o.width ?? 1280, height: o.height ?? 720, log: logFile, timeline: tl,
    packaged: target.kind === 'packaged', extra: o.extra ?? [],
  });
  const exe = target.kind === 'packaged' ? target.exe : target.editor;
  const startupMs = o.startupMs ?? 240_000;
  const r = await runUE(host, exe, args, { timeoutMs: startupMs + (o.seconds ?? 10) * 1000 + 30_000, signal, onLine, exitGraceMs: 8000 });
  const text = (await fsp.readFile(logFile, 'utf8').catch(() => '')) || r.output;
  const saved = target.kind === 'packaged' ? target.savedDir : path.join(target.projectDir, 'Saved');
  const shots = await filesSince(path.join(saved, 'Screenshots'), t0, (n) => /\.png$/i.test(n));
  const framesDir = path.join(o.outDir, 'frames');
  await fsp.mkdir(framesDir, { recursive: true });
  const frames = [];
  for (const [i, s] of shots.entries()) {
    const to = path.join(framesDir, `${String(i).padStart(4, '0')}.png`);
    await fsp.rename(s.file, to).catch(async () => { await fsp.copyFile(s.file, to); });
    frames.push(to);
  }
  const csv = (await filesSince(path.join(saved, 'Profiling', 'CSV'), t0, (n) => /\.csv$/i.test(n))).at(-1);
  let metrics = null;
  if (csv) {
    await fsp.copyFile(csv.file, path.join(o.outDir, 'profile.csv')).catch(() => {});
    metrics = parseCsvProfile(await fsp.readFile(csv.file, 'utf8'));
  }
  const events = eventsIn(text);
  const problems = problemsIn(text, { warnings: false });
  // A game stopped after it asked to exit (the exit grace) is not a crash.
  const crashed = /Fatal error|Unhandled Exception|=== Critical error ===|appError called/i.test(text) || (r.code !== 0 && r.code !== null && !r.timedOut && !r.exitRequested);
  return { run: r, text, timeline: tl, frames, metrics, events, problems, crashed, logFile, startupS: startupOf(text) };
}

/** Seconds from the first log line to the play driver's "ready" (startup and loading). */
function startupOf(text) {
  const ev = eventsIn(text).find((e) => e.type === 'driver');
  return ev?.t ?? null;
}

/** The playtest report of FORMATS.md from a scripted play. */
export function playReport({ id, build, goal, seconds, play, expect = [], host, outDir }) {
  const types = play.events.map((e) => e.type);
  const missing = expect.filter((e) => !types.includes(e));
  const errors = play.problems.filter((p) => p.severity === 'error');
  const result = play.crashed ? 'crash' : play.run.timedOut ? 'timeout' : missing.length || errors.length ? 'fail' : 'pass';
  const issues = [
    ...missing.map((m) => ({ severity: 'major', title: `expected event "${m}" did not happen` })),
    ...errors.slice(0, 20).map((p) => ({ severity: 'major', title: p.message })),
    ...(play.frames.length ? [] : [{ severity: 'minor', title: 'no frames were captured (is the play driver in the level?)' }]),
  ];
  return {
    id, engine: 'unreal', build: build ?? null, player: 'bot:scripted', goal: goal ?? null, result,
    durationS: Math.round(play.run.took * 10) / 10, steps: play.timeline.split(';').length,
    events: play.events,
    metrics: { ...(play.metrics ?? {}), errors: errors.length, ...(play.startupS != null ? { startupS: play.startupS } : {}) },
    frames: play.frames.map((f) => path.relative(outDir, f).split(path.sep).join('/')),
    issues, verdicts: [],
    log: relTo(host, play.logFile),
    seconds,
  };
}

// ---------- the step server ----------

/** A JSON-lines connection to the step server. */
export function stepClient(port) {
  let sock;
  let buf = '';
  const waiting = [];
  function connect() {
    return new Promise((resolve, reject) => {
      sock = net.connect(port, '127.0.0.1', () => resolve());
      sock.on('error', (e) => { reject(e); for (const w of waiting.splice(0)) w.reject(e); });
      sock.on('data', (d) => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          const w = waiting.shift();
          if (!w) continue;
          try { w.resolve(JSON.parse(line)); } catch (e) { w.reject(e); }
        }
      });
      sock.on('close', () => { for (const w of waiting.splice(0)) w.reject(new Error('the game closed the connection')); });
    });
  }
  return {
    connect,
    request(obj, timeoutMs = 120_000) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`the game did not answer ${obj.op} within ${timeoutMs / 1000} s`)), timeoutMs);
        waiting.push({ resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
        sock.write(`${JSON.stringify(obj)}\n`);
      });
    },
    close() { try { sock?.end(); } catch { /* closed */ } },
  };
}

/**
 * Starts an editor -game session with the step server; resolves when it answers. The game is
 * paused until the first step. watch: class paths whose actors are counted in each state.
 */
export async function startStepSession(host, eng, proj, o = {}) {
  await installHelpers(proj.dir);
  const port = await freePort();
  const script = path.join(proj.dir, 'Content', 'Python', 'harness_step.py').replace(/\\/g, '/');
  // ExecCmds splits commands at commas, so the class list is joined with '+'.
  const watch = (o.watch ?? []).join('+');
  const py = `py ${script} --port ${port} --width ${o.width ?? 1280} --height ${o.height ?? 720}${watch ? ` --watch ${watch}` : ''}`;
  const args = gameArgs({ uproject: proj.file, map: o.map, width: o.width ?? 1280, height: o.height ?? 720, log: o.logFile, extra: [`-ExecCmds=${py}`] });
  const lines = [];
  const child = startDirect(eng.bin.editor, args, { onLine: (l) => { lines.push(l); if (lines.length > 400) lines.shift(); } });
  const client = stepClient(port);
  const t0 = Date.now();
  const limit = o.startupMs ?? 240_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the game exited (code ${child.exitCode}) before the step server started:\n${lines.slice(-20).join('\n')}`);
    if (Date.now() - t0 > limit) { killTree(child); throw new Error(`the step server did not start within ${limit / 1000} s`); }
    try { await client.connect(); break; } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  // The first state once the player exists.
  let state;
  for (let i = 0; i < 120; i++) {
    state = (await client.request({ op: 'state' })).state;
    if (state?.ready) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return { child, client, port, startedAt: Date.now(), startupS: Math.round((Date.now() - t0) / 100) / 10, state, step: 0 };
}

export async function stopStepSession(s) {
  try { await s.client.request({ op: 'quit' }, 10_000); } catch { /* it may be gone */ }
  s.client.close();
  const exited = await new Promise((resolve) => {
    if (s.child.exitCode !== null) return resolve(true);
    const t = setTimeout(() => resolve(false), 20_000);
    s.child.once('close', () => { clearTimeout(t); resolve(true); });
  });
  if (!exited) killTree(s.child);
  return exited;
}

export { exists };
