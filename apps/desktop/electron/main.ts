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
// Under the end-to-end tests (HARNESS_DESKTOP_TEST=1) the window is never shown, focused or flashed, and nothing
// notifies: playwright drives it (and takes its screenshots) through CDP. HARNESS_E2E_SHOW=1 shows it to watch.
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
  env: () => ({ HARNESS_HOME: home.layout.home, HARNESS_DATA: home.dataDir, HARNESS_LOCAL_ROOTS: localRoots().join(path.delimiter), HARNESS_DESKTOP: '1' }),
});
let engine: Engine = local;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

const ctx: DesktopContext = {
  window: () => mainWindow,
  prefs,
  engine: () => engine,
  product,
  paths: { dataDir, get engineData() { return home.dataDir; }, get scratch() { return home.layout.tmp; }, get home() { return home.layout.home; }, rendererDir: path.join(distDir, 'renderer'), sdkDir: path.join(distDir, 'sdk'), repoRoot },
  devPlugins,
  emit(channel, payload) { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload); },
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

function createWindow(): void {
  const p = prefs.get();
  const b = p.window;
  const visible = screen.getAllDisplays().some((d) => b.x !== undefined && b.y !== undefined && b.x >= d.bounds.x - 50 && b.y >= d.bounds.y - 50 && b.x < d.bounds.x + d.bounds.width && b.y < d.bounds.y + d.bounds.height);
  const dark = p.theme === 'dark' || (p.theme === 'system' && nativeTheme.shouldUseDarkColors);
  const bg = dark ? '#1d1c1a' : '#faf9f6';
  mainWindow = new BrowserWindow({
    width: b.width, height: b.height, ...(visible ? { x: b.x, y: b.y } : {}),
    minWidth: 480, minHeight: 480, show: false, title: product.name, icon: appIcon(), backgroundColor: bg,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? undefined : { color: bg, symbolColor: dark ? '#ecebe6' : '#1f1e1c', height: 40 },
    ...(quiet ? { paintWhenInitiallyHidden: true, skipTaskbar: true, focusable: true } : {}),
    webPreferences: { preload: path.join(distDir, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false, spellcheck: true, ...(quiet ? { backgroundThrottling: false } : {}) },
  });
  if (b.maximized && !quiet) mainWindow.maximize();
  mainWindow.once('ready-to-show', () => { if (!process.env.HARNESS_DESKTOP_HIDDEN && !quiet) mainWindow?.show(); });
  void mainWindow.loadURL(`${APP_ORIGIN}/`);
  const save = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
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
  // Links leave the app; the app never navigates away from itself.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
  mainWindow.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(`${APP_ORIGIN}/`)) { e.preventDefault(); if (/^https?:/i.test(url)) void shell.openExternal(url); } });
  mainWindow.webContents.on('will-frame-navigate', (e) => {
    // Plugin frames stay on their own files; previews on theirs. Nothing navigates a frame to the API or elsewhere.
    if (e.isMainFrame) return;
    const to = e.url;
    if (!(to.startsWith(`${APP_ORIGIN}/plugins/`) || to.startsWith(`${PREVIEW_ORIGIN}/`) || to === 'about:srcdoc' || to.startsWith('about:blank'))) e.preventDefault();
  });
  mainWindow.webContents.on('render-process-gone', (_e, d) => { if (d.reason !== 'clean-exit') void mainWindow?.loadURL(`${APP_ORIGIN}/`); });
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

app.on('second-instance', (_e, argv) => { ctx.reveal(); handleDeepLink(argv); });

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
  // npm run desktop:dev rebuilds the interface on change; the window reloads when it lands.
  if (process.env.HARNESS_DESKTOP_DEV_RELOAD && !app.isPackaged) {
    let timer: NodeJS.Timeout | undefined;
    try {
      fs.watch(ctx.paths.rendererDir, { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => mainWindow?.webContents.reloadIgnoringCache(), 300);
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
