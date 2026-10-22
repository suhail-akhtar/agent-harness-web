// core.dashboards end to end: the real Electron app against a scripted engine (no paid calls),
// driven with playwright-core. A chart from a conversation is pinned into a new dashboard, bound to
// a CSV dataset made on the Data page, given a model, a KPI and a slicer; a selection cross-filters;
// the CSV changes and a refresh shows the new numbers; the dashboard is published and opened in a
// Chromium page that updates live; an agent applies a change request through the ops (diff, undo);
// unpublishing cuts the page off. Skipped when Electron cannot start here.
//
// HARNESS_DESKTOP_SCREENSHOTS=1 writes the screenshots in docs/screenshots/desktop/dashboards/.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = path.join(root, 'apps', 'desktop');
const SHOTS = process.env.HARNESS_DESKTOP_SCREENSHOTS === '1' ? path.join(root, 'docs', 'screenshots', 'desktop', 'dashboards') : null;
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');

function newest(dir: string): number {
  let t = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(p) : fs.statSync(p).mtimeMs);
  }
  return t;
}
function ensureBuilt(): string | null {
  const src = Math.max(newest(path.join(desktop, 'electron')), newest(path.join(desktop, 'renderer')), newest(path.join(desktop, 'shared')), newest(path.join(root, 'packages')));
  const out = path.join(desktop, 'dist', 'renderer', 'index.html');
  if (!fs.existsSync(out) || fs.statSync(out).mtimeMs < src) {
    const r = spawnSync(process.execPath, [path.join(desktop, 'scripts', 'build.mjs')], { cwd: root, stdio: 'pipe', encoding: 'utf8', timeout: 600_000 });
    if (r.status !== 0) return `build failed: ${(r.stderr || r.stdout).slice(-800)}`;
  }
  const viewer = path.join(root, 'dist', 'bi-viewer', 'viewer.js');
  if (!fs.existsSync(viewer) || fs.statSync(viewer).mtimeMs < newest(path.join(root, 'packages'))) {
    const r = spawnSync(process.execPath, [path.join(desktop, 'scripts', 'build-viewer.mjs')], { cwd: root, stdio: 'pipe', encoding: 'utf8', timeout: 600_000 });
    if (r.status !== 0) return `viewer build failed: ${(r.stderr || r.stdout).slice(-800)}`;
  }
  return null;
}

test('dashboards end to end', { timeout: 15 * 60_000 }, async (t) => {
  if (!fs.existsSync(electronExe)) { t.skip('Electron is not installed'); return; }
  let pw: typeof import('playwright-core');
  try { pw = await import('playwright-core'); } catch { t.skip('playwright-core is not installed'); return; }
  const failed = ensureBuilt();
  if (failed) assert.fail(failed);

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-bi-'));
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-bi-work-')));
  const csv = path.join(work, 'sales.csv');
  const writeCsv = (rows: Array<[string, string, number, number]>) => fs.writeFileSync(csv, `region,channel,amount,orders\n${rows.map((r) => r.join(',')).join('\n')}\n`);
  writeCsv([['EMEA', 'Online', 120, 3], ['EMEA', 'Retail', 80, 2], ['Americas', 'Online', 200, 5], ['APAC', 'Retail', 150, 4]]);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_API_KEY$|^GW_|^HARNESS_/.test(k)) env[k] = v;
  Object.assign(env, { HARNESS_DESKTOP_DATA: data, HARNESS_DESKTOP_ENGINE: path.join(root, 'test', 'fixtures', 'dashboards', 'engine.ts'), HARNESS_DESKTOP_NO_TRAY: '1', HARNESS_PLUGIN_LOOPS: 'off' });
  let app: import('playwright-core').ElectronApplication;
  try { app = await pw._electron.launch({ executablePath: electronExe, args: [desktop], env, timeout: 60_000 }); } catch (e) { t.skip(`Electron could not start here: ${(e as Error).message.split('\n')[0]}`); return; }
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const page = await app.firstWindow();
  let phase = 'start';
  const errors: Array<{ phase: string; text: string }> = [];
  page.on('pageerror', (e) => errors.push({ phase, text: `exception: ${e.message}` }));
  page.on('console', (m) => { const where = m.location().url ?? ''; if (m.type() === 'error' && !/\/plugins\/|^harness:\/\/preview|^about:srcdoc/.test(where)) errors.push({ phase, text: `console: ${m.text()} (${where})` }); });
  const shot = async (name: string, el?: import('playwright-core').Locator) => { if (!SHOTS) return; await page.waitForTimeout(400); await (el ?? page).screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
  const invoke = (channel: string, ...args: unknown[]) => page.evaluate(([c, a]) => (window as unknown as { harnessDesktop: { invoke: (c: string, ...x: unknown[]) => Promise<unknown> } }).harnessDesktop.invoke(c as string, ...(a as unknown[])), [channel, args] as const);
  const api = (method: string, p: string, body?: unknown) => page.evaluate(async ([m, u, b]) => { const r = await fetch(u as string, { method: m as string, headers: { 'content-type': 'application/json', 'x-harness': '1' }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) }; }, [method, p, body] as const);
  const ready = () => page.waitForSelector('[data-engine-status="ready"]', { timeout: 90_000 });
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; w.unmaximize(); w.setSize(1440, 900); });
  const step = (name: string, fn: () => Promise<void>) => t.test(name, async () => {
    phase = name;
    try { await fn(); } catch (e) {
      await page.screenshot({ path: path.join(os.tmpdir(), `hd-bi-fail-${name.slice(0, 40).replace(/[^a-z0-9]+/gi, '-')}.png`) }).catch(() => {});
      for (let i = 0; i < 3; i++) await page.keyboard.press('Escape').catch(() => {});
      throw e;
    }
  });
  const kpi = async () => Number(await page.getAttribute('[data-visual-type="card"] [data-card-value]', 'data-card-value', { timeout: 30_000 }));
  let docId = '';
  let viewer: import('playwright-core').Browser | undefined;
  try {
    await step('the app is ready; Dashboards and Data are in the sidebar', async () => {
      await ready();
      await page.waitForSelector('[data-nav="core.dashboards:dashboards"]', { timeout: 30_000 });
      assert.ok(await page.locator('[data-nav="core.dashboards:data"]').count());
      // The folder with the CSV is a project (a root the engine may read).
      await invoke('projects:add', work);
      await page.waitForTimeout(1500);
      await ready();
    });

    await step('a chart in a conversation is pinned into a new dashboard; it says its numbers were typed by a model', async () => {
      await page.click('[data-nav="core.chat:new"]');
      await page.waitForSelector('[data-home]');
      const box = page.locator('[data-composer-input]');
      // Under load the composer may not take the first Enter (models still loading): send again until a session opens.
      for (let i = 0; i < 4; i++) {
        if (!(await page.locator('[data-home]').count())) break;
        if (!(await box.inputValue().catch(() => ''))) await box.fill('chart please');
        await box.press('Enter');
        await page.waitForSelector('[data-home]', { state: 'detached', timeout: 10_000 }).catch(() => {});
      }
      const pin = page.locator('[data-block-action="core.dashboards:pin"]').first();
      await pin.waitFor({ timeout: 30_000 });
      await shot('pin-from-transcript', page.locator('[data-widget]').first());
      await pin.click();
      await page.waitForSelector('[data-pin-panel]');
      await page.fill('[data-pin-title]', 'Regional sales');
      await page.click('[data-pin-go]');
      await page.waitForSelector('[data-toast]:has-text("Pinned")', { timeout: 20_000 });
      await page.click('[data-toast] button:has-text("Open")');
      await page.waitForSelector('[data-bi-editor]', { timeout: 20_000 });
      docId = (await page.getAttribute('[data-bi-editor]', 'data-bi-editor'))!;
      await page.waitForSelector('[data-visual-type="column"] [data-static-badge]', { timeout: 30_000 });
    });

    await step('the Data page: a CSV source, a dataset (previewed and profiled) and a model with a measure', async () => {
      await page.click('[data-nav="core.dashboards:data"]');
      await page.click('[role="tab"]:has-text("Sources")');
      await page.click('[data-add-source]');
      await page.fill('[data-source-name] , input[data-source-name]', 'Sales CSV').catch(async () => page.locator('[data-source-name]').fill('Sales CSV'));
      await page.locator('[data-source-path]').fill(csv);
      await page.click('[data-save-source]');
      await page.waitForSelector('[data-source]:has-text("Sales CSV")', { timeout: 20_000 });
      await page.click('[role="tab"]:has-text("Datasets")');
      await page.click('[data-new-dataset]');
      await page.locator('[data-dataset-name]').fill('sales');
      const srcId = await page.locator('[data-dataset-source] option:has-text("Sales CSV")').getAttribute('value');
      await page.locator('[data-dataset-source]').selectOption(srcId!);
      await page.click('[data-save-dataset]');
      await page.waitForSelector('[data-dataset-detail="sales"] [data-result-rows="4"]', { timeout: 30_000 });
      await page.waitForSelector('[data-dataset-detail="sales"] [data-profile]', { timeout: 30_000 });
      await shot('data-dataset');
      await page.click('[role="tab"]:has-text("Model")');
      await page.fill('[aria-label="New model name"]', 'Sales');
      await page.click('[data-new-model]');
      await page.waitForSelector('[data-model]', { timeout: 15_000 });
      await page.locator('[aria-label="Add a table"]').selectOption('sales');
      await page.click('[data-model] button:has-text("Add")');
      await page.waitForSelector('[data-model-table="sales"]', { timeout: 15_000 });
      await page.fill('[aria-label="Measure name"]', 'Revenue');
      await page.fill('[aria-label="Measure expression"]', 'sum(sales.amount)');
      await page.click('[data-save-measure]');
      await page.waitForSelector('[data-measure="Revenue"]', { timeout: 15_000 });
      await page.fill('[aria-label="Measure name"]', 'Orders');
      await page.fill('[aria-label="Measure expression"]', 'sum(sales.orders)');
      await page.click('[data-save-measure]');
      await page.waitForSelector('[data-measure="Orders"]', { timeout: 15_000 });
      await shot('data-model');
    });

    await step('back in the dashboard: the pinned chart is bound to the dataset; a KPI card and a slicer are added', async () => {
      await page.click('[data-nav="core.dashboards:dashboards"]');
      await page.click(`[data-doc-card="${docId}"]`);
      await page.click('[data-bi-edit]');
      await page.locator('[aria-label="Model"]').last().selectOption({ label: 'Sales' });
      await page.waitForTimeout(800);
      await page.click('[data-visual-type="column"] header');
      await page.waitForSelector('[data-bind-dim]');
      await page.locator('[data-bind-dim]').selectOption('sales.region');
      await page.click('[data-bind-go]');
      await page.waitForSelector('[data-visual-type="column"]:not(:has([data-static-badge])) [data-chart="bi"][data-rows="3"]', { timeout: 30_000 });
      // A card of Revenue and a slicer on the channel.
      await page.click('[data-menu="add-visual"]');
      await page.click('[role="menuitem"]:has-text("Card")');
      await page.waitForSelector('[data-visual-type="card"] [data-card-value]', { timeout: 30_000 });
      assert.equal(await kpi(), 550);
      await page.click('[data-menu="add-visual"]');
      await page.click('[role="menuitem"]:has-text("Slicer")');
      await page.waitForSelector('[data-visual-type="slicer"] [data-slicer]', { timeout: 30_000 });
      await page.click('[data-menu="add-visual"]');
      await page.click('[role="menuitem"]:has-text("Table")');
      await page.waitForSelector('[data-visual-type="table"] [data-bi-table] tbody tr', { timeout: 30_000 });
      await page.click('[data-bi-edit]');
      await shot('dashboard-built');
    });

    await step('a slicer filters and a selection cross-filters: the card is the engine\'s number for the selection', async () => {
      const slicerButtons = page.locator('[data-visual-type="slicer"] [data-slicer="buttons"] button');
      await slicerButtons.first().waitFor({ timeout: 15_000 });
      // Slicer on the first text field (region).
      await page.click('[data-visual-type="slicer"] button:has-text("EMEA")');
      await page.waitForFunction(() => document.querySelector('[data-visual-type="card"] [data-card-value]')?.getAttribute('data-card-value') === '200', null, { timeout: 20_000 });
      await shot('dashboard-slicer');
      await page.click('[data-visual-type="slicer"] button:has-text("EMEA")');
      await page.waitForFunction(() => document.querySelector('[data-visual-type="card"] [data-card-value]')?.getAttribute('data-card-value') === '550', null, { timeout: 20_000 });
      // A selection in the table cross-filters the card (and highlights the column chart).
      await page.click('[data-visual-type="table"] tbody tr:has-text("Americas")');
      await page.waitForFunction(() => document.querySelector('[data-visual-type="card"] [data-card-value]')?.getAttribute('data-card-value') === '200', null, { timeout: 20_000 });
      await shot('dashboard-cross-filter');
      await page.click('[data-visual-type="table"] tbody tr:has-text("Americas")');
      await page.waitForFunction(() => document.querySelector('[data-visual-type="card"] [data-card-value]')?.getAttribute('data-card-value') === '550', null, { timeout: 20_000 });
      // Lineage on demand: the dataset, its refresh time and the SQL.
      await page.locator('[data-visual-type="card"]').hover();
      await page.click('[data-visual-type="card"] [data-lineage-button]');
      await page.waitForSelector('[data-visual-type="card"] [data-lineage-sql]');
      assert.match(await page.locator('[data-visual-type="card"] [data-lineage]').innerText(), /sales from Sales CSV/);
      await shot('lineage', page.locator('[data-visual-type="card"]'));
      await page.click('[data-visual-type="card"] [data-lineage-button]');
    });

    await step('the CSV changes; a refresh shows the new numbers', async () => {
      writeCsv([['EMEA', 'Online', 120, 3], ['EMEA', 'Retail', 80, 2], ['Americas', 'Online', 260, 6], ['APAC', 'Retail', 150, 4]]);
      await page.click('[data-bi-refresh]');
      await page.waitForFunction(() => document.querySelector('[data-visual-type="card"] [data-card-value]')?.getAttribute('data-card-value') === '610', null, { timeout: 30_000 });
    });

    let url = '';
    await step('published: the same visuals in a browser, updated live when the data is refreshed', async () => {
      await page.click('[data-bi-publish]');
      await page.click('[data-bi-publish-go]');
      await page.waitForSelector('[data-bi-published-url]', { timeout: 20_000 });
      url = (await page.locator('[data-bi-published-url] .font-mono').innerText()).trim();
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/p\/[A-Za-z0-9_-]{16}#t=hwp_/);
      await shot('publish-dialog', page.locator('[role="dialog"]'));
      await page.keyboard.press('Escape');
      viewer = await pw.chromium.launch();
      const vp = await viewer.newPage({ viewport: { width: 1280, height: 860 } });
      await vp.goto(url);
      await vp.waitForSelector('[data-bi-ready="1"]', { timeout: 60_000 });
      assert.equal(await vp.getAttribute('[data-visual-type="card"] [data-card-value]', 'data-card-value'), '610');
      assert.ok(await vp.locator('[data-visual-type="column"] [data-chart="bi"]').count());
      if (SHOTS) await vp.screenshot({ path: path.join(SHOTS, 'published-page.png') });
      writeCsv([['EMEA', 'Online', 120, 3], ['EMEA', 'Retail', 80, 2], ['Americas', 'Online', 260, 6], ['APAC', 'Retail', 350, 9]]);
      await page.click('[data-bi-refresh]');
      await vp.waitForFunction(() => document.querySelector('[data-visual-type="card"] [data-card-value]')?.getAttribute('data-card-value') === '810', null, { timeout: 30_000 });
      await vp.close();
    });

    await step('an agent applies a change request through the ops: the dashboard updates, the change is listed with Undo', async () => {
      await page.click('[data-bi-ask]');
      await page.fill('[data-prompt-input]', 'make the by-region chart a bar and add an Orders card');
      await page.click('[data-prompt-ok]');
      await page.waitForSelector('[data-ask-panel]', { timeout: 20_000 });
      await page.waitForSelector('[data-ask-panel][data-status="idle"] [data-assistant-message]:has-text("Done.")', { timeout: 60_000 });
      await page.waitForSelector('[data-visual-type="bar"]', { timeout: 20_000 });
      assert.equal(await page.locator('[data-visual-type="card"]').count(), 2);
      // The agent's steps fold under "Worked for" when its turn ends: open them to see the tool cards.
      const steps = page.locator('[data-ask-panel] [data-steps]').first();
      if (await steps.getAttribute('data-open') !== '1') await steps.locator('button').first().click();
      const change = page.locator('[data-ask-panel] [data-data-change]').filter({ hasText: 'visual' }).first();
      assert.match(await change.innerText(), /~ visual .* bar/);
      await shot('agent-change-request');
      await change.locator('[data-undo-change]').click();
      await page.waitForSelector('[data-visual-type="column"]', { timeout: 20_000 });
      assert.equal(await page.locator('[data-visual-type="card"]').count(), 1);
      await page.click('[aria-label="Close the panel"]');
    });

    await step('layouts: sections, then a free-form canvas where a widget is dragged; back to the grid', async () => {
      const layoutTo = async (type: string) => {
        await page.click('[data-menu="layout"]');
        await page.click('[role="menuitem"]:has-text("Layout type and options")');
        await page.click(`[data-layout-type="${type}"]`);
        await page.click('[data-save-layout]');
        await page.waitForSelector(`[data-bi-doc][data-layout="${type}"]`, { timeout: 20_000 });
      };
      await layoutTo('sections');
      await page.waitForSelector('[data-bi-section]');
      await shot('layout-sections-app');
      await page.click('[data-bi-edit]');
      await layoutTo('canvas');
      const card = page.locator('[data-bi-cell] [data-visual-type="card"] header').first();
      const cell = page.locator('[data-bi-cell]:has([data-visual-type="card"])').first();
      const before = await cell.boundingBox();
      const box = (await card.boundingBox())!;
      await page.mouse.move(box.x + 30, box.y + 10);
      await page.mouse.down();
      await page.mouse.move(box.x + 230, box.y + 70, { steps: 8 });
      await page.mouse.up();
      await page.waitForFunction((x0) => { const el = document.querySelector('[data-bi-cell]:has([data-visual-type="card"])') as HTMLElement | null; return !!el && el.getBoundingClientRect().x > x0 + 100; }, before!.x, { timeout: 20_000 });
      await shot('layout-canvas-app');
      await layoutTo('grid');
      await page.click('[data-bi-edit]');
    });

    await step('an agent makes the page a TV wall (set_layout through the ops); undo puts it back', async () => {
      await page.click('[data-bi-ask]');
      await page.fill('[data-prompt-input]', 'make this a TV wall for the ops room');
      await page.click('[data-prompt-ok]');
      await page.waitForSelector('[data-ask-panel][data-status="idle"] [data-assistant-message]:has-text("TV wall")', { timeout: 60_000 });
      await page.waitForSelector('[data-bi-doc][data-layout="tv"]', { timeout: 20_000 });
      assert.equal(await page.locator('[data-bi-toolbar]').count(), 0, 'no chrome on a TV wall');
      await shot('agent-tv-wall');
      const steps = page.locator('[data-ask-panel] [data-steps]').last();
      if (await steps.getAttribute('data-open') !== '1') await steps.locator('button').first().click();
      await page.locator('[data-ask-panel] [data-data-change] [data-undo-change]').last().click();
      await page.waitForSelector('[data-bi-doc][data-layout="grid"]', { timeout: 20_000 });
      await page.click('[aria-label="Close the panel"]');
    });

    await step('unpublished: the page is refused at once', async () => {
      await page.click('[data-bi-publish]');
      await page.click('[data-bi-unpublish]');
      await page.waitForTimeout(500);
      const vp = await viewer!.newPage();
      await vp.goto(url);
      await vp.waitForSelector('[data-bi-error]', { timeout: 30_000 });
      assert.match(await vp.locator('[data-bi-error]').innerText(), /not published/);
      const r = await api('GET', `/api/data/docs/${docId}`);
      assert.equal(r.body.published, null);
    });

    const unexpected = errors.filter((e) => !/Failed to load resource|ResizeObserver/.test(e.text));
    assert.deepEqual(unexpected, [], 'no unexpected errors in the window');
  } finally {
    await viewer?.close().catch(() => {});
    await app.close().catch(() => {});
  }
});
