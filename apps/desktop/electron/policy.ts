/**
 * The harness:// scheme's rules as data and pure functions (no Electron, unit-tested):
 *  - the content-security policies of the app, of plugin UI files and of artifact previews;
 *  - which requests may reach the engine through the proxy (only the app's own fetches);
 *  - which frames IPC answers (only the app's top frame);
 *  - which paths a plugin file request may name.
 */

export const SCHEME = 'harness';
export const APP_HOST = 'app';
export const APP_ORIGIN = `${SCHEME}://${APP_HOST}`;
export const PREVIEW_HOST = 'preview';
export const PREVIEW_ORIGIN = `${SCHEME}://${PREVIEW_HOST}`;

/** The renderer's own policy. */
export const APP_CSP = [
  `default-src 'self' ${APP_ORIGIN}`,
  `script-src 'self' ${APP_ORIGIN} 'wasm-unsafe-eval'`,
  // KaTeX, Mermaid, ECharts and React style props write inline styles.
  `style-src 'self' ${APP_ORIGIN} 'unsafe-inline'`,
  `font-src 'self' ${APP_ORIGIN} data:`,
  `img-src 'self' ${APP_ORIGIN} data: blob: https: http:`,
  `media-src 'self' ${APP_ORIGIN} data: blob:`,
  `connect-src 'self' ${APP_ORIGIN}`,
  // Plugin frames are served from harness://app/plugins/..., artifact previews from harness://preview/.
  `frame-src 'self' ${APP_ORIGIN} ${PREVIEW_ORIGIN} blob:`,
  `worker-src 'self' ${APP_ORIGIN} blob:`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * A plugin's UI files: its scripts and the SDK may run, inside an opaque-origin sandbox, with no
 * connections at all (the SDK talks to the host by postMessage only), no forms that post anywhere,
 * and nothing from the app's API paths.
 */
export function pluginCsp(plugin: string): string {
  const own = `${APP_ORIGIN}/plugins/${encodeURIComponent(plugin)}/`;
  const sdk = `${APP_ORIGIN}/sdk/`;
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${own} ${sdk}`,
    `style-src 'unsafe-inline' ${own}`,
    `img-src ${own} data: blob: https:`,
    `font-src ${own} data:`,
    `media-src ${own} data: blob:`,
    "connect-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    `frame-ancestors ${APP_ORIGIN}`,
    'sandbox allow-scripts allow-forms',
  ].join('; ');
}

/** Artifact previews (harness://preview/<token>/...): inline script and the React runtime only, no network. */
export function previewCsp(token: string): string {
  const own = `${PREVIEW_ORIGIN}/${token}/`;
  const runtime = `${PREVIEW_ORIGIN}/runtime/`;
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${own} ${runtime}`,
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    'media-src data: blob:',
    "connect-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    `frame-ancestors ${APP_ORIGIN}`,
    'sandbox allow-scripts',
  ].join('; ');
}

/**
 * May this request go to the engine? Only the app's own fetches: an <img>, a script, a frame or a
 * form aimed at harness://app/api/... is refused (those are how a sandboxed page would reach the API
 * without fetch), and so is anything that says it comes from another origin (an opaque frame sends
 * "Origin: null").
 */
export function apiRequestAllowed(h: { get(name: string): string | null }): { ok: true } | { ok: false; reason: string } {
  const dest = h.get('sec-fetch-dest');
  if (dest && dest !== 'empty') return { ok: false, reason: `a ${dest} request cannot reach the API` };
  const origin = h.get('origin');
  if (origin !== null && origin !== APP_ORIGIN) return { ok: false, reason: `requests from ${origin} cannot reach the API` };
  const site = h.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return { ok: false, reason: 'cross-site requests cannot reach the API' };
  return { ok: true };
}

/** Request headers the proxy never forwards from the renderer (main sets its own). */
export const STRIPPED_REQUEST_HEADERS = ['authorization', 'cookie', 'host', 'origin', 'referer', 'x-harness-cluster-auth', 'x-harness-forwarded', 'x-harness-route-token'];
/** Response headers the proxy drops. */
export const STRIPPED_RESPONSE_HEADERS = ['set-cookie', 'content-encoding', 'content-length', 'transfer-encoding', 'connection'];

/** Only the top frame of a page on harness://app may use IPC (never a plugin frame or a preview). */
export function appFrameAllowed(frame: { url: string; isTopFrame: boolean } | null): boolean {
  if (!frame || !frame.isTopFrame) return false;
  try { const u = new URL(frame.url); return u.protocol === `${SCHEME}:` && u.host === APP_HOST; } catch { return false; }
}

/** Splits /plugins/<name>/<path> into its parts, refusing anything that could leave the plugin's folder. */
export function pluginFilePath(pathname: string): { plugin: string; file: string } | null {
  const m = /^\/plugins\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/(.+)$/.exec(pathname);
  if (!m) return null;
  const segs: string[] = [];
  for (const raw of m[2]!.split('/')) {
    let s: string;
    try { s = decodeURIComponent(raw); } catch { return null; }
    if (!s || s === '.' || s === '..' || /[\\:\0]/.test(s)) return null;
    segs.push(s);
  }
  return { plugin: m[1]!, file: segs.join('/') };
}

/** A deep link (harness://open?session=..., harness://new?prompt=...) as an action the window understands. */
export function parseDeepLink(raw: string): { action: string; params: Record<string, string> } | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== `${SCHEME}:`) return null;
  if (u.host === APP_HOST || u.host === PREVIEW_HOST) return null;
  const action = (u.host || u.pathname.replace(/^\/+/, '')).split('/')[0]!.toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(action)) return null;
  const params: Record<string, string> = {};
  for (const [k, v] of u.searchParams) if (/^[a-zA-Z0-9_-]{1,32}$/.test(k)) params[k] = v.slice(0, 2000);
  return { action, params };
}
