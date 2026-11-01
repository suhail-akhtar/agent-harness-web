/**
 * Noticing: what the harness notices by itself from the person's work (src/core/noticing.ts). Its panel
 * (the eye in the Inbox): off, practice (findings written down, not shown) or on; what it would have said
 * in practice; each detector with its measures, on or off (one that turned itself off says why); what it
 * observes (fingerprints, never content) and a button that forgets it. And the one quiet line a finding
 * about a conversation gets by its message box, with what it offers and a way to say it was not useful.
 */

import React, { useCallback, useEffect, useState } from 'react';
import type { InboxItem, NoticedDraft, NoticingOverview } from '@harness/client';
import { Badge, Button, Icon, Modal, Switch, cx, toast, ChoiceGroup, Section, Callout } from '@harness/ui';
import { useData, client } from '../../state/data';
import { openSession } from '../../state/app';
import type { ScheduleDraft } from '../core.scheduled/templates';
import { useScheduleDialog } from '../core.scheduled/Scheduled';

const fail = (e: unknown) => toast((e as Error).message, { kind: 'error' });

/** The finding's offered schedule as the schedule dialog's draft (a checker approves its steps; it is the person's to make). */
export const scheduleDraft = (d: NoticedDraft): ScheduleDraft => ({ title: d.title, prompt: d.prompt, ...(d.cron ? { cron: d.cron } : {}), ...(d.timeZone ? { timeZone: d.timeZone } : {}), ...(d.folder ? { folder: d.folder } : {}), ...(d.model ? { model: d.model } : {}), asks: 'auto' });

/** The overview, and a reload (null before the first read; undefined on a server without noticing). */
export function useNoticing(open = true): [NoticingOverview | null | undefined, () => void] {
  const [o, setO] = useState<NoticingOverview | null | undefined>(null);
  // Read again when the inbox or noticing changed (a finding shown, written down in practice, a detector off).
  const tick = useData((s) => s.inbox);
  const noticed = useData((s) => s.noticingTick);
  const load = useCallback(() => { client.noticing.get().then(setO).catch(() => setO(undefined)); }, []);
  useEffect(() => { if (open) load(); }, [open, load, tick, noticed]);
  return [o, load];
}

const MODES: Array<{ id: NoticingOverview['mode']; label: string }> = [{ id: 'off', label: 'Off' }, { id: 'practice', label: 'Practice' }, { id: 'on', label: 'On' }];
const MODE_HELP: Record<NoticingOverview['mode'], string> = {
  off: 'Nothing is observed and nothing is noticed.',
  practice: 'It notices quietly and writes down what it would have told you, so you can judge it before it tells you anything.',
  on: 'What it notices comes to your Inbox (and, about a conversation, by its message box). At most 3 a day; at most 1 may interrupt you.',
};
const STATE: Record<'on' | 'digest' | 'off', { label: string; tone: 'success' | 'warning' | 'neutral' }> = { on: { label: 'On', tone: 'success' }, digest: { label: 'Digest only', tone: 'warning' }, off: { label: 'Turned itself off', tone: 'neutral' } };
const when = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** The panel: mode, what it would have said, detectors, what it observes. */
export function NoticingDialog({ open, onClose }: { open: boolean; onClose: () => void }): React.ReactElement {
  const [o, reload] = useNoticing(open);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const set = async (b: Parameters<typeof client.noticing.set>[0]) => {
    setBusy(true);
    try { await client.noticing.set(b); reload(); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const clear = async () => {
    setConfirmClear(false);
    try { const r = await client.noticing.clear(); toast(`Forgot ${r.cleared} observation${r.cleared === 1 ? '' : 's'}`, { kind: 'success' }); reload(); } catch (e) { fail(e); }
  };
  const days = o?.practiceSince ? Math.floor((Date.now() - o.practiceSince) / 86_400_000) : 0;
  return (
    <Modal open={open} onClose={onClose} title="Noticing" size="lg" footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      {o === null ? <p className="text-body text-hx-muted">Loading…</p> : o === undefined || !o.enabled ? <p className="text-body text-hx-muted" data-noticing-unavailable>Noticing is not available on this server.</p> : (
        <div data-noticing data-noticing-mode={o.mode}>
          <p className="mb-4 text-small text-hx-secondary">
            Without anything set up, it notices a few things in your work that need you: a failure while you were away, a schedule in trouble, a command failing the same way again and again, a task you ask for day after day. Fixed rules count what happens; no model watches you.
          </p>
          <section className="mb-5">
            <ChoiceGroup name="noticing-mode" label="Noticing" value={o.mode} options={MODES} onChange={(mode) => void set({ mode })} />
            <p className="mt-1.5 text-small text-hx-muted" data-noticing-help>{MODE_HELP[o.mode]}</p>
            {o.mode === 'practice' && o.practiceSince && (
              <p className="mt-1 text-small text-hx-muted" data-noticing-practice-days>
                Practising for {days} day{days === 1 ? '' : 's'}{o.ready ? '' : ` (${o.practiceDays} days suggested before you decide)`}.
              </p>
            )}
          </section>

          {o.mode === 'practice' && (
            <Section dense title="What it would have told you" data-noticing-review>
              {!o.practice.length
                ? <p className="text-body text-hx-muted" data-noticing-review-empty>Nothing yet. It writes down what it would have said as you work.</p>
                : (
                  <div className="hx-scroll max-h-64 space-y-2 overflow-y-auto pr-1">
                    {o.practice.map((p, i) => (
                      <div key={i} className="rounded-lg border border-hx-border-subtle px-3 py-2" data-noticing-would={p.detector}>
                        <div className="flex items-center gap-2 text-caption text-hx-muted"><span>{o.detectors.find((d) => d.id === p.detector)?.title}</span><span>· {when(p.at)}</span></div>
                        <div className="text-body font-medium">{p.title}</div>
                        <p className="line-clamp-3 whitespace-pre-line text-small text-hx-secondary">{p.body}</p>
                      </div>
                    ))}
                  </div>
                )}
              {o.practice.length > 0 && <div className="mt-2 flex items-center gap-2"><Button size="sm" variant="primary" disabled={busy} onClick={() => void set({ mode: 'on' })} data-noticing-turn-on>Useful: turn it on</Button><span className="text-small text-hx-muted">Or switch off the detectors whose findings you would not want, below.</span></div>}
            </Section>
          )}

          <Section dense title="What it notices">
            <div className="divide-y divide-hx-border-subtle rounded-lg border border-hx-border-subtle">
              {o.detectors.map((d) => {
                const st = STATE[d.state];
                const s = d.stats;
                return (
                  <div key={d.id} className="flex items-start gap-3 px-3 py-2.5" data-detector={d.id} data-detector-state={d.state}>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2"><span className="text-body font-medium">{d.title}</span>{d.enabled && d.state !== 'on' && <Badge tone={st.tone}>{st.label}</Badge>}</div>
                      <p className="text-small text-hx-muted">{d.blurb}</p>
                      {d.enabled && d.state !== 'on' && d.why && <p className="mt-0.5 text-small text-hx-warning" data-detector-why>{d.state === 'off' ? 'It turned itself off' : 'It moved itself to the digest'}: {d.why}.</p>}
                      {(s.shown > 0 || s.practice > 0 || s.holdout > 0) && (
                        <p className="mt-0.5 flex flex-wrap gap-x-3 text-caption text-hx-muted" data-detector-stats>
                          {s.practice > 0 && <span>{s.practice} in practice</span>}
                          {s.shown > 0 && <span>{s.shown} shown in 14 days</span>}
                          {s.shown > 0 && <span>{s.acted} acted on</span>}
                          {s.notUseful > 0 && <span>{s.notUseful} not useful</span>}
                          {s.holdout > 0 && <span>{s.holdout} held back to measure, {s.selfFound} you found anyway</span>}
                        </p>
                      )}
                    </div>
                    <Switch checked={d.enabled && d.state !== 'off'} disabled={busy || o.mode === 'off'} onChange={(v) => void set({ detectors: { [d.id]: v } })} label={`${d.title}: ${d.enabled && d.state !== 'off' ? 'on' : 'off'}`} />
                  </div>
                );
              })}
            </div>
            <p className="mt-1.5 text-small text-hx-muted">Your dismissals only make it quieter: "wrong" mutes that finding for good, "not useful" mutes that kind of finding in that folder for 30 days. A detector whose findings you mostly do not want moves to the digest, then turns itself off; only you turn it on again.</p>
          </Section>

          <Section dense title="What it observes" data-noticing-observed>
            <p className="text-small text-hx-secondary">
              {o.observed.turns || o.observed.commands
                ? <>{o.observed.typed} of your messages, {o.observed.commands} commands ({o.observed.failed} failed) and {o.observed.edits} edits in {o.observed.projects} folder{o.observed.projects === 1 ? '' : 's'}, over {o.observed.days} day{o.observed.days === 1 ? '' : 's'}.</>
                : <>Nothing yet.</>}
              {' '}Kept as fingerprints (hashes), never the text of your messages, commands or files, for {o.limits.keepDays} days. Scheduled runs and their conversations are not observed.
            </p>
            <div className="mt-2 flex items-center gap-2">
              {confirmClear
                ? <><Button size="sm" variant="danger" onClick={() => void clear()} data-noticing-clear-confirm>Forget it</Button><Button size="sm" variant="ghost" onClick={() => setConfirmClear(false)}>Cancel</Button></>
                : <Button size="sm" variant="ghost" icon="trash" disabled={!o.observed.turns && !o.observed.commands} onClick={() => setConfirmClear(true)} data-noticing-clear>Forget what it observed</Button>}
            </div>
          </Section>
        </div>
      )}
    </Modal>
  );
}

/** A finding's offer: send its message to its conversation, or open the schedule it offers in the dialog. */
export async function acceptFinding(item: InboxItem): Promise<void> {
  if (item.draft) { void client.inbox.act(item.id, 'open').catch(() => {}); useScheduleDialog.getState().open(scheduleDraft(item.draft)); return; }
  await client.inbox.act(item.id, 'accept');
  if (item.sessionId) openSession(item.sessionId);
}

/** The quiet line by a conversation's message box: a finding about it, while it is not working. */
export function NoticedStrip({ sessionId, running }: { sessionId: string; running: boolean }): React.ReactElement | null {
  const item = useData((s) => s.inbox?.find((i) => i.kind === 'noticed' && i.inline && i.sessionId === sessionId && (i.status === 'new' || i.status === 'read')));
  const [busy, setBusy] = useState(false);
  if (!item || running) return null;
  const dismiss = (reason: NonNullable<InboxItem['reason']>) => void client.inbox.act(item.id, 'dismiss', { reason }).catch(fail);
  return (
    <div className="mx-auto w-full max-w-column shrink-0 px-4 pb-2 sm:px-6" data-noticed-strip={item.id}>
      <Callout variant="banner" tone="neutral" icon="eye" className="bg-hx-elevated" actions={<>
        {item.action && <Button size="sm" variant="primary" disabled={busy} onClick={() => { setBusy(true); void acceptFinding(item).catch(fail).finally(() => setBusy(false)); }} data-noticed-accept>{item.action.label}</Button>}
        <Button size="sm" variant="ghost" onClick={() => dismiss('bad_timing')} data-noticed-later>Not now</Button>
        <Button size="sm" variant="ghost" onClick={() => dismiss('not_useful')} data-noticed-not-useful>Not useful</Button>
      </>}>
        <span className="font-medium">{item.title}.</span> <span className="text-hx-secondary">{item.body.split('\n')[0]}</span>
      </Callout>
    </div>
  );
}

/** In the Inbox, once practice has run its days: what it would have said, to judge it by. */
export function PracticeBanner({ o, onReview }: { o: NoticingOverview | null | undefined; onReview: () => void }): React.ReactElement | null {
  if (!o || o.mode !== 'practice' || !o.ready || !o.practice.length) return null;
  const days = o.practiceSince ? Math.floor((Date.now() - o.practiceSince) / 86_400_000) : 0;
  return (
    <Callout variant="banner" tone="accent" icon="eye" className="mb-3" data-noticing-banner actions={<Button size="sm" variant="primary" onClick={onReview} data-noticing-review-open>Review</Button>}>
      Noticing has practised quietly {days >= 1 ? `for ${days} day${days === 1 ? '' : 's'}` : 'today'}. It would have told you {o.practice.length} thing{o.practice.length === 1 ? '' : 's'}. Look before you decide.
    </Callout>
  );
}
