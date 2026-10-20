import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply, fromHistory, visibleUserText, type Live } from '../ui/src/timeline.ts';

test('history renders user text without harness context blocks, and pairs tool results', () => {
  const items = fromHistory([
    { role: 'user', content: [{ type: 'text', text: '<environment>\nWorkspace: /w\n</environment>\n\nFix the bug' }] },
    { role: 'assistant', content: [{ type: 'reasoning', text: 'hmm' }, { type: 'tool_use', id: 'a', name: 'read', input: { path: 'x' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'body' }, { type: 'text', text: '<system-reminder>r</system-reminder>' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
  ]);
  assert.deepEqual(items.map((i) => i.kind), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal((items[0] as { text: string }).text, 'Fix the bug');
  assert.equal((items[2] as { result: string }).result, 'body');
  assert.equal(visibleUserText('<system-reminder>x</system-reminder>'), '');
});

test('live events stream text, then the final message replaces the streamed copy', () => {
  let l: Live = { items: [], contextTokens: 0, contextWindow: 0 };
  l = apply(l, { kind: 'text_delta', text: 'Hel' });
  l = apply(l, { kind: 'text_delta', text: 'lo' });
  assert.equal((l.items[0] as { text: string }).text, 'Hello');
  l = apply(l, { kind: 'assistant_message', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] } });
  assert.equal(l.items.length, 1);
  assert.equal((l.items[0] as { text: string; streaming: boolean }).streaming, false);
  l = apply(l, { kind: 'tool_call', id: 't', name: 'agent', input: { description: 'look' } });
  l = apply(l, { kind: 'tool_call', id: 's', name: 'grep', input: { pattern: 'x' }, agent: 'explore-1' });
  assert.equal((l.items[1] as { activity: unknown[] }).activity.length, 1, 'sub-agent activity nests in the agent card');
  l = apply(l, { kind: 'tool_result', id: 't', name: 'agent', content: 'report', is_error: false, ms: 5 });
  assert.equal((l.items[1] as { running: boolean }).running, false);
});

test('a workflow run is one card: node events update it and node agents report activity into it', () => {
  const run = (status: string, history: { node: string; status: string; outcome?: string }[]) => ({
    id: 'run_1', workflow: 'build-feature', status, cost: 0, nodes: [{ id: 'implement', type: 'agent' }, { id: 'gates', type: 'gate' }],
    history: history.map((h) => ({ ...h, type: 'agent', startedAt: 1 })),
  });
  let live: Live = { items: [], contextTokens: 0, contextWindow: 0 };
  live = apply(live, { kind: 'workflow', phase: 'started', run: run('running', []) });
  live = apply(live, { kind: 'workflow', phase: 'node_started', node: 'implement', run: run('running', [{ node: 'implement', status: 'running' }]) });
  live = apply(live, { kind: 'tool_call', id: 't', name: 'write', input: { path: 'src/app.js' }, agent: 'implement' });
  live = apply(live, { kind: 'tool_result', id: 't', name: 'write', content: 'ok', is_error: false, ms: 1, agent: 'implement' });
  live = apply(live, { kind: 'workflow', phase: 'node_finished', node: 'gates', run: run('running', [{ node: 'implement', status: 'done' }, { node: 'gates', status: 'done', outcome: 'pass' }]) });
  assert.equal(live.items.length, 1);
  const card = live.items[0] as Extract<typeof live.items[number], { kind: 'workflow' }>;
  assert.equal(card.kind, 'workflow');
  assert.deepEqual(card.activity.implement, [{ name: 'write', summary: 'src/app.js', done: true, isError: false }]);
  assert.equal(card.run.history[1]!.outcome, 'pass');
});
