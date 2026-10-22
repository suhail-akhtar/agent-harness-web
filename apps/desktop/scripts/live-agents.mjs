/**
 * The live check of the agent platform in the real app: the real engine, real models, the window
 * driven with playwright-core. Not part of npm test (it costs money). Keys come from an env file:
 *
 *   node --env-file=<path to .env> apps/desktop/scripts/live-agents.mjs
 *
 * On claude-sonnet-5-5 (effort medium), then deepseek-flash, in a temporary git repository:
 *   1. an HTML artifact made and updated (two versions; the panel opened from its card);
 *   2. two linked sessions in parallel that report back, one started at once and one offered
 *      (its proposal card's Start is clicked in the window);
 *   3. a review sub-agent delegated from deepseek-flash to claude-sonnet-5-5 (the delegation
 *      setting allows it);
 *   4. desktop_describe and desktop_open (the agent opens the Library);
 * then one short session each on kimi-k2.6 and glm-5.3-flash (GLM: one tiny call).
 * Screenshots in docs/screenshots/desktop/live-agents-*.png. It stops before a step that would
 * pass the cap ($2.50, HARNESS_LIVE_CAP_USD to lower it). Key values are never printed.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const repo = path.resolve(desktop, '..', '..');
const require = createRequire(import.meta.url);
const CAP = Math.min(2.5, Number(process.env.HARNESS_LIVE_CAP_USD ?? 2.5));
const SHOTS = path.join(repo, 'docs', 'screenshots', 'desktop');
const ONLY = (process.env.HARNESS_LIVE_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const run = (name) => !ONLY.length || ONLY.includes(name);

const log = (m) => console.log(`[live] ${m}`);
const results = [];
const costs = {};
const spent = () => Object.values(costs).reduce((a, b) => a + b, 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { _electron } = await import('playwright-core');
const electronExe = require('electron');
if (!fs.existsSync(path.join(desktop, 'dist', 'main.cjs'))) { log('building the app first'); const { spawnSync } = await import('node:child_process'); spawnSync(process.execPath, [path.join(here, 'build.mjs')], { stdio: 'inherit', cwd: repo }); }

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-live-ag-data-'));
const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-live-ag-repo-')));
// A small git repository: linked sessions and sub-agents can have worktrees of it.
fs.writeFileSync(path.join(project, 'README.md'), '# Demo\n\nA tiny project for the live check.\n');
fs.writeFileSync(path.join(project, 'last.js'), 'export function last(a) {\n  return a[a.length];\n}\n');
const git = (...a) => execFileSync('git', ['-C', project, ...a], { stdio: 'pipe' });
git('init', '-q'); git('-c', 'user.email=live@example.com', '-c', 'user.name=Live', 'add', '.'); git('-c', 'user.email=live@example.com', '-c', 'user.name=Live', 'commit', '-q', '-m', 'init');

const app = await _electron.launch({ executablePath: electronExe, args: [desktop], env: { ...process.env, HARNESS_DESKTOP_DATA: data, HARNESS_DESKTOP_NO_TRAY: '1' }, timeout: 60_000 });
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const api = (method, p, body) => page.evaluate(async ([m, u, b]) => { const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json', 'x-harness': '1' }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) }; }, [method, p, body]);
const invoke = (channel, ...args) => page.evaluate(([c, a]) => window.harnessDesktop.invoke(c, ...a), [channel, args]);
const ready = () => page.waitForSelector('[data-engine-status="ready"]', { timeout: 120_000 });
const shot = async (name) => { fs.mkdirSync(SHOTS, { recursive: true }); await sleep(500); await page.screenshot({ path: path.join(SHOTS, `live-agents-${name}.png`) }); };

/** Everything a session (and the sessions it started) cost. */
async function costOf(id, seen = new Set()) {
  if (seen.has(id)) return 0;
  seen.add(id);
  const d = (await api('GET', `/api/sessions/${id}`)).body;
  let c = d?.meta?.cost ?? 0;
  for (const k of d?.meta?.linked ?? []) c += await costOf(k, seen);
  return c;
}

/** Waits for a conversation to be idle, answering its permission requests: allowed, except `deny` (with why). */
async function waitIdle(id, label, ms = 300_000, deny = []) {
  const until = Date.now() + ms;
  let seenRunning = false;
  for (;;) {
    const d = (await api('GET', `/api/sessions/${id}`)).body;
    if (d?.status === 'running' || d?.status === 'waiting') seenRunning = true;
    for (const ev of d?.pending ?? []) {
      if (ev.kind !== 'permission_request') continue;
      const no = deny.includes(ev.tool);
      log(`${label}: ${no ? 'denying' : 'allowing'} ${ev.tool}`);
      await api('POST', `/api/sessions/${id}/respond`, { requestId: ev.requestId, decision: no ? 'deny' : 'allow', ...(no ? { feedback: 'Not needed: the linked sessions report back on their own. End your turn now.' } : {}) });
    }
    if (d?.status === 'idle' && (seenRunning || (d?.history?.length ?? 0) > 1)) return d;
    if (Date.now() > until) throw new Error(`${label}: not idle within ${ms / 1000} s`);
    await sleep(1000);
  }
}

/** Starts a conversation from the home page, as a person does (the app's own client declaration). */
async function startChat(model, text) {
  await invoke('prefs:set', { defaultModel: model, defaultEffort: 'medium', defaultMode: 'acceptEdits', onboardingDone: true });
  await page.click('[data-nav="core.chat:new"]');
  await page.waitForSelector('[data-home]');
  await sleep(400);
  const box = page.locator('[data-composer-input]').first();
  await box.fill(text);
  await box.press('Enter');
  await page.waitForSelector('[data-session]', { timeout: 30_000 });
  return page.getAttribute('[data-session]', 'data-session');
}

const lastReply = (d) => (d.history.filter((m) => m.role === 'assistant').at(-1)?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
const toolsUsed = (d) => d.history.flatMap((m) => m.content.filter((b) => b.type === 'tool_use').map((b) => b.name));
const room = (need) => { if (spent() + need > CAP) { log(`stopping: $${spent().toFixed(4)} spent, the next step may need ~$${need} (cap $${CAP})`); return false; } return true; };

try {
  await ready();
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.unmaximize(); w.setSize(1440, 900); });
  await invoke('projects:add', project);
  await sleep(1500);
  await ready();
  for (let i = 0; i < 40 && (await api('GET', '/api/health')).status !== 200; i++) await sleep(500);
  await page.evaluate((p) => localStorage.setItem('harness.workIn', p), project);
  const providers = (await api('GET', '/api/providers')).body;
  for (const p of Array.isArray(providers) ? providers : []) log(`provider ${p.id}: ${p.configured ? 'configured' : 'no key'}`);
  // Delegation: deepseek-flash may hand a review to claude-sonnet-5-5 (and back), without asking.
  const mine = (await api('GET', '/api/me/settings')).body ?? {};
  await api('PUT', '/api/me/settings', { ...mine, delegation: { allowedModels: ['claude-sonnet-5-5', 'deepseek-flash'], maxCostUsd: 0.5 } });
  await page.reload();
  await ready();
  await page.waitForSelector('[data-home]');

  const artifactStep = async (model) => {
    if (!run('artifact') || !room(0.25)) return;
    log(`${model}: artifact`);
    const id = await startChat(model, 'Make an HTML artifact titled "Release checklist": a small, nicely styled page with a checklist of four release steps. Then use the artifact tool\'s update action to add a fifth item, "Tag the release". Keep your reply to one line.');
    const d = await waitIdle(id, `${model} artifact`);
    costs[`${model} artifact`] = await costOf(id);
    const arts = (await api('GET', `/api/sessions/${id}/artifacts`)).body ?? [];
    const a = arts.find((x) => x.kind === 'html');
    let opened = false;
    if (a) {
      await page.click(`[data-session-row="${id}"] button`).catch(() => {});
      const card = page.locator(`[data-artifact-ref="${a.id}"]`).first();
      if (await card.count()) { await card.click(); opened = await page.waitForSelector(`[data-side-panel] [data-artifact-detail="${a.id}"] iframe, [data-side-panel] [data-artifact-detail="${a.id}"]`, { timeout: 20_000 }).then(() => true, () => false); }
    }
    await shot(`${model}-artifact`);
    await page.click('[data-side-panel] button[aria-label="Close the panel"]').catch(() => {});
    results.push({ model, check: 'HTML artifact made and updated (versions in the panel)', ok: !!a && a.version >= 2 && opened, detail: a ? `${a.id} v${a.version}; panel ${opened}; reply ${JSON.stringify(lastReply(d).slice(0, 80))}` : `no html artifact (tools: ${toolsUsed(d).join(',')})`, cost: costs[`${model} artifact`] });
  };

  const linkedStep = async (model) => {
    if (!run('linked') || !room(0.5)) return;
    log(`${model}: linked sessions`);
    const id = await startChat(model, 'Run two small tasks as linked sessions, in parallel, with start_session (context fresh, use_worktree true): (1) title "Haiku", initiation user_asked: write a haiku about unit tests into haiku.txt and commit it; (2) title "Word count", initiation offer: count the words of README.md and reply with the number. Do not do them yourself. When the reports come back, summarise both in one line.');
    // The parent should not wait for its children itself (they report back): no commands for it.
    await waitIdle(id, `${model} linked (parent)`, 300_000, ['bash']);
    // The offered one: Start on its card, in the window.
    await page.click(`[data-session-row="${id}"] button`).catch(() => {});
    const start = page.locator('[data-proposal-start]').first();
    const proposed = await start.waitFor({ timeout: 30_000 }).then(() => true, () => false);
    if (proposed) await start.click();
    // Both children work and report; the parent continues on its own with the reports.
    const until = Date.now() + 360_000;
    let d;
    for (;;) {
      d = (await api('GET', `/api/sessions/${id}`)).body;
      const kids = d.meta.linked ?? [];
      const states = await Promise.all(kids.map(async (k) => (await api('GET', `/api/sessions/${k}`)).body?.status));
      const reports = JSON.stringify(d.history).match(/Linked session \\"[^\\]*\\" \([a-f0-9]{16}\) (finished|ended|was stopped)/g)?.length ?? 0;
      if (kids.length >= 2 && states.every((s) => s === 'idle') && reports >= 2 && d.status === 'idle') break;
      if (Date.now() > until) break;
      for (const k of [id, ...kids]) { const x = (await api('GET', `/api/sessions/${k}`)).body; for (const ev of x?.pending ?? []) if (ev.kind === 'permission_request') await api('POST', `/api/sessions/${k}/respond`, { requestId: ev.requestId, decision: 'allow' }); }
      await sleep(2000);
    }
    costs[`${model} linked`] = await costOf(id);
    await page.click(`[data-session-row="${id}"] button`).catch(() => {});
    await page.click('[data-panel-toggle="core.agents:agents"]').catch(() => {});
    await page.waitForSelector('[data-agents-panel] [data-linked-session]', { timeout: 15_000 }).catch(() => {});
    await shot(`${model}-linked`);
    await page.click('[data-side-panel] button[aria-label="Close the panel"]').catch(() => {});
    const kids = d.meta.linked ?? [];
    const reports = JSON.stringify(d.history).match(/Linked session \\"[^\\]*\\" \([a-f0-9]{16}\) (finished|ended|was stopped)/g)?.length ?? 0;
    const haiku = (() => { try { return execFileSync('git', ['-C', project, 'branch', '--list'], { encoding: 'utf8' }); } catch { return ''; } })();
    results.push({ model, check: 'two linked sessions in parallel reported back (one started from its proposal card)', ok: kids.length >= 2 && reports >= 2 && proposed, detail: `children ${kids.length}, reports ${reports}, proposal clicked ${proposed}, branches ${haiku.split('\n').filter(Boolean).length}; reply ${JSON.stringify(lastReply(d).slice(0, 100))}`, cost: costs[`${model} linked`] });
  };

  const desktopStep = async (model) => {
    if (!run('desktop') || !room(0.2)) return;
    log(`${model}: desktop tools`);
    const id = await startChat(model, 'Call desktop_describe to see what this app has. Then call desktop_open with target "view" and id "core.artifacts:library". Then tell me in one line how many agent-callable commands the app has.');
    const opened = await page.waitForSelector('[data-library]', { timeout: 120_000 }).then(() => true, () => false);
    if (opened) await shot(`${model}-desktop-open`);
    const d = await waitIdle(id, `${model} desktop`);
    costs[`${model} desktop`] = await costOf(id);
    const used = toolsUsed(d);
    const errs = d.history.flatMap((m) => m.content.filter((b) => b.type === 'tool_result' && b.is_error)).length;
    await page.click(`[data-session-row="${id}"] button`).catch(() => {});
    await page.waitForSelector(`[data-session="${id}"] [data-assistant-message]`, { timeout: 15_000 }).catch(() => {});
    await shot(`${model}-desktop`);
    results.push({ model, check: 'desktop_describe and desktop_open answered by the app (the Library opened)', ok: used.includes('desktop_describe') && used.includes('desktop_open') && opened && errs === 0, detail: `tools ${used.join(',')}; errors ${errs}; reply ${JSON.stringify(lastReply(d).slice(0, 100))}`, cost: costs[`${model} desktop`] });
  };

  // One failing step is reported and the others still run.
  const guarded = async (name, f) => { try { await f(); } catch (e) { results.push({ check: name, ok: false, detail: e instanceof Error ? e.message : String(e) }); } };
  const MODELS = (process.env.HARNESS_LIVE_MODELS ?? 'claude-sonnet-5-5,deepseek-flash').split(',').map((x) => x.trim()).filter(Boolean);
  for (const model of MODELS) {
    await guarded(`${model} artifact`, () => artifactStep(model));
    await guarded(`${model} linked`, () => linkedStep(model));
    await guarded(`${model} desktop`, () => desktopStep(model));
  }

  if (run('delegate') && room(0.15)) {
    log('delegation: deepseek-flash -> claude-sonnet-5-5');
    const id = await startChat('deepseek-flash', 'Use the agent tool with model "claude-sonnet-5-5" (type explore) to review last.js for bugs. Then report its finding in one line. Do not review it yourself.');
    const d = await waitIdle(id, 'delegation');
    costs.delegation = await costOf(id);
    const byModel = d.meta.byModel ?? {};
    await page.click(`[data-session-row="${id}"] button`).catch(() => {});
    await page.click('[data-panel-toggle="core.agents:agents"]').catch(() => {});
    const shown = await page.waitForSelector('[data-agents-panel] [data-subagent-model]:has-text("claude-sonnet-5-5")', { timeout: 20_000 }).then(() => true, () => false);
    await shot('delegation');
    await page.click('[data-side-panel] button[aria-label="Close the panel"]').catch(() => {});
    results.push({ model: 'deepseek-flash', check: 'review sub-agent delegated to claude-sonnet-5-5 (cost per model)', ok: !!byModel['claude-sonnet-5-5'] && shown, detail: `byModel ${Object.entries(byModel).map(([k, v]) => `${k} $${v.cost.toFixed(4)}`).join(', ')}; reply ${JSON.stringify(lastReply(d).slice(0, 120))}`, cost: costs.delegation });
  }

  for (const [model, text] of [['kimi-k2.6', 'Call desktop_describe, then reply in one line: how many views does the app have?'], ['glm-5.3-flash', 'Reply with five words: hello from GLM in Harness.']]) {
    if (!run('others') || !room(0.05)) continue;
    log(`${model}: a short session`);
    const id = await startChat(model, text);
    const d = await waitIdle(id, model, 180_000);
    costs[model] = await costOf(id);
    await page.waitForSelector(`[data-session="${id}"] [data-assistant-message]`, { timeout: 15_000 }).catch(() => {});
    await shot(model);
    const reply = lastReply(d);
    results.push({ model, check: 'a short session in the app', ok: !!reply, detail: `calls ${Object.values(d.meta.byModel ?? {}).reduce((n, v) => n + v.requests, 0)}; tools ${toolsUsed(d).join(',') || 'none'}; reply ${JSON.stringify(reply.slice(0, 100))}`, cost: costs[model] });
  }
} catch (e) {
  results.push({ check: 'run', ok: false, detail: e instanceof Error ? e.message : String(e) });
} finally {
  await app.close().catch(() => {});
  try { fs.rmSync(data, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true }); } catch { /* in use */ }
}

results.push({ check: 'no exceptions in the window', ok: errors.length === 0, detail: errors.slice(0, 3).join(' | ') });
console.log(JSON.stringify({ spentUsd: Number(spent().toFixed(4)), capUsd: CAP, costs: Object.fromEntries(Object.entries(costs).map(([k, v]) => [k, Number(v.toFixed(4))])), results }, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
