// The heavy-job queue shared by the engine plugins: renders, builds, cooks, bakes and long
// plays run one at a time per engine (HARNESS_ENGINE_JOBS=<n> raises it), each with a
// timeout and a cancel, so two agents never fight over a GPU or a 20 GB cook.
// The queue lives on globalThis so every plugin that imports this file shares it.

const KEY = Symbol.for('harness.games3d.jobs');
const state = globalThis[KEY] ??= { running: new Map(), waiting: new Map(), jobs: new Map(), seq: 0 };
const limit = () => Math.max(1, Number(process.env.HARNESS_ENGINE_JOBS) || 1);

/**
 * Runs `work(signal)` as a heavy job of `engine`, waiting its turn. The signal aborts when
 * the caller's signal does, on cancel(id), or after timeoutMs. Resolves with work's value;
 * rejects with { cancelled | timedOut } errors.
 */
export function runJob(engine, title, work, { signal, timeoutMs = 30 * 60_000 } = {}) {
  const id = `job-${++state.seq}`;
  const ctl = new AbortController();
  const job = { id, engine, title, status: 'waiting', queuedAt: Date.now(), ctl };
  state.jobs.set(id, job);
  const onAbort = () => ctl.abort(signal?.reason ?? new Error('cancelled'));
  signal?.addEventListener('abort', onAbort, { once: true });
  const start = () => new Promise((resolve, reject) => {
    job.status = 'running';
    job.startedAt = Date.now();
    state.running.set(engine, (state.running.get(engine) ?? 0) + 1);
    const timer = setTimeout(() => { job.timedOut = true; ctl.abort(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
    Promise.resolve().then(() => work(ctl.signal)).then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      job.status = ctl.signal.aborted ? (job.timedOut ? 'timed-out' : 'cancelled') : 'done';
      job.endedAt = Date.now();
      state.running.set(engine, state.running.get(engine) - 1);
      next(engine);
    });
  });
  return new Promise((resolve, reject) => {
    const go = () => start().then(resolve, reject);
    const q = state.waiting.get(engine) ?? [];
    if ((state.running.get(engine) ?? 0) < limit() && !q.length) go();
    else {
      q.push({ job, go, reject });
      state.waiting.set(engine, q);
      ctl.signal.addEventListener('abort', () => {
        const i = q.findIndex((w) => w.job === job);
        if (i >= 0) { q.splice(i, 1); job.status = 'cancelled'; reject(ctl.signal.reason); }
      }, { once: true });
    }
  });
}

function next(engine) {
  const q = state.waiting.get(engine);
  if (q?.length && (state.running.get(engine) ?? 0) < limit()) q.shift().go();
}

/** Cancels a waiting or running job. */
export function cancelJob(id) {
  const job = state.jobs.get(id);
  if (!job || job.status === 'done') return false;
  job.ctl.abort(new Error('cancelled'));
  return true;
}

/** The jobs of the last hour (for the Studio's Jobs view and agents). */
export function listJobs() {
  const since = Date.now() - 3600_000;
  return [...state.jobs.values()].filter((j) => j.status === 'waiting' || j.status === 'running' || (j.endedAt ?? 0) > since)
    .map(({ ctl, ...j }) => j);
}
