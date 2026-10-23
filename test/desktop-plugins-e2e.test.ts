// "Everything is pluggable, on and off any time", end to end: the real Electron app against the
// real harness server with the sdlc ("Engineering"), quality-gates and aiops ("Operations")
// plugins on fixture data and a scripted model (test/fixtures/desktop/plugins-engine.ts: nothing
// is spent). Both plugins bring their UI as sandboxed frames - the path any third party takes.
//
//   1. the core only: nothing of either plugin anywhere
//   2. Engineering on, live: its nav, page, panel, commands, chips, settings, home card and
//      renderer; a feature started from its form runs to the gates (a failing test, fixed)
//   3. Operations on, live: incidents (seeded through the plugin's own alert route), alerts,
//      services, topology, changes, badges, the home card and settings; an incident's detail
//   4. both: no clash, a fixed order, the palette lists both, one conversation uses /incident
//      and /gates, the incident record's root cause, evidence, refuter, runbook and postmortem
//   5. Engineering off: all of it goes, Operations untouched; its tool card in the old conversation
//      is drawn plainly with a note that it is off (and a way to the Plugins page)
//   6. Operations off: exactly the core again (sidebar, settings, palette, home cards, status)
//   7. both on again: their settings and grants come back, the old conversation's card is full again
//
// HARNESS_DESKTOP_SCREENSHOTS=1 writes a screenshot of every stage to
// docs/screenshots/desktop/plugins-journey/ (else to a temporary folder).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertNotBlank, capture } from './fixtures/desktop/png.ts';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = path.join(root, 'apps', 'desktop');
const SHOTS = process.env.HARNESS_DESKTOP_SCREENSHOTS === '1' ? path.join(root, 'docs', 'screenshots', 'desktop', 'plugins-journey') : fs.mkdtempSync(path.join(os.tmpdir(), 'hd-journey-shots-'));
// The electron package answers its executable's path (found wherever node_modules is: a worktree has none of its own).
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
const ofPlugin = (ids: string[], ...names: string[]) => ids.filter((x) => names.some((n) => x.includes(`${n}:`) || x.includes(`${n}.`)));

test('plugins journey: Engineering and Operations switched on and off live, used in between', { timeout: 20 * 60_000 }, async (t) => {
  if (!electronExe || !fs.existsSync(electronExe)) { t.skip('Electron is not installed (npm install, or node node_modules/electron/install.js)'); return; }
  let pw: typeof import('playwright-core');
  try { pw = await import('playwright-core'); } catch { t.skip('playwright-core is not installed'); return; }
  const failed = ensureBuilt();
  if (failed) assert.fail(failed);

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-journey-'));
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-slugify-')));
  const ops = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-ops-')));
  fs.writeFileSync(path.join(repo, 'README.md'), '# slugify\n');
  const originFile = path.join(data, 'engine-origin.txt');
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_API_KEY$|^GW_|^HARNESS_|^NODE_TEST_CONTEXT$/.test(k)) env[k] = v;
  Object.assign(env, {
    HARNESS_DESKTOP_DATA: data,
    HARNESS_DESKTOP_TEST: '1', ...(process.env.HARNESS_E2E_SHOW ? { HARNESS_E2E_SHOW: process.env.HARNESS_E2E_SHOW } : {}),
    HARNESS_DESKTOP_ENGINE: path.join(root, 'test', 'fixtures', 'desktop', 'plugins-engine.ts'),
    HARNESS_DESKTOP_NO_TRAY: '1',
    HARNESS_PLUGINS: ['quality-gates', 'sdlc', 'aiops'].map((p) => path.join(root, 'plugins', p)).join(path.delimiter),
    HARNESS_PLUGIN_LOOPS: 'off',
    HARNESS_OPS_ALERTS_PATH: ops,
    HARNESS_OPS_ALERTS_INVESTIGATE: '0',
    HARNESS_OPS_WATCH_SECONDS: '0',
    HARNESS_OPS_LOCAL_DOCKER: '',
    HARNESS_E2E_ORIGIN_FILE: originFile,
  });
  let app: import('playwright-core').ElectronApplication;
  try { app = await pw._electron.launch({ executablePath: electronExe, args: [desktop], env, timeout: 60_000 }); }
  catch (e) { t.skip(`Electron could not start here: ${(e as Error).message.split('\n')[0]}`); return; }
  fs.mkdirSync(SHOTS, { recursive: true });
  const page = await app.firstWindow();
  let phase = 'start';
  const errors: Array<{ phase: string; text: string }> = [];
  const frameErrors: Array<{ phase: string; text: string }> = [];
  page.on('pageerror', (e) => errors.push({ phase, text: `exception: ${e.message}` }));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const where = m.location().url ?? '';
    (/\/plugins\//.test(where) ? frameErrors : errors).push({ phase, text: `${m.text()} (${where})` });
  });
  page.on('crash', () => errors.push({ phase, text: 'the renderer crashed' }));
  let shotN = 0;
  const shot = async (name: string, el?: import('playwright-core').Locator) => { await page.waitForTimeout(350); shotN++; const png = await capture(app, el); assertNotBlank(png, name); fs.writeFileSync(path.join(SHOTS, `${String(shotN).padStart(2, '0')}-${name}.png`), png); };
  const setSize = (w: number, h: number) => app.evaluate(({ BrowserWindow }, s) => { const win = BrowserWindow.getAllWindows()[0]!; if (win.isMaximized()) win.unmaximize(); win.setSize(s.w, s.h); }, { w, h });
  const invoke = (channel: string, ...args: unknown[]) => page.evaluate(([c, a]) => (window as unknown as { harnessDesktop: { invoke: (c: string, ...x: unknown[]) => Promise<unknown> } }).harnessDesktop.invoke(c as string, ...(a as unknown[])), [channel, args] as const);
  const api = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => page.evaluate(async ([m, u, b, hd]) => { const r = await fetch(u as string, { method: m as string, headers: { 'content-type': 'application/json', 'x-harness': '1', ...(hd as Record<string, string>) }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) }; }, [method, p, body, headers] as const);
  const ready = () => page.waitForSelector('[data-engine-status="ready"]', { timeout: 90_000 });
  const home = async () => { await page.click('[data-nav="core.chat:new"]'); await page.waitForSelector('[data-home]'); };
  const frame = (container: string) => page.frameLocator(`${container} iframe`);
  const view = (qid: string) => frame(`[data-view="${qid}"] [data-plugin-frame]`);
  const send = async (text: string) => { const box = page.locator('[data-composer-input]'); await box.fill(text); await box.press('Enter'); };
  const allowPending = async (sid: string) => {
    // A tool the mode asks about (quality_gates runs commands): allowed in the attention bar.
    const card = page.locator(`[data-session="${sid}"] [data-attention] [data-pending="permission_request"]`).first();
    if (await card.isVisible().catch(() => false)) await card.locator('[data-decision="allow"]').click();
  };
  // A frame's call that needs the person (a message sent without a click the host saw): allowed.
  const allowAsk = async () => { const d = page.locator('[role="dialog"]', { hasText: 'A plugin asks' }); if (await d.isVisible().catch(() => false)) await d.locator('button:has-text("Allow")').click(); };
  /** Unfolds the steps of a conversation's turns, so tool cards (and plugin renderers) are drawn. */
  const openSteps = async () => { for (const st of await page.locator('[data-steps]').all()) if ((await st.getAttribute('data-open')) !== '1') await st.locator('button').first().click().catch(() => {}); };
  const openPanel = async (label: string, plugin: string) => { if (!(await page.locator(`[data-side-panel] [data-plugin-frame="${plugin}"]`).count())) await page.click(`[data-topbar] button[aria-label="${label}"]`); await page.waitForSelector(`[data-side-panel] [data-plugin-frame="${plugin}"]`); };
  const closePanel = async () => { if (await page.locator('[data-side-panel]').count()) await page.click('[data-side-panel] button[aria-label]').catch(() => {}); };
  const idle = async (sid: string, ms = 120_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await allowAsk();
      await allowPending(sid);
      if (await page.locator(`[data-session="${sid}"][data-status="idle"]`).count()) return;
      await page.waitForTimeout(400);
    }
    throw new Error(`session ${sid} did not finish`);
  };
  const switchPlugin = async (name: string, on: boolean) => {
    await page.click('[data-nav="core.plugins:plugins"]');
    const card = page.locator(`[data-plugin="${name}"]`);
    await card.waitFor();
    if ((await card.getAttribute('data-enabled')) === (on ? '1' : '0')) return;
    await card.locator('[role="switch"]').click();
    await page.waitForSelector(`[data-plugin="${name}"][data-enabled="${on ? '1' : '0'}"]`, { timeout: 15_000 });
  };
  /** Everything a person can see of the plugins: what stage 1 and stage 6 must agree on. */
  const snapshot = async () => {
    await home();
    await page.waitForTimeout(400);
    const nav = await page.$$eval('[data-nav]', (els) => els.map((e) => e.getAttribute('data-nav')!));
    const homeCards = await page.$$eval('[data-home-card]', (els) => els.map((e) => e.getAttribute('data-home-card')!));
    const status = await page.$$eval('[data-status-item]', (els) => els.map((e) => e.getAttribute('data-status-item')!));
    const chips = await page.$$eval('[data-chip]', (els) => els.map((e) => e.getAttribute('data-chip')!));
    await page.keyboard.press('Control+K');
    await page.waitForSelector('[data-palette]');
    const palette = (await page.$$eval('[data-entry]', (els) => els.map((e) => e.getAttribute('data-entry')!))).filter((x) => /^(cmd|nav):/.test(x));
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Comma');
    await page.waitForSelector('[data-settings]');
    const settings = await page.$$eval('[data-settings-section]', (els) => els.map((e) => e.getAttribute('data-settings-section')!));
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-settings]', { state: 'detached' });
    await page.locator('[data-composer-input]').fill('/');
    await page.waitForTimeout(250);
    const slash = await page.$$eval('[role="menuitem"]', (els) => els.map((e) => (e.querySelector('span.flex-1')?.childNodes[0]?.textContent ?? '').trim()));
    await page.locator('[data-composer-input]').fill('');
    return { nav, homeCards, status, chips, palette, settings, slash };
  };
  const step = (name: string, fn: () => Promise<void>) => t.test(name, async () => {
    phase = name;
    try { await fn(); } catch (e) {
      await capture(app).then((png) => fs.writeFileSync(path.join(os.tmpdir(), `hd-journey-fail-${name.slice(0, 40).replace(/[^a-z0-9]+/gi, '-')}.png`), png)).catch(() => {});
      for (let i = 0; i < 3; i++) await page.keyboard.press('Escape').catch(() => {});
      throw e;
    }
  });
  await setSize(1360, 860);

  let core: Awaited<ReturnType<typeof snapshot>>;
  let featureSession = '';
  let opsSession = '';
  try {
    await step('setup: the engine is ready, two projects, both plugins off', async () => {
      await ready();
      await page.waitForSelector('[data-home]');
      await invoke('prefs:set', { defaultMode: 'acceptEdits', onboardingDone: true });
      for (const dir of [repo, ops]) {
        await page.evaluate(() => { const w = window as unknown as { __restarted: boolean }; w.__restarted = false; const el = document.querySelector('[data-engine-status]')!; new MutationObserver(() => { if (el.getAttribute('data-engine-status') !== 'ready') w.__restarted = true; }).observe(el, { attributes: true }); });
        await invoke('projects:add', dir);
        await page.waitForFunction(() => (window as unknown as { __restarted: boolean }).__restarted, null, { timeout: 20_000 }).catch(() => {});
        await ready();
      }
      for (const p of ['sdlc', 'aiops']) assert.equal((await api('POST', `/api/plugins/${p}/disable`)).status, 200);
      await page.waitForSelector('[data-nav="sdlc:delivery"]', { state: 'detached', timeout: 15_000 });
      await page.waitForSelector('[data-nav="aiops:incidents"]', { state: 'detached', timeout: 15_000 });
    });

    await step('1. the core only: the sidebar, home, settings, palette and composer show nothing of either plugin', async () => {
      core = await snapshot();
      for (const [k, v] of Object.entries(core)) assert.deepEqual(ofPlugin(v, 'sdlc', 'aiops'), [], `${k} has nothing of them`);
      assert.ok(!core.slash.includes('/feature') && !core.slash.includes('/incident'));
      assert.ok(core.settings.includes('quality-gates:defaults'), 'quality-gates stays on throughout (the core of this journey)');
      await home();
      await shot('core-home');
      await page.keyboard.press('Control+Comma');
      await page.waitForSelector('[data-settings]');
      await shot('core-settings');
      await page.keyboard.press('Escape');
    });

    await step('2. Engineering on, live: everything it adds appears without a restart', async () => {
      await switchPlugin('sdlc', true);
      await page.waitForSelector('[data-nav="sdlc:delivery"]', { timeout: 15_000 });
      await shot('plugins-engineering-on');
      const s = await snapshot();
      assert.deepEqual(ofPlugin(s.nav, 'sdlc'), ['sdlc:delivery', 'sdlc:start', 'sdlc:quality'], 'its module: Delivery, Start a feature, Gates');
      assert.deepEqual(ofPlugin(s.homeCards, 'sdlc'), ['sdlc:in-flight']);
      assert.deepEqual(ofPlugin(s.chips, 'sdlc').sort(), ['sdlc:target-branch', 'sdlc:test-level']);
      assert.deepEqual(ofPlugin(s.settings, 'sdlc'), ['sdlc:engineering', 'sdlc:engineering-panel'], 'the person\'s choices (with the account) and this computer\'s');
      for (const c of ['cmd:sdlc:open-delivery', 'cmd:sdlc:start-feature', 'cmd:sdlc:run-gates', 'nav:sdlc:delivery']) assert.ok(s.palette.includes(c), c);
      for (const c of ['/feature', '/review', '/gates']) assert.ok(s.slash.includes(c), c);
      assert.deepEqual(ofPlugin(s.nav, 'aiops'), [], 'Operations is still off');
      // Its settings: a schema form, kept on this computer; one value set now must survive switching off and on.
      await page.keyboard.press('Control+Comma');
      await page.click('[data-settings-section="sdlc:engineering"]');
      await page.waitForSelector('[data-schema-section="sdlc:engineering"]');
      await page.locator('[data-field="strictness"] [role="radio"]', { hasText: 'Everything' }).click();
      await page.locator('[data-settings] button:has-text("Save")').click();
      await shot('engineering-settings');
      await page.keyboard.press('Escape');
    });

    await step('2. Engineering: the Delivery page asks for access once, then starts a feature from its form', async () => {
      await page.click('[data-nav="sdlc:delivery"]');
      await page.waitForSelector('[data-trust-gate="sdlc"]');
      await shot('engineering-trust');
      await page.click('[data-grant]');
      const board = view('sdlc:delivery');
      await board.locator('body[data-ready="1"]').waitFor({ timeout: 20_000 });
      await board.locator('[data-empty]').waitFor();
      assert.equal(await page.getAttribute('[data-plugin-frame="sdlc"] iframe', 'sandbox'), 'allow-scripts allow-forms', 'a sandboxed frame, as for any third party');
      await shot('delivery-empty');
      await board.locator('#start').click();
      const form = view('sdlc:start-feature');
      await form.locator('body[data-ready="1"]').waitFor({ timeout: 20_000 });
      await form.locator('#request').fill('A slugify(text) utility: lower-case ASCII words joined by dashes, accents removed, at most 80 characters, with unit tests.');
      await form.locator('#approval button[data-value="auto"]').click();
      await form.locator('#more summary').click();
      await shot('start-feature-form');
      await form.locator('#go').click();
      // The host asks first (workflows.start), then shows the workflow's dialog with the form's inputs.
      await page.locator('[role="dialog"] button:has-text("Allow")').click();
      await page.waitForSelector('[data-workflow-dialog][data-fresh]');
      await page.locator('[data-workflow-dialog] select').selectOption(repo);
      assert.match(await page.locator('[data-workflow-dialog] textarea').inputValue(), /slugify/);
      await shot('start-feature-dialog');
      await page.click('[data-start-workflow]');
      await page.waitForSelector('[data-session]', { timeout: 20_000 });
      featureSession = (await page.getAttribute('[data-session]', 'data-session'))!;
      await page.waitForSelector('[data-workflow="build-feature"]', { timeout: 20_000 });
    });

    await step('2. Engineering: the Quality gates panel shows the gates as they run (a failing test, then fixed); the board has the feature delivered', async () => {
      await page.click('[data-topbar] button[aria-label="Quality gates"]');
      const panel = frame('[data-side-panel] [data-plugin-frame="sdlc"]');
      await panel.locator('body[data-ready="1"]').waitFor({ timeout: 20_000 });
      await panel.locator('[data-gate="node-test"][data-status="fail"]').waitFor({ timeout: 120_000 });
      assert.match(await panel.locator('[data-gate="node-test"]').innerText(), /4 tests: 3 passed, 1 failed/);
      await shot('gates-panel-failing');
      await page.waitForSelector(`[data-session="${featureSession}"] [data-workflow="build-feature"][data-status="succeeded"]`, { timeout: 180_000 });
      await panel.locator('[data-gate="node-test"][data-status="pass"]').waitFor({ timeout: 30_000 });
      assert.match(await panel.locator('[data-tests]').innerText(), /4\/4/);
      assert.ok(await panel.locator('[data-gate="todo-markers"][data-status="warn"]').count(), 'the advisory TODO gate warns');
      await shot('gates-panel-passing');
      assert.match(fs.readFileSync(path.join(repo, 'src', 'slugify.js'), 'utf8'), /normalize\('NFKD'\)/, 'the fix agent repaired the code in the folder');
      // Run one gate again from the panel: the agent calls quality_gates; the result draws with the plugin's renderer.
      await panel.locator('[data-gate="secrets"] button').click();
      await allowAsk();
      await page.waitForTimeout(500);
      await idle(featureSession);
      await openSteps();
      await page.waitForSelector('[data-plugin-renderer="sdlc:gate-results"]', { timeout: 30_000 });
      await frame('[data-plugin-renderer="sdlc:gate-results"]').locator('[data-gate="secrets"]').waitFor({ timeout: 20_000 });
      await shot('gate-results-renderer', page.locator('[data-plugin-renderer="sdlc:gate-results"]').last());
      await page.click('[data-topbar] button[aria-label="Quality gates"]');
      // The board: delivered, its gates and tests, the documents the agents wrote.
      await page.click('[data-nav="sdlc:delivery"]');
      const board = view('sdlc:delivery');
      await board.locator('[data-stage="delivered"] [data-delivery]').waitFor({ timeout: 20_000 });
      assert.match(await board.locator('[data-stage="delivered"] [data-delivery]').innerText(), /slugify[\s\S]*4\/4 tests/);
      await board.locator('[data-stage="delivered"] [data-delivery]').click();
      await board.locator('[data-gate-table]').waitFor();
      await board.locator('[data-doc="docs/requirements.md"]').click();
      await board.locator('.doc h1, .doc h2').first().waitFor();
      await shot('delivery-board');
      await home();
      await frame('[data-home-card="sdlc:in-flight"]').locator('body[data-ready="1"]').waitFor({ timeout: 20_000 });
      await shot('home-engineering');
    });

    await step('3. Operations on, live: incidents from its own alert route, alerts, services, topology, changes, badges, home card and settings', async () => {
      await switchPlugin('aiops', true);
      await page.waitForSelector('[data-nav="aiops:incidents"]', { timeout: 15_000 });
      // Monitoring speaks to the plugin's own routes, with their tokens (an administrator gets them once).
      const routes = (await api('POST', '/api/plugin-routes')).body as { plugin: string; path: string; token?: string }[];
      const token = (p: string) => routes.find((r) => r.plugin === 'aiops' && r.path === p)!.token!;
      // ... and to the engine directly (the app's proxy never forwards a route token).
      const origin = fs.readFileSync(originFile, 'utf8').trim();
      const hook = async (p: string, body: unknown) => (await fetch(`${origin}/api/plugins/aiops/${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-harness-route-token': token(p) }, body: JSON.stringify(body) })).status;
      const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
      assert.equal(await hook('changes', { changes: [
        { kind: 'deploy', target: 'checkout', service: 'checkout', env: 'prod', summary: 'v42 rolled out (payment client 3.2)', by: 'github-actions', at: at(14), ref: 'https://github.com/acme/shop/actions/runs/4242' },
        { kind: 'config', target: 'payments', service: 'payments', env: 'prod', summary: 'pool size 50 -> 40', by: 'ops', at: at(95) },
        { kind: 'ci-run', target: 'acme/search', service: 'search', env: 'prod', summary: 'search nightly index: success', by: 'github-actions', at: at(240) },
      ] }), 202);
      assert.equal(await hook('alerts', { alerts: [
        { name: 'CheckoutErrorRatio', severity: 'critical', service: 'checkout', env: 'prod', summary: '21% of checkout requests fail', value: '0.21', startsAt: at(12) },
        { name: 'CheckoutLatencyHigh', severity: 'warning', service: 'checkout', env: 'prod', summary: 'p95 1.8 s (objective 400 ms)', startsAt: at(11) },
        { name: 'SearchIndexLag', severity: 'info', service: 'search', env: 'prod', summary: 'the index is 25 minutes behind', startsAt: at(30) },
      ] }), 202);
      // No Operations page is open (nor granted yet): the badge and the status items come from its badge source
      // (ui.badges: its own route, read by the app), at once on the signal its alert route sends.
      assert.equal(await page.locator('[data-view^="aiops:"]').count(), 0);
      await page.waitForSelector('[data-badge="aiops.open"]:has-text("2")', { timeout: 15_000 });
      await page.waitForSelector('[data-status-item="aiops:firing-alerts"]:has-text("3 firing")', { timeout: 15_000 });
      assert.match(await page.locator('[data-status-item="aiops:open-incidents"]').innerText(), /2 open incidents/);
      await page.click('[data-nav="aiops:incidents"]');
      await page.waitForSelector('[data-trust-gate="aiops"]');
      await page.click('[data-grant]');
      const inc = view('aiops:incidents');
      await inc.locator('body[data-ready="1"]').waitFor({ timeout: 20_000 });
      await inc.locator('[data-incident]').nth(1).waitFor({ timeout: 20_000 });
      assert.equal(await inc.locator('[data-incident]').count(), 2, 'checkout (two alerts, one incident) and search');
      await page.waitForSelector('[data-badge="aiops.open"]:has-text("2")', { timeout: 15_000 });
      assert.match(await page.locator('[data-status-item="aiops:open-incidents"]').innerText(), /2 open incidents/);
      assert.match(await page.locator('[data-status-item="aiops:firing-alerts"]').innerText(), /3 firing/);
      await shot('incidents');
      await inc.locator('[data-incident]', { hasText: 'checkout' }).first().click();
      const detail = view('aiops:incidents');
      await detail.locator('[data-incident-detail]').waitFor({ timeout: 20_000 });
      assert.equal(await detail.locator('[data-alert]').count(), 2);
      assert.match(await detail.locator('body').innerText(), /v42 rolled out/, 'the changes before it are attached');
      await shot('incident-alerts');
      let cur = 'incidents';
      for (const [tab, sel] of [['alerts', '[data-alert-group]'], ['services', '[data-service="checkout"]'], ['topology', '[data-node="checkout"]'], ['changes', '[data-change]']] as const) {
        await view(`aiops:${cur}`).locator(`[data-tab="${tab}"]`).click();
        cur = tab;
        const v = view(`aiops:${tab}`);
        // With core.diagrams installed, Topology hands its graph to the host's diagram renderer (render.show): the
        // nodes are then drawn in the app over the frame, not inside it. Either way the service must be there.
        const hostTopo = page.locator('[data-view="aiops:topology"] [data-host-block="diagram"]', { hasText: 'checkout' });
        if (tab === 'topology') await Promise.any([v.locator(sel).first().waitFor({ timeout: 20_000 }), hostTopo.first().waitFor({ timeout: 20_000 })]);
        else await v.locator(sel).first().waitFor({ timeout: 20_000 });
        if (tab === 'services') {
          assert.equal(await v.locator('[data-service="checkout"]').getAttribute('data-state'), 'critical', 'its error-ratio rule fires');
          assert.equal(await v.locator('[data-service="payments"]').getAttribute('data-state'), 'healthy');
          assert.match(await v.locator('[data-slo="checkout/availability"]').innerText(), /burn 12\.0x/);
        }
        if (tab === 'topology') {
          const block = page.locator('[data-view="aiops:topology"] [data-host-block="diagram"]');
          if (await block.count()) {
            const text = await block.innerText();
            for (const svc of ['storefront', 'checkout', 'payments', 'search', 'orders-db']) assert.match(text, new RegExp(svc), `${svc} is drawn by the diagrams plugin`);
          } else assert.ok(await v.locator('[data-node]').count() >= 6, 'five services and a host');
        }
        await shot(`ops-${tab}`);
      }
      await home();
      const card = frame('[data-home-card="aiops:on-call"]');
      await card.locator('[data-oncall-open="2"]').waitFor({ timeout: 20_000 });
      await shot('home-on-call');
      await page.keyboard.press('Control+Comma');
      await page.click('[data-settings-section="aiops:operations"]');
      await page.waitForSelector('[data-schema-section="aiops:operations"]');
      await shot('operations-settings');
      await page.keyboard.press('Escape');
    });

    await step('4. both: no clash, a fixed order, the palette lists both, one conversation uses /incident and /gates', async () => {
      const s = await snapshot();
      const navIndex = (id: string) => s.nav.indexOf(id);
      // Each a module: the Engineering group (menu order 40: Delivery, Start a feature, Gates), then Operations (41).
      assert.ok(navIndex('sdlc:delivery') >= 0 && navIndex('aiops:incidents') === navIndex('sdlc:quality') + 1 && navIndex('sdlc:quality') === navIndex('sdlc:delivery') + 2, `Engineering's items then Operations': ${s.nav.join(', ')}`);
      assert.deepEqual(s.homeCards.filter((c) => /^(sdlc|aiops):/.test(c)), ['sdlc:in-flight', 'aiops:on-call']);
      assert.deepEqual(s.status.filter((c) => /^aiops:/.test(c)), ['aiops:open-incidents', 'aiops:firing-alerts']);
      for (const c of ['/feature', '/review', '/gates', '/incident', '/investigate', '/ops-check']) assert.ok(s.slash.includes(c), c);
      await page.click('[data-nav="core.plugins:plugins"]');
      for (const p of ['sdlc', 'aiops']) assert.equal(await page.locator(`[data-plugin="${p}"] [data-conflict]`).count(), 0, `${p}: no clash`);
      // The palette finds both.
      await page.keyboard.press('Control+K');
      await page.waitForSelector('[data-palette]');
      await page.keyboard.type('open');
      for (const c of ['cmd:sdlc:open-delivery', 'cmd:aiops:open-incidents', 'cmd:aiops:open-topology']) await page.waitForSelector(`[data-entry="${c}"]`);
      await shot('palette-both');
      await page.keyboard.press('Escape');
      // /ops-check runs the plugin's route at once (no model): a toast with the result.
      await home();
      await send('/ops-check');
      await page.waitForSelector('[data-toast]:has-text("Ops check:")', { timeout: 20_000 });
      // A conversation in the ops workspace: /incident (Operations) then /gates (Engineering).
      await page.click('[data-work-in]');
      await page.locator('[role="menuitemcheckbox"]', { hasText: path.basename(ops) }).click();
      if (await page.locator('[role="menu"]').count()) await page.keyboard.press('Escape');
      await send('/incident Checkout errors after the v42 deploy');
      assert.match(await page.locator('[data-composer-input]').inputValue(), /^Open an incident for: Checkout errors after the v42 deploy/, 'a prompt action fills the composer, never sends unseen');
      await page.locator('[data-composer-input]').press('Enter');
      await page.waitForSelector('[data-session]', { timeout: 20_000 });
      opsSession = (await page.getAttribute('[data-session]', 'data-session'))!;
      await idle(opsSession);
      await openSteps();
      await page.waitForSelector('[data-plugin-renderer="aiops:alert-list"]', { timeout: 20_000 });
      await page.waitForSelector('[data-plugin-renderer="aiops:slo-card"]', { timeout: 20_000 });
      await frame('[data-plugin-renderer="aiops:slo-card"]').locator('[data-slo-card="checkout/availability"]').waitFor({ timeout: 20_000 });
      await send('/gates');
      await page.locator('[data-composer-input]').press('Enter');
      await page.waitForTimeout(500);
      await idle(opsSession);
      await openSteps();
      await page.waitForSelector(`[data-session="${opsSession}"] [data-plugin-renderer="sdlc:gate-results"]`, { timeout: 30_000 });
      const steps = page.locator('[data-steps]').first();
      if (await steps.count() && await steps.getAttribute('data-open') !== '1') await steps.locator('button').first().click();
      await shot('conversation-both-plugins');
      // Its incident, next to it (Operations' panel), and the Engineering panel too.
      await page.click('[data-topbar] button[aria-label="Incident"]');
      const panel = frame('[data-side-panel] [data-plugin-frame="aiops"]');
      await panel.locator('[data-panel-incident]').waitFor({ timeout: 20_000 });
      await panel.locator('[data-panel-runbook]').waitFor();
      assert.ok(await panel.locator('[data-panel-evidence] li').count() >= 2, 'the evidence it rests on');
      await shot('incident-panel');
      await page.click('[data-topbar] button[aria-label="Incident"]');
      // The record in Operations: root cause, confidence, refuter, evidence, runbook, postmortem.
      await page.click('[data-nav="aiops:incidents"]');
      const list = view('aiops:incidents');
      await list.locator('body[data-ready="1"]').waitFor({ timeout: 20_000 });
      await list.locator('.seg button', { hasText: 'All' }).click();
      await list.locator('[data-incident^="inc-"]').first().click();
      const d = view('aiops:incidents');
      await d.locator('[data-root-cause]').waitFor({ timeout: 20_000 });
      assert.match(await d.locator('[data-root-cause]').innerText(), /payment client 3\.2[\s\S]*Confidence: high/);
      assert.equal(await d.locator('[data-refuter]').getAttribute('data-refuter'), 'SURVIVES');
      assert.ok(await d.locator('[data-evidence] li').count() >= 2);
      await d.locator('[data-postmortem]').waitFor();
      await d.locator('[data-runbook]').waitFor();
      await setSize(1360, 1300);
      await page.evaluate(() => { document.documentElement.style.zoom = '0.75'; });
      try { await shot('incident-record'); } finally { await page.evaluate(() => { document.documentElement.style.zoom = ''; }); await setSize(1360, 860); }
    });

    await step('4. an agent opens an incident in the app (desktop_command: an agent-callable command, asked first, its args checked)', async () => {
      const list = (await api('POST', '/api/plugins/aiops/console/incidents', { status: 'all' })).body as { incidents: { id: string }[] };
      const id = list.incidents.find((x) => x.id.startsWith('inc-'))!.id;
      await home();
      await page.click(`[data-session-row="${opsSession}"] button`);
      await page.waitForSelector(`[data-session="${opsSession}"]`);
      await send(`Show incident ${id} in the app`);
      // An action in the person's app: asked in default mode, naming the command.
      const ask = page.locator(`[data-session="${opsSession}"] [data-attention] [data-pending="permission_request"]`).first();
      await ask.waitFor({ timeout: 30_000 });
      assert.match(await ask.innerText(), /aiops:open-incident/);
      await shot('agent-desktop-command-asked');
      await ask.locator('[data-decision="allow"]').click();
      // The window goes to the incident; the agent hears where.
      const d = view('aiops:incidents');
      await d.locator(`[data-incident-detail="${id}"]`).waitFor({ timeout: 30_000 });
      await shot('agent-opened-incident');
      await page.click(`[data-session-row="${opsSession}"] button`);
      await idle(opsSession);
      assert.match(await page.locator(`[data-session="${opsSession}"] [data-assistant-message]`).last().innerText(), /In the app: [\s\S]*Opened Incidents \(id inc-/, 'the agent heard what the app did (fenced as outside data: this engine loads aiops from a folder, not as shipped)');
    });

    await step('5. Engineering off: everything of it goes at once, nothing lingers, Operations untouched', async () => {
      // Its page open and its panel open next to a conversation: both close.
      await page.click(`[data-session-row="${featureSession}"] button`);
      await page.waitForSelector(`[data-session="${featureSession}"]`);
      await openPanel('Quality gates', 'sdlc');
      assert.equal((await api('POST', '/api/plugins/sdlc/disable')).status, 200);
      await page.waitForSelector('[data-side-panel]', { state: 'detached', timeout: 15_000 });
      await page.waitForSelector('[data-nav="sdlc:delivery"]', { state: 'detached', timeout: 15_000 });
      assert.equal(await page.locator('[data-plugin-renderer="sdlc:gate-results"]').count(), 0, 'its renderer falls back to the default tool card');
      // The old conversation's gates card: the default card, and a note saying what drew it before.
      await openSteps();
      const note = page.locator(`[data-session="${featureSession}"] [data-tool="quality_gates"] [data-plugin-off="sdlc"]`).first();
      await note.waitFor({ timeout: 15_000 });
      assert.match(await note.innerText(), /Made with Engineering, which is off\. Switch it on to view it fully/);
      await shot('engineering-off-conversation');
      await note.locator('[data-open-plugins]').click();
      await page.waitForSelector('[data-plugins-page] [data-plugin="sdlc"][data-enabled="0"]', { timeout: 15_000 });
      const s = await snapshot();
      for (const [k, v] of Object.entries(s)) assert.deepEqual(ofPlugin(v, 'sdlc'), [], `${k}: nothing of Engineering`);
      assert.ok(!s.slash.includes('/feature') && !s.slash.includes('/gates'));
      assert.deepEqual(ofPlugin(s.nav, 'aiops'), ['aiops:incidents', 'aiops:alerts', 'aiops:services', 'aiops:topology', 'aiops:changes'], 'Operations is unaffected');
      assert.deepEqual(ofPlugin(s.homeCards, 'aiops'), ['aiops:on-call']);
      assert.ok(s.slash.includes('/incident'));
      await frame('[data-home-card="aiops:on-call"]').locator('[data-oncall-open]').waitFor({ timeout: 20_000 });
      assert.match(await page.locator('[data-badge="aiops.open"]').innerText(), /\d/);
      await shot('engineering-off-home');
    });

    await step('6. Operations off: back to exactly the core', async () => {
      await page.click('[data-nav="aiops:incidents"]');
      await view('aiops:incidents').locator('body[data-ready="1"]').waitFor({ timeout: 20_000 });
      await switchPlugin('aiops', false);
      await page.waitForSelector('[data-nav="aiops:incidents"]', { state: 'detached', timeout: 15_000 });
      assert.equal(await page.locator('[data-badge="aiops.open"]').count(), 0, 'its badge went with it');
      assert.equal(await page.locator('[data-status-item^="aiops:"]').count(), 0);
      const s = await snapshot();
      assert.deepEqual(s.nav, core.nav, 'the same sidebar, in the same order');
      assert.deepEqual(s.settings, core.settings, 'the same settings sections');
      assert.deepEqual(s.homeCards, core.homeCards, 'the same home cards');
      assert.deepEqual(s.status, core.status, 'the same status items');
      assert.deepEqual(s.chips, core.chips, 'the same composer chips');
      assert.deepEqual(s.slash, core.slash, 'the same slash commands');
      assert.deepEqual(s.palette.filter((x) => !x.startsWith('cmd:') || !/^cmd:(sdlc|aiops):/.test(x)), core.palette, 'the same palette commands');
      assert.deepEqual(s.palette, core.palette);
      await home();
      await shot('core-again');
    });

    await step('7. both on again: their settings and grants are restored', async () => {
      await switchPlugin('sdlc', true);
      await switchPlugin('aiops', true);
      await page.waitForSelector('[data-nav="sdlc:delivery"]', { timeout: 15_000 });
      await page.waitForSelector('[data-nav="aiops:incidents"]', { timeout: 15_000 });
      await page.click('[data-nav="sdlc:delivery"]');
      await view('sdlc:delivery').locator('[data-delivery]').first().waitFor({ timeout: 20_000 });
      assert.equal(await page.locator('[data-trust-gate]').count(), 0, 'Engineering\'s grant was kept');
      await page.click('[data-nav="aiops:incidents"]');
      await view('aiops:incidents').locator('[data-incident]').first().waitFor({ timeout: 20_000 });
      assert.equal(await page.locator('[data-trust-gate]').count(), 0, 'Operations\' grant was kept');
      await page.keyboard.press('Control+Comma');
      await page.click('[data-settings-section="sdlc:engineering"]');
      assert.match(await page.locator('[data-field="strictness"] [role="radio"][aria-checked="true"]').innerText(), /Everything/, 'its setting was kept');
      await page.keyboard.press('Escape');
      // The old conversation's gates card is drawn by Engineering again, without the note.
      await page.click(`[data-session-row="${featureSession}"] button`);
      await page.waitForSelector(`[data-session="${featureSession}"]`);
      await openSteps();
      await page.waitForSelector(`[data-session="${featureSession}"] [data-plugin-renderer="sdlc:gate-results"]`, { timeout: 30_000 });
      assert.equal(await page.locator(`[data-session="${featureSession}"] [data-plugin-off]`).count(), 0, 'no note once it is on');
      // A stable layout: the home page with both cards loading moves nothing under the reader.
      await home();
      await page.evaluate(() => {
        const w = window as unknown as { __shift: number };
        w.__shift = 0;
        new PerformanceObserver((l) => { for (const e of l.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>) if (!e.hadRecentInput) w.__shift += e.value; }).observe({ type: 'layout-shift', buffered: false });
      });
      await page.click('[data-nav="core.plugins:plugins"]');
      await home();
      await frame('[data-home-card="aiops:on-call"]').locator('[data-oncall-open]').waitFor({ timeout: 20_000 });
      await frame('[data-home-card="sdlc:in-flight"]').locator('body[data-ready="1"]').waitFor({ timeout: 20_000 });
      await page.waitForTimeout(1500);
      const shift = await page.evaluate(() => (window as unknown as { __shift: number }).__shift);
      t.diagnostic(`layout shift on home with both cards: ${shift.toFixed(4)}`);
      assert.ok(shift < 0.1, `layout shift ${shift}`);
      await shot('both-back-home');
    });

    t.diagnostic(`frame console errors: ${JSON.stringify(frameErrors.slice(0, 5))}`);
    // Adding a project restarts the engine with the new roots: requests cut while it does are expected there.
    const unexpected = errors.filter((e) => !(/^setup/.test(e.phase) && /(502|ERR_FAILED)/.test(e.text)));
    assert.deepEqual(unexpected, [], 'no errors in the window');
    // A frame's request already on its way when its plugin is switched off finds the route switched off (503) or gone (404): only that, only in the phase that switches it off.
    const racing = (e: { phase: string; text: string }) => /status of (404|503)/.test(e.text) && ((/^5\./.test(e.phase) && /\/plugins\/sdlc\//.test(e.text)) || (/^6\./.test(e.phase) && /\/plugins\/aiops\//.test(e.text)));
    assert.deepEqual(frameErrors.filter((e) => /\/plugins\/(sdlc|aiops)\//.test(e.text) && !racing(e)), [], 'none in the plugins\' frames');
  } finally {
    await app.close().catch(() => {});
    try { fs.rmSync(data, { recursive: true, force: true, maxRetries: 3 }); fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3 }); fs.rmSync(ops, { recursive: true, force: true, maxRetries: 3 }); } catch { /* in use (Windows) */ }
  }
});
