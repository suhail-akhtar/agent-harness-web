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

test('a team the orchestrator delegates to still leads (one level deeper than other agents): its members run at once and report to it, and it reports up', async () => {
  const t = await setupServer();
  try {
    const mk = (b: Record<string, unknown>) => t.call(OPERATOR, 'POST', '/api/me/agents', { model: 'deepseek-flash', tools: ['read'], ...b });
    for (const name of ['part-one', 'part-two']) assert.equal((await mk({ name, description: `Does ${name} of a job and reports it.`, prompt: 'Do your part.' })).status, 201);
    assert.equal((await mk({ name: 'crew', description: 'Does a two-part job with its team and reports the result.', prompt: 'Lead.', team: { members: ['part-one', 'part-two'] } })).status, 201);
    const g1 = gate(); const g2 = gate();
    t.ds.scripts.orch = [{ calls: [{ name: 'agent', input: { description: 'the job', type: 'crew', prompt: '[[crewlead]] Do the two-part job.' } }] }, { text: 'The crew reported: both parts done.' }];
    t.ds.scripts.crewlead = [
      { calls: [{ name: 'agent', input: { description: 'one', type: 'part-one', prompt: '[[p1]] Part one.' } }, { name: 'agent', input: { description: 'two', type: 'part-two', prompt: '[[p2]] Part two.' } }] },
      { text: 'Both parts are done.' },
    ];
    t.ds.scripts.p1 = [{ text: 'Part one done.', wait: g1.p }];
    t.ds.scripts.p2 = [{ text: 'Part two done.', wait: g2.p }];
    const made = await t.call(OPERATOR, 'POST', '/api/sessions', { model: 'deepseek-flash', runtime: 'local', mode: 'bypass' });
    const s = t.harness.sessions.get(made.body.id)!;
    const events: HarnessEvent[] = [];
    s.subscribe(0, ({ event }) => events.push(event));
    await s.send('[[orch]] Get the two-part job done.');
    await waitFor(() => (t.ds.byKey.p1?.length ?? 0) === 1 && (t.ds.byKey.p2?.length ?? 0) === 1, 'both members started under the delegated lead');
    g1.open(); g2.open();
    await waitFor(() => events.some((e) => e.kind === 'turn_end' && !e.agent), 'the conversation finished');
    // The lead (a sub-agent) had the agent tool, offering its members only.
    const leadTools = t.ds.byKey.crewlead![0]!.tools.find((x) => x.name === 'agent')!;
    assert.match(leadTools.description, /part-one[\s\S]*part-two/);
    assert.ok(!/\bgeneral\b/.test(leadTools.description));
    // Its report reached the orchestrator.
    const res = s.history.flatMap((m) => m.content).filter((b) => b.type === 'tool_result').map((b) => String((b as { content: unknown }).content));
    assert.ok(res.some((r) => /Both parts are done/.test(r)), res.join('\n---\n'));
    assert.match(s.history.at(-1)!.content.map((b) => (b as { text?: string }).text ?? '').join(''), /The crew reported/);
  } finally { await t.close(); }
});

test('Generate can draft a team: members only from the agents listed (others dropped and said), the reviewer one of them; one member is no team', async () => {
  const { generateAgent } = await import('../src/agents/generate.ts');
  const model = { id: 'fake', provider: 'fake', label: 'Fake', efforts: ['medium'], effort: 'medium', rate: () => ({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 }) };
  const answer = (draft: unknown) => ({ send: async () => ({ message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(draft) }] }, stop: 'end', usage: { input: 900, cacheRead: 0, cacheWrite: 0, output: 200, reasoning: 0 } }) });
  const base = { name: 'release-lead', description: 'Gets a release ready with a team.', prompt: 'Split the release work.', tools: ['read'] };
  const agents = [{ name: 'test-writer', description: 'Writes tests.' }, { name: 'security-reviewer', description: 'Reviews security.' }];
  const common = { description: 'An agent that gets releases ready: tests and a security pass.', model: model as never, tools: [{ name: 'read', description: 'Read a file.' }], mcpServers: [], skills: [], agents, taken: [] };
  const r = await generateAgent({ ...common, provider: answer({ ...base, team: { members: ['test-writer', 'security-reviewer', 'made-up'], reviewer: 'security-reviewer' } }) as never });
  assert.deepEqual(r.draft.team, { members: ['test-writer', 'security-reviewer'], reviewer: 'security-reviewer' });
  assert.deepEqual(r.dropped, ['team: made-up']);
  const one = await generateAgent({ ...common, provider: answer({ ...base, team: { members: ['test-writer'] } }) as never });
  assert.equal(one.draft.team, undefined);
});

test('the agent tool marks the person\'s own agents and says to give their kind of work to them; without any, it says nothing of the sort', async () => {
  const { makeAgentTool, BUILTIN_AGENTS } = await import('../src/agents/agents.ts');
  const withMine = makeAgentTool([...BUILTIN_AGENTS, { name: 'test-fixer', description: 'Fixes failing tests.', prompt: '', source: 'user', model: 'deepseek-flash' }]);
  assert.match(withMine.spec.description, /- test-fixer \(yours\) \(deepseek-flash\): Fixes failing tests\./);
  assert.match(withMine.spec.description, /Agents marked \(yours\) are the person's own specialists[\s\S]*give that part to that agent/);
  assert.doesNotMatch(withMine.spec.description, /- general \(yours\)/);
  assert.doesNotMatch(makeAgentTool(BUILTIN_AGENTS).spec.description, /\(yours\)/);
});

test('an agent that runs out of steps still reports: one last call without tools, its partial findings reach the agent that delegated', async () => {
  const t = await setupServer();
  try {
    assert.equal((await t.call(OPERATOR, 'POST', '/api/me/agents', { name: 'brief-auditor', description: 'Audits files for problems and reports them.', prompt: 'Audit.', model: 'deepseek-flash', tools: ['read', 'glob'], maxTurns: 1 })).status, 201);
    t.ds.scripts.boss = [{ calls: [{ name: 'agent', input: { description: 'audit', type: 'brief-auditor', prompt: '[[aud]] Audit the files.' } }] }, { text: 'Relayed the partial audit.' }];
    t.ds.scripts.aud = [{ calls: [{ name: 'glob', input: { pattern: '*' } }] }, { text: 'Partial audit: listed the files; did not read any of them yet. Left: read and check each one.' }];
    const made = await t.call(OPERATOR, 'POST', '/api/sessions', { model: 'deepseek-flash', runtime: 'local', mode: 'bypass' });
    const s = t.harness.sessions.get(made.body.id)!;
    const events: HarnessEvent[] = [];
    s.subscribe(0, ({ event }) => events.push(event));
    await s.send('[[boss]] Audit everything.');
    await waitFor(() => events.some((e) => e.kind === 'turn_end' && !e.agent), 'done');
    const reqs = t.ds.byKey.aud!;
    assert.equal(reqs.length, 2, 'one step, then the wrap-up');
    assert.equal(reqs[1]!.toolChoice, 'none', 'the wrap-up cannot call tools');
    assert.match(JSON.stringify(reqs[1]!.messages), /reached your step limit[\s\S]*write your report now/);
    const res = s.history.flatMap((m) => m.content).filter((b) => b.type === 'tool_result').map((b) => String((b as { content: unknown }).content)).find((r) => /Partial audit/.test(r));
    assert.match(res ?? '', /^Partial audit: listed the files[\s\S]*\(The agent stopped early: max_steps\.\)/);
  } finally { await t.close(); }
});

test('a team lead must name the member: a call without one is refused (it says which members there are), never sent outside the team', async () => {
  const t = await setupServer();
  try {
    const mk = (b: Record<string, unknown>) => t.call(OPERATOR, 'POST', '/api/me/agents', { model: 'deepseek-flash', tools: ['read'], ...b });
    assert.equal((await mk({ name: 'only-member', description: 'The one member of a small team.', prompt: 'Work.' })).status, 201);
    assert.equal((await mk({ name: 'tiny-team', description: 'A team of one member, for tests.', prompt: 'Lead.', team: { members: ['only-member'] } })).status, 201);
    t.ds.scripts.tl = [
      { calls: [{ name: 'agent', input: { description: 'no type', prompt: '[[nt]] Do it.' } }] },
      { calls: [{ name: 'agent', input: { description: 'named', type: 'only-member', prompt: '[[nt]] Do it.' } }] },
      { text: 'Done.' },
    ];
    t.ds.scripts.nt = [{ text: 'Did it.' }];
    const made = await t.call(OPERATOR, 'POST', '/api/sessions', { agent: 'tiny-team', model: 'deepseek-flash', runtime: 'local', mode: 'bypass' });
    const s = t.harness.sessions.get(made.body.id)!;
    const events: HarnessEvent[] = [];
    s.subscribe(0, ({ event }) => events.push(event));
    await s.send('[[tl]] Go.');
    await waitFor(() => events.some((e) => e.kind === 'turn_end' && !e.agent), 'done');
    const schema = t.ds.byKey.tl![0]!.tools.find((x) => x.name === 'agent')!.input_schema as { required: string[] };
    assert.ok(schema.required.includes('type'), 'a team names its member');
    const first = events.find((e) => e.kind === 'tool_result' && e.name === 'agent') as Extract<HarnessEvent, { kind: 'tool_result' }>;
    assert.equal(first.is_error, true);
    assert.match(first.content, /type/);
    assert.ok(events.some((e) => e.kind === 'turn_end' && e.agent?.startsWith('only-member')), 'then it named the member, which ran');
    assert.ok(!events.some((e) => 'agent' in e && typeof e.agent === 'string' && e.agent.startsWith('explore')), 'no explore agent ran');
  } finally { await t.close(); }
});
