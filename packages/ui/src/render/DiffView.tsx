/**
 * Diffs: unified, or side by side when there is room (or the reader asks). From two texts (a tool's
 * before/after) or from unified diff text (```diff blocks, git).
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../icons.tsx';
import { diffLines, hunks, parseUnifiedDiff, splitRows, stats, type Op } from './diff.ts';

export function DiffView({ before, after, ops: given, path, collapsedLines = 400, mode: forced }: { before?: string; after?: string; ops?: Op[]; path?: string; collapsedLines?: number; mode?: 'unified' | 'split' }): React.ReactElement {
  const ops = useMemo(() => given ?? diffLines(before ?? '', after ?? ''), [given, before, after]);
  const st = useMemo(() => stats(ops), [ops]);
  const box = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  const [choice, setChoice] = useState<'auto' | 'unified' | 'split'>('auto');
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWide(el.clientWidth >= 860));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const mode = forced ?? (choice === 'auto' ? (wide ? 'split' : 'unified') : choice);
  const hs = useMemo(() => hunks(ops), [ops]);
  const total = hs.reduce((n, h) => n + h.ops.length, 0);
  const [all, setAll] = useState(total <= collapsedLines);
  let shown = 0;
  return (
    <div ref={box} data-block="diff" data-diff-mode={mode} className="my-2 overflow-hidden rounded-xl border border-hx-border-subtle">
      <div className="flex items-center gap-2 border-b border-hx-border-subtle bg-hx-code px-3 py-1 text-[11.5px] text-hx-muted">
        {path && <span className="truncate font-mono text-hx-secondary">{path}</span>}
        <span className="text-[var(--hx-diff-add-gutter)]">+{st.added}</span>
        <span className="text-[var(--hx-diff-remove-gutter)]">−{st.removed}</span>
        <div className="flex-1" />
        {!forced && (
          <button type="button" className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hx-hover hover:text-hx-primary" onClick={() => setChoice(mode === 'split' ? 'unified' : 'split')} title="Switch between unified and side-by-side">
            <Icon name={mode === 'split' ? 'list' : 'split'} size={12} />{mode === 'split' ? 'Unified' : 'Split'}
          </button>
        )}
      </div>
      <div className="max-h-[520px] overflow-auto">
        {!hs.length && <div className="px-3 py-2 text-[12px] text-hx-muted">No changes</div>}
        {hs.map((h, hi) => {
          if (!all && shown >= collapsedLines) return null;
          const rows = mode === 'split' ? splitRows(h.ops) : null;
          shown += h.ops.length;
          return (
            <div key={hi}>
              {h.skippedBefore > 0 && <div className="bg-hx-surface px-3 py-0.5 text-[11px] text-hx-muted">⋯ {h.skippedBefore} unchanged line{h.skippedBefore === 1 ? '' : 's'}</div>}
              {rows ? rows.map((r, i) => (
                <div key={i} className="grid grid-cols-2">
                  <Line op={r.left} side="a" split />
                  <Line op={r.right} side="b" split />
                </div>
              )) : h.ops.map((o, i) => <Line key={i} op={o} />)}
            </div>
          );
        })}
        {!all && total > collapsedLines && <button type="button" onClick={() => setAll(true)} className="w-full border-t border-hx-border-subtle py-1 text-[11.5px] text-hx-muted hover:bg-hx-hover">Show all {total} lines</button>}
      </div>
    </div>
  );
}

function Line({ op, side, split }: { op?: Op; side?: 'a' | 'b'; split?: boolean }): React.ReactElement {
  if (!op) return <div className="diff-row split diff-empty" />;
  const cls = op.t === '+' ? 'diff-add' : op.t === '-' ? 'diff-del' : '';
  if (split) {
    const no = side === 'a' ? op.a : op.b;
    return <div className={`diff-row split ${cls}`}><span className="diff-no">{no}</span><span className="diff-sign">{op.t === ' ' ? '' : op.t === '-' ? '−' : '+'}</span><span className="diff-code">{op.s || ' '}</span></div>;
  }
  return <div className={`diff-row ${cls}`}><span className="diff-no">{op.t === '+' ? '' : op.a}</span><span className="diff-no">{op.t === '-' ? '' : op.b}</span><span className="diff-sign">{op.t === ' ' ? '' : op.t === '-' ? '−' : '+'}</span><span className="diff-code">{op.s || ' '}</span></div>;
}

/** A ```diff block or git output: one DiffView per file. */
export function PatchView({ source }: { source: string }): React.ReactElement {
  const files = useMemo(() => parseUnifiedDiff(source), [source]);
  if (!files.length) return <pre className="my-2 overflow-auto rounded-xl bg-hx-code p-3 font-mono text-[12px]">{source}</pre>;
  return <>{files.map((f, i) => <DiffView key={i} path={f.path} ops={f.ops} />)}</>;
}
