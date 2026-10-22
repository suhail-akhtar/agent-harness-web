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

/** The SVG Graphviz wrote, scrubbed, and without links (a graph's URL attributes are not followed). */
export function cleanGraphSvg(out: string): string {
  const svg = out.replace(/^[\s\S]*?(<svg)/, '$1');
  const scrubbed = typeof DOMParser === 'undefined' ? scrubSvg(svg) : scrubSvgDom(svg);
  return scrubbed.replace(/\s(xlink:)?href\s*=\s*("[^"]*"|'[^']*')/gi, '').replace(/\s(target)\s*=\s*("[^"]*"|'[^']*')/gi, '');
}
