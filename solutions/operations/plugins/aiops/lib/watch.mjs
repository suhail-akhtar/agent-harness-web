// The model-free watch loop: the server evaluates the inventory's alert rules on a
// timer (PromQL, probes, log patterns - the same evaluation as ops_check, no model)
// and feeds what fires, and what stopped firing, through the same ingestion and
// grouping as the webhooks (lib/alerts.mjs). A model runs only when that opens or
// escalates an incident: a quiet estate costs no model calls at all, where the
// ops-watch workflow ran an agent every round (288 runs a day at 5 minutes).
//
// HARNESS_OPS_WATCH_SECONDS (default 60; 0 turns it off). It runs only where there
// is something to watch: the operator's inventory (HARNESS_OPS_INVENTORY), plus the
// workspace inventory at HARNESS_OPS_WATCH_PATH (or HARNESS_OPS_ALERTS_PATH).
// Several servers on one data folder: only the holder of the plugin's "ops-watch"
// lease evaluates (another takes over when it stops). Like the quality gates, the
// loop uses no Key Vault credential - nobody is there to be asked: a rule that needs
// one (an authenticated Prometheus, logs over ssh) is reported as not evaluated in
// the watch status (alerts list), not fired.

import path from 'node:path';
import { readJson, writeFileAtomic } from '@harness/plugin-sdk/runtime';

const timers = new Set();
/** The plugin's shared parts per data folder: a seam for tests (the round, the alert engine). */
export const instances = new Map();

/** Stops every watch loop this module started (the plugin's close()). */
export function stopWatchLoops() {
  for (const t of timers) { clearInterval(t); clearTimeout(t); }
  timers.clear();
}

export function watchSeconds(env = process.env) {
  const raw = env.HARNESS_OPS_WATCH_SECONDS;
  if (raw === undefined || raw === '') return 60;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.max(5, Math.round(n)) : 0;
}

/**
 * One round's rule results as alerts: a rule that starts firing fires; a rule that fired last round
 * and is ok now resolves. Pending rules (true, not yet for their `for`) and rules that
 * could not be evaluated change nothing.
 */
export function roundAlerts(results, previouslyFiring, now = Date.now()) {
  const alerts = [];
  const firing = new Set();
  for (const r of results) {
    const labels = { alertname: r.name, rule: r.name, ...(r.service ? { service: r.service } : {}), ...(r.implicit ? { implicit: 'true' } : {}) };
    const base = { source: 'watch', fingerprint: `rule:${r.name}`, name: r.name, severity: r.severity, labels, annotations: { summary: String(r.detail ?? '').slice(0, 1000) }, summary: String(r.detail ?? '').slice(0, 1000), ...(r.service ? { service: r.service } : {}) };
    // Only what changed is sent: a rule still firing is already in its incident.
    if (r.state === 'firing') { firing.add(r.name); if (!previouslyFiring.includes(r.name)) alerts.push({ ...base, status: 'firing', startsAt: now }); }
    else if ((r.state === 'pending' || r.state === 'error') && previouslyFiring.includes(r.name)) firing.add(r.name);
    else if (r.state === 'ok' && previouslyFiring.includes(r.name)) alerts.push({ ...base, status: 'resolved', endsAt: now });
  }
  return { alerts, firing: [...firing] };
}

export function register(api, shared) {
  const seconds = watchSeconds();
  const stateFile = path.join(api.dataDir, 'watch.json');
  const root = process.env.HARNESS_OPS_WATCH_PATH?.trim() || process.env.HARNESS_OPS_ALERTS_PATH?.trim();
  let running;

  /** One round: evaluate, feed the grouper, let windows pass. Returns what it did (for the tests and the status). */
  async function round() {
    if (running) return running;
    running = (async () => {
      if (!(await api.lease('ops-watch'))) return { skipped: 'not here: another server holds the ops-watch lease, or background work is off (HARNESS_PLUGIN_LOOPS=off, evals, the CLI)' };
      const inv = await shared.serverInventory();
      if (!inv?.present || (!inv.alerts.length && !inv.services.some((x) => x.health || x.tls))) { await shared.alerts.tick(); return { skipped: 'nothing to watch (no inventory alert rules or health checks)' }; }
      const host = { kind: 'local', root: path.resolve(root || api.dataDir), displayRoot: path.resolve(root || api.dataDir) };
      const ctx = { host, signal: AbortSignal.timeout(Math.max(30_000, seconds * 1000)), opsGate: true, opsDeclared: [], readFiles: new Map(), todos: [], setTodos() {}, emit() {} };
      const t0 = Date.now();
      const results = await shared.evaluate(inv, ctx);
      const prev = await readJson(stateFile, { firing: [] });
      const { alerts, firing } = roundAlerts(results, prev.firing ?? []);
      const status = {
        at: new Date().toISOString(), ms: Date.now() - t0, rules: results.length, firing: firing.length,
        notEvaluated: results.filter((r) => r.state === 'error').map((r) => `${r.name}: ${String(r.detail).slice(0, 160)}`).slice(0, 20),
        sent: alerts.length,
      };
      await writeFileAtomic(stateFile, JSON.stringify({ firing, status }));
      if (alerts.length) await shared.alerts.ingest(alerts);
      await shared.alerts.tick();
      return status;
    })().catch((e) => { api.log(`ops-watch: ${e.message}`); return { error: e.message }; }).finally(() => { running = undefined; });
    return running;
  }

  shared.watchRound = round;
  instances.set(api.dataDir, shared);
  shared.watchStatus = async () => {
    const st = await readJson(stateFile, {});
    if (!seconds) return 'Watch loop: off (HARNESS_OPS_WATCH_SECONDS=0).';
    if (!st.status) return `Watch loop: every ${seconds}s, no round yet.`;
    const x = st.status;
    return `Watch loop: every ${seconds}s; last round ${x.at}: ${x.rules} rule(s), ${x.firing} firing${x.notEvaluated?.length ? `, ${x.notEvaluated.length} not evaluated (${x.notEvaluated.slice(0, 3).join('; ')})` : ''}.`;
  };
  if (!seconds) { api.log('ops-watch loop: off (HARNESS_OPS_WATCH_SECONDS=0)'); return; }
  const first = setTimeout(() => { void round(); }, Math.min(seconds * 1000, 5000));
  const every = setInterval(() => { void round(); }, seconds * 1000);
  first.unref?.(); every.unref?.();
  timers.add(first); timers.add(every);
  api.log(`ops-watch loop: every ${seconds}s, model-free (an agent starts only for a new or escalated incident)`);
}
