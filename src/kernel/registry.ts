import type { ModelSpec } from '../core/models.ts';
import type { WorkflowDef } from '../graph/types.ts';
import type { HookEvent, HookSpec } from '../core/settings.ts';
import type { AgentDef, HookHandler, McpServerConfig, ProviderDef, QualityGate } from '../plugins/api.ts';
import type { Provider } from '../providers/types.ts';
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
}

export interface InProcessHook { event: HookEvent; matcher?: string; handler: HookHandler; plugin: string }

export class Registry {
  readonly models = new Map<string, ModelSpec>();
  readonly providers = new Map<string, ProviderDef>();
  readonly tools = new Map<string, Tool>();
  readonly agents = new Map<string, AgentDef>();
  readonly skillDirs: { dir: string; source: string }[] = [];
  readonly mcpServers = new Map<string, McpServerConfig & { plugin: string }>();
  readonly gates = new Map<string, QualityGate & { plugin: string }>();
  readonly workflows = new Map<string, WorkflowDef>();
  readonly hooks: InProcessHook[] = [];
  readonly shellHooks: Partial<Record<HookEvent, HookSpec[]>> = {};
  readonly plugins: LoadedPlugin[] = [];
  /** Plugin teardown, run by harness.close(). */
  readonly closers: (() => void | Promise<void>)[] = [];
  private instances = new Map<string, Provider>();

  /** Saves the registry's contents; the function returned puts them back (a failed plugin load). */
  snapshot(): () => void {
    const maps: Map<string, unknown>[] = [this.models, this.providers, this.tools, this.agents, this.mcpServers, this.gates, this.workflows, this.instances];
    const lists: unknown[][] = [this.skillDirs, this.hooks, this.plugins, this.closers];
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
    return [...this.models.values()].map((m) => ({ ...m, available: this.instances.has(m.provider) || !!this.keyFor(m.provider) }));
  }

  private keyFor(provider: string): string | undefined {
    const def = this.providers.get(provider);
    for (const k of def?.keyEnv ?? []) if (process.env[k]) return process.env[k];
    return undefined;
  }

  /** The provider instance serving a model (created on first use; keys never leave the server). */
  provider(model: ModelSpec): Provider {
    const hit = this.instances.get(model.provider);
    if (hit) return hit;
    const def = this.providers.get(model.provider);
    if (!def) throw new Error(`No provider "${model.provider}" is registered for ${model.id}.`);
    const key = this.keyFor(model.provider);
    if (!key) throw new Error(`No API key for ${model.provider}. Set ${def.keyEnv.join(' or ')} on the server.`);
    const p = def.create(key);
    this.instances.set(model.provider, p);
    return p;
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
