// PNG encode and decode with node:zlib. Encodes RGBA 8-bit (and 16-bit greyscale for
// heightmaps); decodes every standard kind: greyscale, RGB, palette (with tRNS), with
// alpha, 1-16 bits, interlaced or not, into an RGBA Image (and the 16-bit samples when asked).

import zlib from 'node:zlib';
import { Image } from './image.mjs';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();

export function crc32(buf, crc = 0xffffffff) {
  for (let i = 0; i < buf.length; i++) crc = CRC[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return crc;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE((crc32(td) ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, td, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Filters rows choosing, per row, the filter with the smallest sum of absolute values. */
function filterRows(raw, stride, height, bpp) {
  const out = Buffer.alloc((stride + 1) * height);
  const cand = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const c = cand[f];
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const v = raw[row + x], a = x >= bpp ? raw[row + x - bpp] : 0, b = y ? raw[row - stride + x] : 0, cc = x >= bpp && y ? raw[row - stride + x - bpp] : 0;
        const o = (f === 0 ? v : f === 1 ? v - a : f === 2 ? v - b : f === 3 ? v - ((a + b) >> 1) : v - paeth(a, b, cc)) & 0xff;
        c[x] = o;
        sum += o < 128 ? o : 256 - o;
      }
      if (sum < bestSum) { bestSum = sum; best = f; }
    }
    out[y * (stride + 1)] = best;
    cand[best].copy(out, y * (stride + 1) + 1);
  }
  return out;
}

function ihdr(w, h, depth, colorType) {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(w, 0); b.writeUInt32BE(h, 4); b[8] = depth; b[9] = colorType; b[10] = 0; b[11] = 0; b[12] = 0;
  return b;
}

/** An RGBA Image as PNG bytes (RGB when every pixel is opaque and opaque is allowed). */
export function encodePNG(img, { keepAlpha = true } = {}) {
  const opaque = !keepAlpha || img.data.every((v, i) => (i & 3) !== 3 || v === 255);
  const ch = opaque && !keepAlpha ? 3 : 4;
  const stride = img.width * ch;
  const raw = Buffer.alloc(stride * img.height);
  if (ch === 4) Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length).copy(raw);
  else for (let i = 0, o = 0; i < img.data.length; i += 4) { raw[o++] = img.data[i]; raw[o++] = img.data[i + 1]; raw[o++] = img.data[i + 2]; }
  const idat = zlib.deflateSync(filterRows(raw, stride, img.height, ch), { level: 9 });
  return Buffer.concat([SIG, chunk('IHDR', ihdr(img.width, img.height, 8, ch === 4 ? 6 : 2)), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/** 16-bit greyscale PNG from values in [0, 1] (heightmaps for Unity, Unreal, Godot and Blender). */
export function encodeGray16(values, width, height) {
  const stride = width * 2;
  const raw = Buffer.alloc(stride * height);
  for (let i = 0; i < width * height; i++) raw.writeUInt16BE(Math.max(0, Math.min(65535, Math.round(values[i] * 65535))), i * 2);
  const idat = zlib.deflateSync(filterRows(raw, stride, height, 2), { level: 9 });
  return Buffer.concat([SIG, chunk('IHDR', ihdr(width, height, 16, 0)), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

/**
 * Decodes a PNG into an RGBA Image. With { samples: true } it also returns the first channel's
 * samples scaled to [0, 1] (full 16-bit precision for heightmaps).
 */
export function decodePNG(buf, { samples = false } = {}) {
  buf = Buffer.from(buf);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG file');
  let o = 8, info = null, palette = null, trns = null;
  const idat = [];
  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
    if (o + 12 + len > buf.length) throw new Error(`truncated PNG (${type} chunk)`);
    if (type === 'IHDR') info = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colorType: data[9], interlace: data[12] };
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  if (!info) throw new Error('PNG without IHDR');
  const { width, height, depth, colorType, interlace } = info;
  const ch = CHANNELS[colorType];
  if (!ch) throw new Error(`unknown PNG colour type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bitsPP = ch * depth, bpp = Math.max(1, bitsPP >> 3);
  const img = new Image(width, height);
  const out16 = samples ? new Float32Array(width * height) : null;
  const max = (1 << depth) - 1;
  let pos = 0;
  const pass = (px0, py0, dx, dy) => {
    const pw = Math.ceil((width - px0) / dx), ph = Math.ceil((height - py0) / dy);
    if (pw <= 0 || ph <= 0) return;
    const stride = Math.ceil((pw * bitsPP) / 8);
    let prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
    for (let y = 0; y < ph; y++) {
      const f = raw[pos++];
      for (let x = 0; x < stride; x++) {
        const v = raw[pos++], a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
        cur[x] = (f === 0 ? v : f === 1 ? v + a : f === 2 ? v + b : f === 3 ? v + ((a + b) >> 1) : v + paeth(a, b, c)) & 0xff;
      }
      for (let x = 0; x < pw; x++) {
        const sample = (k) => {
          if (depth === 8) return cur[x * ch + k];
          if (depth === 16) return cur.readUInt16BE((x * ch + k) * 2);
          const bit = (x * ch + k) * depth;
          return (cur[bit >> 3] >> (8 - depth - (bit & 7))) & max;
        };
        const to8 = (v) => (depth === 16 ? v >> 8 : depth === 8 ? v : Math.round((v * 255) / max));
        let rgba;
        if (colorType === 3) {
          const p = sample(0);
          rgba = [palette?.[p * 3] ?? 0, palette?.[p * 3 + 1] ?? 0, palette?.[p * 3 + 2] ?? 0, trns && p < trns.length ? trns[p] : 255];
        } else if (colorType === 0 || colorType === 4) {
          const g = sample(0);
          let a = colorType === 4 ? to8(sample(1)) : 255;
          if (colorType === 0 && trns && trns.readUInt16BE(0) === g) a = 0;
          rgba = [to8(g), to8(g), to8(g), a];
        } else {
          const r = sample(0), g = sample(1), b = sample(2);
          let a = colorType === 6 ? to8(sample(3)) : 255;
          if (colorType === 2 && trns && trns.readUInt16BE(0) === r && trns.readUInt16BE(2) === g && trns.readUInt16BE(4) === b) a = 0;
          rgba = [to8(r), to8(g), to8(b), a];
        }
        const X = px0 + x * dx, Y = py0 + y * dy;
        img.set(X, Y, rgba);
        if (out16) out16[Y * width + X] = colorType === 3 ? rgba[0] / 255 : sample(0) / max;
      }
      [prev, cur] = [cur, prev];
    }
  };
  if (interlace) for (const [x0, y0, dx, dy] of ADAM7) pass(x0, y0, dx, dy);
  else pass(0, 0, 1, 1);
  return samples ? { image: img, samples: out16, depth, colorType } : img;
}

export function pngSize(buf) {
  if (buf.length < 24 || !Buffer.from(buf.subarray(0, 8)).equals(SIG)) throw new Error('not a PNG file');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
