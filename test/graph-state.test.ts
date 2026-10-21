import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { newRun, render, WorkflowRunner } from '../src/graph/runner.ts';
import { evaluateCondition, parseCondition } from '../src/graph/state.ts';
import type { RunRecord, WorkflowDef, WorkflowHost } from '../src/graph/types.ts';
import { usesNodeType, validateWorkflow } from '../src/graph/validate.ts';
import { loadWorkflowDir } from '../src/plugins/loader.ts';
import { LocalHost } from '../src/runtime/host.ts';
import { tempDir } from './helpers.ts';

/** A host whose agents answer from `answer(label, prompt)`; records prompts, concurrency and saves. */
function stubHost(answer: (label: string, prompt: string) => string | { report: string; reason?: string }, opts: { onAgent?: (label: string) => void; delayMs?: number } = {}) {
  const prompts: { label: string; prompt: string }[] = [];
  const saves: RunRecord[] = [];
  let running = 0;
  const peak = { value: 0 };
  const host: WorkflowHost = {
    host: async () => new LocalHost(await tempDir()),
    runAgent: async (a) => {
      prompts.push({ label: a.label, prompt: a.prompt });
      running++;
      peak.value = Math.max(peak.value, running);
      await new Promise((r) => setTimeout(r, opts.delayMs ?? 1));
      running--;
      opts.onAgent?.(a.label);
      const r = answer(a.label, a.prompt);
      const x = typeof r === 'string' ? { report: r } : r;
      return { report: x.report, reason: a.signal.aborted ? 'aborted' : x.reason ?? 'done', cost: 0.01 };
    },
    runGates: async () => [{ name: 'tests', pass: true, summary: 'ok' }],
    approve: async () => ({ approved: true }),
    emit: () => {},
    save: async (r: RunRecord) => { saves.push(JSON.parse(JSON.stringify(r))); },
  };
  return { host, prompts, saves, peak };
}

const json = (o: unknown) => `Done.\n\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;
const go = (w: WorkflowDef, host: WorkflowHost, run = newRun(w, 's', {})) => new WorkflowRunner(w, host, run).execute(new AbortController().signal);

test('state declarations and writes are checked when a workflow loads, with clear errors', () => {
  const w: WorkflowDef = {
    name: 'bad', description: '', start: 'a',
    state: {
      count: { type: 'number', reducer: 'append' },
      notes: { type: 'list', initial: 'x' },
      a: { type: 'string' },
      kind: { type: 'colour' as never },
      'bad-name': { type: 'string' },
      ok: { type: 'list', reducer: 'append' },
      n: { type: 'number', reducer: 'sum' },
    },
    nodes: {
      a: { type: 'agent', prompt: 'Look at {{item}} and {{state.nope}}', outputs: ['missing'], writes: { ghost: '1', n: '{{output}}' }, next: 'b' },
      b: { type: 'branch', when: 'state.n >> 2', next: { on: { true: 'c', false: 'c' } } },
      c: { type: 'branch', when: 'state.unknown > 1 || process.exit(1)', next: { on: { true: 'm', false: 'm' } } },
      m: { type: 'map', over: '{{state.n}}', node: { type: 'shell', command: 'echo {{item}}', next: 'end' } as never, concurrency: 0, collect: 'n', next: 'end' },
      end: { type: 'end' },
    },
  };
  const errors = validateWorkflow(w).join('\n');
  assert.match(errors, /state\.count: the append reducer needs a list field, not a number/);
  assert.match(errors, /state\.notes: initial "x" is not a list/);
  assert.match(errors, /state\.a: a node has the same id/);
  assert.match(errors, /state\.kind: type must be one of string, number, boolean, list, object/);
  assert.match(errors, /state\.bad-name: a field name is letters, digits and _/);
  assert.match(errors, /a: \{\{item\}\} only exists inside a map node's item/);
  assert.match(errors, /a: \{\{state\.nope\}\} is not a declared state field or a node/);
  assert.match(errors, /a: outputs "missing", which is not a declared state field/);
  assert.match(errors, /a: writes "ghost", which is not a declared state field/);
  assert.match(errors, /b: when "state\.n >> 2": unexpected ">"/);
  assert.match(errors, /c: when "state\.unknown > 1 \|\| process\.exit\(1\)": unknown name "process\.exit"/);
  assert.match(errors, /m: over names state\.n, a number, not a list/);
  assert.match(errors, /m: the map's node must not have its own next/);
  assert.match(errors, /m: concurrency must be a whole number from 1 to 50/);
  assert.match(errors, /m: collect "n" must be a list field, not a number/);
  assert.doesNotMatch(errors, /state\.ok|state\.n:/, 'well-formed fields pass');
  // A good declaration passes.
  const good: WorkflowDef = {
    name: 'good', description: '', start: 'b', state: { n: { type: 'number', reducer: 'sum', initial: 2 } },
    nodes: { b: { type: 'branch', when: 'state.n > 1', next: { on: { true: 'end', false: 'end' } } }, end: { type: 'end' } },
  };
  assert.deepEqual(validateWorkflow(good), []);
  assert.match(validateWorkflow({ ...good, nodes: { ...good.nodes, b: { type: 'branch', when: 'state.n > 1', next: { on: { true: 'end' } } } } }).join(), /routes "true" and "false"/);
});

test('conditions: a small language over state and inputs, never eval', () => {
  const w: WorkflowDef = { name: 'c', description: '', start: 'e', state: { failures: { type: 'number' }, todo: { type: 'list' }, plan: { type: 'object' }, done: { type: 'boolean' } }, nodes: { e: { type: 'end' } } };
  const run = newRun(w, 's', { mode: 'dry', limit: '3' });
  run.values = { failures: 3, todo: ['a', 'b'], plan: { title: 'X', steps: 4 }, done: false };
  run.state.review = 'APPROVE';
  const t = (e: string) => evaluateCondition(e, run);
  assert.equal(t('state.failures > 2'), true);
  assert.equal(t('state.failures >= input.limit'), true, 'a numeric input compares as a number');
  assert.equal(t('len(state.todo) == 2 && input.mode == "dry"'), true);
  assert.equal(t("state.plan.title == 'X' and not state.done"), true);
  assert.equal(t('state.plan.steps < 4 or contains(state.todo, "c")'), false);
  assert.equal(t('contains(state.review, "APPROVE")'), true, 'node outputs can be tested too');
  assert.equal(t('!(state.failures != 3)'), true);
  assert.equal(t('state.todo'), true, 'a non-empty list is true');
  assert.equal(t('state.missing == null'), true);
  for (const bad of ['constructor.constructor("x")()', 'state.failures + 1 > 2', 'state.x ==', '"open', '(state.x']) assert.throws(() => parseCondition(bad), Error, bad);
});

test('templates read typed state, dotted paths, and lists as JSON; node outputs still work', () => {
  const w: WorkflowDef = { name: 't', description: '', start: 'e', state: { plan: { type: 'object', initial: { title: 'Ship it', steps: ['a'] } }, n: { type: 'number', initial: 2 } }, nodes: { e: { type: 'end' } } };
  const run = newRun(w, 's', { request: 'X' });
  run.state.e = 'the end';
  assert.equal(render('{{state.plan.title}} / {{state.plan.steps}} / {{state.n}} / {{state.e}} / {{input.request}}', run), 'Ship it / ["a"] / 2 / the end / X');
  assert.deepEqual(run.values, { plan: { title: 'Ship it', steps: ['a'] }, n: 2 }, 'a new run starts from the initial values');
});

test('reducers: writes sum, append and merge across a loop; a branch condition ends it', async () => {
  const w: WorkflowDef = {
    name: 'loop', description: '', start: 'work',
    state: {
      attempts: { type: 'number', reducer: 'sum' },
      notes: { type: 'list', reducer: 'append' },
      seen: { type: 'object', reducer: 'merge' },
      last: { type: 'string' },
    },
    nodes: {
      work: { type: 'agent', prompt: 'Attempt {{state.attempts}}; notes so far {{state.notes}}', writes: { attempts: '1', notes: '{{output}}', seen: '{"a{{state.attempts}}": true}', last: 'attempt {{state.attempts}}' }, next: 'check' },
      check: { type: 'branch', when: 'state.attempts >= 3', next: { on: { true: 'done', false: 'work' } } },
      done: { type: 'end' },
    },
  };
  let n = 0;
  const { host, prompts } = stubHost(() => `note ${++n}`);
  const run = await go(w, host);
  assert.equal(run.status, 'succeeded', run.error ?? '');
  assert.deepEqual(run.history.map((h) => `${h.node}:${h.outcome ?? ''}`), ['work:', 'check:false', 'work:', 'check:false', 'work:', 'check:true', 'done:']);
  assert.deepEqual(run.values, { attempts: 3, notes: ['note 1', 'note 2', 'note 3'], seen: { a0: true, a1: true, a2: true }, last: 'attempt 2' }, 'templates in writes read state as it was before the writes');
  assert.equal(prompts[2]!.prompt, 'Attempt 2; notes so far ["note 1","note 2"]');
});

test('a write of the wrong type fails the node with the field named, and leaves state as it was', async () => {
  const w: WorkflowDef = {
    name: 'bad-write', description: '', start: 'a', state: { n: { type: 'number', reducer: 'sum' }, s: { type: 'string' } },
    nodes: { a: { type: 'agent', prompt: 'x', writes: { s: 'changed', n: '{{output}}' }, next: 'end' }, end: { type: 'end' } },
  };
  const { host } = stubHost(() => 'not a number');
  const run = await go(w, host);
  assert.equal(run.status, 'failed');
  assert.match(run.error ?? '', /writes: state\.n: expected a number, got "not a number"/);
  assert.deepEqual(run.values, { n: 0, s: '' }, 'no partial write');
});

test('an agent reports declared fields in a JSON block; a missing block fails or routes invalid-output', async () => {
  const w: WorkflowDef = {
    name: 'plan', description: '', start: 'plan',
    state: { items: { type: 'list' }, title: { type: 'string' }, risk: { type: 'number', reducer: 'sum' } },
    nodes: {
      plan: { type: 'agent', prompt: 'Plan it', outputs: ['items', 'title', 'risk'], decide: ['APPROVE', 'REJECT'], next: { on: { 'invalid-output': 'retry' }, default: 'end' } },
      retry: { type: 'agent', prompt: 'Your plan could not be read: {{feedback}}', next: 'end' },
      end: { type: 'end' },
    },
  };
  let { host, prompts } = stubHost(() => `${json({ items: ['a.ts', 'b.ts'], title: 'Two files', risk: '2' })}\nAPPROVE`);
  let run = await go(w, host);
  assert.equal(run.status, 'succeeded', run.error ?? '');
  assert.deepEqual(run.values, { items: ['a.ts', 'b.ts'], title: 'Two files', risk: 2 });
  assert.equal(run.history[0]!.outcome, 'APPROVE');
  assert.match(prompts[0]!.prompt, /End your report with a fenced JSON block[\s\S]*"items" \(list\), "title" \(string\), "risk" \(number\)[\s\S]*After the JSON block, end your report with exactly one of these words/);
  // No block: routed to invalid-output, with the reason as feedback.
  ({ host, prompts } = stubHost(() => 'I made a plan.'));
  run = await go(w, host);
  assert.deepEqual(run.history.map((h) => `${h.node}:${h.outcome ?? ''}`), ['plan:invalid-output', 'retry:', 'end:']);
  assert.match(prompts[1]!.prompt, /did not end with a JSON block holding items, title, risk/);
  // A wrong type, with no invalid-output route: the node fails, naming the field.
  const strict: WorkflowDef = { ...w, nodes: { plan: { ...w.nodes.plan!, next: 'end' } as never, end: w.nodes.end! } };
  ({ host } = stubHost(() => json({ items: 'a.ts', title: 'x', risk: 1 })));
  run = await go(strict, host);
  assert.equal(run.status, 'failed');
  assert.match(run.error ?? '', /state\.items: expected a list/);
});

test('map: one item per list entry, limited concurrency, results collected in order, reducers combine item writes', async () => {
  const w: WorkflowDef = {
    name: 'fan', description: '', start: 'plan',
    state: { files: { type: 'list' }, reviews: { type: 'list' }, findings: { type: 'number', reducer: 'sum' }, flagged: { type: 'list', reducer: 'append' } },
    nodes: {
      plan: { type: 'agent', prompt: 'List files', outputs: ['files'], next: 'review' },
      review: {
        type: 'map', over: '{{state.files}}', concurrency: 2, collect: 'reviews',
        node: { type: 'agent', prompt: 'Review {{item.path}} (#{{index}}) for {{input.goal}}', outputs: ['findings'], writes: { flagged: '{{item.path}}' } },
        next: 'gate',
      },
      gate: { type: 'branch', when: 'state.findings > 3', next: { on: { true: 'fix', false: 'end' } } },
      fix: { type: 'agent', prompt: 'Fix {{state.findings}} findings in {{state.flagged}}', next: 'end' },
      end: { type: 'end' },
    },
  };
  const files = ['a', 'b', 'c', 'd', 'e'].map((p) => ({ path: `${p}.ts` }));
  const { host, prompts, peak } = stubHost((label, prompt) => {
    if (label === 'plan') return json({ files });
    return label.startsWith('review[') ? json({ findings: Number(/\[(\d+)\]/.exec(label)![1]) }) : `fixed: ${prompt}`;
  }, { delayMs: 5 });
  const run = await go(w, host, newRun(w, 's', { goal: 'bugs' }));
  assert.equal(run.status, 'succeeded', run.error ?? '');
  assert.equal(peak.value, 2, 'at most `concurrency` items at once');
  assert.deepEqual(prompts.filter((p) => p.label.startsWith('review[')).map((p) => p.prompt).sort(), files.map((f, i) => `Review ${f.path} (#${i}) for bugs\n\nEnd your report with a fenced JSON block (\`\`\`json ... \`\`\`) holding one object with these fields: "findings" (number).`).sort());
  assert.deepEqual(run.values!.reviews, [0, 1, 2, 3, 4].map((i) => ({ findings: i })), 'collected in item order');
  assert.equal(run.values!.findings, 10, 'summed across items');
  assert.deepEqual([...(run.values!.flagged as string[])].sort(), files.map((f) => f.path));
  assert.equal(run.history.filter((h) => /^review\[\d\]$/.test(h.node) && h.status === 'done').length, 5, 'each item is in the history');
  assert.equal(run.history.find((h) => h.node === 'review')!.outcome, 'all');
  assert.equal(Math.round(run.history.find((h) => h.node === 'review')!.cost! * 100), 5, 'the map costs what its items cost');
  assert.match(prompts.at(-1)!.prompt, /Fix 10 findings in \["/);
  assert.equal(run.maps, undefined, 'progress is cleared once the map finishes');
  assert.equal(run.agentRuns, 7);
});

test('map: over a template that renders a JSON array, with code items; a non-list fails clearly', async () => {
  const w: WorkflowDef = {
    name: 'sq', description: '', start: 'm', state: { out: { type: 'list', reducer: 'append' } },
    nodes: {
      m: { type: 'map', over: '{{input.nums}}', collect: 'out', node: { type: 'code', run: async ({ item, index }) => ({ output: (item as number) ** 2 + index! * 0 }) }, next: 'end' },
      end: { type: 'end' },
    },
  };
  const { host } = stubHost(() => '');
  let run = await go(w, host, newRun(w, 's', { nums: '[1, 2, 3]' }));
  assert.equal(run.status, 'succeeded', run.error ?? '');
  assert.deepEqual(run.values!.out, [1, 4, 9], 'append adds each result to the list');
  assert.equal(run.state.m, '[1,4,9]');
  run = await go(w, host, newRun(w, 's', { nums: 'one, two' }));
  assert.equal(run.status, 'failed');
  assert.match(run.error ?? '', /m: over "\{\{input\.nums\}\}" is not a list \(got one, two\)/);
});

test('map respects the agent-run cap and the 200-step cap before it starts anything', async () => {
  const w: WorkflowDef = {
    name: 'cap', description: '', start: 'm', maxAgentRuns: 4, state: { items: { type: 'list', initial: [1, 2, 3, 4, 5] } },
    nodes: { m: { type: 'map', over: '{{state.items}}', node: { type: 'agent', prompt: 'do {{item}}' }, next: 'end' }, end: { type: 'end' } },
  };
  const a = stubHost(() => 'ok');
  let run = await go(w, a.host);
  assert.equal(run.status, 'failed');
  assert.match(run.error ?? '', /5 agent run\(s\) would pass the agent-run limit \(4, 0 used\)/);
  assert.equal(a.prompts.length, 0);
  const big: WorkflowDef = {
    name: 'big', description: '', start: 'm', state: { items: { type: 'list', initial: Array.from({ length: 250 }, (_, i) => i) } },
    nodes: { m: { type: 'map', over: '{{state.items}}', node: { type: 'code', run: async () => ({ output: 1 }) }, next: 'end' }, end: { type: 'end' } },
  };
  run = await go(big, a.host);
  assert.equal(run.status, 'failed');
  assert.match(run.error ?? '', /250 item\(s\) to run, more than the 199 step\(s\) left of the 200-step cap/);
  // 150 items fit; then a loop back would pass the cap.
  big.state!.items!.initial = Array.from({ length: 150 }, (_, i) => i);
  run = await go(big, a.host);
  assert.equal(run.status, 'succeeded', run.error ?? '');
});

test('map: a stopped run resumes with the finished items kept, and state survives the resume', async () => {
  const w: WorkflowDef = {
    name: 'resume', description: '', start: 'm',
    state: { items: { type: 'list', initial: ['a', 'b', 'c', 'd', 'e'] }, done: { type: 'number', reducer: 'sum' }, results: { type: 'list' } },
    nodes: {
      m: { type: 'map', over: '{{state.items}}', concurrency: 1, collect: 'results', node: { type: 'agent', prompt: 'do {{item}}', writes: { done: '1' } }, next: 'end' },
      end: { type: 'end' },
    },
  };
  const ac = new AbortController();
  const first = stubHost((label) => `did ${label}`, { onAgent: (label) => { if (label === 'm[1]') ac.abort(); } });
  let run = await new WorkflowRunner(w, first.host, newRun(w, 's', {})).execute(ac.signal);
  assert.equal(run.status, 'aborted');
  assert.deepEqual(Object.keys(run.maps!.m!.results), ['0'], 'm[0] finished; m[1] was cut short');
  assert.equal(run.values!.done, 1);
  assert.equal(run.history.find((h) => h.node === 'm[1]')!.status, 'interrupted');
  assert.equal(run.history.find((h) => h.node === 'm')!.status, 'interrupted');
  // The saved record, as a restart reads it back.
  const saved = JSON.parse(JSON.stringify(first.saves.at(-1))) as RunRecord;
  const second = stubHost((label) => `did ${label}`);
  run = await new WorkflowRunner(w, second.host, saved).execute(new AbortController().signal);
  assert.equal(run.status, 'succeeded', run.error ?? '');
  assert.deepEqual(second.prompts.map((p) => p.label), ['m[1]', 'm[2]', 'm[3]', 'm[4]'], 'finished items are not run again');
  assert.equal(run.values!.done, 5);
  assert.deepEqual(run.values!.results, ['did m[0]', 'did m[1]', 'did m[2]', 'did m[3]', 'did m[4]']);
});

test('map: failed items fail the run (a resume re-runs only them), or route "fail" with the evidence', async () => {
  const w: WorkflowDef = {
    name: 'fails', description: '', start: 'm', state: { items: { type: 'list', initial: [1, 2, 3] } },
    nodes: {
      m: { type: 'map', over: '{{state.items}}', node: { type: 'agent', prompt: 'do {{item}}' }, next: 'end' },
      fix: { type: 'agent', prompt: 'Fix: {{feedback}}', next: 'end' },
      end: { type: 'end' },
    },
  };
  const flaky = stubHost((label) => (label === 'm[1]' ? { report: 'stuck', reason: 'error' } : 'ok'));
  let run = await go({ ...w, nodes: { m: w.nodes.m!, end: w.nodes.end! } }, flaky.host);
  assert.equal(run.status, 'failed');
  assert.match(run.error ?? '', /m: 1 of 3 item\(s\) failed:\n\[1\] agent stopped: error/);
  const again = stubHost(() => 'ok');
  run = await new WorkflowRunner({ ...w, nodes: { m: w.nodes.m!, end: w.nodes.end! } }, again.host, JSON.parse(JSON.stringify(run))).execute(new AbortController().signal);
  assert.equal(run.status, 'succeeded', run.error ?? '');
  assert.deepEqual(again.prompts.map((p) => p.label), ['m[1]']);
  // Routed: the fix step gets the failures.
  const routed: WorkflowDef = { ...w, nodes: { ...w.nodes, m: { ...w.nodes.m!, next: { on: { fail: 'fix' }, default: 'end' } } as never } };
  const r2 = stubHost((label) => (label === 'm[2]' ? { report: 'gave up', reason: 'max_steps' } : 'ok'));
  run = await go(routed, r2.host);
  assert.deepEqual(run.history.filter((h) => !h.node.includes('[')).map((h) => `${h.node}:${h.outcome ?? ''}`), ['m:fail', 'fix:', 'end:']);
  assert.match(r2.prompts.at(-1)!.prompt, /\[2\] ran out of steps: gave up/);
});

test('JSON workflows cannot hide a code node in a map; the shell trust check sees map templates', async () => {
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, 'm.json'), JSON.stringify({ name: 'm', description: '', start: 'm', nodes: { m: { type: 'map', over: '[1]', node: { type: 'code' } , next: 'end' }, end: { type: 'end' } } }));
  const logs: string[] = [];
  assert.deepEqual(await loadWorkflowDir(dir, 'project', (m) => logs.push(m)), []);
  assert.match(logs.join(), /code nodes are only allowed in TypeScript workflows/);
  const w: WorkflowDef = { name: 's', description: '', start: 'm', nodes: { m: { type: 'map', over: '[1]', node: { type: 'shell', command: 'echo {{item}}' }, next: 'end' }, end: { type: 'end' } } };
  assert.equal(usesNodeType(w, 'shell'), true);
  assert.equal(usesNodeType(w, 'code'), false);
});
