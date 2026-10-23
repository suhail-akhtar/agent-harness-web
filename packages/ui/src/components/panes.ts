/**
 * Resizable panes, the pure half: a pane's spec (default, min, max, collapsing), the size it shows
 * in a viewport, what a drag or a key makes of it, and the store its size is kept in (the desktop
 * gives its prefs; the default is this browser's localStorage). Every resizable pane of the app is
 * one of these, drawn by useResizable (Resizable.tsx). Unit-tested in test/desktop-resizable.test.ts.
 */

/** The window's size and, for a pane inside a page, its container's extent along the axis (box). */
export interface Viewport { width: number; height: number; box?: number }

export interface PaneSpec {
  /** A stable id: the key its size is saved under, and what agents name (desktop layout command). */
  id: string;
  /** What the pane is, for the handle's label ("Resize the <title>") and for agents. */
  title: string;
  /** 'x' (a width, a col-resize handle) or 'y' (a height, a row-resize handle). */
  axis?: 'x' | 'y';
  /** The size it starts at and goes back to (double-click, reset); may follow the window. */
  default: number | ((vp: Viewport) => number);
  min: number;
  /** The largest it may be; may follow the window (keep the main content usable). */
  max?: number | ((vp: Viewport) => number);
  /** Collapses when dragged below collapseBelow (default: half of min), to collapsedSize. */
  collapsible?: boolean;
  collapsedSize?: number;
  collapseBelow?: number;
  /** Arrow-key step in px (Shift: four times). */
  step?: number;
  /** A pane inside a page: the room its container keeps for what is beside it (the max is the container less this). */
  keep?: number;
}

/** What is saved of a pane: its size (absent: the default) and whether it is collapsed. */
export interface PaneState { size?: number; collapsed?: boolean }
export interface PaneShown { size: number; collapsed: boolean }

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const val = (v: number | ((vp: Viewport) => number) | undefined, vp: Viewport, dflt: number) => (v === undefined ? dflt : typeof v === 'function' ? v(vp) : v);

/** The bounds in this viewport: max never below min (a tiny window still shows the pane at its min). */
export function paneBounds(spec: PaneSpec, vp: Viewport): { min: number; max: number } {
  const min = Math.max(0, Math.round(spec.min));
  let max = Math.round(val(spec.max, vp, Number.POSITIVE_INFINITY));
  if (!finite(max)) max = (spec.axis === 'y' ? vp.height : vp.width) - 1;
  if (spec.keep !== undefined && finite(vp.box) && vp.box > 0) max = Math.min(max, Math.round(vp.box - spec.keep));
  return { min, max: Math.max(min, max) };
}

export function clampPane(spec: PaneSpec, size: number, vp: Viewport): number {
  const b = paneBounds(spec, vp);
  return Math.round(Math.min(b.max, Math.max(b.min, finite(size) ? size : b.min)));
}

export function paneDefault(spec: PaneSpec, vp: Viewport): number { return clampPane(spec, val(spec.default, vp, spec.min), vp); }

export const collapsedSizeOf = (spec: PaneSpec) => spec.collapsedSize ?? 0;
export const collapseBelowOf = (spec: PaneSpec) => spec.collapseBelow ?? Math.round(spec.min / 2);

/** What the pane shows: its saved size clamped to this viewport (the saved one is kept, so a window made larger again gets it back). */
export function paneShown(spec: PaneSpec, state: PaneState | undefined, vp: Viewport): PaneShown {
  const size = finite(state?.size) ? clampPane(spec, state.size, vp) : paneDefault(spec, vp);
  return { size, collapsed: !!spec.collapsible && !!state?.collapsed };
}

/**
 * A drag: from the size at the start (collapsed or not), moved by delta px in the growing
 * direction. Below the collapse threshold a collapsible pane collapses; dragged out past it again,
 * it expands (at least to min).
 */
export function dragPane(spec: PaneSpec, start: PaneShown, delta: number, vp: Viewport): PaneShown {
  const from = start.collapsed ? collapsedSizeOf(spec) : start.size;
  const raw = from + delta;
  if (spec.collapsible && raw < collapseBelowOf(spec)) return { size: start.size, collapsed: true };
  return { size: clampPane(spec, raw, vp), collapsed: false };
}

/**
 * A key on the handle (WAI-ARIA window splitter): the arrows along the axis grow or shrink by a
 * step (Shift: four), Home is the min, End the max, Enter collapses or expands (where it can).
 * `grow` is the arrow that makes the pane larger (the handle on its right edge: ArrowRight).
 * Null: not a key of the handle's.
 */
export function keyPane(spec: PaneSpec, cur: PaneShown, key: string, o: { shift?: boolean; grow: string; shrink: string }, vp: Viewport): PaneShown | null {
  const step = (spec.step ?? 16) * (o.shift ? 4 : 1);
  const b = paneBounds(spec, vp);
  if (key === 'Enter' && spec.collapsible) return { size: cur.size, collapsed: !cur.collapsed };
  if (key === 'Home') return { size: b.min, collapsed: false };
  if (key === 'End') return { size: b.max, collapsed: false };
  if (key === o.grow) return cur.collapsed ? { size: cur.size, collapsed: false } : { size: clampPane(spec, cur.size + step, vp), collapsed: false };
  if (key === o.shrink) return cur.collapsed ? cur : { size: clampPane(spec, cur.size - step, vp), collapsed: false };
  return null;
}

/** A saved state from anywhere (a prefs file, an agent): only a finite size and a boolean; null when nothing is left. */
export function cleanPaneState(v: unknown): PaneState | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const out: PaneState = {};
  if (finite(o.size) && o.size >= 0 && o.size <= 10_000) out.size = Math.round(o.size);
  if (typeof o.collapsed === 'boolean') out.collapsed = o.collapsed;
  return Object.keys(out).length ? out : null;
}

// ---------------- the store and the known panes ----------------

export interface PaneStore {
  get(id: string): PaneState | undefined;
  /** A patch merged into the saved state; null forgets it (back to the default, expanded). */
  set(id: string, patch: PaneState | null): void;
  subscribe(fn: () => void): () => void;
}

/** The default store: this browser's localStorage (a page with no host to keep it). */
export function memoryPaneStore(backing?: { getItem(k: string): string | null; setItem(k: string, v: string): void } | null): PaneStore {
  const KEY = 'harness.panes';
  let all: Record<string, PaneState> = {};
  try { const raw = JSON.parse(backing?.getItem(KEY) ?? '{}') as Record<string, unknown>; for (const [k, v] of Object.entries(raw ?? {})) { const c = cleanPaneState(v); if (c) all[k] = c; } } catch { /* none */ }
  const subs = new Set<() => void>();
  return {
    get: (id) => all[id],
    set(id, patch) {
      const next = patch === null ? null : cleanPaneState({ ...all[id], ...patch });
      all = { ...all };
      if (next) all[id] = next; else delete all[id];
      try { backing?.setItem(KEY, JSON.stringify(all)); } catch { /* private mode */ }
      for (const f of subs) f();
    },
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
  };
}

let store: PaneStore = memoryPaneStore((() => { try { return globalThis.localStorage ?? null; } catch { return null; } })());
const storeSubs = new Set<() => void>();
/** The host keeps the sizes (the desktop: its prefs, across restarts). */
export function setPaneStore(s: PaneStore): void { store = s; for (const f of storeSubs) f(); }
export function paneStore(): PaneStore { return store; }
/** Follows the store and its changes (a new store counts as a change). */
export function subscribePanes(fn: () => void): () => void {
  storeSubs.add(fn);
  let un = store.subscribe(fn);
  let cur = store;
  const swap = () => { if (cur !== store) { un(); cur = store; un = store.subscribe(fn); } };
  storeSubs.add(swap);
  return () => { un(); storeSubs.delete(fn); storeSubs.delete(swap); };
}

const specs = new Map<string, PaneSpec>();
const mounted = new Map<string, number>();
/** Makes a pane known (for agents and the layout command) before it is drawn. */
export function registerPane(spec: PaneSpec): PaneSpec { specs.set(spec.id, spec); return spec; }
export function paneSpec(id: string): PaneSpec | undefined { return specs.get(id); }
export function paneSpecs(): PaneSpec[] { return [...specs.values()]; }
/** Whether a pane is on screen now. */
export function paneMounted(id: string): boolean { return (mounted.get(id) ?? 0) > 0; }
export function markPaneMounted(id: string, on: boolean): void { mounted.set(id, Math.max(0, (mounted.get(id) ?? 0) + (on ? 1 : -1))); }

export function viewportNow(): Viewport {
  const w = globalThis as unknown as { innerWidth?: number; innerHeight?: number };
  return { width: w.innerWidth ?? 1280, height: w.innerHeight ?? 800 };
}

/** What a pane is now, for agents: its size, bounds, default and whether it is on screen. */
export function describePane(spec: PaneSpec, vp: Viewport = viewportNow()) {
  const b = paneBounds(spec, vp);
  const shown = paneShown(spec, store.get(spec.id), vp);
  return { id: spec.id, title: spec.title, axis: spec.axis ?? 'x', size: shown.size, ...(spec.collapsible ? { collapsed: shown.collapsed } : {}), min: b.min, max: b.max, default: paneDefault(spec, vp), collapsible: !!spec.collapsible, onScreen: paneMounted(spec.id) };
}
