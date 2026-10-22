// Incident memory and the evidence ledger.
//
// Evidence: every aiops read the agents make is given an id the harness keeps
// (.harness/ops/evidence.jsonl in the workspace): the tool, its exact input
// (the query, the command), when, whether it failed, and links (a Prometheus
// graph, a Grafana dashboard or Explore view, a trace). The tools of this file
// set (grafana, traces, topology, anomalies, similar_incidents) record their
// result's first lines too; the older tools are recorded by a PostToolUse hook
// (their input, and the id in a note after the result). A root cause cites them
// as [ev-xxxxxx]; `evidence check` and the rca-evidence gate refuse a citation
// the harness never recorded, or one that failed, and give a confidence
// ceiling from how many kinds of evidence agree.
//
// Incident memory (`similar_incidents`): resolved incidents in the workspace
// (incident.json, postmortem.md) and imported postmortems
// (.harness/ops/incident-memory/*.md|json), ranked by BM25 over their text with
// boosts for shared services and alert names. No model, no external service.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { INCIDENT_DIR } from './incidents.mjs';
import { redact } from './secrets.mjs';

export const EVIDENCE_FILE = '.harness/ops/evidence.jsonl';
export const MEMORY_DIR = '.harness/ops/incident-memory';
const ID = /\bev-[0-9a-f]{6}\b/g;

const str = (v) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const errOut = (content) => ({ content, is_error: true });

// ---------------- the shared tool helper (used by grafana, traces, topology, anomalies) ----------------

/**
 * Registers an aiops tool: declares the vault names a call uses (decided by the
 * vault rules before it runs; the run sees only those), and records each
 * successful result as evidence, appending its id (and links) to the output.
 * def.evidence(input, content) may return { links: [...], summary } for the record.
 */
export function opsTool(api, shared, def) {
  const { vaultNames: of, evidence, ...rest } = def;
  api.registerTool({
    ...rest,
    ...(of ? { vaultNames: of } : {}),
    async run(input, ctx) {
      const out = await def.run(input, { ...ctx, opsDeclared: of ? of(input) : [] });
      const o = typeof out === 'string' ? { content: out } : out;
      if (o.is_error || o.noEvidence || ctx.host?.kind === 'companion') { const { noEvidence: _n, ...r } = o; return r; }
      let extra = {};
      try { extra = evidence ? (evidence(input, o.content) ?? {}) : {}; } catch { extra = {}; }
      const id = await recordEvidence(api, ctx.host, { tool: def.name, input, excerpt: o.content, links: extra.links ?? o.links ?? [] }).catch(() => undefined);
      const { links: _l, ...r } = o;
      return id ? { ...r, content: `${o.content}\nEvidence id: ${id} (cite it as [${id}])${(extra.links ?? o.links ?? []).length ? `\nLinks: ${(extra.links ?? o.links).join(' ')}` : ''}` } : r;
    },
  });
}

// ---------------- the evidence ledger ----------------

export const newEvidenceId = () => `ev-${randomBytes(3).toString('hex')}`;

/** What kind of evidence a tool gives (a claim backed by two kinds is stronger than one backed by one twice). */
export function evidenceKind(tool, input = {}) {
  if (['prometheus_query', 'slo_status', 'capacity_forecast'].includes(tool)) return 'metrics';
  if (tool === 'anomalies') return input.logs || input.log_service ? 'logs' : 'metrics';
  if (['logs_search', 'k8s_logs'].includes(tool)) return 'logs';
  if (tool === 'traces') return 'traces';
  if (tool === 'topology') return 'topology';
  if (['change_timeline'].includes(tool)) return 'changes';
  if (['host_stats', 'ssh_exec', 'docker_status', 'service_control'].includes(tool)) return 'hosts';
  if (['k8s_health', 'k8s_events', 'k8s_describe', 'k8s'].includes(tool)) return 'kubernetes';
  if (['ops_check', 'alerts'].includes(tool)) return 'alerts';
  if (tool === 'probe') return 'probes';
  if (tool === 'grafana') return ['alerts'].includes(str(input.action)) ? 'alerts' : ['annotations'].includes(str(input.action)) ? 'changes' : 'metrics';
  if (tool === 'similar_incidents') return 'history';
  return 'other';
}

const clipInput = (input) => {
  const s = redact(JSON.stringify(input ?? {}));
  return s.length > 2000 ? `${s.slice(0, 2000)}...` : s;
};

/** Appends one record to the workspace's ledger; returns its id (undefined on a companion host). */
export async function recordEvidence(api, host, { tool, input, excerpt, links = [], error = false, at = Date.now() }) {
  if (!host || host.kind === 'companion') return undefined;
  const file = await api.workspacePath(host, EVIDENCE_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const id = newEvidenceId();
  const rec = { id, at: new Date(at).toISOString(), tool, kind: evidenceKind(tool, input), input: clipInput(input), ...(error ? { error: true } : {}), ...(excerpt ? { excerpt: redact(String(excerpt)).slice(0, 1500) } : {}), ...(links.length ? { links } : {}) };
  await fs.appendFile(file, `${JSON.stringify(rec)}\n`);
  return id;
}

export async function readEvidence(api, host) {
  const file = await api.workspacePath(host, EVIDENCE_FILE).catch(() => null);
  if (!file) return [];
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return undefined; } }).filter(Boolean);
}

export const citations = (text) => [...new Set(String(text ?? '').match(ID) ?? [])];

/**
 * Checks the citations in a text against the ledger: unknown ids (never
 * recorded: made up), failed calls, how many distinct kinds of evidence, and the
 * confidence they can support (low with one kind or any bad citation, medium
 * with two, high with three or more).
 */
export function checkCitations(text, ledger, { minCited = 2 } = {}) {
  const ids = citations(text);
  const byId = new Map(ledger.map((e) => [e.id, e]));
  const known = ids.filter((i) => byId.has(i));
  const unknown = ids.filter((i) => !byId.has(i));
  const errored = known.filter((i) => byId.get(i).error);
  const good = known.filter((i) => !byId.get(i).error);
  const kinds = [...new Set(good.map((i) => byId.get(i).kind).filter((k) => k !== 'other' && k !== 'history'))];
  const problems = [];
  if (ids.length < minCited) problems.push(`${ids.length} citation(s): a root cause needs at least ${minCited} evidence ids ([ev-xxxxxx]) from the tool results that support it`);
  if (unknown.length) problems.push(`unknown evidence id(s) ${unknown.join(', ')}: the harness never recorded them (cite only ids printed after tool results; evidence list shows them)`);
  if (errored.length) problems.push(`evidence id(s) ${errored.join(', ')} are failed calls, not evidence`);
  const ceiling = problems.length || kinds.length <= 1 ? 'low' : kinds.length === 2 ? 'medium' : 'high';
  return { ids, known, unknown, errored, kinds, ceiling, ok: !problems.length, problems, entries: good.map((i) => byId.get(i)) };
}

export function formatEvidence(e) {
  return `[${e.id}] ${e.at} ${e.tool} ${e.input}${e.error ? ' (FAILED)' : ''}${e.links?.length ? `\n    links: ${e.links.join(' ')}` : ''}${e.excerpt ? `\n    ${e.excerpt.split('\n').slice(0, 4).join('\n    ').slice(0, 400)}` : ''}`;
}

/** Links for a PromQL query: the Prometheus graph page, and Grafana Explore when the inventory names its Prometheus data source. */
export function promLinks(inv, expr, { from = 'now-1h', to = 'now' } = {}) {
  const links = [];
  const p = inv?.monitoring?.prometheus;
  if (p && expr) links.push(`${String(p).replace(/\/+$/, '')}/graph?g0.expr=${encodeURIComponent(expr)}&g0.tab=0&g0.range_input=1h`);
  const g = inv?.monitoring?.grafana;
  const gUrl = typeof g === 'string' ? g : g?.url;
  const ds = typeof g === 'object' ? g?.datasource : undefined;
  if (gUrl && ds && expr) links.push(exploreLink(gUrl, ds, expr, from, to));
  return links;
}

export function exploreLink(base, dsUid, expr, from = 'now-1h', to = 'now') {
  const panes = { a: { datasource: dsUid, queries: [{ refId: 'A', expr, datasource: { type: 'prometheus', uid: dsUid } }], range: { from: String(from), to: String(to) } } };
  return `${String(base).replace(/\/+$/, '')}/explore?schemaVersion=1&orgId=1&panes=${encodeURIComponent(JSON.stringify(panes))}`;
}

// ---------------- incident memory: BM25 over past incidents ----------------

const STOP = new Set('a an and are as at be been but by for from has have in into is it its of on or that the this to was were will with not no after before during when while than then there their them they which who what why how all any each per via about over under up down out off we our you your i me my he she his her us can could would should may might must do does did done just also only very more most less least so such same other another some few many much own'.split(' '));
/** Lower-cased word tokens without stop words or bare numbers, lightly stemmed. */
export function words(text) {
  return String(text ?? '').toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w)).map(stem);
}
function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** BM25 over documents ({ id, tokens }): scores for a query's tokens, with the terms that matched. */
export function bm25(docs, query, { k1 = 1.2, b = 0.75 } = {}) {
  const N = docs.length;
  if (!N) return [];
  const avg = docs.reduce((a, d) => a + d.tokens.length, 0) / N || 1;
  const df = new Map();
  for (const d of docs) for (const t of new Set(d.tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  const q = [...new Set(query)];
  return docs.map((d) => {
    const tf = new Map();
    for (const t of d.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0; const matched = [];
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.tokens.length) / avg)));
      matched.push(t);
    }
    return { id: d.id, score, matched };
  });
}

/** A searchable record of a past incident: its text, services, alert names, root cause and fix. */
export function incidentDoc(inc, postmortem = '') {
  const timeline = (inc.timeline ?? []).map((e) => e.text).join('\n');
  const alertNames = [...new Set(`${inc.title ?? ''}\n${inc.summary ?? ''}\n${timeline}\n${postmortem}`.match(/\b[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]+)+\b/g) ?? [])];
  const rootCause = str(inc.rootCause) || (/^Root cause:\s*(.+)$/im.exec(postmortem)?.[1] ?? /Root cause:\s*([^\n]+)/i.exec(timeline)?.[1] ?? '');
  const text = [inc.title, inc.title, inc.summary, rootCause, rootCause, inc.resolution, alertNames.join(' '), timeline, postmortem].filter(Boolean).join('\n');
  return { id: inc.id, title: str(inc.title), services: (inc.services ?? []).map(String), status: str(inc.status) || 'resolved', severity: str(inc.severity), openedAt: str(inc.openedAt), resolvedAt: str(inc.resolvedAt), rootCause: rootCause.trim(), resolution: str(inc.resolution).trim(), alerts: alertNames, tokens: words(text), source: inc.source ?? 'incident' };
}

/** A postmortem written elsewhere, as markdown: "# title", and "Services:", "Root cause:", "Resolution:" lines where it has them. */
export function markdownDoc(name, md) {
  const line = (k) => new RegExp(`^\\**${k}\\**:\\s*(.+)$`, 'im').exec(md)?.[1]?.trim() ?? '';
  return incidentDoc({ id: name, title: /^#\s+(.+)$/m.exec(md)?.[1]?.trim() ?? name, services: line('Services?').split(/[,\s]+/).filter(Boolean), status: 'resolved', rootCause: line('Root cause'), resolution: line('Resolution|Fix|Fixed by'), openedAt: line('Date|Opened'), source: 'memory' }, md);
}

/**
 * Ranks past incidents for a new one: BM25 over the text, plus a boost per shared
 * service and per alert name both mention. Only matches with some substance are
 * returned (at least two shared terms, or a shared alert name).
 */
export function rankSimilar(docs, { text = '', services = [], alerts = [], exclude = [] } = {}, { top = 5 } = {}) {
  const pool = docs.filter((d) => !exclude.includes(d.id));
  const q = words(`${text} ${alerts.join(' ')} ${alerts.join(' ')}`);
  const scores = bm25(pool, q);
  const lower = (xs) => xs.map((x) => String(x).toLowerCase());
  const out = pool.map((d, i) => {
    const s = scores[i];
    const svc = lower(d.services).filter((x) => lower(services).includes(x));
    const al = d.alerts.filter((a) => alerts.some((x) => x.toLowerCase() === a.toLowerCase()));
    const score = s.score + 2 * svc.length + 3 * al.length;
    return { ...d, score, matched: s.matched, sharedServices: svc, sharedAlerts: al };
  }).filter((d) => d.sharedAlerts.length > 0 || d.matched.length >= 2);
  return out.sort((a, b) => b.score - a.score).slice(0, top);
}

// ---------------- the tools ----------------

export function register(api, shared) {
  const { configured, invOrError, incidentIds, loadIncident, clip } = shared;

  // Every aiops read gets an evidence id, recorded by the harness (the tools here record their own).
  const HOOKED = ['prometheus_query', 'logs_search', 'probe', 'host_stats', 'docker_status', 'ssh_exec', 'service_control', 'ops_check', 'slo_status', 'capacity_forecast', 'alerts', 'change_timeline', 'k8s_health', 'k8s_events', 'k8s_logs', 'k8s_describe'];
  api.on('PostToolUse', async (payload, { host }) => {
    if (!host || host.kind === 'companion') return undefined;
    const tool = str(payload.tool);
    const input = payload.input ?? {};
    let links = [];
    if (tool === 'prometheus_query') {
      try { const { inv } = await invOrError({ host }); links = promLinks(inv, str(input.query), { from: str(input.start) || 'now-1h', to: str(input.end) || 'now' }); } catch { links = []; }
    }
    const id = await recordEvidence(api, host, { tool, input, links, error: !!payload.is_error });
    if (!id || payload.is_error) return undefined;
    return { feedback: `Evidence id: ${id} (the harness recorded this ${tool} call; cite it as [${id}])${links.length ? `\nLinks: ${links.join(' ')}` : ''}` };
  }, HOOKED.join('|'));

  async function docs(ctx, includeOpen) {
    const out = [];
    for (const id of await incidentIds(ctx)) {
      const inc = await loadIncident(ctx, id).catch(() => undefined);
      if (!inc || (!includeOpen && inc.status !== 'resolved')) continue;
      const pm = await fs.readFile(await api.workspacePath(ctx.host, `${INCIDENT_DIR}/${id}/postmortem.md`), 'utf8').catch(() => '');
      out.push(incidentDoc(inc, pm));
    }
    const dir = await api.workspacePath(ctx.host, MEMORY_DIR).catch(() => null);
    for (const n of dir ? (await fs.readdir(dir).catch(() => [])).sort() : []) {
      const text = await fs.readFile(path.join(dir, n), 'utf8').catch(() => '');
      if (n.endsWith('.md')) out.push(markdownDoc(n.replace(/\.md$/, ''), text));
      else if (n.endsWith('.json')) { try { const j = JSON.parse(text); for (const inc of Array.isArray(j) ? j : [j]) out.push(incidentDoc({ id: inc.id ?? n, ...inc, source: 'memory' }, inc.postmortem ?? '')); } catch { /* not an incident */ } }
    }
    return out;
  }

  opsTool(api, shared, {
    name: 'similar_incidents',
    description: `Past incidents like this one (incident memory): resolved incidents in this workspace (${INCIDENT_DIR}, with their postmortems) and imported postmortems (${MEMORY_DIR}/*.md or *.json), ranked by text similarity (BM25) to the symptom, with boosts for shared services and alert names. Each match shows its root cause and what fixed it - a lead to test, not a conclusion. Give the symptom text (the alert, error messages, log templates), services and alert names. No model, nothing leaves the server.`,
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'the symptom: alert text, error messages, log templates' },
        services: { type: 'array', items: { type: 'string' } },
        alerts: { type: 'array', items: { type: 'string' }, description: 'alert names, e.g. ShopOrdersLatencyHigh' },
        exclude: { type: 'string', description: 'an incident id to leave out (the current one)' },
        include_open: { type: 'boolean', description: 'also unresolved incidents (default false)' },
        top: { type: 'number' },
      },
      additionalProperties: false,
    },
    kind: 'read', parallelSafe: true,
    availableIn: configured,
    summarize: (i) => `similar incidents: ${str(i.text).slice(0, 80)}${Array.isArray(i.services) && i.services.length ? ` (${i.services.join(', ')})` : ''}`,
    async run(input, ctx) {
      if (ctx.host.kind === 'companion') return errOut('Incidents are kept in the workspace on the server; not available in a session on your computer.');
      const all = await docs(ctx, input.include_open === true);
      if (!all.length) return `No past incidents to compare with: none resolved in ${INCIDENT_DIR} and none in ${MEMORY_DIR}. (Resolved incidents with a root cause become the memory.)`;
      const services = Array.isArray(input.services) ? input.services.map(String) : [];
      const alerts = Array.isArray(input.alerts) ? input.alerts.map(String) : [];
      const top = Math.min(10, Math.max(1, Number(input.top) || 5));
      const hits = rankSimilar(all, { text: str(input.text), services, alerts, exclude: input.exclude ? [str(input.exclude)] : [] }, { top });
      if (!hits.length) return `No similar past incident among ${all.length} (no shared alert names and fewer than two shared terms with any). Treat this as new.`;
      const lines = [`${hits.length} similar of ${all.length} past incident(s), best first (a lead to test against this incident's evidence, not a conclusion):`];
      for (const h of hits) {
        lines.push(`- ${h.id}${h.title ? ` "${h.title}"` : ''} [${h.status}${h.severity ? `, ${h.severity}` : ''}${h.openedAt ? `, ${h.openedAt.slice(0, 10)}` : ''}${h.source === 'memory' ? ', imported postmortem' : ''}] score ${h.score.toFixed(2)}`);
        lines.push(`    root cause: ${h.rootCause || '(none recorded)'}`);
        if (h.resolution) lines.push(`    fixed by: ${h.resolution}`);
        lines.push(`    why similar: ${[h.sharedServices.length ? `services ${h.sharedServices.join(', ')}` : '', h.sharedAlerts.length ? `alerts ${h.sharedAlerts.join(', ')}` : '', h.matched.length ? `terms ${h.matched.slice(0, 10).join(', ')}` : ''].filter(Boolean).join('; ')}`);
      }
      return clip(lines.join('\n'));
    },
  });

  api.registerTool({
    name: 'evidence',
    description: `The evidence ledger (${EVIDENCE_FILE}): every aiops read in this workspace has an id the harness recorded (printed after the tool's result as "Evidence id: ev-xxxxxx"), with the exact query or command and links. "list" (newest first; filter by tool or text, since), "show" ids, "check" a text (a root cause, a report): every [ev-...] it cites must be one the harness recorded and not a failed call; it reports the kinds of evidence cited (metrics, logs, traces, changes, hosts...) and the confidence they support (low: one kind or a bad citation; medium: two; high: three or more).`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'show', 'check'] },
        ids: { type: 'array', items: { type: 'string' } },
        text: { type: 'string', description: 'check: the text whose citations to check' },
        tool: { type: 'string' }, filter: { type: 'string' }, since: { type: 'string', description: 'list: ISO time or e.g. 2h' }, limit: { type: 'number' },
      },
      required: ['action'], additionalProperties: false,
    },
    kind: 'read', parallelSafe: true,
    availableIn: configured,
    summarize: (i) => `evidence ${str(i.action)}${Array.isArray(i.ids) ? ` ${i.ids.join(' ')}` : ''}`,
    async run(input, ctx) {
      if (ctx.host.kind === 'companion') return errOut('The evidence ledger is kept in the workspace on the server.');
      const ledger = await readEvidence(api, ctx.host);
      const action = str(input.action);
      if (action === 'check') {
        const c = checkCitations(str(input.text), ledger);
        const lines = [`${c.ids.length} citation(s): ${c.known.length} recorded, ${c.unknown.length} unknown, ${c.errored.length} failed calls. Kinds of evidence: ${c.kinds.join(', ') || 'none'}. Confidence these support: at most ${c.ceiling}.`];
        if (c.problems.length) lines.push('PROBLEMS:', ...c.problems.map((p) => `- ${p}`));
        if (c.entries.length) lines.push('Cited evidence:', ...c.entries.map(formatEvidence));
        return { content: clip(lines.join('\n')), ...(c.ok ? {} : { is_error: true }) };
      }
      if (action === 'show') {
        const ids = Array.isArray(input.ids) ? input.ids.map(String) : citations(str(input.text));
        const found = ids.map((i) => ledger.find((e) => e.id === i) ?? { id: i, missing: true });
        return clip(found.map((e) => (e.missing ? `[${e.id}] NOT RECORDED: no such evidence id` : formatEvidence(e))).join('\n') || 'Give ids.');
      }
      let list = ledger;
      if (input.tool) list = list.filter((e) => e.tool === str(input.tool));
      if (input.filter) { const f = str(input.filter).toLowerCase(); list = list.filter((e) => `${e.input} ${e.excerpt ?? ''}`.toLowerCase().includes(f)); }
      if (input.since) {
        const s = str(input.since);
        const rel = /^(\d+)([mhd])$/.exec(s);
        const t = rel ? Date.now() - Number(rel[1]) * { m: 60e3, h: 3600e3, d: 86400e3 }[rel[2]] : Date.parse(s);
        if (Number.isFinite(t)) list = list.filter((e) => Date.parse(e.at) >= t);
      }
      const limit = Math.min(200, Math.max(1, Number(input.limit) || 40));
      const shown = list.slice(-limit).reverse();
      return shown.length ? clip(`${list.length} record(s)${list.length > shown.length ? `, newest ${shown.length} shown` : ''}:\n${shown.map(formatEvidence).join('\n')}`) : 'No evidence recorded yet in this workspace.';
    },
  });

  // The root cause in the incident cites evidence the harness recorded (run by incident-response after the RCA).
  api.registerGate({
    name: 'rca-evidence',
    description: 'The root cause recorded in the open incident ("Root cause:" in its timeline) cites at least two evidence ids the harness recorded ([ev-...]), none unknown or failed - runs only when named',
    applies: async () => false,
    async run({ host }) {
      const ctx = { host };
      let incs = [];
      try { incs = (await Promise.all((await incidentIds(ctx)).map((id) => loadIncident(ctx, id).catch(() => undefined)))).filter(Boolean); } catch { incs = []; }
      const withRc = incs.map((i) => ({ i, note: [...(i.timeline ?? [])].reverse().find((e) => /^Root cause:/i.test(String(e.text ?? ''))) })).filter((x) => x.note);
      if (!withRc.length) return { pass: false, summary: 'no incident has a "Root cause:" note in its timeline', details: 'Record the root cause in the incident timeline (incident update, kind note, text starting "Root cause:") with the evidence ids that support it, e.g. [ev-1a2b3c].' };
      withRc.sort((a, b) => (a.i.status === 'resolved') - (b.i.status === 'resolved') || String(b.i.updatedAt).localeCompare(String(a.i.updatedAt)));
      const { i, note } = withRc[0];
      const c = checkCitations(note.text, await readEvidence(api, host));
      return c.ok
        ? { pass: true, summary: `${i.id}: the root cause cites ${c.known.length} recorded evidence id(s) of ${c.kinds.length} kind(s) (${c.kinds.join(', ')}); confidence at most ${c.ceiling}` }
        : { pass: false, summary: `${i.id}: the root cause's citations do not hold`, details: `${c.problems.join('\n')}\n\nThe note: ${String(note.text).slice(0, 1500)}` };
    },
  });
}
