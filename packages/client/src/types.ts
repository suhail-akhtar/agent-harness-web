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

export interface ModelInfo { id: string; label: string; provider: string; contextWindow: number; compactAt: number; effort: Effort; efforts: Effort[]; available: boolean; vision?: boolean; notes?: string }
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
export interface SessionMeta {
  id: string; title: string; model: string; effort: Effort; mode: Mode;
  runtime: { kind: 'docker' | 'local' | 'companion'; network: 'none' | 'full' | 'allowlist'; companionId?: string; path?: string; image?: string };
  createdAt: number; updatedAt: number; usage: Usage; cost: number; todos: Todo[];
  byModel: Record<string, { usage: Usage; cost: number; requests: number }>;
  contextStart: number; compactions: number; lastPromptTokens: number; status?: SessionStatus;
  /** New server fields (absent on older servers). */
  archived?: boolean; pinned?: boolean; group?: string; forkedFrom?: string;
}
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
  nodes: { id: string; type: string; title?: string }[];
  history: { node: string; type: string; status: string; outcome?: string; summary?: string; startedAt: number; endedAt?: number; cost?: number }[];
}
export interface WorkflowInfo { name: string; description: string; source?: string; inputs: Record<string, { description?: string; required?: boolean; default?: string }>; nodes: { id: string; type: string; title?: string }[] }

/** Background work: a shell, a sub-agent, a workflow run or a monitor. */
export interface TaskView { id: string; kind: 'shell' | 'agent' | 'workflow' | 'monitor'; description: string; status: 'running' | 'completed' | 'failed' | 'stopped'; startedAt: number; endedAt?: number; owner: string; cost?: number }

export type HarnessEvent =
  | { kind: 'turn_start'; turn: number; agent?: string }
  | { kind: 'user_message'; text: string; images?: ImageData[] }
  | { kind: 'text_delta'; text: string; agent?: string }
  | { kind: 'reasoning_delta'; text: string; agent?: string }
  | { kind: 'assistant_message'; message: Message; agent?: string }
  | { kind: 'tool_call'; id: string; name: string; input: Record<string, unknown>; agent?: string }
  | { kind: 'tool_result'; id: string; name: string; content: string; is_error: boolean; display?: ToolDisplay; ms: number; agent?: string; images?: ImageData[] }
  | { kind: 'permission_request'; requestId: string; tool: string; summary: string; input: Record<string, unknown>; suggestion?: string; agent?: string }
  | { kind: 'question'; requestId: string; question: string; options: string[] }
  | { kind: 'plan_proposed'; requestId: string; plan: string }
  | { kind: 'approval_request'; requestId: string; runId: string; node: string; title: string; message: string; files: { path: string; content: string }[] }
  | { kind: 'workflow'; phase: 'started' | 'node_started' | 'node_finished' | 'finished'; node?: string; run: WorkflowRunView }
  | { kind: 'request_resolved'; requestId: string; decision: string }
  | { kind: 'usage'; model: string; usage: Usage; cost: number; contextTokens: number; contextWindow: number; agent?: string }
  | { kind: 'todos'; todos: Todo[] }
  | { kind: 'mode'; mode: Mode }
  | { kind: 'compaction'; before: number; after: number; summaryTokens: number }
  | { kind: 'notice'; level: 'info' | 'warn' | 'error'; text: string; agent?: string }
  | { kind: 'retry'; attempt: number; delayMs: number; reason: string }
  | { kind: 'turn_end'; reason: string; agent?: string }
  | { kind: 'status'; status: SessionStatus }
  | { kind: 'task'; phase: 'started' | 'finished'; task: TaskView };

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
export type EventTopic = 'sessions' | 'session' | 'approvals' | 'schedules' | 'plugins' | 'notices';
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
}
export interface ProviderTest { ok: boolean; latencyMs?: number; model?: string; error?: string }

/** A plugin as the server lists it (GET /api/plugins, new). */
export interface PluginInfo {
  name: string; version: string; description?: string; enabled: boolean; required?: boolean;
  source?: 'bundled' | 'installed' | 'operator' | 'catalogue' | 'dev' | string;
  contributes?: string[]; signature?: string; permissions?: Record<string, unknown>;
  ui?: UiManifest; uiError?: string; uiHash?: string; /** Where the server serves this plugin's UI files: /api/plugins/<name>/ui/ */ uiBase?: string;
}
export interface CatalogueEntry { name: string; version: string; description?: string; installed?: boolean; url?: string }

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
