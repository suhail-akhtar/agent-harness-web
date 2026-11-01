/**
 * The schedule dialog: a new schedule (from a template, from what an agent proposed, or blank) or
 * changes to one. What it runs (a prompt or a workflow), when (in plain choices - once, every few
 * minutes, hourly, daily, weekdays, weekly, monthly - or a cron, with the next runs shown before it is
 * made), where (a new conversation each time, its model and folder, or always the same one), and what
 * happens when it needs approval. Limits sit under More options. The footer's button is always in view.
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { Schedule, WatchSpec, WorkflowInfo } from '@harness/client';
import { Button, Field, Icon, Input, Modal, Select, Textarea, cx, toast } from '@harness/ui';
import { useData, client } from '../state/data';
import { useApp } from '../state/app';
import { recommendedModel } from '../state/recommend';
import { scratchFolder } from '../bridge';
import { DAY_SHORT, DEFAULT_WHEN, EVERY_MINUTES, fromTiming, toCron, toOnce, type Freq, type When } from './when';
import { TEMPLATES, type Asks, type ScheduleDraft } from '../builtins/core.scheduled/templates';

const SCRATCH = '__scratch__';
const LOCAL_ZONE = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } })();
const ZONES: string[] = (() => { try { return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []; } catch { return []; } })();

const FREQS: Array<{ id: Freq; label: string }> = [
  { id: 'once', label: 'Once' }, { id: 'minutes', label: 'Every few minutes' }, { id: 'hourly', label: 'Hourly' }, { id: 'daily', label: 'Daily' },
  { id: 'weekdays', label: 'Weekdays' }, { id: 'weekly', label: 'Weekly' }, { id: 'monthly', label: 'Monthly' }, { id: 'custom', label: 'Custom (cron)' },
];
const NOTIFY: Array<{ id: NonNullable<Schedule['notify']>; label: string }> = [{ id: 'always', label: 'Every time' }, { id: 'important', label: 'Only when it matters' }, { id: 'digest', label: 'In my daily digest' }, { id: 'silent', label: 'Don\'t tell me' }];
const NOTIFY_HELP: Record<NonNullable<Schedule['notify']>, string> = {
  always: 'What it finds comes to your Inbox and interrupts you (within your quiet hours and daily most).',
  important: 'Failures, what it tells you and work it offers interrupt you; other results wait quietly in your Inbox.',
  digest: 'Its results wait for your daily digest; failures still interrupt you.',
  silent: 'Its results stay in its run history; failures, messages and offers still reach your Inbox.',
};
const ASKS: Array<{ id: Asks; title: string; detail: string }> = [
  { id: 'dontAsk', title: 'Never stop to ask', detail: 'What needs approval is refused; the run goes on without it.' },
  { id: 'auto', title: 'A checker decides, I answer the rest', detail: 'A checking model approves safe steps; the others wait for you in the Inbox.' },
  { id: 'acceptEdits', title: 'Edits are fine, ask me for commands', detail: 'It may change files in its folder; commands wait for you in the Inbox.' },
  { id: 'default', title: 'Ask me for everything', detail: 'Every edit and command waits for you in the Inbox.' },
];

/** A row of choices, one selected (radio semantics). */
export function Choice<T extends string>({ value, options, onChange, label, name }: { value: T; options: Array<{ id: T; label: string }>; onChange: (v: T) => void; label: string; name: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5" data-choice={name}>
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} data-value={o.id} onClick={() => onChange(o.id)}
          className={cx('h-8 rounded-lg border px-3 text-[12.5px] transition-colors', value === o.id ? 'border-hx-accent bg-hx-accent-soft font-medium text-hx-accent-text' : 'border-hx-border text-hx-secondary hover:bg-hx-hover hover:text-hx-primary')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** When it runs: the plain choices, and what they come to. */
function WhenPicker({ when, set, zone }: { when: When; set: (w: When) => void; zone: string }) {
  const [preview, setPreview] = useState<{ when?: string; next?: number[]; error?: string } | null>(null);
  const cron = toCron(when), once = toOnce(when);
  useEffect(() => {
    let alive = true;
    const body = cron ? { cron, ...(zone ? { timeZone: zone } : {}) } : once;
    if (!body) { setPreview(null); return; }
    const t = setTimeout(() => { client.schedules.preview(body).then((p) => alive && setPreview(p)).catch(() => alive && setPreview(null)); }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [cron, JSON.stringify(once), zone]);
  const timeField = (label = 'At') => <Field label={label}><Input type="time" value={when.time} onChange={(e) => set({ ...when, time: e.target.value })} data-when-time /></Field>;
  return (
    <div data-when-picker>
      <Choice name="freq" label="How often" value={when.freq} options={FREQS} onChange={(freq) => set({ ...when, freq })} />
      <div className="mt-3 grid gap-x-3 gap-y-1 md:grid-cols-2">
        {when.freq === 'once' && (
          <>
            <Field label="When">
              <Select value={when.onceMode} onChange={(v) => set({ ...when, onceMode: v as 'in' | 'at' })} options={[{ value: 'in', label: 'In a while' }, { value: 'at', label: 'At a date and time' }]} data-when-once />
            </Field>
            {when.onceMode === 'in' ? (
              <div className="grid grid-cols-[1fr_1.2fr] gap-2">
                <Field label="In"><Input type="number" min={1} value={String(when.inAmount)} onChange={(e) => set({ ...when, inAmount: Number(e.target.value) })} data-when-in /></Field>
                <Field label={" "}><Select value={when.inUnit} onChange={(v) => set({ ...when, inUnit: v as When['inUnit'] })} options={[{ value: 'minutes', label: 'minutes' }, { value: 'hours', label: 'hours' }, { value: 'days', label: 'days' }]} data-when-unit /></Field>
              </div>
            ) : <Field label="Date and time"><Input type="datetime-local" value={when.at} onChange={(e) => set({ ...when, at: e.target.value })} data-when-at /></Field>}
          </>
        )}
        {when.freq === 'minutes' && <Field label="Every"><Select value={String(when.every)} onChange={(v) => set({ ...when, every: Number(v) })} options={EVERY_MINUTES.map((n) => ({ value: String(n), label: `${n} minutes` }))} data-when-every /></Field>}
        {when.freq === 'hourly' && <Field label="At minute"><Input type="number" min={0} max={59} value={String(when.minute)} onChange={(e) => set({ ...when, minute: Number(e.target.value) })} data-when-minute /></Field>}
        {(when.freq === 'daily' || when.freq === 'weekdays') && timeField()}
        {when.freq === 'weekly' && (
          <>
            <Field label="On">
              <div className="flex flex-wrap gap-1" role="group" aria-label="Days" data-when-days>
                {[1, 2, 3, 4, 5, 6, 0].map((d) => {
                  const on = when.days.includes(d);
                  return <button key={d} type="button" aria-pressed={on} data-day={d} onClick={() => set({ ...when, days: on ? when.days.filter((x) => x !== d) : [...when.days, d] })} className={cx('h-8 w-11 rounded-lg border text-[12px]', on ? 'border-hx-accent bg-hx-accent-soft font-medium text-hx-accent-text' : 'border-hx-border text-hx-secondary hover:bg-hx-hover')}>{DAY_SHORT[d]}</button>;
                })}
              </div>
            </Field>
            {timeField()}
          </>
        )}
        {when.freq === 'monthly' && (
          <>
            <Field label="On day"><Select value={String(when.dom)} onChange={(v) => set({ ...when, dom: Number(v) })} options={Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))} data-when-dom /></Field>
            {timeField()}
          </>
        )}
        {when.freq === 'custom' && <Field label="Cron (five fields)" help="minute hour day-of-month month day-of-week, e.g. 0 9 * * 1-5"><Input className="font-mono" value={when.cron} onChange={(e) => set({ ...when, cron: e.target.value })} placeholder="0 9 * * 1-5" data-schedule-cron /></Field>}
      </div>
      <div className={cx('mt-1 flex items-start gap-2 rounded-lg px-3 py-2 text-[12.5px]', preview?.error ? 'bg-hx-danger/10 text-hx-danger' : 'bg-hx-hover text-hx-secondary')} data-when-preview aria-live="polite">
        <Icon name={preview?.error ? 'alert' : 'calendar'} size={14} className="mt-0.5 shrink-0" />
        <span>
          {preview?.error ? preview.error : preview?.when ? (
            <>
              <b className="font-medium text-hx-primary" data-when-words>{/^Once, /.test(preview.when) && preview.next?.[0] ? `Once, ${new Date(preview.next[0]).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : preview.when}</b>
              {preview.next?.length && !/^Once, /.test(preview.when) ? <> · next {preview.next.map((t) => new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })).join(', ')}</> : null}
            </>
          ) : 'Pick when it runs.'}
        </span>
      </div>
    </div>
  );
}

/** A watch as the dialog edits it (paths as one line). */
interface WatchDraft { kind: WatchSpec['kind']; command: string; paths: string; branch: string; url: string; match: string; everyMinutes: number; settleSeconds: number; onlyWhen: string }
const WATCH_DEFAULT: WatchDraft = { kind: 'files', command: '', paths: '', branch: '', url: '', match: '', everyMinutes: 5, settleSeconds: 0, onlyWhen: '' };
const KINDS: Array<{ id: WatchSpec['kind']; label: string }> = [{ id: 'files', label: 'Files in the folder' }, { id: 'command', label: "A command's output" }, { id: 'git', label: 'New commits' }, { id: 'url', label: 'A web page or API' }];
const toDraft = (w?: WatchSpec): WatchDraft => (w ? { ...WATCH_DEFAULT, kind: w.kind, everyMinutes: w.everyMinutes ?? 5, command: w.command ?? '', paths: (w.paths ?? []).join(', '), branch: w.branch ?? '', url: w.url ?? '', match: w.match ?? '', settleSeconds: w.settleSeconds ?? 0, onlyWhen: w.onlyWhen ?? '' } : WATCH_DEFAULT);

/** The watch a draft makes (undefined: not complete yet). */
function toWatch(d: WatchDraft): WatchSpec | undefined {
  const base = { kind: d.kind, everyMinutes: d.everyMinutes, ...(d.settleSeconds ? { settleSeconds: d.settleSeconds } : {}), ...(d.onlyWhen.trim() ? { onlyWhen: d.onlyWhen.trim() } : {}) };
  if (d.kind === 'command') return d.command.trim() ? { ...base, command: d.command.trim() } : undefined;
  if (d.kind === 'files') { const paths = d.paths.split(',').map((p) => p.trim()).filter(Boolean); return { ...base, ...(paths.length ? { paths } : {}) }; }
  if (d.kind === 'git') return { ...base, ...(d.branch.trim() ? { branch: d.branch.trim() } : {}) };
  return /^https?:\/\//i.test(d.url.trim()) ? { ...base, url: d.url.trim(), ...(d.match.trim() ? { match: d.match.trim() } : {}) } : undefined;
}

const EVERY = [1, 5, 15, 30, 60, 240, 1440].map((n) => ({ value: String(n), label: n === 1 ? 'minute' : n < 60 ? `${n} minutes` : n === 60 ? 'hour' : n === 1440 ? 'day' : `${n / 60} hours` }));
const SETTLE = [{ value: '0', label: 'At the first change' }, { value: '60', label: 'Once quiet for a minute' }, { value: '300', label: 'Once quiet for 5 minutes' }, { value: '900', label: 'Once quiet for 15 minutes' }];

/** What a watch looks at, how often, and when a change runs. */
function WatchPicker({ d, set }: { d: WatchDraft; set: (d: WatchDraft) => void }) {
  const [preview, setPreview] = useState<{ when?: string; error?: string } | null>(null);
  const w = toWatch(d);
  useEffect(() => {
    let alive = true;
    if (!w) { setPreview(null); return; }
    const t = setTimeout(() => { client.schedules.preview({ watch: w }).then((p) => alive && setPreview(p)).catch(() => alive && setPreview(null)); }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [JSON.stringify(w)]);
  return (
    <div data-watch-picker>
      <Choice name="watch-kind" label="What it watches" value={d.kind} options={KINDS} onChange={(kind) => set({ ...d, kind })} />
      <div className="mt-3 grid gap-x-3 gap-y-1 md:grid-cols-2">
        {d.kind === 'command' && <div className="md:col-span-2"><Field label="Command" help="Run in the folder; when its output or exit code changes, it runs"><Input className="font-mono" value={d.command} onChange={(e) => set({ ...d, command: e.target.value })} placeholder="npm test" data-watch-command /></Field></div>}
        {d.kind === 'files' && <div className="md:col-span-2"><Field label="Paths (optional)" help="In the folder, comma-separated: src, docs/*.md. Empty: all of it"><Input value={d.paths} onChange={(e) => set({ ...d, paths: e.target.value })} placeholder="src, docs/*.md" data-watch-paths /></Field></div>}
        {d.kind === 'git' && <Field label="Branch (optional)" help="Empty: the one checked out"><Input value={d.branch} onChange={(e) => set({ ...d, branch: e.target.value })} placeholder="main" data-watch-branch /></Field>}
        {d.kind === 'url' && (
          <>
            <Field label="Address"><Input value={d.url} onChange={(e) => set({ ...d, url: e.target.value })} placeholder="https://status.example.com" data-watch-url /></Field>
            <Field label="Only this part (optional)" help="A regular expression: only what it matches is compared"><Input className="font-mono" value={d.match} onChange={(e) => set({ ...d, match: e.target.value })} placeholder="All systems \w+" data-watch-match /></Field>
          </>
        )}
        <Field label="Check every"><Select value={String(d.everyMinutes)} onChange={(v) => set({ ...d, everyMinutes: Number(v) })} options={EVERY} data-watch-every /></Field>
        <Field label="Run" help="Changes in a row wait until it has been quiet this long"><Select value={String(d.settleSeconds)} onChange={(v) => set({ ...d, settleSeconds: Number(v) })} options={SETTLE} data-watch-settle /></Field>
        <div className="md:col-span-2"><Field label="Only when (optional)" help="A small model with no tools checks each change against this first; a change that does not match costs no run"><Input value={d.onlyWhen} onChange={(e) => set({ ...d, onlyWhen: e.target.value })} placeholder="a test fails" data-watch-only-when /></Field></div>
      </div>
      <div className={cx('mt-1 flex items-start gap-2 rounded-lg px-3 py-2 text-[12.5px]', preview?.error ? 'bg-hx-danger/10 text-hx-danger' : 'bg-hx-hover text-hx-secondary')} data-when-preview aria-live="polite">
        <Icon name={preview?.error ? 'alert' : 'eye'} size={14} className="mt-0.5 shrink-0" />
        <span>{preview?.error ? preview.error : preview?.when ? <><b className="font-medium text-hx-primary" data-when-words>{preview.when}</b> · no model runs until it changes</> : d.kind === 'url' ? 'Give the address.' : d.kind === 'command' ? 'Give the command.' : 'Pick what it watches.'}</span>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="mb-5"><h3 className="mb-2 text-[11.5px] font-semibold uppercase tracking-wide text-hx-muted">{title}</h3>{children}</section>;
}

/** A draft as the dialog's state. */
function initial(edit?: Schedule, draft?: ScheduleDraft) {
  const when: When = edit ? fromTiming({ cron: edit.cron, at: edit.at }) : { ...(draft?.cron ? fromTiming({ cron: draft.cron }) : DEFAULT_WHEN), ...(draft?.when ?? {}) };
  return {
    title: edit?.title ?? draft?.title ?? '', prompt: edit?.workflow ? '' : edit?.prompt ?? draft?.prompt ?? '',
    what: (edit?.workflow ?? draft?.workflow ? 'workflow' : 'prompt') as 'prompt' | 'workflow',
    workflow: edit?.workflow?.name ?? draft?.workflow?.name ?? '', input: { ...(edit?.workflow?.input ?? draft?.workflow?.input ?? {}) } as Record<string, string>,
    when, timeZone: edit?.timeZone ?? draft?.timeZone ?? '', misfire: edit?.misfire ?? 'once',
    trigger: (edit?.watch ?? draft?.watch ? 'change' : 'time') as 'time' | 'change', watch: toDraft(edit?.watch ?? draft?.watch),
    maxCostUsd: edit?.maxCostUsd ? String(edit.maxCostUsd) : draft?.maxCostUsd ? String(draft.maxCostUsd) : '',
    target: 'new', sessionId: '', model: draft?.model ?? '', folder: draft?.folder ?? SCRATCH,
    // A checker approves safe steps and the rest wait for the person: never asking leaves most tasks half done.
    asks: (edit?.newSession?.mode as Asks | undefined) ?? draft?.asks ?? 'auto',
    waitHours: edit?.askTimeoutMinutes ? String(edit.askTimeoutMinutes / 60) : '8',
    notify: (edit?.notify ?? 'always') as NonNullable<Schedule['notify']>,
  };
}

export function ScheduleDialog({ open, edit, draft, onClose, onDone }: { open: boolean; edit?: Schedule; draft?: ScheduleDraft; onClose: () => void; onDone?: (s: Schedule) => void }): React.ReactElement {
  const models = useData((s) => s.models).filter((m) => m.available);
  const sessions = useData((s) => s.sessions);
  const projects = useApp((x) => x.prefs.projects);
  const defaultModel = useApp((x) => x.prefs.defaultModel);
  const [f, setF] = useState(() => initial(edit, draft));
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [workflows, setWorkflows] = useState<WorkflowInfo[] | null>(null);
  // A new draft or schedule: the dialog starts again from it.
  useEffect(() => { if (open) { setF(initial(edit, draft)); setError(''); setMore(!!(edit?.maxCostUsd || edit?.timeZone || edit?.misfire === 'skip')); } }, [open, edit?.id, draft]);
  const folderPath = f.folder === SCRATCH ? undefined : f.folder;
  useEffect(() => { if (open && f.what === 'workflow') client.schedules.workflows(folderPath).then(setWorkflows).catch(() => setWorkflows([])); }, [open, f.what, folderPath]);
  const zones = useMemo(() => ZONES.map((z) => <option key={z} value={z} />), []);
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }));
  const model = (f.model && models.some((m) => m.id === f.model) ? f.model : '') || (models.some((m) => m.id === defaultModel) ? defaultModel : recommendedModel(models)?.id ?? models[0]?.id ?? '');
  const trigger = !!edit?.trigger;
  const watching = f.trigger === 'change';
  const cron = watching ? undefined : toCron(f.when), once = watching ? undefined : toOnce(f.when);
  const watch = watching ? toWatch(f.watch) : undefined;
  const wf = workflows?.find((w) => w.name === f.workflow);
  const cost = f.maxCostUsd.trim() ? Number(f.maxCostUsd) : undefined;
  const waits = edit ? !!edit.sessionId || (edit.newSession?.mode ?? 'dontAsk') !== 'dontAsk' : f.target === 'existing' || f.asks !== 'dontAsk';
  const waitMin = Math.round(Number(f.waitHours) * 60);
  const missing = [
    f.what === 'prompt' && !f.prompt.trim() && 'what it should do',
    f.what === 'workflow' && !f.workflow && 'a workflow',
    f.what === 'workflow' && wf && Object.entries(wf.inputs).some(([k, v]) => v.required && !f.input[k]?.trim()) && 'the workflow\'s inputs',
    !trigger && !watching && !cron && !once && 'when it runs',
    watching && !watch && (f.watch.kind === 'url' ? 'an http(s) address' : 'the command'),
    !edit && f.target === 'new' && !model && 'a model',
    !edit && f.target === 'existing' && !f.sessionId && 'a conversation',
    cost !== undefined && !(cost > 0) && 'a spend limit above 0',
    waits && !(waitMin >= 1 && waitMin <= 10080) && 'a wait of up to a week',
  ].filter(Boolean) as string[];
  const save = async () => {
    setBusy(true); setError('');
    try {
      const timing = trigger ? {} : watching ? { watch: watch! } : cron ? { cron, timeZone: f.timeZone.trim() || undefined } : once!;
      const workflow = f.what === 'workflow' ? { workflow: { name: f.workflow, input: Object.fromEntries(Object.entries(f.input).filter(([, v]) => v.trim())) } } : {};
      let s: Schedule;
      if (edit) {
        s = await client.schedules.update(edit.id, {
          title: f.title, ...(f.what === 'prompt' ? { prompt: f.prompt } : {}), ...workflow, ...timing,
          ...(trigger || watching ? {} : { timeZone: cron && f.timeZone.trim() ? f.timeZone.trim() : null, misfire: f.misfire as 'once' | 'skip' }),
          maxCostUsd: cost ?? null, ...(waits ? { askTimeoutMinutes: waitMin } : {}), notify: f.notify,
        });
        toast('Saved', { kind: 'success' });
      } else {
        const where = f.target === 'new'
          ? { newSession: { model, runtime: 'local' as const, path: folderPath ?? await scratchFolder(), mode: f.asks } }
          : { sessionId: f.sessionId };
        s = await client.schedules.create({
          title: f.title.trim() || undefined, prompt: f.what === 'prompt' ? f.prompt : '', ...workflow, ...timing, ...where,
          misfire: f.misfire as 'once' | 'skip', ...(cost ? { maxCostUsd: cost } : {}), ...(waits ? { askTimeoutMinutes: waitMin } : {}), notify: f.notify,
        });
        toast(`Scheduled: ${s.when ?? s.title}`, { kind: 'success' });
      }
      onDone?.(s);
      onClose();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const footer = (
    <>
      {missing.length > 0 && <span className="mr-auto text-[12px] text-hx-muted" data-schedule-missing>Still needed: {missing.join(', ')}</span>}
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={missing.length > 0 || busy} onClick={() => void save()} data-schedule-create>{edit ? 'Save' : 'Schedule it'}</Button>
    </>
  );
  return (
    <Modal open={open} onClose={onClose} title={edit ? `Edit "${edit.title}"` : 'New schedule'} size="lg" footer={footer}>
      <div data-schedule-form={edit ? 'edit' : 'new'}>
        {!edit && (
          <div className="mb-5" data-schedule-templates>
            <div className="mb-2 text-[12px] text-hx-muted">Start from</div>
            <div className="grid gap-2 sm:grid-cols-2">
              {TEMPLATES.map((t) => (
                <button key={t.id} type="button" data-template={t.id} onClick={() => setF({ ...initial(undefined, t.draft), folder: f.folder, model: f.model })}
                  className="flex items-start gap-2.5 rounded-xl border border-hx-border-subtle px-3 py-2.5 text-left hover:border-hx-border hover:bg-hx-hover">
                  <Icon name={t.icon} size={16} className="mt-0.5 shrink-0 text-hx-accent-text" />
                  <span className="min-w-0"><span className="block text-[13px] font-medium">{t.title}</span><span className="block text-[12px] text-hx-muted">{t.blurb}</span></span>
                </button>
              ))}
            </div>
          </div>
        )}

        <Section title="What it does">
          {!trigger && <div className="mb-2"><Choice name="what" label="What it runs" value={f.what} options={[{ id: 'prompt', label: 'A prompt' }, { id: 'workflow', label: 'A workflow' }]} onChange={(what) => set({ what })} /></div>}
          <Field label="Title"><Input value={f.title} onChange={(e) => set({ title: e.target.value })} placeholder="Morning briefing" data-schedule-title /></Field>
          {f.what === 'prompt' ? (
            <Field label="Prompt" help="A complete instruction, as you would type it then. Nobody is watching when it runs.">
              <Textarea rows={4} value={f.prompt} onChange={(e) => set({ prompt: e.target.value })} placeholder="Look through this folder and tell me what changed since yesterday…" data-schedule-prompt />
            </Field>
          ) : (
            <>
              <Field label="Workflow" help={wf?.description}>
                <Select value={f.workflow} onChange={(v) => set({ workflow: v })} options={[{ value: '', label: workflows === null ? 'Loading…' : workflows.length ? 'Choose a workflow…' : 'No workflows here' }, ...(workflows ?? []).map((w) => ({ value: w.name, label: w.name }))]} data-schedule-workflow />
              </Field>
              {wf && Object.entries(wf.inputs).map(([k, v]) => (
                <Field key={k} label={`${k}${v.required ? '' : ' (optional)'}`} help={v.description}><Input value={f.input[k] ?? v.default ?? ''} onChange={(e) => set({ input: { ...f.input, [k]: e.target.value } })} data-workflow-input={k} /></Field>
              ))}
            </>
          )}
        </Section>

        {!trigger && (
          <Section title="When">
            {!edit && <div className="mb-3"><Choice name="trigger" label="When it runs" value={f.trigger} options={[{ id: 'time', label: 'At set times' }, { id: 'change', label: 'When something changes' }]} onChange={(trigger) => set({ trigger })} /></div>}
            {watching ? <WatchPicker d={f.watch} set={(w) => set({ watch: w })} /> : <WhenPicker when={f.when} set={(when) => set({ when })} zone={f.timeZone.trim()} />}
          </Section>
        )}

        {!edit && (
          <Section title="Where">
            <Choice name="target" label="Runs in" value={f.target as 'new' | 'existing'} options={[{ id: 'new', label: 'A new conversation each time' }, { id: 'existing', label: 'The same conversation each time' }]} onChange={(target) => set({ target })} />
            <div className="mt-3">
              {f.target === 'new' ? (
                <div className="grid gap-x-3 md:grid-cols-2">
                  <Field label="Folder" help="Its files and commands"><Select value={f.folder} onChange={(v) => set({ folder: v })} options={[{ value: SCRATCH, label: 'A scratch folder' }, ...projects.map((p) => ({ value: p.path, label: p.name })), ...(f.folder !== SCRATCH && !projects.some((p) => p.path === f.folder) ? [{ value: f.folder, label: f.folder }] : [])]} data-schedule-folder /></Field>
                  <Field label="Model"><Select value={model} onChange={(v) => set({ model: v })} options={models.map((m) => ({ value: m.id, label: m.label ?? m.id }))} data-schedule-model /></Field>
                </div>
              ) : (
                <Field label="Conversation">
                  <Select value={f.sessionId} onChange={(v) => set({ sessionId: v })} options={[{ value: '', label: 'Choose a conversation…' }, ...sessions.filter((s) => !s.archived).slice(0, 50).map((s) => ({ value: s.id, label: s.title || s.id }))]} data-schedule-session />
                </Field>
              )}
            </div>
          </Section>
        )}

        {!edit && f.target === 'new' && (
          <Section title="When it needs your approval">
            <div role="radiogroup" aria-label="When it needs your approval" className="grid gap-2 sm:grid-cols-2" data-schedule-asks>
              {ASKS.map((a) => (
                <button key={a.id} type="button" role="radio" aria-checked={f.asks === a.id} data-value={a.id} onClick={() => set({ asks: a.id })}
                  className={cx('rounded-xl border px-3 py-2.5 text-left', f.asks === a.id ? 'border-hx-accent bg-hx-accent-soft' : 'border-hx-border-subtle hover:bg-hx-hover')}>
                  <span className={cx('block text-[13px] font-medium', f.asks === a.id && 'text-hx-accent-text')}>{a.title}</span>
                  <span className="block text-[12px] text-hx-muted">{a.detail}</span>
                </button>
              ))}
            </div>
          </Section>
        )}
        {waits && (
          <div className="-mt-2 mb-5 flex items-center gap-2 text-[12.5px] text-hx-secondary" data-schedule-wait-row>
            Wait for my answer up to <Input type="number" min={0.1} step={0.5} className="w-20" value={f.waitHours} onChange={(e) => set({ waitHours: e.target.value })} data-schedule-wait /> hours, then refuse and go on.
          </div>
        )}

        <Section title="Tell me">
          <Choice name="notify" label="Tell me" value={f.notify} options={NOTIFY} onChange={(notify) => set({ notify })} />
          <p className="mt-1.5 text-[12px] text-hx-muted" data-notify-help>{NOTIFY_HELP[f.notify]}</p>
        </Section>

        <button type="button" className="mb-2 inline-flex items-center gap-1 text-[12.5px] text-hx-secondary hover:text-hx-primary" onClick={() => setMore(!more)} aria-expanded={more} data-schedule-more>
          <Icon name={more ? 'chevron-down' : 'chevron-right'} size={13} />More options
        </button>
        {more && (
          <div className="grid gap-x-3 md:grid-cols-2" data-schedule-options>
            <Field label="Spend limit per run (USD)" help="Empty: the conversation's and the daily limits apply"><Input type="number" min={0.01} step={0.01} value={f.maxCostUsd} onChange={(e) => set({ maxCostUsd: e.target.value })} placeholder="e.g. 0.50" data-schedule-cost /></Field>
            {!trigger && cron && <Field label="Time zone" help={`Empty: the app's (${LOCAL_ZONE || 'this computer'})`}><Input list="hx-time-zones" value={f.timeZone} onChange={(e) => set({ timeZone: e.target.value })} placeholder={LOCAL_ZONE} data-schedule-tz /><datalist id="hx-time-zones">{zones}</datalist></Field>}
            {!trigger && cron && <Field label="If the app was closed at the time"><Select value={f.misfire} onChange={(v) => set({ misfire: v as 'once' | 'skip' })} options={[{ value: 'once', label: 'Run it once when it is back' }, { value: 'skip', label: 'Skip it' }]} data-schedule-misfire /></Field>}
          </div>
        )}
        {error && <p role="alert" className="mt-2 rounded-lg bg-hx-danger/10 px-3 py-2 text-[12.5px] text-hx-danger" data-schedule-error>{error}</p>}
      </div>
    </Modal>
  );
}
