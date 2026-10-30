import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message } from '@harness/client';
import { conversationAsText } from '../apps/desktop/renderer/src/builtins/core.chat/conversation-text.ts';

test("an exported conversation has the person's words, not the context the harness added to them", () => {
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: '<environment>\nWorkspace: E:\\w\n</environment>\n\n<memory>\nnotes\n</memory>\n\n<skills>\n- a skill\n</skills>\n\nbuild a watch' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>Background agent finished.</system-reminder>' }] },
  ];
  const md = conversationAsText({ title: 'Watch', model: 'claude-sonnet-5-5' }, messages, 'md');
  assert.match(md, /## You\n\nbuild a watch\n/);
  assert.doesNotMatch(md, /environment|memory|skills|system-reminder/);
  // A message that carried only a reminder is not a turn of the person's.
  assert.equal(md.match(/## You/g)?.length, 1);
});
