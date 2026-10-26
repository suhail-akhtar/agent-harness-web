import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { loadAgentDir } from '../agents/agents.ts';
import type { PluginParts, Registry } from '../kernel/registry.ts';
import { HOOK_EVENTS } from '../core/settings.ts';
import type { WorkflowDef } from '../graph/types.ts';
import { usesNodeType, validateWorkflow } from '../graph/validate.ts';
import { assertPublicUrl, publicFetch } from '../tools/web.ts';
import { resolveIn } from '../tools/paths.ts';
import type { Tool, ToolServices } from '../tools/types.ts';
import type { VaultService } from '../vault/store.ts';
import { defineTool, type PluginAPI, type PluginDefinition, type PluginManifest, type PluginSessions } from './api.ts';
import { ChangeJournal } from '../ops/changes.ts';
import { ROUTE_PATH } from './host.ts';
import { freshImport } from './fresh-import.ts';
import { makeStore } from './store.ts';
import { registerPluginDir } from './resolve.ts';
import { compatibility, HARNESS_VERSION } from './bundle.ts';

// Plugins are folders with a harness-plugin.json. The operator lists plugin
// directories (HARNESS_PLUGINS); those are TRUSTED: their code runs in the
// server. Code never loads from a workspace - a repository can only contribute
// declaratively, per session (see the session's project loading).

export const MANIFEST = 'harness-plugin.json';

export async function readManifest(dir: string): Promise<PluginManifest | undefined> {
  try {
    const m = JSON.parse(await fs.readFile(path.join(dir, MANIFEST), 'utf8')) as PluginManifest;
    if (!m || typeof m.name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(m.name)) throw new Error('manifest needs a valid "name"');
    return m;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`${path.join(dir, MANIFEST)}: ${(err as Error).message}`);
  }
}

/** A plugin dir, or a dir of plugin dirs. */
export async function findPluginDirs(root: string): Promise<string[]> {
  if (await readManifest(root).catch(() => undefined)) return [root];
  let names: string[];
  try { names = await fs.readdir(root); } catch { return []; }
  const out: string[] = [];
  for (const n of names.sort()) {
    const d = path.join(root, n);
    try { if ((await fs.stat(d)).isDirectory() && (await fs.stat(path.join(d, MANIFEST)).catch(() => null))) out.push(d); } catch { /* skip */ }
  }
  return out;
}

/**
 * Loads one plugin, all or nothing: a plugin that fails partway through (a bad
 * workflow, a throwing setup) leaves no tools, agents, gates or hooks behind.
 */
export async function loadPlugin(reg: Registry, dir: string, log: (m: string) => void = () => {}, opts: { dataDir?: string; /** Import its code again, not Node's cached copy (a live reload). */ fresh?: boolean; /** Official or custom (api.tier). */ tier?: 'official' | 'custom' } = {}): Promise<PluginParts> {
  const restore = reg.snapshot();
  // What it adds is recorded, so it can be switched off and on again while the server runs.
  const added = reg.record();
  try {
    await loadInto(reg, dir, log, opts.dataDir, opts.fresh, opts.tier);
    return added();
  } catch (e) {
    restore();
    throw e;
  }
}

/** The plugin's UI section, validated (see src/plugins/ui.ts); a bad one is reported, never fatal. */
export { readPluginUi } from './ui.ts';

async function loadInto(reg: Registry, dir: string, log: (m: string) => void, dataRoot?: string, fresh?: boolean, tier: 'official' | 'custom' = 'custom'): Promise<void> {
  const m = await readManifest(dir);
  if (!m) throw new Error(`no ${MANIFEST} in ${dir}`);
  if (reg.plugins.some((p) => p.name === m.name)) throw new Error(`plugin ${m.name} is loaded twice`);
  // Made for other harness versions (engines.harness): not loaded, with what to do (HARNESS_PLUGIN_IGNORE_ENGINES=1 loads it anyway).
  const compat = compatibility(m);
  if (!compat.ok) {
    if (process.env.HARNESS_PLUGIN_IGNORE_ENGINES !== '1') throw new Error(`${m.name} ${m.version ?? ''} is not for this harness: ${compat.reason}`);
    log(`plugin ${m.name}: ${compat.reason} (loaded anyway: HARNESS_PLUGIN_IGNORE_ENGINES=1)`);
  }
  const contributes: string[] = [];
  const within = (rel: string) => {
    const p = path.resolve(dir, rel);
    if (!p.startsWith(path.resolve(dir) + path.sep) && p !== path.resolve(dir)) throw new Error(`${m.name}: path ${rel} leaves the plugin folder`);
    return p;
  };

  if (m.skills) { reg.skillDirs.push({ dir: within(m.skills), source: m.name }); contributes.push('skills'); }
  if (m.outputStyles) { reg.outputStyleDirs.push({ dir: within(m.outputStyles), source: m.name }); contributes.push('output-styles'); }
  if (m.agents) {
    for (const a of await loadAgentDir(within(m.agents), m.name)) {
      if (!reg.agents.has(a.name)) reg.agents.set(a.name, a);
    }
    contributes.push('agents');
  }
  if (m.workflows) {
    for (const w of await loadWorkflowDir(within(m.workflows), m.name)) { reg.workflows.set(w.name, w); contributes.push(`workflow:${w.name}`); }
  }
  // The operator may add hosts to a plugin's own list (HARNESS_PLUGIN_NETWORK, e.g. a GitHub
  // Enterprise or internal Prometheus address): never the plugin itself.
  const declared = { network: [...(m.permissions?.network ?? []).map(String), ...operatorHosts(m.name)], secrets: (m.permissions?.secrets ?? []).map(String), vault: (m.permissions?.vault ?? []).map(String).filter((g) => g.trim()) };
  // Driving sessions and serving HTTP are declared like network and secrets: an operator sees them before installing.
  const mayDrive = m.permissions?.sessions === true;
  const mayServe = m.permissions?.routes === true;
  for (const [name, cfg] of Object.entries(m.mcpServers ?? {})) {
    reg.mcpServers.set(name, { ...cfg, plugin: m.name, secrets: declared.secrets, operator: false } as never);
    contributes.push(`mcp:${name}`);
  }
  for (const [ev, specs] of Object.entries(m.hooks ?? {})) {
    if (!(HOOK_EVENTS as readonly string[]).includes(ev)) { log(`${m.name}: unknown hook event ${ev} (skipped)`); continue; }
    // An http hook goes only to hosts the plugin declared, and reads only the secrets it declared.
    const ok = (specs ?? []).filter((h) => {
      if (h?.type !== 'http') return true;
      let host = '';
      try { host = new URL(String(h.url)).hostname; } catch { /* not a URL */ }
      const vars = Object.values(h.headers ?? {}).flatMap((v) => [...String(v).matchAll(/\$\{([A-Za-z0-9_]+)\}/g)].map((x) => x[1]!));
      const bad = !host || !hostAllowed(host, declared.network) ? `its URL's host is not in permissions.network` : vars.find((v) => !declared.secrets.includes(v)) ? `it reads a variable not in permissions.secrets` : '';
      if (bad) log(`${m.name}: ${ev} http hook skipped: ${bad}`);
      return !bad;
    });
    (reg.shellHooks[ev as keyof typeof reg.shellHooks] ??= []).push(...ok);
    contributes.push(`hooks:${ev}`);
  }

  if (m.main) {
    // Its modules (and other plugins' by name: @harness/plugins/<name>/...) resolve wherever it is installed.
    registerPluginDir(m.name, dir);
    const mod = (fresh ? await freshImport(within(m.main), dir) : await import(pathToFileURL(within(m.main)).href)) as { default?: PluginDefinition };
    const def = mod.default;
    if (!def || typeof def.setup !== 'function') throw new Error(`${m.name}: ${m.main} must default-export definePlugin({...})`);
    const undeclared = (what: string, key: string) => () => { throw new Error(`${m.name}: ${what} needs "permissions": {"${key}": true} in harness-plugin.json`); };
    const bridgeOrThrow = () => {
      if (!reg.bridge) throw new Error(`${m.name}: sessions are only available in a server harness (createHarness)`);
      return reg.bridge;
    };
    const sessions: PluginSessions = mayDrive ? {
      start: (o) => bridgeOrThrow().sessionsFor(m.name).start(o),
      send: (id, text, o) => bridgeOrThrow().sessionsFor(m.name).send(id, text, o),
      respond: (id, requestId, d) => bridgeOrThrow().sessionsFor(m.name).respond(id, requestId, d),
      get: (id) => reg.bridge?.sessionsFor(m.name).get(id),
    } : { start: async () => undeclared('api.sessions', 'sessions')(), send: async () => undeclared('api.sessions', 'sessions')(), respond: async () => undeclared('api.sessions', 'sessions')(), get: undeclared('api.sessions', 'sessions') } as PluginSessions;
    const pluginData = path.resolve(dataRoot ?? path.join(os.tmpdir(), 'harness-plugin-data'), 'plugin-data', m.name);
    const localChanges = new ChangeJournal(path.resolve(dataRoot ?? path.join(os.tmpdir(), 'harness-plugin-data')));
    const api: PluginAPI = {
      pluginName: m.name,
      pluginDir: dir,
      tier,
      harnessVersion: HARNESS_VERSION,
      // The server's data folder when there is one; a temporary folder otherwise (a plugin loaded on its own, in a test).
      dataDir: pluginData,
      store: (name, so) => makeStore(m.name, pluginData, name, so),
      registerTool: (t) => {
        const tool = limitVault('spec' in t ? t : defineTool(t), m.name, declared.vault);
        // A plugin that may reach the network (declared hosts) can send what its tools are given there.
        if (declared.network.length && tool.sendsOut === undefined) tool.sendsOut = true;
        reg.addTool(tool, m.name);
        contributes.push(`tool:${tool.spec.name}`);
      },
      workspacePath: (host, p) => resolveIn(host, p),
      registerModel: (spec) => { reg.models.set(spec.id, spec); contributes.push(`model:${spec.id}`); },
      registerProvider: (id, p) => { reg.providers.set(id, p); contributes.push(`provider:${id}`); },
      registerAgent: (a) => { reg.agents.set(a.name, { ...a, source: m.name }); contributes.push(`agent:${a.name}`); },
      registerSkills: (d) => { reg.skillDirs.push({ dir: path.resolve(dir, d), source: m.name }); contributes.push('skills'); },
      registerMcpServer: (name, cfg) => { reg.mcpServers.set(name, { ...cfg, plugin: m.name, secrets: declared.secrets, operator: false } as never); contributes.push(`mcp:${name}`); },
      secret: (name) => {
        if (!declared.secrets.includes(name)) throw new Error(`${m.name}: the secret ${name} is not declared in harness-plugin.json (permissions.secrets)`);
        return process.env[name];
      },
      fetch: (url, init) => pluginFetch(m.name, declared.network, url, init),
      registerGate: (g) => { reg.gates.set(g.name, { ...g, run: (ctx) => g.run({ ...ctx, services: vaultFor(ctx.services, m.name, declared.vault) }), plugin: m.name }); contributes.push(`gate:${g.name}`); },
      registerVaultRotation: (h) => {
        if (typeof h?.rotate !== 'function') throw new Error(`${m.name}: a vault rotation handler needs rotate()`);
        reg.vaultRotators.push({ ...h, plugin: m.name });
        contributes.push(`vault-rotation:${h.kind ?? ''}${h.prefix ? `${h.prefix}*` : ''}`);
      },
      registerSearchBackend: (b) => { reg.searchBackends.set(b.name, b); contributes.push(`search:${b.name}`); },
      registerWorkflow: (w) => {
        const errors = validateWorkflow(w);
        if (errors.length) throw new Error(`${m.name}: workflow ${w.name} is invalid: ${errors.join('; ')}`);
        reg.workflows.set(w.name, { ...w, source: m.name });
        contributes.push(`workflow:${w.name}`);
      },
      on: (event, handler, matcher) => { reg.hooks.push({ event, handler, matcher, plugin: m.name }); contributes.push(`hook:${event}`); },
      log: (msg) => log(`[${m.name}] ${msg}`),
      signal: (name) => { if (typeof name === 'string' && /^[a-zA-Z0-9_.-]{1,40}$/.test(name)) reg.bridge?.signal?.(m.name, name); },
      registerRoute: (r) => {
        if (!mayServe) undeclared('api.registerRoute', 'routes')();
        if (r?.method !== 'GET' && r?.method !== 'POST') throw new Error(`${m.name}: a route's method is GET or POST`);
        if (r.auth !== 'token' && r.auth !== 'none' && r.auth !== 'user') throw new Error(`${m.name}: a route's auth is "token", "user" or "none"`);
        if (typeof r.path !== 'string' || !ROUTE_PATH.test(r.path) || r.path.split('/').some((x) => x === '.' || x === '..')) throw new Error(`${m.name}: route path "${r.path}" must be letters, digits, . _ - and / (no leading slash)`);
        // The server's own paths under /api/plugins/<name>/: the UI files, enable and disable.
        if (/^(ui(\/|$)|(enable|disable|reload|update|export|revisions|rollback)$)/.test(r.path)) throw new Error(`${m.name}: route path "${r.path}" is reserved (ui/..., enable, disable, reload, update, export, revisions, rollback)`);
        if (typeof r.handler !== 'function') throw new Error(`${m.name}: a route needs a handler`);
        if (reg.routes.some((x) => x.plugin === m.name && x.path === r.path && x.method === r.method)) throw new Error(`${m.name}: ${r.method} ${r.path} is registered twice`);
        reg.routes.push({ ...r, plugin: m.name });
        contributes.push(`route:${r.method} ${r.path}`);
      },
      events: {
        subscribe: (handler) => {
          if (!mayDrive) undeclared('api.events', 'sessions')();
          const entry = { plugin: m.name, handler };
          reg.eventHandlers.push(entry);
          return () => { const i = reg.eventHandlers.indexOf(entry); if (i >= 0) reg.eventHandlers.splice(i, 1); };
        },
      },
      sessions,
      get changes() { return reg.bridge?.changes ?? localChanges; },
      lease: async (name) => (reg.bridge ? reg.bridge.lease(m.name, String(name)) : true),
      get vault() {
        const b = reg.bridge;
        return declared.vault.length && b?.hasVault() ? { list: () => b.vaultList(m.name, declared.vault), reveal: (name: string, purpose: string) => b.vaultReveal(m.name, declared.vault, String(name), String(purpose ?? '')) } : undefined;
      },
    };
    try {
      await def.setup(api);
    } catch (e) {
      await Promise.resolve(def.close?.()).catch(() => {}); // it may have started something before failing
      throw e;
    }
    if (typeof def.close === 'function') reg.closers.push(() => def.close!());
  }
  const { vault, ...rest } = declared;
  const runsPrograms = m.permissions?.processes === true;
  const extra = { ...(mayDrive ? { sessions: true } : {}), ...(mayServe ? { routes: true } : {}), ...(runsPrograms ? { processes: true } : {}) };
  reg.plugins.push({ name: m.name, version: m.version ?? '0.0.0', description: m.description ?? '', dir, trusted: true, contributes: [...new Set(contributes)], ...(declared.network.length || declared.secrets.length || vault.length || mayDrive || mayServe || runsPrograms ? { permissions: { ...rest, ...(vault.length ? { vault } : {}), ...extra } } : {}) });
}

/**
 * A plugin's tools reach the key vault only for the names its manifest declared
 * (permissions.vault): the session's vault is handed to them wrapped, so every
 * reveal and envFor carries the plugin's name and grants (checked and audited by
 * the vault) and the vault tool's own operations are not there at all.
 */
function vaultFor(services: ToolServices | undefined, plugin: string, grants: string[]): ToolServices | undefined {
  const v = services?.vault;
  if (!v) return services;
  const vault: VaultService = {
    list: () => v.list(),
    reveal: (name, purpose) => v.reveal(name, purpose, { plugin, grants }),
    envFor: (map, purpose) => v.envFor(map, purpose, { plugin, grants }),
  };
  return { ...services, vault };
}

function limitVault(tool: Tool, plugin: string, grants: string[]): Tool {
  const run = tool.run.bind(tool);
  tool.run = (input, ctx) => run(input, ctx.services?.vault ? { ...ctx, services: vaultFor(ctx.services, plugin, grants) } : ctx);
  return tool;
}

/** JSON workflows from a directory. Declarative only: a JSON workflow cannot hold code nodes. */
export async function loadWorkflowDir(dir: string, source: string, log: (m: string) => void = () => {}): Promise<WorkflowDef[]> {
  let names: string[];
  try { names = await fs.readdir(dir); } catch { return []; }
  const out: WorkflowDef[] = [];
  for (const n of names.sort()) {
    if (!n.endsWith('.json')) continue;
    try {
      const w = JSON.parse(await fs.readFile(path.join(dir, n), 'utf8')) as WorkflowDef;
      if (usesNodeType(w, 'code')) throw new Error('code nodes are only allowed in TypeScript workflows');
      const errors = validateWorkflow(w);
      if (errors.length) throw new Error(errors.join('; '));
      out.push({ ...w, source });
    } catch (err) {
      log(`workflow ${path.join(dir, n)} skipped: ${(err as Error).message}`);
    }
  }
  return out;
}

/** A host matches a declared pattern: "api.example.com", or "*.example.com" for any subdomain. */
export function hostAllowed(host: string, patterns: string[]): boolean {
  const h = host.toLowerCase();
  return patterns.some((p) => {
    const d = p.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    return d.startsWith('*.') ? h.endsWith(d.slice(1)) && h !== d.slice(2) : h === d;
  });
}

/** Hosts the operator grants a plugin beyond its manifest: HARNESS_PLUGIN_NETWORK = {"plugin": ["host", ...]}. */
function operatorHosts(plugin: string): string[] {
  const raw = process.env.HARNESS_PLUGIN_NETWORK?.trim();
  if (!raw) return [];
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const v = j[plugin];
    return Array.isArray(v) ? v.map(String).filter((h) => /^[\w.*:[\]-]+$/.test(h)) : [];
  } catch { throw new Error('HARNESS_PLUGIN_NETWORK is not JSON of the form {"plugin": ["host", ...]}'); }
}

/**
 * fetch for plugin code: only to the hosts the plugin declared (permissions.network),
 * every redirect re-checked. Every host name is checked against private
 * addresses, named exactly or not - a declared name can be re-pointed in DNS at
 * an internal address. A private endpoint (a local model server) is reached
 * only when declared as an IP address or localhost.
 */
export async function pluginFetch(plugin: string, allowed: string[], url: string | URL, init: RequestInit = {}): Promise<Response> {
  let u = new URL(String(url));
  for (let hop = 0; hop < 6; hop++) {
    const host = u.host.toLowerCase();
    const exact = allowed.some((p) => p.toLowerCase() === host || p.toLowerCase() === u.hostname.toLowerCase());
    if (!hostAllowed(u.hostname, allowed) && !exact) throw new Error(`${plugin}: ${u.hostname} is not in the plugin's declared network hosts (harness-plugin.json permissions.network)`);
    const literal = net.isIP(u.hostname.replace(/^\[|\]$/g, '')) !== 0 || u.hostname.toLowerCase() === 'localhost';
    const checked = !(exact && literal);
    if (checked) await assertPublicUrl(u.toString());
    // Checked hosts are checked again on connect (no DNS rebinding in between).
    const res = await (checked ? publicFetch : fetch)(u, { ...init, redirect: 'manual' });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!loc) return res;
    u = new URL(loc, u);
  }
  throw new Error(`${plugin}: too many redirects`);
}

