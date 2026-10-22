// The Operations console's server side: read-only routes the desktop's AIOps pages call
// (routes.call, auth "user": signed in like the rest of the API), assembled from what the plugin
// already keeps - the alert incidents (alerts.json), the incident records the incident tool
// writes in workspaces, the evidence ledger, the inventory, the change journal - and from the
// sessions' events (which session works on which incident, and the incident-response run's
// root cause, confidence, refuter verdict and runbook). Nothing here changes a system or runs a
// model; "console/ops-check" evaluates the alert rules now, as the watch loop does.
//
//   console/summary      open incidents, firing alerts, SLO burn, the watch loop's state
//   console/incidents    alert incidents and workspace incidents, newest first
//   console/incident     one incident: timeline, alerts, changes, evidence, root cause and
//                        confidence, the refuter's verdict, the runbook, the postmortem
//   console/alerts       firing (and recently resolved) alerts, grouped by service
//   console/services     the inventory's services with their health and SLO status
//   console/topology     the dependency graph with each node's health
//   console/changes      the change timeline
//   console/ops-check    (POST) the alert rules evaluated now
//
// Who sees what: an administrator everything; anyone signed in the alert incidents (operational
// data, as the alerts tool shows them) and the workspace incidents of their own sessions.

import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeFileAtomic } from '../../../src/util/shared-file.ts';
import { INCIDENT_DIR } from './incidents.mjs';
import { citations, readEvidence } from './memory.mjs';
import { fromInventory, newGraph } from './topology.mjs';
import { promClient } from './prom.mjs';
import { budgetLeft, burnAlerts, burnRate } from './stats.mjs';
import { alertConfig, SEV_RANK } from './alerts.mjs';

const ID = /^(inc|alr)-[a-z0-9-]{3,90}$/;
const SID = /^[a-f0-9]{16}$/;
const INVESTIGATIONS = ['incident-response', 'incident-response-k8s'];
const clip = (s, n) => { const t = typeof s === 'string' ? s : s === undefined || s === null ? '' : String(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const ok = (body) => ({ status: 200, body });
const no = (status, error) => ({ status, body: { error } });
const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const SEV_OF_ALERT = { critical: 'sev2', warning: 'sev3', info: 'sev4' };

/** The JSON outputs block an agent ends its report with (the workflow asks for one), or {}. */
export function outputsOf(report) {
  const text = String(report ?? '');
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const brace = text.lastIndexOf('{');
  if (brace >= 0) blocks.push(text.slice(brace));
  for (const b of blocks.reverse()) { try { const v = JSON.parse(b.trim()); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch { /* next */ } }
  return {};
}

/** What an incident-response run says, from its steps' reports: the root cause, the confidence, the refuter. */
export function investigationOf(run) {
  const hist = run.history ?? [];
  const lastOf = (node) => [...hist].reverse().find((h) => h.node === node && h.status !== 'running');
  const rca = lastOf('rca');
  const refute = lastOf('refute');
  const runbook = lastOf('runbook');
  const triage = lastOf('triage');
  const o = rca ? outputsOf(rca.summary) : {};
  const t = triage ? outputsOf(triage.summary) : {};
  const confidence = typeof o.confidence === 'string' ? o.confidence : /confidence[:\s]+\**(high|medium|low)\b[^\n]*/i.exec(rca?.summary ?? '')?.[0];
  return {
    id: run.id, workflow: run.workflow, status: run.status, current: run.current, cost: Number(run.cost) || 0, ...(run.error ? { error: clip(run.error, 400) } : {}),
    steps: hist.map((h) => ({ node: h.node, title: (run.nodes ?? []).find((n) => n.id === h.node)?.title ?? h.node, type: h.type, status: h.status, ...(h.outcome ? { outcome: h.outcome } : {}), startedAt: h.startedAt, ...(h.endedAt ? { endedAt: h.endedAt } : {}) })),
    ...(typeof t.incident === 'string' ? { incident: t.incident } : {}),
    ...(rca ? { rca: { rootCause: clip(typeof o.root_cause === 'string' ? o.root_cause : '', 1000), confidence: clip(confidence ?? '', 400), evidenceIds: Array.isArray(o.evidence_ids) ? o.evidence_ids.map(String).filter((x) => /^ev-[0-9a-f]{6}$/.test(x)) : citations(rca.summary), remediationNeeded: o.remediation_needed === true } } : {}),
    ...(refute ? { refuter: { verdict: refute.outcome ?? '', report: clip(refute.summary ?? '', 2500) } } : {}),
    ...(runbook ? { runbookReport: clip(runbook.summary ?? '', 4000) } : {}),
  };
}

const may = (user, owner) => !!user && (user.role === 'admin' || (!!user.id && owner === user.id));

export function register(api, shared) {
  const file = path.join(api.dataDir, 'console.json');
  const cfg = alertConfig();
  const opsRoot = cfg.path ? path.resolve(cfg.path) : undefined;
  let index = { incidents: {}, sessions: {} };
  let loaded = readJson(file, index).then((v) => { if (v && typeof v === 'object' && v.incidents) index = { incidents: v.incidents ?? {}, sessions: v.sessions ?? {} }; });
  let timer;
  const save = () => { timer ??= setTimeout(async () => { timer = undefined; await fs.mkdir(api.dataDir, { recursive: true }); await writeFileAtomic(file, JSON.stringify(index)).catch((e) => api.log(`console: ${e.message}`)); }, 300); timer.unref?.(); };
  const prune = () => {
    for (const [k, list] of [['incidents', Object.entries(index.incidents)], ['sessions', Object.entries(index.sessions)]]) {
      if (list.length <= 500) continue;
      for (const [id] of list.sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0)).slice(500)) delete index[k][id];
    }
  };

  /** The incident tool calls this when it saves a record: where it lives (the workspace root). */
  shared.recordIncident = async (root, inc) => {
    await loaded;
    const e = index.incidents[inc.id] ?? {};
    index.incidents[inc.id] = { ...e, root, title: clip(inc.title, 200), severity: inc.severity, status: inc.status, services: inc.services ?? [], openedAt: inc.openedAt, updatedAt: Date.now() };
    prune(); save();
  };

  // Which session works on which incident, and what its incident-response run says.
  const calls = new Map();
  api.events.subscribe(async (e) => {
    const ev = e.event;
    if (ev?.kind === 'tool_call' && ev.name === 'incident') { calls.set(`${e.sessionId}:${ev.id}`, ev.input ?? {}); if (calls.size > 500) calls.delete(calls.keys().next().value); return; }
    if (ev?.kind === 'tool_result' && ev.name === 'incident') {
      const input = calls.get(`${e.sessionId}:${ev.id}`) ?? {};
      calls.delete(`${e.sessionId}:${ev.id}`);
      if (ev.is_error) return;
      const id = /^Opened (inc-[a-z0-9-]+)/.exec(String(ev.content ?? ''))?.[1] ?? (typeof input.id === 'string' && /^inc-/.test(input.id) ? input.id : undefined);
      if (!id) return;
      await loaded;
      index.incidents[id] = { ...(index.incidents[id] ?? {}), sessionId: e.sessionId, ...(e.owner !== undefined ? { owner: e.owner } : {}), updatedAt: Date.now() };
      index.sessions[e.sessionId] = { ...(index.sessions[e.sessionId] ?? {}), incident: id, ...(e.owner !== undefined ? { owner: e.owner } : {}), updatedAt: Date.now() };
      prune(); save();
      return;
    }
    if (ev?.kind === 'workflow' && ev.run && INVESTIGATIONS.includes(ev.run.workflow) && (ev.phase === 'node_finished' || ev.phase === 'finished' || ev.phase === 'started' || ev.phase === 'node_started')) {
      await loaded;
      const inv = investigationOf(ev.run);
      const s = index.sessions[e.sessionId] = { ...(index.sessions[e.sessionId] ?? {}), run: inv, title: clip(e.title, 200), ...(e.owner !== undefined ? { owner: e.owner } : {}), updatedAt: Date.now() };
      if (inv.incident && !s.incident) s.incident = inv.incident;
      if (s.incident) index.incidents[s.incident] = { ...(index.incidents[s.incident] ?? {}), sessionId: e.sessionId, ...(e.owner !== undefined ? { owner: e.owner } : {}), updatedAt: Date.now() };
      prune(); save();
    }
  });

  const host = (root) => ({ kind: 'local', root, displayRoot: root });
  const readText = async (root, rel) => { try { return await fs.readFile(await api.workspacePath(host(root), rel), 'utf8'); } catch { return undefined; } };

  /** Workspace incidents: the ones the index knows (any workspace), and the ops workspace's own. */
  async function workspaceIncidents() {
    await loaded;
    const roots = new Map();
    for (const [id, e] of Object.entries(index.incidents)) if (e.root) roots.set(id, e.root);
    if (opsRoot) {
      const dir = path.join(opsRoot, INCIDENT_DIR);
      for (const n of await fs.readdir(dir).catch(() => [])) if (/^inc-[a-z0-9-]+$/.test(n) && !roots.has(n)) roots.set(n, opsRoot);
    }
    const out = [];
    await Promise.all([...roots.entries()].map(async ([id, root]) => {
      const text = await readText(root, `${INCIDENT_DIR}/${id}/incident.json`);
      if (!text) return;
      try { const inc = JSON.parse(text); if (inc?.id === id) out.push({ inc, root, meta: index.incidents[id] ?? {} }); } catch { /* not a record */ }
    }));
    return out;
  }
  const groups = async () => (await shared.alerts?.incidents().catch(() => [])) ?? [];

  const listItem = (x) => x;
  function fromGroup(g, linked) {
    const firing = Object.values(g.alerts ?? {}).filter((a) => a.status === 'firing');
    return listItem({
      id: g.id, source: 'alerts', title: g.title, severity: linked?.inc.severity ?? g.severity ?? SEV_OF_ALERT[g.alertSeverity] ?? 'sev3', alertSeverity: g.alertSeverity,
      status: linked?.inc.status ?? g.status ?? (g.state === 'resolved' ? 'resolved' : 'investigating'), state: g.state, open: g.state !== 'resolved',
      service: g.service, services: g.services ?? (g.service ? [g.service] : []), env: g.env, openedAt: g.openedAt, updatedAt: g.updatedAt, resolvedAt: g.resolvedAt,
      alertsFiring: firing.length, alertsTotal: Object.keys(g.alerts ?? {}).length, sessionId: g.sessionId, investigation: g.investigation, ...(linked ? { linked: linked.inc.id } : {}),
    });
  }
  function fromWorkspace(w) {
    const i = w.inc;
    return listItem({
      id: i.id, source: 'workspace', title: i.title, severity: i.severity, status: i.status, open: i.status !== 'resolved', services: i.services ?? [], service: i.services?.[0],
      openedAt: i.openedAt, updatedAt: i.updatedAt, resolvedAt: i.resolvedAt, sessionId: w.meta.sessionId, rootCause: i.rootCause ? clip(i.rootCause, 300) : undefined,
    });
  }

  /** Every incident the caller may see, an alert incident and the workspace record of its investigation as one. */
  async function incidents(user) {
    const [gs, ws] = await Promise.all([groups(), workspaceIncidents()]);
    const bySession = new Map(ws.filter((w) => w.meta.sessionId).map((w) => [w.meta.sessionId, w]));
    const used = new Set();
    const out = [];
    for (const g of gs) {
      const linked = g.sessionId ? bySession.get(g.sessionId) : undefined;
      if (linked && may(user, linked.meta.owner)) used.add(linked.inc.id);
      out.push(fromGroup(g, linked && may(user, linked.meta.owner) ? linked : undefined));
    }
    for (const w of ws) if (!used.has(w.inc.id) && may(user, w.meta.owner)) out.push(fromWorkspace(w));
    return out.sort((a, b) => Number(b.open) - Number(a.open) || String(b.openedAt).localeCompare(String(a.openedAt)));
  }

  async function detail(user, id) {
    const [gs, ws] = await Promise.all([groups(), workspaceIncidents()]);
    let g = id.startsWith('alr-') ? gs.find((x) => x.id === id) : undefined;
    let w = id.startsWith('inc-') ? ws.find((x) => x.inc.id === id) : undefined;
    if (w && !may(user, w.meta.owner)) w = undefined;
    if (!g && !w) return undefined;
    if (g && !w && g.sessionId) { const x = ws.find((y) => y.meta.sessionId === g.sessionId); if (x && may(user, x.meta.owner)) w = x; }
    if (w && !g && w.meta.sessionId) g = gs.find((x) => x.sessionId === w.meta.sessionId);
    const sessionId = g?.sessionId ?? w?.meta.sessionId;
    const sess = sessionId ? index.sessions[sessionId] : undefined;
    const investigation = sess?.run && (may(user, sess.owner) || !!g) ? sess.run : undefined;
    const inc = w?.inc;
    const root = w?.root;
    const timeline = [
      ...(g?.timeline ?? []).map((x) => ({ ...x, from: 'alerts' })),
      ...(inc?.timeline ?? []).map((x) => ({ ...x, from: 'record' })),
    ].sort((a, b) => String(a.at).localeCompare(String(b.at))).map((x) => ({ at: x.at, kind: x.kind, from: x.from, text: clip(x.text, 3000) }));
    const notes = timeline.map((x) => x.text);
    const rcNote = [...notes].reverse().find((t) => /^root cause:/i.test(t));
    const rootCause = inc?.rootCause || (rcNote ? rcNote.replace(/^root cause:\s*/i, '') : '') || investigation?.rca?.rootCause || '';
    const confidence = investigation?.rca?.confidence || [...notes].reverse().map((t) => /confidence[:\s]+\**(high|medium|low)\b[^\n]*/i.exec(t)?.[0]).find(Boolean) || '';
    const refuterNote = [...(inc?.timeline ?? [])].reverse().find((x) => /^refuter:/i.test(x.text));
    const refuter = investigation?.refuter
      ? { verdict: investigation.refuter.verdict, text: investigation.refuter.report }
      : refuterNote ? { verdict: /\bREJECTED\b/.test(refuterNote.text) ? 'REJECTED' : /\bSURVIVES\b/.test(refuterNote.text) ? 'SURVIVES' : '', text: refuterNote.text } : undefined;
    const evidenceIds = [...new Set([...citations(rootCause), ...(investigation?.rca?.evidenceIds ?? []), ...notes.flatMap((t) => citations(t))])].slice(0, 60);
    let evidence = [];
    if (root && evidenceIds.length) {
      const ledger = await readEvidence(api, host(root)).catch(() => []);
      evidence = evidenceIds.map((eid) => ledger.find((e) => e.id === eid) ?? { id: eid, missing: true }).map((e) => ({ id: e.id, ...(e.missing ? { missing: true } : { at: e.at, tool: e.tool, kind: e.kind, input: clip(e.input, 400), excerpt: clip(e.excerpt, 600), ...(e.links?.length ? { links: e.links.slice(0, 4) } : {}), ...(e.error ? { error: true } : {}) }) }));
    }
    const incId = inc?.id;
    const runbook = root && incId ? await readText(root, `.harness/ops/runbooks/remediate-${incId}.md`) : undefined;
    const postmortem = root && incId ? await readText(root, `${INCIDENT_DIR}/${incId}/postmortem.md`) : undefined;
    const alerts = Object.values(g?.alerts ?? {}).sort((a, b) => (a.status === b.status ? SEV_RANK[b.severity] - SEV_RANK[a.severity] : a.status === 'firing' ? -1 : 1)).map((a) => ({ name: a.name, status: a.status, severity: a.severity, summary: clip(a.summary, 400), value: a.value, source: a.source, count: a.count, firstSeen: a.firstSeen, lastSeen: a.lastSeen, flapping: !!a.flapping, url: a.url, labels: a.labels }));
    return {
      id: g?.id ?? inc.id, ids: [g?.id, inc?.id].filter(Boolean), title: inc?.title ?? g.title,
      severity: inc?.severity ?? g?.severity, alertSeverity: g?.alertSeverity, status: inc?.status ?? g?.status, state: g?.state,
      open: inc ? inc.status !== 'resolved' : g.state !== 'resolved', services: [...new Set([...(inc?.services ?? []), ...(g?.services ?? [])])], env: g?.env,
      openedAt: [inc?.openedAt, g?.openedAt].filter(Boolean).sort()[0], resolvedAt: inc?.resolvedAt ?? g?.resolvedAt, summary: inc?.summary || g?.summary || '',
      timeline, alerts, changes: (g?.changes ?? []).slice(0, 30), rootCause, confidence, refuter, evidenceIds, evidence,
      resolution: inc?.resolution ?? '', runbook: runbook ? clip(runbook, 30_000) : undefined, runbookReport: investigation?.runbookReport, postmortem: postmortem ? clip(postmortem, 40_000) : undefined,
      sessionId, investigation, investigationState: g?.investigation, deferred: g?.deferred,
    };
  }

  // ---- health, SLOs (cached: the console polls) ----
  const gateCtx = (signal) => ({ host: host(opsRoot ?? api.dataDir), signal, opsGate: true, opsDeclared: [], readFiles: new Map(), todos: [], setTodos() {}, emit() {} });
  let healthCache; let sloCache;
  async function health(force = false) {
    if (!force && healthCache && Date.now() - healthCache.at < 20_000) return healthCache;
    const inv = await shared.serverInventory().catch(() => undefined);
    if (!inv?.present) { healthCache = { at: Date.now(), inv, results: [] }; return healthCache; }
    const results = await shared.evaluate(inv, gateCtx(AbortSignal.timeout(30_000))).catch((e) => [{ name: 'evaluate', state: 'error', severity: 'warning', detail: e.message }]);
    healthCache = { at: Date.now(), inv, results };
    return healthCache;
  }
  async function slos(inv) {
    if (sloCache && Date.now() - sloCache.at < 30_000) return sloCache.list;
    const list = [];
    const all = (inv?.services ?? []).flatMap((s) => (s.slos ?? []).map((o) => ({ ...o, service: s.name })));
    if (!all.length) { sloCache = { at: Date.now(), list }; return list; }
    if (!inv.monitoring?.prometheus) { sloCache = { at: Date.now(), list: all.map((o) => ({ service: o.service, name: o.name, objective: o.objective, window: o.window, error: 'no Prometheus in the inventory' })) }; return sloCache.list; }
    if (inv.monitoring.prometheus_credential) { sloCache = { at: Date.now(), list: all.map((o) => ({ service: o.service, name: o.name, objective: o.objective, window: o.window, error: 'Prometheus needs a credential: the slo_status tool reads it (asked)' })) }; return sloCache.list; }
    const p = promClient({ url: inv.monitoring.prometheus, timeoutMs: 8_000 });
    const signal = AbortSignal.timeout(20_000);
    await Promise.all(all.map(async (o) => {
      const ratios = {};
      try {
        await Promise.all([...new Set(['5m', '30m', '1h', '6h', o.window])].map(async (wnd) => {
          const d = await p.instant(`(${o.errors.replaceAll('{{window}}', wnd)}) / (${o.total.replaceAll('{{window}}', wnd)})`, Date.now() / 1000, signal);
          const v = Number(d.result?.[0]?.value?.[1]);
          ratios[wnd] = Number.isFinite(v) ? v : 0;
        }));
        const left = budgetLeft(ratios[o.window], o.objective);
        const alerts = burnAlerts(ratios, o.objective).filter((a) => a.firing);
        list.push({ service: o.service, name: o.name, objective: o.objective, window: o.window, errorRatio: ratios[o.window], budgetLeft: Number.isFinite(left) ? left : null, burn1h: burnRate(ratios['1h'], o.objective), burn6h: burnRate(ratios['6h'], o.objective), burn5m: burnRate(ratios['5m'], o.objective), alerts: alerts.map((a) => `${a.severity} ${a.factor}x over ${a.long}/${a.short}`) });
      } catch (e) { list.push({ service: o.service, name: o.name, objective: o.objective, window: o.window, error: clip(e.message, 200) }); }
    }));
    list.sort((a, b) => a.service.localeCompare(b.service) || a.name.localeCompare(b.name));
    sloCache = { at: Date.now(), list };
    return list;
  }
  const serviceState = (results, name, openIncidents) => {
    const mine = results.filter((r) => r.service === name);
    const firing = mine.filter((r) => r.state === 'firing' && !(r.maint?.length));
    if (firing.some((r) => r.severity === 'critical')) return 'critical';
    if (firing.length || openIncidents > 0) return 'degraded';
    if (mine.some((r) => r.state === 'error')) return 'unknown';
    return mine.length ? 'healthy' : 'unknown';
  };

  // ---- routes ----
  const argsOf = (req) => {
    if (req.method === 'GET') return req.query ?? {};
    try { const b = JSON.parse(req.body.toString('utf8') || '{}'); return b && typeof b === 'object' && !Array.isArray(b) ? b : {}; } catch { return {}; }
  };
  const read = (p, handler) => { for (const method of ['GET', 'POST']) api.registerRoute({ method, path: `console/${p}`, auth: 'user', handler: (req) => handler(req, argsOf(req)) }); };

  read('summary', async (req) => {
    const list = await incidents(req.user);
    const gs = await groups();
    const firing = gs.flatMap((g) => Object.values(g.alerts ?? {}).filter((a) => a.status === 'firing').map((a) => ({ ...a, incident: g.id, service: g.service })));
    const h = await health();
    const slo = await slos(h.inv).catch(() => []);
    return ok({
      open: list.filter((x) => x.open).length, firing: firing.length,
      bySeverity: { critical: firing.filter((a) => a.severity === 'critical').length, warning: firing.filter((a) => a.severity === 'warning').length, info: firing.filter((a) => a.severity === 'info').length },
      top: list.filter((x) => x.open).slice(0, 5), slo, watch: shared.watchStatus ? await shared.watchStatus() : 'Watch loop: not running here.', at: Date.now(),
      inventory: !!h.inv?.present,
    });
  });
  // The sidebar badge and the status bar's counts, read by the app while no Operations page is open (ui.badges).
  read('badges', async (req) => {
    const list = await incidents(req.user);
    const gs = await groups();
    const firing = gs.reduce((n, g) => n + Object.values(g.alerts ?? {}).filter((a) => a.status === 'firing').length, 0);
    return ok({ open: list.filter((x) => x.open).length || null, firing: firing || null });
  });
  read('incidents', async (req, a) => {
    const list = await incidents(req.user);
    const want = a.status === 'all' ? 'all' : a.status === 'resolved' ? 'resolved' : 'open';
    return ok({ incidents: want === 'all' ? list : list.filter((x) => (want === 'open' ? x.open : !x.open)), counts: { open: list.filter((x) => x.open).length, resolved: list.filter((x) => !x.open).length } });
  });
  read('incident', async (req, a) => {
    const id = String(a.id ?? '');
    if (!ID.test(id)) return no(400, 'id is an incident id (alr-... or inc-...)');
    const d = await detail(req.user, id);
    return d ? ok(d) : no(404, 'no such incident');
  });
  read('session', async (req, a) => {
    // The incident a conversation works on (the panel next to an investigation).
    const sid = String(a.session ?? '');
    if (!SID.test(sid)) return no(400, 'session is a conversation id');
    await loaded;
    const gs = await groups();
    const s = index.sessions[sid];
    const g = gs.find((x) => x.sessionId === sid);
    const id = g?.id ?? s?.incident;
    if (!id) return ok({ session: sid, incident: null });
    if (!g && !may(req.user, s?.owner)) return no(404, 'no such conversation');
    return ok({ session: sid, incident: await detail(req.user, id) ?? null });
  });
  read('alerts', async (req, a) => {
    const gs = await groups();
    const minRank = SEV_RANK[a.severity] ?? 0;
    const rows = [];
    for (const g of gs) for (const al of Object.values(g.alerts ?? {})) {
      if (SEV_RANK[al.severity] < minRank) continue;
      if (al.status !== 'firing' && Date.now() - (al.lastSeen ?? 0) > 24 * 3_600_000) continue;
      rows.push({ name: al.name, status: al.status, severity: al.severity, summary: clip(al.summary, 400), value: al.value, source: al.source, count: al.count, firstSeen: al.firstSeen, lastSeen: al.lastSeen, startsAt: al.startsAt, flapping: !!al.flapping, url: al.url, incident: g.id, incidentState: g.state, service: g.service ?? null, env: g.env ?? null });
    }
    const byKey = new Map();
    for (const r of rows) { const k = r.service ?? r.name; const x = byKey.get(k) ?? { key: k, service: r.service, env: r.env, alerts: [] }; x.alerts.push(r); byKey.set(k, x); }
    const out = [...byKey.values()].map((x) => ({ ...x, firing: x.alerts.filter((r) => r.status === 'firing').length, top: x.alerts.reduce((m, r) => (r.status === 'firing' && SEV_RANK[r.severity] > SEV_RANK[m] ? r.severity : m), 'info'), alerts: x.alerts.sort((p, q) => (p.status === q.status ? SEV_RANK[q.severity] - SEV_RANK[p.severity] : p.status === 'firing' ? -1 : 1)) }))
      .sort((p, q) => q.firing - p.firing || SEV_RANK[q.top] - SEV_RANK[p.top] || String(p.key).localeCompare(String(q.key)));
    return ok({ groups: out, firing: rows.filter((r) => r.status === 'firing').length, watch: shared.watchStatus ? await shared.watchStatus() : '' });
  });
  read('services', async (req) => {
    const h = await health();
    const inv = h.inv;
    if (!inv?.present) return ok({ services: [], inventory: false, note: 'No inventory on the server: set HARNESS_OPS_INVENTORY (the operator\'s) or HARNESS_OPS_ALERTS_PATH (a workspace with .harness/ops/inventory.yaml).' });
    const list = await incidents(req.user);
    const slo = await slos(inv).catch(() => []);
    return ok({
      inventory: true, checkedAt: h.at,
      services: inv.services.map((s) => {
        const open = list.filter((x) => x.open && (x.services ?? []).includes(s.name)).length;
        const rules = h.results.filter((r) => r.service === s.name).map((r) => ({ name: r.name, state: r.state, severity: r.severity, detail: clip(r.detail, 300), implicit: !!r.implicit, maintenance: r.maint ?? [] }));
        return { name: s.name, env: s.env ?? null, host: s.host ?? null, owner: s.owner ?? null, health: s.health ?? null, container: s.container ?? null, k8s: s.k8s ? `${s.k8s.cluster}/${s.k8s.namespace}` : null, dependsOn: s.depends_on ?? [], state: serviceState(h.results, s.name, open), openIncidents: open, rules, slos: slo.filter((o) => o.service === s.name) };
      }),
    });
  });
  read('topology', async (req) => {
    const h = await health();
    const inv = h.inv;
    if (!inv?.present) return ok({ nodes: [], edges: [], inventory: false });
    const g = newGraph();
    fromInventory(g, inv);
    const list = await incidents(req.user);
    const svcNames = new Set(inv.services.map((s) => s.name));
    const nodes = [...g.nodes.values()].map((n) => ({ id: n.name, kinds: [...(n.kinds ?? [])], service: svcNames.has(n.name), state: svcNames.has(n.name) ? serviceState(h.results, n.name, list.filter((x) => x.open && (x.services ?? []).includes(n.name)).length) : 'unknown' }));
    const edges = [...g.edges.values()].map((e) => ({ from: e.from, to: e.to, kind: [...(e.kinds ?? [])][0] ?? 'calls' }));
    return ok({ nodes, edges, inventory: true, checkedAt: h.at });
  });
  read('changes', async (req, a) => {
    const hours = Math.min(24 * 30, Math.max(1, Number(a.hours) || 48));
    const list = await api.changes.query({ since: Date.now() - hours * 3_600_000, limit: 500 }).catch(() => []);
    return ok({ hours, changes: list.sort((p, q) => q.at - p.at).map((c) => ({ id: c.id, at: c.at, kind: c.kind, target: clip(c.target, 200), service: c.service ?? null, env: c.env ?? null, summary: clip(c.summary, 500), by: c.by, ref: c.ref ?? null, source: c.source ?? null })) });
  });
  api.registerRoute({
    method: 'POST', path: 'console/ops-check', auth: 'user',
    async handler() {
      const h = await health(true);
      if (!h.inv?.present) return ok({ text: 'No inventory on the server to check.', firing: 0, results: [] });
      const r = h.results;
      const firing = r.filter((x) => x.state === 'firing' && !(x.maint?.length));
      const errors = r.filter((x) => x.state === 'error');
      return ok({
        text: `Ops check: ${r.length} rule(s), ${firing.length} firing${firing.length ? ` (${firing.slice(0, 4).map((x) => x.name).join(', ')}${firing.length > 4 ? '…' : ''})` : ''}, ${errors.length} could not be evaluated, ${r.filter((x) => x.state === 'ok').length} ok.`,
        firing: firing.length, at: iso(h.at), results: r.map((x) => ({ name: x.name, state: x.state, severity: x.severity, service: x.service ?? null, detail: clip(x.detail, 300) })),
      });
    },
  });
}
