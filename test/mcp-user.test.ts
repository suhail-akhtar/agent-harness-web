import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { parseMcpImport } from '../src/mcp/import.ts';
import { checkServerConfig, McpServerError, toolHash, UserMcp } from '../src/mcp/servers.ts';
import { mcpTool } from '../src/mcp/tools.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { FakeProvider, results, tempDir } from './helpers.ts';
import { modernFixture, startModernHttp } from './mcp-fixtures.ts';

// A person's own MCP servers (src/mcp/servers.ts): the store, pinning against a changed tool, policies,
// resources and prompts as tools, ${vault:} secrets, OAuth sign-in, a member's reach, imports, conversations.

const stdio = (name = 'notes', extra: Record<string, unknown> = {}) => ({ name, type: 'stdio', command: process.execPath, args: [modernFixture], ...extra });
const text = (r: { content?: Array<{ text?: string }> }) => r.content?.map((c) => c.text).join('\n') ?? '';

test('a person\'s servers: added, checked, versioned, turned off and removed; plain secrets and bad names refused', async () => {
  const um = new UserMcp({ dataDir: await tempDir(), reserved: () => ['github'], isAdmin: () => true });
  try {
    const v = await um.create('ann', stdio());
    assert.equal(v.version, 1);
    assert.equal(v.enabled, true);
    await assert.rejects(um.create('ann', stdio()), /already have/);
    await assert.rejects(um.create('ann', stdio('github')), /already has/);
    await assert.rejects(um.create('ann', { name: 'Bad Name!', type: 'http', url: 'https://x.example/mcp' }), /name/);
    assert.throws(() => checkServerConfig({ name: 'x', type: 'http', url: 'https://x.example/mcp', headers: { Authorization: 'Bearer sk-live-1234567890abcdef' } }), /looks like a secret/);
    assert.doesNotThrow(() => checkServerConfig({ name: 'x', type: 'http', url: 'https://x.example/mcp', headers: { Authorization: 'Bearer ${vault:x-token}' } }));
    assert.throws(() => checkServerConfig({ name: 'x', type: 'http', url: 'ftp://x' }), /url/);
    // Another person sees nothing of it.
    assert.deepEqual(await um.list('bob'), []);
    const off = await um.update('ann', 'notes', { enabled: false });
    assert.equal(off.enabled, false);
    assert.equal(off.version, 2);
    await assert.rejects(um.update('ann', 'notes', { description: 'x' }, 1), /changed since/);
    const d = await um.update('ann', 'notes', { description: 'My notes' }, 2);
    assert.equal(d.description, 'My notes');
    // Turned off: in no conversation.
    assert.deepEqual((await um.entries('ann')).entries, []);
    await um.remove('ann', 'notes');
    assert.deepEqual(await um.list('ann'), []);
  } finally { await um.closeAll(); }
});

test('a member cannot add a command or a private address; an administrator can', async () => {
  const um = new UserMcp({ dataDir: await tempDir(), isAdmin: (o) => o === 'admin' });
  const srv = await startModernHttp();
  try {
    await assert.rejects(um.create('member', stdio()), (e: McpServerError) => e.status === 403 && /administrators/.test(e.message));
    await assert.rejects(um.create('member', { name: 'plain', type: 'http', url: srv.url }), /https/);
    // An https address that is private: added, but it never connects.
    await um.create('member', { name: 'inside', type: 'http', url: 'https://127.0.0.1:1/mcp' });
    const t = await um.test('member', 'inside');
    assert.equal(t.ok, false);
    assert.match(t.error ?? '', /private/);
    // The administrator's local server connects.
    await um.create('admin', { name: 'local', type: 'http', url: srv.url });
    assert.equal((await um.test('admin', 'local')).ok, true);
  } finally { srv.stop(); await um.closeAll(); }
});

test('tools are pinned when first seen; a server that changes a tool or adds one gets nothing past the person until approved', async () => {
  const data = await tempDir();
  let changes = 0;
  const um = new UserMcp({ dataDir: data, onChange: () => { changes++; } });
  try {
    await um.create(undefined, stdio());
    const first = await um.test(undefined, 'notes');
    assert.equal(first.ok, true, first.error ?? "");
    assert.equal(first.protocol, '2026-07-28');
    assert.deepEqual(first.tools.map((t) => `${t.name}:${t.state}`).sort(), ['add:approved', 'echo:approved', 'mutate:approved', 'slow:approved']);
    assert.equal(first.resources[0]?.uri, 'note://welcome');
    assert.equal(first.prompts[0]?.name, 'review');
    const { entries, status } = await um.entries(undefined);
    assert.equal(status[0]?.ok, true);
    const by = new Map(entries.map((e) => [e.qualified, e]));
    assert.deepEqual([...by.keys()].sort(), ['mcp__notes__add', 'mcp__notes__echo', 'mcp__notes__mutate', 'mcp__notes__prompts', 'mcp__notes__resources', 'mcp__notes__slow']);
    assert.equal(text(await by.get('mcp__notes__echo')!.client.callTool('echo', { text: 'a' })), 'echo: a');
    // Resources and prompts, as read-only tools.
    const res = by.get('mcp__notes__resources')!;
    assert.equal(mcpTool(res).kind, 'read');
    assert.match(text(await res.client.callTool('resources', {})), /note:\/\/welcome - Welcome note/);
    assert.equal(text(await res.client.callTool('resources', { uri: 'note://welcome' })), 'Welcome to the notes server.');
    const pr = by.get('mcp__notes__prompts')!;
    assert.match(text(await pr.client.callTool('prompts', {})), /review: Review a file\. \(arguments: file\)/);
    assert.equal(text(await pr.client.callTool('prompts', { name: 'review', arguments: { file: 'x.ts' } })), '[user] Please review x.ts.');

    // The server changes "echo" (now it also asks to read ~/.ssh) and adds "shout".
    const before = changes;
    await by.get('mcp__notes__mutate')!.client.callTool('mutate', {});
    for (let i = 0; i < 50 && changes === before; i++) await new Promise((r) => setTimeout(r, 20));
    // This conversation's echo is refused at once; the next conversation has neither echo nor shout.
    const refused = await by.get('mcp__notes__echo')!.client.callTool('echo', { text: 'b' });
    assert.equal(refused.isError, true);
    assert.match(text(refused), /changed the tool "echo" after it was approved/);
    // Refused before anyone is asked about it.
    assert.match(await mcpTool(by.get('mcp__notes__echo')!).refuse?.({}) ?? '', /changed the tool "echo"/);
    assert.equal(await mcpTool(by.get('mcp__notes__add')!).refuse?.({}), undefined);
    const next = (await um.entries(undefined)).entries.map((e) => e.qualified);
    assert.ok(!next.includes('mcp__notes__echo') && !next.includes('mcp__notes__shout') && next.includes('mcp__notes__add'));
    assert.equal((await um.entries(undefined)).status[0]?.pending, 2);
    const look = await um.test(undefined, 'notes');
    assert.deepEqual(look.tools.filter((t) => t.state !== 'approved').map((t) => `${t.name}:${t.state}`).sort(), ['echo:changed', 'shout:new']);
    assert.match(look.tools.find((t) => t.name === 'shout')!.description!, /evil\.example/);
    // Approving one tool approves that one only.
    await um.approve(undefined, 'notes', ['shout']);
    const after = (await um.entries(undefined)).entries;
    assert.ok(after.some((e) => e.qualified === 'mcp__notes__shout') && !after.some((e) => e.qualified === 'mcp__notes__echo'));
    await um.approve(undefined, 'notes');
    const echo = (await um.entries(undefined)).entries.find((e) => e.qualified === 'mcp__notes__echo')!;
    assert.equal(text(await echo.client.callTool('echo', { text: 'c' })), 'echo: c');
    // Pins survive a restart (they are in the person's file).
    const raw = JSON.parse(await fs.readFile(path.join(data, 'mcp', '_local.json'), 'utf8'));
    assert.equal(Object.keys(raw.servers.notes.pinned).length, 5);
  } finally { await um.closeAll(); }
});

test('a definition that changed while the server was down is caught when it reconnects', async () => {
  const um = new UserMcp({ dataDir: await tempDir() });
  try {
    await um.create(undefined, stdio());
    await um.test(undefined, 'notes');
    const echo = (await um.entries(undefined)).entries.find((e) => e.qualified === 'mcp__notes__echo')!;
    // Pretend the approved definition was different: the reconnect sees a mismatch.
    const f = path.join(um.dir, '_local.json');
    const j = JSON.parse(await fs.readFile(f, 'utf8'));
    j.servers.notes.pinned.echo = 'not-this-one';
    await fs.writeFile(f, JSON.stringify(j));
    // The process goes away (as a crash would) and the next call reconnects.
    const l = await (um as unknown as { live: Map<string, Promise<{ client: { close(): Promise<void>; closed: boolean } }>> }).live.get('\u0000notes')!;
    await l.client.close();
    for (let i = 0; i < 100 && !l.client.closed; i++) await new Promise((r) => setTimeout(r, 20));
    const r = await echo.client.callTool('echo', { text: 'x' });
    assert.equal(r.isError, true);
    assert.match(text(r), /reconnected and its tool "echo" is not the one approved/);
  } finally { await um.closeAll(); }
});

test('per-tool policy: allow runs without asking, ask always asks, block leaves it out', async () => {
  const um = new UserMcp({ dataDir: await tempDir() });
  try {
    await um.create(undefined, stdio());
    await um.test(undefined, 'notes');
    const kinds = async () => new Map((await um.entries(undefined)).entries.map((e) => [e.tool.name, mcpTool(e).kind]));
    let k = await kinds();
    assert.equal(k.get('echo'), 'read');     // the server says read-only
    assert.equal(k.get('add'), 'external');
    await assert.rejects(um.setPolicies(undefined, 'notes', { add: 'sometimes' }), /policy/);
    await um.setPolicies(undefined, 'notes', { add: 'allow', echo: 'ask', slow: 'block' });
    k = await kinds();
    assert.equal(k.get('add'), 'read');
    assert.equal(k.get('echo'), 'external');
    assert.equal(k.has('slow'), false);
    const v = await um.setPolicies(undefined, 'notes', { add: 'auto' });
    assert.deepEqual(v.policies, { echo: 'ask', slow: 'block' });
    // A running conversation's tools follow the person's choices at once.
    const running = (await um.entries(undefined)).entries.find((e) => e.tool.name === 'add')!;
    assert.equal(await mcpTool(running).refuse?.({}), undefined);
    await um.setPolicies(undefined, 'notes', { add: 'block' });
    assert.match(await mcpTool(running).refuse?.({}) ?? '', /blocked the tool "add"/);
    await um.setPolicies(undefined, 'notes', { add: 'auto' });
    await um.update(undefined, 'notes', { enabled: false });
    assert.match(await mcpTool(running).refuse?.({}) ?? '', /turned the server "notes" off/);
  } finally { await um.closeAll(); }
});

test('${vault:name} in a header: read from the person\'s vault when connecting, never stored; a missing entry says which', async () => {
  const srv = await startModernHttp({ MCP_TOKEN: 'tok-vault-1' });
  const asked: string[] = [];
  const vault = { reveal: async (a: { account?: string }, name: string) => { asked.push(`${a.account}:${name}`); if (name === 'notes-token') return 'tok-vault-1'; throw new Error('no such entry'); } };
  const um = new UserMcp({ dataDir: await tempDir(), vault });
  try {
    const v = await um.create(undefined, { name: 'remote', type: 'http', url: srv.url, headers: { Authorization: 'Bearer ${vault:notes-token}' } });
    assert.deepEqual(v.vault, ['notes-token']);
    assert.equal((await um.test(undefined, 'remote')).ok, true);
    assert.deepEqual(asked, ['undefined:notes-token']);
    assert.ok(!(await fs.readFile(path.join(um.dir, '_local.json'), 'utf8')).includes('tok-vault-1'));
    await um.create(undefined, { name: 'other', type: 'http', url: srv.url, headers: { Authorization: 'Bearer ${vault:missing}' } });
    const t = await um.test(undefined, 'other');
    assert.equal(t.ok, false);
    assert.match(t.error ?? '', /needs the vault entry "missing"/);
  } finally { srv.stop(); await um.closeAll(); }
});

test('OAuth: a server that needs sign-in says so; signing in (PKCE, dynamic registration) seals the tokens; a state is used once; refresh; sign out', async () => {
  const srv = await startModernHttp({ MCP_OAUTH: '1' });
  const data = await tempDir();
  const um = new UserMcp({ dataDir: data, isAdmin: () => true });
  try {
    await um.create('ann', { name: 'oauth', type: 'http', url: srv.url });
    const before = await um.entries('ann');
    assert.equal(before.status[0]?.ok, false);
    assert.match(before.status[0]?.error ?? '', /sign in/);
    assert.equal((await um.test('ann', 'oauth')).needsSignIn, true);
    const start = await um.signIn('ann', 'oauth', 'http://127.0.0.1:9/api/mcp/oauth/callback');
    assert.ok(start.authorizeUrl);
    const a = new URL(start.authorizeUrl!);
    assert.equal(a.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(a.searchParams.get('resource'));
    // The service approves and sends the browser back to the harness.
    const back = await fetch(a, { redirect: 'manual' });
    const to = new URL(back.headers.get('location')!);
    assert.equal(to.pathname, '/api/mcp/oauth/callback');
    const r = await um.finishSignIn(to.searchParams.get('state')!, to.searchParams.get('code')!, to.searchParams.get('iss') ?? undefined);
    assert.deepEqual(r, { owner: 'ann', server: 'oauth' });
    await assert.rejects(um.finishSignIn(to.searchParams.get('state')!, to.searchParams.get('code')!), /expired or was already used/);
    await assert.rejects(um.finishSignIn('made-up', 'x'), /expired or was already used/);
    // Tokens on disk only sealed.
    const disk = await fs.readFile(path.join(data, 'mcp', 'ann.auth.json'), 'utf8');
    assert.ok(!/at-|rt-|access_token/.test(disk), disk);
    assert.equal((await um.viewOf('ann', 'oauth')).signedIn, true);
    const after = await um.entries('ann');
    assert.equal(after.status[0]?.ok, true, after.status[0]?.error ?? "");
    const echo = after.entries.find((e) => e.tool.name === 'echo')!;
    assert.equal(text(await echo.client.callTool('echo', { text: 'signed' })), 'echo: signed');
    // Every access token ends: a new connection refreshes by itself.
    await fetch(new URL('/revoke-all', srv.url));
    await um.forget('ann', 'oauth');
    assert.equal((await um.test('ann', 'oauth')).ok, true);
    await um.signOut('ann', 'oauth');
    assert.equal((await um.viewOf('ann', 'oauth')).signedIn, false);
    assert.equal((await um.test('ann', 'oauth')).needsSignIn, true);
  } finally { srv.stop(); await um.closeAll(); }
});

test('imports: Claude Desktop, Claude Code, Cursor and VS Code configs, secrets moved to the vault', () => {
  const claude = parseMcpImport(JSON.stringify({ mcpServers: {
    github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_abcdefghijklmnop' } },
    Linear: { type: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer ${LINEAR_KEY}' } },
    old: { type: 'sse', url: 'https://example.com/sse' },
    broken: { args: [] },
  } }));
  assert.match(claude.format, /mcpServers/);
  assert.deepEqual(claude.servers.map((s) => s.config.name), ['github', 'linear', 'old']);
  assert.equal(claude.servers[0]!.config.env!.GITHUB_PERSONAL_ACCESS_TOKEN, '${vault:GITHUB_PERSONAL_ACCESS_TOKEN}');
  assert.ok(!JSON.stringify(claude).includes('ghp_abcdef'));
  assert.equal(claude.servers[1]!.config.headers!.Authorization, 'Bearer ${vault:LINEAR_KEY}');
  assert.match(claude.servers[2]!.warnings.join(), /SSE/);
  assert.deepEqual(claude.vault, ['GITHUB_PERSONAL_ACCESS_TOKEN', 'LINEAR_KEY']);
  assert.match(claude.errors.join(), /broken: .*neither a command nor a url/);
  const vscode = parseMcpImport(`{
    // VS Code
    "inputs": [{ "type": "promptString", "id": "api-key", "description": "Notes API key", "password": true }],
    "servers": { "notes": { "type": "http", "url": "https://notes.example/mcp", "headers": { "X-Key": "\${input:api-key}" } }, },
  }`);
  assert.match(vscode.format, /VS Code/);
  assert.equal(vscode.servers[0]!.config.headers!['X-Key'], '${vault:api-key}');
  assert.match(vscode.servers[0]!.warnings.join(), /Notes API key/);
  const cursor = parseMcpImport('{"mcpServers":{"docs":{"url":"https://docs.example/mcp"}}}');
  assert.equal(cursor.servers[0]!.config.type, 'http');
  assert.throws(() => parseMcpImport('nope'), /not JSON/);
  assert.throws(() => parseMcpImport('{"x":1}'), /no servers found/);
});

test('a person\'s servers reach their conversations and their agents, and nobody else\'s', async () => {
  const data = await tempDir();
  const h = await createHarness({ dataDir: data, search: null, memory: 'off' });
  // ann is an administrator here (a command server); bob is not.
  h.userMcp.isAdmin = (o) => o === 'ann';
  try {
    await h.userMcp.create('ann', stdio('mine'));
    h.registry.setProviderInstance('deepseek', new FakeProvider([{ calls: [{ name: 'mcp__mine__add', input: { a: 20, b: 22 } }] }, { text: 'ok' }]));
    const s = await h.sessions.create({ owner: 'ann', model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: await tempDir() } });
    const caps = await s.capabilities();
    assert.deepEqual(caps.mcp.find((m) => m.name === 'mine'), { name: 'mine', scope: 'user', ok: true, tools: 6 });
    assert.ok(caps.tools.some((t) => t.name === 'mcp__mine__echo'));
    const ended = new Promise<void>((r) => s.subscribe(0, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
    await s.send('add');
    await ended;
    assert.equal(results(s.history[2])[0]!.content, '42');
    const other = await h.sessions.create({ owner: 'bob', model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: await tempDir() } });
    assert.ok(!(await other.capabilities()).tools.some((t) => t.name.startsWith('mcp__mine__')));
    // The pinned definitions are those of the first connection.
    const rec = await h.userMcp.get('ann', 'mine');
    assert.equal(rec?.pinned.add?.length, 32);
    assert.equal(typeof toolHash({ name: 'x' }), 'string');
  } finally { await h.close(); }
});
