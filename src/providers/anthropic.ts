import Anthropic from '@anthropic-ai/sdk';
import type { Block, Message } from '../core/types.ts';
import type { Provider, ProviderRequest, ProviderResponse, StopKind, ToolSpec } from './types.ts';
import { ProviderError } from './types.ts';

// Claude over the official SDK's beta Messages stream.
//
// Caching: one explicit breakpoint on the system prompt (tools render before
// system, so it covers both) plus top-level automatic caching for the growing
// conversation tail. Tool-result clearing runs server-side (context editing),
// so the transcript we send stays append-only: that keeps the cache valid and
// keeps preserved-thinking signatures valid on Haiku 5.5.

const IDLE_MS = Number(process.env.HARNESS_STREAM_IDLE_MS ?? 180_000);
const BETAS = ['context-management-2025-06-27'];

export class AnthropicProvider implements Provider {
  private client: Anthropic;
  /** Context editing is beta; if the API refuses it we stop sending it for this process. */
  private contextEditing = true;

  constructor(apiKey: string) {
    // The SDK reads ANTHROPIC_BASE_URL; ignore it unless explicitly meant for us.
    this.client = new Anthropic({ apiKey, baseURL: process.env.HARNESS_ANTHROPIC_BASE_URL || 'https://api.anthropic.com', maxRetries: 0 });
  }

  async send(req: ProviderRequest): Promise<ProviderResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(req);
      } catch (err) {
        if (err instanceof Anthropic.BadRequestError && this.contextEditing && /context_management|context-management/i.test(err.message) && attempt === 0) {
          this.contextEditing = false;
          continue;
        }
        throw this.classify(err, req.signal);
      }
    }
  }

  private body(req: ProviderRequest): Record<string, unknown> {
    return anthropicBody(req, this.contextEditing);
  }

  private async once(req: ProviderRequest): Promise<ProviderResponse> {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort(req.signal.reason);
    req.signal.addEventListener('abort', onAbort, { once: true });
    let idleTimer: NodeJS.Timeout | undefined;
    let stalled = false;
    const bump = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { stalled = true; ctl.abort(new Error('stalled')); }, IDLE_MS);
    };
    try {
      bump();
      const params = { ...this.body(req), betas: this.contextEditing ? BETAS : [] };
      const stream = this.client.beta.messages.stream(params as unknown as Anthropic.Beta.Messages.MessageCreateParamsStreaming, { signal: ctl.signal });
      stream.on('streamEvent', bump);
      stream.on('text', (d) => req.onText?.(d));
      stream.on('thinking', (d) => req.onReasoning?.(d));
      let msg: Anthropic.Beta.Messages.BetaMessage;
      try {
        msg = await stream.finalMessage();
      } catch (err) {
        if (stalled) throw new ProviderError(`stream stalled for ${IDLE_MS / 1000}s`, 0, true);
        throw err;
      }
      return fromAnthropic(req.model.id, msg);
    } finally {
      clearTimeout(idleTimer);
      req.signal.removeEventListener('abort', onAbort);
    }
  }

  private classify(err: unknown, signal: AbortSignal): unknown {
    if (signal.aborted) return err;
    if (err instanceof ProviderError) return err;
    if (err instanceof Anthropic.APIUserAbortError) return err;
    if (err instanceof Anthropic.APIConnectionError) return new ProviderError(`network error: ${err.message}`, 0, true);
    if (err instanceof Anthropic.APIError) {
      const status = err.status ?? 0;
      const ra = Number(err.headers?.get?.('retry-after'));
      return new ProviderError(err.message, status, status === 408 || status === 409 || status === 429 || status >= 500, Number.isFinite(ra) ? ra * 1000 : undefined);
    }
    // The SDK materialises streamed tool input at block end; JSON it cannot
    // parse at all rejects here. Re-issuing the turn is the documented fix.
    if (err instanceof SyntaxError) return new ProviderError(`unparseable tool input: ${err.message}`, 0, true);
    return err;
  }
}

/** The request body (without betas). Exported for tests: caching depends on its exact shape. */
export function anthropicBody(req: Pick<ProviderRequest, 'model' | 'system' | 'tools' | 'messages' | 'effort'>, contextEditing: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model.id,
    max_tokens: req.model.maxOutput,
    // One explicit breakpoint on the frozen system prompt (tools render before
    // it, so it covers both) ...
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
    tools: req.tools.map(toAnthropicTool),
    messages: req.messages.map(toAnthropicMessage),
    // ... plus automatic caching for the growing conversation tail.
    cache_control: { type: 'ephemeral' },
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort: req.effort },
  };
  if (contextEditing) {
    body.context_management = {
      edits: [{
        type: 'clear_tool_uses_20250919',
        // Clear well before compaction, in large batches, so each cache
        // reset buys back a lot of context.
        trigger: { type: 'input_tokens', value: Math.round(req.model.compactAt * 0.6) },
        keep: { type: 'tool_uses', value: 6 },
        clear_at_least: { type: 'input_tokens', value: 12_000 },
        exclude_tools: ['todo_write', 'agent'],
      }],
    };
  }
  return body;
}

function toAnthropicTool(t: ToolSpec) {
  return { name: t.name, description: t.description, input_schema: t.input_schema, eager_input_streaming: true };
}

function toAnthropicMessage(m: Message) {
  if (m.role === 'assistant' && m.raw?.provider === 'anthropic') {
    // Replayed verbatim: thinking signatures, fallback blocks and all.
    return { role: 'assistant', content: m.raw.payload };
  }
  const content: unknown[] = [];
  for (const b of m.content) {
    if (b.type === 'text' && b.text) content.push({ type: 'text', text: b.text });
    else if (b.type === 'tool_use') content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
    else if (b.type === 'tool_result') {
      // Images inside the result: server-side clearing then removes them with it.
      const body = b.images?.length
        ? [{ type: 'text', text: b.content || '(no output)' }, ...b.images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.media_type, data: i.data } }))]
        : b.content || '(no output)';
      content.push({ type: 'tool_result', tool_use_id: b.tool_use_id, content: body, ...(b.is_error ? { is_error: true } : {}) });
    }
    else if (b.type === 'image') content.push({ type: 'image', source: { type: 'base64', media_type: b.media_type, data: b.data } });
  }
  if (content.length === 0) content.push({ type: 'text', text: '(empty)' });
  return { role: m.role, content };
}

function fromAnthropic(model: string, msg: Anthropic.Beta.Messages.BetaMessage): ProviderResponse {
  const blocks: Block[] = [];
  for (const b of msg.content) {
    if (b.type === 'text') blocks.push({ type: 'text', text: b.text });
    else if (b.type === 'thinking') { if (b.thinking) blocks.push({ type: 'reasoning', text: b.thinking }); }
    else if (b.type === 'tool_use') {
      const input = b.input && typeof b.input === 'object' && !Array.isArray(b.input) ? b.input as Record<string, unknown> : {};
      blocks.push({ type: 'tool_use', id: b.id, name: b.name, input });
    }
  }
  const u = msg.usage;
  const stopMap: Record<string, StopKind> = { end_turn: 'end', tool_use: 'tool_use', max_tokens: 'max_tokens', refusal: 'refusal', stop_sequence: 'end', pause_turn: 'other' };
  const stop = stopMap[msg.stop_reason ?? ''] ?? 'other';
  let notice: string | undefined;
  if (stop === 'refusal') {
    const d = (msg as unknown as { stop_details?: { category?: string | null; explanation?: string } }).stop_details;
    notice = `The model declined this request${d?.category ? ` (${d.category})` : ''}.${d?.explanation ? ' ' + d.explanation : ''}`;
  }
  return {
    message: { role: 'assistant', content: blocks, raw: { provider: 'anthropic', model, payload: msg.content } },
    stop,
    usage: {
      input: u.input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      reasoning: 0,
    },
    notice,
  };
}
