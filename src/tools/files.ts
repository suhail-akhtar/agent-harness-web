import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from '../runtime/host.ts';
import { display, globMatcher, PathError, resolveIn, walk } from './paths.ts';
import type { Tool, ToolContext, ToolOutcome } from './types.ts';
import { bool, clip, num, str } from './types.ts';

// File tools. Their descriptions are part of every prompt, so they say what
// the model needs to use them well and nothing more. Their errors are written
// for the model to repair from: what went wrong and the next step.

const MAX_READ_LINES = 2000;
const MAX_LINE = 2000;
const MAX_READ_CHARS = 100_000;

const fail = (content: string): ToolOutcome => ({ content, is_error: true });

async function realRoot(ctx: ToolContext) { return fs.realpath(ctx.host.root); }

function numbered(lines: string[], start: number): string {
  return lines.map((l, i) => `${String(start + i).padStart(6)}\t${l.length > MAX_LINE ? l.slice(0, MAX_LINE) + ' [line truncated]' : l}`).join('\n');
}

export const readTool: Tool = {
  kind: 'read', parallelSafe: true, remoteable: true,
  spec: {
    name: 'read',
    description: 'Read a text file. Returns numbered lines (`  N\\tline`). Reads up to 2000 lines; use offset/limit for more. Read a file before editing it. A directory returns its entries.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the workspace or absolute inside it.' },
        offset: { type: 'number', description: '1-based line to start from.' },
        limit: { type: 'number', description: 'Number of lines to read.' },
      },
      required: ['path'],
    },
  },
  summarize: (i) => `read ${str(i.path)}${i.offset ? ` from line ${i.offset}` : ''}`,
  async run(input, ctx) {
    const p = await resolveIn(ctx.host, str(input.path));
    let st;
    try { st = await fs.stat(p); } catch { return fail(`${str(input.path)} does not exist.${await nearby(ctx, p)}`); }
    if (st.isDirectory()) {
      const entries = await fs.readdir(p, { withFileTypes: true });
      const names = entries.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 500).map((e) => e.isDirectory() ? `${e.name}/` : e.name);
      return { content: `Directory ${str(input.path)} (${entries.length} entries):\n${names.join('\n')}` };
    }
    const buf = await fs.readFile(p);
    if (buf.subarray(0, 8000).includes(0)) return { content: `${str(input.path)} is a binary file (${buf.length} bytes).` };
    const all = buf.toString('utf8').split(/\r?\n/);
    if (all.length > 1 && all[all.length - 1] === '') all.pop();
    const offset = Math.max(1, Math.floor(num(input.offset) ?? 1));
    const limit = Math.max(1, Math.floor(num(input.limit) ?? MAX_READ_LINES));
    let slice = all.slice(offset - 1, offset - 1 + limit);
    let body = numbered(slice, offset);
    let note = '';
    if (body.length > MAX_READ_CHARS) {
      // Cut on a line boundary so the numbering stays trustworthy.
      let size = 0; let n = 0;
      for (; n < slice.length; n++) { size += slice[n]!.length + 8; if (size > MAX_READ_CHARS) break; }
      slice = slice.slice(0, Math.max(1, n));
      body = numbered(slice, offset);
    }
    const end = offset + slice.length - 1;
    if (end < all.length) note = `\n[lines ${offset}-${end} of ${all.length}; read more with offset=${end + 1}]`;
    ctx.readFiles.set(p, { mtimeMs: st.mtimeMs, size: st.size });
    if (all.length === 0 || (all.length === 1 && all[0] === '')) return { content: `${str(input.path)} is empty.`, display: { type: 'file', path: str(input.path), lines: 0 } };
    return { content: body + note, display: { type: 'file', path: str(input.path), lines: slice.length } };
  },
};

async function nearby(ctx: ToolContext, p: string): Promise<string> {
  try {
    const dir = path.dirname(p);
    const base = path.basename(p).toLowerCase();
    const names = await fs.readdir(dir);
    const close = names.filter((n) => n.toLowerCase().includes(base.slice(0, 4)) || base.includes(n.toLowerCase().replace(/\.[^.]+$/, ''))).slice(0, 5);
    const rr = await realRoot(ctx);
    if (close.length) return ` Similar names in ${display(ctx.host, dir, rr)}: ${close.join(', ')}`;
  } catch { /* parent missing too */ }
  return '';
}

async function stale(ctx: ToolContext, p: string): Promise<string | undefined> {
  let st;
  try { st = await fs.stat(p); } catch { return undefined; }
  const seen = ctx.readFiles.get(p);
  if (!seen) return 'You must read this file before changing it (read it first, then retry).';
  if (st.mtimeMs !== seen.mtimeMs || st.size !== seen.size) return 'The file changed since you last read it. Read it again, then retry.';
  return undefined;
}

async function remember(ctx: ToolContext, p: string) {
  const st = await fs.stat(p);
  ctx.readFiles.set(p, { mtimeMs: st.mtimeMs, size: st.size });
}

export const writeTool: Tool = {
  kind: 'edit', parallelSafe: false, remoteable: true,
  spec: {
    name: 'write',
    description: 'Create a file or overwrite one completely. Prefer `edit` for changes to an existing file. An existing file must have been read first.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string', description: 'The complete file content.' } },
      required: ['path', 'content'],
    },
  },
  summarize: (i) => `write ${str(i.path)} (${str(i.content).split('\n').length} lines)`,
  async run(input, ctx) {
    const p = await resolveIn(ctx.host, str(input.path));
    if (typeof input.content !== 'string') return fail('content must be a string.');
    const problem = await stale(ctx, p);
    if (problem) return fail(problem);
    let before = '';
    try { before = await fs.readFile(p, 'utf8'); } catch { /* new file */ }
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, input.content);
    await remember(ctx, p);
    const lines = input.content.split('\n').length;
    return { content: `${before ? 'Overwrote' : 'Created'} ${str(input.path)} (${lines} lines).`, display: { type: 'diff', path: str(input.path), before: before.slice(0, 200_000), after: input.content.slice(0, 200_000) } };
  },
};

export const editTool: Tool = {
  kind: 'edit', parallelSafe: false, remoteable: true,
  spec: {
    name: 'edit',
    description: 'Replace an exact string in a file. old_string must match the file exactly (whitespace included) and be unique, or set replace_all. Include enough surrounding lines to make it unique. Read the file first; do not include the line-number prefix from `read`.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  summarize: (i) => `edit ${str(i.path)}`,
  async run(input, ctx) {
    const p = await resolveIn(ctx.host, str(input.path));
    const oldS = str(input.old_string);
    const newS = str(input.new_string);
    let before: string;
    try { before = await fs.readFile(p, 'utf8'); } catch { return fail(`${str(input.path)} does not exist. Use write to create it.`); }
    const problem = await stale(ctx, p);
    if (problem) return fail(problem);
    if (oldS === newS) return fail('old_string and new_string are identical; nothing to change.');
    if (oldS === '') return fail('old_string is empty. To add content, include a nearby line in old_string, or use write for a new file.');
    const count = before.split(oldS).length - 1;
    if (count === 0) return fail(`old_string was not found in ${str(input.path)}.${nearMatch(before, oldS)} Re-read the file and copy the text exactly.`);
    if (count > 1 && !bool(input.replace_all)) return fail(`old_string occurs ${count} times. Add surrounding lines to make it unique, or set replace_all: true.`);
    const after = bool(input.replace_all) ? before.split(oldS).join(newS) : before.replace(oldS, () => newS);
    await fs.writeFile(p, after);
    await remember(ctx, p);
    // Echo the changed region with line numbers so the model can verify
    // without spending a read.
    const idx = after.indexOf(newS);
    const line = after.slice(0, Math.max(0, idx)).split('\n').length;
    const lines = after.split('\n');
    const from = Math.max(1, line - 2);
    const to = Math.min(lines.length, line + newS.split('\n').length + 1);
    const snippet = numbered(lines.slice(from - 1, to), from);
    return {
      content: `Edited ${str(input.path)}${count > 1 ? ` (${count} replacements)` : ''}. Now:\n${clip(snippet, 4000)}`,
      display: { type: 'diff', path: str(input.path), before: before.slice(0, 200_000), after: after.slice(0, 200_000) },
    };
  },
};

/** When an edit misses, point at the line that nearly matched (whitespace differences). */
function nearMatch(content: string, needle: string): string {
  const norm = (s: string) => s.replace(/[ \t]+/g, ' ').replace(/\r/g, '').trim();
  const first = norm(needle.split('\n').find((l) => l.trim()) ?? '');
  if (!first) return '';
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (norm(lines[i]!) === first) return ` A line matching its first line apart from whitespace is at line ${i + 1}.`;
  }
  return '';
}

export const globTool: Tool = {
  kind: 'read', parallelSafe: true, remoteable: true,
  spec: {
    name: 'glob',
    description: 'Find files by glob pattern (e.g. "**/*.ts", "src/**/test_*.py"). Newest first, up to 200. Skips .git, node_modules and build output unless the pattern names them.',
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Directory to search; defaults to the workspace.' } },
      required: ['pattern'],
    },
  },
  summarize: (i) => `glob ${str(i.pattern)}${i.path ? ` in ${str(i.path)}` : ''}`,
  async run(input, ctx) {
    const base = await resolveIn(ctx.host, str(input.path) || '.');
    const pattern = str(input.pattern);
    const match = globMatcher(pattern);
    const heavy = /node_modules|\.git\/|dist\/|build\//.test(pattern);
    const files = await walk(base, { includeHeavy: heavy, signal: ctx.signal });
    const hits = files.filter((f) => match(f.rel)).sort((a, b) => b.mtimeMs - a.mtimeMs);
    const rr = await realRoot(ctx);
    if (!hits.length) return { content: `No files match ${pattern}.` };
    const shown = hits.slice(0, 200).map((f) => display(ctx.host, f.path, rr));
    return { content: shown.join('\n') + (hits.length > 200 ? `\n[${hits.length - 200} more; narrow the pattern]` : '') };
  },
};

let rgPath: string | null | undefined;
async function ripgrep(): Promise<string | null> {
  if (rgPath !== undefined) return rgPath;
  const r = await run('rg', ['--version'], { timeoutMs: 5000 });
  rgPath = r.code === 0 ? 'rg' : null;
  return rgPath;
}

export const grepTool: Tool = {
  kind: 'read', parallelSafe: true, remoteable: true,
  spec: {
    name: 'grep',
    description: 'Search file contents with a regular expression (ripgrep syntax). output_mode: "files" (default, paths only), "content" (matching lines with numbers), "count". Filter with glob (e.g. "*.py"). Prefer this to running grep in bash.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'File or directory; defaults to the workspace.' },
        glob: { type: 'string' },
        output_mode: { type: 'string', enum: ['files', 'content', 'count'] },
        context: { type: 'number', description: 'Lines of context around each match (content mode).' },
        case_insensitive: { type: 'boolean' },
        max_results: { type: 'number', description: 'Default 100.' },
      },
      required: ['pattern'],
    },
  },
  summarize: (i) => `grep "${str(i.pattern)}"${i.glob ? ` in ${str(i.glob)}` : ''}`,
  async run(input, ctx) {
    const target = await resolveIn(ctx.host, str(input.path) || '.');
    const mode = (['files', 'content', 'count'] as const).find((m) => m === input.output_mode) ?? 'files';
    const max = Math.min(1000, Math.max(1, Math.floor(num(input.max_results) ?? 100)));
    const rr = await realRoot(ctx);
    const rg = await ripgrep();
    let lines: string[];
    if (rg) {
      const args = ['--no-config', '--color', 'never', '--no-messages', '--max-columns', '400', '--max-columns-preview'];
      if (bool(input.case_insensitive)) args.push('-i');
      if (str(input.glob)) args.push('--glob', str(input.glob));
      if (mode === 'files') args.push('-l');
      else if (mode === 'count') args.push('-c');
      else {
        args.push('-n');
        const c = num(input.context);
        if (c) args.push('-C', String(Math.min(10, Math.max(0, Math.floor(c)))));
      }
      args.push('-e', str(input.pattern), '--', target);
      const r = await run(rg, args, { timeoutMs: 60_000, signal: ctx.signal });
      if (r.code === 2 && !r.stdout) return fail(`grep failed: ${r.stderr.trim().slice(0, 500)}`);
      lines = r.stdout.split('\n').filter(Boolean);
    } else {
      lines = await jsGrep(target, str(input.pattern), mode, bool(input.case_insensitive), str(input.glob), ctx.signal);
    }
    // Show paths the way the model addresses them.
    const prefix = rr.endsWith(path.sep) ? rr : rr + path.sep;
    const shownPrefix = ctx.host.displayRoot === ctx.host.root ? '' : `${ctx.host.displayRoot}/`;
    lines = lines.map((l) => (l.startsWith(prefix) ? shownPrefix + l.slice(prefix.length).split(path.sep).join('/') : l));
    if (!lines.length) return { content: 'No matches.' };
    const shown = lines.slice(0, max).join('\n');
    return { content: clip(shown, 40_000, 'narrow the search') + (lines.length > max ? `\n[${lines.length - max} more results; narrow the pattern or raise max_results]` : '') };
  },
};

async function jsGrep(target: string, pattern: string, mode: 'files' | 'content' | 'count', ci: boolean, glob: string, signal: AbortSignal): Promise<string[]> {
  let re: RegExp;
  try { re = new RegExp(pattern, ci ? 'i' : ''); } catch (e) { return [`invalid regex: ${(e as Error).message}`]; }
  const st = await fs.stat(target);
  const files = st.isFile() ? [{ path: target, rel: path.basename(target) }] : await walk(target, { signal });
  const match = glob ? globMatcher(glob) : () => true;
  const out: string[] = [];
  for (const f of files) {
    if (!match(f.rel) || out.length > 5000) continue;
    let text: string;
    try { const b = await fs.readFile(f.path); if (b.subarray(0, 4000).includes(0)) continue; text = b.toString('utf8'); } catch { continue; }
    const ls = text.split('\n');
    let n = 0;
    ls.forEach((l, i) => { if (re.test(l)) { n++; if (mode === 'content') out.push(`${f.path}:${i + 1}:${l.slice(0, 400)}`); } });
    if (n && mode === 'files') out.push(f.path);
    if (n && mode === 'count') out.push(`${f.path}:${n}`);
  }
  return out;
}

export { PathError };
