import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { McpServerConfig } from '../plugins/api.ts';
import { scrubbedEnv, type ToolHost } from '../runtime/host.ts';
import { assertPublicUrl } from '../tools/web.ts';
import { HttpTransport, McpClient, StdioTransport, type Transport } from './client.ts';
import { type McpEntry, qualifiedName } from './tools.ts';

// Two scopes of MCP server:
//   server  - configured by the operator (plugins, HARNESS_MCP_CONFIG). Trusted:
//             ${VAR} in the config expands from the SERVER's environment, so a
//             token lives only here; stdio servers run on the server; one
//             connection is shared by every session.
//   project - the workspace's .mcp.json (Claude Code's format). Repository
//             content: nothing expands from the server's environment, stdio
//             servers run where the session's tools run (inside the sandbox),
//             and HTTP servers must be public addresses.

export interface McpStatus { name: string; scope: 'server' | 'project'; ok: boolean; tools: number; error?: string }

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE|SESSION/i;

/**
 * ${VAR} from the server's environment. A plugin's server gets a secret only if
 * the plugin declares it (permissions.secrets); the operator's own config gets any.
 */
export function expand(v: string, allowedSecrets?: string[]): string {
  return v.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, k: string) => (allowedSecrets && SECRET_NAME.test(k) && !allowedSecrets.includes(k) ? '' : process.env[k] ?? ''));
}

/** A server-scope MCP config, with who added it and the secrets it may read. */
export type ServerMcpConfig = McpServerConfig & { plugin?: string; secrets?: string[]; /** Set only by the harness for HARNESS_MCP_CONFIG: may read any variable. */ operator?: boolean };

const SHIMS = new Set(['npx', 'npm', 'pnpm', 'pnpx', 'yarn', 'corepack']);

/** Windows quoting for cmd.exe: wrap in quotes, double inner quotes, escape cmd metacharacters. */
const quoteWin = (a: string) => (/^[\w./:=@\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '""').replace(/([%^&|<>])/g, '^$1')}"`);

/**
 * How to start an MCP server's command. On Windows, npx/npm & co are .cmd shims
 * that Node refuses to spawn without a shell (EINVAL), so they go through cmd.exe
 * with their arguments quoted for it.
 */
export function spawnPlan(command: string, args: string[], platform: string = process.platform): { command: string; args: string[]; shell: boolean } {
  if (platform !== 'win32') return { command, args, shell: false };
  const base = path.win32.basename(command).toLowerCase();
  const batch = /\.(cmd|bat)$/.test(base) || (!/[\\/]/.test(command) && SHIMS.has(base));
  return batch ? { command: quoteWin(command), args: args.map(quoteWin), shell: true } : { command, args, shell: false };
}

async function connect(name: string, cfg: ServerMcpConfig, scope: 'server' | 'project', host?: ToolHost): Promise<McpClient> {
  let client: McpClient;
  const opts = { callTimeoutMs: cfg.timeoutMs };
  // The operator's own config may read any variable; anything else only what its plugin declared.
  // (A flag, not a name: a plugin called "config" once got the operator's reach.)
  const allowed = cfg.operator === true ? undefined : cfg.secrets ?? [];
  const x = (v: string) => (scope === 'server' ? expand(v, allowed) : v);
  if (cfg.type === 'http') {
    const url = x(cfg.url);
    if (scope === 'project') await assertPublicUrl(url);
    const headers = Object.fromEntries(Object.entries(cfg.headers ?? {}).map(([k, v]) => [k, x(v)]));
    client = new McpClient(new HttpTransport(url, headers), opts);
  } else {
    const args = (cfg.args ?? []).map(x);
    const env = Object.fromEntries(Object.entries(cfg.env ?? {}).map(([k, v]) => [k, x(v)]));
    const plan = spawnPlan(cfg.command, args);
    if (scope === 'project' && host?.mcpTransport) {
      // A companion: the server runs on the user's computer, its messages relayed through the companion.
      client = new McpClient(await host.mcpTransport(name, cfg.command, args, env) as unknown as Transport, opts);
    } else {
      // Never the server's whole environment: a server gets the provider keys only if its config passes them.
      const child = scope === 'server'
        ? spawn(plan.command, plan.args, { cwd: cfg.cwd, env: scrubbedEnv(env), stdio: ['pipe', 'pipe', 'pipe'], shell: plan.shell })
        : await host!.spawnStream!(cfg.command, args, env);
      client = new McpClient(new StdioTransport(child), opts);
    }
  }
  await client.initialize();
  return client;
}

/**
 * A client that reconnects when its server has gone (process exited, HTTP session
 * expired). Only BEFORE a call: a call that fails mid-way is not retried, since the
 * server may have acted on it.
 */
export class ReconnectingClient {
  private current: McpClient;
  private reconnecting?: Promise<McpClient>;
  private reconnect: () => Promise<McpClient>;
  reconnects = 0;
  constructor(first: McpClient, reconnect: () => Promise<McpClient>) {
    this.current = first;
    this.reconnect = reconnect;
  }
  private async live(): Promise<McpClient> {
    if (!this.current.closed) return this.current;
    this.reconnecting ??= this.reconnect().then((c) => { this.current = c; this.reconnects++; return c; }).finally(() => { this.reconnecting = undefined; });
    return this.reconnecting;
  }
  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    return (await this.live()).callTool(name, args, signal);
  }
  close(): Promise<void> { return this.current.close(); }
}

async function entriesOf(name: string, client: McpClient, caller: Pick<McpClient, 'callTool'> = client): Promise<McpEntry[]> {
  const tools = await client.listTools();
  return tools.map((tool) => ({ server: name, tool, client: caller, qualified: qualifiedName(name, tool.name) }));
}

export class McpManager {
  private shared = new Map<string, Promise<{ client: ReconnectingClient; entries: McpEntry[] }>>();

  /** Operator-configured servers, connected once per process. */
  async serverEntries(configs: Map<string, ServerMcpConfig>): Promise<{ entries: McpEntry[]; status: McpStatus[] }> {
    const entries: McpEntry[] = [];
    const status: McpStatus[] = [];
    for (const [name, cfg] of configs) {
      let p = this.shared.get(name);
      if (!p) {
        p = connect(name, cfg, 'server').then(async (first) => {
          const client = new ReconnectingClient(first, () => connect(name, cfg, 'server'));
          return { client, entries: await entriesOf(name, first, client) };
        });
        this.shared.set(name, p);
        p.catch(() => this.shared.delete(name));
      }
      try {
        const r = await p;
        entries.push(...r.entries);
        status.push({ name, scope: 'server', ok: true, tools: r.entries.length });
      } catch (err) {
        status.push({ name, scope: 'server', ok: false, tools: 0, error: (err as Error).message });
      }
    }
    return { entries, status };
  }

  /** The workspace's .mcp.json servers, connected for one session. */
  async projectEntries(host: ToolHost, trusted: boolean): Promise<{ entries: McpEntry[]; status: McpStatus[]; close(): Promise<void> }> {
    const status: McpStatus[] = [];
    const entries: McpEntry[] = [];
    const clients: { close(): Promise<void> }[] = [];
    const close = async () => { await Promise.all(clients.map((c) => c.close().catch(() => {}))); };
    let configs: Record<string, McpServerConfig> = {};
    try {
      // On a companion the file is on the user's computer.
      const text = host.kind === 'companion' ? (await host.readFile?.('.mcp.json'))?.toString('utf8') : await fs.readFile(path.join(host.root, '.mcp.json'), 'utf8');
      if (!text) return { entries, status, close };
      const j = JSON.parse(text) as { mcpServers?: Record<string, McpServerConfig> };
      configs = j.mcpServers ?? {};
    } catch { return { entries, status, close }; }
    for (const [name, cfg] of Object.entries(configs)) {
      const isStdio = cfg.type !== 'http';
      if (isStdio && !trusted) {
        status.push({ name, scope: 'project', ok: false, tools: 0, error: host.kind === 'companion'
          ? 'stdio servers from the project start on your computer only when the companion is sandboxed or started with --trust-project'
          : 'stdio servers from the project run only in a sandboxed session (or with HARNESS_TRUST_PROJECT=1)' });
        continue;
      }
      if (isStdio && !host.spawnStream && !host.mcpTransport) {
        status.push({ name, scope: 'project', ok: false, tools: 0, error: 'this workspace cannot start processes' });
        continue;
      }
      try {
        const first = await connect(name, cfg, 'project', host);
        const client = new ReconnectingClient(first, () => connect(name, cfg, 'project', host));
        clients.push(client);
        const e = await entriesOf(name, first, client);
        entries.push(...e);
        status.push({ name, scope: 'project', ok: true, tools: e.length });
      } catch (err) {
        status.push({ name, scope: 'project', ok: false, tools: 0, error: (err as Error).message });
      }
    }
    return { entries, status, close };
  }

  /** Drops one server's shared connection (its config changed or it was removed); the next session connects afresh. */
  async forget(name: string): Promise<void> {
    const p = this.shared.get(name);
    this.shared.delete(name);
    try { (await p)?.client.close(); } catch { /* never connected */ }
  }

  async closeAll(): Promise<void> {
    for (const p of this.shared.values()) { try { (await p).client.close(); } catch { /* never connected */ } }
    this.shared.clear();
  }
}
