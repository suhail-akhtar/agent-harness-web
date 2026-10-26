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
  /** Its name in a settings page (default: the id). */
  label?: string;
  /** The API's address when nothing else is set (shown in settings; an administrator may set another). */
  defaultBaseUrl?: string;
  /** The environment variable the operator may set the address with (it wins over the default, not over the API's). */
  baseUrlEnv?: string;
  /** `opts.baseUrl`: an address an administrator set through the API (PUT /api/providers/:id); else the provider's own default. */
  create(apiKey: string, opts?: { baseUrl?: string }): Provider;
  /** Switches an administrator can turn on in the provider's settings (all off by default). */
  options?: Array<{ id: string; label: string; help?: string }>;
  /** What the provider offers now (its list-models endpoint), for the model picker; baseUrl is the one in use. */
  listModels?(apiKey: string, baseUrl: string, signal: AbortSignal): Promise<import('../providers/catalog.ts').LiveModel[]>;
}

export interface PluginAPI {
  readonly pluginName: string;
  readonly pluginDir: string;
  /**
   * official: shipped with the harness, or signed with an official publisher's key (HARNESS_OFFICIAL_KEYS);
   * custom: everything else. Both have the whole API and @harness/plugin-sdk/runtime.
   */
  readonly tier: 'official' | 'custom';
  /** A folder for the plugin's own state on this server (created on first use): outside every workspace, so no agent can edit it. */
  readonly dataDir: string;
  /**
   * A JSON document of the plugin's own, kept in dataDir and versioned: `version` is the shape this
   * code uses, `migrations[n]` turns version n-1 into n (run once, when old data is first read; the
   * old file is kept as <name>.v<old>.json). Writes are atomic and locked; update() is read-change-write.
   *   const db = api.store('habits', { version: 2, initial: () => ({ habits: [] }),
   *     migrations: { 2: (v1) => ({ habits: v1.habits.map((h) => ({ ...h, archived: false })) }) } });
   *   await db.update((d) => { d.habits.push(h); });
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  store<T = any>(name: string, o: import('./store.ts').StoreOptions<T>): import('./store.ts').PluginStore<T>;
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
  /**
   * Tells the people's apps that something of this plugin changed (a `plugins` event
   * {type: "signal", plugin, name}, with no data): a badge source with "signal": true reads its
   * route again at once. At most one per name each second.
   */
  signal(name: string): void;
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
  /**
   * An HTTP endpoint at /api/plugins/<plugin>/<path> (needs "permissions": {"routes": true}).
   * auth 'token': the harness makes a random secret for the route, kept as a hash in the data
   * folder; an administrator gets it once from GET /api/plugin-routes (and a new one with
   * POST /api/plugin-routes/<plugin>/<path>/rotate); callers send it as ?token= or the
   * x-harness-route-token header. auth 'none': the plugin checks the caller itself (a
   * signing secret such as Slack's or GitHub's) - every request reaches the handler.
   * auth 'user': signed in like the rest of the API (the desktop, the web UI, an account's
   * token; a POST needs the x-harness header), and the handler gets who asked (`user`): for
   * a plugin's own pages (their frames call it with routes.call), read their data per person.
   * Rate-limited per address like triggers; bodies up to 1 MB. Whatever a route passes on
   * to an agent is outside data: use sessions.start/send with untrusted: true.
   */
  registerRoute(route: PluginRoute): void;
  /** Every session's events, harness-wide (needs permissions.sessions). Returns the unsubscribe. */
  readonly events: { subscribe(handler: PluginEventHandler): () => void };
  /** Starts, drives and answers sessions (needs permissions.sessions; a server harness only). */
  readonly sessions: PluginSessions;
  /** The framework's change journal (<data>/changes.jsonl). */
  readonly changes: import('../ops/changes.ts').ChangeService;
  /**
   * Several servers on one data folder: true when this server holds (or just took) the
   * plugin's lease of that name - run server-side loops only then. True on a single server;
   * false where background work is off (HarnessOptions.backgroundWork, HARNESS_PLUGIN_LOOPS=off: evals, the CLI).
   */
  lease(name: string): Promise<boolean>;
  /**
   * The key vault for the plugin's server code (a webhook's signing secret, a chat bot's
   * token): operator-scope entries only. list(): those its permissions.vault globs cover
   * (metadata, never values), each with whether it is granted. reveal(): the value of one
   * an administrator granted it - the entry's allow list includes "plugin:<name>" (POST
   * /api/vault/entries/<name>/allow) - refused otherwise; audited as plugin:<name> with the
   * purpose. A value read here is hidden as [vault:name] in whatever the plugin passes to a
   * session. Absent without permissions.vault, when the vault is off, or outside a server harness.
   */
  readonly vault?: {
    list(): Promise<(import('../vault/store.ts').VaultEntryInfo & { granted: boolean })[]>;
    reveal(name: string, purpose: string): Promise<string>;
  };
}

/** What a route handler gets: the raw body (verify signatures over it), lowercased headers, the query without the token. */
export interface PluginRouteRequest {
  method: string; path: string; query: Record<string, string>; headers: Record<string, string>; body: Buffer; ip: string;
  /** auth 'user' only: who asked (id is absent for the operator's own token). */
  user?: { id?: string; name: string; role: 'admin' | 'member' };
}
export interface PluginRouteResponse { status: number; headers?: Record<string, string>; body?: string | Buffer | object }
export interface PluginRoute {
  method: 'GET' | 'POST';
  /** Relative to /api/plugins/<plugin>/ (letters, digits, . _ - and /). */
  path: string;
  auth: 'token' | 'none' | 'user';
  handler: (req: PluginRouteRequest) => Promise<PluginRouteResponse>;
}

export type PluginEventHandler = (e: { sessionId: string; owner?: string; title: string; event: import('../core/types.ts').HarnessEvent }) => void | Promise<void>;

export interface PluginSessionStart {
  title: string;
  /** The account that owns it (default: the operator's, no account). */
  owner?: string;
  model?: string;
  /** Default dontAsk: nobody is watching a session a plugin started. */
  mode?: import('../core/types.ts').PermissionMode;
  /** Default: a server folder of its own ({ kind: 'local', network: 'none' }). */
  runtime?: import('../core/session.ts').SessionMeta['runtime'];
  /** The first message. With untrusted, it is outside data: fenced, after `instructions`. */
  prompt?: string;
  /** With untrusted and a prompt: the plugin's own instructions, put before the fenced prompt. */
  instructions?: string;
  /** Runs a workflow instead of a prompt. With untrusted, every input value is fenced as outside data. */
  workflow?: { name: string; input: Record<string, string> };
  /** What it carries came from outside (a webhook, a chat): fenced, and the session counts as having read untrusted content. */
  untrusted?: boolean;
}

export interface PluginSessions {
  start(o: PluginSessionStart): Promise<{ id: string }>;
  /** A message to the session (queued when it is working). With untrusted, fenced as outside data. */
  send(id: string, text: string, o?: { untrusted?: boolean }): Promise<void>;
  /**
   * Answers a pending request (permission_request, question, approval_request, plan_proposed)
   * on someone's behalf: `by` names them, and every answer is audited. False when there is
   * no such pending request. Refused for a session outside the plugin's reach (see README) and
   * for allowing a tool call the session's deny rules cover.
   */
  respond(id: string, requestId: string, d: { decision: 'approve' | 'reject' | 'allow' | 'deny' | 'answer'; feedback?: string; answer?: string; by: string }): Promise<boolean>;
  get(id: string): { id: string; title: string; owner?: string; status: string } | undefined;
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
  /** false: its schema is in every request even when the session defers plugin tools (a tool most turns use). */
  defer?: boolean;
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
    ...(t.defer !== undefined ? { defer: t.defer } : {}),
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
  /**
   * sessions: api.sessions and api.events (start, drive and answer sessions; see every
   * session's events). routes: api.registerRoute (HTTP endpoints under /api/plugins/<name>/).
   */
  /**
   * processes: its code starts programs on the server itself (not where the session runs): shown to people
   * before they add it, and the review flags code that does so without declaring it.
   */
  permissions?: { network?: string[]; secrets?: string[]; vault?: string[]; sessions?: boolean; routes?: boolean; processes?: boolean };
  /**
   * The plugin's UI half (navigation entries, pages, panels, commands, settings sections,
   * renderers...): see packages/plugin-ui. Validated with validateUiManifest when the plugin
   * loads; a bad section is reported (uiError) and never stops the server half.
   */
  ui?: unknown;
  /**
   * A standalone solution shipped with the harness (Studio, Operations, Engineering, DevOps): on a server
   * that installs solutions one by one (HarnessOptions.solutions = 'installed'), it loads only once
   * installed (the Catalogue), in any mix; the core never needs it. `title`: its name in the catalogue.
   */
  solution?: { title?: string; summary?: string } | true;
  /** Plugins it needs loaded first (it imports from them or uses their tools): installing it installs them. */
  requires?: string[];
}
