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
    // The schedule's last result, in full (the row shows it as an icon and a word; its title has the whole).
    const lastIs = (id: string, re: string) => page.waitForFunction(([i, r]) => new RegExp(r).test(document.querySelector(`[data-schedule="${i}"] [data-schedule-last]`)?.getAttribute('title') ?? ''), [id, re] as const, { timeout: 20_000 });
    const runAndWait = async (id: string, re: string) => { await page.click(`[data-schedule="${id}"] button[aria-label="Run now"]`); await lastIs(id, re); };
    const openRuns = async (id: string) => { if (!(await page.locator(`[data-schedule="${id}"] [data-runs], [data-schedule="${id}"] [data-runs-empty]`).count())) await page.click(`[data-schedule="${id}"] [data-schedule-toggle]`); };
    const freq = (f: string) => page.click(`[data-schedule-form] [data-choice="freq"] [data-value="${f}"]`);
    const words = () => page.locator('[data-schedule-form] [data-when-words]').innerText();
    const created = () => page.waitForSelector('[data-schedule-form]', { state: 'detached', timeout: 15_000 });
    const scheduleNamed = async (title: string): Promise<{ id: string } & Record<string, unknown>> => ((await api('GET', '/api/schedules')).body as Array<{ id: string; title: string }>).find((x) => x.title === title)!;

    await step('phase 0: a schedule made in Settings runs in a new conversation in its folder, unattended; the tray note says it stops with the window', async () => {
      await openSettings('core.settings:schedules');
      await page.waitForSelector('[data-section="schedules"] [data-schedule-manager]');
      assert.equal(await page.locator('[data-schedules-tray-note]').count(), 0, 'no note while nothing is scheduled');
      await page.click('[data-section="schedules"] [data-schedule-new]');
      await page.waitForSelector('[data-schedule-form="new"]');
      // Nothing filled in yet: the button says what is still needed.
      assert.match(await page.locator('[data-schedule-missing]').innerText(), /what it should do/);
      await page.fill('[data-schedule-title]', 'Build check');
      await page.fill('[data-schedule-prompt]', 'Check the build and notify me.');
      await freq('once');
      await page.fill('[data-when-in]', '30');
      await page.waitForFunction(() => /^Once, /.test(document.querySelector('[data-when-words]')?.textContent ?? ''));
      await page.locator('[data-schedule-model]').selectOption('deepseek-flash');
      await page.click('[data-schedule-create]');
      await created();
      await page.waitForSelector('[data-section="schedules"] [data-schedule]', { timeout: 15_000 });
      schedId = (await page.getAttribute('[data-section="schedules"] [data-schedule]', 'data-schedule'))!;
      const made = (await api('GET', '/api/schedules')).body as Array<{ id: string; title: string; newSession?: { model: string; mode: string; runtime: { kind: string; path?: string } } }>;
      const s = made.find((x) => x.id === schedId)!;
      assert.equal(s.title, 'Build check');
      assert.equal(s.newSession?.model, 'deepseek-flash');
      assert.equal(s.newSession?.mode, 'auto', 'a checker decides, the rest waits for you: the default');
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
      assert.equal(run!.mode, 'auto');
      await lastIs(schedId, '^completed$');
    });

    await step('phase 0: the same conversation each time: the run goes into the chosen conversation', async () => {
      const target = (await api('POST', '/api/sessions', { title: 'Release notes', model: 'deepseek-flash', runtime: 'local' })).body as { id: string };
      assert.ok(target.id, JSON.stringify(target));
      await page.click('[data-section="schedules"] [data-schedule-new]');
      await page.waitForSelector('[data-schedule-form="new"]');
      await page.click('[data-choice="target"] [data-value="existing"]');
      await page.waitForSelector(`[data-schedule-session] option[value="${target.id}"]`, { state: 'attached', timeout: 15_000 });
      await page.fill('[data-schedule-title]', 'Into release notes');
      await page.fill('[data-schedule-prompt]', 'Add today to the notes.');
      await freq('once');
      await page.fill('[data-when-in]', '1');
      await page.locator('[data-when-unit]').selectOption('hours');
      await page.locator('[data-schedule-session]').selectOption(target.id);
      assert.equal(await page.locator('[data-schedule-asks]').count(), 0, 'its conversation\'s own mode applies');
      await page.click('[data-schedule-create]');
      await created();
      await page.waitForFunction(() => document.querySelectorAll('[data-section="schedules"] [data-schedule]').length === 2, null, { timeout: 15_000 });
      const into = await scheduleNamed('Into release notes') as unknown as { id: string; sessionId?: string; nextRun: number };
      assert.equal(into.sessionId, target.id);
      assert.ok(Math.abs(into.nextRun - (Date.now() + 3600_000)) < 120_000, 'in an hour');
      await runAndWait(into.id, '^completed');
      assert.match(await history(target.id), /Add today to the notes\./);
    });

    await step('phase 0: keeping the app in the tray removes the note', async () => {
      await page.click('[data-section="schedules"] button:has-text("Keep running in the tray")');
      await page.waitForSelector('[data-schedules-tray-note]', { state: 'detached' });
      assert.equal(((await invoke('prefs:get')) as { keepInTray: boolean }).keepInTray, true);
      await page.click('[data-schedules-login-note] button:has-text("Start the app at login")');
      await page.waitForSelector('[data-schedules-login-note]', { state: 'detached' });
      assert.equal(((await invoke('prefs:get')) as { startAtLogin: boolean }).startAtLogin, true);
      await invoke('prefs:set', { startAtLogin: false });
      await page.keyboard.press('Escape');
      await page.waitForSelector('[data-settings]', { state: 'detached' });
    });

    await step('phase 1: the Scheduled page lists every schedule in plain words; a run\'s record shows how it ended, what it said, that it told the person, and opens its conversation', async () => {
      await page.click('[data-nav="core.scheduled:scheduled"]');
      await page.waitForSelector('[data-scheduled] [data-schedule-list]');
      assert.equal(await page.locator('[data-scheduled] [data-schedule]').count(), 2);
      assert.match(await page.locator(`[data-schedule="${schedId}"] [data-schedule-when]`).innerText(), /^Once, (?!\d{4}-\d\d-\d\dT)/, 'on the computer clock, not an ISO time');
      await openRuns(schedId);
      const row = page.locator(`[data-runs="${schedId}"] [data-run]`).first();
      await row.waitFor();
      assert.equal(await row.getAttribute('data-run-status'), 'completed');
      const text = await row.innerText();
      assert.match(text, /Completed[\s\S]*Checked the build and told you: it is green\./);
      assert.match(text, /told you/);
      assert.match(text, /run now/);
      await shot('scheduled-page');
      const runs = (await api('GET', `/api/schedules/${schedId}/runs`)).body as Array<{ sessionId: string; tools: number; notified: boolean }>;
      assert.equal(runs.length, 1);
      assert.equal(runs[0]!.tools, 1);
      assert.equal(runs[0]!.notified, true);
      await row.locator('button[aria-label="Open its conversation"]').click();
      await page.waitForSelector(`[data-session="${runs[0]!.sessionId}"]`);
    });

    await step('phase 1: editing a schedule: weekdays at 9 in a time zone with a spend limit; the dialog shows it in words and its next runs; the next run is computed in that zone', async () => {
      await page.click('[data-nav="core.scheduled:scheduled"]');
      await page.click(`[data-schedule="${schedId}"] [data-schedule-menu]`);
      await page.click('[role="menuitem"]:has-text("Edit")');
      await page.waitForSelector('[data-schedule-form="edit"]');
      assert.equal(await page.inputValue('[data-schedule-title]'), 'Build check');
      assert.equal(await page.getAttribute('[data-choice="freq"] [data-value="once"]', 'aria-checked'), 'true', 'it opens as what it is');
      await freq('weekdays');
      await page.fill('[data-when-time]', '09:00');
      await page.click('[data-schedule-more]');
      await page.fill('[data-schedule-tz]', 'Asia/Tokyo');
      await page.locator('[data-schedule-misfire]').selectOption('skip');
      await page.fill('[data-schedule-cost]', '0.5');
      await page.waitForFunction(() => document.querySelector('[data-when-words]')?.textContent === 'Every weekday at 09:00 (Asia/Tokyo)');
      assert.match(await page.locator('[data-when-preview]').innerText(), /next .*,.*,/, 'its next three runs');
      await shot('schedule-dialog-edit', page.locator('[role="dialog"]').last());
      await page.click('[data-schedule-create]');
      await created();
      await page.waitForFunction((id) => (document.querySelector(`[data-schedule="${id}"] [data-schedule-when]`)?.textContent ?? '') === 'Every weekday at 09:00 (Asia/Tokyo)', schedId);
      assert.match(await rowText(schedId), /at most \$0\.50 a run/);
      assert.match(await rowText(schedId), /Next /);
      const s = (await api('GET', `/api/schedules/${schedId}`)).body as { cron: string; timeZone: string; misfire: string; maxCostUsd: number; nextRun: number; enabled: boolean };
      assert.deepEqual([s.cron, s.timeZone, s.misfire, s.maxCostUsd, s.enabled], ['0 9 * * 1-5', 'Asia/Tokyo', 'skip', 0.5, true]);
      const next = new Date(s.nextRun);
      assert.equal(`${next.getUTCHours()}:${next.getUTCMinutes()}`, '0:0', '9:00 in Tokyo is midnight UTC');
    });

    await step('phase 1: a schedule that would run every minute is refused before it is made, and says why in the dialog', async () => {
      await page.click('[data-scheduled] [data-schedule-new]');
      await page.waitForSelector('[data-schedule-form="new"]');
      await page.fill('[data-schedule-prompt]', 'too often');
      await freq('custom');
      await page.fill('[data-schedule-cron]', '* * * * *');
      await page.waitForFunction(() => /a schedule may run at most every 5 minutes/.test(document.querySelector('[data-when-preview]')?.textContent ?? ''));
      await page.click('[data-schedule-create]');
      await page.waitForSelector('[data-schedule-form="new"] [data-schedule-error]');
      assert.match(await page.locator('[data-schedule-error]').innerText(), /a schedule may run at most every 5 minutes/);
      assert.equal(await page.locator('[data-toast="error"]').count(), 0, 'in the dialog, not a toast');
      await page.keyboard.press('Escape');
      await page.waitForSelector('[data-schedule-form="new"]', { state: 'detached' });
      assert.equal(((await api('GET', '/api/schedules')).body as unknown[]).length, 2);
      await page.click('[data-scheduled] [data-schedule-new]');
      await page.waitForSelector('[data-schedule-form="new"]');
      assert.equal(await page.locator('[data-schedule-error]').count(), 0, 'opened again: no old error');
      await page.keyboard.press('Escape');
    });

    await step('phase 1: a run that finds nothing is marked so and stays quiet; a run over its spend limit stops and says so, once', async () => {
      const quiet = (await api('POST', '/api/schedules', { title: 'Quiet check', prompt: 'quiet please', inMinutes: 60, newSession: { model: 'deepseek-flash', runtime: 'local', path: scratch, mode: 'dontAsk' } })).body as { id: string };
      const costly = (await api('POST', '/api/schedules', { title: 'Costly job', prompt: 'costly work', inMinutes: 60, maxCostUsd: 0.01, newSession: { model: 'deepseek-flash', runtime: 'local', path: scratch, mode: 'dontAsk' } })).body as { id: string };
      await page.waitForSelector(`[data-schedule="${quiet.id}"]`);
      await runAndWait(quiet.id, 'nothing to report');
      await openRuns(quiet.id);
      await page.waitForSelector(`[data-runs="${quiet.id}"] [data-run]`);
      assert.match(await page.locator(`[data-runs="${quiet.id}"] [data-run]`).innerText(), /Nothing to report[\s\S]*All quiet\./);
      await runAndWait(costly.id, '^Stopped: this scheduled run reached its spend limit');
      await toastWith('Stopped: this scheduled run reached its spend limit of $0.01');
      assert.match(await page.locator(`[data-schedule="${costly.id}"] [data-schedule-last-reason]`).innerText(), /spend limit of \$0\.01/);
      await openRuns(costly.id);
      const c = page.locator(`[data-runs="${costly.id}"] [data-run]`);
      await c.waitFor();
      assert.equal(await c.getAttribute('data-run-status'), 'stopped');
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
      await freq('daily');
      await page.fill('[data-when-time]', '02:00');
      assert.equal(await page.getAttribute('[data-schedule-asks] [data-value="auto"]', 'aria-checked'), 'true', 'a checker decides: the default');
      await page.click('[data-schedule-asks] [data-value="dontAsk"]');
      assert.equal(await page.locator('[data-schedule-wait]').count(), 0, 'never asks: no wait');
      await page.click('[data-schedule-asks] [data-value="acceptEdits"]');
      await page.fill('[data-schedule-wait]', '2');
      await shot('schedules-form-asks', page.locator('[role="dialog"]').last());
      await page.click('[data-schedule-create]');
      await created();
      const s = ((await api('GET', '/api/schedules')).body as Array<{ id: string; title: string; cron: string; askTimeoutMinutes?: number; newSession?: { mode: string } }>).find((x) => x.title === 'Nightly deploy')!;
      assert.deepEqual([s.cron, s.askTimeoutMinutes, s.newSession?.mode], ['0 2 * * *', 120, 'acceptEdits']);
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
      await openRuns(s.id);
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

    await step('setup: a template fills the dialog in; its timing is shown in words with its next runs', async () => {
      await page.click('[data-nav="core.scheduled:scheduled"]');
      await page.click('[data-scheduled] [data-schedule-new]');
      await page.waitForSelector('[data-schedule-form="new"] [data-schedule-templates]');
      // While a dialog is open, toasts sit under its backdrop, never over its buttons.
      assert.equal(await page.getAttribute('[data-toaster]', 'data-toaster'), 'under');
      assert.ok(await page.evaluate(() => Number(getComputedStyle(document.querySelector('[data-toaster]')!).zIndex) < Number(getComputedStyle(document.querySelector('[role="dialog"]')!.parentElement!).zIndex)), 'below the dialog');
      await page.click('[data-template="briefing"]');
      assert.equal(await page.inputValue('[data-schedule-title]'), 'Morning briefing');
      assert.match(await page.inputValue('[data-schedule-prompt]'), /what changed since yesterday/);
      assert.equal(await page.getAttribute('[data-choice="freq"] [data-value="weekdays"]', 'aria-checked'), 'true');
      assert.equal(await page.inputValue('[data-when-time]'), '08:30');
      await page.waitForFunction(() => /^Every weekday at 08:30/.test(document.querySelector('[data-when-words]')?.textContent ?? ''));
      await page.click('[data-template="weekly"]');
      await page.waitForFunction(() => /^Every Monday at 09:00/.test(document.querySelector('[data-when-words]')?.textContent ?? ''));
      assert.equal(await page.getAttribute('[data-schedule-asks] [data-value="acceptEdits"]', 'aria-checked'), 'true', 'its approvals too');
      assert.match(await words(), /Every Monday at 09:00/);
      // A day more: Monday and Thursday.
      await page.click('[data-when-days] [data-day="4"]');
      await page.waitForFunction(() => /^Every Monday and Thursday at 09:00/.test(document.querySelector('[data-when-words]')?.textContent ?? ''));
      await shot('schedule-dialog-new', page.locator('[role="dialog"]').last());
      await page.keyboard.press('Escape');
      await page.waitForSelector('[data-toaster="over"]', { state: 'attached' });
    });

    await step('workflows: a schedule that runs a workflow, picked with its inputs in a project folder; its run is the workflow\'s', async () => {
      const proj = (await invoke('projects:create', 'Reports')) as { path: string };
      fs.mkdirSync(path.join(proj.path, '.harness', 'workflows'), { recursive: true });
      fs.writeFileSync(path.join(proj.path, '.harness', 'workflows', 'daily-report.json'), JSON.stringify({ name: 'daily-report', description: 'Write the daily report', inputs: { topic: { description: 'What it is about', required: true } }, start: 'write', nodes: { write: { type: 'agent', prompt: 'Write the daily report on {{input.topic}}.', next: 'done' }, done: { type: 'end' } } }));
      await page.click('[data-scheduled] [data-schedule-new]');
      await page.waitForSelector('[data-schedule-form="new"]');
      await page.locator('[data-schedule-folder]').selectOption(proj.path);
      await page.click('[data-choice="what"] [data-value="workflow"]');
      await page.waitForSelector('[data-schedule-workflow] option[value="daily-report"]', { state: 'attached', timeout: 15_000 });
      await page.locator('[data-schedule-workflow]').selectOption('daily-report');
      await page.waitForSelector('[data-workflow-input="topic"]');
      assert.match(await page.locator('[data-schedule-missing]').innerText(), /the workflow's inputs/);
      await page.fill('[data-workflow-input="topic"]', 'sales');
      await page.fill('[data-schedule-title]', 'Daily sales report');
      await freq('daily');
      await page.fill('[data-when-time]', '18:00');
      await page.click('[data-schedule-create]');
      await created();
      const s = await scheduleNamed('Daily sales report') as unknown as { id: string; cron: string; workflow: { name: string; input: Record<string, string> }; newSession: { runtime: { path: string } } };
      assert.deepEqual([s.cron, s.workflow, s.newSession.runtime.path], ['0 18 * * *', { name: 'daily-report', input: { topic: 'sales' } }, proj.path]);
      await page.waitForSelector(`[data-schedule="${s.id}"]`);
      assert.match(await rowText(s.id), /Every day at 18:00[\s\S]*Workflow daily-report/);
      await runAndWait(s.id, '^completed');
      const [run] = (await api('GET', `/api/schedules/${s.id}/runs`)).body as Array<{ sessionId: string }>;
      const wf = (await api('GET', `/api/sessions/${run!.sessionId}/workflows`)).body as { runs: Array<{ workflow: string; status: string }> };
      assert.deepEqual([wf.runs[0]!.workflow, wf.runs[0]!.status], ['daily-report', 'succeeded']);
    });

    await step('watches: a watch made in the dialog looks at once; a change to its folder, found with Check now, runs once with what changed; no change runs nothing', async () => {
      const proj = (await api('GET', '/api/schedules')).body as Array<{ title: string; newSession?: { runtime: { path: string } } }>;
      const folder = proj.find((x) => x.title === 'Daily sales report')!.newSession!.runtime.path;
      fs.mkdirSync(path.join(folder, 'notes'), { recursive: true });
      fs.writeFileSync(path.join(folder, 'notes', 'a.md'), 'first');
      await page.click('[data-nav="core.scheduled:scheduled"]');
      await page.click('[data-scheduled] [data-schedule-new]');
      await page.waitForSelector('[data-schedule-form="new"]');
      await page.click('[data-choice="trigger"] [data-value="change"]');
      await page.waitForSelector('[data-watch-picker]');
      await page.click('[data-choice="watch-kind"] [data-value="files"]');
      await page.fill('[data-watch-paths]', 'notes');
      await page.waitForFunction(() => document.querySelector('[data-when-words]')?.textContent === 'When notes change, checked every 5 minutes');
      await page.fill('[data-schedule-title]', 'Notes watch');
      await page.fill('[data-schedule-prompt]', 'Summarise what changed in the notes.');
      await page.locator('[data-schedule-folder]').selectOption(folder);
      await shot('schedule-dialog-watch', page.locator('[role="dialog"]').last());
      await page.click('[data-schedule-create]');
      await created();
      const s = await scheduleNamed('Notes watch') as unknown as { id: string; watch: { kind: string; paths: string[]; everyMinutes: number } };
      assert.deepEqual(s.watch, { kind: 'files', everyMinutes: 5, paths: ['notes'] });
      await page.waitForFunction((id) => /Checked just now/.test(document.querySelector(`[data-schedule="${id}"] [data-schedule-watch]`)?.textContent ?? ''), s.id, { timeout: 15_000 });
      assert.match(await rowText(s.id), /When notes change, checked every 5 minutes/);
      await page.click(`[data-schedule="${s.id}"] [data-schedule-check]`);
      await toastWith('No change');
      assert.equal(((await api('GET', `/api/schedules/${s.id}/runs`)).body as unknown[]).length, 0, 'nothing ran');
      fs.writeFileSync(path.join(folder, 'notes', 'b.md'), 'a new note');
      await page.click(`[data-schedule="${s.id}"] [data-schedule-check]`);
      await toastWith('It changed: a run started');
      const end = Date.now() + 20_000;
      let runs: Array<{ by: string; status: string; sessionId: string }> = [];
      while (!(runs[0]?.status === 'completed')) { assert.ok(Date.now() < end, 'it ran'); await page.waitForTimeout(300); runs = (await api('GET', `/api/schedules/${s.id}/runs`)).body as typeof runs; }
      assert.equal(runs.length, 1);
      assert.equal(runs[0]!.by, 'watch');
      assert.match(await history(runs[0]!.sessionId), /<watch_change>[\s\S]*Added: notes\/b\.md/);
      await page.waitForSelector(`[data-runs="${s.id}"] [data-run]`);
      assert.match(await page.locator(`[data-runs="${s.id}"] [data-run]`).first().innerText(), /on a change/);
    });

    await step('watches: a check that fails says why on the row; a watch template fills the dialog in as a watch', async () => {
      const proj = (await api('GET', '/api/schedules')).body as Array<{ title: string; newSession?: { runtime: { path: string } } }>;
      const folder = proj.find((x) => x.title === 'Daily sales report')!.newSession!.runtime.path;
      const made = (await api('POST', '/api/schedules', { title: 'Commits', prompt: 'review', watch: { kind: 'git', everyMinutes: 15 }, newSession: { model: 'deepseek-flash', runtime: 'local', path: folder, mode: 'dontAsk' } })).body as { id: string };
      await page.waitForSelector(`[data-schedule="${made.id}"]`);
      await page.click(`[data-schedule="${made.id}"] [data-schedule-check]`);
      await toastWith('the check failed: git:');
      await page.waitForSelector(`[data-schedule="${made.id}"] [data-schedule-watch-error]`);
      assert.match(await page.locator(`[data-schedule="${made.id}"] [data-schedule-watch-error]`).innerText(), /The last check failed: git: /);
      await page.click('[data-scheduled] [data-schedule-new]');
      await page.waitForSelector('[data-schedule-form="new"]');
      await page.click('[data-template="tests"]');
      assert.equal(await page.getAttribute('[data-choice="trigger"] [data-value="change"]', 'aria-checked'), 'true');
      assert.equal(await page.getAttribute('[data-choice="watch-kind"] [data-value="command"]', 'aria-checked'), 'true');
      assert.equal(await page.inputValue('[data-watch-command]'), 'npm test');
      assert.equal(await page.inputValue('[data-watch-only-when]'), 'a test fails');
      await page.waitForFunction(() => document.querySelector('[data-when-words]')?.textContent === 'When the output of `npm test` changes, checked every 30 minutes');
      await page.click('[data-template="briefing"]');
      assert.equal(await page.getAttribute('[data-choice="trigger"] [data-value="time"]', 'aria-checked'), 'true', 'a time template is at set times again');
      await page.keyboard.press('Escape');
    });

    await step('agents set it up: asked in a chat, the agent schedules a routine for the person (after they allow it); it is on the Scheduled page in plain words', async () => {
      await page.click('[data-nav="core.chat:new"]');
      await page.waitForSelector('[data-home]');
      const box = page.locator('[data-composer-input]').first();
      await box.fill('set up a routine for me');
      await box.press('Enter');
      await page.waitForSelector('[data-session]', { timeout: 20_000 });
      const sid = (await page.getAttribute('[data-session]', 'data-session'))!;
      const card = await page.waitForSelector('[data-attention] [data-pending="permission_request"]', { timeout: 20_000 });
      assert.match(await card.innerText(), /schedule/);
      await (await card.$('[data-decision="allow"]'))!.click();
      await page.waitForSelector(`[data-session="${sid}"][data-status="idle"]`, { timeout: 30_000 });
      const s = (await api('GET', '/api/schedules')).body as Array<{ id: string; createdBy?: string; when: string; newSession?: unknown }>;
      const mine = s.find((x) => x.createdBy === sid)!;
      assert.equal(mine.when, 'Every weekday at 09:00');
      assert.ok(mine.newSession, 'a new conversation each time');
      await page.click('[data-nav="core.scheduled:scheduled"]');
      await page.waitForSelector(`[data-schedule="${mine.id}"]`);
      assert.match(await rowText(mine.id), /Summarise what changed in this folder since yesterday\.[\s\S]*Every weekday at 09:00/);
    });

    await step('agents set it up: the agent fills the dialog in for the person to check; nothing exists until they confirm', async () => {
      await page.click('[data-nav="core.chat:new"]');
      await page.waitForSelector('[data-home]');
      const before = ((await api('GET', '/api/schedules')).body as unknown[]).length;
      const box = page.locator('[data-composer-input]').first();
      await box.fill('propose a schedule');
      await box.press('Enter');
      const card = await page.waitForSelector('[data-attention] [data-pending="permission_request"]', { timeout: 20_000 });
      await (await card.$('[data-decision="allow"]'))!.click();
      await page.waitForSelector('[data-schedule-form="new"]', { timeout: 20_000 });
      assert.equal(await page.inputValue('[data-schedule-title]'), 'Nightly tests');
      assert.equal(await page.inputValue('[data-schedule-prompt]'), 'Run the tests and tell me what fails.');
      assert.equal(await page.getAttribute('[data-choice="freq"] [data-value="daily"]', 'aria-checked'), 'true');
      assert.equal(await page.inputValue('[data-when-time]'), '02:00');
      assert.equal(await page.getAttribute('[data-schedule-asks] [data-value="auto"]', 'aria-checked'), 'true');
      assert.equal(((await api('GET', '/api/schedules')).body as unknown[]).length, before, 'nothing yet');
      await page.click('[data-schedule-create]');
      await created();
      const s = await scheduleNamed('Nightly tests') as unknown as { cron: string; newSession: { mode: string } };
      assert.deepEqual([s.cron, s.newSession.mode], ['0 2 * * *', 'auto']);
    });

    await step('phase 4: "Tell me: only when it matters": a plain result waits quietly in the Inbox and says why; it does not interrupt', async () => {
      await page.click('[data-nav="core.scheduled:scheduled"]');
      await page.click('[data-scheduled] [data-schedule-new]');
      await page.waitForSelector('[data-schedule-form="new"]');
      await page.fill('[data-schedule-title]', 'Plain report');
      await page.fill('[data-schedule-prompt]', 'Write the plain report.');
      await freq('once');
      await page.fill('[data-when-in]', '60');
      await page.click('[data-choice="notify"] [data-value="important"]');
      assert.match(await page.locator('[data-notify-help]').innerText(), /other results wait quietly/);
      await page.click('[data-schedule-create]');
      await created();
      const s = await scheduleNamed('Plain report') as unknown as { id: string; notify: string };
      // (Its title has none of the engine's script words: it gets a plain reply.)
      assert.equal(s.notify, 'important');
      assert.match(await rowText(s.id), /tells you what matters/);
      const toastsBefore = await page.$$eval('[data-toast]', (els) => els.map((e) => e.textContent ?? ''));
      await runAndWait(s.id, '^completed');
      await page.click('[data-nav="core.inbox:inbox"]');
      const u = page.locator('[data-inbox-updates] [data-update]', { hasText: 'Plain report' });
      await u.waitFor({ timeout: 15_000 });
      assert.equal(await u.locator('[data-update-held]').getAttribute('data-update-held'), 'policy');
      assert.match(await u.innerText(), /kept quiet by its schedule/);
      const toastsAfter = await page.$$eval('[data-toast]', (els) => els.map((e) => e.textContent ?? ''));
      assert.ok(!toastsAfter.some((t) => t.includes('Plain report') && !toastsBefore.includes(t)), 'no toast for it');
    });

    await step('phase 4: the person\'s limits in the Inbox: a daily most of 0 keeps the next update from interrupting ("past your daily most"); the limits are checked and saved', async () => {
      await page.click('[data-inbox-updates] [data-updates-settings]');
      await page.waitForSelector('[data-limits]');
      await page.fill('[data-limits-quiet-from]', '22:00');
      await page.click('[data-limits-save]');
      await page.waitForSelector('[data-limits-error]');
      assert.match(await page.locator('[data-limits-error]').innerText(), /quiet hours need both/);
      await page.fill('[data-limits-quiet-from]', '');
      await page.fill('[data-limits-max]', '0');
      await page.fill('[data-limits-digest]', '08:30');
      await page.click('[data-limits-save]');
      await page.waitForSelector('[data-limits]', { state: 'detached' });
      const saved = (await api('GET', '/api/inbox/settings')).body as { maxPerDay: number; digestAt: string; timeZone?: string };
      assert.deepEqual([saved.maxPerDay, saved.digestAt], [0, '08:30']);
      assert.ok(saved.timeZone, 'this computer\'s time zone');
      const made = (await api('POST', '/api/schedules', { title: 'Over the limit', prompt: 'say hello', inMinutes: 60, newSession: { model: 'deepseek-flash', runtime: 'local', path: scratch, mode: 'dontAsk' } })).body as { id: string };
      await api('POST', `/api/schedules/${made.id}/run`);
      const u = page.locator('[data-inbox-updates] [data-update]', { hasText: 'Over the limit' });
      await u.waitFor({ timeout: 15_000 });
      assert.equal(await u.locator('[data-update-held]').getAttribute('data-update-held'), 'budget');
      assert.match(await u.innerText(), /past your daily most/);
      await shot('inbox-limits', page.locator('[data-inbox-updates]'));
      await api('PUT', '/api/inbox/settings', {});
    });

    await step('phase 4: a schedule whose updates are mostly dismissed as not useful says so and offers to be quieter; one click moves it to the digest; its 30 days are shown', async () => {
      const made = (await api('POST', '/api/schedules', { title: 'Noisy check', prompt: 'say hello', inMinutes: 60, newSession: { model: 'deepseek-flash', runtime: 'local', path: scratch, mode: 'dontAsk' } })).body as { id: string };
      for (let i = 0; i < 4; i++) {
        await api('POST', `/api/schedules/${made.id}/run`);
        const end = Date.now() + 15_000;
        while (((await api('GET', '/api/inbox?view=all')).body as { items: Array<{ title: string }> }).items.filter((x) => x.title === 'Noisy check').length < i + 1) { assert.ok(Date.now() < end, 'its update'); await page.waitForTimeout(200); }
      }
      const mine = ((await api('GET', '/api/inbox?view=all')).body as { items: Array<{ id: string; title: string }> }).items.filter((x) => x.title === 'Noisy check');
      for (const it of mine.slice(0, 3)) await api('POST', `/api/inbox/${it.id}`, { action: 'dismiss', reason: 'not_useful' });
      await page.click('[data-nav="core.scheduled:scheduled"]');
      const banner = page.locator(`[data-schedule="${made.id}"] [data-schedule-quieter]`);
      await banner.waitFor({ timeout: 15_000 });
      assert.match(await banner.innerText(), /3 of its last 4 updates were dismissed as not useful or left unread\. Make it quieter\?/);
      await openRuns(made.id);
      await page.waitForSelector(`[data-schedule="${made.id}"] [data-schedule-stats]`);
      assert.match(await page.locator(`[data-schedule="${made.id}"] [data-schedule-stats]`).innerText(), /Last 30 days: 4 runs[\s\S]*4 found something[\s\S]*0 of 4 updates opened[\s\S]*3 not useful/);
      await shot('schedule-quieter', page.locator(`[data-schedule="${made.id}"]`));
      await banner.locator('[data-quieter="digest"]').click();
      await banner.waitFor({ state: 'detached', timeout: 15_000 });
      assert.equal(((await api('GET', `/api/schedules/${made.id}`)).body as { notify: string }).notify, 'digest');
      assert.match(await rowText(made.id), /in your digest/);
    });

    await step('no errors in the window', async () => {
      // The refusal of the every-minute schedule is a 400 the window shows as a toast (Chromium logs it too).
      // Refusals the window shows in its own dialogs (a 400 Chromium logs too): the every-minute schedule, half-set quiet hours.
      assert.deepEqual(errors.filter((e) => !(e.phase.includes('every minute is refused') && /status of 400 .*\/api\/schedules\)/.test(e.text)) && !(e.phase.includes('limits in the Inbox') && /status of 400 .*\/api\/inbox\/settings\)/.test(e.text))), []);
    });
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(data, { recursive: true, force: true });
  }
});
