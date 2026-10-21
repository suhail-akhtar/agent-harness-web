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
  assert.match(report, /\| demo\/hello \| deepseek-flash \| 0\/2 \| 4\/6 \|/);
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
  } finally { await h.close(); }
});
