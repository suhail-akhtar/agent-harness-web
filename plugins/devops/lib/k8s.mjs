// Kubernetes: render and validate manifests (kubeconform, schemas cached in
// the ops image), helm template / lint, and against a cluster: diff, apply,
// rollout status / undo, get, describe, logs and events, summarised. The
// kubeconfig comes from the Key Vault into a private temporary file (removed
// when the command ends) - never into the workspace or the output.

import path from 'node:path';
import { fromVault, guard, need, offline, parseJson, q, relIn, relList, seconds, sh, tail, UserError, words } from './common.mjs';

const KUBECONFORM_SCHEMA = '{{ .NormalizedKubernetesVersion }}-standalone{{ .StrictSuffix }}/{{ .ResourceKind }}{{ .KindSuffix }}.json';
const NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const RESOURCE = /^[a-zA-Z][\w.-]*\/[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

/** kubeconform arguments: the cached schemas first, the online catalogue only where the network is open. */
function schemaArgs(host, kubernetesVersion) {
  const local = `-schema-location "\${HARNESS_K8S_SCHEMAS:-/opt/k8s-schemas}/${KUBECONFORM_SCHEMA}"`;
  const online = offline(host) ? '' : ' -schema-location default';
  return `${local}${online}${kubernetesVersion ? ` -kubernetes-version ${q(kubernetesVersion)}` : ''}`;
}

/** kubeconform -output json: problems as lines, and what was skipped. */
export function kubeconformReport(json) {
  const res = json?.resources ?? [];
  const invalid = res.filter((r) => r.status === 'statusInvalid' || r.status === 'statusError');
  const skipped = res.filter((r) => r.status === 'statusSkipped');
  const s = json?.summary ?? {};
  const lines = invalid.map((r) => `${r.filename}: ${r.kind ?? '?'} ${r.name ?? ''}: ${String(r.msg ?? '').replace(/\s+/g, ' ').slice(0, 400)}`);
  return {
    ok: invalid.length === 0 && !s.invalid && !s.errors,
    lines,
    skipped: skipped.map((r) => `${r.kind ?? '?'} ${r.name ?? ''} (${r.filename})`),
    valid: s.valid ?? 0,
    invalid: (s.invalid ?? 0) + (s.errors ?? 0),
  };
}

/** Runs kubeconform on files/dirs (or "-" with stdin text). */
export async function kubeconform(host, targets, signal, { stdinCmd, kubernetesVersion, strict = true } = {}) {
  const base = `kubeconform ${strict ? '-strict ' : ''}-summary -verbose -output json -ignore-missing-schemas ${schemaArgs(host, kubernetesVersion)}`;
  const cmd = stdinCmd ? `set -o pipefail; ${stdinCmd} | ${base} -` : `${base} ${words(targets)}`;
  const r = await sh(host, cmd, { signal, timeoutMs: 300_000 });
  const json = parseJson(r.stdout);
  if (!json) return { ok: false, lines: [`kubeconform failed (exit ${r.code}): ${tail(r.output, 20)}`], skipped: [], valid: 0, invalid: 1, raw: r.output };
  return kubeconformReport(json);
}

/** Kubernetes manifests in the workspace: YAML with apiVersion and kind, not templates, not CI or compose files. */
export async function findManifests(host, signal, max = 200) {
  const cmd = "grep -rlE --include='*.yaml' --include='*.yml' --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.github --exclude-dir=.harness --exclude-dir=.terraform '^apiVersion:' . 2>/dev/null | while IFS= read -r f; do grep -qE '^kind:' \"$f\" && ! grep -q '{{' \"$f\" && echo \"$f\"; done | head -" + max;
  const r = await sh(host, cmd, { signal, timeoutMs: 60_000 });
  return r.stdout.split('\n').map((l) => l.trim().replace(/^\.\//, '')).filter(Boolean);
}

/** Helm charts in the workspace (folders with Chart.yaml). */
export async function findCharts(host, signal) {
  const r = await sh(host, "find . \\( -name .git -o -name node_modules -o -name .harness \\) -prune -o -name Chart.yaml -print 2>/dev/null | head -20", { signal, timeoutMs: 60_000 });
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/^\.\//, '').replace(/\/?Chart\.yaml$/, '') || '.');
}

// ---------- cluster ----------

/** The kubeconfig for this call from the Key Vault (a file only the command can read), or the runtime's own. */
async function kubeEnv(ctx, input, purpose) {
  if (!input.kubeconfig) return {};
  const v = await fromVault(ctx, { KUBECONFIG: String(input.kubeconfig) }, purpose);
  return { files: v };
}

function kubectlBase(input) {
  const parts = ['kubectl'];
  if (input.context) parts.push(`--context ${q(input.context)}`);
  if (input.namespace) {
    if (!NAME.test(String(input.namespace))) throw new UserError(`${input.namespace} is not a valid namespace name`);
    parts.push(`-n ${q(input.namespace)}`);
  }
  return parts.join(' ');
}

async function kubectl(ctx, input, args, purpose, { timeoutMs = 120_000 } = {}) {
  const env = await kubeEnv(ctx, input, purpose);
  const r = await sh(ctx.host, `${kubectlBase(input)} ${args}`, { signal: ctx.signal, timeoutMs, ...env });
  return r;
}

const unreachable = (ctx, r) => (/connection refused|no such host|i\/o timeout|Unable to connect to the server|dial tcp/i.test(r.output)
  ? `\nThe cluster could not be reached from where commands run${ctx.host.networkPolicy === 'none' ? ' (this sandbox has no network: the operator allows the API server\'s host with an allowlist network)' : ''}.`
  : /current-context is not set|no configuration has been provided|invalid configuration/i.test(r.output)
    ? '\nNo kubeconfig: pass "kubeconfig": "<Key Vault secret name>" (the vault holds the file).'
    : '');

const age = (t) => {
  if (!t) return '';
  const s = Math.max(0, (Date.now() - Date.parse(t)) / 1000);
  return s < 120 ? `${Math.round(s)}s` : s < 7200 ? `${Math.round(s / 60)}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};

/** One line per pod: ready, restarts, why it is not running or ready. */
export function podLine(p) {
  const cs = p.status?.containerStatuses ?? [];
  const ready = `${cs.filter((c) => c.ready).length}/${cs.length || (p.spec?.containers?.length ?? 0)}`;
  const restarts = cs.reduce((n, c) => n + (c.restartCount ?? 0), 0);
  const waiting = cs.map((c) => c.state?.waiting).find(Boolean);
  const term = cs.map((c) => c.state?.terminated).find(Boolean);
  const last = cs.map((c) => c.lastState?.terminated).find(Boolean);
  const why = [];
  if (waiting) why.push(`${waiting.reason}${waiting.message ? `: ${String(waiting.message).slice(0, 160)}` : ''}`);
  else if (term) why.push(`terminated ${term.reason ?? ''} exit ${term.exitCode}`);
  if (last) why.push(`last exit ${last.exitCode}${last.reason ? ` (${last.reason})` : ''}`);
  const sched = (p.status?.conditions ?? []).find((c) => c.type === 'PodScheduled' && c.status === 'False');
  if (sched) why.push(`unschedulable: ${String(sched.message ?? sched.reason).slice(0, 160)}`);
  const notReady = (p.status?.conditions ?? []).find((c) => c.type === 'Ready' && c.status === 'False');
  if (!waiting && !term && p.status?.phase === 'Running' && notReady) why.push('running but not ready (readiness probe failing?)');
  const images = (p.spec?.containers ?? []).map((c) => c.image).join(',');
  return `pod/${p.metadata?.name} ${p.status?.phase ?? '?'} ready ${ready} restarts ${restarts} age ${age(p.metadata?.creationTimestamp)} image ${images}${why.length ? ` - ${why.join('; ')}` : ''}`;
}

/** A summary line for any object, by kind. */
export function objectLine(o) {
  const k = o.kind;
  const n = `${String(k).toLowerCase()}/${o.metadata?.name}`;
  const st = o.status ?? {};
  if (k === 'Pod') return podLine(o);
  if (k === 'Deployment' || k === 'StatefulSet' || k === 'ReplicaSet') {
    const want = o.spec?.replicas ?? 1;
    const images = (o.spec?.template?.spec?.containers ?? []).map((c) => c.image).join(',');
    const bad = (st.conditions ?? []).filter((c) => c.status === 'False' || c.reason === 'ProgressDeadlineExceeded').map((c) => `${c.type}: ${c.reason}`);
    return `${n} ready ${st.readyReplicas ?? 0}/${want} updated ${st.updatedReplicas ?? 0} available ${st.availableReplicas ?? 0} image ${images}${bad.length ? ` - ${bad.join('; ')}` : ''}`;
  }
  if (k === 'DaemonSet') return `${n} ready ${st.numberReady ?? 0}/${st.desiredNumberScheduled ?? 0} updated ${st.updatedNumberScheduled ?? 0}`;
  if (k === 'Service') return `${n} ${o.spec?.type} ${o.spec?.clusterIP ?? ''} ports ${(o.spec?.ports ?? []).map((p) => `${p.port}${p.targetPort ? `->${p.targetPort}` : ''}/${p.protocol ?? 'TCP'}`).join(',')}`;
  if (k === 'Job') return `${n} succeeded ${st.succeeded ?? 0} failed ${st.failed ?? 0} active ${st.active ?? 0}`;
  if (k === 'Node') return `${n} ${(st.conditions ?? []).find((c) => c.type === 'Ready')?.status === 'True' ? 'Ready' : 'NotReady'} ${st.nodeInfo?.kubeletVersion ?? ''}`;
  if (k === 'Secret') return `${n} type ${o.type} keys ${Object.keys(o.data ?? {}).join(',')} (values not shown)`;
  return `${n} age ${age(o.metadata?.creationTimestamp)}`;
}

/** Events: warnings first, then the most recent others. */
export function eventLines(items, max = 40) {
  const ts = (e) => Date.parse(e.lastTimestamp || e.eventTime || e.metadata?.creationTimestamp || 0) || 0;
  const sorted = [...items].sort((a, b) => ts(b) - ts(a));
  const fmt = (e) => `${e.type} ${e.reason} ${String(e.involvedObject?.kind ?? '').toLowerCase()}/${e.involvedObject?.name}: ${String(e.message ?? '').replace(/\s+/g, ' ').slice(0, 240)}${(e.count ?? 1) > 1 ? ` (x${e.count})` : ''} ${age(e.lastTimestamp || e.eventTime)} ago`;
  const warn = sorted.filter((e) => e.type === 'Warning');
  const rest = sorted.filter((e) => e.type !== 'Warning');
  return [...warn.slice(0, max).map(fmt), ...rest.slice(0, Math.max(5, max - warn.length)).map(fmt)];
}

/** kubectl diff output: the objects that change, and the diff trimmed. */
export function summarizeDiff(text) {
  const objects = [];
  for (const m of String(text).matchAll(/^diff -u -N \S*\/LIVE-[^/\s]+\/(\S+) \S+/gm)) {
    // apps.v1.Deployment.default.web
    const parts = m[1].split('.');
    const name = parts.pop();
    const ns = parts.pop();
    const kind = parts.pop();
    objects.push(`${kind} ${ns}/${name}`);
  }
  const plus = (String(text).match(/^\+(?!\+\+)/gm) ?? []).length;
  const minus = (String(text).match(/^-(?!--)/gm) ?? []).length;
  const body = String(text).split('\n').filter((l) => !/^\s*[-+]\s*(generation|resourceVersion|uid|creationTimestamp):/.test(l)).filter((l) => !/^diff -u -N /.test(l));
  return { objects, plus, minus, body: body.slice(0, 200).join('\n') + (body.length > 200 ? `\n... ${body.length - 200} more lines` : '') };
}

const WORKLOAD = /^(deployment|deployments|deploy|statefulset|statefulsets|sts|daemonset|daemonsets|ds)(\.apps)?\//i;

/** After a failed rollout: the workload's pods and their warnings, so the cause is on screen. */
async function diagnose(ctx, input, resource) {
  const sel = await kubectl(ctx, input, `get ${q(resource)} -o json`, `k8s diagnose ${resource}`);
  const obj = parseJson(sel.stdout);
  const labels = obj?.spec?.selector?.matchLabels;
  const out = obj ? [objectLine(obj)] : [];
  if (labels && Object.keys(labels).length) {
    const l = Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(',');
    const pods = parseJson((await kubectl(ctx, input, `get pods -l ${q(l)} -o json`, `k8s diagnose ${resource}`)).stdout);
    const items = pods?.items ?? [];
    out.push(...items.slice(0, 15).map(podLine));
    const names = new Set(items.map((p) => p.metadata?.name));
    const ev = parseJson((await kubectl(ctx, input, 'get events -o json', `k8s diagnose ${resource}`)).stdout);
    const mine = (ev?.items ?? []).filter((e) => names.has(e.involvedObject?.name) || e.involvedObject?.name === obj?.metadata?.name || String(e.involvedObject?.name ?? '').startsWith(`${obj?.metadata?.name}-`));
    const ws = eventLines(mine, 15).filter((x) => x.startsWith('Warning'));
    if (ws.length) out.push('Warnings:', ...ws.map((w) => `  ${w}`));
  }
  return out.join('\n');
}

async function rolloutStatus(ctx, input, resource) {
  const t = seconds(input.timeoutSec, 120, 1800);
  const r = await kubectl(ctx, input, `rollout status ${q(resource)} --timeout=${t}s`, `k8s rollout status ${resource}`, { timeoutMs: (t + 30) * 1000 });
  if (r.code === 0) return { ok: true, text: `${resource}: ${tail(r.output, 1)}` };
  const why = await diagnose(ctx, input, resource).catch(() => '');
  return { ok: false, text: `${resource}: rollout did not complete in ${t}s.\n${tail(r.output, 6)}${unreachable(ctx, r)}${why ? `\n${why}` : ''}` };
}

function checkResource(r) {
  const s = String(r ?? '');
  if (!RESOURCE.test(s)) throw new UserError(`resource must be kind/name, e.g. deployment/web (got "${s}")`);
  return s;
}

async function helmArgs(host, input) {
  const chart = await relIn(host, input.chart);
  const values = await relList(host, input.values);
  const sets = Object.entries(input.set ?? {}).map(([k, v]) => {
    if (!/^[\w.\-[\]]+$/.test(k)) throw new UserError(`${k} is not a valid --set key`);
    return `--set ${q(`${k}=${v}`)}`;
  });
  const release = String(input.release ?? 'release');
  if (!NAME.test(release)) throw new UserError(`${release} is not a valid release name`);
  return { chart, release, rest: [...values.map((v) => `-f ${q(v)}`), ...sets, input.namespace ? `--namespace ${q(input.namespace)}` : ''].filter(Boolean).join(' ') };
}

const listOf = (rep) => [
  ...rep.lines,
  ...(rep.skipped.length ? [`Not validated (no schema here - a CRD or an uncached kind): ${rep.skipped.slice(0, 15).join(', ')}`] : []),
];

export async function runK8s(input, ctx) {
  return guard(async () => {
    const { host, signal } = ctx;
    const action = String(input.action ?? '');
    if (action === 'validate') {
      const n = await need(host, 'kubeconform', 'kubeconform', signal);
      if (n.error) return n.error;
      const targets = input.paths ? await relList(host, input.paths) : await findManifests(host, signal);
      const charts = input.paths ? [] : await findCharts(host, signal);
      if (!targets.length && !charts.length) return { content: 'No Kubernetes manifests (YAML with apiVersion and kind) or Helm charts in the workspace.', is_error: true };
      const parts = [];
      let bad = 0;
      if (targets.length) {
        const rep = await kubeconform(host, targets, signal, { kubernetesVersion: input.kubernetesVersion });
        bad += rep.invalid;
        parts.push(`${targets.length} file(s): ${rep.valid} resource(s) valid, ${rep.invalid} invalid`, ...listOf(rep));
      }
      for (const c of charts) {
        const h = await need(host, 'helm', 'Helm', signal);
        if (h.error) { parts.push(`chart ${c}: not rendered (${h.error.content})`); continue; }
        const rep = await kubeconform(host, [], signal, { stdinCmd: `helm template hw ${q(c)}`, kubernetesVersion: input.kubernetesVersion });
        bad += rep.invalid;
        parts.push(`chart ${c} (helm template): ${rep.valid} resource(s) valid, ${rep.invalid} invalid`, ...listOf(rep));
      }
      return { content: `kubeconform (strict): ${bad ? `${bad} problem(s)` : 'all valid'}\n${parts.join('\n')}`, is_error: bad > 0 };
    }
    if (action === 'template' || action === 'lint') {
      const n = await need(host, 'helm', 'Helm', signal);
      if (n.error) return n.error;
      if (!input.chart) return { content: `${action} needs chart: the chart folder (with Chart.yaml) in the workspace.`, is_error: true };
      const { chart, release, rest } = await helmArgs(host, input);
      if (action === 'lint') {
        const r = await sh(host, `helm lint ${q(chart)} ${rest} 2>&1`, { signal, timeoutMs: 120_000 });
        const msgs = r.output.split('\n').filter((l) => /\[(ERROR|WARNING|INFO)\]/.test(l));
        return { content: `helm lint ${chart}: ${r.code === 0 ? 'passed' : 'failed'}${msgs.length ? `\n${msgs.slice(0, 40).join('\n')}` : ''}${r.code !== 0 && !msgs.length ? `\n${tail(r.output, 30)}` : ''}`, is_error: r.code !== 0 };
      }
      const out = await relIn(host, input.out ?? `.harness/devops/rendered/${release}.yaml`);
      const r = await sh(host, `mkdir -p ${q(path.posix.dirname(out))} && helm template ${q(release)} ${q(chart)} ${rest} > ${q(out)}`, { signal, timeoutMs: 120_000 });
      if (r.code !== 0) return { content: `helm template failed:\n${tail(r.output, 30)}`, is_error: true };
      const kinds = await sh(host, `grep -E '^(kind|  name):' ${q(out)} | paste - - | sed -E 's/kind: *//; s/\\s+name: */ /' | head -60`, { signal, timeoutMs: 30_000 });
      let validation = '';
      const kc = await need(host, 'kubeconform', 'kubeconform', signal);
      if (!kc.error) {
        const rep = await kubeconform(host, [out], signal, { kubernetesVersion: input.kubernetesVersion });
        validation = `\nkubeconform: ${rep.valid} valid, ${rep.invalid} invalid${rep.lines.length ? `\n${listOf(rep).join('\n')}` : ''}`;
      }
      return `Rendered ${chart} as release ${release} to ${out}:\n${kinds.stdout.trim()}${validation}`;
    }

    // Against a cluster.
    const kc = await need(host, 'kubectl', 'kubectl', signal);
    if (kc.error) return kc.error;
    if (action === 'diff' || action === 'apply') {
      const targets = await relList(host, input.paths);
      if (!targets.length) return { content: `${action} needs paths: manifest files or folders in the workspace.`, is_error: true };
      const files = targets.map((t) => `-f ${q(t)}`).join(' ');
      if (action === 'diff') {
        const r = await kubectl(ctx, input, `diff ${files}`, `k8s diff ${targets.join(' ')}`, { timeoutMs: 180_000 });
        if (r.code === 0) return `No differences: the cluster already matches ${targets.join(', ')}.`;
        if (r.code !== 1) return { content: `kubectl diff failed (exit ${r.code}):\n${tail(r.output, 30)}${unreachable(ctx, r)}`, is_error: true };
        const d = summarizeDiff(r.stdout);
        return `${d.objects.length} object(s) would change (+${d.plus} -${d.minus} lines): ${d.objects.join(', ')}\n\n${d.body}`;
      }
      const r = await kubectl(ctx, input, `apply ${files}`, `k8s apply ${targets.join(' ')}`, { timeoutMs: 300_000 });
      if (r.code !== 0) return { content: `kubectl apply failed (exit ${r.code}):\n${tail(r.output, 30)}${unreachable(ctx, r)}`, is_error: true };
      const applied = r.stdout.trim().split('\n').filter(Boolean);
      if (input.wait === false) return `Applied:\n${applied.join('\n')}`;
      // Wait for every workload that changed.
      const workloads = applied.map((l) => l.split(/\s+/)[0]).filter((x) => WORKLOAD.test(x) && !/ unchanged$/.test(applied.find((l) => l.startsWith(x)) ?? ''));
      const results = [];
      for (const w of workloads.slice(0, 10)) results.push(await rolloutStatus(ctx, input, w));
      const failed = results.filter((x) => !x.ok);
      return {
        content: `Applied:\n${applied.join('\n')}${results.length ? `\n\nRollouts:\n${results.map((x) => x.text).join('\n')}` : ''}${failed.length ? `\n\n${failed.length} rollout(s) failed. Undo with {"action": "rollout-undo", "resource": "<kind/name>"} if the change is at fault.` : ''}`,
        is_error: failed.length > 0,
      };
    }
    if (action === 'rollout-status') {
      const s = await rolloutStatus(ctx, input, checkResource(input.resource));
      return { content: s.text, is_error: !s.ok };
    }
    if (action === 'rollout-undo') {
      const resource = checkResource(input.resource);
      const rev = input.toRevision !== undefined ? ` --to-revision=${Math.max(0, Math.floor(Number(input.toRevision)))}` : '';
      const r = await kubectl(ctx, input, `rollout undo ${q(resource)}${rev}`, `k8s rollout undo ${resource}`);
      if (r.code !== 0) return { content: `kubectl rollout undo failed:\n${tail(r.output, 20)}${unreachable(ctx, r)}`, is_error: true };
      const s = await rolloutStatus(ctx, input, resource);
      return { content: `${tail(r.output, 3)}\nAfter the undo: ${s.text}`, is_error: !s.ok };
    }
    if (action === 'get') {
      const what = String(input.resource ?? input.what ?? 'pods');
      if (!/^[a-zA-Z][\w.,/-]*$/.test(what)) return { content: `resource must be a kind (pods, deployments) or kind/name (got "${what}")`, is_error: true };
      const sel = input.selector ? ` -l ${q(input.selector)}` : '';
      const r = await kubectl(ctx, input, `get ${q(what)}${sel} -o json`, `k8s get ${what}`);
      if (r.code !== 0) return { content: `kubectl get failed:\n${tail(r.output, 20)}${unreachable(ctx, r)}`, is_error: true };
      const j = parseJson(r.stdout);
      const items = j?.kind === 'List' || Array.isArray(j?.items) ? j.items : j ? [j] : [];
      return items.length ? `${items.length} object(s):\n${items.slice(0, 80).map(objectLine).join('\n')}` : `No ${what} found${input.namespace ? ` in ${input.namespace}` : ''}.`;
    }
    if (action === 'describe') {
      const resource = checkResource(input.resource);
      const r = await kubectl(ctx, input, `describe ${q(resource)}`, `k8s describe ${resource}`);
      if (r.code !== 0) return { content: `kubectl describe failed:\n${tail(r.output, 20)}${unreachable(ctx, r)}`, is_error: true };
      const lines = r.stdout.split('\n');
      return { content: lines.length > 150 ? `${lines.slice(0, 110).join('\n')}\n...\n${lines.slice(-40).join('\n')}` : r.stdout.trim(), untrusted: true };
    }
    if (action === 'logs') {
      const resource = checkResource(input.resource);
      const lines = Math.min(Math.max(Math.floor(Number(input.tail) || 200), 1), 2000);
      const flags = [`--tail=${lines}`, input.previous === true ? '--previous' : '', input.container ? `-c ${q(input.container)}` : '--all-containers=true', '--prefix=false'].filter(Boolean).join(' ');
      const r = await kubectl(ctx, input, `logs ${q(resource)} ${flags}`, `k8s logs ${resource}`);
      if (r.code !== 0) return { content: `kubectl logs failed:\n${tail(r.output, 20)}${unreachable(ctx, r)}${/previous terminated container/.test(r.output) ? '\n(There is no previous container: drop "previous".)' : ''}`, is_error: true };
      const text = r.stdout.replace(/\r/g, '');
      const errs = text.split('\n').filter((l) => /\b(error|exception|fatal|panic|traceback|refused|denied|failed)\b/i.test(l));
      return { content: `${errs.length ? `${errs.length} error-like line(s), first: ${errs.slice(0, 5).map((e) => e.slice(0, 300)).join(' | ')}\n\n` : ''}Last ${lines} lines${input.previous === true ? ' of the previous (crashed) container' : ''}:\n${tail(text, lines, 12_000)}`, untrusted: true };
    }
    if (action === 'events') {
      const fs = input.resource ? ` --field-selector ${q(`involvedObject.name=${String(input.resource).split('/').pop()}`)}` : '';
      const r = await kubectl(ctx, input, `get events${fs} -o json`, 'k8s events');
      if (r.code !== 0) return { content: `kubectl get events failed:\n${tail(r.output, 20)}${unreachable(ctx, r)}`, is_error: true };
      const items = parseJson(r.stdout)?.items ?? [];
      return { content: items.length ? `${items.filter((e) => e.type === 'Warning').length} warning(s), ${items.length} event(s):\n${eventLines(items).join('\n')}` : 'No events.', untrusted: true };
    }
    return { content: `Unknown action ${action}: use validate, template, lint, diff, apply, rollout-status, rollout-undo, get, describe, logs or events.`, is_error: true };
  });
}

export const K8S_REMOTE = new Set(['diff', 'apply', 'rollout-status', 'rollout-undo', 'get', 'describe', 'logs', 'events']);
export const K8S_CHANGES = new Set(['apply', 'rollout-undo']);

export const k8sParameters = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['validate', 'template', 'lint', 'diff', 'apply', 'rollout-status', 'rollout-undo', 'get', 'describe', 'logs', 'events'], description: 'What to do: validate, template and lint offline; the rest against a cluster' },
    paths: { type: 'array', items: { type: 'string' }, description: 'validate/diff/apply: manifest files or folders (validate default: every manifest and chart in the workspace)' },
    chart: { type: 'string', description: 'template/lint: chart folder' },
    release: { type: 'string', description: 'template: release name (default "release")' },
    values: { type: 'array', items: { type: 'string' }, description: 'template/lint: values files' },
    set: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] }, description: 'template/lint: --set values (not secrets)' },
    out: { type: 'string', description: 'template: where to write the rendered YAML (default .harness/devops/rendered/<release>.yaml)' },
    kubernetesVersion: { type: 'string', description: 'validate: target version for schemas, e.g. 1.31.0 (default: the cached master schemas)' },
    resource: { type: 'string', description: 'kind/name, e.g. deployment/web (rollout-*, describe, logs; get also takes a kind like pods)' },
    selector: { type: 'string', description: 'get: label selector' },
    namespace: { type: 'string', description: 'Kubernetes namespace for kubectl and helm (default: the context\'s namespace)' },
    context: { type: 'string', description: 'kubeconfig context' },
    kubeconfig: { type: 'string', description: 'Key Vault secret name holding the kubeconfig (written to a private temporary file for the call). Default: the runtime\'s own kubeconfig.' },
    wait: { type: 'boolean', description: 'apply: wait for changed workloads to roll out (default true)' },
    toRevision: { type: 'number', description: 'rollout-undo: revision to go back to (default the previous one)' },
    container: { type: 'string', description: 'logs: one container' },
    previous: { type: 'boolean', description: 'logs: the previous (crashed) container' },
    tail: { type: 'number', description: 'logs: lines (default 200)' },
    timeoutSec: { type: 'number', description: 'rollout wait (default 120)' },
  },
  required: ['action'],
  additionalProperties: false,
};
