import fs from 'node:fs/promises';
import path from 'node:path';

// Who imports whom in a workspace, for the desktop's code map (a `code` view diagram): the
// TypeScript, JavaScript and Python files under a folder, each with the workspace files its
// imports resolve to, and the outside packages it uses, counted. Read-only and cheap: regular
// expressions over the text (no parser, no type checker), heavy folders and links skipped, bounded
// in files, bytes and time. Good enough to draw dependencies between folders; not a compiler.

export interface ImportedFile { path: string; lang: 'ts' | 'js' | 'py'; lines: number; imports: string[] }
export interface ImportScan { root: string; files: ImportedFile[]; external: Array<[string, number]>; truncated: boolean; ms: number }

const LANG: Record<string, ImportedFile['lang']> = { '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts', '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js', '.py': 'py' };
const SKIP = new Set(['.git', 'node_modules', '.hg', '.svn', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next', 'target', '.cache', '.gradle', '.terraform', 'coverage', '.harness', 'out', 'release', 'vendor', 'site-packages']);
const NODE_BUILTINS = new Set(['assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram', 'dns', 'events', 'fs', 'http', 'http2', 'https', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'querystring', 'readline', 'stream', 'string_decoder', 'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib', 'test']);
const JS_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

const JS_PATTERNS = [
  /\bimport\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"\n]{1,300})['"]/g,
  /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]{0,2000}\})\s+from\s+['"]([^'"\n]{1,300})['"]/g,
  /\brequire\(\s*['"]([^'"\n]{1,300})['"]\s*\)/g,
  /\bimport\(\s*['"]([^'"\n]{1,300})['"]\s*\)/g,
];
const PY_FROM = /^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+\(?([^\n#)]+)/gm;
const PY_IMPORT = /^[ \t]*import[ \t]+([\w.]+(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[\w.]+(?:[ \t]+as[ \t]+\w+)?)*)/gm;

/** The import specifiers a file names (comments mostly ignored). */
export function importSpecifiers(text: string, lang: ImportedFile['lang']): Array<{ spec: string; names?: string[] }> {
  const out: Array<{ spec: string; names?: string[] }> = [];
  if (lang === 'py') {
    const code = text.replace(/^[ \t]*#.*$/gm, '');
    for (const m of code.matchAll(PY_FROM)) out.push({ spec: m[1]!, names: m[2]!.split(',').map((s) => s.trim().split(/\s+/)[0]!).filter((s) => /^\w+$/.test(s)) });
    for (const m of code.matchAll(PY_IMPORT)) for (const part of m[1]!.split(',')) out.push({ spec: part.trim().split(/\s+/)[0]! });
    return out;
  }
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  for (const re of JS_PATTERNS) for (const m of code.matchAll(re)) out.push({ spec: m[1]! });
  return out;
}

const posix = (p: string) => p.split(path.sep).join('/');

/** Scans `start` (a folder inside `root`, both real paths) for imports; every path in the result is relative to `root`. */
export async function scanImports(root: string, start = root, o: { maxFiles?: number; maxBytes?: number; timeoutMs?: number } = {}): Promise<ImportScan> {
  const began = Date.now();
  const maxFiles = o.maxFiles ?? 4000;
  const maxBytes = o.maxBytes ?? 48 * 1024 * 1024;
  const deadline = began + (o.timeoutMs ?? 20_000);
  const found: Array<{ rel: string; full: string; lang: ImportedFile['lang'] }> = [];
  let truncated = false;
  const walk = async (dir: string): Promise<void> => {
    if (truncated) return;
    const names = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    names.sort((a, b) => a.name.localeCompare(b.name));
    for (const d of names) {
      if (found.length >= maxFiles || Date.now() > deadline) { truncated = true; return; }
      if (d.isSymbolicLink()) continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) { if (!SKIP.has(d.name) && !d.name.startsWith('.')) await walk(full); continue; }
      const lang = LANG[path.extname(d.name).toLowerCase()];
      if (!d.isFile() || !lang || d.name.endsWith('.d.ts')) continue;
      found.push({ rel: posix(path.relative(root, full)), full, lang });
    }
  };
  await walk(start);
  const known = new Set(found.map((f) => f.rel));
  const external = new Map<string, number>();
  const files: ImportedFile[] = [];
  let bytes = 0;
  for (const f of found) {
    if (Date.now() > deadline || bytes > maxBytes) { truncated = true; break; }
    const st = await fs.stat(f.full).catch(() => null);
    if (!st || st.size > 600_000) continue;
    const text = await fs.readFile(f.full, 'utf8').catch(() => '');
    bytes += text.length;
    const imports = new Set<string>();
    for (const { spec, names } of importSpecifiers(text, f.lang)) {
      const hit = f.lang === 'py' ? resolvePy(f.rel, spec, names, known) : resolveJs(f.rel, spec, known);
      if (hit.length) { for (const h of hit) if (h !== f.rel) imports.add(h); continue; }
      const pkg = f.lang === 'py' ? (spec.startsWith('.') ? '' : spec.split('.')[0]!) : externalName(spec);
      if (pkg) external.set(pkg, (external.get(pkg) ?? 0) + 1);
    }
    files.push({ path: f.rel, lang: f.lang, lines: text ? text.split('\n').length : 0, imports: [...imports].sort() });
  }
  return { root: posix(path.relative(root, start)) || '.', files, external: [...external.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 200), truncated, ms: Date.now() - began };
}

function externalName(spec: string): string {
  if (spec.startsWith('.') || spec.startsWith('/') || /^[a-z]+:/i.test(spec) && !spec.startsWith('node:')) return '';
  if (spec.startsWith('node:')) return '';
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
  return NODE_BUILTINS.has(name) ? '' : name;
}

function resolveJs(from: string, spec: string, known: Set<string>): string[] {
  if (!spec.startsWith('.')) return [];
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  if (base.startsWith('..')) return [];
  const tries = [base];
  const ext = path.posix.extname(base);
  if (ext) {
    const stem = base.slice(0, -ext.length);
    // TypeScript's ESM convention: "./x.js" names x.ts.
    if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') tries.push(...JS_EXT.map((e) => stem + e));
  } else {
    tries.push(...JS_EXT.map((e) => base + e), ...JS_EXT.map((e) => `${base}/index${e}`));
  }
  const hit = tries.find((t) => known.has(t));
  return hit ? [hit] : [];
}

function resolvePy(from: string, spec: string, names: string[] | undefined, known: Set<string>): string[] {
  const dots = /^\.*/.exec(spec)![0].length;
  const mod = spec.slice(dots);
  const modPath = mod ? mod.split('.').join('/') : '';
  const bases: string[] = [];
  if (dots) {
    let b = path.posix.dirname(from);
    for (let i = 1; i < dots; i++) b = path.posix.dirname(b);
    bases.push(b === '.' ? '' : b);
  } else {
    bases.push('', 'src');
    // A package next to the importing file (a script run from its folder).
    bases.push(path.posix.dirname(from) === '.' ? '' : path.posix.dirname(from));
  }
  const file = (b: string, p: string) => [b, p].filter(Boolean).join('/');
  for (const b of bases) {
    const out: string[] = [];
    const target = file(b, modPath);
    if (modPath && known.has(`${target}.py`)) out.push(`${target}.py`);
    else if (known.has(`${target ? `${target}/` : ''}__init__.py`) || !modPath) {
      if (modPath && known.has(`${target}/__init__.py`)) out.push(`${target}/__init__.py`);
      // "from pkg import mod": each name may be a module of the package.
      for (const n of names ?? []) { const m = `${target ? `${target}/` : ''}${n}.py`; if (known.has(m)) out.push(m); }
    }
    if (out.length) return out;
  }
  return [];
}
