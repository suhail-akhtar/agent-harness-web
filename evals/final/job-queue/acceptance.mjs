// Hidden acceptance checks for the job queue: validation, results, retries with backoff (timed),
// dead jobs and retry, priority order with one worker, the pool limit with three, pause and resume,
// delete rules, the status filter and stats, and persistence across restarts (a running job comes
// back queued). Plain Node, so it runs the same on Linux, macOS and Windows.
//   node acceptance.mjs <workspace> "<start command>" <port>
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [ws = '.', cmd = 'npm start', portArg = '4400'] = process.argv.slice(2);
const P = Number(portArg);
const base = `http://127.0.0.1:${P}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-'));
const F = path.join(tmp, 'jobs.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child;
async function start(env = {}) {
  const e = { ...process.env, PORT: String(P), DATA_FILE: F, WORKERS: '2', BACKOFF_MS: '200', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', ...env };
  child = spawn(cmd, { cwd: path.resolve(ws), env: e, shell: true, stdio: 'ignore', detached: process.platform !== 'win32' });
  for (let i = 0; i < 80; i++) {
    try { await fetch(`${base}/stats`); return; } catch { await sleep(250); }
  }
  console.log('service did not start');
}
async function stop() {
  if (!child) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }
  child = undefined;
  for (let i = 0; i < 20; i++) { try { await fetch(`${base}/stats`); await sleep(250); } catch { return; } }
}

let body;
async function req(p, init = {}) {
  try {
    const r = await fetch(base + p, init);
    const t = await r.text();
    try { body = JSON.parse(t); } catch { body = undefined; }
    return r;
  } catch (e) { body = undefined; return { status: `error ${e.cause?.code ?? e.message}` }; }
}
const post = (p, b) => req(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : typeof b === 'string' ? b : JSON.stringify(b) });
const job = () => (body && typeof body === 'object' && body.job) || body || {};
const list = () => (Array.isArray(body) ? body : body?.jobs ?? body?.items ?? []);
const add = async (b) => { await post('/jobs', b); return job().id; };
const get = async (id) => { await req(`/jobs/${id}`); return job(); };
async function until(id, statuses, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const j = await get(id);
    if (statuses.includes(j.status) || Date.now() > end) return j;
    await sleep(50);
  }
}

let ok = 0, bad = 0;
const check = (name, got, want) => { if (JSON.stringify(got) === JSON.stringify(want)) ok++; else { bad++; console.log(`FAIL ${name}: expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`); } };

try {
  await start();
  // Validation.
  check('echo is created', (await post('/jobs', { type: 'echo', payload: { n: 1 } })).status, 201);
  const echo = job();
  check('created job is queued or running', ['queued', 'running', 'succeeded'].includes(echo.status), true);
  check('unknown type', (await post('/jobs', { type: 'nope' })).status, 400);
  check('priority over 9', (await post('/jobs', { type: 'echo', priority: 10 })).status, 400);
  check('priority not an integer', (await post('/jobs', { type: 'echo', priority: 2.5 })).status, 400);
  check('maxAttempts 0', (await post('/jobs', { type: 'echo', maxAttempts: 0 })).status, 400);
  check('payload not an object', (await post('/jobs', { type: 'echo', payload: 'x' })).status, 400);
  check('malformed json', (await post('/jobs', '{"type":')).status, 400);
  check('body over 10KB', (await post('/jobs', { type: 'echo', payload: { pad: 'a'.repeat(11000) } })).status, 413);
  check('unknown id 404', (await req('/jobs/does-not-exist')).status, 404);
  check('404 is json', body !== undefined, true);

  // Results.
  let j = await until(echo.id, ['succeeded', 'dead']);
  check('echo succeeds with its payload', [j.status, j.result], ['succeeded', { n: 1 }]);
  check('echo took one attempt', j.attempts, 1);
  check('finishedAt set', typeof j.finishedAt === 'number' && j.finishedAt >= j.createdAt, true);

  // Retries with backoff: BACKOFF_MS 200, so attempt 2 no sooner than 200ms after the first failure, attempt 3 no sooner than 400ms after the second.
  const t0 = Date.now();
  const failId = await add({ type: 'fail', maxAttempts: 3 });
  j = await until(failId, ['dead'], 10000);
  check('fail ends dead after 3 attempts', [j.status, j.attempts], ['dead', 3]);
  check('dead keeps the error', /failed on purpose/.test(String(j.error)), true);
  check('backoff waited (>= 600ms in all)', Date.now() - t0 >= 600, true);
  const flakyOk = await add({ type: 'flaky', payload: { failTimes: 2, v: 'x' }, maxAttempts: 3 });
  j = await until(flakyOk, ['succeeded', 'dead'], 10000);
  check('flaky succeeds on the third attempt', [j.status, j.attempts, j.result?.v], ['succeeded', 3, 'x']);
  const flakyDead = await add({ type: 'flaky', payload: { failTimes: 3 }, maxAttempts: 3 });
  j = await until(flakyDead, ['succeeded', 'dead'], 10000);
  check('flaky with too few attempts dies', [j.status, j.attempts], ['dead', 3]);

  // Retry and delete rules.
  check('retry a dead job', (await post(`/jobs/${failId}/retry`)).status, 200);
  check('retried job is queued with attempts 0', [['queued', 'running'].includes(job().status), job().attempts === 0 || job().status === 'running'], [true, true]);
  check('retry a succeeded job is 409', (await post(`/jobs/${flakyOk}/retry`)).status, 409);
  check('status filter', (await req('/jobs?status=dead')).status, 200);
  check('filter lists only dead jobs', list().length >= 1 && list().every((x) => x.status === 'dead'), true);
  check('unknown status is 400', (await req('/jobs?status=bogus')).status, 400);
  const slow = await add({ type: 'echo', payload: { ms: 1500 } });
  await until(slow, ['running'], 4000);
  check('delete a running job is 409', (await req(`/jobs/${slow}`, { method: 'DELETE' })).status, 409);
  check('delete a dead job', (await req(`/jobs/${flakyDead}`, { method: 'DELETE' })).status, 204);
  check('deleted job is gone', (await req(`/jobs/${flakyDead}`)).status, 404);
  await until(slow, ['succeeded'], 5000);
  await until(failId, ['dead'], 10000);
  check('list newest first', (await req('/jobs')).status === 200 && list()[0]?.id === slow, true);
  await stop();

  // Priority order with one worker: paused, four queued, then resumed.
  await start({ WORKERS: '1' });
  check('pause', (await post('/workers/pause')).status, 200);
  const low = await add({ type: 'echo', priority: 1, payload: { ms: 100 } });
  const high = await add({ type: 'echo', priority: 9, payload: { ms: 100 } });
  const midA = await add({ type: 'echo', priority: 5, payload: { ms: 100 } });
  const midB = await add({ type: 'echo', priority: 5, payload: { ms: 100 } });
  await sleep(400);
  check('paused: nothing runs', (await get(high)).status, 'queued');
  check('resume', (await post('/workers/resume')).status, 200);
  for (const id of [low, high, midA, midB]) await until(id, ['succeeded'], 6000);
  const starts = [];
  for (const id of [high, midA, midB, low]) starts.push((await get(id)).startedAt);
  check('highest priority first, FIFO within a priority', starts.every((s, i) => i === 0 || (typeof s === 'number' && s > starts[i - 1])), true);
  await stop();

  // The pool limit with three workers.
  await start({ WORKERS: '3' });
  await post('/workers/pause');
  const pool = [];
  for (let i = 0; i < 5; i++) pool.push(await add({ type: 'echo', payload: { ms: 800 } }));
  await post('/workers/resume');
  await sleep(350);
  await req('/stats');
  check('three run at once, never more', [body?.running, body?.queued], [3, 2]);
  for (const id of pool) await until(id, ['succeeded'], 6000);
  await req('/stats');
  check('stats count succeeded', typeof body?.succeeded === 'number' && body.succeeded >= 5, true);

  // Persistence: a running job is killed mid-attempt and comes back queued, attempt not counted.
  const longJob = await add({ type: 'echo', payload: { ms: 4000, keep: true } });
  await until(longJob, ['running'], 4000);
  await post('/workers/pause');
  const waiting = await add({ type: 'echo', payload: { keep: 'queued' } });
  await stop();
  await start({ WORKERS: '1' });
  j = await get(longJob);
  check('a running job is queued again after a restart', [['queued', 'running'].includes(j.status), j.attempts <= 1], [true, true]);
  check('queued job survives a restart', (await req(`/jobs/${waiting}`)).status, 200);
  check('the service starts unpaused', (await until(waiting, ['succeeded'], 8000)).status, 'succeeded');
  check('the interrupted job finishes', (await until(longJob, ['succeeded'], 9000)).status, 'succeeded');
  check('succeeded jobs survive restarts', (await get(pool[0])).status, 'succeeded');
} finally {
  await stop();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`acceptance: ${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
