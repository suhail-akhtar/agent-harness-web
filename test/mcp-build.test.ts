import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { checkServer, packServer, writeServer } from '../src/mcp/build/builder.ts';
import { McpBuilder } from '../src/mcp/build/service.ts';
import { BuildSpecError, checkBuildSpec, fromDatabase, fromOpenApi } from '../src/mcp/build/spec.ts';
import { readZip } from '../src/mcp/mcpb.ts';
import { UserMcp } from '../src/mcp/servers.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { tempDir } from './helpers.ts';

// The MCP server builder (docs/agents-mcp/PLAN.md, phase 3): specs checked; servers from an OpenAPI document, a
// database and code, built, checked by the harness's own client (both eras, stdio and HTTP), packed as a .mcpb
// that installs, and added to the person's servers.

/** A small REST API (the "pets" of an OpenAPI document), with an API key it requires. */
async function petsApi(): Promise<{ url: string; stop: () => void; seen: string[] }> {
  const pets = [{ id: 1, name: 'Rex', kind: 'dog' }, { id: 2, name: 'Tom', kind: 'cat' }];
  const seen: string[] = [];
  const srv = http.createServer(async (req, res) => {
    seen.push(`${req.method} ${req.url} key=${req.headers['x-api-key'] ?? ''}`);
    if (req.headers['x-api-key'] !== 'k-123') { res.writeHead(401).end('{"error":"no key"}'); return; }
    const u = new URL(req.url!, 'http://x');
    const one = /^\/pets\/(\d+)$/.exec(u.pathname);
    let body = ''; for await (const c of req) body += c;
    res.setHeader('content-type', 'application/json');
    if (u.pathname === '/pets' && req.method === 'GET') { const k = u.searchParams.get('kind'); res.end(JSON.stringify(pets.filter((p) => !k || p.kind === k).slice(0, Number(u.searchParams.get('limit') ?? 10)))); return; }
    if (u.pathname === '/pets' && req.method === 'POST') { const p = { id: pets.length + 1, ...JSON.parse(body) }; pets.push(p); res.writeHead(201).end(JSON.stringify(p)); return; }
    if (one && req.method === 'GET') { const p = pets.find((x) => x.id === Number(one[1])); res.writeHead(p ? 200 : 404).end(JSON.stringify(p ?? { error: 'not found' })); return; }
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, stop: () => srv.close(), seen };
}

const OPENAPI = JSON.stringify({
  openapi: '3.1.0', info: { title: 'Pet Store', description: 'Pets for sale.' }, servers: [{ url: 'https://pets.example.com' }],
  components: { securitySchemes: { key: { type: 'apiKey', in: 'header', name: 'X-Api-Key' } }, schemas: { NewPet: { type: 'object', properties: { name: { type: 'string' }, kind: { type: 'string' } }, required: ['name'] } } },
  paths: {
    '/pets': {
      get: { operationId: 'listPets', summary: 'List pets', parameters: [{ name: 'kind', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }] },
      post: { operationId: 'createPet', summary: 'Add a pet', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/NewPet' } } } } },
    },
    '/pets/{petId}': {
      get: { operationId: 'getPet', summary: 'One pet by its id', parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'integer' } }] },
      delete: { operationId: 'deletePet', summary: 'Remove a pet', parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'X-Trace', in: 'header', required: true, schema: { type: 'string' } }] },
    },
  },
});

test('specs are checked: names, descriptions, written keys, SQL parameters, code that does not parse; settings a tool reads are declared', () => {
  const ok = { name: 'demo', description: 'A demo server for tests.', tools: [{ name: 'hello', description: 'Say hello to someone.', inputSchema: { type: 'object', properties: { who: { type: 'string' } } }, run: { kind: 'code', code: "return 'hello ' + args.who + ' from ' + ctx.env('GREETER');" } }] };
  const s = checkBuildSpec(ok);
  assert.deepEqual(s.env.map((e) => e.name), ['GREETER']);
  assert.throws(() => checkBuildSpec({ ...ok, name: 'Bad Name' }), BuildSpecError);
  assert.throws(() => checkBuildSpec({ ...ok, tools: [{ ...ok.tools[0], description: 'x' }] }), /description/);
  assert.throws(() => checkBuildSpec({ ...ok, tools: [{ ...ok.tools[0], run: { kind: 'code', code: 'return (' } }] }), /does not parse/);
  assert.throws(() => checkBuildSpec({ ...ok, tools: [{ ...ok.tools[0], run: { kind: 'http', method: 'GET', url: 'https://x.example/a', headers: { Authorization: 'Bearer sk-live-123' } } }] }), /reads a setting/);
  assert.throws(() => checkBuildSpec({ ...ok, database: { kind: 'sqlite', path: 'x.db' }, tools: [{ ...ok.tools[0], run: { kind: 'sql', sql: 'SELECT * FROM t WHERE a = ? AND b = ?', params: ['a'] } }] }), /2 "\?" and 1 params/);
  const h = checkBuildSpec({ ...ok, tools: [{ ...ok.tools[0], run: { kind: 'http', method: 'DELETE', url: '${BASE}/x' } }] });
  assert.deepEqual(h.tools[0]!.annotations, { readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  assert.deepEqual(h.env.map((e) => e.name), ['BASE']);
});

test('from an OpenAPI document: an operation each (path, query and body arguments), its API key as a setting, what cannot be a tool said', () => {
  const r = fromOpenApi(OPENAPI);
  assert.deepEqual(r.operations.map((o) => `${o.method} ${o.name}`), ['GET list_pets', 'POST create_pet', 'GET get_pet', 'DELETE delete_pet']);
  assert.deepEqual(r.spec.tools.map((t) => t.name), ['list_pets', 'create_pet', 'get_pet']);
  assert.match(r.skipped.join(), /delete_pet: a required header parameter/);
  const get = r.spec.tools.find((t) => t.name === 'get_pet')!;
  assert.deepEqual(get.run, { kind: 'http', method: 'GET', url: '${API_BASE_URL}/pets/{petId}', headers: { 'X-Api-Key': '${API_KEY}' } });
  assert.equal(get.annotations.readOnlyHint, true);
  const create = r.spec.tools.find((t) => t.name === 'create_pet')!;
  assert.deepEqual(create.inputSchema.required, ['name']);
  assert.equal((create.run as { body?: string }).body, 'args');
  assert.deepEqual(r.spec.env.map((e) => `${e.name}${e.secret ? '*' : ''}`), ['API_BASE_URL', 'API_KEY*']);
  assert.deepEqual(fromOpenApi(OPENAPI, { only: ['get_pet'] }).spec.tools.map((t) => t.name), ['get_pet']);
  assert.throws(() => fromOpenApi('{"swagger":"2.0"}'), /OpenAPI 3/);
});

test('an OpenAPI server built and checked by the harness\'s own client: both eras, stdio and HTTP, calls reach the API with its key', async () => {
  const api = await petsApi();
  const dir = await tempDir();
  try {
    const { spec } = fromOpenApi(OPENAPI);
    spec.tools.find((t) => t.name === 'list_pets')!.example = { kind: 'dog' };
    spec.tools.find((t) => t.name === 'get_pet')!.example = { petId: 2 };
    const files = await writeServer(dir, spec);
    assert.ok(files.includes('server.ts') && files.includes('manifest.json') && files.includes('configs/vscode-mcp.json'));
    const report = await checkServer(dir, spec, { API_BASE_URL: api.url, API_KEY: 'k-123' });
    assert.equal(report.ok, true, JSON.stringify(report.checks.filter((c) => !c.ok)));
    const names = report.checks.map((c) => c.name);
    for (const want of ['speaks MCP 2026-07-28', 'answers the 2025 handshake too', 'serves streamable HTTP', 'list_pets works (called with its example)', 'a call without its required arguments is answered as an error', 'an unknown tool is refused']) assert.ok(names.includes(want), want);
    assert.match(report.checks.find((c) => c.name === 'get_pet works (called with its example)')!.detail!, /Tom/);
    assert.ok(api.seen.some((l) => l === 'GET /pets?kind=dog key=k-123'), api.seen.join('\n'));
    // A missing setting: the tool says so (the server still starts and lists its tools).
    const bad = await checkServer(dir, spec, { API_KEY: 'k-123' });
    assert.equal(bad.ok, false);
    assert.match(bad.checks.find((c) => !c.ok)!.detail ?? '', /API_BASE_URL is not set/);
    // The configs for other clients.
    const vs = JSON.parse(await fs.readFile(path.join(dir, 'configs', 'vscode-mcp.json'), 'utf8'));
    assert.equal(vs.servers['pet-store'].env.API_KEY, '${input:api_key}');
    assert.equal(vs.inputs[0].password, true);
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.user_config.api_key.sensitive, true);
  } finally { api.stop(); }
});

test('a database server: tables found, a find tool each, read-only SQL (a write refused); checked on a real SQLite file', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'shop.db');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE orders (id INTEGER PRIMARY KEY, customer TEXT, total REAL); INSERT INTO orders (customer, total) VALUES ('ann', 12.5), ('bob', 7), ('ann', 3);");
  db.close();
  const um = new UserMcp({ dataDir: dir, isAdmin: () => true });
  const b = new McpBuilder(dir, um);
  const draft = await b.draft(undefined, { source: 'database', kind: 'sqlite', path: file });
  assert.deepEqual(draft.tables, [{ name: 'orders', columns: [{ name: 'id', type: 'INTEGER' }, { name: 'customer', type: 'TEXT' }, { name: 'total', type: 'REAL' }] }]);
  assert.deepEqual(draft.spec.tools.map((t) => t.name), ['list_tables', 'query', 'find_orders']);
  const rec = await b.build(undefined, draft.spec, { DATABASE_PATH: file }, 'database');
  assert.equal(rec.report!.ok, true, JSON.stringify(rec.report!.checks.filter((c) => !c.ok)));
  assert.match(rec.report!.checks.find((c) => c.name.startsWith('list_tables'))!.detail!, /orders/);
  // Added to the person's servers, its tools in their conversations.
  assert.deepEqual(await b.register(undefined, rec.name), { created: true });
  const t = await um.test(undefined, rec.name);
  assert.equal(t.ok, true, t.error ?? '');
  const entries = (await um.entries(undefined)).entries;
  const find = entries.find((e) => e.tool.name === 'find_orders')!;
  const r = await find.client.callTool('find_orders', { customer: 'ann' });
  assert.equal((r.structuredContent as { rows: unknown[] }).rows.length, 2);
  const q = entries.find((e) => e.tool.name === 'query')!;
  assert.match((await q.client.callTool('query', { sql: 'SELECT sum(total) AS s FROM orders' })).content![0]!.text!, /"s": 22\.5/);
  const refused = await q.client.callTool('query', { sql: 'DELETE FROM orders' });
  assert.equal(refused.isError, true);
  await um.closeAll();
  // A database opened read-only refuses a write even through a find tool's SQL.
  assert.equal(fromDatabase({ name: 'x', kind: 'sqlite', tables: [] }).database?.write, undefined);
});

test('a code server with a secret setting: built, its secret a vault reference (a plain one refused), packed as a .mcpb that the harness installs', async () => {
  const data = await tempDir();
  const vault = { reveal: async (_a: unknown, name: string) => { if (name === 'greeter-key') return 'very-secret'; throw new Error('no entry'); } };
  const um = new UserMcp({ dataDir: data, vault, isAdmin: () => true });
  const b = new McpBuilder(data, um);
  const spec = { name: 'greeter', description: 'Greets people politely.', env: [{ name: 'GREETER_KEY', description: 'A key.', secret: true, required: true }], tools: [{ name: 'greet', description: 'Greet someone by name.', inputSchema: { type: 'object', properties: { who: { type: 'string' } }, required: ['who'] }, annotations: { readOnlyHint: true }, run: { kind: 'code', code: "const k = ctx.env('GREETER_KEY');\nreturn `Hello, ${args.who}! (key of ${k.length} characters)`;" }, example: { who: 'Ann' } }] };
  await assert.rejects(b.build(undefined, spec, { GREETER_KEY: 'very-secret' }), /is a secret/);
  const rec = await b.build(undefined, spec, { GREETER_KEY: '${vault:greeter-key}' });
  assert.equal(rec.report!.ok, true, JSON.stringify(rec.report!.checks.filter((c) => !c.ok)));
  assert.match(rec.report!.checks.find((c) => c.name === 'greet works (called with its example)')!.detail!, /Hello, Ann! \(key of 11 characters\)/);
  // Never the value on disk.
  for (const f of ['settings.json', 'build.json', 'spec.json']) assert.ok(!(await fs.readFile(path.join(b.dir(undefined, 'greeter'), f), 'utf8')).includes('very-secret'), f);
  // A member may not build (it runs code here).
  um.isAdmin = () => false;
  await assert.rejects(b.build('member', spec, {}), /only administrators/);
  um.isAdmin = () => true;

  const packed = await b.pack(undefined, 'greeter');
  assert.ok(packed.bundle!.bytes > 10_000);
  const bundle = await b.bundle(undefined, 'greeter');
  const entries = readZip(bundle);
  assert.deepEqual(entries.map((e) => e.name).sort(), ['README.md', 'manifest.json', 'server/server.mjs', 'server/spec.json']);
  // The bundle stands alone: installed as Claude Desktop would (its settings asked for), it runs and answers.
  const h = await createHarness({ dataDir: await tempDir(), search: null, memory: 'off' });
  try {
    const inst = await h.mcpb.install(bundle, { greeter_key: 'from-install' });
    assert.equal(inst.name, 'greeter');
    const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: await tempDir() } });
    const caps = await s.capabilities();
    assert.equal(caps.mcp.find((m) => m.name === 'greeter')?.ok, true, JSON.stringify(caps.mcp));
    assert.ok(caps.tools.some((t) => t.name === 'mcp__greeter__greet'));
  } finally { await h.close(); }
  await b.remove(undefined, 'greeter');
  assert.deepEqual(await b.list(undefined), []);
});

test('a setting can have a default (a public address, never a secret): the server works without it; the configs and the bundle ask only for the rest', async () => {
  const api = await petsApi();
  const dir = await tempDir();
  try {
    assert.throws(() => checkBuildSpec({ name: 'x', description: 'A server for tests.', env: [{ name: 'KEY', description: 'k', secret: true, default: 'abc' }], tools: [{ name: 'a', description: 'Does a thing for tests.', run: { kind: 'code', code: 'return 1;' } }] }), /no default/);
    const { spec } = fromOpenApi(OPENAPI);
    spec.env = spec.env.map((e) => (e.name === 'API_BASE_URL' ? { name: e.name, description: e.description, default: api.url } : e));
    spec.tools.find((t) => t.name === 'list_pets')!.example = { kind: 'cat' };
    await writeServer(dir, spec);
    const report = await checkServer(dir, checkBuildSpec(spec), { API_KEY: 'k-123' });
    assert.equal(report.ok, true, JSON.stringify(report.checks.filter((c) => !c.ok)));
    const cfg = JSON.parse(await fs.readFile(path.join(dir, 'configs', 'mcp.json'), 'utf8'));
    assert.deepEqual(Object.keys(cfg.mcpServers['pet-store'].env), ['API_KEY']);
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.user_config), ['api_key']);
  } finally { api.stop(); }
});
