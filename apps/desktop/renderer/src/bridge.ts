/**
 * The typed surface over the preload's bridge (window.harnessDesktop). Outside Electron (a test
 * page, a browser) every call fails softly, so components still render.
 */

import type { DesktopPrefs } from '@desk/prefs';
import type { ProductProfile } from '@desk/product';
import type { Grants, GrantRecord } from '@desk/grants';
import type { PickedBundle } from '@desk/bundle-pick';
export type { PickedBundle, PickedPlugin } from '@desk/bundle-pick';

interface Bridge {
  platform: string;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, fn: (payload: unknown) => void): () => void;
  pathForFile(f: File): string;
}

const raw = (globalThis as unknown as { harnessDesktop?: Bridge }).harnessDesktop;
export const inDesktop = !!raw;
export const platform = raw?.platform ?? (navigator.platform.toLowerCase().includes('mac') ? 'darwin' : navigator.platform.toLowerCase().includes('win') ? 'win32' : 'linux');

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  if (!raw) return Promise.reject(new Error('not running in the desktop app'));
  return raw.invoke(channel, ...args) as Promise<T>;
}
export function on<T = unknown>(channel: string, fn: (payload: T) => void): () => void {
  if (!raw) return () => {};
  return raw.on(channel, fn as (p: unknown) => void);
}

export type EngineState =
  | { status: 'starting'; attempt: number }
  | { status: 'ready'; origin: string; startedAt: number; remote?: boolean }
  | { status: 'crashed'; message: string; attempt: number; retryInMs: number }
  | { status: 'stopped'; message?: string };

export interface AppInfo { product: ProductProfile; version: string; electron: string; chrome: string; node: string; platform: string; packaged: boolean; dataDir: string; /** The harness home (~/.harness). */ home?: string; /** The home's tmp folder (each scratch conversation gets a folder in it). */ scratch: string; previewRuntime: string; server: string; /** The product's icon (96 px). */ iconDataUrl?: string; /** Driven by the end-to-end tests (the window is never shown). */ test?: boolean }
export interface DevPluginInfo { name: string; version: string; description?: string; dir: string; ui?: import('@harness/plugin-ui').UiManifest; uiError?: string; uiHash?: string; enabled: boolean; source: 'dev' }
export interface HomeFolder { key: string; label: string; path: string; note: string; bytes: number; files: number }
export interface HomeInfo { home: string; settingsFile: string; tmpCleanupDays: number; folders: HomeFolder[]; oldCopy?: string; migration?: string; dataOutside?: boolean }
export interface ServersInfo { active: string; remote: Array<{ id: string; name: string; url: string; hasToken?: boolean }>; encryption: boolean }

export const desktop = {
  info: () => invoke<AppInfo>('app:info'),
  openDataFolder: () => invoke<void>('app:openDataFolder'),
  setLoginItem: (on: boolean) => invoke<boolean>('app:setLoginItem', on),
  busy: (b: boolean) => invoke<boolean>('app:busy', b).catch(() => false),
  relaunch: () => invoke<void>('app:relaunch'),
  engineStatus: () => invoke<EngineState>('engine:status'),
  engineLogs: () => invoke<string[]>('engine:logs'),
  engineRestart: () => invoke<EngineState>('engine:restart'),
  prefs: () => invoke<DesktopPrefs>('prefs:get'),
  setPrefs: (patch: Partial<DesktopPrefs>) => invoke<DesktopPrefs>('prefs:set', patch),
  minimize: () => invoke<void>('win:minimize'),
  toggleMaximize: () => invoke<boolean>('win:toggleMaximize'),
  close: () => invoke<void>('win:close'),
  overlay: (color: string, symbolColor: string) => invoke<void>('win:overlay', { color, symbolColor }).catch(() => {}),
  openFolder: (title?: string) => invoke<string | null>('dialog:openFolder', title),
  openFiles: () => invoke<Array<{ name: string; path: string; size: number; base64: string }>>('dialog:openFiles'),
  openExternal: (url: string) => invoke<boolean>('shell:openExternal', url),
  showItem: (p: string) => invoke<void>('shell:showItem', p),
  clipboard: (text: string) => invoke<boolean>('clipboard:write', text),
  /** force: shown even while the window is in front (an agent's desktop_notify). */
  notify: (n: { title: string; body?: string; route?: string; force?: boolean }) => invoke<boolean>('notify:show', n).catch(() => false),
  /** Editing in the focused window, for the right-click menu (electron/edit.ts). */
  edit: {
    do: (what: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'pasteAndMatchStyle' | 'selectAll' | 'delete') => invoke<boolean>('edit:do', what).catch(() => false),
    spelling: () => invoke<{ word: string; suggestions: string[] } | null>('edit:spelling').catch(() => null),
    replaceMisspelling: (word: string) => invoke<boolean>('edit:replaceMisspelling', word),
    addToDictionary: (word: string) => invoke<boolean>('edit:addToDictionary', word),
    copyImageAt: (x: number, y: number) => invoke<boolean>('edit:copyImageAt', x, y),
    saveImage: (url: string) => invoke<boolean>('edit:saveImage', url),
  },
  devPlugins: () => invoke<DevPluginInfo[]>('plugins:dev').catch(() => [] as DevPluginInfo[]),
  pickPluginFolder: () => invoke<string | null>('plugins:pickFolder'),
  /** Opens a plugin as its own app: a window focused on it (every core service and plugin still there). */
  openPluginWindow: (name: string) => invoke<void>('win:openPlugin', name),
  /** Shows the main window (from a window focused on a plugin). */
  revealMain: () => invoke<void>('win:revealMain'),
  /** A shortcut on the desktop (and the Start menu on Windows) that opens the app focused on the plugin. */
  pluginShortcut: (name: string, title: string) => invoke<{ ok: boolean; path?: string; reason?: string }>('plugins:shortcut', name, title),
  /** Picks a plugin bundle (.tgz) and unpacks it to a staging folder for review; then importCommit (or importCancel). */
  importPluginFile: () => invoke<{ dir: string; name: string; version: string } | null>('plugins:importFile'),
  /** Picks a plugin's or a solution's file to install into the engine: its bytes and what is in it (signatures checked). */
  pickBundle: () => invoke<PickedBundle | null>('plugins:pickBundle'),
  /** Moves a reviewed bundle into place; returns its folder (load it with addDevPlugin). */
  importCommit: (staging: string) => invoke<string>('plugins:importCommit', staging),
  importCancel: (staging: string) => invoke<void>('plugins:importCancel', staging).catch(() => {}),
  /** Saves a plugin bundle (Export): the save dialog; the path saved to, or null. */
  saveBundle: (fileName: string, base64: string) => invoke<string | null>('plugins:saveBundle', fileName, base64),
  addDevPlugin: (dir?: string) => invoke<DevPluginInfo[] | null>('plugins:devAdd', ...(dir ? [dir] : [])),
  removeDevPlugin: (dir: string) => invoke<DevPluginInfo[]>('plugins:devRemove', dir),
  toggleDevPlugin: (name: string, on: boolean) => invoke<DevPluginInfo[]>('plugins:devToggle', name, on),
  grants: () => invoke<Grants>('grants:get').catch(() => ({} as Grants)),
  setGrant: (plugin: string, rec: GrantRecord) => invoke<Grants>('grants:set', plugin, rec),
  revokeGrant: (plugin: string) => invoke<Grants>('grants:revoke', plugin),
  servers: () => invoke<ServersInfo>('servers:list'),
  addServer: (s: { name: string; url: string; token: string }) => invoke<ServersInfo>('servers:add', s),
  removeServer: (id: string) => invoke<ServersInfo>('servers:remove', id),
  useServer: (id: string) => invoke<ServersInfo>('servers:use', id),
  registerPreview: (html: string) => invoke<{ url: string }>('preview:register', html),
  addProject: (dir: string) => invoke<DesktopPrefs['projects']>('projects:add', dir),
  removeProject: (dir: string) => invoke<DesktopPrefs['projects']>('projects:remove', dir),
  pathForFile: (f: File) => raw?.pathForFile(f) ?? '',
  /** A new project folder in the home's workspaces, added to the projects. */
  createProject: (name: string) => invoke<{ path: string; projects: DesktopPrefs['projects'] }>('projects:create', name),
  /** A new scratch folder under the home's tmp/ (one per scratch conversation). */
  newScratch: () => invoke<string>('home:scratch'),
  homeInfo: () => invoke<HomeInfo>('home:info'),
  openHomeFolder: (key: string) => invoke<string>('home:open', key),
  setTmpDays: (days: number) => invoke<number>('home:setTmpDays', days),
  cleanTmp: () => invoke<{ removed: string[]; kept: number; errors: string[] }>('home:cleanTmp'),
  chooseHomeFolder: () => invoke<string | null>('home:chooseFolder'),
  moveHome: (to: string) => invoke<{ moved: { home: string; old: string; files: number; bytes: number; sessionsRebased: number }; info: HomeInfo }>('home:move', to),
  removeOldHome: () => invoke<HomeInfo>('home:removeOld'),
};

/** A folder for a new scratch conversation: a fresh one under the home's tmp/ (the tmp folder itself outside the app). */
export async function scratchFolder(fallback?: string): Promise<string | undefined> {
  try { return await desktop.newScratch(); } catch { return fallback; }
}
