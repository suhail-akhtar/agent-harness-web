import fs from 'node:fs/promises';
import path from 'node:path';
import { BUILTIN_MODELS } from '../core/models.ts';
import { SessionManager } from '../core/manager.ts';
import { McpManager } from '../mcp/manager.ts';
import type { McpServerConfig } from '../plugins/api.ts';
import { findPluginDirs, loadPlugin } from '../plugins/loader.ts';
import { BUILTIN_PROVIDERS } from '../providers/index.ts';
import { CompanionHub } from '../runtime/companion.ts';
import { BUILTIN_TOOLS } from '../tools/index.ts';
import { Registry } from './registry.ts';

// The harness as a library: one call assembles the registry (built-ins, then
// plugins), the MCP manager, the companion hub and the session manager.
//
//   const h = await createHarness({ dataDir: './data', plugins: ['./plugins'] });
//   const s = await h.sessions.create({ model: 'deepseek-flash', runtime: { kind: 'local', network: 'none', path: '.' } });
//   s.subscribe(0, (e) => console.log(e.event));
//   await s.send('Fix the failing tests');

export interface HarnessOptions {
  dataDir: string;
  /** Plugin folders (each a plugin, or a folder of plugins). Trusted: their code runs in this process. */
  plugins?: string[];
  /** Operator MCP servers, in .mcp.json shape ({ mcpServers: {...} }), as a path or an object. */
  mcp?: string | Record<string, McpServerConfig>;
  /** Skip the built-in models/providers/tools (for a fully custom harness). */
  bare?: boolean;
  log?: (message: string) => void;
}

export interface Harness {
  registry: Registry;
  sessions: SessionManager;
  companions: CompanionHub;
  mcp: McpManager;
  dataDir: string;
  close(): Promise<void>;
}

export function builtinRegistry(): Registry {
  const reg = new Registry();
  for (const m of BUILTIN_MODELS) reg.models.set(m.id, m);
  for (const [id, p] of Object.entries(BUILTIN_PROVIDERS)) reg.providers.set(id, p);
  for (const t of BUILTIN_TOOLS) reg.addTool(t);
  return reg;
}

export async function createHarness(opts: HarnessOptions): Promise<Harness> {
  const log = opts.log ?? (() => {});
  const registry = opts.bare ? new Registry() : builtinRegistry();
  for (const root of opts.plugins ?? []) {
    for (const dir of await findPluginDirs(path.resolve(root))) {
      try {
        await loadPlugin(registry, dir, log);
        log(`plugin loaded: ${dir}`);
      } catch (err) {
        log(`plugin FAILED (${dir}): ${(err as Error).message}`);
      }
    }
  }
  if (opts.mcp) {
    const servers = typeof opts.mcp === 'string'
      ? (JSON.parse(await fs.readFile(opts.mcp, 'utf8')) as { mcpServers?: Record<string, McpServerConfig> }).mcpServers ?? {}
      : opts.mcp;
    for (const [name, cfg] of Object.entries(servers)) registry.mcpServers.set(name, { ...cfg, plugin: 'config' } as never);
  }
  await fs.mkdir(opts.dataDir, { recursive: true });
  const companions = new CompanionHub(opts.dataDir);
  await companions.load();
  const mcp = new McpManager();
  const sessions = new SessionManager({ dataDir: opts.dataDir, companions, registry, mcp });
  await sessions.load();
  return {
    registry, sessions, companions, mcp, dataDir: opts.dataDir,
    async close() { await sessions.close(); await mcp.closeAll(); },
  };
}
