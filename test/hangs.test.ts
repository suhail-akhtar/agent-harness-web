import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { defineTool } from '../src/plugins/api.ts';
import { postStream } from '../src/providers/http.ts';
import { ProviderError } from '../src/providers/types.ts';
import { makeAgent, results } from './helpers.ts';

// Nothing may hold an agent for good: a tool that ignores the stop, a tool that never
// returns, a model server that takes the request and never answers. (An AIOps eval run
// once hung for 5.4 hours past its 45-minute limit.)

const forever = (name: string) => defineTool({ name, description: 'never returns and ignores the signal', parameters: { type: 'object', properties: {} }, kind: 'read', run: () => new Promise<string>(() => {}) });

test('a tool that ignores the stop is left behind when the turn is stopped: the agent ends at once', async () => {
  const h = await makeAgent([{ calls: [{ name: 'stuck', input: {} }] }, { text: 'never reached' }], { tools: [forever('stuck')] });
  const ac = new AbortController();
  const t0 = Date.now();
  setTimeout(() => ac.abort(new Error('stopped')), 200);
  await h.agent.run(ac.signal);
  assert.ok(Date.now() - t0 < 5_000, `it ended ${Date.now() - t0} ms after the stop`);
});

test('a tool call that never returns is abandoned at the ceiling (HARNESS_TOOL_MAX_MINUTES) and the agent goes on', async () => {
  const before = process.env.HARNESS_TOOL_MAX_MINUTES;
  process.env.HARNESS_TOOL_MAX_MINUTES = String(0.5 / 60); // half a second
  try {
    const h = await makeAgent([{ calls: [{ name: 'stuck', input: {} }] }, { text: 'went on' }], { tools: [forever('stuck')] });
    await h.agent.run(new AbortController().signal);
    const r = results(h.agent.messages.find((m) => m.role === 'user' && m.content.some((b) => b.type === 'tool_result'))!)[0]!;
    assert.equal(r.is_error, true);
    assert.match(r.content, /did not finish within .* and was abandoned/);
    assert.match(JSON.stringify(h.agent.messages.at(-1)), /went on/);
  } finally { if (before === undefined) delete process.env.HARNESS_TOOL_MAX_MINUTES; else process.env.HARNESS_TOOL_MAX_MINUTES = before; }
});

test('a model server that takes the request and never answers is a retryable error after the idle time, not a hang', async () => {
  const sockets = new Set<import('node:net').Socket>();
  const srv = http.createServer(() => { /* never answers */ });
  srv.on('connection', (s) => sockets.add(s));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const before = process.env.HARNESS_STREAM_IDLE_MS;
  process.env.HARNESS_STREAM_IDLE_MS = '300';
  try {
    const t0 = Date.now();
    const err = await postStream(`http://127.0.0.1:${(srv.address() as { port: number }).port}/v1/chat`, {}, { x: 1 }, new AbortController().signal).then(() => undefined, (e: unknown) => e);
    assert.ok(err instanceof ProviderError, String(err));
    assert.equal((err as ProviderError).retryable, true);
    assert.match((err as Error).message, /no response within 0\.3s/);
    assert.ok(Date.now() - t0 < 5_000);
  } finally {
    if (before === undefined) delete process.env.HARNESS_STREAM_IDLE_MS; else process.env.HARNESS_STREAM_IDLE_MS = before;
    for (const s of sockets) s.destroy();
    srv.close();
  }
});
