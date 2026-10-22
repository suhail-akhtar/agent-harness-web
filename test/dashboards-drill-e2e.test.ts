// Drill, linked dashboards and log analytics in the browser (the published viewer: the same
// components as the app), against sums computed here: a table drilled five levels by clicks with
// its breadcrumb, a chart's next level and expand all, a slicer synced into another dashboard, a
// point opening a linked dashboard with its context (and Back), and a web access log dashboard.
// No paid calls; skipped when there is no Chromium for playwright-core.
//
// HARNESS_DESKTOP_SCREENSHOTS=1 writes docs/screenshots/desktop/dashboards/drill-*.png, linked-*.png and log-analytics.png.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { demo } from './fixtures/dashboards/demo-server.ts';
import { GEO_LEVELS, writeRetail } from './fixtures/dashboards/retail.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.env.HARNESS_DESKTOP_SCREENSHOTS === '1' ? path.join(root, 'docs', 'screenshots', 'desktop', 'dashboards') : null;
function newest(dir: string): number {
  let t = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (e.name === 'node_modules') continue; const p = path.join(dir, e.name); t = Math.max(t, e.isDirectory() ? newest(p) : fs.statSync(p).mtimeMs); }
  return t;
}

test('drill, linked dashboards and log analytics in the browser', { timeout: 15 * 60_000 }, async (t) => {
  let pw: typeof import('playwright-core');
  try { pw = await import('playwright-core'); } catch { t.skip('playwright-core is not installed'); return; }
  if (!fs.existsSync(pw.chromium.executablePath())) { t.skip('no Chromium for playwright-core'); return; }
  const viewer = path.join(root, 'dist', 'bi-viewer', 'viewer.js');
  if (!fs.existsSync(viewer) || fs.statSync(viewer).mtimeMs < newest(path.join(root, 'packages'))) {
    const r = spawnSync(process.execPath, [path.join(root, 'apps', 'desktop', 'scripts', 'build-viewer.mjs')], { cwd: root, stdio: 'pipe', encoding: 'utf8', timeout: 600_000 });
    assert.equal(r.status, 0, (r.stderr || r.stdout).slice(-800));
  }
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const d = await demo();
  const r = await writeRetail(d.files);
  const geoOf = new Map(r.stores.map((s) => [s.store, s]));
  const g = (store: string, l: number) => geoOf.get(store)![GEO_LEVELS[l]!];
  // A web access log: 600 requests over an hour.
  const paths = ['/api/orders', '/api/checkout', '/api/search', '/health', '/static/app.js'];
  const log: Array<{ ip: string; path: string; status: number; ms: number }> = [];
  const lines: string[] = [];
  for (let i = 0; i < 600; i++) {
    const p = paths[(i * 7) % 5]!; const ip = `198.51.100.${(i * 13) % 29}`; const status = i % 19 === 0 ? 500 : i % 13 === 0 ? 404 : 200; const ms = p === '/api/search' ? 200 + ((i * 31) % 700) : 5 + ((i * 17) % 120);
    log.push({ ip, path: p, status, ms });
    lines.push(`${ip} - - [01/May/2024:10:${String(Math.floor(i / 10)).padStart(2, '0')}:${String((i * 6) % 60).padStart(2, '0')} +0000] "GET ${p} HTTP/1.1" ${status} ${300 + (i % 50)} "-" "Mozilla/5.0" ${(ms / 1000).toFixed(3)}`);
  }
  fs.writeFileSync(path.join(d.files, 'access.log'), `${lines.join('\n')}\n`);
  await d.ops([
    { op: 'add_source', source: { id: 'src-rs', name: 'Retail sales', type: 'file', path: path.join(d.files, 'retail_sales.csv') } },
    { op: 'add_source', source: { id: 'src-rg', name: 'Stores', type: 'file', path: path.join(d.files, 'retail_stores.csv') } },
    { op: 'define', dataset: { name: 'rsales', source: 'src-rs' } }, { op: 'define', dataset: { name: 'geo', source: 'src-rg' } },
    { op: 'add_model', model: { id: 'retail', name: 'Retail' } },
    { op: 'set_table', model: 'retail', table: { name: 'rsales', dataset: 'rsales' } }, { op: 'set_table', model: 'retail', table: { name: 'geo', dataset: 'geo' } },
    { op: 'set_relationship', model: 'retail', relationship: { from: 'rsales.store', to: 'geo.store' } },
    { op: 'set_measure', model: 'retail', measure: { name: 'Revenue', expr: 'sum(rsales.amount)', format: 'currency:USD:0' } },
    { op: 'set_hierarchy', model: 'retail', hierarchy: { name: 'Geography', levels: GEO_LEVELS.map((l) => `geo.${l}`) } },
    { op: 'set_hierarchy', model: 'retail', hierarchy: { name: 'Calendar', levels: ['year', 'quarter', 'month', 'week', 'day'].map((x) => `rsales.day:${x}`) } },
    // B first (A links to it).
    { op: 'create', doc: { type: 'dashboard', title: 'Store ranking', model: 'retail' } },
    { op: 'add_visual', doc: '$new', visual: { id: 'v-bsl', type: 'slicer', title: 'Country', options: { slicer: { field: 'geo.country', style: 'buttons', sync: 'country' } }, layout: { x: 0, y: 0, w: 12, h: 2 } } },
    { op: 'add_visual', doc: '$new', visual: { id: 'v-btot', type: 'card', title: 'Revenue', query: { measures: ['Revenue'] }, layout: { x: 0, y: 2, w: 3, h: 4 } } },
    { op: 'add_visual', doc: '$new', visual: { id: 'v-bst', type: 'bar', title: 'Revenue by store', query: { dims: ['geo.store'], measures: ['Revenue'], sort: [{ by: 'Revenue', desc: true }] }, layout: { x: 3, y: 2, w: 9, h: 9 } } },
  ]);
  const B = (await d.ops([{ op: 'list_docs' }])).results[0]!.data as unknown as Array<{ id: string; title: string }>;
  const docB = B.find((x) => x.title === 'Store ranking')!.id;
  const made = await d.ops([
    { op: 'create', doc: { type: 'dashboard', title: 'Retail drill', model: 'retail' } },
    { op: 'add_visual', doc: '$new', visual: { id: 'v-sl', type: 'slicer', title: 'Country', options: { slicer: { field: 'geo.country', style: 'buttons', sync: 'country' } }, layout: { x: 0, y: 0, w: 6, h: 2 } } },
    { op: 'add_visual', doc: '$new', visual: { id: 'v-open', type: 'button', options: { button: { label: 'Store ranking', action: 'doc', target: docB } }, layout: { x: 6, y: 0, w: 2, h: 2 } } },
    { op: 'add_visual', doc: '$new', visual: { id: 'v-tab', type: 'table', title: 'Revenue by place (click to drill)', query: { dims: ['geo.region'], measures: ['Revenue'] }, options: { hierarchy: 'Geography', drillMode: true, subtotals: false }, layout: { x: 0, y: 2, w: 5, h: 10 } } },
    { op: 'add_visual', doc: '$new', visual: { id: 'v-col', type: 'column', title: 'Revenue by place', query: { dims: ['geo.region'], measures: ['Revenue'] }, options: { hierarchy: 'Geography' }, layout: { x: 5, y: 2, w: 7, h: 10 } } },
    { op: 'add_visual', doc: '$new', visual: { id: 'v-cal', type: 'line', title: 'Revenue by period', query: { dims: ['rsales.day:year'], measures: ['Revenue'] }, options: { hierarchy: 'Calendar' }, layout: { x: 0, y: 12, w: 12, h: 8 } } },
  ]);
  const docA = made.results[0]!.data!.id!;
  await d.ops([{ op: 'add_link', doc: docA, visual: 'v-tab', link: { label: 'Store ranking', doc: docB } }]);
  const pubA = (await d.ops([{ op: 'publish', doc: docA, access: 'token' }])).results[0]!.data as { slug: string; token: string };

  const browser = await pw.chromium.launch();
  const errors: string[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${d.base}/p/${pubA.slug}#t=${pubA.token}`);
    await page.waitForSelector('[data-bi-ready="1"]', { timeout: 90_000 });
    const tableRows = async () => (await page.locator('[data-visual="v-tab"] tbody tr').allTextContents()).map((x) => x.trim());
    const level = async (v: string) => Number(await page.getAttribute(`[data-visual="${v}"] [data-drill-level]`, 'data-drill-level'));
    const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

    await t.test('a table drilled five levels by clicks: each level\'s rows are the sums within the path; the breadcrumb goes back', async () => {
      const trail: string[] = [];
      for (let l = 0; l < 5; l++) {
        assert.equal(await level('v-tab'), l);
        const want = new Map<string, number>();
        for (const s of r.sales) if (trail.every((v, i) => g(s.store, i) === v)) want.set(g(s.store, l), (want.get(g(s.store, l)) ?? 0) + s.amount);
        const got = await tableRows();
        assert.equal(got.length, want.size, `level ${l + 1}: ${got.join(' | ')}`);
        const first = [...want.keys()].sort()[0]!;
        assert.ok(got.some((x) => x.startsWith(first) && x.includes(money(want.get(first)!))), `level ${l + 1}: ${first} ${money(want.get(first)!)} in ${got.join(' | ')}`);
        if (l < 4) {
          await page.click(`[data-visual="v-tab"] tbody tr:has-text("${first}")`);
          // The table's first column is the next level's field once its new rows are in.
          await page.waitForFunction((name) => (document.querySelector('[data-visual="v-tab"] thead th')?.textContent ?? '').trim().startsWith(name), GEO_LEVELS[l + 1]!);
          await page.waitForSelector('[data-bi-ready="1"]');
        }
        trail.push(first);
      }
      const crumbs = await page.locator('[data-visual="v-tab"] [data-drill-crumbs]').innerText();
      for (const p of trail.slice(0, 4)) assert.ok(crumbs.includes(p), `breadcrumb ${crumbs} has ${p}`);
      if (SHOTS) { await page.waitForTimeout(500); await page.screenshot({ path: path.join(SHOTS, 'drill-five-levels.png') }); }
      // Back to the country level through the breadcrumb (the region's crumb).
      await page.click(`[data-visual="v-tab"] [data-drill-crumbs] button:has-text("${trail[0]}")`);
      await page.waitForFunction(() => document.querySelector('[data-visual="v-tab"] [data-drill-level]')?.getAttribute('data-drill-level') === '1');
      await page.click('[data-visual="v-tab"] [data-crumb="all"]');
      await page.waitForFunction(() => document.querySelector('[data-visual="v-tab"] [data-drill-level]')?.getAttribute('data-drill-level') === '0');
    });

    await t.test('a chart: go to the next level (every country), expand all (country within region on one axis), drill up', async () => {
      await page.click('[data-visual="v-col"] [data-drill-next]');
      await page.waitForFunction(() => document.querySelector('[data-visual="v-col"] [data-drill-level]')?.getAttribute('data-drill-level') === '1');
      await page.click('[data-visual="v-col"] [data-drill-up]');
      await page.click('[data-visual="v-col"] [data-drill-expand-all]');
      await page.waitForSelector('[data-visual="v-col"] [data-drill-expand="1"]');
      await page.waitForSelector('[data-bi-ready="1"]');
      // The calendar too: down to the week level with "next level".
      for (let i = 0; i < 3; i++) await page.click('[data-visual="v-cal"] [data-drill-next]');
      await page.waitForFunction(() => document.querySelector('[data-visual="v-cal"] [data-drill-level]')?.getAttribute('data-drill-level') === '3');
      await page.waitForSelector('[data-bi-ready="1"]');
      if (SHOTS) { await page.waitForTimeout(800); await page.screenshot({ path: path.join(SHOTS, 'drill-expand-and-next.png') }); }
    });

    await t.test('a synced slicer: France chosen here is chosen in the other dashboard; a point opens the linked dashboard with its context; Back returns', async () => {
      await page.click('[data-visual="v-sl"] button:has-text("France")');
      await page.waitForSelector('[data-bi-ready="1"]');
      const fr = r.sales.filter((s) => g(s.store, 1) === 'France');
      // The button opens B: its synced slicer has France, so its total is France's.
      await page.click('[data-visual="v-open"] button:has-text("Store ranking")');
      await page.waitForSelector('[data-bi-linked-back]');
      await page.waitForSelector('[data-bi-ready="1"]');
      await page.waitForFunction(() => !!document.querySelector('[data-visual="v-btot"] [data-card-value]'));
      const filtersShown = await page.locator('[data-bi-filters]').innerText().catch(() => '(none)');
      assert.equal(Number(await page.getAttribute('[data-visual="v-btot"] [data-card-value]', 'data-card-value')), fr.reduce((a, s) => a + s.amount, 0), `B shows France (filters: ${filtersShown})`);
      assert.equal(await page.getAttribute('[data-visual="v-bsl"] button:has-text("France")', 'aria-pressed'), 'true', 'B\'s slicer has France');
      await page.click('[data-bi-linked-back]');
      await page.waitForSelector('[data-visual="v-tab"]');
      await page.waitForSelector('[data-bi-ready="1"]');
      // A point's link: drill to France's states, right-click one and open B with it.
      await page.click('[data-visual="v-tab"] tbody tr:has-text("EMEA")');
      await page.waitForSelector('[data-bi-ready="1"]');
      await page.click('[data-visual="v-tab"] tbody tr:has-text("France")');
      await page.waitForFunction(() => document.querySelector('[data-visual="v-tab"] [data-drill-level]')?.getAttribute('data-drill-level') === '2');
      await page.waitForSelector('[data-bi-ready="1"]');
      const state = (await tableRows())[0]!.split(/\s|\$/)[0]!;
      await page.click(`[data-visual="v-tab"] tbody tr:has-text("${state}")`, { button: 'right' });
      await page.click(`[data-bi-menu] [data-link="${docB}"]`);
      await page.waitForSelector('[data-bi-linked-back]');
      await page.waitForSelector('[data-bi-ready="1"]');
      await page.waitForFunction(() => !!document.querySelector('[data-visual="v-btot"] [data-card-value]'));
      const inState = r.sales.filter((s) => g(s.store, 2) === state);
      assert.equal(Number(await page.getAttribute('[data-visual="v-btot"] [data-card-value]', 'data-card-value')), inState.reduce((a, s) => a + s.amount, 0), `B shows the state ${state}`);
      if (SHOTS) { await page.waitForTimeout(800); await page.screenshot({ path: path.join(SHOTS, 'linked-dashboards.png') }); }
      await page.click('[data-bi-linked-back]');
      await page.waitForSelector('[data-visual="v-tab"]');
    });

    await t.test('a web access log dashboard: requests, errors, p95 latency by path and top client addresses equal the log counted here', async () => {
      const lg = await d.ops([
        { op: 'add_source', source: { id: 'src-log', name: 'Web access log', type: 'file', path: path.join(d.files, 'access.log'), format: 'log', log: { format: 'combined' } } },
        { op: 'define', dataset: { name: 'web', source: 'src-log' } },
        { op: 'add_model', model: { id: 'web', name: 'Web traffic' } },
        { op: 'set_table', model: 'web', table: { name: 'web', dataset: 'web' } },
        { op: 'set_model', model: 'web', patch: { date: 'web.time' } },
        { op: 'set_measure', model: 'web', measure: { name: 'Requests', expr: 'count(*)', table: 'web', format: 'integer' } },
        { op: 'set_measure', model: 'web', measure: { name: 'Errors', expr: 'count(*)', table: 'web', filter: 'web.status >= 500', format: 'integer' } },
        { op: 'set_measure', model: 'web', measure: { name: 'Error rate', expr: '[Errors] / [Requests]', format: 'percent:1' } },
        { op: 'set_measure', model: 'web', measure: { name: 'p95 latency (ms)', expr: 'quantile_cont(web.latency_ms, 0.95)', format: 'number:0' } },
        { op: 'create', doc: { type: 'dashboard', title: 'Web traffic', model: 'web' } },
        { op: 'add_visual', doc: '$new', visual: { id: 'v-req', type: 'card', title: 'Requests', query: { measures: ['Requests'] }, layout: { x: 0, y: 0, w: 3, h: 4 } } },
        { op: 'add_visual', doc: '$new', visual: { id: 'v-err', type: 'card', title: 'Server errors', query: { measures: ['Errors'] }, layout: { x: 3, y: 0, w: 3, h: 4 } } },
        { op: 'add_visual', doc: '$new', visual: { id: 'v-rate', type: 'card', title: 'Error rate', query: { measures: ['Error rate'] }, layout: { x: 6, y: 0, w: 3, h: 4 } } },
        { op: 'add_visual', doc: '$new', visual: { id: 'v-p95', type: 'card', title: 'p95 latency (ms)', query: { measures: ['p95 latency (ms)'] }, layout: { x: 9, y: 0, w: 3, h: 4 } } },
        { op: 'add_visual', doc: '$new', visual: { id: 'v-time', type: 'line', title: 'Requests and errors per minute', query: { dims: ['web.time:minute'], measures: ['Requests', 'Errors'] }, layout: { x: 0, y: 4, w: 12, h: 7 } } },
        { op: 'add_visual', doc: '$new', visual: { id: 'v-path', type: 'bar', title: 'p95 latency by path', query: { dims: ['web.path'], measures: ['p95 latency (ms)'], sort: [{ by: 'p95 latency (ms)', desc: true }] }, options: { labels: true }, layout: { x: 0, y: 11, w: 6, h: 8 } } },
        { op: 'add_visual', doc: '$new', visual: { id: 'v-ip', type: 'table', title: 'Top client addresses', query: { dims: ['web.host'], measures: ['Requests', 'Errors'], sort: [{ by: 'Requests', desc: true }], limit: 8 }, options: { subtotals: false }, layout: { x: 6, y: 11, w: 6, h: 8 } } },
        { op: 'add_visual', doc: '$new', visual: { id: 'v-status', type: 'donut', title: 'Status codes', query: { dims: ['web.status'], measures: ['Requests'] }, layout: { x: 0, y: 19, w: 6, h: 7 } } },
      ]);
      const docW = lg.results.find((x) => x.op === 'create')!.data!.id!;
      const pubW = (await d.ops([{ op: 'publish', doc: docW, access: 'token' }])).results[0]!.data as { slug: string; token: string };
      const p2 = await browser.newPage({ viewport: { width: 1440, height: 1500 } });
      p2.on('pageerror', (e) => errors.push(e.message));
      await p2.goto(`${d.base}/p/${pubW.slug}#t=${pubW.token}`);
      await p2.waitForSelector('[data-bi-ready="1"]', { timeout: 90_000 });
      const card = async (v: string) => Number(await p2.getAttribute(`[data-visual="${v}"] [data-card-value]`, 'data-card-value'));
      assert.equal(await card('v-req'), log.length);
      assert.equal(await card('v-err'), log.filter((x) => x.status >= 500).length);
      const ms = log.map((x) => x.ms).sort((a, b) => a - b); const pos = 0.95 * (ms.length - 1); const lo = Math.floor(pos);
      assert.ok(Math.abs(await card('v-p95') - (ms[lo]! + (ms[lo + 1]! - ms[lo]!) * (pos - lo))) < 1e-6, 'p95 latency');
      const counts = new Map<string, number>(); for (const x of log) counts.set(x.ip, (counts.get(x.ip) ?? 0) + 1);
      const top = [...counts].sort((a, b) => b[1] - a[1])[0]!;
      assert.match((await p2.locator('[data-visual="v-ip"] tbody tr').first().innerText()).replace(/\s+/g, ' '), new RegExp(`${top[1]}`));
      if (SHOTS) { await p2.waitForTimeout(900); await p2.screenshot({ path: path.join(SHOTS, 'log-analytics.png'), fullPage: true }); }
      await p2.close();
    });
    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    await browser.close();
    await d.close();
  }
});
