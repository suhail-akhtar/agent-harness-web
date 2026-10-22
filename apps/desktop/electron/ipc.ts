/**
 * The window's requests to main, by channel prefix (each on the preload's allowlist):
 *   app:      who we are (product, versions, mode), data folder, start at login
 *   engine:   state, last log lines, restart
 *   prefs:    the machine-scope preferences
 *   win:      window controls and the title bar overlay colours
 *   dialog:   choose a folder or a file (native dialogs)
 *   shell:    open a link in the system browser (http(s) and mailto only), show a file
 *   clipboard:write text
 *   notify:   a native notification, only while the window is in the background
 *   plugins:  desktop dev plugins (UI only, from folders on this machine)
 *   grants:   frame plugins' capability grants, tied to their uiHash
 *   servers:  local engine or remote servers (tokens kept with the OS keychain via safeStorage)
 *   preview:  register an artifact page on the preview origin
 */

import { app, BrowserWindow, clipboard, dialog, Notification, powerSaveBlocker, safeStorage, shell } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DesktopContext } from './context';
import { JsonFile } from './store';
import { registerPreviewHtml, RUNTIME_URL } from './preview';
import type { Grants, GrantRecord } from '../shared/grants';
import type { RemoteServer } from '../shared/prefs';

const SAFE_EXTERNAL = /^(https?:\/\/|mailto:)/i;

export function registerIpc(ctx: DesktopContext): { grants: JsonFile<Grants> } {
  const h = ctx.handle;

  h('app:info', () => ({
    product: ctx.product,
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    packaged: app.isPackaged,
    dataDir: ctx.paths.dataDir,
    home: ctx.paths.home,
    scratch: ctx.paths.scratch,
    previewRuntime: RUNTIME_URL,
    server: ctx.prefs.get().servers.active,
    iconDataUrl: ctx.iconDataUrl(),
    ...(process.env.HARNESS_DESKTOP_TEST === '1' ? { test: true } : {}),
  }));
  h('app:openDataFolder', () => shell.openPath(ctx.paths.dataDir));
  h('app:setLoginItem', (on: boolean) => { try { app.setLoginItemSettings({ openAtLogin: !!on }); } catch { /* unsupported */ } return app.getLoginItemSettings().openAtLogin; });
  let sleepBlock: number | null = null;
  h('app:busy', (busy: boolean) => {
    const want = !!busy && ctx.prefs.get().preventSleep;
    if (want && sleepBlock === null) sleepBlock = powerSaveBlocker.start('prevent-app-suspension');
    if (!want && sleepBlock !== null) { powerSaveBlocker.stop(sleepBlock); sleepBlock = null; }
    return want;
  });
  h('app:relaunch', () => { app.relaunch(); ctx.quit(); });

  h('engine:status', () => ctx.engine().state);
  h('engine:logs', () => ctx.engine().recentLog());
  h('engine:restart', async () => { await ctx.engine().restart(); return ctx.engine().state; });

  h('prefs:get', () => ctx.prefs.get());
  h('prefs:set', (patch: Record<string, unknown>) => ctx.prefs.set(patch));

  h('win:minimize', () => ctx.window()?.minimize());
  h('win:toggleMaximize', () => { const w = ctx.window(); if (!w || ctx.quiet) return false; if (w.isMaximized()) w.unmaximize(); else w.maximize(); return w.isMaximized(); });
  h('win:close', () => ctx.window()?.close());
  h('win:isMaximized', () => ctx.window()?.isMaximized() ?? false);
  h('win:overlay', (o: { color?: string; symbolColor?: string }) => {
    const w = ctx.window();
    if (!w || process.platform === 'darwin') return;
    const hex = (s?: string) => (typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s) ? s : undefined);
    try { w.setTitleBarOverlay({ color: hex(o.color), symbolColor: hex(o.symbolColor), height: 40 }); } catch { /* no overlay on this platform */ }
    if (hex(o.color)) w.setBackgroundColor(hex(o.color)!);
  });

  h('dialog:openFolder', async (title?: string) => {
    const w = ctx.window();
    const r = w ? await dialog.showOpenDialog(w, { title: title ?? 'Open a folder', properties: ['openDirectory', 'createDirectory'] }) : await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });
  h('dialog:openFiles', async () => {
    const w = ctx.window();
    const r = w ? await dialog.showOpenDialog(w, { properties: ['openFile', 'multiSelections'] }) : await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
    if (r.canceled) return [];
    return r.filePaths.slice(0, 10).flatMap((p) => {
      try {
        const st = fs.statSync(p);
        if (st.size > 20 * 1024 * 1024) return [];
        return [{ name: path.basename(p), path: p, size: st.size, base64: fs.readFileSync(p).toString('base64') }];
      } catch { return []; }
    });
  });

  h('shell:openExternal', async (url: string) => {
    if (typeof url !== 'string' || !SAFE_EXTERNAL.test(url)) throw new Error('Only http(s) and mailto links open outside the app.');
    await shell.openExternal(url);
    return true;
  });
  h('shell:showItem', (p: string) => { if (typeof p === 'string' && path.isAbsolute(p)) shell.showItemInFolder(p); });

  h('clipboard:write', (text: string) => { clipboard.writeText(String(text ?? '').slice(0, 1_000_000)); return true; });

  h('notify:show', (n: { title: string; body?: string; route?: string; force?: boolean }) => {
    const w = ctx.window();
    if (!ctx.prefs.get().notifications || ctx.quiet) return false;
    // Nothing interrupts work: a notification only when the window is not in front.
    if (w && w.isFocused() && w.isVisible() && !n.force) return false;
    if (!Notification.isSupported()) return false;
    const note = new Notification({ title: String(n.title).slice(0, 120), body: String(n.body ?? '').slice(0, 300), silent: false });
    note.on('click', () => { ctx.reveal(); if (n.route) ctx.emit('notify:clicked', { route: n.route }); });
    note.show();
    if (w && !w.isFocused()) w.flashFrame(true);
    return true;
  });

  h('plugins:dev', () => ctx.devPlugins.load());
  h('plugins:devAdd', async () => {
    const w = ctx.window();
    const r = w ? await dialog.showOpenDialog(w, { title: 'Load a plugin folder (UI only)', properties: ['openDirectory'] }) : null;
    const dir = r && !r.canceled ? r.filePaths[0] : undefined;
    if (!dir) return null;
    if (!fs.existsSync(path.join(dir, 'harness-plugin.json'))) throw new Error('That folder has no harness-plugin.json.');
    const p = ctx.prefs.get();
    if (!p.devPlugins.includes(dir)) ctx.prefs.set({ devPlugins: [...p.devPlugins, dir] });
    return ctx.devPlugins.load();
  });
  h('plugins:devRemove', (dir: string) => { ctx.prefs.set({ devPlugins: ctx.prefs.get().devPlugins.filter((d) => d !== dir) }); return ctx.devPlugins.load(); });
  h('plugins:devToggle', (name: string, on: boolean) => {
    const d = new Set(ctx.prefs.get().disabledPlugins);
    if (on) d.delete(name); else d.add(name);
    ctx.prefs.set({ disabledPlugins: [...d] });
    return ctx.devPlugins.load();
  });

  const grants = new JsonFile<Grants>(path.join(ctx.paths.dataDir, 'plugin-grants.json'), () => ({}), (raw) => (raw && typeof raw === 'object' ? raw as Grants : {}));
  h('grants:get', () => grants.value);
  h('grants:set', (plugin: string, rec: GrantRecord) => {
    if (typeof plugin !== 'string' || !rec || typeof rec.uiHash !== 'string' || !Array.isArray(rec.capabilities)) throw new Error('bad grant');
    grants.set({ ...grants.value, [plugin]: { uiHash: rec.uiHash, capabilities: rec.capabilities.map(String) as GrantRecord['capabilities'], at: Date.now(), ...(rec.denied ? { denied: true } : {}) } }, true);
    return grants.value;
  });
  h('grants:revoke', (plugin: string) => { const g = { ...grants.value }; delete g[plugin]; grants.set(g, true); return g; });

  // Remote servers: the URL in prefs, the token encrypted with the OS keychain (safeStorage).
  const tokens = new JsonFile<Record<string, string>>(path.join(ctx.paths.dataDir, 'server-tokens.json'), () => ({}));
  const listServers = () => ({ active: ctx.prefs.get().servers.active, remote: ctx.prefs.get().servers.remote.map((s) => ({ ...s, hasToken: !!tokens.value[s.id] })), encryption: safeStorage.isEncryptionAvailable() });
  h('servers:list', listServers);
  h('servers:add', (s: { name: string; url: string; token: string }) => {
    let u: URL;
    try { u = new URL(String(s.url)); } catch { throw new Error('That is not a server address.'); }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && /^(127\.|localhost$|\[::1\])/.test(u.hostname))) throw new Error('Use https (http only for this computer).');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('This system cannot encrypt the token (no keychain); it is not stored.');
    const id = crypto.randomBytes(6).toString('hex');
    const server: RemoteServer = { id, name: String(s.name || u.host).slice(0, 60), url: u.origin };
    tokens.set({ ...tokens.value, [id]: safeStorage.encryptString(String(s.token)).toString('base64') }, true);
    ctx.prefs.set({ servers: { ...ctx.prefs.get().servers, remote: [...ctx.prefs.get().servers.remote, server] } });
    return listServers();
  });
  h('servers:remove', async (id: string) => {
    const t = { ...tokens.value }; delete t[id]; tokens.set(t, true);
    const p = ctx.prefs.get().servers;
    ctx.prefs.set({ servers: { active: p.active === id ? 'local' : p.active, remote: p.remote.filter((s) => s.id !== id) } });
    if (p.active === id) await ctx.useServer('local');
    return listServers();
  });
  h('servers:use', async (id: string) => { await ctx.useServer(id); return listServers(); });

  h('preview:register', (html: string) => registerPreviewHtml(html));

  return { grants };
}

/** The decrypted token of a remote server (main only). */
export function serverToken(dataDir: string, id: string): string | null {
  try {
    const t = JSON.parse(fs.readFileSync(path.join(dataDir, 'server-tokens.json'), 'utf8')) as Record<string, string>;
    return t[id] ? safeStorage.decryptString(Buffer.from(t[id]!, 'base64')) : null;
  } catch { return null; }
}

export function allWindows(): BrowserWindow[] { return BrowserWindow.getAllWindows(); }
