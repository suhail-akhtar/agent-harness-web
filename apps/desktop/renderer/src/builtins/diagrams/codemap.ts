/**
 * The code map: a `code` view diagram of a workspace from its import graph (the server's
 * GET /api/sessions/:id/files/imports). Files are aggregated into folders, deep enough that the
 * picture holds at most `maxNodes` boxes; edges between folders carry how many imports they bundle.
 * Pure, so the tests run it as is.
 */

import type { DiagramEdge, DiagramNode, DiagramSpec, Tone } from '@harness/plugin-ui';

export interface ImportScan { root: string; files: Array<{ path: string; lang: string; lines: number; imports: string[] }>; external: Array<[string, number]>; truncated: boolean; ms?: number }

const ROOT = '_root';
const TONES: Tone[] = ['blue', 'purple', 'teal', 'indigo', 'orange', 'green', 'pink', 'amber', 'red', 'gray'];
const dirOf = (p: string) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
const cut = (dir: string, depth: number) => (dir ? dir.split('/').slice(0, depth).join('/') : '');
const fmtLines = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** The deepest folder level whose folders still fit in `maxNodes` boxes (at least 1, at most 4). */
export function folderDepth(scan: ImportScan, maxNodes: number): number {
  let depth = 1;
  for (let d = 2; d <= 4; d++) {
    const keys = new Set(scan.files.map((f) => cut(dirOf(f.path), d)));
    if (keys.size > maxNodes) break;
    // A level that splits nothing further is no deeper.
    if (![...keys].some((k) => k.split('/').length >= d)) break;
    depth = d;
  }
  return depth;
}

export function codeMapSpec(scan: ImportScan, o: { title?: string; maxNodes?: number } = {}): DiagramSpec {
  const maxNodes = o.maxNodes ?? 80;
  const depth = folderDepth(scan, maxNodes);
  const folderOf = (p: string) => cut(dirOf(p), depth) || ROOT;
  const stats = new Map<string, { files: number; lines: number; langs: Map<string, number>; biggest: Array<{ path: string; lines: number }> }>();
  for (const f of scan.files) {
    const k = folderOf(f.path);
    const s = stats.get(k) ?? { files: 0, lines: 0, langs: new Map<string, number>(), biggest: [] as Array<{ path: string; lines: number }> };
    s.files++; s.lines += f.lines; s.langs.set(f.lang, (s.langs.get(f.lang) ?? 0) + 1);
    s.biggest.push({ path: f.path, lines: f.lines });
    stats.set(k, s);
  }
  // A flat map (nested boxes with hundreds of crossing imports read worse): each folder tinted by its
  // top-level folder, named by the rest of its path, with the top folder as its caption.
  const tops = [...new Set([...stats.keys()].map((k) => (k === ROOT ? '' : k.split('/')[0]!)))].sort();
  const toneOf = (k: string) => TONES[tops.indexOf(k === ROOT ? '' : k.split('/')[0]!) % TONES.length]!;
  const nodes: DiagramNode[] = [...stats.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, s]) => {
    const parts = k.split('/');
    const lang = [...s.langs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return {
      id: k, kind: 'folder', title: k === ROOT ? '(root)' : parts.length > 1 ? parts.slice(1).join('/') : k,
      ...(parts.length > 1 ? { caption: `${parts[0]}/` } : {}), tone: toneOf(k),
      tech: `${s.files} file${s.files === 1 ? '' : 's'} · ${fmtLines(s.lines)} lines${lang ? ` · ${lang}` : ''}`, files: s.files,
      // Its biggest files, to open from the details.
      links: s.biggest.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path)).slice(0, 6).map((f) => ({ file: f.path, label: `${f.path.split('/').pop()} (${f.lines} lines)` })),
    };
  });
  const counts = new Map<string, number>();
  for (const f of scan.files) {
    const a = folderOf(f.path);
    for (const imp of f.imports) {
      const b = folderOf(imp);
      if (a === b || !stats.has(b)) continue;
      const key = `${a}\u0000${b}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const edges: DiagramEdge[] = [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 1500).map(([k, count], i) => {
    const [from, to] = k.split('\u0000') as [string, string];
    return { id: `i${i + 1}`, from, to, count, kind: 'import' };
  });
  const ext = scan.external.slice(0, 8).map(([n, c]) => `${n} (${c})`).join(', ');
  return {
    version: 1, view: 'code', title: o.title ?? 'Code map',
    description: `${scan.files.length} files in ${nodes.length} folders, ${edges.reduce((s, e) => s + (e.count ?? 1), 0)} imports between folders.${ext ? ` Outside packages: ${ext}.` : ''}${scan.truncated ? ' (Large workspace: only part of it was read.)' : ''}`,
    nodes, ...(edges.length ? { edges } : {}),
  };
}
