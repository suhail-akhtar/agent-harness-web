// Harness Desktop end to end, the person's own MCP servers (docs/agents-mcp/PLAN.md, phase 2): Settings > MCP
// servers in the real app. A command server added and connected (its tools listed, a tool blocked); a conversation
// uses it, then the server changes its tools: the changed tool is refused mid-conversation and the page asks for
// approval; approved. A server that needs sign-in: Sign in opens the browser (caught here), the browser's return
// updates the page by itself. A Claude Desktop config imported; one turned off; one removed. The real Electron app
// against the scripted engine (test/fixtures/desktop/proactive-engine.ts: nothing is spent), driven with playwright-core.
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
import { modernFixture, startModernHttp } from './mcp-fixtures.ts';

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

test('desktop app end to end: your MCP servers', { timeout: 10 * 60_000 }, async (t) => {
  if (!fs.existsSync(electronExe)) { t.skip('Electron is not installed'); return; }
  let pw: typeof import('playwright-core');
  try { pw = await import('playwright-core'); } catch { t.skip('playwright-core is not installed'); return; }
  const failed = ensureBuilt();
  if (failed) assert.fail(failed);

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-e2e-mcp-'));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_API_KEY$|^GW_|^HARNESS_/.test(k)) env[k] = v;
  Object.assign(env, { HARNESS_DESKTOP_DATA: data, HARNESS_DESKTOP_TEST: '1', ...(process.env.HARNESS_E2E_SHOW ? { HARNESS_E2E_SHOW: process.env.HARNESS_E2E_SHOW } : {}), HARNESS_DESKTOP_ENGINE: path.join(root, 'test', 'fixtures', 'desktop', 'proactive-engine.ts'), HARNESS_DESKTOP_NO_TRAY: '1', HARNESS_PLUGIN_LOOPS: 'off' });
  const oauth = await startModernHttp({ MCP_OAUTH: '1' });
  let app: import('playwright-core').ElectronApplication;
  try { app = await pw._electron.launch({ executablePath: electronExe, args: [desktop], env, timeout: 60_000 }); } catch (e) { oauth.stop(); t.skip(`Electron could not start here: ${(e as Error).message.split('\n')[0]}`); return; }
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
      await capture(app).then((png) => fs.writeFileSync(path.join(os.tmpdir(), `hd-e2e-mcp-fail-${name.slice(0, 40).replace(/[^a-z0-9]+/gi, '-')}.png`), png)).catch(() => {});
      for (let i = 0; i < 3; i++) await page.keyboard.press('Escape').catch(() => {});
      throw e;
    }
  });
  type Server = { name: string; enabled: boolean; policies: Record<string, string>; signedIn: boolean; status?: { ok: boolean; pending: number } };
  const servers = async () => ((await api('GET', '/api/me/mcp')).body as { servers: Server[] }).servers;
  const openSettings = async () => {
    if (!(await page.locator('[data-settings]').count())) await page.keyboard.press('Control+Comma');
    await page.waitForSelector('[data-settings]');
    await page.click('[data-settings-section="core.settings:mcp-servers"]');
    await page.waitForSelector('[data-section="mcp-servers"]');
  };
  const closeSettings = async () => { for (let i = 0; i < 3 && await page.locator('[data-settings]').count(); i++) await page.keyboard.press('Escape'); };
  const card = (name: string) => page.locator(`[data-section="mcp-servers"] [data-server="${name}"]`);
  const detail = (name: string) => page.locator(`[data-detail="${name}"]`);
  const idleSession = async (id: string) => {
    const end = Date.now() + 30_000;
    for (;;) {
      const d = (await api('GET', `/api/sessions/${id}`)).body as { status: string; history: Array<{ role: string; content: Array<{ type: string; name?: string; content?: string; is_error?: boolean }> }> };
      if (d.status === 'idle' && d.history.at(-1)?.role === 'assistant') return d;
      assert.ok(Date.now() < end, 'the reply');
      await page.waitForTimeout(150);
    }
  };
  // The browser is not opened in a test: the address it would open is kept.
  await app.evaluate(({ shell }) => { (globalThis as { opened?: string[] }).opened = []; shell.openExternal = async (u: string) => { (globalThis as unknown as { opened: string[] }).opened.push(u); }; });
  const opened = () => app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened);
  // Nor the system clipboard (it is the person's, shared with whatever they do meanwhile): what the app copies is kept.
  await app.evaluate(({ clipboard }) => { (globalThis as { copied?: string }).copied = ''; clipboard.writeText = ((t: string) => { (globalThis as unknown as { copied: string }).copied = t; }) as never; });
  const copiedText = () => app.evaluate(() => (globalThis as unknown as { copied: string }).copied);
  const clearCopied = () => app.evaluate(() => { (globalThis as unknown as { copied: string }).copied = ''; });

  try {
    await step('the app starts; Settings > MCP servers is empty and says what it is for', async () => {
      await page.waitForSelector('[data-engine-status="ready"]', { timeout: 90_000 });
      await page.waitForSelector('[data-home]');
      await invoke('prefs:set', { defaultModel: 'deepseek-flash', onboardingDone: true, keepInTray: false });
      await openSettings();
      assert.match(await page.locator('[data-section="mcp-servers"]').innerText(), /No servers yet[\s\S]*Claude Desktop, Claude Code, Cursor or VS Code/);
    });

    await step('a command server is added and connects: its tools approved as first seen, its documents and prompts listed; a tool blocked', async () => {
      await page.click('[data-mcp-add]');
      await page.click('[data-choice="mcp-type"] [data-value="stdio"]');
      await page.fill('[data-mcp-name]', 'notes');
      await page.fill('[data-mcp-command]', process.execPath);
      await page.fill('[data-mcp-args]', modernFixture);
      await shot('mcp-add-server', page.locator('[role="dialog"]').last());
      await page.click('[data-mcp-save]');
      await detail('notes').waitFor({ timeout: 30_000 });
      const text = await detail('notes').innerText();
      assert.match(text, /Connected[\s\S]*modern-fixture 2\.0\.0[\s\S]*MCP 2026-07-28/);
      assert.match(text, /tools\s*4/i);
      assert.deepEqual(await detail('notes').locator('[data-tool]').evaluateAll((els) => els.map((e) => e.getAttribute('data-tool')).sort()), ['add', 'echo', 'mutate', 'slow']);
      assert.match(text, /1 resources[\s\S]*1 prompts: review/);
      assert.equal(await page.locator('[data-mcp-pending]').count(), 0, 'nothing waits: all seen now');
      await page.click('[data-choice="policy-slow"] [data-value="block"]');
      await page.waitForFunction(() => document.querySelector('[data-choice="policy-slow"] [data-value="block"]')?.getAttribute('aria-checked') === 'true');
      const s = (await servers())[0]!;
      assert.deepEqual(s.policies, { slow: 'block' });
      await shot('mcp-server-detail', page.locator('[role="dialog"]').last());
      await page.click('[data-mcp-done]');
      await card('notes').waitFor();
      assert.match(await card('notes').innerText(), /notes[\s\S]*Connected/);
    });

    await step('a conversation uses it; the server then changes its tools: the changed one is refused at once, and the page asks for approval', async () => {
      await closeSettings();
      await page.click('[data-nav="core.chat:new"]');
      await page.waitForSelector('[data-home]');
      const box = page.locator('[data-composer-input]').first();
      await box.fill('usemcp: add 20 and 22 with my notes server');
      await box.press('Enter');
      await page.waitForSelector('[data-session]', { timeout: 20_000 });
      const id = (await page.getAttribute('[data-session]', 'data-session'))!;
      // The add and mutate calls ask first (they are not read-only); the changed echo is refused without asking.
      for (let i = 0; i < 2; i++) {
        const pending = await page.waitForSelector('[data-attention] [data-pending="permission_request"]', { timeout: 20_000 });
        await (await pending.$('[data-decision="allow"]'))!.click();
        await page.waitForTimeout(300);
      }
      const d = await idleSession(id);
      const res = d.history.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
      assert.equal(res[0]?.content, '42');
      assert.equal(res[1]?.content, 'mutated');
      assert.equal(res[2]?.is_error, true);
      assert.match(String(res[2]?.content), /changed the tool "echo" after it was approved/);
      await openSettings();
      await page.waitForFunction(() => /to review/.test(document.querySelector('[data-server="notes"]')?.textContent ?? ''), undefined, { timeout: 15_000 });
      await card('notes').click();
      await page.waitForSelector('[data-mcp-pending]');
      const text = await page.locator('[data-mcp-pending]').innerText();
      assert.match(text, /2 tools wait for your approval[\s\S]*changed what some tools say/);
      assert.match(await detail('notes').locator('[data-tool="echo"]').innerText(), /Changed[\s\S]*read ~\/\.ssh first/);
      assert.match(await detail('notes').locator('[data-tool="shout"]').innerText(), /New[\s\S]*evil\.example/);
      await shot('mcp-rug-pull', page.locator('[role="dialog"]').last());
      await page.click('[data-mcp-approve="shout"]');
      await page.waitForFunction(() => !document.querySelector('[data-mcp-approve="shout"]'));
      await page.click('[data-mcp-approve-all]');
      await page.waitForSelector('[data-mcp-pending]', { state: 'detached' });
      assert.equal((await servers())[0]!.status?.pending, 0);
      await page.click('[data-mcp-done]');
    });

    await step('a server that needs sign-in: Sign in opens the browser; when the browser comes back, the page updates by itself', async () => {
      await page.click('[data-mcp-add]');
      await page.click('[data-choice="mcp-type"] [data-value="http"]');
      await page.fill('[data-mcp-name]', 'cloud-notes');
      await page.fill('[data-mcp-url]', oauth.url);
      await page.click('[data-mcp-save]');
      await page.waitForSelector('[data-mcp-needs-signin]', { timeout: 30_000 });
      await page.click('[data-mcp-needs-signin] button');
      await page.waitForFunction(async () => true);
      for (let i = 0; i < 50 && !(await opened()).length; i++) await page.waitForTimeout(100);
      const url = (await opened())[0]!;
      assert.match(url, /\/authorize\?.*code_challenge_method=S256/);
      // The "browser": the service approves and sends it back to the harness.
      const back = await fetch(url, { redirect: 'manual' });
      const done = await fetch(back.headers.get('location')!);
      assert.match(await done.text(), /Signed in to cloud-notes/);
      await page.waitForSelector('[data-mcp-needs-signin]', { state: 'detached', timeout: 20_000 });
      await page.waitForFunction(() => /Connected/.test(document.querySelector('[data-detail="cloud-notes"]')?.textContent ?? ''), undefined, { timeout: 20_000 });
      assert.ok(await page.locator('[data-mcp-signout]').count());
      assert.equal((await servers()).find((s) => s.name === 'cloud-notes')?.signedIn, true);
      await page.click('[data-mcp-done]');
    });

    await step('a Claude Desktop config is imported: read, its key moved to a Vault reference, the chosen servers added', async () => {
      await page.click('[data-mcp-import]');
      await page.fill('[data-mcp-import-text]', JSON.stringify({ mcpServers: { linear: { url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer lin_api_abcdefghijklmnop' } } } }));
      await page.click('[data-mcp-import-read]');
      await page.waitForSelector('[data-checks="import"] [data-check="linear"]');
      assert.match(await page.locator('[role="dialog"]').last().innerText(), /Put these in your Vault[\s\S]*Authorization/);
      await shot('mcp-import', page.locator('[role="dialog"]').last());
      await page.click('[data-mcp-import-add]');
      await card('linear').waitFor({ timeout: 15_000 });
      const linear = ((await api('GET', '/api/me/mcp/linear')).body) as { headers: Record<string, string> };
      assert.equal(linear.headers.Authorization, 'Bearer ${vault:Authorization}');
    });

    await step('turned off from its switch; removed from its page', async () => {
      await card('linear').locator('[role="switch"]').click();
      await page.waitForFunction(() => document.querySelector('[data-server="linear"] [role="switch"]')?.getAttribute('aria-checked') === 'false');
      assert.equal((await servers()).find((s) => s.name === 'linear')?.enabled, false);
      await shot('mcp-servers', page.locator('[data-section="mcp-servers"]'));
      await card('linear').click();
      await page.click('[data-mcp-remove]');
      await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).last().click();
      await card('linear').waitFor({ state: 'detached', timeout: 15_000 });
      assert.deepEqual((await servers()).map((s) => s.name), ['cloud-notes', 'notes']);
    });

    await step('Build a server from a description: drafted, its tools reviewed, built and checked by the harness, added to my servers', async () => {
      await page.click('[data-mcp-build]');
      await page.click('[data-choice="build-source"] [data-value="description"]');
      await page.fill('[data-build-description]', 'A unit converter: temperatures and lengths, for my cooking and travel notes.');
      await page.click('[data-build-draft]');
      await page.waitForSelector('[data-build-step="review"]', { timeout: 20_000 });
      assert.equal(await page.inputValue('[data-build-name]'), 'unit-converter');
      assert.deepEqual(await page.$$eval('[data-checks="build-tools"] input:checked', (els) => els.map((e) => e.getAttribute('data-check'))), ['convert_temperature', 'convert_length']);
      await shot('mcp-build-review', page.locator('[role="dialog"]').last());
      await page.click('[data-build-go]');
      await page.waitForSelector('[data-build-ok]', { timeout: 90_000 });
      const checks = await page.locator('[data-build-checks]').innerText();
      assert.match(checks, /speaks MCP 2026-07-28[\s\S]*convert_temperature works[\s\S]*100 C is 212 F[\s\S]*answers the 2025 handshake too[\s\S]*serves streamable HTTP/);
      assert.equal(await page.locator('[data-check-row="failed"]').count(), 0);
      await shot('mcp-build-checked', page.locator('[role="dialog"]').last());
      await page.click('[data-build-register]');
      await page.waitForFunction(async () => true);
      for (let i = 0; i < 50 && !(await servers()).some((s) => s.name === 'unit-converter'); i++) await page.waitForTimeout(100);
      const t2 = (await api('POST', '/api/me/mcp/unit-converter/test')).body as { ok: boolean; tools: Array<{ name: string; state: string }> };
      assert.equal(t2.ok, true);
      assert.deepEqual(t2.tools.map((x) => `${x.name}:${x.state}`).sort(), ['convert_length:approved', 'convert_temperature:approved']);
    });

    await step('its bundle is saved for Claude Desktop and its config copied for Claude Code; it is listed under the servers I built', async () => {
      const target = path.join(data, 'unit-converter.mcpb');
      await app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = (async () => ({ canceled: false, filePath: f })) as never; }, target);
      await page.click('[data-build-pack]');
      for (let i = 0; i < 100 && !fs.existsSync(target); i++) await page.waitForTimeout(200);
      assert.ok(fs.statSync(target).size > 10_000, 'the .mcpb was saved');
      assert.equal(fs.readFileSync(target).subarray(0, 2).toString(), 'PK');
      await clearCopied();
      await page.getByRole('button', { name: 'Claude Code (.mcp.json)' }).click();
      let copied = '';
      for (let i = 0; i < 50 && !copied; i++) { await page.waitForTimeout(100); copied = await copiedText(); }
      assert.equal(JSON.parse(copied).mcpServers['unit-converter'].type, 'stdio');
      await page.click('[data-build-done]');
      await page.locator('[data-builds] [data-build="unit-converter"]').waitFor();
      assert.match(await page.locator('[data-build="unit-converter"]').innerText(), /Unit converter[\s\S]*In your servers[\s\S]*2 tools/);
      await shot('mcp-servers-built', page.locator('[data-section="mcp-servers"]'));
    });

    await step('a .mcpb bundle installed as my own server from the Import dialog (the bundle the builder saved)', async () => {
      const bundle = path.join(data, 'unit-converter.mcpb');
      await page.click('[data-mcp-import]');
      await page.click('[data-mcp-bundle]');
      await page.waitForSelector('[data-bundle-dialog]');
      const chooser = page.waitForEvent('filechooser');
      await page.click('[data-bundle-pick]');
      await (await chooser).setFiles(bundle);
      await page.waitForFunction(() => /unit-converter/.test(document.querySelector('[data-bundle-dialog]')?.textContent ?? ''), undefined, { timeout: 15_000 });
      await page.click('[data-bundle-install]');
      await detail('unit-converter').waitFor({ timeout: 30_000 });
      await page.waitForFunction(() => /Connected/.test(document.querySelector('[data-detail="unit-converter"]')?.textContent ?? ''), undefined, { timeout: 30_000 });
      const s = (await api('GET', '/api/me/mcp/unit-converter')).body as { type: string; cwd?: string };
      assert.equal(s.type, 'stdio');
      assert.match(s.cwd ?? '', /bundles/);
      await page.click('[data-mcp-done]');
    });

    await step('your agents in another app: turned on in Settings, its Claude Code config copied, and that app (the bridge, started as its config says) hands work to an agent', async () => {
      await page.click('[data-settings-section="core.settings:mcp-access"]');
      await page.waitForSelector('[data-section="mcp-access"]');
      assert.equal(await page.locator('[data-mcp-token]').count(), 0, 'off until turned on');
      await page.locator('[data-section="mcp-access"] [role="switch"]').click();
      await page.waitForSelector('[data-mcp-token]', { timeout: 60_000 });
      await page.waitForSelector('[data-engine-status="ready"]', { timeout: 90_000 });
      await clearCopied();
      await page.click('[data-mcp-config="claude-code"]');
      let copied = '';
      for (let i = 0; i < 50 && !copied; i++) { await page.waitForTimeout(100); copied = await copiedText(); }
      const cfg = JSON.parse(copied).mcpServers['agent-harness'] as { type: string; command: string; args: string[]; env: Record<string, string> };
      assert.equal(cfg.type, 'stdio');
      assert.equal(cfg.env.ELECTRON_RUN_AS_NODE, '1');
      assert.ok((cfg.env.HARNESS_TOKEN ?? "").length > 30);
      await shot('mcp-access', page.locator('[data-section="mcp-access"]'));
      // Started as Claude Code would start it.
      const { spawn } = await import('node:child_process');
      const { McpClient, StdioTransport } = await import('../src/mcp/client.ts');
      const c = new McpClient(new StdioTransport(spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env } })), { callTimeoutMs: 120_000 });
      try {
        await c.initialize();
        const tools = (await c.listTools()).map((x) => x.name);
        assert.ok(tools.includes('run_agent') && tools.includes('agent_general'), tools.join(', '));
        const r = await c.callTool('run_agent', { agent: 'general', task: 'Say hello from the other app.' });
        assert.equal(r.isError, undefined, JSON.stringify(r));
        assert.match(r.content?.map((x) => x.text).join('') ?? '', /conversation: \S+ \(finished\) · agent: general/);
      } finally { await c.close(); }
      // Off: the bridge cannot find it any more.
      await page.locator('[data-section="mcp-access"] [role="switch"]').click();
      await page.waitForSelector('[data-mcp-token]', { state: 'detached', timeout: 60_000 });
      await page.waitForSelector('[data-engine-status="ready"]', { timeout: 90_000 });
      assert.ok(!fs.existsSync(cfg.args[cfg.args.indexOf('--endpoint-file') + 1]!), 'the address file is gone');
    });

    await step('no errors in the window', async () => {
      // Turning it on and off restarts the engine: the event streams drop meanwhile (and reconnect).
      assert.deepEqual(errors.filter((e) => !(e.phase.startsWith('your agents in another app') && /ERR_FAILED \(harness:\/\/app\/api\/(sessions\/\w+\/)?events/.test(e.text))), []);
    });
  } finally {
    await app.close().catch(() => {});
    oauth.stop();
    fs.rmSync(data, { recursive: true, force: true });
  }
});
