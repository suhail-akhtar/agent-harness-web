/**
 * The Agents page: everything working across conversations (kept current by the global event
 * stream: status changes, linked sessions starting and reporting, proposals), each conversation
 * with its running sub-agents and background tasks, linked sessions under the one that started
 * them, proposals waiting for the person, and Stop.
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { GlobalEvent, SessionMeta } from '@harness/client';
import { Badge, Button, EmptyState, Icon, toast, Page, Section, PageState } from '@harness/ui';
import { client, globalBus, useData } from '../../state/data';
import { openSession, openSplit } from '../../state/app';
import { useSessionLive } from '../core.chat/live';
import { AgentRow, Dot, money } from './Panel';
import { dismissProposal, refreshProposals, startProposal, useOpenProposals } from './proposals';

/** The global stream's linked-session news since the app started (newest first). */
export interface LinkNews { at: number; type: string; sessionId: string; id: string; title: string; reason?: string; preview?: string }
const news: LinkNews[] = [];
const newsListeners = new Set<() => void>();
export function watchLinkedNews(): void {
  globalBus.on((e: GlobalEvent) => {
    if (e.topic !== 'linked') return;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    news.unshift({ at: Date.now(), type: String(p.type ?? ''), sessionId: String(p.sessionId ?? ''), id: String(p.id ?? ''), title: String(p.title ?? ''), ...(typeof p.reason === 'string' ? { reason: p.reason } : {}), ...(typeof p.preview === 'string' ? { preview: p.preview } : {}) });
    if (news.length > 50) news.length = 50;
    for (const l of newsListeners) l();
  });
}
function useNews(): LinkNews[] {
  const [, t] = useState(0);
  useEffect(() => { const l = () => t((n) => n + 1); newsListeners.add(l); return () => { newsListeners.delete(l); }; }, []);
  return news;
}

const stop = (id: string) => void client.sessions.abort(id).then(() => toast('Stopped')).catch((e: Error) => toast(e.message, { kind: 'error' }));

export function Working({ s, depth = 0 }: { s: SessionMeta; depth?: number }) {
  const [live] = useSessionLive(s.id);
  const sessions = useData((st) => st.sessions);
  const kids = sessions.filter((x) => x.parent === s.id && (x.status === 'running' || x.status === 'waiting'));
  const agents = Object.values(live.agents).filter((a) => a.status === 'running');
  const tasks = live.tasks.filter((t) => t.status === 'running' && t.kind !== 'agent');
  return (
    <div data-working-session={s.id} className={depth ? 'ml-5 border-l border-hx-border-subtle pl-3' : ''}>
      <div className="mb-2 rounded-xl border border-hx-border-subtle bg-hx-elevated p-3">
        <div className="flex items-center gap-2">
          <Dot status={s.status ?? 'idle'} />
          <button type="button" onClick={() => openSession(s.id)} className="min-w-0 flex-1 truncate text-left text-[13.5px] font-medium hover:underline">{s.title || 'Conversation'}</button>
          {s.parent && <Badge>linked</Badge>}
          <Badge tone={s.status === 'waiting' ? 'warning' : 'accent'}>{s.status === 'waiting' ? 'Needs you' : 'Working'}</Badge>
          <span className="text-[11.5px] text-hx-muted">{s.model} · {money(s.cost)}</span>
          <Button size="sm" variant="ghost" icon="split" onClick={() => openSplit({ view: 'core.chat:session', params: { id: s.id } })}>Beside</Button>
          <Button size="sm" variant="ghost" icon="stop" data-stop={s.id} onClick={() => stop(s.id)}>Stop</Button>
        </div>
        {(agents.length > 0 || tasks.length > 0) && (
          <div className="ml-4 mt-2 space-y-1">
            {agents.map((a) => <AgentRow key={a.name} a={a} />)}
            {tasks.map((t) => <div key={t.id} className="flex items-center gap-2 text-[12.5px] text-hx-secondary"><Icon name={t.kind === 'shell' ? 'terminal' : t.kind === 'workflow' ? 'workflow' : 'eye'} size={13} /><span className="min-w-0 flex-1 truncate">{t.description}</span><span className="text-[11px] text-hx-muted">{t.kind}</span></div>)}
          </div>
        )}
      </div>
      {kids.map((k) => <Working key={k.id} s={k} depth={depth + 1} />)}
    </div>
  );
}

export function SessionProposals({ s }: { s: SessionMeta }) {
  const list = useOpenProposals(s.id);
  if (!list?.length) return null;
  return (
    <>
      {list.map((p) => (
        <div key={p.id} data-page-proposal={p.id} className="flex items-start gap-3 rounded-xl border border-hx-accent/40 bg-hx-accent-soft/30 p-3">
          <Icon name="split" size={16} className="mt-0.5 text-hx-accent-text" />
          <div className="min-w-0 flex-1"><div className="text-[13.5px] font-medium">{p.title}</div><div className="line-clamp-2 text-[12px] text-hx-muted">{p.brief}</div><button type="button" onClick={() => openSession(s.id)} className="text-[11.5px] text-hx-accent-text hover:underline">from {s.title}</button></div>
          <Button size="sm" variant="primary" onClick={() => void startProposal(s.id, p.id)}>Start</Button>
          <Button size="sm" variant="ghost" onClick={() => void dismissProposal(s.id, p.id)}>Dismiss</Button>
        </div>
      ))}
    </>
  );
}

export function AgentsPage(): React.ReactElement {
  const sessions = useData((st) => st.sessions);
  const items = useNews();
  const active = useMemo(() => sessions.filter((s) => (s.status === 'running' || s.status === 'waiting')), [sessions]);
  // Top of each tree: a working session whose parent is not working (or has none).
  const roots = active.filter((s) => !s.parent || !active.some((p) => p.id === s.parent));
  // Proposals: the conversations used lately (the server keeps them per conversation).
  const recent = useMemo(() => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30), [sessions]);
  useEffect(() => { for (const s of recent) void refreshProposals(s.id); }, [recent.map((s) => s.id).join(',')]);
  return (
    <Page data-agents-page width="wide" title="Agents" actions={active.length > 0 ? <Button variant="ghost" icon="stop" onClick={() => { for (const s of active) stop(s.id); }}>Stop all</Button> : undefined}>
        <Section title="Working now" className="mb-0">
        {!roots.length ? <PageState kind="empty" icon="bot" title="No agent is working" detail="Conversations at work, their sub-agents, background tasks and linked sessions show here." /> : roots.map((s) => <Working key={s.id} s={s} />)}
        </Section>
        <div className="mt-6 space-y-2" data-proposals-waiting>{recent.map((s) => <SessionProposals key={s.id} s={s} />)}</div>
        {items.length > 0 && (
          <>
            <h2 className="mb-2 mt-6 text-[12px] font-medium uppercase tracking-wide text-hx-muted">Linked sessions, lately</h2>
            <div className="divide-y divide-hx-border-subtle rounded-xl border border-hx-border-subtle" data-linked-news>
              {items.slice(0, 20).map((n, i) => (
                <button key={i} type="button" onClick={() => openSession(n.id || n.sessionId)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-hx-hover">
                  <Icon name={n.type === 'report' ? 'check-circle' : n.type === 'message' ? 'mail' : 'split'} size={14} className="text-hx-muted" />
                  <span className="min-w-0 flex-1"><span className="block truncate text-[13px]">{n.title}</span>{n.preview && <span className="block truncate text-[11.5px] text-hx-muted">{n.preview}</span>}</span>
                  <span className="text-[11px] text-hx-muted">{n.type}{n.reason ? ` (${n.reason})` : ''}</span>
                </button>
              ))}
            </div>
          </>
        )}
    </Page>
  );
}
