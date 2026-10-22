/**
 * The documents HTML, SVG and React artifacts are previewed in. Pure (tested): the component in
 * Artifact.tsx frames what this builds.
 *
 * The frame is always `sandbox` without `allow-same-origin` (an opaque origin: no cookies, no
 * storage, no access to the app's DOM), and the document carries its own CSP: no network at all
 * (`connect-src 'none'`), no forms, no nested frames, no <base>. HTML and React get scripts
 * (`allow-scripts`) because a live preview is the point; SVG gets none.
 */

/** `diagram` is reserved for the interactive diagrams of the core.diagrams plugin; until it is installed it reads as JSON. */
export type ArtifactKind = 'html' | 'svg' | 'react' | 'diagram';
/** The kinds previewed in a sandboxed frame by default. */
export type FramedArtifactKind = Exclude<ArtifactKind, 'diagram'>;

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

/** Formats the 3D viewer reads. */
export const MOLECULE_FORMATS = ['pdb', 'sdf', 'mol', 'mol2', 'xyz', 'cif'] as const;

/**
 * A 3D molecule viewer (3Dmol.js, from the runtime folder next to the React runtime) for a ```pdb,
 * ```sdf, ```mol ... block. The structure travels base64-encoded and is parsed by 3Dmol, never as markup.
 */
export function moleculeDocument(source: string, format: string, runtimeUrl?: string): string {
  const fmt = (MOLECULE_FORMATS as readonly string[]).includes(format) ? format : 'pdb';
  const base = runtimeUrl ? runtimeUrl.replace(/[^/]*$/, '') : '';
  const b64 = btoa(unescape(encodeURIComponent(source)));
  // Proteins as a cartoon; small molecules (and small PDB files: a ligand, a peptide) as balls and sticks.
  const style = fmt === 'pdb' || fmt === 'cif' ? "n>300?{cartoon:{color:'spectrum'}}:{stick:{radius:0.15},sphere:{scale:0.25}}" : '{stick:{radius:0.15},sphere:{scale:0.25}}';
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${esc(artifactCsp(true, base || undefined))}"><style>html,body{margin:0;height:100%;background:#fff;font:12px system-ui}#v{position:absolute;inset:0}#e{color:#b42318;padding:10px}</style></head><body><div id="v"></div>${base ? `<script src="${esc(base)}3Dmol-min.js"></script>` : ''}<script id="mol" type="text/plain" data-b64="${b64}" data-format="${fmt}"></script><script>(function(){var el=document.getElementById('mol');try{if(!window.$3Dmol)throw new Error('the 3D viewer is not available here');var data=decodeURIComponent(escape(atob(el.getAttribute('data-b64'))));var v=window.$3Dmol.createViewer(document.getElementById('v'),{backgroundColor:'white'});var m=v.addModel(data,el.getAttribute('data-format'));var n=m?m.selectedAtoms({}).length:0;if(!n)throw new Error('no atoms in this structure');v.setStyle({},${style});v.zoomTo();v.render();document.body.setAttribute('data-atoms',String(n));parent.postMessage({harnessArtifact:'molecule',atoms:n},'*');}catch(e){var d=document.createElement('div');d.id='e';d.textContent='Could not show this structure: '+e.message;document.body.appendChild(d);}})();</script></body></html>`;
}

/** The document for an artifact. `runtimeUrl` is the React runtime script (React artifacts only). */
export function artifactDocument(kind: FramedArtifactKind, source: string, opts: { runtimeUrl?: string } = {}): string {
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
export function artifactSandbox(kind: FramedArtifactKind): string { return kind === 'svg' ? '' : 'allow-scripts'; }
