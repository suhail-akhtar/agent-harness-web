// ask_user: suggested answers with what each does (the recommended one first), and what the agent hears for
// each thing the person can do - answer (with a note), reply in their own words instead, or skip.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askUserTool } from '../src/tools/meta.ts';
import type { AskOutcome, ToolContext } from '../src/tools/types.ts';
import type { QuestionChoice } from '../src/core/types.ts';

function ctx(outcome: string | AskOutcome) {
  const seen: { question?: string; options?: string[]; form?: unknown; choices?: QuestionChoice[] } = {};
  const c = { askUser: async (question: string, options: string[], form?: Record<string, unknown>, choices?: QuestionChoice[]) => { Object.assign(seen, { question, options, form, choices }); return outcome; } } as unknown as ToolContext;
  return { c, seen };
}

test('ask_user: options as labels or { label, description, recommended }: the recommended one first, at most one, no duplicates', async () => {
  const { c, seen } = ctx({ answered: 'Disable' });
  await askUserTool.run({ question: 'What should I do with the VPN clients?', options: ['Keep them', { label: 'Disable', description: 'Stop and disable their services (reversible)', recommended: true }, { label: 'Uninstall', recommended: true }, 'Keep them', 42] }, c);
  assert.deepEqual(seen.options, ['Disable', 'Keep them', 'Uninstall']);
  assert.deepEqual(seen.choices, [{ label: 'Disable', description: 'Stop and disable their services (reversible)', recommended: true }, { label: 'Keep them' }, { label: 'Uninstall' }]);
  // Plain labels only: no choices sent (the options are enough).
  const plain = ctx('Yes');
  await askUserTool.run({ question: 'Go on?', options: ['Yes', 'No'] }, plain.c);
  assert.equal(plain.seen.choices, undefined);
});

test('ask_user: what the agent hears - an answer with a note, a reply in words, a skip; an empty question is refused', async () => {
  assert.equal((await askUserTool.run({ question: 'Q?' }, ctx('A plain answer').c)).content, 'The user answered: A plain answer');
  assert.equal((await askUserTool.run({ question: 'Q?' }, ctx({ answered: '{"vpn":["iNode"]}', note: 'keep SSLVPN' }).c)).content, 'The user answered: {"vpn":["iNode"]}\nTheir note: keep SSLVPN');
  const replied = (await askUserTool.run({ question: 'Q?', form: { type: 'object', properties: { a: { type: 'string' } } } }, ctx({ replied: 'Do nothing for now, just list them' }).c)).content;
  assert.match(replied, /did not pick a suggested answer or fill in the form; they wrote: Do nothing for now, just list them/);
  const skipped = (await askUserTool.run({ question: 'Q?' }, ctx({ skipped: true, note: 'not now' }).c));
  assert.match(skipped.content, /skipped this question and said: not now\. Do not ask it again/);
  assert.equal(skipped.is_error, undefined);
  assert.equal((await askUserTool.run({ question: '   ' }, ctx('x').c)).is_error, true);
});
