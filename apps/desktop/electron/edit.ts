/**
 * Right-click menus, main's half. The app's own page draws its menu itself (shell/ContextMenu.tsx: standard
 * editing, links, images, and what the thing under the pointer offers) and asks here for what only main
 * can do: the editing commands, the spelling suggestions of the word under the pointer, copying or saving
 * an image. Everything else (a plugin's sandboxed frame, a preview window) gets the standard menu natively.
 */

import { app, BrowserWindow, clipboard, ipcMain, Menu, shell, type ContextMenuParams, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type WebContents } from 'electron';
import { appFrameAllowed } from './policy';

const EDIT = ['undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'selectAll', 'delete'] as const;
type Edit = typeof EDIT[number];

/** The last right-click in each page: the renderer asks for its spelling suggestions a moment later. */
const last = new WeakMap<WebContents, { at: number; params: ContextMenuParams }>();

/** The standard menu, for pages that do not draw their own. */
function nativeMenu(wc: WebContents, p: ContextMenuParams): Menu | null {
  const items: MenuItemConstructorOptions[] = [];
  if (p.misspelledWord) {
    for (const s of p.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => wc.replaceMisspelling(s) });
    if (!p.dictionarySuggestions.length) items.push({ label: 'No suggestions', enabled: false });
    items.push({ label: 'Add to dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) }, { type: 'separator' });
  }
  if (p.linkURL && /^(https?:|mailto:)/i.test(p.linkURL)) items.push({ label: 'Open link in browser', click: () => void shell.openExternal(p.linkURL) }, { label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) }, { type: 'separator' });
  if (p.mediaType === 'image' && p.srcURL) items.push({ label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) }, { label: 'Save image as…', click: () => wc.downloadURL(p.srcURL) }, { type: 'separator' });
  const f = p.editFlags;
  if (p.isEditable) items.push({ role: 'undo', enabled: f.canUndo }, { role: 'redo', enabled: f.canRedo }, { type: 'separator' }, { role: 'cut', enabled: f.canCut }, { role: 'copy', enabled: f.canCopy }, { role: 'paste', enabled: f.canPaste }, { role: 'pasteAndMatchStyle', enabled: f.canPaste }, { type: 'separator' }, { role: 'selectAll' });
  else if (p.selectionText.trim()) items.push({ role: 'copy' }, { role: 'selectAll' });
  else items.push({ role: 'selectAll' });
  while (items.at(-1)?.type === 'separator') items.pop();
  return items.length ? Menu.buildFromTemplate(items) : null;
}

/** A handler that acts on the page that asked (the app's top frame only, as every other channel). */
function handle(channel: string, fn: (wc: WebContents, ...args: never[]) => unknown): void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, (e: IpcMainInvokeEvent, ...args: unknown[]) => {
    const f = e.senderFrame;
    if (!appFrameAllowed(f ? { url: f.url, isTopFrame: f.parent === null } : null)) throw new Error(`Refused: "${channel}" answers only the app window.`);
    return fn(e.sender, ...(args as never[]));
  });
}

export function registerEdit(): void {
  app.on('web-contents-created', (_e, wc) => {
    wc.on('context-menu', (_ev, params) => {
      last.set(wc, { at: Date.now(), params });
      // The app's own top page draws its menu (shell/ContextMenu.tsx); a plugin's frame inside it, or any other page, gets the native one.
      const inSubframe = !!params.frame && params.frame.parent !== null;
      if (!inSubframe && wc.getURL().startsWith('harness://app/')) return;
      nativeMenu(wc, params)?.popup({ window: BrowserWindow.fromWebContents(wc) ?? undefined });
    });
  });
  handle('edit:do', (wc, what: string) => {
    if (!(EDIT as readonly string[]).includes(what)) throw new Error(`Not an editing command: ${what}`);
    wc[what as Edit]();
    return true;
  });
  /** The word under the last right-click (within the last few seconds) and what it might be. */
  handle('edit:spelling', (wc) => {
    const l = last.get(wc);
    if (!l || Date.now() - l.at > 4000 || !l.params.misspelledWord) return null;
    return { word: l.params.misspelledWord, suggestions: l.params.dictionarySuggestions.slice(0, 6) };
  });
  handle('edit:replaceMisspelling', (wc, word: string) => { wc.replaceMisspelling(String(word)); return true; });
  handle('edit:addToDictionary', (wc, word: string) => { wc.session.addWordToSpellCheckerDictionary(String(word)); return true; });
  handle('edit:copyImageAt', (wc, x: number, y: number) => { wc.copyImageAt(Math.round(Number(x)), Math.round(Number(y))); return true; });
  handle('edit:saveImage', (wc, url: string) => {
    const u = String(url);
    if (!/^(https?:|data:image\/|blob:|harness:)/i.test(u)) throw new Error('That image cannot be saved.');
    wc.downloadURL(u);
    return true;
  });
}
