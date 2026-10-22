/**
 * A dashboard or report, live: pages, a 12-column grid (drag and resize when editing), slicers,
 * cross-filter and cross-highlight between visuals, hierarchy drill, drill-through with the filter
 * context, tooltip pages, bookmarks and buttons, a phone layout, TV mode, and live refresh. The same
 * component draws the app's editor, published pages and static exports; only the client differs.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type DocSpec, type FilterSpec, formatValue, type HierarchySpec, type PageSpec, type QueryResult, type Scalar, themeOf, type ViewState, type VisualSpec } from '@harness/plugin-ui';
import { cx } from '../../components/primitives.tsx';
import { Icon } from '../../icons.tsx';
import { BiVisual, type VisualEvents } from './Visual.tsx';
import { toCsvText } from './csv.ts';

export interface BiClient {
  /** A visual's numbers in a state (the server applies filters, interactions, drill and row-level security). */
  visual(v: VisualSpec, state: ViewState, signal: AbortSignal): Promise<QueryResult>;
  geo?(source: string): Promise<unknown>;
  /** Live changes: "refreshed" (data), "doc_changed", "gone". */
  subscribe?(on: (e: { type: string }) => void): () => void;
  /** Detail rows behind a point ("see records"); absent where not allowed. */
  records?(v: VisualSpec, filters: FilterSpec[], state: ViewState): Promise<QueryResult>;
}

export interface DocViewProps {
  doc: DocSpec;
  client: BiClient;
  hierarchies?: HierarchySpec[];
  dark: boolean;
  /** Editing: selecting visuals, moving and resizing them (each change is an op the host applies). */
  edit?: { selected?: string | null; onSelect(id: string | null): void; onLayout(id: string, layout: VisualSpec['layout']): void; mobile?: boolean };
  renderMarkdown?(text: string): React.ReactNode;
  renderFence?(lang: string, source: string): React.ReactNode;
  mode?: 'app' | 'published' | 'static';
  print?: boolean;
  /** The current page (controlled) and its change. */
  page?: string;
  onPage?(id: string): void;
  /** The state as it changes (the host saves bookmarks from it, or gives it to the agent). */
  onState?(s: ViewState): void;
  /** Visual header extras (the host's menu: pin, edit...). */
  visualActions?(v: VisualSpec, result?: QueryResult): React.ReactNode;
  toolbar?: React.ReactNode;
}

const ROW = 40;
const GAP = 8;

export function DocView(p: DocViewProps): React.ReactElement {
  const { doc } = p;
  const theme = themeOf(doc.theme);
  const pages = doc.pages.filter((x) => !x.kind || x.kind === 'page');
  const [pageId, setPageId] = useState(p.page ?? pages[0]?.id ?? doc.pages[0]!.id);
  useEffect(() => { if (p.page && p.page !== pageId) setPageId(p.page); }, [p.page]);
  const page = doc.pages.find((x) => x.id === pageId) ?? doc.pages[0]!;
  const [filters, setFilters] = useState<FilterSpec[]>([]);
  const [selection, setSelection] = useState<ViewState['selection']>();
  const [drill, setDrill] = useState<NonNullable<ViewState['drill']>>({});
  const [decomp, setDecomp] = useState<NonNullable<ViewState['decomp']>>({});
  const [drillthrough, setDrillthrough] = useState<FilterSpec[] | undefined>();
  const [back, setBack] = useState<Array<{ page: string; drillthrough?: FilterSpec[] }>>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [version, setVersion] = useState(0);
  const [refreshedAt, setRefreshedAt] = useState(Date.now());
  const [menu, setMenu] = useState<{ v: VisualSpec; filters: FilterSpec[]; x: number; y: number }>();
  const [records, setRecords] = useState<{ title: string; result?: QueryResult; error?: string }>();
  const [tip, setTip] = useState<{ v: VisualSpec; filters: FilterSpec[]; x: number; y: number }>();
  const [focus, setFocus] = useState<string>();
  const [tv, setTv] = useState(false);
  const [gone, setGone] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1200);
  useEffect(() => { const ro = new ResizeObserver(([e]) => setWidth(e!.contentRect.width)); if (host.current) ro.observe(host.current); return () => ro.disconnect(); }, []);
  useEffect(() => { setSelection(undefined); setFocus(undefined); p.onPage?.(pageId); }, [pageId]);
  useEffect(() => p.client.subscribe?.((e) => {
    if (e.type === 'gone') setGone(true);
    if (e.type === 'refreshed' || e.type === 'doc_changed') { setVersion((n) => n + 1); setRefreshedAt(Date.now()); }
  }), [p.client]);
  // TV mode: full screen, the pages in turn.
  useEffect(() => {
    if (!tv) return;
    void host.current?.requestFullscreen?.().catch(() => {});
    const t = setInterval(() => setPageId((cur) => { const i = pages.findIndex((x) => x.id === cur); return pages[(i + 1) % pages.length]!.id; }), 30_000);
    const off = () => { if (!document.fullscreenElement) setTv(false); };
    document.addEventListener('fullscreenchange', off);
    return () => { clearInterval(t); document.removeEventListener('fullscreenchange', off); };
  }, [tv]);

  const state: ViewState = useMemo(() => ({ page: page.id, filters, ...(selection ? { selection } : {}), drill, decomp, ...(drillthrough && page.kind === 'drillthrough' ? { drillthrough } : {}) }), [page.id, filters, selection, drill, decomp, drillthrough, page.kind]);
  useEffect(() => { p.onState?.(state); }, [state]);

  const setSlicer = useCallback((field: string, f: FilterSpec | null) => { setFilters((cur) => [...cur.filter((x) => x.field !== field), ...(f ? [f] : [])]); setSelection(undefined); }, []);
  const hierarchyOf = (v: VisualSpec) => (v.options?.hierarchy ? p.hierarchies?.find((h) => h.name === v.options!.hierarchy) : undefined);
  const drillTargets = (fs: FilterSpec[]) => doc.pages.filter((x) => x.kind === 'drillthrough' && x.drillFields?.some((d) => fs.some((f) => f.field === d || f.field.replace(/:.*$/, '') === d.replace(/:.*$/, ''))));
  const goDrillthrough = (target: PageSpec, fs: FilterSpec[]) => {
    setBack((b) => [...b, { page: page.id, drillthrough }]);
    // The clicked point's values, plus the slicers in force, travel into the page.
    setDrillthrough([...filters, ...(selection?.filters ?? []), ...fs]);
    setPageId(target.id);
  };
  const button = (b: NonNullable<VisualSpec['options']>['button']) => {
    if (!b) return;
    if (b.action === 'bookmark') { const bm = doc.bookmarks?.find((x) => x.id === b.target); if (bm) applyBookmark(bm); }
    else if (b.action === 'page' && b.target) setPageId(b.target);
    else if (b.action === 'back') goBack();
    else if (b.action === 'clear') { setFilters([]); setSelection(undefined); setDrill({}); }
    else if (b.action === 'url' && b.target && /^https:\/\//.test(b.target)) window.open(b.target, '_blank', 'noopener');
  };
  const applyBookmark = (bm: NonNullable<DocSpec['bookmarks']>[number]) => { setPageId(bm.page); setFilters(bm.filters ?? []); setHidden(bm.hidden ?? []); setSelection(bm.selection); };
  const goBack = () => { const last = back.at(-1); if (!last) return; setBack((b) => b.slice(0, -1)); setDrillthrough(last.drillthrough); setPageId(last.page); };

  const mobile = width < 640 && !p.edit;
  const visuals = page.visuals.filter((v) => !hidden.includes(v.id) && !(mobile && v.mobile?.hidden));
  const ordered = mobile || doc.type === 'report' ? [...visuals].sort((a, b) => (mobile ? (a.mobile?.order ?? 999) - (b.mobile?.order ?? 999) : 0) || a.layout.y - b.layout.y || a.layout.x - b.layout.x) : visuals;
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const ready = Object.values(loading).every((x) => !x) && Object.keys(loading).length >= visuals.filter((v) => !['text', 'image', 'button'].includes(v.type) && !(v.type === 'fence' && v.options?.fence?.source)).length;
  const active = filters.length + (selection ? 1 : 0) + (drillthrough && page.kind === 'drillthrough' ? drillthrough.length : 0);

  if (gone) return <div className="flex h-full items-center justify-center p-8 text-center text-hx-secondary" data-bi-gone>This page is no longer published.</div>;
  const bg = theme.background ? { background: theme.background, color: theme.foreground } : undefined;
  return (
    <div ref={host} className={cx('flex h-full min-h-0 flex-col', tv && 'bg-hx-bg text-[115%]')} style={bg} data-bi-doc={doc.type} data-bi-ready={ready ? '1' : '0'} data-bi-page={page.id}>
      {!p.print && (
        <div className="flex flex-wrap items-center gap-1 border-b border-hx-border-subtle px-2 py-1" data-bi-toolbar>
          {back.length > 0 && <button type="button" className="mr-1 flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] hover:bg-hx-hover" onClick={goBack} data-bi-back><Icon name="arrow-left" size={13} />Back</button>}
          <div role="tablist" aria-label="Pages" className="flex min-w-0 flex-wrap gap-0.5">
            {pages.map((x) => <button key={x.id} role="tab" type="button" aria-selected={x.id === page.id} data-bi-tab={x.id} onClick={() => setPageId(x.id)} className={cx('rounded-md px-2 py-0.5 text-[12.5px]', x.id === page.id ? 'bg-hx-accent-soft font-medium text-hx-primary' : 'text-hx-secondary hover:bg-hx-hover')}>{x.name}</button>)}
            {page.kind === 'drillthrough' && <span className="rounded-md bg-hx-accent-soft px-2 py-0.5 text-[12.5px] font-medium">{page.name}</span>}
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-1">
            {active > 0 && <span className="flex flex-wrap gap-1" data-bi-filters>{[...filters, ...(selection?.filters ?? [])].map((f, i) => <span key={i} className="flex items-center gap-1 rounded-full bg-hx-code px-2 py-0.5 text-[11.5px]">{f.field.split('.').pop()?.replace(/:.*/, '')}: {filterText(f)}</span>)}<button type="button" className="text-[11.5px] text-hx-accent-text hover:underline" onClick={() => { setFilters([]); setSelection(undefined); }}>Clear</button></span>}
            {!!doc.bookmarks?.length && <select aria-label="Bookmarks" className="rounded border border-hx-border bg-hx-bg px-1 py-0.5 text-[12px]" value="" onChange={(e) => { const bm = doc.bookmarks!.find((b) => b.id === e.target.value); if (bm) applyBookmark(bm); }}><option value="">Bookmarks</option>{doc.bookmarks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>}
            <span className="text-[11px] text-hx-muted" title="When this page last got new data" data-bi-updated>{p.mode === 'static' && doc.snapshot ? `Snapshot ${new Date(doc.snapshot.at).toLocaleString()}` : `Updated ${new Date(refreshedAt).toLocaleTimeString()}`}</span>
            {p.mode !== 'static' && <button type="button" aria-label="Refresh the visuals" className="rounded p-1 text-hx-muted hover:bg-hx-hover hover:text-hx-primary" onClick={() => setVersion((n) => n + 1)}><Icon name="refresh" size={14} /></button>}
            <button type="button" aria-label={tv ? 'Leave TV mode' : 'TV mode (full screen, pages in turn)'} aria-pressed={tv} className="rounded p-1 text-hx-muted hover:bg-hx-hover hover:text-hx-primary" onClick={() => (tv ? void document.exitFullscreen?.().catch(() => {}) : setTv(true))}><Icon name={tv ? 'collapse' : 'monitor'} size={14} /></button>
            {p.toolbar}
          </div>
        </div>
      )}
      <div className={cx('min-h-0 flex-1 overflow-auto', p.print ? '' : 'p-2')} data-bi-canvas>
        {doc.type === 'report' && <div className="mx-auto mb-2 max-w-[1100px] px-2"><h1 className="text-[22px] font-semibold">{doc.title}</h1>{doc.description && <p className="text-hx-secondary">{doc.description}</p>}{doc.snapshot && <p className="text-[12px] text-hx-muted">Numbers as of {new Date(doc.snapshot.at).toLocaleString()}</p>}</div>}
        <Grid edit={p.edit} flow={mobile || doc.type === 'report'} mobile={mobile} width={width} visuals={ordered} render={(v) => (
          <VisualFrame key={v.id} v={v} doc={doc} state={state} client={p.client} version={version} dark={p.dark} theme={theme} edit={p.edit} focus={focus === v.id} onFocus={() => setFocus(focus === v.id ? undefined : v.id)}
            selection={selection?.visual === v.id ? selection.filters : undefined}
            slicerValue={v.type === 'slicer' ? filters.find((f) => f.field === v.options?.slicer?.field) : undefined}
            onLoading={(on) => setLoading((l) => (l[v.id] === on ? l : { ...l, [v.id]: on }))}
            events={{
              onSelect: (f) => setSelection(f ? { visual: v.id, filters: f } : undefined),
              onSlicer: setSlicer,
              onButton: button,
              onDecomp: (path) => setDecomp((d) => ({ ...d, [v.id]: path })),
              onDrill: (val) => { const h = hierarchyOf(v); if (!h) return; setDrill((d) => { const cur = d[v.id] ?? { level: 0, path: [] }; if (cur.level >= h.levels.length - 1) return d; return { ...d, [v.id]: { level: cur.level + 1, path: [...cur.path.slice(0, cur.level), val] } }; }); setSelection(undefined); },
              onContext: (fs, at) => setMenu({ v, filters: fs, ...at }),
              onHover: (fs, at) => { if (!v.tooltip) return; setTip(fs && at ? { v, filters: fs, ...at } : undefined); },
            }}
            drill={drill[v.id]} hierarchy={hierarchyOf(v)} onDrillUp={() => setDrill((d) => { const cur = d[v.id]; if (!cur || cur.level === 0) return d; return { ...d, [v.id]: { level: cur.level - 1, path: cur.path.slice(0, cur.level - 1) } }; })}
            decompPath={decomp[v.id]} renderMarkdown={p.renderMarkdown} renderFence={p.renderFence} static={!!p.print || p.mode === 'static'} actions={p.visualActions} />
        )} />
        {!visuals.length && <div className="p-8 text-center text-[13px] text-hx-muted" data-bi-empty-page>{p.edit ? 'Add a visual, or ask the agent to build this page.' : 'This page is empty.'}</div>}
      </div>
      {menu && (
        <div className="fixed inset-0 z-50" onClick={() => setMenu(undefined)} onContextMenu={(e) => { e.preventDefault(); setMenu(undefined); }}>
          <div role="menu" className="absolute min-w-[200px] rounded-lg border border-hx-border bg-hx-elevated p-1 text-[12.5px] shadow-[var(--hx-shadow)]" style={{ left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - 160) }} data-bi-menu>
            <div className="px-2 py-1 text-[11px] text-hx-muted">{menu.filters.map(filterText).join(' · ')}</div>
            {drillTargets(menu.filters).map((t) => <button key={t.id} role="menuitem" type="button" className="block w-full rounded px-2 py-1 text-left hover:bg-hx-hover" onClick={() => { goDrillthrough(t, menu.filters); setMenu(undefined); }}>Drill through: {t.name}</button>)}
            {hierarchyOf(menu.v) && <button role="menuitem" type="button" className="block w-full rounded px-2 py-1 text-left hover:bg-hx-hover" onClick={() => { const f = menu.filters[0]!; setDrill((d) => { const cur = d[menu.v.id] ?? { level: 0, path: [] }; const h = hierarchyOf(menu.v)!; return cur.level >= h.levels.length - 1 ? d : { ...d, [menu.v.id]: { level: cur.level + 1, path: [...cur.path.slice(0, cur.level), f.value ?? null] } }; }); setMenu(undefined); }}>Drill down</button>}
            {p.client.records && <button role="menuitem" type="button" className="block w-full rounded px-2 py-1 text-left hover:bg-hx-hover" onClick={() => { const m = menu; setMenu(undefined); setRecords({ title: m.filters.map(filterText).join(' · ') }); void p.client.records!(m.v, m.filters, state).then((r) => setRecords({ title: m.filters.map(filterText).join(' · '), result: r }), (e: Error) => setRecords({ title: '', error: e.message })); }}>See records</button>}
            <button role="menuitem" type="button" className="block w-full rounded px-2 py-1 text-left hover:bg-hx-hover" onClick={() => { setSelection({ visual: menu.v.id, filters: menu.filters }); setMenu(undefined); }}>Filter the page by this</button>
          </div>
        </div>
      )}
      {records && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--hx-scrim)] p-6" onClick={() => setRecords(undefined)} role="dialog" aria-modal="true" aria-label="Records">
          <div className="flex max-h-full w-full max-w-4xl flex-col rounded-xl border border-hx-border bg-hx-elevated shadow-[var(--hx-shadow)]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 border-b border-hx-border-subtle px-3 py-2"><b className="flex-1 truncate text-[13px]">Records: {records.title}</b>{records.result && <button type="button" className="text-[12px] text-hx-accent-text hover:underline" onClick={() => downloadCsv('records.csv', records.result!)}>CSV</button>}<button type="button" aria-label="Close" onClick={() => setRecords(undefined)}><Icon name="x" size={14} /></button></div>
            <div className="min-h-0 flex-1 overflow-auto p-2" data-bi-records>{records.error ? <p className="text-hx-danger">{records.error}</p> : records.result ? <BiVisual v={{ id: 'records', type: 'table', layout: { x: 0, y: 0, w: 12, h: 8 } }} result={records.result} theme={theme} dark={p.dark} /> : 'Loading…'}</div>
          </div>
        </div>
      )}
      {tip && <TooltipPage tip={tip} doc={doc} client={p.client} state={state} dark={p.dark} />}
    </div>
  );
}

function filterText(f: FilterSpec): string {
  const g = f.field.includes(':') ? f.field.split(':').pop() as 'month' : undefined;
  if (f.op === 'in') return (f.values ?? []).map((x) => formatValue(x, undefined, g)).join(', ');
  if (f.op === 'between') return `${formatValue(f.value ?? null, undefined, g)} to ${formatValue(f.to ?? null, undefined, g)}`;
  if (f.op === 'relative') return `last ${f.n} ${f.unit}${f.n === 1 ? '' : 's'}`;
  if (f.op === 'is_null') return '(blank)';
  return formatValue(f.value ?? null, undefined, g);
}

function downloadCsv(name: string, r: QueryResult): void {
  const blob = new Blob([toCsvText(r)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** The 12-column grid: absolute placement in rows of 40 px; flowing on a phone and in reports. */
function Grid({ visuals, render, edit, flow, mobile, width }: { visuals: VisualSpec[]; render(v: VisualSpec): React.ReactNode; edit?: DocViewProps['edit']; flow: boolean; mobile: boolean; width: number }) {
  const [drag, setDrag] = useState<{ id: string; layout: VisualSpec['layout'] }>();
  const colW = (width - 16 + GAP) / 12;
  if (flow) {
    return <div className="flex flex-wrap content-start gap-2" data-bi-grid="flow">{visuals.map((v) => <div key={v.id} style={{ width: mobile ? '100%' : `calc(${(v.layout.w / 12) * 100}% - ${GAP}px)`, height: (mobile ? v.mobile?.h ?? v.layout.h : v.layout.h) * ROW }} className="break-inside-avoid">{render(v)}</div>)}</div>;
  }
  const rows = Math.max(4, ...visuals.map((v) => (drag?.id === v.id ? drag.layout : v.layout)).map((l) => l.y + l.h));
  const start = (e: React.PointerEvent, v: VisualSpec, mode: 'move' | 'resize') => {
    if (!edit || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const x0 = e.clientX; const y0 = e.clientY; const l0 = v.layout;
    let cur = l0;
    const mv = (ev: PointerEvent) => {
      const dx = Math.round((ev.clientX - x0) / colW); const dy = Math.round((ev.clientY - y0) / (ROW + GAP));
      cur = mode === 'move' ? { ...l0, x: Math.max(0, Math.min(12 - l0.w, l0.x + dx)), y: Math.max(0, l0.y + dy) } : { ...l0, w: Math.max(1, Math.min(12 - l0.x, l0.w + dx)), h: Math.max(2, l0.h + dy) };
      setDrag({ id: v.id, layout: cur });
    };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); setDrag(undefined); if (JSON.stringify(cur) !== JSON.stringify(l0)) edit.onLayout(v.id, cur); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };
  return (
    <div className="relative" style={{ height: rows * (ROW + GAP) }} data-bi-grid="grid">
      {edit && <div className="pointer-events-none absolute inset-0 opacity-40" style={{ backgroundImage: 'linear-gradient(to right, var(--hx-border-subtle) 1px, transparent 1px)', backgroundSize: `${colW}px 100%` }} />}
      {visuals.map((v) => {
        const l = drag?.id === v.id ? drag.layout : v.layout;
        return (
          <div key={v.id} className={cx('absolute', drag?.id === v.id && 'z-20 opacity-90')} style={{ left: l.x * colW, top: l.y * (ROW + GAP), width: l.w * colW - GAP, height: l.h * (ROW + GAP) - GAP }} data-bi-cell={v.id}
            onPointerDown={edit ? (e) => { if ((e.target as HTMLElement).closest('[data-drag-handle]')) start(e, v, 'move'); } : undefined}>
            {render(v)}
            {edit && <div data-resize-handle aria-label="Resize" className="absolute bottom-0 right-0 z-10 h-3 w-3 cursor-se-resize rounded-br border-b-2 border-r-2 border-hx-accent/60" onPointerDown={(e) => start(e, v, 'resize')} />}
          </div>
        );
      })}
    </div>
  );
}

interface FrameProps {
  v: VisualSpec; doc: DocSpec; state: ViewState; client: BiClient; version: number; dark: boolean; theme: ReturnType<typeof themeOf>;
  edit?: DocViewProps['edit']; focus: boolean; onFocus(): void; selection?: FilterSpec[]; slicerValue?: FilterSpec;
  onLoading(on: boolean): void; events: VisualEvents; drill?: { level: number; path: Scalar[] }; hierarchy?: HierarchySpec; onDrillUp(): void;
  decompPath?: Array<{ dim: string; value: Scalar }>; renderMarkdown?(t: string): React.ReactNode; renderFence?(l: string, s: string): React.ReactNode; static: boolean;
  actions?(v: VisualSpec, r?: QueryResult): React.ReactNode;
}

/** One visual with its header (title, lineage, drill, export) and its data for the current state. */
function VisualFrame(f: FrameProps) {
  const { v } = f;
  const [result, setResult] = useState<QueryResult>();
  const [error, setError] = useState<string>();
  const [lineage, setLineage] = useState(false);
  const chart = useRef<{ getDataURL(o: Record<string, unknown>): string } | null>(null);
  const needsData = !['text', 'image', 'button'].includes(v.type) && !(v.type === 'fence' && v.options?.fence?.source);
  // Only what changes this visual's numbers refetches it.
  const key = JSON.stringify([v.query, v.type, v.options?.hierarchy, v.options?.forecast, v.options?.anomalies, v.options?.target, v.options?.trend, v.options?.dims, v.options?.text, v.options?.slicer, v.options?.play, v.options?.geo, f.state.page, f.state.filters, f.state.selection, f.state.drill?.[v.id], f.state.decomp?.[v.id], f.state.drillthrough, f.version]);
  useEffect(() => {
    if (!needsData) { f.onLoading(false); return; }
    const ctl = new AbortController();
    f.onLoading(true);
    f.client.visual(v, f.state, ctl.signal).then((r) => { if (!ctl.signal.aborted) { setResult(r); setError(undefined); f.onLoading(false); } }, (e: Error) => { if (!ctl.signal.aborted) { setError(e.message); f.onLoading(false); } });
    return () => ctl.abort();
  }, [key]);
  const selected = f.edit?.selected === v.id;
  const statics = result?.lineage.datasets.filter((d) => d.static) ?? [];
  const bare = v.type === 'button' || (v.type === 'text' && !v.title);
  return (
    <section aria-label={v.title ?? v.type} data-visual={v.id} data-visual-type={v.type} className={cx('group flex h-full min-h-0 flex-col overflow-hidden rounded-xl', !bare && 'border bg-hx-elevated', selected ? 'border-hx-accent ring-2 ring-hx-accent/40' : 'border-hx-border-subtle', f.focus && 'fixed inset-6 z-40 shadow-[var(--hx-shadow)]')}
      style={{ containerType: 'inline-size' }} onClick={f.edit ? (e) => { e.stopPropagation(); f.edit!.onSelect(v.id); } : undefined}>
      {!bare && (
        <header className={cx('flex min-h-[28px] items-center gap-1 px-2 pt-1', f.edit && 'cursor-move')} data-drag-handle={f.edit ? '' : undefined}>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px] font-medium text-hx-secondary">{v.title ?? (v.type === 'slicer' ? v.options?.slicer?.field.split('.').pop() : '')}</div>
            {v.subtitle && <div className="truncate text-[11px] text-hx-muted">{v.subtitle}</div>}
          </div>
          {statics.some((d) => d.origin === 'model') && <span title="These numbers were typed by a model in a conversation, not read from a source. Bind a real source to trust them." className="rounded bg-hx-warning/15 px-1.5 text-[10.5px] font-medium text-hx-warning" data-static-badge>Typed by a model</span>}
          {result?.lineage.datasets.some((d) => d.certified) && <span title="Certified dataset" className="text-hx-success"><Icon name="shield-check" size={13} /></span>}
          {f.hierarchy && <span className="flex items-center gap-0.5 text-[11px] text-hx-muted" data-drill-level={f.drill?.level ?? 0}>
            <button type="button" aria-label="Drill up" disabled={!f.drill?.level} className="rounded p-0.5 hover:bg-hx-hover disabled:opacity-30" onClick={(e) => { e.stopPropagation(); f.onDrillUp(); }}><Icon name="arrow-up" size={13} /></button>
            {f.hierarchy.levels[f.drill?.level ?? 0]?.split(':').pop()}
          </span>}
          <div className={cx('flex items-center gap-0.5', !f.focus && 'opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100')}>
            {result && <button type="button" aria-label="Where these numbers come from" aria-expanded={lineage} className="rounded p-0.5 text-hx-muted hover:bg-hx-hover hover:text-hx-primary" onClick={(e) => { e.stopPropagation(); setLineage((x) => !x); }} data-lineage-button><Icon name="info" size={13} /></button>}
            {result && <button type="button" aria-label="Download CSV" className="rounded p-0.5 text-hx-muted hover:bg-hx-hover hover:text-hx-primary" onClick={(e) => { e.stopPropagation(); downloadCsv(`${(v.title ?? v.id).replace(/[^\w -]+/g, '')}.csv`, result); }}><Icon name="download" size={13} /></button>}
            {chart.current && <button type="button" aria-label="Download PNG" className="rounded p-0.5 text-hx-muted hover:bg-hx-hover hover:text-hx-primary" onClick={(e) => { e.stopPropagation(); const a = document.createElement('a'); a.href = chart.current!.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: f.dark ? '#1d1c1a' : '#ffffff' }); a.download = `${v.title ?? v.id}.png`; a.click(); }}><Icon name="image" size={13} /></button>}
            <button type="button" aria-label={f.focus ? 'Back to the page' : 'Focus'} className="rounded p-0.5 text-hx-muted hover:bg-hx-hover hover:text-hx-primary" onClick={(e) => { e.stopPropagation(); f.onFocus(); }}><Icon name={f.focus ? 'collapse' : 'expand'} size={13} /></button>
            {f.actions?.(v, result)}
          </div>
        </header>
      )}
      {lineage && result && <Lineage r={result} />}
      <div className="min-h-0 flex-1" onClick={(e) => { if (!f.edit) e.stopPropagation(); }}>
        <BiVisual v={v} result={result} error={error} theme={f.theme} dark={f.dark} selection={f.selection} slicerValue={f.slicerValue} decompPath={f.decompPath}
          renderMarkdown={f.renderMarkdown} renderFence={f.renderFence} geo={f.client.geo} static={f.static} chartRef={(c) => { chart.current = c; }} {...f.events} />
      </div>
      {result?.method && !['decomp', 'drivers'].includes(v.type) && <div className="px-2 pb-1 text-[10.5px] text-hx-muted" data-method>{result.method}</div>}
    </section>
  );
}

function Lineage({ r }: { r: QueryResult }) {
  return (
    <div className="mx-2 mb-1 max-h-48 overflow-auto rounded-lg border border-hx-border-subtle bg-hx-bg p-2 text-[11.5px]" data-lineage>
      {r.lineage.datasets.map((d) => (
        <div key={d.name} className="mb-0.5">
          <b>{d.name}</b>{d.source ? ` from ${d.source}${d.sourceType ? ` (${d.sourceType})` : ''}` : ''}{d.static ? (d.origin === 'model' ? ' · static, typed by a model' : ' · static') : ''}
          {d.refreshedAt ? ` · refreshed ${new Date(d.refreshedAt).toLocaleString()}` : ''}{d.rows !== undefined ? ` · ${d.rows.toLocaleString()} rows` : ''}{d.certified ? ' · certified' : ''}
          {d.provenance?.length ? <div className="text-hx-muted">from {d.provenance.join(', ')}</div> : null}
        </div>
      ))}
      <div className="text-hx-muted">{r.rowCount} result rows · computed {new Date(r.at).toLocaleTimeString()} in {r.ms} ms · hash {r.hash.slice(0, 12)}{r.lineage.role ? ` · as role ${r.lineage.role}` : ''}</div>
      {r.lineage.params && <div className="text-hx-muted">parameters {JSON.stringify(r.lineage.params)}</div>}
      {r.lineage.sql && <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-hx-code p-1 font-mono text-[10.5px]" data-lineage-sql>{r.lineage.sql}</pre>}
      {(r.extra?.warnings as string[] | undefined)?.map((w, i) => <div key={i} className="text-hx-warning">{w}</div>)}
    </div>
  );
}

/** A tooltip page: its visuals, filtered to the hovered point, in a small card by the pointer. */
function TooltipPage({ tip, doc, client, state, dark }: { tip: { v: VisualSpec; filters: FilterSpec[]; x: number; y: number }; doc: DocSpec; client: BiClient; state: ViewState; dark: boolean }) {
  const page = doc.pages.find((x) => x.id === tip.v.tooltip);
  const [results, setResults] = useState<Record<string, QueryResult>>({});
  useEffect(() => {
    if (!page) return;
    const ctl = new AbortController();
    const t = setTimeout(() => { for (const v of page.visuals) void client.visual(v, { ...state, page: page.id, filters: [...(state.filters ?? []), ...tip.filters], selection: undefined }, ctl.signal).then((r) => setResults((x) => ({ ...x, [v.id]: r })), () => {}); }, 120);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [JSON.stringify(tip.filters)]);
  if (!page) return null;
  const theme = themeOf(doc.theme);
  return (
    <div className="pointer-events-none fixed z-50 w-[300px] rounded-lg border border-hx-border bg-hx-elevated p-2 shadow-[var(--hx-shadow)]" style={{ left: Math.min(tip.x + 14, window.innerWidth - 310), top: Math.min(tip.y + 14, window.innerHeight - 260) }} data-bi-tooltip-page>
      <div className="mb-1 text-[11px] text-hx-muted">{tip.filters.map(filterText).join(' · ')}</div>
      {page.visuals.slice(0, 3).map((v) => <div key={v.id} style={{ height: Math.min(160, v.layout.h * 24) }}><BiVisual v={v} result={results[v.id]} theme={theme} dark={dark} static /></div>)}
    </div>
  );
}
