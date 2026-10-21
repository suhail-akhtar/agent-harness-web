import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { DockerHost, dockerAvailable, imageExists, snapshotTag } from '../src/runtime/docker.ts';
import { run } from '../src/runtime/host.ts';
import { tempDir } from './helpers.ts';

const hasDocker = (await dockerAvailable()) && (await imageExists('harness-sandbox:latest'));

test('setup scripts: run as root with network, snapshotted, reused; the session starts from the result with its own policy', { skip: !hasDocker && 'no docker or sandbox image' }, async (t) => {
  // A system package (needs root and the network) and a file in the workspace.
  // (the package mirror can be slow or drop a request on a busy machine: up to three tries)
  const script = `for i in 1 2 3; do apt-get update -qq >/dev/null && apt-get install -y -qq cowsay >/dev/null && break; sleep 5; done && test -x /usr/games/cowsay && echo installed > /workspace/setup-ran.txt && echo SETUP-OK # ${Date.now()}`;
  const tag = snapshotTag('harness-sandbox:latest', script);
  t.after(() => run('docker', ['rmi', '-f', tag], { timeoutMs: 60_000 }));
  const opts = (logs: string[]) => ({ image: 'harness-sandbox:latest', network: 'none' as const, memory: '1g', cpus: '1', setup: { script, onLog: (l: string) => logs.push(l) } });
  const ws1 = await tempDir();
  const logs1: string[] = [];
  const a = new DockerHost(`s1${Date.now().toString(16)}`, ws1, opts(logs1));
  try {
    let r = await a.exec('/usr/games/cowsay moo | head -2; cat setup-ran.txt; echo more >> setup-ran.txt && echo WRITABLE; (getent hosts example.com || echo NO-NET)', { timeoutMs: 600_000 });
    assert.match(r.stdout, /moo/, r.stdout + r.stderr);
    assert.match(r.stdout, /installed/);
    assert.match(r.stdout, /WRITABLE/, 'the workspace is handed back to the session\'s user');
    assert.match(r.stdout, /NO-NET/, 'the session itself keeps its own network policy');
    assert.match(await fs.readFile(path.join(ws1, '.harness', 'setup.log'), 'utf8'), /SETUP-OK[\s\S]*exit 0/);
    assert.ok(logs1.some((l) => /no snapshot yet/.test(l)) && logs1.some((l) => /snapshot .* saved/.test(l)), logs1.join('\n'));
    assert.ok(await imageExists(tag));
    r = await a.exec('id -u', { timeoutMs: 30_000 });
    assert.notEqual(r.stdout.trim(), '0', 'the session does not run as root');
  } finally { await a.close(); }
  // A second session with the same script starts from the snapshot.
  const logs2: string[] = [];
  const b = new DockerHost(`s2${Date.now().toString(16)}`, await tempDir(), opts(logs2));
  try {
    const r = await b.exec('/usr/games/cowsay again | head -2', { timeoutMs: 600_000 });
    assert.match(r.stdout, /again/);
    assert.ok(logs2.some((l) => /starting from the snapshot/.test(l)), logs2.join('\n'));
  } finally { await b.close(); }
});

test('a failing setup script does not stop the session: it starts from the base image and the log says why', { skip: !hasDocker && 'no docker or sandbox image' }, async () => {
  const ws = await tempDir();
  const logs: string[] = [];
  const h = new DockerHost(`s3${Date.now().toString(16)}`, ws, { image: 'harness-sandbox:latest', network: 'none', memory: '512m', cpus: '1', setup: { script: 'echo trying; exit 3', onLog: (l) => logs.push(l) } });
  try {
    const r = await h.exec('echo alive', { timeoutMs: 120_000 });
    assert.equal(r.stdout.trim(), 'alive');
    assert.ok(logs.some((l) => /script failed \(exit 3\)/.test(l)), logs.join('\n'));
    assert.match(await fs.readFile(path.join(ws, '.harness', 'setup.log'), 'utf8'), /trying[\s\S]*exit 3/);
    assert.equal(h.setupResult?.ok, false);
  } finally { await h.close(); }
});

test('the setup log never goes through a link planted in the workspace, and snapshots are kept per account and repository', { skip: !hasDocker && 'no docker or sandbox image' }, async () => {
  assert.notEqual(snapshotTag('img', 'npm ci', 'alice\n/repo/a'), snapshotTag('img', 'npm ci', 'bob\n/repo/a'), 'another account never starts from this snapshot');
  assert.notEqual(snapshotTag('img', 'npm ci', 'alice\n/repo/a'), snapshotTag('img', 'npm ci', 'alice\n/repo/b'));
  const ws = await tempDir();
  const outside = await tempDir();
  await fs.writeFile(path.join(outside, 'setup.log'), 'server file');
  // .harness is a link to a folder outside (a junction on Windows, which needs no privileges).
  await fs.symlink(outside, path.join(ws, '.harness'), 'junction');
  const h = new DockerHost(`s4${Date.now().toString(16)}`, ws, { image: 'harness-sandbox:latest', network: 'none', memory: '512m', cpus: '1', setup: { script: 'echo LINK-TEST; exit 3' } });
  try {
    await h.exec('true', { timeoutMs: 120_000 });
    assert.equal(await fs.readFile(path.join(outside, 'setup.log'), 'utf8'), 'server file', 'the file outside is untouched');
    assert.match(await fs.readFile(path.join(ws, '.harness', 'setup.log'), 'utf8').catch(() => ''), /LINK-TEST[\s\S]*exit 3/, 'the log is in the workspace\'s own .harness');
  } finally { await h.close(); }
});
