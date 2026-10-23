import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runGates } from '../src/gates/gates.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { readPluginGuide } from '../src/plugins/guides.ts';
import { readManifest } from '../src/plugins/loader.ts';
import { readPluginUi } from '../src/plugins/ui.ts';
import { LocalHost, type ToolHost } from '../src/runtime/host.ts';
import { skillsIn } from '../src/skills/skills.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir, testPicture } from './helpers.ts';

// engine-godot with a stand-in Godot: a small Node program behind a shell script that
// understands the command lines the plugin builds (import, check, the boot scene's play,
// describe, test, gltf and step modes, exports, the movie writer, --selftest). The real
// Godot runs in engine-godot-real.test.ts (HARNESS_REAL_GODOT=1).

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(here, '..', 'plugins', 'engine-godot');
// @ts-expect-error plain JS module
const Z = await import('../plugins/engine-godot/lib/zip.mjs');
// @ts-expect-error plain JS module
const I = await import('../plugins/engine-godot/lib/install.mjs');
// @ts-expect-error plain JS module
const P = await import('../plugins/engine-godot/lib/play.mjs');
// @ts-expect-error plain JS module
const T = await import('../plugins/engine-godot/lib/templates.mjs');
// @ts-expect-error plain JS module
const S = await import('../plugins/engine-godot/lib/presets.mjs');
// @ts-expect-error plain JS module
const B = await import('../plugins/engine-godot/lib/bridge.mjs');
// @ts-expect-error plain JS module
const E = await import('../plugins/games3d/lib-engines.mjs');
// @ts-expect-error plain JS module
const { pngStats } = await import('../plugins/games3d/lib-png.mjs');

const ctxOf = (host: ToolHost) => ({ host, signal: new AbortController().signal, readFiles: new Map(), todos: [], setTodos() {}, emit() {} }) as unknown as ToolContext;
type Out = { content: string; is_error?: boolean; images?: { data: string }[]; details?: Record<string, unknown> };

async function harness() {
  return createHarness({ dataDir: await tempDir(), plugins: [path.join(here, '..', 'plugins')], search: null, memory: 'off' });
}

const FAKE = String.raw`
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (process.env.FAKE_GODOT_LOG) fs.appendFileSync(process.env.FAKE_GODOT_LOG, args.join(' ') + '\n');
const has = (a) => args.includes(a);
const val = (a) => { const i = args.indexOf(a); return i >= 0 ? args[i + 1] : undefined; };
const user = args.includes('--') ? args.slice(args.indexOf('--') + 1) : [];
const PNG = Buffer.from(process.env.FAKE_PNG, 'base64');
const say = (s) => process.stdout.write(s + '\n');
say('Godot Engine v4.7.2.stable.fake');
if (has('--version')) { say('4.7.2.stable.fake'); process.exit(0); }
const proj = val('--path') ?? '.';
if (has('--import')) process.exit(0);
const script = val('--script');
if (script) {
  if (script.includes('check.gd')) { say('HARNESS_CHECKED 3'); process.exit(0); }
  const file = path.join(proj, script.replace('res://', ''));
  say('RAN ' + fs.readFileSync(file, 'utf8').split('\n').length + ' lines');
  if (fs.readFileSync(file, 'utf8').includes('boom')) say('SCRIPT ERROR: boom\n   at: _initialize (' + script + ':5)');
  process.exit(0);
}
for (const flag of ['--export-release', '--export-debug']) {
  const i = args.indexOf(flag);
  if (i < 0) continue;
  if (process.env.FAKE_NO_TEMPLATES === '1') { say('ERROR: Cannot export project with preset: No export template found at the expected path'); process.exit(1); }
  const out = args[i + 2];
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, 'binary');
  const base = out.replace(/\.[^.\/]+$/, '');
  fs.writeFileSync(base + '.pck', 'pack');
  if (out.endsWith('.html')) fs.writeFileSync(base + '.wasm', 'wasm');
  process.exit(0);
}
const movie = val('--write-movie');
if (movie) {
  const n = Number(val('--quit-after') ?? 60);
  if (movie.endsWith('.avi')) { fs.writeFileSync(movie, 'RIFF'); process.exit(0); }
  for (let i = 0; i < n; i++) fs.writeFileSync(movie.replace(/\.png$/, String(i).padStart(8, '0') + '.png'), PNG);
  process.exit(0);
}
const cfgArg = user.find((u) => u.startsWith('--harness='));
if (cfgArg) {
  const cfg = JSON.parse(fs.readFileSync(cfgArg.slice(10), 'utf8'));
  const headless = has('--headless');
  const write = (o) => fs.writeFileSync(cfg.report, JSON.stringify(o));
  const metrics = (frames) => ({ frames, gameSeconds: frames / 60, realSeconds: 0.5, fps: 240.5, frameMsAvg: 4.1, frameMsP95: 6.2, frameMsMax: 9, memoryMb: 30.5, memoryPeakMb: 31, drawCalls: 12, nodes: 20 });
  if (cfg.mode === 'play') {
    if (process.env.FAKE_PLAY_ERROR === '1') say('SCRIPT ERROR: Invalid access to property or key\n   at: _process (res://scripts/main.gd:7)');
    const captures = [];
    if (!headless && cfg.out && cfg.every > 0) {
      fs.mkdirSync(cfg.out, { recursive: true });
      for (let f = cfg.every; f <= cfg.frames; f += cfg.every) {
        const file = cfg.out + '/frame_' + String(f).padStart(5, '0') + '.png';
        fs.writeFileSync(file, PNG);
        captures.push({ frame: f, file, state: { frame: f } });
      }
    }
    write({ mode: 'play', metrics: metrics(cfg.frames), captures, events: [{ t: 1, type: 'pickup', detail: 'coin 1 of 5' }], state: { frame: cfg.frames, game: { inputs: cfg.inputs, scene: cfg.scene, fps: cfg.fps } }, noFrames: headless, applied: cfg.inputs.length, inputs: cfg.inputs.length });
    say('HARNESS_PLAY_DONE ' + cfg.frames);
    process.exit(0);
  }
  if (cfg.mode === 'describe') {
    write({ mode: 'describe', project: { name: 'Fake', actions: { move_left: ['A - Physical'] }, autoloads: { StudioHook: 'res://harness/studio_hook.gd' } }, scene: 'res://scenes/main.tscn', nodes: 3, truncated: false, tree: [{ name: 'Main', type: 'Node2D', children: [{ name: 'Player', type: 'CharacterBody2D' }] }], state: { frame: cfg.frames } });
    process.exit(0);
  }
  if (cfg.mode === 'gltf') {
    fs.writeFileSync(cfg.file, 'glTF');
    write({ mode: 'gltf', error: 0, file: cfg.file, meshes: 2, nodes: 5 });
    process.exit(0);
  }
  if (cfg.mode === 'test') {
    const ok = process.env.FAKE_TESTS_PASS === '1';
    say('HARNESS_TEST ' + JSON.stringify({ suite: 'res://tests/test_game.gd', name: 'test_moves', status: 'passed', failures: [], asserts: 2, ms: 3 }));
    say('HARNESS_TEST ' + JSON.stringify({ suite: 'res://tests/test_game.gd', name: 'test_scores', status: ok ? 'passed' : 'failed', failures: ok ? [] : [{ message: 'expected 1, got 0', file: 'res://tests/test_game.gd', line: 12 }], asserts: 1, ms: 2 }));
    say('HARNESS_TESTS_DONE ' + JSON.stringify({ files: 1, tests: 2, passed: ok ? 2 : 1, failed: ok ? 0 : 1, skipped: 0, ms: 9, filter: cfg.filter }));
    process.exit(ok ? 0 : 1);
  }
  if (cfg.mode === 'step') {
    let frame = 1; let x = 0; let held = false; let step = 0;
    const reply = () => {
      let file = '';
      if (cfg.out) { fs.mkdirSync(cfg.out, { recursive: true }); file = cfg.out + '/frame_' + String(frame).padStart(5, '0') + '.png'; fs.writeFileSync(file, PNG); }
      say('HARNESS_STEP ' + JSON.stringify({ ok: true, step, frame, file, state: { frame, game: { x } }, events: [], metrics: metrics(frame) }));
    };
    reply();
    let buf = '';
    process.stdin.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const cmd = JSON.parse(line);
        if (cmd.cmd === 'quit') process.exit(0);
        if (cmd.cmd === 'state') { say('HARNESS_STEP ' + JSON.stringify({ ok: true, step, frame, file: '', state: { frame, game: { x } }, events: [], metrics: metrics(frame) })); continue; }
        for (const e of cmd.inputs) if (e.action === 'move_right') held = e.down;
        step++; frame += cmd.frames; if (held) x += cmd.frames * 2;
        if (cmd.inputs.some((e) => e.action === 'explode')) say('SCRIPT ERROR: step broke\n   at: _process (res://scripts/main.gd:9)');
        reply();
      }
    });
    process.stdin.on('end', () => process.exit(0));
  }
} else if (user.includes('--selftest')) {
  say('SELFTEST PASS');
  process.exit(0);
}
`;

/** The stand-in Godot: a shell script (what host.exec runs) and the Node program it starts (what step mode spawns). */
async function fakeGodot() {
  const dir = await tempDir('hw-fake-godot2-');
  const js = path.join(dir, 'godot.mjs').split(path.sep).join('/');
  await fs.writeFile(js, FAKE);
  const bin = path.join(dir, 'godot').split(path.sep).join('/');
  await fs.writeFile(bin, `#!/bin/sh\nexec '${process.execPath.split(path.sep).join('/')}' '${js}' "$@"\n`, { mode: 0o755 });
  const log = path.join(dir, 'calls.log');
  process.env.HARNESS_GODOT = bin;
  process.env.FAKE_GODOT_LOG = log;
  process.env.FAKE_PNG = testPicture(64, 48).toString('base64');
  return { bin, js, calls: async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean) };
}

function unsetFake() {
  for (const k of ['HARNESS_GODOT', 'FAKE_GODOT_LOG', 'FAKE_PNG', 'FAKE_NO_TEMPLATES', 'FAKE_TESTS_PASS', 'FAKE_PLAY_ERROR']) delete process.env[k];
}

/** A local host whose long-lived processes are the stand-in run by Node (a shell script cannot be spawned directly on Windows). */
function withSpawn(host: LocalHost, js: string): ToolHost {
  return Object.assign(Object.create(host), {
    spawnStream: async (_cmd: string, args: string[]) => spawn(process.execPath, [js, ...args], { cwd: host.root, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] }),
  }) as ToolHost;
}

// ---------- the plugin ----------

test('engine-godot registers the godot tool, its gates, skills, agent and guide; games3d keeps model_info and its gates', async () => {
  const h = await harness();
  const tool = h.registry.tools.get('godot')!;
  assert.ok(tool, 'godot tool');
  assert.equal(tool.kind, 'exec');
  assert.deepEqual(tool.kindsFor!({ action: 'install' }), ['exec', 'network'], 'the download is asked about even where commands are free');
  assert.deepEqual(tool.kindsFor!({ action: 'play' }), ['exec']);
  const actions =(tool.spec.input_schema as unknown as { properties: { action: { enum: string[] } } }).properties.action.enum;
  for (const a of ['detect', 'install', 'project.create', 'describe', 'check', 'script', 'asset.import', 'asset.export', 'run', 'capture', 'screenshot', 'render', 'build', 'export', 'package', 'test', 'play', 'step.start', 'step', 'step.state', 'step.stop', 'bridge.install', 'bridge.status', 'bridge.connect', 'bridge.call']) assert.ok(actions.includes(a), a);
  for (const g of ['godot-project', 'godot-selftest', 'godot-export', 'gltf-valid', 'model-preview']) assert.ok(h.registry.gates.has(g), g);
  assert.ok(h.registry.tools.has('model_info'));
  assert.match(h.registry.agents.get('godot-engineer')!.prompt, /godot-essentials/);
  const skills = (await skillsIn(path.join(PLUGIN, 'skills'), 'engine-godot')).map((s: { name: string }) => s.name).sort();
  assert.deepEqual(skills, ['godot-2d', 'godot-essentials', 'godot-gdscript-testing']);
  const games = (await skillsIn(path.join(here, '..', 'plugins', 'games3d', 'skills'), 'games3d')).map((s: { name: string }) => s.name);
  assert.ok(!games.includes('godot-essentials') && !games.includes('blender-scripting'), 'the engine skills moved to their plugins');
  const m = (await readManifest(PLUGIN))!;
  const ui = await readPluginUi(PLUGIN, m.ui, 'frame');
  assert.equal(ui.uiError, undefined, String(ui.uiError));
  assert.equal(ui.ui!.guide, 'GUIDE.md');
  const g = await readPluginGuide(PLUGIN, m, ui.ui);
  assert.match(g.guide!.purpose, /Godot 4 for Studio/);
  assert.deepEqual(m.permissions?.network, I.NETWORK_HOSTS, 'downloads only through the hosts the install uses');
  await h.close();
});

// ---------- zip ----------

test('zip: what writeZip packs, zipEntries lists and extractZip unpacks byte for byte; a damaged entry and a path outside are refused', async () => {
  const dir = await tempDir();
  const a = path.join(dir, 'a.bin');
  const b = path.join(dir, 'b.txt');
  await fs.writeFile(a, crypto.randomBytes(200_000));
  await fs.writeFile(b, 'hello '.repeat(5000));
  const zip = path.join(dir, 'x.zip');
  const w = await Z.writeZip(zip, [{ name: 'bin/a.bin', file: a, executable: true }, { name: 'b.txt', file: b }]);
  assert.equal(w.files, 2);
  const entries = await Z.zipEntries(zip);
  assert.deepEqual(entries.map((e: { name: string }) => e.name), ['bin/a.bin', 'b.txt']);
  assert.equal(entries[1].method, 8, 'text is deflated');
  assert.equal(entries[0].method, 0, 'random bytes are stored');
  const out = path.join(dir, 'out');
  const written = await Z.extractZip(zip, (n: string) => (n === 'b.txt' ? path.join(out, n) : null));
  assert.deepEqual(written, [path.join(out, 'b.txt')]);
  assert.equal(await fs.readFile(path.join(out, 'b.txt'), 'utf8'), 'hello '.repeat(5000));
  // A flipped byte in the data: the CRC check refuses it, and nothing is left behind.
  const bytes = await fs.readFile(zip);
  const at = 30 + 'bin/a.bin'.length + 100;
  bytes[at] = bytes[at]! ^ 0xff;
  await fs.writeFile(zip, bytes);
  await assert.rejects(Z.extractZip(zip, (n: string) => path.join(out, n)), /CRC mismatch/);
  await assert.rejects(fs.stat(path.join(out, 'bin', 'a.bin')));
  assert.throws(() => Z.safeName('../evil'), /outside its folder/);
  assert.throws(() => Z.safeName('C:/x'), /outside its folder/);
  await assert.rejects(Z.zipEntries(b), /not a zip file/);
});

// ---------- install ----------

/** A fake GitHub: releases, assets and their SHA512-SUMS.txt, served to installGodot's fetch. */
async function fakeReleases(dir: string, o: { badSum?: string; foreignUrl?: string } = {}) {
  const v = '4.9.1';
  const tag = `${v}-stable`;
  const files = new Map<string, Buffer>();
  const zipOf = async (name: string, entries: Record<string, string>) => {
    const src = path.join(dir, `src-${name}`);
    await fs.mkdir(src, { recursive: true });
    const list = [];
    for (const [n, text] of Object.entries(entries)) {
      const f = path.join(src, n.replace(/\//g, '_'));
      await fs.writeFile(f, text);
      list.push({ name: n, file: f });
    }
    await Z.writeZip(path.join(dir, name), list);
    files.set(name, await fs.readFile(path.join(dir, name)));
  };
  await zipOf(`Godot_v${v}-stable_win64.exe.zip`, { [`Godot_v${v}-stable_win64.exe`]: 'MZ godot', [`Godot_v${v}-stable_win64_console.exe`]: 'MZ console' });
  await zipOf(`Godot_v${v}-stable_linux.x86_64.zip`, { [`Godot_v${v}-stable_linux.x86_64`]: 'ELF godot' });
  await zipOf(`Godot_v${v}-stable_export_templates.tpz`, {
    'templates/version.txt': `${v}.stable\n`, 'templates/windows_release_x86_64.exe': 'win release', 'templates/windows_debug_x86_64.exe': 'win debug',
    'templates/web_nothreads_release.zip': 'web', 'templates/linux_release.x86_64': 'linux', 'templates/android_release.apk': 'not wanted', 'templates/ios.zip': 'not wanted',
  });
  const sums = [...files].map(([n, data]) => `${o.badSum === n ? '0'.repeat(128) : crypto.createHash('sha512').update(data).digest('hex')}  ${n}`).join('\n');
  files.set('SHA512-SUMS.txt', Buffer.from(sums));
  const url = (n: string) => (o.foreignUrl === n ? `https://example.com/${n}` : `https://github.com/godotengine/godot/releases/download/${tag}/${n}`);
  const release = { tag_name: tag, draft: false, prerelease: false, assets: [...files.keys()].map((n) => ({ name: n, size: files.get(n)!.length, browser_download_url: url(n) })) };
  const list = [{ tag_name: '5.0-stable', draft: false, prerelease: false, assets: [] }, { tag_name: '4.10-beta1', draft: false, prerelease: true, assets: [] }, release, { tag_name: '4.8-stable', draft: false, prerelease: false, assets: [] }];
  const asked: string[] = [];
  const fetchFn = async (u: string) => {
    asked.push(u);
    if (u.startsWith(I.RELEASES_API)) return new Response(JSON.stringify(u.includes('/tags/') ? release : list), { status: 200 });
    const name = decodeURIComponent(u.split('/').pop()!);
    const data = files.get(name);
    return data ? new Response(new Uint8Array(data), { status: 200 }) : new Response('no', { status: 404 });
  };
  return { v, fetchFn, asked };
}

test('install: the newest stable 4.x from the official releases, every archive checked against SHA512-SUMS.txt, only the wanted files kept, self-contained', async () => {
  const dir = await tempDir();
  const engines = path.join(dir, 'engines');
  const { v, fetchFn, asked } = await fakeReleases(dir);
  const { manifest, report } = await I.installGodot({ fetch: fetchFn, platforms: ['windows', 'linux'], templates: ['windows', 'web', 'linux'], dir: engines });
  assert.equal(manifest.version, v, '4.9.1: not 5.0 (another major), not the 4.10 beta');
  assert.deepEqual(report.downloaded, [`Godot_v${v}-stable_win64.exe.zip`, `Godot_v${v}-stable_linux.x86_64.zip`, `Godot_v${v}-stable_export_templates.tpz`]);
  assert.ok(asked.every((u) => u.startsWith('https://api.github.com/repos/godotengine/godot/releases') || u.startsWith('https://github.com/godotengine/godot/releases/download/')), asked.join('\n'));
  const root = path.join(engines, 'godot', v);
  assert.deepEqual(manifest.binaries, { 'win32-x64': `windows/Godot_v${v}-stable_win64.exe`, 'linux-x64': `linux/Godot_v${v}-stable_linux.x86_64` });
  assert.equal(await fs.readFile(path.join(root, 'windows', `Godot_v${v}-stable_win64.exe`), 'utf8'), 'MZ godot');
  for (const b of ['windows', 'linux']) {
    await fs.access(path.join(root, b, '_sc_'));
    const t = (await fs.readdir(path.join(root, b, 'editor_data', 'export_templates', `${v}.stable`))).sort();
    assert.deepEqual(t, ['linux_release.x86_64', 'version.txt', 'web_nothreads_release.zip', 'windows_debug_x86_64.exe', 'windows_release_x86_64.exe'], `${b}: only the asked-for templates`);
  }
  await assert.rejects(fs.stat(path.join(root, '.downloads')), 'the archives are removed');
  assert.deepEqual(manifest.templates.sets, ['windows', 'web', 'linux']);
  // lib-engines finds it: the engines folder, newest version, this machine's build.
  const bin = E.installedBinary('godot', 'win32-x64', engines);
  assert.equal(bin, path.join(root, 'windows', `Godot_v${v}-stable_win64.exe`));
  assert.equal(E.installedBinary('godot', 'darwin-arm64', engines), null);
  const tf = I.templatesFor(bin, `${v}.stable`);
  assert.equal(tf.selfContained, true);
  assert.deepEqual(tf.targets.sort(), ['linux', 'web', 'windows']);
  // Again: nothing to download.
  const again = await I.installGodot({ fetch: fetchFn, platforms: ['windows', 'linux'], dir: engines });
  assert.deepEqual(again.report.downloaded, []);
  assert.ok(again.report.kept.includes(`templates ${v}.stable`));
});

test('install: a checksum that does not match, an asset off the official path, or an unknown platform installs nothing', async () => {
  const dir = await tempDir();
  const bad = await fakeReleases(dir, { badSum: 'Godot_v4.9.1-stable_win64.exe.zip' });
  const engines = path.join(dir, 'engines');
  await assert.rejects(I.installGodot({ fetch: bad.fetchFn, platforms: ['windows'], templates: [], dir: engines }), /SHA-512 mismatch.*nothing installed/);
  await assert.rejects(fs.stat(path.join(engines, 'godot', '4.9.1', 'windows')));
  assert.equal(E.installedEngines('godot', engines).length, 0);
  const dir2 = await tempDir();
  const foreign = await fakeReleases(dir2, { foreignUrl: 'Godot_v4.9.1-stable_linux.x86_64.zip' });
  await assert.rejects(I.installGodot({ fetch: foreign.fetchFn, platforms: ['linux'], templates: [], dir: path.join(dir2, 'e') }), /has no Godot_v4\.9\.1-stable_linux\.x86_64\.zip/);
  await assert.rejects(I.installGodot({ fetch: foreign.fetchFn, platforms: ['amiga'], dir: path.join(dir2, 'e') }), /no official Godot build for amiga/);
  await assert.rejects(I.findRelease(foreign.fetchFn, '3.5'), /not a stable Godot 4 version/);
  assert.deepEqual([...I.parseSums(`${'a'.repeat(128)}  x.zip\nnot a line\n${'B'.repeat(128)} *y.tpz`)], [['x.zip', 'a'.repeat(128)], ['y.tpz', 'b'.repeat(128)]]);
});

test('locate: an explicit HARNESS_GODOT wins, then what the harness installed, then the PATH; the install action refuses a companion', async () => {
  const dir = await tempDir();
  const engines = path.join(dir, 'engines');
  const vdir = path.join(engines, 'godot', '4.9.1', 'windows');
  await fs.mkdir(vdir, { recursive: true });
  const key = E.platformKey();
  await fs.writeFile(path.join(vdir, 'godot.bin'), 'x');
  await fs.writeFile(path.join(engines, 'godot', '4.9.1', 'engine.json'), JSON.stringify({ name: 'godot', version: '4.9.1', binaries: { [key]: 'windows/godot.bin' } }));
  // An older partial install (no engine.json) is not an install.
  await fs.mkdir(path.join(engines, 'godot', '4.8.0'), { recursive: true });
  const prev = process.env.HARNESS_ENGINES_DIR;
  process.env.HARNESS_ENGINES_DIR = engines;
  try {
    const local = new LocalHost(dir);
    assert.equal(await E.locate(local, 'godot', undefined, () => '/on/the/path/godot'), path.join(vdir, 'godot.bin'));
    process.env.HARNESS_GODOT = '/explicit/godot';
    assert.equal(await E.locate(new LocalHost(dir), 'godot', undefined, () => '/explicit/godot'), '/explicit/godot');
    delete process.env.HARNESS_GODOT;
    assert.match(E.probeScript('godot', 'bash'), /\.harness\/engines\/godot\/\*\/linux\/Godot_v4\*_linux\.x86_64/, 'a sandbox looks in the workspace for a pushed build');
    const h = await harness();
    const comp = { kind: 'companion', root: '', displayRoot: '/home/me/game', platform: 'linux', shell: 'bash', exec: async () => ({ code: 1, stdout: '', stderr: '', timedOut: false }) } as unknown as ToolHost;
    const r = await h.registry.tools.get('godot')!.run({ action: 'install' }, ctxOf(comp)) as Out;
    assert.equal(r.is_error, true);
    assert.match(r.content, /godot install: unavailable - install puts Godot on the server/);
    await h.close();
  } finally {
    if (prev === undefined) delete process.env.HARNESS_ENGINES_DIR; else process.env.HARNESS_ENGINES_DIR = prev;
  }
});

// ---------- pieces ----------

test('input timelines: seconds or frames, actions, keys and the mouse, down, up and hold; bad entries are refused', () => {
  assert.deepEqual(P.timeline([{ t: 0.5, action: 'jump', hold: 0.25 }, { f: 3, key: 'Space' }, { t: 1, key: 'Space', up: true }, { t: 0, button: 1, x: 10, y: 20 }]), [
    { f: 0, button: 1, x: 10, y: 20, down: true },
    { f: 3, key: 'Space', down: true },
    { f: 30, action: 'jump', down: true },
    { f: 45, action: 'jump', down: false },
    { f: 60, key: 'Space', down: false },
  ]);
  assert.deepEqual(P.timeline(undefined), []);
  assert.throws(() => P.timeline([{ t: 1 }]), /needs action, key, or button/);
  assert.throws(() => P.timeline([{ t: -1, action: 'x' }]), /0 or more/);
  assert.throws(() => P.timeline('jump'), /must be an array/);
  assert.deepEqual(P.sizeOf('1280x720'), [1280, 720]);
  assert.throws(() => P.sizeOf([10, 10]), /64 to 4096/);
  const host = { kind: 'local', platform: 'win32' } as ToolHost;
  assert.deepEqual(P.displayArgs(host, { windowed: false }), ['--headless']);
  assert.deepEqual(P.displayArgs(host, { windowed: true, size: [640, 360], uncapped: true }), ['--resolution', '640x360', '--disable-vsync', '--audio-driver', 'Dummy']);
  assert.deepEqual(P.displayArgs({ kind: 'docker', platform: 'linux' } as ToolHost, { windowed: true }).slice(0, 4), ['--rendering-driver', 'opengl3', '--rendering-method', 'gl_compatibility']);
  assert.deepEqual(P.bootArgs('game', ['--headless'], '/w/c.json', { args: ['--hard'] }), ['--path', 'game', '--headless', '--fixed-fps', '60', 'res://.godot/harness/boot.tscn', '--', '--harness=/w/c.json', '--hard']);
});

test('export presets: Windows, Web and Linux sections with the asset.json include filter, numbered after the ones there', () => {
  const cfg = S.presetsFile();
  assert.deepEqual(E.presetsIn(cfg).map((p: { index: number; name: string; platform: string }) => `${p.index}:${p.name}:${p.platform}`), ['0:Windows Desktop:Windows Desktop', '1:Web:Web', '2:Linux:Linux']);
  assert.match(cfg, /\[preset\.0\][\s\S]*include_filter="assets\/\*\.json"[\s\S]*export_path="\.\.\/build\/windows\/game\.exe"[\s\S]*\[preset\.0\.options\][\s\S]*application\/modify_resources=false/);
  assert.match(cfg, /\[preset\.1\.options\]\n\nvariant\/extensions_support=false\nvariant\/thread_support=false/);
  const more = S.addPreset(cfg, 'windows', 'Win debug', 'out/w.exe');
  assert.equal(E.presetsIn(more).at(-1).index, 3);
  assert.throws(() => S.presetSection('switch', 0, 'x', 'y'), /unknown preset kind/);
  assert.equal(S.hostPreset('win32'), 'windows');
  assert.equal(S.hostPreset('linux'), 'linux');
});

test('templates: 2D, 2.5D and 3D projects with an input map, the StudioHook autoload, tests, presets, and sprite sheets in Studio\'s asset layout', async () => {
  for (const t of ['2d', '2.5d', '3d']) {
    const files = await T.templateFiles(t, 'My "Game"');
    for (const f of ['project.godot', 'scenes/main.tscn', 'scripts/main.gd', 'tests/test_game.gd', 'harness/studio_hook.gd', 'harness/sprite_sheet.gd', 'addons/harness_test/test_case.gd', 'export_presets.cfg', '.gitignore']) assert.ok(files.has(f), `${t}: ${f}`);
    const proj = String(files.get('project.godot'));
    assert.match(proj, /config_version=5/);
    assert.match(proj, /config\/name="My \\"Game\\""/);
    assert.match(proj, /\[autoload\]\n\nStudioHook="\*res:\/\/harness\/studio_hook\.gd"/);
    for (const a of ['move_left', 'move_right', 'move_up', 'move_down', 'jump', 'action']) assert.match(proj, new RegExp(`\\n${a}=\\{\\n"deadzone": 0\\.2,\\n"events": \\[Object\\(InputEventKey,`), a);
    assert.match(proj, /"physical_keycode":4194321/, 'the arrow keys too');
    assert.match(String(files.get('scenes/main.tscn')), new RegExp(`type="${t === '2d' ? 'Node2D' : 'Node3D'}"`));
    assert.match(String(files.get('scripts/main.gd')), /StudioHook\.expect\(\[/);
    assert.match(String(files.get('tests/test_game.gd')), /^extends "res:\/\/addons\/harness_test\/test_case\.gd"/);
    assert.equal(files.has('assets/hero/hero.png'), t !== '3d');
  }
  const files = await T.templateFiles('2d', 'x');
  const hero = pngStats(files.get('assets/hero/hero.png'));
  assert.deepEqual([hero.width, hero.height, hero.blank], [128, 32, false]);
  const asset = JSON.parse(String(files.get('assets/hero/asset.json')));
  assert.equal(asset.kind, 'spritesheet');
  assert.deepEqual(asset.files, [{ path: 'hero.png', role: 'main' }]);
  assert.deepEqual(asset.meta.frameSize, [32, 32]);
  assert.deepEqual(Object.keys(asset.meta.animations), ['idle', 'walk']);
  assert.equal(asset.engines.godot.path, 'res://assets/hero/hero.png');
  assert.equal(JSON.parse(String(files.get('assets/tiles/asset.json'))).kind, 'tileset');
  await assert.rejects(T.templateFiles('4d', 'x'), /unknown template 4d/);
  assert.match(T.studioProject('X', '2d', 'game/project.godot'), /"engine": "godot"[\s\S]*"dimension": "2d"[\s\S]*"engineProject": "game\/project.godot"/);
});

test('bridge: the EditorPlugin is enabled in project.godot without losing other plugins; a call sends the token and the command', async () => {
  const base = 'config_version=5\n\n[application]\n\nconfig/name="X"\n';
  const once = B.withEditorPlugin(base);
  assert.match(once, /\[editor_plugins\]\n\nenabled=PackedStringArray\("res:\/\/addons\/harness_bridge\/plugin\.cfg"\)\n$/);
  assert.equal(B.withEditorPlugin(once), once, 'idempotent');
  const other = 'config_version=5\n\n[editor_plugins]\n\nenabled=PackedStringArray("res://addons/gut/plugin.cfg")\n\n[rendering]\n\nx=1\n';
  assert.match(B.withEditorPlugin(other), /enabled=PackedStringArray\("res:\/\/addons\/gut\/plugin\.cfg", "res:\/\/addons\/harness_bridge\/plugin\.cfg"\)\n\n\[rendering\]/);
  const sent: string[] = [];
  class FakeWs {
    onopen?: () => void; onmessage?: (e: { data: string }) => void; onerror?: () => void;
    url: string;
    constructor(url: string) { this.url = url; setTimeout(() => this.onopen?.(), 1); }
    send(s: string) { sent.push(s); const m = JSON.parse(s); setTimeout(() => this.onmessage?.({ data: JSON.stringify(m.cmd === 'tree' ? { id: m.id, ok: true, result: { tree: { name: 'Main' } } } : { id: m.id, ok: false, error: 'unknown command' }) }), 1); }
    close() {}
  }
  const info = { port: 47610, token: 'secret' };
  assert.deepEqual(await B.bridgeCall(info, 'tree', { depth: 2 }, { WebSocketImpl: FakeWs }), { tree: { name: 'Main' } });
  assert.deepEqual(JSON.parse(sent[0]!), { id: 1, token: 'secret', cmd: 'tree', params: { depth: 2 } });
  await assert.rejects(B.bridgeCall(info, 'nope', {}, { WebSocketImpl: FakeWs }), /the editor refused nope: unknown command/);
});

// ---------- the tool with the stand-in Godot ----------

test('project.create, detect, check, describe and script with a stand-in Godot', async () => {
  const fake = await fakeGodot();
  const h = await harness();
  const root = await tempDir();
  const godot = (input: Record<string, unknown>) => h.registry.tools.get('godot')!.run(input, ctxOf(new LocalHost(root))) as Promise<Out>;
  try {
    let r = await godot({ action: 'detect' });
    assert.ok(!r.is_error, r.content);
    assert.match(r.content, /godot detect: ok - Godot 4\.7\.2 \(host\)/);
    assert.match(r.content, /no windows export templates for 4\.7\.2/);
    r = await godot({ action: 'project.create', template: '2.5d', name: 'Iso', project: 'game' });
    assert.ok(!r.is_error, r.content);
    assert.match(r.content, /a 2\.5d project "Iso" in game: an isometric level.*Verified: it imports and its self-test passes \(isometric, moves, animates, collects\)/);
    assert.match(await fs.readFile(path.join(root, 'game', 'project.godot'), 'utf8'), /config\/name="Iso"/);
    const studio = JSON.parse(await fs.readFile(path.join(root, '.studio', 'project.json'), 'utf8'));
    assert.deepEqual([studio.engine, studio.dimension, studio.engineProject], ['godot', '2.5d', 'game/project.godot']);
    r = await godot({ action: 'project.create', template: '3d', project: 'game' });
    assert.equal(r.is_error, true);
    assert.match(r.content, /game\/project\.godot exists already: project\.create never overwrites/);
    r = await godot({ action: 'project.create', template: 'voxel' });
    assert.match(r.content, /template must be one of 2d, 2\.5d, 3d/);

    r = await godot({ action: 'check', project: 'game' });
    assert.equal(r.content, 'godot check: game imports cleanly; 3 scripts and scenes load without errors.');
    r = await godot({ action: 'describe', project: 'game' });
    assert.match(r.content, /godot describe: ok - res:\/\/scenes\/main\.tscn: 3 node\(s\) after 2 frame\(s\); project "Fake", 1 input action\(s\), autoloads: StudioHook/);
    assert.ok((await fs.readdir(path.join(root, 'game', '.godot', 'harness'))).includes('boot.tscn'), 'the harness scripts go into Godot\'s cache folder');
    r = await godot({ action: 'script', project: 'game', code: 'print(root)\nprint("boom")' });
    assert.equal(r.is_error, true);
    assert.match(r.content, /godot script: failed - exit 0 .* 1 error\(s\)[\s\S]*SCRIPT ERROR: boom/);
    r = await godot({ action: 'script', project: 'game', code: 'print(root)' });
    assert.ok(!r.is_error, r.content);
    assert.match(r.content, /RAN 7 lines/, 'the lines are wrapped in a SceneTree script');
    assert.ok(!(await fs.readdir(path.join(root, 'game', '.godot', 'harness'))).some((f) => f.startsWith('script-')), 'the script is removed');
  } finally { unsetFake(); await h.close(); }
});

test('play: the timeline reaches the game as frames, frames come back as images, the metrics and the game\'s state and events are reported; errors fail it', async () => {
  const fake = await fakeGodot();
  const h = await harness();
  const root = await tempDir();
  const godot = (input: Record<string, unknown>) => h.registry.tools.get('godot')!.run(input, ctxOf(new LocalHost(root))) as Promise<Out>;
  try {
    await godot({ action: 'project.create', template: '2d', project: 'game', verify: false });
    let r = await godot({ action: 'play', project: 'game', seconds: 2, every: 30, inputs: [{ t: 0, action: 'move_right', hold: 1 }, { t: 1.5, key: 'Space' }] });
    assert.ok(!r.is_error, r.content);
    assert.match(r.content, /godot play: ok - 120 frames \(2s of game time\) in 0\.5s: 240\.5 fps, frame 4\.1 ms avg \/ 6\.2 p95, 30\.5 MB; 3 of 3 input\(s\) applied; no errors\. 4 frame\(s\) in \.harness\/godot\/play-/);
    assert.match(r.content, /Metrics: fps=240\.5, frameMsAvg=4\.1, frameMsP95=6\.2, frameMsMax=9, memoryMb=30\.5, memoryPeakMb=31, drawCalls=12, frames=120, realSeconds=0\.5, gameSeconds=2, nodes=20, errors=0, captures=4/);
    assert.equal(r.images?.length, 4);
    const data = r.details!.data as { state: { game: { inputs: unknown[] } }; events: unknown[]; captures: { file: string }[] };
    assert.deepEqual(data.state.game.inputs, [{ f: 0, action: 'move_right', down: true }, { f: 60, action: 'move_right', down: false }, { f: 90, key: 'Space', down: true }]);
    assert.deepEqual(data.events, [{ t: 1, type: 'pickup', detail: 'coin 1 of 5' }]);
    await fs.access(path.join(root, data.captures[0]!.file));
    const playCall = (await fake.calls()).find((c) => c.includes('boot.tscn'))!;
    assert.match(playCall, /--path game .*--audio-driver Dummy --fixed-fps 60 res:\/\/\.godot\/harness\/boot\.tscn -- --harness=/);
    assert.ok(!playCall.includes('--headless'), 'frames need a window');

    r = await godot({ action: 'play', project: 'game', seconds: 1, headless: true, inputs: [{ t: 0, action: 'jump' }] });
    assert.match(r.content, /60 frames .* Headless: state only, no frames\./);
    assert.match((await fake.calls()).at(-1)!, /--path game --headless --fixed-fps 60 res:\/\/\.godot\/harness\/boot\.tscn/);
    r = await godot({ action: 'play', project: 'game', frames: 30, realtime: true, headless: true });
    assert.ok(!(await fake.calls()).at(-1)!.includes('--fixed-fps'), 'realtime: no fixed fps');
    process.env.FAKE_PLAY_ERROR = '1';
    r = await godot({ action: 'play', project: 'game', frames: 30, headless: true });
    assert.equal(r.is_error, true);
    assert.match(r.content, /godot play: failed - .*1 error\(s\)[\s\S]*- error: SCRIPT ERROR: Invalid access to property or key \(at: _process \(res:\/\/scripts\/main\.gd:7\)\) \(scripts\/main\.gd:7\)/);
    delete process.env.FAKE_PLAY_ERROR;
    r = await godot({ action: 'play', project: 'game', inputs: [{ t: 1 }] });
    assert.match(r.content, /godot play: failed - inputs\[0\] needs action, key, or button/);

    r = await godot({ action: 'capture', project: 'game', frames: 10, out: 'shots/a.png' });
    assert.ok(!r.is_error, r.content);
    assert.match(r.content, /godot capture: ok - frame 10 saved to shots\/a\.png/);
    assert.equal(r.images?.length, 1);
    assert.ok((await fs.readFile(path.join(root, 'shots', 'a.png'))).equals(testPicture(64, 48)));
  } finally { unsetFake(); await h.close(); }
});

test('test: results per test as data, failures with their file and line; selftest adds one more', async () => {
  await fakeGodot();
  const h = await harness();
  const root = await tempDir();
  const godot = (input: Record<string, unknown>) => h.registry.tools.get('godot')!.run(input, ctxOf(new LocalHost(root))) as Promise<Out>;
  try {
    await godot({ action: 'project.create', template: '3d', project: 'game', verify: false });
    await fs.rm(path.join(root, 'game', 'addons'), { recursive: true });
    let r = await godot({ action: 'test', project: 'game', filter: 'scores' });
    assert.equal(r.is_error, true);
    assert.match(r.content, /godot test: failed - 1 of 2 test\(s\) passed, 1 failed in 9 ms \(added the test base class game\/addons\/harness_test\/test_case\.gd\)/);
    assert.match(r.content, /- error: test_scores: expected 1, got 0 \(game\/tests\/test_game\.gd:12\)/);
    assert.match(r.content, /Metrics: tests=2, passed=1, failed=1, skipped=0/);
    const data = r.details!.data as { tests: { name: string; status: string }[]; summary: { filter: string } };
    assert.deepEqual(data.tests.map((t) => `${t.name}:${t.status}`), ['test_moves:passed', 'test_scores:failed']);
    assert.equal(data.summary.filter, 'scores', 'the filter reaches the runner');
    process.env.FAKE_TESTS_PASS = '1';
    r = await godot({ action: 'test', project: 'game', selftest: true });
    assert.ok(!r.is_error, r.content);
    assert.match(r.content, /godot test: ok - 3 of 3 test\(s\) passed/);
  } finally { unsetFake(); await h.close(); }
});

test('step mode: a long-lived Godot advanced a step at a time with inputs; each step brings back the frame and the state', async () => {
  const fake = await fakeGodot();
  const h = await harness();
  const root = await tempDir();
  const host = withSpawn(new LocalHost(root), fake.js);
  const godot = (input: Record<string, unknown>) => h.registry.tools.get('godot')!.run(input, ctxOf(host)) as Promise<Out>;
  try {
    await godot({ action: 'project.create', template: '2d', project: 'game', verify: false });
    let r = await godot({ action: 'step.start', project: 'game', size: [640, 360] });
    assert.ok(!r.is_error, r.content);
    const session = (r.details!.data as { session: string }).session;
    assert.match(session, /^step-[0-9a-f]{8}$/);
    assert.match(r.content, /step session step-[0-9a-f]+ started \(windowed: frames come back\)/);
    assert.equal(r.images?.length, 1);
    r = await godot({ action: 'step', session, inputs: [{ action: 'move_right' }], frames: 30 });
    assert.ok(!r.is_error, r.content);
    assert.match(r.content, /godot step: ok - step 1: frame 31/);
    assert.deepEqual((r.details!.data as { state: unknown }).state, { frame: 31, game: { x: 60 } });
    assert.equal(r.images?.length, 1);
    r = await godot({ action: 'step', session, inputs: [{ action: 'move_right', up: true }], frames: 10 });
    assert.deepEqual((r.details!.data as { state: unknown }).state, { frame: 41, game: { x: 60 } });
    r = await godot({ action: 'step.state', session });
    assert.match(r.content, /godot step\.state: ok - step 2: frame 41\n/);
    r = await godot({ action: 'step', session, inputs: [{ action: 'explode' }], frames: 1 });
    assert.equal(r.is_error, true, 'an error while stepping is reported');
    assert.match(r.content, /SCRIPT ERROR: step broke/);
    r = await godot({ action: 'step.stop', session });
    assert.match(r.content, /godot step\.stop: ok - step session .* ended after 3 step\(s\)/);
    r = await godot({ action: 'step', session, frames: 1 });
    assert.match(r.content, /no step session step-/);
    const comp = { kind: 'companion', root: '', displayRoot: root, platform: 'linux', shell: 'bash', exec: (c: string, o: never) => new LocalHost(root).exec(c, o), remoteTool: async () => ({ content: 'No files match' }) } as unknown as ToolHost;
    r = await h.registry.tools.get('godot')!.run({ action: 'step.start', project: 'game' }, ctxOf(comp)) as Out;
    assert.match(r.content, /step mode needs a long-lived Godot process, which this runtime cannot keep \(a companion\)/);
  } finally { unsetFake(); await h.close(); }
});

test('build and package: a platform picks its preset, the build is recorded in .studio/project.json and zipped; the godot-export gate builds every preset', async () => {
  const fake = await fakeGodot();
  const h = await harness();
  const root = await tempDir();
  const host = new LocalHost(root);
  const godot = (input: Record<string, unknown>) => h.registry.tools.get('godot')!.run(input, ctxOf(host)) as Promise<Out>;
  const signal = new AbortController().signal;
  try {
    await godot({ action: 'project.create', template: '2d', project: 'game', verify: false });
    let r = await godot({ action: 'build', project: 'game', platform: 'windows' });
    assert.ok(!r.is_error, r.content);
    assert.match(r.content, /godot build: ok - Windows Desktop -> build\/windows\/game\.exe in [\d.]+s/);
    assert.match(r.content, /Files: build\/windows\/game\.exe, build\/windows\/game\.pck/);
    assert.match((await fake.calls()).at(-1)!, /--export-release Windows Desktop .*\/build\/windows\/game\.exe$/);
    r = await godot({ action: 'build', project: 'game', platform: 'web', debug: true });
    assert.match(r.content, /Web -> build\/web\/index\.html/);
    assert.match((await fake.calls()).at(-1)!, /--export-debug Web /);
    const studio = JSON.parse(await fs.readFile(path.join(root, '.studio', 'project.json'), 'utf8'));
    assert.deepEqual(studio.builds.map((b: { id: string; platform: string; path: string }) => `${b.id}:${b.platform}:${b.path}`), ['b1:windows:build/windows/game.exe', 'b2:web:build/web/index.html']);
    r = await godot({ action: 'package', project: 'game', platform: 'windows', name: 'Coin Run' });
    assert.match(r.content, /packaged as build\/Coin_Run-windows\.zip/);
    assert.deepEqual((await Z.zipEntries(path.join(root, 'build', 'Coin_Run-windows.zip'))).map((e: { name: string }) => e.name), ['game.exe', 'game.pck']);
    r = await godot({ action: 'build', project: 'game', platform: 'windows', preset: 'Nope' });
    assert.match(r.content, /no preset named "Nope"\. The presets there: "Windows Desktop" \(Windows Desktop\), "Web" \(Web\), "Linux" \(Linux\)/);

    const gate = h.registry.gates.get('godot-export')!;
    assert.equal(await gate.applies!(host, signal), true);
    let [g] = await runGates(h.registry, host, ['godot-export'], signal);
    assert.equal(g!.pass, true, g!.details ?? '');
    assert.match(g!.summary, /^3 preset\(s\) build: game: "Windows Desktop" .*, game: "Web" .*, game: "Linux"/);
    await assert.rejects(fs.stat(path.join(root, '.harness', 'godot', 'export-check', 'game')), 'the check builds are removed');
    process.env.FAKE_NO_TEMPLATES = '1';
    [g] = await runGates(h.registry, host, ['godot-export'], signal);
    assert.equal(g!.pass, false);
    assert.equal(g!.severity, 'advisory', 'no templates: not checked, not failed');
    assert.match(g!.summary, /not checked: game: "Windows Desktop": no export templates/);
  } finally { unsetFake(); await h.close(); }
});

test('asset.import brings a Studio asset into the project and records it; asset.export, render and bridge.install', async () => {
  const fake = await fakeGodot();
  const h = await harness();
  const root = await tempDir();
  const godot = (input: Record<string, unknown>) => h.registry.tools.get('godot')!.run(input, ctxOf(new LocalHost(root))) as Promise<Out>;
  try {
    await godot({ action: 'project.create', template: '2.5d', project: 'game', verify: false });
    await fs.mkdir(path.join(root, '.studio', 'assets', 'robot'), { recursive: true });
    await fs.writeFile(path.join(root, '.studio', 'assets', 'robot', 'robot.png'), testPicture(64, 64));
    await fs.writeFile(path.join(root, '.studio', 'assets', 'robot', 'asset.json'), JSON.stringify({ id: 'robot', kind: 'spritesheet', files: [{ path: 'robot.png', role: 'main' }], engines: {} }));
    let r = await godot({ action: 'asset.import', project: 'game', asset: 'robot' });
    assert.ok(!r.is_error, r.content);
    assert.match(r.content, /imported into game: res:\/\/assets\/robot\/robot\.png \(asset robot\)/);
    await fs.access(path.join(root, 'game', 'assets', 'robot', 'robot.png'));
    for (const f of [path.join(root, 'game', 'assets', 'robot', 'asset.json'), path.join(root, '.studio', 'assets', 'robot', 'asset.json')]) {
      assert.equal(JSON.parse(await fs.readFile(f, 'utf8')).engines.godot.path, 'res://assets/robot/robot.png', f);
    }
    await fs.writeFile(path.join(root, 'barrel.glb'), 'glb');
    r = await godot({ action: 'asset.import', project: 'game', file: 'barrel.glb' });
    assert.match(r.content, /res:\/\/assets\/barrel\.glb/);
    r = await godot({ action: 'asset.export', project: 'game', output: 'exports/level.glb' });
    assert.match(r.content, /the main scene -> exports\/level\.glb: 2 mesh\(es\), 5 node\(s\)/);
    r = await godot({ action: 'render', project: 'game', frames: 5, out: 'renders/shot' });
    assert.match(r.content, /godot render: ok - 5 frame\(s\) in renders\/shot/);
    assert.equal(r.images?.length, 3);
    r = await godot({ action: 'render', project: 'game', frames: 5, out: 'renders/shot.avi' });
    assert.match(r.content, /a video of 5 frames: renders\/shot\.avi/);
    r = await godot({ action: 'bridge.install', project: 'game' });
    assert.match(r.content, /Harness Bridge EditorPlugin is in game\/addons\/harness_bridge and enabled in project\.godot/);
    assert.match(await fs.readFile(path.join(root, 'game', 'project.godot'), 'utf8'), /\[editor_plugins\]\n\nenabled=PackedStringArray\("res:\/\/addons\/harness_bridge\/plugin\.cfg"\)/);
    assert.match(await fs.readFile(path.join(root, 'game', 'addons', 'harness_bridge', 'plugin.gd'), 'utf8'), /listen\(p, "127\.0\.0\.1"\)/, 'local only');
    r = await godot({ action: 'bridge.status', project: 'game' });
    assert.match(r.content, /no editor: game\/\.godot\/harness_bridge\.json is not there/);
    r = await godot({ action: 'describe', project: 'game', live: true });
    assert.match(r.content, /no Godot editor with the Harness Bridge has game open/);
    // A stale bridge file (the editor was killed): reported, not hung on.
    await fs.writeFile(path.join(root, 'game', '.godot', 'harness_bridge.json'), JSON.stringify({ port: 1, token: 't', pid: 1 }));
    r = await godot({ action: 'bridge.status', project: 'game' });
    assert.match(r.content, /the bridge file is there but the editor does not answer/);
    void fake;
  } finally { unsetFake(); await h.close(); }
});
