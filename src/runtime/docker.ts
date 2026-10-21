import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { worktreeWritable } from '../git/worktree.ts';
import { credentialSummary, proxyCredentialFile, type SandboxCredential } from './credentials.ts';
import type { ExecOptions, ExecResult, ToolHost } from './host.ts';
import { run } from './host.ts';

const PROXY_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'egress-proxy.mjs');

/**
 * Hosts a sandbox with an allowlist reaches by default: the package registries
 * and source hosts a build needs. HARNESS_SANDBOX_ALLOW_HOSTS replaces the list.
 */
export const DEFAULT_ALLOW_HOSTS = [
  'registry.npmjs.org', 'registry.yarnpkg.com', 'pypi.org', 'files.pythonhosted.org',
  'proxy.golang.org', 'sum.golang.org', 'crates.io', 'index.crates.io', 'static.crates.io',
  'repo.maven.apache.org', 'repo1.maven.org', 'services.gradle.org', 'plugins.gradle.org',
  'rubygems.org', 'index.rubygems.org', 'github.com', 'codeload.github.com', 'objects.githubusercontent.com', 'raw.githubusercontent.com',
];

export function defaultAllowHosts(): string[] {
  const env = process.env.HARNESS_SANDBOX_ALLOW_HOSTS;
  return env !== undefined ? env.split(',').map((h) => h.trim()).filter(Boolean) : DEFAULT_ALLOW_HOSTS;
}

/**
 * One allowlist entry, normalized, or undefined if it is not one: "host",
 * "host:port", "*.domain", optionally followed by the methods it allows
 * ("example.com GET,HEAD", or "example.com read-only"). Methods hold only for
 * plain http:// and credential routes; over HTTPS such a host is refused (see egress-proxy.mjs).
 */
export function cleanAllowEntry(entry: string): string | undefined {
  const [host = '', methods, extra] = entry.trim().split(/\s+/);
  const h = host.toLowerCase();
  if (extra !== undefined || !/^(\*\.)?[a-z0-9.-]+(:\d{1,5})?$/.test(h)) return undefined;
  if (methods === undefined) return h;
  if (/^read-?only$/i.test(methods)) return `${h} GET,HEAD,OPTIONS`;
  const m = methods.toUpperCase().split(',');
  return m.every((x) => HTTP_METHODS.has(x)) ? `${h} ${[...new Set(m)].join(',')}` : undefined;
}

const HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE', 'TRACE']);

/**
 * A stronger isolation runtime for sandbox containers (HARNESS_SANDBOX_RUNTIME):
 * gVisor's runsc, Kata Containers, any OCI runtime registered with Docker. The
 * name is checked to be a runtime name before it reaches docker's command line.
 */
export function sandboxRuntime(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const r = env.HARNESS_SANDBOX_RUNTIME?.trim();
  if (!r) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(r)) throw new Error(`HARNESS_SANDBOX_RUNTIME "${r}" is not a runtime name (letters, digits, . _ -), e.g. runsc for gVisor or kata-runtime for Kata Containers.`);
  return r;
}

const runtimeChecks = new Map<string, Promise<void>>();
/**
 * Fails with a clear message when Docker does not have the runtime (asked once per
 * name; a failure is asked again next time, after the operator has installed it).
 */
export function checkSandboxRuntime(name: string): Promise<void> {
  let p = runtimeChecks.get(name);
  if (!p) {
    p = (async () => {
      const r = await run('docker', ['info', '--format', '{{json .Runtimes}}'], { timeoutMs: 15_000 });
      if (r.code !== 0) throw new Error(`cannot ask Docker which runtimes it has: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
      let have: string[];
      try { have = Object.keys(JSON.parse(r.stdout.trim()) ?? {}); } catch { throw new Error(`Docker did not list its runtimes: ${r.stdout.trim().slice(0, 200)}`); }
      if (!have.includes(name)) throw new Error(`The sandbox runtime "${name}" (HARNESS_SANDBOX_RUNTIME) is not installed in Docker; it has: ${have.join(', ') || 'none'}. Install it (gVisor: runsc install, then restart Docker) or unset HARNESS_SANDBOX_RUNTIME.`);
    })();
    p.catch(() => runtimeChecks.delete(name));
    runtimeChecks.set(name, p);
  }
  return p;
}

export interface EgressEvent { host: string; port: number; allowed: boolean; why?: string }

// One container per session. The workspace is a host directory mounted at
// /workspace; the container has no network by default, drops every
// capability, and is limited in memory, CPU and process count. File tools work
// on the host directory (with symlink-safe path checks); only commands run in
// the container.

export interface DockerOptions {
  image: string;
  /** none: no network; full: the default bridge; allowlist: only the hosts in policyFile, through a proxy. */
  network: 'none' | 'full' | 'allowlist';
  memory: string;
  cpus: string;
  /** An OCI runtime for the sandbox (and setup) containers: runsc (gVisor), kata-runtime... Default: Docker's (runc). */
  runtime?: string;
  /** allowlist: the JSON policy file ({ hosts: [...] }) the proxy reads; edit it to change the list live. */
  policyFile?: string;
  /** allowlist: called for every connection the proxy decides (blocked ones are worth telling the user). */
  onEgress?: (e: EgressEvent) => void;
  /** allowlist: API credentials the proxy adds to requests through it; the sandbox only sees base URLs and placeholders. */
  credentials?: SandboxCredential[];
  /**
   * A setup script: run once when the sandbox is created, as root with the network
   * open, in a throwaway container with the workspace mounted. What it installs
   * outside the workspace is kept as a snapshot image (by base image and script) and
   * reused for SNAPSHOT_DAYS; the script runs again on top of it (idempotent installs
   * are then quick). The session's own container starts from the result.
   */
  setup?: { script: string; /** Who the snapshot belongs to (account and repository): it is never reused beyond them. */ scope?: string; onLog?: (line: string) => void };
  /**
   * The workspace is a git worktree: its git data lives in the repository's .git,
   * outside the mount. That .git is mounted read-only at /repo.git with only what
   * committing on the session's branch needs made writable (never hooks or config),
   * and git is pointed at it.
   */
  gitWorktree?: { commonDir: string; name: string };
}

/** Mounts and environment for a worktree's git data (see DockerOptions.gitWorktree). */
export function worktreeMounts(w: { commonDir: string; name: string }): string[] {
  const rel = (p: string) => path.relative(w.commonDir, p).split(path.sep).join('/');
  return [
    '-v', `${w.commonDir}:/repo.git:ro`,
    ...worktreeWritable(w).flatMap((p) => ['-v', `${p}:/repo.git/${rel(p)}`]),
    '-e', `GIT_DIR=/repo.git/worktrees/${w.name}`, '-e', 'GIT_WORK_TREE=/workspace',
  ];
}

const SNAPSHOT_DAYS = Number(process.env.HARNESS_SNAPSHOT_DAYS ?? 7);
const SETUP_TIMEOUT_MS = Number(process.env.HARNESS_SETUP_TIMEOUT_S ?? 900) * 1000;

/**
 * The snapshot image for a base image, a setup script and its scope. The scope (the
 * account and repository) is part of the key: setup runs as root over a workspace,
 * so a snapshot made over one person's repository is never another's starting point.
 */
export function snapshotTag(image: string, script: string, scope = ''): string {
  return `harness-env:${crypto.createHash('sha256').update(`${image}\n${scope}\n${script}`).digest('hex').slice(0, 16)}`;
}

/** When an image was made (its label), or undefined if it does not exist. */
async function imageMadeAt(tag: string): Promise<number | undefined> {
  const r = await run('docker', ['image', 'inspect', tag, '--format', '{{index .Config.Labels "harness-env.created"}}'], { timeoutMs: 15_000 });
  return r.code === 0 ? Number(r.stdout.trim()) || 0 : undefined;
}

/** Removes snapshots past their age (they are rebuilt on next use). */
export async function pruneSnapshots(now = Date.now()): Promise<string[]> {
  const r = await run('docker', ['images', 'harness-env', '--format', '{{.Repository}}:{{.Tag}}'], { timeoutMs: 15_000 });
  const gone: string[] = [];
  for (const tag of r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
    const at = await imageMadeAt(tag);
    if (at !== undefined && now - at > SNAPSHOT_DAYS * 86_400_000) {
      if ((await run('docker', ['rmi', tag], { timeoutMs: 60_000 })).code === 0) gone.push(tag);
    }
  }
  return gone;
}

/** Which images have which programs (asked once per image and set of names). */
const imageCommands = new Map<string, Promise<boolean>>();
export function imageHasCommands(image: string, names: string[]): Promise<boolean> {
  const safe = names.filter((n) => /^[\w.+-]+$/.test(n));
  const key = `${image}\n${safe.join(' ')}`;
  let p = imageCommands.get(key);
  if (!p) {
    p = run('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'sh', image, '-c', safe.map((n) => `command -v ${n} >/dev/null`).join(' && ')], { timeoutMs: 60_000 })
      .then((r) => r.code === 0, () => false);
    imageCommands.set(key, p);
  }
  return p;
}

export const dockerDefaults = (): DockerOptions => ({
  image: process.env.HARNESS_SANDBOX_IMAGE || 'harness-sandbox:latest',
  network: 'none',
  memory: process.env.HARNESS_SANDBOX_MEMORY || '4g',
  cpus: process.env.HARNESS_SANDBOX_CPUS || '2',
  ...(process.env.HARNESS_SANDBOX_RUNTIME?.trim() ? { runtime: process.env.HARNESS_SANDBOX_RUNTIME.trim() } : {}),
});

/** `--runtime <name>` for docker run, after checking the name and that Docker has it. */
export async function runtimeArgs(runtime: string | undefined): Promise<string[]> {
  if (!runtime) return [];
  const name = sandboxRuntime({ HARNESS_SANDBOX_RUNTIME: runtime })!;
  await checkSandboxRuntime(name);
  return ['--runtime', name];
}

/**
 * The images a session may ask for: the default and the operator's
 * HARNESS_SANDBOX_IMAGES (comma-separated, e.g. harness-sandbox-3d:latest for
 * Blender and Godot). Never an image named by the agent or the browser alone.
 */
export function allowedImages(env: NodeJS.ProcessEnv = process.env): string[] {
  const def = env.HARNESS_SANDBOX_IMAGE || 'harness-sandbox:latest';
  return [...new Set([def, ...(env.HARNESS_SANDBOX_IMAGES ?? '').split(',').map((s) => s.trim()).filter(Boolean)])];
}

/** The image for a session that asked for `image` (undefined: the default); throws if it is not allowed. */
export function sessionImage(image: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const allowed = allowedImages(env);
  if (!image) return allowed[0]!;
  if (!allowed.includes(image)) throw new Error(`Sandbox image ${image} is not allowed on this server (allowed: ${allowed.join(', ')}; the operator adds images with HARNESS_SANDBOX_IMAGES).`);
  return image;
}

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
  networkPolicy: 'none' | 'full' | 'allowlist';
  private name: string;
  private netName: string;
  private proxyName: string;
  private logs?: ReturnType<typeof spawn>;
  private opts: DockerOptions;
  private ready: Promise<void> | undefined;

  constructor(sessionId: string, root: string, opts: DockerOptions) {
    this.root = root;
    this.opts = opts;
    this.networkPolicy = opts.network;
    this.name = `harness-${sessionId}`;
    this.netName = `harness-net-${sessionId}`;
    this.proxyName = `harness-egress-${sessionId}`;
  }

  /**
   * The allowlist network: an internal Docker network (no route out) holding the
   * sandbox and a proxy container that is also on the default bridge. The proxy
   * is the only way out, and it reads the policy file on every connection.
   */
  private async startEgress(): Promise<void> {
    if (!this.opts.policyFile) throw new Error('allowlist network needs a policy file');
    const policyDir = path.dirname(this.opts.policyFile);
    await fs.mkdir(policyDir, { recursive: true });
    if (!(await fs.stat(this.opts.policyFile).catch(() => null))) await fs.writeFile(this.opts.policyFile, JSON.stringify({ hosts: defaultAllowHosts() }));
    const net = await run('docker', ['network', 'inspect', this.netName], { timeoutMs: 15_000 });
    if (net.code !== 0) {
      // --internal: no route out. inhibit_ipv4: the host has no address on it either,
      // so the sandbox cannot reach services on the host past the proxy.
      const c = await run('docker', ['network', 'create', '--internal', '-o', 'com.docker.network.bridge.inhibit_ipv4=true', '--label', 'harness-web=1', this.netName], { timeoutMs: 30_000 });
      if (c.code !== 0) throw new Error(`could not create the sandbox network: ${c.stderr.trim()}`);
    }
    const state = await run('docker', ['inspect', '-f', '{{.State.Running}}', this.proxyName], { timeoutMs: 15_000 });
    if (state.code !== 0 || state.stdout.trim() !== 'true') {
      await run('docker', ['rm', '-f', this.proxyName], { timeoutMs: 15_000 });
      const upstream = process.env.HARNESS_SANDBOX_UPSTREAM_PROXY;
      // The keys go to the proxy container only, in a file beside the policy (never mounted into the sandbox).
      const creds = this.opts.credentials ?? [];
      const credDir = path.join(path.dirname(policyDir), 'egress-credentials');
      if (creds.length) {
        await fs.mkdir(credDir, { recursive: true, mode: 0o700 });
        await fs.writeFile(path.join(credDir, 'credentials.json'), proxyCredentialFile(creds), { mode: 0o600 });
      }
      const r = await run('docker', [
        'run', '-d', '--init', '--name', this.proxyName, '--network', 'bridge',
        '--memory', '256m', '--cpus', '0.5', '--pids-limit', '128', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only',
        '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        '-v', `${PROXY_SCRIPT}:/egress-proxy.mjs:ro`, '-v', `${policyDir}:/policy:ro`,
        ...(creds.length ? ['-v', `${credDir}:/secrets:ro`, '-e', 'CREDENTIALS_FILE=/secrets/credentials.json'] : []),
        '-e', `ALLOW_FILE=/policy/${path.basename(this.opts.policyFile)}`, ...(upstream ? ['-e', `UPSTREAM_PROXY=${upstream}`] : []),
        '--label', 'harness-web=1', this.opts.image, 'node', '/egress-proxy.mjs',
      ], { timeoutMs: 120_000 });
      if (r.code !== 0) throw new Error(`could not start the network proxy: ${(r.stderr || r.stdout).trim()}`);
      const c = await run('docker', ['network', 'connect', '--alias', 'egress', this.netName, this.proxyName], { timeoutMs: 30_000 });
      if (c.code !== 0) throw new Error(`could not attach the network proxy: ${c.stderr.trim()}`);      // Commands start only once the proxy listens, or their first request fails.
      for (let i = 0; i < 50; i++) {
        const l = await run('docker', ['logs', this.proxyName], { timeoutMs: 10_000 });
        if (l.stdout.includes('"kind":"ready"')) break;
        if (i === 49) throw new Error(`the network proxy did not start: ${(l.stdout + l.stderr).trim().slice(-300)}`);
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    this.watchEgress();
  }

  private watchEgress(): void {
    if (this.logs || !this.opts.onEgress) return;
    const p = spawn('docker', ['logs', '-f', '--since', '0s', this.proxyName], { stdio: ['ignore', 'pipe', 'ignore'] });
    this.logs = p;
    readline.createInterface({ input: p.stdout! }).on('line', (line) => {
      try {
        const e = JSON.parse(line) as { kind?: string; host?: string; port?: number; allowed?: boolean; why?: string };
        if (e.kind === 'connect' || e.kind === 'http') this.opts.onEgress!({ host: e.host ?? '', port: e.port ?? 0, allowed: !!e.allowed, why: e.why });
      } catch { /* not ours */ }
    });
    p.on('exit', () => { if (this.logs === p) this.logs = undefined; });
  }

  private ensure(): Promise<void> {
    this.ready ??= this.start().catch((e) => { this.ready = undefined; throw e; });
    return this.ready;
  }

  private async start(): Promise<void> {
    // Before anything runs: a runtime the operator asked for that is not there is an error, never runc instead.
    const rt = await runtimeArgs(this.opts.runtime);
    if (this.opts.network === 'allowlist') await this.startEgress();
    const state = await run('docker', ['inspect', '-f', '{{.State.Running}}', this.name], { timeoutMs: 15_000 });
    if (state.code === 0 && state.stdout.trim() === 'true') return;
    if (state.code === 0) {
      const s = await run('docker', ['start', this.name], { timeoutMs: 30_000 });
      if (s.code === 0) return;
      await run('docker', ['rm', '-f', this.name], { timeoutMs: 15_000 });
    }
    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? 1000;
    const image = this.opts.setup?.script.trim() ? await this.runSetup(uid, gid, rt) : this.opts.image;
    const allowlist = this.opts.network === 'allowlist';
    const proxyEnv = allowlist
      ? ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'].flatMap((k) => ['-e', `${k}=http://egress:3128`]).concat(['-e', 'NO_PROXY=localhost,127.0.0.1,egress', '-e', 'no_proxy=localhost,127.0.0.1,egress', '-e', 'NODE_USE_ENV_PROXY=1'])
      : [];
    // Base URLs to the credential gateway and placeholder keys; the real ones never enter.
    const credEnv = allowlist ? (this.opts.credentials ?? []).flatMap((c) => Object.entries(c.env).flatMap(([k, v]) => ['-e', `${k}=${v}`])) : [];
    const args = [
      'run', '-d', '--init', '--name', this.name, ...rt,
      '--network', allowlist ? this.netName : this.opts.network === 'full' ? 'bridge' : 'none',
      ...proxyEnv, ...credEnv,
      '--memory', this.opts.memory, '--cpus', this.opts.cpus, '--pids-limit', '512',
      // Browsers in the sandbox (the desktop image, Chromium for render) need more shared memory than Docker's 64 MB.
      '--shm-size', process.env.HARNESS_SANDBOX_SHM || '512m',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--user', `${uid}:${gid}`,
      '-e', 'HOME=/tmp/home', '-e', 'CI=1',
      '-v', `${this.root}:/workspace`, '-w', '/workspace',
      ...(this.opts.gitWorktree ? worktreeMounts(this.opts.gitWorktree) : []),
      '--label', 'harness-web=1',
      image, 'sleep', 'infinity',
    ];
    const r = await run('docker', args, { timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(`could not start the sandbox container: ${(r.stderr || r.stdout).trim()}`);
    await run('docker', ['exec', this.name, 'mkdir', '-p', '/tmp/home'], { timeoutMs: 15_000 });
  }

  /**
   * Runs the setup script and returns the image the session starts from: the
   * refreshed snapshot when it succeeded, else the base image (the session still
   * works; the failure is in the log the agent can read). The log goes to
   * .harness/setup.log in the workspace.
   */
  private async runSetup(uid: number, gid: number, rt: string[] = []): Promise<string> {
    const script = this.opts.setup!.script;
    const tag = snapshotTag(this.opts.image, script, this.opts.setup!.scope);
    const log = (l: string) => this.opts.setup!.onLog?.(l);
    void pruneSnapshots().catch(() => {});
    const made = await imageMadeAt(tag);
    const fresh = made !== undefined && Date.now() - made <= SNAPSHOT_DAYS * 86_400_000;
    const from = fresh ? tag : this.opts.image;
    log(fresh ? `setup: starting from the snapshot ${tag}` : 'setup: no snapshot yet, starting from the base image');
    const name = `harness-setup-${this.name.replace(/^harness-/, '')}`;
    await run('docker', ['rm', '-f', name], { timeoutMs: 15_000 });
    // As root with the network open, as cloud harnesses run setup; then the workspace
    // is handed back to the session's user, whatever the script did. The log is written
    // inside the container, so a link planted in the workspace resolves there and never
    // on the server; whatever .harness/setup.log was is replaced.
    const logFile = '/workspace/.harness/setup.log';
    const wrapped = [
      '[ -L /workspace/.harness ] && rm -f /workspace/.harness', 'mkdir -p /workspace/.harness', `rm -rf ${logFile}`,
      `(${script}\n) 2>&1 | tee ${logFile}; rc=\${PIPESTATUS[0]}`, `printf '\\nexit %s\\n' "$rc" >> ${logFile}`,
      `chown -R ${uid}:${gid} /workspace /tmp/home 2>/dev/null; exit $rc`,
    ].join('; ');
    const r = await run('docker', [
      'run', '--name', name, ...rt, '--network', 'bridge', '--user', '0:0', '--security-opt', 'no-new-privileges',
      '--memory', this.opts.memory, '--cpus', this.opts.cpus, '--pids-limit', '1024',
      '-e', 'HOME=/tmp/home', '-e', 'CI=1', '-e', 'DEBIAN_FRONTEND=noninteractive',
      '-v', `${this.root}:/workspace`, '-w', '/workspace', '--label', 'harness-web=1',
      from, 'bash', '-lc', `mkdir -p /tmp/home; ${wrapped}`,
    ], { timeoutMs: SETUP_TIMEOUT_MS });
    let image = from;
    if (r.code === 0) {
      const c = await run('docker', ['commit', '--change', `LABEL harness-env.created=${Date.now()}`, '--change', 'USER root', name, tag], { timeoutMs: 300_000 });
      if (c.code === 0) image = tag;
      log(c.code === 0 ? `setup: done; snapshot ${tag} saved` : `setup: done, but the snapshot could not be saved: ${c.stderr.trim().slice(0, 300)}`);
    } else {
      log(`setup: the script failed (exit ${r.code}${r.timedOut ? ', timed out' : ''}); the session starts without it. See .harness/setup.log`);
    }
    await run('docker', ['rm', '-f', name], { timeoutMs: 30_000 });
    this.setupResult = { ok: r.code === 0, image };
    return image;
  }

  /** How setup went, once the sandbox has started (for the agent's environment note). */
  setupResult?: { ok: boolean; image: string };

  async exec(cmd: string, opts: ExecOptions): Promise<ExecResult> {
    await this.ensure();
    const secs = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
    const workdir = opts.cwd ?? '/workspace';
    // `timeout` inside the container kills the command itself; killing the
    // docker CLI alone would leave it running.
    // Vault values: `-e NAME` with no value makes the docker CLI copy it from its own environment,
    // so a value is never in a process's arguments (ps on the server shows those).
    const secretArgs = Object.keys(opts.secretEnv ?? {}).flatMap((k) => ['-e', k]);
    const env = opts.secretEnv && Object.keys(opts.secretEnv).length ? { ...(opts.env ?? process.env), ...opts.secretEnv } : opts.env;
    const r = await run('docker', ['exec', '-i', ...secretArgs, '-w', workdir, this.name, 'timeout', '-k', '5', String(secs), 'bash', '-lc', cmd], { ...opts, env, timeoutMs: opts.timeoutMs + 15_000 });
    if (r.code === 124) r.timedOut = true;
    return r;
  }

  async spawnStream(command: string, args: string[], env: Record<string, string>): Promise<ChildProcessWithoutNullStreams> {
    await this.ensure();
    const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    return spawn('docker', ['exec', '-i', ...envArgs, '-w', '/workspace', this.name, command, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  }

  hasCommands(names: string[]): Promise<boolean> { return imageHasCommands(this.opts.image, names); }

  /** For the agent's environment note: a setup script prepares this sandbox. */
  get hasSetup(): boolean { return !!this.opts.setup?.script.trim(); }

  credentialEnv(): { name: string; vars: string[]; writes: boolean }[] {
    return this.opts.network === 'allowlist' ? credentialSummary(this.opts.credentials ?? []) : [];
  }

  async allowedHosts(): Promise<string[]> {
    if (!this.opts.policyFile) return [];
    try { return (JSON.parse(await fs.readFile(this.opts.policyFile, 'utf8')) as { hosts?: string[] }).hosts ?? []; } catch { return defaultAllowHosts(); }
  }

  /** Stops the container (it restarts on next use); the workspace stays. */
  async stop(): Promise<void> {
    this.ready = undefined;
    this.logs?.kill();
    await run('docker', ['stop', '-t', '2', this.name], { timeoutMs: 30_000 });
    if (this.opts.network === 'allowlist') await run('docker', ['stop', '-t', '1', this.proxyName], { timeoutMs: 30_000 });
  }

  async close(): Promise<void> {
    this.ready = undefined;
    this.logs?.kill();
    await run('docker', ['rm', '-f', this.name], { timeoutMs: 30_000 });
    if (this.opts.network === 'allowlist') {
      await run('docker', ['rm', '-f', this.proxyName], { timeoutMs: 30_000 });
      await run('docker', ['network', 'rm', this.netName], { timeoutMs: 30_000 });
      if (this.opts.policyFile) await fs.rm(path.join(path.dirname(path.dirname(this.opts.policyFile)), 'egress-credentials'), { recursive: true, force: true });
    }
  }
}
