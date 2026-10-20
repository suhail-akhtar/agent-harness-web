import assert from 'node:assert/strict';
import { test } from 'node:test';
import { costOf, deepseekPeak, getModel } from '../src/core/models.ts';
import type { Message } from '../src/core/types.ts';
import { anthropicBody } from '../src/providers/anthropic.ts';
import { toChat } from '../src/providers/deepseek.ts';
import { toInputItems } from '../src/providers/openai.ts';

const toolUse: Message = { role: 'assistant', content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 't1', name: 'read', input: { path: 'a' } }] };
const toolResult: Message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'data' }, { type: 'text', text: '<system-reminder>note</system-reminder>' }] };

test('anthropic: breakpoint on the frozen system prompt plus automatic tail caching', () => {
  const body = anthropicBody({ model: getModel('claude-haiku-5-5'), system: 'SYS', tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], effort: 'medium' }, true) as Record<string, unknown>;
  assert.deepEqual(body.system, [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(body.cache_control, { type: 'ephemeral' });
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepEqual(body.output_config, { effort: 'medium' });
  const cm = body.context_management as { edits: { type: string; clear_at_least: unknown }[] };
  assert.equal(cm.edits[0]!.type, 'clear_tool_uses_20250919');
  assert.ok(!('temperature' in body), 'Haiku 5.5 rejects non-default sampling parameters');
});

test('anthropic: assistant turns are replayed verbatim (thinking signatures intact)', () => {
  const raw = [{ type: 'thinking', thinking: '', signature: 'sig==' }, { type: 'text', text: 'x', citations: null }];
  const m: Message = { role: 'assistant', content: [{ type: 'text', text: 'x' }], raw: { provider: 'anthropic', model: 'claude-haiku-5-5', payload: raw } };
  const body = anthropicBody({ model: getModel('claude-haiku-5-5'), system: 'S', tools: [], messages: [m], effort: 'low' }, false) as { messages: { content: unknown }[] };
  assert.equal(body.messages[0]!.content, raw);
});

test('openai: function calls and outputs map to Responses items; raw output replays as is', () => {
  assert.deepEqual(toInputItems(toolUse), [
    { role: 'assistant', content: [{ type: 'output_text', text: 'checking' }] },
    { type: 'function_call', call_id: 't1', name: 'read', arguments: '{"path":"a"}' },
  ]);
  assert.deepEqual(toInputItems(toolResult), [
    { type: 'function_call_output', call_id: 't1', output: 'data' },
    { role: 'user', content: [{ type: 'input_text', text: '<system-reminder>note</system-reminder>' }] },
  ]);
  const payload = [{ type: 'reasoning', encrypted_content: 'enc' }];
  assert.equal(toInputItems({ role: 'assistant', content: [], raw: { provider: 'openai', model: 'gpt-6-luna', payload } }), payload);
});

test('deepseek: tool messages follow the assistant call; reasoning_content is replayed', () => {
  assert.deepEqual(toChat(toolResult), [
    { role: 'tool', tool_call_id: 't1', content: 'data' },
    { role: 'user', content: '<system-reminder>note</system-reminder>' },
  ]);
  const payload = { role: 'assistant', content: null, reasoning_content: 'thought', tool_calls: [] };
  assert.deepEqual(toChat({ role: 'assistant', content: [], raw: { provider: 'deepseek', model: 'deepseek-flash', payload } }), [payload]);
  // A turn produced by another provider still carries reasoning_content (required with tools).
  assert.equal((toChat(toolUse)[0] as { reasoning_content: string }).reasoning_content, '');
});

test('pricing: Haiku rate card by prompt size, DeepSeek peak hours', () => {
  const haiku = getModel('claude-haiku-5-5');
  assert.equal(costOf(haiku, { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }).toFixed(2), '0.50');
  assert.equal(costOf(haiku, { input: 50_000, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }).toFixed(4), '0.0050');
  assert.ok(deepseekPeak(new Date('2026-10-19T07:00:00Z')));
  assert.ok(!deepseekPeak(new Date('2026-10-18T07:00:00Z')), 'Sunday is off-peak');
  assert.ok(!deepseekPeak(new Date('2026-10-19T12:00:00Z')));
  const ds = getModel('deepseek-flash');
  const u = { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, output: 1_000_000, reasoning: 0 };
  assert.equal(costOf(ds, u, new Date('2026-10-19T12:00:00Z')).toFixed(3), '0.753');
});

test('images: each provider gets them in its own shape', async () => {
  const { anthropicBody } = await import('../src/providers/anthropic.ts');
  const img = { media_type: 'image/png', data: 'AAAA' };
  const m: Message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Image attached below.', images: [img] }, { type: 'text', text: 'note' }] };
  // Claude: inside the tool result, so server-side clearing removes it with the result.
  const a = anthropicBody({ model: getModel('claude-haiku-5-5'), system: 'S', tools: [], messages: [m], effort: 'low' }, false) as { messages: { content: { content: unknown }[] }[] };
  assert.deepEqual(a.messages[0]!.content[0]!.content, [{ type: 'text', text: 'Image attached below.' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }]);
  // OpenAI and DeepSeek: text-only results, the image follows as user content.
  const o = toInputItems(m) as { type?: string; output?: unknown; content?: unknown[] }[];
  assert.equal(o[0]!.output, 'Image attached below.');
  assert.deepEqual(o[1]!.content, [{ type: 'input_text', text: 'Image(s) from tool call t1:' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }, { type: 'input_text', text: 'note' }]);
  const d = toChat(m) as { role: string; content: unknown }[];
  assert.equal(d[0]!.role, 'tool');
  assert.deepEqual((d[1]!.content as unknown[])[1], { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
  // Sessions saved before images moved onto results still convert.
  const legacy: Message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }, { type: 'text', text: 'Image(s) from read:' }, { type: 'image', ...img }] };
  assert.deepEqual((toInputItems(legacy) as { content?: unknown[] }[])[1]!.content![1], { type: 'input_image', image_url: 'data:image/png;base64,AAAA' });
});

test('a stream that breaks mid-way is a retryable network error, not the end of the step', async () => {
  const { readSse } = await import('../src/providers/http.ts');
  const { ProviderError } = await import('../src/providers/types.ts');
  let n = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) { if (n++ === 0) c.enqueue(new TextEncoder().encode('data: {"a":1}\n\n')); else c.error(new TypeError('terminated')); },
  });
  const seen: string[] = [];
  await assert.rejects(async () => { for await (const e of readSse(new Response(body), new AbortController().signal)) seen.push(e.data); },
    (e: unknown) => e instanceof ProviderError && e.retryable && /mid-stream: terminated/.test(e.message));
  assert.deepEqual(seen, ['{"a":1}']);
});

test('Claude server-side compaction: requested at the compaction point, costed over every step, context from the last', async () => {
  const { fromAnthropic } = await import('../src/providers/anthropic.ts');
  const model = getModel('claude-haiku-5-5');
  const body = anthropicBody({ model, system: 'S', tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], effort: 'low' }, true, true) as { context_management: { edits: { type: string; trigger?: { value: number }; instructions?: string }[] } };
  const compact = body.context_management.edits.find((e) => e.type === 'compact_20260112')!;
  assert.equal(compact.trigger!.value, model.compactAt);
  assert.match(compact.instructions!, /continuation summary/);
  assert.equal((anthropicBody({ model, system: 'S', tools: [], messages: [], effort: 'low' }, true, false) as typeof body).context_management.edits.length, 1, 'off: clearing only');
  // HARNESS_COMPACT_AT moves the server's point too, not only the backstop.
  const lower = anthropicBody({ model, system: 'S', tools: [], messages: [], effort: 'low', compactAt: 60_000 }, true, true) as typeof body;
  assert.equal(lower.context_management.edits.find((e) => e.type === 'compact_20260112')!.trigger!.value, 60_000);
  assert.equal(lower.context_management.edits.find((e) => e.type !== 'compact_20260112')!.trigger!.value, 36_000);
  const { AnthropicProvider } = await import('../src/providers/anthropic.ts');
  const p = new AnthropicProvider('sk-test');
  assert.equal(p.compactsServerSide(model, 10_000), false, 'below the API minimum: the harness compacts itself');

  // A response that compacted: compaction step, then the reply.
  const r = fromAnthropic(model.id, {
    content: [{ type: 'compaction', content: 'summary...' }, { type: 'text', text: 'OK' }], stop_reason: 'end_turn',
    usage: { input_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 623, output_tokens: 246,
      iterations: [
        { type: 'compaction', input_tokens: 48, output_tokens: 634, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 15_439 },
        { type: 'message', input_tokens: 2, output_tokens: 246, cache_read_input_tokens: 0, cache_creation_input_tokens: 623 },
      ] },
  } as never);
  assert.deepEqual(r.usage, { input: 50, cacheRead: 100_000, cacheWrite: 16_062, output: 880, reasoning: 0 });
  assert.equal(r.contextTokens, 625);
  assert.deepEqual(r.compacted, { summaryTokens: 634, before: 115_487 });
  assert.deepEqual((r.message.raw as { payload: { type: string }[] }).payload.map((b) => b.type), ['compaction', 'text'], 'replayed verbatim, compaction block included');
  // An ordinary response has neither.
  const plain = fromAnthropic(model.id, { content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 1 } } as never);
  assert.equal(plain.contextTokens, undefined);
  assert.equal(plain.compacted, undefined);
});

test('a provider that compacts itself: the loop backs it up later instead of compacting first, and reports the server\'s compaction', async () => {
  const { makeAgent } = await import('./helpers.ts');
  const h = await makeAgent([{ text: 'one' }, { text: 'two' }]);
  const at = h.agent.compactThreshold();
  (h.provider as unknown as { compactsServerSide: () => boolean }).compactsServerSide = () => true;
  assert.ok(h.agent.compactThreshold() > at, 'client compaction is only the backstop');
  const orig = h.provider.send.bind(h.provider);
  h.provider.send = async (req) => ({ ...(await orig(req)), contextTokens: 900, compacted: { summaryTokens: 600, before: 120_000 } });
  h.agent.append({ role: 'user', content: [{ type: 'text', text: 'go' }] });
  await h.agent.run(new AbortController().signal);
  assert.equal(h.agent.lastPromptTokens, 900);
  assert.ok(h.events.some((e) => e.kind === 'compaction' && e.before === 120_000 && e.after === 900));
});
