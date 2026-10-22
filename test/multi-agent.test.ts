import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { getModel } from '../src/core/models.ts';
import { saveUserSettings } from '../src/core/settings.ts';
import type { HarnessEvent, Message } from '../src/core/types.ts';
import { anthropicBody } from '../src/providers/anthropic.ts';
import { toReasoningChat } from '../src/providers/chat-shared.ts';
import { toInputItems } from '../src/providers/openai.ts';
import { tempDir } from './helpers.ts';
import { gate, gitRepo, OPERATOR, record, setupServer, turnsEnded, userText, waitFor } from './multi-helpers.ts';

// A multi-agent platform (docs/desktop/DESIGN.md section 12): sub-agents with a worktree of
// their own and on other models (only those the person allowed), and sessions that start
// sessions - linked, proposed, reporting back, messaging each other, handing off. Two
// scripted providers stand in for DeepSeek and Anthropic; git is real, in temp repositories.

type ToolResult = Extract<HarnessEvent, { kind: 'tool_result' }>;
const results = (ev: HarnessEvent[]) => ev.filter((e) => e.kind === 'tool_result' && (!e.agent || e.agent === 'main')) as ToolResult[];
const desktop = { kind: 'desktop' as const, version: '1', renderers: [], tools: [] };

test('sub-agents: the agent tool lists each agent with its tools; isolation "worktree" gives a fresh worktree, removed when unchanged, kept and reported when not; refused without git', async () => {
  const t = await setupServer();
  try {
    const repo = await gitRepo();
    const s = await t.harness.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: repo } });
    const ev = record(s);
    t.ds.scripts['m'] = [
      { calls: [{ name: 'agent', input: { description: 'make', type: 'general', isolation: 'worktree', prompt: '[[w1]] add x.txt' } }, { name: 'agent', input: { description: 'look', type: 'general', isolation: 'worktree', prompt: '[[w2]] only look' } }] },
      { calls: [{ name: 'agent', input: { description: 'bg', type: 'general', isolation: 'worktree', run_in_background: true, prompt: '[[w3]] add y.txt' } }] },
      { calls: [{ name: 'monitor', input: { task_id: 'general-3', timeout_ms: 20_000 } }] },
      { text: 'done' },
    ];
    t.ds.scripts['w1'] = [{ calls: [{ name: 'write', input: { path: 'x.txt', content: 'x\n' } }] }, { text: 'wrote x.txt' }];
    t.ds.scripts['w2'] = [{ text: 'nothing to change' }];
    t.ds.scripts['w3'] = [{ calls: [{ name: 'write', input: { path: 'y.txt', content: 'y\n' } }] }, { text: 'wrote y.txt' }];
    await s.send('[[m]] go');
    await waitFor(() => turnsEnded(ev) === 1, 'turn', 30_000);
    const agentTool = t.ds.byKey['m']![0]!.tools.find((x) => x.name === 'agent')!;
    assert.match(agentTool.description, /- explore \[glob, grep, read, skill, tool_search, web_fetch\]: Read-only research/);
    assert.ok('isolation' in (agentTool.input_schema.properties as object), 'offered where the session is a git repository');
    const r = results(ev);
    assert.match(r[0]!.content, /wrote x\.txt[\s\S]*It worked in a git worktree: .*, branch harness\/[\w-]+, 0 commit\(s\), with uncommitted changes/);
    assert.match(r[1]!.content, /nothing to change[\s\S]*Its worktree changed nothing and was removed/);
    const dir = /worktree: (.+?), branch/.exec(r[0]!.content)![1]!;
    assert.equal(await fs.readFile(path.join(dir, 'x.txt'), 'utf8'), 'x\n');
    await assert.rejects(fs.stat(path.join(repo, 'x.txt')), 'the session\'s own checkout is untouched');
    // A background sub-agent in a worktree: its report, with the worktree, reaches the parent as a reminder, and a task event.
    assert.match(JSON.stringify(t.ds.byKey['m']!.at(-1)!.messages), /Background agent general-3 \(bg\) finished[\s\S]*wrote y\.txt[\s\S]*It worked in a git worktree/);
    assert.deepEqual(ev.filter((e) => e.kind === 'task').map((e) => (e as { phase: string }).phase), ['started', 'finished']);
    assert.equal(s.meta.subWorktrees?.length, 2);
    // Deleting the session removes the worktrees (their branches stay, they have no commits: gone too).
    await t.harness.sessions.remove(s.meta.id);
    await assert.rejects(fs.stat(dir));
    // Without git: no isolation offered, and asking for it anyway is refused with why.
    const plain = await t.harness.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: await tempDir() } });
    const pev = record(plain);
    t.ds.scripts['n'] = [{ calls: [{ name: 'agent', input: { description: 'x', type: 'general', isolation: 'worktree', prompt: '[[w4]] x' } }] }, { text: 'ok' }];
    await plain.send('[[n]] go');
    await waitFor(() => turnsEnded(pev) === 1, 'turn');
    assert.ok(!('isolation' in (t.ds.byKey['n']![0]!.tools.find((x) => x.name === 'agent')!.input_schema.properties as object)));
    assert.match(results(pev)[0]!.content, /isolation "worktree" needs the session's folder to be a git repository/);
    assert.equal(t.ds.byKey['w4'], undefined, 'no sub-agent ran');
  } finally { await t.close(); }
});

test('delegation: another model only when the person allows it; the allowed ones are listed in the agent tool; approval per provider; a spend cap; costs by model; workflow nodes too', async () => {
  const t = await setupServer();
  try {
    // Not allowed (the default: only the session's own model).
    const s0 = await t.harness.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: await tempDir() } });
    const ev0 = record(s0);
    t.ds.scripts['d0'] = [{ calls: [{ name: 'agent', input: { description: 'review', type: 'explore', model: 'claude-sonnet-5-5', prompt: '[[rev0]] review' } }] }, { text: 'ok' }];
    await s0.send('[[d0]] go');
    await waitFor(() => turnsEnded(ev0) === 1, 'turn');
    assert.match(results(ev0)[0]!.content, /Delegating to claude-sonnet-5-5 \(anthropic\) is not allowed[\s\S]*delegation\.allowedModels/);
    assert.equal(t.an.requests.length, 0);
    const tool0 = t.ds.byKey['d0']![0]!.tools.find((x) => x.name === 'agent')!;
    assert.ok(!('model' in (tool0.input_schema.properties as object)), 'no model parameter when no other model is allowed');
    // Allowed, with approval for each new provider and a small spend cap on delegated work.
    await saveUserSettings(t.data, undefined, { delegation: { allowedModels: ['claude-sonnet-5-5'], requireApproval: true, maxCostUsd: 0.0002 } });
    const ws = await tempDir();
    await fs.mkdir(path.join(ws, '.harness', 'workflows'), { recursive: true });
    await fs.writeFile(path.join(ws, '.harness', 'workflows', 'review.json'), JSON.stringify({
      name: 'review', description: 'a review by another model', start: 'r',
      nodes: { r: { type: 'agent', agent: 'explore', model: 'claude-sonnet-5-5', prompt: '[[wfr]] review the change', next: 'end' }, end: { type: 'end' } },
    }));
    const s = await t.harness.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws } });
    const ev = record(s);
    t.ds.scripts['d1'] = [
      { calls: [{ name: 'agent', input: { description: 'review', type: 'explore', model: 'claude-sonnet-5-5', effort: 'low', prompt: '[[rev1]] review' } }] },
      { calls: [{ name: 'agent', input: { description: 'again', type: 'explore', model: 'claude-sonnet-5-5', prompt: '[[rev2]] review again' } }] },
      { text: 'ok' },
    ];
    t.an.scripts['rev1'] = [{ text: 'LGTM from Sonnet' }];
    await s.send('[[d1]] go');
    await waitFor(() => ev.some((e) => e.kind === 'permission_request'), 'the approval');
    const ask = ev.find((e) => e.kind === 'permission_request') as Extract<HarnessEvent, { kind: 'permission_request' }>;
    assert.equal(ask.tool, 'delegate');
    assert.match(ask.summary, /to anthropic \(claude-sonnet-5-5\)/);
    s.respond(ask.requestId, { decision: 'allow' });
    await waitFor(() => turnsEnded(ev) === 1, 'turn');
    const r = results(ev);
    assert.match(r[0]!.content, /LGTM from Sonnet/, 'the report comes back like any sub-agent\'s');
    assert.match(r[1]!.content, /Agents on other models have spent \$0\.\d+ in this session, the most allowed \(delegation\.maxCostUsd/);
    assert.equal(ev.filter((e) => e.kind === 'permission_request').length, 1, 'approved once per provider');
    assert.equal(t.an.byKey['rev1']![0]!.model.id, 'claude-sonnet-5-5');
    assert.equal(t.an.byKey['rev1']![0]!.effort, 'low');
    assert.ok(s.meta.byModel['claude-sonnet-5-5']!.cost > 0 && s.meta.byModel['deepseek-flash']!.cost > 0, 'each model\'s cost is its own');
    assert.deepEqual(s.meta.delegatedProviders, ['anthropic']);
    const tool = t.ds.byKey['d1']![0]!.tools.find((x) => x.name === 'agent')!;
    assert.match(tool.description, /Other models \(model param; default deepseek-flash\):\n- claude-sonnet-5-5 \(anthropic, \$\$\$, 1M: strongest reasoning, review, hard code\)/);
    // A workflow's reviewer node on another model: the same consent (the cap is spent here, so it is refused).
    await s.startWorkflow('review', {});
    await waitFor(async () => (await s.listRuns())[0]?.status === 'failed', 'the run to fail');
    assert.match((await s.listRuns())[0]!.error ?? '', /delegation\.maxCostUsd/);
    await saveUserSettings(t.data, undefined, { delegation: { allowedModels: '*' } });
    await s.configChanged('user_settings');
    t.an.scripts['wfr'] = [{ text: 'review: fine' }];
    s.meta.delegationCost = 0;
    await s.startWorkflow('review', {});
    await waitFor(async () => (await s.listRuns()).some((x) => x.status === 'succeeded'), 'the run to succeed');
    assert.equal(t.an.byKey['wfr']!.length, 1);
  } finally { await t.close(); }
});

test('cross-model linked sessions: a model the person has not allowed is refused; an allowed one runs on its own provider, reports back and takes messages', async () => {
  const t = await setupServer();
  try {
    const repo = await gitRepo();
    const p = await t.harness.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: repo }, client: desktop });
    const ev = record(p);
    p.update({ title: 'Parent' });
    t.ds.scripts['x'] = [{ calls: [{ name: 'start_session', input: { title: 'On Claude', prompt: '[[cc]] review', context: 'fresh', initiation: 'user_asked', use_worktree: true, model: 'claude-sonnet-5-5' } }] }, { text: 'ok' }];
    await p.send('[[x]] go');
    await waitFor(() => turnsEnded(ev) === 1, 'turn');
    assert.match(results(ev)[0]!.content, /not allowed[\s\S]*delegation\.allowedModels/);
    assert.equal(p.meta.linked, undefined);
    await saveUserSettings(t.data, undefined, { delegation: { allowedModels: ['claude-sonnet-5-5'] } });
    await p.configChanged('user_settings');
    t.ds.scripts['x'] = [
      { calls: [{ name: 'start_session', input: { title: 'On Claude', prompt: '[[cc]] review', context: 'fresh', initiation: 'user_asked', use_worktree: true, model: 'claude-sonnet-5-5', effort: 'medium' } }] },
      { text: 'started' },
      // Woken by the Claude session's report: it asks it one more thing.
      () => ({ calls: [{ name: 'send_message', input: { to: p.meta.linked![0]!, message: 'and the tests?' } }] }),
      { text: 'ok' },
    ];
    t.an.scripts['cc'] = [{ text: 'Claude: looks right' }, { text: 'Claude: tests too' }];
    await p.send('[[x]] again');
    await waitFor(() => (t.an.byKey['cc']?.length ?? 0) >= 2, 'the message to reach the Claude session', 30_000);
    const child = t.harness.sessions.get(p.meta.linked![0]!)!;
    assert.equal(child.meta.model, 'claude-sonnet-5-5');
    assert.equal(child.meta.effort, 'medium');
    assert.match(userText(t.ds.byKey['x']!.find((r) => /Claude: looks right/.test(userText(r)))!), /<side_session id="[a-f0-9]{16}">\nClaude: looks right/);
    assert.match(userText(t.an.byKey['cc']![1]!), /<session_message from="[^"]+" id="[a-f0-9]{16}">\nand the tests\?/);
  } finally { await t.close(); }
});

test('cross-provider: one provider\'s reasoning is never replayed to another (the turn is rebuilt as text and tool calls)', () => {
  const fromDeepseek: Message = { role: 'assistant', content: [{ type: 'reasoning', text: 'secret chain' }, { type: 'text', text: 'answer' }, { type: 'tool_use', id: 't1', name: 'read', input: { path: 'a' } }], raw: { provider: 'deepseek', model: 'deepseek-flash', payload: { role: 'assistant', content: 'answer', reasoning_content: 'secret chain' } } };
  const fromClaude: Message = { role: 'assistant', content: [{ type: 'reasoning', text: 'claude thought' }, { type: 'text', text: 'hi' }], raw: { provider: 'anthropic', model: 'claude-sonnet-5-5', payload: [{ type: 'thinking', thinking: 'claude thought', signature: 'sig' }, { type: 'text', text: 'hi' }] } };
  const user: Message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] };
  const body = JSON.stringify(anthropicBody({ model: getModel('claude-sonnet-5-5'), system: 's', tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }, fromDeepseek, user], effort: 'low' }, true));
  assert.ok(!body.includes('secret chain') && !body.includes('reasoning_content'));
  assert.match(body, /"text":"answer"[\s\S]*"tool_use"/);
  const other = JSON.stringify(anthropicBody({ model: getModel('claude-haiku-5-5'), system: 's', tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }, fromClaude], effort: 'low' }, true));
  assert.ok(!other.includes('claude thought') && !other.includes('"signature"'), 'thinking is tied to the model that wrote it');
  assert.ok(!JSON.stringify(toReasoningChat(fromClaude, { provider: 'moonshot', toolImages: 'inline' })).includes('claude thought'));
  assert.ok(!JSON.stringify(toInputItems(fromDeepseek)).includes('secret chain'));
});

test('linked sessions: user_asked starts at once (fresh: only the brief) in its own worktree; it reports to its parent, which an idle parent wakes to; events reach the global stream', async () => {
  const t = await setupServer();
  try {
    const repo = await gitRepo();
    const p = await t.harness.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: repo }, client: desktop });
    const ev = record(p);
    const global = await t.stream(OPERATOR, '/api/events?topics=linked,chapters');
    t.ds.scripts['p'] = [
      { calls: [{ name: 'mark_chapter', input: { title: 'Split the work', summary: 'two parts' } }, { name: 'start_session', input: { title: 'Add function', prompt: '[[ca]] write add.ts', context: 'fresh', initiation: 'user_asked', use_worktree: true } }] },
      { text: 'started it; waiting' },
      { text: 'parent saw the report' },
    ];
    t.ds.scripts['ca'] = [{ calls: [{ name: 'write', input: { path: 'add.ts', content: 'export const add = (a: number, b: number) => a + b;\n' } }] }, { text: 'CHILD-A: wrote add.ts' }];
    await p.send('[[p]] split it');
    await waitFor(() => turnsEnded(ev) === 2, 'the parent to be woken by the report and finish', 30_000);
    const r = results(ev);
    assert.equal(r[0]!.content, 'Chapter 1: Split the work');
    assert.match(r[1]!.content, /Started linked session "Add function" \(([a-f0-9]{16})\) on deepseek-flash, in a worktree on branch harness\//);
    const child = t.harness.sessions.get(p.meta.linked![0]!)!;
    assert.equal(child.meta.parent, p.meta.id);
    assert.equal(child.meta.linkDepth, 1);
    assert.equal(child.meta.mode, 'bypass');
    assert.ok(child.meta.runtime.worktree, 'its own worktree');
    assert.equal(await fs.readFile(path.join(child.workspace, 'add.ts'), 'utf8'), 'export const add = (a: number, b: number) => a + b;\n');
    await assert.rejects(fs.stat(path.join(repo, 'add.ts')));
    // Fresh: the child's first request holds its brief, not the parent's conversation.
    const first = userText(t.ds.byKey['ca']![0]!);
    assert.match(first, /You are a linked session "Add function", started by session/);
    assert.equal(JSON.parse(t.ds.sent['ca']![0]!).length, 1, 'one message: the environment and the brief, none of the parent\'s conversation');
    assert.ok(!first.includes('mark_chapter') && !first.includes('Split the work'));
    // The parent's wake-up request carries the fenced report, after the conversation so far (appended, nothing edited).
    const woke = t.ds.byKey['p']!.at(-1)!;
    const prev = t.ds.sent['p']!.at(-2)!;
    assert.ok(JSON.stringify(woke.messages).startsWith(prev.slice(0, -1)), 'the history only grows');
    assert.match(userText(woke), /Linked session "Add function" \([a-f0-9]{16}\) finished its turn[\s\S]*<side_session id="[a-f0-9]{16}">\nCHILD-A: wrote add\.ts\n<\/side_session>/);
    assert.ok(ev.some((e) => e.kind === 'user_message' && e.origin === 'auto'));
    assert.equal(p.meta.autoContinues, 1);
    assert.deepEqual(ev.filter((e) => e.kind === 'side_session').map((e) => (e as { phase: string }).phase), ['started', 'report']);
    assert.deepEqual(p.meta.chapters!.map((c) => c.title), ['Split the work']);
    await waitFor(() => global.got.some((e) => e.topic === 'linked' && e.payload.type === 'report'), 'the global report');
    assert.ok(global.got.some((e) => e.topic === 'chapters' && e.payload.title === 'Split the work'));
    // A person's message resets the count of turns started without one.
    await t.call(OPERATOR, 'POST', `/api/sessions/${p.meta.id}/messages`, { text: 'thanks [[p]]' });
    await waitFor(() => turnsEnded(ev) === 3, 'turn 3');
    assert.equal(p.meta.autoContinues, 0);
    global.close();
  } finally { await t.close(); }
});

test('linked sessions: a fork gets the conversation so far (the pending call answered) with the same prompt, tools and cache key; workspaces: refused without git unless shared; depth, linked and account limits', async () => {
  const t = await setupServer({ env: { HARNESS_LINKED_MAX: '1', HARNESS_USER_MAX_RUNNING: '2' } });
  try {
    const a = await t.member('alice');
    const repo = await gitRepo();
    const p = await t.harness.sessions.create({ model: 'deepseek-flash', mode: 'acceptEdits', runtime: { kind: 'local', network: 'none', path: repo }, client: desktop, owner: a.id });
    const ev = record(p);
    const hold = gate();
    t.ds.scripts['pf'] = [
      { text: 'thinking', calls: [{ name: 'start_session', input: { title: 'Fork it', prompt: '[[cf]] carry on', context: 'fork', initiation: 'user_asked', use_worktree: true } }] },
      { calls: [{ name: 'start_session', input: { title: 'Second', prompt: '[[c2]] x', context: 'fresh', initiation: 'user_asked', use_worktree: true } }] },
      { text: 'ok' },
    ];
    t.ds.scripts['cf'] = [{ wait: hold.p, text: 'fork done' }];
    await p.send('[[pf]] go');
    await waitFor(() => turnsEnded(ev) === 1, 'turn 1');
    const r = results(ev);
    assert.match(r[1]!.content, /1 linked sessions of this session are working already, the most at once \(1, HARNESS_LINKED_MAX\)/);
    const fork = t.harness.sessions.get(p.meta.linked![0]!)!;
    await waitFor(() => !!t.ds.byKey['cf'], 'the fork to make its first request');
    const fr = t.ds.byKey['cf']![0]!;
    const pr = t.ds.byKey['pf']![0]!;
    assert.equal(fr.system, pr.system, 'the same system prompt');
    assert.deepEqual(fr.tools, pr.tools, 'the same tools: the cached prefix serves both');
    assert.equal(fr.cacheKey, pr.cacheKey);
    assert.equal(JSON.stringify(fr.messages[0]), JSON.stringify(pr.messages[0]), 'the same opening message');
    assert.match(JSON.stringify(fr.messages), /This call started this session: you are now the linked session \\"Fork it\\"/);
    assert.equal(fork.meta.forkedFrom?.id, p.meta.id);
    hold.open();
    await waitFor(() => turnsEnded(ev) >= 2, 'the parent to see the fork\'s report', 30_000);
    // Depth: a session two levels down starts none.
    fork.meta.linkDepth = 2;
    const fev = record(fork);
    t.ds.scripts['cf2'] = [{ calls: [{ name: 'start_session', input: { title: 'Deeper', prompt: 'x', context: 'fresh', initiation: 'user_asked', use_worktree: true } }] }, { text: 'ok' }];
    await fork.send('[[cf2]] go deeper');
    await waitFor(() => results(fev).some((x) => /levels deep/.test(x.content)), 'the depth refusal');
    // Without git: refused unless the parent shares its folder.
    const plainDir = await tempDir();
    const q = await t.harness.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: plainDir }, client: desktop, owner: a.id });
    const qev = record(q);
    t.ds.scripts['q'] = [
      { calls: [{ name: 'start_session', input: { title: 'No git', prompt: '[[cq]] x', context: 'fresh', initiation: 'user_asked', use_worktree: true } }] },
      { calls: [{ name: 'start_session', input: { title: 'Shared', prompt: '[[cq]] x', context: 'fresh', initiation: 'user_asked', share_workspace: true } }] },
      { text: 'ok' },
    ];
    await q.send('[[q]] go');
    await waitFor(() => turnsEnded(qev) >= 1 && results(qev).length >= 2, 'q turn');
    assert.match(results(qev)[0]!.content, /is not a git repository, so the linked session cannot get a worktree of it\. Pass share_workspace: true/);
    assert.match(results(qev)[1]!.content, /Started linked session "Shared"/);
    assert.equal(t.harness.sessions.get(q.meta.linked![0]!)!.workspace, plainDir);
    // The account's running-session cap (HARNESS_USER_MAX_RUNNING=2): a third at once is refused.
    const blocker = gate();
    t.ds.scripts['busy'] = [{ wait: blocker.p, text: 'x' }];
    const other = await t.harness.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: await tempDir() }, owner: a.id });
    await other.send('[[busy]] hold');
    await waitFor(() => turnsEnded(qev) >= 2, 'q idle again', 30_000);
    t.ds.scripts['q'] = [{ calls: [{ name: 'start_session', input: { title: 'Third', prompt: '[[c3]] x', context: 'fresh', initiation: 'user_asked', share_workspace: true } }] }, { text: 'ok' }];
    const n = results(qev).length;
    await q.send('[[q]] again');
    await waitFor(() => results(qev).length > n, 'the cap refusal');
    assert.match(results(qev)[n]!.content, /already has 2 sessions working/);
    blocker.open();
  } finally { await t.close(); }
});

test('proposals: offer and own_initiative wait for the person (nothing runs); the owner starts or dismisses them, others cannot; they expire', async () => {
  const t = await setupServer();
  try {
    const a = await t.member('alice');
    const b = await t.member('bob');
    const repo = await gitRepo();
    const p = await t.harness.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: repo }, client: desktop, owner: a.id });
    const ev = record(p);
    const global = await t.stream(a.token, '/api/events?topics=proposals');
    t.ds.scripts['po'] = [
      { calls: [
        { name: 'start_session', input: { title: 'Tidy docs', prompt: '[[cp1]] tidy', context: 'fresh', initiation: 'offer', use_worktree: true } },
        { name: 'start_session', input: { title: 'Add tests', prompt: '[[cp2]] tests', context: 'fresh', initiation: 'own_initiative', use_worktree: true } },
        { name: 'start_session', input: { title: 'Old idea', prompt: '[[cp3]] old', context: 'fresh', initiation: 'offer', use_worktree: true } },
      ] },
      { text: 'proposed' },
    ];
    await p.send('[[po]] go');
    await waitFor(() => turnsEnded(ev) === 1, 'turn');
    assert.match(results(ev)[0]!.content, /Proposed "Tidy docs" \(prop_[a-f0-9]{12}\): the person starts or dismisses it; nothing runs until then/);
    const props = ev.filter((e) => e.kind === 'session_proposal') as Extract<HarnessEvent, { kind: 'session_proposal' }>[];
    assert.deepEqual(props.map((x) => [x.title, x.initiation]), [['Tidy docs', 'offer'], ['Add tests', 'own_initiative'], ['Old idea', 'offer']]);
    assert.equal(p.meta.linked, undefined, 'nothing started');
    assert.equal(t.ds.byKey['cp1'], undefined);
    const listed = await t.call(a.token, 'GET', `/api/sessions/${p.meta.id}/proposals`);
    assert.equal(listed.body.length, 3);
    assert.equal((await t.call(b.token, 'GET', `/api/sessions/${p.meta.id}/proposals`)).status, 404);
    assert.equal((await t.call(b.token, 'POST', `/api/proposals/${props[0]!.id}/start`)).status, 404, 'another person cannot start it');
    assert.equal((await t.call(OPERATOR, 'POST', `/api/proposals/${props[0]!.id}/start`)).status, 404, 'nor an administrator for the owner');
    assert.equal((await t.call(a.token, 'POST', `/api/proposals/${props[0]!.id}/dismiss`)).status, 200);
    assert.equal((await t.call(a.token, 'POST', `/api/proposals/${props[0]!.id}/start`)).status, 409, 'a dismissed proposal does not start');
    const started = await t.call(a.token, 'POST', `/api/proposals/${props[1]!.id}/start`);
    assert.equal(started.status, 201);
    assert.equal(started.body.session.parent, p.meta.id);
    await waitFor(() => !!t.ds.byKey['cp2'], 'the started session to run');
    assert.equal((await t.call(a.token, 'POST', `/api/proposals/${props[1]!.id}/start`)).status, 409, 'started once');
    // Expiry: seven days after it was made.
    const file = path.join(t.data, 'proposals.json');
    const j = JSON.parse(await fs.readFile(file, 'utf8'));
    for (const x of j.proposals) if (x.id === props[2]!.id) x.expiresAt = Date.now() - 1;
    await fs.writeFile(file, JSON.stringify(j));
    assert.deepEqual((await t.call(a.token, 'GET', `/api/sessions/${p.meta.id}/proposals`)).body, []);
    assert.equal((await t.call(a.token, 'POST', `/api/proposals/${props[2]!.id}/start`)).status, 410, 'gone');
    assert.deepEqual(ev.filter((e) => e.kind === 'proposal_resolved').map((e) => (e as { status: string }).status), ['dismissed', 'started', 'expired']);
    await waitFor(() => global.got.filter((e) => e.topic === 'proposals').length >= 6, 'proposal events on the global stream');
    assert.deepEqual(global.got.filter((e) => e.topic === 'proposals').map((e) => e.payload.type), ['added', 'added', 'added', 'dismissed', 'started', 'expired']);
    // The agent withdraws one of its own.
    t.ds.scripts['po'] = [{ calls: [{ name: 'start_session', input: { title: 'Maybe', prompt: '[[cp4]] m', context: 'fresh', initiation: 'offer', use_worktree: true } }] }, (req) => ({ calls: [{ name: 'dismiss_proposal', input: { proposal_id: /\((prop_[a-f0-9]{12})\)/.exec(JSON.stringify(req.messages.at(-1)))![1]! } }] }), { text: 'ok' }];
    await p.send('[[po]] again');
    await waitFor(() => turnsEnded(ev) >= 2 && results(ev).some((x) => /^Dismissed "Maybe"/.test(x.content)), 'the dismissal', 30_000);
    global.close();
  } finally { await t.close(); }
});

test('linked sessions: auto-continue stops at its cap without a person\'s message; reports of a session that read outside content are fenced and taint the parent; messages between sessions (busy: queued, idle: a turn, another account: refused); list_sessions; hand_off', async () => {
  const t = await setupServer();
  try {
    const a = await t.member('alice');
    const b = await t.member('bob');
    await saveUserSettings(t.data, a.id, { linkedSessions: { maxAutoContinues: 1 } });
    const repo = await gitRepo();
    const p = await t.harness.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: repo }, client: desktop, owner: a.id });
    const bobs = await t.harness.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: await tempDir() }, owner: b.id });
    const ev = record(p);
    t.ds.scripts['pa'] = [
      { calls: [{ name: 'start_session', input: { title: 'Worker', prompt: '[[cw]] work', context: 'fresh', initiation: 'user_asked', use_worktree: true } }] },
      { text: 'started' },
      { text: 'woken once' },
    ];
    t.ds.scripts['cw'] = [{ text: 'first report' }, { text: 'second report' }];
    await p.send('[[pa]] go');
    await waitFor(() => turnsEnded(ev) === 2, 'the first wake', 30_000);
    const child = t.harness.sessions.get(p.meta.linked![0]!)!;
    const cev = record(child);
    // The child read outside content: its next report is fenced as such, and the parent counts as having read it.
    child.markUntrusted();
    await child.send('[[cw]] more');
    await waitFor(() => ev.filter((e) => e.kind === 'side_session' && e.phase === 'report').length === 2, 'the second report');
    await waitFor(() => ev.some((e) => e.kind === 'notice' && /not continuing on its own \(it already continued 1 time\(s\)/.test(e.text)), 'the cap notice');
    assert.equal(turnsEnded(ev), 2, 'not woken a second time');
    assert.ok(p.meta.tainted, 'the parent counts as having read outside content');
    // Messages: to the idle child (a turn), to bob's session (refused); list the linked sessions; hand off.
    t.ds.scripts['pa'] = [
      { calls: [{ name: 'list_sessions', input: { linked: true } }, { name: 'send_message', input: { to: child.meta.id, message: 'please also add a test' } }, { name: 'send_message', input: { to: bobs.meta.id, message: 'hi bob' } }] },
      { calls: [{ name: 'hand_off', input: { title: 'Finish docs', remaining_plan: '[[ho]] write the docs section' } }] },
      { text: 'answering the new question' },
    ];
    t.ds.scripts['cw'] = [{ text: 'added a test' }];
    await t.call(a.token, 'POST', `/api/sessions/${p.meta.id}/messages`, { text: '[[pa]] next' });
    await waitFor(() => results(ev).some((x) => /^Handed off/.test(x.content)), 'the hand-off', 30_000);
    const r = results(ev);
    const listed = r.find((x) => x.content.includes(child.meta.id) && /\[linked\]/.test(x.content));
    assert.ok(listed, 'list_sessions shows the linked one');
    assert.match(r.find((x) => /^Delivered/.test(x.content))!.content, /it was idle and starts a turn with it/);
    assert.match(r.find((x) => /hi bob|No other session/.test(x.content))!.content, new RegExp(`No other session ${bobs.meta.id} of this account`));
    await waitFor(() => cev.some((e) => e.kind === 'user_message' && e.origin === 'auto'), 'the child to be woken by the message');
    // The sender read outside content: its message is fenced as outside data, and the receiver is tainted.
    assert.match(userText(t.ds.byKey['cw']!.at(-1)!), /A message from session "[^"]*" \([a-f0-9]{16}\)[\s\S]*<outside_data source="session [^"]*, which read outside content">[\s\S]*please also add a test/);
    const handed = r.find((x) => /^Handed off/.test(x.content))!.content;
    const hid = /\(([a-f0-9]{16})\)/.exec(handed)![1]!;
    const h = t.harness.sessions.get(hid)!;
    assert.equal(h.meta.forkedFrom?.id, p.meta.id);
    assert.deepEqual(p.meta.handoffs?.map((x) => x.id), [hid]);
    await waitFor(() => !!t.ds.byKey['ho'], 'the hand-off session to run');
    assert.match(userText(t.ds.byKey['ho']![0]!), /to take over a task it handed off[\s\S]*\[\[ho\]\] write the docs section/);
  } finally { await t.close(); }
});
