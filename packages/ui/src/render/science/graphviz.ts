/**
 * Graphviz in the transcript: what a ```dot block may contain, and what its SVG may keep. Pure
 * (tested with the real wasm build in Node); the component in Science.tsx loads the layout engine.
 */

import { scrubSvg, scrubSvgDom } from '../safe.ts';

/** Refuses what would make Graphviz read files (images, shapefiles, font and image paths). */
export function checkDot(source: string): string | undefined {
  if (!source.trim()) return 'the graph is empty';
  if (source.length > 200_000) return 'the graph is too large';
  if (/\b(image|shapefile|fontpath|imagepath|fontnames)\s*=/i.test(source)) return 'images and files are not allowed in a graph';
  return undefined;
}

/**
 * Graphviz draws black on a white page. Themed for the app: the page is transparent, default black
 * lines, arrowheads and text take the theme's text colour (currentColor), and the default white
 * fill of a filled shape takes the elevated surface. Colours the graph sets itself are kept, and
 * text inside a node the graph filled with its own (light) colour stays dark so it can be read.
 */
export function themeGraphSvg(svg: string): string {
  const own = (fill: string) => !/^(none|white|#ffffff|#fff|transparent|black|#000000|#000)$/i.test(fill);
  let out = svg
    // The page: <g class="graph"> starts with a white polygon covering it.
    .replace(/(<g\b[^>]*class="graph"[^>]*>\s*(?:<title>[\s\S]*?<\/title>\s*)?<polygon\b[^>]*?)fill="white"/, '$1fill="none"')
    .replace(/stroke="black"/g, 'stroke="currentColor"')
    .replace(/stroke="#000000"/gi, 'stroke="currentColor"')
    .replace(/(<(?:polygon|path|ellipse|polyline)\b[^>]*?)fill="black"/g, '$1fill="currentColor"')
    .replace(/(<(?:polygon|path|ellipse|rect)\b[^>]*?)fill="white"/g, '$1fill="var(--hx-elevated, transparent)"');
  // Text: inside a node with a fill of its own, keep Graphviz's default (black); elsewhere, the theme's colour.
  out = out.replace(/<g\b[^>]*class="(node|edge|cluster)"[^>]*>[\s\S]*?<\/g>/g, (group) => {
    const fills = [...group.matchAll(/<(?:polygon|ellipse|path|rect)\b[^>]*\bfill="([^"]+)"/g)].map((m) => m[1]!);
    const filled = fills.some(own);
    return filled ? group.replace(/<text\b(?![^>]*\bfill=)/g, '<text fill="#1f1e1c"') : group.replace(/<text\b(?![^>]*\bfill=)/g, '<text fill="currentColor"').replace(/(<text\b[^>]*?)fill="black"/g, '$1fill="currentColor"');
  });
  // Graph labels outside any node or edge.
  out = out.replace(/<text\b(?![^>]*\bfill=)/g, '<text fill="currentColor"');
  return out;
}

/** The SVG Graphviz wrote, scrubbed, and without links (a graph's URL attributes are not followed). */
export function cleanGraphSvg(out: string): string {
  const svg = out.replace(/^[\s\S]*?(<svg)/, '$1');
  const scrubbed = typeof DOMParser === 'undefined' ? scrubSvg(svg) : scrubSvgDom(svg);
  return scrubbed.replace(/\s(xlink:)?href\s*=\s*("[^"]*"|'[^']*')/gi, '').replace(/\s(target)\s*=\s*("[^"]*"|'[^']*')/gi, '');
}
