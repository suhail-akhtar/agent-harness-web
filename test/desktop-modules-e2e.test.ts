// Plugins as first-class modules, end to end: the real Electron app against the real harness
// server with the sdlc ("Engineering"), quality-gates, research and aiops ("Operations") plugins on
// fixture monitoring, a dev plugin with a menu and no home of its own, and a scripted model
// (test/fixtures/desktop/modules-engine.ts: nothing is spent).
//
//   1. the sidebar: the core's items at the top, each module a group (header, items, badges)
//   2. fold and unfold, reorder (menu, keyboard, drag): remembered across a reload
//   3. the narrow rail: a group is one icon with a flyout of its items
//   4. every module's home: Agents, Dashboards, Engineering, Operations, and one the shell draws
//   5. the palette ("Plugin › Item") and the breadcrumbs ("Plugin > Page")
//   6. a scripted agent loads the Operations guide (a skill), opens its home with desktop_open, runs
//      its agent-callable ops check, opens Incidents; and loads the Dashboards guide from the app
//   7. a plugin switched off: its group, home, guide line and skill go; on again: back
//
// HARNESS_DESKTOP_SCREENSHOTS=1 writes the screenshots to docs/screenshots/desktop/modules/.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { assertNotBlank, capture } from './fixtures/desktop/png.ts';
import { pluginDir } from '../src/plugins/test-fixtures.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = path.join(root, 'apps', 'desktop');
const SHOTS = process.env.HARNESS_DESKTOP_SCREENSHOTS === '1' ? path.join(root, 'docs', 'screenshots', 'desktop', 'modules') : fs.mkdtempSync(path.join(os.tmpdir(), 'hd-modules-shots-'));
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

/** A third party's plugin with a menu (sub-items included) and no home: the shell draws one. */
function devPlugin(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-fieldnotes-'));
  fs.writeFileSync(path.join(dir, 'harness-plugin.json'), JSON.stringify({
    name: 'field-notes', version: '0.1.0', description: 'Field notes: a declarative plugin with a menu and no home of its own, so the app draws its home from the manifest.',
    ui: {
      apiVersion: 1, displayName: 'Field notes', icon: 'book', trust: 'declarative',
      menu: { title: 'Field notes', icon: 'book', order: 90, items: ['today', { id: 'guides', title: 'Guides', view: 'guides', icon: 'library', children: [{ id: 'safety', title: 'Safety', view: 'safety' }] }] },
      contributes: {
        navItems: [{ id: 'today', title: 'Today', icon: 'calendar', view: 'today' }],
        views: [
          { id: 'today', title: 'Today', kind: 'markdown', markdown: '# Today\n\nNothing logged yet.', description: 'What was logged today.' },
          { id: 'guides', title: 'Guides', kind: 'links', links: [{ title: 'Field guide', url: 'https://example.com/guide' }], description: 'Reference guides.' },
          { id: 'safety', title: 'Safety', kind: 'markdown', markdown: '# Safety\n\nWear a helmet.' },
        ],
        commands: [{ id: 'log', title: 'Log an observation', category: 'Field notes', icon: 'edit', action: { type: 'prompt', prompt: 'Log this observation: ', newChat: true } }],
        slashCommands: [{ name: 'observe', description: 'Log an observation', action: { type: 'prompt', prompt: 'Log this observation: {args}' } }],
        settings: [{ id: 'notes', title: 'Field notes', scope: 'app', schema: { type: 'object', properties: { units: { type: 'string', enum: ['metric', 'imperial'], default: 'metric' } } } }],
      },
    },
  }, null, 2));
  return dir;
}

test('plugins as modules: groups, fold and reorder, the rail, homes, palette and crumbs, an agent driving a plugin from its guide, on and off', { timeout: 15 * 60_000 }, async (t) => {
  if (!electronExe || !fs.existsSync(electronExe)) { t.skip('Electron is not installed'); return; }
  let pw: typeof import('playwright-core');
  try { pw = await import('playwright-core'); } catch { t.skip('playwright-core is not installed'); return; }
  const failed = ensureBuilt();
  if (failed) assert.fail(failed);

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-modules-'));
  const ops = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-modules-ops-')));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_API_KEY$|^GW_|^HARNESS_|^NODE_TEST_CONTEXT$/.test(k)) env[k] = v;
  Object.assign(env, {
    HARNESS_DESKTOP_DATA: data,
    HARNESS_DESKTOP_TEST: '1', ...(process.env.HARNESS_E2E_SHOW ? { HARNESS_E2E_SHOW: process.env.HARNESS_E2E_SHOW } : {}),
    HARNESS_DESKTOP_ENGINE: path.join(root, 'test', 'fixtures', 'desktop', 'modules-engine.ts'),
    HARNESS_DESKTOP_NO_TRAY: '1',
    HARNESS_DESKTOP_DEV_PLUGINS: devPlugin(),
    HARNESS_PLUGINS: ['quality-gates', 'sdlc', 'research', 'aiops'].map((p) => pluginDir(p)).join(path.delimiter),
    HARNESS_PLUGIN_LOOPS: 'off',
    HARNESS_OPS_ALERTS_PATH: ops,
    HARNESS_OPS_ALERTS_INVESTIGATE: '0',
    HARNESS_OPS_WATCH_SECONDS: '0',
    HARNESS_OPS_LOCAL_DOCKER: '',
  });
  let app: import('playwright-core').ElectronApplication;
  try { app = await pw._electron.launch({ executablePath: electronExe, args: [desktop], env, timeout: 60_000 }); }
  catch (e) { t.skip(`Electron could not start here: ${(e as Error).message.split('\n')[0]}`); return; }
  fs.mkdirSync(SHOTS, { recursive: true });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`exception: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/\/plugins\//.test(m.location().url ?? '')) errors.push(`${m.text()} (${m.location().url})`); });
  let shotN = 0;
  const shot = async (name: string, el?: import('playwright-core').Locator) => { await page.waitForTimeout(400); shotN++; const png = await capture(app, el); assertNotBlank(png, name); fs.writeFileSync(path.join(SHOTS, `${String(shotN).padStart(2, '0')}-${name}.png`), png); };
  const setSize = (w: number, h: number) => app.evaluate(({ BrowserWindow }, s) => { const win = BrowserWindow.getAllWindows()[0]!; if (win.isMaximized()) win.unmaximize(); win.setSize(s.w, s.h); }, { w, h });
  const invoke = (channel: string, ...args: unknown[]) => page.evaluate(([c, a]) => (window as unknown as { harnessDesktop: { invoke: (c: string, ...x: unknown[]) => Promise<unknown> } }).harnessDesktop.invoke(c as string, ...(a as unknown[])), [channel, args] as const);
  const api = (method: string, p: string, body?: unknown) => page.evaluate(async ([m, u, b]) => { const r = await fetch(u as string, { method: m as string, headers: { 'content-type': 'application/json', 'x-harness': '1' }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) }; }, [method, p, body] as const);
  const ready = () => page.waitForSelector('[data-engine-status="ready"]', { timeout: 90_000 });
  const frame = (qid: string) => page.frameLocator(`[data-view="${qid}"] [data-plugin-frame] iframe`);
  const grant = async () => { const g = page.locator('[data-grant]').first(); if (await g.isVisible().catch(() => false)) await g.click(); };
  const groups = () => page.$$eval('[data-modules] [data-group]', (els) => els.map((e) => e.getAttribute('data-group')!));
  const send = async (text: string) => { const box = page.locator('[data-composer-input]'); await box.fill(text); await box.press('Enter'); };
  const sessionOnScreen = async () => (await page.waitForSelector('[data-session]')).getAttribute('data-session');
  /** Waits for the conversation's turn to end; a request it makes (desktop_command) is allowed as the person would (the agent may have taken the window to another page). */
  const idle = async (sid: string, ms = 90_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const d = await api('GET', `/api/sessions/${sid}`);
      for (const p of (d.body?.pending ?? []) as Array<{ requestId: string; kind?: string }>) await api('POST', `/api/sessions/${sid}/respond`, { requestId: p.requestId, decision: 'allow' });
      if (d.body?.status === 'idle' && !(d.body?.pending ?? []).length) return;
      await page.waitForTimeout(300);
    }
    throw new Error(`session ${sid} did not finish`);
  };
  /** Sends a message in the conversation on screen and waits for the answer to it. */
  const ask = async (sid: string, text: string) => {
    const before = ((await api('GET', `/api/sessions/${sid}`)).body.history as unknown[]).length;
    await send(text);
    const end = Date.now() + 90_000;
    while (Date.now() < end) {
      const d = await api('GET', `/api/sessions/${sid}`);
      const h = d.body.history as Array<{ role: string }>;
      if (h.length > before + 1 && h.at(-1)!.role === 'assistant' && d.body.status === 'idle') return JSON.stringify(h.at(-1));
      await page.waitForTimeout(300);
    }
    throw new Error(`no answer to "${text}"`);
  };
  const step = (name: string, fn: () => Promise<void>) => t.test(name, async () => {
    try { await fn(); } catch (e) {
      await capture(app).then((png) => fs.writeFileSync(path.join(os.tmpdir(), `hd-modules-fail-${name.slice(0, 40).replace(/[^a-z0-9]+/gi, '-')}.png`), png)).catch(() => {});
      for (let i = 0; i < 3; i++) await page.keyboard.press('Escape').catch(() => {});
      throw e;
    }
  });
  await setSize(1360, 900);

  try {
    await step('setup: the engine is ready, the plugins on', async () => {
      await ready();
      await page.waitForSelector('[data-home]');
      await invoke('prefs:set', { onboardingDone: true, defaultMode: 'default' });
      for (const p of ['sdlc', 'aiops', 'research']) { const r = await api('POST', `/api/plugins/${p}/enable`); assert.ok(r.status === 200 || r.status === 409, `${p}: ${r.status}`); }
      await page.waitForSelector('[data-group="aiops"]', { timeout: 30_000 });
      // A plugin folder loaded in the app is the person's: under Custom, its pages under it.
      await page.waitForSelector('[data-group="custom"] [data-nav="field-notes:menu"]', { timeout: 30_000 });
    });

    await step('1. the sidebar: the core\'s items at the top, every module a group with its items and badges', async () => {
      const top = await page.$$eval('nav[aria-label="Main"] > [data-nav]', (els) => els.map((e) => e.getAttribute('data-nav')!));
      assert.deepEqual(top.slice(0, 2), ['core.chat:new', 'core.chat:search']);
      for (const id of ['core.inbox:inbox', 'core.activity:activity', 'core.projects:projects', 'core.plugins:plugins']) assert.ok(top.includes(id), `${id} stays at the top`);
      assert.ok(!top.some((x) => /^(aiops|sdlc|core\.dashboards|core\.agents|core\.artifacts):/.test(x)), 'nothing of a module at the top level');
      assert.deepEqual(await groups(), ['core.agents', 'core.dashboards', 'sdlc', 'aiops', 'custom']);
      const items = (g: string) => page.$$eval(`[data-group="${g}"] [data-nav]`, (els) => els.map((e) => e.getAttribute('data-nav')!));
      assert.deepEqual(await items('aiops'), ['aiops:incidents', 'aiops:alerts', 'aiops:services', 'aiops:topology', 'aiops:changes']);
      assert.deepEqual(await items('sdlc'), ['sdlc:delivery', 'sdlc:start', 'sdlc:quality']);
      assert.deepEqual(await items('core.agents'), ['core.agents:agents', 'core.artifacts:library']);
      assert.deepEqual(await items('core.dashboards'), ['core.dashboards:dashboards', 'core.dashboards:reports', 'core.dashboards:data']);
      assert.deepEqual(await items('custom'), ['field-notes:menu', 'field-notes:today', 'field-notes:guides', 'field-notes:safety'], 'an added plugin with a menu: an entry, its pages under it');
      await page.click('[data-nav="aiops:alerts"]');
      await page.waitForSelector('[data-view="aiops:alerts"]');
      await grant();
      assert.equal(await page.locator('[data-nav="aiops:alerts"]').getAttribute('aria-current'), 'page', 'the active item is highlighted');
      await shot('sidebar-groups', page.locator('[data-sidebar]'));
    });

    await step('2. fold, unfold and reorder the groups; remembered across a reload', async () => {
      await page.click('[data-group-fold="core.dashboards"]');
      await page.waitForSelector('[data-group="core.dashboards"][data-folded="1"]');
      assert.equal(await page.locator('[data-group="core.dashboards"] [data-nav]').count(), 0, 'its items are hidden');
      // The keyboard: Left folds, Right unfolds, on the header.
      await page.focus('[data-group-home="sdlc"]');
      await page.keyboard.press('ArrowLeft');
      await page.waitForSelector('[data-group="sdlc"][data-folded="1"]');
      await page.keyboard.press('ArrowRight');
      await page.waitForSelector('[data-group="sdlc"][data-folded="0"]');
      // Reorder from the group's menu, with the keyboard, and by dragging.
      await page.hover('[data-group-home="aiops"]');
      await page.click('[data-group-menu="aiops"]');
      await page.click('[role="menuitem"]:has-text("Move up")');
      await page.waitForFunction(() => [...document.querySelectorAll('[data-modules] [data-group]')].map((e) => e.getAttribute('data-group')).join(',') === 'core.agents,core.dashboards,aiops,sdlc,custom');
      await page.focus('[data-group-home="aiops"]');
      await page.keyboard.press('Alt+Shift+ArrowUp');
      await page.waitForFunction(() => [...document.querySelectorAll('[data-modules] [data-group]')].map((e) => e.getAttribute('data-group')).join(',') === 'core.agents,aiops,core.dashboards,sdlc,custom');
      await page.locator('[data-group-home="custom"]').dragTo(page.locator('[data-group-home="core.agents"]'));
      await page.waitForFunction(() => [...document.querySelectorAll('[data-modules] [data-group]')].map((e) => e.getAttribute('data-group'))[0] === 'custom', null, { timeout: 5_000 }).catch(async () => {
        // Some platforms do not deliver HTML drag events to a playwright drag: the menu does the same.
        await page.hover('[data-group-home="custom"]');
        for (let i = 0; i < 4; i++) { await page.click('[data-group-menu="custom"]'); await page.click('[role="menuitem"]:has-text("Move up")'); }
      });
      const order = await groups();
      assert.deepEqual(order, ['custom', 'core.agents', 'aiops', 'core.dashboards', 'sdlc']);
      await shot('sidebar-folded-reordered', page.locator('[data-sidebar]'));
      const prefs = await invoke('prefs:get') as { menus: { order: string[]; collapsed: Record<string, boolean> } };
      assert.deepEqual(prefs.menus.order, order, 'the order is a preference');
      assert.equal(prefs.menus.collapsed['core.dashboards'], true);
      await page.reload();
      await ready();
      await page.waitForSelector('[data-group="aiops"]', { timeout: 30_000 });
      assert.deepEqual(await groups(), order, 'remembered across a reload');
      assert.equal(await page.locator('[data-group="core.dashboards"]').getAttribute('data-folded'), '1');
      // Back to the menus' own order for the rest.
      await invoke('prefs:set', { menus: { order: [], collapsed: {} } });
      await page.waitForFunction(() => [...document.querySelectorAll('[data-modules] [data-group]')].map((e) => e.getAttribute('data-group')).join(',') === 'core.agents,core.dashboards,sdlc,aiops,custom', null, { timeout: 10_000 });
    });

    await step('3. the narrow rail: one icon per group, its items in a flyout', async () => {
      await page.click('[data-sidebar] button[aria-label="Collapse the sidebar"]');
      await page.waitForSelector('[data-sidebar][data-collapsed="1"]');
      for (const g of ['core.agents', 'core.dashboards', 'sdlc', 'aiops', 'custom']) assert.equal(await page.locator(`[data-group-rail="${g}"]`).count(), 1, g);
      await page.click('[data-group-rail="aiops"]');
      const menu = page.locator('[role="menu"]');
      await menu.waitFor();
      const labels = await menu.locator('[role="menuitem"]').allTextContents();
      assert.deepEqual(labels.map((l) => l.trim()).slice(0, 6), ['Home', 'Incidents', 'Alerts', 'Services', 'Topology', 'Changes']);
      await shot('rail-flyout');
      await menu.locator('[role="menuitem"]', { hasText: 'Services' }).click();
      await page.waitForSelector('[data-view="aiops:services"]');
      assert.equal(await page.locator('[data-group-rail="aiops"]').getAttribute('aria-expanded'), 'false');
      await page.click('[data-sidebar] button[aria-label="Expand the sidebar"]');
      await page.waitForSelector('[data-sidebar][data-collapsed="0"]');
      // A narrow window: the same rail.
      await setSize(700, 820);
      await page.waitForSelector('[data-group-rail="sdlc"]');
      await page.click('[data-group-rail="sdlc"]');
      await page.locator('[role="menu"] [role="menuitem"]', { hasText: 'Gates' }).click();
      await page.waitForSelector('[data-view="sdlc:quality"]');
      await setSize(1360, 900);
      await page.waitForSelector('[data-group="sdlc"]');
    });

    await step('4. every module\'s home: the header opens it; Agents, Dashboards, Engineering, Operations, and one the shell draws', async () => {
      await page.click('[data-group-home="core.agents"]');
      await page.waitForSelector('[data-module-home="core.agents"]');
      assert.equal(await page.locator('[data-group-home="core.agents"]').getAttribute('aria-current'), 'page');
      for (const k of ['working', 'linked', 'needs', 'cost']) assert.equal(await page.locator(`[data-kpi="${k}"]`).count(), 1, k);
      for (const s of ['working', 'proposals', 'library', 'actions']) assert.equal(await page.locator(`[data-home-section="${s}"]`).count(), 1, s);
      await shot('home-agents');
      await page.click('[data-group-home="core.dashboards"]');
      await page.waitForSelector('[data-module-home="core.dashboards"]');
      for (const s of ['recent', 'datasets', 'sources', 'templates', 'ask']) assert.equal(await page.locator(`[data-home-section="${s}"]`).count(), 1, s);
      assert.ok(await page.locator('[data-home-template-card="executive"]').count(), 'the templates');
      await shot('home-dashboards');
      await page.click('[data-group-home="sdlc"]');
      await page.waitForSelector('[data-view="sdlc:home"]');
      await grant();
      const eng = frame('sdlc:home');
      await eng.locator('body[data-ready]').waitFor({ timeout: 30_000 });
      for (const k of ['flight', 'failing', 'delivered', 'cost']) assert.equal(await eng.locator(`[data-kpi="${k}"]`).count(), 1, k);
      await eng.locator('[data-eng-flight] [data-empty]').waitFor();
      await shot('home-engineering');
      await eng.locator('#request').fill('A slugify function');
      await eng.locator('[data-eng-quick] button[type="submit"]').click();
      await page.waitForSelector('[data-view="sdlc:start-feature"]');
      const start = frame('sdlc:start-feature');
      await start.locator('body[data-ready]').waitFor({ timeout: 30_000 });
      for (let i = 0; i < 50 && (await start.locator('#request').inputValue()) !== 'A slugify function'; i++) await page.waitForTimeout(100);
      assert.equal(await start.locator('#request').inputValue(), 'A slugify function', 'the home starts a feature with the request filled in');
      await page.click('[data-group-home="aiops"]');
      await page.waitForSelector('[data-view="aiops:home"]');
      await grant();
      const opsHome = frame('aiops:home');
      await opsHome.locator('body[data-ready]').waitFor({ timeout: 30_000 });
      for (const k of ['open', 'firing', 'slo', 'services']) assert.equal(await opsHome.locator(`[data-kpi="${k}"]`).count(), 1, k);
      await opsHome.locator('[data-home-service]').first().waitFor({ timeout: 20_000 });
      await shot('home-operations');
      // Its entry under Custom opens the home the shell draws for it.
      await page.click('[data-nav="field-notes:menu"]');
      await page.waitForSelector('[data-plugin-home="field-notes"]');
      assert.deepEqual(await page.$$eval('[data-home-page]', (els) => els.map((e) => e.getAttribute('data-home-page'))), ['field-notes:today', 'field-notes:guides', 'field-notes:safety']);
      assert.deepEqual(await page.$$eval('[data-home-action]', (els) => els.map((e) => e.getAttribute('data-home-action'))), ['field-notes:log', '/observe']);
      assert.equal(await page.locator('[data-home-settings="field-notes:notes"]').count(), 1);
      await shot('home-generated');
      await page.click('[data-module-guide="field-notes"]');
      await page.getByText('Reference: Field notes').first().waitFor();
      await page.keyboard.press('Escape');
      await page.click('[data-home-ask="field-notes"]');
      await page.waitForSelector('[data-home]');
      assert.match(await page.locator('[data-composer-input]').inputValue(), /Field notes plugin[\s\S]*field-notes-guide/, '"Ask the agent" types a question in, never sends it');
      await page.locator('[data-composer-input]').fill('');
    });

    await step('5. the palette lists "Plugin › Item"; the breadcrumbs read Plugin > Page', async () => {
      await page.locator('[data-statusbar]').click();
      await page.keyboard.press('Control+K');
      await page.waitForSelector('[data-palette]');
      await page.keyboard.type('operations');
      await page.waitForTimeout(300);
      const titles = await page.$$eval('[data-palette] [role="option"]', (els) => els.map((e) => (e.textContent ?? '').trim()));
      for (const x of ['Operations › Home', 'Operations › Incidents', 'Operations › Alerts', 'Operations › Topology']) assert.ok(titles.some((tt) => tt.startsWith(x)), `${x} in ${titles.slice(0, 12).join(' | ')}`);
      await shot('palette-grouped');
      await page.locator('[data-palette] [role="option"]', { hasText: 'Operations › Alerts' }).first().click();
      await page.waitForSelector('[data-view="aiops:alerts"]');
      assert.equal(await page.locator('[data-crumb-parent]').textContent(), 'Operations');
      assert.equal(await page.locator('[data-topbar] [data-breadcrumb]').textContent(), 'Alerts');
      await page.click('[data-crumb-parent]');
      await page.waitForSelector('[data-view="aiops:home"]');
      await page.click('[data-nav="core.artifacts:library"]');
      assert.equal(await page.locator('[data-crumb-parent]').textContent(), 'Agents');
      assert.equal(await page.title(), 'Library - Harness');
    });

    let sid = '';
    await step('6. a scripted agent loads the Operations guide, opens its home, runs its ops check and opens Incidents; the Dashboards guide comes from the app', async () => {
      await page.click('[data-nav="core.chat:new"]');
      await page.waitForSelector('[data-home]');
      await send('What can the Operations plugin do? And open its incidents page.');
      sid = (await sessionOnScreen())!;
      // desktop_command acts in the app: the person is asked; the request waits in the Inbox (the agent took the window to the Operations home).
      await page.waitForSelector('[data-view="aiops:home"]', { timeout: 60_000 });
      await page.click('[data-nav="core.inbox:inbox"]');
      await page.waitForSelector(`[data-inbox-session="${sid}"]`, { timeout: 30_000 });
      await shot('agent-asks-ops-check');
      await idle(sid);
      await page.waitForSelector('[data-view="aiops:incidents"]', { timeout: 20_000 });
      const detail = await api('GET', `/api/sessions/${sid}`);
      const results = (detail.body.history as Array<{ role: string; content: Array<{ type: string; content?: unknown }> }>).flatMap((m) => m.content).filter((b) => b.type === 'tool_result').map((b) => String(b.content));
      assert.match(results[0]!, /<skill name="aiops-guide">[\s\S]*## What it is for[\s\S]*`aiops:run-ops-check`/, 'the guide: authored and generated');
      assert.match(results[1]!, /Opened aiops:home/);
      assert.match(results[2]!, /Ops check: \d+ rule\(s\)/);
      assert.match(results[3]!, /Opened aiops:incidents/);
      const last = (detail.body.history as Array<{ role: string; content: Array<{ type: string; text?: string }> }>).at(-1)!;
      assert.match(last.content.map((b) => b.text ?? '').join(''), /guide loaded: yes/);
      await shot('agent-opened-incidents');
      // The Dashboards guide is the app's: the server asks the app for it (desktop_describe {plugin, guide}).
      await page.click(`[data-session-row="${sid}"] button`);
      await page.waitForSelector(`[data-session="${sid}"]`);
      await ask(sid, 'Build me a dashboard from this CSV using the dashboards plugin.');
      await page.waitForSelector('[data-module-home="core.dashboards"]', { timeout: 20_000 });
      const d2 = await api('GET', `/api/sessions/${sid}`);
      assert.match(JSON.stringify(d2.body.history.at(-1)), /Dashboards guide loaded: yes/);
      await page.click(`[data-session-row="${sid}"] button`);
      await page.waitForSelector(`[data-session="${sid}"]`);
      await page.waitForTimeout(400);
      for (const st of await page.locator('[data-steps]').all()) if ((await st.getAttribute('data-open')) !== '1') await st.locator('button').first().click().catch(() => {});
      await shot('agent-transcript');
    });

    await step('7. a plugin switched off: its group, home, guide line and skill go; on again: back', async () => {
      assert.match(await ask(sid, 'Which plugin guides do you see?'), /Guides: [^"]*aiops[^"]*core\.dashboards[^"]*sdlc/);
      assert.equal((await api('POST', '/api/plugins/aiops/disable')).status, 200);
      await page.waitForSelector('[data-group="aiops"]', { state: 'detached', timeout: 15_000 });
      const off = await ask(sid, 'Which plugin guides do you see?');
      assert.match(off, /Guides: /);
      assert.ok(!/aiops/.test(off) && /sdlc/.test(off), `the aiops line went with it, and only it (${off})`);
      const meta = await api('GET', `/api/sessions/${sid}`);
      assert.ok(!meta.body.meta.client.plugins.some((p: { name: string }) => p.name === 'aiops'));
      await shot('aiops-off', page.locator('[data-sidebar]'));
      assert.equal((await api('POST', '/api/plugins/aiops/enable')).status, 200);
      await page.waitForSelector('[data-group="aiops"]', { timeout: 15_000 });
      assert.match(await ask(sid, 'Which plugin guides do you see?'), /Guides: [^"]*aiops/);
    });

    await step('no errors in the app', async () => {
      assert.deepEqual(errors.filter((e) => !/net::ERR_|Failed to load resource|ResizeObserver/.test(e)), []);
    });
  } finally {
    await app.close().catch(() => {});
  }
});
