// A live run of answers over the person's own data (phase 2; spends: not part of npm test). Two SQLite databases with
// the traps that make data answers wrong (an order has several item rows, so counting across the join counts it more
// than once; refunded orders and test customers that the definitions exclude; data that ends in March; a relative
// period; a question the data cannot answer), approved definitions beside each, and ten questions a person would ask.
// Each runs the data-answer workflow in a fresh conversation (Claude Haiku 5.5 for five, Claude Sonnet 5.5 for five),
// recomputed on Grok 4.7. Graded from data/answer.md's figures against the truth computed here, not from what the
// agents said; a run counts only when its figures are right.
//   node --env-file=path/to/.env scripts/live-data-answers.mjs [--only 1,4] [--out docs/swarm/EVAL-DATA-ANSWERS]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
const OUT = arg('--out');
const ONLY = arg('--only')?.split(',').map(Number);
const RECOMPUTE = arg('--recompute') ?? 'grok-4.7';
process.env.HARNESS_PLUGIN_LOOPS = 'off';
process.env.HARNESS_MAX_COST_USD = '6';
const has = (...k) => k.some((n) => process.env[n]?.trim());
console.log(`keys: Anthropic ${has('GW_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY') ? 'present' : 'absent'}, xAI ${has('XAI_API_KEY') ? 'present' : 'absent'}`);
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const { createHarness } = await imp('src/kernel/harness.ts');
const { createApp } = await imp('src/server/app.ts');
const { DatabaseSync } = await import('node:sqlite');

// ---------- the data (deterministic) ----------
let seed = 7;
const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
function makeShop(file) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, region TEXT, is_test INTEGER);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, ordered_at TEXT, status TEXT);
    CREATE TABLE order_items (order_id INTEGER, product TEXT, quantity INTEGER, unit_price REAL);`);
  const regions = ['north', 'south', 'east', 'west'];
  for (let c = 1; c <= 60; c++) db.prepare('INSERT INTO customers VALUES (?, ?, ?, ?)').run(c, `Customer ${c}`, regions[c % 4], c > 56 ? 1 : 0);
  const products = [['pen', 1.5], ['ink', 7], ['pad', 4.25], ['desk lamp', 39.9], ['chair', 129]];
  for (let o = 1; o <= 420; o++) {
    const day = Math.floor(rnd() * 89); // 2026-01-01 .. 2026-03-30
    const d = new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10);
    db.prepare('INSERT INTO orders VALUES (?, ?, ?, ?)').run(o, 1 + Math.floor(rnd() * 60), d, rnd() < 0.08 ? 'refunded' : 'paid');
    const lines = 1 + Math.floor(rnd() * 4);
    for (let l = 0; l < lines; l++) { const [p, price] = products[Math.floor(rnd() * products.length)]; db.prepare('INSERT INTO order_items VALUES (?, ?, ?, ?)').run(o, p, 1 + Math.floor(rnd() * 5), price); }
  }
  db.close();
}
function makeHr(file) {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE employees (id INTEGER PRIMARY KEY, name TEXT, department TEXT, hired_on TEXT, left_on TEXT, salary REAL);');
  const depts = ['Engineering', 'Sales', 'Support', 'Finance'];
  for (let e = 1; e <= 180; e++) {
    const hired = new Date(Date.UTC(2019, 0, 1 + Math.floor(rnd() * 2600))).toISOString().slice(0, 10);
    const left = rnd() < 0.3 ? new Date(Math.max(Date.parse(hired) + 86_400_000 * 30, Date.UTC(2022, 0, 1 + Math.floor(rnd() * 1500)))).toISOString().slice(0, 10) : null;
    db.prepare('INSERT INTO employees VALUES (?, ?, ?, ?, ?, ?)').run(e, `Person ${e}`, depts[e % 4], hired, left && left < '2026-10-31' ? left : null, Math.round(40_000 + rnd() * 90_000));
  }
  db.close();
}
const SHOP_SEM = `# Semantics of data/shop.db

Status: approved

## Definitions
- Revenue: SUM(order_items.quantity * order_items.unit_price) over orders with status 'paid', excluding test customers (customers.is_test = 1).
- An order is one row of orders; order_items has one row per product line of an order (several per order).
- Order count: COUNT(DISTINCT orders.id), test customers excluded.
- Average order value: revenue divided by the number of paid orders (test customers excluded).
- Refund rate: refunded orders divided by all orders (paid and refunded), test customers excluded.
- Region: customers.region.

## Pitfalls
- Counting orders across a join to order_items counts an order once per product line.
- ordered_at is a date (YYYY-MM-DD).
`;
const HR_SEM = `# Semantics of data/hr.db

Status: approved

## Definitions
- Headcount on a date D: employees with hired_on <= D and (left_on IS NULL or left_on > D).
- Current employees: left_on IS NULL.
- Leavers in a year: employees whose left_on falls in that calendar year.
- Salary: annual, in euros.
`;

// ---------- the questions, and the truth computed here ----------
const truthOf = (file, sql) => { const db = new DatabaseSync(file, { readOnly: true }); try { return Object.values(db.prepare(sql).get()); } finally { db.close(); } };
const paid = "o.status = 'paid' AND c.is_test = 0";
const QUESTIONS = [
  { db: 'shop', q: 'What was our revenue in February 2026?', truth: (f) => truthOf(f, `SELECT ROUND(SUM(i.quantity * i.unit_price), 2) FROM orders o JOIN customers c ON c.id = o.customer_id JOIN order_items i ON i.order_id = o.id WHERE ${paid} AND o.ordered_at >= '2026-02-01' AND o.ordered_at < '2026-03-01'`) },
  { db: 'shop', q: 'How many orders did we get in the first quarter of 2026?', truth: (f) => truthOf(f, "SELECT COUNT(DISTINCT o.id) FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.is_test = 0 AND o.ordered_at < '2026-04-01'") },
  { db: 'shop', q: 'Which region brought in the most revenue in March 2026, and how much?', truth: (f) => truthOf(f, `SELECT ROUND(SUM(i.quantity * i.unit_price), 2) AS r FROM orders o JOIN customers c ON c.id = o.customer_id JOIN order_items i ON i.order_id = o.id WHERE ${paid} AND o.ordered_at >= '2026-03-01' GROUP BY c.region ORDER BY r DESC LIMIT 1`), also: (f) => truthOf(f, `SELECT c.region FROM orders o JOIN customers c ON c.id = o.customer_id JOIN order_items i ON i.order_id = o.id WHERE ${paid} AND o.ordered_at >= '2026-03-01' GROUP BY c.region ORDER BY SUM(i.quantity * i.unit_price) DESC LIMIT 1`)[0] },
  { db: 'shop', q: "What's our average order value?", truth: (f) => truthOf(f, `SELECT ROUND(SUM(i.quantity * i.unit_price) / COUNT(DISTINCT o.id), 2) FROM orders o JOIN customers c ON c.id = o.customer_id JOIN order_items i ON i.order_id = o.id WHERE ${paid}`) },
  { db: 'shop', q: 'What was revenue in the first half of 2026?', truth: (f) => truthOf(f, `SELECT ROUND(SUM(i.quantity * i.unit_price), 2) FROM orders o JOIN customers c ON c.id = o.customer_id JOIN order_items i ON i.order_id = o.id WHERE ${paid}`), coverage: true },
  { db: 'shop', q: 'What was the refund rate in Q1 2026?', truth: (f) => truthOf(f, "SELECT ROUND(1.0 * SUM(o.status = 'refunded') / COUNT(*), 4) FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.is_test = 0"), rate: true },
  { db: 'hr', q: 'What was our headcount at the end of March 2026?', truth: (f) => truthOf(f, "SELECT COUNT(*) FROM employees WHERE hired_on <= '2026-03-31' AND (left_on IS NULL OR left_on > '2026-03-31')") },
  { db: 'hr', q: 'What is the average salary of the people in Engineering now?', truth: (f) => truthOf(f, "SELECT ROUND(AVG(salary), 2) FROM employees WHERE department = 'Engineering' AND left_on IS NULL") },
  { db: 'hr', q: 'How many people left last year?', truth: (f) => truthOf(f, "SELECT COUNT(*) FROM employees WHERE left_on >= '2025-01-01' AND left_on < '2026-01-01'"), interpretation: true },
  { db: 'hr', q: 'How satisfied were our employees in 2025?', unanswerable: true },
];

const tmp = fs.realpathSync(os.tmpdir());
const data = fs.mkdtempSync(path.join(tmp, 'live-da-'));
const h = await createHarness({ dataDir: data, search: null, memory: 'off', plugins: [path.join(root, 'plugins', 'data-answers')] });
const { server } = createApp({ harness: h, token: 'da-check', loopback: true, localRoots: [tmp], uiDir: path.join(data, 'ui'), appRoot: data });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const api = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { authorization: 'Bearer da-check', 'content-type': 'application/json', 'x-harness': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const t = await r.text(); try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t }; } };
await api('PUT', '/api/me/settings', { delegation: { allowedModels: [RECOMPUTE] } });

const results = [];
let spent = 0;
for (const [i, Q] of QUESTIONS.entries()) {
  if (ONLY && !ONLY.includes(i + 1)) continue;
  const model = i < 5 ? 'claude-haiku-5-5' : 'claude-sonnet-5-5';
  const dir = fs.mkdtempSync(path.join(tmp, `da-${i + 1}-`));
  fs.mkdirSync(path.join(dir, 'data'));
  const file = path.join(dir, 'data', `${Q.db}.db`);
  seed = Q.db === 'shop' ? 7 : 11;
  (Q.db === 'shop' ? makeShop : makeHr)(file);
  fs.writeFileSync(path.join(dir, 'data', `${Q.db}.semantics.md`), Q.db === 'shop' ? SHOP_SEM : HR_SEM);
  const truth = Q.truth ? Number(Q.truth(file)[0]) : undefined;
  const s = h.sessions.get((await api('POST', '/api/sessions', { runtime: 'local', mode: 'bypass', model, path: dir })).body.id);
  let ended = false; let wf = 'none'; let status = '';
  s.subscribe(0, ({ event: e }) => {
    if (e.kind === 'turn_end' && !e.agent) ended = true;
    if (e.kind === 'workflow' && e.phase === 'started') wf = 'running';
    if (e.kind === 'workflow' && e.phase === 'finished') { wf = 'finished'; status = `${e.run?.status ?? ''} ${e.run?.node ?? e.run?.endTitle ?? ''}`.trim(); }
  });
  const t0 = Date.now();
  await s.send(`Run the data-answer workflow on data/${Q.db}.db: ${Q.q}`);
  while (!(ended && wf !== 'running') && Date.now() - t0 < 30 * 60_000) await new Promise((r) => setTimeout(r, 1500));
  const answer = (() => { try { return fs.readFileSync(path.join(dir, 'data', 'answer.md'), 'utf8'); } catch { return ''; } })();
  const recompute = (() => { try { return fs.readFileSync(path.join(dir, 'data', 'recompute.md'), 'utf8'); } catch { return ''; } })();
  // The figures line, as the harness reads it: the last line with {"figures" ...} (a first run read only the very last
  // line, and an answer that put it in a code fence was graded wrong).
  const last = answer.trim().split('\n').reverse().find((l) => /\{.*"figures"/.test(l)) ?? '';
  let figures = {}; try { figures = JSON.parse(/\{.*\}/.exec(last)?.[0] ?? '{}').figures ?? {}; } catch { /* none */ }
  const values = Object.values(figures).map(Number).filter(Number.isFinite);
  const close = (x) => truth !== undefined && values.some((v) => Math.abs(v - truth) <= Math.max(0.005 * Math.abs(truth), 0.01) || (Q.rate && Math.abs(v / 100 - truth) <= 0.0005));
  const checks = [];
  if (Q.unanswerable) checks.push(['says the data cannot answer it', /"unanswerable"/.test(last) && values.length === 0]);
  else checks.push([`the figure is right (truth ${truth})`, close()]);
  if (Q.also) checks.push([`names ${Q.also(file)}`, new RegExp(`\\b${Q.also(file)}\\b`, 'i').test(answer)]);
  if (Q.coverage) checks.push(['says the data ends before the period does', /(only|ends|through|until|up to|not cover|no data|missing)[^.\n]{0,80}(march|30 march|2026-03-30|mar)/i.test(answer)]);
  if (Q.interpretation) checks.push(['states its reading of "last year"', /Interpretation:[^\n]*2025/i.test(answer)]);
  checks.push(['every number traced to a query cell (the provenance gate passed)', !/Numbers without a source/.test(status) && answer.length > 0]);
  checks.push([`recomputed on ${RECOMPUTE}`, new RegExp(`Recomputed on ${RECOMPUTE}`).test(recompute)]);
  const cost = +s.meta.cost.toFixed(4); spent += cost;
  const r = { n: i + 1, db: Q.db, question: Q.q, model, truth, figures, workflow: status, agreed: /\nAgree: /.test(recompute) && !/DISAGREE/.test(recompute), minutes: +((Date.now() - t0) / 60_000).toFixed(1), cost, byModel: Object.fromEntries(Object.entries(s.meta.byModel ?? {}).map(([k, v]) => [k, +v.cost.toFixed(4)])), checks: checks.map(([what, ok]) => ({ what, ok })) };
  results.push(r);
  console.log(`\n=== ${i + 1}. ${Q.q} (${model}; ${status}; ${r.minutes} min; $${cost})`);
  for (const [what, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
  console.log(`  figures: ${JSON.stringify(figures)}${r.agreed ? ' (the recomputation agreed)' : ''}`);
}
const all = results.flatMap((r) => r.checks);
console.log(`\n${all.filter((c) => c.ok).length}/${all.length} checks; right answers ${results.filter((r) => r.checks[0].ok).length}/${results.length}; $${spent.toFixed(4)} spent.`);
if (OUT) fs.writeFileSync(path.join(root, `${OUT}.json`), `${JSON.stringify({ date: new Date().toISOString(), recompute: RECOMPUTE, results }, null, 2)}\n`);
server.close(); await h.close();
