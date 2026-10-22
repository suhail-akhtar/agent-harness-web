/**
 * What the transcript draws for the multi-agent events (renderers for the item kinds "proposal",
 * "link" and "chapter"): a proposal card (Start / Dismiss), a card for a linked session started,
 * reporting or sending a message (open it here or beside), and a chapter divider.
 */

import React, { useState } from 'react';
import type { Item } from '@harness/client';
import { Badge, Button, Icon, Markdown, cx } from '@harness/ui';
import { useData } from '../../state/data';
import { openSession, openSplit } from '../../state/app';
import { useSessionLive } from '../core.chat/live';
import { dismissProposal, startProposal, useOpenProposals } from './proposals';

type ProposalItem = Extract<Item, { kind: 'proposal' }>;
type LinkItem = Extract<Item, { kind: 'link' }>;
type ChapterItem = Extract<Item, { kind: 'chapter' }>;

export function ProposalCard({ item, sessionId }: { item: ProposalItem; sessionId: string }): React.ReactElement {
  const [live] = useSessionLive(sessionId);
  const resolved = live.resolved[item.id];
  const openList = useOpenProposals(sessionId, Object.keys(live.resolved).length);
  const [busy, setBusy] = useState<'start' | 'dismiss' | null>(null);
  const [more, setMore] = useState(false);
  const isOpen = !resolved && (openList === null || openList.some((p) => p.id === item.id));
  const status = resolved?.status ?? (isOpen ? 'open' : 'resolved');
  const go = async (what: 'start' | 'dismiss') => { setBusy(what); try { if (what === 'start') await startProposal(sessionId, item.id); else await dismissProposal(sessionId, item.id); } finally { setBusy(null); } };
  const long = item.brief.length > 320;
  return (
    <div data-proposal={item.id} data-proposal-status={status} className={cx('my-1 rounded-xl border p-3', isOpen ? 'border-hx-accent/40 bg-hx-accent-soft/40' : 'border-hx-border-subtle bg-hx-elevated')}>
      <div className="flex items-center gap-2">
        <Icon name="split" size={15} className="text-hx-accent-text" />
        <span className="text-[11.5px] font-medium uppercase tracking-wide text-hx-accent-text">{item.initiation === 'own_initiative' ? 'The agent suggests a session' : 'Offered: a separate session'}</span>
        <span className="flex-1" />
        {status === 'started' && <Badge tone="success">Started</Badge>}
        {status === 'dismissed' && <Badge>Dismissed</Badge>}
        {status === 'expired' && <Badge>Expired</Badge>}
        {status === 'resolved' && <Badge>Closed</Badge>}
      </div>
      <div className="mt-1 text-[14px] font-medium text-hx-primary" data-proposal-title>{item.title}</div>
      {item.brief && <div className={cx('mt-1 text-[13px] text-hx-secondary', !more && long && 'line-clamp-4')}><Markdown text={item.brief} /></div>}
      {long && <button type="button" className="mt-0.5 text-[12px] text-hx-accent-text hover:underline" onClick={() => setMore(!more)}>{more ? 'Less' : 'More'}</button>}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11.5px] text-hx-muted">
        <span>{item.context === 'fork' ? 'Takes this conversation so far' : 'Starts fresh from the brief'}</span>
        {item.model && <><span>·</span><span>on {item.model}{item.effort ? ` (${item.effort})` : ''}</span></>}
      </div>
      {isOpen ? (
        <div className="mt-2.5 flex gap-2">
          <Button size="sm" variant="primary" icon="play" loading={busy === 'start'} disabled={!!busy} data-proposal-start onClick={() => void go('start')}>Start</Button>
          <Button size="sm" variant="ghost" loading={busy === 'dismiss'} disabled={!!busy} data-proposal-dismiss onClick={() => void go('dismiss')}>Dismiss</Button>
        </div>
      ) : resolved?.sessionId ? (
        <div className="mt-2.5 flex gap-2"><Button size="sm" icon="arrow-right" onClick={() => openSession(resolved.sessionId!)}>Open</Button><Button size="sm" variant="ghost" icon="split" onClick={() => openSplit({ view: 'core.chat:session', params: { id: resolved.sessionId! } })}>Open beside</Button></div>
      ) : null}
    </div>
  );
}

export function LinkCard({ item }: { item: LinkItem; sessionId: string }): React.ReactElement {
  const s = useData((st) => st.sessions.find((x) => x.id === item.id));
  const [more, setMore] = useState(false);
  const status = s?.status && s.status !== 'idle' ? s.status : undefined;
  const label = item.phase === 'started' ? 'Linked session started' : item.phase === 'report' ? `Report from a linked session${item.reason && item.reason !== 'done' ? ` (${item.reason})` : ''}` : 'Message from another session';
  return (
    <div data-link={item.id} data-link-phase={item.phase} className="my-1 rounded-xl border border-hx-border-subtle bg-hx-elevated p-3">
      <div className="flex items-center gap-2">
        <Icon name={item.phase === 'message' ? 'mail' : item.phase === 'report' ? 'check-circle' : 'split'} size={15} className={item.phase === 'report' ? (item.reason && item.reason !== 'done' ? 'text-hx-warning' : 'text-hx-success') : 'text-hx-accent-text'} />
        <span className="text-[11.5px] font-medium uppercase tracking-wide text-hx-muted">{label}</span>
        <span className="flex-1" />
        {status && <Badge tone={status === 'waiting' ? 'warning' : 'accent'}>{status === 'waiting' ? 'Needs you' : 'Working'}</Badge>}
      </div>
      <div className="mt-1 text-[13.5px] font-medium text-hx-primary">{s?.title || item.title}</div>
      {item.preview && <div className={cx('mt-1 whitespace-pre-wrap break-words rounded-lg bg-hx-bg px-2.5 py-1.5 text-[12.5px] text-hx-secondary', !more && 'line-clamp-5')} data-link-preview>{item.preview}</div>}
      {item.preview && item.preview.length > 300 && <button type="button" className="mt-0.5 text-[12px] text-hx-accent-text hover:underline" onClick={() => setMore(!more)}>{more ? 'Less' : 'More'}</button>}
      <div className="mt-2 flex gap-2">
        <Button size="sm" icon="arrow-right" data-link-open onClick={() => openSession(item.id)}>Open</Button>
        <Button size="sm" variant="ghost" icon="split" data-link-split onClick={() => openSplit({ view: 'core.chat:session', params: { id: item.id } })}>Open beside</Button>
      </div>
    </div>
  );
}

export function ChapterDivider({ item }: { item: ChapterItem; sessionId: string }): React.ReactElement {
  return (
    <div data-chapter={item.index} className="mb-1 mt-4 flex items-center gap-3" id={`chapter-${item.index}`}>
      <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-hx-accent-soft px-1.5 text-[11px] font-semibold text-hx-accent-text">{item.index}</span>
      <div className="min-w-0">
        <div className="text-[14px] font-semibold text-hx-primary">{item.title}</div>
        {item.summary && <div className="text-[12px] text-hx-muted">{item.summary}</div>}
      </div>
      <span className="h-px flex-1 bg-hx-border-subtle" />
    </div>
  );
}
