// aiops P1: anomaly detection (synthetic series with known anomalies, normal
// seasonality and pure noise; the false-positive rate is measured), log-pattern
// novelty, trace summaries, the topology graph, incident memory, the evidence
// ledger and its gate, the Grafana helpers, the tools in a harness against fake
// endpoints, and incident-response / ops-advisor dry runs with a scripted model
// (FakeProvider-style) with and without the optional tools. Real Grafana, Tempo
// and Jaeger are in aiops-p1-stack.test.ts.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decide, type Rules } from '../src/core/permissions.ts';
import type { Message } from '../src/core/types.ts';
import { runOne, type EvalCase } from '../src/eval/runner.ts';
import { runGates } from '../src/gates/gates.ts';
import { newRun, WorkflowRunner } from '../src/graph/runner.ts';
import type { RunRecord, WorkflowHost } from '../src/graph/types.ts';
import { validateWorkflow } from '../src/graph/validate.ts';
import { createHarness } from '../src/kernel/harness.ts';
import type { Provider, ProviderRequest, ProviderResponse } from '../src/providers/types.ts';
import { LocalHost } from '../src/runtime/host.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir } from './helpers.ts';
// @ts-expect-error plain JS
const an = await import('../plugins/aiops/lib/anomaly.mjs');
// @ts-expect-error plain JS
const tr = await import('../plugins/aiops/lib/traces.mjs');
// @ts-expect-error plain JS
const topo = await import('../plugins/aiops/lib/topology.mjs');
// @ts-expect-error plain JS
const mem = await import('../plugins/aiops/lib/memory.mjs');
// @ts-expect-error plain JS
const gf = await import('../plugins/aiops/lib/grafana.mjs');
// @ts-expect-error plain JS
const runbooks = await import('../plugins/aiops/lib/runbooks.mjs');

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(here, '..', 'plugins', 'aiops');

// ---------------- synthetic series ----------------

function rng(seed: number) {
  let s = seed | 0;
  return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const DAY = 86400; const STEP = 300;
type Pt = [number, number];
/** A daily cycle (100 +- 50) with noise (sd 5), 8 days at 5 min; optionally a bump or a level shift. */
function daily(seed: number, { bump, shift }: { bump?: { from: number; to: number; add: number }; shift?: { at: number; add: number } } = {}): Pt[] {
  const r = rng(seed); const pts: Pt[] = [];
  for (let t = 0; t <= 8 * DAY; t += STEP) {
    let v = 100 + 50 * Math.sin((2 * Math.PI * t) / DAY) + 5 * gauss(r);
    if (bump && t >= bump.from && t < bump.to) v += bump.add;
    if (shift && t >= shift.at) v += shift.add;
    pts.push([t, v]);
  }
  return pts;
}
/** The last day of a series, and the 7 days before it shifted onto it (what range queries 1..7 days back return). */
function withSeasons(pts: Pt[], end = pts.at(-1)![0]) {
  const seasons = [];
  for (let k = 1; k <= 7; k++) seasons.push(pts.filter((p) => p[0] >= end - DAY - k * DAY && p[0] <= end - k * DAY).map(([t, v]) => [t + k * DAY, v] as Pt));
  return { series: pts.filter((p) => p[0] >= end - DAY && p[0] <= end), seasons };
}

test('anomaly basics: median, MAD, robust scale floors, runs', () => {
  assert.equal(an.median([3, 1, 2]), 2);
  assert.equal(an.median([4, 1, 2, 3]), 2.5);
  assert.equal(an.mad([1, 2, 3, 4, 100]), 1);
  assert.ok(an.robustScale([5, 5, 5, 5, 5, 6], { relFloor: 0 }) > 0, 'a constant baseline still gets a scale');
  assert.deepEqual(an.runsOf([false, true, true, false, true, false, true, true, true], 2), [{ start: 1, end: 2 }, { start: 6, end: 8 }]);
});

test('anomalies: the daily peak is normal for the seasonal baseline; a bump and a level shift in the window are found; false positives measured on 200 normal windows', () => {
  const N = 200;
  const fp: Record<string, number> = { seasonal: 0, robust: 0, ewma: 0, changepoint: 0, strong: 0 };
  let pointsJudged = 0; let pointsFlagged = 0;
  for (let s = 1; s <= N; s++) {
    // Windows at every hour of the day, peaks and troughs included.
    const pts = daily(s);
    const end = 8 * DAY - (s % 24) * 3600;
    const ws = end - 2 * 3600;
    const { series, seasons } = withSeasons(pts.filter((p) => p[0] <= end), end);
    const r = an.detect({ series, seasons, windowStart: ws });
    for (const m of ['seasonal', 'robust', 'ewma']) if (r.methods[m].anomalies?.length) fp[m]!++;
    if (r.methods.changepoint.changes.length) fp.changepoint!++;
    if (r.strong.length) fp.strong!++;
    pointsJudged += series.filter((p) => p[0] >= ws).length;
    pointsFlagged += (r.methods.seasonal.anomalies ?? []).reduce((a: number, x: { points: number }) => a + x.points, 0);
  }
  // The measured rates (deterministic seeds): no method flags more than 2% of normal windows.
  for (const [m, n] of Object.entries(fp)) assert.ok(n / N <= 0.02, `${m}: ${n}/${N} normal windows flagged`);
  assert.ok(pointsFlagged / pointsJudged < 0.002, `seasonal point false-positive rate ${pointsFlagged}/${pointsJudged}`);

  let bumpFound = 0; let shiftFound = 0; let bumpStrong = 0;
  for (let s = 1; s <= 50; s++) {
    const ws = 8 * DAY - 2 * 3600;
    const b = withSeasons(daily(s, { bump: { from: ws + 3600, to: ws + 5400, add: 40 } }));
    const rb = an.detect({ series: b.series, seasons: b.seasons, windowStart: ws });
    const hit = (rb.methods.seasonal.anomalies ?? []).find((a: { from: number; to: number; direction: string }) => a.direction === 'up' && a.from >= ws + 3600 - STEP && a.to <= ws + 5400);
    if (hit) bumpFound++;
    if (rb.strong.some((x: { direction: string }) => x.direction === 'up')) bumpStrong++;
    const sh = withSeasons(daily(s, { shift: { at: ws + 3600, add: 30 } }));
    const rs = an.detect({ series: sh.series, seasons: sh.seasons, windowStart: ws });
    if (rs.methods.changepoint.changes.some((c: { at: number; delta: number }) => c.delta > 20 && Math.abs(c.at - (ws + 3600)) <= 3 * STEP)) shiftFound++;
  }
  assert.ok(bumpFound >= 49, `a +40 bump for 30 min found by the seasonal baseline in ${bumpFound}/50`);
  assert.ok(bumpStrong >= 45, `and confirmed by a second method in ${bumpStrong}/50`);
  assert.ok(shiftFound >= 45, `a +30 level shift dated within 15 min by change-point detection in ${shiftFound}/50`);
});

test('anomalies without seasonality: robust z, EWMA bands, binary segmentation and CUSUM on a flat noisy series', () => {
  const flat = (seed: number, f: (i: number) => number = () => 0): Pt[] => { const r = rng(seed); return Array.from({ length: 300 }, (_, i) => [i * 60, 50 + 3 * gauss(r) + f(i)] as Pt); };
  const ws = 240 * 60;
  let fp = 0;
  for (let s = 1; s <= 100; s++) { const r = an.detect({ series: flat(s), windowStart: ws, methods: ['robust', 'ewma', 'changepoint'] }); if (r.methods.robust.anomalies.length || r.methods.ewma.anomalies.length || r.methods.changepoint.changes.length) fp++; }
  assert.ok(fp <= 2, `${fp}/100 pure-noise windows flagged`);
  const spike = an.detect({ series: flat(7, (i) => (i >= 270 && i < 274 ? 25 : 0)), windowStart: ws, methods: ['robust', 'ewma'] });
  assert.equal(spike.methods.robust.anomalies.length, 1);
  assert.equal(spike.methods.robust.anomalies[0].direction, 'up');
  assert.equal(spike.methods.robust.anomalies[0].from, 270 * 60);
  assert.ok(spike.strong.length >= 1, 'robust and EWMA agree');
  const values = flat(3, (i) => (i >= 150 ? 12 : 0)).map((p) => p[1]);
  const cps = an.binarySegmentation(values);
  assert.equal(cps.length, 1);
  assert.ok(Math.abs(cps[0].index - 150) <= 3, `change at ${cps[0].index}`);
  const cu = an.cusum(values, { baselineN: 100 });
  assert.ok(cu.some((c: { index: number; direction: string }) => c.direction === 'up' && Math.abs(c.index - 150) <= 5), JSON.stringify(cu));
  assert.equal(an.binarySegmentation(flat(4).map((p) => p[1])).length, 0, 'no change in pure noise');
  const dn = an.detect({ series: flat(5, (i) => (i >= 260 ? -15 : 0)), windowStart: ws, methods: ['changepoint', 'robust'] });
  assert.ok(dn.methods.changepoint.changes.some((c: { delta: number }) => c.delta < -10));
  assert.ok(dn.methods.robust.anomalies.every((a: { direction: string }) => a.direction === 'down'));
  assert.match(an.robustZ(flat(1).slice(0, 5), 0).skipped, /not enough history/);
});

test('log novelty: templates mask ids and numbers; a new error template and a jumped rate are found, steady chatter is not', () => {
  assert.deepEqual(an.tokenize('2026-10-22T10:00:00Z GET /api/orders/123 took 340ms user=42 id=5f2c9a1e-1111-2222-3333-444455556666 from 10.0.0.7:5432'), ['GET', '/api/orders/<N>', 'took', '<NUM>', 'user=<NUM>', 'id=<UUID>', 'from', '<IP>']);
  const t0 = Date.parse('2026-10-22T04:00:00Z');
  const lines: string[] = [];
  const at = (ms: number, s: string) => lines.push(`${new Date(t0 + ms).toISOString()} ${s}`);
  for (let i = 0; i < 360; i++) {
    at(i * 60_000, `GET /api/orders/${i} 200 in ${20 + (i % 7)}ms`);
    if (i % 30 === 0) at(i * 60_000 + 1000, `cache refresh took ${i % 9}s`);
    if (i % 60 === 0) at(i * 60_000 + 2000, `WARN slow query on table orders took ${900 + i}ms`);
  }
  // The last hour: a new error template, and the slow-query warning every 2 minutes.
  for (let i = 300; i < 360; i++) {
    if (i % 5 === 0) at(i * 60_000 + 3000, `ERROR index orders_customer_id_idx missing: falling back to a full scan of ${1000 + i} rows`);
    if (i % 2 === 0) at(i * 60_000 + 4000, `WARN slow query on table orders took ${1900 + i}ms`);
  }
  lines.sort();
  const r = an.logNovelty(lines, { windowStart: t0 + 300 * 60_000, end: t0 + 360 * 60_000 });
  assert.equal(r.timed, true);
  const kinds = r.findings.map((f: { kind: string; template: string }) => `${f.kind}: ${f.template}`);
  assert.ok(kinds.some((k: string) => /^new: ERROR index orders_customer_id_idx missing/.test(k)), kinds.join('\n'));
  assert.ok(kinds.some((k: string) => /^jump: WARN slow query on table orders took <NUM>/.test(k)), kinds.join('\n'));
  assert.ok(!kinds.some((k: string) => /GET|cache refresh/.test(k)), `steady templates are not flagged:\n${kinds.join('\n')}`);
  // Without timestamps the last quarter of the lines is the window.
  const plain = an.logNovelty([...Array(30).fill('ok request'), ...Array(10).fill('panic: nil map')]);
  assert.equal(plain.timed, false);
  assert.equal(plain.findings[0].kind, 'new');
});

test('anomalies: the signals of a service come from its alert expressions, SLOs and metrics job', () => {
  assert.equal(an.signalOf('histogram_quantile(0.95, sum by (le) (rate(x[5m]))) > 1'), 'histogram_quantile(0.95, sum by (le) (rate(x[5m])))');
  assert.equal(an.signalOf('up == 0'), 'up');
  const sig = an.serviceSignals({ services: [{ name: 'api', metrics_job: 'api', slos: [{ name: 'avail', errors: 'sum(rate(e[{{window}}]))', total: 'sum(rate(t[{{window}}]))' }] }], alerts: [{ name: 'Down', service: 'api', expr: 'up{job="api"} == 0' }] }, 'api');
  const names = sig.map((s: { name: string }) => s.name);
  assert.deepEqual(names.slice(0, 2), ['alert Down', 'SLO avail error ratio']);
  assert.match(sig[1].query, /\[5m\]/);
  assert.ok(names.includes('request rate'));
});

// ---------------- traces ----------------

const NS = (ms: number) => String(BigInt(Math.round(ms * 1000)) * 1000n);
const b64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64');
const TRACE = '0af7651916cd43dd8448eb211c80319c';
/** frontend GET /checkout (0-1000 ms) -> orders (client 10-900) -> orders server (20-890: db 30-80, payments client 100-880) -> payments server (110-870, ERROR). */
function otlpTrace() {
  const span = (id: string, parent: string, name: string, kind: number, s: number, e: number, extra: Record<string, unknown> = {}) => ({ traceId: b64(TRACE), spanId: b64(id), parentSpanId: parent ? b64(parent) : '', name, kind, startTimeUnixNano: NS(s), endTimeUnixNano: NS(e), ...extra });
  const res = (svc: string) => ({ attributes: [{ key: 'service.name', value: { stringValue: svc } }] });
  return { batches: [
    { resource: res('frontend'), scopeSpans: [{ spans: [span('0000000000000001', '', 'GET /checkout', 2, 0, 1000), span('0000000000000002', '0000000000000001', 'POST orders', 3, 10, 900)] }] },
    { resource: res('orders'), scopeSpans: [{ spans: [span('0000000000000003', '0000000000000002', 'POST /orders', 2, 20, 890), span('0000000000000004', '0000000000000003', 'SELECT orders', 3, 30, 80, { attributes: [{ key: 'db.statement', value: { stringValue: 'SELECT * FROM orders WHERE customer_id = ?' } }] }), span('0000000000000005', '0000000000000003', 'POST payments', 3, 100, 880)] }] },
    { resource: res('payments'), scopeSpans: [{ spans: [span('0000000000000006', '0000000000000005', 'POST /charge', 2, 110, 870, { status: { code: 'STATUS_CODE_ERROR', message: 'card processor timeout' } })] }] },
  ] };
}

test('traces: OTLP (base64 ids) and Jaeger traces normalise to the same spans; the critical path, self times, errors and services', () => {
  const spans = tr.normalizeOtlp(otlpTrace());
  assert.equal(spans.length, 6);
  assert.equal(spans[0].trace, TRACE);
  assert.equal(spans[0].id, '0000000000000001');
  assert.equal(spans[5].error, true);
  assert.equal(spans[5].message, 'card processor timeout');
  const s = tr.summarizeTrace(spans);
  assert.deepEqual(s.criticalPath.map((c: { service: string; name: string }) => `${c.service} ${c.name}`), ['frontend GET /checkout', 'frontend POST orders', 'orders POST /orders', 'orders SELECT orders', 'orders POST payments', 'payments POST /charge']);
  assert.match(s.text, /Slowest by self time: payments POST \/charge \(server\) 760 ms/);
  assert.match(s.text, /Errors \(1\):\n {2}payments POST \/charge \(server\): card processor timeout/);
  assert.match(s.text, /Services \(3\)/);
  assert.equal(s.errors, 1);
  // The same trace as Jaeger returns it.
  const procs = { p1: { serviceName: 'frontend' }, p2: { serviceName: 'orders' }, p3: { serviceName: 'payments' } };
  const js = (id: string, parent: string, op: string, p: string, s0: number, e: number, tags: unknown[] = []) => ({ traceID: TRACE, spanID: id, operationName: op, references: parent ? [{ refType: 'CHILD_OF', traceID: TRACE, spanID: parent }] : [], startTime: 1_700_000_000_000_000 + s0 * 1000, duration: (e - s0) * 1000, tags, processID: p });
  const jt = { traceID: TRACE, processes: procs, spans: [js('01', '', 'GET /checkout', 'p1', 0, 1000), js('02', '01', 'POST orders', 'p1', 10, 900), js('03', '02', 'POST /orders', 'p2', 20, 890), js('05', '03', 'POST payments', 'p2', 100, 880), js('06', '05', 'POST /charge', 'p3', 110, 870, [{ key: 'error', type: 'bool', value: true }, { key: 'otel.status_description', value: 'card processor timeout' }])] };
  const j = tr.summarizeTrace(tr.normalizeJaeger(jt));
  assert.equal(j.criticalPath.at(-1).service, 'payments');
  assert.equal(j.errors, 1);
  // Repeated calls under one parent are named.
  const many = [{ id: 'a', service: 's', name: 'root', start: 0, end: 100, duration: 100, trace: 't' }, ...Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, parent: 'a', service: 'db', name: 'SELECT item', start: i * 8, end: i * 8 + 5, duration: 5, trace: 't' }))];
  assert.match(tr.summarizeTrace(many).text, /db SELECT item called 12 times under s root \(N\+1\?\)/);
});

test('traces: TraceQL from the search fields, quoting what it is given', () => {
  assert.equal(tr.traceql({ service: 'orders', minDuration: '500ms', status: 'error' }), '{ resource.service.name = "orders" && duration >= 500ms && status = error }');
  assert.equal(tr.traceql({ operation: 'GET "/x"', minDuration: '2s' }), '{ name = "GET \\"/x\\"" && duration >= 2s }');
  assert.equal(tr.traceql({}), '{ }');
  assert.throws(() => tr.traceql({ minDuration: 'slow' }), /not a duration/);
  assert.equal(tr.idHex(b64('0af7651916cd43dd')), '0af7651916cd43dd');
  // Tempo's search drops a trace id's leading zeros (found against a real Tempo): shown and looked up as 32 characters.
  assert.equal(tr.traceIdHex('2a1d6085c3a67a580056feb6ae28542'), '02a1d6085c3a67a580056feb6ae28542');
  assert.equal(tr.traceIdHex('0AF7651916CD43DD'), '0af7651916cd43dd');
});

// ---------------- topology ----------------

const INV = {
  hosts: [{ name: 'db-1', address: '10.0.0.5' }, { name: 'app-1', address: '10.0.0.2' }],
  services: [
    { name: 'web', host: 'app-1', depends_on: ['orders'], metrics_job: 'web' },
    { name: 'orders', host: 'app-1', depends_on: ['db-1'], metrics_job: 'orders-api', trace_service: 'orders-svc' },
    { name: 'billing', host: 'app-1', depends_on: ['db-1'] },
  ],
  alerts: [],
};

test('topology: inventory, trace service graph, Kubernetes objects and Prometheus up merge into one graph; blast radius, dependencies, single points of failure, Mermaid', () => {
  const g = topo.newGraph();
  const alias = topo.aliasMap(INV);
  topo.fromInventory(g, INV);
  topo.fromTraceEdges(g, [{ client: 'web', server: 'orders-svc', rate: 12, errors: 0.6 }, { client: 'orders-svc', server: 'payments', rate: 3, errors: 0 }], { alias, source: 'tempo-service-graph' });
  topo.fromPromUp(g, [{ job: 'orders-api', instance: '10.0.0.2:8080', up: '1' }, { job: 'web', instance: '10.0.0.2:80', up: '1' }, { job: 'web', instance: '10.0.0.3:80', up: '0' }], { alias, hosts: INV.hosts });
  const k8s = [{ kind: 'List', items: [
    { kind: 'Service', metadata: { name: 'payments', namespace: 'shop' }, spec: { selector: { app: 'payments' } } },
    { kind: 'Service', metadata: { name: 'fraud', namespace: 'shop' }, spec: { selector: { app: 'fraud' } } },
    { kind: 'Endpoints', metadata: { name: 'payments', namespace: 'shop' }, subsets: [{ addresses: [{ ip: '10.1.0.4' }] }] },
    { kind: 'Deployment', metadata: { name: 'payments', namespace: 'shop' }, spec: { replicas: 1 } },
    { kind: 'ReplicaSet', metadata: { name: 'payments-7d9', namespace: 'shop', ownerReferences: [{ kind: 'Deployment', name: 'payments', controller: true }] } },
    { kind: 'Pod', metadata: { name: 'payments-7d9-x', namespace: 'shop', labels: { app: 'payments' }, ownerReferences: [{ kind: 'ReplicaSet', name: 'payments-7d9', controller: true }] }, spec: { containers: [{ name: 'app', env: [{ name: 'FRAUD_URL', value: 'http://fraud.shop.svc.cluster.local:8080/check' }, { name: 'MODE', value: 'live' }] }] } },
    { kind: 'Pod', metadata: { name: 'fraud-1', namespace: 'shop', labels: { app: 'fraud' } }, spec: { containers: [{ name: 'app' }] } },
  ] }];
  topo.fromK8s(g, k8s, { alias });
  const e = g.edges.get('web\u0000orders')!;
  assert.deepEqual([...e.kinds].sort(), ['calls', 'depends_on']);
  assert.deepEqual([...e.sources].sort(), ['inventory', 'tempo-service-graph']);
  assert.ok(Math.abs(e.errorRatio - 0.05) < 1e-9);
  assert.ok(g.edges.has('payments\u0000fraud'), 'an env URL naming another Service is a call');
  assert.ok(g.edges.has('payments\u0000deployment/payments'));
  assert.equal(g.nodes.get('web')!.instances, 2);
  assert.equal(g.nodes.get('web')!.up, 1);
  assert.ok(g.edges.has('orders\u0000app-1'), 'up instance address -> inventory host');
  // What depends on db-1 (blast radius), what web depends on (where to look), nearest first.
  assert.deepEqual(topo.walk(g, 'db-1', { reverse: true }).map((x: { name: string }) => x.name), ['billing', 'orders', 'web']);
  const deps = topo.walk(g, 'web', {}).map((x: { name: string; depth: number }) => `${x.depth}:${x.name}`);
  assert.deepEqual(deps.slice(0, 2), ['1:app-1', '1:orders']);
  assert.ok(deps.includes('3:fraud'));
  const sp = topo.spof(g);
  const byName = Object.fromEntries(sp.map((r: { name: string; reasons: string[] }) => [r.name, r.reasons.join('; ')]));
  assert.match(byName['app-1']!, /a host running 3 services/);
  assert.match(byName['payments']!, /one instance/);
  assert.match(byName['web'] ?? '', /^$|down now/);
  assert.match(byName['db-1']!, /a single host others depend on/);
  const mm = topo.toMermaid(g, { focus: 'orders' });
  assert.match(mm, /^graph LR/);
  assert.match(mm, /-->\|"12\/s 5% err"\|/);
  assert.match(mm, /-\.->/);
  assert.match(mm, /style n\d+ stroke-width:3px/);
  assert.ok(topo.articulationPoints(g).has('payments'));
});

// ---------------- incident memory and evidence ----------------

test('incident memory: BM25 with service and alert boosts finds the past incident like this one, and not an unrelated one', () => {
  const docs = [
    mem.incidentDoc({ id: 'inc-20260901-slow-orders', title: 'Slow order history', services: ['shop-api'], status: 'resolved', rootCause: 'migration 0042 dropped the orders_customer_id_idx index', resolution: 'recreated the index with dbctl create-index', timeline: [{ text: 'ShopOrdersLatencyHigh fired: p95 2 s on GET /api/orders' }, { text: 'slow query warnings on table orders' }] }),
    mem.incidentDoc({ id: 'inc-20260915-disk-full', title: 'Disk full on db-1', services: ['db-1'], status: 'resolved', rootCause: 'render cache filled /data', resolution: 'deleted render-*.tmp', timeline: [{ text: 'DiskAlmostFull fired' }] }),
    mem.markdownDoc('pm-2025-cert', '# Expired certificate\nServices: shop-api\nRoot cause: the TLS certificate expired\nResolution: renewed\n'),
  ];
  const hits = mem.rankSimilar(docs, { text: 'order history page very slow, slow query on orders table', services: ['shop-api'], alerts: ['ShopOrdersLatencyHigh'] });
  assert.equal(hits[0].id, 'inc-20260901-slow-orders');
  assert.deepEqual(hits[0].sharedAlerts, ['ShopOrdersLatencyHigh']);
  assert.ok(hits[0].score > (hits[1]?.score ?? 0) * 2);
  assert.ok(!hits.some((h: { id: string }) => h.id === 'inc-20260915-disk-full'));
  assert.deepEqual(mem.rankSimilar(docs, { text: 'kafka consumer lag growing' }), [], 'nothing shared: no match');
  assert.deepEqual(mem.words('Queries were failing'), ['queri', 'fail']);
});

test('evidence citations: unknown and failed ids are refused; the kinds of evidence set the confidence ceiling', () => {
  const ledger = [{ id: 'ev-aaaaaa', tool: 'prometheus_query', kind: 'metrics' }, { id: 'ev-bbbbbb', tool: 'logs_search', kind: 'logs' }, { id: 'ev-cccccc', tool: 'traces', kind: 'traces' }, { id: 'ev-dddddd', tool: 'ssh_exec', kind: 'hosts', error: true }];
  const three = mem.checkCitations('Root cause: index missing [ev-aaaaaa] [ev-bbbbbb] [ev-cccccc]', ledger);
  assert.equal(three.ok, true);
  assert.equal(three.ceiling, 'high');
  assert.equal(mem.checkCitations('x [ev-aaaaaa] [ev-bbbbbb]', ledger).ceiling, 'medium');
  const bad = mem.checkCitations('x [ev-aaaaaa] [ev-123456] [ev-dddddd]', ledger);
  assert.equal(bad.ok, false);
  assert.equal(bad.ceiling, 'low');
  assert.match(bad.problems.join('\n'), /unknown evidence id\(s\) ev-123456/);
  assert.match(bad.problems.join('\n'), /ev-dddddd are failed calls/);
  assert.match(mem.checkCitations('no ids', ledger).problems[0], /0 citation/);
});

// ---------------- Grafana helpers ----------------

test('grafana helpers: panels in rows, variables and built-ins interpolated, data sources resolved, frames summarised, deep links, coverage; a workspace credential is ignored', () => {
  const dash = {
    uid: 'shop', title: 'Shop',
    templating: { list: [{ name: 'job', type: 'custom', current: { value: 'demoapp' } }, { name: 'ds', type: 'datasource', current: { value: 'prom-uid' } }, { name: 'route', type: 'query', current: { value: ['$__all'] }, allValue: '.+' }] },
    panels: [
      { id: 1, type: 'timeseries', title: 'p95', datasource: { type: 'prometheus', uid: '${ds}' }, targets: [{ refId: 'A', expr: 'histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{job="$job",route=~"$route"}[$__rate_interval])))' }] },
      { id: 2, type: 'row', title: 'More', collapsed: true, panels: [{ id: 3, type: 'stat', title: 'logs', datasource: { type: 'loki', uid: 'loki-uid' }, targets: [{ refId: 'A', expr: '{job="x"}' }] }] },
    ],
  };
  const ps = gf.flattenPanels(dash);
  assert.deepEqual(ps.map((p: { id: number; row?: string }) => `${p.id}${p.row ? `@${p.row}` : ''}`), ['1', '3@More']);
  const vars = gf.dashboardVars(dash, { job: 'shop-api' });
  assert.equal(vars.job.value, 'shop-api');
  assert.equal(vars.route.value, '.+');
  assert.equal(gf.interpolate(ps[0].targets[0].expr, vars, { stepS: 30 }), 'histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{job="shop-api",route=~".+"}[60s])))');
  const dss = [{ uid: 'prom-uid', name: 'Prometheus', type: 'prometheus', isDefault: true }, { uid: 'loki-uid', name: 'Loki', type: 'loki' }];
  assert.deepEqual(gf.resolveDatasource(ps[0].datasource, dss, vars), { uid: 'prom-uid', type: 'prometheus', name: 'Prometheus' });
  assert.equal(gf.resolveDatasource(undefined, dss, vars).uid, 'prom-uid', 'no data source: the default');
  assert.equal(gf.resolveDatasource('Loki', dss, vars).type, 'loki', 'an old-style name');
  const series = gf.framesToSeries([{ schema: { fields: [{ name: 'Time', type: 'time' }, { name: 'Value', type: 'number', labels: { job: 'x' } }] }, data: { values: [[1000, 2000], [1.5, null]] } }]);
  assert.deepEqual(series[0].labels, { job: 'x' });
  assert.equal(series[0].points[0][0], 1);
  assert.ok(Number.isNaN(series[0].points[1][1]));
  assert.equal(gf.dashboardLink('http://g:3000/', 'shop', { panelId: 3, from: 1, to: 2, vars: { job: 'api' }, version: '11.2.0' }), 'http://g:3000/d/shop?orgId=1&from=1&to=2&var-job=api&viewPanel=panel-3');
  assert.match(gf.dashboardLink('http://g', 'shop', { panelId: 3, version: '10.4.1' }), /viewPanel=3$/);
  const cov = gf.coverage([{ name: 'shop-api', metrics_job: 'demoapp' }, { name: 'billing-worker' }], [{ title: 'Shop', text: 'rate(x{job="demoapp"}[5m])' }], [{ name: 'BillingStuck', text: 'billing-worker queue' }]);
  assert.deepEqual(cov.map((c: { service: string; dashboards: string[]; rules: string[] }) => `${c.service}:${c.dashboards.length}:${c.rules.length}`), ['shop-api:1:0', 'billing-worker:0:1']);
  // A workspace inventory may name a Grafana, never a credential to send to it.
  assert.equal(gf.grafanaConfig({ monitoring: { grafana: { url: 'http://evil:3000', credential: 'ops-grafana' }, source: 'workspace' } }).credential, undefined);
  assert.equal(gf.grafanaConfig({ monitoring: { grafana: { url: 'http://g:3000', credential: 'ops-grafana' }, source: 'operator' } }).credential, 'ops-grafana');
  assert.match(gf.grafanaConfig({ monitoring: { grafana: { url: 'http://g', credential: 'prod-root' }, source: 'operator' } }).error, /not a vault name this plugin may read/);
  assert.match(gf.grafanaConfig({ monitoring: { grafana: 'ftp://x' } }).error, /not an http/);
});

// ---------------- the tools in a harness ----------------

async function harness() {
  const dataDir = await tempDir();
  const h = await createHarness({ dataDir, plugins: [PLUGIN], search: null, memory: 'off', scheduler: false });
  return { h, dataDir, tool: (n: string) => h.registry.tools.get(n)! };
}
const ctxFor = (root: string, services?: unknown) => ({ host: new LocalHost(root), signal: new AbortController().signal, readFiles: new Map(), todos: [], setTodos() {}, emit() {}, services }) as unknown as ToolContext;
async function workspace(inv: unknown) {
  const ws = await tempDir();
  await fs.mkdir(path.join(ws, '.harness', 'ops'), { recursive: true });
  await fs.writeFile(path.join(ws, '.harness', 'ops', 'inventory.json'), JSON.stringify(inv));
  return ws;
}
type Handler = (u: URL, body: string, req: http.IncomingMessage) => { status?: number; json: unknown } | undefined;
async function fakeServer(handler: Handler) {
  const seen: string[] = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const u = new URL(req.url!, 'http://x');
      seen.push(`${req.method} ${u.pathname}${u.search} ${req.headers.authorization ?? ''}`);
      const r = handler(u, body, req) ?? { status: 404, json: { message: 'not found' } };
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.json));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, seen, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

/** A Prometheus whose range queries return a daily cycle, with a bump in the last 30 minutes for "orders" signals. */
async function cyclePrometheus() {
  return fakeServer((u) => {
    const q = u.searchParams.get('query') ?? '';
    if (u.pathname.endsWith('/query_range')) {
      const start = Number(u.searchParams.get('start')); const end = Number(u.searchParams.get('end')); const step = Number(u.searchParams.get('step'));
      const now = Date.now() / 1000;
      const values: [number, string][] = [];
      let i = 0;
      for (let t = start; t <= end; t += step) {
        const v = 100 + 50 * Math.sin((2 * Math.PI * t) / DAY) + 3 * Math.sin(i++ * 1.7) + (q.includes('orders') && t > now - 1800 ? 80 : 0);
        values.push([t, String(v)]);
      }
      return { json: { status: 'success', data: { resultType: 'matrix', result: [{ metric: { job: q.includes('orders') ? 'orders' : 'web' }, values }] } } };
    }
    if (u.pathname.endsWith('/query')) {
      if (q.startsWith('sum by (client, server) (rate(traces_service_graph_request_total')) return { json: { status: 'success', data: { resultType: 'vector', result: [{ metric: { client: 'web', server: 'orders' }, value: [0, '5'] }] } } };
      if (q.startsWith('sum by (client, server) (rate(traces_service_graph_request_failed_total')) return { json: { status: 'success', data: { resultType: 'vector', result: [{ metric: { client: 'web', server: 'orders' }, value: [0, '0.5'] }] } } };
      if (q === 'up') return { json: { status: 'success', data: { resultType: 'vector', result: [{ metric: { job: 'orders', instance: '10.0.0.2:8080' }, value: [0, '1'] }] } } };
      return { json: { status: 'success', data: { resultType: 'vector', result: [{ metric: { job: 'web' }, value: [0, '1'] }] } } };
    }
    return undefined;
  });
}

test('aiops P1 tools: permission classes, operator-only credentials, asked writes; anomalies and topology against a fake Prometheus; every result gets an evidence id the ledger keeps', async () => {
  const p = await cyclePrometheus();
  const { h, tool, dataDir } = await harness();
  const dir = await tempDir();
  const opFile = path.join(dir, 'op.json');
  const before = process.env.HARNESS_OPS_INVENTORY;
  try {
    const kinds = Object.fromEntries(['grafana', 'traces', 'topology', 'anomalies', 'similar_incidents', 'evidence'].map((n) => [n, tool(n)?.kind]));
    assert.deepEqual(kinds, { grafana: 'network', traces: 'network', topology: 'network', anomalies: 'network', similar_incidents: 'read', evidence: 'read' });
    for (const n of ['grafana', 'traces', 'topology', 'anomalies']) assert.equal(tool(n).untrusted, true, n);
    assert.ok(h.registry.gates.get('rca-evidence'));
    assert.ok(h.registry.agents.get('refuter'));
    assert.equal(h.registry.agents.get('refuter')!.tools!.includes('service_control'), false, 'the refuter cannot change services');
    // Permissions: the operator's Grafana is read unasked; a workspace one, and every annotation write, is asked; the token is the operator's.
    const rules: Rules = { allow: [], deny: [], ask: [] };
    const c = { mode: 'default' as const, rules, sandboxed: false, network: 'full' as const };
    delete process.env.HARNESS_OPS_INVENTORY;
    assert.equal(decide(tool('grafana'), { action: 'dashboards' }, c).action, 'ask', 'a workspace-chosen Grafana');
    assert.deepEqual(tool('grafana').vaultNames!({ action: 'dashboards' }), []);
    await fs.writeFile(opFile, JSON.stringify({ monitoring: { prometheus: p.url, grafana: { url: 'http://127.0.0.1:9', credential: 'ops-grafana-viewer' }, tempo: { url: 'http://127.0.0.1:9', credential: 'ops-tempo' } }, hosts: [] }));
    process.env.HARNESS_OPS_INVENTORY = opFile;
    assert.deepEqual(tool('grafana').vaultNames!({ action: 'dashboards' }), ['ops-grafana-viewer']);
    assert.deepEqual(tool('grafana').vaultNames!({ action: 'link', expr: 'up' }), [], 'an Explore link is built here: no call, no token');
    assert.deepEqual(tool('grafana').vaultNames!({ action: 'link', uid: 'x' }), ['ops-grafana-viewer'], 'a dashboard link reads the dashboard');
    assert.deepEqual(tool('traces').vaultNames!({ action: 'search' }), ['ops-tempo']);
    const allowVault: Rules = { allow: ['vault(ops-grafana-viewer)', 'vault(ops-tempo)'], deny: [], ask: [] };
    assert.equal(decide(tool('grafana'), { action: 'dashboards' }, { ...c, rules: allowVault }).action, 'allow', 'reading the operator\'s Grafana');
    assert.equal(decide(tool('grafana'), { action: 'annotate', text: 'x' }, { ...c, rules: allowVault }).action, 'ask', 'writing an annotation is asked');
    assert.equal(decide(tool('grafana'), { action: 'annotate', text: 'x' }, { ...c, mode: 'dontAsk', rules: allowVault }).action, 'deny');
    assert.match(tool('grafana').summarize({ action: 'annotate', text: 'INC-1 start', tags: ['incident'] }), /^WRITE a Grafana annotation/);
    assert.equal(decide(tool('topology'), { action: 'graph' }, c).action, 'allow', 'the operator\'s Prometheus: a read');
    delete process.env.HARNESS_OPS_INVENTORY;

    const ws = await workspace({ monitoring: { prometheus: p.url }, hosts: [{ name: 'app-1', address: '10.0.0.2' }], services: [{ name: 'web', metrics_job: 'web', depends_on: ['orders'], host: 'app-1' }, { name: 'orders', metrics_job: 'orders', host: 'app-1' }], alerts: [] });
    const ctx = ctxFor(ws);
    const a = await tool('anomalies').run({ query: 'sum(rate(orders_requests_total[5m]))', window: '1h', history: '24h', seasons: 3 }, ctx);
    assert.equal(a.is_error, undefined, a.content);
    assert.match(a.content, /STRONG/);
    assert.match(a.content, /seasonal: UP/);
    assert.match(a.content, /Evidence id: ev-[0-9a-f]{6}/);
    const quiet = await tool('anomalies').run({ query: 'sum(rate(web_requests_total[5m]))', window: '1h', history: '24h', seasons: 3 }, ctx);
    assert.match(quiet.content, /^0 finding\(s\), 0 strong/, 'the daily cycle alone is normal');
    const t = await tool('topology').run({ action: 'dependents', service: 'orders' }, ctx);
    assert.match(t.content, /web \(depth 1, via orders\) \[calls,depends_on; inventory,tempo-service-graph; 5 req\/s; 10% errors\]/);
    assert.match(t.content, /```|graph LR/);
    const sp = await tool('topology').run({ action: 'spof' }, ctx);
    assert.match(sp.content, /orders \(service\): one instance/);
    // The ledger: the tools' own records, and the hook's for the older tools (with the id in a note after the result).
    const ledger = await mem.readEvidence({ dataDir: path.join(dataDir, 'plugin-data', 'aiops'), workspacePath: async (_h: unknown, rel: string) => path.join(ws, rel) }, new LocalHost(ws));
    assert.ok(ledger.some((e: { tool: string; excerpt?: string }) => e.tool === 'anomalies' && /STRONG/.test(e.excerpt ?? '')));
    assert.ok(ledger.every((e: { id: string }) => /^ev-[0-9a-f]{6}$/.test(e.id)));
    const ev = await tool('evidence').run({ action: 'check', text: `Root cause: ${ledger.slice(0, 2).map((e: { id: string }) => `[${e.id}]`).join(' ')} [ev-000000]` }, ctx);
    assert.equal(ev.is_error, true);
    assert.match(ev.content, /unknown evidence id\(s\) ev-000000/);
    // The ledger is in the workspace, where the agent can write: records it adds itself are not evidence.
    await fs.appendFile(path.join(ws, mem.EVIDENCE_FILE), `${JSON.stringify({ id: 'ev-f0f0f0', at: new Date().toISOString(), tool: 'traces', kind: 'traces', input: '{}' })}
${JSON.stringify({ id: 'ev-f1f1f1', at: new Date().toISOString(), tool: 'logs_search', kind: 'logs', input: '{}', sig: 'ab'.repeat(32) })}
`);
    const forged = await tool('evidence').run({ action: 'check', text: `Root cause: [${ledger[0].id}] [ev-f0f0f0] [ev-f1f1f1]` }, ctx);
    assert.match(forged.content, /unknown evidence id\(s\) ev-f0f0f0, ev-f1f1f1/);
  } finally {
    if (before === undefined) delete process.env.HARNESS_OPS_INVENTORY; else process.env.HARNESS_OPS_INVENTORY = before;
    await h.close(); await p.close();
  }
});

test('aiops P1 tools: grafana, traces (Tempo and Jaeger) against fake APIs - queries, links, the annotation write audited, a 403 explained', async () => {
  const dashboard = { dashboard: { uid: 'shop', title: 'Shop', templating: { list: [{ name: 'job', type: 'custom', current: { value: 'web' } }] }, panels: [{ id: 4, type: 'timeseries', title: 'Requests', datasource: { type: 'prometheus', uid: 'prom' }, targets: [{ refId: 'A', expr: 'sum(rate(http_requests_total{job="$job"}[$__rate_interval]))' }] }] }, meta: { folderTitle: 'Ops' } };
  let annotations = 0;
  const g = await fakeServer((u, body, req) => {
    if (u.pathname === '/api/health') return { json: { version: '11.2.0' } };
    if (u.pathname === '/api/search') return { json: [{ uid: 'shop', title: 'Shop', url: '/d/shop/shop', tags: ['web'] }] };
    if (u.pathname === '/api/dashboards/uid/shop') return { json: dashboard };
    if (u.pathname === '/api/datasources') return { status: 403, json: { message: 'Permission denied' } };
    if (u.pathname === '/api/frontend/settings') return { json: { defaultDatasource: 'Prometheus', datasources: { Prometheus: { uid: 'prom', name: 'Prometheus', type: 'prometheus' } } } };
    if (u.pathname === '/api/ds/query') {
      const q = JSON.parse(body).queries[0];
      assert.equal(q.expr, 'sum(rate(http_requests_total{job="web"}[60s]))');
      return { json: { results: { A: { frames: [{ schema: { fields: [{ name: 'Time', type: 'time' }, { name: 'Value', type: 'number', labels: { job: 'web' } }] }, data: { values: [[1, 2], [3, 4]] } }] } } } };
    }
    if (u.pathname === '/api/prometheus/grafana/api/v1/rules') return { json: { status: 'success', data: { groups: [{ name: 'g', file: 'Ops', rules: [{ name: 'WebDown', state: 'firing', health: 'ok', labels: { service: 'web' }, alerts: [{ state: 'Alerting', activeAt: '2026-10-22T10:00:00Z', value: '0', labels: {} }] }, { name: 'Quiet', state: 'inactive', health: 'ok' }] }] } } };
    if (u.pathname === '/api/annotations' && req.method === 'GET') return { json: [{ time: 1_700_000_000_000, text: 'deploy web v2', tags: ['deploy'] }] };
    if (u.pathname === '/api/annotations' && req.method === 'POST') { annotations++; return req.headers.authorization === 'Bearer viewer-token' ? { status: 403, json: { message: 'You\'ll need additional permissions to perform this action.' } } : { json: { id: 77, message: 'Annotation added' } }; }
    return undefined;
  });
  const tempo = await fakeServer((u) => {
    if (u.pathname === '/api/search') { assert.equal(u.searchParams.get('q'), '{ resource.service.name = "orders" && status = error }'); return { json: { traces: [{ traceID: TRACE, rootServiceName: 'frontend', rootTraceName: 'GET /checkout', startTimeUnixNano: '1700000000000000000', durationMs: 1000, spanSets: [{ matched: 2 }] }] } }; }
    if (u.pathname === `/api/v2/traces/${TRACE}`) return { json: { trace: { resourceSpans: otlpTrace().batches } } };
    return undefined;
  });
  const jaeger = await fakeServer((u) => {
    if (u.pathname === '/api/traces') return { json: { data: [{ traceID: TRACE, processes: { p1: { serviceName: 'orders' } }, spans: [{ traceID: TRACE, spanID: 'aa', operationName: 'POST /orders', references: [], startTime: 1_700_000_000_000_000, duration: 500_000, tags: [{ key: 'error', value: true }], processID: 'p1' }] }] } };
    if (u.pathname === '/api/dependencies') return { json: { data: [{ parent: 'frontend', child: 'orders', callCount: 42 }] } };
    if (u.pathname === '/api/services') return { json: { data: ['orders', 'frontend'] } };
    return undefined;
  });
  const { h, tool, dataDir } = await harness();
  const dir = await tempDir();
  const opFile = path.join(dir, 'op.json');
  const before = process.env.HARNESS_OPS_INVENTORY;
  const secrets = { 'ops-grafana': 'editor-token', 'ops-grafana-viewer': 'viewer-token' };
  const vault = { async list() { return []; }, async reveal(n: string) { return secrets[n as keyof typeof secrets]; }, async envFor() { return {}; } };
  try {
    await fs.writeFile(opFile, JSON.stringify({ monitoring: { prometheus: 'http://127.0.0.1:9', grafana: { url: g.url, credential: 'ops-grafana', datasource: 'prom' }, tempo: tempo.url, jaeger: jaeger.url }, hosts: [] }));
    process.env.HARNESS_OPS_INVENTORY = opFile;
    const ws = await workspace({ services: [{ name: 'web', metrics_job: 'web' }, { name: 'orders' }] });
    const ctx = { ...ctxFor(ws, { vault }) } as ToolContext;
    const run = (n: string, i: Record<string, unknown>) => tool(n).run(i, ctx);
    const d = await run('grafana', { action: 'dashboards' });
    assert.match(d.content, /- Shop \[uid shop\] tags web\n {4}http:\/\/127\.0\.0\.1:\d+\/d\/shop\/shop/);
    assert.ok(g.seen.some((s) => /Bearer editor-token/.test(s)), 'the operator\'s token is sent');
    const panel = await run('grafana', { action: 'panel', uid: 'shop', panel: 4, from: 'now-1h' });
    assert.match(panel.content, /\{job="web"\}: last 4, min 3, max 4/);
    assert.match(panel.content, /Link: .*\/d\/shop\?orgId=1&from=\d+&to=\d+&var-job=web&viewPanel=panel-4/);
    assert.match(panel.content, /Evidence id: ev-/);
    const al = await run('grafana', { action: 'alerts' });
    assert.match(al.content, /2 Grafana alert rule\(s\), 1 firing/);
    assert.match(al.content, /\[FIRING\] WebDown/);
    assert.match(al.content, /\[NORMAL\] Quiet/);
    assert.match((await run('grafana', { action: 'annotations', from: 'now-30d' })).content, /\[deploy\]: deploy web v2/);
    const w = await run('grafana', { action: 'annotate', text: 'inc-1: orders slow', tags: ['incident', 'inc-1'], time: 'now-30m', time_end: 'now' });
    assert.match(w.content, /Annotation 77 written/);
    const audit = await fs.readFile(path.join(dataDir, 'plugin-data', 'aiops', 'audit.jsonl'), 'utf8');
    assert.match(audit, /"action":"annotate"/);
    // A Viewer token cannot write: the error says why.
    await fs.writeFile(opFile, JSON.stringify({ monitoring: { grafana: { url: g.url, credential: 'ops-grafana-viewer' } }, hosts: [] }));
    const denied = await run('grafana', { action: 'annotate', text: 'x' });
    assert.equal(denied.is_error, true);
    assert.match(denied.content, /403.*needs Editor/);
    assert.equal(annotations, 2);
    const link = await run('grafana', { action: 'link', expr: 'up' });
    assert.match(link.content, /needs the Prometheus data source's uid: set monitoring\.grafana\.datasource/);
    await fs.writeFile(opFile, JSON.stringify({ monitoring: { grafana: { url: g.url, credential: 'ops-grafana', datasource: 'prom' }, tempo: tempo.url, jaeger: jaeger.url }, hosts: [] }));
    assert.match((await run('grafana', { action: 'link', expr: 'up', from: 'now-2h' })).content, /\/explore\?schemaVersion=1&orgId=1&panes=/);
    // Traces: Tempo search and a trace by id; Jaeger search and dependencies.
    const s = await run('traces', { action: 'search', service: 'orders', status: 'error' });
    assert.match(s.content, new RegExp(`${TRACE}: frontend GET /checkout 1000 ms`));
    const one = await run('traces', { action: 'trace', id: TRACE });
    assert.match(one.content, /Critical path/);
    assert.match(one.content, /payments POST \/charge \(server\): card processor timeout/);
    const js = await run('traces', { action: 'search', backend: 'jaeger', service: 'orders', status: 'error' });
    assert.match(js.content, /1 ERROR span\(s\)/);
    assert.ok(jaeger.seen.some((x) => /tags=%7B%22error%22%3A%22true%22%7D/.test(x)));
    assert.match((await run('traces', { action: 'dependencies', backend: 'jaeger' })).content, /frontend -> orders: 42 calls/);
    assert.match((await run('traces', { action: 'trace', id: 'nope' })).content, /hex trace id/);
  } finally {
    if (before === undefined) delete process.env.HARNESS_OPS_INVENTORY; else process.env.HARNESS_OPS_INVENTORY = before;
    await h.close(); await g.close(); await tempo.close(); await jaeger.close();
  }
});

test('similar_incidents and the rca-evidence gate in a workspace: past incidents found at triage; a root cause without recorded citations fails the gate, one with them passes', async () => {
  const { h, tool, dataDir } = await harness();
  try {
    const ws = await workspace({ services: [{ name: 'shop-api', health: 'http://127.0.0.1:9/health' }] });
    const ctx = ctxFor(ws);
    const inc = (a: Record<string, unknown>) => tool('incident').run(a, ctx);
    await inc({ action: 'open', title: 'Slow order history', severity: 'sev2', services: ['shop-api'], summary: 'ShopOrdersLatencyHigh: p95 2 s on GET /api/orders' });
    const id1 = (await inc({ action: 'list' })).content.split(' ')[0];
    await inc({ action: 'resolve', id: id1, root_cause: 'migration 0042 dropped the orders_customer_id_idx index', resolution: 'dbctl create-index orders_customer_id_idx' });
    await fs.mkdir(path.join(ws, '.harness', 'ops', 'incident-memory'), { recursive: true });
    await fs.writeFile(path.join(ws, '.harness', 'ops', 'incident-memory', 'pm-cert.md'), '# Expired certificate\nServices: shop-api\nRoot cause: the certificate expired\n');
    const s = await tool('similar_incidents').run({ text: 'order history very slow, slow query on orders', services: ['shop-api'], alerts: ['ShopOrdersLatencyHigh'] }, ctx);
    assert.match(s.content, new RegExp(`- ${id1} "Slow order history"`));
    assert.match(s.content, /root cause: migration 0042 dropped the orders_customer_id_idx index\n {4}fixed by: dbctl create-index/);
    assert.match(s.content, /alerts ShopOrdersLatencyHigh/);
    assert.match(s.content, /Evidence id: ev-/);
    // A new incident: its root cause cites ids. Made-up ones fail the gate; recorded ones pass.
    await inc({ action: 'open', title: 'Orders slow again', services: ['shop-api'] });
    const id2 = (await inc({ action: 'list' })).content.split('\n').find((l: string) => /Orders slow again/.test(l))!.split(' ')[0];
    await inc({ action: 'update', id: id2, note: 'Root cause: the index is missing again [ev-111111] [ev-222222]', kind: 'note' });
    let g = await runGates(h.registry, new LocalHost(ws), ['rca-evidence'], new AbortController().signal);
    assert.equal(g[0]!.pass, false);
    assert.match(g[0]!.details!, /unknown evidence id\(s\) ev-111111, ev-222222/);
    await tool('similar_incidents').run({ text: 'certificate expired', services: ['shop-api'] }, ctx);
    const ledger = await mem.readEvidence({ dataDir: path.join(dataDir, 'plugin-data', 'aiops'), workspacePath: async (_h: unknown, rel: string) => path.join(ws, rel) }, new LocalHost(ws));
    assert.equal(ledger.length, 2);
    await inc({ action: 'update', id: id2, note: `Root cause: the index is missing again [${ledger[0].id}] [${ledger.at(-1).id}]`, kind: 'note' });
    g = await runGates(h.registry, new LocalHost(ws), ['rca-evidence'], new AbortController().signal);
    assert.equal(g[0]!.pass, true, g[0]!.details ?? '');
    assert.match(g[0]!.summary, /cites 2 recorded evidence id\(s\)/);
  } finally { await h.close(); }
});

// ---------------- workflows ----------------

test('incident-response and ops-advisor: valid, runbook-safe, every tool they name optional is guarded, and the refuter loop is bounded', async () => {
  const dir = path.join(PLUGIN, 'workflows');
  for (const n of (await fs.readdir(dir)).filter((x) => x.endsWith('.json'))) {
    const w = JSON.parse(await fs.readFile(path.join(dir, n), 'utf8'));
    assert.deepEqual(validateWorkflow(w), [], n);
    assert.deepEqual(runbooks.checkWorkflowSafety(w).errors, [], n);
  }
  const ir = JSON.parse(await fs.readFile(path.join(dir, 'incident-response.json'), 'utf8'));
  // Tools other packs add (and this pack's optional ones) are used only where the step says "if available" for them.
  const prompts = Object.entries(ir.nodes).map(([id, n]) => [id, String((n as { prompt?: string; message?: string }).prompt ?? '')] as const);
  for (const t of ['change_timeline', 'k8s_health', 'k8s_events', 'k8s_logs', 'k8s_describe', 'alerts', 'anomalies', 'topology', 'traces', 'grafana', 'similar_incidents']) {
    // "alerts" is also a plain word ("until the alerts clear"): the tool is "the alerts tool".
    const word = t === 'alerts' ? /the alerts tool/ : new RegExp(`(^|[^a-z_])${t}([^a-z_]|$)`);
    const using = prompts.filter(([, p]) => word.test(p));
    assert.ok(using.length, `${t} is used`);
    for (const [id, p] of using) assert.ok(p.split(/(?<=[.;])\s|\n/).some((s) => word.test(s) && /available|this session has/.test(s)), `${id}: ${t} is used without an "if available" guard`);
  }
  assert.equal(ir.nodes.refute.agent, 'refuter');
  assert.deepEqual(ir.nodes.refute.decide, ['SURVIVES', 'REJECTED']);
  assert.equal(ir.nodes['refuted-again'].when, 'state.refutations >= 2');
  assert.deepEqual(ir.nodes['rca-cited'].gates, ['rca-evidence']);
  const adv = JSON.stringify(JSON.parse(await fs.readFile(path.join(dir, 'ops-advisor.json'), 'utf8')));
  for (const t of ['topology spof', 'grafana coverage', 'anomalies']) assert.ok(adv.includes(t), t);
});

function stubHost(answer: (label: string, n: number) => string, gates: (names: string[]) => boolean = () => true) {
  const labels: string[] = []; const approvals: string[] = [];
  const counts = new Map<string, number>();
  const host: WorkflowHost = {
    host: async () => new LocalHost(await tempDir()),
    runAgent: async (a) => { labels.push(a.label); const n = (counts.get(a.label) ?? 0) + 1; counts.set(a.label, n); return { report: answer(a.label, n), reason: 'done', cost: 0 }; },
    runGates: async (names) => (Array.isArray(names) ? names : ['applicable']).map((name) => ({ name, pass: gates(Array.isArray(names) ? names : []), summary: 'ok' })),
    approve: async (a) => { approvals.push(a.message); return { approved: !/not confirmed|no root cause has survived/.test(a.message) }; },
    emit: () => {}, save: async (_r: RunRecord) => {},
  };
  return { host, labels, approvals };
}
const json = (o: unknown, word = '') => `Done.\n\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\`\n${word}`;
const RCA = json({ root_cause: 'index missing [ev-aaaaaa] [ev-bbbbbb]', remediation_needed: true, confidence: 'medium: metrics and logs agree', evidence_ids: ['ev-aaaaaa', 'ev-bbbbbb'] });

test('incident-response routes: a root cause the refuter rejects goes back to the hypotheses; one that survives is remediated; two rejections stop at a person who can hand it over', async () => {
  const h = await createHarness({ dataDir: await tempDir(), plugins: [PLUGIN], search: null, memory: 'off', scheduler: false });
  const wf = h.registry.workflows.get('incident-response')!;
  await h.close();
  const base = (label: string) => ({ triage: json({ incident: 'inc-1', services: ['shop-api'] }), 'test-hypotheses': json({ hypotheses: ['index missing: confirmed [ev-aaaaaa]'] }), rca: RCA } as Record<string, string>)[label] ?? 'Done.';
  // Rejected once, then survives.
  const once = stubHost((l, n) => (l === 'refute' ? (n === 1 ? 'Timing: the latency rose 10 min before the migration [ev-cccccc].\nREJECTED' : 'All consistent.\nSURVIVES') : base(l)));
  const r1 = await new WorkflowRunner(wf, once.host, newRun(wf, 's', { symptom: 'orders slow', service: 'shop-api' })).execute(new AbortController().signal);
  assert.equal(r1.status, 'succeeded', JSON.stringify(r1.history.map((x) => `${x.node}:${x.outcome ?? ''}`)));
  const seq = once.labels.filter((l) => ['test-hypotheses', 'rca', 'refute', 'runbook', 'execute', 'postmortem'].includes(l));
  assert.deepEqual(seq, ['test-hypotheses', 'rca', 'refute', 'test-hypotheses', 'rca', 'refute', 'runbook', 'execute', 'postmortem']);
  assert.match(once.approvals[0]!, /Confidence: medium: metrics and logs agree/);
  assert.match(once.approvals[0]!, /Refuter: All consistent/);
  for (const b of ['evidence-metrics', 'evidence-logs', 'evidence-changes', 'evidence-hosts', 'evidence-traces', 'evidence-k8s']) assert.ok(once.labels.includes(b), b);
  // Rejected twice: a person decides; rejecting hands the incident over unresolved.
  const twice = stubHost((l) => (l === 'refute' ? 'Scope: billing is slow too, which the index cannot explain.\nREJECTED' : base(l)));
  const r2 = await new WorkflowRunner(wf, twice.host, newRun(wf, 's', { symptom: 'orders slow' })).execute(new AbortController().signal);
  assert.equal(r2.status, 'failed');
  assert.equal(twice.labels.filter((l) => l === 'refute').length, 2);
  assert.match(twice.approvals[0]!, /rejected the root cause 2 time\(s\)/);
  assert.equal(twice.labels.at(-1), 'postmortem-unresolved');
  assert.ok(!twice.labels.includes('execute'), 'nothing changed');
  // A refuter that gives no verdict has not let it through.
  const silent = stubHost((l) => (l === 'refute' ? 'I looked around.' : base(l)));
  const r3 = await new WorkflowRunner(wf, silent.host, newRun(wf, 's', { symptom: 'x' })).execute(new AbortController().signal);
  assert.ok(!silent.labels.includes('execute'));
  assert.equal(r3.status, 'failed');
  // A root cause whose citations fail the gate twice still goes to the refuter (it reads the gate's verdict).
  const cites = stubHost((l) => (l === 'refute' ? 'SURVIVES' : base(l)), (names) => names[0] !== 'rca-evidence');
  await new WorkflowRunner(wf, cites.host, newRun(wf, 's', { symptom: 'x' })).execute(new AbortController().signal);
  assert.deepEqual(cites.labels.filter((l) => ['rca', 'refute'].includes(l)), ['rca', 'rca', 'refute']);
});

// ---------------- dry runs in a real session, with a scripted model ----------------

type Reply = { text?: string; calls?: { name: string; input: Record<string, unknown> }[] };
type Script = (step: number, brief: string, last: string, tools: Set<string>) => Reply;
const text = (m: Message) => m.content.map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? (typeof b.content === 'string' ? b.content : JSON.stringify(b.content)) : '')).join('\n');
class ScriptedModel implements Provider {
  calls = 0; toolsSeen = new Map<string, Set<string>>();
  private scripts: [RegExp, Script][];
  constructor(scripts: [RegExp, Script][]) { this.scripts = scripts; }
  async send(req: ProviderRequest): Promise<ProviderResponse> {
    this.calls++;
    const brief = req.messages.filter((m) => m.role === 'user').map((m) => m.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n')).join('\n');
    const step = req.messages.filter((m) => m.role === 'assistant').length;
    const last = req.messages.length ? text(req.messages.at(-1)!) : '';
    const tools = new Set((req.tools ?? []).map((t: { name: string }) => t.name));
    const s = this.scripts.find(([re]) => re.test(brief));
    if (s) this.toolsSeen.set(String(s[0]), tools);
    const r: Reply = s ? s[1](step, brief, last, tools) : { text: 'Nothing to do.\n```json\n{}\n```' };
    const content = [...(r.text ? [{ type: 'text' as const, text: r.text }] : []), ...(r.calls ?? []).map((c, i) => ({ type: 'tool_use' as const, id: `c${this.calls}_${i}`, name: c.name, input: c.input }))];
    return { message: { role: 'assistant', content, raw: { provider: 'deepseek', model: req.model.id, payload: {} } }, stop: r.calls?.length ? 'tool_use' : 'end', usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 20, reasoning: 0 } };
  }
}
const ids = (s: string) => [...new Set(s.match(/ev-[0-9a-f]{6}/g) ?? [])];
const seq = (...rs: Reply[]): Script => (step) => rs[Math.min(step, rs.length - 1)]!;

function incidentScripts(refuterVerdicts: string[]): [RegExp, Script][] {
  let refuterRuns = 0;
  return [
    [/Triage this incident/, (step, _b, last, tools) => {
      const plan: Reply[] = [{ calls: [{ name: 'ops_check', input: {} }] }];
      if (tools.has('similar_incidents')) plan.push({ calls: [{ name: 'similar_incidents', input: { text: 'orders slow', services: ['shop-api'], alerts: ['OrdersSlow'] } }] });
      plan.push({ calls: [{ name: 'incident', input: { action: 'open', title: 'Orders slow', severity: 'sev2', services: ['shop-api'] } }] });
      if (step < plan.length) return plan[step]!;
      return { text: json({ incident: /Opened (inc-[a-z0-9-]+)/.exec(last)?.[1] ?? 'missing', services: ['shop-api'] }) };
    }],
    [/Gather METRICS/, (step, _b, last, tools) => {
      const plan: Reply[] = [{ calls: [{ name: 'prometheus_query', input: { query: 'sum(rate(orders_requests_total[5m]))' } }] }];
      if (tools.has('anomalies')) plan.push({ calls: [{ name: 'anomalies', input: { query: 'sum(rate(orders_requests_total[5m]))', seasons: 2 } }] });
      return step < plan.length ? plan[step]! : { text: `Requests up 80 over the daily baseline ${ids(last).map((i) => `[${i}]`).join(' ')}` };
    }],
    [/Gather TRACE and DEPENDENCY/, (step, _b, _l, tools) => (tools.has('topology') && step === 0 ? { calls: [{ name: 'topology', input: { action: 'dependencies', service: 'shop-api' } }] } : { text: tools.has('topology') ? 'shop-api depends on db-1.' : 'No trace or topology tools in this session' })],
    [/Form 2-4 hypotheses/, seq({ calls: [{ name: 'prometheus_query', input: { query: 'up' } }] }, { text: json({ hypotheses: ['load surge: confirmed by the request rate'] }) })],
    [/Decide the root cause/, (step, brief, last) => {
      const inc = /Incident (inc-[a-z0-9-]+)/.exec(brief)![1]!;
      if (step === 0) return { calls: [{ name: 'evidence', input: { action: 'list', limit: 20 } }] };
      if (step === 1) { const cited = ids(last).slice(0, 3).map((i) => `[${i}]`).join(' '); return { calls: [{ name: 'incident', input: { action: 'update', id: inc, status: 'identified', kind: 'note', note: `Root cause: a load surge from a retry storm ${cited}` } }] }; }
      return { text: json({ root_cause: 'a load surge from a retry storm', remediation_needed: false, confidence: 'medium: metrics only', evidence_ids: ['see the incident note'] }) };
    }],
    [/Try to FALSIFY/, (step) => {
      if (step === 0) { refuterRuns++; return { calls: [{ name: 'prometheus_query', input: { query: 'sum(rate(orders_requests_total[5m] offset 1d))' } }] }; }
      return { text: `Checked the same hour yesterday.\n\n${refuterVerdicts[Math.min(refuterRuns - 1, refuterVerdicts.length - 1)]}` };
    }],
    [/is mitigated/, (step, brief) => {
      const inc = /Incident (inc-[a-z0-9-]+)/.exec(brief)![1]!;
      return [{ calls: [{ name: 'incident', input: { action: 'resolve', id: inc, root_cause: 'a load surge from a retry storm', resolution: 'recovered on its own' } }] }, { calls: [{ name: 'incident', input: { action: 'postmortem', id: inc, summary: 'A retry storm.', evidence: ['see the ledger'] } }] }, { text: 'Root cause: a load surge.' }][Math.min(step, 2)]!;
    }],
  ];
}

async function dryRunIncident(model: ScriptedModel, disableTools: string[] = []) {
  const p = await cyclePrometheus();
  const root = await tempDir();
  const fixtures = path.join(root, 'fixtures');
  await fs.mkdir(path.join(fixtures, '.harness', 'ops', 'incidents', 'inc-20260901-orders-slow'), { recursive: true });
  await fs.writeFile(path.join(fixtures, '.harness', 'ops', 'inventory.json'), JSON.stringify({ monitoring: { prometheus: p.url }, hosts: [{ name: 'db-1', address: '10.0.0.5' }], services: [{ name: 'shop-api', metrics_job: 'orders', depends_on: ['db-1'] }], alerts: [{ name: 'OrdersSlow', service: 'shop-api', expr: 'sum(rate(orders_requests_total[5m])) > 1000', severity: 'warning' }] }));
  await fs.writeFile(path.join(fixtures, '.harness', 'ops', 'incidents', 'inc-20260901-orders-slow', 'incident.json'), JSON.stringify({ id: 'inc-20260901-orders-slow', title: 'Orders slow', status: 'resolved', severity: 'sev2', services: ['shop-api'], openedAt: '2026-09-01T10:00:00Z', resolvedAt: '2026-09-01T11:00:00Z', rootCause: 'a retry storm from the mobile app', resolution: 'rate limited the client', timeline: [{ at: '2026-09-01T10:00:00Z', kind: 'detection', text: 'OrdersSlow fired' }] }));
  const c: EvalCase = { name: 'incident-dry', dir: root, pack: 'p1', workflow: 'incident-response', input: { symptom: 'OrdersSlow fires: orders are slow', service: 'shop-api' }, fixtures: 'fixtures', timeoutMin: 10, checks: [{ name: 'inventory', gates: ['inventory-valid'] }] };
  try {
    return await runOne(c, 'deepseek-flash', 1, await tempDir(), { plugins: [PLUGIN], setup: (hh) => { hh.registry.setProviderInstance('deepseek', model); for (const t of disableTools) hh.registry.tools.delete(t); } });
  } finally { await p.close(); }
}

test('incident-response dry run (scripted model): with the optional tools, similar incidents at triage, anomalies and topology as evidence, a cited root cause that passes the gate, refuted once then surviving, a postmortem', { timeout: 300_000 }, async () => {
  const model = new ScriptedModel(incidentScripts(['REJECTED', 'SURVIVES']));
  const r = await dryRunIncident(model);
  assert.equal(r.status, 'succeeded', `${r.error ?? ''} ${JSON.stringify(r.checks)}`);
  const ws = r.workspace;
  const incDir = (await fs.readdir(path.join(ws, '.harness', 'ops', 'incidents'))).find((n) => n !== 'inc-20260901-orders-slow')!;
  const inc = JSON.parse(await fs.readFile(path.join(ws, '.harness', 'ops', 'incidents', incDir, 'incident.json'), 'utf8'));
  assert.equal(inc.status, 'resolved');
  const notes = inc.timeline.map((e: { text: string }) => e.text).join('\n');
  assert.match(notes, /Root cause: a load surge from a retry storm \[ev-[0-9a-f]{6}\]/);
  const ledger = (await fs.readFile(path.join(ws, '.harness', 'ops', 'evidence.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const tools = new Set(ledger.map((e: { tool: string }) => e.tool));
  for (const t of ['similar_incidents', 'anomalies', 'topology', 'prometheus_query', 'ops_check']) assert.ok(tools.has(t), `${t} recorded as evidence (${[...tools].join(', ')})`);
  assert.match(ledger.find((e: { tool: string }) => e.tool === 'similar_incidents').excerpt, /inc-20260901-orders-slow/);
  await fs.access(path.join(ws, '.harness', 'ops', 'incidents', incDir, 'postmortem.md'));
  // The sre agent had the P1 tools; the refuter ran twice (rejected, then survived).
  assert.ok(model.toolsSeen.get(String(/Gather METRICS/))!.has('anomalies'));
});

test('incident-response dry run (scripted model) without the optional tools: the steps that would use them say so and the run still resolves', { timeout: 300_000 }, async () => {
  const model = new ScriptedModel(incidentScripts(['SURVIVES']));
  const r = await dryRunIncident(model, ['anomalies', 'topology', 'traces', 'grafana', 'similar_incidents']);
  assert.equal(r.status, 'succeeded', `${r.error ?? ''}`);
  const ledger = (await fs.readFile(path.join(r.workspace, '.harness', 'ops', 'evidence.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(!ledger.some((e: { tool: string }) => ['anomalies', 'topology', 'similar_incidents'].includes(e.tool)));
  assert.ok(!model.toolsSeen.get(String(/Gather METRICS/))!.has('anomalies'));
});

test('ops-advisor dry run (scripted model): the survey and reliability steps use topology, grafana coverage and anomalies when present', { timeout: 300_000 }, async () => {
  const p = await cyclePrometheus();
  const root = await tempDir();
  const fixtures = path.join(root, 'fixtures');
  await fs.mkdir(path.join(fixtures, '.harness', 'ops'), { recursive: true });
  await fs.writeFile(path.join(fixtures, '.harness', 'ops', 'inventory.json'), JSON.stringify({ monitoring: { prometheus: p.url }, hosts: [{ name: 'app-1', address: '10.0.0.2' }], services: [{ name: 'web', metrics_job: 'web', host: 'app-1', depends_on: ['orders'] }, { name: 'orders', metrics_job: 'orders', host: 'app-1' }] }));
  const model = new ScriptedModel([
    [/Survey the estate/, (step, _b, _l, tools) => [{ calls: [{ name: 'ops_inventory', input: { action: 'list' } }] }, ...(tools.has('topology') ? [{ calls: [{ name: 'topology', input: { action: 'graph' } }] }] : [])][step] ?? { text: json({ estate: 'web and orders on app-1' }) }],
    [/Analyse RELIABILITY/, (step, _b, last, tools) => {
      const plan: Reply[] = tools.has('topology') ? [{ calls: [{ name: 'topology', input: { action: 'spof' } }] }, { calls: [{ name: 'anomalies', input: { service: 'orders', seasons: 2 } }] }] : [];
      if (step < plan.length) return plan[step]!;
      if (step === plan.length) return { calls: [{ name: 'write', input: { path: '.harness/ops/reports/advisor/reliability.md', content: `## Two services share app-1\nPriority: P2\nEvidence: ${last.slice(0, 2000)}\n` } }] };
      return { text: 'P2 Two services share app-1' };
    }],
    [/Merge the four analyses/, seq({ calls: [{ name: 'read', input: { path: '.harness/ops/reports/advisor/reliability.md' } }] }, { calls: [{ name: 'write', input: { path: '.harness/ops/reports/ops-advisor.md', content: '# Ops advisor\nsee reliability' } }] }, { text: 'Written.' })],
  ]);
  const c: EvalCase = { name: 'advisor-dry', dir: root, pack: 'p1', workflow: 'ops-advisor', input: {}, fixtures: 'fixtures', timeoutMin: 10, checks: [{ name: 'inventory', gates: ['inventory-valid'] }] };
  try {
    const r = await runOne(c, 'deepseek-flash', 1, await tempDir(), { plugins: [PLUGIN], setup: (hh) => hh.registry.setProviderInstance('deepseek', model) });
    assert.equal(r.status, 'succeeded', r.error ?? '');
    const rel = await fs.readFile(path.join(r.workspace, '.harness', 'ops', 'reports', 'advisor', 'reliability.md'), 'utf8');
    assert.match(rel, /finding\(s\), \d+ strong/, 'the anomalies result is the evidence');
    const ledger = await fs.readFile(path.join(r.workspace, '.harness', 'ops', 'evidence.jsonl'), 'utf8');
    assert.match(ledger, /"tool":"topology"/);
    assert.match(ledger, /single point/);
  } finally { await p.close(); }
});
