import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import type { Message } from '../src/core/types.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { CompatProvider, compatSpec, loadCompatModels, resolveCompat, toCompatChat, type CompatModelConfig } from '../src/providers/compat.ts';
import type { ProviderRequest } from '../src/providers/types.ts';
import { ProviderError } from '../src/providers/types.ts';
import { tempDir } from './helpers.ts';

// The generic OpenAI-compatible provider against local stand-ins for each
// server variation it handles. The real server (Ollama in Docker) is in
// compat-ollama.test.ts.

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }
type Reply = { status?: number; json?: unknown; sse?: unknown[]; raw?: string };

async function mockServer(reply: (seen: Seen, n: number) => Reply) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const s: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: data ? JSON.parse(data) : {} };
      seen.push(s);
      const r = reply(s, seen.length);
      if (r.sse) {
        res.writeHead(r.status ?? 200, { 'content-type': 'text/event-stream' });
        for (const c of r.sse) res.write(`data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`);
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
        res.end(r.raw ?? JSON.stringify(r.json ?? {}));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const delta = (d: Record<string, unknown>, finish: string | null = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

function request(cfg: ReturnType<typeof resolveCompat>, over: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: compatSpec(cfg),
    system: 'SYS',
    tools: [{ name: 'read', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    effort: 'high',
    cacheKey: 'sess-1',
    signal: new AbortController().signal,
    ...over,
  };
}

const provider = (c: CompatModelConfig, key = '') => { const r = resolveCompat(c); return { cfg: r, p: new CompatProvider(r, key) }; };

test('compat: plain streaming answer, usage with cached tokens, bearer key, max_tokens and no unknown fields by default', async () => {
  const srv = await mockServer(() => ({ sse: [
    delta({ role: 'assistant', content: 'Hel' }),
    delta({ content: 'lo' }, 'stop'),
    { choices: [], usage: { prompt_tokens: 120, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 100 } } },
  ] }));
  try {
    const { cfg, p } = provider({ id: 'm1', model: 'served-name', baseUrl: `${srv.url}/v1/`, apiKeyEnv: 'X_KEY', maxOutput: 999 }, 'sk-test');
    let streamed = '';
    const r = await p.send(request(cfg, { onText: (d) => { streamed += d; } }));
    assert.equal(streamed, 'Hello');
    assert.deepEqual(r.message.content, [{ type: 'text', text: 'Hello' }]);
    assert.equal(r.stop, 'end');
    assert.deepEqual(r.usage, { input: 20, cacheRead: 100, cacheWrite: 0, output: 7, reasoning: 0 });
    const s = srv.seen[0]!;
    assert.equal(s.url, '/v1/chat/completions', 'trailing slash on baseUrl tolerated');
    assert.equal(s.headers.authorization, 'Bearer sk-test');
    assert.equal(s.body.model, 'served-name');
    assert.equal(s.body.max_tokens, 999);
    assert.deepEqual(s.body.stream_options, { include_usage: true });
    assert.deepEqual((s.body.messages as unknown[])[0], { role: 'system', content: 'SYS' });
    assert.equal((s.body.tools as { function: { name: string } }[])[0]!.function.name, 'read');
    for (const k of ['prompt_cache_key', 'reasoning_effort', 'parallel_tool_calls', 'max_completion_tokens']) assert.ok(!(k in s.body), `${k} not sent unless configured`);
  } finally { await srv.close(); }
});

test('compat: Azure deployment URL form, api-key header, api-version, max_completion_tokens, prompt_cache_key', async () => {
  const srv = await mockServer(() => ({ sse: [delta({ content: 'ok' }, 'stop'), { choices: [], usage: { prompt_tokens: 10, completion_tokens: 1 } }] }));
  try {
    const { cfg, p } = provider({ id: 'azure-gpt', preset: 'azure', baseUrl: srv.url, azure: { deployment: 'my deploy', apiVersion: '2024-10-21' } }, 'az-key');
    await p.send(request(cfg));
    const s = srv.seen[0]!;
    assert.equal(s.url, '/openai/deployments/my%20deploy/chat/completions?api-version=2024-10-21');
    assert.equal(s.headers['api-key'], 'az-key');
    assert.equal(s.headers.authorization, undefined, 'Azure keys go in api-key, not Authorization');
    assert.equal(s.body.max_completion_tokens, cfg.maxOutput ?? 4096);
    assert.ok(!('max_tokens' in s.body));
    assert.equal(s.body.prompt_cache_key, 'sess-1');
    assert.equal(s.body.model, 'my deploy', 'the deployment is the model by default');
    // Azure's v1 form: the plain path plus a query parameter.
    const v1 = provider({ id: 'azure-v1', preset: 'azure', baseUrl: `${srv.url}/openai/v1`, query: { 'api-version': 'preview' } }, 'k').p;
    assert.equal(v1.url(), `${srv.url}/openai/v1/chat/completions?api-version=preview`);
  } finally { await srv.close(); }
});

test('compat: tool-call deltas split across chunks (two calls interleaved, name and arguments in pieces)', async () => {
  const srv = await mockServer(() => ({ sse: [
    delta({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read', arguments: '' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] }),
    delta({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'gr', arguments: '' } }] }),
    delta({ tool_calls: [{ index: 1, function: { name: 'ep' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] }),
    delta({ tool_calls: [{ index: 1, function: { arguments: '{"pattern":"x"}' } }] }),
    delta({}, 'tool_calls'),
  ] }));
  try {
    const { cfg, p } = provider({ id: 'm', baseUrl: srv.url });
    const r = await p.send(request(cfg));
    assert.equal(r.stop, 'tool_use');
    assert.deepEqual(r.message.content, [
      { type: 'tool_use', id: 'call_a', name: 'read', input: { path: 'a.txt' } },
      { type: 'tool_use', id: 'call_b', name: 'grep', input: { pattern: 'x' } },
    ]);
    // Replayed as the server sent it, then the results as tool messages.
    const replay = toCompatChat(r.message);
    assert.deepEqual(replay, [{ role: 'assistant', content: null, tool_calls: [
      { id: 'call_a', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } },
      { id: 'call_b', type: 'function', function: { name: 'grep', arguments: '{"pattern":"x"}' } },
    ] }]);
    const results: Message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a', content: 'A' }, { type: 'tool_result', tool_use_id: 'call_b', content: 'boom', is_error: true }] };
    assert.deepEqual(toCompatChat(results), [{ role: 'tool', tool_call_id: 'call_a', content: 'A' }, { role: 'tool', tool_call_id: 'call_b', content: 'ERROR: boom' }]);
  } finally { await srv.close(); }
});

test('compat: calls without an index, every call numbered 0 with its own id, finish_reason "stop" with calls', async () => {
  const srv = await mockServer((_s, n) => ({ sse: n === 1
    ? [
      delta({ tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{"path":' } }] }),
      delta({ tool_calls: [{ function: { arguments: '"x"}' } }] }),
      delta({ tool_calls: [{ id: 'c2', function: { name: 'read', arguments: '{"path":"y"}' } }] }),
      delta({}, 'stop'),
    ]
    : [
      delta({ tool_calls: [{ index: 0, id: 'g1', function: { name: 'read', arguments: '{"path":"p"}' } }] }),
      delta({ tool_calls: [{ index: 0, id: 'g2', function: { name: 'glob', arguments: '{"pattern":"*"}' } }] }),
      delta({}, 'stop'),
    ] }));
  try {
    const { cfg, p } = provider({ id: 'm', baseUrl: srv.url });
    const a = await p.send(request(cfg));
    assert.equal(a.stop, 'tool_use', 'calls win over a "stop" finish');
    assert.deepEqual(a.message.content.map((b) => b.type === 'tool_use' && [b.id, b.input]), [['c1', { path: 'x' }], ['c2', { path: 'y' }]]);
    const b = await p.send(request(cfg));
    assert.deepEqual(b.message.content.map((x) => x.type === 'tool_use' && [x.id, x.name]), [['g1', 'read'], ['g2', 'glob']]);
  } finally { await srv.close(); }
});

test('compat: a server that sends no usage gets estimates; stream_options can be turned off', async () => {
  const srv = await mockServer(() => ({ sse: [delta({ content: 'an answer of some length' }, 'stop')] }));
  try {
    const { cfg, p } = provider({ id: 'm', baseUrl: srv.url, streamUsage: false });
    const r = await p.send(request(cfg));
    assert.equal(r.message.content[0]!.type, 'text');
    assert.ok(r.usage.input > 0 && r.usage.output > 0, `estimated usage: ${JSON.stringify(r.usage)}`);
    assert.equal(r.usage.output, Math.ceil('an answer of some length'.length / 4));
    assert.ok(!('stream_options' in srv.seen[0]!.body));
  } finally { await srv.close(); }
});

test('compat: a server that rejects tools gives a clear, non-retryable error naming the fix', async () => {
  const srv = await mockServer((s) => s.body.tools
    ? { status: 400, json: { error: { message: 'registry.ollama.ai/library/gemma:2b does not support tools', type: 'api_error' } } }
    : { sse: [delta({ content: 'fine without tools' }, 'stop')] });
  try {
    const { cfg, p } = provider({ id: 'gemma', baseUrl: srv.url });
    await assert.rejects(p.send(request(cfg)), (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.retryable, false);
      assert.match(err.message, /gemma \(http:\/\/127\.0\.0\.1:\d+\) does not accept tools \(function calling\)/);
      assert.match(err.message, /does not support tools/);
      assert.match(err.message, /"tools": false/);
      return true;
    });
    // Configured without tools: none are sent and it answers.
    const off = provider({ id: 'gemma', baseUrl: srv.url, tools: false });
    const r = await off.p.send(request(off.cfg));
    assert.equal((r.message.content[0] as { text: string }).text, 'fine without tools');
    assert.match(compatSpec(off.cfg).notes ?? '', /without tools/);
    // A refused key names the variable to check; a 5xx stays retryable.
    const bad = await mockServer(() => ({ status: 401, json: { error: { message: 'invalid key' } } }));
    try {
      const k = provider({ id: 'k', baseUrl: bad.url, apiKeyEnv: 'GROQ_API_KEY' }, 'x');
      await assert.rejects(k.p.send(request(k.cfg)), /refused the key \(401\): check GROQ_API_KEY/);
    } finally { await bad.close(); }
    const busy = await mockServer(() => ({ status: 503, json: { error: { message: 'overloaded' } } }));
    try {
      const b = provider({ id: 'b', baseUrl: busy.url });
      await assert.rejects(b.p.send(request(b.cfg)), (err: unknown) => err instanceof ProviderError && err.retryable && err.status === 503);
    } finally { await busy.close(); }
  } finally { await srv.close(); }
});

test('compat: reasoning in reasoning_content, in reasoning (OpenRouter, Ollama) and inline <think> tags', async () => {
  const replies = [
    [delta({ reasoning_content: 'step 1' }), delta({ content: 'A' }, 'stop')],
    [delta({ reasoning: 'thinking hard' }), delta({ content: 'B' }, 'stop')],
    [delta({ content: '<thi' }), delta({ content: 'nk>plan it</th' }), delta({ content: 'ink>\n\nC' }, 'stop')],
  ];
  const srv = await mockServer((_s, n) => ({ sse: replies[n - 1]! }));
  try {
    const { cfg, p } = provider({ id: 'r', baseUrl: srv.url, reasoningEffort: true, replayReasoning: true });
    const out: { text: string; reasoning: string; blocks: unknown }[] = [];
    for (let i = 0; i < 3; i++) {
      let text = '', reasoning = '';
      const r = await p.send(request(cfg, { onText: (d) => { text += d; }, onReasoning: (d) => { reasoning += d; } }));
      out.push({ text, reasoning, blocks: r.message.content });
      if (i === 0) assert.equal((r.message.raw!.payload as { reasoning_content: string }).reasoning_content, 'step 1', 'replayed when configured');
    }
    assert.deepEqual(out.map((o) => [o.reasoning, o.text]), [['step 1', 'A'], ['thinking hard', 'B'], ['plan it', 'C']]);
    assert.deepEqual(out[2]!.blocks, [{ type: 'reasoning', text: 'plan it' }, { type: 'text', text: 'C' }]);
    assert.equal(srv.seen[0]!.body.reasoning_effort, 'high');
    // Not replayed unless asked: most servers reject or ignore it.
    const plain = provider({ id: 'r2', baseUrl: srv.url });
    const msg: Message = { role: 'assistant', content: [], raw: { provider: 'compat', model: 'r', payload: { role: 'assistant', content: 'x', reasoning_content: 'secret' } } };
    assert.deepEqual(toCompatChat(msg), [{ role: 'assistant', content: 'x' }]);
    assert.equal(compatSpec(plain.cfg).effort, 'medium');
  } finally { await srv.close(); }
});

test('compat: non-streaming servers, images as image_url parts, extra headers and body fields', async () => {
  const srv = await mockServer(() => ({ json: { choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 't', type: 'function', function: { name: 'read', arguments: '{"path":"z"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 50, completion_tokens: 5, prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 20 } } }));
  try {
    const { cfg, p } = provider({ id: 'ns', baseUrl: srv.url, stream: false, images: true, headers: { 'HTTP-Referer': 'https://harness.example' }, body: { temperature: 0.2 }, maxTokensField: 'none' });
    const img: Message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'shot', images: [{ media_type: 'image/png', data: 'AAAA' }] }] };
    const r = await p.send(request(cfg, { messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }] }, { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'computer', input: {} }] }, img] }));
    assert.equal(r.stop, 'tool_use');
    assert.deepEqual(r.usage, { input: 20, cacheRead: 30, cacheWrite: 0, output: 5, reasoning: 0 });
    const s = srv.seen[0]!;
    assert.equal(s.body.stream, false);
    assert.ok(!('stream_options' in s.body) && !('max_tokens' in s.body));
    assert.equal(s.body.temperature, 0.2);
    assert.equal(s.headers['http-referer'], 'https://harness.example');
    const msgs = s.body.messages as { role: string; content: unknown }[];
    assert.equal(msgs[3]!.role, 'tool');
    assert.deepEqual((msgs[4]!.content as { type: string }[]).map((c) => c.type), ['text', 'image_url']);
    assert.equal(compatSpec(cfg).vision, true);
  } finally { await srv.close(); }
});

test('compat: configuration - presets, defaults, validation, file and inline JSON, keyless local servers', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'models.json');
  await fs.writeFile(file, JSON.stringify({ models: [{ id: 'groq-llama', preset: 'groq', model: 'llama-3.3-70b-versatile', contextWindow: 131072, maxOutput: 8192, prices: { input: 0.59, output: 0.79 } }] }));
  const { models, providers } = loadCompatModels({
    HARNESS_MODELS_JSON: JSON.stringify([{ id: 'local-qwen', label: 'Qwen (Ollama)', preset: 'ollama', model: 'qwen2.5:0.5b' }]),
    HARNESS_MODELS_FILE: file,
  });
  assert.deepEqual(models.map((m) => [m.id, m.provider, m.label]), [['local-qwen', 'compat:local-qwen', 'Qwen (Ollama)'], ['groq-llama', 'compat:groq-llama', 'groq-llama']]);
  assert.equal(models[0]!.contextWindow, 32768);
  assert.equal(models[0]!.compactAt, Math.floor(32768 * 0.6));
  assert.equal(providers['compat:local-qwen']!.keyless, true);
  assert.deepEqual(providers['compat:groq-llama']!.keyEnv, ['GROQ_API_KEY']);
  assert.deepEqual(models[1]!.rate(0, new Date()), { input: 0.59, output: 0.79, cacheRead: 0.59, cacheWrite: 0.59 });
  const groq = resolveCompat({ id: 'g', preset: 'groq' });
  assert.equal(groq.baseUrl, 'https://api.groq.com/openai/v1');
  assert.equal(groq.maxTokensField, 'max_completion_tokens');
  assert.equal(resolveCompat({ id: 'gem', preset: 'gemini' }).baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');
  for (const [entry, msg] of [
    [{ id: 'x' }, /baseUrl is required/],
    [{ id: 'x', baseUrl: 'ftp://a' }, /http\(s\)/],
    [{ id: 'x', baseUrl: 'http://a', apiKeyEnv: 'sk-live-123 456' }, /environment variable name/],
    [{ id: 'x', preset: 'nope' }, /unknown preset/],
    [{ id: 'bad id!' }, /model id/],
    [{ id: 'x', baseUrl: 'http://a', contextWindow: -1 }, /contextWindow/],
  ] as const) assert.throws(() => resolveCompat(entry as never), msg);
  assert.throws(() => loadCompatModels({ HARNESS_MODELS_JSON: '{nope' }), /HARNESS_MODELS_JSON is not valid JSON/);
  assert.throws(() => loadCompatModels({ HARNESS_MODELS_JSON: '[{"id":"a","baseUrl":"http://x"},{"id":"a","baseUrl":"http://y"}]' }), /listed twice/);
  assert.throws(() => loadCompatModels({ HARNESS_MODELS_FILE: path.join(dir, 'missing.json') }), /HARNESS_MODELS_FILE/);
  assert.deepEqual(loadCompatModels({}).models, []);
});

test('compat: a harness session through a configured model - tool call executed by the loop, then the answer', async () => {
  const ws = await tempDir();
  await fs.writeFile(path.join(ws, 'secret-word.txt'), 'pineapple\n');
  const srv = await mockServer((s, n) => {
    if (n === 1) return { sse: [delta({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"secret-word.txt"}' } }] }), delta({}, 'tool_calls'), { choices: [], usage: { prompt_tokens: 900, completion_tokens: 12 } }] };
    const tool = (s.body.messages as { role: string; content: string }[]).find((m) => m.role === 'tool');
    return { sse: [delta({ content: `The word is ${/pineapple/.test(tool?.content ?? '') ? 'pineapple' : 'unknown'}.` }, 'stop'), { choices: [], usage: { prompt_tokens: 950, completion_tokens: 6 } }] };
  });
  const before = process.env.HARNESS_MODELS_JSON;
  process.env.HARNESS_MODELS_JSON = JSON.stringify([{ id: 'mock-local', baseUrl: `${srv.url}/v1`, label: 'Mock local model', prices: { input: 1, output: 2 } }]);
  const h = await createHarness({ dataDir: await tempDir(), search: null, memory: 'off', scheduler: false });
  try {
    const listed = h.registry.listModels().find((m) => m.id === 'mock-local');
    assert.equal(listed?.available, true, 'a keyless model is available without any key set');
    const s = await h.sessions.create({ model: 'mock-local', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws } });
    const done = new Promise<void>((r) => s.subscribe(s.lastSeq, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
    await s.send('What is the secret word in secret-word.txt?');
    await done;
    const last = s.history.at(-1)!;
    assert.equal(last.role, 'assistant');
    assert.match(JSON.stringify(last.content), /The word is pineapple/);
    assert.equal(srv.seen.length, 2);
    assert.equal(s.meta.usage.output, 18);
    assert.ok(s.meta.cost > 0, 'priced from the configured rates');
  } finally {
    await h.close();
    await srv.close();
    if (before === undefined) delete process.env.HARNESS_MODELS_JSON; else process.env.HARNESS_MODELS_JSON = before;
  }
});
