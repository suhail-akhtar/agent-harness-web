// Every pane of the desktop resizes, end to end: the real Electron app against a scripted engine
// (nothing is spent), off-screen with its own data folder.
//
//   - the sidebar: dragged wider, the keys on its handle (arrows, Shift, Home, End), double-click
//     back to the default, dragged below the threshold it collapses to the rail, dragged out again
//     it expands; the sizes are in the prefs file
//   - the side panel (a plugin's frame panel): dragged across its frame (the frame does not take the
//     pointer while dragging), keys, double-click; clamped when the window is small, its size back
//     when the window grows again
//   - a page's own split (Dashboards' Data: the dataset list beside the detail)
//   - all of them persist across a reload and a restart; "Reset the layout" in the palette resets them
//
// HARNESS_DESKTOP_SCREENSHOTS=1 writes the screenshots to docs/screenshots/desktop/layout/ (else to a temporary folder).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { assertNotBlank, capture } from './fixtures/desktop/png.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = path.join(root, 'apps', 'desktop');
const SHOTS = process.env.HARNESS_DESKTOP_SCREENSHOTS === '1' ? path.join(root, 'docs', 'screenshots', 'desktop', 'layout') : fs.mkdtempSync(path.join(os.tmpdir(), 'hd-layout-shots-'));
const electronExe = (() => { try { return String(createRequire(import.meta.url)('electron')); } catch { return ''; } })();

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
  const out = path.join(desktop, 'dist', 'renderer', 'index.html');
  const src = Math.max(newest(path.join(desktop, 'electron')), newest(path.join(desktop, 'renderer')), newest(path.join(desktop, 'shared')), newest(path.join(root, 'packages')));
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= src) return null;
  const r = spawnSync(process.execPath, [path.join(desktop, 'scripts', 'build.mjs')], { cwd: root, stdio: 'pipe', encoding: 'utf8', timeout: 600_000 });
  return r.status === 0 ? null : `build failed: ${(r.stderr || r.stdout).slice(-800)}`;
}

type Page = import('playwright-core').Page;
type App = import('playwright-core').ElectronApplication;

test('layout: every pane resizes (drag, keys, double-click, collapse) and keeps its size across a reload and a restart', { timeout: 10 * 60_000 }, async (t) => {
  if (!electronExe || !fs.existsSync(electronExe)) { t.skip('Electron is not installed (npm install, or node node_modules/electron/install.js)'); return; }
  let pw: typeof import('playwright-core');
  try { pw = await import('playwright-core'); } catch { t.skip('playwright-core is not installed'); return; }
  const failed = ensureBuilt();
  if (failed) assert.fail(failed);

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-layout-'));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_API_KEY$|^GW_|^HARNESS_|^NODE_TEST_CONTEXT$/.test(k)) env[k] = v;
  Object.assign(env, {
    HARNESS_DESKTOP_DATA: data,
    HARNESS_DESKTOP_TEST: '1', ...(process.env.HARNESS_E2E_SHOW ? { HARNESS_E2E_SHOW: process.env.HARNESS_E2E_SHOW } : {}),
    HARNESS_DESKTOP_ENGINE: path.join(root, 'test', 'fixtures', 'desktop', 'scripted-engine.ts'),
    HARNESS_DESKTOP_NO_TRAY: '1',
    HARNESS_PLUGINS: path.join(root, 'examples', 'plugins', 'hello-frame'),
    HARNESS_PLUGIN_LOOPS: 'off',
  });
  fs.mkdirSync(SHOTS, { recursive: true });
  let phase = 'start';
  const errors: Array<{ phase: string; text: string }> = [];
  let app!: App;
  let page!: Page;
  const launch = async (): Promise<boolean> => {
    try { app = await pw._electron.launch({ executablePath: electronExe, args: [desktop], env, timeout: 60_000 }); }
    catch (e) { t.skip(`Electron could not start here: ${(e as Error).message.split('\n')[0]}`); return false; }
    page = await app.firstWindow();
    page.on('pageerror', (e) => errors.push({ phase, text: `exception: ${e.message}` }));
    page.on('console', (m) => { const where = m.location().url ?? ''; if (m.type() === 'error' && !/\/plugins\/|^harness:\/\/preview|^about:srcdoc/.test(where)) errors.push({ phase, text: `console: ${m.text()} (${where})` }); });
    await setSize(1280, 820);
    await page.waitForSelector('[data-engine-status="ready"]', { timeout: 90_000 });
    await page.waitForSelector('[data-sidebar]');
    return true;
  };
  let shotN = 0;
  const shot = async (name: string, el?: import('playwright-core').Locator) => { await page.waitForTimeout(300); shotN++; const png = await capture(app, el); assertNotBlank(png, name); fs.writeFileSync(path.join(SHOTS, `${String(shotN).padStart(2, '0')}-${name}.png`), png); };
  const setSize = (w: number, h: number) => app.evaluate(({ BrowserWindow }, s) => { const win = BrowserWindow.getAllWindows()[0]!; if (win.isMaximized()) win.unmaximize(); win.setContentSize(s.w, s.h); }, { w, h });
  const innerWidth = () => page.evaluate(() => window.innerWidth);
  const invoke = (channel: string, ...args: unknown[]) => page.evaluate(([c, a]) => (window as unknown as { harnessDesktop: { invoke: (c: string, ...x: unknown[]) => Promise<unknown> } }).harnessDesktop.invoke(c as string, ...(a as unknown[])), [channel, args] as const);
  const prefs = () => invoke('prefs:get') as Promise<{ sidebar: { width: number; collapsed: boolean }; panes: Record<string, { size?: number; collapsed?: boolean }> }>;
  const width = (sel: string) => page.$eval(sel, (e) => Math.round(e.getBoundingClientRect().width));
  const valueNow = async (handle: string) => Number(await page.getAttribute(`[data-resize-handle="${handle}"]`, 'aria-valuenow'));
  /** A real drag: down on the handle, moved in steps, up. `during` runs with the button still down. */
  const drag = async (handle: string, dx: number, during?: () => Promise<void>) => {
    const b = (await page.locator(`[data-resize-handle="${handle}"]`).boundingBox())!;
    const x = b.x + b.width / 2; const y = b.y + Math.min(b.height / 2, 300);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx / 2, y, { steps: 6 });
    await page.mouse.move(x + dx, y, { steps: 6 });
    if (during) await during();
    await page.mouse.up();
    await page.waitForTimeout(150);
  };
  const key = async (handle: string, k: string) => { await page.focus(`[data-resize-handle="${handle}"]`); await page.keyboard.press(k); await page.waitForTimeout(60); };
  /** The dataset list's width in its page: its size, leaving the detail 320px, never below its min. */
  const listFits = async (size: number) => { const box = await page.$eval('[data-pane="dashboards.datasets"]', (e) => e.parentElement!.getBoundingClientRect().width); return Math.max(180, Math.min(size, Math.round(box - 320))); };
  const near = (a: number, b: number, what: string, tol = 3) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not about ${b}`);
  const step = (name: string, fn: () => Promise<void>) => t.test(name, async () => {
    phase = name;
    try { await fn(); } catch (e) {
      await capture(app).then((png) => fs.writeFileSync(path.join(SHOTS, `fail-${name.slice(0, 40).replace(/[^a-z0-9]+/gi, '-')}.png`), png)).catch(() => {});
      for (let i = 0; i < 2; i++) await page.mouse.up().catch(() => {});
      throw e;
    }
  });

  if (!(await launch())) return;
  try {
    await step('the sidebar: a drag, the keys, double-click to reset', async () => {
      const h = page.locator('[data-resize-handle="sidebar"]');
      assert.equal(await h.getAttribute('role'), 'separator');
      assert.equal(await h.getAttribute('aria-orientation'), 'vertical');
      assert.equal(await h.getAttribute('tabindex'), '0');
      assert.equal(await h.getAttribute('aria-valuemin'), '56', 'it collapses to the rail');
      assert.equal(await h.getAttribute('aria-valuemax'), '480');
      assert.equal(await h.evaluate((e) => getComputedStyle(e).cursor), 'col-resize');
      near(await h.evaluate((e) => e.getBoundingClientRect().width), 6, 'a 6px hit area', 0.5);
      near(await width('[data-sidebar]'), 272, 'the default');
      await h.hover();
      await page.waitForTimeout(300);
      assert.ok(Number(await h.evaluate((e) => getComputedStyle(e, '::after').opacity)) > 0.3, 'a line shows on hover');
      await drag('sidebar', 90);
      near(await width('[data-sidebar]'), 362, 'dragged wider');
      await page.waitForFunction(() => true);
      near((await prefs()).sidebar.width, 362, 'saved in the prefs');
      await shot('sidebar-wider');
      await key('sidebar', 'ArrowRight');
      assert.equal(await valueNow('sidebar'), 378, 'ArrowRight: a step');
      await key('sidebar', 'Shift+ArrowLeft');
      assert.equal(await valueNow('sidebar'), 314, 'Shift: four steps');
      await key('sidebar', 'End');
      assert.equal(await width('[data-sidebar]'), 480, 'End: the max');
      await key('sidebar', 'Home');
      assert.equal(await width('[data-sidebar]'), 200, 'Home: the min');
      await h.dblclick();
      await page.waitForFunction(() => Math.round(document.querySelector('[data-sidebar]')!.getBoundingClientRect().width) === 272);
      assert.equal((await prefs()).sidebar.width, 272, 'double-click: the default, saved');
    });

    await step('the sidebar collapses when dragged below the threshold, and expands when dragged out again (or Enter)', async () => {
      await drag('sidebar', -180, async () => {
        // While dragging: no text selection, the resize cursor everywhere.
        assert.equal(await page.evaluate(() => document.documentElement.classList.contains('hx-resizing')), true);
        assert.equal(await page.evaluate(() => getComputedStyle(document.body).userSelect), 'none');
        await page.waitForSelector('[data-sidebar][data-collapsed="1"]', { timeout: 2_000 });
      });
      await page.waitForSelector('[data-sidebar][data-collapsed="1"]');
      assert.equal(await width('[data-sidebar]'), 56, 'the rail');
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains('hx-resizing')), false, 'the drag state is gone');
      const p = await prefs();
      assert.equal(p.sidebar.collapsed, true, 'collapsed in the prefs');
      assert.equal(p.sidebar.width, 272, 'the width kept for later');
      await shot('sidebar-collapsed');
      await drag('sidebar', 60);
      assert.equal(await page.getAttribute('[data-sidebar]', 'data-collapsed'), '1', 'a small pull stays collapsed');
      await drag('sidebar', 260);
      await page.waitForSelector('[data-sidebar][data-collapsed="0"]');
      const w = await width('[data-sidebar]');
      assert.ok(w >= 200 && w <= 330, `expanded by the drag (${w})`);
      assert.equal((await prefs()).sidebar.collapsed, false);
      await key('sidebar', 'Enter');
      await page.waitForSelector('[data-sidebar][data-collapsed="1"]');
      await key('sidebar', 'Enter');
      await page.waitForSelector('[data-sidebar][data-collapsed="0"]');
      await page.locator('[data-resize-handle="sidebar"]').dblclick();
      await page.waitForFunction(() => Math.round(document.querySelector('[data-sidebar]')!.getBoundingClientRect().width) === 272);
    });

    await step('the side panel (a plugin frame): dragged across its frame, the keys, double-click, clamped to a small window', async () => {
      await page.click('[data-nav="core.chat:new"]');
      await page.waitForSelector('[data-home]');
      const box = page.locator('[data-composer-input]');
      await box.fill('hello there');
      await box.press('Enter');
      await page.waitForSelector('[data-session] [data-assistant-message]', { timeout: 30_000 });
      await page.click('[data-panel-toggle="hello-frame:hello-panel"]');
      // The plugin asks for its grants first: it runs without them here.
      const noAccess = page.locator('[data-side-panel] button:has-text("Run without access")');
      await noAccess.waitFor({ timeout: 10_000 }).then(() => noAccess.click()).catch(() => {});
      await page.waitForSelector('[data-side-panel] [data-plugin-frame] iframe', { timeout: 20_000 });
      const vw = await innerWidth();
      const w0 = await width('[data-side-panel]');
      near(w0, Math.round(Math.min(520, vw * 0.42)), 'the default');
      // Shrink it by dragging right, across the frame: the frame does not take the pointer while dragging.
      await drag('side-panel', 140, async () => {
        assert.equal(await page.$eval('[data-side-panel] iframe', (e) => getComputedStyle(e).pointerEvents), 'none', 'frames ignore the pointer during a drag');
      });
      near(await width('[data-side-panel]'), w0 - 140, 'dragged narrower across the frame');
      assert.equal(await page.$eval('[data-side-panel] iframe', (e) => getComputedStyle(e).pointerEvents), 'auto', 'and take it again after');
      near((await prefs()).panes['side-panel']?.size ?? 0, w0 - 140, 'saved in the prefs');
      await drag('side-panel', -240);
      near(await width('[data-side-panel]'), w0 + 100, 'dragged wider');
      await shot('side-panel-wider');
      await key('side-panel', 'ArrowLeft');
      near(await width('[data-side-panel]'), w0 + 116, 'ArrowLeft grows a pane on the right');
      await key('side-panel', 'Home');
      assert.equal(await width('[data-side-panel]'), 280, 'Home: its min');
      await key('side-panel', 'End');
      const sb = await width('[data-sidebar]');
      near(await width('[data-side-panel]'), vw - sb - 360, 'End: its max, the main content keeps 360px');
      near(await page.$eval('[data-view]', (e) => e.getBoundingClientRect().width), 360, 'the main content at its minimum', 4);
      await shot('side-panel-max');
      // A smaller window clamps it; the saved size comes back when the window grows again.
      await drag('side-panel', 200);
      const saved = await width('[data-side-panel]');
      await setSize(1000, 760);
      await page.waitForFunction(() => window.innerWidth < 1100);
      const small = await innerWidth();
      const ws = await width('[data-side-panel]');
      assert.ok(ws <= small - (await width('[data-sidebar]')) - 360 + 1, `clamped to the small window (${ws})`);
      assert.ok((await page.$eval('[data-view]', (e) => e.getBoundingClientRect().width)) >= 359, 'the main content stays usable');
      await shot('small-window-clamped');
      await setSize(1280, 820);
      await page.waitForFunction(() => window.innerWidth > 1200);
      near(await width('[data-side-panel]'), saved, 'its size back in the larger window');
      await page.locator('[data-resize-handle="side-panel"]').dblclick();
      await page.waitForTimeout(200);
      near(await width('[data-side-panel]'), w0, 'double-click: the default');
      assert.equal((await prefs()).panes['side-panel'], undefined, 'the default is not saved');
      // Leave it at a size to check after the restart.
      await drag('side-panel', -60);
    });

    await step('a page\'s split: the dataset list of Dashboards\' Data page', async () => {
      await page.click('[data-side-panel] button[aria-label="Close the panel"]');
      await page.click('[data-nav="core.dashboards:data"]');
      await page.waitForSelector('[data-resize-handle="dashboards.datasets"]', { timeout: 20_000 });
      await page.waitForTimeout(200);
      near(await width('[data-pane="dashboards.datasets"]'), 256, 'the default');
      await drag('dashboards.datasets', 100);
      near(await width('[data-pane="dashboards.datasets"]'), 356, 'dragged wider');
      await key('dashboards.datasets', 'ArrowLeft');
      near(await width('[data-pane="dashboards.datasets"]'), 340, 'a key');
      near((await prefs()).panes['dashboards.datasets']?.size ?? 0, 340, 'saved');
      await shot('data-page-split');
    });

    await step('the sizes persist across a reload', async () => {
      await drag('sidebar', 40);
      const before = { sidebar: await width('[data-sidebar]'), list: await width('[data-pane="dashboards.datasets"]') };
      await page.reload();
      await page.waitForSelector('[data-engine-status="ready"]', { timeout: 90_000 });
      await page.waitForSelector('[data-resize-handle="dashboards.datasets"]', { timeout: 20_000 });
      near(await width('[data-sidebar]'), before.sidebar, 'the sidebar after a reload');
      near(await width('[data-pane="dashboards.datasets"]'), before.list, 'the dataset list after a reload');
    });

    let expected = { sidebar: 0, panel: 0, list: 0 };
    await step('and across a restart', async () => {
      const p = await prefs();
      expected = { sidebar: p.sidebar.width, panel: p.panes['side-panel']?.size ?? 0, list: p.panes['dashboards.datasets']?.size ?? 0 };
      assert.ok(expected.panel > 0 && expected.list > 0);
      await app.close();
      if (!(await launch())) return;
      near(await width('[data-sidebar]'), expected.sidebar, 'the sidebar after a restart');
      await page.click('[data-nav="core.dashboards:data"]');
      await page.waitForSelector('[data-pane="dashboards.datasets"]', { timeout: 20_000 });
      near(await width('[data-pane="dashboards.datasets"]'), expected.list, 'the dataset list after a restart');
      await page.click('[data-panel-toggle="core.dashboards:ask"]');
      await page.waitForSelector('[data-side-panel]');
      near(await width('[data-side-panel]'), expected.panel, 'the side panel after a restart');
      // With the side panel open the page is narrower: its list leaves the detail its room.
      await page.waitForTimeout(200);
      near(await width('[data-pane="dashboards.datasets"]'), await listFits(expected.list), 'the list leaves the detail 320px (or is at its min)');
      await shot('after-restart');
    });

    await step('"Reset the layout" in the palette puts every pane back to its default', async () => {
      await page.keyboard.press('Control+K');
      await page.waitForSelector('[data-palette]');
      await page.keyboard.type('Reset the layout');
      await page.waitForTimeout(200);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => Math.round(document.querySelector('[data-sidebar]')!.getBoundingClientRect().width) === 272);
      near(await width('[data-pane="dashboards.datasets"]'), await listFits(256), 'the list (at its default, as far as the page lets it)');
      const vw = await innerWidth();
      near(await width('[data-side-panel]'), Math.round(Math.min(520, vw * 0.42)), 'the side panel');
      const p = await prefs();
      assert.deepEqual(p.panes, {});
      assert.equal(p.sidebar.width, 272);
      await shot('layout-reset');
    });

    assert.deepEqual(errors, [], 'no errors in the window');
  } finally {
    await app.close().catch(() => {});
    try { fs.rmSync(data, { recursive: true, force: true, maxRetries: 3 }); } catch { /* in use (Windows) */ }
    console.log(`# screenshots: ${SHOTS}`);
  }
});
