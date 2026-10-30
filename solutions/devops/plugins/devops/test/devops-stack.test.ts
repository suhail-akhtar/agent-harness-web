import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runGates, pluginDir as dirOf, shippedPlugins } from '@harness/plugin-sdk/testing';
import { newRun, WorkflowRunner } from '@harness/plugin-sdk/testing';
import type { RunRecord, WorkflowHost } from '@harness/plugin-sdk/testing';
import { createHarness } from '@harness/plugin-sdk/testing';
import { dockerAvailable, imageExists } from '@harness/plugin-sdk/testing';
import { type ExecOptions, type ExecResult, LocalHost, run, type ToolHost } from '@harness/plugin-sdk/testing';
import type { ToolContext } from '@harness/plugin-sdk/testing';
import { tempDir } from '@harness/plugin-sdk/testing';
import { HARNESS_ROOT } from '@harness/plugin-sdk/runtime';

// The devops plugin's integration tests (devops.test.ts has the unit tests and the GitHub mock ones):
// the real programs inside the ops
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

const TF_MAIN = `terraform {
  required_providers {
    random = { source = "hashicorp/random", version = "3.9.1" }
    local  = { source = "hashicorp/local", version = "2.9.1" }
    null   = { source = "hashicorp/null", version = "3.3.2" }
  }
}

variable "token" {
  type      = string
  sensitive = true
}

resource "random_pet" "name" {
  length = 2
}

resource "local_file" "motd" {
  filename = "\${path.module}/motd.txt"
  content  = "hello \${random_pet.name.id}\\n"
}

resource "null_resource" "old" {
  triggers = { token = sha256(var.token) }
}

output "pet" {
  value = random_pet.name.id
}
`;

test('ops image: every tool it promises runs', { skip: skipOps, timeout: 120_000 }, async () => {
  const r = await run('docker', ['run', '--rm', '--network', 'none', '--name', `hwtest-ops-versions-${Date.now()}`, OPS_IMAGE, 'bash', '-c',
    'set -e; tofu version | head -1; kubectl version --client | head -1; helm version --short; kind version; kubeconform -v; hadolint --version; shellcheck --version | sed -n 2p; trivy --version | head -1; actionlint -version | head -1; yamllint --version; ansible --version | head -1; docker --version; docker compose version; ls /opt/k8s-schemas/master-standalone-strict | wc -l'], { timeoutMs: 110_000 });
  assert.equal(r.code, 0, r.stderr);
  for (const want of [/OpenTofu v1\.13\.1/, /Client Version: v1\.37\.1/, /v4\.3\.1/, /kind v0\.33\.0/, /v0\.8\.0/, /Haskell Dockerfile Linter 2\.15\.1/, /version: 0\.11\.0/, /Version: 0\.76\.1/, /1\.7\.12/, /yamllint 1\.38\.0/, /ansible \[core 2\.19\.14\]/, /Docker version 29\.9\.2/, /Docker Compose version v5\.6\.1/, /^23$/m]) assert.match(r.stdout, want);
});

test('ops image: terraform validate, plan (summary, no values), approved-plan apply, destroy detection and the plan-hash guard', { skip: skipOps, timeout: 600_000 }, async () => {
  const host = await opsHost();
  const vault = fakeVault({ 'tf-token': 'tok-ABCDEFGHIJKLMNOP-secret' });
  const ctx = ctxOf(host, vault);
  try {
    await write(host.root, { 'infra/main.tf': TF_MAIN });
    const fmt = await call('iac', { action: 'fmt', dir: 'infra' }, ctx);
    assert.ok(!fmt.is_error, fmt.content);
    const v = await call('iac', { action: 'validate' }, ctx);
    assert.ok(!v.is_error, v.content);
    assert.match(v.content, /tofu validate: 1 of 1 module\(s\) valid\.\ninfra: valid/);

    const p1 = await call('iac', { action: 'plan', dir: 'infra', env: { TF_VAR_token: 'tf-token' } }, ctx);
    assert.ok(!p1.is_error, p1.content);
    assert.match(p1.content, /^Plan for infra \(tofu\): 3 to add, 0 to change, 0 to destroy\./);
    assert.match(p1.content, /\+\s+local_file\.motd/);
    assert.doesNotMatch(p1.content, /tok-ABCDEFGHIJKLMNOP-secret|DESTROYS/);
    const hash1 = /sha256: ([0-9a-f]{64})/.exec(p1.content)![1]!;
    assert.match(toolsByName.iac!.summarize({ action: 'apply', planHash: hash1 }), /^APPLY plan [0-9a-f]{12} in infra: \+3 ~0 -0$/);
    assert.ok(vault.uses.some((u) => u.name === 'tf-token' && u.purpose === 'iac plan in infra'));
    const latest = JSON.parse(await fs.readFile(path.join(host.root, '.harness/devops/plans/latest.json'), 'utf8'));
    assert.equal(latest.hash, hash1);
    assert.deepEqual(latest.env, ['TF_VAR_token'], 'the record names the variables, never the values');
    // The plan file holds every variable's value (TF_VAR_token too): it is not left in the workspace, nor in the sandbox.
    assert.deepEqual(await filesUnder(host.root, (f) => f.endsWith('.tfplan')), [], 'no plan file in the workspace');
    assert.equal((await host.exec('ls -a "${TMPDIR:-/tmp}" | grep -c -e tfplan -e hw-devops-secrets- || true', { timeoutMs: 20_000 })).stdout.trim(), '0', 'nor in the sandbox\'s temporary folder');
    assert.ok(IAC.plansFor(host).get(hash1)?.bytes.length > 0, 'the server keeps it, for this session');
    assert.equal((await runGates(await gatesRegistry(), host, ['tf-plan-no-destroy'], new AbortController().signal))[0]!.pass, true);
    // Another session (another runtime, even on the same machine) cannot apply this session's plan.
    const other = Object.assign(Object.create(Object.getPrototypeOf(host)), host) as ToolHost;
    const foreign = await call('iac', { action: 'apply', planHash: hash1 }, ctxOf(other, vault));
    assert.match(foreign.content, /No plan with sha256 .* was made in this session/);

    const a1 = await call('iac', { action: 'apply', planHash: hash1 }, ctx);
    assert.ok(!a1.is_error, a1.content);
    assert.match(a1.content, /Apply complete! Resources: 3 added, 0 changed, 0 destroyed\./);
    assert.match(a1.content, /Outputs \(values not shown\):\n\s+pet/);
    assert.match(await fs.readFile(path.join(host.root, 'infra/motd.txt'), 'utf8'), /^hello \w+-\w+\n$/);
    const again = await call('iac', { action: 'apply', planHash: hash1 }, ctx);
    assert.match(again.content, /No plan with sha256/, 'a plan applies once');

    // Removing a resource: the plan destroys it, loudly; the gate blocks unless the run allows it.
    await write(host.root, { 'infra/main.tf': TF_MAIN.replace(/resource "null_resource" "old" \{[^}]*\}\n\}\n/, '') });
    const p2 = await call('iac', { action: 'plan', dir: 'infra', env: { TF_VAR_token: 'tf-token' } }, ctx);
    assert.match(p2.content, /0 to add, 0 to change, 1 to destroy\.\n!! DESTROYS 1 resource\(s\) - review these:\n   - null_resource\.old/);
    const hash2 = /sha256: ([0-9a-f]{64})/.exec(p2.content)![1]!;
    const reg = await gatesRegistry();
    const g1 = (await runGates(reg, host, ['tf-plan-no-destroy'], new AbortController().signal))[0]!;
    assert.equal(g1.pass, false);
    assert.match(g1.details!, /null_resource\.old/);
    // The workspace's record is only a pointer: editing what it says is destroyed changes nothing.
    const rec = JSON.parse(await fs.readFile(path.join(host.root, '.harness/devops/plans/latest.json'), 'utf8'));
    await fs.writeFile(path.join(host.root, '.harness/devops/plans/latest.json'), JSON.stringify({ ...rec, destroys: [] }));
    assert.equal((await runGates(reg, host, ['tf-plan-no-destroy'], new AbortController().signal))[0]!.pass, false);
    await write(host.root, { '.harness/devops/run-policy.json': '{"allowDestroy": true}' });
    const g2 = (await runGates(reg, host, ['tf-plan-no-destroy'], new AbortController().signal))[0]!;
    assert.equal(g2.pass, true);
    assert.match(g2.summary, /allowed by this run/);

    const noAllow = await call('iac', { action: 'apply', planHash: hash2 }, ctx);
    assert.ok(noAllow.is_error);
    assert.match(noAllow.content, /destroys 1 resource\(s\): null_resource\.old.*allowDestroy/);
    // A kept plan that changed after approval is refused.
    const kept = IAC.plansFor(host).get(hash2);
    kept.bytes = Buffer.concat([kept.bytes, Buffer.from('x')]);
    const tampered = await call('iac', { action: 'apply', planHash: hash2, allowDestroy: true }, ctx);
    assert.ok(tampered.is_error);
    assert.match(tampered.content, /no longer matches the approved plan/);

    const p3 = await call('iac', { action: 'plan', dir: 'infra', env: { TF_VAR_token: 'tf-token' } }, ctx);
    const a3 = await call('iac', { action: 'apply', planHash: /sha256: ([0-9a-f]{64})/.exec(p3.content)![1], allowDestroy: true }, ctx);
    assert.match(a3.content, /Resources: 0 added, 0 changed, 1 destroyed/);
    for (const r of [p1, a1, p2, p3, a3]) assert.ok(!r.content.includes('tok-ABCDEFGHIJKLMNOP-secret'));

    // The state file is now in the workspace: secrets-in-repo says it must not be committed.
    const sec = (await runGates(reg, host, ['secrets-in-repo'], new AbortController().signal))[0]!;
    assert.equal(sec.pass, false);
    assert.match(sec.details!, /infra\/terraform\.tfstate/);

    // A broken configuration: terraform-valid names the file and line.
    await write(host.root, { 'broken/main.tf': 'resource "random_pet" "x" {\n  lenght = 2\n}\n\noutput "o" {\n  value = var.missing\n}\n' });
    const bad = (await runGates(reg, host, ['terraform-valid'], new AbortController().signal))[0]!;
    assert.equal(bad.pass, false);
    assert.match(bad.details!, /broken: \d error\(s\)/);
    assert.match(bad.details!, /ERROR main\.tf:2: Unsupported argument/);
    assert.match(bad.details!, /ERROR main\.tf:6: Reference to undeclared input variable/);
  } finally { await host.close(); }
});

/** Files under a folder (relative paths) that `pick` chooses. */
async function filesUnder(dir: string, pick: (rel: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const rel = path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/');
    if (pick(rel)) out.push(rel);
  }
  return out;
}

let registryOnce: Awaited<ReturnType<typeof createHarness>> | undefined;
async function gatesRegistry() {
  registryOnce ??= await createHarness({ dataDir: await tempDir(), plugins: [path.join(pluginDir), dirOf('quality-gates')] });
  return registryOnce.registry;
}
process.once('beforeExit', () => { void registryOnce?.close(); });

const DEPLOYMENT = (extra = '') => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:${extra}
      containers:
        - name: web
          image: nginx:1.27.3
          ports:
            - containerPort: 80
`;

test('ops image: manifests, charts, Dockerfiles, shell scripts and workflows - tools and gates on good and bad fixtures', { skip: skipOps, timeout: 600_000 }, async () => {
  const host = await opsHost();
  const ctx = ctxOf(host);
  const reg = await gatesRegistry();
  const gate = async (name: string) => (await runGates(reg, host, [name], new AbortController().signal))[0]!;
  try {
    await write(host.root, {
      'k8s/web.yaml': DEPLOYMENT(),
      'k8s/svc.yaml': 'apiVersion: v1\nkind: Service\nmetadata:\n  name: web\nspec:\n  selector:\n    app: web\n  ports:\n    - port: 80\n',
      'docker-compose.yml': 'services:\n  web:\n    image: nginx\n',
      'charts/web/Chart.yaml': 'apiVersion: v2\nname: web\nversion: 0.1.0\n',
      'charts/web/values.yaml': 'replicas: 2\nimage: nginx:1.27.3\n',
      'charts/web/templates/deploy.yaml': 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {{ .Release.Name }}-web\nspec:\n  replicas: {{ .Values.replicas }}\n  selector:\n    matchLabels: {app: web}\n  template:\n    metadata:\n      labels: {app: web}\n    spec:\n      containers:\n        - name: web\n          image: {{ .Values.image }}\n',
      'Dockerfile': 'FROM node:22.11-bookworm-slim\nWORKDIR /app\nCOPY server.js .\nUSER node\nCMD ["node", "server.js"]\n',
      'scripts/ok.sh': '#!/bin/bash\nset -euo pipefail\nfor f in ./*.txt; do\n  echo "$f"\ndone\n',
      '.github/workflows/ci.yml': 'name: ci\non: push\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hello\n',
    });
    // All good.
    const v = await call('k8s', { action: 'validate' }, ctx);
    assert.ok(!v.is_error, v.content);
    assert.match(v.content, /2 file\(s\): 2 resource\(s\) valid, 0 invalid/, 'the compose file and the chart template are not taken for manifests');
    assert.match(v.content, /chart charts\/web \(helm template\): 1 resource\(s\) valid/);
    for (const g of ['k8s-manifests-valid', 'dockerfile-lint', 'shell-lint', 'workflow-lint']) {
      const r = await gate(g);
      assert.equal(r.pass, true, `${g}: ${r.summary}\n${r.details ?? ''}`);
    }
    const tpl = await call('k8s', { action: 'template', chart: 'charts/web', release: 'shop', set: { replicas: 3 } }, ctx);
    assert.ok(!tpl.is_error, tpl.content);
    assert.match(tpl.content, /Rendered charts\/web as release shop to \.harness\/devops\/rendered\/shop\.yaml:\nDeployment shop-web\nkubeconform: 1 valid, 0 invalid/);
    assert.ok(!(await call('k8s', { action: 'lint', chart: 'charts/web' }, ctx)).is_error);
    assert.ok(!(await call('ci', { action: 'lint' }, ctx)).is_error);

    // Each with one problem.
    await write(host.root, {
      'k8s/web.yaml': DEPLOYMENT('\n      restartPolicyy: Always'),
      'Dockerfile': 'FROM ubuntu\nRUN apt-get update && apt-get install -y curl\nCMD node server.js\n',
      'scripts/bad.sh': '#!/bin/bash\nfor f in $(ls *.txt); do\n  echo "$f"\ndone\ncd /tmp\n',
      '.github/workflows/ci.yml': 'name: ci\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "${{ matrix.node }}"\n',
    });
    const bad = await call('k8s', { action: 'validate', paths: ['k8s'] }, ctx);
    assert.ok(bad.is_error);
    assert.match(bad.content, /k8s\/web\.yaml: Deployment web: .*restartPolicyy/);
    const k = await gate('k8s-manifests-valid');
    assert.equal(k.pass, false);
    assert.match(k.details!, /restartPolicyy/);

    const lint = await call('container', { action: 'lint' }, ctx);
    assert.ok(lint.is_error);
    assert.match(lint.content, /Dockerfile:1 WARNING DL3006/);
    assert.match(lint.content, /DL3008/);
    const d = await gate('dockerfile-lint');
    assert.equal(d.pass, false);
    assert.match(d.summary, /^0 error\(s\), 3 warning\(s\), \d info, 0 style in 1 Dockerfile\(s\)$/);

    const s = await gate('shell-lint');
    assert.equal(s.pass, false);
    assert.match(s.details!, /scripts\/bad\.sh:2:\d+ \w+ SC2045/);
    assert.match(s.details!, /SC2164/);
    assert.doesNotMatch(s.details!, /ok\.sh/);

    const w = await gate('workflow-lint');
    assert.equal(w.pass, false);
    assert.match(w.details!, /\.github\/workflows\/ci\.yml:7:\d+: property "node" is not defined/);

    // A build in the sandbox: no daemon, said plainly; the Dockerfile is checked instead.
    const b = await call('container', { action: 'build', tag: 'shop:1.0.0' }, ctx);
    assert.ok(b.is_error);
    assert.match(b.content, /^NOT BUILT: no Docker daemon is reachable/);
    assert.match(b.content, /hadolint: 0 error\(s\), \d+ warning\(s\)/);
    assert.match(b.content, /trivy config: CRITICAL \d+, HIGH \d+/);
  } finally { await host.close(); }
});

const HARDENED = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: shop
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        runAsGroup: 10001
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: web
          image: nginx:1.27.3
          ports:
            - containerPort: 8080
          resources:
            requests: {cpu: 100m, memory: 64Mi}
            limits: {cpu: 500m, memory: 128Mi}
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: [ALL]
`;

test('ops image: iac-security blocks HIGH/CRITICAL misconfigurations; secrets-in-repo finds keys and state; scans say what they could not do offline', { skip: skipOps, timeout: 600_000 }, async () => {
  const host = await opsHost();
  const ctx = ctxOf(host);
  const reg = await gatesRegistry();
  const gate = async (name: string) => (await runGates(reg, host, [name], new AbortController().signal))[0]!;
  try {
    // trivy's checks are strict: a plain Deployment has HIGH findings (writable root filesystem, default security context).
    await write(host.root, { 'k8s/web.yaml': DEPLOYMENT() });
    const plain = await gate('iac-security');
    assert.equal(plain.pass, false);
    assert.match(plain.details!, /HIGH KSV-?0*14 k8s\/web\.yaml:\d+: Root file system is not read-only/);
    await write(host.root, { 'k8s/web.yaml': HARDENED });
    const clean = await gate('iac-security');
    assert.equal(clean.pass, true, clean.details ?? clean.summary);
    await write(host.root, { 'k8s/web.yaml': HARDENED.replace('allowPrivilegeEscalation: false', 'allowPrivilegeEscalation: false\n            privileged: true') });
    const g = await gate('iac-security');
    assert.equal(g.pass, false);
    assert.match(g.summary, /HIGH\/CRITICAL misconfiguration/);
    assert.match(g.details!, /HIGH KSV-?0*17 k8s\/web\.yaml:\d+: Privileged/);

    assert.equal((await gate('secrets-in-repo')).pass, true);
    await write(host.root, { 'config/settings.py': `AWS_ACCESS_KEY_ID = "AKIA${'Q'.repeat(16)}"\n`, 'kubeconfig': 'apiVersion: v1\n' });
    const sec = await gate('secrets-in-repo');
    assert.equal(sec.pass, false);
    assert.match(sec.details!, /credential scan: 1 possible credential/);
    assert.match(sec.details!, /config\/settings\.py:1: possible credential/);
    assert.match(sec.details!, /must not be in the repository \(1\):\nkubeconfig/);
    assert.doesNotMatch(sec.details!, /AKIAQQQQ/);

    const scan = await call('container', { action: 'scan' }, ctx);
    assert.ok(scan.is_error);
    assert.match(scan.content, /secret aws-access-key-id config\/settings\.py:1/);
    assert.match(scan.content, /Vulnerabilities were NOT scanned: trivy's vulnerability database is not in this image and the sandbox has no network/);
  } finally { await host.close(); }
});

const RUN_LOCAL_WF = `name: ci
on: [push]
env:
  GREETING: hello
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [22, 20]
    steps:
      - uses: actions/checkout@v4
      - name: greet
        run: echo "$GREETING node \${{ matrix.node }}" > out.txt
      - name: deploy
        run: echo \${{ secrets.TOKEN }}
      - name: check
        run: test "$(cat out.txt)" = "hello node 22"
      - name: fail
        run: |
          echo about to fail
          exit 3
      - name: never
        run: echo never
`;

test('ops image: ci run-local runs a job\'s steps like the runner (env, matrix, skips actions and secrets, stops at the failure)', { skip: skipOps, timeout: 300_000 }, async () => {
  const host = await opsHost();
  try {
    await write(host.root, { '.github/workflows/ci.yml': RUN_LOCAL_WF });
    const r = await call('ci', { action: 'run-local', workflow: 'ci.yml' }, ctxOf(host));
    assert.ok(r.is_error);
    assert.match(r.content, /^\.github\/workflows\/ci\.yml job test \(matrix \{"node":22\}\): step "fail" failed/);
    assert.match(r.content, /skipped actions\/checkout@v4 - uses actions\/checkout@v4/);
    assert.match(r.content, /ok      greet\nskipped deploy - needs secrets\.TOKEN\nok      check\nFAILED  fail \(exit 3\)/);
    assert.doesNotMatch(r.content, /never/);
    assert.match(r.content, /about to fail/);
    const nojob = await call('ci', { action: 'run-local', workflow: 'ci.yml', job: 'nope' }, ctxOf(host));
    assert.match(nojob.content, /no job nope in \.github\/workflows\/ci\.yml \(jobs: test\)/);
  } finally { await host.close(); }
});

// ---------- compose deploys against this machine's Docker daemon ----------

test('deploy: compose up verifies health, a failing image is rolled back automatically, rollback and down', { skip: skipOps, timeout: 600_000 }, async () => {
  const tag = crypto.randomBytes(3).toString('hex');
  const images = [`hwtest-app:${tag}-good`, `hwtest-app:${tag}-bad`];
  const project = `hwtest-deploy-${tag}`;
  for (const [img, code] of [[images[0], 0], [images[1], 1]] as const) {
    const df = `FROM node:22-alpine\nHEALTHCHECK --interval=1s --timeout=2s --start-period=1s --retries=2 CMD ["node", "-e", "process.exit(${code})"]\nCMD ["node", "-e", "setInterval(() => {}, 1e9)"]\n`;
    const b = await run('docker', ['build', '-q', '-t', img!, '-'], { timeoutMs: 300_000, stdin: df });
    assert.equal(b.code, 0, b.stderr);
  }
  const host = await opsHost({ socket: true });
  const ctx = ctxOf(host);
  try {
    await write(host.root, { 'compose.yaml': `services:\n  app:\n    image: ${images[0]}\n` });
    const up1 = await call('deploy', { action: 'up', project, healthTimeoutSec: 60 }, ctx);
    assert.ok(!up1.is_error, up1.content);
    assert.match(up1.content, new RegExp(`Deployed ${project} on the local Docker daemon: healthy\\.\\napp running \\(healthy\\) image ${images[0]}`));
    const up2 = await call('deploy', { action: 'up', project, service: 'app', image: images[1], healthTimeoutSec: 30 }, ctx);
    assert.ok(up2.is_error);
    assert.match(up2.content, new RegExp(`UNHEALTHY after deploying \\{"app":"${images[1]}"\\}; ROLLED BACK automatically to \\{"app":"${images[0]}"\\}: healthy again`));
    const ps = await call('deploy', { action: 'ps', project }, ctx);
    assert.match(ps.content, new RegExp(`app running \\(healthy\\) image ${images[0]}`));
    const history = JSON.parse(await fs.readFile(path.join(host.root, `.harness/devops/deploy/${project}.json`), 'utf8'));
    assert.deepEqual(history.map((h: { action: string; ok: boolean }) => `${h.action}:${h.ok}`), ['up:true', 'up:false', 'auto-rollback:true']);
    // The only healthy deploy is what runs now: nothing earlier to roll back to.
    assert.match((await call('deploy', { action: 'rollback', project }, ctx)).content, /No earlier healthy deploy of hwtest-deploy-\w+ to roll back to/);
    const down = await call('deploy', { action: 'down', project }, ctx);
    assert.match(down.content, /is down .* Volumes kept\./);
    assert.match((await call('deploy', { action: 'ps', project }, ctx)).content, /nothing running/);
    assert.match((await call('deploy', { action: 'up', project: 'Bad Name' }, ctx)).content, /project must be/);
  } finally {
    await run('docker', ['compose', '-p', project, 'down', '--remove-orphans'], { timeoutMs: 120_000 });
    await host.close();
    await run('docker', ['image', 'rm', '-f', ...images], { timeoutMs: 60_000 });
  }
});

// ---------- a real Kubernetes API: kind (a full cluster) or kwok (real control plane, simulated kubelet) ----------

const KIND_VERSION = '0.33.0';
const KIND_SHA256: Record<string, string> = { 'windows-amd64': '4b22adaa135368c5a465d56bbd8e520cbea87272a06ca00b6078e7b81515c9fc', 'linux-amd64': 'aee6151561422756b764a4ae28e7f44cda5af5a9eead3cc9985112b1de8d8e0d' };
const runKind = process.env.HARNESS_TEST_KIND === '1';
const KWOK_IMAGE = 'registry.k8s.io/kwok/cluster:v0.8.0-k8s.v1.36.1';
const runKwok = process.env.HARNESS_TEST_KWOK === '1' || (hasOps && process.env.HARNESS_TEST_KWOK !== '0' && (await imageExists(KWOK_IMAGE)));

/** kind on this machine: on the PATH, else downloaded into a temp folder and checked against its release checksum. */
async function kindBinary(): Promise<string> {
  const onPath = await run(process.platform === 'win32' ? 'where' : 'which', ['kind'], { timeoutMs: 10_000 });
  if (onPath.code === 0) return onPath.stdout.trim().split(/\r?\n/)[0]!;
  const plat = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}`;
  const sum = KIND_SHA256[plat];
  if (!sum) throw new Error(`no kind checksum pinned for ${plat}`);
  const res = await fetch(`https://github.com/kubernetes-sigs/kind/releases/download/v${KIND_VERSION}/kind-${plat}`);
  const data = Buffer.from(await res.arrayBuffer());
  assert.equal(crypto.createHash('sha256').update(data).digest('hex'), sum, 'kind download checksum');
  const file = path.join(await tempDir('hwtest-kind-'), process.platform === 'win32' ? 'kind.exe' : 'kind');
  await fs.writeFile(file, data, { mode: 0o755 });
  return file;
}

/**
 * The same rollout story on any cluster: validate, diff, apply and wait, a
 * second rollout that cannot finish (its pods cannot be scheduled) diagnosed
 * and undone, events, describe - with the kubeconfig from the vault, never in
 * the output, and gone after every call.
 */
async function clusterScenario(host: OpsHost, kubeconfig: string, image: string, secret: string) {
  const vault = fakeVault({ 'kubeconfig-hwtest': kubeconfig });
  const ctx = ctxOf(host, vault);
  const base = { kubeconfig: 'kubeconfig-hwtest', namespace: 'default' };
  const deploy = (extra: string) => `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: hwtest-web\nspec:\n  replicas: 1\n  selector:\n    matchLabels:\n      app: hwtest-web\n  template:\n    metadata:\n      labels:\n        app: hwtest-web\n    spec:${extra}\n      containers:\n        - name: web\n          image: ${image}\n          imagePullPolicy: IfNotPresent\n`;
  await write(host.root, { 'k8s/web.yaml': deploy('') });
  assert.ok(!(await call('k8s', { action: 'validate' }, ctx)).is_error);
  const diff = await call('k8s', { action: 'diff', paths: ['k8s'], ...base }, ctx);
  assert.match(diff.content, /1 object\(s\) would change .*Deployment default\/hwtest-web/);
  const a1 = await call('k8s', { action: 'apply', paths: ['k8s'], timeoutSec: 180, ...base }, ctx);
  assert.ok(!a1.is_error, a1.content);
  assert.match(a1.content, /deployment\.apps\/hwtest-web created[\s\S]*Rollouts:\ndeployment\.apps\/hwtest-web: .*successfully rolled out/);
  const pods = await call('k8s', { action: 'get', resource: 'pods', selector: 'app=hwtest-web', ...base }, ctx);
  assert.match(pods.content, /pod\/hwtest-web-\S+ Running ready 1\/1 restarts 0/);
  assert.match((await call('k8s', { action: 'diff', paths: ['k8s'], ...base }, ctx)).content, /^No differences/);
  // A rollout whose new pod can never be scheduled: it does not finish, the reason is shown, and it is undone.
  await write(host.root, { 'k8s/web.yaml': deploy('\n      nodeSelector:\n        hwtest/pool: missing') });
  const a2 = await call('k8s', { action: 'apply', paths: ['k8s'], timeoutSec: 25, ...base }, ctx);
  assert.ok(a2.is_error, a2.content);
  assert.match(a2.content, /deployment\.apps\/hwtest-web configured/);
  assert.match(a2.content, /rollout did not complete in 25s/);
  assert.match(a2.content, /Pending .*unschedulable: .*node affinity\/selector/);
  assert.match(a2.content, /Warning FailedScheduling pod\/hwtest-web-/);
  const undo = await call('k8s', { action: 'rollout-undo', resource: 'deployment/hwtest-web', timeoutSec: 120, ...base }, ctx);
  assert.ok(!undo.is_error, undo.content);
  assert.match(undo.content, /rolled back[\s\S]*After the undo: deployment\/hwtest-web: .*successfully rolled out/);
  const after = await call('k8s', { action: 'get', resource: 'deployment/hwtest-web', ...base }, ctx);
  assert.match(after.content, /deployment\/hwtest-web ready 1\/1/);
  const ev = await call('k8s', { action: 'events', ...base }, ctx);
  assert.match(ev.content, /^\d+ warning\(s\), \d+ event\(s\):\nWarning FailedScheduling/);
  const desc = await call('k8s', { action: 'describe', resource: 'deployment/hwtest-web', ...base }, ctx);
  assert.match(desc.content, /Name:\s+hwtest-web/);
  for (const r of [diff, a1, pods, a2, undo, after, ev, desc]) assert.ok(!r.content.includes(secret), 'the kubeconfig\'s credential never shows');
  assert.ok(vault.uses.length >= 8 && vault.uses.every((u) => u.name === 'kubeconfig-hwtest' && u.purpose.startsWith('k8s ')));
  const left = await host.exec(`grep -rl ${secret.slice(0, 12)} /tmp 2>/dev/null | head -3`, { timeoutMs: 30_000 });
  assert.equal(left.stdout.trim(), '', 'no kubeconfig left behind');
}

test('kubernetes on a real kind cluster: rollout, a failing rollout diagnosed and undone, events', { skip: (!runKind && 'set HARNESS_TEST_KIND=1 to create a real kind cluster (minutes, pulls kindest/node; needs a kernel that runs systemd in a container)') || skipOps, timeout: 1_200_000 }, async () => {
  const kind = await kindBinary();
  const cluster = 'hwtest-k8s';
  const network = 'hwtest-kind';
  const env = { ...process.env, KIND_EXPERIMENTAL_DOCKER_NETWORK: network };
  let host: OpsHost | undefined;
  try {
    const c = await run(kind, ['create', 'cluster', '--name', cluster, '--wait', '180s'], { timeoutMs: 900_000, env });
    assert.equal(c.code, 0, `${c.stdout}\n${c.stderr}`);
    const kc = await run(kind, ['get', 'kubeconfig', '--internal', '--name', cluster], { timeoutMs: 60_000, env });
    assert.equal(kc.code, 0, kc.stderr);
    // The pause image is preloaded on the node: no pulls needed for the workload.
    const imgs = await run('docker', ['exec', `${cluster}-control-plane`, 'crictl', 'images'], { timeoutMs: 60_000 });
    const pause = /(registry\.k8s\.io\/pause)\s+(\S+)/.exec(imgs.stdout);
    assert.ok(pause, imgs.stdout);
    host = await new OpsHost(await tempDir('hw-devops-'), { network }).start();
    await clusterScenario(host, kc.stdout, `${pause[1]}:${pause[2]}`, /client-key-data: (\S+)/.exec(kc.stdout)![1]!);
  } finally {
    await host?.close();
    await run(kind, ['delete', 'cluster', '--name', cluster], { timeoutMs: 300_000, env });
    await run('docker', ['network', 'rm', network], { timeoutMs: 60_000 });
  }
});

test('kubernetes on a kwok cluster (real API server, controllers and scheduler; simulated kubelet): rollout, a failing rollout diagnosed and undone, events', { skip: (!runKwok && `no ${KWOK_IMAGE} here (docker pull it, or HARNESS_TEST_KWOK=1 to pull)`) || skipOps, timeout: 600_000 }, async () => {
  const id = crypto.randomBytes(3).toString('hex');
  const network = `hwtest-kwok-${id}`;
  const name = `hwtest-kwok-${id}`;
  let host: OpsHost | undefined;
  try {
    assert.equal((await run('docker', ['network', 'create', network], { timeoutMs: 60_000 })).code, 0);
    const s = await run('docker', ['run', '-d', '--name', name, '--network', network, KWOK_IMAGE], { timeoutMs: 600_000 });
    assert.equal(s.code, 0, s.stderr);
    for (let i = 0; i < 60; i++) {
      if ((await run('docker', ['logs', name], { timeoutMs: 10_000 })).stdout.includes('keep alive')) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    // The all-in-one image serves the API through kubectl proxy (no auth); the token is only there to prove redaction.
    const token = `hwtest-${crypto.randomBytes(16).toString('hex')}`;
    const kubeconfig = `apiVersion: v1\nkind: Config\nclusters:\n- name: kwok\n  cluster:\n    server: http://${name}:8080\ncontexts:\n- name: kwok\n  context:\n    cluster: kwok\n    user: kwok\ncurrent-context: kwok\nusers:\n- name: kwok\n  user:\n    token: ${token}\n`;
    host = await new OpsHost(await tempDir('hw-devops-'), { network }).start();
    // One fake node (kwok manages every node and runs its pods as ready).
    await write(host.root, { 'node/node.yaml': 'apiVersion: v1\nkind: Node\nmetadata:\n  name: hwtest-node-1\n  labels:\n    type: kwok\n  annotations:\n    kwok.x-k8s.io/node: fake\nstatus:\n  allocatable: {cpu: "32", memory: 256Gi, pods: "110"}\n  capacity: {cpu: "32", memory: 256Gi, pods: "110"}\n' });
    const vault = fakeVault({ 'kubeconfig-hwtest': kubeconfig });
    const n = await call('k8s', { action: 'apply', paths: ['node'], kubeconfig: 'kubeconfig-hwtest' }, ctxOf(host, vault));
    assert.ok(!n.is_error, n.content);
    for (let i = 0; i < 30; i++) {
      const g = await call('k8s', { action: 'get', resource: 'nodes', kubeconfig: 'kubeconfig-hwtest' }, ctxOf(host, vault));
      if (/node\/hwtest-node-1 Ready/.test(g.content)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    await fs.rm(path.join(host.root, 'node'), { recursive: true });
    await clusterScenario(host, kubeconfig, 'registry.example/hwtest-web:1.0.0', token);
  } finally {
    await host?.close();
    await run('docker', ['rm', '-f', name], { timeoutMs: 60_000 });
    await run('docker', ['network', 'rm', network], { timeoutMs: 60_000 });
  }
});

// ---------- workflows, dry-run ----------

const json = (o: unknown, word = '') => `Done.\n\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\`\n${word}`;

const SOLUTIONS: Record<string, Record<string, string>> = {
  'fix-terraform': {
    'infra/main.tf': `terraform {
  required_providers {
    random = { source = "hashicorp/random", version = "3.9.1" }
    local  = { source = "hashicorp/local", version = "2.9.1" }
    null   = { source = "hashicorp/null", version = "3.3.2" }
  }
}

variable "pet_length" {
  type    = number
  default = 2
}

resource "random_pet" "name" {
  length = var.pet_length
}

resource "local_file" "motd" {
  filename = "\${path.module}/motd.txt"
  content  = "Welcome to \${random_pet.name.id}\\n"
}

resource "null_resource" "ready" {
  triggers = {
    motd = local_file.motd.content_sha256
  }
  depends_on = [local_file.motd]
}

output "name" {
  value = random_pet.name.id
}
`,
  },
  'fix-k8s-manifests': {
    'k8s/deployment.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: shop
  labels:
    app: web
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: web
          image: ghcr.io/acme/shop-web:2.4.1
          ports:
            - name: http
              containerPort: 8080
          env:
            - name: LOG_LEVEL
              value: info
          resources:
            requests: { cpu: 100m, memory: 128Mi }
            limits: { cpu: 500m, memory: 256Mi }
          readinessProbe:
            httpGet: { path: /ready, port: http }
          livenessProbe:
            httpGet: { path: /healthz, port: http }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: [ALL]
`,
    'k8s/service.yaml': 'apiVersion: v1\nkind: Service\nmetadata:\n  name: web\n  namespace: shop\nspec:\n  selector:\n    app: web\n  ports:\n    - name: http\n      port: 80\n      targetPort: http\n',
  },
  'fix-ci': {
    'src/calc.mjs': "// Small statistics helpers.\n\nexport function sum(values) {\n  let total = 0;\n  for (const v of values) total += v;\n  return total;\n}\n\nexport function mean(values) {\n  if (!values.length) throw new RangeError('mean of an empty list');\n  return sum(values) / values.length;\n}\n\nexport function max(values) {\n  return values.reduce((m, v) => (v > m ? v : m), -Infinity);\n}\n",
    '.github/workflows/ci.yml': 'name: ci\non:\n  push:\n    branches: [main]\n  pull_request:\n\npermissions:\n  contents: read\n\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n      - name: Unit tests\n        run: npm test\n      - name: Lint\n        run: npm run lint\n',
  },
};

/** Sets environment variables for the duration of fn. */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test('evals/devops: three cases load; each hidden check fails on the broken fixtures and passes on a reference fix', { skip: skipOps, timeout: 900_000 }, async () => {
  const { loadCases, runChecks } = await import('@harness/plugin-sdk/testing');
  const cases = await loadCases(path.join(pluginDir, '..', '..', 'evals'), ['devops']);
  assert.deepEqual(cases.map((c) => c.name).sort(), ['fix-ci', 'fix-k8s-manifests', 'fix-terraform']);
  const h = await createHarness({ dataDir: await tempDir(), plugins: [path.join(pluginDir)] });
  try {
    await withEnv({ HARNESS_EVAL_CONTAINER_PREFIX: 'hwtest-eval-' }, async () => {
      for (const c of cases) {
        const ws = await tempDir('hw-eval-ws-');
        await fs.cp(path.join(c.dir, c.fixtures!), ws, { recursive: true });
        const before = await runChecks(h, c, ws, new AbortController().signal);
        assert.deepEqual(before.filter((x) => x.pass).map((x) => x.name), c.name === 'fix-ci' ? ['hidden: tests unchanged'] : [], `${c.name} broken: ${JSON.stringify(before, null, 1)}`);
        await write(ws, SOLUTIONS[c.name]!);
        const after = await runChecks(h, c, ws, new AbortController().signal);
        assert.ok(after.every((x) => x.pass), `${c.name} fixed: ${JSON.stringify(after, null, 1)}`);
      }
      // The tempting wrong fix for the Terraform case: a new default length replaces the deployed pet.
      const tf = cases.find((c) => c.name === 'fix-terraform')!;
      const ws = await tempDir('hw-eval-ws-');
      await fs.cp(path.join(tf.dir, tf.fixtures!), ws, { recursive: true });
      await write(ws, { 'infra/main.tf': SOLUTIONS['fix-terraform']!['infra/main.tf']!.replace('default = 2', 'default = 3') });
      const wrong = await runChecks(h, tf, ws, new AbortController().signal);
      assert.deepEqual(wrong.map((x) => x.pass), [true, false]);
      assert.match(wrong[1]!.detail, /random_pet\.name: expected no-op, plan says delete,create/);
    });
  } finally { await h.close(); }
});

test('evals/devops dry run with FakeProvider: fix-terraform (a prompt) and fix-ci (the pipeline-fix workflow, local) end to end, judged by the hidden checks', { skip: skipOps, timeout: 900_000 }, async () => {
  const { loadCases, runEvals } = await import('@harness/plugin-sdk/testing');
  const { FakeProvider } = await import('@harness/plugin-sdk/testing');
  const cases = (await loadCases(path.join(pluginDir, '..', '..', 'evals'), ['devops'])).filter((c) => c.name !== 'fix-k8s-manifests');
  const out = await tempDir('hw-eval-out-');
  const scripts: Record<string, ConstructorParameters<typeof FakeProvider>[0]> = {
    'fix-terraform': [
      { calls: [{ name: 'read', input: { path: 'infra/main.tf' } }, { name: 'iac', input: { action: 'validate', dir: 'infra' } }] },
      { calls: [{ name: 'write', input: { path: 'infra/main.tf', content: SOLUTIONS['fix-terraform']!['infra/main.tf'] } }] },
      { calls: [{ name: 'iac', input: { action: 'validate', dir: 'infra' } }] },
      { text: 'Fixed: declared pet_length (default 2, as deployed), content instead of contents, depends_on local_file.motd.' },
    ],
    'fix-ci': [
      { calls: [{ name: 'ci', input: { action: 'lint' } }, { name: 'ci', input: { action: 'run-local', workflow: 'ci.yml' } }] },
      { text: json({ workflowFile: 'ci.yml', job: 'test', cause: 'sum() subtracts, src uses var, and setup-node reads an undefined matrix.node' }) },
      { calls: [{ name: 'read', input: { path: 'src/calc.mjs' } }, { name: 'read', input: { path: '.github/workflows/ci.yml' } }] },
      { calls: [{ name: 'write', input: { path: 'src/calc.mjs', content: SOLUTIONS['fix-ci']!['src/calc.mjs'] } }, { name: 'write', input: { path: '.github/workflows/ci.yml', content: SOLUTIONS['fix-ci']!['.github/workflows/ci.yml'] } }] },
      { calls: [{ name: 'ci', input: { action: 'run-local', workflow: 'ci.yml', job: 'test' } }] },
      { text: json({ fixed: true }) },
    ],
  };
  // The agent's devops tools run in the ops image (a server-folder session, as evals use).
  const runs = await withEnv({ HARNESS_EVAL_CONTAINER_PREFIX: 'hwtest-eval-', HARNESS_DEVOPS_IMAGE: OPS_IMAGE }, async () => {
    const all = [];
    for (const c of cases) {
      const provider = new FakeProvider(scripts[c.name]!);
      all.push({ provider, runs: await runEvals({
        cases: [c], models: ['deepseek-flash'], repeats: 1, out: path.join(out, c.name), concurrency: 1, plugins: shippedPlugins(),
        setup: (h) => h.registry.setProviderInstance('deepseek', provider),
      }) });
    }
    return all;
  });
  for (const { provider, runs: [r] } of runs) {
    assert.ok(r!.pass, `${r!.case}: ${r!.status} ${r!.error ?? ''}\n${JSON.stringify(r!.checks, null, 1)}`);
    // The tool results the agent saw: validate and run-local ran for real.
    const seen = provider.snapshots.join('\n');
    if (r!.case === 'fix-terraform') {
      assert.match(seen, /Reference to undeclared input variable/, 'the broken config, before the fix');
      assert.match(seen, /tofu validate: 1 of 1 module\(s\) valid/);
    } else {
      assert.match(seen, /property \\"node\\" is not defined/, 'actionlint, before the fix');
      assert.match(seen, /step \\"Unit tests\\" failed/, 'run-local, before the fix');
      assert.match(seen, /all 2 run step\(s\) passed/);
    }
  }
});
