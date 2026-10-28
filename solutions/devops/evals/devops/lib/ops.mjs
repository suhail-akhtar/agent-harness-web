// Hidden checks for the devops evals run the real programs in the ops sandbox
// image (npm run sandbox:image:ops), with the finished workspace mounted
// read-only at /ws and copied to /tmp/ws before anything runs - a check never
// changes the workspace it judges. No network.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

export const IMAGE = process.env.HARNESS_DEVOPS_IMAGE?.trim() || 'harness-sandbox-ops:latest';

/** Runs a bash script in the ops image against a copy of the workspace; { code, out }. */
export function inOps(ws, script, { timeoutMs = 300_000 } = {}) {
  const name = `${process.env.HARNESS_EVAL_CONTAINER_PREFIX || 'harness-eval-'}${crypto.randomBytes(4).toString('hex')}`;
  const r = spawnSync('docker', [
    'run', '--rm', '-i', '--name', name, '--network', 'none', '-e', 'HOME=/tmp/home', '-v', `${ws}:/ws:ro`, IMAGE,
    'bash', '-c', 'mkdir -p /tmp/home && cp -a /ws /tmp/ws && cd /tmp/ws && bash -s',
  ], { input: script, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  if (r.error) return { code: 1, out: `docker could not run the check: ${r.error.message}` };
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** Prints the problems and exits 1, or the ok line and exits 0. */
export function finish(problems, ok) {
  console.log(problems.length ? problems.join('\n') : ok);
  process.exit(problems.length ? 1 : 0);
}
