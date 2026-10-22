/**
 * HTML from outside (a notebook's text/html outputs: pandas tables, styled text) made safe to put
 * in the app's own page, so it sizes like any block instead of a frame the host must measure.
 *
 * Built back up from an allowlist rather than cleaned: only the tags and attributes below are
 * written, every attribute value escaped, everything else dropped (script, style, iframe, object,
 * svg, math, form controls, event handlers, style attributes, classes, ids, links). The content of
 * a dropped container (script, style, template...) is dropped with it; other unknown tags keep
 * their text. Pure (no DOM), so it runs and is tested in Node.
 */

const ALLOWED: Record<string, string[]> = {
  table: ['border'], thead: [], tbody: [], tfoot: [], tr: [], th: ['colspan', 'rowspan', 'scope', 'align'], td: ['colspan', 'rowspan', 'align'], caption: [], colgroup: ['span'], col: ['span'],
  div: [], span: [], p: [], br: [], hr: [], b: [], i: [], u: [], s: [], em: [], strong: [], small: [], sub: [], sup: [], mark: [], code: [], pre: [], kbd: [], samp: [], var: [], q: [], blockquote: [], abbr: ['title'],
  h1: [], h2: [], h3: [], h4: [], h5: [], h6: [], ul: [], ol: ['start'], li: [], dl: [], dt: [], dd: [], details: [], summary: [],
  img: ['src', 'alt', 'width', 'height'],
};
const VOID = new Set(['br', 'hr', 'img', 'col']);
/** Dropped with everything inside. */
const DROP = new Set(['script', 'style', 'template', 'iframe', 'object', 'embed', 'noscript', 'svg', 'math', 'textarea', 'select', 'title', 'head', 'canvas', 'video', 'audio', 'frameset', 'frame', 'applet', 'xmp', 'noembed', 'noframes', 'plaintext']);

const esc = (s: string) => s.replace(/&(?!(?:#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const SAFE_IMG = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;

function attrs(tag: string, raw: string): string {
  const allowed = ALLOWED[tag] ?? [];
  if (!allowed.length) return '';
  let out = '';
  for (const m of raw.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = m[1]!.toLowerCase();
    if (!allowed.includes(name)) continue;
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    if (name === 'src' && !SAFE_IMG.test(value.trim())) continue;
    if ((name === 'width' || name === 'height' || name === 'colspan' || name === 'rowspan' || name === 'span' || name === 'start' || name === 'border') && !/^\d{1,4}%?$/.test(value.trim())) continue;
    if (name === 'align' && !/^(left|right|center|justify)$/i.test(value.trim())) continue;
    if (name === 'scope' && !/^(row|col|rowgroup|colgroup)$/i.test(value.trim())) continue;
    out += ` ${name}="${esc(value)}"`;
  }
  return out;
}

export function sanitizeHtml(html: string, maxLength = 2_000_000): string {
  const src = String(html ?? '').slice(0, maxLength);
  const out: string[] = [];
  const open: string[] = [];
  let skip: string | null = null;
  let skipDepth = 0;
  const re = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![^>]*>|<\?[^>]*>|<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
  let last = 0;
  for (const m of src.matchAll(re)) {
    const text = src.slice(last, m.index);
    last = m.index! + m[0].length;
    if (!skip && text) out.push(esc(text));
    const name = m[1]?.toLowerCase();
    if (!name) continue; // a comment, doctype or processing instruction
    const closing = m[0].startsWith('</');
    if (skip) {
      if (name === skip) skipDepth += closing ? -1 : 1;
      if (skipDepth <= 0) skip = null;
      continue;
    }
    if (DROP.has(name)) { if (!closing && !m[0].endsWith('/>')) { skip = name; skipDepth = 1; } continue; }
    if (!(name in ALLOWED)) continue;
    if (closing) {
      const at = open.lastIndexOf(name);
      if (at < 0) continue;
      // Close what was left open inside it.
      while (open.length > at) out.push(`</${open.pop()}>`);
      continue;
    }
    out.push(`<${name}${attrs(name, m[2] ?? '')}>`);
    if (!VOID.has(name)) open.push(name);
  }
  if (!skip) out.push(esc(src.slice(last)));
  while (open.length) out.push(`</${open.pop()}>`);
  return out.join('');
}
