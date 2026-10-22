/**
 * What every main-process feature module gets: the window, prefs, the engine, the product, a way to
 * tell the window something, and `handle` - an IPC handler that answers only the app's top frame
 * (never a plugin frame, an artifact preview or a web page).
 */

import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import type { Engine } from './engine-host';
import type { PrefsStore } from './store';
import type { ProductProfile } from '../shared/product';
import type { DevPlugins } from './dev-plugins';
import { appFrameAllowed } from './policy';

export interface DesktopPaths { dataDir: string; engineData: string; scratch: string; rendererDir: string; sdkDir: string; repoRoot: string | null }

export interface DesktopContext {
  window(): BrowserWindow | null;
  prefs: PrefsStore;
  engine(): Engine;
  product: ProductProfile;
  paths: DesktopPaths;
  devPlugins: DevPlugins;
  emit(channel: string, payload?: unknown): void;
  handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>): void;
  reveal(): void;
  /** Switch between the local engine and a remote server. */
  useServer(id: string): Promise<void>;
  quit(): void;
}

export function makeHandle(): DesktopContext['handle'] {
  return (channel, fn) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (e: IpcMainInvokeEvent, ...args: unknown[]) => {
      const f = e.senderFrame;
      if (!appFrameAllowed(f ? { url: f.url, isTopFrame: f.parent === null } : null)) throw new Error(`Refused: "${channel}" answers only the app window.`);
      return fn(...(args as never));
    });
  };
}
