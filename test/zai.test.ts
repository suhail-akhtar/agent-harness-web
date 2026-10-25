import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { costOf, getModel } from '../src/core/models.ts';
import type { Message } from '../src/core/types.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { BUILTIN_PROVIDERS } from '../src/providers/index.ts';
import type { ProviderRequest } from '../src/providers/types.ts';
import { ProviderError } from '../src/providers/types.ts';
import { glmEffort, zaiBody, ZaiProvider } from '../src/providers/zai.ts';
import { delta, mockServer } from './chat-mock.ts';
import { tempDir } from './helpers.ts';

// The GLM provider against a local stand-in speaking Z.ai's documented Chat
// Completions wire format (https://docs.z.ai/api-reference/llm/chat-completion):
// forced thinking with reasoning_effort and clear_thinking, tool_stream deltas,
// usage on the last chunk, Z.ai's own finish reasons and business error codes.

const READ_TOOL = { name: 'read', description: 'Read a file', input_schema: { type: 'object' as const, properties: { path: { type: 'string' } }, required: ['path'] } };

function request(over: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: getModel('glm-5.3-flash'),
    system: 'SYS',
    tools: [READ_TOOL],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    effort: 'high',
    cacheKey: 'sess-1',
    signal: new AbortController().signal,
    ...over,
  };
}

test('zai: glm-5.3-flash request - forced thinking with preserved reasoning, effort, tool_stream, only documented fields', async () => {
  const srv = await mockServer(() => ({ sse: [
    delta({ role: 'assistant', reasoning_content: 'Simple.' }),
    delta({ content: 'Hel' }),
    { id: '1', choices: [{ index: 0, finish_reason: 'stop', delta: { role: 'assistant', content: 'lo' } }], usage: { prompt_tokens: 300, completion_tokens: 12, total_tokens: 312, prompt_tokens_details: { cached_tokens: 256 } } },
  ] }));
  try {
    const p = new ZaiProvider('zk', `${srv.url}/api/paas/v4/`);
    let text = '';
    const r = await p.send(request({ effort: 'xhigh', onText: (d) => { text += d; } }));
    const s = srv.seen[0]!;
    assert.equal(s.url, '/api/paas/v4/chat/completions');
    assert.equal(s.headers.authorization, 'Bearer zk');
    assert.equal(s.headers['accept-language'], 'en-US,en');
    const b = s.body;
    assert.equal(b.model, 'glm-5.3-flash');
    assert.deepEqual(b.messages, [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }]);
    assert.deepEqual(b.tools, [{ type: 'function', function: { name: 'read', description: 'Read a file', parameters: READ_TOOL.input_schema } }]);
    assert.equal(b.tool_choice, 'auto');
    assert.equal(b.tool_stream, true);
    assert.equal(b.stream, true);
    assert.equal(b.max_tokens, 131_072);
    assert.deepEqual(b.thinking, { type: 'enabled', clear_thinking: false });
    assert.equal(b.reasoning_effort, 'max');
    for (const k of ['stream_options', 'temperature', 'top_p', 'do_sample', 'prompt_cache_key', 'max_completion_tokens']) assert.ok(!(k in b), `${k} must not be sent`);
    assert.equal(text, 'Hello');
    assert.equal(r.stop, 'end');
    assert.deepEqual(r.usage, { input: 44, cacheRead: 256, cacheWrite: 0, output: 12, reasoning: 0 });
    assert.deepEqual(r.message.raw, { provider: 'zai', model: 'glm-5.3-flash', payload: { role: 'assistant', content: 'Hello', reasoning_content: 'Simple.' } });
  } finally { await srv.close(); }
  assert.deepEqual(['low', 'medium', 'high', 'xhigh', 'max'].map((e) => glmEffort(e as never)), ['low', 'high', 'high', 'max', 'max']);
  const bare = zaiBody(request({ tools: [] }));
  assert.ok(!('tools' in bare) && !('tool_choice' in bare) && !('tool_stream' in bare));
});

test('zai: streamed tool calls, reasoning replayed with the calls, tool results as text with their images after them', async () => {
  const srv = await mockServer((_s, n) => n === 1 ? { sse: [
    delta({ role: 'assistant', reasoning_content: 'Read both.' }),
    delta({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read', arguments: '{"pa' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] }),
    delta({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'read', arguments: '{"path":"b.png"}' } }] }),
    { id: '1', choices: [{ index: 0, finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 900, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 0 } } },
  ] } : { sse: [{ id: '2', choices: [{ index: 0, finish_reason: 'stop', delta: { content: 'done' } }], usage: { prompt_tokens: 1000, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 896 } } }] });
  try {
    const p = new ZaiProvider('zk', `${srv.url}/api/paas/v4`);
    const first = await p.send(request());
    assert.equal(first.stop, 'tool_use');
    assert.deepEqual(first.message.content.filter((b) => b.type === 'tool_use'), [
      { type: 'tool_use', id: 'call_a', name: 'read', input: { path: 'a.txt' } },
      { type: 'tool_use', id: 'call_b', name: 'read', input: { path: 'b.png' } },
    ]);
    const payload = first.message.raw!.payload;
    assert.deepEqual(payload, {
      role: 'assistant', content: '', reasoning_content: 'Read both.',
      tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } },
        { id: 'call_b', type: 'function', function: { name: 'read', arguments: '{"path":"b.png"}' } },
      ],
    });
    const results: Message = { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'call_a', content: 'A' },
      { type: 'tool_result', tool_use_id: 'call_b', content: 'an image', images: [{ media_type: 'image/png', data: 'AAAA' }] },
    ] };
    const second = await p.send(request({ messages: [request().messages[0]!, first.message, results] }));
    assert.deepEqual(second.usage, { input: 104, cacheRead: 896, cacheWrite: 0, output: 3, reasoning: 0 });
    const msgs = srv.seen[1]!.body.messages as Record<string, unknown>[];
    assert.deepEqual(msgs[2], payload, 'interleaved thinking: the reasoning goes back unmodified with its tool calls');
    assert.deepEqual(msgs[3], { role: 'tool', tool_call_id: 'call_a', content: 'A' });
    assert.deepEqual(msgs[4], { role: 'tool', tool_call_id: 'call_b', content: 'an image' });
    assert.deepEqual(msgs[5], { role: 'user', content: [{ type: 'text', text: 'Image(s) from tool call call_b:' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] });
  } finally { await srv.close(); }
});

test('zai: finish reasons - sensitive is a refusal, a full context window stops, network_error is retried', async () => {
  let finish = 'sensitive';
  const srv = await mockServer(() => ({ sse: [delta({ content: 'part' }), { id: '1', choices: [{ index: 0, finish_reason: finish, delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 1 } }] }));
  try {
    const p = new ZaiProvider('zk', srv.url);
    let r = await p.send(request());
    assert.equal(r.stop, 'refusal'); assert.match(r.notice ?? '', /sensitive/);
    finish = 'model_context_window_exceeded';
    r = await p.send(request());
    assert.equal(r.stop, 'max_tokens'); assert.match(r.notice ?? '', /context window/);
    finish = 'length';
    assert.equal((await p.send(request())).stop, 'max_tokens');
    finish = 'network_error';
    await assert.rejects(p.send(request()), (e: unknown) => e instanceof ProviderError && e.retryable && /network_error/.test(e.message));
  } finally { await srv.close(); }
});

test('zai: business error codes - balance and plan limits are final, rate limits and overload are retried', async () => {
  const errors: Record<string, { status: number; code: string; message: string; headers?: Record<string, string> }> = {
    balance: { status: 429, code: '1113', message: 'Insufficient balance or no resource package. Please recharge.' },
    rate: { status: 429, code: '1302', message: 'Rate limit reached for requests', headers: { 'retry-after': '3' } },
    overload: { status: 429, code: '1305', message: 'The service may be temporarily overloaded, please try again later' },
    plan: { status: 429, code: '1310', message: 'Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-23 00:00:00' },
    long: { status: 400, code: '1261', message: 'Prompt too long' },
    param: { status: 400, code: '1214', message: 'Parameter `tool_choice` is invalid.' },
    auth: { status: 401, code: '1000', message: 'Authentication Failed' },
    sensitive: { status: 400, code: '1301', message: 'System detected potentially unsafe or sensitive content' },
    network: { status: 500, code: '1234', message: 'Network error, error id: x, please try again later' },
  };
  let which = 'balance';
  const srv = await mockServer(() => { const e = errors[which]!; return { status: e.status, json: { error: { code: e.code, message: e.message } }, headers: e.headers }; });
  const p = new ZaiProvider('zk', srv.url);
  const fail = async (w: string) => {
    which = w;
    try { await p.send(request()); } catch (err) { assert.ok(err instanceof ProviderError, String(err)); return err; }
    throw new Error(`${w}: no error`);
  };
  try {
    let e = await fail('balance');
    assert.equal(e.retryable, false); assert.equal(e.status, 429); assert.match(e.message, /insufficient balance.*1113/);
    e = await fail('rate');
    assert.equal(e.retryable, true); assert.equal(e.retryAfterMs, 3000);
    e = await fail('overload');
    assert.equal(e.retryable, true);
    e = await fail('plan');
    assert.equal(e.retryable, false); assert.match(e.message, /reset at 2026-10-23/);
    e = await fail('long');
    assert.equal(e.retryable, false); assert.match(e.message, /Compact/);
    e = await fail('param');
    assert.equal(e.retryable, false);
    e = await fail('auth');
    assert.equal(e.retryable, false); assert.match(e.message, /ZAI_API_KEY/); assert.match(e.message, /coding\/paas\/v4/);
    e = await fail('sensitive');
    assert.equal(e.retryable, false);
    e = await fail('network');
    assert.equal(e.retryable, true);
  } finally { await srv.close(); }
});

test('zai: an error inside the stream, more tools than Z.ai accepts, pricing and registration', async () => {
  const srv = await mockServer(() => ({ sse: [delta({ content: 'x' }), { error: { code: '1305', message: 'overloaded mid-stream' } }] }));
  try {
    await assert.rejects(new ZaiProvider('zk', srv.url).send(request()), (e: unknown) => e instanceof ProviderError && e.retryable && /overloaded mid-stream/.test(e.message));
  } finally { await srv.close(); }
  const many = Array.from({ length: 129 }, (_, i) => ({ ...READ_TOOL, name: `t${i}` }));
  await assert.rejects(new ZaiProvider('zk', 'http://127.0.0.1:9').send(request({ tools: many })), (e: unknown) => e instanceof ProviderError && !e.retryable && /at most 128 tools/.test(e.message));
  const u = { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, output: 1_000_000, reasoning: 0 };
  assert.equal(Number(costOf(getModel('glm-5.3-flash'), u).toFixed(4)), 0.68);
  assert.deepEqual(BUILTIN_PROVIDERS.zai!.keyEnv, ['ZAI_API_KEY']);
  const m = getModel('glm-5.3-flash');
  assert.equal(m.provider, 'zai');
  assert.equal(m.contextWindow, 1_000_000);
  assert.ok(m.vision && m.efforts.includes(m.effort));
});

test('zai: a harness session on glm-5.3-flash - the loop runs the tool call and answers from its result', async () => {
  const ws = await tempDir();
  await fs.writeFile(path.join(ws, 'secret-word.txt'), 'mango\n');
  const srv = await mockServer((s, n) => {
    if (n === 1) return { sse: [
      delta({ reasoning_content: 'Read it.' }),
      delta({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"secret-word.txt"}' } }] }),
      { id: '1', choices: [{ index: 0, finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 3000, completion_tokens: 15, prompt_tokens_details: { cached_tokens: 0 } } },
    ] };
    const msgs = s.body.messages as { role: string; content: string; reasoning_content?: string }[];
    const tool = msgs.find((m) => m.role === 'tool');
    const replayed = msgs.find((m) => m.role === 'assistant')?.reasoning_content === 'Read it.';
    return { sse: [{ id: '2', choices: [{ index: 0, finish_reason: 'stop', delta: { content: `The word is ${/mango/.test(tool?.content ?? '') && replayed ? 'mango' : 'unknown'}.` } }], usage: { prompt_tokens: 3100, completion_tokens: 6, prompt_tokens_details: { cached_tokens: 2944 } } }] };
  });
  const saved = { key: process.env.ZAI_API_KEY, base: process.env.ZAI_BASE_URL };
  process.env.ZAI_API_KEY = 'zk-test';
  process.env.ZAI_BASE_URL = `${srv.url}/api/paas/v4`;
  const h = await createHarness({ dataDir: await tempDir(), search: null, memory: 'off', scheduler: false });
  try {
    assert.equal(h.registry.listModels().find((m) => m.id === 'glm-5.3-flash')?.available, true);
    const s = await h.sessions.create({ model: 'glm-5.3-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws } });
    const done = new Promise<void>((r) => s.subscribe(s.lastSeq, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
    await s.send('What is the secret word in secret-word.txt?');
    await done;
    assert.match(JSON.stringify(s.history.at(-1)!.content), /The word is mango/);
    assert.equal(srv.seen.length, 2);
    assert.equal(s.meta.usage.cacheRead, 2944);
    assert.ok(s.meta.cost > 0);
  } finally {
    await h.close();
    await srv.close();
    for (const [k, v] of [['ZAI_API_KEY', saved.key], ['ZAI_BASE_URL', saved.base]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
