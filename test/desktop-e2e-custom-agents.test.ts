// Harness Desktop end to end, custom agents (docs/agents-mcp/PLAN.md, phase 1): Your agents in the real app. An
// agent drafted from a description with Generate (what the server does not have is left out and said), checked and
// made; edited into a new version and an earlier one brought back; switched off and on; an agent file imported;
// a conversation with the agent (it runs as it); the agent in another conversation handing work to it (the
// orchestrator), seen in the Agents panel; deleted. The real Electron app against the scripted engine
// (test/fixtures/desktop/proactive-engine.ts: nothing is spent), driven with playwright-core.
//
// HARNESS_DESKTOP_SCREENSHOTS=1 also writes the screenshots in docs/screenshots/desktop/.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
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

test('desktop app end to end: custom agents', { timeout: 10 * 60_000 }, async (t) => {
  if (!fs.existsSync(electronExe)) { t.skip('Electron is not installed'); return; }
  let pw: typeof import('playwright-core');
  try { pw = await import('playwright-core'); } catch { t.skip('playwright-core is not installed'); return; }
  const failed = ensureBuilt();
  if (failed) assert.fail(failed);

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-e2e-agents-'));
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
  await setSize(1360, 900);
  const step = (name: string, fn: () => Promise<void>) => t.test(name, async () => {
    phase = name;
    try { await fn(); } catch (e) {
      await capture(app).then((png) => fs.writeFileSync(path.join(os.tmpdir(), `hd-e2e-agents-fail-${name.slice(0, 40).replace(/[^a-z0-9]+/gi, '-')}.png`), png)).catch(() => {});
      for (let i = 0; i < 3; i++) await page.keyboard.press('Escape').catch(() => {});
      throw e;
    }
  });
  const mine = async () => (await api('GET', '/api/me/agents')).body as Array<{ name: string; version: number; enabled: boolean; description: string; tools?: string[]; permissionMode?: string; prompt: string }>;
  const openMine = async () => { await page.click('[data-nav="core.agents:mine"]'); await page.waitForSelector('[data-your-agents]'); };
  const card = (name: string) => page.locator(`[data-agents-mine] [data-agent-card="${name}"]`);
  const idleSession = async (id: string) => {
    const end = Date.now() + 30_000;
    for (;;) {
      const d = (await api('GET', `/api/sessions/${id}`)).body as { status: string; history: Array<{ role: string }> };
      if (d.status === 'idle' && d.history.at(-1)?.role === 'assistant') return d;
      assert.ok(Date.now() < end, 'the reply');
      await page.waitForTimeout(150);
    }
  };

  try {
    await step('the app starts; Your agents is empty and says what agents are for; the built-in ones are listed', async () => {
      await page.waitForSelector('[data-engine-status="ready"]', { timeout: 90_000 });
      await page.waitForSelector('[data-home]');
      await invoke('prefs:set', { defaultModel: 'deepseek-flash', onboardingDone: true, keepInTray: false });
      await openMine();
      await page.waitForSelector('[data-agents-make]');
      assert.deepEqual(await page.$$eval('[data-agents-others] [data-agent-card]', (els) => els.map((e) => e.getAttribute('data-agent-card'))), ['explore', 'general']);
    });

    await step('Generate drafts an agent from a description (what the server lacks is left out and said); the person checks it and makes it', async () => {
      await page.click('[data-agents-make]');
      await page.waitForSelector('[data-agent-form="new"]');
      assert.match(await page.locator('[data-agent-missing]').innerText(), /a name/);
      await page.fill('[data-agent-describe]', 'Reviews my pull requests for security problems and explains each one with a fix');
      await page.click('[data-agent-generate]');
      await page.waitForSelector('[data-agent-note]');
      assert.match(await page.locator('[data-agent-note]').innerText(), /Check it, change what you like, then save\. Left out \(not on this server\): tools: teleport/);
      assert.equal(await page.inputValue('[data-agent-name]'), 'security-reviewer');
      assert.match(await page.inputValue('[data-agent-prompt]'), /^Role: a careful security reviewer\.\nProcedure:/);
      assert.deepEqual(await page.$$eval('[data-checks] input:checked', (els) => els.map((e) => e.getAttribute('data-check'))).then((x) => x.sort()), ['glob', 'grep', 'read']);
      assert.equal(await page.getAttribute('[data-choice="agent-mode"] [aria-checked="true"]', 'data-value'), 'plan');
      assert.equal(await page.inputValue('[data-agent-max-turns]'), '30');
      assert.equal((await mine()).length, 0, 'nothing saved yet');
      await shot('agent-builder', page.locator('[role="dialog"]'));
      await page.click('[data-agent-save]');
      await card('security-reviewer').waitFor({ timeout: 15_000 });
      const [a] = await mine();
      assert.deepEqual([a!.name, a!.version, a!.permissionMode, a!.tools?.sort()], ['security-reviewer', 1, 'plan', ['glob', 'grep', 'read']]);
      assert.match(await card('security-reviewer').innerText(), /security-reviewer[\s\S]*v1[\s\S]*Reviews code changes[\s\S]*3 tools[\s\S]*read only/);
    });

    await step('edited into a new version; an earlier one comes back as a newer version; switched off and on', async () => {
      await card('security-reviewer').locator('[data-agent-edit]').click();
      await page.waitForSelector('[data-agent-form="edit"]');
      await page.fill('[data-agent-description]', 'Reviews code changes for security problems, especially login and payment code; returns each finding with a fix.');
      await page.click('[data-agent-save]');
      await page.waitForSelector('[data-agent-form]', { state: 'detached' });
      assert.equal((await mine())[0]!.version, 2);
      await card('security-reviewer').locator('[data-agent-edit]').click();
      await page.waitForSelector('[data-agent-versions] [data-agent-restore="1"]');
      await page.click('[data-agent-restore="1"]');
      await page.waitForSelector('[data-agent-form]', { state: 'detached' });
      const back = (await mine())[0]!;
      assert.deepEqual([back.version, back.description], [3, 'Reviews code changes for security problems and returns each finding with a fix.']);
      await card('security-reviewer').locator('[role="switch"]').click();
      await page.waitForFunction(() => document.querySelector('[data-agent-card="security-reviewer"] [role="switch"]')?.getAttribute('aria-checked') === 'false');
      assert.equal((await mine())[0]!.enabled, false);
      assert.equal(await card('security-reviewer').locator('[data-agent-chat]').count(), 0, 'off: no chat');
      await card('security-reviewer').locator('[role="switch"]').click();
      await page.waitForFunction(() => document.querySelector('[data-agent-card="security-reviewer"] [role="switch"]')?.getAttribute('aria-checked') === 'true');
      assert.equal((await mine())[0]!.version, 3, 'on and off are not versions');
    });

    await step('an agent file from Claude Code is imported (Import button, a file); its tools and model read from the file', async () => {
      const file = path.join(os.tmpdir(), `doc-writer-${Date.now()}.md`);
      fs.writeFileSync(file, '---\nname: doc-writer\ndescription: Writes documentation for new features in plain words.\ntools: Read, Write, Grep\nmodel: inherit\nbackground: true\n---\nWrite clear, short docs.\n');
      const chooser = page.waitForEvent('filechooser');
      await page.click('[data-agents-import]');
      await (await chooser).setFiles(file);
      await card('doc-writer').waitFor({ timeout: 15_000 });
      const d = (await mine()).find((a) => a.name === 'doc-writer')!;
      assert.deepEqual(d.tools, ['read', 'write', 'grep']);
      assert.match(await card('doc-writer').innerText(), /the conversation's model[\s\S]*3 tools[\s\S]*background/);
      await shot('your-agents', page.locator('[data-your-agents]'));
    });

    let chatId = '';
    await step('Chat starts a conversation that runs as the agent (its name, its instructions, its read-only mode)', async () => {
      await card('security-reviewer').locator('[data-agent-chat]').click();
      await page.waitForSelector('[data-session]', { timeout: 20_000 });
      chatId = (await page.getAttribute('[data-session]', 'data-session'))!;
      const meta = (await api('GET', `/api/sessions/${chatId}`)).body as { meta: { agent: string; title: string } };
      assert.deepEqual([meta.meta.agent, meta.meta.title], ['security-reviewer', 'security-reviewer']);
      const box = page.locator('[data-composer-input]').first();
      await box.fill('hello there');
      await box.press('Enter');
      await idleSession(chatId);
    });

    await step('in another conversation, the agent hands the review to security-reviewer (the orchestrator), and the Agents panel shows it', async () => {
      await page.click('[data-nav="core.chat:new"]');
      await page.waitForSelector('[data-home]');
      const box = page.locator('[data-composer-input]').first();
      await box.fill('delegate the review of my login change');
      await box.press('Enter');
      await page.waitForSelector('[data-session]', { timeout: 20_000 });
      const id = (await page.getAttribute('[data-session]', 'data-session'))!;
      await idleSession(id);
      const d = (await api('GET', `/api/sessions/${id}`)).body as { history: Array<{ role: string; content: Array<{ type: string; name?: string; input?: { type?: string }; content?: string }> }> };
      const call = d.history.flatMap((m) => m.content).find((b) => b.type === 'tool_use' && b.name === 'agent');
      assert.equal(call?.input?.type, 'security-reviewer');
      const result = d.history.flatMap((m) => m.content).find((b) => b.type === 'tool_result');
      assert.ok(result && !/Unknown|not available/i.test(String(result.content)), String(result?.content));
      await page.waitForFunction(() => /security-reviewer: security review/.test(document.querySelector('[data-session]')?.textContent ?? ''), undefined, { timeout: 15_000 });
      await shot('agent-delegated', page.locator('[data-session]'));
    });

    await step('an agent sets one up for the person: it opens the builder filled in (approved first), and nothing is made until the person saves', async () => {
      await page.click('[data-nav="core.chat:new"]');
      await page.waitForSelector('[data-home]');
      const box = page.locator('[data-composer-input]').first();
      await box.fill('makeagent: an agent that writes tests for my changes');
      await box.press('Enter');
      const pending = await page.waitForSelector('[data-attention] [data-pending="permission_request"]', { timeout: 20_000 });
      await (await pending.$('[data-decision="allow"]'))!.click();
      await page.waitForSelector('[data-agent-form="new"]', { timeout: 20_000 });
      assert.equal(await page.inputValue('[data-agent-name]'), 'test-writer');
      assert.equal(await page.inputValue('[data-agent-description]'), 'Writes unit tests for a change and runs them.');
      assert.equal(await page.getAttribute('[data-choice="agent-mode"] [aria-checked="true"]', 'data-value'), 'acceptEdits');
      assert.ok(!(await mine()).some((a) => a.name === 'test-writer'), 'not made yet');
      await page.click('[data-agent-save]');
      await card('test-writer').waitFor({ timeout: 15_000 });
      const tw = (await mine()).find((a) => a.name === 'test-writer')!;
      assert.deepEqual(tw.tools?.sort(), ['bash', 'read', 'write']);
    });

    await step('deleted from its menu; gone from the catalogue', async () => {
      await openMine();
      await card('doc-writer').locator('[data-agent-more]').click();
      await page.getByRole('menuitem', { name: 'Delete' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
      await card('doc-writer').waitFor({ state: 'detached', timeout: 15_000 });
      assert.deepEqual((await mine()).map((a) => a.name).sort(), ['security-reviewer', 'test-writer']);
    });

    await step('no errors in the window', async () => {
      assert.deepEqual(errors, []);
    });
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(data, { recursive: true, force: true });
  }
});
