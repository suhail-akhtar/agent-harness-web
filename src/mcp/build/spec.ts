// What a built MCP server offers, as data (spec.json beside the runtime, src/mcp/build/template/server.ts): its
// tools, what each one does (an HTTP call, a command, SQL, or code), and the settings it reads from the
// environment. Generators fill it from an OpenAPI document, a database, a command or a description; the
// person reviews it; the harness writes, checks and packs the server from it.

export type JsonSchema = Record<string, unknown>;
export interface ToolAnnotations { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }
export type ToolRun =
  | { kind: 'http'; method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; url: string; query?: string[]; body?: 'args' | string[]; headers?: Record<string, string> }
  | { kind: 'command'; command: string; args: string[]; timeoutMs?: number }
  | { kind: 'sql'; sql: string; params?: string[] }
  | { kind: 'code'; code: string };
export interface BuildTool {
  name: string; title?: string; description: string;
  inputSchema: JsonSchema; outputSchema?: JsonSchema;
  annotations: ToolAnnotations;
  run: ToolRun;
  /** Arguments for a safe call that shows the tool works (the check runs it when the tool is read-only). */
  example?: Record<string, unknown>;
}
/** A setting the server reads from its environment; `default` (never for a secret) when it is not set, such as a public API's address. */
export interface BuildEnv { name: string; description: string; required?: boolean; secret?: boolean; default?: string }
export interface BuildSpec {
  name: string; title?: string; version: string; description: string; instructions?: string;
  env: BuildEnv[];
  database?: { kind: 'sqlite' | 'duckdb'; path: string; write?: boolean };
  tools: BuildTool[];
}

export class BuildSpecError extends Error {}

export const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const SERVER_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const MAX_TOOLS = 80;

/** A name for a tool from free text: snake_case, at most 64. */
export function toolName(s: string): string {
  const n = s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
  return n || 'tool';
}

/** A spec from anywhere (a person's edit, a model's draft), checked: what a client and the runtime rely on. */
export function checkBuildSpec(x: unknown): BuildSpec {
  if (!x || typeof x !== 'object') throw new BuildSpecError('a spec is an object');
  const o = x as Record<string, unknown>;
  const name = String(o.name ?? '').trim().toLowerCase();
  if (!SERVER_NAME.test(name)) throw new BuildSpecError('name: lowercase letters, digits and - (at most 40)');
  const description = String(o.description ?? '').trim();
  if (description.length < 10) throw new BuildSpecError('description: say what the server is for (a sentence)');
  const version = typeof o.version === 'string' && /^\d+\.\d+\.\d+/.test(o.version) ? o.version : '0.1.0';
  const env: BuildEnv[] = [];
  for (const e of Array.isArray(o.env) ? o.env as Array<Record<string, unknown>> : []) {
    const n = String(e?.name ?? '');
    if (!ENV_NAME.test(n)) throw new BuildSpecError(`env: "${n}" is not an environment variable name (A-Z, 0-9, _)`);
    if (env.some((x) => x.name === n)) continue;
    const dflt = typeof e.default === 'string' && e.default !== '' ? e.default.slice(0, 2000) : undefined;
    if (dflt && e.secret) throw new BuildSpecError(`env: ${n} is a secret: it has no default (the person sets it)`);
    env.push({ name: n, description: String(e.description ?? n).slice(0, 300), ...(e.required && !dflt ? { required: true } : {}), ...(e.secret ? { secret: true } : {}), ...(dflt ? { default: dflt } : {}) });
  }
  let database: BuildSpec['database'];
  if (o.database) {
    const d = o.database as Record<string, unknown>;
    if (d.kind !== 'sqlite' && d.kind !== 'duckdb') throw new BuildSpecError('database.kind is sqlite or duckdb');
    if (typeof d.path !== 'string' || !d.path) throw new BuildSpecError('database.path is a file (or ${SETTING})');
    database = { kind: d.kind, path: d.path, ...(d.write ? { write: true } : {}) };
  }
  if (!Array.isArray(o.tools) || !o.tools.length) throw new BuildSpecError('a server has at least one tool');
  if (o.tools.length > MAX_TOOLS) throw new BuildSpecError(`at most ${MAX_TOOLS} tools: fewer, broader tools work better for an agent`);
  const tools: BuildTool[] = [];
  for (const raw of o.tools as Array<Record<string, unknown>>) {
    const t = checkTool(raw, !!database);
    if (tools.some((x) => x.name === t.name)) throw new BuildSpecError(`two tools are named "${t.name}"`);
    tools.push(t);
  }
  // Every ${SETTING} a tool reads is declared (so the person and the configs know to set it).
  const declared = new Set(env.map((e) => e.name));
  const scan = JSON.stringify({ tools: tools.map((t) => t.run.kind === 'code' ? { ...t.run, code: '' } : t.run), database });
  for (const m of scan.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)) if (!declared.has(m[1]!)) env.push({ name: m[1]!, description: `Used by ${name}.`, required: true }), declared.add(m[1]!);
  for (const t of tools) if (t.run.kind === 'code') for (const m of t.run.code.matchAll(/ctx\.env\(\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\)/g)) if (!declared.has(m[1]!)) env.push({ name: m[1]!, description: `Used by ${t.name}.`, required: true }), declared.add(m[1]!);
  return {
    name, ...(typeof o.title === 'string' && o.title.trim() ? { title: o.title.trim().slice(0, 100) } : {}), version, description: description.slice(0, 1000),
    ...(typeof o.instructions === 'string' && o.instructions.trim() ? { instructions: o.instructions.trim().slice(0, 4000) } : {}),
    env, ...(database ? { database } : {}), tools,
  };
}

function checkTool(t: Record<string, unknown>, hasDb: boolean): BuildTool {
  const name = String(t?.name ?? '');
  if (!TOOL_NAME.test(name)) throw new BuildSpecError(`tool "${name}": a name is letters, digits, _ and - (at most 64)`);
  const description = String(t.description ?? '').trim();
  if (description.length < 10) throw new BuildSpecError(`tool ${name}: a description says what it does and when to use it`);
  const s = t.inputSchema as JsonSchema | undefined;
  const inputSchema: JsonSchema = s && typeof s === 'object' ? { ...s, type: 'object' } : { type: 'object', properties: {} };
  if (inputSchema.properties !== undefined && (typeof inputSchema.properties !== 'object' || Array.isArray(inputSchema.properties))) throw new BuildSpecError(`tool ${name}: inputSchema.properties is an object`);
  const r = t.run as Record<string, unknown> | undefined;
  if (!r || typeof r !== 'object') throw new BuildSpecError(`tool ${name}: run says what it does (http, command, sql or code)`);
  let run: ToolRun;
  if (r.kind === 'http') {
    const method = String(r.method ?? 'GET').toUpperCase() as ToolRun & { kind: 'http' } extends { method: infer M } ? M : never;
    if (!METHODS.includes(method as typeof METHODS[number])) throw new BuildSpecError(`tool ${name}: method is one of ${METHODS.join(', ')}`);
    if (typeof r.url !== 'string' || !/^(https?:\/\/|\$\{[A-Z][A-Z0-9_]*\})/.test(r.url)) throw new BuildSpecError(`tool ${name}: url starts with http(s):// or a \${SETTING}`);
    const strs = (v: unknown, what: string) => { if (v === undefined) return undefined; if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new BuildSpecError(`tool ${name}: ${what} is a list of argument names`); return v as string[]; };
    const headers = r.headers && typeof r.headers === 'object' ? Object.fromEntries(Object.entries(r.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)])) : undefined;
    for (const [k, v] of Object.entries(headers ?? {})) if (/authorization|key|token|secret/i.test(k) && !/\$\{[A-Z]/.test(v)) throw new BuildSpecError(`tool ${name}: header ${k} reads a setting (\${API_KEY}), never a written key`);
    run = { kind: 'http', method: method as 'GET', url: r.url, ...(strs(r.query, 'query') ? { query: strs(r.query, 'query') } : {}), ...(r.body === 'args' ? { body: 'args' as const } : strs(r.body, 'body') ? { body: strs(r.body, 'body') } : {}), ...(headers ? { headers } : {}) };
  } else if (r.kind === 'command') {
    if (typeof r.command !== 'string' || !r.command.trim()) throw new BuildSpecError(`tool ${name}: command is the program to run`);
    if (!Array.isArray(r.args) || r.args.some((a) => typeof a !== 'string')) throw new BuildSpecError(`tool ${name}: args is a list of text ({name} for an argument)`);
    run = { kind: 'command', command: r.command.trim(), args: r.args as string[], ...(typeof r.timeoutMs === 'number' ? { timeoutMs: Math.min(600_000, Math.max(1000, r.timeoutMs)) } : {}) };
  } else if (r.kind === 'sql') {
    if (!hasDb) throw new BuildSpecError(`tool ${name}: a sql tool needs the server's database`);
    if (typeof r.sql !== 'string' || !r.sql.trim()) throw new BuildSpecError(`tool ${name}: sql is the statement (? for each parameter)`);
    const params = Array.isArray(r.params) ? (r.params as unknown[]).map(String) : [];
    if ((r.sql.match(/\?/g) ?? []).length !== params.length) throw new BuildSpecError(`tool ${name}: the statement has ${(r.sql.match(/\?/g) ?? []).length} "?" and ${params.length} params`);
    run = { kind: 'sql', sql: r.sql.trim(), ...(params.length ? { params } : {}) };
  } else if (r.kind === 'code') {
    if (typeof r.code !== 'string' || !r.code.trim()) throw new BuildSpecError(`tool ${name}: code is the body of an async function (args, ctx)`);
    try { new Function('args', 'ctx', `return (async () => {\n${r.code}\n})`); } catch (e) { throw new BuildSpecError(`tool ${name}: the code does not parse: ${(e as Error).message}`); }
    run = { kind: 'code', code: r.code };
  } else throw new BuildSpecError(`tool ${name}: run.kind is http, command, sql or code`);
  const a = (t.annotations ?? {}) as Record<string, unknown>;
  const annotations: ToolAnnotations = {};
  for (const k of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) if (typeof a[k] === 'boolean') annotations[k] = a[k] as boolean;
  // What a read-only GET or SELECT is, said for the client (it asks less about those).
  if (annotations.readOnlyHint === undefined) {
    if (run.kind === 'http') annotations.readOnlyHint = run.method === 'GET';
    else if (run.kind === 'sql') annotations.readOnlyHint = /^\s*(select|with|pragma|describe|show|explain)\b/i.test(run.sql);
  }
  if (run.kind === 'http' && run.method === 'DELETE' && annotations.destructiveHint === undefined) annotations.destructiveHint = true;
  if (run.kind === 'http' && annotations.openWorldHint === undefined) annotations.openWorldHint = true;
  return {
    name, ...(typeof t.title === 'string' && t.title ? { title: t.title.slice(0, 100) } : {}), description: description.slice(0, 2000), inputSchema,
    ...(t.outputSchema && typeof t.outputSchema === 'object' ? { outputSchema: { ...(t.outputSchema as JsonSchema), type: 'object' } } : {}),
    annotations, run, ...(t.example && typeof t.example === 'object' ? { example: t.example as Record<string, unknown> } : {}),
  };
}

// ---- from an OpenAPI document --------------------------------------------------------------------------------

type OA = Record<string, unknown>;
const ref = (doc: OA, x: unknown, depth = 0): unknown => {
  if (depth > 12 || !x || typeof x !== 'object') return x;
  if (Array.isArray(x)) return x.map((v) => ref(doc, v, depth + 1));
  const o = x as OA;
  if (typeof o.$ref === 'string' && o.$ref.startsWith('#/')) {
    const target = o.$ref.slice(2).split('/').reduce<unknown>((a, k) => (a as OA | undefined)?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], doc);
    return ref(doc, target, depth + 1);
  }
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, ref(doc, v, depth + 1)]));
};

export interface OpenApiOperation { name: string; method: string; path: string; summary: string; readOnly: boolean }

/** The operations an OpenAPI 3 document offers (to choose from), and a spec for the chosen ones. */
export function fromOpenApi(docText: string, o: { name?: string; only?: string[]; baseSetting?: string; authHeader?: string } = {}): { spec: BuildSpec; operations: OpenApiOperation[]; skipped: string[] } {
  let doc: OA;
  try { doc = JSON.parse(docText) as OA; } catch { throw new BuildSpecError('the OpenAPI document is JSON (convert a YAML one first)'); }
  if (typeof doc.openapi !== 'string' || !doc.openapi.startsWith('3')) throw new BuildSpecError('an OpenAPI 3 document (it has "openapi": "3.x")');
  const info = (doc.info ?? {}) as OA;
  const baseSetting = o.baseSetting ?? 'API_BASE_URL';
  const servers = (doc.servers as Array<{ url?: string }> | undefined) ?? [];
  const base = servers[0]?.url ?? '';
  const operations: OpenApiOperation[] = [];
  const tools: BuildTool[] = [];
  const skipped: string[] = [];
  const env: BuildEnv[] = [{ name: baseSetting, description: `The API's address${base ? ` (for example ${base})` : ''}.`, required: true }];
  // An API key or bearer token, if the document says it uses one.
  const schemes = Object.values(((doc.components as OA | undefined)?.securitySchemes ?? {}) as Record<string, OA>);
  const bearer = schemes.find((s) => s.type === 'http' && String(s.scheme).toLowerCase() === 'bearer') ?? schemes.find((s) => s.type === 'oauth2');
  const apiKey = schemes.find((s) => s.type === 'apiKey' && s.in === 'header');
  const headers: Record<string, string> = {};
  if (o.authHeader) { headers[o.authHeader] = '${API_KEY}'; env.push({ name: 'API_KEY', description: 'The API key.', required: true, secret: true }); }
  else if (apiKey) { headers[String(apiKey.name)] = '${API_KEY}'; env.push({ name: 'API_KEY', description: `The API key (sent as ${String(apiKey.name)}).`, required: true, secret: true }); }
  else if (bearer) { headers.Authorization = 'Bearer ${API_TOKEN}'; env.push({ name: 'API_TOKEN', description: 'The API token (a bearer token).', required: true, secret: true }); }
  for (const [p, item] of Object.entries((doc.paths ?? {}) as Record<string, OA>)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const op = item?.[method] as OA | undefined;
      if (!op) continue;
      const name = toolName(String(op.operationId ?? `${method}_${p.replace(/\{[^}]+\}/g, 'by').replace(/\//g, '_')}`));
      const summary = String(op.summary ?? op.description ?? `${method.toUpperCase()} ${p}`).split('\n')[0]!.slice(0, 200);
      operations.push({ name, method: method.toUpperCase(), path: p, summary, readOnly: method === 'get' });
      if (o.only && !o.only.includes(name)) continue;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      const query: string[] = [];
      const params = [...((item.parameters as unknown[]) ?? []), ...((op.parameters as unknown[]) ?? [])].map((x) => ref(doc, x) as OA);
      let bad = '';
      for (const prm of params) {
        const n = String(prm.name ?? '');
        if (prm.in === 'header' || prm.in === 'cookie') { if (prm.required) bad = `a required ${String(prm.in)} parameter (${n})`; continue; }
        if (!/^[A-Za-z0-9_]+$/.test(n)) { if (prm.required) bad = `parameter "${n}" is not a usable argument name`; continue; }
        properties[n] = { ...(ref(doc, prm.schema) as OA ?? { type: 'string' }), ...(prm.description ? { description: String(prm.description).slice(0, 300) } : {}) };
        if (prm.required || prm.in === 'path') required.push(n);
        if (prm.in === 'query') query.push(n);
      }
      let body: 'args' | undefined;
      const rb = ref(doc, op.requestBody) as OA | undefined;
      const json = ((rb?.content ?? {}) as Record<string, OA>)['application/json'];
      if (rb && !json) bad = 'its body is not JSON';
      if (json) {
        const bs = ref(doc, json.schema) as OA | undefined;
        if (bs?.type === 'object' || bs?.properties) {
          for (const [k, v] of Object.entries((bs.properties ?? {}) as Record<string, unknown>)) if (!(k in properties)) properties[k] = v;
          for (const r of (bs.required as string[] | undefined) ?? []) if (!required.includes(r)) required.push(r);
          body = 'args';
        } else bad = 'its body is not a JSON object';
      }
      if (bad) { skipped.push(`${name}: ${bad}`); continue; }
      tools.push({
        // What it does (the document's words) and the call it makes.
        name, description: `${[op.summary, op.description].filter(Boolean).map((x) => String(x).trim().replace(/\.$/, '')).join('. ').slice(0, 1400) || 'Calls the API'} (${method.toUpperCase()} ${p}).`,
        inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
        annotations: { readOnlyHint: method === 'get', ...(method === 'delete' ? { destructiveHint: true } : {}), ...(method === 'get' || method === 'put' || method === 'delete' ? { idempotentHint: true } : {}), openWorldHint: true },
        run: { kind: 'http', method: method.toUpperCase() as 'GET', url: `\${${baseSetting}}${p}`, ...(query.length ? { query } : {}), ...(body ? { body } : {}), ...(Object.keys(headers).length ? { headers } : {}) },
      });
    }
  }
  if (!tools.length) throw new BuildSpecError(o.only ? 'none of the chosen operations could be made into tools' : 'the document has no operations that can be tools');
  const title = String(info.title ?? 'API');
  const spec = checkBuildSpec({
    name: o.name ?? toolName(title).replace(/_/g, '-').slice(0, 40), title, version: '0.1.0',
    description: String(info.description ?? `Tools for the ${title}.`).slice(0, 1000).padEnd(10, '.'),
    instructions: `Tools for the ${title}. Read-only tools are safe to call; the others change data in the service.`,
    env, tools,
  });
  return { spec, operations, skipped };
}

// ---- from a database --------------------------------------------------------------------------------------------

/** Tables and columns, as the database says (for the person to choose and for the tools' descriptions). */
export interface DbTable { name: string; columns: Array<{ name: string; type: string }> }

/**
 * A server over a database: list the tables, describe one, a read-only query (SELECT, WITH), and per chosen table a
 * "find" tool with its columns as filters. `write` adds an execute tool (marked destructive).
 */
export function fromDatabase(o: { name: string; kind: 'sqlite' | 'duckdb'; tables: DbTable[]; setting?: string; write?: boolean; description?: string }): BuildSpec {
  const setting = o.setting ?? 'DATABASE_PATH';
  const q = (n: string) => `"${n.replace(/"/g, '""')}"`;
  const list = o.kind === 'sqlite' ? "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name" : "SELECT table_name AS name, table_type AS type FROM information_schema.tables WHERE table_schema NOT IN ('information_schema','pg_catalog') ORDER BY table_name";
  const tools: Array<Record<string, unknown>> = [
    { name: 'list_tables', description: 'List the tables (and views) in the database. Start here to see what there is.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, idempotentHint: true }, run: { kind: 'sql', sql: list }, example: {} },
    { name: 'query', description: 'Run a read-only SQL query (SELECT or WITH) and get its rows. Use list_tables and the find tools first; add LIMIT for big tables.', inputSchema: { type: 'object', properties: { sql: { type: 'string', description: 'A SELECT or WITH statement.' } }, required: ['sql'] }, annotations: { readOnlyHint: true },
      run: { kind: 'code', code: "const sql = String(args.sql ?? '').trim();\nif (!/^(select|with)\\b/i.test(sql) || /;\\s*\\S/.test(sql)) return { content: [{ type: 'text', text: 'Only one SELECT or WITH statement.' }], isError: true };\nreturn ctx.query(sql, []);" },
      example: { sql: 'SELECT 1 AS one' } },
  ];
  for (const t of o.tables) {
    const filters = t.columns.slice(0, 30);
    tools.push({
      name: toolName(`find_${t.name}`).slice(0, 64), description: `Find rows of ${t.name} (columns: ${t.columns.map((c) => `${c.name} ${c.type}`).join(', ').slice(0, 600)}). Every filter is optional; at most "limit" rows (default 50).`,
      inputSchema: { type: 'object', properties: { ...Object.fromEntries(filters.map((c) => [c.name, { type: /int|real|num|dec|double|float/i.test(c.type) ? 'number' : 'string', description: `Rows whose ${c.name} equals this.` }])), limit: { type: 'number', description: 'At most this many rows (default 50, at most 500).' } } },
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: { kind: 'code', code: `const cols = ${JSON.stringify(filters.map((c) => c.name))};\nconst where = []; const params = [];\nfor (const c of cols) if (args[c] !== undefined && args[c] !== null && args[c] !== '') { where.push('"' + c.replace(/"/g, '""') + '" = ?'); params.push(args[c]); }\nconst limit = Math.min(500, Math.max(1, Number(args.limit) || 50));\nreturn ctx.query('SELECT * FROM ${q(t.name).replace(/'/g, "\\'")}' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' LIMIT ' + limit, params);` },
      example: { limit: 3 },
    });
  }
  if (o.write) tools.push({ name: 'execute', description: 'Run one statement that changes the database (INSERT, UPDATE, DELETE, CREATE). It cannot be undone: say what it will change first.', inputSchema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] }, annotations: { readOnlyHint: false, destructiveHint: true }, run: { kind: 'code', code: "const sql = String(args.sql ?? '').trim();\nif (/;\\s*\\S/.test(sql)) return { content: [{ type: 'text', text: 'One statement at a time.' }], isError: true };\nreturn ctx.query(sql, []);" } });
  return checkBuildSpec({
    name: o.name, version: '0.1.0', description: o.description ?? `Read ${o.write ? 'and change ' : ''}the ${o.kind === 'sqlite' ? 'SQLite' : 'DuckDB'} database: its tables, a find tool for each, and SQL queries.`,
    instructions: 'Start with list_tables, then the find tools; use query for joins and aggregates.',
    env: [{ name: setting, description: `The database file${o.kind === 'duckdb' ? ' (or a DuckDB connection string)' : ''}.`, required: true }],
    database: { kind: o.kind, path: `\${${setting}}`, ...(o.write ? { write: true } : {}) },
    tools,
  });
}
