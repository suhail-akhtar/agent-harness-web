// A small PNG writer (RGBA, 8 bits) for the art the templates start with: a sprite sheet
// and a tileset drawn pixel by pixel, so a new project runs before any real art exists.

import zlib from 'node:zlib';

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

/** A PNG of width x height from px(x, y) -> [r, g, b, a]. */
export function encodePng(width, height, px) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a = 255] = px(x, y);
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const CLEAR = [0, 0, 0, 0];

/**
 * The template hero: 4 walking frames of 32x32 in a row (frame 0 is also the idle pose).
 * A round head, a blue tunic, legs that swing.
 */
export function heroSheet(frames = 4, size = 32) {
  const px = (x, y) => {
    const f = Math.floor(x / size);
    const cx = x % size;
    const swing = [0, 2, 0, -2][f % 4];
    const head = (cx - 16) ** 2 + (y - 9) ** 2;
    if (head <= 30) return (cx === 14 || cx === 18) && y === 8 ? [30, 30, 40, 255] : [240, 200, 160, 255];
    if (head <= 40) return [60, 40, 30, 255];
    if (y >= 15 && y <= 23 && cx >= 10 && cx <= 22) return y === 15 || cx === 10 || cx === 22 ? [30, 60, 130, 255] : [60, 110, 210, 255];
    if (y >= 24 && y <= 29) {
      const left = 12 + swing;
      const right = 18 - swing;
      if ((cx >= left && cx <= left + 2) || (cx >= right && cx <= right + 2)) return [70, 50, 40, 255];
    }
    return CLEAR;
  };
  return { png: encodePng(frames * size, size, px), width: frames * size, height: size };
}

/** Three 16x16 tiles in a row: grass, a dirt path, a stone wall. */
export function tilesSheet(tile = 16) {
  const noise = (x, y) => ((x * 73856093) ^ (y * 19349663)) % 7;
  const px = (x, y) => {
    const t = Math.floor(x / tile);
    const cx = x % tile;
    if (t === 0) return noise(cx, y) === 0 ? [70, 150, 60, 255] : [90, 170, 70, 255];
    if (t === 1) return noise(cx, y) === 0 ? [150, 110, 70, 255] : [170, 130, 85, 255];
    const mortar = y % 8 === 0 || (cx + (Math.floor(y / 8) % 2) * 8) % 16 === 0;
    return mortar ? [90, 90, 95, 255] : [140, 140, 150, 255];
  };
  return { png: encodePng(3 * tile, tile, px), width: 3 * tile, height: tile };
}
