import path from 'node:path';
import { LocalHost, resolveShell } from '../runtime/host.ts';
import { toolByName } from '../tools/index.ts';
import type { FileStamp, ToolContext } from '../tools/types.ts';

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

const host = new LocalHost(dir);
const readFiles = new Map<string, Map<string, FileStamp>>();

async function post(p: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(`${server}${p}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
}

type Job =
  | { id: string; kind: 'tool'; sessionId: string; name: string; input: Record<string, unknown> }
  | { id: string; kind: 'exec'; sessionId: string; command: string; timeoutMs: number; stdin?: string };

async function handle(job: Job): Promise<void> {
  let ok = true;
  let value: unknown;
  try {
    if (job.kind === 'exec') {
      if (!allowHooks) throw new Error('hooks are disabled on this companion (start it with --allow-hooks)');
      value = await host.exec(job.command, { timeoutMs: job.timeoutMs, stdin: job.stdin });
    } else {
      const tool = toolByName(job.name);
      if (!tool || !tool.remoteable) throw new Error(`tool ${job.name} does not run on the companion`);
      const files = readFiles.get(job.sessionId) ?? new Map<string, FileStamp>();
      readFiles.set(job.sessionId, files);
      const ctx: ToolContext = { host, signal: new AbortController().signal, readFiles: files, todos: [], setTodos() {}, emit() {} };
      console.log(`[${new Date().toLocaleTimeString()}] ${tool.summarize(job.input)}`);
      try {
        value = await tool.run(job.input, ctx);
      } catch (err) {
        value = { content: (err as Error).message, is_error: true };
      }
    }
  } catch (err) {
    ok = false;
    value = { error: (err as Error).message };
  }
  for (let i = 0; i < 3; i++) {
    try { await post('/api/companion/result', { jobId: job.id, ok, value }); return; } catch { await new Promise((r) => setTimeout(r, 1000 * (i + 1))); }
  }
}

async function loop(): Promise<void> {
  console.log(`harness companion: serving ${dir} to ${server}`);
  let backoff = 1000;
  while (true) {
    try {
      const res = await post('/api/companion/poll', { info: { platform: process.platform, shell: resolveShell().kind, root: dir, version: '0.1.0' } }, AbortSignal.timeout(60_000));
      if (res.status === 401) { console.error('The server rejected this token. Create a new companion in the web app.'); process.exit(1); }
      if (res.status === 200) handle(await res.json() as Job).catch((e) => console.error(e));
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
