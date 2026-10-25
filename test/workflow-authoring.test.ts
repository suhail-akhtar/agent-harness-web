// An agent writing its own workflow: the format it is given is valid as shown, "check" says why a
// file is not loaded (bad JSON, an invalid graph, shell steps where project commands are untrusted),
// "list" points at what did not load, and an unattended eval answers a question's form with an object.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { WORKFLOW_EXAMPLE, WORKFLOW_FORMAT } from '../src/graph/format.ts';
import { validateWorkflow } from '../src/graph/validate.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { workflowTool } from '../src/tools/schedule.ts';
import { formDefaults } from '../src/eval/runner.ts';
import { tempDir } from './helpers.ts';

test('workflow format: its example is a valid graph and every node type is described', () => {
  assert.deepEqual(validateWorkflow(WORKFLOW_EXAMPLE as never), []);
  for (const t of ['agent', 'shell', 'gate', 'approval', 'branch', 'parallel', 'map', 'end']) assert.match(WORKFLOW_FORMAT, new RegExp(`^- ${t}:`, 'm'), `${t} is described`);
  assert.match(WORKFLOW_FORMAT, /\.harness\/workflows\/<name>\.json/);
});

test('workflow check: a broken file and an untrusted shell step are reported; the tool lists them as not loaded', async () => {
  const data = await tempDir();
  const ws = await tempDir();
  const dir = path.join(ws, '.harness', 'workflows');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'good.json'), JSON.stringify({ name: 'good', description: 'ok', start: 'a', nodes: { a: { type: 'agent', prompt: 'hi', next: 'b' }, b: { type: 'end' } } }));
  await fs.writeFile(path.join(dir, 'steps.json'), JSON.stringify({ name: 'steps', description: 'x', steps: [{ id: 'test', run: 'npm test' }] }));
  await fs.writeFile(path.join(dir, 'torn.json'), '{"name": "torn",');
  await fs.writeFile(path.join(dir, 'release.json'), JSON.stringify(WORKFLOW_EXAMPLE));
  const prev = process.env.HARNESS_TRUST_PROJECT;
  delete process.env.HARNESS_TRUST_PROJECT;
  const h = await createHarness({ dataDir: data, backgroundWork: false, scheduler: false, search: null });
  try {
    const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws, sandbox: 'off' } });
    const r = await s.checkProjectWorkflows();
    const by = Object.fromEntries(r.map((x) => [x.file.split('/').pop(), x]));
    assert.equal(by['good.json']!.loaded, true);
    assert.equal(by['steps.json']!.loaded, false);
    assert.ok(by['steps.json']!.problems.length > 0);
    assert.match(by['torn.json']!.problems[0]!, /not valid JSON/);
    assert.equal(by['release.json']!.loaded, false);
    assert.match(by['release.json']!.problems.join(' '), /shell steps.*trust/);

    const services = { workflows: { list: async () => (await s.workflows()).map((w) => ({ name: w.name, description: w.description, inputs: [] })), run: async () => ({ status: 'succeeded', summary: '', cost: 0 }), check: () => s.checkProjectWorkflows() } };
    const ctx = { services } as never;
    const check = await workflowTool.run({ action: 'check' }, ctx);
    assert.equal(check.is_error, true);
    assert.match(check.content, /steps\.json \(steps\): NOT LOADED/);
    assert.match(check.content, /good\.json \(good\): OK, loaded/);
    const list = await workflowTool.run({ action: 'list' }, ctx);
    assert.match(list.content, /- good: ok/);
    assert.match(list.content, /Not loaded \(see "check"\): .*steps\.json/);
    assert.match(list.content, /"format" shows the file format/);
    assert.equal((await workflowTool.run({ action: 'format' }, ctx)).content, WORKFLOW_FORMAT);
  } finally {
    await h.close();
    if (prev === undefined) delete process.env.HARNESS_TRUST_PROJECT; else process.env.HARNESS_TRUST_PROJECT = prev;
  }
});

test('eval runner: a question with a form is answered with an object (defaults, first choices)', () => {
  assert.deepEqual(formDefaults({ type: 'object', properties: { decision: { type: 'string', enum: ['approve', 'reject'] }, note: { type: 'string' }, n: { type: 'number', default: 3 }, ok: { type: 'boolean' } } }),
    { decision: 'approve', note: 'Use your best judgement.', n: 3, ok: true });
});

test('workflow format: the shell quoting rule it teaches holds in bash (a value joined to quoted text, never inside quotes)', async () => {
  const { renderShell } = await import('../src/graph/state.ts');
  const { execFileSync } = await import('node:child_process');
  const run = { input: { version: '1.4.0' }, state: {}, values: {} } as never;
  const tag = (WORKFLOW_EXAMPLE.nodes.tag as { command: string }).command;
  const cmd = renderShell(tag.replace(/^git commit -am /, 'printf "%s|" ').replace(/ && git tag -a .*$/, ''), run);
  let bash = 'bash';
  try { execFileSync(bash, ['-c', 'true']); } catch { return; }
  assert.equal(execFileSync(bash, ['-c', cmd], { encoding: 'utf8' }), 'chore(release): v1.4.0|');
  // The mistake the rule warns about: a value inside quotes keeps its quotes.
  assert.equal(execFileSync(bash, ['-c', renderShell('printf "%s" "v{{input.version}}"', run)], { encoding: 'utf8' }), "v'1.4.0'");
});

test('toolBudget: past a step\'s budget a tool call is refused with why, other tools still run; the graph checks the budget', async () => {
  const { makeAgent } = await import('./helpers.ts');
  const { BUILTIN_TOOLS } = await import('../src/tools/index.ts');
  let ran = 0;
  const bot = { kind: 'read' as const, parallelSafe: false, remoteable: false, spec: { name: 'game_bot', description: 'plays', input_schema: { type: 'object' as const, properties: {} } }, summarize: () => 'bot', run: async () => { ran++; return { content: `won (${ran})` }; } };
  const h = await makeAgent([
    { calls: [{ name: 'game_bot', input: {} }] }, { calls: [{ name: 'game_bot', input: {} }] }, { calls: [{ name: 'game_bot', input: {} }] },
    { calls: [{ name: 'glob', input: { pattern: '*' } }] }, { text: 'done' },
  ], { tools: [...BUILTIN_TOOLS, bot], config: { toolBudget: { game_bot: 2 } } });
  h.agent.append({ role: 'user', content: [{ type: 'text', text: 'play it' }] });
  await h.agent.run(new AbortController().signal);
  assert.equal(ran, 2, 'the third call did not run');
  const results = h.agent.messages.flatMap((m) => m.content.filter((b) => b.type === 'tool_result')) as Array<{ content: string; is_error?: boolean }>;
  assert.match(results[2]!.content, /game_bot has been run 2 times in this step, its budget/);
  assert.equal(results[2]!.is_error, true);
  assert.equal(results[3]!.is_error, undefined, 'another tool still runs');
  const bad = { ...WORKFLOW_EXAMPLE, nodes: { ...WORKFLOW_EXAMPLE.nodes, prepare: { ...WORKFLOW_EXAMPLE.nodes.prepare, toolBudget: { game_bot: -1 } } } };
  assert.match(validateWorkflow(bad as never).join(' '), /toolBudget is/);
});
