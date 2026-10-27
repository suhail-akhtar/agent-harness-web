// Quality gates, as any server loads it: every gate registered; the scan gates pass a clean workspace and
// fail one with a credential or merge-conflict markers; a stack's gates apply only where that stack is.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { loadPlugin } from '@harness/plugin-sdk/testing';
import { runGates } from '@harness/core/src/gates/gates.ts';
import { LocalHost } from '@harness/core/src/runtime/host.ts';

const dir = new URL('..', import.meta.url);

test('quality gates: registered; secrets and conflict markers found; a clean workspace passes', async () => {
  const kit = await loadPlugin(dir);
  try {
    assert.equal(kit.error, undefined);
    for (const g of ['node-test', 'node-typecheck', 'python-test', 'go-test', 'rust-test', 'java-test', 'secrets', 'conflict-markers', 'large-files']) assert.ok(kit.adds.gates.includes(g), g);
    const host = new LocalHost(kit.workspace);
    const run = async (names: string[] | 'applicable') => Object.fromEntries((await runGates(kit.harness.registry, host, names, new AbortController().signal)).map((g) => [g.name, g]));
    let r = await run(['secrets', 'conflict-markers']);
    assert.deepEqual([r.secrets!.pass, r['conflict-markers']!.pass], [true, true]);
    await fs.writeFile(path.join(kit.workspace, 'config.js'), `const key = "AKIA${'B'.repeat(16)}";\n<<<<<<< HEAD\n`);
    r = await run(['secrets', 'conflict-markers']);
    assert.deepEqual([r.secrets!.pass, r['conflict-markers']!.pass], [false, false]);
    // No package.json, go.mod or Cargo.toml here: those stacks' gates do not apply.
    const applicable = Object.keys(await run('applicable'));
    for (const g of ['node-test', 'go-test', 'rust-test']) assert.ok(!applicable.includes(g), `${g} does not apply`);
  } finally { await kit.close(); }
});
