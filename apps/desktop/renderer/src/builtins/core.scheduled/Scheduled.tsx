/**
 * Scheduled work in the window: every schedule and trigger, when it runs next, what its last run came to,
 * and each run's record (how it ended, how long it took, what it cost, what it said, its conversation).
 * New, Edit, Run now, on/off and Delete. The same list is the Settings > Schedules section, and the run
 * rows are Activity's "Recent runs".
 */

import React, { useEffect, useState } from 'react';
import type { Schedule, ScheduleRun } from '@harness/client';
import { duration, isMissing } from '@harness/client';
import { create } from 'zustand';
import { Badge, Button, ConfirmDialog, Icon, IconButton, InfoNote, Menu, Page, Spinner, Switch, Tooltip, cx, toast } from '@harness/ui';
import { useData, client } from '../../state/data';
import { navigate, openSession, prefill, useApp } from '../../state/app';
import { money } from '../../components/CostByModel';
import { ScheduleDialog } from '../../components/ScheduleDialog';
import { TEMPLATES, type ScheduleDraft } from './templates';
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
          {!!run.waited && <span data-run-waited>· asked you {run.waited === 1 ? 'once' : `${run.waited} times`}</span>}
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

/** "in 3 h", "in 12 min", "tomorrow 09:00", or the date. */
export function relative(t: number, now = Date.now()): string {
  const d = t - now;
  const clock = new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d < 0) return 'now';
  if (d < 60 * 60_000) return `in ${Math.max(1, Math.round(d / 60_000))} min`;
  if (d < 12 * 3600_000) return `in ${Math.round(d / 3600_000)} h`;
  const day = new Date(t).toDateString(), today = new Date(now).toDateString(), tomorrow = new Date(now + 86_400_000).toDateString();
  if (day === today) return `today ${clock}`;
  if (day === tomorrow) return `tomorrow ${clock}`;
  return new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// The last result as an icon and a word (results start with how the run ended, in either case: "Stopped: ...").
const LAST_ICON = (last: string) => /^completed: nothing/i.test(last) ? { icon: 'check', tone: 'text-hx-muted', label: 'Nothing to report' }
  : /^completed/i.test(last) ? { icon: 'check-circle', tone: 'text-hx-success', label: 'Completed' }
    : /^(started|running)/i.test(last) ? { icon: 'activity', tone: 'text-hx-accent-text', label: 'Running' }
      : /^failed/i.test(last) ? { icon: 'x-circle', tone: 'text-hx-danger', label: 'Failed' }
        : { icon: 'alert', tone: 'text-hx-warning', label: last.split(':')[0]!.replace(/^\w/, (c) => c.toUpperCase()) };

function ScheduleItem({ s, onEdit, reload }: { s: Schedule; onEdit: () => void; reload: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const last = s.lastResult;
  const li = last ? LAST_ICON(last) : undefined;
  const target = s.workflow ? `Workflow ${s.workflow.name}` : s.newSession ? 'A new conversation each time' : 'Into one conversation';
  const asks = s.newSession ? ({ dontAsk: 'never asks', auto: 'a checker decides', acceptEdits: 'asks you for commands', default: 'asks you' } as Record<string, string>)[s.newSession.mode ?? 'dontAsk'] : undefined;
  return (
    <div data-schedule={s.id} className={cx('rounded-xl border bg-hx-elevated', s.enabled ? 'border-hx-border-subtle' : 'border-dashed border-hx-border-subtle opacity-75')}>
      <div className="flex items-start gap-3 px-4 py-3">
        <span className={cx('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', s.enabled ? 'bg-hx-accent-soft text-hx-accent-text' : 'bg-hx-hover text-hx-muted')}><Icon name={s.trigger ? 'link' : s.workflow ? 'workflow' : 'clock'} size={16} /></span>
        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen(!open)} aria-expanded={open} data-schedule-toggle>
          <span className="block truncate text-[14px] font-medium">{s.title || s.prompt}</span>
          <span className="block truncate text-[12.5px] text-hx-secondary" data-schedule-when>{!s.cron && !s.trigger && s.at ? `Once, ${fmt(s.at)}` : s.when ?? timing(s)}</span>
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] text-hx-muted">
            {s.enabled && s.nextRun && !s.trigger ? <span data-schedule-next><Icon name="calendar" size={11} className="mr-1 inline" />Next {relative(s.nextRun)}</span> : !s.enabled ? <span>Off</span> : null}
            <span>{target}</span>
            {asks && <span>{asks}</span>}
            {s.maxCostUsd ? <span>at most {money(s.maxCostUsd)} a run</span> : null}
            {li && <span className={cx('inline-flex items-center gap-1', li.tone)} data-schedule-last title={last}><Icon name={li.icon} size={11} />{li.label}{s.lastRun ? ` ${relative(s.lastRun) === 'now' ? new Date(s.lastRun).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : ''}` : ''}</span>}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip label={s.enabled ? 'On: runs at its times' : 'Off: does not run'}><span><Switch checked={s.enabled} onChange={(v) => void client.schedules.setEnabled(s.id, v).then(reload).catch(fail)} label="Enabled" /></span></Tooltip>
          <Button size="sm" variant="ghost" icon="play" onClick={() => void client.schedules.run(s.id).then(() => { setOpen(true); reload(); }).catch(fail)} aria-label="Run now">Run now</Button>
          <Menu placement="bottom-end" items={[
            { id: 'edit', label: 'Edit', icon: 'edit', onSelect: onEdit },
            { id: 'open', label: 'Show its runs', icon: 'history', onSelect: () => setOpen(true) },
            { id: 'delete', label: 'Delete', icon: 'trash', danger: true, onSelect: () => setConfirm(true) },
          ]} trigger={({ ref, toggle }) => <IconButton ref={ref} size="sm" icon="more" label="More" onClick={toggle} data-schedule-menu />} />
        </div>
      </div>
      {last && /^(failed|stopped|interrupted|skipped)/i.test(last) && <div className="mx-4 mb-3 rounded-lg bg-hx-hover px-3 py-1.5 text-[12px] text-hx-secondary" data-schedule-last-reason>{last}</div>}
      {open && <div className="border-t border-hx-border-subtle"><Runs id={s.id} /></div>}
      <ConfirmDialog open={confirm} title={`Delete "${s.title}"?`} body="It stops running, and its run history goes with it. The conversations it made stay." confirmLabel="Delete" danger onAnswer={(yes) => { setConfirm(false); if (yes) void client.schedules.remove(s.id).then(reload).catch(fail); }} />
    </div>
  );
}

/** Opens the schedule dialog from anywhere (a command, an agent's proposal), on the Scheduled page. */
export const useScheduleDialog = create<{ draft: ScheduleDraft | null; open: (d?: ScheduleDraft) => void; close: () => void }>((set) => ({
  draft: null,
  open: (d) => { set({ draft: d ?? {} }); navigate({ view: 'core.scheduled:scheduled' }); },
  close: () => set({ draft: null }),
}));

const ASK_AGENT = 'Set up a schedule for me: ';

/** Every schedule and trigger of the person's, with New, Edit and their runs. */
export function ScheduleManager({ embedded }: { embedded?: boolean }): React.ReactElement {
  const { value: list, error, reload } = useScheduled(() => client.schedules.list());
  const keepInTray = useApp((x) => x.prefs.keepInTray);
  const startAtLogin = useApp((x) => x.prefs.startAtLogin);
  const draft = useScheduleDialog((x) => x.draft);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const openNew = (d?: ScheduleDraft) => useScheduleDialog.setState({ draft: d ?? {} });
  if (error) return <InfoNote>{error}</InfoNote>;
  if (!list) return <Spinner />;
  const active = list.some((s) => s.enabled && !s.trigger);
  return (
    <div data-schedule-manager className="space-y-3">
      {active && !keepInTray && (
        <InfoNote>
          <span data-schedules-tray-note>Schedules run only while this app is open. Closing the window quits it unless it keeps running in the tray.</span>{' '}
          <Button size="sm" onClick={() => useApp.getState().setPrefs({ keepInTray: true })}>Keep running in the tray</Button>
        </InfoNote>
      )}
      {active && keepInTray && !startAtLogin && (
        <p className="flex flex-wrap items-center gap-2 text-[12px] text-hx-muted" data-schedules-login-note>
          They also stop when this computer restarts, until the app is opened again.
          <Button size="sm" variant="ghost" onClick={() => { useApp.getState().setPrefs({ startAtLogin: true }); void desktop.setLoginItem(true).catch(() => {}); }}>Start the app at login</Button>
        </p>
      )}
      {!list.length ? (
        embedded ? <p className="text-[13px] text-hx-muted">Nothing scheduled.</p> : (
          <div className="rounded-2xl border border-hx-border-subtle p-6" data-schedules-empty>
            <div className="mb-1 text-[15px] font-semibold">Let agents work while you are away</div>
            <p className="mb-4 text-[13px] text-hx-secondary">A schedule runs a prompt or a workflow at set times, in a new conversation each time or the same one. What it finds comes to your Inbox; what needs your approval waits there.</p>
            <div className="mb-4 grid gap-2 sm:grid-cols-2">
              {TEMPLATES.map((t) => (
                <button key={t.id} type="button" data-empty-template={t.id} onClick={() => openNew(t.draft)} className="flex items-start gap-2.5 rounded-xl border border-hx-border-subtle px-3 py-2.5 text-left hover:border-hx-border hover:bg-hx-hover">
                  <Icon name={t.icon} size={16} className="mt-0.5 shrink-0 text-hx-accent-text" />
                  <span><span className="block text-[13px] font-medium">{t.title}</span><span className="block text-[12px] text-hx-muted">{t.blurb}</span></span>
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" icon="plus" onClick={() => openNew()} data-schedule-new>New schedule</Button>
              <Button icon="sparkles" onClick={() => prefill(ASK_AGENT, true)} data-schedule-ask-agent>Ask an agent to set it up</Button>
            </div>
          </div>
        )
      ) : <div className="space-y-2" data-schedule-list>{list.map((s) => <ScheduleItem key={s.id} s={s} onEdit={() => setEditing(s)} reload={reload} />)}</div>}
      {(embedded || list.length > 0) && (
        <div className="flex justify-end gap-2">
          {!embedded && <Button icon="sparkles" variant="ghost" onClick={() => prefill(ASK_AGENT, true)} data-schedule-ask-agent>Ask an agent to set it up</Button>}
          <Button icon="plus" onClick={() => openNew()} data-schedule-new>New schedule</Button>
        </div>
      )}
      <ScheduleDialog open={draft !== null || editing !== null} edit={editing ?? undefined} draft={draft ?? undefined} onClose={() => { setEditing(null); useScheduleDialog.getState().close(); }} onDone={() => reload()} />
    </div>
  );
}

export function ScheduledPage(): React.ReactElement {
  return <Page data-scheduled title="Scheduled" subtitle="Prompts and workflows that run at set times or when called, and what each run came to."><ScheduleManager /></Page>;
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
