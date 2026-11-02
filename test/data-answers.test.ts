import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type Cell, checkProvenance, compareFigures, figuresOf, openDatabase, readOnlySql, runCell } from '../src/data/answers.ts';
import type { HarnessEvent } from '../src/core/types.ts';
import { tempDir } from './helpers.ts';
import { OPERATOR, setupServer, waitFor } from './multi-helpers.ts';

// Answers over the person's own data (docs/swarm/SWARM.md, phase 2): read-only queries kept as cells the agent cannot
// edit, the database's own checks after every query, every number traced to a cell, and the figures recomputed by an
// agent of another family that never sees the first queries.

const here = path.dirname(fileURLToPath(import.meta.url));

/** A small shop: orders, their items (several per order), refunds, customers; the data runs January to March 2026. */
async function shop(dir: string): Promise<string> {
  const { DatabaseSync } = await import('node:sqlite');
  await fs.mkdir(path.join(dir, 'data'), { recursive: true });
  const file = path.join(dir, 'data', 'shop.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, region TEXT);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, ordered_at TEXT, status TEXT);
    CREATE TABLE order_items (order_id INTEGER, product TEXT, quantity INTEGER, unit_price REAL);
    INSERT INTO customers VALUES (1, 'Ada', 'north'), (2, 'Ben', 'south'), (3, 'Cy', 'north');
    INSERT INTO orders VALUES (1, 1, '2026-01-05', 'paid'), (2, 2, '2026-01-20', 'paid'), (3, 1, '2026-02-11', 'refunded'), (4, 3, '2026-03-02', 'paid'), (5, 2, '2026-03-30', 'paid');
    INSERT INTO order_items VALUES (1, 'pen', 2, 1.5), (1, 'ink', 1, 7.0), (2, 'pad', 3, 4.0), (3, 'pen', 10, 1.5), (4, 'ink', 2, 7.0), (4, 'pad', 1, 4.0), (5, 'pen', 4, 1.5);
  `);
  db.close();
  return file;
}

test('only reading: one SELECT, never a write, an attach or a setting', () => {
  assert.equal(readOnlySql('SELECT 1;'), 'SELECT 1');
  assert.equal(readOnlySql("with x as (select 'drop table y' as s) select * from x"), "with x as (select 'drop table y' as s) select * from x", 'a word inside a string is not a statement');
  for (const bad of ['DELETE FROM orders', 'select 1; drop table orders', "ATTACH 'x.db' AS x", 'PRAGMA writable_schema = 1', 'UPDATE orders SET status = 1', 'select * from orders /* ; */ ; insert into orders values (9)']) assert.throws(() => readOnlySql(bad), bad);
});

test('the database\'s own checks: a join that repeats rows, groups that repeat, a period the data does not cover', async () => {
  const db = await openDatabase(await shop(await tempDir()));
  try {
    // Revenue per customer with a join to the items and to the orders: fine (items are summed per order line).
    const ok = runCell(db, 'SELECT c.name, SUM(i.quantity * i.unit_price) AS revenue FROM customers c JOIN orders o ON o.customer_id = c.id JOIN order_items i ON i.order_id = o.id WHERE o.status = \'paid\' GROUP BY c.name ORDER BY c.name', 'q1');
    assert.deepEqual(ok.rows, [['Ada', 10], ['Ben', 18], ['Cy', 18]]);
    // The classic mistake: counting orders across a join to their items counts an order once per item.
    const fan = runCell(db, 'SELECT COUNT(o.id) AS orders FROM orders o JOIN order_items i ON i.order_id = o.id', 'q2');
    assert.equal(fan.rows[0]![0], 7, 'seven, not five');
    assert.ok(fan.checks.some((c) => /^fan-out: order_items\.order_id is not unique/.test(c)), fan.checks.join('\n'));
    // A grouped column shown differently: two rows for one group.
    const grain = runCell(db, "SELECT substr(ordered_at, 1, 7) AS month, status, COUNT(*) FROM orders GROUP BY substr(ordered_at, 1, 7), status", 'q3');
    assert.equal(grain.checks.filter((c) => c.startsWith('grain')).length, 0, 'a proper grouping has no repeats');
    const rep = runCell(db, 'SELECT customer_id, COUNT(*) FROM orders GROUP BY customer_id, status', 'q4');
    assert.ok(rep.checks.some((c) => /^grain: the result has more than one row for \[1\]/.test(c)) || rep.columns.length === 2, rep.checks.join('\n'));
    // Asked for the first half of 2026, the data ends in March.
    const cov = runCell(db, "SELECT COUNT(*) FROM orders WHERE ordered_at >= '2026-01-01' AND ordered_at < '2026-07-01'", 'q5');
    assert.ok(cov.checks.some((c) => /^coverage: orders\.ordered_at: its newest row is from 2026-03-30, 93 days before the window's end \(2026-07-01\)\. Give the figure for the part the data covers/.test(c)), cov.checks.join('\n'));
    // Not a gap (seen live, each made an agent call a question unanswerable): a cutoff, not a window; a quiet last day.
    assert.deepEqual(runCell(db, "SELECT COUNT(*) FROM orders WHERE ordered_at <= '2026-06-30'", 'q6').checks, [], 'a cutoff');
    assert.deepEqual(runCell(db, "SELECT COUNT(*) FROM orders WHERE ordered_at >= '2026-01-01' AND ordered_at < '2026-04-01'", 'q7').checks, [], 'the quarter, its last quiet day');
    assert.match(ok.hash, /^[0-9a-f]{16}$/);
  } finally { db.close(); }
});

test('the provenance rule: every number cites a cell and is in it, or is marked derived; years and dates are not numbers here', () => {
  const cell = (id: string, rows: unknown[][]): Cell => ({ id, sql: 'select', columns: ['x'], rows, count: rows.length, truncated: false, hash: 'h', at: 0, checks: [] });
  const cells = new Map([['q1', cell('q1', [['north', 28], ['south', 18]])], ['q2', cell('q2', [[0.1234]])]]);
  const ok = checkProvenance('Question: Revenue by region in 2026?\n\nNorth made 28 [q1] and south 18 [q1]. Refunds were 12.3% of orders [q2]. Together 46 (derived: 28 + 18) [q1].\n\n{"figures": {"north": 28}}', cells);
  assert.deepEqual(ok.issues, []);
  assert.equal(ok.sentences, 3);
  const bad = checkProvenance('North made 29 [q1]. South made 18. East made 4 [q7]. On 2026-03-30 there were 18 [q1].', cells);
  assert.deepEqual(bad.issues.map((i) => i.problem.split(':')[0]), ['29 is not in [q1]', 'has 18 but cites no query cell', 'cites q7, which no query made']);
  // Rounded as written: 28.0 is 28; 0.12 is 0.1234 to two places; 1,234 is 1234.
  assert.deepEqual(checkProvenance('About 0.12 [q2]. Exactly 28.0 [q1].', cells).issues, []);
});

test('the recomputation compared in code: by name, then by value; a disagreement and a figure only one side has are said', () => {
  assert.deepEqual(figuresOf('the answer\n\n{"figures": {"revenue": "46.0", "orders": 4}}'), { revenue: 46, orders: 4 });
  assert.equal(figuresOf('no line'), undefined);
  const c = compareFigures({ revenue_2026: 46, paid_orders: 4, refund_rate: 0.2 }, { Revenue2026: 46.1, orders_paid: 4, extra: 1 });
  assert.deepEqual(c.agree, ['revenue_2026: 46', 'paid_orders: 4 (as orders_paid)']);
  assert.deepEqual(c.unmatched, ['refund_rate: 0.2 (no matching figure in the recomputation)', 'extra: 1 (only in the recomputation)']);
  assert.deepEqual(compareFigures({ revenue: 46 }, { revenue: 56 }).disagree, ['revenue: 46 against 56']);
});

test('in a conversation: queries kept as cells in the session (not the workspace), draft definitions block queries, the answer checked, and the figures recomputed on another provider', async () => {
  const t = await setupServer({ plugins: [path.join(here, '..', 'plugins', 'data-answers')] });
  try {
    assert.equal((await t.call(OPERATOR, 'PUT', '/api/me/settings', { delegation: { allowedModels: ['claude-sonnet-5-5'] } })).status, 200);
    const dir = await tempDir('hw-data-');
    await shop(dir);
    await fs.writeFile(path.join(dir, 'data', 'shop.semantics.md'), '# Semantics\n\nStatus: draft\n\n- Revenue: SUM(quantity * unit_price) over paid orders.\n');
    const made = await t.call(OPERATOR, 'POST', '/api/sessions', { model: 'deepseek-flash', runtime: 'local', path: dir, mode: 'bypass' });
    const s = t.harness.sessions.get(made.body.id)!;
    const ev: HarnessEvent[] = [];
    s.subscribe(0, ({ event }) => ev.push(event));
    const ends = () => ev.filter((e) => e.kind === 'turn_end' && (!('agent' in e) || !e.agent)).length;
    const turn = async (text: string) => { const n = ends(); await s.send(text); await waitFor(() => ends() > n, 'the turn', 60_000); };
    const result = (name: string) => ev.filter((e): e is Extract<HarnessEvent, { kind: 'tool_result' }> => e.kind === 'tool_result' && e.name === name).at(-1)!;
    const revenue = "SELECT SUM(i.quantity * i.unit_price) AS revenue FROM orders o JOIN order_items i ON i.order_id = o.id WHERE o.status = 'paid'";

    // Draft definitions: nothing is queried until the person approves them.
    t.ds.scripts.lead = [{ calls: [{ name: 'sql_query', input: { db: 'data/shop.db', sql: revenue } }] }, { text: 'Waiting.' }];
    await turn('[[lead]] Revenue?');
    assert.match(result('sql_query').content, /are a draft: the person approves them first/);
    await fs.writeFile(path.join(dir, 'data', 'shop.semantics.md'), '# Semantics\n\nStatus: approved\n\n- Revenue: SUM(quantity * unit_price) over paid orders.\n');

    // Approved: the query runs, its cell is kept in the session's folder (the agent's workspace has no copy to edit).
    t.ds.scripts.lead = [{ calls: [{ name: 'sql_query', input: { db: 'data/shop.db', sql: revenue, purpose: 'revenue' } }] }, { text: 'Queried.' }];
    await turn('[[lead]] Revenue?');
    assert.match(result('sql_query').content, /^\[q1\] 1 row\(s\)[\s\S]*\| 46 \|[\s\S]*Cite it as \[q1\]/);
    assert.ok(JSON.parse(await fs.readFile(path.join((s as unknown as { dir: string }).dir, 'cells.json'), 'utf8')).some((c: Cell) => c.id === 'q1' && c.rows[0]![0] === 46));
    assert.equal((await fs.readdir(dir, { recursive: true })).some((f) => String(f).includes('cells')), false);
    // A write is refused by the tool and by the database.
    t.ds.scripts.lead = [{ calls: [{ name: 'sql_query', input: { db: 'data/shop.db', sql: 'DELETE FROM orders' } }] }, { text: 'No.' }];
    await turn('[[lead]] Clean up.');
    assert.match(result('sql_query').content, /Query refused or failed: only SELECT/);

    // The answer: a number without its cell is caught; then the right one passes.
    const answer = (n: string) => `Question: What was the revenue from paid orders?\nDatabase: data/shop.db\nInterpretation: all paid orders in the data.\n\n## Answer\nRevenue from paid orders was ${n} [q1].\n\n{"figures": {"revenue": ${n}}}\n`;
    await fs.mkdir(path.join(dir, 'data'), { recursive: true });
    await fs.writeFile(path.join(dir, 'data', 'answer.md'), answer('48'));
    t.ds.scripts.lead = [{ calls: [{ name: 'check_answer', input: { path: 'data/answer.md' } }] }, { text: 'Checked.' }];
    await turn('[[lead]] Check it.');
    assert.equal(result('check_answer').is_error, true);
    assert.match(result('check_answer').content, /48 is not in \[q1\]/);
    await fs.writeFile(path.join(dir, 'data', 'answer.md'), answer('46'));
    t.ds.scripts.lead = [{ calls: [{ name: 'check_answer', input: { path: 'data/answer.md' } }] }, { text: 'Checked.' }];
    await turn('[[lead]] Check it.');
    assert.equal(result('check_answer').is_error, false);

    // The recomputation: on Claude (another provider than the conversation's DeepSeek), from the question alone.
    t.ds.scripts.lead = [{ calls: [{ name: 'recompute_answer', input: { path: 'data/answer.md' } }] }, { text: 'Recomputed.' }];
    t.an.scripts.main = [
      { calls: [{ name: 'sql_query', input: { db: 'data/shop.db', sql: "SELECT SUM(quantity * unit_price) FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE status = 'paid')" } }] },
      { text: 'Revenue from paid orders: 46.\n{"figures": {"paid_revenue": 46}}' },
    ];
    await turn('[[lead]] Recompute it.');
    const rc = result('recompute_answer');
    assert.equal(rc.is_error, false, rc.content);
    assert.match(rc.content, /agree with an independent recomputation on claude-sonnet-5-5[\s\S]*Agree: revenue: 46 \(as paid_revenue\)/);
    const brief = JSON.stringify(t.an.requests[0]!.messages);
    assert.ok(brief.includes('What was the revenue from paid orders?') && brief.includes('SUM(quantity * unit_price) over paid orders'), 'the question and the definitions');
    assert.ok(!brief.includes('JOIN order_items'), 'never the first queries');
    assert.match(await fs.readFile(path.join(dir, 'data', 'recompute.md'), 'utf8'), /^# Recomputation of data\/answer\.md/);

    // A recomputation that finds another figure: a disagreement, said.
    t.an.scripts.main = [{ text: 'I count every order.\n{"figures": {"revenue": 61}}' }];
    t.ds.scripts.lead = [{ calls: [{ name: 'recompute_answer', input: { path: 'data/answer.md' } }] }, { text: 'Recomputed.' }];
    await turn('[[lead]] Recompute it.');
    assert.equal(result('recompute_answer').is_error, true);
    assert.match(result('recompute_answer').content, /DISAGREE: revenue: 46 against 61/);
  } finally { await t.close(); }
});
