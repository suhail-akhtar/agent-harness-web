// The harness home (~/.harness, DESIGN section 19): where it is, its first-run layout, the tmp
// clean-up (only inside tmp, never through a link), moving older data in, moving the home, and the
// server's and the CLI's defaults.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  cleanTmp, copyVerified, ensureHome, harnessPaths, HOME_MARKER, homeLayout, migrateDataDir, moveHome, readHomeSettings, rebasePaths,
  removeOldHome, resolveHome, writeHomeSettings,
} from '../src/util/home.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = (p = 'hh-') => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const DAY = 86_400_000;

test('home resolution: HARNESS_HOME, a moved home\'s pointer, ~/.harness; Windows and Unix paths', () => {
  const w = path.win32; const u = path.posix;
  assert.equal(resolveHome({ env: {}, userHome: 'C:\\Users\\ann', pointer: null, pathMod: w }), 'C:\\Users\\ann\\.harness');
  assert.equal(resolveHome({ env: {}, userHome: '/home/ann', pointer: null, pathMod: u }), '/home/ann/.harness');
  assert.equal(resolveHome({ env: { HARNESS_HOME: 'D:\\work\\harness' }, userHome: 'C:\\Users\\ann', pointer: null, pathMod: w }), 'D:\\work\\harness');
  assert.equal(resolveHome({ env: { HARNESS_HOME: '/srv/harness/' }, userHome: '/home/ann', pointer: null, pathMod: u }), '/srv/harness');
  assert.equal(resolveHome({ env: { HARNESS_HOME: '~/h' }, userHome: '/home/ann', pointer: null, pathMod: u }), '/home/ann/h', '~ is the person\'s home');
  assert.equal(resolveHome({ env: { HARNESS_HOME: '~\\h' }, userHome: 'C:\\Users\\ann', pointer: null, pathMod: w }), 'C:\\Users\\ann\\h');
  assert.equal(resolveHome({ env: { HARNESS_HOME: '  ' }, userHome: '/home/ann', pointer: null, pathMod: u }), '/home/ann/.harness', 'blank is unset');
  assert.equal(resolveHome({ env: {}, userHome: '/home/ann', pointer: null, pathMod: u, fallback: '/data/app/home' }), '/data/app/home');
  // A move leaves a pointer the server, the CLI and the app all read; HARNESS_HOME still wins.
  const d = tmpDir();
  const pointer = path.join(d, '.harness-location');
  fs.writeFileSync(pointer, JSON.stringify({ home: path.join(d, 'moved') }));
  assert.equal(resolveHome({ env: {}, userHome: d, pointer }), path.join(d, 'moved'));
  assert.equal(resolveHome({ env: {}, userHome: d }), path.join(d, 'moved'), 'the pointer in the person\'s home by default');
  assert.equal(resolveHome({ env: { HARNESS_HOME: path.join(d, 'env') }, userHome: d, pointer }), path.join(d, 'env'));
  fs.writeFileSync(pointer, path.join(d, 'plain'));
  assert.equal(resolveHome({ env: {}, userHome: d, pointer }), path.join(d, 'plain'), 'a plain path works too');
  fs.writeFileSync(pointer, '{ not json');
  assert.equal(resolveHome({ env: {}, userHome: d, pointer }), path.join(d, '.harness'), 'a broken pointer is ignored');
  const l = homeLayout('/home/ann/.harness', u);
  assert.deepEqual(l, { home: '/home/ann/.harness', data: '/home/ann/.harness/data', workspaces: '/home/ann/.harness/workspaces', defaultWorkspace: '/home/ann/.harness/workspaces/default', tmp: '/home/ann/.harness/tmp', exports: '/home/ann/.harness/exports', plugins: '/home/ann/.harness/plugins', logs: '/home/ann/.harness/logs', settings: '/home/ann/.harness/settings.json' });
  assert.equal(homeLayout('C:\\Users\\ann\\.harness', w).defaultWorkspace, 'C:\\Users\\ann\\.harness\\workspaces\\default');
});

test('paths from the environment: explicit variables win, the home otherwise; an older data folder is kept while the home has none; local roots', () => {
  const d = tmpDir();
  const home = path.join(d, 'home');
  let p = harnessPaths({ env: { HARNESS_HOME: home }, pointer: null });
  assert.equal(p.dataDir, path.join(home, 'data'));
  assert.equal(p.dataFrom, 'home');
  assert.deepEqual(p.localRoots, [path.join(home, 'workspaces'), path.join(home, 'tmp')]);
  assert.equal(p.installDir, path.join(home, 'plugins'));
  p = harnessPaths({ env: { HARNESS_HOME: home, HARNESS_DATA: path.join(d, 'elsewhere'), HARNESS_LOCAL_ROOTS: [path.join(d, 'a'), path.join(d, 'b')].join(path.delimiter) }, pointer: null });
  assert.equal(p.dataDir, path.join(d, 'elsewhere'));
  assert.equal(p.dataFrom, 'env');
  assert.equal(p.installDir, path.join(d, 'elsewhere', 'plugins'), 'catalogue installs stay with explicit data, as before');
  assert.deepEqual(p.localRoots, [path.join(home, 'workspaces'), path.join(home, 'tmp'), path.join(d, 'a'), path.join(d, 'b')]);
  assert.equal(harnessPaths({ env: { HARNESS_HOME: home, HARNESS_DATA_DIR: path.join(d, 'dd') }, pointer: null }).dataDir, path.join(d, 'dd'), 'HARNESS_DATA_DIR too');
  assert.deepEqual(harnessPaths({ env: { HARNESS_HOME: home, HARNESS_HOME_ROOTS: 'off', HARNESS_LOCAL_ROOTS: path.join(d, 'a') }, pointer: null }).localRoots, [path.join(d, 'a')]);
  // The repository's old .harness-data: used while it has data and the home has none.
  const legacy = path.join(d, '.harness-data');
  assert.equal(harnessPaths({ env: { HARNESS_HOME: home }, pointer: null, legacy }).dataFrom, 'home', 'absent: the home');
  fs.mkdirSync(path.join(legacy, 'sessions'), { recursive: true });
  p = harnessPaths({ env: { HARNESS_HOME: home }, pointer: null, legacy });
  assert.deepEqual([p.dataDir, p.dataFrom], [legacy, 'legacy']);
  fs.mkdirSync(path.join(home, 'data', 'sessions'), { recursive: true });
  assert.equal(harnessPaths({ env: { HARNESS_HOME: home }, pointer: null, legacy }).dataFrom, 'home', 'once the home has data, the home');
});

test('first run: the layout is made (nothing there is ever changed), settings.json with the clean-up age', () => {
  const l = homeLayout(path.join(tmpDir(), '.harness'));
  assert.equal(ensureHome(l), true, 'a first run');
  for (const d of [l.data, l.workspaces, l.defaultWorkspace, l.tmp, l.exports, l.plugins, l.logs]) assert.ok(fs.statSync(d).isDirectory(), d);
  assert.ok(fs.existsSync(path.join(l.home, HOME_MARKER)));
  assert.deepEqual(readHomeSettings(l), { tmpCleanupDays: 7 });
  fs.writeFileSync(path.join(l.defaultWorkspace, 'notes.md'), 'mine');
  fs.writeFileSync(l.settings, JSON.stringify({ tmpCleanupDays: 3, theirs: true }));
  assert.equal(ensureHome(l), false, 'not a first run');
  assert.equal(fs.readFileSync(path.join(l.defaultWorkspace, 'notes.md'), 'utf8'), 'mine');
  assert.deepEqual(readHomeSettings(l), { tmpCleanupDays: 3 });
  assert.deepEqual(writeHomeSettings(l, { tmpCleanupDays: 14 }), { tmpCleanupDays: 14 });
  assert.equal(JSON.parse(fs.readFileSync(l.settings, 'utf8')).theirs, true, 'keys it does not know are kept');
  assert.throws(() => writeHomeSettings(l, { tmpCleanupDays: 0 }), /1 to 365/);
  fs.writeFileSync(l.settings, JSON.stringify({ tmpCleanupDays: -4 }));
  assert.deepEqual(readHomeSettings(l), { tmpCleanupDays: 7 }, 'a bad value reads as the default');
});

test('tmp clean-up: old entries go, recent ones stay; a link in tmp is removed as a link and never followed; nothing outside tmp is touched', async (t) => {
  const d = tmpDir();
  const tmp = path.join(d, 'tmp'); fs.mkdirSync(tmp);
  const outside = path.join(d, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep me');
  const now = Date.now();
  const old = (p: string) => { const s = (now - 10 * DAY) / 1000; fs.utimesSync(p, s, s); };
  // An old scratch folder, and a recent one (one file in it is new even though the folder is old).
  fs.mkdirSync(path.join(tmp, 'old', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'old', 'deep', 'a.txt'), 'x');
  for (const p of [path.join(tmp, 'old', 'deep', 'a.txt'), path.join(tmp, 'old', 'deep'), path.join(tmp, 'old')]) old(p);
  fs.mkdirSync(path.join(tmp, 'recent'));
  fs.writeFileSync(path.join(tmp, 'recent', 'b.txt'), 'y');
  old(path.join(tmp, 'recent'));
  // Links planted to the outside: at the top of tmp, and inside an old folder (a directory link needs no privilege on Windows as a junction).
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(outside, path.join(tmp, 'planted'), type);
  fs.mkdirSync(path.join(tmp, 'old2'));
  fs.symlinkSync(outside, path.join(tmp, 'old2', 'escape'), type);
  old(path.join(tmp, 'old2'));
  let fileLink = true;
  try { fs.symlinkSync(path.join(outside, 'precious.txt'), path.join(tmp, 'old', 'file-link'), 'file'); } catch { fileLink = false; t.diagnostic('no file symlinks here (Windows without the privilege): the directory links are checked'); }
  // The links' own times are now: the clean-up runs "30 days later" so they are old too, while the recent file stays newer than the cut-off.
  fs.utimesSync(path.join(tmp, 'recent', 'b.txt'), (now + 29 * DAY) / 1000, (now + 29 * DAY) / 1000);
  const r = await cleanTmp(tmp, { maxAgeDays: 7, now: now + 30 * DAY });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.removed.sort(), ['old', 'old2', 'planted']);
  assert.equal(r.kept, 1);
  assert.deepEqual(fs.readdirSync(tmp), ['recent']);
  assert.deepEqual(fs.readdirSync(outside), ['precious.txt'], 'what the links pointed at is untouched');
  assert.equal(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8'), 'keep me');
  if (fileLink) t.diagnostic('a file link was removed as a link');
  // An old folder whose only fresh thing is behind a link is still old: the link is not followed to read times.
  fs.mkdirSync(path.join(tmp, 'stale'));
  fs.symlinkSync(outside, path.join(tmp, 'stale', 'to-outside'), type);
  fs.utimesSync(path.join(outside, 'precious.txt'), (now + 40 * DAY) / 1000, (now + 40 * DAY) / 1000);
  old(path.join(tmp, 'stale'));
  const r2 = await cleanTmp(tmp, { maxAgeDays: 7, now: now + 30 * DAY });
  assert.ok(r2.removed.includes('stale'));
  assert.ok(fs.existsSync(path.join(outside, 'precious.txt')));
  // The default age is a week; nothing recent goes; a missing folder is nothing to do; a root is refused.
  fs.mkdirSync(path.join(tmp, 'today'));
  assert.deepEqual((await cleanTmp(tmp)).removed, []);
  assert.deepEqual(await cleanTmp(path.join(d, 'missing')), { removed: [], kept: 0, errors: [] });
  await assert.rejects(cleanTmp(path.parse(d).root), /refused/);
  await assert.rejects(cleanTmp(tmp, { maxAgeDays: 0 }), /at least 1/);
});

test('migration: an older data folder is copied into the home once, verified, the old one kept as a backup; a failure keeps using it', async () => {
  const d = tmpDir();
  const from = path.join(d, 'userData', 'engine');
  fs.mkdirSync(path.join(from, 'sessions', 'abc'), { recursive: true });
  fs.writeFileSync(path.join(from, 'sessions', 'abc', 'meta.json'), '{"id":"abc"}');
  fs.writeFileSync(path.join(from, 'users.json'), 'x'.repeat(5000));
  const to = path.join(d, 'home', 'data');
  fs.mkdirSync(to, { recursive: true }); // the home made it empty
  const r = await migrateDataDir(from, to);
  assert.equal(r.status, 'moved', r.message);
  assert.equal(r.dataDir, to);
  assert.match(r.message, /moved 2 file\(s\) from .* to .*backup/);
  assert.equal(fs.readFileSync(path.join(to, 'sessions', 'abc', 'meta.json'), 'utf8'), '{"id":"abc"}');
  assert.equal(fs.statSync(path.join(to, 'users.json')).size, 5000);
  assert.ok(!fs.existsSync(from), 'renamed away');
  assert.ok(r.backup && fs.existsSync(path.join(r.backup, 'users.json')) && fs.existsSync(path.join(r.backup, 'MOVED.txt')), 'the backup is kept');
  assert.equal((await migrateDataDir(from, to)).status, 'done-before', 'once');
  // An older folder next to a home that already has data is left alone.
  const from2 = path.join(d, 'u2', 'engine'); fs.mkdirSync(from2, { recursive: true }); fs.writeFileSync(path.join(from2, 'x'), '1');
  const to2 = path.join(d, 'h2', 'data'); fs.mkdirSync(to2, { recursive: true }); fs.writeFileSync(path.join(to2, 'y'), '2');
  const r2 = await migrateDataDir(from2, to2);
  assert.equal(r2.status, 'nothing');
  assert.ok(fs.existsSync(path.join(from2, 'x')));
  // A copy that cannot be made (the target's parent is a file): the old folder stays in use, no partial copy is left.
  const from3 = path.join(d, 'u3', 'engine'); fs.mkdirSync(from3, { recursive: true }); fs.writeFileSync(path.join(from3, 'x'), '1');
  fs.writeFileSync(path.join(d, 'blocker'), '');
  const r3 = await migrateDataDir(from3, path.join(d, 'blocker', 'data'));
  assert.equal(r3.status, 'failed');
  assert.equal(r3.dataDir, from3);
  assert.match(r3.message, /still using/);
  assert.ok(fs.existsSync(path.join(from3, 'x')));
  // Nothing to move.
  assert.equal((await migrateDataDir(path.join(d, 'none'), path.join(d, 'h4', 'data'))).status, 'nothing');
  await assert.rejects(copyVerified(from2, to2), /not empty/);
});

test('moving the home: copied and checked, sessions\' folders follow, the pointer written, the old copy kept until removed', async () => {
  const d = tmpDir();
  const l = homeLayout(path.join(d, '.harness'));
  ensureHome(l);
  const ws = path.join(l.workspaces, 'shop');
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, 'README.md'), '# shop');
  fs.mkdirSync(path.join(l.data, 'sessions', 's1'), { recursive: true });
  fs.writeFileSync(path.join(l.data, 'sessions', 's1', 'meta.json'), JSON.stringify({ id: 's1', runtime: { kind: 'local', path: ws }, other: path.join(d, 'elsewhere') }));
  const pointer = path.join(d, '.harness-location');
  await assert.rejects(moveHome(l.home, path.join(l.home, 'inside'), { pointer }), /inside the current one/);
  await assert.rejects(moveHome(l.home, l.home, { pointer }), /where the home is now/);
  await assert.rejects(moveHome(path.join(d, 'not-a-home'), path.join(d, 'x'), { pointer }), /not a harness home/);
  const to = path.join(d, 'new place', 'Harness');
  const r = await moveHome(l.home, to, { pointer });
  assert.equal(r.home, to);
  assert.equal(r.sessionsRebased, 1);
  assert.equal(fs.readFileSync(path.join(to, 'workspaces', 'shop', 'README.md'), 'utf8'), '# shop');
  const meta = JSON.parse(fs.readFileSync(path.join(to, 'data', 'sessions', 's1', 'meta.json'), 'utf8'));
  assert.equal(meta.runtime.path, path.join(to, 'workspaces', 'shop'));
  assert.equal(meta.other, path.join(d, 'elsewhere'), 'other paths are left alone');
  assert.equal(resolveHome({ env: {}, userHome: d, pointer }), to, 'the server, the CLI and the app find it');
  assert.ok(fs.existsSync(path.join(l.home, 'MOVED.txt')) && fs.existsSync(path.join(ws, 'README.md')), 'the old copy is kept');
  await assert.rejects(removeOldHome(to, to), /in use/);
  await assert.rejects(removeOldHome(path.join(d, 'new place'), to), /in use/);
  const plain = path.join(d, 'plain'); fs.mkdirSync(plain);
  await assert.rejects(removeOldHome(plain, to), /not a harness home/);
  assert.ok(fs.existsSync(plain));
  await removeOldHome(l.home, to);
  assert.ok(!fs.existsSync(l.home));
  assert.deepEqual(rebasePaths({ a: ['/h/x', '/hx/y', '/h'] }, '/h', '/n'), { a: ['/n/x', '/hx/y', '/n'] });
});

async function runNode(args: string[], env: Record<string, string>, timeoutMs = 60_000): Promise<{ code: number | null; out: string }> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_API_KEY$|^HARNESS_/.test(k)) clean[k] = v;
  const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { env: { ...clean, ...env }, cwd: root });
  let out = '';
  return new Promise((resolve) => {
    const timer = setTimeout(() => c.kill(), timeoutMs);
    c.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    c.stderr.on('data', (b: Buffer) => { out += b.toString(); });
    c.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

test('the CLI and the server default to the home: the CLI\'s data and scratch folder, the server\'s data and local roots', async () => {
  const d = tmpDir();
  const home = path.join(d, 'home');
  // The CLI with no key: the run fails, and its session is in the home's data, its folder in the home's tmp.
  const r = await runNode([path.join(root, 'src', 'cli.ts'), '--output', 'json', '--model', 'deepseek-flash', 'say hello'], { HARNESS_HOME: home, HARNESS_PLUGINS: '', HARNESS_BUNDLED_PLUGINS: 'off', HARNESS_PLUGIN_LOOPS: 'off' });
  const j = JSON.parse(r.out.trim().split('\n').pop()!) as { sessionId: string };
  assert.ok(fs.existsSync(path.join(home, 'data', 'sessions', j.sessionId, 'meta.json')), r.out);
  const meta = JSON.parse(fs.readFileSync(path.join(home, 'data', 'sessions', j.sessionId, 'meta.json'), 'utf8'));
  assert.ok(String(meta.runtime.path).startsWith(path.join(home, 'tmp') + path.sep), `the run's folder is a scratch one: ${meta.runtime.path}`);
  for (const f of ['workspaces/default', 'exports', 'plugins', 'logs', 'settings.json']) assert.ok(fs.existsSync(path.join(home, f)), f);
  // The server: its data, its local roots (the home's workspaces and tmp, then HARNESS_LOCAL_ROOTS), the tmp clean-up on start.
  const extra = path.join(d, 'extra'); fs.mkdirSync(extra);
  const stale = path.join(home, 'tmp', 'stale'); fs.mkdirSync(stale);
  fs.utimesSync(stale, (Date.now() - 30 * DAY) / 1000, (Date.now() - 30 * DAY) / 1000);
  const port = 43000 + Math.floor(Math.random() * 2000);
  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, 'src', 'server', 'main.ts')], {
    cwd: root, env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_API_KEY$|^HARNESS_/.test(k))), HARNESS_HOME: home, HARNESS_PORT: String(port), HARNESS_TOKEN: 'home-test', HARNESS_LOCAL_ROOTS: extra, HARNESS_BUNDLED_PLUGINS: 'off', HARNESS_PLUGIN_LOOPS: 'off' } as Record<string, string>,
  });
  let log = '';
  server.stdout.on('data', (b) => { log += b; }); server.stderr.on('data', (b) => { log += b; });
  try {
    const deadline = Date.now() + 60_000;
    // The lines after 'listening on' may come in a later chunk: wait for the last one.
    while (!/local folders:/.test(log) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 200));
    assert.match(log, /listening on/, log);
    assert.match(log, new RegExp(`data: ${path.join(home, 'data').replace(/\\/g, '\\\\')}`));
    const cfg = await (await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { authorization: 'Bearer home-test' } })).json() as { runtimes: { local: boolean; localRoots: string[] } };
    assert.equal(cfg.runtimes.local, true);
    assert.deepEqual(cfg.runtimes.localRoots, [path.join(home, 'workspaces'), path.join(home, 'tmp'), extra]);
    // A session in the home's default workspace is allowed; a folder outside the roots is not.
    const mk = (p: string) => fetch(`http://127.0.0.1:${port}/api/sessions`, { method: 'POST', headers: { authorization: 'Bearer home-test', 'content-type': 'application/json', 'x-harness': '1' }, body: JSON.stringify({ model: 'deepseek-flash', runtime: 'local', path: p }) });
    assert.equal((await mk(path.join(home, 'workspaces', 'default'))).status, 201);
    assert.equal((await mk(d)).status, 400, 'outside the roots');
    for (let i = 0; i < 50 && fs.existsSync(stale); i++) await new Promise((res) => setTimeout(res, 100));
    assert.ok(!fs.existsSync(stale), 'tmp was cleaned on start');
  } finally { server.kill(); }
});
