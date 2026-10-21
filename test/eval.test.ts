import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { loadCases, runEvals } from '../src/eval/runner.ts';
import { FakeProvider, tempDir } from './helpers.ts';

test('evaluation: cases run per model and repeat; hidden checks judge them; the report names what failed', async () => {
  const root = await tempDir();
  const dir = path.join(root, 'evals', 'demo', 'hello');
  await fs.mkdir(path.join(dir, 'fixtures'), { recursive: true });
  await fs.writeFile(path.join(dir, 'fixtures', 'input.txt'), 'world');
  await fs.writeFile(path.join(dir, 'eval.json'), JSON.stringify({
    name: 'hello', prompt: 'Write greeting.txt saying hello to the name in input.txt', fixtures: 'fixtures',
    checks: [
      { name: 'file written', files: ['greeting.txt'] },
      { name: 'right greeting', run: 'grep -q "hello world" greeting.txt' },
      { name: 'hidden: shouts', run: 'grep -q "HELLO" greeting.txt' },
    ],
  }));
  const cases = await loadCases(path.join(root, 'evals'));
  assert.equal(cases.length, 1);
  const out = path.join(root, 'out');
  await fs.mkdir(out);
  const runs = await runEvals({
    cases, models: ['deepseek-flash'], repeats: 2, out, concurrency: 2, plugins: [],
    setup: (h) => h.registry.setProviderInstance('deepseek', new FakeProvider([
      { calls: [{ name: 'write', input: { path: 'greeting.txt', content: 'hello world\n' } }] }, { text: 'Done.' },
    ])),
  });
  assert.equal(runs.length, 2);
  for (const r of runs) {
    assert.equal(r.status, 'done');
    assert.deepEqual(r.checks.map((c) => c.pass), [true, true, false]);
    assert.equal(r.pass, false);
    assert.equal(r.modelCalls, 2);
  }
  const report = await fs.readFile(path.join(out, 'report.md'), 'utf8');
  // The harness is named with the numbers: a score belongs to a model and a harness together.
  assert.match(report, /- harness: harness-web \d/);
  assert.match(report, /- commit: [0-9a-f]{7}/);
  assert.match(report, /- settings: maxSteps \d+/);
  assert.match(report, /- platform: \w+ \w+, Node \d/);
  assert.equal(JSON.parse(await fs.readFile(path.join(out, 'results.json'), 'utf8')).harness.harness, report.match(/- harness: (.*)/)![1]);
  // The pass rate carries its 95% interval: 0 of 2 is not "certainly 0%".
  assert.match(report, /\| demo\/hello \| deepseek-flash \| 0\/2 \| 0%-66% \| 4\/6 \| \$0\.000 \|/);
  assert.match(report, /hidden: shouts: exit 1/);
  await assert.rejects(fs.writeFile(path.join(dir, 'eval.json'), '{"name":"x","checks":[]}').then(() => loadCases(path.join(root, 'evals'))), /needs "workflow" or "prompt"/);
});

test('checks run on Windows too: case and workspace paths reach the shell with forward slashes, quoted', async () => {
  const root = await tempDir('hw test spaces ');
  const dir = path.join(root, 'evals', 'demo', 'paths');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'check.mjs'), "import fs from 'node:fs'; process.exit(fs.existsSync(process.argv[2] + '/x.txt') ? 0 : 1);");
  await fs.writeFile(path.join(dir, 'eval.json'), JSON.stringify({ name: 'paths', prompt: 'x', checks: [{ name: 'own checker', run: 'node {{case}}/check.mjs {{ws}}' }] }));
  const [c] = await loadCases(path.join(root, 'evals'));
  const ws = path.join(root, 'work space');
  await fs.mkdir(ws);
  await fs.writeFile(path.join(ws, 'x.txt'), 'x');
  const { createHarness } = await import('../src/kernel/harness.ts');
  const { runChecks } = await import('../src/eval/runner.ts');
  const h = await createHarness({ dataDir: await tempDir(), search: null, memory: 'off', scheduler: false });
  try {
    const [r] = await runChecks(h, c!, ws, new AbortController().signal);
    assert.equal(r!.pass, true, r!.detail);
    // The same check under PowerShell (Windows without Git Bash): the path and its suffix stay one argument.
    if (process.platform === 'win32') {
      const saved = process.env.HARNESS_SHELL;
      process.env.HARNESS_SHELL = 'powershell';
      try {
        const [p] = await runChecks(h, c!, ws, new AbortController().signal);
        assert.equal(p!.pass, true, p!.detail);
      } finally { if (saved === undefined) delete process.env.HARNESS_SHELL; else process.env.HARNESS_SHELL = saved; }
    }
  } finally { await h.close(); }
});

test('the 95% Wilson interval for a pass rate', async () => {
  const { wilson } = await import('../src/eval/runner.ts');
  const r = (k: number, n: number) => wilson(k, n).map((x) => Math.round(x * 1000) / 1000);
  assert.deepEqual(r(5, 10), [0.237, 0.763]);
  assert.deepEqual(r(0, 2), [0, 0.658]);
  assert.deepEqual(r(2, 2), [0.342, 1]);
  assert.deepEqual(r(0, 0), [0, 1], 'no runs: anything is possible');
});

test('the report shows spread over repeats, not only medians', async () => {
  const { report } = await import('../src/eval/runner.ts');
  const run = (cost: number, seconds: number, pass: boolean) => ({ pack: 'p', case: 'c', model: 'm', repeat: 1, status: 'done', pass, checks: [{ name: 'x', pass, detail: '' }], cost, inputTokens: 0, cacheHit: 0.5, output: 0, modelCalls: 4, toolCalls: 0, seconds, workspace: '' });
  const md = report([run(0.01, 30, true), run(0.05, 300, false), run(0.02, 60, true)]);
  assert.match(md, /\| p\/c \| m \| 2\/3 \| 21%-94% \| 2\/3 \| \$0\.020 \(\$0\.010-\$0\.050\) \| 60s \(30s-5 min\) \| 50% \| 4 \|/);
  assert.match(md, /Cells over repeats read median \(min-max\)/);
  assert.doesNotMatch(md, /Config|Δ/, 'no configuration columns without configurations');
});

test('harness configurations are checked, with the field named', async () => {
  const { parseConfigs, parseInlineConfig, describeConfig } = await import('../src/eval/runner.ts');
  assert.throws(() => parseConfigs([]), /expected a list of configurations/);
  assert.throws(() => parseConfigs([{ name: 'a' }, { name: 'a' }]), /config "a" appears twice/);
  assert.throws(() => parseConfigs([{ name: 'a', compactAt: 5 }]), /config "a": unknown field\(s\) compactAt/);
  assert.throws(() => parseConfigs({ configs: [{ name: 'a', settings: { permissions: {} } }] }), /settings\.permissions is not a setting a configuration can change/);
  assert.throws(() => parseConfigs([{ name: 'a', settings: { maxSteps: '5' } }]), /settings\.maxSteps must be a number/);
  assert.throws(() => parseConfigs([{ name: 'a', env: { PATH: '/x' } }]), /env\.PATH: only HARNESS_\* variables/);
  assert.throws(() => parseConfigs([{ name: 'a', memory: 'maybe' }]), /memory must be on, read or off/);
  assert.deepEqual(parseInlineConfig('nocode={"codeMode":false}'), { codeMode: false, name: 'nocode' });
  assert.deepEqual(parseInlineConfig('baseline'), { name: 'baseline' });
  assert.throws(() => parseInlineConfig('x={oops'), /--config x: the part after = must be a JSON object/);
  const shipped = parseConfigs(JSON.parse(await fs.readFile(path.join(import.meta.dirname, '..', 'evals', 'ablations.json'), 'utf8')));
  assert.equal(shipped[0]!.name, 'baseline');
  assert.equal(describeConfig({ name: 'x', settings: { compactAt: 60000 }, codeMode: false, plugins: ['sdlc'], memory: 'off', injectionScan: true }), 'compactAt 60000, code mode off, plugins sdlc, injection scan on, memory off');
});

test('ablation: the same model under several harness configurations; each is a row with its delta against the baseline', async () => {
  const root = await tempDir();
  const dir = path.join(root, 'evals', 'demo', 'two');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'eval.json'), JSON.stringify({ name: 'two', prompt: 'Write a.txt, then b.txt', checks: [{ name: 'second file', files: ['b.txt'] }] }));
  const cases = await loadCases(path.join(root, 'evals'));
  const out = path.join(root, 'out');
  await fs.mkdir(out);
  const tools: Record<string, boolean> = {};
  const before = process.env.HARNESS_SETTINGS;
  const runs = await runEvals({
    cases, models: ['deepseek-flash'], repeats: 2, out, concurrency: 2, plugins: [],
    configs: [{ name: 'baseline' }, { name: 'tight', settings: { maxSteps: 1 }, codeMode: false }],
    setup: (h, config) => {
      tools[config!.name] = h.registry.tools.has('run_script');
      h.registry.setProviderInstance('deepseek', new FakeProvider([
        { calls: [{ name: 'write', input: { path: 'a.txt', content: 'a' } }] },
        { calls: [{ name: 'write', input: { path: 'b.txt', content: 'b' } }] },
        { text: 'Done.' },
      ]));
    },
  });
  assert.deepEqual(runs.map((r) => `${r.config}:${r.pass}:${r.modelCalls}`), ['baseline:true:3', 'baseline:true:3', 'tight:false:1', 'tight:false:1'], 'the settings reached the loop');
  assert.deepEqual(tools, { baseline: true, tight: false }, 'code mode off takes run_script out');
  assert.equal(process.env.HARNESS_SETTINGS, before, 'the environment is put back');
  const report = await fs.readFile(path.join(out, 'report.md'), 'utf8');
  assert.match(report, /- config baseline: \(baseline\) harness defaults/);
  assert.match(report, /- config tight: maxSteps 1, code mode off/);
  assert.match(report, /\| Case \| Model \| Config \| Pass \| 95% CI \|.*\| Δ pass \| Δ cost \|/);
  assert.match(report, /\| demo\/two \| deepseek-flash \| baseline \| 2\/2 \| 34%-100% \|.*\| baseline \| baseline \|/);
  assert.match(report, /\| demo\/two \| deepseek-flash \| tight \| 0\/2 \| 0%-66% \|.*\| -100 pp \| -\$0\.\d{3} \|/);
  assert.match(report, /## Harness configurations[\s\S]*\| deepseek-flash \| baseline \| 2\/2 \|[\s\S]*\| deepseek-flash \| tight \| 0\/2 \| 0%-66% \| -100 pp \|/);
  assert.match(report, /\*\*demo\/two deepseek-flash \[tight\] #1\*\*/);
  const results = JSON.parse(await fs.readFile(path.join(out, 'results.json'), 'utf8'));
  assert.deepEqual(results.configs.map((c: { name: string }) => c.name), ['baseline', 'tight']);
  // Judged again, the baseline stays the baseline.
  const { rejudge } = await import('../src/eval/runner.ts');
  await rejudge(out, cases, { plugins: [] });
  assert.match(await fs.readFile(path.join(out, 'report.md'), 'utf8'), /\| tight \| 0\/2 \| 0%-66% \|.*\| -100 pp \|/);
});
