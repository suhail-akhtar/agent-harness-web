import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The harness home: one folder the person can find, open and move, shared by the server, the CLI
// and the desktop app (DESIGN section 19).
//
//   <home>/data/         the server's data (what HARNESS_DATA held): sessions, vault, plugin data
//   <home>/workspaces/   default/ and one folder per project the harness creates
//   <home>/tmp/          scratch conversations; entries older than N days (7) are removed
//   <home>/exports/      dashboards, reports and session exports
//   <home>/plugins/      catalogue installs
//   <home>/logs/         the desktop's engine log
//   <home>/settings.json the app's settings for this home (the tmp clean-up age)
//
// Where it is: HARNESS_HOME, else the folder a move left in ~/.harness-location, else ~/.harness.
// Explicit variables still win for what they name: HARNESS_DATA (or HARNESS_DATA_DIR) for the data,
// HARNESS_LOCAL_ROOTS adds folders sessions may work in (the home's workspaces and tmp are always
// there unless HARNESS_HOME_ROOTS=off).

export interface HomeLayout {
  home: string;
  data: string;
  workspaces: string;
  defaultWorkspace: string;
  tmp: string;
  exports: string;
  plugins: string;
  logs: string;
  settings: string;
}

export type Env = Record<string, string | undefined>;
/** path, path.win32 or path.posix. */
export type PathMod = typeof path.posix;

/** A file in the person's own home that names a moved harness home (written by a move). */
export const POINTER_FILE = '.harness-location';
/** A file every harness home has, so nothing else is ever taken for one (and removed as an old copy). */
export const HOME_MARKER = '.harness-home';
export const DEFAULT_TMP_DAYS = 7;

interface ResolveOpts {
  env?: Env;
  /** The person's home folder (default os.homedir()). */
  userHome?: string;
  /** The pointer file to read (default <userHome>/.harness-location); null: none. */
  pointer?: string | null;
  /** path.win32 or path.posix (tests); default the platform's. */
  pathMod?: PathMod;
  /** The home when nothing names one (default <userHome>/.harness). */
  fallback?: string;
}

function expand(p: string, userHome: string, P: PathMod): string {
  const t = p.trim();
  if (t === '~') return userHome;
  if (t.startsWith('~/') || t.startsWith('~\\')) return P.join(userHome, t.slice(2));
  return P.resolve(t);
}

function readPointer(file: string | null, userHome: string, P: PathMod): string | undefined {
  if (!file) return undefined;
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    const j = raw.startsWith('{') ? (JSON.parse(raw) as { home?: unknown }).home : raw;
    if (typeof j !== 'string' || !j.trim()) return undefined;
    const p = expand(j, userHome, P);
    return P.isAbsolute(p) ? p : undefined;
  } catch { return undefined; }
}

/** Where the harness home is. */
export function resolveHome(o: ResolveOpts = {}): string {
  const env = o.env ?? process.env;
  const P = o.pathMod ?? path;
  const userHome = o.userHome ?? os.homedir();
  if (env.HARNESS_HOME?.trim()) return expand(env.HARNESS_HOME, userHome, P);
  const moved = readPointer(o.pointer === undefined ? P.join(userHome, POINTER_FILE) : o.pointer, userHome, P);
  return moved ?? o.fallback ?? P.join(userHome, '.harness');
}

export function homeLayout(home: string, P: PathMod = path): HomeLayout {
  const workspaces = P.join(home, 'workspaces');
  return {
    home, data: P.join(home, 'data'), workspaces, defaultWorkspace: P.join(workspaces, 'default'), tmp: P.join(home, 'tmp'),
    exports: P.join(home, 'exports'), plugins: P.join(home, 'plugins'), logs: P.join(home, 'logs'), settings: P.join(home, 'settings.json'),
  };
}

export interface HarnessPaths {
  layout: HomeLayout;
  /** The server's data folder, and why: an explicit variable, the home, or an older default folder still in use. */
  dataDir: string;
  dataFrom: 'env' | 'home' | 'legacy';
  /** Folders local sessions may work in: the home's workspaces and tmp, then HARNESS_LOCAL_ROOTS. */
  localRoots: string[];
  /** Where catalogue installs go: the home's plugins/ with the home's data, else <data>/plugins as before. */
  installDir: string;
}

const nonEmptyDir = (p: string): boolean => { try { return fs.readdirSync(p).length > 0; } catch { return false; } };

/**
 * Every path the server and the CLI need, from the environment. `legacy` is an older default data
 * folder (the repository's .harness-data): still used while it has data and the home has none, so
 * nothing disappears on an update (the start says where it is and how to move it).
 */
export function harnessPaths(o: ResolveOpts & { legacy?: string } = {}): HarnessPaths {
  const env = o.env ?? process.env;
  const P = o.pathMod ?? path;
  const layout = homeLayout(resolveHome(o), P);
  const explicit = env.HARNESS_DATA?.trim() || env.HARNESS_DATA_DIR?.trim();
  let dataDir = layout.data; let dataFrom: HarnessPaths['dataFrom'] = 'home';
  if (explicit) { dataDir = P.resolve(explicit); dataFrom = 'env'; }
  else if (o.legacy && nonEmptyDir(o.legacy) && !nonEmptyDir(layout.data)) { dataDir = P.resolve(o.legacy); dataFrom = 'legacy'; }
  const extra = (env.HARNESS_LOCAL_ROOTS ?? '').split(P.delimiter).map((s) => s.trim()).filter(Boolean).map((p) => P.resolve(p));
  const own = env.HARNESS_HOME_ROOTS?.trim() === 'off' ? [] : [layout.workspaces, layout.tmp];
  const localRoots = [...own, ...extra].filter((p, i, a) => a.indexOf(p) === i);
  return { layout, dataDir, dataFrom, localRoots, installDir: dataFrom === 'home' ? layout.plugins : P.join(dataDir, 'plugins') };
}

/**
 * Creates the home's folders (and settings.json, and the marker) where they are missing; never
 * changes what is there. Returns true when the home was made now (a first run).
 */
export function ensureHome(l: HomeLayout): boolean {
  const fresh = !fs.existsSync(path.join(l.home, HOME_MARKER));
  for (const d of [l.home, l.data, l.workspaces, l.defaultWorkspace, l.tmp, l.exports, l.plugins, l.logs]) fs.mkdirSync(d, { recursive: true });
  if (!fs.existsSync(l.settings)) fs.writeFileSync(l.settings, `${JSON.stringify({ tmpCleanupDays: DEFAULT_TMP_DAYS }, null, 1)}\n`);
  if (fresh) fs.writeFileSync(path.join(l.home, HOME_MARKER), `${JSON.stringify({ created: new Date().toISOString(), note: 'The harness home. Its folders are described in docs/desktop/DESIGN.md, section 19.' }, null, 1)}\n`);
  return fresh;
}

export interface HomeSettings { tmpCleanupDays: number }

export function readHomeSettings(l: HomeLayout): HomeSettings {
  let j: Record<string, unknown> = {};
  try { const v = JSON.parse(fs.readFileSync(l.settings, 'utf8')) as unknown; if (v && typeof v === 'object' && !Array.isArray(v)) j = v as Record<string, unknown>; } catch { /* defaults */ }
  const d = Number(j.tmpCleanupDays);
  return { tmpCleanupDays: Number.isFinite(d) && d >= 1 && d <= 365 ? Math.floor(d) : DEFAULT_TMP_DAYS };
}

/** Merges into settings.json (keeps keys it does not know: the file is the app's too). */
export function writeHomeSettings(l: HomeLayout, patch: Partial<HomeSettings>): HomeSettings {
  let j: Record<string, unknown> = {};
  try { const v = JSON.parse(fs.readFileSync(l.settings, 'utf8')) as unknown; if (v && typeof v === 'object' && !Array.isArray(v)) j = v as Record<string, unknown>; } catch { /* new */ }
  if (patch.tmpCleanupDays !== undefined) {
    const d = Math.floor(Number(patch.tmpCleanupDays));
    if (!Number.isFinite(d) || d < 1 || d > 365) throw new Error('The clean-up age is 1 to 365 days.');
    j.tmpCleanupDays = d;
  }
  const tmp = `${l.settings}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(l.settings), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(j, null, 1)}\n`);
  fs.renameSync(tmp, l.settings);
  return readHomeSettings(l);
}

// ---------------- tmp clean-up ----------------

const inside = (root: string, p: string) => p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** Removes a link itself, never what it points at (a directory link on Windows needs rmdir). */
async function removeLink(p: string): Promise<void> {
  try { await fsp.unlink(p); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EISDIR') await fsp.rmdir(p); else throw e;
  }
}

/** The newest modification time in a tree, read with lstat (links are not followed). */
async function newest(p: string, depth = 0): Promise<number> {
  const st = await fsp.lstat(p);
  let t = st.mtimeMs;
  if (st.isDirectory() && !st.isSymbolicLink() && depth < 32) {
    for (const e of await fsp.readdir(p).catch(() => [] as string[])) t = Math.max(t, await newest(path.join(p, e), depth + 1).catch(() => 0));
  }
  return t;
}

/** Removes a tree under root without following a link: links are unlinked, directories emptied then removed. */
async function removeTree(root: string, p: string, depth = 0): Promise<void> {
  if (!inside(root, p)) throw new Error(`refused: ${p} is not inside ${root}`);
  let st: fs.Stats;
  try { st = await fsp.lstat(p); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  if (st.isSymbolicLink()) { await removeLink(p); return; }
  if (st.isDirectory()) {
    // The directory must still be where it was (not swapped for a link to elsewhere since lstat).
    const real = await fsp.realpath(p);
    if (!inside(root, real)) throw new Error(`refused: ${p} now leads outside ${root}`);
    if (depth > 64) throw new Error(`refused: ${p} nests too deeply`);
    for (const e of await fsp.readdir(p)) await removeTree(root, path.join(p, e), depth + 1);
    await fsp.rmdir(p);
    return;
  }
  await fsp.unlink(p);
}

export interface CleanResult { removed: string[]; kept: number; errors: string[] }

/**
 * Removes the entries of the tmp folder (scratch conversations) not changed for `maxAgeDays`.
 * Only inside tmp: a link in it is removed as a link (what it points at is never touched, nor
 * walked), and nothing outside the folder is read or removed.
 */
export async function cleanTmp(tmp: string, o: { maxAgeDays?: number; now?: number } = {}): Promise<CleanResult> {
  const out: CleanResult = { removed: [], kept: 0, errors: [] };
  const days = o.maxAgeDays ?? DEFAULT_TMP_DAYS;
  if (!(days >= 1)) throw new Error('maxAgeDays must be at least 1');
  let root: string;
  try { root = await fsp.realpath(tmp); } catch { return out; }
  if (path.parse(root).root === root || root === path.resolve(os.homedir())) throw new Error(`refused to clean ${root}: not a tmp folder`);
  const cutoff = (o.now ?? Date.now()) - days * 86_400_000;
  for (const name of await fsp.readdir(root)) {
    const p = path.join(root, name);
    try {
      const st = await fsp.lstat(p);
      const t = st.isSymbolicLink() ? st.mtimeMs : await newest(p);
      if (t >= cutoff) { out.kept++; continue; }
      await removeTree(root, p);
      out.removed.push(name);
    } catch (e) { out.errors.push(`${name}: ${(e as Error).message}`); }
  }
  return out;
}

/** Cleans tmp now and then daily (the timer does not keep the process alive). Returns the stop. */
export function scheduleTmpCleanup(l: HomeLayout, log: (m: string) => void = () => {}, everyMs = 86_400_000): () => void {
  const run = () => cleanTmp(l.tmp, { maxAgeDays: readHomeSettings(l).tmpCleanupDays })
    .then((r) => { if (r.removed.length || r.errors.length) log(`tmp clean-up: removed ${r.removed.length} folder(s) older than ${readHomeSettings(l).tmpCleanupDays} days${r.errors.length ? `; ${r.errors.length} could not be removed (${r.errors.slice(0, 3).join('; ')})` : ''}`); })
    .catch((e: Error) => log(`tmp clean-up: ${e.message}`));
  void run();
  const t = setInterval(run, everyMs);
  t.unref?.();
  return () => clearInterval(t);
}

// ---------------- copies: migration and moving the home ----------------

interface TreeEntry { rel: string; size: number; kind: 'file' | 'dir' | 'link' }

async function listTree(root: string): Promise<TreeEntry[]> {
  const out: TreeEntry[] = [];
  const walk = async (dir: string, rel: string) => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name); const r = rel ? `${rel}/${e.name}` : e.name;
      const st = await fsp.lstat(p);
      if (st.isSymbolicLink()) out.push({ rel: r, size: 0, kind: 'link' });
      else if (st.isDirectory()) { out.push({ rel: r, size: 0, kind: 'dir' }); await walk(p, r); }
      else out.push({ rel: r, size: st.size, kind: 'file' });
    }
  };
  await walk(root, '');
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** The total size of a folder in bytes and its file count (links not followed). */
export async function folderSize(root: string): Promise<{ bytes: number; files: number }> {
  try { const t = await listTree(root); return { bytes: t.reduce((a, x) => a + x.size, 0), files: t.filter((x) => x.kind === 'file').length }; } catch { return { bytes: 0, files: 0 }; }
}

/** Copies a folder and checks the copy has every entry with the same size; removes a partial copy on failure. */
export async function copyVerified(from: string, to: string, o: { skip?: (rel: string) => boolean } = {}): Promise<{ files: number; bytes: number }> {
  if (fs.existsSync(to) && fs.readdirSync(to).length) throw new Error(`${to} is not empty`);
  const partial = `${to}.partial-${process.pid}`;
  await fsp.rm(partial, { recursive: true, force: true });
  try {
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.cp(from, partial, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false, preserveTimestamps: true, filter: (src) => !o.skip?.(path.relative(from, src).split(path.sep).join('/')) });
    const want = (await listTree(from)).filter((x) => !o.skip?.(x.rel));
    const got = await listTree(partial);
    const key = (x: TreeEntry) => `${x.kind}:${x.rel}:${x.size}`;
    const have = new Set(got.map(key));
    const missing = want.filter((x) => !have.has(key(x)));
    if (missing.length) throw new Error(`the copy differs from the original (${missing.length} entr${missing.length === 1 ? 'y' : 'ies'}, e.g. ${missing[0]!.rel})`);
    if (fs.existsSync(to)) await fsp.rmdir(to);
    await fsp.rename(partial, to);
    return { files: want.filter((x) => x.kind === 'file').length, bytes: want.reduce((a, x) => a + x.size, 0) };
  } catch (e) {
    await fsp.rm(partial, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

export interface MigrationResult { status: 'moved' | 'nothing' | 'done-before' | 'failed'; dataDir: string; backup?: string; error?: string; message: string }

/**
 * Moves an older data folder (the desktop's user-data engine folder) into the home's data, once:
 * copied, verified, then the old one renamed to <name>.backup-<date> (kept; a note in it says where
 * the data went). A failure leaves the old folder as it was and keeps using it.
 */
export async function migrateDataDir(from: string, to: string): Promise<MigrationResult> {
  const marker = path.join(to, '.migrated.json');
  if (fs.existsSync(marker)) return { status: 'done-before', dataDir: to, message: `data: ${to} (moved here before)` };
  if (!nonEmptyDir(from)) return { status: 'nothing', dataDir: to, message: `data: ${to}` };
  if (nonEmptyDir(to)) return { status: 'nothing', dataDir: to, message: `data: ${to} (an older data folder, ${from}, was left as it is: the home already has data)` };
  try {
    const r = await copyVerified(from, to);
    const stamp = new Date().toISOString().slice(0, 10);
    let backup = `${from}.backup-${stamp}`;
    for (let i = 2; fs.existsSync(backup); i++) backup = `${from}.backup-${stamp}-${i}`;
    let renamed = true;
    try { await fsp.rename(from, backup); } catch { renamed = false; backup = from; }
    await fsp.writeFile(path.join(backup, 'MOVED.txt'), `This folder was copied to ${to} on ${new Date().toISOString()}.\nIt is kept as a backup: remove it when you no longer need it.\n`).catch(() => {});
    await fsp.writeFile(marker, `${JSON.stringify({ from, backup, at: new Date().toISOString(), files: r.files, bytes: r.bytes }, null, 1)}\n`);
    return { status: 'moved', dataDir: to, backup, message: `data: moved ${r.files} file(s) from ${from} to ${to}; the old folder is kept as a backup at ${backup}${renamed ? '' : ' (it could not be renamed)'}` };
  } catch (e) {
    return { status: 'failed', dataDir: from, error: (e as Error).message, message: `data: could not move ${from} to ${to} (${(e as Error).message}); still using ${from}` };
  }
}

/** Replaces `from` with `to` at the start of every string in a JSON value (paths stored in session records). */
export function rebasePaths<T>(v: T, from: string, to: string): T {
  const fix = (x: unknown): unknown => {
    if (typeof x === 'string') return x === from || x.startsWith(from + path.sep) || x.startsWith(`${from}/`) ? to + x.slice(from.length) : x;
    if (Array.isArray(x)) return x.map(fix);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, fix(y)]));
    return x;
  };
  return fix(v) as T;
}

export interface MoveResult { home: string; old: string; files: number; bytes: number; sessionsRebased: number }

/**
 * Moves the home: copies it to `to` (which must be new or empty, and not inside it), verifies the
 * copy, points the sessions' recorded folders at the new place, and writes the pointer so the
 * server, the CLI and the app all find it. The old copy is kept until the person removes it.
 */
export async function moveHome(from: string, to: string, o: { pointer?: string } = {}): Promise<MoveResult> {
  const src = path.resolve(from); const dst = path.resolve(to);
  if (!path.isAbsolute(to)) throw new Error('Choose a full path for the new location.');
  if (src === dst) throw new Error('That is where the home is now.');
  if (inside(src, dst)) throw new Error('The new location cannot be inside the current one.');
  if (inside(dst, src)) throw new Error('The new location cannot contain the current one.');
  if (!fs.existsSync(path.join(src, HOME_MARKER))) throw new Error(`${src} is not a harness home.`);
  const r = await copyVerified(src, dst, { skip: (rel) => /\.partial-\d+(\/|$)/.test(rel) });
  let sessionsRebased = 0;
  const sessions = path.join(dst, 'data', 'sessions');
  for (const id of await fsp.readdir(sessions).catch(() => [] as string[])) {
    const f = path.join(sessions, id, 'meta.json');
    try {
      const before = await fsp.readFile(f, 'utf8');
      const after = JSON.stringify(rebasePaths(JSON.parse(before) as unknown, src, dst), null, 1);
      if (after !== JSON.stringify(JSON.parse(before), null, 1)) { await fsp.writeFile(f, after); sessionsRebased++; }
    } catch { /* not a session */ }
  }
  await fsp.writeFile(path.join(src, 'MOVED.txt'), `This harness home was copied to ${dst} on ${new Date().toISOString()}.\nThe harness uses the new one now; remove this copy when you no longer need it.\n`).catch(() => {});
  const pointer = o.pointer ?? path.join(os.homedir(), POINTER_FILE);
  await fsp.writeFile(pointer, `${JSON.stringify({ home: dst, movedFrom: src, at: new Date().toISOString() }, null, 1)}\n`);
  return { home: dst, old: src, files: r.files, bytes: r.bytes, sessionsRebased };
}

/** Removes an old home copy after a move: only a folder that is a harness home and not the current one. */
export async function removeOldHome(old: string, current: string): Promise<void> {
  const o = path.resolve(old); const c = path.resolve(current);
  if (o === c || inside(o, c) || inside(c, o)) throw new Error('That is the home in use.');
  if (!fs.existsSync(path.join(o, HOME_MARKER))) throw new Error(`${o} is not a harness home; nothing was removed.`);
  await fsp.rm(o, { recursive: true, force: true });
}
