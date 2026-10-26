// A plugin's versioned data (api.store): the empty document at first, a bare file written before the
// plugin used the store read as version 1, old data brought forward one step per version on its first
// read (the old file kept), data newer than the code and a missing step refused with the data untouched,
// and concurrent updates under the lock losing nothing.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { makeStore } from '../src/plugins/store.ts';
import { tempDir } from './helpers.ts';

type V3 = { habits: { name: string; archived: boolean; color: string }[] };

test('plugin store: initial, update, migrations from a bare v1 file through v3, the old file kept', async () => {
  const dir = await tempDir();
  const v1 = makeStore<{ habits: { name: string }[] }>('demo', dir, 'habits', { initial: () => ({ habits: [] }) });
  assert.deepEqual(await v1.read(), { habits: [] });
  // Written before the plugin used api.store: a bare document.
  await fs.writeFile(path.join(dir, 'habits.json'), JSON.stringify({ habits: [{ name: 'walk' }] }));
  assert.deepEqual(await v1.read(), { habits: [{ name: 'walk' }] });

  const v3 = makeStore<V3>('demo', dir, 'habits', {
    version: 3, initial: () => ({ habits: [] }),
    migrations: {
      2: (d: { habits: { name: string }[] }) => ({ habits: d.habits.map((h) => ({ ...h, archived: false })) }),
      3: (d: { habits: { name: string; archived: boolean }[] }) => ({ habits: d.habits.map((h) => ({ ...h, color: 'blue' })) }),
    },
  });
  assert.deepEqual(await v3.read(), { habits: [{ name: 'walk', archived: false, color: 'blue' }] });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'habits.json'), 'utf8')).version, 3);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'habits.v1.json'), 'utf8')), { habits: [{ name: 'walk' }] }, 'the old file is kept');

  await Promise.all(Array.from({ length: 10 }, (_, i) => v3.update((d) => { d.habits.push({ name: `h${i}`, archived: false, color: 'red' }); })));
  assert.equal((await v3.read()).habits.length, 11, 'concurrent updates under the lock lose nothing');

  await assert.rejects(v1.read(), /the "habits" data is version 3, newer than this plugin's \(1\)/);
  const gap = makeStore('demo', dir, 'habits', { version: 5, initial: () => ({}), migrations: { 4: (d) => d } });
  await assert.rejects(gap.read(), /no migration to version 5 \(migrations\[5\]\)\. The data was left as it was/);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'habits.json'), 'utf8')).version, 3, 'untouched');
  const broken = makeStore('demo', dir, 'habits', { version: 4, initial: () => ({}), migrations: { 4: () => { throw new Error('bad step'); } } });
  await assert.rejects(broken.read(), /migrating the "habits" data to version 4 failed: bad step/);
  assert.throws(() => makeStore('demo', dir, '../escape', { initial: () => ({}) }), /a store's name is letters/);
});
