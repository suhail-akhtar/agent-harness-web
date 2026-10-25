// Kimi's web tools (search and page reading) are an opt-in of the Kimi provider's settings: off, web_search
// uses the usual backend and Kimi is never called; on, web_search goes to Kimi first and web_fetch asks Kimi for
// a page it reads as empty. The switch is kept in providers.json, set through PUT /api/providers/moonshot.
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { kimiFetch, makeSearchService, setKimiTools, type SearchBackend } from '../src/research/search.ts';
import { kimiBackend } from '../src/research/search.ts';
import { ProviderKeys } from '../src/kernel/provider-keys.ts';
import { Registry } from '../src/kernel/registry.ts';
import { tempDir } from './helpers.ts';

async function stand(): Promise<{ url: string; calls: string[]; close: () => Promise<void> }> {
  const calls: string[] = [];
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
      calls.push(`${req.url} ${body}`);
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/tools/search') res.end(JSON.stringify({ search_results: [{ title: 'QUIC', url: 'https://example.org/quic', snippet: 'RFC 9000' }] }));
      else if (req.url === '/v1/tools/fetch') res.end(JSON.stringify({ title: 'A page', markdown: '# A page\n\nThe text a browser would show.' }));
      else { res.statusCode = 404; res.end('{}'); }
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(srv.address() as { port: number }).port}/v1`, calls, close: () => new Promise((r) => srv.close(() => r())) };
}

test('Kimi web tools: off by default (the usual backend, Kimi never called); on, search and empty-page fetch go to Kimi', async () => {
  const k = await stand();
  const other: SearchBackend = { name: 'brave', available: () => true, search: async () => ({ hits: [{ title: 'b', url: 'https://b.example', snippet: '' }], cost: 0, backend: 'brave' }) };
  let enabled = false;
  setKimiTools(() => ({ enabled, key: 'sk-kimi', baseUrl: k.url }));
  try {
    const svc = makeSearchService([other, kimiBackend], undefined)!;
    assert.equal(svc.backend, 'brave');
    assert.equal((await svc.search('quic', {}, AbortSignal.timeout(5000))).backend, 'brave');
    assert.equal(await kimiFetch('https://example.org', AbortSignal.timeout(5000)), undefined);
    assert.equal(k.calls.length, 0, 'off: Kimi is never called');
    enabled = true;
    assert.equal(svc.backend, 'kimi', 'on: Kimi first, at the next search');
    const r = await svc.search('quic', { max: 3 }, AbortSignal.timeout(5000));
    assert.deepEqual([r.backend, r.hits[0]!.url, r.cost], ['kimi', 'https://example.org/quic', 0.002]);
    assert.match(k.calls[0]!, /\/v1\/tools\/search .*"text_query":"quic"/);
    assert.match((await kimiFetch('https://example.org/js-page', AbortSignal.timeout(5000)))!.text, /The text a browser would show/);
  } finally { setKimiTools(() => ({ enabled: false })); await k.close(); }
});

test('provider options: kept in providers.json beside the base URLs, off unless set', async () => {
  const dir = await tempDir();
  const keys = await new ProviderKeys({ dataDir: dir, registry: new Registry() }).load();
  assert.equal(keys.option('moonshot', 'webTools'), false);
  await keys.setBaseUrl('moonshot', 'https://api.moonshot.cn/v1');
  await keys.setOptions('moonshot', { webTools: true });
  const again = await new ProviderKeys({ dataDir: dir, registry: new Registry() }).load();
  assert.equal(again.option('moonshot', 'webTools'), true);
  assert.equal(again.baseUrl('moonshot'), 'https://api.moonshot.cn/v1', 'the base URL is kept');
});
