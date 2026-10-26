/**
 * The shell's own state: prefs, engine, the router (a view reference plus params, with back and
 * forward), the overlays (palette, settings, side panel, dialogs) and live values (badges).
 */

import type React from 'react';
import { create } from 'zustand';
import { DEFAULT_PREFS, type DesktopPrefs } from '@desk/prefs';
import { desktop, type AppInfo, type EngineState } from '../bridge';
import type { ArtifactKind } from '@harness/ui';

export interface Route { view: string; params?: Record<string, string> }
export type SidePanel =
  | { kind: 'plugin'; panel: string; params?: Record<string, string>; /** Structured input for a native panel (the details of a selected node, say). */ data?: unknown }
  | { kind: 'artifact'; title: string; artifact: ArtifactKind; source: string; language: string }
  | { kind: 'file'; title: string; path: string; sessionId: string; content: string };

export interface Confirm { title: string; body: string; confirmLabel?: string; danger?: boolean; resolve: (yes: boolean) => void }

/** Where the page on screen sits: an optional parent (a page it belongs to) and its own title. */
export interface Crumb { view: string; title?: string; parent?: { label: string; route?: Route } }

export interface AppState {
  info: AppInfo | null;
  prefs: DesktopPrefs;
  engine: EngineState;
  route: Route;
  back: Route[];
  forward: Route[];
  paletteOpen: boolean;
  settingsSection: string | null;
  panel: SidePanel | null;
  badges: Record<string, unknown>;
  prefill: { text: string; newChat?: boolean; nonce: number } | null;
  workflowDialog: { sessionId?: string; workflow?: string; input?: Record<string, string> } | null;
  confirm: Confirm | null;
  onboardingOpen: boolean;
  focused: boolean;
  /** A second view beside the first (a linked conversation next to this one); its width is the 'split' pane's (state/layout.ts). */
  split: Route | null;
  /** What the page on screen says about itself (breadcrumbs). */
  crumb: Crumb | null;
  /** The floating sidebar of a narrow window is open. */
  narrowSidebarOpen: boolean;
  /** Something shown over the whole window (an artifact opened in full window). */
  fullWindow: { title: string; body: React.ReactNode } | null;
  /** The keyboard shortcuts sheet. */
  shortcutsOpen: boolean;
  navigate(r: Route, opts?: { replace?: boolean }): void;
  goBack(): void;
  goForward(): void;
  setPrefs(patch: Partial<DesktopPrefs>): void;
  setBadge(name: string, value: unknown): void;
  openSettings(section?: string): void;
  ask(c: Omit<Confirm, 'resolve'>): Promise<boolean>;
}

export const HOME: Route = { view: 'core.chat:home' };
/**
 * A window focused on one plugin (the plugin opened as its own app: ?focus=<name>): its menu is the first
 * group, it opens on the plugin's home and carries its name; every other plugin and core service is there too.
 */
export const FOCUS: string | undefined = (() => { try { return new URLSearchParams(location.search).get('focus') || undefined; } catch { return undefined; } })();
/** Below this width the sidebar is a rail that floats open over the page. */
export const NARROW_PX = 760;
const same = (a: Route, b: Route) => a.view === b.view && JSON.stringify(a.params ?? {}) === JSON.stringify(b.params ?? {});

function initialRoute(): Route {
  try { const r = JSON.parse(sessionStorage.getItem('harness.route') ?? 'null') as Route | null; if (r && typeof r.view === 'string') return r; } catch { /* none */ }
  return HOME;
}

export const useApp = create<AppState>((set, get) => ({
  info: null,
  prefs: DEFAULT_PREFS,
  engine: { status: 'starting', attempt: 1 },
  route: initialRoute(),
  back: [],
  forward: [],
  paletteOpen: false,
  settingsSection: null,
  panel: null,
  badges: {},
  prefill: null,
  workflowDialog: null,
  confirm: null,
  onboardingOpen: false,
  focused: true,
  split: null,
  crumb: null,
  narrowSidebarOpen: false,
  fullWindow: null,
  shortcutsOpen: false,
  navigate(r, opts) {
    const cur = get().route;
    if (same(cur, r)) return;
    try { sessionStorage.setItem('harness.route', JSON.stringify(r)); } catch { /* private mode */ }
    set(opts?.replace ? { route: r } : { route: r, back: [...get().back.slice(-49), cur], forward: [] });
  },
  goBack() {
    const b = get().back;
    if (!b.length) return;
    const prev = b[b.length - 1]!;
    set({ route: prev, back: b.slice(0, -1), forward: [get().route, ...get().forward] });
  },
  goForward() {
    const f = get().forward;
    if (!f.length) return;
    set({ route: f[0]!, forward: f.slice(1), back: [...get().back, get().route] });
  },
  setPrefs(patch) {
    set({ prefs: { ...get().prefs, ...patch } as DesktopPrefs });
    void desktop.setPrefs(patch).then((p) => set({ prefs: p })).catch(() => {});
  },
  setBadge(name, value) { if (get().badges[name] !== value) set({ badges: { ...get().badges, [name]: value } }); },
  openSettings(section) { set({ settingsSection: section ?? 'core.settings:appearance' }); },
  ask(c) { return new Promise((resolve) => set({ confirm: { ...c, resolve: (yes) => { set({ confirm: null }); resolve(yes); } } })); },
}));

export const navigate = (r: Route, opts?: { replace?: boolean }) => useApp.getState().navigate(r, opts);
export const openSession = (id: string) => navigate({ view: 'core.chat:session', params: { id } });
export function prefill(text: string, newChat?: boolean) {
  useApp.setState({ prefill: { text, newChat, nonce: Date.now() } });
  if (newChat) navigate(HOME);
}

/** Opens a plugin's side panel (a qualified id), with params and, for a native panel, structured data. */
export function openPluginPanel(panel: string, params?: Record<string, string>, data?: unknown): void {
  useApp.setState({ panel: { kind: 'plugin', panel, ...(params ? { params } : {}), ...(data !== undefined ? { data } : {}) } });
}

/** Opens a view beside the current page (split view); null closes it. */
export function openSplit(r: Route | null): void { useApp.setState({ split: r }); }

/** A page says where it is (breadcrumbs): its title and the page it belongs to. Cleared when another page shows. */
export function setCrumb(c: Crumb | null): void {
  const cur = useApp.getState().crumb;
  if (JSON.stringify(cur) !== JSON.stringify(c)) useApp.setState({ crumb: c });
}

/** Shows something over the whole window (Escape closes it). */
export function showFullWindow(title: string, body: React.ReactNode): void { useApp.setState({ fullWindow: { title, body } }); }
