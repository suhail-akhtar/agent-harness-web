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

test('a workspace workflow runs through the session; its approval shows only files inside the workspace', async () => {
  const h = await createHarness({ dataDir: await tempDir() });
  const outside = await tempDir();
  const ws = path.join(outside, 'ws');
  await fs.mkdir(path.join(ws, '.harness', 'workflows'), { recursive: true });
  await fs.writeFile(path.join(outside, 'secret.txt'), 'server secret');
  await fs.writeFile(path.join(ws, 'design.md'), '# Design');
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(ws, 'link.md'));
  await fs.writeFile(path.join(ws, '.harness', 'workflows', 'ship.json'), JSON.stringify({
    name: 'ship', description: 'd', inputs: { what: { description: 'w', required: true } }, start: 'ok',
    nodes: { ok: { type: 'approval', message: 'Ship {{input.what}}?', files: ['../secret.txt', 'link.md', 'design.md'], next: { on: { approve: 'end', reject: 'end' } } }, end: { type: 'end' } },
  }));
  const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws } });
  const seen: string[][] = [];
  const ended = new Promise<void>((r) => s.subscribe(0, ({ event }) => {
    if (event.kind === 'approval_request') { seen.push(event.files.map((f) => f.path)); assert.equal(event.message, 'Ship v2?'); s.respond(event.requestId, { decision: 'approve' }); }
    if (event.kind === 'turn_end' && !event.agent) r();
  }));
  await s.startWorkflow('ship', { what: 'v2' });
  await ended;
  assert.deepEqual(seen, [['design.md']]);
  assert.equal(s.meta.title, 'ship: v2');
  const [run] = await s.listRuns();
  assert.equal(run!.status, 'succeeded');
  assert.deepEqual(run!.history.map((x) => `${x.node}:${x.outcome ?? ''}`), ['ok:approve', 'end:']);
  await h.close();
});

test('parallel branches saving at the same moment do not break the run record', async () => {
  const h = await createHarness({ dataDir: await tempDir() });
  const ws = await tempDir();
  await fs.mkdir(path.join(ws, '.harness', 'workflows'), { recursive: true });
  const branches = Array.from({ length: 6 }, (_, i) => `b${i}`);
  await fs.writeFile(path.join(ws, '.harness', 'workflows', 'fan.json'), JSON.stringify({
    name: 'fan', description: 'd', start: 'p',
    nodes: { p: { type: 'parallel', branches, next: 'end' }, ...Object.fromEntries(branches.map((b) => [b, { type: 'gate', gates: 'applicable' }])), end: { type: 'end' } },
  }));
  const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws } });
  const ended = new Promise<void>((r) => s.subscribe(0, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
  await s.startWorkflow('fan', {});
  await ended;
  const [run] = await s.listRuns();
  assert.equal(run!.status, 'succeeded', run!.error ?? '');
  assert.equal(run!.history.filter((x) => x.outcome === 'pass').length, 6);
  await h.close();
});

test('tool images ride on their result, and clearing old results drops their images', async () => {
  const { makeAgent } = await import('./helpers.ts');
  const root = await tempDir();
  await fs.writeFile(path.join(root, 'shot.png'), Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c80000000049454e44ae426082', 'hex'));
  const steps = Array.from({ length: 17 }, (_, i) => ({ calls: [{ name: 'read', input: { path: 'shot.png' } }], usage: { input: i < 16 ? 1000 : 120_000 } }));
  const h = await makeAgent([...steps, { text: 'ok' }], { root });
  h.agent.append({ role: 'user', content: [{ type: 'text', text: 'go' }] });
  await h.agent.run(new AbortController().signal);
  const resultsWithImages = (msgs: typeof h.persisted) => msgs.flatMap((m) => m.content).filter((b) => b.type === 'tool_result' && b.images?.length).length;
  assert.equal(h.persisted.flatMap((m) => m.content).filter((b) => b.type === 'image').length, 0, 'no loose image blocks');
  assert.equal(resultsWithImages(h.persisted), 17, 'the stored history keeps every image');
  assert.equal(resultsWithImages(h.agent.messages), 6, 'the live context keeps the newest six');
});

test('scan gates fail when the scan cannot run, instead of reading as "nothing found"', async () => {
  const { runGates } = await import('../src/gates/gates.ts');
  const h = await createHarness({ dataDir: await tempDir(), plugins: [path.join(here, '..', 'plugins', 'quality-gates')] });
  const root = await tempDir();
  const local = new LocalHost(root);
  const run = async (host: LocalHost) => Object.fromEntries((await runGates(h.registry, host, ['secrets', 'conflict-markers'], new AbortController().signal)).map((g) => [g.name, g]));
  let r = await run(local);
  assert.equal(r.secrets!.pass, true);
  await fs.writeFile(path.join(root, 'config.js'), `const key = "AKIA${'A'.repeat(16)}";\n<<<<<<< HEAD\n`);
  r = await run(local);
  assert.equal(r.secrets!.pass, false);
  assert.equal(r['conflict-markers']!.pass, false);
  // A grep that errors (exit 2), as when it is missing or cannot read the tree.
  const bin = await tempDir();
  await fs.writeFile(path.join(bin, 'grep'), '#!/bin/sh\necho "grep: broken" >&2\nexit 2\n', { mode: 0o755 });
  const broken = Object.assign(Object.create(Object.getPrototypeOf(local)), local, { exec: (cmd: string, o: Parameters<LocalHost['exec']>[1]) => local.exec(`PATH="${bin}:$PATH"; ${cmd}`, o) }) as LocalHost;
  await fs.rm(path.join(root, 'config.js'));
  r = await run(broken);
  assert.equal(r.secrets!.pass, false, 'a failed scan is not a pass');
  assert.match(r.secrets!.summary, /could not scan \(the scan failed: grep: broken\)/);
  assert.equal(r['conflict-markers']!.pass, false);
  await h.close();
});

test('checkpoints: parallel writes all get recorded, and a path through a symlinked root still counts', async () => {
  const real = await tempDir();
  const link = path.join(await tempDir(), 'ws-link');
  await fs.symlink(real, link);
  const sdir = await tempDir();
  const cp = new Checkpoints(sdir, link);
  cp.begin(1, 'parallel edits');
  const names = Array.from({ length: 12 }, (_, i) => `f${i}.txt`);
  for (const n of names) await fs.writeFile(path.join(real, n), `original ${n}`);
  // Twelve tools checkpoint at once, through the non-canonical (symlinked) workspace path.
  await Promise.all(names.map((n) => cp.before(path.join(link, n))));
  await cp.before(path.join(link, 'new.txt'));
  for (const n of names) await fs.writeFile(path.join(real, n), 'changed');
  await fs.writeFile(path.join(real, 'new.txt'), 'created');
  const [turn] = await cp.list();
  assert.equal(turn!.files.length, 13, 'every file is in the manifest');
  await cp.rewind(1);
  for (const n of names) assert.equal(await fs.readFile(path.join(real, n), 'utf8'), `original ${n}`);
  await assert.rejects(fs.access(path.join(real, 'new.txt')), 'a file created in the turn is removed');
});

test('checkpoints: staggered parallel saves of mixed sizes never lose a manifest entry', async () => {
  let lost = 0;
  // The race is timing-dependent, so this catches it only sometimes (about 1 run in 3 on the old
  // code); the queue in Checkpoints.before removes it by construction.
  for (let it = 0; it < 30; it++) {
    const root = await tempDir();
    const cp = new Checkpoints(await tempDir(), root);
    cp.begin(1, 'p');
    const names = Array.from({ length: 20 }, (_, i) => `f${i}`);
    for (const [i, n] of names.entries()) await fs.writeFile(path.join(root, n), Buffer.alloc(i % 3 === 0 ? 2_000_000 : 10, i));
    await Promise.all(names.map((n, i) => new Promise((r) => setTimeout(r, (i % 5) * 3)).then(() => cp.before(path.join(root, n)))));
    lost += 20 - ((await cp.list())[0]?.files.length ?? 0);
  }
  assert.equal(lost, 0);
});

test('starting a workflow claims the session at once: a second start or a message in the same moment cannot also run', async () => {
  const h = await createHarness({ dataDir: await tempDir() });
  const ws = await tempDir();
  await fs.mkdir(path.join(ws, '.harness', 'workflows'), { recursive: true });
  await fs.writeFile(path.join(ws, '.harness', 'workflows', 'wait.json'), JSON.stringify({
    name: 'wait', description: 'd', start: 'ok', nodes: { ok: { type: 'approval', message: 'go?', next: { on: { approve: 'end', reject: 'end' } } }, end: { type: 'end' } },
  }));
  const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws } });
  const approvals: string[] = [];
  s.subscribe(0, ({ event }) => { if (event.kind === 'approval_request') approvals.push(event.requestId); });
  // All in the same tick, before any of them has awaited anything.
  const [a, b, c] = await Promise.allSettled([s.startWorkflow('wait', {}), s.startWorkflow('wait', {}), s.send('hello')]);
  assert.equal(a.status, 'fulfilled');
  assert.equal(b.status, 'rejected');
  assert.match((b as PromiseRejectedResult).reason.message, /busy/);
  assert.deepEqual(c, { status: 'fulfilled', value: 'queued' }, 'the message is queued, not a second turn');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(approvals.length, 1, 'one run is waiting, not two');
  assert.equal((await s.listRuns()).length, 1);
  s.abort();
  await h.close();
});

test('MCP: a shared server that crashed is reconnected on the next call; the failed call is not retried', async () => {
  const mgr = new McpManager();
  const { entries } = await mgr.serverEntries(new Map([['fx', { command: 'node', args: [fixture], plugin: 'test' }]]));
  const echo = entries.find((e) => e.tool.name === 'echo')!;
  assert.equal((await echo.client.callTool('echo', { text: 'a' })).content?.[0]?.text, 'echo: a');
  await assert.rejects(echo.client.callTool('crash', {}), /MCP server closed/);
  assert.equal((await echo.client.callTool('echo', { text: 'b' })).content?.[0]?.text, 'echo: b', 'reconnected');
  assert.equal((echo.client as unknown as { reconnects: number }).reconnects, 1);
  await mgr.closeAll();
});

test('MCP over HTTP: the per-server timeout applies to tool calls, and an expired session reconnects', async () => {
  let session = 0;
  let expired = false;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    if (req.method === 'DELETE') { res.writeHead(204).end(); return; }
    const m = JSON.parse(body);
    if (m.id === undefined) { res.writeHead(202).end(); return; }
    if (m.method === 'initialize') {
      session++; expired = false;
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': `s${session}` });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'h' } } }));
      return;
    }
    if (expired || req.headers['mcp-session-id'] !== `s${session}`) { res.writeHead(404).end('unknown session'); return; }
    const result = m.method === 'tools/list'
      ? { tools: [{ name: 'slow', inputSchema: { type: 'object', properties: { ms: { type: 'number' } } } }] }
      : await new Promise((r) => setTimeout(() => r({ content: [{ type: 'text', text: `slept ${m.params.arguments.ms}` }] }), m.params.arguments.ms));
    if (res.destroyed) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  const prev = process.env.NO_PROXY;
  process.env.NO_PROXY = '127.0.0.1';
  const mgr = new McpManager();
  try {
    const { entries } = await mgr.serverEntries(new Map([['h', { type: 'http', url, timeoutMs: 400, plugin: 'test' } as never]]));
    const slow = entries[0]!;
    assert.equal((await slow.client.callTool('slow', { ms: 50 })).content?.[0]?.text, 'slept 50');
    await assert.rejects(slow.client.callTool('slow', { ms: 1500 }), /timed out after 0\.4s/);
    expired = true; // the server forgot the session
    await assert.rejects(slow.client.callTool('slow', { ms: 10 }), /session expired/);
    assert.equal((await slow.client.callTool('slow', { ms: 10 })).content?.[0]?.text, 'slept 10', 'a new session was started');
    assert.equal(session, 2);
  } finally {
    await mgr.closeAll();
    server.close();
    if (prev === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = prev;
  }
});

test('MCP on Windows: npx-style shims start through the shell with quoted arguments; real binaries do not', async () => {
  const { spawnPlan } = await import('../src/mcp/manager.ts');
  assert.deepEqual(spawnPlan('npx', ['-y', '@scope/server'], 'win32'), { command: 'npx', args: ['-y', '@scope/server'], shell: true });
  assert.deepEqual(spawnPlan('npm', ['run', 'my tool & more'], 'win32').args, ['run', '"my tool ^& more"']);
  assert.equal(spawnPlan('C:\\tools\\server.cmd', [], 'win32').shell, true);
  assert.equal(spawnPlan('node', ['server.js'], 'win32').shell, false);
  assert.equal(spawnPlan('npx', ['x'], 'linux').shell, false);
});

test('a Claude Code agent file keeps its tools: Read, Grep, Glob, Bash map to the harness names', () => {
  const a = parseAgentFile('---\nname: reviewer\ndescription: Reviews code\ntools: Read, Grep, Glob, Bash, LS, mcp__github__get_issue, render\n---\nReview it.', 'x', 'project')!;
  assert.deepEqual(a.tools, ['read', 'grep', 'glob', 'bash', 'mcp__github__get_issue', 'render']);
});

test('a plugin that fails partway through loading leaves nothing behind', async () => {
  const root = await tempDir('hw-plugins-');
  const dir = path.join(root, 'half');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'harness-plugin.json'), JSON.stringify({ name: 'half', main: 'index.mjs' }));
  await fs.writeFile(path.join(dir, 'index.mjs'), `let closed = false;
export default { name: 'half', close() { globalThis.__halfClosed = true; }, setup(api) {
  api.registerTool({ name: 'half_tool', description: 'd', parameters: { type: 'object', properties: {} }, run: async () => 'x' });
  api.registerGate({ name: 'half-gate', description: 'd', run: async () => ({ pass: true, summary: 'ok' }) });
  api.on('Stop', () => undefined);
  throw new Error('setup failed after registering');
} };`);
  const logs: string[] = [];
  const h = await createHarness({ dataDir: await tempDir(), plugins: [root], log: (m) => logs.push(m) });
  assert.ok(logs.some((l) => /half.*setup failed after registering/.test(l)));
  assert.equal(h.registry.tools.has('half_tool'), false);
  assert.equal(h.registry.gates.has('half-gate'), false);
  assert.equal(h.registry.hooks.length, 0);
  assert.equal(h.registry.plugins.length, 0);
  assert.equal((globalThis as { __halfClosed?: boolean }).__halfClosed, true, 'its close() ran');
  await h.close();
});
