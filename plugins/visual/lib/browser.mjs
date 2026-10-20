// Headless Chromium for looking at what the agent made: one shared browser,
// a fresh context per call, the workspace served from 127.0.0.1 and every
// other request blocked. Pages run offline, so what passes here passes for a
// user without our network.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain',
};

export function chromiumPath() {
  if (process.env.HARNESS_CHROMIUM) return process.env.HARNESS_CHROMIUM;
  try {
    for (const d of fs.readdirSync('/opt/pw-browsers').filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
      const p = path.join('/opt/pw-browsers', d, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  } catch { /* not this layout */ }
  return undefined; // playwright-core's own lookup
}

let browserP = null;
let idle = null;
let users = 0;

async function launch() {
  let pw;
  try { pw = await import('playwright-core'); } catch { throw new Error('The browser tools need playwright-core (npm install in harness-web) and a Chromium build.'); }
  const chromium = pw.chromium ?? pw.default?.chromium;
  return chromium.launch({
    executablePath: chromiumPath(),
    // WebGL through SwiftShader: no GPU needed, same images on every server.
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
  });
}

export async function closeBrowser() {
  clearTimeout(idle);
  const b = await browserP?.catch(() => null);
  browserP = null;
  await b?.close().catch(() => {});
}

/** Runs fn with the shared browser; it closes two minutes after the last use. */
export async function withBrowser(fn) {
  users++;
  clearTimeout(idle);
  try {
    browserP ??= launch().catch((e) => { browserP = null; throw e; });
    const b = await browserP;
    if (!b.isConnected()) { browserP = null; return await withBrowser(fn); }
    return await fn(b);
  } finally {
    if (--users === 0) idle = setTimeout(async () => { const b = await browserP?.catch(() => null); browserP = null; await b?.close().catch(() => {}); }, 120_000).unref();
  }
}

/** Serves one directory on 127.0.0.1, confined to it (symlinks included). */
export async function serveDir(root) {
  const real = await fsp.realpath(root);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      let p = path.resolve(real, '.' + decodeURIComponent(url.pathname));
      let file = await fsp.realpath(p).catch(() => null);
      if (file && (await fsp.stat(file)).isDirectory()) file = await fsp.realpath(path.join(file, 'index.html')).catch(() => null);
      if (!file || (file !== real && !file.startsWith(real + path.sep))) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    } catch { res.writeHead(500).end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

const keyOf = (a) => Object.keys(a).find((k) => k !== 'hold' && k !== 'timeout' && k !== 'label');

/**
 * Opens a page from the workspace and drives it.
 * actions: [{wait: ms} | {press: key, hold?: ms} | {down: key} | {up: key} | {type: text}
 *   | {click: selector | [x, y]} | {move: [x, y]} | {drag: [[x1, y1], [x2, y2]]} | {scroll: dy}
 *   | {eval: js} | {waitFor: js, timeout?: ms} | {screenshot: label}]
 */
export async function runPage({ root, file = 'index.html', query = '', viewport = { width: 1280, height: 720 }, actions = [], evaluate, save, screenshot = true, fullPage = false, paged, waitMs = 1000, timeoutMs = 90_000, signal }) {
  const srv = await serveDir(root);
  const out = { url: '', title: '', console: [], errors: [], blocked: [], missing: [], evals: [], shots: [], result: undefined };
  try {
    return await withBrowser(async (browser) => {
      const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, serviceWorkers: 'block', acceptDownloads: false });
      const deadline = Date.now() + timeoutMs;
      const left = () => Math.max(1000, deadline - Date.now());
      const stop = () => ctx.close().catch(() => {});
      signal?.addEventListener('abort', stop, { once: true });
      try {
        await ctx.route('**/*', (route) => {
          const u = route.request().url();
          if (u.startsWith(srv.origin + '/')) return route.continue();
          if (out.blocked.length < 20) out.blocked.push(u.slice(0, 200));
          return route.abort('blockedbyclient');
        });
        await ctx.routeWebSocket?.(/.*/, (ws) => ws.close());
        const page = await ctx.newPage();
        page.on('console', (m) => {
          const t = m.type();
          if ((t === 'error' || t === 'warning') && out.console.length < 40) {
            const text = `${t}: ${m.text()}`.slice(0, 500);
            if (!out.console.includes(text)) out.console.push(text);
          }
        });
        page.on('pageerror', (e) => { if (out.errors.length < 20) out.errors.push(String(e?.stack ?? e).split('\n').slice(0, 4).join('\n').slice(0, 800)); });
        page.on('response', (r) => { if (r.status() >= 400 && r.url().startsWith(srv.origin) && out.missing.length < 20) out.missing.push(`${r.status()} ${r.url().slice(srv.origin.length)}`); });
        out.url = `${srv.origin}/${file.replace(/^\/+/, '')}${query}`;
        await page.goto(out.url, { waitUntil: 'load', timeout: Math.min(30_000, left()) });
        if (waitMs) await page.waitForTimeout(Math.min(waitMs, 15_000));
        let waited = 0;
        for (const a of actions.slice(0, 60)) {
          if (signal?.aborted || Date.now() > deadline) break;
          const k = keyOf(a);
          const v = a[k];
          switch (k) {
            case 'wait': { const ms = Math.min(Number(v) || 0, 30_000 - waited); waited += ms; await page.waitForTimeout(Math.max(0, ms)); break; }
            // Input is frame-synchronised: a game that reads keys once per frame sees every
            // press even when a busy machine renders few frames (a fixed 60 ms could fall between two).
            case 'press': await page.keyboard.down(String(v)); await frames(page); await page.waitForTimeout(Math.min(Number(a.hold) || 60, 10_000)); await page.keyboard.up(String(v)); await frames(page); break;
            case 'down': await page.keyboard.down(String(v)); await frames(page); break;
            case 'up': await page.keyboard.up(String(v)); await frames(page); break;
            case 'type': await page.keyboard.type(String(v), { delay: 20 }); await frames(page); break;
            case 'click': if (Array.isArray(v)) await page.mouse.click(Number(v[0]), Number(v[1])); else await page.click(String(v), { timeout: Math.min(10_000, left()) }); await frames(page); break;
            case 'move': await page.mouse.move(Number(v[0]), Number(v[1]), { steps: 5 }); break;
            case 'drag': await page.mouse.move(v[0][0], v[0][1]); await page.mouse.down(); await page.mouse.move(v[1][0], v[1][1], { steps: 10 }); await page.mouse.up(); break;
            case 'scroll': await page.mouse.wheel(0, Number(v) || 0); break;
            case 'eval': out.evals.push({ js: String(v).slice(0, 200), value: await safeEval(page, String(v)) }); break;
            case 'waitFor': await page.waitForFunction(String(v), undefined, { timeout: Math.min(Number(a.timeout) || 5000, left()) }).catch(() => out.evals.push({ js: String(v).slice(0, 200), value: 'waitFor timed out' })); break;
            case 'screenshot': out.shots.push({ label: String(v || `after step ${out.shots.length + 1}`), png: await shoot(page, fullPage, viewport, out) }); break;
            default: out.errors.push(`unknown action ${JSON.stringify(a).slice(0, 100)}`);
          }
        }
        out.title = await page.title().catch(() => '');
        if (evaluate) out.result = await safeEval(page, evaluate);
        if (save) out.saved = await saveFromPage(page, save);
        if (paged) {
          // Long pages as pages: slices of a fixed height, like a PDF, never one giant image.
          const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0));
          out.pageCount = Math.max(1, Math.min(50, Math.ceil(height / paged.height)));
          for (const n of paged.want(out.pageCount)) {
            const y = (n - 1) * paged.height;
            out.shots.push({ label: `page ${n}`, page: n, png: await page.screenshot({ fullPage: true, clip: { x: 0, y, width: viewport.width, height: Math.min(paged.height, height - y) } }) });
          }
        } else if (screenshot && !out.shots.length) out.shots.push({ label: 'final', png: await shoot(page, fullPage, viewport, out) });
        for (const s of out.shots) s.stats = await frameStats(ctx, s.png);
        return out;
      } finally {
        signal?.removeEventListener('abort', stop);
        await stop();
      }
    });
  } finally {
    await srv.close();
  }
}

/** Waits for the page to render n more animation frames (bounded, for pages that never draw). */
const frames = (page, n = 2) => page.evaluate((count) => new Promise((resolve) => {
  let left = count;
  const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
  setTimeout(resolve, 1000);
}), n).catch(() => {});

const MAX_SAVE = 50 * 1024 * 1024;

/**
 * Writes what a page expression returns to a file the caller already resolved
 * inside the workspace: a data: URL, a base64 string, or plain text.
 * For browser-only exporters (GLTFExporter, canvas.toDataURL, Blob output).
 */
async function saveFromPage(page, { file, js, encoding = 'auto' }) {
  let v;
  try {
    v = await page.evaluate(async (code) => {
      let r = await (0, eval)(code);
      if (r instanceof Blob) r = new Uint8Array(await r.arrayBuffer());
      if (r instanceof ArrayBuffer) r = new Uint8Array(r);
      if (ArrayBuffer.isView(r)) { let s = ''; const b = new Uint8Array(r.buffer, r.byteOffset, r.byteLength); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return { b64: btoa(s) }; }
      return typeof r === 'string' ? { str: r } : { str: JSON.stringify(r, null, 2) };
    }, js);
  } catch (e) { return { error: `save expression failed: ${String(e?.message ?? e).split('\n')[0].slice(0, 300)}` }; }
  let buf;
  const dataUrl = v.str && /^data:[^;,]+(;base64)?,/.exec(v.str);
  if (v.b64 !== undefined) buf = Buffer.from(v.b64, 'base64');
  else if (dataUrl) buf = dataUrl[1] ? Buffer.from(v.str.slice(dataUrl[0].length), 'base64') : Buffer.from(decodeURIComponent(v.str.slice(dataUrl[0].length)));
  else if (encoding === 'base64') buf = Buffer.from(v.str, 'base64');
  else buf = Buffer.from(v.str ?? '', 'utf8');
  if (buf.length > MAX_SAVE) return { error: `save output is ${buf.length} bytes (limit ${MAX_SAVE})` };
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, buf);
  return { bytes: buf.length };
}

/** Providers reject very tall images: a full-page shot stops at four screens and says so. */
async function shoot(page, fullPage, viewport, out) {
  if (!fullPage) return page.screenshot();
  const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0));
  const max = viewport.height * 4;
  if (height <= max) return page.screenshot({ fullPage: true });
  out.console.push(`note: the page is ${height}px tall; the screenshot shows the first ${max}px (scroll with actions to see the rest)`);
  return page.screenshot({ fullPage: true, clip: { x: 0, y: 0, width: viewport.width, height: max } });
}

async function safeEval(page, js) {
  try {
    const v = await page.evaluate(js);
    const s = v === undefined ? 'undefined' : JSON.stringify(v);
    return s.length > 4000 ? `${s.slice(0, 4000)}… [truncated]` : s;
  } catch (e) { return `error: ${String(e?.message ?? e).split('\n')[0].slice(0, 300)}`; }
}

/** Colour spread of a frame, from a 64x64 thumbnail: a blank or single-colour frame has almost none. */
export async function frameStats(ctx, png) {
  const p = await ctx.newPage();
  try {
    return await p.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = 64; c.height = 64;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0, 64, 64);
      const d = g.getImageData(0, 0, 64, 64).data;
      const colours = new Set();
      let sum = 0, sq = 0;
      for (let i = 0; i < d.length; i += 4) {
        const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        sum += l; sq += l * l;
        colours.add(((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4));
      }
      const n = d.length / 4;
      const mean = sum / n;
      const stddev = Math.sqrt(Math.max(0, sq / n - mean * mean));
      return { colours: colours.size, stddev: Math.round(stddev * 10) / 10, blank: colours.size <= 2 || stddev < 1.5 };
    }, png.toString('base64'));
  } finally { await p.close(); }
}

export function describePage(r) {
  const lines = [`Opened ${r.url.replace(/^http:\/\/127\.0\.0\.1:\d+\//, '')}${r.title ? ` ("${r.title}")` : ''}.`];
  lines.push(r.errors.length ? `Uncaught errors (${r.errors.length}):\n${r.errors.map((e) => `  ${e}`).join('\n')}` : 'No uncaught errors.');
  if (r.console.length) lines.push(`Console:\n${r.console.map((c) => `  ${c}`).join('\n')}`);
  if (r.missing.length) lines.push(`Missing files:\n${r.missing.map((m) => `  ${m}`).join('\n')}`);
  if (r.blocked.length) lines.push(`Blocked (pages run offline - put libraries in the workspace, e.g. with add_library):\n${r.blocked.map((b) => `  ${b}`).join('\n')}`);
  for (const e of r.evals) lines.push(`eval ${e.js} => ${e.value}`);
  if (r.result !== undefined) lines.push(`Result: ${r.result}`);
  if (r.saved) lines.push(r.saved.error ? `Save failed: ${r.saved.error}` : `Saved ${r.saved.label}: ${r.saved.bytes} bytes`);
  for (const s of r.shots) lines.push(`Screenshot "${s.label}": ${s.stats.blank ? 'BLANK (one colour - nothing was drawn)' : `${s.stats.colours} colours, contrast ${s.stats.stddev}`}`);
  return lines.join('\n');
}
