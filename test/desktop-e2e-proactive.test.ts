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
    let scratch = '';
    const rowText = (id: string) => page.locator(`[data-schedule="${id}"]`).innerText();
    const lastIs = (id: string, re: string) => page.waitForFunction(([i, r]) => new RegExp(r).test(document.querySelector(`[data-schedule="${i}"] [data-schedule-last]`)?.textContent ?? ''), [id, re] as const, { timeout: 20_000 });
    const runAndWait = async (id: string, re: string) => { await page.click(`[data-schedule="${id}"] button[aria-label="Run now"]`); await lastIs(id, re); };
    // Its runs (Run now opens them already).
    const openRuns = async (id: string) => { if (!(await page.locator(`[data-schedule="${id}"] [data-runs], [data-schedule="${id}"] [data-runs-empty]`).count())) await page.click(`[data-schedule="${id}"] [data-schedule-toggle]`); };

    await step('phase 0: a schedule made in Settings runs in a new conversation in its folder, unattended; the tray note says it stops with the window', async () => {
      await openSettings('core.settings:schedules');
      await page.waitForSelector('[data-section="schedules"] [data-schedule-manager]');
      assert.equal(await page.locator('[data-schedules-tray-note]').count(), 0, 'no note while nothing is scheduled');
      await page.click('[data-section="schedules"] [data-schedule-new]');
      await page.waitForSelector('[data-schedule-form="new"]');
      await page.fill('[data-schedule-title]', 'Build check');
      await page.fill('[data-schedule-prompt]', 'Check the build and notify me.');
      await page.fill('[data-schedule-minutes]', '30');
      await page.locator('[data-schedule-model]').selectOption('deepseek-flash');
      await shot('schedules-form', page.locator('[role="dialog"]').last());
      await page.click('[data-schedule-create]');
      await page.waitForSelector('[data-schedule-form="new"]', { state: 'detached' });
      await page.waitForSelector('[data-section="schedules"] [data-schedule]', { timeout: 15_000 });
      schedId = (await page.getAttribute('[data-section="schedules"] [data-schedule]', 'data-schedule'))!;
      const made = (await api('GET', '/api/schedules')).body as Array<{ id: string; title: string; newSession?: { model: string; mode: string; runtime: { kind: string; path?: string } } }>;
      const s = made.find((x) => x.id === schedId)!;
      assert.equal(s.title, 'Build check');
      assert.equal(s.newSession?.model, 'deepseek-flash');
      assert.equal(s.newSession?.mode, 'dontAsk');
      assert.equal(s.newSession?.runtime.kind, 'local');
      scratch = s.newSession!.runtime.path!;
      assert.ok(scratch && fs.existsSync(scratch), 'a real scratch folder');
      await page.waitForSelector('[data-schedules-tray-note]');
    });

    await step('phase 0: running it now starts the conversation; what the agent tells the person arrives as a toast; the row says the run completed', async () => {
      await page.click(`[data-schedule="${schedId}"] button[aria-label="Run now"]`);
      await toastWith('The build is green.');
      const sessions = (await api('GET', '/api/sessions')).body as Array<{ id: string; title: string; mode: string }>;
      const run = sessions.find((x) => x.title === 'Scheduled: Build check');
      assert.ok(run, 'a conversation for the run');
      assert.equal(run!.mode, 'dontAsk');
      await lastIs(schedId, '^completed$');
      await toastWith('Build check: Checked the build and told you: it is green.');
    });

    await step('phase 0: the same conversation each time: the run goes into the chosen conversation', async () => {
      const target = (await api('POST', '/api/sessions', { title: 'Release notes', model: 'deepseek-flash', runtime: 'local' })).body as { id: string };
      assert.ok(target.id, JSON.stringify(target));
      await page.click('[data-section="schedules"] [data-schedule-new]');
      await page.waitForSelector('[data-schedule-form="new"]');
      await page.locator('[data-schedule-target]').selectOption('existing');
      await page.waitForSelector(`[data-schedule-session] option[value="${target.id}"]`, { state: 'attached', timeout: 15_000 });
      await page.fill('[data-schedule-title]', 'Into release notes');
      await page.fill('[data-schedule-prompt]', 'Add today to the notes.');
      await page.fill('[data-schedule-minutes]', '60');
      await page.locator('[data-schedule-session]').selectOption(target.id);
      await page.click('[data-schedule-create]');
      await page.waitForFunction(() => document.querySelectorAll('[data-section="schedules"] [data-schedule]').length === 2, null, { timeout: 15_000 });
      const list = (await api('GET', '/api/schedules')).body as Array<{ id: string; title: string; sessionId?: string }>;
      const into = list.find((x) => x.title === 'Into release notes')!;
      assert.equal(into.sessionId, target.id);
      await runAndWait(into.id, '^completed');
      assert.match(await history(target.id), /Add today to the notes\./);
    });

    await step('phase 0: keeping the app in the tray removes the note', async () => {
      await page.click('[data-section="schedules"] button:has-text("Keep running in the tray")');
      await page.waitForSelector('[data-schedules-tray-note]', { state: 'detached' });
      assert.equal(((await invoke('prefs:get')) as { keepInTray: boolean }).keepInTray, true);
      // Then: they would still stop when the computer restarts, unless the app starts at login.
      await page.click('[data-schedules-login-note] button:has-text("Start the app at login")');
      await page.waitForSelector('[data-schedules-login-note]', { state: 'detached' });
      assert.equal(((await invoke('prefs:get')) as { startAtLogin: boolean }).startAtLogin, true);
      await invoke('prefs:set', { startAtLogin: false });
      await invoke('app:setLoginItem', false).catch(() => {});
      await page.keyboard.press('Escape');
      await page.waitForSelector('[data-settings]', { state: 'detached' });
    });

    await step('phase 1: the Scheduled page lists every schedule; a run\'s record shows how it ended, what it said, that it told the person, and opens its conversation', async () => {
      await page.click('[data-nav="core.scheduled:scheduled"]');
      await page.waitForSelector('[data-scheduled] [data-schedule-list]');
      assert.equal(await page.locator('[data-scheduled] [data-schedule]').count(), 2);
      await page.click(`[data-schedule="${schedId}"] [data-schedule-toggle]`);
      const row = page.locator(`[data-runs="${schedId}"] [data-run]`).first();
      await row.waitFor();
      assert.equal(await row.getAttribute('data-run-status'), 'completed');
      const text = await row.innerText();
      assert.match(text, /Completed/);
      assert.match(text, /Checked the build and told you: it is green\./);
      assert.match(text, /told you/);
      assert.match(text, /run now/);
      await shot('scheduled-page');
      const runs = (await api('GET', `/api/schedules/${schedId}/runs`)).body as Array<{ sessionId: string; costUsd: number; tools: number; notified: boolean }>;
      assert.equal(runs.length, 1);
      assert.equal(runs[0]!.tools, 1);
      assert.equal(runs[0]!.notified, true);
      await row.locator('button[aria-label="Open its conversation"]').click();
      await page.waitForSelector(`[data-session="${runs[0]!.sessionId}"]`);
    });

    await step('phase 1: editing a schedule: a cron in a time zone and a spend limit; the next run is computed in that zone', async () => {
      await page.click('[data-nav="core.scheduled:scheduled"]');
      await page.click(`[data-schedule="${schedId}"] button[aria-label="Edit"]`);
      await page.waitForSelector('[data-schedule-form="edit"]');
      assert.equal(await page.inputValue('[data-schedule-title]'), 'Build check');
      await page.fill('[data-schedule-cron]', '0 9 * * 1-5');
      await page.fill('[data-schedule-tz]', 'Asia/Tokyo');
      await page.locator('[data-schedule-misfire]').selectOption('skip');
      await page.fill('[data-schedule-cost]', '0.5');
      await page.click('[data-schedule-create]');
      await page.waitForSelector('[data-schedule-form="edit"]', { state: 'detached' });
      await page.waitForFunction((id) => /0 9 \* \* 1-5 \(Asia\/Tokyo\)/.test(document.querySelector(`[data-schedule="${id}"] [data-schedule-when]`)?.textContent ?? ''), schedId);
      assert.match(await rowText(schedId), /at most \$0\.50 a run/);
      const s = (await api('GET', `/api/schedules/${schedId}`)).body as { cron: string; timeZone: string; misfire: string; maxCostUsd: number; nextRun: number; enabled: boolean };
      assert.deepEqual([s.cron, s.timeZone, s.misfire, s.maxCostUsd, s.enabled], ['0 9 * * 1-5', 'Asia/Tokyo', 'skip', 0.5, true]);
      const next = new Date(s.nextRun);
      assert.equal(`${next.getUTCHours()}:${next.getUTCMinutes()}`, '0:0', '9:00 in Tokyo is midnight UTC');
      assert.ok([1, 2, 3, 4, 5].includes(new Date(s.nextRun + 9 * 3600_000).getUTCDay()), 'a weekday in Tokyo');
    });

    await step('phase 1: a schedule that would run every minute is refused, and says why', async () => {
      await page.click('[data-scheduled] [data-schedule-new]');
      await page.waitForSelector('[data-schedule-form="new"]');
      await page.fill('[data-schedule-prompt]', 'too often');
      await page.fill('[data-schedule-cron]', '* * * * *');
      await page.click('[data-schedule-create]');
      await page.waitForSelector('[data-schedule-form="new"] [data-schedule-error]');
      assert.match(await page.locator('[data-schedule-error]').innerText(), /a schedule may run at most every 5 minutes/);
      // Said in the form, not in a toast that would stay and cover other dialogs.
      assert.equal(await page.locator('[data-toast="error"]').count(), 0);
      assert.equal(await page.locator('[data-schedule-form="new"]').count(), 1, 'the form stays open to fix it');
      await page.keyboard.press('Escape');
      await page.waitForSelector('[data-schedule-form="new"]', { state: 'detached' });
      assert.equal(((await api('GET', '/api/schedules')).body as unknown[]).length, 2);
      // Opened again, the form starts without the old error.
      await page.click('[data-scheduled] [data-schedule-new]');
      await page.waitForSelector('[data-schedule-form="new"]');
      assert.equal(await page.locator('[data-schedule-error]').count(), 0);
      await page.keyboard.press('Escape');
    });

    await step('phase 1: a run that finds nothing is marked so and stays quiet; a run over its spend limit stops and says so', async () => {
      const quiet = (await api('POST', '/api/schedules', { title: 'Quiet check', prompt: 'quiet please', inMinutes: 60, newSession: { model: 'deepseek-flash', runtime: 'local', path: scratch, mode: 'dontAsk' } })).body as { id: string };
      const costly = (await api('POST', '/api/schedules', { title: 'Costly job', prompt: 'costly work', inMinutes: 60, maxCostUsd: 0.01, newSession: { model: 'deepseek-flash', runtime: 'local', path: scratch, mode: 'dontAsk' } })).body as { id: string };
      await page.waitForSelector(`[data-schedule="${quiet.id}"]`);
      await runAndWait(quiet.id, 'nothing to report');
      await openRuns(quiet.id);
      await page.waitForSelector(`[data-runs="${quiet.id}"] [data-run]`);
      assert.match(await page.locator(`[data-runs="${quiet.id}"] [data-run]`).innerText(), /Nothing to report[\s\S]*All quiet\./);
      await runAndWait(costly.id, '^Stopped: this scheduled run');
      await toastWith('Stopped: this scheduled run reached its spend limit of $0.01');
      await openRuns(costly.id);
      const c = page.locator(`[data-runs="${costly.id}"] [data-run]`);
      await c.waitFor();
      assert.equal(await c.getAttribute('data-run-status'), 'stopped');
      assert.match(await c.innerText(), /spend limit of \$0\.01/);
      const toasts = await page.$$eval('[data-toast]', (els) => els.map((e) => e.textContent ?? ''));
      assert.ok(!toasts.some((t) => t.includes('All quiet')), 'nothing to report: no toast');
      assert.equal(toasts.filter((t) => t.includes('spend limit of $0.01')).length, 1, 'one warning for the stopped run, not two');
      await shot('scheduled-runs');
    });

    await step('phase 1: Activity lists the latest scheduled runs across schedules', async () => {
      await page.click('[data-nav="core.activity:activity"]');
      await page.waitForSelector('[data-activity] [data-recent-runs] [data-run]');
      const rows = await page.$$eval('[data-recent-runs] [data-run]', (els) => els.map((e) => [e.getAttribute('data-run-status') ?? '', e.textContent ?? ''] as const));
      assert.equal(rows.length, 4);
      assert.match(rows[0]![1], /Costly job/, 'newest first');
      assert.deepEqual(rows.map((r) => r[0]), ['stopped', 'completed', 'completed', 'completed']);
    });

    const update = (sel: string) => page.locator(`[data-inbox-updates] [data-update]${sel}`);
    const updateWith = (text: string) => page.locator('[data-inbox-updates] [data-update]', { hasText: text });
    const inboxApi = async (view = 'open') => ((await api('GET', `/api/inbox?view=${view}`)).body as { items: Array<{ id: string; kind: string; title: string; body: string; level: string; status: string; reason?: string; snoozedUntil?: number }>; unread: number });

    await step('phase 2: the Inbox has the updates unattended work left: what the agent told you, each run that found something (a stopped one as a warning), not the one that found nothing; the sidebar counts the new ones', async () => {
      await page.click('[data-nav="core.inbox:inbox"]');
      await page.waitForSelector('[data-inbox] [data-inbox-updates] [data-update]');
      const box = await inboxApi();
      const titles = box.items.map((i) => `${i.kind}:${i.title}`);
      assert.ok(titles.includes('message:Scheduled: Build check'), titles.join(', '));
      assert.ok(titles.includes('result:Into release notes') && titles.includes('result:Costly job'), titles.join(', '));
      assert.ok(!titles.includes('result:Build check'), 'that run told the person already: its result is not a second update');
      assert.ok(!titles.some((t) => t.includes('Quiet check')), 'nothing to report: no update');
      assert.equal(box.items.find((i) => i.title === 'Costly job')!.level, 'warn');
      assert.equal(await updateWith('The build is green.').count(), 1);
      assert.equal(await page.locator('[data-inbox-updates] [data-update][data-update-status="new"]').count(), box.unread);
      assert.equal(await page.locator('[data-badge="core.inbox.badge"]').first().innerText(), String(box.unread), 'the sidebar counts the new updates');
      assert.equal(await page.locator('[data-inbox-nothing-waiting]').count(), 1, 'nothing waiting for an answer');
      await shot('inbox-updates');
    });

    await step('phase 2: an update is read and unread again, snoozed out of sight, dismissed with a reason; the reason is kept', async () => {
      const msg = updateWith('The build is green.');
      await msg.locator('[data-update-read]').click();
      await page.waitForFunction(() => document.querySelector('[data-inbox-updates] [data-update][data-update-kind="message"]')?.getAttribute('data-update-status') === 'read');
      await msg.locator('[data-update-unread]').click();
      await page.waitForFunction(() => document.querySelector('[data-inbox-updates] [data-update][data-update-kind="message"]')?.getAttribute('data-update-status') === 'new');
      const release = updateWith('Into release notes');
      await release.locator('[data-update-snooze]').click();
      await page.click('[role="menuitem"]:has-text("For an hour")');
      await updateWith('Into release notes').waitFor({ state: 'detached' });
      const snoozed = (await inboxApi('all')).items.find((i) => i.title === 'Into release notes')!;
      assert.ok(snoozed.snoozedUntil! > Date.now() + 50 * 60_000, 'about an hour');
      await updateWith('Costly job').locator('[data-update-dismiss]').click();
      await page.click('[role="menuitem"]:has-text("Not useful")');
      await updateWith('Costly job').waitFor({ state: 'detached' });
      const gone = (await inboxApi('all')).items.find((i) => i.title === 'Costly job')!;
      assert.deepEqual([gone.status, gone.reason], ['dismissed', 'not_useful']);
    });

    await step('phase 2: work an agent offered during a scheduled run is a suggestion in the Inbox; Start opens it as a conversation and the suggestion is done', async () => {
      const made = (await api('POST', '/api/schedules', { title: 'Repo triage', prompt: 'offer what to fix', inMinutes: 60, newSession: { model: 'deepseek-flash', runtime: 'local', path: scratch, mode: 'bypass' } })).body as { id: string };
      assert.equal((await api('POST', `/api/schedules/${made.id}/run`)).status, 200);
      const sug = update('[data-update-kind="suggestion"]');
      await sug.waitFor({ timeout: 20_000 });
      assert.match(await sug.innerText(), /Fix the flaky test[\s\S]*Fix the flaky test in parser\.test\.ts\./);
      await shot('inbox-suggestion', sug);
      await sug.locator('[data-update-start]').click();
      await page.waitForSelector('[data-session]');
      const child = (await page.getAttribute('[data-session]', 'data-session'))!;
      const sessions = (await api('GET', '/api/sessions')).body as Array<{ id: string; title: string; parent?: string }>;
      assert.equal(sessions.find((x) => x.id === child)!.title, 'Fix the flaky test');
      const done = (await inboxApi('all')).items.find((i) => i.kind === 'suggestion')!;
      assert.equal(done.status, 'done');
    });

    await step('phase 2: a schedule that asks in the Inbox: its run waits for approval there (not refused), goes on when approved, and its record says it asked', async () => {
      await page.click('[data-nav="core.scheduled:scheduled"]');
      await page.click('[data-scheduled] [data-schedule-new]');
      await page.waitForSelector('[data-schedule-form="new"]');
      await page.fill('[data-schedule-title]', 'Nightly deploy');
      await page.fill('[data-schedule-prompt]', 'deploy the site');
      await page.fill('[data-schedule-cron]', '0 2 * * *');
      await page.locator('[data-schedule-asks]').selectOption('acceptEdits');
      await page.fill('[data-schedule-wait]', '2');
      await shot('schedules-form-asks', page.locator('[role="dialog"]').last());
      const btn = page.locator('[data-schedule-create]');
      assert.equal(await btn.isDisabled(), false, `the form is ready: ${JSON.stringify(await btn.boundingBox())}`);
      await btn.click();
      await page.waitForSelector('[data-schedule-form="new"]', { state: 'detached' });
      const s = ((await api('GET', '/api/schedules')).body as Array<{ id: string; title: string; askTimeoutMinutes?: number; newSession?: { mode: string } }>).find((x) => x.title === 'Nightly deploy')!;
      assert.deepEqual([s.askTimeoutMinutes, s.newSession?.mode], [120, 'acceptEdits']);
      await page.click(`[data-schedule="${s.id}"] button[aria-label="Run now"]`);
      await page.click('[data-nav="core.inbox:inbox"]');
      const card = await page.waitForSelector('[data-inbox] [data-pending="permission_request"]', { timeout: 20_000 });
      assert.match(await card.innerText(), /node -e/);
      await shot('inbox-scheduled-approval');
      const running = ((await api('GET', `/api/schedules/${s.id}/runs`)).body as Array<{ status: string }>)[0]!;
      assert.equal(running.status, 'running', 'it waits, it is not refused');
      await (await card.$('[data-decision="allow"]'))!.click();
      await page.waitForSelector('[data-inbox] [data-pending]', { state: 'detached', timeout: 15_000 });
      const end = Date.now() + 20_000;
      let run: { status: string; waited?: number; summary?: string } = running;
      while (run.status === 'running' && Date.now() < end) { await page.waitForTimeout(300); run = ((await api('GET', `/api/schedules/${s.id}/runs`)).body as typeof run[])[0]!; }
      assert.deepEqual([run.status, run.waited, run.summary], ['completed', 1, 'Deployed: the command printed 42.']);
      await page.click('[data-nav="core.scheduled:scheduled"]');
      await page.click(`[data-schedule="${s.id}"] [data-schedule-toggle]`);
      await page.waitForSelector(`[data-runs="${s.id}"] [data-run-waited]`);
      assert.match(await page.locator(`[data-runs="${s.id}"] [data-run]`).first().innerText(), /asked you once/);
    });

    await step('phase 2: Mark all read clears the new count; the sidebar badge follows', async () => {
      await page.click('[data-nav="core.inbox:inbox"]');
      await page.waitForSelector('[data-inbox-updates] [data-updates-read-all]');
      await page.click('[data-inbox-updates] [data-updates-read-all]');
      await page.waitForFunction(() => !document.querySelector('[data-inbox-updates] [data-update][data-update-status="new"]'));
      assert.equal((await inboxApi()).unread, 0);
      await page.waitForFunction(() => { const b = document.querySelector('[data-badge="core.inbox.badge"]'); return !b || (b.textContent ?? '').trim() === '' || (b.textContent ?? '').trim() === '0'; });
    });

    await step('no errors in the window', async () => {
      // The refusal of the every-minute schedule is a 400 the window shows as a toast (Chromium logs it too).
      assert.deepEqual(errors.filter((e) => !(e.phase.includes('every minute is refused') && /status of 400 .*\/api\/schedules\)/.test(e.text))), []);
    });
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(data, { recursive: true, force: true });
  }
});
