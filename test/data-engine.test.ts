import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { DataService } from '../src/data/service.ts';
import { applyOps, type Actor } from '../src/data/ops.ts';
import { compileDataset } from '../src/data/steps.ts';
import { readXlsx, sheetTable, writeXlsx } from '../src/data/xlsx.ts';
import { tempDir } from './helpers.ts';

// The data engine: sources read into extracts, datasets with steps and parameters, read-only
// queries in a locked DuckDB, limits and cancel, and the semantic model's numbers checked against
// SQL written by hand over the same files.

const ME: Actor = { kind: 'person', label: 'person:test' };

async function fixture() {
  const data = await tempDir();
  const files = path.join(data, 'files');
  await fs.mkdir(files);
  // 2023 and 2024 sales in two regions; one row with a missing region (it must still count in totals).
  const sales = [['id', 'day', 'region_id', 'product', 'amount', 'cost'],
    [1, '2023-01-05', 1, 'A', 100, 60], [2, '2023-02-07', 2, 'B', 50, 20], [3, '2023-03-09', 1, 'A', 80, 50], [4, '2024-01-03', 1, 'B', 120, 70],
    [5, '2024-02-10', 1, 'A', 30, 10], [6, '2024-02-11', 2, 'A', 70, 40], [7, '2024-03-15', 2, 'B', 90, 45], [8, '2024-03-20', null, 'A', 15, 5]];
  await fs.writeFile(path.join(files, 'sales.csv'), sales.map((r) => r.map((v) => v ?? '').join(',')).join('\n') + '\n');
  await fs.writeFile(path.join(files, 'regions.json'), JSON.stringify([{ id: 1, region: 'EU', manager: 'usr_eu' }, { id: 2, region: 'US', manager: 'usr_us' }]));
  await fs.writeFile(path.join(files, 'targets.xlsx'), writeXlsx([{ name: 'Targets', columns: ['region', 'month', 'target'], rows: [['EU', '2024-01-01', 100], ['EU', '2024-02-01', 50], ['US', '2024-02-01', 60], ['US', '2024-03-01', 80]] }]));
  const db = new DatabaseSync(path.join(files, 'shop.sqlite'));
  db.exec("CREATE TABLE products (code TEXT PRIMARY KEY, name TEXT, price REAL); INSERT INTO products VALUES ('A','Apple',1.5),('B','Banana',0.25);");
  db.close();
  const svc = new DataService({ dataDir: data, rootsFor: () => [files], today: () => '2024-03-31' });
  const home = svc.home(undefined);
  const ops = (o: unknown[]) => applyOps(svc, home, o as never, ME);
  await ops([
    { op: 'add_source', source: { id: 'src-sales', name: 'Sales CSV', type: 'file', path: path.join(files, 'sales.csv') } },
    { op: 'add_source', source: { id: 'src-regions', name: 'Regions JSON', type: 'file', path: path.join(files, 'regions.json') } },
    { op: 'add_source', source: { id: 'src-targets', name: 'Targets workbook', type: 'file', path: path.join(files, 'targets.xlsx') } },
    { op: 'add_source', source: { id: 'src-shop', name: 'Shop', type: 'sqlite', path: path.join(files, 'shop.sqlite') } },
    { op: 'define', dataset: { name: 'sales', source: 'src-sales' } },
    { op: 'define', dataset: { name: 'regions', source: 'src-regions' } },
    { op: 'define', dataset: { name: 'targets', source: 'src-targets', from: 'Targets' } },
    { op: 'define', dataset: { name: 'products', source: 'src-shop', from: 'products' } },
    { op: 'add_model', model: { id: 'm', name: 'Sales' } },
    { op: 'set_table', model: 'm', table: { name: 'sales', dataset: 'sales' } },
    { op: 'set_table', model: 'm', table: { name: 'regions', dataset: 'regions' } },
    { op: 'set_table', model: 'm', table: { name: 'products', dataset: 'products' } },
    { op: 'set_relationship', model: 'm', relationship: { from: 'sales.region_id', to: 'regions.id' } },
    { op: 'set_relationship', model: 'm', relationship: { from: 'sales.product', to: 'products.code' } },
    { op: 'set_model', model: 'm', patch: { date: 'sales.day' } },
    { op: 'set_measure', model: 'm', measure: { name: 'Revenue', expr: 'sum(sales.amount)', format: 'currency:USD' } },
    { op: 'set_measure', model: 'm', measure: { name: 'Cost', expr: 'sum(sales.cost)' } },
    { op: 'set_measure', model: 'm', measure: { name: 'Orders', expr: 'count(*)', table: 'sales' } },
    { op: 'set_measure', model: 'm', measure: { name: 'Margin %', expr: '([Revenue] - [Cost]) / [Revenue]', format: 'percent:1' } },
    { op: 'set_measure', model: 'm', measure: { name: 'Units value', expr: 'sum(sales.amount * products.price)' } },
  ]);
  return { data, files, svc, home, ops };
}

test('sources of every kind become extracts: CSV, JSON, Excel (typed: dates, numbers), SQLite; xlsx round trip', async () => {
  const { svc, home, files } = await fixture();
  const sheets = readXlsx(await fs.readFile(path.join(files, 'targets.xlsx')));
  const t = sheetTable(sheets[0]!);
  assert.deepEqual(t.columns.map((c) => `${c.name}:${c.type}`), ['region:VARCHAR', 'month:DATE', 'target:BIGINT']);
  const st = await home.state();
  const cat = (await home.catalog()).spec;
  const byName = (n: string) => st.datasets[cat.datasets.find((d) => d.name === n)!.id]!;
  assert.equal(byName('sales').rows, 8);
  assert.deepEqual(byName('sales').columns!.map((c) => c.type), ['BIGINT', 'DATE', 'BIGINT', 'VARCHAR', 'BIGINT', 'BIGINT']);
  assert.deepEqual(byName('targets').columns!.map((c) => `${c.name}:${c.type}`), ['region:VARCHAR', 'month:DATE', 'target:BIGINT']);
  assert.equal(byName('products').rows, 2);
  assert.match(byName('sales').hash!, /^[0-9a-f]{64}$/);
  const r = await svc.sql(home, 'SELECT sum(target) AS t FROM targets');
  assert.equal(r.rows[0]![0], 290);
  const p = await svc.sql(home, "SELECT name, price FROM products WHERE code = 'A'");
  assert.deepEqual(p.rows, [['Apple', 1.5]]);
});

test('read-only: writes, COPY, ATTACH, INSTALL, PRAGMA, SET, files outside the extracts and several statements are refused', async () => {
  const { svc, home, files } = await fixture();
  const bad = [
    "COPY (SELECT 1) TO 'x.csv'", 'CREATE TABLE t AS SELECT 1', 'INSERT INTO sales VALUES (1)', `ATTACH '${path.join(files, 'x.db').replace(/\\/g, '/')}'`,
    'INSTALL excel', 'PRAGMA database_list', 'SET threads = 8', 'SELECT 1; SELECT 2', `SELECT * FROM read_csv('${path.join(files, 'sales.csv').replace(/\\/g, '/')}')`,
    `SELECT * FROM read_text('${path.join(files, 'regions.json').replace(/\\/g, '/')}')`, "SELECT * FROM glob('*')", 'DROP VIEW sales',
  ];
  for (const sql of bad) await assert.rejects(svc.sql(home, sql), (e: Error) => e.message.length > 0, sql);
  // A dataset's own SQL is held to the same rule.
  await assert.rejects(applyOps(svc, home, [{ op: 'define', dataset: { name: 'evil', sql: "SELECT 1; COPY (SELECT 1) TO 'y.csv'" } }], ME), /one SELECT|statements/);
  assert.equal((await fs.readdir(files)).filter((f) => /x\.db|out|y\.csv/.test(f)).length, 0);
});

test('limits: a row cap (truncated is said), a time limit, and cancel', async () => {
  const { svc, home } = await fixture();
  const r = await svc.sql(home, 'SELECT * FROM range(100)', { limit: 10 });
  assert.equal(r.rowCount, 10); assert.equal(r.truncated, true);
  const slow = 'SELECT count(*) FROM range(100000000000) a, range(100000) b';
  const ctl = new AbortController();
  const t0 = Date.now();
  setTimeout(() => ctl.abort(), 200);
  await assert.rejects(svc.engine.run({ files: [], views: [], sql: slow, signal: ctl.signal }), /cancelled/);
  assert.ok(Date.now() - t0 < 5000);
  await assert.rejects(svc.engine.run({ files: [], views: [], sql: slow, timeoutMs: 300 }), /longer than/);
});

test('datasets: steps compile to SQL and replay, each step previews, parameters bind safely', async () => {
  const { home, svc, ops } = await fixture();
  assert.equal(compileDataset({ id: 'x', name: 'x', steps: [{ op: 'filter', where: 'amount > 0' }, { op: 'rename', columns: { amount: 'value' } }] }, 'base'),
    'WITH s0 AS (SELECT * FROM base),\ns1 AS (SELECT * FROM s0 WHERE (amount > 0)),\ns2 AS (SELECT * RENAME ("amount" AS "value") FROM s1)\nSELECT * EXCLUDE (__rn) FROM s2 ORDER BY __rn');
  const steps = [
    { op: 'filter', where: 'amount >= 30' },
    { op: 'dateparts', column: 'day', parts: ['year', 'monthname'] },
    { op: 'conditional', name: 'size', cases: [{ when: 'amount >= 100', then: 'big' }], else: 'small' },
    { op: 'merge', with: 'regions', on: [['region_id', 'id']], columns: ['region'] },
    { op: 'replace', column: 'regions.region', find: null, with: 'Unknown' },
    { op: 'group', by: ['regions.region', 'day year'], aggs: [{ column: 'amount', fn: 'sum', as: 'total' }, { fn: 'count', as: 'n' }] },
    { op: 'sort', by: [{ column: 'total', desc: true }] },
  ];
  await ops([{ op: 'define', dataset: { name: 'by_region', source: 'src-sales', steps } }]);
  const r = await svc.preview(home, 'by_region');
  assert.deepEqual(r.columns.map((c) => c.name), ['regions.region', 'day year', 'total', 'n']);
  assert.deepEqual(r.rows, [['EU', 2023, 180, 2], ['EU', 2024, 150, 2], ['US', 2024, 160, 2], ['US', 2023, 50, 1]].sort((a, b) => Number(b[2]) - Number(a[2])));
  const step1 = await svc.preview(home, 'by_region', { step: 1 });
  assert.equal(step1.rowCount, 7, 'filter alone');
  // fill down, split, type, unpivot, pivot (its columns fixed when added), dedupe, append.
  await fs.writeFile(path.join(path.dirname((await home.catalog()).spec.sources[0]!.path!), 'messy.csv'), 'grp,name,score_a,score_b\nX,ann smith,1,2\n,bob jones,3,4\nY,cy lee,5,6\n,cy lee,5,6\n');
  await ops([{ op: 'add_source', source: { id: 'src-messy', name: 'Messy', type: 'file', path: path.join(path.dirname((await home.catalog()).spec.sources[0]!.path!), 'messy.csv') } },
    { op: 'define', dataset: { name: 'messy', source: 'src-messy', steps: [{ op: 'filldown', columns: ['grp'] }, { op: 'split', column: 'name', by: ' ', into: ['first', 'last'] }, { op: 'dedupe' }, { op: 'unpivot', columns: ['score_a', 'score_b'], name: 'test', value: 'score' }] } }]);
  const m = await svc.sql(home, 'SELECT grp, first, test, score FROM messy ORDER BY first, test');
  assert.deepEqual(m.rows, [['X', 'ann', 'score_a', 1], ['X', 'ann', 'score_b', 2], ['X', 'bob', 'score_a', 3], ['X', 'bob', 'score_b', 4], ['Y', 'cy', 'score_a', 5], ['Y', 'cy', 'score_b', 6]]);
  const pv = await ops([{ op: 'add_step', dataset: 'messy', step: { op: 'pivot', on: 'test', values: 'score', fn: 'sum' } }]);
  assert.match(pv.results[0]!.message, /added step 4 \(pivot\)/);
  const cat = (await home.catalog()).spec;
  assert.deepEqual((cat.datasets.find((d) => d.name === 'messy')!.steps![4] as { columns: string[] }).columns, ['score_a', 'score_b']);
  assert.deepEqual((await svc.sql(home, 'SELECT grp, first, score_a, score_b FROM messy ORDER BY first')).rows, [['X', 'ann', 1, 2], ['X', 'bob', 3, 4], ['Y', 'cy', 5, 6]]);
  // Parameters: $name binds as a value, never as SQL.
  await ops([{ op: 'define', dataset: { name: 'big', sql: 'SELECT * FROM sales WHERE amount >= $min', params: [{ name: 'min', type: 'number', default: 90 }] } }]);
  assert.equal((await svc.sql(home, 'SELECT count(*) FROM big')).rows[0]![0], 3);
  assert.equal((await svc.sql(home, 'SELECT count(*) FROM big', { params: { 'big.min': 100 } })).rows[0]![0], 2);
  await assert.rejects(svc.sql(home, 'SELECT count(*) FROM big', { params: { 'big.min': "0 OR 1=1; DROP VIEW sales; --" } }), /parameter min is a number/, 'a parameter is a value, never SQL');
  // A step on a missing column is refused with the columns there are.
  await assert.rejects(ops([{ op: 'add_step', dataset: 'sales', step: { op: 'type', column: 'amnt', to: 'double' } }]), /amnt/);
  // Profile: quality and distribution.
  const prof = await svc.profile(home, 'sales');
  const region = prof.columns.find((c) => c.name === 'region_id')!;
  assert.equal(prof.rows, 8); assert.equal(region.nulls, 1); assert.equal(region.distinct, 2);
});

test('semantic model: measures across relationships equal hand-written SQL; derived measures exact at every level; unrelated filters warn', async () => {
  const { svc, home } = await fixture();
  const q = await svc.query(home, { model: 'm', dims: ['regions.region'], measures: ['Revenue', 'Orders', 'Margin %', 'Units value'] });
  const hand = await svc.sql(home, `SELECT r.region, sum(s.amount), count(*), (sum(s.amount) - sum(s.cost)) / sum(s.amount), sum(s.amount * p.price)
    FROM sales s LEFT JOIN regions r ON s.region_id = r.id LEFT JOIN products p ON s.product = p.code GROUP BY 1 ORDER BY 2 DESC`);
  assert.deepEqual(q.rows, hand.rows);
  assert.equal(q.rows.reduce((s, r) => s + Number(r[1]), 0), 555, 'the row without a region is in the total');
  // Subtotals by GROUPING SETS: a ratio at the total is recomputed, never averaged.
  const t = await svc.query(home, { model: 'm', dims: ['regions.region', 'sales.day:year'], measures: ['Revenue', 'Margin %'], totals: { rows: 1 } });
  // The level column tells a subtotal from a row whose region is missing (both have a null region).
  const grand = t.rows.find((r) => r[4] === 3)!;
  assert.equal(t.rows.filter((r) => r[0] === null && r[1] === null).length, 2);
  const g = (await svc.sql(home, 'SELECT sum(amount), (sum(amount) - sum(cost)) / sum(amount) FROM sales')).rows[0]!;
  assert.deepEqual(grand.slice(2, 4), g);
  // Top N by a measure, and a measure filter.
  const top = await svc.query(home, { model: 'm', dims: ['sales.product'], measures: ['Revenue'], filters: [{ field: 'sales.product', op: 'top', n: 1, by: 'Revenue' }] });
  assert.deepEqual(top.rows, [['A', 295]]);
  const gt = await svc.query(home, { model: 'm', dims: ['regions.region'], measures: ['Revenue'], filters: [{ field: 'Revenue', op: 'gt', value: 250 }] });
  assert.deepEqual(gt.rows, [['EU', 330]]);
  // A filter on an unrelated table does not filter, and says so.
  await applyOps(svc, home, [{ op: 'define', dataset: { name: 'targets2', source: 'src-targets' } }, { op: 'set_table', model: 'm', table: { name: 'targets', dataset: 'targets2' } }], ME);
  const w = await svc.query(home, { model: 'm', measures: ['Revenue'], filters: [{ field: 'targets.region', op: 'eq', value: 'EU' }] });
  assert.equal(w.rows[0]![0], 555);
  assert.match(String((w.extra?.warnings as string[])[0]), /does not reach sales/);
  // Lineage: datasets, sources, refresh times and the SQL.
  assert.deepEqual(q.lineage.datasets.map((d) => d.name).sort(), ['products', 'regions', 'sales']);
  assert.ok(q.lineage.datasets.every((d) => d.refreshedAt && d.hash));
  assert.match(q.lineage.sql!, /LEFT JOIN/);
});

test('time intelligence: YTD, previous period, same period last year, YoY %, running total, % of total and rank equal hand-written SQL', async () => {
  const { svc, home, ops } = await fixture();
  await ops([
    { op: 'set_measure', model: 'm', measure: { name: 'Rev YTD', base: 'Revenue', calc: 'ytd' } },
    { op: 'set_measure', model: 'm', measure: { name: 'Rev PP', base: 'Revenue', calc: 'prev_period' } },
    { op: 'set_measure', model: 'm', measure: { name: 'Rev PY', base: 'Revenue', calc: 'prev_year' } },
    { op: 'set_measure', model: 'm', measure: { name: 'YoY %', base: 'Revenue', calc: 'yoy_pct' } },
    { op: 'set_measure', model: 'm', measure: { name: 'Running', base: 'Revenue', calc: 'running_total' } },
    { op: 'set_measure', model: 'm', measure: { name: 'Share', base: 'Revenue', calc: 'pct_of_total' } },
    { op: 'set_measure', model: 'm', measure: { name: 'Rank', base: 'Revenue', calc: 'rank' } },
  ]);
  // Only 2024 shown: the previous year still comes from 2023's rows.
  const r = await svc.query(home, { model: 'm', dims: ['sales.day:month'], measures: ['Revenue', 'Rev YTD', 'Rev PP', 'Rev PY', 'YoY %', 'Running'], filters: [{ field: 'sales.day', op: 'ge', value: '2024-01-01' }] });
  const hand = await svc.sql(home, `WITH m AS (SELECT date_trunc('month', day)::DATE AS mo, sum(amount) AS rev FROM sales GROUP BY 1)
    SELECT mo, rev,
      (SELECT sum(amount) FROM sales WHERE day >= date_trunc('year', m.mo) AND day < m.mo + INTERVAL 1 MONTH),
      (SELECT sum(amount) FROM sales WHERE day >= m.mo - INTERVAL 1 MONTH AND day < m.mo),
      (SELECT sum(amount) FROM sales WHERE day >= m.mo - INTERVAL 1 YEAR AND day < m.mo - INTERVAL 1 YEAR + INTERVAL 1 MONTH),
      (rev - (SELECT sum(amount) FROM sales WHERE day >= m.mo - INTERVAL 1 YEAR AND day < m.mo - INTERVAL 1 YEAR + INTERVAL 1 MONTH)) / (SELECT sum(amount) FROM sales WHERE day >= m.mo - INTERVAL 1 YEAR AND day < m.mo - INTERVAL 1 YEAR + INTERVAL 1 MONTH),
      sum(rev) OVER (ORDER BY mo)
    FROM m WHERE mo >= DATE '2024-01-01' ORDER BY mo`);
  // The running total runs over what is shown (2024 only).
  const expected = hand.rows.map((row) => [...row.slice(0, 6), null]);
  let run = 0; for (const e of expected) { run += Number(e[1]); e[6] = run; }
  assert.deepEqual(r.rows, expected);
  assert.deepEqual(r.rows.map((x) => x[0]), ['2024-01-01', '2024-02-01', '2024-03-01']);
  assert.deepEqual(r.rows[1]!.slice(1, 5), [100, 220, 120, 50]);
  const s = await svc.query(home, { model: 'm', dims: ['regions.region'], measures: ['Revenue', 'Share', 'Rank'] });
  assert.ok(Math.abs(s.rows.reduce((a, x) => a + Number(x[2]), 0) - 1) < 1e-12);
  assert.deepEqual(s.rows.map((x) => x[3]), [1, 2, 3]);
  await assert.rejects(svc.query(home, { model: 'm', dims: ['regions.region'], measures: ['Rev YTD'] }), /needs a date dimension/);
});

test('row-level security: rows filtered in SQL, through relationships, per viewer; no role means no data', async () => {
  const { svc, home, ops } = await fixture();
  await ops([{ op: 'set_role', model: 'm', role: { name: 'Managers', members: ['*'], filters: { regions: 'manager = {user}' } } }]);
  const roles = (await home.catalog()).spec.models[0]!.roles;
  const eu = await svc.query(home, { model: 'm', dims: ['regions.region'], measures: ['Revenue'] }, { owner: false, user: 'usr_eu', roles, showSql: false });
  assert.deepEqual(eu.rows, [['EU', 330]], 'the sales rows of other regions (and without a region) are gone too');
  assert.equal(eu.lineage.sql, undefined, 'no SQL for a viewer');
  const total = await svc.query(home, { model: 'm', measures: ['Revenue'] }, { owner: false, user: 'usr_us', roles, showSql: false });
  assert.equal(total.rows[0]![0], 210);
  await assert.rejects(svc.query(home, { model: 'm', measures: ['Revenue'] }, { owner: false, user: 'x', roles: [], showSql: false }), /no row-level security role/);
});

test('ops: unknown fields and measures are refused with the valid choices; batches are atomic; undo and redo', async () => {
  const { svc, home, ops } = await fixture();
  await assert.rejects(ops([{ op: 'set_measure', model: 'm', measure: { name: 'Bad', expr: 'sum(sales.amnt)' } }]), /amnt/);
  await assert.rejects(ops([{ op: 'set_relationship', model: 'm', relationship: { from: 'regions.id', to: 'sales.region_id' } }]), /repeated value/);
  const c = await ops([{ op: 'create', doc: { type: 'dashboard', title: 'Sales', model: 'm' } }]);
  const id = (c.results[0]!.data as { id: string }).id;
  await assert.rejects(ops([{ op: 'add_visual', doc: id, visual: { type: 'column', query: { dims: ['regions.regoin'], measures: ['Revenue'] } } }]), /no column "regoin" in regions.*region/);
  await assert.rejects(ops([{ op: 'add_visual', doc: id, visual: { type: 'column', query: { dims: ['regions.region'], measures: ['Revnue'] } } }]), /no measure "Revnue".*Revenue/);
  await assert.rejects(ops([{ op: 'add_visual', doc: id, visual: { type: 'spline', query: { measures: ['Revenue'] } } }]), /not one of: card/);
  await assert.rejects(ops([{ op: 'update_visual', doc: id, visual: 'v-nope', patch: { title: 'x' } }]), /no visual "v-nope"/);
  // Atomic: the second op fails, the first is not kept.
  await assert.rejects(ops([{ op: 'add_visual', doc: id, visual: { type: 'card', query: { measures: ['Revenue'] } } }, { op: 'add_visual', doc: id, visual: { type: 'card', query: { measures: ['Nope'] } } }]), /op 2/);
  assert.equal((await home.doc(id)).spec.pages[0]!.visuals.length, 0);
  const a = await ops([{ op: 'add_visual', doc: id, visual: { type: 'card', title: 'Revenue', query: { measures: ['Revenue'] } } }, { op: 'add_visual', doc: id, visual: { type: 'column', query: { dims: ['regions.region'], measures: ['Revenue'] } } }]);
  assert.deepEqual(a.diff.map((l) => l.replace(/v-[0-9a-f]+/, 'v-x')), [`${id}: + visual v-x card "Revenue": Revenue`, `${id}: + visual v-x column: Revenue by regions.region`]);
  const v2 = (a.results[1]!.data as { id: string }).id;
  await ops([{ op: 'update_visual', doc: id, visual: v2, patch: { type: 'bar', options: { stack: 'stacked' } } }]);
  assert.equal((await home.doc(id)).spec.pages[0]!.visuals[1]!.type, 'bar');
  const u = await ops([{ op: 'undo', doc: id }]);
  assert.match(u.results[0]!.message, /undo [\s\S]*~ visual [\s\S]* column/);
  assert.equal((await home.doc(id)).spec.pages[0]!.visuals[1]!.type, 'column');
  await ops([{ op: 'redo', doc: id }]);
  assert.equal((await home.doc(id)).spec.pages[0]!.visuals[1]!.type, 'bar');
  await ops([{ op: 'undo', doc: id }, { op: 'undo', doc: id }]);
  assert.equal((await home.doc(id)).spec.pages[0]!.visuals.length, 0);
  await assert.rejects(ops([{ op: 'undo', doc: id }]), /created by that change/);
  const h = await ops([{ op: 'history', doc: id }]);
  assert.match(h.results[0]!.message, /person:test undo/);
  await ops([{ op: 'restore', doc: id, version: 3 }]);
  assert.equal((await home.doc(id)).spec.pages[0]!.visuals[1]!.type, 'bar');
  // The catalog undoes too.
  await ops([{ op: 'set_measure', model: 'm', measure: { name: 'Tmp', expr: 'max(sales.amount)' } }]);
  await ops([{ op: 'undo', target: 'catalog' }]);
  assert.ok(!(await home.catalog()).spec.models[0]!.measures.some((x) => x.name === 'Tmp'));
  // Removing what something uses is refused.
  await assert.rejects(ops([{ op: 'remove_measure', model: 'm', name: 'Revenue' }]), /used by measure Margin %/);
  void svc;
});

test('verify runs every visual and catches a broken one; narratives accept only computed numbers', async () => {
  const { svc, home, ops, data } = await fixture();
  const c = await ops([{ op: 'create', doc: { type: 'dashboard', title: 'V', model: 'm' } }, { op: 'add_visual', doc: '$new', visual: { type: 'column', query: { dims: ['regions.region'], measures: ['Revenue'] } } }, { op: 'add_visual', doc: '$new', visual: { type: 'narrative', query: { dims: ['regions.region'], measures: ['Revenue'] } } }]);
  const id = (c.results[0]!.data as { id: string }).id;
  const nv = (c.results[2]!.data as { id: string }).id;
  const ok = await ops([{ op: 'verify', doc: id }]);
  assert.match(ok.results[0]!.message, /verified: every visual ran/);
  assert.match(ok.results[0]!.message, /Revenue rows add up to the total \$555\.00/);
  await assert.rejects(ops([{ op: 'set_narrative', doc: id, visual: nv, text: 'Revenue was 999 this year.' }]), /says 999, which no computed result backs/);
  await ops([{ op: 'set_narrative', doc: id, visual: nv, text: 'Revenue reached {{Revenue}}; EU brought {{Revenue[regions.region=EU]}} (330 of it), in 2024 Q1 too.' }]);
  const doc = (await home.doc(id)).spec;
  const { visualData } = await import('../src/data/analytics.ts');
  const n = await visualData(svc, home, doc, doc.pages[0]!.visuals[1]!, {});
  assert.equal(n.extra!.text, 'Revenue reached $555.00; EU brought $330.00 (330 of it), in 2024 Q1 too.');
  // A narrative without a query of its own reads the document's model.
  const bare = await ops([{ op: 'add_visual', doc: id, visual: { type: 'narrative', title: 'Summary' } }]);
  const bv = (bare.results[0]!.data as { id: string }).id;
  await ops([{ op: 'set_narrative', doc: id, visual: bv, text: 'In all, {{Revenue}}.' }]);
  const doc2 = (await home.doc(id)).spec;
  const b = await visualData(svc, home, doc2, doc2.pages[0]!.visuals.find((x) => x.id === bv)!, {});
  assert.equal(b.extra!.text, 'In all, $555.00.');
  // Break the data under a visual: verify says which and why.
  await fs.writeFile(path.join(data, 'files', 'regions.json'), JSON.stringify([{ code: 1, name: 'EU' }]));
  await ops([{ op: 'refresh', dataset: 'regions' }]).catch(() => {});
  const bad = await ops([{ op: 'verify', doc: id }]);
  assert.match(bad.results[0]!.message, /problems found[\s\S]*ERROR/);
});
