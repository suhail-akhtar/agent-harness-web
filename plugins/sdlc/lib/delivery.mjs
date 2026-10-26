// The delivery index: what the Engineering pages of the desktop show, built from the sessions'
// own events (no model, nothing guessed). A feature is a run of one of this plugin's workflows
// (build-feature, long-task); its stage follows the node the run is in; its gate results come
// from the workflow's gate nodes and from the agent's quality_gates calls; its test counts from
// the gates' summaries ("(12 tests: 11 passed, 1 failed)") and from test runs the agents made.
//
// Pure: state in, state out. index.mjs keeps it on disk and serves it through its routes.

import { testCounts } from '@harness/plugins/quality-gates/index.mjs';

export const STAGES = ['requirement', 'design', 'plan', 'build', 'gates', 'review', 'delivered'];
export const STAGE_TITLES = { requirement: 'Requirement', design: 'Design / ADR', plan: 'Plan', build: 'Build', gates: 'Gates', review: 'Review', delivered: 'Delivered' };

/** The stage of each node of the bundled workflows; other nodes by their type and name. */
const NODE_STAGE = {
  requirements: 'requirement', architecture: 'design', 'approval-mode': 'design', 'approve-design': 'design', plan: 'plan',
  implement: 'build', fix: 'build', 'fix-final': 'build', 'address-review': 'review', gates: 'gates', 'gates-final': 'gates',
  review: 'review', 'code-review': 'review', 'security-review': 'review', docs: 'delivered', deliver: 'delivered',
  // long-task
  init: 'plan', lock: 'plan', check: 'build', build: 'build', 'final-gates': 'gates', 'final-gates-2': 'gates', address: 'review', 'fix-final-2': 'build', stuck: 'build', unstick: 'build',
};

export function stageOf(node, type) {
  if (!node) return 'requirement';
  if (NODE_STAGE[node]) return NODE_STAGE[node];
  if (type === 'gate') return 'gates';
  if (/review/i.test(node)) return 'review';
  if (/require|spec/i.test(node)) return 'requirement';
  if (/design|architect|adr/i.test(node)) return 'design';
  if (/plan/i.test(node)) return 'plan';
  if (/doc|deliver|release/i.test(node)) return 'delivered';
  return 'build';
}

const MAX_DELIVERIES = 300;
const MAX_SESSIONS = 300;
const clip = (s, n) => (typeof s === 'string' ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : '');

export function emptyState() { return { version: 1, deliveries: {}, sessions: {} }; }

/**
 * Gate result lines as the harness writes them: a workflow gate node ("PASS node-test: summary")
 * or the quality_gates tool ("FAIL secrets (0.4s): summary" with details on the next lines).
 */
export function parseGateLines(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = /^(PASS|FAIL|WARN) ([A-Za-z0-9_.-]+)(?: \(([\d.]+)s\))?: (.*)$/.exec(line.trim());
    if (!m) continue;
    const summary = m[4].trim();
    const counts = /\((\d+) tests?: (\d+) passed(?:, (\d+) failed)?(?:, (\d+) skipped)?\)/.exec(summary);
    out.push({
      name: m[2], status: m[1] === 'PASS' ? 'pass' : m[1] === 'FAIL' ? 'fail' : 'warn', summary: clip(summary, 400),
      ...(m[3] ? { seconds: Number(m[3]) } : {}),
      ...(counts ? { tests: { total: Number(counts[1]), passed: Number(counts[2]), failed: Number(counts[3] ?? 0), skipped: Number(counts[4] ?? 0) } } : {}),
    });
  }
  return out;
}

/** The person-facing title of a feature: the first line of its request, else the workflow's name. */
export function titleOf(input, workflow) {
  const first = String(input?.request ?? input?.goal ?? '').split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean);
  return clip(first || workflow, 120);
}

function sessionRec(st, id, owner, now) {
  let s = st.sessions[id];
  if (!s) { s = st.sessions[id] = { id, gates: {}, running: null, updatedAt: now, runs: [] }; }
  if (owner !== undefined) s.owner = owner;
  return s;
}

function recordGates(target, results, source, at) {
  for (const g of results) target.gates[g.name] = { ...g, source, at };
  const withCounts = [...results].reverse().find((g) => g.tests);
  if (withCounts) target.tests = { ...withCounts.tests, at, gate: withCounts.name };
}

function prune(st) {
  const ds = Object.values(st.deliveries).sort((a, b) => b.updatedAt - a.updatedAt);
  for (const d of ds.slice(MAX_DELIVERIES)) delete st.deliveries[d.id];
  const ss = Object.values(st.sessions).sort((a, b) => b.updatedAt - a.updatedAt);
  for (const s of ss.slice(MAX_SESSIONS)) delete st.sessions[s.id];
}

/**
 * Applies one session event. `workflows`: the names this plugin tracks as features. `pending`:
 * the open quality_gates calls (call id -> names), kept by the caller between events.
 * Returns true when the state changed.
 */
export function applyEvent(st, e, { workflows, pending, now = Date.now() }) {
  const ev = e.event;
  if (!ev || typeof ev !== 'object') return false;
  if (ev.kind === 'workflow' && ev.run) {
    const run = ev.run;
    const s = sessionRec(st, e.sessionId, e.owner, now);
    const gateNodes = new Set((run.nodes ?? []).filter((n) => n.type === 'gate').map((n) => n.id));
    // A gate node starting: its gates are running in this session (which ones is known when it ends).
    if (ev.phase === 'node_started' && ev.node && gateNodes.has(ev.node)) { s.running = { since: now, gates: 'applicable', source: `workflow:${ev.node}` }; s.updatedAt = now; }
    if (ev.phase === 'node_finished' && ev.node && gateNodes.has(ev.node)) {
      const h = [...(run.history ?? [])].reverse().find((x) => x.node === ev.node);
      const results = parseGateLines(h?.summary);
      if (results.length) recordGates(s, results, `workflow:${ev.node}`, now);
      s.running = null; s.updatedAt = now;
    }
    if (ev.phase === 'finished') { s.running = null; s.updatedAt = now; }
    if (!workflows.includes(run.workflow)) return true;
    if (!s.runs.includes(run.id)) s.runs.push(run.id);
    let d = st.deliveries[run.id];
    if (!d) d = st.deliveries[run.id] = { id: run.id, sessionId: e.sessionId, workflow: run.workflow, title: titleOf(ev.input ?? {}, run.workflow), sessionTitle: clip(e.title, 120), createdAt: now, gates: {}, reviews: {} };
    if (e.owner !== undefined) d.owner = e.owner;
    if (e.title && (!d.title || d.title === run.workflow)) d.title = clip(e.title.replace(/^build-feature:\s*/i, ''), 120);
    d.sessionTitle = clip(e.title, 120) || d.sessionTitle;
    d.status = run.status; d.current = run.current; d.cost = Number(run.cost) || 0; d.error = run.error ? clip(run.error, 500) : undefined; d.updatedAt = now;
    const nodeType = (id) => (run.nodes ?? []).find((n) => n.id === id)?.type;
    d.nodes = (run.history ?? []).map((h) => ({ node: h.node, title: (run.nodes ?? []).find((n) => n.id === h.node)?.title ?? h.node, type: h.type, status: h.status, ...(h.outcome ? { outcome: h.outcome } : {}), startedAt: h.startedAt, ...(h.endedAt ? { endedAt: h.endedAt } : {}), ...(h.cost ? { cost: h.cost } : {}), stage: stageOf(h.node, h.type) }));
    const done = run.status === 'succeeded';
    d.stage = done ? 'delivered' : stageOf(run.current ?? d.nodes.at(-1)?.node, nodeType(run.current));
    for (const h of run.history ?? []) {
      if (h.type === 'gate' && h.status !== 'running') recordGates(d, parseGateLines(h.summary), `workflow:${h.node}`, h.endedAt ?? now);
      if (/^(code-review|security-review|review)$/.test(h.node) && h.outcome) d.reviews[h.node === 'security-review' ? 'security' : 'code'] = h.outcome;
    }
    if (s.tests && (!d.tests || s.tests.at > d.tests.at)) d.tests = s.tests;
    prune(st);
    return true;
  }
  if (ev.kind === 'tool_call' && ev.name === 'quality_gates') {
    const names = Array.isArray(ev.input?.gates) && ev.input.gates.length ? ev.input.gates.map(String) : 'applicable';
    pending.set(`${e.sessionId}:${ev.id}`, names);
    const s = sessionRec(st, e.sessionId, e.owner, now);
    s.running = { since: now, gates: names, source: 'tool' };
    s.updatedAt = now;
    return true;
  }
  if (ev.kind === 'tool_result' && ev.name === 'quality_gates') {
    pending.delete(`${e.sessionId}:${ev.id}`);
    const s = sessionRec(st, e.sessionId, e.owner, now);
    const results = parseGateLines(ev.content);
    if (results.length) recordGates(s, results, 'tool', now);
    s.running = null; s.updatedAt = now;
    for (const id of s.runs) { const d = st.deliveries[id]; if (d && results.length) { recordGates(d, results, 'tool', now); d.updatedAt = now; } }
    return true;
  }
  // Test runs the agents made themselves (npm test, pytest...): their counts.
  if (ev.kind === 'tool_result' && (ev.name === 'bash' || ev.name === 'run_script') && typeof ev.content === 'string' && /test|spec|pass/i.test(ev.content)) {
    const c = testCounts(ev.content);
    if (!c || !Number.isFinite(c.total) || !c.total) return false;
    const s = sessionRec(st, e.sessionId, e.owner, now);
    s.tests = { ...c, at: now, gate: 'agent' };
    s.updatedAt = now;
    for (const id of s.runs) { const d = st.deliveries[id]; if (d) { d.tests = s.tests; d.updatedAt = now; } }
    return true;
  }
  return false;
}

/** Who may see a record: its owner, an administrator, or anyone for the operator's own work on a single-person server. */
export function visible(rec, user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return !!user.id && rec.owner === user.id;
}

/** A delivery as the board shows it (small: no node summaries). */
export function card(d) {
  const gates = Object.values(d.gates ?? {});
  return {
    id: d.id, sessionId: d.sessionId, title: d.title, workflow: d.workflow, status: d.status, stage: d.stage, current: d.current,
    cost: d.cost ?? 0, createdAt: d.createdAt, updatedAt: d.updatedAt, reviews: d.reviews ?? {},
    gates: { pass: gates.filter((g) => g.status === 'pass').length, fail: gates.filter((g) => g.status === 'fail').length, warn: gates.filter((g) => g.status === 'warn').length, failing: gates.filter((g) => g.status === 'fail').map((g) => g.name) },
    ...(d.tests ? { tests: d.tests } : {}),
  };
}
