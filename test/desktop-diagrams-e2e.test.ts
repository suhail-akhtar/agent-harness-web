// core.diagrams end to end: the real Electron app against the scripted engine (no paid calls).
// For every view a diagram artifact is made and drawn in the transcript; the full-page canvas
// shows its nodes and edges (laid out by ELK in the worker); a flow plays; a dragged box saves a
// new artifact version; details open in the side panel; Neighbourhood narrows the picture; SVG
// export is a standalone file; the ask box gets a new version with its changes marked; the code
// map of the workspace draws; the dark theme; and the window logs no errors.
//
// HARNESS_DESKTOP_SCREENSHOTS=1 writes docs/screenshots/desktop/diagram-*.png.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DIAGRAMS } from './fixtures/desktop/diagrams.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = path.join(root, 'apps', 'desktop');
const SHOTS = process.env.HARNESS_DESKTOP_SCREENSHOTS === '1' ? path.join(root, 'docs', 'screenshots', 'desktop') : null;
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');

function newest(dir: string): number {
  let t = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'release') continue;
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

/** A workspace with real code for the code map: copies of this repository's sources. */
function codeWorkspace(): string {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-dgw-')));
  const keep = (src: string) => fs.statSync(src).isDirectory() ? !/node_modules|dist|release/.test(path.basename(src)) : /\.(ts|tsx|mjs|py)$/.test(src);
  for (const rel of ['src', 'packages/ui/src', 'packages/client/src', 'packages/plugin-ui/src', 'apps/desktop/renderer/src', 'apps/desktop/electron']) {
    fs.cpSync(path.join(root, rel), path.join(work, rel), { recursive: true, filter: keep });
  }
  return work;
}

// The deployment last: the steps after this one work on its page.
const VIEWS = ['context', 'container', 'component', 'data', 'code', 'flow', 'deployment'] as const;

test('diagrams end to end', { timeout: 15 * 60_000 }, async (t) => {
  if (!fs.existsSync(electronExe)) { t.skip('Electron is not installed'); return; }
  let pw: typeof import('playwright-core');
  try { pw = await import('playwright-core'); } catch { t.skip('playwright-core is not installed'); return; }
  const failed = ensureBuilt();
  if (failed) assert.fail(failed);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-dg-'));
  const work = codeWorkspace();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_API_KEY$|^GW_|^HARNESS_/.test(k)) env[k] = v;
  Object.assign(env, { HARNESS_DESKTOP_DATA: data, HARNESS_DESKTOP_ENGINE: path.join(root, 'test', 'fixtures', 'desktop', 'scripted-engine.ts'), HARNESS_DESKTOP_NO_TRAY: '1', HARNESS_PLUGIN_LOOPS: 'off' });
  // No window on the screen unless screenshots are wanted.
  if (!SHOTS) env.HARNESS_DESKTOP_HIDDEN = '1';
  let app: import('playwright-core').ElectronApplication;
  try { app = await pw._electron.launch({ executablePath: electronExe, args: [desktop], env, timeout: 60_000 }); } catch (e) { t.skip(`Electron could not start here: ${(e as Error).message.split('\n')[0]}`); return; }
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const page = await app.firstWindow();
  let phase = 'start';
  const errors: Array<{ phase: string; text: string }> = [];
  page.on('pageerror', (e) => errors.push({ phase, text: `exception: ${e.message}` }));
  page.on('console', (m) => { const where = m.location().url ?? ''; if ((m.type() === 'error' || (m.type() === 'warning' && /\[diagram\]/.test(m.text()))) && !/\/plugins\/|^harness:\/\/preview|^about:srcdoc/.test(where)) errors.push({ phase, text: `console ${m.type()}: ${m.text()} (${where})` }); });
  page.on('crash', () => errors.push({ phase, text: 'the renderer crashed' }));
  const shot = async (name: string) => { if (!SHOTS) return; await page.waitForTimeout(400); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
  const invoke = (channel: string, ...args: unknown[]) => page.evaluate(([c, a]) => (window as unknown as { harnessDesktop: { invoke: (c: string, ...x: unknown[]) => Promise<unknown> } }).harnessDesktop.invoke(c as string, ...(a as unknown[])), [channel, args] as const);
  const api = (method: string, p: string, body?: unknown) => page.evaluate(async ([m, u, b]) => { const r = await fetch(u as string, { method: m as string, headers: { 'content-type': 'application/json', 'x-harness': '1' }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) }; }, [method, p, body] as const);
  const ready = () => page.waitForSelector('[data-engine-status="ready"]', { timeout: 90_000 });
  const send = async (text: string) => { const box = page.locator('[data-composer-input]'); await box.fill(text); await box.press('Enter'); };
  // The conversation's id, from the route the first turn opened (going back does not rewrite the stored route).
  let sid = '';
  const sessionId = async () => { if (!sid) sid = await page.evaluate(() => { const r = JSON.parse(sessionStorage.getItem('harness.route') ?? '{}') as { view?: string; params?: { id?: string } }; return r.view === 'core.chat:session' ? r.params?.id ?? '' : ''; }); return sid; };
  const artifacts = async () => { const id = await sessionId(); return id ? ((await api('GET', `/api/sessions/${id}/artifacts`)).body as Array<{ id: string; title: string; version: number }>) ?? [] : []; };
  /** Sends and waits for the turn's artifact (answering the first permission request with "always"). */
  const draw = async (text: string, count: number) => {
    await send(text);
    for (let i = 0; i < 160; i++) {
      const allow = page.locator('button', { hasText: 'Always allow artifact' });
      if (await allow.count()) await allow.first().click().catch(() => {});
      if ((await artifacts()).length >= count) break;
      await page.waitForTimeout(250);
    }
    const made = await artifacts();
    assert.ok(made.length >= count, `${text}: an artifact was made (have ${made.map((a) => a.title).join(', ') || 'none'} in session ${await sessionId()}, route ${await page.evaluate(() => sessionStorage.getItem('harness.route'))})`);
    await page.waitForSelector('[data-composer-input]:not([disabled])');
  };
  const canvas = (view: string) => page.locator(`[data-diagram-canvas="${view}"]`);
  const openCard = async (title: string) => {
    await page.locator('[data-diagram-artifact]', { hasText: title }).last().locator('[data-diagram-open]').click();
    await page.waitForSelector('[data-diagram-page]');
  };
  const laidOut = async (view: string) => {
    await page.waitForFunction((v) => { const c = document.querySelector(`[data-diagram-canvas="${v}"]`); return !!c && c.getAttribute('data-engine') !== '' && Number(c.getAttribute('data-nodes')) > 0; }, view, { timeout: 30_000 });
    await page.waitForTimeout(500);
  };
  const back = async () => { await page.locator('[data-diagram-page-header] button', { hasText: 'Back' }).click(); await page.waitForSelector('[data-composer-input]'); };
  const step = (name: string, fn: () => Promise<void>) => t.test(name, async () => {
    phase = name;
    try { await fn(); } catch (e) {
      await page.screenshot({ path: path.join(os.tmpdir(), `hd-dg-fail-${name.slice(0, 40).replace(/[^a-z0-9]+/gi, '-')}.png`) }).catch(() => {});
      for (let i = 0; i < 2; i++) await page.keyboard.press('Escape').catch(() => {});
      throw e;
    }
  });
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; w.unmaximize(); w.setSize(1440, 900); });

  try {
    await step('ready, in a project folder with code', async () => {
      await ready();
      await page.waitForSelector('[data-home]');
      // The engine restarts to take the new folder as a root: watch it go down and come back.
      await page.evaluate(() => { const w = window as unknown as { __restarted: boolean }; w.__restarted = false; const el = document.querySelector('[data-engine-status]')!; new MutationObserver(() => { if (el.getAttribute('data-engine-status') !== 'ready') w.__restarted = true; }).observe(el, { attributes: true }); });
      await invoke('projects:add', work);
      await page.locator('[data-sidebar] button').filter({ hasText: path.basename(work) }).first().waitFor({ timeout: 15_000 });
      await page.waitForFunction(() => (window as unknown as { __restarted: boolean }).__restarted, null, { timeout: 20_000 });
      await ready();
      await page.click('[data-work-in]');
      await page.locator('[role="menuitemcheckbox"]', { hasText: path.basename(work) }).click();
      await page.keyboard.press('Escape');
    });

    await step('every view: an artifact drawn in the transcript, and on its page every node and edge (ELK in the worker)', async () => {
      for (const [i, view] of VIEWS.entries()) {
        const d = DIAGRAMS[view];
        await draw(`draw the ${view} diagram`, i + 1);
        const card = page.locator('[data-diagram-artifact]', { hasText: d.title }).last();
        await card.waitFor({ timeout: 20_000 });
        await card.locator('[data-diagram-svg]').waitFor({ timeout: 20_000 });
        assert.equal(await card.locator('[data-diagram-svg] [data-node-id]').count(), d.nodes.length, `${view}: the static picture has every node`);
        await openCard(d.title);
        await laidOut(view);
        const c = canvas(view);
        assert.equal(await c.getAttribute('data-engine'), 'elk', `${view}: laid out by ELK`);
        assert.equal(await c.locator('[data-diagram-viewport] [data-node-id]').count(), d.nodes.length, `${view}: nodes`);
        assert.equal(await c.locator('[data-diagram-viewport] [data-edge-id]').count(), (d as { edges?: unknown[] }).edges?.length ?? 0, `${view}: edges`);
        assert.match(await c.locator('[data-diagram-summary]').innerText(), /relation/);
        if (view === 'context') await shot('diagram-context');
        if (view === 'container') await shot('diagram-container');
        if (view === 'data') { assert.ok(await c.locator('[data-pii]').count() >= 3, 'pii marks'); await shot('diagram-er'); }
        if (view !== 'deployment') await back();
      }
    });

    let artifactId = '';
    await step('deployment: zones, a flow plays step by step, details in the side panel', async () => {
      artifactId = (await page.locator('[data-diagram-page]').getAttribute('data-artifact'))!;
      const c = canvas('deployment');
      assert.equal(await c.locator('[data-group-kind="zone"]').count(), 3);
      assert.match((await c.locator('[data-group-id="dmz"]').textContent()) ?? '', /DMZ ZONE[\s\S]*subnet dmz 10\.42\.10\.0\/24/);
      await shot('diagram-deployment-zones');
      await page.click('[data-diagram-flows-toggle]');
      await page.selectOption('[data-flow-select]', 'login');
      await page.click('[data-flow-play]');
      await page.waitForSelector('[data-flow-step="1"]', { timeout: 10_000, state: 'attached' });
      await page.waitForSelector('[data-flow-step="2"][data-current="1"]', { timeout: 10_000, state: 'attached' });
      assert.match((await page.locator('[data-flow-label]').textContent()) ?? '', /3\. read the session signing key/);
      assert.equal(await page.locator('[data-flow-step-item][data-active="1"]').innerText().then((s) => s.includes('read the session signing key')), true);
      assert.ok(await c.locator('[data-diagram-viewport] .dg-node.dg-dim').count() >= 2, 'the rest dims');
      await shot('diagram-flow-animating');
      await page.click('[data-flow-play]'); // pause
      const at = await page.locator('[data-flow-position]').innerText();
      await page.waitForTimeout(2000);
      assert.equal(await page.locator('[data-flow-position]').innerText(), at, 'paused');
      const n = Number(at.split(' / ')[0]);
      await page.click('[data-flow-next]');
      assert.equal(await page.locator('[data-flow-position]').innerText(), `${Math.min(6, n + 1)} / 6`, 'a step forward');
      await page.click('[data-diagram-viewport]', { position: { x: 30, y: 300 } });
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('[data-flow-step]').count(), 0, 'Escape stops the flow');
      await page.click('[data-diagram-flows-toggle]');
      // Details: select, Enter opens them in the side panel; links and findings there.
      await c.locator('[data-diagram-viewport] [data-node-id="db"]').click();
      await page.keyboard.press('Enter');
      const side = page.locator('[data-diagram-details-side]');
      await side.waitFor();
      assert.match(await side.innerText(), /CRM database[\s\S]*PostgreSQL 16[\s\S]*10\.42\.29\.3:5432[\s\S]*Backups are not encrypted at rest/);
      // Arrow keys move the selection to a neighbour.
      await page.locator('[data-diagram-viewport]').focus();
      await page.keyboard.press('ArrowLeft');
      await page.waitForFunction(() => document.querySelector('[data-diagram-details-side] [data-details-title]')?.textContent !== 'CRM database');
      await c.locator('[data-diagram-viewport] [data-node-id="db"]').click();
      await shot('diagram-details-panel');
      await page.click('[data-diagram-details-toggle]');
      await side.waitFor({ state: 'detached' });
    });

    await step('Neighbourhood: the selected node and one hop, laid out on their own', async () => {
      const c = canvas('deployment');
      await c.locator('[data-diagram-viewport] [data-node-id="db"]').click();
      await page.click('[data-mode-button="neighbourhood"]');
      await page.waitForFunction(() => document.querySelector('[data-diagram-canvas]')?.getAttribute('data-mode') === 'neighbourhood' && document.querySelectorAll('[data-diagram-viewport] [data-node-id]').length === 3, null, { timeout: 15_000 });
      assert.deepEqual((await c.locator('[data-diagram-viewport] [data-node-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-node-id')))).sort(), ['backup', 'db', 'web']);
      await page.click('[data-mode-button="overview"]');
      await page.waitForFunction(() => document.querySelectorAll('[data-diagram-viewport] [data-node-id]').length === 7, null, { timeout: 15_000 });
    });

    await step('export SVG: a standalone file with the theme written in', async () => {
      await page.evaluate(() => {
        const w = window as unknown as { __blobs: Blob[] };
        w.__blobs = [];
        const make = URL.createObjectURL.bind(URL);
        URL.createObjectURL = (b: Blob | MediaSource) => { if (b instanceof Blob) w.__blobs.push(b); return make(b); };
        const click = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { if (this.download) { (window as unknown as { __saved: string }).__saved = this.download; return; } click.call(this); };
      });
      await page.click('[data-diagram-export="svg"]');
      await page.waitForFunction(() => (window as unknown as { __blobs: Blob[] }).__blobs.length > 0);
      const svg = await page.evaluate(() => (window as unknown as { __blobs: Blob[] }).__blobs.at(-1)!.text());
      assert.match(svg, /^<\?xml/);
      assert.match(svg, /<svg[^>]+viewBox=/);
      assert.match(svg, /CRM database/);
      assert.match(svg, /DMZ ZONE/);
      assert.doesNotMatch(svg, /var\(--/, 'colours are resolved');
      assert.doesNotMatch(svg, /class="dg-hit"|data-collapse=|dg-card-sel"/, 'no interface parts');
      assert.equal(await page.evaluate(() => (window as unknown as { __saved: string }).__saved), 'crm-production-deployment.svg');
      await page.click('[data-diagram-export="png"]');
      await page.waitForFunction(() => (window as unknown as { __blobs: Blob[] }).__blobs.some((b) => b.type === 'image/png'), null, { timeout: 15_000 });
    });

    await step('drag a box: a new artifact version is saved with the positions', async () => {
      const before = Number(await page.locator('[data-diagram-page]').getAttribute('data-version'));
      const box = (await page.locator('[data-diagram-viewport] [data-node-id="backup"]').boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 60, { steps: 8 });
      await page.mouse.up();
      await page.waitForFunction((v) => Number(document.querySelector('[data-diagram-page]')?.getAttribute('data-version')) > v, before, { timeout: 15_000 });
      const latest = (await api('GET', `/api/sessions/${await sessionId()}/artifacts/${artifactId}`)).body as { version: number; content: string };
      assert.equal(latest.version, before + 1);
      const positions = (JSON.parse(latest.content) as { layout: { positions: Record<string, { x: number; y: number }> } }).layout.positions;
      assert.deepEqual(Object.keys(positions).sort(), DIAGRAMS.deployment.nodes.map((n) => n.id).sort(), 'every box is saved');
      assert.equal(await page.locator('[data-diagram-viewport] [data-changed]').count(), 0, 'moving boxes marks nothing as changed');
    });

    await step('ask the agent to change the design: the new version arrives in place with the changes marked', async () => {
      const before = Number(await page.locator('[data-diagram-page]').getAttribute('data-version'));
      const db = await page.locator('[data-diagram-viewport] [data-node-id="db"]').boundingBox();
      await page.fill('[data-diagram-ask-input]', 'add a cache in front of the database');
      await page.press('[data-diagram-ask-input]', 'Enter');
      await page.waitForFunction((v) => Number(document.querySelector('[data-diagram-page]')?.getAttribute('data-version')) > v, before, { timeout: 60_000 });
      await page.waitForSelector('[data-diagram-viewport] [data-node-id="cache"]', { timeout: 20_000 });
      await page.waitForTimeout(600);
      assert.equal(await page.locator('[data-diagram-viewport] [data-node-id="cache"] [data-changed]').count(), 1, 'the new node is marked changed');
      assert.match(await page.locator('[data-diagram-changed]').innerText(), /1 added \(Cache\)/);
      const after = await page.locator('[data-diagram-viewport] [data-node-id="db"]').boundingBox();
      assert.ok(db && after && Math.abs(db.x - after.x) < 3 && Math.abs(db.y - after.y) < 3, 'the other boxes stay where they were');
      await shot('diagram-changed');
    });

    await step('dark theme', async () => {
      await invoke('prefs:set', { theme: 'dark' });
      await page.waitForFunction(() => document.documentElement.classList.contains('dark') || document.documentElement.getAttribute('data-theme') === 'dark', null, { timeout: 10_000 }).catch(() => {});
      await page.click('[data-diagram-fit]');
      await shot('diagram-dark');
      await invoke('prefs:set', { theme: 'light' });
      await back();
    });

    await step('a ```diagram block draws in the transcript and opens its canvas', async () => {
      await send('draw a diagram block');
      const block = page.locator('[data-artifact="diagram"]').last();
      await block.locator('[data-diagram-svg]').waitFor({ timeout: 20_000 });
      if (SHOTS) await block.screenshot({ path: path.join(SHOTS, 'render-diagram.png') });
      await block.locator('[data-diagram-open]').click();
      await laidOut('flow');
      assert.equal(await page.locator('[data-diagram-page]').getAttribute('data-diagram-page'), 'block');
      await back();
    });

    await step('Show code map: folders of the workspace with import counts, Overview and Neighbourhood', async () => {
      await page.keyboard.press('Control+K');
      await page.waitForSelector('[data-palette]');
      await page.keyboard.type('Show code map');
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-diagram-page="code"]');
      await laidOut('code');
      const c = canvas('code');
      const nodes = await c.locator('[data-diagram-viewport] [data-node-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-node-id')));
      assert.ok(nodes.includes('src/core') && nodes.includes('src/server'), `folders: ${nodes.join(', ')}`);
      assert.ok(await c.locator('[data-diagram-viewport] [data-edge-id]').count() > 5);
      await shot('diagram-code-overview');
      await c.locator('[data-diagram-viewport] [data-node-id="src/core"]').click();
      await page.click('[data-mode-button="neighbourhood"]');
      await page.waitForFunction(() => document.querySelector('[data-diagram-canvas]')?.getAttribute('data-mode') === 'neighbourhood');
      await laidOut('code');
      assert.ok(await c.locator('[data-diagram-viewport] [data-node-id]').count() < nodes.length);
      await shot('diagram-code-neighbourhood');
    });

    // Adding the folder restarts the engine, which cuts the open event streams (they reconnect): expected.
    const unexpected = errors.filter((e) => !(/project folder/.test(e.phase) && /ERR_FAILED \(harness:\/\/app\/api\/(events|sessions\/[^/]+\/events)/.test(e.text)));
    assert.deepEqual(unexpected, [], 'no errors in the window');
  } finally {
    await app.close().catch(() => {});
    try { fs.rmSync(data, { recursive: true, force: true, maxRetries: 3 }); fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 }); } catch { /* in use (Windows) */ }
  }
});
