import type { HarnessEvent, Todo } from '../core/types.ts';
import type { ToolSpec } from '../providers/types.ts';
import type { ToolHost, ToolOutcome } from '../runtime/host.ts';

/**
 * Permission class. read: no side effects. edit: changes workspace files.
 * exec: runs commands where tools run (free in a sandbox). network: fetches
 * the web. external: acts on another system (an MCP service) - always asks
 * unless allowed. meta: talks to the harness or the user.
 */
export type ToolKind = 'read' | 'edit' | 'exec' | 'network' | 'external' | 'meta';

/** What the person did with a question (ask_user). */
export type AskOutcome = { answered: string; note?: string } | { replied: string } | { skipped: true; note?: string };

export interface FileStamp { mtimeMs: number; size: number }

/** Harness services a tool may use; absent ones are turned off. */
export interface ToolServices {
  memory?: import('../memory/store.ts').MemoryStore;
  sources?: import('../research/sources.ts').SourceStore;
  search?: import('../research/search.ts').SearchService;
  /** URLs the web tools refuse (hosts, or host/path prefixes): an eval run's own hidden checks. */
  denyUrls?: readonly string[];
  /** Publishes the workspace as a branch and pull request (absent: not possible for this session). */
  publish?(input: import('../git/publish.ts').PublishInput, signal: AbortSignal): Promise<import('../git/publish.ts').PublishResult>;
  /** Spend a tool incurred outside the model loop (a paid search), added to the session's cost. */
  charge?(what: string, cost: number): void;
  /** This session's scheduled prompts (the main agent only). */
  schedules?: {
    create(spec: { prompt: string; cron?: string; inMinutes?: number; at?: number }): Promise<import('../core/scheduler.ts').Schedule>;
    list(): Promise<import('../core/scheduler.ts').Schedule[]>;
    remove(id: string): Promise<boolean>;
  };
  /** Tells the user now: the session, and the Notification hooks. */
  notify?(message: string): Promise<void>;
  /** The session's workflows, run inside the main agent's turn. */
  workflows?: {
    list(): Promise<{ name: string; description: string; inputs: string[] }[]>;
    run(name: string, input: Record<string, string>, signal: AbortSignal): Promise<{ status: string; summary: string; cost: number }>;
    /** Starts a run detached and returns its id; the outcome reaches the agent later as a reminder. */
    start?(name: string, input: Record<string, string>): Promise<string>;
    /** The workspace's own workflow files (.harness/workflows), each with what keeps it from loading. */
    check?(): Promise<{ file: string; name?: string; loaded: boolean; problems: string[] }[]>;
  };
  /** This session's background tasks (shells, sub-agents, workflows, monitors). */
  tasks?: import('./tasks.ts').TaskService;
  /**
   * The key vault, present when the session's owner may use it. list() gives names and
   * metadata only; reveal() and envFor() give values to server-side code (to sign a
   * request, open a connection, set a command's environment), audited with the purpose,
   * and only names a plugin declared (permissions.vault). Every value handed out is
   * hidden as [vault:name] in everything the session shows or stores; never put one in
   * a tool result.
   */
  vault?: import('../vault/store.ts').VaultService;
  /**
   * The change journal (<data>/changes.jsonl): record a change a call made to a real system
   * (a deploy, an apply, a rollout, a restart), and read what changed around a time. `by`
   * and `source` default to the session's owner and the session.
   */
  changes?: {
    record(c: Omit<import('../ops/changes.ts').ChangeInput, 'by'> & { by?: string }): Promise<void>;
    query(q: import('../ops/changes.ts').ChangeQuery): Promise<import('../ops/changes.ts').ChangeEvent[]>;
  };
  /** The session's artifacts (versioned, under .harness/artifacts). */
  artifacts?: import('../core/artifacts.ts').ArtifactService;
  /** Data, dashboards and reports: the op layer, as this session's agent (src/data/tools.ts). */
  data?: import('../data/tools.ts').DataToolService;
  /** The attached client app (desktop tools). */
  client?: import('./desktop.ts').ClientService;
  /** Linked sessions, proposals, messages between sessions, hand-off, chapters (the main agent only). */
  sessions?: import('./sessions.ts').SessionsService;
}

export interface ToolContext {
  host: ToolHost;
  signal: AbortSignal;
  /** Files read this session with the mtime seen, so writes can refuse stale edits. */
  readFiles: Map<string, FileStamp>;
  todos: Todo[];
  setTodos(todos: Todo[]): void;
  emit(e: HarnessEvent): void;
  runSubagent?(args: import('../agents/agents.ts').SubagentArgs): Promise<string>;
  /** Called with a file's real path before a tool changes it (checkpoints for rewind). */
  beforeWrite?(realPath: string): Promise<void>;
  /** With `form` (a JSON Schema the session checked), the answer is the filled-in object as JSON. */
  /**
   * Asks the person; resolves with what they did: answered (the option, the text or the form's JSON, and a
   * note if they added one), replied in their own words instead, or skipped the question.
   */
  askUser?(question: string, options: string[], form?: Record<string, unknown>, choices?: import('../core/types.ts').QuestionChoice[]): Promise<string | AskOutcome>;
  proposePlan?(plan: string): Promise<{ approved: boolean; feedback?: string }>;
  isPlanMode?(): boolean;
  /** Switches the session into plan mode (the main agent only); refused where nobody could approve a plan. */
  enterPlanMode?(reason: string): { ok: boolean; reason?: string };
  services?: ToolServices;
  /** Runs another tool as this agent would (permissions, hooks, events): for run_script. */
  callTool?(name: string, input: Record<string, unknown>): Promise<{ content: string; is_error?: boolean }>;
  /** The tools this agent has. */
  toolNames?(): string[];
  /**
   * Output longer than `max`, kept whole in a session file (src/tools/spill.ts) with its head and
   * tail returned; absent where output cannot be kept (then clip it). Use clipOrSpill.
   */
  spill?(tool: string, text: string, max: number, hint?: string): Promise<string>;
}

export interface Tool {
  spec: ToolSpec;
  kind: ToolKind;
  /** Safe to run concurrently with other parallel-safe calls in the same turn. */
  parallelSafe: boolean;
  /** Runs on the user's machine when the session uses a companion host. */
  remoteable: boolean;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>;
  /** True when this call keeps something beyond the session (memory): confirmed after untrusted input. */
  persists?(input: Record<string, unknown>): boolean;
  /** Its output comes from outside the user's control (a service, stored web pages), whatever its kind. */
  untrusted?: boolean;
  /** The file a call changes (write, edit): checkpointed before it runs where the tool runs remotely (a companion). */
  writesPath?(input: Record<string, unknown>): string | undefined;
  /** Whether a call can carry data out of the session (default: from its kinds; a function may answer undefined for that); confirmed after untrusted input. */
  sendsOut?: boolean | ((input: Record<string, unknown>, where?: { hostKind?: string }) => boolean | undefined);
  /** The permission kinds this call needs, when they depend on the input (default: [kind]). */
  kindsFor?(input: Record<string, unknown>, where?: { hostKind?: string }): ToolKind[];
  /** Whether a session on this host gets the tool at all (default: yes). A tool that can only fail there is left out of every request. */
  availableIn?(host: import('../runtime/host.ts').ToolHost): boolean | Promise<boolean>;
  /** Vault entries a call puts into a command (bash's secrets): asked about like an external action unless a rule allows them. */
  vaultNames?(input: Record<string, unknown>): string[];
  /** Secret values a call carries in its own input (vault set): hidden before the call is shown, stored or sent anywhere. */
  secretInputs?(input: Record<string, unknown>): { name: string; value: string }[];
  /**
   * What "tool(spec)" permission rules match for this call (e.g. ssh_exec: "<host> <command>"):
   * the exact text, or "prefix:*", which never covers a compound command. Without it a spec matches input.path.
   */
  ruleSubject?(input: Record<string, unknown>): string;
  /** One line for permission prompts and the UI. */
  summarize(input: Record<string, unknown>): string;
  /**
   * A call that must be asked every time, of the person (the reason it is): never allowed by a rule, a
   * mode, a hook or auto mode, never "always allowed", refused where nobody can be asked. Elevated commands.
   */
  alwaysAsk?(input: Record<string, unknown>): string | undefined;
  /**
   * For dispatcher tools (tool_call): the real tool and input this call runs.
   * Permissions, hooks and validation then apply to THAT tool.
   */
  resolve?(input: Record<string, unknown>): { tool: Tool; input: Record<string, unknown> } | { error: string };
  /**
   * Whether its schema waits behind load_tools until the session needs it (src/tools/deferred.ts;
   * efficiency.deferPluginTools). Default: a plugin's tools wait, core tools do not; false keeps a
   * plugin tool every turn needs inline, true defers a rarely used core tool.
   */
  defer?: boolean;
}

export type { ToolOutcome };

export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
export const bool = (v: unknown): boolean => v === true || v === 'true';

/** Keeps the head and tail of long output; the middle is what a model needs least. */
export function clip(text: string, max: number, hint = ''): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  const dropped = text.length - head - tail;
  return `${text.slice(0, head)}\n\n[... ${dropped} characters omitted${hint ? ` - ${hint}` : ''} ...]\n\n${text.slice(text.length - tail)}`;
}

/** Long output kept whole in a session file where the session can (ctx.spill), else clipped. */
export async function clipOrSpill(ctx: Pick<ToolContext, 'spill'>, tool: string, text: string, max: number, hint = ''): Promise<string> {
  if (text.length <= max) return text;
  return ctx.spill ? ctx.spill(tool, text, max, hint) : clip(text, max, hint);
}
