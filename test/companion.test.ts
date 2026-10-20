import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCompanionHandler, type CompanionJob } from '../src/companion/handler.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { CompanionHub } from '../src/runtime/companion.ts';
import { FakeProvider, tempDir } from './helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
// @ts-expect-error plain JS module
const { chromiumPath } = await import('../plugins/visual/lib/browser.mjs');
const hasChromium = await import('playwright-core').then(() => true, () => false) && !!chromiumPath();

/** A companion running in this process: polls the hub, runs each job with the real handler. */
function runCompanion(hub: CompanionHub, id: string, dir: string, wrap?: (job: CompanionJob, r: { ok: boolean; value: unknown }) => { ok: boolean; value: unknown }) {
  const handle = createCompanionHandler(dir);
  let on = true;
  (async () => {
    while (on) {
      const job = await hub.poll(id, { platform: 'linux', shell: 'bash', root: dir }, 200);
      if (!job) continue;
      const r = await handle(job as CompanionJob);
      const out = wrap ? wrap(job as CompanionJob, r) : r;
      hub.complete(id, job.id, out.ok, out.value);
    }
  })();
  return () => { on = false; };
}

test('mirror: a server-side copy of the companion folder, refreshed with what changed, without the heavy folders', async () => {
  const data = await tempDir();
  const hub = new CompanionHub(data);
  const { id } = await hub.create('laptop');
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, 'a.md'), '# A');
  await fs.mkdir(path.join(dir, 'docs'));
  await fs.writeFile(path.join(dir, 'docs', 'b.html'), '<h1>B</h1>');
  await fs.mkdir(path.join(dir, 'node_modules', 'x'), { recursive: true });
  await fs.writeFile(path.join(dir, 'node_modules', 'x', 'big.js'), 'x');
  const pulls: number[] = [];
  const stop = runCompanion(hub, id, dir, (job, r) => {
    if (job.kind === 'pull') pulls.push((r.value as { files: { data?: string }[] }).files.filter((f) => f.data !== undefined).length);
    return r;
  });
  try {
    const host = hub.host(id, 's1');
    const root = await host.mirror!();
    assert.equal(await fs.readFile(path.join(root, 'docs', 'b.html'), 'utf8'), '<h1>B</h1>');
    await assert.rejects(fs.stat(path.join(root, 'node_modules')));
    // Unchanged: nothing is sent again. Changed and removed files are followed.
    await host.mirror!();
    await new Promise((r) => setTimeout(r, 20));
    await fs.writeFile(path.join(dir, 'a.md'), '# A changed');
    await fs.rm(path.join(dir, 'docs', 'b.html'));
    await host.mirror!();
    assert.deepEqual(pulls, [2, 0, 1]);
    assert.equal(await fs.readFile(path.join(root, 'a.md'), 'utf8'), '# A changed');
    await assert.rejects(fs.stat(path.join(root, 'docs', 'b.html')));
    // Writing back goes through the companion, confined to its folder.
    await host.pushFile!('out/report.pdf', Buffer.from('%PDF'));
    assert.equal(await fs.readFile(path.join(dir, 'out', 'report.pdf'), 'utf8'), '%PDF');
    await assert.rejects(host.pushFile!('../escape.txt', Buffer.from('x')), /outside|workspace|path/i);
  } finally { stop(); }
});

test('mirror: a companion that sends paths outside the folder cannot write outside the copy', async () => {
  const data = await tempDir();
  const hub = new CompanionHub(data);
  const { id } = await hub.create('evil');
  const dir = await tempDir();
  const stop = runCompanion(hub, id, dir, (job, r) => (job.kind === 'pull'
    ? { ok: true, value: { files: [{ path: '../../escaped.txt', size: 1, mtime: 1, data: 'eA==' }, { path: '/etc/x', size: 1, mtime: 1, data: 'eA==' }, { path: 'ok.txt', size: 1, mtime: 1, data: 'eA==' }] } }
    : r));
  try {
    const root = await hub.host(id, 's1').mirror!();
    assert.deepEqual(await fs.readdir(root), ['ok.txt']);
    await assert.rejects(fs.stat(path.join(data, 'escaped.txt')));
    await assert.rejects(fs.stat(path.join(data, 'mirrors', 'escaped.txt')));
  } finally { stop(); }
});

test('render on a companion session: the file on the user\'s computer is rendered on the server, results written back', { skip: !hasChromium && 'no Chromium' }, async () => {
  const data = await tempDir();
  const h = await createHarness({ dataDir: data, plugins: [path.join(here, '..', 'plugins', 'visual')], search: null, memory: 'off' });
  const { id } = await h.companions.create('laptop');
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, 'notes.md'), '# Plan\n\nShip on Friday.\n');
  const stop = runCompanion(h.companions, id, dir);
  try {
    await new Promise((r) => setTimeout(r, 300));
    const fake = new FakeProvider([{ calls: [{ name: 'render', input: { path: 'notes.md' } }] }, { text: 'looks fine' }]);
    h.registry.setProviderInstance('deepseek', fake);
    const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'companion', network: 'none', companionId: id } });
    const done = new Promise<void>((r) => s.subscribe(0, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
    await s.send('render the notes');
    await done;
    const result = fake.snapshots[1]!;
    assert.match(result, /notes\.md: 1 page/);
    assert.match(result, /"images":\[\{"media_type":"image\/png"/);
    // The saved page image is on the user's computer, where the result says it is.
    const saved = await fs.readdir(path.join(dir, '.harness', 'render', 'notes.md'));
    assert.deepEqual(saved, ['page-1.png']);
  } finally { stop(); await h.close(); }
});
