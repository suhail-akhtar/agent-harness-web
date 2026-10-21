import type { Effort, ModelSpec } from '../core/models.ts';
import type { WorkflowDef } from '../graph/types.ts';
import type { HookEvent } from '../core/settings.ts';
import type { Provider, JsonSchema } from '../providers/types.ts';
import type { ToolHost } from '../runtime/host.ts';
import type { SearchBackend } from '../research/search.ts';
import type { Tool, ToolContext, ToolKind, ToolOutcome, ToolServices } from '../tools/types.ts';

// The contract between the harness and everything plugged into it. A plugin
// is a folder with a harness-plugin.json manifest. Declarative contributions
// (skills, agents, MCP servers, shell hooks) need no code; a TRUSTED plugin
// (installed by the server's operator) may also ship code that registers
// tools, models, providers, quality gates and in-process hooks.

/** A named sub-agent: its own prompt, tool subset, and optionally model and effort. */
export interface AgentDef {
  name: string;
  description: string;
  prompt: string;
  /** Tool names it may use. Omit for every tool except the interactive ones. */
  tools?: string[];
  model?: string;
  effort?: Effort;
  source?: string;
}

/** timeoutMs: how long one tool call may take (default 10 minutes). */
export type McpServerConfig =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string; timeoutMs?: number }
  | { type: 'http'; url: string; headers?: Record<string, string>; timeoutMs?: number };

export interface GateResult {
  pass: boolean;
  /** One line for the agent and the UI. */
  summary: string;
  /** The evidence (trimmed output), for the agent to act on. */
  details?: string;
  /** Advisory gates report but never fail the run. */
  severity?: 'blocking' | 'advisory';
}

/** A verifier: something that proves (or disproves) the work is right. */
export interface QualityGate {
  name: string;
  description: string;
  /** Whether this gate applies to the workspace (e.g. it has a package.json). */
  applies?(host: ToolHost, signal: AbortSignal): Promise<boolean>;
  run(ctx: { host: ToolHost; signal: AbortSignal; services?: ToolServices }): Promise<GateResult>;
}

export interface HookPayload { event: HookEvent; [k: string]: unknown }
/** What a hook answers: block (with feedback the model sees), or, for PermissionRequest, decide the prompt. */
export interface HookAnswer { block?: boolean; feedback?: string; decision?: 'allow' | 'deny' }
export type HookHandler = (payload: HookPayload, ctx: { host: ToolHost; signal: AbortSignal }) => Promise<HookAnswer | void> | HookAnswer | void;

export interface ProviderDef {
  /** Environment variables that hold its key, first match wins. */
  keyEnv: string[];
  /** Works without a key (a local server): available even when no keyEnv variable is set. */
  keyless?: boolean;
  create(apiKey: string): Provider;
}

export interface PluginAPI {
  readonly pluginName: string;
  readonly pluginDir: string;
  /** A folder for the plugin's own state on this server (created on first use): outside every workspace, so no agent can edit it. */
  readonly dataDir: string;
  /** A Tool, or a plain definition ({ name, description, parameters, kind?, run }): plugins need no imports. */
  registerTool(tool: Tool | ToolDefinition): void;
  /** Resolves a path inside the session's workspace (symlink-safe); throws if it leaves it. */
  workspacePath(host: ToolHost, p: string): Promise<string>;
  registerModel(spec: ModelSpec): void;
  registerProvider(id: string, def: ProviderDef): void;
  registerAgent(def: AgentDef): void;
  registerSkills(dir: string): void;
  registerMcpServer(name: string, cfg: McpServerConfig): void;
  registerGate(gate: QualityGate): void;
  /** A web search backend for web_search (chosen with HARNESS_SEARCH=<name>, else the first available). */
  registerSearchBackend(backend: SearchBackend): void;
  /** A workflow graph (TypeScript workflows may use code nodes). Validated before every run. */
  registerWorkflow(def: WorkflowDef): void;
  on(event: HookEvent, handler: HookHandler, matcher?: string): void;
  log(message: string): void;
  /** A server secret the plugin declared in permissions.secrets (throws for undeclared names). */
  secret(name: string): string | undefined;
  /** fetch, limited to the hosts declared in permissions.network (redirects re-checked; private addresses need an exact entry). */
  fetch(url: string | URL, init?: RequestInit): Promise<Response>;
  /**
   * Rotates key vault entries of a kind or name prefix for real (changes the password
   * where it is used) when an entry is rotated; return the new value, or nothing to
   * store `generated`. `current()` reads only names declared in permissions.vault.
   */
  registerVaultRotation(handler: Omit<import('../vault/store.ts').RotationHandler, 'plugin'>): void;
}

export interface PluginDefinition {
  name: string;
  version?: string;
  setup(api: PluginAPI): void | Promise<void>;
  /** Called when the harness closes: stop processes, close connections. */
  close?(): void | Promise<void>;
}

export function definePlugin(p: PluginDefinition): PluginDefinition {
  return p;
}

/** Sugar for writing a tool: a JSON-schema'd function with a permission class. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  kind?: ToolKind;
  /** Kinds a particular call needs beyond `kind` (e.g. an option that writes files needs 'edit'); `where` says where tools run. */
  kindsFor?: Tool['kindsFor'];
  parallelSafe?: boolean;
  /** Its output carries content from outside the user's control (web pages, a service): saving to memory afterwards is confirmed. */
  untrusted?: boolean;
  /** Whether a call can carry data out of the session (default: from its kind, or true for a plugin that declares network hosts). */
  sendsOut?: Tool['sendsOut'];
  summarize?: (input: Record<string, unknown>) => string;
  /** What "tool(spec)" permission rules match (exact, or "prefix:*"), e.g. "<host> <command>". */
  ruleSubject?: Tool['ruleSubject'];
  /** Whether a session on this host gets the tool at all (e.g. only where the sandbox image has the program). */
  availableIn?: Tool['availableIn'];
  /**
   * The key vault entries a call reads (from its input; the same answer every time). Declared, they go
   * through the vault permission rules (vault(NAME) deny/ask/allow, asked unless allowed, the
   * untrusted-content guard) before the call runs, and the call can then read only those names.
   */
  vaultNames?: Tool['vaultNames'];
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome | string>;
}

export function defineTool(t: ToolDefinition): Tool {
  return {
    spec: { name: t.name, description: t.description, input_schema: t.parameters },
    kind: t.kind ?? 'exec',
    ...(t.kindsFor ? { kindsFor: t.kindsFor } : {}),
    parallelSafe: t.parallelSafe ?? false,
    ...(t.untrusted ? { untrusted: true } : {}),
    ...(t.sendsOut !== undefined ? { sendsOut: t.sendsOut } : {}),
    ...(t.availableIn ? { availableIn: t.availableIn } : {}),
    ...(t.ruleSubject ? { ruleSubject: t.ruleSubject } : {}),
    ...(t.vaultNames ? { vaultNames: t.vaultNames } : {}),
    remoteable: false,
    summarize: t.summarize ?? ((i) => `${t.name} ${JSON.stringify(i).slice(0, 80)}`),
    async run(input, ctx) {
      const r = await t.run(input, t.vaultNames ? onlyDeclared(ctx, t.name, t.vaultNames(input)) : ctx);
      return typeof r === 'string' ? { content: r } : r;
    },
  };
}

/** A call that declared its vault entries reads only those: the permission decision was about them. */
function onlyDeclared(ctx: ToolContext, tool: string, names: string[]): ToolContext {
  const v = ctx.services?.vault;
  if (!v) return ctx;
  const check = (name: string) => {
    if (!names.includes(name)) throw new Error(`${tool} may not read the vault entry "${name}" in this call: it was not among the entries the call declared (${names.join(', ') || 'none'}), which are what the permission check decided`);
  };
  const vault: NonNullable<ToolServices['vault']> = {
    list: () => v.list(),
    reveal: (name, ...rest) => { check(name); return v.reveal(name, ...rest); },
    envFor: (map, ...rest) => { for (const n of Object.values(map)) check(n); return v.envFor(map, ...rest); },
  };
  return { ...ctx, services: { ...ctx.services, vault } };
}

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  /** Code entry (trusted plugins only): a module whose default export is a PluginDefinition. */
  main?: string;
  /** Directory of skills (each a folder with SKILL.md). */
  skills?: string;
  /** Directory of agent definitions (markdown with frontmatter). */
  agents?: string;
  /** Directory of output styles: <name>.md, the body an instruction on how to reply. */
  outputStyles?: string;
  mcpServers?: Record<string, McpServerConfig>;
  hooks?: Partial<Record<HookEvent, import('../core/settings.ts').HookSpec[]>>;
  /** Directory of workflow definitions (*.json). */
  workflows?: string;
  /**
   * What the plugin needs. Enforced on the channels the harness hands out:
   * api.secret, api.fetch, ${VAR} in its MCP servers' configuration (an
   * undeclared secret expands to nothing), and the key vault its tools reach. Plugin code runs in the server
   * process, so this does not contain code that ignores those channels: that is
   * what signing and review are for.
   */
  /**
   * vault: key vault entry names (globs, "prod-*") its tools may read through
   * ctx.services.vault (reveal, envFor); any other name is refused and audited.
   */
  permissions?: { network?: string[]; secrets?: string[]; vault?: string[] };
}
