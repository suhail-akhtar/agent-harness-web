import type { Message, Usage } from '../core/types.ts';
import type { Effort, ModelSpec } from '../core/models.ts';

export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

export interface ProviderRequest {
  model: ModelSpec;
  /** Frozen for the life of a session (and identical across sessions) so it caches. */
  system: string;
  /** Fixed for the life of a session and sorted by name, for the same reason. */
  tools: ToolSpec[];
  /** The model's context: append-only between compactions. */
  messages: Message[];
  effort: Effort;
  /** Stable per conversation; used by providers that route caches by key. */
  cacheKey: string;
  /** Where the context should be compacted (HARNESS_COMPACT_AT, else the model's point); providers that compact themselves use it. */
  compactAt?: number;
  /** What PreCompact hooks asked a provider-side summary to keep (added to its instructions). */
  compactKeep?: string;
  /** '1h': the stable prefix (tools and system prompt) is cached for an hour (providers with TTL tiers: Anthropic); else the default TTL. */
  prefixTtl?: '1h';
  signal: AbortSignal;
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
}

export type StopKind = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface ProviderResponse {
  message: Message;
  stop: StopKind;
  usage: Usage;
  /** Extra detail worth surfacing, e.g. a refusal category. */
  notice?: string;
  /**
   * Prompt tokens of the context the model answered from, when it differs from
   * usage (the provider compacted the conversation inside this request).
   */
  contextTokens?: number;
  /** The provider summarised earlier context in this request (server-side compaction). */
  compacted?: { summaryTokens: number; before: number };
}

export interface Provider {
  send(req: ProviderRequest): Promise<ProviderResponse>;
  /** True when this provider compacts long conversations itself (the loop then only backs it up). */
  compactsServerSide?(model: ModelSpec, compactAt?: number): boolean;
}

export class ProviderError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  constructor(message: string, status: number, retryable: boolean, retryAfterMs?: number) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}
