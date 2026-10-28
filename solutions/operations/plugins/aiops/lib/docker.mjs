// The Docker engine the server can reach (the docker CLI, DOCKER_HOST honoured):
// containers with health, restarts, resource use and the user they run as, and
// their logs. Reading only - changes go through service_control, asked first.

import { cleanEnv, runProgram } from './proc.mjs';
import { secretName } from './secrets.mjs';

const dockerEnv = () => {
  // DOCKER_HOST / DOCKER_CONTEXT are how an operator points at another engine; credentials stay out.
  const env = cleanEnv();
  for (const k of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY']) if (process.env[k]) env[k] = process.env[k];
  return env;
};

export const docker = (args, opts = {}) => runProgram(process.env.HARNESS_OPS_DOCKER || 'docker', args, { timeoutMs: 30_000, env: dockerEnv(), ...opts });

// ---------- the server's own engine: off unless the operator turns it on ----------
//
// On a shared server the local engine runs every user's sandbox and the egress
// proxies: listing it shows other people's work, and stopping a container there
// is stopping theirs. So the ops tools use it only when the operator says so
// (HARNESS_OPS_LOCAL_DOCKER=1), only for the containers the operator lists
// (HARNESS_OPS_LOCAL_DOCKER_ALLOW: names or globs, and label:key=value), and
// never for the harness's own containers (harness-* names, the harness-web label).

export const LOCAL_DOCKER_OFF = 'The server\'s own Docker engine is off for the ops tools: it runs other sessions\' sandboxes too. The operator turns it on with HARNESS_OPS_LOCAL_DOCKER=1 and lists the containers the ops tools may see and control in HARNESS_OPS_LOCAL_DOCKER_ALLOW (names or globs such as shop-*, or label:key=value). Containers on inventory hosts are reached over ssh (host).';

const globRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);

/** The operator's switch and allowlist; `allows({ name, labels })` decides one container. */
export function localDockerPolicy(env = process.env) {
  const enabled = /^(1|on|true|yes)$/i.test(String(env.HARNESS_OPS_LOCAL_DOCKER ?? '').trim());
  const entries = String(env.HARNESS_OPS_LOCAL_DOCKER_ALLOW ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const names = entries.filter((e) => !e.startsWith('label:')).map(globRe);
  const labels = entries.filter((e) => e.startsWith('label:')).map((e) => { const [k, ...v] = e.slice(6).split('='); return [k, v.length ? v.join('=') : undefined]; });
  const harnessOwn = (name, l) => /^harness-/.test(name) || !!l?.['harness-web'];
  return {
    enabled,
    entries,
    allows({ name, labels: l = {} }) {
      const n = String(name ?? '').replace(/^\//, '');
      if (!enabled || !n || harnessOwn(n, l)) return false;
      return names.some((re) => re.test(n)) || labels.some(([k, v]) => k in l && (v === undefined || l[k] === v));
    },
  };
}

/**
 * A container on the local engine by name or id, if the operator allows it:
 * { id, name }, inspected first so a name prefix or an id cannot reach another
 * container. Throws with the reason otherwise.
 */
export async function localContainer(ref, signal, env = process.env) {
  const p = localDockerPolicy(env);
  if (!p.enabled) throw new Error(LOCAL_DOCKER_OFF);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(String(ref))) throw new Error(`"${ref}" is not a container name`);
  const r = await docker(['inspect', '--type', 'container', '--format', '{{json .}}', '--', String(ref)], { signal });
  if (r.code !== 0) throw new Error(/No such (container|object)/i.test(r.stderr) ? `there is no container "${ref}"` : dockerError(r));
  let info;
  try { info = JSON.parse(r.stdout.trim().split('\n')[0]); } catch { throw new Error(`docker inspect ${ref} did not answer as expected`); }
  const name = String(info.Name ?? '').replace(/^\//, '');
  if (!p.allows({ name, labels: info.Config?.Labels ?? {} })) throw new Error(`The container "${name}" is not one the operator lets the ops tools use (HARNESS_OPS_LOCAL_DOCKER_ALLOW: ${p.entries.join(', ') || 'empty'}; the harness's own containers never are).`);
  return { id: String(info.Id), name };
}

export function dockerError(r) {
  if (r.error) return `docker is not available on the server: ${r.error}`;
  const e = (r.stderr || r.stdout).trim();
  if (/Cannot connect to the Docker daemon|error during connect|pipe.*docker_engine/i.test(e)) return 'The Docker engine is not running (or the server cannot reach it).';
  return e.split('\n').slice(-3).join(' ') || `docker exited ${r.code}`;
}

const jsonLines = (s) => s.split('\n').filter((l) => l.trim().startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return undefined; } }).filter(Boolean);

/** Containers matching a name substring, a label (k=v) or a compose project; all when no filter. */
export async function listContainers({ name, label, project, all = true } = {}, signal) {
  const args = ['ps', '--no-trunc', '--format', '{{json .}}'];
  if (all) args.push('-a');
  if (name) args.push('--filter', `name=${name}`);
  if (label) args.push('--filter', `label=${label}`);
  if (project) args.push('--filter', `label=com.docker.compose.project=${project}`);
  const r = await docker(args, { signal });
  if (r.code !== 0) throw new Error(dockerError(r));
  return jsonLines(r.stdout);
}

export async function inspect(ids, signal) {
  if (!ids.length) return [];
  const r = await docker(['inspect', ...ids], { signal, timeoutMs: 60_000 });
  if (r.code !== 0 && !r.stdout.trim().startsWith('[')) throw new Error(dockerError(r));
  try { return JSON.parse(r.stdout); } catch { return []; }
}

export async function stats(ids, signal) {
  if (!ids.length) return [];
  const r = await docker(['stats', '--no-stream', '--format', '{{json .}}', ...ids], { signal, timeoutMs: 60_000 });
  return r.code === 0 ? jsonLines(r.stdout) : [];
}

/** One container's facts that matter for operations and security. */
export function describe(i, s) {
  const st = i.State ?? {};
  const cfg = i.Config ?? {};
  const host = i.HostConfig ?? {};
  const user = cfg.User || 'root (no USER set)';
  const envNames = (cfg.Env ?? []).map((e) => e.split('=')[0]).filter((k) => secretName(k));
  return {
    name: String(i.Name ?? '').replace(/^\//, ''),
    image: cfg.Image,
    state: st.Status,
    health: st.Health?.Status ?? (cfg.Healthcheck?.Test && cfg.Healthcheck.Test[0] !== 'NONE' ? 'starting' : 'no healthcheck'),
    healthLog: (st.Health?.Log ?? []).slice(-1).map((l) => `exit ${l.ExitCode}: ${String(l.Output ?? '').trim().slice(0, 160)}`)[0],
    restarts: i.RestartCount ?? 0,
    restartPolicy: host.RestartPolicy?.Name || 'no',
    startedAt: st.StartedAt,
    exitCode: st.ExitCode,
    oomKilled: !!st.OOMKilled,
    user,
    root: !cfg.User || /^(0|root)(:|$)/.test(cfg.User),
    privileged: !!host.Privileged,
    capAdd: host.CapAdd ?? [],
    ports: Object.entries(i.NetworkSettings?.Ports ?? {}).flatMap(([p, b]) => (b ?? []).map((x) => `${x.HostIp || '0.0.0.0'}:${x.HostPort}->${p}`)),
    memLimit: host.Memory || 0,
    secretEnvNames: envNames,
    project: cfg.Labels?.['com.docker.compose.project'],
    cpu: s?.CPUPerc, mem: s?.MemUsage, memPerc: s?.MemPerc,
  };
}

export function formatContainer(c) {
  const flags = [];
  if (c.root) flags.push('runs as root');
  if (c.privileged) flags.push('PRIVILEGED');
  if (c.capAdd.length) flags.push(`cap_add ${c.capAdd.join(',')}`);
  if (c.oomKilled) flags.push('OOM-killed');
  if (!c.memLimit && c.state === 'running') flags.push('no memory limit');
  if (c.secretEnvNames.length) flags.push(`secret-looking env vars: ${c.secretEnvNames.join(', ')} (values not shown)`);
  return `${c.name} [${c.state}${c.state === 'exited' ? ` ${c.exitCode}` : ''}] health=${c.health}${c.healthLog && c.health !== 'healthy' ? ` (${c.healthLog})` : ''} restarts=${c.restarts} (policy ${c.restartPolicy}) started=${c.startedAt?.slice(0, 19) ?? '-'} image=${c.image}${c.cpu ? ` cpu=${c.cpu} mem=${c.mem} (${c.memPerc})` : ''} user=${c.user}${c.ports.length ? ` ports=${c.ports.join(',')}` : ''}${flags.length ? `\n    ! ${flags.join('; ')}` : ''}`;
}

/** `docker logs` of a container since a time, as lines (stdout and stderr together, oldest first). */
export async function containerLogs(container, { since = '15m', tail = 2000 } = {}, signal) {
  const r = await docker(['logs', '--timestamps', '--since', since, '--tail', String(tail), container], { signal, timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(/No such container/i.test(r.stderr) ? `there is no container "${container}"` : dockerError(r));
  const lines = `${r.stdout}\n${r.stderr}`.split('\n').filter(Boolean);
  // Two streams interleave by timestamp.
  return lines.sort((a, b) => a.slice(0, 30).localeCompare(b.slice(0, 30)));
}
