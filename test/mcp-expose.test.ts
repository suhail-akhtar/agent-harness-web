import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { HttpTransport, McpClient, StdioTransport } from '../src/mcp/client.ts';
import { gate, OPERATOR, setupServer } from './multi-helpers.ts';

// The harness as an MCP server (docs/agents-mcp/PLAN.md, phase 4): POST /mcp with a person's token offers their
// agents as tools; a call runs the agent and returns its answer; a long one goes on and is fetched later; the
// stdio bridge for apps that start a command.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (r: { content?: Array<{ text?: string }> }) => r.content?.map((c) => c.text ?? '').join('') ?? '';

test('/mcp: a bearer token only; the agents as tools; a run returns the agent\'s answer, a long one goes on and get_result fetches it; each person their own', async () => {
  const t = await setupServer();
  try {
    const url = `${t.base}/mcp`;
    // No token, a wrong one, or only a cookie: refused.
    assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer nope' }, body: '{}' })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `hw_token=${OPERATOR}` }, body: '{}' })).status, 401);

    const al = await t.member('al');
    assert.equal((await t.call(al.token, 'POST', '/api/me/agents', { name: 'helper', description: 'Helps with small writing jobs and returns the text.', prompt: 'Write it.', tools: ['read'] })).status, 201);

    const op = new McpClient(new HttpTransport(url, { authorization: `Bearer ${OPERATOR}` }));
    await op.initialize();
    assert.equal(op.protocol, '2026-07-28');
    assert.equal(op.serverInfo?.name, 'agent-harness');
    const names = (await op.listTools()).map((x) => x.name);
    for (const n of ['run_agent', 'list_agents', 'get_result', 'agent_general', 'agent_explore']) assert.ok(names.includes(n), n);
    assert.ok(!names.includes('agent_helper'), 'al\'s agent is not the operator\'s');
    assert.match(text(await op.callTool('list_agents', {})), /general \(builtin\)/);

    // A run: the agent's answer, and its conversation.
    for (const p of [t.ds, t.an]) p.scripts.r1 = Array.from({ length: 4 }, () => ({ text: 'The summary is ready: three points.' }));
    const r = await op.callTool('run_agent', { agent: 'general', task: '[[r1]] Summarise the notes.' });
    assert.equal(r.isError, undefined, text(r));
    assert.match(text(r), /^The summary is ready: three points\.[\s\S]*conversation: \S+ \(finished\) · agent: general/);
    const conv = (r.structuredContent as { conversation: string }).conversation;
    const meta = (await t.call(OPERATOR, 'GET', `/api/sessions/${conv}`)).body;
    assert.deepEqual([meta.meta.agent, meta.meta.mode], ['general', 'dontAsk']);
    // The agent's own tool works the same.
    for (const p of [t.ds, t.an]) p.scripts.r2 = Array.from({ length: 4 }, () => ({ text: 'Explored.' }));
    assert.match(text(await op.callTool('agent_explore', { task: '[[r2]] Look around.', mode: 'plan' })), /^Explored\./);
    assert.match(text(await op.callTool('run_agent', { agent: 'nobody', task: 'x' })), /one of the allowed values/);

    // A long run: the call returns, the run goes on, get_result fetches the answer.
    const g = gate();
    for (const p of [t.ds, t.an]) p.scripts.slow = Array.from({ length: 4 }, () => ({ text: 'Finished at last.', wait: g.p }));
    const long = await op.callTool('run_agent', { agent: 'general', task: '[[slow]] Take your time.', waitSeconds: 5 });
    assert.match(text(long), /still working\. Call get_result with conversation "([^"]+)"/);
    const slowId = (long.structuredContent as { conversation: string }).conversation;
    assert.match(text(await op.callTool('get_result', { conversation: slowId })), /^Still working/);
    g.open();
    for (let i = 0; i < 100 && /^Still/.test(text(await op.callTool('get_result', { conversation: slowId }))); i++) await new Promise((x) => setTimeout(x, 100));
    assert.match(text(await op.callTool('get_result', { conversation: slowId })), /^Finished at last\./);
    await op.close();

    // A member: their own agent is offered (their runs go to a sandbox, as in the app), and another's conversation is not theirs.
    const m = new McpClient(new HttpTransport(url, { authorization: `Bearer ${al.token}` }));
    await m.initialize();
    assert.ok((await m.listTools()).some((x) => x.name === 'agent_helper'));
    assert.match(text(await m.callTool('agent_helper', { task: 'Write a line.', folder: '/etc' })), /could not start: Server folders are for administrators/);
    assert.match(text(await m.callTool('get_result', { conversation: conv })), /No such conversation of yours/);
    await m.close();
  } finally { await t.close(); }
});

test('the stdio bridge: an app that starts a command reaches the same agents (the token from the environment)', async () => {
  const t = await setupServer();
  try {
    const child = spawn(process.execPath, [path.join(root, 'src', 'mcp', 'bridge.ts'), '--url', `${t.base}/mcp`], { env: { ...process.env, HARNESS_TOKEN: OPERATOR } });
    const c = new McpClient(new StdioTransport(child));
    try {
      await c.initialize();
      assert.equal(c.serverInfo?.name, 'agent-harness');
      assert.ok((await c.listTools()).some((x) => x.name === 'run_agent'));
      for (const p of [t.ds, t.an]) p.scripts.br = Array.from({ length: 4 }, () => ({ text: 'Bridged answer.' }));
      assert.match(text(await c.callTool('run_agent', { agent: 'general', task: '[[br]] Hello through the bridge.' })), /^Bridged answer\./);
    } finally { await c.close(); }
    // Without a token it says how to start it.
    const bad = spawn(process.execPath, [path.join(root, 'src', 'mcp', 'bridge.ts'), '--url', `${t.base}/mcp`], { env: { ...process.env, HARNESS_TOKEN: '' } });
    let err = '';
    bad.stderr.on('data', (d) => { err += d; });
    const code = await new Promise((r) => bad.on('exit', r));
    assert.equal(code, 2);
    assert.match(err, /HARNESS_TOKEN=<token>/);
  } finally { await t.close(); }
});

test('the desktop app\'s token for other apps works on /mcp only, never on the rest of the API', async () => {
  process.env.HARNESS_MCP_TOKEN = 'mcp-only-token-for-tests-0123456789';
  const t = await setupServer();
  try {
    const c = new McpClient(new HttpTransport(`${t.base}/mcp`, { authorization: 'Bearer mcp-only-token-for-tests-0123456789' }));
    await c.initialize();
    assert.ok((await c.listTools()).some((x) => x.name === 'run_agent'));
    await c.close();
    assert.equal((await t.call('mcp-only-token-for-tests-0123456789', 'GET', '/api/me')).status, 401);
    assert.equal((await t.call('mcp-only-token-for-tests-0123456789', 'GET', '/api/sessions')).status, 401);
  } finally { delete process.env.HARNESS_MCP_TOKEN; await t.close(); }
});
