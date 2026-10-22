/**
 * Live check of the harness home and of plugin commands through desktop_command: the real app, the
 * real engine, a real model. Not part of npm test (it costs money). Keys come from an env file:
 *
 *   node --env-file=<path to .env> apps/desktop/scripts/live-home.mjs
 *
 * 1. A short session (claude-sonnet-5-5, effort medium) in the home's default workspace
 *    (<home>/workspaces/default): a file written there and read back, checked on disk.
 * 2. An Operations incident (made from an alert posted to the aiops alert route) opened in the app by
 *    the agent with desktop_command (aiops:open-incident): asked first (allowed here), the window
 *    shows the incident.
 * Stops before a run that would pass $0.50 (HARNESS_LIVE_CAP_USD to lower it). The window stays hidden
 * (HARNESS_E2E_SHOW=1 shows it). Key values are never printed.
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
const MODEL = process.env.HARNESS_LIVE_MODEL ?? 'claude-sonnet-5-5';
const CAP = Math.min(0.5, Number(process.env.HARNESS_LIVE_CAP_USD ?? 0.5));
const SHOTS = path.join(repo, 'docs', 'screenshots', 'desktop');
const log = (m) => console.log(`[live-home] ${m}`);
const results = [];
let spent = 0;

const { _electron } = await import('playwright-core');
const electronExe = require('electron');
if (!fs.existsSync(path.join(desktop, 'dist', 'main.cjs'))) { const { spawnSync } = await import('node:child_process'); spawnSync(process.execPath, [path.join(here, 'build.mjs')], { stdio: 'inherit', cwd: repo }); }

// The app's data folder of its own: its harness home is <data>/home (never the person's ~/.harness).
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-live-home-'));
const app = await _electron.launch({ executablePath: electronExe, args: [desktop], env: { ...process.env, HARNESS_DESKTOP_DATA: data, HARNESS_DESKTOP_NO_TRAY: '1', HARNESS_DESKTOP_TEST: '1', HARNESS_PLUGIN_LOOPS: 'off', HARNESS_OPS_ALERTS_INVESTIGATE: '0', HARNESS_OPS_WATCH_SECONDS: '0' }, timeout: 60_000 });
const capture = async () => Buffer.from(await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64')), 'base64');
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const invoke = (c, ...a) => page.evaluate(([ch, args]) => window.harnessDesktop.invoke(ch, ...args), [c, a]);
const api = (method, p, body) => page.evaluate(async ([m, u, b]) => { const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json', 'x-harness': '1' }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) }; }, [method, p, body]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ready = () => page.waitForSelector('[data-engine-status="ready"]', { timeout: 120_000 });
const textOf = (d) => (d.history.filter((m) => m.role === 'assistant').at(-1)?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();

async function waitIdle(id, label) {
  const until = Date.now() + 240_000;
  let seenRunning = false;
  for (;;) {
    const d = (await api('GET', `/api/sessions/${id}`)).body;
    if (d?.status === 'running') seenRunning = true;
    for (const ev of d?.pending ?? []) if (ev.kind === 'permission_request') { log(`${label}: allowing ${ev.tool}${ev.suggestion ? ` (${ev.suggestion})` : ''}`); results.push({ check: `${label}: asked before ${ev.tool}`, ok: true }); await api('POST', `/api/sessions/${id}/respond`, { requestId: ev.requestId, decision: 'allow' }); }
    if (d?.status === 'idle' && (seenRunning || (d?.history?.length ?? 0) > 1)) return d;
    if (Date.now() > until) throw new Error(`${label}: no answer within 4 minutes`);
    await sleep(1000);
  }
}

try {
  await ready();
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; if (w.isMaximized()) w.unmaximize(); w.setSize(1360, 900); });
  const home = (await invoke('home:info')).home;
  const ws = path.join(home, 'workspaces', 'default');
  results.push({ check: 'the home is the app\'s own (in its data folder), with its layout', ok: home === path.join(data, 'home') && fs.existsSync(ws) && fs.existsSync(path.join(home, 'tmp')) });
  const providers = (await api('GET', '/api/providers')).body;
  for (const p of Array.isArray(providers) ? providers : providers?.providers ?? []) if (/anthropic|deepseek/.test(p.id)) log(`provider ${p.id}: ${p.configured ? 'configured' : 'no key'}`);

  // 1. A session in the home's default workspace: no folder to add, it is allowed by default.
  const s1 = await api('POST', '/api/sessions', { title: 'Live home', model: MODEL, effort: 'medium', mode: 'acceptEdits', runtime: 'local', path: ws, client: { kind: 'desktop', version: 'live', renderers: [], tools: [] } });
  if (s1.status !== 201) throw new Error(`the session in the default workspace was refused: ${JSON.stringify(s1.body).slice(0, 200)}`);
  const id1 = s1.body.id ?? s1.body.meta?.id;
  await api('POST', `/api/sessions/${id1}/messages`, { text: 'Create a file named home-check.txt in the working folder whose only content is the line ok-home . Then read the file back with a tool and reply with exactly what it contains, nothing else.' });
  const d1 = await waitIdle(id1, 'default workspace');
  const disk = fs.existsSync(path.join(ws, 'home-check.txt')) ? fs.readFileSync(path.join(ws, 'home-check.txt'), 'utf8').trim() : null;
  spent += d1.meta.cost ?? 0;
  results.push({ check: 'a file written in ~/.harness/workspaces/default and read back', ok: disk === 'ok-home' && textOf(d1).includes('ok-home'), detail: `disk=${JSON.stringify(disk)} reply=${JSON.stringify(textOf(d1).slice(0, 60))}`, cost: Number((d1.meta.cost ?? 0).toFixed(4)) });
  log(`session 1: $${(d1.meta.cost ?? 0).toFixed(4)}`);
  if (spent >= CAP * 0.6) throw new Error(`stopping before the second run: $${spent.toFixed(4)} of the $${CAP} cap`);

  // 2. An incident from an alert (the aiops route, with its token, straight to the engine: the app's proxy never forwards one).
  const routes = (await api('POST', '/api/plugin-routes')).body;
  const token = (Array.isArray(routes) ? routes : []).find((r) => r.plugin === 'aiops' && r.path === 'alerts')?.token;
  const origin = (await invoke('engine:status')).origin;
  if (!token || !origin) throw new Error('the aiops alert route is not there');
  const hook = await fetch(`${origin}/api/plugins/aiops/alerts`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-harness-route-token': token }, body: JSON.stringify({ alerts: [{ name: 'CheckoutErrorRatio', severity: 'critical', service: 'checkout', env: 'prod', summary: '21% of checkout requests fail', value: '0.21', startsAt: new Date(Date.now() - 600_000).toISOString() }] }) });
  if (hook.status !== 202) throw new Error(`the alert was not taken (${hook.status})`);
  const inc = (await api('POST', '/api/plugins/aiops/console/incidents', { status: 'open' })).body?.incidents?.[0]?.id;
  if (!inc) throw new Error('no incident from the alert');
  log(`incident ${inc}`);
  // The person allows the Operations pages once (their frame's access), so the incident can show.
  await page.click('[data-nav="aiops:incidents"]');
  await page.click('[data-grant]', { timeout: 20_000 }).catch(() => {});
  const s2 = await api('POST', '/api/sessions', { title: 'Live incident', model: MODEL, effort: 'medium', mode: 'default', runtime: 'local', path: ws, client: { kind: 'desktop', version: 'live', renderers: [], tools: ['desktop_command', 'desktop_describe', 'desktop_notify', 'desktop_open'] } });
  const id2 = s2.body.id ?? s2.body.meta?.id;
  await page.click('[data-nav="core.chat:new"]');
  await api('POST', `/api/sessions/${id2}/messages`, { text: `Show me incident ${inc} in the desktop app: use desktop_command with the command aiops:open-incident. Then reply with one short sentence.` });
  const d2 = await waitIdle(id2, 'incident');
  spent += d2.meta.cost ?? 0;
  const calls = d2.history.flatMap((m) => m.content).filter((b) => b.type === 'tool_use' && b.name === 'desktop_command');
  const resultsText = d2.history.flatMap((m) => m.content).filter((b) => b.type === 'tool_result').map((b) => (typeof b.content === 'string' ? b.content : JSON.stringify(b.content))).join('\n');
  const shown = await page.waitForSelector('[data-view="aiops:incidents"] [data-plugin-frame] iframe', { timeout: 20_000 }).then(async (f) => { const fr = await f.contentFrame(); return fr ? fr.waitForSelector(`[data-incident-detail="${inc}"]`, { timeout: 20_000 }).then(() => true, () => false) : false; }, () => false);
  await sleep(800);
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, `live-home-incident-${MODEL}.png`), await capture());
  results.push({ check: 'the agent opened the incident with desktop_command', ok: calls.some((c) => c.input?.command === 'aiops:open-incident' && c.input?.args?.id === inc) && /Opened Incidents/.test(resultsText) && shown, detail: `calls=${calls.length} result=${JSON.stringify(resultsText.slice(0, 120))} shown=${shown}`, cost: Number((d2.meta.cost ?? 0).toFixed(4)) });
  log(`session 2: $${(d2.meta.cost ?? 0).toFixed(4)} (total $${spent.toFixed(4)})`);
} catch (e) {
  results.push({ check: 'run', ok: false, detail: e instanceof Error ? e.message : String(e) });
} finally {
  await app.close().catch(() => {});
  try { fs.rmSync(data, { recursive: true, force: true, maxRetries: 3 }); } catch { /* in use (Windows) */ }
}

results.push({ check: 'no exceptions in the window', ok: errors.length === 0, detail: errors.slice(0, 3).join(' | ') });
console.log(JSON.stringify({ model: MODEL, spentUsd: Number(spent.toFixed(4)), capUsd: CAP, results }, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
