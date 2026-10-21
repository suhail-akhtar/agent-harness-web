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
  create(apiKey: string): Provider;
}

export interface PluginAPI {
  readonly pluginName: string;
  readonly pluginDir: string;
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
  /** Kinds a particular call needs beyond `kind` (e.g. an option that writes files needs 'edit'). */
  kindsFor?: (input: Record<string, unknown>) => ToolKind[];
  parallelSafe?: boolean;
  /** Its output carries content from outside the user's control (web pages, a service): saving to memory afterwards is confirmed. */
  untrusted?: boolean;
  /** Whether a call can carry data out of the session (default: from its kind, or true for a plugin that declares network hosts). */
  sendsOut?: boolean | ((input: Record<string, unknown>) => boolean);
  summarize?: (input: Record<string, unknown>) => string;
  /** Whether a session on this host gets the tool at all (e.g. only where the sandbox image has the program). */
  availableIn?: Tool['availableIn'];
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
    remoteable: false,
    summarize: t.summarize ?? ((i) => `${t.name} ${JSON.stringify(i).slice(0, 80)}`),
    async run(input, ctx) {
      const r = await t.run(input, ctx);
      return typeof r === 'string' ? { content: r } : r;
    },
  };
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
  mcpServers?: Record<string, McpServerConfig>;
  hooks?: Partial<Record<HookEvent, import('../core/settings.ts').HookSpec[]>>;
  /** Directory of workflow definitions (*.json). */
  workflows?: string;
  /**
   * What the plugin needs. Enforced on the channels the harness hands out:
   * api.secret, api.fetch, and ${VAR} in its MCP servers' configuration (an
   * undeclared secret expands to nothing). Plugin code runs in the server
   * process, so this does not contain code that ignores those channels: that is
   * what signing and review are for.
   */
  permissions?: { network?: string[]; secrets?: string[] };
}
