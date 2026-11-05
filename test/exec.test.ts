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

test('the shell-write guard reads shell words, not text', async () => {
  const { shellFileWrite } = await import('../src/tools/exec.ts');
  for (const c of [
    'echo x | tee a.log b.py', 'echo x | tee --append notes.md', 'echo x | tee -a -i app.py', 'echo x | tee -- notes.md', 'echo x | tee "src/my app.ts"', 'echo x | tee Dockerfile',
    "sed -E -i 's/a/b/' f.txt", "sed -e 's/a/b/' -i f.txt", "perl -0pi -e 's/a/b/' f.txt", "awk -i inplace '{print}' f.txt", 'echo x > .env', 'echo x >> .gitignore', '{ echo a; echo b; } > a.py', ': > src/core.py',
    `python -c "open('src/a.py','w').write('x')"`, `node -e "require('fs').writeFileSync('src/a.js','x')"`, 'base64 -d <<< eD0x > a.py',
  ]) assert.ok(shellFileWrite(c), c);
  for (const c of [
    './build.sh 2>&1 | tee build.sh.log', 'python train.py | tee logs/train.py.out', 'node app.js 2>&1 | tee -a app.js.log', 'echo ok > build.sh.log', 'echo "compiled a.ts -> a.js"', 'echo "see docs => guide.md"',
    'git commit -m "use tee README.md and sed -i here"', 'grep -rn "sed -i" scripts/', "sed -i 's/a/b/' /tmp/scratch.txt", 'echo building\nnode build.js > dist/bundle.js', 'python - <<EOF > results.txt\nprint(1)\nEOF', 'wc -l <<< hello > count.txt',
    "cat <<'EOF' | python -\nprint('tee README.md')\nEOF",
  ]) assert.equal(shellFileWrite(c), undefined, c);
});

test('a timed-out command says what to do, and a kill of ours is not reported as something left running', async () => {
  const r = await bashTool.run({ command: 'sleep 30', timeout_ms: 1000 }, await ctx());
  assert.ok(r.is_error);
  assert.match(r.content, /Timed out after 1s \(the command was killed\)\. For something longer, pass timeout_ms/);
  assert.doesNotMatch(r.content, /left running in the background/);
});
