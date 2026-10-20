import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeAgentTool, parseAgentFile } from '../src/agents/agents.ts';
import { Checkpoints } from '../src/core/checkpoints.ts';
import { decide } from '../src/core/permissions.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { HttpTransport, McpClient } from '../src/mcp/client.ts';
import { McpManager } from '../src/mcp/manager.ts';
import { deferredTools, mcpTool, qualifiedName } from '../src/mcp/tools.ts';
import { LocalHost } from '../src/runtime/host.ts';
import { makeSkillTool, skillsIn, skillsListing } from '../src/skills/skills.ts';
import { readTool } from '../src/tools/files.ts';
import { parseFrontmatter } from '../src/util/frontmatter.ts';
import { FakeProvider, results, tempDir } from './helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'mcp-server.mjs');
const noRules = { allow: [], deny: [], ask: [] };

test('frontmatter: scalars, lists, blocks', () => {
  const p = parseFrontmatter('---\nname: x\ndescription: >\n  folded\n  text\ntools: [read, grep]\nmodel: "deepseek-flash"\nitems:\n  - a\n  - b\n---\nBody here');
  assert.equal(p.data.name, 'x');
  assert.equal(p.data.description, 'folded text');
  assert.deepEqual(p.data.tools, ['read', 'grep']);
  assert.equal(p.data.model, 'deepseek-flash');
  assert.deepEqual(p.data.items, ['a', 'b']);
  assert.equal(p.body, 'Body here');
});

test('agent definitions and the per-session agent tool', () => {
  const def = parseAgentFile('---\nname: reviewer\ndescription: Reviews diffs for bugs\ntools: read, grep\neffort: high\n---\nYou review code.', 'f', 'project')!;
  assert.deepEqual(def.tools, ['read', 'grep']);
  assert.equal(def.effort, 'high');
  const tool = makeAgentTool([{ name: 'explore', description: 'e', prompt: '' }, def]);
  assert.deepEqual((tool.spec.input_schema.properties.type as { enum: string[] }).enum, ['explore', 'reviewer']);
  assert.match(tool.spec.description, /reviewer: Reviews diffs/);
});

test('skills: discovered from folders, listed in one line each, loaded on demand, contained', async () => {
  const root = await tempDir();
  await fs.mkdir(path.join(root, 'pdf-forms', 'scripts'), { recursive: true });
  await fs.writeFile(path.join(root, 'pdf-forms', 'SKILL.md'), '---\nname: pdf-forms\ndescription: Fill PDF forms\n---\nUse scripts/fill.py.');
  await fs.writeFile(path.join(root, 'pdf-forms', 'scripts', 'fill.py'), 'print("fill")');
  await fs.mkdir(path.join(root, 'broken'));
  await fs.writeFile(path.join(root, 'broken', 'SKILL.md'), 'no frontmatter');
  const skills = await skillsIn(root, 'test');
  assert.deepEqual(skills.map((s) => s.name), ['pdf-forms']);
  assert.match(skillsListing(skills), /- pdf-forms: Fill PDF forms/);
  const tool = makeSkillTool(skills);
  const ctx = {} as never;
  const main = await tool.run({ name: 'pdf-forms' }, ctx);
  assert.match(main.content, /Use scripts\/fill.py/);
  assert.match(main.content, /scripts\/fill.py/);
  assert.match((await tool.run({ name: 'pdf-forms', file: 'scripts/fill.py' }, ctx)).content, /print/);
  await assert.rejects(tool.run({ name: 'pdf-forms', file: '../../etc/passwd' }, ctx));
});

test('MCP over stdio: initialize, paged tools/list, tools/call', async () => {
  const host = new LocalHost(await tempDir());
  const child = await host.spawnStream('node', [fixture], { MCP_TOOLS: '5' });
  const { StdioTransport } = await import('../src/mcp/client.ts');
  const c = new McpClient(new StdioTransport(child));
  await c.initialize();
  assert.equal(c.serverInfo?.name, 'fixture');
  const tools = await c.listTools();
  assert.equal(tools.length, 5);
  const r = await c.callTool('add', { a: 2, b: 3 });
  assert.equal(r.content?.[0]?.text, '5');
  await c.close();
});

test('MCP over streamable HTTP with a session id', async () => {
  let sid = '';
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    if (req.method === 'DELETE') { res.writeHead(204).end(); return; }
    const m = JSON.parse(body);
    if (m.id === undefined) { res.writeHead(202).end(); return; }
    if (m.method !== 'initialize' && req.headers['mcp-session-id'] !== 'abc') { res.writeHead(400).end('no session'); return; }
    const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'http-fixture' } }
      : m.method === 'tools/list' ? { tools: [{ name: 'ping', inputSchema: { type: 'object', properties: {} } }] }
      : { content: [{ type: 'text', text: 'pong' }] };
    sid = 'abc';
    // Answer tools/call as SSE, the rest as JSON.
    if (m.method === 'tools/call') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': sid });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result })}\n\n`);
    } else {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': sid });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const c = new McpClient(new HttpTransport(`http://127.0.0.1:${port}/mcp`));
  await c.initialize();
  assert.equal((await c.listTools())[0]!.name, 'ping');
  assert.equal((await c.callTool('ping', {})).content?.[0]?.text, 'pong');
  await c.close();
  server.close();
});

test('MCP tools: inline when few, tool_search + tool_call when many; permissions apply to the real tool', async () => {
  const host = new LocalHost(await tempDir());
  const child = await host.spawnStream('node', [fixture], { MCP_TOOLS: '30' });
  const { StdioTransport } = await import('../src/mcp/client.ts');
  const client = new McpClient(new StdioTransport(child));
  await client.initialize();
  const entries = (await client.listTools()).map((tool) => ({ server: 'inv', tool, client, qualified: qualifiedName('inv', tool.name) }));
  const echo = mcpTool(entries[0]!);
  assert.equal(echo.spec.name, 'mcp__inv__echo');
  assert.equal(echo.kind, 'read', 'readOnlyHint maps to a read tool');
  assert.equal(mcpTool(entries[1]!).kind, 'external');

  const d = deferredTools(entries);
  const found = await d.search.run({ query: 'add numbers' }, {} as never);
  assert.match(found.content, /<tool name="mcp__inv__add"/);
  assert.match(found.content, /"required":\["a","b"\]/);
  const resolved = d.call.resolve!({ name: 'mcp__inv__add', arguments: { a: 4, b: 5 } });
  assert.ok('tool' in resolved);
  assert.equal(decide(resolved.tool, resolved.input, { mode: 'default', rules: noRules, sandboxed: true }).action, 'ask', 'external actions ask even in a sandbox');
  assert.equal(decide(resolved.tool, resolved.input, { mode: 'default', rules: { ...noRules, allow: ['mcp__inv__*'] }, sandboxed: true }).action, 'allow');
  assert.equal((await resolved.tool.run(resolved.input, { signal: new AbortController().signal } as never)).content, '9');
  const bad = d.call.resolve!({ name: 'mcp__inv__add', arguments: { a: 1 } });
  assert.ok('error' in bad && /missing required parameter "b"/.test(bad.error));
  await client.close();
});

test('project .mcp.json: stdio servers run only when trusted; secrets never expand from the server env', async () => {
  const root = await tempDir();
  process.env.HW_TEST_SECRET = 'super-secret';
  await fs.writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { inv: { command: 'node', args: [fixture], env: { MCP_TOOLS: '2', LEAK: '${HW_TEST_SECRET}' } } } }));
  const mgr = new McpManager();
  const untrusted = await mgr.projectEntries(new LocalHost(root), false);
  assert.equal(untrusted.entries.length, 0);
  assert.match(untrusted.status[0]!.error!, /sandboxed/);
  const trusted = await mgr.projectEntries(new LocalHost(root), true);
  assert.equal(trusted.entries.length, 2);
  await trusted.close();
});

test('read returns images; non-image binaries are described', async () => {
  const root = await tempDir();
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  await fs.writeFile(path.join(root, 'shot.png'), png);
  const r = await readTool.run({ path: 'shot.png' }, { host: new LocalHost(root), readFiles: new Map(), signal: new AbortController().signal } as never);
  assert.equal(r.images?.[0]?.media_type, 'image/png');
  assert.equal(Buffer.from(r.images![0]!.data, 'base64').length, png.length);
});

test('checkpoints: rewind restores edited files and removes created ones', async () => {
  const root = await tempDir();
  const sdir = await tempDir();
  await fs.writeFile(path.join(root, 'a.txt'), 'v1');
  const cp = new Checkpoints(sdir, root);
  cp.begin(1, 'turn one');
  await cp.before(path.join(root, 'a.txt'));
  await fs.writeFile(path.join(root, 'a.txt'), 'v2');
  cp.begin(2, 'turn two');
  await cp.before(path.join(root, 'a.txt'));
  await fs.writeFile(path.join(root, 'a.txt'), 'v3');
  await cp.before(path.join(root, 'new.txt'));
  await fs.writeFile(path.join(root, 'new.txt'), 'created');
  assert.deepEqual((await cp.list()).map((t) => t.turn), [1, 2]);
  assert.deepEqual(await cp.rewind(2), ['a.txt', 'new.txt']);
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'v2');
  await assert.rejects(fs.stat(path.join(root, 'new.txt')));
  await cp.rewind(1);
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'v1');
});

async function writePlugin(dir: string) {
  await fs.mkdir(path.join(dir, 'skills', 'house-style'), { recursive: true });
  await fs.mkdir(path.join(dir, 'agents'), { recursive: true });
  await fs.writeFile(path.join(dir, 'harness-plugin.json'), JSON.stringify({ name: 'acme', version: '1.2.0', main: 'index.mjs', skills: 'skills', agents: 'agents' }));
  await fs.writeFile(path.join(dir, 'skills', 'house-style', 'SKILL.md'), '---\nname: house-style\ndescription: ACME code conventions\n---\nUse tabs.');
  await fs.writeFile(path.join(dir, 'agents', 'security.md'), '---\nname: security\ndescription: Security review\ntools: read, grep\n---\nFind vulnerabilities.');
  await fs.writeFile(path.join(dir, 'index.mjs'), `
export default {
  name: 'acme',
  setup(api) {
    api.registerTool({ spec: { name: 'acme_status', description: 'ACME build status', input_schema: { type: 'object', properties: {} } }, kind: 'read', parallelSafe: true, remoteable: false, summarize: () => 'status', run: async () => ({ content: 'all green' }) });
    api.registerGate({ name: 'acme-lint', description: 'lint', run: async () => ({ pass: true, summary: 'ok' }) });
    api.on('PreToolUse', (p) => (p.tool === 'bash' ? { block: true, feedback: 'ACME policy: no shell' } : undefined), 'bash');
  },
};`);
}

test('a plugin contributes tools, skills, agents, gates and in-process hooks to every session', async () => {
  const plugins = await tempDir('hw-plugins-');
  await writePlugin(path.join(plugins, 'acme'));
  const data = await tempDir();
  const h = await createHarness({ dataDir: data, plugins: [plugins] });
  assert.equal(h.registry.plugins[0]!.name, 'acme');
  assert.ok(h.registry.gates.has('acme-lint'));
  const fake = new FakeProvider([
    { calls: [{ name: 'acme_status' }, { name: 'skill', input: { name: 'house-style' } }] },
    { calls: [{ name: 'bash', input: { command: 'echo hi' } }] },
    { text: 'done' },
  ]);
  h.registry.setProviderInstance('deepseek', fake);
  const ws = await tempDir();
  const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws } });
  const caps = await s.capabilities();
  assert.ok(caps.tools.some((t) => t.name === 'acme_status'));
  assert.ok(caps.skills.some((x) => x.name === 'house-style'));
  assert.ok(caps.agents.some((a) => a.name === 'security'));
  const ended = new Promise<void>((r) => s.subscribe(0, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
  await s.send('check status');
  await ended;
  const first = JSON.parse(fake.snapshots[0]!) as { content: { text: string }[] }[];
  assert.match(first[0]!.content.at(-1)!.text, /<skills>[\s\S]*house-style: ACME code conventions/, 'skills are listed in the first message, not the system prompt');
  assert.equal(fake.requests[0]!.system, fake.requests[2]!.system);
  const r1 = results(s.history[2]);
  assert.equal(r1[0]!.content, 'all green');
  assert.match(r1[1]!.content, /Use tabs/);
  assert.match(results(s.history[4])[0]!.content, /ACME policy: no shell/);
  const trace = await s.readTrace();
  assert.equal(trace.filter((x) => x.type === 'model').length, 3);
  assert.ok(trace.some((x) => x.type === 'tool' && x.tool === 'acme_status'));
  await h.close();
});

test('a session interrupted by a restart is closed out append-only', async () => {
  const data = await tempDir();
  const h = await createHarness({ dataDir: data });
  const ws = await tempDir();
  const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws } });
  const dir = path.join(data, 'sessions', s.meta.id);
  await fs.writeFile(path.join(dir, 'history.jsonl'), [
    JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'go' }] }),
    JSON.stringify({ role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'bash', input: { command: 'sleep 100' } }] }),
  ].join('\n') + '\n');
  const meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ ...meta, running: true }));
  const h2 = await createHarness({ dataDir: data });
  const s2 = h2.sessions.get(s.meta.id)!;
  assert.equal(s2.meta.running, false);
  const last = s2.history.at(-1)!;
  assert.equal(last.role, 'user');
  assert.match(results(last)[0]!.content, /server restarted/);
  await h.close(); await h2.close();
});

test('old tool results are cleared in one batch for providers without server-side editing; history keeps them', async () => {
  const { makeAgent } = await import('./helpers.ts');
  const big = 'x'.repeat(20_000);
  const steps = Array.from({ length: 9 }, (_, i) => ({ calls: [{ name: 'bash', input: { command: `printf '${big}' # ${i}` } }], usage: { input: i < 8 ? 1000 : 120_000 } }));
  const h = await makeAgent([...steps, { text: 'ok' }]);
  h.agent.append({ role: 'user', content: [{ type: 'text', text: 'go' }] });
  await h.agent.run(new AbortController().signal);
  const cleared = h.agent.messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result' && b.content.startsWith('[Old tool output cleared'));
  assert.equal(cleared.length, 3, '9 results, newest 6 kept');
  const stored = h.persisted.flatMap((m) => m.content).filter((b) => b.type === 'tool_result' && b.content.startsWith('[Old tool output cleared'));
  assert.equal(stored.length, 0, 'the persisted history is untouched');
  assert.ok(h.events.some((e) => e.kind === 'notice' && /Cleared 3 old tool results/.test(e.text)));
});

test('calling a deferred MCP tool by its own name is routed through tool_call (no wasted round trip)', async () => {
  const { makeAgent } = await import('./helpers.ts');
  const host = new LocalHost(await tempDir());
  const child = await host.spawnStream('node', [fixture], { MCP_TOOLS: '30' });
  const { StdioTransport } = await import('../src/mcp/client.ts');
  const client = new McpClient(new StdioTransport(child));
  await client.initialize();
  const entries = (await client.listTools()).map((tool) => ({ server: 'inv', tool, client, qualified: qualifiedName('inv', tool.name) }));
  const d = deferredTools(entries);
  const { BUILTIN_TOOLS } = await import('../src/tools/index.ts');
  const h = await makeAgent([{ calls: [{ name: 'mcp__inv__add', input: { a: 20, b: 22 } }] }, { text: 'ok' }], { tools: [...BUILTIN_TOOLS, d.search, d.call] });
  h.agent.append({ role: 'user', content: [{ type: 'text', text: 'add' }] });
  await h.agent.run(new AbortController().signal);
  assert.equal(results(h.agent.messages[2])[0]!.content, '42');
  await client.close();
});

test('the shipped example plugin loads and works', async () => {
  const h = await createHarness({ dataDir: await tempDir(), plugins: [path.join(here, '..', 'examples', 'plugins')] });
  const p = h.registry.plugins.find((x) => x.name === 'acme');
  assert.ok(p, 'acme loaded');
  assert.ok(p!.contributes.includes('tool:acme_word_count'));
  const tool = h.registry.tools.get('acme_word_count')!;
  assert.equal((await tool.run({ text: 'one two three' }, {} as never)).content, '3 words');
  const gate = h.registry.gates.get('acme-no-todo')!;
  const ws = await tempDir();
  await fs.writeFile(path.join(ws, 'a.js'), '// TODO: fix\n');
  const r = await gate.run({ host: new LocalHost(ws), signal: new AbortController().signal });
  assert.equal(r.pass, false);
  const hook = h.registry.hooks.find((x) => x.plugin === 'acme')!;
  assert.deepEqual(await hook.handler({ event: 'PreToolUse', input: { command: 'git push --force origin main' } }, {} as never), { block: true, feedback: 'ACME policy: force-push is not allowed. Push normally or open a PR.' });
  assert.ok(h.registry.agents.has('security-reviewer'));
  await h.close();
});
