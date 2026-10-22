/**
 * The interactive diagram: a dotted canvas to pan and zoom (fit, minimap), Overview and
 * Neighbourhood (a node and N hops), search, collapsible groups, boxes to drag (the host saves
 * the positions: an artifact gets a new version), a details panel for a box or a line, flows played
 * step by step (the path draws with moving dashes, the rest dims, the step label rides the edge),
 * export to SVG and PNG, the keyboard (arrows move the selection, Enter opens it, Escape clears),
 * and a box to ask the agent for a change.
 *
 * Panning and zooming set one transform directly (no React render); the zoom figure and the
 * minimap follow through a small store. Dragging redraws only the moved box and its lines.
 */

import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import {
  flowFrame, neighbourhood, PLAYBACK_SPEEDS, PLAYBACK_START, playback, resolveFlow, STEP_MS, subDiagram, summarizeDiagram, summaryLine, unconnected,
  type DiagramLink, type DiagramSpec,
} from '@harness/plugin-ui';
import { Icon } from '../../icons.tsx';
import { IconButton, Spinner, cx } from '../../components/primitives.tsx';
import { downloadText } from '../download.ts';
import { DiagramDetails, type DiagramSelection } from './Details.tsx';
import { Drawing, PAD, type DrawState, type FlowDraw } from './Drawing.tsx';
import { downloadBlob, exportSvg, fileSlug, svgToPng } from './export.ts';
import { collapsedId, isCollapsedId, moveNodes, positionsOf, simpleRoute, visibleGraph, type Scene } from './layout.ts';
import { reversePoints } from './paths.ts';
import { forgetLayout, useDiagramLayout } from './useLayout.ts';

export type { DiagramSelection };

export interface DiagramCanvasProps {
  spec: DiagramSpec;
  title?: string;
  /** Called after a drag (Overview) with every box's position: the host saves them into the spec. */
  onPositions?: (positions: Record<string, { x: number; y: number }>) => void;
  /** "Ask the agent to change the design": the host sends the request to the conversation. */
  onAsk?: (request: string) => Promise<void> | void;
  /** While a request is out: a note (and a spinner when pending). */
  askState?: { pending: boolean; note?: string } | null;
  /** The nodes (and edges) the last version changed: they get the "changed" badge. */
  changed?: { nodes: string[]; edges: string[]; note?: string } | null;
  onClearChanged?: () => void;
  /** Details inside the canvas (default), or the host's own panel (onDetails tells it what to show). */
  details?: 'internal' | 'external';
  onDetails?: (d: { open: boolean; selection: DiagramSelection | null; spec: DiagramSpec; changed: ReadonlySet<string> }) => void;
  /** Bumped by the host to close (false) or open (true) the details from outside. */
  detailsOpen?: boolean;
  onOpenLink?: (l: DiagramLink) => void;
  /** Remembers the layout across versions (an artifact's id). */
  stableKey?: string;
  initialMode?: 'overview' | 'neighbourhood';
  /** Extra controls in the top-right bar. */
  extra?: React.ReactNode;
  /** Lets the host select (the details panel's links) and fit. */
  apiRef?: React.MutableRefObject<DiagramCanvasApi | null>;
  className?: string;
}

export interface DiagramCanvasApi { select(s: DiagramSelection | null): void; neighbourhood(id: string): void; fit(): void }

type Camera = { x: number; y: number; k: number };
function cameraStore() {
  let cam: Camera = { x: 0, y: 0, k: 1 };
  const subs = new Set<() => void>();
  return { get: () => cam, set(c: Camera) { cam = c; for (const f of subs) f(); }, subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; } };
}

const MIN_K = 0.08; const MAX_K = 2.5; const LOW_LOD = 0.42;

export function DiagramCanvas(props: DiagramCanvasProps): React.ReactElement {
  const { spec, title, onPositions, onAsk, askState, changed, onClearChanged, details = 'internal', onDetails, onOpenLink, stableKey, extra, className } = props;
  const [mode, setMode] = useState<'overview' | 'neighbourhood'>(props.initialMode ?? 'overview');
  const [hops, setHops] = useState(1);
  const [center, setCenter] = useState<string | null>(null);
  const [selection, setSelection] = useState<DiagramSelection | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set((spec.groups ?? []).filter((g) => g.collapsed).map((g) => g.id)));
  const [fresh, setFresh] = useState(0);
  const [moved, setMoved] = useState<Map<string, { x: number; y: number }>>(() => new Map());
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const [flowsOpen, setFlowsOpen] = useState(false);
  const [lonelyOpen, setLonelyOpen] = useState(false);
  const [ask, setAsk] = useState('');
  const [play, dispatch] = useReducer(playback, PLAYBACK_START);

  useEffect(() => { if (props.detailsOpen !== undefined) setDetailsOpen(props.detailsOpen); }, [props.detailsOpen]);
  // A version that no longer has the selection or the centre lets them go.
  useEffect(() => {
    if (selection?.type === 'node' && !spec.nodes.some((n) => n.id === selection.id) && !isCollapsedId(selection.id)) setSelection(null);
    if (selection?.type === 'edge' && !(spec.edges ?? []).some((e) => e.id === selection.id)) setSelection(null);
    if (center && !spec.nodes.some((n) => n.id === center)) { setCenter(null); setMode('overview'); }
  }, [spec]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- what is shown: the whole diagram, or a neighbourhood of it
  const shown = useMemo(() => (mode === 'neighbourhood' && center ? subDiagram(spec, neighbourhood(spec, center, hops)) : spec), [spec, mode, center, hops]);
  const overview = mode === 'overview';
  const { scene: base, busy } = useDiagramLayout(shown, { collapsed, stableKey: overview ? stableKey : undefined, fresh });
  const vg = useMemo(() => visibleGraph(shown, collapsed), [shown, collapsed]);
  useEffect(() => { setMoved(new Map()); }, [base]);
  const scene = useMemo(() => {
    if (!base) return null;
    const all = new Map(moved);
    if (drag) all.set(drag.id, { x: drag.x, y: drag.y });
    return moveNodes(base, vg, all);
  }, [base, vg, moved, drag]);

  // ---- camera
  const wrap = useRef<HTMLDivElement>(null);
  const cameraG = useRef<SVGGElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const store = useMemo(cameraStore, []);
  /** The person moved the camera: a resize keeps it then, instead of fitting again. */
  const touched = useRef(false);
  const apply = useCallback((c: Camera) => {
    store.set(c);
    cameraG.current?.setAttribute('transform', `translate(${c.x} ${c.y}) scale(${c.k})`);
    const w = wrap.current;
    if (w) { const s = 22 * c.k; w.style.backgroundSize = `${s}px ${s}px`; w.style.backgroundPosition = `${c.x}px ${c.y}px`; }
    svg.current?.setAttribute('data-lod', c.k < LOW_LOD ? 'low' : 'high');
  }, [store]);
  const fit = useCallback((ids?: string[]) => {
    const w = wrap.current; const sc = sceneRef.current;
    if (!w || !sc) return;
    const list = ids?.length ? sc.nodes.filter((n) => ids.includes(n.id)) : null;
    const b = list?.length ? list.reduce((r, n) => ({ x0: Math.min(r.x0, n.x), y0: Math.min(r.y0, n.y), x1: Math.max(r.x1, n.x + n.w), y1: Math.max(r.y1, n.y + n.h) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }) : { x0: sc.bounds.x, y0: sc.bounds.y, x1: sc.bounds.x + sc.bounds.w, y1: sc.bounds.y + sc.bounds.h };
    // Room for the bars over the canvas: the tools on top, the zoom, the ask box and the minimap below.
    touched.current = false;
    const W = w.clientWidth; const H = w.clientHeight;
    const top = 60; const bottom = 84; const side = 40;
    const k = Math.max(MIN_K, Math.min(1.15, (W - side * 2) / Math.max(1, b.x1 - b.x0), (H - top - bottom) / Math.max(1, b.y1 - b.y0)));
    apply({ k, x: W / 2 - ((b.x0 + b.x1) / 2) * k, y: top + (H - top - bottom) / 2 - ((b.y0 + b.y1) / 2) * k });
  }, [apply]);
  const zoomBy = useCallback((f: number, at?: { x: number; y: number }) => {
    const w = wrap.current; if (!w) return;
    touched.current = true;
    const c = store.get();
    const k = Math.max(MIN_K, Math.min(MAX_K, c.k * f));
    const px = at?.x ?? w.clientWidth / 2; const py = at?.y ?? w.clientHeight / 2;
    apply({ k, x: px - ((px - c.x) / c.k) * k, y: py - ((py - c.y) / c.k) * k });
  }, [apply, store]);
  const centerOn = useCallback((id: string) => {
    const w = wrap.current; const n = sceneRef.current?.nodes.find((x) => x.id === id);
    if (!w || !n) return;
    const c = store.get();
    const sx = n.x * c.k + c.x; const sy = n.y * c.k + c.y;
    if (sx > 40 && sy > 40 && sx + n.w * c.k < w.clientWidth - 40 && sy + n.h * c.k < w.clientHeight - 60) return;
    touched.current = true;
    apply({ ...c, x: w.clientWidth / 2 - (n.x + n.w / 2) * c.k, y: w.clientHeight / 2 - (n.y + n.h / 2) * c.k });
  }, [apply, store]);
  const sceneRef = useRef<Scene | null>(null);
  sceneRef.current = scene;
  // Fit when a layout first arrives and when the mode changes; a new version keeps the camera.
  const fitted = useRef('');
  useEffect(() => {
    // Not while the layout for the new mode is still coming (the old one is still shown meanwhile).
    if (!base || busy) return;
    const want = `${mode}|${center}|${hops}|${fresh}`;
    if (fitted.current === want) { apply(store.get()); return; }
    fitted.current = want;
    requestAnimationFrame(() => fit());
  }, [base, busy, mode, center, hops, fresh, fit, apply, store]);
  useEffect(() => {
    const w = wrap.current; if (!w) return;
    // Until the person moves the camera, a change of size fits again (the page settling, the details opening).
    const ro = new ResizeObserver(() => { if (touched.current) apply(store.get()); else fit(); });
    ro.observe(w);
    return () => ro.disconnect();
  }, [apply, store, fit]);

  // ---- pointer: pan the background, drag a box, click to select, wheel to zoom
  const gesture = useRef<{ kind: 'pan' | 'node'; id?: string; edge?: string; sx: number; sy: number; cam: Camera; ox: number; oy: number; moved: boolean } | null>(null);
  const frame = useRef(0);
  const lastClick = useRef({ id: '', at: 0 });
  const toNeighbourhoodRef = useRef<(id: string | null) => void>(() => {});
  useEffect(() => {
    const w = wrap.current; if (!w) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = w.getBoundingClientRect();
      const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0016));
      zoomBy(f, { x: e.clientX - r.left, y: e.clientY - r.top });
    };
    w.addEventListener('wheel', onWheel, { passive: false });
    return () => w.removeEventListener('wheel', onWheel);
  }, [zoomBy]);
  const canDrag = overview && !!scene;
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const t = e.target as Element;
    if (t.closest('[data-ui]')) return;
    const toggle = t.closest('[data-collapse]')?.getAttribute('data-collapse');
    if (toggle) { setCollapsed((s) => { const n = new Set(s); n.add(toggle); return n; }); return; }
    const nodeId = t.closest('[data-node-id]')?.getAttribute('data-node-id') ?? undefined;
    const n = nodeId ? sceneRef.current?.nodes.find((x) => x.id === nodeId) : undefined;
    wrap.current?.focus({ preventScroll: true });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const edge = n ? undefined : t.closest('[data-edge-id]')?.getAttribute('data-edge-id') ?? undefined;
    gesture.current = { kind: n ? 'node' : 'pan', id: n?.id, edge, sx: e.clientX, sy: e.clientY, cam: store.get(), ox: n?.x ?? 0, oy: n?.y ?? 0, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current; if (!g) return;
    const dx = e.clientX - g.sx; const dy = e.clientY - g.sy;
    if (!g.moved && Math.hypot(dx, dy) < 4) return;
    g.moved = true;
    if (g.kind === 'pan') { touched.current = true; apply({ ...g.cam, x: g.cam.x + dx, y: g.cam.y + dy }); return; }
    if (!canDrag || !g.id) return;
    const k = store.get().k;
    const next = { id: g.id, x: Math.round(g.ox + dx / k), y: Math.round(g.oy + dy / k) };
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => setDrag(next));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current; gesture.current = null;
    if (!g) return;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* released */ }
    if (!g.moved) {
      const edgeId = g.edge;
      if (g.kind === 'node' && g.id) {
        if (isCollapsedId(g.id)) { const gid = g.id.slice(3); setCollapsed((s) => { const n = new Set(s); n.delete(gid); return n; }); return; }
        setSelection({ type: 'node', id: g.id });
        // A second click on the same box soon after: its neighbourhood.
        const now = Date.now();
        if (lastClick.current.id === g.id && now - lastClick.current.at < 380) { setCenter(g.id); setMode('neighbourhood'); lastClick.current = { id: '', at: 0 }; }
        else lastClick.current = { id: g.id, at: now };
      } else if (edgeId) {
        const se = sceneRef.current?.edges.find((x) => x.id === edgeId);
        setSelection({ type: 'edge', id: se?.ids[0] ?? edgeId });
      } else setSelection(null);
      return;
    }
    if (g.kind === 'node' && g.id && canDrag) {
      cancelAnimationFrame(frame.current);
      const k = store.get().k;
      const final = { x: Math.round(g.ox + (e.clientX - g.sx) / k), y: Math.round(g.oy + (e.clientY - g.sy) / k) };
      const nextMoved = new Map(moved); nextMoved.set(g.id, final);
      setMoved(nextMoved);
      setDrag(null);
      if (onPositions && base) onPositions(positionsOf(moveNodes(base, vg, nextMoved)));
    }
  };

  // ---- search, flows, keyboard
  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return null;
    return new Set(shown.nodes.filter((n) => `${n.title} ${n.tech ?? ''} ${n.id} ${n.kind} ${n.address ?? ''} ${(n.tags ?? []).join(' ')}`.toLowerCase().includes(q)).map((n) => n.id));
  }, [shown, q]);
  const steps = useMemo(() => (play.flow ? resolveFlow(shown, play.flow) : []), [shown, play.flow]);
  useEffect(() => { if (play.flow && !shown.flows?.some((f) => f.id === play.flow)) dispatch({ type: 'select', flow: null, length: 0 }); }, [shown, play.flow]);
  useEffect(() => {
    if (!play.playing) return;
    const t = setTimeout(() => dispatch({ type: 'tick' }), STEP_MS / play.speed);
    return () => clearTimeout(t);
  }, [play.playing, play.step, play.speed]);
  const frameNow = useMemo(() => (play.flow ? flowFrame(steps, play.step) : null), [steps, play.flow, play.step]);
  const flowDraw = useMemo((): FlowDraw | null => {
    if (!frameNow || !scene || play.step < 0) return null;
    const byNode = new Map(scene.nodes.map((n) => [n.id, n]));
    const folded = (id: string) => byNode.get(id) ?? scene.nodes.find((n) => n.collapsed && isInside(shown, id, n.collapsed.id));
    return {
      drawMs: Math.min(700, (STEP_MS / play.speed) * 0.45),
      steps: frameNow.shown.map((s) => {
        const se = s.edge ? scene.edges.find((x) => x.ids.includes(s.edge!)) : undefined;
        let points = se?.points;
        if (points && s.reversed) points = reversePoints(points);
        if (!points) { const a = folded(s.from); const b = folded(s.to); points = a && b ? simpleRoute(a, b, scene.dir) : []; }
        return { key: `${s.index}`, index: s.index, points, label: s.label, current: s.index === play.step };
      }).filter((s) => s.points.length >= 4),
    };
  }, [frameNow, scene, play.step, play.speed, shown]);
  const changedSet = useMemo(() => new Set(changed?.nodes ?? []), [changed]);
  const changedEdges = useMemo(() => new Set(changed?.edges ?? []), [changed]);
  const drawState = useMemo((): DrawState => ({
    selected: selection ? (selection.type === 'edge' ? { type: 'edge', id: scene?.edges.find((e) => e.ids.includes(selection.id))?.id ?? selection.id } : selection) : null,
    bright: frameNow && play.step >= 0 ? frameNow.lit : matches,
    brightEdges: frameNow && play.step >= 0 ? new Set(scene?.edges.filter((e) => e.ids.some((id) => frameNow.litEdges.has(id))).map((e) => e.id) ?? []) : null,
    changed: changedSet, changedEdges, matches: matches ?? undefined, flow: flowDraw,
  }), [selection, frameNow, play.step, matches, changedSet, changedEdges, flowDraw, scene]);

  const lonely = useMemo(() => unconnected(shown), [shown]);
  const summary = useMemo(() => summaryLine(summarizeDiagram(shown), shown.view), [shown]);
  const select = useCallback((s: DiagramSelection | null) => {
    setSelection(s);
    if (s?.type === 'node') { const id = sceneRef.current?.nodes.some((n) => n.id === s.id) ? s.id : undefined; if (id) centerOn(id); }
  }, [centerOn]);

  useEffect(() => {
    if (!props.apiRef) return;
    props.apiRef.current = { select, neighbourhood: (id) => toNeighbourhoodRef.current(id), fit: () => fit() };
    return () => { if (props.apiRef) props.apiRef.current = null; };
  });

  useEffect(() => { if (details === 'external') onDetails?.({ open: detailsOpen, selection, spec: shown, changed: changedSet }); }, [details, detailsOpen, selection, shown, changedSet]); // eslint-disable-line react-hooks/exhaustive-deps

  const onKeyDown = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
    const sc = sceneRef.current; if (!sc) return;
    const dirs: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (dirs[e.key]) {
      e.preventDefault();
      const cur = selection?.type === 'node' ? sc.nodes.find((n) => n.id === selection.id) : undefined;
      if (!cur) { const first = [...sc.nodes].sort((a, b) => a.y - b.y || a.x - b.x)[0]; if (first) select({ type: 'node', id: first.id }); return; }
      const next = neighbourInDirection(sc, cur.id, dirs[e.key]!);
      if (next) select({ type: 'node', id: next });
      return;
    }
    if (e.key === 'Enter' && selection) { e.preventDefault(); setDetailsOpen(true); return; }
    if (e.key === 'Escape') {
      if (play.flow && play.step >= 0) { dispatch({ type: 'reset' }); e.stopPropagation(); return; }
      if (query) { setQuery(''); e.stopPropagation(); return; }
      if (selection || detailsOpen) { setSelection(null); setDetailsOpen(false); e.stopPropagation(); }
      return;
    }
    if (e.key === '+' || e.key === '=') zoomBy(1.2);
    else if (e.key === '-') zoomBy(1 / 1.2);
    else if (e.key === '0') fit();
  };

  // ---- export
  const exportAs = async (kind: 'svg' | 'png') => {
    if (!svg.current || !scene) return;
    const { text, width, height } = exportSvg(svg.current, scene, title ?? shown.title);
    const name = fileSlug(title ?? shown.title);
    if (kind === 'svg') downloadText(`${name}.svg`, text, 'image/svg+xml');
    else downloadBlob(`${name}.png`, await svgToPng(text, width, height, 2));
  };

  const flows = shown.flows ?? [];
  const selNode = selection?.type === 'node' ? selection.id : null;
  const toNeighbourhood = (id: string | null) => {
    const c = id ?? selNode ?? [...spec.nodes].sort((a, b) => degree(spec, b.id) - degree(spec, a.id))[0]?.id ?? null;
    if (!c) return;
    setCenter(c); setSelection({ type: 'node', id: c }); setMode('neighbourhood');
  };
  toNeighbourhoodRef.current = toNeighbourhood;

  return (
    <div className={cx('relative flex h-full min-h-[320px] w-full flex-col overflow-hidden bg-hx-bg', className)} data-diagram-canvas={shown.view} data-mode={mode} data-engine={scene?.engine ?? ""} data-nodes={scene?.nodes.length ?? 0} data-edges={scene?.edges.length ?? 0}>
      <div className="flex min-h-0 flex-1">
        <div
          ref={wrap}
          tabIndex={0}
          role="application"
          aria-label={`${title ?? shown.title ?? 'Diagram'}: arrow keys move the selection, Enter shows details, Escape clears`}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => { gesture.current = null; setDrag(null); }}
          className="relative min-w-0 flex-1 cursor-grab touch-none select-none outline-none active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-hx-focus"
          style={{ backgroundImage: 'radial-gradient(circle, var(--hx-border) 1.1px, transparent 1.3px)', backgroundSize: '22px 22px' }}
          data-diagram-viewport=""
        >
          {scene && <MemoDrawing scene={scene} view={shown.view} state={drawState} live cameraRef={cameraG} svgRef={svg} title={title ?? shown.title} />}
          {(!scene || busy) && <div className="absolute inset-0 flex items-center justify-center" data-ui=""><span className="flex items-center gap-2 rounded-full border border-hx-border-subtle bg-hx-elevated px-3 py-1.5 text-[12px] text-hx-muted shadow-sm"><Spinner size={12} />Laying out…</span></div>}

          {/* top-left: search, not connected, changed, flows */}
          <div data-ui="" className="absolute left-3 top-3 flex max-w-[60%] flex-wrap items-start gap-1.5">
            <label className="flex h-8 items-center gap-1.5 rounded-lg border border-hx-border-subtle bg-hx-elevated/95 px-2 shadow-sm backdrop-blur">
              <Icon name="search" size={14} className="text-hx-muted" />
              <input data-diagram-search value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => {
                if (e.key === 'Enter' && matches?.size) { const id = [...matches][0]!; select({ type: 'node', id }); }
                if (e.key === 'Escape') { setQuery(''); wrap.current?.focus(); }
              }} placeholder="Search boxes" className="w-36 bg-transparent text-[12.5px] text-hx-primary outline-none placeholder:text-hx-muted" />
              {q && <span className="text-[11px] tabular-nums text-hx-muted">{matches?.size ?? 0}</span>}
            </label>
            {lonely.length > 0 && (
              <div className="relative">
                <button type="button" data-diagram-lonely={lonely.length} onClick={() => setLonelyOpen((v) => !v)} className="flex h-8 items-center gap-1.5 rounded-lg border border-hx-border-subtle bg-hx-elevated/95 px-2.5 text-[12px] text-hx-secondary shadow-sm hover:text-hx-primary">
                  <span className="h-2 w-2 rounded-full border border-hx-muted" />{lonely.length} not connected
                </button>
                {lonelyOpen && (
                  <ul className="absolute left-0 top-9 z-20 max-h-64 w-56 overflow-auto rounded-lg border border-hx-border bg-hx-elevated p-1 shadow-lg">
                    {lonely.map((id) => <li key={id}><button type="button" className="w-full truncate rounded-md px-2 py-1 text-left text-[12.5px] hover:bg-hx-hover" onClick={() => { select({ type: 'node', id }); setLonelyOpen(false); }}>{shown.nodes.find((n) => n.id === id)?.title ?? id}</button></li>)}
                  </ul>
                )}
              </div>
            )}
            {changed && (changed.nodes.length > 0 || changed.edges.length > 0) && (
              <span data-diagram-changed={changed.nodes.length} className="flex h-8 items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/12 px-2.5 text-[12px] font-medium text-hx-warning shadow-sm">
                {changed.note ?? `${changed.nodes.length} changed`}
                {onClearChanged && <button type="button" aria-label="Clear the changed marks" className="rounded p-0.5 hover:bg-hx-hover" onClick={onClearChanged}><Icon name="x" size={12} /></button>}
              </span>
            )}
            {flows.length > 0 && (
              <button type="button" data-diagram-flows-toggle onClick={() => setFlowsOpen((v) => !v)} className={cx('flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] shadow-sm', flowsOpen ? 'border-hx-accent/50 bg-hx-accent-soft text-hx-accent-text' : 'border-hx-border-subtle bg-hx-elevated/95 text-hx-secondary hover:text-hx-primary')}>
                <Icon name="play" size={12} />{flows.length} flow{flows.length === 1 ? '' : 's'}
              </button>
            )}
          </div>
          {flowsOpen && flows.length > 0 && (
            <div data-ui="" data-diagram-flows="" className="absolute left-3 top-14 z-10 w-[300px] rounded-xl border border-hx-border-subtle bg-hx-elevated/97 p-2 shadow-lg backdrop-blur">
              <select data-flow-select value={play.flow ?? ''} onChange={(e) => { const id = e.target.value || null; dispatch({ type: 'select', flow: id, length: id ? resolveFlow(shown, id).length : 0 }); }} className="mb-2 w-full rounded-md border border-hx-border bg-hx-bg px-2 py-1 text-[12.5px] text-hx-primary">
                <option value="">Choose a flow…</option>
                {flows.map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}
              </select>
              {play.flow && (
                <>
                  <div className="mb-2 flex items-center gap-1">
                    <IconButton size="sm" icon="chevron-left" label="Previous step" data-flow-prev onClick={() => dispatch({ type: 'prev' })} disabled={play.step < 0} />
                    <IconButton size="sm" icon={play.playing ? 'pause' : 'play'} label={play.playing ? 'Pause' : 'Play'} data-flow-play onClick={() => dispatch({ type: 'toggle' })} active={play.playing} />
                    <IconButton size="sm" icon="chevron-right" label="Next step" data-flow-next onClick={() => dispatch({ type: 'next' })} disabled={play.step >= play.length - 1} />
                    <span className="ml-1 text-[11.5px] tabular-nums text-hx-muted" data-flow-position>{play.step < 0 ? `${play.length} steps` : `${play.step + 1} / ${play.length}`}</span>
                    <span className="ml-auto flex rounded-md border border-hx-border-subtle p-0.5">
                      {PLAYBACK_SPEEDS.map((s) => <button key={s} type="button" data-flow-speed={s} onClick={() => dispatch({ type: 'speed', speed: s })} className={cx('rounded px-1.5 text-[11px]', play.speed === s ? 'bg-hx-active text-hx-primary' : 'text-hx-muted hover:text-hx-primary')}>{s}×</button>)}
                    </span>
                  </div>
                  <ol className="max-h-56 space-y-0.5 overflow-auto" data-flow-steps>
                    {steps.map((s) => (
                      <li key={s.index}>
                        <button type="button" onClick={() => dispatch({ type: 'goto', step: s.index })} data-flow-step-item={s.index} data-active={s.index === play.step ? '1' : '0'} className={cx('flex w-full gap-2 rounded-md px-1.5 py-1 text-left text-[12px]', s.index === play.step ? 'bg-hx-accent-soft text-hx-accent-text' : s.index < play.step ? 'text-hx-secondary hover:bg-hx-hover' : 'text-hx-muted hover:bg-hx-hover')}>
                          <span className="w-4 shrink-0 text-right tabular-nums">{s.index + 1}.</span><span className="min-w-0 flex-1">{s.label}</span>
                        </button>
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </div>
          )}

          {/* top-right: mode, zoom, fit, details, export */}
          <div data-ui="" className="absolute right-3 top-3 flex items-center gap-1 rounded-lg border border-hx-border-subtle bg-hx-elevated/95 p-0.5 shadow-sm backdrop-blur">
            <span className="flex rounded-md bg-hx-pill p-0.5" role="tablist">
              <button type="button" role="tab" aria-selected={overview} data-mode-button="overview" onClick={() => setMode('overview')} className={cx('rounded px-2 py-0.5 text-[12px]', overview ? 'bg-hx-elevated text-hx-primary shadow-sm' : 'text-hx-muted hover:text-hx-primary')}>Overview</button>
              <button type="button" role="tab" aria-selected={!overview} data-mode-button="neighbourhood" onClick={() => toNeighbourhood(center && !selNode ? center : null)} className={cx('rounded px-2 py-0.5 text-[12px]', !overview ? 'bg-hx-elevated text-hx-primary shadow-sm' : 'text-hx-muted hover:text-hx-primary')}>Neighbourhood</button>
            </span>
            {!overview && (
              <select aria-label="Hops" value={hops} onChange={(e) => setHops(Number(e.target.value))} data-diagram-hops className="rounded-md bg-transparent px-1 text-[12px] text-hx-secondary">
                {[1, 2, 3].map((h) => <option key={h} value={h}>{h} hop{h > 1 ? 's' : ''}</option>)}
              </select>
            )}
            <ZoomLabel store={store} />
            <IconButton size="sm" icon="fit" label="Fit to the window (0)" data-diagram-fit onClick={() => fit()} />
            <IconButton size="sm" icon="refresh" label="Lay it out again" onClick={() => { forgetLayout(stableKey); setFresh((n) => n + 1); }} />
            <IconButton size="sm" icon="download" label="Export as SVG" data-diagram-export="svg" onClick={() => void exportAs('svg')} />
            <IconButton size="sm" icon="image" label="Export as PNG" data-diagram-export="png" onClick={() => void exportAs('png')} />
            {extra}
            <IconButton size="sm" icon="panel-right" label={detailsOpen ? 'Hide the details' : 'Show the details'} data-diagram-details-toggle active={detailsOpen} onClick={() => setDetailsOpen((v) => !v)} />
          </div>

          {/* bottom-left: zoom */}
          <div data-ui="" className="absolute bottom-3 left-3 flex flex-col overflow-hidden rounded-lg border border-hx-border-subtle bg-hx-elevated/95 shadow-sm backdrop-blur">
            <IconButton size="sm" icon="plus" label="Zoom in (+)" data-diagram-zoom="in" onClick={() => zoomBy(1.25)} className="rounded-none" />
            <IconButton size="sm" icon="minus" label="Zoom out (-)" data-diagram-zoom="out" onClick={() => zoomBy(1 / 1.25)} className="rounded-none border-t border-hx-border-subtle" />
            <IconButton size="sm" icon="fit" label="Fit" onClick={() => fit()} className="rounded-none border-t border-hx-border-subtle" />
          </div>

          {/* bottom-right: minimap */}
          {scene && <Minimap scene={scene} store={store} viewport={wrap} onJump={(c) => { touched.current = true; apply(c); }} />}

          {/* bottom-centre: ask the agent */}
          {onAsk && (
            <form data-ui="" data-diagram-ask="" onSubmit={(e) => { e.preventDefault(); const t = ask.trim(); if (!t || askState?.pending) return; void Promise.resolve(onAsk(t)).then(() => setAsk('')); }} className="absolute bottom-3 left-1/2 flex w-[min(520px,calc(100%-260px))] -translate-x-1/2 items-center gap-1.5 rounded-xl border border-hx-border bg-hx-elevated/97 p-1 pl-3 shadow-md backdrop-blur">
              <Icon name="sparkles" size={14} className="shrink-0 text-hx-accent-text" />
              <input data-diagram-ask-input value={ask} onChange={(e) => setAsk(e.target.value)} placeholder={askState?.note ?? 'Ask the agent to change the design…'} disabled={askState?.pending} className="min-w-0 flex-1 bg-transparent text-[13px] text-hx-primary outline-none placeholder:text-hx-muted disabled:opacity-60" />
              {askState?.pending ? <span className="flex items-center gap-1.5 px-2 text-[11.5px] text-hx-muted"><Spinner size={12} />{askState.note ?? 'Waiting…'}</span>
                : <button type="submit" disabled={!ask.trim()} aria-label="Send to the agent" className="flex h-7 w-7 items-center justify-center rounded-lg bg-hx-accent text-hx-on-accent disabled:opacity-40"><Icon name="send" size={14} /></button>}
            </form>
          )}
        </div>
        {details === 'internal' && detailsOpen && (
          <aside className="hx-scroll w-[300px] shrink-0 overflow-y-auto border-l border-hx-border-subtle bg-hx-bg" data-diagram-details-panel="">
            <DiagramDetails spec={shown} selection={selection} changed={changedSet} onSelect={select} onOpenLink={onOpenLink} onNeighbourhood={(id) => toNeighbourhood(id)} onClose={() => setDetailsOpen(false)} />
          </aside>
        )}
      </div>
      <Legend summary={summary} view={shown.view} />
    </div>
  );
}

const MemoDrawing = React.memo(Drawing);

function isInside(spec: DiagramSpec, nodeId: string, group: string): boolean {
  const byId = new Map((spec.groups ?? []).map((g) => [g.id, g]));
  for (let g = spec.nodes.find((n) => n.id === nodeId)?.group; g; g = byId.get(g)?.parent) if (g === group) return true;
  return false;
}
function degree(spec: DiagramSpec, id: string): number { return (spec.edges ?? []).filter((e) => e.from === id || e.to === id).length; }

/** The box in a screen direction from `from`: connected ones first (AICO's rule: by distance over the angle's cosine). */
function neighbourInDirection(scene: Scene, from: string, [dx, dy]: [number, number]): string | undefined {
  const a = scene.nodes.find((n) => n.id === from)!;
  const linked = new Set(scene.edges.flatMap((e) => (e.from === from ? [e.to] : e.to === from ? [e.from] : [])));
  const pick = (pool: typeof scene.nodes) => {
    let best: string | undefined; let score = Infinity;
    for (const n of pool) {
      if (n.id === from) continue;
      const vx = n.x + n.w / 2 - (a.x + a.w / 2); const vy = n.y + n.h / 2 - (a.y + a.h / 2);
      const dist = Math.hypot(vx, vy) || 1e-6;
      const cos = (vx * dx + vy * dy) / dist;
      if (cos < 0.4) continue;
      const s = dist / (cos * cos);
      if (s < score) { score = s; best = n.id; }
    }
    return best;
  };
  return pick(scene.nodes.filter((n) => linked.has(n.id))) ?? pick(scene.nodes);
}

function ZoomLabel({ store }: { store: ReturnType<typeof cameraStore> }) {
  const k = useSyncExternalStore(store.subscribe, () => store.get().k, () => 1);
  return <span className="min-w-[3rem] text-center text-[11.5px] tabular-nums text-hx-muted" data-diagram-zoom-label>{Math.round(k * 100)}%</span>;
}

function Minimap({ scene, store, viewport, onJump }: { scene: Scene; store: ReturnType<typeof cameraStore>; viewport: React.RefObject<HTMLDivElement | null>; onJump: (c: Camera) => void }) {
  const cam = useSyncExternalStore(store.subscribe, store.get, store.get);
  const W = 180; const H = 112;
  const b = scene.bounds;
  const s = Math.min((W - 12) / Math.max(1, b.w), (H - 12) / Math.max(1, b.h));
  const ox = (W - b.w * s) / 2 - b.x * s; const oy = (H - b.h * s) / 2 - b.y * s;
  const vw = viewport.current?.clientWidth ?? 800; const vh = viewport.current?.clientHeight ?? 600;
  const view = { x: (-cam.x / cam.k) * s + ox, y: (-cam.y / cam.k) * s + oy, w: (vw / cam.k) * s, h: (vh / cam.k) * s };
  const jump = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const wx = (e.clientX - r.left - ox) / s; const wy = (e.clientY - r.top - oy) / s;
    onJump({ k: cam.k, x: vw / 2 - wx * cam.k, y: vh / 2 - wy * cam.k });
  };
  return (
    <div data-ui="" data-diagram-minimap="" className="absolute bottom-3 right-3 overflow-hidden rounded-lg border border-hx-border-subtle bg-hx-elevated/95 shadow-sm backdrop-blur">
      <svg width={W} height={H} onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); jump(e); }} onPointerMove={(e) => { if (e.buttons & 1) jump(e); }} className="block cursor-pointer">
        {scene.groups.map((g) => <rect key={g.id} x={g.x * s + ox} y={g.y * s + oy} width={g.w * s} height={g.h * s} rx={2} fill="none" stroke="var(--hx-border)" />)}
        {scene.nodes.map((n) => <rect key={n.id} x={n.x * s + ox} y={n.y * s + oy} width={Math.max(1.5, n.w * s)} height={Math.max(1.5, n.h * s)} rx={1} fill="var(--hx-text-muted)" fillOpacity={0.55} />)}
        {(() => { const x0 = Math.max(1, view.x); const y0 = Math.max(1, view.y); const x1 = Math.min(W - 1, view.x + view.w); const y1 = Math.min(H - 1, view.y + view.h); return x1 > x0 && y1 > y0 && (x1 - x0) * (y1 - y0) < W * H * 0.92 ? <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill="var(--hx-accent)" fillOpacity={0.06} stroke="var(--hx-accent)" strokeWidth={1.3} rx={2} data-minimap-view="" /> : null; })()}
      </svg>
    </div>
  );
}

/** The legend and the summary line under the canvas. */
export function Legend({ summary, view, compact }: { summary: string; view: string; compact?: boolean }): React.ReactElement {
  const dot = (c: string, hollow = false) => <span className={cx('inline-block h-2.5 w-2.5 rounded-full', hollow && 'border border-dashed border-hx-muted')} style={hollow ? undefined : { background: c }} />;
  return (
    <div data-diagram-legend="" className={cx('flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-hx-border-subtle bg-hx-bg text-[11.5px] text-hx-muted', compact ? 'px-2.5 py-1.5' : 'px-3 py-2')}>
      {view !== 'code' && view !== 'data' && <>
        <span className="flex items-center gap-1.5">{dot('#16a34a')}done</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-amber-500 border-r-transparent" />in progress</span>
        <span className="flex items-center gap-1.5">{dot('#dc2626')}failing</span>
        <span className="flex items-center gap-1.5">{dot('', true)}planned</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded-[3px] border border-dashed border-hx-muted" />dashed = integrated / bought</span>
      </>}
      {view === 'code' && <span className="flex items-center gap-1.5"><span className="rounded-full border border-hx-border px-1.5 text-[10px] leading-4">12</span>imports between folders</span>}
      {view === 'data' && <span className="flex items-center gap-1.5"><b className="text-hx-secondary">n · 1</b>many rows point at one</span>}
      {view !== 'code' && <span className="flex items-center gap-1.5"><svg width="18" height="6" aria-hidden="true"><path d="M0 3h18" stroke="currentColor" strokeWidth="1.4" strokeDasharray="4 3" /></svg>dashed line = asynchronous</span>}
      <span className="ml-auto font-medium text-hx-secondary" data-diagram-summary>{summary}</span>
    </div>
  );
}

export { collapsedId };
