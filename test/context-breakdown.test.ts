// What fills a session's context (the desktop's context panel): the parts, the deferred tools apart,
// the messages as the rest of the provider's count once a request has been made.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { createHarness } from '../src/kernel/harness.ts';
import { LOAD_TOOLS } from '../src/tools/deferred.ts';
import { FakeProvider, tempDir } from './helpers.ts';

const until = async (f: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); }
};

test('context breakdown: estimated before the first request, the provider count after; plugin tools wait until loaded', async () => {
  const data = await tempDir();
  const plugins = path.resolve('plugins');
  const fake = new FakeProvider([{ calls: [{ name: LOAD_TOOLS, input: { groups: ['visual'] } }] }, { text: 'loaded' }]);
  const h = await createHarness({ dataDir: data, plugins: [plugins], shippedPlugins: [plugins], backgroundWork: false, scheduler: false, search: null });
  try {
    for (const id of h.registry.providers.keys()) h.registry.setProviderInstance(id, fake);
    const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: await tempDir() } });
    const before = await s.contextBreakdown();
    assert.equal(before.measured, false, 'nothing sent yet: an estimate');
    const part = (b: typeof before, id: string) => b.parts.find((p) => p.id === id)?.tokens ?? -1;
    assert.ok(part(before, 'system') > 100, 'the system prompt counts');
    assert.ok(part(before, 'tools') > 1000, 'the core tool schemas count');
    assert.ok(before.deferred.tools > 0 && before.deferred.tokens > 0, 'plugin tools wait behind load_tools');
    assert.ok(before.window > 0 && before.compactAt > 0 && before.compactAt <= before.window);
    const pluginBefore = part(before, 'plugin-tools');

    await s.send('render my page');
    await until(() => h.sessions.statusOf(s.meta.id) === 'idle' && fake.requests.length >= 2);
    s.meta.lastPromptTokens = 50_000;
    const after = await s.contextBreakdown();
    assert.equal(after.measured, true);
    assert.equal(after.used, 50_000, 'the total is the provider count');
    assert.equal(after.parts.reduce((a, p) => a + p.tokens, 0), 50_000, 'the messages are the rest');
    assert.ok(part(after, 'plugin-tools') > pluginBefore, 'a loaded group takes room');
    assert.ok(after.deferred.tools < before.deferred.tools, 'and waits no more');
  } finally { await h.close(); }
});
