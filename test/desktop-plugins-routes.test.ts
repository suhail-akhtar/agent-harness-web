// The desktop halves of the sdlc ("Engineering") and aiops ("Operations") plugins: their UI
// manifests, the read-only routes their frames call (auth "user"), and the indexes those
// routes serve - built from real sessions, real gates and the plugin's own alert routes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { uiEntries, validateUiManifest } from '../packages/plugin-ui/src/manifest.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { LocalHost } from '../src/runtime/host.ts';
import { createApp } from '../src/server/app.ts';
import { UserStore } from '../src/server/users.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { FakeProvider, tempDir } from './helpers.ts';
// @ts-expect-error plain JS
const gatesLib = await import('../plugins/quality-gates/index.mjs');
// @ts-expect-error plain JS
const delivery = await import('../plugins/sdlc/lib/delivery.mjs');
// @ts-expect-error plain JS
const consoleLib = await import('../plugins/aiops/lib/console.mjs');

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGINS = path.join(here, '..', 'plugins');
const OPERATOR = 'operator-token-for-desktop-plugins';
const until = async (f: () => boolean | Promise<boolean>, ms = 60_000) => {
  const end = Date.now() + ms;
  while (!(await f())) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)); }
};

async function serve(o: { plugins: string[]; env?: Record<string, string>; steps?: ConstructorParameters<typeof FakeProvider>[0] }) {
  const data = await tempDir();
  const work = await tempDir();
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(o.env ?? {})) { saved[k] = process.env[k]; process.env[k] = v; }
  const users = await new UserStore(data).load();
  const harness = await createHarness({ dataDir: data, search: null, plugins: o.plugins });
  const fake = new FakeProvider(o.steps ?? []);
  for (const id of harness.registry.providers.keys()) harness.registry.setProviderInstance(id, fake);
  const { server } = createApp({ harness, token: OPERATOR, loopback: true, localRoots: [work], uiDir: path.join(data, 'ui'), appRoot: data, users });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (token: string | undefined, method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + p, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-harness': '1' } : {}), ...headers }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const text = await res.text();
    let json: unknown; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json as any };
  };
  const close = async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await harness.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  };
  return { harness, users, call, close, data, work, fake, base };
}

test('both UI halves validate as frame plugins (never native), with every entry on disk and every contribution point the journey needs', async () => {
  for (const name of ['sdlc', 'aiops']) {
    const m = JSON.parse(await fs.readFile(path.join(PLUGINS, name, 'harness-plugin.json'), 'utf8'));
    const ui = validateUiManifest(m.ui, { trustCeiling: 'frame' });
    assert.equal(ui.trust, 'frame', `${name} is a frame plugin, the path any third party takes`);
    assert.throws(() => validateUiManifest({ ...m.ui, trust: 'native' }, { trustCeiling: 'frame' }), /signed by a key/);
    for (const e of uiEntries(ui)) await fs.access(path.join(PLUGINS, name, e));
    for (const f of ['ui/kit.js', 'ui/kit.css']) await fs.access(path.join(PLUGINS, name, f));
    const c = ui.contributes;
    assert.ok(c.navItems.length && c.views.length && c.panels.length && c.commands.length && c.slashCommands.length && c.settings.length && c.renderers.length && c.homeCards.length, name);
    assert.ok(c.commands.some((x) => x.agent), `${name} has agent-callable commands`);
    // Frames read their own settings (settings.read): this machine's sections, and the account's (the person's choices that follow them).
    assert.deepEqual(c.settings.map((s) => s.scope).sort(), ['account', 'app'], `${name}: one section on this computer, one with the account`);
  }
  const sdlc = validateUiManifest(JSON.parse(await fs.readFile(path.join(PLUGINS, 'sdlc', 'harness-plugin.json'), 'utf8')).ui);
  assert.deepEqual(sdlc.contributes.slashCommands.map((s) => s.name), ['feature', 'review', 'gates']);
  assert.deepEqual(sdlc.contributes.composerChips.map((s) => s.setting), ['sdlc.targetBranch', 'sdlc.testLevel']);
  const aiops = validateUiManifest(JSON.parse(await fs.readFile(path.join(PLUGINS, 'aiops', 'harness-plugin.json'), 'utf8')).ui);
  assert.deepEqual(aiops.contributes.slashCommands.map((s) => s.name), ['incident', 'investigate', 'ops-check']);
  assert.equal(aiops.contributes.navItems[0]!.badge, 'aiops.open');
  assert.deepEqual(aiops.contributes.views.map((v) => v.id), ['home', 'incidents', 'alerts', 'services', 'topology', 'changes']);
  // Each is a module: a menu (Operations: Incidents, Alerts, Services, Topology, Changes; Engineering: Delivery, Start a feature, Gates), a home, a guide.
  assert.equal(aiops.home, 'home');
  assert.equal(sdlc.home, 'home');
  assert.equal(aiops.menu!.items.length, 5);
  assert.equal(sdlc.menu!.items.length, 3);
  for (const p of ['sdlc', 'aiops']) await fs.access(path.join(PLUGINS, p, 'GUIDE.md'));
  // Role models reach the workflows' agent nodes from their inputs.
  const bf = JSON.parse(await fs.readFile(path.join(PLUGINS, 'sdlc', 'workflows', 'build-feature.json'), 'utf8'));
  assert.equal(bf.nodes['code-review'].model, '{{input.reviewerModel}}');
  const ir = JSON.parse(await fs.readFile(path.join(PLUGINS, 'aiops', 'workflows', 'incident-response.json'), 'utf8'));
  assert.equal(ir.nodes.refute.model, '{{input.refuterModel}}');
  assert.equal(ir.inputs.refuterModel.default, '');
});

test('quality gates report test counts in their summaries, for every runner they support', () => {
  const c = gatesLib.testCounts;
  assert.deepEqual(c('TAP version 13\n# tests 12\n# suites 0\n# pass 11\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n'), { total: 12, passed: 11, failed: 1, skipped: 0 });
  assert.deepEqual(c('Tests:       1 failed, 2 skipped, 11 passed, 14 total\nTime: 1s'), { total: 14, passed: 11, failed: 1, skipped: 2 });
  assert.deepEqual(c(' Test Files  2 passed (2)\n      Tests  9 passed | 1 skipped (10)\n'), { total: 10, passed: 9, failed: 0, skipped: 1 });
  assert.deepEqual(c('..F.\n==== 3 passed, 1 failed in 0.12s ===='), { total: 4, passed: 3, failed: 1, skipped: 0 });
  assert.deepEqual(c('Ran 5 tests in 0.002s\n\nFAILED (failures=1, errors=1)'), { total: 5, passed: 3, failed: 2, skipped: 0 });
  assert.deepEqual(c('  7 passing (20ms)\n  1 failing\n'), { total: 8, passed: 7, failed: 1, skipped: 0 });
  assert.deepEqual(c('test result: ok. 4 passed; 0 failed; 1 ignored\ntest result: ok. 2 passed; 0 failed; 0 ignored'), { total: 7, passed: 6, failed: 0, skipped: 1 });
  assert.deepEqual(c('Tests run: 3, Failures: 0, Errors: 0, Skipped: 0\nTests run: 9, Failures: 1, Errors: 0, Skipped: 1'), { total: 9, passed: 7, failed: 1, skipped: 1 });
  assert.deepEqual(c('=== RUN   TestA\n--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.00s)\nFAIL'), { total: 2, passed: 1, failed: 1, skipped: 0 });
  assert.equal(c('no tests here'), undefined);
  assert.equal(gatesLib.countsText({ total: 12, passed: 11, failed: 1, skipped: 0 }), ' (12 tests: 11 passed, 1 failed)');
  // And the delivery index reads them back from a gate line.
  assert.deepEqual(delivery.parseGateLines('PASS node-test: `npm test --silent 2>&1` passed (3 tests: 3 passed)\nWARN todo-markers (0.1s): 2 TODO/FIXME marker(s)\nnoise')
    .map((g: { name: string; status: string; tests?: unknown }) => [g.name, g.status, g.tests ?? null]), [['node-test', 'pass', { total: 3, passed: 3, failed: 0, skipped: 0 }], ['todo-markers', 'warn', null]]);
});

test('the delivery index follows a real build-feature run, its gates and the agent\'s own test runs; routes need a signed-in caller and show each person their own', async () => {
  const t = await serve({ plugins: [path.join(PLUGINS, 'quality-gates'), path.join(PLUGINS, 'sdlc')] });
  try {
    const ws = t.work;
    await fs.writeFile(path.join(ws, 'README.md'), '# demo\n');
    const s = await t.harness.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws } });
    const ended = new Promise<void>((r) => s.subscribe(0, ({ event }) => { if (event.kind === 'workflow' && event.phase === 'finished') r(); }));
    await s.startWorkflow('build-feature', { request: 'A slugify(text) utility\nwith tests', approval: 'auto' });
    await ended;
    const [run] = await s.listRuns();
    assert.equal(run!.status, 'succeeded');

    // Signed in like the rest of the API.
    assert.equal((await t.call(undefined, 'GET', '/api/plugins/sdlc/deliveries')).status, 401);
    await until(async () => ((await t.call(OPERATOR, 'GET', '/api/plugins/sdlc/deliveries')).body.deliveries?.length ?? 0) === 1);
    const board = (await t.call(OPERATOR, 'GET', '/api/plugins/sdlc/deliveries')).body;
    assert.deepEqual(board.stages.map((x: { id: string }) => x.id), ['requirement', 'design', 'plan', 'build', 'gates', 'review', 'delivered']);
    const d = board.deliveries[0];
    assert.equal(d.id, run!.id);
    assert.equal(d.title, 'A slugify(text) utility with tests'.slice(0, d.title.length));
    assert.match(d.title, /^A slugify\(text\) utility/);
    assert.equal(d.stage, 'delivered');
    assert.equal(d.status, 'succeeded');
    assert.ok(d.gates.pass >= 2, `the scan gates passed: ${JSON.stringify(d.gates)}`);
    assert.equal(d.gates.fail, 0);
    // A frame's routes.call sends a POST with a JSON body; GET with a query works too.
    const one = (await t.call(OPERATOR, 'POST', '/api/plugins/sdlc/delivery', { id: run!.id })).body;
    assert.ok(one.nodes.some((n: { node: string; stage: string }) => n.node === 'implement' && n.stage === 'build'));
    assert.ok(one.gateResults.some((g: { name: string; status: string }) => g.name === 'secrets' && g.status === 'pass'));
    assert.equal(one.reviews.code, 'REQUEST_CHANGES', 'a reviewer with no verdict counts as asking for changes');
    assert.equal((await t.call(OPERATOR, 'GET', `/api/plugins/sdlc/delivery?id=${run!.id}`)).body.id, run!.id);
    assert.equal((await t.call(OPERATOR, 'POST', '/api/plugins/sdlc/delivery', { id: 'run_nope' })).status, 404);

    // The agent's own quality_gates call and test run in the same conversation: the panel's data.
    t.fake['steps' as never] = [{ calls: [{ name: 'quality_gates', input: { gates: ['secrets'] } }] }, { calls: [{ name: 'bash', input: { command: 'printf "# tests 4\\n# pass 4\\n# fail 0\\n"' } }] }, { text: 'All good.' }] as never;
    const idle = new Promise<void>((r) => s.subscribe(s.lastSeq, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
    await s.send('Run the secrets gate and the tests');
    await idle;
    await until(async () => (await t.call(OPERATOR, 'POST', '/api/plugins/sdlc/gates', { session: s.meta.id })).body.tests?.total === 4);
    const g = (await t.call(OPERATOR, 'POST', '/api/plugins/sdlc/gates', { session: s.meta.id })).body;
    assert.equal(g.running, null);
    assert.equal(g.gates.find((x: { name: string }) => x.name === 'secrets').source, 'tool');
    assert.deepEqual([g.tests.passed, g.tests.total, g.tests.gate], [4, 4, 'agent']);
    assert.equal(g.deliveries[0].id, run!.id);
    assert.equal((await t.call(OPERATOR, 'POST', '/api/plugins/sdlc/gates', { session: 'not-an-id' })).status, 400);

    // Another person sees none of the operator's work.
    const alice = await t.users.add('Alice', 'member');
    assert.deepEqual((await t.call(alice.token, 'GET', '/api/plugins/sdlc/deliveries')).body.deliveries, []);
    assert.equal((await t.call(alice.token, 'POST', '/api/plugins/sdlc/delivery', { id: run!.id })).status, 404);
    assert.equal((await t.call(alice.token, 'POST', '/api/plugins/sdlc/gates', { session: s.meta.id })).status, 404);
  } finally { await t.close(); }
});

test('delivery index (pure): stages follow the nodes, a gate node running then done, a failed run stays where it stopped', () => {
  const st = delivery.emptyState();
  const pending = new Map();
  const nodes = [{ id: 'implement', type: 'agent', title: 'Implement' }, { id: 'gates', type: 'gate', title: 'Quality gates' }, { id: 'fix', type: 'agent' }];
  const ev = (phase: string, run: object, node?: string) => ({ sessionId: 'a'.repeat(16), title: 'build-feature: Add login', event: { kind: 'workflow', phase, node, run: { id: 'run_1', workflow: 'build-feature', cost: 0.12, nodes, history: [], ...run } } });
  delivery.applyEvent(st, ev('started', { status: 'running', current: 'implement' }), { workflows: ['build-feature'], pending });
  assert.equal(st.deliveries.run_1.stage, 'build');
  assert.equal(st.deliveries.run_1.title, 'Add login');
  delivery.applyEvent(st, ev('node_started', { status: 'running', current: 'gates' }, 'gates'), { workflows: ['build-feature'], pending });
  assert.equal(st.sessions['a'.repeat(16)].running.gates, 'applicable');
  delivery.applyEvent(st, ev('node_finished', { status: 'running', current: 'fix', history: [{ node: 'gates', type: 'gate', status: 'done', outcome: 'fail', summary: '1 gate(s) failed: node-test\nFAIL node-test: `npm test` exited 1 (5 tests: 4 passed, 1 failed)', startedAt: 1, endedAt: 2 }] }, 'gates'), { workflows: ['build-feature'], pending });
  const d = st.deliveries.run_1;
  assert.equal(st.sessions['a'.repeat(16)].running, null);
  assert.equal(d.gates['node-test'].status, 'fail');
  assert.deepEqual(d.tests && [d.tests.passed, d.tests.failed], [4, 1]);
  assert.equal(delivery.card(d).gates.failing[0], 'node-test');
  delivery.applyEvent(st, ev('finished', { status: 'failed', current: 'gates', error: 'gates still failing' }), { workflows: ['build-feature'], pending });
  assert.equal(st.deliveries.run_1.stage, 'gates');
  // Another plugin's workflow is no feature.
  delivery.applyEvent(st, { ...ev('started', { id: 'run_2', workflow: 'incident-response', status: 'running' }) }, { workflows: ['build-feature'], pending });
  assert.equal(st.deliveries.run_2, undefined);
  assert.equal(delivery.visible({ owner: 'usr_a' }, { id: 'usr_a', role: 'member' }), true);
  assert.equal(delivery.visible({ owner: undefined }, { id: 'usr_a', role: 'member' }), false);
  assert.equal(delivery.visible({ owner: 'usr_b' }, { role: 'admin' }), true);
});

async function fakeOps() {
  const prom = http.createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    const q = u.searchParams.get('query') ?? '';
    const vector = (v: number, metric: Record<string, string> = {}) => ({ status: 'success', data: { resultType: 'vector', result: [{ metric, value: [Date.now() / 1000, String(v)] }] } });
    // checkout: 2% errors (an SLO at 99.9% burns 20x); payments: none; the error-ratio rule fires.
    const body = q.includes('checkout_errors_total') ? vector(0.02) : q.includes('payments_errors_total') ? vector(0) : q.includes('checkout_error_ratio') ? vector(0.21, { job: 'checkout' }) : { status: 'success', data: { resultType: 'vector', result: [] } };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  const health = http.createServer((req, res) => { res.writeHead(req.url?.includes('down') ? 503 : 200); res.end('ok'); });
  await Promise.all([new Promise<void>((r) => prom.listen(0, '127.0.0.1', r)), new Promise<void>((r) => health.listen(0, '127.0.0.1', r))]);
  const port = (s: http.Server) => (s.address() as { port: number }).port;
  return { prom: `http://127.0.0.1:${port(prom)}`, health: `http://127.0.0.1:${port(health)}`, close: async () => { await new Promise((r) => prom.close(r)); await new Promise((r) => health.close(r)); } };
}

test('aiops console routes: incidents from the plugin\'s own alert routes and the incident tool, alerts grouped, services with health and SLO burn, topology, changes, ops check; who sees what', async () => {
  const ops = await fakeOps();
  const invDir = await tempDir();
  const inv = path.join(invDir, 'inventory.yaml');
  await fs.writeFile(inv, `monitoring:
  prometheus: ${ops.prom}
services:
  - name: checkout
    env: prod
    health: ${ops.health}/health
    depends_on: [payments]
    owner: team-shop
    slos:
      - name: availability
        objective: 99.9
        window: 30d
        errors: sum(rate(checkout_errors_total[{{window}}]))
        total: sum(rate(checkout_requests_total[{{window}}]))
  - name: payments
    env: prod
    health: ${ops.health}/down
    slos:
      - name: availability
        objective: 99.5
        window: 30d
        errors: sum(rate(payments_errors_total[{{window}}]))
        total: sum(rate(payments_requests_total[{{window}}]))
alerts:
  - name: CheckoutErrorRatio
    expr: checkout_error_ratio > 0.05
    severity: critical
    service: checkout
`);
  const work = await tempDir();
  const t = await serve({
    plugins: [path.join(PLUGINS, 'aiops')],
    env: { HARNESS_OPS_INVENTORY: inv, HARNESS_OPS_ALERTS_PATH: work, HARNESS_OPS_ALERTS_INVESTIGATE: '0', HARNESS_OPS_WATCH_SECONDS: '0', HARNESS_PLUGIN_LOOPS: 'off', HARNESS_OPS_LOCAL_DOCKER: '' },
  });
  try {
    const routes = (await t.call(OPERATOR, 'POST', '/api/plugin-routes')).body as { path: string; method: string; auth: string; token?: string }[];
    for (const p of ['console/summary', 'console/incidents', 'console/incident', 'console/alerts', 'console/services', 'console/topology', 'console/changes', 'console/ops-check']) assert.equal(routes.find((r) => r.path === p)?.auth, 'user', `${p} needs a signed-in caller`);
    const token = routes.find((r) => r.path === 'alerts')!.token!;
    const alert = (body: unknown) => fetch(`${t.base}/api/plugins/aiops/alerts`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-harness-route-token': token }, body: JSON.stringify(body) });
    assert.equal((await alert({ alerts: [
      { name: 'CheckoutErrorRatio', severity: 'critical', service: 'checkout', summary: '21% of checkout requests fail', value: '0.21' },
      { name: 'CheckoutLatencyHigh', severity: 'warning', service: 'checkout', summary: 'p95 1.8s' },
      { name: 'SearchSlow', severity: 'info', labels: { app: 'search' } },
    ] })).status, 202);
    assert.equal((await t.call(undefined, 'GET', '/api/plugins/aiops/console/summary')).status, 401, 'no sign-in, no data');

    const sum = (await t.call(OPERATOR, 'GET', '/api/plugins/aiops/console/summary')).body;
    assert.equal(sum.open, 2, 'checkout (2 alerts) and search: two incidents');
    assert.equal(sum.firing, 3);
    assert.deepEqual(sum.bySeverity, { critical: 1, warning: 1, info: 1 });
    const slo = sum.slo.find((o: { service: string }) => o.service === 'checkout');
    assert.ok(slo.burn1h > 19 && slo.burn1h < 21, `burn ${slo.burn1h}`);
    assert.ok(slo.budgetLeft < 0, 'the budget is spent');
    assert.ok(slo.alerts.length >= 1, 'the multi-window burn alerts fire');

    const list = (await t.call(OPERATOR, 'POST', '/api/plugins/aiops/console/incidents', {})).body.incidents as { id: string; severity: string; services: string[]; alertsFiring: number; open: boolean }[];
    const checkout = list.find((x) => x.services.includes('checkout'))!;
    assert.deepEqual([checkout.severity, checkout.alertsFiring, checkout.open], ['sev2', 2, true]);

    const grouped = (await t.call(OPERATOR, 'POST', '/api/plugins/aiops/console/alerts', { severity: 'warning' })).body;
    assert.equal(grouped.firing, 2, 'below the minimum severity is left out');
    assert.equal(grouped.groups[0].service, 'checkout');
    assert.deepEqual(grouped.groups[0].alerts.map((a: { name: string }) => a.name), ['CheckoutErrorRatio', 'CheckoutLatencyHigh']);

    const svc = (await t.call(OPERATOR, 'GET', '/api/plugins/aiops/console/services')).body;
    const byName = Object.fromEntries(svc.services.map((s: { name: string }) => [s.name, s]));
    assert.equal(byName.checkout.state, 'critical', 'its error-ratio rule fires');
    assert.equal(byName.payments.state, 'critical', 'its health URL answers 503');
    assert.deepEqual(byName.checkout.dependsOn, ['payments']);
    assert.equal(byName.checkout.openIncidents, 1);
    assert.equal(byName.payments.slos[0].budgetLeft, 1, 'no errors: the whole budget left');

    const topo = (await t.call(OPERATOR, 'GET', '/api/plugins/aiops/console/topology')).body;
    assert.deepEqual(topo.edges.map((e: { from: string; to: string; kind: string }) => `${e.from}>${e.to}:${e.kind}`), ['checkout>payments:depends_on']);
    assert.equal(topo.nodes.find((n: { id: string }) => n.id === 'checkout').state, 'critical');

    await t.harness.bridge.changes.record({ kind: 'deploy', target: 'checkout', service: 'checkout', env: 'prod', summary: 'v42 rolled out', by: 'ci' });
    const ch = (await t.call(OPERATOR, 'POST', '/api/plugins/aiops/console/changes', { hours: 2 })).body;
    assert.equal(ch.changes[0].summary, 'v42 rolled out');

    const check = (await t.call(OPERATOR, 'POST', '/api/plugins/aiops/console/ops-check', {})).body;
    assert.match(check.text, /^Ops check: 3 rule\(s\), 2 firing/);
    assert.equal((await fetch(`${t.base}/api/plugins/aiops/console/ops-check`, { method: 'POST', headers: { authorization: `Bearer ${OPERATOR}`, 'content-type': 'application/json' }, body: '{}' })).status, 403, 'a write without the x-harness header is refused');

    // An incident record from the incident tool, in the ops workspace: the console finds it, with its evidence, runbook and postmortem.
    const tool = t.harness.registry.tools.get('incident')!;
    const ctx = { host: new LocalHost(work), signal: new AbortController().signal, readFiles: new Map(), todos: [], setTodos() {}, emit() {} } as unknown as ToolContext;
    const opened = await tool.run({ action: 'open', title: 'Checkout errors after deploy', severity: 'sev2', services: ['checkout'], summary: '21% of checkouts fail' }, ctx);
    const incId = /Opened (inc-[a-z0-9-]+)/.exec(opened.content)![1]!;
    // Evidence the harness recorded (the ledger is signed: written through the plugin's own tool).
    const q = await t.harness.registry.tools.get('topology')!.run({ action: 'graph' }, ctx);
    const ev = /Evidence id: (ev-[0-9a-f]{6})/.exec(q.content)?.[1] ?? /\[(ev-[0-9a-f]{6})\]/.exec(q.content)?.[1];
    await tool.run({ action: 'update', id: incId, kind: 'evidence', note: `checkout_error_ratio is 0.21 since 10:02 [${ev}]` }, ctx);
    await tool.run({ action: 'update', id: incId, kind: 'hypothesis', note: 'Refuter: SURVIVES - the errors started 2 min after the v42 deploy and only on checkout.' }, ctx);
    await tool.run({ action: 'resolve', id: incId, root_cause: `The v42 deploy broke the payment client [${ev}]`, resolution: 'rolled back to v41' }, ctx);
    await tool.run({ action: 'postmortem', id: incId, summary: 'A bad deploy.', impact: ['21% of checkouts failed for 14 minutes'] }, ctx);
    await fs.mkdir(path.join(work, '.harness', 'ops', 'runbooks'), { recursive: true });
    await fs.writeFile(path.join(work, '.harness', 'ops', 'runbooks', `remediate-${incId}.md`), '# Roll back checkout\n\n1. [check] `kubectl rollout history`\n');
    const all = (await t.call(OPERATOR, 'POST', '/api/plugins/aiops/console/incidents', { status: 'all' })).body.incidents as { id: string; source: string }[];
    assert.ok(all.some((x) => x.id === incId && x.source === 'workspace'));
    const det = (await t.call(OPERATOR, 'POST', '/api/plugins/aiops/console/incident', { id: incId })).body;
    assert.equal(det.status, 'resolved');
    assert.match(det.rootCause, /v42 deploy broke the payment client/);
    assert.equal(det.refuter.verdict, 'SURVIVES');
    assert.ok(det.timeline.some((x: { kind: string }) => x.kind === 'evidence'));
    assert.ok(det.evidenceIds.includes(ev));
    assert.equal(det.evidence.find((e: { id: string }) => e.id === ev).tool, 'topology', 'the ledger record behind the citation');
    assert.match(det.runbook, /Roll back checkout/);
    assert.match(det.postmortem, /# Postmortem: Checkout errors after deploy/);
    const alr = (await t.call(OPERATOR, 'POST', '/api/plugins/aiops/console/incident', { id: checkout.id })).body;
    assert.equal(alr.alerts.length, 2);
    assert.equal((await t.call(OPERATOR, 'POST', '/api/plugins/aiops/console/incident', { id: '../etc' })).status, 400);

    // A member: the alert incidents (as the alerts tool shows them), not the operator's workspace records.
    const alice = await t.users.add('Alice', 'member');
    const hers = (await t.call(alice.token, 'POST', '/api/plugins/aiops/console/incidents', { status: 'all' })).body.incidents as { id: string }[];
    assert.ok(hers.some((x) => x.id === checkout.id));
    assert.ok(!hers.some((x) => x.id === incId));
    assert.equal((await t.call(alice.token, 'POST', '/api/plugins/aiops/console/incident', { id: incId })).status, 404);
  } finally { await t.close(); await ops.close(); }
});

test('aiops console (pure): an investigation\'s root cause, confidence and refuter verdict from its steps\' reports', () => {
  const run = {
    id: 'run_x', workflow: 'incident-response', status: 'waiting', current: 'approve', cost: 0.4,
    nodes: [{ id: 'rca', type: 'agent', title: 'Root cause analysis' }, { id: 'refute', type: 'agent', title: 'Refuter' }],
    history: [
      { node: 'triage', type: 'agent', status: 'done', summary: 'Scope: checkout.\n```json\n{"incident": "inc-20261022-checkout", "services": ["checkout"]}\n```', startedAt: 1, endedAt: 2 },
      { node: 'rca', type: 'agent', status: 'done', summary: 'Root cause: bad deploy [ev-1a2b3c].\n```json\n{"root_cause": "the v42 deploy [ev-1a2b3c]", "confidence": "high: metrics and changes agree", "evidence_ids": ["ev-1a2b3c", "bogus"], "remediation_needed": true}\n```', startedAt: 3, endedAt: 4 },
      { node: 'refute', type: 'agent', status: 'done', outcome: 'SURVIVES', summary: 'Every check is consistent.\nSURVIVES', startedAt: 5, endedAt: 6 },
    ],
  };
  const inv = consoleLib.investigationOf(run);
  assert.equal(inv.incident, 'inc-20261022-checkout');
  assert.equal(inv.rca.rootCause, 'the v42 deploy [ev-1a2b3c]');
  assert.match(inv.rca.confidence, /^high/);
  assert.deepEqual(inv.rca.evidenceIds, ['ev-1a2b3c']);
  assert.equal(inv.refuter.verdict, 'SURVIVES');
  assert.deepEqual(inv.steps.map((s: { node: string; title: string }) => s.title), ['triage', 'Root cause analysis', 'Refuter']);
});
