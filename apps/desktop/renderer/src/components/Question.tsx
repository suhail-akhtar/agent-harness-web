/**
 * A question from the agent (ask_user): its suggested answers (what each does, the recommended one first), a
 * form when the answer has several parts, the person's own words (a note with the answer, or a reply
 * instead), a review of what will be sent, and skipping it (the agent then decides and says what it assumed).
 * Its actions sit in the panel's footer, always in view however long the form is.
 */

import React, { useMemo, useState } from 'react';
import type { PendingRequest } from '@harness/client';
import type { JsonSchema } from '@harness/plugin-ui';
import { ActionPanel, Badge, Button, Icon, Markdown, SchemaForm, Textarea, cx, fieldsOf, labelOf, optionLabels, validate, withDefaults } from '@harness/ui';
import { desktop } from '../bridge';
import type { Respond } from './Pending';

type Question = Extract<PendingRequest, { kind: 'question' }>;
type Choice = { label: string; description?: string; recommended?: boolean };

/** What a field's value reads as in the review: labels for choices, Yes/No, lists joined. */
function shown(s: JsonSchema, v: unknown): string {
  if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.map((x) => shown(s.items ?? {}, x)).join(', ');
  if (s.enum) return optionLabels(s).find((o) => o.value === String(v))?.label ?? String(v);
  if (typeof v === 'object') return fieldsOf(s).map(([k, sub]) => `${labelOf(k, sub)}: ${shown(sub, (v as Record<string, unknown>)[k])}`).join('; ');
  return String(v);
}

export function QuestionCard({ p, respond }: { p: Question; respond: Respond }): React.ReactElement {
  const schema = p.form && typeof p.form === 'object' ? (p.form as unknown as JsonSchema) : undefined;
  const choices: Choice[] = p.choices?.length ? p.choices : p.options.map((label) => ({ label }));
  const [value, setValue] = useState<Record<string, unknown>>(() => (schema ? (withDefaults(schema, {}) as Record<string, unknown>) ?? {} : {}));
  const [words, setWords] = useState('');
  const [tried, setTried] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const errors = useMemo(() => (schema ? validate(schema, value) : {}), [schema, value]);
  const problems = Object.keys(errors);
  const go = (b: Parameters<Respond>[0]) => { setBusy(true); void respond(b).finally(() => setBusy(false)); };
  const note = words.trim();
  // Empty optional fields are left out (the form refuses unknown fields, never missing optional ones).
  const clean = () => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== '' && v !== undefined && v !== null));
  const sendForm = () => {
    setTried(true);
    if (problems.length) { setReviewing(false); return; }
    go({ requestId: p.requestId, decision: 'answer', answer: clean(), ...(note ? { feedback: note } : {}) });
  };
  const pick = (c: Choice) => (schema
    // With a form, a suggestion answers the whole question in words.
    ? go({ requestId: p.requestId, decision: 'reply', feedback: note ? `${c.label}. ${note}` : c.label })
    : go({ requestId: p.requestId, decision: 'answer', answer: c.label, ...(note ? { feedback: note } : {}) }));
  const ownWords = () => (schema
    ? go({ requestId: p.requestId, decision: 'reply', feedback: note })
    : go({ requestId: p.requestId, decision: 'answer', answer: note }));
  const skip = () => go({ requestId: p.requestId, decision: 'deny', ...(note ? { feedback: note } : {}) });
  const described = choices.some((c) => c.description);

  const footer = (
    <div className="flex flex-wrap items-center gap-2" data-question-actions>
      <Button size="sm" variant="ghost" icon="x" disabled={busy} data-skip-question onClick={skip} title="The agent decides on its own and says what it assumed">Skip question</Button>
      <span className={cx('min-w-0 flex-1 truncate text-[11.5px] text-hx-muted', note && schema && !reviewing ? 'invisible' : 'hidden sm:block')}>
        {schema ? (reviewing ? 'Check your answers, then send them.' : 'Pick a suggestion, fill in the form, or write your own answer.') : 'Pick an answer, or write your own.'}
      </span>
      <span className="flex-1 sm:hidden" />
      {schema ? (
        <>
          {note && !reviewing && <Button size="sm" disabled={busy} data-reply-instead onClick={ownWords} title="Send only what you wrote, instead of the form">Send my words only</Button>}
          {reviewing
            ? <Button size="sm" variant="ghost" icon="edit" disabled={busy} onClick={() => setReviewing(false)}>Edit</Button>
            : <Button size="sm" variant="ghost" icon="eye" disabled={busy} data-review-answers onClick={() => { setTried(true); if (!problems.length) setReviewing(true); }}>Review</Button>}
          <Button size="sm" variant="primary" icon="check" disabled={busy} data-submit-form onClick={sendForm}>{busy ? 'Sending…' : 'Send answers'}</Button>
        </>
      ) : (
        <Button size="sm" variant="primary" icon="check" disabled={busy || !note} data-answer-own onClick={ownWords} title={note ? '' : 'Write an answer first'}>{busy ? 'Sending…' : 'Send answer'}</Button>
      )}
    </div>
  );

  return (
    <ActionPanel data-pending="question" data-request={p.requestId} data-question-form={schema ? '' : undefined} label={p.agent ? `Question from ${p.agent}` : 'Question'} icon="help" tone="accent" footer={footer}>
      <div data-question={p.requestId}>
        <div className="text-[14px] font-semibold leading-snug text-hx-primary [&_p]:my-0"><Markdown text={p.question} /></div>
        {schema?.description && <p className="mt-1 text-[12.5px] text-hx-secondary">{schema.description}</p>}

        {choices.length > 0 && !reviewing && (
          <div className="mt-2.5" data-question-choices>
            {schema && <div className="mb-1 text-[11.5px] font-medium uppercase tracking-wide text-hx-muted">Quick answers</div>}
            <div className={cx(described ? 'grid gap-1.5 sm:grid-cols-2' : 'flex flex-wrap gap-2')}>
              {choices.map((c) => described ? (
                <button key={c.label} type="button" disabled={busy} data-choice={c.label} onClick={() => pick(c)}
                  className={cx('group flex flex-col items-start rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-60', c.recommended ? 'border-hx-accent/50 bg-hx-accent-soft/50 hover:bg-hx-accent-soft' : 'border-hx-border-subtle hover:border-hx-accent/40 hover:bg-hx-hover')}>
                  <span className="flex items-center gap-1.5 text-[13px] font-medium text-hx-primary">{c.label}{c.recommended && <Badge tone="accent">Recommended</Badge>}</span>
                  {c.description && <span className="mt-0.5 text-[12px] leading-snug text-hx-secondary">{c.description}</span>}
                </button>
              ) : (
                <Button key={c.label} size="sm" variant={c.recommended ? 'primary' : 'secondary'} disabled={busy} data-choice={c.label} onClick={() => pick(c)}>{c.label}</Button>
              ))}
            </div>
          </div>
        )}

        {schema && !reviewing && (
          <div className="mt-3">
            {tried && problems.length > 0 && (
              <div role="alert" className="mb-2 flex items-start gap-1.5 rounded-lg bg-hx-danger/10 px-2.5 py-1.5 text-[12.5px] text-hx-danger" data-form-problems>
                <Icon name="alert" size={14} className="mt-0.5 shrink-0" />
                <span>{problems.length === 1 ? 'One field needs' : `${problems.length} fields need`} attention: {problems.map((k) => labelOf(k.split('.').pop()!.replace(/\[\d+\]$/, ''), schema.properties?.[k.split('.')[0]!.replace(/\[\d+\]$/, '')] ?? {})).join(', ')}.</span>
              </div>
            )}
            <div className="rounded-lg border border-hx-border-subtle bg-hx-bg px-3"><SchemaForm schema={schema} value={value} onChange={setValue} showAllErrors={tried} pickPath={() => desktop.openFolder()} idPrefix={`q-${p.requestId.slice(0, 8)}`} /></div>
          </div>
        )}

        {schema && reviewing && (
          <dl className="mt-3 divide-y divide-hx-border-subtle rounded-lg border border-hx-border-subtle bg-hx-bg px-3 text-[13px]" data-answer-review>
            {fieldsOf(schema).map(([k, sub]) => (
              <div key={k} className="flex gap-3 py-1.5"><dt className="w-2/5 shrink-0 text-hx-muted">{labelOf(k, sub)}</dt><dd className="min-w-0 flex-1 break-words text-hx-primary">{shown(sub, value[k])}</dd></div>
            ))}
            {note && <div className="flex gap-3 py-1.5"><dt className="w-2/5 shrink-0 text-hx-muted">Your note</dt><dd className="min-w-0 flex-1 whitespace-pre-wrap text-hx-primary">{note}</dd></div>}
          </dl>
        )}

        {!reviewing && (
          <div className="mt-3">
            <Textarea rows={2} value={words} disabled={busy} data-own-words onChange={(e) => setWords(e.target.value)}
              placeholder={schema ? 'Add a note to your answers, or answer in your own words (Ctrl+Enter sends)' : 'Or write your own answer (Ctrl+Enter sends)'}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (schema) sendForm(); else if (note) ownWords(); } }} />
          </div>
        )}
      </div>
    </ActionPanel>
  );
}
