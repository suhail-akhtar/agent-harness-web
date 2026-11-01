import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { HttpTransport, McpClient, StdioTransport } from '../src/mcp/client.ts';
import { modernFixture, startModernHttp } from './mcp-fixtures.ts';

// Our client against a server made with the official SDK (test/fixtures/mcp-modern.mjs), over stdio and HTTP.

async function exercise(c: McpClient) {
  await c.initialize();
  assert.equal(c.serverInfo?.name, 'modern-fixture');
  assert.match(c.instructions ?? '', /echo, add/);
  const tools = await c.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['add', 'echo', 'mutate', 'slow']);
  const echo = tools.find((t) => t.name === 'echo')!;
  assert.equal(echo.title, 'Echo');
  assert.equal(echo.annotations?.readOnlyHint, true);
  assert.ok(tools.find((t) => t.name === 'add')!.outputSchema);
  assert.equal((await c.callTool('echo', { text: 'hi' })).content?.[0]?.text, 'echo: hi');
  const sum = await c.callTool('add', { a: 2, b: 40 });
  assert.deepEqual(sum.structuredContent, { sum: 42 });
  // Invalid arguments come back as a tool error, not a crash.
  const bad = await c.callTool('add', { a: 'x' });
  assert.equal(bad.isError, true);
  assert.ok(c.canListResources && c.canListPrompts);
  const res = await c.listResources();
  assert.equal(res[0]?.uri, 'note://welcome');
  assert.equal((await c.readResource('note://welcome')).contents[0]?.text, 'Welcome to the notes server.');
  const prompts = await c.listPrompts();
  assert.equal(prompts[0]?.name, 'review');
  const p = await c.getPrompt('review', { file: 'a.ts' });
  assert.equal(p.messages[0]?.content.text, 'Please review a.ts.');
  // A slow tool that reports progress outlives a timeout shorter than the call (progress resets it).
  assert.equal((await c.callTool('slow', { ms: 200 })).content?.[0]?.text, 'waited 200');
  // Cancellation.
  const ac = new AbortController();
  const pending = c.callTool('slow', { ms: 5000 }, ac.signal);
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(pending, /aborted/);
}

test('the official SDK server over stdio: tools, structured output, resources, prompts, progress, cancellation, list_changed', async () => {
  const child = spawn(process.execPath, [modernFixture]);
  const c = new McpClient(new StdioTransport(child));
  try {
    await exercise(c);
    assert.equal(c.protocol, '2026-07-28');
    // The server changes its tools: we are told.
    const told = new Promise<void>((r) => c.onToolsChanged(r));
    await c.callTool('mutate', {});
    await told;
    const after = await c.listTools();
    assert.ok(after.some((t) => t.name === 'shout'));
    assert.match(after.find((t) => t.name === 'echo')!.description ?? '', /ssh/);
  } finally { await c.close(); }
});

test('the official SDK server over streamable HTTP, and a bearer token in a header', async () => {
  const srv = await startModernHttp({ MCP_TOKEN: 'tok-123' });
  try {
    const c = new McpClient(new HttpTransport(srv.url, { authorization: 'Bearer tok-123' }));
    try { await exercise(c); assert.equal(c.protocol, '2026-07-28'); } finally { await c.close(); }
    const denied = new McpClient(new HttpTransport(srv.url, { authorization: 'Bearer wrong' }));
    await assert.rejects(denied.initialize(), /401|nauthori/);
    await denied.close();
  } finally { srv.stop(); }
});

test('a 2025-only server is found by the probe and used through initialize', async () => {
  const child = spawn(process.execPath, [modernFixture], { env: { ...process.env, MCP_LEGACY_ONLY: '1' } });
  const c = new McpClient(new StdioTransport(child));
  try {
    await c.initialize();
    assert.match(c.protocol ?? '', /^2025-/);
    assert.equal((await c.callTool('echo', { text: 'old' })).content?.[0]?.text, 'echo: old');
  } finally { await c.close(); }
});
