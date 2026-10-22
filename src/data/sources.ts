import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileFormat, Scalar, SourceSpec } from '../../packages/plugin-ui/src/bi.ts';
import { assertPublicUrl, publicFetch } from '../tools/web.ts';
import { DataError, lit, pathLit, qid } from './engine.ts';
import { readXlsx, sheetTable, type Cell, definedNames, rangeSheet } from './xlsx.ts';
import { decodeText, flattenRecords, parseLog, parseNdjson, sniffDelimiter, xmlRows } from './formats.ts';

// Reading sources. Each type turns into an extract reader: DuckDB SQL over a file (CSV, TSV, JSON,
// Parquet) or over rows the server took from a workbook, a database, an API or a plugin (written
// as newline-delimited JSON with explicit column types, so nothing is guessed twice). Databases
// are read in read-only transactions with a statement timeout; APIs only at the source's own
// host; secrets come from the key vault on the server and go nowhere else.

export interface SourceContext {
  /** The owner's data folder (temporary files, uploads). */
  home: string;
  /** Folders a file source may be in (the person's projects, uploads). */
  roots: string[];
  /** A vault entry's value, read as the owner, audited with the purpose. */
  secret(name: string, purpose: string): Promise<string>;
  /** Hosts (host or host:port) an API source may reach although they are private (tests, a local mock). */
  privateHosts: string[];
  /** A plugin's data source: its route, called in the server. */
  pluginData?(plugin: string, kind: string, params: Record<string, unknown>): Promise<unknown>;
  timeoutMs?: number;
}
export interface Reader { reader: string; cleanup(): Promise<void> }
const MAX_FETCH = 50 * 1024 * 1024;

export function formatOf(p: string, f?: FileFormat): FileFormat {
  if (f) return f;
  const ext = path.extname(p).toLowerCase().slice(1);
  if (ext === 'xlsx' || ext === 'xlsm') return 'xlsx';
  if (ext === 'tsv' || ext === 'tab') return 'tsv';
  if (ext === 'ndjson' || ext === 'jsonl') return 'ndjson';
  if (ext === 'json') return 'json';
  if (ext === 'xml') return 'xml';
  if (ext === 'log' || ext === 'evtx') return 'log';
  if (ext === 'geojson') return 'geojson';
  if (ext === 'parquet') return 'parquet';
  return 'csv';
}

/** A file path the owner may read: inside one of their roots, through links too. */
export async function allowedFile(p: string, roots: string[]): Promise<string> {
  if (!p || p.includes('\0')) throw new DataError('a file source needs a path');
  const abs = path.resolve(p);
  const real = await fs.realpath(abs).catch(() => { throw new DataError(`${p} was not found`, 404); });
  const st = await fs.stat(real);
  if (!st.isFile()) throw new DataError(`${p} is not a file`);
  for (const r of roots) {
    const root = await fs.realpath(r).catch(() => undefined);
    if (root && (real === root || real.startsWith(root.endsWith(path.sep) ? root : root + path.sep))) return real;
  }
  throw new DataError(`${p} is outside the folders this account may read (its projects and uploads)`, 403);
}

type ColType = 'BIGINT' | 'DOUBLE' | 'BOOLEAN' | 'DATE' | 'TIMESTAMP' | 'VARCHAR' | 'DECIMAL(38,10)';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TS = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** Types of columns from their values (mixed columns are text; JSON objects become their JSON text). */
export function inferTypes(columns: string[], rows: unknown[][], given: Record<string, ColType> = {}): ColType[] {
  return columns.map((c, i) => {
    if (given[c]) return given[c]!;
    let t: ColType | undefined;
    for (const r of rows) {
      const v = r[i];
      if (v === null || v === undefined || v === '') continue;
      const k: ColType = typeof v === 'number' ? (Number.isInteger(v) && Number.isSafeInteger(v) ? 'BIGINT' : 'DOUBLE') : typeof v === 'boolean' ? 'BOOLEAN' : typeof v === 'string' ? (ISO_DATE.test(v) ? 'DATE' : ISO_TS.test(v) ? 'TIMESTAMP' : 'VARCHAR') : v instanceof Date ? 'TIMESTAMP' : 'VARCHAR';
      if (!t) t = k;
      else if (t !== k) t = (t === 'BIGINT' && k === 'DOUBLE') || (t === 'DOUBLE' && k === 'BIGINT') ? 'DOUBLE' : (t === 'DATE' && k === 'TIMESTAMP') || (t === 'TIMESTAMP' && k === 'DATE') ? 'TIMESTAMP' : 'VARCHAR';
      if (t === 'VARCHAR') break;
    }
    return t ?? 'VARCHAR';
  });
}

/** Rows to a newline-delimited JSON file and the reader that loads it with these exact types. */
export async function rowsReader(home: string, columns: string[], rows: unknown[][], given: Record<string, ColType> = {}): Promise<Reader> {
  if (!columns.length) throw new DataError('the source gave no columns');
  const types = inferTypes(columns, rows, given);
  const dir = path.join(home, 'tmp');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${crypto.randomBytes(8).toString('hex')}.ndjson`);
  const fh = await fs.open(file, 'w');
  try {
    let buf = '';
    for (const r of rows) {
      const o: Record<string, unknown> = {};
      columns.forEach((c, i) => {
        let v = r[i];
        if (v instanceof Date) v = v.toISOString().replace('T', ' ').replace('Z', '');
        else if (typeof v === 'bigint') v = Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
        else if (v !== null && typeof v === 'object') v = JSON.stringify(v);
        else if (types[i] === 'VARCHAR' && v !== null && v !== undefined) v = String(v);
        else if (v === '') v = null;
        o[c] = v ?? null;
      });
      buf += `${JSON.stringify(o)}\n`;
      if (buf.length > 1 << 20) { await fh.write(buf); buf = ''; }
    }
    if (buf) await fh.write(buf);
  } finally { await fh.close(); }
  const cols = columns.map((c, i) => `${lit(c)}: ${lit(types[i]!)}`).join(', ');
  return { reader: `SELECT * FROM read_json(${pathLit(file)}, format = 'newline_delimited', columns = {${cols}}, maximum_object_size = 104857600)`, cleanup: () => fs.rm(file, { force: true }) };
}

const noCleanup = async () => {};

/** Picks the array at a dotted path ("data.items") in a JSON value. */
export function atPath(v: unknown, p?: string): unknown {
  if (!p) return v;
  let cur = v;
  for (const k of p.split('.').filter(Boolean)) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[k] : undefined;
  return cur;
}

/** JSON rows (objects, arrays with a header, {columns, rows}) as columns and rows; nested objects flattened unless `flatten` is false. */
export function jsonTable(v: unknown, o: { flatten?: boolean; unnest?: string } = {}): { columns: string[]; rows: unknown[][] } {
  if (v && typeof v === 'object' && !Array.isArray(v) && Array.isArray((v as { rows?: unknown }).rows)) {
    const o = v as { columns?: unknown[]; rows: unknown[] };
    if (Array.isArray(o.columns) && o.rows.every(Array.isArray)) return { columns: o.columns.map((c) => (typeof c === 'string' ? c : String((c as { name?: unknown })?.name ?? c))), rows: o.rows as unknown[][] };
    v = o.rows;
  }
  if (!Array.isArray(v)) throw new DataError('the data is not a list of rows (set rowsPath to the array inside the JSON, e.g. "data.items")');
  if (v.length && v.every(Array.isArray)) { const [head, ...rest] = v as unknown[][]; return { columns: head!.map(String), rows: rest }; }
  if (o.flatten !== false && v.some((r) => r && typeof r === 'object')) {
    const t = flattenRecords(v, { unnest: o.unnest });
    if (t.columns.length) return t;
  }
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const r of v) if (r && typeof r === 'object') for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); columns.push(k); }
  if (!columns.length && v.length) return { columns: ['value'], rows: v.map((x) => [x]) };
  return { columns, rows: v.map((r) => columns.map((c) => (r && typeof r === 'object' ? (r as Record<string, unknown>)[c] : undefined))) };
}

/** GeoJSON features as rows: their properties, the geometry type, and lon/lat for points (the shape stays in the file for maps). */
export function geoRows(g: unknown): { columns: string[]; rows: unknown[][] } {
  const feats = (g as { features?: unknown[] })?.features;
  if (!Array.isArray(feats)) throw new DataError('not a GeoJSON FeatureCollection');
  const props = feats.map((f) => ((f as { properties?: Record<string, unknown> }).properties ?? {}));
  const t = jsonTable(props);
  const extra = feats.map((f) => { const geo = (f as { geometry?: { type?: string; coordinates?: unknown } }).geometry; const pt = geo?.type === 'Point' && Array.isArray(geo.coordinates) ? geo.coordinates as number[] : undefined; return [geo?.type ?? null, pt?.[0] ?? null, pt?.[1] ?? null]; });
  return { columns: [...t.columns, 'geometry_type', 'lon', 'lat'], rows: t.rows.map((r, i) => [...r, ...extra[i]!]) };
}

/** A database source's table name or read-only query, as SQL for that database. */
function dbQuery(from: string | undefined, quote: (s: string) => string): string {
  const f = (from ?? '').trim();
  if (!f) throw new DataError('name the table (or a SELECT query) to read: "from"');
  if (/^(select|with)\b/i.test(f)) {
    if (/;\s*\S/.test(f.replace(/'[^']*'/g, "''"))) throw new DataError('one SELECT query only');
    return f.replace(/;\s*$/, '');
  }
  return `SELECT * FROM ${f.split('.').map(quote).join('.')}`;
}

// Postgres type OIDs -> DuckDB types (numeric kept exact as DECIMAL).
const PG_TYPES: Record<number, ColType> = { 16: 'BOOLEAN', 20: 'BIGINT', 21: 'BIGINT', 23: 'BIGINT', 700: 'DOUBLE', 701: 'DOUBLE', 1700: 'DECIMAL(38,10)', 1082: 'DATE', 1114: 'TIMESTAMP', 1184: 'TIMESTAMP' };

async function postgresRows(s: SourceSpec, from: string | undefined, ctx: SourceContext, since?: { column: string; cutoff: string }, list = false): Promise<{ columns: string[]; rows: unknown[][]; types: Record<string, ColType> } | string[]> {
  let pg: typeof import('pg');
  try { pg = (await import('pg')).default as unknown as typeof import('pg'); } catch { throw new DataError('Postgres sources need the pg package (npm install)', 503); }
  const password = s.secret ? await ctx.secret(s.secret, `read Postgres source ${s.name}`) : undefined;
  // Dates and numerics as text: converted with their types by DuckDB, nothing rounded on the way.
  const types = { getTypeParser: (oid: number) => (oid === 20 || oid === 21 || oid === 23 ? (v: string) => Number(v) : oid === 16 ? (v: string) => v === 't' : oid === 700 || oid === 701 ? (v: string) => Number(v) : (v: string) => v) };
  const client = new pg.Client({ host: s.host, port: s.port ?? 5432, database: s.database, user: s.user, password, ssl: s.ssl ? { rejectUnauthorized: true } : undefined, connectionTimeoutMillis: 10_000, types: types as never });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${Math.round(ctx.timeoutMs ?? 120_000)}`);
    if (list) return (await client.query("SELECT table_schema || '.' || table_name AS t FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1")).rows.map((r: { t: string }) => r.t);
    let q = dbQuery(from, (x) => `"${x.replace(/"/g, '""')}"`);
    if (since) q = `SELECT * FROM (${q}) AS t WHERE "${since.column.replace(/"/g, '""')}" >= '${since.cutoff.replace(/'/g, "''")}'`;
    const r = await client.query({ text: q, rowMode: 'array' });
    const columns = r.fields.map((f: { name: string }) => f.name);
    const t: Record<string, ColType> = {};
    for (const f of r.fields as Array<{ name: string; dataTypeID: number }>) t[f.name] = PG_TYPES[f.dataTypeID] ?? 'VARCHAR';
    return { columns, rows: r.rows as unknown[][], types: t };
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }
}

// mysql2 field types -> DuckDB types.
const MY_TYPES: Record<number, ColType> = { 1: 'BIGINT', 2: 'BIGINT', 3: 'BIGINT', 8: 'BIGINT', 9: 'BIGINT', 4: 'DOUBLE', 5: 'DOUBLE', 0: 'DECIMAL(38,10)', 246: 'DECIMAL(38,10)', 10: 'DATE', 7: 'TIMESTAMP', 12: 'TIMESTAMP', 16: 'BOOLEAN' };

async function mysqlRows(s: SourceSpec, from: string | undefined, ctx: SourceContext, since?: { column: string; cutoff: string }, list = false): Promise<{ columns: string[]; rows: unknown[][]; types: Record<string, ColType> } | string[]> {
  let my: typeof import('mysql2/promise');
  try { my = await import('mysql2/promise'); } catch { throw new DataError('MySQL sources need the mysql2 package (npm install)', 503); }
  const password = s.secret ? await ctx.secret(s.secret, `read MySQL source ${s.name}`) : undefined;
  const conn = await my.createConnection({ host: s.host, port: s.port ?? 3306, database: s.database, user: s.user, password, connectTimeout: 10_000, dateStrings: true, decimalNumbers: false, supportBigNumbers: true, bigNumberStrings: true, ...(s.ssl ? { ssl: {} } : {}) });
  try {
    await conn.query('SET SESSION TRANSACTION READ ONLY');
    await conn.query('START TRANSACTION READ ONLY');
    if (list) { const [rows] = await conn.query('SHOW TABLES'); return (rows as Record<string, string>[]).map((r) => Object.values(r)[0]!); }
    let q = dbQuery(from, (x) => `\`${x.replace(/`/g, '``')}\``);
    if (since) q = `SELECT * FROM (${q}) AS t WHERE \`${since.column.replace(/`/g, '``')}\` >= '${since.cutoff.replace(/'/g, "''")}'`;
    const [rows, fields] = await conn.query({ sql: q, rowsAsArray: true, timeout: ctx.timeoutMs ?? 120_000 });
    const f = fields as Array<{ name: string; columnType?: number; type?: number }>;
    const types: Record<string, ColType> = {};
    for (const x of f) types[x.name] = MY_TYPES[x.columnType ?? x.type ?? -1] ?? 'VARCHAR';
    return { columns: f.map((x) => x.name), rows: (rows as unknown[][]).map((r) => r.map((v, i) => (types[f[i]!.name] === 'BIGINT' && typeof v === 'string' && Number.isSafeInteger(Number(v)) ? Number(v) : v))), types };
  } finally {
    await conn.query('ROLLBACK').catch(() => {});
    await conn.end().catch(() => {});
  }
}

// SQL Server type names (tedious) -> DuckDB types.
const MS_TYPES: Record<string, ColType> = { Int: 'BIGINT', BigInt: 'BIGINT', SmallInt: 'BIGINT', TinyInt: 'BIGINT', IntN: 'BIGINT', Float: 'DOUBLE', Real: 'DOUBLE', FloatN: 'DOUBLE', Decimal: 'DECIMAL(38,10)', Numeric: 'DECIMAL(38,10)', DecimalN: 'DECIMAL(38,10)', NumericN: 'DECIMAL(38,10)', Money: 'DECIMAL(38,10)', SmallMoney: 'DECIMAL(38,10)', MoneyN: 'DECIMAL(38,10)', Date: 'DATE', DateTime: 'TIMESTAMP', DateTime2: 'TIMESTAMP', SmallDateTime: 'TIMESTAMP', DateTimeN: 'TIMESTAMP', DateTimeOffset: 'TIMESTAMP', Bit: 'BOOLEAN', BitN: 'BOOLEAN' };

/** SQL Server through tedious (a TDS driver, no ODBC): one SELECT inside a transaction that is rolled back. */
async function mssqlRows(s: SourceSpec, from: string | undefined, ctx: SourceContext, since?: { column: string; cutoff: string }, list = false): Promise<{ columns: string[]; rows: unknown[][]; types: Record<string, ColType> } | string[]> {
  let td: typeof import('tedious');
  try { td = await import('tedious'); } catch { throw new DataError('SQL Server sources need the tedious package (npm install)', 503); }
  const password = s.secret ? await ctx.secret(s.secret, `read SQL Server source ${s.name}`) : undefined;
  const conn = new td.Connection({ server: s.host!, authentication: { type: 'default', options: { userName: s.user, password } }, options: { port: s.port ?? 1433, database: s.database, encrypt: s.ssl !== false, trustServerCertificate: !s.ssl, readOnlyIntent: true, connectTimeout: 10_000, requestTimeout: ctx.timeoutMs ?? 120_000, rowCollectionOnRequestCompletion: false } });
  await new Promise<void>((res, rej) => { conn.on('connect', (e) => (e ? rej(new DataError(`SQL Server: ${e.message}`)) : res())); conn.connect(); });
  const run = (sql: string) => new Promise<{ columns: string[]; rows: unknown[][]; types: Record<string, ColType> }>((res, rej) => {
    const out = { columns: [] as string[], rows: [] as unknown[][], types: {} as Record<string, ColType> };
    const req = new td.Request(sql, (e) => (e ? rej(new DataError(`SQL Server: ${e.message}`)) : res(out)));
    req.on('columnMetadata', (cols) => { const list = (Array.isArray(cols) ? cols : Object.values(cols)) as Array<{ colName: string; type: { name: string } }>; out.columns = list.map((c) => c.colName); for (const c of list) out.types[c.colName] = MS_TYPES[c.type.name] ?? 'VARCHAR'; });
    req.on('row', (cols) => { const list = (Array.isArray(cols) ? cols : Object.values(cols)) as Array<{ value: unknown }>; out.rows.push(list.map((c) => c.value)); });
    conn.execSql(req);
  });
  try {
    await new Promise<void>((res, rej) => conn.beginTransaction((e) => (e ? rej(new DataError(`SQL Server: ${e.message}`)) : res())));
    if (list) return (await run("SELECT TABLE_SCHEMA + '.' + TABLE_NAME AS t FROM INFORMATION_SCHEMA.TABLES ORDER BY 1")).rows.map((r) => String(r[0]));
    let q = dbQuery(from, (x) => `[${x.replace(/]/g, ']]')}]`);
    if (since) q = `SELECT * FROM (${q}) AS t WHERE [${since.column.replace(/]/g, ']]')}] >= '${since.cutoff.replace(/'/g, "''")}'`;
    return await run(q);
  } finally {
    await new Promise<void>((res) => conn.rollbackTransaction(() => res())).catch(() => {});
    conn.close();
  }
}

async function sqliteRows(file: string, from: string | undefined, list = false): Promise<{ columns: string[]; rows: unknown[][] } | string[]> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (list) return (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY 1").all() as Array<{ name: string }>).map((r) => r.name);
    const stmt = db.prepare(dbQuery(from, (x) => `"${x.replace(/"/g, '""')}"`));
    const cols = stmt.columns().map((c) => c.name);
    const rows = (stmt.all() as Array<Record<string, unknown>>).map((r) => cols.map((c) => r[c] ?? null));
    return { columns: cols, rows };
  } finally { db.close(); }
}

/** An API source's request (secret attached on the server only). */
async function httpGet(s: SourceSpec, ctx: SourceContext, pageUrl?: string): Promise<{ type: string; body: Buffer; link?: string }> {
  if (!s.url) throw new DataError('an http source needs a url');
  const u = new URL(pageUrl ?? s.url);
  if (u.host !== new URL(s.url).host) throw new DataError('a page of an API source is on its own host only');
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new DataError('only http(s) URLs');
  const hostKey = u.port ? `${u.hostname}:${u.port}` : u.hostname;
  const isPrivate = ctx.privateHosts.includes(hostKey) || ctx.privateHosts.includes(u.hostname);
  if (!isPrivate) await assertPublicUrl(u.toString()).catch((e: Error) => { throw new DataError(`${e.message} (private addresses need HARNESS_DATA_PRIVATE_HOSTS)`, 403); });
  const headers: Record<string, string> = { accept: 'application/json, text/csv;q=0.9, */*;q=0.5', ...(s.headers ?? {}) };
  for (const k of Object.keys(headers)) if (/^(host|cookie|authorization)$/i.test(k) && !(k.toLowerCase() === 'authorization' && !s.secret)) delete headers[k];
  if (s.secret) {
    const v = await ctx.secret(s.secret, `call the API of source ${s.name}`);
    const a = s.auth ?? 'bearer';
    if (a === 'bearer') headers.authorization = `Bearer ${v}`;
    else if (a === 'basic') headers.authorization = `Basic ${Buffer.from(v.includes(':') ? v : `${v}:`).toString('base64')}`;
    else if (a === 'header') headers[s.authName || 'x-api-key'] = v;
    else u.searchParams.set(s.authName || 'api_key', v);
  }
  const init: RequestInit = { method: s.method ?? 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(ctx.timeoutMs ?? 60_000), ...(s.method === 'POST' && s.body ? { body: s.body } : {}) };
  const res = isPrivate ? await fetch(u, init) : await publicFetch(u, init);
  if (res.status >= 300 && res.status < 400) throw new DataError(`${u.host} answered with a redirect (${res.status}); use the final URL (redirects are not followed, so a source never reaches another host)`);
  if (!res.ok) throw new DataError(`${u.host} answered HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_FETCH) throw new DataError('the response is larger than 50 MB');
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_FETCH) throw new DataError('the response is larger than 50 MB');
  return { type: res.headers.get('content-type') ?? '', body, link: res.headers.get('link') ?? undefined };
}

/**
 * A delimited text file: its encoding (a file that is not UTF-8 is converted to a UTF-8 copy first)
 * and its delimiter (named, else detected) given to the engine, which types the columns.
 */
async function csvReader(file: string, fmt: 'csv' | 'tsv', s: SourceSpec, ctx: SourceContext): Promise<Reader> {
  const fh = await fs.open(file, 'r');
  const head = Buffer.alloc(65_536);
  const { bytesRead } = await fh.read(head, 0, head.length, 0).finally(() => fh.close());
  const sample = head.subarray(0, bytesRead);
  // Cut at the last newline so a character split by the sample's end does not look like bad UTF-8.
  const cut = sample.lastIndexOf(10);
  const probe = decodeText(cut > 0 && bytesRead === head.length ? sample.subarray(0, cut) : sample, s.encoding);
  const delim = fmt === 'tsv' ? '\t' : s.delimiter ?? sniffDelimiter(probe.text);
  const opts = `header = true, delim = ${lit(delim)}, auto_detect = true, sample_size = -1`;
  if (probe.encoding === 'utf-8' && !(sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf)) return { reader: `SELECT * FROM read_csv(${pathLit(file)}, ${opts})`, cleanup: noCleanup };
  const dir = path.join(ctx.home, 'tmp');
  await fs.mkdir(dir, { recursive: true });
  const copy = path.join(dir, `${crypto.randomBytes(8).toString('hex')}.csv`);
  await fs.writeFile(copy, decodeText(await fs.readFile(file), s.encoding ?? probe.encoding).text, 'utf8');
  return { reader: `SELECT * FROM read_csv(${pathLit(copy)}, ${opts})`, cleanup: () => fs.rm(copy, { force: true }) };
}

/** A sheet (by name) or a named range of a workbook, as a table with its header row found. */
function workbookTable(buf: Buffer, from: string | undefined, file: string): ReturnType<typeof sheetTable> {
  const sheets = readXlsx(buf);
  const find = (n: string) => sheets.find((x) => x.name === n) ?? sheets.find((x) => x.name.toLowerCase() === n.toLowerCase());
  if (!from) return sheetTable(sheets[0]!);
  const sh = find(from);
  if (sh) return sheetTable(sh);
  // A named range ("SalesTable"), or a sheet and range ("Sheet1!B3:F40").
  const named = definedNames(buf).find((x) => x.name.toLowerCase() === from.toLowerCase());
  const direct = /^'?(.+?)'?!(\$?[A-Z]+\$?\d+:\$?[A-Z]+\$?\d+)$/.exec(from);
  const ref = named ? { sheet: named.sheet, range: named.range } : direct ? { sheet: direct[1]!, range: direct[2]! } : undefined;
  const base = ref ? find(ref.sheet) : undefined;
  if (!ref || !base) throw new DataError(`no sheet or named range "${from}" in ${file} (sheets: ${sheets.map((x) => x.name).join(', ')}${definedNames(buf).length ? `; names: ${definedNames(buf).map((x) => x.name).join(', ')}` : ''})`);
  return sheetTable(rangeSheet(base, ref.range), { headerAtTop: true });
}

/** An API's rows across its pages (page numbers, offsets, a cursor in the body, or the Link header's next). */
async function httpRows(s: SourceSpec, from: string | undefined, ctx: SourceContext): Promise<{ columns: string[]; rows: unknown[][]; types?: Record<string, ColType> }> {
  const pg = s.paginate;
  const first = await httpGet(s, ctx, pg ? pageUrl(s.url!, pg, pg.start ?? (pg.kind === 'offset' ? 0 : 1)) : undefined);
  const text = first.body.toString('utf8');
  if (s.format === 'log') return parseLog(text, s.log ?? { format: 'auto' });
  if (s.format === 'xml' || (!s.format && /xml/i.test(first.type) && !/json/i.test(first.type))) return xmlRows(text, from ?? s.rowsPath);
  const parse = (t: string): { items: unknown; json: unknown } => {
    if (s.format === 'ndjson') { const items = parseNdjson(t); return { items, json: items }; }
    let json: unknown; try { json = JSON.parse(t); } catch { throw new DataError(`${new URL(s.url!).host} did not answer with JSON or CSV`); }
    return { items: atPath(json, from ?? s.rowsPath), json };
  };
  let cur = parse(text);
  if (!pg) return jsonTable(cur.items, { flatten: s.flatten, unnest: s.unnest });
  const all: unknown[] = [];
  let res = first; let n = pg.start ?? (pg.kind === 'offset' ? 0 : 1); let url = s.url!;
  for (let i = 0; i < Math.min(pg.maxPages ?? 50, 500); i++) {
    if (!Array.isArray(cur.items)) throw new DataError('a page is not a list of rows: set rowsPath to the list');
    all.push(...cur.items);
    let next: string | undefined;
    if (pg.kind === 'link') {
      const link = /<([^>]+)>\s*;\s*rel="?next"?/.exec(res.link ?? '')?.[1];
      if (link) { const u = new URL(link, url); if (u.host !== new URL(s.url!).host) throw new DataError('the next page is on another host: refused'); next = u.toString(); }
    } else if (pg.kind === 'cursor') {
      const c = atPath(cur.json, pg.cursorPath ?? 'next');
      if (c !== null && c !== undefined && c !== '' && cur.items.length) { const u = new URL(s.url!); u.searchParams.set(pg.param ?? 'cursor', String(c)); if (pg.size) u.searchParams.set(pg.sizeParam ?? 'limit', String(pg.size)); next = u.toString(); }
    } else if (cur.items.length && !(pg.size && cur.items.length < pg.size)) {
      n += pg.kind === 'offset' ? cur.items.length : 1;
      next = pageUrl(s.url!, pg, n);
    }
    if (!next) break;
    url = next;
    res = await httpGet(s, ctx, url);
    cur = parse(res.body.toString('utf8'));
  }
  return jsonTable(all, { flatten: s.flatten, unnest: s.unnest });
}
function pageUrl(base: string, pg: NonNullable<SourceSpec['paginate']>, n: number): string {
  const u = new URL(base);
  if (pg.kind === 'page' || pg.kind === 'offset') u.searchParams.set(pg.param ?? (pg.kind === 'offset' ? 'offset' : 'page'), String(n));
  if (pg.size && pg.kind !== 'link') u.searchParams.set(pg.sizeParam ?? (pg.kind === 'offset' ? 'limit' : 'per_page'), String(pg.size));
  return u.toString();
}

/** A MongoDB collection (the official driver, read with a secondary-preferred read): documents flattened, an array unnested into rows when asked. */
async function mongoRows(s: SourceSpec, from: string | undefined, ctx: SourceContext, list = false): Promise<{ columns: string[]; rows: unknown[][] } | string[]> {
  let mongo: typeof import('mongodb');
  try { mongo = await import('mongodb'); } catch { throw new DataError('MongoDB sources need the mongodb package (npm install)', 503); }
  const password = s.secret ? await ctx.secret(s.secret, `read MongoDB source ${s.name}`) : undefined;
  const base = s.url ? new URL(s.url) : new URL(`mongodb://${s.host ?? 'localhost'}:${s.port ?? 27017}`);
  if (s.user) { base.username = encodeURIComponent(s.user); if (password) base.password = encodeURIComponent(password); }
  const client = new mongo.MongoClient(base.toString(), { serverSelectionTimeoutMS: 10_000, readPreference: 'secondaryPreferred', ...(s.user && !base.searchParams.get('authSource') ? { authSource: 'admin' } : {}) });
  await client.connect();
  try {
    const db = client.db(s.database);
    if (list) return (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).sort();
    if (!from) throw new DataError('name the collection to read: "from"');
    const docs = await db.collection(from).find(s.filter ?? {}, { projection: s.projection, maxTimeMS: ctx.timeoutMs ?? 120_000 }).limit(2_000_000).toArray();
    const plain = (v: unknown): unknown => {
      if (v === null || v === undefined) return null;
      if (v instanceof Date) return v;
      if (Array.isArray(v)) return v.map(plain);
      if (typeof v === 'object') {
        const bt = (v as { _bsontype?: string })._bsontype;
        if (bt === 'ObjectId' || bt === 'ObjectID') return (v as { toHexString(): string }).toHexString();
        if (bt === 'Decimal128') return Number((v as { toString(): string }).toString());
        if (bt === 'Long' || bt === 'Int32' || bt === 'Double') return Number((v as { toString(): string }).toString());
        if (bt === 'Binary') return Buffer.from((v as { buffer: Uint8Array }).buffer).toString('base64');
        if (bt) return String(v);
        return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, plain(x)]));
      }
      return v;
    };
    return flattenRecords(docs.map(plain), { unnest: s.unnest });
  } finally { await client.close().catch(() => {}); }
}

/**
 * The extract reader for a source (and a dataset's `from`). `since` pushes an incremental window
 * down to databases; files are read whole (the engine keeps rows before the window from the last extract).
 */
export async function readerFor(s: SourceSpec, from: string | undefined, ctx: SourceContext, since?: { column: string; cutoff: string }): Promise<Reader> {
  switch (s.type) {
    case 'file': {
      const file = await allowedFile(s.path ?? '', ctx.roots);
      const fmt = formatOf(file, s.format);
      if (fmt === 'csv' || fmt === 'tsv') return csvReader(file, fmt, s, ctx);
      if (fmt === 'parquet') return { reader: `SELECT * FROM read_parquet(${pathLit(file)})`, cleanup: noCleanup };
      if (fmt === 'json' && !from && s.flatten === false && !s.unnest) return { reader: `SELECT * FROM read_json_auto(${pathLit(file)}, sample_size = -1, maximum_object_size = 104857600)`, cleanup: noCleanup };
      if (path.extname(file).toLowerCase() === '.evtx') throw new DataError('binary .evtx files are not read here: export the events from Event Viewer as XML (or CSV) and read that (log format winevent-xml or winevent-csv)');
      const buf = await fs.readFile(file);
      if (fmt === 'xlsx') {
        const t = workbookTable(buf, from, path.basename(file));
        return rowsReader(ctx.home, t.columns.map((c) => c.name), t.rows, Object.fromEntries(t.columns.map((c) => [c.name, c.type])));
      }
      const text = decodeText(buf, s.encoding).text;
      if (fmt === 'log') { const t = parseLog(text, s.log ?? { format: 'auto' }); return rowsReader(ctx.home, t.columns, t.rows, t.types); }
      if (fmt === 'xml') { const t = xmlRows(text, from ?? s.rowsPath); return rowsReader(ctx.home, t.columns, t.rows); }
      if (fmt === 'ndjson') { const t = jsonTable(parseNdjson(text), { flatten: s.flatten, unnest: s.unnest }); return rowsReader(ctx.home, t.columns, t.rows); }
      const json = JSON.parse(text) as unknown;
      const t = fmt === 'geojson' ? geoRows(json) : jsonTable(atPath(json, from ?? s.rowsPath), { flatten: s.flatten, unnest: s.unnest });
      return rowsReader(ctx.home, t.columns, t.rows);
    }
    case 'sqlite': {
      const file = await allowedFile(s.path ?? '', ctx.roots);
      const t = await sqliteRows(file, from) as { columns: string[]; rows: unknown[][] };
      return rowsReader(ctx.home, t.columns, t.rows);
    }
    case 'postgres': case 'mysql': case 'mssql': {
      const t = await (s.type === 'postgres' ? postgresRows : s.type === 'mssql' ? mssqlRows : mysqlRows)(s, from, ctx, since) as { columns: string[]; rows: unknown[][]; types: Record<string, ColType> };
      return rowsReader(ctx.home, t.columns, t.rows, t.types);
    }
    case 'http': {
      if (s.paginate || (s.format && s.format !== 'csv' && s.format !== 'tsv')) { const t = await httpRows(s, from, ctx); return rowsReader(ctx.home, t.columns, t.rows, t.types); }
      const r = await httpGet(s, ctx);
      const text = r.body.toString('utf8');
      if (/xml/i.test(r.type) && !/json/i.test(r.type)) { const t = xmlRows(text, from ?? s.rowsPath); return rowsReader(ctx.home, t.columns, t.rows); }
      if (s.format === 'csv' || s.format === 'tsv' || /csv|tab-separated/i.test(r.type) || (!/json/i.test(r.type) && !/^\s*[[{]/.test(text))) {
        const dir = path.join(ctx.home, 'tmp');
        await fs.mkdir(dir, { recursive: true });
        const file = path.join(dir, `${crypto.randomBytes(8).toString('hex')}.csv`);
        await fs.writeFile(file, r.body);
        return { reader: `SELECT * FROM read_csv(${pathLit(file)}, header = true, auto_detect = true, sample_size = -1${/tab-separated/i.test(r.type) ? ", delim = '\\t'" : ''})`, cleanup: () => fs.rm(file, { force: true }) };
      }
      let json: unknown;
      try { json = JSON.parse(text); } catch { throw new DataError(`${new URL(s.url!).host} did not answer with JSON or CSV`); }
      const t = jsonTable(atPath(json, from ?? s.rowsPath), { flatten: s.flatten, unnest: s.unnest });
      return rowsReader(ctx.home, t.columns, t.rows);
    }
    case 'mongodb': {
      const t = await mongoRows(s, from, ctx) as { columns: string[]; rows: unknown[][] };
      return rowsReader(ctx.home, t.columns, t.rows);
    }
    case 'static': {
      if (!Array.isArray(s.columns) || !Array.isArray(s.rows)) throw new DataError('a static source needs columns and rows');
      return rowsReader(ctx.home, s.columns.map(String), s.rows as Scalar[][]);
    }
    case 'plugin': {
      if (!ctx.pluginData || !s.plugin || !s.kind) throw new DataError('this plugin data source is not available (is the plugin on?)', 503);
      const t = jsonTable(atPath(await ctx.pluginData(s.plugin, s.kind, s.params ?? {}), from ?? s.rowsPath));
      return rowsReader(ctx.home, t.columns, t.rows);
    }
  }
  throw new DataError(`unknown source type ${String((s as { type?: unknown }).type)}`);
}

/** Connects and says what can be read: tables, sheets, or the shape of the data. Never a secret. */
export async function testSource(s: SourceSpec, ctx: SourceContext): Promise<{ ok: true; tables: string[]; note: string }> {
  switch (s.type) {
    case 'file': {
      const file = await allowedFile(s.path ?? '', ctx.roots);
      const fmt = formatOf(file, s.format);
      if (fmt === 'xlsx') { const buf = await fs.readFile(file); const sh = readXlsx(buf); const names = definedNames(buf); return { ok: true, tables: [...sh.map((x) => x.name), ...names.map((x) => x.name)], note: `${sh.length} sheet(s)${names.length ? `, ${names.length} named range(s)` : ''}` }; }
      if (fmt === 'log') { const t = parseLog(decodeText(await fs.readFile(file), s.encoding).text, s.log ?? { format: 'auto' }); return { ok: true, tables: [path.basename(file)], note: `${t.note}; columns: ${t.columns.join(', ')}` }; }
      const st = await fs.stat(file);
      return { ok: true, tables: [path.basename(file)], note: `${fmt}, ${Math.round(st.size / 1024)} KB` };
    }
    case 'sqlite': { const t = await sqliteRows(await allowedFile(s.path ?? '', ctx.roots), undefined, true) as string[]; return { ok: true, tables: t, note: `${t.length} table(s)` }; }
    case 'postgres': case 'mysql': case 'mssql': { const t = await (s.type === 'postgres' ? postgresRows : s.type === 'mssql' ? mssqlRows : mysqlRows)(s, undefined, ctx, undefined, true) as string[]; return { ok: true, tables: t, note: `connected; ${t.length} table(s)` }; }
    case 'http': {
      const r = await httpGet(s, ctx);
      let note = `${r.body.length} bytes of ${r.type || 'data'}`;
      if (/json/i.test(r.type) || /^\s*[[{]/.test(r.body.toString('utf8', 0, 64))) { try { const t = jsonTable(atPath(JSON.parse(r.body.toString('utf8')), s.rowsPath)); note += `; ${t.rows.length} rows, columns: ${t.columns.slice(0, 20).join(', ')}`; } catch (e) { note += `; ${(e as Error).message}`; } }
      return { ok: true, tables: [new URL(s.url!).host], note };
    }
    case 'mongodb': { const t = await mongoRows(s, undefined, ctx, true) as string[]; return { ok: true, tables: t, note: `connected; ${t.length} collection(s)` }; }
    case 'static': return { ok: true, tables: ['values'], note: `${s.rows?.length ?? 0} rows typed in${s.origin === 'model' ? ' by a model (bind a real source)' : ''}` };
    case 'plugin': { const t = jsonTable(atPath(await ctx.pluginData!(s.plugin!, s.kind!, s.params ?? {}), s.rowsPath)); return { ok: true, tables: [s.kind!], note: `${t.rows.length} rows` }; }
  }
  throw new DataError('unknown source type');
}

/** What a source looks like to someone who may not see its secrets: never the secret's value, never a password. */
export function publicSource(s: SourceSpec): SourceSpec {
  const { rows, ...rest } = s;
  return { ...rest, ...(rows ? { rows: rows.slice(0, 50) } : {}), ...(s.headers ? { headers: Object.fromEntries(Object.keys(s.headers).map((k) => [k, '…'])) } : {}) };
}

export const quoteIdent = qid;
export type { Cell };
