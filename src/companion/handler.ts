import fs from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LocalHost, type ToolHost } from '../runtime/host.ts';
import { toolByName } from '../tools/index.ts';
import { resolveIn } from '../tools/paths.ts';
import type { FileStamp, ToolContext, ToolKind } from '../tools/types.ts';
import { checkRequest, type DesktopExecutor, type DesktopRequest, systemDesktop } from './desktop.ts';

// What a companion does with each job from the server, kept apart from the
// network loop so it can be tested. Everything is confined to the folder the
// companion was started in.

export type CompanionJob =
  /** `swarm`: a swarm agent's call (docs/swarm/SWARM.md, phase 7), held to this machine's policy for swarm work. */
  /** `opKey`: what the call is (the session, the tool, its input): the same call again is done once (the journal). */
  | { id: string; kind: 'tool'; sessionId: string; name: string; input: Record<string, unknown>; swarm?: boolean; opKey?: string }
  | { id: string; kind: 'exec'; sessionId: string; command: string; timeoutMs: number; stdin?: string; swarm?: boolean; opKey?: string }
  /** Stop a job that is running here (its process tree is killed); a job that is not running is no-op. */
  | { id: string; kind: 'cancel'; sessionId: string; target: string; reason?: string }
  | { id: string; kind: 'pull'; sessionId: string; known: Record<string, [number, number]>; maxBytes: number; chunkBytes?: number }
  /** `swarm`: a file a swarm agent sends here (copy_file): held to the policy as a write. */
  | { id: string; kind: 'push'; sessionId: string; path: string; data: string; swarm?: boolean; opKey?: string }
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

/**
 * What this machine offers to agents' work (phase 7): set on the machine, in a file the sandbox cannot see
 * (~/.harness-companion/policy.json, through `harness-companion policy`), never by the server, which can only
 * narrow it. The conversation's own agent works as the companion's start flags allow; swarm agents (the sub-agents
 * a run starts) work here only when `swarm` is on, with the kinds of tools listed, in a sandbox unless the person
 * turned that off, and at most `maxJobs` at once.
 */
export interface MachinePolicy { swarm: boolean; kinds: ToolKind[]; maxJobs: number; sandboxRequired: boolean }
// With no policy file: swarm agents may read here (an explore agent works as before), nothing more; writing,
// commands and the network are the owner's to allow. Read-only work needs no sandbox (nothing runs).
export const DEFAULT_POLICY: MachinePolicy = { swarm: true, kinds: ['read'], maxJobs: 4, sandboxRequired: true };
const KINDS: ToolKind[] = ['read', 'edit', 'exec', 'network', 'external', 'meta'];

/** A policy from a file's JSON: anything unreadable falls back to the default (no swarm work). */
export function cleanPolicy(o: unknown): MachinePolicy {
  const p = o && typeof o === 'object' ? o as Record<string, unknown> : {};
  const kinds = Array.isArray(p.kinds) ? p.kinds.filter((k): k is ToolKind => KINDS.includes(k as ToolKind)) : DEFAULT_POLICY.kinds;
  const max = Number(p.maxJobs);
  return { swarm: p.swarm === true, kinds: [...new Set(kinds)], maxJobs: Number.isInteger(max) && max >= 1 && max <= 64 ? max : DEFAULT_POLICY.maxJobs, sandboxRequired: p.sandboxRequired !== false };
}

/** Why this machine refuses a swarm agent's job, by its policy (undefined: it runs). */
export function policyRefusal(job: CompanionJob, policy: MachinePolicy, sandboxed: boolean): string | undefined {
  if ((job.kind !== 'tool' && job.kind !== 'exec' && job.kind !== 'push') || !job.swarm) return undefined;
  const by = 'refused by this machine\'s policy';
  if (!policy.swarm) return `${by}: it does not take swarm work (its owner can allow it: harness-companion policy --swarm on)`;
  const tool = job.kind === 'tool' ? toolByName(job.name) : undefined;
  const kinds: ToolKind[] = job.kind === 'exec' ? ['exec'] : job.kind === 'push' ? ['edit'] : tool?.kindsFor?.(job.input) ?? (tool ? [tool.kind] : ['exec']);
  const off = kinds.filter((k) => !policy.kinds.includes(k));
  if (off.length) return `${by}: ${job.kind === 'exec' ? 'a command' : job.kind === 'push' ? 'a file sent here' : job.name} needs ${off.join(', ')}, and swarm work here may only ${policy.kinds.join(', ')} (its owner can allow more: harness-companion policy --kinds ...)`;
  // Reading changes nothing; anything more from a swarm agent runs contained, or not at all.
  if (policy.sandboxRequired && !sandboxed && kinds.some((k) => k !== 'read')) return `${by}: swarm work beyond reading runs only in a sandbox here, and this companion has none (start it with --sandbox, or its owner sets --sandbox-required off)`;
  // A detached command outlives the job and its lease: not in swarm work.
  if (job.kind === 'tool' && job.input.run_in_background === true) return `${by}: background commands outlive the job; swarm work here runs commands in the foreground only`;
  return undefined;
}

/** How long a result waits in the journal for the server (24 hours). */
const JOURNAL_MS = 24 * 60 * 60_000;

/** A project MCP server running here: what it said and the server has not yet read. */
interface McpRelay { child: import('node:child_process').ChildProcessWithoutNullStreams; inbox: Record<string, unknown>[]; held: number; waiters: (() => void)[]; closed?: string }

export function createCompanionHandler(dir: string, opts: {
  allowHooks?: boolean;
  /** Project MCP servers (.mcp.json) may start here without a sandbox. */ trustProject?: boolean;
  /** The agent may see this screen and use the mouse and keyboard (--allow-desktop). */ allowDesktop?: boolean;
  /** How desktop jobs run (default: this OS's own tools; tests pass a stand-in). */ desktop?: DesktopExecutor;
  log?: (m: string) => void;
  /** Where commands run: a sandboxed host for the folder (default: plain). */ host?: ToolHost;
  /** This machine's policy for swarm work, read for every job (an edit takes effect at the next one). Default: none. */
  policy?: () => MachinePolicy;
  /** Where calls that change something are journaled with their results until the server has them (done once). */
  journal?: string;
  /** A line per job for this machine's own audit log (who asked what, and what came of it). */
  audit?: (e: { at: string; job: string; kind: string; session: string; what: string; swarm: boolean; outcome: string }) => void;
} = {}) {
  const host: ToolHost = opts.host ?? new LocalHost(dir);
  const desktop = opts.desktop ?? systemDesktop(dir);
  const readFiles = new Map<string, Map<string, FileStamp>>();
  /** Jobs running here, each with the signal that stops it (a cancel, the lease running out, the companion stopping). */
  const running = new Map<string, AbortController>();
  /** Swarm jobs waiting for a place under the policy's maxJobs. */
  let swarmActive = 0;
  const swarmWaiting: (() => void)[] = [];
  let fenced: string | undefined;

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

  async function run(job: CompanionJob, signal: AbortSignal): Promise<{ ok: boolean; value: unknown }> {
    try {
      if (job.kind === 'exec') {
        if (!opts.allowHooks) throw new Error('hooks are disabled on this companion (start it with --allow-hooks)');
        return { ok: true, value: await host.exec(job.command, { timeoutMs: job.timeoutMs, stdin: job.stdin, signal }) };
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
        const ctx: ToolContext = { host, signal, readFiles: files, todos: [], setTodos() {}, emit() {} };
        opts.log?.(tool.summarize(job.input));
        try { return { ok: true, value: await tool.run(job.input, ctx) }; } catch (err) { return { ok: true, value: { content: (err as Error).message, is_error: true } }; }
      }
      throw new Error(`this companion does not know the job "${(job as { kind: string }).kind}": update it (download it again from the web app)`);
    } catch (err) {
      return { ok: false, value: { error: (err as Error).message } };
    }
  }

  const what = (job: CompanionJob) => (job.kind === 'tool' ? `${job.name} ${toolByName(job.name)?.summarize(job.input) ?? ''}`.trim() : job.kind === 'exec' ? `exec ${job.command}` : job.kind === 'cancel' ? `cancel ${job.target}` : job.kind).slice(0, 300);
  const record = (job: CompanionJob, outcome: string) => opts.audit?.({ at: new Date().toISOString(), job: job.id, kind: job.kind, session: job.sessionId, what: what(job), swarm: 'swarm' in job && job.swarm === true, outcome });

  async function handle(job: CompanionJob): Promise<{ ok: boolean; value: unknown }> {
    if (job.kind === 'cancel') {
      // Idempotent: a job already stopping (or gone) is left as it is.
      const c = running.get(job.target);
      const now = !!c && !c.signal.aborted;
      if (now) { c!.abort(new Error(job.reason ?? 'cancelled by the server')); opts.log?.(`stopped job ${job.target}${job.reason ? `: ${job.reason}` : ''}`); }
      record(job, now ? 'stopped' : c ? 'already stopping' : 'not running');
      return { ok: true, value: { stopped: now } };
    }
    // Fenced (the lease ran out without word from the server): nothing new starts until the server is heard again.
    if (fenced) { record(job, `refused: ${fenced}`); return { ok: false, value: { error: `this companion stopped taking work: ${fenced}` } }; }
    const policy = opts.policy?.() ?? DEFAULT_POLICY;
    const no = policyRefusal(job, policy, host.sandboxed === true);
    if (no) { opts.log?.(no); record(job, no); return { ok: false, value: { error: no } }; }
    const swarm = 'swarm' in job && job.swarm === true;
    const c = new AbortController();
    running.set(job.id, c);
    try {
      if (swarm) {
        while (swarmActive >= policy.maxJobs && !c.signal.aborted) await new Promise<void>((r) => { swarmWaiting.push(r); c.signal.addEventListener('abort', () => r(), { once: true }); });
        if (c.signal.aborted) { record(job, 'stopped before it started'); return { ok: false, value: { error: `stopped before it started: ${(c.signal.reason as Error)?.message ?? 'cancelled'}` } }; }
        swarmActive++;
      }
      try {
        // Done once: the same call again, while its earlier result never reached the server, gets that result.
        const key = effectKey(job);
        const earlier = key ? journal().get(key) : undefined;
        if (earlier && !earlier.delivered && Date.now() - earlier.at < JOURNAL_MS) {
          record(job, `not run again: done at ${new Date(earlier.at).toISOString()}, its result handed over`);
          earlier.jobs.push(job.id); saveJournal();
          return { ok: earlier.ok, value: replayed(earlier.value, earlier.at) };
        }
        const r = await run(job, c.signal);
        record(job, c.signal.aborted ? `stopped: ${(c.signal.reason as Error)?.message ?? 'cancelled'}` : r.ok ? ((r.value as { is_error?: boolean; code?: number })?.is_error ? 'error' : 'done') : `failed: ${(r.value as { error?: string })?.error ?? ''}`.slice(0, 200));
        if (key && !c.signal.aborted) { journal().set(key, { at: Date.now(), ok: r.ok, value: r.value, delivered: false, jobs: [job.id] }); saveJournal(); }
        // A stopped job says so, whatever its tool returned on the way out.
        return c.signal.aborted ? { ok: false, value: { error: `stopped on this machine: ${(c.signal.reason as Error)?.message ?? 'cancelled'}` } } : r;
      } finally {
        if (swarm) { swarmActive--; swarmWaiting.shift()?.(); }
      }
    } finally { running.delete(job.id); }
  }

  // ---- done once (phase 7, recommendation 7) ----
  // A call that changes something (a write, a command) is journaled with its result, by what it is (opKey: the session,
  // the tool and its input, from the server). Until the server has the result, the same call again is answered from
  // the journal instead of being run twice: a deploy, a payment script, an email runs once although the machine
  // dropped (or the server restarted) between doing it and saying so. A delivered result is not replayed: running the
  // tests twice runs them twice.
  type Entry = { at: number; ok: boolean; value: unknown; delivered: boolean; jobs: string[] };
  let entries: Map<string, Entry> | undefined;
  const journal = (): Map<string, Entry> => {
    if (entries) return entries;
    entries = new Map();
    if (opts.journal) { try { for (const [k, v] of Object.entries(JSON.parse(readFileSync(opts.journal, 'utf8')) as Record<string, Entry>)) entries.set(k, v); } catch { /* none yet */ } }
    return entries;
  };
  const saveJournal = () => {
    if (!opts.journal || !entries) return;
    const now = Date.now();
    for (const [k, v] of entries) if (now - v.at > JOURNAL_MS) entries.delete(k);
    while (entries.size > 500) entries.delete(entries.keys().next().value!);
    try { mkdirSync(path.dirname(opts.journal), { recursive: true, mode: 0o700 }); writeFileSync(opts.journal, JSON.stringify(Object.fromEntries(entries)), { mode: 0o600 }); } catch { /* best effort */ }
  };
  // Only where the companion keeps a journal; only the agent's own calls carry a key (a check or a hook runs fresh).
  const effectKey = (job: CompanionJob): string | undefined => {
    if (!opts.journal) return undefined;
    if (!('opKey' in job) || typeof job.opKey !== 'string' || !job.opKey) return undefined;
    if (job.kind === 'exec' || job.kind === 'push') return job.opKey;
    if (job.kind !== 'tool') return undefined;
    const tool = toolByName(job.name);
    const kinds = tool?.kindsFor?.(job.input) ?? (tool ? [tool.kind] : []);
    return kinds.some((k) => k !== 'read' && k !== 'meta') ? job.opKey : undefined;
  };
  const replayed = (value: unknown, at: number): unknown => {
    const note = `[Done on this computer at ${new Date(at).toISOString()}, while the server could not hear it: not run again. Its result:]\n`;
    if (value && typeof value === 'object' && 'content' in (value as Record<string, unknown>)) return { ...(value as Record<string, unknown>), content: `${note}${String((value as { content: unknown }).content)}` };
    if (value && typeof value === 'object' && 'stdout' in (value as Record<string, unknown>)) return { ...(value as Record<string, unknown>), stdout: `${note}${String((value as { stdout: unknown }).stdout)}`, replayed: true };
    return value;
  };

  return Object.assign(handle, {
    /** The server has a job's result: its journal entry is no longer replayed (the next identical call runs). */
    delivered(jobId: string) {
      for (const v of journal().values()) if (v.jobs.includes(jobId) && !v.delivered) { v.delivered = true; saveJournal(); }
    },
    /** The jobs running here now (reported with each poll, so the server can stop the ones it no longer knows). */
    running: () => [...running.keys()],
    /** Stops every job running here, and (with `fence`) takes no new work until `unfence`. */
    stopAll(reason: string, fence = false) {
      if (fence) fenced = reason;
      for (const c of running.values()) c.abort(new Error(reason));
      for (const w of swarmWaiting.splice(0)) w();
    },
    unfence() { fenced = undefined; },
  });
}
