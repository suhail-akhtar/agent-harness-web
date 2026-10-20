// Thin client for the harness server. Auth is an HttpOnly cookie set by /api/login.

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined || method !== 'GET' ? { 'content-type': 'application/json', 'x-harness': '1' } : {},
    body: body !== undefined ? JSON.stringify(body) : method !== 'GET' ? '{}' : undefined,
  });
  const text = await res.text();
  let data: unknown = undefined;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string })?.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  get: <T>(p: string) => call<T>('GET', p),
  post: <T>(p: string, b?: unknown) => call<T>('POST', p, b ?? {}),
  patch: <T>(p: string, b: unknown) => call<T>('PATCH', p, b),
  del: <T>(p: string) => call<T>('DELETE', p),
};

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type Mode = 'default' | 'acceptEdits' | 'plan' | 'bypass';

export interface ModelInfo { id: string; label: string; provider: string; contextWindow: number; compactAt: number; effort: Effort; efforts: Effort[]; available: boolean; vision?: boolean; notes?: string }
export interface CompanionInfo { id: string; name: string; online: boolean; info: { platform: string; root: string } | null }
export interface Config {
  models: ModelInfo[];
  runtimes: { docker: boolean; dockerImage: string | null; local: boolean; localRoots: string[] };
  companions: CompanionInfo[];
  plugins?: { name: string; version: string; description: string; contributes: string[] }[];
}
export interface Usage { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number }
export interface Todo { content: string; status: 'pending' | 'in_progress' | 'completed' }
export interface SessionMeta {
  id: string; title: string; model: string; effort: Effort; mode: Mode;
  runtime: { kind: 'docker' | 'local' | 'companion'; network: 'none' | 'full'; companionId?: string; path?: string };
  createdAt: number; updatedAt: number; usage: Usage; cost: number; todos: Todo[];
  byModel: Record<string, { usage: Usage; cost: number; requests: number }>;
  contextStart: number; compactions: number; lastPromptTokens: number; status?: string;
}

export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean; images?: ImageData[] }
  | { type: 'reasoning'; text: string }
  | { type: 'image'; media_type: string; data: string };
export interface Message { role: 'user' | 'assistant'; content: Block[]; compactionSummary?: boolean }

export interface ImageData { media_type: string; data: string }

export type ToolDisplay =
  | { type: 'diff'; path: string; before: string; after: string }
  | { type: 'file'; path: string; lines: number }
  | { type: 'text'; text: string };

export type HarnessEvent =
  | { kind: 'turn_start'; turn: number; agent?: string }
  | { kind: 'user_message'; text: string }
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
  | { kind: 'status'; status: 'idle' | 'running' | 'waiting' };

export interface SessionDetail { meta: SessionMeta; status: 'idle' | 'running' | 'waiting'; history: Message[]; pending: HarnessEvent[]; lastSeq: number }

export interface Capabilities {
  tools: { name: string; kind: string }[];
  agents: { name: string; description: string; source?: string }[];
  skills: { name: string; description: string; source: string }[];
  mcp: { name: string; scope: string; ok: boolean; tools: number; error?: string }[];
  plugins: { name: string; version: string; description: string; contributes: string[] }[];
}
export interface CheckpointTurn { turn: number; at: number; prompt: string; files: string[] }
export type TraceSpan =
  | { at: number; type: 'model'; agent: string; model: string; ms: number; usage: Usage; cost: number; stop: string; retries: number; compaction?: boolean }
  | { at: number; type: 'tool'; agent: string; tool: string; ms: number; error: boolean; chars: number; images: number }
  | { at: number; type: 'clear'; agent: string; results: number; tokens: number };

export interface WorkflowRunView {
  id: string; workflow: string; status: string; current?: string; cost: number; error?: string;
  nodes: { id: string; type: string; title?: string }[];
  history: { node: string; type: string; status: string; outcome?: string; summary?: string; startedAt: number; endedAt?: number; cost?: number }[];
}
export interface WorkflowInfo { name: string; description: string; source?: string; inputs: Record<string, { description?: string; required?: boolean; default?: string }>; nodes: { id: string; type: string; title?: string }[] }
