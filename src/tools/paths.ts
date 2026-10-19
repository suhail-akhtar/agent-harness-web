import fs from 'node:fs/promises';
import path from 'node:path';
import type { ToolHost } from '../runtime/host.ts';

// Model-supplied paths are untrusted. A sandboxed command can plant a symlink
// in the workspace that points at the host (/etc, the server's keys), and the
// file tools run on the host - so containment is checked on the REAL path of
// the target (or of its deepest existing ancestor when creating a file), not
// on the string.

export class PathError extends Error {}

async function realOrNearest(p: string): Promise<string> {
  let cur = p;
  const tail: string[] = [];
  while (true) {
    try {
      const real = await fs.realpath(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

export function within(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

/** Maps a model path (relative, or absolute under the display root) to a safe real path. */
export async function resolveIn(host: Pick<ToolHost, 'root' | 'displayRoot'>, p: string): Promise<string> {
  if (typeof p !== 'string' || !p.trim()) throw new PathError('path is required');
  let candidate: string;
  const posix = p.replace(/\\/g, '/');
  const disp = host.displayRoot.replace(/\\/g, '/').replace(/\/$/, '');
  if (posix === disp || posix.startsWith(disp + '/')) candidate = path.join(host.root, posix.slice(disp.length));
  else if (path.isAbsolute(p)) candidate = p;
  else candidate = path.join(host.root, p);
  candidate = path.resolve(candidate);
  const realRoot = await fs.realpath(host.root);
  if (!within(path.resolve(host.root), candidate) && !within(realRoot, candidate)) {
    throw new PathError(`${p} is outside the workspace (${host.displayRoot})`);
  }
  const real = await realOrNearest(candidate);
  if (!within(realRoot, real)) throw new PathError(`${p} resolves outside the workspace (symlink)`);
  return real;
}

/** The path as the model should see it. */
export function display(host: Pick<ToolHost, 'root' | 'displayRoot'>, real: string, realRoot?: string): string {
  const rel = path.relative(realRoot ?? host.root, real).split(path.sep).join('/');
  if (host.displayRoot === host.root) return rel || '.';
  return rel ? `${host.displayRoot}/${rel}` : host.displayRoot;
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn', '__pycache__', '.venv', 'dist', 'build', '.next', 'target', '.cache']);

export interface WalkEntry { path: string; rel: string; mtimeMs: number; size: number }

/** Walks files without following symlinks. Skips heavy directories unless asked for. */
export async function walk(dir: string, opts: { includeHeavy?: boolean; limit?: number; signal?: AbortSignal } = {}): Promise<WalkEntry[]> {
  const out: WalkEntry[] = [];
  const limit = opts.limit ?? 50_000;
  async function visit(d: string, rel: string): Promise<void> {
    if (out.length >= limit || opts.signal?.aborted) return;
    let entries: import('node:fs').Dirent[];
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= limit) return;
      const full = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!opts.includeHeavy && SKIP_DIRS.has(e.name)) continue;
        await visit(full, r);
      } else if (e.isFile()) {
        try {
          const st = await fs.stat(full);
          out.push({ path: full, rel: r, mtimeMs: st.mtimeMs, size: st.size });
        } catch { /* vanished */ }
      }
    }
  }
  await visit(dir, '');
  return out;
}

/** Glob to RegExp: supports **, *, ?, {a,b} and [..]. Matches against a /-separated relative path. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  let inBrace = 0;
  while (i < g.length) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        const slash = g[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 3 : 2;
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') { inBrace++; re += '(?:'; }
    else if (c === '}' && inBrace) { inBrace--; re += ')'; }
    else if (c === ',' && inBrace) re += '|';
    else if (c === '[') {
      const end = g.indexOf(']', i);
      if (end > i) { re += g.slice(i, end + 1).replace(/^\[!/, '[^'); i = end + 1; continue; }
      re += '\\[';
    } else re += /[.+^$()|\\]/.test(c) ? `\\${c}` : c;
    i++;
  }
  return new RegExp(`^${re}$`);
}

/** A pattern without a slash matches the basename anywhere, like most globbers' matchBase. */
export function globMatcher(glob: string): (rel: string) => boolean {
  const re = globToRegExp(glob);
  if (!glob.includes('/')) {
    return (rel) => re.test(rel) || re.test(rel.slice(rel.lastIndexOf('/') + 1));
  }
  return (rel) => re.test(rel);
}
