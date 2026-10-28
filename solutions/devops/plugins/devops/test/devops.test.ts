import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runGates, shippedPlugins } from '@harness/plugin-sdk/testing';
import { newRun, WorkflowRunner } from '@harness/plugin-sdk/testing';
import type { RunRecord, WorkflowHost } from '@harness/plugin-sdk/testing';
import { createHarness } from '@harness/plugin-sdk/testing';
import { dockerAvailable, imageExists } from '@harness/plugin-sdk/testing';
import { type ExecOptions, type ExecResult, LocalHost, run, type ToolHost } from '@harness/plugin-sdk/testing';
import type { ToolContext } from '@harness/plugin-sdk/testing';
import { tempDir } from '@harness/plugin-sdk/testing';
import { HARNESS_ROOT } from '@harness/plugin-sdk/runtime';

// The devops plugin. Unit tests need nothing; the GitHub tests use a local
// mock of the API; the integration tests run the real programs inside the ops
// sandbox image (npm run sandbox:image:ops) in containers named hwtest-...;
// the compose deploy test talks to this machine's Docker daemon; the
// Kubernetes test makes a real kind cluster (HARNESS_TEST_KIND=1, minutes).

const here = path.join(HARNESS_ROOT, 'test');
const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = HARNESS_ROOT;
// @ts-expect-error plain JS module
const C = await import('../lib/common.mjs');
// @ts-expect-error plain JS module
const IAC = await import('../lib/iac.mjs');
// @ts-expect-error plain JS module
const K8S = await import('../lib/k8s.mjs');
// @ts-expect-error plain JS module
const CI = await import('../lib/ci.mjs');
// @ts-expect-error plain JS module
const CT = await import('../lib/container.mjs');
// @ts-expect-error plain JS module
const DP = await import('../lib/deploy.mjs');
// @ts-expect-error plain JS module
const plugin = (await import('../index.mjs')) as { tools(api: unknown): { spec: { name: string }; run(i: Record<string, unknown>, c: ToolContext): Promise<{ content: string; is_error?: boolean; untrusted?: boolean }>; summarize(i: Record<string, unknown>): string; kindsFor?(i: Record<string, unknown>): string[]; sendsOut?: unknown }[] };

const OPS_IMAGE = 'harness-sandbox-ops:latest';
const hasDocker = await dockerAvailable();
const hasOps = hasDocker && (await imageExists(OPS_IMAGE));
const skipOps = !hasOps && `no Docker or no ${OPS_IMAGE} (npm run sandbox:image && npm run sandbox:image:ops)`;
C.runner.prefix = 'hwtest-devops-';

/** A Key Vault stand-in with the framework's contract; records every use. */
function fakeVault(values: Record<string, string>) {
  const uses: { name: string; purpose: string }[] = [];
  const get = (n: string) => { if (!(n in values)) throw new Error(`no secret ${n}`); return values[n]!; };
  return {
    uses,
    async list() { return Object.keys(values).map((name) => ({ name, kind: 'secret', scope: 'test', updatedAt: 0, backend: 'memory' })); },
    async reveal(name: string, purpose: string) { uses.push({ name, purpose }); return get(name); },
    async envFor(map: Record<string, string>, purpose: string) { return Object.fromEntries(Object.entries(map).map(([k, n]) => { uses.push({ name: n, purpose }); return [k, get(n)]; })); },
  };
}

const ctxOf = (host: ToolHost, vault?: unknown) => ({ host, signal: new AbortController().signal, readFiles: new Map(), todos: [], setTodos() {}, emit() {}, services: vault ? { vault } : {} }) as unknown as ToolContext;
const fakeApi = { fetch: (u: string, i?: RequestInit) => fetch(u, i), secret: (n: string) => process.env[n] };
const toolsByName = Object.fromEntries(plugin.tools(fakeApi).map((t) => [t.spec.name, t]));
const call = (name: string, input: Record<string, unknown>, ctx: ToolContext) => toolsByName[name]!.run(input, ctx);

async function write(dir: string, files: Record<string, string>) {
  for (const [f, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, f)), { recursive: true });
    await fs.writeFile(path.join(dir, f), text);
  }
}

/**
 * A ToolHost whose commands run in a container of the ops image (named
 * hwtest-ops-...), the workspace mounted at /workspace - as a session sandbox.
 */
class OpsHost implements ToolHost {
  kind = 'docker' as const;
  displayRoot = '/workspace';
  platform = 'linux';
  shell = 'bash';
  sandboxed = true;
  networkPolicy: 'none' | 'full' | 'allowlist';
  name = `hwtest-ops-${crypto.randomBytes(4).toString('hex')}`;
  root: string;
  private opts: { network?: string; socket?: boolean };
  constructor(root: string, opts: { network?: string; socket?: boolean } = {}) {
    this.root = root;
    this.opts = opts;
    this.networkPolicy = opts.network && opts.network !== 'none' ? 'full' : 'none';
  }
  async start() {
    const r = await run('docker', [
      'run', '-d', '--init', '--name', this.name, '--network', this.opts.network ?? 'none',
      ...(this.opts.socket ? ['-v', '/var/run/docker.sock:/var/run/docker.sock', '--user', '0:0'] : ['--user', '1000:1000', '--cap-drop', 'ALL']),
      '-e', 'HOME=/tmp/home', '-v', `${this.root}:/workspace`, '-w', '/workspace', OPS_IMAGE, 'sleep', 'infinity',
    ], { timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(r.stderr);
    await run('docker', ['exec', this.name, 'mkdir', '-p', '/tmp/home'], { timeoutMs: 30_000 });
    return this;
  }
  async exec(cmd: string, opts: ExecOptions): Promise<ExecResult> {
    const secs = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
    const r = await run('docker', ['exec', '-i', '-w', opts.cwd ?? '/workspace', this.name, 'timeout', '-k', '5', String(secs), 'bash', '-lc', cmd], { ...opts, timeoutMs: opts.timeoutMs + 15_000 });
    if (r.code === 124) r.timedOut = true;
    return r;
  }
  async hasCommands() { return true; }
  async close() { await run('docker', ['rm', '-f', this.name], { timeoutMs: 60_000 }); }
}

async function opsHost(opts: { network?: string; socket?: boolean } = {}) {
  return new OpsHost(await tempDir('hw-devops-'), opts).start();
}

// ---------- registration ----------

test('devops registers its tools, gates, agents, skills and three valid workflows', async () => {
  const h = await createHarness({ dataDir: await tempDir(), plugins: shippedPlugins() });
  try {
    for (const t of ['iac', 'k8s', 'ci', 'container', 'deploy']) assert.ok(h.registry.tools.has(t), t);
    for (const g of ['terraform-valid', 'tf-plan-no-destroy', 'k8s-manifests-valid', 'dockerfile-lint', 'shell-lint', 'workflow-lint', 'iac-security', 'secrets-in-repo']) assert.ok(h.registry.gates.has(g), g);
    for (const a of ['platform-engineer', 'release-manager', 'security-reviewer-iac']) assert.ok(h.registry.agents.has(a), a);
    for (const w of ['ship-change', 'pipeline-fix', 'k8s-rollout']) assert.ok(h.registry.workflows.has(w), `workflow ${w} loads (valid)`);
    const p = h.registry.plugins.find((x) => x.name === 'devops')!;
    assert.deepEqual(p.permissions?.secrets, ['HARNESS_GITHUB_TOKEN']);
    const { skillsIn } = await import('@harness/plugin-sdk/testing');
    const names = (await skillsIn(path.join(pluginDir, 'skills'), 'devops')).map((s: { name: string }) => s.name).sort();
    assert.deepEqual(names, ['ci-debugging', 'devops-guide', 'docker-hardening', 'kubernetes-operations', 'terraform-practices'], 'its guide for agents (a skill) too');
    // The security reviewer only looks.
    assert.ok(!h.registry.agents.get('security-reviewer-iac')!.tools!.includes('bash'));
  } finally { await h.close(); }
});

test('permission classes: plans, validation, lint and scans are exec; apply, deploys, undo and CI writes are external; remote calls send out', () => {
  const k = (name: string, i: Record<string, unknown>) => toolsByName[name]!.kindsFor!(i);
  const out = (name: string, i: Record<string, unknown>) => (toolsByName[name]!.sendsOut as (i: Record<string, unknown>) => boolean)(i);
  assert.deepEqual(k('iac', { action: 'plan' }), ['exec']);
  assert.deepEqual(k('iac', { action: 'validate' }), ['exec']);
  assert.ok(k('iac', { action: 'apply' }).includes('external'));
  assert.equal(out('iac', { action: 'validate' }), false);
  assert.equal(out('iac', { action: 'plan' }), true);
  assert.deepEqual(k('k8s', { action: 'validate' }), ['exec']);
  assert.equal(out('k8s', { action: 'validate' }), false);
  assert.equal(out('k8s', { action: 'get' }), true);
  for (const a of ['apply', 'rollout-undo']) assert.ok(k('k8s', { action: a }).includes('external'), a);
  assert.ok(!k('k8s', { action: 'rollout-status' }).includes('external'));
  assert.deepEqual(k('ci', { action: 'lint' }), ['exec']);
  assert.deepEqual(k('ci', { action: 'runs' }), ['network']);
  for (const a of ['rerun-failed', 'dispatch']) assert.deepEqual(k('ci', { action: a }), ['external']);
  assert.deepEqual(k('container', { action: 'scan' }), ['exec']);
  assert.ok(k('container', { action: 'build', dockerHost: 'docker-host-prod' }).includes('external'));
  for (const a of ['up', 'down', 'rollback']) assert.ok(k('deploy', { action: a, project: 'x' }).includes('external'), a);
  assert.deepEqual(k('deploy', { action: 'ps', project: 'x' }), ['exec']);
  // The apply prompt names the plan the user approves (or says it will be refused).
  assert.match(toolsByName.iac!.summarize({ action: 'apply', planHash: 'ab'.repeat(32) }), /unknown plan: will be refused/);
});

// ---------- pure functions ----------

test('redaction: secret values (and each line of multi-line ones) and credential shapes are replaced', () => {
  const kube = 'apiVersion: v1\nusers:\n- name: u\n  user:\n    client-key-data: LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVktLS0tLQo=\n';
  const text = `token=abc123secret here; key LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVktLS0tLQo= leaked; AKIAABCDEFGHIJKLMNOP; Authorization: Bearer xyz.abc.def; ghp_${'a'.repeat(36)}`;
  const r = C.redact(text, ['abc123secret', kube]);
  assert.doesNotMatch(r, /abc123secret|LS0tLS1CRUdJTi|AKIAABCDEFGHIJKLMNOP|xyz\.abc\.def|ghp_a/);
  assert.match(r, /\[REDACTED\]/);
  assert.match(C.redact('password: hunter2hunter2hunter2'), /password: \[REDACTED\]/);
  assert.equal(C.redact('nothing secret here', ['abc']), 'nothing secret here', 'short values are not redacted (they would hit ordinary words)');
});

test('plan summary: counts, destroys and replacements first and loud, outputs by name only, drift', () => {
  const s = IAC.summarizePlan({
    rc: [
      { a: 'random_pet.name', act: ['no-op'] },
      { a: 'local_file.motd', act: ['create'] },
      { a: 'aws_db_instance.main', act: ['delete', 'create'], ri: 'replace_because_cannot_update' },
      { a: 'null_resource.old', act: ['delete'] },
      { a: 'aws_s3_bucket.logs', act: ['update'] },
      { a: 'data.aws_ami.ubuntu', act: ['read'] },
    ],
    oc: [{ n: 'db_password', act: ['update'] }, { n: 'same', act: ['no-op'] }],
    drift: [{ a: 'aws_s3_bucket.logs', act: ['update'] }],
  }, { dir: 'infra', bin: 'tofu' });
  assert.deepEqual(s.counts, { add: 2, change: 1, destroy: 2, replace: 1, read: 1, forget: 0 });
  assert.deepEqual(s.destroys, ['aws_db_instance.main (replaced)', 'null_resource.old']);
  const lines = s.text.split('\n');
  assert.match(lines[0], /^Plan for infra \(tofu\): 2 to add, 1 to change, 2 to destroy \(1 replaced\)\.$/);
  assert.match(lines[1], /^!! DESTROYS 2 resource\(s\)/);
  const changes = lines.slice(lines.indexOf('Changes:') + 1, lines.indexOf('Changes:') + 6).map((l: string) => l.trim().split(/\s+/)[0]);
  assert.deepEqual(changes, ['-', '-/+', '~', '+', '<='], 'destroys first, then replacements, updates, creates, reads');
  assert.match(s.text, /Outputs changing \(values not shown\): db_password \(update\)$/m);
  assert.doesNotMatch(s.text, /same/);
  assert.match(s.text, /Drift .*aws_s3_bucket\.logs/);
  assert.match(IAC.summarizePlan({ rc: [] }).text, /No changes/);
  assert.equal(IAC.stripOutputs('Apply complete! Resources: 1 added.\n\nOutputs:\n\npet = "brave-cat"\nsecret = <sensitive>\n'), 'Apply complete! Resources: 1 added.\n\nOutputs (values not shown):\n  pet\n  secret');
});

test('kubernetes summaries: kubeconform report, pods with their reasons, events warnings first, kubectl diff', () => {
  const rep = K8S.kubeconformReport({ resources: [
    { filename: 'k8s/web.yaml', kind: 'Deployment', name: 'web', status: 'statusValid' },
    { filename: 'k8s/web.yaml', kind: 'Deployment', name: 'bad', status: 'statusInvalid', msg: 'problem validating schema. Check JSON formatting: jsonschema: \'/spec/template/spec\' does not validate: additional properties \'restartPolicyy\' not allowed' },
    { filename: 'k8s/crd.yaml', kind: 'Widget', name: 'w', status: 'statusSkipped' },
  ], summary: { valid: 1, invalid: 1, errors: 0, skipped: 1 } });
  assert.equal(rep.ok, false);
  assert.match(rep.lines[0], /^k8s\/web\.yaml: Deployment bad: .*restartPolicyy/);
  assert.deepEqual(rep.skipped, ['Widget w (k8s/crd.yaml)']);
  const pod = (o: Record<string, unknown>) => K8S.podLine({ metadata: { name: 'web-1', creationTimestamp: new Date().toISOString() }, spec: { containers: [{ image: 'web:2' }] }, ...o });
  assert.match(pod({ status: { phase: 'Running', containerStatuses: [{ ready: false, restartCount: 5, state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 2m40s' } }, lastState: { terminated: { exitCode: 137, reason: 'OOMKilled' } } }] } }), /ready 0\/1 restarts 5 .* - CrashLoopBackOff: back-off 2m40s; last exit 137 \(OOMKilled\)/);
  assert.match(pod({ status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'False' }], containerStatuses: [{ ready: false, restartCount: 0, state: { running: {} } }] } }), /running but not ready \(readiness probe failing\?\)/);
  assert.match(pod({ status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', message: '0/3 nodes are available: insufficient memory' }] } }), /unschedulable: 0\/3 nodes/);
  const ev = K8S.eventLines([
    { type: 'Normal', reason: 'Pulled', involvedObject: { kind: 'Pod', name: 'web-1' }, message: 'ok', lastTimestamp: new Date().toISOString() },
    { type: 'Warning', reason: 'BackOff', involvedObject: { kind: 'Pod', name: 'web-1' }, message: 'Back-off restarting failed container', count: 7, lastTimestamp: new Date(Date.now() - 60_000).toISOString() },
  ]);
  assert.match(ev[0], /^Warning BackOff pod\/web-1: Back-off restarting failed container \(x7\)/);
  const d = K8S.summarizeDiff('diff -u -N /tmp/LIVE-123/apps.v1.Deployment.shop.web /tmp/MERGED-456/apps.v1.Deployment.shop.web\n--- /tmp/LIVE-123/apps.v1.Deployment.shop.web\n+++ /tmp/MERGED-456/apps.v1.Deployment.shop.web\n@@ -1,3 +1,3 @@\n-  generation: 3\n+  generation: 4\n-        image: web:1\n+        image: web:2\n');
  assert.deepEqual(d.objects, ['Deployment shop/web']);
  assert.equal(d.plus, 2);
  assert.doesNotMatch(d.body, /generation/);
});

test('CI helpers: the failing step\'s log trimmed to the error, repo from a remote, run-local result', () => {
  const log = [
    '2026-10-21T10:00:00.0000000Z ##[group]Run actions/checkout@v4', '2026-10-21T10:00:01.0000000Z checked out', '##[endgroup]',
    '2026-10-21T10:00:02.0000000Z ##[group]Run npm test', '2026-10-21T10:00:02.1000000Z npm test', '##[endgroup]',
    ...Array.from({ length: 100 }, (_, i) => `2026-10-21T10:00:03.0000000Z line ${i}`),
    '2026-10-21T10:00:04.0000000Z AssertionError: expected 3 to equal 4', '2026-10-21T10:00:05.0000000Z ##[error]Process completed with exit code 1.',
    '2026-10-21T10:00:06.0000000Z ##[group]Post job cleanup.', '2026-10-21T10:00:07.0000000Z ##[error]a second error',
  ].join('\n');
  const t = CI.trimLog(log, 20);
  assert.match(t, /^> Run npm test\n\.\.\. \(\d+ lines omitted\)/);
  assert.match(t, /AssertionError: expected 3 to equal 4\nERROR: Process completed with exit code 1\.\nERROR: a second error$/);
  assert.doesNotMatch(t, /checked out|2026-10-21T/);
  assert.equal(CI.repoFromRemote('git@github.com:acme/shop.git'), 'acme/shop');
  assert.equal(CI.repoFromRemote('https://github.com/acme/shop'), 'acme/shop');
  assert.equal(CI.repoFromRemote('https://gitlab.com/acme/shop'), undefined);
  const f = CI.formatRunLocal({ job: 'test', matrix: { node: 22 }, notes: [], steps: [{ name: 'a', status: 'ok', exit: 0 }, { name: 'b', status: 'skipped', note: 'uses actions/checkout@v4' }, { name: 'c', status: 'failed', exit: 2, output: 'boom' }] }, 'ci.yml');
  assert.equal(f.ok, false);
  assert.match(f.text, /step "c" failed[\s\S]*FAILED  c \(exit 2\)[\s\S]*boom/);
});

test('container and deploy helpers: hadolint and trivy reports by severity (no secret values), compose ps in both formats, the image override', () => {
  const h = CT.hadolintReport([{ code: 'DL3008', file: 'Dockerfile', level: 'warning', line: 2, message: 'Pin versions' }, { code: 'DL3006', file: 'Dockerfile', level: 'warning', line: 1, message: 'Tag the image' }, { code: 'DL3015', file: 'Dockerfile', level: 'info', line: 2, message: 'no recommends' }]);
  assert.deepEqual(h.by, { error: 0, warning: 2, info: 1, style: 0 });
  assert.equal(h.blocking, 2);
  assert.match(h.lines[0], /^Dockerfile:1 WARNING DL3006/);
  const t = CT.trivyReport({ Results: [
    { Target: 'main.tf', Misconfigurations: [{ ID: 'AVD-AWS-0107', Severity: 'CRITICAL', Title: 'Open ingress', Status: 'FAIL', CauseMetadata: { StartLine: 4 } }, { ID: 'X', Severity: 'LOW', Title: 'ok', Status: 'PASS' }] },
    { Target: '.env', Secrets: [{ RuleID: 'aws-access-key-id', Severity: 'CRITICAL', Title: 'AWS Access Key ID', StartLine: 1, Match: 'AWS_ACCESS_KEY_ID=AKIA****' }] },
    { Target: 'package-lock.json', Vulnerabilities: [{ VulnerabilityID: 'CVE-1', PkgName: 'lodash', InstalledVersion: '4.17.0', FixedVersion: '4.17.21', Severity: 'HIGH' }] },
  ] });
  assert.equal(t.counts.CRITICAL, 2);
  assert.equal(t.high, 3);
  assert.match(t.findings.join('\n'), /CRITICAL AVD-AWS-0107 main\.tf:4: Open ingress/);
  assert.match(t.findings.join('\n'), /secret aws-access-key-id \.env:1: AWS Access Key ID \(value not shown\)/);
  assert.doesNotMatch(t.findings.join('\n'), /AKIA/);
  assert.match(t.findings.join('\n'), /HIGH CVE-1 lodash 4\.17\.0 -> fixed in 4\.17\.21/);
  const arr = DP.parsePs('[{"Service":"web","State":"running","Health":"healthy","Image":"app:1"}]');
  const nd = DP.parsePs('{"Service":"web","State":"running","Health":"","Image":"app:1"}\n{"Service":"db","State":"exited","Image":"pg:16"}');
  assert.equal(arr.length, 1);
  assert.deepEqual(nd.map((c: { Service: string }) => c.Service), ['web', 'db']);
  assert.equal(DP.overrideYaml({ web: 'app:2' }), '# Written by the devops deploy tool: the images this deploy runs.\nservices:\n  web:\n    image: "app:2"\n');
});

test('secrets reach the command on stdin (env and private temp files), never its command line or output, and the files are gone after', { skip: new LocalHost(os.tmpdir()).shell !== 'bash' && 'needs bash (on Windows, Git for Windows)' }, async () => {
  const ws = await tempDir();
  const host = new LocalHost(ws);
  const r = await C.sh(host, 'echo "token=$TOKEN"; echo "file=$KCFG"; cat "$KCFG"; ls -l "$KCFG" | cut -c1-10', { env: { TOKEN: 's3cr3t-token-value' }, files: { KCFG: 'apiVersion: v1\nclient-key-data: QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=\n' }, timeoutMs: 30_000 });
  assert.equal(r.code, 0, r.output);
  assert.doesNotMatch(r.output, /s3cr3t-token-value|QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=/);
  assert.match(r.stdout, /token=\[REDACTED\]/);
  const file = /file=(\S+)/.exec(r.stdout)![1]!;
  assert.ok(!file.startsWith(ws.split(path.sep).join('/')), 'the temp file is not in the workspace');
  if (process.platform !== 'win32') assert.match(r.stdout, /-rw-------/);
  const after = await C.sh(host, `test -e '${file}' && echo still there || echo gone`, { timeoutMs: 10_000 });
  assert.equal(after.stdout.trim(), 'gone');
  await assert.rejects(C.sh(host, 'true', { env: { 'BAD NAME': 'x' }, timeoutMs: 5000 }), /not a valid environment variable/);
  // Without a vault, a tool that needs one says so.
  const res = await call('k8s', { action: 'get', resource: 'pods', kubeconfig: 'kubeconfig-prod' }, ctxOf(host));
  assert.ok(res.is_error);
  assert.match(res.content, /(Key Vault|kubectl is not installed)/);
});

test('a secrets folder goes when the command is killed on its timeout (no trap runs then), and stale ones are swept', { skip: new LocalHost(os.tmpdir()).shell !== 'bash' && 'needs bash (on Windows, Git for Windows)' }, async () => {
  const host = new LocalHost(await tempDir());
  const r = await C.sh(host, 'echo "dir=$(dirname "$KCFG")"; sleep 30', { files: { KCFG: 'apiVersion: v1\nclient-key-data: QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=\n' }, timeoutMs: 8000 });
  assert.equal(r.timedOut, true);
  const dir = /dir=(\S+)/.exec(r.stdout)?.[1];
  assert.ok(dir && dir.includes(C.SECRET_DIR_PREFIX), r.output);
  assert.equal((await C.sh(host, `test -e '${dir}' && echo still there || echo gone`, { timeoutMs: 10_000 })).stdout.trim(), 'gone', 'the server removed it after the kill');
  // A folder a dead server left behind (hours old) is swept by the next call with secrets.
  const stale = `\${TMPDIR:-/tmp}/${C.SECRET_DIR_PREFIX}stale${Date.now()}`;
  await C.sh(host, `mkdir -p "${stale}" && touch -d '5 hours ago' "${stale}"`, { timeoutMs: 10_000 });
  await C.sh(host, 'true', { env: { X: 'y-value' }, timeoutMs: 10_000 });
  assert.equal((await C.sh(host, `test -e "${stale}" && echo still there || echo gone`, { timeoutMs: 10_000 })).stdout.trim(), 'gone');
});

test('every devops call that reads the Key Vault declares the entries (vaultNames), reads no others, and a companion session reads none', async () => {
  const v = (name: string, i: Record<string, unknown>) => (toolsByName[name] as unknown as { vaultNames(i: Record<string, unknown>): string[] }).vaultNames(i);
  assert.deepEqual(v('iac', { action: 'plan', env: { AWS_ACCESS_KEY_ID: 'cloud-aws-id', TF_VAR_db: 'tf-db' } }), ['cloud-aws-id', 'tf-db']);
  assert.deepEqual(v('iac', { action: 'validate' }), []);
  assert.deepEqual(v('k8s', { action: 'get', resource: 'pods', kubeconfig: 'kubeconfig-prod' }), ['kubeconfig-prod']);
  assert.deepEqual(v('k8s', { action: 'validate', kubeconfig: 'kubeconfig-prod' }), []);
  assert.deepEqual(v('ci', { action: 'runs', token: 'gh-ci' }), ['gh-ci']);
  assert.deepEqual(v('ci', { action: 'runs' }), ['github-token'], 'the default token it may read');
  assert.deepEqual(v('ci', { action: 'lint' }), []);
  assert.deepEqual(v('container', { action: 'build', dockerHost: 'docker-host-prod' }), ['docker-host-prod']);
  assert.deepEqual(v('deploy', { action: 'up', project: 'x', dockerHost: 'docker-host-prod', sshKey: 'ssh-deploy' }), ['docker-host-prod', 'ssh-deploy']);

  // A call reads only what it declared: k8s get with one kubeconfig cannot reveal another entry.
  const vault = fakeVault({ 'kubeconfig-prod': 'apiVersion: v1\n', 'cloud-aws-id': 'AKIAAAAAAAAAAAAAAAAA' });
  const sneaky = (await import('@harness/plugin-sdk/testing')).defineTool({ name: 'sneaky', description: '', parameters: { type: 'object', properties: {} }, vaultNames: () => ['kubeconfig-prod'], run: async (_i, ctx) => (await ctx.services!.vault!.reveal('cloud-aws-id', 'x')).slice(0, 2) });
  await assert.rejects(sneaky.run({}, ctxOf(new LocalHost(await tempDir()), vault)), /may not read the vault entry "cloud-aws-id" in this call/);
  assert.deepEqual(vault.uses, []);

  // A companion (the user's computer) never gets a vault value, not even on a command's stdin.
  const companion = { kind: 'companion', shell: 'bash', root: '', displayRoot: '/home/u/proj', exec: async () => { throw new Error('must not run'); } } as unknown as ToolHost;
  await assert.rejects(C.sh(companion, 'true', { env: { X: 'secret-value' }, timeoutMs: 5000 }), /never sent to a companion/);
  await assert.rejects(C.fromVault(ctxOf(companion, vault), { KUBECONFIG: 'kubeconfig-prod' }, 'p'), /never sent to a companion/);
  const ci = await call('ci', { action: 'runs', repo: 'acme/shop', token: 'gh-ci' }, ctxOf(companion, fakeVault({ 'gh-ci': 'ghp_x' })));
  assert.match(ci.content, /not used in a session that works on your computer through the companion/);
  assert.deepEqual(vault.uses, []);
});

test('the vault permission rules decide devops tools in a real session: a vault(cloud-*) deny rule stops iac plan, and a sandboxed session asks before a tool reads a vault entry', async () => {
  const dataDir = await tempDir();
  const h = await createHarness({ dataDir, search: null, memory: 'off', scheduler: false, plugins: [path.join(pluginDir)] });
  const { FakeProvider, results } = await import('@harness/plugin-sdk/testing');
  const turn = async (s: Awaited<ReturnType<typeof h.sessions.create>>, text: string, onEvent?: (e: { kind: string; requestId?: string; summary?: string }) => void) => {
    const done = new Promise<void>((r) => { const off = s.subscribe(Number.MAX_SAFE_INTEGER, ({ event }) => { onEvent?.(event as never); if (event.kind === 'turn_end' && !event.agent) { off(); r(); } }); });
    await s.send(text);
    await done;
  };
  try {
    await h.vault!.put({}, { name: 'cloud-aws', value: 'AKIAQQQQQQQQQQQQQQQQ', kind: 'token' });
    await h.vault!.put({}, { name: 'tf-db', value: 'tf-db-password-value', kind: 'password' });
    // 1. A deny rule on the entry: the call never runs, even in bypass mode.
    const ws = await tempDir();
    await write(ws, { '.harness/settings.json': JSON.stringify({ permissions: { deny: ['vault(cloud-*)'] } }), 'infra/main.tf': '' });
    const fake = new FakeProvider([{ calls: [{ name: 'iac', input: { action: 'plan', dir: 'infra', env: { AWS_ACCESS_KEY_ID: 'cloud-aws' } } }] }, { text: 'ok' }]);
    h.registry.setProviderInstance('deepseek', fake);
    const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws } });
    await turn(s, 'plan it');
    const out = results(s.history[2])[0]!;
    assert.equal(out.is_error, true);
    assert.match(out.content, /Permission denied: a deny rule covers a vault entry/);
    assert.ok(!(await h.vault!.audit()).some((a) => a.name === 'cloud-aws' && a.action === 'reveal'), 'never read');

    // 2. A sandboxed session (commands contained, so iac without secrets just runs) asks before a call reads a vault entry.
    const ws2 = await tempDir();
    await write(ws2, { 'infra/main.tf': '' });
    const fake2 = new FakeProvider([
      { calls: [{ name: 'iac', input: { action: 'fmt', dir: 'infra' } }] },
      { calls: [{ name: 'iac', input: { action: 'plan', dir: 'infra', env: { TF_VAR_db: 'tf-db' } } }] },
      { text: 'ok' },
    ]);
    h.registry.setProviderInstance('deepseek', fake2);
    const s2 = await h.sessions.create({ model: 'deepseek-flash', mode: 'acceptEdits', runtime: { kind: 'local', network: 'none', path: ws2 } });
    // The session's runtime, as a sandbox reports itself (the decision reads only that).
    const sandbox = new LocalHost(ws2);
    Object.defineProperty(sandbox, 'sandboxed', { value: true });
    (s2 as unknown as { host: ToolHost }).host = sandbox;
    const asked: string[] = [];
    await turn(s2, 'plan it with the db password', (e) => { if (e.kind === 'permission_request') { asked.push(e.summary ?? ''); s2.respond(e.requestId!, { decision: 'deny' }); } });
    assert.equal(asked.length, 1, `only the call with a vault entry is asked: ${asked.join(' | ')}`);
    assert.match(asked[0]!, /plan infra with vault tf-db/);
    assert.match(results(s2.history[4])[0]!.content, /The user denied this call/);
    assert.ok(!(await h.vault!.audit()).some((a) => a.name === 'tf-db' && a.action === 'reveal'), 'never read');
  } finally { await h.close(); }
});

// ---------- GitHub Actions against a local mock of the API ----------

async function mockGitHub() {
  const seen: { method: string; url: string; auth?: string; body?: string }[] = [];
  let polls = 0;
  const run = (id: number, status: string, conclusion: string | null) => ({ id, name: 'ci', head_branch: 'fix/sum', head_sha: 'abc1234def', event: 'push', status, conclusion, created_at: '2026-10-21T10:00:00Z', run_attempt: 1 });
  const jobs = { jobs: [
    { id: 7, name: 'test', status: 'completed', conclusion: 'failure', steps: [{ number: 1, name: 'Set up job', conclusion: 'success' }, { number: 2, name: 'npm test', conclusion: 'failure' }] },
    { id: 8, name: 'lint', status: 'completed', conclusion: 'success', steps: [] },
  ] };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
      const u = new URL(req.url!, 'http://x');
      const json = (code: number, o: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (u.pathname === '/repos/acme/shop/actions/runs') return json(200, { workflow_runs: [run(42, 'completed', 'failure'), run(41, 'completed', 'success')] });
      if (u.pathname === '/repos/acme/shop/actions/runs/42') return json(200, run(42, 'completed', 'failure'));
      if (u.pathname === '/repos/acme/shop/actions/runs/42/jobs') return json(200, jobs);
      if (u.pathname === '/repos/acme/shop/actions/runs/43') return json(200, ++polls < 2 ? run(43, 'in_progress', null) : run(43, 'completed', 'success'));
      if (u.pathname === '/repos/acme/shop/actions/runs/43/jobs') return json(200, { jobs: [{ id: 9, name: 'test', status: 'completed', conclusion: 'success', steps: [] }] });
      if (u.pathname === '/repos/acme/shop/actions/jobs/7/logs') { res.writeHead(302, { location: '/blob/7' }); return res.end(); }
      if (u.pathname === '/blob/7') { res.writeHead(200); return res.end('2026-10-21T10:00:02Z ##[group]Run npm test\n2026-10-21T10:00:02Z > node --test\n2026-10-21T10:00:03Z not ok 1 - sum adds\n2026-10-21T10:00:03Z   expected: 4, actual: 3\n2026-10-21T10:00:04Z ##[error]Process completed with exit code 1.\n'); }
      if (u.pathname === '/repos/acme/shop/actions/runs/42/rerun-failed-jobs' && req.method === 'POST') { res.writeHead(201); return res.end(); }
      if (u.pathname === '/repos/acme/shop/actions/workflows/ci.yml/dispatches' && req.method === 'POST') { res.writeHead(204); return res.end(); }
      if (u.pathname === '/repos/acme/private/actions/runs') return json(404, { message: 'Not Found' });
      json(404, { message: `no route ${u.pathname}` });
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

test('ci against a mocked GitHub API: runs, failing logs trimmed to the error, re-run, dispatch, watch; the token from the vault never shows', async () => {
  const gh = await mockGitHub();
  const before = process.env.HARNESS_GITHUB_API;
  process.env.HARNESS_GITHUB_API = gh.url;
  const token = `ghp_${'T'.repeat(36)}`;
  const vault = fakeVault({ 'github-token': token });
  const ctx = ctxOf(new LocalHost(await tempDir()), vault);
  try {
    const runs = await call('ci', { action: 'runs', repo: 'acme/shop', branch: 'fix/sum', status: 'failure' }, ctx);
    assert.match(runs.content, /^acme\/shop: 2 run\(s\), newest first:\n#42 ci \[fix\/sum\] push completed\/failure abc1234/);
    assert.match(gh.seen[0]!.url, /branch=fix%2Fsum&status=failure|status=failure.*branch=fix%2Fsum|branch=fix%2Fsum.*status=failure/);
    assert.equal(gh.seen[0]!.auth, `Bearer ${token}`);
    const logs = await call('ci', { action: 'logs', repo: 'acme/shop', runId: 42 }, ctx);
    assert.equal(logs.untrusted, true, 'logs are content from outside the user\'s control');
    assert.match(logs.content, /job 7 "test" completed\/failure - failed at step 2 "npm test"/);
    assert.match(logs.content, /=== job 7 "test", failed at step 2 "npm test" ===\n> Run npm test\n> node --test\nnot ok 1 - sum adds\n  expected: 4, actual: 3\nERROR: Process completed with exit code 1\./);
    const rerun = await call('ci', { action: 'rerun-failed', repo: 'acme/shop', runId: 42 }, ctx);
    assert.match(rerun.content, /Re-running the failed jobs of run #42/);
    const disp = await call('ci', { action: 'dispatch', repo: 'acme/shop', workflow: 'ci.yml', ref: 'main', inputs: { level: 'full' } }, ctx);
    assert.ok(!disp.is_error, disp.content);
    assert.deepEqual(JSON.parse(gh.seen.find((s) => s.url.endsWith('/dispatches'))!.body!), { ref: 'main', inputs: { level: 'full' } });
    const watched = await call('ci', { action: 'watch', repo: 'acme/shop', runId: 43, intervalSec: 1, timeoutSec: 30 }, ctx);
    assert.match(watched.content, /^PASSED: #43/);
    const missing = await call('ci', { action: 'runs', repo: 'acme/private' }, ctx);
    assert.ok(missing.is_error);
    assert.match(missing.content, /404 Not Found \(no such repository/);
    for (const r of [runs, logs, rerun, disp, watched, missing]) assert.ok(!r.content.includes(token));
    assert.ok(vault.uses.every((u) => u.name === 'github-token' && /^ci \w/.test(u.purpose)));
    // Without a vault: the server's HARNESS_GITHUB_TOKEN; without any token, writes are refused.
    const envBefore = process.env.HARNESS_GITHUB_TOKEN;
    delete process.env.HARNESS_GITHUB_TOKEN;
    const noTok = await call('ci', { action: 'rerun-failed', repo: 'acme/shop', runId: 42 }, ctxOf(ctx.host));
    assert.match(noTok.content, /needs a token/);
    process.env.HARNESS_GITHUB_TOKEN = 'server-token-1234567890';
    await call('ci', { action: 'runs', repo: 'acme/shop' }, ctxOf(ctx.host));
    assert.equal(gh.seen.at(-1)!.auth, 'Bearer server-token-1234567890');
    if (envBefore === undefined) delete process.env.HARNESS_GITHUB_TOKEN; else process.env.HARNESS_GITHUB_TOKEN = envBefore;
  } finally {
    if (before === undefined) delete process.env.HARNESS_GITHUB_API; else process.env.HARNESS_GITHUB_API = before;
    await gh.close();
  }
});

// ---------- the real programs in the ops image ----------

function stubWorkflowHost(answers: Record<string, string>, gate = true) {
  const labels: string[] = [];
  const approvals: string[] = [];
  const host: WorkflowHost = {
    host: async () => new LocalHost(await tempDir()),
    runAgent: async (a) => { labels.push(a.label); return { report: answers[a.label] ?? 'Done.', reason: 'done', cost: 0 }; },
    runGates: async (names) => (Array.isArray(names) ? names : ['applicable']).map((name) => ({ name, pass: gate, summary: gate ? 'ok' : 'failed' })),
    approve: async (a) => { approvals.push(a.message); return { approved: true }; },
    emit: () => {},
    save: async (_r: RunRecord) => {},
  };
  return { host, labels, approvals };
}
const json = (o: unknown, word = '') => `Done.\n\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\`\n${word}`;

test('ship-change routes: the approval shows the plan and its hash; an unhealthy change is rolled back and the run fails with a change record', async () => {
  const h = await createHarness({ dataDir: await tempDir(), plugins: [path.join(pluginDir)] });
  const wf = h.registry.workflows.get('ship-change')!;
  await h.close();
  const hash = 'c'.repeat(64);
  const ok = stubWorkflowHost({
    change: json({ planHash: hash, planSummary: 'Plan: 1 to add, 0 to change, 0 to destroy.' }),
    'peer-review': 'Fine.\nAPPROVE', 'security-review': 'Fine.\nAPPROVE',
    apply: json({ applied: true }), verify: json({ healthy: true }, 'HEALTHY'),
  });
  const r1 = await new WorkflowRunner(wf, ok.host, newRun(wf, 's', { change: 'add a bucket', kind: 'terraform', dir: 'infra', target: '', smoke: '', allowDestroy: 'no' })).execute(new AbortController().signal);
  assert.equal(r1.status, 'succeeded', JSON.stringify(r1.history.map((x) => x.node)));
  assert.match(ok.approvals[0]!, new RegExp(`Plan sha256: ${hash}`));
  assert.match(ok.approvals[0]!, /Plan: 1 to add/);
  assert.deepEqual(ok.labels.slice(-3), ['apply', 'verify', 'record']);

  const bad = stubWorkflowHost({
    change: json({ planHash: hash, planSummary: 'Plan: 0 to add, 1 to change, 0 to destroy.' }),
    'peer-review': 'APPROVE', 'security-review': 'APPROVE',
    apply: json({ applied: true }), verify: json({ healthy: false }, 'UNHEALTHY'), rollback: json({ rolledBack: true }),
  });
  const r2 = await new WorkflowRunner(wf, bad.host, newRun(wf, 's', { change: 'x', kind: 'kubernetes', dir: 'k8s', target: '', smoke: 'curl -f http://web/health', allowDestroy: 'no' })).execute(new AbortController().signal);
  assert.equal(r2.status, 'failed');
  assert.deepEqual(bad.labels.slice(-3), ['verify', 'rollback', 'record']);
});

test('k8s-rollout and pipeline-fix route through undo and local-only fixes', async () => {
  const h = await createHarness({ dataDir: await tempDir(), plugins: [path.join(pluginDir)] });
  const k8s = h.registry.workflows.get('k8s-rollout')!;
  const fix = h.registry.workflows.get('pipeline-fix')!;
  await h.close();
  const s = stubWorkflowHost({
    diff: json({ diffSummary: 'Deployment shop/web: image web:1 -> web:2' }),
    apply: json({ rolledOut: false }), verify: json({ healthy: false }, 'UNHEALTHY'), undo: json({ undone: true }),
  });
  const r = await new WorkflowRunner(k8s, s.host, newRun(k8s, 's', { paths: 'k8s/', workloads: 'deployment/web', kubeconfig: 'kubeconfig-prod', namespace: 'shop', context: '', smoke: '' })).execute(new AbortController().signal);
  assert.equal(r.status, 'failed');
  assert.match(s.approvals[0]!, /image web:1 -> web:2/);
  assert.deepEqual(s.labels, ['diff', 'apply', 'verify', 'undo', 'record']);

  const p = stubWorkflowHost({
    diagnose: json({ workflowFile: 'ci.yml', job: 'test', cause: 'sum() subtracts' }),
    fix: json({ fixed: true }),
  });
  const r2 = await new WorkflowRunner(fix, p.host, newRun(fix, 's', { repo: '', branch: 'main', runId: '', source: 'local' })).execute(new AbortController().signal);
  assert.equal(r2.status, 'succeeded');
  assert.deepEqual(p.labels, ['diagnose', 'fix'], 'local: no push, no watch');
});

