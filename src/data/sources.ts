import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileFormat, Scalar, SourceSpec } from '../../packages/plugin-ui/src/bi.ts';
import { assertPublicUrl, publicFetch } from '../tools/web.ts';
import { DataError, lit, pathLit, qid } from './engine.ts';
import { readXlsx, sheetTable, type Cell } from './xlsx.ts';

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
  if (ext === 'json' || ext === 'ndjson' || ext === 'jsonl') return 'json';
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

/** JSON rows (objects, arrays with a header, {columns, rows}) as columns and rows. */
export function jsonTable(v: unknown): { columns: string[]; rows: unknown[][] } {
  if (v && typeof v === 'object' && !Array.isArray(v) && Array.isArray((v as { rows?: unknown }).rows)) {
    const o = v as { columns?: unknown[]; rows: unknown[] };
    if (Array.isArray(o.columns) && o.rows.every(Array.isArray)) return { columns: o.columns.map((c) => (typeof c === 'string' ? c : String((c as { name?: unknown })?.name ?? c))), rows: o.rows as unknown[][] };
    v = o.rows;
  }
  if (!Array.isArray(v)) throw new DataError('the data is not a list of rows (set rowsPath to the array inside the JSON, e.g. "data.items")');
  if (v.length && v.every(Array.isArray)) { const [head, ...rest] = v as unknown[][]; return { columns: head!.map(String), rows: rest }; }
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
async function httpGet(s: SourceSpec, ctx: SourceContext): Promise<{ type: string; body: Buffer }> {
  if (!s.url) throw new DataError('an http source needs a url');
  const u = new URL(s.url);
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
  return { type: res.headers.get('content-type') ?? '', body };
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
      if (fmt === 'csv') return { reader: `SELECT * FROM read_csv(${pathLit(file)}, header = true, auto_detect = true, sample_size = -1)`, cleanup: noCleanup };
      if (fmt === 'tsv') return { reader: `SELECT * FROM read_csv(${pathLit(file)}, header = true, delim = '\\t', auto_detect = true, sample_size = -1)`, cleanup: noCleanup };
      if (fmt === 'parquet') return { reader: `SELECT * FROM read_parquet(${pathLit(file)})`, cleanup: noCleanup };
      if (fmt === 'json' && !from) return { reader: `SELECT * FROM read_json_auto(${pathLit(file)}, sample_size = -1, maximum_object_size = 104857600)`, cleanup: noCleanup };
      const buf = await fs.readFile(file);
      if (fmt === 'xlsx') {
        const sheets = readXlsx(buf);
        const sh = from ? sheets.find((x) => x.name === from) ?? sheets.find((x) => x.name.toLowerCase() === from.toLowerCase()) : sheets[0];
        if (!sh) throw new DataError(`no sheet "${from}" in ${path.basename(file)} (sheets: ${sheets.map((x) => x.name).join(', ')})`);
        const t = sheetTable(sh);
        return rowsReader(ctx.home, t.columns.map((c) => c.name), t.rows, Object.fromEntries(t.columns.map((c) => [c.name, c.type])));
      }
      const json = JSON.parse(buf.toString('utf8')) as unknown;
      const t = fmt === 'geojson' ? geoRows(json) : jsonTable(atPath(json, from ?? s.rowsPath));
      return rowsReader(ctx.home, t.columns, t.rows);
    }
    case 'sqlite': {
      const file = await allowedFile(s.path ?? '', ctx.roots);
      const t = await sqliteRows(file, from) as { columns: string[]; rows: unknown[][] };
      return rowsReader(ctx.home, t.columns, t.rows);
    }
    case 'postgres': case 'mysql': {
      const t = await (s.type === 'postgres' ? postgresRows : mysqlRows)(s, from, ctx, since) as { columns: string[]; rows: unknown[][]; types: Record<string, ColType> };
      return rowsReader(ctx.home, t.columns, t.rows, t.types);
    }
    case 'http': {
      const r = await httpGet(s, ctx);
      const text = r.body.toString('utf8');
      if (/csv|tab-separated/i.test(r.type) || (!/json/i.test(r.type) && !/^\s*[[{]/.test(text))) {
        const dir = path.join(ctx.home, 'tmp');
        await fs.mkdir(dir, { recursive: true });
        const file = path.join(dir, `${crypto.randomBytes(8).toString('hex')}.csv`);
        await fs.writeFile(file, r.body);
        return { reader: `SELECT * FROM read_csv(${pathLit(file)}, header = true, auto_detect = true, sample_size = -1${/tab-separated/i.test(r.type) ? ", delim = '\\t'" : ''})`, cleanup: () => fs.rm(file, { force: true }) };
      }
      let json: unknown;
      try { json = JSON.parse(text); } catch { throw new DataError(`${new URL(s.url!).host} did not answer with JSON or CSV`); }
      const t = jsonTable(atPath(json, from ?? s.rowsPath));
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
      if (fmt === 'xlsx') { const sh = readXlsx(await fs.readFile(file)); return { ok: true, tables: sh.map((x) => x.name), note: `${sh.length} sheet(s)` }; }
      const st = await fs.stat(file);
      return { ok: true, tables: [path.basename(file)], note: `${fmt}, ${Math.round(st.size / 1024)} KB` };
    }
    case 'sqlite': { const t = await sqliteRows(await allowedFile(s.path ?? '', ctx.roots), undefined, true) as string[]; return { ok: true, tables: t, note: `${t.length} table(s)` }; }
    case 'postgres': case 'mysql': { const t = await (s.type === 'postgres' ? postgresRows : mysqlRows)(s, undefined, ctx, undefined, true) as string[]; return { ok: true, tables: t, note: `connected; ${t.length} table(s)` }; }
    case 'http': {
      const r = await httpGet(s, ctx);
      let note = `${r.body.length} bytes of ${r.type || 'data'}`;
      if (/json/i.test(r.type) || /^\s*[[{]/.test(r.body.toString('utf8', 0, 64))) { try { const t = jsonTable(atPath(JSON.parse(r.body.toString('utf8')), s.rowsPath)); note += `; ${t.rows.length} rows, columns: ${t.columns.slice(0, 20).join(', ')}`; } catch (e) { note += `; ${(e as Error).message}`; } }
      return { ok: true, tables: [new URL(s.url!).host], note };
    }
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
