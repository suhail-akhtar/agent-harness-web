import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The modern MCP test server (test/fixtures/mcp-modern.mjs, on the official SDK), for the MCP tests.
const here = path.dirname(fileURLToPath(import.meta.url));
export const modernFixture = path.join(here, 'fixtures', 'mcp-modern.mjs');

/** The modern fixture over HTTP: its URL and a stop. */
export async function startModernHttp(env: Record<string, string> = {}): Promise<{ url: string; stop: () => void; child: ChildProcessWithoutNullStreams }> {
  const child = spawn(process.execPath, [modernFixture, '--http', '0'], { env: { ...process.env, ...env } });
  const port = await new Promise<number>((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); const m = /listening (\d+)/.exec(out); if (m) resolve(Number(m[1])); });
    child.on('exit', (c) => reject(new Error(`fixture exited ${c}`)));
  });
  return { url: `http://127.0.0.1:${port}/mcp`, stop: () => child.kill(), child };
}
