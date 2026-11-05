// A scripted model stands in for the real one: no key, no network, no cost.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FakeProvider } from '@harness/plugin-sdk/testing';
import { startAgent } from '../agent.ts';

test('the agent calls its tool and answers from the result', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-test-'));
  const fake = new FakeProvider([{ calls: [{ name: 'lookup_order', input: { id: 'A1' } }] }, { text: 'Order A1 has shipped.' }]);
  const agent = await startAgent({ dataDir: path.join(tmp, 'data'), workspace: tmp, model: 'deepseek-flash', setup: (h) => h.registry.setProviderInstance('deepseek', fake) });
  assert.equal(await agent.ask('Where is order A1?'), 'Order A1 has shipped.');
  assert.match(JSON.stringify(fake.requests.at(-1)?.messages), /shipped/);
  await agent.harness.close?.();
});
