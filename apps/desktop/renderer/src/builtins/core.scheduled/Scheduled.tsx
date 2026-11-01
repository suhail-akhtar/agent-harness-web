/**
 * Scheduled work in the window: every schedule and trigger, when it runs next, what its last run came to,
 * and each run's record (how it ended, how long it took, what it cost, what it said, its conversation).
 * New, Edit, Run now, on/off and Delete. The same list is the Settings > Schedules section, and the run
 * rows are Activity's "Recent runs".
 */

import React, { useEffect, useState } from 'react';
import type { Schedule, ScheduleRun } from '@harness/client';
import { duration, isMissing } from '@harness/client';
import { Badge, Button, Icon, IconButton, InfoNote, Modal, Page, PageState, Spinner, Switch, Tooltip, toast } from '@harness/ui';
import { useData, client } from '../../state/data';
import { openSession, useApp } from '../../state/app';
import { money } from '../../components/CostByModel';
import { ScheduleForm } from '../../components/ScheduleForm';
import { desktop } from '../../bridge';

const fail = (e: unknown) => toast((e as Error).message, { kind: 'error' });

/** Loads again whenever a schedule changes or a run starts or ends. */
function useScheduled<T>(f: () => Promise<T>, deps: unknown[] = []): { value: T | null; error: string; reload: () => void } {
  const tick = useData((s) => s.scheduleTick);
  const [n, setN] = useState(0);
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    f().then((v) => { if (alive) { setValue(v); setError(''); } }).catch((e: Error) => { if (alive) setError(isMissing(e) ? 'This server does not offer schedules.' : e.message); });
    return () => { alive = false; };
  }, [tick, n, ...deps]);
  return { value, error, reload: () => setN((x) => x + 1) };
}

const fmt = (t?: number | null) => (t ? new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

/** When it runs, in words. */
export function timing(s: Schedule): string {
  if (s.trigger) return 'When its URL is called';
  if (s.cron) return `${s.cron}${s.timeZone ? ` (${s.timeZone})` : ''}`;
  return s.at ? `Once, ${fmt(s.at)}` : 'Once';
}

const TONE: Record<ScheduleRun['status'], 'success' | 'accent' | 'danger' | 'warning' | 'neutral'> = { completed: 'success', running: 'accent', failed: 'danger', stopped: 'warning', skipped: 'neutral', interrupted: 'warning' };
const LABEL: Record<ScheduleRun['status'], string> = { completed: 'Completed', running: 'Running', failed: 'Failed', stopped: 'Stopped', skipped: 'Skipped', interrupted: 'Interrupted' };

export function RunStatus({ run }: { run: ScheduleRun }): React.ReactElement {
  if (run.status === 'completed' && run.noOp) return <Badge tone="neutral">Nothing to report</Badge>;
  return <Badge tone={TONE[run.status]}>{run.status === 'running' && <Spinner size={10} className="mr-1" />}{LABEL[run.status]}</Badge>;
}

/** One run: its status, when, how long, its cost, what it said or why it stopped, and its conversation. */
export function RunRow({ run, showTitle }: { run: ScheduleRun; showTitle?: boolean }): React.ReactElement {
  const took = run.endedAt && run.status !== 'skipped' ? duration(run.endedAt - run.startedAt) : '';
  const text = run.status === 'completed' ? run.summary : run.reason ?? run.summary;
  return (
    <div data-run={run.id} data-run-status={run.status} className="flex items-start gap-2 px-3 py-2 text-[12.5px]">
      <div className="w-[118px] shrink-0 pt-0.5"><RunStatus run={run} /></div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 text-[11.5px] text-hx-muted">
          {showTitle && <span className="font-medium text-hx-secondary">{run.title}</span>}
          <span>{fmt(run.startedAt)}</span>
          {took && <span>· {took}</span>}
          {run.costUsd !== undefined && run.costUsd > 0 && <span>· {money(run.costUsd)}</span>}
          {run.by !== 'schedule' && <span>· {run.by === 'manual' ? 'run now' : 'trigger'}</span>}
          {run.notified && <span className="inline-flex items-center gap-0.5">· <Icon name="bell" size={11} /> told you</span>}
        </div>
        {text && <div className="mt-0.5 line-clamp-2 text-hx-secondary" data-run-summary>{text}</div>}
      </div>
      {run.sessionId && <Tooltip label="Open its conversation"><IconButton size="xs" icon="arrow-right" label="Open its conversation" onClick={() => openSession(run.sessionId!)} /></Tooltip>}
    </div>
  );
}

function Runs({ id }: { id: string }) {
  const { value: runs, error } = useScheduled(() => client.schedules.runs(id, 20), [id]);
  if (error) return <div className="px-3 py-2 text-[12px] text-hx-danger">{error}</div>;
  if (!runs) return <div className="px-3 py-2"><Spinner /></div>;
  if (!runs.length) return <div className="px-3 py-2 text-[12px] text-hx-muted" data-runs-empty>No runs yet.</div>;
  return <div className="divide-y divide-hx-border-subtle" data-runs={id}>{runs.map((r) => <RunRow key={r.id} run={r} />)}</div>;
}

function ScheduleItem({ s, onEdit, reload }: { s: Schedule; onEdit: () => void; reload: () => void }) {
  const [open, setOpen] = useState(false);
  const last = s.lastResult;
  const tone = !last ? undefined : /^completed/.test(last) ? 'success' : /^(started|running)/.test(last) ? 'accent' : /^(failed)/.test(last) ? 'danger' : 'warning';
  return (
    <div data-schedule={s.id} className="rounded-xl border border-hx-border-subtle bg-hx-elevated">
      <div className="flex items-center gap-2 px-3 py-2.5 text-[13px]">
        <IconButton size="xs" icon={open ? 'chevron-down' : 'chevron-right'} label={open ? 'Hide its runs' : 'Show its runs'} onClick={() => setOpen(!open)} data-schedule-toggle />
        <Icon name={s.trigger ? 'link' : 'clock'} size={14} className="text-hx-muted" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{s.title || s.prompt}</span>
          <span className="block truncate text-[11.5px] text-hx-muted" data-schedule-when>
            {timing(s)}{s.enabled && s.nextRun && !s.trigger && s.cron ? ` · next ${fmt(s.nextRun)}` : ''}{!s.enabled ? ' · off' : ''}{s.maxCostUsd ? ` · at most ${money(s.maxCostUsd)} a run` : ''}
          </span>
        </span>
        {last && <span className="hidden max-w-[34%] truncate md:inline" data-schedule-last title={last}><Badge tone={tone}>{last.length > 40 ? `${last.slice(0, 39)}…` : last}</Badge></span>}
        <Switch checked={s.enabled} onChange={(v) => void client.schedules.setEnabled(s.id, v).then(reload).catch(fail)} label="Enabled" />
        <IconButton size="xs" icon="play" label="Run now" onClick={() => void client.schedules.run(s.id).then(() => { setOpen(true); reload(); }).catch(fail)} />
        <IconButton size="xs" icon="edit" label="Edit" onClick={onEdit} />
        <IconButton size="xs" icon="trash" tone="danger" label="Delete" onClick={() => void client.schedules.remove(s.id).then(reload).catch(fail)} />
      </div>
      {open && <div className="border-t border-hx-border-subtle"><Runs id={s.id} /></div>}
    </div>
  );
}

/** Every schedule and trigger of the person's, with New, Edit and their runs. */
export function ScheduleManager({ embedded }: { embedded?: boolean }): React.ReactElement {
  const { value: list, error, reload } = useScheduled(() => client.schedules.list());
  const keepInTray = useApp((x) => x.prefs.keepInTray);
  const startAtLogin = useApp((x) => x.prefs.startAtLogin);
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null);
  if (error) return <InfoNote>{error}</InfoNote>;
  if (!list) return <Spinner />;
  return (
    <div data-schedule-manager className="space-y-3">
      {list.some((s) => s.enabled && !s.trigger) && !keepInTray && (
        <InfoNote>
          <span data-schedules-tray-note>Schedules run only while this app is open. Closing the window quits it unless it keeps running in the tray.</span>{' '}
          <Button size="sm" onClick={() => useApp.getState().setPrefs({ keepInTray: true })}>Keep running in the tray</Button>
        </InfoNote>
      )}
      {list.some((s) => s.enabled && !s.trigger) && keepInTray && !startAtLogin && (
        <p className="flex flex-wrap items-center gap-2 text-[12px] text-hx-muted" data-schedules-login-note>
          They also stop when this computer restarts, until the app is opened again.
          <Button size="sm" variant="ghost" onClick={() => { useApp.getState().setPrefs({ startAtLogin: true }); void desktop.setLoginItem(true).catch(() => {}); }}>Start the app at login</Button>
        </p>
      )}
      {!list.length
        ? (embedded ? <p className="text-[13px] text-hx-muted">Nothing scheduled.</p> : <PageState kind="empty" icon="clock" title="Nothing is scheduled" detail="Ask an agent to check on something later, or make a schedule: a prompt that runs at set times, in a new conversation each time or the same one." action={<Button variant="primary" icon="plus" onClick={() => setEditing('new')}>New schedule</Button>} />)
        : <div className="space-y-2" data-schedule-list>{list.map((s) => <ScheduleItem key={s.id} s={s} onEdit={() => setEditing(s)} reload={reload} />)}</div>}
      {(embedded || list.length > 0) && <div className="flex justify-end"><Button icon="plus" onClick={() => setEditing('new')} data-schedule-new>New schedule</Button></div>}
      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? 'New schedule' : 'Edit schedule'} size="lg">
        {editing !== null && <ScheduleForm edit={editing === 'new' ? undefined : editing} onDone={() => { setEditing(null); reload(); }} />}
      </Modal>
    </div>
  );
}

export function ScheduledPage(): React.ReactElement {
  return <Page data-scheduled title="Scheduled" subtitle="Prompts that run at set times or when called, and what each run came to."><ScheduleManager /></Page>;
}

/** The latest runs of every schedule (Activity). */
export function RecentRuns({ limit = 15 }: { limit?: number }): React.ReactElement | null {
  const { value: runs } = useScheduled(() => client.schedules.allRuns(limit), [limit]);
  if (!runs?.length) return null;
  return (
    <section data-recent-runs className="mt-6">
      <h2 className="mb-2 text-[12px] font-medium uppercase tracking-wide text-hx-muted">Recent scheduled runs</h2>
      <div className="divide-y divide-hx-border-subtle rounded-xl border border-hx-border-subtle">{runs.map((r) => <RunRow key={r.id} run={r} showTitle />)}</div>
    </section>
  );
}
