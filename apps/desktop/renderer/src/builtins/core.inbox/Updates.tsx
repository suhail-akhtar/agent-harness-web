/**
 * The inbox's updates: what work done without the person watching left for them - a scheduled run's
 * result, what an agent told them, work an agent offered (a suggestion they start or dismiss). Each is
 * opened, marked read, snoozed, or dismissed with a reason (the reason is written down, so the kinds
 * of updates that are not useful can be told apart from the ones that came at a bad time).
 */

import React, { useState } from 'react';
import type { InboxItem } from '@harness/client';
import { Badge, Button, Icon, IconButton, Menu, Tooltip, cx, toast, type MenuItem } from '@harness/ui';
import { useData, client } from '../../state/data';
import { navigate, openSession } from '../../state/app';

const fail = (e: unknown) => toast((e as Error).message, { kind: 'error' });

const ICON: Record<InboxItem['kind'], string> = { result: 'clock', message: 'bell', suggestion: 'sparkles' };
const KIND: Record<InboxItem['kind'], string> = { result: 'Scheduled run', message: 'Message', suggestion: 'Suggestion' };
export const REASONS: Array<{ id: NonNullable<InboxItem['reason']>; label: string }> = [
  { id: 'not_useful', label: 'Not useful' }, { id: 'wrong', label: 'Wrong' }, { id: 'bad_timing', label: 'Bad timing' }, { id: 'other', label: 'Other reason' },
];

const when = (t: number) => {
  const d = Date.now() - t;
  if (d < 60_000) return 'just now';
  if (d < 3600_000) return `${Math.round(d / 60_000)} min ago`;
  if (d < 86_400_000) return `${Math.round(d / 3600_000)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { dateStyle: 'medium' });
};

/** Tomorrow at 9:00 on this computer's clock. */
const tomorrowNine = () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.getTime(); };

function UpdateRow({ item }: { item: InboxItem }) {
  const [busy, setBusy] = useState(false);
  const act = (action: 'read' | 'unread' | 'open' | 'snooze' | 'dismiss', o: { reason?: InboxItem['reason']; until?: number } = {}) => client.inbox.act(item.id, action, o).catch(fail);
  const open = () => { void act('open'); if (item.sessionId) openSession(item.sessionId); else if (item.scheduleId) navigate({ view: 'core.scheduled:scheduled' }); };
  const start = async () => {
    if (!item.proposalId) return;
    setBusy(true);
    try { const r = await client.proposals.start(item.proposalId); openSession(r.session.id); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const snooze: MenuItem[] = [
    { id: 'hour', label: 'For an hour', icon: 'clock', onSelect: () => void act('snooze', { until: Date.now() + 3600_000 }) },
    { id: 'tomorrow', label: 'Until tomorrow, 9:00', icon: 'calendar', onSelect: () => void act('snooze', { until: tomorrowNine() }) },
  ];
  const dismiss: MenuItem[] = REASONS.map((r) => ({ id: r.id, label: r.label, onSelect: () => void act('dismiss', { reason: r.id }) }));
  const tone = item.level === 'error' ? 'text-hx-danger' : item.level === 'warn' ? 'text-hx-warning' : item.kind === 'suggestion' ? 'text-hx-accent-text' : 'text-hx-muted';
  return (
    <div data-update={item.id} data-update-kind={item.kind} data-update-status={item.status} className={cx('flex gap-3 rounded-xl border p-3', item.status === 'new' ? 'border-hx-border bg-hx-elevated' : 'border-hx-border-subtle')}>
      <Icon name={item.level === 'error' || item.level === 'warn' ? 'alert' : ICON[item.kind]} size={16} className={cx('mt-0.5 shrink-0', tone)} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 text-[12px] text-hx-muted">
          {item.status === 'new' && <span className="h-2 w-2 rounded-full bg-hx-accent" aria-label="New" data-update-new />}
          <span className="font-medium text-hx-secondary">{KIND[item.kind]}</span>
          <span>{when(item.at)}</span>
        </div>
        <button type="button" onClick={open} className="mt-0.5 block max-w-full truncate text-left text-[13.5px] font-medium hover:underline" data-update-title>{item.title}</button>
        {item.body && <p className="mt-0.5 line-clamp-3 whitespace-pre-line text-[13px] text-hx-secondary" data-update-body>{item.body}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {item.kind === 'suggestion' && <Button size="sm" variant="primary" icon="play" disabled={busy} onClick={() => void start()} data-update-start>Start</Button>}
          {(item.sessionId || item.scheduleId) && <Button size="sm" variant="ghost" icon="arrow-right" onClick={open} data-update-open>{item.sessionId ? 'Open conversation' : 'Open schedule'}</Button>}
          {item.status === 'new'
            ? <Button size="sm" variant="ghost" icon="check" onClick={() => void act('read')} data-update-read>Mark read</Button>
            : <Button size="sm" variant="ghost" onClick={() => void act('unread')} data-update-unread>Mark unread</Button>}
          <Menu items={snooze} trigger={({ ref, toggle }) => <Button ref={ref} size="sm" variant="ghost" icon="clock" onClick={toggle} data-update-snooze>Snooze</Button>} />
          <Menu items={dismiss} trigger={({ ref, toggle }) => <Button ref={ref} size="sm" variant="ghost" icon="x" onClick={toggle} data-update-dismiss>Dismiss</Button>} />
        </div>
      </div>
    </div>
  );
}

/** The open updates, newest first; Mark all read. */
export function InboxUpdates(): React.ReactElement | null {
  const items = useData((s) => s.inbox);
  if (items === null) return null;
  const unread = items.filter((i) => i.status === 'new').length;
  return (
    <section data-inbox-updates className="mb-8">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-[12px] font-medium uppercase tracking-wide text-hx-muted">Updates</h2>
        {unread > 0 && <Badge tone="accent">{unread} new</Badge>}
        <span className="flex-1" />
        {unread > 0 && <Tooltip label="Mark every update read"><IconButton size="xs" icon="check" label="Mark all read" onClick={() => void client.inbox.readAll().catch(fail)} data-updates-read-all /></Tooltip>}
      </div>
      {!items.length
        ? <p className="text-[13px] text-hx-muted" data-updates-empty>No updates. Results of scheduled runs, what agents tell you, and work they offer while you are away arrive here.</p>
        : <div className="space-y-2">{items.map((i) => <UpdateRow key={i.id} item={i} />)}</div>}
    </section>
  );
}
