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
