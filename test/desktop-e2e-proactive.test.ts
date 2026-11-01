// Harness Desktop end to end, proactive work: schedules made in the app (each target), their runs, what a
// scheduled agent tells the person, the tray note, and (later phases) run records, the inbox and watches.
// The real Electron app against a scripted engine (test/fixtures/desktop/proactive-engine.ts: nothing is
// spent), driven with playwright-core. Skipped when Electron cannot start here.
//
// HARNESS_DESKTOP_SCREENSHOTS=1 also writes the screenshots in docs/screenshots/desktop/.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertNotBlank, capture } from './fixtures/desktop/png.ts';
import { fileURLToPath } from 'node:url';

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
function ensureBuilt(): string | null {
  const out = path.join(desktop, 'dist', 'renderer', 'index.html');
  const src = Math.max(newest(path.join(desktop, 'electron')), newest(path.join(desktop, 'renderer')), newest(path.join(desktop, 'shared')), newest(path.join(root, 'packages')));
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= src) return null;
  const r = spawnSync(process.execPath, [path.join(desktop, 'scripts', 'build.mjs')], { cwd: root, stdio: 'pipe', encoding: 'utf8', timeout: 600_000 });
  return r.status === 0 ? null : `build failed: ${(r.stderr || r.stdout).slice(-800)}`;
}

test('desktop app end to end: proactive work', { timeout: 10 * 60_000 }, async (t) => {
  if (!fs.existsSync(electronExe)) { t.skip('Electron is not installed'); return; }
  let pw: typeof import('playwright-core');
  try { pw = await import('playwright-core'); } catch { t.skip('playwright-core is not installed'); return; }
  const failed = ensureBuilt();
  if (failed) assert.fail(failed);

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-e2e-pro-'));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_API_KEY$|^GW_|^HARNESS_/.test(k)) env[k] = v;
  Object.assign(env, { HARNESS_DESKTOP_DATA: data, HARNESS_DESKTOP_TEST: '1', ...(process.env.HARNESS_E2E_SHOW ? { HARNESS_E2E_SHOW: process.env.HARNESS_E2E_SHOW } : {}), HARNESS_DESKTOP_ENGINE: path.join(root, 'test', 'fixtures', 'desktop', 'proactive-engine.ts'), HARNESS_DESKTOP_NO_TRAY: '1', HARNESS_PLUGIN_LOOPS: 'off' });
  let app: import('playwright-core').ElectronApplication;
  try { app = await pw._electron.launch({ executablePath: electronExe, args: [desktop], env, timeout: 60_000 }); } catch (e) { t.skip(`Electron could not start here: ${(e as Error).message.split('\n')[0]}`); return; }
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const page = await app.firstWindow();
  let phase = 'start';
  const errors: Array<{ phase: string; text: string }> = [];
  page.on('pageerror', (e) => errors.push({ phase, text: `exception: ${e.message}` }));
  page.on('console', (m) => { const where = m.location().url ?? ''; if (m.type() === 'error' && !/\/plugins\/|^harness:\/\/preview|^about:srcdoc/.test(where)) errors.push({ phase, text: `console: ${m.text()} (${where})` }); });
  const shot = async (name: string, el?: import('playwright-core').Locator) => { if (!SHOTS) return; await page.waitForTimeout(300); const png = await capture(app, el); assertNotBlank(png, name); fs.writeFileSync(path.join(SHOTS, `${name}.png`), png); };
  const setSize = (w: number, h: number) => app.evaluate(({ BrowserWindow }, s) => { const win = BrowserWindow.getAllWindows()[0]!; if (win.isMaximized()) win.unmaximize(); win.setSize(s.w, s.h); }, { w, h });
  const invoke = (channel: string, ...args: unknown[]) => page.evaluate(([c, a]) => (window as unknown as { harnessDesktop: { invoke: (c: string, ...x: unknown[]) => Promise<unknown> } }).harnessDesktop.invoke(c as string, ...(a as unknown[])), [channel, args] as const);
  const api = (method: string, p: string, body?: unknown) => page.evaluate(async ([m, u, b]) => { const r = await fetch(u as string, { method: m as string, headers: { 'content-type': 'application/json', 'x-harness': '1' }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) }; }, [method, p, body] as const);
  const ready = () => page.waitForSelector('[data-engine-status="ready"]', { timeout: 90_000 });
  const newChat = async () => { await page.click('[data-nav="core.chat:new"]'); await page.waitForSelector('[data-home]'); };
  const send = async (text: string) => { const box = page.locator('[data-composer-input]').first(); await box.fill(text); await box.press('Enter'); };
  const startChat = async (text: string) => { await newChat(); await send(text); await page.waitForSelector('[data-session]', { timeout: 20_000 }); return (await page.getAttribute('[data-session]', 'data-session'))!; };
  const idle = (id: string) => page.waitForSelector(`[data-session="${id}"][data-status="idle"]`, { timeout: 45_000 });
  const openPanel = async (qid: string) => { if (!(await page.locator('[data-side-panel] [data-agents-panel]').count())) await page.click(`[data-panel-toggle="${qid}"]`); };
  await setSize(1360, 860);
  const step = (name: string, fn: () => Promise<void>) => t.test(name, async () => {
    phase = name;
    try { await fn(); } catch (e) {
      await capture(app).then((png) => fs.writeFileSync(path.join(os.tmpdir(), `hd-e2e-pro-fail-${name.slice(0, 40).replace(/[^a-z0-9]+/gi, '-')}.png`), png)).catch(() => {});
      for (let i = 0; i < 3; i++) await page.keyboard.press('Escape').catch(() => {});
      throw e;
    }
  });

  const openSettings = async (section: string) => {
    if (!(await page.locator('[data-settings]').count())) await page.keyboard.press('Control+Comma');
    await page.waitForSelector('[data-settings]');
    await page.click(`[data-settings-section="${section}"]`);
  };
  const toastWith = (text: string) => page.waitForFunction((x) => [...document.querySelectorAll('[data-toast]')].some((e) => (e.textContent ?? '').includes(x)), text, { timeout: 30_000 });
  const history = async (id: string) => JSON.stringify(((await api('GET', `/api/sessions/${id}`)).body as { history?: unknown[] }).history ?? []);

  try {
    await step('the app starts', async () => {
      await ready();
      await page.waitForSelector('[data-home]');
      await invoke('prefs:set', { defaultModel: 'deepseek-flash', onboardingDone: true, keepInTray: false });
    });

    let schedId = '';
    await step('phase 0: a schedule made in Settings runs in a new conversation in its folder, unattended; the tray note says it stops with the window', async () => {
      await openSettings('core.settings:schedules');
      await page.waitForSelector('[data-section="schedules"] [data-schedule-form]');
      assert.equal(await page.locator('[data-schedules-tray-note]').count(), 0, 'no note while nothing is scheduled');
      await page.fill('[data-schedule-form] input >> nth=0', 'Build check');
      await page.fill('[data-schedule-prompt]', 'Check the build and notify me.');
      await page.fill('[data-schedule-minutes]', '30');
      await page.locator('[data-schedule-model]').selectOption('deepseek-flash');
      await page.click('[data-schedule-create]');
      await page.waitForSelector('[data-section="schedules"] [data-schedule]', { timeout: 15_000 });
      schedId = (await page.getAttribute('[data-section="schedules"] [data-schedule]', 'data-schedule'))!;
      const made = (await api('GET', '/api/schedules')).body as Array<{ id: string; title: string; newSession?: { model: string; mode: string; runtime: { kind: string; path?: string } } }>;
      const s = made.find((x) => x.id === schedId)!;
      assert.equal(s.title, 'Build check');
      assert.equal(s.newSession?.model, 'deepseek-flash');
      assert.equal(s.newSession?.mode, 'dontAsk');
      assert.equal(s.newSession?.runtime.kind, 'local');
      assert.ok(s.newSession?.runtime.path && fs.existsSync(s.newSession.runtime.path), 'a real scratch folder');
      await page.waitForSelector('[data-schedules-tray-note]');
      await shot('schedules-form');
    });

    await step('phase 0: running it now starts the conversation; what the agent tells the person arrives as a toast', async () => {
      await page.click(`[data-schedule="${schedId}"] button[aria-label="Run now"]`);
      await toastWith('The build is green.');
      const sessions = (await api('GET', '/api/sessions')).body as Array<{ id: string; title: string; mode: string }>;
      const run = sessions.find((x) => x.title === 'Scheduled: Build check');
      assert.ok(run, 'a conversation for the run');
      assert.equal(run!.mode, 'dontAsk');
      await page.waitForFunction((id) => (document.querySelector(`[data-schedule="${id}"]`)?.textContent ?? '').includes('last: started'), schedId, { timeout: 15_000 });
    });

    await step('phase 0: the same conversation each time: the run goes into the chosen conversation', async () => {
      const target = (await api('POST', '/api/sessions', { title: 'Release notes', model: 'deepseek-flash', runtime: 'local' })).body as { id: string };
      assert.ok(target.id, JSON.stringify(target));
      await page.locator('[data-schedule-target]').selectOption('existing');
      await page.waitForSelector(`[data-schedule-session] option[value="${target.id}"]`, { state: 'attached', timeout: 15_000 });
      await page.fill('[data-schedule-form] input >> nth=0', 'Into release notes');
      await page.fill('[data-schedule-prompt]', 'Add today to the notes.');
      await page.fill('[data-schedule-minutes]', '60');
      await page.locator('[data-schedule-session]').selectOption(target.id);
      await page.click('[data-schedule-create]');
      await page.waitForFunction(() => document.querySelectorAll('[data-section="schedules"] [data-schedule]').length === 2, null, { timeout: 15_000 });
      const list = (await api('GET', '/api/schedules')).body as Array<{ id: string; title: string; sessionId?: string }>;
      const into = list.find((x) => x.title === 'Into release notes')!;
      assert.equal(into.sessionId, target.id);
      await page.click(`[data-schedule="${into.id}"] button[aria-label="Run now"]`);
      const end = Date.now() + 20_000;
      while (!(await history(target.id)).includes('Add today to the notes.')) { assert.ok(Date.now() < end, 'the run reached the conversation'); await page.waitForTimeout(300); }
    });

    await step('phase 0: keeping the app in the tray removes the note', async () => {
      await page.click('[data-section="schedules"] button:has-text("Keep running in the tray")');
      await page.waitForSelector('[data-schedules-tray-note]', { state: 'detached' });
      assert.equal(((await invoke('prefs:get')) as { keepInTray: boolean }).keepInTray, true);
    });

    await step('no errors in the window', async () => {
      assert.deepEqual(errors, []);
    });
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(data, { recursive: true, force: true });
  }
});
