import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DATA_VISUALS, type DocSpec, formatValue, type QueryResult, type Scalar } from '../../packages/plugin-ui/src/bi.ts';
import { DataError } from './engine.ts';
import type { DataHome } from './home.ts';
import { OWNER, type DataService } from './service.ts';
import { visualData } from './analytics.ts';
import { writeXlsx } from './xlsx.ts';

// Exports: a workbook (a sheet per visual), CSV (one visual), a static site (the viewer bundle and
// a snapshot of every visual's numbers: it looks the same as the app, without a server), and PDF
// or PNG rendered from that site by headless Chromium (paginated: page header and footer, table
// headers repeated on every page).

export type ExportFormat = 'xlsx' | 'csv' | 'html' | 'pdf' | 'png';

const csvCell = (v: Scalar) => { if (v === null || v === undefined) return ''; const s = String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function toCsv(r: QueryResult): string { return [r.columns.map((c) => csvCell(c.label || c.name)), ...r.rows.map((row) => row.map(csvCell))].map((l) => l.join(',')).join('\r\n') + '\r\n'; }

/** Where the viewer bundle is (built by apps/desktop/scripts/build-viewer.mjs). */
export function viewerDir(appRoot: string): string | undefined {
  for (const d of [path.join(appRoot, 'dist', 'bi-viewer'), path.resolve(import.meta.dirname, '..', '..', 'dist', 'bi-viewer')]) if (fsSync.existsSync(path.join(d, 'viewer.js'))) return d;
  return undefined;
}

/** Every data visual's numbers now (the default state). */
export async function allResults(svc: DataService, home: DataHome, doc: DocSpec): Promise<Record<string, QueryResult>> {
  const out: Record<string, QueryResult> = {};
  const cat = (await home.catalog()).spec;
  for (const p of doc.pages) for (const v of p.visuals) {
    if (!DATA_VISUALS.has(v.type)) continue;
    try { out[v.id] = await visualData(svc, home, doc, v, { page: p.id }, OWNER, { catalog: cat }); } catch (e) { out[v.id] = { columns: [], rows: [], rowCount: 0, hash: '', ms: 0, at: Date.now(), lineage: { datasets: [] }, extra: { error: (e as Error).message } }; }
  }
  return out;
}

/** A self-contained folder: index.html, the viewer, data.js with the document and its numbers. */
export async function staticSite(svc: DataService, home: DataHome, id: string, dir: string, appRoot = process.cwd()): Promise<string> {
  const vd = viewerDir(appRoot);
  if (!vd) throw new DataError('the dashboard viewer is not built here (node apps/desktop/scripts/build-viewer.mjs)', 503);
  const { spec } = await home.doc(id);
  const results = await allResults(svc, home, spec);
  // Strip what a static copy must not carry: SQL, source details.
  for (const r of Object.values(results)) r.lineage = { datasets: r.lineage.datasets.map(({ name, refreshedAt, rows, static: st, origin }) => ({ name, refreshedAt, rows, ...(st ? { static: st, origin } : {}) })) };
  await fs.mkdir(dir, { recursive: true });
  for (const f of await fs.readdir(vd)) await fs.cp(path.join(vd, f), path.join(dir, f), { recursive: true });
  const data = { doc: { ...spec, snapshot: { at: Date.now(), results } }, exportedAt: Date.now() };
  await fs.writeFile(path.join(dir, 'data.js'), `window.__BI_STATIC__ = ${JSON.stringify(data).replace(/</g, '\\u003c')};\n`);
  await fs.writeFile(path.join(dir, 'index.html'), viewerHtml(spec.title, { staticData: true }));
  return dir;
}

/** The viewer page (published or static): the same renderers as the app. */
export function viewerHtml(title: string, o: { staticData?: boolean; base?: string } = {}): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const b = o.base ?? '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<link rel="stylesheet" href="${b}viewer.css"></head>
<body><div id="root" data-bi-viewer></div>${o.staticData ? `<script src="${b}data.js"></script>` : ''}<script type="module" src="${b}viewer.js"></script></body></html>
`;
}

let chromium: Promise<import('playwright-core').Browser> | undefined;
function browserPath(): string | undefined {
  if (process.env.HARNESS_CHROMIUM) return process.env.HARNESS_CHROMIUM;
  try { const p = (createRequire(import.meta.url)('playwright-core') as typeof import('playwright-core')).chromium.executablePath(); if (p && fsSync.existsSync(p)) return p; } catch { /* not installed */ }
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright') : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright') : path.join(os.homedir(), '.cache', 'ms-playwright'), '/opt/pw-browsers'].filter(Boolean) as string[];
  for (const r of roots) {
    const builds = (fsSync.existsSync(r) ? fsSync.readdirSync(r) : []).filter((x) => /^chromium-\d+$/.test(x)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const b of builds) for (const exe of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) { const p = path.join(r, b, ...exe.split('/')); if (fsSync.existsSync(p)) return p; }
  }
  return undefined;
}
async function browser(): Promise<import('playwright-core').Browser> {
  return (chromium ??= (async () => {
    let pw: typeof import('playwright-core');
    try { pw = await import('playwright-core'); } catch { throw new DataError('PDF and PNG exports need playwright-core and a Chromium build', 503); }
    const exe = browserPath();
    if (!exe) throw new DataError('PDF and PNG exports need a Chromium build (npx playwright-core install chromium, or HARNESS_CHROMIUM)', 503);
    const b = await pw.chromium.launch({ executablePath: exe, args: ['--disable-dev-shm-usage'] });
    b.on('disconnected', () => { chromium = undefined; });
    return b;
  })().catch((e) => { chromium = undefined; throw e; }));
}
export async function closeExportBrowser(): Promise<void> { const b = await chromium?.catch(() => undefined); chromium = undefined; await b?.close().catch(() => {}); }

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
/** A folder over http on 127.0.0.1 (an ephemeral port): files only, nothing outside it. */
async function serveDir(dir: string): Promise<{ url: string; close(): void }> {
  const http = await import('node:http');
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    const f = path.resolve(root, decodeURIComponent((req.url ?? '/').split('?')[0]!.replace(/^\/+/, '')) || 'index.html');
    if (!f.startsWith(root + path.sep)) { res.writeHead(404); res.end(); return; }
    fs.readFile(f).then((b) => { res.writeHead(200, { 'content-type': TYPES[path.extname(f)] ?? 'application/octet-stream' }); res.end(b); }, () => { res.writeHead(404); res.end(); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => { server.closeAllConnections(); server.close(); } };
}

/** Renders a static site to PDF (paginated, print styles) or PNG (the first page, full height). */
async function render(dir: string, out: string, format: 'pdf' | 'png', title: string, paged = false): Promise<void> {
  const b = await browser();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: format === 'png' ? 2 : 1 });
  try {
    const page = await ctx.newPage();
    // The site from a loopback port of its own (module scripts do not load from file://); nothing else is reachable.
    const site = await serveDir(dir);
    page.on('close', () => site.close());
    await page.route((u) => !u.href.startsWith(site.url), (r) => r.abort());
    await page.goto(`${site.url}/index.html${format === 'pdf' ? '?print=1' : ''}`);
    await page.waitForSelector('[data-bi-ready="1"]', { timeout: 60_000 });
    await page.waitForTimeout(400);
    if (format === 'png') await page.screenshot({ path: out, fullPage: true });
    else if (paged) {
      // Print layouts draw their own paper pages (size, headers, footers): the PDF takes them as they are.
      await page.pdf({ path: out, preferCSSPageSize: true, printBackground: true });
    } else {
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      await page.pdf({ path: out, format: 'A4', landscape: true, printBackground: true, displayHeaderFooter: true, margin: { top: '18mm', bottom: '16mm', left: '10mm', right: '10mm' },
        headerTemplate: `<div style="font:9px sans-serif;width:100%;padding:0 10mm;color:#555">${title.replace(/</g, '&lt;')}</div>`,
        footerTemplate: `<div style="font:9px sans-serif;width:100%;padding:0 10mm;color:#555;display:flex;justify-content:space-between"><span>${stamp}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>` });
    }
  } finally { await ctx.close(); }
}

/** Exports a document into the person's exports folder. */
export async function exportDoc(svc: DataService, home: DataHome, id: string, format: ExportFormat, o: { visual?: string; appRoot?: string } = {}): Promise<{ file: string; path: string; bytes: number; contentType: string }> {
  const { spec } = await home.doc(id);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const base = `${spec.title.replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || id}-${stamp}`;
  const dir = home.path('exports');
  await fs.mkdir(dir, { recursive: true });
  let file: string; let contentType: string;
  if (format === 'xlsx' || format === 'csv') {
    const results = await allResults(svc, home, spec);
    const vis = spec.pages.flatMap((p) => p.visuals).filter((v) => results[v.id] && results[v.id]!.columns.length);
    if (format === 'csv') {
      const v = o.visual ? vis.find((x) => x.id === o.visual) : vis[0];
      if (!v) throw new DataError(o.visual ? `no data visual ${o.visual}` : 'no data visual to export');
      file = `${base}-${v.id}.csv`; contentType = 'text/csv; charset=utf-8';
      await fs.writeFile(path.join(dir, file), toCsv(results[v.id]!));
    } else {
      file = `${base}.xlsx`; contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      await fs.writeFile(path.join(dir, file), writeXlsx(vis.map((v) => ({ name: v.title ?? v.id, columns: results[v.id]!.columns.map((c) => c.label || c.name), rows: results[v.id]!.rows }))));
    }
  } else {
    const site = path.join(dir, `${base}-site`);
    await staticSite(svc, home, id, site, o.appRoot);
    if (format === 'html') { file = `${base}-site`; contentType = 'inode/directory'; }
    else {
      file = `${base}.${format}`; contentType = format === 'pdf' ? 'application/pdf' : 'image/png';
      await render(site, path.join(dir, file), format, spec.title, spec.pages.some((p) => p.layout?.type === 'print'));
      await fs.rm(site, { recursive: true, force: true });
    }
  }
  const p = path.join(dir, file);
  const st = await fs.stat(p);
  return { file, path: p, bytes: st.isDirectory() ? 0 : st.size, contentType };
}

export const fmt = formatValue;
