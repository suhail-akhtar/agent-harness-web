import { costOf, getModel } from '../core/models.ts';
import type { SearchHit } from './sources.ts';

// web_search for every model. A backend is a search API (Brave, Tavily, Exa,
// a SearXNG instance, DeepSeek's search endpoint) or the web search built into
// the Claude or OpenAI API, called once per query by a small model. Every model
// gets the same tool, whichever key the server has.
//
// HARNESS_SEARCH picks one: brave | tavily | exa | searxng | deepseek | anthropic | openai | off.
// Default: the first that has a key, in that order.

export interface SearchOptions { max?: number; allowedDomains?: string[]; blockedDomains?: string[] }
export interface SearchResult { hits: SearchHit[]; cost: number; backend: string }

export interface SearchBackend {
  name: string;
  /** True when it can run (its key or URL is set). */
  available(): boolean;
  search(query: string, opts: SearchOptions, signal: AbortSignal): Promise<SearchResult>;
}

export interface SearchService { readonly backend: string; search(query: string, opts: SearchOptions, signal: AbortSignal): Promise<SearchResult> }

const env = (k: string) => process.env[k]?.trim() || undefined;
const UA = 'harness-web/0.1 (+agent search)';

async function json(res: Response, what: string): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${what} search failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  try { return JSON.parse(text) as Record<string, unknown>; } catch { throw new Error(`${what} search returned something that is not JSON`); }
}

/** Domain filters for APIs that have none: applied to the hits. */
function filterHits(hits: SearchHit[], o: SearchOptions): SearchHit[] {
  const host = (u: string) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
  const match = (h: string, d: string) => h === d.toLowerCase() || h.endsWith('.' + d.toLowerCase());
  return hits.filter((x) => {
    const h = host(x.url);
    if (!h) return false;
    if (o.allowedDomains?.length && !o.allowedDomains.some((d) => match(h, d))) return false;
    if (o.blockedDomains?.some((d) => match(h, d))) return false;
    return true;
  });
}

const siteQuery = (q: string, o: SearchOptions) => (o.allowedDomains?.length === 1 ? `${q} site:${o.allowedDomains[0]}` : q);

export const braveBackend: SearchBackend = {
  name: 'brave',
  available: () => !!env('BRAVE_API_KEY'),
  async search(q, o, signal) {
    const u = new URL('https://api.search.brave.com/res/v1/web/search');
    u.searchParams.set('q', siteQuery(q, o));
    u.searchParams.set('count', String(Math.min(20, o.max ?? 8)));
    const j = await json(await fetch(u, { signal, headers: { accept: 'application/json', 'x-subscription-token': env('BRAVE_API_KEY')!, 'user-agent': UA } }), 'Brave');
    const rows = ((j.web as { results?: unknown[] } | undefined)?.results ?? []) as { title?: string; url?: string; description?: string; age?: string; page_age?: string }[];
    const hits = rows.map((r) => ({ title: strip(r.title ?? ''), url: r.url ?? '', snippet: strip(r.description ?? ''), date: r.page_age ?? r.age }));
    return { hits: filterHits(hits, o), cost: 0, backend: 'brave' };
  },
};

export const tavilyBackend: SearchBackend = {
  name: 'tavily',
  available: () => !!env('TAVILY_API_KEY'),
  async search(q, o, signal) {
    const body = { query: q, max_results: Math.min(20, o.max ?? 8), include_domains: o.allowedDomains ?? [], exclude_domains: o.blockedDomains ?? [] };
    const j = await json(await fetch('https://api.tavily.com/search', { method: 'POST', signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${env('TAVILY_API_KEY')}`, 'user-agent': UA }, body: JSON.stringify(body) }), 'Tavily');
    const rows = (j.results ?? []) as { title?: string; url?: string; content?: string; published_date?: string }[];
    return { hits: filterHits(rows.map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.content, date: r.published_date })), o), cost: 0, backend: 'tavily' };
  },
};

export const exaBackend: SearchBackend = {
  name: 'exa',
  available: () => !!env('EXA_API_KEY'),
  async search(q, o, signal) {
    const body = { query: q, numResults: Math.min(20, o.max ?? 8), ...(o.allowedDomains?.length ? { includeDomains: o.allowedDomains } : {}), ...(o.blockedDomains?.length ? { excludeDomains: o.blockedDomains } : {}), contents: { highlights: true } };
    const j = await json(await fetch('https://api.exa.ai/search', { method: 'POST', signal, headers: { 'content-type': 'application/json', 'x-api-key': env('EXA_API_KEY')!, 'user-agent': UA }, body: JSON.stringify(body) }), 'Exa');
    const rows = (j.results ?? []) as { title?: string; url?: string; publishedDate?: string; highlights?: string[]; text?: string }[];
    return { hits: filterHits(rows.map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.highlights?.join(' … ') ?? r.text?.slice(0, 300), date: r.publishedDate })), o), cost: 0, backend: 'exa' };
  },
};

export const searxngBackend: SearchBackend = {
  name: 'searxng',
  available: () => !!env('HARNESS_SEARXNG_URL'),
  async search(q, o, signal) {
    const u = new URL('search', env('HARNESS_SEARXNG_URL')!.replace(/\/?$/, '/'));
    u.searchParams.set('q', siteQuery(q, o));
    u.searchParams.set('format', 'json');
    const j = await json(await fetch(u, { signal, headers: { accept: 'application/json', 'user-agent': UA } }), 'SearXNG');
    const rows = (j.results ?? []) as { title?: string; url?: string; content?: string; publishedDate?: string }[];
    return { hits: filterHits(rows.map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.content, date: r.publishedDate ?? undefined })), o).slice(0, o.max ?? 8), cost: 0, backend: 'searxng' };
  },
};

/** DeepSeek's search endpoint: $0.75 per 1,000 searches, the cheapest of the keyed options. */
export const deepseekBackend: SearchBackend = {
  name: 'deepseek',
  available: () => !!env('DEEPSEEK_API_KEY'),
  async search(q, o, signal) {
    const base = env('HARNESS_DEEPSEEK_BASE_URL') ?? 'https://api.deepseek.com';
    const res = await fetch(`${base}/v1/tools/search`, {
      method: 'POST', signal,
      headers: { authorization: `Bearer ${env('DEEPSEEK_API_KEY')}`, 'content-type': 'application/json', 'user-agent': UA },
      body: JSON.stringify({ query: siteQuery(q, o).slice(0, 128), count: Math.min(50, (o.max ?? 8) + (o.allowedDomains?.length || o.blockedDomains?.length ? 10 : 0)) }),
    });
    const j = await json(res, 'DeepSeek');
    const rows = (j.results ?? []) as { title?: string; url?: string; snippet?: string; summary?: string; date?: string }[];
    const hits = rows.map((r) => ({ title: r.title ?? '', url: (r.url ?? '').replace(/#\d+$/, ''), snippet: (r.snippet || r.summary || '').replace(/\s+/g, ' ').slice(0, 400), date: r.date?.slice(0, 10) }));
    return { hits: filterHits(hits, o).slice(0, o.max ?? 8), cost: 0.00075, backend: 'deepseek' };
  },
};

const NATIVE_PROMPT = (q: string) => `Run one web search for: ${q}

Then list the most relevant results, one per line, as: URL - one short sentence quoted from that result that is relevant to the search. No other text.`;

/** Claude's server-side web_search, run by a small model. Pricing: the tokens plus $10 per 1,000 searches. */
export const anthropicBackend: SearchBackend = {
  name: 'anthropic',
  available: () => !!(env('ANTHROPIC_API_KEY') ?? env('GW_ANTHROPIC_API_KEY')),
  async search(q, o, signal) {
    const model = env('HARNESS_SEARCH_ANTHROPIC_MODEL') ?? 'claude-haiku-5-5';
    const tool: Record<string, unknown> = { type: 'web_search_20250305', name: 'web_search', max_uses: 1 };
    if (o.allowedDomains?.length) tool.allowed_domains = o.allowedDomains;
    else if (o.blockedDomains?.length) tool.blocked_domains = o.blockedDomains;
    const base = env('HARNESS_ANTHROPIC_BASE_URL') ?? 'https://api.anthropic.com';
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST', signal,
      headers: { 'x-api-key': (env('ANTHROPIC_API_KEY') ?? env('GW_ANTHROPIC_API_KEY'))!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1500, tools: [tool], messages: [{ role: 'user', content: NATIVE_PROMPT(q) }] }),
    });
    const j = await json(res, 'Claude web');
    const content = (j.content ?? []) as { type: string; text?: string; content?: unknown; citations?: { url?: string; title?: string; cited_text?: string }[] }[];
    const hits: SearchHit[] = [];
    for (const b of content) {
      if (b.type !== 'web_search_tool_result') continue;
      if (!Array.isArray(b.content)) throw new Error(`Claude web search failed: ${JSON.stringify(b.content).slice(0, 200)}`);
      for (const r of b.content as { type?: string; title?: string; url?: string; page_age?: string }[]) {
        if (r.type === 'web_search_result' && r.url) hits.push({ title: r.title ?? '', url: r.url, date: r.page_age ?? undefined });
      }
    }
    // Snippets: the model's quoted sentence per URL (its citations carry the exact text).
    for (const b of content) {
      if (b.type !== 'text') continue;
      for (const c of b.citations ?? []) {
        const h = hits.find((x) => x.url === c.url);
        if (h && c.cited_text && !h.snippet) h.snippet = c.cited_text.trim();
      }
      for (const line of (b.text ?? '').split('\n')) {
        const m = /(https?:\/\/\S+?)[\s)]*[-–—:]\s+(.+)/.exec(line);
        const h = m && hits.find((x) => x.url === m[1]);
        if (h && !h.snippet) h.snippet = m![2]!.replace(/^["“]|["”]$/g, '').trim();
      }
    }
    const u = (j.usage ?? {}) as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; server_tool_use?: { web_search_requests?: number } };
    const searches = u.server_tool_use?.web_search_requests ?? 1;
    const cost = priceOf(model, { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, reasoning: 0 }) + searches * 0.01;
    return { hits: hits.slice(0, o.max ?? 8), cost, backend: 'anthropic' };
  },
};

/** OpenAI's web_search tool on the Responses API, run by a small model. */
export const openaiBackend: SearchBackend = {
  name: 'openai',
  available: () => !!env('OPENAI_API_KEY'),
  async search(q, o, signal) {
    const model = env('HARNESS_SEARCH_OPENAI_MODEL') ?? 'gpt-6-luna';
    const tool: Record<string, unknown> = { type: 'web_search' };
    if (o.allowedDomains?.length) tool.filters = { allowed_domains: o.allowedDomains };
    const base = env('HARNESS_OPENAI_BASE_URL') ?? 'https://api.openai.com/v1';
    const res = await fetch(`${base}/responses`, {
      method: 'POST', signal,
      headers: { authorization: `Bearer ${env('OPENAI_API_KEY')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, tools: [tool], tool_choice: 'required', include: ['web_search_call.action.sources'], input: NATIVE_PROMPT(q), reasoning: { effort: 'low' }, store: false }),
    });
    const j = await json(res, 'OpenAI web');
    const out = (j.output ?? []) as { type: string; action?: { sources?: { url?: string; title?: string }[] }; content?: { type: string; text?: string; annotations?: { type: string; url?: string; title?: string; start_index?: number; end_index?: number }[] }[] }[];
    const hits: SearchHit[] = [];
    const add = (url?: string, title?: string) => { if (url && !hits.some((h) => h.url === url)) hits.push({ title: title ?? '', url }); };
    for (const item of out) {
      if (item.type === 'message') {
        for (const c of item.content ?? []) {
          for (const a of c.annotations ?? []) {
            if (a.type !== 'url_citation') continue;
            add(a.url, a.title);
            const h = hits.find((x) => x.url === a.url)!;
            if (!h.title && a.title) h.title = a.title;
          }
          for (const line of (c.text ?? '').split('\n')) {
            const m = /(https?:\/\/[^\s)\]]+)[^-–—:]*[-–—:]\s+(.+)/.exec(line);
            if (!m) continue;
            const url = m[1]!.replace(/[.,]$/, '');
            const h = hits.find((x) => x.url.split('?')[0] === url.split('?')[0]);
            if (h && !h.snippet) h.snippet = m[2]!.replace(/\[[^\]]*\]\([^)]*\)/g, '').replace(/^["“]|["”]$/g, '').trim();
          }
        }
      }
    }
    for (const item of out) if (item.type === 'web_search_call') for (const s of item.action?.sources ?? []) add(s.url, s.title);
    const u = (j.usage ?? {}) as { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
    const cached = u.input_tokens_details?.cached_tokens ?? 0;
    const calls = out.filter((x) => x.type === 'web_search_call').length || 1;
    const cost = priceOf(model, { input: (u.input_tokens ?? 0) - cached, cacheRead: cached, cacheWrite: 0, output: u.output_tokens ?? 0, reasoning: 0 }) + calls * 0.01;
    return { hits: filterHits(hits, o).slice(0, o.max ?? 8), cost, backend: 'openai' };
  },
};

export const BUILTIN_SEARCH: SearchBackend[] = [braveBackend, tavilyBackend, exaBackend, searxngBackend, deepseekBackend, anthropicBackend, openaiBackend];

function priceOf(model: string, u: Parameters<typeof costOf>[1]): number {
  try { return costOf(getModel(model), u); } catch { return 0; }
}

function strip(s: string): string { return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }

/**
 * The search service a harness uses: HARNESS_SEARCH names a backend, else the
 * first available. Plugin backends are offered before the built-in ones.
 */
export function makeSearchService(backends: SearchBackend[], choice = env('HARNESS_SEARCH')): SearchService | undefined {
  if (choice === 'off') return undefined;
  const pick = choice ? backends.find((b) => b.name === choice) : backends.find((b) => b.available());
  if (!pick) return undefined;
  if (choice && !pick.available()) throw new Error(`HARNESS_SEARCH=${choice}, but its key or URL is not set`);
  return { backend: pick.name, search: (q, o, s) => pick.search(q, o, s) };
}
