/**
 * Page layouts: grid (responsive N columns, wide / medium / phone, auto-pack), free-form canvas
 * (pixels, layers, alignment guides, snap, groups, locks), sections (collapsible bands), tabs,
 * sidebar (a resizable column of filters), masonry (cards by height), story (one column), TV
 * (a fixed 16:9 or 21:9 screen scaled to fit, large type) and print (paper pages with headers,
 * footers and page breaks). Drag and resize report positions; the host turns them into ops.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { type DocSpec, GAP as LGAP, type LayoutSpec, mediumLayout, pack, type PageSpec, ROW as LROW, type VisualSpec } from '@harness/plugin-ui';
import { cx } from '../../components/primitives.tsx';
import { Icon } from '../../icons.tsx';

export interface LayoutEdit {
  selected?: string | null;
  onSelect(id: string | null): void;
  onMove(id: string, p: { x: number; y: number; dx?: number; dy?: number; breakpoint?: 'medium' }): void;
  onResize(id: string, s: { w: number; h: number; breakpoint?: 'medium' }): void;
  onLayoutOptions?(patch: Partial<LayoutSpec>): void;
  onSection?(section: string, patch: { collapsed?: boolean; title?: string }): void;
}

export interface LayoutProps {
  page: PageSpec;
  doc: DocSpec;
  visuals: VisualSpec[];
  render(v: VisualSpec): React.ReactNode;
  width: number;
  edit?: LayoutEdit;
  tab?: string;
  onTab?(id: string): void;
  collapsed: Record<string, boolean>;
  onCollapse(id: string): void;
  print?: boolean;
  /** Print layouts: the number of paper pages before this page and in the whole document. */
  paper?: { before: number; total: number };
}

const PAPER: Record<string, [number, number]> = { A4: [297, 210], Letter: [279.4, 215.9] };
const MM = 96 / 25.4;

/** The page size of a print layout, in CSS pixels (for the renderer and for @page). */
export function paperSize(l: LayoutSpec): { w: number; h: number; css: string } {
  const [a, b] = PAPER[l.paper ?? 'A4']!;
  const land = (l.orientation ?? 'landscape') === 'landscape';
  const [wmm, hmm] = land ? [a, b] : [b, a];
  // A pixel under the paper's size, so a page never spills onto the next.
  return { w: Math.floor(wmm * MM) - 1, h: Math.floor(hmm * MM) - 1, css: `${l.paper ?? 'A4'} ${land ? 'landscape' : 'portrait'}` };
}

export function PageLayout(p: LayoutProps): React.ReactElement {
  const l: LayoutSpec = p.page.layout ?? { type: 'grid' };
  switch (l.type) {
    case 'canvas': return <Canvas {...p} l={l} />;
    case 'sections': return <Sections {...p} l={l} />;
    case 'tabs': return <Tabbed {...p} l={l} />;
    case 'sidebar': return <Sidebar {...p} l={l} />;
    case 'masonry': return <Masonry {...p} l={l} />;
    case 'story': return <Story {...p} l={l} />;
    case 'tv': return <Tv {...p} l={l} />;
    case 'print': return <Print {...p} l={l} />;
    default: return <ResponsiveGrid {...p} l={l} />;
  }
}

const order = (vs: VisualSpec[]) => [...vs].sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x);

/** Phone: one column, the phone order, the phone heights. */
function Phone({ visuals, render, rowHeight = LROW }: { visuals: VisualSpec[]; render: LayoutProps['render']; rowHeight?: number }) {
  const vs = visuals.filter((v) => !v.mobile?.hidden).sort((a, b) => (a.mobile?.order ?? 999) - (b.mobile?.order ?? 999) || a.layout.y - b.layout.y || a.layout.x - b.layout.x);
  return <div className="flex flex-col gap-2" data-bi-grid="phone">{vs.map((v) => <div key={v.id} style={{ height: (v.mobile?.h ?? v.layout.h) * rowHeight }}>{render(v)}</div>)}</div>;
}

/** The grid: wide (the layout), medium (an arrangement of its own), phone (one column); fixed width when not responsive. */
function ResponsiveGrid(p: LayoutProps & { l: LayoutSpec }) {
  const { l } = p;
  const responsive = l.responsive !== false;
  const bp = !responsive ? 'wide' : p.width < 640 ? 'phone' : p.width < 1000 ? 'medium' : 'wide';
  if (bp === 'phone' && !p.edit) return <Phone visuals={p.visuals} render={p.render} rowHeight={l.rowHeight} />;
  let vs = p.visuals;
  if (l.compact === 'up' || l.compact === 'left') vs = pack(vs, l.compact, l.columns ?? 12);
  if (bp === 'medium' && !p.edit) { const m = mediumLayout(vs, l.columns ?? 12); vs = vs.map((v) => ({ ...v, layout: { ...v.layout, ...m.get(v.id)! } })); }
  const width = responsive ? p.width : l.width ?? 1200;
  return <div style={responsive ? undefined : { width }} data-bi-breakpoint={bp}><Grid visuals={vs} render={p.render} width={width} edit={p.edit} columns={l.columns ?? 12} rowHeight={l.rowHeight ?? LROW} breakpoint={bp === 'medium' ? 'medium' : undefined} /></div>;
}

/** A snapping grid with drag (by the header) and resize (the corner). */
export function Grid({ visuals, render, edit, width, columns = 12, rowHeight = LROW, breakpoint }: { visuals: VisualSpec[]; render: LayoutProps['render']; edit?: LayoutEdit; width: number; columns?: number; rowHeight?: number; breakpoint?: 'medium' }) {
  const [drag, setDrag] = useState<{ id: string; layout: VisualSpec['layout'] }>();
  const colW = (width - 16 + LGAP) / columns;
  const rows = Math.max(4, ...visuals.map((v) => (drag?.id === v.id ? drag.layout : v.layout)).map((l) => l.y + l.h));
  const start = (e: React.PointerEvent, v: VisualSpec, mode: 'move' | 'resize') => {
    if (!edit || e.button !== 0 || v.locked) return;
    e.preventDefault(); e.stopPropagation();
    const x0 = e.clientX; const y0 = e.clientY; const l0 = v.layout;
    let cur = l0;
    const mv = (ev: PointerEvent) => {
      const dx = Math.round((ev.clientX - x0) / colW); const dy = Math.round((ev.clientY - y0) / (rowHeight + LGAP));
      cur = mode === 'move' ? { ...l0, x: Math.max(0, Math.min(columns - l0.w, l0.x + dx)), y: Math.max(0, l0.y + dy) } : { ...l0, w: Math.max(1, Math.min(columns - l0.x, l0.w + dx)), h: Math.max(2, l0.h + dy) };
      setDrag({ id: v.id, layout: cur });
    };
    const up = () => {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); setDrag(undefined);
      if (mode === 'move' && (cur.x !== l0.x || cur.y !== l0.y)) edit.onMove(v.id, { x: cur.x, y: cur.y, ...(breakpoint ? { breakpoint } : {}) });
      if (mode === 'resize' && (cur.w !== l0.w || cur.h !== l0.h)) edit.onResize(v.id, { w: cur.w, h: cur.h, ...(breakpoint ? { breakpoint } : {}) });
    };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };
  return (
    <div className="relative" style={{ height: rows * (rowHeight + LGAP) }} data-bi-grid="grid">
      {edit && <div className="pointer-events-none absolute inset-0 opacity-40" style={{ backgroundImage: 'linear-gradient(to right, var(--hx-border-subtle) 1px, transparent 1px)', backgroundSize: `${colW}px 100%` }} />}
      {visuals.map((v) => {
        const l = drag?.id === v.id ? drag.layout : v.layout;
        return (
          <div key={v.id} className={cx('absolute', drag?.id === v.id && 'z-20 opacity-90')} style={{ left: l.x * colW, top: l.y * (rowHeight + LGAP), width: l.w * colW - LGAP, height: l.h * (rowHeight + LGAP) - LGAP }} data-bi-cell={v.id}
            onPointerDown={edit ? (e) => { if ((e.target as HTMLElement).closest('[data-drag-handle]')) start(e, v, 'move'); } : undefined}>
            {render(v)}
            {edit && !v.locked && <div data-resize-handle aria-label="Resize" className="absolute bottom-0 right-0 z-10 h-3 w-3 cursor-se-resize rounded-br border-b-2 border-r-2 border-hx-accent/60" onPointerDown={(e) => start(e, v, 'resize')} />}
          </div>
        );
      })}
    </div>
  );
}

/** Free-form canvas: pixel positions, layers (z), snap, alignment guides with the others' edges, groups and locks. */
function Canvas(p: LayoutProps & { l: LayoutSpec }) {
  const { l, edit } = p;
  const base = l.width ?? 1200;
  const scale = l.responsive === false ? 1 : Math.min(1, (p.width - 8) / base);
  const snap = l.snap ?? 8;
  const [drag, setDrag] = useState<{ id: string; layout: VisualSpec['layout']; guides: { x: number[]; y: number[] } }>();
  const height = Math.max(400, ...p.visuals.map((v) => v.layout.y + v.layout.h + 16));
  const start = (e: React.PointerEvent, v: VisualSpec, mode: 'move' | 'resize') => {
    if (!edit || e.button !== 0 || v.locked) return;
    e.preventDefault(); e.stopPropagation();
    const x0 = e.clientX; const y0 = e.clientY; const l0 = v.layout;
    const others = p.visuals.filter((o) => o.id !== v.id);
    const xs = others.flatMap((o) => [o.layout.x, o.layout.x + o.layout.w, o.layout.x + o.layout.w / 2]);
    const ys = others.flatMap((o) => [o.layout.y, o.layout.y + o.layout.h, o.layout.y + o.layout.h / 2]);
    let cur = l0;
    const near = (val: number, list: number[]) => list.find((t) => Math.abs(t - val) <= 4);
    const mv = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / scale; const dy = (ev.clientY - y0) / scale;
      const s = (n: number) => Math.round(n / snap) * snap;
      cur = mode === 'move' ? { ...l0, x: Math.max(0, s(l0.x + dx)), y: Math.max(0, s(l0.y + dy)) } : { ...l0, w: Math.max(40, s(l0.w + dx)), h: Math.max(40, s(l0.h + dy)) };
      // Alignment guides: an edge or centre within 4 px of another's snaps to it and shows a line.
      const gx: number[] = []; const gy: number[] = [];
      for (const [val, set] of [[cur.x, 'l'], [cur.x + cur.w, 'r'], [cur.x + cur.w / 2, 'c']] as const) { const t = near(val, xs); if (t !== undefined) { gx.push(t); if (mode === 'move') cur = { ...cur, x: Math.round(set === 'l' ? t : set === 'r' ? t - cur.w : t - cur.w / 2) }; } }
      for (const [val, set] of [[cur.y, 't'], [cur.y + cur.h, 'b'], [cur.y + cur.h / 2, 'c']] as const) { const t = near(val, ys); if (t !== undefined) { gy.push(t); if (mode === 'move') cur = { ...cur, y: Math.round(set === 't' ? t : set === 'b' ? t - cur.h : t - cur.h / 2) }; } }
      setDrag({ id: v.id, layout: cur, guides: { x: gx, y: gy } });
    };
    const up = () => {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); setDrag(undefined);
      if (mode === 'move' && (cur.x !== l0.x || cur.y !== l0.y)) edit.onMove(v.id, { x: cur.x, y: cur.y, dx: cur.x - l0.x, dy: cur.y - l0.y });
      if (mode === 'resize' && (cur.w !== l0.w || cur.h !== l0.h)) edit.onResize(v.id, { w: cur.w, h: cur.h });
    };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };
  return (
    <div style={{ height: height * scale }} data-bi-grid="canvas">
      <div className="relative origin-top-left" style={{ width: base, height, transform: `scale(${scale})` }}>
        {edit && <div className="pointer-events-none absolute inset-0 opacity-30" style={{ backgroundImage: 'radial-gradient(var(--hx-border) 1px, transparent 1px)', backgroundSize: `${snap * 4}px ${snap * 4}px` }} />}
        {[...p.visuals].sort((a, b) => (a.layout.z ?? 0) - (b.layout.z ?? 0)).map((v) => {
          const lay = drag?.id === v.id ? drag.layout : v.layout;
          return (
            <div key={v.id} className="absolute" style={{ left: lay.x, top: lay.y, width: lay.w, height: lay.h, zIndex: (lay.z ?? 0) + 1 }} data-bi-cell={v.id} data-locked={v.locked ? '1' : undefined} data-group={v.group}
              onPointerDown={edit ? (e) => { if ((e.target as HTMLElement).closest('[data-drag-handle]')) start(e, v, 'move'); } : undefined}>
              {p.render(v)}
              {edit && v.locked && <span className="absolute right-1 top-1 text-hx-muted" title="Locked"><Icon name="lock" size={12} /></span>}
              {edit && !v.locked && <div data-resize-handle aria-label="Resize" className="absolute bottom-0 right-0 z-10 h-3 w-3 cursor-se-resize rounded-br border-b-2 border-r-2 border-hx-accent/60" onPointerDown={(e) => start(e, v, 'resize')} />}
            </div>
          );
        })}
        {drag?.guides.x.map((x, i) => <div key={`gx${i}`} data-guide className="pointer-events-none absolute inset-y-0 w-px bg-hx-accent" style={{ left: x }} />)}
        {drag?.guides.y.map((y, i) => <div key={`gy${i}`} data-guide className="pointer-events-none absolute inset-x-0 h-px bg-hx-accent" style={{ top: y }} />)}
      </div>
    </div>
  );
}

const inSection = (v: VisualSpec, s: { id: string }, first: string) => (v.section ?? first) === s.id;

/** Bands with a header, each a grid of its own; collapsible. */
function Sections(p: LayoutProps & { l: LayoutSpec }) {
  const sections = p.l.sections?.length ? p.l.sections : [{ id: 's-1', title: 'Section' }];
  return (
    <div className="space-y-3" data-bi-grid="sections">
      {sections.map((s) => {
        const vs = p.visuals.filter((v) => inSection(v, s, sections[0]!.id));
        const closed = p.collapsed[s.id] ?? !!s.collapsed;
        return (
          <section key={s.id} data-bi-section={s.id} aria-label={s.title}>
            <button type="button" aria-expanded={!closed} className="mb-1 flex w-full items-center gap-1.5 border-b border-hx-border-subtle pb-1 text-left text-[14px] font-semibold" onClick={() => p.onCollapse(s.id)}>
              <Icon name={closed ? 'chevron-right' : 'chevron-down'} size={14} />{s.title}<span className="text-[11.5px] font-normal text-hx-muted">{vs.length}</span>
            </button>
            {!closed && (p.width < 640 && !p.edit ? <Phone visuals={vs} render={p.render} /> : <Grid visuals={vs} render={p.render} edit={p.edit} width={p.width} columns={p.l.columns} rowHeight={p.l.rowHeight} />)}
          </section>
        );
      })}
    </div>
  );
}

/** Tabbed panels: one tab's grid at a time. */
function Tabbed(p: LayoutProps & { l: LayoutSpec }) {
  const tabs = p.l.sections?.length ? p.l.sections : [{ id: 's-1', title: 'Tab' }];
  const cur = tabs.find((t) => t.id === p.tab) ?? tabs[0]!;
  const vs = p.visuals.filter((v) => inSection(v, cur, tabs[0]!.id));
  return (
    <div data-bi-grid="tabs">
      <div role="tablist" aria-label="Panels" className="mb-2 flex gap-1 border-b border-hx-border-subtle">
        {tabs.map((t) => <button key={t.id} type="button" role="tab" aria-selected={t.id === cur.id} data-bi-panel-tab={t.id} onClick={() => p.onTab?.(t.id)} className={cx('-mb-px border-b-2 px-3 py-1.5 text-[13px]', t.id === cur.id ? 'border-hx-accent font-medium text-hx-primary' : 'border-transparent text-hx-secondary hover:text-hx-primary')}>{t.title}</button>)}
      </div>
      {p.width < 640 && !p.edit ? <Phone visuals={vs} render={p.render} /> : <Grid visuals={vs} render={p.render} edit={p.edit} width={p.width} columns={p.l.columns} rowHeight={p.l.rowHeight} />}
    </div>
  );
}

/** A fixed column (filters) beside the content; the divider resizes it. */
function Sidebar(p: LayoutProps & { l: LayoutSpec }) {
  const side = p.l.sidebar?.side ?? 'left';
  const [w, setW] = useState(p.l.sidebar?.width ?? 260);
  useEffect(() => setW(p.l.sidebar?.width ?? 260), [p.l.sidebar?.width]);
  const bar = p.visuals.filter((v) => v.section === 'sidebar');
  const main = p.visuals.filter((v) => v.section !== 'sidebar');
  const phone = p.width < 640 && !p.edit;
  const drag = (e: React.PointerEvent) => {
    if (!p.edit) return;
    e.preventDefault();
    const x0 = e.clientX; const w0 = w; let cur = w0;
    const mv = (ev: PointerEvent) => { cur = Math.max(160, Math.min(480, w0 + (side === 'left' ? 1 : -1) * (ev.clientX - x0))); setW(cur); };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); if (cur !== w0) p.edit?.onLayoutOptions?.({ sidebar: { ...p.l.sidebar, width: Math.round(cur) } }); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };
  const column = <aside className="flex shrink-0 flex-col gap-2" style={{ width: phone ? '100%' : w }} data-bi-sidebar>{order(bar).map((v) => <div key={v.id} style={{ height: v.layout.h * LROW }}>{p.render(v)}</div>)}</aside>;
  if (phone) return <div className="flex flex-col gap-2" data-bi-grid="sidebar">{column}<Phone visuals={main} render={p.render} /></div>;
  return (
    <div className={cx('flex items-start gap-1', side === 'right' && 'flex-row-reverse')} data-bi-grid="sidebar">
      {column}
      <div role="separator" aria-orientation="vertical" aria-label="Resize the sidebar" onPointerDown={drag} className={cx('w-1.5 self-stretch rounded', p.edit ? 'cursor-col-resize bg-hx-border-subtle hover:bg-hx-accent/40' : '')} data-sidebar-divider />
      <div className="min-w-0 flex-1"><Grid visuals={main} render={p.render} edit={p.edit} width={p.width - w - 8} columns={p.l.columns} rowHeight={p.l.rowHeight} /></div>
    </div>
  );
}

/** Cards flowing in columns by their height (a KPI wall). */
function Masonry(p: LayoutProps & { l: LayoutSpec }) {
  return (
    <div style={{ columnWidth: p.l.cardWidth ?? 320, columnGap: LGAP }} data-bi-grid="masonry">
      {order(p.visuals).map((v) => <div key={v.id} className="mb-2 break-inside-avoid" style={{ height: v.layout.h * LROW }} data-bi-cell={v.id}>{p.render(v)}</div>)}
    </div>
  );
}

/** A narrative top to bottom: one column, full-width visuals, KPIs in strips. */
function Story(p: LayoutProps & { l: LayoutSpec }) {
  return (
    <div className="mx-auto flex max-w-[960px] flex-wrap gap-2" data-bi-grid="story">
      {order(p.visuals).map((v) => <div key={v.id} style={{ width: p.width < 640 ? '100%' : `calc(${(Math.min(12, v.layout.w) / 12) * 100}% - ${LGAP}px)`, height: v.layout.h * LROW }} data-bi-cell={v.id}>{p.render(v)}</div>)}
    </div>
  );
}

/**
 * A TV page taller than one screen becomes several screens, cut where no widget spans the cut,
 * each shown in turn (the page's rotation time shared between them), so nothing is squashed.
 */
export function tvScreens(visuals: VisualSpec[], maxRows: number): VisualSpec[][] {
  const out: VisualSpec[][] = [];
  let cur: VisualSpec[] = []; let start = 0; let bottom = 0;
  for (const v of order(visuals)) {
    if (cur.length && v.layout.y >= bottom && v.layout.y + v.layout.h - start > maxRows) { out.push(cur); cur = []; start = v.layout.y; }
    cur.push({ ...v, layout: { ...v.layout, y: v.layout.y - start } });
    bottom = Math.max(bottom, v.layout.y + v.layout.h);
  }
  if (cur.length || !out.length) out.push(cur);
  return out;
}

/** A TV wall: a fixed screen (16:9 or 21:9) scaled to fit, larger type; the grid fills it. */
function Tv(p: LayoutProps & { l: LayoutSpec }) {
  const ratio = p.l.aspect === '21:9' ? 21 / 9 : 16 / 9;
  const host = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: p.width, h: p.width / ratio });
  useEffect(() => { const el = host.current?.closest('[data-bi-canvas]') as HTMLElement | null; if (!el) return; const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight })); ro.observe(el); return () => ro.disconnect(); }, []);
  const W = 1200; const H = Math.round(W / ratio);
  const scale = Math.max(0.2, Math.min(box.w / W, (box.h || box.w / ratio) / H));
  // Editing shows the whole page on one screen; viewing splits a long page into screens.
  const screens = useMemo(() => (p.edit ? [p.visuals] : tvScreens(p.visuals, Math.floor(H / (LROW + LGAP)))), [p.visuals, p.edit, H]);
  const [n, setN] = useState(0);
  const i = n % screens.length;
  useEffect(() => {
    if (screens.length < 2 || p.print) return;
    const t = setInterval(() => setN((x) => x + 1), Math.max(5, (p.l.rotate || 30) / screens.length) * 1000);
    return () => clearInterval(t);
  }, [screens.length, p.l.rotate, p.print]);
  const shown = screens[i]!;
  const rows = Math.max(1, ...shown.map((v) => v.layout.y + v.layout.h));
  const rowHeight = Math.floor(H / rows) - LGAP;
  return (
    <div ref={host} className="flex h-full w-full items-start justify-center overflow-hidden" data-bi-grid="tv" data-aspect={p.l.aspect ?? '16:9'} data-tv-screens={screens.length} data-tv-screen={i}>
      <div style={{ width: W * scale, height: H * scale }}>
        <div className="origin-top-left" style={{ width: W, height: H, transform: `scale(${scale})`, fontSize: `${(p.l.scale ?? 1.25) * 100}%` }} data-bi-tv-screen>
          <Grid visuals={shown} render={p.render} edit={p.edit} width={W + 16 - LGAP} columns={p.l.columns} rowHeight={Math.max(16, rowHeight)} />
        </div>
      </div>
    </div>
  );
}

/** Paper pages: widgets flow in reading order into pages of the paper's size, each with its header and footer. */
const HEAD_H = 28; const FOOT_H = 24;
const paperBox = (l: LayoutSpec) => { const size = paperSize(l); const m = Math.round((l.margins ?? 12) * MM); return { size, m, contentW: size.w - 2 * m, contentH: size.h - 2 * m - HEAD_H - FOOT_H }; };

/** A print layout's paper pages: rows of widgets (12 columns); a row that does not fit starts a page. */
export function printPages(visuals: VisualSpec[], l: LayoutSpec): VisualSpec[][][] {
  const { contentH } = paperBox(l);
  const out: VisualSpec[][][] = [[]];
  let used = 0; let row: VisualSpec[] = []; let rowW = 0;
  const flush = () => {
    if (!row.length) return;
    const h = Math.max(...row.map((v) => v.layout.h * LROW)) + LGAP;
    if (used + h > contentH && out.at(-1)!.length) { out.push([]); used = 0; }
    out.at(-1)!.push(row); used += h; row = []; rowW = 0;
  };
  for (const v of order(visuals)) { const w = Math.min(12, v.layout.w); if (rowW + w > 12) flush(); row.push(v); rowW += w; }
  flush();
  return out;
}

function Print(p: LayoutProps & { l: LayoutSpec }) {
  const { size, m, contentW, contentH } = paperBox(p.l);
  const headH = HEAD_H; const footH = FOOT_H;
  const pages = useMemo(() => printPages(p.visuals, p.l), [p.visuals, p.l]);
  // Page numbers run through the whole document when it prints every page.
  const before = p.paper?.before ?? 0; const total = p.paper?.total ?? pages.length;
  const fill = (t: string | undefined, n: number) => (t ?? '').replace('{title}', p.doc.title).replace('{date}', new Date().toLocaleDateString()).replace('{page}', String(before + n + 1)).replace('{pages}', String(total));
  const fit = Math.min(1, (p.width - 16) / size.w);
  return (
    <div className="flex flex-col items-center gap-4" data-bi-grid="print" data-pages={pages.length}>
      <style>{`@page { size: ${size.css}; margin: 0 } [data-bi-paper] { break-after: page } [data-bi-print-page]:last-child [data-bi-paper-wrap]:last-child [data-bi-paper] { break-after: auto } @media print { html, body, #root, [data-bi-doc], [data-bi-canvas] { height: auto !important; overflow: visible !important; } [data-bi-grid="print"] { gap: 0 !important; } [data-bi-paper] { box-shadow: none !important; margin: 0 !important; transform: none !important; } [data-bi-paper-wrap] { height: auto !important; } body { background: #fff } }`}</style>
      {pages.map((rows, i) => (
        <div key={i} data-bi-paper-wrap style={{ height: p.print ? undefined : size.h * fit }}>
          <div data-bi-paper={i + 1} className="relative overflow-hidden bg-white text-[#1f1e1c] shadow-[var(--hx-shadow)]" style={{ width: size.w, height: size.h, padding: m, transform: p.print ? undefined : `scale(${fit})`, transformOrigin: 'top left' }}>
            <div className="flex items-center justify-between border-b border-[#ddd] pb-1 text-[11px] text-[#555]" style={{ height: headH }} data-bi-paper-header>{fill(p.doc.header ?? '{title}', i)}<span>{p.page.name}</span></div>
            <div className="flex flex-col" style={{ height: contentH }}>
              {rows.map((r, j) => <div key={j} className="flex gap-2" style={{ marginBottom: LGAP }}>{r.map((v) => <div key={v.id} style={{ width: (Math.min(12, v.layout.w) / 12) * contentW - LGAP, height: v.layout.h * LROW }} data-bi-cell={v.id}>{p.render(v)}</div>)}</div>)}
            </div>
            <div className="absolute inset-x-0 bottom-0 flex items-center justify-between border-t border-[#ddd] text-[10.5px] text-[#555]" style={{ height: footH, marginLeft: m, marginRight: m, marginBottom: m / 2 }} data-bi-paper-footer><span>{fill(p.doc.footer ?? '{date}', i)}</span><span>{before + i + 1} / {total}</span></div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Which widgets show now (a collapsed section's and other tabs' do not load). */
export function visibleIn(page: PageSpec, tab: string | undefined, collapsed: Record<string, boolean>): (v: VisualSpec) => boolean {
  const l = page.layout;
  const first = l?.sections?.[0]?.id ?? '';
  if (l?.type === 'tabs') { const cur = l.sections?.find((s) => s.id === tab)?.id ?? first; return (v) => (v.section ?? first) === cur; }
  if (l?.type === 'sections') return (v) => { const s = l.sections?.find((x) => x.id === (v.section ?? first)); return !(collapsed[v.section ?? first] ?? !!s?.collapsed); };
  return () => true;
}
