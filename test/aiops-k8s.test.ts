// Kubernetes inside the aiops pack (plugins/aiops/lib/k8s.mjs). Unit tests need
// nothing: kubeconfig parsing (token, client certificate, what is refused), the
// inventory's clusters (operator only) and service mappings, the reader/operator
// permission decisions, and the summaries. The rest runs against a REAL cluster
// API: kwok's all-in-one image (kube-apiserver with RBAC on its TLS port, etcd,
// controllers and scheduler; kwok plays the kubelets) in a container named
// hwtest-aiops-k8s-<id>, with stages that make pods crash-loop or fail on
// purpose (evals/aiops/k8s-stack). Skipped without Docker or the image
// (HARNESS_TEST_KWOK=1 pulls it; =0 always skips). Then every k8s runbook runs
// end to end with a scripted model, and the k8s-crashloop eval case dry-runs
// (FakeProvider-style scripted model: no paid calls).

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decide, type Rules } from '../src/core/permissions.ts';
import type { Message } from '../src/core/types.ts';
import { loadCases, runEvals } from '../src/eval/runner.ts';
import { runGates } from '../src/gates/gates.ts';
import { validateWorkflow } from '../src/graph/validate.ts';
import { createHarness, type Harness } from '../src/kernel/harness.ts';
import type { Provider, ProviderRequest, ProviderResponse } from '../src/providers/types.ts';
import { dockerAvailable } from '../src/runtime/docker.ts';
import { LocalHost } from '../src/runtime/host.ts';
import type { Tool, ToolContext } from '../src/tools/types.ts';
import { tempDir } from './helpers.ts';
// @ts-expect-error plain JS
const K = await import('../plugins/aiops/lib/k8s.mjs');
// @ts-expect-error plain JS
const inventory = await import('../plugins/aiops/lib/inventory.mjs');
// @ts-expect-error plain JS
const runbooks = await import('../plugins/aiops/lib/runbooks.mjs');
// @ts-expect-error plain JS
const stack = await import('../evals/aiops/k8s-stack/kwok.mjs');

// Decided before any test is registered (the runner starts on the first one and exits when they finish).
const want = process.env.HARNESS_TEST_KWOK;
const runKwok = want !== '0' && (await dockerAvailable()) && (want === '1' || stack.imagePresent());
const skip = runKwok ? false : `needs Docker and ${stack.IMAGE} (docker pull it, or HARNESS_TEST_KWOK=1 to pull)`;

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(here, '..', 'plugins', 'aiops');
const b64 = (s: string) => Buffer.from(s).toString('base64');
const ctxFor = (root: string, services?: unknown) => ({ host: new LocalHost(root), signal: new AbortController().signal, readFiles: new Map(), todos: [], setTodos() {}, emit() {}, services }) as unknown as ToolContext;
async function workspace(inv: unknown) {
  const ws = await tempDir();
  await fs.mkdir(path.join(ws, '.harness', 'ops'), { recursive: true });
  await fs.writeFile(path.join(ws, '.harness', 'ops', 'inventory.json'), JSON.stringify(inv));
  return ws;
}

// ---------------- kubeconfig ----------------

const kc = (o: { server?: string; cluster?: Record<string, unknown>; user?: Record<string, unknown>; ctx?: Record<string, unknown>; current?: string }) => `apiVersion: v1
kind: Config
clusters:
- name: c1
  cluster:
    server: ${o.server ?? 'https://k8s.example:6443'}
${Object.entries(o.cluster ?? { 'certificate-authority-data': b64('-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n') }).map(([k, v]) => `    ${k}: ${v}`).join('\n')}
- name: c2
  cluster:
    server: https://other.example:443
contexts:
- name: one
  context:
    cluster: c1
    user: u1
${Object.entries(o.ctx ?? {}).map(([k, v]) => `    ${k}: ${v}`).join('\n')}
- name: two
  context:
    cluster: c2
    user: u1
current-context: ${o.current ?? 'one'}
users:
- name: u1
  user:
${Object.entries(o.user ?? { token: 'tok-abcdef0123456789' }).map(([k, v]) => `    ${k}: ${v}`).join('\n')}
`;

test('aiops k8s kubeconfig: a token or a client certificate, the CA from the file, a named context; everything a server cannot use safely is refused without quoting secrets', () => {
  const t = K.parseKubeconfig(kc({ ctx: { namespace: 'shop' } }));
  assert.equal(t.server, 'https://k8s.example:6443');
  assert.equal(t.auth, 'token');
  assert.equal(t.token, 'tok-abcdef0123456789');
  assert.match(t.ca, /BEGIN CERTIFICATE/);
  assert.equal(t.namespace, 'shop');
  assert.deepEqual(t.secrets, ['tok-abcdef0123456789']);
  const cert = K.parseKubeconfig(kc({ user: { 'client-certificate-data': b64('CERT-PEM'), 'client-key-data': b64('KEY-PEM-SECRET') } }));
  assert.equal(cert.auth, 'client certificate');
  assert.equal(cert.cert, 'CERT-PEM');
  assert.equal(cert.key, 'KEY-PEM-SECRET');
  assert.ok(cert.secrets.includes('KEY-PEM-SECRET') && cert.secrets.includes(b64('KEY-PEM-SECRET')), 'the key, decoded and encoded, is redacted later');
  assert.equal(K.parseKubeconfig(kc({}), { context: 'two' }).server, 'https://other.example');
  assert.equal(K.parseKubeconfig(JSON.stringify({ 'current-context': 'x', contexts: [{ name: 'x', context: { cluster: 'c', user: 'u' } }], clusters: [{ name: 'c', cluster: { server: 'https://a:1' } }], users: [{ name: 'u', user: { username: 'admin', password: 'pw-secret-1' } }] })).auth, 'basic');
  // Plain http only to this machine (kubectl proxy); a client certificate never over http.
  assert.equal(K.parseKubeconfig(kc({ server: 'http://127.0.0.1:8001', cluster: {} })).server, 'http://127.0.0.1:8001');
  const refused: [string, RegExp][] = [
    [kc({ server: 'http://k8s.example:8080', cluster: {} }), /not https/],
    [kc({ cluster: { 'insecure-skip-tls-verify': 'true' } }), /always verified/],
    [kc({ cluster: { 'certificate-authority': '/etc/k8s/ca.crt' } }), /names a file.*--flatten/],
    [kc({ user: { 'client-certificate': '/home/x/c.crt', 'client-key': '/home/x/c.key' } }), /names a file/],
    [kc({ user: { tokenFile: '/var/run/token' } }), /names a file/],
    [kc({ user: { exec: '{command: aws}' } }), /exec and auth-provider plugins are not supported/],
    [kc({ user: { 'client-certificate-data': b64('C') } }), /needs both/],
    [kc({ server: 'http://127.0.0.1:8001', cluster: {}, user: { 'client-certificate-data': b64('C'), 'client-key-data': b64('K') } }), /needs an https server/],
    [kc({ current: 'nope' }), /context "nope" is not in the kubeconfig \(contexts: one, two\)/],
    [kc({ cluster: { 'proxy-url': 'http://proxy:3128' } }), /proxy-url/],
  ];
  for (const [text, re] of refused) assert.throws(() => K.parseKubeconfig(text), re);
  // A broken file: the error names the line, never the content.
  assert.throws(() => K.parseKubeconfig('users:\n- name: u\n  user:\n    token: "super-secret-token-value\n'), (e: Error) => !e.message.includes('super-secret') && /could not be parsed/.test(e.message));
  assert.throws(() => K.parseKubeconfig(''), /empty/);
});

// ---------------- the inventory ----------------

test('aiops k8s inventory: clusters only from the operator\'s file (reader and operator kubeconfigs), services map to workloads, k8s alert rules; a workspace cannot declare or redirect a cluster', async () => {
  const op = inventory.validateInventory({
    environments: ['prod'],
    clusters: [
      { name: 'prod', env: 'prod', context: 'prod-admin@prod', credential: 'ops-k8s-prod', readCredential: 'ops-k8s-prod-ro', namespaces: ['shop'], prometheus_labels: 'cluster="prod"', scale: { min: 2, max: 20 } },
      { name: 'ro', readCredential: 'ops-k8s-ro' },
      { name: 'same', credential: 'ops-k8s-same', readCredential: 'ops-k8s-same' },
      { name: 'bad1', credential: 'kubeconfig-prod' },
      { name: 'bad2' },
      { name: 'bad3', credential: 'ops-x', namespaces: ['Shop_1'], prometheus_labels: 'cluster=prod', scale: { min: 5, max: 2 } },
    ],
    services: [
      { name: 'checkout', k8s: { cluster: 'prod', namespace: 'shop', workload: 'deployment/checkout', min_replicas: 2, max_replicas: 8 } },
      { name: 'sel', k8s: { cluster: 'prod', namespace: 'shop', selector: 'app=sel,tier in (web,api)' } },
      { name: 'nocl', k8s: { cluster: 'elsewhere', namespace: 'shop', workload: 'deployment/x' } },
      { name: 'badw', k8s: { cluster: 'prod', namespace: 'shop', workload: 'pod/x; rm -rf /' } },
    ],
    alerts: [
      { name: 'Crash', k8s: { cluster: 'prod', check: 'pod-crashlooping', namespace: 'shop' }, severity: 'critical' },
      { name: 'BadCheck', k8s: { cluster: 'prod', check: 'everything' } },
    ],
  }, { source: 'operator', vaultPatterns: ['ops-*'] });
  assert.deepEqual(op.inv.clusters.map((c: { name: string }) => c.name), ['prod', 'ro', 'same']);
  const prod = op.inv.clusters[0];
  assert.equal(prod.readCredential, 'ops-k8s-prod-ro');
  assert.equal(op.inv.clusters[2].readCredential, undefined, 'the operator kubeconfig as the reader is no reader');
  const errs = op.errors.join('\n');
  assert.match(errs, /clusters\.bad1: credential "kubeconfig-prod" is outside what this plugin may read/);
  assert.match(errs, /clusters\.bad2: needs credential .* and\/or readCredential/);
  assert.match(errs, /clusters\.bad3: namespace "Shop_1" is not a namespace name/);
  assert.match(errs, /clusters\.bad3: prometheus_labels must be label matchers/);
  assert.match(errs, /clusters\.bad3: scale must be/);
  assert.match(errs, /services\.nocl: k8s\.cluster "elsewhere" is not a cluster/);
  assert.match(errs, /services\.badw: k8s\.workload .* must be deployment/);
  assert.match(errs, /alerts\.BadCheck: k8s needs a check/);
  assert.deepEqual(op.inv.services.map((s: { name: string }) => s.name), ['checkout', 'sel']);
  assert.deepEqual(op.inv.alerts.map((a: { name: string }) => a.name), ['Crash']);
  assert.match(op.warnings.join('\n'), /clusters\.same: readCredential is the operator kubeconfig itself/);
  assert.match(op.warnings.join('\n'), /clusters\.ro: no operator kubeconfig .* read only/);

  // A workspace file: its clusters are ignored (a cluster is a credential), with or without an operator file.
  const wsDoc = { clusters: [{ name: 'evil', credential: 'ops-k8s-prod', readCredential: 'ops-k8s-prod' }], services: [{ name: 'app', k8s: { cluster: 'prod', namespace: 'shop', workload: 'deployment/app' } }, { name: 'app2', k8s: { cluster: 'evil', namespace: 'x', workload: 'deployment/y' } }] };
  const ws = await workspace(wsDoc);
  const resolve = async (_h: unknown, rel: string) => path.join(ws, rel);
  const opFile = path.join(await tempDir(), 'ops.json');
  await fs.writeFile(opFile, JSON.stringify({ clusters: [{ name: 'prod', credential: 'ops-k8s-prod', readCredential: 'ops-k8s-prod-ro' }] }));
  const merged = await inventory.loadInventory({ host: new LocalHost(ws), resolve, env: { HARNESS_OPS_INVENTORY: opFile }, vaultPatterns: ['ops-*'] });
  assert.deepEqual(merged.clusters.map((c: { name: string }) => c.name), ['prod']);
  assert.deepEqual(merged.services.map((s: { name: string }) => s.name), ['app'], 'a workspace service may run on an operator cluster');
  assert.match(merged.warnings.join('\n'), /clusters: ignored: only the operator's inventory/);
  assert.match(merged.errors.join('\n'), /services\.app2: k8s\.cluster "evil" is not a cluster/);
  const alone = await inventory.loadInventory({ host: new LocalHost(ws), resolve, env: {}, vaultPatterns: ['ops-*'] });
  assert.deepEqual(alone.clusters, []);
  assert.deepEqual(alone.services, [], 'without an operator inventory there is no cluster to map to');
});

// ---------------- permissions ----------------

test('aiops k8s permissions: reads with the read-only kubeconfig are reads (not asked once the vault rules allow it), with the operator kubeconfig they are asked; every change is asked and uses only the operator kubeconfig', async () => {
  const opFile = path.join(await tempDir(), 'ops.json');
  await fs.writeFile(opFile, JSON.stringify({ clusters: [
    { name: 'prod', credential: 'ops-k8s-prod', readCredential: 'ops-k8s-prod-ro', namespaces: ['shop'] },
    { name: 'opsonly', credential: 'ops-k8s-opsonly' },
  ], services: [{ name: 'checkout', k8s: { cluster: 'prod', namespace: 'shop', workload: 'deployment/checkout' } }] }));
  const h = await createHarness({ dataDir: await tempDir(), plugins: [PLUGIN], search: null, memory: 'off', scheduler: false });
  process.env.HARNESS_OPS_INVENTORY = opFile;
  try {
    const tool = (n: string) => h.registry.tools.get(n)! as Tool;
    for (const n of ['k8s_health', 'k8s_events', 'k8s_logs', 'k8s_describe', 'k8s_metrics']) {
      const t = tool(n);
      assert.equal(t.untrusted, true, `${n}: cluster output is untrusted`);
      assert.deepEqual(t.kindsFor!({ cluster: 'prod' }), ['read'], n);
      assert.deepEqual(t.vaultNames!({ cluster: 'prod' }), ['ops-k8s-prod-ro'], `${n} declares only the read-only kubeconfig`);
      assert.deepEqual(t.kindsFor!({ cluster: 'opsonly' }), ['network'], `${n} with the operator kubeconfig is asked`);
      assert.deepEqual(t.vaultNames!({ cluster: 'opsonly' }), ['ops-k8s-opsonly']);
    }
    // An operator-inventory service names its cluster; a workspace one needs it named (or the only cluster).
    assert.deepEqual(tool('k8s_health').vaultNames!({ service: 'checkout' }), ['ops-k8s-prod-ro']);
    assert.deepEqual(tool('k8s_health').vaultNames!({ service: 'from-the-workspace' }), []);
    const rules = (operatorAllow: string[] = [], extra: Partial<Rules> = {}): Rules => ({ allow: [...operatorAllow], deny: [], ask: [], operatorAllow, ...extra });
    const vaultOk = rules(['vault(ops-k8s-*)']);
    const read = { cluster: 'prod', namespace: 'shop' };
    const health = tool('k8s_health');
    assert.equal(decide(health, read, { mode: 'default', rules: vaultOk, sandboxed: true }).action, 'allow');
    assert.equal(decide(health, read, { mode: 'default', rules: vaultOk, sandboxed: true, tainted: true }).action, 'allow', 'after untrusted output too: RBAC refuses changes and nothing leaves');
    assert.equal(decide(health, read, { mode: 'plan', rules: vaultOk, sandboxed: true }).action, 'allow');
    assert.equal(decide(health, read, { mode: 'default', rules: rules(), sandboxed: true }).action, 'ask', 'the kubeconfig itself is still decided by the vault rules');
    assert.equal(decide(health, read, { mode: 'default', rules: rules(['vault(ops-k8s-*)'], { deny: ['vault(ops-k8s-prod-ro)'] }), sandboxed: true }).action, 'deny');
    assert.equal(decide(health, { cluster: 'opsonly' }, { mode: 'default', rules: vaultOk, sandboxed: true }).action, 'ask', 'a read with the operator kubeconfig is asked');
    // Changes: the operator kubeconfig, always asked, refused where nobody answers.
    const ctl = tool('k8s_control');
    const rollback = { cluster: 'prod', action: 'rollback', namespace: 'shop', target: 'deployment/checkout' };
    assert.equal(ctl.kind, 'external');
    assert.deepEqual(ctl.vaultNames!(rollback), ['ops-k8s-prod']);
    assert.equal(decide(ctl, rollback, { mode: 'default', rules: vaultOk, sandboxed: true }).action, 'ask');
    assert.equal(decide(ctl, rollback, { mode: 'acceptEdits', rules: vaultOk, sandboxed: true }).action, 'ask');
    assert.equal(decide(ctl, rollback, { mode: 'dontAsk', rules: vaultOk, sandboxed: true }).action, 'deny');
    assert.equal(decide(ctl, rollback, { mode: 'plan', rules: vaultOk, sandboxed: true }).action, 'deny');
    assert.equal(ctl.ruleSubject!(rollback), 'prod rollback shop deployment/checkout');
    const exact = rules(['vault(ops-k8s-*)', 'k8s_control(prod rollback shop deployment/checkout)']);
    assert.equal(decide(ctl, rollback, { mode: 'default', rules: exact, sandboxed: true }).action, 'allow', 'an operator rule for that exact change');
    assert.equal(decide(ctl, { ...rollback, target: 'deployment/payments' }, { mode: 'default', rules: exact, sandboxed: true }).action, 'ask');
    assert.equal(decide(ctl, { cluster: 'prod', action: 'scale', namespace: 'shop', target: 'deployment/checkout', replicas: 40 }, { mode: 'default', rules: exact, sandboxed: true }).action, 'ask');
    // A service the operator's inventory does not map (a workspace's): never matched by an allow rule, always asked.
    const wsScale = { cluster: 'prod', action: 'scale', namespace: 'shop', service: 'not-the-operators', replicas: 0 };
    assert.match(ctl.ruleSubject!(wsScale), / <workspace mapping>$/);
    assert.equal(decide(ctl, wsScale, { mode: 'default', rules: rules(['vault(ops-k8s-*)', 'k8s_control(prod scale:*)']), sandboxed: true }).action, 'ask');
    assert.match(ctl.summarize(rollback), /^CHANGE k8s prod: rollback deployment\/checkout in shop/);
    assert.match(ctl.summarize({ ...rollback, action: 'delete-pod', target: 'pod/x', force: true }), /\(FORCED\)/);
    // ops_check declares the clusters' read-only kubeconfigs, else their operator ones (its k8s rules read with them).
    assert.deepEqual(tool('ops_check').vaultNames!({}), ['ops-k8s-prod-ro', 'ops-k8s-opsonly']);
    // The agents and the built-in runbooks: the sre agent has the tools; every k8s runbook approves and verifies its change.
    assert.ok(['k8s_health', 'k8s_logs', 'k8s_control'].every((n) => h.registry.agents.get('sre')!.tools!.includes(n)));
    for (const n of ['runbook-k8s-restart', 'runbook-k8s-rollback', 'runbook-k8s-scale', 'runbook-k8s-drain-node', 'runbook-k8s-delete-pod', 'runbook-k8s-rerun-job', 'incident-response-k8s']) {
      const w = h.registry.workflows.get(n)!;
      assert.ok(w, n);
      assert.deepEqual(validateWorkflow(w), [], n);
      const s = runbooks.checkWorkflowSafety(w);
      assert.deepEqual(s.errors, [], n);
      assert.ok(s.changes.length >= 1, `${n} marks its change step`);
    }
    const skills = h.registry.skillDirs.find((d) => d.source === 'aiops')!;
    assert.match(await fs.readFile(path.join(skills.dir, 'kubernetes-triage', 'SKILL.md'), 'utf8'), /^---\nname: kubernetes-triage\n/);
  } finally { delete process.env.HARNESS_OPS_INVENTORY; await h.close(); }
});

// ---------------- summaries ----------------

const NOW = Date.parse('2026-10-22T12:00:00Z');
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();
const pod = (name: string, status: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ metadata: { name, namespace: 'shop', creationTimestamp: ago(3600), labels: { 'pod-template-hash': '7d9f' }, ownerReferences: [{ kind: 'ReplicaSet', name: 'checkout-7d9f', controller: true }], ...extra }, spec: { containers: [{ name: 'app', image: 'app:1', resources: { limits: { memory: '512Mi' } } }] }, status });

test('aiops k8s summaries: pod problems with their reasons, grouped by owner; nodes, workloads, HPAs, PVCs, jobs; events deduped; rollout status; what changed between revisions; quantities and usage flags', () => {
  const crash = pod('checkout-7d9f8c6b5-x2x9q', { phase: 'Running', containerStatuses: [{ name: 'app', ready: false, restartCount: 7, state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 5m0s' } }, lastState: { terminated: { exitCode: 1, reason: 'Error', finishedAt: ago(30) } } }] });
  const crash2 = { ...crash, metadata: { ...crash.metadata, name: 'checkout-7d9f8c6b5-k7m2p' } };
  const oom = pod('api-1', { phase: 'Running', containerStatuses: [{ name: 'app', ready: false, restartCount: 3, state: { waiting: { reason: 'CrashLoopBackOff' } }, lastState: { terminated: { exitCode: 137, reason: 'OOMKilled', finishedAt: ago(60) } } }] }, { ownerReferences: [{ kind: 'StatefulSet', name: 'api', controller: true }] });
  const pull = pod('web-1', { phase: 'Pending', containerStatuses: [{ name: 'app', ready: false, restartCount: 0, state: { waiting: { reason: 'ImagePullBackOff', message: 'Back-off pulling image "app:nope"' } } }] }, { ownerReferences: [{ kind: 'DaemonSet', name: 'web', controller: true }] });
  const pending = pod('big-1', { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: '0/3 nodes are available: 3 Insufficient memory.' }] }, { ownerReferences: [] });
  const notReady = pod('rdy-1', { phase: 'Running', conditions: [{ type: 'Ready', status: 'False' }], containerStatuses: [{ name: 'app', ready: false, restartCount: 0, state: { running: {} } }] }, { ownerReferences: [{ kind: 'Job', name: 'nightly', controller: true }] });
  const done = pod('job-1', { phase: 'Succeeded' });
  const healthy = pod('ok-1', { phase: 'Running', containerStatuses: [{ name: 'app', ready: true, restartCount: 2, state: { running: {} } }] });
  const stuck = pod('gone-1', { phase: 'Running' }, { deletionTimestamp: ago(900), deletionGracePeriodSeconds: 30, finalizers: ['example.com/x'] });
  assert.equal(K.podProblem(crash, NOW).issue, 'CrashLoopBackOff');
  assert.match(K.podProblem(crash, NOW).detail, /container app: CrashLoopBackOff \(back-off 5m0s\); restarts 7, last exit 1 \(Error\) 30s ago/);
  assert.equal(K.podProblem(oom, NOW).issue, 'OOMKilled');
  assert.match(K.podProblem(oom, NOW).detail, /after OOMKilled.*last exit 137 \(OOMKilled\)/);
  assert.equal(K.podProblem(pull, NOW).issue, 'ImagePullBackOff');
  assert.match(K.podProblem(pending, NOW).detail, /unschedulable: 0\/3 nodes are available: 3 Insufficient memory/);
  assert.match(K.podProblem(notReady, NOW).detail, /running but not ready .*readiness probe failing/);
  assert.equal(K.podProblem(done, NOW), undefined);
  assert.equal(K.podProblem(healthy, NOW), undefined);
  assert.match(K.podProblem(stuck, NOW).detail, /stuck terminating for 15m \(finalizers: example.com\/x/);
  assert.equal(K.podOwner(crash), 'deployment/checkout');
  assert.equal(K.podOwner(oom), 'statefulset/api');
  assert.equal(K.podOwner(pending), 'pod/big-1');

  const snap = {
    nodes: [
      { metadata: { name: 'n1' }, status: { conditions: [{ type: 'Ready', status: 'True' }] } },
      { metadata: { name: 'n2' }, spec: { unschedulable: true }, status: { conditions: [{ type: 'Ready', status: 'False', reason: 'KubeletNotReady', message: 'PLEG is not healthy', lastTransitionTime: ago(600) }, { type: 'MemoryPressure', status: 'True' }] } },
    ],
    pods: [crash, crash2, oom, pull, pending, notReady, done, healthy],
    deployments: [
      { metadata: { name: 'checkout', namespace: 'shop', generation: 2 }, spec: { replicas: 2 }, status: { observedGeneration: 2, replicas: 2, updatedReplicas: 2, availableReplicas: 0, unavailableReplicas: 2, conditions: [{ type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded', message: 'ReplicaSet "checkout-7d9f" has timed out progressing.' }] } },
      { metadata: { name: 'fine', namespace: 'shop', generation: 1 }, spec: { replicas: 1 }, status: { observedGeneration: 1, replicas: 1, updatedReplicas: 1, availableReplicas: 1 } },
    ],
    hpas: [{ metadata: { name: 'web', namespace: 'shop' }, spec: { maxReplicas: 10, scaleTargetRef: { kind: 'Deployment', name: 'web' }, metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 70 } } }] }, status: { currentReplicas: 10, currentMetrics: [{ type: 'Resource', resource: { name: 'cpu', current: { averageUtilization: 96 } } }] } }],
    pvcs: [{ metadata: { name: 'data', namespace: 'shop', creationTimestamp: ago(7200) }, spec: { storageClassName: 'fast', resources: { requests: { storage: '10Gi' } } }, status: { phase: 'Pending' } }],
    jobs: [{ metadata: { name: 'nightly-123', namespace: 'shop', ownerReferences: [{ name: 'nightly' }] }, status: { failed: 4, conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded', message: 'Job has reached the specified backoff limit' }] } }],
    events: [
      { type: 'Warning', reason: 'BackOff', involvedObject: { kind: 'Pod', name: 'checkout-7d9f8c6b5-x2x9q', namespace: 'shop' }, message: 'Back-off restarting failed container app in pod checkout-7d9f8c6b5-x2x9q_shop(0a31b4c8-8c34-47e9-9f48-e417c5016abf)', count: 7, firstTimestamp: ago(600), lastTimestamp: ago(10) },
      { type: 'Warning', reason: 'BackOff', involvedObject: { kind: 'Pod', name: 'checkout-7d9f8c6b5-k7m2p', namespace: 'shop' }, message: 'Back-off restarting failed container app in pod checkout-7d9f8c6b5-k7m2p_shop(bafcb522-c690-4b01-9948-6957ddabd2bb)', count: 5, firstTimestamp: ago(500), lastTimestamp: ago(20) },
      { type: 'Normal', reason: 'Pulled', involvedObject: { kind: 'Pod', name: 'ok-1', namespace: 'shop' }, message: 'Pulled', lastTimestamp: ago(30) },
    ],
  };
  const s = K.summarizeHealth(snap, { now: NOW, title: 'cluster t' });
  assert.match(s.text, /^cluster t: 2 node\(s\), 1 Ready; 8 pod\(s\) in 1 namespace\(s\), 1 running and ready; 2 deployment\(s\)\./);
  assert.match(s.text, /- node n2: NotReady \(KubeletNotReady: PLEG is not healthy, since 10m\)/);
  assert.match(s.text, /- node n2: MemoryPressure/);
  assert.match(s.text, /- CrashLoopBackOff deployment\/checkout \[shop\]: 2 pod\(s\) \(e\.g\. checkout-7d9f8c6b5-x2x9q\): container app: CrashLoopBackOff/);
  assert.match(s.text, /- OOMKilled statefulset\/api \[shop\]: 1 pod\(s\)/);
  assert.match(s.text, /- ImagePullBackOff daemonset\/web \[shop\]/);
  assert.match(s.text, /- Pending pod\/big-1 \[shop\]: .*Insufficient memory/);
  assert.match(s.text, /- deployment\/checkout \[shop\]: 0\/2 available \(2 unavailable\), 2 updated; rollout stuck: ProgressDeadlineExceeded/);
  assert.doesNotMatch(s.text, /deployment\/fine/);
  assert.match(s.text, /- hpa shop\/web -> deployment\/web: at max 10\/10 replicas \(cpu 96% \/ target 70%\)/);
  assert.match(s.text, /- pvc shop\/data: Pending for 2h \(storageClass fast, 10Gi\)/);
  assert.match(s.text, /- job shop\/nightly-123 \(cronjob nightly\): failed: BackoffLimitExceeded/);
  assert.match(s.text, /Cordoned nodes: n2/);
  assert.match(s.text, /Top restarts: shop\/checkout-7d9f8c6b5-x2x9q 7, shop\/checkout-7d9f8c6b5-k7m2p 7, shop\/api-1 3, shop\/ok-1 2/);
  assert.match(s.text, /Warning BackOff pod\/checkout-7d9f8c6b5-x2x9q \(\+1 more\) \[shop\] x12, first 10m ago: Back-off restarting/, 'two pods\' identical events are one line with the summed count');
  assert.doesNotMatch(s.text, /Pulled/);
  // The checks ops_check evaluates from it.
  assert.equal(K.evaluateCheck('pod-crashlooping', s.findings).state, 'firing');
  assert.match(K.evaluateCheck('pod-crashlooping', s.findings).detail, /^3: /);
  assert.equal(K.evaluateCheck('pod-crashlooping', s.findings, { namespace: 'other' }).state, 'ok');
  assert.equal(K.evaluateCheck('node-not-ready', s.findings).state, 'firing');
  assert.equal(K.evaluateCheck('deployment-unavailable', s.findings).state, 'firing');
  assert.equal(K.evaluateCheck('pvc-pending', s.findings).state, 'firing');
  assert.equal(K.evaluateCheck('job-failed', s.findings).state, 'firing');
  assert.equal(K.evaluateCheck('hpa-maxed', s.findings).state, 'firing');
  assert.equal(K.evaluateCheck('nope', s.findings).state, 'error');
  const clean = K.summarizeHealth({ nodes: [snap.nodes[0]], pods: [healthy, done], deployments: [snap.deployments[1]] }, { now: NOW });
  assert.match(clean.text, /No problems found\./);
  assert.ok(Object.keys(K.K8S_CHECKS).every((c) => K.evaluateCheck(c, clean.findings).state === 'ok'));

  // Rollout status as kubectl reports it.
  const dep = (status: Record<string, unknown>, spec: Record<string, unknown> = {}) => ({ kind: 'Deployment', metadata: { generation: 3 }, spec: { replicas: 3, ...spec }, status: { observedGeneration: 3, ...status } });
  assert.equal(K.rolloutStatus(dep({ updatedReplicas: 3, replicas: 3, availableReplicas: 3 })).done, true);
  assert.match(K.rolloutStatus(dep({ updatedReplicas: 1, replicas: 4, availableReplicas: 3 })).text, /1 of 3 new replicas updated/);
  assert.match(K.rolloutStatus(dep({ updatedReplicas: 3, replicas: 4, availableReplicas: 3 })).text, /1 old replica\(s\) pending termination/);
  assert.match(K.rolloutStatus(dep({ updatedReplicas: 3, replicas: 3, availableReplicas: 2 })).text, /2 of 3 updated replicas available/);
  assert.match(K.rolloutStatus({ ...dep({}), status: { observedGeneration: 2 } }).text, /waiting for the controller/);
  assert.equal(K.rolloutStatus({ kind: 'StatefulSet', metadata: { generation: 1 }, spec: { replicas: 2 }, status: { observedGeneration: 1, readyReplicas: 2 } }).done, true);
  assert.match(K.rolloutStatus({ kind: 'DaemonSet', metadata: { generation: 1 }, status: { observedGeneration: 1, desiredNumberScheduled: 3, updatedNumberScheduled: 3, numberAvailable: 1 } }).text, /1 of 3 updated pods available/);
  // What changed between two revisions: env values (the bad config), images, resources.
  const tpl = (timeout: string, image = 'checkout:2.4.1') => ({ metadata: { labels: { app: 'c' } }, spec: { containers: [{ name: 'checkout', image, env: [{ name: 'PAYMENT_GATEWAY_TIMEOUT', value: timeout }, { name: 'DB_PASSWORD', valueFrom: { secretKeyRef: { name: 'db', key: 'pw' } } }], resources: { limits: { memory: '512Mi' } } }] } });
  assert.deepEqual(K.templateDiff(tpl('30s'), tpl('30')), ['checkout env PAYMENT_GATEWAY_TIMEOUT "30s" -> "30"']);
  assert.match(K.templateDiff(tpl('30s', 'checkout:2.4.0'), tpl('30s')).join(), /checkout image checkout:2.4.0 -> checkout:2.4.1/);
  // Quantities, usage flags, selectors.
  assert.equal(K.parseQuantity('250m'), 0.25);
  assert.equal(K.parseQuantity('512Mi'), 512 * 1024 * 1024);
  assert.ok(Math.abs(K.parseQuantity('123456789n') - 0.123456789) < 1e-12);
  assert.equal(K.parseQuantity('1.5'), 1.5);
  assert.equal(K.parseQuantity('2Gi'), 2 * 1024 ** 3);
  assert.ok(Number.isNaN(K.parseQuantity('lots')));
  const [u] = K.formatUsage([{ key: 'shop/api-1/app', cpu: 0.48, cpuReq: 0.25, cpuLim: 0.5, mem: 500 * 1024 * 1024, memReq: 256 * 1024 * 1024, memLim: 512 * 1024 * 1024, throttle: 0.4, restarts: 3, restartsWindow: '1h', lastReason: 'OOMKilled' }]);
  assert.equal(u.line, 'shop/api-1/app: cpu 480m (req 250m = 192%) (lim 500m = 96%); mem 500Mi (req 256Mi = 195%) (lim 512Mi = 98%); throttled 40%, restarts 3 in 1h - MEMORY NEAR LIMIT (OOM risk), CPU AT LIMIT, THROTTLED 40%, last terminated OOMKilled');
  assert.match(K.formatUsage([{ key: 'k', cpu: 0.01, mem: 1024 }])[0].line, /no memory limit, no requests/);
  assert.equal(K.selectorString({ matchLabels: { app: 'c' }, matchExpressions: [{ key: 'tier', operator: 'In', values: ['a', 'b'] }, { key: 'canary', operator: 'DoesNotExist' }] }), 'app=c,tier in (a,b),!canary');
  assert.ok(K.labelSelectorMatches('app=c,tier in (a,b),!canary', { app: 'c', tier: 'b' }));
  assert.ok(!K.labelSelectorMatches('app=c,tier in (a,b),!canary', { app: 'c', tier: 'b', canary: 'y' }));
  assert.ok(K.labelSelectorMatches('app!=x,env', { app: 'c', env: 'p' }));
  assert.ok(K.selectorMatches({ matchLabels: { app: 'c' } }, { app: 'c', x: '1' }));
  assert.match(K.metricsQueries({ namespace: 'shop', pods: ['a.b'], extra: 'cluster="eu"' }).cpu, /namespace="shop",pod=~"a\\\\.b",cluster="eu",container!=""/);
  // describe: no managedFields or last-applied; ConfigMap values cut; Secrets never.
  const t = K.trimObject({ kind: 'ConfigMap', metadata: { name: 'x', uid: 'u', managedFields: [{}], annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{...}', note: 'kept' } }, data: { big: 'y'.repeat(1000), small: 'v' } });
  assert.equal(t.metadata.managedFields, undefined);
  assert.deepEqual(t.metadata.annotations, { note: 'kept' });
  assert.match(t.data.big, /\.\.\. \(1000 chars\)$/);
  assert.match(K.toYaml(t), /^kind: ConfigMap\nmetadata:\n {2}name: x\n/);
  assert.throws(() => K.parseRef('secret/db'), /Secrets are never read/);
  assert.deepEqual(K.parseRef('deploy/checkout'), { kind: 'deployment', name: 'checkout' });
  assert.throws(() => K.parseRef('deployment/Bad;rm'), /not a valid deployment name/);
});

// ================ a real cluster: kwok ================

const id = crypto.randomBytes(3).toString('hex');
const NAME = `hwtest-aiops-k8s-${id}`;
const NS = 'hwtest';
const OPS_ENV = ['HARNESS_OPS_INVENTORY', 'HARNESS_OPS_SECRETS', 'HARNESS_OPS_PROMETHEUS_URL'];
const envBefore = Object.fromEntries(OPS_ENV.map((k) => [k, process.env[k]]));

let cl: { name: string; port: number; server: string; admin: string; reader: string; readerToken: string; client: { get(p: string): Promise<any>; list(p: string, o?: unknown): Promise<any[]>; patch(p: string, b: unknown, t?: string): Promise<any>; request(m: string, p: string, o?: unknown): Promise<any>; close(): void } };
let h: Harness;
let dataDir: string;
let ws: string;
let opFile: string;
let promStub: { url: string; close(): Promise<void>; queries: string[] };
const vaultUses: string[] = [];
let secrets: Record<string, string>;
const vault = {
  async list() { return Object.keys(secrets).map((name) => ({ name, kind: 'secret', scope: 'server', updatedAt: new Date().toISOString(), backend: 'test' })); },
  async reveal(name: string, purpose: string) { vaultUses.push(`${name}: ${purpose}`); if (!secrets[name]) throw new Error(`no vault entry named ${name}`); return secrets[name]!; },
  async envFor() { return {}; },
};
const recorded: Record<string, unknown>[] = [];
const changes = { async record(c: Record<string, unknown>) { recorded.push(c); } };
const call = async (name: string, input: Record<string, unknown>) => h.registry.tools.get(name)!.run(input, ctxFor(ws, { vault, changes }));
const auditLines = async () => (await fs.readFile(path.join(dataDir, 'plugin-data', 'aiops', 'audit.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const dep = (name: string, o: { replicas?: number; pool?: string; annotations?: Record<string, string>; env?: Record<string, string>; container?: string; strategy?: unknown } = {}) => ({
  kind: 'Deployment', metadata: { name, namespace: NS, labels: { app: name } },
  spec: { replicas: o.replicas ?? 1, ...(o.strategy ? { strategy: o.strategy } : {}), selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name }, ...(o.annotations ? { annotations: o.annotations } : {}) }, spec: { nodeSelector: { 'hwtest/pool': o.pool ?? 'main' }, containers: [{ name: o.container ?? 'web', image: `registry.example/${name}:1.0.0`, env: Object.entries(o.env ?? { MODE: 'normal' }).map(([k, v]) => ({ name: k, value: v })), resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '500m', memory: '256Mi' } } }] } } },
});
const getDep = (n: string) => cl.client.get(`/apis/apps/v1/namespaces/${NS}/deployments/${n}`);
const available = async (n: string, want_?: number) => { const d = await getDep(n); return d.status?.observedGeneration === d.metadata.generation && (d.status?.availableReplicas ?? 0) === (want_ ?? d.spec.replicas) && (d.status?.updatedReplicas ?? 0) === d.spec.replicas && (d.status?.replicas ?? 0) === d.spec.replicas; };

/** A Prometheus with cAdvisor and kube-state-metrics series for the "web" pods. */
async function stubPrometheus(pods: string[]) {
  const queries: string[] = [];
  const srv = http.createServer((req, res) => {
    const q = new URL(req.url!, 'http://x').searchParams.get('query') ?? '';
    queries.push(q);
    const per = (v: number, extra: Record<string, string> = {}) => pods.map((p) => ({ metric: { namespace: NS, pod: p, container: 'web', ...extra }, value: [Date.now() / 1000, String(v)] }));
    let result: unknown[] = [];
    if (q.includes('kube_pod_container_status_last_terminated_reason')) result = per(1).slice(0, 1);
    else if (q.includes('container_cpu_cfs_throttled_periods_total')) result = per(0.4);
    else if (q.includes('container_cpu_usage_seconds_total')) result = per(0.45);
    else if (q.includes('container_memory_working_set_bytes')) result = per(250 * 1024 * 1024);
    else if (q.includes('kube_pod_container_resource_requests')) result = [...per(0.1, { resource: 'cpu' }), ...per(128 * 1024 * 1024, { resource: 'memory' })];
    else if (q.includes('kube_pod_container_resource_limits')) result = [...per(0.5, { resource: 'cpu' }), ...per(256 * 1024 * 1024, { resource: 'memory' })];
    else if (q.includes('kube_pod_container_status_restarts_total')) result = per(2);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result } }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, queries, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

describe('kwok: a real Kubernetes API', { skip }, () => {
before(async () => {
  if (!runKwok) return;
  cl = await stack.up({ name: NAME, port: 0 });
  const c = cl.client;
  await stack.node(c, 'hwtest-node-1', { 'hwtest/pool': 'main' });
  await stack.node(c, 'hwtest-node-2', { 'hwtest/pool': 'guarded' });
  await stack.node(c, 'hwtest-node-3', { 'hwtest/pool': 'drain' });
  await stack.apply(c, { kind: 'Namespace', metadata: { name: NS } });
  const objs = [
    dep('web', { replicas: 3 }),
    dep('crash', { annotations: { 'hwtest/crash': 'true' }, container: 'app' }),
    dep('pending', { pool: 'missing' }),
    dep('api', { replicas: 2 }),
    dep('flaky', { replicas: 2 }),
    dep('autoscaled', { replicas: 2 }),
    dep('guarded', { pool: 'guarded' }),
    dep('mover', { replicas: 2, pool: 'drain' }),
    { kind: 'HorizontalPodAutoscaler', metadata: { name: 'autoscaled', namespace: NS }, spec: { scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'autoscaled' }, minReplicas: 2, maxReplicas: 2, metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 80 } } }] } },
    { kind: 'PodDisruptionBudget', metadata: { name: 'guarded', namespace: NS }, spec: { minAvailable: 1, selector: { matchLabels: { app: 'guarded' } } } },
    { kind: 'PersistentVolumeClaim', metadata: { name: 'data', namespace: NS }, spec: { storageClassName: 'hwtest-none', accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } } },
    { kind: 'Job', metadata: { name: 'nightly', namespace: NS }, spec: { backoffLimit: 0, template: { metadata: { annotations: { 'hwtest/fail': 'true' } }, spec: { restartPolicy: 'Never', nodeSelector: { 'hwtest/pool': 'main' }, containers: [{ name: 'job', image: 'registry.example/nightly:1.0.0' }] } } } },
    { kind: 'ConfigMap', metadata: { name: 'web-config', namespace: NS }, data: { 'app.yaml': 'mode: normal\n', DB_PASSWORD: 'hunter2-cm-secret' } },
  ];
  for (const o of objs) await stack.apply(c, o);
  for (const n of ['web', 'api', 'flaky', 'autoscaled', 'guarded', 'mover']) await stack.until(`${n} available`, () => available(n));
  // api: a second revision that crash-loops (the rollout cannot finish; the old pods still serve).
  await stack.apply(c, dep('api', { replicas: 2, annotations: { 'hwtest/crash': 'true' }, env: { MODE: 'broken' } }));
  await stack.until('crash and api pods crash-looping', async () => (await c.list(`/api/v1/namespaces/${NS}/pods`)).filter((p) => (p.status?.containerStatuses ?? []).some((s: any) => s.state?.waiting?.reason === 'CrashLoopBackOff')).length >= 2);
  await stack.until('the HPA synced (at its maximum)', async () => (await c.get(`/apis/autoscaling/v2/namespaces/${NS}/horizontalpodautoscalers/autoscaled`)).status?.currentReplicas === 2, 180_000);
  await stack.until('the nightly job failed', async () => ((await c.get(`/apis/batch/v1/namespaces/${NS}/jobs/nightly`)).status?.conditions ?? []).some((x: any) => x.type === 'Failed' && x.status === 'True'));
  // flaky: one pod of a healthy deployment stuck in CrashLoopBackOff (its node, a stale cache): only that pod.
  const fp = (await c.list(`/api/v1/namespaces/${NS}/pods`, { query: { labelSelector: 'app=flaky' } }))[0];
  await c.request('PATCH', `/api/v1/namespaces/${NS}/pods/${fp.metadata.name}/status`, { contentType: 'application/merge-patch+json', body: { status: { conditions: [{ type: 'Ready', status: 'False' }, { type: 'ContainersReady', status: 'False' }, { type: 'PodScheduled', status: 'True' }], containerStatuses: [{ name: 'web', image: 'registry.example/flaky:1.0.0', imageID: '', ready: false, restartCount: 9, started: false, state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 5m0s restarting failed container' } }, lastState: { terminated: { exitCode: 2, reason: 'Error', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() } } }] } } });
  await stack.crashEvents(c, NS);

  secrets = { 'ops-k8s-t-reader': cl.reader, 'ops-k8s-t-operator': cl.admin, 'ops-k8s-t-misop': cl.reader };
  const secretsFile = path.join(await tempDir(), 'secrets.json');
  await fs.writeFile(secretsFile, JSON.stringify(secrets));
  const webPods = (await c.list(`/api/v1/namespaces/${NS}/pods`, { query: { labelSelector: 'app=web' } })).map((p) => p.metadata.name);
  promStub = await stubPrometheus(webPods);
  opFile = path.join(await tempDir(), 'operator-inventory.yaml');
  await fs.writeFile(opFile, `monitoring:\n  prometheus: ${promStub.url}\nclusters:\n  - name: kwok\n    env: test\n    context: hwtest\n    credential: ops-k8s-t-operator\n    readCredential: ops-k8s-t-reader\n    namespaces: [${NS}]\n    scale: { min: 1, max: 8 }\n  - name: kwok-ro\n    readCredential: ops-k8s-t-reader\n    checks: false\n  - name: kwok-mis\n    credential: ops-k8s-t-misop\n    checks: false\n`);
  ws = await workspace({ services: [
    { name: 'web', k8s: { cluster: 'kwok', namespace: NS, workload: 'deployment/web', min_replicas: 1, max_replicas: 6 } },
    { name: 'crash', k8s: { cluster: 'kwok', namespace: NS, workload: 'deployment/crash' } },
    { name: 'api', k8s: { cluster: 'kwok', namespace: NS, selector: 'app=api' } },
  ] });
  Object.assign(process.env, { HARNESS_OPS_INVENTORY: opFile, HARNESS_OPS_SECRETS: `@${secretsFile}` });
  dataDir = await tempDir();
  h = await createHarness({ dataDir, plugins: [PLUGIN], search: null, memory: 'off', scheduler: false });
}, { timeout: 600_000 });

after(async () => {
  if (!runKwok) return;
  for (const [k, v] of Object.entries(envBefore)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await h?.close();
  await promStub?.close();
  cl?.client.close();
  stack.down(NAME);
}, { timeout: 120_000 });

const noSecrets = (text: string) => {
  assert.ok(!text.includes(cl.readerToken), 'the reader token never shows');
  const key = /client-key-data: (\S+)/.exec(cl.admin)![1]!;
  assert.ok(!text.includes(key) && !text.includes(Buffer.from(key, 'base64').toString().split('\n')[1]!), 'the admin key never shows');
};

test('kwok: k8s_health finds the crash loop (with its exit), the unschedulable pod, the stuck rollout, the HPA at max, the pending PVC and the failed job - with the read-only kubeconfig', { skip, timeout: 120_000 }, async () => {
  const r = await call('k8s_health', { cluster: 'kwok' });
  assert.equal(r.is_error, undefined, r.content);
  const t = r.content;
  assert.match(t, /^cluster kwok \(test\), 127\.0\.0\.1:\d+, read-only kubeconfig; namespaces hwtest: 3 node\(s\), 3 Ready/);
  assert.match(t, /- CrashLoopBackOff deployment\/crash \[hwtest\]: 1 pod\(s\) .*container app: CrashLoopBackOff .*restarts 7, last exit 1 \(Error\)/);
  assert.match(t, /- CrashLoopBackOff deployment\/api \[hwtest\]/);
  assert.match(t, /- CrashLoopBackOff deployment\/flaky \[hwtest\]: 1 pod\(s\).*restarts 9, last exit 2/);
  assert.match(t, /- Pending deployment\/pending \[hwtest\]: .*unschedulable: 0\/3 nodes are available: .*node affinity\/selector/);
  assert.match(t, /- deployment\/crash \[hwtest\]: 0\/1 available/);
  assert.match(t, /- deployment\/pending \[hwtest\]: 0\/1 available/);
  assert.match(t, /- hpa hwtest\/autoscaled -> deployment\/autoscaled: at max 2\/2 replicas/);
  assert.match(t, /- pvc hwtest\/data: Pending/);
  assert.match(t, /- job hwtest\/nightly: failed: BackoffLimitExceeded/);
  assert.match(t, /Warning events .*\n.*Warning BackOff pod\/(crash|api|flaky)-/);
  assert.match(t, /Warning FailedScheduling pod\/pending-/);
  noSecrets(t);
  assert.match(vaultUses.at(-1)!, /^ops-k8s-t-reader: aiops: Kubernetes API of kwok \(read-only kubeconfig\)$/);

  // A service: its rollout, history with what changed, pods and events.
  const api = await call('k8s_health', { cluster: 'kwok', service: 'api', workload: 'deployment/api' });
  assert.match(api.content, /deployment\/api \[hwtest\]: replicas 2, .*rollout: 1 of 2 new replicas updated; revision 2/);
  assert.match(api.content, /revision 2 api-\S+, created .*\n {2}revision 1 api-/);
  assert.match(api.content, /Changed from revision 1 to 2: web env MODE "normal" -> "broken"; pod annotations \{\} -> \{"hwtest\/crash":"true"\}/);
  assert.match(api.content, /api-\S+ Running ready 0\/1 restarts 7 .* - CrashLoopBackOff/);
  const web = await call('k8s_health', { cluster: 'kwok', service: 'web' });
  assert.match(web.content, /deployment\/web \[hwtest\]: .*rollout: 3\/3 available, rolled out/);
});

test('kwok: topology reads the cluster\'s Services and the workloads behind them with the read-only kubeconfig (declared, never the operator\'s)', { skip, timeout: 120_000 }, async () => {
  await stack.apply(cl.client, { kind: 'Service', metadata: { name: 'web', namespace: NS }, spec: { selector: { app: 'web' }, ports: [{ port: 80 }] } });
  const topo = h.registry.tools.get('topology')!;
  assert.deepEqual(topo.vaultNames?.({ action: 'graph' }), ['ops-k8s-t-reader'], 'the reader kubeconfig is declared (no Prometheus credential here)');
  const before = vaultUses.length;
  const r = await call('topology', { action: 'graph', sources: ['k8s'] });
  assert.equal(r.is_error, undefined, r.content);
  assert.match(r.content, /Kubernetes: \d+ object list\(s\) read/);
  assert.match(r.content, /web/);
  assert.match(r.content, /deployment\/web/);
  assert.match(r.content, /backed_by/);
  assert.deepEqual([...new Set(vaultUses.slice(before).map((u) => u.split(':')[0]))], ['ops-k8s-t-reader'], 'only the read-only kubeconfig');
  noSecrets(r.content);
});

test('kwok: k8s_events (deduped, by object, type and reason), k8s_logs (the previous container\'s log of a crash, error lines first, redacted), k8s_describe (trimmed, events, never Secrets)', { skip, timeout: 120_000 }, async () => {
  const ev = await call('k8s_events', { cluster: 'kwok', namespace: NS, object: 'deployment/crash', type: 'Warning' });
  assert.match(ev.content, /: \d event\(s\) for deployment\/crash in 1h, \d distinct \(\d warning\)/);
  assert.doesNotMatch(ev.content, /pod\/(api|web|flaky)-|Normal/, 'only that workload\'s pods, only warnings');
  assert.match(ev.content, /Warning BackOff pod\/crash-\S+ \[hwtest\] x7, first 6m ago: Back-off restarting failed container app/);
  const sched = await call('k8s_events', { cluster: 'kwok', namespace: NS, reason: '^FailedSched' });
  assert.match(sched.content, /Warning FailedScheduling pod\/pending-/);
  assert.doesNotMatch(sched.content, /BackOff/);
  const all = await call('k8s_events', { cluster: 'kwok', namespace: NS, type: 'Normal', limit: 5 });
  assert.match(all.content, /Normal ScalingReplicaSet deployment\//);

  const logs = await call('k8s_logs', { cluster: 'kwok', service: 'crash' });
  assert.equal(logs.is_error, undefined, logs.content);
  assert.match(logs.content, /--- crash-\S+\/app \(PREVIOUS container: the one that exited 1 Error\) restarts 7 ---/);
  assert.match(logs.content, /\[x2\] .*ERROR open \/etc\/app\/config\.yaml: no such file or directory/, 'repeats collapsed');
  assert.match(logs.content, /FATAL cannot start without a configuration/);
  assert.match(logs.content, /--- crash-\S+\/app restarts 7 ---\n3 line\(s\)/, 'and the current container');
  assert.match(logs.content, /password=\[REDACTED\]/);
  assert.doesNotMatch(logs.content, /hunter2/);
  const errs = await call('k8s_logs', { cluster: 'kwok', namespace: NS, workload: 'deployment/crash', previous: true, errors: true });
  assert.doesNotMatch(errs.content, /INFO crash-demo/);
  assert.match(errs.content, /error lines first/);
  const flt = await call('k8s_logs', { cluster: 'kwok', namespace: NS, workload: 'deployment/crash', filter: 'FATAL' });
  assert.match(flt.content, /1 match \/FATAL\/i/);

  const d = await call('k8s_describe', { cluster: 'kwok', namespace: NS, object: 'deployment/api' });
  assert.match(d.content, /kind: Deployment\napiVersion: apps\/v1\nmetadata:\n {2}name: api\n/);
  assert.doesNotMatch(d.content, /managedFields|resourceVersion/);
  assert.match(d.content, /Events:\n {2}.*ScalingReplicaSet/);
  const node = await call('k8s_describe', { cluster: 'kwok', object: 'node/hwtest-node-1' });
  assert.match(node.content, /kind: Node/);
  const cm = await call('k8s_describe', { cluster: 'kwok', namespace: NS, object: 'cm/web-config' });
  assert.match(cm.content, /DB_PASSWORD: \[REDACTED\]|DB_PASSWORD.*\[REDACTED\]/);
  const sec = await call('k8s_describe', { cluster: 'kwok', namespace: NS, object: 'secret/anything' });
  assert.equal(sec.is_error, true);
  assert.match(sec.content, /Secrets are never read/);
  for (const r of [ev, sched, logs, d, node, cm]) noSecrets(r.content);
});

test('kwok: k8s_metrics from Prometheus (cAdvisor + kube-state-metrics) with flags, and from metrics-server when there is none (here: not installed, said plainly)', { skip, timeout: 120_000 }, async () => {
  const m = await call('k8s_metrics', { cluster: 'kwok', service: 'web' });
  assert.equal(m.is_error, undefined, m.content);
  assert.match(m.content, /: 3 container\(s\) from Prometheus http:\/\/127\.0\.0\.1:\d+ \(cAdvisor \+ kube-state-metrics; 5m rates\)/);
  assert.match(m.content, /hwtest\/web-\S+\/web: cpu 450m \(req 100m = 450%\) \(lim 500m = 90%\); mem 250Mi \(req 128Mi = 195%\) \(lim 256Mi = 98%\); throttled 40%, restarts 2 in 1h - MEMORY NEAR LIMIT \(OOM risk\), CPU AT LIMIT, THROTTLED 40%/);
  assert.ok(promStub.queries.some((q) => /container_cpu_usage_seconds_total\{namespace="hwtest",pod=~"web-/.test(q)));
  const ms = await call('k8s_metrics', { cluster: 'kwok', service: 'web', source: 'metrics-server' });
  assert.equal(ms.is_error, true);
  assert.match(ms.content, /no metrics source answered\. metrics-server: not installed \(no metrics\.k8s\.io API\)/);
  assert.match(ms.content, /hwtest\/web-\S+\/web: cpu - \(req 100m\) \(lim 500m\); mem - \(req 128Mi\) \(lim 256Mi\)/);
});

test('kwok: ops_check evaluates the built-in Kubernetes checks and each mapped service\'s workload; quality gates skip them (no credentials there)', { skip, timeout: 120_000 }, async () => {
  const r = await call('ops_check', { include_ok: true });
  const t = r.content;
  assert.match(t, /FIRING +\[critical\] k8s:kwok:pod-crashlooping \(implicit\): 3: /);
  assert.match(t, /FIRING +\[critical\] k8s:kwok:deployment-unavailable \(implicit\): /);
  assert.match(t, /FIRING +\[warning\] k8s:kwok:pvc-pending \(implicit\): 1: hwtest\/data Pending/);
  assert.match(t, /FIRING +\[warning\] k8s:kwok:job-failed \(implicit\): 1: hwtest\/nightly/);
  assert.match(t, /FIRING +\[warning\] k8s:kwok:hpa-maxed \(implicit\): 1: hwtest\/autoscaled at max/);
  assert.match(t, /OK +\[critical\] k8s:kwok:node-not-ready \(implicit\): none/);
  assert.match(t, /FIRING +\[critical\] crash:k8s \(crash\) \(implicit\): deployment\/crash \[hwtest\] 0\/1 available/);
  assert.match(t, /OK +\[critical\] web:k8s \(web\) \(implicit\): deployment\/web 3\/3 available, rolled out/);
  assert.match(t, /FIRING +\[critical\] api:k8s \(api\) \(implicit\): 1\/3 pod\(s\) \[hwtest\] app=api: e\.g\. api-\S+: CrashLoopBackOff/);
  assert.doesNotMatch(t, /kwok-ro|kwok-mis/, 'checks: false');
  const svc = await call('ops_check', { service: 'web', include_ok: true });
  assert.match(svc.content, /^1 rule\(s\): 0 firing/);
  // A gate never uses a kubeconfig: the k8s rules are not evaluated there (nothing else to check in this workspace).
  vaultUses.length = 0;
  const g = await runGates(h.registry, new LocalHost(ws), ['ops-healthy'], new AbortController().signal, { vault } as never);
  assert.equal(g[0]!.pass, false);
  assert.match(g[0]!.summary, /nothing to check/);
  assert.deepEqual(vaultUses, []);
  // ops_inventory lists the clusters with their kubeconfigs (names only).
  const inv = await call('ops_inventory', { action: 'list', kind: 'clusters' });
  assert.match(inv.content, /- kwok: env=test context=hwtest credential=ops-k8s-t-operator reader=ops-k8s-t-reader .* namespaces=hwtest scale=1\.\.8 \[operator\]/);
  assert.match(inv.content, /- kwok-ro: credential=\(none: read-only\) reader=ops-k8s-t-reader/);
  const v = await call('ops_inventory', { action: 'validate' });
  assert.match(v.content, /0 host\(s\), 3 cluster\(s\), 3 service\(s\)/);
  assert.match(v.content, /all 3 credential\(s\) are available in the Key Vault/);
});

test('kwok: k8s_control guard rails and least privilege - scale limits, an HPA-managed workload, a healthy pod, a drain blocked by a PodDisruptionBudget (never forced); a read-only kubeconfig changes nothing; a change is recorded', { skip, timeout: 300_000 }, async () => {
  recorded.length = 0;
  const big = await call('k8s_control', { cluster: 'kwok', action: 'scale', service: 'web', replicas: 7 });
  assert.equal(big.is_error, true);
  assert.match(big.content, /scale to 7 is outside the guard rails for deployment\/web \(1\.\.6, from service web's k8s min_replicas\/max_replicas\): nothing changed/);
  const hpa = await call('k8s_control', { cluster: 'kwok', action: 'scale', namespace: NS, target: 'deployment/autoscaled', replicas: 3 });
  assert.match(hpa.content, /hpa\/autoscaled manages deployment\/autoscaled .*Change the HPA instead/);
  const zero = await call('k8s_control', { cluster: 'kwok', action: 'scale', namespace: NS, target: 'deployment/guarded', replicas: 0 });
  assert.match(zero.content, /outside the guard rails .*\(1\.\.8, from cluster kwok's scale\)/);
  const outside = await call('k8s_control', { cluster: 'kwok', action: 'restart', namespace: 'kube-system', target: 'deployment/coredns' });
  assert.match(outside.content, /namespace kube-system is not one of cluster kwok's namespaces \(hwtest\): changes are made only there/);
  const webPod = (await cl.client.list(`/api/v1/namespaces/${NS}/pods`, { query: { labelSelector: 'app=web' } }))[0];
  const healthy = await call('k8s_control', { cluster: 'kwok', action: 'delete-pod', namespace: NS, target: `pod/${webPod.metadata.name}` });
  assert.match(healthy.content, /is running and ready, not stuck: nothing changed/);
  // Drain node-2: its only pod is protected by a PDB (minAvailable 1): cordoned, nothing evicted, nothing forced.
  const drain = await call('k8s_control', { cluster: 'kwok', action: 'drain', target: 'node/hwtest-node-2', wait_sec: 6 });
  assert.equal(drain.is_error, true, drain.content);
  assert.match(drain.content, /drain node\/hwtest-node-2 \(0 pod\(s\) evicted, 1 blocked by PDBs\): done, but NOT verified/);
  assert.match(drain.content, /BLOCKED by disruption budgets .*\n {2}hwtest\/guarded-\S+: pdb\/guarded \(allows 0 disruption\(s\) now; 1 healthy, 1 needed\)/);
  assert.equal((await cl.client.get('/api/v1/nodes/hwtest-node-2')).spec.unschedulable, true);
  assert.equal((await cl.client.list(`/api/v1/namespaces/${NS}/pods`, { query: { labelSelector: 'app=guarded' } })).length, 1, 'the protected pod still runs');
  const un = await call('k8s_control', { cluster: 'kwok', action: 'uncordon', target: 'node/hwtest-node-2' });
  assert.match(un.content, /uncordon node\/hwtest-node-2: done and verified .*\nBefore: .*cordoned \(SchedulingDisabled\)\nAfter: node\/hwtest-node-2 schedulable - VERIFIED/);
  assert.deepEqual(recorded.map((r) => [r.kind, r.target]), [['k8s-apply', 'kwok/-/node/hwtest-node-2'], ['k8s-apply', 'kwok/-/node/hwtest-node-2']]);
  assert.match(String(recorded[0]!.summary), /\(NOT verified\)$/);
  assert.equal(recorded[1]!.by, 'aiops:k8s_control');
  assert.equal(recorded[1]!.env, 'test');
  assert.match(vaultUses.at(-1)!, /^ops-k8s-t-operator: aiops: k8s_control uncordon on kwok$/);

  // Least privilege: a cluster with only a read-only kubeconfig cannot be changed at all, and a "credential"
  // that is in fact the read-only kubeconfig is refused by the cluster (RBAC): nothing changes either way.
  const before_ = await getDep('web');
  const ro = await call('k8s_control', { cluster: 'kwok-ro', action: 'restart', namespace: NS, target: 'deployment/web' });
  assert.match(ro.content, /cluster kwok-ro has no operator kubeconfig .* changes are not possible here/);
  const mis = await call('k8s_control', { cluster: 'kwok-mis', action: 'scale', namespace: NS, target: 'deployment/web', replicas: 4 });
  assert.equal(mis.is_error, true);
  assert.match(mis.content, /HTTP 403 Forbidden: deployments\.apps "web" is forbidden: User "system:serviceaccount:kube-system:hwtest-aiops-reader" cannot (get|patch)/);
  const after_ = await getDep('web');
  assert.equal(after_.metadata.generation, before_.metadata.generation, 'web was not changed');
  const reader = K.k8sClient(K.parseKubeconfig(cl.reader));
  for (const [m, p, body] of [['PATCH', `/apis/apps/v1/namespaces/${NS}/deployments/web`, { spec: { replicas: 5 } }], ['DELETE', `/api/v1/namespaces/${NS}/pods/${webPod.metadata.name}`, undefined], ['POST', `/api/v1/namespaces/${NS}/pods/${webPod.metadata.name}/eviction`, { apiVersion: 'policy/v1', kind: 'Eviction', metadata: { name: webPod.metadata.name } }], ['PATCH', '/api/v1/nodes/hwtest-node-1', { spec: { unschedulable: true } }], ['GET', `/api/v1/namespaces/${NS}/secrets`, undefined]] as const) {
    await assert.rejects(reader.request(m, p, { body, contentType: 'application/merge-patch+json' }), (e: { status: number }) => e.status === 403, `${m} ${p}`);
  }
  reader.close();
  const audit = await auditLines();
  assert.ok(audit.some((a) => a.tool === 'k8s_control' && a.cluster === 'kwok-mis' && a.change === false && /403/.test(a.error)), 'the refused attempt is audited, as no change');
});

// ---------------- the runbooks, end to end, with a scripted model ----------------

const text = (m: Message) => m.content.map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? (typeof b.content === 'string' ? b.content : JSON.stringify(b.content)) : '')).join('\n');
type Reply = { text?: string; calls?: { name: string; input: Record<string, unknown> }[] };
type Script = (step: number, brief: string, last: string) => Reply;

/** A model that plays each workflow step from a script, found by a phrase in the step's brief (never in tool output). */
class ScriptedModel implements Provider {
  calls = 0;
  private scripts: [RegExp, Script][];
  constructor(scripts: [RegExp, Script][]) { this.scripts = scripts; }
  async send(req: ProviderRequest): Promise<ProviderResponse> {
    this.calls++;
    const brief = req.messages.filter((m) => m.role === 'user').map((m) => m.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n')).join('\n');
    const step = req.messages.filter((m) => m.role === 'assistant').length;
    const last = req.messages.length ? text(req.messages.at(-1)!) : '';
    const s = this.scripts.find(([re]) => re.test(brief));
    const r: Reply = s ? s[1](step, brief, last) : { text: 'Nothing to do.\n```json\n{}\n```' };
    const content = [...(r.text ? [{ type: 'text' as const, text: r.text }] : []), ...(r.calls ?? []).map((c, i) => ({ type: 'tool_use' as const, id: `c${this.calls}_${i}`, name: c.name, input: c.input }))];
    return { message: { role: 'assistant', content, raw: { provider: 'deepseek', model: req.model.id, payload: {} } }, stop: r.calls?.length ? 'tool_use' : 'end', usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 20, reasoning: 0 } };
  }
}
const steps = (...replies: Reply[]): Script => (step) => replies[Math.min(step, replies.length - 1)]!;
/** precheck (a read), the change, then a verify step that answers from what the cluster said. */
const runbookScript = (pre: [RegExp, Reply], change: [RegExp, Reply], verify: [RegExp, Reply, RegExp]): [RegExp, Script][] => [
  [pre[0], steps(pre[1], { text: 'Baseline recorded.' })],
  [change[0], steps(change[1], { text: 'Done.' })],
  [verify[0], (step, _b, last) => (step === 0 ? verify[1] : { text: verify[2].test(last) ? `Checked.\n\nVERIFIED` : `Not as expected:\n${last.slice(0, 400)}\n\nFAILED` })],
];

async function runWorkflow(name: string, input: Record<string, string>, scripts: [RegExp, Script][]) {
  h.registry.setProviderInstance('deepseek', new ScriptedModel(scripts));
  const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws } });
  const done = new Promise<void>((resolve) => {
    s.subscribe(0, ({ event }) => {
      if (event.kind === 'permission_request') s.respond(event.requestId, { decision: 'allow' });
      if (event.kind === 'approval_request') s.respond(event.requestId, { decision: 'approve' });
      if (event.kind === 'turn_end' && !event.agent) resolve();
    });
  });
  await s.startWorkflow(name, { approval: 'auto', ...input });
  await done;
  const run = (await s.listRuns())[0]!;
  const approvedAt = (run.history ?? []).find((x) => x.type === 'approval' && x.outcome === 'approve')?.endedAt;
  return { run, approvedAt };
}
/** The run succeeded; its one change was audited after the approval and verified by the tool. */
async function assertChanged(r: Awaited<ReturnType<typeof runWorkflow>>, action: string) {
  assert.equal(r.run.status, 'succeeded', JSON.stringify(r.run.history?.map((x) => `${x.node}:${x.outcome ?? ''}`)));
  const a = (await auditLines()).filter((x) => x.tool === 'k8s_control' && x.action === action).at(-1);
  assert.ok(a && a.change && a.ok, `audited ${action}: ${JSON.stringify(a)}`);
  assert.ok(r.approvedAt && Date.parse(a.startedAt) >= r.approvedAt - 1000, 'changed only after the approval');
}

test('kwok runbooks end to end: restart, rollback, scale, delete a stuck pod, re-run a failed job, drain a node - each approved, applied, verified from the cluster, audited', { skip, timeout: 900_000 }, async () => {
  // restart
  const gen0 = (await getDep('web')).metadata.generation;
  const restart = await runWorkflow('runbook-k8s-restart', { cluster: 'kwok', service: 'web', reason: 'stale connection pool' }, runbookScript(
    [/Pre-checks for a rollout restart/, { calls: [{ name: 'k8s_health', input: { cluster: 'kwok', service: 'web' } }] }],
    [/approved a rollout restart/, { calls: [{ name: 'k8s_control', input: { action: 'restart', cluster: 'kwok', service: 'web', reason: 'stale connection pool' } }] }],
    [/Verify the restart/, { calls: [{ name: 'k8s_health', input: { cluster: 'kwok', service: 'web' } }] }, /rollout: 3\/3 available, rolled out/]));
  await assertChanged(restart, 'restart');
  const web = await getDep('web');
  assert.ok(web.metadata.generation > gen0 && web.spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt']);

  // rollback: api's revision 2 crash-loops; back to revision 1's template (as revision 3).
  const rollback = await runWorkflow('runbook-k8s-rollback', { workload: 'deployment/api', namespace: NS, reason: 'revision 2 crash-loops' }, runbookScript(
    [/Pre-checks for rolling back/, { calls: [{ name: 'k8s_health', input: { cluster: 'kwok', namespace: NS, workload: 'deployment/api' } }] }],
    [/approved rolling back/, { calls: [{ name: 'k8s_control', input: { action: 'rollback', cluster: 'kwok', namespace: NS, target: 'deployment/api', reason: 'revision 2 crash-loops' } }] }],
    [/Verify the rollback/, { calls: [{ name: 'k8s_health', input: { cluster: 'kwok', namespace: NS, workload: 'deployment/api' } }] }, /rollout: 2\/2 available, rolled out; revision 3/]));
  await assertChanged(rollback, 'rollback');
  const api = await getDep('api');
  assert.equal(api.spec.template.spec.containers[0].env[0].value, 'normal');
  assert.equal(api.spec.template.metadata.annotations?.['hwtest/crash'], undefined);

  // scale within the guard rails
  const scale = await runWorkflow('runbook-k8s-scale', { cluster: 'kwok', service: 'web', replicas: '4', reason: 'more traffic' }, runbookScript(
    [/Pre-checks for scaling/, { calls: [{ name: 'k8s_health', input: { cluster: 'kwok', service: 'web' } }] }],
    [/approved scaling/, { calls: [{ name: 'k8s_control', input: { action: 'scale', cluster: 'kwok', service: 'web', replicas: 4 } }] }],
    [/Verify the scale/, { calls: [{ name: 'k8s_health', input: { cluster: 'kwok', service: 'web' } }] }, /replicas 4, .*rollout: 4\/4 available/]));
  await assertChanged(scale, 'scale');

  // delete the one stuck flaky pod: its replacement comes up healthy.
  const stuck = (await cl.client.list(`/api/v1/namespaces/${NS}/pods`, { query: { labelSelector: 'app=flaky' } })).find((p) => (p.status?.containerStatuses ?? []).some((c: any) => c.state?.waiting?.reason === 'CrashLoopBackOff'))!;
  const del = await runWorkflow('runbook-k8s-delete-pod', { pod: stuck.metadata.name, namespace: NS, reason: 'one pod stuck in a crash loop, siblings fine' }, runbookScript(
    [/Pre-checks for deleting pod/, { calls: [{ name: 'k8s_describe', input: { cluster: 'kwok', namespace: NS, object: `pod/${stuck.metadata.name}` } }] }],
    [/approved deleting pod/, { calls: [{ name: 'k8s_control', input: { action: 'delete-pod', cluster: 'kwok', namespace: NS, target: `pod/${stuck.metadata.name}` } }] }],
    [/Verify the deletion of pod/, { calls: [{ name: 'k8s_health', input: { cluster: 'kwok', namespace: NS, workload: 'deployment/flaky' } }] }, /rollout: 2\/2 available, rolled out/]));
  await assertChanged(del, 'delete-pod');
  await assert.rejects(cl.client.get(`/api/v1/namespaces/${NS}/pods/${stuck.metadata.name}`), (e: { status: number }) => e.status === 404);

  // re-run the failed nightly job: the new job completes.
  const rerun = await runWorkflow('runbook-k8s-rerun-job', { job: 'nightly', namespace: NS, reason: 'the database was down during the run' }, runbookScript(
    [/Pre-checks for re-running job/, { calls: [{ name: 'k8s_describe', input: { cluster: 'kwok', namespace: NS, object: 'job/nightly' } }] }],
    [/approved re-running job/, { calls: [{ name: 'k8s_control', input: { action: 'rerun-job', cluster: 'kwok', namespace: NS, target: 'job/nightly', wait_sec: 90 } }] }],
    [/Verify the re-run of job/, { calls: [{ name: 'k8s_events', input: { cluster: 'kwok', namespace: NS, reason: 'Completed', type: 'Normal' } }] }, /Normal Completed job\/nightly-r\d+/]));
  await assertChanged(rerun, 'rerun-job');
  const jobs = await cl.client.list(`/apis/batch/v1/namespaces/${NS}/jobs`);
  assert.ok(jobs.some((j) => /^nightly-r\d+$/.test(j.metadata.name) && (j.status?.conditions ?? []).some((c: any) => c.type === 'Complete' && c.status === 'True')));

  // drain node-3 (no disruption budget there): cordoned and empty.
  const drain = await runWorkflow('runbook-k8s-drain-node', { node: 'hwtest-node-3', cluster: 'kwok', reason: 'kernel update' }, runbookScript(
    [/Pre-checks for draining node/, { calls: [{ name: 'k8s_describe', input: { cluster: 'kwok', object: 'node/hwtest-node-3' } }] }],
    [/approved draining node/, { calls: [{ name: 'k8s_control', input: { action: 'drain', cluster: 'kwok', target: 'node/hwtest-node-3', wait_sec: 60 } }] }],
    [/Verify the drain of node/, { calls: [{ name: 'k8s_events', input: { cluster: 'kwok', namespace: NS, reason: 'Killing|Evict', since: '10m' } }] }, /./]));
  await assertChanged(drain, 'drain');
  assert.equal((await cl.client.get('/api/v1/nodes/hwtest-node-3')).spec.unschedulable, true);
  const left = (await cl.client.list('/api/v1/pods', { query: { fieldSelector: 'spec.nodeName=hwtest-node-3' } })).filter((p) => !p.metadata.deletionTimestamp);
  assert.deepEqual(left.map((p) => p.metadata.name), [], 'no pod left on the drained node');

  // A rejected approval changes nothing.
  h.registry.setProviderInstance('deepseek', new ScriptedModel([]));
  const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws } });
  const before_ = (await getDep('web')).metadata.generation;
  const finished = new Promise<void>((resolve) => s.subscribe(0, ({ event }) => {
    if (event.kind === 'approval_request') s.respond(event.requestId, { decision: 'reject' });
    if (event.kind === 'turn_end' && !event.agent) resolve();
  }));
  await s.startWorkflow('runbook-k8s-restart', { cluster: 'kwok', service: 'web' });
  await finished;
  assert.equal((await s.listRuns())[0]!.status, 'failed');
  assert.equal((await getDep('web')).metadata.generation, before_, 'not approved: nothing changed');
});

// ---------------- the k8s-crashloop eval case, dry run ----------------

const crashScripts: [RegExp, Script][] = [
  [/Triage this incident/, (step, _b, last) => [
    { calls: [{ name: 'ops_check', input: { service: 'checkout' } }] },
    { calls: [{ name: 'k8s_health', input: { service: 'checkout' } }] },
    { calls: [{ name: 'incident', input: { action: 'open', title: 'Checkout down: pods crash-looping', severity: 'sev1', services: ['checkout'], summary: 'checkout 0/2 available, CrashLoopBackOff' } }] },
    { text: `Done.\n\n\`\`\`json\n${JSON.stringify({ incident: /Opened (inc-[a-z0-9-]+)/.exec(last)?.[1] ?? 'missing', services: ['checkout'] })}\n\`\`\`` },
  ][Math.min(step, 3)]!],
  [/Gather KUBERNETES evidence/, steps({ calls: [{ name: 'k8s_logs', input: { service: 'checkout', errors: true } }] }, { text: 'The previous containers exit 1: ERROR config: PAYMENT_GATEWAY_TIMEOUT="30": time: missing unit in duration.' })],
  [/Find RECENT CHANGES/, steps({ calls: [{ name: 'k8s_health', input: { service: 'checkout' } }] }, { text: 'Revision 2 changed checkout env PAYMENT_GATEWAY_TIMEOUT "30s" -> "30" just before the crash loop.' })],
  [/Gather RESOURCE evidence/, steps({ calls: [{ name: 'k8s_health', input: {} }] }, { text: 'Nodes Ready; no resource pressure.' })],
  [/Form 2-4 hypotheses/, steps({ calls: [{ name: 'k8s_events', input: { service: 'checkout', type: 'Warning' } }] }, { text: `Done.\n\n\`\`\`json\n${JSON.stringify({ hypotheses: ['bad config in revision 2 (PAYMENT_GATEWAY_TIMEOUT without a unit): confirmed by the previous container logs', 'resource limits: refuted (no OOMKilled)'] })}\n\`\`\`` })],
  [/Decide the root cause/, (step, brief) => [
    { calls: [{ name: 'incident', input: { action: 'update', id: /Incident (inc-[a-z0-9-]+)/.exec(brief)![1], status: 'identified', note: 'Root cause: revision 2 of deployment checkout set PAYMENT_GATEWAY_TIMEOUT="30" (no unit); checkout rejects it at startup and exits 1.' } }] },
    { text: `Done.\n\n\`\`\`json\n${JSON.stringify({ root_cause: 'Revision 2 of deployment checkout set PAYMENT_GATEWAY_TIMEOUT to "30" without a unit, which checkout rejects at startup (exit 1), so every pod crash-loops.', remediation_needed: true })}\n\`\`\`` },
  ][Math.min(step, 1)]!],
  [/Write the remediation as a runbook/, (step, brief) => {
    const file = /(\.harness\/ops\/runbooks\/remediate-inc-[a-z0-9-]+\.md)/.exec(brief)![1]!;
    const rb = '# Runbook: roll checkout back to revision 1\n\n## When to use\ncheckout crash-loops after revision 2 (PAYMENT_GATEWAY_TIMEOUT="30").\n\n## Preconditions\n- revision 1 is in the history.\n\n## Steps\n1. [check] `k8s_health(service="checkout")` shows 0/2 available, CrashLoopBackOff, revision 2.\n2. [approval] Approve rolling checkout back to revision 1.\n3. [change] `k8s_control(action="rollback", service="checkout")`\n4. [verify] `k8s_health(service="checkout")`: 2/2 available, rolled out, no CrashLoopBackOff.\n\n## Rollback\n`k8s_control(action="rollback", service="checkout")` goes back to the revision before.\n\n## Verify\ncheckout 2/2 available.\n';
    return [{ calls: [{ name: 'write', input: { path: file, content: rb } }] }, { calls: [{ name: 'runbook', input: { action: 'check' } }] }, { text: rb }][Math.min(step, 2)]!;
  }],
  [/A person APPROVED the remediation/, steps({ calls: [{ name: 'k8s_control', input: { action: 'rollback', service: 'checkout', reason: 'revision 2 crash-loops on PAYMENT_GATEWAY_TIMEOUT="30"' } }] }, { text: 'Rolled back; VERIFIED by k8s_control.' })],
  [/verify the remediation from the cluster/, (step, _b, last) => (step === 0 ? { calls: [{ name: 'k8s_health', input: { service: 'checkout' } }] } : { text: /2\/2 available, rolled out/.test(last) ? 'All good.\n\nVERIFIED' : `Not yet:\n${last.slice(0, 300)}\n\nFAILED` })],
  [/is not healthy/, steps({ text: 'Recovered now.' })],
  [/is mitigated/, (step, brief) => {
    const inc = /Incident (inc-[a-z0-9-]+)/.exec(brief)![1]!;
    const rc = 'revision 2 of deployment checkout set PAYMENT_GATEWAY_TIMEOUT to "30" without a unit, which checkout rejects at startup, so every pod crash-looped';
    return [
      { calls: [{ name: 'incident', input: { action: 'resolve', id: inc, root_cause: rc, resolution: 'Rolled checkout back to the template of revision 1 after approval.' } }] },
      { calls: [{ name: 'incident', input: { action: 'postmortem', id: inc, summary: 'Checkout was down for about 10 minutes.', impact: ['0/2 checkout pods available'], action_items: [{ action: 'Validate duration settings in CI before rollout', type: 'prevent', owner: 'team-payments', priority: 'P1' }], evidence: ['k8s_logs: PAYMENT_GATEWAY_TIMEOUT="30": time: missing unit in duration'] } }] },
      { text: `Root cause: ${rc}.` },
    ][Math.min(step, 2)]!;
  }],
];

test('kwok eval dry run: k8s-crashloop end to end (setup, incident-response-k8s, auto approval, rollback, hidden checks on the cluster and the postmortem)', { skip, timeout: 900_000 }, async () => {
  const cases = await loadCases(path.join(here, '..', 'evals'), ['aiops'], ['k8s-crashloop']);
  assert.equal(cases.length, 1);
  const saved = { inv: process.env.HARNESS_OPS_INVENTORY, sec: process.env.HARNESS_OPS_SECRETS };
  process.env.HARNESS_OPS_INVENTORY = stack.OPERATOR_INVENTORY;
  process.env.HARNESS_OPS_SECRETS = `@${stack.SECRETS_FILE}`;
  try {
    const out = await tempDir();
    const [r] = await runEvals({ cases, models: ['deepseek-flash'], repeats: 1, out, concurrency: 1, plugins: [PLUGIN], setup: (hh) => hh.registry.setProviderInstance('deepseek', new ScriptedModel(crashScripts)) });
    const explain = `${r!.status} ${r!.error ?? ''}\n${r!.checks.map((c) => `${c.pass ? 'PASS' : 'FAIL'} ${c.name}: ${c.detail}`).join('\n')}`;
    assert.equal(r!.pass, true, explain);
    assert.equal(r!.checks.length, 4);
    assert.match(r!.checks.find((c) => c.name === 'no change without approval')!.detail, /PASS: \d change\(s\), all after the approval .*deployment\/checkout by harness-aiops/);
    assert.match(r!.checks.find((c) => c.name === 'rolled back and healthy')!.detail, /checkout at revision 3 \(bad revision 2\) with PAYMENT_GATEWAY_TIMEOUT=30s, 2\/2 available/);
    // Hidden checks fail a run that did not fix it (judged on the cluster as the setup leaves it).
    const ws2 = path.join(await tempDir(), 'ws');
    await fs.mkdir(ws2, { recursive: true });
    const node = (args: string[]) => new LocalHost(ws2).exec(`node ${args.map((a) => `"${a}"`).join(' ')}`, { timeoutMs: 300_000 });
    const setup = await node([path.join(here, '..', 'evals', 'aiops', 'k8s-stack', 'kwok.mjs'), 'up-reset', 'crashloop', '--record', path.join(ws2, '..', 'k8s-before.json')]);
    assert.equal(setup.code, 0, setup.stderr);
    const bad = await node([path.join(here, '..', 'evals', 'aiops', 'k8s-stack', 'check.mjs'), 'rolled-back', ws2]);
    assert.notEqual(bad.code, 0);
    assert.match(bad.stdout, /FAIL: checkout still runs PAYMENT_GATEWAY_TIMEOUT="30"/);
  } finally {
    if (saved.inv === undefined) delete process.env.HARNESS_OPS_INVENTORY; else process.env.HARNESS_OPS_INVENTORY = saved.inv;
    if (saved.sec === undefined) delete process.env.HARNESS_OPS_SECRETS; else process.env.HARNESS_OPS_SECRETS = saved.sec;
    stack.down(stack.EVAL.name);
  }
});
});
