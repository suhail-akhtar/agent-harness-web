/**
 * What model output may point at, and what it may not.
 *
 * Model output is steerable by anything that reached its context (a fetched page, a file it read),
 * so every URL and every piece of generated markup it produces is checked here before the DOM
 * sees it. Pure functions: the unit tests feed them the classic attacks.
 */

/** A link target, or undefined when it must not be followed (javascript:, data:, vbscript:, file:, ...). */
export function safeHref(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  const u = String(url).trim();
  // Control characters and whitespace inside a scheme are how "java\tscript:" sneaks through.
  const compact = u.replace(/[\u0000- \u007f-\u009f]/g, '').toLowerCase();
  if (compact.startsWith('#')) return u;
  if (/^(https?|mailto):/.test(compact)) return u;
  // Relative links have no meaning in a transcript; refusing them avoids navigating the app.
  return undefined;
}

/** An image source, or undefined: http(s), and data: images of a raster or SVG type (an <img> runs no script). */
export function safeImageSrc(src: string | undefined | null): string | undefined {
  if (!src) return undefined;
  const u = String(src).trim();
  const compact = u.replace(/[\u0000- ]/g, '').toLowerCase();
  if (/^https?:\/\//.test(compact)) return u;
  if (/^data:image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)[;,]/.test(compact)) return u;
  if (/^blob:/.test(compact)) return u;
  return undefined;
}

/** True for a link that leaves the app (opened in the system browser, rel=noopener). */
export function isExternal(url: string): boolean { return /^https?:\/\//i.test(url) || /^mailto:/i.test(url); }

/**
 * Removes what could run from an SVG string: scripts, foreignObject (HTML inside SVG), event
 * handler attributes, javascript: and data:text links, <use> of external documents, <animate> that
 * rewrites href. A second layer behind Mermaid's own strict mode; also used for ```svg blocks
 * shown inline.
 */
export function scrubSvg(svg: string): string {
  let s = svg;
  s = s.replace(/<script[\s\S]*?<\/script\s*>/gi, '').replace(/<script\b[^>]*\/?>/gi, '');
  s = s.replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '');
  s = s.replace(/<(iframe|object|embed|link|meta|base|style\s+[^>]*src)[\s\S]*?>/gi, '');
  s = s.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  s = s.replace(/\s+(xlink:)?href\s*=\s*("|')\s*(javascript|data|vbscript):[\s\S]*?\2/gi, '');
  s = s.replace(/<(animate|set|animateTransform|animateMotion)\b[^>]*attributeName\s*=\s*("|')(xlink:)?href\2[^>]*\/?>/gi, '');
  return s;
}

/** Same as scrubSvg, on a parsed document (browser): walks every element. Returns the cleaned markup. */
export function scrubSvgDom(svg: string): string {
  if (typeof DOMParser === 'undefined') return scrubSvg(svg);
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (doc.querySelector('parsererror')) return scrubSvg(svg);
  const bad = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed', 'link', 'meta', 'base']);
  const walk = (el: Element) => {
    for (const child of [...el.children]) {
      if (bad.has(child.localName.toLowerCase())) { child.remove(); continue; }
      walk(child);
    }
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      const v = a.value.replace(/[\u0000- ]/g, '').toLowerCase();
      if (n.startsWith('on')) el.removeAttribute(a.name);
      else if ((n === 'href' || n === 'xlink:href' || n === 'src') && /^(javascript|data:text|vbscript)/.test(v)) el.removeAttribute(a.name);
      else if ((n === 'attributename') && /href/.test(v)) el.remove();
    }
  };
  walk(doc.documentElement);
  return new XMLSerializer().serializeToString(doc.documentElement);
}
