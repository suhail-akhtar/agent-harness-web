// An MCP server (Model Context Protocol), made with Agent Harness on the official TypeScript SDK.
// What it offers is in spec.json next to this file: its tools, what each one does, and the settings it reads
// from the environment. This file runs it; to change a tool, change spec.json.
//
//   node server.ts                 stdio: how Claude Desktop, Claude Code, Cursor and VS Code start it
//   node server.ts --http 3000     streamable HTTP at http://127.0.0.1:3000/mcp
//                                  (MCP_HTTP_TOKEN: a bearer token it then requires; MCP_HTTP_HOST: where it listens)
//
// It speaks the 2026-07-28 protocol and the 2025 handshake. Settings (keys, addresses) come from the environment,
// never from spec.json.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer, createMcpHandler, fromJsonSchema } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Args = Record<string, unknown>;
interface Annotations { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }
type Run =
  | { kind: 'http'; method: string; url: string; query?: string[]; body?: 'args' | string[]; headers?: Record<string, string> }
  | { kind: 'command'; command: string; args: string[]; timeoutMs?: number }
  | { kind: 'sql'; sql: string; params?: string[] }
  | { kind: 'code'; code: string };
interface ToolDef { name: string; title?: string; description: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown>; annotations?: Annotations; run: Run }
interface Spec {
  name: string; title?: string; version: string; description: string; instructions?: string;
  env?: Array<{ name: string; description: string; required?: boolean; secret?: boolean; default?: string }>;
  database?: { kind: 'sqlite' | 'duckdb'; path: string; write?: boolean };
  tools: ToolDef[];
}

const here = path.dirname(fileURLToPath(import.meta.url));
const SPEC = JSON.parse(fs.readFileSync(path.join(here, 'spec.json'), 'utf8')) as Spec;
const MAX_TEXT = 100_000;

/** ${NAME} from the environment, else its default (a missing one is an error the tool returns, not a crash). */
function fromEnv(s: string): string {
  return s.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, k: string) => {
    const v = process.env[k] || SPEC.env?.find((e) => e.name === k)?.default;
    if (v === undefined) throw new Error(`the setting ${k} is not set (an environment variable of this server)`);
    return v;
  });
}
/** {name} from the arguments. */
const fill = (s: string, args: Args, encode: (v: string) => string) => s.replace(/\{([A-Za-z0-9_]+)\}/g, (_m, k: string) => {
  if (args[k] === undefined || args[k] === null) throw new Error(`the argument ${k} is required`);
  return encode(String(args[k]));
});
const cut = (t: string) => (t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}\n[... ${t.length - MAX_TEXT} more characters cut]` : t);
const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: cut(t) }], ...(isError ? { isError: true } : {}) });

async function httpCall(run: Extract<Run, { kind: 'http' }>, args: Args) {
  const used = new Set<string>();
  const url = new URL(fill(fromEnv(run.url), args, (v) => encodeURIComponent(v)));
  for (const m of run.url.matchAll(/\{([A-Za-z0-9_]+)\}/g)) used.add(m[1]!);
  for (const q of run.query ?? []) { used.add(q); if (args[q] !== undefined && args[q] !== null) url.searchParams.set(q, typeof args[q] === 'object' ? JSON.stringify(args[q]) : String(args[q])); }
  const headers: Record<string, string> = { accept: 'application/json, text/plain;q=0.9, */*;q=0.5' };
  for (const [k, v] of Object.entries(run.headers ?? {})) headers[k] = fromEnv(v);
  let body: string | undefined;
  if (run.body && !/^(GET|HEAD)$/i.test(run.method)) {
    const picked = run.body === 'args' ? Object.fromEntries(Object.entries(args).filter(([k]) => !used.has(k))) : Object.fromEntries(run.body.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
    body = JSON.stringify(picked);
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(url, { method: run.method.toUpperCase(), headers, ...(body ? { body } : {}), signal: AbortSignal.timeout(60_000) });
  const raw = await res.text();
  let shown = raw;
  try { shown = JSON.stringify(JSON.parse(raw), null, 1); } catch { /* not JSON */ }
  return res.ok ? text(shown || `(${res.status}, no content)`) : text(`HTTP ${res.status} ${res.statusText}\n${shown}`, true);
}

function commandCall(run: Extract<Run, { kind: 'command' }>, args: Args) {
  const argv = run.args.map((a) => fill(fromEnv(a), args, (v) => v));
  return new Promise<ReturnType<typeof text>>((resolve) => {
    // No shell: each argument reaches the program as it is.
    execFile(fromEnv(run.command), argv, { timeout: run.timeoutMs ?? 60_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) resolve(text(`${err.message}\n${stderr}`.trim(), true));
      else resolve(text(stdout || stderr || '(no output)'));
    });
  });
}

let db: Promise<{ all(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> }> | undefined;
function database() {
  const d = SPEC.database;
  if (!d) throw new Error('this server has no database');
  return (db ??= (async () => {
    const file = fromEnv(d.path);
    if (d.kind === 'sqlite') {
      const { DatabaseSync } = await import('node:sqlite');
      const conn = new DatabaseSync(file, { readOnly: !d.write });
      return { all: async (sql: string, params: unknown[]) => conn.prepare(sql).all(...(params as never[])) as Record<string, unknown>[] };
    }
    const { DuckDBInstance } = await import('@duckdb/node-api' as string) as { DuckDBInstance: { create(p: string, o?: Record<string, string>): Promise<{ connect(): Promise<{ runAndReadAll(sql: string, v?: unknown[]): Promise<{ getRowObjectsJson(): Record<string, unknown>[] }> }> }> } };
    const conn = await (await DuckDBInstance.create(file, d.write ? {} : { access_mode: 'READ_ONLY' })).connect();
    return { all: async (sql: string, params: unknown[]) => (await conn.runAndReadAll(sql, params.length ? params : undefined)).getRowObjectsJson() };
  })());
}
const plain = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x))) as Json;
/** Rows as a result: as text, and as structured content. */
async function rowsOf(sql: string, params: unknown[]) {
  const rows = plain(await (await database()).all(sql, params));
  return { content: [{ type: 'text' as const, text: cut(JSON.stringify(rows, null, 1)) }], structuredContent: { rows } };
}
const sqlCall = (run: Extract<Run, { kind: 'sql' }>, args: Args) => rowsOf(run.sql, (run.params ?? []).map((p) => args[p] ?? null));

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...a: string[]) => (args: Args, ctx: unknown) => Promise<unknown>;
async function codeCall(t: ToolDef, run: Extract<Run, { kind: 'code' }>, args: Args) {
  const fn = new AsyncFunction('args', 'ctx', run.code);
  const out = await fn(args, { env: (k: string) => fromEnv(`\${${k}}`), fetch, query: rowsOf, log: (m: string) => process.stderr.write(`[${t.name}] ${m}\n`) });
  if (typeof out === 'string') return text(out);
  if (out && typeof out === 'object' && Array.isArray((out as { content?: unknown }).content)) return out as ReturnType<typeof text>;
  return { content: [{ type: 'text' as const, text: cut(JSON.stringify(out, null, 1) ?? 'null') }], ...(t.outputSchema && out && typeof out === 'object' ? { structuredContent: out as Record<string, Json> } : {}) };
}

function build(): McpServer {
  const server = new McpServer({ name: SPEC.name, version: SPEC.version, ...(SPEC.title ? { title: SPEC.title } : {}) }, {
    ...(SPEC.instructions ? { instructions: SPEC.instructions } : {}),
    supportedProtocolVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'],
  });
  for (const t of SPEC.tools) {
    // Schemas as JSON Schema (the spec's), validated by the SDK.
    const config = {
      ...(t.title ? { title: t.title } : {}),
      description: t.description,
      inputSchema: fromJsonSchema(t.inputSchema as never),
      ...(t.outputSchema ? { outputSchema: fromJsonSchema(t.outputSchema as never) } : {}),
      ...(t.annotations ? { annotations: t.annotations } : {}),
    };
    server.registerTool(t.name, config as never, async (args: Args) => {
      try {
        switch (t.run.kind) {
          case 'http': return await httpCall(t.run, args);
          case 'command': return await commandCall(t.run, args);
          case 'sql': return await sqlCall(t.run, args);
          case 'code': return await codeCall(t, t.run, args);
        }
      } catch (e) { return text((e as Error).message, true); }
    });
  }
  return server;
}

const at = process.argv.indexOf('--http');
if (at < 0) serveStdio(() => build());
else {
  const port = Number(process.argv[at + 1] ?? 3000);
  const host = process.env.MCP_HTTP_HOST ?? '127.0.0.1';
  const token = process.env.MCP_HTTP_TOKEN;
  const handler = createMcpHandler(() => build());
  const srv = http.createServer(async (req, res) => {
    if (token && req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401, { 'www-authenticate': 'Bearer' }).end('unauthorized'); return; }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const headers = Object.fromEntries(Object.entries(req.headers).filter((e): e is [string, string] => typeof e[1] === 'string'));
    const response = await handler.fetch(new Request(`http://${req.headers.host ?? host}${req.url}`, { method: req.method, headers, ...(body.length && req.method !== 'GET' && req.method !== 'HEAD' ? { body } : {}) }));
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    if (response.body) for await (const c of response.body) res.write(c);
    res.end();
  });
  // The address on stdout once listening (port 0: the one it was given).
  srv.listen(port, host, () => process.stdout.write(`${SPEC.name} on http://${host}:${(srv.address() as { port: number }).port}/mcp\n`));
}
