import { ProviderError } from './types.ts';

// Shared plumbing for the providers we call over raw HTTP+SSE (OpenAI and
// DeepSeek). We parse the stream ourselves rather than use an SDK so an abort
// can never be mistaken for a clean finish, and so a stalled stream is caught.

const IDLE_MS = Number(process.env.HARNESS_STREAM_IDLE_MS ?? 180_000);
/** The longest one reply may stream: past it the call is retried (or failed over), however busy the stream looks. */
const MAX_CALL_MS = Number(process.env.HARNESS_CALL_MAX_MS ?? 15 * 60_000);

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

export function retryAfter(headers: Headers): number | undefined {
  const v = headers.get('retry-after');
  if (!v) return undefined;
  const s = Number(v);
  if (Number.isFinite(s)) return s * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : undefined;
}

export async function postStream(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<Response> {
  let res: Response;
  // A server that takes the request and never answers would hold the step for good: the
  // response must start within IDLE_MS, like every gap in the stream after it.
  // (A timer cleared once it starts: the body goes on streaming under the same signal.)
  const waiting = new AbortController();
  const startMs = Number(process.env.HARNESS_STREAM_IDLE_MS ?? IDLE_MS);
  const timer = setTimeout(() => waiting.abort(new Error('no response')), startMs);
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, waiting.signal]),
    });
  } catch (err) {
    if (signal.aborted) throw err;
    if (waiting.signal.aborted) throw new ProviderError(`no response within ${startMs / 1000}s`, 0, true);
    throw new ProviderError(`network error: ${(err as Error).message}`, 0, true);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ProviderError(`${res.status} ${text.slice(0, 2000)}`, res.status, isRetryableStatus(res.status), retryAfter(res.headers));
  }
  return res;
}

export interface SseEvent { event?: string; data: string }

/**
 * Yields SSE events from a response body. Throws if the caller's signal fires, nothing arrives for
 * IDLE_MS, or the reply streams past MAX_CALL_MS, so none of these can look like a finished turn.
 * `keepAliveIsIdle`: only data counts, for a server that queues the request and sends keep-alive
 * comments meanwhile (": keep-alive", as DeepSeek does under load): that is stalled, not streaming.
 */
export async function* readSse(res: Response, signal: AbortSignal, limits: { idleMs?: number; maxMs?: number; keepAliveIsIdle?: boolean } = {}): AsyncGenerator<SseEvent> {
  if (!res.body) throw new ProviderError('empty response body', 0, true);
  const idleMs = limits.idleMs ?? Number(process.env.HARNESS_STREAM_IDLE_MS ?? IDLE_MS);
  const maxMs = limits.maxMs ?? Number(process.env.HARNESS_CALL_MAX_MS ?? MAX_CALL_MS);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event: string | undefined;
  let data: string[] = [];
  const started = Date.now();
  let lastData = started;
  try {
    while (true) {
      let timer: NodeJS.Timeout | undefined;
      const now = Date.now();
      const toIdle = idleMs - (now - lastData), toMax = maxMs - (now - started);
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(toMax <= toIdle
          ? new ProviderError(`the reply took longer than ${Math.round(maxMs / 60_000)} min`, 0, true)
          : new ProviderError(`stream stalled for ${idleMs / 1000}s${lastData === started ? ' (no reply yet)' : ''}`, 0, true)), Math.max(0, Math.min(toIdle, toMax)));
      });
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await Promise.race([reader.read(), idle]);
      } catch (err) {
        // A connection dropped mid-stream ("terminated", ECONNRESET) is a network
        // failure like a failed fetch: retry it, never end the step on it.
        if (signal.aborted || err instanceof ProviderError) throw err;
        throw new ProviderError(`network error mid-stream: ${(err as Error).message}`, 0, true);
      } finally {
        clearTimeout(timer);
      }
      if (signal.aborted) throw signal.reason ?? new Error('aborted');
      if (chunk.done) break;
      if (!limits.keepAliveIsIdle) lastData = Date.now();
      buf += decoder.decode(chunk.value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line === '') {
          if (data.length) yield { event, data: data.join('\n') };
          event = undefined;
          data = [];
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
          lastData = Date.now();
        } else if (line.startsWith('event:')) {
          event = line.slice(6).trim();
        }
      }
    }
    if (data.length) yield { event, data: data.join('\n') };
  } finally {
    reader.releaseLock();
    if (!signal.aborted) res.body.cancel().catch(() => {});
  }
  if (signal.aborted) throw signal.reason ?? new Error('aborted');
}

/** JSON.parse that reports failure instead of throwing. */
export function parseArgs(raw: string): { value: Record<string, unknown>; error?: string } {
  if (!raw.trim()) return { value: {} };
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) return { value: v as Record<string, unknown> };
    return { value: {}, error: 'arguments must be a JSON object' };
  } catch (err) {
    return { value: {}, error: `invalid JSON arguments (${(err as Error).message}): ${raw.slice(0, 500)}` };
  }
}

/** A tool "name" that is not an identifier is model prose a template scraper lifted into the call. */
export const isToolName = (name: string): boolean => /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(name);
