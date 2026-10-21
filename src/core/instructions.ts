import fs from 'node:fs/promises';
import path from 'node:path';
import type { ToolHost } from '../runtime/host.ts';
import { resolveIn } from '../tools/paths.ts';

// Instruction files, in the tiers Claude Code reads them:
//   managed  the operator's file (HARNESS_INSTRUCTIONS) for every session;
//   user     the person's own (per account, /api/me/instructions);
//   project  AGENTS.md / CLAUDE.md / HARNESS.md at the workspace root;
//   local    AGENTS.local.md / CLAUDE.local.md / HARNESS.local.md: personal and
//            gitignored, so read like the project's (same trust: workspace content);
//   nested   the same files in a subdirectory, loaded the first time the agent
//            reads or edits a file under it (appended as a reminder, never inserted).
// All of it goes in the first user message, never the system prompt: the system
// prompt stays byte-identical for every session, so one cache entry serves them all.
// A workspace file can pull in others with "@path" (relative to it, inside the
// workspace only, at most 4 levels deep); the managed and user files cannot.

export type InstructionScope = 'managed' | 'user' | 'project' | 'local' | 'nested';
export interface InstructionFile { source: string; scope: InstructionScope; importedBy?: string }

export const PROJECT_FILES = ['AGENTS.md', 'CLAUDE.md', 'HARNESS.md'];
export const LOCAL_FILES = ['AGENTS.local.md', 'CLAUDE.local.md', 'HARNESS.local.md'];
/** All tiers in the opening context together; the managed file comes first so it is never the one cut. */
const TOTAL_MAX = 32_000;
/** One directory's files, loaded on demand. */
const NESTED_MAX = 12_000;
/** A larger file is not instructions. */
const FILE_MAX = 1_000_000;
const IMPORT_DEPTH = 4;
/** Directories whose files are never anyone's instructions to the agent. */
const SKIP = new Set(['node_modules', '.git', '.hg', '.svn', '.venv', '__pycache__']);

/** A workspace-relative POSIX path, or undefined when it is absolute or leaves the workspace. */
export function safeRel(rel: string): string | undefined {
  if (!rel) return undefined;
  const p = path.posix.normalize(rel.replace(/\\/g, '/'));
  if (!p || p === '.' || p.startsWith('/') || /^[a-zA-Z]:/.test(p) || p === '..' || p.startsWith('../')) return undefined;
  return p.replace(/\/+$/, '');
}

const stripNumbers = (text: string) => text.split('\n').filter((l) => !l.startsWith('[lines ')).map((l) => l.replace(/^ *\d+\t/, '')).join('\n');

/** Reads a workspace file by its relative path, inside the workspace only (symlinks included); null when absent. */
export function workspaceReader(host: ToolHost): (rel: string) => Promise<string | null> {
  return async (rel) => {
    const clean = safeRel(rel);
    if (!clean) return null;
    if (host.remoteTool) {
      // On a companion the file lives on the user's machine: read it there and drop the line numbers.
      const r = await host.remoteTool('read', { path: clean }, AbortSignal.timeout(15_000)).catch(() => undefined);
      if (!r || r.is_error || /^\S+ (does not exist|is empty|is a binary)/.test(r.content) || /^Directory /.test(r.content)) return null;
      return stripNumbers(r.content);
    }
    const real = await resolveIn(host, clean).catch(() => null);
    if (!real) return null;
    const st = await fs.stat(real).catch(() => null);
    if (!st?.isFile() || st.size > FILE_MAX) return null;
    return fs.readFile(real, 'utf8').catch(() => null);
  };
}

/** The names in a workspace directory (one call, so a companion is not asked for every candidate file). */
async function listDir(host: ToolHost, rel: string): Promise<Set<string>> {
  if (host.remoteTool) {
    const r = await host.remoteTool('read', { path: rel }, AbortSignal.timeout(15_000)).catch(() => undefined);
    if (!r || r.is_error || !/^Directory /.test(r.content)) return new Set();
    return new Set(r.content.split('\n').slice(1).map((l) => l.trim()));
  }
  const real = await resolveIn(host, rel).catch(() => null);
  return new Set(real ? await fs.readdir(real).catch(() => []) : []);
}

/** The name a candidate file has in a listing: exact, else any case (a case-insensitive disk finds "agents.md" too). */
function named(names: Set<string>, f: string): string | undefined {
  if (names.has(f)) return f;
  const lower = f.toLowerCase();
  return [...names].find((n) => n.toLowerCase() === lower);
}

/** "@path" references in an instruction file, outside code blocks and code spans. */
export function importsIn(text: string): string[] {
  const prose = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  const out: string[] = [];
  for (const m of prose.matchAll(/(?:^|[\s(])@((?:\.{1,2}\/)*[\w-][\w./-]*)/g)) {
    const p = m[1]!.replace(/[.,;:]+$/, '');
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

class Collector {
  parts: string[] = [];
  files: InstructionFile[] = [];
  seen = new Set<string>();
  private size = 0;
  private max: number;
  constructor(max: number) { this.max = max; }
  add(tag: string, attrs: string, text: string, file: InstructionFile): boolean {
    const room = this.max - this.size;
    if (room <= 0) return false;
    const t = text.length > room ? `${text.slice(0, room)}\n[truncated]` : text;
    this.parts.push(`<${tag}${attrs}>\n${t}\n</${tag}>`);
    this.size += t.length;
    this.files.push(file);
    return true;
  }
}

/** A workspace file and, depth-first, the files it imports. */
async function addWorkspaceFile(c: Collector, read: (rel: string) => Promise<string | null>, rel: string, scope: InstructionScope, tag: string, depth = 0, importedBy?: string): Promise<void> {
  if (c.seen.has(rel)) return;
  c.seen.add(rel);
  const text = (await read(rel))?.trim();
  if (!text) return;
  if (!c.add(tag, ` source="${rel}"${importedBy ? ` imported_by="${importedBy}"` : ''}`, text, { source: rel, scope, ...(importedBy ? { importedBy } : {}) })) return;
  if (depth >= IMPORT_DEPTH) return;
  for (const imp of importsIn(text)) {
    const target = safeRel(path.posix.join(path.posix.dirname(rel), imp));
    if (target && !target.split('/').some((s) => SKIP.has(s))) await addWorkspaceFile(c, read, target, scope, tag, depth + 1, rel);
  }
}

/**
 * The opening context's instructions: managed, user, project, local, in that
 * order. A managed file that is named but cannot be read is an error (running
 * without the operator's instructions would be worse than not running).
 */
export async function loadInstructions(host: ToolHost, opts: { managedFile?: string; user?: string } = {}): Promise<{ text: string; files: InstructionFile[] }> {
  const c = new Collector(TOTAL_MAX);
  if (opts.managedFile) {
    const text = (await fs.readFile(opts.managedFile, 'utf8').catch((e: Error) => { throw new Error(`HARNESS_INSTRUCTIONS (${opts.managedFile}) cannot be read: ${e.message}`); })).trim();
    if (text) c.add('managed_instructions', ' source="operator"', text, { source: 'operator', scope: 'managed' });
  }
  if (opts.user?.trim()) c.add('user_instructions', '', opts.user.trim(), { source: 'user', scope: 'user' });
  const read = workspaceReader(host);
  const root = await listDir(host, '.');
  for (const f of PROJECT_FILES) { const n = named(root, f); if (n) await addWorkspaceFile(c, read, n, 'project', 'project_instructions'); }
  for (const f of LOCAL_FILES) { const n = named(root, f); if (n) await addWorkspaceFile(c, read, n, 'local', 'local_instructions'); }
  return { text: c.parts.join('\n'), files: c.files };
}

/**
 * The directories between the workspace root and a path the agent touched, outermost
 * first (the root itself is left out: its files are in the opening context).
 */
export function dirsToward(host: Pick<ToolHost, 'root' | 'displayRoot'>, p: string): string[] {
  const posix = p.replace(/\\/g, '/');
  let rel = posix;
  for (const r of [host.displayRoot, host.root]) {
    const base = r.replace(/\\/g, '/').replace(/\/+$/, '');
    if (posix.toLowerCase() === base.toLowerCase()) return [];
    if (posix.toLowerCase().startsWith(`${base.toLowerCase()}/`)) { rel = posix.slice(base.length + 1); break; }
  }
  const clean = safeRel(rel);
  if (!clean) return [];
  const parts = clean.split('/').slice(0, -1);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (SKIP.has(parts[i]!)) break;
    out.push(parts.slice(0, i + 1).join('/'));
  }
  return out;
}

/** One subdirectory's instruction files (and their imports), for the reminder when the agent first works there. */
export async function nestedInstructions(host: ToolHost, dir: string): Promise<{ text: string; files: InstructionFile[] }> {
  const names = await listDir(host, dir);
  const c = new Collector(NESTED_MAX);
  const read = workspaceReader(host);
  for (const f of [...PROJECT_FILES, ...LOCAL_FILES]) { const n = named(names, f); if (n) await addWorkspaceFile(c, read, `${dir}/${n}`, 'nested', 'project_instructions'); }
  return { text: c.parts.join('\n'), files: c.files };
}
