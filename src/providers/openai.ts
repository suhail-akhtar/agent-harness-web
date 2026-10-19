import type { Block, Message } from '../core/types.ts';
import type { Provider, ProviderRequest, ProviderResponse, StopKind } from './types.ts';
import { ProviderError } from './types.ts';
import { isToolName, parseArgs, postStream, readSse } from './http.ts';

// OpenAI over the Responses API (chat/completions rejects function tools on
// reasoning models). Stateless: store=false, encrypted reasoning items are
// requested and replayed verbatim, and prompt_cache_key pins the conversation
// to one cache shard. OpenAI caches the longest repeated prefix on its own.

export class OpenAIProvider implements Provider {
  private apiKey: string;
  private baseUrl: string;
  constructor(apiKey: string, baseUrl = process.env.HARNESS_OPENAI_BASE_URL || 'https://api.openai.com/v1') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async send(req: ProviderRequest): Promise<ProviderResponse> {
    const body = {
      model: req.model.id,
      instructions: req.system,
      input: req.messages.flatMap(toInputItems),
      tools: req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema, strict: false })),
      tool_choice: 'auto',
      parallel_tool_calls: true,
      reasoning: { effort: req.effort, summary: 'auto' },
      max_output_tokens: req.model.maxOutput,
      store: false,
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: req.cacheKey,
      stream: true,
    };
    const res = await postStream(`${this.baseUrl}/responses`, { authorization: `Bearer ${this.apiKey}` }, body, req.signal);
    let final: ResponseObject | undefined;
    for await (const ev of readSse(res, req.signal)) {
      if (ev.data === '[DONE]') break;
      let e: { type: string; delta?: string; response?: ResponseObject; error?: { message?: string; code?: string }; message?: string };
      try { e = JSON.parse(ev.data); } catch { continue; }
      switch (e.type) {
        case 'response.output_text.delta': req.onText?.(e.delta ?? ''); break;
        case 'response.reasoning_summary_text.delta': req.onReasoning?.(e.delta ?? ''); break;
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
    return fromResponse(req.model.id, final);
  }
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
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    output_tokens: number;
    output_tokens_details?: { reasoning_tokens?: number };
  };
}

export function toInputItems(m: Message): unknown[] {
  if (m.role === 'assistant') {
    if (m.raw?.provider === 'openai') return m.raw.payload as unknown[];
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
  const texts = m.content.filter((b) => b.type === 'text').map((b) => ({ type: 'input_text', text: (b as { text: string }).text }));
  if (texts.length) items.push({ role: 'user', content: texts });
  return items;
}

function fromResponse(model: string, r: ResponseObject): ProviderResponse {
  const blocks: Block[] = [];
  let refusal: string | undefined;
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
    }
  }
  const hasTools = blocks.some((b) => b.type === 'tool_use');
  let stop: StopKind = hasTools ? 'tool_use' : 'end';
  if (r.status === 'incomplete') stop = r.incomplete_details?.reason === 'max_output_tokens' ? 'max_tokens' : 'other';
  if (refusal && !hasTools) stop = 'refusal';
  const u = r.usage;
  const cached = u?.input_tokens_details?.cached_tokens ?? 0;
  const written = u?.input_tokens_details?.cache_write_tokens ?? 0;
  return {
    message: { role: 'assistant', content: blocks, raw: { provider: 'openai', model, payload: r.output } },
    stop,
    usage: {
      // OpenAI's input_tokens includes the cached part.
      input: Math.max(0, (u?.input_tokens ?? 0) - cached - written),
      cacheRead: cached,
      cacheWrite: written,
      output: u?.output_tokens ?? 0,
      reasoning: u?.output_tokens_details?.reasoning_tokens ?? 0,
    },
    notice: refusal ? `The model declined: ${refusal}` : undefined,
  };
}
