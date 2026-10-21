import fs from 'node:fs/promises';
import path from 'node:path';
import { LocalHost, type ToolHost } from '../runtime/host.ts';
import { toolByName } from '../tools/index.ts';
import { resolveIn } from '../tools/paths.ts';
import type { FileStamp, ToolContext } from '../tools/types.ts';
import { checkRequest, type DesktopExecutor, type DesktopRequest, systemDesktop } from './desktop.ts';

// What a companion does with each job from the server, kept apart from the
// network loop so it can be tested. Everything is confined to the folder the
// companion was started in.

export type CompanionJob =
  | { id: string; kind: 'tool'; sessionId: string; name: string; input: Record<string, unknown> }
  | { id: string; kind: 'exec'; sessionId: string; command: string; timeoutMs: number; stdin?: string }
  | { id: string; kind: 'pull'; sessionId: string; known: Record<string, [number, number]>; maxBytes: number; chunkBytes?: number }
  | { id: string; kind: 'push'; sessionId: string; path: string; data: string }
  /** One file in the folder: its bytes (null when absent), or remove it - for checkpoints and project config. */
  | { id: string; kind: 'file'; sessionId: string; op: 'get' | 'delete'; path: string }
  /**
   * A project MCP server on this computer: start it, or send it a message and get
   * back what it has said since (a request waits for its own answer).
   */
  | { id: string; kind: 'mcp'; sessionId: string; op: 'start' | 'send' | 'stop'; server: string; command?: string; args?: string[]; env?: Record<string, string>; message?: Record<string, unknown>; timeoutMs?: number }
  /** The computer tool on this computer's real screen: only with --allow-desktop. */
  | { id: string; kind: 'desktop'; sessionId: string; request: DesktopRequest };

/** Why a desktop job is refused, and how to allow it. */
export const DESKTOP_OFF = 'desktop control is off on this companion: the user can restart it with --allow-desktop to let the agent see this screen and use the mouse and keyboard (each action is approved in the web app)';

/** Folders never copied to the server: big, regenerated, or private to tools. */
export const MIRROR_SKIP = new Set(['node_modules', '.git', '.harness', '.venv', 'venv', '__pycache__', '.next', 'target', 'dist', 'build', 'coverage']);
/** Files never copied either: secrets a page or a document never needs. */
export const MIRROR_SKIP_FILE = /^(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)(\.pub)?|\.npmrc|\.netrc)$/i;
const FILE_MAX = 20 * 1024 * 1024;

/** A project MCP server's largest message, and the most it may say before the server reads it. */
const MCP_MESSAGE_MAX = 16 * 1024 * 1024;
const MCP_INBOX_MAX = 32 * 1024 * 1024;

/** A project MCP server running here: what it said and the server has not yet read. */
interface McpRelay { child: import('node:child_process').ChildProcessWithoutNullStreams; inbox: Record<string, unknown>[]; held: number; waiters: (() => void)[]; closed?: string }

export function createCompanionHandler(dir: string, opts: {
  allowHooks?: boolean;
  /** Project MCP servers (.mcp.json) may start here without a sandbox. */ trustProject?: boolean;
  /** The agent may see this screen and use the mouse and keyboard (--allow-desktop). */ allowDesktop?: boolean;
  /** How desktop jobs run (default: this OS's own tools; tests pass a stand-in). */ desktop?: DesktopExecutor;
  log?: (m: string) => void;
  /** Where commands run: a sandboxed host for the folder (default: plain). */ host?: ToolHost;
} = {}) {
  const host: ToolHost = opts.host ?? new LocalHost(dir);
  const desktop = opts.desktop ?? systemDesktop(dir);
  const readFiles = new Map<string, Map<string, FileStamp>>();

  /**
   * Files that changed since the server's copy (by size and mtime); the server
   * removes what is not listed. With `chunkBytes` the reply carries at most
   * about that much file data and says `more`, and the server asks again - one
   * reply always fits the server's request limit.
   */
  async function pull(known: Record<string, [number, number]>, maxBytes: number, chunkBytes?: number) {
    const files: { path: string; size: number; mtime: number; data?: string }[] = [];
    let bytes = 0;
    let more = false;
    const walk = async (rel: string) => {
      for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (!MIRROR_SKIP.has(e.name)) await walk(r); continue; }
        if (!e.isFile() || MIRROR_SKIP_FILE.test(e.name)) continue;
        const st = await fs.stat(path.join(dir, r));
        if (st.size > FILE_MAX) continue;
        const mtime = Math.floor(st.mtimeMs);
        const k = known[r];
        if (k && k[0] === st.size && k[1] === mtime) { files.push({ path: r, size: st.size, mtime }); continue; }
        if (chunkBytes && bytes > 0 && bytes + st.size > chunkBytes) { more = true; files.push({ path: r, size: st.size, mtime }); continue; }
        bytes += st.size;
        if (!chunkBytes && bytes > maxBytes) throw new Error(`the folder has more than ${Math.round(maxBytes / 1048576)} MB to copy for this tool (node_modules, .git and build output are skipped)`);
        files.push({ path: r, size: st.size, mtime, data: (await fs.readFile(path.join(dir, r))).toString('base64') });
      }
    };
    await walk('');
    return { files, more };
  }

  /** Project MCP servers running on this computer, by session and name; what each has said and not yet been relayed. */
  const servers = new Map<string, McpRelay>();

  async function mcp(job: Extract<CompanionJob, { kind: 'mcp' }>): Promise<unknown> {
    const key = `${job.sessionId}/${job.server}`;
    if (job.op === 'start') {
      if (!opts.trustProject && !host.sandboxed) throw new Error('project MCP servers do not start on this computer: start the companion with --trust-project, or with a sandbox');
      if (!host.spawnStream || !job.command) throw new Error('this companion cannot start processes');
      servers.get(key)?.child.kill();
      const child = await host.spawnStream(job.command, job.args ?? [], job.env ?? {});
      const s: McpRelay = { child, inbox: [], waiters: [], held: 0 };
      let buf = '';
      // Held until the server asks for them: bounded, so a server that talks without end
      // (or never ends a line) is stopped instead of filling this computer's memory.
      const stop = (why: string) => { s.closed = why; child.kill(); for (const w of s.waiters.splice(0)) w(); };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d: string) => {
        if (s.closed) return;
        buf += d;
        if (buf.length > MCP_MESSAGE_MAX) return stop(`sent a message over ${MCP_MESSAGE_MAX / 1024 / 1024} MB`);
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try { s.inbox.push(JSON.parse(line)); s.held += line.length; } catch { /* not a message */ }
          if (s.held > MCP_INBOX_MAX) return stop(`said more than ${MCP_INBOX_MAX / 1024 / 1024} MB that was not read`);
          for (const w of s.waiters.splice(0)) w();
        }
      });
      child.on('exit', (code) => { s.closed = `exited with ${code}`; for (const w of s.waiters.splice(0)) w(); });
      servers.set(key, s);
      opts.log?.(`started project MCP server ${job.server}`);
      return { ok: true };
    }
    const s = servers.get(key);
    if (job.op === 'stop') { s?.child.kill(); servers.delete(key); return { ok: true }; }
    if (!s) throw new Error(`MCP server ${job.server} is not running here`);
    if (s.closed) throw new Error(`MCP server ${job.server} ${s.closed}`);
    s.child.stdin.write(JSON.stringify(job.message) + '\n');
    // A request waits for its own answer (anything else said meanwhile comes along); a notification does not wait.
    const id = (job.message as { id?: unknown })?.id;
    const deadline = Date.now() + Math.min(job.timeoutMs ?? 60_000, 15 * 60_000);
    while (id !== undefined && !s.inbox.some((m) => m.id === id && ('result' in m || 'error' in m)) && !s.closed && Date.now() < deadline) {
      await new Promise<void>((r) => { s.waiters.push(r); setTimeout(r, 1000); });
    }
    s.held = 0;
    return { messages: s.inbox.splice(0), ...(s.closed ? { closed: s.closed } : {}) };
  }

  return async function handle(job: CompanionJob): Promise<{ ok: boolean; value: unknown }> {
    try {
      if (job.kind === 'exec') {
        if (!opts.allowHooks) throw new Error('hooks are disabled on this companion (start it with --allow-hooks)');
        return { ok: true, value: await host.exec(job.command, { timeoutMs: job.timeoutMs, stdin: job.stdin }) };
      }
      if (job.kind === 'pull') {
        opts.log?.('copying changed files for a server-side tool');
        return { ok: true, value: await pull(job.known ?? {}, job.maxBytes, job.chunkBytes) };
      }
      if (job.kind === 'file') {
        const real = await resolveIn(host, job.path);
        if (job.op === 'delete') { await fs.rm(real, { force: true }); return { ok: true, value: { ok: true } }; }
        const st = await fs.stat(real).catch(() => null);
        if (!st?.isFile()) return { ok: true, value: { data: null } };
        if (st.size > FILE_MAX) throw new Error(`${job.path} is larger than ${FILE_MAX / 1048576} MB`);
        return { ok: true, value: { data: (await fs.readFile(real)).toString('base64') } };
      }
      if (job.kind === 'mcp') return { ok: true, value: await mcp(job) };
      if (job.kind === 'desktop') {
        if (!opts.allowDesktop) throw new Error(DESKTOP_OFF);
        const req = job.request;
        checkRequest(req);
        // Never the typed text itself: it shows on the screen, not in this log.
        const typed = req.steps.find((s) => s.t === 'type');
        opts.log?.(`desktop: ${req.action}${typed && typed.t === 'type' ? ` (${typed.text.length} characters)` : ''}${req.launch ? ` ${req.launch.slice(0, 200)}` : ''}`);
        return { ok: true, value: await desktop(req) };
      }
      if (job.kind === 'push') {
        const real = await resolveIn(host, job.path);
        await fs.mkdir(path.dirname(real), { recursive: true });
        await fs.writeFile(real, Buffer.from(job.data, 'base64'));
        opts.log?.(`wrote ${job.path}`);
        return { ok: true, value: { ok: true } };
      }
      if (job.kind === 'tool') {
        const tool = toolByName(job.name);
        if (!tool || !tool.remoteable) throw new Error(`tool ${job.name} does not run on the companion`);
        const files = readFiles.get(job.sessionId) ?? new Map<string, FileStamp>();
        readFiles.set(job.sessionId, files);
        const ctx: ToolContext = { host, signal: new AbortController().signal, readFiles: files, todos: [], setTodos() {}, emit() {} };
        opts.log?.(tool.summarize(job.input));
        try { return { ok: true, value: await tool.run(job.input, ctx) }; } catch (err) { return { ok: true, value: { content: (err as Error).message, is_error: true } }; }
      }
      throw new Error(`this companion does not know the job "${(job as { kind: string }).kind}": update it (download it again from the web app)`);
    } catch (err) {
      return { ok: false, value: { error: (err as Error).message } };
    }
  };
}
