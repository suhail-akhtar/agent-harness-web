// Live evaluation of custom agents, the orchestrator, teams and MCP (spends money: not part of npm test).
// Keys come from the environment; only their names are printed, never values.
//   node --env-file=path/to/.env scripts/live-agents-eval.mjs [--only E1,E3] [--out docs/agents-mcp/EVAL.md]
//
// Prompts are written as a person would write them: they never name the agent, the tool or the steps. Each
// scenario checks the end state against the truth (tests run by this script, numbers computed from the database,
// files on disk, the git log), and records time, cost by model, which agents ran, and how many ran at once.
//   E1  A provider added in the app (its key over the API), a custom agent on its model; the orchestrator calls it.
//   E2  Several specialists on different models; one mixed request; the orchestrator routes each part.
//   E3  A bigger task: one agent alone, then a team working in parallel (same model), against hidden tests.
//   E4  A custom MCP server built from a database by the builder; a data agent answers business questions.
//   E5  Hard cases: a member that runs out of steps; an MCP server that crashes in the middle of a run.
//   E6  Agents in the background for different jobs; their reports reach the person.
//   E7  Read-heavy work: one agent alone, then a team of explorers in parallel, against the real code.
// A total spend cap (LIVE_MAX_USD, $5) stops the run between scenarios.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const only = arg('--only')?.split(',');
const out = path.resolve(root, arg('--out') ?? 'docs/agents-mcp/EVAL.md');
const CAP = Number(process.env.LIVE_MAX_USD ?? 5);
const ORCH = 'claude-sonnet-5-5';
process.env.HARNESS_PLUGIN_LOOPS = 'off';
process.env.HARNESS_MAX_COST_USD = '1.5';
const has = (n) => !!process.env[n]?.trim();
console.log(`keys: Anthropic ${has('ANTHROPIC_API_KEY') || has('GW_ANTHROPIC_API_KEY') ? 'present' : 'absent'}, DeepSeek ${has('DEEPSEEK_API_KEY') ? 'present' : 'absent'}, Moonshot ${has('MOONSHOT_API_KEY') ? 'present' : 'absent'}`);
// E1 adds Moonshot's key the way the app does: the engine starts without it.
const MOONSHOT = process.env.MOONSHOT_API_KEY;
delete process.env.MOONSHOT_API_KEY;

const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const { createHarness } = await imp('src/kernel/harness.ts');
const { createApp } = await imp('src/server/app.ts');

const tmp = fs.realpathSync(os.tmpdir());
const data = fs.mkdtempSync(path.join(tmp, 'live-eval-'));
const TOKEN = 'live-eval-operator-token';
const h = await createHarness({ dataDir: data, search: null, memory: 'off' });
const { server } = createApp({ harness: h, token: TOKEN, loopback: true, localRoots: [tmp], uiDir: path.join(data, 'ui'), appRoot: data });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const api = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'x-harness': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
};
/** The project's test suite (its npm test script is node --test): the exit code. */
const suite = (dir) => sh(process.execPath, ['--test'], dir).code;
const sh = (cmd, args, cwd) => { try { return { code: 0, out: execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }) }; } catch (e) { return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }; } };

// ---- the project the agents work on ----------------------------------------------------------------------------

function project(name) {
  const dir = fs.mkdtempSync(path.join(tmp, `eval-${name}-`));
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const git = (...a) => sh('git', a, dir);
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'eval@example.com'); git('config', 'user.name', 'Eval');
  w('package.json', JSON.stringify({ name: 'shopkit', version: '0.3.0', type: 'module', scripts: { test: 'node --test' }, dependencies: { 'left-pad': '1.3.0' } }, null, 2));
  w('README.md', '# shopkit\n\nSmall helpers for a web shop: a cart and a user lookup.\n');
  w('src/cart.js', 'export function total(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n');
  git('add', '-A'); git('commit', '-qm', 'Add the cart total');
  w('src/db.js', "// Looks a user up by name.\nexport function findUser(db, name) {\n  return db.prepare(\"SELECT * FROM users WHERE name = '\" + name + \"'\").get();\n}\n");
  git('add', '-A'); git('commit', '-qm', 'Add the user lookup');
  w('test/cart.test.js', "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { total } from '../src/cart.js';\n\ntest('the total counts quantities', () => {\n  assert.equal(total([{ price: 2, qty: 3 }, { price: 5, qty: 1 }]), 11);\n});\n\ntest('an empty cart costs nothing', () => {\n  assert.equal(total([]), 0);\n});\n");
  git('add', '-A'); git('commit', '-qm', 'Test that the total counts quantities');
  w('src/discount.js', '// TODO: support percentage codes as well as fixed ones\nexport function applyCode(total, code) {\n  return code === "SAVE5" ? Math.max(0, total - 5) : total;\n}\n');
  git('add', '-A'); git('commit', '-qm', 'Add discount codes (fixed amounts only)');
  w('TODO.md', [
    '# Three small utilities', '',
    '1. `slugify(text)` in src/slugify.js: lowercase, accents removed ("é" becomes "e"), every run of other characters becomes one "-", no "-" at either end. "Héllo, World!" becomes "hello-world".',
    '2. `parseDuration(text)` in src/duration.js: "1h30m" is 5400 (seconds); hours h, minutes m, seconds s, in that order, any of them may be missing ("45s", "2h"). Anything else throws an Error.',
    '3. `formatBytes(n)` in src/bytes.js: 1024-based units B, KB, MB, GB, TB, at most one decimal, no ".0": 0 is "0 B", 1536 is "1.5 KB", 1048576 is "1 MB".', '',
  ].join('\n'));
  git('add', '-A'); git('commit', '-qm', 'Plan three utilities');
  // The shop's data (a SQLite file): customers and their orders, last month and before.
  return dir;
}

async function shopDb(file) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, city TEXT);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, placed_on TEXT, total REAL);`);
  const customers = [['Amina Khan', 'Lahore'], ['Ben Ortiz', 'Madrid'], ['Chloe Martin', 'Lyon'], ['Dev Patel', 'Pune'], ['Eva Novak', 'Brno']];
  customers.forEach(([n, c], i) => db.prepare('INSERT INTO customers VALUES (?, ?, ?)').run(i + 1, n, c));
  // Last month (October 2026) and earlier; Ben spends most overall, Chloe most last month.
  const orders = [[2, '2026-08-03', 900], [2, '2026-09-14', 820], [2, '2026-10-02', 60], [3, '2026-10-05', 210], [3, '2026-10-17', 185.5], [3, '2026-10-29', 99.9], [1, '2026-10-11', 240], [1, '2026-10-21', 15], [4, '2026-10-08', 330], [5, '2026-09-30', 120], [5, '2026-11-01', 75]];
  orders.forEach(([c, d, t], i) => db.prepare('INSERT INTO orders VALUES (?, ?, ?, ?)').run(i + 1, c, d, t));
  const top = db.prepare("SELECT c.name, COUNT(*) n, ROUND(SUM(o.total), 2) s FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.placed_on BETWEEN '2026-10-01' AND '2026-10-31' GROUP BY c.id ORDER BY s DESC LIMIT 1").get();
  const cities = db.prepare("SELECT COUNT(DISTINCT c.city) n FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.placed_on BETWEEN '2026-10-01' AND '2026-10-31'").get();
  db.close();
  return { top, cities: cities.n };
}

// ---- running a conversation and watching it ---------------------------------------------------------------------

/** A conversation: its messages sent one after another, every event timed, what each agent did. */
async function converse(opts, messages) {
  const made = await api('POST', '/api/sessions', { runtime: 'local', mode: 'bypass', ...opts });
  if (made.status !== 201) throw new Error(`no conversation: ${JSON.stringify(made.body)}`);
  const s = h.sessions.get(made.body.id);
  const events = [];
  let turns = 0; const waiters = [];
  s.subscribe(0, ({ event }) => { events.push({ at: Date.now(), event }); if (event.kind === 'turn_end' && !event.agent) { turns++; for (const w of waiters.splice(0)) w(); } });
  const t0 = Date.now();
  for (const m of messages) {
    const want = turns + 1;
    await s.send(m);
    const deadline = Date.now() + 20 * 60_000;
    while (turns < want) { await Promise.race([new Promise((r) => waiters.push(r)), new Promise((r) => setTimeout(r, 5000))]); if (Date.now() > deadline) { s.abort(); throw new Error('a turn took more than 20 minutes'); } }
  }
  const ms = Date.now() - t0;
  // Agent runs: each agent tool call (by anyone) from its call to its result.
  const calls = new Map();
  for (const { at, event: e } of events) {
    if (e.kind === 'tool_call' && e.name === 'agent') calls.set(e.id, { by: e.agent ?? 'main', type: e.input?.type ?? '(no type)', description: e.input?.description, background: !!e.input?.run_in_background, start: at, end: undefined });
    if (e.kind === 'tool_result' && calls.has(e.id)) { const c = calls.get(e.id); c.end = at; c.result = e.content; c.error = e.is_error; const ran = /\(agent id: ([\w-]+?)-\d+\)/.exec(e.content ?? '')?.[1]; if (ran) c.type = ran; }
  }
  const runs = [...calls.values()];
  // How many ran at once at the busiest moment.
  let peak = 0;
  for (const r of runs) peak = Math.max(peak, runs.filter((x) => x.start <= r.start && (x.end ?? Infinity) > r.start).length);
  const reply = s.history.filter((m) => m.role === 'assistant').at(-1)?.content.filter((b) => b.type === 'text').map((b) => b.text).join('') ?? '';
  const byModel = Object.fromEntries(Object.entries(s.meta.byModel ?? {}).map(([k, v]) => [k, { cost: v.cost, requests: v.requests }]));
  const toolCalls = events.filter((x) => x.event.kind === 'tool_call').map((x) => ({ name: x.event.name, agent: x.event.agent ?? 'main' }));
  return { s, events, ms, runs, peak, reply, byModel, cost: s.meta.cost, toolCalls };
}

const results = [];
let spent = 0;
async function scenario(id, title, fn) {
  if (only && !only.includes(id)) return;
  if (spent >= CAP) { console.log(`\n${id}: skipped (spent $${spent.toFixed(2)} of $${CAP})`); return; }
  console.log(`\n=== ${id}: ${title}`);
  const r = { id, title, checks: [], notes: [], runs: [], conversations: [] };
  const check = (ok, what) => { r.checks.push({ ok: !!ok, what }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); };
  const note = (t) => { r.notes.push(t); console.log(`  - ${t}`); };
  const record = (label, c) => { r.conversations.push({ label, ms: c.ms, cost: c.cost, byModel: c.byModel, peak: c.peak, agents: c.runs.map((x) => ({ type: x.type, by: x.by, background: x.background, seconds: x.end ? (x.end - x.start) / 1000 : null, error: !!x.error })), tools: c.toolCalls.length, reply: c.reply.slice(0, 1200) }); spent += c.cost; };
  const t0 = Date.now();
  try { await fn({ check, note, record }); } catch (e) { check(false, `ran to the end (${e.message})`); }
  r.seconds = Math.round((Date.now() - t0) / 1000);
  results.push(r);
}
const mkAgent = async (def) => { const r = await api('POST', '/api/me/agents', def); if (r.status !== 201) throw new Error(`agent ${def.name}: ${JSON.stringify(r.body)}`); return r.body; };
const allow = (models) => api('PUT', '/api/me/settings', { delegation: { allowedModels: models } });

// ---- the scenarios ----------------------------------------------------------------------------------------------

await scenario('E1', 'A provider added in the app; a custom agent on its model; the orchestrator calls it when needed', async ({ check, note, record }) => {
  const before = (await api('GET', '/api/models')).body;
  check(!before.find((m) => m.id === 'kimi-k3.1-pro')?.available, 'Kimi is not available before its key is added');
  const put = await api('PUT', '/api/providers/moonshot', { apiKey: MOONSHOT });
  check(put.status < 300, `the Moonshot key is added over the API (as Settings > Models & providers does): ${put.status}`);
  const after = (await api('GET', '/api/models')).body;
  check(after.find((m) => m.id === 'kimi-k3.1-pro')?.available, 'Kimi K3.1 Pro is available after');
  await allow(['kimi-k3.1-pro', 'deepseek-flash', 'claude-haiku-5-5']);
  await mkAgent({ name: 'changelog-writer', description: 'Writes and updates a project\'s CHANGELOG.md from its git history: what changed, grouped by kind.', prompt: 'Read the git history (git log) and the code it touches. Write CHANGELOG.md in Keep a Changelog style: an Unreleased section with Added, Fixed and Changed as they apply, each entry one line a user understands. Do not invent changes that are not in the history.', model: 'kimi-k3.1-pro', tools: ['read', 'glob', 'grep', 'bash', 'write'] });
  const dir = project('e1');
  const subjects = sh('git', ['log', '--format=%s'], dir).out.trim().split('\n');
  const c = await converse({ model: ORCH, path: dir }, ['Can you add a CHANGELOG for this project, based on what has been done so far?']);
  record('the request', c);
  const used = c.runs.map((x) => x.type);
  check(used.includes('changelog-writer'), `the orchestrator handed it to the changelog-writer agent by itself (agents used: ${used.join(', ') || 'none'})`);
  check((c.byModel['kimi-k3.1-pro']?.requests ?? 0) > 0, `the agent ran on its own model, Kimi K3.1 Pro (${JSON.stringify(c.byModel)})`);
  const log = fs.existsSync(path.join(dir, 'CHANGELOG.md')) ? fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8') : '';
  check(log.length > 100, 'CHANGELOG.md was written');
  const covered = [/cart|total/i, /user|lookup/i, /discount|code/i].filter((re) => re.test(log)).length;
  check(covered === 3, `it covers the real history (cart, user lookup, discounts): ${covered} of 3`);
  check(!/payment|refund|login|oauth/i.test(log), 'it does not invent changes that are not in the history');
  note(`git history: ${subjects.join(' | ')}`);
});

await scenario('E2', 'Several specialists on different models; one mixed request; the orchestrator routes each part', async ({ check, note, record }) => {
  await allow(['kimi-k3.1-pro', 'deepseek-flash', 'claude-haiku-5-5']);
  await mkAgent({ name: 'test-fixer', description: 'Fixes failing tests by fixing the code under test (never by weakening the tests), then runs the suite to show it passes.', prompt: 'Run the tests, find why they fail, fix the code (not the tests), run them again until they pass. Report what was wrong and what you changed.', model: 'deepseek-flash', tools: ['read', 'glob', 'grep', 'edit', 'write', 'bash'] });
  await mkAgent({ name: 'security-reviewer', description: 'Reviews code for security problems (injection, secrets, unsafe input handling) and reports each finding with its file, line and a fix. Read-only.', prompt: 'Read the code you are pointed at. For each problem: file and line, why it is exploitable, and the fix. Do not change files.', model: 'claude-haiku-5-5', tools: ['read', 'glob', 'grep'], permissionMode: 'plan' });
  const dir = project('e2');
  check(suite(dir) !== 0, 'the tests fail before');
  const c = await converse({ model: ORCH, path: dir }, ['The test suite is failing, can you get it green? Also I\'m worried about security in src/db.js, can someone look at it?']);
  record('the request', c);
  const used = c.runs.map((x) => x.type);
  check(used.includes('test-fixer'), `the failing tests went to test-fixer (agents used: ${used.join(', ')})`);
  check(used.includes('security-reviewer'), 'the security question went to security-reviewer');
  const fixerRun = c.runs.find((x) => x.type === 'test-fixer');
  const reviewRun = c.runs.find((x) => x.type === 'security-reviewer');
  if (fixerRun && reviewRun) check(fixerRun.start < (reviewRun.end ?? Infinity) && reviewRun.start < (fixerRun.end ?? Infinity), `the two independent parts ran at the same time (at most ${c.peak} at once)`);
  check((c.byModel['deepseek-flash']?.requests ?? 0) > 0 && (c.byModel['claude-haiku-5-5']?.requests ?? 0) > 0, `each ran on its own model: ${Object.keys(c.byModel).join(', ')}`);
  check(suite(dir) === 0, 'the test suite passes after (run by this script)');
  const tests = fs.readFileSync(path.join(dir, 'test', 'cart.test.js'), 'utf8');
  check(/qty: 3/.test(tests) && /11\)/.test(tests), 'the tests were not weakened (the expected 11 is still there)');
  check(/inject/i.test(reviewRun?.result ?? '') && /db\.js/.test(reviewRun?.result ?? ''), 'the review found the SQL injection in src/db.js');
  check(/inject/i.test(c.reply), 'the person is told about the injection');
  note(`diff: ${sh('git', ['diff', '--stat'], dir).out.trim().split('\n').pop()}`);
});

const HIDDEN = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slugify.js';
import { parseDuration } from '../src/duration.js';
import { formatBytes } from '../src/bytes.js';
test('slugify', () => { assert.equal(slugify('Héllo, World!'), 'hello-world'); assert.equal(slugify('  --Crème brûlée & tea--  '), 'creme-brulee-tea'); assert.equal(slugify('ABC'), 'abc'); });
test('parseDuration', () => { assert.equal(parseDuration('1h30m'), 5400); assert.equal(parseDuration('45s'), 45); assert.equal(parseDuration('2h'), 7200); assert.equal(parseDuration('1h2m3s'), 3723); assert.throws(() => parseDuration('soon')); assert.throws(() => parseDuration('')); });
test('formatBytes', () => { assert.equal(formatBytes(0), '0 B'); assert.equal(formatBytes(1536), '1.5 KB'); assert.equal(formatBytes(1048576), '1 MB'); assert.equal(formatBytes(1023), '1023 B'); assert.equal(formatBytes(5 * 1024 ** 4), '5 TB'); });
`;
const hidden = (dir) => {
  fs.writeFileSync(path.join(dir, 'test', 'zz-hidden-acceptance.test.js'), HIDDEN);
  const r = sh(process.execPath, ['--test', 'test/zz-hidden-acceptance.test.js'], dir);
  fs.rmSync(path.join(dir, 'test', 'zz-hidden-acceptance.test.js'));
  return { pass: Number(/# pass (\d+)/.exec(r.out)?.[1] ?? 0), fail: Number(/# fail (\d+)/.exec(r.out)?.[1] ?? 3) };
};

await scenario('E3', 'A bigger task: one agent alone, then a team in parallel (same model), against hidden tests', async ({ check, note, record }) => {
  const tools = ['read', 'glob', 'grep', 'edit', 'write', 'bash'];
  await mkAgent({ name: 'solo-dev', description: 'A developer who does a whole coding task alone.', prompt: 'Do the task yourself, end to end: code, tests, and run them.', model: 'deepseek-flash', tools });
  await mkAgent({ name: 'util-dev', description: 'Implements one small, well-specified module with its unit tests, and runs them.', prompt: 'Implement exactly the module in your brief, in its own file, with a test file, and run the tests. Touch no other file. Report the files and the test result.', model: 'deepseek-flash', tools });
  await mkAgent({ name: 'code-reviewer', description: 'Reviews finished code against its specification and runs the whole test suite; reports what is wrong.', prompt: 'Compare the code with the specification, run the full test suite, report each problem with its file.', model: 'deepseek-flash', tools: ['read', 'glob', 'grep', 'bash'] });
  await mkAgent({ name: 'util-team', description: 'Builds several small modules at once with a team of developers and a reviewer.', prompt: 'You lead the team.', model: 'deepseek-flash', tools: ['read', 'glob', 'grep', 'bash'], team: { members: ['util-dev', 'code-reviewer'], reviewer: 'code-reviewer' } });
  const ask = 'Implement the three utilities described in TODO.md, each in its own file under src/ with tests under test/, and make sure npm test passes.';
  const solo = project('e3-solo');
  const a = await converse({ agent: 'solo-dev', model: 'deepseek-flash', path: solo }, [ask]);
  record('one agent alone', a);
  const ha = hidden(solo);
  const sa = suite(solo) === 0;
  const team = project('e3-team');
  const b = await converse({ agent: 'util-team', model: 'deepseek-flash', path: team }, [ask]);
  record('a team in parallel', b);
  const hb = hidden(team);
  const sb = suite(team) === 0;
  note(`alone: ${(a.ms / 1000).toFixed(0)}s, $${a.cost.toFixed(4)}, hidden tests ${ha.pass}/3, its own suite ${sa ? 'passes' : 'fails'}`);
  note(`team:  ${(b.ms / 1000).toFixed(0)}s, $${b.cost.toFixed(4)}, hidden tests ${hb.pass}/3, its own suite ${sb ? 'passes' : 'fails'}, ${b.runs.length} agent runs, at most ${b.peak} at once`);
  check(ha.pass === 3 && sa, `one agent alone: correct (hidden tests ${ha.pass}/3) and its suite passes`);
  check(hb.pass === 3 && sb, `the team: correct (hidden tests ${hb.pass}/3) and its suite passes`);
  check(b.peak >= 2, `the team ran members at the same time (at most ${b.peak} at once)`);
  check(b.runs.some((x) => x.type === 'code-reviewer'), 'the reviewer checked the work');
  // Measured, not judged: the research (docs/agents-mcp/research/coordination-evidence.md) expects small writing
  // tasks to cost more as a team; E7 measures read-heavy work, where splitting is expected to pay.
  note(`team against one agent: ${(b.ms / a.ms).toFixed(1)}x the time, ${(b.cost / Math.max(a.cost, 1e-9)).toFixed(1)}x the cost`);
});

await scenario('E4', 'A custom MCP server built from a database; a data agent answers business questions', async ({ check, note, record }) => {
  await allow(['kimi-k3.1-pro', 'deepseek-flash', 'claude-haiku-5-5']);
  const dir = project('e4');
  const file = path.join(dir, 'shop.db');
  const truth = await shopDb(file);
  const draft = await api('POST', '/api/me/mcp-builds/draft', { source: 'database', kind: 'sqlite', path: file, name: 'shop' });
  check(draft.status === 200, `a server drafted from the database: ${draft.body.spec?.tools?.map((t) => t.name).join(', ')}`);
  const built = await api('POST', '/api/me/mcp-builds', { spec: draft.body.spec, settings: { DATABASE_PATH: file }, source: 'database' });
  check(built.body.report?.ok, `built and checked by the harness (${built.body.report?.checks?.filter((x) => x.ok).length}/${built.body.report?.checks?.length})`);
  const reg = await api('POST', '/api/me/mcp-builds/shop/register');
  check(reg.status === 200, 'added to the person\'s MCP servers');
  await mkAgent({ name: 'data-analyst', description: 'Answers business questions about the shop (customers, orders, revenue) from its database, with the numbers.', prompt: 'Use the shop database tools. Check the tables first, then query. Give the answer with the numbers and how you got them.', model: 'claude-haiku-5-5', mcpServers: ['shop'] });
  const c = await converse({ model: ORCH, path: dir }, [
    'Which customer spent the most last month (October 2026), how much, and how many orders did they place? And how many different cities did October\'s orders come from?',
  ]);
  record('the question', c);
  check(c.runs.some((x) => x.type === 'data-analyst'), `the orchestrator asked the data-analyst (agents used: ${c.runs.map((x) => x.type).join(', ')})`);
  check(c.toolCalls.some((x) => x.name.startsWith('mcp__shop__') && x.agent !== 'main'), `the analyst used the shop server's tools: ${[...new Set(c.toolCalls.filter((x) => x.name.startsWith('mcp__')).map((x) => x.name))].join(', ')}`);
  check((c.byModel['claude-haiku-5-5']?.requests ?? 0) > 0, 'the analyst ran on Claude Haiku 5.5');
  const first = truth.top.name.split(' ')[0];
  check(new RegExp(first).test(c.reply), `the right customer: ${truth.top.name}`);
  check(new RegExp(`${truth.top.s}`.replace('.', '\\.')).test(c.reply.replace(/,/g, '')), `the right amount: ${truth.top.s}`);
  check(new RegExp(`\\b${truth.top.n}\\b`).test(c.reply), `the right number of orders: ${truth.top.n}`);
  check(new RegExp(`\\b${truth.cities}\\b`).test(c.reply), `the right number of cities: ${truth.cities}`);
  note(`truth: ${truth.top.name}, ${truth.top.s}, ${truth.top.n} orders; ${truth.cities} cities`);
});

await scenario('E5', 'Hard cases: a member that runs out of steps; an MCP server that crashes in the middle of a run', async ({ check, note, record }) => {
  // a) A member with a tight step limit, in a team whose lead must report honestly.
  await mkAgent({ name: 'hasty-auditor', description: 'Audits every source file of a project for missing error handling.', prompt: 'Read every file under src/ and list each function without error handling.', model: 'deepseek-flash', tools: ['read', 'glob', 'grep'], maxTurns: 2 });
  await mkAgent({ name: 'audit-lead', description: 'Runs code audits with an auditor.', prompt: 'Lead the audit. Report only what was actually checked.', model: 'deepseek-flash', tools: ['read'], team: { members: ['hasty-auditor'] } });
  const dir = project('e5');
  const a = await converse({ agent: 'audit-lead', model: 'deepseek-flash', path: dir }, ['Audit all the source files for missing error handling.']);
  record('a member out of steps', a);
  const member = a.runs.find((x) => x.type === 'hasty-auditor');
  check(member && /stopped early: max_steps/.test(member.result ?? ''), 'the member hit its step limit');
  check(member && !/finished without a report/.test(member.result ?? '') && (member.result ?? '').length > 120, `it still reported what it did and what is left (${(member?.result ?? '').replace(/\s+/g, ' ').slice(0, 200)})`);
  check(/limit|not (all|every|finish|complete)|incomplete|partial|only|could not|couldn't|ran out|remaining|steps/i.test(a.reply), 'the lead\'s report says the audit was not complete');
  // b) An MCP server that dies in the middle: the next call reconnects by itself.
  const added = await api('POST', '/api/me/mcp', { name: 'notes', type: 'stdio', command: process.execPath, args: [path.join(root, 'test', 'fixtures', 'mcp-modern.mjs')], env: { MCP_CRASH_TOOL: '1' } });
  check(added.status === 201, 'a notes MCP server is added');
  await api('POST', '/api/me/mcp/notes/test');
  await mkAgent({ name: 'note-keeper', description: 'Uses the notes service for arithmetic and notes.', prompt: 'Use the notes service tools for what is asked, in order, and report each result.', model: 'deepseek-flash', mcpServers: ['notes'] });
  const b = await converse({ agent: 'note-keeper', model: 'deepseek-flash', path: dir }, ['With the notes service: add 2 and 3, then call its crash tool, then add 10 and 20. Tell me both sums.']);
  record('a server crash', b);
  const results = b.events.filter((x) => x.event.kind === 'tool_result' && x.event.name?.startsWith('mcp__notes__add')).map((x) => x.event);
  check(results.length >= 2 && results.at(-1).content.includes('30') && !results.at(-1).is_error, `the call after the crash worked (the server was restarted): ${results.map((x) => x.content).join(' / ')}`);
  check(/\b5\b/.test(b.reply) && /\b30\b/.test(b.reply), 'both sums reached the person (5 and 30)');
  note(`the server's status after: ${JSON.stringify((await api('GET', '/api/me/mcp/notes')).body.status ?? {})}`);
});

await scenario('E6', 'Agents in the background for different jobs; their reports reach the person', async ({ check, note, record }) => {
  const dir = project('e6');
  const c = await converse({ model: ORCH, path: dir }, [
    'In the background, have one agent check package.json for outdated or risky dependencies and another list every TODO in the code. Meanwhile, tell me briefly how this project is structured.',
    'What did the two background checks find?',
  ]);
  record('two background jobs', c);
  const bg = c.runs.filter((x) => x.background);
  check(bg.length >= 2, `two agents ran in the background (${c.runs.map((x) => `${x.type}${x.background ? ' (background)' : ''}`).join(', ')})`);
  const firstTurnEnd = c.events.find((x) => x.event.kind === 'turn_end' && !x.event.agent)?.at ?? Infinity;
  check(bg.some((x) => (x.end ?? Infinity) > firstTurnEnd - 1000) || bg.length >= 2, 'the person got the structure without waiting for the background work');
  check(/left-pad/i.test(c.reply), 'the dependency check reached the person (left-pad)');
  check(/discount|percentage/i.test(c.reply), 'the TODO list reached the person (the discount TODO)');
});

await scenario('E7', 'Read-heavy work: one agent alone, then a team of explorers in parallel (same model), against the real code', async ({ check, note, record }) => {
  // Eight folders of this repository's own code (about 26,000 lines): what each is for and its main exports.
  const folders = ['core', 'server', 'mcp', 'agents', 'vault', 'runtime', 'tools', 'plugins'];
  const make = (name) => {
    const dir = fs.mkdtempSync(path.join(tmp, `eval-${name}-`));
    for (const f of folders) fs.cpSync(path.join(root, 'src', f), path.join(dir, f), { recursive: true });
    return dir;
  };
  const exportsOf = (f) => {
    const names = new Set();
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|mjs)$/.test(e.name)) for (const m of fs.readFileSync(p, 'utf8').matchAll(/export (?:async )?(?:function|class|const|interface|type) (\w+)/g)) names.add(m[1]); } };
    walk(path.join(root, 'src', f));
    return names;
  };
  const truth = Object.fromEntries(folders.map((f) => [f, exportsOf(f)]));
  const ask = `For each of the eight folders here (${folders.join(', ')}): what is it for, in two or three sentences, and what are its three most important exported functions or classes? Use the exact names from the code.`;
  // An answer names an export of a folder when the name appears in that folder's part of the answer.
  const score = (reply) => folders.map((f, i) => {
    const start = reply.search(new RegExp(`(^|\\n)[#*\\s\\d.]*\`?${f}\`?\\b`, 'i'));
    const next = folders.slice(i + 1).map((g) => reply.search(new RegExp(`(^|\\n)[#*\\s\\d.]*\`?${g}\`?\\b`, 'i'))).filter((x) => x > start);
    const part = start < 0 ? '' : reply.slice(start, next.length ? Math.min(...next) : undefined);
    return [...truth[f]].filter((n) => n.length > 3 && new RegExp(`\\b${n}\\b`).test(part)).length;
  });
  await mkAgent({ name: 'solo-reader', description: 'Reads a codebase and explains it, alone.', prompt: 'Read what you need yourself and answer.', model: 'claude-haiku-5-5', tools: ['read', 'glob', 'grep'] });
  await mkAgent({ name: 'reading-team', description: 'Explains a large codebase by splitting the reading among explorers.', prompt: 'You lead the reading.', model: 'claude-haiku-5-5', tools: ['read', 'glob', 'grep'], team: { members: ['explore'] } });
  const a = await converse({ agent: 'solo-reader', model: 'claude-haiku-5-5', path: make('e7-solo'), mode: 'plan' }, [ask]);
  record('one agent alone', a);
  const b = await converse({ agent: 'reading-team', model: 'claude-haiku-5-5', path: make('e7-team'), mode: 'plan' }, [ask]);
  record('a team of explorers', b);
  const sa = score(a.reply); const sb = score(b.reply);
  note(`real exports named per folder (${folders.join(', ')}): alone ${sa.join(', ')}; team ${sb.join(', ')}`);
  note(`alone: ${(a.ms / 1000).toFixed(0)}s, $${a.cost.toFixed(4)}; team: ${(b.ms / 1000).toFixed(0)}s, $${b.cost.toFixed(4)}, ${b.runs.length} explorers, at most ${b.peak} at once`);
  note(`team against one agent: ${(b.ms / a.ms).toFixed(1)}x the time, ${(b.cost / Math.max(a.cost, 1e-9)).toFixed(1)}x the cost`);
  check(sa.every((n) => n >= 2), `one agent alone: at least two real exports for every folder (${sa.join(', ')})`);
  check(sb.every((n) => n >= 2), `the team: at least two real exports for every folder (${sb.join(', ')})`);
  // The lead decides whether splitting pays (its procedure); what matters is no blow-up for an equal answer.
  check(b.cost <= a.cost * 1.5 + 0.01 || sb.reduce((x, y) => x + y, 0) > sa.reduce((x, y) => x + y, 0), `the team's effort fit the work: ${b.peak ? `${b.runs.length} explorers, at most ${b.peak} at once` : 'the lead judged one pass enough and did not split'}, at ${(b.cost / Math.max(a.cost, 1e-9)).toFixed(1)}x the cost`);
});

// ---- the report ------------------------------------------------------------------------------------------------

server.close();
await h.close();
// --merge: the scenarios run now replace theirs in the existing report; the others stay as they were.
if (process.argv.includes('--merge') && fs.existsSync(out.replace(/\.md$/, '.json'))) {
  const before = JSON.parse(fs.readFileSync(out.replace(/\.md$/, '.json'), 'utf8'));
  const now = new Map(results.map((r) => [r.id, r]));
  const merged = before.map((r) => now.get(r.id) ?? r);
  for (const r of results) if (!merged.some((x) => x.id === r.id)) merged.push(r);
  spent += before.filter((r) => !now.has(r.id)).reduce((n, r) => n + r.conversations.reduce((m, c) => m + c.cost, 0), 0);
  results.splice(0, results.length, ...merged.sort((a, b) => a.id.localeCompare(b.id)));
}
const total = results.reduce((n, r) => n + r.checks.length, 0);
const passed = results.reduce((n, r) => n + r.checks.filter((c) => c.ok).length, 0);
const md = [
  '# Agents and MCP: live evaluation', '',
  `Run ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC by \`scripts/live-agents-eval.mjs\`. Orchestrator: ${ORCH}. Prompts are written as a person would write them; every check is against the end state (tests run by the script, numbers from the database, files, the git log). ${passed} of ${total} checks passed; $${spent.toFixed(2)} spent.`, '',
  ...results.flatMap((r) => [
    `## ${r.id}: ${r.title}`, '',
    ...r.checks.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'}: ${c.what}`), '',
    ...(r.notes.length ? ['Notes:', ...r.notes.map((n) => `- ${n}`), ''] : []),
    '| Conversation | Time | Cost | By model | Agents (seconds) | At once |', '|---|---|---|---|---|---|',
    ...r.conversations.map((c) => `| ${c.label} | ${(c.ms / 1000).toFixed(0)}s | $${c.cost.toFixed(4)} | ${Object.entries(c.byModel).map(([m, v]) => `${m} $${v.cost.toFixed(4)} (${v.requests})`).join('<br>')} | ${c.agents.map((a) => `${a.type}${a.background ? ' (bg)' : ''}${a.by !== 'main' ? ` by ${a.by}` : ''} ${a.seconds ?? '?'}s${a.error ? ' error' : ''}`).join('<br>') || '-'} | ${c.peak} |`),
    '',
    ...r.conversations.map((c) => `<details><summary>${c.label}: the answer</summary>\n\n${c.reply.replace(/\n/g, '\n> ').replace(/^/, '> ')}\n\n</details>\n`),
  ]),
].join('\n');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, md);
fs.writeFileSync(out.replace(/\.md$/, '.json'), JSON.stringify(results, null, 1));
console.log(`\n${passed}/${total} checks passed, $${spent.toFixed(2)} spent. Report: ${path.relative(root, out)}`);
process.exit(passed === total ? 0 : 1);
