import type { ModelSpec } from '../core/models.ts';
import type { WorkflowDef } from '../graph/types.ts';
import type { HookEvent, HookSpec } from '../core/settings.ts';
import type { AgentDef, HookHandler, McpServerConfig, PluginEventHandler, PluginRoute, ProviderDef, QualityGate } from '../plugins/api.ts';
import type { PluginBridge } from '../plugins/host.ts';
import type { Provider } from '../providers/types.ts';
import type { SearchBackend } from '../research/search.ts';
import type { Tool } from '../tools/types.ts';

// Everything the harness can use is registered here: the built-ins and every
// plugin go through the same calls, so a plugin can do anything a built-in can.

export interface LoadedPlugin {
  name: string;
  version: string;
  description: string;
  dir: string;
  trusted: boolean;
  contributes: string[];
  /** "shipped with the harness", "signed by <key>", "unsigned", ... */
  signature?: string;
  /** What it declared it needs (harness-plugin.json permissions). */
  permissions?: { network?: string[]; secrets?: string[]; vault?: string[]; sessions?: boolean; routes?: boolean };
  /** Where it came from: shipped with the harness, installed from the catalogue, or listed by the operator (HARNESS_PLUGINS). */
  source?: 'bundled' | 'installed' | 'env';
}

/**
 * What loading one plugin added to the registry, so it can be taken out again and put
 * back (a plugin switched off and on while the server runs). Map entries keep what they
 * replaced, if anything.
 */
export interface PluginParts {
  maps: { map: Map<string, unknown>; key: string; value: unknown; replaced?: { value: unknown } }[];
  lists: { list: unknown[]; item: unknown }[];
  shell: { event: string; spec: unknown }[];
  closers: (() => void | Promise<void>)[];
}

export interface InProcessHook { event: HookEvent; matcher?: string; handler: HookHandler; plugin: string }

/**
 * Which plugin contributed a part (a tool, agent, gate, workflow, hook, skill folder ...) and the
 * registry that knows whether it is on. An open session keeps the parts it was built with (its tool
 * list is part of the cached prefix), so whether one may run is asked when it is used.
 */
const owned = new WeakMap<object, { registry: Registry; plugin: string }>();
const isObj = (x: unknown): x is object => (typeof x === 'object' && x !== null) || typeof x === 'function';

/**
 * Why a part may not run now (its plugin is switched off on the server, or was uninstalled), or
 * undefined when it may. `what` names it in the message ("query_db", "the reviewer agent").
 */
export function switchedOff(part: unknown, what: string): string | undefined {
  if (!isObj(part)) return undefined;
  const o = owned.get(part);
  return o ? o.registry.offReason(o.plugin, what) : undefined;
}

export class Registry {
  readonly models = new Map<string, ModelSpec>();
  readonly providers = new Map<string, ProviderDef>();
  readonly tools = new Map<string, Tool>();
  readonly agents = new Map<string, AgentDef>();
  readonly skillDirs: { dir: string; source: string }[] = [];
  /** Folders of output styles (<name>.md) a session may pick when it is made. */
  readonly outputStyleDirs: { dir: string; source: string }[] = [];
  readonly mcpServers = new Map<string, McpServerConfig & { plugin: string; secrets?: string[]; operator?: boolean }>();
  readonly gates = new Map<string, QualityGate & { plugin: string }>();
  readonly workflows = new Map<string, WorkflowDef>();
  /** Search backends from plugins (tried before the built-in ones). */
  readonly searchBackends = new Map<string, SearchBackend>();
  readonly hooks: InProcessHook[] = [];
  readonly shellHooks: Partial<Record<HookEvent, HookSpec[]>> = {};
  readonly plugins: LoadedPlugin[] = [];
  /** Key vault rotation handlers from plugins. */
  readonly vaultRotators: import('../vault/store.ts').RotationHandler[] = [];
  /** Plugin teardown, run by harness.close(). */
  readonly closers: (() => void | Promise<void>)[] = [];
  /** HTTP endpoints from plugins (served at /api/plugins/<plugin>/<path>). */
  readonly routes: (PluginRoute & { plugin: string })[] = [];
  /** Plugins' subscribers to every session's events. */
  readonly eventHandlers: { plugin: string; handler: PluginEventHandler }[] = [];
  /** What plugin code reaches of the running harness (sessions, the change journal, leases); set by createHarness. */
  bridge?: PluginBridge;
  private instances = new Map<string, Provider>();
  /** Provider instances made here, with the key and base URL they were made with (a changed key makes a new one). */
  private made = new Map<string, { key: string; baseUrl?: string; p: Provider }>();
  private live = new Map<string, Provider>();
  /**
   * Keys and base URLs set through the API (the vault's provider-<id>-key entries, the
   * providers file): the environment's key wins, then this. Set by createHarness.
   */
  keySource?: (provider: string) => string | undefined;
  baseUrlFor?: (provider: string) => string | undefined;

  /** Saves the registry's contents; the function returned puts them back (a failed plugin load). */
  snapshot(): () => void {
    const maps: Map<string, unknown>[] = [this.models, this.providers, this.tools, this.agents, this.mcpServers, this.gates, this.workflows, this.searchBackends, this.instances];
    const lists: unknown[][] = [this.skillDirs, this.outputStyleDirs, this.hooks, this.plugins, this.closers, this.vaultRotators, this.routes, this.eventHandlers];
    const savedMaps = maps.map((m) => new Map(m));
    const savedLists = lists.map((l) => l.slice());
    const savedShell = Object.fromEntries(Object.entries(this.shellHooks).map(([k, v]) => [k, v?.slice()]));
    return () => {
      maps.forEach((m, i) => { m.clear(); for (const [k, v] of savedMaps[i]!) m.set(k, v); });
      lists.forEach((l, i) => { l.length = 0; l.push(...savedLists[i]!); });
      for (const k of Object.keys(this.shellHooks)) delete (this.shellHooks as Record<string, unknown>)[k];
      Object.assign(this.shellHooks, savedShell);
    };
  }

  model(id: string): ModelSpec {
    const m = this.models.get(id);
    if (!m) throw new Error(`Unknown model "${id}". Available: ${[...this.models.keys()].join(', ')}`);
    return m;
  }

  listModels(): (ModelSpec & { available: boolean })[] {
    return [...this.models.values()].map((m) => ({ ...m, available: this.instances.has(m.provider) || !!this.keyFor(m.provider) || !!this.providers.get(m.provider)?.keyless }));
  }

  /** Where a provider's key comes from: its environment variables first, then a key set through the API. */
  keyInfo(provider: string): { key?: string; source: 'env' | 'vault' | 'none' } {
    const def = this.providers.get(provider);
    for (const k of def?.keyEnv ?? []) if (process.env[k]) return { key: process.env[k], source: 'env' };
    const stored = this.keySource?.(provider);
    return stored ? { key: stored, source: 'vault' } : { source: 'none' };
  }

  private keyFor(provider: string): string | undefined { return this.keyInfo(provider).key; }

  /** Whether a test (setProviderInstance) serves this provider. */
  hasInstance(provider: string): boolean { return this.instances.has(provider); }

  /**
   * The provider serving a model (keys never leave the server). Without a test instance it is
   * a thin stand-in that looks the key up on every request, so a key set or changed through the
   * API takes effect at the next request of every session, without a restart.
   */
  provider(model: ModelSpec): Provider {
    const hit = this.instances.get(model.provider);
    if (hit) return hit;
    const id = model.provider;
    this.current(id); // fails now (no provider, no key) rather than at the first request
    let p = this.live.get(id);
    if (!p) {
      p = {
        send: async (req) => this.current(id).send(req),
        compactsServerSide: (m, at) => this.current(id).compactsServerSide?.(m, at) ?? false,
      };
      this.live.set(id, p);
    }
    return p;
  }

  /** The instance for the key and base URL in force now (made again when either changed). */
  private current(id: string): Provider {
    const hit = this.instances.get(id);
    if (hit) return hit;
    const def = this.providers.get(id);
    if (!def) throw new Error(`No provider "${id}" is registered.`);
    const key = this.keyFor(id);
    if (!key && !def.keyless) throw new Error(`No API key for ${id}. Set ${def.keyEnv.join(' or ')} on the server, or an administrator sets one in the providers settings.`);
    const baseUrl = this.baseUrlFor?.(id);
    const was = this.made.get(id);
    if (was && was.key === (key ?? '') && was.baseUrl === baseUrl) return was.p;
    const p = def.create(key ?? '', baseUrl ? { baseUrl } : undefined);
    this.made.set(id, { key: key ?? '', baseUrl, p });
    return p;
  }

  /** Starts recording what a plugin's load adds; the function returned says what it added. */
  record(): () => PluginParts {
    const maps: Map<string, unknown>[] = [this.models, this.providers, this.tools, this.agents, this.mcpServers, this.gates, this.workflows, this.searchBackends];
    const lists: unknown[][] = [this.skillDirs, this.outputStyleDirs, this.hooks, this.routes, this.eventHandlers, this.vaultRotators];
    const before = maps.map((m) => new Map(m));
    const had = lists.map((l) => new Set(l));
    const shellBefore = new Map(Object.entries(this.shellHooks).map(([k, v]) => [k, new Set<unknown>(v ?? [])]));
    const closers = new Set(this.closers);
    return () => ({
      maps: maps.flatMap((m, i) => [...m].filter(([k, v]) => before[i]!.get(k) !== v).map(([key, value]) => ({ map: m, key, value, ...(before[i]!.has(key) ? { replaced: { value: before[i]!.get(key) } } : {}) }))),
      lists: lists.flatMap((l, i) => l.filter((x) => !had[i]!.has(x)).map((item) => ({ list: l, item }))),
      shell: Object.entries(this.shellHooks).flatMap(([event, specs]) => (specs ?? []).filter((x) => !shellBefore.get(event)?.has(x)).map((spec) => ({ event, spec }))),
      closers: this.closers.filter((c) => !closers.has(c)),
    });
  }

  /** Takes a plugin's contributions out (its code stays loaded; nothing reaches it any more). */
  detach(parts: PluginParts): void {
    for (const e of parts.maps) {
      if (e.map.get(e.key) !== e.value) continue; // another plugin's now
      if (e.replaced) e.map.set(e.key, e.replaced.value); else e.map.delete(e.key);
    }
    for (const e of parts.lists) { const i = e.list.indexOf(e.item); if (i >= 0) e.list.splice(i, 1); }
    for (const e of parts.shell) {
      const l = (this.shellHooks as Record<string, unknown[] | undefined>)[e.event];
      const i = l?.indexOf(e.spec) ?? -1;
      if (i >= 0) l!.splice(i, 1);
    }
  }

  /**
   * Plugins switched off (or uninstalled) while the server runs, with what they had added: what an
   * open session still holds of theirs answers with the reason instead of running.
   */
  readonly off = new Map<string, { parts: PluginParts; title: string; uninstalled?: boolean; /** A shipped solution not installed here. */ notInstalled?: boolean }>();

  /** Marks every part a plugin's load added as that plugin's (see switchedOff). */
  claim(plugin: string, parts: PluginParts): void {
    for (const e of parts.maps) if (isObj(e.value)) owned.set(e.value, { registry: this, plugin });
    for (const e of parts.lists) if (isObj(e.item)) owned.set(e.item, { registry: this, plugin });
    for (const e of parts.shell) if (isObj(e.spec)) owned.set(e.spec, { registry: this, plugin });
  }

  /** Marks `part` as made from `from` (a skill read from a plugin's skill folder). */
  claimLike(part: object, from: unknown): void {
    const o = isObj(from) ? owned.get(from) : undefined;
    if (o) owned.set(part, o);
  }

  /** The plugin a part came from, if a plugin's. */
  ownerOf(part: unknown): string | undefined { return isObj(part) ? owned.get(part)?.plugin : undefined; }

  /** The reason a plugin's part does not run, when the plugin is off; undefined while it is on. */
  offReason(plugin: string, what: string): string | undefined {
    const o = this.off.get(plugin);
    if (!o) return undefined;
    if (o.notInstalled) return `${o.title} is not installed on this server; install it (Plugins > Catalogue) to use ${what}.`;
    return o.uninstalled ? `${o.title} was uninstalled from this server; install it again to use ${what}.` : `${o.title} is switched off on this server; switch it on to use ${what}.`;
  }

  /** The switched-off plugin that had `key` in `map` (a workflow, agent, gate or tool no longer registered). */
  offOwner(map: Map<string, unknown>, key: string): string | undefined {
    for (const [name, o] of this.off) if (o.parts.maps.some((e) => e.map === map && e.key === key)) return name;
    return undefined;
  }

  /** Puts a detached plugin's contributions back. */
  attach(parts: PluginParts): void {
    for (const e of parts.maps) e.map.set(e.key, e.value);
    for (const e of parts.lists) if (!e.list.includes(e.item)) e.list.push(e.item);
    for (const e of parts.shell) {
      const l = ((this.shellHooks as Record<string, unknown[]>)[e.event] ??= []);
      if (!l.includes(e.spec)) l.push(e.spec);
    }
  }

  /** Test seam: serve a provider id with a given instance. */
  setProviderInstance(id: string, p: Provider | undefined): void {
    if (p) this.instances.set(id, p); else this.instances.delete(id);
  }

  addTool(tool: Tool, owner = 'builtin'): void {
    const name = tool.spec.name;
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error(`invalid tool name "${name}" from ${owner}`);
    if (this.tools.has(name)) throw new Error(`tool "${name}" from ${owner} is already registered`);
    this.tools.set(name, tool);
  }
}
