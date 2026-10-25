import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { type UiManifest, type UiTrust, uiEntries, validateUiManifest } from '../../packages/plugin-ui/src/manifest.ts';
import { within } from '../tools/paths.ts';

// The UI half of a plugin, as the server sees it: the `ui` section of harness-plugin.json
// validated against the contract (packages/plugin-ui), the files its frames load, and a
// hash over both (a person's grant to a frame plugin is tied to it: any change asks again).
//
// What is served (GET /api/plugins/<name>/ui/<path>): only files under the top-level
// folder(s) the manifest's frame entries live in (an entry at the top level: that file
// alone), never a dotfile or anything under a dot-folder, never a path with "..", and the
// real path (links followed) must stay inside that folder - a plugin folder's own code
// (index.mjs, the manifest) is never served.

export interface PluginUi { ui?: UiManifest; uiError?: string; uiHash?: string; /** What validation put right (an unknown icon): the UI is used, the plugin's author should fix it. */ uiWarnings?: string[] }

/** Content types of what a plugin UI may hold; anything else is served as bytes. */
export const UI_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.wasm': 'application/wasm',
};

/**
 * Frames talk to the host only through postMessage: no network of their own. `sandbox`
 * (added to the contract's policy) keeps an entry opened outside its frame from running
 * with the server's origin.
 */
export const UI_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; frame-ancestors *";
export const UI_CSP_DOCUMENT = `${UI_CSP}; sandbox allow-scripts allow-forms`;

const MAX_FILE = 10 * 1024 * 1024;
const MAX_FILES = 2000;

/** Folders (and top-level files) the frames of a manifest may load from. */
export function uiRoots(ui: UiManifest): { folders: string[]; files: string[] } {
  const folders = new Set<string>(); const files = new Set<string>();
  for (const e of uiEntries(ui)) {
    const parts = e.split(/[\\/]/);
    if (parts.length > 1) folders.add(parts[0]!); else files.add(parts[0]!);
  }
  return { folders: [...folders], files: [...files] };
}

const hidden = (seg: string) => seg.startsWith('.');

/** Every file the plugin's frames may load, as sorted plugin-relative paths (links that leave their folder left out). */
export async function uiFiles(dir: string, ui: UiManifest): Promise<string[]> {
  const out: string[] = [];
  const realDir = await fs.realpath(dir).catch(() => dir);
  const { folders, files } = uiRoots(ui);
  for (const f of files) { if (!hidden(f) && await servable(realDir, f, f)) out.push(f); }
  for (const top of folders) {
    if (hidden(top)) continue;
    const walk = async (rel: string, depth: number) => {
      if (depth > 12 || out.length >= MAX_FILES) return;
      const entries = await fs.readdir(path.join(realDir, rel), { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (hidden(e.name)) continue;
        const r = `${rel}/${e.name}`;
        if (e.isDirectory()) await walk(r, depth + 1);
        else if ((e.isFile() || e.isSymbolicLink()) && await servable(realDir, top, r)) out.push(r);
      }
    };
    await walk(top, 0);
  }
  return out.sort();
}

/** The real path of a file when it may be served (inside its UI folder after links, a regular file, not too big). */
async function servable(realDir: string, top: string, rel: string): Promise<string | undefined> {
  const real = await fs.realpath(path.join(realDir, rel)).catch(() => undefined);
  if (!real) return undefined;
  const rootReal = await fs.realpath(path.join(realDir, top)).catch(() => undefined);
  if (!rootReal || !within(realDir, rootReal)) return undefined;
  // A top-level entry is served alone; a folder's files must stay in that folder.
  if (top === rel ? real !== rootReal : !within(rootReal, real) || real === rootReal) return undefined;
  const st = await fs.stat(real).catch(() => undefined);
  return st?.isFile() && st.size <= MAX_FILE ? real : undefined;
}

/**
 * Resolves a requested UI path to the file to send, or says why not (404 for everything
 * refused: what exists outside the UI folders is nobody's business).
 */
export async function resolveUiFile(dir: string, ui: UiManifest, requested: string): Promise<{ file: string; type: string } | undefined> {
  let rel: string;
  try { rel = decodeURIComponent(requested); } catch { return undefined; }
  if (!rel || rel.includes('\0') || rel.includes('\\') || rel.startsWith('/') || /^[a-z]:/i.test(rel)) return undefined;
  const segs = rel.split('/');
  if (segs.some((s) => !s || s === '.' || s === '..' || hidden(s))) return undefined;
  const { folders, files } = uiRoots(ui);
  const top = segs[0]!;
  if (segs.length === 1 ? !files.includes(top) : !folders.includes(top)) return undefined;
  const realDir = await fs.realpath(dir).catch(() => undefined);
  if (!realDir) return undefined;
  const file = await servable(realDir, top, rel);
  return file ? { file, type: UI_MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' } : undefined;
}

/** sha256 over the ui section and every servable file (path and bytes), in path order. */
export async function uiHash(dir: string, ui: UiManifest, section: unknown): Promise<string> {
  const h = crypto.createHash('sha256');
  h.update(`ui\0${JSON.stringify(section)}\0`);
  const realDir = await fs.realpath(dir).catch(() => dir);
  for (const rel of await uiFiles(dir, ui)) {
    const data = await fs.readFile(path.join(realDir, rel)).catch(() => Buffer.alloc(0));
    h.update(`${rel}\0${data.length}\0`);
    h.update(data);
  }
  return h.digest('hex');
}

/**
 * The validated UI of a plugin from its manifest's `ui` section: `trust` is the most the
 * server allows it (native only for bundled or signature-verified plugins). A bad section
 * comes back as uiError and the plugin's server half loads as usual.
 */
export async function readPluginUi(dir: string, section: unknown, trust: UiTrust): Promise<PluginUi> {
  if (section === undefined) return {};
  try {
    const warnings: string[] = [];
    const ui = validateUiManifest(section, { trustCeiling: trust, warnings });
    return { ui, uiHash: await uiHash(dir, ui, section), ...(warnings.length ? { uiWarnings: warnings } : {}) };
  } catch (e) {
    return { uiError: (e as Error).message };
  }
}
