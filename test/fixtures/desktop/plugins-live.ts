// The plugins journey with real models (costs money: not part of npm test). Keys come from an env file:
//
//   node --env-file=<path to .env> test/fixtures/desktop/plugins-live.ts
//
// The real desktop app and the real engine (src/server/main.ts) with the quality-gates, sdlc and aiops
// plugins; the aiops inventory points at the fixture Prometheus (ops-fixture.ts) unless
// HARNESS_LIVE_OPS_INVENTORY names another (the local AIOps eval stack's, when it runs).
//   claude-sonnet-5-5 (effort medium)  builds a slugify utility with build-feature in a temporary git
//                                      repository, through the gates; the Delivery board and the gates panel
//   deepseek-flash                     /incident on the alerts posted to the aiops alert route; the incident page
//   kimi-k2.6                          one short check: the quality gates of that repository
//   glm-5.3-flash                      at most two calls: the alerts tool
// It stops a step before the cap (HARNESS_LIVE_CAP_USD, at most $3.00). Key values are never printed.
import { capture } from './png.ts';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startOpsFixture } from './ops-fixture.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const desktop = path.join(root, 'apps', 'desktop');
const SHOTS = path.join(root, 'docs', 'screenshots', 'desktop', 'plugins-journey');
const CAP = Math.min(3, Number(process.env.HARNESS_LIVE_CAP_USD ?? 3));
const log = (m: string) => console.log(`[live] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Array<{ model?: string; check: string; ok: boolean; detail?: string; cost?: number }> = [];

const { _electron } = await import('playwright-core');
const electronExe = String(createRequire(import.meta.url)('electron'));
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-live-data-'));
const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-live-slugify-')));
const opsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-live-ops-')));
execFileSync('git', ['init', '-q', repo]);
fs.writeFileSync(path.join(repo, 'README.md'), '# text-utils\n');
execFileSync('git', ['-C', repo, '-c', 'user.name=live', '-c', 'user.email=live@harness.invalid', 'add', '-A']);
execFileSync('git', ['-C', repo, '-c', 'user.name=live', '-c', 'user.email=live@harness.invalid', 'commit', '-q', '-m', 'init']);
const fixture = process.env.HARNESS_LIVE_OPS_INVENTORY ? undefined : await startOpsFixture(data);
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'NODE_TEST_CONTEXT') env[k] = v;
Object.assign(env, {
  HARNESS_DESKTOP_DATA: data, HARNESS_DESKTOP_NO_TRAY: '1', HARNESS_DESKTOP_TEST: '1', ...(process.env.HARNESS_E2E_SHOW ? { HARNESS_E2E_SHOW: process.env.HARNESS_E2E_SHOW } : {}), 
  HARNESS_PLUGINS: ['quality-gates', 'sdlc', 'aiops'].map((p) => path.join(root, 'plugins', p)).join(path.delimiter),
  HARNESS_OPS_INVENTORY: process.env.HARNESS_LIVE_OPS_INVENTORY ?? fixture!.inventory, HARNESS_OPS_ALERTS_PATH: opsDir,
  HARNESS_OPS_ALERTS_INVESTIGATE: '0', HARNESS_OPS_WATCH_SECONDS: '0', HARNESS_PLUGIN_LOOPS: 'off',
});
const app = await _electron.launch({ executablePath: electronExe, args: [desktop], env, timeout: 60_000 });
const page = await app.firstWindow();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
const api = (method: string, p: string, body?: unknown) => page.evaluate(async ([m, u, b]) => { const r = await fetch(u as string, { method: m as string, headers: { 'content-type': 'application/json', 'x-harness': '1' }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) }; }, [method, p, body] as const) as Promise<{ status: number; body: any }>;
const invoke = (channel: string, ...args: unknown[]) => page.evaluate(([c, a]) => (window as unknown as { harnessDesktop: { invoke: (c: string, ...x: unknown[]) => Promise<unknown> } }).harnessDesktop.invoke(c as string, ...(a as unknown[])), [channel, args] as const);
const ready = () => page.waitForSelector('[data-engine-status="ready"]', { timeout: 120_000 });
const frame = (sel: string) => page.frameLocator(`${sel} iframe`);
const shot = async (name: string) => { await sleep(600); fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, `live-${name}.png`), await capture(app)); };
let spent = 0;
const costOf = async (id: string) => Number((await api('GET', `/api/sessions/${id}`)).body?.meta?.cost ?? 0);

/** Waits for a session to finish its turn (and a workflow run), allowing what the mode asks about in its own temporary folder, under the cap. */
async function waitIdle(id: string, label: string, o: { budget: number; minutes?: number; workflow?: boolean }) {
  const until = Date.now() + (o.minutes ?? 10) * 60_000;
  let seen = false;
  for (;;) {
    const d = (await api('GET', `/api/sessions/${id}`)).body;
    if (d?.status !== 'idle') seen = true;
    for (const ev of d?.pending ?? []) {
      if (ev.kind === 'permission_request') { log(`${label}: allowing ${ev.tool}`); await api('POST', `/api/sessions/${id}/respond`, { requestId: ev.requestId, decision: 'allow' }); }
      if (ev.kind === 'approval_request') { log(`${label}: approving "${ev.title}"`); await api('POST', `/api/sessions/${id}/respond`, { requestId: ev.requestId, decision: 'approve' }); }
    }
    const cost = Number(d?.meta?.cost ?? 0);
    if (cost > o.budget) { log(`${label}: $${cost.toFixed(4)} is over its budget $${o.budget}: stopping it`); await api('POST', `/api/sessions/${id}/abort`, {}); return { d, stopped: true }; }
    if (d?.status === 'idle' && seen) {
      if (!o.workflow) return { d, stopped: false };
      const runs = (await api('GET', `/api/sessions/${id}/workflows`)).body?.runs ?? [];
      if (runs.length && runs.every((r: { status: string }) => !['running', 'waiting'].includes(r.status))) return { d, stopped: false };
    }
    if (Date.now() > until) { await api('POST', `/api/sessions/${id}/abort`, {}); return { d, stopped: true }; }
    await sleep(2000);
  }
}
const lastText = (d: any) => (d?.history ?? []).filter((m: any) => m.role === 'assistant').flatMap((m: any) => m.content).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();

try {
  await ready();
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; if (w.isMaximized()) w.unmaximize(); w.setSize(1360, 900); });
  await invoke('prefs:set', { onboardingDone: true, defaultMode: 'acceptEdits' });
  for (const dir of [repo, opsDir]) { await invoke('projects:add', dir); await sleep(1500); await ready(); }
  for (let i = 0; i < 60 && (await api('GET', '/api/health')).status !== 200; i++) await sleep(500);
  const models = (await api('GET', '/api/models')).body;
  const ids: string[] = (Array.isArray(models) ? models : models?.models ?? []).filter((m: any) => m.available).map((m: any) => m.id);
  log(`models with a key: ${ids.join(', ')}`);
  const create = async (model: string, dir: string, title: string) => (await api('POST', '/api/sessions', { title, model, effort: 'medium', mode: 'acceptEdits', runtime: 'local', path: dir, client: { kind: 'desktop', version: 'live', renderers: [], tools: [] } })).body.id as string;

  // ---- 1. claude-sonnet-5-5: a feature through build-feature, to the gates ----
  if (ids.includes('claude-sonnet-5-5')) {
    const id = await create('claude-sonnet-5-5', repo, 'Feature: slugify');
    log('claude-sonnet-5-5: build-feature (slugify)');
    const started = await api('POST', `/api/sessions/${id}/workflows`, { name: 'build-feature', input: { request: 'Add src/slugify.js exporting slugify(text): lower-case ASCII words joined by single dashes, accents removed (é -> e), other characters dropped, at most 60 characters and never ending in a dash. Node 22, ES modules, no dependencies; tests with node:test run by npm test. Keep it small: one module, one test file, a short README section.', approval: 'auto', stack: 'Node 22, node:test, no dependencies' } });
    if (started.status >= 300) results.push({ model: 'claude-sonnet-5-5', check: 'build-feature started', ok: false, detail: JSON.stringify(started.body).slice(0, 200) });
    else {
      const { d, stopped } = await waitIdle(id, 'sonnet', { budget: Math.min(2.2, CAP - 0.6), minutes: 25, workflow: true });
      const cost = await costOf(id); spent += cost;
      const runs = (await api('GET', `/api/sessions/${id}/workflows`)).body?.runs ?? [];
      const run = runs[0];
      const gates = (await api('POST', '/api/plugins/sdlc/gates', { session: id })).body;
      const testsOk = fs.existsSync(path.join(repo, 'src', 'slugify.js'));
      results.push({ model: 'claude-sonnet-5-5', check: 'build-feature reached the gates', ok: !!run && run.history.some((h: any) => h.type === 'gate') && testsOk, detail: `run ${run?.status} at ${run?.current}; steps ${run?.history.map((h: any) => `${h.node}:${h.outcome ?? h.status}`).join(' ')}; gates ${gates.gates?.map((g: any) => `${g.name}=${g.status}`).join(',')}; tests ${JSON.stringify(gates.tests)}${stopped ? ' (stopped at its budget)' : ''}`, cost });
      log(`claude-sonnet-5-5: $${cost.toFixed(4)}; ${lastText(d).slice(0, 120).replace(/\s+/g, ' ')}`);
      // The Delivery board and the gates panel, in the window.
      await page.click('[data-nav="sdlc:delivery"]');
      if (await page.locator('[data-trust-gate="sdlc"]').count()) await page.click('[data-grant]');
      const board = frame('[data-view="sdlc:delivery"] [data-plugin-frame]');
      await board.locator('[data-delivery]').first().click({ timeout: 30_000 });
      await board.locator('[data-gate-table], .detail p').first().waitFor({ timeout: 20_000 }).catch(() => {});
      await shot('sonnet-delivery-board');
      await page.click(`[data-session-row="${id}"] button`);
      await page.click('[data-topbar] button[aria-label="Quality gates"]');
      await frame('[data-side-panel] [data-plugin-frame="sdlc"]').locator('[data-gate], [data-empty]').first().waitFor({ timeout: 20_000 }).catch(() => {});
      await shot('sonnet-gates-panel');
      await page.click('[data-topbar] button[aria-label="Quality gates"]');
    }
  } else results.push({ model: 'claude-sonnet-5-5', check: 'listed with a key', ok: false });

  // ---- 2. deepseek-flash: an investigation of the alerts the aiops route received ----
  const logs = ((await invoke('engine:logs')) as string[]).join('\n');
  const origin = [...logs.matchAll(/listening on (http:\/\/127\.0\.0\.1:\d+)/g)].at(-1)?.[1];
  const tokens = (await api('POST', '/api/plugin-routes')).body as Array<{ plugin: string; path: string; token?: string }>;
  const tok = (p: string) => tokens.find((r) => r.plugin === 'aiops' && r.path === p)?.token ?? '';
  const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  if (origin) {
    await fetch(`${origin}/api/plugins/aiops/changes`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-harness-route-token': tok('changes') }, body: JSON.stringify({ kind: 'deploy', target: 'checkout', service: 'checkout', env: 'prod', summary: 'v42 rolled out (payment client 3.2)', by: 'github-actions', at: at(14) }) });
    await fetch(`${origin}/api/plugins/aiops/alerts`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-harness-route-token': tok('alerts') }, body: JSON.stringify({ alerts: [{ name: 'CheckoutErrorRatio', severity: 'critical', service: 'checkout', env: 'prod', summary: '21% of checkout requests fail', value: '0.21', startsAt: at(12) }, { name: 'CheckoutLatencyHigh', severity: 'warning', service: 'checkout', env: 'prod', summary: 'p95 1.8 s', startsAt: at(11) }] }) });
  }
  if (ids.includes('deepseek-flash') && spent < CAP - 0.3) {
    const id = await create('deepseek-flash', opsDir, 'Checkout errors');
    log('deepseek-flash: /incident');
    await api('POST', `/api/sessions/${id}/messages`, { text: 'Open an incident for: checkout errors after the v42 deploy\n\nUse the incident tool (action open: a title, the severity by user impact, the affected services, a summary), then triage it read-only with the alerts tool, ops_check, slo_status, topology (dependencies of checkout) and change_timeline, and add what you find to its timeline with the evidence ids. When you have a root cause, add a note starting "Root cause:" citing the evidence ids, with your confidence. Change nothing.' });
    const { d } = await waitIdle(id, 'deepseek', { budget: 0.4, minutes: 10 });
    const cost = await costOf(id); spent += cost;
    const list = (await api('POST', '/api/plugins/aiops/console/incidents', { status: 'all' })).body?.incidents ?? [];
    const rec = list.find((x: any) => x.source === 'workspace') ?? list.find((x: any) => x.sessionId === id);
    results.push({ model: 'deepseek-flash', check: 'incident opened and triaged with evidence', ok: !!rec, detail: `${list.length} incident(s); record ${rec?.id ?? 'none'}; ${lastText(d).slice(0, 160).replace(/\s+/g, ' ')}`, cost });
    await page.click('[data-nav="aiops:incidents"]');
    if (await page.locator('[data-trust-gate="aiops"]').count()) await page.click('[data-grant]');
    const v = frame('[data-view="aiops:incidents"] [data-plugin-frame]');
    await v.locator('[data-incident]').first().waitFor({ timeout: 30_000 }).catch(() => {});
    await v.locator('.seg button', { hasText: 'All' }).click().catch(() => {});
    if (rec) await v.locator(`[data-incident="${rec.id}"]`).click({ timeout: 20_000 }).catch(() => {});
    await frame('[data-view="aiops:incidents"] [data-plugin-frame]').locator('[data-incident-detail]').waitFor({ timeout: 20_000 }).catch(() => {});
    await shot('deepseek-incident');
  }

  // ---- 3. kimi-k2.6: one short check ----
  if (ids.includes('kimi-k2.6') && spent < CAP - 0.2) {
    const id = await create('kimi-k2.6', repo, 'Kimi: gates');
    await api('POST', `/api/sessions/${id}/messages`, { text: 'Run the quality_gates tool once in this folder and reply with one line per gate: PASS/FAIL/WARN and its name. Nothing else.' });
    const { d } = await waitIdle(id, 'kimi', { budget: 0.2, minutes: 6 });
    const cost = await costOf(id); spent += cost;
    results.push({ model: 'kimi-k2.6', check: 'quality gates through the tool', ok: /PASS|FAIL|WARN/.test(lastText(d)), detail: lastText(d).slice(0, 200).replace(/\s+/g, ' '), cost });
  }

  // ---- 4. glm-5.3-flash: at most two tiny calls ----
  if (ids.includes('glm-5.3-flash') && spent < CAP - 0.1) {
    const id = await create('glm-5.3-flash', opsDir, 'GLM: alerts');
    await api('POST', `/api/sessions/${id}/messages`, { text: 'Call the alerts tool once with action "list", then reply with only the incident ids it lists, one per line. Do not call any other tool.' });
    const { d } = await waitIdle(id, 'glm', { budget: 0.05, minutes: 4 });
    const cost = await costOf(id); spent += cost;
    const calls = (d?.history ?? []).filter((m: any) => m.role === 'assistant').length;
    results.push({ model: 'glm-5.3-flash', check: 'the alerts tool (at most two calls)', ok: /alr-/.test(lastText(d)) && calls <= 2, detail: `${calls} call(s): ${lastText(d).slice(0, 160).replace(/\s+/g, ' ')}`, cost });
  }
} catch (e) {
  results.push({ check: 'run', ok: false, detail: e instanceof Error ? e.message : String(e) });
} finally {
  await app.close().catch(() => {});
  fixture?.close();
  for (const d of [data, repo, opsDir]) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* in use */ } }
}
results.push({ check: 'no exceptions in the window', ok: errors.length === 0, detail: errors.slice(0, 3).join(' | ') });
console.log(JSON.stringify({ spentUsd: Number(spent.toFixed(4)), capUsd: CAP, results }, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
