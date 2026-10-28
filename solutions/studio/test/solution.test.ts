// Studio as one release: every plugin carries the solution's version and the core range in package.json,
// the same publisher and licence, and a changelog entry for that version; the solution's changelog has it too.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { HARNESS_VERSION, satisfies } from '@harness/plugin-sdk/runtime';
import { readManifest, shippedPlugins } from '@harness/plugin-sdk/testing';

const solution = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(await fs.readFile(path.join(solution, 'package.json'), 'utf8')) as { version: string; license: string; author: string; harness: { core: string; plugins: string[] } };

test('Studio is one release: each plugin has its version, its core range, its publisher and licence, and a changelog entry', async () => {
  const found = (await fs.readdir(path.join(solution, 'plugins'), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  assert.deepEqual(found, [...pkg.harness.plugins].sort(), 'package.json lists every plugin of Studio');
  for (const name of found) {
    const dir = path.join(solution, 'plugins', name);
    const m = (await readManifest(dir))! as { version?: string; engines?: { harness?: string }; publisher?: { name?: string }; license?: string };
    assert.equal(m.version, pkg.version, `${name}: version`);
    assert.equal(m.engines?.harness, pkg.harness.core, `${name}: the core versions`);
    assert.equal(m.publisher?.name, pkg.author, `${name}: publisher`);
    assert.equal(m.license, pkg.license, `${name}: licence`);
    assert.match(await fs.readFile(path.join(dir, 'CHANGELOG.md'), 'utf8'), new RegExp(`^## ${pkg.version.replace(/\./g, '\\.')}$`, 'm'), `${name}: changelog`);
  }
  assert.match(await fs.readFile(path.join(solution, 'CHANGELOG.md'), 'utf8'), new RegExp(`^## ${pkg.version.replace(/\./g, '\\.')}$`, 'm'));
});

test('Studio runs on this core, and the core ships it as a solution of its own', async () => {
  assert.ok(satisfies(HARNESS_VERSION, pkg.harness.core), `core ${HARNESS_VERSION} in ${pkg.harness.core}`);
  assert.ok(shippedPlugins().includes(path.join(solution, 'plugins')), 'the core finds Studio in solutions/studio');
});
