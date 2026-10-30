import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LocalHost } from '../src/runtime/host.ts';
import { bashTool } from '../src/tools/exec.ts';
import { tempDir } from './helpers.ts';

const ctx = async () => ({ host: new LocalHost(await tempDir()), signal: new AbortController().signal } as never);

test('a command that leaves `&` children holding the pipes still returns', async () => {
  const t0 = Date.now();
  const r = await bashTool.run({ command: 'sleep 60 & echo started' }, await ctx());
  assert.ok(Date.now() - t0 < 10_000, `took ${Date.now() - t0}ms`);
  assert.match(r.content, /started/);
  assert.match(r.content, /run_in_background/);
});

test('a long command runs whole (Git Bash on Windows cuts `-c` off near 8K characters)', async () => {
  const host = new LocalHost(await tempDir());
  const r = await host.exec(`printf '${'x'.repeat(20_000)}' | wc -c`, { timeoutMs: 30_000 });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), '20000');
});

test('timeouts kill the command', async () => {
  const t0 = Date.now();
  const r = await bashTool.run({ command: 'sleep 30', timeout_ms: 1000 }, await ctx());
  assert.ok(Date.now() - t0 < 8000);
  assert.match(r.content, /Timed out/);
});

test('run_in_background returns at once and the process keeps running', async () => {
  const c = await ctx();
  const r = await bashTool.run({ command: 'echo ready; sleep 30', run_in_background: true }, c);
  assert.match(r.content, /pid \d+/);
  assert.match(r.content, /ready/);
  assert.match(r.content, /\[running\]/);
  const pid = /pid (\d+)/.exec(r.content)![1]!;
  await bashTool.run({ command: `kill ${pid}` }, c);
});

test('shell writes of file contents are steered to write/edit; ordinary commands are not', async () => {
  const { shellFileWrite } = await import('../src/tools/exec.ts');
  for (const c of [
    "cat > stats.js <<'EOF'\nx\nEOF",
    'cat <<EOF > a.py\nprint(1)\nEOF',
    'cat >> notes.md',
    "sed -i 's/a/b/' file.txt",
    'perl -pi -e s/a/b/ x.js',
    'echo hi | tee out.js',
    'npm test | tee -a README.md',
    "printf 'x' > src/app.ts",
    'echo "{}" > package.json',
  ]) assert.ok(shellFileWrite(c), c);
  for (const c of [
    'npm install', 'node test.js > /tmp/out.log 2>&1', 'cat stats.js', 'grep -n foo src/*.ts', 'echo done',
    'make build 2>&1 | tail -20', 'ls > /dev/null', 'cat a.txt | tee /dev/stderr', 'python -u e1.py | tee e1.log', 'node run.js 2>&1 | tee -a out.txt', 'git commit -m "update"', "sed -n '1,20p' file.txt",
  ]) assert.equal(shellFileWrite(c), undefined, c);
  const r = await bashTool.run({ command: "cat > x.js <<'EOF'\n1\nEOF" }, await ctx());
  assert.ok(r.is_error);
  assert.match(r.content, /Use the write tool/);
});
