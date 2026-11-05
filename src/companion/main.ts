import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveShell } from '../runtime/host.ts';
import { sandboxedFolderHost } from '../runtime/local-sandbox.ts';
import { warmJobs } from '../runtime/winjob.ts';
import type { LocalSandbox } from '../runtime/os-sandbox.ts';
import { type CompanionJob, cleanPolicy, createCompanionHandler, DEFAULT_POLICY, type MachinePolicy } from './handler.ts';
import { machineKey, policyPayload, resultPayload, sign } from './sign.ts';

// harness-companion: lets the browser harness work on a folder on THIS computer.
//   node harness-companion.mjs --server https://your-server --token hwc_... [--dir .] [--allow-hooks] [--allow-desktop]
// It only makes outbound HTTPS requests. Tool calls are confined to --dir.

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

// What this machine offers to swarm work (phase 7): a file next to the token, which sandboxed commands cannot see.
// Only this program changes it (`harness-companion policy ...`); the server can never widen it.
const policyFile = path.resolve(arg('policy') ?? path.join(os.homedir(), '.harness-companion', 'policy.json'));
const readPolicy = (): MachinePolicy => { try { return cleanPolicy(JSON.parse(fs.readFileSync(policyFile, 'utf8'))); } catch { return DEFAULT_POLICY; } };
if (process.argv[2] === 'policy') {
  const p = readPolicy();
  const on = (v: string | undefined) => (v === undefined ? undefined : /^(on|yes|true|allow)$/i.test(v));
  const swarm = on(arg('swarm')); const sbx = on(arg('sandbox-required'));
  const next = cleanPolicy({ ...p, ...(swarm !== undefined ? { swarm } : {}), ...(arg('kinds') ? { kinds: arg('kinds')!.split(',').map((k) => k.trim()) } : {}), ...(arg('max-jobs') ? { maxJobs: Number(arg('max-jobs')) } : {}), ...(sbx !== undefined ? { sandboxRequired: sbx } : {}) });
  if (process.argv.length > 3) {
    fs.mkdirSync(path.dirname(policyFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(policyFile, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  }
  console.log(`${policyFile}:\n  swarm work: ${next.swarm ? 'allowed' : 'not allowed'}\n  kinds of tools for swarm agents: ${next.kinds.join(', ')}\n  at most ${next.maxJobs} swarm job(s) at once\n  swarm work only in a sandbox: ${next.sandboxRequired ? 'yes' : 'no'}\nChange it with: harness-companion policy [--swarm on|off] [--kinds read,edit,exec,network] [--max-jobs N] [--sandbox-required on|off]`);
  process.exit(0);
}
// The lease: with no word from the server for this long, everything running here stops and nothing new starts.
// Longer than the server holds a poll (25 s), or a healthy companion would stop itself.
const leaseMs = Math.max(40, Number(arg('lease-seconds') ?? process.env.HARNESS_COMPANION_LEASE_S ?? 120)) * 1000;
const auditFile = path.join(path.dirname(policyFile), 'audit.log');

const server = (arg('server') ?? process.env.HARNESS_SERVER ?? '').replace(/\/$/, '');
// Tokens are short-lived: the server sends a fresh one before this one expires, and it
// is kept in a file (owner-only) that later starts use. --token-file names that file.
const tokenFile = path.resolve(arg('token-file') ?? path.join(os.homedir(), '.harness-companion', `${crypto.createHash('sha256').update(server).digest('hex').slice(0, 16)}.token`));
const stored = (): string => { try { return fs.readFileSync(tokenFile, 'utf8').trim(); } catch { return ''; } };
let token = arg('token') ?? process.env.HARNESS_COMPANION_TOKEN ?? stored();
// This machine's own key, next to its token (never sent: only its public half, and signatures).
const key = machineKey(tokenFile.replace(/\.token$/, '') + '.key', fs, path);
const dir = path.resolve(arg('dir') ?? process.cwd());
const allowHooks = process.argv.includes('--allow-hooks');
// The project's own MCP servers (.mcp.json) start on this computer only with this, or inside a sandbox.
const trustProject = process.argv.includes('--trust-project');
// The computer tool on this computer's real screen: off unless asked for.
const allowDesktop = process.argv.includes('--allow-desktop');
// Commands from the agent run contained: the OS sandbox (Linux, macOS), else Docker, else plainly (and are asked about).
const sandboxWant = (arg('sandbox') ?? process.env.HARNESS_COMPANION_SANDBOX ?? 'auto') as LocalSandbox | 'auto';
const network = (arg('network') ?? 'full') as 'none' | 'full';

if (!server || !token || !['auto', 'bwrap', 'seatbelt', 'docker', 'off'].includes(sandboxWant) || !['none', 'full'].includes(network)) {
  console.error('usage: node harness-companion.mjs --server <url> --token <hwc_...> [--token-file <path>] [--dir <folder>] [--sandbox auto|bwrap|seatbelt|docker|off] [--network full|none] [--allow-hooks] [--trust-project] [--allow-desktop]');
  process.exit(2);
}

const sandbox = await sandboxedFolderHost(dir, sandboxWant, network).catch((e: Error) => { console.error(`sandbox: ${e.message}`); process.exit(2); });
console.log(`commands run: ${sandbox.why}${sandbox.kind !== 'off' ? `, network ${network}` : ''}`);
if (allowDesktop) console.log('DESKTOP CONTROL IS ON (--allow-desktop): the agent can see this screen and use the mouse and keyboard, outside any sandbox. Each action is approved in the web app unless the session bypasses permissions. Stop the companion (Ctrl+C) to take it back.');
else console.log('desktop control: off (start with --allow-desktop to let the agent see the screen and use the mouse and keyboard)');
// Ready before the first command: started by that command on a busy machine, it can be too late to hold it.
warmJobs();
const handle = createCompanionHandler(dir, {
  allowHooks, trustProject, allowDesktop, host: sandbox.host, log: (m) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`),
  policy: readPolicy,
  // Results of calls that change something, until the server has them (a call repeated meanwhile is done once).
  journal: path.join(path.dirname(policyFile), 'journal.json'),
  // Who asked what, where, and what came of it: kept on this machine, outside the folder.
  audit: (e) => { try { fs.mkdirSync(path.dirname(auditFile), { recursive: true, mode: 0o700 }); fs.appendFileSync(auditFile, `${JSON.stringify(e)}\n`, { mode: 0o600 }); } catch { /* the log is best effort */ } },
});
{ const p = readPolicy(); console.log(`swarm work: ${p.swarm ? `allowed (${p.kinds.join(', ')}; at most ${p.maxJobs} at once${p.sandboxRequired ? '; only in a sandbox' : ''})` : 'not allowed'} (${policyFile}); lease ${leaseMs / 1000}s`); }
// Monotonic time, so a clock change on this machine cannot stretch the lease.
let heard = performance.now();
setInterval(() => {
  if (performance.now() - heard > leaseMs && !fencedNow) {
    fencedNow = true;
    handle.stopAll(`no word from the server for ${Math.round(leaseMs / 1000)}s`, true);
    console.error(`no word from the server for ${Math.round(leaseMs / 1000)}s: stopped everything running here; work resumes when the server is heard again`);
  }
}, 2000).unref();
let fencedNow = false;
// Ctrl+C stops what runs here first.
process.on('SIGINT', () => { handle.stopAll('the companion was stopped on this machine', true); setTimeout(() => process.exit(130), 300); });

async function post(p: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(`${server}${p}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
}

/** A fresh token from the server: used from now on, and kept for the next start. */
function adopt(fresh: string | null): void {
  if (!fresh || !/^hwc_[A-Za-z0-9_-]{20,64}$/.test(fresh) || fresh === token) return;
  token = fresh;
  try {
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${tokenFile}.tmp`, `${fresh}\n`, { mode: 0o600 });
    fs.renameSync(`${tokenFile}.tmp`, tokenFile);
    console.log(`received a fresh token from the server (kept in ${tokenFile})`);
  } catch (e) { console.error(`could not keep the fresh token in ${tokenFile}: ${(e as Error).message}; pass --token-file to put it elsewhere`); }
}

async function run(job: CompanionJob): Promise<void> {
  const { ok, value } = await handle(job);
  for (let i = 0; i < 3; i++) {
    try {
      const res = await post('/api/companion/result', { jobId: job.id, ok, value, signature: sign(key.privateKey, resultPayload(job.id, ok, value)) });
      // The server has it: no replay of it from the journal from now on.
      if (res.status === 200) handle.delivered(job.id);
      // Refused (too large, say): tell the server, so the job fails instead of waiting out its timeout.
      if (res.status >= 400 && res.status !== 404) { const v = { error: `the server refused this result (HTTP ${res.status})` }; await post('/api/companion/result', { jobId: job.id, ok: false, value: v, signature: sign(key.privateKey, resultPayload(job.id, false, v)) }); }
      return;
    } catch { await new Promise((r) => setTimeout(r, 1000 * (i + 1))); }
  }
}

async function loop(): Promise<void> {
  console.log(`harness companion: serving ${dir} to ${server}`);
  let backoff = 1000;
  while (true) {
    try {
      const h = sandbox.host;
      const info = { platform: h.platform, shell: h.kind === 'docker' ? 'bash' : resolveShell().kind, root: h.displayRoot, version: '0.6.0', sandbox: sandbox.kind, network: h.sandboxed ? h.networkPolicy : 'full', trustProject, desktop: allowDesktop, policy: readPolicy() };
      const res = await post('/api/companion/poll', { info, running: handle.running(), publicKey: key.publicKey, policySignature: sign(key.privateKey, policyPayload(info.policy)) }, AbortSignal.timeout(60_000));
      if (res.status !== 401) { heard = performance.now(); if (fencedNow) { fencedNow = false; handle.unfence(); console.log('the server is heard again: taking work'); } }
      if (res.status === 401) {
        // Started with an old token, but a fresher one was kept from an earlier run.
        const kept = stored();
        if (kept && kept !== token) { token = kept; continue; }
        console.error('The server rejected this token (unknown, revoked, or expired). Create a new token for this companion in the web app.');
        process.exit(1);
      }
      adopt(res.headers.get('x-harness-companion-token'));
      if (res.status === 200) run(await res.json() as CompanionJob).catch((e) => console.error(e));
      else if (res.status !== 204) throw new Error(`poll failed: ${res.status}`);
      backoff = 1000;
    } catch (err) {
      console.error(`connection problem: ${(err as Error).message}; retrying in ${backoff / 1000}s`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(30_000, backoff * 2);
    }
  }
}

loop();
