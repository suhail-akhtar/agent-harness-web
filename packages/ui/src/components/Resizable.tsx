/**
 * Resizable panes, drawn: useResizable gives a pane its size (saved in the pane store, clamped to
 * the window) and the props of its drag handle; ResizeHandle is that handle (a focusable
 * role="separator" with its value, the arrow keys, Home/End, Enter to collapse, double-click to go
 * back to the default). While dragging, the size is written straight to the pane's element once a
 * frame (no React render per pointer move), text is not selected and frames (plugin iframes) do not
 * take the pointer; the new size is saved when the drag ends.
 */

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { cx } from './primitives.tsx';
import {
  collapsedSizeOf, dragPane, keyPane, markPaneMounted, paneBounds, paneShown, paneStore, registerPane, subscribePanes, viewportNow,
  type PaneShown, type PaneSpec, type PaneState, type Viewport,
} from './panes.ts';

export * from './panes.ts';

function subscribeViewport(fn: () => void) { window.addEventListener('resize', fn); return () => window.removeEventListener('resize', fn); }
const viewportKey = () => `${window.innerWidth}x${window.innerHeight}`;
/** The window's size, re-rendering when it changes. */
export function useViewport(): Viewport {
  const key = useSyncExternalStore(subscribeViewport, viewportKey, () => '1280x800');
  const [w, h] = key.split('x').map(Number) as [number, number];
  return { width: w, height: h };
}

/** A pane's saved state, following the store. */
export function usePaneState(id: string): PaneState | undefined {
  const snap = () => JSON.stringify(paneStore().get(id) ?? null);
  const key = useSyncExternalStore(subscribePanes, snap, snap);
  return React.useMemo(() => (JSON.parse(key) as PaneState | null) ?? undefined, [key]);
}

export interface ResizableOptions {
  /** Which edge of the pane the handle is on: 'end' (right or bottom: dragging right grows it) or 'start' (left or top). */
  edge: 'start' | 'end';
  /** The host decides it is collapsed (a narrow window's rail): no resizing then. */
  forceCollapsed?: boolean;
  disabled?: boolean;
}

export interface Resizable {
  size: number;
  collapsed: boolean;
  dragging: boolean;
  /** For the pane: its ref and its width (or height). */
  paneRef: React.RefCallback<HTMLElement>;
  paneStyle: React.CSSProperties;
  paneId: string;
  handleProps: React.HTMLAttributes<HTMLDivElement> & { ref: React.RefCallback<HTMLDivElement>; [k: `data-${string}`]: string | undefined };
  /** Saves a size (or null: back to the default), as a key or the layout command would. */
  commit(next: Partial<PaneShown> | null): void;
}

const RESIZING = 'hx-resizing';

/**
 * A resizable pane. `spec` is registered (agents and the layout command know it) and its saved
 * state comes from the pane store (setPaneStore: the desktop's prefs).
 */
export function useResizable(spec: PaneSpec, o: ResizableOptions): Resizable {
  useEffect(() => { registerPane(spec); }, [spec]);
  useEffect(() => { markPaneMounted(spec.id, true); return () => markPaneMounted(spec.id, false); }, [spec.id]);
  const state = usePaneState(spec.id);
  const win = useViewport();
  const pane = useRef<HTMLElement | null>(null);
  // A pane inside a page follows its container too (the max leaves `keep` px for what is beside it).
  const [box, setBox] = useState<number | undefined>(undefined);
  const boxRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    const parent = pane.current?.parentElement;
    if (spec.keep === undefined || !parent || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { const r = parent.getBoundingClientRect(); const n = Math.round(spec.axis === 'y' ? r.height : r.width); boxRef.current = n; setBox(n); });
    ro.observe(parent);
    return () => ro.disconnect();
  }, [spec.keep, spec.axis]);
  const vp: Viewport = box !== undefined ? { ...win, box } : win;
  const saved = paneShown(spec, state, vp);
  const [preview, setPreview] = useState<boolean | null>(null);
  const [dragging, setDragging] = useState(false);
  const handle = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ pos: number; start: PaneShown; last: PaneShown; frame: number; moved: boolean; id: number } | null>(null);
  const y = spec.axis === 'y';
  const sign = o.edge === 'end' ? 1 : -1;
  const collapsed = o.forceCollapsed ?? (preview ?? saved.collapsed);
  const size = collapsed ? collapsedSizeOf(spec) : saved.size;
  const b = paneBounds(spec, vp);
  const off = !!o.disabled || o.forceCollapsed !== undefined;
  const paneId = `hx-pane-${spec.id.replace(/[^a-z0-9_-]/gi, '-')}`;

  const commit = useCallback((next: Partial<PaneShown> | null) => {
    if (next === null) { paneStore().set(spec.id, null); return; }
    paneStore().set(spec.id, { ...(next.size !== undefined ? { size: next.size } : {}), ...(spec.collapsible && next.collapsed !== undefined ? { collapsed: next.collapsed } : {}) });
  }, [spec.id, spec.collapsible]);

  // Written straight to the elements during a drag (React's props do not change until it ends).
  const paint = (s: PaneShown) => {
    const px = s.collapsed ? collapsedSizeOf(spec) : s.size;
    if (pane.current) pane.current.style[y ? 'height' : 'width'] = `${px}px`;
    if (handle.current) { handle.current.setAttribute('aria-valuenow', String(px)); handle.current.dataset.paneSize = String(px); }
  };
  const end = (cancel: boolean) => {
    const d = drag.current;
    if (!d) return;
    cancelAnimationFrame(d.frame);
    drag.current = null;
    document.documentElement.classList.remove(RESIZING, `${RESIZING}-${y ? 'y' : 'x'}`);
    setDragging(false);
    setPreview(null);
    try { handle.current?.releasePointerCapture(d.id); } catch { /* released */ }
    if (cancel || !d.moved) { paint(d.start); return; }
    commit(d.last.collapsed ? { collapsed: true } : { size: d.last.size, collapsed: false });
  };
  useEffect(() => () => { if (drag.current) end(true); }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (off || e.button !== 0) return;
    e.preventDefault();
    handle.current?.focus({ preventScroll: true });
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    const start = { size: saved.size, collapsed };
    drag.current = { pos: y ? e.clientY : e.clientX, start, last: start, frame: 0, moved: false, id: e.pointerId };
    document.documentElement.classList.add(RESIZING, `${RESIZING}-${y ? 'y' : 'x'}`);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const delta = ((y ? e.clientY : e.clientX) - d.pos) * sign;
    if (!d.moved && Math.abs(delta) < 2) return;
    d.moved = true;
    const next = dragPane(spec, d.start, delta, boxRef.current !== undefined ? { ...viewportNow(), box: boxRef.current } : viewportNow());
    const flip = next.collapsed !== d.last.collapsed;
    d.last = next;
    if (flip) setPreview(next.collapsed);
    cancelAnimationFrame(d.frame);
    d.frame = requestAnimationFrame(() => paint(next));
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (off) return;
    if (e.key === 'Escape' && drag.current) { e.preventDefault(); end(true); return; }
    const grow = y ? (sign > 0 ? 'ArrowDown' : 'ArrowUp') : (sign > 0 ? 'ArrowRight' : 'ArrowLeft');
    const shrink = y ? (sign > 0 ? 'ArrowUp' : 'ArrowDown') : (sign > 0 ? 'ArrowLeft' : 'ArrowRight');
    const next = keyPane(spec, { size: saved.size, collapsed }, e.key, { shift: e.shiftKey, grow, shrink }, vp);
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    commit(next);
  };

  return {
    size, collapsed, dragging, paneId, commit,
    paneRef: useCallback((el: HTMLElement | null) => { pane.current = el; }, []),
    paneStyle: y ? { height: size } : { width: size },
    handleProps: {
      ref: useCallback((el: HTMLDivElement | null) => { handle.current = el; }, []),
      role: 'separator',
      tabIndex: off ? -1 : 0,
      'aria-orientation': y ? 'horizontal' : 'vertical',
      'aria-label': `Resize the ${spec.title}`,
      'aria-controls': paneId,
      'aria-valuenow': size,
      'aria-valuemin': spec.collapsible ? collapsedSizeOf(spec) : b.min,
      'aria-valuemax': b.max,
      ...(off ? { 'aria-disabled': true } : {}),
      title: off ? undefined : `Drag to resize${spec.collapsible ? ' (or to collapse)' : ''}; double-click to reset`,
      'data-resize-handle': spec.id,
      'data-pane-size': String(size),
      'data-dragging': dragging ? '1' : undefined,
      'data-collapsed': collapsed ? '1' : '0',
      onPointerDown, onPointerMove,
      onPointerUp: () => end(false),
      onPointerCancel: () => end(false),
      onLostPointerCapture: () => end(false),
      onKeyDown,
      onDoubleClick: (e) => { if (off) return; e.preventDefault(); commit(null); },
    },
  };
}

/**
 * The drag handle: a 6px hit area over the pane's edge (it takes no room of its own), a line that
 * shows on hover, focus and while dragging. The pane it sits in is position: relative.
 */
export function ResizeHandle({ r, edge, axis = 'x', className, ...data }: { r: Resizable; edge: 'start' | 'end'; axis?: 'x' | 'y'; className?: string } & Record<`data-${string}`, string | undefined>): React.ReactElement {
  const { ref, ...props } = r.handleProps;
  return <div ref={ref} {...props} {...data} data-edge={edge} data-axis={axis} className={cx('hx-resize-handle', className)} />;
}

/** A pane with its handle: a div (or the given element) sized by useResizable. */
export function ResizablePane({ spec, edge, as = 'div', className, style, forceCollapsed, disabled, handle, children, ...rest }: {
  spec: PaneSpec; edge: 'start' | 'end'; as?: 'div' | 'aside' | 'section' | 'nav'; className?: string; style?: React.CSSProperties; forceCollapsed?: boolean; disabled?: boolean;
  /** Extra data attributes for the handle. */
  handle?: Record<`data-${string}`, string>;
  children: React.ReactNode | ((r: Resizable) => React.ReactNode);
} & Record<`data-${string}`, string | undefined>): React.ReactElement {
  const r = useResizable(spec, { edge, ...(forceCollapsed !== undefined ? { forceCollapsed } : {}), ...(disabled ? { disabled } : {}) });
  const Tag = as as 'div';
  return (
    <Tag ref={r.paneRef} id={r.paneId} data-pane={spec.id} {...rest} className={cx('relative shrink-0', className)} style={{ ...style, ...r.paneStyle }}>
      {typeof children === 'function' ? children(r) : children}
      {!disabled && <ResizeHandle r={r} edge={edge} axis={spec.axis ?? 'x'} {...handle} />}
    </Tag>
  );
}
