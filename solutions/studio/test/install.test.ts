// Studio as one file (what Plugins > Install from a file takes) into a harness that has only the core:
// signed by an official publisher, every plugin installed in order, loaded, official, its tools there; the
// same file again changes nothing.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createHarness, generateKeyPair, shippedPlugins, tempDir, writeSolutionBundle } from '@harness/plugin-sdk/testing';

const solution = path.resolve(import.meta.dirname, '..');

test('Studio installs from one file into a harness with only the core: verified, in order, loaded, its tools there', async () => {
  const pair = generateKeyPair();
  const keys = await tempDir();
  await fs.writeFile(path.join(keys, 'publisher.pub.pem'), pair.publicPem);
  const out = await tempDir();
  const w = await writeSolutionBundle(solution, out, pair.privatePem);
  assert.equal(w.plugins[0], 'games3d', 'Studio first: its engines require it');
  const data = await fs.readFile(path.join(out, w.file));

  // Only the core's plugins (plugins/), not the solutions.
  const core = shippedPlugins().filter((d) => !d.includes(`${path.sep}solutions${path.sep}`));
  const h = await createHarness({ dataDir: await tempDir(), plugins: core, shippedPlugins: core, publisherKeys: keys, backgroundWork: false, scheduler: false, search: null, memory: 'off' });
  try {
    assert.equal(h.plugins.list().some((p) => p.name === 'games3d'), false, 'no Studio before');
    const r = await h.plugins.importFile(data, { allowUnsigned: true });
    assert.equal(r.kind, 'solution');
    if (r.kind !== 'solution') return;
    assert.deepEqual(r.solution.title, 'Studio');
    assert.deepEqual(r.plugins.map((p) => p.name), w.plugins);
    for (const p of r.plugins) {
      assert.equal(p.source, 'installed', p.name);
      assert.ok(p.loaded, `${p.name} loaded${p.error ? `: ${p.error}` : ''}`);
      assert.equal(p.tier, 'official', `${p.name} is official`);
      assert.match(p.signature ?? '', /^signed by publisher /, p.name);
    }
    const tools = r.plugins.flatMap((p) => p.loaded?.contributes ?? []);
    for (const t of ['tool:godot', 'tool:blender', 'tool:game_play', 'tool:studio_model', 'tool:model_info']) assert.ok(tools.includes(t), t);
    const again = await h.plugins.importFile(data, { allowUnsigned: true });
    assert.deepEqual(again.kind === 'solution' && [again.plugins.length, again.unchanged], [0, w.plugins]);
  } finally { await h.close(); }
});
