// Documents to page images, the way a reader will see them: office files
// through LibreOffice to PDF, PDF pages through poppler, web pages, SVG and
// Markdown through Chromium. Plus cheap checks a model without vision can use:
// page count, words per page, and text a slide drops because it does not fit.

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPage } from './browser.mjs';

export const OFFICE = ['.docx', '.doc', '.odt', '.rtf', '.pptx', '.ppt', '.odp', '.xlsx', '.xls', '.ods'];
export const WEB = ['.html', '.htm', '.svg'];
export const IMAGES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
export const RENDERABLE = [...OFFICE, ...WEB, '.pdf', '.md', ...Object.keys(IMAGES)];

// Converters get no network at all where the kernel allows it (documents can
// link remote images; a converter that fetches them is a request from the server).
let offline;
async function offlinePrefix() {
  offline ??= new Promise((resolve) => execFile('unshare', ['-rn', 'true'], { timeout: 5000 }, (err) => resolve(err ? null : ['unshare', '-rn'])));
  return offline;
}
export async function convertersOffline() { return !!(await offlinePrefix()); }

async function run(cmd, args, { timeoutMs = 120_000, signal, cwd } = {}) {
  const pre = process.env.HARNESS_RENDER_NETWORK === 'on' ? null : await offlinePrefix();
  if (pre) { args = [...pre.slice(1), cmd, ...args]; cmd = pre[0]; }
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, signal, cwd, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, HOME: os.tmpdir() } }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), error: err && typeof err.code !== 'number' ? String(err.message) : undefined });
    });
  });
}

/** "1-3,5" -> [1,2,3,5] within 1..total */
export function parsePages(spec, total, max) {
  if (!spec) return Array.from({ length: Math.min(total, max) }, (_, i) => i + 1);
  const out = new Set();
  for (const part of String(spec).split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]), b = Number(m[2] ?? m[1]);
    for (let i = Math.max(1, a); i <= Math.min(total, b); i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y).slice(0, max);
}

async function officeToPdf(file, tmp, signal) {
  const profile = path.join(tmp, 'lo-profile');
  const r = await run('soffice', ['--headless', '--norestore', '--nolockcheck', `-env:UserInstallation=file://${profile}`, '--convert-to', 'pdf', '--outdir', tmp, file], { timeoutMs: 180_000, signal });
  const pdf = path.join(tmp, `${path.basename(file, path.extname(file))}.pdf`);
  if (!(await fsp.stat(pdf).catch(() => null))) throw new Error(`LibreOffice could not convert ${path.basename(file)}${r.error ? ` (${r.error})` : ''}: ${(r.stderr || r.stdout).trim().slice(-400) || 'no output'}`);
  return pdf;
}

async function pdfInfo(pdf, signal) {
  const r = await run('pdfinfo', [pdf], { timeoutMs: 30_000, signal });
  if (r.code !== 0) throw new Error(`pdfinfo failed: ${r.stderr.trim().slice(0, 300)}`);
  const pages = Number(/Pages:\s+(\d+)/.exec(r.stdout)?.[1] ?? 0);
  const size = /Page size:\s+([\d.]+) x ([\d.]+) pts/.exec(r.stdout);
  return { pages, width: size ? Number(size[1]) : 0, height: size ? Number(size[2]) : 0 };
}

async function pageWords(pdf, n, signal) {
  const r = await run('pdftotext', ['-layout', '-f', String(n), '-l', String(n), pdf, '-'], { timeoutMs: 30_000, signal });
  const text = r.stdout.replace(/\f/g, '').trim();
  return { words: text ? text.split(/\s+/).length : 0, text };
}

/** Each slide's own text, from the .pptx, in presentation order. */
export async function pptxSlideTexts(file) {
  let JSZip;
  try { JSZip = (await import('jszip')).default; } catch { return null; }
  const zip = await JSZip.loadAsync(await fsp.readFile(file));
  const pres = await zip.file('ppt/presentation.xml')?.async('string');
  const rels = await zip.file('ppt/_rels/presentation.xml.rels')?.async('string');
  if (!pres || !rels) return null;
  const target = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [/Id="([^"]+)"/.exec(m[0])?.[1], /Target="([^"]+)"/.exec(m[0])?.[1]]));
  const ids = [...pres.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)].map((m) => m[1]);
  const texts = [];
  for (const id of ids) {
    const t = target.get(id);
    const xml = t ? await zip.file(path.posix.join('ppt', t.replace(/^\/?ppt\//, '')))?.async('string') : undefined;
    const runs = xml ? [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")) : [];
    texts.push(runs.join(' '));
  }
  return texts;
}

const words = (s) => (s.trim() ? s.trim().split(/\s+/).length : 0);

/**
 * Renders a workspace file. Returns page images (PNG) and per-page facts.
 * width: pixels across (default 1000); pages: "1-3,5" (default the first `max`).
 */
export async function renderFile({ root, rel, pages, width = 1000, max = 4, signal }) {
  const file = path.resolve(root, rel);
  const ext = path.extname(file).toLowerCase();
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hw-render-'));
  const result = { file: rel, kind: ext.slice(1), pages: 0, size: null, images: [], facts: [], warnings: [] };
  try {
    if (IMAGES[ext]) {
      result.pages = 1;
      result.images.push({ page: 1, media_type: IMAGES[ext], data: await fsp.readFile(file) });
      return result;
    }
    if (WEB.includes(ext) || ext === '.md') {
      let page = rel;
      if (ext === '.md') {
        // No --embed-resources: pandoc would fetch remote URLs from the server.
        // The HTML goes into the workspace and opens through the offline browser.
        const css = 'body{max-width:820px;margin:40px auto;padding:0 24px;font:16px/1.6 system-ui,sans-serif;color:#222}img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}pre{background:#f5f5f5;padding:8px;overflow:auto}';
        const r = await run('pandoc', ['-s', '--metadata', `pagetitle=${path.basename(rel)}`, '-t', 'html5', file], { cwd: path.dirname(file), signal });
        if (r.code !== 0) throw new Error(`pandoc failed: ${r.stderr.trim().slice(0, 400)}`);
        const dir = path.posix.dirname(rel.split(path.sep).join('/'));
        const base = `<base href="/${dir === '.' ? '' : `${dir.split('/').map(encodeURIComponent).join('/')}/`}"><style>${css}</style>`;
        const out = path.join(root, '.harness', 'render', '_md');
        await fsp.mkdir(out, { recursive: true });
        const name = `${rel.replace(/[^A-Za-z0-9._-]+/g, '_')}.html`;
        await fsp.writeFile(path.join(out, name), r.stdout.replace(/<head>/i, `<head>${base}`));
        page = `.harness/render/_md/${name}`;
      }
      const p = await runPage({ root, file: page, viewport: { width: Math.min(Math.max(width, 320), 1920), height: Math.round(width * 0.5625) }, fullPage: true, waitMs: 500, signal });
      result.pages = 1;
      result.images.push({ page: 1, media_type: 'image/png', data: p.shots[0].png });
      if (p.errors.length) result.warnings.push(`page errors: ${p.errors.join(' | ').slice(0, 400)}`);
      if (p.missing.length) result.warnings.push(`missing: ${p.missing.join(', ')}`);
      if (p.blocked.length) result.warnings.push(`blocked (offline): ${p.blocked.slice(0, 5).join(', ')}`);
      return result;
    }
    let pdf = file;
    if (OFFICE.includes(ext)) pdf = await officeToPdf(file, tmp, signal);
    else if (ext !== '.pdf') throw new Error(`Cannot render ${ext || 'files without an extension'}. Supported: ${RENDERABLE.join(' ')}`);
    const info = await pdfInfo(pdf, signal);
    result.pages = info.pages;
    result.size = info.width ? `${Math.round(info.width)} x ${Math.round(info.height)} pt` : null;
    result.pdf = pdf;
    const slides = ext === '.pptx' ? await pptxSlideTexts(file).catch(() => null) : null;
    for (let n = 1; n <= info.pages; n++) {
      const w = await pageWords(pdf, n, signal);
      const fact = { page: n, words: w.words };
      if (slides && slides[n - 1] !== undefined) {
        const own = words(slides[n - 1]);
        fact.slideWords = own;
        // LibreOffice drops text that falls outside the slide: fewer words on the page than in the slide means it did not fit.
        if (own >= 8 && w.words < own * 0.85) fact.overflow = `${own - w.words} of ${own} words do not fit on the slide`;
      }
      if (w.words === 0) fact.empty = true;
      result.facts.push(fact);
    }
    const want = parsePages(pages, info.pages, max);
    for (const n of want) {
      const base = path.join(tmp, `p${n}`);
      const r = await run('pdftoppm', ['-png', '-f', String(n), '-l', String(n), '-singlefile', '-scale-to-x', String(width), '-scale-to-y', '-1', pdf, base], { timeoutMs: 60_000, signal });
      if (r.code !== 0) { result.warnings.push(`page ${n} did not render: ${r.stderr.trim().slice(0, 200)}`); continue; }
      result.images.push({ page: n, media_type: 'image/png', data: await fsp.readFile(`${base}.png`) });
    }
    return result;
  } finally {
    if (!result.pdf || result.pdf === file) await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    else result.cleanup = () => fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/** Keeps copies a person can open: .harness/render/<name>/page-N.png (and the PDF of an office file). */
export async function saveRenders(root, r) {
  const name = r.file.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80);
  const dir = path.join(root, '.harness', 'render', name);
  await fsp.mkdir(dir, { recursive: true });
  const saved = [];
  for (const img of r.images) {
    const f = path.join(dir, `page-${img.page}.${img.media_type === 'image/png' ? 'png' : img.media_type.split('/')[1]}`);
    await fsp.writeFile(f, img.data);
    saved.push(path.relative(root, f));
  }
  if (r.pdf && r.pdf !== path.resolve(root, r.file)) {
    const f = path.join(dir, `${path.basename(r.file, path.extname(r.file))}.pdf`);
    await fsp.copyFile(r.pdf, f).catch(() => {});
    saved.push(path.relative(root, f));
  }
  await r.cleanup?.();
  return saved;
}

export function describeRender(r, saved) {
  const lines = [`${r.file}: ${r.pages} page(s)${r.size ? `, ${r.size}` : ''}.`];
  const flagged = r.facts.filter((f) => f.overflow || f.empty);
  for (const f of flagged) lines.push(`  page ${f.page}: ${f.overflow ? `TEXT DOES NOT FIT - ${f.overflow}` : 'no text on this page'}`);
  if (r.facts.length && !flagged.length) lines.push(`  text on every page${r.facts.some((f) => f.slideWords !== undefined) ? '; all slide text fits' : ''}.`);
  if (r.facts.length) lines.push(`  words per page: ${r.facts.map((f) => f.words).join(', ')}`);
  for (const w of r.warnings) lines.push(`  warning: ${w}`);
  if (r.images.length) lines.push(`Showing page(s) ${r.images.map((i) => i.page).join(', ')}${r.pages > r.images.length ? ` of ${r.pages} (ask for others with pages: "5-8")` : ''}. Saved: ${saved.join(', ')}`);
  return lines.join('\n');
}

export const tmpId = () => crypto.randomUUID().slice(0, 8);
