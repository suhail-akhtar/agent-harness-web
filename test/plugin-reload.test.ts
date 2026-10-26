// A plugin's code loaded again while the server runs (the desktop app does this when a plugin folder it
// loaded changes): the new code and the files it imports replace the old, a tool object an open session
// holds runs the new code, the old version is closed, and a version that fails leaves the old one running.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createHarness } from '../src/kernel/harness.ts';
import type { Tool, ToolContext } from '../src/tools/types.ts';
import { tempDir } from './helpers.ts';

const g = globalThis as unknown as { __reloadClosed: string[] };

async function write(dir: string, version: string, body = '') {
  await fs.writeFile(path.join(dir, 'helper.mjs'), `export const word = ${JSON.stringify(`helper ${version}`)};\n`);
  await fs.writeFile(path.join(dir, 'index.mjs'), `import { word } from './helper.mjs';
export default { name: 'live', setup(api) {
  ${body}
  api.registerTool({ name: 'live_version', description: 'Says the version', kind: 'read', parameters: { type: 'object', properties: {} }, run: async () => ${JSON.stringify(version)} + ' / ' + word });
  api.registerRoute({ method: 'GET', path: 'version', auth: 'user', handler: async () => ({ status: 200, body: { version: ${JSON.stringify(version)} } }) });
}, close() { (globalThis.__reloadClosed ??= []).push(${JSON.stringify(version)}); } };\n`);
}

test('plugin reload: new code (and its helpers) replace the old; held tools run it; a failing version keeps the old one', async () => {
  const root = await tempDir();
  const dir = path.join(root, 'live');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'harness-plugin.json'), JSON.stringify({ name: 'live', version: '1.0.0', main: 'index.mjs', permissions: { routes: true } }));
  await write(dir, 'v1');
  g.__reloadClosed = [];
  const h = await createHarness({ dataDir: path.join(root, 'data'), plugins: [dir], backgroundWork: false, scheduler: false, search: null });
  try {
    const run = async (t: Tool) => (await t.run({}, {} as ToolContext)).content;
    const held = h.registry.tools.get('live_version')!;
    assert.equal(await run(held), 'v1 / helper v1');

    await write(dir, 'v2');
    await h.plugins.reload('live');
    assert.equal(await run(h.registry.tools.get('live_version')!), 'v2 / helper v2', 'the new code and the file it imports');
    assert.equal(await run(held), 'v2 / helper v2', 'a session holding the old tool runs the new code');
    assert.deepEqual(g.__reloadClosed, ['v1'], 'the version before is closed');
    assert.equal(h.registry.routes.filter((r) => r.plugin === 'live').length, 1, 'one route, not two');
    assert.equal(h.registry.plugins.filter((p) => p.name === 'live').length, 1);

    await write(dir, 'v3', "throw new Error('setup broke');");
    await assert.rejects(h.plugins.reload('live'), /did not load again \(the version before keeps running\): setup broke/);
    assert.equal(await run(h.registry.tools.get('live_version')!), 'v2 / helper v2', 'v2 still runs');
    assert.equal(h.registry.routes.filter((r) => r.plugin === 'live').length, 1);
    assert.ok(h.plugins.get('live')?.enabled);

    // A plugin the server does not have yet loads from its folder.
    const other = path.join(root, 'other');
    await fs.mkdir(other);
    await fs.writeFile(path.join(other, 'harness-plugin.json'), JSON.stringify({ name: 'other', main: 'index.mjs' }));
    await fs.writeFile(path.join(other, 'index.mjs'), "export default { name: 'other', setup(api) { api.registerTool({ name: 'other_hi', description: 'hi', kind: 'read', parameters: { type: 'object', properties: {} }, run: async () => 'hi' }); } };\n");
    await assert.rejects(h.plugins.reload('other'), /No plugin "other"/);
    await h.plugins.reload('other', other);
    assert.ok(h.registry.tools.has('other_hi'));
  } finally { await h.close(); }
});
