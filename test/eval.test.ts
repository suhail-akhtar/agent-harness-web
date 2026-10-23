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

test('a case\'s setup runs before the agent (a failure skips the run) and its teardown after the checks', async () => {
  const root = await tempDir();
  const dir = path.join(root, 'evals', 'demo', 'env');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'step.mjs'), "import fs from 'node:fs'; import path from 'node:path'; const [what, ws] = process.argv.slice(2); if (what === 'fail') { console.log('no docker here'); process.exit(3); } fs.appendFileSync(path.join(ws, '..', 'steps.log'), what + '\\n');");
  await fs.writeFile(path.join(dir, 'eval.json'), JSON.stringify({
    name: 'env', prompt: 'x', setup: 'node {{case}}/step.mjs setup {{ws}}', teardown: 'node {{case}}/step.mjs teardown {{ws}}',
    checks: [{ name: 'setup ran first', run: 'node -e "process.exit(require(\'fs\').readFileSync(\'../steps.log\',\'utf8\')===\'setup\\n\'?0:1)"' }],
  }));
  const out = path.join(root, 'out');
  await fs.mkdir(out);
  const fake = () => new FakeProvider([{ text: 'Done.' }]);
  const [ok] = await runEvals({ cases: await loadCases(path.join(root, 'evals')), models: ['deepseek-flash'], repeats: 1, out, concurrency: 1, plugins: [], setup: (h) => h.registry.setProviderInstance('deepseek', fake()) });
  assert.equal(ok!.pass, true, JSON.stringify(ok!.checks));
  assert.equal(await fs.readFile(path.join(ok!.workspace, '..', 'steps.log'), 'utf8'), 'setup\nteardown\n');
  await fs.writeFile(path.join(dir, 'eval.json'), JSON.stringify({ name: 'env', prompt: 'x', setup: 'node {{case}}/step.mjs fail {{ws}}', checks: [{ name: 'c', files: ['x'] }] }));
  const out2 = path.join(root, 'out2');
  await fs.mkdir(out2);
  const model = fake();
  const [bad] = await runEvals({ cases: await loadCases(path.join(root, 'evals')), models: ['deepseek-flash'], repeats: 1, out: out2, concurrency: 1, plugins: [], setup: (h) => h.registry.setProviderInstance('deepseek', model) });
  assert.equal(bad!.status, 'setup-failed');
  assert.equal(bad!.pass, false);
  assert.match(bad!.error!, /setup exited 3: no docker here/);
  assert.equal(model.requests.length, 0, 'the agent never ran');
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

test('a run the provider stopped (credits, a key, an outage) is listed as not scored, never counted as the model failing', async () => {
  const { providerProblem, report } = await import('../src/eval/runner.ts');
  assert.match(providerProblem(['build failed: You have no credits remaining. Add credits to continue using the API']) ?? '', /no credits/);
  assert.ok(providerProblem(['Error: 401 invalid api key']));
  assert.ok(providerProblem(['upstream 529 overloaded']));
  assert.equal(providerProblem(['build failed: tests did not pass', 'gate python-test failed']), undefined, 'an ordinary failure is the agent\'s');
  const base = { pack: 'p', case: 'c', model: 'm', checks: [], cost: 0.01, inputTokens: 1, cacheHit: 0, output: 1, modelCalls: 1, toolCalls: 1, seconds: 1, workspace: '/w' };
  const md = report([
    { ...base, repeat: 1, status: 'succeeded', pass: true },
    { ...base, repeat: 2, status: 'provider-error', pass: false, unscored: true, error: 'You have no credits remaining' },
  ]);
  assert.match(md, /1 run\(s\) scored, 1 not scored/);
  assert.match(md, /\| p\/c \| m \| 1\/1 \|/, 'the pass rate counts only scored runs');
  assert.match(md, /## Not scored[\s\S]*#2: You have no credits remaining/);
});

test('a run the machine slept through is seen (timers do not count suspended time) and so not scored', async () => {
  const { pauseWatch } = await import('../src/eval/runner.ts');
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  try {
    const awake = pauseWatch(20, 200);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(awake(), 0, 'an ordinary run has no pause');
    const slept = pauseWatch(20, 200);
    await new Promise((r) => setTimeout(r, 50));
    skew = 3 * 3_600_000; // the lid closed for three hours
    await new Promise((r) => setTimeout(r, 50));
    const ms = slept();
    assert.ok(ms > 2.9 * 3_600_000 && ms < 3 * 3_600_000 + 1_000, String(ms));
    assert.equal(slept(), ms, 'asking again changes nothing');
  } finally { Date.now = realNow; }
});

test('the web-console gate asked for by name where there is no page fails with a reason instead of crashing', async () => {
  const { runGates } = await import('../src/gates/gates.ts');
  const { createHarness } = await import('../src/kernel/harness.ts');
  const { LocalHost } = await import('../src/runtime/host.ts');
  const { fileURLToPath } = await import('node:url');
  const h = await createHarness({ dataDir: await tempDir(), search: null, memory: 'off', scheduler: false, plugins: [fileURLToPath(new URL('../plugins/visual', import.meta.url))] });
  try {
    const [g] = await runGates(h.registry, new LocalHost(await tempDir()), ['web-console'], new AbortController().signal);
    assert.equal(g!.pass, false);
    assert.match(g!.summary, /no index\.html/);
  } finally { await h.close(); }
});

test('an eval run cannot fetch its own hidden checks: the repository\'s GitHub URLs are refused by web_fetch, and the results say so', async () => {
  const saved = process.env.HARNESS_EVAL_DENY_HOSTS;
  delete process.env.HARNESS_EVAL_DENY_HOSTS;
  try {
    const root = await tempDir();
    const dir = path.join(root, 'evals', 'demo', 'peek');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'eval.json'), JSON.stringify({ name: 'peek', prompt: 'x', checks: [{ name: 'hidden', run: 'exit 0' }] }));
    const cases = await loadCases(path.join(root, 'evals'));
    const out = path.join(root, 'out');
    await fs.mkdir(out);
    // The repository is public: the case's checks are one download away. Refused before any request is made.
    const urls = [
      'https://raw.githubusercontent.com/suhail-akhtar/agent-harness-web/main/evals/demo/peek/eval.json',
      'https://github.com/Suhail-Akhtar/Agent-Harness-Web/blob/main/evals/demo/peek/eval.json',
      'https://codeload.github.com/suhail-akhtar/agent-harness-web/zip/refs/heads/main',
      'https://api.github.com/repos/suhail-akhtar/agent-harness-web/contents/evals',
    ];
    const p = new FakeProvider([{ calls: urls.map((url) => ({ name: 'web_fetch', input: { url } })) }, { text: 'Done.' }]);
    await runEvals({ cases, models: ['deepseek-flash'], repeats: 1, out, concurrency: 1, plugins: [], setup: (h) => h.registry.setProviderInstance('deepseek', p) });
    const blocks = (JSON.parse(p.snapshots.at(-1)!) as { content: unknown }[]).flatMap((m) => (Array.isArray(m.content) ? m.content as { type: string; content: unknown }[] : []));
    const results = blocks.filter((b) => b.type === 'tool_result');
    assert.equal(results.length, urls.length);
    for (const x of results) assert.match(JSON.stringify(x.content), /is blocked in this session \((github\.com|raw\.githubusercontent\.com|codeload\.github\.com|api\.github\.com\/repos)\/suhail-akhtar\/agent-harness-web\)/);
    // Recorded in the run's result and the results file: what was refused, and how commands were contained (as they were, not as asked).
    const one = JSON.parse(await fs.readFile(path.join(out, 'demo-peek-deepseek-flash-1', 'result.json'), 'utf8')) as { isolation?: { deniedUrls: string[]; commands: string } };
    assert.ok(one.isolation!.deniedUrls.includes('raw.githubusercontent.com/suhail-akhtar/agent-harness-web'));
    assert.match(one.isolation!.commands, /^(not contained: .*can read the case folder|bwrap|seatbelt|docker)/);
    const all = JSON.parse(await fs.readFile(path.join(out, 'results.json'), 'utf8')) as { harness: Record<string, string> };
    assert.match(all.harness['web tools refuse']!, /github\.com\/suhail-akhtar\/agent-harness-web/);
    assert.equal(all.harness.commands, one.isolation!.commands);
    assert.match(await fs.readFile(path.join(out, 'report.md'), 'utf8'), /- web tools refuse: github\.com\/suhail-akhtar\/agent-harness-web, raw\.githubusercontent\.com/);
  } finally { if (saved === undefined) delete process.env.HARNESS_EVAL_DENY_HOSTS; else process.env.HARNESS_EVAL_DENY_HOSTS = saved; }
});

test('the eval deny list: host and path-prefix entries, every redirect hop, search results, and HARNESS_EVAL_DENY_HOSTS', async () => {
  const { evalDenyList } = await import('../src/eval/runner.ts');
  const web = await import('../src/tools/web.ts');
  const deny = await evalDenyList({});
  const denied = (u: string) => web.deniedUrl(new URL(u), deny);
  assert.ok(denied('https://github.com/suhail-akhtar/agent-harness-web.git'), 'a clone URL');
  assert.ok(denied('https://www.github.com/suhail-akhtar/agent-harness-web'));
  assert.ok(denied('https://raw.github.com/suhail-akhtar/agent-harness-web/main/x'), 'the old raw host (a subdomain)');
  assert.ok(denied('https://github.com/suhail-akhtar%2Fagent-harness-web/raw/main/x'), 'an encoded slash');
  assert.ok(denied('https://github.com//suhail-akhtar/agent-harness-web/'), 'a doubled slash');
  // The rest of GitHub stays open: research cases cite it.
  assert.equal(denied('https://github.com/modelcontextprotocol/modelcontextprotocol'), undefined);
  assert.equal(denied('https://github.com/suhail-akhtar/agent-harness-web2'), undefined);
  assert.equal(denied('https://raw.githubusercontent.com/suhail-akhtar/other/main/x'), undefined);
  // The variable replaces the list; "none" empties it.
  assert.deepEqual(await evalDenyList({ HARNESS_EVAL_DENY_HOSTS: 'example.org, docs.example.com/private' }), ['example.org', 'docs.example.com/private']);
  assert.deepEqual(await evalDenyList({ HARNESS_EVAL_DENY_HOSTS: 'none' }), []);
  assert.ok(web.deniedUrl(new URL('https://sub.example.org/a'), ['example.org']));
  assert.equal(web.deniedUrl(new URL('https://docs.example.com/public'), ['docs.example.com/private']), undefined);

  // A redirect to a denied URL is refused at that hop (here through a local HTTP proxy that answers the first request).
  const http = await import('node:http');
  let proxied = 0;
  const proxy = http.createServer((_q, res) => { proxied++; res.writeHead(302, { location: 'https://raw.githubusercontent.com/suhail-akhtar/agent-harness-web/main/evals/x/eval.json', connection: 'close' }).end(); });
  // Node's proxy agent tunnels plain http too: answer the tunnel with the same server.
  proxy.on('connect', (_q, sock) => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); proxy.emit('connection', sock); });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  const keys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'];
  const env = keys.map((k) => [k, process.env[k]] as const);
  const lookup = web.resolver.lookup;
  for (const k of keys) delete process.env[k];
  process.env.HTTP_PROXY = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  web.resolver.lookup = async () => [{ address: '93.184.215.14', family: 4 }];
  try {
    const r = await web.webFetchTool.run({ url: 'http://short.example/x' }, { signal: new AbortController().signal, services: { denyUrls: deny } } as never).then(() => undefined, (e: Error) => e.message);
    assert.equal(proxied, 1, 'the first hop was fetched');
    assert.match(r ?? '', /raw\.githubusercontent\.com\/suhail-akhtar\/agent-harness-web\/main\/evals\/x\/eval\.json is blocked in this session/);
  } finally {
    web.resolver.lookup = lookup;
    for (const [k, v] of env) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    proxy.close();
  }

  // Search: hits on denied pages are dropped (a snippet carries the page), the rest kept.
  const search = { backend: 'fake', search: async () => ({ backend: 'fake', cost: 0, hits: [
    { title: 'eval.json', url: 'https://github.com/suhail-akhtar/agent-harness-web/blob/main/evals/demo/peek/eval.json', snippet: '"checks": [ hidden ]' },
    { title: 'MCP spec', url: 'https://github.com/modelcontextprotocol/modelcontextprotocol', snippet: 'the spec' },
  ] }) };
  const s = await web.webSearchTool.run({ query: 'agent-harness-web eval.json' }, { signal: new AbortController().signal, services: { search, denyUrls: deny } } as never) as { content: string };
  assert.doesNotMatch(s.content, /agent-harness-web\/blob|hidden/);
  assert.match(s.content, /modelcontextprotocol/);
});

test('eval runs contain their commands by default: auto (the OS sandbox, else Docker), HARNESS_EVAL_SANDBOX chooses, the harness checkout is what they must not read', async () => {
  const { evalSandbox, evalImage, evalHiddenPaths, describeContainment } = await import('../src/eval/runner.ts');
  assert.equal(evalSandbox({}), 'auto');
  assert.equal(evalSandbox({ HARNESS_EVAL_SANDBOX: ' Docker ' }), 'docker');
  assert.equal(evalSandbox({ HARNESS_EVAL_SANDBOX: 'off' }), 'off');
  assert.throws(() => evalSandbox({ HARNESS_EVAL_SANDBOX: 'none' }), /use auto, bwrap, seatbelt, docker or off/);
  // The checkout (its evals/ and git history), the main checkout of a worktree, and wherever the cases came from.
  const root = await tempDir();
  const caseDir = path.join(root, 'evals', 'demo', 'peek');
  await fs.mkdir(caseDir, { recursive: true });
  const hidden = await evalHiddenPaths([caseDir]);
  const repo = await fs.realpath(path.resolve(import.meta.dirname, '..'));
  assert.ok(hidden.includes(repo), `${repo} in ${hidden.join(', ')}`);
  assert.ok(hidden.includes(await fs.realpath(path.join(root, 'evals'))));
  assert.ok(hidden.every((p) => !p.endsWith(`${path.sep}.git`)), 'a checkout, not its .git folder');
  assert.match(describeContainment({ sandbox: 'bwrap', network: 'none', hidden }), /harness checkout is hidden/);
  assert.match(describeContainment({ sandbox: 'seatbelt', network: 'none' }), /the disk is readable/);
  assert.match(describeContainment({ sandbox: 'none', network: 'full' }), /HARNESS_EVAL_SANDBOX/);
  // The devops cases' image is the Docker sandbox's, allowed for the runner's sessions.
  const env: NodeJS.ProcessEnv = { HARNESS_DEVOPS_IMAGE: 'harness-sandbox-ops:latest', HARNESS_SANDBOX_IMAGES: 'x:1' };
  assert.equal(evalImage(env), 'harness-sandbox-ops:latest');
  assert.equal(env.HARNESS_SANDBOX_IMAGES, 'x:1,harness-sandbox-ops:latest');
  assert.equal(evalImage({}), undefined);
});

test('commands never see the server\'s npm variables (they point into the harness checkout)', async () => {
  const { scrubbedEnv } = await import('../src/runtime/host.ts');
  const saved = { a: process.env.npm_package_json, b: process.env.INIT_CWD, c: process.env.npm_config_local_prefix };
  process.env.npm_package_json = '/repo/package.json';
  process.env.INIT_CWD = '/repo';
  process.env.npm_config_local_prefix = '/repo';
  try {
    const env = scrubbedEnv();
    assert.equal(env.npm_package_json, undefined);
    assert.equal(env.INIT_CWD, undefined);
    assert.equal(env.npm_config_local_prefix, undefined);
    assert.ok(env.PATH ?? env.Path, 'the rest stays');
  } finally {
    for (const [k, v] of [['npm_package_json', saved.a], ['INIT_CWD', saved.b], ['npm_config_local_prefix', saved.c]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

const { detectOsSandbox } = await import('../src/runtime/os-sandbox.ts');
const { dockerAvailable, imageExists } = await import('../src/runtime/docker.ts');
const canContain = !!detectOsSandbox() || ((await dockerAvailable()) && (await imageExists('harness-sandbox:latest')));
test('an eval run\'s commands cannot read the case folder (the hidden checks): auto contains them', { skip: !canContain && 'no OS sandbox and no Docker sandbox image here' }, async () => {
  const saved = process.env.HARNESS_EVAL_SANDBOX;
  process.env.HARNESS_EVAL_SANDBOX = 'auto';
  try {
    const root = await tempDir();
    const dir = path.join(root, 'evals', 'demo', 'peek');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'acceptance.sh'), 'echo HIDDEN-CHECK-BODY');
    await fs.writeFile(path.join(dir, 'eval.json'), JSON.stringify({ name: 'peek', prompt: 'x', checks: [{ name: 'hidden', run: 'bash {{case}}/acceptance.sh' }] }));
    const cases = await loadCases(path.join(root, 'evals'));
    const out = path.join(root, 'out');
    await fs.mkdir(out);
    const target = `${dir.split(path.sep).join('/')}/acceptance.sh`;
    const p = new FakeProvider([{ calls: [{ name: 'bash', input: { command: `cat '${target}' 2>&1; echo END` } }] }, { text: 'Done.' }]);
    const [r] = await runEvals({ cases, models: ['deepseek-flash'], repeats: 1, out, concurrency: 1, plugins: [], setup: (h) => h.registry.setProviderInstance('deepseek', p) });
    const blocks = (JSON.parse(p.snapshots.at(-1)!) as { content: unknown }[]).flatMap((m) => (Array.isArray(m.content) ? m.content as { type: string; content: unknown }[] : []));
    const result = JSON.stringify(blocks.find((b) => b.type === 'tool_result')?.content);
    assert.match(result, /END/, result);
    assert.doesNotMatch(result, /HIDDEN-CHECK-BODY/, 'the agent read its own hidden check');
    // The checks themselves still run on this machine, with the case folder.
    assert.equal(r!.checks[0]!.pass, true, r!.checks[0]!.detail);
    assert.match(r!.isolation!.commands, /^(docker, network none: only the workspace is mounted|(bwrap|seatbelt), network none: the harness checkout is hidden)/);
  } finally { if (saved === undefined) delete process.env.HARNESS_EVAL_SANDBOX; else process.env.HARNESS_EVAL_SANDBOX = saved; }
});
