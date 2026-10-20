import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runGates } from '../src/gates/gates.ts';
import { validateWorkflow } from '../src/graph/validate.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { checkCitations, parseReferences } from '../src/research/citations.ts';
import { anthropicBackend, deepseekBackend, makeSearchService, openaiBackend, type SearchBackend } from '../src/research/search.ts';
import { normalizeUrl, SourceStore } from '../src/research/sources.ts';
import { LocalHost } from '../src/runtime/host.ts';
import { htmlToText, readable, webSearchTool } from '../src/tools/web.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir } from './helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

async function sources() {
  const s = new SourceStore(path.join(await tempDir(), 'sources'));
  await s.recordFetch({ url: 'https://example.org/mcp?utm_source=x', finalUrl: 'https://www.example.org/mcp/', title: 'MCP', text: 'Anthropic announced the Model Context Protocol on November 25, 2024. It defines two standard transports: stdio and Streamable HTTP.' });
  await s.recordFetch({ url: 'https://stats.example.com/report', finalUrl: 'https://stats.example.com/report', text: 'Revenue grew 23.5% to $4.2 billion in 2025, with 1,250 new customers.' });
  return s;
}

test('sources: a page is found by any URL it was known under; the latest fetch wins', async () => {
  const s = await sources();
  assert.equal(normalizeUrl('https://WWW.Example.org/mcp/?utm_source=x#top'), 'example.org/mcp');
  assert.ok(await s.find('http://example.org/mcp'));
  assert.ok(await s.find('https://example.org/mcp?utm_campaign=y'));
  assert.equal(await s.find('https://example.org/other'), undefined);
  await s.recordFetch({ url: 'https://example.org/mcp', finalUrl: 'https://example.org/mcp', text: 'new text' });
  assert.equal((await s.list()).length, 2);
  assert.equal(await s.text((await s.find('https://example.org/mcp'))!), 'new text');
});

test('citation check: unread pages, misquotes, wrong figures and dangling markers are caught; derived figures pass', async () => {
  const s = await sources();
  const good = `# MCP\n\nAnthropic announced it in 2024 [1]. The spec says it "defines two standard transports: stdio and Streamable HTTP" [1].\nRevenue rose 23.5% to $4.2 billion [2]. That is about 3.4 million per new customer [2] (derived: 4,200 / 1,250).\n\n## References\n[1]: https://example.org/mcp\n[2]: https://stats.example.com/report\n`;
  const r = await checkCitations(good, s);
  assert.deepEqual(r.issues, []);
  assert.equal(r.citations, 2);
  assert.equal(r.sentencesChecked, 4);

  const bad = `Anthropic announced it with "three standard transports" [1]. Revenue rose 25% [2]. It has 9,000 users [2]. See also [3] and [4].\nA blog said so ([post](https://blog.example.net/x)).\n\n[1]: https://example.org/mcp\n[2]: https://stats.example.com/report\n[3]: https://never-read.example.com/page\n`;
  const kinds = (await checkCitations(bad, s)).issues.map((i) => `${i.kind}:${i.detail.slice(0, 30)}`);
  assert.ok(kinds.some((k) => k.startsWith('quote:')), 'misquote');
  assert.ok(kinds.some((k) => k.startsWith('figure:"25%"')), 'wrong percent');
  assert.ok(kinds.some((k) => k.startsWith('figure:"9,000"')), 'wrong count');
  assert.ok(kinds.some((k) => k.startsWith('unread:never fetched')), 'cited but never read');
  assert.ok(kinds.some((k) => k.startsWith('dangling:[4]')), 'marker without a reference');
  assert.ok(kinds.some((k) => k.startsWith('unread:linked')), 'inline link never read');
});

test('reference lists in the usual shapes', () => {
  const refs = parseReferences('[1]: https://a.example/x\n[^2]: Title, https://b.example/y.\n3. Some Org - "Report" (2025). https://c.example/z\n[4] https://d.example/w');
  assert.deepEqual([...refs], [['1', 'https://a.example/x'], ['2', 'https://b.example/y'], ['3', 'https://c.example/z'], ['4', 'https://d.example/w']]);
});

test('readable pages: the article without menus, footers and scripts; a title', () => {
  const html = `<html><head><title>MCP &amp; you</title><script>x()</script></head><body><nav>Home | Docs | Blog</nav><header>Site</header>
  <main><h1>Transports</h1><p>${'MCP defines stdio and Streamable HTTP. '.repeat(20)}</p><table><tr><td>a</td><td>b</td></tr></table></main><aside>Ads</aside><footer>© 2026</footer></body></html>`;
  const r = readable(html);
  assert.equal(r.title, 'MCP & you');
  assert.match(r.text, /^# Transports/);
  assert.match(r.text, /a \| b \|/);
  assert.doesNotMatch(r.text, /Home \| Docs|Ads|© 2026|x\(\)/);
});

test('html to text: links, entities and lists; hostile pages take linear time', () => {
  assert.equal(htmlToText('<ul><li>One <a href="https://x.dev/a">docs</a></li><li>Two &amp;lt; &#x41; &#99999999; &bogus;</li></ul>'), '- One docs (https://x.dev/a)\n- Two &lt; A &#99999999;', 'an out-of-range code point stays as text (it used to throw)');
  assert.equal(htmlToText('a < b and <!-- note --> c'), 'a < b and  c');
  for (const [name, html] of [
    ['unclosed scripts', '<script>'.repeat(40_000)],
    ['unclosed comments', '<!--x'.repeat(40_000)],
    ['tags that never close', '<a href="x"'.repeat(20_000)],
    ['bare angle brackets', '<'.repeat(200_000)],
    ['unclosed main', '<main>x'.repeat(30_000)],
    ['unclosed chrome', '<nav>'.repeat(40_000)],
    ['a long run of spaces', 'a' + ' '.repeat(200_000) + 'b'],
  ] as [string, string][]) {
    const t = Date.now();
    readable(html);
    assert.ok(Date.now() - t < 1000, `${name}: ${Date.now() - t} ms`);
  }
});

test('search service: a named backend, the first available, plugin backends first, or off', () => {
  const b = (name: string, available: boolean): SearchBackend => ({ name, available: () => available, search: async () => ({ hits: [], cost: 0, backend: name }) });
  assert.equal(makeSearchService([b('a', false), b('b', true), b('c', true)], undefined)?.backend, 'b');
  assert.equal(makeSearchService([b('a', true), b('b', true)], 'b')?.backend, 'b');
  assert.equal(makeSearchService([b('a', true)], 'off'), undefined);
  assert.equal(makeSearchService([b('a', false)], undefined), undefined);
  assert.throws(() => makeSearchService([b('a', false)], 'a'), /key or URL is not set/);
});

/** Replaces fetch for one call and returns what was sent. */
async function withFetch<T>(body: unknown, f: () => Promise<T>): Promise<{ result: T; sent: { url: string; init: RequestInit } }> {
  const real = globalThis.fetch;
  let sent!: { url: string; init: RequestInit };
  globalThis.fetch = (async (url: string | URL, init: RequestInit) => { sent = { url: String(url), init }; return new Response(JSON.stringify(body), { status: 200 }); }) as typeof fetch;
  try { return { result: await f(), sent }; } finally { globalThis.fetch = real; }
}

test('search backends turn each API\'s answer into hits with snippets and a cost', async () => {
  const keys = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY };
  Object.assign(process.env, { ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k', DEEPSEEK_API_KEY: 'k' });
  const signal = new AbortController().signal;
  try {
    const a = await withFetch({
      content: [
        { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'q' } },
        { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', title: 'Node.js', url: 'https://nodejs.org/en', page_age: '2026-10-01', encrypted_content: 'x' }, { type: 'web_search_result', title: 'Other', url: 'https://o.example/', encrypted_content: 'y' }] },
        { type: 'text', text: 'https://nodejs.org/en - ', citations: [{ type: 'web_search_result_location', url: 'https://nodejs.org/en', title: 'Node.js', cited_text: 'Node.js 24 is the LTS line.' }] },
        { type: 'text', text: '\nhttps://o.example/ - "Some other sentence."' },
      ],
      usage: { input_tokens: 5000, output_tokens: 100, server_tool_use: { web_search_requests: 1 } },
    }, () => anthropicBackend.search('node lts', { allowedDomains: ['nodejs.org'] }, signal));
    assert.deepEqual(a.result.hits.map((h) => [h.url, h.snippet, h.date]), [['https://nodejs.org/en', 'Node.js 24 is the LTS line.', '2026-10-01'], ['https://o.example/', 'Some other sentence.', undefined]]);
    assert.ok(a.result.cost > 0.01 && a.result.cost < 0.02, String(a.result.cost));
    assert.deepEqual(JSON.parse(String(a.sent.init.body)).tools[0].allowed_domains, ['nodejs.org']);

    const o = await withFetch({
      output: [
        { type: 'web_search_call', action: { type: 'search', sources: [{ type: 'url', url: 'https://nodejs.org/en/about/previous-releases' }, { type: 'url', url: 'https://x.example/' }] } },
        { type: 'message', content: [{ type: 'output_text', text: 'https://nodejs.org/en/about/previous-releases - Node 24 is Active LTS.', annotations: [{ type: 'url_citation', url: 'https://nodejs.org/en/about/previous-releases', title: 'Releases', start_index: 0, end_index: 10 }] }] },
      ],
      usage: { input_tokens: 3000, output_tokens: 50 },
    }, () => openaiBackend.search('node lts', {}, signal));
    assert.deepEqual(o.result.hits.map((h) => [h.title, h.url, h.snippet]), [['Releases', 'https://nodejs.org/en/about/previous-releases', 'Node 24 is Active LTS.'], ['', 'https://x.example/', undefined]]);
    assert.deepEqual(JSON.parse(String(o.sent.init.body)).include, ['web_search_call.action.sources']);

    const d = await withFetch({ results: [{ title: 'A', url: 'https://a.example/x#1', snippet: 'alpha', date: '2026-08-23T16:00:00+00:00' }, { title: 'B', url: 'https://blocked.example/', summary: 'beta' }] },
      () => deepseekBackend.search('q', { blockedDomains: ['blocked.example'] }, signal));
    assert.deepEqual(d.result.hits, [{ title: 'A', url: 'https://a.example/x', snippet: 'alpha', date: '2026-08-23' }]);
    assert.equal(d.result.cost, 0.00075);
  } finally {
    for (const [k, v] of Object.entries(keys)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test('web_search: numbered results, the cost charged to the session, the search recorded', async () => {
  const charged: [string, number][] = [];
  const store = new SourceStore(path.join(await tempDir(), 's'));
  const ctx = {
    signal: new AbortController().signal,
    services: {
      sources: store,
      charge: (w: string, c: number) => charged.push([w, c]),
      search: { backend: 'fake', search: async (q: string, o: { max?: number; allowedDomains?: string[] }) => ({ hits: [{ title: 'T', url: 'https://t.example/', snippet: `about ${q} ${o.allowedDomains?.join(',')}` }], cost: 0.002, backend: 'fake' }) },
    },
  } as unknown as ToolContext;
  const r = await webSearchTool.run({ query: 'mcp', allowed_domains: ['https://modelcontextprotocol.io/docs'] }, ctx);
  assert.equal(r.content, '<search_results query="mcp">\n1. T\n   https://t.example/\n   about mcp modelcontextprotocol.io\n</search_results>');
  assert.deepEqual(charged, [['web_search (fake)', 0.002]]);
  const none = await webSearchTool.run({ query: 'x' }, { ...ctx, services: {} } as ToolContext);
  assert.match(none.content, /not set up/);
});

test('the research pack loads; its workflow is valid; the citations gate and tool judge the report', async () => {
  const h = await createHarness({ dataDir: await tempDir(), plugins: [path.join(here, '..', 'plugins', 'research')], search: null });
  const w = h.registry.workflows.get('deep-research')!;
  assert.deepEqual(validateWorkflow(w), []);
  for (const a of ['research-lead', 'researcher', 'research-writer', 'fact-checker']) assert.ok(h.registry.agents.has(a), a);
  const root = await tempDir();
  const host = new LocalHost(root);
  const s = await sources();
  const gate = async () => (await runGates(h.registry, host, 'applicable', new AbortController().signal, { sources: s })).find((g) => g.name === 'citations');
  assert.equal(await gate(), undefined, 'no report: the gate does not apply');
  await fs.mkdir(path.join(root, 'research'));
  await fs.writeFile(path.join(root, 'research', 'report.md'), 'MCP has "two standard transports" [1].\n\n[1]: https://example.org/mcp\n');
  assert.equal((await gate())!.pass, true);
  await fs.writeFile(path.join(root, 'research', 'report.md'), 'MCP has "five standard transports in all" [1].\n\n[1]: https://example.org/mcp\n');
  const g = (await gate())!;
  assert.equal(g.pass, false);
  assert.match(g.details ?? '', /\[quote\] not found word for word in \[1\]/);
  const tool = h.registry.tools.get('check_citations')!;
  const t = await tool.run({ path: 'research/report.md' }, { host, signal: new AbortController().signal, services: { sources: s } } as unknown as ToolContext);
  assert.equal(t.is_error, true);
  const read = await h.registry.tools.get('sources')!.run({ command: 'read', url: 'http://example.org/mcp' }, { host, services: { sources: s } } as unknown as ToolContext);
  assert.match(read.content, /^<source url="https:\/\/www\.example\.org\/mcp\/">\nAnthropic announced/);
  await h.close();
});
