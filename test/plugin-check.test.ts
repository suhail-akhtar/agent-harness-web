// npm run plugin -- check: a plugin loaded as the server would, what it adds listed, a problem exits 1.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir } from './helpers.ts';

const check = (dir: string) => spawnSync(process.execPath, ['scripts/run.mjs', 'src/plugins/cli.ts', 'check', dir], { encoding: 'utf8', timeout: 120_000 });

test('plugin check: lists what a good plugin adds; a throwing setup and a bad ui section are problems', async () => {
  const ok = check(path.resolve('examples/plugins/acme'));
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /tools\s+acme_word_count/);
  assert.match(ok.stdout, /skills\s+release-notes/);
  assert.match(ok.stdout, /gates\s+acme-no-todo/);
  assert.match(ok.stdout, /^OK$/m);

  const dir = path.join(await tempDir(), 'broken');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'harness-plugin.json'), JSON.stringify({ name: 'broken', version: '1.0.0', main: 'index.mjs' }));
  await fs.writeFile(path.join(dir, 'index.mjs'), "export default { name: 'broken', setup() { throw new Error('boom in setup'); } };\n");
  const bad = check(dir);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /PROBLEM: it did not load: .*boom in setup/);

  await fs.writeFile(path.join(dir, 'harness-plugin.json'), JSON.stringify({ name: 'broken', version: '1.0.0', main: 'index.mjs', ui: { apiVersion: 1, displayName: 'B', contributes: { views: [{ id: 'x', kind: 'frame' }] } } }));
  await fs.writeFile(path.join(dir, 'index.mjs'), "export default { name: 'broken', setup(api) { api.registerTool({ name: 'b_t', description: 'x', parameters: { type: 'object', properties: {} }, run: async () => 'ok' }); } };\n");
  const ui = check(dir);
  assert.equal(ui.status, 1);
  assert.match(ui.stderr, /PROBLEM: its ui section is not used: View "x" needs a "title"/);
});
