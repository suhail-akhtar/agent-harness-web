// PDF pages without poppler: pdf.js reads the facts (page count, size, every
// word with its font size) in Node, and draws pages in the headless Chromium
// the browser tool already uses. So a PDF, HTML or Markdown file needs nothing
// installed beyond Chromium; only Office files still need LibreOffice.

import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { withBrowser } from './browser.mjs';

const require = createRequire(import.meta.url);

/** The pdf.js build folder, or null when pdfjs-dist is not installed. */
export function pdfjsDir() {
  try { return path.dirname(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')); } catch { return null; }
}

async function open(data) {
  const pdfjs = await import(path.join(pdfjsDir(), 'pdf.mjs'));
  const fonts = path.join(pdfjsDir(), '..', '..', 'standard_fonts') + path.sep;
  return pdfjs.getDocument({ data: new Uint8Array(data), standardFontDataUrl: fonts, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
}

/**
 * Page count, the first page's size in points, and per page the words and
 * their font sizes (points) - what the slide-fit and text-size checks use.
 */
export async function pdfFacts(file) {
  const task = await open(await fsp.readFile(file));
  const doc = await task.promise;
  try {
    const first = await doc.getPage(1);
    const vp = first.getViewport({ scale: 1 });
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = n === 1 ? first : await doc.getPage(n);
      const tc = await page.getTextContent();
      const sizes = [];
      for (const it of tc.items) {
        if (!('str' in it) || !it.str.trim()) continue;
        // Font size: the text matrix's vertical scale (item.height is the same, when set).
        const size = Math.hypot(it.transform[2], it.transform[3]) || it.height;
        for (const _w of it.str.trim().split(/\s+/)) sizes.push(size);
      }
      pages.push({ page: n, words: sizes.length, sizes });
      page.cleanup();
    }
    return { pages: doc.numPages, width: vp.width, height: vp.height, perPage: pages };
  } finally {
    await task.destroy();
  }
}

/**
 * PNG images of the given pages, `width` pixels across, drawn by pdf.js in
 * Chromium. The PDF and pdf.js are served to the page from memory; nothing
 * else is reachable from it.
 */
export async function renderPdfPages(file, pageNumbers, width, { signal } = {}) {
  const dir = pdfjsDir();
  const pdf = await fsp.readFile(file);
  const files = {
    '/pdf.mjs': await fsp.readFile(path.join(dir, 'pdf.mjs')),
    '/pdf.worker.mjs': await fsp.readFile(path.join(dir, 'pdf.worker.mjs')),
    '/doc.pdf': pdf,
  };
  const html = `<!doctype html><html><body style="margin:0;background:#fff"><canvas id="c"></canvas><script type="module">
    import * as pdfjs from '/pdf.mjs';
    pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.mjs';
    const doc = await pdfjs.getDocument({ url: '/doc.pdf', standardFontDataUrl: '/fonts/', isEvalSupported: false }).promise;
    window.renderPage = async (n, width) => {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: width / base.width });
      const c = document.getElementById('c');
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      return [c.width, c.height];
    };
    window.ready = true;
  </script></body></html>`;
  const mime = { '.mjs': 'text/javascript', '.pdf': 'application/pdf', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf' };
  return withBrowser(async (browser) => {
    const ctx = await browser.newContext({ viewport: { width: Math.max(320, width), height: Math.round(width * 1.5) }, deviceScaleFactor: 1 });
    const out = [];
    try {
      await ctx.route('**/*', async (route) => {
        const u = new URL(route.request().url());
        if (u.host !== 'render.local') return route.abort();
        if (u.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
        if (files[u.pathname]) return route.fulfill({ status: 200, contentType: mime[path.extname(u.pathname)] ?? 'application/octet-stream', body: files[u.pathname] });
        if (u.pathname.startsWith('/fonts/')) {
          const name = path.basename(u.pathname);
          const f = path.join(dir, '..', '..', 'standard_fonts', name);
          const body = await fsp.readFile(f).catch(() => null);
          return body ? route.fulfill({ status: 200, contentType: mime[path.extname(name)] ?? 'application/octet-stream', body }) : route.fulfill({ status: 404, body: '' });
        }
        return route.fulfill({ status: 404, body: '' });
      });
      const page = await ctx.newPage();
      await page.goto('http://render.local/', { timeout: 60_000 });
      await page.waitForFunction(() => window.ready === true, null, { timeout: 60_000 });
      for (const n of pageNumbers) {
        if (signal?.aborted) break;
        const [w, h] = await page.evaluate(([p, wd]) => window.renderPage(p, wd), [n, width]);
        await page.setViewportSize({ width: w, height: h });
        out.push({ page: n, png: await page.locator('#c').screenshot({ type: 'png' }) });
      }
    } finally {
      await ctx.close().catch(() => {});
    }
    return out;
  });
}
