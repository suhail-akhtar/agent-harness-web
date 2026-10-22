/**
 * Line diffs: an LCS diff of two texts, hunks with context, rows for a split (side by side) view,
 * and a reader for unified diff text (```diff blocks, git output). Pure and tested.
 */

export type Op = { t: ' ' | '-' | '+'; s: string; a?: number; b?: number };

export function diffLines(before: string, after: string): Op[] {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length; let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const ma = a.slice(start, endA); const mb = b.slice(start, endB);
  const ops: Op[] = [];
  for (let i = 0; i < start; i++) ops.push({ t: ' ', s: a[i]!, a: i + 1, b: i + 1 });
  if (ma.length * mb.length > 4_000_000) {
    ma.forEach((s, i) => ops.push({ t: '-', s, a: start + i + 1 }));
    mb.forEach((s, i) => ops.push({ t: '+', s, b: start + i + 1 }));
  } else {
    const n = ma.length; const m = mb.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = ma[i] === mb[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    let i = 0; let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && ma[i] === mb[j]) { ops.push({ t: ' ', s: ma[i]!, a: start + i + 1, b: start + j + 1 }); i++; j++; }
      else if (i < n && (j >= m || dp[i + 1]![j]! >= dp[i]![j + 1]!)) { ops.push({ t: '-', s: ma[i]!, a: start + i + 1 }); i++; }
      else { ops.push({ t: '+', s: mb[j]!, b: start + j + 1 }); j++; }
    }
  }
  for (let i = endA, j = endB; i < a.length; i++, j++) ops.push({ t: ' ', s: a[i]!, a: i + 1, b: j + 1 });
  return ops;
}

export interface Hunk { ops: Op[]; skippedBefore: number }

/** Changed lines with `context` lines around them; runs of unchanged lines between become gaps. */
export function hunks(ops: Op[], context = 3): Hunk[] {
  const keep = new Set<number>();
  ops.forEach((o, i) => { if (o.t !== ' ') for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep.add(k); });
  const out: Hunk[] = [];
  let cur: Hunk | null = null;
  let skipped = 0;
  ops.forEach((o, i) => {
    if (!keep.has(i)) { cur = null; skipped++; return; }
    if (!cur) { cur = { ops: [], skippedBefore: skipped }; out.push(cur); skipped = 0; }
    cur.ops.push(o);
  });
  return out;
}

export function stats(ops: Op[]): { added: number; removed: number } {
  let added = 0; let removed = 0;
  for (const o of ops) { if (o.t === '+') added++; else if (o.t === '-') removed++; }
  return { added, removed };
}

export interface SplitRow { left?: Op; right?: Op }

/** Pairs removed and added lines side by side (a removal run against the addition run after it). */
export function splitRows(ops: Op[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < ops.length) {
    const o = ops[i]!;
    if (o.t === ' ') { rows.push({ left: o, right: o }); i++; continue; }
    const dels: Op[] = []; const adds: Op[] = [];
    while (i < ops.length && ops[i]!.t === '-') dels.push(ops[i++]!);
    while (i < ops.length && ops[i]!.t === '+') adds.push(ops[i++]!);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k], right: adds[k] });
  }
  return rows;
}

export interface FilePatch { path: string; oldPath?: string; ops: Op[]; binary?: boolean }

/** Reads unified diff text (one file or many, as git prints it) into ops per file. */
export function parseUnifiedDiff(text: string): FilePatch[] {
  const files: FilePatch[] = [];
  let cur: FilePatch | null = null;
  let a = 0; let b = 0;
  const lines = text.replace(/\r/g, '').split('\n');
  for (const line of lines) {
    const git = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (git) { cur = { path: git[2]!, oldPath: git[1]!, ops: [] }; files.push(cur); continue; }
    if (line.startsWith('--- ')) { if (!cur) { cur = { path: '', ops: [] }; files.push(cur); } const p = line.slice(4).replace(/^a\//, ''); if (p !== '/dev/null') cur.oldPath = p; continue; }
    if (line.startsWith('+++ ')) { const p = line.slice(4).replace(/^b\//, ''); if (cur && p !== '/dev/null') cur.path = p; else if (cur && !cur.path) cur.path = cur.oldPath ?? ''; continue; }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) { if (!cur) { cur = { path: '', ops: [] }; files.push(cur); } a = Number(h[1]); b = Number(h[2]); continue; }
    if (!cur) continue;
    if (/^Binary files/.test(line)) { cur.binary = true; continue; }
    if (line.startsWith('+')) cur.ops.push({ t: '+', s: line.slice(1), b: b++ });
    else if (line.startsWith('-')) cur.ops.push({ t: '-', s: line.slice(1), a: a++ });
    else if (line.startsWith(' ')) cur.ops.push({ t: ' ', s: line.slice(1), a: a++, b: b++ });
  }
  return files.filter((f) => f.ops.length || f.binary);
}
