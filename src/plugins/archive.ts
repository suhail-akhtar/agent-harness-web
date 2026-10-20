import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

// Plugin archives: .tgz (ustar), packed and unpacked here so no external tar
// is needed on any OS. Unpacking is strict - an archive comes from the network:
// regular files and folders only (no links, devices), no absolute paths or
// "..", and limits on count and size. Its contents are then verified against
// the plugin's signature like any other plugin folder.

const BLOCK = 512;
const MAX_FILES = 5000;
const MAX_BYTES = 200 * 1024 * 1024;

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

function header(name: string, size: number, type: '0' | '5', mode: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const i = name.lastIndexOf('/', 154);
    if (i <= 0 || Buffer.byteLength(name.slice(i + 1)) > 100) throw new Error(`path too long for an archive: ${name}`);
    prefix = name.slice(0, i);
    base = name.slice(i + 1);
  }
  h.write(base, 0, 100, 'utf8');
  h.write(octal(mode, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii');
  h.write(octal(0, 8), 116, 8, 'ascii');
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(0, 12), 136, 12, 'ascii'); // mtime 0: the same folder packs to the same bytes
  h.write('        ', 148, 8, 'ascii');
  h.write(type, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + ' ', 148, 8, 'ascii');
  return h;
}

/** A folder as .tgz, entries sorted, links refused. */
export async function pack(dir: string): Promise<Buffer> {
  const parts: Buffer[] = [];
  const walk = async (rel: string) => {
    const entries = (await fs.readdir(path.join(dir, rel), { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) throw new Error(`refusing to pack a symbolic link: ${r}`);
      if (e.isDirectory()) { parts.push(header(`${r}/`, 0, '5', 0o755)); await walk(r); }
      else if (e.isFile()) {
        const data = await fs.readFile(path.join(dir, r));
        const st = await fs.stat(path.join(dir, r));
        parts.push(header(r, data.length, '0', st.mode & 0o111 ? 0o755 : 0o644), data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK));
      }
    }
  };
  await walk('');
  parts.push(Buffer.alloc(BLOCK * 2));
  return zlib.gzipSync(Buffer.concat(parts), { level: 9 });
}

const str = (b: Buffer, off: number, len: number) => { const s = b.subarray(off, off + len); const z = s.indexOf(0); return s.subarray(0, z < 0 ? len : z).toString('utf8'); };

/** A safe relative path inside the destination, or an error. */
function safeRel(name: string): string {
  const n = name.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!n || n.startsWith('/') || /^[a-z]:/i.test(n) || n.split('/').some((p) => p === '..' || p === '')) throw new Error(`unsafe path in archive: ${name}`);
  return n;
}

/** Unpacks a .tgz into dest (which must not exist yet). */
export async function unpack(tgz: Buffer, dest: string): Promise<string[]> {
  const tar = zlib.gunzipSync(tgz, { maxOutputLength: MAX_BYTES });
  await fs.mkdir(dest, { recursive: false });
  const files: string[] = [];
  let off = 0;
  let paxPath: string | undefined;
  while (off + BLOCK <= tar.length) {
    const h = tar.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
    if (sum !== parseInt(str(h, 148, 8).trim(), 8)) throw new Error('corrupt archive (bad header checksum)');
    const size = parseInt(str(h, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(h[156]!) || '0';
    const prefix = str(h, 345, 155);
    const name = paxPath ?? (prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100));
    paxPath = undefined;
    const body = tar.subarray(off + BLOCK, off + BLOCK + size);
    off += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x') { paxPath = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1]; continue; }
    if (type === 'g') continue;
    if (type === '5') { await fs.mkdir(path.join(dest, safeRel(name)), { recursive: true }); continue; }
    if (type !== '0' && type !== '\0') throw new Error(`archive entry ${name} is not a plain file or folder (type ${type})`);
    const rel = safeRel(name);
    if (files.length >= MAX_FILES) throw new Error(`archive has more than ${MAX_FILES} files`);
    const target = path.join(dest, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body, { flag: 'wx', mode: parseInt(str(h, 100, 8).trim() || '644', 8) & 0o111 ? 0o755 : 0o644 });
    files.push(rel);
  }
  return files;
}
