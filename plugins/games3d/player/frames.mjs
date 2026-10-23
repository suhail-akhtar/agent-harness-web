// Frames on the server, without a browser: decode a screenshot (PNG), shrink it for the agent
// (a 512 px frame costs a few hundred tokens), encode it again, and measure it: colour spread
// (a blank frame has almost none) and a small luminance hash for "did anything change".

import zlib from 'node:zlib';
import { pixels, pngInfo } from '../lib-png.mjs';

/** RGB pixels of a PNG: { width, height, rgb: Uint8Array(width * height * 3) }. Throws on a PNG it cannot read. */
export function decodePng(buf) {
  const info = pngInfo(buf);
  const px = pixels(buf, info);
  if (!px) throw new Error(`cannot decode this PNG (colour type ${info.colorType}, depth ${info.depth}, interlace ${info.interlace})`);
  const { width, height } = info;
  const step = info.depth / 8;
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = y * px.stride + x * px.bpp;
      const s = (k) => px.data[o + k * step];
      const d = (y * width + x) * 3;
      if (px.ch >= 3) { rgb[d] = s(0); rgb[d + 1] = s(1); rgb[d + 2] = s(2); } else { rgb[d] = rgb[d + 1] = rgb[d + 2] = s(0); }
    }
  }
  return { width, height, rgb };
}

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** An 8-bit RGB PNG from { width, height, rgb }. */
export function encodePng({ width, height, rgb }) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    // Filter "up" on every row but the first: game frames have large flat areas.
    const row = y * (width * 3 + 1);
    raw[row] = y ? 2 : 0;
    for (let x = 0; x < width * 3; x++) {
      const v = rgb[y * width * 3 + x];
      raw[row + 1 + x] = y ? (v - rgb[(y - 1) * width * 3 + x]) & 0xff : v;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/** A smaller copy, averaging the source pixels under each target pixel (never larger than the source). */
export function resize(img, width) {
  const w = Math.max(1, Math.min(img.width, Math.round(width)));
  if (w === img.width) return img;
  const h = Math.max(1, Math.round((img.height * w) / img.width));
  const rgb = new Uint8Array(w * h * 3);
  const sx = img.width / w;
  const sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) { const o = (yy * img.width + xx) * 3; r += img.rgb[o]; g += img.rgb[o + 1]; b += img.rgb[o + 2]; n++; }
      }
      const d = (y * w + x) * 3;
      rgb[d] = r / n; rgb[d + 1] = g / n; rgb[d + 2] = b / n;
    }
  }
  return { width: w, height: h, rgb };
}

/** Colour spread on a 64x64 sample: blank when at most two colours or almost no contrast (as the browser tool says). */
export function imageStats(img) {
  const colours = new Set();
  let sum = 0, sq = 0;
  const n = 64;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = Math.min(img.width - 1, Math.floor(((i + 0.5) * img.width) / n));
      const y = Math.min(img.height - 1, Math.floor(((j + 0.5) * img.height) / n));
      const o = (y * img.width + x) * 3;
      const r = img.rgb[o], g = img.rgb[o + 1], b = img.rgb[o + 2];
      colours.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      sum += l; sq += l * l;
    }
  }
  const mean = sum / (n * n);
  const stddev = Math.sqrt(Math.max(0, sq / (n * n) - mean * mean));
  return { colours: colours.size, stddev: Math.round(stddev * 10) / 10, blank: colours.size <= 2 || stddev < 1.5 };
}

/** A 16x9 luminance hash (hex, one 4-bit level per cell): equal for frames that look the same. */
export function imageHash(img, cols = 16, rows = 9) {
  const small = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x0 = Math.floor((i * img.width) / cols), x1 = Math.max(x0 + 1, Math.floor(((i + 1) * img.width) / cols));
      const y0 = Math.floor((j * img.height) / rows), y1 = Math.max(y0 + 1, Math.floor(((j + 1) * img.height) / rows));
      let l = 0, k = 0;
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { const o = (y * img.width + x) * 3; l += 0.299 * img.rgb[o] + 0.587 * img.rgb[o + 1] + 0.114 * img.rgb[o + 2]; k++; }
      small.push(Math.min(15, Math.floor(l / k / 16)).toString(16));
    }
  }
  return small.join('');
}

/** How many cells of two hashes differ (0 = the same picture). */
export function hashDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

/** A screenshot as the agent sees it: shrunk to `width`, re-encoded, with its stats and hash. */
export function prepareFrame(png, width = 512) {
  const img = decodePng(png);
  const small = resize(img, width);
  return { png: small === img ? png : encodePng(small), width: small.width, height: small.height, sourceWidth: img.width, sourceHeight: img.height, stats: imageStats(img), hash: imageHash(img), img: small };
}
