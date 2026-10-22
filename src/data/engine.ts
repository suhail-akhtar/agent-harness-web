import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { QueryResult, ResultColumn, Scalar } from '../../packages/plugin-ui/src/bi.ts';

// The query engine: DuckDB, two ways.
//
// - Extracts (trusted, engine-written SQL only): a source is read once (a file through DuckDB's
//   readers, rows a driver or an API gave) and written as a Parquet file with a row number, under
//   the person's data folder. A refresh writes a new file; readers of the old one are never cut off.
// - Runs (anything that holds a person's or an agent's SQL): a fresh in-memory database per run,
//   locked before any of that SQL is seen: no file but the extracts it needs, no network, no
//   ATTACH, COPY, INSTALL or LOAD, configuration locked; only single SELECT statements are run;
//   a row cap, a time limit, and an interrupt for cancel.

type DuckModule = typeof import('@duckdb/node-api');
let duckP: Promise<DuckModule> | undefined;
/** The DuckDB binding, loaded on first use (a server that never makes a dashboard never loads it). */
export function duck(): Promise<DuckModule> {
  return (duckP ??= import('@duckdb/node-api').catch((e: Error) => {
    duckP = undefined;
    throw new DataError(`the data engine (DuckDB) is not installed here: ${e.message.split('\n')[0]}. Run npm install (scripts/ensure-duckdb.mjs installs the platform binding).`, 503);
  }));
}

export class DataError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

/** 'it''s' - a string literal for engine-written SQL. */
export const lit = (s: string) => `'${String(s).replace(/'/g, "''")}'`;
/** "My Column" - a quoted identifier. */
export const qid = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
/** A path inside SQL: forward slashes on every OS. */
export const pathLit = (p: string) => lit(p.replace(/\\/g, '/'));
export function scalarLit(v: Scalar): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new DataError(`${v} is not a number SQL can hold`); return String(v); }
  return lit(v);
}

class Gate {
  private n = 0;
  private q: Array<() => void> = [];
  private max: number;
  constructor(max: number) { this.max = max; }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.n >= this.max) await new Promise<void>((r) => this.q.push(r));
    this.n++;
    try { return await fn(); } finally { this.n--; this.q.shift()?.(); }
  }
}

export interface EngineLimits { rows: number; timeoutMs: number; memory: string; threads: number }
export const DEFAULT_LIMITS: EngineLimits = {
  rows: Math.max(10, Number(process.env.HARNESS_DATA_MAX_ROWS ?? 50_000) || 50_000),
  timeoutMs: Math.max(1000, Number(process.env.HARNESS_DATA_TIMEOUT_MS ?? 30_000) || 30_000),
  memory: process.env.HARNESS_DATA_MEMORY ?? '1GB',
  threads: Math.max(1, Number(process.env.HARNESS_DATA_THREADS ?? 2) || 2),
};

/** A view to create before the query: engine SQL, or a person's SELECT (checked to be one SELECT first). */
export interface ViewDef { name: string; sql: string; user?: boolean }
export interface RunPlan {
  /** Extract files the run may read (nothing else on disk). */
  files: string[];
  views: ViewDef[];
  vars?: Record<string, Scalar>;
  sql: string;
  limit?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface RawResult { columns: Array<{ name: string; type: string }>; rows: Scalar[][]; truncated: boolean; ms: number }

/** A JSON-safe value: BIGINT and DECIMAL as numbers (exact while safe), dates as ISO text. */
function jsonValue(v: unknown, type: string): Scalar {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (typeof v === 'string') {
    if (/^(BIGINT|HUGEINT|UBIGINT|UHUGEINT|DECIMAL|INTEGER|SMALLINT|TINYINT|UINTEGER|DOUBLE|FLOAT)/.test(type) && v.trim() !== '' && Number.isFinite(Number(v))) {
      const n = Number(v);
      return /INT/.test(type) && !Number.isSafeInteger(n) ? v : n;
    }
    return v;
  }
  return JSON.stringify(v);
}

export const rowsHash = (rows: unknown[][]) => crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');

export class Engine {
  limits: EngineLimits;
  private runs = new Gate(Math.max(1, Number(process.env.HARNESS_DATA_PARALLEL ?? 4) || 4));
  private extracts = new Gate(2);
  private active = new Map<string, { interrupt(): void }>();
  constructor(limits: Partial<EngineLimits> = {}) { this.limits = { ...DEFAULT_LIMITS, ...limits }; }

  /** Interrupts a running query by its id. */
  cancel(id: string): boolean { const c = this.active.get(id); c?.interrupt(); return !!c; }

  private async open(lock: string[] | null) {
    const { DuckDBInstance } = await duck();
    const inst = await DuckDBInstance.create(':memory:', { threads: String(this.limits.threads), memory_limit: this.limits.memory });
    const conn = await inst.connect();
    if (lock) {
      // Only these files, then no more file system, network or extension access, and no way back.
      await conn.run(`SET allowed_paths = [${lock.map(pathLit).join(', ')}]`);
      for (const s of ['SET enable_external_access = false', 'SET autoinstall_known_extensions = false', 'SET autoload_known_extensions = false', 'SET lock_configuration = true']) await conn.run(s);
    }
    return { conn, close: () => { try { conn.closeSync(); } catch { /* closed */ } try { inst.closeSync(); } catch { /* closed */ } } };
  }

  /**
   * Writes an extract: `reader` is engine-written SQL (a file reader, or read_json over rows the
   * engine wrote). The result gets __rn (the source's row order) and lands in `out` (Parquet).
   */
  async extract(o: { reader: string; out: string; incremental?: { previous: string; column: string; cutoff: string }; timeoutMs?: number }): Promise<{ rows: number; columns: Array<{ name: string; type: string }>; ms: number }> {
    return this.extracts.run(async () => {
      const t0 = Date.now();
      const db = await this.open(null);
      const timer = setTimeout(() => db.conn.interrupt(), o.timeoutMs ?? Math.max(this.limits.timeoutMs, 120_000));
      try {
        await fs.mkdir(path.dirname(o.out), { recursive: true });
        await db.conn.run(`CREATE TABLE src AS ${o.reader}`);
        if (o.incremental) {
          const { previous, column, cutoff } = o.incremental;
          // Rows before the window come from the last extract; the window from the source, read again.
          await db.conn.run(`CREATE TABLE t AS SELECT * EXCLUDE (__rn) FROM read_parquet(${pathLit(previous)}) WHERE ${qid(column)} < ${lit(cutoff)}::TIMESTAMP UNION ALL BY NAME SELECT * FROM src WHERE ${qid(column)} >= ${lit(cutoff)}::TIMESTAMP`);
        } else await db.conn.run('CREATE TABLE t AS SELECT * FROM src');
        const tmp = `${o.out}.${process.pid}.tmp`;
        await db.conn.run(`COPY (SELECT rowid AS __rn, * FROM t ORDER BY rowid) TO ${pathLit(tmp)} (FORMAT parquet)`);
        await fs.rename(tmp, o.out);
        const d = await db.conn.runAndReadAll('DESCRIBE t');
        const columns = d.getRowObjectsJson().map((r) => ({ name: String(r.column_name), type: String(r.column_type) }));
        const n = await db.conn.runAndReadAll('SELECT count(*)::BIGINT AS n FROM t');
        return { rows: Number(n.getRowsJson()[0]![0]), columns, ms: Date.now() - t0 };
      } catch (e) {
        throw new DataError(cleanError(e), 400);
      } finally { clearTimeout(timer); db.close(); }
    });
  }

  /** Runs one plan in a locked database. Every user SQL (views marked user, and the query) must be one SELECT. */
  async run(plan: RunPlan, id = crypto.randomUUID()): Promise<RawResult> {
    return this.runs.run(async () => {
      if (plan.signal?.aborted) throw new DataError('cancelled', 499);
      const t0 = Date.now();
      const db = await this.open(plan.files);
      this.active.set(id, db.conn);
      const onAbort = () => db.conn.interrupt();
      plan.signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => db.conn.interrupt(), plan.timeoutMs ?? this.limits.timeoutMs);
      try {
        for (const [k, v] of Object.entries(plan.vars ?? {})) await db.conn.run(`SET VARIABLE ${qid(k)} = ${scalarLit(v)}`);
        for (const v of plan.views) {
          if (v.user) await assertSelect(db.conn, v.sql, `dataset ${v.name}`);
          await db.conn.run(`CREATE VIEW ${qid(v.name)} AS (\n${v.sql}\n)`);
        }
        await assertSelect(db.conn, plan.sql, 'the query');
        const limit = Math.min(plan.limit ?? this.limits.rows, this.limits.rows);
        const r = await db.conn.runAndReadUntil(`SELECT * FROM (\n${plan.sql}\n) LIMIT ${limit + 1}`, limit + 1);
        const types = r.columnTypes().map(String);
        const names = r.deduplicatedColumnNames();
        const raw = r.getRowsJson() as unknown[][];
        const truncated = raw.length > limit;
        const rows = raw.slice(0, limit).map((row) => row.map((v, i) => jsonValue(v, types[i]!)));
        return { columns: names.map((name, i) => ({ name, type: types[i]! })), rows, truncated, ms: Date.now() - t0 };
      } catch (e) {
        if (e instanceof DataError) throw e;
        const m = cleanError(e);
        if (/INTERRUPT/i.test(m)) throw new DataError(plan.signal?.aborted ? 'cancelled' : `the query took longer than ${Math.round((plan.timeoutMs ?? this.limits.timeoutMs) / 1000)} s and was stopped`, plan.signal?.aborted ? 499 : 408);
        throw new DataError(m, 400);
      } finally {
        clearTimeout(timer);
        plan.signal?.removeEventListener('abort', onAbort);
        this.active.delete(id);
        db.close();
      }
    });
  }

  /** The columns a plan's query gives (for checking ops), without reading rows. */
  async describe(plan: RunPlan): Promise<Array<{ name: string; type: string }>> {
    const r = await this.run({ ...plan, sql: `SELECT * FROM (\n${plan.sql}\n) WHERE false`, limit: 1 });
    return r.columns;
  }
}

async function assertSelect(conn: import('@duckdb/node-api').DuckDBConnection, sql: string, what: string): Promise<void> {
  let n: number;
  try { n = (await conn.extractStatements(sql)).count; } catch (e) { throw new DataError(`${what}: ${cleanError(e)}`); }
  if (n !== 1) throw new DataError(`${what} must be exactly one SELECT statement (got ${n} statements)`);
  let p: import('@duckdb/node-api').DuckDBPreparedStatement;
  try { p = await conn.prepare(sql); } catch (e) { throw new DataError(`${what}: ${cleanError(e)}`); }
  const t = p.statementType;
  p.destroySync();
  // 1 = SELECT. Anything else (INSERT, COPY, ATTACH, SET, PRAGMA, CALL, CREATE ...) is refused: queries only read.
  if (t !== 1) throw new DataError(`${what} must be a read-only SELECT (or WITH ... SELECT); writes, COPY, ATTACH, INSTALL, PRAGMA and SET are refused`);
}

/** A DuckDB error without its internal noise. */
export function cleanError(e: unknown): string {
  const m = (e instanceof Error ? e.message : String(e)).replace(/\s*\n\s*LINE \d+:[\s\S]*$/, '').trim();
  return m.length > 600 ? `${m.slice(0, 600)}...` : m;
}

/** A finished result with its hash and lineage. */
export function toResult(raw: RawResult, columns: ResultColumn[], lineage: QueryResult['lineage']): QueryResult {
  return { columns, rows: raw.rows, rowCount: raw.rows.length, ...(raw.truncated ? { truncated: true } : {}), hash: rowsHash(raw.rows), ms: raw.ms, at: Date.now(), lineage };
}
