/**
 * Maths blocks (KaTeX), tables (```table specs, CSV and TSV) with sorting and column stats, and
 * JSON as a collapsible tree.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Icon } from '../icons.tsx';
import { KATEX_MACROS } from './katex-setup.ts';
import { AGGREGATES, filterRows, jsonSummary, numericColumns, parseDelimited, parseTableSpec, pivot, sortRows, summarise, toCsv, type Aggregate, type TableSpec } from './data.ts';
import { downloadText } from './download.ts';

type Katex = { renderToString: (tex: string, o?: Record<string, unknown>) => string };
let katexPromise: Promise<Katex> | null = null;
const loadKatex = () => (katexPromise ??= import('./katex-setup.ts').then(() => import('katex')).then((m) => ((m as { default?: Katex }).default ?? m) as Katex));

export function MathBlock({ source, streaming }: { source: string; streaming?: boolean }): React.ReactElement {
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (streaming) return;
    let cancelled = false;
    void loadKatex().then((k) => {
      if (cancelled) return;
      try {
        // trust: false refuses every command that can emit a URL or raw HTML (\href, \url, \htmlClass ...).
        setHtml(k.renderToString(source.trim(), { displayMode: true, throwOnError: true, strict: false, trust: false, macros: { ...KATEX_MACROS } }));
        setError('');
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    });
    return () => { cancelled = true; };
  }, [source, streaming]);
  if (streaming) return <p className="p-2 text-[11.5px] text-hx-muted">Formula arriving…</p>;
  if (error) throw new Error(error.split('\n')[0]);
  if (!html) return <p className="p-2 text-[11.5px] text-hx-muted">Setting…</p>;
  // KaTeX's own markup with trust: false.
  return <div data-math="block" className="overflow-x-auto px-2 py-3 text-hx-primary [&_.katex-display]:my-0" dangerouslySetInnerHTML={{ __html: html }} />;
}

const fmt = (v: number) => (Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 }));

/** ```table ({columns, rows}), ```csv or ```tsv. */
export function DataTable({ source, format = 'table', streaming }: { source: string; format?: 'table' | 'csv' | 'tsv'; streaming?: boolean }): React.ReactElement {
  const parsed = useMemo(() => (format === 'table' ? parseTableSpec(source) : { spec: parseDelimited(source, format === 'tsv' ? '\t' : undefined) }), [source, format]);
  if (parsed.error) { if (streaming) return <div className="px-3 py-4 text-[12px] text-hx-muted">Table arriving…</div>; throw new Error(parsed.error); }
  return <TableBody spec={parsed.spec!} />;
}

export function TableBody({ spec, maxHeight = 420 }: { spec: TableSpec; maxHeight?: number }): React.ReactElement {
  const [sort, setSort] = useState<{ index: number; descending: boolean } | null>(null);
  const [query, setQuery] = useState('');
  const [tool, setTool] = useState<'none' | 'stats' | 'pivot'>('none');
  const numeric = useMemo(() => numericColumns(spec), [spec]);
  const filtered = useMemo(() => ({ ...spec, rows: filterRows(spec, query) }), [spec, query]);
  const rows = useMemo(() => (sort ? sortRows(filtered, sort.index, sort.descending) : filtered.rows), [filtered, sort]);
  const big = spec.rows.length > 8;
  return (
    <div className="space-y-1.5" data-table>
      {big && (
        <div className="flex items-center gap-2">
          <label className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-hx-border-subtle bg-hx-bg px-2 text-[12px] focus-within:border-hx-accent">
            <Icon name="filter" size={12} className="text-hx-muted" />
            <input data-table-filter value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter rows" className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-hx-muted" />
          </label>
        </div>
      )}
      <div className="overflow-auto" style={{ maxHeight }}>
        <table className="w-full border-collapse text-[12.5px]">
          <thead className="sticky top-0 bg-hx-bg">
            <tr>
              {spec.columns.map((c, i) => (
                <th key={i} aria-sort={sort?.index === i ? (sort.descending ? 'descending' : 'ascending') : 'none'} className={`border-b border-hx-border px-2 py-1.5 font-medium text-hx-secondary ${numeric[i] ? 'text-right' : 'text-left'}`}>
                  <button type="button" className="inline-flex items-center gap-1 hover:text-hx-primary" title="Sort by this column" onClick={() => setSort((s) => ({ index: i, descending: s?.index === i ? !s.descending : false }))}>
                    {c}{sort?.index === i && <Icon name={sort.descending ? 'arrow-down' : 'arrow-up'} size={11} />}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri} className="border-b border-hx-border-subtle last:border-0">
                {r.map((cell, ci) => <td key={ci} className={`px-2 py-1 text-hx-primary ${numeric[ci] ? 'text-right tabular-nums' : ''}`}>{cell === null ? '' : String(cell)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-1 text-[11px] text-hx-muted">
        <span data-table-count className="mr-1">{query ? `${rows.length} of ` : ''}{spec.rows.length} row{spec.rows.length === 1 ? '' : 's'} · {spec.columns.length} column{spec.columns.length === 1 ? '' : 's'}</span>
        {numeric.some(Boolean) && <ToolButton on={tool === 'stats'} onClick={() => setTool((t) => (t === 'stats' ? 'none' : 'stats'))}>Stats</ToolButton>}
        {spec.columns.length > 1 && spec.rows.length > 1 && <ToolButton on={tool === 'pivot'} onClick={() => setTool((t) => (t === 'pivot' ? 'none' : 'pivot'))}>Pivot</ToolButton>}
        <ToolButton onClick={() => downloadText(`${(spec.title ?? 'table').toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'table'}.csv`, toCsv(spec, rows), 'text/csv')}>Export CSV</ToolButton>
      </div>
      {tool === 'stats' && <StatsTable spec={filtered} numeric={numeric} />}
      {tool === 'pivot' && <PivotTool spec={filtered} numeric={numeric} />}
    </div>
  );
}

function ToolButton({ on, onClick, children }: { on?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} aria-pressed={on} className={`rounded px-1.5 py-0.5 hover:bg-hx-hover hover:text-hx-primary ${on ? 'bg-hx-active text-hx-primary' : ''}`}>{children}</button>;
}

const STAT_COLUMNS = ['count', 'mean', 'median', 'std', 'min', 'max'] as const;
function StatsTable({ spec, numeric }: { spec: TableSpec; numeric: boolean[] }) {
  return (
    <table className="w-full border-collapse text-[11.5px]" data-table-stats>
      <thead><tr className="text-hx-muted"><th className="px-2 text-left font-normal">column</th>{STAT_COLUMNS.map((h) => <th key={h} className="px-2 text-right font-normal">{h}</th>)}</tr></thead>
      <tbody>
        {spec.columns.map((c, i) => {
          const s = numeric[i] ? summarise(spec, i) : undefined;
          return s ? <tr key={i} className="text-hx-secondary"><td className="px-2">{c}</td>{STAT_COLUMNS.map((k) => <td key={k} className="px-2 text-right tabular-nums">{fmt(s[k])}</td>)}</tr> : null;
        })}
      </tbody>
    </table>
  );
}

function PivotTool({ spec, numeric }: { spec: TableSpec; numeric: boolean[] }) {
  const firstText = Math.max(0, numeric.findIndex((n) => !n));
  const firstNum = numeric.findIndex(Boolean);
  const [rowsBy, setRowsBy] = useState(firstText);
  const [colsBy, setColsBy] = useState(-1);
  const [values, setValues] = useState(firstNum);
  const [how, setHow] = useState<Aggregate>(firstNum >= 0 ? 'sum' : 'count');
  const result = useMemo(() => pivot(spec, { rows: rowsBy, cols: colsBy < 0 ? undefined : colsBy, values: values < 0 ? undefined : values, aggregate: values < 0 ? 'count' : how }), [spec, rowsBy, colsBy, values, how]);
  const pick = (label: string, value: number, set: (n: number) => void, opts: Array<[number, string]>) => (
    <label className="inline-flex items-center gap-1">{label}
      <select value={value} onChange={(e) => set(Number(e.target.value))} className="rounded border border-hx-border-subtle bg-hx-bg px-1 py-0.5 text-hx-primary">{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
    </label>
  );
  const cols = spec.columns.map((c, i) => [i, c] as [number, string]);
  return (
    <div data-table-pivot className="space-y-1.5 rounded-lg border border-hx-border-subtle p-2">
      <div className="flex flex-wrap items-center gap-3 text-[11.5px] text-hx-secondary">
        {pick('Rows', rowsBy, setRowsBy, cols)}
        {pick('Columns', colsBy, setColsBy, [[-1, '(none)'], ...cols.filter(([i]) => i !== rowsBy)])}
        {pick('Values', values, setValues, [[-1, '(rows)'], ...cols.filter(([i]) => numeric[i])])}
        {values >= 0 && <label className="inline-flex items-center gap-1">as<select value={how} onChange={(e) => setHow(e.target.value as Aggregate)} className="rounded border border-hx-border-subtle bg-hx-bg px-1 py-0.5 text-hx-primary">{AGGREGATES.map((a) => <option key={a} value={a}>{a}</option>)}</select></label>}
      </div>
      <TableBody spec={result} maxHeight={260} />
    </div>
  );
}

/** JSON as a collapsible tree (big documents start folded below the first levels). */
export function JsonView({ source, streaming }: { source: string; streaming?: boolean }): React.ReactElement {
  const parsed = useMemo(() => { try { return { v: JSON.parse(source) as unknown }; } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; } }, [source]);
  const [mode, setMode] = useState<'tree' | 'table'>('tree');
  if ('error' in parsed) { if (streaming) return <div className="p-2 text-[12px] text-hx-muted">JSON arriving…</div>; throw new Error(`not valid JSON: ${parsed.error}`); }
  const asTable = tableFromJson(parsed.v);
  return (
    <div data-json>
      {asTable && (
        <div className="mb-1.5 flex gap-1 text-[11.5px]">
          {(['tree', 'table'] as const).map((m) => <button key={m} type="button" onClick={() => setMode(m)} className={`rounded px-2 py-0.5 ${mode === m ? 'bg-hx-active text-hx-primary' : 'text-hx-muted hover:bg-hx-hover'}`}>{m === 'tree' ? 'Tree' : 'Table'}</button>)}
        </div>
      )}
      {mode === 'table' && asTable ? <TableBody spec={asTable} /> : <div className="max-h-[420px] overflow-auto font-mono text-[12px] leading-5"><JsonNode name={null} value={parsed.v} depth={0} /></div>}
    </div>
  );
}

/** An array of flat objects reads as a table. */
export function tableFromJson(v: unknown): TableSpec | undefined {
  if (!Array.isArray(v) || !v.length || v.length > 5000 || !v.every((x) => x && typeof x === 'object' && !Array.isArray(x))) return undefined;
  const cols = [...new Set(v.flatMap((x) => Object.keys(x as object)))].slice(0, 40);
  if (!cols.length) return undefined;
  return { columns: cols, rows: v.map((x) => cols.map((c) => { const cell = (x as Record<string, unknown>)[c]; return cell === null || cell === undefined ? null : typeof cell === 'object' ? JSON.stringify(cell) : typeof cell === 'number' ? cell : String(cell); })) };
}

function JsonNode({ name, value, depth }: { name: string | null; value: unknown; depth: number }): React.ReactElement {
  const composite = value !== null && typeof value === 'object';
  const [open, setOpen] = useState(depth < 2);
  const label = name !== null ? <span className="text-[var(--hx-tok-prop)]">{JSON.stringify(name)}<span className="text-hx-muted">: </span></span> : null;
  if (!composite) {
    const color = typeof value === 'string' ? 'var(--hx-tok-string)' : typeof value === 'number' || typeof value === 'boolean' ? 'var(--hx-tok-const)' : 'var(--hx-text-muted)';
    return <div style={{ paddingLeft: depth * 14 }} className="whitespace-pre-wrap break-words">{label}<span style={{ color }}>{JSON.stringify(value)}</span></div>;
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
  return (
    <div>
      <button type="button" style={{ paddingLeft: depth * 14 }} className="flex items-center gap-1 text-left hover:bg-hx-hover" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} className="text-hx-muted" />
        {label}<span className="text-hx-muted">{jsonSummary(value)}</span>
      </button>
      {open && entries.slice(0, 500).map(([k, v]) => <JsonNode key={k} name={Array.isArray(value) ? null : k} value={v} depth={depth + 1} />)}
      {open && entries.length > 500 && <div style={{ paddingLeft: (depth + 1) * 14 }} className="text-hx-muted">… {entries.length - 500} more</div>}
    </div>
  );
}
