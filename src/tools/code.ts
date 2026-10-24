import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Tool, ToolKind } from './types.ts';
import { clipOrSpill, num, str } from './types.ts';

// run_script: the model writes a short JavaScript program that calls tools and
// keeps only what matters - "code mode". Fetch ten pages and pull one number
// from each, grep a hundred files and count, call an MCP service in a loop: the
// intermediate results never enter the context, only what the script prints.
// Every tool call still goes through the agent's permissions and hooks.

const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'code-runner.mjs');
let runnerText: string | undefined;
const runnerSource = () => (runnerText ??= readFileSync(RUNNER, 'utf8'));
const MAX_CALLS = 200;
/** Tools a script may not call: interactive ones, itself, and delegation. */
const NOT_FROM_SCRIPTS = new Set(['run_script', 'ask_user', 'exit_plan_mode', 'todo_write', 'agent', 'publish_branch', 'schedule', 'workflow']);

let netIsolation: boolean | undefined;
/** Linux namespaces: the script process has no network and sees no other process (it cannot signal the server). */
const UNSHARE = ['-rnpf', '--kill-child'];
export function scriptNetworkIsolated(): boolean {
  if (netIsolation === undefined) {
    netIsolation = process.platform === 'linux' && process.env.HARNESS_SCRIPT_ISOLATION !== 'off'
      && spawnSync('unshare', [...UNSHARE, 'true'], { timeout: 5000 }).status === 0;
  }
  return netIsolation;
}

export const runScriptTool: Tool = {
  kind: 'read', parallelSafe: false, remoteable: false,
  spec: {
    name: 'run_script',
    description: `Run a short JavaScript (async function body) that calls tools and returns only what you need, instead of making many tool calls whose full output fills the context. Use it for loops and filtering: reading or grepping many files and summarising, fetching several pages and extracting facts, calling a service repeatedly.
In the script: \`await tools.<name>({...input})\` returns the tool's text output (it throws on an error); \`tools.call(name, input)\` for any name; \`console.log(...)\` and the return value are what you get back. No require, files, network or processes except through tools. Example:
const files = (await tools.glob({ pattern: "src/**/*.ts" })).split("\\n");
let n = 0; for (const f of files) if ((await tools.read({ path: f })).includes("TODO")) n++;
return \`\${n} of \${files.length} files have TODOs\`;`,
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The body of an async function' },
        timeout_seconds: { type: 'number', description: 'Default 120, at most 600' },
      },
      required: ['code'],
    },
  },
  // In a Docker session the script process runs inside the sandbox, under its network
  // policy, like any command there. Elsewhere it runs on the server: free where Linux
  // namespaces cut it off from the network, otherwise asked about, like web_fetch.
  kindsFor: (_i, where) => [(where?.hostKind === 'docker' ? 'exec' : scriptNetworkIsolated() ? 'read' : 'network') as ToolKind],
  summarize: (i) => `script: ${str(i.code).replace(/\s+/g, ' ').slice(0, 100)}`,
  async run(input, ctx) {
    if (!ctx.callTool) return { content: 'Scripts are not available here.', is_error: true };
    const timeoutMs = Math.min(600, Math.max(1, num(input.timeout_seconds) ?? 120)) * 1000;
    const names = (ctx.toolNames?.() ?? []).filter((n) => !NOT_FROM_SCRIPTS.has(n) && /^[A-Za-z_$][\w$]*$/.test(n));
    let child: ChildProcessWithoutNullStreams;
    if (ctx.host.kind === 'docker' && ctx.host.spawnStream) {
      // Inside the session's container: its network policy (none, the allowlist) is the
      // script's too, on every OS. The runner goes in as source; `timeout` ends it there
      // (killing the docker CLI alone would leave it running).
      const secs = String(Math.ceil(timeoutMs / 1000) + 5);
      child = await ctx.host.spawnStream('timeout', ['-k', '5', secs, 'node', '--permission', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', runnerSource()], {});
    } else {
      const node = [process.execPath, '--permission', `--allow-fs-read=${RUNNER}`, '--disable-warning=ExperimentalWarning', RUNNER];
      const [cmd, ...args] = scriptNetworkIsolated() ? ['unshare', ...UNSHARE, ...node] : node;
      child = spawn(cmd!, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '' }, windowsHide: true });
    }
    let stderr = '';
    child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d; });
    child.stdin.on('error', () => {});
    const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + '\n');
    let calls = 0;
    const done = new Promise<{ ok: boolean; output: string; error?: string }>((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ ok: false, output: '', error: `the script ran longer than ${timeoutMs / 1000}s` }); }, timeoutMs);
      const onAbort = () => { child.kill('SIGKILL'); resolve({ ok: false, output: '', error: 'interrupted' }); };
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      child.on('exit', (code) => { clearTimeout(timer); ctx.signal.removeEventListener('abort', onAbort); resolve({ ok: false, output: '', error: `the script process exited (${code})${stderr ? `: ${stderr.trim().slice(0, 600)}` : ''}` }); });
      readline.createInterface({ input: child.stdout }).on('line', async (line) => {
        let m: { type?: string; id?: number; name?: string; input?: Record<string, unknown>; ok?: boolean; output?: string; error?: string };
        try { m = JSON.parse(line); } catch { return; }
        if (m.type === 'done') { clearTimeout(timer); ctx.signal.removeEventListener('abort', onAbort); child.kill(); resolve({ ok: !!m.ok, output: m.output ?? '', error: m.error }); return; }
        if (m.type !== 'call') return;
        if (++calls > MAX_CALLS) return send({ type: 'result', id: m.id, ok: false, content: `a script may make at most ${MAX_CALLS} tool calls` });
        if (NOT_FROM_SCRIPTS.has(m.name ?? '')) return send({ type: 'result', id: m.id, ok: false, content: `${m.name} cannot be called from a script` });
        try {
          const r = await ctx.callTool!(m.name ?? '', m.input && typeof m.input === 'object' ? m.input : {});
          send({ type: 'result', id: m.id, ok: !r.is_error, content: r.content });
        } catch (e) { send({ type: 'result', id: m.id, ok: false, content: (e as Error).message }); }
      });
    });
    send({ code: str(input.code), tools: names, timeoutMs });
    const r = await done;
    const body = await clipOrSpill(ctx, 'run_script', r.output.trim(), 20_000, 'print less, or summarise in the script');
    if (!r.ok) return { content: `The script failed after ${calls} tool call(s): ${r.error}${body ? `\nOutput before it failed:\n${body}` : ''}`, is_error: true };
    return { content: `${body || '(the script printed nothing and returned nothing)'}\n[${calls} tool call(s) inside the script]` };
  },
};
