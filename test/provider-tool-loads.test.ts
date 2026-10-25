// Deferred tools loaded mid-session, provider by provider: Claude models with mid-conversation tool changes
// declare every tool from the first request (the deferred ones with defer_loading) and add a loaded one by a
// system message where it loaded; Haiku 5.5 keeps the plain list. Checked live on Sonnet 5.5: after a load the
// whole earlier prefix was read from the cache and the added tool was called.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getModel } from '../src/core/models.ts';
import type { Message } from '../src/core/types.ts';
import { anthropicBody, MID_TOOL_CHANGES } from '../src/providers/anthropic.ts';
import type { ToolSpec } from '../src/providers/types.ts';

const spec = (name: string): ToolSpec => ({ name, description: name, input_schema: { type: 'object', properties: {} } });
const LOAD = spec('load_tools'); const READ = spec('read'); const WIDGET = spec('widget_count'); const OTHER = spec('widget_paint');
const loaded: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'count' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'load_tools', input: { groups: ['widgets'] } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Loaded; callable from your next step:\nwidgets: widget_count, widget_paint' }] },
];
const req = (model: string, tools: ToolSpec[], messages: Message[]) => ({ model: getModel(model), system: 'S', tools, messages, effort: 'low' as const, allTools: [READ, WIDGET, OTHER], deferrable: ['widget_count', 'widget_paint'] });
type Body = { tools: Array<{ name: string; defer_loading?: boolean }>; messages: Array<{ role: string; content: unknown }> };

test('Claude with mid-conversation tool changes: the same tool list before and after a load; the load is a system message where it happened', () => {
  for (const model of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1']) {
    assert.ok(MID_TOOL_CHANGES.has(model));
    const before = anthropicBody(req(model, [LOAD, READ], loaded.slice(0, 1)), false) as unknown as Body;
    const after = anthropicBody(req(model, [LOAD, READ, WIDGET, OTHER], loaded), false) as unknown as Body;
    assert.deepEqual(after.tools, before.tools, `${model}: the tool list does not change`);
    assert.deepEqual(before.tools.filter((t) => t.defer_loading).map((t) => t.name), ['widget_count', 'widget_paint']);
    const added = after.messages.at(-1)!;
    assert.equal(added.role, 'system');
    assert.deepEqual(added.content, [{ type: 'tool_addition', tool: { type: 'tool_reference', name: 'widget_count' } }, { type: 'tool_addition', tool: { type: 'tool_reference', name: 'widget_paint' } }]);
  }
});

test('Haiku 5.5 (no mid-conversation tool changes) keeps the plain list: what is callable now, nothing deferred', () => {
  const b = anthropicBody(req('claude-haiku-5-5', [LOAD, READ, WIDGET], loaded), false) as unknown as Body;
  assert.deepEqual(b.tools.map((t) => t.name), ['load_tools', 'read', 'widget_count']);
  assert.ok(!b.tools.some((t) => t.defer_loading));
  assert.ok(!b.messages.some((m) => m.role === 'system'));
});
