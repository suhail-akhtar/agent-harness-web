// A small zip writer (deflate, CRC-32, no zip64): a web build packaged as one file the person
// can send or upload to a game portal.

import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const TABLE = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Writes entries [{ name, data }] as a zip file. Returns { bytes, files }. */
export async function writeZip(file, entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  const date = 0x5a21, time = 0; // a fixed time: the same files make the same zip
  for (const e of entries) {
    const name = Buffer.from(e.name.replace(/\\/g, '/'));
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const packed = zlib.deflateRawSync(raw, { level: 9 });
    const store = packed.length >= raw.length;
    const body = store ? raw : packed;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(store ? 0 : 8, 10);
    c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  const all = Buffer.concat([...parts, cd, end]);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, all);
  return { bytes: all.length, files: entries.length };
}

/** The names in a zip (its central directory), for checks. */
export async function zipNames(file) {
  const b = await fsp.readFile(file);
  const end = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('not a zip file');
  let o = b.readUInt32LE(end + 16);
  const n = b.readUInt16LE(end + 10);
  const out = [];
  for (let i = 0; i < n; i++) {
    const len = b.readUInt16LE(o + 28), extra = b.readUInt16LE(o + 30), comment = b.readUInt16LE(o + 32);
    out.push(b.toString('utf8', o + 46, o + 46 + len));
    o += 46 + len + extra + comment;
  }
  return out;
}
