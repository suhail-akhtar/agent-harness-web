/**
 * Starts, watches and stops the harness server (the engine) in an Electron utility process.
 *
 * Local mode: the server's own entry (src/server/main.ts, run from source: Electron's Node strips
 * TypeScript types) on 127.0.0.1 with a free port and a random token, its data folder in the app's
 * user data, and the projects the person opened as its local roots. `ready()` resolves once the
 * server answers; an unexpected exit restarts it with backoff, and the last log lines are kept so
 * the engine gate shows the real error and a Restart button instead of a spinner.
 *
 * The token never leaves main: the harness:// proxy attaches it (protocol.ts).
 */

import { utilityProcess, type UtilityProcess } from 'electron';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import { EventEmitter } from 'node:events';

export type EngineState =
  | { status: 'starting'; attempt: number }
  | { status: 'ready'; origin: string; startedAt: number; remote?: boolean }
  | { status: 'crashed'; message: string; attempt: number; retryInMs: number }
  | { status: 'stopped'; message?: string };

export interface EngineEndpoint { origin: string; token: string; remote?: boolean }

const MAX_BACKOFF_MS = 30_000;

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

/** Backoff after the n-th consecutive failure (pure, tested). */
export function backoffMs(attempt: number): number { return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(Math.max(0, attempt - 1), 5)); }

export interface EngineOptions {
  entry: string;
  cwd?: string;
  /** Computed at each start (local roots change when a project is added). */
  env: () => Record<string, string>;
  execArgv?: string[];
}

export class EngineHost extends EventEmitter {
  private child: UtilityProcess | null = null;
  private endpoint: EngineEndpoint | null = null;
  private waiters: Array<(e: EngineEndpoint) => void> = [];
  private attempt = 0;
  private quitting = false;
  private log: string[] = [];
  private retryTimer: NodeJS.Timeout | null = null;
  private generation = 0;
  state: EngineState = { status: 'stopped' };
  private opts: EngineOptions;

  constructor(opts: EngineOptions) { super(); this.opts = opts; }

  /** The engine's endpoint, waiting for it if it is starting. */
  ready(timeoutMs = 90_000): Promise<EngineEndpoint> {
    if (this.endpoint) return Promise.resolve(this.endpoint);
    return new Promise((resolve, reject) => {
      const done = (e: EngineEndpoint) => { clearTimeout(timer); resolve(e); };
      const timer = setTimeout(() => { this.waiters = this.waiters.filter((w) => w !== done); reject(new Error(this.state.status === 'crashed' ? this.state.message : 'The engine did not start in time.')); }, timeoutMs);
      this.waiters.push(done);
    });
  }
  current(): EngineEndpoint | null { return this.endpoint; }
  recentLog(): string[] { return [...this.log]; }

  private push(line: string) {
    // Never keep a token in the log the window can read.
    const clean = line.replace(/(access token[^:]*:\s*)\S+/i, '$1[hidden]').replace(/(HARNESS_TOKEN=)\S+/g, '$1[hidden]');
    this.log.push(clean);
    if (this.log.length > 300) this.log.shift();
    this.emit('log', clean);
  }

  async start(): Promise<void> {
    if (this.child || this.quitting) return;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.attempt += 1;
    const gen = ++this.generation;
    this.setState({ status: 'starting', attempt: this.attempt });
    const port = await freePort();
    const token = crypto.randomBytes(24).toString('base64url');
    const origin = `http://127.0.0.1:${port}`;
    this.push(`starting the engine (attempt ${this.attempt}) on ${origin}`);
    let child: UtilityProcess;
    try {
      child = utilityProcess.fork(this.opts.entry, [], {
        serviceName: 'Harness Engine',
        stdio: 'pipe',
        cwd: this.opts.cwd ?? os.homedir(),
        execArgv: ['--disable-warning=ExperimentalWarning', '--disable-warning=UNDICI-EHPA', ...(this.opts.execArgv ?? [])],
        env: { ...process.env, NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY ?? '1', ...this.opts.env(), HARNESS_HOST: '127.0.0.1', HARNESS_PORT: String(port), HARNESS_TOKEN: token } as Record<string, string>,
      });
    } catch (e) {
      this.push(`could not start: ${(e as Error).message}`);
      this.scheduleRetry(`The engine could not start: ${(e as Error).message}`);
      return;
    }
    this.child = child;
    const capture = (chunk: Buffer) => { for (const line of chunk.toString('utf8').split(/\r?\n/)) if (line.trim()) this.push(line); };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.on('exit', (code) => {
      if (gen !== this.generation) return;
      this.child = null;
      this.endpoint = null;
      if (this.quitting) { this.setState({ status: 'stopped' }); return; }
      const tail = this.log.slice(-4).join('\n');
      this.push(`the engine exited (code ${code})`);
      this.scheduleRetry(`The engine stopped (exit code ${code}).${tail ? `\n${tail}` : ''}`);
    });
    // Ready when it answers with our token (the server prints its address; we check it really is ours).
    const deadline = Date.now() + 60_000;
    while (this.child === child && Date.now() < deadline) {
      try {
        const res = await fetch(`${origin}/api/me`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          this.endpoint = { origin, token };
          this.attempt = 0;
          this.setState({ status: 'ready', origin, startedAt: Date.now() });
          this.push('the engine is ready');
          const w = this.waiters; this.waiters = [];
          for (const f of w) f(this.endpoint);
          return;
        }
      } catch { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (this.child === child) { this.push('the engine did not answer within 60 seconds'); child.kill(); }
  }

  private scheduleRetry(message: string) {
    const retryInMs = backoffMs(this.attempt);
    this.setState({ status: 'crashed', message, attempt: this.attempt, retryInMs });
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.start(); }, retryInMs);
  }

  /** Stop and start again: the gate's Restart button, and after the local roots change. */
  async restart(): Promise<void> {
    await this.stop(false);
    this.attempt = 0;
    await this.start();
  }

  async stop(final = true): Promise<void> {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.quitting = true;
    const child = this.child;
    if (child) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve(); }, 6000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        // The server stops cleanly on SIGTERM (turns end, hooks run); kill() sends it.
        try { child.kill(); } catch { clearTimeout(timer); resolve(); }
      });
    }
    this.child = null;
    this.endpoint = null;
    this.generation++;
    this.setState({ status: 'stopped' });
    if (!final) this.quitting = false;
  }

  private setState(s: EngineState) { this.state = s; this.emit('state', s); }
}

/**
 * A remote server: the same surface as the engine host, with no process. Ready once it answers
 * with the person's token.
 */
export class RemoteEndpoint extends EventEmitter {
  state: EngineState = { status: 'stopped' };
  private endpoint: EngineEndpoint | null = null;
  private log: string[] = [];
  private url: string;
  private token: string;
  constructor(url: string, token: string) { super(); this.url = url.replace(/\/+$/, ''); this.token = token; }
  recentLog(): string[] { return [...this.log]; }
  current(): EngineEndpoint | null { return this.endpoint; }
  async start(): Promise<void> {
    this.state = { status: 'starting', attempt: 1 }; this.emit('state', this.state);
    try {
      const res = await fetch(`${this.url}/api/me`, { headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(res.status === 401 ? 'The server refused the token (401).' : `HTTP ${res.status}`);
      this.endpoint = { origin: this.url, token: this.token, remote: true };
      this.state = { status: 'ready', origin: this.url, startedAt: Date.now(), remote: true };
    } catch (e) {
      this.log.push(`${new Date().toISOString()} ${this.url}: ${(e as Error).message}`);
      this.state = { status: 'crashed', message: `Cannot reach ${this.url}: ${(e as Error).message}`, attempt: 1, retryInMs: 10_000 };
      setTimeout(() => { if (this.state.status === 'crashed') void this.start(); }, 10_000);
    }
    this.emit('state', this.state);
  }
  async ready(timeoutMs = 30_000): Promise<EngineEndpoint> {
    const until = Date.now() + timeoutMs;
    while (!this.endpoint && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
    if (!this.endpoint) throw new Error(this.state.status === 'crashed' ? this.state.message : 'The server is not reachable.');
    return this.endpoint;
  }
  async restart(): Promise<void> { this.endpoint = null; await this.start(); }
  async stop(): Promise<void> { this.endpoint = null; this.state = { status: 'stopped' }; this.emit('state', this.state); }
}

export type Engine = EngineHost | RemoteEndpoint;
