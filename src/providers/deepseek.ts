import type { Block, Message } from '../core/types.ts';
import type { Provider, ProviderRequest, ProviderResponse, StopKind } from './types.ts';
import { ProviderError } from './types.ts';
import { isToolName, parseArgs, postStream, readSse } from './http.ts';

// DeepSeek over its OpenAI-compatible chat/completions endpoint.
// Caching is automatic and prefix-based, so the only job here is to keep the
// prefix byte-identical: the system message first, history append-only, and
// each assistant message replayed exactly as received - including
// reasoning_content, which DeepSeek requires back whenever tools are present.

interface ChatToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
interface ChatAssistant { role: 'assistant'; content: string | null; reasoning_content?: string; tool_calls?: ChatToolCall[] }

export class DeepSeekProvider implements Provider {
  private apiKey: string;
  private baseUrl: string;
  constructor(apiKey: string, baseUrl = process.env.HARNESS_DEEPSEEK_BASE_URL || 'https://api.deepseek.com') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async send(req: ProviderRequest): Promise<ProviderResponse> {
    const messages: unknown[] = [{ role: 'system', content: req.system }];
    for (const m of req.messages) messages.push(...toChat(m));
    const body = {
      model: req.model.id,
      messages,
      tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })),
      tool_choice: 'auto',
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: req.model.maxOutput,
      thinking: { type: 'enabled' },
      reasoning_effort: req.effort === 'max' ? 'max' : req.effort === 'low' ? 'low' : 'high',
    };
    const res = await postStream(`${this.baseUrl}/chat/completions`, { authorization: `Bearer ${this.apiKey}` }, body, req.signal);

    let content = '';
    let reasoning = '';
    const calls: { id: string; name: string; args: string }[] = [];
    let finish: string | null = null;
    let usage: Record<string, number> | undefined;
    for await (const ev of readSse(res, req.signal)) {
      if (ev.data === '[DONE]') break;
      let chunk: { choices?: { delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[]; usage?: Record<string, number>; error?: { message?: string } };
      try { chunk = JSON.parse(ev.data); } catch { continue; }
      if (chunk.error) throw new ProviderError(chunk.error.message ?? 'stream error', 500, true);
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const d = choice.delta ?? {};
      if (d.reasoning_content) { reasoning += d.reasoning_content; req.onReasoning?.(d.reasoning_content); }
      if (d.content) { content += d.content; req.onText?.(d.content); }
      for (const tc of d.tool_calls ?? []) {
        const slot = (calls[tc.index] ??= { id: '', name: '', args: '' });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }

    const blocks: Block[] = [];
    if (reasoning) blocks.push({ type: 'reasoning', text: reasoning });
    if (content) blocks.push({ type: 'text', text: content });
    const toolCalls: ChatToolCall[] = [];
    for (const c of calls.filter(Boolean)) {
      // A non-identifier "name" is the model's prose swallowed by a template
      // scraper; show it as text instead of failing the call.
      if (!isToolName(c.name)) { blocks.push({ type: 'text', text: c.name }); continue; }
      const id = c.id || `call_${Math.random().toString(36).slice(2, 10)}`;
      const { value, error } = parseArgs(c.args);
      blocks.push({ type: 'tool_use', id, name: c.name, input: value, ...(error ? { parseError: error } : {}) });
      toolCalls.push({ id, type: 'function', function: { name: c.name, arguments: c.args } });
    }
    const raw: ChatAssistant = { role: 'assistant', content: content || null, reasoning_content: reasoning };
    if (toolCalls.length) raw.tool_calls = toolCalls;

    const stopMap: Record<string, StopKind> = { stop: 'end', tool_calls: 'tool_use', length: 'max_tokens', content_filter: 'refusal' };
    let stop = stopMap[finish ?? ''] ?? 'other';
    if (toolCalls.length && stop !== 'max_tokens') stop = 'tool_use';
    if (!toolCalls.length && stop === 'tool_use') stop = 'end';
    const hit = usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details_cached_tokens ?? 0;
    const prompt = usage?.prompt_tokens ?? 0;
    return {
      message: { role: 'assistant', content: blocks, raw: { provider: 'deepseek', model: req.model.id, payload: raw } },
      stop,
      usage: {
        input: usage?.prompt_cache_miss_tokens ?? Math.max(0, prompt - hit),
        cacheRead: hit,
        cacheWrite: 0,
        output: usage?.completion_tokens ?? 0,
        reasoning: (usage as { completion_tokens_details?: { reasoning_tokens?: number } } | undefined)?.completion_tokens_details?.reasoning_tokens ?? 0,
      },
      notice: stop === 'refusal' ? 'The provider filtered this response.' : undefined,
    };
  }
}

export function toChat(m: Message): unknown[] {
  if (m.role === 'assistant') {
    if (m.raw?.provider === 'deepseek') return [m.raw.payload];
    // A message from another provider: no reasoning to replay.
    const text = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
    const tool_calls = m.content.filter((b) => b.type === 'tool_use').map((b) => {
      const t = b as { id: string; name: string; input: unknown };
      return { id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.input) } };
    });
    return [{ role: 'assistant', content: text || null, reasoning_content: '', ...(tool_calls.length ? { tool_calls } : {}) }];
  }
  const out: unknown[] = [];
  for (const b of m.content) {
    if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? `ERROR: ${b.content}` : b.content || '(no output)' });
  }
  const text = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n\n');
  if (text) out.push({ role: 'user', content: text });
  return out;
}
