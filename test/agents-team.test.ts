import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentToMarkdown, checkAgentDef, parseAgentFile, teamBrief } from '../src/agents/agents.ts';
import type { HarnessEvent } from '../src/core/types.ts';
import { gate, OPERATOR, setupServer, waitFor } from './multi-helpers.ts';

// Teams (docs/agents-mcp/PLAN.md, phase 5): an agent that leads named members. It delegates only to them, in
// parallel where the work splits, has its reviewer check the result, and its spend limit covers the whole team.

test('a team definition: members (not itself), a reviewer among them; in and out of an agent file; the lead\'s procedure', () => {
  const lead = checkAgentDef({ name: 'squad', description: 'Builds small features with a team.', prompt: 'Lead.', team: { members: ['writer', 'tester', 'reviewer'], reviewer: 'reviewer' } });
  assert.deepEqual(lead.team, { members: ['writer', 'tester', 'reviewer'], reviewer: 'reviewer' });
  assert.throws(() => checkAgentDef({ name: 'squad', description: 'Builds small features.', team: { members: ['squad'] } }), /does not include its lead/);
  assert.throws(() => checkAgentDef({ name: 'squad', description: 'Builds small features.', team: { members: ['a'], reviewer: 'b' } }), /reviewer is one of its members/);
  assert.throws(() => checkAgentDef({ name: 'squad', description: 'Builds small features.', team: { members: [] } }), /1 to 12/);
  const md = agentToMarkdown(lead);
  assert.match(md, /^team: writer, tester, reviewer$/m);
  assert.deepEqual(parseAgentFile(md, 'squad', 'user')!.team, lead.team);
  const brief = teamBrief(lead, [{ name: 'writer', description: 'Writes code.', prompt: '' }, { name: 'reviewer', description: 'Reviews code.', prompt: '' }]);
  assert.match(brief, /<team lead="squad">[\s\S]*- writer: Writes code\.[\s\S]*- tester: \(not available here\)[\s\S]*- reviewer \(the reviewer\): Reviews code\.[\s\S]*run in parallel[\s\S]*5\. Before you report, give the combined result to reviewer/);
  assert.equal(teamBrief(checkAgentDef({ name: 'solo', description: 'Works alone on things.' }), []), '');
});

test('a conversation that runs as a team: only its members are offered, two start at once and run in parallel, the reviewer checks, the lead reports; another agent is refused', async () => {
  const t = await setupServer();
  try {
    const mk = (b: Record<string, unknown>) => t.call(OPERATOR, 'POST', '/api/me/agents', { model: 'deepseek-flash', tools: ['read', 'glob'], ...b });
    for (const [name, description] of [['writer-a', 'Writes the first half of a document.'], ['writer-b', 'Writes the second half of a document.'], ['checker', 'Reviews written work for mistakes.']]) assert.equal((await mk({ name, description, prompt: `You are ${name}.` })).status, 201);
    assert.equal((await mk({ name: 'squad', description: 'Writes documents with a team of writers and a checker.', prompt: 'Lead the team.', team: { members: ['writer-a', 'writer-b', 'checker'], reviewer: 'checker' } })).status, 201);

    const ga = gate(); const gb = gate();
    t.ds.scripts.lead = [
      { calls: [{ name: 'agent', input: { description: 'first half', type: 'writer-a', prompt: '[[wa]] Write the first half.' } }, { name: 'agent', input: { description: 'second half', type: 'writer-b', prompt: '[[wb]] Write the second half.' } }] },
      { calls: [{ name: 'agent', input: { description: 'review', type: 'checker', prompt: '[[ck]] Check both halves.' } }] },
      { calls: [{ name: 'agent', input: { description: 'not a member', type: 'general', prompt: '[[gen]] Do something else.' } }] },
      { text: 'The document is done: writer-a and writer-b wrote it, the checker found nothing.' },
    ];
    t.ds.scripts.wa = [{ text: 'First half written.', wait: ga.p }];
    t.ds.scripts.wb = [{ text: 'Second half written.', wait: gb.p }];
    t.ds.scripts.ck = [{ text: 'Both halves are fine.' }];

    const made = await t.call(OPERATOR, 'POST', '/api/sessions', { agent: 'squad', model: 'deepseek-flash', runtime: 'local', mode: 'bypass' });
    assert.equal(made.status, 201, made.text);
    const s = t.harness.sessions.get(made.body.id)!;
    const events: HarnessEvent[] = [];
    s.subscribe(0, ({ event }) => events.push(event));
    await s.send('[[lead]] Write the document.');
    // Both members started before either finished: they run at the same time.
    await waitFor(() => (t.ds.byKey.wa?.length ?? 0) === 1 && (t.ds.byKey.wb?.length ?? 0) === 1, 'both writers started');
    ga.open(); gb.open();
    await waitFor(() => events.some((e) => e.kind === 'turn_end' && !e.agent), 'the lead finished');

    // The lead's tools: the agent tool lists only its members; its instructions are the team's.
    const leadReq = t.ds.byKey.lead![0]!;
    const agentTool = leadReq.tools.find((x) => x.name === 'agent')!;
    assert.match(agentTool.description, /writer-a[\s\S]*writer-b[\s\S]*checker/);
    assert.ok(!/\bgeneral\b|\bexplore\b/.test(agentTool.description), 'only its members');
    assert.match(leadReq.system, /<team lead="squad">[\s\S]*- checker \(the reviewer\)/);
    // The reviewer ran after the writers; the non-member was refused.
    assert.equal(t.ds.byKey.ck?.length, 1);
    assert.equal(t.ds.byKey.gen, undefined, 'no other agent ran');
    const results = s.history.flatMap((m) => m.content).filter((b) => b.type === 'tool_result').map((b) => String((b as { content: unknown }).content));
    assert.ok(results.some((r) => /First half written/.test(r)) && results.some((r) => /Second half written/.test(r)) && results.some((r) => /Both halves are fine/.test(r)));
    assert.ok(results.some((r) => /must be one of "writer-a", "writer-b", "checker"/.test(r)), results.join('\n---\n').slice(0, 2000));
    const last = s.history.at(-1)!.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
    assert.match(last, /The document is done/);
  } finally { await t.close(); }
});

test('a team\'s spend limit covers its members: the run stops when the whole team reaches it', async () => {
  const t = await setupServer();
  try {
    const mk = (b: Record<string, unknown>) => t.call(OPERATOR, 'POST', '/api/me/agents', { model: 'deepseek-flash', tools: ['read'], ...b });
    assert.equal((await mk({ name: 'helper', description: 'Helps with any small task.', prompt: 'Help.' })).status, 201);
    assert.equal((await mk({ name: 'thrifty', description: 'A team that must stay cheap.', prompt: 'Lead.', maxCostUsd: 0.0001, team: { members: ['helper'] } })).status, 201);
    t.ds.scripts.cheap = [
      { calls: [{ name: 'agent', input: { description: 'help', type: 'helper', prompt: '[[hp]] Help.' } }] },
      { calls: [{ name: 'agent', input: { description: 'help again', type: 'helper', prompt: '[[hp2]] Help again.' } }] },
      { text: 'Should not get here.' },
    ];
    const made = await t.call(OPERATOR, 'POST', '/api/sessions', { agent: 'thrifty', model: 'deepseek-flash', runtime: 'local', mode: 'bypass' });
    const s = t.harness.sessions.get(made.body.id)!;
    const events: HarnessEvent[] = [];
    s.subscribe(0, ({ event }) => events.push(event));
    await s.send('[[cheap]] Do it.');
    await waitFor(() => events.some((e) => e.kind === 'turn_end' && !e.agent), 'the run stopped');
    assert.ok(events.some((e) => (e.kind === 'notice' || e.kind === 'turn_end') && /the thrifty team reached its spend limit/.test(JSON.stringify(e))), JSON.stringify(events.filter((e) => e.kind === 'notice' || e.kind === 'turn_end')).slice(0, 1500));
    assert.equal(t.ds.byKey.hp2, undefined, 'no member started after the limit');
  } finally { await t.close(); }
});
