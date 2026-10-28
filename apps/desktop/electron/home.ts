/**
 * The harness home on this machine (~/.harness, DESIGN section 19), as the app sees it: where it is,
 * the one-time move of the engine's data out of Electron's user data, scratch folders, new projects,
 * the engine log, and Settings > Application > Location (sizes, open, move, the tmp clean-up age).
 *
 * The logic is the server's (src/util/home.ts): the server, the CLI and the app agree on one home.
 * Tests and side-by-side editions (HARNESS_DESKTOP_DATA) get a home inside their data folder unless
 * HARNESS_HOME names one, so a test never touches the person's own.
 */

import { dialog, shell } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cleanTmp, ensureHome, folderSize, homeLayout, migrateDataDir, moveHome, POINTER_FILE, readHomeSettings, removeOldHome, resolveHome,
  scheduleTmpCleanup, writeHomeSettings, type HomeLayout,
} from '../../../src/util/home';
import type { DesktopContext } from './context';

export interface DesktopHome {
  layout: HomeLayout;
  /** The engine's data folder: the home's, or the old user-data one when moving it failed. */
  dataDir: string;
  /** The pointer a move writes (where the server and the CLI look too, unless the app is isolated). */
  pointer: string;
  /** What happened to an older data folder at start (for the log and Location). */
  migration?: string;
  /** The scratch folder of older versions (user data/workspace), kept as a folder sessions may use while it exists. */
  legacyScratch?: string;
}

/** Where the home is for this app (synchronous: needed before the window and the engine). */
export function resolveDesktopHome(userData: string, edition?: string): DesktopHome {
  const isolated = !!process.env.HARNESS_DESKTOP_DATA && !process.env.HARNESS_HOME;
  // An edition with a home of its own (a solution's app: ~/.harness-studio), and its own pointer when moved.
  const own = !isolated && edition && /^\.?[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(edition) ? edition : undefined;
  const pointer = isolated ? path.join(userData, 'home-location') : own ? path.join(os.homedir(), `${own}-location`) : path.join(os.homedir(), POINTER_FILE);
  const home = resolveHome({ pointer, ...(isolated ? { fallback: path.join(userData, 'home') } : own ? { fallback: path.join(os.homedir(), own) } : {}) });
  const layout = homeLayout(home);
  ensureHome(layout);
  const legacyScratch = path.join(userData, 'workspace');
  return { layout, dataDir: layout.data, pointer, ...(fs.existsSync(legacyScratch) ? { legacyScratch } : {}) };
}

/** Moves the engine data of older versions (user data/engine) into the home, once; keeps using it if that fails. */
export async function migrateEngineData(h: DesktopHome, userData: string, log: (m: string) => void): Promise<void> {
  const r = await migrateDataDir(path.join(userData, 'engine'), h.layout.data);
  h.dataDir = r.dataDir;
  if (r.status === 'moved' || r.status === 'failed') { h.migration = r.message; log(r.message); }
}

/** The engine's log lines, appended to <home>/logs/engine.log (kept under 5 MB, one older file). */
export function engineLogFile(h: DesktopHome): (line: string) => void {
  const file = () => path.join(h.layout.logs, 'engine.log');
  let size = (() => { try { return fs.statSync(file()).size; } catch { return 0; } })();
  return (line) => {
    try {
      if (size > 5 * 1024 * 1024) { fs.renameSync(file(), `${file()}.1`); size = 0; }
      const text = `${new Date().toISOString()} ${line.replace(/\s+$/, '')}\n`;
      fs.appendFileSync(file(), text);
      size += Buffer.byteLength(text);
    } catch { /* the log is a convenience */ }
  };
}

/** The folders local sessions may use: the home's workspaces and tmp, an older scratch, and opened projects elsewhere. */
export function desktopRoots(h: DesktopHome, projects: string[]): string[] {
  const own = [h.layout.workspaces, h.layout.tmp];
  const under = (p: string) => own.some((r) => p === r || p.startsWith(r + path.sep));
  return [...own, ...(h.legacyScratch && fs.existsSync(h.legacyScratch) ? [h.legacyScratch] : []), ...projects.filter((p) => !under(p))].filter((p, i, a) => a.indexOf(p) === i);
}

const slug = (name: string) => name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);

export function registerHomeIpc(ctx: DesktopContext, h: DesktopHome, o: { restartEngine: () => Promise<void>; stopEngine: () => Promise<void> }): () => void {
  const handle = ctx.handle;
  let stopCleanup = scheduleTmpCleanup(h.layout, (m) => ctx.emit('engine:log', `[desktop] ${m}`));

  // A scratch conversation: a new folder of its own under tmp/ (cleaned after the set number of days).
  handle('home:scratch', () => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
    const dir = path.join(h.layout.tmp, `${stamp}-${crypto.randomBytes(3).toString('hex')}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  });

  // A new project the app creates: <home>/workspaces/<name>, listed with the projects.
  handle('projects:create', (name: string) => {
    const base = slug(String(name ?? ''));
    if (!base) throw new Error('Give the project a name (letters or digits).');
    let dir = path.join(h.layout.workspaces, base);
    for (let i = 2; fs.existsSync(dir); i++) dir = path.join(h.layout.workspaces, `${base}-${i}`);
    fs.mkdirSync(dir, { recursive: true });
    const p = ctx.prefs.get();
    ctx.prefs.set({ projects: [...p.projects, { path: dir, name: String(name).trim().slice(0, 80) || base, addedAt: Date.now() }] });
    return { path: dir, projects: ctx.prefs.get().projects };
  });

  const movedFrom = (): string | undefined => {
    try {
      const j = JSON.parse(fs.readFileSync(h.pointer, 'utf8')) as { home?: string; movedFrom?: string };
      return j.home === h.layout.home && j.movedFrom && j.movedFrom !== h.layout.home && fs.existsSync(j.movedFrom) ? j.movedFrom : undefined;
    } catch { return undefined; }
  };
  const folders = () => {
    const l = h.layout;
    return [
      { key: 'data', label: 'Data', path: h.dataDir, note: 'conversations, vault, plugin data' },
      { key: 'workspaces', label: 'Workspaces', path: l.workspaces, note: 'default and the projects made here' },
      { key: 'tmp', label: 'Scratch (tmp)', path: l.tmp, note: 'scratch conversations, cleaned after some days' },
      { key: 'exports', label: 'Exports', path: l.exports, note: 'dashboards, reports, conversation exports' },
      { key: 'plugins', label: 'Plugins', path: l.plugins, note: 'installed from the catalogue' },
      { key: 'logs', label: 'Logs', path: l.logs, note: 'the engine log' },
    ];
  };
  const info = async () => ({
    home: h.layout.home,
    settingsFile: h.layout.settings,
    tmpCleanupDays: readHomeSettings(h.layout).tmpCleanupDays,
    folders: await Promise.all(folders().map(async (f) => ({ ...f, ...(await folderSize(f.path)) }))),
    ...(movedFrom() ? { oldCopy: movedFrom() } : {}),
    ...(h.migration ? { migration: h.migration } : {}),
    ...(h.dataDir !== h.layout.data ? { dataOutside: true } : {}),
  });
  handle('home:info', info);
  handle('home:open', (key: string) => {
    const f = key === 'home' ? h.layout.home : folders().find((x) => x.key === key)?.path;
    if (!f) throw new Error('No such folder.');
    fs.mkdirSync(f, { recursive: true });
    return shell.openPath(f);
  });
  handle('home:setTmpDays', (days: number) => writeHomeSettings(h.layout, { tmpCleanupDays: Number(days) }).tmpCleanupDays);
  handle('home:cleanTmp', async () => cleanTmp(h.layout.tmp, { maxAgeDays: readHomeSettings(h.layout).tmpCleanupDays }));
  handle('home:chooseFolder', async () => {
    const w = ctx.window();
    const r = w ? await dialog.showOpenDialog(w, { title: 'Move the harness home to', properties: ['openDirectory', 'createDirectory'] }) : null;
    return r && !r.canceled && r.filePaths[0] ? r.filePaths[0] : null;
  });
  // Move: copy to the new place, verify, switch (the engine restarts there), keep the old copy until the person removes it.
  handle('home:move', async (target: string) => {
    if (typeof target !== 'string' || !path.isAbsolute(target)) throw new Error('Choose a folder for the new location.');
    // A folder that has things in it gets the home as a subfolder.
    const to = fs.existsSync(target) && fs.readdirSync(target).length ? path.join(target, 'Harness') : target;
    const from = h.layout.home;
    await o.stopEngine();
    try {
      const r = await moveHome(from, to, { pointer: h.pointer });
      const before = h.layout;
      h.layout = homeLayout(r.home);
      if (h.dataDir === before.data) h.dataDir = h.layout.data;
      // Projects made in the old home's workspaces now live in the new one.
      const p = ctx.prefs.get();
      ctx.prefs.set({ projects: p.projects.map((x) => (x.path === from || x.path.startsWith(from + path.sep) ? { ...x, path: r.home + x.path.slice(from.length) } : x)) });
      stopCleanup(); stopCleanup = scheduleTmpCleanup(h.layout, (m) => ctx.emit('engine:log', `[desktop] ${m}`));
      ctx.emit('engine:log', `[desktop] home moved from ${from} to ${r.home} (${r.files} files); the old copy is kept until you remove it`);
      return { moved: r, info: await info() };
    } finally { await o.restartEngine(); }
  });
  handle('home:removeOld', async () => {
    const old = movedFrom();
    if (!old) throw new Error('There is no old copy to remove.');
    await removeOldHome(old, h.layout.home);
    return info();
  });
  return () => stopCleanup();
}
