/**
 * A new schedule: what to do, when, and where it runs - a new conversation each time (with its model and
 * folder) or always the same conversation. Scheduled conversations run without anyone watching, so they never
 * wait on a question (Don't ask).
 */

import React, { useState } from 'react';
import type { Schedule } from '@harness/client';
import { Button, Field, Input, Select, Textarea, toast } from '@harness/ui';
import { useData, client } from '../state/data';
import { useApp } from '../state/app';
import { recommendedModel } from '../state/recommend';
import { scratchFolder } from '../bridge';

const SCRATCH = '__scratch__';

export function ScheduleForm({ onCreated }: { onCreated?: (s: Schedule) => void }): React.ReactElement {
  const models = useData((s) => s.models).filter((m) => m.available);
  const sessions = useData((s) => s.sessions);
  const projects = useApp((x) => x.prefs.projects);
  const defaultModel = useApp((x) => x.prefs.defaultModel);
  const [form, setForm] = useState({ title: '', prompt: '', cron: '', inMinutes: '', target: 'new', sessionId: '', model: '', folder: SCRATCH });
  const [busy, setBusy] = useState(false);
  const model = form.model || (models.some((m) => m.id === defaultModel) ? defaultModel : recommendedModel(models)?.id ?? models[0]?.id ?? '');
  const when = form.cron.trim() ? { cron: form.cron.trim() } : form.inMinutes ? { inMinutes: Number(form.inMinutes) } : undefined;
  const ready = !!form.prompt.trim() && !!when && (form.target === 'new' ? !!model : !!form.sessionId);
  const create = async () => {
    if (!when) return;
    setBusy(true);
    try {
      const where = form.target === 'new'
        ? { newSession: { model, runtime: 'local' as const, ...(form.folder === SCRATCH ? { path: await scratchFolder() } : { path: form.folder }), mode: 'dontAsk' as const } }
        : { sessionId: form.sessionId };
      const s = await client.schedules.create({ title: form.title.trim() || undefined, prompt: form.prompt, ...when, ...where });
      setForm({ ...form, title: '', prompt: '', cron: '', inMinutes: '' });
      toast('Scheduled', { kind: 'success' });
      onCreated?.(s);
    } catch (e) { toast((e as Error).message, { kind: 'error' }); } finally { setBusy(false); }
  };
  return (
    <div data-schedule-form>
      <Field label="Title"><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Morning summary" /></Field>
      <Field label="Prompt"><Textarea rows={3} value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} data-schedule-prompt /></Field>
      <div className="grid gap-2 md:grid-cols-2">
        <Field label="Cron (five fields)" help="e.g. 0 9 * * 1-5"><Input className="font-mono" value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value, ...(e.target.value ? { inMinutes: '' } : {}) })} data-schedule-cron /></Field>
        <Field label="Or once, in minutes"><Input type="number" min={1} value={form.inMinutes} onChange={(e) => setForm({ ...form, inMinutes: e.target.value, ...(e.target.value ? { cron: '' } : {}) })} data-schedule-minutes /></Field>
      </div>
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
      <p className="mb-2 text-[12px] text-hx-muted">It runs without anyone watching: it never stops to ask (Don't ask), so anything that would need your approval is refused.</p>
      <div className="flex justify-end"><Button variant="primary" disabled={!ready || busy} onClick={() => void create()} data-schedule-create>Schedule</Button></div>
    </div>
  );
}
