// The two tiers: official (shipped with the harness, or signed with a key the operator lists as an official
// publisher, HARNESS_OFFICIAL_KEYS) and custom (everything else, signed by another trusted key or loaded
// without a trust list). Both get the whole API; the tier is shown (GET /api/plugins) and the plugin's code
// sees it (api.tier).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createHarness } from '../src/kernel/harness.ts';
import { generateKeyPair, signPlugin } from '../src/plugins/signing.ts';
import { tempDir } from './helpers.ts';

const g = globalThis as unknown as { __tiers: Record<string, string> };

async function plugin(root: string, name: string): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'harness-plugin.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.mjs' }));
  await fs.writeFile(path.join(dir, 'index.mjs'), `export default { name: ${JSON.stringify(name)}, setup(api) { (globalThis.__tiers ??= {})[api.pluginName] = api.tier; } };\n`);
  return dir;
}

test('tiers: shipped and official-key plugins are official, others custom; the plugin sees its own', async () => {
  g.__tiers = {};
  const shipped = path.join(await tempDir(), 'plugins');
  await plugin(shipped, 'core-thing');
  const keys = await tempDir();
  const official = generateKeyPair();
  const partner = generateKeyPair();
  await fs.writeFile(path.join(keys, 'harness.pub.pem'), official.publicPem);
  await fs.writeFile(path.join(keys, 'partner.pub.pem'), partner.publicPem);
  const extra = await tempDir();
  await signPlugin(await plugin(extra, 'by-harness'), official.privatePem);
  await signPlugin(await plugin(extra, 'by-partner'), partner.privatePem);
  process.env.HARNESS_OFFICIAL_KEYS = official.keyId;
  try {
    const h = await createHarness({ dataDir: await tempDir(), plugins: [shipped, extra], shippedPlugins: [shipped], pluginKeys: keys, backgroundWork: false, scheduler: false, search: null });
    try {
      const tier = (n: string) => h.plugins.get(n)?.tier;
      assert.deepEqual([tier('core-thing'), tier('by-harness'), tier('by-partner')], ['official', 'official', 'custom']);
      assert.deepEqual(g.__tiers, { 'core-thing': 'official', 'by-harness': 'official', 'by-partner': 'custom' });
    } finally { await h.close(); }
  } finally { delete process.env.HARNESS_OFFICIAL_KEYS; }

  // Without a trust list (a desktop loading a folder): custom, with the whole API all the same.
  const loose = await tempDir();
  await plugin(loose, 'my-own');
  const h = await createHarness({ dataDir: await tempDir(), plugins: [loose], backgroundWork: false, scheduler: false, search: null });
  try { assert.equal(h.plugins.get('my-own')?.tier, 'custom'); assert.equal((g.__tiers as Record<string, string>)['my-own'], 'custom'); } finally { await h.close(); }
});
