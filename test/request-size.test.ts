// A request larger than the model provider accepts (HTTP 413, "Failed to buffer the request body: length limit
// exceeded"): the oldest images are left out once the newest fill what a request may carry; a 413 is sent
// again without images, then after compacting; past that the person is told what to do. The stored history
// keeps everything.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { capImages } from '../src/core/agent.ts';
import type { Message } from '../src/core/types.ts';
import { ProviderError } from '../src/providers/types.ts';
import { makeAgent, tempDir } from './helpers.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c80000000049454e44ae426082', 'hex');

test('capImages: the newest images are kept up to the budget, older ones become a note; nothing over, nothing changed', () => {
  const img = (n: number) => ({ media_type: 'image/png', data: 'x'.repeat(n) });
  const msgs: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', ...img(400) } as never] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'shot 1', images: [img(300)] } as never] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: 'shot 2', images: [img(300)] } as never] },
  ];
  assert.equal(capImages(msgs, 10_000), msgs, 'under the budget: the same array');
  const capped = capImages(msgs, 650);
  const json = JSON.stringify(capped);
  assert.equal((capped[2]!.content[0] as { images?: unknown[] }).images?.length, 1, 'the newest kept');
  assert.equal((capped[1]!.content[0] as { images?: unknown[] }).images?.length, 1, 'the next fits');
  assert.equal(capped[0]!.content[1]!.type, 'text', 'the oldest left out');
  assert.match(json, /An older image was here/);
  assert.equal((msgs[0]!.content[1] as { type: string }).type, 'image', 'the original is untouched');
});

test('a 413 from the provider: sent again without images; the run goes on; the stored history keeps them', async () => {
  const root = await tempDir();
  await fs.writeFile(path.join(root, 'shot.png'), PNG);
  const h = await makeAgent([{ calls: [{ name: 'read', input: { path: 'shot.png' } }] }, { text: 'done' }], { root });
  const real = h.provider.send.bind(h.provider);
  const sizes: boolean[] = [];
  h.provider.send = async (req) => {
    const withImages = req.messages.some((m) => m.content.some((b) => b.type === 'image' || (b.type === 'tool_result' && !!b.images?.length)));
    sizes.push(withImages);
    if (withImages) throw new ProviderError('413 Failed to buffer the request body: length limit exceeded', 413, false);
    return real(req);
  };
  h.agent.append({ role: 'user', content: [{ type: 'text', text: 'look at the shot' }] });
  await h.agent.run(new AbortController().signal);
  assert.deepEqual(sizes, [false, true, false], 'refused with the image, then sent without it');
  assert.ok(h.events.some((e) => e.kind === 'notice' && /larger than .* accepts; sending it again without the images/.test(e.text)));
  assert.match(JSON.stringify(h.agent.messages.at(-1)), /done/, 'the run went on');
  assert.match(JSON.stringify(h.agent.messages), /request would be larger than the model provider accepts/);
  assert.ok(h.persisted.some((m) => m.content.some((b) => b.type === 'tool_result' && !!b.images?.length)), 'the stored history keeps the image');
});

test('a 413 with no images: compacted, then sent again; if it is still too large the error says what to do', async () => {
  const h = await makeAgent([{ text: 'summary of the work so far' }, { text: 'carried on' }]);
  const real = h.provider.send.bind(h.provider);
  let calls = 0;
  h.provider.send = async (req) => {
    calls++;
    // The first request is too large; the compaction request and the one after it go through.
    if (calls === 1) throw new ProviderError('413 Failed to buffer the request body: length limit exceeded', 413, false);
    return real(req);
  };
  h.agent.append({ role: 'user', content: [{ type: 'text', text: 'go on' }] });
  await h.agent.run(new AbortController().signal);
  assert.ok(h.events.some((e) => e.kind === 'notice' && /compacting it, then going on/.test(e.text)));
  assert.equal(calls, 3, 'the request, the compaction, the request again');

  const h2 = await makeAgent([{ text: 'x' }]);
  h2.provider.send = async () => { throw new ProviderError('413 too big', 413, false); };
  h2.agent.append({ role: 'user', content: [{ type: 'text', text: 'go' }] });
  await assert.rejects(h2.agent.run(new AbortController().signal), /larger than .* accepts.*Start a new conversation/);
});
