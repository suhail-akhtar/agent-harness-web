import { spawn } from 'node:child_process';
import type { ToolDisplay } from '../core/types.ts';

// A ToolHost is where tools touch a filesystem and run commands.
//   docker    - a per-session container; files live in a host directory
//               bind-mounted at /workspace, commands run inside the container.
//   local     - a directory on the server machine, commands run unsandboxed.
//   companion - a process on the user's own machine; whole tool calls are
//               dispatched to it and it runs the same tool code locally.

export interface ExecResult { stdout: string; stderr: string; code: number | null; timedOut: boolean }
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
    env[k] = v;
  }
  return { ...env, ...extra };
}

export interface ToolOutcome { content: string; is_error?: boolean; display?: ToolDisplay }

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
  networkPolicy: 'none' | 'full';
  exec(cmd: string, opts: ExecOptions): Promise<ExecResult>;
  /** Present on hosts that run whole tool calls themselves (companion). */
  remoteTool?: (name: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<ToolOutcome>;
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
    const kill = () => {
      if (child.pid === undefined || child.exitCode !== null) return;
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
      resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), code, timedOut });
    };
    child.on('error', (e) => { err.push(Buffer.from(String(e.message))); finish(127); });
    child.on('close', (code) => finish(code));
  });
}

export class LocalHost implements ToolHost {
  kind = 'local' as const;
  root: string;
  displayRoot: string;
  platform = process.platform;
  shell = process.platform === 'win32' ? 'powershell' : 'bash';
  sandboxed = false;
  networkPolicy = 'full' as const;
  constructor(root: string) {
    this.root = root;
    this.displayRoot = root;
  }
  exec(cmd: string, opts: ExecOptions): Promise<ExecResult> {
    const o = { ...opts, cwd: opts.cwd ?? this.root, env: opts.env ?? scrubbedEnv() };
    if (process.platform === 'win32') return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], o);
    return run('bash', ['-c', cmd], o);
  }
}
