import http from 'node:http';
import type { AddressInfo } from 'node:net';

// A local stand-in for a Chat Completions platform (Moonshot, Z.ai): records
// every request and answers each with what the test scripts - an SSE stream,
// a JSON body or an error status with headers.

export interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }
export type Reply = { status?: number; json?: unknown; sse?: unknown[]; raw?: string; headers?: Record<string, string>; done?: boolean };

export async function mockServer(reply: (seen: Seen, n: number) => Reply) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const s: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: data ? JSON.parse(data) : {} };
      seen.push(s);
      const r = reply(s, seen.length);
      if (r.sse) {
        res.writeHead(r.status ?? 200, { 'content-type': 'text/event-stream', ...r.headers });
        for (const c of r.sse) res.write(`data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`);
        res.end(r.done === false ? '' : 'data: [DONE]\n\n');
      } else {
        res.writeHead(r.status ?? 200, { 'content-type': 'application/json', ...r.headers });
        res.end(r.raw ?? JSON.stringify(r.json ?? {}));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** One streamed chunk with a delta (and optionally a finish reason and usage). */
export const delta = (d: Record<string, unknown>, finish: string | null = null, usage?: unknown) =>
  ({ id: 'cmpl-1', object: 'chat.completion.chunk', created: 1, choices: [{ index: 0, delta: d, finish_reason: finish }], ...(usage ? { usage } : {}) });
