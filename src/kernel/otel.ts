// OpenTelemetry export of the trace: each model call and tool call becomes an
// OTLP span (GenAI semantic conventions where they exist), batched and posted
// to <endpoint>/v1/traces as OTLP/HTTP JSON. Off the request path: a span is
// queued in memory and a timer sends batches; a failed send is dropped, never retried into the loop.

import crypto from 'node:crypto';
import type { TraceSpan } from '../core/agent.ts';

type Attr = { key: string; value: { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean } };
const attr = (key: string, v: string | number | boolean | undefined): Attr[] => {
  if (v === undefined) return [];
  if (typeof v === 'string') return [{ key, value: { stringValue: v } }];
  if (typeof v === 'boolean') return [{ key, value: { boolValue: v } }];
  return Number.isInteger(v) ? [{ key, value: { intValue: String(v) } }] : [{ key, value: { doubleValue: v } }];
};

export function parseHeaders(s?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (s ?? '').split(',')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return out;
}

/** One trace per session: the trace id is derived from the session id. */
const traceIdOf = (sessionId: string) => crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
const ns = (ms: number) => (BigInt(Math.round(ms)) * 1_000_000n).toString();

export function toOtlpSpan(sessionId: string, span: TraceSpan & { at: number }) {
  const end = span.at;
  const start = 'ms' in span ? end - span.ms : end;
  const base = { traceId: traceIdOf(sessionId), spanId: crypto.randomBytes(8).toString('hex'), startTimeUnixNano: ns(start), endTimeUnixNano: ns(end), kind: 1 };
  const common = [...attr('harness.session.id', sessionId), ...attr('harness.agent', span.agent)];
  if (span.type === 'model') {
    return {
      ...base, name: `chat ${span.model}`, kind: 3,
      attributes: [...common, ...attr('gen_ai.operation.name', 'chat'), ...attr('gen_ai.request.model', span.model),
        ...attr('gen_ai.usage.input_tokens', span.usage.input + span.usage.cacheRead + span.usage.cacheWrite), ...attr('gen_ai.usage.output_tokens', span.usage.output),
        ...attr('harness.usage.cache_read_tokens', span.usage.cacheRead), ...attr('harness.usage.cache_write_tokens', span.usage.cacheWrite),
        ...attr('harness.usage.reasoning_tokens', span.usage.reasoning), ...attr('harness.cost_usd', span.cost), ...attr('gen_ai.response.finish_reasons', span.stop),
        ...attr('harness.retries', span.retries), ...attr('harness.compaction', span.compaction)],
      status: { code: 1 },
    };
  }
  if (span.type === 'tool') {
    return {
      ...base, name: `execute_tool ${span.tool}`,
      attributes: [...common, ...attr('gen_ai.operation.name', 'execute_tool'), ...attr('gen_ai.tool.name', span.tool), ...attr('harness.tool.output_chars', span.chars), ...attr('harness.tool.images', span.images)],
      status: span.error ? { code: 2, message: 'tool error' } : { code: 1 },
    };
  }
  if (span.type === 'cache') {
    return { ...base, name: 'cache miss', attributes: [...common, ...attr('harness.cache.cause', span.cause), ...attr('harness.cache.section', span.section), ...attr('harness.cache.expected_tokens', span.expected), ...attr('harness.cache.read_tokens', span.read)], status: { code: 1 } };
  }
  return { ...base, name: 'context clear', attributes: [...common, ...attr('harness.cleared_results', span.results), ...attr('harness.cleared_tokens', span.tokens)], status: { code: 1 } };
}

export class OtelExporter {
  private queue: ReturnType<typeof toOtlpSpan>[] = [];
  private timer: NodeJS.Timeout;
  private sending: Promise<void> = Promise.resolve();
  private endpoint: string;
  private opts: { headers?: Record<string, string>; service?: string; intervalMs?: number; log?: (m: string) => void };
  constructor(endpoint: string, opts: { headers?: Record<string, string>; service?: string; intervalMs?: number; log?: (m: string) => void } = {}) {
    this.endpoint = endpoint;
    this.opts = opts;
    this.timer = setInterval(() => { void this.flush(); }, opts.intervalMs ?? 5000);
    this.timer.unref();
  }

  record(sessionId: string, span: TraceSpan & { at: number }): void {
    this.queue.push(toOtlpSpan(sessionId, span));
    if (this.queue.length >= 200) void this.flush();
  }

  flush(): Promise<void> {
    const batch = this.queue.splice(0);
    if (!batch.length) return this.sending;
    const body = {
      resourceSpans: [{
        resource: { attributes: [...attr('service.name', this.opts.service ?? 'harness-web')] },
        scopeSpans: [{ scope: { name: 'harness-web', version: '0.1.0' }, spans: batch }],
      }],
    };
    this.sending = this.sending.then(async () => {
      try {
        const res = await fetch(`${this.endpoint.replace(/\/$/, '')}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json', ...this.opts.headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
        if (!res.ok) this.opts.log?.(`otel export: HTTP ${res.status} (${batch.length} spans dropped)`);
      } catch (e) { this.opts.log?.(`otel export failed: ${(e as Error).message} (${batch.length} spans dropped)`); }
    });
    return this.sending;
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }
}
