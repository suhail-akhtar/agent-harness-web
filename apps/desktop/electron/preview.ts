/**
 * Artifact previews on their own origin: harness://preview/<token>/index.html.
 *
 * A srcdoc frame inherits the app's CSP (which refuses inline script), so an HTML or React artifact
 * that should run is registered here by the window (preview:register) and framed from this origin,
 * always with sandbox="allow-scripts" and never allow-same-origin, under previewCsp: no network,
 * no forms, no frames, framed only by the app. The React runtime is the one file besides the page.
 * The registry is in memory; tokens are unguessable; the oldest are forgotten past 200.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PREVIEW_ORIGIN, previewCsp } from './policy';

const pages = new Map<string, string>();
const MAX = 200;

export function registerPreviewHtml(html: unknown): { url: string } {
  if (typeof html !== 'string' || !html) throw new Error('html is required');
  if (html.length > 5_000_000) throw new Error('the page is too large to preview');
  const token = crypto.randomBytes(18).toString('base64url');
  pages.set(token, html);
  while (pages.size > MAX) pages.delete(pages.keys().next().value!);
  return { url: `${PREVIEW_ORIGIN}/${token}/index.html` };
}

export const RUNTIME_URL = `${PREVIEW_ORIGIN}/runtime/artifact-runtime.js`;

export function previewResponse(url: URL, rendererDir: string): Response {
  const parts = url.pathname.replace(/^\/+/, '').split('/');
  const token = parts[0] ?? '';
  const rest = parts.slice(1).join('/');
  const base = { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
  if (token === 'runtime' && rest === 'artifact-runtime.js') {
    const file = path.join(rendererDir, 'artifact-runtime.js');
    if (!fs.existsSync(file)) return new Response('Not found', { status: 404 });
    return new Response(fs.readFileSync(file), { status: 200, headers: { ...base, 'content-type': 'text/javascript; charset=utf-8', 'access-control-allow-origin': '*' } });
  }
  const html = pages.get(token);
  if (!html || rest !== 'index.html') return new Response('Not found', { status: 404, headers: base });
  return new Response(html, { status: 200, headers: { ...base, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': previewCsp(token) } });
}
