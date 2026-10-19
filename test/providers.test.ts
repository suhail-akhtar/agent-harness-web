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
