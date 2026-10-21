import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveShell } from '../runtime/host.ts';
import { sandboxedFolderHost } from '../runtime/local-sandbox.ts';
import type { LocalSandbox } from '../runtime/os-sandbox.ts';
import { type CompanionJob, createCompanionHandler } from './handler.ts';

// harness-companion: lets the browser harness work on a folder on THIS computer.
//   node harness-companion.mjs --server https://your-server --token hwc_... [--dir .] [--allow-hooks] [--allow-desktop]
// It only makes outbound HTTPS requests. Tool calls are confined to --dir.

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const server = (arg('server') ?? process.env.HARNESS_SERVER ?? '').replace(/\/$/, '');
// Tokens are short-lived: the server sends a fresh one before this one expires, and it
// is kept in a file (owner-only) that later starts use. --token-file names that file.
const tokenFile = path.resolve(arg('token-file') ?? path.join(os.homedir(), '.harness-companion', `${crypto.createHash('sha256').update(server).digest('hex').slice(0, 16)}.token`));
const stored = (): string => { try { return fs.readFileSync(tokenFile, 'utf8').trim(); } catch { return ''; } };
let token = arg('token') ?? process.env.HARNESS_COMPANION_TOKEN ?? stored();
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
const handle = createCompanionHandler(dir, { allowHooks, trustProject, allowDesktop, host: sandbox.host, log: (m) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`) });

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
      const res = await post('/api/companion/result', { jobId: job.id, ok, value });
      // Refused (too large, say): tell the server, so the job fails instead of waiting out its timeout.
      if (res.status >= 400 && res.status !== 404) await post('/api/companion/result', { jobId: job.id, ok: false, value: { error: `the server refused this result (HTTP ${res.status})` } });
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
      const info = { platform: h.platform, shell: h.kind === 'docker' ? 'bash' : resolveShell().kind, root: h.displayRoot, version: '0.5.0', sandbox: sandbox.kind, network: h.sandboxed ? h.networkPolicy : 'full', trustProject, desktop: allowDesktop };
      const res = await post('/api/companion/poll', { info }, AbortSignal.timeout(60_000));
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
