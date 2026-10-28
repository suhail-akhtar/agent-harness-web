// Archives without a dependency: reading the editor's project templates (.tgz, as npm packs
// them: ustar with pax or GNU long names) and writing a .zip of a build for package.

import zlib from 'node:zlib';

const str = (b, o, n) => { const s = b.toString('utf8', o, o + n); const z = s.indexOf('\0'); return z < 0 ? s : s.slice(0, z); };
const octal = (b, o, n) => parseInt(str(b, o, n).trim() || '0', 8) || 0;

/** The files of a tar archive (gzip-compressed or not): [{ name, type: 'file' | 'dir', data }]. */
export function untar(buf) {
  const tar = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf;
  const out = [];
  let longName = null;
  let pax = {};
  for (let o = 0; o + 512 <= tar.length;) {
    const h = tar.subarray(o, o + 512);
    if (h.every((x) => x === 0)) break;
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 48);
    const body = tar.subarray(o + 512, o + 512 + size);
    o += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = str(body, 0, body.length); continue; }
    if (type === 'x') {
      pax = {};
      for (const rec of body.toString('utf8').split('\n')) { const m = /^\d+ ([^=]+)=(.*)$/.exec(rec); if (m) pax[m[1]] = m[2]; }
      continue;
    }
    if (type === 'g') continue;
    const prefix = str(h, 257, 6).startsWith('ustar') ? str(h, 345, 155) : '';
    const name = pax.path ?? longName ?? (prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100));
    longName = null;
    pax = {};
    if (type === '0' || type === '\0' || type === '7') out.push({ name, type: 'file', data: Buffer.from(body) });
    else if (type === '5') out.push({ name: name.replace(/\/$/, ''), type: 'dir', data: Buffer.alloc(0) });
  }
  return out;
}

/** A tar archive of files (for tests and fixtures): [{ name, data }]. */
export function tar(files) {
  const parts = [];
  for (const f of files) {
    const data = Buffer.from(f.data);
    const h = Buffer.alloc(512);
    const name = Buffer.from(f.name);
    if (name.length > 100) {
      const ln = Buffer.alloc(512);
      ln.write('././@LongLink', 0); ln.write('0000644\0', 100); ln.write(`${name.length.toString(8).padStart(11, '0')}\0`, 124); ln.write('L', 156); ln.write('ustar  \0', 257);
      checksum(ln);
      parts.push(ln, name, Buffer.alloc(Math.ceil(name.length / 512) * 512 - name.length));
    }
    h.write(f.name.slice(0, 100), 0); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124); h.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136);
    h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
    checksum(h);
    parts.push(h, data, Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function checksum(h) {
  h.fill(32, 148, 156);
  let sum = 0;
  for (const x of h) sum += x;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
}

/** A .zip of files (deflated): [{ name, data }]. */
export function zip(files) {
  const local = [];
  const central = [];
  let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.name.replace(/\\/g, '/'));
    const data = Buffer.from(f.data);
    const comp = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data) >>> 0;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42);
    local.push(h, name, comp);
    central.push(c, name);
    off += h.length + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...local, cd, end]);
}

/** The names in a .zip (for checks). */
export function zipNames(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip file');
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < n; i++) {
    const len = buf.readUInt16LE(p + 28); const extra = buf.readUInt16LE(p + 30); const comment = buf.readUInt16LE(p + 32);
    names.push(buf.toString('utf8', p + 46, p + 46 + len));
    p += 46 + len + extra + comment;
  }
  return names;
}
