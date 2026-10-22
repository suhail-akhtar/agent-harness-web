import fs from 'node:fs/promises';
import path from 'node:path';
import type { Session } from '../core/session.ts';
import { PathError, resolveIn, within } from '../tools/paths.ts';

// A session's workspace as a person sees it from the desktop: a lazy file tree, writes,
// renames, deletes, uploads, name and content search, and git status, diff and log.
//
// Reads go through the same confinement as the agent's file tools (resolveIn: the real
// path, links followed, must stay inside the workspace) and come back with the session's
// vault values hidden. Writes are refused outside the workspace, through a link that
// leaves it, on the workspace itself, and anywhere inside a .git folder (the repository's
// internals: hooks and config there would run code). A person's write is not an agent
// tool call - nobody is asked - but the session is told (Session.userChangedFiles).
// Git runs where the session's commands run (its sandbox, or the server folder), never
// with the server's own rights over a sandbox's repository.

export class WorkspaceError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** Big folders listed but never walked into (marked heavy). */
export const HEAVY_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next', 'target', '.cache', '.gradle', '.terraform']);
const DIR_CAP = 2000;
export const WRITE_LIMIT = 10 * 1024 * 1024;

const posix = (p: string) => p.split(path.sep).join('/');

function workspaceOf(s: Session): string {
  if (s.meta.runtime.kind === 'companion') throw new WorkspaceError(501, 'The files of a companion session live on that computer: the server cannot read or change them.');
  return s.workspace;
}

async function realRoot(s: Session): Promise<string> {
  const ws = workspaceOf(s);
  await fs.mkdir(ws, { recursive: true });
  return fs.realpath(ws);
}

/** A path inside the workspace (relative, or absolute under it), resolved through links. */
async function inside(s: Session, rel: unknown): Promise<{ real: string; rel: string; root: string }> {
  if (typeof rel !== 'string' || rel.includes('\0') || rel.length > 1024) throw new WorkspaceError(400, 'path is required');
  const root = await realRoot(s);
  const p = rel.trim() === '' || rel === '/' ? '.' : rel;
  let real: string;
  try { real = await resolveIn({ root, displayRoot: root }, p); } catch (e) { throw new WorkspaceError(e instanceof PathError ? 400 : 500, (e as Error).message); }
  return { real, rel: posix(path.relative(root, real)) || '.', root };
}

/** Writes may not touch the workspace itself or anything in a .git folder (by the name asked for, or where links lead). */
async function writable(s: Session, rel: unknown): Promise<{ real: string; rel: string; root: string }> {
  if (isGitPath(String(rel))) throw new WorkspaceError(403, GIT_REFUSED);
  const t = await inside(s, rel);
  if (t.rel === '.' || t.real === t.root) throw new WorkspaceError(400, 'that is the workspace itself');
  if (isGitPath(t.rel)) throw new WorkspaceError(403, GIT_REFUSED);
  return t;
}

const GIT_REFUSED = 'The repository internals (.git) are not changed from here: use git through the agent or a terminal.';
const isGitPath = (p: string) => p.split(/[\\/]+/).some((seg) => seg.toLowerCase() === '.git');

export interface TreeEntry { name: string; path: string; type: 'file' | 'dir'; size: number; mtime: number; heavy?: boolean; symlink?: boolean; children?: TreeEntry[]; truncated?: boolean }

/** One folder's entries (folders first), `depth` levels down (heavy folders and links are never walked into). */
export async function fileTree(s: Session, rel: string, depth = 1): Promise<{ path: string; entries: TreeEntry[]; truncated?: boolean }> {
  const t = await inside(s, rel);
  const st = await fs.stat(t.real).catch(() => null);
  if (!st) throw new WorkspaceError(404, 'not found');
  if (!st.isDirectory()) throw new WorkspaceError(400, 'not a folder');
  const list = async (dirReal: string, dirRel: string, level: number): Promise<{ entries: TreeEntry[]; truncated?: boolean }> => {
    const names = await fs.readdir(dirReal, { withFileTypes: true }).catch(() => []);
    const truncated = names.length > DIR_CAP;
    const out: TreeEntry[] = [];
    for (const d of names.slice(0, DIR_CAP)) {
      const full = path.join(dirReal, d.name);
      const r = dirRel === '.' ? d.name : `${dirRel}/${d.name}`;
      const link = d.isSymbolicLink();
      // A link is described by what it points at, if that is inside the workspace; else as a file nobody can open.
      let target = link ? await fs.realpath(full).catch(() => undefined) : full;
      if (link && target && !within(t.root, target)) target = undefined;
      const tst = target ? await fs.stat(target).catch(() => null) : null;
      const isDir = !!tst?.isDirectory();
      const e: TreeEntry = { name: d.name, path: r, type: isDir ? 'dir' : 'file', size: tst && !isDir ? tst.size : 0, mtime: tst?.mtimeMs ?? 0 };
      if (link) e.symlink = true;
      if (isDir && HEAVY_DIRS.has(d.name)) e.heavy = true;
      if (isDir && !link && !e.heavy && level < depth) { const sub = await list(full, r, level + 1); e.children = sub.entries; if (sub.truncated) e.truncated = true; }
      out.push(e);
    }
    out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return { entries: out, ...(truncated ? { truncated } : {}) };
  };
  return { path: t.rel, ...await list(t.real, t.rel, 1) };
}

export async function writeFile(s: Session, rel: unknown, data: Buffer): Promise<{ path: string; size: number }> {
  if (data.length > WRITE_LIMIT) throw new WorkspaceError(413, 'A file written from here is at most 10 MB.');
  const t = await writable(s, rel);
  const st = await fs.stat(t.real).catch(() => null);
  if (st?.isDirectory()) throw new WorkspaceError(409, 'a folder is there');
  await fs.mkdir(path.dirname(t.real), { recursive: true });
  // The parent may have been made a link meanwhile: checked again where it really is.
  if (!within(t.root, await fs.realpath(path.dirname(t.real)))) throw new WorkspaceError(400, 'that path resolves outside the workspace');
  await fs.writeFile(t.real, data);
  return { path: t.rel, size: data.length };
}

export async function renamePath(s: Session, from: unknown, to: unknown, overwrite = false): Promise<{ from: string; to: string }> {
  const a = await writable(s, from);
  const b = await writable(s, to);
  if (!await fs.lstat(a.real).catch(() => null)) throw new WorkspaceError(404, `${a.rel} does not exist`);
  if (!overwrite && await fs.lstat(b.real).catch(() => null)) throw new WorkspaceError(409, `${b.rel} exists (send overwrite: true to replace it)`);
  if (within(a.real, b.real) && a.real !== b.real) throw new WorkspaceError(400, 'a folder cannot be moved into itself');
  await fs.mkdir(path.dirname(b.real), { recursive: true });
  await fs.rename(a.real, b.real);
  return { from: a.rel, to: b.rel };
}

export async function deletePath(s: Session, rel: unknown): Promise<{ path: string }> {
  // A link itself goes (wherever it points), never what it points at; its folder must really be inside.
  if (typeof rel === 'string' && rel.trim() && !rel.includes('\0') && !isGitPath(rel)) {
    const root = await realRoot(s);
    const asked = path.resolve(root, rel);
    const lst = within(root, asked) && asked !== root ? await fs.lstat(asked).catch(() => null) : null;
    if (lst?.isSymbolicLink() && within(root, await fs.realpath(path.dirname(asked)).catch(() => ''))) {
      await fs.rm(asked, { force: true });
      return { path: posix(path.relative(root, asked)) };
    }
  }
  const t = await writable(s, rel);
  if (!await fs.lstat(t.real).catch(() => null)) throw new WorkspaceError(404, 'not found');
  await fs.rm(t.real, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  return { path: t.rel };
}

/** A file name a person uploads: its last part only, no leading dot, nothing a shell or a path reads specially. */
export function cleanName(name: unknown): string {
  const base = String(name ?? '').split(/[\\/]/).pop()!.replace(/[\0-\x1f<>:"|?*]/g, '_').replace(/^\.+/, '_').trim().slice(0, 120);
  return base || 'upload';
}

/** Saves attachments under .harness/uploads (a free name for each); returns their workspace paths. */
export async function saveUploads(s: Session, files: { name: string; data: Buffer }[]): Promise<string[]> {
  const out: string[] = [];
  for (const f of files) {
    const name = cleanName(f.name);
    const ext = path.extname(name);
    let rel = `.harness/uploads/${name}`;
    for (let i = 2; i < 1000 && await fs.lstat(path.join(s.workspace, rel)).catch(() => null); i++) rel = `.harness/uploads/${name.slice(0, name.length - ext.length)}-${i}${ext}`;
    out.push((await writeFile(s, rel, f.data)).path);
  }
  return out;
}

export interface SearchHit { path: string; type: 'file' | 'dir'; matches?: { line: number; text: string }[] }

/** Names (and with `content`, lines) matching `q`, case-insensitively; heavy folders, links and binary files skipped. */
export async function searchFiles(s: Session, q: string, o: { content?: boolean; limit?: number } = {}): Promise<{ query: string; results: SearchHit[]; truncated?: boolean }> {
  const needle = q.trim().toLowerCase();
  if (!needle) throw new WorkspaceError(400, 'q is required');
  if (needle.length > 200) throw new WorkspaceError(400, 'q is at most 200 characters');
  const limit = Math.min(1000, Math.max(1, o.limit ?? 100));
  const root = await realRoot(s);
  const redactor = o.content ? await s.loadSecrets() : undefined;
  const results: SearchHit[] = [];
  let seen = 0, found = 0, truncated = false;
  const deadline = Date.now() + 15_000;
  const walk = async (dir: string, rel: string): Promise<void> => {
    if (truncated) return;
    const names = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const d of names) {
      if (found >= limit || ++seen > 50_000 || Date.now() > deadline) { truncated = true; return; }
      if (d.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (!o.content && r.toLowerCase().includes(needle)) { results.push({ path: r, type: 'dir' }); found++; }
        if (!HEAVY_DIRS.has(d.name)) await walk(full, r);
        continue;
      }
      if (!d.isFile()) continue;
      if (!o.content) { if (r.toLowerCase().includes(needle)) { results.push({ path: r, type: 'file' }); found++; } continue; }
      const st = await fs.stat(full).catch(() => null);
      if (!st || st.size > 1_000_000) continue;
      const buf = await fs.readFile(full).catch(() => null);
      if (!buf || buf.subarray(0, 8000).includes(0)) continue;
      const matches: { line: number; text: string }[] = [];
      const lines = buf.toString('utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length && matches.length < 20 && found < limit; i++) {
        if (lines[i]!.toLowerCase().includes(needle)) { matches.push({ line: i + 1, text: redactor!.redact(lines[i]!.slice(0, 300)) }); found++; }
      }
      if (matches.length) results.push({ path: r, type: 'file', matches });
    }
  };
  await walk(root, '');
  return { query: q, results, ...(truncated ? { truncated } : {}) };
}

// ---- git, where the session's commands run ----

const quote = (shell: string, v: string) => (shell === 'powershell' ? `'${v.replace(/'/g, "''")}'` : `'${v.replace(/'/g, `'\\''`)}'`);
/** No fsmonitor command, no hooks, no external diff or textconv programs, no pager, no optional index writes. */
const GIT = 'git --no-pager --no-optional-locks -c core.fsmonitor=false -c core.quotepath=false -c color.ui=false';

async function git(s: Session, args: string, timeoutMs = 30_000): Promise<{ out: string; code: number | null; err: string }> {
  workspaceOf(s);
  let r: Awaited<ReturnType<Session['execInWorkspace']>>;
  try { r = await s.execInWorkspace(`${GIT} ${args}`, timeoutMs); } catch (e) { throw new WorkspaceError(502, `git could not run in this session's workspace: ${(e as Error).message}`); }
  return { out: r.stdout, code: r.code, err: r.stderr };
}

const notRepo = (err: string) => /not a git repository/i.test(err);

/** "path" or a C-quoted "\"pa th\"" from git's porcelain output. */
function unquote(p: string): string {
  if (!p.startsWith('"')) return p;
  try { return JSON.parse(p.replace(/\\([0-7]{3})/g, (_m, o: string) => `\\u00${parseInt(o, 8).toString(16).padStart(2, '0')}`)) as string; } catch { return p.slice(1, -1); }
}

export async function gitStatus(s: Session): Promise<{ repo: boolean; branch?: string; upstream?: string; ahead?: number; behind?: number; files: { path: string; from?: string; index: string; worktree: string }[]; clean?: boolean }> {
  const r = await git(s, 'status --porcelain=v1 -b --untracked-files=all');
  if (r.code !== 0) {
    if (notRepo(r.err)) return { repo: false, files: [] };
    throw new WorkspaceError(502, `git status failed: ${r.err.trim().slice(0, 300)}`);
  }
  const lines = r.out.split(/\r?\n/).filter(Boolean);
  const out: { repo: boolean; branch?: string; upstream?: string; ahead?: number; behind?: number; files: { path: string; from?: string; index: string; worktree: string }[]; clean?: boolean } = { repo: true, files: [] };
  for (const l of lines) {
    if (l.startsWith('## ')) {
      const h = l.slice(3);
      const m = /^(?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/.exec(h);
      if (m) {
        out.branch = m[1];
        if (m[2]) out.upstream = m[2];
        const ab = m[3] ?? '';
        const a = /ahead (\d+)/.exec(ab); const b = /behind (\d+)/.exec(ab);
        if (a) out.ahead = Number(a[1]);
        if (b) out.behind = Number(b[1]);
      }
      continue;
    }
    const x = l[0]!, y = l[1]!;
    const rest = l.slice(3);
    const arrow = rest.indexOf(' -> ');
    const file = arrow >= 0 ? { from: unquote(rest.slice(0, arrow)), path: unquote(rest.slice(arrow + 4)) } : { path: unquote(rest) };
    out.files.push({ ...file, index: x, worktree: y });
  }
  out.clean = !out.files.length;
  return out;
}

export async function gitDiff(s: Session, rel: string | null, staged: boolean): Promise<{ repo: boolean; path?: string; staged: boolean; diff: string; truncated?: boolean }> {
  let arg = '';
  let shown: string | undefined;
  if (rel) {
    const t = await inside(s, rel);
    shown = t.rel;
    arg = ` -- ${quote(await s.workspaceShell(), t.rel)}`;
  }
  const r = await git(s, `diff --no-ext-diff --no-textconv --no-color${staged ? ' --cached' : ''}${arg}`);
  if (r.code !== 0) {
    if (notRepo(r.err)) return { repo: false, staged, diff: '' };
    throw new WorkspaceError(502, `git diff failed: ${r.err.trim().slice(0, 300)}`);
  }
  const cap = 2_000_000;
  const text = (await s.loadSecrets()).redact(r.out.length > cap ? r.out.slice(0, cap) : r.out);
  return { repo: true, ...(shown ? { path: shown } : {}), staged, diff: text, ...(r.out.length > cap ? { truncated: true } : {}) };
}

export async function gitLog(s: Session, limit = 50): Promise<{ repo: boolean; commits: { hash: string; author: string; email: string; at: number; subject: string }[] }> {
  const n = Math.min(500, Math.max(1, Math.floor(limit) || 50));
  const r = await git(s, `log -n ${n} --no-color --format=%H%x1f%an%x1f%ae%x1f%at%x1f%s%x1e`);
  if (r.code !== 0) {
    if (notRepo(r.err)) return { repo: false, commits: [] };
    // A repository without commits yet.
    if (/does not have any commits|bad default revision|unknown revision/i.test(r.err)) return { repo: true, commits: [] };
    throw new WorkspaceError(502, `git log failed: ${r.err.trim().slice(0, 300)}`);
  }
  const commits = r.out.split('\x1e').map((x) => x.trim()).filter(Boolean).map((rec) => {
    const [hash, author, email, at, subject] = rec.split('\x1f');
    return { hash: hash ?? '', author: author ?? '', email: email ?? '', at: Number(at) * 1000 || 0, subject: subject ?? '' };
  });
  return { repo: true, commits };
}
