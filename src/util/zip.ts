// A small zip reader (and writer) for packages people bring: Anthropic .skill files and .zip skill packages. Stored
// and deflated entries only (what every zip tool writes), read from the central directory; guarded against what a
// package from elsewhere can do: paths out of the folder, too many entries, too much data once inflated (zip bombs).
import zlib from 'node:zlib';

export interface ZipEntry { name: string; data: Buffer }
export class ZipError extends Error {}

const LIMITS = { entries: 2000, file: 20 * 1024 * 1024, total: 60 * 1024 * 1024 };

/** A zip's files (folders left out), each name a plain relative path; throws ZipError when it is not one or is unsafe. */
export function readZip(buf: Buffer, limits = LIMITS): ZipEntry[] {
  // The end of central directory record: within the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new ZipError('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  if (count > limits.entries) throw new ZipError(`too many entries (${count}; at most ${limits.entries})`);
  const out: ZipEntry[] = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new ZipError('a damaged zip (central directory)');
    const method = buf.readUInt16LE(at + 10);
    const csize = buf.readUInt32LE(at + 20);
    const usize = buf.readUInt32LE(at + 24);
    const nlen = buf.readUInt16LE(at + 28); const elen = buf.readUInt16LE(at + 30); const clen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nlen).toString('utf8').replace(/\\/g, '/');
    at += 46 + nlen + elen + clen;
    if (name.endsWith('/')) continue;
    if (!name || name.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(name) || /^[a-zA-Z]:/.test(name) || name.includes('\0')) throw new ZipError(`an unsafe path in the zip: ${name.slice(0, 120)}`);
    if (usize > limits.file) throw new ZipError(`${name} is too large (${Math.round(usize / 1048576)} MB)`);
    if ((total += usize) > limits.total) throw new ZipError(`the zip holds more than ${limits.total / 1048576} MB`);
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new ZipError('a damaged zip (local header)');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: limits.file });
    else throw new ZipError(`${name}: compression method ${method} is not supported (stored or deflated only)`);
    if (data.length !== usize) throw new ZipError(`${name}: its size does not match the zip's directory`);
    out.push({ name, data });
  }
  return out;
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/** A zip of these files (deflated): for exporting a skill as a package. */
export function writeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = []; const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8');
    const comp = zlib.deflateRawSync(e.data);
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(e.data.length, 22); lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(e.data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
