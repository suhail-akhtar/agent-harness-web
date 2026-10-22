/**
 * A workflow run drawn as a graph: each node with its status (and outcome, and how often it ran)
 * and, for agent nodes, the agent and model; click a node for its latest output. A simple layered
 * layout (workflow-layout.ts); the interactive diagrams plugin has the richer canvas.
 */

import React, { useMemo, useState } from 'react';
import type { WorkflowRunView } from '@harness/client';
import { Markdown, cx } from '@harness/ui';
import { NODE_H, NODE_W, edgePath, layoutWorkflow, nodeState } from './workflow-layout';

const FILL: Record<string, string> = {
  running: 'var(--hx-accent-soft)', done: 'color-mix(in srgb, var(--hx-success) 14%, transparent)', failed: 'color-mix(in srgb, var(--hx-danger) 14%, transparent)',
  waiting: 'color-mix(in srgb, var(--hx-warning) 16%, transparent)', interrupted: 'var(--hx-pill)', pending: 'transparent',
};
const STROKE: Record<string, string> = { running: 'var(--hx-accent)', done: 'var(--hx-success)', failed: 'var(--hx-danger)', waiting: 'var(--hx-warning)', interrupted: 'var(--hx-border)', pending: 'var(--hx-border)' };

export function WorkflowGraph({ run }: { run: WorkflowRunView }): React.ReactElement {
  const layout = useMemo(() => layoutWorkflow(run.nodes, run.start), [run.nodes, run.start]);
  const [picked, setPicked] = useState<string | null>(null);
  const back = layout.edges.some((e) => e.back);
  const width = layout.width + (back ? 70 : 0);
  const out = picked ? [...run.history].reverse().find((h) => h.node === picked) : undefined;
  const node = picked ? run.nodes.find((n) => n.id === picked) : undefined;
  return (
    <div data-workflow-graph>
      <div className="hx-scroll overflow-x-auto">
        <svg width={width} height={layout.height} viewBox={`0 0 ${width} ${layout.height}`} className="mx-auto block text-hx-primary" role="img" aria-label={`Graph of ${run.workflow}`}>
          <defs><marker id={`arrow-${run.id}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" fill="var(--hx-text-muted)" /></marker></defs>
          {layout.edges.map((e, i) => <path key={i} d={edgePath(layout, e)} fill="none" stroke="var(--hx-text-muted)" strokeOpacity={0.6} strokeWidth={1.3} strokeDasharray={e.back ? '4 3' : undefined} markerEnd={`url(#arrow-${run.id})`} />)}
          {run.nodes.map((n) => {
            const p = layout.nodes[n.id];
            if (!p) return null;
            const st = nodeState(run.history, n.id, run.current);
            const sub = n.type === 'agent' || n.agent ? `${n.agent ?? 'general'}${n.model ? ` · ${n.model}` : ''}` : n.type;
            return (
              <g key={n.id} data-graph-node={n.id} data-node-status={st.status} transform={`translate(${p.x},${p.y})`} className="cursor-pointer outline-none" onClick={() => setPicked(picked === n.id ? null : n.id)} role="button" tabIndex={0} aria-label={`${n.title ?? n.id}: ${st.status}`} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setPicked(picked === n.id ? null : n.id); }}>
                <rect width={NODE_W} height={NODE_H} rx={9} fill={FILL[st.status] ?? 'transparent'} stroke={picked === n.id ? 'var(--hx-accent)' : STROKE[st.status] ?? 'var(--hx-border)'} strokeWidth={picked === n.id ? 2 : 1.2} className={st.status === 'running' ? 'hx-thinking' : ''} />
                <text x={10} y={20} fontSize={12.5} fontWeight={600} fill="currentColor">{clip(n.title ?? n.id, 22)}</text>
                <text x={10} y={38} fontSize={10.5} fill="var(--hx-text-muted)">{clip(sub, 26)}</text>
                {(st.outcome || st.runs > 1) && <text x={NODE_W - 8} y={20} fontSize={10} textAnchor="end" fill="var(--hx-text-secondary)">{st.outcome ? clip(st.outcome, 10) : ''}{st.runs > 1 ? ` ×${st.runs}` : ''}</text>}
              </g>
            );
          })}
        </svg>
      </div>
      {picked && (
        <div data-graph-output={picked} className="mx-2 mb-2 rounded-lg border border-hx-border-subtle bg-hx-bg p-2.5">
          <div className="mb-1 flex items-center gap-2 text-[12px]"><b>{node?.title ?? picked}</b><span className="text-hx-muted">{node?.type}{node?.agent ? ` · ${node.agent}` : ''}{node?.model ? ` · ${node.model}` : ''}</span>{out?.outcome && <span className="rounded bg-hx-pill px-1.5 text-[11px]">{out.outcome}</span>}{out?.cost ? <span className="ml-auto text-[11px] text-hx-muted">${out.cost.toFixed(4)}</span> : null}</div>
          {out?.summary ? <div className={cx('hx-scroll max-h-72 overflow-auto text-[12.5px]')}><Markdown text={out.type === 'gate' || out.type === 'shell' ? `\`\`\`\n${out.summary}\n\`\`\`` : out.summary} /></div> : <p className="text-[12px] text-hx-muted">{out ? 'No output yet.' : 'This step has not run.'}</p>}
        </div>
      )}
    </div>
  );
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
