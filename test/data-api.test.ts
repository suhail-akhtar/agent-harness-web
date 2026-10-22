import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { OPS, UI_ACTIONS } from '../packages/plugin-ui/src/bi.ts';
import { validateUiManifest } from '../packages/plugin-ui/src/manifest.ts';
import type { HarnessEvent } from '../src/core/types.ts';
import { DATA_TOOLS } from '../src/data/tools.ts';
import { tempDir } from './helpers.ts';
import { delay, OPERATOR, record, setupServer, turnsEnded, waitFor } from './multi-helpers.ts';

// core.dashboards over HTTP: the op API, an API source whose token lives in the vault (never in a
// payload), published pages (token and signed-in access, no SQL or credentials, row-level
// security, live updates over SSE, unpublish cuts access), schedules and alerts on a fake clock,
// cross-highlight and drill-through, and the agents' tools.

const SECRET = 'sekret-token-4c1d9b';

async function mockApi() {
  let orders = [{ id: 1, region: 'EU', amount: 100, day: '2024-01-03' }, { id: 2, region: 'US', amount: 50, day: '2024-01-09' }, { id: 3, region: 'EU', amount: 25, day: '2024-02-01' }];
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(String(req.headers.authorization ?? ''));
    if (req.headers.authorization !== `Bearer ${SECRET}`) { res.writeHead(401); res.end('no'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { items: orders } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/orders`, host: `127.0.0.1:${port}`, seen, set: (o: typeof orders) => { orders = o; }, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** An SSE reader for published pages. */
async function sse(url: string, headers: Record<string, string>) {
  const ctl = new AbortController();
  const res = await fetch(url, { headers, signal: ctl.signal });
  const got: Array<{ type: string }> = [];
  let buf = '';
  void (async () => { const rd = res.body!.getReader(); const dec = new TextDecoder(); try { for (;;) { const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const d = /^data: (.*)$/m.exec(buf.slice(0, i))?.[1]; buf = buf.slice(i + 2); if (d) got.push(JSON.parse(d)); } } } catch { /* closed */ } })();
  await delay(50);
  return { status: res.status, got, close: () => ctl.abort() };
}

test('API source with a vault secret, published page (token), live SSE refresh, RLS by role, no SQL or credentials leaked, unpublish', async () => {
  const api = await mockApi();
  const t = await setupServer({ env: { HARNESS_DATA_PRIVATE_HOSTS: api.host } });
  try {
    const ops = async (o: unknown[]) => { const r = await t.call(OPERATOR, 'POST', '/api/data/ops', { ops: o }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
    assert.equal((await t.call(OPERATOR, 'POST', '/api/vault/entries', { name: 'orders-api', value: SECRET, kind: 'token' })).status, 201);
    // A credential written into a source is refused: it belongs in the vault.
    const bad = await t.call(OPERATOR, 'POST', '/api/data/ops', { op: 'add_source', source: { name: 'x', type: 'http', url: api.url, token: SECRET } });
    assert.equal(bad.status, 400); assert.match(bad.body.error, /key vault/);
    await ops([
      { op: 'add_source', source: { id: 'src-api', name: 'Orders API', type: 'http', url: api.url, rowsPath: 'data.items', secret: 'orders-api', auth: 'bearer' } },
      { op: 'define', dataset: { name: 'orders', source: 'src-api', steps: [{ op: 'type', column: 'day', to: 'date' }] } },
      { op: 'add_model', model: { id: 'shop', name: 'Shop' } },
      { op: 'set_table', model: 'shop', table: { name: 'orders', dataset: 'orders' } },
      { op: 'set_measure', model: 'shop', measure: { name: 'Revenue', expr: 'sum(orders.amount)', format: 'currency:USD' } },
      { op: 'set_role', model: 'shop', role: { name: 'EU only', members: [], filters: { orders: "region = 'EU'" } } },
      { op: 'create', doc: { type: 'dashboard', title: 'Orders', model: 'shop' } },
      { op: 'add_visual', doc: '$new', visual: { id: 'v-total', type: 'card', title: 'Revenue', query: { measures: ['Revenue'] } } },
      { op: 'add_visual', doc: '$new', visual: { id: 'v-region', type: 'column', title: 'By region', query: { dims: ['orders.region'], measures: ['Revenue'] } } },
      { op: 'add_visual', doc: '$new', visual: { id: 'v-month', type: 'line', title: 'By month', query: { dims: ['orders.day:month'], measures: ['Revenue'] } } },
    ]);
    assert.ok(api.seen.every((h) => h === `Bearer ${SECRET}`));
    const catalog = await t.call(OPERATOR, 'GET', '/api/data/catalog');
    assert.ok(!catalog.text.includes(SECRET), 'the catalog never carries the secret');
    assert.equal(catalog.body.datasets[0].state.rows, 3);
    const docs = await t.call(OPERATOR, 'GET', '/api/data/docs');
    const id = docs.body[0].id as string;
    // In the app: cross-highlight (the region chart under a month selection) and drill-through context.
    const hl = await t.call(OPERATOR, 'POST', `/api/data/docs/${id}/visual`, { visual: 'v-region', state: { selection: { visual: 'v-month', filters: [{ field: 'orders.day:month', op: 'eq', value: '2024-02-01' }] } } });
    assert.deepEqual(hl.body.rows, [['EU', 125], ['US', 50]]);
    assert.deepEqual(hl.body.highlight, [[25], [null]], 'highlighted part under the selection, aligned with the rows');
    const filtered = await t.call(OPERATOR, 'POST', `/api/data/docs/${id}/visual`, { visual: 'v-total', state: { selection: { visual: 'v-region', filters: [{ field: 'orders.region', op: 'eq', value: 'US' }] } } });
    assert.deepEqual(filtered.body.rows, [[50]], 'a card is filtered by a selection');
    assert.match(filtered.body.lineage.sql, /SELECT/);

    // Publish with a token: the page, the doc without SQL, numbers equal to direct SQL.
    const pub = await ops([{ op: 'publish', doc: id, access: 'token' }]);
    const { slug, token, url } = pub.results[0].data as { slug: string; token: string; url: string };
    assert.match(url, new RegExp(`/p/${slug}#t=hwp_`));
    const page = await fetch(`${t.base}/p/${slug}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self'/);
    assert.match(await page.text(), /data-bi-viewer/);
    assert.equal((await fetch(`${t.base}/p/${slug}/api/doc`)).status, 401, 'no token, no data');
    assert.equal((await fetch(`${t.base}/p/${slug}/api/doc`, { headers: { 'x-harness-share': 'hwp_wrong' } })).status, 401);
    const H = { 'x-harness-share': token, 'content-type': 'application/json' };
    const docRes = await fetch(`${t.base}/p/${slug}/api/doc`, { headers: H });
    const docText = await docRes.text();
    assert.equal(docRes.status, 200);
    for (const s of [SECRET, api.url, 'orders-api', 'sum(orders', 'SELECT']) assert.ok(!docText.includes(s), `the published doc does not carry ${s}`);
    const pv = async (visual: string, state: unknown = {}) => { const r = await fetch(`${t.base}/p/${slug}/api/visual`, { method: 'POST', headers: H, body: JSON.stringify({ visual, state }) }); return { status: r.status, body: await r.json() as { rows: unknown[][]; lineage: { sql?: string }; error?: string }, text: '' }; };
    const total = await pv('v-total');
    const direct = await t.call(OPERATOR, 'POST', '/api/data/query', { sql: 'SELECT sum(amount) FROM orders' });
    assert.deepEqual(total.body.rows, direct.body.rows);
    assert.equal(total.body.lineage.sql, undefined);
    assert.ok(!JSON.stringify(total.body).includes(api.url));
    // A viewer cannot filter on fields the page does not show.
    assert.equal((await pv('v-total', { filters: [{ field: 'orders.id', op: 'eq', value: 1 }] })).status, 403);
    assert.deepEqual((await pv('v-total', { filters: [{ field: 'orders.region', op: 'in', values: ['EU'] }] })).body.rows, [[125]]);

    // Live: the page listens; the data changes at the source; a refresh pushes the news; it re-queries.
    const live = await sse(`${t.base}/p/${slug}/api/events`, { 'x-harness-share': token });
    assert.equal(live.status, 200);
    api.set([{ id: 1, region: 'EU', amount: 100, day: '2024-01-03' }, { id: 2, region: 'US', amount: 500, day: '2024-01-09' }]);
    await ops([{ op: 'refresh', doc: id }]);
    await waitFor(() => live.got.some((e) => e.type === 'refreshed'), 'refreshed over SSE');
    assert.deepEqual((await pv('v-total')).body.rows, [[600]]);

    // Row-level security on a published link: the role's rows only.
    const rls = await ops([{ op: 'publish', doc: id, access: 'token', role: 'EU only' }]);
    const tk2 = (rls.results[0].data as { token: string }).token;
    assert.equal((await fetch(`${t.base}/p/${slug}/api/doc`, { headers: { 'x-harness-share': token } })).status, 401, 'publishing again makes a new token');
    const eu = await fetch(`${t.base}/p/${slug}/api/visual`, { method: 'POST', headers: { 'x-harness-share': tk2, 'content-type': 'application/json' }, body: JSON.stringify({ visual: 'v-region', state: {} }) });
    assert.deepEqual(((await eu.json()) as { rows: unknown[] }).rows, [['EU', 100]]);

    // Unpublish: refused at once; the live page is told.
    const live2 = await sse(`${t.base}/p/${slug}/api/events`, { 'x-harness-share': tk2 });
    await ops([{ op: 'unpublish', doc: id }]);
    await waitFor(() => live2.got.some((e) => e.type === 'gone'), 'gone over SSE');
    assert.equal((await fetch(`${t.base}/p/${slug}`)).status, 404);
    assert.equal((await fetch(`${t.base}/p/${slug}/api/doc`, { headers: { 'x-harness-share': tk2 } })).status, 404);
    live.close(); live2.close();
  } finally { await t.close(); await api.close(); }
});

test('published to signed-in accounts: only the accounts it is shared with; RLS by membership', async () => {
  const t = await setupServer();
  try {
    const files = await tempDir();
    await fs.writeFile(path.join(files, 'sales.csv'), 'region,amount\nEU,10\nUS,20\nEU,5\n');
    const alice = await t.member('alice');
    const bob = await t.member('bob');
    const carol = await t.member('carol');
    const ops = async (o: unknown[]) => { const r = await t.call(alice.token, 'POST', '/api/data/ops', { ops: o }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
    // A member's file must be in their own folders: an upload.
    const up = await t.call(alice.token, 'POST', '/api/data/uploads', { name: 'sales.csv', base64: Buffer.from(await fs.readFile(path.join(files, 'sales.csv'))).toString('base64') });
    assert.equal(up.status, 200);
    const outside = await t.call(alice.token, 'POST', '/api/data/ops', { op: 'add_source', source: { name: 'x', type: 'file', path: path.join(files, 'sales.csv') } });
    assert.equal(outside.status, 200, 'adding is allowed; reading is checked');
    const read = await t.call(alice.token, 'POST', '/api/data/ops', { op: 'define', dataset: { name: 'nope', source: outside.body.results[0].data.id } });
    assert.equal(read.status, 403); assert.match(read.body.error, /outside the folders/);
    const r = await ops([
      { op: 'add_source', source: { id: 'src-up', name: 'Upload', type: 'file', path: up.body.path } },
      { op: 'define', dataset: { name: 'sales', source: 'src-up' } },
      { op: 'add_model', model: { id: 'm', name: 'M' } }, { op: 'set_table', model: 'm', table: { name: 'sales', dataset: 'sales' } },
      { op: 'set_measure', model: 'm', measure: { name: 'Total', expr: 'sum(sales.amount)' } },
      { op: 'set_role', model: 'm', role: { name: 'Bob EU', members: [bob.id], filters: { sales: "region = 'EU'" } } },
      { op: 'create', doc: { type: 'dashboard', title: 'Team', model: 'm' } },
      { op: 'add_visual', doc: '$new', visual: { id: 'v-t', type: 'card', query: { measures: ['Total'] } } },
    ]);
    const id = r.results.find((x: { op: string }) => x.op === 'create').data.id;
    const p = await ops([{ op: 'publish', doc: id, access: 'signed-in', accounts: [bob.id, carol.id] }]);
    const slug = p.results[0].data.slug;
    assert.equal(p.results[0].data.token, undefined);
    const get = (tok: string | undefined, sub: string, body?: unknown) => fetch(`${t.base}/p/${slug}/api/${sub}`, { method: body ? 'POST' : 'GET', headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    assert.equal((await get(undefined, 'doc')).status, 401);
    const dan = await t.member('dan');
    assert.equal((await get(dan.token, 'doc')).status, 403, 'not shared with dan');
    const bobR = await (await get(bob.token, 'visual', { visual: 'v-t' })).json() as { rows: unknown[] };
    assert.deepEqual(bobR.rows, [[15]], 'bob sees EU only');
    assert.equal((await get(carol.token, 'visual', { visual: 'v-t' })).status, 403, 'carol has no role in a model with roles: no data');
    // Members never see each other's data in the app.
    assert.equal((await t.call(bob.token, 'GET', `/api/data/docs/${id}`)).status, 404);
  } finally { await t.close(); }
});

test('schedules on a fake clock: interval refresh, cron, alerts that fire once and recover, failure recorded and announced', async () => {
  const t = await setupServer();
  try {
    const files = await tempDir();
    const csv = path.join(files, 'm.csv');
    await fs.writeFile(csv, 'v\n5\n');
    const data = t.harness.data;
    const home = data.home(undefined);
    await t.harness.data.grantRoot(home, files);
    const events: Array<Record<string, unknown>> = [];
    data.on((e) => events.push(e));
    const ops = async (o: unknown[]) => { const r = await t.call(OPERATOR, 'POST', '/api/data/ops', { ops: o }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
    const r = await ops([
      { op: 'add_source', source: { id: 'src-m', name: 'M', type: 'file', path: csv } },
      { op: 'define', dataset: { name: 'metric', source: 'src-m', refresh: { mode: 'interval', every: 60 } } },
      { op: 'add_model', model: { id: 'm', name: 'M' } }, { op: 'set_table', model: 'm', table: { name: 'metric', dataset: 'metric' } },
      { op: 'set_measure', model: 'm', measure: { name: 'Value', expr: 'sum(metric.v)' } },
      { op: 'create', doc: { type: 'dashboard', title: 'Mon', model: 'm' } },
      { op: 'add_visual', doc: '$new', visual: { type: 'card', query: { measures: ['Value'] } } },
      { op: 'set_refresh', doc: '$new', refresh: { mode: 'cron', cron: '0 * * * *' } },
      { op: 'add_alert', doc: '$new', alert: { name: 'Too high', measure: 'Value', op: 'gt', value: 10, notify: true } },
    ]);
    const id = r.results.find((x: { op: string }) => x.op === 'create').data.id;
    const st0 = (await home.state()).datasets;
    const at0 = Object.values(st0)[0]!.at!;
    // 30 s later: not due. 61 s later: due.
    await data.tick(at0 + 30_000);
    assert.equal(Object.values((await home.state()).datasets)[0]!.at, at0);
    await fs.writeFile(csv, 'v\n50\n');
    await data.tick(at0 + 61_000);
    assert.equal(Object.values((await home.state()).datasets)[0]!.rows, 1);
    assert.ok(Object.values((await home.state()).datasets)[0]!.at! > at0);
    // The document's cron (hourly) runs its refresh and its alert: 50 > 10 fires once.
    const notices = await t.stream(OPERATOR, '/api/events?topics=notices,data');
    const hour = Math.ceil((Date.now() + 1) / 3_600_000) * 3_600_000;
    await data.tick(hour + 1000);
    await waitFor(() => events.some((e) => e.type === 'alert' && e.state === 'firing'), 'alert fired');
    await data.tick(hour + 3_600_000 + 1000);
    assert.equal(events.filter((e) => e.type === 'alert' && e.state === 'firing').length, 1, 'fires on the crossing only');
    await fs.writeFile(csv, 'v\n1\n');
    await ops([{ op: 'refresh', doc: id }]);
    assert.ok(events.some((e) => e.type === 'alert' && e.state === 'ok'), 'recovers');
    await waitFor(() => notices.got.some((e) => e.topic === 'notices' && /Too high/.test(String(e.payload.text))), 'alert notice on the global stream');
    // A failing source: recorded in the history, announced, the last good extract kept.
    await fs.rm(csv);
    await ops([{ op: 'refresh', dataset: 'metric' }]).catch(() => {});
    const runs = await t.call(OPERATOR, 'GET', '/api/data/runs');
    assert.ok(runs.body.some((x: { ok: boolean; dataset: string }) => x.ok === false && x.dataset === 'metric'));
    assert.ok(events.some((e) => e.type === 'refresh_failed'));
    const q = await t.call(OPERATOR, 'POST', '/api/data/query', { query: { model: 'm', measures: ['Value'] } });
    assert.deepEqual(q.body.rows, [[1]], 'the last good data stays');
    notices.close();
  } finally { await t.close(); }
});

test('agents drive it through the same ops: tools only for an app that draws dashboards, within the token budget; a multi-step change with undo', async () => {
  const t = await setupServer();
  try {
    const ws = await tempDir();
    await fs.writeFile(path.join(ws, 'sales.csv'), 'region,month,amount\nEU,2024-01-01,10\nUS,2024-01-01,20\nEU,2024-02-01,30\n');
    const client = { kind: 'desktop', version: '1', renderers: ['dashboard', 'mermaid'], tools: [] };
    const s = await t.harness.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws }, client: client as never });
    const ev = record(s);
    let doc = '';
    t.ds.scripts['bi'] = [
      { calls: [{ name: 'dashboard', input: { op: 'help' } }] },
      { calls: [{ name: 'datasource', input: { op: 'add_source', source: { id: 'src-s', name: 'Sales', type: 'file', path: 'sales.csv' } } }] },
      { calls: [{ name: 'dataset', input: { op: 'define', dataset: { name: 'sales', source: 'src-s' } } }] },
      { calls: [{ name: 'model', input: { ops: [{ op: 'add_model', model: { id: 'm', name: 'Sales' } }, { op: 'set_table', model: 'm', table: { name: 'sales', dataset: 'sales' } }, { op: 'set_measure', model: 'm', measure: { name: 'Revenue', expr: 'sum(sales.amount)' } }] } }] },
      { calls: [{ name: 'dashboard', input: { ops: [{ op: 'create', doc: { type: 'dashboard', title: 'Sales', model: 'm' } }, { op: 'add_visual', doc: '$new', visual: { type: 'column', title: 'By region', query: { dims: ['sales.region'], measures: ['Revenue'] } } }] } }] },
      (req) => { doc = /created dashboard (dash-[a-z0-9]+)/.exec(JSON.stringify(req.messages))![1]!; return { calls: [{ name: 'dashboard', input: { op: 'describe', doc } }] }; },
      () => ({ calls: [{ name: 'dashboard', input: { ops: [{ op: 'update_visual', doc, visual: /(v-[0-9a-f]+) column/.exec(JSON.stringify(t.ds.byKey['bi']!.at(-1)!.messages))![1], patch: { type: 'bar', options: { stack: 'stacked' }, query: { dims: ['sales.region', 'sales.month:quarter'] } } }, { op: 'set_measure', doc } ] } }] }),
      () => ({ calls: [{ name: 'dashboard', input: { ops: [{ op: 'add_visual', doc, visual: { type: 'card', query: { measures: ['Revenue'] } } }, { op: 'verify', doc }] } }] }),
      () => ({ calls: [{ name: 'dashboard', input: { op: 'undo', doc } }] }),
      { text: 'done' },
    ];
    await s.send('[[bi]] build a sales dashboard');
    await waitFor(() => turnsEnded(ev) === 1, 'turn', 60_000);
    const req0 = t.ds.byKey['bi']![0]!;
    const names = req0.tools.map((x) => x.name);
    for (const n of ['datasource', 'dataset', 'model', 'dashboard']) assert.ok(names.includes(n), n);
    const dataTokens = Math.round(JSON.stringify(req0.tools.filter((x) => ['datasource', 'dataset', 'model', 'dashboard'].includes(x.name))).length / 4);
    assert.ok(dataTokens <= 700, `the four data tools cost ~${dataTokens} tokens (budget 700)`);
    const results = ev.filter((e) => e.kind === 'tool_result') as Extract<HarnessEvent, { kind: 'tool_result' }>[];
    assert.match(results[0]!.content, /# Dashboards, reports and data/);
    assert.match(results[1]!.content, /added source src-s/);
    assert.match(results[2]!.content, /defined dataset sales/);
    assert.match(results[4]!.content, /created dashboard dash-[\s\S]*changed:\n.*\+ dashboard "Sales"/);
    assert.match(results[6]!.content, /set_measure belongs to the model tool|not an op|op 2/i, 'a foreign op is refused with where it belongs');
    assert.match(results[7]!.content, /verified: every visual ran/);
    assert.match(results[8]!.content, /undo dash-.*\n- visual/);
    // Recorded as the agent of this session.
    const h = await t.call(OPERATOR, 'POST', '/api/data/ops', { op: 'history', doc });
    assert.match(h.body.results[0].message, new RegExp(`agent:${s.meta.id}.*\\(session ${s.meta.id}\\)`));
    // A plain session (no app drawing dashboards) has none of these tools.
    const plain = await t.harness.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws } });
    const pev = record(plain);
    t.ds.scripts['p'] = [{ text: 'x' }];
    await plain.send('[[p]] hi'); await waitFor(() => turnsEnded(pev) === 1, 'plain');
    assert.ok(!t.ds.byKey['p']![0]!.tools.some((x) => x.name === 'dashboard'));
  } finally { await t.close(); }
});

test('permissions of the data tools: reads are free, writes are edits, sources and publishing ask (external)', () => {
  const tool = (n: string) => DATA_TOOLS.find((x) => x.spec.name === n)!;
  assert.deepEqual(tool('dataset').kindsFor!({ op: 'query', sql: 'SELECT 1' }), ['read']);
  assert.deepEqual(tool('dashboard').kindsFor!({ op: 'verify', doc: 'x' }), ['read']);
  assert.deepEqual(tool('dashboard').kindsFor!({ op: 'add_visual' }), ['edit']);
  assert.deepEqual(tool('datasource').kindsFor!({ op: 'add_source' }), ['external']);
  assert.deepEqual(tool('dashboard').kindsFor!({ ops: [{ op: 'add_visual' }, { op: 'publish' }] }), ['external']);
  assert.equal(tool('dashboard').persists!({ op: 'add_visual' }), true);
  assert.equal(tool('dashboard').persists!({ op: 'describe' }), false);
});

test('every control in the app applies an op from the catalogue; the contribution points for plugins validate', async () => {
  for (const [action, op] of Object.entries(UI_ACTIONS)) assert.ok(OPS[op], `${action} -> ${op} is an op`);
  // The desktop's dashboards plugin changes things only through act(<ui action>) (POST /api/data/ops).
  const dir = path.join(import.meta.dirname, '..', 'apps', 'desktop', 'renderer', 'src', 'builtins', 'dashboards');
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  const used = new Set<string>();
  for (const f of files.filter((x) => /\.tsx?$/.test(x))) {
    const src = await fs.readFile(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/act\(\s*'([\w.-]+)'/g)) used.add(m[1]!);
    assert.ok(!/method:\s*'(POST|PUT|DELETE|PATCH)'/.test(src.replace(/\/api\/data\/(ops|query|uploads|cancel)/g, '')) || /api\/data\/(ops|query|uploads)/.test(src), `${f}: no other mutating calls`);
  }
  for (const a of used) assert.ok(UI_ACTIONS[a], `the app uses ${a}, which maps to an op`);
  if (files.length) assert.ok(used.size >= 30, `the app's controls go through act() (${used.size} actions)`);
  const ui = validateUiManifest({ contributes: { dataSources: [{ id: 'prom', title: 'Prometheus', route: 'data/prom', params: { type: 'object', properties: { query: { type: 'string' } } } }], dashboardWidgets: [{ id: 'mol', title: 'Molecule', fence: 'smiles' }], blockActions: [{ id: 'pin', title: 'Pin', kinds: ['chart'], command: 'pin' }], commands: [{ id: 'pin', title: 'Pin', action: { type: 'open-view', view: 'x' } }] } });
  assert.equal(ui.contributes.dataSources[0]!.route, 'data/prom');
  assert.throws(() => validateUiManifest({ contributes: { dataSources: [{ id: 'x', title: 'X', route: '../../etc' }] } }), /route/);
  assert.throws(() => validateUiManifest({ contributes: { dashboardWidgets: [{ id: 'x', title: 'X', fence: 'BAD LANG' }] } }), /fence/);
});
