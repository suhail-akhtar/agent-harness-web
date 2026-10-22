// Live smoke test of the Moonshot (Kimi) and Z.ai (GLM) providers against the
// real APIs. It spends money, so it is not part of npm test. Keys come from the
// environment (MOONSHOT_API_KEY, ZAI_API_KEY); only their names are ever printed.
//   node --env-file=path/to/.env scripts/live-providers.mjs [--only moonshot|zai]
//
// Per model: one short tool-use round trip through the harness CLI (write a
// file, read it back, answer with its content), reporting cost, model calls and
// cached tokens. Kimi also gets a cache-hit check (two direct calls sharing a
// long prefix), a token estimate and the balance before and after. Z.ai is
// kept to at most 3 model calls in total (--max-steps 3): its second and third
// calls share the first one's prefix, so they show the cache too.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined;
const results = [];
const has = (name) => !!process.env[name]?.trim();

console.log(`keys: MOONSHOT_API_KEY ${has('MOONSHOT_API_KEY') ? 'present' : 'absent'}, ZAI_API_KEY ${has('ZAI_API_KEY') ? 'present' : 'absent'}`);

/** One headless CLI run in a fresh folder: write a file, read it back, answer. */
function roundTrip(model, word, { maxSteps = 4, maxCost = 0.05 } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live-ws-')));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'live-data-'));
  const prompt = `Use the write tool to create note.txt containing exactly ${word} (nothing else). Then use the read tool to read note.txt. Then reply with only the file's content. Use no other tools.`;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['scripts/run.mjs', 'src/cli.ts', '--model', model, '--runtime', 'local', '--dir', dir, '--data', data, '--mode', 'bypass', '--max-cost', String(maxCost), '--max-steps', String(maxSteps), '--output', 'json', prompt], {
    cwd: root,
    encoding: 'utf8',
    timeout: 600_000,
    env: { ...process.env, HARNESS_LOCAL_ROOTS: dir, HARNESS_PLUGIN_LOOPS: 'off', HARNESS_MEMORY: 'off', HARNESS_SEARCH: 'off' },
  });
  let out;
  try { out = JSON.parse(r.stdout.trim().split('\n').at(-1)); } catch { out = { reason: 'error', error: `no JSON result (exit ${r.status}); stderr tail: ${(r.stderr ?? '').slice(-600)}` }; }
  const file = fs.existsSync(path.join(dir, 'note.txt')) ? fs.readFileSync(path.join(dir, 'note.txt'), 'utf8').trim() : null;
  const pass = out.reason === 'done' && file === word && (out.text ?? '').includes(word);
  return { check: 'cli round trip', model, pass, seconds: Math.round((Date.now() - t0) / 1000), cost: out.cost, modelCalls: out.modelCalls, toolCalls: out.toolCalls, tokens: out.tokens, cacheHit: out.cacheHit, file, answer: (out.text ?? '').slice(0, 80), ...(out.error ? { error: out.error.slice(0, 400) } : {}) };
}

async function moonshot() {
  const { MoonshotProvider, moonshotBalance, moonshotEstimateTokens } = await import(pathToFileURL(path.join(root, 'src/providers/moonshot.ts')).href);
  const { getModel, costOf } = await import(pathToFileURL(path.join(root, 'src/core/models.ts')).href);
  const key = process.env.MOONSHOT_API_KEY;
  const before = await moonshotBalance(key).catch((e) => ({ error: e.message }));
  console.log('moonshot balance before:', before.error ?? `$${before.available.toFixed(4)}`);

  // Cache check on the cheapest call: kimi-k2.6 with thinking off, a ~5K-token
  // fixed system prompt, two different questions, a 16-token answer cap.
  const system = `You are a terse assistant. Reference material follows; answer only what is asked.\n\n${Array.from({ length: 160 }, (_, i) => `Fact ${i + 1}: the code word for item ${i + 1} is ${(i * 7919 % 10007).toString(36)}-${i % 13}.`).join('\n')}`;
  const spec = { ...getModel('kimi-k2.6'), maxOutput: 16 };
  const p = new MoonshotProvider(key);
  const estimate = await moonshotEstimateTokens(key, 'kimi-k2.6', [{ role: 'system', content: system }, { role: 'user', content: 'What is the code word for item 1? Answer with the word only.' }]).catch((e) => `error: ${e.message}`);
  const calls = [];
  for (const q of [1, 2]) {
    const r = await p.send({ model: spec, system, tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: `What is the code word for item ${q}? Answer with the word only.` }] }], effort: 'low', cacheKey: 'live-cache-check', signal: AbortSignal.timeout(120_000) });
    calls.push({ usage: r.usage, cost: costOf(spec, r.usage), text: r.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('').slice(0, 40) });
  }
  results.push({ check: 'cache hit (two calls, shared ~5K-token prefix)', model: 'kimi-k2.6', pass: calls[1].usage.cacheRead > 0, estimateTokens: estimate, first: calls[0].usage, second: calls[1].usage, cost: Number((calls[0].cost + calls[1].cost).toFixed(6)), answers: calls.map((c) => c.text) });

  for (const [model, word] of [['kimi-k2.6', 'kiwi-26'], ['kimi-k2.7-code', 'kiwi-27'], ['kimi-k3', 'kiwi-3']]) results.push(roundTrip(model, word, { maxCost: model === 'kimi-k3' ? 0.12 : 0.05 }));

  // The balance can lag the calls by a while; one retry covers a dropped connection.
  const after = await moonshotBalance(key).catch(() => moonshotBalance(key)).catch((e) => ({ error: e.message }));
  console.log('moonshot balance after:', after.error ?? `$${after.available.toFixed(4)}`);
  if (!before.error && !after.error) results.push({ check: 'moonshot balance delta (may lag)', pass: true, spent: Number((before.available - after.available).toFixed(4)) });
}

async function zai() {
  // At most 3 model calls on Z.ai in total: this one run, capped at 3 steps.
  results.push(roundTrip('glm-5.3-flash', 'mango-53', { maxSteps: 3, maxCost: 0.02 }));
}

if ((!only || only === 'moonshot')) {
  if (has('MOONSHOT_API_KEY')) await moonshot().catch((e) => results.push({ check: 'moonshot', pass: false, error: e.message }));
  else results.push({ check: 'moonshot', skipped: 'MOONSHOT_API_KEY is not set' });
}
if ((!only || only === 'zai')) {
  if (has('ZAI_API_KEY')) await zai().catch((e) => results.push({ check: 'zai', pass: false, error: e.message }));
  else results.push({ check: 'zai', skipped: 'ZAI_API_KEY is not set' });
}

// Nothing printed below holds a key: provider errors carry the API's message, never the request headers.
const secrets = [process.env.MOONSHOT_API_KEY, process.env.ZAI_API_KEY].filter((k) => k && k.length > 8);
let report = JSON.stringify(results, null, 2);
for (const k of secrets) report = report.split(k).join('[redacted]');
console.log(report);
process.exitCode = results.every((r) => r.pass !== false) ? 0 : 1;
