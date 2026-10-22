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

test('anthropic: a model thinking quietly for longer than the idle time (only pings on the wire) is not a stall; a silent connection still is', async () => {
  const { AnthropicProvider } = await import('../src/providers/anthropic.ts');
  const { getModel } = await import('../src/core/models.ts');
  const sockets = new Set<import('node:net').Socket>();
  let mode: 'pings' | 'silent' = 'pings';
  const ev = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', async () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(ev('message_start', { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } }));
      // 900 ms with nothing but pings (or nothing at all), against a 300 ms idle limit.
      for (let i = 0; i < 9; i++) { await new Promise((r) => setTimeout(r, 100)); if (mode === 'pings' && !res.destroyed) res.write(ev('ping', { type: 'ping' })); }
      if (res.destroyed) return;
      res.write(ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
      res.write(ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'thought it through' } }));
      res.write(ev('content_block_stop', { type: 'content_block_stop', index: 0 }));
      res.write(ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }));
      res.end(ev('message_stop', { type: 'message_stop' }));
    });
  });
  srv.on('connection', (s) => sockets.add(s));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const before = process.env.HARNESS_STREAM_IDLE_MS;
  process.env.HARNESS_STREAM_IDLE_MS = '300';
  try {
    const p = new AnthropicProvider('test-key', `http://127.0.0.1:${(srv.address() as { port: number }).port}`);
    const req = { model: getModel('claude-haiku-5-5'), system: 's', tools: [], messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }], effort: 'low' as const, signal: new AbortController().signal, cacheKey: 'k' };
    const ok = await p.send(req);
    assert.match(JSON.stringify(ok.message.content), /thought it through/, 'pings kept it alive past the idle time');
    mode = 'silent';
    const err = await p.send(req).then(() => undefined, (e: unknown) => e);
    assert.ok(err instanceof ProviderError, String(err));
    assert.match((err as Error).message, /stream stalled for 0\.3s/);
    assert.equal((err as ProviderError).retryable, true);
  } finally {
    if (before === undefined) delete process.env.HARNESS_STREAM_IDLE_MS; else process.env.HARNESS_STREAM_IDLE_MS = before;
    for (const s of sockets) s.destroy();
    srv.close();
  }
});

test('anthropic: tool arguments the model broke (XML tags inside the JSON) are asked again, and the error does not carry the arguments', async () => {
  const { AnthropicProvider } = await import('../src/providers/anthropic.ts');
  const { getModel } = await import('../src/core/models.ts');
  const ev = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(ev('message_start', { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } }));
      res.write(ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'incident', input: {} } }));
      res.write(ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"action": "postmortem", "lucky": ["secret-ish detail"]</lucky>\n<parameter name="action_items">[]' } }));
      res.write(ev('content_block_stop', { type: 'content_block_stop', index: 0 }));
      res.write(ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 40 } }));
      res.end(ev('message_stop', { type: 'message_stop' }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const p = new AnthropicProvider('test-key', `http://127.0.0.1:${(srv.address() as { port: number }).port}`);
    const req = { model: getModel('claude-sonnet-5-5'), system: 's', tools: [], messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }], effort: 'medium' as const, signal: new AbortController().signal, cacheKey: 'k' };
    const err = await p.send(req).then(() => undefined, (e: unknown) => e);
    assert.ok(err instanceof ProviderError, String(err));
    assert.equal((err as ProviderError).retryable, true, 'the agent loop asks again');
    assert.match((err as Error).message, /tool arguments that are not valid JSON .*asking again/);
    assert.ok(!(err as Error).message.includes('secret-ish detail'), (err as Error).message);
  } finally { srv.close(); }
});
