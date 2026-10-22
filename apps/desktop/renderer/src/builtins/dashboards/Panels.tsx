/**
 * Side panels and cards: the Ask conversation beside a dashboard, "Add to dashboard" for a block
 * pinned from a transcript, and the card under the agents' data tool calls (what changed, Open, Undo).
 */

import React, { useEffect, useRef, useState } from 'react';
import { Badge, Button, Field, Input, Select, Spinner, Textarea, toast } from '@harness/ui';
import { client } from '../../state/data';
import { navigate, useApp } from '../../state/app';
import { Transcript } from '../core.chat/Transcript';
import { useSessionLive } from '../core.chat/live';
import { PendingCard, respondFor } from '../../components/Pending';
import { act, useDataStore } from './api';

/** The agent working on a dashboard: its live transcript, its questions, and a box to continue. */
export function AskPanel({ params }: { params?: Record<string, string> }): React.ReactElement {
  const id = params?.session ?? '';
  const [s] = useSessionLive(id);
  const [text, setText] = useState('');
  const running = s.status !== 'idle';
  const send = () => { if (!text.trim()) return; void client.sessions.send(id, text.trim()).catch((e: Error) => toast(e.message, { kind: 'error' })); setText(''); };
  if (!id) return <p className="p-3 text-hx-muted">No conversation.</p>;
  return (
    <div className="flex h-full flex-col" data-ask-panel={id} data-status={s.status}>
      <div className="min-h-0 flex-1 overflow-auto">{s.loaded ? <Transcript sessionId={id} items={s.live.items} running={running} onRetry={() => {}} /> : <Spinner />}</div>
      {s.pending.length > 0 && <div className="space-y-2 p-2">{s.pending.map((p) => <PendingCard key={p.requestId} p={p} respond={respondFor(id)} />)}</div>}
      <div className="flex gap-1 border-t border-hx-border-subtle p-2">
        <Textarea aria-label="Continue" rows={2} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} placeholder={running ? 'Working… (Enter steers)' : 'Ask for another change'} />
        <div className="flex flex-col gap-1"><Button size="sm" variant="primary" onClick={send}>Send</Button>{running && <Button size="sm" onClick={() => void client.sessions.abort(id)}>Stop</Button>}</div>
      </div>
      <button type="button" className="border-t border-hx-border-subtle p-1.5 text-[12px] text-hx-accent-text hover:underline" onClick={() => navigate({ view: 'core.chat:session', params: { id } })}>Open the whole conversation</button>
    </div>
  );
}

/** "Add to dashboard": a chart, figure, table or KPIs from a conversation into a dashboard or report (its numbers become a static dataset, labelled as typed by a model). */
export function PinPanel({ data }: { data?: unknown }): React.ReactElement {
  const block = (data ?? {}) as { lang?: string; source?: string; kind?: string };
  const docs = useDataStore((s) => s.docs);
  const [target, setTarget] = useState('new');
  const [title, setTitle] = useState('Pinned');
  const [busy, setBusy] = useState(false);
  useEffect(() => { void useDataStore.getState().refreshDocs(); }, []);
  const pin = async () => {
    setBusy(true);
    try {
      const r = target === 'new' || target === 'new-report'
        ? await act('doc.new', { doc: { type: target === 'new-report' ? 'report' : 'dashboard', title } }, { more: [['doc.pin', { doc: '$new', block: { lang: block.lang, source: block.source } }]] })
        : await act('doc.pin', { doc: target, block: { lang: block.lang, source: block.source } });
      const doc = r.changed.find((c) => c.target !== 'catalog')?.target;
      useApp.setState({ panel: null });
      if (doc) toast('Pinned. Its numbers were typed in the conversation: bind a real source to trust them.', { kind: 'success', action: { label: 'Open', run: () => navigate({ view: 'core.dashboards:doc', params: { id: doc } }) } });
    } catch { /* toasted */ } finally { setBusy(false); }
  };
  return (
    <div className="space-y-2 p-2" data-pin-panel>
      <p className="text-[12.5px] text-hx-secondary">Adds this {block.kind ?? 'block'} as a visual. Its data becomes a <b>static dataset marked as typed by a model</b>; bind the visual to a real source to make the numbers the engine's.</p>
      <Field label="Into"><Select value={target} onChange={setTarget} options={[{ value: 'new', label: 'A new dashboard' }, { value: 'new-report', label: 'A new report' }, ...(docs ?? []).map((d) => ({ value: d.id, label: `${d.type === 'report' ? 'Report' : 'Dashboard'}: ${d.title}` }))]} data-pin-target /></Field>
      {target.startsWith('new') && <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} data-pin-title /></Field>}
      <Button variant="primary" loading={busy} onClick={() => void pin()} data-pin-go>Add</Button>
    </div>
  );
}

/** Under an agent's datasource / dataset / model / dashboard call: the diff, the versions, Open and Undo. */
export function ToolResult({ input, result, isError }: { tool: string; input: Record<string, unknown>; result?: string; isError?: boolean }): React.ReactElement | null {
  const [undone, setUndone] = useState(false);
  const once = useRef(false);
  if (!result || isError) return null;
  const changed = /\nchanged:\n([\s\S]*?)(?:\nversions:|$)/.exec(result)?.[1]?.split('\n').filter(Boolean) ?? [];
  const versions = [...(/versions: ([^\n(]*)/.exec(result)?.[1] ?? '').matchAll(/((?:dash|rep)-[a-z0-9]+|catalog) v(\d+)/g)].map((m) => ({ target: m[1]!, version: Number(m[2]) }));
  const doc = versions.find((v) => v.target !== 'catalog')?.target ?? (typeof input.doc === 'string' && /^(dash|rep)-/.test(input.doc) ? input.doc : undefined);
  if (!changed.length && !doc) return null;
  return (
    <div className="mt-1 rounded-lg border border-hx-border-subtle bg-hx-elevated p-2 text-[12px]" data-data-change>
      {changed.length > 0 && <ul className="space-y-0.5 font-mono text-[11.5px]">{changed.slice(0, 12).map((l, i) => <li key={i} className={l.includes(': +') || l.startsWith('+') ? 'text-hx-success' : l.includes(': -') || l.startsWith('-') ? 'text-hx-danger' : 'text-hx-secondary'}>{l}</li>)}{changed.length > 12 && <li className="text-hx-muted">… {changed.length - 12} more</li>}</ul>}
      <div className="mt-1 flex items-center gap-1">
        {versions.map((v) => <Badge key={v.target}>{v.target} v{v.version}</Badge>)}
        {doc && <Button size="sm" icon="chart" onClick={() => navigate({ view: 'core.dashboards:doc', params: { id: doc } })} data-open-doc>Open</Button>}
        {versions.length > 0 && <Button size="sm" icon="arrow-left" disabled={undone} data-undo-change onClick={() => { if (once.current) return; once.current = true; void Promise.all(versions.map((v) => act('doc.undo', v.target === 'catalog' ? { target: 'catalog' } : { doc: v.target }, { quiet: true }))).then(() => { setUndone(true); toast('Undone'); }).catch(() => { once.current = false; }); }}>{undone ? 'Undone' : 'Undo'}</Button>}
      </div>
    </div>
  );
}

/** A home card: the dashboards opened most. */
export function DashboardsCard(): React.ReactElement {
  const docs = useDataStore((s) => s.docs);
  useEffect(() => { void useDataStore.getState().refreshDocs(); }, []);
  const top = [...(docs ?? [])].sort((a, b) => b.views - a.views || b.updatedAt - a.updatedAt).slice(0, 4);
  if (!top.length) return <p className="text-[12.5px] text-hx-muted">No dashboards yet. Ask for one, or pin a chart from a conversation.</p>;
  return <div className="space-y-1">{top.map((d) => <button key={d.id} type="button" className="block w-full truncate rounded px-1 py-0.5 text-left text-[13px] hover:bg-hx-hover" onClick={() => navigate({ view: 'core.dashboards:doc', params: { id: d.id } })}>{d.title} <span className="text-[11px] text-hx-muted">{d.views} views</span></button>)}</div>;
}
