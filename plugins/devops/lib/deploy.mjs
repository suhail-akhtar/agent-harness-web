// Docker Compose deploys: ps, up (with health verification after, and an
// automatic rollback to the images that ran before when health fails), down,
// and rollback. The target is the Docker daemon where commands run, or one
// named by a Key Vault secret holding a DOCKER_HOST (tcp://... or
// ssh://user@host, with an SSH key from the vault). A session sandbox has no
// daemon of its own.

import { fromVault, guard, need, parseJson, q, relIn, seconds, sh, tail, UserError } from './common.mjs';
import { writeWs } from './iac.mjs';

const PROJECT = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SERVICE = /^[a-zA-Z0-9][\w.-]{0,62}$/;
const IMAGE = /^[\w][\w.\-/:@]{0,250}$/;
export const DEPLOY_DIR = '.harness/devops/deploy';

/** `docker compose ps --format json`: one JSON array, or one object per line (older compose). */
export function parsePs(text) {
  const t = String(text ?? '').trim();
  if (!t) return [];
  const j = parseJson(t);
  if (Array.isArray(j)) return j;
  return t.split('\n').map((l) => parseJson(l)).filter((x) => x && typeof x === 'object');
}

export const psLine = (c) => `${c.Service} ${c.State}${c.Health ? ` (${c.Health})` : ''} image ${c.Image} ${c.Status ?? ''}`.trim();

/** The override file that pins images: { service: image }. */
export function overrideYaml(images) {
  return `# Written by the devops deploy tool: the images this deploy runs.\nservices:\n${Object.entries(images).map(([s, i]) => `  ${s}:\n    image: ${JSON.stringify(i)}`).join('\n')}\n`;
}

/** The bash that, with HW_SSH_KEY set (a key file), makes docker's ssh use it, trusting a new host key once. */
const SSH_WRAP = [
  'if [ -n "${HW_SSH_KEY:-}" ]; then',
  '  __real_ssh=$(command -v ssh) || { echo "no ssh client where commands run" >&2; exit 98; }',
  '  mkdir -p "$__hw_t/bin"',
  '  printf \'#!/bin/sh\\nexec "%s" -i "%s" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="%s/known_hosts" "$@"\\n\' "$__real_ssh" "$HW_SSH_KEY" "$__hw_t" > "$__hw_t/bin/ssh"',
  '  chmod 700 "$__hw_t/bin/ssh"; export PATH="$__hw_t/bin:$PATH"',
  'fi',
].join('\n');

async function target(ctx, input, purpose) {
  const env = input.dockerHost ? await fromVault(ctx, { DOCKER_HOST: String(input.dockerHost) }, purpose) : {};
  const files = input.sshKey ? await fromVault(ctx, { HW_SSH_KEY: String(input.sshKey) }, purpose) : {};
  return { env, files, where: input.dockerHost ? `the Docker host in ${input.dockerHost}` : 'the local Docker daemon' };
}

async function compose(ctx, t, base, args, timeoutMs = 300_000) {
  const pre = Object.keys(t.files).length ? `${SSH_WRAP}\n` : '';
  return sh(ctx.host, `${pre}docker compose ${base} ${args}`, { signal: ctx.signal, timeoutMs, env: t.env, files: t.files });
}

async function ps(ctx, t, base) {
  const r = await compose(ctx, t, base, 'ps -a --format json', 60_000);
  if (r.code !== 0) throw new UserError(`docker compose ps failed: ${tail(r.output, 10)}${/Cannot connect to the Docker daemon|docker daemon|error during connect/i.test(r.output) ? `\nNo Docker daemon is reachable where commands run (a session sandbox has none): pass dockerHost, a Key Vault secret holding the target's DOCKER_HOST.` : ''}`);
  return parsePs(r.stdout);
}

/**
 * Health: compose's own (every service running, and healthy where it has a
 * healthcheck), then the URL or command given, retried until the timeout.
 */
async function healthy(ctx, t, base, input, deadline) {
  for (;;) {
    const list = await ps(ctx, t, base).catch((e) => ({ error: e.message }));
    const problems = Array.isArray(list)
      ? list.filter((c) => c.State !== 'running' || (c.Health && c.Health !== 'healthy')).map((c) => psLine(c))
      : [list.error];
    let probe = '';
    if (!problems.length && (input.healthUrl || input.healthCmd)) {
      const cmd = input.healthUrl ? `curl -fsS -m 10 -o /dev/null -w '%{http_code}' ${q(input.healthUrl)}` : String(input.healthCmd);
      const r = await sh(ctx.host, cmd, { signal: ctx.signal, timeoutMs: 30_000, env: t.env });
      if (r.code !== 0) probe = `${input.healthUrl ? `GET ${input.healthUrl}` : 'health command'} failed: ${tail(r.output, 3)}`;
    }
    if (!problems.length && !probe) return { ok: true, text: Array.isArray(list) ? list.map(psLine).join('\n') : '' };
    if (Date.now() > deadline) return { ok: false, text: [...problems, probe].filter(Boolean).join('\n') };
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function readHistory(ctx, project) {
  const r = await sh(ctx.host, `cat ${q(`${DEPLOY_DIR}/${project}.json`)} 2>/dev/null`, { signal: ctx.signal, timeoutMs: 15_000 });
  const j = parseJson(r.stdout);
  return Array.isArray(j) ? j : [];
}

async function upWith(ctx, t, input, project, file, images, deadline) {
  const override = `${DEPLOY_DIR}/${project}.override.yml`;
  const pin = Object.keys(images).length ? ` -f ${q(override)}` : '';
  if (pin) await writeWs(ctx.host, override, overrideYaml(images), ctx.signal);
  const base = `-p ${q(project)} -f ${q(file)}${pin}`;
  const wait = Math.max(10, Math.round((deadline - Date.now()) / 1000));
  const up = await compose(ctx, t, base, `up -d --wait --wait-timeout ${wait} 2>&1`, (wait + 120) * 1000);
  const h = await healthy(ctx, t, base, input, up.code === 0 ? deadline : Math.min(deadline, Date.now() + 15_000));
  return { up, health: h, base, ok: up.code === 0 && h.ok };
}

export async function runDeploy(input, ctx) {
  return guard(async () => {
    const { host, signal } = ctx;
    const action = String(input.action ?? '');
    const project = String(input.project ?? '');
    if (!PROJECT.test(project)) return { content: 'project must be a compose project name: lower-case letters, digits, - and _.', is_error: true };
    const n = await need(host, 'docker', 'the docker CLI with compose', signal);
    if (n.error) return n.error;
    const file = await relIn(host, input.file ?? 'compose.yaml');
    const t = await target(ctx, input, `deploy ${action} ${project}`);
    const base = `-p ${q(project)} -f ${q(file)}`;
    if (action === 'ps') {
      const list = await ps(ctx, t, base);
      return list.length ? `${project} on ${t.where}:\n${list.map(psLine).join('\n')}` : `${project}: nothing running on ${t.where}.`;
    }
    if (action === 'down') {
      const r = await compose(ctx, t, base, `down${input.removeVolumes === true ? ' -v' : ''} 2>&1`);
      return r.code === 0 ? `${project} is down on ${t.where}.${input.removeVolumes === true ? ' Its volumes were removed.' : ' Volumes kept.'}` : { content: `docker compose down failed:\n${tail(r.output, 20)}`, is_error: true };
    }
    if (action !== 'up' && action !== 'rollback') return { content: `Unknown action ${action}: use ps, up, down or rollback.`, is_error: true };

    const deadline = Date.now() + seconds(input.healthTimeoutSec, 120, 1800) * 1000;
    const before = await ps(ctx, t, base);
    const previous = Object.fromEntries(before.filter((c) => c.Service && c.Image).map((c) => [c.Service, c.Image]));
    const history = await readHistory(ctx, project);
    let images;
    if (action === 'rollback') {
      const good = [...history].reverse().find((h) => h.ok && JSON.stringify(h.images) !== JSON.stringify(previous));
      if (!good) return { content: `No earlier healthy deploy of ${project} to roll back to (history in ${DEPLOY_DIR}/${project}.json).`, is_error: true };
      images = good.images;
    } else {
      images = {};
      if (input.service || input.image) {
        if (!SERVICE.test(String(input.service ?? '')) || !IMAGE.test(String(input.image ?? ''))) return { content: 'up with an image change needs service (the compose service) and image (name:tag).', is_error: true };
        images = { ...previous, [String(input.service)]: String(input.image) };
      }
    }
    const res = await upWith(ctx, t, input, project, file, images, deadline);
    const record = async (entry) => {
      history.push({ at: new Date().toISOString(), ...entry });
      await writeWs(host, `${DEPLOY_DIR}/${project}.json`, JSON.stringify(history.slice(-20), null, 1), signal);
    };
    if (res.ok) {
      const now = Object.fromEntries((await ps(ctx, t, res.base)).map((c) => [c.Service, c.Image]));
      await record({ action, images: now, ok: true });
      return `${action === 'rollback' ? 'Rolled back' : 'Deployed'} ${project} on ${t.where}: healthy.\n${res.health.text}`;
    }
    const failure = `${res.up.code !== 0 ? `docker compose up failed or a service did not become healthy (exit ${res.up.code}):\n${tail(res.up.output, 20)}\n` : ''}Health: ${res.health.text}`;
    await record({ action, images, ok: false });
    if (action === 'rollback' || !Object.keys(previous).length || input.autoRollback === false) {
      return { content: `${project} is UNHEALTHY after the ${action} on ${t.where}.\n${failure}${!Object.keys(previous).length && action === 'up' ? '\nNothing ran before this deploy, so there is nothing to roll back to.' : ''}`, is_error: true };
    }
    // Back to what ran before.
    const back = await upWith(ctx, t, input, project, file, previous, Date.now() + seconds(input.healthTimeoutSec, 120, 1800) * 1000);
    await record({ action: 'auto-rollback', images: previous, ok: back.ok });
    return {
      content: `${project} was UNHEALTHY after deploying ${JSON.stringify(images)}; ROLLED BACK automatically to ${JSON.stringify(previous)}: ${back.ok ? 'healthy again' : 'STILL UNHEALTHY - needs attention'}.\n\nWhy the deploy failed:\n${failure}\n\nAfter the rollback:\n${back.health.text}`,
      is_error: true,
    };
  });
}

export const DEPLOY_CHANGES = new Set(['up', 'down', 'rollback']);

export const deployParameters = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['ps', 'up', 'down', 'rollback'], description: 'What to do: ps, up (deploy and verify health), down, or rollback to the last healthy deploy' },
    project: { type: 'string', description: 'Compose project name' },
    file: { type: 'string', description: 'Compose file in the workspace (default compose.yaml)' },
    service: { type: 'string', description: 'up: the service whose image changes' },
    image: { type: 'string', description: 'up: the new image (name:tag) for service' },
    healthUrl: { type: 'string', description: 'up/rollback: a URL that must answer 2xx from where commands run' },
    healthCmd: { type: 'string', description: 'up/rollback: a command that must exit 0 (instead of healthUrl)' },
    healthTimeoutSec: { type: 'number', description: 'How long to wait for health (default 120)' },
    autoRollback: { type: 'boolean', description: 'up: roll back to the previous images when health fails (default true)' },
    removeVolumes: { type: 'boolean', description: 'down: also remove the volumes (data!)' },
    dockerHost: { type: 'string', description: 'Key Vault secret holding the target DOCKER_HOST (tcp://... or ssh://user@host). Default: the daemon where commands run.' },
    sshKey: { type: 'string', description: 'Key Vault secret holding the SSH private key for an ssh:// DOCKER_HOST' },
  },
  required: ['action', 'project'],
  additionalProperties: false,
};
