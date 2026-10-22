/**
 * The typed surface over the preload's bridge (window.harnessDesktop). Outside Electron (a test
 * page, a browser) every call fails softly, so components still render.
 */

import type { DesktopPrefs } from '@desk/prefs';
import type { ProductProfile } from '@desk/product';
import type { Grants, GrantRecord } from '@desk/grants';

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

export interface AppInfo { product: ProductProfile; version: string; electron: string; chrome: string; node: string; platform: string; packaged: boolean; dataDir: string; scratch: string; previewRuntime: string; server: string }
export interface DevPluginInfo { name: string; version: string; description?: string; dir: string; ui?: import('@harness/plugin-ui').UiManifest; uiError?: string; uiHash?: string; enabled: boolean; source: 'dev' }
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
  notify: (n: { title: string; body?: string; route?: string }) => invoke<boolean>('notify:show', n).catch(() => false),
  devPlugins: () => invoke<DevPluginInfo[]>('plugins:dev').catch(() => [] as DevPluginInfo[]),
  addDevPlugin: () => invoke<DevPluginInfo[] | null>('plugins:devAdd'),
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
};
