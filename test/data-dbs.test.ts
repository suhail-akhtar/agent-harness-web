import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { applyOps } from '../src/data/ops.ts';
import { DataService } from '../src/data/service.ts';
import { tempDir } from './helpers.ts';
import { delay } from './multi-helpers.ts';

// Postgres and MySQL sources against real servers in Docker (postgres:16-alpine, mysql:8.0):
// read in read-only transactions, numeric types kept exact, the password read from the vault (a
// stand-in here), and a write through a "query" refused by the database itself. Skipped clearly
// when Docker or the images are not here (HARNESS_TEST_DATA_DBS=0 skips them too).

const docker = (...a: string[]) => spawnSync('docker', a, { encoding: 'utf8', timeout: 120_000 });
const have = (img: string) => process.env.HARNESS_TEST_DATA_DBS !== '0' && docker('image', 'inspect', img).status === 0;
const PW = 'pw-9f8e7d';

async function container(image: string, env: string[], port: number): Promise<{ id: string; port: number; stop(): void }> {
  const r = docker('run', '-d', '--rm', ...env.flatMap((e) => ['-e', e]), '-p', `127.0.0.1::${port}`, image);
  if (r.status !== 0) throw new Error(r.stderr);
  const id = r.stdout.trim();
  const mapped = Number(/:(\d+)\s*$/.exec(docker('port', id, String(port)).stdout.trim().split('\n')[0]!)![1]);
  return { id, port: mapped, stop: () => { spawnSync('docker', ['rm', '-f', id], { timeout: 60_000 }); } };
}

async function service(): Promise<DataService> {
  const data = await tempDir();
  // A vault stand-in: the engine asks for the entry by name and gets the value on the server.
  const asked: string[] = [];
  const svc = new DataService({ dataDir: data, vault: { reveal: async (_a: unknown, name: string) => { asked.push(name); if (name !== 'db-pw') throw new Error('no such entry'); return PW; } } as never });
  (svc as unknown as { asked: string[] }).asked = asked;
  return svc;
}

test('Postgres source: tables listed, a table and a query read read-only, numerics exact, writes refused', { timeout: 180_000 }, async (t) => {
  if (!have('postgres:16-alpine')) { t.skip('docker or postgres:16-alpine not available'); return; }
  const c = await container('postgres:16-alpine', [`POSTGRES_PASSWORD=${PW}`, 'POSTGRES_DB=shop'], 5432);
  try {
    for (let i = 0; i < 60; i++) { if (spawnSync('docker', ['exec', c.id, 'pg_isready', '-U', 'postgres', '-d', 'shop']).status === 0) break; await delay(1000); }
    await delay(1500);
    execFileSync('docker', ['exec', c.id, 'psql', '-U', 'postgres', '-d', 'shop', '-c', "CREATE TABLE orders (id int primary key, region text, amount numeric(12,2), day date); INSERT INTO orders VALUES (1,'EU',10.10,'2024-01-02'),(2,'US',20.20,'2024-01-05'),(3,'EU',0.30,'2024-02-01');"]);
    const svc = await service();
    const home = svc.home(undefined);
    const ops = (o: unknown[]) => applyOps(svc, home, o as never, { kind: 'person', label: 'person:t' });
    await ops([{ op: 'add_source', source: { id: 'src-pg', name: 'Shop', type: 'postgres', host: '127.0.0.1', port: c.port, database: 'shop', user: 'postgres', secret: 'db-pw' } }]);
    const listed = await ops([{ op: 'test_source', id: 'src-pg' }]);
    assert.match(listed.results[0]!.message, /public\.orders/);
    await ops([{ op: 'define', dataset: { name: 'orders', source: 'src-pg', from: 'public.orders' } }, { op: 'define', dataset: { name: 'eu', source: 'src-pg', from: "SELECT * FROM orders WHERE region = 'EU'" } }]);
    const r = await svc.sql(home, 'SELECT sum(amount) AS s, typeof(sum(amount)) AS t, min(day) AS d FROM orders');
    assert.equal(r.rows[0]![0], 30.6, 'numeric(12,2) summed exactly (10.10 + 20.20 + 0.30)');
    assert.match(String(r.rows[0]![1]), /DECIMAL/);
    assert.equal(r.rows[0]![2], '2024-01-02');
    assert.equal((await svc.sql(home, 'SELECT count(*) FROM eu')).rows[0]![0], 2);
    assert.deepEqual((svc as unknown as { asked: string[] }).asked.filter((x) => x === 'db-pw').length > 0, true);
    // A "query" that writes is refused by the database (read-only transaction).
    await assert.rejects(ops([{ op: 'define', dataset: { name: 'evil', source: 'src-pg', from: 'SELECT * FROM orders; DELETE FROM orders' } }]), /one SELECT/);
    await assert.rejects(ops([{ op: 'define', dataset: { name: 'evil2', source: 'src-pg', from: 'WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d' } }]), /read-only/i);
    assert.match(execFileSync('docker', ['exec', c.id, 'psql', '-U', 'postgres', '-d', 'shop', '-tAc', 'SELECT count(*) FROM orders'], { encoding: 'utf8' }), /3/);
  } finally { c.stop(); }
});

test('MySQL source: a table read read-only with exact decimals; writes refused', { timeout: 240_000 }, async (t) => {
  if (!have('mysql:8.0.46')) { t.skip('docker or mysql:8.0.46 not available'); return; }
  const c = await container('mysql:8.0.46', [`MYSQL_ROOT_PASSWORD=${PW}`, 'MYSQL_DATABASE=shop'], 3306);
  try {
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) { ready = spawnSync('docker', ['exec', c.id, 'mysql', '-uroot', `-p${PW}`, '-e', 'SELECT 1', 'shop']).status === 0; if (!ready) await delay(1000); }
    assert.ok(ready, 'mysql started');
    execFileSync('docker', ['exec', c.id, 'mysql', '-uroot', `-p${PW}`, 'shop', '-e', "CREATE TABLE orders (id int primary key, region varchar(8), amount decimal(12,2), day date); INSERT INTO orders VALUES (1,'EU',10.10,'2024-01-02'),(2,'US',20.20,'2024-01-05'),(3,'EU',0.30,'2024-02-01');"]);
    const svc = await service();
    const home = svc.home(undefined);
    const ops = (o: unknown[]) => applyOps(svc, home, o as never, { kind: 'person', label: 'person:t' });
    // Connect on TCP to the mapped port (the user root may come from the host).
    await ops([{ op: 'add_source', source: { id: 'src-my', name: 'Shop', type: 'mysql', host: '127.0.0.1', port: c.port, database: 'shop', user: 'root', secret: 'db-pw' } },
      { op: 'define', dataset: { name: 'orders', source: 'src-my', from: 'orders' } }]);
    const r = await svc.sql(home, 'SELECT sum(amount), count(*), max(day) FROM orders');
    assert.deepEqual(r.rows[0], [30.6, 3, '2024-02-01']);
    await assert.rejects(ops([{ op: 'define', dataset: { name: 'evil', source: 'src-my', from: "SELECT * FROM orders WHERE region = 'x' FOR UPDATE" } }]), /read|READ ONLY|denied|lock/i);
  } finally { c.stop(); }
});

test('MongoDB source: collections listed; nested documents flattened into columns; an array unnested into rows; a query filter', { timeout: 240_000 }, async (t) => {
  if (!have('mongo:7.0')) { t.skip('docker or mongo:7.0 not available'); return; }
  const c = await container('mongo:7.0', ['MONGO_INITDB_ROOT_USERNAME=root', `MONGO_INITDB_ROOT_PASSWORD=${PW}`], 27017);
  try {
    const sh = (js: string) => spawnSync('docker', ['exec', c.id, 'mongosh', '--quiet', '-u', 'root', '-p', PW, '--authenticationDatabase', 'admin', 'shop', '--eval', js], { encoding: 'utf8', timeout: 60_000 });
    for (let i = 0; i < 60; i++) { if (sh('db.runCommand({ping:1}).ok').stdout.trim() === '1') break; await delay(1000); }
    const r0 = sh(`db.orders.insertMany([
      { _id: 1, day: ISODate('2024-01-03'), status: 'paid', customer: { name: 'Ada', address: { city: 'Paris', zip: '75001' } }, items: [{ sku: 'A', qty: 2, price: 1.5 }, { sku: 'B', qty: 1, price: 4 }], total: NumberDecimal('7.00') },
      { _id: 2, day: ISODate('2024-01-04'), status: 'paid', customer: { name: 'Bo', address: { city: 'Lyon', zip: '69001' } }, items: [{ sku: 'A', qty: 5, price: 1.5 }], total: NumberDecimal('7.50') },
      { _id: 3, day: ISODate('2024-01-05'), status: 'void', customer: { name: 'Cy', address: { city: 'Paris', zip: '75002' } }, items: [], total: NumberDecimal('0') }
    ]).acknowledged`);
    assert.match(r0.stdout, /true/, r0.stderr);
    const svc = await service();
    const home = svc.home(undefined);
    const ops = (o: unknown[]) => applyOps(svc, home, o as never, { kind: 'person', label: 'person:t' });
    await assert.rejects(ops([{ op: 'add_source', source: { name: 'bad', type: 'mongodb', url: `mongodb://root:${PW}@127.0.0.1:${c.port}`, database: 'shop' } }]), /no credentials in the URL/);
    await ops([{ op: 'add_source', source: { id: 'src-mg', name: 'Shop', type: 'mongodb', host: '127.0.0.1', port: c.port, database: 'shop', user: 'root', secret: 'db-pw' } }]);
    assert.match((await ops([{ op: 'test_source', id: 'src-mg' }])).results[0]!.message, /orders/);
    await ops([
      { op: 'define', dataset: { name: 'orders', source: 'src-mg', from: 'orders' } },
      { op: 'add_source', source: { id: 'src-mg-items', name: 'Shop items', type: 'mongodb', host: '127.0.0.1', port: c.port, database: 'shop', user: 'root', secret: 'db-pw', unnest: 'items', filter: { status: 'paid' } } },
      { op: 'define', dataset: { name: 'items', source: 'src-mg-items', from: 'orders' } },
    ]);
    const cols = (await svc.sql(home, 'SELECT * FROM orders LIMIT 1')).columns.map((x) => x.name);
    for (const k of ['_id', 'customer_name', 'customer_address_city', 'customer_address_zip', 'total']) assert.ok(cols.includes(k), `column ${k} in ${cols.join(', ')}`);
    assert.deepEqual((await svc.sql(home, 'SELECT customer_address_city, count(*), sum(total) FROM orders GROUP BY 1 ORDER BY 1')).rows, [['Lyon', 1, 7.5], ['Paris', 2, 7]]);
    // One row per item of the paid orders, with the order's fields beside the item's.
    assert.deepEqual((await svc.sql(home, 'SELECT items_sku, sum(items_qty), sum(items_qty * items_price), count(DISTINCT _id) FROM items GROUP BY 1 ORDER BY 1')).rows, [['A', 7, 10.5, 2], ['B', 1, 4, 1]]);
    assert.equal((await svc.sql(home, 'SELECT min(day) FROM items')).rows[0]![0], '2024-01-03 00:00:00');
  } finally { c.stop(); }
});

test('SQL Server source (tedious, no ODBC): read-only, types mapped', { timeout: 300_000 }, async (t) => {
  const img = 'mcr.microsoft.com/mssql/server:2022-latest';
  if (!have(img)) { t.skip(`docker or ${img} not available (SQL Server sources are read with tedious; this test runs where the image is)`); return; }
  const pw = `Aa1!${PW}`;
  const c = await container(img, ['ACCEPT_EULA=Y', `MSSQL_SA_PASSWORD=${pw}`], 1433);
  try {
    const sql = (q: string) => spawnSync('docker', ['exec', c.id, '/opt/mssql-tools18/bin/sqlcmd', '-C', '-S', 'localhost', '-U', 'sa', '-P', pw, '-Q', q], { encoding: 'utf8', timeout: 60_000 });
    for (let i = 0; i < 90; i++) { if (sql('SELECT 1').status === 0) break; await delay(1000); }
    sql('CREATE DATABASE shop;');
    sql("USE shop; CREATE TABLE orders (id int primary key, region nvarchar(10), amount decimal(12,2), day date); INSERT INTO orders VALUES (1,'EU',10.10,'2024-01-02'),(2,'US',20.20,'2024-01-03');");
    const svc = new DataService({ dataDir: await tempDir(), vault: { reveal: async () => pw } as never });
    const home = svc.home(undefined);
    const ops = (o: unknown[]) => applyOps(svc, home, o as never, { kind: 'person', label: 'person:t' });
    await ops([{ op: 'add_source', source: { id: 'src-ms', name: 'Shop', type: 'mssql', host: '127.0.0.1', port: c.port, database: 'shop', user: 'sa', secret: 'db-pw' } }, { op: 'define', dataset: { name: 'orders', source: 'src-ms', from: 'dbo.orders' } }]);
    assert.deepEqual((await svc.sql(home, 'SELECT count(*), sum(amount), min(day) FROM orders')).rows[0], [2, 30.3, '2024-01-02']);
  } finally { c.stop(); }
});
