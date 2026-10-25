import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { costOf, getModel } from '../src/core/models.ts';
import type { Message } from '../src/core/types.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { BUILTIN_PROVIDERS } from '../src/providers/index.ts';
import { kimiEffort, mfjsStrict, moonshotBalance, moonshotBody, moonshotEstimateTokens, MoonshotProvider } from '../src/providers/moonshot.ts';
import type { ProviderRequest } from '../src/providers/types.ts';
import { ProviderError } from '../src/providers/types.ts';
import { delta, mockServer } from './chat-mock.ts';
import { tempDir } from './helpers.ts';

// The Kimi provider against a local stand-in speaking the Kimi Open Platform's
// documented Chat Completions wire format (https://platform.kimi.ai/docs/api/chat):
// request fields per model, SSE with reasoning_content and split tool-call
// deltas, usage with cache reads and writes, and the documented error types.

const READ_TOOL = { name: 'read', description: 'Read a file', input_schema: { type: 'object' as const, properties: { path: { type: 'string' } }, required: ['path'] } };

function request(model: string, over: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: getModel(model),
    system: 'SYS',
    tools: [READ_TOOL],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    effort: 'high',
    cacheKey: 'sess-1',
    signal: new AbortController().signal,
    ...over,
  };
}

const usage = { prompt_tokens: 1000, completion_tokens: 40, total_tokens: 1040, cached_tokens: 768, prompt_tokens_details: { cached_tokens: 768, cache_write_tokens: 200 } };

test('moonshot: kimi-k3 request - effort, cache key, strict tools, usage in the stream, no fixed sampling fields', async () => {
  const srv = await mockServer(() => ({ sse: [delta({ role: 'assistant', content: '' }), delta({ content: 'ok' }, 'stop'), { choices: [], usage }] }));
  try {
    const p = new MoonshotProvider('sk-kimi', `${srv.url}/v1/`);
    const r = await p.send(request('kimi-k3', { effort: 'medium' }));
    const s = srv.seen[0]!;
    assert.equal(s.url, '/v1/chat/completions');
    assert.equal(s.headers.authorization, 'Bearer sk-kimi');
    const b = s.body;
    assert.equal(b.model, 'kimi-k3');
    assert.deepEqual(b.messages, [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }]);
    assert.deepEqual(b.tools, [{ type: 'function', function: { name: 'read', description: 'Read a file', parameters: READ_TOOL.input_schema, strict: true } }]);
    assert.equal(b.tool_choice, 'auto');
    assert.equal(b.stream, true);
    assert.deepEqual(b.stream_options, { include_usage: true });
    assert.equal(b.max_completion_tokens, 64_000);
    assert.ok(!('max_tokens' in b), 'max_tokens is deprecated on Kimi');
    assert.equal(b.prompt_cache_key, 'sess-1');
    assert.equal(b.reasoning_effort, 'high', 'medium maps to high (K3 has low/high/max)');
    for (const k of ['thinking', 'temperature', 'top_p', 'n', 'presence_penalty', 'frequency_penalty', 'prompt_cache_options']) assert.ok(!(k in b), `${k} must not be sent`);
    // prompt_tokens includes the cached part and the written part.
    assert.deepEqual(r.usage, { input: 32, cacheRead: 768, cacheWrite: 200, output: 40, reasoning: 0 });
    assert.equal(r.stop, 'end');
    assert.deepEqual(r.message.content, [{ type: 'text', text: 'ok' }]);
    assert.deepEqual(r.message.raw, { provider: 'moonshot', model: 'kimi-k3', payload: { role: 'assistant', content: 'ok' } });
  } finally { await srv.close(); }
});

test('moonshot: effort and thinking per model, and the 1-hour cache tier for K3 only', () => {
  assert.deepEqual(['low', 'medium', 'high', 'xhigh', 'max'].map((e) => kimiEffort(e as never)), ['low', 'high', 'high', 'max', 'max']);
  const k27 = moonshotBody(request('kimi-k2.7-code'));
  assert.ok(!('reasoning_effort' in k27) && !('thinking' in k27), 'K2.7 Code always thinks; no controls are sent');
  assert.deepEqual(moonshotBody(request('kimi-k2.6', { effort: 'low' })).thinking, { type: 'disabled' });
  assert.deepEqual(moonshotBody(request('kimi-k2.6', { effort: 'high' })).thinking, { type: 'enabled', keep: 'all' });
  assert.ok(!('reasoning_effort' in moonshotBody(request('kimi-k2.6'))));
  assert.equal(moonshotBody(request('kimi-k3', { effort: 'max' })).reasoning_effort, 'max');
  assert.deepEqual(moonshotBody(request('kimi-k3'), { HARNESS_MOONSHOT_CACHE_TTL: '1h' }).prompt_cache_options, { mode: 'implicit', ttl: '1h' });
  assert.ok(!('prompt_cache_options' in moonshotBody(request('kimi-k2.6'), { HARNESS_MOONSHOT_CACHE_TTL: '1h' })), 'K2 models have no cache-write tiers');
  // No tools: neither tools nor tool_choice.
  const bare = moonshotBody(request('kimi-k3', { tools: [] }));
  assert.ok(!('tools' in bare) && !('tool_choice' in bare));
});

test('moonshot: a schema outside MFJS is sent with strict false instead of being rejected', () => {
  assert.equal(mfjsStrict(READ_TOOL.input_schema), true);
  assert.equal(mfjsStrict({ type: 'object', properties: { a: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, b: { type: 'string', enum: ['x', 'y'] } }, additionalProperties: false }), true);
  assert.equal(mfjsStrict({ type: 'object', properties: { when: { type: 'string', format: 'date-time' } } }), false);
  assert.equal(mfjsStrict({ type: 'object', properties: { v: { oneOf: [{ type: 'string' }, { type: 'number' }] } } }), false);
  assert.equal(mfjsStrict({ type: 'object', title: 'X', properties: {} }), false);
  assert.equal(mfjsStrict({ type: 'object', properties: { e: { enum: ['a', 1] } } }), false, 'mixed enum types');
  assert.equal(mfjsStrict({ type: 'object', properties: { r: { $ref: 'https://example.com/s.json' } } }), false);
  const body = moonshotBody(request('kimi-k3', { tools: [{ name: 'when', description: 'd', input_schema: { type: 'object', properties: { at: { type: 'string', format: 'date' } } } }] }));
  assert.equal((body.tools as { function: { strict: boolean } }[])[0]!.function.strict, false);
});

test('moonshot: streamed reasoning and two parallel tool calls split across chunks; the assistant turn replays verbatim', async () => {
  const srv = await mockServer((_s, n) => n === 1 ? { sse: [
    delta({ role: 'assistant', reasoning_content: 'Need ' }),
    delta({ reasoning_content: 'two files.' }),
    delta({ tool_calls: [{ index: 0, id: 'read:0', type: 'function', function: { name: 'read', arguments: '' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
    delta({ tool_calls: [{ index: 1, id: 'read:1', type: 'function', function: { name: 'read', arguments: '{"path":"b.txt"}' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }),
    delta({}, 'tool_calls'),
    { choices: [], usage: { prompt_tokens: 500, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 480 } } },
  ] } : { sse: [delta({ content: 'Both read.' }, 'stop', { prompt_tokens: 700, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 512, cache_write_tokens: 0 } })] });
  try {
    const p = new MoonshotProvider('k', `${srv.url}/v1`);
    let reasoning = '';
    const first = await p.send(request('kimi-k3', { onReasoning: (d) => { reasoning += d; } }));
    assert.equal(reasoning, 'Need two files.');
    assert.equal(first.stop, 'tool_use');
    assert.deepEqual(first.message.content, [
      { type: 'reasoning', text: 'Need two files.' },
      { type: 'tool_use', id: 'read:0', name: 'read', input: { path: 'a.txt' } },
      { type: 'tool_use', id: 'read:1', name: 'read', input: { path: 'b.txt' } },
    ]);
    const payload = first.message.raw!.payload;
    assert.deepEqual(payload, {
      role: 'assistant', content: '', reasoning_content: 'Need two files.',
      tool_calls: [
        { id: 'read:0', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } },
        { id: 'read:1', type: 'function', function: { name: 'read', arguments: '{"path":"b.txt"}' } },
      ],
    });
    assert.deepEqual(first.usage, { input: 20, cacheRead: 0, cacheWrite: 480, output: 30, reasoning: 0 });

    const results: Message = { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'read:0', content: 'A' },
      { type: 'tool_result', tool_use_id: 'read:1', content: 'no such file', is_error: true, images: [{ media_type: 'image/png', data: 'AAAA' }] },
    ] };
    const history: Message[] = [request('kimi-k3').messages[0]!, first.message, results];
    const second = await p.send(request('kimi-k3', { messages: history }));
    assert.equal(second.stop, 'end');
    assert.deepEqual(second.usage, { input: 188, cacheRead: 512, cacheWrite: 0, output: 5, reasoning: 0 }, 'usage on the finishing chunk is read too');
    const msgs = srv.seen[1]!.body.messages as Record<string, unknown>[];
    assert.deepEqual(msgs[2], payload, 'the assistant message goes back exactly as received (reasoning_content included)');
    assert.deepEqual(msgs[3], { role: 'tool', tool_call_id: 'read:0', content: 'A' });
    assert.deepEqual(msgs[4], { role: 'tool', tool_call_id: 'read:1', content: [{ type: 'text', text: 'ERROR: no such file' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }, 'Kimi takes images inside the tool result');
    assert.equal(msgs.length, 5);
    // The first request is a byte-identical prefix of the second (what the cache matches).
    const a = JSON.stringify(srv.seen[0]!.body.messages);
    assert.ok(JSON.stringify(msgs).startsWith(a.slice(0, -1)));
  } finally { await srv.close(); }
});

test('moonshot: history from another provider, images from the user, legacy usage inside the choice', async () => {
  const srv = await mockServer(() => ({ sse: [delta({ content: 'seen' }), { choices: [{ index: 0, delta: {}, finish_reason: 'stop', usage: { prompt_tokens: 90, completion_tokens: 2, cached_tokens: 64 } }] }] }));
  try {
    const p = new MoonshotProvider('k', `${srv.url}/v1`);
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', media_type: 'image/jpeg', data: 'BBBB' }] },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'x' }, { type: 'text', text: 'calling' }, { type: 'tool_use', id: 'c1', name: 'read', input: { path: 'z' } }], raw: { provider: 'deepseek', model: 'deepseek-flash', payload: { role: 'assistant', content: 'calling', reasoning_content: 'x' } } },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '' }] },
    ];
    const r = await p.send(request('kimi-k2.6', { messages }));
    assert.equal(r.stop, 'end');
    assert.deepEqual(r.usage, { input: 26, cacheRead: 64, cacheWrite: 0, output: 2, reasoning: 0 });
    const msgs = srv.seen[0]!.body.messages as Record<string, unknown>[];
    assert.deepEqual(msgs[1], { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB' } }] });
    assert.deepEqual(msgs[2], { role: 'assistant', content: 'calling', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"z"}' } }] }, 'no reasoning from another provider');
    assert.deepEqual(msgs[3], { role: 'tool', tool_call_id: 'c1', content: '(no output)' });
  } finally { await srv.close(); }
});

test('moonshot: errors - overload retried after Retry-After, balance and daily limits are not, context and key errors say what to do', async () => {
  const errors: Record<string, { status: number; body: unknown; headers?: Record<string, string> }> = {
    overload: { status: 429, body: { error: { type: 'engine_overloaded_error', message: 'The engine is currently overloaded, please try again later' } }, headers: { 'retry-after': '7' } },
    rpm: { status: 429, body: { error: { type: 'rate_limit_reached_error', message: 'Organization-level RPM limit reached' } }, headers: { 'retry-after': '2' } },
    tpd: { status: 429, body: { error: { type: 'rate_limit_reached_error', message: 'Organization-level TPD limit reached' } } },
    quota: { status: 429, body: { error: { type: 'exceeded_current_quota_error', message: 'Account balance is insufficient or the account has been disabled' } } },
    long: { status: 400, body: { error: { type: 'invalid_request_error', message: 'Input token length too long' } } },
    key: { status: 401, body: { error: { type: 'incorrect_api_key_error', message: 'Incorrect API key provided' } } },
    model: { status: 404, body: { error: { type: 'resource_not_found_error', message: 'Model not found, or this account does not have permission to access the model' } } },
    filter: { status: 400, body: { error: { type: 'content_filter', message: 'The request was rejected because it was considered high risk' } } },
    server: { status: 503, body: { error: { type: 'server_unavailable', message: 'unavailable' } } },
  };
  let which = 'overload';
  const srv = await mockServer((s) => {
    if (s.url === '/v1/users/me/balance') return { json: { code: 0, data: { available_balance: 0, voucher_balance: 0, cash_balance: -0.42 }, scode: '0x0', status: true } };
    const e = errors[which]!;
    return { status: e.status, json: e.body, headers: e.headers };
  });
  const p = new MoonshotProvider('k', `${srv.url}/v1`);
  const fail = async (w: string) => {
    which = w;
    try { await p.send(request('kimi-k3')); } catch (err) { assert.ok(err instanceof ProviderError, String(err)); return err; }
    throw new Error(`${w}: no error`);
  };
  try {
    let e = await fail('overload');
    assert.equal(e.retryable, true); assert.equal(e.retryAfterMs, 7000); assert.equal(e.status, 429);
    e = await fail('rpm');
    assert.equal(e.retryable, true); assert.equal(e.retryAfterMs, 2000);
    e = await fail('tpd');
    assert.equal(e.retryable, false); assert.match(e.message, /daily token limit/);
    e = await fail('quota');
    assert.equal(e.retryable, false);
    assert.match(e.message, /insufficient balance/);
    assert.match(e.message, /Available balance: \$0\.00 \(cash \$-0\.42/, 'the balance is looked up on this error only');
    assert.equal(srv.seen.filter((s) => s.url === '/v1/users/me/balance').length, 1);
    e = await fail('long');
    assert.equal(e.retryable, false); assert.match(e.message, /context window.*Compact/);
    e = await fail('key');
    assert.equal(e.retryable, false); assert.match(e.message, /MOONSHOT_API_KEY/); assert.match(e.message, /api\.moonshot\.cn/);
    e = await fail('model');
    assert.equal(e.retryable, false); assert.match(e.message, /top-up/);
    e = await fail('filter');
    assert.equal(e.retryable, false);
    e = await fail('server');
    assert.equal(e.retryable, true);
  } finally { await srv.close(); }
});

test('moonshot: an error inside the stream is a ProviderError of its type', async () => {
  const srv = await mockServer(() => ({ sse: [delta({ content: 'par' }), { error: { type: 'engine_overloaded_error', message: 'overloaded mid-stream' } }] }));
  try {
    await assert.rejects(new MoonshotProvider('k', `${srv.url}/v1`).send(request('kimi-k3')), (e: unknown) => e instanceof ProviderError && e.retryable && /overloaded mid-stream/.test(e.message));
  } finally { await srv.close(); }
});

test('moonshot: balance and token estimate endpoints; pricing with cache writes', async () => {
  const srv = await mockServer((s) => s.url === '/v1/users/me/balance'
    ? { json: { code: 0, data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 }, scode: '0x0', status: true } }
    : { json: { code: 0, data: { total_tokens: 80 }, scode: '0x0', status: true } });
  try {
    assert.deepEqual(await moonshotBalance('k', `${srv.url}/v1`), { available: 49.58894, voucher: 46.58893, cash: 3.00001 });
    assert.equal(srv.seen[0]!.headers.authorization, 'Bearer k');
    assert.equal(await moonshotEstimateTokens('k', 'kimi-k3', [{ role: 'user', content: 'hi' }], `${srv.url}/v1`), 80);
    assert.equal(srv.seen[1]!.url, '/v1/tokenizers/estimate-token-count');
    assert.deepEqual(srv.seen[1]!.body, { model: 'kimi-k3', messages: [{ role: 'user', content: 'hi' }] });
  } finally { await srv.close(); }
  // K3: $3 input, $3 per 5-minute cache write, $0.30 cached, $15 output.
  const u = { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000, reasoning: 0 };
  assert.equal(Number(costOf(getModel('kimi-k3'), u).toFixed(4)), 21.3);
  assert.equal(Number(costOf(getModel('kimi-k2.7-code'), u).toFixed(4)), 6.09);
  assert.equal(Number(costOf(getModel('kimi-k2.6'), u).toFixed(4)), 6.06);
  assert.deepEqual(BUILTIN_PROVIDERS.moonshot!.keyEnv, ['MOONSHOT_API_KEY']);
  for (const id of ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6']) {
    const m = getModel(id);
    assert.equal(m.provider, 'moonshot');
    assert.ok(m.efforts.includes(m.effort) && m.compactAt < m.contextWindow && m.vision);
  }
});

test('moonshot: a harness session on kimi-k3 - the loop runs the tool call and the reasoning goes back with it', async () => {
  const ws = await tempDir();
  await fs.writeFile(path.join(ws, 'secret-word.txt'), 'kiwi\n');
  const srv = await mockServer((s, n) => {
    if (n === 1) return { sse: [
      delta({ reasoning_content: 'I should read the file.' }),
      delta({ tool_calls: [{ index: 0, id: 'read:0', type: 'function', function: { name: 'read', arguments: '{"path":"secret-word.txt"}' } }] }),
      delta({}, 'tool_calls'),
      { choices: [], usage: { prompt_tokens: 4000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 3584 } } },
    ] };
    const msgs = s.body.messages as { role: string; content: string; reasoning_content?: string }[];
    const tool = msgs.find((m) => m.role === 'tool');
    const replayed = msgs.find((m) => m.role === 'assistant')?.reasoning_content === 'I should read the file.';
    return { sse: [delta({ content: `The word is ${/kiwi/.test(tool?.content ?? '') && replayed ? 'kiwi' : 'unknown'}.` }, 'stop'), { choices: [], usage: { prompt_tokens: 4100, completion_tokens: 6, prompt_tokens_details: { cached_tokens: 3584, cache_write_tokens: 0 } } }] };
  });
  const saved = { key: process.env.MOONSHOT_API_KEY, base: process.env.MOONSHOT_BASE_URL };
  process.env.MOONSHOT_API_KEY = 'sk-test';
  process.env.MOONSHOT_BASE_URL = `${srv.url}/v1`;
  const h = await createHarness({ dataDir: await tempDir(), search: null, memory: 'off', scheduler: false });
  try {
    assert.equal(h.registry.listModels().find((m) => m.id === 'kimi-k3')?.available, true);
    const s = await h.sessions.create({ model: 'kimi-k3', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws } });
    const done = new Promise<void>((r) => s.subscribe(s.lastSeq, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
    await s.send('What is the secret word in secret-word.txt?');
    await done;
    assert.match(JSON.stringify(s.history.at(-1)!.content), /The word is kiwi/);
    assert.equal(srv.seen.length, 2);
    assert.equal(srv.seen[0]!.body.prompt_cache_key, srv.seen[1]!.body.prompt_cache_key, 'one cache key for the session');
    assert.equal(s.meta.usage.cacheRead, 3584);
    assert.ok(s.meta.cost > 0);
  } finally {
    await h.close();
    await srv.close();
    for (const [k, v] of [['MOONSHOT_API_KEY', saved.key], ['MOONSHOT_BASE_URL', saved.base]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('moonshot K3.1 Pro: tools loaded mid-session go in as a system message where they loaded (the prefix stays cached); the 1-hour tier follows the session', () => {
  const WIDGET = { name: 'widget_count', description: 'Counts widgets', input_schema: { type: 'object' as const, properties: {} } };
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'count the widgets' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'load_tools', input: { groups: ['widgets'] } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Loaded; callable from your next step:\nwidgets: widget_count' }] },
  ];
  const b = moonshotBody(request('kimi-k3.1-pro', { tools: [READ_TOOL, WIDGET], messages }));
  assert.deepEqual((b.tools as Array<{ function: { name: string } }>).map((t) => t.function.name), ['read'], 'the top list is the one the session started with');
  const sys = (b.messages as Array<{ role: string; tools?: Array<{ function: { name: string } }>; content?: unknown }>);
  const at = sys.findIndex((m) => m.role === 'system' && m.tools);
  assert.equal(at, sys.length - 1, 'right after the load result');
  assert.deepEqual(sys[at]!.tools!.map((t) => t.function.name), ['widget_count']);
  assert.ok(!('content' in sys[at]!));
  // Before any load: as before.
  assert.ok(!(moonshotBody(request('kimi-k3.1-pro', { tools: [READ_TOOL, WIDGET] })).messages as Array<{ tools?: unknown }>).some((m) => m.tools));
  // The cache tier: the session's 1h once it has shown long gaps, unless the operator fixed it.
  assert.deepEqual(moonshotBody(request('kimi-k3.1-pro', { prefixTtl: '1h' }), {}).prompt_cache_options, { mode: 'implicit', ttl: '1h' });
  assert.ok(!('prompt_cache_options' in moonshotBody(request('kimi-k3.1-pro', { prefixTtl: '1h' }), { HARNESS_MOONSHOT_CACHE_TTL: '5m' })));
  assert.ok(!('prompt_cache_options' in moonshotBody(request('kimi-k3.1-pro'), {})));
  // 1-hour writes at their own rate: $4 against $2 per million on K3.1 Pro.
  const m = getModel('kimi-k3.1-pro');
  assert.equal(costOf(m, { input: 0, cacheRead: 0, cacheWrite: 1_000_000, cacheWrite1h: 1_000_000, output: 0, reasoning: 0 }), 4);
  assert.equal(costOf(m, { input: 0, cacheRead: 0, cacheWrite: 1_000_000, output: 0, reasoning: 0 }), 2);
  assert.equal(m.maxOutput, 131_072);
});
