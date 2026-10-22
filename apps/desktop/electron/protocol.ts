/**
 * harness:// - the origin the interface runs on, and the preview origin.
 *
 *   harness://app/api/...          the engine (local or remote), with its token attached; streamed
 *                                  both ways so event streams arrive as they are written. Only the
 *                                  app's own fetches get through (policy.ts apiRequestAllowed).
 *   harness://app/plugins/<n>/<f>  a plugin's UI file: from a desktop dev plugin's folder, else the
 *                                  engine's GET /api/plugins/<n>/ui/<f>; always under the plugin CSP.
 *   harness://app/sdk/...          the plugin SDK frames load (built from @harness/plugin-ui).
 *   harness://app/...              the renderer's files; unknown paths fall back to index.html.
 *   harness://preview/<token>/...  an artifact preview the window registered (preview.ts).
 *
 * The renderer never sees a token: the proxy replaces whatever the request carried.
 */

import { protocol } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { APP_CSP, APP_HOST, PREVIEW_HOST, SCHEME, STRIPPED_REQUEST_HEADERS, STRIPPED_RESPONSE_HEADERS, apiRequestAllowed, pluginCsp, pluginFilePath } from './policy';
import type { EngineEndpoint } from './engine-host';
import type { DevPlugins } from './dev-plugins';
import { previewResponse } from './preview';

export function registerSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, codeCache: true } }]);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json',
  '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};
export const mimeOf = (f: string): string => MIME[path.extname(f).toLowerCase()] ?? 'application/octet-stream';

function inside(root: string, rel: string): string | null {
  const target = path.resolve(root, `.${path.sep}${rel}`);
  const r = path.resolve(root);
  return target === r || target.startsWith(r + path.sep) ? target : null;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-content-type-options': 'nosniff' } });
}

export interface ProtocolOptions {
  rendererDir: string;
  sdkDir: string;
  /** The engine's endpoint (waits while it starts). */
  endpoint: () => Promise<EngineEndpoint>;
  devPlugins: DevPlugins;
}

export function handleProtocol(o: ProtocolOptions): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host === PREVIEW_HOST) return previewResponse(url, o.rendererDir);
    if (url.host !== APP_HOST) return new Response('Not found', { status: 404 });
    let pathname: string;
    try { pathname = decodeURIComponent(url.pathname); } catch { return new Response('Bad request', { status: 400 }); }

    if (pathname.startsWith('/api/') || pathname.startsWith('/auth/')) {
      const allowed = apiRequestAllowed(request.headers);
      if (!allowed.ok) return json(403, { error: allowed.reason });
      return proxy(request, url, o.endpoint);
    }

    if (pathname.startsWith('/plugins/')) {
      const p = pluginFilePath(url.pathname);
      if (!p) return new Response('Not found', { status: 404 });
      const headers = { 'content-security-policy': pluginCsp(p.plugin), 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache', 'referrer-policy': 'no-referrer' };
      const local = o.devPlugins.file(p.plugin, p.file);
      if (local) {
        if (!fs.existsSync(local) || !fs.statSync(local).isFile()) return new Response('Not found', { status: 404, headers });
        return new Response(fs.readFileSync(local), { status: 200, headers: { ...headers, 'content-type': mimeOf(local) } });
      }
      // The engine serves an installed plugin's UI files (GET /api/plugins/<name>/ui/<path>).
      try {
        const e = await o.endpoint();
        const target = new URL(`/api/plugins/${encodeURIComponent(p.plugin)}/ui/${p.file.split('/').map(encodeURIComponent).join('/')}`, e.origin);
        const res = await fetch(target, { headers: { authorization: `Bearer ${e.token}` }, redirect: 'manual' });
        if (!res.ok) return new Response('Not found', { status: res.status === 404 ? 404 : 502, headers });
        return new Response(Buffer.from(await res.arrayBuffer()), { status: 200, headers: { ...headers, 'content-type': mimeOf(p.file) } });
      } catch (err) {
        return new Response(`The engine did not answer: ${(err as Error).message}`, { status: 502, headers });
      }
    }

    if (pathname.startsWith('/sdk/')) {
      const file = inside(o.sdkDir, pathname.slice('/sdk/'.length));
      if (!file || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
      return new Response(fs.readFileSync(file), { status: 200, headers: { 'content-type': mimeOf(file), 'cache-control': 'no-cache', 'access-control-allow-origin': '*' } });
    }

    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    let file = inside(o.rendererDir, rel);
    if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(o.rendererDir, 'index.html');
    const headers: Record<string, string> = { 'content-type': mimeOf(file), 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' };
    if (file.endsWith('.html')) headers['content-security-policy'] = APP_CSP;
    return new Response(fs.readFileSync(file), { status: 200, headers });
  });
}

async function proxy(request: Request, url: URL, endpoint: () => Promise<EngineEndpoint>): Promise<Response> {
  let e: EngineEndpoint;
  try { e = await endpoint(); } catch (err) { return json(503, { error: (err as Error).message, engine: 'unavailable' }); }
  const target = new URL(url.pathname + url.search, e.origin);
  target.searchParams.delete('token');
  const headers = new Headers();
  for (const [k, v] of request.headers) if (!STRIPPED_REQUEST_HEADERS.includes(k.toLowerCase()) && !k.toLowerCase().startsWith('sec-')) headers.set(k, v);
  headers.set('authorization', `Bearer ${e.token}`);
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  try {
    const upstream = await fetch(target, { method: request.method, headers, body: hasBody ? await request.arrayBuffer() : undefined, signal: request.signal, redirect: 'manual' });
    const out = new Headers(upstream.headers);
    for (const h of STRIPPED_RESPONSE_HEADERS) out.delete(h);
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
  } catch (err) {
    if ((err as Error).name === 'AbortError') return new Response(null, { status: 499 });
    return json(502, { error: `The engine did not answer: ${(err as Error).message}`, engine: 'unreachable' });
  }
}
