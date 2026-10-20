import type { ChildProcessWithoutNullStreams } from 'node:child_process';

// A Model Context Protocol client: JSON-RPC 2.0 over stdio (newline-delimited)
// or streamable HTTP (POST, JSON or SSE response, Mcp-Session-Id). It implements
// what a harness needs: initialize, tools/list (paged), tools/call.

export const MCP_PROTOCOL_VERSION = '2025-06-18';

type Msg = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };

export interface Transport {
  send(msg: Msg): Promise<void>;
  onMessage(cb: (msg: Msg) => void): void;
  onClose(cb: (reason: string) => void): void;
  close(): Promise<void>;
}

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
  async send(msg: Msg) { this.child.stdin.write(JSON.stringify(msg) + '\n'); }
  onMessage(cb: (m: Msg) => void) { this.handlers.push(cb); }
  onClose(cb: (r: string) => void) { this.closers.push(cb); }
  async close() { try { this.child.stdin.end(); this.child.kill('SIGTERM'); } catch { /* gone */ } }
}

export class HttpTransport implements Transport {
  private url: string;
  private headers: Record<string, string>;
  private sessionId?: string;
  private protocol?: string;
  private handlers: ((m: Msg) => void)[] = [];
  private closers: ((r: string) => void)[] = [];
  constructor(url: string, headers: Record<string, string> = {}) {
    this.url = url;
    this.headers = headers;
  }
  async send(msg: Msg) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        ...(this.protocol ? { 'mcp-protocol-version': this.protocol } : {}),
        ...this.headers,
      },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(120_000),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (res.status === 202 || res.status === 204) return;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (msg.id !== undefined) this.deliver({ jsonrpc: '2.0', id: msg.id, error: { code: res.status, message: `HTTP ${res.status}: ${text.slice(0, 300)}` } });
      return;
    }
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream')) {
      const text = await res.text();
      for (const block of text.split(/\n\n/)) {
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (data) { try { this.deliver(JSON.parse(data)); } catch { /* keep-alive */ } }
      }
    } else {
      const body = await res.json().catch(() => undefined);
      for (const m of Array.isArray(body) ? body : body ? [body] : []) this.deliver(m as Msg);
    }
  }
  setProtocol(v: string) { this.protocol = v; }
  private deliver(m: Msg) { for (const h of this.handlers) h(m); }
  onMessage(cb: (m: Msg) => void) { this.handlers.push(cb); }
  onClose(cb: (r: string) => void) { this.closers.push(cb); }
  async close() {
    if (this.sessionId) await fetch(this.url, { method: 'DELETE', headers: { 'mcp-session-id': this.sessionId, ...this.headers } }).catch(() => {});
    for (const c of this.closers) c('closed');
  }
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

export interface McpContent { type: string; text?: string; data?: string; mimeType?: string; resource?: { text?: string; uri?: string; mimeType?: string } }
export interface McpCallResult { content?: McpContent[]; isError?: boolean; structuredContent?: unknown }

export class McpClient {
  private transport: Transport;
  private nextId = 1;
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout }>();
  private closedReason?: string;
  serverInfo?: { name?: string; version?: string };
  instructions?: string;

  constructor(transport: Transport) {
    this.transport = transport;
    transport.onMessage((m) => {
      if (m.id !== undefined && (m.result !== undefined || m.error)) {
        const p = this.pending.get(Number(m.id));
        if (!p) return;
        this.pending.delete(Number(m.id));
        clearTimeout(p.timer);
        if (m.error) p.reject(new Error(`MCP error ${m.error.code}: ${m.error.message}`));
        else p.resolve(m.result);
      } else if (m.method && m.id !== undefined) {
        // Server-to-client requests (sampling, roots, elicitation) are not offered.
        void this.transport.send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not supported by this client' } }).catch(() => {});
      }
    });
    transport.onClose((reason) => {
      this.closedReason = reason;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(`MCP server closed: ${reason}`)); }
      this.pending.clear();
    });
  }

  request<T>(method: string, params: unknown, timeoutMs = 60_000, signal?: AbortSignal): Promise<T> {
    if (this.closedReason) return Promise.reject(new Error(`MCP server is not running: ${this.closedReason}`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP ${method} timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      signal?.addEventListener('abort', () => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        void this.transport.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'aborted' } }).catch(() => {});
        reject(new Error('aborted'));
      }, { once: true });
      this.transport.send({ jsonrpc: '2.0', id, method, params }).catch((e) => { this.pending.delete(id); clearTimeout(timer); reject(e); });
    });
  }

  async initialize(): Promise<void> {
    const r = await this.request<{ protocolVersion?: string; serverInfo?: { name?: string; version?: string }; instructions?: string }>('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'harness-web', version: '0.2.0' },
    }, 30_000);
    this.serverInfo = r.serverInfo;
    this.instructions = r.instructions;
    if (this.transport instanceof HttpTransport && r.protocolVersion) this.transport.setProtocol(r.protocolVersion);
    await this.transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async listTools(): Promise<McpTool[]> {
    const out: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const r = await this.request<{ tools: McpTool[]; nextCursor?: string }>('tools/list', cursor ? { cursor } : {});
      out.push(...(r.tools ?? []));
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    return this.request<McpCallResult>('tools/call', { name, arguments: args }, 10 * 60_000, signal);
  }

  close(): Promise<void> { return this.transport.close(); }
}
