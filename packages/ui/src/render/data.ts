/**
 * Data previews: delimited text (CSV/TSV) and table specs read into rows, with the arithmetic a
 * reader would otherwise do by hand. Parsing is here (tested) and drawing in DataTable.tsx.
 */

export interface TableSpec { columns: string[]; rows: Array<Array<string | number | null>>; title?: string }
export interface ColumnSummary { sum: number; mean: number; min: number; max: number; count: number }

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
  return { sum, mean: sum / values.length, min: Math.min(...values), max: Math.max(...values), count: values.length };
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
  return { spec };
}

/** A JSON value's shape, for the tree view's summary line. */
export function jsonSummary(v: unknown): string {
  if (Array.isArray(v)) return `[${v.length} item${v.length === 1 ? '' : 's'}]`;
  if (v && typeof v === 'object') { const n = Object.keys(v).length; return `{${n} key${n === 1 ? '' : 's'}}`; }
  return JSON.stringify(v) ?? String(v);
}
