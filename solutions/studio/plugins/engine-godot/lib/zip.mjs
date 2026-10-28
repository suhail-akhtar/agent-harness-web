// Zip files without an unzip program: reads the official Godot downloads (the
// editor .zip, the export templates .tpz, Zip64 included) and writes the zip a
// package action hands out. Entries are streamed, so a 1.3 GB .tpz never sits in memory.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import zlib from 'node:zlib';

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return buf.subarray(0, bytesRead);
}

/** The entries of a zip: name, sizes, method, crc, where its local header is, unix mode. */
export async function zipEntries(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65_557);
    const tailBuf = await readAt(fh, size - tailLen, tailLen);
    let at = -1;
    for (let i = tailBuf.length - 22; i >= 0; i--) if (tailBuf.readUInt32LE(i) === EOCD) { at = i; break; }
    if (at < 0) throw new Error(`${path.basename(file)} is not a zip file (no end of central directory)`);
    let count = tailBuf.readUInt16LE(at + 10);
    let cdSize = tailBuf.readUInt32LE(at + 12);
    let cdOffset = tailBuf.readUInt32LE(at + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = at - 20;
      if (loc < 0 || tailBuf.readUInt32LE(loc) !== ZIP64_LOCATOR) throw new Error('a Zip64 file without its locator');
      const rec = await readAt(fh, Number(tailBuf.readBigUInt64LE(loc + 8)), 56);
      if (rec.readUInt32LE(0) !== ZIP64_EOCD) throw new Error('a broken Zip64 end of central directory');
      count = Number(rec.readBigUInt64LE(32));
      cdSize = Number(rec.readBigUInt64LE(40));
      cdOffset = Number(rec.readBigUInt64LE(48));
    }
    const cd = await readAt(fh, cdOffset, cdSize);
    const out = [];
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (cd.readUInt32LE(p) !== CENTRAL) throw new Error('a broken central directory');
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let csize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const nlen = cd.readUInt16LE(p + 28);
      const elen = cd.readUInt16LE(p + 30);
      const clen = cd.readUInt16LE(p + 32);
      const attr = cd.readUInt32LE(p + 38);
      let local = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nlen).toString('utf8');
      // Zip64 sizes and offsets, in this order, for the fields that overflowed.
      let e = p + 46 + nlen;
      const end = e + elen;
      while (e + 4 <= end) {
        const id = cd.readUInt16LE(e);
        const len = cd.readUInt16LE(e + 2);
        if (id === 1) {
          let q = e + 4;
          if (usize === 0xffffffff) { usize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (csize === 0xffffffff) { csize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (local === 0xffffffff) { local = Number(cd.readBigUInt64LE(q)); q += 8; }
        }
        e += 4 + len;
      }
      out.push({ name, method, crc, csize, usize, local, mode: (attr >>> 16) & 0o7777, dir: name.endsWith('/') });
      p = end + clen;
    }
    return out;
  } finally { await fh.close(); }
}

/** A name from a zip as a safe relative path (no "..", not absolute), or throws. */
export function safeName(name) {
  const n = String(name).replace(/\\/g, '/');
  if (!n || n.startsWith('/') || /^[a-z]:/i.test(n) || n.split('/').some((s) => s === '..')) throw new Error(`refused a zip entry outside its folder: ${name}`);
  return n;
}

/**
 * Extracts the entries `pick` chooses (name -> destination path, or null to skip) and
 * checks each one's CRC. Returns the paths written.
 */
export async function extractZip(file, pick, { signal } = {}) {
  const entries = await zipEntries(file);
  const written = [];
  const fh = await fsp.open(file, 'r');
  try {
    for (const en of entries) {
      if (en.dir) continue;
      const dest = pick(safeName(en.name), en);
      if (!dest) continue;
      signal?.throwIfAborted();
      const head = await readAt(fh, en.local, 30);
      if (head.readUInt32LE(0) !== LOCAL) throw new Error(`a broken local header for ${en.name}`);
      const start = en.local + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const partial = `${dest}.partial`;
      let crc = 0;
      const check = new Transform({ transform(chunk, _e, cb) { crc = zlib.crc32(chunk, crc); cb(null, chunk); } });
      const source = en.csize === 0 ? [Buffer.alloc(0)] : fs.createReadStream(file, { start, end: start + en.csize - 1 });
      const stages = en.method === 8 ? [source, zlib.createInflateRaw(), check, fs.createWriteStream(partial)] : en.method === 0 ? [source, check, fs.createWriteStream(partial)] : null;
      if (!stages) throw new Error(`${en.name}: compression method ${en.method} is not supported`);
      try { await pipeline(...stages, { signal }); } catch (e) { await fsp.rm(partial, { force: true }); throw e; }
      if ((crc >>> 0) !== en.crc) { await fsp.rm(partial, { force: true }); throw new Error(`${en.name}: CRC mismatch (a damaged download)`); }
      await fsp.rename(partial, dest);
      if (process.platform !== 'win32' && en.mode & 0o111) await fsp.chmod(dest, 0o755);
      written.push(dest);
    }
  } finally { await fh.close(); }
  return written;
}

/** Writes a zip of these files ({ name, file }), deflated; for builds a person hands out. */
export async function writeZip(out, files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const stamp = dosTime(new Date());
  for (const f of files) {
    const data = await fsp.readFile(f.file);
    const deflated = zlib.deflateRawSync(data, { level: 6 });
    const useStore = deflated.length >= data.length;
    const body = useStore ? data : deflated;
    const name = Buffer.from(safeName(f.name), 'utf8');
    const crc = zlib.crc32(data) >>> 0;
    const mode = f.executable ? 0o100755 : 0o100644;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(useStore ? 0 : 8, 8);
    local.writeUInt32LE(stamp, 10); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    chunks.push(local, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(CENTRAL, 0); c.writeUInt16LE(0x031e, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(useStore ? 0 : 8, 10);
    c.writeUInt32LE(stamp, 12); c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt32LE((mode << 16) >>> 0, 38); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  await fsp.mkdir(path.dirname(out), { recursive: true });
  await fsp.writeFile(out, Buffer.concat([...chunks, cd, end]));
  return { files: files.length, bytes: offset + cd.length + 22 };
}

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return ((date << 16) | time) >>> 0;
}
