import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { cloneRepository, githubRepo, mayCloneWithToken, prefixedBranch, publish, publishPolicy, publishTarget, tokenMayGoTo, validBranch } from '../src/git/publish.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { publishTool } from '../src/tools/publish.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { FakeProvider, tempDir } from './helpers.ts';

const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

/** A bare "remote" with main, and a clone of it to work in. */
async function repos() {
  const remote = path.join(await tempDir(), 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const seed = await tempDir();
  g(seed, 'init', '-q', '-b', 'main');
  await fs.writeFile(path.join(seed, 'README.md'), '# shop\n');
  g(seed, 'add', '-A'); g(seed, 'commit', '-q', '-m', 'init'); g(seed, 'push', '-q', remote, 'main');
  const ws = path.join(await tempDir(), 'ws');
  g(path.dirname(ws), 'clone', '-q', remote, ws);
  return { remote, ws };
}

const commitIn = (ws: string) => async (msg: string, a: { name: string; email: string }) => { g(ws, 'add', '-A'); g(ws, '-c', `user.name=${a.name}`, '-c', `user.email=${a.email}`, 'commit', '-q', '-m', msg); };

test('GitHub remotes in every form; branch names; publishing only where the session may', () => {
  for (const r of ['https://github.com/acme/shop', 'https://github.com/acme/shop.git', 'git@github.com:acme/shop.git', 'https://tok@github.com/acme/shop/']) assert.deepEqual(githubRepo(r), { owner: 'acme', name: 'shop', url: 'https://github.com/acme/shop.git' }, r);
  assert.equal(githubRepo('https://gitlab.com/acme/shop'), undefined);
  for (const b of ['fix/login', 'agent/2026-10-20-ab12', 'v1.2']) assert.ok(validBranch(b), b);
  for (const b of ['', '-x', 'a..b', 'a//b', 'x.lock', 'a b', 'refs/@{x}', 'a/']) assert.ok(!validBranch(b), b);
  assert.equal(publishTarget('https://github.com/acme/shop', undefined, {}).url, 'https://github.com/acme/shop.git');
  assert.equal(publishTarget(undefined, 'acme/tools', { repos: ['acme/tools'] }).name, 'tools');
  assert.throws(() => publishTarget('https://github.com/acme/shop', 'https://github.com/evil/repo', {}), /not a repository this session may publish to/);
  assert.throws(() => publishTarget(undefined, undefined, {}), /no repository to publish to/);
});

test('publish: commits, copies out of the workspace and pushes a new branch; never the base branch, never force', async () => {
  const { remote, ws } = await repos();
  await fs.writeFile(path.join(ws, 'app.js'), 'console.log(1)\n');
  const ledger = path.join(await tempDir(), 'published-branches.json');
  const r = await publish({ workspace: ws, input: { branch: 'agent/feature-one', title: 'One', commitMessage: 'Add app' }, cfg: { repos: [remote] }, commit: commitIn(ws), ledger });
  assert.equal(r.branch, 'agent/feature-one');
  assert.equal(r.pullRequest, undefined, 'not a GitHub repository: pushed, no pull request');
  assert.equal(g(remote, 'log', '--format=%s', 'agent/feature-one', '-1'), 'Add app');
  assert.equal(g(remote, 'rev-parse', 'agent/feature-one'), r.commit);
  // (With no prefix, which the operator can choose, the base branch is still refused.)
  await assert.rejects(publish({ workspace: ws, input: { branch: 'main', title: 'x' }, cfg: { repos: [remote], branchPrefix: '' } }), /it is the base branch/);
  // Someone else moved the branch (this session's own): no overwrite.
  const other = path.join(await tempDir(), 'other');
  g(path.dirname(other), 'clone', '-q', '-b', 'agent/feature-one', remote, other);
  await fs.writeFile(path.join(other, 'b.txt'), 'b');
  g(other, 'add', '-A'); g(other, 'commit', '-q', '-m', 'theirs'); g(other, 'push', '-q', 'origin', 'agent/feature-one');
  await fs.writeFile(path.join(ws, 'c.txt'), 'c');
  await assert.rejects(publish({ workspace: ws, input: { branch: 'agent/feature-one', title: 'x', commitMessage: 'mine' }, cfg: { repos: [remote] }, commit: commitIn(ws), ledger }), /never overwritten. Publish to a new branch name/);
  assert.equal(g(remote, 'log', '--format=%s', 'agent/feature-one', '-1'), 'theirs');
});

test('least-privilege publish: only under the prefix, never a branch this session did not make, drafts unless the operator allows ready ones', async () => {
  assert.equal(prefixedBranch('fix/login', 'agent/'), 'agent/fix/login');
  assert.equal(prefixedBranch('agent/fix', 'agent/'), 'agent/fix');
  assert.equal(prefixedBranch('main', ''), 'main');
  assert.deepEqual(publishPolicy({}, {}), { prefix: 'agent/', allowUpdate: false, allowReady: false, cloneRepos: [] });
  assert.deepEqual(publishPolicy({ repos: ['acme/a'] }, { HARNESS_PUBLISH_PREFIX: 'bot/', HARNESS_PUBLISH_UPDATE: '1', HARNESS_PUBLISH_READY: '1', HARNESS_CLONE_REPOS: 'acme/private, acme/*' }), { prefix: 'bot/', allowUpdate: true, allowReady: true, cloneRepos: ['acme/private', 'acme/*', 'acme/a'] });

  const { remote, ws } = await repos();
  const ledger = path.join(await tempDir(), 'published-branches.json');
  // "main" asked for: the agent gets agent/main, and the base branch is untouched.
  await fs.writeFile(path.join(ws, 'a.txt'), 'a');
  const r = await publish({ workspace: ws, input: { branch: 'main', title: 't', commitMessage: 'a' }, cfg: { repos: [remote] }, commit: commitIn(ws), ledger });
  assert.equal(r.branch, 'agent/main');
  assert.match(r.note ?? '', /published under agent\//);
  assert.equal(g(remote, 'log', '--format=%s', 'main', '-1'), 'init', 'main is untouched');
  // A branch someone else made (even under the prefix) is not pushed to...
  g(remote, 'branch', 'agent/theirs', 'main');
  await fs.writeFile(path.join(ws, 'b.txt'), 'b');
  g(ws, 'add', '-A'); g(ws, 'commit', '-q', '-m', 'b');
  await assert.rejects(publish({ workspace: ws, input: { branch: 'agent/theirs', title: 't' }, cfg: { repos: [remote] }, ledger }), /already exists and this session did not create it.*HARNESS_PUBLISH_UPDATE=1/);
  assert.equal(g(remote, 'log', '--format=%s', 'agent/theirs', '-1'), 'init');
  // ...unless the operator allows updates; and this session's own branch is updated.
  await publish({ workspace: ws, input: { branch: 'agent/theirs', title: 't' }, cfg: { repos: [remote], allowUpdate: true }, ledger });
  assert.equal(g(remote, 'log', '--format=%s', 'agent/theirs', '-1'), 'b');
  await publish({ workspace: ws, input: { branch: 'main', title: 't' }, cfg: { repos: [remote] }, ledger });
  assert.equal(g(remote, 'log', '--format=%s', 'agent/main', '-1'), 'b', 'its own branch, pushed again');
  // Another session (another ledger) may not push to it.
  await fs.writeFile(path.join(ws, 'c.txt'), 'c');
  g(ws, 'add', '-A'); g(ws, 'commit', '-q', '-m', 'c');
  await assert.rejects(publish({ workspace: ws, input: { branch: 'agent/main', title: 't' }, cfg: { repos: [remote] }, ledger: path.join(await tempDir(), 'other.json') }), /did not create it/);
});

test('least-privilege publish: pull requests are drafts unless the operator allows ready ones', async () => {
  const bodies: Record<string, unknown>[] = [];
  const api = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { bodies.push(JSON.parse(b)); res.writeHead(201); res.end(JSON.stringify({ number: bodies.length, html_url: `https://github.com/acme/shop/pull/${bodies.length}` })); });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  const prev = process.env.NO_PROXY;
  process.env.NO_PROXY = '127.0.0.1';
  try {
    const { remote, ws } = await repos();
    const cfg = { token: 'ghs_test', apiBase: `http://127.0.0.1:${(api.address() as { port: number }).port}`, rewrite: { 'https://github.com/acme/shop.git': remote } };
    const go = async (branch: string, draft: boolean | undefined, extra: Record<string, unknown> = {}) => {
      await fs.writeFile(path.join(ws, `${branch}.txt`), branch);
      return publish({ workspace: ws, sessionGitUrl: 'https://github.com/acme/shop', input: { branch, title: 'T', commitMessage: branch, ...(draft === undefined ? {} : { draft }) }, cfg: { ...cfg, ...extra }, commit: commitIn(ws) });
    };
    await go('one', undefined);
    const asked = await go('two', false);
    assert.match(asked.note ?? '', /is a draft: this server opens only drafts.*HARNESS_PUBLISH_READY=1/);
    await go('three', false, { allowReady: true });
    await go('four', undefined, { allowReady: true });
    assert.deepEqual(bodies.map((b) => [b.head, b.draft]), [['agent/one', true], ['agent/two', true], ['agent/three', false], ['agent/four', true]]);
  } finally {
    api.close();
    if (prev === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = prev;
  }
});

/** A git smart-HTTP server (git http-backend) that wants the token as GitHub does: Basic x-access-token. */
async function gitHttpServer(root: string, token: string) {
  const seen: (string | undefined)[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    if (req.headers.authorization !== `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="git"' });
      return res.end();
    }
    const u = new URL(req.url!, 'http://x');
    const cgi = spawn('git', ['http-backend'], { env: { ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: u.pathname, QUERY_STRING: u.search.slice(1), REQUEST_METHOD: req.method!, CONTENT_TYPE: req.headers['content-type'] ?? '', HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '', REMOTE_ADDR: '127.0.0.1', REMOTE_USER: 'x-access-token' } });
    req.pipe(cgi.stdin);
    const out: Buffer[] = [];
    cgi.stdout.on('data', (d: Buffer) => out.push(d));
    cgi.on('close', () => {
      const all = Buffer.concat(out);
      const sep = all.indexOf('\r\n\r\n');
      const head = all.subarray(0, sep).toString().split('\r\n');
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of head) { const i = line.indexOf(':'); const k = line.slice(0, i).trim(); const v = line.slice(i + 1).trim(); if (/^status$/i.test(k)) status = Number(v.split(' ')[0]); else headers[k] = v; }
      res.writeHead(status, headers);
      res.end(all.subarray(sep + 4));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, close: () => server.close() };
}

test('cloning a private repository: the publish token goes in a header for that one command, only for repositories the operator lists, and is never stored', async () => {
  const { remote } = await repos();
  const root = path.dirname(remote);
  const srv = await gitHttpServer(root, 'ghs_clone_token');
  const prev = process.env.NO_PROXY;
  process.env.NO_PROXY = '127.0.0.1';
  try {
    const url = `${srv.url}/remote.git`;
    const cfg = { token: 'ghs_clone_token', tokenHosts: ['127.0.0.1'] };
    assert.ok(mayCloneWithToken('https://github.com/acme/shop', { cloneRepos: ['acme/*'] }, {}));
    assert.ok(!mayCloneWithToken('https://github.com/acme2/shop', { cloneRepos: ['acme/*'] }, {}));
    assert.ok(mayCloneWithToken('https://github.com/acme/shop.git', {}, { HARNESS_CLONE_REPOS: 'acme/shop' }));
    assert.ok(mayCloneWithToken('https://github.com/acme/shop', { repos: ['https://github.com/acme/shop'] }, {}), 'a publish repository may be cloned too');
    // Not listed: cloned without the token, so a private repository fails, with a hint.
    await assert.rejects(cloneRepository(url, path.join(await tempDir(), 'a'), cfg, { env: {} }), /git clone failed.*HARNESS_CLONE_REPOS/s);
    assert.deepEqual(srv.seen.filter(Boolean), [], 'the token was not sent');
    // Listed: cloned with it.
    const dest = path.join(await tempDir(), 'b');
    const r = await cloneRepository(url, dest, { ...cfg, cloneRepos: [url] }, { env: {} });
    assert.equal(r.withToken, true);
    assert.equal(await fs.readFile(path.join(dest, 'README.md'), 'utf8'), '# shop\n');
    const config = await fs.readFile(path.join(dest, '.git', 'config'), 'utf8');
    assert.doesNotMatch(config, /ghs_clone_token|extraHeader|eC1hY2Nlc3MtdG9rZW46/i, 'the token is nowhere in the clone');
    assert.match(config, new RegExp(`url = ${url.replace(/[.:/]/g, '\\$&')}`), 'the remote is the plain URL');
    // Listed, but the host is not one the token may go to: not sent.
    srv.seen.length = 0;
    await assert.rejects(cloneRepository(url, path.join(await tempDir(), 'c'), { token: 'ghs_clone_token', cloneRepos: [url] }, { env: {} }), /git clone failed/);
    assert.deepEqual(srv.seen.filter(Boolean), []);
  } finally {
    srv.close();
    if (prev === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = prev;
  }
});

test('publish: nothing in the workspace\'s git config runs or redirects the push', async () => {
  const { remote, ws } = await repos();
  const marker = path.join(await tempDir(), 'pwned');
  const evil = path.join(await tempDir(), 'evil.git');
  execFileSync('git', ['init', '-q', '--bare', evil]);
  // Hooks, fsmonitor and a URL rewrite planted by whatever ran in the workspace.
  // Backslashes (Windows paths) are escapes in git config values and in sh.
  const cfgq = (s: string) => `"${s.replace(/\\/g, '\\\\')}"`;
  const shPath = marker.replace(/\\/g, '/');
  await fs.appendFile(path.join(ws, '.git', 'config'), `[core]\n\tfsmonitor = ${cfgq(`touch ${shPath}-fsmonitor`)}\n\thooksPath = .githooks\n[url ${cfgq(evil)}]\n\tinsteadOf = ${cfgq(remote)}\n`);
  await fs.mkdir(path.join(ws, '.githooks'));
  for (const h of ['pre-push', 'post-checkout', 'reference-transaction', 'pre-auto-gc']) await fs.writeFile(path.join(ws, '.githooks', h), `#!/bin/sh\ntouch ${shPath}-${h}\n`, { mode: 0o755 });
  await fs.writeFile(path.join(ws, 'x.txt'), 'x');
  g(ws, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=', 'add', '-A');
  g(ws, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=', 'commit', '-q', '-m', 'x');
  await publish({ workspace: ws, input: { branch: 'safe', title: 't' }, cfg: { repos: [remote] } });
  assert.deepEqual((await fs.readdir(path.dirname(marker))).filter((f) => f.startsWith('pwned')), []);
  assert.equal(g(remote, 'log', '--format=%s', 'agent/safe', '-1'), 'x', 'pushed to the real target');
  assert.equal(execFileSync('git', ['-C', evil, 'branch', '--list']).toString().trim(), '', 'not to the planted one');
});

test('publish: the pull request through the GitHub API, with the token only in headers', async () => {
  const { remote, ws } = await repos();
  const calls: { method: string; url: string; auth?: string; body?: Record<string, unknown> }[] = [];
  let existing = false;
  const api = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      calls.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body: b ? JSON.parse(b) : undefined });
      if (req.method === 'POST' && existing) { res.writeHead(422); return res.end(JSON.stringify({ message: 'Validation Failed', errors: [{ message: 'A pull request already exists for acme:feat.' }] })); }
      if (req.method === 'GET') return res.end(JSON.stringify([{ number: 7, html_url: 'https://github.com/acme/shop/pull/7' }]));
      res.writeHead(201); res.end(JSON.stringify({ number: 7, html_url: 'https://github.com/acme/shop/pull/7' }));
    });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  const prev = process.env.NO_PROXY;
  process.env.NO_PROXY = '127.0.0.1';
  try {
    const cfg = { token: 'ghs_test_token', apiBase: `http://127.0.0.1:${(api.address() as { port: number }).port}`, rewrite: { 'https://github.com/acme/shop.git': remote } };
    await fs.writeFile(path.join(ws, 'f.txt'), 'f');
    const ledger = path.join(await tempDir(), 'published-branches.json');
    const r = await publish({ workspace: ws, sessionGitUrl: 'https://github.com/acme/shop', input: { branch: 'agent/feat', title: 'Feature', body: 'Tested.', draft: true, commitMessage: 'feat' }, cfg, commit: commitIn(ws), ledger });
    assert.deepEqual(r.pullRequest, { number: 7, url: 'https://github.com/acme/shop/pull/7' });
    assert.equal(r.pushedTo, 'acme/shop');
    assert.equal(calls[0]!.url, '/repos/acme/shop/pulls');
    assert.deepEqual(calls[0]!.body, { title: 'Feature', head: 'agent/feat', base: 'main', body: 'Tested.', draft: true });
    assert.equal(calls[0]!.auth, 'Bearer ghs_test_token');
    assert.doesNotMatch(await fs.readFile(path.join(ws, '.git', 'config'), 'utf8'), /ghs_test_token|extraHeader/i, 'the token never lands in the workspace');
    // A second publish of the same branch finds the open pull request.
    existing = true;
    await fs.writeFile(path.join(ws, 'g.txt'), 'g');
    const again = await publish({ workspace: ws, sessionGitUrl: 'https://github.com/acme/shop', input: { branch: 'agent/feat', title: 'Feature', commitMessage: 'more' }, cfg, commit: commitIn(ws), ledger });
    assert.match(again.note ?? '', /already had an open pull request/);
  } finally {
    api.close();
    if (prev === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = prev;
  }
});

test('publish_branch is offered only to sessions that can publish, and commits in the session\'s runtime', async () => {
  const { remote, ws } = await repos();
  const h = await createHarness({ dataDir: await tempDir(), search: null, publish: { repos: [remote] } });
  const fake = new FakeProvider([
    { calls: [{ name: 'publish_branch', input: { branch: 'agent/x', title: 'X', commit_message: 'Add notes' } }] },
    { text: 'done' },
  ]);
  h.registry.setProviderInstance('deepseek', fake);
  await fs.writeFile(path.join(ws, 'notes.md'), 'n');
  const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws } });
  const done = new Promise<void>((r) => s.subscribe(0, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
  await s.send('publish it');
  await done;
  assert.ok(fake.requests[0]!.tools.some((t) => t.name === 'publish_branch'));
  assert.match(fake.snapshots[1]!, /Pushed agent\/x/);
  assert.equal(g(remote, 'log', '--format=%s', 'agent/x', '-1'), 'Add notes');
  await h.close();
  const off = await createHarness({ dataDir: await tempDir(), search: null, publish: null });
  const fake2 = new FakeProvider([{ text: 'hi' }]);
  off.registry.setProviderInstance('deepseek', fake2);
  const s2 = await off.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws } });
  const d2 = new Promise<void>((r) => s2.subscribe(0, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
  await s2.send('hi');
  await d2;
  assert.ok(!fake2.requests[0]!.tools.some((t) => t.name === 'publish_branch'));
  await off.close();
  const r = await publishTool.run({ branch: 'b', title: 't' }, { services: {} } as unknown as ToolContext);
  assert.match(r.content, /not available/);
});

test('publish: the token goes only to GitHub (or the operator\'s Enterprise host), never to a session\'s own git URL', async () => {
  assert.ok(tokenMayGoTo('https://github.com/acme/shop.git', {}));
  assert.ok(!tokenMayGoTo('https://evil.example/acme/shop.git', {}));
  assert.ok(!tokenMayGoTo('https://github.com.evil.example/a/b.git', {}));
  assert.ok(tokenMayGoTo('https://ghe.corp/a/b.git', { apiBase: 'https://ghe.corp/api/v3' }));
  assert.ok(tokenMayGoTo('https://git.corp/a/b.git', { tokenHosts: ['git.corp'] }));
  const { ws } = await repos();
  await fs.writeFile(path.join(ws, 'x.txt'), 'x');
  g(ws, 'add', '-A'); g(ws, 'commit', '-q', '-m', 'x');
  const seen: (string | undefined)[] = [];
  const evil = http.createServer((req, res) => { seen.push(req.headers.authorization); res.writeHead(401, { 'www-authenticate': 'Basic realm="x"' }); res.end(); });
  await new Promise<void>((r) => evil.listen(0, '127.0.0.1', r));
  const prev = process.env.NO_PROXY;
  process.env.NO_PROXY = '127.0.0.1';
  try {
    const url = `http://127.0.0.1:${(evil.address() as { port: number }).port}/acme/shop.git`;
    await assert.rejects(publish({ workspace: ws, sessionGitUrl: url, input: { branch: 'b', title: 't' }, cfg: { token: 'ghs_secret_token' } }), /Cannot reach/);
    assert.ok(seen.length > 0, 'git did talk to the server');
    assert.deepEqual(seen.filter(Boolean), [], 'and never sent it the token');
  } finally {
    evil.close();
    if (prev === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = prev;
  }
});

test('publish: a .git that is a link, a gitfile or borrows another repository is refused', async () => {
  const { remote, ws } = await repos();
  const elsewhere = path.join(await tempDir(), 'server-repo');
  await fs.rename(path.join(ws, '.git'), elsewhere);
  await fs.symlink(elsewhere, path.join(ws, '.git'));
  await assert.rejects(publish({ workspace: ws, input: { branch: 'b', title: 't' }, cfg: { repos: [remote] } }), /not a plain folder/);
  await fs.rm(path.join(ws, '.git'));
  await fs.writeFile(path.join(ws, '.git'), `gitdir: ${elsewhere}\n`);
  await assert.rejects(publish({ workspace: ws, input: { branch: 'b', title: 't' }, cfg: { repos: [remote] } }), /not a plain folder/);
  await fs.rm(path.join(ws, '.git'));
  await fs.rename(elsewhere, path.join(ws, '.git'));
  await fs.writeFile(path.join(ws, '.git', 'objects', 'info', 'alternates'), `${elsewhere}/objects\n`);
  await assert.rejects(publish({ workspace: ws, input: { branch: 'b', title: 't' }, cfg: { repos: [remote] } }), /points at another repository/);
});

test('publish: links inside .git (objects, refs, HEAD) that could reach another repository are refused', async () => {
  const other = await repos();
  for (const entry of ['objects', path.join('refs', 'heads'), 'HEAD', 'packed-refs']) {
    const { remote, ws } = await repos();
    const target = path.join(other.ws, '.git', entry);
    await fs.rm(path.join(ws, '.git', entry), { recursive: true, force: true });
    if (entry === 'packed-refs') await fs.writeFile(path.join(other.ws, '.git', 'packed-refs'), '');
    await fs.symlink(target, path.join(ws, '.git', entry), (await fs.stat(target)).isDirectory() ? 'dir' : 'file');
    await assert.rejects(publish({ workspace: ws, input: { branch: 'b', title: 't' }, cfg: { repos: [remote] } }), /has a link/, entry);
  }
});

test('publish from a sandbox: .git is moved out of reach for the fetch and always put back', async () => {
  const { remote, ws } = await repos();
  await fs.writeFile(path.join(ws, 'a.txt'), 'a');
  const r = await publish({ workspace: ws, input: { branch: 'agent/sandboxed', title: 't', commitMessage: 'Add a' }, cfg: { repos: [remote] }, commit: commitIn(ws), isolate: true });
  assert.equal(g(remote, 'rev-parse', 'agent/sandboxed'), r.commit);
  assert.equal(g(ws, 'log', '--format=%s', '-1'), 'Add a', '.git is back where it was');
  assert.deepEqual((await fs.readdir(path.dirname(ws))).filter((f) => f.startsWith('.publish-')), [], 'nothing left beside the workspace');
  // A failing fetch (HEAD names no commit) puts it back too.
  await fs.writeFile(path.join(ws, '.git', 'HEAD'), 'ref: refs/heads/nothing-here\n');
  await assert.rejects(publish({ workspace: ws, input: { branch: 'x', title: 't' }, cfg: { repos: [remote] }, isolate: true }), /fetch failed/);
  assert.ok((await fs.stat(path.join(ws, '.git'))).isDirectory());
});
