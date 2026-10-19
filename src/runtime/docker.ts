import type { ExecOptions, ExecResult, ToolHost } from './host.ts';
import { run } from './host.ts';

// One container per session. The workspace is a host directory mounted at
// /workspace; the container has no network by default, drops every
// capability, and is limited in memory, CPU and process count. File tools work
// on the host directory (with symlink-safe path checks); only commands run in
// the container.

export interface DockerOptions {
  image: string;
  network: 'none' | 'full';
  memory: string;
  cpus: string;
}

export const dockerDefaults = (): DockerOptions => ({
  image: process.env.HARNESS_SANDBOX_IMAGE || 'harness-sandbox:latest',
  network: 'none',
  memory: process.env.HARNESS_SANDBOX_MEMORY || '4g',
  cpus: process.env.HARNESS_SANDBOX_CPUS || '2',
});

export async function dockerAvailable(): Promise<boolean> {
  const r = await run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 10_000 });
  return r.code === 0;
}

export async function imageExists(image: string): Promise<boolean> {
  const r = await run('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { timeoutMs: 15_000 });
  return r.code === 0;
}

export class DockerHost implements ToolHost {
  kind = 'docker' as const;
  root: string;
  displayRoot = '/workspace';
  platform = 'linux';
  shell = 'bash';
  sandboxed = true;
  networkPolicy: 'none' | 'full';
  private name: string;
  private opts: DockerOptions;
  private ready: Promise<void> | undefined;

  constructor(sessionId: string, root: string, opts: DockerOptions) {
    this.root = root;
    this.opts = opts;
    this.networkPolicy = opts.network;
    this.name = `harness-${sessionId}`;
  }

  private ensure(): Promise<void> {
    this.ready ??= this.start().catch((e) => { this.ready = undefined; throw e; });
    return this.ready;
  }

  private async start(): Promise<void> {
    const state = await run('docker', ['inspect', '-f', '{{.State.Running}}', this.name], { timeoutMs: 15_000 });
    if (state.code === 0 && state.stdout.trim() === 'true') return;
    if (state.code === 0) {
      const s = await run('docker', ['start', this.name], { timeoutMs: 30_000 });
      if (s.code === 0) return;
      await run('docker', ['rm', '-f', this.name], { timeoutMs: 15_000 });
    }
    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? 1000;
    const args = [
      'run', '-d', '--init', '--name', this.name,
      '--network', this.opts.network === 'full' ? 'bridge' : 'none',
      '--memory', this.opts.memory, '--cpus', this.opts.cpus, '--pids-limit', '512',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--user', `${uid}:${gid}`,
      '-e', 'HOME=/tmp/home', '-e', 'CI=1',
      '-v', `${this.root}:/workspace`, '-w', '/workspace',
      '--label', 'harness-web=1',
      this.opts.image, 'sleep', 'infinity',
    ];
    const r = await run('docker', args, { timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(`could not start the sandbox container: ${(r.stderr || r.stdout).trim()}`);
    await run('docker', ['exec', this.name, 'mkdir', '-p', '/tmp/home'], { timeoutMs: 15_000 });
  }

  async exec(cmd: string, opts: ExecOptions): Promise<ExecResult> {
    await this.ensure();
    const secs = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
    const workdir = opts.cwd ?? '/workspace';
    // `timeout` inside the container kills the command itself; killing the
    // docker CLI alone would leave it running.
    const r = await run('docker', ['exec', '-i', '-w', workdir, this.name, 'timeout', '-k', '5', String(secs), 'bash', '-lc', cmd], { ...opts, timeoutMs: opts.timeoutMs + 15_000 });
    if (r.code === 124) r.timedOut = true;
    return r;
  }

  /** Stops the container (it restarts on next use); the workspace stays. */
  async stop(): Promise<void> {
    this.ready = undefined;
    await run('docker', ['stop', '-t', '2', this.name], { timeoutMs: 30_000 });
  }

  async close(): Promise<void> {
    this.ready = undefined;
    await run('docker', ['rm', '-f', this.name], { timeoutMs: 30_000 });
  }
}
