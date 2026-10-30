// Harness Desktop end to end, the agent platform (docs/desktop/DESIGN.md sections 11-13): the
// real Electron app against a scripted engine (test/fixtures/desktop/scripted-agents-engine.ts:
// nothing is spent), driven with playwright-core. Artifacts (panel, versions, diff, full window,
// Library), agents (sub-agents, linked sessions, proposals, reports, chapters, split view, the
// Agents panel and page), the desktop tools answered for real, ask_user forms, delegation, the
// workflow graph, and the phase-1 gaps. Skipped when Electron cannot start here.
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

const bundle = (title: string, history: unknown[]) => ({
  format: 'harness-session', version: 1, exportedAt: Date.now(),
  source: { id: 'x', title, model: 'deepseek-flash', effort: 'medium', mode: 'default', tainted: false, todos: [], contextStart: 0, compactions: 0, lastPromptTokens: 0, cost: 0 },
  history, files: [], skipped: [],
});

const WORKFLOW = {
  name: 'ship-graph', description: 'Plan, approve, build', start: 'plan',
  nodes: {
    plan: { type: 'agent', agent: 'general', title: 'Plan', prompt: 'Plan the release of {{input.request}}', next: 'approve' },
    approve: { type: 'approval', title: 'Approve the plan', message: 'Ship this plan?', next: { on: { approve: 'build', reject: 'plan' } } },
    build: { type: 'agent', agent: 'general', title: 'Build', prompt: 'Build it', next: 'done' },
    done: { type: 'end', status: 'success' },
  },
};

test('desktop app end to end: the agent platform', { timeout: 15 * 60_000 }, async (t) => {
  if (!fs.existsSync(electronExe)) { t.skip('Electron is not installed'); return; }
  let pw: typeof import('playwright-core');
  try { pw = await import('playwright-core'); } catch { t.skip('playwright-core is not installed'); return; }
  const failed = ensureBuilt();
  if (failed) assert.fail(failed);

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-e2e-ag-'));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_API_KEY$|^GW_|^HARNESS_/.test(k)) env[k] = v;
  Object.assign(env, { HARNESS_DESKTOP_DATA: data, HARNESS_DESKTOP_TEST: '1', ...(process.env.HARNESS_E2E_SHOW ? { HARNESS_E2E_SHOW: process.env.HARNESS_E2E_SHOW } : {}), HARNESS_DESKTOP_ENGINE: path.join(root, 'test', 'fixtures', 'desktop', 'scripted-agents-engine.ts'), HARNESS_DESKTOP_NO_TRAY: '1', HARNESS_PLUGIN_LOOPS: 'off' });
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
      await capture(app).then((png) => fs.writeFileSync(path.join(os.tmpdir(), `hd-e2e-ag-fail-${name.slice(0, 40).replace(/[^a-z0-9]+/gi, '-')}.png`), png)).catch(() => {});
      for (let i = 0; i < 3; i++) await page.keyboard.press('Escape').catch(() => {});
      throw e;
    }
  });

  try {
    await step('the app starts and tells new sessions what it renders, which desktop tools it serves and its agent-callable commands', async () => {
      await ready();
      await page.waitForSelector('[data-home]');
      // With keys for both providers the first run recommends Claude Sonnet 5.5; these steps run on DeepSeek
      // (delegating to Claude), with edits accepted (artifacts) and everything else asked.
      await page.waitForFunction(() => !!document.querySelector('[data-work-in]'));
      await invoke('prefs:set', { defaultModel: 'deepseek-flash', defaultMode: 'acceptEdits', onboardingDone: true });
      await page.waitForSelector('[data-nav="core.artifacts:library"]');
      await page.waitForSelector('[data-nav="core.agents:agents"]');
    });

    let artId = '';
    let artSession = '';
    await step('artifacts: a card in the transcript opens the panel; versions, the diff between them, code, full window', async () => {
      artSession = await startChat('make an artifact for the launch plan');
      await idle(artSession);
      const card = await page.waitForSelector('[data-artifact-ref]', { timeout: 30_000 });
      artId = (await card.getAttribute('data-artifact-ref'))!;
      assert.equal(await card.getAttribute('data-artifact-version'), '2');
      // The client declaration: the tools and the agent-callable commands, compact.
      const meta = (await api('GET', `/api/sessions/${artSession}`)).body.meta;
      assert.deepEqual(meta.client.tools, ['desktop_command', 'desktop_describe', 'desktop_notify', 'desktop_open']);
      const cmds = (meta.client.commands as Array<{ id: string }>).map((c) => c.id);
      for (const c of ['core.shell:set-theme', 'core.shell:open-view', 'core.chat:new', 'core.settings:open', 'core.artifacts:library', 'core.agents:page']) assert.ok(cmds.includes(c), c);
      const { plugins: index, ...decl } = meta.client as { plugins?: Array<{ name: string }> };
      assert.ok(JSON.stringify(decl).length < 4000, `the declaration is compact (${JSON.stringify(decl).length})`);
      // Its plugin index (one line each in the prompt; the guides are skills): the built-ins with a guide.
      for (const p of ['core.agents', 'core.artifacts', 'core.chat', 'core.dashboards', 'core.diagrams', 'core.settings']) assert.ok(index?.some((x) => x.name === p), p);
      assert.ok(JSON.stringify(index).length < 3000, `the plugin index is compact (${JSON.stringify(index).length})`);
      await card.click();
      await page.waitForSelector(`[data-side-panel] [data-artifact-detail="${artId}"][data-version="2"]`);
      await page.waitForSelector('[data-side-panel] iframe[data-artifact-frame="html"]');
      assert.doesNotMatch(String(await page.getAttribute('[data-side-panel] iframe[data-artifact-frame="html"]', 'sandbox')), /allow-same-origin/);
      await shot('artifacts-panel');
      await page.locator('[data-side-panel] [data-version-picker]').selectOption('1');
      await page.waitForSelector(`[data-artifact-detail="${artId}"][data-version="1"]`);
      await page.locator('[data-side-panel] [data-version-picker]').selectOption('2');
      await page.click('[data-side-panel] [role="tab"]:has-text("Changes")');
      const diff = await page.waitForSelector('[data-artifact-diff]');
      assert.match(await diff.innerText(), /Launch plan v1[\s\S]*Launch plan v2|Launch plan v2[\s\S]*Launch plan v1/);
      await shot('artifacts-versions-diff', page.locator('[data-side-panel]'));
      await page.click('[data-side-panel] [role="tab"]:has-text("Code")');
      await page.waitForSelector('[data-side-panel] [data-block="code"]');
      await page.click('[data-side-panel] [role="tab"]:has-text("Preview")');
      await page.click('[data-open-full]');
      await page.waitForSelector('[data-full-window] iframe[data-artifact-frame="html"]');
      await shot('artifact-full-window');
      await page.keyboard.press('Escape');
      await page.waitForSelector('[data-full-window]', { state: 'detached' });
      // The panel lists every artifact of the conversation.
      await page.click('[data-side-panel] button[aria-label="All artifacts"]');
      await page.waitForSelector(`[data-artifact-item="${artId}"]`);
    });

    await step('the Library: across conversations, grid and list, a kind filter and search', async () => {
      await page.click('[data-nav="core.artifacts:library"]');
      await page.waitForSelector(`[data-library-item="${artId}"]`);
      assert.equal((await page.locator('[data-crumbs] [data-crumb-parent]').innerText()).trim(), 'Agents', 'the Library sits in the Agents module: Agents > Library');
      assert.equal((await page.locator('[data-crumbs] [data-breadcrumb]').innerText()).trim(), 'Library');
      await shot('library-grid');
      await page.click('button[aria-label="Show as a list"]');
      await page.waitForSelector('[data-library-layout="list"]');
      await page.locator('[data-library-kind]').selectOption('markdown');
      await page.waitForSelector(`[data-library-item="${artId}"]`, { state: 'detached' });
      await page.locator('[data-library-kind]').selectOption('html');
      await page.waitForSelector(`[data-library-item="${artId}"]`);
      await page.fill('[data-library-search]', 'nothing-like-this');
      await page.waitForSelector(`[data-library-item="${artId}"]`, { state: 'detached' });
      await page.fill('[data-library-search]', 'launch');
      await page.waitForSelector(`[data-library-item="${artId}"]`);
      await shot('library-list');
      await page.click(`[data-library-item="${artId}"]`);
      await page.waitForSelector(`[data-session="${artSession}"]`);
      await page.waitForSelector(`[data-side-panel] [data-artifact-detail="${artId}"]`);
      await page.click('[data-side-panel] button[aria-label="Close the panel"]');
    });

    let agentsSession = '';
    await step('agents: a sub-agent, a linked session started and reporting, a proposal started from its card, chapters, the Agents panel', async () => {
      agentsSession = await startChat('run the agents demo');
      await page.waitForSelector('[data-proposal][data-proposal-status="open"]', { timeout: 40_000 });
      await page.waitForSelector('[data-link][data-link-phase="started"]');
      await idle(agentsSession);
      // The task list is a card in the conversation while some of it is open.
      assert.equal(await page.locator('[data-task-card] li').count(), 3, 'the task card');
      assert.equal(await page.locator('[data-task-card] li[data-todo-status="in_progress"]').count(), 1);
      await shot('task-card', page.locator('[data-task-card]'));
      await page.waitForSelector('[data-link][data-link-phase="report"]', { timeout: 40_000 });
      await shot('proposal-and-report-cards', page.locator('[data-virtual-list]'));
      // Chapters: a floating table of contents.
      await page.click('[data-toc-toggle]');
      await page.waitForSelector('[data-toc-list]');
      const toc = await page.$$eval('[data-toc-entry]', (els) => els.map((e) => e.textContent ?? ''));
      assert.equal(toc.length, 2);
      assert.match(toc[0]!, /^1Exploration/);
      assert.match(toc[1]!, /^2Delegation/);
      await shot('chapters-toc');
      await page.click('[data-toc-entry="1"]');
      await page.waitForSelector('[data-toc-list]', { state: 'detached' });
      await page.waitForSelector('[data-chapter="1"]');
      // The Agents panel.
      await openPanel('core.agents:agents');
      const panel = await page.waitForSelector(`[data-agents-panel="${agentsSession}"]`);
      await page.waitForSelector('[data-agents-panel] [data-subagent]');
      assert.match(await (await page.$('[data-agents-panel] [data-subagent]'))!.innerText(), /explore/);
      assert.equal(await page.locator('[data-agents-panel] [data-todos] li').count(), 3, 'the todo list');
      await page.waitForSelector('[data-agents-panel] [data-linked-session]');
      await page.waitForSelector('[data-agents-panel] [data-panel-proposal]');
      await page.waitForSelector('[data-agents-panel] [data-cost-by-model] [data-model-cost="deepseek-flash"]');
      assert.ok(panel);
      await shot('agents-panel');
      // Start the offered session from its card: it runs and reports back.
      await page.click('[data-proposal-start]');
      await page.waitForSelector('[data-proposal][data-proposal-status="started"]', { timeout: 20_000 });
      await page.waitForFunction(() => document.querySelectorAll('[data-link][data-link-phase="report"]').length >= 2, null, { timeout: 45_000 });
      await page.waitForFunction(() => document.querySelectorAll('[data-agents-panel] [data-linked-session]').length >= 2, null, { timeout: 20_000 });
      await page.waitForSelector('[data-user-message="auto"]', { timeout: 30_000 });
      await shot('agents-panel-linked', page.locator('[data-side-panel]'));
    });

    await step('split view: a linked conversation beside this one, resizable and closeable; the Agents page', async () => {
      await page.click('[data-side-panel] button[aria-label="Close the panel"]');
      await page.locator('[data-link][data-link-phase="report"] [data-link-split]').first().click();
      const split = await page.waitForSelector('[data-split-view="core.chat:session"]');
      await page.waitForSelector('[data-split-view] [data-session] [data-assistant-message]', { timeout: 20_000 });
      const w0 = (await split.boundingBox())!.width;
      await page.focus('[data-split-handle]');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      await page.waitForFunction((w) => (document.querySelector('[data-split-view]') as HTMLElement).getBoundingClientRect().width > w + 40, w0);
      await shot('split-view');
      await page.click('[data-split-view] [data-close-split]');
      await page.waitForSelector('[data-split-view]', { state: 'detached' });
      await page.click('[data-nav="core.agents:agents"]');
      await page.waitForSelector('[data-agents-page]');
      await shot('agents-page');
    });

    let deskSession = '';
    await step('desktop tools: the agent describes the app, opens the Library and the Agents panel, notifies, and runs a command (asked first)', async () => {
      await page.evaluate(() => { const w = window as unknown as { __toasts: string[] }; w.__toasts = []; new MutationObserver(() => { for (const el of document.querySelectorAll('[data-toast]')) { const s = (el as HTMLElement).innerText; if (!w.__toasts.includes(s)) w.__toasts.push(s); } }).observe(document.body, { childList: true, subtree: true }); });
      deskSession = await startChat('take the desktop tour');
      // The agent opens the Library and the Agents panel on its conversation.
      await page.waitForSelector('[data-library]', { timeout: 30_000 });
      await page.waitForSelector(`[data-side-panel] [data-agents-panel="${deskSession}"]`, { timeout: 20_000 });
      await page.waitForFunction(() => (window as unknown as { __toasts: string[] }).__toasts.some((x) => /Library opened/.test(x)), null, { timeout: 20_000 });
      await shot('desktop-tools-open');
      // desktop_command is asked first (it acts in the person's app): approve it in the conversation.
      await page.click(`[data-session-row="${deskSession}"] button`);
      const ask = await page.waitForSelector('[data-attention] [data-pending="permission_request"]', { timeout: 30_000 });
      assert.match(await ask.innerText(), /desktop_command/);
      await (await ask.$('[data-decision="allow"]'))!.click();
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark', null, { timeout: 20_000 });
      await idle(deskSession);
      const last = await page.locator('[data-assistant-message]').last().innerText();
      assert.match(last, /Done\. The app answered: Theme set to dark/);
      const hist = JSON.stringify((await api('GET', `/api/sessions/${deskSession}`)).body.history);
      const n = Number(/The app has (-?\d+) agent-callable commands/.exec(hist)?.[1]);
      assert.ok(n >= 6, `desktop_describe listed the agent-callable commands (${n})`);
      // Every call was answered (none timed out or was declined).
      const calls = (await api('GET', `/api/sessions/${deskSession}`)).body.history.flatMap((m: { content: Array<{ type: string; content?: string; is_error?: boolean }> }) => m.content.filter((b) => b.type === 'tool_result'));
      assert.equal(calls.filter((b: { is_error?: boolean }) => b.is_error).length, 0, JSON.stringify(calls.filter((b: { is_error?: boolean }) => b.is_error)));
      await shot('desktop-tools-done');
      await invoke('prefs:set', { theme: 'light' });
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    });

    await step('ask_user with a form: drawn natively, the answer sent as an object', async () => {
      const id = await startChat('show me the form');
      const form = await page.waitForSelector('[data-attention] [data-question-form]', { timeout: 30_000 });
      assert.ok(await form.$('[data-field="seats"]'));
      await page.click('[data-question-form] [data-submit-form]');
      await page.waitForSelector('[data-question-form] [data-field="name"] [role="alert"], [data-question-form] [data-field="name"] .text-hx-danger', { timeout: 5_000 }).catch(() => {});
      assert.ok(await page.locator('[data-attention] [data-question-form]').count(), 'a required field keeps the form open');
      // Suggested answers with what each does (the recommended one marked), tick boxes for several choices.
      assert.match(await page.locator('[data-question-form] [data-question-choices]').innerText(), /The core team\s*Recommended[\s\S]*Decide for me/);
      await page.locator('[data-question-form] [data-field="regions"] [data-choice="us"] input').check();
      await page.click('[data-question-form] [data-field="name"] [data-suggestion="Ada Lovelace"]');
      assert.equal(await page.locator('[data-question-form] [data-field="name"] input').inputValue(), 'Ada Lovelace');
      await page.locator('[data-question-form] [data-own-words]').fill('Ship it before Friday');
      await shot('ask-user-form', page.locator('[data-attention]'));
      // Review what will be sent, then send it.
      await page.click('[data-question-form] [data-review-answers]');
      const review = await page.locator('[data-question-form] [data-answer-review]').innerText();
      assert.match(review, /Ada Lovelace[\s\S]*Team[\s\S]*Europe, United States[\s\S]*Ship it before Friday/);
      await shot('ask-user-review', page.locator('[data-attention]'));
      await page.click('[data-question-form] [data-submit-form]');
      await idle(id);
      await page.waitForSelector('[data-assistant-message]:has-text("Ada Lovelace")');
    });

    await step('delegation: allowed in Settings, a review sub-agent runs on Claude, cost per model in the usage panel and the Agents panel', async () => {
      await page.keyboard.press('Control+Comma');
      await page.click('[data-settings-section="core.settings:models"]');
      await page.waitForSelector('[data-delegation]');
      await page.locator('[data-delegation-model="claude-sonnet-5-5"] input').check();
      await page.locator('[data-delegation] [role="switch"]').nth(1).click();
      await page.click('[data-save-delegation]');
      await page.waitForFunction(async () => { const r = await fetch('/api/me/settings'); const j = await r.json(); return Array.isArray(j.delegation?.allowedModels) && j.delegation.allowedModels.includes('claude-sonnet-5-5'); }, null, { timeout: 10_000 });
      await page.locator('[data-delegation]').scrollIntoViewIfNeeded();
      await shot('settings-delegation', page.locator('[data-delegation]'));
      await page.keyboard.press('Escape');
      const id = await startChat('delegate a review of the change');
      // requireApproval: the first hand-off to Anthropic is asked.
      const ask = await page.waitForSelector('[data-attention] [data-pending="permission_request"]', { timeout: 30_000 });
      assert.match(await ask.innerText(), /delegate|anthropic/i);
      await (await ask.$('[data-decision="allow"]'))!.click();
      await idle(id);
      await page.waitForSelector('[data-assistant-message]:has-text("reviewed on claude-sonnet-5-5")');
      await page.click('[data-session-meter] [data-cost]');
      await page.waitForSelector('[data-usage-panel] [data-model-cost="claude-sonnet-5-5"]');
      await page.waitForSelector('[data-usage-panel] [data-model-cost="deepseek-flash"]');
      await shot('usage-by-model', page.locator('[data-usage-panel]'));
      await page.keyboard.press('Escape');
      await openPanel('core.agents:agents');
      await page.waitForSelector('[data-agents-panel] [data-subagent-model]:has-text("claude-sonnet-5-5")');
      await page.waitForSelector('[data-agents-panel] [data-model-cost="claude-sonnet-5-5"]');
      await shot('agents-panel-delegation', page.locator('[data-side-panel]'));
      await page.click('[data-side-panel] button[aria-label="Close the panel"]');
    });

    await step('a workflow added after the session started is offered and runs, drawn as a graph; a node opens its output', async () => {
      await page.click(`[data-session-row="${agentsSession}"] button`);
      await page.waitForSelector(`[data-session="${agentsSession}"]`);
      const ws = (await api('GET', `/api/sessions/${agentsSession}`)).body.meta.runtime.path as string;
      fs.mkdirSync(path.join(ws, '.harness', 'workflows'), { recursive: true });
      fs.writeFileSync(path.join(ws, '.harness', 'workflows', 'ship-graph.json'), JSON.stringify(WORKFLOW));
      await page.click('[aria-label="Run a workflow"]');
      await page.click('[data-workflow-dialog] [data-workflow-option="ship-graph"]');
      await page.waitForSelector('[data-workflow-detail="ship-graph"] [data-workflow-steps]');
      await page.click('[data-start-workflow]');
      await page.waitForSelector('[data-workflow="ship-graph"] [data-workflow-graph]', { timeout: 20_000 });
      await page.waitForSelector('[data-attention] [data-pending="approval_request"]', { timeout: 30_000 });
      await page.waitForSelector('[data-graph-node="plan"][data-node-status="done"]');
      await page.waitForSelector('[data-graph-node="approve"][data-node-status="waiting"]');
      await page.click('[data-attention] [data-pending="approval_request"] button:has-text("Approve")');
      await page.waitForSelector('[data-workflow="ship-graph"][data-status="succeeded"]', { timeout: 30_000 });
      // Done: folded to its header; shown again on a click.
      await page.waitForSelector('[data-workflow="ship-graph"][data-expanded="0"]');
      await page.click('[data-workflow="ship-graph"] [data-workflow-show]');
      await page.locator('[data-workflow="ship-graph"]').scrollIntoViewIfNeeded();
      await page.click('[data-graph-node="build"]');
      await page.waitForSelector('[data-graph-output="build"]:has-text("Done: Build it")');
      await shot('workflow-graph', page.locator('[data-workflow="ship-graph"]'));
    });

    await step('gaps: breadcrumbs, Ctrl+B in a narrow window, Graphviz in dark, notebook HTML in the page', async () => {
      await page.click('[data-nav="core.plugins:plugins"]');
      assert.equal((await page.locator('[data-crumbs]').innerText()).trim(), 'Plugins', 'not "Plugins > Plugins"');
      await setSize(620, 760);
      await page.waitForTimeout(400);
      await page.locator('[data-statusbar]').click();
      await page.keyboard.press('Control+B');
      await page.waitForSelector('[data-floating-sidebar]');
      await shot('narrow-sidebar-ctrl-b');
      await page.keyboard.press('Control+B');
      await page.waitForSelector('[data-floating-sidebar]', { state: 'detached' });
      await setSize(1360, 860);
      const dot = '```dot\ndigraph G { a -> b; b [style=filled, fillcolor=lightblue]; }\n```\n\n```ipynb\n' + JSON.stringify({ nbformat: 4, metadata: {}, cells: [{ cell_type: 'code', source: 'df', outputs: [{ output_type: 'execute_result', data: { 'text/html': '<table class="dataframe"><thead><tr><th>region</th><th>revenue</th></tr></thead><tbody><tr><td>eu</td><td>3590</td></tr></tbody></table><script>parent.alert(1)</script>' } }] }] }) + '\n```';
      const r = await api('POST', '/api/sessions/import', { runtime: 'local', bundle: bundle('Graph in the dark', [{ role: 'user', content: [{ type: 'text', text: 'Draw it' }] }, { role: 'assistant', content: [{ type: 'text', text: dot }] }]) });
      assert.equal(r.status, 201);
      await invoke('prefs:set', { theme: 'dark' });
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
      await page.click(`[data-session-row="${r.body.id}"] button`);
      const svg = await page.waitForSelector('[data-graphviz="svg"] svg', { timeout: 30_000 });
      const look = await svg.evaluate((el) => {
        const bg = el.querySelector('g.graph > polygon');
        const text = [...el.querySelectorAll('g.node text')].map((t) => getComputedStyle(t).fill);
        return { bg: bg?.getAttribute('fill'), text, page: getComputedStyle(document.body).backgroundColor };
      });
      assert.equal(look.bg, 'none', 'the white page is gone');
      assert.notEqual(look.text[0], 'rgb(0, 0, 0)', `text in the theme colour (${look.text.join(', ')})`);
      await shot('graphviz-dark', page.locator('[data-widget="Graph"]').first());
      await page.waitForSelector('[data-notebook-html] table');
      assert.equal(await page.locator('iframe[data-artifact-frame="notebook-html"]').count(), 0);
      assert.doesNotMatch(await page.locator('[data-notebook-html]').innerHTML(), /script/);
      await shot('notebook-html-dark', page.locator('[data-widget="Notebook"]').first());
      await invoke('prefs:set', { theme: 'light' });
    });

    await step('product: About with versions, the keyboard shortcuts sheet, a failing page shows its card with Disable', async () => {
      await page.keyboard.press('Control+K');
      await page.keyboard.type('Help: About');
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-about-page] [data-about-row="Electron"]');
      assert.match(await page.locator('[data-about-row="App"]').innerText(), /Harness \d/);
      assert.match(await page.title(), /^About - Harness$/, 'the window title follows the page');
      await shot('about');
      await page.keyboard.press('Control+/');
      await page.waitForSelector('[data-shortcuts] [data-shortcut="core.chat:new"]');
      await page.waitForSelector('[data-shortcuts] [data-shortcut="core.agents:panel"]');
      await shot('keyboard-shortcuts');
      await page.keyboard.press('Escape');
      await page.waitForSelector('[data-shortcuts]', { state: 'detached' });
      await page.evaluate(() => { (globalThis as { __harnessCrashView?: string }).__harnessCrashView = 'core.agents:agents'; });
      await page.click('[data-nav="core.agents:agents"]');
      const card = await page.waitForSelector('[data-failed-plugin="core.agents"]');
      assert.match(await card.innerText(), /failed on purpose/);
      assert.ok(await page.locator('[data-sidebar]').isVisible(), 'never a blank window');
      await shot('error-card');
      await page.evaluate(() => { delete (globalThis as { __harnessCrashView?: string }).__harnessCrashView; });
      await page.click('[data-disable-plugin="core.agents"]');
      await page.waitForSelector('[data-nav="core.agents:agents"]', { state: 'detached' });
      await page.waitForSelector('[data-home]');
      assert.deepEqual(((await invoke('prefs:get')) as { disabledPlugins: string[] }).disabledPlugins, ['core.agents']);
      await invoke('prefs:set', { disabledPlugins: [] });
      await page.waitForSelector('[data-nav="core.agents:agents"]');
    });

    const unexpected = errors.filter((e) => !/Failed to load resource.*(404|409)/.test(e.text) && !/failed on purpose/.test(e.text) && !/The above error occurred/.test(e.text));
    assert.deepEqual(unexpected, [], 'no unexpected errors in the window');
  } finally {
    await app.close().catch(() => {});
    try { fs.rmSync(data, { recursive: true, force: true, maxRetries: 3 }); } catch { /* in use (Windows) */ }
  }
});
