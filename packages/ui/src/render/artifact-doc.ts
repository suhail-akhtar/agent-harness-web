/**
 * The documents HTML, SVG and React artifacts are previewed in. Pure (tested): the component in
 * Artifact.tsx frames what this builds.
 *
 * The frame is always `sandbox` without `allow-same-origin` (an opaque origin: no cookies, no
 * storage, no access to the app's DOM), and the document carries its own CSP: no network at all
 * (`connect-src 'none'`), no forms, no nested frames, no <base>. HTML and React get scripts
 * (`allow-scripts`) because a live preview is the point; SVG gets none.
 */

export type ArtifactKind = 'html' | 'svg' | 'react';

export function artifactCsp(scripts: boolean, runtime?: string): string {
  return [
    "default-src 'none'",
    scripts ? `script-src 'unsafe-inline'${runtime ? ` ${runtime}` : ''}` : "script-src 'none'",
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
  ].join('; ');
}

const BASE_STYLE = `:root { color-scheme: light; }
body { margin: 12px; font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif; color: #1a1a1a; background: #fff; }
table { border-collapse: collapse; } th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; }
img, svg, video, canvas { max-width: 100%; height: auto; } pre { overflow-x: auto; }`;

/** Reports the document's height to the host so the frame can fit it (postMessage is the only channel). */
const SIZE_REPORTER = `<script>(function(){var last=0;function send(){var h=Math.ceil(Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0));if(h!==last){last=h;parent.postMessage({harnessArtifact:'size',height:h},'*');}}addEventListener('load',send);try{new ResizeObserver(send).observe(document.documentElement);}catch(e){setInterval(send,500);}send();})();</script>`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** The document for an artifact. `runtimeUrl` is the React runtime script (React artifacts only). */
export function artifactDocument(kind: ArtifactKind, source: string, opts: { runtimeUrl?: string } = {}): string {
  if (kind === 'svg') {
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${artifactCsp(false)}"><style>html,body{margin:0;height:100%;background:#fff}body{display:flex;align-items:center;justify-content:center}svg{max-width:100%;max-height:100%}</style></head><body>${source}</body></html>`;
  }
  if (kind === 'react') {
    const runtime = opts.runtimeUrl;
    const origin = runtime ? runtime.replace(/[^/]*$/, '') : undefined;
    const b64 = btoa(unescape(encodeURIComponent(source)));
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${esc(artifactCsp(true, origin))}"><style>${BASE_STYLE}</style></head><body><div id="root"></div>${runtime ? `<script src="${esc(runtime)}"></script>` : ''}<script id="artifact-source" type="text/plain" data-b64="${b64}"></script><script>(function(){var el=document.getElementById('artifact-source');var code=decodeURIComponent(escape(atob(el.getAttribute('data-b64'))));if(!window.HarnessArtifact){document.getElementById('root').textContent='This preview needs the app (the React runtime is not available here).';return;}window.HarnessArtifact.mount(code,document.getElementById('root'));})();</script>${SIZE_REPORTER}</body></html>`;
  }
  // html: a fragment gets a minimal document; a whole document keeps its <head> plus our CSP.
  const csp = `<meta http-equiv="Content-Security-Policy" content="${esc(artifactCsp(true))}">`;
  if (/<html[\s>]/i.test(source)) {
    const withCsp = /<head[^>]*>/i.test(source) ? source.replace(/<head[^>]*>/i, (m) => `${m}\n${csp}`) : source.replace(/<html[^>]*>/i, (m) => `${m}<head>${csp}</head>`);
    return withCsp.replace(/<\/body>/i, `${SIZE_REPORTER}</body>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${csp}<style>${BASE_STYLE}</style></head><body>${source}${SIZE_REPORTER}</body></html>`;
}

/** The sandbox attribute for an artifact frame: never allow-same-origin. */
export function artifactSandbox(kind: ArtifactKind): string { return kind === 'svg' ? '' : 'allow-scripts'; }
