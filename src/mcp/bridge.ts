// The harness's MCP server over stdio, for an app that starts a command instead of opening an address (Claude
// Desktop's config, some IDEs): this process speaks MCP on its stdin and stdout and hands every call to the
// harness's /mcp over HTTP with the person's token.
//
//   HARNESS_TOKEN=<your access token> node <harness>/src/mcp/bridge.ts --url http://127.0.0.1:8787/mcp
//   HARNESS_TOKEN=<token> node bridge.ts --endpoint-file <file>   (the desktop app writes its engine's address there)
//
// The token comes from the environment, never the command line (other people on the computer can read a
// command line).
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import fs from 'node:fs';
import { HttpTransport, McpClient } from './client.ts';

const at = process.argv.indexOf('--url');
const ef = process.argv.indexOf('--endpoint-file');
let url = at > 0 ? process.argv[at + 1] : process.env.HARNESS_MCP_URL;
if (!url && ef > 0) {
  try { url = (JSON.parse(fs.readFileSync(process.argv[ef + 1]!, 'utf8')) as { url?: string }).url; } catch {
    process.stderr.write('Agent Harness is not running (or "Use your agents elsewhere" is off): open the app and try again.\n');
    process.exit(1);
  }
}
const token = process.env.HARNESS_TOKEN;
if (!url || !token) {
  process.stderr.write('usage: HARNESS_TOKEN=<token> node bridge.ts --url http://<harness>/mcp\n');
  process.exit(2);
}

// Each call waits as long as its run may (an agent's work can take many minutes).
const remote = new McpClient(new HttpTransport(url, { authorization: `Bearer ${token}` }), { callTimeoutMs: 3_600_000 });
try { await remote.initialize(); } catch (e) {
  process.stderr.write(`could not reach the harness at ${url}: ${(e as Error).message}\n`);
  process.exit(1);
}
const tools = await remote.listTools();
process.stderr.write(`agent-harness bridge: ${tools.length} tools from ${url}\n`);

serveStdio(() => {
  const server = new McpServer({ name: 'agent-harness', version: '0.3.0', title: 'Agent Harness' }, {
    ...(remote.instructions ? { instructions: remote.instructions } : {}),
    supportedProtocolVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'],
  });
  for (const t of tools) {
    server.registerTool(t.name, {
      ...(t.title ? { title: t.title } : {}),
      description: t.description ?? t.name,
      inputSchema: fromJsonSchema((t.inputSchema ?? { type: 'object' }) as never),
      ...(t.annotations ? { annotations: t.annotations } : {}),
    } as never, (async (args: Record<string, unknown>, ctx: { mcpReq: { signal: AbortSignal } }) => {
      try { return await remote.callTool(t.name, args, ctx.mcpReq.signal); } catch (e) {
        return { isError: true, content: [{ type: 'text', text: `The harness did not answer: ${(e as Error).message}` }] };
      }
    }) as never);
  }
  return server;
});
