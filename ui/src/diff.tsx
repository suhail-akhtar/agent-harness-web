import type { VNode } from 'preact';

// Line diff (LCS) rendered as unified hunks with 3 lines of context.

type Op = { t: ' ' | '-' | '+'; s: string; a?: number; b?: number };

export function diffLines(before: string, after: string): Op[] {
  const a = before.split('\n');
  const b = after.split('\n');
  // Trim the common prefix/suffix first: edits are usually small.
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
      else if (j < m && (i >= n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) { ops.push({ t: '+', s: mb[j]!, b: start + j + 1 }); j++; }
      else { ops.push({ t: '-', s: ma[i]!, a: start + i + 1 }); i++; }
    }
  }
  for (let i = endA, j = endB; i < a.length; i++, j++) ops.push({ t: ' ', s: a[i]!, a: i + 1, b: j + 1 });
  return ops;
}

export function Diff({ before, after }: { before: string; after: string }): VNode {
  const ops = diffLines(before, after);
  const keep = new Set<number>();
  ops.forEach((o, i) => { if (o.t !== ' ') for (let k = Math.max(0, i - 3); k <= Math.min(ops.length - 1, i + 3); k++) keep.add(k); });
  const rows: VNode[] = [];
  let gap = false;
  let added = 0; let removed = 0;
  ops.forEach((o, i) => {
    if (o.t === '+') added++;
    if (o.t === '-') removed++;
    if (!keep.has(i)) { gap = true; return; }
    if (gap && rows.length) rows.push(<div key={`g${i}`} class="diff-gap">⋯</div>);
    gap = false;
    rows.push(
      <div key={i} class={`diff-line diff-${o.t === '+' ? 'add' : o.t === '-' ? 'del' : 'ctx'}`}>
        <span class="diff-no">{o.t === '+' ? '' : o.a}</span>
        <span class="diff-no">{o.t === '-' ? '' : o.b}</span>
        <span class="diff-sign">{o.t}</span>
        <span class="diff-text">{o.s || ' '}</span>
      </div>,
    );
  });
  return (
    <div class="diff">
      <div class="diff-stat"><span class="add">+{added}</span> <span class="del">−{removed}</span></div>
      <div class="diff-body">{rows.length ? rows : <div class="diff-gap">No changes</div>}</div>
    </div>
  );
}
