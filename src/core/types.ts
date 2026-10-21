// Provider-neutral transcript, events and usage. Every provider adapter converts
// to and from these shapes; the loop, the UI and the store only ever see them.

export type ProviderId = string;

export interface TextBlock { type: 'text'; text: string }
export interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; parseError?: string }
/** Images a tool produced travel with its result, so clearing the result clears them too. */
export interface ToolResultBlock { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean; images?: { media_type: string; data: string }[] }
/** Model reasoning. `text` is for display only; replay uses the provider-native `raw` on the message. */
export interface ReasoningBlock { type: 'reasoning'; text: string }

/** An image the model should see (a screenshot, a render), base64-encoded. */
export interface ImageBlock { type: 'image'; media_type: string; data: string }

export type Block = TextBlock | ToolUseBlock | ToolResultBlock | ReasoningBlock | ImageBlock;

export interface Message {
  role: 'user' | 'assistant';
  content: Block[];
  /**
   * The provider-native assistant payload, replayed byte-for-byte to the same
   * provider (Anthropic thinking signatures, OpenAI encrypted reasoning items,
   * DeepSeek reasoning_content). Never edited: that is what keeps the prompt
   * cache warm and keeps preserved-thinking checks passing.
   */
  raw?: { provider: ProviderId; model: string; payload: unknown };
  /** Marks the synthetic first message of a compacted context. */
  compactionSummary?: boolean;
}

export interface Usage {
  /** Uncached input tokens billed at the full rate. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Subset of output spent on reasoning, when the provider reports it. */
  reasoning: number;
}

export const emptyUsage = (): Usage => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 });

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
  };
}

/** Total prompt size of one request: what the context window actually holds. */
export const promptTokens = (u: Usage): number => u.input + u.cacheRead + u.cacheWrite;

/** default asks; acceptEdits allows edits; auto: a model checks each call against the request; dontAsk: what would be asked is denied (unattended runs); plan: read only; bypass: no checks. */
export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'dontAsk' | 'plan' | 'bypass';

export interface Todo { content: string; status: 'pending' | 'in_progress' | 'completed' }

export type HarnessEvent =
  | { kind: 'turn_start'; turn: number; agent?: string }
  | { kind: 'user_message'; text: string }
  | { kind: 'text_delta'; text: string; agent?: string }
  | { kind: 'reasoning_delta'; text: string; agent?: string }
  | { kind: 'assistant_message'; message: Message; agent?: string }
  | { kind: 'tool_call'; id: string; name: string; input: Record<string, unknown>; agent?: string }
  | { kind: 'tool_result'; id: string; name: string; content: string; is_error: boolean; display?: ToolDisplay; ms: number; agent?: string; images?: { media_type: string; data: string }[] }
  | { kind: 'permission_request'; requestId: string; tool: string; summary: string; input: Record<string, unknown>; suggestion?: string; agent?: string }
  | { kind: 'question'; requestId: string; question: string; options: string[]; agent?: string }
  | { kind: 'plan_proposed'; requestId: string; plan: string }
  | { kind: 'approval_request'; requestId: string; runId: string; node: string; title: string; message: string; files: { path: string; content: string }[] }
  | { kind: 'workflow'; phase: 'started' | 'node_started' | 'node_finished' | 'finished'; node?: string; run: WorkflowRunView }
  | { kind: 'task'; phase: 'started' | 'finished'; task: TaskView }
  | { kind: 'request_resolved'; requestId: string; decision: string }
  | { kind: 'usage'; model: string; usage: Usage; cost: number; contextTokens: number; contextWindow: number; agent?: string }
  | { kind: 'todos'; todos: Todo[] }
  | { kind: 'mode'; mode: PermissionMode }
  | { kind: 'compaction'; before: number; after: number; summaryTokens: number }
  | { kind: 'notice'; level: 'info' | 'warn' | 'error'; text: string; agent?: string }
  | { kind: 'retry'; attempt: number; delayMs: number; reason: string }
  | { kind: 'turn_end'; reason: TurnEndReason; agent?: string }
  | { kind: 'status'; status: SessionStatus };

export type TurnEndReason = 'done' | 'aborted' | 'max_steps' | 'budget' | 'refusal' | 'error' | 'max_tokens';
export type SessionStatus = 'idle' | 'running' | 'waiting';

/** Background work in a session (a shell, a sub-agent, a workflow run, a monitor) as task_list and the UI see it. */
export interface TaskView {
  id: string;
  kind: 'shell' | 'agent' | 'workflow' | 'monitor';
  description: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  startedAt: number;
  endedAt?: number;
  /** Who started it: 'main' or a sub-agent's name. */
  owner: string;
  cost?: number;
}

/** What the UI renders for a tool result (never sent to the model). */
export type ToolDisplay =
  | { type: 'diff'; path: string; before: string; after: string }
  | { type: 'file'; path: string; lines: number }
  | { type: 'text'; text: string };

/** A workflow run as the UI sees it (state values are trimmed). */
export interface WorkflowRunView {
  id: string;
  workflow: string;
  status: string;
  current?: string;
  cost: number;
  error?: string;
  nodes: { id: string; type: string; title?: string }[];
  history: { node: string; type: string; status: string; outcome?: string; summary?: string; startedAt: number; endedAt?: number; cost?: number }[];
}
