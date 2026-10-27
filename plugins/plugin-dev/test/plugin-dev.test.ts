// Plugin development, as any server loads it: plugin_new writes a complete plugin in the workspace (with its
// bundle details and tests), refuses a bad name and an existing folder; the build-a-plugin skill is there.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { loadPlugin } from '@harness/plugin-sdk/testing';

const dir = new URL('..', import.meta.url);

test('plugin-dev: plugin_new writes a plugin with its manifest, bundle details, page and tests; bad names and existing folders are refused', async () => {
  const kit = await loadPlugin(dir);
  try {
    assert.equal(kit.error, undefined);
    assert.deepEqual(kit.adds.tools.sort(), ['plugin_new', 'plugin_review', 'plugin_test']);
    assert.deepEqual(kit.adds.skills, ['build-a-plugin']);
    const made = await kit.tool('plugin_new', { name: 'reading-list' });
    assert.equal(made.isError, false, made.content);
    const root = path.join(kit.workspace, 'plugins', 'reading-list');
    const m = JSON.parse(await fs.readFile(path.join(root, 'harness-plugin.json'), 'utf8'));
    assert.equal(m.name, 'reading-list');
    assert.match(m.engines.harness, /^>=\d+\.\d+\.\d+$/);
    for (const f of ['icon.svg', 'CHANGELOG.md', 'ui/index.html']) await fs.access(path.join(root, f));
    assert.ok((await fs.readdir(path.join(root, 'test'))).some((f) => f.endsWith('.test.ts')));
    assert.equal((await kit.tool('plugin_new', { name: 'Bad Name' })).isError, true);
    assert.equal((await kit.tool('plugin_new', { name: 'reading-list' })).isError, true, 'the folder exists');
  } finally { await kit.close(); }
});
