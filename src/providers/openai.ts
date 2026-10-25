import { splitToolImages } from './images.ts';
import type { Effort } from '../core/models.ts';
import type { Block, Message } from '../core/types.ts';
import type { Provider, ProviderRequest, ProviderResponse, StopKind, ToolSpec } from './types.ts';
import { ProviderError } from './types.ts';
import { isToolName, parseArgs, postStream, readSse } from './http.ts';
import { loadedAt } from './tool-loads.ts';

// OpenAI over the Responses API (chat/completions rejects function tools on
// reasoning models). Stateless: store=false, encrypted reasoning items are
// requested and replayed verbatim, and prompt_cache_key pins the conversation
// to one cache shard. OpenAI caches the longest repeated prefix on its own.
// The same code drives xAI's Responses API (src/providers/xai.ts) with its own flavor.

/** What differs between platforms that speak the Responses API. */
export interface ResponsesFlavor {
  /** The id stored with an assistant turn (it is replayed verbatim only to the same platform). */
  provider: string;
  /** Tool definitions carry strict (OpenAI: false, so optional fields stay optional); xAI does not take the field. */
  strict?: boolean;
  effort(e: Effort): string;
  /** Ask for reasoning summaries (shown as the model's thinking). */
  summaries: boolean;
  /** Tools loaded mid-session as an additional_tools item where they loaded (the tool list and cache unchanged). */
  midTools: boolean;
  /** Server-side compaction (context_management) when the prompt passes the model's compaction point. */
  serverCompaction: boolean;
  /** Sampling the platform recommends (xAI: temperature 0.7, top_p 0.95). */
  sampling?: { temperature: number; top_p: number };
  /** The platform reports reasoning tokens apart from output_tokens (they are billed as output). */
  reasoningApart?: boolean;
}

export const OPENAI_FLAVOR: ResponsesFlavor = {
  provider: 'openai', strict: false, summaries: true, midTools: true, serverCompaction: true,
  effort: (e) => e,
};

export class ResponsesProvider implements Provider {
  private apiKey: string;
  private baseUrl: string;
  private flavor: ResponsesFlavor;
  /** Turned off for this process when the API refuses them (unverified on some models). */
  private midTools: boolean;
  private serverCompaction: boolean;

  constructor(apiKey: string, baseUrl: string, flavor: ResponsesFlavor) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.flavor = flavor;
    this.midTools = flavor.midTools;
    this.serverCompaction = flavor.serverCompaction;
  }

  compactsServerSide(): boolean { return this.serverCompaction; }

  async send(req: ProviderRequest): Promise<ProviderResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(req);
      } catch (err) {
        // A feature the model does not take: off for this process, the request again without it.
        if (err instanceof ProviderError && err.status === 400 && attempt < 2) {
          if (this.midTools && /additional_tools/i.test(err.message)) { this.midTools = false; continue; }
          if (this.serverCompaction && /context_management|compaction/i.test(err.message)) { this.serverCompaction = false; continue; }
        }
        throw err;
      }
    }
  }

  private async once(req: ProviderRequest): Promise<ProviderResponse> {
    const body = responsesBody(req, { ...this.flavor, midTools: this.midTools, serverCompaction: this.serverCompaction });
    const res = await postStream(`${this.baseUrl}/responses`, { authorization: `Bearer ${this.apiKey}` }, body, req.signal);
    let final: ResponseObject | undefined;
    for await (const ev of readSse(res, req.signal)) {
      if (ev.data === '[DONE]') break;
      let e: { type: string; delta?: string; response?: ResponseObject; error?: { message?: string; code?: string }; message?: string };
      try { e = JSON.parse(ev.data); } catch { continue; }
      switch (e.type) {
        case 'response.output_text.delta': req.onText?.(e.delta ?? ''); break;
        case 'response.reasoning_summary_text.delta': case 'response.reasoning_text.delta': req.onReasoning?.(e.delta ?? ''); break;
        case 'response.completed':
        case 'response.incomplete': final = e.response; break;
        case 'response.failed': {
          const msg = e.response?.error?.message ?? 'response failed';
          throw new ProviderError(msg, 500, /server_error|overloaded|rate/i.test(e.response?.error?.code ?? msg));
        }
        case 'error': throw new ProviderError(e.message ?? e.error?.message ?? 'stream error', 500, true);
      }
    }
    if (!final) throw new ProviderError('stream ended without a completed response', 0, true);
    return fromResponse(req.model.id, final, this.flavor);
  }
}

export class OpenAIProvider extends ResponsesProvider {
  constructor(apiKey: string, baseUrl = process.env.HARNESS_OPENAI_BASE_URL || 'https://api.openai.com/v1') {
    super(apiKey, baseUrl, OPENAI_FLAVOR);
  }
}

const fn = (t: ToolSpec, strict: boolean | undefined) => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema, ...(strict !== undefined ? { strict } : {}) });

/** The request body. Exported for tests: the cache depends on its exact shape. */
export function responsesBody(req: Pick<ProviderRequest, 'model' | 'system' | 'tools' | 'messages' | 'effort' | 'cacheKey' | 'toolChoice' | 'allTools' | 'deferrable' | 'compactAt'>, flavor: ResponsesFlavor): Record<string, unknown> {
  // Deferred tools loaded mid-session: the tool list keeps only what never waited (and a group loaded some
  // other way); each load is an additional_tools item where it happened, so the cached prefix stays.
  const deferrable = flavor.midTools && req.allTools?.length ? new Set(req.deferrable ?? []) : new Set<string>();
  const additions = deferrable.size ? loadedAt(req.messages, new Set(req.tools.map((t) => t.name).filter((n) => deferrable.has(n)))) : new Map<number, string[]>();
  const placed = new Set([...additions.values()].flat());
  const byName = new Map(req.tools.map((t) => [t.name, t]));
  const input: unknown[] = [];
  req.messages.forEach((m, i) => {
    input.push(...toInputItems(m, flavor.provider));
    const added = additions.get(i);
    if (added) input.push({ type: 'additional_tools', role: 'developer', tools: added.map((n) => fn(byName.get(n)!, flavor.strict)) });
  });
  const top = req.tools.filter((t) => !placed.has(t.name));
  return {
    model: req.model.id,
    instructions: req.system,
    input,
    tools: top.map((t) => fn(t, flavor.strict)),
    tool_choice: req.toolChoice ?? 'auto',
    parallel_tool_calls: true,
    reasoning: { effort: flavor.effort(req.effort), ...(flavor.summaries ? { summary: 'auto' } : {}) },
    max_output_tokens: req.model.maxOutput,
    store: false,
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: req.cacheKey,
    ...(flavor.sampling ?? {}),
    ...(flavor.serverCompaction ? { context_management: [{ type: 'compaction', compact_threshold: req.compactAt ?? req.model.compactAt }] } : {}),
    stream: true,
  };
}

interface OutputItem {
  type: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  role?: string;
  content?: { type: string; text?: string; refusal?: string }[];
  summary?: { type: string; text: string }[];
  encrypted_content?: string;
}
interface ResponseObject {
  status: string;
  output: OutputItem[];
  incomplete_details?: { reason?: string } | null;
  error?: { message?: string; code?: string } | null;
  usage?: {
    input_tokens: number;
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number; cache_write_tokens_details?: { ttl_30m_tokens?: number; ttl_12h_tokens?: number } };
    output_tokens: number;
    output_tokens_details?: { reasoning_tokens?: number };
    total_tokens?: number;
  };
}

export function toInputItems(msg: Message, provider = 'openai'): unknown[] {
  const m = splitToolImages(msg);
  if (m.role === 'assistant') {
    if (m.raw?.provider === provider) return m.raw.payload as unknown[];
    const items: unknown[] = [];
    const text = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
    if (text) items.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
    for (const b of m.content) {
      if (b.type === 'tool_use') items.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input) });
    }
    return items;
  }
  const items: unknown[] = [];
  for (const b of m.content) {
    if (b.type === 'tool_result') items.push({ type: 'function_call_output', call_id: b.tool_use_id, output: b.is_error ? `ERROR: ${b.content}` : b.content || '(no output)' });
  }
  const parts: unknown[] = [];
  for (const b of m.content) {
    if (b.type === 'text') parts.push({ type: 'input_text', text: b.text });
    else if (b.type === 'image') parts.push({ type: 'input_image', image_url: `data:${b.media_type};base64,${b.data}` });
  }
  if (parts.length) items.push({ role: 'user', content: parts });
  return items;
}

export function fromResponse(model: string, r: ResponseObject, flavor: ResponsesFlavor = OPENAI_FLAVOR): ProviderResponse {
  const blocks: Block[] = [];
  let refusal: string | undefined;
  let compacted = false;
  for (const item of r.output) {
    if (item.type === 'reasoning') {
      const text = (item.summary ?? []).map((s) => s.text).join('\n');
      if (text) blocks.push({ type: 'reasoning', text });
    } else if (item.type === 'message') {
      for (const c of item.content ?? []) {
        if (c.type === 'output_text' && c.text) blocks.push({ type: 'text', text: c.text });
        if (c.type === 'refusal') refusal = c.refusal;
      }
    } else if (item.type === 'function_call') {
      const name = item.name ?? '';
      if (!isToolName(name)) { blocks.push({ type: 'text', text: name }); continue; }
      const { value, error } = parseArgs(item.arguments ?? '');
      blocks.push({ type: 'tool_use', id: item.call_id ?? item.id ?? '', name, input: value, ...(error ? { parseError: error } : {}) });
    } else if (item.type === 'compaction') {
      // Server-side compaction: an opaque item, replayed with the rest of the output (raw payload).
      compacted = true;
    }
  }
  const hasTools = blocks.some((b) => b.type === 'tool_use');
  let stop: StopKind = hasTools ? 'tool_use' : 'end';
  if (r.status === 'incomplete') stop = r.incomplete_details?.reason === 'max_output_tokens' ? 'max_tokens' : 'other';
  if (refusal && !hasTools) stop = 'refusal';
  const u = r.usage;
  const cached = u?.input_tokens_details?.cached_tokens ?? 0;
  const written = u?.input_tokens_details?.cache_write_tokens ?? 0;
  const w12h = u?.input_tokens_details?.cache_write_tokens_details?.ttl_12h_tokens ?? 0;
  const reasoning = u?.output_tokens_details?.reasoning_tokens ?? 0;
  // Reasoning reported apart from output_tokens (total = input + output + reasoning) is billed as output too.
  const apart = flavor.reasoningApart && u?.total_tokens !== undefined && u.total_tokens === (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + reasoning;
  return {
    message: { role: 'assistant', content: blocks, raw: { provider: flavor.provider, model, payload: r.output } },
    stop,
    usage: {
      // input_tokens includes the cached part and the cache writes.
      input: Math.max(0, (u?.input_tokens ?? 0) - cached - written),
      cacheRead: cached,
      cacheWrite: written,
      ...(w12h ? { cacheWrite1h: w12h } : {}),
      output: (u?.output_tokens ?? 0) + (apart ? reasoning : 0),
      reasoning,
    },
    notice: refusal ? `The model declined: ${refusal}` : undefined,
    ...(compacted ? { compacted: { summaryTokens: 0, before: u?.input_tokens ?? 0 } } : {}),
  };
}
