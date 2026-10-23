/**
 * The desktop's machine-scope preferences (the prefs file in the app's data folder): what a person
 * set on this computer. Account settings live on the server; operator policy is the server's too.
 * Shared by main (which owns the file) and the renderer (which reads and patches it over IPC).
 */

export interface WindowBounds { x?: number; y?: number; width: number; height: number; maximized: boolean }
export interface ProjectRef { path: string; name: string; addedAt: number; pinned?: boolean }
export interface RemoteServer { id: string; name: string; url: string; hasToken?: boolean }

export interface DesktopPrefs {
  /** 'system', 'light', 'dark' or a plugin theme id ("<plugin>:<id>"). */
  theme: string;
  /** Overrides the built-in themes' accent (empty: the product's). */
  accent: string;
  contrast: 'normal' | 'strong';
  density: 'comfortable' | 'compact';
  fontSize: number;
  uiFont: string;
  codeFont: string;
  transcriptWidth: 'normal' | 'wide' | 'full';
  motion: 'system' | 'reduced';
  sendKey: 'enter' | 'mod-enter';
  /** Tool steps under "Worked for ...": folded or open. */
  steps: 'collapsed' | 'expanded';
  notifications: boolean;
  startAtLogin: boolean;
  keepInTray: boolean;
  preventSleep: boolean;
  window: WindowBounds;
  sidebar: { collapsed: boolean; width: number; showArchived: boolean };
  /** Resizable panes other than the sidebar: pane id -> its size (px) and whether it is collapsed (absent: the default). */
  panes: Record<string, { size?: number; collapsed?: boolean }>;
  /** The sidebar's plugin groups: the person's order (plugin names) and which are folded. */
  menus: { order: string[]; collapsed: Record<string, boolean> };
  projects: ProjectRef[];
  defaultModel: string;
  defaultEffort: string;
  defaultMode: string;
  /** Command id -> key chord; overrides the contributed defaults ("" unbinds). */
  keybindings: Record<string, string>;
  servers: { active: string; remote: RemoteServer[] };
  /** Folders of UI-only plugins loaded by the desktop itself (plugin development). */
  devPlugins: string[];
  /** Plugins switched off on this machine when the server cannot (UI-only dev plugins). */
  disabledPlugins: string[];
  onboardingDone: boolean;
  /** Settings sections with scope "app": plugin -> values. */
  pluginSettings: Record<string, Record<string, unknown>>;
  /** Composer chip values by setting key ("<plugin>.<key>"). */
  chips: Record<string, unknown>;
}

export const DEFAULT_PREFS: DesktopPrefs = {
  theme: 'system',
  accent: '',
  contrast: 'normal',
  density: 'comfortable',
  fontSize: 14,
  uiFont: "'Inter', 'Segoe UI Variable', 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif",
  codeFont: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
  transcriptWidth: 'normal',
  motion: 'system',
  sendKey: 'enter',
  steps: 'collapsed',
  notifications: true,
  startAtLogin: false,
  keepInTray: false,
  preventSleep: false,
  window: { width: 1280, height: 820, maximized: false },
  sidebar: { collapsed: false, width: 272, showArchived: false },
  panes: {},
  menus: { order: [], collapsed: {} },
  projects: [],
  defaultModel: '',
  defaultEffort: '',
  defaultMode: 'default',
  keybindings: {},
  servers: { active: 'local', remote: [] },
  devPlugins: [],
  disabledPlugins: [],
  onboardingDone: false,
  pluginSettings: {},
  chips: {},
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Merges a patch into prefs, keeping only known keys of the right type (a bad file or a bad patch cannot break the app). */
export function mergePrefs(base: DesktopPrefs, patch: unknown): DesktopPrefs {
  const out = structuredClone(base) as unknown as Record<string, unknown>;
  if (!isObj(patch)) return out as unknown as DesktopPrefs;
  const def = DEFAULT_PREFS as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in def) || v === undefined) continue;
    const d = def[k];
    if (Array.isArray(d)) { if (Array.isArray(v)) out[k] = structuredClone(v); continue; }
    if (isObj(d)) {
      if (!isObj(v)) continue;
      // Open maps (keybindings, pluginSettings, chips) take any keys; fixed shapes keep theirs.
      const open = Object.keys(d).length === 0;
      out[k] = open ? { ...(out[k] as object), ...structuredClone(v) } : { ...(out[k] as object), ...Object.fromEntries(Object.entries(v).filter(([kk, vv]) => kk in d || k === 'window' ? vv !== undefined : false)) };
      continue;
    }
    if (typeof v === typeof d) out[k] = v;
  }
  const p = out as unknown as DesktopPrefs;
  p.fontSize = Math.min(20, Math.max(11, Math.round(p.fontSize)));
  p.sidebar.width = Math.min(480, Math.max(200, Math.round(p.sidebar.width)));
  p.panes = Object.fromEntries(Object.entries(isObj(p.panes) ? p.panes : {}).flatMap(([k, v]) => {
    if (!/^[a-z0-9][a-z0-9._:-]{0,79}$/i.test(k) || !isObj(v)) return [];
    const one: { size?: number; collapsed?: boolean } = {};
    if (typeof v.size === 'number' && Number.isFinite(v.size) && v.size >= 0 && v.size <= 10_000) one.size = Math.round(v.size);
    if (typeof v.collapsed === 'boolean') one.collapsed = v.collapsed;
    return Object.keys(one).length ? [[k, one]] : [];
  }).slice(0, 100));
  const order = Array.isArray(p.menus.order) ? p.menus.order : [];
  const folded = isObj(p.menus.collapsed) ? p.menus.collapsed : {};
  p.menus = { order: [...new Set(order.filter((x): x is string => typeof x === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(x)))].slice(0, 200), collapsed: Object.fromEntries(Object.entries(folded).filter(([k, v]) => typeof v === 'boolean' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(k)).slice(0, 200)) };
  return p;
}

/** The name a folder gets in the project list. */
export function projectName(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
