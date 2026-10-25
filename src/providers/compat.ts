import fs from 'node:fs';
import { splitToolImages } from './images.ts';
import type { Block, Message } from '../core/types.ts';
import type { Effort, ModelSpec } from '../core/models.ts';
import type { ProviderDef } from '../plugins/api.ts';
import type { Provider, ProviderRequest, ProviderResponse, StopKind } from './types.ts';
import { ProviderError } from './types.ts';
import { isToolName, parseArgs, postStream, readSse } from './http.ts';

// Any server that speaks OpenAI's Chat Completions: Ollama, vLLM, LM Studio,
// OpenRouter, Together, Groq, Azure OpenAI, Gemini's OpenAI endpoint, ...
// The operator lists the models (HARNESS_MODELS_JSON, or a file named by
// HARNESS_MODELS_FILE); each entry says where the server is, which variable
// holds its key, what it costs and which of the protocol's variations it needs.
// No code per server: the differences between them are data here.

/** One operator-configured model. Everything but id and baseUrl has a default (or a preset's). */
export interface CompatModelConfig {
  /** The harness's id for the model (what sessions pick). */
  id: string;
  /** The model name sent to the server, when it differs from id (e.g. "qwen2.5:0.5b"). */
  model?: string;
  label?: string;
  /** Fills in base URL, key variable and quirks for a known server (each field can still be given). */
  preset?: keyof typeof PRESETS;
  /** The API root, ending before /chat/completions (e.g. http://localhost:11434/v1). */
  baseUrl?: string;
  /** The environment variable holding the API key; none for a local server that needs no key. */
  apiKeyEnv?: string;
  contextWindow?: number;
  maxOutput?: number;
  /** Compact once a prompt passes this many tokens (default 60% of the window). */
  compactAt?: number;
  /** USD per million tokens. */
  prices?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  /** The server accepts function tools (default true). false: the model answers without tools. */
  tools?: boolean;
  /** The model accepts images (default false). */
  images?: boolean;
  notes?: string;
  effort?: Effort;
  efforts?: Effort[];
  // --- protocol variations ---
  /** Which field caps the output: OpenAI's newer models and Azure want max_completion_tokens. */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens' | 'none';
  /** How the key is sent: "bearer" (Authorization: Bearer) or a header name such as "api-key" (Azure). */
  auth?: string;
  /** Azure OpenAI's deployment URL form: {baseUrl}/openai/deployments/{deployment}/chat/completions?api-version=... */
  azure?: { deployment?: string; apiVersion: string };
  /** Query parameters added to the URL (e.g. { "api-version": "..." } for Azure's v1 form). */
  query?: Record<string, string>;
  /** Extra headers sent on every request (e.g. OpenRouter's HTTP-Referer). */
  headers?: Record<string, string>;
  /** Send prompt_cache_key (servers that route caches by key: OpenAI, Azure). Default off: unknown fields break some servers. */
  promptCacheKey?: boolean;
  /** Ask for usage in the stream (stream_options.include_usage). Default true; turn off for a server that rejects it. */
  streamUsage?: boolean;
  /** Send the session's effort as reasoning_effort (low/medium/high). Default off. */
  reasoningEffort?: boolean;
  /** Send the model's reasoning back with its tool calls as reasoning_content (DeepSeek-style servers). Default off. */
  replayReasoning?: boolean;
  /** Stream (default true); false reads one JSON response. */
  stream?: boolean;
  /** Send parallel_tool_calls: true (default: not sent; some servers reject it). */
  parallelToolCalls?: boolean;
  /** Fields merged into every request body as they are (temperature, provider routing, ...). */
  body?: Record<string, unknown>;
}

/** Defaults for well-known servers. A model's own fields win. */
export const PRESETS = {
  openai: { baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', maxTokensField: 'max_completion_tokens', promptCacheKey: true, reasoningEffort: true },
  azure: { apiKeyEnv: 'AZURE_OPENAI_API_KEY', auth: 'api-key', maxTokensField: 'max_completion_tokens', promptCacheKey: true },
  ollama: { baseUrl: 'http://localhost:11434/v1' },
  vllm: { baseUrl: 'http://localhost:8000/v1' },
  lmstudio: { baseUrl: 'http://localhost:1234/v1' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' },
  together: { baseUrl: 'https://api.together.xyz/v1', apiKeyEnv: 'TOGETHER_API_KEY' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY', maxTokensField: 'max_completion_tokens' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKeyEnv: 'GEMINI_API_KEY', reasoningEffort: true },
} satisfies Record<string, Partial<CompatModelConfig>>;

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The provider id a configured model is served under (one provider per entry: its own URL and key). */
export const compatProviderId = (modelId: string): string => `compat:${modelId}`;

/** Fills in a preset's and the global defaults, and checks the entry. Throws with what is wrong. */
export function resolveCompat(raw: CompatModelConfig): Required<Pick<CompatModelConfig, 'id' | 'model' | 'baseUrl'>> & CompatModelConfig {
  if (!raw || typeof raw !== 'object') throw new Error('each model must be an object');
  if (typeof raw.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(raw.id)) throw new Error(`model id ${JSON.stringify(raw.id)} must be 1-128 letters, digits and . _ : / -`);
  const preset = raw.preset ? PRESETS[raw.preset] : {};
  if (raw.preset && !preset) throw new Error(`${raw.id}: unknown preset "${raw.preset}" (known: ${Object.keys(PRESETS).join(', ')})`);
  const c = { ...preset, ...raw } as CompatModelConfig;
  if (!c.baseUrl) throw new Error(`${raw.id}: baseUrl is required`);
  let u: URL;
  try { u = new URL(c.baseUrl); } catch { throw new Error(`${raw.id}: baseUrl "${c.baseUrl}" is not a URL`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`${raw.id}: baseUrl must be http(s)`);
  if (c.apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.apiKeyEnv)) throw new Error(`${raw.id}: apiKeyEnv must be an environment variable name (the key itself never goes in this file)`);
  if (c.maxTokensField && !['max_tokens', 'max_completion_tokens', 'none'].includes(c.maxTokensField)) throw new Error(`${raw.id}: maxTokensField must be max_tokens, max_completion_tokens or none`);
  if (c.azure && typeof c.azure.apiVersion !== 'string') throw new Error(`${raw.id}: azure.apiVersion is required`);
  for (const n of ['contextWindow', 'maxOutput', 'compactAt'] as const) {
    if (c[n] !== undefined && !(Number.isInteger(c[n]) && c[n]! > 0)) throw new Error(`${raw.id}: ${n} must be a positive integer`);
  }
  for (const [k, v] of Object.entries(c.prices ?? {})) if (typeof v !== 'number' || v < 0) throw new Error(`${raw.id}: prices.${k} must be a number >= 0`);
  if (c.effort && !EFFORTS.includes(c.effort)) throw new Error(`${raw.id}: effort must be one of ${EFFORTS.join(', ')}`);
  return { ...c, id: c.id, model: c.model ?? c.azure?.deployment ?? c.id, baseUrl: c.baseUrl.replace(/\/+$/, '') };
}

export function compatSpec(c: ReturnType<typeof resolveCompat>): ModelSpec {
  const contextWindow = c.contextWindow ?? 32_768;
  const p = c.prices ?? {};
  const rate = { input: p.input ?? 0, output: p.output ?? 0, cacheRead: p.cacheRead ?? p.input ?? 0, cacheWrite: p.cacheWrite ?? p.input ?? 0 };
  const efforts = c.efforts ?? (c.reasoningEffort ? ['low', 'medium', 'high'] as Effort[] : ['medium'] as Effort[]);
  return {
    id: c.id,
    label: c.label ?? c.id,
    provider: compatProviderId(c.id),
    vision: c.images === true,
    notes: c.notes ?? (c.tools === false ? 'Configured without tools: it answers, but cannot act.' : undefined),
    contextWindow,
    maxOutput: Math.min(c.maxOutput ?? 4096, contextWindow),
    compactAt: c.compactAt ?? Math.floor(contextWindow * 0.6),
    effort: c.effort ?? efforts[Math.min(1, efforts.length - 1)]!,
    efforts,
    rate: () => rate,
  };
}

/**
 * The operator's models: HARNESS_MODELS_JSON (a JSON array, or { "models": [...] })
 * and/or the file HARNESS_MODELS_FILE (same shape). Throws on a malformed entry,
 * so a typo stops the server at start instead of failing a session later.
 */
export function loadCompatModels(env: NodeJS.ProcessEnv = process.env): { models: ModelSpec[]; providers: Record<string, ProviderDef> } {
  const sources: [string, string][] = [];
  if (env.HARNESS_MODELS_JSON?.trim()) sources.push(['HARNESS_MODELS_JSON', env.HARNESS_MODELS_JSON]);
  if (env.HARNESS_MODELS_FILE?.trim()) {
    let text: string;
    try { text = fs.readFileSync(env.HARNESS_MODELS_FILE, 'utf8'); } catch (err) { throw new Error(`HARNESS_MODELS_FILE: ${(err as Error).message}`); }
    sources.push([`HARNESS_MODELS_FILE (${env.HARNESS_MODELS_FILE})`, text]);
  }
  const models: ModelSpec[] = [];
  const providers: Record<string, ProviderDef> = {};
  for (const [where, text] of sources) {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch (err) { throw new Error(`${where} is not valid JSON: ${(err as Error).message}`); }
    const list = Array.isArray(parsed) ? parsed : (parsed as { models?: unknown })?.models;
    if (!Array.isArray(list)) throw new Error(`${where} must be a JSON array of models, or { "models": [...] }`);
    for (const entry of list) {
      let c: ReturnType<typeof resolveCompat>;
      try { c = resolveCompat(entry as CompatModelConfig); } catch (err) { throw new Error(`${where}: ${(err as Error).message}`); }
      if (models.some((m) => m.id === c.id)) throw new Error(`${where}: model "${c.id}" is listed twice`);
      models.push(compatSpec(c));
      providers[compatProviderId(c.id)] = {
        keyEnv: c.apiKeyEnv ? [c.apiKeyEnv] : [],
        keyless: !c.apiKeyEnv,
        create: (key) => new CompatProvider(c, key),
      };
    }
  }
  return { models, providers };
}

interface ChatToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
interface ChatAssistant { role: 'assistant'; content: string | null; reasoning_content?: string; tool_calls?: ChatToolCall[] }
interface ToolCallDelta { index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }
interface ChatDelta { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; refusal?: string | null; tool_calls?: ToolCallDelta[] }
interface ChatChoice { delta?: ChatDelta; message?: ChatDelta; finish_reason?: string | null }
interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number; cache_creation_tokens?: number } | null;
  completion_tokens_details?: { reasoning_tokens?: number } | null;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}
export interface ChatChunk { choices?: (ChatChoice & { usage?: ChatUsage | null })[]; usage?: ChatUsage | null; error?: { message?: string; code?: string | number; type?: string } }

export class CompatProvider implements Provider {
  readonly cfg: ReturnType<typeof resolveCompat>;
  private apiKey: string;
  constructor(cfg: ReturnType<typeof resolveCompat>, apiKey = '') {
    this.cfg = cfg;
    this.apiKey = apiKey;
  }

  /** The request URL: the plain form, or Azure's deployment form. */
  url(): string {
    const c = this.cfg;
    const u = new URL(c.azure?.deployment
      ? `${c.baseUrl}/openai/deployments/${encodeURIComponent(c.azure.deployment)}/chat/completions`
      : `${c.baseUrl}/chat/completions`);
    if (c.azure) u.searchParams.set('api-version', c.azure.apiVersion);
    for (const [k, v] of Object.entries(c.query ?? {})) u.searchParams.set(k, v);
    return u.toString();
  }

  headers(): Record<string, string> {
    const h: Record<string, string> = { ...(this.cfg.headers ?? {}) };
    if (this.apiKey) {
      const auth = this.cfg.auth ?? 'bearer';
      if (auth.toLowerCase() === 'bearer') h.authorization = `Bearer ${this.apiKey}`;
      else h[auth.toLowerCase()] = this.apiKey;
    }
    return h;
  }

  body(req: ProviderRequest): Record<string, unknown> {
    const c = this.cfg;
    const messages: unknown[] = [{ role: 'system', content: req.system }];
    for (const m of req.messages) messages.push(...toCompatChat(m, c.replayReasoning === true));
    const stream = c.stream !== false;
    const body: Record<string, unknown> = { model: c.model, messages, stream };
    if (stream && c.streamUsage !== false) body.stream_options = { include_usage: true };
    if (c.tools !== false && req.tools.length) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
      // none for a compaction's summary (the tools stay listed, so the cached prefix is the same).
      body.tool_choice = req.toolChoice ?? 'auto';
      if (c.parallelToolCalls) body.parallel_tool_calls = true;
    }
    const field = c.maxTokensField ?? 'max_tokens';
    if (field !== 'none') body[field] = req.model.maxOutput;
    if (c.reasoningEffort) body.reasoning_effort = req.effort === 'low' ? 'low' : req.effort === 'medium' ? 'medium' : 'high';
    if (c.promptCacheKey) body.prompt_cache_key = req.cacheKey;
    return { ...body, ...(c.body ?? {}) };
  }

  async send(req: ProviderRequest): Promise<ProviderResponse> {
    const body = this.body(req);
    let res: Response;
    try {
      res = await postStream(this.url(), this.headers(), body, req.signal);
    } catch (err) {
      throw this.explain(err, body);
    }
    const acc = new Accumulator(req);
    if (body.stream) {
      let done = false;
      for await (const ev of readSse(res, req.signal)) {
        if (ev.data === '[DONE]') { done = true; break; }
        let chunk: ChatChunk;
        try { chunk = JSON.parse(ev.data); } catch { continue; }
        if (chunk.error) throw new ProviderError(`${this.cfg.id}: ${chunk.error.message ?? 'stream error'}`, 500, true);
        // Some servers put the final usage inside the choice.
        const inChoice = (chunk.choices?.[0] as { usage?: ChatChunk['usage'] } | undefined)?.usage;
        if (!chunk.usage && inChoice) chunk.usage = inChoice;
        acc.add(chunk, true);
      }
      // Neither [DONE] nor a finish reason: the stream was cut off, not finished (asked again).
      if (!done && !acc.finish_ && !req.signal.aborted) throw new ProviderError(`${this.cfg.id}: the response stream ended before it was complete`, 0, true);
    } else {
      let chunk: ChatChunk;
      try { chunk = await res.json() as ChatChunk; } catch (err) { throw new ProviderError(`${this.cfg.id}: unreadable response: ${(err as Error).message}`, 0, true); }
      if (chunk.error) throw new ProviderError(`${this.cfg.id}: ${chunk.error.message ?? 'error'}`, 500, false);
      acc.add(chunk, false);
    }
    return acc.finish(this.cfg.id, JSON.stringify(body.messages).length + JSON.stringify(body.tools ?? []).length, this.cfg.replayReasoning === true);
  }

  /** A server that refuses tools says so in many ways; the operator gets one clear message with the fix. */
  private explain(err: unknown, body: Record<string, unknown>): unknown {
    if (!(err instanceof ProviderError)) return err;
    const where = `${this.cfg.id} (${this.cfg.baseUrl})`;
    if (body.tools && (err.status === 400 || err.status === 404 || err.status === 422 || err.status === 501) && /tool|function/i.test(err.message)) {
      return new ProviderError(
        `${where} does not accept tools (function calling): ${err.message.slice(0, 600)}. Pick a model that supports tools, or set "tools": false for "${this.cfg.id}" in the models configuration (it then answers without acting).`,
        err.status, false);
    }
    if (err.status === 401 || err.status === 403) {
      return new ProviderError(`${where} refused the key (${err.status})${this.cfg.apiKeyEnv ? `: check ${this.cfg.apiKeyEnv}` : ''}. ${err.message.slice(0, 300)}`, err.status, false);
    }
    if (err.status === 404) return new ProviderError(`${where}: not found (${err.message.slice(0, 300)}). Check baseUrl${this.cfg.azure ? ', azure.deployment and azure.apiVersion' : ''} and the model name "${this.cfg.model}".`, 404, false);
    return new ProviderError(`${where}: ${err.message}`, err.status, err.retryable, err.retryAfterMs);
  }
}

/** Splits "<think>...</think>" out of streamed content (models that inline their reasoning). */
class ThinkSplitter {
  private buf = '';
  private inside = false;
  private started = false;
  private onText: (s: string) => void;
  private onThink: (s: string) => void;
  constructor(onText: (s: string) => void, onThink: (s: string) => void) {
    this.onText = onText;
    this.onThink = onThink;
  }
  push(s: string): void {
    this.buf += s;
    while (this.buf) {
      if (!this.started) {
        const t = this.buf.trimStart();
        if (!t) return;
        if ('<think>'.startsWith(t) && t.length < 7) return; // could still be the tag
        this.started = true;
        if (t.startsWith('<think>')) { this.inside = true; this.buf = t.slice(7); continue; }
      }
      if (!this.inside) { this.onText(this.buf); this.buf = ''; return; }
      const end = this.buf.indexOf('</think>');
      if (end >= 0) {
        this.onThink(this.buf.slice(0, end));
        this.buf = this.buf.slice(end + 8).replace(/^\s+/, '');
        this.inside = false;
        continue;
      }
      // Keep a possible partial closing tag for the next chunk.
      const keep = Math.min(this.buf.length, 7);
      const tail = this.buf.slice(-keep);
      let hold = 0;
      for (let n = keep; n > 0; n--) if ('</think>'.startsWith(tail.slice(-n))) { hold = n; break; }
      this.onThink(this.buf.slice(0, this.buf.length - hold));
      this.buf = this.buf.slice(this.buf.length - hold);
      return;
    }
  }
  flush(): void {
    if (this.buf) (this.inside ? this.onThink : this.onText)(this.buf);
    this.buf = '';
  }
}

/**
 * Collects one streamed (or whole) Chat Completions answer: text, reasoning,
 * tool calls in any of the servers' delta shapes, finish reason and usage.
 * Shared with the built-in Chat Completions providers (Moonshot, Z.ai).
 */
export class Accumulator {
  content = '';
  reasoning = '';
  refusal = '';
  calls: { id: string; name: string; args: string }[] = [];
  finish_: string | null = null;
  usage?: ChatUsage;
  private think: ThinkSplitter;
  private req: ProviderRequest;
  constructor(req: ProviderRequest) {
    this.req = req;
    this.think = new ThinkSplitter(
      (s) => { if (s) { this.content += s; req.onText?.(s); } },
      (s) => { if (s) { this.reasoning += s; req.onReasoning?.(s); } },
    );
  }

  add(chunk: ChatChunk, streamed: boolean): void {
    if (chunk.usage) this.usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const d = (streamed ? choice.delta : choice.message ?? choice.delta) ?? {};
    // || not ??: a server that sends an empty reasoning_content beside the real reasoning (both fields).
    const r = d.reasoning_content || d.reasoning;
    if (r) { this.reasoning += r; this.req.onReasoning?.(r); }
    if (d.content) this.think.push(d.content);
    if (d.refusal) this.refusal += d.refusal;
    let last = this.calls.length - 1;
    for (const tc of d.tool_calls ?? []) {
      // Most servers number the calls (index); some leave it out and send a new id per call.
      let i = typeof tc.index === 'number' ? tc.index : last < 0 || (tc.id && this.calls[last]!.id && tc.id !== this.calls[last]!.id) ? last + 1 : last;
      // A server that numbers every call 0 but gives each its own id: a new id is a new call.
      if (tc.id && this.calls[i]?.id && this.calls[i]!.id !== tc.id && this.calls[i]!.name) i = this.calls.length;
      const slot = (this.calls[i] ??= { id: '', name: '', args: '' });
      if (tc.id) slot.id = tc.id;
      // The name comes once (OpenAI), whole in every chunk (some servers) or in pieces before the arguments.
      const n = tc.function?.name;
      if (n) slot.name = !slot.name || slot.name === n ? n : !slot.args ? slot.name + n : slot.name;
      if (tc.function?.arguments) slot.args += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
      last = i;
    }
    if (choice.finish_reason) this.finish_ = choice.finish_reason;
  }

  /** `provider` tags the raw payload: only that provider replays it verbatim. */
  finish(model: string, promptChars: number, replayReasoning: boolean, provider = 'compat'): ProviderResponse {
    this.think.flush();
    const blocks: Block[] = [];
    if (this.reasoning) blocks.push({ type: 'reasoning', text: this.reasoning });
    if (this.content) blocks.push({ type: 'text', text: this.content });
    const toolCalls: ChatToolCall[] = [];
    for (const c of this.calls.filter(Boolean)) {
      if (!isToolName(c.name)) { if (c.name) blocks.push({ type: 'text', text: c.name }); continue; }
      const id = c.id || `call_${Math.random().toString(36).slice(2, 10)}`;
      const { value, error } = parseArgs(c.args);
      blocks.push({ type: 'tool_use', id, name: c.name, input: value, ...(error ? { parseError: error } : {}) });
      toolCalls.push({ id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } });
    }
    const raw: ChatAssistant = { role: 'assistant', content: this.content || null };
    if (replayReasoning) raw.reasoning_content = this.reasoning;
    if (toolCalls.length) raw.tool_calls = toolCalls;

    const stopMap: Record<string, StopKind> = { stop: 'end', end_turn: 'end', tool_calls: 'tool_use', function_call: 'tool_use', length: 'max_tokens', max_tokens: 'max_tokens', content_filter: 'refusal' };
    let stop = stopMap[this.finish_ ?? ''] ?? (this.finish_ ? 'other' : 'end');
    if (toolCalls.length && stop !== 'max_tokens') stop = 'tool_use';
    if (!toolCalls.length && stop === 'tool_use') stop = 'end';
    if (this.refusal && !toolCalls.length) stop = 'refusal';

    const u = this.usage;
    let usage;
    if (u && (u.prompt_tokens !== undefined || u.completion_tokens !== undefined)) {
      const prompt = u.prompt_tokens ?? 0;
      const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
      const written = u.prompt_tokens_details?.cache_write_tokens ?? u.prompt_tokens_details?.cache_creation_tokens ?? 0;
      usage = {
        // prompt_tokens includes the cached part.
        input: u.prompt_cache_miss_tokens ?? Math.max(0, prompt - cached - written),
        cacheRead: cached,
        cacheWrite: written,
        output: u.completion_tokens ?? 0,
        reasoning: u.completion_tokens_details?.reasoning_tokens ?? 0,
      };
    } else {
      // No usage from the server: estimate (about 4 characters a token) so the
      // context still gets compacted in time and the totals are not zero.
      const out = this.content.length + this.reasoning.length + this.calls.reduce((n, c) => n + c.name.length + c.args.length, 0);
      usage = { input: Math.ceil(promptChars / 4), cacheRead: 0, cacheWrite: 0, output: Math.ceil(out / 4), reasoning: Math.ceil(this.reasoning.length / 4) };
    }
    return {
      message: { role: 'assistant', content: blocks, raw: { provider, model, payload: raw } },
      stop,
      usage,
      notice: stop === 'refusal' ? (this.refusal ? `The model declined: ${this.refusal}` : 'The provider filtered this response.') : undefined,
    };
  }
}

/** History in Chat Completions form. Assistant turns from this provider replay as received. */
export function toCompatChat(msg: Message, replayReasoning = false): unknown[] {
  const m = splitToolImages(msg);
  if (m.role === 'assistant') {
    if (m.raw?.provider === 'compat') {
      const p = m.raw.payload as ChatAssistant;
      if (!replayReasoning && 'reasoning_content' in p) { const { reasoning_content: _r, ...rest } = p; return [rest]; }
      return [p];
    }
    const text = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
    const tool_calls = m.content.filter((b) => b.type === 'tool_use').map((b) => {
      const t = b as { id: string; name: string; input: unknown };
      return { id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.input) } };
    });
    return [{ role: 'assistant', content: text || null, ...(replayReasoning ? { reasoning_content: '' } : {}), ...(tool_calls.length ? { tool_calls } : {}) }];
  }
  const out: unknown[] = [];
  for (const b of m.content) {
    if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? `ERROR: ${b.content}` : b.content || '(no output)' });
  }
  const text = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n\n');
  const images = m.content.filter((b) => b.type === 'image') as { media_type: string; data: string }[];
  if (images.length) {
    out.push({ role: 'user', content: [...(text ? [{ type: 'text', text }] : []), ...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.media_type};base64,${i.data}` } }))] });
  } else if (text) out.push({ role: 'user', content: text });
  return out;
}
