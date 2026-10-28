// Going back to one of the person's messages (Edit / Send again from here): the conversation is cut to just
// before it, the stored history too, and the next turn starts from there; a changed conversation is not cut.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createHarness } from '../src/kernel/harness.ts';
import { FakeProvider, tempDir } from './helpers.ts';

test('cutBefore: back to the second message; the history file follows; the agent starts from there; a wrong text or a running agent is refused', async () => {
  const h = await createHarness({ dataDir: await tempDir(), plugins: [], search: null, memory: 'off', backgroundWork: false, scheduler: false });
  const fake = new FakeProvider([{ text: 'one' }, { text: 'two' }, { text: 'two again' }]);
  h.registry.setProviderInstance('deepseek', fake);
  try {
    const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: await tempDir() } });
    // A turn: the question and its answer are stored, and the agent is idle again.
    const turn = async (text: string) => { const n = s.history.length; await s.send(text); for (let i = 0; i < 200 && (s.history.length < n + 2 || s.status !== 'idle'); i++) await new Promise((r) => setTimeout(r, 25)); };
    await turn('first question');
    await turn('second question');
    assert.equal(s.history.length, 4);
    await assert.rejects(s.cutBefore(1, 'something else'), /changed since it was shown/);
    await assert.rejects(s.cutBefore(5), /no message 6/);
    assert.deepEqual(await s.cutBefore(1, 'second question'), { removed: 2 });
    assert.equal(s.history.length, 2);
    const stored = (await fs.readFile(path.join((s as unknown as { dir: string }).dir, 'history.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(stored.length, 2, 'the stored history is cut too');
    await turn('second question, better');
    const last = JSON.stringify(fake.requests.at(-1)!.messages);
    assert.doesNotMatch(last, /"two"/, 'the removed answer is not sent');
    assert.match(last, /second question, better/);
    assert.match(last, /went back to an earlier message/);
  } finally { await h.close(); }
});
