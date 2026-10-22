/**
 * The live smoke test: the real desktop app, the real engine, real models. Not part of npm test
 * (it costs money). Keys come from an env file:
 *
 *   node --env-file=<path to .env> apps/desktop/scripts/live-smoke.mjs
 *
 * For each model (deepseek-flash, claude-sonnet-5-5; effort medium) it creates a session in a
 * temporary project folder, asks for a file to be written and read back (checked on disk), then
 * asks for a rich answer (table, Mermaid, maths, chart) and checks every block drew, with a
 * screenshot in docs/screenshots/desktop/live-<model>.png. It stops before a run that would pass
 * the cost cap ($0.50 for the whole smoke, HARNESS_SMOKE_CAP_USD to lower it).
 *
 * It also checks the Kimi and GLM models are listed (no calls are made to them).
 * Key values are never printed: only whether a provider is configured.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const repo = path.resolve(desktop, '..', '..');
const require = createRequire(import.meta.url);
const MODELS = (process.env.HARNESS_SMOKE_MODELS ?? 'deepseek-flash,claude-sonnet-5-5').split(',').map((s) => s.trim()).filter(Boolean);
const CAP = Math.min(0.5, Number(process.env.HARNESS_SMOKE_CAP_USD ?? 0.5));
const SHOTS = path.join(repo, 'docs', 'screenshots', 'desktop');

const log = (m) => console.log(`[smoke] ${m}`);
const results = [];
let spent = 0;

const { _electron } = await import('playwright-core');
const electronExe = require('electron');
if (!fs.existsSync(path.join(desktop, 'dist', 'main.cjs'))) { log('building the app first'); const { spawnSync } = await import('node:child_process'); spawnSync(process.execPath, [path.join(here, 'build.mjs')], { stdio: 'inherit', cwd: repo }); }

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-smoke-data-'));
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-smoke-project-'));
const app = await _electron.launch({ executablePath: electronExe, args: [desktop], env: { ...process.env, HARNESS_DESKTOP_DATA: data, HARNESS_DESKTOP_NO_TRAY: '1', HARNESS_DESKTOP_TEST: '1' }, timeout: 60_000 });
const capture = async () => Buffer.from(await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64')), 'base64');
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const api = (method, p, body) => page.evaluate(async ([m, u, b]) => { const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json', 'x-harness': '1' }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) }; }, [method, p, body]);
const ready = () => page.waitForSelector('[data-engine-status="ready"]', { timeout: 120_000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await ready();
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; if (w.isMaximized()) w.unmaximize(); w.setSize(1280, 900); });
  // The folder the sessions work in (the engine restarts with it as a root).
  await page.evaluate((dir) => window.harnessDesktop.invoke('projects:add', dir), project);
  await sleep(1500);
  await ready();
  for (let i = 0; i < 40 && (await api('GET', '/api/health')).status !== 200; i++) await sleep(500);

  const models = (await api('GET', '/api/models')).body;
  const list = Array.isArray(models) ? models : models?.models ?? [];
  const ids = list.map((m) => m.id);
  log(`models listed: ${ids.join(', ')}`);
  results.push({ check: 'Kimi and GLM listed (no calls)', ok: ids.some((i) => /^kimi/.test(i)) && ids.some((i) => /^glm/.test(i)) });
  const providers = (await api('GET', '/api/providers')).body;
  for (const p of Array.isArray(providers) ? providers : providers?.providers ?? []) log(`provider ${p.id}: ${p.configured ? 'configured' : 'no key'}`);

  const waitIdle = async (id, label) => {
    const until = Date.now() + 240_000;
    let seenRunning = false;
    for (;;) {
      const d = (await api('GET', `/api/sessions/${id}`)).body;
      const status = d?.status;
      if (status === 'running') seenRunning = true;
      // Permission requests for the smoke's own writes in its temporary folder are allowed.
      for (const ev of d?.pending ?? []) if (ev.kind === 'permission_request') { log(`${label}: allowing ${ev.tool}`); await api('POST', `/api/sessions/${id}/respond`, { requestId: ev.requestId, decision: 'allow' }); }
      if (status === 'idle' && (seenRunning || (d?.history?.length ?? 0) > 1)) return d;
      if (Date.now() > until) throw new Error(`${label}: no answer within 4 minutes`);
      await sleep(1000);
    }
  };

  for (const model of MODELS) {
    if (!ids.includes(model)) { results.push({ model, check: 'listed', ok: false }); continue; }
    if (spent >= CAP * 0.8) { log(`stopping before ${model}: $${spent.toFixed(4)} spent of the $${CAP} cap`); break; }
    const created = await api('POST', '/api/sessions', { title: `Smoke ${model}`, model, effort: 'medium', mode: 'acceptEdits', runtime: 'local', path: project, client: { kind: 'desktop', version: 'smoke', renderers: ['mermaid', 'chart', 'math', 'table'], tools: [] } });
    if (created.status !== 201 && created.status !== 200) { results.push({ model, check: 'session created', ok: false, detail: JSON.stringify(created.body).slice(0, 200) }); continue; }
    const id = created.body.id ?? created.body.meta?.id;
    const file = `smoke-${model}.txt`;
    const expected = `ok-${model}`;
    log(`${model}: write and read back`);
    await api('POST', `/api/sessions/${id}/messages`, { text: `Create a file named ${file} in the working folder whose only content is the line ${expected} . Then read the file back with a tool and reply with exactly what it contains, nothing else.` });
    let d = await waitIdle(id, model);
    const onDisk = fs.existsSync(path.join(project, file)) ? fs.readFileSync(path.join(project, file), 'utf8').trim() : null;
    const reply1 = (d.history.filter((m) => m.role === 'assistant').at(-1)?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    results.push({ model, check: 'file written and read back', ok: onDisk === expected && reply1.includes(expected), detail: `disk=${JSON.stringify(onDisk)} reply=${JSON.stringify(reply1.slice(0, 80))}` });
    spent += d.meta.cost ?? 0;
    if (spent >= CAP) { log(`cap reached after the file check ($${spent.toFixed(4)})`); break; }

    log(`${model}: rich answer`);
    await api('POST', `/api/sessions/${id}/messages`, { text: 'In one short reply, show: a Markdown table of three planets with their radius in km; a ```mermaid flowchart of a build pipeline (3 steps); the formula for kinetic energy in a ```math block; and a ```chart block with an ECharts option for a bar chart of the three radii. No other text beyond one line per item.' });
    d = await waitIdle(id, model);
    spent = results.filter((r) => r.cost).reduce((a, r) => a + r.cost, 0) + d.meta.cost;
    // Open it in the window and check every block drew.
    await page.click('[data-nav="core.chat:search"]');
    await page.click(`[data-session-row="${id}"] button`);
    await page.waitForSelector(`[data-session="${id}"] [data-assistant-message]`, { timeout: 30_000 });
    const drew = {};
    for (const [name, sel] of Object.entries({ table: '[data-md-table] table', mermaid: '[data-diagram="svg"] svg', math: '.katex-display', chart: '[data-chart="echarts"] svg' })) {
      drew[name] = await page.waitForSelector(`[data-session="${id}"] ${sel}`, { timeout: 30_000 }).then(() => true, () => false);
    }
    // Mermaid's node labels are drawn (not just the boxes).
    if (drew.mermaid) drew.mermaidLabels = ((await page.locator(`[data-session="${id}"] [data-diagram="svg"] svg .node`).allTextContents()).join('').trim().length) > 3;
    const failed = await page.locator(`[data-session="${id}"] [data-render-error]`).count();
    await page.locator('[data-virtual-list]').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await sleep(600);
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.writeFileSync(path.join(SHOTS, `live-${model}.png`), await capture());
    results.push({ model, check: 'rich answer drawn', ok: Object.values(drew).every(Boolean) && failed === 0, detail: `${JSON.stringify(drew)} failed blocks=${failed}`, cost: d.meta.cost });
    log(`${model}: $${d.meta.cost.toFixed(4)} (total $${spent.toFixed(4)})`);
  }
} catch (e) {
  results.push({ check: 'run', ok: false, detail: e instanceof Error ? e.message : String(e) });
} finally {
  await app.close().catch(() => {});
  fs.rmSync(data, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
}

results.push({ check: 'no exceptions in the window', ok: errors.length === 0, detail: errors.slice(0, 3).join(' | ') });
console.log(JSON.stringify({ spentUsd: Number(spent.toFixed(4)), capUsd: CAP, results }, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
