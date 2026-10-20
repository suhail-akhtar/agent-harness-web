import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newRun, render, WorkflowRunner } from '../src/graph/runner.ts';
import type { RunRecord, WorkflowDef, WorkflowHost } from '../src/graph/types.ts';
import { validateWorkflow } from '../src/graph/validate.ts';
import { LocalHost } from '../src/runtime/host.ts';
import { tempDir } from './helpers.ts';

function stubHost(opts: { reports?: Record<string, string[]>; gates?: boolean[]; approvals?: { approved: boolean; feedback?: string }[]; reasons?: Record<string, string[]> }) {
  const prompts: { label: string; prompt: string }[] = [];
  const saved: string[] = [];
  const reports = Object.fromEntries(Object.entries(opts.reports ?? {}).map(([k, v]) => [k, [...v]]));
  const gates = [...(opts.gates ?? [])];
  const approvals = [...(opts.approvals ?? [])];
  const host: WorkflowHost = {
    host: async () => new LocalHost(await tempDir()),
    runAgent: async (a) => { prompts.push({ label: a.label, prompt: a.prompt }); return { report: reports[a.label]?.shift() ?? `${a.label} done`, reason: opts.reasons?.[a.label]?.shift() ?? 'done', cost: 0.01 }; },
    runGates: async () => { const pass = gates.shift() ?? true; return [{ name: 'tests', pass, summary: pass ? 'ok' : '2 failing', details: pass ? undefined : 'expected 3, got 2' }]; },
    approve: async () => approvals.shift() ?? { approved: true },
    emit: () => {},
    save: async (r: RunRecord) => { saved.push(r.status); },
  };
  return { host, prompts, saved };
}

const wf = (): WorkflowDef => ({
  name: 'w', description: 'test', start: 'build',
  inputs: { request: { description: 'what', required: true } },
  nodes: {
    build: { type: 'agent', agent: 'engineer', prompt: 'Build {{input.request}}', next: 'gates' },
    gates: { type: 'gate', gates: 'applicable', maxFailures: 3, next: { on: { pass: 'review', fail: 'fix', exhausted: 'failed' } } },
    fix: { type: 'agent', prompt: 'Fix:\n{{feedback}}', next: 'gates' },
    review: { type: 'parallel', branches: ['cr', 'sr'], next: { on: { REQUEST_CHANGES: 'address' }, default: 'done' } },
    cr: { type: 'agent', prompt: 'review', decide: ['APPROVE', 'REQUEST_CHANGES'] },
    sr: { type: 'agent', prompt: 'security', decide: ['APPROVE', 'REQUEST_CHANGES'] },
    address: { type: 'agent', prompt: 'Address {{state.cr}}', next: 'done' },
    done: { type: 'end', status: 'success' },
    failed: { type: 'end', status: 'failed' },
  },
});

test('validation catches broken graphs before they run', () => {
  assert.deepEqual(validateWorkflow(wf()), []);
  const bad = wf();
  bad.nodes.fix = { type: 'agent', prompt: 'x', next: 'nowhere' };
  bad.nodes.orphan = { type: 'agent', prompt: 'x', next: 'done' };
  (bad.nodes.cr as { next?: string }).next = 'done';
  const errors = validateWorkflow(bad).join('\n');
  assert.match(errors, /fix: next "nowhere" does not exist/);
  assert.match(errors, /orphan: not reachable/);
  assert.match(errors, /branch "cr" must not have its own next/);
});

test('templates fill inputs, state and feedback', () => {
  const run = newRun(wf(), 's', { request: 'a todo app' });
  run.state.cr = 'looks fine';
  run.feedback = 'tests fail';
  assert.equal(render('{{input.request}} | {{state.cr}} | {{feedback}} | {{state.none}}', run), 'a todo app | looks fine | tests fail | ');
  assert.throws(() => newRun(wf(), 's', {}), /needs input "request"/);
});

test('gate failures route to the fix loop with the evidence, then on', async () => {
  const { host, prompts } = stubHost({ gates: [false, true], reports: { cr: ['All good.\nAPPROVE'], sr: ['No issues.\nAPPROVE'] } });
  const run = await new WorkflowRunner(wf(), host, newRun(wf(), 's', { request: 'X' })).execute(new AbortController().signal);
  assert.equal(run.status, 'succeeded');
  assert.deepEqual(run.history.map((h) => `${h.node}${h.outcome ? `:${h.outcome}` : ''}`), ['build', 'gates:fail', 'fix', 'gates:pass', 'review:all', 'cr:APPROVE', 'sr:APPROVE', 'done']);
  assert.match(prompts.find((p) => p.label === 'fix')!.prompt, /2 failing[\s\S]*expected 3, got 2/);
  assert.equal(prompts[0]!.prompt, 'Build X');
});

test('a failing gate that never recovers ends the run failed after maxFailures', async () => {
  const { host } = stubHost({ gates: [false, false, false, false] });
  const run = await new WorkflowRunner(wf(), host, newRun(wf(), 's', { request: 'X' })).execute(new AbortController().signal);
  assert.equal(run.status, 'failed');
  assert.equal(run.history.filter((h) => h.node === 'fix').length, 2);
  assert.equal(run.history.at(-1)!.node, 'failed');
});

test('a parallel review with a REQUEST_CHANGES verdict routes to the fix node', async () => {
  const { host, prompts } = stubHost({ reports: { cr: ['Missing tests for REQ-2.\nREQUEST_CHANGES'], sr: ['APPROVE'] } });
  const run = await new WorkflowRunner(wf(), host, newRun(wf(), 's', { request: 'X' })).execute(new AbortController().signal);
  assert.equal(run.history.find((h) => h.node === 'review')!.outcome, 'REQUEST_CHANGES');
  assert.match(prompts.find((p) => p.label === 'address')!.prompt, /Missing tests for REQ-2/);
  assert.equal(run.status, 'succeeded');
});

test('approval: rejection goes back with the reviewer feedback; branch routes on input', async () => {
  const w: WorkflowDef = {
    name: 'a', description: '', start: 'mode',
    nodes: {
      mode: { type: 'branch', value: '{{input.approval}}', next: { on: { auto: 'build' }, default: 'design' } },
      design: { type: 'agent', prompt: 'Design. Feedback: {{feedback}}', next: 'approve' },
      approve: { type: 'approval', message: 'ok?', next: { on: { approve: 'build', reject: 'design' } } },
      build: { type: 'agent', prompt: 'build', next: 'end' },
      end: { type: 'end' },
    },
  };
  const a = stubHost({ approvals: [{ approved: false, feedback: 'use Postgres' }, { approved: true }] });
  const run = await new WorkflowRunner(w, a.host, newRun(w, 's', { approval: 'manual' })).execute(new AbortController().signal);
  assert.deepEqual(run.history.map((h) => h.node), ['mode', 'design', 'approve', 'design', 'approve', 'build', 'end']);
  assert.match(a.prompts[1]!.prompt, /use Postgres/);
  const b = stubHost({});
  const run2 = await new WorkflowRunner(w, b.host, newRun(w, 's', { approval: 'auto' })).execute(new AbortController().signal);
  assert.deepEqual(run2.history.map((h) => h.node), ['mode', 'build', 'end']);
});

test('a run saved mid-way resumes at the node it was in', async () => {
  const { host } = stubHost({ reports: { cr: ['APPROVE'], sr: ['APPROVE'] } });
  const run = newRun(wf(), 's', { request: 'X' });
  run.current = 'review';
  run.status = 'interrupted';
  run.history.push({ node: 'review', type: 'parallel', status: 'running', startedAt: 1 });
  const done = await new WorkflowRunner(wf(), host, run).execute(new AbortController().signal);
  assert.equal(done.status, 'succeeded');
  assert.deepEqual(done.history.slice(0, 2).map((h) => `${h.node}:${h.status}`), ['review:interrupted', 'review:done']);
});

test('agent-run cap stops runaway loops', async () => {
  const w = wf();
  w.maxAgentRuns = 2;
  const { host } = stubHost({ gates: [false, false, false] });
  const run = await new WorkflowRunner(w, host, newRun(w, 's', { request: 'X' })).execute(new AbortController().signal);
  assert.equal(run.status, 'failed');
  assert.match(run.error ?? '', /agent-run limit/);
});

test('a step summary line skips headings and labels', async () => {
  const { firstLine } = await import('../src/graph/runner.ts');
  assert.equal(firstLine('## Report\n\n**Built the API** in src/.'), 'Built the API in src/.');
  assert.equal(firstLine('Report:\n---\nAll tests pass.'), 'All tests pass.');
  assert.equal(firstLine('# Only a heading'), '# Only a heading');
});

test('a step that runs out of steps goes on to the gates, and the fix step is told it was unfinished', async () => {
  const { host, prompts } = stubHost({ reasons: { build: ['max_steps'] }, reports: { build: ['Did tasks 1-5 of 9.'] }, gates: [false, true] });
  const run = await new WorkflowRunner(wf(), host, newRun(wf(), 's', { request: 'X' })).execute(new AbortController().signal);
  assert.deepEqual(run.history.slice(0, 4).map((h) => `${h.node}:${h.outcome ?? ''}`), ['build:incomplete', 'gates:fail', 'fix:', 'gates:pass']);
  assert.match(prompts.find((p) => p.label === 'fix')!.prompt, /ran out of steps[\s\S]*tasks 1-5 of 9[\s\S]*Quality gates failed/);
  assert.equal(run.state.__incomplete, undefined);
});
