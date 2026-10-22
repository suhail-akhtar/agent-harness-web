// Every layout type and the templates, drawn by the published-page viewer in Chromium (the same
// components as the app) with real data: a screenshot of each; the TV layout rotates its pages;
// the print layout's PDF has the pages the screen shows, each with its header. No paid calls;
// skipped when there is no Chromium for playwright-core.
//
// HARNESS_DESKTOP_SCREENSHOTS=1 writes docs/screenshots/desktop/dashboards/layout-*.png and template-*.png.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LAYOUT_TYPES } from '../packages/plugin-ui/src/bi.ts';
import { demo } from './fixtures/dashboards/demo-server.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.env.HARNESS_DESKTOP_SCREENSHOTS === '1' ? path.join(root, 'docs', 'screenshots', 'desktop', 'dashboards') : null;

function newest(dir: string): number {
  let t = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (e.name === 'node_modules') continue; const p = path.join(dir, e.name); t = Math.max(t, e.isDirectory() ? newest(p) : fs.statSync(p).mtimeMs); }
  return t;
}

test('layouts and templates in the browser', { timeout: 15 * 60_000 }, async (t) => {
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
  const browser = await pw.chromium.launch();
  const errors: string[] = [];
  try {
    const open = async (doc: string, o: { width?: number; height?: number; name?: string } = {}) => {
      const pub = await d.ops([{ op: 'publish', doc, access: 'token' }]);
      const { slug, token } = pub.results[0]!.data as { slug: string; token: string };
      const page = await browser.newPage({ viewport: { width: o.width ?? 1360, height: o.height ?? 900 } });
      page.on('pageerror', (e) => errors.push(`${o.name ?? doc}: ${e.message}`));
      await page.goto(`${d.base}/p/${slug}#t=${token}`);
      await page.waitForSelector('[data-bi-ready="1"]', { timeout: 90_000 });
      await page.waitForTimeout(700);
      return page;
    };
    const fromTemplate = async (template: string, title: string) => ((await d.ops([{ op: 'apply_template', template, model: 'sales', title }])).results[0]!.data as { id: string }).id;

    await t.test('each layout type renders with its widgets', async () => {
      for (const type of LAYOUT_TYPES) {
        const doc = await fromTemplate('executive', `Layout: ${type}`);
        await d.ops([{ op: 'add_visual', doc, visual: { type: 'slicer', title: 'Region', options: { slicer: { field: 'countries.region', style: 'list' } } } }]);
        if (type !== 'grid') await d.ops([{ op: 'set_layout', doc, layout: { type, ...(type === 'tv' ? { rotate: 0 } : {}) } }]);
        const page = await open(doc, { name: type, ...(type === 'tv' ? { width: 1600, height: 900 } : {}) });
        assert.equal(await page.getAttribute('[data-bi-doc]', 'data-layout'), type);
        assert.ok(await page.locator(`[data-bi-grid="${type}"]`).count(), `${type} drawn`);
        assert.ok(await page.locator('[data-visual]').count() >= (type === 'tabs' ? 1 : 5), `${type}: widgets shown`);
        if (type === 'tv') assert.equal(await page.locator('[data-bi-toolbar]').count(), 0, 'a TV wall has no chrome');
        if (type === 'tabs') { await page.click('[data-bi-panel-tab]:nth-child(2)'); await page.waitForSelector('[data-bi-ready="1"]'); }
        if (type === 'sections') { await page.click('[data-bi-section] button >> nth=0'); await page.waitForTimeout(200); await page.click('[data-bi-section] button >> nth=0'); }
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `layout-${type}.png`), fullPage: type !== 'tv' });
        if (type === 'grid') {
          // The phone arrangement of the same page.
          const phone = await open(doc, { width: 390, height: 844, name: 'phone' });
          assert.ok(await phone.locator('[data-bi-grid="phone"]').count());
          if (SHOTS) await phone.screenshot({ path: path.join(SHOTS, 'layout-grid-phone.png'), fullPage: true });
          await phone.close();
          const medium = await open(doc, { width: 900, name: 'medium' });
          assert.equal(await medium.getAttribute('[data-bi-breakpoint]', 'data-bi-breakpoint'), 'medium');
          await medium.close();
        }
        await page.close();
      }
    });

    await t.test('the TV layout rotates its pages on its timer', async () => {
      const doc = await fromTemplate('noc', 'Ops room');
      await d.ops([{ op: 'apply_template', doc, template: 'executive', model: 'sales' }]);
      const { spec } = await d.harness.data.home(undefined).doc(doc);
      await d.ops(spec.pages.map((p) => ({ op: 'set_layout', doc, page: p.id, layout: { type: 'tv', rotate: 2 } })));
      const page = await open(doc, { width: 1600, height: 900, name: 'tv' });
      const first = await page.getAttribute('[data-bi-doc]', 'data-bi-page');
      await page.waitForFunction((p) => document.querySelector('[data-bi-doc]')?.getAttribute('data-bi-page') !== p, first, { timeout: 15_000 });
      const second = await page.getAttribute('[data-bi-doc]', 'data-bi-page');
      assert.notEqual(second, first);
      await page.waitForFunction((p) => document.querySelector('[data-bi-doc]')?.getAttribute('data-bi-page') !== p, second, { timeout: 15_000 });
      assert.equal(await page.getAttribute('[data-bi-doc]', 'data-bi-page'), first, 'and round again');
      if (SHOTS) { await page.waitForSelector('[data-bi-ready="1"]'); await page.waitForTimeout(600); await page.screenshot({ path: path.join(SHOTS, 'template-noc-tv.png') }); }
      await page.close();
    });

    await t.test('the print layout paginates: the PDF has the pages the screen shows, each with its header and footer', async () => {
      const doc = await fromTemplate('sales', 'Monthly sales report');
      await d.ops([{ op: 'apply_template', doc, template: 'executive', model: 'sales' }]);
      const { spec } = await d.harness.data.home(undefined).doc(doc);
      await d.ops(spec.pages.map((p) => ({ op: 'set_layout', doc, page: p.id, layout: { type: 'print', paper: 'A4', orientation: 'portrait' } })));
      await d.ops([{ op: 'set_doc', doc, patch: { header: '{title} · ACME Ltd', footer: 'Confidential · {date}' } }]);
      // On screen (print mode): every page of the document as paper.
      const pub = await d.ops([{ op: 'publish', doc, access: 'token' }]);
      const { slug, token } = pub.results[0]!.data as { slug: string; token: string };
      const page = await browser.newPage({ viewport: { width: 1000, height: 1200 } });
      await page.goto(`${d.base}/p/${slug}?print=1#t=${token}`);
      await page.waitForSelector('[data-bi-ready="1"]', { timeout: 90_000 });
      const papers = await page.locator('[data-bi-paper]').count();
      assert.ok(papers >= 3, `${papers} pages`);
      assert.equal(await page.locator('[data-bi-paper-header]:has-text("Monthly sales report · ACME Ltd")').count(), papers, 'a header on every page');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'layout-print-pages.png'), fullPage: true });
      await page.close();
      // The PDF the server renders.
      const res = await fetch(`${d.base}/api/data/docs/${doc}/export?format=pdf`, { headers: { authorization: `Bearer ${d.token}` } });
      assert.equal(res.status, 200, await res.clone().text().catch(() => ''));
      const pdf = new Uint8Array(await res.arrayBuffer());
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const loaded = await pdfjs.getDocument({ data: pdf, useSystemFonts: true }).promise;
      assert.equal(loaded.numPages, papers, 'one PDF page per paper page');
      for (let i = 1; i <= loaded.numPages; i++) {
        const text = (await (await loaded.getPage(i)).getTextContent()).items.map((x) => ('str' in x ? x.str : '')).join(' ');
        assert.match(text, /Monthly sales report · ACME Ltd/, `header on page ${i}`);
        assert.match(text, new RegExp(`${i} / ${loaded.numPages}`), `page number on page ${i}`);
      }
      const vp = (await loaded.getPage(1)).getViewport({ scale: 1 });
      assert.ok(vp.height > vp.width, 'A4 portrait');
    });

    await t.test('templates filled with real data', async () => {
      for (const id of ['executive', 'sales', 'funnel', 'product', 'delivery', 'sre', 'lab', 'quality']) {
        const doc = await fromTemplate(id, `Template: ${id}`);
        const page = await open(doc, { name: id });
        assert.equal(await page.locator('[data-visual-error]').count(), 0, `${id}: no visual failed`);
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `template-${id}.png`), fullPage: true });
        await page.close();
      }
    });
    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    await browser.close();
    await d.close();
  }
});
