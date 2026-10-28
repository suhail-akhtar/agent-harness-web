// A Prometheus HTTP API client and the compact summaries a model can use:
// per series min/max/avg/last, sorted, top N - never thousands of raw points.

import { formatDuration, parseDuration } from './inventory.mjs';
import { fmt, summarize } from './stats.mjs';

export const MAX_POINTS = 300;
export const MAX_RANGE_MS = 90 * 86_400_000;

/** "now", "now-1h", an ISO time or unix seconds, as unix seconds. */
export function parseTime(v, now = Date.now()) {
  if (v === undefined || v === null || v === '' || v === 'now') return now / 1000;
  if (typeof v === 'number') return v > 1e12 ? v / 1000 : v;
  const s = String(v).trim();
  const rel = /^now\s*-\s*(.+)$/.exec(s);
  if (rel) {
    const d = parseDuration(rel[1].trim());
    if (!(d >= 0)) throw new Error(`"${s}" is not a time: use now, now-1h, an ISO time or unix seconds`);
    return (now - d) / 1000;
  }
  if (/^\d+(\.\d+)?$/.test(s)) { const n = Number(s); return n > 1e12 ? n / 1000 : n; }
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`"${s}" is not a time: use now, now-1h, an ISO time or unix seconds`);
  return t / 1000;
}

/** The step a range query uses: what was asked, raised so no series has more than MAX_POINTS points. */
export function chooseStep(startS, endS, asked) {
  const range = endS - startS;
  const want = asked ? parseDuration(asked) / 1000 : NaN;
  const min = Math.max(1, Math.ceil(range / MAX_POINTS));
  const step = Number.isFinite(want) && want > 0 ? Math.max(want, min) : Math.max(min, 15);
  return { step, raised: Number.isFinite(want) && want > 0 && want < min };
}

export class PromError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; }
}

export function promClient({ url, fetchImpl = fetch, token, timeoutMs = 30_000 }) {
  if (!url) throw new PromError('No Prometheus is configured: set monitoring.prometheus in the inventory (.harness/ops/inventory.yaml) or HARNESS_OPS_PROMETHEUS_URL.', 'config');
  const base = String(url).replace(/\/+$/, '');
  async function get(pathname, params, signal) {
    const u = new URL(`${base}${pathname}`);
    for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    let res;
    try {
      res = await fetchImpl(u, { headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: sig });
    } catch (e) {
      throw new PromError(`Prometheus at ${base} did not answer (${e.name === 'TimeoutError' ? 'timed out' : e.cause?.code ?? e.message}). Check that it runs and the URL is right.`, 'unreachable');
    }
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { throw new PromError(`Prometheus at ${base} answered HTTP ${res.status} with something that is not its API (${text.slice(0, 120)})`, 'protocol'); }
    if (body.status !== 'success') throw new PromError(`${body.errorType ?? `HTTP ${res.status}`}: ${body.error ?? 'query failed'}`, body.errorType ?? 'error');
    return body;
  }
  return {
    base,
    async instant(query, time, signal) { return (await get('/api/v1/query', { query, time }, signal)).data; },
    async range(query, start, end, step, signal) { return (await get('/api/v1/query_range', { query, start, end, step }, signal)).data; },
    async targets(signal) { return (await get('/api/v1/targets', { state: 'active' }, signal)).data; },
    async rules(signal) { return (await get('/api/v1/rules', {}, signal)).data; },
    /** A parse check: the parse_query endpoint where it exists (Prometheus 2.49+), else an instant query. */
    async parse(query, signal) {
      try { await get('/api/v1/parse_query', { query }, signal); return { ok: true }; } catch (e) {
        if (e.kind === 'bad_data') return { ok: false, error: e.message };
        if (e.kind !== 'protocol' && !/404|not found/i.test(e.message)) throw e;
      }
      try { await get('/api/v1/query', { query, time: Math.floor(Date.now() / 1000) }, signal); return { ok: true }; } catch (e) {
        if (e.kind === 'bad_data') return { ok: false, error: e.message };
        throw e;
      }
    },
  };
}

export function labelString(metric) {
  const { __name__: name, ...rest } = metric ?? {};
  const inner = Object.entries(rest).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}="${v}"`).join(', ');
  return `${name ?? ''}{${inner}}`;
}

/** An instant or range result as compact text, top N series by `sort` (last, max, avg, min). */
export function summarizeResult(data, { top = 10, sort = 'last', order = 'desc', unit = '' } = {}) {
  const u = unit ? ` ${unit}` : '';
  if (!data) return { text: 'no data', series: 0 };
  if (data.resultType === 'scalar' || data.resultType === 'string') return { text: `${data.resultType}: ${data.result?.[1]}`, series: 1 };
  const rows = (data.result ?? []).map((r) => {
    if (data.resultType === 'vector') { const v = Number(r.value?.[1]); return { labels: labelString(r.metric), last: v, max: v, min: v, avg: v, count: 1 }; }
    const pts = (r.values ?? []).map(([t, v]) => [Number(t), Number(v)]);
    const s = summarize(pts);
    return { labels: labelString(r.metric), ...s, from: pts[0]?.[0], to: pts[pts.length - 1]?.[0] };
  });
  if (!rows.length) return { text: 'The query returned no series (empty result). Check the metric and label names, e.g. with a query of {__name__=~"part_of_name.*"} or count by (job) (up).', series: 0, rows };
  const key = ['last', 'max', 'avg', 'min'].includes(sort) ? sort : 'last';
  rows.sort((a, b) => (order === 'asc' ? 1 : -1) * ((Number.isFinite(a[key]) ? a[key] : -Infinity) - (Number.isFinite(b[key]) ? b[key] : -Infinity)));
  const shown = rows.slice(0, Math.max(1, top));
  const lines = shown.map((r) => (data.resultType === 'vector'
    ? `${r.labels} = ${fmt(r.last)}${u}`
    : `${r.labels}: last ${fmt(r.last)}${u}, min ${fmt(r.min)}, max ${fmt(r.max)}, avg ${fmt(r.avg)} (${r.count} points)`));
  if (rows.length > shown.length) lines.push(`... ${rows.length - shown.length} more series (sorted by ${key} ${order}; raise top or narrow the query with labels)`);
  return { text: lines.join('\n'), series: rows.length, rows };
}

export const describeStep = (s) => formatDuration(s * 1000);
