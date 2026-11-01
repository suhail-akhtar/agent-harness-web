import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { agentToMarkdown, checkAgentDef, parseAgentFile, stricterMode, toolMatches } from '../src/agents/agents.ts';
import { AgentStore } from '../src/agents/store.ts';
import { saveUserSettings } from '../src/core/settings.ts';
import type { HarnessEvent } from '../src/core/types.ts';
import { tempDir } from './helpers.ts';
import { OPERATOR, record, setupServer, turnsEnded, waitFor } from './multi-helpers.ts';

// Custom agents (docs/agents-mcp/PLAN.md, phase 1): a person's own agents (versioned), Claude Code's agent file
// format in and out (and Copilot's and Cursor's), every field enforced where the agent runs (tools and deny lists
// with globs, only its MCP servers and skills, autonomy never looser than the conversation's, turn and spend limits,
// background, who may use it), its own model only when the person allowed it, and conversations that run as one.

const here = path.dirname(fileURLToPath(import.meta.url));
type ToolResult = Extract<HarnessEvent, { kind: 'tool_result' }>;
const subResults = (ev: HarnessEvent[], agent: RegExp) => ev.filter((e) => e.kind === 'tool_result' && e.agent && agent.test(e.agent)) as ToolResult[];
const mainResults = (ev: HarnessEvent[]) => ev.filter((e) => e.kind === 'tool_result' && (!e.agent || e.agent === 'main')) as ToolResult[];
const toolNames = (req: { tools: Array<{ name: string }> }) => req.tools.map((t) => t.name).sort();

test('agent files: Claude Code\'s fields, Copilot\'s and Cursor\'s, read; written back as a Claude Code file that reads the same', () => {
  const cc = parseAgentFile(['---', 'name: security-reviewer', 'description: Reviews changes for security problems. Use after any change to auth code.', 'tools: Read, Grep, Glob, Bash', 'disallowedTools: Bash(git push *), mcp__github__delete_*', 'model: sonnet', 'effort: high', 'permissionMode: bypassPermissions', 'maxTurns: 30', 'skills: [owasp, threat-model]', 'mcpServers: github', 'isolation: worktree', 'background: true', 'color: red', '---', 'You review code.'].join('\n'), 'x', 'user')!;
  assert.deepEqual(cc.tools, ['read', 'grep', 'glob', 'bash']);
  assert.deepEqual(cc.disallowedTools, ['Bash(git push *)', 'mcp__github__delete_*']);
  assert.equal(cc.model, 'claude-sonnet-5-5', 'Claude Code\'s alias');
  assert.equal(cc.permissionMode, 'acceptEdits', 'bypass is never taken from a file');
  assert.deepEqual([cc.maxTurns, cc.skills, cc.mcpServers, cc.isolation, cc.background, cc.color], [30, ['owasp', 'threat-model'], ['github'], 'worktree', true, 'red']);
  const copilot = parseAgentFile(['---', 'name: issue-triager', 'description: Triages new issues', 'tools: [read, search, github/*, jira/create_issue]', 'mcp-servers: github', 'disable-model-invocation: true', 'user-invocable: false', '---', 'Triage.'].join('\n'), 'x', 'user')!;
  assert.deepEqual(copilot.tools, ['read', 'glob', 'grep', 'web_search', 'mcp__github__*', 'mcp__jira__create_issue'], 'aliases and server/tool names');
  assert.deepEqual([copilot.modelInvocable, copilot.userInvocable, copilot.mcpServers], [false, false, ['github']]);
  const cursor = parseAgentFile('---\nname: scout\ndescription: Finds things\nreadonly: true\nis_background: true\n---\n', 'x', 'user')!;
  assert.deepEqual(cursor.tools, ['glob', 'grep', 'read', 'skill', 'tool_search', 'web_fetch']);
  assert.equal(cursor.background, true);
  const { source: _s, ...plain } = cc;
  const back = parseAgentFile(agentToMarkdown(plain), 'x', 'user')!;
  assert.deepEqual({ ...back, source: undefined }, { ...plain, permissionMode: 'acceptEdits', source: undefined }, 'round trip');
  assert.equal(parseAgentFile('---\nname: bad name\ndescription: x\n---\n', 'x', 'user'), undefined);
  assert.equal(parseAgentFile('no frontmatter', 'x', 'user'), undefined);
});

test('an agent as given is checked: names, a description that says when, known values only; globs; a mode never looser than the conversation\'s', () => {
  assert.throws(() => checkAgentDef({ name: 'has space', description: 'Does things well.' }), /name is letters/);
  assert.throws(() => checkAgentDef({ name: 'a', description: 'short' }), /when to use it/);
  assert.throws(() => checkAgentDef({ name: 'a', description: 'Does things well.', permissionMode: 'bypass' }), /permissionMode is one of/);
  assert.throws(() => checkAgentDef({ name: 'a', description: 'Does things well.', maxTurns: 0 }), /maxTurns/);
  assert.throws(() => checkAgentDef({ name: 'a', description: 'Does things well.', maxCostUsd: -1 }), /maxCostUsd/);
  assert.throws(() => checkAgentDef({ name: 'a', description: 'Does things well.', tools: ['read; rm -rf /'] }), /tools is a list of names/);
  assert.deepEqual(checkAgentDef({ name: 'a', description: 'Does things well.', tools: ['Read', 'execute'], model: 'haiku', effort: 'low' }), { name: 'a', description: 'Does things well.', prompt: '', tools: ['read', 'bash', 'run_script', 'task_output', 'task_stop', 'monitor'], model: 'claude-haiku-5-5', effort: 'low' });
  assert.equal(toolMatches(['mcp__github__*'], 'mcp__github__create_issue'), true);
  assert.equal(toolMatches(['mcp__github__*'], 'mcp__gitlab__x'), false);
  assert.equal(toolMatches(['read'], 'read_more'), false);
  assert.equal(stricterMode('bypass', 'default'), 'default');
  assert.equal(stricterMode('default', 'acceptEdits'), 'default', 'never looser');
  assert.equal(stricterMode('auto', 'plan'), 'plan');
  assert.equal(stricterMode('default', 'dontAsk'), 'dontAsk', 'refusing what it would ask is not more');
  assert.equal(stricterMode('acceptEdits', undefined), 'acceptEdits');
});

test('the store: per person, versions with history, a stale save refused, a rename keeps history, on and off without a version, restore, no built-in names', async () => {
  const store = new AgentStore(await tempDir());
  const a = await store.create('al', { name: 'writer', description: 'Writes release notes from merged changes.', prompt: 'v1' }, 1000);
  assert.deepEqual([a.version, a.enabled, a.owner], [1, true, 'al']);
  await assert.rejects(store.create('al', { name: 'writer', description: 'Writes release notes again.' }), /already have an agent named "writer"/);
  await assert.rejects(store.create('al', { name: 'explore', description: 'Shadows the built-in one.' }), /built-in agent/);
  assert.deepEqual(await store.list('bo'), [], 'each person their own');
  const b = await store.update('al', 'writer', { name: 'writer', description: 'Writes release notes from merged changes.', prompt: 'v2' }, { expectVersion: 1, now: 2000 });
  assert.equal(b.version, 2);
  await assert.rejects(store.update('al', 'writer', { name: 'writer', description: 'Writes release notes, stale.', prompt: 'v3' }, { expectVersion: 1 }), /changed since you opened it \(now version 2/);
  const off = await store.update('al', 'writer', { enabled: false });
  assert.deepEqual([off.version, off.enabled], [2, false], 'on and off is not a new version');
  assert.deepEqual(await store.active('al'), []);
  const renamed = await store.update('al', 'writer', { name: 'notes-writer', description: 'Writes release notes from merged changes.', prompt: 'v3' }, { now: 3000 });
  assert.deepEqual([renamed.name, renamed.version, renamed.enabled], ['notes-writer', 3, false]);
  assert.equal(await store.get('al', 'writer'), undefined);
  assert.deepEqual((await store.versions('al', 'notes-writer')).map((v) => [v.version, v.def.prompt]), [[2, 'v2'], [1, 'v1']]);
  const back = await store.restore('al', 'notes-writer', 1, 4000);
  assert.deepEqual([back.version, back.prompt, back.name], [4, 'v1', 'notes-writer'], 'an old version comes back as a new one');
  assert.equal((await store.versions('al', 'notes-writer')).length, 3);
  assert.equal(await store.remove('al', 'notes-writer'), true);
  assert.equal(await store.remove('al', 'notes-writer'), false);
});

test('where it runs: its tools and deny list (globs), only its MCP servers and skills, its skills\' instructions up front, its autonomy, turn and spend limits, background by default; the orchestrator is not offered one kept for the person', async () => {
  const skillDir = await tempDir();
  await fs.mkdir(path.join(skillDir, 'release-style'), { recursive: true });
  await fs.writeFile(path.join(skillDir, 'release-style', 'SKILL.md'), '---\nname: release-style\ndescription: How release notes are written here\n---\nWrite notes as bullet points, newest first.');
  await fs.mkdir(path.join(skillDir, 'other-skill'), { recursive: true });
  await fs.writeFile(path.join(skillDir, 'other-skill', 'SKILL.md'), '---\nname: other-skill\ndescription: Something else\n---\nOther.');
  const t = await setupServer();
  try {
    const fixture = path.join(here, 'fixtures', 'mcp-server.mjs');
    t.harness.registry.mcpServers.set('alpha', { command: process.execPath, args: [fixture], plugin: 'test' });
    t.harness.registry.mcpServers.set('beta', { command: process.execPath, args: [fixture], plugin: 'test' });
    t.harness.registry.skillDirs.push({ dir: skillDir, source: 'test' });
    const add = (def: Record<string, unknown>) => t.harness.agentStore.create(undefined, def);
    await add({ name: 'reader', description: 'Reads files and reports what they say.', prompt: 'You only read.', tools: ['read', 'glob', 'mcp__beta__*'], mcpServers: ['alpha'], skills: ['release-style'] });
    await add({ name: 'no-shell', description: 'Does everything but run commands.', prompt: 'No shell.', disallowedTools: ['bash', 'run_*'] });
    await add({ name: 'planner', description: 'Plans changes without making them.', prompt: 'Plan.', permissionMode: 'plan' });
    await add({ name: 'short', description: 'Gives up quickly when stuck.', prompt: 'Short.', maxTurns: 2 });
    await add({ name: 'thrifty', description: 'Stops at a small spend limit.', prompt: 'Cheap.', maxCostUsd: 0.000001 });
    await add({ name: 'slow', description: 'Long research that runs in the background.', prompt: 'Slow.', background: true });
    await add({ name: 'mine-only', description: 'One the person keeps for themselves.', prompt: 'Mine.', modelInvocable: false });
    await add({ name: 'off-one', description: 'Switched off: in no conversation.', prompt: 'Off.', enabled: false });
    const work = await tempDir();
    const s = await t.harness.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: work } });
    const ev = record(s);
    const call = (type: string, key: string) => ({ name: 'agent', input: { description: type, type, prompt: `[[${key}]] go` } });
    t.ds.scripts.m = [
      { calls: [call('reader', 'r'), call('no-shell', 'n'), call('planner', 'p')] },
      { calls: [call('short', 's'), call('thrifty', 't'), call('slow', 'w')] },
      { text: 'all done' },
    ];
    t.ds.scripts.r = [{ text: 'read it' }];
    t.ds.scripts.n = [{ text: 'no shell here' }];
    t.ds.scripts.p = [{ calls: [{ name: 'write', input: { path: 'plan.txt', content: 'x' } }] }, { text: 'planned' }];
    t.ds.scripts.s = [{ calls: [{ name: 'glob', input: { pattern: '*' } }] }, { calls: [{ name: 'glob', input: { pattern: '*' } }] }, { calls: [{ name: 'glob', input: { pattern: '*' } }] }, { text: 'never reached' }];
    t.ds.scripts.t = [{ calls: [{ name: 'glob', input: { pattern: '*' } }] }, { text: 'never reached' }];
    t.ds.scripts.w = [{ text: 'slow report' }];
    await s.send('[[m]] go');
    await waitFor(() => turnsEnded(ev) === 1, 'turn', 30_000);
    // The orchestrator's catalogue: the person's agents that are on and offered to it.
    const agentTool = t.ds.byKey.m![0]!.tools.find((x) => x.name === 'agent')!;
    const offered = (agentTool.input_schema.properties as { type: { enum: string[] } }).type.enum;
    assert.ok(['reader', 'no-shell', 'planner', 'short', 'thrifty', 'slow'].every((n) => offered.includes(n)));
    assert.ok(!offered.includes('mine-only') && !offered.includes('off-one'), 'kept for the person, or switched off');
    assert.match(agentTool.description, /- reader \[read, glob, mcp__beta__\*\] \{mcp: alpha\}: Reads files/);
    // reader: read and glob; alpha's tools (its server), not beta's (not its server, though its list names them); only its skill, loaded up front.
    const rq = t.ds.byKey.r![0]!;
    const rt = toolNames(rq);
    assert.ok(rt.includes('read') && rt.includes('glob') && !rt.includes('bash') && !rt.includes('write'));
    assert.ok(rt.some((n) => n.startsWith('mcp__alpha__')) && !rt.some((n) => n.startsWith('mcp__beta__')), rt.join(','));
    assert.deepEqual((rq.tools.find((x) => x.name === 'skill')!.input_schema.properties as { name: { enum: string[] } }).name.enum, ['release-style']);
    assert.match(JSON.stringify(rq.messages), /<role>\\nYou only read\.\\n<\/role>[\s\S]*<skill name=\\"release-style\\">\\nWrite notes as bullet points/);
    // no-shell: everything but bash and run_* (a glob).
    const nt = toolNames(t.ds.byKey.n![0]!);
    assert.ok(nt.includes('write') && nt.includes('read') && !nt.includes('bash') && !nt.some((n) => n.startsWith('run_')));
    // planner: plan mode in a bypass conversation; its write is refused.
    assert.match(subResults(ev, /^planner/)[0]!.content, /plan mode/i);
    // short: 2 steps at most.
    assert.equal(t.ds.byKey.s!.length, 2);
    // thrifty: stopped at its spend limit.
    assert.ok(ev.some((e) => e.kind === 'notice' && e.agent?.startsWith('thrifty') && /the thrifty agent reached its spend limit of \$0\.000001 for one run \(\$0\.0000\d+ spent\)/.test(e.text)));
    // slow: in the background by default.
    assert.match(mainResults(ev).map((r) => r.content).join('\n'), /Started slow-\d+ in the background/);
  } finally { await t.close(); }
});

test('an agent\'s own model goes to another company only when the person allowed it (else it runs on the conversation\'s, and says so)', async () => {
  const t = await setupServer();
  try {
    await t.harness.agentStore.create(undefined, { name: 'claude-reviewer', description: 'Reviews code on Claude.', prompt: 'Review.', model: 'claude-sonnet-5-5' });
    const s = await t.harness.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: await tempDir() } });
    const ev = record(s);
    t.ds.scripts.m = [{ calls: [{ name: 'agent', input: { description: 'review', type: 'claude-reviewer', prompt: '[[v]] review' } }] }, { text: 'ok' }];
    await s.send('[[m]] go');
    await waitFor(() => turnsEnded(ev) === 1, 'turn');
    assert.equal(t.an.byKey.v, undefined, 'nothing reached Anthropic');
    assert.equal(t.ds.byKey.v!.length, 1, 'it ran on DeepSeek');
    assert.ok(ev.some((e) => e.kind === 'notice' && /The claude-reviewer agent runs on deepseek-flash, not claude-sonnet-5-5: .*not allowed/.test(e.text)));
    // Allowed: it runs on Claude.
    await saveUserSettings(t.data, undefined, { delegation: { allowedModels: ['claude-sonnet-5-5'] } });
    const s2 = await t.harness.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: await tempDir() } });
    const ev2 = record(s2);
    t.ds.scripts.m2 = [{ calls: [{ name: 'agent', input: { description: 'review', type: 'claude-reviewer', prompt: '[[v2]] review' } }] }, { text: 'ok' }];
    await s2.send('[[m2]] go');
    await waitFor(() => turnsEnded(ev2) === 1, 'turn');
    assert.equal(t.an.byKey.v2!.length, 1, 'on Claude now');
    assert.equal(t.an.byKey.v2![0]!.model.id, 'claude-sonnet-5-5');
  } finally { await t.close(); }
});

test('the API: the catalogue and options, create, import a Claude Code file, export it back, versions and restore, a stale save, generate a draft (only what the person has), each person their own; a conversation that runs as an agent', async () => {
  const t = await setupServer();
  try {
    const al = await t.member('al');
    const bo = await t.member('bo');
    const c = (tok: string, m: string, p: string, b?: unknown) => t.call(tok, m, p, b);
    const opts = (await c(al.token, 'GET', '/api/agents/options')).body;
    assert.ok(opts.tools.some((x: { name: string }) => x.name === 'read') && opts.models.some((m: { id: string }) => m.id === 'deepseek-flash'));
    assert.equal((await c(al.token, 'POST', '/api/me/agents', { name: 'x', description: 'short' })).status, 400);
    const made = await c(al.token, 'POST', '/api/me/agents', { name: 'tester', description: 'Writes and runs tests for a change.', prompt: 'Test it.', tools: ['read', 'write', 'bash'], model: 'deepseek-flash', permissionMode: 'acceptEdits' });
    assert.equal(made.status, 201);
    assert.equal((await c(al.token, 'POST', '/api/me/agents', { name: 'tester', description: 'Writes and runs tests again.' })).status, 409);
    const file = '---\nname: doc-writer\ndescription: Writes documentation for new features.\ntools: Read, Write, Grep\nmodel: haiku\n---\nWrite clear docs.\n';
    const imp = await c(al.token, 'POST', '/api/me/agents/import', { text: file });
    assert.equal(imp.status, 201);
    assert.deepEqual([imp.body.tools, imp.body.model], [['read', 'write', 'grep'], 'claude-haiku-5-5']);
    assert.equal((await c(al.token, 'POST', '/api/me/agents/import', { text: file.replace('clear', 'short') })).status, 200, 'again: a new version');
    assert.equal((await c(al.token, 'GET', '/api/me/agents/doc-writer')).body.version, 2);
    const md = await c(al.token, 'GET', '/api/me/agents/doc-writer/export');
    assert.match(md.headers.get('content-type') ?? '', /text\/markdown/);
    assert.match(md.text, /^---\nname: doc-writer\ndescription: Writes documentation for new features\.\ntools: read, write, grep\nmodel: claude-haiku-5-5\n---\n\nWrite short docs\.\n$/);
    assert.equal((await c(al.token, 'POST', '/api/me/agents/import', { text: 'just text' })).status, 400);
    assert.deepEqual((await c(al.token, 'GET', '/api/me/agents/doc-writer/versions')).body.map((v: { version: number }) => v.version), [1]);
    assert.equal((await c(al.token, 'POST', '/api/me/agents/doc-writer/restore', { version: 1 })).body.prompt, 'Write clear docs.');
    assert.equal((await c(al.token, 'PUT', '/api/me/agents/doc-writer', { agent: { name: 'doc-writer', description: 'Writes documentation for new features.' }, expectVersion: 1 })).status, 409);
    assert.equal((await c(al.token, 'PUT', '/api/me/agents/doc-writer', { enabled: false })).body.enabled, false);
    // The catalogue: built-in, then the person's own; another person sees none of them.
    const cat = (await c(al.token, 'GET', '/api/agents')).body as Array<{ name: string; source: string; prompt?: string }>;
    assert.deepEqual(cat.map((x) => `${x.source}:${x.name}`), ['builtin:explore', 'builtin:general', 'user:doc-writer', 'user:tester']);
    assert.equal((await c(bo.token, 'GET', '/api/me/agents')).body.length, 0);
    assert.equal((await c(bo.token, 'GET', '/api/me/agents/tester')).status, 404);
    // Generate: the model's draft, with what the person does not have dropped and a taken name changed.
    t.ds.scripts.main = [{ text: JSON.stringify({ name: 'tester', description: 'Finds flaky tests and explains why they flake.', prompt: 'Role: ...', tools: ['read', 'grep', 'teleport'], mcpServers: ['nowhere'], effort: 'medium', permissionMode: 'plan', maxTurns: 30 }) }];
    const gen = await c(al.token, 'POST', '/api/me/agents/generate', { description: 'An agent that finds flaky tests and tells me why they flake', model: 'deepseek-flash' });
    assert.equal(gen.status, 200, JSON.stringify(gen.body));
    assert.equal(gen.body.draft.name, 'tester-2', 'a free name');
    assert.deepEqual(gen.body.draft.tools, ['read', 'grep']);
    assert.equal(gen.body.draft.mcpServers, undefined);
    assert.deepEqual(gen.body.dropped, ['tools: teleport', 'mcpServers: nowhere']);
    assert.equal((await c(al.token, 'GET', '/api/me/agents/tester-2')).status, 404, 'a draft is not saved');
    t.ds.scripts.main = [{ text: 'I would rather not.' }];
    assert.equal((await c(al.token, 'POST', '/api/me/agents/generate', { description: 'An agent that does something useful for me' })).status, 422);
    assert.equal((await c(al.token, 'DELETE', '/api/me/agents/tester')).status, 200);
    assert.equal((await c(al.token, 'DELETE', '/api/me/agents/tester')).status, 404);
  } finally { await t.close(); }
});

test('a conversation that runs as an agent: its model, its instructions in the system prompt, only its tools, its mode', async () => {
  const t = await setupServer();
  try {
    await t.harness.agentStore.create(undefined, { name: 'tester', description: 'Writes and runs tests for a change.', prompt: 'Always run the tests before you finish.', tools: ['read', 'glob', 'bash'], model: 'deepseek-flash', permissionMode: 'plan' });
    await t.harness.agentStore.create(undefined, { name: 'private-one', description: 'Only for the orchestrator to use.', prompt: 'x', userInvocable: false });
    const work = await tempDir();
    assert.equal((await t.call(OPERATOR, 'POST', '/api/sessions', { agent: 'nobody', runtime: 'local', path: work })).status, 400);
    assert.match((await t.call(OPERATOR, 'POST', '/api/sessions', { agent: 'private-one', runtime: 'local', path: work })).body.error, /for the orchestrator only/);
    const made = await t.call(OPERATOR, 'POST', '/api/sessions', { agent: 'tester', runtime: 'local', path: work, mode: 'bypass' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.deepEqual([made.body.agent, made.body.model, made.body.title], ['tester', 'deepseek-flash', 'tester']);
    const s = t.harness.sessions.get(made.body.id)!;
    const ev = record(s);
    t.ds.scripts.a = [{ calls: [{ name: 'bash', input: { command: 'echo hi > x.txt' } }] }, { text: 'planned only' }];
    await s.send('[[a]] make x.txt');
    // Its plan mode, though the conversation is bypass: the command waits for the person.
    await waitFor(() => ev.some((e) => e.kind === 'permission_request'), 'the request');
    assert.equal((ev.find((e) => e.kind === 'permission_request') as { tool: string }).tool, 'bash');
    s.abort();
    await waitFor(() => turnsEnded(ev) === 1, 'turn');
    const req = t.ds.byKey.a![0]!;
    assert.match(req.system, /<agent name="tester">\nIn this conversation you are the tester agent: Writes and runs tests for a change\.\n\nAlways run the tests before you finish\.\n<\/agent>/);
    assert.deepEqual(toolNames(req).filter((n) => !['agent'].includes(n)).filter((n) => ['read', 'glob', 'bash', 'write', 'edit'].includes(n)), ['bash', 'glob', 'read']);
  } finally { await t.close(); }
});
