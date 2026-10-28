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
import { reloadInEngine } from './dev-watch';
import { unpack } from '../../../src/plugins/archive';
import { loadTrustedKeys, SIG_FILE, verifyPlugin } from '../../../src/plugins/signing';
import type { PickedBundle, PickedPlugin } from '../shared/bundle-pick';
import os from 'node:os';
import type { Grants, GrantRecord } from '../shared/grants';
import type { RemoteServer } from '../shared/prefs';

const SAFE_EXTERNAL = /^(https?:\/\/|mailto:)/i;

/** The plugin folder has server code (a "main"): its tools and routes run in the engine. */
function hasServerCode(dir: string): boolean {
  try { return !!JSON.parse(fs.readFileSync(path.join(dir, 'harness-plugin.json'), 'utf8')).main; } catch { return false; }
}

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

  h('win:openPlugin', (name: string) => ctx.openPluginWindow(String(name)));
  h('win:revealMain', () => ctx.reveal());
  h('plugins:shortcut', (name: string, title: string) => ctx.pluginShortcut(String(name), String(title ?? name)));
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
  // Saves text the window made (a conversation as Markdown or plain text) where the person picks.
  h('dialog:saveText', async (fileName: string, text: string, kind?: string) => {
    const w = ctx.window();
    const ext = kind === 'txt' ? 'txt' : 'md';
    const name = path.basename(String(fileName)).replace(/[^\w .@()-]/g, '_') || `conversation.${ext}`;
    const opts = { title: 'Export the conversation', defaultPath: path.join(app.getPath('documents'), name), filters: [ext === 'md' ? { name: 'Markdown', extensions: ['md'] } : { name: 'Text', extensions: ['txt'] }] };
    const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, String(text), 'utf8');
    return r.filePath;
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
  // Picks a plugin folder (the window reviews it before it is loaded: plugins:devAdd with the folder).
  h('plugins:pickFolder', async () => {
    const w = ctx.window();
    const r = w ? await dialog.showOpenDialog(w, { title: 'Load a plugin folder', properties: ['openDirectory'] }) : null;
    const dir = r && !r.canceled ? r.filePaths[0] : undefined;
    if (dir && !fs.existsSync(path.join(dir, 'harness-plugin.json'))) throw new Error('That folder has no harness-plugin.json.');
    return dir ?? null;
  });
  h('plugins:devAdd', async (picked?: string) => {
    const w = ctx.window();
    const r = picked ? null : w ? await dialog.showOpenDialog(w, { title: 'Load a plugin folder', properties: ['openDirectory'] }) : null;
    const dir = picked ?? (r && !r.canceled ? r.filePaths[0] : undefined);
    if (!dir) return null;
    if (!fs.existsSync(path.join(dir, 'harness-plugin.json'))) throw new Error('That folder has no harness-plugin.json.');
    const p = ctx.prefs.get();
    if (!p.devPlugins.includes(dir)) ctx.prefs.set({ devPlugins: [...p.devPlugins, dir] });
    const list = ctx.devPlugins.load();
    // Server code (tools, routes): the engine loads it now, without a restart (and at every start after).
    if (hasServerCode(dir)) {
      const name = list.find((x) => x.dir === dir)?.name ?? path.basename(dir);
      const r = await reloadInEngine(await ctx.engine().ready(30_000).catch(() => null), name, dir);
      if (!r.ok) throw new Error(`The plugin's pages are loaded, but its server code did not load: ${r.error}`);
    }
    ctx.devWatch?.sync();
    return list;
  });
  // A plugin bundle (.tgz, from Plugins > Export on another computer or server): unpacked to a staging folder,
  // reviewed by the window, then moved into place and loaded like a folder (plugins:importCommit).
  const imported = () => path.join(app.getPath('userData'), 'imported-plugins');
  h('plugins:importFile', async () => {
    const w = ctx.window();
    const opts = { title: 'Import a plugin', properties: ['openFile' as const], filters: [{ name: 'Plugin bundle', extensions: ['tgz', 'gz'] }] };
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
    const file = r.canceled ? undefined : r.filePaths[0];
    if (!file) return null;
    if (fs.statSync(file).size > 50 * 1024 * 1024) throw new Error('The bundle is larger than 50 MB.');
    const staging = path.join(imported(), '.staging', `${Date.now()}`);
    fs.mkdirSync(path.dirname(staging), { recursive: true });
    try {
      await unpack(fs.readFileSync(file), staging);
      const m = JSON.parse(fs.readFileSync(path.join(staging, 'harness-plugin.json'), 'utf8')) as { name?: unknown; version?: unknown };
      if (typeof m.name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(m.name)) throw new Error('its harness-plugin.json has no valid name');
      return { dir: staging, name: m.name, version: typeof m.version === 'string' ? m.version : '0.0.0' };
    } catch (e) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw new Error(`Not a plugin bundle: ${(e as Error).message}`);
    }
  });
  // Install from a file: a plugin's bundle or a whole solution's, read here first (what is in it, who signed it),
  // then installed into the engine by the window (POST /api/plugins/import), where it is checked again.
  h('plugins:pickBundle', async (): Promise<PickedBundle | null> => {
    const w = ctx.window();
    const opts = { title: 'Install a plugin or a solution', properties: ['openFile' as const], filters: [{ name: 'Plugin or solution', extensions: ['tgz', 'gz'] }] };
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
    const file = r.canceled ? undefined : r.filePaths[0];
    if (!file) return null;
    if (fs.statSync(file).size > 50 * 1024 * 1024) throw new Error('The file is larger than 50 MB.');
    const data = fs.readFileSync(file);
    const top = fs.mkdtempSync(path.join(os.tmpdir(), 'hx-pick-'));
    // unpack makes the folder it unpacks into.
    const tmp = path.join(top, 'bundle');
    try {
      try { await unpack(data, tmp); } catch (e) { throw new Error(`Not a plugin or solution file: ${(e as Error).message}`); }
      const keys = (await Promise.all(ctx.publisherKeys.map((k) => loadTrustedKeys(k).catch(() => [])))).flat();
      const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, unknown>;
      const one = async (dir: string): Promise<PickedPlugin> => {
        if (!fs.existsSync(path.join(dir, 'harness-plugin.json'))) throw new Error(`Not a plugin or solution file: no harness-plugin.json in ${path.relative(tmp, dir) || 'its top'}`);
        const m = read(path.join(dir, 'harness-plugin.json')) as { name?: string; version?: string; displayName?: string; description?: string; publisher?: { name?: string } | string; ui?: { displayName?: string } };
        if (typeof m.name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(m.name)) throw new Error('Not a plugin or solution file: a harness-plugin.json has no valid name');
        const signed = fs.existsSync(path.join(dir, SIG_FILE));
        const v = signed && keys.length ? await verifyPlugin(dir, keys) : null;
        const known = !!v && (v.ok || (!!v.keyId && keys.some((k) => k.keyId === v.keyId)));
        const publisher = typeof m.publisher === 'string' ? m.publisher : m.publisher?.name;
        return {
          name: m.name, version: typeof m.version === 'string' ? m.version : '0.0.0',
          ...(m.displayName ?? m.ui?.displayName ? { displayName: m.displayName ?? m.ui?.displayName } : {}),
          ...(typeof m.description === 'string' ? { description: m.description } : {}), ...(publisher ? { publisher } : {}),
          signature: v?.ok ? 'verified' : known ? 'changed' : signed ? 'signed' : 'unsigned', ...(v?.ok ? { signedBy: v.keyName } : {}),
        };
      };
      const solFile = path.join(tmp, 'harness-solution.json');
      if (fs.existsSync(solFile)) {
        const s = read(solFile) as { title?: string; name?: string; version?: string; description?: string; publisher?: { name?: string }; license?: string; engines?: { harness?: string }; plugins?: string[] };
        if (!Array.isArray(s.plugins) || !s.plugins.length) throw new Error('Not a solution file: its harness-solution.json names no plugins');
        const plugins = await Promise.all(s.plugins.map((p) => one(path.join(tmp, 'plugins', String(p)))));
        return {
          file: path.basename(file), base64: data.toString('base64'), kind: 'solution', title: String(s.title ?? s.name), version: String(s.version ?? '0.0.0'),
          ...(s.description ? { description: s.description } : {}), ...(s.publisher?.name ? { publisher: s.publisher.name } : {}), ...(s.license ? { license: s.license } : {}),
          ...(s.engines?.harness ? { harness: s.engines.harness } : {}), plugins,
        };
      }
      const p = await one(tmp);
      const m = read(path.join(tmp, 'harness-plugin.json')) as { license?: string; engines?: { harness?: string } };
      return { file: path.basename(file), base64: data.toString('base64'), kind: 'plugin', title: p.displayName ?? p.name, version: p.version, ...(p.description ? { description: p.description } : {}), ...(p.publisher ? { publisher: p.publisher } : {}), ...(m.license ? { license: m.license } : {}), ...(m.engines?.harness ? { harness: m.engines.harness } : {}), plugins: [p] };
    } finally { fs.rmSync(top, { recursive: true, force: true }); }
  });
  h('plugins:importCommit', (staging: string) => {
    const root = path.join(imported(), '.staging');
    const from = path.resolve(String(staging));
    if (path.dirname(from) !== root || !fs.existsSync(from)) throw new Error('No imported bundle there.');
    const m = JSON.parse(fs.readFileSync(path.join(from, 'harness-plugin.json'), 'utf8')) as { name: string };
    const dest = path.join(imported(), m.name);
    // A newer version of one imported before replaces it (it reloads in place).
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(from, dest);
    return dest;
  });
  h('plugins:importCancel', (staging: string) => {
    const from = path.resolve(String(staging));
    if (path.dirname(from) === path.join(imported(), '.staging')) fs.rmSync(from, { recursive: true, force: true });
  });
  // Saves a plugin bundle the window fetched from the server (Plugins > Export).
  h('plugins:saveBundle', async (fileName: string, base64: string) => {
    const w = ctx.window();
    const name = path.basename(String(fileName)).replace(/[^\w.@-]/g, '_') || 'plugin.tgz';
    const opts = { title: 'Export the plugin', defaultPath: path.join(app.getPath('downloads'), name), filters: [{ name: 'Plugin bundle', extensions: ['tgz'] }] };
    const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, Buffer.from(String(base64), 'base64'));
    return r.filePath;
  });
  h('plugins:devRemove', async (dir: string) => { ctx.prefs.set({ devPlugins: ctx.prefs.get().devPlugins.filter((d) => d !== dir) }); ctx.devWatch?.sync(); if (hasServerCode(dir)) await ctx.engine().restart(); return ctx.devPlugins.load(); });
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
