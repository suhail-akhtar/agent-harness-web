/**
 * One dashboard visual: charts (ECharts, from option.ts), cards, KPIs, tables and matrices with
 * subtotals the engine computed, slicers, decomposition trees, key drivers, narratives, text,
 * images, buttons and any fence renderer of the stack. Interactive: a click selects (cross-filter
 * and highlight), a double click drills down a hierarchy, a right click offers drill-through and
 * the rows behind a point. Every number shown is a value of the result; its lineage is one click away.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { type CondFormat, type FilterSpec, formatValue, type QueryResult, type ResultColumn, type Scalar, type ThemeSpec, type VisualSpec } from '@harness/plugin-ui';
import { cx } from '../../components/primitives.tsx';
import { Icon } from '../../icons.tsx';
import { clickFilters, visualOption } from './option.ts';

let echartsP: Promise<typeof import('echarts')> | undefined;
const loadECharts = () => (echartsP ??= import('echarts'));
const maps = new Set<string>();

export interface VisualEvents {
  /** A click on a data point: its filters (or null to clear). */
  onSelect?(filters: FilterSpec[] | null): void;
  /** Double click: drill down on a value. */
  onDrill?(value: Scalar): void;
  /** Right click: a menu at (x, y) for these filters. */
  onContext?(filters: FilterSpec[], at: { x: number; y: number }): void;
  /** Hover on a point (tooltip pages). */
  onHover?(filters: FilterSpec[] | null, at?: { x: number; y: number }): void;
  /** A slicer's value. */
  onSlicer?(field: string, filter: FilterSpec | null): void;
  onButton?(action: NonNullable<VisualSpec['options']>['button']): void;
  onDecomp?(path: Array<{ dim: string; value: Scalar }>): void;
}

export interface VisualProps extends VisualEvents {
  v: VisualSpec;
  result?: QueryResult;
  error?: string;
  loading?: boolean;
  theme: ThemeSpec;
  dark: boolean;
  /** The selection of this visual (drawn as selected). */
  selection?: FilterSpec[];
  /** Current slicer filter for a slicer's field. */
  slicerValue?: FilterSpec;
  decompPath?: Array<{ dim: string; value: Scalar }>;
  geo?(source: string): Promise<unknown>;
  renderMarkdown?(text: string): React.ReactNode;
  renderFence?(lang: string, source: string): React.ReactNode;
  static?: boolean;
  /** Called with the chart instance (PNG export). */
  chartRef?(c: { getDataURL(o: Record<string, unknown>): string } | null): void;
}

const CHARTS = new Set(['bar', 'column', 'line', 'area', 'combo', 'ribbon', 'waterfall', 'funnel', 'pie', 'donut', 'treemap', 'scatter', 'gauge', 'map']);

export function BiVisual(p: VisualProps): React.ReactElement {
  const { v, result, error } = p;
  if (error) return <div data-visual-error className="flex h-full items-center justify-center p-3 text-center text-[12px] text-hx-danger"><span><Icon name="alert" size={14} className="mr-1 inline" />{error}</span></div>;
  if (['text', 'image', 'button'].includes(v.type)) return <StaticVisual {...p} />;
  if (v.type === 'fence' && v.options?.fence?.source) return <div className="h-full overflow-auto">{p.renderFence?.(v.options.fence.lang, v.options.fence.source)}</div>;
  if (!result) return <div className="flex h-full items-center justify-center" data-visual-loading><span className="h-1 w-16 animate-pulse rounded bg-hx-border" /></div>;
  if (CHARTS.has(v.type)) return <ChartVisual {...p} result={result} />;
  switch (v.type) {
    case 'card': case 'multicard': return <Cards {...p} result={result} />;
    case 'kpi': return <Kpi {...p} result={result} />;
    case 'table': return <Table {...p} result={result} />;
    case 'matrix': return <Matrix {...p} result={result} />;
    case 'slicer': return <Slicer {...p} result={result} />;
    case 'decomp': return <Decomp {...p} result={result} />;
    case 'drivers': return <Drivers {...p} result={result} />;
    case 'narrative': return <Narrative {...p} result={result} />;
    case 'fence': return <div className="h-full overflow-auto">{p.renderFence?.(v.options?.fence?.lang ?? 'json', JSON.stringify({ columns: result.columns.map((c) => c.name), rows: result.rows, options: v.options }))}</div>;
  }
  return <div className="p-2 text-[12px] text-hx-muted">{v.type}</div>;
}

// ---------------- charts ----------------

function ChartVisual(p: VisualProps & { result: QueryResult }): React.ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const inst = useRef<import('echarts').ECharts | undefined>(undefined);
  const [err, setErr] = useState<string>();
  const cb = useRef(p);
  cb.current = p;
  const geoSource = p.v.type === 'map' ? p.v.options?.geo?.source : undefined;
  useEffect(() => {
    let dead = false;
    void (async () => {
      try {
        const echarts = await loadECharts();
        if (dead || !host.current) return;
        let option: Record<string, unknown>;
        if (p.v.type === 'map') option = await mapOption(echarts, p, geoSource);
        else option = visualOption(p.v, p.result, { theme: p.theme, dark: p.dark, selection: p.selection, static: p.static });
        if (dead || !host.current) return;
        if (!inst.current) {
          inst.current = echarts.init(host.current, p.dark ? 'dark' : undefined, { renderer: p.static ? 'svg' : 'canvas' });
          const c = inst.current;
          const filtersOf = (e: unknown) => clickFilters(cb.current.result, e as never);
          c.on('click', (e) => { const f = filtersOf(e); if (f) cb.current.onSelect?.(sameSel(cb.current.selection, f) ? null : f); });
          c.on('dblclick', (e) => { const raw = (e as { data?: { raw?: Scalar } }).data?.raw; if (raw !== undefined) cb.current.onDrill?.(raw); });
          c.on('contextmenu', (e) => { const f = filtersOf(e); const ev = (e as { event?: { event?: MouseEvent } }).event?.event; if (f && ev) { ev.preventDefault(); cb.current.onContext?.(f, { x: ev.clientX, y: ev.clientY }); } });
          c.on('mouseover', (e) => { const f = filtersOf(e); const ev = (e as { event?: { event?: MouseEvent } }).event?.event; if (f) cb.current.onHover?.(f, ev ? { x: ev.clientX, y: ev.clientY } : undefined); });
          c.on('globalout', () => cb.current.onHover?.(null));
          p.chartRef?.(c as never);
        }
        inst.current.setOption({ backgroundColor: 'transparent', textStyle: { fontFamily: 'inherit' }, ...option }, true);
        setErr(undefined);
      } catch (e) { if (!dead) setErr((e as Error).message); }
    })();
    return () => { dead = true; };
  }, [p.v, p.result, p.theme, p.dark, JSON.stringify(p.selection ?? null)]);
  useEffect(() => {
    const ro = new ResizeObserver(() => inst.current?.resize());
    if (host.current) ro.observe(host.current);
    return () => { ro.disconnect(); inst.current?.dispose(); inst.current = undefined; p.chartRef?.(null); };
  }, []);
  if (!p.result.rows.length) return <Empty />;
  return <>{err && <div className="p-2 text-[12px] text-hx-danger">{err}</div>}<div ref={host} data-chart="bi" data-rows={p.result.rowCount} className="h-full min-h-[80px] w-full" /></>;
}
const sameSel = (a?: FilterSpec[], b?: FilterSpec[]) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const Empty = () => <div data-visual-empty className="flex h-full items-center justify-center text-[12px] text-hx-muted">No data for this selection</div>;

/** Filled map (GeoJSON regions matched to the first dim) or points (lat/lon dims) on the GeoJSON's shapes; no tiles. */
async function mapOption(echarts: typeof import('echarts'), p: VisualProps & { result: QueryResult }, source?: string): Promise<Record<string, unknown>> {
  const r = p.result;
  const g = p.v.options?.geo ?? {};
  const name = `bi-${source ?? 'none'}`;
  if (source && !maps.has(name) && p.geo) { echarts.registerMap(name, (await p.geo(source)) as never); maps.add(name); }
  const dims = r.columns.map((c, i) => [c, i] as const).filter(([c]) => c.role === 'dim');
  const mi = r.columns.findIndex((c) => c.role === 'measure');
  const m = r.columns[mi];
  const vals = r.rows.map((x) => Number(x[mi])).filter(Number.isFinite);
  const visualMap = { min: Math.min(...vals, 0), max: Math.max(...vals, 1), left: 8, bottom: 8, calculable: true, inRange: { color: ['#d6e6f5', '#2a78d6'] }, formatter: (x: number) => formatValue(x, m?.format) };
  if (g.lat && g.lon) {
    const lat = dims.find(([c]) => c.field === g.lat); const lon = dims.find(([c]) => c.field === g.lon); const label = dims.find(([c]) => c !== lat?.[0] && c !== lon?.[0]);
    const data = r.rows.map((x) => ({ name: label ? String(x[label[1]]) : '', value: [Number(x[lon![1]]), Number(x[lat![1]]), mi >= 0 ? x[mi] : 1], raw: label ? x[label[1]] : null }));
    return { tooltip: { trigger: 'item', formatter: (q: { name: string; value: Scalar[] }) => `${q.name}: ${formatValue(q.value[2], m?.format)}` }, ...(source ? { geo: { map: name, roam: true, itemStyle: { areaColor: p.dark ? '#2a2926' : '#eeede8', borderColor: p.dark ? '#555' : '#bbb' } } } : { xAxis: { type: 'value', scale: true }, yAxis: { type: 'value', scale: true } }), visualMap: { ...visualMap, dimension: 2 }, series: [{ type: 'scatter', coordinateSystem: source ? 'geo' : 'cartesian2d', data, symbolSize: 10 }] };
  }
  const key = dims[0];
  return { tooltip: { trigger: 'item', formatter: (q: { name: string; value: number }) => `${q.name}: ${formatValue(q.value, m?.format)}` }, visualMap, series: [{ type: 'map', map: name, roam: true, nameProperty: g.key ?? 'name', data: r.rows.map((x) => ({ name: String(x[key?.[1] ?? 0]), value: x[mi], raw: x[key?.[1] ?? 0] })), emphasis: { label: { show: true } } }] };
}

// ---------------- cards and KPIs ----------------

const fmtCell = (v: VisualSpec, c: ResultColumn, x: Scalar) => formatValue(x, v.options?.formats?.[c.name] ?? c.format, c.grain);

function Cards({ v, result }: VisualProps & { result: QueryResult }) {
  const ms = result.columns.map((c, i) => [c, i] as const).filter(([c]) => c.role === 'measure');
  const dims = result.columns.map((c, i) => [c, i] as const).filter(([c]) => c.role === 'dim');
  if (!result.rows.length) return <Empty />;
  if (v.type === 'card' && !dims.length) {
    const [c, i] = ms[0]!;
    return (
      <div className="flex h-full flex-col justify-center px-3" data-card>
        <div className="truncate text-[clamp(20px,4.2cqw,40px)] font-semibold tabular-nums leading-tight text-hx-primary" data-card-value={String(result.rows[0]![i])}>{fmtCell(v, c, result.rows[0]![i]!)}</div>
        {(!v.title || v.title !== c.label) && <div className="truncate text-[12px] text-hx-muted">{c.label}</div>}
        {ms.slice(1).map(([c2, i2]) => <div key={c2.name} className="truncate text-[12px] text-hx-secondary">{c2.label}: <b className="tabular-nums">{fmtCell(v, c2, result.rows[0]![i2]!)}</b></div>)}
      </div>
    );
  }
  return (
    <div className="grid h-full auto-rows-min grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2 overflow-auto p-1" data-multicard>
      {result.rows.slice(0, 60).map((row, r) => (
        <div key={r} className="rounded-lg border border-hx-border-subtle p-2">
          <div className="truncate text-[11.5px] font-medium text-hx-muted">{dims.map(([c, i]) => fmtCell(v, c, row[i]!)).join(' · ') || v.title}</div>
          {ms.map(([c, i]) => <div key={c.name} className="flex items-baseline justify-between gap-2"><span className="truncate text-[11px] text-hx-muted">{c.label}</span><span className="text-[15px] font-semibold tabular-nums">{fmtCell(v, c, row[i]!)}</span></div>)}
        </div>
      ))}
    </div>
  );
}

function Spark({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return null;
  const lo = Math.min(...values); const hi = Math.max(...values); const span = hi - lo || 1;
  const pts = values.map((x, i) => `${(i / (values.length - 1)) * 100},${30 - ((x - lo) / span) * 28}`).join(' ');
  return <svg viewBox="0 0 100 32" preserveAspectRatio="none" className="h-8 w-full" aria-hidden><polyline points={`0,32 ${pts} 100,32`} fill={color} opacity={0.12} /><polyline points={pts} fill="none" stroke={color} strokeWidth={1.8} vectorEffect="non-scaling-stroke" /></svg>;
}

function Kpi({ v, result }: VisualProps & { result: QueryResult }) {
  if (!result.rows.length) return <Empty />;
  const row = result.rows[0]!;
  const col = (name?: string) => result.columns.findIndex((c) => c.name === name);
  const main = result.columns.findIndex((c) => c.role === 'measure');
  const t = typeof v.options?.target === 'string' ? col(v.options.target) : -1;
  const d = col('vs target');
  const delta = d >= 0 ? (row[d] as number | null) : null;
  const target = t >= 0 ? row[t] : typeof v.options?.target === 'number' ? v.options.target : null;
  const good = delta === null ? undefined : delta >= 0;
  const trend = (result.extra?.trend as Scalar[][] | undefined)?.map((x) => Number(x[1])).filter(Number.isFinite) ?? [];
  const c = result.columns[main]!;
  const period = result.columns.findIndex((x) => x.role === 'dim');
  return (
    <div className="flex h-full flex-col justify-between px-3 py-1" data-kpi>
      <div>
        {(!v.title || period >= 0) && <div className="truncate text-[12px] text-hx-muted">{v.title ? '' : c.label}{period >= 0 && <span data-kpi-period>{v.title ? '' : ' · '}{formatValue(row[period]!, result.columns[period]!.format, result.columns[period]!.grain)}</span>}</div>}
        <div className="truncate text-[clamp(20px,4cqw,36px)] font-semibold tabular-nums" data-kpi-value={String(row[main])}>{fmtCell(v, c, row[main]!)}</div>
        {target !== null && <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <span className="text-hx-muted">Target {formatValue(target, t >= 0 ? result.columns[t]!.format : c.format)}</span>
          {delta !== null && <span className={good ? 'text-hx-success' : 'text-hx-danger'} data-kpi-delta>{good ? '▲' : '▼'} {formatValue(delta, 'percent:1')}</span>}
        </div>}
      </div>
      {trend.length > 1 && <Spark values={trend} color={good === false ? 'var(--hx-danger)' : 'var(--hx-accent)'} />}
    </div>
  );
}

// ---------------- tables ----------------

function lerp(a: string, b: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return `rgb(${x.map((v0, i) => Math.round(v0 + (y[i]! - v0) * t)).join(',')})`;
}
/** Conditional formatting of one cell: background scale, a data bar, an icon, or a rule's colour. */
export function condStyle(cfs: CondFormat[] | undefined, col: string, x: Scalar, range: { min: number; max: number } | undefined): { style?: React.CSSProperties; bar?: number; icon?: string } {
  const cf = cfs?.find((c) => c.field === col);
  if (!cf || typeof x !== 'number') return {};
  const min = cf.min ?? range?.min ?? 0; const max = cf.max ?? range?.max ?? 1;
  const t = max === min ? 1 : Math.max(0, Math.min(1, (x - min) / (max - min)));
  if (cf.kind === 'scale') {
    const cs = cf.colors?.length ? cf.colors : ['#f8696b', '#ffeb84', '#63be7b'];
    const bg = cs.length === 3 ? (t < 0.5 ? lerp(cs[0]!, cs[1]!, t * 2) : lerp(cs[1]!, cs[2]!, (t - 0.5) * 2)) : lerp(cs[0]!, cs[1] ?? cs[0]!, t);
    return { style: { background: bg, color: '#1f1e1c' } };
  }
  if (cf.kind === 'bars') return { bar: t };
  const hit = cf.rules?.find((r) => (r.op === 'gt' ? x > r.value : r.op === 'ge' ? x >= r.value : r.op === 'lt' ? x < r.value : r.op === 'le' ? x <= r.value : r.op === 'eq' ? x === r.value : x >= r.value && x <= (r.to ?? r.value)));
  if (cf.kind === 'icons') return { icon: hit?.icon ?? (t > 0.66 ? 'up' : t < 0.33 ? 'down' : 'flat') };
  return hit?.color ? { style: { color: hit.color, fontWeight: 600 } } : {};
}
const ICON_GLYPH: Record<string, string> = { up: '▲', down: '▼', flat: '▶', ok: '●', warn: '▲', bad: '■' };
const ICON_COLOR: Record<string, string> = { up: 'var(--hx-success)', ok: 'var(--hx-success)', down: 'var(--hx-danger)', bad: 'var(--hx-danger)', warn: 'var(--hx-warning)', flat: 'var(--hx-text-muted)' };

function Cell({ v, c, x, range }: { v: VisualSpec; c: ResultColumn; x: Scalar; range?: { min: number; max: number } }) {
  const cf = condStyle(v.options?.conditional, c.name, x, range);
  if (cf.style?.background) { const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(String(cf.style.background)); if (m && (0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3])) < 140) cf.style = { ...cf.style, color: '#ffffff' }; }
  return (
    <td style={cf.style} className={cx('relative px-2 py-1', c.role !== 'dim' && typeof x === 'number' && 'text-right tabular-nums')}>
      {cf.bar !== undefined && <span className="absolute inset-y-1 left-0 rounded-r bg-hx-accent/25" style={{ width: `${Math.round(cf.bar * 100)}%` }} />}
      <span className="relative">{cf.icon && <span style={{ color: ICON_COLOR[cf.icon] }} className="mr-1">{ICON_GLYPH[cf.icon]}</span>}{fmtCell(v, c, x)}</span>
    </td>
  );
}
function ranges(r: QueryResult, rows: Scalar[][]): Record<string, { min: number; max: number }> {
  const out: Record<string, { min: number; max: number }> = {};
  r.columns.forEach((c, i) => { const xs = rows.map((x) => x[i]).filter((x): x is number => typeof x === 'number'); if (xs.length) out[c.name] = { min: Math.min(...xs), max: Math.max(...xs) }; });
  return out;
}

function Table({ v, result, onSelect, selection, onContext }: VisualProps & { result: QueryResult }) {
  const level = result.columns.findIndex((c) => c.role === 'level');
  const cols = result.columns.map((c, i) => [c, i] as const).filter(([c]) => c.role !== 'level');
  const body = level >= 0 ? result.rows.filter((x) => x[level] === 0) : result.rows;
  const total = level >= 0 ? result.rows.find((x) => x[level] === Math.max(...result.rows.map((y) => Number(y[level])))) : undefined;
  const [sort, setSort] = useState<{ i: number; desc: boolean }>();
  const rows = useMemo(() => (sort ? [...body].sort((a, b) => { const x = a[sort.i]; const y = b[sort.i]; const d = x === y ? 0 : x === null ? 1 : y === null ? -1 : x < y ? -1 : 1; return sort.desc ? -d : d; }) : body), [body, sort]);
  const rg = useMemo(() => ranges(result, body), [result, body]);
  const dimCol = cols.find(([c]) => c.role === 'dim' || c.role === 'column');
  if (!rows.length) return <Empty />;
  return (
    <div className="h-full overflow-auto" data-bi-table>
      <table className="w-full border-collapse text-[12.5px]">
        <thead className="sticky top-0 z-10 bg-hx-elevated"><tr>{cols.map(([c, i]) => (
          <th key={c.name} scope="col" aria-sort={sort?.i === i ? (sort.desc ? 'descending' : 'ascending') : 'none'} className={cx('cursor-pointer select-none whitespace-nowrap border-b border-hx-border px-2 py-1 font-medium text-hx-secondary hover:text-hx-primary', c.role === 'measure' ? 'text-right' : 'text-left')} onClick={() => setSort((s) => (s?.i === i ? { i, desc: !s.desc } : { i, desc: c.role === 'measure' }))}>{c.label}{sort?.i === i ? (sort.desc ? ' ▾' : ' ▴') : ''}</th>
        ))}</tr></thead>
        <tbody>{rows.slice(0, 2000).map((row, r) => {
          const f: FilterSpec[] | undefined = dimCol && dimCol[0].field ? [{ field: dimCol[0].field, op: row[dimCol[1]] === null ? 'is_null' : 'eq', ...(row[dimCol[1]] === null ? {} : { value: row[dimCol[1]] }) }] : undefined;
          const sel = f && JSON.stringify(selection) === JSON.stringify(f);
          return <tr key={r} className={cx('border-b border-hx-border-subtle', f && 'cursor-pointer hover:bg-hx-hover', sel && 'bg-hx-accent-soft')} onClick={() => f && onSelect?.(sel ? null : f)} onContextMenu={(e) => { if (f && onContext) { e.preventDefault(); onContext(f, { x: e.clientX, y: e.clientY }); } }}>{cols.map(([c, i]) => <Cell key={c.name} v={v} c={c} x={row[i]!} range={rg[c.name]} />)}</tr>;
        })}</tbody>
        {total && <tfoot className="sticky bottom-0 bg-hx-elevated font-semibold"><tr>{cols.map(([c, i], k) => <td key={c.name} className={cx('border-t border-hx-border px-2 py-1', c.role === 'measure' && 'text-right tabular-nums')}>{k === 0 && c.role !== 'measure' ? 'Total' : c.role === 'measure' ? fmtCell(v, c, total[i]!) : ''}</td>)}</tr></tfoot>}
      </table>
      {result.truncated && <div className="p-1 text-[11px] text-hx-muted">Showing the first {result.rowCount} rows.</div>}
    </div>
  );
}

/** A matrix: row dims down (stepped, expandable), column dims across, subtotals from the engine's grouping sets. */
function Matrix({ v, result }: VisualProps & { result: QueryResult }) {
  const level = result.columns.findIndex((c) => c.role === 'level');
  const dims = result.columns.map((c, i) => [c, i] as const).filter(([c]) => c.role === 'dim');
  const ms = result.columns.map((c, i) => [c, i] as const).filter(([c]) => c.role === 'measure');
  const nr = Math.max(1, Math.min(dims.length, v.options?.rows ?? 1));
  const rd = dims.slice(0, nr); const cd = dims.slice(nr);
  const n = dims.length;
  // GROUPING(d0..dn): bit (n-1-i) set when dim i is rolled up.
  const rolled = (row: Scalar[], i: number) => level >= 0 && ((Number(row[level]) >> (n - 1 - dims[i]![1] + dims[0]![1])) & 1) === 1;
  const colKeys: Scalar[][] = [];
  for (const row of result.rows) { if (cd.some((_, k) => rolled(row, nr + k))) continue; const key = cd.map(([, i]) => row[i]!); if (!colKeys.some((x) => JSON.stringify(x) === JSON.stringify(key))) colKeys.push(key); }
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const stepped = v.options?.stepped !== false;
  type Line = { path: Scalar[]; depth: number; cells: Map<string, Scalar[]>; total: Scalar[] | undefined; isTotal: boolean };
  const lines = new Map<string, Line>();
  for (const row of result.rows) {
    const depth = rd.findIndex((_, k) => rolled(row, k));
    const d = depth < 0 ? nr : depth;
    const path = rd.slice(0, d).map(([, i]) => row[i]!);
    const k = JSON.stringify(path);
    const ln = lines.get(k) ?? { path, depth: d, cells: new Map(), total: undefined, isTotal: d === 0 };
    const colRolled = cd.length > 0 && cd.every((_, j) => rolled(row, nr + j));
    if (cd.length && !colRolled) ln.cells.set(JSON.stringify(cd.map(([, i]) => row[i]!)), ms.map(([, i]) => row[i]!));
    else ln.total = ms.map(([, i]) => row[i]!);
    lines.set(k, ln);
  }
  const sorted = [...lines.values()].filter((l) => l.depth > 0).sort((a, b) => { for (let i = 0; i < Math.max(a.path.length, b.path.length); i++) { if (i >= a.path.length) return -1; if (i >= b.path.length) return 1; const x = String(a.path[i]); const y = String(b.path[i]); if (x !== y) return x < y ? -1 : 1; } return 0; });
  const visible = sorted.filter((l) => l.path.slice(0, -1).every((_, i) => i === 0 || open[JSON.stringify(l.path.slice(0, i))] !== false) && (l.depth === 1 || open[JSON.stringify(l.path.slice(0, l.depth - 1))] === true || !stepped));
  const grand = lines.get('[]');
  // Colour scales compare like with like: rows at the same depth, cells of the same kind.
  const rgAt = (depth: number) => ranges(result, result.rows.filter((x) => { const d = rd.findIndex((_, k) => rolled(x, k)); return (d < 0 ? nr : d) === depth && !(cd.length && cd.every((_, j) => rolled(x, nr + j))); }));
  const rgCache = new Map<number, Record<string, { min: number; max: number }>>();
  const rgFor = (depth: number) => { if (!rgCache.has(depth)) rgCache.set(depth, rgAt(depth)); return rgCache.get(depth)!; };
  const header = colKeys.length ? colKeys.flatMap((k) => ms.map(([m]) => ({ k, m, label: `${k.map((x, j) => formatValue(x, cd[j]![0].format, cd[j]![0].grain)).join(' · ')}${ms.length > 1 ? ` ${m.label}` : ''}` }))) : ms.map(([m]) => ({ k: [] as Scalar[], m, label: m.label }));
  const vals = (l: Line, k: Scalar[]) => (colKeys.length ? l.cells.get(JSON.stringify(k)) : l.total);
  return (
    <div className="h-full overflow-auto" data-bi-matrix>
      <table className="w-full border-collapse text-[12.5px]">
        <thead className="sticky top-0 z-10 bg-hx-elevated"><tr><th className="border-b border-hx-border px-2 py-1 text-left font-medium text-hx-secondary">{rd.map(([c]) => c.label).join(' / ')}</th>{header.map((h, i) => <th key={i} className="whitespace-nowrap border-b border-hx-border px-2 py-1 text-right font-medium text-hx-secondary">{h.label}</th>)}{colKeys.length > 0 && ms.map(([m]) => <th key={`t-${m.name}`} className="border-b border-hx-border px-2 py-1 text-right font-semibold">Total{ms.length > 1 ? ` ${m.label}` : ''}</th>)}</tr></thead>
        <tbody>{visible.map((l) => {
          const key = JSON.stringify(l.path);
          const canOpen = stepped && l.depth < nr;
          const isOpen = open[key] === true;
          return (
            <tr key={key} className={cx('border-b border-hx-border-subtle', l.depth < nr && 'font-medium')} data-matrix-row={l.depth}>
              <td className="whitespace-nowrap px-2 py-1" style={{ paddingLeft: 8 + (l.depth - 1) * 16 }}>
                {canOpen && <button type="button" aria-expanded={isOpen} aria-label={isOpen ? 'Collapse' : 'Expand'} className="mr-1 text-hx-muted hover:text-hx-primary" onClick={() => setOpen((o) => ({ ...o, [key]: !isOpen }))}>{isOpen ? '▾' : '▸'}</button>}
                {formatValue(l.path.at(-1) ?? null, rd[l.depth - 1]?.[0].format, rd[l.depth - 1]?.[0].grain) || '(blank)'}
              </td>
              {header.map((h, i) => { const vv = vals(l, h.k); const mi = ms.findIndex(([m]) => m === h.m); return <Cell key={i} v={v} c={h.m} x={vv?.[mi] ?? null} range={rgFor(l.depth)[h.m.name]} />; })}
              {colKeys.length > 0 && ms.map(([m], mi) => <td key={m.name} className="px-2 py-1 text-right font-semibold tabular-nums">{fmtCell(v, m, l.total?.[mi] ?? null)}</td>)}
            </tr>
          );
        })}</tbody>
        {grand && <tfoot className="sticky bottom-0 bg-hx-elevated font-semibold"><tr><td className="border-t border-hx-border px-2 py-1">Total</td>{header.map((h, i) => { const vv = vals(grand, h.k); const mi = ms.findIndex(([m]) => m === h.m); return <td key={i} className="border-t border-hx-border px-2 py-1 text-right tabular-nums">{fmtCell(v, h.m, vv?.[mi] ?? null)}</td>; })}{colKeys.length > 0 && ms.map(([m], mi) => <td key={m.name} className="border-t border-hx-border px-2 py-1 text-right tabular-nums">{fmtCell(v, m, grand.total?.[mi] ?? null)}</td>)}</tr></tfoot>}
      </table>
    </div>
  );
}

// ---------------- slicers ----------------

function Slicer({ v, result, onSlicer, slicerValue }: VisualProps & { result: QueryResult }) {
  const s = v.options!.slicer!;
  const c = result.columns[0]!;
  const values = result.rows.map((r) => r[0]!);
  const style = s.style ?? (values.length > 12 ? 'dropdown' : 'list');
  const sel = new Set((slicerValue?.op === 'in' ? slicerValue.values : slicerValue?.op === 'eq' ? [slicerValue.value] : [])?.map((x) => JSON.stringify(x)));
  const set = (vals: Scalar[]) => onSlicer?.(s.field, vals.length ? { field: s.field, op: 'in', values: vals } : null);
  const toggle = (x: Scalar) => { const k = JSON.stringify(x); const cur = values.filter((y) => sel.has(JSON.stringify(y))); set(sel.has(k) ? cur.filter((y) => JSON.stringify(y) !== k) : s.multi === false ? [x] : [...cur, x]); };
  const [q, setQ] = useState('');
  if (style === 'range') {
    const nums = values.filter((x) => x !== null);
    const lo = slicerValue?.op === 'between' ? slicerValue.value : undefined; const hi = slicerValue?.op === 'between' ? slicerValue.to : undefined;
    const isDate = /DATE|TIME/.test(c.type);
    const apply = (a: string, b: string) => onSlicer?.(s.field, a || b ? { field: s.field, op: 'between', value: isDate ? a || String(nums[0]) : Number(a || nums[0]), to: isDate ? b || String(nums.at(-1)) : Number(b || nums.at(-1)) } : null);
    return (
      <div className="flex h-full flex-col justify-center gap-1 px-2 text-[12px]" data-slicer="range">
        <div className="flex items-center gap-1">
          <input aria-label={`${c.label} from`} type={isDate ? 'date' : 'number'} defaultValue={String(lo ?? '')} placeholder={formatValue(nums[0] ?? null, c.format, c.grain)} className="w-0 min-w-0 flex-1 rounded border border-hx-border bg-hx-bg px-1.5 py-1" onBlur={(e) => apply(e.target.value, String(hi ?? ''))} />
          <span className="text-hx-muted">to</span>
          <input aria-label={`${c.label} to`} type={isDate ? 'date' : 'number'} defaultValue={String(hi ?? '')} placeholder={formatValue(nums.at(-1) ?? null, c.format, c.grain)} className="w-0 min-w-0 flex-1 rounded border border-hx-border bg-hx-bg px-1.5 py-1" onBlur={(e) => apply(String(lo ?? ''), e.target.value)} />
        </div>
      </div>
    );
  }
  if (style === 'relative') {
    const cur = slicerValue?.op === 'relative' ? `${slicerValue.n}-${slicerValue.unit}` : '';
    return (
      <div className="flex h-full items-center px-2" data-slicer="relative">
        <select aria-label={c.label} value={cur} className="w-full rounded border border-hx-border bg-hx-bg px-2 py-1 text-[12.5px]" onChange={(e) => { const [n, unit] = e.target.value.split('-'); onSlicer?.(s.field, e.target.value ? { field: s.field, op: 'relative', n: Number(n), unit: unit as 'day', current: true } : null); }}>
          <option value="">All time</option>
          {[['7', 'day'], ['30', 'day'], ['3', 'month'], ['6', 'month'], ['12', 'month'], ['1', 'year'], ['2', 'year']].map(([n, u]) => <option key={`${n}-${u}`} value={`${n}-${u}`}>Last {n} {u}{n === '1' ? '' : 's'}</option>)}
        </select>
      </div>
    );
  }
  if (style === 'dropdown') {
    return (
      <div className="flex h-full flex-col gap-1 px-2 py-1" data-slicer="dropdown">
        <select aria-label={c.label} multiple={s.multi !== false} value={values.filter((x) => sel.has(JSON.stringify(x))).map((x) => JSON.stringify(x))} className="min-h-0 w-full flex-1 rounded border border-hx-border bg-hx-bg px-1 py-0.5 text-[12.5px]" onChange={(e) => set([...e.target.selectedOptions].map((o) => JSON.parse(o.value) as Scalar))}>
          {values.map((x) => <option key={JSON.stringify(x)} value={JSON.stringify(x)}>{formatValue(x, c.format, c.grain) || '(blank)'}</option>)}
        </select>
        {sel.size > 0 && <button type="button" className="self-start text-[11px] text-hx-accent-text hover:underline" onClick={() => set([])}>Clear</button>}
      </div>
    );
  }
  if (style === 'buttons') return <div className="flex h-full flex-wrap content-start gap-1 overflow-auto p-1" data-slicer="buttons">{values.map((x) => <button key={JSON.stringify(x)} type="button" aria-pressed={sel.has(JSON.stringify(x))} onClick={() => toggle(x)} className={cx('rounded-full border px-2.5 py-0.5 text-[12px]', sel.has(JSON.stringify(x)) ? 'border-hx-accent bg-hx-accent text-hx-on-accent' : 'border-hx-border hover:bg-hx-hover')}>{formatValue(x, c.format, c.grain) || '(blank)'}</button>)}</div>;
  const shown = values.filter((x) => !q || String(x).toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="flex h-full flex-col" data-slicer="list">
      {values.length > 8 && <input aria-label={`Search ${c.label}`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="mx-1 mb-1 rounded border border-hx-border bg-hx-bg px-1.5 py-0.5 text-[12px]" />}
      <div className="min-h-0 flex-1 overflow-auto px-1">{shown.map((x) => (
        <label key={JSON.stringify(x)} className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 text-[12.5px] hover:bg-hx-hover">
          <input type="checkbox" checked={sel.has(JSON.stringify(x))} onChange={() => toggle(x)} className="accent-[var(--hx-accent)]" />
          <span className="truncate">{formatValue(x, c.format, c.grain) || '(blank)'}</span>
        </label>
      ))}</div>
      {sel.size > 0 && <button type="button" className="mx-2 mb-1 self-start text-[11px] text-hx-accent-text hover:underline" onClick={() => set([])}>Clear</button>}
    </div>
  );
}

// ---------------- analysis visuals ----------------

function Decomp({ v, result, onDecomp, decompPath }: VisualProps & { result: QueryResult }) {
  const e = (result.extra ?? {}) as { total?: Scalar; next?: string | null; spread?: Array<{ dim: string; variance: number | null }>; remaining?: string[] };
  const path = decompPath ?? [];
  const m = result.columns.find((c) => c.role === 'measure');
  const max = Math.max(1e-9, ...result.rows.map((r) => Math.abs(Number(r[1] ?? 0))));
  return (
    <div className="flex h-full flex-col gap-1 overflow-auto p-2 text-[12.5px]" data-decomp>
      <div className="flex flex-wrap items-center gap-1">
        <button type="button" className="rounded-md border border-hx-border px-2 py-0.5 font-semibold" onClick={() => onDecomp?.([])}>{m?.label ?? 'Total'}: {formatValue(e.total ?? null, m?.format)}</button>
        {path.map((p0, i) => <React.Fragment key={i}><span className="text-hx-muted">›</span><button type="button" className="rounded-md bg-hx-accent-soft px-2 py-0.5" onClick={() => onDecomp?.(path.slice(0, i + 1))}>{p0.dim.split('.').pop()}: {String(p0.value)}</button></React.Fragment>)}
      </div>
      {e.next && <div className="text-[11.5px] text-hx-muted" data-decomp-next={e.next}>Split by <b>{e.next.split('.').pop()}</b> (largest spread{e.spread?.[1] ? `; next: ${e.spread[1].dim.split('.').pop()}` : ''})</div>}
      <div className="space-y-0.5">{result.rows.map((r, i) => (
        <button key={i} type="button" className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-hx-hover" onClick={() => e.next && onDecomp?.([...path, { dim: e.next, value: r[0]! }])}>
          <span className="w-28 shrink-0 truncate">{String(r[0] ?? '(blank)')}</span>
          <span className="relative h-4 flex-1 rounded bg-hx-border-subtle"><span className="absolute inset-y-0 left-0 rounded bg-hx-accent" style={{ width: `${(Math.abs(Number(r[1] ?? 0)) / max) * 100}%` }} /></span>
          <span className="w-20 shrink-0 text-right tabular-nums">{formatValue(r[1] ?? null, m?.format)}</span>
        </button>
      ))}</div>
      {result.method && <div className="mt-auto text-[10.5px] text-hx-muted">{result.method}</div>}
    </div>
  );
}

function Drivers({ result }: VisualProps & { result: QueryResult }) {
  return (
    <div className="flex h-full flex-col gap-1 overflow-auto p-2 text-[12.5px]" data-drivers>
      {result.rows.map((r, i) => { const ratio = Number(r[4] ?? 1); const up = ratio >= 1; return (
        <div key={i} className="flex items-center gap-2">
          <span className="w-40 shrink-0 truncate"><span className="text-hx-muted">{String(r[0]).split('.').pop()} =</span> {String(r[1])}</span>
          <span className="relative h-3 flex-1"><span className={cx('absolute inset-y-0 rounded', up ? 'left-1/2 bg-hx-success' : 'right-1/2 bg-hx-danger')} style={{ width: `${Math.min(50, Math.abs(ratio - 1) * 50)}%` }} /><span className="absolute inset-y-0 left-1/2 w-px bg-hx-border" /></span>
          <span className="w-16 shrink-0 text-right tabular-nums">{formatValue(ratio, 'number:2')}×</span>
          <span className="w-14 shrink-0 text-right text-hx-muted tabular-nums">{formatValue(r[3] ?? null, 'integer')}</span>
        </div>
      ); })}
      {result.method && <div className="mt-auto text-[10.5px] text-hx-muted">{result.method}</div>}
    </div>
  );
}

function Narrative({ result, renderMarkdown }: VisualProps & { result: QueryResult }) {
  const e = (result.extra ?? {}) as { text?: string; refs?: Array<{ measure: string; formatted: string; filters: FilterSpec[] }> };
  if (!e.text) return <div className="p-2 text-[12px] text-hx-muted">No narrative yet: ask the agent to summarise, or write one with {'{{Measure}}'} placeholders.</div>;
  return (
    <div className="h-full overflow-auto p-2 text-[13px] leading-relaxed" data-narrative>
      {renderMarkdown ? renderMarkdown(e.text) : e.text}
      {!!e.refs?.length && <div className="mt-2 flex flex-wrap gap-1 text-[10.5px] text-hx-muted" aria-label="Where the numbers come from">{e.refs.map((r, i) => <span key={i} title={r.filters.map((f) => `${f.field} = ${String(f.value)}`).join(', ') || 'all rows'} className="rounded bg-hx-code px-1">{r.formatted} = {r.measure}{r.filters.length ? ` [${r.filters.map((f) => String(f.value)).join(', ')}]` : ''}</span>)}</div>}
    </div>
  );
}

function StaticVisual({ v, renderMarkdown, onButton }: VisualProps) {
  const o = v.options ?? {};
  if (v.type === 'image') return o.url ? <img src={o.url} alt={o.alt ?? v.title ?? ''} className="h-full w-full object-contain" /> : <div className="p-2 text-[12px] text-hx-muted">No image</div>;
  if (v.type === 'button') return <div className="flex h-full items-center justify-center p-1"><button type="button" data-bi-button className="w-full rounded-lg bg-hx-accent px-3 py-1.5 text-[13px] font-medium text-hx-on-accent hover:bg-hx-accent-hover" onClick={() => onButton?.(o.button)}>{o.button?.label ?? 'Button'}</button></div>;
  return <div className="h-full overflow-auto px-2 py-1 text-[13px]" data-bi-text>{renderMarkdown ? renderMarkdown(o.markdown ?? '') : o.markdown}</div>;
}
