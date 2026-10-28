// Runs a program with arguments (never a shell string) on the server, with a
// timeout, an abort signal, capped output, and an environment without the
// server's credentials.

import { spawn } from 'node:child_process';

const CAP = 2 * 1024 * 1024;
const SECRETISH = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE|SESSION/i;

/** The server's environment minus anything that looks like a credential, plus `extra`. */
export function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!SECRETISH.test(k) && !/^GIT_CONFIG_/.test(k)) env[k] = v;
  return { ...env, ...extra };
}

export function runProgram(cmd, args, { timeoutMs = 60_000, signal, env, stdin, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { env: env ?? cleanEnv(), cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: '', error: e.code === 'ENOENT' ? `${cmd} is not installed (not on PATH)` : e.message, timedOut: false });
      return;
    }
    const out = []; const err = []; let so = 0; let se = 0;
    let timedOut = false; let settled = false;
    const kill = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const onAbort = () => kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (b) => { if (so < CAP) { out.push(b); so += b.length; } });
    child.stderr.on('data', (b) => { if (se < CAP) { err.push(b); se += b.length; } });
    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut, ...(error ? { error } : {}) });
    };
    child.on('error', (e) => finish(null, e.code === 'ENOENT' ? `${cmd} is not installed (not on PATH)` : e.message));
    child.on('close', (code) => finish(code));
    if (stdin !== undefined) child.stdin.end(stdin); else child.stdin.end();
  });
}
