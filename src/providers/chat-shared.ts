import { splitToolImages } from './images.ts';
import type { Message } from '../core/types.ts';
import type { ProviderRequest, ProviderResponse } from './types.ts';
import { ProviderError } from './types.ts';
import { readSse } from './http.ts';
import { Accumulator, type ChatChunk } from './compat.ts';

// What the built-in Chat Completions providers with reasoning_content
// (Moonshot's Kimi, Z.ai's GLM) share: the history mapping, reading the
// stream, and reading an error body. The request bodies and the error
// classification differ per platform and stay in each provider.

export interface ChatHistoryOptions {
  /** The provider id whose own assistant turns are replayed verbatim (raw payload). */
  provider: string;
  /**
   * 'inline': a tool result's images go inside the tool message as content parts
   * (Kimi accepts multimodal tool results). 'split': tool messages are text only,
   * the images follow in a user message (splitToolImages).
   */
  toolImages: 'inline' | 'split';
}

const imagePart = (i: { media_type: string; data: string }) => ({ type: 'image_url', image_url: { url: `data:${i.media_type};base64,${i.data}` } });

/**
 * History in Chat Completions form. An assistant turn from the same provider is
 * replayed byte for byte (reasoning_content and all: both platforms want it back
 * for preserved/interleaved thinking, and it keeps the cached prefix identical).
 * A turn from another provider carries no reasoning; its text and calls are kept.
 */
export function toReasoningChat(msg: Message, o: ChatHistoryOptions): unknown[] {
  const m = o.toolImages === 'split' ? splitToolImages(msg) : msg;
  if (m.role === 'assistant') {
    if (m.raw?.provider === o.provider) return [m.raw.payload];
    const text = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
    const tool_calls = m.content.filter((b) => b.type === 'tool_use').map((b) => {
      const t = b as { id: string; name: string; input: unknown };
      return { id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.input) } };
    });
    // Both platforms return "" (not null) as the content of a tool-call turn.
    return [{ role: 'assistant', content: text, ...(tool_calls.length ? { tool_calls } : {}) }];
  }
  const out: unknown[] = [];
  for (const b of m.content) {
    if (b.type !== 'tool_result') continue;
    const text = b.is_error ? `ERROR: ${b.content}` : b.content || '(no output)';
    const content = o.toolImages === 'inline' && b.images?.length ? [{ type: 'text', text }, ...b.images.map(imagePart)] : text;
    out.push({ role: 'tool', tool_call_id: b.tool_use_id, content });
  }
  const text = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n\n');
  const images = m.content.filter((b) => b.type === 'image') as { media_type: string; data: string }[];
  if (images.length) out.push({ role: 'user', content: [...(text ? [{ type: 'text', text }] : []), ...images.map(imagePart)] });
  else if (text) out.push({ role: 'user', content: text });
  return out;
}

export interface StreamedTurn {
  acc: Accumulator;
  /** The raw finish_reason, for platform-specific ones the shared mapping does not know. */
  finish: string | null;
}

/**
 * Reads a Chat Completions SSE stream into an Accumulator. `onError` turns an
 * error object sent inside the stream into the platform's ProviderError.
 */
export async function readChatStream(res: Response, req: ProviderRequest, onError: (e: NonNullable<ChatChunk['error']>) => ProviderError): Promise<StreamedTurn> {
  const acc = new Accumulator(req);
  let done = false;
  for await (const ev of readSse(res, req.signal)) {
    if (ev.data === '[DONE]') { done = true; break; }
    let chunk: ChatChunk;
    try { chunk = JSON.parse(ev.data); } catch { continue; }
    if (chunk.error) throw onError(chunk.error);
    // Older Kimi streams put the final usage inside the choice.
    if (!chunk.usage && chunk.choices?.[0]?.usage) chunk.usage = chunk.choices[0].usage;
    // ... and may carry cached_tokens at the top of usage only.
    const u = chunk.usage as (NonNullable<ChatChunk['usage']> & { cached_tokens?: number }) | null | undefined;
    if (u && u.cached_tokens !== undefined && !u.prompt_tokens_details) u.prompt_tokens_details = { cached_tokens: u.cached_tokens };
    acc.add(chunk, true);
  }
  // A stream that stopped with neither [DONE] nor a finish reason was cut off, not answered: asked again
  // (Kimi: "always use data: [DONE]" to tell a complete reply).
  if (!done && !acc.finish_ && !req.signal.aborted) throw new ProviderError('the response stream ended before it was complete', 0, true);
  return { acc, finish: acc.finish_ };
}

/**
 * Finishes a turn: the payload replayed next time is the assistant message as
 * the platform returned it - content "" rather than null for a tool-call turn,
 * and reasoning_content only when there was reasoning.
 */
export function finishTurn(t: StreamedTurn, model: string, provider: string, body: Record<string, unknown>): ProviderResponse {
  const r = t.acc.finish(model, JSON.stringify(body.messages).length + JSON.stringify(body.tools ?? []).length, true, provider);
  const p = r.message.raw!.payload as { content: string | null; reasoning_content?: string };
  if (p.content === null) p.content = '';
  if (!p.reasoning_content) delete p.reasoning_content;
  return r;
}

/** The JSON error body of a failed request, from the message postStream built ("<status> <body>"). */
export function errorBody(err: ProviderError): { code?: string; type?: string; message: string } {
  const text = err.message.replace(/^\d{3} /, '');
  try {
    type E = { code?: string | number; type?: string; message?: string };
    const j = JSON.parse(text) as E & { error?: E };
    const e: E = j.error ?? j;
    return { code: e.code !== undefined ? String(e.code) : undefined, type: e.type, message: e.message ?? text };
  } catch {
    return { message: text };
  }
}
