/**
 * The Agents home (core.agents:home): the main entry to the agent platform. What is working now
 * (conversations, their sub-agents and linked sessions, with Stop), proposals waiting for the
 * person, what agents made lately (the Library), and the ways to start work.
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { ArtifactMeta } from '@harness/client';
import { Badge, Button, Icon } from '@harness/ui';
import { client, useData } from '../../state/data';
import { navigate, openPluginPanel, openSession, prefill } from '../../state/app';
import { HomeSection, ModuleHeader } from '../plugin-home';
import { homeModel } from '../../registry/modules';
import { SessionProposals, Working } from './Page';
import { refreshProposals } from './proposals';

function Kpi({ label, value, tone, onClick, id }: { label: string; value: React.ReactNode; tone?: 'hot' | 'warm' | 'calm'; onClick?: () => void; id: string }) {
  return (
    <button type="button" data-kpi={id} onClick={onClick} className="rounded-xl border border-hx-border-subtle bg-hx-elevated p-3.5 text-left hover:border-hx-border">
      <b className={`block text-[24px] font-semibold leading-tight tracking-tight ${tone === 'hot' ? 'text-hx-danger' : tone === 'warm' ? 'text-hx-warning' : tone === 'calm' ? 'text-hx-success' : ''}`}>{value}</b>
      <span className="text-[12px] text-hx-muted">{label}</span>
    </button>
  );
}

export function AgentsHome(): React.ReactElement {
  const registry = useData((s) => s.registry);
  const sessions = useData((s) => s.sessions);
  const approvals = useData((s) => s.approvals);
  const [made, setMade] = useState<ArtifactMeta[] | null>(null);
  const m = homeModel(registry, 'core.agents');
  const active = useMemo(() => sessions.filter((s) => s.status === 'running' || s.status === 'waiting'), [sessions]);
  const roots = active.filter((s) => !s.parent || !active.some((p) => p.id === s.parent));
  const linked = active.filter((s) => s.parent).length;
  const recent = useMemo(() => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20), [sessions]);
  useEffect(() => { for (const s of recent) void refreshProposals(s.id); }, [recent.map((s) => s.id).join(',')]);
  useEffect(() => { client.artifacts.library({ limit: 8 }).then(setMade).catch(() => setMade([])); }, []);
  const library = registry.views.has('core.artifacts:library');
  if (!m) return <div />;
  return (
    <div className="hx-scroll h-full overflow-y-auto" data-module-home="core.agents">
      <div className="mx-auto max-w-5xl px-6 py-8">
        <ModuleHeader model={m}>
          <Button size="sm" icon="bot" onClick={() => navigate({ view: 'core.agents:agents' })}>All agents</Button>
        </ModuleHeader>
        <div className="mb-7 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Kpi id="working" label="conversations working" value={active.filter((s) => !s.parent).length} tone={active.length ? 'warm' : 'calm'} onClick={() => navigate({ view: 'core.agents:agents' })} />
          <Kpi id="linked" label="linked sessions working" value={linked} onClick={() => navigate({ view: 'core.agents:agents' })} />
          <Kpi id="needs" label="waiting for you" value={approvals.length} tone={approvals.length ? 'hot' : 'calm'} onClick={() => navigate({ view: 'core.inbox:inbox' })} />
          <Kpi id="cost" label="spent in the last 20 conversations" value={`$${recent.reduce((n, s) => n + (s.cost ?? 0), 0).toFixed(2)}`} />
        </div>
        <HomeSection title="Working now" id="working" action={active.length > 0 ? <Button size="sm" variant="ghost" icon="stop" onClick={() => { for (const s of active) void client.sessions.abort(s.id).catch(() => {}); }}>Stop all</Button> : undefined}>
          {!roots.length ? <p className="rounded-xl border border-dashed border-hx-border-subtle p-4 text-[13px] text-hx-muted" data-empty>No agent is working. Start a conversation, a workflow or a linked session; sub-agents and background tasks show here as they run.</p> : roots.slice(0, 6).map((s) => <Working key={s.id} s={s} />)}
        </HomeSection>
        <HomeSection title="Proposals waiting for you" id="proposals">
          <div className="space-y-2" data-home-proposals>{recent.map((s) => <SessionProposals key={s.id} s={s} />)}</div>
          <p className="mt-1 text-[12px] text-hx-muted">Agents propose linked sessions for work beside yours; Start runs one, Dismiss drops it.</p>
        </HomeSection>
        {library && (
          <HomeSection title="Made lately (Library)" id="library" action={<Button size="sm" variant="ghost" icon="library" onClick={() => navigate({ view: 'core.artifacts:library' })}>Library</Button>}>
            {made === null ? <p className="text-[13px] text-hx-muted">Loading…</p> : !made.length ? <p className="text-[13px] text-hx-muted">Nothing yet: documents, apps, diagrams and data agents make with the artifact tool are kept here, with every version.</p> : (
              <div className="grid gap-2 sm:grid-cols-2">
                {made.map((a) => (
                  <button key={`${a.sessionId}:${a.id}`} type="button" data-home-artifact={a.id} onClick={() => { if (a.sessionId) { openSession(a.sessionId); openPluginPanel('core.artifacts:artifacts', { id: a.sessionId, artifact: a.id }); } }} className="flex items-center gap-3 rounded-lg border border-hx-border-subtle px-3 py-2.5 text-left hover:bg-hx-hover">
                    <Icon name={a.kind === 'diagram' ? 'layers' : a.kind === 'html' || a.kind === 'react' ? 'apps' : 'file-text'} size={15} className="text-hx-accent-text" />
                    <span className="min-w-0 flex-1 truncate text-[13px]">{a.title}</span><Badge>{a.kind}</Badge><span className="text-[11px] text-hx-muted">v{a.version}</span>
                  </button>
                ))}
              </div>
            )}
          </HomeSection>
        )}
        <HomeSection title="Start" id="actions">
          <div className="grid gap-2 sm:grid-cols-2">
            {[
              ['Plan, then delegate', 'Make a plan for this and run the independent parts as sub-agents in parallel, then bring the results together: '],
              ['A linked session beside this one', 'Start a linked session that works on this beside me and reports back when done: '],
              ['Review with a second model', 'Have a sub-agent on another model review this and list what it would change: '],
              ['Run a workflow', '/workflow '],
            ].map(([title, prompt]) => (
              <button key={title} type="button" data-home-action={title} onClick={() => prefill(prompt!, true)} className="flex items-center gap-3 rounded-lg border border-hx-border-subtle px-3 py-2.5 text-left text-[13px] hover:bg-hx-hover"><Icon name="sparkles" size={15} className="text-hx-accent-text" /><span className="flex-1">{title}</span></button>
            ))}
          </div>
        </HomeSection>
      </div>
    </div>
  );
}
