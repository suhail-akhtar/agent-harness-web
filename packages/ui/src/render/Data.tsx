/**
 * Maths blocks (KaTeX), tables (```table specs, CSV and TSV) with sorting and column stats, and
 * JSON as a collapsible tree.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Icon } from '../icons.tsx';
import { jsonSummary, numericColumns, parseDelimited, parseTableSpec, sortRows, summarise, type TableSpec } from './data.ts';

type Katex = { renderToString: (tex: string, o?: Record<string, unknown>) => string };
let katexPromise: Promise<Katex> | null = null;
const loadKatex = () => (katexPromise ??= import('katex').then((m) => ((m as { default?: Katex }).default ?? m) as Katex));

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
        setHtml(k.renderToString(source.trim(), { displayMode: true, throwOnError: true, strict: false, trust: false, macros: { '\\abs': '\\left|#1\\right|', '\\norm': '\\left\\|#1\\right\\|' } }));
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
  const [stats, setStats] = useState(false);
  const numeric = useMemo(() => numericColumns(spec), [spec]);
  const rows = useMemo(() => (sort ? sortRows(spec, sort.index, sort.descending) : spec.rows), [spec, sort]);
  return (
    <div className="space-y-1.5" data-table>
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
      <div className="flex items-center gap-2 text-[11px] text-hx-muted">
        <span>{spec.rows.length} row{spec.rows.length === 1 ? '' : 's'} · {spec.columns.length} column{spec.columns.length === 1 ? '' : 's'}</span>
        {numeric.some(Boolean) && <button type="button" onClick={() => setStats((v) => !v)} className="rounded px-1.5 py-0.5 hover:bg-hx-hover hover:text-hx-primary">{stats ? 'Hide stats' : 'Stats'}</button>}
      </div>
      {stats && (
        <table className="w-full border-collapse text-[11.5px]" data-table-stats>
          <thead><tr className="text-hx-muted"><th className="px-2 text-left font-normal">column</th>{['sum', 'mean', 'min', 'max', 'n'].map((h) => <th key={h} className="px-2 text-right font-normal">{h}</th>)}</tr></thead>
          <tbody>
            {spec.columns.map((c, i) => {
              const s = numeric[i] ? summarise(spec, i) : undefined;
              return s ? <tr key={i} className="text-hx-secondary"><td className="px-2">{c}</td><td className="px-2 text-right tabular-nums">{fmt(s.sum)}</td><td className="px-2 text-right tabular-nums">{fmt(s.mean)}</td><td className="px-2 text-right tabular-nums">{fmt(s.min)}</td><td className="px-2 text-right tabular-nums">{fmt(s.max)}</td><td className="px-2 text-right tabular-nums">{s.count}</td></tr> : null;
            })}
          </tbody>
        </table>
      )}
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
