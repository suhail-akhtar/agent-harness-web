// Screenshots of the running app, for the docs and as evidence of what it does.
// Drives a running server (HARNESS_AUTH=off on loopback) through its API with real
// models, then captures each screen with Chromium.
//   node scripts/screenshots.mjs [--url http://127.0.0.1:4399] [--out docs/screenshots] [--only name,name]
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { chromiumPath } from '../plugins/visual/lib/browser.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('url', 'http://127.0.0.1:4399');
const OUT = path.resolve(arg('out', 'docs/screenshots'));
const ONLY = arg('only', '')?.split(',').filter(Boolean);
const FOLDER = path.resolve(arg('folder', 'E:/tmp/hw-demo-folder'));
await fs.mkdir(OUT, { recursive: true });

const api = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', 'x-harness': '1' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : undefined;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function idle(id, ms = 600_000) {
  const end = Date.now() + ms;
  await sleep(1500);
  while (Date.now() < end) {
    const s = (await api('GET', '/api/sessions')).find((x) => x.id === id);
    if (s?.status === 'idle') return;
    await sleep(2000);
  }
  throw new Error(`session ${id} did not finish`);
}

const browser = await chromium.launch({ executablePath: chromiumPath() });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const shot = async (name, full = false) => { await sleep(600); await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: full }); console.log(`saved ${name}.png`); };
const want = (n) => !ONLY?.length || ONLY.includes(n);
const open = async (id) => { await page.goto(`${BASE}/#${id}`); await page.waitForLoadState('domcontentloaded'); await sleep(1500); };

try {
  if (want('home')) {
    await page.goto(BASE); await page.waitForLoadState('domcontentloaded');
    await shot('01-home');
  }
  if (want('new-session')) {
    await page.goto(BASE); await page.waitForLoadState('domcontentloaded');
    await page.getByRole('button', { name: '+ New session' }).click();
    await page.setViewportSize({ width: 1440, height: 1400 });
    await shot('02-new-session');
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  if (want('sandbox-task')) {
    const s = await api('POST', '/api/sessions', { title: 'Fibonacci in the sandbox', model: 'deepseek-flash', mode: 'acceptEdits', runtime: 'docker', network: 'none' });
    await api('POST', `/api/sessions/${s.id}/messages`, { text: 'Write fib.py that prints the first 15 Fibonacci numbers, add a test file test_fib.py using unittest, run both, and summarise the results.' });
    await idle(s.id);
    await open(s.id);
    await shot('03-sandbox-task');
    await shot('03-sandbox-task-full', true);
  }
  if (want('approval')) {
    await fs.mkdir(FOLDER, { recursive: true });
    await fs.writeFile(path.join(FOLDER, 'notes.txt'), 'server folder demo\n');
    const s = await api('POST', '/api/sessions', { title: 'Approval on a server folder', model: 'deepseek-flash', mode: 'default', runtime: 'local', path: FOLDER, sandbox: 'off' });
    await api('POST', `/api/sessions/${s.id}/messages`, { text: 'Count the words in notes.txt with a shell command (wc), then write the count to count.txt.' });
    await open(s.id);
    await page.getByText('Allow once').first().waitFor({ timeout: 180_000 });
    await shot('04-approval-prompt');
    for (let i = 0; i < 6; i++) {
      const b = page.getByText('Allow once').first();
      if (!(await b.isVisible().catch(() => false))) { await sleep(3000); if (!(await b.isVisible().catch(() => false))) break; }
      await b.click(); await sleep(1500);
    }
    await idle(s.id);
    await open(s.id);
    await shot('05-approved-result');
  }
  if (want('computer')) {
    const s = await api('POST', '/api/sessions', { title: 'Computer use in the desktop sandbox', model: 'claude-haiku-5-5', mode: 'acceptEdits', runtime: 'docker', network: 'none', image: 'harness-sandbox-desktop:latest' });
    await api('POST', `/api/sessions/${s.id}/messages`, { text: 'Use only the computer tool. Launch xterm, click into it, type  echo hello-from-the-desktop > /workspace/desktop.txt  and press Return, then take a screenshot and tell me what the terminal shows.' });
    await idle(s.id);
    await open(s.id);
    await shot('06-computer-use');
    await shot('06-computer-use-full', true);
  }
  if (want('workflow')) {
    const sessions = await api('GET', '/api/sessions');
    const id = sessions[0]?.id ?? (await api('POST', '/api/sessions', { model: 'deepseek-flash', runtime: 'docker', network: 'none' })).id;
    await open(id);
    await page.getByRole('button', { name: 'Workflow…' }).click();
    await shot('07-workflows');
  }
  if (want('details')) {
    const sessions = await api('GET', '/api/sessions');
    await open(sessions.find((x) => /Fibonacci/.test(x.title))?.id ?? sessions[0].id);
    const toggle = page.getByRole('button', { name: 'Session details' });
    if (await toggle.isVisible().catch(() => false)) await toggle.click();
    await shot('08-session-details');
  }
} finally { await browser.close(); }
