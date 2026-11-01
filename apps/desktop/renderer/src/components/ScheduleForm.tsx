/**
 * A new schedule, or changes to one: what to do, when (a cron in a time zone, or once), where it runs - a
 * new conversation each time (its model and folder) or always the same conversation - and its limits (the
 * most one run may cost, and whether a run missed while the app was closed runs when it is back).
 * Nobody watches a scheduled run: what needs approval is refused (Don't ask), or waits for the person in their
 * inbox for a while and then gets the safe answer (no).
 */

import React, { useMemo, useState } from 'react';
import type { Schedule } from '@harness/client';
import { Button, Field, Input, Select, Textarea, toast } from '@harness/ui';
import { useData, client } from '../state/data';
import { useApp } from '../state/app';
import { recommendedModel } from '../state/recommend';
import { scratchFolder } from '../bridge';

const SCRATCH = '__scratch__';
const LOCAL_ZONE = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } })();
const ZONES: string[] = (() => { try { return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []; } catch { return []; } })();

export function ScheduleForm({ edit, onDone }: { edit?: Schedule; onDone?: (s: Schedule) => void }): React.ReactElement {
  const models = useData((s) => s.models).filter((m) => m.available);
  const sessions = useData((s) => s.sessions);
  const projects = useApp((x) => x.prefs.projects);
  const defaultModel = useApp((x) => x.prefs.defaultModel);
  const [form, setForm] = useState({
    title: edit?.title ?? '', prompt: edit?.prompt ?? '', cron: edit?.cron ?? '', inMinutes: '',
    timeZone: edit?.timeZone ?? '', misfire: edit?.misfire ?? 'once', maxCostUsd: edit?.maxCostUsd ? String(edit.maxCostUsd) : '',
    target: 'new', sessionId: '', model: '', folder: SCRATCH,
    asks: 'dontAsk', waitHours: edit?.askTimeoutMinutes ? String(edit.askTimeoutMinutes / 60) : '8',
  });
  const [busy, setBusy] = useState(false);
  // What the server refused, shown in the form next to its button (a toast would outlive the form and cover other dialogs).
  const [error, setError] = useState('');
  const zones = useMemo(() => ZONES.map((z) => <option key={z} value={z} />), []);
  const model = form.model || (models.some((m) => m.id === defaultModel) ? defaultModel : recommendedModel(models)?.id ?? models[0]?.id ?? '');
  const trigger = !!edit?.trigger;
  const when = form.cron.trim() ? { cron: form.cron.trim() } : form.inMinutes ? { inMinutes: Number(form.inMinutes) } : undefined;
  const cost = form.maxCostUsd.trim() ? Number(form.maxCostUsd) : undefined;
  const costOk = cost === undefined || (Number.isFinite(cost) && cost > 0);
  const waitMin = Math.round(Number(form.waitHours) * 60);
  const waitOk = Number.isFinite(waitMin) && waitMin >= 1 && waitMin <= 7 * 1440;
  const waits = edit ? !!edit.sessionId || (edit.newSession?.mode ?? 'dontAsk') !== 'dontAsk' : form.target === 'existing' || form.asks !== 'dontAsk';
  const ready = !!form.prompt.trim() && costOk && (!waits || waitOk) && (edit ? true : !!when && (form.target === 'new' ? !!model : !!form.sessionId));
  const limits = { ...(form.cron.trim() && form.timeZone.trim() ? { timeZone: form.timeZone.trim() } : {}), misfire: form.misfire as 'once' | 'skip' };
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      let s: Schedule;
      if (edit) {
        s = await client.schedules.update(edit.id, {
          title: form.title, prompt: form.prompt, ...(trigger ? {} : when ?? {}),
          ...(trigger ? {} : { timeZone: form.cron.trim() && form.timeZone.trim() ? form.timeZone.trim() : null, misfire: limits.misfire }),
          maxCostUsd: cost ?? null, ...(waits ? { askTimeoutMinutes: waitMin } : {}),
        });
        toast('Saved', { kind: 'success' });
      } else {
        if (!when) return;
        const where = form.target === 'new'
          ? { newSession: { model, runtime: 'local' as const, ...(form.folder === SCRATCH ? { path: await scratchFolder() } : { path: form.folder }), mode: form.asks } }
          : { sessionId: form.sessionId };
        s = await client.schedules.create({ title: form.title.trim() || undefined, prompt: form.prompt, ...when, ...where, ...limits, ...(cost ? { maxCostUsd: cost } : {}), ...(waits ? { askTimeoutMinutes: waitMin } : {}) });
        setForm({ ...form, title: '', prompt: '', cron: '', inMinutes: '', maxCostUsd: '' });
        toast('Scheduled', { kind: 'success' });
      }
      onDone?.(s);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div data-schedule-form={edit ? 'edit' : 'new'}>
      <Field label="Title"><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Morning summary" data-schedule-title /></Field>
      <Field label="Prompt"><Textarea rows={3} value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} data-schedule-prompt /></Field>
      {!trigger && (
        <>
          <div className="grid gap-2 md:grid-cols-2">
            <Field label="Cron (five fields)" help="e.g. 0 9 * * 1-5"><Input className="font-mono" value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value, ...(e.target.value ? { inMinutes: '' } : {}) })} data-schedule-cron /></Field>
            <Field label={edit ? 'Or once, in minutes from now' : 'Or once, in minutes'}><Input type="number" min={1} value={form.inMinutes} onChange={(e) => setForm({ ...form, inMinutes: e.target.value, ...(e.target.value ? { cron: '' } : {}) })} data-schedule-minutes /></Field>
          </div>
          {form.cron.trim() && (
            <div className="grid gap-2 md:grid-cols-2">
              <Field label="Time zone" help={`Empty: the app's (${LOCAL_ZONE || 'this computer'})`}><Input list="hx-time-zones" value={form.timeZone} onChange={(e) => setForm({ ...form, timeZone: e.target.value })} placeholder={LOCAL_ZONE} data-schedule-tz /><datalist id="hx-time-zones">{zones}</datalist></Field>
              <Field label="If the app was closed at the time"><Select value={form.misfire} onChange={(v) => setForm({ ...form, misfire: v as 'once' | 'skip' })} options={[{ value: 'once', label: 'Run it once when it is back' }, { value: 'skip', label: 'Skip it' }]} data-schedule-misfire /></Field>
            </div>
          )}
        </>
      )}
      {!edit && (
        <>
          <Field label="Runs in">
            <Select value={form.target} onChange={(v) => setForm({ ...form, target: v })} options={[{ value: 'new', label: 'A new conversation each time' }, { value: 'existing', label: 'The same conversation each time' }]} data-schedule-target />
          </Field>
          {form.target === 'new' ? (
            <div className="grid gap-2 md:grid-cols-2">
              <Field label="Model"><Select value={model} onChange={(v) => setForm({ ...form, model: v })} options={models.map((m) => ({ value: m.id, label: m.label ?? m.id }))} data-schedule-model /></Field>
              <Field label="Folder" help="Its commands and files"><Select value={form.folder} onChange={(v) => setForm({ ...form, folder: v })} options={[{ value: SCRATCH, label: 'A scratch folder' }, ...projects.map((p) => ({ value: p.path, label: p.name }))]} data-schedule-folder /></Field>
            </div>
          ) : (
            <Field label="Conversation">
              <Select value={form.sessionId} onChange={(v) => setForm({ ...form, sessionId: v })} options={[{ value: '', label: 'Choose a conversation…' }, ...sessions.filter((s) => !s.archived).slice(0, 50).map((s) => ({ value: s.id, label: s.title || s.id }))]} data-schedule-session />
            </Field>
          )}
        </>
      )}
      <Field label="Spend limit per run (USD)" help="Empty: no limit of its own (the conversation's and the daily limits still apply)">
        <Input type="number" min={0.01} step={0.01} value={form.maxCostUsd} onChange={(e) => setForm({ ...form, maxCostUsd: e.target.value })} placeholder="e.g. 0.50" data-schedule-cost />
      </Field>
      {!edit && form.target === 'new' && (
        <Field label="When it needs your approval">
          <Select value={form.asks} onChange={(v) => setForm({ ...form, asks: v })} options={[
            { value: 'dontAsk', label: "Refuse it: never stop to ask (Don't ask)" },
            { value: 'acceptEdits', label: 'Ask me in the Inbox; edits in its folder need no approval' },
            { value: 'default', label: 'Ask me in the Inbox for edits and commands' },
          ]} data-schedule-asks />
        </Field>
      )}
      {waits && (
        <Field label="Wait for my answer (hours)" help="Then it gets the safe answer (no) and goes on">
          <Input type="number" min={0.1} step={0.5} value={form.waitHours} onChange={(e) => setForm({ ...form, waitHours: e.target.value })} data-schedule-wait />
        </Field>
      )}
      {error && <p role="alert" className="mb-2 rounded-lg bg-hx-danger/10 px-3 py-2 text-[12.5px] text-hx-danger" data-schedule-error>{error}</p>}
      <div className="flex justify-end"><Button variant="primary" disabled={!ready || busy} onClick={() => void save()} data-schedule-create>{edit ? 'Save' : 'Schedule'}</Button></div>
    </div>
  );
}
