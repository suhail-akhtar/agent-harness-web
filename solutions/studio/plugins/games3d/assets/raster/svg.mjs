// Pixel art as SVG: one rect per horizontal run of a colour, crisp at any zoom
// (shape-rendering crispEdges), for web UIs, docs and vector pipelines.

import { toHex } from './color.mjs';

export function pixelSvg(img, { scale = 1 } = {}) {
  const rects = [];
  for (let y = 0; y < img.height; y++) {
    let x = 0;
    while (x < img.width) {
      const c = img.get(x, y);
      if (!c[3]) { x++; continue; }
      let end = x + 1;
      while (end < img.width) { const d = img.get(end, y); if (d[0] !== c[0] || d[1] !== c[1] || d[2] !== c[2] || d[3] !== c[3]) break; end++; }
      rects.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${toHex(c)}"${c[3] < 255 ? ` fill-opacity="${(c[3] / 255).toFixed(3)}"` : ''}/>`);
      x = end;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${img.width * scale}" height="${img.height * scale}" viewBox="0 0 ${img.width} ${img.height}" shape-rendering="crispEdges">${rects.join('')}</svg>\n`;
}
