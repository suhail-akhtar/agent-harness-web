// A live end-to-end run of the deep-research workflow (phase 3; spends: not part of npm test). The conversation runs on
// the model given (default Claude Haiku 5.5), web search through the backend in HARNESS_SEARCH (default anthropic),
// and the claim ledger's judge on another family (the first of --judges allowed: default grok-4.7). The prompt is
// what a person would type. Graded afterwards from the files and the stored pages, not from what the agents said:
//   - the report exists, cites only pages that were read, and passes check_citations;
//   - the claim ledger was written, by a judge of another family, with no unsupported or contradicted claim left;
//   - the counter-evidence search and the fact-check were written;
//   - the answer holds the facts the truth list names (regular expressions over the report).
//   node --env-file=path/to/.env scripts/live-deep-research.mjs [--model claude-haiku-5-5] [--judges grok-4.7] [--out docs/swarm/EVAL-DEEP-RESEARCH]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
const MODEL = arg('--model') ?? 'claude-haiku-5-5';
const JUDGES = (arg('--judges') ?? 'grok-4.7').split(',');
const OUT = arg('--out');
process.env.HARNESS_SEARCH ??= 'anthropic';
process.env.HARNESS_PLUGIN_LOOPS = 'off';
process.env.HARNESS_MAX_COST_USD = arg('--max-usd') ?? '6';
const QUESTION = 'When do the EU AI Act\'s obligations apply? I need the dates for the bans, for general-purpose AI models and for high-risk systems, and whether any of them have been delayed.';
// What the answer must hold (each a fact any reliable source on the Act states).
const TRUTH = [
  ['entry into force on 1 August 2024', /1 August 2024|August 1, 2024/i],
  ['prohibitions from 2 February 2025', /2 February 2025|February 2, 2025/i],
  ['general-purpose AI obligations from 2 August 2025', /2 August 2025|August 2, 2025/i],
  ['most of the rest from 2 August 2026', /2 August 2026|August 2, 2026/i],
];

const has = (...k) => k.some((n) => process.env[n]?.trim());
console.log(`keys: Anthropic ${has('GW_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY') ? 'present' : 'absent'}, xAI ${has('XAI_API_KEY') ? 'present' : 'absent'}; search: ${process.env.HARNESS_SEARCH}; model: ${MODEL}; judges: ${JUDGES.join(', ')}`);
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const { createHarness } = await imp('src/kernel/harness.ts');
const { createApp } = await imp('src/server/app.ts');
const { checkCitations } = await imp('src/research/citations.ts');
const tmp = fs.realpathSync(os.tmpdir());
const data = fs.mkdtempSync(path.join(tmp, 'live-dr-'));
const h = await createHarness({ dataDir: data, memory: 'off', plugins: [path.join(root, 'plugins', 'research')] });
const { server } = createApp({ harness: h, token: 'dr-check', loopback: true, localRoots: [tmp], uiDir: path.join(data, 'ui'), appRoot: data });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const api = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { authorization: 'Bearer dr-check', 'content-type': 'application/json', 'x-harness': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const t = await r.text(); try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t }; } };
await api('PUT', '/api/me/settings', { delegation: { allowedModels: JUDGES } });
const dir = fs.mkdtempSync(path.join(tmp, 'dr-'));
const s = h.sessions.get((await api('POST', '/api/sessions', { runtime: 'local', mode: 'bypass', model: MODEL, path: dir })).body.id);
const steps = [];
let t0 = Date.now();
let ended = false; let wf = "none";
s.subscribe(0, ({ event: e }) => {
  if (e.kind === 'turn_end' && !e.agent) ended = true;
  if (e.kind === 'workflow' && e.phase === 'started') wf = 'running';
  if (e.kind === 'workflow' && e.phase === 'finished') { wf = 'finished'; console.log(`  workflow ${e.run?.status ?? 'finished'}`); }
  if (e.kind === 'workflow' && e.phase === 'node_finished' && e.node) { steps.push(e.node); console.log(`  [${((Date.now() - t0) / 60_000).toFixed(1)} min] ${e.node} done, $${s.meta.cost.toFixed(3)}`); }
});
t0 = Date.now();
await s.send(`Run the deep-research workflow on: ${QUESTION}`);
// Done when the workflow has finished and the turn after it ended (a detached run reports back in a later turn).
while (!(ended && wf !== "running") && Date.now() - t0 < 75 * 60_000) await new Promise((r) => setTimeout(r, 2000));
const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } };
const report = read('research/report.md');
const claims = read('research/claims.md');
const cites = report ? await checkCitations(report, s.sources) : undefined;
const pages = (await s.sources.list()).length;
const judgeModels = [...new Set([...JSON.stringify(s.meta.byModel ?? {}).matchAll(/"([\w.-]+)":\{/g)].map((m) => m[1]))];
const counts = /Claims: (\d+); supported (\d+), partial (\d+), unsupported (\d+), contradicted (\d+), unverifiable (\d+); backed by two or more independent sites: (\d+)/.exec(claims);
const checks = [
  ['the report was written', report.length > 500],
  ['it cites only pages that were read, and passes check_citations', !!cites && cites.citations > 0 && cites.issues.length === 0],
  ['the claim ledger was written', !!counts],
  ['the ledger was judged on another family (models used include a judge model)', JUDGES.some((j) => judgeModels.includes(j))],
  ['no unsupported or contradicted claim left in the ledger', !!counts && counts[4] === '0' && counts[5] === '0'],
  ['the counter-evidence search was written', read('research/counter.md').length > 100],
  ['the fact-check was written', read('research/fact-check.md').length > 50],
  ...TRUTH.map(([what, re]) => [`the answer holds: ${what}`, re.test(report)]),
];
for (const [what, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
const out = {
  date: new Date().toISOString(), model: MODEL, judges: JUDGES, search: process.env.HARNESS_SEARCH, question: QUESTION,
  minutes: +((Date.now() - t0) / 60_000).toFixed(1), cost: +s.meta.cost.toFixed(4), byModel: Object.fromEntries(Object.entries(s.meta.byModel ?? {}).map(([k, v]) => [k, +v.cost.toFixed(4)])),
  pagesRead: pages, citations: cites ? { citations: cites.citations, issues: cites.issues.length } : null, ledger: counts ? counts[0] : null,
  checks: checks.map(([what, ok]) => ({ what, ok })), steps,
};
console.log(`\n${checks.filter((c) => c[1]).length}/${checks.length} checks; ${out.minutes} min; $${out.cost} ${JSON.stringify(out.byModel)}; ${pages} pages read; ${out.ledger ?? 'no ledger'}`);
if (OUT) {
  fs.writeFileSync(path.join(root, `${OUT}.json`), `${JSON.stringify(out, null, 2)}\n`);
  for (const f of ['report.md', 'claims.md', 'counter.md', 'fact-check.md']) if (read(`research/${f}`)) fs.writeFileSync(path.join(root, `${OUT}-${f}`), read(`research/${f}`));
}
server.close(); await h.close();
process.exit(checks.every((c) => c[1]) ? 0 : 1);
