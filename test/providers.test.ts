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
