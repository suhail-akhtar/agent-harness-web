// Containers: lint Dockerfiles (hadolint), scan (trivy: config and secrets
// offline; vulnerabilities with its database), and build where a Docker daemon
// is reachable. A session sandbox has no daemon: build then says so plainly
// and lints and scans instead - it never pretends an image was built.

import path from 'node:path';
import { fromVault, guard, need, offline as isOffline, parseJson, q, relIn, seconds, sh, tail } from './common.mjs';

export const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];

/** hadolint -f json: lines and counts by level. */
export function hadolintReport(list) {
  const items = Array.isArray(list) ? list : [];
  const by = { error: 0, warning: 0, info: 0, style: 0 };
  for (const i of items) by[i.level] = (by[i.level] ?? 0) + 1;
  const order = { error: 0, warning: 1, info: 2, style: 3 };
  const lines = [...items].sort((a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9) || a.line - b.line)
    .map((i) => `${i.file}:${i.line} ${i.level.toUpperCase()} ${i.code}: ${i.message}`);
  return { by, lines, blocking: by.error + by.warning };
}

export async function hadolint(host, files, signal) {
  const n = await need(host, 'hadolint', 'hadolint', signal);
  if (n.error) return { error: n.error };
  const r = await sh(host, `hadolint --no-fail -f json ${files.map(q).join(' ')}`, { signal, timeoutMs: 120_000 });
  const list = parseJson(r.stdout);
  if (!Array.isArray(list)) return { error: { content: `hadolint failed (exit ${r.code}): ${tail(r.output, 15)}`, is_error: true } };
  return { report: hadolintReport(list) };
}

/** trivy JSON: findings by severity (misconfigurations, secrets, vulnerabilities). Secret values are never shown. */
export function trivyReport(json) {
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  const findings = [];
  for (const res of json?.Results ?? []) {
    for (const m of res.Misconfigurations ?? []) {
      if (m.Status && m.Status !== 'FAIL') continue;
      counts[m.Severity] = (counts[m.Severity] ?? 0) + 1;
      const line = m.CauseMetadata?.StartLine ? `:${m.CauseMetadata.StartLine}` : '';
      findings.push({ sev: m.Severity, text: `${m.Severity} ${m.ID ?? m.AVDID} ${res.Target}${line}: ${m.Title}${m.Message && m.Message !== m.Title ? ` - ${String(m.Message).slice(0, 200)}` : ''}${m.Resolution ? ` (fix: ${String(m.Resolution).slice(0, 160)})` : ''}` });
    }
    for (const s of res.Secrets ?? []) {
      counts[s.Severity] = (counts[s.Severity] ?? 0) + 1;
      findings.push({ sev: s.Severity, text: `${s.Severity} secret ${s.RuleID} ${res.Target}:${s.StartLine}: ${s.Title} (value not shown)` });
    }
    for (const v of res.Vulnerabilities ?? []) {
      counts[v.Severity] = (counts[v.Severity] ?? 0) + 1;
      findings.push({ sev: v.Severity, text: `${v.Severity} ${v.VulnerabilityID} ${v.PkgName} ${v.InstalledVersion}${v.FixedVersion ? ` -> fixed in ${v.FixedVersion}` : ' (no fix yet)'} [${res.Target}]${v.Title ? `: ${String(v.Title).slice(0, 140)}` : ''}` });
    }
  }
  const rank = Object.fromEntries(SEVERITIES.map((s, i) => [s, i]));
  findings.sort((a, b) => (rank[a.sev] ?? 9) - (rank[b.sev] ?? 9));
  return { counts, findings: findings.map((f) => f.text), total: findings.length, high: (counts.CRITICAL ?? 0) + (counts.HIGH ?? 0) };
}

export const countLine = (c) => SEVERITIES.map((s) => `${s} ${c[s] ?? 0}`).join(', ');

/** Whether trivy's vulnerability database is in its cache where commands run. */
async function hasDb(host, signal) {
  const r = await sh(host, 'test -s "${TRIVY_CACHE_DIR:-$HOME/.cache/trivy}/db/trivy.db"', { signal, timeoutMs: 15_000 });
  return r.code === 0;
}

/**
 * trivy on a path: "config" (IaC misconfigurations), "fs" (secrets and
 * misconfigurations, plus vulnerabilities in lock files when the database is
 * there or can be downloaded), or "image" (a docker save tarball).
 */
export async function trivy(host, mode, target, signal, { vulns = true, severity, only } = {}) {
  const n = await need(host, 'trivy', 'trivy', signal);
  if (n.error) return { error: n.error };
  const notes = [];
  let scanners = '';
  let dbFlags = '';
  if (mode === 'fs' || mode === 'image') {
    const db = await hasDb(host, signal);
    const offline = isOffline(host);
    const wantVuln = vulns && (db || !offline);
    if (vulns && !wantVuln && !only) notes.push('Vulnerabilities were NOT scanned: trivy\'s vulnerability database is not in this image and the sandbox has no network (build the ops image with --build-arg TRIVY_DB=1, or allow ghcr.io/mirror.gcr.io).');
    if (mode === 'image' && !wantVuln) return { error: { content: notes[0] ?? 'trivy image needs the vulnerability database.', is_error: true } };
    scanners = only ? `--scanners ${only}` : mode === 'fs' ? `--scanners ${['secret', 'misconfig', ...(wantVuln ? ['vuln'] : [])].join(',')}` : '--scanners vuln,secret';
    dbFlags = db ? '--skip-db-update' : '';
  }
  const sev = severity ? `--severity ${q(severity)}` : '';
  const what = mode === 'image' ? `--input ${q(target)}` : q(target);
  const r = await sh(host, `trivy ${mode} --quiet --format json --skip-check-update ${dbFlags} ${scanners} ${sev} ${what}`, { signal, timeoutMs: 900_000 });
  const json = parseJson(r.stdout);
  if (!json) return { error: { content: `trivy ${mode} failed (exit ${r.code}): ${tail(r.output, 20)}`, is_error: true } };
  return { report: trivyReport(json), notes };
}

async function dockerEnv(ctx, input, purpose) {
  return input.dockerHost ? fromVault(ctx, { DOCKER_HOST: String(input.dockerHost) }, purpose) : {};
}

export async function runContainer(input, ctx) {
  return guard(async () => {
    const { host, signal } = ctx;
    const action = String(input.action ?? '');
    if (action === 'lint') {
      const df = await relIn(host, input.dockerfile ?? 'Dockerfile');
      const h = await hadolint(host, [df], signal);
      if (h.error) return h.error;
      const { by, lines, blocking } = h.report;
      return { content: `hadolint ${df}: ${by.error} error(s), ${by.warning} warning(s), ${by.info} info, ${by.style} style${lines.length ? `\n${lines.join('\n')}` : ''}`, is_error: blocking > 0 };
    }
    if (action === 'scan') {
      const mode = input.tarball ? 'image' : input.mode === 'config' ? 'config' : 'fs';
      const target = await relIn(host, input.tarball ?? input.path ?? '.');
      const t = await trivy(host, mode, target, signal, { vulns: input.vulns !== false, severity: input.severity });
      if (t.error) return t.error;
      const { counts, findings, high } = t.report;
      return { content: `trivy ${mode} ${target}: ${countLine(counts)}${findings.length ? `\n${findings.slice(0, 60).join('\n')}${findings.length > 60 ? `\n... ${findings.length - 60} more` : ''}` : '\nNothing found.'}${t.notes.length ? `\n${t.notes.join('\n')}` : ''}`, is_error: high > 0 };
    }
    if (action === 'build') {
      const df = await relIn(host, input.dockerfile ?? 'Dockerfile');
      const context = await relIn(host, input.context ?? (path.posix.dirname(df) || '.'));
      const tag = String(input.tag ?? '');
      if (!/^[a-z0-9][a-z0-9._/-]*(:[\w.-]+)?$/.test(tag)) return { content: 'build needs tag: an image name like app:1.2.3 (lower case).', is_error: true };
      const env = await dockerEnv(ctx, input, `container build ${tag}`);
      const dk = await need(host, 'docker', 'the docker CLI', signal);
      const daemon = dk.error ? null : await sh(host, "docker info --format '{{.ServerVersion}}'", { signal, timeoutMs: 30_000, env });
      const lint = await hadolint(host, [df], signal);
      const lintText = lint.error ? `hadolint: ${lint.error.content}` : `hadolint: ${lint.report.by.error} error(s), ${lint.report.by.warning} warning(s)${lint.report.lines.length ? `\n${lint.report.lines.slice(0, 30).join('\n')}` : ''}`;
      if (!daemon || daemon.code !== 0) {
        const scan = await trivy(host, 'config', df, signal);
        const scanText = scan.error ? `trivy config: ${scan.error.content}` : `trivy config: ${countLine(scan.report.counts)}${scan.report.findings.length ? `\n${scan.report.findings.slice(0, 30).join('\n')}` : ''}`;
        return {
          content: `NOT BUILT: no Docker daemon is reachable where commands run (${dk.error ? 'no docker CLI' : 'docker info failed'}; a session sandbox has none - pass dockerHost, a Key Vault secret holding a DOCKER_HOST such as ssh://deploy@builder, or build on a dedicated runner). Checked the Dockerfile instead:\n${lintText}\n${scanText}`,
          is_error: true,
        };
      }
      const args = Object.entries(input.buildArgs ?? {}).map(([k, v]) => `--build-arg ${q(`${k}=${v}`)}`).join(' ');
      const t = seconds(input.timeoutSec, 1200, 3600);
      const b = await sh(host, `docker build -t ${q(tag)} -f ${q(df)} ${args} ${q(context)} 2>&1`, { signal, timeoutMs: t * 1000, env });
      if (b.code !== 0) return { content: `docker build failed (exit ${b.code}${b.timedOut ? ', timed out' : ''}):\n${tail(b.output, 50)}\n${lintText}`, is_error: true };
      let scanText = '';
      let high = 0;
      if (input.scan !== false) {
        const tar = `.harness/devops/images/${tag.replace(/[/:]/g, '_')}.tar`;
        const s = await sh(host, `mkdir -p .harness/devops/images && docker save -o ${q(tar)} ${q(tag)}`, { signal, timeoutMs: 600_000, env });
        if (s.code === 0) {
          const scan = await trivy(host, 'image', tar, signal);
          scanText = scan.error ? `\ntrivy image: ${scan.error.content}` : `\ntrivy image: ${countLine(scan.report.counts)}${scan.report.findings.length ? `\n${scan.report.findings.slice(0, 40).join('\n')}` : ''}`;
          high = scan.report?.high ?? 0;
          await sh(host, `rm -f ${q(tar)}`, { signal, timeoutMs: 30_000 });
        } else scanText = `\n(could not save the image for scanning: ${tail(s.output, 5)})`;
      }
      const size = await sh(host, `docker image inspect ${q(tag)} --format '{{.Size}}'`, { signal, timeoutMs: 30_000, env });
      return { content: `Built ${tag} on Docker ${daemon.stdout.trim()} (${(Number(size.stdout.trim()) / 1048576 || 0).toFixed(0)} MB).\n${lintText}${scanText}`, is_error: high > 0 };
    }
    return { content: `Unknown action ${action}: use lint, scan or build.`, is_error: true };
  });
}

export const containerParameters = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['lint', 'scan', 'build'] },
    dockerfile: { type: 'string', description: 'lint/build: the Dockerfile (default Dockerfile)' },
    path: { type: 'string', description: 'scan: folder or file to scan (default the workspace)' },
    mode: { type: 'string', enum: ['fs', 'config'], description: 'scan: fs (secrets, misconfigurations, vulnerabilities in lock files) or config (IaC misconfigurations only). Default fs.' },
    tarball: { type: 'string', description: 'scan: an image saved with docker save (scanned for vulnerabilities)' },
    vulns: { type: 'boolean', description: 'scan: include vulnerabilities (default true; needs trivy\'s database or the network)' },
    severity: { type: 'string', description: 'scan: only these, e.g. HIGH,CRITICAL' },
    context: { type: 'string', description: 'build: build context (default the Dockerfile\'s folder)' },
    tag: { type: 'string', description: 'build: image name:tag' },
    buildArgs: { type: 'object', additionalProperties: { type: 'string' }, description: 'build: --build-arg values (not secrets)' },
    scan: { type: 'boolean', description: 'build: scan the built image (default true)' },
    dockerHost: { type: 'string', description: 'build: Key Vault secret holding the DOCKER_HOST to build on' },
    timeoutSec: { type: 'number' },
  },
  required: ['action'],
  additionalProperties: false,
};
