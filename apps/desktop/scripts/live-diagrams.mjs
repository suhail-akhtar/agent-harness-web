/**
 * The live diagrams check: the real desktop app, the real engine, real models. Not part of npm test
 * (it costs money). Keys come from an env file:
 *
 *   node --env-file=<path to .env> apps/desktop/scripts/live-diagrams.mjs
 *
 * 1. claude-sonnet-5-5 (effort medium) draws the deployment architecture of a small CRM (proxy, web
 *    app, database, secrets, backup job) in zones with a login flow, as a diagram artifact; the canvas
 *    opens it (screenshot live-diagram-sonnet-before.png).
 * 2. On the canvas, the ask box: "add a cache in front of the database"; the new version arrives in
 *    place with its changes marked (live-diagram-sonnet-after.png).
 * 3. deepseek-flash gets the first request (live-diagram-deepseek.png).
 * It stops before a request that would pass the cap ($1.50, HARNESS_DIAGRAM_CAP_USD to lower it).
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
const CAP = Math.min(1.5, Number(process.env.HARNESS_DIAGRAM_CAP_USD ?? 1.5));
const SHOTS = path.join(repo, 'docs', 'screenshots', 'desktop');
const RENDERERS = ['mermaid', 'chart', 'vega-lite', 'math', 'table', 'csv', 'json', 'html', 'svg', 'jsx', 'diff', 'diagram', 'plot', 'dot', 'dashboard'];
const ASK = 'Draw the deployment architecture of a small CRM as a diagram artifact: a reverse proxy, the CRM web app, a PostgreSQL database, a secrets vault and a nightly backup job, in network zones (DMZ, app, data) on one host, with addresses and sizes, and a login flow from the user to the database and back.';

const log = (m) => console.log(`[diagrams] ${m}`);
const results = [];
const spentBy = {};
const spent = () => Object.values(spentBy).reduce((a, b) => a + b, 0);

const { _electron } = await import('playwright-core');
const electronExe = require('electron');
const { spawnSync } = await import('node:child_process');
log('building the app');
spawnSync(process.execPath, [path.join(here, 'build.mjs')], { stdio: 'inherit', cwd: repo });

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-live-dg-data-'));
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-live-dg-project-'));
const app = await _electron.launch({ executablePath: electronExe, args: [desktop], env: { ...process.env, HARNESS_DESKTOP_DATA: data, HARNESS_DESKTOP_NO_TRAY: '1' }, timeout: 60_000 });
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/ERR_FAILED|Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 300)); });
const api = (method, p, body) => page.evaluate(async ([m, u, b]) => { const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json', 'x-harness': '1' }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) }; }, [method, p, body]);
const ready = () => page.waitForSelector('[data-engine-status="ready"]', { timeout: 120_000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const waitIdle = async (id, label, minutes = 6) => {
  const until = Date.now() + minutes * 60_000;
  let seenRunning = false;
  for (;;) {
    const d = (await api('GET', `/api/sessions/${id}`)).body;
    if (d?.status === 'running') seenRunning = true;
    for (const ev of d?.pending ?? []) if (ev.kind === 'permission_request') { log(`${label}: allowing ${ev.tool}`); await api('POST', `/api/sessions/${id}/respond`, { requestId: ev.requestId, decision: 'allow' }); }
    if (d?.status === 'idle' && seenRunning) return d;
    if (Date.now() > until) throw new Error(`${label}: no answer within ${minutes} minutes`);
    await sleep(1500);
  }
};
const toolsUsed = (d) => d.history.flatMap((m) => (m.role === 'assistant' ? m.content.filter((b) => b.type === 'tool_use').map((b) => `${b.name}${b.input?.action ? `:${b.input.action}` : ''}${b.input?.name ? `:${b.input.name}` : ''}`) : []));
const openSession = async (id) => {
  await page.click('[data-nav="core.chat:search"]');
  await page.click(`[data-session-row="${id}"] button`);
  await page.waitForSelector(`[data-session="${id}"]`, { timeout: 30_000 });
};
const openLatestDiagram = async () => {
  const open = page.locator('[data-diagram-artifact] [data-diagram-open]').last();
  await open.waitFor({ timeout: 60_000 });
  await open.click();
  await page.waitForSelector('[data-diagram-canvas]');
  await page.waitForFunction(() => { const c = document.querySelector('[data-diagram-canvas]'); return !!c && c.getAttribute('data-engine') !== '' && Number(c.getAttribute('data-nodes')) > 0; }, null, { timeout: 60_000 });
  await sleep(1200);
};

async function draw(model) {
  const created = await api('POST', '/api/sessions', { title: `Diagram ${model}`, model, effort: 'medium', mode: 'acceptEdits', runtime: 'local', path: project, client: { kind: 'desktop', version: 'live', renderers: RENDERERS, tools: [] } });
  if (created.status !== 201 && created.status !== 200) throw new Error(`${model}: session not created (${created.status})`);
  const id = created.body.id ?? created.body.meta?.id;
  log(`${model}: drawing`);
  await api('POST', `/api/sessions/${id}/messages`, { text: ASK });
  const d = await waitIdle(id, model);
  spentBy[`${model}-1`] = d.meta.cost ?? 0;
  const arts = ((await api('GET', `/api/sessions/${id}/artifacts`)).body ?? []).filter((a) => a.kind === 'diagram');
  log(`${model}: tools ${toolsUsed(d).join(', ')}; diagram artifacts ${arts.length}; $${(d.meta.cost ?? 0).toFixed(4)}`);
  return { id, d, arts };
}

try {
  await ready();
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.unmaximize(); w.setSize(1440, 900); });
  await page.evaluate((dir) => window.harnessDesktop.invoke('projects:add', dir), project);
  await sleep(1500);
  await ready();
  for (let i = 0; i < 40 && (await api('GET', '/api/health')).status !== 200; i++) await sleep(500);
  const providers = (await api('GET', '/api/providers')).body;
  for (const p of Array.isArray(providers) ? providers : providers?.providers ?? []) log(`provider ${p.id}: ${p.configured ? 'configured' : 'no key'}`);
  fs.mkdirSync(SHOTS, { recursive: true });

  // 1-2: Sonnet draws, then the ask box changes it.
  const sonnet = await draw('claude-sonnet-5-5');
  const s1 = sonnet.arts[0];
  results.push({ model: 'claude-sonnet-5-5', check: 'a diagram artifact, loaded the skill', ok: !!s1 && toolsUsed(sonnet.d).some((t) => t.startsWith('skill')), detail: `${sonnet.arts.length} artifact(s); tools ${toolsUsed(sonnet.d).join(', ')}` });
  if (s1) {
    await openSession(sonnet.id);
    await openLatestDiagram();
    const nodes = Number(await page.locator('[data-diagram-canvas]').getAttribute('data-nodes'));
    const zones = await page.locator('[data-diagram-viewport] [data-group-kind="zone"], [data-diagram-viewport] [data-group-kind="subnet"]').count();
    const flows = await page.locator('[data-diagram-flows-toggle]').count();
    results.push({ model: 'claude-sonnet-5-5', check: 'drawn: nodes, zones, a flow', ok: nodes >= 5 && zones >= 2 && flows > 0, detail: `nodes=${nodes} zones=${zones} flows=${flows} engine=${await page.locator('[data-diagram-canvas]').getAttribute('data-engine')}` });
    await page.screenshot({ path: path.join(SHOTS, 'live-diagram-sonnet-before.png') });
    if (spent() < CAP * 0.6) {
      const before = Number(await page.locator('[data-diagram-page]').getAttribute('data-version'));
      log('claude-sonnet-5-5: asking for a cache on the canvas');
      await page.fill('[data-diagram-ask-input]', 'add a cache in front of the database');
      await page.press('[data-diagram-ask-input]', 'Enter');
      await sleep(2000);
      const d2 = await waitIdle(sonnet.id, 'claude-sonnet-5-5 (ask)');
      spentBy['claude-sonnet-5-5-2'] = (d2.meta.cost ?? 0) - spentBy['claude-sonnet-5-5-1'];
      await page.waitForFunction((v) => Number(document.querySelector('[data-diagram-page]')?.getAttribute('data-version')) > v, before, { timeout: 60_000 }).catch(() => {});
      await sleep(2500);
      const after = Number(await page.locator('[data-diagram-page]').getAttribute('data-version'));
      const marked = await page.locator('[data-diagram-viewport] [data-changed]').count();
      const cacheish = await page.locator('[data-diagram-viewport] [data-kind="cache"]').count();
      const note = await page.locator('[data-diagram-changed]').first().innerText().catch(() => '');
      results.push({ model: 'claude-sonnet-5-5', check: 'asked on the canvas: new version in place, changes marked', ok: after > before && marked > 0 && cacheish > 0, detail: `v${before} -> v${after}; marked=${marked}; cache nodes=${cacheish}; "${note}"; tools ${toolsUsed(d2).slice(toolsUsed(sonnet.d).length).join(', ')}` });
      await page.screenshot({ path: path.join(SHOTS, 'live-diagram-sonnet-after.png') });
    }
  }
  // 3: DeepSeek gets the first request.
  if (spent() < CAP * 0.85) {
    const ds = await draw('deepseek-flash');
    const a = ds.arts[0];
    results.push({ model: 'deepseek-flash', check: 'a diagram artifact', ok: !!a, detail: `${ds.arts.length} artifact(s); tools ${toolsUsed(ds.d).join(', ')}` });
    if (a) {
      await openSession(ds.id);
      await openLatestDiagram();
      const nodes = Number(await page.locator('[data-diagram-canvas]').getAttribute('data-nodes'));
      const zones = await page.locator('[data-diagram-viewport] [data-group-kind="zone"], [data-diagram-viewport] [data-group-kind="subnet"]').count();
      results.push({ model: 'deepseek-flash', check: 'drawn: nodes and zones', ok: nodes >= 5 && zones >= 2, detail: `nodes=${nodes} zones=${zones}` });
      await page.screenshot({ path: path.join(SHOTS, 'live-diagram-deepseek.png') });
    }
  } else log(`skipping deepseek-flash: $${spent().toFixed(4)} spent of the $${CAP} cap`);
} catch (e) {
  results.push({ check: 'run', ok: false, detail: e instanceof Error ? e.message : String(e) });
  await page.screenshot({ path: path.join(os.tmpdir(), 'live-diagrams-fail.png') }).catch(() => {});
} finally {
  await app.close().catch(() => {});
  fs.rmSync(data, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
}

results.push({ check: 'no errors in the window', ok: errors.length === 0, detail: errors.slice(0, 3).join(' | ') });
console.log(JSON.stringify({ spentUsd: Number(spent().toFixed(4)), capUsd: CAP, spentBy, results }, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
