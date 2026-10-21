// A small PNG reader for the model-preview gate: size, and whether a render
// shows anything (more than one colour) - on the server, without a browser.
// 8- and 16-bit greyscale, RGB, palette and alpha images, not interlaced
// (what Blender and Godot write); anything else is read as "unknown".

import zlib from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Width, height and the raw image header fields; throws when it is not a PNG. */
export function pngInfo(buf) {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIG) || buf.toString('latin1', 12, 16) !== 'IHDR') throw new Error('not a PNG file');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), depth: buf[24], colorType: buf[25], interlace: buf[28] };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** The unfiltered rows of a non-interlaced 8/16-bit PNG, or null when this reader cannot decode it. */
export function pixels(buf, info = pngInfo(buf)) {
  const ch = CHANNELS[info.colorType];
  if (!ch || (info.depth !== 8 && info.depth !== 16) || info.interlace !== 0) return null;
  const parts = [];
  for (let o = 8; o + 8 <= buf.length;) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    if (type === 'IDAT') parts.push(buf.subarray(o + 8, o + 8 + len));
    if (type === 'IEND') break;
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(parts));
  const bpp = ch * (info.depth / 8);
  const stride = info.width * bpp;
  const out = Buffer.alloc(stride * info.height);
  for (let y = 0; y < info.height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[row + x - bpp] : 0;
      const b = y ? out[row - stride + x] : 0;
      const c = x >= bpp && y ? out[row - stride + x - bpp] : 0;
      const v = raw[src + x];
      out[row + x] = (f === 0 ? v : f === 1 ? v + a : f === 2 ? v + b : f === 3 ? v + ((a + b) >> 1) : v + paeth(a, b, c)) & 0xff;
    }
  }
  return { data: out, bpp, ch, stride };
}

/**
 * Colour spread on a 64x64 sample, like the browser tool's screenshot check:
 * blank when it has at most two colours or almost no contrast. null fields
 * when the PNG is a kind this reader does not decode.
 */
export function pngStats(buf) {
  const info = pngInfo(buf);
  const px = pixels(buf, info);
  if (!px) return { ...info, colours: null, stddev: null, blank: null };
  const step = info.depth / 8;
  const colours = new Set();
  const lum = [];
  const n = 64;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = Math.min(info.width - 1, Math.floor(((i + 0.5) * info.width) / n));
      const y = Math.min(info.height - 1, Math.floor(((j + 0.5) * info.height) / n));
      const o = y * px.stride + x * px.bpp;
      const s = (k) => px.data[o + k * step];
      const [r, g, b] = px.ch >= 3 ? [s(0), s(1), s(2)] : [s(0), s(0), s(0)];
      colours.add((r << 16) | (g << 8) | b);
      lum.push(0.299 * r + 0.587 * g + 0.114 * b);
    }
  }
  const mean = lum.reduce((a, v) => a + v, 0) / lum.length;
  const stddev = Math.sqrt(lum.reduce((a, v) => a + (v - mean) ** 2, 0) / lum.length);
  return { ...info, colours: colours.size, stddev: Math.round(stddev * 10) / 10, blank: colours.size <= 2 || stddev < 1.5 };
}
