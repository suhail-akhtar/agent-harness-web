/**
 * Data previews: delimited text (CSV/TSV) and table specs read into rows, with the arithmetic a
 * reader would otherwise do by hand. Parsing is here (tested) and drawing in DataTable.tsx.
 */

export interface TableSpec { columns: string[]; rows: Array<Array<string | number | null>>; title?: string }
export interface ColumnSummary { sum: number; mean: number; median: number; std: number; min: number; max: number; count: number }

/** Rows whose cells contain the query (case-insensitive), optionally in one column only. */
export function filterRows(spec: TableSpec, query: string, column?: number): TableSpec['rows'] {
  const q = query.trim().toLowerCase();
  if (!q) return spec.rows;
  return spec.rows.filter((r) => (column === undefined ? r : [r[column]]).some((c) => String(c ?? '').toLowerCase().includes(q)));
}

export type Aggregate = 'sum' | 'count' | 'mean' | 'min' | 'max' | 'median';
export const AGGREGATES: Aggregate[] = ['sum', 'count', 'mean', 'median', 'min', 'max'];

function agg(values: number[], how: Aggregate, rows: number): number {
  if (how === 'count') return rows;
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  switch (how) {
    case 'sum': return values.reduce((a, b) => a + b, 0);
    case 'mean': return values.reduce((a, b) => a + b, 0) / values.length;
    case 'min': return sorted[0]!;
    case 'max': return sorted[sorted.length - 1]!;
    case 'median': { const m = sorted.length >> 1; return sorted.length % 2 ? sorted[m]! : (sorted[m - 1]! + sorted[m]!) / 2; }
  }
}

/**
 * A pivot table: one row per distinct value of `rows`, one column per distinct value of `cols`
 * (or a single column when none), cells aggregating `values`.
 */
export function pivot(spec: TableSpec, o: { rows: number; cols?: number; values?: number; aggregate: Aggregate }): TableSpec {
  const key = (v: unknown) => (v === null || v === undefined || v === '' ? '(blank)' : String(v));
  const rowKeys = [...new Set(spec.rows.map((r) => key(r[o.rows])))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const colKeys = o.cols === undefined ? ['__all__'] : [...new Set(spec.rows.map((r) => key(r[o.cols!])))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const label = `${o.aggregate}${o.values !== undefined && o.aggregate !== 'count' ? ` of ${spec.columns[o.values]}` : ''}`;
  const columns = [spec.columns[o.rows]!, ...(o.cols === undefined ? [label] : colKeys)];
  const rows = rowKeys.map((rk) => [rk, ...colKeys.map((ck) => {
    const group = spec.rows.filter((r) => key(r[o.rows]) === rk && (o.cols === undefined || key(r[o.cols]) === ck));
    const nums = o.values === undefined ? [] : group.map((r) => numericValue(r[o.values!])).filter((v): v is number => v !== undefined);
    const v = agg(nums, o.aggregate, group.length);
    return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
  })]);
  return { columns, rows };
}

/** CSV text of a table (RFC 4180 quoting), for export. */
export function toCsv(spec: TableSpec, rows: TableSpec['rows'] = spec.rows): string {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? '' : String(v);
    // A text cell starting like a formula is neutralised (spreadsheet formula injection); numbers stay numbers.
    if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [spec.columns, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}

/** RFC 4180-ish: quoted fields with doubled quotes, newlines inside quotes, CRLF. */
export function parseDelimited(text: string, delimiter?: string): TableSpec {
  const src = text.replace(/^﻿/, '');
  const d = delimiter ?? sniffDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
      continue;
    }
    if (c === '"' && field === '') { quoted = true; continue; }
    if (c === d) { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter((r) => r.some((x) => x.trim() !== ''));
  const header = nonEmpty[0] ?? [];
  const width = Math.max(header.length, ...nonEmpty.slice(1).map((r) => r.length));
  const columns = Array.from({ length: width }, (_, i) => header[i]?.trim() || `Column ${i + 1}`);
  return { columns, rows: nonEmpty.slice(1).map((r) => Array.from({ length: width }, (_, i) => r[i] ?? '')) };
}

export function sniffDelimiter(text: string): string {
  const first = text.split('\n').slice(0, 5).join('\n');
  const counts: Array<[string, number]> = [[',', 0], ['\t', 0], [';', 0], ['|', 0]].map(([d]) => [d as string, first.split(d as string).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ',';
}

/** Read a ```table block ({columns, rows}) and say exactly what is wrong when it is not one. */
export function parseTableSpec(source: string): { spec?: TableSpec; error?: string } {
  const text = source.trim();
  if (!text) return { error: 'the table block is empty' };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (error) { return { error: `the table spec is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }; }
  const c = parsed as Partial<TableSpec> | null;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return { error: 'a table spec must be a JSON object with `columns` and `rows`' };
  if (!Array.isArray(c.columns) || !c.columns.every((x) => typeof x === 'string')) return { error: '`columns` must be an array of strings' };
  if (!Array.isArray(c.rows) || !c.rows.every(Array.isArray)) return { error: '`rows` must be an array of arrays, one per row, in column order' };
  const ragged = c.rows.findIndex((r) => r.length !== c.columns!.length);
  if (ragged !== -1) return { error: `row ${ragged + 1} has ${c.rows[ragged]!.length} cells but there are ${c.columns.length} columns` };
  return { spec: c as TableSpec };
}

/** A cell's numeric value ("1,024", "$5", "92%" are numbers to a reader), or undefined. */
export function numericValue(cell: string | number | null | undefined): number | undefined {
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : undefined;
  if (typeof cell !== 'string') return undefined;
  const cleaned = cell.trim().replace(/[,\s]/g, '').replace(/^[$£€]/, '').replace(/%$/, '');
  if (!/^-?\d*\.?\d+(e[-+]?\d+)?$/i.test(cleaned)) return undefined;
  const v = Number(cleaned);
  return Number.isFinite(v) ? v : undefined;
}

/** Which columns are numeric (a clear majority of their non-empty cells). */
export function numericColumns(spec: TableSpec): boolean[] {
  return spec.columns.map((_, i) => {
    const cells = spec.rows.map((r) => r[i]).filter((c) => c !== null && c !== '' && c !== undefined);
    if (!cells.length) return false;
    return cells.filter((c) => numericValue(c) !== undefined).length / cells.length >= 0.8;
  });
}

export function summarise(spec: TableSpec, index: number): ColumnSummary | undefined {
  const values = spec.rows.map((r) => numericValue(r[index])).filter((v): v is number => v !== undefined);
  if (!values.length) return undefined;
  const sum = values.reduce((a, b) => a + b, 0);
  const mean = sum / values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const m = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[m]! : (sorted[m - 1]! + sorted[m]!) / 2;
  const std = values.length > 1 ? Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (values.length - 1)) : 0;
  return { sum, mean, median, std, min: sorted[0]!, max: sorted[sorted.length - 1]!, count: values.length };
}

/** Rows sorted by a column (numbers numerically, text by locale), without touching the spec. */
export function sortRows(spec: TableSpec, index: number, descending: boolean): TableSpec['rows'] {
  const numeric = numericColumns(spec)[index];
  return [...spec.rows].sort((a, b) => {
    const l = numeric ? numericValue(a[index]) : undefined;
    const r = numeric ? numericValue(b[index]) : undefined;
    const res = l !== undefined && r !== undefined ? l - r : String(a[index] ?? '').localeCompare(String(b[index] ?? ''), undefined, { numeric: true });
    return descending ? -res : res;
  });
}

/** Read an ECharts option ({series} or {dataset}). */
export function parseChartSpec(source: string): { option?: Record<string, unknown>; error?: string } {
  const text = source.trim();
  if (!text) return { error: 'the chart block is empty' };
  try {
    const p: unknown = JSON.parse(text);
    if (!p || typeof p !== 'object' || Array.isArray(p)) return { error: 'a chart spec must be a JSON object of ECharts options' };
    const o = p as Record<string, unknown>;
    if (!o.series && !o.dataset) return { error: 'no `series` in the chart spec: there is nothing to draw' };
    return { option: o };
  } catch (e) { return { error: `the chart spec is not valid JSON: ${e instanceof Error ? e.message : String(e)}` }; }
}

/** Read a Vega-Lite spec (needs data and a mark or a composition). */
export function parseVizSpec(source: string): { spec?: Record<string, unknown>; error?: string } {
  const text = source.trim();
  if (!text) return { error: 'the viz block is empty' };
  let p: unknown;
  try { p = JSON.parse(text); } catch (e) { return { error: `the viz spec is not valid JSON: ${e instanceof Error ? e.message : String(e)}` }; }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { error: 'a viz spec must be a JSON object of Vega-Lite options' };
  const spec = p as Record<string, unknown>;
  if (!['mark', 'layer', 'hconcat', 'vconcat', 'concat', 'facet', 'repeat', 'spec'].some((k) => k in spec)) return { error: 'no `mark` in the viz spec: there is nothing to draw' };
  if (!('data' in spec)) return { error: 'no `data` in the viz spec: use {"values": [...]} with the rows inline' };
  // Data only inline: a spec that names a URL would make the renderer fetch from wherever the model said.
  const urls = JSON.stringify(spec).match(/"url"\s*:/);
  if (urls) return { error: 'the viz spec loads data from a URL; put the rows inline as {"values": [...]}' };
  // Expressions run in Vega's interpreter (no eval); these names never belong in a figure and are refused outright.
  const exprs: string[] = [];
  const walk = (v: unknown, k = '') => {
    if (typeof v === 'string') { if (/^(calculate|filter|expr|test|update|init|on|signal)$/.test(k)) exprs.push(v); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, k); return; }
    if (v && typeof v === 'object') for (const [kk, vv] of Object.entries(v)) { if (kk === '__proto__' || kk === 'constructor') exprs.push(kk); walk(vv, kk); }
  };
  walk(spec);
  if (exprs.some((e) => /\b(constructor|__proto__|prototype|globalThis|window|document|eval|Function|import)\b/.test(e))) return { error: 'an expression in the viz spec uses a name that is not allowed' };
  return { spec };
}

/** A JSON value's shape, for the tree view's summary line. */
export function jsonSummary(v: unknown): string {
  if (Array.isArray(v)) return `[${v.length} item${v.length === 1 ? '' : 's'}]`;
  if (v && typeof v === 'object') { const n = Object.keys(v).length; return `{${n} key${n === 1 ? '' : 's'}}`; }
  return JSON.stringify(v) ?? String(v);
}
