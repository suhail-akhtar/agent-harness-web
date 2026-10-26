/**
 * Harness Desktop: the Electron main process.
 *
 * Starts the engine (the harness server) in a utility process - or connects to a remote server -
 * serves the interface from harness://app/ with the API proxied behind it, and owns the window,
 * the tray, notifications, deep links, prefs and plugin grants. Everything a person sees is drawn
 * by the renderer from plugins; main names no feature.
 */

import { app, BrowserWindow, Menu, nativeImage, nativeTheme, screen, session, shell, Tray } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { EngineHost, RemoteEndpoint, type Engine } from './engine-host';
import { handleProtocol, registerSchemePrivileges } from './protocol';
import { APP_ORIGIN, PREVIEW_ORIGIN, parseDeepLink, SCHEME } from './policy';
import { PrefsStore } from './store';
import { makeHandle, type DesktopContext } from './context';
import { registerIpc, serverToken } from './ipc';
import { DevPlugins } from './dev-plugins';
import { DevWatch } from './dev-watch';
import { normaliseProduct, type ProductProfile } from '../shared/product';
import { projectName } from '../shared/prefs';
import { desktopRoots, engineLogFile, migrateEngineData, registerHomeIpc, resolveDesktopHome } from './home';

const distDir = __dirname;
const desktopDir = path.resolve(distDir, '..');
const repoGuess = path.resolve(desktopDir, '..', '..');
const repoRoot = !app.isPackaged && fs.existsSync(path.join(repoGuess, 'src', 'server', 'main.ts')) ? repoGuess : null;

// ---- the product profile: name, app id, brand ----
function loadProduct(): ProductProfile {
  const candidates = [process.env.HARNESS_PRODUCT, app.isPackaged ? path.join(process.resourcesPath, 'product.json') : undefined, repoRoot ? path.join(repoRoot, 'products', 'harness.json') : undefined].filter(Boolean) as string[];
  for (const c of candidates) { try { return normaliseProduct(JSON.parse(fs.readFileSync(c, 'utf8'))); } catch { /* next */ } }
  return normaliseProduct({});
}
const product = loadProduct();
// Under the end-to-end tests (HARNESS_DESKTOP_TEST=1) the window is shown without focus off every display, never
// flashed, and nothing notifies: playwright drives it through CDP. HARNESS_E2E_SHOW=1 shows it on screen to watch.
const quiet = process.env.HARNESS_DESKTOP_TEST === '1' && process.env.HARNESS_E2E_SHOW !== '1';
app.setName(product.name);
if (process.platform === 'win32') app.setAppUserModelId(product.appId);
// Tests and side-by-side editions: a data folder of their own (set before the single-instance lock, which keys on it).
if (process.env.HARNESS_DESKTOP_DATA) app.setPath('userData', path.resolve(process.env.HARNESS_DESKTOP_DATA));
const dataDir = app.getPath('userData');
fs.mkdirSync(dataDir, { recursive: true });

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
registerSchemePrivileges();

const prefs = new PrefsStore(path.join(dataDir, 'prefs.json'));
// The harness home (~/.harness): the engine's data, workspaces, scratch folders (tmp), exports, logs. Shared with the server and the CLI.
const home = resolveDesktopHome(dataDir);
const logToFile = engineLogFile(home);

const devPluginDirs = () => [...(process.env.HARNESS_DESKTOP_DEV_PLUGINS ?? '').split(path.delimiter).filter(Boolean), ...prefs.get().devPlugins];
const devPlugins = new DevPlugins(devPluginDirs, () => prefs.get().disabledPlugins);
devPlugins.load();

/** The folders sessions may work in: the home's workspaces and tmp, and every project the person opened elsewhere. */
const localRoots = () => desktopRoots(home, prefs.get().projects.map((p) => p.path));

function engineEntry(): string {
  if (process.env.HARNESS_DESKTOP_ENGINE) return path.resolve(process.env.HARNESS_DESKTOP_ENGINE);
  if (app.isPackaged) return path.join(process.resourcesPath, 'engine', 'src', 'server', 'main.ts');
  return path.join(repoRoot ?? repoGuess, 'src', 'server', 'main.ts');
}

const local = new EngineHost({
  entry: engineEntry(),
  env: () => {
    // The person is this engine's operator: their spend limit (Settings > Application) is the engine's.
    const limit = prefs.get().spendLimitUsd;
    // A plugin folder loaded in the app with server code (tools, routes) runs in this engine too: its page can call its routes.
    const withCode = devPluginDirs().filter((d) => { try { return !!JSON.parse(fs.readFileSync(path.join(d, 'harness-plugin.json'), 'utf8')).main; } catch { return false; } });
    const plugins = [...(process.env.HARNESS_PLUGINS ?? '').split(path.delimiter).filter(Boolean), ...withCode].join(path.delimiter);
    return { ...(plugins ? { HARNESS_PLUGINS: plugins } : {}), HARNESS_HOME: home.layout.home, HARNESS_DATA: home.dataDir, HARNESS_LOCAL_ROOTS: localRoots().join(path.delimiter), HARNESS_DESKTOP: '1', ...(typeof limit === 'number' && limit >= 0 ? { HARNESS_MAX_COST_USD: String(limit) } : {}) };
  },
});
let engine: Engine = local;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

const ctx: DesktopContext = {
  // The window a request came from when it is one of ours (a plugin's own window's buttons act on it), else the main one.
  window: () => { const f = BrowserWindow.getFocusedWindow(); return f && (f === mainWindow || [...pluginWindows.values()].includes(f)) ? f : mainWindow; },
  prefs,
  engine: () => engine,
  product,
  paths: { dataDir, get engineData() { return home.dataDir; }, get scratch() { return home.layout.tmp; }, get home() { return home.layout.home; }, rendererDir: path.join(distDir, 'renderer'), sdkDir: path.join(distDir, 'sdk'), repoRoot },
  devPlugins,
  devWatch: undefined,
  emit(channel, payload) { for (const w of [mainWindow, ...pluginWindows.values()]) if (w && !w.isDestroyed()) w.webContents.send(channel, payload); },
  handle: makeHandle(),
  quiet,
  reveal() { if (!mainWindow) { createWindow(); return; } if (quiet) return; if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); },
  iconDataUrl() { const i = appIcon(); return i && !i.isEmpty() ? i.resize({ width: 96, height: 96, quality: 'best' }).toDataURL() : undefined; },
  async useServer(id) {
    const current = prefs.get().servers.active;
    const watch = (e: Engine) => { e.on('state', (s) => ctx.emit('engine:state', s)); };
    if (id === 'local') {
      if (engine !== local) { await engine.stop(); engine = local; }
      if (local.state.status === 'stopped') void local.start();
    } else {
      const s = prefs.get().servers.remote.find((x) => x.id === id);
      const token = s ? serverToken(dataDir, s.id) : null;
      if (!s || !token) throw new Error('That server has no saved sign-in.');
      if (engine === local) await local.stop(false); else await engine.stop();
      const remote = new RemoteEndpoint(s.url, token);
      watch(remote);
      engine = remote;
      void remote.start();
    }
    if (current !== id) prefs.set({ servers: { ...prefs.get().servers, active: id } });
    ctx.emit('engine:state', engine.state);
  },
  openPluginWindow: (name) => openPluginWindow(name),
  pluginShortcut: (name, title) => pluginShortcut(name, title),
  quit() { quitting = true; app.quit(); },
};

local.on('state', (s) => ctx.emit('engine:state', s));
local.on('log', (line) => { ctx.emit('engine:log', line); logToFile(line); });

// A project opened outside the engine's roots: restart it with the new roots (the server reads them at start).
let rootsSig = localRoots().join('|');
prefs.on('change', (p) => {
  ctx.emit('prefs:changed', p);
  const sig = localRoots().join('|');
  if (sig !== rootsSig) {
    rootsSig = sig;
    if (engine === local && local.state.status !== 'stopped') { ctx.emit('engine:notice', { text: 'Restarting the engine so sessions can work in the new folder.' }); void local.restart(); }
  }
});

function appIcon(): Electron.NativeImage | undefined {
  const icon = product.brand.icon;
  const candidates = [
    app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : undefined,
    icon && repoRoot ? path.join(repoRoot, 'products', icon) : undefined,
    path.join(desktopDir, 'build', 'icon.png'),
  ].filter(Boolean) as string[];
  for (const c of candidates) if (fs.existsSync(c)) return nativeImage.createFromPath(c);
  return undefined;
}

/** A position left of every display, far enough that no part of the window shows. */
function offscreen(width: number): { x: number; y: number } {
  const left = Math.min(...screen.getAllDisplays().map((d) => d.bounds.x));
  return { x: left - width - 4000, y: 0 };
}

function createWindow(): void {
  const p = prefs.get();
  const b = p.window;
  const visible = screen.getAllDisplays().some((d) => b.x !== undefined && b.y !== undefined && b.x >= d.bounds.x - 50 && b.y >= d.bounds.y - 50 && b.x < d.bounds.x + d.bounds.width && b.y < d.bounds.y + d.bounds.height);
  const dark = p.theme === 'dark' || (p.theme === 'system' && nativeTheme.shouldUseDarkColors);
  const bg = dark ? '#1d1c1a' : '#faf9f6';
  mainWindow = new BrowserWindow({
    width: b.width, height: b.height, ...(quiet ? offscreen(b.width) : visible ? { x: b.x, y: b.y } : {}),
    minWidth: 480, minHeight: 480, show: false, title: product.name, icon: appIcon(), backgroundColor: bg,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? undefined : { color: bg, symbolColor: dark ? '#ecebe6' : '#1f1e1c', height: 40 },
    ...(quiet ? { paintWhenInitiallyHidden: true, skipTaskbar: true, focusable: true } : {}),
    webPreferences: { preload: path.join(distDir, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false, spellcheck: true, ...(quiet ? { backgroundThrottling: false } : {}) },
  });
  if (b.maximized && !quiet) mainWindow.maximize();
  // Under the tests the window is shown without focus, off every display: it renders and lays out like a
  // visible window (a hidden one lets plugin frames' layout go stale, so clicks land on the old layout),
  // yet nobody sees it and it never takes focus or a taskbar entry.
  mainWindow.once('ready-to-show', () => { if (quiet) { mainWindow?.setPosition(offscreen(b.width).x, offscreen(b.width).y); mainWindow?.showInactive(); } else if (!process.env.HARNESS_DESKTOP_HIDDEN && !focusArg(process.argv)) mainWindow?.show(); });
  void mainWindow.loadURL(`${APP_ORIGIN}/`);
  const save = () => {
    if (!mainWindow || mainWindow.isDestroyed() || quiet) return;
    const max = mainWindow.isMaximized();
    prefs.set({ window: max ? { ...prefs.get().window, maximized: true } : { ...mainWindow.getBounds(), maximized: false } });
  };
  mainWindow.on('resize', save);
  mainWindow.on('move', save);
  mainWindow.on('maximize', () => { save(); ctx.emit('win:maximized', true); });
  mainWindow.on('unmaximize', () => { save(); ctx.emit('win:maximized', false); });
  mainWindow.on('focus', () => { if (!quiet) mainWindow?.flashFrame(false); ctx.emit('win:focus', true); });
  mainWindow.on('blur', () => ctx.emit('win:focus', false));
  mainWindow.on('close', (e) => { if (!quitting && prefs.get().keepInTray && tray) { e.preventDefault(); mainWindow?.hide(); } });
  mainWindow.on('closed', () => { mainWindow = null; });
  guardWindow(mainWindow, `${APP_ORIGIN}/`);
}

/** Links leave the app; the app never navigates away from itself; plugin frames stay on their own files. */
function guardWindow(w: BrowserWindow, home: string): void {
  w.webContents.setWindowOpenHandler(({ url }) => { if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
  w.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(`${APP_ORIGIN}/`)) { e.preventDefault(); if (/^https?:/i.test(url)) void shell.openExternal(url); } });
  w.webContents.on('will-frame-navigate', (e) => {
    if (e.isMainFrame) return;
    const to = e.url;
    if (!(to.startsWith(`${APP_ORIGIN}/plugins/`) || to.startsWith(`${PREVIEW_ORIGIN}/`) || to === 'about:srcdoc' || to.startsWith('about:blank'))) e.preventDefault();
  });
  w.webContents.on('render-process-gone', (_e, d) => { if (d.reason !== 'clean-exit') void w.loadURL(home); });
}

/**
 * A plugin opened as its own app: a window focused on it (renderer ?focus=<name>: its menu first, its home,
 * its name), with every core service and every other plugin still there. One window per plugin.
 */
const pluginWindows = new Map<string, BrowserWindow>();
function openPluginWindow(name: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) return;
  const open = pluginWindows.get(name);
  if (open && !open.isDestroyed()) { if (open.isMinimized()) open.restore(); open.show(); open.focus(); return; }
  const p = prefs.get();
  const dark = p.theme === 'dark' || (p.theme === 'system' && nativeTheme.shouldUseDarkColors);
  const bg = dark ? '#1d1c1a' : '#faf9f6';
  const w = new BrowserWindow({
    width: Math.min(1320, p.window.width), height: Math.min(900, p.window.height), ...(quiet ? offscreen(1200) : {}),
    minWidth: 480, minHeight: 480, show: false, title: name, icon: appIcon(), backgroundColor: bg,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? undefined : { color: bg, symbolColor: dark ? '#ecebe6' : '#1f1e1c', height: 40 },
    ...(quiet ? { paintWhenInitiallyHidden: true, skipTaskbar: true } : {}),
    webPreferences: { preload: path.join(distDir, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false, spellcheck: true, ...(quiet ? { backgroundThrottling: false } : {}) },
  });
  const home = `${APP_ORIGIN}/?focus=${encodeURIComponent(name)}`;
  pluginWindows.set(name, w);
  guardWindow(w, home);
  // In front when it opens (from a shortcut the app may be in the background: Windows lets it take focus only so).
  w.once('ready-to-show', () => { if (quiet) w.showInactive(); else if (!process.env.HARNESS_DESKTOP_HIDDEN) {
    w.show(); app.focus({ steal: true }); w.focus();
    // Windows keeps a window a background process opens behind the others: on top for a moment brings it forward.
    if (!w.isFocused()) { w.setAlwaysOnTop(true); w.focus(); setTimeout(() => { if (!w.isDestroyed()) w.setAlwaysOnTop(false); }, 300); }
  } });
  w.on('focus', () => w.webContents.send('win:focus', true));
  w.on('blur', () => w.webContents.send('win:focus', false));
  w.on('maximize', () => w.webContents.send('win:maximized', true));
  w.on('unmaximize', () => w.webContents.send('win:maximized', false));
  w.on('closed', () => {
    pluginWindows.delete(name);
    // Started focused on plugins (a shortcut): the last of their windows closing ends the app, unless it lives in the tray.
    if (!pluginWindows.size && mainWindow && !mainWindow.isVisible() && !quitting && !(prefs.get().keepInTray && tray)) app.quit();
  });
  void w.loadURL(home);
}

/** --plugin=<name> on the command line (a shortcut made from the Plugins page): open that plugin as its own app. */
const focusArg = (argv: string[]) => argv.map((a) => /^--plugin=(.+)$/.exec(a)?.[1]).find((x): x is string => !!x);

/**
 * A shortcut that starts the app focused on one plugin: on the desktop (and the Start menu) on Windows,
 * a .desktop entry on Linux. macOS has no such shortcut for an app's argument: the window opens from the Plugins page.
 */
function pluginShortcut(name: string, title: string): { ok: boolean; path?: string; reason?: string } {
  const safe = title.replace(/[\\/:*?"<>|]/g, '').slice(0, 60) || name;
  const args = [...(app.isPackaged ? [] : [app.getAppPath()]), `--plugin=${name}`];
  const argText = args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
  if (process.platform === 'win32') {
    const link = { target: process.execPath, args: argText, description: `${title} (${product.name})`, icon: process.execPath, iconIndex: 0 };
    const target = path.join(app.getPath('desktop'), `${safe}.lnk`);
    const ok = shell.writeShortcutLink(target, 'create', link);
    if (ok) { try { shell.writeShortcutLink(path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${safe}.lnk`), 'create', link); } catch { /* the desktop one is enough */ } }
    return ok ? { ok, path: target } : { ok: false, reason: 'Windows did not create the shortcut.' };
  }
  if (process.platform === 'linux') {
    const dir = path.join(app.getPath('home'), '.local', 'share', 'applications');
    const file = path.join(dir, `harness-${name}.desktop`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, ['[Desktop Entry]', 'Type=Application', `Name=${safe}`, `Comment=${title} (${product.name})`, `Exec=${[process.execPath, ...args].map((a) => `"${a}"`).join(' ')}`, 'Terminal=false', ''].join('\n'));
    return { ok: true, path: file };
  }
  return { ok: false, reason: 'On macOS, open it from the Plugins page (Open as app), then keep it in the Dock.' };
}

function createTray(): void {
  const icon = appIcon();
  if (!icon || process.env.HARNESS_DESKTOP_NO_TRAY || quiet) return;
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip(product.name);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Open ${product.name}`, click: () => ctx.reveal() },
    { label: 'New chat', click: () => { ctx.reveal(); ctx.emit('command:run', { id: 'core.chat:new' }); } },
    { type: 'separator' },
    { label: `Quit ${product.name}`, click: () => ctx.quit() },
  ]));
  tray.on('click', () => ctx.reveal());
}

/** No menu bar is drawn (the window has its own); the standard editing and developer keys still work. */
function installMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload', accelerator: 'CmdOrCtrl+Shift+R' }, { role: 'toggleDevTools', accelerator: 'CmdOrCtrl+Alt+I' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]));
}

function handleDeepLink(argv: string[]): void {
  const raw = argv.find((a) => a.startsWith(`${SCHEME}://`));
  if (!raw) return;
  const link = parseDeepLink(raw);
  if (link) { ctx.reveal(); ctx.emit('deeplink:open', link); }
}

app.on('second-instance', (_e, argv) => { const f = focusArg(argv); if (f) { openPluginWindow(f); return; } ctx.reveal(); handleDeepLink(argv); });

app.whenReady().then(async () => {
  nativeTheme.themeSource = prefs.get().theme === 'dark' ? 'dark' : prefs.get().theme === 'light' ? 'light' : 'system';
  // A stub for links from the browser (harness://open?session=...): registered only for the installed app.
  if (app.isPackaged) { try { app.setAsDefaultProtocolClient(SCHEME); } catch { /* not allowed here */ } }
  handleProtocol({ rendererDir: ctx.paths.rendererDir, sdkDir: ctx.paths.sdkDir, endpoint: () => engine.ready(90_000), devPlugins });
  // The window may ask for nothing: no camera, microphone, location or notifications from web content.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write' || permission === 'fullscreen'));
  registerIpc(ctx);
  ctx.handle('projects:add', (dir: string) => {
    if (typeof dir !== 'string' || !path.isAbsolute(dir) || !fs.existsSync(dir)) throw new Error('That folder does not exist.');
    const p = prefs.get();
    if (!p.projects.some((x) => x.path === dir)) prefs.set({ projects: [...p.projects, { path: dir, name: projectName(dir), addedAt: Date.now() }] });
    return prefs.get().projects;
  });
  ctx.handle('projects:remove', (dir: string) => { prefs.set({ projects: prefs.get().projects.filter((x) => x.path !== dir) }); return prefs.get().projects; });
  // Settings > Application > Location, scratch folders and new projects; the tmp clean-up (on start and daily).
  registerHomeIpc(ctx, home, { stopEngine: () => (engine === local ? local.stop(false) : Promise.resolve()), restartEngine: async () => { rootsSig = localRoots().join('|'); if (engine === local) void local.start(); } });
  installMenu();
  // Older versions kept the engine's data in the app's user data: moved into the home once (a backup stays), before the engine starts.
  await migrateEngineData(home, dataDir, (m) => { console.log(m); logToFile(`[desktop] ${m}`); });
  const active = prefs.get().servers.active;
  if (active !== 'local' && prefs.get().servers.remote.some((s) => s.id === active)) await ctx.useServer(active).catch(() => { void local.start(); });
  else void local.start();
  createWindow();
  createTray();
  handleDeepLink(process.argv);
  const startFocused = focusArg(process.argv);
  if (startFocused) openPluginWindow(startFocused);
  // Plugin folders loaded in the app: an edit refreshes the plugin's pages and reloads its server code.
  ctx.devWatch = new DevWatch({
    dirs: devPluginDirs,
    nameOf: (dir) => devPlugins.load().find((p) => p.dir === dir)?.name,
    engine: () => engine.ready(30_000).catch(() => null),
    changed: (r) => ctx.emit('plugins:devChanged', r),
  });
  ctx.devWatch.sync();
  // npm run desktop:dev rebuilds the interface on change; the window reloads when it lands.
  if (process.env.HARNESS_DESKTOP_DEV_RELOAD && !app.isPackaged) {
    let timer: NodeJS.Timeout | undefined;
    try {
      fs.watch(ctx.paths.rendererDir, { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => { for (const w of [mainWindow, ...pluginWindows.values()]) if (w && !w.isDestroyed()) w.webContents.reloadIgnoringCache(); }, 300);
      });
    } catch { /* no recursive watch here: reload by hand (Ctrl+R) */ }
  }
});

app.on('activate', () => { if (!mainWindow) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !(prefs.get().keepInTray && tray)) app.quit(); });

let stopped = false;
app.on('before-quit', (e) => {
  quitting = true;
  prefs.flush();
  if (stopped) return;
  e.preventDefault();
  void engine.stop().finally(() => { stopped = true; app.quit(); });
});
