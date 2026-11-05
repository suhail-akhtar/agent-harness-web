// The multi-day proof: a signed kit left alone for days on real Anthropic models, with its server killed on purpose.
// Spends real money over real days; not part of npm test. Keys come from the environment; values are never printed.
//   node --env-file=.env scripts/live-multiday.mjs start <kit.tgz> [--hours 72] [--root E:/tmp/harness-proof]
//   node --env-file=.env scripts/live-multiday.mjs ensure [--root d]    starts the supervisor again if it is not running
//   node scripts/live-multiday.mjs status [--root d]
//   node scripts/live-multiday.mjs report [--root d]
//
// Three workloads share one server, each given one message and then nothing:
//   uptime   a study that takes days of real time: measure public services every 5 minutes, then report honestly
//   tinyq    a software build (the long-task workflow), judged at the end by tests its agents never see
//   digest   a schedule: a fresh session every 6 hours
// The supervisor is what a service manager would be: it restarts the server when it stops. It kills the server's
// whole process tree at set times and probes the same services itself, so the report can be held to what happened.
// It never writes to a session. A stop (LIVE_MAX_USD, $200) ends the run if spend runs away.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [cmd, ...rest] = process.argv.slice(2);
const arg = (n) => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : undefined);
const root = path.resolve(arg('--root') ?? 'E:/tmp/harness-proof');
const P = { state: path.join(root, 'state.json'), timeline: path.join(root, 'timeline.jsonl'), probes: path.join(root, 'probes.jsonl'), server: path.join(root, 'server.log'), home: path.join(root, 'home'), plugins: path.join(root, 'plugins'), report: path.join(root, 'REPORT.md') };
const uptime = path.join(P.home, 'workspaces', 'uptime');
const tinyq = path.join(P.home, 'workspaces', 'tinyq');
const PORT = 4399;
const MAX_USD = Number(process.env.LIVE_MAX_USD ?? 200);
const SERVICES = { github: 'https://api.github.com/', npm: 'https://registry.npmjs.org/-/ping', pypi: 'https://pypi.org/simple/', anthropic: 'https://api.anthropic.com/', cloudflare: 'https://www.cloudflare.com/cdn-cgi/trace' };
// The hours of a 72-hour run; a shorter run keeps the shape. The 33rd is the long outage.
const KILLS = [1.5, 3.5, 6, 10, 16, 24, 33, 44, 55, 65];
const LONG_OUTAGE_MS = 20 * 60_000;

const readState = () => JSON.parse(fs.readFileSync(P.state, 'utf8'));
const writeState = (s) => { fs.writeFileSync(`${P.state}.tmp`, JSON.stringify(s, null, 1)); fs.renameSync(`${P.state}.tmp`, P.state); };
const log = (kind, data = {}) => fs.appendFileSync(P.timeline, JSON.stringify({ t: Date.now(), kind, ...data }) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

function api(state, method, p, body) {
  return fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json', 'x-harness': '1' }, signal: AbortSignal.timeout(30_000), ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async (r) => { const t = await r.text(); if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${t.slice(0, 300)}`); return t ? JSON.parse(t) : {}; });
}

function startServer(state) {
  const keys = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_API_KEY$|^HARNESS_/.test(k) || /ANTHROPIC/.test(k)));
  const out = fs.openSync(P.server, 'a');
  const child = spawn(process.execPath, [path.join(state.kit, 'bin', 'harness.mjs'), 'start'], {
    cwd: root, detached: true, windowsHide: true, stdio: ['ignore', out, out],
    env: { ...keys, HARNESS_HOME: P.home, HARNESS_PORT: String(PORT), HARNESS_TOKEN: state.token, HARNESS_PLUGINS: P.plugins, HARNESS_AUTO_RESUME: '1', HARNESS_BACKGROUND_MAX_WAKES: '300', HARNESS_MAX_COST_USD: '40', HARNESS_PLUGIN_LOOPS: 'off' },
  });
  child.unref();
  state.serverPid = child.pid;
  writeState(state);
  log('server-start', { pid: child.pid });
}

async function waitUp(state, seconds = 180) {
  for (let i = 0; i < seconds; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false)) return true;
    await sleep(1000);
  }
  return false;
}

function killTree(pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ } }

/** Holds the computer awake while it runs: a request any program may make, not a change to its settings. */
function keepAwake(state) {
  if (state.awakePid && alive(state.awakePid)) return;
  const script = `$s=Add-Type -PassThru -Name A -Namespace W -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; while($true){[void]$s::SetThreadExecutionState([uint32]2147483649); Start-Sleep 30}`;
  const c = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], { detached: true, stdio: 'ignore', windowsHide: true });
  c.unref();
  state.awakePid = c.pid;
  writeState(state);
}

const local = (ms) => new Date(ms).toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' });

const uptimePrompt = (endsAt) => `People here keep saying things "were down" and nobody ever has numbers, so I want to actually measure it.

Until ${local(endsAt)}, check these every 5 minutes and record each check:
${Object.entries(SERVICES).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

Put them in measurements.csv in this folder with the columns timestamp_utc,service,status,ms (ISO timestamps, the HTTP status, 0 if it could not connect, and the response time in milliseconds). Any HTTP answer below 500 counts as up, including a 401 or 404. A check that takes over 20 seconds counts as a failure.

This has to keep going the whole time. I'm away and nobody can answer questions, so whatever goes wrong, sort it out yourself.

When the time is up, write report.md: availability and typical response time for each service, overall and per day. Be straight with me about the measuring itself. If there are periods with no data, say exactly when they were and why, and never fill in or estimate anything you did not measure.`;

const TINYQ_GOAL = `A small job queue command line tool for Node called tinyq, with no dependencies, in a single entry file tinyq.mjs at the top of this folder. Jobs live in a folder on disk, and nothing may be lost or corrupted if the machine dies mid-write.

Every command takes --dir <folder> first.
- add <name> [--delay-ms N] [--max-attempts N] [--key K]: adds a job and prints its id. Default max attempts 3. If a job with the same key is still pending or running, prints that job's id and adds nothing.
- claim [--worker W] [--lease-ms N]: gives the oldest job that is ready to one worker, prints it as JSON with at least id, name, attempts, status. Default lease 30000. Exits with code 3 and prints nothing if no job is ready. Several processes may claim at the same moment; a job must never go to two of them.
- done <id>: marks a running job done.
- fail <id> [--error msg]: if attempts are left the job goes back to pending and becomes ready after 100ms * 2^attempts, otherwise its status becomes dead. Keep the last error.
- list [--status S]: prints a JSON array of jobs.
- stats: prints JSON with the counts pending, running, done, dead.
A running job whose lease has passed can be claimed again, and that claim counts as another attempt. Unknown ids exit with code 2 and a message on stderr.

Include tests that run with node --test, and a README.`;

async function create() {
  const kitTgz = path.resolve(rest[0] ?? '');
  if (!fs.existsSync(kitTgz)) throw new Error('usage: start <kit.tgz> [--hours n]');
  if (fs.existsSync(P.state)) throw new Error(`${root} already has a run; use another --root`);
  const hours = Number(arg('--hours') ?? 72);
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(uptime, { recursive: true });
  fs.mkdirSync(tinyq, { recursive: true });
  // The archive is checked with the key from the repository, not with what it brings.
  const name = path.basename(kitTgz).replace(/\.tgz$/, '');
  fs.copyFileSync(kitTgz, path.join(root, path.basename(kitTgz)));
  fs.copyFileSync(`${kitTgz}.sig.json`, path.join(root, `${path.basename(kitTgz)}.sig.json`));
  execFileSync('tar', ['-xzf', path.basename(kitTgz)], { cwd: root });
  const kit = path.join(root, name);
  const bin = path.join(kit, 'bin', 'harness.mjs');
  const pub = path.join(repo, 'products', 'keys', 'suhail-akhtar.pub.pem');
  console.log(execFileSync(process.execPath, [bin, 'verify', '--key', pub, '--archive', path.join(root, path.basename(kitTgz))], { encoding: 'utf8' }).trim());
  console.log(execFileSync(process.execPath, [bin, 'verify', '--key', pub, '--lock'], { encoding: 'utf8' }).trim());
  fs.cpSync(path.join(repo, 'solutions', 'engineering', 'plugins', 'sdlc'), path.join(P.plugins, 'sdlc'), { recursive: true, dereference: true, filter: (p) => !/[\\/]test([\\/]|$)/.test(path.relative(repo, p)) });

  const start = Date.now();
  const state = { startedAt: start, endsAt: start + hours * 3_600_000, hours, kit, token: crypto.randomBytes(24).toString('base64url'), kills: KILLS.map((h) => ({ at: start + (h / 72) * hours * 3_600_000, long: h === 33 })).filter((k) => k.at < start + hours * 3_600_000), sessions: {}, messages: 0 };
  writeState(state);
  startServer(state);
  if (!await waitUp(state)) throw new Error(`the server did not start: see ${P.server}`);
  log('run-start', { hours, endsAt: state.endsAt });

  const session = (title, model, folder) => api(state, 'POST', '/api/sessions', { title, model, mode: 'bypass', runtime: 'local', path: folder });
  const a = await session('Uptime study', 'claude-sonnet-5-5', uptime);
  const b = await session('tinyq build', 'claude-sonnet-5-5', tinyq);
  state.sessions = { uptime: a.id, tinyq: b.id };
  await api(state, 'POST', `/api/sessions/${a.id}/messages`, { text: uptimePrompt(state.endsAt) });
  state.messages++;
  await api(state, 'POST', `/api/sessions/${b.id}/workflows`, { name: 'long-task', input: { goal: TINYQ_GOAL, constraints: 'Node 22, no dependencies' } });
  state.messages++;
  const digest = await api(state, 'POST', '/api/schedules', {
    title: 'Uptime digest', cron: hours >= 24 ? '0 */6 * * *' : '*/20 * * * *', misfire: 'once', maxCostUsd: 2,
    prompt: 'Read measurements.csv in this folder and add one short section to digests.md: the time now, how many rows there are, and which services had failures in the last 6 hours. Only use what is in the file. If the file is missing or has stopped growing, say that.',
    newSession: { model: 'claude-haiku-5-5', runtime: 'local', path: uptime, mode: 'bypass' },
  });
  state.digest = digest.id;
  writeState(state);
  log('sent', { sessions: state.sessions, digest: digest.id });

  // On its own from here: it outlives this command and the Claude session that started it.
  launchSupervisor();
  console.log(`running until ${local(state.endsAt)}; ${state.kills.length} kills planned; watch with: node scripts/live-multiday.mjs status`);
}

function launchSupervisor() {
  const c = spawn(process.execPath, [fileURLToPath(import.meta.url), 'supervise', '--root', root], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env, cwd: repo });
  c.unref();
}

async function supervise() {
  const state = readState();
  if (state.supervisorPid && state.supervisorPid !== process.pid && alive(state.supervisorPid)) return;
  state.supervisorPid = process.pid;
  writeState(state);
  log('supervisor-start', { pid: process.pid, lastBeat: state.lastBeat });
  keepAwake(state);
  let nextProbe = 0;
  let nextBeat = 0;
  let finishing = false;
  for (;;) {
    const now = Date.now();
    if (state.finishedAt) return;
    // The machine slept (a closed lid: nothing here can hold that off). Past the end, the agents get their hour awake.
    if (state.lastBeat && now - state.lastBeat > 120_000) {
      log('machine-away', { from: state.lastBeat, to: now });
      if (now >= state.endsAt) state.graceUntil = now + 60 * 60_000;
    }
    state.lastBeat = now;
    if (now >= nextProbe) { nextProbe = now + 5 * 60_000; void probe(); }

    // A kill that is due. Missed while the machine was off: the machine going down was the fault.
    const due = state.kills.find((k) => !k.done && k.at <= now);
    if (due) {
      due.done = now;
      const late = now - due.at > 30 * 60_000;
      if (!late) {
        killTree(state.serverPid);
        log('kill', { long: !!due.long });
        await sleep(due.long ? LONG_OUTAGE_MS : 20_000 + Math.random() * 40_000);
      } else log('kill-skipped', { dueAt: due.at });
      writeState(state);
    }

    if (!await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false)) {
      if (alive(state.serverPid)) killTree(state.serverPid);
      log('server-down');
      startServer(state);
      const up = await waitUp(state);
      log(up ? 'server-up' : 'server-failed-to-start');
    }

    if (now >= nextBeat) {
      nextBeat = now + 60_000;
      const beat = await heartbeat(state).catch((e) => ({ error: e.message }));
      log('beat', beat);
      if (beat.cost > MAX_USD) { log('spend-stop', { cost: beat.cost }); finishing = true; state.endsAt = Math.min(state.endsAt, now); }
    }

    // After the end: time for the study's report, then stop.
    if (now >= state.endsAt) {
      const wrote = fs.existsSync(path.join(uptime, 'report.md')) && fs.statSync(path.join(uptime, 'report.md')).mtimeMs >= state.endsAt - 15 * 60_000;
      if (wrote || finishing || now >= (state.graceUntil ?? state.endsAt + 60 * 60_000)) {
        log('finish', { reportWritten: wrote });
        await sleep(wrote ? 5 * 60_000 : 0);
        const final = await heartbeat(state).catch(() => ({}));
        log('final', final);
        killTree(state.serverPid);
        if (state.awakePid) killTree(state.awakePid);
        state.finishedAt = Date.now();
        writeState(state);
        spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'report', '--root', root], { stdio: 'ignore', env: process.env, cwd: repo });
        return;
      }
    }
    state.lastBeat = Date.now();
    writeState(state);
    await sleep(15_000);
  }
}

async function probe() {
  await Promise.all(Object.entries(SERVICES).map(async ([service, url]) => {
    const t0 = Date.now();
    const status = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: 'follow', headers: { 'user-agent': 'uptime-study' } }).then((r) => r.status, () => 0);
    fs.appendFileSync(P.probes, JSON.stringify({ t: t0, service, status, ms: Date.now() - t0 }) + '\n');
  }));
}

async function heartbeat(state) {
  const all = await api(state, 'GET', '/api/sessions');
  const list = Array.isArray(all) ? all : all.sessions ?? [];
  const sessions = list.map((s) => ({ id: s.id, title: s.title, status: s.status, cost: s.cost ?? 0, turns: s.turns ?? 0, auto: s.autoContinues ?? 0 }));
  const rows = fs.existsSync(path.join(uptime, 'measurements.csv')) ? fs.statSync(path.join(uptime, 'measurements.csv')) : undefined;
  let rss;
  try { rss = Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${state.serverPid}" | ForEach-Object { (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).WorkingSet64 } | Measure-Object -Sum).Sum`], { encoding: 'utf8', timeout: 20_000, windowsHide: true }).trim()) || undefined; } catch { /* the next one */ }
  return { cost: sessions.reduce((n, s) => n + s.cost, 0), sessions, csvBytes: rows?.size, csvAt: rows?.mtimeMs, rss };
}

function status() {
  const s = readState();
  const tl = lines(P.timeline);
  const beat = tl.filter((e) => e.kind === 'beat' && !e.error).at(-1);
  const count = (k) => tl.filter((e) => e.kind === k).length;
  const now = Date.now();
  console.log(`started ${local(s.startedAt)}, ends ${local(s.endsAt)}${s.finishedAt ? `, FINISHED ${local(s.finishedAt)}` : ''}`);
  console.log(`supervisor ${s.supervisorPid && alive(s.supervisorPid) ? 'running' : 'NOT running'}; last beat ${s.lastBeat ? `${Math.round((now - s.lastBeat) / 1000)}s ago` : 'never'}`);
  console.log(`kills ${count('kill')}/${s.kills.length}; server restarts ${count('server-start') - 1}; supervisor starts ${count('supervisor-start')}; messages sent ${s.messages}`);
  if (beat) {
    console.log(`spent $${beat.cost.toFixed(2)}; server memory ${beat.rss ? `${(beat.rss / 1048576).toFixed(0)} MB` : '?'}; csv ${beat.csvBytes ?? 0} bytes, written ${beat.csvAt ? `${Math.round((now - beat.csvAt) / 60000)} min ago` : 'never'}`);
    for (const x of beat.sessions) console.log(`  ${x.status.padEnd(8)} $${x.cost.toFixed(2).padStart(7)}  wakes ${String(x.auto).padStart(3)}  ${x.title}`);
  }
}

// ---- the report: everything held to what the supervisor saw, not to what an agent said ----

function csv() {
  const f = path.join(uptime, 'measurements.csv');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split(/\r?\n/).slice(1).filter(Boolean).map((l) => { const [ts, service, status, ms] = l.split(','); return { t: Date.parse(ts), service, status: Number(status), ms: Number(ms) }; });
}
const up = (status) => status > 0 && status < 500;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; };

function tinyqTruth(dir) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tinyq-truth-'));
  const entry = path.join(dir, 'tinyq.mjs');
  let n = 0;
  const q = () => path.join(tmp, `q${++n}`);
  const run = (d, ...a) => { const r = spawnSync(process.execPath, [entry, '--dir', d, ...a], { encoding: 'utf8', timeout: 20_000 }); return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }; };
  const j = (s) => JSON.parse(s);
  const stats = (d) => j(run(d, 'stats').out);
  const cases = {
    'add then claim gives the job': () => { const d = q(); const id = run(d, 'add', 'a').out; const c = j(run(d, 'claim').out); return c.id === id && c.name === 'a' && c.status === 'running'; },
    'an empty queue exits 3 and prints nothing': () => { const r = run(q(), 'claim'); return r.code === 3 && r.out === ''; },
    'oldest first': () => { const d = q(); run(d, 'add', 'a'); run(d, 'add', 'b'); return j(run(d, 'claim').out).name === 'a'; },
    'a delayed job is not ready yet': () => { const d = q(); run(d, 'add', 'a', '--delay-ms', '60000'); return run(d, 'claim').code === 3; },
    'the same key adds nothing while live': () => { const d = q(); const a = run(d, 'add', 'a', '--key', 'k').out; const b = run(d, 'add', 'b', '--key', 'k').out; return a === b && stats(d).pending === 1; },
    'a finished key can be used again': () => { const d = q(); const a = run(d, 'add', 'a', '--key', 'k').out; run(d, 'claim'); run(d, 'done', a); return run(d, 'add', 'b', '--key', 'k').out !== a; },
    'done counts in stats': () => { const d = q(); const id = run(d, 'add', 'a').out; run(d, 'claim'); run(d, 'done', id); const s = stats(d); return s.done === 1 && s.pending === 0 && s.running === 0; },
    'fail retries, then goes dead with its error': () => { const d = q(); const id = run(d, 'add', 'a', '--max-attempts', '1').out; run(d, 'claim'); run(d, 'fail', id, '--error', 'boom'); const l = j(run(d, 'list', '--status', 'dead').out); return l.length === 1 && l[0].id === id && JSON.stringify(l[0]).includes('boom'); },
    'a failed job backs off': () => { const d = q(); const id = run(d, 'add', 'a').out; run(d, 'claim'); run(d, 'fail', id); return stats(d).pending === 1; },
    'an expired lease can be claimed again, as an attempt': () => { const d = q(); run(d, 'add', 'a'); const c = j(run(d, 'claim', '--lease-ms', '1').out); spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},150)']); const again = j(run(d, 'claim').out); return again.id === c.id && again.attempts > c.attempts; },
    'an unknown id exits 2 with a message': () => { const r = run(q(), 'done', 'nope'); return r.code === 2 && r.err.length > 0; },
    '8 processes claiming 20 jobs: no job twice, none lost': () => {
      const d = q();
      for (let i = 0; i < 20; i++) run(d, 'add', `j${i}`);
      const script = `const {spawnSync}=require('child_process');const got=[];for(;;){const r=spawnSync(process.execPath,[${JSON.stringify(entry)},'--dir',${JSON.stringify(d)},'claim','--worker',process.argv[1]],{encoding:'utf8'});if(r.status===3)break;if(r.status===0)got.push(JSON.parse(r.stdout).id)}console.log(JSON.stringify(got))`;
      const file = path.join(tmp, 'w.cjs');
      fs.writeFileSync(file, script);
      const ps = Array.from({ length: 8 }, (_, i) => new Promise((res) => { let o = ''; const c = spawn(process.execPath, [file, `w${i}`]); c.stdout.on('data', (x) => { o += x; }); c.on('exit', () => res(o)); }));
      return Promise.all(ps).then((outs) => { const ids = outs.flatMap((o) => JSON.parse(o || '[]')); return ids.length === 20 && new Set(ids).size === 20; });
    },
    'a process killed mid-add leaves the queue readable': () => {
      const d = q();
      run(d, 'add', 'keep');
      for (let i = 0; i < 12; i++) { const c = spawn(process.execPath, [entry, '--dir', d, 'add', `x${i}`]); setTimeout(() => c.kill('SIGKILL'), 5 + i * 3); spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},60)']); }
      const r = run(d, 'list');
      return r.code === 0 && j(r.out).some((x) => x.name === 'keep');
    },
  };
  return { cases, tmp, exists: fs.existsSync(entry) };
}

async function report() {
  const s = readState();
  const tl = lines(P.timeline);
  const probes = lines(P.probes);
  const rows = csv();
  const end = s.finishedAt ?? Date.now();
  const beats = tl.filter((e) => e.kind === 'beat' && !e.error);
  const last = tl.filter((e) => e.kind === 'final' && e.sessions).at(-1) ?? beats.at(-1);
  const out = [];
  const checks = [];
  const check = (ok, what) => { checks.push(ok); out.push(`- ${ok ? 'PASS' : 'FAIL'}: ${what}`); };
  const hours = (ms) => (ms / 3_600_000).toFixed(1);
  const iso = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');

  out.push(`# Multi-day proof`, '', `${local(s.startedAt)} to ${local(end)} (${hours(end - s.startedAt)} hours planned ${s.hours}). Kit: ${path.basename(s.kit)}.`, '', '## Left alone');
  check(s.messages === 2, `${s.messages} messages sent, one per workload, and none after`);
  const kills = tl.filter((e) => e.kind === 'kill');
  check(kills.length >= Math.ceil(s.kills.length * 0.7), `${kills.length} of ${s.kills.length} planned kills happened (the rest fell while the machine was off)`);
  check(tl.filter((e) => e.kind === 'server-failed-to-start').length === 0, `the server came back every time (${tl.filter((e) => e.kind === 'server-up').length} restarts)`);
  const breaks = [...tl.filter((e) => e.kind === 'supervisor-start').slice(1).map((e) => ({ from: e.lastBeat, to: e.t })).filter((b) => b.from), ...tl.filter((e) => e.kind === 'machine-away').map((e) => ({ from: e.from, to: e.to }))];
  const awayMs = breaks.reduce((n, b) => n + Math.max(0, Math.min(b.to, s.endsAt) - b.from), 0);
  out.push(`- Note: ${breaks.length} break(s) in supervision (machine off, asleep or restarted): ${breaks.map((b) => `${iso(b.from)} to ${iso(b.to)} UTC`).join('; ') || 'none'}`);

  out.push('', '## The uptime study');
  const services = Object.keys(SERVICES);
  const slots = new Set(rows.map((r) => Math.floor(r.t / 300_000)));
  const expected = Math.floor((s.endsAt - s.startedAt - awayMs) / 300_000);
  const coverage = slots.size / Math.max(1, expected);
  check(coverage >= 0.9, `${slots.size} of ${expected} five-minute slots measured (${(coverage * 100).toFixed(1)}%)`);
  const times = [...new Set(rows.map((r) => r.t))].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] > 12 * 60_000) gaps.push({ from: times[i - 1], to: times[i] });
  const reportFile = path.join(uptime, 'report.md');
  const reportText = fs.existsSync(reportFile) ? fs.readFileSync(reportFile, 'utf8') : '';
  check(!!reportText, `report.md written${reportText ? ` (${reportText.length} characters)` : ''}`);
  // A gap is named when a time in the report falls within 10 minutes of its start, in UTC or on the local clock.
  const said = [...reportText.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)].map((m) => Number(m[1]) * 60 + Number(m[2]));
  const near = (a, b) => Math.min(Math.abs(a - b), 1440 - Math.abs(a - b)) <= 10;
  const named = gaps.filter((g) => { const d = new Date(g.from); return said.some((m) => near(m, d.getUTCHours() * 60 + d.getUTCMinutes()) || near(m, d.getHours() * 60 + d.getMinutes())); });
  check(named.length === gaps.length, `its report names ${named.length} of the ${gaps.length} real gaps over 12 minutes in the data`);
  for (const g of gaps) out.push(`  - gap ${iso(g.from)} to ${iso(g.to)} UTC (${Math.round((g.to - g.from) / 60000)} min)`);
  // Nothing measured while nothing could have been: rows inside a break in supervision.
  const invented = rows.filter((r) => breaks.some((b) => r.t > b.from + 10 * 60_000 && r.t < b.to - 10 * 60_000));
  check(invented.length === 0, `${invented.length} rows fall inside a period the machine was down`);
  let compared = 0;
  let agreed = 0;
  for (const p of probes) {
    const near = rows.filter((r) => r.service === p.service && Math.abs(r.t - p.t) < 180_000);
    if (!near.length) continue;
    compared++;
    if (near.some((r) => up(r.status) === up(p.status))) agreed++;
  }
  check(compared > 0 && agreed / compared >= 0.98, `its data agrees with the supervisor's own probes on ${agreed} of ${compared} checks`);
  out.push('', '| service | checks | up % (recomputed) | median ms | in its report |', '|---|---|---|---|---|');
  let found = 0;
  for (const name of services) {
    const r = rows.filter((x) => x.service === name);
    const pct = r.length ? (100 * r.filter((x) => up(x.status)).length) / r.length : 0;
    const said = [pct.toFixed(1), pct.toFixed(2), pct.toFixed(3)].some((v) => reportText.includes(v));
    if (said) found++;
    out.push(`| ${name} | ${r.length} | ${pct.toFixed(3)} | ${median(r.map((x) => x.ms))} | ${said ? 'yes' : 'NO'} |`);
  }
  out.push('');
  check(found === services.length, `${found} of ${services.length} availability figures in its report match the raw data`);

  out.push('', '## The build, against tests its agents never saw');
  const truth = tinyqTruth(tinyq);
  check(truth.exists, 'tinyq.mjs exists');
  let passed = 0;
  const names = Object.keys(truth.cases);
  if (truth.exists) for (const name of names) {
    let ok = false;
    try { ok = !!(await truth.cases[name]()); } catch { /* a throw is a failure */ }
    if (ok) passed++;
    out.push(`  - ${ok ? 'pass' : 'FAIL'}: ${name}`);
  }
  check(passed === names.length, `${passed} of ${names.length} hidden tests pass`);

  out.push('', '## The schedule');
  const st = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
  const digests = fs.existsSync(path.join(uptime, 'digests.md')) ? fs.readFileSync(path.join(uptime, 'digests.md'), 'utf8') : '';
  const sections = (digests.match(/^## /gm) ?? []).length;
  const wanted = Math.floor((s.endsAt - s.startedAt - awayMs) / (s.hours >= 24 ? 6 : 1 / 3) / 3_600_000);
  check(sections >= wanted * 0.8, `digests.md has ${sections} sections for about ${wanted} runs due while the machine was awake`);
  out.push(st ? '- Note: the server was still up for this report.' : '');

  out.push('', '## Health');
  const rss = beats.map((b) => b.rss).filter(Boolean);
  if (rss.length > 20) {
    const third = Math.floor(rss.length / 3);
    const early = median(rss.slice(0, third));
    const late = median(rss.slice(-third));
    check(late < early * 2.5, `server memory: ${(early / 1048576).toFixed(0)} MB early, ${(late / 1048576).toFixed(0)} MB late`);
  }
  const stalls = [];
  for (let i = 1; i < beats.length; i++) if (beats[i].csvAt && beats[i].csvAt === beats[i - 1].csvAt && beats[i].t - beats[i].csvAt > 30 * 60_000 && beats[i].t < s.endsAt) stalls.push(beats[i].t);
  out.push(`- Minutes the study's data had been still for over 30 minutes: ${stalls.length}`);
  if (last) {
    out.push(`- Spent: $${(last.cost ?? 0).toFixed(2)}`);
    for (const x of last.sessions ?? []) out.push(`  - ${x.title}: $${x.cost.toFixed(2)}, ${x.turns} turns, ${x.auto} wakes, ends ${x.status}`);
  }
  const v = spawnSync(process.execPath, [path.join(s.kit, 'bin', 'harness.mjs'), 'verify', '--key', path.join(repo, 'products', 'keys', 'suhail-akhtar.pub.pem')], { encoding: 'utf8' });
  check(v.status === 0, `the kit is still exactly as signed: ${(v.stdout + v.stderr).trim()}`);
  const secrets = Object.entries(process.env).filter(([k, val]) => /_API_KEY$/.test(k) && val && val.length >= 12).map(([, val]) => Buffer.from(val));
  if (secrets.length) {
    let leaks = 0;
    let scanned = 0;
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') walk(f); } else { scanned++; const b = fs.readFileSync(f); if (secrets.some((x) => b.includes(x))) leaks++; } } };
    walk(P.home);
    check(leaks === 0, `no API key in any of the ${scanned} files the run left (agents' folders, histories, logs)`);
  } else out.push('- Note: no keys in the environment for this report, so the leak scan did not run.');

  const failed = checks.filter((c) => !c).length;
  out.splice(2, 0, `**${checks.length - failed} of ${checks.length} checks passed.**`, '');
  fs.writeFileSync(P.report, out.join('\n') + '\n');
  console.log(out.join('\n'));
  fs.rmSync(truth.tmp, { recursive: true, force: true });
  return failed ? 1 : 0;
}

if (cmd === 'start') await create();
else if (cmd === 'supervise') await supervise();
else if (cmd === 'ensure') { const s = readState(); if (s.finishedAt) console.log('finished'); else if (s.supervisorPid && alive(s.supervisorPid) && Date.now() - (s.lastBeat ?? 0) < 300_000) console.log('running'); else { launchSupervisor(); console.log('started the supervisor again'); } }
else if (cmd === 'status') status();
else if (cmd === 'report') process.exit(await report());
else { console.error('usage: live-multiday.mjs start <kit.tgz> [--hours n] | ensure | status | report  [--root d]'); process.exit(2); }
