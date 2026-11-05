/**
 * The inbox's updates: what work done without the person watching left for them - a scheduled run's
 * result, what an agent told them, work an agent offered (a suggestion they start or dismiss). Each is
 * opened, marked read, snoozed, or dismissed with a reason (the reason is written down, so the kinds
 * of updates that are not useful can be told apart from the ones that came at a bad time).
 */

import React, { useEffect, useState } from 'react';
import type { InboxItem } from '@harness/client';
import type { Interruptions } from '@harness/client';
import { Badge, Button, Field, Icon, IconButton, Input, Menu, Modal, Tooltip, cx, toast, type MenuItem, Card, IconTile, Section, Callout, type Tone } from '@harness/ui';
import { useData, client } from '../../state/data';
import { navigate, openSession } from '../../state/app';
import { NoticingDialog, PracticeBanner, acceptFinding, useNoticing } from './Noticing';

const fail = (e: unknown) => toast((e as Error).message, { kind: 'error' });

const ICON: Record<InboxItem['kind'], string> = { result: 'clock', message: 'bell', suggestion: 'sparkles', digest: 'inbox', noticed: 'eye' };
const KIND: Record<InboxItem['kind'], string> = { result: 'Scheduled run', message: 'Message', suggestion: 'Suggestion', digest: 'Digest', noticed: 'Noticed' };
/** What noticed it (src/core/noticing.ts DETECTORS). */
const DETECTOR: Record<string, string> = { away_failure: 'failed while you were away', routine_health: 'a schedule in trouble', stuck: 'the same failure again', repeated_task: 'a task you repeat' };
/** Why an update did not interrupt (it waited here). */
const HELD: Record<NonNullable<InboxItem['held']>, string> = { policy: 'kept quiet by its schedule', digest: 'for your digest', quiet: 'in your quiet hours', budget: 'past your daily most' };
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

function UpdateRow({ item, onNoticing }: { item: InboxItem; onNoticing: () => void }) {
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
  const tone: Tone = item.level === 'error' ? 'danger' : item.level === 'warn' ? 'warning' : item.kind === 'suggestion' ? 'accent' : 'neutral';
  return (
    <Card padding="sm" data-update={item.id} data-update-kind={item.kind} data-update-status={item.status} className={cx('flex gap-3', item.status === 'new' && 'border-hx-border')}>
      <IconTile icon={item.level === 'error' || item.level === 'warn' ? 'alert' : ICON[item.kind]} tone={tone} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 text-small text-hx-muted">
          {item.status === 'new' && <span className="h-2 w-2 rounded-full bg-hx-accent" aria-label="New" data-update-new />}
          <span className="font-medium text-hx-secondary">{KIND[item.kind]}</span>
          <span>{when(item.at)}</span>
          {item.held && <span data-update-held={item.held}>· {HELD[item.held]}</span>}
          {item.detector && DETECTOR[item.detector] && <button type="button" className="hover:underline" onClick={onNoticing} data-update-detector={item.detector}>· {DETECTOR[item.detector]}</button>}
        </div>
        <button type="button" onClick={open} className="mt-0.5 block max-w-full truncate text-left text-body font-medium hover:underline" data-update-title>{item.title}</button>
        {item.body && <p className="mt-0.5 line-clamp-3 whitespace-pre-line text-body text-hx-secondary" data-update-body>{item.body}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {item.kind === 'suggestion' && <Button size="sm" variant="primary" icon="play" disabled={busy} onClick={() => void start()} data-update-start>Start</Button>}
          {item.kind === 'noticed' && item.draft && <Button size="sm" variant="primary" icon="calendar" onClick={() => void acceptFinding(item).catch(fail)} data-update-setup>Set it up…</Button>}
          {item.kind === 'noticed' && item.action && <Button size="sm" variant="primary" disabled={busy} onClick={() => { setBusy(true); void acceptFinding(item).catch(fail).finally(() => setBusy(false)); }} data-update-accept>{item.action.label}</Button>}
          {(item.sessionId || item.scheduleId) && <Button size="sm" variant="ghost" icon="arrow-right" onClick={open} data-update-open>{item.sessionId ? 'Open conversation' : 'Open schedule'}</Button>}
          {item.status === 'new'
            ? <Button size="sm" variant="ghost" icon="check" onClick={() => void act('read')} data-update-read>Mark read</Button>
            : <Button size="sm" variant="ghost" onClick={() => void act('unread')} data-update-unread>Mark unread</Button>}
          <Menu items={snooze} trigger={({ ref, toggle }) => <Button ref={ref} size="sm" variant="ghost" icon="clock" onClick={toggle} data-update-snooze>Snooze</Button>} />
          <Menu items={dismiss} trigger={({ ref, toggle }) => <Button ref={ref} size="sm" variant="ghost" icon="x" onClick={toggle} data-update-dismiss>Dismiss</Button>} />
        </div>
      </div>
    </Card>
  );
}

/** The open updates, newest first; Mark all read. */
export function InboxUpdates(): React.ReactElement | null {
  const items = useData((s) => s.inbox);
  const [limits, setLimits] = useState(false);
  const [noticing, setNoticing] = useState(false);
  const [overview] = useNoticing(!noticing);
  if (items === null) return null;
  const unread = items.filter((i) => i.status === 'new').length;
  return (
    <Section data-inbox-updates title={<>Updates{unread > 0 && <Badge tone="accent" className="ml-2 normal-case tracking-normal">{unread} new</Badge>}</>} actions={<>
      {unread > 0 && <Tooltip label="Mark every update read"><IconButton size="sm" icon="check" label="Mark all read" onClick={() => void client.inbox.readAll().catch(fail)} data-updates-read-all /></Tooltip>}
      {overview && overview.enabled && <Tooltip label={`Noticing: ${overview.mode === 'on' ? 'on' : overview.mode === 'practice' ? 'practising quietly' : 'off'}`}><IconButton size="sm" icon={overview.mode === 'off' ? 'eye-off' : 'eye'} label="Noticing" onClick={() => setNoticing(true)} data-updates-noticing /></Tooltip>}
      <Tooltip label="When updates may interrupt you"><IconButton size="sm" icon="settings" label="Interruptions" onClick={() => setLimits(true)} data-updates-settings /></Tooltip>
    </>}>
      <InterruptionsDialog open={limits} onClose={() => setLimits(false)} />
      <NoticingDialog open={noticing} onClose={() => setNoticing(false)} />
      <PracticeBanner o={overview} onReview={() => setNoticing(true)} />
      {!items.length
        ? <p className="text-body text-hx-muted" data-updates-empty>No updates. Results of scheduled runs, what agents tell you, and work they offer while you are away arrive here.</p>
        : <div className="space-y-2">{items.map((i) => <UpdateRow key={i.id} item={i} onNoticing={() => setNoticing(true)} />)}</div>}
    </Section>
  );
}

const LOCAL_ZONE = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } })();

/** The person's limits: quiet hours, a most a day, a digest time (their clock). */
export function InterruptionsDialog({ open, onClose }: { open: boolean; onClose: () => void }): React.ReactElement {
  const [f, setF] = useState({ quietFrom: '', quietTo: '', maxPerDay: '', digestAt: '' });
  const [error, setError] = useState('');
  // Until the saved limits are here the form stays shut: what they replace would be lost, and a save would blank them.
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!open) return;
    setError('');
    setLoaded(false);
    client.inbox.settings().then((p) => { setLoaded(true); setF({ quietFrom: p.quietFrom ?? '', quietTo: p.quietTo ?? '', maxPerDay: p.maxPerDay === undefined ? '' : String(p.maxPerDay), digestAt: p.digestAt ?? '' }); }).catch((e: Error) => setError(e.message));
  }, [open]);
  const save = async () => {
    setError('');
    const body: Interruptions = { timeZone: LOCAL_ZONE || undefined, ...(f.quietFrom || f.quietTo ? { quietFrom: f.quietFrom, quietTo: f.quietTo } : {}), ...(f.maxPerDay !== '' ? { maxPerDay: Number(f.maxPerDay) } : {}), ...(f.digestAt ? { digestAt: f.digestAt } : {}) };
    try { await client.inbox.setSettings(body); toast('Saved', { kind: 'success' }); onClose(); } catch (e) { setError((e as Error).message); }
  };
  return (
    <Modal open={open} onClose={onClose} title="When updates may interrupt you" size="md" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!loaded} onClick={() => void save()} data-limits-save>Save</Button></>}>
      <div data-limits>
        <p className="mb-4 text-small text-hx-secondary">Every update lands in your Inbox. These decide when one may also interrupt you with a notification. Each schedule can be quieter still (its "Tell me" setting).</p>
        <div className="grid gap-x-3 md:grid-cols-2">
          <Field label="Quiet from" help="Nothing interrupts, not even errors"><Input type="time" value={f.quietFrom} onChange={(e) => setF({ ...f, quietFrom: e.target.value })} disabled={!loaded} data-limits-quiet-from /></Field>
          <Field label="Quiet until"><Input type="time" value={f.quietTo} onChange={(e) => setF({ ...f, quietTo: e.target.value })} disabled={!loaded} data-limits-quiet-to /></Field>
          <Field label="At most a day" help="Empty: no limit. Errors still interrupt"><Input type="number" min={0} value={f.maxPerDay} onChange={(e) => setF({ ...f, maxPerDay: e.target.value })} placeholder="No limit" disabled={!loaded} data-limits-max /></Field>
          <Field label="Daily digest at" help="What waited, in one update"><Input type="time" value={f.digestAt} onChange={(e) => setF({ ...f, digestAt: e.target.value })} disabled={!loaded} data-limits-digest /></Field>
        </div>
        <p className="text-small text-hx-muted">Times are on this computer's clock{LOCAL_ZONE ? ` (${LOCAL_ZONE})` : ''}.</p>
        {error && <Callout tone="danger" className="mt-2" data-limits-error>{error}</Callout>}
      </div>
    </Modal>
  );
}
