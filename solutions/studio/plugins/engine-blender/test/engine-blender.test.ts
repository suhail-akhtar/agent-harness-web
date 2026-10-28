import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHarness, shippedPlugins } from '@harness/plugin-sdk/testing';
import { readPluginGuide } from '@harness/plugin-sdk/testing';
import { readManifest } from '@harness/plugin-sdk/testing';
import { readPluginUi } from '@harness/plugin-sdk/testing';
import { LocalHost, type ToolHost } from '@harness/plugin-sdk/testing';
import { skillsIn } from '@harness/plugin-sdk/testing';
import type { ToolContext } from '@harness/plugin-sdk/testing';
import { tempDir, testPicture } from '@harness/plugin-sdk/testing';

// engine-blender with a stand-in Blender (a Node program behind a shell script) that
// answers the helper's commands (describe, import, export, capture, render, sprites) the
// way py/harness_blender.py does, and a stand-in bridge server. Real Blender runs in
// engine-blender-real.test.ts (HARNESS_REAL_BLENDER=1).

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(pluginDir);
// @ts-expect-error plain JS module
const EB = await import('../index.mjs');

const ctxOf = (host: ToolHost) => ({ host, signal: new AbortController().signal, readFiles: new Map(), todos: [], setTodos() {}, emit() {} }) as unknown as ToolContext;
type Out = { content: string; is_error?: boolean; images?: { data: string }[]; details?: Record<string, unknown> };

async function harness() {
  return createHarness({ dataDir: await tempDir(), plugins: shippedPlugins(), search: null, memory: 'off' });
}

const FAKE = String.raw`
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const say = (s) => process.stdout.write(s + '\n');
say('Blender 4.2.16 LTS (hash fake)');
if (args.includes('--version')) process.exit(0);
const PNG = Buffer.from(process.env.FAKE_PNG, 'base64');
const script = args[args.indexOf('--python') + 1];
const file = args.slice(0, args.indexOf('--python-exit-code')).find((a) => a.endsWith('.blend'));
const cfgPath = args.includes('--') ? args[args.indexOf('--') + 1] : undefined;
if (!script.endsWith('harness_blender.py')) { say('ran ' + script); process.exit(0); }
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
fs.appendFileSync(process.env.FAKE_BLENDER_LOG, JSON.stringify({ ...cfg, file: file ?? null }) + '\n');
if (process.env.FAKE_BLENDER_FAIL === '1') { say('Traceback (most recent call last):\n  File "harness_blender.py", line 9\nRuntimeError: boom'); process.exit(1); }
const scene = { file: file ?? '', blender: '4.2.16 LTS', count: 2, triangles: 24, materials: ['Red'], bounds: { min: [-0.5, -0.5, 0], max: [0.5, 0.5, 2], size: [1, 1, 2] }, objects: [{ name: 'Crate', type: 'MESH' }] };
const mk = (p) => fs.mkdirSync(path.dirname(p), { recursive: true });
let out = { cmd: cfg.cmd };
if (cfg.cmd === 'describe') out = { ...out, ...scene };
if (cfg.cmd === 'import') { if (cfg.blend) { mk(cfg.blend); fs.writeFileSync(cfg.blend, 'BLENDER'); } for (const e of cfg.exports) { mk(e); fs.writeFileSync(e, 'x'); } out = { ...out, imported: ['Crate', 'Lid'], scene }; }
if (cfg.cmd === 'export') { mk(cfg.output); fs.writeFileSync(cfg.output, Buffer.alloc(4096)); out = { ...out, file: cfg.output, bytes: 4096, scene }; }
if (cfg.cmd === 'capture') { mk(cfg.output); fs.writeFileSync(cfg.output, PNG); out = { ...out, file: cfg.output, view: cfg.view, engine: 'BLENDER_WORKBENCH' }; }
if (cfg.cmd === 'render') {
  const files = [];
  if (cfg.turntable) for (let i = 1; i <= cfg.turntable; i++) { const f = cfg.output + '/turntable_' + String(i).padStart(4, '0') + '.png'; mk(f); fs.writeFileSync(f, PNG); files.push(f); }
  else { mk(cfg.output); fs.writeFileSync(cfg.output, PNG); files.push(cfg.output); }
  out = { ...out, files, engine: cfg.engine === 'eevee' ? 'BLENDER_EEVEE_NEXT' : cfg.engine.toUpperCase(), preset: cfg.preset, size: cfg.size };
}
if (cfg.cmd === 'sprites') {
  const f = cfg.output + '/' + cfg.id + '.png'; mk(f); fs.writeFileSync(f, PNG);
  const names = { 1: ['s'], 4: ['s', 'w', 'n', 'e'], 8: ['s', 'sw', 'w', 'nw', 'n', 'ne', 'e', 'se'] }[cfg.directions];
  const anim = cfg.animation || (cfg.frames > 1 ? 'walk' : 'idle');
  const animations = Object.fromEntries(names.map((n, r) => [anim + '_' + n, { row: r, from: 0, count: cfg.frames, loop: true }]));
  out = { ...out, file: f, frames: cfg.directions * cfg.frames, frameSize: [cfg.size, cfg.size], columns: cfg.frames, rows: cfg.directions, directions: cfg.directions, directionNames: names, animations, sampled: [1, 7, 13, 19].slice(0, cfg.frames), engine: 'BLENDER_EEVEE_NEXT', triangles: 24, cellMetres: 2.4 };
}
fs.writeFileSync(cfg.report, JSON.stringify(out));
say('HARNESS_BLENDER_DONE ' + cfg.cmd);
`;

async function fakeBlender() {
  const dir = await tempDir('hw-fake-blender-');
  const js = path.join(dir, 'blender.mjs').split(path.sep).join('/');
  await fs.writeFile(js, FAKE);
  const bin = path.join(dir, 'blender').split(path.sep).join('/');
  await fs.writeFile(bin, `#!/bin/sh\nexec '${process.execPath.split(path.sep).join('/')}' '${js}' "$@"\n`, { mode: 0o755 });
  const log = path.join(dir, 'calls.jsonl');
  process.env.HARNESS_BLENDER = bin;
  process.env.FAKE_BLENDER_LOG = log;
  process.env.FAKE_PNG = testPicture(64, 48).toString('base64');
  return { calls: async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) };
}
const unsetFake = () => { for (const k of ['HARNESS_BLENDER', 'FAKE_BLENDER_LOG', 'FAKE_PNG', 'FAKE_BLENDER_FAIL']) delete process.env[k]; };

test('engine-blender registers the blender tool (script stays the default), the blender-file gate, its skills, agent and guide', async () => {
  const h = await harness();
  const tool = h.registry.tools.get('blender')!;
  assert.equal(tool.kind, 'exec');
  assert.deepEqual(tool.kindsFor!({ action: 'bridge.install' }), ['exec', 'external'], 'writing into the person\'s Blender folder is always asked about');
  assert.deepEqual(tool.kindsFor!({ code: 'pass' }), ['exec']);
  const actions =(tool.spec.input_schema as unknown as { properties: { action: { enum: string[] } } }).properties.action.enum;
  assert.deepEqual(actions, ['script', 'detect', 'describe', 'asset.import', 'asset.export', 'capture', 'render', 'sprites', 'bridge.install', 'bridge.status', 'bridge.connect', 'bridge.call', 'jobs', 'job.cancel']);
  assert.ok(h.registry.gates.has('blender-file'));
  assert.match(h.registry.agents.get('blender-artist')!.prompt, /blender-scripting/);
  assert.match(h.registry.agents.get('blender-artist')!.prompt, /blender-sprites/);
  const skills = (await skillsIn(path.join(PLUGIN, 'skills'), 'engine-blender')).map((s: { name: string }) => s.name).sort();
  assert.deepEqual(skills, ['blender-scripting', 'blender-sprites']);
  const m = (await readManifest(PLUGIN))!;
  const ui = await readPluginUi(PLUGIN, m.ui, 'frame');
  assert.equal(ui.uiError, undefined, String(ui.uiError));
  assert.match((await readPluginGuide(PLUGIN, m, ui.ui)).guide!.purpose, /Blender for Studio/);
  await h.close();
});

test('the bridge add-on: installed into the version\'s add-ons folder with its helper and the connection file it writes', async () => {
  const env = { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' };
  assert.equal(EB.addonsDir('4.2.16 LTS', { env, platform: 'win32', home: 'C:\\Users\\me' }), path.join('C:\\Users\\me\\AppData\\Roaming', 'Blender Foundation', 'Blender', '4.2', 'scripts', 'addons'));
  assert.equal(EB.addonsDir('4.2', { env: {}, platform: 'linux', home: '/home/me' }), path.join('/home/me', '.config', 'blender', '4.2', 'scripts', 'addons'));
  assert.equal(EB.addonsDir('3.6.5', { env: {}, platform: 'darwin', home: '/Users/me' }), path.join('/Users/me', 'Library', 'Application Support', 'Blender', '3.6', 'scripts', 'addons'));
  assert.equal(EB.addonsDir(undefined, { env: {}, platform: 'linux', home: '/h' }), null);
  assert.equal(EB.addonsDir('4.2', { env: { HARNESS_BLENDER_ADDONS: '/x/addons' }, platform: 'linux', home: '/h' }), '/x/addons');
  const dir = await tempDir();
  const dest = await EB.installAddon(dir, '/home/me/.harness/bridges/blender.json');
  assert.deepEqual((await fs.readdir(dest)).sort(), ['__init__.py', 'config.json', 'harness_blender.py']);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dest, 'config.json'), 'utf8')), { info: '/home/me/.harness/bridges/blender.json' });
  const init = await fs.readFile(path.join(dest, '__init__.py'), 'utf8');
  assert.match(init, /s\.bind\(\("127\.0\.0\.1", port\)\)/, 'local only');
  assert.match(init, /secrets\.compare_digest/, 'a token');
  assert.match(EB.bridgeInfoFile(), /bridges[\\/]blender\.json$/);
});

test('bridge calls: one JSON line with the token and the command, the reply\'s result or its error; nobody listening is said plainly', async () => {
  const seen: Record<string, unknown>[] = [];
  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      const msg = JSON.parse(buf.slice(0, i)) as { id: number; token: string; cmd: string };
      seen.push(msg);
      const reply = msg.token !== 'tok' ? { id: msg.id, ok: false, error: 'bad token' } : msg.cmd === 'scene' ? { id: msg.id, ok: true, result: { count: 3 } } : { id: msg.id, ok: false, error: 'ValueError: boom' };
      sock.write(`${JSON.stringify(reply)}\n`);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  try {
    assert.deepEqual(await EB.bridgeCall({ port, token: 'tok' }, 'scene'), { count: 3 });
    assert.deepEqual(seen[0], { id: 1, token: 'tok', cmd: 'scene', params: {} });
    await assert.rejects(EB.bridgeCall({ port, token: 'tok' }, 'exec', { code: 'x' }), /Blender refused exec: ValueError: boom/);
    await assert.rejects(EB.bridgeCall({ port, token: 'wrong' }, 'scene'), /bad token/);
  } finally { server.close(); }
  await assert.rejects(EB.bridgeCall({ port, token: 'tok' }, 'ping', {}, { timeoutMs: 5000 }), /could not reach Blender's bridge on 127\.0\.0\.1:\d+ \(ECONNREFUSED\)/);
});

test('detect, describe, asset.import and asset.export run the helper with absolute paths and report what it found', async () => {
  const fake = await fakeBlender();
  const h = await harness();
  const root = await tempDir();
  const blender = (input: Record<string, unknown>) => h.registry.tools.get('blender')!.run(input, ctxOf(new LocalHost(root))) as Promise<Out>;
  try {
    let r = await blender({ action: 'detect' });
    assert.ok(!r.is_error, r.content);
    assert.match(r.content, /blender detect: ok - Blender 4\.2\.16 \(host\)/);
    assert.deepEqual((r.details!.data as { engines: string[] }).engines, ['cycles', 'eevee', 'workbench']);
    await fs.mkdir(path.join(root, 'art'));
    await fs.writeFile(path.join(root, 'art', 'crate.blend'), 'BLENDER');
    r = await blender({ action: 'describe', file: 'art/crate.blend' });
    assert.match(r.content, /blender describe: ok - art\/crate\.blend: 2 object\(s\), 24 triangles, 1 material\(s\), 1 x 1 x 2 m; Blender 4\.2\.16 LTS/);
    assert.match(r.content, /Metrics: objects=2, triangles=24/);
    let c = (await fake.calls()).at(-1)!;
    assert.equal(c.cmd, 'describe');
    assert.equal(c.file, 'art/crate.blend', 'Blender opens the file');
    assert.equal(c.empty, false, 'with a file, its scene is kept');

    await fs.mkdir(path.join(root, 'in'));
    await fs.writeFile(path.join(root, 'in', 'chair.fbx'), 'fbx');
    r = await blender({ action: 'asset.import', files: ['in/chair.fbx'], normalise: true, height: 0.9, output: 'art/chair.blend', exports: ['out/chair.glb'], target: 'godot' });
    assert.ok(!r.is_error, r.content);
    assert.match(r.content, /imported 2 object\(s\) from in\/chair\.fbx \(normalised: scale applied, on the floor, centred\): 24 triangles, 1 x 1 x 2 m; saved art\/chair\.blend; exported out\/chair\.glb/);
    c = (await fake.calls()).at(-1)!;
    const abs = (rel: string) => `${root.split(path.sep).join('/')}/${rel}`;
    assert.deepEqual([c.files, c.normalise, c.height, c.blend, c.exports, c.target, c.empty], [[abs('in/chair.fbx')], true, 0.9, abs('art/chair.blend'), [abs('out/chair.glb')], 'godot', true]);
    await fs.access(path.join(root, 'art', 'chair.blend'));
    r = await blender({ action: 'asset.import', files: ['in/chair.fbx'], output: 'art/chair.glb' });
    assert.match(r.content, /output is the \.blend to save/);
    r = await blender({ action: 'asset.import' });
    assert.match(r.content, /give files/);
    await assert.rejects(blender({ action: 'asset.import', files: ['../outside.fbx'] }), /outside the workspace/);

    r = await blender({ action: 'asset.export', file: 'art/crate.blend', output: 'out/crate.fbx', target: 'unreal', objects: ['Crate'] });
    assert.match(r.content, /art\/crate\.blend -> out\/crate\.fbx \(4 KB, for unreal\): 24 triangles/);
    c = (await fake.calls()).at(-1)!;
    assert.deepEqual([c.cmd, c.output, c.target, c.objects, c.applyModifiers], ['export', abs('out/crate.fbx'), 'unreal', ['Crate'], true]);

    process.env.FAKE_BLENDER_FAIL = '1';
    r = await blender({ action: 'describe', file: 'art/crate.blend' });
    assert.equal(r.is_error, true);
    assert.match(r.content, /blender describe: failed - describe did not finish \(exit 1\): RuntimeError: boom/);
    delete process.env.FAKE_BLENDER_FAIL;
    assert.ok(!(await fs.readdir(path.join(root, '.harness', 'blender'))).some((f) => /^(cfg|report)-/.test(f)), 'configs and reports are removed');
  } finally { unsetFake(); await h.close(); }
});

test('capture, render (presets, engines, turntables) and sprites: images come back, sprites write an asset.json in Studio\'s layout', async () => {
  const fake = await fakeBlender();
  const h = await harness();
  const root = await tempDir();
  const blender = (input: Record<string, unknown>) => h.registry.tools.get('blender')!.run(input, ctxOf(new LocalHost(root))) as Promise<Out>;
  try {
    await fs.mkdir(path.join(root, 'art'));
    await fs.writeFile(path.join(root, 'art', 'knight.blend'), 'BLENDER');
    let r = await blender({ action: 'capture', file: 'art/knight.blend', view: 'front', out: 'previews/front.png' });
    assert.match(r.content, /blender capture: ok - front view of art\/knight\.blend \(BLENDER_WORKBENCH\) saved to previews\/front\.png/);
    assert.equal(r.images?.length, 1);
    assert.deepEqual((await fake.calls()).at(-1)!.size, [640, 480]);

    r = await blender({ action: 'render', file: 'art/knight.blend', preset: 'night', engine: 'cycles', samples: 8, size: [320, 240], out: 'previews/night.png' });
    assert.match(r.content, /blender render: ok - a still of art\/knight\.blend \(night, CYCLES, 320x240\) in [\d.]+s: previews\/night\.png/);
    const c = (await fake.calls()).at(-1)!;
    assert.deepEqual([c.preset, c.engine, c.samples, c.turntable, c.transparent], ['night', 'cycles', 8, 0, false]);
    r = await blender({ action: 'render', file: 'art/knight.blend', engine: 'eevee', turntable: 12, out: 'renders/tt' });
    assert.match(r.content, /a 12-frame turntable of art\/knight\.blend \(studio, BLENDER_EEVEE_NEXT, 960x720\)/);
    assert.match(r.content, /Metrics: frames=12, seconds=[\d.]+, secondsPerFrame=[\d.]+/);
    assert.match(r.content, /Files: renders\/tt\/turntable_0001\.png, renders\/tt\/turntable_0012\.png/);
    assert.equal(r.images?.length, 3);
    r = await blender({ action: 'render', engine: 'octane' });
    assert.match(r.content, /engine is cycles, eevee or workbench/);
    r = await blender({ action: 'render', preset: 'sunset' });
    assert.match(r.content, /preset is studio, outdoor, night or none/);

    r = await blender({ action: 'sprites', file: 'art/knight.blend', directions: 8, frames: 4, cell: 48, elevation: 35, name: 'Knight', fps: 12 });
    assert.ok(!r.is_error, r.content);
    assert.match(r.content, /blender sprites: ok - a 192x384 sprite sheet: 8 direction\(s\) x 4 frame\(s\) of 48x48 \(BLENDER_EEVEE_NEXT\) in [\d.]+s, in \.studio\/assets\/knight with asset\.json/);
    assert.equal(r.images?.length, 1);
    const asset = JSON.parse(await fs.readFile(path.join(root, '.studio', 'assets', 'knight', 'asset.json'), 'utf8'));
    assert.equal(asset.id, 'knight');
    assert.equal(asset.name, 'Knight');
    assert.equal(asset.kind, 'spritesheet');
    assert.equal(asset.dimension, '2d');
    assert.deepEqual(asset.files, [{ path: 'knight.png', role: 'main' }]);
    assert.equal(asset.source.type, 'procedural');
    assert.equal(asset.source.generator, 'blender:sprites');
    assert.equal(asset.source.params.from, 'art/knight.blend');
    assert.deepEqual([asset.meta.frames, asset.meta.columns, asset.meta.rows, asset.meta.fps, asset.meta.directions, asset.meta.cellMetres, asset.meta.elevation], [32, 4, 8, 12, 8, 2.4, 35]);
    assert.deepEqual(asset.meta.frameSize, [48, 48]);
    assert.deepEqual(asset.meta.animations.walk_sw, { row: 1, from: 0, count: 4, loop: true });
    assert.ok(asset.license.id && asset.created && asset.updated);
    const sc = (await fake.calls()).at(-1)!;
    assert.deepEqual([sc.directions, sc.frames, sc.size, sc.elevation, sc.engine], [8, 4, 48, 35, 'eevee']);
    r = await blender({ action: 'sprites', file: 'art/knight.blend', directions: 3 });
    assert.match(r.content, /directions is 1, 2, 4, 8 or 16/);
    r = await blender({ action: 'jobs' });
    assert.match(r.content, /blender jobs: ok - \d+ Blender job\(s\) in the last hour/);
    assert.match(r.content, /sprites 8x4 knight/);
  } finally { unsetFake(); await h.close(); }
});

test('the bridge from the tool: none running is said with what to do; a companion session cannot reach it; script stays the default', async () => {
  const prev = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = await tempDir();
  const h = await harness();
  const root = await tempDir();
  const blender = (input: Record<string, unknown>, host: ToolHost = new LocalHost(root)) => h.registry.tools.get('blender')!.run(input, ctxOf(host)) as Promise<Out>;
  try {
    let r = await blender({ action: 'bridge.status' });
    assert.match(r.content, /blender bridge\.status: ok - no Blender with the Harness Bridge is running \(no .*blender\.json\): bridge\.install/);
    r = await blender({ code: 'result = 1', live: true });
    assert.equal(r.is_error, true);
    assert.match(r.content, /no Blender with the Harness Bridge add-on is running/);
    r = await blender({ action: 'bridge.call', command: 'scene' });
    assert.match(r.content, /unavailable - no Blender with the Harness Bridge is running/);
    const comp = { kind: 'companion', root: '', displayRoot: '/home/me/x', platform: 'linux', shell: 'bash', exec: async () => ({ code: 1, stdout: '', stderr: '', timedOut: false }) } as unknown as ToolHost;
    r = await blender({ action: 'bridge.install' }, comp);
    assert.match(r.content, /unavailable - the Blender bridge reaches a Blender on the server's own machine/);
    r = await blender({ script: 'a.py', code: 'pass' });
    assert.equal(r.content, 'Give either script (a .py file in the workspace) or code (Python), not both.');
    r = await blender({ action: 'teleport' });
    assert.match(r.content, /Unknown action teleport/);
  } finally {
    if (prev === undefined) delete process.env.HARNESS_HOME; else process.env.HARNESS_HOME = prev;
    await h.close();
  }
});
