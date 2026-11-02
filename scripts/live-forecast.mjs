// A live run of the forecasting ledger (phase 5; spends: not part of npm test). Three live questions (not decided
// yet), each asked the way a person would ask; the conversation runs on Claude Haiku 5.5 and the forecasters on Claude
// Sonnet 5.5, Claude Haiku 5.5 and Grok 4.7, with web search. Nothing here can score skill (the questions resolve
// later): graded on what can be checked now, from the ledger itself: each forecaster gave a probability from its own
// brief, the aggregate is what the code computes from them, the question is kept with its criteria and date, and a
// question already decided is refused.
//   node --env-file=path/to/.env scripts/live-forecast.mjs [--out docs/swarm/EVAL-FORECAST]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
const OUT = arg('--out');
const MODELS = ['claude-sonnet-5-5', 'claude-haiku-5-5', 'grok-4.7'];
process.env.HARNESS_SEARCH ??= 'anthropic';
process.env.HARNESS_PLUGIN_LOOPS = 'off';
process.env.HARNESS_MAX_COST_USD = '4';
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const { createHarness } = await imp('src/kernel/harness.ts');
const { createApp } = await imp('src/server/app.ts');
const { aggregate } = await imp('plugins/forecasting/lib/aggregate.mjs');

const QUESTIONS = [
  'How likely is it that the Bank of England cuts Bank Rate at its December 2026 meeting? Use the forecasting tool, with Sonnet, Haiku and Grok 4.7 as forecasters.',
  // (A first run asked about Artemis II with crew before April 2027: it had flown in April 2026, and the agent found
  // that and refused to forecast a decided question. The question was ours to fix.)
  'Forecast whether the US Federal Reserve cuts the federal funds target range at its December 2026 FOMC meeting. Use the forecasting tool with Sonnet, Haiku and Grok 4.7.',
  'What are the chances that Bitcoin closes above 150,000 US dollars on 31 December 2026 (CoinMarketCap daily close)? Use the forecasting tool with Sonnet, Haiku and Grok 4.7.',
];

const tmp = fs.realpathSync(os.tmpdir());
const data = fs.mkdtempSync(path.join(tmp, 'live-fc-'));
const h = await createHarness({ dataDir: data, memory: 'off', plugins: [path.join(root, 'plugins', 'forecasting')] });
const { server } = createApp({ harness: h, token: 'fc-check', loopback: true, localRoots: [tmp], uiDir: path.join(data, 'ui'), appRoot: data });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const api = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { authorization: 'Bearer fc-check', 'content-type': 'application/json', 'x-harness': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const t = await r.text(); try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t }; } };
await api('PUT', '/api/me/settings', { delegation: { allowedModels: MODELS } });
const s = h.sessions.get((await api('POST', '/api/sessions', { runtime: 'local', mode: 'bypass', model: 'claude-haiku-5-5', path: fs.mkdtempSync(path.join(tmp, 'fc-')) })).body.id);
let ends = 0;
s.subscribe(0, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) ends++; });
const turn = async (text) => { const n = ends; const t0 = Date.now(); await s.send(text); while (ends === n && Date.now() - t0 < 30 * 60_000) await new Promise((r) => setTimeout(r, 1500)); };
const ledger = () => { try { return JSON.parse(fs.readFileSync(path.join(data, 'plugin-data', 'forecasting', 'forecasts.json'), 'utf8')).questions; } catch { return []; } };

const checks = [];
const check = (what, ok, detail = '') => { checks.push({ what, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` (${detail})` : ''}`); };
for (const q of QUESTIONS) {
  const before = ledger().length;
  await turn(q);
  const added = ledger().slice(before);
  const x = added[0];
  console.log(`\n=== ${q.slice(0, 90)}`);
  if (!x) { check('kept in the ledger', false); continue; }
  console.log(`  ${x.id}: "${x.question}" resolves ${x.resolveBy}; aggregate ${x.aggregate?.toFixed?.(3)}; ${x.forecasts.map((f) => `${f.model} ${typeof f.p === 'number' ? f.p.toFixed(2) : f.error ?? '-'}`).join(', ')}`);
  check('kept in the ledger with its criteria and a resolution date after today', !!x.criteria && x.resolveBy > new Date().toISOString().slice(0, 10), x.resolveBy);
  const got = x.forecasts.filter((f) => typeof f.p === 'number');
  check('a probability from each forecaster (Sonnet, Haiku, Grok 4.7)', MODELS.every((m) => got.some((f) => f.model === m)), got.map((f) => f.model).join(', '));
  check('the aggregate is what the code computes from them', typeof x.aggregate === 'number' && Math.abs(aggregate(got.map((f) => f.p)) - x.aggregate) < 1e-9);
  check('each forecaster started from a base rate', got.every((f) => /base_rate/.test(f.rationale ?? '')));
}
// A question already decided: refused (live questions only).
const before = ledger().length;
await turn('Use the forecasting tool: will the 2024 Summer Olympics be held in Paris? It resolved on 2024-08-11.');
check('a question already decided is not forecast', ledger().length === before);

const cost = +s.meta.cost.toFixed(4);
console.log(`\n${checks.filter((c) => c.ok).length}/${checks.length} checks; $${cost} ${JSON.stringify(Object.fromEntries(Object.entries(s.meta.byModel ?? {}).map(([k, v]) => [k, +v.cost.toFixed(4)])))}`);
if (OUT) fs.writeFileSync(path.join(root, `${OUT}.json`), `${JSON.stringify({ date: new Date().toISOString(), models: MODELS, checks, cost, ledger: ledger() }, null, 2)}\n`);
server.close(); await h.close();
