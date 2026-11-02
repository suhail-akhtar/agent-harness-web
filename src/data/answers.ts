// Answers over the person's own data (docs/swarm/SWARM.md, phase 2). An answer is only as good as the query behind
// every number in it, so:
//   - queries run read-only against the database, and each result is kept as a query cell (q1, q2, ...) the agent
//     cannot edit: its SQL, its rows, a hash;
//   - deterministic checks run after every query, on the database itself: a join that multiplies rows (the joined key
//     is not unique, so sums count rows more than once), a grouped result whose groups repeat (the grain is not what
//     the query says), a date filter that reaches past the data (the period asked is not all there);
//   - the provenance rule: every number in the answer cites a cell ([q3]) and appears in it (formatting aside), or is
//     marked as computed from cited numbers "(derived: ...)"; anything else is rejected;
//   - the headline figures are recomputed by an agent of another family that never sees the first queries, and
//     compared in code.
import crypto from 'node:crypto';

export type Cell = { id: string; sql: string; purpose?: string; columns: string[]; rows: unknown[][]; count: number; truncated: boolean; hash: string; at: number; checks: string[] };

/** How many rows a cell keeps (and a reply shows fewer). */
export const CELL_ROWS = 500;

/** Only one read-only statement: a SELECT (or WITH ... SELECT); nothing that writes, attaches, or changes settings. */
export function readOnlySql(sql: string): string {
  const s = sql.trim().replace(/;\s*$/, '');
  const bare = s.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""').replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
  if (bare.includes(';')) throw new Error('one statement at a time');
  if (!/^\s*(select|with)\b/i.test(bare)) throw new Error('only SELECT queries (or WITH ... SELECT): the data is read, never changed');
  if (/\b(insert|update|delete|replace|drop|alter|create|attach|detach|pragma|vacuum|reindex)\b/i.test(bare)) throw new Error('only reading statements: no INSERT, UPDATE, DELETE, DDL, ATTACH or PRAGMA');
  return s;
}

/** A read-only connection to a SQLite file (opened read-only, and query_only on top). */
export async function openDatabase(file: string) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA query_only = ON');
  const all = (sql: string) => {
    const st = db.prepare(sql);
    st.setReturnArrays?.(true);
    const columns = (st.columns?.() ?? []).map((c: { name: string }) => c.name);
    return { columns, rows: st.all() as unknown as unknown[][] };
  };
  return {
    all,
    /** The tables with their columns: what a semantics file and a query author start from. */
    schema(): string {
      const tables = all("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name").rows.map((r) => String(r[0]));
      return tables.map((t) => {
        const cols = all(`PRAGMA table_info(${q(t)})`).rows.map((r) => `${r[1]} ${r[2] || ''}`.trim());
        const n = all(`SELECT COUNT(*) FROM ${q(t)}`).rows[0]?.[0];
        return `${t} (${n} rows): ${cols.join(', ')}`;
      }).join('\n');
    },
    close: () => db.close(),
  };
}
type Db = Awaited<ReturnType<typeof openDatabase>>;
const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

/** Runs one read-only query and keeps it as a cell, with the deterministic checks of what it computed. */
export function runCell(db: Db, sql: string, id: string, purpose?: string): Cell {
  const clean = readOnlySql(sql);
  const r = db.all(clean);
  const rows = r.rows.map((row) => row.map((v) => (typeof v === 'bigint' ? Number(v) : v)));
  return { id, sql: clean, ...(purpose ? { purpose } : {}), columns: r.columns, rows: rows.slice(0, CELL_ROWS), count: rows.length, truncated: rows.length > CELL_ROWS, hash: crypto.createHash('sha256').update(JSON.stringify([clean, rows])).digest('hex').slice(0, 16), at: Date.now(), checks: checksFor(db, clean, r.columns, rows) };
}

/** The tables a query reads, with their aliases (FROM a x, JOIN b AS y). */
function tablesOf(sql: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of sql.matchAll(/\b(?:from|join)\s+("?[\w]+"?)(?:\s+(?:as\s+)?(?!on\b|where\b|join\b|left\b|right\b|inner\b|outer\b|cross\b|group\b|order\b|limit\b|using\b)(\w+))?/gi)) {
    const t = m[1]!.replace(/"/g, '');
    out.set(t, t);
    if (m[2]) out.set(m[2], t);
  }
  return out;
}

/**
 * What the database says about a query's result:
 * - fan-out: a JOIN on a key that is not unique on the joined side multiplies rows, so a SUM or COUNT over them counts
 *   rows more than once (the classic wrong revenue);
 * - grain: the grouped columns repeat in the result (two rows for one group);
 * - coverage: a filter on a date reaches past the dates in the table (the period is not all in the data).
 */
export function checksFor(db: Db, sql: string, columns: string[], rows: unknown[][]): string[] {
  const out: string[] = [];
  const tables = tablesOf(sql);
  const aggregates = /\b(sum|count|avg|total)\s*\(/i.test(sql);
  // Fan-out: for each equi-join, whether the key on each side is unique in its table.
  for (const m of sql.matchAll(/\bjoin\s+"?(\w+)"?(?:\s+(?:as\s+)?(\w+))?\s+on\s+([\w."]+)\s*=\s*([\w."]+)/gi)) {
    if (!aggregates) break;
    for (const side of [m[3]!, m[4]!]) {
      const [a, c] = side.replace(/"/g, '').includes('.') ? side.replace(/"/g, '').split('.') as [string, string] : [m[2] ?? m[1]!, side.replace(/"/g, '')];
      const table = tables.get(a!);
      if (!table) continue;
      try {
        const dup = db.all(`SELECT ${q(c!)}, COUNT(*) FROM ${q(table)} GROUP BY ${q(c!)} HAVING COUNT(*) > 1 LIMIT 1`).rows[0];
        const joined = m[2] ?? m[1]!;
        if (dup && (a === joined || table === m[1])) out.push(`fan-out: ${table}.${c} is not unique (${JSON.stringify(dup[0])} appears ${dup[1]} times), so joining ${table} repeats rows of the other side: a SUM or COUNT over them counts some rows more than once. Aggregate ${table} first (a subquery grouped by ${c}), or count DISTINCT keys.`);
      } catch { /* not a plain column */ }
    }
  }
  // Grain: grouped columns that repeat in the result.
  const g = /\bgroup\s+by\s+([\s\S]+?)(?:\bhaving\b|\border\b|\blimit\b|$)/i.exec(sql);
  if (g && rows.length > 1) {
    const keys = g[1]!.split(',').map((k) => k.trim().replace(/^.*\./, '').replace(/"/g, '')).filter(Boolean);
    const idx = keys.map((k) => (/^\d+$/.test(k) ? Number(k) - 1 : columns.indexOf(k))).filter((i) => i >= 0);
    if (idx.length === keys.length) {
      const seen = new Set<string>();
      const rep = rows.find((r) => { const k = JSON.stringify(idx.map((i) => r[i])); if (seen.has(k)) return true; seen.add(k); return false; });
      if (rep) out.push(`grain: the result has more than one row for ${JSON.stringify(idx.map((i) => rep[i]))} of ${keys.join(', ')}: the groups are not what the query says (a column grouped in SQL is shown differently)`);
    }
  }
  // Coverage: a window on a date (a start and an end on the same column) that reaches well past the table's dates.
  // Only a window: a single bound is a cutoff ("hired on or before 31 March"), and the newest row before it is no gap
  // (seen live: an agent called a headcount unanswerable). Only a real gap: more than a week and more than a tenth of
  // the window, so a quiet last day of a quarter is no gap either (seen live).
  const bounds = new Map<string, { lo?: string; hi?: string }>();
  for (const m of sql.matchAll(/([\w."]+)\s*(>=|>|<=|<|between)\s*'(\d{4}-\d{2}-\d{2})'(?:\s+and\s+'(\d{4}-\d{2}-\d{2})')?/gi)) {
    const ref = m[1]!.replace(/"/g, '');
    const b = bounds.get(ref) ?? {};
    const op = m[2]!.toLowerCase();
    if (op === 'between') { b.lo = m[3]; b.hi = m[4]; } else if (op.startsWith('>')) b.lo = m[3]; else b.hi = m[3];
    bounds.set(ref, b);
  }
  for (const [ref, b] of bounds) {
    if (!b.lo || !b.hi) continue;
    const [a, c] = ref.includes('.') ? ref.split('.') as [string, string] : [undefined, ref];
    const table = a ? tables.get(a) : [...new Set(tables.values())].find((t) => { try { db.all(`SELECT ${q(c!)} FROM ${q(t)} LIMIT 0`); return true; } catch { return false; } });
    if (!table) continue;
    try {
      const [lo, hi] = (db.all(`SELECT MIN(${q(c!)}), MAX(${q(c!)}) FROM ${q(table)}`).rows[0] as [string, string]).map((x) => String(x ?? '').slice(0, 10));
      if (!lo || !hi) continue;
      const span = daysBetween(b.lo, b.hi);
      const gap = (d: number) => d > 7 && d > span / 10;
      const parts: string[] = [];
      if (gap(daysBetween(hi, b.hi))) parts.push(`its newest row is from ${hi}, ${Math.round(daysBetween(hi, b.hi))} days before the window's end (${b.hi})`);
      if (gap(daysBetween(b.lo, lo))) parts.push(`its oldest row is from ${lo}, ${Math.round(daysBetween(b.lo, lo))} days after the window's start (${b.lo})`);
      if (parts.length) out.push(`coverage: ${table}.${c}: ${parts.join('; ')}. Give the figure for the part the data covers and say which part that is (not a figure for the whole window as if it were complete)`);
    } catch { /* not a date column */ }
  }
  return [...new Set(out)];
}
const daysBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;

/** A cell as the agent sees it: the cell id, the checks, the first rows as a table. */
export function showCell(c: Cell, max = 40): string {
  const cell = (v: unknown) => String(v ?? 'NULL').replace(/\|/g, '\\|').slice(0, 80);
  return [
    `[${c.id}] ${c.count} row(s)${c.truncated ? ` (the cell keeps the first ${CELL_ROWS})` : ''}; hash ${c.hash}`,
    ...(c.checks.length ? ['CHECKS:', ...c.checks.map((x) => `- ${x}`)] : []),
    '', `| ${c.columns.join(' | ')} |`, `|${c.columns.map(() => '---').join('|')}|`,
    ...c.rows.slice(0, max).map((r) => `| ${r.map(cell).join(' | ')} |`),
    ...(c.count > max ? [`(${c.count - max} more rows in the cell)`] : []),
    '', `Cite it as [${c.id}] next to each number you take from it.`,
  ].join('\n');
}

// ---------- the provenance rule ----------

/** The numbers in a text (1,234.5 / 12% / -3 / 0.25), with their place. Years in dates and cell ids are not numbers here. */
function numbersIn(s: string): string[] {
  const t = s.replace(/\[q\d+\]/g, '').replace(/\b\d{4}-\d{2}(-\d{2})?\b/g, '').replace(/\b(19|20)\d{2}\b(?!\.\d|,\d{3})/g, '');
  return [...t.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0]).filter((n) => /\d/.test(n));
}

const value = (n: string) => Number(n.replace(/,/g, ''));

/** A number as written matches a value in a cell: the same, or the same rounded to the decimals written. */
function inCell(n: string, c: Cell): boolean {
  const v = value(n);
  if (!Number.isFinite(v)) return false;
  const dec = (n.split('.')[1] ?? '').length;
  for (const row of c.rows) for (const x of row) {
    const y = typeof x === 'number' ? x : typeof x === 'string' && /^-?\d+(\.\d+)?$/.test(x.trim()) ? Number(x) : NaN;
    if (!Number.isFinite(y)) continue;
    if (y === v || Number(y.toFixed(dec)) === v || Number((y * 100).toFixed(dec)) === v) return true;
  }
  return c.count === v; // a row count
}

export interface ProvenanceIssue { line: number; text: string; problem: string }

/**
 * Every sentence of the answer with a number cites a cell, and each number in it is in a cell it cites (as written,
 * or rounded to the decimals written, or as a percentage of a fraction), or the sentence ends "(derived: ...)" and
 * cites the cells it computed from. Years and dates are not checked.
 */
export function checkProvenance(answer: string, cells: Map<string, Cell>): { issues: ProvenanceIssue[]; numbers: number; sentences: number } {
  const issues: ProvenanceIssue[] = [];
  let numbers = 0; let sentences = 0;
  answer.split('\n').forEach((raw, i) => {
    if (/^\s*(#|```|\{")/.test(raw)) return;
    for (const s of raw.split(/(?<=[.!?])\s+(?=[A-Z(])/)) {
      const nums = numbersIn(s);
      if (!nums.length) continue;
      sentences++; numbers += nums.length;
      const cited = [...s.matchAll(/\[(q\d+)\]/g)].map((m) => m[1]!);
      const missing = cited.filter((c) => !cells.has(c));
      if (missing.length) { issues.push({ line: i + 1, text: s.slice(0, 160), problem: `cites ${missing.join(', ')}, which no query made` }); continue; }
      if (!cited.length) { issues.push({ line: i + 1, text: s.slice(0, 160), problem: `has ${nums.join(', ')} but cites no query cell: cite the cell each number comes from ([q1]), or cut it` }); continue; }
      if (/\(derived:[^)]*\)/i.test(s)) continue;
      const off = nums.filter((n) => !cited.some((c) => inCell(n, cells.get(c)!)));
      if (off.length) issues.push({ line: i + 1, text: s.slice(0, 160), problem: `${off.join(', ')} ${off.length === 1 ? 'is' : 'are'} not in ${cited.map((c) => `[${c}]`).join(', ')}: copy numbers exactly from the cell, or end the sentence with "(derived: <the arithmetic>)"` });
    }
  });
  return { issues, numbers, sentences };
}

// ---------- the recomputation ----------

/** The headline figures an answer ends with: one line of JSON {"figures": {"name": number, ...}}. */
export function figuresOf(text: string): Record<string, number> | undefined {
  const lines = text.trim().split('\n').reverse();
  for (const l of lines) {
    const m = /\{[\s\S]*"figures"[\s\S]*\}/.exec(l.trim());
    if (!m) continue;
    try {
      const f = (JSON.parse(m[0]) as { figures?: Record<string, unknown> }).figures;
      if (!f || typeof f !== 'object') return undefined;
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(f)) { const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '')); if (Number.isFinite(n)) out[k] = n; }
      return out;
    } catch { return undefined; }
  }
  return undefined;
}

/**
 * The first answer's figures against an independent recomputation's: each figure agrees within `tolerance` (relative;
 * 0.5% by default) or is a disagreement; a figure only one side has is unmatched. Figures are matched by name, then by
 * value for the rest (two authors name things differently).
 */
export function compareFigures(a: Record<string, number>, b: Record<string, number>, tolerance = 0.005): { agree: string[]; disagree: string[]; unmatched: string[] } {
  const close = (x: number, y: number) => (x === y) || Math.abs(x - y) <= tolerance * Math.max(Math.abs(x), Math.abs(y));
  const agree: string[] = []; const disagree: string[] = []; const unmatched: string[] = [];
  const left = new Map(Object.entries(b));
  const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [k, v] of Object.entries(a)) {
    const same = [...left.keys()].find((x) => norm(x) === norm(k));
    if (same !== undefined) {
      const w = left.get(same)!; left.delete(same);
      (close(v, w) ? agree : disagree).push(close(v, w) ? `${k}: ${v}` : `${k}: ${v} against ${w}`);
      continue;
    }
    const byValue = [...left.entries()].find(([, w]) => close(v, w));
    if (byValue) { left.delete(byValue[0]); agree.push(`${k}: ${v} (as ${byValue[0]})`); } else unmatched.push(`${k}: ${v} (no matching figure in the recomputation)`);
  }
  for (const [k, v] of left) unmatched.push(`${k}: ${v} (only in the recomputation)`);
  return { agree, disagree, unmatched };
}

// ---------- where cells live ----------

/** A session's query cells, in the session's own folder (an agent's workspace never holds them, so it cannot edit one). */
export class CellStore {
  private cells = new Map<string, Cell>();
  private loaded = false;
  private file: string;
  constructor(file: string) { this.file = file; }
  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    const fs = await import('node:fs/promises');
    try { for (const c of JSON.parse(await fs.readFile(this.file, 'utf8')) as Cell[]) this.cells.set(c.id, c); } catch { /* none yet */ }
  }
  async all(): Promise<Map<string, Cell>> { await this.load(); return this.cells; }
  async add(make: (id: string) => Cell): Promise<Cell> {
    await this.load();
    const c = make(`q${this.cells.size + 1}`);
    this.cells.set(c.id, c);
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify([...this.cells.values()]));
    return c;
  }
}

/** A semantics file's status line: "draft" until the person approves it (then agents may query). */
export function semanticsStatus(text: string): 'draft' | 'approved' | 'none' {
  const m = /^\s*status:\s*(\w+)/im.exec(text);
  return !m ? 'none' : /^approved$/i.test(m[1]!) ? 'approved' : 'draft';
}

/** A first semantics file from a database's schema: the tables, and the definitions for the person to write or confirm. */
export function draftSemantics(db: string, schema: string): string {
  return [
    `# Semantics of ${db}`, '',
    'Status: draft (the person reviews the definitions below, then changes this line to "Status: approved"; until then agents do not query)', '',
    '## Tables', '', ...schema.split('\n').map((l) => `- ${l}`), '',
    '## Definitions', '',
    'Write each business term the way the numbers must be computed: the table, the filter, the grain. For example:', '',
    '- Revenue: SUM(order_items.quantity * order_items.unit_price) over orders whose status is not \'refunded\'.', '- Active customer: a customer with an order in the last 90 days.', '',
    '## Pitfalls', '', '- Joins that repeat rows (a table with several rows per key):', '- Dates: which column, which time zone, which period is complete:', '',
  ].join('\n');
}
