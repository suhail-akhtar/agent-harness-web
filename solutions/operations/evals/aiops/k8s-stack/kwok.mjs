// A Kubernetes cluster for the aiops Kubernetes tests and the k8s-crashloop eval:
// kwok's all-in-one image (a real kube-apiserver with RBAC on its secure port,
// etcd, controller-manager and scheduler; kwok plays the kubelets), started with
// the stages in kwok-stages.yaml (pods that crash-loop or fail on purpose) and
// container logs from ./logs. Only containers named hwtest-* are ever touched.
//
//   node evals/aiops/k8s-stack/kwok.mjs up                  start the eval cluster (hwtest-aiops-kwok, https://127.0.0.1:16443)
//   node evals/aiops/k8s-stack/kwok.mjs up-reset crashloop [--record <file>]
//                                                           what the eval's setup runs: up, a fresh "shop" namespace, the
//                                                           checkout deployment healthy at revision 1, then the bad config
//                                                           change (revision 2) that crash-loops; --record writes the state
//   node evals/aiops/k8s-stack/kwok.mjs reset               remove the eval's namespace
//   node evals/aiops/k8s-stack/kwok.mjs status | down
//
// Credentials (.state/secrets.json, for HARNESS_OPS_SECRETS=@<that file>):
//   ops-k8s-hwtest-reader    a kubeconfig with a ServiceAccount token bound to a read-only ClusterRole (no Secrets)
//   ops-k8s-hwtest-operator  a kubeconfig with the cluster's admin client certificate
// The operator inventory for the eval is ./operator-inventory.yaml (HARNESS_OPS_INVENTORY).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { k8sClient, parseKubeconfig } from '../../../plugins/aiops/lib/k8s.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const IMAGE = 'registry.k8s.io/kwok/cluster:v0.8.0-k8s.v1.36.1';
export const EVAL = { name: 'hwtest-aiops-kwok', port: 16443 };
export const STATE = path.join(here, '.state');
export const SECRETS_FILE = path.join(STATE, 'secrets.json');
export const OPERATOR_INVENTORY = path.join(here, 'operator-inventory.yaml');
export const MANAGER = 'hwtest-k8s-stack';
const PKI = '/root/.kwok/clusters/kwok/pki';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function docker(args, { allowFail = false, input } = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8', input, maxBuffer: 16 * 1024 * 1024, timeout: 600_000 });
  if (r.status !== 0 && !allowFail) throw new Error(`docker ${args.slice(0, 3).join(' ')} failed: ${(r.stderr || r.stdout || r.error?.message || '').trim().slice(-600)}`);
  return r;
}
const assertName = (name) => { if (!/^hwtest-[a-z0-9-]+$/.test(name)) throw new Error(`refusing to touch container "${name}" (only hwtest-*)`); return name; };

export function imagePresent() { return docker(['image', 'inspect', IMAGE], { allowFail: true }).status === 0; }

/** Starts (or reuses) a kwok cluster in container `name`; port 0 picks a free one. Returns kubeconfigs and an admin client. */
export async function up({ name = EVAL.name, port = EVAL.port } = {}) {
  assertName(name);
  const st = docker(['inspect', '-f', '{{.State.Running}}', name], { allowFail: true });
  if (st.status === 0 && st.stdout.trim() !== 'true') docker(['rm', '-f', name]);
  if (st.status !== 0 || st.stdout.trim() !== 'true') {
    if (!imagePresent()) docker(['pull', IMAGE]);
    docker(['create', '--name', name, '--label', 'hwtest=aiops-k8s', '-e', 'KWOK_KUBE_APISERVER_PORT=6443', '-p', `127.0.0.1:${port || ''}:6443`, IMAGE, '--config', '/hwtest-stages.yaml']);
    docker(['cp', path.join(here, 'kwok-stages.yaml'), `${name}:/hwtest-stages.yaml`]);
    docker(['cp', path.join(here, 'logs'), `${name}:/hwtest-logs`]);
    docker(['start', name]);
  }
  for (let i = 0; i < 120; i++) {
    if (docker(['logs', name], { allowFail: true }).stdout.includes('keep alive')) break;
    await sleep(1000);
  }
  const mapped = docker(['port', name, '6443/tcp']).stdout.trim().split('\n')[0];
  const hostPort = Number(/:(\d+)$/.exec(mapped)?.[1]);
  const cat = (f) => docker(['exec', name, 'cat', `${PKI}/${f}`]).stdout;
  const b64 = (s) => Buffer.from(s).toString('base64');
  const server = `https://127.0.0.1:${hostPort}`;
  const kubeconfig = (user) => `apiVersion: v1\nkind: Config\nclusters:\n- name: hwtest\n  cluster:\n    server: ${server}\n    certificate-authority-data: ${b64(cat('ca.crt'))}\ncontexts:\n- name: hwtest\n  context:\n    cluster: hwtest\n    user: hwtest\ncurrent-context: hwtest\nusers:\n- name: hwtest\n  user:\n${user}`;
  const admin = kubeconfig(`    client-certificate-data: ${b64(cat('admin.crt'))}\n    client-key-data: ${b64(cat('admin.key'))}\n`);
  const client = k8sClient(parseKubeconfig(admin));
  for (let i = 0; i < 60; i++) {
    try { await client.get('/api/v1/namespaces/default'); break; } catch (e) { if (i === 59) throw e; await sleep(1000); }
  }
  await baseline(client);
  const tr = await client.post('/api/v1/namespaces/kube-system/serviceaccounts/hwtest-aiops-reader/token', { apiVersion: 'authentication.k8s.io/v1', kind: 'TokenRequest', spec: { expirationSeconds: 86_400 } });
  const reader = kubeconfig(`    token: ${tr.status.token}\n`);
  return { name, port: hostPort, server, admin, reader, readerToken: tr.status.token, client };
}

/** Server-side apply as this stack (field manager hwtest-k8s-stack). */
export async function apply(client, obj) {
  const kinds = { Namespace: ['', 'namespaces', false], Node: ['', 'nodes', false], ServiceAccount: ['', 'serviceaccounts', true], Service: ['', 'services', true], ConfigMap: ['', 'configmaps', true], PersistentVolumeClaim: ['', 'persistentvolumeclaims', true], Pod: ['', 'pods', true], Deployment: ['apps/v1', 'deployments', true], Job: ['batch/v1', 'jobs', true], HorizontalPodAutoscaler: ['autoscaling/v2', 'horizontalpodautoscalers', true], PodDisruptionBudget: ['policy/v1', 'poddisruptionbudgets', true], ClusterRole: ['rbac.authorization.k8s.io/v1', 'clusterroles', false], ClusterRoleBinding: ['rbac.authorization.k8s.io/v1', 'clusterrolebindings', false] };
  const [gv, plural, namespaced] = kinds[obj.kind];
  const p = `${gv ? `/apis/${gv}` : '/api/v1'}${namespaced ? `/namespaces/${obj.metadata.namespace}` : ''}/${plural}/${obj.metadata.name}`;
  const r = await client.request('PATCH', p, { body: { apiVersion: gv || 'v1', ...obj }, contentType: 'application/apply-patch+yaml', query: { fieldManager: MANAGER, force: 'true' } });
  return r.json();
}

const NODE = (name, labels = {}) => ({ kind: 'Node', metadata: { name, labels: { type: 'kwok', 'kubernetes.io/hostname': name, ...labels }, annotations: { 'kwok.x-k8s.io/node': 'fake' } }, status: { allocatable: { cpu: '32', memory: '256Gi', pods: '110' }, capacity: { cpu: '32', memory: '256Gi', pods: '110' } } });

/** Nodes, and the read-only ServiceAccount the reader kubeconfig uses. */
async function baseline(client) {
  await apply(client, NODE('hwtest-node-1'));
  await apply(client, { kind: 'ClusterRole', metadata: { name: 'hwtest-aiops-reader' }, rules: [
    { apiGroups: [''], resources: ['pods', 'pods/log', 'events', 'nodes', 'services', 'endpoints', 'configmaps', 'persistentvolumeclaims', 'persistentvolumes', 'namespaces', 'serviceaccounts', 'replicationcontrollers'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: ['apps'], resources: ['deployments', 'replicasets', 'statefulsets', 'daemonsets', 'controllerrevisions'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: ['batch'], resources: ['jobs', 'cronjobs'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: ['autoscaling'], resources: ['horizontalpodautoscalers'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: ['policy'], resources: ['poddisruptionbudgets'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: ['networking.k8s.io'], resources: ['ingresses', 'networkpolicies'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: ['storage.k8s.io'], resources: ['storageclasses'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: ['events.k8s.io'], resources: ['events'], verbs: ['get', 'list', 'watch'] },
    { apiGroups: ['metrics.k8s.io'], resources: ['pods', 'nodes'], verbs: ['get', 'list'] },
  ] });
  await apply(client, { kind: 'ServiceAccount', metadata: { name: 'hwtest-aiops-reader', namespace: 'kube-system' } });
  await apply(client, { kind: 'ClusterRoleBinding', metadata: { name: 'hwtest-aiops-reader' }, roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'hwtest-aiops-reader' }, subjects: [{ kind: 'ServiceAccount', name: 'hwtest-aiops-reader', namespace: 'kube-system' }] });
  for (let i = 0; i < 60; i++) {
    const n = await client.get('/api/v1/nodes/hwtest-node-1');
    if ((n.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True')) return;
    await sleep(1000);
  }
  throw new Error('node hwtest-node-1 never became Ready');
}
export const node = (client, name, labels) => apply(client, NODE(name, labels));

export function down(name = EVAL.name) { docker(['rm', '-f', assertName(name)], { allowFail: true }); }

/** Deletes a namespace and waits until it is gone. */
export async function dropNamespace(client, ns) {
  try { await client.del(`/api/v1/namespaces/${ns}`); } catch (e) { if (e.status !== 404) throw e; }
  for (let i = 0; i < 120; i++) {
    try { await client.get(`/api/v1/namespaces/${ns}`); } catch (e) { if (e.status === 404) return; throw e; }
    await sleep(1000);
  }
  throw new Error(`namespace ${ns} was not deleted in 2 minutes`);
}

/** Waits until fn() is truthy (polling every second). */
export async function until(what, fn, ms = 120_000) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await sleep(1000); }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

/** Warning BackOff events like a kubelet's for every crash-looping pod in a namespace (kwok's kubelets send none). */
export async function crashEvents(client, ns) {
  const pods = (await client.list(`/api/v1/namespaces/${ns}/pods`)).filter((p) => (p.status?.containerStatuses ?? []).some((c) => c.state?.waiting?.reason === 'CrashLoopBackOff'));
  const now = new Date(); const first = new Date(Date.now() - 6 * 60_000);
  for (const p of pods) for (const c of p.status.containerStatuses.filter((x) => x.state?.waiting?.reason === 'CrashLoopBackOff')) {
    const ev = { apiVersion: 'v1', kind: 'Event', metadata: { name: `${p.metadata.name}.backoff-${c.name}`, namespace: ns }, involvedObject: { apiVersion: 'v1', kind: 'Pod', namespace: ns, name: p.metadata.name, uid: p.metadata.uid, fieldPath: `spec.containers{${c.name}}` }, reason: 'BackOff', message: `Back-off restarting failed container ${c.name} in pod ${p.metadata.name}_${ns}(${p.metadata.uid})`, type: 'Warning', count: 7, firstTimestamp: first.toISOString(), lastTimestamp: now.toISOString(), source: { component: 'kubelet', host: p.spec.nodeName }, reportingComponent: 'kubelet', reportingInstance: p.spec.nodeName };
    try { await client.post(`/api/v1/namespaces/${ns}/events`, ev); } catch (e) { if (e.status !== 409) throw e; }
  }
  return pods.length;
}

// ---------------- the eval: checkout crash-loops after a bad config change ----------------

export const SHOP = 'shop';
const checkout = (timeout, cause) => ({
  kind: 'Deployment',
  metadata: { name: 'checkout', namespace: SHOP, labels: { app: 'checkout', team: 'payments' }, annotations: { 'kubernetes.io/change-cause': cause } },
  spec: {
    replicas: 2, revisionHistoryLimit: 5, progressDeadlineSeconds: 120,
    strategy: { type: 'Recreate' },
    selector: { matchLabels: { app: 'checkout' } },
    template: {
      metadata: { labels: { app: 'checkout', team: 'payments' } },
      spec: { containers: [{ name: 'checkout', image: 'registry.example/shop/checkout:2.4.1', ports: [{ containerPort: 8080 }], env: [{ name: 'PAYMENT_GATEWAY_URL', value: 'https://payments.internal/v2' }, { name: 'PAYMENT_GATEWAY_TIMEOUT', value: timeout }, { name: 'LOG_LEVEL', value: 'info' }], resources: { requests: { cpu: '250m', memory: '256Mi' }, limits: { cpu: '1', memory: '512Mi' } }, readinessProbe: { httpGet: { path: '/healthz', port: 8080 }, periodSeconds: 10 } }] },
    },
  },
});

/** A fresh shop namespace: checkout healthy (revision 1), then the bad config change (revision 2) crash-loops. */
export async function crashloop(client) {
  await dropNamespace(client, SHOP);
  await apply(client, { kind: 'Namespace', metadata: { name: SHOP, labels: { team: 'payments' } } });
  await apply(client, { kind: 'Deployment', metadata: { name: 'cart', namespace: SHOP, labels: { app: 'cart' } }, spec: { replicas: 1, selector: { matchLabels: { app: 'cart' } }, template: { metadata: { labels: { app: 'cart' } }, spec: { containers: [{ name: 'cart', image: 'registry.example/shop/cart:1.9.0' }] } } } });
  await apply(client, checkout('30s', 'release 2.4.1'));
  const avail = async (n) => { const d = await client.get(`/apis/apps/v1/namespaces/${SHOP}/deployments/${n}`); return d.status?.availableReplicas === d.spec.replicas && d.status?.observedGeneration === d.metadata.generation; };
  await until('checkout revision 1 available', () => avail('checkout'));
  await until('cart available', () => avail('cart'));
  await sleep(1500);
  await apply(client, checkout('30', 'tune the payment gateway timeout'));
  await until('the bad revision crash-looping', async () => (await client.list(`/api/v1/namespaces/${SHOP}/pods`, { query: { labelSelector: 'app=checkout' } })).filter((p) => (p.status?.containerStatuses ?? []).some((c) => c.state?.waiting?.reason === 'CrashLoopBackOff')).length === 2);
  await crashEvents(client, SHOP);
  const d = await client.get(`/apis/apps/v1/namespaces/${SHOP}/deployments/checkout`);
  return { revision: Number(d.metadata.annotations['deployment.kubernetes.io/revision']), generation: d.metadata.generation };
}

/** Writes the kubeconfigs into .state/secrets.json (HARNESS_OPS_SECRETS=@...). */
export function writeSecrets(c) {
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(SECRETS_FILE, JSON.stringify({ 'ops-k8s-hwtest-reader': c.reader, 'ops-k8s-hwtest-operator': c.admin }, null, 1));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const recordAt = rest.includes('--record') ? rest[rest.indexOf('--record') + 1] : undefined;
  try {
    if (rest.includes('--check-env')) {
      // The harness this setup runs for must use this stack's operator inventory (its cluster) and credentials.
      const inv = process.env.HARNESS_OPS_INVENTORY;
      // A relative path is the harness's (the repository root, above solutions/operations), not this setup's working folder.
      const file = inv && [inv, path.resolve(here, '..', '..', '..', '..', '..', inv)].find((f) => fs.existsSync(f));
      if (!file || !fs.readFileSync(file, 'utf8').includes('ops-k8s-hwtest-reader')) throw new Error(`HARNESS_OPS_INVENTORY must name ${path.relative(process.cwd(), OPERATOR_INVENTORY)} (or an inventory with its cluster); it is ${inv ? `"${inv}"` : 'not set'}`);
      const sec = process.env.HARNESS_OPS_SECRETS;
      if (sec && path.resolve(sec.replace(/^@/, '')) !== path.resolve(SECRETS_FILE)) console.error(`note: HARNESS_OPS_SECRETS is ${sec}; this stack's kubeconfigs are in ${SECRETS_FILE}`);
    }
    if (cmd === 'up' || cmd === 'up-reset') {
      const c = await up();
      writeSecrets(c);
      if (cmd === 'up-reset' && rest.includes('crashloop')) {
        const s = await crashloop(c.client);
        if (recordAt) fs.writeFileSync(recordAt, JSON.stringify({ at: Date.now(), cluster: EVAL.name, namespace: SHOP, ...s }, null, 1));
        console.log(`shop/checkout crash-looping at revision ${s.revision}`);
      }
      c.client.close();
      console.log(`${EVAL.name} up at ${c.server}; credentials in ${path.relative(process.cwd(), SECRETS_FILE)}`);
    } else if (cmd === 'reset') {
      const c = await up();
      await dropNamespace(c.client, SHOP);
      c.client.close();
    } else if (cmd === 'status') {
      console.log(docker(['ps', '-a', '--filter', `name=^${EVAL.name}$`, '--format', '{{.Names}} {{.Status}} {{.Ports}}']).stdout.trim() || 'not running');
    } else if (cmd === 'down') down();
    else { console.error('usage: kwok.mjs up | up-reset crashloop [--record <file>] | reset | status | down'); process.exit(2); }
  } catch (e) { console.error(e.message); process.exit(1); }
}
