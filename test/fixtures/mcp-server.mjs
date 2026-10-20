// A minimal MCP server over stdio for tests. MCP_TOOLS sets how many tools it
// offers (echo, add, then filler tools), to exercise inline vs deferred loading.
import readline from 'node:readline';

const count = Number(process.env.MCP_TOOLS ?? 3);
const tools = [
  { name: 'echo', description: 'Echo the text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
  { name: 'add', description: 'Add two numbers.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
];
for (let i = tools.length; i < count; i++) tools.push({ name: `widget_${i}`, description: `Manage widget number ${i} in the inventory.`, inputSchema: { type: 'object', properties: { id: { type: 'string' } } } });

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return; // notifications
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } });
  if (m.method === 'tools/list') {
    // Two pages, to exercise the cursor.
    const half = Math.ceil(tools.length / 2);
    if (!m.params?.cursor) return send({ jsonrpc: '2.0', id: m.id, result: { tools: tools.slice(0, half), nextCursor: tools.length > half ? 'p2' : undefined } });
    return send({ jsonrpc: '2.0', id: m.id, result: { tools: tools.slice(half) } });
  }
  if (m.method === 'tools/call') {
    const { name, arguments: a } = m.params;
    if (name === 'echo') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `echo: ${a.text}` }] } });
    if (name === 'add') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: String(a.a + a.b) }] } });
    if (name === 'crash') process.exit(1); // dies without answering, like a server that crashed
    return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `${name} done` }] } });
  }
  send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unknown method' } });
});
