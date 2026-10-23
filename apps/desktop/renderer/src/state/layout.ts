/**
 * The window's resizable panes: their specs (default, min, max, which collapse) and the store their
 * sizes are kept in - the prefs file, so they survive restarts (the sidebar keeps its own
 * prefs.sidebar; every other pane is prefs.panes[id]). The maxima follow the window and leave the
 * main content its room. The layout command (core.shell:layout) lets an agent list, set, reset,
 * collapse and expand them.
 */

import { DIAGRAM_DETAILS_PANE, clampPane, describePane, paneShown, paneSpec, paneSpecs, registerPane, setPaneStore, viewportNow, type PaneSpec, type PaneState, type PaneStore, type Viewport } from '@harness/ui';
import { DEFAULT_PREFS } from '@desk/prefs';
import { useApp, NARROW_PX } from './app';

/** The main content keeps at least this much of the window, whatever the panes beside it. */
export const MAIN_MIN = 360;
export const RAIL = 56;

/** The sidebar's width on screen now (a rail when collapsed or narrow). */
function sidebarNow(vp: Viewport): number {
  if (vp.width < NARROW_PX) return RAIL;
  const s = useApp.getState().prefs.sidebar;
  return s.collapsed ? RAIL : clampPane(SIDEBAR_PANE, s.width, vp);
}
const panelOpen = () => !!useApp.getState().panel;
const splitOpen = () => !!useApp.getState().split;
const shownOf = (spec: PaneSpec, vp: Viewport) => paneShown(spec, layoutStore.get(spec.id), vp).size;

export const SIDEBAR_PANE = registerPane({
  id: 'sidebar', title: 'sidebar', default: DEFAULT_PREFS.sidebar.width, min: 200,
  max: (vp) => Math.min(480, vp.width - MAIN_MIN - RAIL),
  collapsible: true, collapsedSize: RAIL, collapseBelow: 140,
});

/** The side panel (artifacts, agents, details, plugin panels). */
export const SIDE_PANEL_PANE = registerPane({
  id: 'side-panel', title: 'side panel', min: 280,
  default: (vp) => Math.round(splitOpen() ? Math.min(420, vp.width * 0.32) : Math.min(520, vp.width * 0.42)),
  max: (vp) => vp.width - sidebarNow(vp) - MAIN_MIN - (splitOpen() ? SPLIT_PANE.min : 0),
});

/** The view beside the page (a linked conversation next to this one). */
export const SPLIT_PANE = registerPane({
  id: 'split', title: 'view beside', min: 320, step: 32,
  default: (vp) => Math.round((vp.width - sidebarNow(vp)) * 0.45),
  max: (vp) => vp.width - sidebarNow(vp) - MAIN_MIN - (panelOpen() ? shownOf(SIDE_PANEL_PANE, vp) : 0),
});

/** Dashboards: the inspector beside an edited dashboard, and the dataset list of the Data page. */
export const DASHBOARD_INSPECTOR_PANE = registerPane({ id: 'dashboards.inspector', title: 'inspector', default: 320, min: 260, max: 640, keep: 360 });
export const DATASETS_LIST_PANE = registerPane({ id: 'dashboards.datasets', title: 'dataset list', default: 256, min: 180, max: 480, keep: 320 });

// The packages' own panes, known before they are drawn.
registerPane(DIAGRAM_DETAILS_PANE);

/** The prefs as the pane store: written through setPrefs (saved by main), followed through the app store. */
export const layoutStore: PaneStore = {
  get(id) {
    const p = useApp.getState().prefs;
    if (id === 'sidebar') return { size: p.sidebar.width, collapsed: p.sidebar.collapsed };
    return p.panes?.[id];
  },
  set(id, patch) {
    const app = useApp.getState();
    const p = app.prefs;
    if (id === 'sidebar') {
      const next = patch === null ? { width: DEFAULT_PREFS.sidebar.width, collapsed: false } : { ...(patch.size !== undefined ? { width: patch.size } : {}), ...(patch.collapsed !== undefined ? { collapsed: patch.collapsed } : {}) };
      app.setPrefs({ sidebar: { ...p.sidebar, ...next } });
      return;
    }
    const merged: PaneState | null = patch === null ? null : { ...(p.panes?.[id] ?? {}), ...patch };
    const panes = { ...(p.panes ?? {}) } as Record<string, PaneState | null>;
    panes[id] = merged;
    // null tells main to forget the pane; the local copy drops it at once.
    app.setPrefs({ panes: panes as Record<string, PaneState> });
  },
  subscribe(fn) {
    let last = useApp.getState().prefs;
    return useApp.subscribe((s) => { if (s.prefs.panes !== last.panes || s.prefs.sidebar !== last.sidebar) { last = s.prefs; fn(); } });
  },
};
setPaneStore(layoutStore);

export type LayoutAction = 'list' | 'set' | 'reset' | 'collapse' | 'expand';

/**
 * The layout command (agents and the palette): list the panes, set one's size (clamped to its
 * bounds in this window), reset one (or, with no pane, all) to the default, collapse or expand one.
 */
export function layoutCommand(args: { action?: unknown; pane?: unknown; size?: unknown }, vp: Viewport = viewportNow()): unknown {
  const action = String(args.action ?? 'list') as LayoutAction;
  const known = paneSpecs().map((s) => s.id);
  if (action === 'list') return { panes: paneSpecs().map((s) => describePane(s, vp)) };
  const id = typeof args.pane === 'string' ? args.pane.trim() : '';
  if (action === 'reset' && !id) { for (const s of paneSpecs()) layoutStore.set(s.id, null); return 'Every pane is back to its default size.'; }
  const spec = paneSpec(id);
  if (!spec) throw new Error(`No pane "${id}". Panes: ${known.join(', ')}`);
  switch (action) {
    case 'set': {
      const n = Number(args.size);
      if (!Number.isFinite(n)) throw new Error('set needs size (px)');
      const size = clampPane(spec, n, vp);
      layoutStore.set(id, { size, ...(spec.collapsible ? { collapsed: false } : {}) });
      return size === Math.round(n) ? `The ${spec.title} is ${size}px.` : `The ${spec.title} is ${size}px (its bounds in this window are ${describePane(spec, vp).min}-${describePane(spec, vp).max}px).`;
    }
    case 'reset': layoutStore.set(id, null); return `The ${spec.title} is back to its default (${describePane(spec, vp).default}px).`;
    case 'collapse':
    case 'expand':
      if (!spec.collapsible) throw new Error(`The ${spec.title} does not collapse; set its size instead. Collapsible: ${paneSpecs().filter((s) => s.collapsible).map((s) => s.id).join(', ')}`);
      layoutStore.set(id, { collapsed: action === 'collapse' });
      return `The ${spec.title} is ${action === 'collapse' ? 'collapsed' : 'expanded'}.`;
    default: throw new Error('action is list, set, reset, collapse or expand');
  }
}
