/**
 * The live dashboards run: the real desktop app, the real engine, real models (costs money; not in
 * npm test). Keys come from an env file and are never printed:
 *
 *   node --env-file=<path to .env> apps/desktop/scripts/live-dashboards.mjs
 *
 * For each model (claude-sonnet-5-5 first, then deepseek-flash; effort medium) an agent in a session
 * of the app builds a dashboard from a generated sales.xlsx and countries.csv plus a public JSON API
 * (population by country from a public statistics API; a local stand-in when it cannot be reached), with a region slicer and an
 * hourly refresh, and writes a one-page printable report. Then three change requests in plain words.
 * After each step: the dashboards are verified (every visual runs, totals reconcile) and the main
 * numbers are checked against the same figures computed here from the fixture's rows, without the
 * engine. Screenshots go to docs/screenshots/desktop/dashboards/live-*.png. The whole run stops
 * before it would pass $3.00 (HARNESS_LIVE_CAP_USD to lower it).
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const repo = path.resolve(desktop, '..', '..');
const require = createRequire(import.meta.url);
const MODELS = (process.env.HARNESS_LIVE_MODELS ?? 'claude-sonnet-5-5,deepseek-flash').split(',').map((s) => s.trim()).filter(Boolean);
const CAP = Math.min(3, Number(process.env.HARNESS_LIVE_CAP_USD ?? 3));
const SHOTS = path.join(repo, 'docs', 'screenshots', 'desktop', 'dashboards');
const log = (m) => console.log(`[live] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(SHOTS, { recursive: true });

// ---- the files and the truth, computed here (no engine) ----
const { writeSalesFiles, salesFixture } = await import(pathToFileURL(path.join(repo, 'test', 'fixtures', 'dashboards', 'sales.ts')).href);
const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-live-bi-')));
await writeSalesFiles(project);
const fx = salesFixture();
const col = (n) => fx.columns.indexOf(n);
const round2 = (x) => Math.round(x * 100) / 100;
const truth = { revenue: 0, cost: 0, orders: fx.rows.length, byRegion: {}, byYear: {} };
for (const r of fx.rows) {
  truth.revenue += r[col('revenue')]; truth.cost += r[col('cost')];
  truth.byRegion[r[col('region')]] = (truth.byRegion[r[col('region')]] ?? 0) + r[col('revenue')];
  const y = String(r[col('order_date')]).slice(0, 4); truth.byYear[y] = (truth.byYear[y] ?? 0) + r[col('revenue')];
}
log(`fixture: ${fx.rows.length} orders, revenue ${round2(truth.revenue)}, margin ${round2((truth.revenue - truth.cost) / truth.revenue * 100)}%`);

// ---- a public API with no key, or a local stand-in ----
let apiUrl = 'https://api.worldbank.org/v2/country/all/indicator/SP.POP.TOTL?format=json&date=2023&per_page=400';
let privateHost = '';
try {
  const r = await fetch(apiUrl, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(String(r.status));
  const j = await r.json();
  if (!Array.isArray(j?.[1]) || !j[1].some((x) => x?.country?.value === 'Germany' && x.value > 0)) throw new Error('unexpected shape');
  log('the public API answers');
} catch (e) {
  log(`the public API is not reachable (${e.message}): a local stand-in serves the same shape`);
  const pops = { 'United Kingdom': 68_350_000, Germany: 83_280_000, France: 68_170_000, 'United States': 334_900_000, Canada: 40_100_000, Brazil: 216_400_000, Japan: 124_500_000, Australia: 26_640_000, India: 1_428_000_000 };
  const srv = http.createServer((_q, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify([{ page: 1, pages: 1, total: 9 }, Object.entries(pops).map(([n, p]) => ({ indicator: { id: 'SP.POP.TOTL', value: 'Population, total' }, country: { id: n.slice(0, 2).toUpperCase(), value: n }, date: '2023', value: p }))])); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  privateHost = `127.0.0.1:${srv.address().port}`;
  apiUrl = `http://${privateHost}/v2/country/all/indicator/SP.POP.TOTL?format=json&date=2023&per_page=400`;
}

const { _electron } = await import('playwright-core');
const electronExe = require('electron');
if (!fs.existsSync(path.join(desktop, 'dist', 'main.cjs'))) { const { spawnSync } = await import('node:child_process'); spawnSync(process.execPath, [path.join(here, 'build.mjs')], { stdio: 'inherit', cwd: repo }); }
// One app (and one data folder) per model: each agent starts from nothing.
let app; let page;
async function launch() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-live-bi-data-'));
  app = await _electron.launch({ executablePath: electronExe, args: [desktop], env: { ...process.env, HARNESS_DESKTOP_DATA: data, HARNESS_DESKTOP_NO_TRAY: '1', ...(privateHost ? { HARNESS_DATA_PRIVATE_HOSTS: privateHost } : {}) }, timeout: 60_000 });
  page = await app.firstWindow();
  await ready();
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.unmaximize(); w.setSize(1440, 920); });
  await page.evaluate((dir) => window.harnessDesktop.invoke('projects:add', dir), project);
  await sleep(1500); await ready();
  for (let i = 0; i < 40 && (await api('GET', '/api/health')).status !== 200; i++) await sleep(500);
}
const api = (method, p, body) => page.evaluate(async ([m, u, b]) => { const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json', 'x-harness': '1' }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) }; }, [method, p, body]);
const ready = () => page.waitForSelector('[data-engine-status="ready"]', { timeout: 120_000 });
const ops = async (o) => { const r = await api('POST', '/api/data/ops', { ops: o }); if (r.status !== 200) throw new Error(r.body?.error ?? `HTTP ${r.status}`); return r.body; };
const results = [];
let spent = 0;

async function runTurn(id, text, label) {
  await api('POST', `/api/sessions/${id}/messages`, { text });
  const until = Date.now() + 15 * 60_000;
  let seenRunning = false;
  for (;;) {
    const d = (await api('GET', `/api/sessions/${id}`)).body;
    if (d?.status === 'running') seenRunning = true;
    for (const ev of d?.pending ?? []) {
      // The agent adds sources (asked: data leaves through them) and may ask a question: the run answers for the person.
      if (ev.kind === 'permission_request') { log(`${label}: allowing ${ev.tool} (${String(ev.summary ?? '').slice(0, 80)})`); await api('POST', `/api/sessions/${id}/respond`, { requestId: ev.requestId, decision: 'allow' }); }
      if (ev.kind === 'question') { log(`${label}: the agent asks "${String(ev.question).slice(0, 120)}" -> "your choice; be sensible"`); await api('POST', `/api/sessions/${id}/respond`, { requestId: ev.requestId, decision: 'answer', answer: ev.form ? '{}' : (ev.options?.[0] ?? 'Your choice; be sensible.') }); }
    }
    if (d?.status === 'idle' && seenRunning) return d;
    if (Date.now() > until) throw new Error(`${label}: no answer within 15 minutes`);
    if (costOf(d) + spent > CAP) { await api('POST', `/api/sessions/${id}/abort`, {}); throw new Error(`${label}: stopped at the $${CAP} cap`); }
    await sleep(1500);
  }
}

/** Every dashboard and report verified, and the main numbers equal to the ones computed here. */
async function check(label) {
  const docs = (await ops([{ op: 'list_docs' }])).results[0].data;
  const out = { label, docs: docs.length, verified: 0, problems: [], numbers: 0, mismatches: [] };
  for (const d of docs) {
    const v = (await ops([{ op: 'verify', doc: d.id }])).results[0];
    if (/verified: every visual ran/.test(v.message)) out.verified++; else out.problems.push(`${d.title}: ${v.message.split('\n').filter((l) => /ERROR|EMPTY|WARNING|STATIC|problems/.test(l)).slice(0, 4).join(' | ')}`);
  }
  // The agent's measures, found by what they aggregate; their values here and there.
  const cat = (await api('GET', '/api/data/catalog')).body;
  for (const m of cat.models ?? []) {
    const rev = m.measures.find((x) => /sum\([^)]*revenue[^)]*\)/i.test(x.expr ?? '') && !x.filter);
    if (!rev) continue;
    const region = (() => { for (const t of m.tables) { const ds = cat.datasets.find((d) => d.name === t.dataset); if (ds?.state.columns?.some((c) => c.name === 'region')) return `${t.name}.region`; } return undefined; })();
    const q = async (query) => (await ops([{ op: 'model_query', query: { model: m.id, ...query } }])).results[0].data;
    const total = (await q({ measures: [rev.name] })).rows[0][0];
    out.numbers++;
    if (Math.abs(total - truth.revenue) > 0.005) out.mismatches.push(`${m.id} ${rev.name}: ${total} != ${round2(truth.revenue)}`);
    if (region) {
      const by = await q({ dims: [region], measures: [rev.name] });
      for (const [r, val] of by.rows) { out.numbers++; if (Math.abs(val - (truth.byRegion[r] ?? NaN)) > 0.005) out.mismatches.push(`${rev.name} ${r}: ${val} != ${round2(truth.byRegion[r])}`); }
    }
  }
  results.push(out);
  log(`${label}: ${out.verified}/${out.docs} documents verified; ${out.numbers} numbers checked against the fixture, ${out.mismatches.length} mismatches${out.problems.length ? `; problems: ${out.problems.join(' / ')}` : ''}${out.mismatches.length ? `; ${out.mismatches.join('; ')}` : ''}`);
  return out;
}

/** A screenshot of a dashboard or report, opened from its library page; a failure is logged, never fatal. */
async function shoot(name, doc) {
  try {
    const nav = `[data-nav="core.dashboards:${doc.type === 'report' ? 'reports' : 'dashboards'}"]`;
    // Reports live under the sidebar's More.
    if (!(await page.locator(nav).isVisible())) await page.getByRole('button', { name: 'More', exact: true }).first().click();
    await page.click(nav);
    await page.waitForSelector('[data-bi-library]');
    await page.click(`[data-doc-card="${doc.id}"]`, { timeout: 15_000 });
    await page.waitForSelector('[data-bi-ready="1"]', { timeout: 120_000 });
    await sleep(1500);
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  } catch (e) { log(`screenshot ${name}: ${e.message.split('\n')[0]}`); }
}
const costOf = (d) => d?.meta?.cost ?? d?.cost ?? 0;

const BUILD = (file) => `In this project folder there are sales.xlsx (sheets Orders and Products) and countries.csv (country, region, manager).
Also use this public JSON API, no key: ${apiUrl} (a JSON array whose second element is the list of rows: country.value is the country name, value the population in 2023).
Build a dashboard "Sales overview" for the sales director: KPIs for revenue, margin % and orders; revenue by month and region; the top countries by revenue; revenue per million inhabitants by country (join the populations by country name); a region slicer; refresh hourly.
Then write a one-page printable report "Sales summary" (a report with a print layout) with a short narrative whose numbers come from measures, and the key visuals.
Verify both before you finish, and tell me what you built. Be decisive: do not ask me questions. (${file})`;
const CHANGES = [
  'Change request 1: make the monthly revenue chart a stacked column by quarter, split by channel, and add a KPI for revenue year over year % (against the same period last year).',
  'Change request 2: turn the Sales overview\'s first page into a TV wall for the ops room (16:9, rotating), keeping every widget.',
  'Change request 3: in the country table (or add one), colour revenue with a scale and add a drill-through page "Country detail" showing revenue by city and by product for the country clicked.',
];

try {
  for (const model of MODELS) {
    if (spent >= CAP) { log(`skipping ${model}: the cap is reached`); continue; }
    await launch();
    const providers = (await api('GET', '/api/providers')).body;
    for (const p of Array.isArray(providers) ? providers : []) if (p.configured) log(`provider ${p.id}: configured`);
    const s = (await api('POST', '/api/sessions', { title: `Live dashboards (${model})`, model, effort: 'medium', mode: 'acceptEdits', runtime: 'local', path: project, client: { kind: 'desktop', version: 'live', renderers: ['mermaid', 'chart', 'vega-lite', 'math', 'table', 'csv', 'json', 'html', 'svg', 'jsx', 'diff', 'diagram', 'plot', 'dot', 'smiles', 'pdb', 'sdf', 'geojson', 'ipynb', 'dashboard'], tools: [] } })).body;
    if (!s?.id) { log(`${model}: no session (${JSON.stringify(s).slice(0, 200)})`); continue; }
    log(`${model}: session ${s.id}`);
    const t0 = Date.now();
    try {
      await runTurn(s.id, BUILD(`model ${model}`), `${model} build`);
      const c = await check(`${model} build`);
      const docs = (await ops([{ op: 'list_docs' }])).results[0].data;
      const dash = docs.find((d) => d.type === 'dashboard') ?? docs[0];
      const rep = docs.find((d) => d.type === 'report');
      if (dash) await shoot(`live-${model}-dashboard`, dash);
      if (rep) await shoot(`live-${model}-report`, rep);
      void c;
      for (const [i, ch] of CHANGES.entries()) {
        const meta = (await api('GET', `/api/sessions/${s.id}`)).body;
        if (spent + costOf(meta) > CAP * 0.85) { log(`${model}: stopping before change ${i + 1} (cost so far $${(spent + costOf(meta)).toFixed(3)})`); break; }
        await runTurn(s.id, `${ch} Verify, then list what changed.`, `${model} change ${i + 1}`);
        await check(`${model} change ${i + 1}`);
        if (dash) await shoot(`live-${model}-change-${i + 1}`, dash);
      }
    } catch (e) { log(`${model}: ${e.message}`); results.push({ label: `${model} failed`, error: e.message }); }
    const meta = (await api('GET', `/api/sessions/${s.id}`)).body;
    spent += costOf(meta);
    const last = (meta?.history ?? []).filter((m) => m.role === 'assistant').at(-1);
    const text = last ? (Array.isArray(last.content) ? last.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : String(last.content)) : '';
    log(`${model}: $${costOf(meta).toFixed(4)} in ${Math.round((Date.now() - t0) / 1000)} s; last answer: ${text.slice(0, 400).replace(/\s+/g, ' ')}`);
    await app.close().catch(() => {});
  }
} finally {
  log(`total cost $${spent.toFixed(4)} (cap $${CAP})`);
  fs.writeFileSync(path.join(os.tmpdir(), 'hd-live-dashboards.json'), JSON.stringify({ results, spent }, null, 1));
  await app?.close().catch(() => {});
}
