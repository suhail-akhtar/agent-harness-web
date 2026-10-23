import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dockerAvailable, imageExists } from '../src/runtime/docker.ts';
import { LocalHost } from '../src/runtime/host.ts';
import { BWRAP_PROXY_PORT, bwrapArgs, chooseSandbox, detectOsSandbox, proxyEnv, sandboxProxyOrigin, seatbeltProfile, wrapCommand } from '../src/runtime/os-sandbox.ts';
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
  // Local ways out are hidden; the workspace's git hooks and config are bound read-only after it.
  const b = bwrapArgs('x', { root: '/w', network: 'full', home: '/h', exists: (p) => ['/run/user', '/var/run/docker.sock', '/h/.docker/run/docker.sock', '/w/.git/hooks', '/w/.git/config'].includes(p) });
  const bs = b.join(' ');
  assert.match(bs, /--tmpfs \/run\/user/);
  assert.match(bs, /--ro-bind \/dev\/null \/var\/run\/docker\.sock/);
  assert.match(bs, /--ro-bind \/dev\/null \/h\/\.docker\/run\/docker\.sock/);
  assert.match(bs, /--cap-drop ALL/);
  assert.ok(b.indexOf('/w/.git/hooks') > b.indexOf('--bind'), 'git hooks bound read-only after the workspace');
  assert.match(bs, /--ro-bind \/w\/\.git\/config \/w\/\.git\/config --chdir/);
  // A workspace inside a masked folder stays reachable (the mask is skipped).
  assert.doesNotMatch(bwrapArgs('x', { root: '/home/u/.config/gcloud/proj', network: 'none', home: '/home/u' }).join(' '), /--tmpfs \/home\/u\/\.config\/gcloud /);
});

test('Seatbelt: writes only to the workspace and temp folders, credential folders unreadable, network denied unless allowed', () => {
  const p = seatbeltProfile({ root: '/Users/u/proj "x"', network: 'none', home: '/Users/u' });
  assert.match(p, /\(deny file-write\*\)/);
  assert.match(p, /\(allow file-write\* \(subpath "\/Users\/u\/proj \\"x\\""\)/, 'quotes in the path are escaped');
  assert.match(p, /\(deny file-read\* file-write\* .*\(subpath "\/Users\/u\/\.ssh"\)/);
  assert.match(p, /\(deny network\*\)/);
  assert.doesNotMatch(p, /allow network\* \(local unix-socket\)/, 'no unix sockets either when there is no network');
  const full = seatbeltProfile({ root: '/w', network: 'full', home: '/h' });
  assert.doesNotMatch(full, /deny network\*\)/);
  assert.match(full, /\(deny network-outbound \(remote unix-socket \(path-literal "\/private\/var\/run\/docker\.sock"\)\)/, 'the Docker socket is refused even with network');
  assert.match(full, /\(deny process-exec \(literal "\/usr\/bin\/open"\)/);
  assert.match(full, /\(deny mach-lookup \(global-name "com\.apple\.coreservices\.launchservicesd"\)/);
  assert.match(full, /\(deny file-write\* \(subpath "\/w\/\.git\/hooks"\) \(literal "\/w\/\.git\/config"\)\)/);
  const w = wrapCommand('seatbelt', 'make', { root: '/w', network: 'none', home: '/h' });
  assert.equal(w.file, 'sandbox-exec');
  assert.deepEqual(w.args.slice(-3), ['bash', '-c', 'make']);
});

test('hidden folders (the harness checkout in an eval run): bubblewrap mounts an empty folder over each, Seatbelt refuses their contents; a workspace inside one stays visible', () => {
  const o = { root: '/repo/out/run/ws', network: 'none' as const, home: '/home/u', exists: (p: string) => p !== '/gone', hidden: ['/repo', '/gone', '/repo/out/run/ws/sub', '/other/evals'] };
  const a = bwrapArgs('cat x', o);
  const at = (flag: string, p: string) => a.findIndex((x, i) => x === flag && a[i + 1] === p);
  assert.ok(at('--tmpfs', '/repo') > 0 && at('--tmpfs', '/other/evals') > 0, a.join(' '));
  assert.ok(at('--bind', '/repo/out/run/ws') > at('--tmpfs', '/repo'), 'the workspace is bound back after the folder that holds it is emptied');
  assert.equal(at('--tmpfs', '/gone'), -1, 'only folders that exist can be masked');
  assert.equal(at('--tmpfs', '/repo/out/run/ws/sub'), -1, 'nothing inside the workspace is hidden from it');
  const p = seatbeltProfile(o);
  const lines = p.split('\n');
  const deny = lines.indexOf('(deny file-read-data file-write* (subpath "/repo") (subpath "/gone") (subpath "/other/evals"))');
  assert.ok(deny > 0, p);
  assert.ok(lines.indexOf('(allow file-read* file-write* (subpath "/repo/out/run/ws"))') > deny, 'the workspace is allowed after the deny (the later rule wins)');
  assert.doesNotMatch(bwrapArgs('x', { root: '/w', network: 'none', home: '/h', exists: () => true }).join(' '), /--tmpfs \/repo/);
  assert.doesNotMatch(seatbeltProfile({ root: '/w', network: 'none', home: '/h' }), /file-read-data/);
  // The host carries them to every command it wraps, and to a sub-agent's worktree; unsandboxed, there is nothing to hide with.
  const host = new LocalHost('/w', { sandbox: 'bwrap', network: 'none', hidden: ['/repo'] });
  assert.deepEqual(host.hidden, ['/repo']);
  assert.deepEqual(host.withRoot('/w2').hidden, ['/repo']);
  assert.deepEqual(new LocalHost('/w', { hidden: ['/repo'] }).hidden, []);
});

test('an allowlist in the OS sandboxes: bubblewrap keeps no network but a bridge to the proxy\'s socket; Seatbelt allows one connection, to the proxy', () => {
  const a = bwrapArgs('npm ci', { root: '/w', network: 'allowlist', home: '/h', exists: () => false, proxy: { port: 41234, socket: '/tmp/hw-egress-abc/proxy.sock' }, node: '/usr/bin/node' });
  const s = a.join(' ');
  assert.match(s, /--unshare-net/, 'still no network of its own');
  assert.match(s, /--bind \/tmp\/hw-egress-abc \/tmp\/\.harness-egress/, 'the socket folder bound in');
  assert.ok(a.indexOf('/tmp/hw-egress-abc') > a.indexOf('/tmp'), 'after the /tmp mount, so it is not hidden by it');
  const tail = a.slice(a.indexOf('--') + 1);
  assert.equal(tail[0], '/usr/bin/node');
  assert.match(tail[1]!, /egress-bridge\.mjs$/);
  assert.deepEqual(tail.slice(2), ['/tmp/.harness-egress/proxy.sock', String(BWRAP_PROXY_PORT), 'bash', '-c', 'npm ci']);
  assert.throws(() => bwrapArgs('x', { root: '/w', network: 'allowlist', home: '/h', exists: () => false }), /needs the egress proxy's socket/);

  const p = seatbeltProfile({ root: '/w', network: 'allowlist', home: '/h', proxy: { port: 41234 } });
  assert.match(p, /\(deny network\*\)/);
  assert.match(p, /\(allow network-outbound \(remote ip "localhost:41234"\)\)/);
  assert.doesNotMatch(p, /remote ip "localhost:\*"|remote ip "\*/, 'nothing else on localhost (the harness itself) or beyond');
  assert.ok(p.indexOf('(deny network*)') < p.indexOf('localhost:41234'), 'the one exception comes after the deny');
  assert.throws(() => seatbeltProfile({ root: '/w', network: 'allowlist', home: '/h' }), /needs the egress proxy's port/);

  assert.equal(sandboxProxyOrigin('bwrap', { port: 41234 }), `http://127.0.0.1:${BWRAP_PROXY_PORT}`);
  assert.equal(sandboxProxyOrigin('seatbelt', { port: 41234 }), 'http://127.0.0.1:41234');
  const env = proxyEnv('http://127.0.0.1:41234');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:41234');
  assert.equal(env.https_proxy, 'http://127.0.0.1:41234');
  assert.equal(env.NODE_USE_ENV_PROXY, '1');
});

test('an allowlist OS sandbox points the credential variables at its local gateway', async () => {
  const { gatewayEnv, sandboxCredentials } = await import('../src/runtime/credentials.ts');
  const c = sandboxCredentials({ HARNESS_SANDBOX_CREDENTIALS: 'openai', OPENAI_API_KEY: 'k' }).credentials[0]!;
  assert.deepEqual(gatewayEnv(c, 'http://127.0.0.1:3128'), { OPENAI_BASE_URL: 'http://127.0.0.1:3128/__cred/openai/v1', OPENAI_API_KEY: c.env.OPENAI_API_KEY });
  // A local host without the OS sandbox has no proxy, and claims no credentials.
  const ws = await tempDir();
  assert.deepEqual(new LocalHost(ws).credentialEnv(), []);
  assert.throws(() => new LocalHost(ws, { sandbox: 'bwrap', network: 'allowlist' }), /needs a policy file/);
});

test('bubblewrap for real: an allowlist reaches only allowed hosts, through the local proxy, and the gateway adds keys outside', { skip: !hasBwrap && 'not Linux with a working bubblewrap' }, async () => {
  const http = await import('node:http');
  const target = http.createServer((req, res) => res.end(`${req.method} ${req.url} ${req.headers.authorization ?? '-'}`));
  await new Promise<void>((r) => target.listen(0, '0.0.0.0', r));
  const tport = (target.address() as { port: number }).port;
  // This machine's own address (not loopback: inside the sandbox 127.0.0.1 is its own, and NO_PROXY keeps it direct).
  const ip = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  assert.ok(ip, 'a network address to serve on');
  const ws = await tempDir();
  const policyFile = path.join(await tempDir(), 'allow.json');
  await fs.writeFile(policyFile, JSON.stringify({ hosts: [] }));
  const events: { host: string; allowed: boolean }[] = [];
  const host = new LocalHost(ws, {
    sandbox: 'bwrap', network: 'allowlist', policyFile, onEgress: (e) => events.push(e),
    credentials: [{ name: 'svc', upstream: `http://127.0.0.1:${tport}/api`, headers: { authorization: 'Bearer real-bwrap-key' }, env: { SVC_URL: 'http://egress:3128/__cred/svc', SVC_KEY: 'placeholder' }, allow: [{ methods: ['GET'] }], writes: false }],
  });
  const f = (url: string, extra = '', method = 'GET') => `${extra} node -e "fetch('${url}',{method:'${method}'}).then(async r=>console.log('STATUS',r.status,(await r.text()).slice(0,200))).catch(e=>console.log('ERR',e.cause?.code||e.cause?.message||e.message))"`;
  try {
    assert.equal(host.networkPolicy, 'allowlist');
    // What a client sees when it asks for a host that is not allowed (Node's env proxy tunnels even http://, so ask as it does).
    const probe = `node -e "const s=require('net').connect(3128,'127.0.0.1',()=>s.write('CONNECT ${ip}:${tport} HTTP/1.1\\r\\nHost: x\\r\\n\\r\\n'));s.once('data',d=>{console.log('PROXY',d.toString().split('\\r\\n')[0]);s.destroy()})"`;
    let r = await host.exec(probe, { timeoutMs: 30_000 });
    assert.match(r.stdout, /PROXY HTTP\/1\.1 403 Forbidden/, r.stdout + r.stderr);
    r = await host.exec(f(`http://${ip}:${tport}/x`), { timeoutMs: 30_000 });
    assert.match(r.stdout, /ERR /, 'fetch through the proxy fails for a blocked host');
    await new Promise((res) => setTimeout(res, 20));
    await fs.writeFile(policyFile, JSON.stringify({ hosts: [`${ip}:${tport}`] }));
    r = await host.exec(f(`http://${ip}:${tport}/x`), { timeoutMs: 30_000 });
    assert.match(r.stdout, /STATUS 200 GET \/x -/, r.stdout + r.stderr);
    // Around the proxy there is nothing: no route to the same address, and the sandbox's loopback is its own.
    r = await host.exec(f(`http://${ip}:${tport}/x`, 'NODE_USE_ENV_PROXY=0'), { timeoutMs: 30_000 });
    assert.match(r.stdout, /ERR (ENETUNREACH|EHOSTUNREACH|ECONNREFUSED)/, r.stdout + r.stderr);
    r = await host.exec(f(`http://127.0.0.1:${tport}/x`), { timeoutMs: 30_000 });
    assert.match(r.stdout, /ERR ECONNREFUSED/, r.stdout + r.stderr);
    r = await host.exec('node -e "require(\'net\').connect(53,\'1.1.1.1\').on(\'error\',e=>console.log(e.code)).on(\'connect\',()=>console.log(\'OPEN\'))"', { timeoutMs: 30_000 });
    assert.match(r.stdout, /ENETUNREACH|EACCES|ECONNREFUSED/, r.stdout);
    // The credential gateway at the sandbox's proxy address: the key is added outside; its rules hold.
    r = await host.exec(f("'+process.env.SVC_URL+'/v1/thing"), { timeoutMs: 30_000 });
    assert.match(r.stdout, /STATUS 200 GET \/api\/v1\/thing Bearer real-bwrap-key/, r.stdout + r.stderr);
    r = await host.exec(f("'+process.env.SVC_URL+'/v1/thing", '', 'POST'), { timeoutMs: 30_000 });
    assert.match(r.stdout, /STATUS 403 Blocked by the harness: the svc credential does not allow POST/, r.stdout + r.stderr);
    r = await host.exec('env; ls -A /tmp/.harness-egress', { timeoutMs: 30_000 });
    assert.ok(!r.stdout.includes('real-bwrap-key'), 'the key is not in the sandbox');
    assert.match(r.stdout, /SVC_URL=http:\/\/127\.0\.0\.1:3128\/__cred\/svc/);
    assert.match(r.stdout, /HTTPS_PROXY=http:\/\/127\.0\.0\.1:3128/);
    assert.match(r.stdout, /^proxy\.sock$/m);
    assert.ok(events.some((e) => !e.allowed) && events.some((e) => e.allowed), JSON.stringify(events));
    assert.deepEqual(host.credentialEnv(), [{ name: 'svc', vars: ['SVC_URL', 'SVC_KEY'], writes: false }]);
  } finally {
    await host.close();
    target.close();
  }
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
  // A plain workspace's git hooks and config stay read-only (the next git command a person runs would run them).
  execFileSync('git', ['init', '-q', ws]);
  const fresh = new LocalHost(ws, { sandbox: 'bwrap', network: 'none' });
  r = await fresh.exec('(echo x > .git/hooks/pre-commit && echo HOOK) 2>&1 | tail -1; (git config core.hooksPath /tmp && echo CONFIG) 2>&1 | tail -1; echo ok > tracked.txt && echo WRITE', { timeoutMs: 20_000 });
  assert.doesNotMatch(r.stdout, /HOOK\b|CONFIG\b/, r.stdout);
  assert.match(r.stdout, /WRITE/);
  // A daemon socket on the machine is hidden (made here as a plain file when the test may; masked, it reads as nothing or is refused).
  if (process.getuid?.() === 0) {
    await fs.writeFile('/run/docker.sock', 'daemon');
    try {
      r = await fresh.exec('cat /run/docker.sock /var/run/docker.sock 2>&1; echo END', { timeoutMs: 20_000 });
      assert.match(r.stdout, /END/, r.stderr);
      assert.doesNotMatch(r.stdout, /daemon/, 'the Docker socket is masked inside');
    } finally { await fs.rm('/run/docker.sock', { force: true }); }
  }
});

test('bubblewrap for real: a hidden folder reads as empty, a workspace inside it as itself', { skip: !hasBwrap && 'not Linux with a working bubblewrap' }, async () => {
  // Not under /tmp (the sandbox has its own /tmp, which would hide it anyway).
  const hidden = await fs.mkdtemp(path.join(os.homedir(), 'hw-hidden-'));
  try {
    await fs.mkdir(path.join(hidden, 'evals', 'pack', 'case'), { recursive: true });
    await fs.writeFile(path.join(hidden, 'evals', 'pack', 'case', 'acceptance.sh'), 'HIDDEN-CHECK');
    const ws = path.join(hidden, 'out', 'ws');
    await fs.mkdir(ws, { recursive: true });
    await fs.writeFile(path.join(ws, 'mine.txt'), 'MINE');
    const host = new LocalHost(ws, { sandbox: 'bwrap', network: 'none', hidden: [hidden] });
    const r = await host.exec(`cat ${hidden}/evals/pack/case/acceptance.sh 2>&1; ls -A ${hidden} | wc -l; cat mine.txt; echo new > made.txt && echo WROTE`, { timeoutMs: 20_000 });
    assert.doesNotMatch(r.stdout, /HIDDEN-CHECK/, r.stdout);
    assert.match(r.stdout, /MINE/, r.stdout + r.stderr);
    assert.match(r.stdout, /WROTE/);
    assert.equal(await fs.readFile(path.join(ws, 'made.txt'), 'utf8'), 'new\n');
  } finally { await fs.rm(hidden, { recursive: true, force: true }); }
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
  // A git worktree finds its packages in the main checkout's node_modules: mount that where Node looks last.
  const modules = path.resolve(fileURLToPath(import.meta.resolve('undici')), '..', '..');
  const extra = modules.startsWith(repo + path.sep) ? [] : ['-v', `${modules}:/node_modules:ro`];
  const r = spawnSync('docker', ['run', '--rm', '--privileged', '-v', `${repo}:/repo:ro`, ...extra, '-w', '/repo', 'harness-sandbox:latest', 'bash', '-c',
    'apt-get update -qq >/dev/null && apt-get install -y -qq bubblewrap >/dev/null && node --test --disable-warning=ExperimentalWarning --test-name-pattern="for real" test/os-sandbox.test.ts'], { encoding: 'utf8', timeout: 300_000 });
  const out = r.stdout + r.stderr;
  assert.match(out, /# pass 4\b/, out.slice(-3000));
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
