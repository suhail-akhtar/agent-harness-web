import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { githubRepo, publish, publishTarget, validBranch } from '../src/git/publish.ts';
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
  const r = await publish({ workspace: ws, input: { branch: 'feature/one', title: 'One', commitMessage: 'Add app' }, cfg: { repos: [remote] }, commit: commitIn(ws) });
  assert.equal(r.branch, 'feature/one');
  assert.equal(r.pullRequest, undefined, 'not a GitHub repository: pushed, no pull request');
  assert.equal(g(remote, 'log', '--format=%s', 'feature/one', '-1'), 'Add app');
  assert.equal(g(remote, 'rev-parse', 'feature/one'), r.commit);
  await assert.rejects(publish({ workspace: ws, input: { branch: 'main', title: 'x' }, cfg: { repos: [remote] } }), /it is the base branch/);
  // Someone else moved the branch: no overwrite.
  const other = path.join(await tempDir(), 'other');
  g(path.dirname(other), 'clone', '-q', '-b', 'feature/one', remote, other);
  await fs.writeFile(path.join(other, 'b.txt'), 'b');
  g(other, 'add', '-A'); g(other, 'commit', '-q', '-m', 'theirs'); g(other, 'push', '-q', 'origin', 'feature/one');
  await fs.writeFile(path.join(ws, 'c.txt'), 'c');
  await assert.rejects(publish({ workspace: ws, input: { branch: 'feature/one', title: 'x', commitMessage: 'mine' }, cfg: { repos: [remote] }, commit: commitIn(ws) }), /never overwritten. Publish to a new branch name/);
  assert.equal(g(remote, 'log', '--format=%s', 'feature/one', '-1'), 'theirs');
});

test('publish: nothing in the workspace\'s git config runs or redirects the push', async () => {
  const { remote, ws } = await repos();
  const marker = path.join(await tempDir(), 'pwned');
  const evil = path.join(await tempDir(), 'evil.git');
  execFileSync('git', ['init', '-q', '--bare', evil]);
  // Hooks, fsmonitor and a URL rewrite planted by whatever ran in the workspace.
  await fs.appendFile(path.join(ws, '.git', 'config'), `[core]\n\tfsmonitor = "touch ${marker}-fsmonitor"\n\thooksPath = .githooks\n[url "${evil}"]\n\tinsteadOf = ${remote}\n`);
  await fs.mkdir(path.join(ws, '.githooks'));
  for (const h of ['pre-push', 'post-checkout', 'reference-transaction', 'pre-auto-gc']) await fs.writeFile(path.join(ws, '.githooks', h), `#!/bin/sh\ntouch ${marker}-${h}\n`, { mode: 0o755 });
  await fs.writeFile(path.join(ws, 'x.txt'), 'x');
  g(ws, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=', 'add', '-A');
  g(ws, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=', 'commit', '-q', '-m', 'x');
  await publish({ workspace: ws, input: { branch: 'safe', title: 't' }, cfg: { repos: [remote] } });
  assert.deepEqual((await fs.readdir(path.dirname(marker))).filter((f) => f.startsWith('pwned')), []);
  assert.equal(g(remote, 'log', '--format=%s', 'safe', '-1'), 'x', 'pushed to the real target');
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
    const r = await publish({ workspace: ws, sessionGitUrl: 'https://github.com/acme/shop', input: { branch: 'feat', title: 'Feature', body: 'Tested.', draft: true, commitMessage: 'feat' }, cfg, commit: commitIn(ws) });
    assert.deepEqual(r.pullRequest, { number: 7, url: 'https://github.com/acme/shop/pull/7' });
    assert.equal(r.pushedTo, 'acme/shop');
    assert.equal(calls[0]!.url, '/repos/acme/shop/pulls');
    assert.deepEqual(calls[0]!.body, { title: 'Feature', head: 'feat', base: 'main', body: 'Tested.', draft: true });
    assert.equal(calls[0]!.auth, 'Bearer ghs_test_token');
    assert.doesNotMatch(await fs.readFile(path.join(ws, '.git', 'config'), 'utf8'), /ghs_test_token|extraHeader/i, 'the token never lands in the workspace');
    // A second publish of the same branch finds the open pull request.
    existing = true;
    await fs.writeFile(path.join(ws, 'g.txt'), 'g');
    const again = await publish({ workspace: ws, sessionGitUrl: 'https://github.com/acme/shop', input: { branch: 'feat', title: 'Feature', commitMessage: 'more' }, cfg, commit: commitIn(ws) });
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
