/**
 * The shapes the harness HTTP API speaks. Shared by the desktop and the browser UI.
 *
 * Endpoints marked "new" are being added to the server alongside the desktop; the client
 * treats a 404 from them as "this server does not have it yet" and falls back (see http.ts).
 */

import type { UiManifest } from '@harness/plugin-ui';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type Mode = 'default' | 'acceptEdits' | 'auto' | 'dontAsk' | 'plan' | 'bypass';
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export const MODES: readonly Mode[] = ['default', 'acceptEdits', 'auto', 'dontAsk', 'plan', 'bypass'];

export interface ModelInfo { id: string; label: string; provider: string; contextWindow: number; compactAt: number; effort: Effort; efforts: Effort[]; available: boolean; vision?: boolean; notes?: string; /** The picker's group (newer servers). */ tier?: 'frontier' | 'balanced' | 'fast'; maxOutput?: number; /** The long edge (px) attached images are scaled to for this model (newer servers). */ imageMaxEdge?: number; /** USD per million tokens (newer servers). */ price?: { input: number; output: number } }
/** What a provider offers now (GET /api/models/live); known: the harness has its spec and can run it. */
export interface LiveProviderModels { id: string; label: string; error?: string; models: Array<{ id: string; name?: string; created?: number; known: boolean }> }
export interface MachinePolicyInfo { swarm: boolean; kinds: string[]; maxJobs: number; sandboxRequired: boolean }
export interface CompanionInfo {
  id: string; name: string; online: boolean; info: { platform: string; root: string; version?: string; sandbox?: string; network?: 'none' | 'full'; policy?: MachinePolicyInfo; policySigned?: boolean } | null;
  /** When its token stops working (a companion that polls gets a fresh one well before). */
  expiresAt?: number;
  /** Jobs it is running now. */
  running?: number;
  /** Its own key is pinned: every result must be signed with it. */
  keyed?: boolean;
}
export interface Me { id?: string; name: string; role: 'admin' | 'member'; email?: string; spentToday?: number; accounts?: boolean }
export interface Config {
  models: ModelInfo[];
  runtimes: { docker: boolean; dockerImage: string | null; dockerImages?: string[]; local: boolean; localRoots: string[] };
  companions: CompanionInfo[];
  plugins?: { name: string; version: string; description: string; contributes: string[]; signature?: string; permissions?: { network?: string[]; secrets?: string[] } }[];
  search?: string | null;
  outputStyles?: string[];
  me?: Me;
}
export interface Usage { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number }
/** activeForm: the step as it is being done ("Running the tests"), shown while it is in progress. */
export interface Todo { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }
/** What fills a conversation's context: estimated parts; the messages are the rest of the provider's count of the last request. */
export interface ContextBreakdown {
  model: string;
  window: number;
  /** Where the context is compacted (the room above it is the compaction buffer). */
  compactAt: number;
  used: number;
  /** used is the provider's own count (false: an estimate, nothing sent yet). */
  measured: boolean;
  parts: Array<{ id: string; label: string; tokens: number }>;
  /** Tools whose schemas wait until loaded (no room taken). */
  deferred: { tools: number; tokens: number };
  compactions: number;
}

export interface SessionMeta {
  id: string; title: string; model: string; effort: Effort; mode: Mode;
  runtime: { kind: 'docker' | 'local' | 'companion'; network: 'none' | 'full' | 'allowlist'; companionId?: string; path?: string; image?: string };
  createdAt: number; updatedAt: number; usage: Usage; cost: number; todos: Todo[];
  byModel: Record<string, { usage: Usage; cost: number; requests: number }>;
  contextStart: number; compactions: number; lastPromptTokens: number; status?: SessionStatus;
  /** New server fields (absent on older servers). */
  archived?: boolean; pinned?: boolean; group?: string; forkedFrom?: string | { id: string; turn: number };
  /** The app declared when the session was made. */
  client?: { kind: string; version?: string; renderers?: string[]; tools?: string[] };
  /** A linked session: the session that started it, and how deep it is. */
  parent?: string; linkDepth?: number;
  /** Linked sessions this one started (newest last), and tasks it handed off. */
  linked?: string[]; handoffs?: { id: string; title: string; at: number }[];
  /** Chapters the agent marked (mark_chapter): a table of contents. */
  chapters?: Chapter[];
  /** Spent by agents on other models than the session's (delegation). */
  delegationCost?: number;
  turns?: number;
}
export interface Chapter { index: number; title: string; summary?: string; at?: number; turn?: number }
export type SessionStatus = 'idle' | 'running' | 'waiting';

export interface ImageData { media_type: string; data: string }
export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean; images?: ImageData[] }
  | { type: 'reasoning'; text: string }
  | { type: 'image'; media_type: string; data: string }
  | { type: 'document'; media_type: string; data: string; name?: string };
export interface Message { role: 'user' | 'assistant'; content: Block[]; compactionSummary?: boolean }

export type ToolDisplay =
  | { type: 'diff'; path: string; before: string; after: string }
  | { type: 'file'; path: string; lines: number }
  | { type: 'text'; text: string };

export interface WorkflowRunView {
  id: string; workflow: string; status: string; current?: string; cost: number; error?: string;
  /** The conversation's length (stored messages) when it started: where its card goes (newer servers). */
  at?: number;
  /** Waiting at a node whose plugin is switched off on the server (it carries on when that is switched on). */
  paused?: { node: string; plugin: string; reason: string };
  nodes: WorkflowNodeView[];
  /** The first node (newer servers). */
  start?: string;
  history: { node: string; type: string; status: string; outcome?: string; summary?: string; startedAt: number; endedAt?: number; cost?: number }[];
}
export interface WorkflowInfo { name: string; description: string; source?: string; inputs: Record<string, { description?: string; required?: boolean; default?: string }>; nodes: WorkflowNodeView[]; start?: string }

/** A workflow node as a run shows it: its type and title, and (newer servers) its agent, model and where it goes next. */
export interface WorkflowNodeView { id: string; type: string; title?: string; agent?: string; model?: string; next?: string[] }

/** Background work: a shell, a sub-agent, a workflow run or a monitor. */
export interface TaskView { id: string; kind: 'shell' | 'agent' | 'workflow' | 'monitor'; description: string; status: 'running' | 'completed' | 'failed' | 'stopped'; startedAt: number; endedAt?: number; owner: string; cost?: number }

export type HarnessEvent =
  | { kind: 'turn_start'; turn: number; agent?: string }
  /** origin: not typed by the person (a linked session's report or message woke it: auto; a linked session's brief: link). */
  | { kind: 'user_message'; text: string; images?: ImageData[]; origin?: 'auto' | 'link' | 'person' }
  | { kind: 'text_delta'; text: string; agent?: string }
  | { kind: 'reasoning_delta'; text: string; agent?: string }
  | { kind: 'assistant_message'; message: Message; agent?: string }
  | { kind: 'tool_call'; id: string; name: string; input: Record<string, unknown>; agent?: string }
  | { kind: 'tool_result'; id: string; name: string; content: string; is_error: boolean; display?: ToolDisplay; ms: number; agent?: string; images?: ImageData[] }
  | { kind: 'permission_request'; requestId: string; tool: string; summary: string; input: Record<string, unknown>; suggestion?: string; agent?: string }
  /** `form`: a JSON Schema the answer fills in (an object); `agent`: a sub-agent asked. */
  | { kind: 'question'; requestId: string; question: string; options: string[]; /** The suggested answers with what each does, the recommended one first. */ choices?: Array<{ label: string; description?: string; recommended?: boolean }>; form?: Record<string, unknown>; agent?: string }
  | { kind: 'plan_proposed'; requestId: string; plan: string }
  | { kind: 'approval_request'; requestId: string; runId: string; node: string; title: string; message: string; files: { path: string; content: string }[] }
  | { kind: 'workflow'; phase: 'started' | 'node_started' | 'node_finished' | 'finished'; node?: string; run: WorkflowRunView }
  | { kind: 'request_resolved'; requestId: string; decision: string; answer?: string }
  | { kind: 'usage'; model: string; usage: Usage; cost: number; contextTokens: number; contextWindow: number; agent?: string }
  | { kind: 'todos'; todos: Todo[] }
  | { kind: 'mode'; mode: Mode }
  | { kind: 'compaction'; before: number; after: number; summaryTokens: number }
  /** notify: the agent asked to tell the person now (notify_user): it reaches them outside the conversation too. */
  | { kind: 'notice'; level: 'info' | 'warn' | 'error'; text: string; agent?: string; notify?: boolean }
  /** A progress review at a step checkpoint: started, extended, refreshed (a fresh start), stopped, a flagged "done", a test-discipline nudge. */
  | { kind: 'progress'; phase: 'checkpoint' | 'extended' | 'refreshed' | 'stopped' | 'flagged' | 'nudge'; step: number; budget: number; by: 'signals' | 'review'; text: string; reasons: string[]; verdict?: string; advice?: string; agent?: string }
  /** A delegated agent's work checked by the harness: its done criteria (run by the harness), or a verifier's verdict. */
  | { kind: 'swarm'; phase: 'start' | 'refused' | 'stopped'; agent?: string; parent?: string; depth?: number; reason?: string; started?: number; limit?: number }
  | { kind: 'acceptance'; agent: string; phase: 'checks' | 'verdict' | 'compare'; round: number; results?: AcceptanceCheck[]; verifier?: string; verifierModel?: string; verdict?: 'pass' | 'fail' | 'unknown'; requirements?: AcceptanceRequirement[]; replicas?: AcceptanceReplica[]; agree?: boolean; issues?: AcceptanceIssue[]; overruled?: string; blocked?: string; findings?: AcceptanceFinding[] }
  | { kind: 'retry'; attempt: number; delayMs: number; reason: string }
  | { kind: 'turn_end'; reason: string; agent?: string }
  | { kind: 'status'; status: SessionStatus }
  | { kind: 'task'; phase: 'started' | 'finished'; task: TaskView }
  /** An artifact was made or got a new version (its own kind is markdown, html, ...). */
  | { kind: 'artifact'; artifact: { id: string; title: string; kind: string; version: number; action: 'create' | 'update' | 'rewrite' } }
  /** A desktop tool call for the attached app to answer (POST /api/sessions/:id/client-result). */
  | { kind: 'client_call'; callId: string; tool: string; input: Record<string, unknown> }
  | { kind: 'client_call_end'; callId: string; ok: boolean; reason: string }
  /** A session the agent offered to start: nothing runs until the person starts it. */
  | { kind: 'session_proposal'; id: string; title: string; brief: string; initiation: 'offer' | 'own_initiative'; context: 'fork' | 'fresh'; useWorktree?: boolean; model?: string; effort?: string; expiresAt: number }
  | { kind: 'proposal_resolved'; id: string; status: 'started' | 'dismissed' | 'expired'; sessionId?: string }
  /** A linked session started from this one, its report at the end of a turn, or a message from another session. */
  | { kind: 'side_session'; phase: 'started' | 'report' | 'message'; id: string; title: string; reason?: string; preview?: string }
  | { kind: 'chapter'; title: string; summary?: string; index: number };

/** A request waiting for a person: a tool permission, a question, a plan, a workflow approval. */
export type PendingRequest = Extract<HarnessEvent, { kind: 'permission_request' | 'question' | 'plan_proposed' | 'approval_request' }>;
export const PENDING_KINDS = ['permission_request', 'question', 'plan_proposed', 'approval_request'] as const;
export function isPending(e: HarnessEvent): e is PendingRequest { return (PENDING_KINDS as readonly string[]).includes(e.kind); }

/** One line of a session's event stream (SSE data). */
export interface SessionEventEnvelope { seq: number; event: HarnessEvent; at?: number }

export interface SessionDetail { meta: SessionMeta; status: SessionStatus; history: Message[]; pending: HarnessEvent[]; lastSeq: number; tasks?: TaskView[] }
export interface SessionsPage { sessions: SessionMeta[]; next: string | null }
export interface HistoryPage { total?: number; after?: number; messages: Message[]; next?: number | null }

/**
 * A request waiting for a person, with its session (GET /api/approvals, the approvals topic's
 * "added" shape). "request" is the full event when the client has it (from the session's pending
 * list); the summary fields are always there.
 */
export interface Approval { sessionId: string; requestId: string; kind: PendingRequest['kind']; /** The session's title. */ title?: string; summary?: string; tool?: string; at: number; request?: PendingRequest }

/** The global stream (GET /api/events): `data:{seq,topic,payload}`. */
export type EventTopic = 'sessions' | 'session' | 'approvals' | 'schedules' | 'inbox' | 'plugins' | 'notices' | 'proposals' | 'linked' | 'artifacts' | 'chapters' | 'client' | 'noticing' | 'mcp';
export interface GlobalEvent { seq: number; topic: EventTopic | string; payload: unknown }

export interface Capabilities {
  tools: { name: string; kind: string }[];
  agents: { name: string; description: string; source?: string }[];
  skills: { name: string; description: string; source: string }[];
  mcp: { name: string; scope: string; ok: boolean; tools: number; error?: string }[];
  plugins: { name: string; version: string; description: string; contributes: string[] }[];
}

export interface Health { ok: boolean; version?: string; apiVersion?: number; uptimeSec?: number; node?: string; /** Set when the server has no /api/health and the client checked another way. */ legacy?: boolean }
export interface VersionInfo { version: string; apiVersion?: number; uiApiVersion?: number }

/** A model provider (GET /api/providers, new). Keys are never returned, only whether one is set and where from. */
export interface ProviderInfo {
  id: string; label?: string; keyEnv?: string[]; configured: boolean; source?: 'env' | 'vault' | 'none' | string;
  baseUrl?: string | null; baseUrlEditable?: boolean; models?: string[]; keyless?: boolean; note?: string;
  /** The provider's switches (off by default), with their current values. */
  options?: Array<{ id: string; label: string; help?: string; value: boolean }>;
}
export interface ProviderTest { ok: boolean; latencyMs?: number; model?: string; error?: string }

/** What a solution's bundle added (POST /api/plugins/import): its plugins, and those already at that version. */
export interface SolutionImportInfo { solution: { name: string; title: string; version: string }; plugins: PluginInfo[]; unchanged: string[] }

/** A plugin as the server lists it (GET /api/plugins, new). */
export interface PluginInfo {
  name: string; version: string; description?: string; enabled: boolean; required?: boolean;
  source?: 'bundled' | 'installed' | 'operator' | 'catalogue' | 'dev' | string;
  contributes?: string[]; signature?: string; permissions?: Record<string, unknown>;
  ui?: UiManifest; uiError?: string; uiHash?: string; /** Where the server serves this plugin's UI files: /api/plugins/<name>/ui/ */ uiBase?: string;
  /** The plugin has a guide for agents (skill `<name>-guide` in a desktop session): its one-sentence purpose. */
  guide?: { purpose: string };
  /** official: shipped with the harness or signed by an official publisher; custom: everything else. */
  tier?: 'official' | 'custom';
  /** The bundle: how it is shown, who publishes it, its links, licence and changelog, which harness versions it runs on. */
  info?: PluginBundleInfo;
  /** A newer version found by the last update check. */
  update?: PluginUpdateInfo;
  error?: string;
}
export interface PluginBundleInfo {
  displayName: string; icon?: string; /** data: URL of its icon image */ iconData?: string; tags: string[]; category?: string;
  author?: { name: string; email?: string; url?: string }; publisher?: { name: string; url?: string; email?: string }; license?: string;
  links: { homepage?: string; docs?: string; support?: string; privacy?: string; terms?: string; repository?: string };
  changelog?: string; compat: { harness?: string; ok: boolean; reason?: string }; updatesUrl?: string;
}
export interface PluginUpdateInfo { name: string; version: string; latest: string; from: string }
export interface PluginRevisionInfo { id: string; version: string; at: number }
export interface CatalogueEntry { name: string; version: string; description?: string; installed?: boolean; url?: string; /** A solution shipped with the harness (Studio, Operations, ...): installed one by one, in any mix. */ solution?: { title: string; requires: string[]; requiredBy: string[] } }
/** A deep review of a plugin (POST /api/plugins/review; src/plugins/review.ts). */
export interface PluginReviewFinding { level: 'error' | 'warning' | 'info'; area: string; message: string; fix?: string }
export interface PluginReview {
  ok: boolean; score: number; plugin: string; version: string; dir: string;
  adds: { tools: string[]; skills: string[]; agents: string[]; workflows: string[]; gates: string[]; routes: string[]; pages: number };
  findings: PluginReviewFinding[];
  tests?: { files: number; passed: boolean; output: string };
  durationMs: number;
}

export interface FileEntry { name?: string; path: string; size?: number; mtime?: number; type?: 'file' | 'dir'; heavy?: boolean; symlink?: boolean; children?: FileEntry[] }
export interface FileTree { path: string; entries: FileEntry[]; truncated?: boolean }
export interface SearchHit { path: string; matches?: Array<{ line: number; text: string }> }
export interface FileContent { type: 'file'; path: string; size: number; content: string | null; note?: string }
export interface GitStatus { repo: boolean; branch?: string; upstream?: string; ahead?: number; behind?: number; files: { path: string; from?: string; index: string; worktree: string }[]; clean?: boolean }
export interface GitLogEntry { hash: string; subject: string; author?: string; email?: string; at?: number }

export interface VaultEntry { name: string; kind?: string; scope?: string; description?: string; updatedAt?: number; createdAt?: number; backend?: string; rotateBy?: number; allow?: string[] }
/** A schedule or trigger (GET /api/schedules). A trigger's secret URL is shown once, when it is made. */
export interface Schedule {
  id: string; title?: string; prompt: string; cron?: string; at?: number; enabled: boolean;
  nextRun?: number | null; lastRun?: number | null; lastResult?: string; runs?: number; createdAt?: number;
  sessionId?: string; newSession?: { model: string; runtime: { kind: string; path?: string; network?: string }; mode?: string };
  trigger?: boolean; url?: string;
  /** The IANA time zone its cron is read in (absent: the server's). */
  timeZone?: string;
  /** A run missed while the server was down: once (run it when back, the default) or skip. */
  misfire?: 'once' | 'skip';
  /** The most one run may cost, in USD. */
  maxCostUsd?: number;
  /** How long a run waits for the person when it asks (in their inbox), in minutes; then the safe answer. */
  askTimeoutMinutes?: number;
  /** It runs this workflow instead of sending its prompt. */
  workflow?: { name: string; input: Record<string, string> };
  /** When it runs, in words ("Every weekday at 09:00"), and (repeating ones) its next runs. */
  when?: string;
  upcoming?: number[];
  /** The conversation whose agent set it up. */
  createdBy?: string;
  /** It runs when this changes (checked without a model) instead of at a time. */
  watch?: WatchSpec;
  /** Its watch's last look: when, whether it failed, how many changes wait to run, whether it has looked yet. */
  watchState?: { checkedAt?: number; error?: string; pending: number; seen: boolean };
  /** What its results do: interrupt every time (absent), only when it matters, go to the digest, or stay in its history. */
  notify?: 'always' | 'important' | 'digest' | 'silent';
}
/** How useful a schedule has been, the last 30 days (GET /api/schedules/stats). */
export interface ScheduleStats { runs: number; found: number; failed: number; skipped: number; updates: number; opened: number; dismissed: number; notUseful: number; ignored: number; costUsd: number; quieter?: string }
/** The person's limits on interruptions (GET/PUT /api/inbox/settings). */
export interface Interruptions { quietFrom?: string; quietTo?: string; timeZone?: string; maxPerDay?: number; digestAt?: string }
/** What a watch looks at: a command's output, files in the folder, commits on a branch, a web page or API. */
export interface WatchSpec { kind: 'command' | 'files' | 'git' | 'url'; command?: string; paths?: string[]; branch?: string; url?: string; match?: string; everyMinutes: number; settleSeconds?: number; onlyWhen?: string }
/** What unattended work left for the person (GET /api/inbox). */
export interface InboxItem {
  id: string; kind: 'result' | 'message' | 'suggestion' | 'digest' | 'noticed'; title: string; body: string; at: number; level: 'info' | 'warn' | 'error';
  /** It interrupted the person; else why it waited (its schedule's policy, the digest, quiet hours, the day's most). */
  alert?: boolean; held?: 'policy' | 'digest' | 'quiet' | 'budget';
  status: 'new' | 'read' | 'dismissed' | 'done'; sessionId?: string; scheduleId?: string; runId?: string; proposalId?: string;
  readAt?: number; snoozedUntil?: number; resolvedAt?: number; reason?: 'not_useful' | 'wrong' | 'bad_timing' | 'other'; note?: string;
  /** Noticed by the harness itself: which detector; shown in its conversation too (inline); a schedule it offers (draft); a message it offers to send (action). */
  detector?: NoticeDetector; fingerprint?: string; project?: string; inline?: boolean;
  draft?: NoticedDraft; action?: { label: string; prompt: string };
}
/** An agent: a specialist with its role, instructions, model, tools, MCP servers, skills, autonomy and limits (Claude Code's agent fields). */
export interface AgentDef {
  name: string;
  /** When to use it: what the orchestrator reads to choose it. */
  description: string;
  /** Its role and instructions (absent in the catalogue for built-in and plugin agents). */
  prompt?: string;
  tools?: string[]; disallowedTools?: string[]; model?: string; effort?: Effort;
  mcpServers?: string[]; skills?: string[];
  permissionMode?: 'default' | 'acceptEdits' | 'auto' | 'dontAsk' | 'plan';
  maxTurns?: number; maxCostUsd?: number; isolation?: 'worktree'; background?: boolean;
  modelInvocable?: boolean; userInvocable?: boolean; color?: string;
  /** A team: it leads these agents (in parallel where the work splits), and its reviewer checks their work. */
  team?: { members: string[]; reviewer?: string };
}
/** One of the person's own agents (GET /api/me/agents). */
export interface AgentRecord extends AgentDef { prompt: string; owner?: string; version: number; createdAt: number; updatedAt: number; enabled: boolean }
/** An agent in the catalogue (GET /api/agents): built-in, a plugin's, or the person's own. */
export type AgentInfo = (AgentDef | AgentRecord) & { source: 'builtin' | 'plugin' | 'user'; plugin?: string; version?: number; enabled?: boolean };
/** What an agent can be given on this server (GET /api/agents/options). */
export interface AgentOptions {
  tools: Array<{ name: string; kind: string; description: string }>;
  mcpServers: string[];
  skills: Array<{ name: string; description: string }>;
  models: Array<{ id: string; label?: string; provider: string; efforts: Effort[] }>;
}

/** One done criterion as the harness ran it. */
export interface AcceptanceCheck { label: string; ok: boolean; detail: string; hidden?: boolean }
/** One issue a verifier found, where it is. */
export interface AcceptanceIssue { file?: string; line?: number; problem: string }
/** A requirement of the brief as the verifier found it. */
export interface AcceptanceRequirement { requirement: string; status: 'met' | 'unmet' | 'unverifiable' }
/** At critical stakes: one of the two independent replicas, and how the harness found its work. */
export interface AcceptanceReplica { agent: string; model: string; outcome: string }
/** An added line that can game a check (a skipped test, an early exit): for a closer look, not a failure. */
export interface AcceptanceFinding { file: string; line?: number; why: string; text: string }

/** A tool's policy on a person's MCP server: auto (the server's read-only hint decides), allow, ask, block. */
export type McpToolPolicy = 'auto' | 'allow' | 'ask' | 'block';
/** What a person's MCP server is: a URL (http) or, for an administrator, a command (stdio). Secrets are ${vault:name}. */
export interface McpServerConfig {
  name: string; description?: string; type: 'http' | 'stdio';
  url?: string; headers?: Record<string, string>;
  command?: string; args?: string[]; env?: Record<string, string>; cwd?: string;
  timeoutMs?: number; oauth?: { clientId?: string; clientSecret?: string; scope?: string };
}
/** A person's MCP server (GET /api/me/mcp). */
export interface McpServerView extends McpServerConfig {
  enabled: boolean; version: number; updatedAt: number; source?: string;
  policies: Record<string, McpToolPolicy>;
  /** The vault entries it uses. */
  vault: string[];
  signedIn: boolean;
  /** As last seen (absent: not connected since the server started). */
  status?: { ok: boolean; error?: string; needsSignIn?: boolean; tools: number; pending: number; protocol?: string; server?: string; checkedAt: number };
}
/** A tool on a person's server: approved, new, or changed since it was approved (new and changed wait for the person). */
export interface McpToolView { name: string; title?: string; description?: string; readOnly: boolean; policy: McpToolPolicy; state: 'approved' | 'new' | 'changed' }
/** Connecting to a server now (POST /api/me/mcp/:name/test). */
export interface McpTestResult {
  ok: boolean; error?: string; needsSignIn?: boolean; protocol?: string; serverInfo?: { name?: string; version?: string }; instructions?: string;
  tools: McpToolView[]; resources: Array<{ uri: string; name?: string; description?: string }>; prompts: Array<{ name: string; description?: string }>;
}
/** What a pasted config holds (POST /api/me/mcp/import). */
export interface McpImportResult { format: string; servers: Array<{ config: McpServerConfig; warnings: string[]; disabled?: boolean }>; vault: string[]; errors: string[]; added?: string[] }

/** A tool of a server the builder makes: what it does, and how (an HTTP call, a command, SQL, code). */
export interface McpBuildTool {
  name: string; title?: string; description: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown>;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  run: { kind: 'http'; method: string; url: string; query?: string[]; body?: 'args' | string[]; headers?: Record<string, string> } | { kind: 'command'; command: string; args: string[] } | { kind: 'sql'; sql: string; params?: string[] } | { kind: 'code'; code: string };
  example?: Record<string, unknown>;
}
/** What a built server offers (its spec.json). */
export interface McpBuildSpec {
  name: string; title?: string; version: string; description: string; instructions?: string;
  env: Array<{ name: string; description: string; required?: boolean; secret?: boolean; default?: string }>;
  database?: { kind: 'sqlite' | 'duckdb'; path: string; write?: boolean };
  tools: McpBuildTool[];
}
/** Where a draft comes from. */
export type McpBuildSource =
  | { source: 'openapi'; text?: string; url?: string; only?: string[]; name?: string }
  | { source: 'database'; kind: 'sqlite' | 'duckdb'; path: string; tables?: string[]; write?: boolean; name?: string }
  | { source: 'description'; description: string; model?: string }
  | { source: 'command'; command: string; description?: string; model?: string };
export interface McpBuildDraft { spec: McpBuildSpec; operations?: Array<{ name: string; method: string; path: string; summary: string; readOnly: boolean }>; skipped?: string[]; tables?: Array<{ name: string; columns: Array<{ name: string; type: string }> }>; costUsd?: number }
/** A server the builder made: its spec, its check, its bundle. */
export interface McpBuildRecord {
  name: string; spec: McpBuildSpec; source: string; builtAt: number; registered?: boolean; bundle?: { bytes: number; at: number };
  report?: { ok: boolean; protocol?: string; tools: number; checks: Array<{ name: string; ok: boolean; detail?: string }> };
}

/** A schedule a finding offers: the person's own words, at the time they usually asked. */
export interface NoticedDraft { title: string; prompt: string; cron?: string; timeZone?: string; folder?: string; model?: string }
export type NoticeDetector = 'away_failure' | 'routine_health' | 'stuck' | 'repeated_task';
/** What the harness notices by itself, its detectors and what it observed (GET /api/noticing). */
export interface NoticingOverview {
  enabled: boolean;
  /** off: nothing observed; practice: findings written down, not shown; on: shown. */
  mode: 'off' | 'practice' | 'on';
  practiceSince?: number; practiceDays: number;
  /** Practice ran its days: time to look at what it would have said. */
  ready: boolean;
  detectors: Array<{ id: NoticeDetector; title: string; blurb: string; enabled: boolean; state: 'on' | 'digest' | 'off'; why?: string; stats: { shown: number; acted: number; notUseful: number; badTiming: number; ignored: number; holdout: number; selfFound: number; practice: number } }>;
  practice: Array<{ at: number; detector: NoticeDetector; title: string; body: string; level: 'info' | 'warn' | 'error'; sessionId?: string; scheduleId?: string; draft?: NoticedDraft }>;
  observed: { commands: number; failed: number; edits: number; turns: number; typed: number; projects: number; since?: number; days: number };
  today: { shown: number; alerts: number };
  limits: { perDay: number; alertsPerDay: number; keepDays: number };
}
/** One run of a schedule or trigger (GET /api/schedules/:id/runs, /api/schedule-runs). */
export interface ScheduleRun {
  id: string; scheduleId: string; title: string; by: 'schedule' | 'trigger' | 'manual' | 'watch';
  startedAt: number; endedAt?: number;
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'skipped' | 'interrupted';
  reason?: string; sessionId?: string; costUsd?: number; summary?: string;
  tools?: number; actions?: number; notified?: boolean; noOp?: boolean; waited?: number; proposed?: number; refused?: number;
}
export interface McpBundle { name: string; version: string; description?: string; installedAt?: number }
export interface EffectiveSetting { key: string; value: unknown; source: 'default' | 'operator' | 'account' | 'project' | string; scope?: string; locked?: boolean; max?: number; layers?: Array<{ source: string; value: unknown }> }

/** A file attached to a message (POST messages, new). */
export interface Attachment { name: string; mediaType: string; base64: string }

/** An artifact (GET /api/sessions/:id/artifacts): versioned files the agent made for the person. */
export interface ArtifactVersionInfo { n: number; at: number; size: number; action: 'create' | 'update' | 'rewrite'; file: string }
export interface ArtifactMeta {
  id: string; title: string; kind: string; language?: string; contentType: string;
  version: number; versions: ArtifactVersionInfo[]; createdAt: number; updatedAt: number;
  /** In the Library (GET /api/artifacts): whose session it is. */
  sessionId?: string; sessionTitle?: string;
}
/** One version's content: text, or base64 for images and PDFs. */
export interface ArtifactContent { meta: ArtifactMeta; version: number; contentType: string; content?: string; base64?: string }

/** A session an agent offered to start (GET /api/sessions/:id/proposals). */
export interface Proposal { id: string; sessionId: string; title: string; brief: string; initiation: 'offer' | 'own_initiative'; context: 'fork' | 'fresh'; useWorktree?: boolean; model?: string; effort?: string; status?: string; createdAt?: number; expiresAt?: number }

/** A model call or a tool call in a session's trace (GET /api/sessions/:id/trace). */
export type TraceSpan =
  | { type: 'model'; at: number; agent: string; model: string; ms: number; usage: Usage; cost: number; stop: string; retries: number; compaction?: boolean }
  | { type: 'tool'; at: number; agent: string; tool: string; ms: number; error: boolean; chars?: number; images?: number }
  | { type: 'clear'; at: number; agent: string; results: number; tokens: number };

/** The person's delegation setting (other models agents may use). */
export interface Delegation { allowedModels?: string[] | '*'; maxCostUsd?: number; requireApproval?: boolean }

/** One of the person's own skills: what it holds and declares. */
export interface SkillInfo { name: string; description: string; version?: string; scripts: string[]; tests: string[]; references: string[]; assets: string[]; tools: string[]; mcpServers: string[]; lines: number }
/** What came of importing one skill of a package. */
export interface SkillImportResult { name: string; ok: boolean; problems: string[]; warnings: string[]; scripts?: number; tests?: number; tools?: string[]; mcpServers?: string[]; serversAdded?: string[] }
