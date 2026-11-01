import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { Client, StreamableHTTPClientTransport, type FetchLike, type OAuthClientProvider, type Transport as SdkTransport } from '@modelcontextprotocol/client';

// A Model Context Protocol client, on the official TypeScript SDK (@modelcontextprotocol/client): both eras of the
// protocol (2026-07-28, stateless with server/discover, and the 2025 initialize handshake, found by probing),
// tools (paged, with list_changed), resources, prompts, progress, cancellation and OAuth for HTTP servers. The
// harness's own transports carry it where a server's process runs somewhere the SDK cannot start it (a
// sandbox, a companion on the person's computer, a scrubbed environment); HTTP is the SDK's transport.

export const MCP_PROTOCOL_VERSION = '2026-07-28';
const CLIENT_INFO = { name: 'harness', version: '0.3.0' };

type Msg = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };

export interface SendOptions { timeoutMs?: number; signal?: AbortSignal }

/** The harness's own transport shape (a process's stdio, a companion relay). */
export interface Transport {
  send(msg: Msg, opts?: SendOptions): Promise<void>;
  onMessage(cb: (msg: Msg) => void): void;
  onClose(cb: (reason: string) => void): void;
  close(): Promise<void>;
}

/** A server process's stdio: newline-delimited JSON-RPC; stray stdout lines are ignored, the last stderr kept. */
export class StdioTransport implements Transport {
  private child: ChildProcessWithoutNullStreams;
  private handlers: ((m: Msg) => void)[] = [];
  private closers: ((r: string) => void)[] = [];
  private buf = '';
  stderr = '';
  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      this.buf += d;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        try { const m = JSON.parse(line) as Msg; for (const h of this.handlers) h(m); } catch { /* a server logging to stdout */ }
      }
    });
    child.stderr.on('data', (d: Buffer) => { this.stderr = (this.stderr + d.toString()).slice(-4000); });
    child.on('exit', (code) => { for (const c of this.closers) c(`process exited (${code})${this.stderr ? `: ${this.stderr.trim().split('\n').pop()}` : ''}`); });
    child.on('error', (e) => { for (const c of this.closers) c(e.message); });
    child.stdin.on('error', () => {});
  }
  async send(msg: Msg, _opts?: SendOptions) { this.child.stdin.write(JSON.stringify(msg) + '\n'); }
  onMessage(cb: (m: Msg) => void) { this.handlers.push(cb); }
  onClose(cb: (r: string) => void) { this.closers.push(cb); }
  async close() { try { this.child.stdin.end(); this.child.kill('SIGTERM'); } catch { /* gone */ } }
}

/** Streamable HTTP (the SDK's): sessions, SSE, reconnection; OAuth through `authProvider`; every request through `fetch`. */
export class HttpTransport extends StreamableHTTPClientTransport {
  constructor(url: string, headers: Record<string, string> = {}, o: { fetch?: FetchLike; authProvider?: OAuthClientProvider } = {}) {
    super(new URL(url), { requestInit: { headers }, ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.authProvider ? { authProvider: o.authProvider } : {}) });
  }
}

/** One of the harness's transports, as the SDK's (start, send, close and the three callbacks). */
function adapt(t: Transport): SdkTransport & { closedReason?: string } {
  const sdk: SdkTransport & { closedReason?: string } = {
    async start() { /* already running */ },
    async send(message) { await t.send(message as Msg); },
    async close() { await t.close(); },
  };
  t.onMessage((m) => sdk.onmessage?.(m as never));
  t.onClose((reason) => { sdk.closedReason = reason; sdk.onclose?.(); });
  return sdk;
}
const isSdk = (t: Transport | SdkTransport): t is SdkTransport => typeof (t as SdkTransport).start === 'function';

/**
 * What servers leave out that the spec has a safe default for, filled in on the way in, so a server that is
 * nearly right still works (the SDK validates strictly): a missing tools capability, a server's missing version or name, a tool without
 * an input schema (no arguments), an input schema without its "object" type. Nothing else is changed.
 */
function tolerant(m: Record<string, unknown>): Record<string, unknown> {
  const r = m.result as Record<string, unknown> | undefined;
  if (!r || typeof r !== 'object') return m;
  // An initialize answer without the tools capability: tools are assumed (a server that has none answers the list empty or with an error).
  if (typeof r.protocolVersion === 'string' && r.capabilities && typeof r.capabilities === 'object' && !(r.capabilities as Record<string, unknown>).tools) (r.capabilities as Record<string, unknown>).tools = {};
  const info = r.serverInfo as Record<string, unknown> | undefined;
  if (info && typeof info === 'object') {
    if (typeof info.version !== 'string') info.version = '0';
    if (typeof info.name !== 'string') info.name = 'server';
  }
  if (Array.isArray(r.tools)) {
    for (const t of r.tools as Array<Record<string, unknown>>) {
      if (!t || typeof t !== 'object') continue;
      const s = t.inputSchema as Record<string, unknown> | undefined;
      if (!s || typeof s !== 'object') t.inputSchema = { type: 'object' };
      else if (s.type === undefined) s.type = 'object';
    }
  }
  return m;
}

/** A transport whose incoming messages pass through tolerant() (the same transport underneath). */
function tolerate(inner: SdkTransport & { closedReason?: string }): SdkTransport & { closedReason?: string; inner: SdkTransport } {
  const outer = {
    inner,
    start: () => inner.start(),
    send: (m: Parameters<SdkTransport['send']>[0], o?: Parameters<SdkTransport['send']>[1]) => inner.send(m, o),
    close: () => inner.close(),
    get sessionId() { return inner.sessionId; },
    get closedReason() { return inner.closedReason; },
    setProtocolVersion: (v: string) => inner.setProtocolVersion?.(v),
    setSupportedProtocolVersions: (v: string[]) => inner.setSupportedProtocolVersions?.(v),
  } as SdkTransport & { closedReason?: string; inner: SdkTransport };
  inner.onmessage = (m, extra) => outer.onmessage?.(tolerant(m as Record<string, unknown>) as never, extra);
  inner.onclose = () => outer.onclose?.();
  inner.onerror = (e) => outer.onerror?.(e);
  return outer;
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
  outputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean; title?: string };
}

export interface McpContent { type: string; text?: string; data?: string; mimeType?: string; uri?: string; name?: string; resource?: { text?: string; uri?: string; mimeType?: string; blob?: string } }
export interface McpCallResult { content?: McpContent[]; isError?: boolean; structuredContent?: unknown }
export interface McpResource { uri: string; name?: string; title?: string; description?: string; mimeType?: string }
export interface McpPrompt { name: string; title?: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }

export class McpClient {
  readonly sdk: Client;
  private transport: SdkTransport & { closedReason?: string; inner: SdkTransport };
  private closedReason?: string;
  private callTimeoutMs: number;
  private toolsChanged = new Set<() => void>();
  serverInfo?: { name?: string; version?: string };
  instructions?: string;
  /** The protocol revision agreed (2026-07-28, or a 2025 one). */
  protocol?: string;

  constructor(transport: Transport | SdkTransport, opts: { callTimeoutMs?: number; legacy?: boolean } = {}) {
    this.transport = tolerate(isSdk(transport) ? transport : adapt(transport));
    this.callTimeoutMs = opts.callTimeoutMs ?? 10 * 60_000;
    this.sdk = new Client(CLIENT_INFO, {
      capabilities: {},
      // A 2026 server is used as one, a 2025 one through initialize (probed: server/discover first).
      versionNegotiation: { mode: opts.legacy ? 'legacy' : 'auto', probe: { timeoutMs: 10_000 } },
      // A server that changes its tools says so: whoever holds this client hears it (and re-checks them).
      // At once, not debounced, and not re-listed by the SDK: whoever holds this client re-lists (and must know before the next call).
      listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: () => { for (const f of this.toolsChanged) f(); } } },
    });
    this.sdk.onclose = () => { this.closedReason ??= this.transport.closedReason ?? 'the connection closed'; };
  }

  async initialize(): Promise<void> {
    try {
      await this.sdk.connect(this.transport, { timeout: 30_000 } as never);
    } catch (e) {
      throw new Error(this.transport.closedReason ? `MCP server is not running: ${this.transport.closedReason}` : (e as Error).message);
    }
    this.serverInfo = this.sdk.getServerVersion();
    this.instructions = this.sdk.getInstructions();
    this.protocol = this.sdk.getNegotiatedProtocolVersion();
  }

  async listTools(): Promise<McpTool[]> {
    try { return (await this.sdk.listTools()).tools as McpTool[]; } catch (e) {
      // A server with no tools at all (it never had the capability).
      if ((e as { code?: number }).code === -32601) return [];
      throw this.explain(e, 'tools/list');
    }
  }

  /** Told when the server's tools changed (notifications/tools/list_changed). */
  onToolsChanged(cb: () => void): () => void { this.toolsChanged.add(cb); return () => this.toolsChanged.delete(cb); }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    if (this.closedReason) throw new Error(`MCP server is not running: ${this.closedReason}`);
    try {
      return await this.sdk.callTool({ name, arguments: args }, { timeout: this.callTimeoutMs, resetTimeoutOnProgress: true, ...(signal ? { signal } : {}) }) as McpCallResult;
    } catch (e) {
      throw this.explain(e, 'tools/call', signal);
    }
  }

  /** An SDK error as the harness says it: a timeout with its length, an ended HTTP session (it reconnects next time). */
  private explain(e: unknown, method: string, signal?: AbortSignal): Error {
    const err = e as Error & { code?: number; status?: number; data?: { status?: number } };
    if (signal?.aborted) return new Error('aborted');
    if (this.closedReason) return new Error(`MCP server closed: ${this.closedReason}`);
    if (err.code === -32001 || /timed? ?out/i.test(err.message ?? '')) return new Error(`MCP ${method} timed out after ${this.callTimeoutMs / 1000}s`);
    // A session the server no longer knows (HTTP 404): this client is done; the next call starts a new session.
    if ((err.status ?? err.data?.status) === 404 || /\b404\b/.test(err.message ?? '')) {
      this.closedReason = 'session expired (HTTP 404)';
      return new Error('MCP server closed: session expired (HTTP 404)');
    }
    return err instanceof Error ? err : new Error(String(e));
  }

  /** The HTTP transport underneath (for OAuth: finishAuth), when it is one. */
  get http(): HttpTransport | undefined { return this.transport.inner instanceof HttpTransport ? this.transport.inner : undefined; }

  get canListResources(): boolean { return !!this.sdk.getServerCapabilities()?.resources; }
  get canListPrompts(): boolean { return !!this.sdk.getServerCapabilities()?.prompts; }
  async listResources(): Promise<McpResource[]> { return this.canListResources ? (await this.sdk.listResources()).resources as McpResource[] : []; }
  async readResource(uri: string, signal?: AbortSignal): Promise<{ contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }> }> {
    return await this.sdk.readResource({ uri }, signal ? { signal } : undefined) as never;
  }
  async listPrompts(): Promise<McpPrompt[]> { return this.canListPrompts ? (await this.sdk.listPrompts()).prompts as McpPrompt[] : []; }
  async getPrompt(name: string, args: Record<string, string>, signal?: AbortSignal): Promise<{ description?: string; messages: Array<{ role: string; content: McpContent }> }> {
    return await this.sdk.getPrompt({ name, arguments: args }, signal ? { signal } : undefined) as never;
  }

  /** The server process exited or the HTTP session ended: this client cannot be used again. */
  get closed(): boolean { return this.closedReason !== undefined; }

  async close(): Promise<void> { await this.sdk.close().catch(() => {}); }
}
