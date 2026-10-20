import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { McpServerConfig } from '../plugins/api.ts';
import type { ToolHost } from '../runtime/host.ts';
import { assertPublicUrl } from '../tools/web.ts';
import { HttpTransport, McpClient, StdioTransport } from './client.ts';
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

function expand(v: string): string {
  return v.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, k: string) => process.env[k] ?? '');
}

async function connect(name: string, cfg: McpServerConfig, scope: 'server' | 'project', host?: ToolHost): Promise<McpClient> {
  let client: McpClient;
  if (cfg.type === 'http') {
    const url = scope === 'server' ? expand(cfg.url) : cfg.url;
    if (scope === 'project') await assertPublicUrl(url);
    const headers = Object.fromEntries(Object.entries(cfg.headers ?? {}).map(([k, v]) => [k, scope === 'server' ? expand(v) : v]));
    client = new McpClient(new HttpTransport(url, headers));
  } else {
    const args = (cfg.args ?? []).map((a) => (scope === 'server' ? expand(a) : a));
    const env = Object.fromEntries(Object.entries(cfg.env ?? {}).map(([k, v]) => [k, scope === 'server' ? expand(v) : v]));
    const child = scope === 'server'
      ? spawn(cfg.command, args, { cwd: cfg.cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
      : await host!.spawnStream!(cfg.command, args, env);
    client = new McpClient(new StdioTransport(child));
  }
  await client.initialize();
  return client;
}

async function entriesOf(name: string, client: McpClient): Promise<McpEntry[]> {
  const tools = await client.listTools();
  return tools.map((tool) => ({ server: name, tool, client, qualified: qualifiedName(name, tool.name) }));
}

export class McpManager {
  private shared = new Map<string, Promise<{ client: McpClient; entries: McpEntry[] }>>();

  /** Operator-configured servers, connected once per process. */
  async serverEntries(configs: Map<string, McpServerConfig>): Promise<{ entries: McpEntry[]; status: McpStatus[] }> {
    const entries: McpEntry[] = [];
    const status: McpStatus[] = [];
    for (const [name, cfg] of configs) {
      let p = this.shared.get(name);
      if (!p) {
        p = connect(name, cfg, 'server').then(async (client) => ({ client, entries: await entriesOf(name, client) }));
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
    const clients: McpClient[] = [];
    const close = async () => { await Promise.all(clients.map((c) => c.close().catch(() => {}))); };
    if (host.kind === 'companion') return { entries, status, close };
    let configs: Record<string, McpServerConfig> = {};
    try {
      const j = JSON.parse(await fs.readFile(path.join(host.root, '.mcp.json'), 'utf8')) as { mcpServers?: Record<string, McpServerConfig> };
      configs = j.mcpServers ?? {};
    } catch { return { entries, status, close }; }
    for (const [name, cfg] of Object.entries(configs)) {
      const isStdio = cfg.type !== 'http';
      if (isStdio && !trusted) {
        status.push({ name, scope: 'project', ok: false, tools: 0, error: 'stdio servers from the project run only in a sandboxed session (or with HARNESS_TRUST_PROJECT=1)' });
        continue;
      }
      if (isStdio && !host.spawnStream) {
        status.push({ name, scope: 'project', ok: false, tools: 0, error: 'this workspace cannot start processes' });
        continue;
      }
      try {
        const client = await connect(name, cfg, 'project', host);
        clients.push(client);
        const e = await entriesOf(name, client);
        entries.push(...e);
        status.push({ name, scope: 'project', ok: true, tools: e.length });
      } catch (err) {
        status.push({ name, scope: 'project', ok: false, tools: 0, error: (err as Error).message });
      }
    }
    return { entries, status, close };
  }

  async closeAll(): Promise<void> {
    for (const p of this.shared.values()) { try { (await p).client.close(); } catch { /* never connected */ } }
    this.shared.clear();
  }
}
