/**
 * Open proposals per conversation (sessions an agent offered to start), shared by the proposal
 * cards in the transcript, the Agents panel and the Agents page; kept current by the session's own
 * events (proposal_resolved) and the global stream's proposals topic.
 */

import { useEffect, useState } from 'react';
import type { Proposal } from '@harness/client';
import { toast } from '@harness/ui';
import { client, globalBus } from '../../state/data';
import { openSession } from '../../state/app';

const open = new Map<string, Proposal[]>();
const loading = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
const changed = () => { for (const l of listeners) l(); };

export function refreshProposals(sessionId: string): Promise<void> {
  const p = client.sessions.proposals(sessionId).then((list) => { open.set(sessionId, Array.isArray(list) ? list : []); changed(); }).catch(() => { open.set(sessionId, []); changed(); }).finally(() => loading.delete(sessionId));
  loading.set(sessionId, p);
  return p;
}

let wired = false;
function wire(): void {
  if (wired) return;
  wired = true;
  globalBus.on((e) => {
    if (e.topic !== 'proposals') return;
    const sid = (e.payload as { sessionId?: unknown })?.sessionId;
    if (typeof sid === 'string' && open.has(sid)) void refreshProposals(sid);
  });
}

/** The open proposals of a conversation (null while loading); `version` re-reads them (a resolved event). */
export function useOpenProposals(sessionId: string, version = 0): Proposal[] | null {
  const [, tick] = useState(0);
  useEffect(() => {
    wire();
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    if (sessionId && !loading.has(sessionId)) void refreshProposals(sessionId);
    return () => { listeners.delete(l); };
  }, [sessionId, version]);
  return sessionId ? open.get(sessionId) ?? null : null;
}

/** Start: the linked session is made and runs; the person is told where it is. */
export async function startProposal(sessionId: string, id: string, opts: { open?: boolean } = {}): Promise<string | undefined> {
  try {
    const r = await client.proposals.start(id);
    await refreshProposals(sessionId);
    toast(`Started "${r.session.title}"`, { kind: 'success', action: { label: 'Open', run: () => openSession(r.session.id) } });
    if (opts.open) openSession(r.session.id);
    return r.session.id;
  } catch (e) { toast((e as Error).message, { kind: 'error' }); await refreshProposals(sessionId); return undefined; }
}

export async function dismissProposal(sessionId: string, id: string): Promise<void> {
  try { await client.proposals.dismiss(id); await refreshProposals(sessionId); toast('Dismissed'); } catch (e) { toast((e as Error).message, { kind: 'error' }); await refreshProposals(sessionId); }
}
