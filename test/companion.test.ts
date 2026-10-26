import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCompanionHandler, type CompanionJob } from '../src/companion/handler.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { CompanionHub, mirrorPath } from '../src/runtime/companion.ts';
import { DockerHost, dockerAvailable, dockerDefaults, imageExists } from '../src/runtime/docker.ts';
import { FakeProvider, fakeGodot, tempDir, testPicture } from './helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const { chromiumPath } = await import('../plugins/visual/lib/browser.mjs');
const hasChromium = await import('playwright-core').then(() => true, () => false) && !!chromiumPath();
const IMAGE_3D = 'harness-sandbox-3d:latest';
const has3d = (await dockerAvailable()) && (await imageExists(IMAGE_3D));

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
    ? { ok: true, value: { files: ['../../escaped.txt', '/etc/x', '..\\..\\escaped.txt', 'a\\..\\..\\..\\escaped.txt', 'C:escaped.txt', 'C:\\escaped.txt', 'a/./b', 'ok.txt'].map((p) => ({ path: p, size: 1, mtime: 1, data: 'eA==' })) } }
    : r));
  try {
    const root = await hub.host(id, 's1').mirror!();
    // On Windows, \ and : are refused; elsewhere they are ordinary characters of one file name inside the copy.
    const expected = process.platform === 'win32' ? ['ok.txt'] : ['..\\..\\escaped.txt', 'C:\\escaped.txt', 'C:escaped.txt', 'a\\..\\..\\..\\escaped.txt', 'ok.txt'];
    assert.deepEqual((await fs.readdir(root)).sort(), expected.sort());
    for (const n of await fs.readdir(root)) assert.ok((await fs.lstat(path.join(root, n))).isFile(), `${n} is a plain file in the copy`);
    await assert.rejects(fs.stat(path.join(data, 'escaped.txt')));
    await assert.rejects(fs.stat(path.join(data, 'mirrors', 'escaped.txt')));
  } finally { stop(); }
  // What Windows would read as a path out of the copy.
  const root = path.join(data, 'mirrors', 's1');
  for (const p of ['..\\..\\users.json', 'a\\..\\..\\x', 'C:x', 'C:\\x', '\\\\server\\share']) assert.equal(mirrorPath(root, p, 'win32'), undefined, p);
  for (const p of ['a//b', 'a/../b', '', 'a\0b', '/etc/x']) assert.equal(mirrorPath(root, p), undefined, p);
  assert.equal(mirrorPath(root, 'docs/a.md'), path.join(root, 'docs', 'a.md'));
  // On a Linux or macOS server ":" and "\" are ordinary name characters (a Mac's "10:00.png"), and stay inside.
  assert.equal(mirrorPath(root, 'shots/10:00.png', 'linux'), path.join(root, 'shots', '10:00.png'));
  if (process.platform !== 'win32') assert.equal(mirrorPath(root, '..\\..\\users.json'), path.join(root, '..\\..\\users.json'));
  // Whatever the rules say, the result is never outside the copy.
  assert.equal(mirrorPath(root, '..\\..\\users.json', process.platform === 'win32' ? 'linux' : 'win32'), undefined);
});

test('mirror: a large folder comes over in several replies; secrets stay on the computer; the copy goes with the session', async () => {
  const data = await tempDir();
  const hub = new CompanionHub(data, { mirrorChunkBytes: 10 });
  const { id } = await hub.create('laptop');
  const dir = await tempDir();
  for (const n of ['a', 'b', 'c']) await fs.writeFile(path.join(dir, `${n}.txt`), `${n}`.repeat(8));
  await fs.writeFile(path.join(dir, '.env'), 'API_KEY=secret');
  await fs.writeFile(path.join(dir, 'server.pem'), 'key');
  let pulls = 0;
  const stop = runCompanion(hub, id, dir, (job, r) => { if (job.kind === 'pull') pulls++; return r; });
  try {
    const root = await hub.host(id, 's1').mirror!();
    assert.equal(pulls, 3, 'one file per reply at 10 bytes a reply');
    assert.deepEqual((await fs.readdir(root)).sort(), ['a.txt', 'b.txt', 'c.txt']);
    // A deletion is applied only once the whole listing is in.
    await fs.rm(path.join(dir, 'b.txt'));
    await hub.host(id, 's1').mirror!();
    assert.deepEqual((await fs.readdir(root)).sort(), ['a.txt', 'c.txt']);
    await hub.forget('s1');
    await assert.rejects(fs.stat(root));
  } finally { stop(); }
});

test('visual gates on a companion decide from a listing, and an offline companion fails no gate', async () => {
  const h = await createHarness({ dataDir: await tempDir(), plugins: [path.join(here, '..', 'plugins', 'visual')], search: null, memory: 'off' });
  try {
    const gate = (n: string) => h.registry.gates.get(n)!;
    let mirrored = 0;
    const host = (list: string | Error) => ({ kind: 'companion', root: '', mirror: async () => { mirrored++; return ''; }, pushFile: async () => {}, remoteTool: async () => { if (list instanceof Error) throw list; return { content: list }; } });
    const sig = new AbortController().signal;
    assert.equal(await gate('web-console').applies!(host('public/index.html') as never, sig), true);
    assert.equal(await gate('playtest').applies!(host('levels/playtest.json') as never, sig), false, 'only the one at the root');
    assert.equal(await gate('documents-render').applies!(host('No files match **/*.pdf.') as never, sig), false);
    assert.equal(await gate('documents-render').applies!(host(new Error('companion offline')) as never, sig), false);
    // Only documents the gate's own walk would find: not too deep, not in skipped folders, not Office lock files.
    assert.equal(await gate('documents-render').applies!(host('docs/a/b/c/d/e/report.pdf\n~$deck.pptx\n.cache/x.pdf\nnode_modules/p/doc.pdf') as never, sig), false);
    assert.equal(await gate('documents-render').applies!(host('~$deck.pptx\ndocs\\q3\\deck.pptx') as never, sig), true, 'a Windows companion lists with backslashes');
    assert.equal(mirrored, 0, 'deciding copied nothing');
  } finally { await h.close(); }
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

/** Like runCompanion, with the handler's options (trust, a host). */
function runCompanionWith(hub: CompanionHub, id: string, dir: string, opts: Parameters<typeof createCompanionHandler>[1], info: Record<string, unknown> = {}) {
  const handle = createCompanionHandler(dir, opts);
  let on = true;
  (async () => {
    while (on) {
      const job = await hub.poll(id, { platform: process.platform, shell: 'bash', root: dir, ...info }, 200);
      if (!job) continue;
      const r = await handle(job as CompanionJob);
      hub.complete(id, job.id, r.ok, r.value);
    }
  })();
  return () => { on = false; };
}

test('companion checkpoints: files the agent changes on the user\'s computer are saved first and can be rewound', async () => {
  const h = await createHarness({ dataDir: await tempDir(), search: null, memory: 'off' });
  const { id } = await h.companions.create('laptop');
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, 'notes.md'), 'original\n');
  const stop = runCompanionWith(h.companions, id, dir, {});
  h.registry.setProviderInstance('deepseek', new FakeProvider([
    { calls: [{ name: 'read', input: { path: 'notes.md' } }] },
    { calls: [{ name: 'write', input: { path: 'notes.md', content: 'changed\n' } }, { name: 'write', input: { path: 'sub/new.md', content: 'new\n' } }] },
    { text: 'done' },
  ]));
  try {
    await new Promise((r) => setTimeout(r, 300));
    const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'companion', network: 'none', companionId: id } });
    const done = new Promise<void>((r) => s.subscribe(0, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
    await s.send('change the notes');
    await done;
    assert.equal(await fs.readFile(path.join(dir, 'notes.md'), 'utf8'), 'changed\n');
    const turns = await s.listCheckpoints();
    assert.deepEqual(turns.map((t) => t.files.sort()), [['notes.md', 'sub/new.md']]);
    const restored = await s.rewind(turns[0]!.turn);
    assert.deepEqual(restored, ['notes.md', 'sub/new.md']);
    assert.equal(await fs.readFile(path.join(dir, 'notes.md'), 'utf8'), 'original\n', 'restored on the user\'s computer');
    await assert.rejects(fs.stat(path.join(dir, 'sub', 'new.md')), 'a file the turn created is removed');
  } finally { stop(); await h.close(); }
});

test('companion project MCP servers: started on the user\'s computer only when trusted or sandboxed, their tools usable from the session', async () => {
  const fixture = path.join(here, 'fixtures', 'mcp-server.mjs');
  for (const trusted of [false, true]) {
    const h = await createHarness({ dataDir: await tempDir(), search: null, memory: 'off' });
    const { id } = await h.companions.create('laptop');
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { local: { command: process.execPath, args: [fixture] } } }));
    const stop = runCompanionWith(h.companions, id, dir, { trustProject: trusted }, { trustProject: trusted });
    h.registry.setProviderInstance('deepseek', new FakeProvider([{ calls: [{ name: 'mcp__local__add', input: { a: 20, b: 22 } }] }, { text: 'done' }]));
    try {
      await new Promise((r) => setTimeout(r, 300));
      const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'companion', network: 'none', companionId: id } });
      const caps = await s.capabilities();
      const status = caps.mcp.find((m) => m.name === 'local')!;
      if (!trusted) {
        assert.equal(status.ok, false);
        assert.match(status.error!, /--trust-project/);
        continue;
      }
      assert.equal(status.ok, true, status.error ?? '');
      const done = new Promise<void>((r) => s.subscribe(0, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
      await s.send('add them');
      await done;
      const { results } = await import('./helpers.ts');
      assert.equal(results(s.history[2])[0]!.content, '42');
      await h.sessions.remove(s.meta.id);
    } finally { stop(); await h.close(); }
  }
});

// ---------- Godot on the companion's computer ----------

const GODOT_PROJECT = 'config_version=5\n\n[application]\n\nconfig/name="Demo"\nrun/main_scene="res://main.tscn"\n';
const GODOT_SCENE = '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://main.gd" id="1"]\n\n[node name="Main" type="Node2D"]\nscript = ExtResource("1")\n';
const GODOT_SCRIPT = 'extends Node2D\n\nfunc _process(_delta: float) -> void:\n\tqueue_redraw()\n\nfunc _draw() -> void:\n\tdraw_rect(Rect2(100, 100, 200, 120), Color(1, 0.6, 0.1))\n';

/** A companion session whose model asks for one godot screenshot; returns what the model was sent back. */
async function companionScreenshot(dir: string, handler: Parameters<typeof createCompanionHandler>[1], info: Record<string, unknown> = {}) {
  const h = await createHarness({ dataDir: await tempDir(), plugins: ['games3d', 'engine-blender', 'engine-godot'].map((p) => path.join(here, '..', 'plugins', p)), search: null, memory: 'off' });
  const { id } = await h.companions.create('laptop');
  const stop = runCompanionWith(h.companions, id, dir, handler, info);
  const fake = new FakeProvider([{ calls: [{ name: 'godot', input: { action: 'screenshot', project: 'game', frames: 3, out: 'shots/start.png' } }] }, { text: 'looks fine' }]);
  h.registry.setProviderInstance('deepseek', fake);
  try {
    await new Promise((r) => setTimeout(r, 300));
    const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'companion', network: 'none', companionId: id } });
    const done = new Promise<void>((r) => s.subscribe(0, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
    await s.send('take a screenshot of the game');
    await done;
    return fake.snapshots[1]!;
  } finally { stop(); await h.close(); }
}

async function godotGame(dir: string) {
  await fs.mkdir(path.join(dir, 'game'));
  await fs.writeFile(path.join(dir, 'game', 'project.godot'), GODOT_PROJECT);
  await fs.writeFile(path.join(dir, 'game', 'main.tscn'), GODOT_SCENE);
  await fs.writeFile(path.join(dir, 'game', 'main.gd'), GODOT_SCRIPT);
}

const imageData = (result: string) => /"images":\[\{"media_type":"image\/png","data":"([^"]+)"/.exec(result)?.[1];

test('godot screenshot on a companion session: Godot runs on the user\'s computer and the frame comes back to the model', async () => {
  const godot = await fakeGodot();
  process.env.HARNESS_GODOT = godot.bin;
  try {
    const dir = await tempDir();
    await godotGame(dir);
    const result = await companionScreenshot(dir, { allowHooks: true });
    assert.match(result, /godot screenshot: frame 3 of 3 saved to shots\/start\.png/);
    // Saved on the user's computer, where the result says, and the same image the model got; the frames Godot wrote there are gone.
    const saved = await fs.readFile(path.join(dir, 'shots', 'start.png'));
    assert.ok(saved.equals(testPicture(32, 24)));
    assert.equal(imageData(result), saved.toString('base64'));
    assert.deepEqual((await fs.readdir(path.join(dir, '.harness', 'godot'))).filter((f) => f.startsWith('frames-')), []);
    // Godot ran on the companion, writing frames into its folder.
    const movie = (await godot.calls()).find((c) => c.includes('--write-movie'))!;
    assert.ok(movie.includes(`${dir.split(path.sep).join('/')}/.harness/godot/frames-`), movie);

    // A companion started without --allow-hooks runs no commands for the server's tools, and the error says how to allow them.
    const refused = await companionScreenshot(await tempDir(), {});
    assert.match(refused, /run Blender and Godot on the companion's computer, which it allows only when started with --allow-hooks/);
  } finally { delete process.env.HARNESS_GODOT; }
});

test('godot screenshot on a companion that runs commands in the 3D sandbox image: a real frame from Godot comes back', { skip: !has3d && `no Docker or no ${IMAGE_3D}`, timeout: 600_000 }, async () => {
  const dir = await tempDir();
  await godotGame(dir);
  const docker = new DockerHost(`test-cmp-3d-${Date.now()}`, dir, { ...dockerDefaults(), image: IMAGE_3D, network: 'none' });
  try {
    // As a companion started with --sandbox docker reports it: commands see the folder at /workspace.
    const result = await companionScreenshot(dir, { allowHooks: true, host: docker }, { platform: 'linux', shell: 'bash', root: '/workspace' });
    assert.match(result, /godot screenshot: frame \d+ of 3 saved to shots\/start\.png .*No errors while running/);
    const png = await fs.readFile(path.join(dir, 'shots', 'start.png'));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(imageData(result), png.toString('base64'), 'the model saw the frame');
  } finally { await docker.close(); }
});
