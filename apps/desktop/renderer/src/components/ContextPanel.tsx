/**
 * The context meter in a conversation's header and, on a click, what fills the context: a bar of
 * its parts (the system prompt, the tool schemas sent, instructions, memory, skills, the messages),
 * the compaction buffer and the room left, then the tools that wait until loaded. From the engine's
 * own account (GET /api/sessions/:id/context), refreshed while open as the conversation grows.
 */

import React, { useEffect, useRef, useState } from 'react';
import type { ContextBreakdown } from '@harness/client';
import { Popover, Spinner, Tooltip, cx } from '@harness/ui';
import { client } from '../state/data';

const fmt = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const pct = (n: number, of: number) => (of ? `${((n / of) * 100).toFixed(1)}%` : '—');

/** One colour per part, from the theme's tokens (the same in light and dark). */
const COLOUR: Record<string, string> = {
  messages: 'var(--hx-accent)',
  tools: 'var(--hx-warning)',
  'plugin-tools': 'var(--hx-success)',
  'mcp-tools': 'var(--hx-info)',
  system: 'var(--hx-text-muted)',
  instructions: 'color-mix(in srgb, var(--hx-text-muted) 75%, var(--hx-bg))',
  memory: 'color-mix(in srgb, var(--hx-danger) 70%, var(--hx-bg))',
  skills: 'color-mix(in srgb, var(--hx-accent) 45%, var(--hx-text-muted))',
};
const colourOf = (id: string) => COLOUR[id] ?? 'var(--hx-text-muted)';

export function ContextMeter({ sessionId, tokens, window: win }: { sessionId: string; tokens: number; window: number }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const p = win ? Math.min(100, Math.round((tokens / win) * 100)) : 0;
  return (
    <>
      <Tooltip label="What fills the context">
        <button ref={ref} type="button" data-context-meter aria-expanded={open} onClick={() => setOpen(!open)} className="flex items-center gap-1.5 rounded px-1 hover:bg-hx-hover hover:text-hx-primary">
          <span className="h-1.5 w-16 overflow-hidden rounded-full bg-hx-pill"><span className={cx('block h-full rounded-full', p > 85 ? 'bg-hx-danger' : p > 60 ? 'bg-hx-warning' : 'bg-hx-accent')} style={{ width: `${p}%` }} /></span>{fmt(tokens)}
        </button>
      </Tooltip>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} placement="bottom-end" className="w-[380px]" role="dialog" label="Context">
        {open && <ContextPanel sessionId={sessionId} tokens={tokens} />}
      </Popover>
    </>
  );
}

export function ContextPanel({ sessionId, tokens }: { sessionId: string; tokens: number }): React.ReactElement {
  const [b, setB] = useState<ContextBreakdown | null>(null);
  const [error, setError] = useState('');
  // Again whenever the conversation's count moves (a turn ended, a compaction).
  useEffect(() => {
    let alive = true;
    client.sessions.context(sessionId).then((x) => { if (alive) { setB(x); setError(''); } }).catch((e: Error) => alive && setError(e.message));
    return () => { alive = false; };
  }, [sessionId, tokens]);
  if (error && !b) return <div className="p-4 text-[12.5px] text-hx-danger" data-context-panel>{error}</div>;
  if (!b) return <div className="flex justify-center p-6" data-context-panel><Spinner size={16} /></div>;
  const buffer = Math.max(0, b.window - b.compactAt);
  const used = (b.used / b.window) * 100;
  const free = Math.max(0, b.window - b.used - buffer);
  const parts = b.parts.filter((x) => x.tokens > 0).sort((x, y) => y.tokens - x.tokens);
  const rows: Array<{ id: string; label: string; tokens: number; colour: string; hint?: string }> = [
    ...parts.map((x) => ({ ...x, colour: colourOf(x.id) })),
    { id: 'buffer', label: `Past the compaction point (${fmt(b.compactAt)})`, tokens: buffer, colour: 'color-mix(in srgb, var(--hx-text-muted) 35%, var(--hx-bg))', hint: `Never filled: at ${fmt(b.compactAt)} the conversation is summarised to make room` },
    { id: 'free', label: 'Free space', tokens: free, colour: 'var(--hx-pill)' },
  ];
  return (
    <div className="p-4" data-context-panel>
      <div className="mb-1 text-[13px] font-semibold text-hx-primary">Context</div>
      <div className="mb-2 flex items-baseline justify-between text-[13px]">
        <span className="text-hx-primary" data-context-used>{used < 10 ? used.toFixed(1) : Math.round(used)}% used</span>
        <span className="text-hx-muted">{fmt(b.used)} / {fmt(b.window)}</span>
      </div>
      <div className="mb-3 flex h-2 w-full overflow-hidden rounded-full bg-hx-pill" role="img" aria-label={`${fmt(b.used)} of ${fmt(b.window)} tokens used`}>
        {rows.filter((r) => r.id !== 'free').map((r) => <span key={r.id} className="h-full" style={{ width: `${(r.tokens / b.window) * 100}%`, background: r.colour }} />)}
      </div>
      <ul className="space-y-1.5 text-[12.5px]">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center gap-2.5" data-context-part={r.id} title={r.hint}>
            <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: r.colour, boxShadow: r.id === 'free' ? 'inset 0 0 0 1px var(--hx-border)' : undefined }} />
            <span className="flex-1 text-hx-secondary">{r.label}</span>
            <span className="w-16 text-right tabular-nums text-hx-muted">{fmt(r.tokens)}</span>
            <span className="w-12 text-right tabular-nums text-hx-muted">{pct(r.tokens, b.window)}</span>
          </li>
        ))}
        {b.deferred.tools > 0 && (
          <li className="flex items-center gap-2.5 opacity-70" data-context-part="deferred" title="Their schemas are sent only once the agent loads them">
            <span className="h-2.5 w-2.5 shrink-0 rounded-[3px] border border-dashed border-hx-border" />
            <span className="flex-1 text-hx-secondary">Tools loaded on demand ({b.deferred.tools})</span>
            <span className="w-16 text-right tabular-nums text-hx-muted">{fmt(b.deferred.tokens)}</span>
            <span className="w-12 text-right text-hx-muted">—</span>
          </li>
        )}
      </ul>
      <p className="mt-3 border-t border-hx-border-subtle pt-2 text-[11.5px] leading-relaxed text-hx-muted">
        {b.measured ? 'Total from the model provider’s count of the last request; the parts are estimates, the messages the rest.' : 'Estimated: nothing has been sent yet.'}
        {b.compactions ? ` Compacted ${b.compactions}×.` : ''} {fmt(Math.max(0, b.compactAt - b.used))} until it is compacted.
      </p>
    </div>
  );
}
