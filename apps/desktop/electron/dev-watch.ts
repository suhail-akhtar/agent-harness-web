/**
 * Plugin folders loaded in the app, watched while the app runs: a change to a page (anything under
 * the folder that is not server code) refreshes the plugin's pages; a change to its server code (its
 * "main" and the files beside it, its skills, agents, workflows, the manifest) loads the plugin
 * again in the engine (POST /api/plugins/<name>/reload) without a restart. A version that fails to
 * load leaves the one before running, and the window hears why.
 */

import fs from 'node:fs';
import path from 'node:path';
/** Where the engine answers (engine-host.ts's EngineEndpoint). */
type EngineEndpoint = { origin: string; token: string };

export interface DevReload { plugin: string; dir: string; pages: boolean; server?: { ok: boolean; error?: string } }

/** Whether a changed file is server code: everything but the page folders (where the ui's entries are) and docs. */
export function isServerFile(rel: string, pageDirs: string[]): boolean {
  const r = rel.split(path.sep).join('/');
  if (/(^|\/)(node_modules|\.git)(\/|$)/.test(r) || /\.(md|txt|png|jpe?g|gif|svg|webp|ico)$/i.test(r) && !/^(skills|agents|output-styles)\//.test(r)) return false;
  if (r === 'harness-plugin.json') return true;
  return !pageDirs.some((d) => r === d || r.startsWith(`${d}/`));
}

/** The folders a plugin's pages are served from (each ui entry's folder), from its manifest. */
export function pageDirsOf(dir: string): string[] {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'harness-plugin.json'), 'utf8')) as { ui?: { contributes?: Record<string, Array<{ entry?: unknown }>> } };
    const entries = Object.values(m.ui?.contributes ?? {}).flatMap((xs) => (Array.isArray(xs) ? xs : [])).map((x) => x?.entry).filter((e): e is string => typeof e === 'string');
    const dirs = new Set(entries.map((e) => path.posix.dirname(e.replace(/\\/g, '/'))).filter((d) => d && d !== '.'));
    return dirs.size ? [...dirs] : ['ui'];
  } catch { return ['ui']; }
}

export class DevWatch {
  private watchers = new Map<string, fs.FSWatcher>();
  private pending = new Map<string, { files: Set<string>; timer: NodeJS.Timeout }>();
  private o: { dirs: () => string[]; nameOf: (dir: string) => string | undefined; engine: () => Promise<EngineEndpoint | null>; changed: (r: DevReload) => void };

  constructor(o: DevWatch['o']) { this.o = o; }

  /** Watches the folders loaded now (and stops watching the ones removed). */
  sync(): void {
    const want = new Set(this.o.dirs());
    for (const [d, w] of this.watchers) if (!want.has(d)) { w.close(); this.watchers.delete(d); }
    for (const d of want) {
      if (this.watchers.has(d)) continue;
      try {
        const w = fs.watch(d, { recursive: true }, (_e, f) => { if (f) this.note(d, String(f)); });
        w.on('error', () => { w.close(); this.watchers.delete(d); });
        this.watchers.set(d, w);
      } catch { /* no recursive watching here: reload from the Plugins page */ }
    }
  }

  close(): void { for (const w of this.watchers.values()) w.close(); this.watchers.clear(); for (const p of this.pending.values()) clearTimeout(p.timer); }

  private note(dir: string, file: string): void {
    const p = this.pending.get(dir) ?? { files: new Set<string>(), timer: undefined as unknown as NodeJS.Timeout };
    p.files.add(file);
    clearTimeout(p.timer);
    // Editors save in bursts (a temp file, a rename): one reload once it settles.
    p.timer = setTimeout(() => { this.pending.delete(dir); void this.flush(dir, [...p.files]); }, 400);
    this.pending.set(dir, p);
  }

  private async flush(dir: string, files: string[]): Promise<void> {
    const plugin = this.o.nameOf(dir);
    if (!plugin) return;
    const pageDirs = pageDirsOf(dir);
    const server = files.some((f) => isServerFile(f, pageDirs)) && hasMain(dir);
    const out: DevReload = { plugin, dir, pages: true };
    if (server) out.server = await reloadInEngine(await this.o.engine(), plugin, dir);
    this.o.changed(out);
  }
}

export function hasMain(dir: string): boolean {
  try { return !!JSON.parse(fs.readFileSync(path.join(dir, 'harness-plugin.json'), 'utf8')).main; } catch { return false; }
}

/** Loads a plugin folder again in the engine (or for the first time). */
export async function reloadInEngine(ep: EngineEndpoint | null, plugin: string, dir: string): Promise<{ ok: boolean; error?: string }> {
  if (!ep) return { ok: false, error: 'the engine is not running' };
  try {
    const r = await fetch(`${ep.origin}/api/plugins/${encodeURIComponent(plugin)}/reload`, { method: 'POST', headers: { authorization: `Bearer ${ep.token}`, 'content-type': 'application/json', 'x-harness': '1' }, body: JSON.stringify({ dir }) });
    if (r.ok) return { ok: true };
    const j = await r.json().catch(() => ({})) as { error?: string };
    return { ok: false, error: j.error ?? `the engine answered ${r.status}` };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
