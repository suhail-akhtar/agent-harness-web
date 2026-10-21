import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Files in the data folder may be shared by several servers (NFS, SMB, a shared
// volume). Three rules make that safe:
//  - a write never shows half a file: it goes to a temp file next to the target,
//    unique to this host, process and write, and is renamed over it;
//  - a read-change-write of a file other servers also change happens under a
//    short lock (<file>.lock, created atomically), on the file as it is on disk
//    now, not on an old copy in memory;
//  - a reader that keeps a copy in memory notices when the file changed on disk.

const HOST = os.hostname().replace(/[^\w.-]/g, '_').slice(0, 40);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** A temp name next to `file` that no other host, process or write uses. */
export const tempName = (file: string): string => `${file}.${HOST}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;

/**
 * Writes `data` to `file` so readers see the old or the new content, never part of it.
 * On Windows (and SMB) a rename over a file someone has open (a reader, a virus scanner)
 * fails for a moment: retried for up to about ten seconds.
 */
export async function writeFileAtomic(file: string, data: string | Uint8Array, opts: { mode?: number } = {}): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = tempName(file);
  await fs.writeFile(tmp, data, { mode: opts.mode });
  for (let i = 0; ; i++) {
    try { await fs.rename(tmp, file); return; } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (!BUSY.has(code) || i >= 100) { await fs.rm(tmp, { force: true }).catch(() => {}); throw err; }
      await sleep(Math.min(100, 5 + i * 5) + Math.random() * 10);
    }
  }
}

/** A JSON file's content, or `fallback` when it does not exist (or is not JSON yet). */
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; } catch { return fallback; }
}

export class LockTimeout extends Error {}

/**
 * Runs `fn` holding an exclusive lock on `file` across servers: `<file>.lock` is
 * created with O_EXCL (atomic on local disks, NFSv3+ and SMB). A lock older than
 * `staleMs` was left by a process that died and is broken. Keep `fn` short.
 */
export async function withFileLock<T>(file: string, fn: () => Promise<T>, opts: { staleMs?: number; waitMs?: number } = {}): Promise<T> {
  const lock = `${file}.lock`;
  const staleMs = opts.staleMs ?? 30_000;
  const end = Date.now() + (opts.waitMs ?? 60_000);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const me = `${HOST} ${process.pid} ${crypto.randomBytes(6).toString('hex')}`;
  for (let i = 0; ; i++) {
    try {
      const h = await fs.open(lock, 'wx');
      try { await h.writeFile(`${me} ${Date.now()}\n`); } finally { await h.close(); }
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      // Windows answers EPERM for a lock file another process is deleting this moment: busy, try again.
      if (code !== 'EEXIST' && !BUSY.has(code)) throw err;
      const st = code === 'EEXIST' ? await fs.stat(lock).catch(() => null) : null;
      // Left by a crash: break it (by renaming, so two breakers cannot both win).
      if (st && Date.now() - st.mtimeMs > staleMs) {
        const gone = `${lock}.${crypto.randomBytes(4).toString('hex')}.stale`;
        if (await fs.rename(lock, gone).then(() => true, () => false)) await fs.rm(gone, { force: true }).catch(() => {});
        continue;
      }
      if (Date.now() > end) throw new LockTimeout(`${path.basename(file)} is locked by another process (${lock})`);
      await sleep(Math.min(200, 5 + i * 5) + Math.random() * 10);
    }
  }
  try { return await fn(); } finally {
    // Only our own lock is removed (a slow fn may have had it broken and taken by another).
    const held = await fs.readFile(lock, 'utf8').catch(() => '');
    if (held.startsWith(me)) await fs.rm(lock, { force: true }).catch(() => {});
  }
}

/** Notices when a file changed on disk since it was last read or written here (size, mtime, inode). */
export class FileWatch {
  private file: string;
  private seen = '';
  private checked = 0;
  private everyMs: number;
  constructor(file: string, everyMs = Number(process.env.HARNESS_SYNC_MS ?? 1000)) { this.file = file; this.everyMs = everyMs; }

  private static sig(st: { size: number; mtimeMs: number; ino: number } | null): string { return st ? `${st.size}:${st.mtimeMs}:${st.ino}` : 'none'; }

  /** Records the file as it is now (after this process read or wrote it). */
  async mark(): Promise<void> { this.seen = FileWatch.sig(await fs.stat(this.file).catch(() => null)); this.checked = Date.now(); }

  /** True when the file is not as last marked. Checked at most every `everyMs` unless `force`. */
  async changed(force = false): Promise<boolean> {
    if (!force && Date.now() - this.checked < this.everyMs) return false;
    this.checked = Date.now();
    return FileWatch.sig(await fs.stat(this.file).catch(() => null)) !== this.seen;
  }
}
