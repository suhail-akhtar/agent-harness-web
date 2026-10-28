// A small zip reader (the central directory, stored and deflated entries) for the asset
// packs the CC0 libraries ship as zips. Paths are checked: no absolute paths, no "..".

import zlib from 'node:zlib';

/** The entries of a zip: [{ name, size, data() }]. Throws on a file that is not a zip. */
export function readZip(buf) {
  buf = Buffer.from(buf);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file (no end of central directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let o = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(o) !== 0x02014b50) throw new Error('broken zip central directory');
    const method = buf.readUInt16LE(o + 10), csize = buf.readUInt32LE(o + 20), size = buf.readUInt32LE(o + 24);
    const nl = buf.readUInt16LE(o + 28), el = buf.readUInt16LE(o + 30), cl = buf.readUInt16LE(o + 32), local = buf.readUInt32LE(o + 42);
    const name = buf.toString('utf8', o + 46, o + 46 + nl).replace(/\\/g, '/');
    o += 46 + nl + el + cl;
    if (name.endsWith('/')) continue;
    if (name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').includes('..')) throw new Error(`zip entry with an unsafe path: ${name}`);
    out.push({
      name, size, method,
      data() {
        const ln = buf.readUInt16LE(local + 26), le = buf.readUInt16LE(local + 28);
        const start = local + 30 + ln + le;
        const raw = buf.subarray(start, start + csize);
        if (method === 0) return Buffer.from(raw);
        if (method === 8) return zlib.inflateRawSync(raw);
        throw new Error(`zip entry ${name}: compression method ${method} is not supported`);
      },
    });
  }
  return out;
}

/** A zip with stored entries (for tests and for bundling). */
export function writeZip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  const crc = (b) => { let c = 0xffffffff; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return (c ^ 0xffffffff) >>> 0; };
  for (const f of files) {
    const data = Buffer.from(f.data), name = Buffer.from(f.name), c = crc(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(c, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(c, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, data); centrals.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
