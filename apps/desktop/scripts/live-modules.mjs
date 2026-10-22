/**
 * Live check of plugins as modules: real models find a plugin from the guide index in their system
 * prompt, load its guide (a skill) and act through the plugin in the real app. Not part of npm test
 * (it costs money). Keys come from an env file:
 *
 *   node --env-file=<path to .env> apps/desktop/scripts/live-modules.mjs
 *
 * 1. claude-sonnet-5-5 (effort medium): "What can the Operations plugin do? Open its incidents page."
 *    It should load aiops-guide and open aiops:incidents in the window.
 * 2. deepseek-flash: "Build me a dashboard from this CSV using the dashboards plugin" (the CSV inline).
 *    It should load core.dashboards-guide and build through the data tools (a source, a dataset, a
 *    dashboard), shown in the app.
 * Each conversation is started from the composer, so the app's own declaration (its plugin index) is
 * what the model sees. Requests are allowed as the person would. Stops before a run that would pass
 * $1.00 (HARNESS_LIVE_CAP_USD to lower it). The window stays hidden (HARNESS_E2E_SHOW=1 shows it).
 * Key values are never printed. Screenshots in docs/screenshots/desktop/modules/live-*.png.
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
const CAP = Math.min(1, Number(process.env.HARNESS_LIVE_CAP_USD ?? 1));
const SHOTS = path.join(repo, 'docs', 'screenshots', 'desktop', 'modules');
const log = (m) => console.log(`[live-modules] ${m}`);
const results = [];
let spent = 0;

const { _electron } = await import('playwright-core');
const electronExe = require('electron');
if (!fs.existsSync(path.join(desktop, 'dist', 'main.cjs'))) { const { spawnSync } = await import('node:child_process'); spawnSync(process.execPath, [path.join(here, 'build.mjs')], { stdio: 'inherit', cwd: repo }); }

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-live-modules-'));
const app = await _electron.launch({ executablePath: electronExe, args: [desktop], env: { ...process.env, HARNESS_DESKTOP_DATA: data, HARNESS_DESKTOP_NO_TRAY: '1', HARNESS_DESKTOP_TEST: '1', HARNESS_PLUGIN_LOOPS: 'off', HARNESS_OPS_ALERTS_INVESTIGATE: '0', HARNESS_OPS_WATCH_SECONDS: '0' }, timeout: 60_000 });
const capture = async () => Buffer.from(await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64')), 'base64');
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const invoke = (c, ...a) => page.evaluate(([ch, args]) => window.harnessDesktop.invoke(ch, ...args), [c, a]);
const api = (method, p, body) => page.evaluate(async ([m, u, b]) => { const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json', 'x-harness': '1' }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) }; }, [method, p, body]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ready = () => page.waitForSelector('[data-engine-status="ready"]', { timeout: 120_000 });
const blocks = (d) => d.history.flatMap((m) => m.content);
const textOf = (d) => (d.history.filter((m) => m.role === 'assistant').at(-1)?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();

async function waitIdle(id, label) {
  const until = Date.now() + 300_000;
  let seenRunning = false;
  for (;;) {
    const d = (await api('GET', `/api/sessions/${id}`)).body;
    if (d?.status === 'running') seenRunning = true;
    for (const ev of d?.pending ?? []) if (ev.kind === 'permission_request') { log(`${label}: allowing ${ev.tool}${ev.suggestion ? ` (${ev.suggestion})` : ''}`); await api('POST', `/api/sessions/${id}/respond`, { requestId: ev.requestId, decision: 'allow' }); }
      else if (ev.kind === 'question') { log(`${label}: answering a question`); await api('POST', `/api/sessions/${id}/respond`, { requestId: ev.requestId, decision: 'answer', answer: 'Use your best judgement.' }); }
    if (d?.status === 'idle' && seenRunning && !(d?.pending ?? []).length) return d;
    if (Date.now() > until) throw new Error(`${label}: no answer within 5 minutes`);
    await sleep(1000);
  }
}

/** A conversation started from the composer with this model: the app declares itself (and its plugin index). */
async function start(model, effort, text) {
  await invoke('prefs:set', { defaultModel: model, defaultEffort: effort, defaultMode: 'default', onboardingDone: true });
  await page.click('[data-nav="core.chat:new"]');
  await page.reload();
  await ready();
  await page.waitForSelector('[data-home]');
  const box = page.locator('[data-composer-input]');
  await box.fill(text);
  await box.press('Enter');
  const id = await (await page.waitForSelector('[data-session]', { timeout: 30_000 })).getAttribute('data-session');
  const meta = (await api('GET', `/api/sessions/${id}`)).body.meta;
  log(`${model}: session ${id} (model ${meta.model}, ${meta.client?.plugins?.length ?? 0} plugins declared)`);
  return id;
}

const SALES = 'date,region,product,units,revenue\n2026-01-05,EU,Widget,12,1200\n2026-01-19,US,Widget,30,3000\n2026-02-02,EU,Gadget,7,1400\n2026-02-16,US,Gadget,11,2200\n2026-03-03,EU,Widget,16,1600\n2026-03-17,US,Widget,25,2500\n2026-03-30,APAC,Gadget,9,1800\n';

try {
  await ready();
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; if (w.isMaximized()) w.unmaximize(); w.setSize(1440, 920); });
  const plugins = (await api('GET', '/api/plugins')).body;
  for (const p of ['aiops', 'sdlc']) if (!(Array.isArray(plugins) ? plugins : plugins?.plugins ?? []).find((x) => x.name === p)?.enabled) await api('POST', `/api/plugins/${p}/enable`);
  await page.waitForSelector('[data-group="aiops"]', { timeout: 30_000 });
  // The person allows the Operations pages once (their frame's access), so the agent's page can show.
  await page.click('[data-nav="aiops:incidents"]');
  await page.click('[data-grant]', { timeout: 20_000 }).catch(() => {});
  fs.mkdirSync(SHOTS, { recursive: true });

  // 1. Claude: the Operations plugin, from its guide.
  const id1 = await start('claude-sonnet-5-5', 'medium', 'What can the Operations plugin do? Then open its incidents page in the app.');
  const d1 = await waitIdle(id1, 'sonnet');
  spent += d1.meta.cost ?? 0;
  const skills1 = blocks(d1).filter((b) => b.type === 'tool_use' && b.name === 'skill').map((b) => b.input?.name);
  const opens1 = blocks(d1).filter((b) => b.type === 'tool_use' && /^desktop_(open|command)$/.test(b.name)).map((b) => JSON.stringify(b.input));
  await page.waitForSelector('[data-view="aiops:incidents"]', { timeout: 20_000 }).catch(() => {});
  const onIncidents = await page.locator('[data-view="aiops:incidents"]').count() > 0;
  await sleep(1500);
  fs.writeFileSync(path.join(SHOTS, 'live-sonnet-operations.png'), await capture());
  results.push({ check: 'sonnet: loaded aiops-guide and opened Operations > Incidents in the app', ok: skills1.includes('aiops-guide') && onIncidents, detail: `skills=${JSON.stringify(skills1)} acts=${opens1.join(' ')} incidents=${onIncidents} reply=${JSON.stringify(textOf(d1).slice(0, 240))}`, cost: Number((d1.meta.cost ?? 0).toFixed(4)) });
  await page.click(`[data-session-row="${id1}"] button`).catch(() => {});
  await sleep(1200);
  fs.writeFileSync(path.join(SHOTS, 'live-sonnet-transcript.png'), await capture());
  log(`sonnet: $${(d1.meta.cost ?? 0).toFixed(4)}`);
  if (spent >= CAP * 0.7) throw new Error(`stopping before the second run: $${spent.toFixed(4)} of the $${CAP} cap`);

  // 2. DeepSeek: a dashboard through the dashboards plugin.
  const before = (await api('GET', '/api/data/docs')).body?.length ?? 0;
  const id2 = await start('deepseek-flash', 'medium', `Build me a dashboard from this CSV using the dashboards plugin.\n\n\`\`\`csv\n${SALES}\`\`\``);
  const d2 = await waitIdle(id2, 'deepseek');
  spent += d2.meta.cost ?? 0;
  const skills2 = blocks(d2).filter((b) => b.type === 'tool_use' && b.name === 'skill').map((b) => b.input?.name);
  const dataCalls = blocks(d2).filter((b) => b.type === 'tool_use' && ['datasource', 'dataset', 'model', 'dashboard'].includes(b.name)).map((b) => `${b.name}:${(b.input?.ops ?? [b.input]).map((o) => o?.op).join('+')}`);
  const docs = (await api('GET', '/api/data/docs')).body ?? [];
  const made = docs.length > before;
  if (made) { await page.click('[data-group-home="core.dashboards"]').catch(() => {}); await page.waitForSelector('[data-module-home="core.dashboards"]', { timeout: 10_000 }).catch(() => {}); const card = page.locator('[data-home-doc]').first(); if (await card.count()) { await card.click(); await sleep(3000); } }
  fs.writeFileSync(path.join(SHOTS, 'live-deepseek-dashboard.png'), await capture());
  results.push({ check: 'deepseek: loaded core.dashboards-guide and built a dashboard through the data tools', ok: skills2.includes('core.dashboards-guide') && made && dataCalls.length > 0, detail: `skills=${JSON.stringify(skills2)} data=${dataCalls.slice(0, 12).join(' ')} docs ${before}->${docs.length} reply=${JSON.stringify(textOf(d2).slice(0, 240))}`, cost: Number((d2.meta.cost ?? 0).toFixed(4)) });
  await page.click(`[data-session-row="${id2}"] button`).catch(() => {});
  await sleep(1200);
  fs.writeFileSync(path.join(SHOTS, 'live-deepseek-transcript.png'), await capture());
  log(`deepseek: $${(d2.meta.cost ?? 0).toFixed(4)} (total $${spent.toFixed(4)})`);
} catch (e) {
  results.push({ check: 'run', ok: false, detail: e instanceof Error ? e.message : String(e) });
} finally {
  await app.close().catch(() => {});
  try { fs.rmSync(data, { recursive: true, force: true, maxRetries: 3 }); } catch { /* in use (Windows) */ }
}

results.push({ check: 'no exceptions in the window', ok: errors.length === 0, detail: errors.slice(0, 3).join(' | ') });
console.log(JSON.stringify({ spentUsd: Number(spent.toFixed(4)), capUsd: CAP, results }, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
