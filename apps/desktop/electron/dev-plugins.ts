/**
 * Plugins the desktop loads itself from folders on this machine: the UI half only, for plugin
 * development (like "load unpacked" in a browser) and for UI-only plugins on a server that cannot
 * serve plugin UI files yet. Their server half (tools, routes) is not loaded here; install the
 * plugin on the server for that.
 *
 * Each folder holds a harness-plugin.json with a `ui` section, validated with the same rules the
 * server uses (frame at most: native UI is for signed first-party plugins). The uiHash is a hash of
 * every file in the folder, so a grant given to one version is asked again after any change.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { validateUiManifest, type UiManifest } from '@harness/plugin-ui';

export interface DevPlugin {
  name: string; version: string; description?: string; dir: string;
  ui?: UiManifest; uiError?: string; uiHash?: string; enabled: boolean; source: 'dev';
}

function hashDir(dir: string): string {
  const h = crypto.createHash('sha256');
  const walk = (d: string, rel = '') => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) { h.update(r); h.update('\0'); h.update(fs.readFileSync(p)); h.update('\0'); }
    }
  };
  walk(dir);
  return h.digest('hex').slice(0, 32);
}

export class DevPlugins {
  private list: DevPlugin[] = [];
  private dirs: () => string[];
  private disabled: () => string[];
  constructor(dirs: () => string[], disabled: () => string[]) { this.dirs = dirs; this.disabled = disabled; }

  load(): DevPlugin[] {
    const out: DevPlugin[] = [];
    for (const dir of this.dirs()) {
      const file = path.join(dir, 'harness-plugin.json');
      let m: Record<string, unknown>;
      try { m = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>; } catch (e) { out.push({ name: path.basename(dir), version: '?', dir, enabled: false, source: 'dev', uiError: `${file}: ${(e as Error).message}` }); continue; }
      const name = typeof m.name === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(m.name) ? m.name : path.basename(dir);
      const p: DevPlugin = { name, version: String(m.version ?? '0.0.0'), description: typeof m.description === 'string' ? m.description : undefined, dir, enabled: !this.disabled().includes(name), source: 'dev' };
      if (m.ui !== undefined) {
        try { p.ui = validateUiManifest(m.ui, { trustCeiling: 'frame' }); p.uiHash = hashDir(dir); } catch (e) { p.uiError = (e as Error).message; }
      }
      if (!out.some((x) => x.name === p.name)) out.push(p);
    }
    this.list = out;
    return out;
  }

  all(): DevPlugin[] { return this.list; }

  /** The file on disk for a dev plugin's UI request, or null when the plugin is not a dev plugin. */
  file(plugin: string, rel: string): string | null {
    const p = this.list.find((x) => x.name === plugin);
    if (!p) return null;
    const target = path.resolve(p.dir, rel);
    const root = path.resolve(p.dir);
    return target.startsWith(root + path.sep) ? target : path.join(root, '__outside__');
  }
}
