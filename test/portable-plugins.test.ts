// The solutions are portable: no module of theirs reaches outside its own folder by relative path (the
// harness's abilities come from @harness/plugin-sdk/runtime, other plugins' modules by name from
// @harness/plugins/<name>/...), so each runs wherever it is installed: packed, unpacked into another
// server's install folder, and loaded there; an engine of Studio finds Studio's installed copy.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createHarness } from '../src/kernel/harness.ts';
import { pack, unpack } from '../src/plugins/archive.ts';
import { registerPluginDir } from '../src/plugins/resolve.ts';
import { tempDir } from './helpers.ts';
import { pluginDir } from '../src/plugins/test-fixtures.ts';
import { solutionDirs } from '../src/plugins/shipped.ts';

const repo = path.resolve(import.meta.dirname!, '..');
const SOLUTIONS = ['aiops', 'sdlc', 'devops', 'games3d', 'engine-blender', 'engine-godot', 'engine-unity', 'engine-unreal'];

async function* files(dir: string): AsyncGenerator<string> {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (/\.(mjs|js|ts)$/.test(e.name)) yield p;
  }
}

test('portable: a solution (solutions/<name>) reaches the harness only through the SDK, its tests too: no @harness/core/ import, no path into the core', async () => {
  const found: string[] = [];
  for (const sol of solutionDirs(repo)) {
    for await (const f of files(sol)) {
      if (!/\.(m?js|ts)$/.test(f) || /[\/](node_modules|vendor)[\/]/.test(f)) continue;
      const text = await fs.readFile(f, 'utf8');
      for (const m of text.matchAll(/['"](@harness\/core\/[^'"]+)['"]/g)) found.push(`${path.relative(repo, f)}: ${m[1]}`);
    }
  }
  assert.deepEqual(found, [], 'import @harness/plugin-sdk/testing (or /testing/desktop) instead');
  assert.ok(solutionDirs(repo).some((d) => path.basename(d) === 'studio'), 'Studio is a solution of its own');
});

test('portable: no module of a solution imports outside its own folder by relative path', async () => {
  const escapes: string[] = [];
  for (const n of SOLUTIONS) {
    const dir = pluginDir(n);
    for await (const f of files(dir)) {
      const text = await fs.readFile(f, 'utf8');
      for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
        const abs = path.resolve(path.dirname(f), m[1]!);
        if (abs !== dir && !abs.startsWith(dir + path.sep)) escapes.push(`${path.relative(repo, f)}: ${m[1]}`);
      }
    }
  }
  assert.deepEqual(escapes, [], 'use @harness/plugin-sdk/runtime or @harness/plugins/<name>/... instead');
});

test('portable: names resolve to where a plugin is (registered), the SDK to the harness, and a missing plugin says so', async () => {
  const elsewhere = await tempDir();
  await fs.mkdir(path.join(elsewhere, 'sdk'), { recursive: true });
  await fs.writeFile(path.join(elsewhere, 'sdk', 'probe.mjs'), 'export const where = "elsewhere";\n');
  registerPluginDir('probe-plugin', elsewhere);
  assert.equal(import.meta.resolve('@harness/plugins/probe-plugin/sdk/probe.mjs'), pathToFileURL(path.join(elsewhere, 'sdk', 'probe.mjs')).href);
  assert.equal((await import('@harness/plugins/probe-plugin/sdk/probe.mjs' as string)).where, 'elsewhere');
  assert.equal(import.meta.resolve('@harness/plugin-sdk/runtime'), pathToFileURL(path.join(repo, 'packages', 'plugin-sdk', 'src', 'runtime.ts')).href);
  await assert.rejects(import('@harness/plugins/not-a-plugin/x.mjs' as string), /The plugin "not-a-plugin" is not on this server/);
  await assert.rejects(import('@harness/plugins/probe-plugin/../../escape.mjs' as string), /may not leave its folder/);
});

test('portable: a solution packed and unpacked into another server\'s install folder loads and works there; Studio\'s engine finds Studio\'s copy', async () => {
  const install = path.join(await tempDir(), 'installed-plugins');
  await fs.mkdir(install, { recursive: true });
  for (const n of ['devops', 'games3d', 'engine-godot']) await unpack(await pack(pluginDir(n)), path.join(install, n));
  const logs: string[] = [];
  // The core's plugins from the harness (as a server ships them); the solutions only from the install folder.
  const h = await createHarness({
    dataDir: await tempDir(), installDir: install, plugins: ['quality-gates', 'visual'].map((n) => pluginDir(n)),
    backgroundWork: false, scheduler: false, search: null, log: (m) => logs.push(m),
  });
  try {
    for (const n of ['devops', 'games3d', 'engine-godot']) {
      const e = h.plugins.get(n);
      assert.ok(e && !e.error, `${n} loaded: ${logs.filter((l) => l.includes(n)).join(' | ')}`);
      assert.equal(e.source, 'installed');
      assert.ok(e.dir.startsWith(install), `${n} runs from the install folder`);
    }
    assert.ok(h.registry.tools.has('iac') && h.registry.tools.has('godot'), 'their tools are there');
    assert.ok(import.meta.resolve('@harness/plugins/games3d/sdk/jobs.mjs').startsWith(pathToFileURL(install).href), 'the engine imports the installed Studio');
    assert.equal(logs.filter((l) => /FAILED/.test(l)).join('\n'), '');
  } finally { await h.close(); }
});
