import fs from 'node:fs/promises';
import path from 'node:path';
import { BUILTIN_MODELS } from '../core/models.ts';
import { SessionManager } from '../core/manager.ts';
import type { SessionDeps } from '../core/session.ts';
import { McpManager } from '../mcp/manager.ts';
import type { McpServerConfig } from '../plugins/api.ts';
import { findPluginDirs, loadPlugin, readManifest } from '../plugins/loader.ts';
import { loadTrustedKeys, SIG_FILE, verifyPlugin } from '../plugins/signing.ts';
import { OtelExporter, parseHeaders } from './otel.ts';
import { BUILTIN_PROVIDERS } from '../providers/index.ts';
import { CompanionHub } from '../runtime/companion.ts';
import { BUILTIN_TOOLS } from '../tools/index.ts';
import { BUILTIN_SEARCH, makeSearchService, type SearchService } from '../research/search.ts';
import { Registry, type LoadedPlugin } from './registry.ts';

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
  /** Plugin folders shipped with the application: loaded without a signature check. */
  shippedPlugins?: string[];
  /**
   * Trusted public keys (a .pem file or a folder of them). When set, every
   * plugin that is not shipped must be signed by one of them, or it is refused.
   * Default: HARNESS_PLUGIN_KEYS.
   */
  pluginKeys?: string;
  /** A folder of signed plugins people can install from. Default: HARNESS_PLUGIN_CATALOGUE. */
  catalogue?: string;
  /** Where catalogue installs go. Default: <dataDir>/plugins (loaded on the next start too). */
  installDir?: string;
  /** OTLP/HTTP endpoint for trace spans. Default: HARNESS_OTEL_ENDPOINT. */
  otelEndpoint?: string;
  /**
   * Memory across sessions: 'on' (agents read and write it), 'read' (loaded,
   * never changed by agents) or 'off'. Default: HARNESS_MEMORY, else 'on'.
   */
  memory?: 'on' | 'read' | 'off';
  /** Where memory lives. Default: <dataDir>/memory. */
  memoryDir?: string;
  /** The search behind web_search. Default: from HARNESS_SEARCH and the keys the server has; null turns it off. */
  search?: SearchService | null;
  /** Spend per account (a shared server's daily caps). */
  spend?: SessionDeps['spend'];
  /**
   * Branches and pull requests (publish_branch). Default from the environment:
   * HARNESS_GITHUB_TOKEN, HARNESS_PUBLISH_REPOS, HARNESS_GITHUB_API, HARNESS_GIT_AUTHOR ("Name <email>");
   * on when a token or a repository list is set. null turns it off.
   */
  publish?: SessionDeps['publish'] | null;
  log?: (message: string) => void;
}

export interface CatalogueEntry { name: string; version: string; description: string; signature: string; verified: boolean; installed: boolean }

export interface Harness {
  registry: Registry;
  sessions: SessionManager;
  /** The web search backend in use, if any. */
  search?: string;
  companions: CompanionHub;
  mcp: McpManager;
  dataDir: string;
  /** Signed plugins available to install (empty without a catalogue). */
  catalogue(): Promise<CatalogueEntry[]>;
  /** Verifies, copies and loads a catalogue plugin; new sessions get it. */
  install(name: string): Promise<LoadedPlugin>;
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
  const keysPath = opts.pluginKeys ?? process.env.HARNESS_PLUGIN_KEYS;
  const keys = keysPath ? await loadTrustedKeys(keysPath) : null;
  if (keys) log(`plugin signatures required (${keys.length} trusted key(s))`);
  const shipped = (opts.shippedPlugins ?? []).map((d) => path.resolve(d));
  const isShipped = (dir: string) => shipped.some((s) => dir === s || dir.startsWith(s + path.sep));

  /** Decides whether a plugin folder may load; returns how it was admitted. */
  async function admit(dir: string): Promise<string> {
    if (isShipped(dir)) return 'shipped with the harness';
    if (keys) {
      const v = await verifyPlugin(dir, keys);
      if (!v.ok) throw new Error(`refused: ${v.reason}`);
      return `signed by ${v.keyName} (${v.keyId})`;
    }
    return (await fs.stat(path.join(dir, SIG_FILE)).catch(() => null)) ? 'signed, not checked (no trust list)' : 'unsigned';
  }
  async function load(dir: string): Promise<LoadedPlugin> {
    const signature = await admit(dir);
    await loadPlugin(registry, dir, log);
    const p = registry.plugins.at(-1)!;
    p.signature = signature;
    return p;
  }

  const installDir = path.resolve(opts.installDir ?? path.join(opts.dataDir, 'plugins'));
  for (const root of [...(opts.plugins ?? []), installDir]) {
    for (const dir of await findPluginDirs(path.resolve(root))) {
      try {
        const p = await load(dir);
        log(`plugin loaded: ${dir} (${p.signature})`);
      } catch (err) {
        log(`plugin FAILED (${dir}): ${(err as Error).message}`);
      }
    }
  }
  const cataloguePath = opts.catalogue ?? process.env.HARNESS_PLUGIN_CATALOGUE;
  const catalogueDirs = async () => (cataloguePath ? findPluginDirs(path.resolve(cataloguePath)) : []);
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
  const otelEndpoint = opts.otelEndpoint ?? process.env.HARNESS_OTEL_ENDPOINT;
  const otel = otelEndpoint ? new OtelExporter(otelEndpoint, { headers: parseHeaders(process.env.HARNESS_OTEL_HEADERS), log }) : undefined;
  const memoryMode = opts.memory ?? (process.env.HARNESS_MEMORY as 'on' | 'read' | 'off' | undefined) ?? 'on';
  if (!['on', 'read', 'off'].includes(memoryMode)) throw new Error(`HARNESS_MEMORY must be on, read or off (got "${memoryMode}")`);
  const search = opts.search === null ? undefined : opts.search ?? makeSearchService([...registry.searchBackends.values(), ...(opts.bare ? [] : BUILTIN_SEARCH)]);
  if (search) log(`web search: ${search.backend}`);
  const sessions = new SessionManager({
    dataDir: opts.dataDir, companions, registry, mcp, onSpan: otel ? (sid, span) => otel.record(sid, span) : undefined,
    memory: { root: path.resolve(opts.memoryDir ?? path.join(opts.dataDir, 'memory')), mode: memoryMode }, search, spend: opts.spend,
    publish: opts.publish === null ? undefined : opts.publish ?? publishFromEnv(),
  });
  await sessions.load();
  return {
    registry, sessions, companions, mcp, dataDir: opts.dataDir, search: search?.backend,
    async catalogue() {
      const out: CatalogueEntry[] = [];
      for (const dir of await catalogueDirs()) {
        const m = await readManifest(dir).catch(() => undefined);
        if (!m) continue;
        const v = keys ? await verifyPlugin(dir, keys) : null;
        out.push({
          name: m.name, version: m.version ?? '0.0.0', description: m.description ?? '',
          signature: v ? (v.ok ? `signed by ${v.keyName}` : v.reason) : 'not checked (no trust list)',
          verified: !!v?.ok, installed: registry.plugins.some((p) => p.name === m.name),
        });
      }
      return out;
    },
    async install(name) {
      if (!keys) throw new Error('Installing from the catalogue needs a trust list (HARNESS_PLUGIN_KEYS): plugin code runs in the server.');
      let src: string | undefined;
      for (const d of await catalogueDirs()) if ((await readManifest(d).catch(() => undefined))?.name === name) src = d;
      if (!src) throw new Error(`No plugin "${name}" in the catalogue.`);
      if (registry.plugins.some((p) => p.name === name)) throw new Error(`Plugin "${name}" is already loaded.`);
      const v = await verifyPlugin(src, keys);
      if (!v.ok) throw new Error(`Refused: ${v.reason}`);
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error(`Bad plugin name "${name}".`);
      const dest = path.join(installDir, name);
      if (await fs.stat(dest).catch(() => null)) throw new Error(`${dest} already exists.`);
      await fs.mkdir(installDir, { recursive: true });
      await fs.cp(src, dest, { recursive: true });
      try {
        return await load(dest); // verified again where it will run from
      } catch (e) {
        await fs.rm(dest, { recursive: true, force: true });
        throw e;
      }
    },
    async close() {
      await sessions.close();
      await otel?.close();
      await mcp.closeAll();
      for (const c of registry.closers) await Promise.resolve(c()).catch(() => {});
    },
  };
}

function publishFromEnv(): SessionDeps['publish'] {
  const token = process.env.HARNESS_GITHUB_TOKEN?.trim() || undefined;
  const repos = (process.env.HARNESS_PUBLISH_REPOS ?? '').split(',').map((r) => r.trim()).filter(Boolean);
  if (!token && !repos.length) return undefined;
  const a = /^(.+?)\s*<([^>]+)>$/.exec(process.env.HARNESS_GIT_AUTHOR ?? '');
  return { token, repos, apiBase: process.env.HARNESS_GITHUB_API || undefined, author: a ? { name: a[1]!, email: a[2]! } : undefined };
}

