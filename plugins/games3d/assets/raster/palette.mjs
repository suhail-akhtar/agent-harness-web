// Palettes: well-known pixel-art palettes by name, median-cut extraction, and mapping an
// image onto a palette with no, ordered (Bayer) or Floyd-Steinberg dithering.

import { colorDist, parseColor, toHex } from './color.mjs';
import { bayer } from './image.mjs';

export const PALETTES = {
  pico8: ['#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8', '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa'],
  db16: ['#140c1c', '#442434', '#30346d', '#4e4a4e', '#854c30', '#346524', '#d04648', '#757161', '#597dce', '#d27d2c', '#8595a1', '#6daa2c', '#d2aa99', '#6dc2ca', '#dad45e', '#deeed6'],
  db32: ['#000000', '#222034', '#45283c', '#663931', '#8f563b', '#df7126', '#d9a066', '#eec39a', '#fbf236', '#99e550', '#6abe30', '#37946e', '#4b692f', '#524b24', '#323c39', '#3f3f74', '#306082', '#5b6ee1', '#639bff', '#5fcde4', '#cbdbfc', '#ffffff', '#9badb7', '#847e87', '#696a6a', '#595652', '#76428a', '#ac3232', '#d95763', '#d77bba', '#8f974a', '#8a6f30'],
  endesga32: ['#be4a2f', '#d77643', '#ead4aa', '#e4a672', '#b86f50', '#733e39', '#3e2731', '#a22633', '#e43b44', '#f77622', '#feae34', '#fee761', '#63c74d', '#3e8948', '#265c42', '#193c3e', '#124e89', '#0099db', '#2ce8f5', '#ffffff', '#c0cbdc', '#8b9bb4', '#5a6988', '#3a4466', '#262b44', '#181425', '#ff0044', '#68386c', '#b55088', '#f6757a', '#e8b796', '#c28569'],
  sweetie16: ['#1a1c2c', '#5d275d', '#b13e53', '#ef7d57', '#ffcd75', '#a7f070', '#38b764', '#257179', '#29366f', '#3b5dc9', '#41a6f6', '#73eff7', '#f4f4f4', '#94b0c2', '#566c86', '#333c57'],
  gameboy: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'],
  grayscale8: ['#000000', '#242424', '#494949', '#6d6d6d', '#929292', '#b6b6b6', '#dbdbdb', '#ffffff'],
};

/** A palette from a name, a list of colours, or null. */
export function paletteOf(p) {
  if (!p) return null;
  if (typeof p === 'string') {
    const named = PALETTES[p.toLowerCase().replace(/[\s_-]/g, '')];
    if (!named) throw new Error(`unknown palette ${p}: one of ${Object.keys(PALETTES).join(', ')}, or a list of colours`);
    return named.map((c) => parseColor(c));
  }
  if (Array.isArray(p)) return p.map((c) => parseColor(c));
  throw new Error('palette must be a name or a list of colours');
}

/** The n colours that best represent an image's opaque pixels (median cut). */
export function medianCut(img, n = 16, { threshold = 128 } = {}) {
  const px = [];
  for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 3] >= threshold) px.push([img.data[i], img.data[i + 1], img.data[i + 2]]);
  if (!px.length) return [];
  let boxes = [px];
  while (boxes.length < n) {
    // Split the box with the widest channel range (weighted by size).
    let bi = -1, bestScore = 0, bestCh = 0;
    boxes.forEach((b, i) => {
      if (b.length < 2) return;
      for (let c = 0; c < 3; c++) {
        let lo = 255, hi = 0;
        for (const p of b) { if (p[c] < lo) lo = p[c]; if (p[c] > hi) hi = p[c]; }
        const score = (hi - lo) * Math.sqrt(b.length);
        if (score > bestScore) { bestScore = score; bi = i; bestCh = c; }
      }
    });
    if (bi < 0) break;
    const b = boxes[bi].sort((p, q) => p[bestCh] - q[bestCh]);
    const mid = b.length >> 1;
    boxes.splice(bi, 1, b.slice(0, mid), b.slice(mid));
  }
  return boxes.filter((b) => b.length).map((b) => {
    const s = [0, 0, 0];
    for (const p of b) { s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; }
    return [Math.round(s[0] / b.length), Math.round(s[1] / b.length), Math.round(s[2] / b.length), 255];
  });
}

export function nearest(palette, c) {
  let best = palette[0], bd = Infinity;
  for (const p of palette) { const d = colorDist(c, p); if (d < bd) { bd = d; best = p; } }
  return best;
}

/**
 * The image mapped onto a palette. dither: 'none' | 'ordered' | 'floyd'. Alpha becomes
 * 0 or 255 (pixel art); the palette's own colours pass through unchanged.
 */
export function quantize(img, palette, { dither = 'none', strength = 1, alphaThreshold = 128 } = {}) {
  const pal = palette.map((c) => parseColor(c));
  const out = img.clone();
  const W = img.width, H = img.height;
  const err = dither === 'floyd' ? new Float32Array(W * H * 3) : null;
  const cache = new Map();
  const near = (c) => {
    const k = (c[0] << 16) | (c[1] << 8) | c[2];
    let v = cache.get(k);
    if (!v) { v = nearest(pal, c); cache.set(k, v); }
    return v;
  };
  // The ordered dither's spread: about the average gap between palette colours.
  const spread = (48 * strength) / Math.sqrt(Math.max(1, pal.length / 8));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (out.data[i + 3] < alphaThreshold) { out.data[i + 3] = 0; continue; }
      out.data[i + 3] = 255;
      let c = [out.data[i], out.data[i + 1], out.data[i + 2]];
      if (dither === 'ordered') { const t = (bayer(x, y) - 0.5) * spread; c = c.map((v) => Math.max(0, Math.min(255, v + t))); }
      if (err) { const e = (y * W + x) * 3; c = c.map((v, k) => Math.max(0, Math.min(255, v + err[e + k]))); }
      const p = near(c.map(Math.round));
      out.data[i] = p[0]; out.data[i + 1] = p[1]; out.data[i + 2] = p[2];
      if (err) {
        const d = [c[0] - p[0], c[1] - p[1], c[2] - p[2]].map((v) => v * strength);
        const push = (dx, dy, f) => {
          const X = x + dx, Y = y + dy;
          if (X < 0 || X >= W || Y >= H) return;
          const e = (Y * W + X) * 3;
          err[e] += d[0] * f; err[e + 1] += d[1] * f; err[e + 2] += d[2] * f;
        };
        push(1, 0, 7 / 16); push(-1, 1, 3 / 16); push(0, 1, 5 / 16); push(1, 1, 1 / 16);
      }
    }
  }
  return out;
}

export const paletteHex = (pal) => pal.map((c) => toHex(c));
