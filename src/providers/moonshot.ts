import type { Effort } from '../core/models.ts';
import type { JsonSchema, Provider, ProviderRequest, ProviderResponse, ToolSpec } from './types.ts';
import { ProviderError } from './types.ts';
import { postStream } from './http.ts';
import { errorBody, finishTurn, readChatStream, toReasoningChat } from './chat-shared.ts';
import { loadedAt } from './tool-loads.ts';

// Moonshot AI's Kimi models (kimi-k3.1-pro, kimi-k3, kimi-k2.7-code, kimi-k2.6) over the
// Kimi Open Platform's OpenAI-compatible Chat Completions endpoint.
//
// Why Chat Completions and not the Anthropic-compatible /anthropic/v1/messages:
// every Kimi-specific control is documented on it first - reasoning_effort (K3),
// thinking.type/keep (K2.x), prompt_cache_key, prompt_cache_options (the cache
// TTL), strict tool schemas, multimodal tool results - and its usage reports
// cache reads and writes separately (prompt_tokens_details.cached_tokens /
// cache_write_tokens). Our Anthropic provider leans on Claude-only betas
// (context editing, server-side compaction) the compatible endpoint lacks.
// Sources (checked 2026-10-22):
//   https://platform.kimi.ai/docs/api/overview          base URLs, protocols
//   https://platform.kimi.ai/docs/api/chat              request, usage, cache fields
//   https://platform.kimi.ai/docs/api/models-overview   per-model parameters
//   https://platform.kimi.ai/docs/guide/use-thinking-models  reasoning_content, keep
//   https://platform.kimi.ai/docs/guide/context-caching  automatic prefix cache, TTL
//   https://platform.kimi.ai/docs/api/errors             error types
//
// Caching is automatic and prefix-based (blocks; a partial block is a miss), so
// the request keeps its prefix byte-stable: the frozen system prompt, the
// session's sorted tools, then the append-only history with every assistant
// turn replayed exactly as received (K3 and K2.7 Code require reasoning_content
// back; it is "Preserved Thinking"). prompt_cache_key carries the session id, as
// the docs recommend for coding agents. Changing reasoning_effort mid-session
// invalidates the prefix cache, so the effort is per session, never per step.

const DEFAULT_BASE = 'https://api.moonshot.ai/v1';

/** How each model is driven. Unknown ids (a plugin's) get no thinking fields at all. */
interface Traits {
  /** 'effort': K3's top-level reasoning_effort; 'always': thinks, no control (K2.7 Code); 'toggle': thinking.type on/off (K2.6). */
  thinking: 'effort' | 'always' | 'toggle' | 'none';
  /** Writes are billed per TTL tier and prompt_cache_options applies (K3 only). */
  cacheWrite: boolean;
  /** Tools loaded mid-session can go in as a system message where they loaded (K3 and K3.1 Pro; K2.6 answers "tokenization failed"). */
  inlineTools?: boolean;
}
const TRAITS: Record<string, Traits> = {
  'kimi-k3': { thinking: 'effort', cacheWrite: true, inlineTools: true },
  'kimi-k3.1-pro': { thinking: 'effort', cacheWrite: true, inlineTools: true },
  'kimi-k3.1-pro-highspeed': { thinking: 'effort', cacheWrite: true, inlineTools: true },
  'kimi-k2.7-code': { thinking: 'always', cacheWrite: false },
  'kimi-k2.7-code-highspeed': { thinking: 'always', cacheWrite: false },
  'kimi-k2.6': { thinking: 'toggle', cacheWrite: false },
};

/** K3 accepts low | high | max (default max). */
export function kimiEffort(e: Effort): 'low' | 'high' | 'max' {
  return e === 'low' ? 'low' : e === 'xhigh' || e === 'max' ? 'max' : 'high';
}

/** The cache tier for K3: HARNESS_MOONSHOT_CACHE_TTL=1h or 5m fixes it; unset, the session's own choice (1h once it has shown long gaps). Writes cost 2x at 1h. */
export function moonshotCacheTtl(env: NodeJS.ProcessEnv = process.env, prefixTtl?: '1h'): '5m' | '1h' {
  const set = env.HARNESS_MOONSHOT_CACHE_TTL;
  return set === '1h' || (set !== '5m' && prefixTtl === '1h') ? '1h' : '5m';
}

// MFJS (Moonshot Flavored JSON Schema): strict tool schemas (the default) must
// use only these keywords. A schema with anything else is sent with strict:
// false (valid JSON arguments, no constrained decoding) instead of risking a
// rejected request. https://github.com/MoonshotAI/walle/blob/main/docs/mfjs-spec.md
const MFJS_KEYS = new Set(['type', 'properties', 'required', 'items', 'additionalProperties', 'anyOf', 'enum', 'description', 'default', '$defs', '$ref']);
export function mfjsStrict(schema: unknown): boolean {
  const ok = (s: unknown): boolean => {
    if (Array.isArray(s)) return s.every(ok);
    if (!s || typeof s !== 'object') return true;
    for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
      if (!MFJS_KEYS.has(k)) return false;
      if (k === '$ref' && (typeof v !== 'string' || !v.startsWith('#'))) return false;
      if (k === 'enum') {
        if (!Array.isArray(v) || new Set(v.map((x) => typeof x)).size > 1 || v.some((x) => typeof x !== 'string' && typeof x !== 'number')) return false;
        continue;
      }
      if (k === 'properties' || k === '$defs') { if (!Object.values(v as object).every(ok)) return false; continue; }
      if (k === 'description' || k === 'default') continue;
      if (!ok(v)) return false;
    }
    return true;
  };
  return ok(schema);
}

export function kimiTool(t: ToolSpec) {
  return { type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema as JsonSchema, strict: mfjsStrict(t.input_schema) } };
}

/** The request body. Exported for tests: the cache depends on its exact shape. */
export function moonshotBody(req: Pick<ProviderRequest, 'model' | 'system' | 'tools' | 'messages' | 'effort' | 'cacheKey' | 'prefixTtl' | 'toolChoice'>, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const traits = TRAITS[req.model.id] ?? { thinking: 'none', cacheWrite: false };
  const byName = new Map(req.tools.map((t) => [t.name, t]));
  const inline = traits.inlineTools ? loadedAt(req.messages, new Set(byName.keys())) : new Map<number, string[]>();
  const later = new Set([...inline.values()].flat());
  const messages: unknown[] = [{ role: 'system', content: req.system }];
  req.messages.forEach((m, i) => {
    messages.push(...toReasoningChat(m, { provider: 'moonshot', toolImages: 'inline' }));
    const loaded = inline.get(i);
    if (loaded) messages.push({ role: 'system', tools: loaded.map((n) => kimiTool(byName.get(n)!)) });
  });
  const body: Record<string, unknown> = { model: req.model.id, messages };
  const top = req.tools.filter((t) => !later.has(t.name));
  if (top.length) body.tools = top.map(kimiTool);
  // auto, or none for a compaction's summary: both are accepted by every Kimi model with thinking on, and a
  // per-request tool_choice keeps the prefix cache (https://platform.kimi.ai/docs/guide/use-tool-choice).
  if (req.tools.length) body.tool_choice = req.toolChoice ?? 'auto';
  body.stream = true;
  body.stream_options = { include_usage: true };
  // max_tokens is deprecated on Kimi; the server lowers this cap itself when the prompt leaves less room.
  body.max_completion_tokens = req.model.maxOutput;
  body.prompt_cache_key = req.cacheKey;
  if (traits.thinking === 'effort') body.reasoning_effort = kimiEffort(req.effort);
  // K2.6: low turns thinking off; otherwise thinking with Preserved Thinking, so
  // earlier turns' reasoning stays in the prompt as sent (the prefix stays cached).
  if (traits.thinking === 'toggle') body.thinking = req.effort === 'low' ? { type: 'disabled' } : { type: 'enabled', keep: 'all' };
  // The 1-hour tier when asked for (HARNESS_MOONSHOT_CACHE_TTL=1h) or when the session has shown gaps past 5 minutes
  // (promptCaching.prefixTtl 'auto', as for Claude): a 5-minute prefix would be written again after every long tool call.
  if (traits.cacheWrite && moonshotCacheTtl(env, req.prefixTtl) === '1h') body.prompt_cache_options = { mode: 'implicit', ttl: '1h' };
  return body;
}

export class MoonshotProvider implements Provider {
  private apiKey: string;
  readonly baseUrl: string;
  constructor(apiKey: string, baseUrl = process.env.MOONSHOT_BASE_URL || DEFAULT_BASE) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async send(req: ProviderRequest): Promise<ProviderResponse> {
    const body = moonshotBody(req);
    let res: Response;
    try {
      res = await postStream(`${this.baseUrl}/chat/completions`, { authorization: `Bearer ${this.apiKey}` }, body, req.signal);
    } catch (err) {
      if (!(err instanceof ProviderError) || req.signal.aborted) throw err;
      throw await this.classify(err.status, errorBody(err), err.retryAfterMs, req.model.id);
    }
    const turn = await readChatStream(res, req, (e) => kimiError(0, { type: e.type, message: e.message ?? 'stream error' }, undefined, req.model.id, this.baseUrl));
    const out = finishTurn(turn, req.model.id, 'moonshot', body);
    // Writes under a 1-hour request go to the 1-hour entry (billed at its rate).
    if ((body.prompt_cache_options as { ttl?: string } | undefined)?.ttl === '1h' && out.usage.cacheWrite) out.usage = { ...out.usage, cacheWrite1h: out.usage.cacheWrite };
    return out;
  }

  /** Maps an error; an insufficient balance also reports the balance left (one cheap call, only on that error). */
  private async classify(status: number, e: { type?: string; message: string }, retryAfterMs: number | undefined, model: string): Promise<ProviderError> {
    const err = kimiError(status, e, retryAfterMs, model, this.baseUrl);
    if (e.type === 'exceeded_current_quota_error') {
      const b = await moonshotBalance(this.apiKey, this.baseUrl, AbortSignal.timeout(5000)).catch(() => undefined);
      if (b) return new ProviderError(`${err.message} Available balance: $${b.available.toFixed(2)} (cash $${b.cash.toFixed(2)}, vouchers $${b.voucher.toFixed(2)}).`, err.status, false);
    }
    return err;
  }
}

/** Kimi error types to retryable or not, with what to do. https://platform.kimi.ai/docs/api/errors */
export function kimiError(status: number, e: { type?: string; message: string }, retryAfterMs: number | undefined, model: string, baseUrl = DEFAULT_BASE): ProviderError {
  const msg = e.message.slice(0, 600);
  const where = `Moonshot (${model})`;
  switch (e.type) {
    case 'exceeded_current_quota_error':
      return new ProviderError(`${where}: insufficient balance or quota - ${msg}. Top up at https://platform.kimi.ai/console (retrying will not help).`, status || 429, false);
    case 'rate_limit_reached_error':
      // A daily token limit resets tomorrow; concurrency, RPM and TPM pass in seconds.
      if (/\bTPD\b|per day/i.test(msg)) return new ProviderError(`${where}: daily token limit (TPD) reached - ${msg}. It resets tomorrow, or a higher top-up tier raises it.`, status || 429, false);
      return new ProviderError(`${where}: rate limited - ${msg}`, status || 429, true, retryAfterMs);
    case 'engine_overloaded_error':
      return new ProviderError(`${where}: overloaded - ${msg}`, status || 429, true, retryAfterMs);
    case 'content_filter':
      return new ProviderError(`${where}: the request was refused by content review - ${msg}`, status || 400, false);
    case 'invalid_authentication_error':
    case 'incorrect_api_key_error':
      return new ProviderError(`${where}: the key was refused (${msg}). Check MOONSHOT_API_KEY; keys from platform.kimi.ai work with ${DEFAULT_BASE}, keys from the China platform need MOONSHOT_BASE_URL=https://api.moonshot.cn/v1 (now ${baseUrl}).`, status || 401, false);
    case 'permission_denied_error':
      return new ProviderError(`${where}: permission denied - ${msg}`, status || 403, false);
    case 'resource_not_found_error':
      return new ProviderError(`${where}: model not found or not available to this account - ${msg}. Kimi K3 is unlocked by a first top-up (minimum $1).`, status || 404, false);
  }
  if (status === 400 && /token length too long|context (window|length)/i.test(msg)) {
    return new ProviderError(`${where}: the prompt is longer than the model's context window - ${msg}. Compact the session (or lower HARNESS_COMPACT_AT).`, 400, false);
  }
  if (status === 0) return new ProviderError(`${where}: ${msg}`, 500, true);
  return new ProviderError(`${where}: ${status} ${msg}`, status, status === 408 || status === 409 || status === 429 || status >= 500, retryAfterMs);
}

/** GET /v1/users/me/balance (USD). https://platform.kimi.ai/docs/api/balance */
export async function moonshotBalance(apiKey: string, baseUrl = process.env.MOONSHOT_BASE_URL || DEFAULT_BASE, signal?: AbortSignal): Promise<{ available: number; voucher: number; cash: number }> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/users/me/balance`, { headers: { authorization: `Bearer ${apiKey}` }, signal });
  if (!res.ok) throw new ProviderError(`balance: ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`, res.status, false);
  const j = await res.json() as { data?: { available_balance?: number; voucher_balance?: number; cash_balance?: number } };
  return { available: j.data?.available_balance ?? 0, voucher: j.data?.voucher_balance ?? 0, cash: j.data?.cash_balance ?? 0 };
}

/** POST /v1/tokenizers/estimate-token-count: the prompt's tokens before sending it. https://platform.kimi.ai/docs/api/estimate */
export async function moonshotEstimateTokens(apiKey: string, model: string, messages: unknown[], baseUrl = process.env.MOONSHOT_BASE_URL || DEFAULT_BASE, signal?: AbortSignal): Promise<number> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/tokenizers/estimate-token-count`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages }),
    signal,
  });
  if (!res.ok) throw new ProviderError(`estimate-token-count: ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`, res.status, false);
  const j = await res.json() as { data?: { total_tokens?: number } };
  return j.data?.total_tokens ?? 0;
}
