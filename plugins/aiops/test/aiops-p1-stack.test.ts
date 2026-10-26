// aiops P1 against real services, in containers this test starts and removes
// (all named hwtest-p1-*, on their own network and 127.0.0.1 ports 193xx/194xx):
// Prometheus (remote-write receiver on), Grafana 11 (a Prometheus data source,
// a dashboard, a Grafana-managed alert rule, Viewer and Editor service-account
// tokens made through its API), Grafana Tempo (OTLP in, its metrics generator
// writing the service graph into that Prometheus) and Jaeger all-in-one. A small
// generator sends OTLP traces (frontend -> orders -> payments, some failing).
// Skipped without Docker or the images (HARNESS_TEST_AIOPS_P1_STACK=1 pulls them; =0 skips).
// HARNESS_TEST_AIOPS_P1_GRAFANA_IMAGE runs it against another Grafana (e.g. grafana/grafana:12.x).

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHarness, type Harness } from '@harness/core/src/kernel/harness.ts';
import { dockerAvailable, imageExists } from '@harness/core/src/runtime/docker.ts';
import { LocalHost } from '@harness/core/src/runtime/host.ts';
import type { ToolContext } from '@harness/core/src/tools/types.ts';
import { tempDir } from '@harness/core/test/helpers.ts';
import { HARNESS_ROOT } from '@harness/plugin-sdk/runtime';
// @ts-expect-error plain JS
const { runProgram } = await import('../lib/proc.mjs');

const here = path.join(HARNESS_ROOT, 'test');
const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(pluginDir);
const IMAGES = { prom: 'prom/prometheus:v2.54.1', grafana: process.env.HARNESS_TEST_AIOPS_P1_GRAFANA_IMAGE || 'grafana/grafana:11.2.0', tempo: 'grafana/tempo:2.6.1', jaeger: 'jaegertracing/all-in-one:1.62.0' };
const want = process.env.HARNESS_TEST_AIOPS_P1_STACK;
const run = want !== '0' && (await dockerAvailable()) && (want === '1' || (await Promise.all(Object.values(IMAGES).map(imageExists))).every(Boolean));
const skip = run ? false : 'needs Docker and the images (HARNESS_TEST_AIOPS_P1_STACK=1 pulls them)';
const NET = 'hwtest-p1-net';
const NAMES = ['hwtest-p1-grafana', 'hwtest-p1-tempo', 'hwtest-p1-jaeger', 'hwtest-p1-prom'];
const PORTS = { prom: 19390, grafana: 19300, tempo: 19320, tempoOtlp: 19318, jaeger: 19686, jaegerOtlp: 19418 };
const URL_ = { prom: `http://127.0.0.1:${PORTS.prom}`, grafana: `http://127.0.0.1:${PORTS.grafana}`, tempo: `http://127.0.0.1:${PORTS.tempo}`, jaeger: `http://127.0.0.1:${PORTS.jaeger}` };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const docker = (args: string[], timeoutMs = 120_000) => runProgram('docker', args, { timeoutMs });

const TEMPO_CONFIG = `stream_over_http_enabled: true
server:
  http_listen_port: 3200
  log_level: warn
distributor:
  receivers:
    otlp:
      protocols:
        http:
          endpoint: "0.0.0.0:4318"
ingester:
  max_block_duration: 5m
metrics_generator:
  registry:
    external_labels:
      source: tempo
    collection_interval: 5s
  storage:
    path: /var/tempo/generator/wal
    remote_write:
      - url: http://hwtest-p1-prom:9090/api/v1/write
  processor:
    service_graphs:
      wait: 5s
storage:
  trace:
    backend: local
    wal:
      path: /var/tempo/wal
    local:
      path: /var/tempo/blocks
overrides:
  defaults:
    metrics_generator:
      processors: [service-graphs]
`;

let h: Harness;
let ws: string;
let opFile: string;
let adminPw: string;
const secrets: Record<string, string> = {};
const vault = { async list() { return Object.keys(secrets).map((name) => ({ name, kind: 'password', scope: 'server', updatedAt: new Date().toISOString(), backend: 'test' })); }, async reveal(n: string) { if (!secrets[n]) throw new Error(`no vault entry named ${n}`); return secrets[n]!; }, async envFor() { return {}; } };
const ctx = () => ({ host: new LocalHost(ws), signal: new AbortController().signal, readFiles: new Map(), todos: [], setTodos() {}, emit() {}, services: { vault } }) as unknown as ToolContext;
const call = (name: string, input: Record<string, unknown>) => h.registry.tools.get(name)!.run(input, ctx());
const envBefore = process.env.HARNESS_OPS_INVENTORY;

async function waitFor<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 120_000): Promise<T> {
  const end = Date.now() + ms; let last: unknown;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await sleep(2000); }
  throw new Error(`timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ''}`);
}
const admin = () => `Basic ${Buffer.from(`admin:${adminPw}`).toString('base64')}`;
async function gapi(method: string, p: string, body?: unknown, auth = admin()) {
  const r = await fetch(`${URL_.grafana}${p}`, { method, headers: { authorization: auth, 'content-type': 'application/json', accept: 'application/json', 'x-disable-provenance': 'true' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : {};
}

// ---------------- traces: a small OTLP generator ----------------

const hex = (n: number) => randomBytes(n).toString('hex');
const ns = (ms: number) => String(BigInt(Math.round(ms)) * 1_000_000n);
const attr = (k: string, v: string | number) => ({ key: k, value: typeof v === 'number' ? { intValue: String(v) } : { stringValue: v } });
/** One trace: frontend GET /checkout -> (client) -> orders POST /orders -> SELECT -> (client) -> payments POST /charge; failing ones error in payments. */
function makeTrace(start: number, { fail, slow }: { fail: boolean; slow: boolean }) {
  const traceId = hex(16);
  const s = { root: hex(8), feClient: hex(8), orders: hex(8), db: hex(8), ordClient: hex(8), pay: hex(8) };
  const payMs = slow ? 900 : 60;
  const t = (o: number) => start + o;
  const span = (id: string, parent: string, name: string, kind: number, a: number, b: number, extra: Record<string, unknown> = {}) => ({ traceId, spanId: id, ...(parent ? { parentSpanId: parent } : {}), name, kind, startTimeUnixNano: ns(t(a)), endTimeUnixNano: ns(t(b)), ...extra });
  const rs = (svc: string, spans: unknown[]) => ({ resource: { attributes: [attr('service.name', svc)] }, scopeSpans: [{ scope: { name: 'hwtest-p1' }, spans }] });
  const end = 40 + payMs + 20;
  return {
    traceId,
    body: { resourceSpans: [
      rs('frontend', [span(s.root, '', 'GET /checkout', 2, 0, end + 10, { attributes: [attr('http.response.status_code', fail ? 502 : 200)], ...(fail ? { status: { code: 2, message: 'upstream failed' } } : {}) }), span(s.feClient, s.root, 'POST orders', 3, 2, end + 5)]),
      rs('orders', [span(s.orders, s.feClient, 'POST /orders', 2, 4, end), span(s.db, s.orders, 'SELECT orders', 3, 6, 30, { attributes: [attr('db.statement', 'SELECT * FROM orders WHERE customer_id = ?')] }), span(s.ordClient, s.orders, 'POST payments', 3, 32, 32 + payMs + 6)]),
      rs('payments', [span(s.pay, s.ordClient, 'POST /charge', 2, 34, 34 + payMs, fail ? { status: { code: 2, message: 'card processor timeout' } } : {})]),
    ] },
  };
}
const sent: { traceId: string; fail: boolean; slow: boolean }[] = [];
async function sendTraces(n: number) {
  const now = Date.now() - 5000;
  for (let i = 0; i < n; i++) {
    const fail = i % 4 === 0; const slow = i % 5 === 0;
    const tr = makeTrace(now - (n - i) * 200, { fail, slow });
    for (const port of [PORTS.tempoOtlp, PORTS.jaegerOtlp]) {
      const r = await fetch(`http://127.0.0.1:${port}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(tr.body) });
      assert.ok(r.ok, `OTLP to ${port}: ${r.status} ${await r.text()}`);
    }
    sent.push({ traceId: tr.traceId, fail, slow });
  }
}

before(async () => {
  if (skip) return;
  if (want === '1') for (const img of Object.values(IMAGES)) await docker(['pull', img], 600_000);
  for (const n of NAMES) await docker(['rm', '-f', n]);
  await docker(['network', 'rm', NET]);
  assert.equal((await docker(['network', 'create', NET])).code, 0);
  adminPw = hex(12);
  const dir = await tempDir('hwtest-p1-');
  await fs.writeFile(path.join(dir, 'tempo.yaml'), TEMPO_CONFIG);
  const common = ['run', '-d', '--network', NET, '--label', 'hwtest=p1'];
  const started = await Promise.all([
    docker([...common, '--name', 'hwtest-p1-prom', '-p', `127.0.0.1:${PORTS.prom}:9090`, IMAGES.prom, '--config.file=/etc/prometheus/prometheus.yml', '--storage.tsdb.path=/prometheus', '--web.enable-remote-write-receiver']),
    docker([...common, '--name', 'hwtest-p1-tempo', '-u', '0', '-v', `${path.join(dir, 'tempo.yaml')}:/etc/tempo.yaml:ro`, '-p', `127.0.0.1:${PORTS.tempo}:3200`, '-p', `127.0.0.1:${PORTS.tempoOtlp}:4318`, IMAGES.tempo, '-config.file=/etc/tempo.yaml']),
    docker([...common, '--name', 'hwtest-p1-jaeger', '-e', 'COLLECTOR_OTLP_ENABLED=true', '-p', `127.0.0.1:${PORTS.jaeger}:16686`, '-p', `127.0.0.1:${PORTS.jaegerOtlp}:4318`, IMAGES.jaeger]),
    docker([...common, '--name', 'hwtest-p1-grafana', '-e', `GF_SECURITY_ADMIN_PASSWORD=${adminPw}`, '-e', 'GF_ANALYTICS_REPORTING_ENABLED=false', '-e', 'GF_ANALYTICS_CHECK_FOR_UPDATES=false', '-p', `127.0.0.1:${PORTS.grafana}:3000`, IMAGES.grafana]),
  ]);
  for (const s of started) assert.equal(s.code, 0, s.stderr);
  await waitFor('Prometheus', async () => (await fetch(`${URL_.prom}/-/ready`)).ok);
  await waitFor('Grafana', async () => (await fetch(`${URL_.grafana}/api/health`)).ok && (await gapi('GET', '/api/org')).id);
  await waitFor('Tempo', async () => (await fetch(`${URL_.tempo}/ready`)).ok, 180_000);
  await waitFor('Jaeger', async () => (await fetch(`${URL_.jaeger}/api/services`)).ok);
  // Grafana: a Prometheus data source, a folder, a dashboard, an always-firing Grafana-managed rule, two service accounts.
  await gapi('POST', '/api/datasources', { name: 'Prometheus', uid: 'hwprom', type: 'prometheus', access: 'proxy', url: 'http://hwtest-p1-prom:9090', isDefault: true });
  const folder = await gapi('POST', '/api/folders', { uid: 'hwp1', title: 'HW P1' });
  await gapi('POST', '/api/dashboards/db', { folderUid: folder.uid, overwrite: true, dashboard: {
    uid: 'hw-p1', title: 'HW P1 Prometheus', tags: ['hwtest', 'prometheus'], schemaVersion: 39,
    templating: { list: [{ name: 'job', type: 'custom', query: 'prometheus', current: { text: 'prometheus', value: 'prometheus' }, options: [{ text: 'prometheus', value: 'prometheus', selected: true }] }] },
    panels: [
      { id: 1, type: 'timeseries', title: 'Up', gridPos: { x: 0, y: 0, w: 12, h: 8 }, datasource: { type: 'prometheus', uid: 'hwprom' }, targets: [{ refId: 'A', expr: 'up{job="$job"}' }] },
      { id: 2, type: 'timeseries', title: 'HTTP requests', gridPos: { x: 12, y: 0, w: 12, h: 8 }, datasource: { type: 'prometheus', uid: 'hwprom' }, targets: [{ refId: 'A', expr: 'sum(rate(prometheus_http_requests_total{job="$job"}[$__rate_interval]))' }] },
    ],
  } });
  const rule = { title: 'P1AlwaysFiring', condition: 'C', noDataState: 'OK', execErrState: 'Error', for: '0s', folderUID: folder.uid, ruleGroup: 'hw', orgID: 1, labels: { service: 'prometheus' }, annotations: { summary: 'always firing (test)' },
    data: [
      { refId: 'A', relativeTimeRange: { from: 600, to: 0 }, datasourceUid: 'hwprom', model: { refId: 'A', expr: 'vector(1)', instant: true, intervalMs: 1000, maxDataPoints: 43200 } },
      { refId: 'C', datasourceUid: '__expr__', model: { refId: 'C', type: 'threshold', expression: 'A', conditions: [{ evaluator: { type: 'gt', params: [0] } }] } },
    ] };
  await gapi('PUT', `/api/v1/provisioning/folder/${folder.uid}/rule-groups/hw`, { title: 'hw', interval: 10, rules: [rule] });
  for (const [role, name] of [['Viewer', 'ops-grafana-viewer'], ['Editor', 'ops-grafana-editor']] as const) {
    const sa = await gapi('POST', '/api/serviceaccounts', { name: `hwtest-${role.toLowerCase()}`, role });
    secrets[name] = (await gapi('POST', `/api/serviceaccounts/${sa.id}/tokens`, { name: `hwtest-${role.toLowerCase()}-token` })).key;
  }
  await sendTraces(24);
  ws = await tempDir();
  await fs.mkdir(path.join(ws, '.harness', 'ops'), { recursive: true });
  await fs.writeFile(path.join(ws, '.harness', 'ops', 'inventory.json'), JSON.stringify({ services: [{ name: 'prometheus', metrics_job: 'prometheus' }, { name: 'orders', depends_on: ['payments'] }, { name: 'payments' }, { name: 'billing-worker' }] }));
  opFile = path.join(ws, 'operator-inventory.json');
  await writeOperator('ops-grafana-viewer');
  h = await createHarness({ dataDir: await tempDir(), plugins: [PLUGIN], search: null, memory: 'off', scheduler: false });
}, { timeout: 900_000 });

async function writeOperator(grafanaCred: string) {
  await fs.writeFile(opFile, JSON.stringify({ monitoring: { prometheus: URL_.prom, grafana: { url: URL_.grafana, credential: grafanaCred, datasource: 'hwprom' }, tempo: URL_.tempo, jaeger: URL_.jaeger }, hosts: [] }));
  process.env.HARNESS_OPS_INVENTORY = opFile;
}

after(async () => {
  if (skip) return;
  if (envBefore === undefined) delete process.env.HARNESS_OPS_INVENTORY; else process.env.HARNESS_OPS_INVENTORY = envBefore;
  await h?.close();
  for (const n of NAMES) await docker(['rm', '-f', n]);
  await docker(['network', 'rm', NET]);
});

test('Grafana 11/12 (real): dashboards, a dashboard\'s panels, a PromQL panel run through Grafana, Grafana-managed alert rules with their state, deep links', { skip, timeout: 300_000 }, async () => {
  await writeOperator('ops-grafana-viewer');
  const list = await call('grafana', { action: 'dashboards', query: 'HW P1' });
  assert.equal(list.is_error, undefined, list.content);
  assert.match(list.content, /HW P1 Prometheus \[uid hw-p1\] folder HW P1 tags hwtest,prometheus/);
  assert.match(list.content, /\(Grafana 1[1-9]\.\d+\.\d+/);
  const d = await call('grafana', { action: 'dashboard', uid: 'hw-p1' });
  assert.match(d.content, /2 panel\(s\); variables: job=prometheus/);
  assert.match(d.content, /panel 2 "HTTP requests" \(timeseries\) datasource prometheus:hwprom\n {4}A: sum\(rate\(prometheus_http_requests_total\{job="\$job"\}\[\$__rate_interval\]\)\)/);
  const p = await waitFor('the up series', async () => { const r = await call('grafana', { action: 'panel', uid: 'hw-p1', panel: 1, from: 'now-5m' }); return /last 1,/.test(r.content) ? r : undefined; }, 90_000);
  assert.match(p.content, /A: up\{job="prometheus"\}/);
  assert.match(p.content, /up\{instance="localhost:9090", job="prometheus"\}: last 1/);
  assert.match(p.content, /Link: http:\/\/127\.0\.0\.1:19300\/d\/hw-p1\?orgId=1&from=\d+&to=\d+&var-job=prometheus&viewPanel=panel-1/);
  assert.match(p.content, /Evidence id: ev-[0-9a-f]{6}/);
  const p2 = await call('grafana', { action: 'panel', uid: 'hw-p1', panel: 2, from: 'now-5m', vars: { job: 'prometheus' } });
  assert.match(p2.content, /A: sum\(rate\(prometheus_http_requests_total\{job="prometheus"\}\[60s\]\)\)/);
  // The rule is evaluated every 10 s: it shows as firing.
  const al = await waitFor('the rule to fire', async () => { const r = await call('grafana', { action: 'alerts' }); return /\[FIRING\] P1AlwaysFiring/.test(r.content) ? r : undefined; }, 120_000);
  assert.match(al.content, /folder HW P1, group hw/);
  assert.match(al.content, /summary: always firing \(test\)/);
  const cov = await call('grafana', { action: 'coverage' });
  assert.match(cov.content, /Services no dashboard mentions \(3\): orders, payments, billing-worker/);
  assert.match(cov.content, /- prometheus: dashboards HW P1 Prometheus; rules P1AlwaysFiring/);
  const link = await call('grafana', { action: 'link', expr: 'up', from: 'now-1h' });
  assert.match(link.content, /^http:\/\/127\.0\.0\.1:19300\/explore\?schemaVersion=1&orgId=1&panes=/);
});

test('Grafana 11/12 (real): the annotation write needs Editor - the Viewer token is refused (403), the Editor token writes it and it reads back', { skip, timeout: 120_000 }, async () => {
  await writeOperator('ops-grafana-viewer');
  const denied = await call('grafana', { action: 'annotate', text: 'hwtest viewer write', tags: ['incident'] });
  assert.equal(denied.is_error, true);
  assert.match(denied.content, /403.*needs Editor/);
  await writeOperator('ops-grafana-editor');
  const start = Date.now() - 10 * 60_000;
  const w = await call('grafana', { action: 'annotate', text: 'inc-hwtest: orders slow (root cause: index missing)', tags: ['incident', 'inc-hwtest'], time: String(start / 1000), time_end: 'now', uid: 'hw-p1' });
  assert.equal(w.is_error, undefined, w.content);
  assert.match(w.content, /Annotation \d+ written/);
  assert.match(w.content, /Link: http:\/\/127\.0\.0\.1:19300\/d\/hw-p1/);
  await writeOperator('ops-grafana-viewer');
  const r = await call('grafana', { action: 'annotations', from: 'now-1h', tags: ['inc-hwtest'] });
  assert.match(r.content, /\[(harness,incident,inc-hwtest|incident,inc-hwtest,harness|[a-z,-]+)\] dashboard hw-p1: inc-hwtest: orders slow/);
  assert.match(r.content, / \.\. /, 'a region (time and end)');
});

test('Tempo (real): TraceQL search for failing orders traces, a trace summarised (critical path to payments, the error); the service-graph metrics reach Prometheus and topology merges them', { skip, timeout: 300_000 }, async () => {
  const failing = sent.filter((x) => x.fail);
  const s = await waitFor('Tempo search', async () => { const r = await call('traces', { action: 'search', service: 'payments', status: 'error', since: '15m' }); return r.content.includes(failing[0]!.traceId) ? r : undefined; }, 120_000);
  assert.match(s.content, /matching \{ resource\.service\.name = "payments" && status = error \}/);
  assert.match(s.content, /frontend GET \/checkout/);
  const slowOne = sent.find((x) => x.slow && x.fail)!;
  const t = await waitFor('the trace by id', async () => { const r = await call('traces', { action: 'trace', id: slowOne.traceId }); return r.is_error ? undefined : r; }, 60_000);
  assert.match(t.content, /6 spans/);
  assert.match(t.content, /Services \(3\): payments 1 spans, self 900 ms, 1 ERROR/);
  assert.match(t.content, /Critical path[^\n]*\n {2}frontend GET \/checkout \(server\)[\s\S]*payments POST \/charge \(server\) 900 ms \(self 900 ms\) ERROR/);
  assert.match(t.content, /payments POST \/charge \(server\): card processor timeout/);
  const slow = await call('traces', { action: 'search', service: 'payments', min_duration: '500ms', since: '15m' });
  assert.ok(sent.filter((x) => x.slow).every((x) => slow.content.includes(x.traceId)), slow.content);
  assert.ok(!sent.filter((x) => !x.slow).some((x) => slow.content.includes(x.traceId)), 'fast traces are not over 500 ms');
  assert.match((await call('traces', { action: 'services' })).content, /frontend, orders, payments/);
  // Tempo's metrics generator writes the service graph into Prometheus; topology reads it.
  await waitFor('service-graph metrics', async () => { const r = await fetch(`${URL_.prom}/api/v1/query?query=${encodeURIComponent('traces_service_graph_request_total')}`).then((x) => x.json()); return r.data?.result?.length >= 2; }, 120_000);
  const topo = await call('topology', { action: 'dependents', service: 'payments', sources: ['inventory', 'traces'] });
  assert.equal(topo.is_error, undefined, topo.content);
  assert.match(topo.content, /orders \(depth 1, via payments\) \[calls,depends_on; inventory,(jaeger,)?tempo-service-graph/);
  assert.match(topo.content, /frontend \(depth 2, via orders\) \[calls; (jaeger,)?tempo-service-graph/);
  const sp = await call('topology', { action: 'mermaid', service: 'orders' });
  assert.match(sp.content, /```mermaid\ngraph LR/);
});

test('Jaeger (real): search with errors and a minimum duration, a trace by id, the services and the dependencies API', { skip, timeout: 180_000 }, async () => {
  const failing = sent.filter((x) => x.fail);
  const s = await waitFor('Jaeger search', async () => { const r = await call('traces', { action: 'search', backend: 'jaeger', service: 'payments', status: 'error', since: '15m', limit: 50 }); return failing.every((f) => r.content.includes(f.traceId)) ? r : undefined; }, 60_000);
  assert.ok(!sent.filter((x) => !x.fail).some((x) => s.content.includes(x.traceId)), 'only failing traces');
  assert.match(s.content, /ERROR span\(s\)\n {4}http:\/\/127\.0\.0\.1:19686\/trace\//);
  const one = await call('traces', { action: 'trace', backend: 'jaeger', id: failing[0]!.traceId });
  assert.match(one.content, /payments POST \/charge \(server\): card processor timeout/);
  assert.match(one.content, /Link: http:\/\/127\.0\.0\.1:19686\/trace\//);
  assert.match((await call('traces', { action: 'services', backend: 'jaeger' })).content, /frontend, (jaeger-all-in-one, )?orders, payments/);
  const deps = await waitFor('Jaeger dependencies', async () => { const r = await call('traces', { action: 'dependencies', backend: 'jaeger', since: '1h' }); return /orders -> payments/.test(r.content) ? r : undefined; }, 60_000);
  assert.match(deps.content, /frontend -> orders: 24 calls/);
});

test('anomalies and topology (real Prometheus): prometheus up/job nodes, and the detectors run on real ranges without inventing findings', { skip, timeout: 120_000 }, async () => {
  const g = await call('topology', { action: 'graph', sources: ['prometheus', 'inventory'] });
  assert.match(g.content, /- prometheus \(service; from inventory,prometheus; 1\/1 up\)/);
  const a = await call('anomalies', { query: 'up{job="prometheus"}', window: '2m', history: '10m', seasons: 0 });
  assert.equal(a.is_error, undefined, a.content);
  assert.match(a.content, /^0 finding\(s\), 0 strong/);
  assert.match(a.content, /up\{instance="localhost:9090", job="prometheus"\}/);
});
