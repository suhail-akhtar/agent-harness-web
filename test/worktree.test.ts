import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createHarness } from '../src/kernel/harness.ts';
import { dockerAvailable, imageExists } from '../src/runtime/docker.ts';
import { FakeProvider, results, tempDir } from './helpers.ts';

const hasDocker = (await dockerAvailable()) && (await imageExists('harness-sandbox:latest'));
const ID = 'GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t';
const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

async function repo() {
  const r = await tempDir();
  g(r, 'init', '-q', '-b', 'main');
  await fs.writeFile(path.join(r, 'app.txt'), 'v1\n');
  g(r, 'add', '-A'); g(r, 'commit', '-q', '-m', 'init');
  return r;
}

async function oneTurn(h: Awaited<ReturnType<typeof createHarness>>, runtime: object, command: string, title = 'fix bug') {
  h.registry.setProviderInstance('deepseek', new FakeProvider([{ calls: [{ name: 'bash', input: { command } }] }, { text: 'ok' }]));
  const s = await h.sessions.create({ title, model: 'deepseek-flash', mode: 'bypass', runtime: runtime as never, worktree: true });
  const done = new Promise<void>((r) => s.subscribe(0, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
  await s.send('go');
  await done;
  return { s, out: results(s.history[2])[0]!.content };
}

test('worktree sessions: parallel sessions on one repository, each on its own branch; the main checkout is untouched; an empty branch is cleaned up', async () => {
  const r = await repo();
  const h = await createHarness({ dataDir: await tempDir(), search: null, memory: 'off' });
  try {
    const a = await oneTurn(h, { kind: 'local', network: 'none', path: r }, `echo v2 > app.txt && ${ID} git commit -qam "change in a" && git log --oneline -1 && git branch --show-current`);
    const b = await oneTurn(h, { kind: 'local', network: 'none', path: r }, 'cat app.txt; git branch --show-current', 'look around');
    assert.match(a.out, /change in a\nharness\/fix-bug-[0-9a-f]{6}/);
    // (Git for Windows may check text out with CRLF.)
    assert.match(b.out, /v1\r?\nharness\/look-around-/, 'the second session sees its own checkout, not the first one\'s change');
    assert.notEqual(a.s.workspace, b.s.workspace);
    assert.equal(await fs.readFile(path.join(r, 'app.txt'), 'utf8'), 'v1\n', 'the user\'s checkout is untouched');
    assert.equal(g(r, 'branch', '--show-current'), 'main');
    const branchA = a.s.meta.runtime.worktree!.branch;
    const branchB = b.s.meta.runtime.worktree!.branch;
    await h.sessions.remove(a.s.meta.id);
    await h.sessions.remove(b.s.meta.id);
    assert.equal(g(r, 'log', '--format=%s', '-1', branchA), 'change in a', 'a branch with work stays for the user to merge');
    assert.equal(g(r, 'branch', '--list', branchB), '', 'a branch with nothing on it is removed');
    assert.equal(g(r, 'worktree', 'list').split('\n').length, 1, 'both worktrees are gone');
  } finally { await h.close(); }
});

test('a worktree in a Docker sandbox commits on its branch but cannot write the repository\'s hooks or config', { skip: !hasDocker && 'no docker or sandbox image' }, async () => {
  const r = await repo();
  const h = await createHarness({ dataDir: await tempDir(), search: null, memory: 'off' });
  try {
    const { s, out } = await oneTurn(h, { kind: 'local', network: 'none', path: r, sandbox: 'docker' },
      `echo v3 > app.txt && ${ID} git commit -qam "in docker" && git log --oneline -1; `
      + `(echo 'touch /tmp/pwned' > /repo.git/hooks/post-checkout && echo HOOK-WRITTEN) 2>&1 | tail -1; `
      + `(git config --file /repo.git/config core.hooksPath /workspace && echo CONFIG-WRITTEN) 2>&1 | tail -1; `
      + `(git update-ref refs/heads/main HEAD && echo MAIN-MOVED) 2>&1 | tail -1`);
    assert.match(out, /in docker/, out);
    assert.doesNotMatch(out, /HOOK-WRITTEN|CONFIG-WRITTEN|MAIN-MOVED/, out);
    assert.equal(g(r, 'log', '--format=%s', '-1', s.meta.runtime.worktree!.branch), 'in docker', 'the commit is in the repository on the session\'s branch');
    assert.equal(g(r, 'log', '--format=%s', '-1', 'main'), 'init');
    await assert.rejects(fs.stat(path.join(r, '.git', 'hooks', 'post-checkout')));
    await h.sessions.remove(s.meta.id);
  } finally { await h.close(); }
});
