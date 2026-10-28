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
export interface CompanionInfo { id: string; name: string; online: boolean; info: { platform: string; root: string } | null }
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
export interface Todo { content: string; status: 'pending' | 'in_progress' | 'completed' }
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
  | { kind: 'request_resolved'; requestId: string; decision: string }
  | { kind: 'usage'; model: string; usage: Usage; cost: number; contextTokens: number; contextWindow: number; agent?: string }
  | { kind: 'todos'; todos: Todo[] }
  | { kind: 'mode'; mode: Mode }
  | { kind: 'compaction'; before: number; after: number; summaryTokens: number }
  | { kind: 'notice'; level: 'info' | 'warn' | 'error'; text: string; agent?: string }
  /** A progress review at a step checkpoint: started, extended, refreshed (a fresh start), stopped, a flagged "done", a test-discipline nudge. */
  | { kind: 'progress'; phase: 'checkpoint' | 'extended' | 'refreshed' | 'stopped' | 'flagged' | 'nudge'; step: number; budget: number; by: 'signals' | 'review'; text: string; reasons: string[]; verdict?: string; advice?: string; agent?: string }
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
export type EventTopic = 'sessions' | 'session' | 'approvals' | 'schedules' | 'plugins' | 'notices' | 'proposals' | 'linked' | 'artifacts' | 'chapters' | 'client';
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
export interface Schedule { id: string; title?: string; prompt: string; cron?: string; at?: number; enabled: boolean; nextRun?: number | null; lastRun?: number | null; sessionId?: string; trigger?: boolean }
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
