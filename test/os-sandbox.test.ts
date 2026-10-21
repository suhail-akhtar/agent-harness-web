import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dockerAvailable, imageExists } from '../src/runtime/docker.ts';
import { LocalHost } from '../src/runtime/host.ts';
import { bwrapArgs, chooseSandbox, detectOsSandbox, seatbeltProfile, wrapCommand } from '../src/runtime/os-sandbox.ts';
import { tempDir } from './helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const hasBwrap = process.platform === 'linux' && detectOsSandbox() === 'bwrap';
const hasDocker = (await dockerAvailable()) && (await imageExists('harness-sandbox:latest'));

test('choosing a sandbox: auto takes the OS one, then Docker; an explicit one that is missing is an error, never a silent "off"', () => {
  assert.equal(chooseSandbox('auto', { os: 'bwrap', docker: true }).kind, 'bwrap');
  assert.equal(chooseSandbox('auto', { os: null, docker: true }).kind, 'docker');
  assert.match(chooseSandbox('auto', { os: null, docker: false }).why, /unsandboxed and need approval/);
  assert.equal(chooseSandbox(undefined, { os: 'bwrap', docker: true }).kind, 'off');
  assert.throws(() => chooseSandbox('bwrap', { os: null, docker: true }), /has no OS sandbox/);
  assert.throws(() => chooseSandbox('seatbelt', { os: 'bwrap', docker: false }), /has bwrap/);
  assert.throws(() => chooseSandbox('docker', { os: 'bwrap', docker: false }), /Docker .* not available/);
  assert.equal(detectOsSandbox('win32'), null, 'Windows has no OS sandbox for a command');
  assert.equal(detectOsSandbox('linux', () => false), null, 'bubblewrap that cannot run (no user namespaces) does not count');
});

test('bubblewrap: read-only system, credentials hidden, the workspace writable last, no network unless allowed', () => {
  const a = bwrapArgs('npm test', { root: '/home/u/proj', network: 'none', home: '/home/u', exists: (p) => !p.endsWith('.azure') });
  const s = a.join(' ');
  assert.match(s, /--unshare-net/);
  assert.match(s, /--ro-bind \/ \//);
  assert.match(s, /--tmpfs \/home\/u\/\.ssh/);
  assert.doesNotMatch(s, /\.azure/, 'only folders that exist are masked');
  assert.match(s, /--ro-bind \/dev\/null \/home\/u\/\.netrc/);
  assert.ok(a.indexOf('--bind') > a.lastIndexOf('--tmpfs'), 'the workspace is bound after the masks');
  assert.deepEqual(a.slice(-4), ['--', 'bash', '-c', 'npm test']);
  assert.doesNotMatch(bwrapArgs('x', { root: '/w', network: 'full', home: '/h', exists: () => false }).join(' '), /unshare-net/);
  // A workspace inside a masked folder stays reachable (the mask is skipped).
  assert.doesNotMatch(bwrapArgs('x', { root: '/home/u/.config/gcloud/proj', network: 'none', home: '/home/u' }).join(' '), /--tmpfs \/home\/u\/\.config\/gcloud /);
});

test('Seatbelt: writes only to the workspace and temp folders, credential folders unreadable, network denied unless allowed', () => {
  const p = seatbeltProfile({ root: '/Users/u/proj "x"', network: 'none', home: '/Users/u' });
  assert.match(p, /\(deny file-write\*\)/);
  assert.match(p, /\(allow file-write\* \(subpath "\/Users\/u\/proj \\"x\\""\)/, 'quotes in the path are escaped');
  assert.match(p, /\(deny file-read\* file-write\* .*\(subpath "\/Users\/u\/\.ssh"\)/);
  assert.match(p, /\(deny network\*\)/);
  assert.doesNotMatch(seatbeltProfile({ root: '/w', network: 'full', home: '/h' }), /deny network/);
  const w = wrapCommand('seatbelt', 'make', { root: '/w', network: 'none', home: '/h' });
  assert.equal(w.file, 'sandbox-exec');
  assert.deepEqual(w.args.slice(-3), ['bash', '-c', 'make']);
});

test('bubblewrap for real: what a sandboxed command can and cannot do', { skip: !hasBwrap && 'not Linux with a working bubblewrap' }, async () => {
  const ws = await tempDir();
  const home = os.homedir();
  const host = new LocalHost(ws, { sandbox: 'bwrap', network: 'none' });
  assert.equal(host.sandboxed, true);
  let r = await host.exec('echo hi > made.txt && cat made.txt', { timeoutMs: 20_000 });
  assert.equal(r.stdout.trim(), 'hi', r.stderr);
  assert.equal(await fs.readFile(path.join(ws, 'made.txt'), 'utf8'), 'hi\n', 'writes reach the real folder');
  r = await host.exec('touch /usr/local/escape 2>&1; echo $?', { timeoutMs: 20_000 });
  assert.notEqual(r.stdout.trim().split('\n').at(-1), '0', 'the rest of the system is read-only');
  await fs.mkdir(path.join(home, '.ssh'), { recursive: true });
  await fs.writeFile(path.join(home, '.ssh', 'harness_probe'), 'private');
  r = await host.exec(`ls -A ${home}/.ssh | wc -l`, { timeoutMs: 20_000 });
  assert.equal(r.stdout.trim(), '0', 'credential folders look empty');
  await fs.rm(path.join(home, '.ssh', 'harness_probe'));
  r = await host.exec('node -e "require(\'net\').connect(53,\'1.1.1.1\').on(\'error\',e=>console.log(e.code)).on(\'connect\',()=>console.log(\'OPEN\'))"', { timeoutMs: 20_000 });
  assert.match(r.stdout, /ENETUNREACH|EACCES|ECONNREFUSED/, 'no network');
  r = await host.exec('ps -e --no-headers | wc -l', { timeoutMs: 20_000 });
  assert.ok(Number(r.stdout.trim()) < 6, `its own process tree, saw ${r.stdout.trim()} processes`);
});

test('bubblewrap for real: a worktree commits on its branch; the repository\'s hooks and config stay read-only', { skip: !hasBwrap && 'not Linux with a working bubblewrap' }, async () => {
  const { createWorktree, worktreeWritable } = await import('../src/git/worktree.ts');
  const repo = await tempDir();
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  await fs.writeFile(path.join(repo, 'a.txt'), '1');
  execFileSync('git', ['-C', repo, 'add', '-A'], { env });
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'init'], { env });
  const w = await createWorktree(repo, path.join(await tempDir(), 'wt'), 'bw');
  const host = new LocalHost(w.dir, { sandbox: 'bwrap', network: 'none', writable: worktreeWritable(w), readable: [w.commonDir] });
  const r = await host.exec(`echo 2 > a.txt && GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t git commit -qam two && echo COMMITTED; (echo x > ${w.commonDir}/hooks/post-checkout && echo HOOK) 2>&1 | tail -1; (git config core.hooksPath /tmp && echo CONFIG) 2>&1 | tail -1`, { timeoutMs: 30_000 });
  assert.match(r.stdout, /COMMITTED/, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /HOOK\b|CONFIG\b/, r.stdout);
  assert.equal(execFileSync('git', ['-C', repo, 'log', '--format=%s', '-1', w.branch], { encoding: 'utf8' }).trim(), 'two');
});

test('bubblewrap verified inside a Linux container (from any host with Docker)', { skip: (process.platform === 'linux' || !hasDocker) && 'runs directly on Linux, or no Docker' }, () => {
  // The real-bubblewrap test above, run where bubblewrap exists. --privileged lets it make namespaces inside the container.
  const repo = path.resolve(here, '..');
  const r = spawnSync('docker', ['run', '--rm', '--privileged', '-v', `${repo}:/repo:ro`, '-w', '/repo', 'harness-sandbox:latest', 'bash', '-c',
    'apt-get update -qq >/dev/null && apt-get install -y -qq bubblewrap >/dev/null && node --test --disable-warning=ExperimentalWarning --test-name-pattern="for real" test/os-sandbox.test.ts'], { encoding: 'utf8', timeout: 300_000 });
  const out = r.stdout + r.stderr;
  assert.match(out, /# pass 2\b/, out.slice(-3000));
  assert.match(out, /# fail 0\b/, out.slice(-3000));
  assert.match(out, /# skipped 0\b/, 'it really ran there, not skipped');
});

test('a local session can run its commands in a Docker sandbox with the folder mounted (Windows has no OS sandbox)', { skip: !hasDocker && 'no Docker or sandbox image' }, async () => {
  const { createHarness } = await import('../src/kernel/harness.ts');
  const { FakeProvider, results } = await import('./helpers.ts');
  const folder = await tempDir();
  await fs.writeFile(path.join(folder, 'notes.txt'), 'mine');
  const h = await createHarness({ dataDir: await tempDir(), search: null, memory: 'off' });
  const fake = new FakeProvider([
    { calls: [{ name: 'bash', input: { command: 'pwd; cat notes.txt; echo made > out.txt; ls /Users /home 2>&1 | head -3; (getent hosts example.com || echo NO-NET)' } }] },
    { text: 'done' },
  ]);
  h.registry.setProviderInstance('deepseek', fake);
  try {
    // Default mode: commands on a real folder normally need approval; in the sandbox they do not.
    const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'default', runtime: { kind: 'local', network: 'none', path: folder, sandbox: 'docker' } });
    let asked = 0;
    const ended = new Promise<void>((r) => s.subscribe(0, ({ event }) => {
      if (event.kind === 'permission_request') { asked++; s.respond(event.requestId, { decision: 'deny' }); }
      if (event.kind === 'turn_end' && !event.agent) r();
    }));
    await s.send('look');
    await ended;
    const out = results(s.history[2])[0]!.content;
    assert.equal(asked, 0, 'no prompt for a sandboxed command');
    assert.match(out, /^\/workspace\nmine/m);
    assert.match(out, /NO-NET/);
    assert.doesNotMatch(out, /Suhail|Administrator/, 'nothing of the host machine is visible');
    assert.equal(await fs.readFile(path.join(folder, 'out.txt'), 'utf8'), 'made\n', 'writes land in the real folder');
    await h.sessions.remove(s.meta.id);
    assert.equal(await fs.readFile(path.join(folder, 'notes.txt'), 'utf8'), 'mine', 'deleting the session leaves the user\'s folder');
  } finally { await h.close(); }
});

test('the companion reports its sandbox, and the server treats its commands as contained', async () => {
  const { CompanionHub } = await import('../src/runtime/companion.ts');
  const hub = new CompanionHub(await tempDir());
  const { id } = await hub.create('laptop');
  const host = hub.host(id, 's1');
  void hub.poll(id, { platform: 'linux', shell: 'bash', root: '/home/u/p', sandbox: 'bwrap', network: 'none' }, 1);
  assert.equal(host.sandboxed, true);
  assert.equal(host.networkPolicy, 'none');
  void hub.poll(id, { platform: 'win32', shell: 'bash', root: 'C:\\p' }, 1);
  assert.equal(host.sandboxed, false, 'an old companion that says nothing is not sandboxed');
  assert.equal(host.networkPolicy, 'full');
  // The bundled companion takes the option.
  const usage = spawnSync(process.execPath, [path.join(here, '..', 'scripts', 'run.mjs'), 'src/companion/main.ts', '--server', 'http://x', '--token', 't', '--sandbox', 'nonsense'], { encoding: 'utf8', cwd: path.join(here, '..') });
  assert.match(usage.stderr, /--sandbox auto\|bwrap\|seatbelt\|docker\|off/);
  void execFileSync;
});
