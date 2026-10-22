/**
 * The renderer's only bridge to main: `invoke` and `on` over an allowlist of channel prefixes, so a
 * feature adds channels without touching this file while the renderer still cannot reach anything
 * main did not register (and main answers only the app's top frame). Plugin frames never get this:
 * they are sandboxed iframes with no preload, talking to the host by postMessage.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';

const PREFIXES = ['app:', 'engine:', 'prefs:', 'win:', 'dialog:', 'shell:', 'clipboard:', 'notify:', 'plugins:', 'grants:', 'servers:', 'preview:', 'projects:', 'command:', 'deeplink:'];
const allowed = (c: unknown): c is string => typeof c === 'string' && PREFIXES.some((p) => c.startsWith(p));

// Only the app's own top-level page gets the bridge.
if (location.protocol === 'harness:' && location.host === 'app' && window.top === window) {
  contextBridge.exposeInMainWorld('harnessDesktop', {
    platform: process.platform,
    invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      if (!allowed(channel)) return Promise.reject(new Error(`Channel not allowed: ${channel}`));
      return ipcRenderer.invoke(channel, ...args);
    },
    on(channel: string, listener: (payload: unknown) => void): () => void {
      if (!allowed(channel)) throw new Error(`Channel not allowed: ${channel}`);
      const wrapped = (_e: unknown, payload: unknown) => listener(payload);
      ipcRenderer.on(channel, wrapped);
      return () => { ipcRenderer.removeListener(channel, wrapped); };
    },
    pathForFile(file: File): string { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  });
}
