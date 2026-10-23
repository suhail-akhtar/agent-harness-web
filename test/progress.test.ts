import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { assess, cleanProgressReview, defaultProgressReview, normalizeError, parseVerdict, ProgressTracker, REVIEW_SYSTEM, type ProgressReviewSettings } from '../src/core/progress.ts';
import type { Block, HarnessEvent, Message, Usage } from '../src/core/types.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { defineTool } from '../src/plugins/api.ts';
import type { Provider, ProviderRequest, ProviderResponse } from '../src/providers/types.ts';
import { BUILTIN_TOOLS } from '../src/tools/index.ts';
import { loadCases, runEvals } from '../src/eval/runner.ts';
import { apply, toRows, type Live } from '../packages/client/src/timeline.ts';
import { FakeProvider, makeAgent, tempDir } from './helpers.ts';

const ac = () => new AbortController().signal;
type Reply = { text?: string; calls?: { name: string; input?: Record<string, unknown> }[] };

const textOf = (m?: Message) => (m?.content ?? []).map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? b.content : '')).join('\n');
const isCompaction = (req: ProviderRequest) => /Do not call tools; reply with the (summary|handoff) only/.test(textOf(req.messages.at(-1)));

/** Main steps from a function of the step number; reviews and compactions answered apart (and counted). */
class ScriptProvider implements Provider {
  main: ProviderRequest[] = [];
  reviews: ProviderRequest[] = [];
  compactions: ProviderRequest[] = [];
  snapshots: string[] = [];
  private n = 0;
  private step = 0;
  private next: (step: number, req: ProviderRequest) => Reply;
  private reviewer: (req: ProviderRequest) => string;
  private handoff = 'Requirements: write the files. Done: nothing that works. Remaining: write out.txt. Pitfalls: missing files.';
  constructor(next: (step: number, req: ProviderRequest) => Reply, reviewer: (req: ProviderRequest) => string = () => 'no verdict') {
    this.next = next;
    this.reviewer = reviewer;
  }
  async send(req: ProviderRequest): Promise<ProviderResponse> {
    let r: Reply;
    if (req.system === REVIEW_SYSTEM) { this.reviews.push(req); r = { text: this.reviewer(req) }; }
    else if (isCompaction(req)) { this.compactions.push(req); r = { text: this.handoff }; }
    else { this.main.push(req); this.snapshots.push(JSON.stringify(req.messages)); r = this.next(++this.step, req); }
    const content: Block[] = [];
    if (r.text) content.push({ type: 'text', text: r.text });
    for (const c of r.calls ?? []) content.push({ type: 'tool_use', id: `call_${++this.n}`, name: c.name, input: c.input ?? {} });
    const usage: Usage = { input: 100, cacheRead: 0, cacheWrite: 0, output: 10, reasoning: 0 };
    return { message: { role: 'assistant', content, raw: { provider: 'deepseek', model: req.model.id, payload: {} } }, stop: r.calls?.length ? 'tool_use' : 'end', usage };
  }
}

const pr = (over: Partial<ProgressReviewSettings> = {}): ProgressReviewSettings => ({ ...defaultProgressReview({}), ...over });

/** An agent on the script provider, with its own budget and progress-review settings. */
async function setup(next: (step: number, req: ProviderRequest) => Reply, o: { maxSteps: number; review?: Partial<ProgressReviewSettings> | false; reviewer?: (req: ProviderRequest) => string; name?: string; tools?: NonNullable<Parameters<typeof makeAgent>[1]>['tools'] }) {
  const h = await makeAgent([], { settings: { progressReview: o.review === false ? pr({ enabled: false }) : pr(o.review) }, tools: o.tools });
  const p = new ScriptProvider(next, o.reviewer);
  h.agent.cfg = { ...h.agent.cfg, provider: p, maxSteps: o.maxSteps, ...(o.name ? { name: o.name } : {}) };
  h.agent.append({ role: 'user', content: [{ type: 'text', text: 'build the thing' }] });
  const progress = () => h.events.filter((e): e is Extract<HarnessEvent, { kind: 'progress' }> => e.kind === 'progress');
  return { ...h, p, progress };
}

const verdict = (v: Record<string, unknown>) => () => JSON.stringify({ onTrack: false, nearDone: false, issues: [], falseClaims: [], advice: '', ...v });

/** A bash stand-in: "npm test" fails until fixed.txt exists; anything else succeeds. */
function fakeBash(root: string) {
  return defineTool({
    name: 'bash', description: 'run a command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    run: async (i) => {
      const fixed = await fs.stat(path.join(root, 'fixed.txt')).then(() => true, () => false);
      return /test/.test(String(i.command)) && !fixed ? { content: 'FAIL src/a.test.js\n1 failed, 3 passed\nexit code: 1', is_error: true } : { content: '4 passed\nexit code: 0' };
    },
  });
}

test('signals: repeated calls and errors, reverts, test thrash, progress markers', () => {
  const t = new ProgressTracker();
  t.record(1, [{ name: 'write', input: { path: 'a.js', content: 'v1' }, writes: 'a.js', content: 'ok', isError: false }], []);
  t.record(2, [{ name: 'write', input: { path: 'a.js', content: 'v2' }, writes: 'a.js', content: 'ok', isError: false }], []);
  t.record(3, [{ name: 'write', input: { path: 'a.js', content: 'v1' }, writes: 'a.js', content: 'ok', isError: false }], []);
  for (let i = 4; i < 10; i++) t.record(i, [{ name: 'read', input: { path: `missing-${i}.txt` }, content: `File does not exist: missing-${i}.txt`, isError: true }], []);
  for (let i = 10; i < 14; i++) t.record(i, [{ name: 'bash', input: { command: 'npm test 2>&1 | tail -20' }, content: '1 failed', isError: true }], []);
  const s = t.signals();
  assert.equal(s.reverts, 1, 'a write back to the content of two writes ago');
  assert.equal(s.repeatedError.count, 6, 'the same error once numbers are flattened');
  assert.equal(s.testThrash.count, 4);
  assert.equal(s.testThrash.command, 'npm test', 'output trimming does not make another command');
  assert.equal(s.failingStreak.count, 4);
  assert.equal(s.filesChanged, 1);
  assert.equal(assess(s).health, 'bad');
  assert.equal(normalizeError('Error: line 12 in "foo.js" at 0xff'), 'Error: line # in "…" at #');
  const nudges = t.takeNudges();
  assert.equal(nudges.filter((n) => /without changing anything/.test(n)).length, 1, 'once per pattern');
  assert.ok(nudges.some((n) => /failed 4 times in a row/.test(n)));
  assert.deepEqual(t.takeNudges(), []);
  // Settings from JSON and the environment.
  assert.equal(cleanProgressReview(false, pr())!.enabled, false);
  assert.equal(cleanProgressReview({ extendBy: 30, ceiling: 0 }, pr())!.extendBy, 30);
  assert.equal(cleanProgressReview({ ceiling: 0 }, pr())!.ceiling, 600, 'a ceiling of 0 is ignored');
  assert.equal(defaultProgressReview({ HARNESS_PROGRESS_REVIEW: 'off' }).enabled, false);
  assert.equal(defaultProgressReview({ HARNESS_STEP_CEILING: '300' }).ceiling, 300);
  assert.equal(parseVerdict('sure: {"verdict":"maybe"}'), undefined);
  assert.equal(parseVerdict('```json\n{"verdict":"refresh","issues":["x"]}\n```')!.verdict, 'refresh');
});

test('on track at the budget: extended by a block without a model call, to the real end of the task', async () => {
  const h = await setup((n) => (n <= 25 ? { calls: [{ name: 'write', input: { path: `f${n}.txt`, content: `file ${n}\n` } }] } : { text: 'Wrote all 25 files.' }), { maxSteps: 10 });
  assert.equal(await h.agent.run(ac()), 'done');
  assert.equal(await fs.readFile(path.join(h.root, 'f25.txt'), 'utf8'), 'file 25\n');
  const ext = h.progress().filter((e) => e.phase === 'extended');
  assert.deepEqual(ext.map((e) => [e.step, e.budget, e.by]), [[10, 20, 'signals'], [20, 30, 'signals']], 'a sub-budget block: the smaller of extendBy and maxSteps');
  assert.match(ext[0]!.text, /Checked progress at 10 steps: on track, extended to 20/);
  assert.equal(h.p.reviews.length, 0, 'clearly fine costs nothing');
  assert.ok(!h.events.some((e) => e.kind === 'notice' && /Stopped after/.test(e.text)));
});

test('a repetition loop is reviewed and stopped with a clear message', async () => {
  const h = await setup(() => ({ calls: [{ name: 'glob', input: { pattern: 'src/**/*.zz' } }] }), {
    maxSteps: 8, reviewer: verdict({ verdict: 'stop', issues: ['it searches for the same files again and again'], advice: 'Ask the person where the sources are.', done: 'Nothing yet.' }),
  });
  assert.equal(await h.agent.run(ac()), 'max_steps');
  assert.equal(h.p.main.length, 8);
  assert.equal(h.p.reviews.length, 1);
  const rv = h.p.reviews[0]!;
  assert.deepEqual(rv.tools, [], 'the reviewer is a plain request: no tools');
  assert.equal(rv.messages.length, 1, 'outside the transcript');
  const input = textOf(rv.messages[0]);
  assert.match(input, /<request>\nthe task/);
  assert.match(input, /<recent_steps>[\s\S]*#8 glob/);
  assert.ok(input.length < 30_000, 'a capped digest');
  assert.ok(rv.model.maxOutput <= 1200, 'a capped answer');
  const phases = h.progress().map((e) => e.phase);
  assert.deepEqual(phases, ['checkpoint', 'stopped']);
  const stop = h.progress().at(-1)!;
  assert.equal(stop.by, 'review');
  assert.match(stop.text, /^Stopped at 8 steps: the progress review found it stuck\.\nDone so far: Nothing yet\.\nStuck on: it searches for the same files again and again\.\nReviewer's advice: Ask the person/);
  assert.ok(!h.events.some((e) => e.kind === 'notice' && /Send a message to continue/.test(e.text)), 'not a bare "send a message"');
});

test('error thrash: a fresh start from a handoff, then the task completes', async () => {
  let refreshed = false;
  const h = await setup((n, req) => {
    if (!refreshed && textOf(req.messages[0]).includes('fresh context after a progress review')) refreshed = true;
    if (!refreshed) return { calls: [{ name: 'read', input: { path: `missing-${n}.txt` } }] };
    return req.messages.length < 3 ? { calls: [{ name: 'write', input: { path: 'out.txt', content: 'ok\n' } }] } : { text: 'Wrote out.txt.' };
  }, { maxSteps: 6, reviewer: verdict({ verdict: 'refresh', issues: ['reads files that do not exist'], advice: 'Create out.txt instead of looking for inputs.' }) });
  assert.equal(await h.agent.run(ac()), 'done');
  assert.equal(await fs.readFile(path.join(h.root, 'out.txt'), 'utf8'), 'ok\n');
  assert.deepEqual(h.progress().map((e) => e.phase), ['checkpoint', 'refreshed']);
  assert.equal(h.p.compactions.length, 1);
  assert.match(textOf(h.p.compactions[0]!.messages.at(-1)), /What is truly done, with the evidence/, 'the handoff prompt, not the compaction one');
  const first = h.agent.messages[0]!;
  assert.equal(first.compactionSummary, true);
  assert.match(textOf(first), /Requirements: write the files[\s\S]*the previous approach was not working \(reads files that do not exist\)[\s\S]*Advice: Create out.txt/);
  assert.ok(h.events.some((e) => e.kind === 'compaction'));
});

test('a fresh start that makes no progress stops', async () => {
  const h = await setup((n) => ({ calls: [{ name: 'read', input: { path: `missing-${n}.txt` } }] }), { maxSteps: 5, reviewer: verdict({ verdict: 'refresh', issues: ['missing files'] }) });
  assert.equal(await h.agent.run(ac()), 'max_steps');
  assert.equal(h.p.main.length, 10, 'the restart got one block');
  assert.equal(h.p.reviews.length, 1, 'the second checkpoint needs no review');
  const stop = h.progress().at(-1)!;
  assert.equal(stop.phase, 'stopped');
  assert.match(stop.text, /^Stopped at 10 steps: a fresh start made no progress\./);
});

test('without a reviewer, bad signals refresh once and then stop', async () => {
  const h = await setup((n) => ({ calls: [{ name: 'read', input: { path: `missing-${n}.txt` } }] }), { maxSteps: 5, review: { reviewer: false } });
  assert.equal(await h.agent.run(ac()), 'max_steps');
  assert.equal(h.p.reviews.length, 0);
  assert.deepEqual(h.progress().map((e) => [e.phase, e.by]), [['refreshed', 'signals'], ['stopped', 'signals']]);
});

test('test thrash: one short reminder per pattern, appended after the results', async () => {
  const root = await tempDir();
  const tools = [...BUILTIN_TOOLS.filter((t) => t.spec.name !== 'bash'), fakeBash(root)];
  const h = await setup((n) => (n <= 4 ? { calls: [{ name: 'bash', input: { command: 'npm test' } }] } : n === 5 ? { calls: [{ name: 'write', input: { path: 'fixed.txt', content: 'x' } }] } : n === 6 ? { calls: [{ name: 'bash', input: { command: 'npm test' } }] } : { text: 'Fixed; the tests pass.' }), { maxSteps: 20, tools });
  h.agent.cfg = { ...h.agent.cfg, host: new (await import('../src/runtime/host.ts')).LocalHost(root) };
  assert.equal(await h.agent.run(ac()), 'done');
  const reminders = h.agent.messages.filter((m) => m.role === 'user').map(textOf);
  const thrash = reminders.filter((t) => /You have run `npm test` 3 times without changing anything in between/.test(t));
  assert.equal(thrash.length, 1, 'once');
  assert.ok(reminders.findIndex((t) => thrash.includes(t)) === 3, 'after the third run');
  const nudges = h.progress().filter((e) => e.phase === 'nudge');
  assert.ok(nudges.length >= 1 && nudges.length <= 2, nudges.map((x) => x.text).join(' | '));
  assert.ok(!h.progress().some((e) => e.phase === 'flagged'), 'the tests pass at the end: no flag');
});

test('a "done" that the last check contradicts is flagged (by the reviewer, or from the signals)', async () => {
  const root = await tempDir();
  const tools = [...BUILTIN_TOOLS.filter((t) => t.spec.name !== 'bash'), fakeBash(root)];
  const script = (n: number): Reply => (n === 1 ? { calls: [{ name: 'bash', input: { command: 'npm test' } }] } : { text: 'Done: all tests pass.' });
  const { LocalHost } = await import('../src/runtime/host.ts');
  const h = await setup(script, { maxSteps: 20, tools, reviewer: verdict({ verdict: 'stop', falseClaims: ['"all tests pass", but npm test failed (1 failed)'] }) });
  h.agent.cfg = { ...h.agent.cfg, host: new LocalHost(root) };
  assert.equal(await h.agent.run(ac()), 'done');
  assert.equal(h.p.reviews.length, 1);
  assert.match(textOf(h.p.reviews[0]!.messages[0]), /The agent says it has finished/);
  const flag = h.progress().find((e) => e.phase === 'flagged')!;
  assert.equal(flag.by, 'review');
  assert.match(flag.text, /claims success that the recent steps do not support \(the last check \(`npm test`\) failed\): "all tests pass", but npm test failed/);
  // A reviewer that finds the claim fine: nothing shown.
  const ok = await setup(script, { maxSteps: 20, tools, reviewer: verdict({ verdict: 'continue', falseClaims: [] }) });
  ok.agent.cfg = { ...ok.agent.cfg, host: new LocalHost(root) };
  await ok.agent.run(ac());
  assert.ok(!ok.progress().some((e) => e.phase === 'flagged'));
  // No reviewer: the signals alone.
  const plain = await setup(script, { maxSteps: 20, tools, review: { reviewer: false } });
  plain.agent.cfg = { ...plain.agent.cfg, host: new LocalHost(root) };
  await plain.agent.run(ac());
  assert.equal(plain.p.reviews.length, 0);
  assert.equal(plain.progress().find((e) => e.phase === 'flagged')?.by, 'signals');
  // A final message that claims nothing is not checked.
  const quiet = await setup((n) => (n === 1 ? { calls: [{ name: 'bash', input: { command: 'npm test' } }] } : { text: 'One test fails; I need the fixture to go on.' }), { maxSteps: 20, tools });
  quiet.agent.cfg = { ...quiet.agent.cfg, host: new LocalHost(root) };
  await quiet.agent.run(ac());
  assert.equal(quiet.p.reviews.length, 0);
});

test('ceilings: extensions per turn, and the absolute step ceiling', async () => {
  const writes = (n: number): Reply => ({ calls: [{ name: 'write', input: { path: `f${n}.txt`, content: `${n}` } }] });
  const a = await setup(writes, { maxSteps: 5, review: { maxExtensions: 2 } });
  assert.equal(await a.agent.run(ac()), 'max_steps');
  assert.equal(a.p.main.length, 15);
  assert.match(a.progress().at(-1)!.text, /^Stopped at 15 steps: it used all 2 extension\(s\) of this turn\.\nDone so far: 15 file\(s\) changed/);
  assert.equal(a.progress().at(-1)!.reasons.length, 0, 'on track: nothing to be stuck on');
  const b = await setup(writes, { maxSteps: 5, review: { ceiling: 12 } });
  assert.equal(await b.agent.run(ac()), 'max_steps');
  assert.equal(b.p.main.length, 12);
  assert.deepEqual(b.progress().map((e) => [e.phase, e.budget]), [['extended', 10], ['extended', 12], ['stopped', 12]]);
  assert.match(b.progress().at(-1)!.text, /the step ceiling \(12\)/);
  // The cost cap still applies first.
  const c = await setup(writes, { maxSteps: 5 });
  let calls = 0;
  c.agent.hooks.overBudget = () => (++calls > 7 ? 'Stopped: the spend limit.' : undefined);
  assert.equal(await c.agent.run(ac()), 'budget');
});

test('progressReview off: the old hard stop at maxSteps', async () => {
  const h = await setup((n) => ({ calls: [{ name: 'write', input: { path: `f${n}.txt`, content: `${n}` } }] }), { maxSteps: 5, review: false });
  assert.equal(await h.agent.run(ac()), 'max_steps');
  assert.equal(h.p.main.length, 5);
  assert.equal(h.progress().length, 0);
  assert.ok(h.events.some((e) => e.kind === 'notice' && e.text === 'Stopped after 5 steps. Send a message to continue.'));
});

test('a review\'s advice is appended to the step\'s results: the cached prefix never changes', async () => {
  const h = await setup((n) => (n <= 6 ? { calls: [{ name: 'read', input: { path: `missing-${n}.txt` } }] } : n === 7 ? { calls: [{ name: 'write', input: { path: 'a.txt', content: 'a' } }] } : { text: 'Wrote a.txt.' }), {
    maxSteps: 6, reviewer: verdict({ verdict: 'continue', onTrack: true, advice: 'Stop looking for inputs; write a.txt.', extendSteps: 4 }),
  });
  assert.equal(await h.agent.run(ac()), 'done');
  const ext = h.progress().find((e) => e.phase === 'extended')!;
  assert.equal(ext.budget, 10, 'the reviewer asked for 4 more steps');
  assert.equal(ext.by, 'review');
  // The advice rides in the same message as step 6's results (append-only, alternating roles).
  const sixth = h.agent.messages[12]!;
  assert.equal(sixth.role, 'user');
  assert.ok(sixth.content.some((b) => b.type === 'tool_result'));
  assert.match(textOf(sixth), /<system-reminder>Progress review at step 6: Stop looking for inputs; write a.txt.<\/system-reminder>/);
  for (let i = 1; i < h.p.snapshots.length; i++) {
    const prev = JSON.parse(h.p.snapshots[i - 1]!) as unknown[];
    assert.deepEqual((JSON.parse(h.p.snapshots[i]!) as unknown[]).slice(0, prev.length), prev, `request ${i} rewrote earlier history`);
  }
  assert.equal(new Set(h.p.main.map((r) => r.system + JSON.stringify(r.tools))).size, 1, 'system prompt and tools unchanged');
  assert.notEqual(h.p.reviews[0]!.cacheKey, h.p.main[0]!.cacheKey, 'the review does not touch the session\'s cache');
});

test('a soft checkpoint reviews bad signals early', async () => {
  const h = await setup((n) => (n <= 10 ? { calls: [{ name: 'read', input: { path: `missing-${n}.txt` } }] } : n === 11 ? { calls: [{ name: 'write', input: { path: 'a.txt', content: 'a' } }] } : { text: 'Wrote a.txt.' }), {
    maxSteps: 100, review: { softEvery: 10 }, reviewer: verdict({ verdict: 'continue', advice: 'The inputs do not exist; write a.txt.' }),
  });
  assert.equal(await h.agent.run(ac()), 'done');
  assert.deepEqual(h.progress().map((e) => [e.phase, e.step]), [['checkpoint', 10], ['nudge', 10]]);
  assert.match(textOf(h.agent.messages[20]), /Progress review at step 10: The inputs do not exist/);
});

test('evals run with progress review: extensions are in the results and the report', async () => {
  const root = await tempDir();
  const dir = path.join(root, 'evals', 'demo', 'three');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'eval.json'), JSON.stringify({ name: 'three', prompt: 'Write a.txt, b.txt and c.txt', checks: [{ name: 'third file', files: ['c.txt'] }] }));
  const out = path.join(root, 'out');
  await fs.mkdir(out);
  const steps = [...['a', 'b', 'c'].map((f) => ({ calls: [{ name: 'write', input: { path: `${f}.txt`, content: f } }] })), { text: 'Wrote the three files.' }];
  const runs = await runEvals({
    cases: await loadCases(path.join(root, 'evals')), models: ['deepseek-flash'], repeats: 1, out, concurrency: 1, plugins: [],
    configs: [{ name: 'short', settings: { maxSteps: 2 } }],
    setup: (h) => h.registry.setProviderInstance('deepseek', new FakeProvider(steps)),
  });
  assert.equal(runs[0]!.pass, true, 'past the step budget to the real end');
  assert.deepEqual(runs[0]!.progress, { extensions: 1, refreshes: 0, reviews: 0, stops: 0, flags: 0 });
  assert.match(await fs.readFile(path.join(out, 'report.md'), 'utf8'), /## Progress reviews\n\n- demo\/three deepseek-flash \[short\] #1: 1 extension\(s\), 0 fresh start\(s\), 0 model review\(s\)/);
});

test('the timeline: a review in flight is replaced by its outcome, drawn as a row of its own; a sub-agent\'s routine ones stay out', () => {
  let l: Live = { items: [], contextTokens: 0, contextWindow: 0 };
  const ev = (phase: 'checkpoint' | 'stopped' | 'extended', agent = 'main') => ({ kind: 'progress' as const, phase, step: 150, budget: 150, by: 'review' as const, text: phase === 'stopped' ? 'Stopped at 150 steps: stuck.\nDone so far: a.\nStuck on: b.' : 'Reviewing', reasons: ['b'], agent });
  l = apply(l, ev('checkpoint'));
  assert.equal(l.items.length, 1);
  l = apply(l, ev('stopped'));
  assert.equal(l.items.length, 1, 'replaced in place');
  assert.equal((l.items[0] as { phase: string }).phase, 'stopped');
  l = apply(l, ev('extended', 'general-1'));
  assert.equal(l.items.length, 1, "a sub-agent's extension stays in its card");
  l = apply(l, ev('stopped', 'general-1'));
  assert.equal((l.items[1] as { agent?: string }).agent, 'general-1');
  assert.ok(toRows([{ kind: 'user', key: 'u', text: 'go' }, ...l.items], false).filter((r) => r.kind === 'item' && r.item.kind === 'progress').length === 2, 'own rows, outside the folded steps');
});

test('a sub-agent has its own budget: extended by its own block', async () => {
  const h = await setup((n) => (n <= 6 ? { calls: [{ name: 'write', input: { path: `s${n}.txt`, content: `${n}` } }] } : { text: 'Report: 6 files.' }), { maxSteps: 4, name: 'general-1' });
  assert.equal(await h.agent.run(ac()), 'done');
  assert.deepEqual(h.progress().map((e) => [e.phase, e.step, e.budget, e.agent]), [['extended', 4, 8, 'general-1']]);
});

test('in a session: a sub-agent past its budget carries on, and its extension is attributed to it', async () => {
  const saved = { s: process.env.HARNESS_MAX_STEPS };
  process.env.HARNESS_MAX_STEPS = '3';
  const h = await createHarness({ dataDir: await tempDir(), search: null, memory: 'off' });
  let main = 0;
  let sub = 0;
  h.registry.setProviderInstance('deepseek', {
    async send(req: ProviderRequest): Promise<ProviderResponse> {
      const isSub = /<brief>/.test(textOf(req.messages[0]));
      let content: Block[];
      if (isSub) content = ++sub <= 5 ? [{ type: 'tool_use', id: `s${sub}`, name: 'write', input: { path: `sub${sub}.txt`, content: 'x' } }] : [{ type: 'text', text: 'Wrote 5 files.' }];
      else content = ++main === 1 ? [{ type: 'tool_use', id: 'm1', name: 'agent', input: { description: 'write files', prompt: 'write five files', type: 'general' } }] : [{ type: 'text', text: 'done' }];
      return { message: { role: 'assistant', content, raw: { provider: 'deepseek', model: req.model.id, payload: {} } }, stop: content[0]!.type === 'tool_use' ? 'tool_use' : 'end', usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0 } };
    },
  });
  try {
    const ws = await tempDir();
    const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws } });
    const events: HarnessEvent[] = [];
    const done = new Promise<void>((r) => s.subscribe(0, ({ event }) => { events.push(event); if (event.kind === 'turn_end' && !event.agent) r(); }));
    await s.send('go');
    await done;
    assert.equal(await fs.readFile(path.join(ws, 'sub5.txt'), 'utf8'), 'x');
    const p = events.filter((e): e is Extract<HarnessEvent, { kind: 'progress' }> => e.kind === 'progress');
    assert.deepEqual(p.map((e) => [e.phase, e.agent, e.budget]), [['extended', 'general-1', 6]]);
    assert.ok(events.some((e) => e.kind === 'turn_end' && e.agent === 'general-1' && e.reason === 'done'));
  } finally {
    if (saved.s === undefined) delete process.env.HARNESS_MAX_STEPS; else process.env.HARNESS_MAX_STEPS = saved.s;
    await h.close();
  }
});
