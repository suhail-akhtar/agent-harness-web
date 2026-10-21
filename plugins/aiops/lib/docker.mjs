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
