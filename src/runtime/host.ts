import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import type { ToolDisplay } from '../core/types.ts';
import { type OsSandboxKind, wrapCommand } from './os-sandbox.ts';

// A ToolHost is where tools touch a filesystem and run commands.
//   docker    - a per-session container; files live in a host directory
//               bind-mounted at /workspace, commands run inside the container.
//   local     - a directory on the server machine, commands run unsandboxed.
//   companion - a process on the user's own machine; whole tool calls are
//               dispatched to it and it runs the same tool code locally.

export interface ExecResult { stdout: string; stderr: string; code: number | null; timedOut: boolean; orphansKilled?: boolean }
export interface ExecOptions { timeoutMs: number; signal?: AbortSignal; stdin?: string; cwd?: string; env?: NodeJS.ProcessEnv }

/**
 * The server's environment minus anything that looks like a credential. A
 * command the model runs on this machine must never be able to `echo` the
 * provider keys the server holds.
 */
export function scrubbedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE|SESSION/i.test(k)) continue;
    // Git's environment config is one group (COUNT, KEY_n, VALUE_n): it can carry
    // credentials (http.extraHeader), and half of it makes every git command fail.
    if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(k)) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

export interface ShellChoice { kind: 'bash' | 'powershell'; path: string; why: string }

/**
 * The shell commands run in. On Windows: Git Bash when it is installed (the quality
 * gates, background commands and models' habits are bash), else PowerShell (and
 * the model is told so). Never C:\Windows\System32\bash.exe: that is WSL, which
 * runs inside Linux and sees the Windows workspace at a different path.
 * HARNESS_SHELL=bash|powershell|<path to bash.exe> overrides.
 */
export function resolveShell(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): ShellChoice {
  if (platform !== 'win32') return { kind: 'bash', path: 'bash', why: 'default' };
  const want = env.HARNESS_SHELL?.trim();
  if (want && /powershell/i.test(want)) return { kind: 'powershell', path: 'powershell.exe', why: 'HARNESS_SHELL' };
  if (want && want !== 'bash' && exists(want)) return { kind: 'bash', path: want, why: 'HARNESS_SHELL' };
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs'), 'C:\\Program Files'].filter(Boolean) as string[];
  const candidates = [
    ...roots.map((r) => path.win32.join(r, 'Git', 'bin', 'bash.exe')),
    ...(env.Path ?? env.PATH ?? '').split(';').filter((d) => d && !/\\system32\b/i.test(d) && !/WindowsApps/i.test(d)).map((d) => path.win32.join(d, 'bash.exe')),
  ];
  const found = candidates.find((c) => exists(c));
  if (found) return { kind: 'bash', path: found, why: 'Git Bash' };
  return { kind: 'powershell', path: 'powershell.exe', why: 'no Git Bash found (install Git for Windows for bash)' };
}

export interface ImageData { media_type: string; data: string }
export interface ToolOutcome { content: string; is_error?: boolean; display?: ToolDisplay; images?: ImageData[]; /** Content from outside the user's control (the agent tool sets it when its sub-agent read the web). */ untrusted?: boolean }

export interface ToolHost {
  kind: 'docker' | 'local' | 'companion';
  /** Real directory the file tools operate on (unused for companion). */
  root: string;
  /** The workspace path as the model sees it. */
  displayRoot: string;
  /** Platform and shell the model's commands run under. */
  platform: string;
  shell: string;
  /** Whether commands are isolated from the host (OS sandbox). */
  sandboxed: boolean;
  /** allowlist: only some hosts, through the harness's proxy. */
  networkPolicy: 'none' | 'full' | 'allowlist';
  /** allowlist: the hosts currently allowed. */
  allowedHosts?(): Promise<string[]>;
  /** API credentials commands can use through the proxy, and the variables that point at them. */
  credentialEnv?(): { name: string; vars: string[] }[];
  exec(cmd: string, opts: ExecOptions): Promise<ExecResult>;
  /** Starts a long-lived process with piped stdio where tools run (MCP servers). */
  spawnStream?(command: string, args: string[], env: Record<string, string>): Promise<ChildProcessWithoutNullStreams>;
  /** Present on hosts that run whole tool calls themselves (companion). */
  remoteTool?: (name: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<ToolOutcome>;
  /** Companion: a server-side copy of the folder (changed files copied), for tools that run on the server. */
  mirror?(signal?: AbortSignal): Promise<string>;
  /** Companion: writes a file the server made back into the user's folder. */
  pushFile?(rel: string, data: Buffer, signal?: AbortSignal): Promise<void>;
  close?(): Promise<void>;
}

const MAX_CAPTURE = 4 * 1024 * 1024;

function capture(chunks: Buffer[], size: { n: number }, b: Buffer) {
  if (size.n >= MAX_CAPTURE) return;
  chunks.push(b);
  size.n += b.length;
}

/** Spawns a process, killing its whole process group on timeout or abort. */
export function run(cmd: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, detached: !win, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const out: Buffer[] = []; const err: Buffer[] = [];
    const so = { n: 0 }; const se = { n: 0 };
    let timedOut = false;
    let done = false;
    let orphans = false;
    // Kill the whole process GROUP, even after the shell itself has exited:
    // `server &` leaves a child in the group that still holds our pipes.
    const kill = () => {
      if (child.pid === undefined) return;
      try {
        if (win) spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true });
        else process.kill(-child.pid, 'SIGKILL');
      } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs);
    const onAbort = () => kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (b: Buffer) => capture(out, so, b));
    child.stderr.on('data', (b: Buffer) => capture(err, se, b));
    child.stdin.on('error', () => {});
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin); else child.stdin.end();
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), code, timedOut, ...(orphans ? { orphansKilled: true } : {}) });
    };
    child.on('error', (e) => { err.push(Buffer.from(String(e.message))); finish(127); });
    child.on('close', (code) => finish(code));
    // The command is over when its process exits. If 'close' does not follow
    // shortly, something it started in the background still holds the pipes:
    // stop it and return, rather than wait for it forever.
    child.on('exit', (code) => {
      setTimeout(() => {
        if (done) return;
        orphans = true;
        kill();
        setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(code); }, 500);
      }, 1500);
    });
  });
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Longer `-c` commands are broken by Git Bash on Windows (the limit is near 8K). */
const WIN_BASH_ARG_MAX = 4000;

export class LocalHost implements ToolHost {
  kind = 'local' as const;
  root: string;
  displayRoot: string;
  platform = process.platform;
  shell: string;
  private shellPath: string;
  sandboxed = false;
  networkPolicy: 'none' | 'full' = 'full';
  /** The OS sandbox commands run in (bubblewrap, Seatbelt), if any. */
  readonly osSandbox?: OsSandboxKind;
  constructor(root: string, opts: { sandbox?: OsSandboxKind; network?: 'none' | 'full' } = {}) {
    this.root = root;
    this.displayRoot = root;
    const sh = resolveShell();
    this.shell = sh.kind;
    this.shellPath = sh.path;
    if (opts.sandbox) {
      this.osSandbox = opts.sandbox;
      this.sandboxed = true;
      this.networkPolicy = opts.network ?? 'none';
    }
  }
  async spawnStream(command: string, args: string[], env: Record<string, string>): Promise<ChildProcessWithoutNullStreams> {
    if (this.osSandbox) {
      const w = wrapCommand(this.osSandbox, [command, ...args].map(shq).join(' '), { root: this.root, network: this.networkPolicy });
      return spawn(w.file, w.args, { cwd: this.root, env: scrubbedEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    }
    return spawn(command, args, { cwd: this.root, env: scrubbedEnv(env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  }
  exec(cmd: string, opts: ExecOptions): Promise<ExecResult> {
    const o = { ...opts, cwd: opts.cwd ?? this.root, env: opts.env ?? scrubbedEnv() };
    if (this.osSandbox) {
      const w = wrapCommand(this.osSandbox, cmd, { root: this.root, network: this.networkPolicy });
      return run(w.file, w.args, o);
    }
    if (this.shell === 'powershell') return run(this.shellPath, ['-NoProfile', '-NonInteractive', '-Command', cmd], o);
    // Git Bash cuts a `-c` argument off at about 8K characters, so a long
    // command (a large heredoc) goes in a script file instead.
    if (process.platform !== 'win32' || cmd.length <= WIN_BASH_ARG_MAX) return run(this.shellPath, ['-c', cmd], o);
    const file = path.join(os.tmpdir(), `harness-cmd-${crypto.randomUUID()}.sh`);
    return fs.writeFile(file, cmd)
      .then(() => run(this.shellPath, [file], o))
      .finally(() => fs.rm(file, { force: true }));
  }
}
