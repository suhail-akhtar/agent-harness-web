// Harness Desktop end to end: the real Electron app (built from apps/desktop) against a scripted
// engine (the real harness server with a scripted model: nothing is spent), driven with
// playwright-core's Electron support. Skipped when Electron cannot start here (no display).
//
// HARNESS_DESKTOP_SCREENSHOTS=1 also writes the screenshots in docs/screenshots/desktop/.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { KITCHEN_SINK } from './fixtures/desktop/rich.ts';
import { SCIENCE_KITCHEN_SINK } from './fixtures/desktop/science.ts';
import { BIO_KITCHEN_SINK } from './fixtures/desktop/biology.ts';
import { assertNotBlank, capture } from './fixtures/desktop/png.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = path.join(root, 'apps', 'desktop');
const SHOTS = process.env.HARNESS_DESKTOP_SCREENSHOTS === '1' ? path.join(root, 'docs', 'screenshots', 'desktop') : null;
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

/** Builds the app when its sources are newer than the build. */
function ensureBuilt(): string | null {
  const out = path.join(desktop, 'dist', 'renderer', 'index.html');
  const src = Math.max(newest(path.join(desktop, 'electron')), newest(path.join(desktop, 'renderer')), newest(path.join(desktop, 'shared')), newest(path.join(root, 'packages')));
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= src) return null;
  const r = spawnSync(process.execPath, [path.join(desktop, 'scripts', 'build.mjs')], { cwd: root, stdio: 'pipe', encoding: 'utf8', timeout: 600_000 });
  return r.status === 0 ? null : `build failed: ${(r.stderr || r.stdout).slice(-800)}`;
}

const longBundle = (n: number) => ({
  format: 'harness-session', version: 1, exportedAt: Date.now(),
  source: { id: 'long', title: 'Long transcript', model: 'deepseek-flash', effort: 'medium', mode: 'default', tainted: false, todos: [], contextStart: 0, compactions: 0, lastPromptTokens: 0, cost: 0 },
  history: Array.from({ length: n }, (_, i) => (i % 2 === 0
    ? { role: 'user', content: [{ type: 'text', text: `Question ${i / 2 + 1}: how does part ${i} work?` }] }
    : { role: 'assistant', content: [{ type: 'text', text: `Part **${i}** works like this:\n\n- it reads the input\n- it checks \`limits\`\n\n| a | b |\n|---|---|\n| ${i} | ${i * 2} |\n\n\`\`\`js\nconst x${i} = compute(${i});\n\`\`\`` }] })),
  files: [], skipped: [],
});

test('desktop app end to end', { timeout: 15 * 60_000 }, async (t) => {
  if (!fs.existsSync(electronExe)) { t.skip('Electron is not installed (npm install, or node node_modules/electron/install.js)'); return; }
  let pw: typeof import('playwright-core');
  try { pw = await import('playwright-core'); } catch { t.skip('playwright-core is not installed'); return; }
  const failed = ensureBuilt();
  if (failed) assert.fail(failed);

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-e2e-'));
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-work-')));
  // A workspace workflow that needs no model (one approval, then the end), there before the session is made.
  fs.mkdirSync(path.join(work, '.harness', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(work, '.harness', 'workflows', 'ship-check.json'), JSON.stringify({
    name: 'ship-check', description: 'Ask before shipping', start: 'confirm',
    nodes: { confirm: { type: 'approval', title: 'Ship it?', message: 'The build is **green**. Ship it?', next: { on: { approve: 'done', reject: 'stop' } } }, done: { type: 'end', status: 'success' }, stop: { type: 'end', status: 'failed' } },
  }));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_API_KEY$|^GW_|^HARNESS_/.test(k)) env[k] = v;
  Object.assign(env, {
    HARNESS_DESKTOP_DATA: data,
    HARNESS_DESKTOP_TEST: '1', ...(process.env.HARNESS_E2E_SHOW ? { HARNESS_E2E_SHOW: process.env.HARNESS_E2E_SHOW } : {}),
    HARNESS_DESKTOP_ENGINE: path.join(root, 'test', 'fixtures', 'desktop', 'scripted-engine.ts'),
    HARNESS_DESKTOP_NO_TRAY: '1',
    HARNESS_PLUGINS: [path.join(root, 'examples', 'plugins', 'notes-frame'), path.join(root, 'examples', 'plugins', 'hello-frame'), path.join(root, 'examples', 'plugins', 'quick-links'), path.join(root, 'test', 'fixtures', 'desktop', 'plugins', 'broken-ui')].join(path.delimiter),
    HARNESS_PLUGIN_LOOPS: 'off',
  });
  let app: import('playwright-core').ElectronApplication;
  try {
    app = await pw._electron.launch({ executablePath: electronExe, args: [desktop], env, timeout: 60_000 });
  } catch (e) { t.skip(`Electron could not start here: ${(e as Error).message.split('\n')[0]}`); return; }
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const page = await app.firstWindow();
  // Every error the window logs, with the step it happened in. Only a few are expected (see the end).
  let phase = 'start';
  const errors: Array<{ phase: string; text: string }> = [];
  page.on('pageerror', (e) => errors.push({ phase, text: `exception: ${e.message}` }));
  // Errors of the window itself; plugin frames and artifact previews log their own refusals (the escape probes cause them on purpose).
  page.on('console', (m) => { const where = m.location().url ?? ''; if (m.type() === 'error' && !/\/plugins\/|^harness:\/\/preview|^about:srcdoc/.test(where)) errors.push({ phase, text: `console: ${m.text()} (${where})` }); });
  page.on('crash', () => errors.push({ phase, text: 'the renderer crashed' }));
  page.on('close', () => errors.push({ phase, text: 'the window closed' }));
  const shot = async (name: string, el?: import('playwright-core').Locator) => { if (!SHOTS) return; await page.waitForTimeout(250); const png = await capture(app, el); assertNotBlank(png, name); fs.writeFileSync(path.join(SHOTS, `${name}.png`), png); };
  const setSize = (w: number, h: number) => app.evaluate(({ BrowserWindow }, s) => { const win = BrowserWindow.getAllWindows()[0]!; if (win.isMaximized()) win.unmaximize(); win.setSize(s.w, s.h); }, { w, h });
  const invoke = (channel: string, ...args: unknown[]) => page.evaluate(([c, a]) => (window as unknown as { harnessDesktop: { invoke: (c: string, ...x: unknown[]) => Promise<unknown> } }).harnessDesktop.invoke(c as string, ...(a as unknown[])), [channel, args] as const);
  const api = (method: string, p: string, body?: unknown) => page.evaluate(async ([m, u, b]) => { const r = await fetch(u as string, { method: m as string, headers: { 'content-type': 'application/json', 'x-harness': '1' }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) }; }, [method, p, body] as const);
  const ready = () => page.waitForSelector('[data-engine-status="ready"]', { timeout: 90_000 });
  const send = async (text: string) => { const box = page.locator('[data-composer-input]'); await box.fill(text); await box.press('Enter'); };
  const newChat = async () => { await page.click('[data-nav="core.chat:new"]'); await page.waitForSelector('[data-home]'); };
  await setSize(1280, 820);
  // A failed step leaves a screenshot (in the temp folder) and closes what it left open, so the next steps still run.
  const step = (name: string, fn: () => Promise<void>) => t.test(name, async () => {
    phase = name;
    try { await fn(); } catch (e) {
      await capture(app).then((png) => fs.writeFileSync(path.join(os.tmpdir(), `hd-e2e-fail-${name.slice(0, 40).replace(/[^a-z0-9]+/gi, '-')}.png`), png)).catch(() => {});
      for (let i = 0; i < 3; i++) await page.keyboard.press('Escape').catch(() => {});
      throw e;
    }
  });

  try {
    await step('the engine gate shows the real state, then the app is ready', async () => {
      const gate = await page.waitForSelector('[data-engine-gate], [data-engine-status="ready"]', { timeout: 60_000 });
      if (await gate.getAttribute('data-engine-gate')) {
        await shot('engine-gate');
        // The gate may already be giving way to the app (a fast start): read its log only while it is there.
        const log = await page.locator('[data-engine-log]').innerText({ timeout: 2_000 }).catch(() => null);
        if (log !== null) assert.match(log, /starting the engine/);
      }
      await ready();
      await page.waitForSelector('[data-home]');
      assert.match(await page.locator('[data-greeting]').innerText(), /Where should we begin\?/);
      // Under the tests the window is shown off every display and never focused (unless HARNESS_E2E_SHOW=1): nobody
      // sees it, yet it renders like a visible window, and a screenshot has real content.
      const where = await app.evaluate(({ BrowserWindow, screen }) => {
        const w = BrowserWindow.getAllWindows()[0]!;
        const b = w.getBounds();
        const onScreen = screen.getAllDisplays().some((d) => b.x < d.bounds.x + d.bounds.width && b.x + b.width > d.bounds.x && b.y < d.bounds.y + d.bounds.height && b.y + b.height > d.bounds.y);
        return { onScreen, focused: w.isFocused() };
      });
      if (!process.env.HARNESS_E2E_SHOW) {
        assert.equal(where.onScreen, false, 'off every display unless HARNESS_E2E_SHOW=1');
        assert.equal(where.focused, false, 'it never takes the focus');
      }
      await page.waitForTimeout(300);
      assertNotBlank(await capture(app), 'the home page');
    });

    await step('the sidebar comes from the registry, the built-ins and plugins alike', async () => {
      await page.waitForSelector('[data-nav="notes-frame:notes"]', { timeout: 30_000 });
      const nav = await page.$$eval('[data-nav]', (els) => els.map((e) => e.getAttribute('data-nav')));
      for (const id of ['core.chat:new', 'core.chat:search', 'core.inbox:inbox', 'core.activity:activity', 'core.projects:projects', 'core.plugins:plugins', 'notes-frame:notes']) assert.ok(nav.includes(id), `${id} in the sidebar`);
      assert.deepEqual(nav.slice(0, 2), ['core.chat:new', 'core.chat:search'], 'the product profile orders the sidebar');
      assert.ok(await page.locator('[data-status-item="notes-frame:count"]').count(), 'a plugin status item');
      assert.ok(await page.locator('[data-home-prompts]').getByText("Today's summary").count(), 'a plugin prompt on the home page');
      await shot('home');
    });

    let sessionId = '';
    let richId = '';
    let bioId = '';
    await step('a session in a folder: a permission request in the attention bar and the inbox, approved, and the tool card', async () => {
      // The engine restarts to take the new folder as a root: watch it go down and come back.
      await page.evaluate(() => { const w = window as unknown as { __restarted: boolean }; w.__restarted = false; const el = document.querySelector('[data-engine-status]')!; new MutationObserver(() => { if (el.getAttribute('data-engine-status') !== 'ready') w.__restarted = true; }).observe(el, { attributes: true }); });
      await invoke('projects:add', work);
      await page.locator('[data-sidebar] button').filter({ hasText: path.basename(work) }).first().waitFor({ timeout: 15_000 });
      await page.waitForFunction(() => (window as unknown as { __restarted: boolean }).__restarted, null, { timeout: 20_000 });
      await ready();
      await page.click('[data-work-in]');
      await page.locator('[role="menuitemcheckbox"]', { hasText: path.basename(work) }).click();
      assert.match(await page.locator('[data-work-in]').innerText(), new RegExp(path.basename(work)));
      if (await page.locator('[role="menu"]').count()) await page.keyboard.press('Escape');
      // What the window says if the send goes wrong (a toast is gone by the time a timeout fails).
      await page.evaluate(() => { const w = window as unknown as { __toasts: string[] }; w.__toasts = []; new MutationObserver(() => { for (const t of document.querySelectorAll('[data-toast]')) { const s = (t as HTMLElement).innerText; if (!w.__toasts.includes(s)) w.__toasts.push(s); } }).observe(document.body, { childList: true, subtree: true }); });
      await send('Please write a file for me');
      await page.waitForSelector('[data-session]', { timeout: 20_000 }).catch(async (e: Error) => { throw new Error(`${e.message.split('\n')[0]}; toasts: ${JSON.stringify(await page.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts))}`); });
      sessionId = (await page.getAttribute('[data-session]', 'data-session'))!;
      // The sent prompt is not left behind as the new-chat draft (it came back, and was sent again, as a second conversation).
      assert.equal(await page.evaluate(() => localStorage.getItem('draft:home')), null, 'the new-chat draft is cleared once sent');
      const card = await page.waitForSelector('[data-attention] [data-pending="permission_request"]', { timeout: 30_000 });
      assert.match(await card.innerText(), /write/);
      await page.waitForSelector('[data-badge="core.inbox.pending"]', { timeout: 15_000 });
      assert.equal(await page.locator('[data-badge="core.inbox.pending"]').first().innerText(), '1');
      await shot('chat-pending-approval');
      await page.click('[data-nav="core.inbox:inbox"]');
      const item = await page.waitForSelector('[data-inbox] [data-pending="permission_request"]', { timeout: 15_000 });
      await shot('inbox');
      await (await item.$('[data-decision="allow"]'))!.click();
      await page.waitForSelector('[data-inbox] [data-pending]', { state: 'detached', timeout: 15_000 });
      await page.click(`[data-session-row="${sessionId}"] button`);
      await page.waitForSelector('[data-session][data-status="idle"]', { timeout: 30_000 });
      await page.waitForSelector('[data-assistant-message]:has-text("hello.txt")', { timeout: 30_000 });
      assert.equal(fs.readFileSync(path.join(work, 'hello.txt'), 'utf8'), 'Hello from the desktop test\n');
      const steps = page.locator('[data-steps]').first();
      assert.match(await steps.innerText(), /Worked/);
      if (await steps.getAttribute('data-open') !== '1') await steps.locator('button').first().click();
      await page.waitForSelector('[data-tool="write"][data-tool-status="ok"]');
      assert.ok(await page.locator('[data-reasoning]').count(), 'the reasoning shows, folded');
      assert.ok(await page.locator(`[data-artifact-card="hello.txt"]`).count(), 'the file the agent wrote is a card');
      await shot('chat-tool-card');
    });

    await step('a workflow: started from the session, its approval answered in the attention bar, its card follows the run', async () => {
      await page.click('[aria-label="Run a workflow"]');
      await page.waitForSelector('[data-workflow-dialog]');
      await page.waitForSelector('[data-workflow-dialog] select');
      await page.locator('[data-workflow-dialog] select').selectOption('ship-check');
      await page.click('[data-start-workflow]');
      await page.waitForSelector('[data-workflow="ship-check"]', { timeout: 20_000 });
      const card = await page.waitForSelector('[data-attention] [data-pending="approval_request"]', { timeout: 20_000 });
      assert.match(await card.innerText(), /Ship it\?/);
      // The decision is always in view: the footer sits inside the window, whatever the length of the details.
      const approve = await page.locator('[data-attention] [data-pending="approval_request"] [data-panel-footer] button:has-text("Approve")').boundingBox();
      const view = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      assert.ok(approve && approve.y >= 0 && approve.y + approve.height <= view.height, 'Approve is on screen');
      await shot('chat-workflow-approval');
      await page.click('[data-attention] [data-pending="approval_request"] button:has-text("Approve")');
      await page.waitForSelector('[data-workflow="ship-check"][data-status="succeeded"]', { timeout: 20_000 });
      await shot('chat-workflow-done', page.locator('[data-workflow="ship-check"]'));
    });

    await step('drafts stay with their conversation, a new chat starts clean, a reopened conversation keeps its workflow card, the context panel', async () => {
      const box = page.locator('[data-composer-input]');
      // The context panel, from the meter in the header.
      await page.click('[data-context-meter]');
      await page.waitForSelector('[data-context-panel] [data-context-part="tools"]', { timeout: 15_000 });
      assert.match(await page.locator('[data-context-used]').innerText(), /% used/);
      await shot('context-panel', page.locator('[data-context-panel]'));
      await page.keyboard.press('Escape');
      // A second conversation, opened straight from the first: neither takes the other's draft.
      const second = await api('POST', '/api/sessions', { title: 'Second conversation', runtime: 'local' });
      assert.equal(second.status, 201, JSON.stringify(second.body));
      const otherId = (second.body as { id: string }).id;
      await box.fill('draft for the first');
      await page.locator(`[data-session-row="${otherId}"] button`).first().click({ timeout: 15_000 });
      await page.waitForSelector(`[data-session="${otherId}"]`);
      assert.equal(await box.inputValue(), '', 'the second conversation opens without the first one\'s draft');
      await box.fill('draft for the second');
      await newChat();
      assert.equal(await box.inputValue(), '', 'a new chat starts clean');
      await box.fill('typed on the new chat, not sent');
      // Long enough for the first conversation's stream to close: it is read again when it reopens.
      await page.waitForTimeout(2_000);
      await page.click(`[data-session-row="${sessionId}"] button`);
      await page.waitForSelector(`[data-session="${sessionId}"]`);
      assert.equal(await box.inputValue(), 'draft for the first', 'back in the first conversation: its draft');
      await page.waitForSelector('[data-workflow="ship-check"][data-status="succeeded"]', { timeout: 15_000 });
      await page.click(`[data-session-row="${otherId}"] button`);
      await page.waitForSelector(`[data-session="${otherId}"]`);
      assert.equal(await box.inputValue(), 'draft for the second');
      await newChat();
      assert.equal(await box.inputValue(), '', 'the unsent new-chat text is not kept');
      await page.click(`[data-session-row="${sessionId}"] button`);
      await page.waitForSelector(`[data-session="${sessionId}"]`);
      await box.fill('');
      await api('DELETE', `/api/sessions/${otherId}`);
    });

    await step('the model picker: grouped by tier, searchable, Enter picks the first match', async () => {
      await page.click('[data-model-picker]');
      await page.waitForSelector('[data-model-list]');
      const tiers = await page.$$eval('[data-model-tier]', (els) => els.map((e) => e.getAttribute('data-model-tier')));
      assert.deepEqual(tiers.filter((t) => ['frontier', 'balanced', 'fast'].includes(t!)), tiers, 'only the three tiers');
      assert.equal(tiers[0], 'frontier', 'the strongest first');
      assert.ok(await page.locator('[data-model-tier="frontier"] [data-model="claude-opus-5-5"]').count(), 'Opus 5.5 is among the most capable');
      await page.fill('[data-model-search]', 'haiku');
      assert.deepEqual(await page.$$eval('[data-model-list] [data-model]', (els) => els.map((e) => e.getAttribute('data-model'))), ['claude-haiku-5-5']);
      await shot('model-picker-search');
      await page.fill('[data-model-search]', 'no such model at all');
      await page.waitForSelector('[data-model-list] >> text=No model matches');
      await page.keyboard.press('Escape');
    });

    await step('a large pasted image is scaled to the long edge of its model before it is sent', async () => {
      const before = ((await api('GET', `/api/sessions/${sessionId}`)).body as { history: unknown[] }).history.length;
      await page.locator('[data-composer-input]').focus();
      await page.evaluate(async () => {
        const c = new OffscreenCanvas(3000, 1500);
        const g = c.getContext('2d')!;
        g.fillStyle = '#3366cc'; g.fillRect(0, 0, 3000, 1500); g.fillStyle = '#fff'; g.fillRect(100, 100, 800, 400);
        const file = new File([await c.convertToBlob({ type: 'image/png' })], 'wide.png', { type: 'image/png' });
        const dt = new DataTransfer(); dt.items.add(file);
        document.querySelector('[data-composer-input]')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      });
      await page.waitForSelector('[data-attachments]', { timeout: 10_000 });
      await send('describe this picture');
      await page.waitForFunction(async ([id, n]) => { const r = await fetch(`/api/sessions/${id}`, { headers: { 'x-harness': '1' } }); const j = await r.json(); return j.history.length > n; }, [sessionId, before] as const, { timeout: 30_000 });
      const detail = (await api('GET', `/api/sessions/${sessionId}`)).body as { history: Array<{ role: string; content: Array<{ type: string; data?: string; text?: string }> }> };
      const sent = detail.history.slice(before).find((m) => m.role === 'user')!;
      const img = sent.content.find((b) => b.type === 'image');
      let png: Buffer;
      if (img?.data) png = Buffer.from(img.data, 'base64');
      else {
        // A model that cannot see images gets the file saved in the workspace instead.
        const where = /\.harness\/uploads\/[^\s,\]]+/.exec(sent.content.map((b) => b.text ?? '').join(' '))?.[0];
        assert.ok(where, 'the image went as an image or as a saved file');
        png = fs.readFileSync(path.join(work, where));
      }
      // The session's model sets the edge (DeepSeek 1302, Opus 5.5 2576, else 2048).
      const meta = ((await api('GET', `/api/sessions/${sessionId}`)).body as { meta: { model: string } }).meta;
      const edge = ((await api('GET', '/api/models')).body as Array<{ id: string; imageMaxEdge?: number }>).find((m) => m.id === meta.model)?.imageMaxEdge ?? 2048;
      assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [edge, edge / 2], `scaled to ${edge} x ${edge / 2} for ${meta.model}`);
      await page.waitForSelector('[data-session][data-status="idle"]', { timeout: 30_000 });
    });

    await step('the command palette opens with Ctrl+K and runs commands', async () => {
      await page.keyboard.press('Control+K');
      await page.waitForSelector('[data-palette]');
      await page.keyboard.type('sett');
      await shot('command-palette');
      assert.ok(await page.locator('[data-entry="cmd:core.settings:open"]').count());
      await page.keyboard.press('Escape');
      await page.waitForSelector('[data-palette]', { state: 'detached' });
      // The component gallery, from the palette: every standard component renders.
      await page.keyboard.press('Control+K');
      await page.waitForSelector('[data-palette]');
      await page.keyboard.type('component gallery');
      await page.click('[data-entry="cmd:core.gallery:open"]');
      await page.waitForSelector('[data-gallery] [data-state="error"]');
      assert.ok(await page.locator('[data-gallery] [data-page-header]').count(), 'the gallery is a Page');
      await shot('component-gallery');
    });

    await step('settings: every section renders, plugin schema sections too', async () => {
      await page.keyboard.press('Control+Comma');
      await page.waitForSelector('[data-settings]');
      const sections = await page.$$eval('[data-settings-section]', (els) => els.map((e) => e.getAttribute('data-settings-section')!));
      for (const id of ['core.settings:appearance', 'core.settings:general', 'core.settings:application', 'core.settings:shortcuts', 'core.settings:servers', 'core.settings:models', 'core.settings:permissions', 'core.settings:instructions', 'core.settings:memory', 'core.settings:vault', 'core.settings:schedules', 'core.settings:mcp', 'core.settings:about', 'notes-frame:notes']) assert.ok(sections.includes(id), `${id} is listed`);
      for (const id of sections) {
        await page.click(`[data-settings-section="${id}"]`);
        await page.waitForTimeout(150);
        assert.equal(await page.locator('[data-settings] [data-render-error]').count(), 0, `${id} renders`);
        if (id === 'core.settings:models') { await page.waitForSelector('[data-provider="deepseek"]'); for (const p of ['anthropic', 'moonshot', 'zai']) assert.ok(await page.locator(`[data-provider="${p}"]`).count(), `${p} is listed`); await shot('settings-models'); }
        if (id === 'notes-frame:notes') { await page.waitForSelector('[data-schema-form] [data-field="maxNotes"]'); await shot('settings-plugin-schema'); }
        if (id === 'core.settings:appearance') await shot('settings-appearance');
      }
      await page.fill('[data-settings] input[aria-label="Search settings"]', 'kimi');
      assert.deepEqual(await page.$$eval('[data-settings-section]', (els) => els.map((e) => e.getAttribute('data-settings-section'))), ['core.settings:models'], 'search finds sections by what they hold');
      await page.keyboard.press('Escape');
    });

    await step('plugins: listed with their UI, switched off and on live', async () => {
      await page.click('[data-nav="core.plugins:plugins"]');
      await page.waitForSelector('[data-plugin="notes-frame"]');
      assert.ok(await page.locator('[data-plugin="hello-frame"]').count());
      assert.ok(await page.locator('[data-plugin="core.chat"]').count(), 'the built-ins are plugins too');
      await shot('plugins');
      await page.locator('[data-plugin="notes-frame"] [role="switch"]').click();
      await page.waitForSelector('[data-nav="notes-frame:notes"]', { state: 'detached', timeout: 15_000 });
      await page.locator('[data-plugin="notes-frame"] [role="switch"]').click();
      await page.waitForSelector('[data-nav="notes-frame:notes"]', { timeout: 15_000 });
    });

    await step('a frame plugin: asks for access, an allowed SDK call works, a call it was not granted is refused', async () => {
      await page.click('[data-nav="notes-frame:notes"]');
      await page.waitForSelector('[data-trust-gate="notes-frame"]');
      await shot('plugin-trust-gate');
      await page.click('[data-grant]');
      const iframe = await page.waitForSelector('[data-plugin-frame="notes-frame"] iframe');
      assert.equal(await iframe.getAttribute('sandbox'), 'allow-scripts allow-forms');
      const frame = page.frameLocator('[data-plugin-frame="notes-frame"] iframe');
      await frame.locator('body[data-ready="1"]').waitFor({ timeout: 20_000 });
      assert.ok(Number(await frame.locator('body').getAttribute('data-sessions')) >= 1, 'sessions.read was granted and works');
      await frame.locator('#note').fill('Remember the milk');
      await frame.locator('#save').click();
      await page.waitForSelector('[data-badge="notes-frame.count"]:has-text("1")');
      await frame.locator('#approvals').click();
      await frame.locator('body[data-refused="1"]').waitFor();
      assert.match(await frame.locator('#refusal').innerText(), /needs the "approvals.respond" capability/);
      // The frame has an opaque origin and no network.
      const f = page.frames().find((x) => x.url().includes('/plugins/notes-frame/'))!;
      assert.equal(await f.evaluate(() => fetch('harness://app/api/sessions').then(() => 'reached', () => 'blocked')), 'blocked');
      assert.equal(await f.evaluate(() => { try { return String(window.parent.document.title); } catch { return 'blocked'; } }), 'blocked');
      assert.equal(await f.evaluate(() => { try { return document.cookie; } catch { return 'blocked'; } }), 'blocked');
      assert.equal(await f.evaluate(() => typeof (window as unknown as { harnessDesktop?: unknown }).harnessDesktop), 'undefined', 'no IPC bridge in a frame');
      await shot('plugin-frame');
      // The server half: the hello-frame page calls its own route.
      await page.click('[data-sidebar] button:has-text("More")');
      await page.click('[data-nav="hello-frame:hello"]');
      await page.click('[data-grant]');
      await page.frameLocator('[data-plugin-frame="hello-frame"] iframe').locator('#greeting:has-text("Hello, there")').waitFor({ timeout: 20_000 });
    });


    await step('plugins switched on and off live: everything they add comes and goes, nothing lingers, settings and grants are kept', async () => {
      const home = async () => { await page.click('[data-nav="core.chat:new"]'); await page.waitForSelector('[data-home]'); };
      const has = async (sel: string) => (await page.locator(sel).count()) > 0;
      const contributions = async () => {
        await home();
        const out: Record<string, boolean> = {
          nav: await has('[data-nav="quick-links:links"]'),
          homeCard: await has('[data-home-card="quick-links:card"]'),
          prompt: await page.locator('[data-home-prompts]').getByText('Summarise the links').count() > 0,
          chip: await has('[data-chip="quick-links:tone"]'),
          status: await has('[data-status-item="quick-links:links"]'),
        };
        await page.locator('[data-composer-input]').fill('/li');
        await page.waitForTimeout(250);
        out.slash = await page.locator('[role="menuitem"]', { hasText: '/links' }).count() > 0;
        await page.locator('[data-composer-input]').fill('');
        await page.keyboard.press('Control+K');
        await page.waitForSelector('[data-palette]');
        await page.keyboard.type('quick links');
        out.command = await has('[data-entry="cmd:quick-links:open"]');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Control+Comma');
        await page.waitForSelector('[data-settings]');
        out.settings = await has('[data-settings-section="quick-links:links"]');
        await page.click('[data-settings-section="core.settings:appearance"]');
        out.theme = await has('[data-theme-choice="quick-links:sea"]');
        await page.keyboard.press('Escape');
        await page.waitForSelector('[data-settings]', { state: 'detached' });
        return out;
      };
      const all = (v: boolean) => ({ nav: v, homeCard: v, prompt: v, chip: v, status: v, slash: v, command: v, settings: v, theme: v });
      assert.deepEqual(await contributions(), all(true), 'a declarative plugin contributes at every point');
      // Clashes: the core keeps Ctrl+K and /plan; the plugin's are shown as clashes, nothing crashes.
      await page.click('[data-nav="core.plugins:plugins"]');
      const clash = await page.locator('[data-plugin="quick-links"] [data-conflict]').innerText();
      assert.match(clash, /Mod\+K is already core\.shell:palette/);
      assert.match(clash, /\/plan is already core\.chat/);
      assert.match(await page.locator('[data-plugin="broken-ui"] [data-ui-error]').innerText(), /not a contribution point/);
      const navBefore = await page.$$eval('[data-nav]', (els) => els.map((e) => e.getAttribute('data-nav')));
      await page.keyboard.press('Control+K');
      await page.waitForSelector('[data-palette]');
      await page.keyboard.press('Escape');

      // Its theme in use, a setting stored, its page open: then it is switched off.
      await invoke('prefs:set', { theme: 'quick-links:sea', pluginSettings: { 'quick-links': { openIn: 'app' } } });
      await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--hx-bg') === '#0b1d26');
      await page.click('[data-nav="quick-links:links"]');
      await page.waitForSelector('[data-view="quick-links:links"]');
      const off = await api('POST', '/api/plugins/quick-links/disable');
      assert.equal(off.status, 200, JSON.stringify(off.body));
      await page.waitForSelector('[data-home]', { timeout: 15_000 });
      await page.waitForSelector('[data-toast]:has-text("Quick links was switched off")');
      await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--hx-bg') !== '#0b1d26');
      assert.deepEqual(await contributions(), all(false), 'switched off: every contribution is gone');
      assert.equal(((await invoke('prefs:get')) as { theme: string }).theme, 'quick-links:sea', 'the choice is kept for when it comes back');

      // Back on: everything returns, the theme and the stored setting with it.
      assert.equal((await api('POST', '/api/plugins/quick-links/enable')).status, 200);
      await page.waitForSelector('[data-nav="quick-links:links"]', { timeout: 15_000 });
      await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--hx-bg') === '#0b1d26');
      assert.deepEqual(await contributions(), all(true));
      await page.keyboard.press('Control+Comma');
      await page.click('[data-settings-section="quick-links:links"]');
      assert.match(await page.locator('[data-field="openIn"] [role="radio"][aria-checked="true"]').innerText(), /The app/);
      await page.keyboard.press('Escape');
      await invoke('prefs:set', { theme: 'light' });

      // A frame plugin: its fence renderer and its open panel; switched off, both go; back on, its grant is kept.
      const r = await api('POST', '/api/sessions/import', { runtime: 'local', bundle: { ...longBundle(0), source: { ...longBundle(0).source, title: 'Hello fence' }, history: [{ role: 'user', content: [{ type: 'text', text: 'Say hello' }] }, { role: 'assistant', content: [{ type: 'text', text: 'A greeting:\n\n```hello\nworld\n```' }] }] } });
      const id = (r.body as { id: string }).id;
      await page.click(`[data-session-row="${id}"] button`);
      await page.waitForSelector('[data-plugin-renderer="hello-frame:hello-fence"]', { timeout: 15_000 });
      await page.click('[data-topbar] button[aria-label="Hello panel"]');
      await page.waitForSelector('[data-side-panel] [data-plugin-frame="hello-frame"]');
      await shot('plugin-panel-and-renderer');
      assert.equal((await api('POST', '/api/plugins/hello-frame/disable')).status, 200);
      await page.waitForSelector('[data-side-panel]', { state: 'detached', timeout: 15_000 });
      await page.waitForSelector('[data-block="code"][data-lang="hello"]', { timeout: 15_000 });
      assert.equal(await page.locator('[data-plugin-renderer]').count(), 0, 'its renderer falls back to the default');
      assert.equal(await page.locator('[data-topbar] button[aria-label="Hello panel"]').count(), 0);
      // Both off at once, then both on: the same sidebar in the same order.
      assert.equal((await api('POST', '/api/plugins/quick-links/disable')).status, 200);
      await page.waitForSelector('[data-nav="quick-links:links"]', { state: 'detached', timeout: 15_000 });
      assert.equal((await api('POST', '/api/plugins/hello-frame/enable')).status, 200);
      assert.equal((await api('POST', '/api/plugins/quick-links/enable')).status, 200);
      await page.waitForSelector('[data-nav="quick-links:links"]', { timeout: 15_000 });
      await page.waitForSelector('[data-plugin-renderer="hello-frame:hello-fence"]', { timeout: 15_000 });
      await page.click('[data-nav="core.plugins:plugins"]');
      assert.deepEqual(await page.$$eval('[data-nav]', (els) => els.map((e) => e.getAttribute('data-nav'))), navBefore, 'deterministic order');
      if (!(await page.locator('[data-nav="hello-frame:hello"]').isVisible())) await page.click('[data-sidebar] button:has-text("More")');
      await page.click('[data-nav="hello-frame:hello"]');
      await page.frameLocator('[data-plugin-frame="hello-frame"] iframe').locator('#greeting:has-text("Hello, there")').waitFor({ timeout: 20_000 });
      assert.equal(await page.locator('[data-trust-gate]').count(), 0, 'its grant was kept');
    });

    await step('rich output: every renderer draws, and the artifact frames are sandboxed', async () => {
      const r = await api('POST', '/api/sessions/import', { runtime: 'local', bundle: { ...longBundle(0), source: { ...longBundle(0).source, title: 'Kitchen sink' }, history: [{ role: 'user', content: [{ type: 'text', text: 'Show me everything you can draw.' }] }, { role: 'assistant', content: [{ type: 'text', text: KITCHEN_SINK }] }] } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      richId = (r.body as { id: string }).id;
      await page.click('[data-nav="core.chat:search"]');
      await page.evaluate((id) => { sessionStorage.setItem('harness.route', JSON.stringify({ view: 'core.chat:session', params: { id } })); }, (r.body as { id: string }).id);
      await page.click(`[data-session-row="${(r.body as { id: string }).id}"] button`);
      await page.waitForSelector('[data-assistant-message]');
      await page.waitForSelector('[data-diagram="svg"] svg', { timeout: 30_000 });
      await page.waitForFunction(() => document.querySelectorAll('[data-diagram="svg"] svg').length >= 2, null, { timeout: 30_000 });
      const flowText = await page.locator('[data-diagram="svg"] svg').first().textContent();
      for (const label of ['Browser', 'Gateway', 'API', 'Error page', 'Database', 'auth ok']) assert.ok(flowText?.includes(label), `the Mermaid label "${label}" is drawn`);
      await page.waitForSelector('[data-chart="echarts"] svg', { timeout: 30_000 });
      await page.waitForSelector('[data-chart="vega"] svg', { timeout: 30_000 });
      assert.ok(await page.locator('.katex').count() >= 2, 'KaTeX drew the maths');
      assert.ok(await page.locator('[data-block="code"]').count() >= 3);
      assert.ok(await page.locator('[data-md-table] table').count() >= 1);
      assert.ok(await page.locator('[data-table]').count() >= 2, 'CSV and table spec');
      assert.ok(await page.locator('[data-json]').count() >= 1);
      assert.ok(await page.locator('[data-block="diff"]').count() >= 1);
      assert.ok(await page.locator('[data-image] img').count() >= 1);
      assert.ok(await page.locator('[data-citation]').count() >= 2);
      for (const sb of await page.$$eval('iframe[data-artifact-frame]', (els) => els.map((e) => e.getAttribute('sandbox')))) assert.doesNotMatch(String(sb), /allow-same-origin/);
      assert.equal(await page.locator('[data-render-error]').count(), 0, 'no block failed');
      await page.waitForFunction(() => [...document.querySelectorAll('iframe[data-artifact-frame="react"]')].length > 0, null, { timeout: 15_000 });
      const reactFrame = await (async () => {
        for (let i = 0; i < 60; i++) {
          for (const f of page.frames().filter((x) => x.url().startsWith('harness://preview/'))) {
            const text = await f.evaluate(() => document.body.innerText).catch(() => '');
            if (/React clicks/.test(text)) return text;
          }
          await page.waitForTimeout(250);
        }
        return '';
      })();
      assert.match(reactFrame, /React clicks: 0/, 'the React artifact runs');
      await shot('chat-rich-top');
      const shotEl = async (name: string, sel: string) => { const el = page.locator(sel).first(); await el.scrollIntoViewIfNeeded(); await shot(name, el); };
      await shotEl('render-table', '[data-md-table]');
      await shotEl('render-code', '[data-block="code"][data-lang="python"]');
      await shotEl('render-math', '.katex-display');
      await shotEl('render-mermaid', '[data-widget="Diagram"]');
      await shotEl('render-chart', '[data-widget="Chart"]');
      await shotEl('render-vega', '[data-widget="Figure"]');
      await shotEl('render-html-artifact', '[data-artifact="html"]');
      await shotEl('render-csv', '[data-widget="CSV"]');
      await shotEl('render-diff', '[data-block="diff"]');
      await shotEl('render-image', '[data-image]');
      await page.locator('[data-virtual-list]').evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await shot('chat-rich-bottom');
    });

    await step('science & BI: maths, chemistry 2D and 3D, plots, Graphviz, statistics, dashboard, tables, notebook, map', async () => {
      const r = await api('POST', '/api/sessions/import', { runtime: 'local', bundle: { ...longBundle(0), source: { ...longBundle(0).source, title: 'Science sink' }, history: [{ role: 'user', content: [{ type: 'text', text: 'Show me the science and BI renderers.' }] }, { role: 'assistant', content: [{ type: 'text', text: SCIENCE_KITCHEN_SINK }] }] } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const id = (r.body as { id: string }).id;
      await page.click('[data-nav="core.chat:search"]');
      await page.click(`[data-session-row="${id}"] button`);
      await page.waitForSelector('[data-assistant-message] [data-fplot]', { timeout: 30_000 });
      // Each lazy renderer loads and draws.
      await page.waitForFunction(() => document.querySelectorAll('[data-smiles-drawn="1"]').length >= 2, null, { timeout: 30_000 });
      await page.waitForSelector('[data-graphviz="svg"] svg', { timeout: 30_000 });
      assert.ok(await page.locator('[data-fplot] polyline').count() >= 4, 'the plots are drawn (tan in pieces)');
      assert.ok(await page.locator('[data-geomap] circle').count() >= 2);
      assert.equal(await page.locator('[data-dashboard] [data-kpi]').count(), 4);
      await page.waitForFunction(() => document.querySelectorAll('[data-dashboard] [data-chart] svg').length >= 2, null, { timeout: 30_000 });
      await page.waitForFunction(() => document.querySelectorAll('[data-chart="vega"] svg').length >= 5, null, { timeout: 30_000 });
      await page.waitForFunction(() => document.querySelectorAll('[data-chart="echarts"] svg').length >= 3, null, { timeout: 30_000 });
      assert.equal(await page.locator('[data-notebook] [data-cell]').count(), 5);
      assert.ok(await page.locator('.katex .mord').count() > 20, 'KaTeX with mhchem and the physics macros');
      assert.equal(await page.locator('.katex-error').count(), 0, 'every formula parsed');
      assert.equal(await page.locator('[data-artifact="diagram"] [data-diagram-svg]').count(), 1, 'a diagram block is drawn (core.diagrams)');
      // Tables: filter, stats, pivot.
      const table = page.locator('[data-widget="CSV"] [data-table]').first();
      await table.locator('[data-table-filter]').fill('gizmo');
      await table.locator('[data-table-count]:has-text("3 of 10")').waitFor({ timeout: 5_000 });
      await table.locator('button:has-text("Stats")').click();
      await table.locator('[data-table-stats] th:has-text("median")').waitFor({ timeout: 5_000 });
      await table.locator('[data-table-filter]').fill('');
      await table.locator('button:has-text("Pivot")').click();
      await table.locator('[data-table-pivot] table').waitFor({ timeout: 5_000 });
      // The 3D viewer runs in its sandboxed frame and reports the atoms it parsed.
      const atoms = await (async () => {
        for (let i = 0; i < 80; i++) {
          const found: number[] = [];
          for (const f of page.frames().filter((x) => x.url().startsWith('harness://preview/'))) {
            const n = await f.evaluate(() => Number(document.body.getAttribute('data-atoms') ?? 0)).catch(() => 0);
            if (n) found.push(n);
          }
          if (found.length >= 2) return found.sort((a, b) => a - b);
          await page.waitForTimeout(250);
        }
        return [];
      })();
      assert.deepEqual(atoms, [3, 10], '3Dmol parsed the molfile and the PDB');
      for (const sb of await page.$$eval('iframe[data-artifact-frame]', (els) => els.map((e) => e.getAttribute('sandbox')))) assert.doesNotMatch(String(sb), /allow-same-origin/);
      assert.equal(await page.locator('[data-render-error]').count(), 0, 'no block failed');
      const shotEl = async (name: string, sel: string) => { const el = page.locator(sel).first(); await el.scrollIntoViewIfNeeded(); await shot(name, el); };
      await shot('science-top');
      await shotEl('render-science-math', '[data-assistant-message] .katex-display');
      await shotEl('render-smiles', '[data-widget="Structure"]');
      await shotEl('render-molecule-3d', '[data-widget="3D structure"]');
      await shotEl('render-function-plot', '[data-widget="Plot"]');
      await shotEl('render-graphviz', '[data-widget="Graph"]');
      await shotEl('render-vega-stats', '[data-widget="Figure"]');
      await shotEl('render-echarts-heatmap', '[data-widget="Chart"] >> nth=1');
      // Taller than the window: shown whole at a smaller zoom.
      const shotTall = async (name: string, sel: string) => {
        await setSize(1280, 1000);
        await page.evaluate(() => { document.documentElement.style.zoom = '0.6'; });
        try { await shotEl(name, sel); } finally { await page.evaluate(() => { document.documentElement.style.zoom = ''; }); await setSize(1280, 820); }
      };
      await shotTall('render-table-pivot', '[data-widget="CSV"]');
      await shotTall('render-dashboard', '[data-widget="Dashboard"]');
      await shotTall('render-notebook', '[data-widget="Notebook"]');
      await shotEl('render-geojson', '[data-widget="Map"]');
      await shotEl('render-diagram', '[data-artifact="diagram"]');
      await page.locator('[data-virtual-list]').evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await shot('science-bottom');
    });

    await step('an HTML artifact cannot reach the app, its cookies or the network', async () => {
      await newChat();
      await page.evaluate(() => { (window as unknown as { __probe?: unknown }).__probe = null; window.addEventListener('message', (e) => { const d = e.data as { escapeProbe?: unknown }; if (d && d.escapeProbe) (window as unknown as { __probe?: unknown }).__probe = d.escapeProbe; }); });
      await send('escape probe please');
      await page.waitForSelector('iframe[data-artifact-frame="html"]', { timeout: 30_000 });
      const probe = await page.waitForFunction(() => (window as unknown as { __probe?: unknown }).__probe, null, { timeout: 30_000 }).then((h) => h.jsonValue()) as Record<string, unknown>;
      assert.equal(probe.parent, 'blocked');
      assert.equal(probe.cookie, 'blocked');
      assert.equal(probe.storage, 'blocked');
      assert.equal(probe.top, 'blocked');
      assert.equal(probe.fetch, 'blocked');
    });

    await step('a 1,000-message transcript opens, scrolls and streams without long tasks over 100 ms', async () => {
      const r = await api('POST', '/api/sessions/import', { runtime: 'local', bundle: longBundle(1000) });
      assert.equal(r.status, 201);
      const id = (r.body as { id: string }).id;
      await page.click(`[data-session-row="${id}"] button`);
      await page.waitForSelector(`[data-session="${id}"] [data-assistant-message]`, { timeout: 30_000 });
      assert.ok(await page.locator('[data-row]').count() < 120, 'only what is on screen is mounted');
      await page.evaluate(() => {
        const w = window as unknown as { __long: number[] };
        w.__long = [];
        new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__long.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: false });
      });
      await page.waitForTimeout(500);
      await page.evaluate(async () => {
        const el = document.querySelector('[data-virtual-list]') as HTMLElement;
        for (let y = el.scrollHeight; y > 0; y -= 900) { el.scrollTop = y; await new Promise((res) => setTimeout(res, 16)); }
        for (let y = 0; y < el.scrollHeight; y += 1400) { el.scrollTop = y; await new Promise((res) => setTimeout(res, 16)); }
        el.scrollTop = el.scrollHeight;
      });
      const scrolling = await page.evaluate(() => (window as unknown as { __long: number[] }).__long.splice(0));
      // The test's own scrolling settles first: rows mounted by the last scroll are measured and the list stops
      // moving (under load that takes a while, and its corrections are not the answer's doing).
      const settled = await page.evaluate(async () => {
        const el = document.querySelector('[data-virtual-list]') as HTMLElement;
        const sig = () => `${el.scrollTop}|${el.scrollHeight}|${[...el.querySelectorAll('[data-row]')].map((r) => `${Math.round(r.getBoundingClientRect().top)}:${Math.round(r.getBoundingClientRect().height)}`).join(',')}`;
        const frame = () => new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
        const end = performance.now() + 10_000;
        let last = sig(); let still = 0;
        while (still < 30 && performance.now() < end) { await frame(); const now = sig(); still = now === last ? still + 1 : 0; last = now; }
        return still >= 30;
      });
      // Layout shifts while the answer streams in (what moves without the person doing anything): only those after
      // the send, in the transcript, not after input. A shift left over from settling is reported, not counted.
      await page.evaluate(() => {
        const w = window as unknown as { __shift: number; __early: number; __from: number; __shifts: string[] };
        w.__shift = 0; w.__early = 0; w.__from = Infinity; w.__shifts = [];
        type Shift = PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: Array<{ node?: Node; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }> };
        const name = (n?: Node) => { const el = n instanceof Element ? n : n?.parentElement; if (!el) return '?'; const a = [...el.attributes].filter((x) => x.name.startsWith('data-')).map((x) => `${x.name}=${x.value.slice(0, 20)}`).join(' '); return `${el.tagName.toLowerCase()}[${a}]`; };
        new PerformanceObserver((l) => { for (const e of l.getEntries() as Shift[]) if (!e.hadRecentInput) {
          // What matters: the transcript's text moving under the reader. The composer shrinking after a send is the person's own doing.
          const inTranscript = (e.sources ?? []).some((x) => { const el = x.node instanceof Element ? x.node : x.node?.parentElement; return !!el?.closest('[data-virtual-list] [data-row]'); });
          if (inTranscript) { if (e.startTime >= w.__from) w.__shift += e.value; else w.__early += e.value; }
          if (e.value > 0.005) w.__shifts.push(`${e.startTime >= w.__from ? '' : '(before the send) '}${e.value.toFixed(3)}: ${(e.sources ?? []).map((x) => `${name(x.node)} y ${Math.round(x.previousRect.y)}->${Math.round(x.currentRect.y)} h ${Math.round(x.previousRect.height)}->${Math.round(x.currentRect.height)}`).join('; ')}`); } }).observe({ type: 'layout-shift', buffered: false });
      });
      await page.waitForTimeout(300);
      await page.evaluate(() => { (window as unknown as { __from: number }).__from = performance.now(); });
      // The reader stays at the bottom: the view follows the answer the whole time ("jump to the latest" never shows).
      await page.evaluate(() => {
        const w = window as unknown as { __unpinned: number; __watch: boolean };
        w.__unpinned = 0; w.__watch = true;
        const tick = () => { if (!w.__watch) return; if (document.querySelector('[data-jump-latest]')) w.__unpinned++; requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      });
      await send('stream a long answer please');
      await page.waitForSelector(`[data-session="${id}"][data-status="running"]`, { timeout: 15_000 }).catch(() => {});
      await page.waitForSelector(`[data-session="${id}"][data-status="idle"]`, { timeout: 60_000 });
      await page.waitForTimeout(800);
      const streaming = await page.evaluate(() => (window as unknown as { __long: number[] }).__long.splice(0));
      const shift = await page.evaluate(() => (window as unknown as { __shift: number }).__shift);
      const shifts = await page.evaluate(() => (window as unknown as { __shifts: string[] }).__shifts);
      if (shifts.length) t.diagnostic(`layout shifts: ${shifts.slice(0, 8).join(' | ')}`);
      const early = await page.evaluate(() => (window as unknown as { __early: number }).__early);
      t.diagnostic(`long tasks while scrolling: ${JSON.stringify(scrolling)}; while streaming: ${JSON.stringify(streaming)}; layout shift while streaming: ${shift.toFixed(4)} (settled first: ${settled}; before the send, not counted: ${early.toFixed(4)})`);
      assert.ok(shift < 0.1, `transcript layout shift while streaming: ${shift}`);
      const unpinned = await page.evaluate(() => { const w = window as unknown as { __unpinned: number; __watch: boolean }; w.__watch = false; return w.__unpinned; });
      const gap = await page.locator('[data-virtual-list]').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
      assert.equal(unpinned, 0, 'the view followed the answer (no "jump to the latest" while streaming)');
      assert.ok(gap < 2, `the view ends at the bottom (${gap} px above it)`);
      assert.ok(Math.max(0, ...scrolling) <= 100, `scrolling: ${JSON.stringify(scrolling)}`);
      assert.ok(Math.max(0, ...streaming) <= 100, `streaming: ${JSON.stringify(streaming)}`);
    });

    await step('keybindings: defaults work and can be rebound', async () => {
      const collapsed = () => page.getAttribute('[data-sidebar]', 'data-collapsed');
      const before = await collapsed();
      await page.locator('[data-statusbar]').click();
      await page.keyboard.press('Control+B');
      await page.waitForFunction((b) => document.querySelector('[data-sidebar]')?.getAttribute('data-collapsed') !== b, before);
      await invoke('prefs:set', { keybindings: { 'core.shell:sidebar': 'Ctrl+Alt+B' } });
      await page.waitForTimeout(300);
      await page.keyboard.press('Control+Alt+B');
      await page.waitForFunction((b) => document.querySelector('[data-sidebar]')?.getAttribute('data-collapsed') === b, before);
      await page.keyboard.press('Alt+ArrowLeft');
      await invoke('prefs:set', { keybindings: {} });
    });

    await step('keyboard: everything reachable with Tab and a visible focus ring, every icon button named, dialogs close with Escape', async () => {
      await newChat();
      const unnamed = await page.$$eval('button, [role="button"], a[href], input, textarea, select', (els) => els.filter((e) => {
        const el = e as HTMLElement;
        if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') return false;
        const name = (el.getAttribute('aria-label') ?? el.getAttribute('title') ?? el.getAttribute('placeholder') ?? el.textContent ?? '').trim();
        const labels = (el as HTMLInputElement).labels; return !name && !(labels && labels.length);
      }).map((e) => e.outerHTML.slice(0, 120)));
      assert.deepEqual(unnamed, [], 'every control has a name');
      await page.locator('[data-statusbar]').click();
      const seen: string[] = [];
      for (let i = 0; i < 60 && !seen.includes('composer'); i++) {
        await page.keyboard.press('Tab');
        const f = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || el === document.body) return null;
          const cs = getComputedStyle(el);
          const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== 'none');
          const r = el.getBoundingClientRect();
          return { what: el.hasAttribute('data-composer-input') ? 'composer' : el.getAttribute('data-nav') ?? el.getAttribute('aria-label') ?? el.tagName.toLowerCase(), ring: !!ring || el.matches('textarea, input'), visible: r.width > 0 && r.height > 0 };
        });
        if (!f) continue;
        assert.ok(f.visible, `focus on something visible (${f.what})`);
        assert.ok(f.ring, `a focus ring on ${f.what}`);
        seen.push(f.what);
      }
      assert.ok(seen.some((x) => x === 'core.chat:new'), `the sidebar is reachable (${seen.join(', ')})`);
      assert.ok(seen.includes('composer'), `the composer is reachable (${seen.join(', ')})`);
      // The palette: open, move, run with the keyboard; Escape closes and gives focus back.
      await page.keyboard.press('Control+K');
      await page.waitForSelector('[data-palette]');
      await page.keyboard.type('settings');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Escape');
      await page.waitForSelector('[data-palette]', { state: 'detached' });
      await page.keyboard.press('Control+,');
      await page.waitForSelector('[data-settings]', { timeout: 5_000 });
      await page.keyboard.press('Escape');
      await page.waitForSelector('[data-settings]', { state: 'detached', timeout: 5_000 });
    });

    await step('light and dark themes, a plugin theme, and small windows', async () => {
      await newChat();
      await invoke('prefs:set', { theme: 'dark' });
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
      await shot('home-dark');
      await page.click(`[data-session-row="${sessionId}"] button`);
      await page.waitForSelector('[data-assistant-message]');
      await shot('chat-dark');
      await invoke('prefs:set', { theme: 'core.shell:paper' });
      await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--hx-bg') === '#f7f3ea');
      await invoke('prefs:set', { theme: 'light' });
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
      await shot('chat-light');
      // The rich renderers in dark, and at narrow widths (wide blocks scroll inside, never the page).
      await page.click('[data-nav="core.chat:search"]');
      await page.click(`[data-session-row="${richId}"] button`);
      await page.waitForSelector(`[data-session="${richId}"] [data-chart="vega"] svg`, { timeout: 30_000 });
      await invoke('prefs:set', { theme: 'dark' });
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
      await page.waitForTimeout(600);
      await shot('chat-rich-dark');
      for (const sel of ['[data-block="code"][data-lang="python"]', '[data-md-table]', '[data-widget="Chart"]', '[data-block="diff"]']) {
        const el = page.locator(sel).first(); await el.scrollIntoViewIfNeeded();
      }
      await shot('chat-rich-dark-bottom');
      await invoke('prefs:set', { theme: 'light' });
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
      await setSize(520, 760);
      await page.waitForTimeout(500);
      // Narrow: the sidebar is a rail; expanding floats it over the page, Escape puts it back.
      assert.equal(await page.getAttribute('[data-sidebar]', 'data-collapsed'), '1', 'a rail at narrow widths');
      await page.click('[data-sidebar] button[aria-label="Expand the sidebar"]');
      await page.waitForSelector('[data-sidebar][data-collapsed="0"]');
      await page.keyboard.press('Escape');
      await page.waitForSelector('[data-sidebar][data-collapsed="1"]');
      const overRich = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overRich <= 1, `rich blocks stay inside a narrow window (${overRich})`);
      const wide = await page.$$eval('[data-assistant-message] *', (els) => els.filter((e) => { const r = e.getBoundingClientRect(); const list = document.querySelector('[data-virtual-list]')!.getBoundingClientRect(); return r.width > 0 && r.right > list.right + 2 && !e.closest('[data-block="code"], [data-md-table], [data-table], [data-chart], .katex-display, [data-diff], [data-block="diff"]'); }).map((e) => e.tagName + '.' + (e.className?.toString() ?? '').slice(0, 40)));
      assert.deepEqual(wide.slice(0, 5), [], 'nothing pokes out of the column');
      await shot('chat-rich-narrow');
      await setSize(1280, 820);
      await newChat();
      for (const [w, h] of [[900, 700], [640, 640], [520, 560]] as const) {
        await setSize(w, h);
        await page.waitForTimeout(400);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(over <= 1, `no sideways scroll at ${w}px (${over})`);
        assert.ok(await page.locator('[data-composer-input]').isVisible(), `the composer is usable at ${w}px`);
      }
      await shot('small-window');
      await setSize(1280, 820);
    });

    await step('the onboarding wizard steps come from the registry', async () => {
      await page.keyboard.press('Control+K');
      await page.keyboard.type('welcome wizard');
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-onboarding]');
      await shot('onboarding');
      await page.click('[data-onboarding-next]');
      await page.waitForSelector('[data-onboard-model]');
      await page.click('[data-onboarding] button:has-text("Skip setup")');
      await page.waitForSelector('[data-onboarding]', { state: 'detached' });
    });

    await step('when the engine stops, the window says so and recovers', async () => {
      await newChat();
      await send('crash the engine now');
      await page.waitForSelector('[data-engine-banner]', { timeout: 30_000 });
      await shot('engine-down');
      await ready();
      await page.waitForSelector('[data-engine-banner]', { state: 'detached', timeout: 30_000 });
      assert.ok(await page.locator(`[data-session-row="${sessionId}"]`).count(), 'conversations are still there');
      // And the Restart button in Settings > Application.
      await invoke('engine:restart');
      await ready();
    });

    await step('biology: sequences, alignments, trees, plasmids, tracks, proteins, pathways, statistics', async () => {
      const before = errors.length;
      const r = await api('POST', '/api/sessions/import', { runtime: 'local', bundle: { ...longBundle(0), source: { ...longBundle(0).source, title: 'Biology sink' }, history: [{ role: 'user', content: [{ type: 'text', text: 'Show me the biology renderers.' }] }, { role: 'assistant', content: [{ type: 'text', text: BIO_KITCHEN_SINK }] }] } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const id = (r.body as { id: string }).id;
      bioId = id;
      await page.click('[data-nav="core.chat:search"]');
      await page.click(`[data-session-row="${id}"] button`);
      const inSession = `[data-session="${id}"] [data-assistant-message]`;
      await page.waitForSelector(`${inSession} [data-seq-map]`, { timeout: 30_000 });
      // The lazy chunk, Vega (four plots), Graphviz (the pathway) and the 3D frame all arrive.
      await page.waitForFunction((s) => document.querySelectorAll(`${s} [data-bioplot] [data-chart="vega"] svg`).length >= 4, inSession, { timeout: 30_000 });
      await page.waitForSelector(`${inSession} [data-pathway] [data-graphviz="svg"] svg`, { timeout: 30_000 });
      const widgets = ['Sequence', 'Alignment', 'Tree', 'Plasmid map', 'Genome tracks', '3D structure', 'Protein features', 'Pathway', 'Volcano plot', 'MA plot', 'Heatmap', 'Survival curve', 'Manhattan plot'];
      const drawn = await page.$$eval(`${inSession} [data-widget]`, (els) => els.map((e) => ({ kind: e.getAttribute('data-widget'), drawn: !!e.querySelector(':scope > div:nth-child(2) svg:not([data-icon]), :scope > div:nth-child(2) canvas, :scope > div:nth-child(2) iframe'), state: e.getAttribute('data-state') })));
      for (const w of widgets) assert.ok(drawn.some((d) => d.kind === w && d.drawn), `${w} is drawn (${JSON.stringify(drawn.filter((d) => d.kind === w))})`);
      assert.equal(drawn.length, 17, 'every block of the sink');
      assert.deepEqual(drawn.filter((d) => !d.drawn || d.state !== 'ok'), [], 'every block has its drawing and no error state');
      assert.equal(await page.locator(`${inSession} [data-render-error]`).count(), 0, 'no error placeholders');
      // The 3D protein: cartoon, two chains, a ligand, a residue picker (in its sandboxed frame).
      const protein = await (async () => {
        for (let i = 0; i < 80; i++) {
          for (const f of page.frames().filter((x) => x.url().startsWith('harness://preview/'))) {
            const v = await f.evaluate(() => ({ residues: Number(document.body.getAttribute('data-residues') ?? 0), chains: Number(document.body.getAttribute('data-chains') ?? 0), ligands: Number(document.body.getAttribute('data-ligands') ?? 0), picker: document.querySelectorAll('select#res option').length })).catch(() => null);
            if (v && v.residues > 10) return v;
          }
          await page.waitForTimeout(250);
        }
        return null;
      })();
      assert.deepEqual(protein, { residues: 66, chains: 2, ligands: 1, picker: 67 }, '3Dmol read the coiled coil');
      for (const sb of await page.$$eval(`${inSession} iframe[data-artifact-frame]`, (els) => els.map((e) => e.getAttribute('sandbox')))) assert.doesNotMatch(String(sb), /allow-same-origin/);
      // Interaction: reverse complement, translation, selection by feature, tree layout and collapse, plasmid views, tracks zoom.
      const seq = page.locator(`${inSession} [data-sequence="dna"]`).first();
      const first = await seq.locator('[data-i="0"]').textContent();
      await seq.locator('button:has-text("Reverse complement")').click();
      assert.notEqual(await seq.locator('[data-i="0"]').textContent(), first, 'the reverse complement is shown');
      await seq.locator('button:has-text("Reverse complement")').click();
      await seq.locator('button:has-text("Translate (3 frames)")').click();
      assert.ok(await seq.locator('[data-frame="1"]').count() >= 1, 'three-frame translation rows');
      await seq.locator('[data-seq-map] [data-feature]').nth(1).dispatchEvent('click');
      assert.match(String(await seq.locator('[data-seq-selection]').textContent()), /Selected 73–162 \(90 bp\)/);
      const tree = page.locator(`${inSession} [data-phylo]`).first();
      await tree.locator('[data-collapse]').nth(1).click();
      assert.ok(await tree.locator('text=/\\(\\d+ leaves\\)/').count() >= 1, 'a clade collapses');
      await tree.locator('button:has-text("expand all")').click();
      await tree.locator('button:has-text("Circular")').click();
      await tree.locator('[data-tree="circular"]').waitFor({ timeout: 5_000 });
      const plasmid = page.locator(`${inSession} [data-plasmid]`).first();
      await plasmid.locator('[data-plasmid-map="circular"] path[data-feature="CDS"]').last().dispatchEvent('click');
      assert.match(String(await plasmid.locator('[data-plasmid-detail]').textContent()), /AmpR · CDS · 1,626–2,486 \(861 bp\)/);
      const tracks = page.locator(`${inSession} [data-tracks]`).first();
      const ticks = () => tracks.locator('[data-genome-tracks] > g > text').allTextContents();
      const ticks0 = (await ticks()).join(',');
      await tracks.locator('button[aria-label="Zoom in"]').click();
      assert.notEqual((await ticks()).join(','), ticks0, 'the tracks zoom');
      await page.locator(`${inSession} [data-msa] button:has-text("Identity")`).first().click();
      assert.equal(await page.locator(`${inSession} [data-render-error]`).count(), 0, 'interaction broke nothing');
      // Close-ups (light), then one dark overview.
      const shotEl = async (name: string, sel: string) => { const el = page.locator(`${inSession} ${sel}`).first(); await el.scrollIntoViewIfNeeded(); await shot(name, el); };
      const shotTall = async (name: string, sel: string) => {
        await setSize(1280, 1000);
        await page.evaluate(() => { document.documentElement.style.zoom = '0.7'; });
        try { await shotEl(name, sel); } finally { await page.evaluate(() => { document.documentElement.style.zoom = ''; }); await setSize(1280, 820); }
      };
      await tree.locator('button:has-text("Rectangular")').click();
      await shotTall('render-bio-sequence', '[data-widget="Sequence"]');
      await shotEl('render-bio-msa', '[data-widget="Alignment"]');
      await shotEl('render-bio-tree', '[data-widget="Tree"]');
      await tree.locator('button:has-text("Circular")').click();
      await shotTall('render-bio-tree-circular', '[data-widget="Tree"]');
      await shotTall('render-bio-plasmid', '[data-widget="Plasmid map"]');
      await plasmid.locator('button:has-text("Linear")').click();
      await shotEl('render-bio-plasmid-linear', '[data-widget="Plasmid map"]');
      await shotEl('render-bio-tracks', '[data-widget="Genome tracks"] >> nth=2');
      await shotEl('render-bio-gff', '[data-widget="Genome tracks"]');
      await page.waitForTimeout(800);
      await shotEl('render-bio-protein-3d', '[data-widget="3D structure"]');
      await shotEl('render-bio-uniprot', '[data-widget="Protein features"]');
      await shotTall('render-bio-pathway', '[data-widget="Pathway"]');
      await shotEl('render-bio-volcano', '[data-widget="Volcano plot"]');
      await shotEl('render-bio-ma', '[data-widget="MA plot"]');
      await shotTall('render-bio-heatmap', '[data-widget="Heatmap"]');
      await shotEl('render-bio-survival', '[data-widget="Survival curve"]');
      await shotEl('render-bio-manhattan', '[data-widget="Manhattan plot"]');
      await newChat();
      assert.deepEqual(errors.slice(before), [], 'no console errors or exceptions while drawing biology');
    });

    // Last, so the biology session and its theme switch cannot touch the timing-sensitive steps above.
    await step('biology in dark: every block follows the theme', async () => {
      assert.ok(bioId, 'the biology session exists');
      const before = errors.length;
      const inSession = `[data-session="${bioId}"] [data-assistant-message]`;
      await page.click('[data-nav="core.chat:search"]');
      await page.click(`[data-session-row="${bioId}"] button`);
      await page.waitForSelector(`${inSession} [data-seq-map]`, { timeout: 30_000 });
      const theme = ((await invoke('prefs:get')) as { theme?: string }).theme ?? 'system';
      await invoke('prefs:set', { theme: 'dark' });
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
      await page.waitForFunction((s) => document.querySelectorAll(`${s} [data-bioplot] [data-chart="vega"] svg`).length >= 4, inSession, { timeout: 30_000 });
      await page.waitForSelector(`${inSession} [data-pathway] [data-graphviz="svg"] svg`, { timeout: 30_000 });
      await setSize(1280, 1000);
      await page.evaluate(() => { document.documentElement.style.zoom = '0.55'; });
      try {
        await page.locator(`${inSession} [data-widget="Plasmid map"]`).first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
        await page.waitForTimeout(1200);
        await shot('render-bio-dark');
      } finally {
        await page.evaluate(() => { document.documentElement.style.zoom = ''; });
        await setSize(1280, 820);
        await invoke('prefs:set', { theme });
        await page.waitForTimeout(400);
      }
      assert.equal(await page.locator(`${inSession} [data-render-error]`).count(), 0, 'the theme switch broke nothing');
      await newChat();
      assert.deepEqual(errors.slice(before), [], 'no console errors or exceptions');
    });

    await step('the harness home: Location in Settings > Application, scratch and new projects in it, the clean-up age saved, a move', async () => {
      // The app's home (inside its test data folder: HARNESS_DESKTOP_DATA without HARNESS_HOME).
      const home = path.join(data, 'home');
      const until = async (f: () => boolean, what: string, ms = 15_000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await page.waitForTimeout(100); } };
      for (const f of ['data', 'workspaces/default', 'tmp', 'exports', 'plugins', 'logs', 'settings.json', '.harness-home']) assert.ok(fs.existsSync(path.join(home, f)), f);
      assert.ok(fs.readdirSync(path.join(home, 'data', 'sessions')).length > 0, 'the engine keeps its data in the home');
      assert.ok(fs.statSync(path.join(home, 'logs', 'engine.log')).size > 0, 'the engine log');
      // A scratch conversation gets a folder of its own under tmp/.
      const scratch = await invoke('home:scratch') as string;
      assert.ok(scratch.startsWith(path.join(home, 'tmp') + path.sep) && fs.existsSync(scratch), scratch);
      // A new project made in the app lives in the home's workspaces.
      await page.click('[data-nav="core.projects:projects"]');
      await page.click('[data-new-project]');
      await page.fill('[data-new-project-name]', 'Shop API');
      await page.locator('[data-new-project-form] button[type="submit"]').click();
      await until(() => fs.existsSync(path.join(home, 'workspaces', 'shop-api')), 'the project folder');
      assert.ok(((await invoke('prefs:get')) as { projects: { path: string }[] }).projects.some((x) => x.path === path.join(home, 'workspaces', 'shop-api')));
      // Settings > Application > Location: the home, its folders with sizes, the clean-up age.
      await page.keyboard.press('Control+Comma');
      await page.click('[data-settings-section="core.settings:application"]');
      await page.waitForSelector('[data-location] [data-home-path]');
      assert.equal(await page.locator('[data-home-path]').innerText(), home);
      assert.deepEqual(await page.$$eval('[data-home-folder]', (els) => els.map((e) => e.getAttribute('data-home-folder'))), ['data', 'workspaces', 'tmp', 'exports', 'plugins', 'logs']);
      assert.ok(Number(await page.getAttribute('[data-home-folder="data"]', 'data-bytes')) > 0);
      await page.locator('[data-location]').scrollIntoViewIfNeeded();
      await shot('settings-location');
      await page.fill('[data-tmp-days]', '3');
      await page.click('[data-save-tmp-days]');
      await until(() => JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).tmpCleanupDays === 3, 'the clean-up age saved');
      await page.keyboard.press('Escape');
      // Move (the folder picker is the system's; the move goes through the channel its button uses): copied, checked, switched, the engine back.
      const target = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-home-move-')));
      const moved = await invoke('home:move', target) as { moved: { home: string; files: number } };
      assert.equal(moved.moved.home, target);
      await ready();
      assert.ok(fs.existsSync(path.join(target, 'workspaces', 'shop-api')) && fs.existsSync(path.join(target, 'data', 'sessions')));
      assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'home-location'), 'utf8')).home, target, 'the pointer the app reads at its next start');
      assert.ok(((await invoke('prefs:get')) as { projects: { path: string }[] }).projects.some((x) => x.path === path.join(target, 'workspaces', 'shop-api')), 'projects made in the home moved with it');
      await page.waitForSelector('[data-session-row]', { timeout: 30_000 });
      await page.keyboard.press('Control+Comma');
      await page.click('[data-settings-section="core.settings:application"]');
      await page.waitForSelector(`[data-home-path]:has-text("${path.basename(target)}")`);
      // The old copy stays until the person removes it.
      assert.ok(fs.existsSync(home));
      await page.click('[data-remove-old-home]');
      await page.locator('[role="dialog"] button[data-autofocus]', { hasText: 'Remove' }).click();
      await until(() => !fs.existsSync(home), 'the old copy removed');
      await page.waitForSelector('[data-remove-old-home]', { state: 'detached' });
      await page.keyboard.press('Escape');
    });

    // Expected: the refusals the frame probe provokes on purpose, the engine's own crash (requests cut
    // while it is down), and the memory section on an engine without memory. Nothing else, and no exceptions.
    const unexpected = errors.filter((e) => !(
      (/an allowed SDK call works/.test(e.phase) && /Content Security Policy|ERR_FAILED/.test(e.text))
      || (/engine stops/.test(e.phase) && /Failed to load resource/.test(e.text))
      // Adding a folder restarts the engine with the new roots, which cuts the open event streams (they reconnect).
      || (/a session in a folder/.test(e.phase) && /ERR_FAILED \(harness:\/\/app\/api\/(events|sessions\/[^/]+\/events)/.test(e.text))
      || (/\/api\/memory\?/.test(e.text) && /404/.test(e.text))
      // Moving the home restarts the engine, which cuts the open event streams (they reconnect).
      || (/harness home/.test(e.phase) && /ERR_FAILED|Failed to load resource/.test(e.text))
    ));
    assert.deepEqual(unexpected, [], 'no unexpected errors in the window');
    assert.deepEqual(errors.filter((e) => /switched on and off live/.test(e.phase)), [], 'switching plugins logs nothing at all');
  } finally {
    await app.close().catch(() => {});
    try { fs.rmSync(data, { recursive: true, force: true, maxRetries: 3 }); fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 }); } catch { /* in use (Windows) */ }
  }
});
