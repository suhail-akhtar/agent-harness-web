// Every solution (solutions/<name>) is one release: its package.json lists its plugins, each carries the
// solution's version and core range, publisher and licence, with a changelog entry; it runs on this core; it
// becomes one file that installs all its plugins; and it describes its own app on the harness desktop app.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { HARNESS_VERSION, satisfies } from '../src/plugins/bundle.ts';
import { readManifest } from '../src/plugins/loader.ts';
import { solutionDirs } from '../src/plugins/shipped.ts';
import { writeSolutionBundle } from '../src/plugins/solution-bundle.ts';
import { tempDir } from './helpers.ts';

const root = path.resolve(import.meta.dirname, '..');
const heading = (v: string) => new RegExp(`^## ${v.replace(/\./g, '\.')}$`, 'm');

test('every solution is one release: versions, core range, publisher, licence, changelogs; its own app; one file with all its plugins', async () => {
  const sols = solutionDirs(root);
  assert.deepEqual(sols.map((d) => path.basename(d)), ['devops', 'engineering', 'operations', 'studio']);
  for (const dir of sols) {
    const name = path.basename(dir);
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')) as { name: string; version: string; license: string; author: string; harness: { title: string; core: string; plugins: string[]; app?: { name?: string; appId?: string; focus?: string } } };
    assert.equal(pkg.name, `@harness/${name}`);
    assert.ok(satisfies(HARNESS_VERSION, pkg.harness.core), `${name} runs on core ${HARNESS_VERSION} (${pkg.harness.core})`);
    const found = (await fs.readdir(path.join(dir, 'plugins'), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    assert.deepEqual(found, [...pkg.harness.plugins].sort(), `${name}: package.json lists every plugin`);
    for (const p of found) {
      const m = (await readManifest(path.join(dir, 'plugins', p)))! as { version?: string; engines?: { harness?: string }; publisher?: { name?: string }; license?: string; links?: { repository?: string } };
      assert.deepEqual([m.version, m.engines?.harness, m.publisher?.name, m.license], [pkg.version, pkg.harness.core, pkg.author, pkg.license], `${name}/${p}`);
      assert.match(m.links?.repository ?? '', new RegExp(`/solutions/${name}/plugins/${p}$`), `${name}/${p}: its link`);
      assert.match(await fs.readFile(path.join(dir, 'plugins', p, 'CHANGELOG.md'), 'utf8'), heading(pkg.version), `${name}/${p}: changelog`);
    }
    assert.match(await fs.readFile(path.join(dir, 'CHANGELOG.md'), 'utf8'), heading(pkg.version), `${name}: changelog`);
    assert.ok(pkg.harness.app?.name && pkg.harness.app.appId && pkg.harness.plugins.includes(pkg.harness.app.focus ?? ''), `${name}: its own app`);
    const w = await writeSolutionBundle(dir, await tempDir());
    assert.deepEqual([w.file, [...w.plugins].sort()], [`${name}-${pkg.version}.tgz`, found], `${name}: one file`);
  }
});
