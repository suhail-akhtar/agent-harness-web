import Anthropic from '@anthropic-ai/sdk';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Block, Message } from '../core/types.ts';
import type { ModelSpec } from '../core/models.ts';
import type { Provider, ProviderRequest, ProviderResponse, StopKind, ToolSpec } from './types.ts';
import { ProviderError } from './types.ts';

// Claude over the official SDK's beta Messages stream.
//
// Caching: one explicit breakpoint on the system prompt (tools render before
// system, so it covers both) plus top-level automatic caching for the growing
// conversation tail. Tool-result clearing runs server-side (context editing),
// so the transcript we send stays append-only: that keeps the cache valid and
// keeps preserved-thinking signatures valid on Haiku 5.5.

const idleMs = () => Number(process.env.HARNESS_STREAM_IDLE_MS ?? 180_000);

/**
 * The stream is alive while bytes arrive. The SDK drops the API's `ping` events before we see
 * them, so a model thinking quietly for minutes (Haiku did, past 180s, on a long hypothesis step)
 * looked stalled, and every retry stalled the same way. Every chunk off the wire - pings included -
 * resets the request's idle timer (the request's own, through async context); a connection that
 * sends nothing at all is still caught.
 */
const liveness = new AsyncLocalStorage<() => void>();
const livenessFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const alive = liveness.getStore();
  const res = await fetch(input, init);
  if (!alive || !res.body) return res;
  alive();
  const body = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, c) { alive(); c.enqueue(chunk); } }));
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}) as typeof fetch;
const BETAS = ['context-management-2025-06-27'];
const COMPACT_BETA = 'compact-2026-01-12';
/** The API's minimum trigger for server-side compaction. */
const COMPACT_MIN = 50_000;

/** What the summary must keep: the same brief as the client-side compaction prompt. */
export const COMPACT_INSTRUCTIONS = `Write a continuation summary of this session so far: the only record the agent will have when work resumes. Include, densely: (1) the user's requests and constraints, quoting them where the wording matters; (2) what has been done: files created or changed (paths) and key decisions, with reasons; (3) the current state: what works, what fails, exact error messages that still matter; (4) important facts discovered: paths, commands, APIs, conventions, gotchas; (5) what remains, as a concrete list of next steps, starting with the one in progress.`;

export class AnthropicProvider implements Provider {
  private client: Anthropic;
  /** Context editing is beta; if the API refuses it we stop sending it for this process. */
  private contextEditing = true;
  /**
   * Server-side compaction (beta): the API summarises inside the request when
   * the prompt passes the model's compaction point - no extra round trip, and
   * the history stays append-only (preserved thinking stays valid). Off with
   * HARNESS_ANTHROPIC_SERVER_COMPACTION=off, or if the API refuses it.
   */
  private serverCompaction = process.env.HARNESS_ANTHROPIC_SERVER_COMPACTION !== 'off';

  compactsServerSide(model: ModelSpec, compactAt = model.compactAt): boolean {
    return this.contextEditing && this.serverCompaction && compactAt >= COMPACT_MIN;
  }

  constructor(apiKey: string, baseUrl?: string) {
    // The SDK reads ANTHROPIC_BASE_URL; ignore it unless explicitly meant for us.
    this.client = new Anthropic({ apiKey, baseURL: baseUrl || process.env.HARNESS_ANTHROPIC_BASE_URL || 'https://api.anthropic.com', maxRetries: 0, fetch: livenessFetch });
  }

  async send(req: ProviderRequest): Promise<ProviderResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(req);
      } catch (err) {
        if (err instanceof Anthropic.BadRequestError && this.serverCompaction && /compact/i.test(err.message) && attempt < 2) {
          this.serverCompaction = false;
          continue;
        }
        if (err instanceof Anthropic.BadRequestError && this.contextEditing && /context_management|context-management/i.test(err.message) && attempt < 2) {
          this.contextEditing = false;
          continue;
        }
        throw this.classify(err, req.signal);
      }
    }
  }

  private body(req: ProviderRequest): Record<string, unknown> {
    return anthropicBody(req, this.contextEditing, this.compactsServerSide(req.model, req.compactAt));
  }

  private async once(req: ProviderRequest): Promise<ProviderResponse> {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort(req.signal.reason);
    req.signal.addEventListener('abort', onAbort, { once: true });
    let idleTimer: NodeJS.Timeout | undefined;
    let stalled = false;
    const bump = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { stalled = true; ctl.abort(new Error('stalled')); }, idleMs());
    };
    try {
      bump();
      const params = { ...this.body(req), betas: this.contextEditing ? [...BETAS, ...(this.compactsServerSide(req.model, req.compactAt) ? [COMPACT_BETA] : [])] : [] };
      const stream = liveness.run(bump, () => this.client.beta.messages.stream(params as unknown as Anthropic.Beta.Messages.MessageCreateParamsStreaming, { signal: ctl.signal }));
      stream.on('streamEvent', bump);
      stream.on('text', (d) => req.onText?.(d));
      stream.on('thinking', (d) => req.onReasoning?.(d));
      let msg: Anthropic.Beta.Messages.BetaMessage;
      try {
        msg = await stream.finalMessage();
      } catch (err) {
        if (stalled) throw new ProviderError(`stream stalled for ${idleMs() / 1000}s`, 0, true);
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
    // ... which the SDK wraps in its own error (a Sonnet 5.5 postmortem of 6,600 characters slid into
    // XML parameter tags halfway). Asked again; the message keeps only the parse error, not the arguments.
    if (err instanceof Anthropic.AnthropicError && /Unable to parse tool parameter JSON/i.test(err.message)) {
      return new ProviderError(`the model sent tool arguments that are not valid JSON (${/Error: ([^.]*?)(?: in JSON| at position|\. JSON:|$)/.exec(err.message)?.[1]?.slice(0, 160) ?? 'parse error'}); asking again`, 0, true);
    }
    // A connection dropped mid-stream surfaces as undici's TypeError("terminated") or a socket error.
    const code = (err as { code?: string; cause?: { code?: string } })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
    if ((err instanceof TypeError && /terminated|fetch failed|socket|network/i.test(err.message)) || /^(ECONNRESET|EPIPE|ETIMEDOUT|UND_ERR_SOCKET)$/.test(code ?? '')) {
      return new ProviderError(`network error mid-stream: ${(err as Error).message}`, 0, true);
    }
    return err;
  }
}

/** The request body (without betas). Exported for tests: caching depends on its exact shape. */
export function anthropicBody(req: Pick<ProviderRequest, 'model' | 'system' | 'tools' | 'messages' | 'effort' | 'compactAt' | 'compactKeep'>, contextEditing: boolean, serverCompaction = false): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model.id,
    max_tokens: req.model.maxOutput,
    // One explicit breakpoint on the frozen system prompt (tools render before
    // it, so it covers both) ...
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
    tools: req.tools.map(toAnthropicTool),
    messages: req.messages.map((m) => toAnthropicMessage(m, req.model.id)),
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
        trigger: { type: 'input_tokens', value: Math.round((req.compactAt ?? req.model.compactAt) * 0.6) },
        keep: { type: 'tool_uses', value: 6 },
        clear_at_least: { type: 'input_tokens', value: 12_000 },
        // As the harness's own clearing: the todo list, sub-agent reports and loaded skills stay.
        exclude_tools: ['todo_write', 'agent', 'skill'],
      }, ...(serverCompaction ? [{
        type: 'compact_20260112',
        trigger: { type: 'input_tokens', value: Math.max(COMPACT_MIN, req.compactAt ?? req.model.compactAt) },
        // PreCompact hooks' feedback reaches the server's summary too.
        instructions: req.compactKeep ? `${COMPACT_INSTRUCTIONS}\n\nAlso keep:\n${req.compactKeep}` : COMPACT_INSTRUCTIONS,
      }] : [])],
    };
  }
  return body;
}

function toAnthropicTool(t: ToolSpec) {
  return { name: t.name, description: t.description, input_schema: t.input_schema, eager_input_streaming: true };
}

function toAnthropicMessage(m: Message, modelId: string) {
  // Replayed verbatim for the model that wrote it: thinking signatures, fallback blocks and all.
  // Thinking blocks are tied to their model, so after a switch (Haiku -> Sonnet 5.5) the turn is
  // rebuilt from its text and tool calls instead.
  if (m.role === 'assistant' && m.raw?.provider === 'anthropic' && m.raw.model === modelId) {
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

export function fromAnthropic(model: string, msg: Anthropic.Beta.Messages.BetaMessage): ProviderResponse {
  const blocks: Block[] = [];
  for (const b of msg.content) {
    if (b.type === 'text') blocks.push({ type: 'text', text: b.text });
    else if (b.type === 'thinking') { if (b.thinking) blocks.push({ type: 'reasoning', text: b.thinking }); }
    else if (b.type === 'tool_use') {
      const input = b.input && typeof b.input === 'object' && !Array.isArray(b.input) ? b.input as Record<string, unknown> : {};
      blocks.push({ type: 'tool_use', id: b.id, name: b.name, input });
    }
  }
  // With server-side compaction the request ran more than one step (summary,
  // then the reply): the cost is all of them; the context is the last one's.
  type Iter = { type?: string; input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  const iters = ((msg.usage as unknown as { iterations?: Iter[] }).iterations ?? []);
  const u = msg.usage;
  const sum = (k: keyof Iter) => iters.reduce((a, it) => a + (Number(it[k]) || 0), 0);
  const compaction = iters.find((it) => it.type === 'compaction');
  const stopMap: Record<string, StopKind> = { end_turn: 'end', tool_use: 'tool_use', max_tokens: 'max_tokens', refusal: 'refusal', stop_sequence: 'end', pause_turn: 'other' };
  const stop = stopMap[msg.stop_reason ?? ''] ?? 'other';
  let notice: string | undefined;
  if (stop === 'refusal') {
    const d = (msg as unknown as { stop_details?: { category?: string | null; explanation?: string } }).stop_details;
    notice = `The model declined this request${d?.category ? ` (${d.category})` : ''}.${d?.explanation ? ' ' + d.explanation : ''}`;
  }
  const last = { input: u.input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 };
  return {
    message: { role: 'assistant', content: blocks, raw: { provider: 'anthropic', model, payload: msg.content } },
    stop,
    usage: iters.length > 1
      ? { input: sum('input_tokens'), cacheRead: sum('cache_read_input_tokens'), cacheWrite: sum('cache_creation_input_tokens'), output: sum('output_tokens'), reasoning: 0 }
      : { ...last, output: u.output_tokens ?? 0, reasoning: 0 },
    notice,
    ...(iters.length > 1 ? { contextTokens: last.input + last.cacheRead + last.cacheWrite } : {}),
    ...(compaction ? { compacted: { summaryTokens: compaction.output_tokens ?? 0, before: (compaction.input_tokens ?? 0) + (compaction.cache_read_input_tokens ?? 0) + (compaction.cache_creation_input_tokens ?? 0) } } : {}),
  };
}
