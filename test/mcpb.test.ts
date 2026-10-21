import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { readZip } from '../src/mcp/mcpb.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { FakeProvider, results, tempDir } from './helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

/** A zip with deflated entries (enough of the format for .mcpb bundles). `mode` marks an entry as a Unix link. */
function zip(entries: { name: string; data: string | Buffer; link?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let off = 0;
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const comp = zlib.deflateRawSync(raw);
    const name = Buffer.from(e.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((e.link ? 0o120777 : 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(off, 42);
    locals.push(local, name, comp);
    centrals.push(central, name);
    off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

test('an MCP bundle (.mcpb) installs as an operator server: its tools reach new sessions, its config fills the environment, and it survives a restart', async () => {
  const server = await fs.readFile(path.join(here, 'fixtures', 'mcp-server.mjs'));
  const bundle = zip([
    { name: 'manifest.json', data: JSON.stringify({ manifest_version: '0.3', name: 'notes-ext', version: '1.2.0', description: 'Notes service', server: { type: 'node', entry_point: 'server/index.mjs', mcp_config: { command: 'node', args: ['${__dirname}/server/index.mjs'], env: { MCP_TOOLS: '${user_config.tool_count}' } } }, user_config: { tool_count: { type: 'number', title: 'Tool count', required: true } } }) },
    { name: 'server/index.mjs', data: server },
  ]);
  const data = await tempDir();
  let h = await createHarness({ dataDir: data, search: null, memory: 'off' });
  await assert.rejects(h.mcpb.install(bundle, {}), /needs "Tool count"/);
  const done = await h.mcpb.install(bundle, { tool_count: 5 });
  assert.equal(done.name, 'notes-ext');
  assert.equal((done.config as { command: string }).command, 'node', 'the manifest\'s own command');
  await h.close();
  // A new process: installed bundles are registered at start.
  h = await createHarness({ dataDir: data, search: null, memory: 'off' });
  h.registry.setProviderInstance('deepseek', new FakeProvider([{ calls: [{ name: 'mcp__notes-ext__add', input: { a: 2, b: 3 } }] }, { text: 'ok' }]));
  try {
    assert.deepEqual((await h.mcpb.list()).map((b) => b.name), ['notes-ext']);
    const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: await tempDir() } });
    const caps = await s.capabilities();
    assert.equal(caps.mcp.find((m) => m.name === 'notes-ext')?.ok, true, JSON.stringify(caps.mcp));
    const ended = new Promise<void>((r) => s.subscribe(0, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
    await s.send('check');
    await ended;
    assert.equal(results(s.history[2])[0]!.content, '5');
    // The value given at install reached the server's environment: it lists that many tools.
    assert.ok(caps.tools.some((t) => t.name === 'mcp__notes-ext__widget_4') && !caps.tools.some((t) => t.name === 'mcp__notes-ext__widget_5'));
    assert.equal(await h.mcpb.remove('notes-ext'), true);
    assert.equal(h.registry.mcpServers.has('notes-ext'), false);
  } finally { await h.close(); }
});

test('bundles that would leave their folder, hold links, or lack a manifest are refused', async () => {
  const root = await tempDir();
  const { installMcpb } = await import('../src/mcp/mcpb.ts');
  const mf = (name = 'x') => ({ name: 'manifest.json', data: JSON.stringify({ name, server: { type: 'node', entry_point: 'i.mjs' } }) });
  await assert.rejects(installMcpb(zip([mf(), { name: '../escape.txt', data: 'x' }]), root), /outside its folder/);
  await assert.rejects(installMcpb(zip([mf(), { name: 'C:/Windows/x.txt', data: 'x' }]), root), /outside its folder/);
  await assert.rejects(installMcpb(zip([mf(), { name: 'evil', data: '/etc/passwd', link: true }]), root), /holds a link/);
  await assert.rejects(installMcpb(zip([{ name: 'i.mjs', data: 'x' }]), root), /no manifest\.json/);
  await assert.rejects(installMcpb(zip([mf('../bad')]), root), /needs a name/);
  await assert.rejects(installMcpb(Buffer.from('not a zip'), root), /not a zip/);
  assert.deepEqual(readZip(zip([{ name: 'a/b.txt', data: 'hello' }])).map((f) => [f.name, f.data.toString()]), [['a/b.txt', 'hello']]);
});
