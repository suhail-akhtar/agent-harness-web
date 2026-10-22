/**
 * The Agents panel of a conversation: a live tree of what works for it - its sub-agents (type,
 * model, status, cost, duration, worktree branch), background tasks, linked sessions (status, end
 * reason, cost; open here or beside) and open proposals - with the todo list and the cost per model.
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { Item, TaskView, Todo } from '@harness/client';
import { duration } from '@harness/client';
import { Badge, Button, EmptyState, Icon, IconButton, Spinner, Tooltip, cx } from '@harness/ui';
import { useData } from '../../state/data';
import { openSession, openSplit } from '../../state/app';
import { useSessionLive } from '../core.chat/live';
import { agentMs, type SubAgent } from '../../state/agents';
import { CostByModel, money } from '../../components/CostByModel';
import type { NativeProps } from '../../registry/PluginView';
import { dismissProposal, startProposal, useOpenProposals } from './proposals';

export { money };

function useTick(on: boolean) {
  const [, t] = useState(0);
  useEffect(() => { if (!on) return; const i = setInterval(() => t((n) => n + 1), 1000); return () => clearInterval(i); }, [on]);
}

const STATUS_DOT: Record<string, string> = { running: 'bg-hx-accent animate-pulse', waiting: 'bg-hx-warning', done: 'bg-hx-success', completed: 'bg-hx-success', idle: 'bg-hx-muted', failed: 'bg-hx-danger', stopped: 'bg-hx-muted' };
export function Dot({ status }: { status: string }) { return <span className={cx('mt-1.5 h-2 w-2 shrink-0 rounded-full', STATUS_DOT[status] ?? 'bg-hx-muted')} title={status} />; }

function Section({ title, count, children, icon }: { title: string; count?: number; icon: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="mb-3">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-1.5 px-1 py-1 text-[11.5px] font-medium uppercase tracking-wide text-hx-muted hover:text-hx-secondary">
        <Icon name={icon} size={13} />{title}{count !== undefined && <span className="ml-1 rounded-full bg-hx-pill px-1.5 text-[10.5px] normal-case">{count}</span>}
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} className="ml-auto" />
      </button>
      {open && <div className="mt-1 space-y-1">{children}</div>}
    </section>
  );
}

export function AgentRow({ a }: { a: SubAgent }) {
  const ms = agentMs(a);
  return (
    <div data-subagent={a.name} data-subagent-status={a.status} className="flex gap-2 rounded-lg border border-hx-border-subtle bg-hx-elevated px-2.5 py-2">
      <Dot status={a.status} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5"><span className="truncate font-mono text-[12.5px] text-hx-primary">{a.name}</span>{a.background && <Badge>background</Badge>}</div>
        {a.description && <div className="truncate text-[12px] text-hx-secondary">{a.description}</div>}
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-hx-muted">
          <span>{a.type}</span>
          {a.model && <span data-subagent-model className="rounded bg-hx-pill px-1">{a.model}</span>}
          {a.worktree && <span className="inline-flex items-center gap-0.5" title="Works in its own git worktree"><Icon name="git-branch" size={11} />{a.worktree}</span>}
          {ms !== undefined && <span>{duration(ms)}</span>}
          {a.cost > 0 && <span data-subagent-cost>{money(a.cost)}</span>}
          {a.status === 'running' && a.last && <span className="truncate">· {a.last}</span>}
        </div>
      </div>
    </div>
  );
}

function TaskRow({ t }: { t: TaskView }) {
  return (
    <div data-task={t.id} className="flex gap-2 rounded-lg border border-hx-border-subtle bg-hx-elevated px-2.5 py-2">
      <Dot status={t.status} />
      <Icon name={t.kind === 'shell' ? 'terminal' : t.kind === 'workflow' ? 'workflow' : t.kind === 'monitor' ? 'eye' : 'bot'} size={13} className="mt-0.5 text-hx-muted" />
      <div className="min-w-0 flex-1"><div className="truncate text-[12.5px]">{t.description}</div><div className="text-[11px] text-hx-muted">{t.kind} · {t.id} · {t.status}{t.endedAt ? ` · ${duration(t.endedAt - t.startedAt)}` : ''}{t.cost ? ` · ${money(t.cost)}` : ''}</div></div>
    </div>
  );
}

export function LinkedRow({ id, fallback, reason }: { id: string; fallback?: string; reason?: string }) {
  const s = useData((st) => st.sessions.find((x) => x.id === id));
  const sessions = useData((st) => st.sessions);
  const kids = useMemo(() => sessions.filter((x) => x.parent === id), [sessions, id]);
  const status = s?.status ?? 'idle';
  return (
    <div data-linked-session={id} className="rounded-lg border border-hx-border-subtle bg-hx-elevated px-2.5 py-2">
      <div className="flex gap-2">
        <Dot status={status === 'idle' ? (reason && reason !== 'done' ? 'failed' : 'done') : status} />
        <div className="min-w-0 flex-1">
          <button type="button" onClick={() => openSession(id)} className="block max-w-full truncate text-left text-[12.5px] font-medium hover:underline">{s?.title || fallback || id}</button>
          <div className="text-[11px] text-hx-muted">{status === 'running' ? 'working' : status === 'waiting' ? 'needs you' : reason ? `ended: ${reason}` : 'idle'}{s ? ` · ${s.model} · ${money(s.cost)}` : ''}</div>
        </div>
        <Tooltip label="Open beside"><IconButton icon="split" size="xs" label="Open beside this one" onClick={() => openSplit({ view: 'core.chat:session', params: { id } })} /></Tooltip>
      </div>
      {kids.length > 0 && <div className="ml-4 mt-1.5 space-y-1 border-l border-hx-border-subtle pl-2">{kids.map((k) => <LinkedRow key={k.id} id={k.id} />)}</div>}
    </div>
  );
}

export function Todos({ todos }: { todos: Todo[] }) {
  return (
    <ol data-todos className="space-y-0.5">
      {todos.map((t, i) => (
        <li key={i} data-todo-status={t.status} className="flex items-start gap-2 px-1 text-[12.5px]">
          <Icon name={t.status === 'completed' ? 'check-circle' : t.status === 'in_progress' ? 'play' : 'dot'} size={13} className={cx('mt-0.5 shrink-0', t.status === 'completed' ? 'text-hx-success' : t.status === 'in_progress' ? 'text-hx-accent-text' : 'text-hx-muted')} />
          <span className={cx(t.status === 'completed' && 'text-hx-muted line-through', t.status === 'in_progress' && 'font-medium')}>{t.content}</span>
        </li>
      ))}
    </ol>
  );
}


export function AgentsPanel({ params }: NativeProps): React.ReactElement {
  const id = params.id ?? '';
  const [s] = useSessionLive(id);
  const parent = useData((st) => st.sessions.find((x) => x.id === s.meta?.parent));
  const openProps = useOpenProposals(id, Object.keys(s.resolved).length + s.live.items.filter((i) => i.kind === 'proposal').length);
  const agents = useMemo(() => Object.values(s.agents).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)), [s.agents]);
  const tasks = useMemo(() => s.tasks.filter((t) => t.kind !== 'agent'), [s.tasks]);
  const reasons = useMemo(() => { const r: Record<string, { reason?: string; title: string }> = {}; for (const i of s.live.items as Item[]) if (i.kind === 'link') r[i.id] = { reason: i.phase === 'report' ? i.reason : r[i.id]?.reason, title: i.title }; return r; }, [s.live.items]);
  const linked = useMemo(() => [...new Set([...(s.meta?.linked ?? []), ...Object.keys(reasons)])], [s.meta?.linked, reasons]);
  useTick(agents.some((a) => a.status === 'running'));
  if (!id) return <EmptyState icon="bot" title="Open a conversation">Its agents show here.</EmptyState>;
  if (!s.loaded) return <div className="flex justify-center p-6"><Spinner /></div>;
  const todos = s.meta?.todos ?? [];
  const nothing = !agents.length && !tasks.length && !linked.length && !(openProps?.length) && !todos.length;
  return (
    <div data-agents-panel={id} className="text-[13px]">
      <div className="mb-3 flex items-center gap-2 rounded-xl bg-hx-pill/60 px-3 py-2">
        <Dot status={s.status} />
        <div className="min-w-0 flex-1"><div className="truncate font-medium">{s.meta?.title}</div><div className="text-[11.5px] text-hx-muted">{s.status === 'running' ? 'Working' : s.status === 'waiting' ? 'Needs you' : 'Idle'} · {s.meta?.model} · {money(s.meta?.cost ?? 0)}</div></div>
      </div>
      {parent && <button type="button" onClick={() => openSession(parent.id)} className="mb-3 flex w-full items-center gap-2 rounded-lg border border-hx-border-subtle px-2.5 py-1.5 text-left text-[12px] text-hx-secondary hover:bg-hx-hover"><Icon name="arrow-up" size={13} />Started by <b className="truncate font-medium">{parent.title}</b></button>}
      {nothing && <EmptyState icon="bot" title="Only the main agent so far">Sub-agents, background tasks, linked sessions and proposals show here as they start.</EmptyState>}
      {todos.length > 0 && <Section title="Tasks" icon="list" count={todos.filter((t) => t.status !== 'completed').length}><Todos todos={todos} /></Section>}
      {agents.length > 0 && <Section title="Sub-agents" icon="bot" count={agents.length}>{agents.map((a) => <AgentRow key={a.name} a={a} />)}</Section>}
      {tasks.length > 0 && <Section title="Background" icon="activity" count={tasks.filter((t) => t.status === 'running').length}>{tasks.map((t) => <TaskRow key={t.id} t={t} />)}</Section>}
      {linked.length > 0 && <Section title="Linked sessions" icon="split" count={linked.length}>{linked.map((l) => <LinkedRow key={l} id={l} fallback={reasons[l]?.title} reason={reasons[l]?.reason} />)}</Section>}
      {!!openProps?.length && (
        <Section title="Proposals" icon="sparkles" count={openProps.length}>
          {openProps.map((p) => (
            <div key={p.id} data-panel-proposal={p.id} className="rounded-lg border border-hx-accent/40 bg-hx-accent-soft/30 px-2.5 py-2">
              <div className="text-[12.5px] font-medium">{p.title}</div>
              <div className="line-clamp-2 text-[11.5px] text-hx-muted">{p.brief}</div>
              <div className="mt-1.5 flex gap-1.5"><Button size="sm" variant="primary" onClick={() => void startProposal(id, p.id)}>Start</Button><Button size="sm" variant="ghost" onClick={() => void dismissProposal(id, p.id)}>Dismiss</Button></div>
            </div>
          ))}
        </Section>
      )}
      {s.meta && <Section title="Cost by model" icon="dollar"><CostByModel meta={s.meta} /></Section>}
    </div>
  );
}
