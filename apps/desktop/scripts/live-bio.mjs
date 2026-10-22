/**
 * The live biology check: the real desktop app, the real engine, real models. Not part of npm test
 * (it costs money). Keys come from an env file:
 *
 *   node --env-file=<path to .env> apps/desktop/scripts/live-bio.mjs
 *
 * For each model (claude-sonnet-5-5, deepseek-flash; effort medium) it creates a desktop session
 * whose client declares the app's renderers (so the session gets the rich-output skill), asks for
 * one short answer with a sequence, a plasmid map, a phylogenetic tree and a volcano plot, opens it
 * in the window, checks each block drew without an error and saves
 * docs/screenshots/desktop/live-bio-<model>.png. It stops before a run that would pass the cap
 * ($0.60 for the whole check; HARNESS_LIVE_BIO_CAP_USD to lower it). Key values are never printed.
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
const MODELS = (process.env.HARNESS_LIVE_BIO_MODELS ?? 'claude-sonnet-5-5,deepseek-flash').split(',').map((s) => s.trim()).filter(Boolean);
const CAP = Math.min(0.6, Number(process.env.HARNESS_LIVE_BIO_CAP_USD ?? 0.6));
const SHOTS = path.join(repo, 'docs', 'screenshots', 'desktop');
// What the desktop declares (packages/ui DECLARED_FENCES): the session gets the skill and the note.
const RENDERERS = ['mermaid', 'chart', 'vega-lite', 'math', 'table', 'csv', 'json', 'html', 'svg', 'jsx', 'diff', 'diagram', 'plot', 'dot', 'smiles', 'pdb', 'sdf', 'geojson', 'ipynb', 'dashboard',
  'fasta', 'msa', 'newick', 'plasmid', 'gff', 'bed', 'tracks', 'uniprot', 'pathway', 'volcano', 'ma', 'heatmap', 'kaplan-meier', 'manhattan'];
const PROMPT = 'In one short reply (one line of text per item, nothing else), show: a ```fasta block of a short real coding sequence (at most 120 nt) with two features; a ```plasmid map of pUC19 with its main features and a few restriction sites; a ```newick tree of five primates with branch lengths and support values; and a ```volcano plot of about 12 differentially expressed genes. Use the exact formats the app expects.';
const BLOCKS = { sequence: '[data-widget="Sequence"] [data-seq-map]', plasmid: '[data-widget="Plasmid map"] [data-plasmid-map]', tree: '[data-widget="Tree"] [data-tree]', volcano: '[data-widget="Volcano plot"] [data-chart="vega"] svg' };

const log = (m) => console.log(`[live-bio] ${m}`);
const results = [];
let spent = 0;

const { _electron } = await import('playwright-core');
const electronExe = require('electron');
if (!fs.existsSync(path.join(desktop, 'dist', 'main.cjs'))) { log('building the app first'); const { spawnSync } = await import('node:child_process'); spawnSync(process.execPath, [path.join(here, 'build.mjs')], { stdio: 'inherit', cwd: repo }); }

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-bio-data-'));
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-bio-project-'));
const app = await _electron.launch({ executablePath: electronExe, args: [desktop], env: { ...process.env, HARNESS_DESKTOP_DATA: data, HARNESS_DESKTOP_NO_TRAY: '1' }, timeout: 60_000 });
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
// Adding the project folder restarts the engine, which cuts the open event streams (they reconnect): expected, like in the e2e test.
page.on('console', (m) => { const where = m.location().url ?? ''; if (m.type() === 'error' && !/\/plugins\/|^harness:\/\/preview|^about:srcdoc/.test(where) && !(/ERR_FAILED/.test(m.text()) && /\/api\/(events|sessions\/[^/]+\/events)/.test(where))) errors.push(`console: ${m.text()} (${where})`); });
const api = (method, p, body) => page.evaluate(async ([m, u, b]) => { const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json', 'x-harness': '1' }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) }; }, [method, p, body]);
const ready = () => page.waitForSelector('[data-engine-status="ready"]', { timeout: 120_000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await ready();
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.unmaximize(); w.setSize(1280, 1000); });
  await page.evaluate((dir) => window.harnessDesktop.invoke('projects:add', dir), project);
  await sleep(1500);
  await ready();
  for (let i = 0; i < 40 && (await api('GET', '/api/health')).status !== 200; i++) await sleep(500);
  const models = (await api('GET', '/api/models')).body;
  const ids = (Array.isArray(models) ? models : models?.models ?? []).map((m) => m.id);
  const providers = (await api('GET', '/api/providers')).body;
  for (const p of Array.isArray(providers) ? providers : providers?.providers ?? []) if (['anthropic', 'deepseek'].includes(p.id)) log(`provider ${p.id}: ${p.configured ? 'configured' : 'no key'}`);

  const waitIdle = async (id, label) => {
    const until = Date.now() + 300_000;
    let seenRunning = false;
    for (;;) {
      const d = (await api('GET', `/api/sessions/${id}`)).body;
      if (d?.status === 'running') seenRunning = true;
      for (const ev of d?.pending ?? []) if (ev.kind === 'permission_request') { log(`${label}: refusing ${ev.tool} (not needed here)`); await api('POST', `/api/sessions/${id}/respond`, { requestId: ev.requestId, decision: 'deny' }); }
      if (d?.status === 'idle' && (seenRunning || (d?.history?.length ?? 0) > 1)) return d;
      if (Date.now() > until) throw new Error(`${label}: no answer within 5 minutes`);
      await sleep(1000);
    }
  };

  for (const model of MODELS) {
    if (!ids.includes(model)) { results.push({ model, check: 'listed', ok: false }); continue; }
    if (spent >= CAP * 0.75) { log(`stopping before ${model}: $${spent.toFixed(4)} spent of the $${CAP} cap`); break; }
    const created = await api('POST', '/api/sessions', { title: `Biology ${model}`, model, effort: 'medium', mode: 'acceptEdits', runtime: 'local', path: project, client: { kind: 'desktop', version: 'live-bio', renderers: RENDERERS, tools: [] } });
    if (created.status !== 201 && created.status !== 200) { results.push({ model, check: 'session created', ok: false, detail: JSON.stringify(created.body).slice(0, 200) }); continue; }
    const id = created.body.id ?? created.body.meta?.id;
    log(`${model}: asking`);
    await api('POST', `/api/sessions/${id}/messages`, { text: PROMPT });
    const d = await waitIdle(id, model);
    const cost = d.meta?.cost ?? 0;
    spent += cost;
    const usedSkill = (d.history ?? []).some((m) => (m.content ?? []).some((b) => b.type === 'tool_use' && b.name === 'skill' && b.input?.name === 'rich-output'));
    await page.click('[data-nav="core.chat:search"]');
    await page.click(`[data-session-row="${id}"] button`);
    await page.waitForSelector(`[data-session="${id}"] [data-assistant-message]`, { timeout: 30_000 });
    const drew = {};
    for (const [name, sel] of Object.entries(BLOCKS)) drew[name] = await page.waitForSelector(`[data-session="${id}"] ${sel}`, { timeout: 30_000 }).then(() => true, () => false);
    const failed = await page.locator(`[data-session="${id}"] [data-render-error]`).count();
    const failures = failed ? await page.locator(`[data-session="${id}"] [data-render-error] p`).allTextContents() : [];
    await page.waitForTimeout(800);
    fs.mkdirSync(SHOTS, { recursive: true });
    // The whole answer in one picture: a taller window at a smaller zoom.
    await page.evaluate(() => { document.documentElement.style.zoom = '0.5'; });
    await page.locator(`[data-session="${id}"] [data-assistant-message]`).last().evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(SHOTS, `live-bio-${model}.png`) });
    await page.evaluate(() => { document.documentElement.style.zoom = ''; });
    results.push({ model, check: 'biology answer drawn', ok: Object.values(drew).every(Boolean) && failed === 0, detail: `${JSON.stringify(drew)} failed blocks=${failed}${failures.length ? ` (${failures.join(' | ').slice(0, 300)})` : ''} loaded rich-output=${usedSkill}`, cost: Number(cost.toFixed(4)) });
    log(`${model}: $${cost.toFixed(4)} (total $${spent.toFixed(4)}), skill loaded: ${usedSkill}`);
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
