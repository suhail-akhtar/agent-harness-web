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
import type { DevWatch } from './dev-watch';
import { appFrameAllowed } from './policy';

export interface DesktopPaths { dataDir: string; /** The engine's data (in the harness home). */ readonly engineData: string; /** The home's tmp folder: scratch conversations get a folder each in it. */ readonly scratch: string; /** The harness home (~/.harness). */ readonly home: string; rendererDir: string; sdkDir: string; repoRoot: string | null }

export interface DesktopContext {
  window(): BrowserWindow | null;
  prefs: PrefsStore;
  engine(): Engine;
  product: ProductProfile;
  paths: DesktopPaths;
  devPlugins: DevPlugins;
  /** Watches the plugin folders loaded in the app (pages refresh, server code reloads in the engine). */
  devWatch?: DevWatch;
  emit(channel: string, payload?: unknown): void;
  handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>): void;
  reveal(): void;
  /** Under the end-to-end tests: the window is never shown or focused, and nothing notifies or flashes. */
  quiet: boolean;
  /** The product's icon (its profile's, else the app's), as a data URL for the window to show; undefined when there is none. */
  iconDataUrl(): string | undefined;
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
