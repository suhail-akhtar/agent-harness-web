// A live check of the xAI (Grok) provider in the harness (spends a little: not part of npm test). Keys come from the
// environment; only their names are printed, never values.
//   node --env-file=path/to/.env scripts/live-xai-check.mjs [--models grok-4.3,grok-4.7]
// For each model: a plain answer, tool use in a real folder (read a file, write one), and the model as a swarm
// worker (a fan-out of two items, each verified on another provider at high stakes) and as a verifier.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
const MODELS = (arg('--models') ?? 'grok-4.3,grok-4.7').split(',');
process.env.HARNESS_PLUGIN_LOOPS = 'off';
process.env.HARNESS_MAX_COST_USD = '0.5';
console.log(`keys: xAI ${process.env.XAI_API_KEY?.trim() ? 'present' : 'absent'}, Anthropic ${process.env.GW_ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_API_KEY?.trim() ? 'present' : 'absent'}`);
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const { createHarness } = await imp('src/kernel/harness.ts');
const { createApp } = await imp('src/server/app.ts');
const { makeAgentTool, BUILTIN_AGENTS } = await imp('src/agents/agents.ts');
const tmp = fs.realpathSync(os.tmpdir());
const data = fs.mkdtempSync(path.join(tmp, 'live-xai-'));
const h = await createHarness({ dataDir: data, search: null, memory: 'off' });
const { server } = createApp({ harness: h, token: 'xai-check', loopback: true, localRoots: [tmp], uiDir: path.join(data, 'ui'), appRoot: data });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const api = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { authorization: 'Bearer xai-check', 'content-type': 'application/json', 'x-harness': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const t = await r.text(); try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t }; } };
await api('PUT', '/api/me/settings', { delegation: { allowedModels: [...MODELS, 'claude-sonnet-5-5', 'deepseek-flash'] } });
const folder = (files) => { const d = fs.mkdtempSync(path.join(tmp, 'xai-')); for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(d, k), v); execFileSync('git', ['init', '-q'], { cwd: d }); return d; };
let ok = 0; let all = 0; let spent = 0;
const check = (c, what) => { all++; if (c) ok++; console.log(`${c ? 'PASS' : 'FAIL'}  ${what}`); };
const models = (await api('GET', '/api/models')).body;
for (const model of MODELS) {
  console.log(`\n=== ${model}`);
  check(models.find((m) => m.id === model)?.available, `${model} is listed and available`);
  const dir = folder({ 'notes.txt': 'The launch code is ORCHID-7.\n' });
  const made = await api('POST', '/api/sessions', { runtime: 'local', mode: 'bypass', model, path: dir });
  const s = h.sessions.get(made.body.id);
  const ends = []; s.subscribe(0, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) ends.push(event.reason); });
  const turn = async (t) => { const n = ends.length; await s.send(t); for (let i = 0; i < 240 && ends.length === n; i++) await new Promise((r) => setTimeout(r, 500)); };
  await turn('What is 17 times 23? Answer with the number only.');
  const last = () => s.history.filter((m) => m.role === 'assistant').at(-1)?.content.filter((b) => b.type === 'text').map((b) => b.text).join('') ?? '';
  check(/391/.test(last()), `a plain answer (${last().slice(0, 40)})`);
  await turn('Read notes.txt and write the launch code alone into code.txt.');
  check(fs.existsSync(path.join(dir, 'code.txt')) && /ORCHID-7/.test(fs.readFileSync(path.join(dir, 'code.txt'), 'utf8')), 'tool use: read a file, wrote one');
  // As a swarm worker: a fan-out of two, each verified on another provider (high stakes).
  const tool = makeAgentTool(BUILTIN_AGENTS, {});
  const res = String((await tool.run({ description: 'count', type: 'general', model, prompt: 'How many vowels (a, e, i, o, u) are in the word {{item}}? Count carefully.', items: ['banana', 'education'], fields: ['vowels'], stakes: 'high' }, { runSubagent: (a) => s.runSubagent(a, 1), signal: AbortSignal.timeout(300_000), services: {} })).content);
  check(/\| banana \| accepted \| 3 \|/.test(res) && /\| education \| accepted \| 5 \|/.test(res), `as a swarm worker, verified on another provider (${res.split('\n')[0]})`);
  spent += s.meta.cost;
  console.log(`  cost: $${s.meta.cost.toFixed(4)} ${JSON.stringify(Object.fromEntries(Object.entries(s.meta.byModel).map(([k, v]) => [k, +v.cost.toFixed(4)])))}`);
}
server.close(); await h.close();
console.log(`\n${ok}/${all} checks passed, $${spent.toFixed(4)} spent.`);
process.exit(ok === all ? 0 : 1);
