// Animated GIFs in plain JS: the playtest recording. One palette for the whole clip (median cut
// over a sample of every frame's pixels, 256 colours), LZW-compressed frames, looping forever.
// decodeGif reads them back (tests, and anything that wants the frames again).

/** Median cut: up to `size` colours that cover the sampled pixels (a flat [r, g, b, r, g, b...] list). */
export function quantize(samples, size = 256) {
  const n = Math.floor(samples.length / 3);
  if (!n) return [[0, 0, 0]];
  let boxes = [{ idx: Uint32Array.from({ length: n }, (_, i) => i) }];
  const range = (box) => {
    const lo = [255, 255, 255], hi = [0, 0, 0];
    for (const i of box.idx) for (let c = 0; c < 3; c++) { const v = samples[i * 3 + c]; if (v < lo[c]) lo[c] = v; if (v > hi[c]) hi[c] = v; }
    const span = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    const ch = span[0] >= span[1] && span[0] >= span[2] ? 0 : span[1] >= span[2] ? 1 : 2;
    return { ch, span: span[ch] };
  };
  for (const b of boxes) Object.assign(b, range(b));
  while (boxes.length < size) {
    // Split the box with the widest spread weighted by how many pixels it holds.
    let best = -1, score = 0;
    boxes.forEach((b, i) => { const s = b.span * Math.sqrt(b.idx.length); if (b.idx.length > 1 && b.span > 0 && s > score) { score = s; best = i; } });
    if (best < 0) break;
    const b = boxes[best];
    const sorted = Array.from(b.idx).sort((x, y) => samples[x * 3 + b.ch] - samples[y * 3 + b.ch]);
    const mid = sorted.length >> 1;
    const left = { idx: Uint32Array.from(sorted.slice(0, mid)) };
    const right = { idx: Uint32Array.from(sorted.slice(mid)) };
    Object.assign(left, range(left));
    Object.assign(right, range(right));
    boxes = [...boxes.slice(0, best), left, right, ...boxes.slice(best + 1)];
  }
  return boxes.map((b) => {
    let r = 0, g = 0, bl = 0;
    for (const i of b.idx) { r += samples[i * 3]; g += samples[i * 3 + 1]; bl += samples[i * 3 + 2]; }
    const k = b.idx.length;
    return [Math.round(r / k), Math.round(g / k), Math.round(bl / k)];
  });
}

/** Maps RGB pixels to palette indices (nearest colour, cached per 15-bit colour). */
export function mapToPalette(rgb, palette, cache = new Map()) {
  const out = new Uint8Array(rgb.length / 3);
  for (let p = 0; p < out.length; p++) {
    const r = rgb[p * 3], g = rgb[p * 3 + 1], b = rgb[p * 3 + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let idx = cache.get(key);
    if (idx === undefined) {
      let best = Infinity;
      idx = 0;
      for (let i = 0; i < palette.length; i++) {
        const c = palette[i];
        const d = (c[0] - r) ** 2 * 3 + (c[1] - g) ** 2 * 4 + (c[2] - b) ** 2 * 2;
        if (d < best) { best = d; idx = i; }
      }
      cache.set(key, idx);
    }
    out[p] = idx;
  }
  return out;
}

/** GIF LZW: variable code size from minCodeSize + 1 up to 12 bits, a clear code when the table fills. */
export function lzwEncode(indices, minCodeSize = 8) {
  const clear = 1 << minCodeSize, eoi = clear + 1;
  const out = [];
  let acc = 0, bits = 0;
  let size = minCodeSize + 1;
  const emit = (code) => {
    acc |= code << bits;
    bits += size;
    while (bits >= 8) { out.push(acc & 0xff); acc >>>= 8; bits -= 8; }
  };
  let table = new Map();
  let next = eoi + 1;
  emit(clear);
  if (!indices.length) { emit(eoi); if (bits) out.push(acc & 0xff); return Uint8Array.from(out); }
  let cur = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = cur * 256 + k;
    const hit = table.get(key);
    if (hit !== undefined) { cur = hit; continue; }
    emit(cur);
    if (next === 4096) {
      emit(clear);
      table = new Map();
      next = eoi + 1;
      size = minCodeSize + 1;
    } else {
      if (next >= 1 << size) size++;
      table.set(key, next++);
    }
    cur = k;
  }
  emit(cur);
  emit(eoi);
  if (bits) out.push(acc & 0xff);
  return Uint8Array.from(out);
}

/** The matching decoder, for pixelCount indices. */
export function lzwDecode(data, minCodeSize, pixelCount) {
  const clear = 1 << minCodeSize, eoi = clear + 1;
  const out = new Uint8Array(pixelCount);
  let o = 0;
  let size = minCodeSize + 1;
  let next = eoi + 1;
  const table = [];
  for (let i = 0; i < clear; i++) table[i] = [i];
  let prev = null;
  let acc = 0, bits = 0, pos = 0;
  for (;;) {
    while (bits < size && pos < data.length) { acc |= data[pos++] << bits; bits += 8; }
    if (bits < size) break;
    const code = acc & ((1 << size) - 1);
    acc >>>= size; bits -= size;
    if (code === clear) { size = minCodeSize + 1; next = eoi + 1; table.length = clear; prev = null; continue; }
    if (code === eoi) break;
    let entry;
    if (prev === null) entry = table[code];
    else if (code < next) {
      entry = table[code];
      if (next < 4096) table[next++] = [...table[prev], entry[0]];
    } else {
      entry = [...table[prev], table[prev][0]];
      if (next < 4096) table[next++] = entry;
    }
    if (!entry) throw new Error(`bad LZW code ${code}`);
    for (const v of entry) if (o < pixelCount) out[o++] = v;
    if (next === 1 << size && size < 12) size++;
    prev = code;
  }
  return out;
}

const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];
function subBlocks(data) {
  const out = [];
  for (let i = 0; i < data.length; i += 255) { const part = data.subarray(i, i + 255); out.push(part.length, ...part); }
  out.push(0);
  return out;
}

/**
 * An animated GIF from frames { width, height, rgb } (all the size of the first; others are
 * cropped or padded) with delays in milliseconds (default 100 each).
 */
export function encodeGif(frames, { delays = [], loop = true, sampleEvery } = {}) {
  if (!frames.length) throw new Error('no frames');
  const { width, height } = frames[0];
  const fit = (f) => {
    if (f.width === width && f.height === height) return f.rgb;
    const rgb = new Uint8Array(width * height * 3);
    for (let y = 0; y < Math.min(height, f.height); y++) rgb.set(f.rgb.subarray(y * f.width * 3, y * f.width * 3 + Math.min(width, f.width) * 3), y * width * 3);
    return rgb;
  };
  const pixelsOf = frames.map(fit);
  // Sample about 60k pixels across the clip for the palette.
  const total = pixelsOf.length * width * height;
  const every = sampleEvery ?? Math.max(1, Math.floor(total / 60000));
  const samples = [];
  let k = 0;
  for (const rgb of pixelsOf) for (let p = 0; p < rgb.length / 3; p++) if (k++ % every === 0) samples.push(rgb[p * 3], rgb[p * 3 + 1], rgb[p * 3 + 2]);
  const palette = quantize(samples, 256);
  while (palette.length < 256) palette.push([0, 0, 0]);
  const bytes = [...Buffer.from('GIF89a', 'latin1'), ...u16(width), ...u16(height), 0xf7, 0, 0];
  for (const c of palette) bytes.push(c[0], c[1], c[2]);
  if (loop) bytes.push(0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0', 'latin1'), 0x03, 0x01, 0, 0, 0);
  const cache = new Map();
  pixelsOf.forEach((rgb, i) => {
    const delay = Math.max(2, Math.round((delays[i] ?? 100) / 10));
    bytes.push(0x21, 0xf9, 0x04, 0x00, ...u16(delay), 0, 0);
    bytes.push(0x2c, 0, 0, 0, 0, ...u16(width), ...u16(height), 0);
    bytes.push(8, ...subBlocks(lzwEncode(mapToPalette(rgb, palette, cache), 8)));
  });
  bytes.push(0x3b);
  return Buffer.from(bytes);
}

/** Reads a GIF: { width, height, frames: [{ delayMs, rgb }] } (full frames, no disposal tricks). */
export function decodeGif(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const sig = Buffer.from(b.subarray(0, 6)).toString('latin1');
  if (sig !== 'GIF89a' && sig !== 'GIF87a') throw new Error('not a GIF');
  const width = b[6] | (b[7] << 8), height = b[8] | (b[9] << 8);
  let pos = 13;
  const table = (flags) => { const n = 2 << (flags & 7); const t = []; for (let i = 0; i < n; i++) t.push([b[pos + i * 3], b[pos + i * 3 + 1], b[pos + i * 3 + 2]]); pos += n * 3; return t; };
  const global = b[10] & 0x80 ? table(b[10]) : null;
  const frames = [];
  let delayMs = 0;
  const readBlocks = () => { const parts = []; for (let n = b[pos++]; n; n = b[pos++]) { parts.push(b.subarray(pos, pos + n)); pos += n; } return Buffer.concat(parts); };
  let loops = false;
  while (pos < b.length) {
    const t = b[pos++];
    if (t === 0x3b) break;
    if (t === 0x21) {
      const label = b[pos++];
      if (label === 0xf9) { delayMs = (b[pos + 2] | (b[pos + 3] << 8)) * 10; }
      if (label === 0xff && Buffer.from(b.subarray(pos + 1, pos + 12)).toString('latin1') === 'NETSCAPE2.0') loops = true;
      readBlocks();
      continue;
    }
    if (t !== 0x2c) throw new Error(`bad block 0x${t.toString(16)} at ${pos - 1}`);
    const w = b[pos + 4] | (b[pos + 5] << 8), h = b[pos + 6] | (b[pos + 7] << 8), flags = b[pos + 8];
    pos += 9;
    const palette = flags & 0x80 ? table(flags) : global;
    if (!palette) throw new Error('a frame without a colour table');
    const min = b[pos++];
    const idx = lzwDecode(readBlocks(), min, w * h);
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < idx.length; i++) { const c = palette[idx[i]] ?? [0, 0, 0]; rgb[i * 3] = c[0]; rgb[i * 3 + 1] = c[1]; rgb[i * 3 + 2] = c[2]; }
    frames.push({ delayMs, width: w, height: h, rgb });
  }
  return { width, height, loops, frames };
}
