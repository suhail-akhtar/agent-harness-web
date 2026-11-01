// Harness Desktop end to end, noticing (docs/proactive/NOTICING.md): what the harness notices by itself, in
// the real app. Practice first (written down, not shown; the Inbox's banner and the review); then on: a
// command failing the same way again shows one line by the conversation's message box, whose button sends
// its own message; a conversation that failed while nobody had it open reaches the Inbox (and interrupts,
// once); a task asked for on 3 days offers a schedule in the person's words that opens the schedule dialog
// filled in; a dismissal is counted; a detector is switched off; what it observed is forgotten.
// The real Electron app against the scripted engine (test/fixtures/desktop/proactive-engine.ts: nothing
// is spent), driven with playwright-core. Skipped when Electron cannot start here.
//
// HARNESS_DESKTOP_SCREENSHOTS=1 also writes the screenshots in docs/screenshots/desktop/.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promptSig } from '../src/core/noticing.ts';
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
function ensureBuilt(): string | null {
  const out = path.join(desktop, 'dist', 'renderer', 'index.html');
  const src = Math.max(newest(path.join(desktop, 'electron')), newest(path.join(desktop, 'renderer')), newest(path.join(desktop, 'shared')), newest(path.join(root, 'packages')));
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= src) return null;
  const r = spawnSync(process.execPath, [path.join(desktop, 'scripts', 'build.mjs')], { cwd: root, stdio: 'pipe', encoding: 'utf8', timeout: 600_000 });
  return r.status === 0 ? null : `build failed: ${(r.stderr || r.stdout).slice(-800)}`;
}
const find = (dir: string, name: string): string | undefined => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) { const f = find(p, name); if (f) return f; }
  }
  return undefined;
};

test('desktop app end to end: noticing', { timeout: 10 * 60_000 }, async (t) => {
  if (!fs.existsSync(electronExe)) { t.skip('Electron is not installed'); return; }
  let pw: typeof import('playwright-core');
  try { pw = await import('playwright-core'); } catch { t.skip('playwright-core is not installed'); return; }
  const failed = ensureBuilt();
  if (failed) assert.fail(failed);

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-e2e-notice-'));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_API_KEY$|^GW_|^HARNESS_/.test(k)) env[k] = v;
  // Practice is ready at once (no week to wait), a turn counts as long at once, nothing is held back to measure.
  Object.assign(env, { HARNESS_DESKTOP_DATA: data, HARNESS_DESKTOP_TEST: '1', ...(process.env.HARNESS_E2E_SHOW ? { HARNESS_E2E_SHOW: process.env.HARNESS_E2E_SHOW } : {}), HARNESS_DESKTOP_ENGINE: path.join(root, 'test', 'fixtures', 'desktop', 'proactive-engine.ts'), HARNESS_DESKTOP_NO_TRAY: '1', HARNESS_PLUGIN_LOOPS: 'off', HARNESS_NOTICE_PRACTICE_DAYS: '0', HARNESS_NOTICE_AWAY_MINUTES: '0', HARNESS_NOTICE_HOLDOUT: '0' });
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
  await setSize(1360, 860);
  const step = (name: string, fn: () => Promise<void>) => t.test(name, async () => {
    phase = name;
    try { await fn(); } catch (e) {
      await capture(app).then((png) => fs.writeFileSync(path.join(os.tmpdir(), `hd-e2e-notice-fail-${name.slice(0, 40).replace(/[^a-z0-9]+/gi, '-')}.png`), png)).catch(() => {});
      for (let i = 0; i < 3; i++) await page.keyboard.press('Escape').catch(() => {});
      throw e;
    }
  });
  const toastWith = (text: string) => page.waitForFunction((x) => [...document.querySelectorAll('[data-toast]')].some((e) => (e.textContent ?? '').includes(x)), text, { timeout: 30_000 });
  let work = '';
  /** A conversation made and driven through the API (as another window or the CLI would): the app does not have it open. */
  const converse = async (title: string, ...messages: string[]) => {
    const s = (await api('POST', '/api/sessions', { model: 'deepseek-flash', runtime: 'local', path: work, mode: 'bypass', title })).body as { id: string };
    assert.ok(s?.id, `made: ${JSON.stringify(s)}`);
    for (const m of messages) {
      const before = ((await api('GET', `/api/sessions/${s.id}`)).body as { history: unknown[] }).history.length;
      await api('POST', `/api/sessions/${s.id}/messages`, { text: m });
      const end = Date.now() + 30_000;
      for (;;) {
        // Idle again, with the turn written (a turn that failed ends without an answer).
        const d = (await api('GET', `/api/sessions/${s.id}`)).body as { status: string; history: Array<{ role: string }> };
        if (d.status === 'idle' && d.history.length >= before + 2) break;
        assert.ok(Date.now() < end, `the reply to "${m}"`);
        await page.waitForTimeout(150);
      }
    }
    return s.id;
  };
  const overview = async () => (await api('GET', '/api/noticing')).body as { mode: string; practice: Array<{ detector: string; title: string }>; detectors: Array<{ id: string; enabled: boolean; stats: { notUseful: number; acted: number } }>; observed: { commands: number } };
  const inbox = async () => ((await api('GET', '/api/inbox?view=all')).body as { items: Array<{ id: string; kind: string; detector?: string; title: string; status: string; alert?: boolean; held?: string; sessionId?: string }> }).items.filter((i) => i.kind === 'noticed');
  const openInbox = async () => { await page.click('[data-nav="core.inbox:inbox"]'); await page.waitForSelector('[data-inbox-updates]'); };
  const openNoticing = async () => { await openInbox(); await page.click('[data-inbox-updates] [data-updates-noticing]'); await page.waitForSelector('[data-noticing]'); };
  const closeDialog = async () => { await page.keyboard.press('Escape'); await page.waitForSelector('[data-noticing]', { state: 'detached' }); };

  try {
    await step('the app starts; noticing practises quietly by default and its panel says what it is', async () => {
      await page.waitForSelector('[data-engine-status="ready"]', { timeout: 90_000 });
      await page.waitForSelector('[data-home]');
      await invoke('prefs:set', { defaultModel: 'deepseek-flash', onboardingDone: true, keepInTray: false });
      work = (await invoke('home:scratch')) as string;
      assert.ok(work && fs.existsSync(work));
      await openNoticing();
      assert.equal(await page.getAttribute('[data-noticing]', 'data-noticing-mode'), 'practice');
      assert.match(await page.locator('[data-noticing-help]').innerText(), /writes down what it would have told you/);
      await page.waitForSelector('[data-noticing-review-empty]');
      assert.equal(await page.locator('[data-noticing] [data-detector]').count(), 4);
      assert.match(await page.locator('[data-noticing-observed]').innerText(), /Nothing yet\.[\s\S]*never the text of your messages/);
      await closeDialog();
    });

    await step('practice: a command failing the same way over two turns is written down, not shown; the Inbox invites a review; the review lists it; "Useful: turn it on"', async () => {
      await converse('Start the app', 'start the app, it is stuck', 'try the stuck app again');
      const o = await overview();
      assert.deepEqual(o.practice.map((p) => p.detector), ['stuck']);
      assert.equal((await inbox()).length, 0, 'nothing shown');
      await openInbox();
      await page.waitForSelector('[data-noticing-banner]');
      assert.match(await page.locator('[data-noticing-banner]').innerText(), /practised quietly today\. It would have told you 1 thing\./);
      await shot('noticing-banner', page.locator('[data-inbox-updates]'));
      await page.click('[data-noticing-review-open]');
      await page.waitForSelector('[data-noticing-review] [data-noticing-would="stuck"]');
      assert.match(await page.locator('[data-noticing-would="stuck"]').innerText(), /The same command failed 4 times[\s\S]*config\.json is missing/);
      assert.match(await page.locator('[data-noticing-observed]').innerText(), /4 commands \(4 failed\)/);
      await shot('noticing-practice', page.locator('[role="dialog"]'));
      await page.click('[data-noticing-turn-on]');
      await page.waitForSelector('[data-noticing][data-noticing-mode="on"]');
      assert.equal((await overview()).mode, 'on');
      await closeDialog();
      assert.equal(await page.locator('[data-noticing-banner]').count(), 0, 'no banner once it is on');
    });

    let stuckSession = '';
    await step('on: the same failure in another conversation shows one quiet line by its message box; "Find the cause" sends the finding\'s own message and the line goes', async () => {
      stuckSession = await converse('Start the app again', 'start the app, it is stuck', 'is it still stuck');
      const [it] = await inbox();
      assert.ok(it);
      assert.deepEqual([it.detector, it.sessionId, it.alert], ['stuck', stuckSession, false]);
      await page.click(`[data-session-row="${stuckSession}"] button`);
      await page.waitForSelector(`[data-session="${stuckSession}"][data-status="idle"]`);
      const strip = page.locator('[data-noticed-strip]');
      await strip.waitFor({ timeout: 15_000 });
      assert.match(await strip.innerText(), /The same command failed 4 times\. “node -e .*” gave the same error each time, 4 times in 1 minute, with no edits in between\./);
      await shot('noticing-strip', page.locator(`[data-session="${stuckSession}"]`));
      await strip.locator('[data-noticed-accept]').click();
      await strip.waitFor({ state: 'detached', timeout: 15_000 });
      await page.waitForFunction(() => /Stop retrying it\. Find the root cause first/.test(document.querySelector('[data-session]')?.textContent ?? ''), undefined, { timeout: 20_000 });
      assert.equal((await inbox()).find((i) => i.id === it.id)?.status, 'done');
    });

    await step('a conversation that failed while nobody had it open reaches the Inbox as a warning and interrupts (the first today); it names what noticed it', async () => {
      await converse('Refactor billing', 'work on billing while I am away');
      await toastWith('stopped while you were away');
      await openInbox();
      const row = page.locator('[data-inbox-updates] [data-update-kind="noticed"]', { hasText: 'stopped while you were away' });
      await row.waitFor({ timeout: 15_000 });
      assert.match(await row.innerText(), /"Refactor billing" stopped while you were away[\s\S]*it hit an error/);
      assert.equal(await row.locator('[data-update-detector]').getAttribute('data-update-detector'), 'away_failure');
      await shot('noticing-away', row);
    });

    const PROMPT = 'Summarise the open pull requests and say which ones need my review today';
    await step('a task asked for on 3 days offers a schedule in the person\'s own words; "Set it up" opens the schedule dialog filled in, and nothing is made until they make it', async () => {
      // The person asked for it yesterday and the day before (as the activity log would have it), and again now.
      const log = find(data, 'activity.jsonl');
      assert.ok(log, 'the activity log');
      const mine = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { project?: string; owner?: string });
      const project = mine.find((a) => a.project)!.project;
      const sig = promptSig(PROMPT);
      const now = Date.now();
      for (const d of [2, 1]) fs.appendFileSync(log, JSON.stringify({ at: now - d * 86_400_000, k: 'turn', turn: 1, person: true, end: 'done', ms: 4000, sig, sid: `seed${d}`, project, ...(mine[0]!.owner ? { owner: mine[0]!.owner } : {}) }) + '\n');
      await page.waitForTimeout(1200);
      await converse('Pull requests', PROMPT);
      await openInbox();
      const row = page.locator('[data-inbox-updates] [data-update-kind="noticed"]', { hasText: 'You asked for this on 3 days' });
      await row.waitFor({ timeout: 15_000 });
      assert.equal(await row.locator('[data-update-held]').getAttribute('data-update-held'), 'digest', 'it waits: no interruption');
      assert.equal(((await api('GET', '/api/schedules')).body as unknown[]).length, 0, 'nothing made');
      await shot('noticing-repeat', row);
      await row.locator('[data-update-setup]').click();
      await page.waitForSelector('[data-schedule-form="new"]');
      assert.equal(await page.inputValue('[data-schedule-prompt]'), PROMPT, 'the person\'s own words');
      assert.equal(await page.inputValue('[data-schedule-title]'), 'Summarise the open pull requests and say which ones need…', 'whole words');
      assert.equal(await page.locator('[data-schedule-folder]').inputValue(), project, 'in that folder');
      assert.match(await page.locator('[data-schedule-form] [data-when-words]').innerText(), /at \d{1,2}:\d{2}/);
      await shot('noticing-setup', page.locator('[role="dialog"]'));
      await page.click('[data-schedule-create]');
      await page.waitForSelector('[data-schedule-form]', { state: 'detached', timeout: 15_000 });
      const made = (await api('GET', '/api/schedules')).body as Array<{ prompt: string; cron?: string; newSession?: { mode: string; runtime: { path?: string } } }>;
      assert.equal(made.length, 1);
      assert.equal(made[0]!.prompt, PROMPT);
      assert.ok(made[0]!.cron, 'at the usual time');
      assert.equal(made[0]!.newSession?.mode, 'auto');
      assert.equal(made[0]!.newSession?.runtime.path, project);
      // Asked again: a schedule does it now, so nothing more is offered (not even one dropped past the day's 3).
      const before = (await inbox()).length;
      await converse('Pull requests again', PROMPT);
      await page.waitForTimeout(800);
      assert.equal((await inbox()).length, before);
      const findings = fs.readFileSync(find(data, 'noticed.jsonl')!, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { detector: string; outcome: string });
      assert.deepEqual(findings.filter((f) => f.detector === 'repeated_task').map((f) => f.outcome), ['shown']);
    });

    await step('a finding dismissed as not useful is counted; a detector switched off in the panel stays off; what it observed is forgotten', async () => {
      await openInbox();
      const row = page.locator('[data-inbox-updates] [data-update-kind="noticed"]', { hasText: 'stopped while you were away' });
      await row.locator('[data-update-dismiss]').click();
      await page.getByRole('menuitem', { name: 'Not useful' }).click();
      await row.waitFor({ state: 'detached', timeout: 15_000 });
      await openNoticing();
      await page.waitForFunction(() => /1 not useful/.test(document.querySelector('[data-detector="away_failure"] [data-detector-stats]')?.textContent ?? ''), undefined, { timeout: 15_000 });
      assert.match(await page.locator('[data-detector="stuck"] [data-detector-stats]').innerText(), /1 acted on/);
      await page.click('[data-detector="repeated_task"] [role="switch"]');
      await page.waitForFunction(() => document.querySelector('[data-detector="repeated_task"] [role="switch"]')?.getAttribute('aria-checked') === 'false');
      assert.equal((await overview()).detectors.find((d) => d.id === 'repeated_task')!.enabled, false);
      await shot('noticing-panel', page.locator('[role="dialog"]'));
      await page.click('[data-noticing-clear]');
      await page.click('[data-noticing-clear-confirm]');
      await page.waitForFunction(() => /Nothing yet\./.test(document.querySelector('[data-noticing-observed]')?.textContent ?? ''), undefined, { timeout: 15_000 });
      assert.equal((await overview()).observed.commands, 0);
      await closeDialog();
    });

    await step('no errors in the window', async () => {
      assert.deepEqual(errors, []);
    });
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(data, { recursive: true, force: true });
  }
});
