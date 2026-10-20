import path from 'node:path';
import { resolveShell } from '../runtime/host.ts';
import { type CompanionJob, createCompanionHandler } from './handler.ts';

// harness-companion: lets the browser harness work on a folder on THIS computer.
//   node harness-companion.mjs --server https://your-server --token hwc_... [--dir .] [--allow-hooks]
// It only makes outbound HTTPS requests. Tool calls are confined to --dir.

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const server = (arg('server') ?? process.env.HARNESS_SERVER ?? '').replace(/\/$/, '');
const token = arg('token') ?? process.env.HARNESS_COMPANION_TOKEN ?? '';
const dir = path.resolve(arg('dir') ?? process.cwd());
const allowHooks = process.argv.includes('--allow-hooks');

if (!server || !token) {
  console.error('usage: node harness-companion.mjs --server <url> --token <hwc_...> [--dir <folder>] [--allow-hooks]');
  process.exit(2);
}

const handle = createCompanionHandler(dir, { allowHooks, log: (m) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`) });

async function post(p: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(`${server}${p}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
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
      const res = await post('/api/companion/poll', { info: { platform: process.platform, shell: resolveShell().kind, root: dir, version: '0.3.0' } }, AbortSignal.timeout(60_000));
      if (res.status === 401) { console.error('The server rejected this token. Create a new companion in the web app.'); process.exit(1); }
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
