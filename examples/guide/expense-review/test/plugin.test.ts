// The expense review plugin on the test kit: it loads into a real harness with a throwaway data folder, and its tools,
// routes and a whole conversation are called for real. A scripted model stands in: no key, no cost.
// Run: harness plugin test <this folder>
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadPlugin } from '@harness/plugin-sdk/testing';
import { policyProblem } from '../index.ts';

const dir = new URL('..', import.meta.url);
const idOf = (s: string) => /\b(E-\w+)\b/.exec(s)![1]!;

test('the policy is plain code, so it can be tested on its own', () => {
  assert.equal(policyProblem({ category: 'meals', amount: 40, note: 'team lunch' }), undefined);
  assert.match(policyProblem({ category: 'meals', amount: 80, note: 'dinner' })!, /over the meals limit of 75/);
  assert.match(policyProblem({ category: 'other', amount: 30, note: ' ' })!, /needs a note/);
  assert.match(policyProblem({ category: 'yachts', amount: 1, note: '' })!, /unknown category/);
});

test('it loads: tools, routes, skill, agent, workflow', async () => {
  const kit = await loadPlugin(dir);
  try {
    assert.equal(kit.error, undefined);
    assert.deepEqual(kit.adds.tools.sort(), ['expense_add', 'expense_decide', 'expense_list', 'expense_policy_check']);
    assert.deepEqual(kit.adds.routes.sort(), ['GET expenses', 'POST expenses']);
    assert.deepEqual(kit.adds.skills, ['expense-review']);
    assert.deepEqual(kit.adds.agents, ['expense-auditor']);
    assert.deepEqual(kit.adds.workflows, ['expense-review']);
  } finally { await kit.close(); }
});

test('tools: add, check, decide; mistakes say what to do', async () => {
  const kit = await loadPlugin(dir);
  try {
    const ok = idOf((await kit.tool('expense_add', { who: 'Ana', category: 'meals', amount: 40, note: 'team lunch' })).content);
    const over = idOf((await kit.tool('expense_add', { who: 'Tom', category: 'meals', amount: 200, note: 'dinner' })).content);
    const check = (await kit.tool('expense_policy_check')).content;
    assert.match(check, new RegExp(`${ok}: within policy`));
    assert.match(check, new RegExp(`${over}: BREAKS POLICY: 200 is over the meals limit of 75`));
    assert.match((await kit.tool('expense_decide', { id: over, decision: 'rejected', reason: 'over the limit' })).content, /\[rejected\]/);
    assert.doesNotMatch((await kit.tool('expense_list')).content, new RegExp(over));
    assert.match((await kit.tool('expense_list', { status: 'rejected' })).content, new RegExp(over));
    assert.equal((await kit.tool('expense_add', { who: 'Ana', category: 'meals', amount: 0 })).isError, true);
    const wrong = await kit.tool('expense_decide', { id: 'E-nope', decision: 'approved', reason: 'x' });
    assert.deepEqual([wrong.isError, /expense_list shows the ids/.test(wrong.content)], [true, true]);
    assert.ok(kit.signals.includes('expenses'), 'open pages are told to refresh');
  } finally { await kit.close(); }
});

test('routes: the page reads and adds claims, signed in only', async () => {
  const kit = await loadPlugin(dir);
  try {
    assert.equal((await kit.route('POST', 'expenses', { body: { who: 'Ana', category: 'travel', amount: 2000, note: 'flight' } })).status, 201);
    const got = await kit.route('GET', 'expenses');
    assert.match(got.body.expenses[0].problem, /over the travel limit/);
    assert.equal((await kit.route('POST', 'expenses', { body: {} })).status, 400);
    assert.equal((await kit.route('GET', 'expenses', { as: 'anonymous' })).status, 401);
  } finally { await kit.close(); }
});

test('a conversation: the agent uses the check, not its own arithmetic', async () => {
  const kit = await loadPlugin(dir);
  try {
    await kit.tool('expense_add', { who: 'Tom', category: 'meals', amount: 200, note: 'dinner' });
    const r = await kit.chat('Is the pending claim within policy?', { script: [{ calls: [{ name: 'expense_policy_check' }] }, { text: 'It is over the limit.' }] });
    assert.deepEqual(r.calls.map((c) => c.name), ['expense_policy_check']);
    assert.match(r.calls[0]!.result, /BREAKS POLICY/);
    assert.match(r.text, /over the limit/);
  } finally { await kit.close(); }
});
