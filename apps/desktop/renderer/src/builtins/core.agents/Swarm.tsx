/**
 * The swarm at a glance, for the Agents panel: how many agents are at work, done or failed, how long the
 * run has gone and what it cost; the mix of models (a bar of their share of the cost); and a timeline,
 * one bar per agent on the run's clock, so parallel work, stragglers and failures show at once.
 */

import React from 'react';
import { duration } from '@harness/client';
import { cx } from '@harness/ui';
import { agentMs, modelColor, stragglers, type SubAgent } from '../../state/agents';
import { money } from '../../components/CostByModel';

export { modelColor, stragglers };

/** The run's clock: from the first agent's start to the last one's end (or now while any works). */
function span(agents: SubAgent[], now: number): { from: number; to: number } | undefined {
  const starts = agents.map((a) => a.startedAt).filter((x): x is number => x !== undefined);
  if (!starts.length) return undefined;
  const from = Math.min(...starts);
  const ends = agents.map((a) => (a.status === 'running' ? now : a.startedAt !== undefined ? a.startedAt + (agentMs(a, now) ?? 0) : from));
  return { from, to: Math.max(from + 1000, ...ends) };
}

const STATUS_TEXT: Record<SubAgent['status'], string> = { running: 'at work', done: 'done', failed: 'failed', stopped: 'stopped' };

export function SwarmSummary({ agents, now = Date.now() }: { agents: SubAgent[]; now?: number }): React.ReactElement {
  const count = (s: SubAgent['status']) => agents.filter((a) => a.status === s).length;
  const cost = agents.reduce((n, a) => n + a.cost, 0);
  const t = span(agents, now);
  const models = [...agents.reduce((m, a) => { const k = a.model ?? '?'; const x = m.get(k) ?? { n: 0, cost: 0, running: 0 }; m.set(k, { n: x.n + 1, cost: x.cost + a.cost, running: x.running + (a.status === 'running' ? 1 : 0) }); return m; }, new Map<string, { n: number; cost: number; running: number }>())].sort((x, y) => y[1].cost - x[1].cost);
  const slow = stragglers(agents, now);
  return (
    <div data-swarm-summary className="rounded-lg border border-hx-border-subtle bg-hx-elevated px-2.5 py-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-small">
        <span className="font-medium text-hx-primary">{agents.length} agents</span>
        {count('running') > 0 && <span data-swarm-running className="text-hx-accent-text">{count('running')} at work</span>}
        {count('done') > 0 && <span className="text-hx-success">{count('done')} done</span>}
        {count('failed') > 0 && <span className="text-hx-danger">{count('failed')} failed</span>}
        {count('stopped') > 0 && <span className="text-hx-muted">{count('stopped')} stopped</span>}
        <span className="ml-auto tabular-nums text-hx-muted">{t ? duration(t.to - t.from) : ''}{cost > 0 ? ` · ${money(cost)}` : ''}</span>
      </div>
      {cost > 0 && (
        <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-hx-pill" aria-hidden>
          {models.map(([m, x]) => <div key={m} style={{ width: `${(x.cost / cost) * 100}%`, background: modelColor(m) }} />)}
        </div>
      )}
      <div className="mt-1.5 grid gap-0.5" data-swarm-models>
        {models.map(([m, x]) => (
          <div key={m} data-swarm-model={m} className="flex items-center gap-1.5 text-tiny text-hx-secondary">
            <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: modelColor(m) }} />
            <span className="min-w-0 flex-1 truncate font-mono">{m}</span>
            <span className="tabular-nums text-hx-muted">{x.n} agent{x.n === 1 ? '' : 's'}{x.running ? ` · ${x.running} at work` : ''}</span>
            <span className="w-14 text-right tabular-nums">{money(x.cost)}</span>
          </div>
        ))}
      </div>
      {slow.size > 0 && <div data-swarm-stragglers className="mt-1.5 text-tiny text-hx-warning">The run waits on {[...slow].join(', ')}: at work well past the others.</div>}
    </div>
  );
}

/** One bar per agent on the run's clock, in the tree's order (nested agents indented). */
export function SwarmTimeline({ agents, now = Date.now() }: { agents: SubAgent[]; now?: number }): React.ReactElement {
  const t = span(agents, now);
  if (!t) return <p className="px-1 text-small text-hx-muted">No start times yet.</p>;
  const total = t.to - t.from;
  const slow = stragglers(agents, now);
  return (
    <div data-swarm-timeline className="rounded-lg border border-hx-border-subtle bg-hx-elevated px-2.5 py-2">
      <div className="mb-1 flex justify-between text-micro tabular-nums text-hx-muted"><span>0</span><span>{duration(total / 2)}</span><span>{duration(total)}</span></div>
      <div className="space-y-1">
        {agents.map((a) => {
          // One whose start is not known (a background fan-out's own call) is drawn from the run's start.
          const start = (a.startedAt ?? t.from) - t.from;
          const ms = a.status === 'running' ? now - (a.startedAt ?? t.from) : agentMs(a, now) ?? 0;
          const left = (start / total) * 100;
          const width = Math.max(1.5, (ms / total) * 100);
          return (
            <div key={a.name} data-timeline-agent={a.name} className="flex items-center gap-2">
              <span className={cx('w-24 shrink-0 truncate font-mono text-tiny', (a.depth ?? 1) > 1 ? 'pl-2 text-hx-muted' : 'text-hx-secondary')} title={a.name}>{a.name}</span>
              <div className="relative h-3 min-w-0 flex-1 rounded-sm bg-hx-pill/60">
                <div title={`${a.name} · ${a.model ?? ''} · ${STATUS_TEXT[a.status]} · ${duration(ms)}${a.cost ? ` · ${money(a.cost)}` : ''}`}
                  className={cx('absolute inset-y-0 rounded-sm', a.status === 'running' && 'animate-pulse', a.status === 'failed' && 'ring-1 ring-hx-danger', slow.has(a.name) && 'ring-1 ring-hx-warning')}
                  style={{ left: `${Math.min(left, 98.5)}%`, width: `${Math.min(width, 100 - Math.min(left, 98.5))}%`, background: modelColor(a.model), opacity: a.status === 'stopped' ? 0.4 : 1 }} />
              </div>
              <span className={cx('w-12 shrink-0 text-right text-micro tabular-nums', a.status === 'failed' ? 'text-hx-danger' : 'text-hx-muted')}>{a.status === 'failed' ? 'failed' : duration(ms)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
