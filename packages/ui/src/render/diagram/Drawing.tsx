/**
 * A laid-out diagram as SVG: clean cards on the canvas (an icon square in the kind's tone, a
 * small-caps caption, a bold title, a muted technology line), status badges, a dashed border for
 * integrated or bought systems, pill-shaped people, ER tables with key marks, nested zone boxes
 * with a coloured dashed border and a header, orthogonal edges with their labels in small pills,
 * and the flow being played over it all.
 *
 * Colours come from the theme's CSS variables (light and dark for free); the export resolves them
 * (export.ts). Everything is memoised per node and per edge, so a drag or a selection redraws only
 * what changed, and panning (a transform on one group) redraws nothing.
 */

import React from 'react';
import type { DiagramView, GroupKind, NodeKind, Tone } from '@harness/plugin-ui';
import { Glyph } from './icons.tsx';
import { captionOf, detailLines, TABLE_ROWS, type Scene, type SceneEdge, type SceneGroup, type SceneNode } from './layout.ts';
import { roundedPath, pointAt } from './paths.ts';

export const TONE_HEX: Record<Tone, string> = { blue: '#3b82f6', green: '#16a34a', amber: '#d97706', red: '#dc2626', purple: '#7c3aed', teal: '#0d9488', gray: '#64748b', pink: '#db2777', indigo: '#4f46e5', orange: '#ea580c' };

const KIND_TONE: Record<NodeKind, Tone> = {
  person: 'green', 'web-app': 'blue', 'mobile-app': 'blue', 'desktop-app': 'blue', browser: 'blue', device: 'blue',
  api: 'indigo', service: 'indigo', function: 'indigo', worker: 'indigo', 'batch-job': 'indigo', container: 'indigo', custom: 'indigo',
  'relational-db': 'purple', 'document-db': 'purple', 'key-value': 'purple', table: 'purple', storage: 'purple', search: 'purple',
  cache: 'teal', queue: 'orange', stream: 'orange',
  'reverse-proxy': 'amber', 'load-balancer': 'amber', gateway: 'amber', cdn: 'amber', dns: 'amber', internet: 'gray',
  secrets: 'red', identity: 'red', monitoring: 'pink', 'external-system': 'gray', folder: 'blue', file: 'gray',
};
export const GROUP_TONE: Record<GroupKind, Tone> = { host: 'gray', network: 'blue', zone: 'amber', subnet: 'teal', cluster: 'indigo', region: 'purple', boundary: 'blue' };
const GROUP_CAPTION: Record<GroupKind, string> = { host: 'Host', network: 'Network', zone: 'Zone', subnet: 'Subnet', cluster: 'Cluster', region: 'Region', boundary: 'Boundary' };

/** The colour of a node's icon: its kind's, or (code view) its group's. */
export function toneOf(n: SceneNode, groupTone: (id: string) => Tone | undefined, view: DiagramView): string {
  if (n.collapsed) return TONE_HEX[n.collapsed.tone ?? GROUP_TONE[n.collapsed.kind]];
  if (n.node?.tone) return TONE_HEX[n.node.tone];
  const k = n.node?.kind ?? 'custom';
  if ((view === 'code' || k === 'folder' || k === 'file') && n.parent) { const t = groupTone(n.parent); if (t) return TONE_HEX[t]; }
  return TONE_HEX[KIND_TONE[k] ?? 'indigo'];
}

/** The theme-aware styles of every diagram (inside the SVG, so an export carries them). */
export const DIAGRAM_CSS = `
.hx-dg{font-family:var(--hx-font,'Inter','Segoe UI',system-ui,sans-serif);--dg-card:var(--hx-elevated,#fefefd);--dg-border:var(--hx-border,rgba(31,30,28,.14));--dg-text:var(--hx-text-primary,#1f1e1c);--dg-muted:var(--hx-text-muted,#8c8a85);--dg-sub:var(--hx-text-secondary,#5b5a56);--dg-bg:var(--hx-bg,#faf9f6);--dg-accent:var(--hx-accent,#d97757);--dg-line:var(--hx-text-muted,#8c8a85);--dg-ok:#16a34a;--dg-warn:#d97706;--dg-bad:#dc2626;--dg-amber:#f59e0b}
.hx-dg text{dominant-baseline:auto}
.hx-dg .dg-card{fill:var(--dg-card);stroke:var(--dg-border);stroke-width:1}
.hx-dg .dg-card.int{stroke-dasharray:5 4;stroke:var(--dg-muted);stroke-opacity:.8}
.hx-dg .dg-shadow{fill:#000;opacity:.05}
.hx-dg .dg-cap{font-size:9.5px;font-weight:600;letter-spacing:.07em;fill:var(--dg-muted)}
.hx-dg .dg-title{font-size:13.5px;font-weight:650;fill:var(--dg-text)}
.hx-dg .dg-tech{font-size:11.5px;fill:var(--dg-muted)}
.hx-dg .dg-mono{font-family:var(--hx-font-mono,'Cascadia Code',Consolas,monospace);font-size:10.5px;fill:var(--dg-muted)}
.hx-dg .dg-row{font-size:12px;fill:var(--dg-text)}
.hx-dg .dg-row.pk{font-weight:650}
.hx-dg .dg-edge{fill:none;stroke:var(--dg-line);stroke-width:1.4;stroke-opacity:.85}
.hx-dg .dg-edge.async{stroke-dasharray:6 5}
.hx-dg .dg-edge.hot{stroke:var(--dg-accent);stroke-width:2;stroke-opacity:1}
.hx-dg .dg-edge.new{stroke:var(--dg-amber);stroke-width:1.9;stroke-opacity:1}
.hx-dg .dg-pill{fill:var(--dg-card);stroke:var(--dg-border)}
.hx-dg .dg-pill-t{font-size:10.5px;font-weight:500;fill:var(--dg-sub)}
.hx-dg .dg-card-sel{fill:none;stroke:var(--dg-accent);stroke-width:2}
.hx-dg .dg-match{fill:none;stroke:var(--dg-amber);stroke-width:2;stroke-dasharray:4 3}
.hx-dg .dg-dim{opacity:.2}
.hx-dg .dg-node,.hx-dg .dg-e{transition:opacity .2s}
.hx-dg.live .dg-node{cursor:pointer}
.hx-dg.live .dg-node:hover .dg-card{stroke:var(--dg-sub)}
.hx-dg.live .dg-hit{fill:none;stroke:transparent;stroke-width:12;cursor:pointer}
.hx-dg .dg-gbtn{cursor:pointer}
.hx-dg .dg-gbtn:hover rect{fill:var(--dg-border)}
.hx-dg .dg-spin{animation:dg-spin 1.1s linear infinite;transform-box:fill-box;transform-origin:center}
@keyframes dg-spin{to{transform:rotate(360deg)}}
.hx-dg .dg-march{fill:none;stroke:var(--dg-accent);stroke-width:2.6;stroke-linecap:round;stroke-dasharray:7 7;animation:dg-march .55s linear infinite}
@keyframes dg-march{to{stroke-dashoffset:-14}}
.hx-dg .dg-trail{fill:none;stroke:var(--dg-accent);stroke-width:2.6;stroke-opacity:.35}
.hx-dg .dg-draw{fill:none;stroke:var(--dg-accent);stroke-width:2.6;stroke-dasharray:1;stroke-dashoffset:1;animation:dg-draw var(--dg-draw,.7s) ease-out forwards}
@keyframes dg-draw{to{stroke-dashoffset:0}}
.hx-dg .dg-step{fill:var(--dg-accent)}
.hx-dg .dg-step-t{font-size:11px;font-weight:600;fill:#fff}
.hx-dg[data-lod='low'] .dg-t{display:none}
@media (prefers-reduced-motion:reduce){.hx-dg .dg-spin,.hx-dg .dg-march{animation:none}.hx-dg .dg-draw{animation-duration:.01s}}
html[data-motion='reduced'] .hx-dg .dg-spin,html[data-motion='reduced'] .hx-dg .dg-march{animation:none}
:root.dark .hx-dg .dg-shadow,:root[data-theme='dark'] .hx-dg .dg-shadow{opacity:.22}
`;

/** Text cut to roughly `px` wide (per: average glyph width). */
export function fit(s: string, px: number, per: number): string {
  const max = Math.max(1, Math.floor(px / per));
  return s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s;
}

// ---------------- nodes ----------------

interface NodeProps { n: SceneNode; tone: string; selected: boolean; dim: boolean; changed: boolean; match: boolean; live: boolean }

function StatusBadge({ status, x, y }: { status: string; x: number; y: number }) {
  if (status === 'done') return <g data-status="done"><circle cx={x} cy={y} r={8} fill="var(--dg-ok)" /><path d={`M${x - 3.6} ${y + 0.2} l2.5 2.5 l4.8 -5`} fill="none" stroke="#fff" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" /></g>;
  if (status === 'in-progress') return <g data-status="in-progress"><circle cx={x} cy={y} r={7} fill="none" stroke="var(--dg-warn)" strokeOpacity={0.25} strokeWidth={2.2} /><g className="dg-spin"><path d={`M${x} ${y - 7} a7 7 0 0 1 7 7`} fill="none" stroke="var(--dg-warn)" strokeWidth={2.2} strokeLinecap="round" /></g></g>;
  if (status === 'failing') return <g data-status="failing"><circle cx={x} cy={y} r={8} fill="var(--dg-bad)" /><path d={`M${x} ${y - 4}v4.6`} stroke="#fff" strokeWidth={2} strokeLinecap="round" /><circle cx={x} cy={y + 3.6} r={1.2} fill="#fff" /></g>;
  if (status === 'planned') return <g data-status="planned"><circle cx={x} cy={y} r={7} fill="none" stroke="var(--dg-muted)" strokeWidth={1.6} strokeDasharray="2.6 2.2" /></g>;
  return null;
}

function ChangedPill({ x, y }: { x: number; y: number }) {
  return <g data-changed=""><rect x={x} y={y} width={54} height={17} rx={8.5} fill="var(--dg-amber)" /><text x={x + 27} y={y + 12} textAnchor="middle" fontSize={9.5} fontWeight={700} fill="#fff" letterSpacing=".03em">changed</text></g>;
}

function Findings({ count, worst, x, y }: { count: number; worst: string; x: number; y: number }) {
  const color = worst === 'critical' || worst === 'high' ? 'var(--dg-bad)' : worst === 'medium' ? 'var(--dg-warn)' : 'var(--dg-muted)';
  const label = `${count} finding${count === 1 ? '' : 's'}`;
  const w = label.length * 5.6 + 18;
  return <g data-findings={count}><rect x={x - w} y={y} width={w} height={15} rx={7.5} fill={color} fillOpacity={0.12} /><circle cx={x - w + 8} cy={y + 7.5} r={2.6} fill={color} /><text x={x - w + 14} y={y + 11} fontSize={9.5} fontWeight={600} fill={color}>{label}</text></g>;
}

const SEVERITY = ['info', 'low', 'medium', 'high', 'critical'];

export const NodeView = React.memo(function NodeView({ n, tone, selected, dim, changed, match, live }: NodeProps) {
  const node = n.node;
  const cls = `dg-node${dim ? ' dg-dim' : ''}`;
  const common = { 'data-node-id': n.id, className: cls, transform: `translate(${n.x} ${n.y})` } as const;
  const isChanged = changed || !!node?.changed;
  const sel = selected ? <rect className="dg-card-sel" x={-3} y={-3} width={n.w + 6} height={n.h + 6} rx={n.node?.kind === 'person' ? (n.h + 6) / 2 : 13} /> : null;
  const ring = match ? <rect className="dg-match" x={-5} y={-5} width={n.w + 10} height={n.h + 10} rx={n.node?.kind === 'person' ? (n.h + 10) / 2 : 15} /> : null;

  if (n.collapsed) {
    const g = n.collapsed;
    return (
      <g {...common} data-collapsed-group={g.id}>
        <rect className="dg-shadow" x={1} y={2} width={n.w} height={n.h} rx={11} />
        <rect className="dg-card" x={0} y={0} width={n.w} height={n.h} rx={11} stroke={tone} strokeDasharray="6 4" />
        <rect x={12} y={(n.h - 40) / 2} width={40} height={40} rx={9} fill={tone} fillOpacity={0.13} />
        <Glyph kind={g.kind} x={22} y={(n.h - 40) / 2 + 10} size={20} color={tone} />
        <g className="dg-t">
          <text className="dg-cap" x={64} y={n.h / 2 - 9}>{`${GROUP_CAPTION[g.kind]} · collapsed`.toUpperCase()}</text>
          <text className="dg-title" x={64} y={n.h / 2 + 7}>{fit(g.label, n.w - 80, 7.5)}</text>
          <text className="dg-tech" x={64} y={n.h / 2 + 22}>{n.members ?? 0} node{n.members === 1 ? '' : 's'} inside</text>
        </g>
        {sel}{ring}
      </g>
    );
  }
  if (!node) return null;
  if (node.kind === 'person') {
    const r = n.h / 2;
    return (
      <g {...common} data-kind="person">
        <rect className="dg-shadow" x={1} y={2} width={n.w} height={n.h} rx={r} />
        <rect className={`dg-card${node.integrated ? ' int' : ''}`} x={0} y={0} width={n.w} height={n.h} rx={r} />
        <circle cx={r} cy={r} r={r - 9} fill={tone} fillOpacity={0.14} />
        <Glyph kind="person" x={r - 10} y={r - 10} size={20} color={tone} />
        <g className="dg-t">
          <text className="dg-title" x={2 * r + 2} y={node.tech ? r - 2 : r + 5}>{fit(node.title, n.w - 2 * r - 18, 7.5)}</text>
          {node.tech && <text className="dg-tech" x={2 * r + 2} y={r + 13}>{fit(node.tech, n.w - 2 * r - 18, 6.3)}</text>}
        </g>
        {node.status && <StatusBadge status={node.status} x={n.w - r + 1} y={r} />}
        {isChanged && <ChangedPill x={n.w - 70} y={-9} />}
        {sel}{ring}
      </g>
    );
  }
  if (node.fields?.length || node.kind === 'table') {
    const fields = node.fields ?? [];
    const shown = fields.slice(0, TABLE_ROWS);
    const more = fields.length - shown.length;
    return (
      <g {...common} data-kind="table">
        <rect className="dg-shadow" x={1} y={2} width={n.w} height={n.h} rx={10} />
        <rect className={`dg-card${node.integrated ? ' int' : ''}`} x={0} y={0} width={n.w} height={n.h} rx={10} />
        <rect x={12} y={10} width={28} height={28} rx={7} fill={tone} fillOpacity={0.13} />
        <Glyph kind="table" x={17} y={15} size={18} color={tone} />
        <g className="dg-t">
          <text className="dg-cap" x={50} y={20}>{(node.tech ? fit(node.tech, n.w - 90, 6.4) : 'TABLE').toUpperCase()}</text>
          <text className="dg-title" x={50} y={36}>{fit(node.title, n.w - 80, 7.7)}</text>
        </g>
        {shown.length > 0 && <path d={`M0 48H${n.w}`} stroke="var(--dg-border)" />}
        <g className="dg-t">
          {shown.map((f, i) => {
            const y = 48 + i * 22;
            const key = f.pk ? 'PK' : f.fk ? 'FK' : f.uk ? 'UK' : '';
            const kc = f.pk ? 'var(--dg-warn)' : f.fk ? '#3b82f6' : '#7c3aed';
            const typeW = f.type ? Math.min(90, f.type.length * 6.2) : 0;
            const name = fit(f.name, n.w - 42 - 14 - typeW - 8 - (f.pii ? 30 : 0), 6.9);
            return (
              <g key={i} data-field={f.name}>
                {i > 0 && <path d={`M10 ${y}H${n.w - 10}`} stroke="var(--dg-border)" strokeOpacity={0.5} />}
                {key && <><rect x={10} y={y + 4} width={24} height={14} rx={3.5} fill={kc} fillOpacity={0.14} /><text x={22} y={y + 14.5} textAnchor="middle" fontSize={8.5} fontWeight={700} fill={kc}>{key}</text></>}
                <text className={`dg-row${f.pk ? ' pk' : ''}`} x={42} y={y + 15}>{name}</text>
                {f.pii && <g data-pii=""><rect x={46 + name.length * 6.9} y={y + 5} width={24} height={13} rx={6.5} fill="#e11d48" fillOpacity={0.12} /><text x={58 + name.length * 6.9} y={y + 14.5} textAnchor="middle" fontSize={8.5} fontWeight={700} fill="#e11d48">pii</text></g>}
                {f.type && <text className="dg-mono" x={n.w - 12} y={y + 15} textAnchor="end">{fit(f.type, 90, 6.2)}</text>}
              </g>
            );
          })}
          {more > 0 && <text className="dg-tech" x={42} y={48 + shown.length * 22 + 15} data-more={more}>+ {more} more</text>}
        </g>
        {node.status && <StatusBadge status={node.status} x={n.w - 16} y={16} />}
        {isChanged && <ChangedPill x={n.w - 70} y={-9} />}
        {sel}{ring}
      </g>
    );
  }
  const lines = detailLines(node);
  const textTop = (n.h - (node.findings?.length ? 16 : 0) - (28 + lines.length * 16)) / 2;
  const worst = node.findings?.reduce((w, f) => (SEVERITY.indexOf(f.severity) > SEVERITY.indexOf(w) ? f.severity : w), 'info') ?? 'info';
  const caption = captionOf(node);
  return (
    <g {...common} data-kind={node.kind}>
      <rect className="dg-shadow" x={1} y={2} width={n.w} height={n.h} rx={11} />
      <rect className={`dg-card${node.integrated ? ' int' : ''}`} x={0} y={0} width={n.w} height={n.h} rx={11} />
      <rect x={12} y={(n.h - 40) / 2} width={40} height={40} rx={9} fill={tone} fillOpacity={0.13} />
      <Glyph kind={node.kind} x={22} y={(n.h - 40) / 2 + 10} size={20} color={tone} />
      <g className="dg-t">
        <text className="dg-cap" x={64} y={textTop + 10}>{fit(caption.toUpperCase(), n.w - 98 + 8, 7)}</text>
        <text className="dg-title" x={64} y={textTop + 27}>{fit(node.title, n.w - 98, 7.5)}</text>
        {lines.map((l, i) => <text key={i} className={i === 0 && node.tech ? 'dg-tech' : 'dg-mono'} x={64} y={textTop + 43 + i * 16}>{fit(l, n.w - 78, 6.4)}</text>)}
      </g>
      {node.status && <StatusBadge status={node.status} x={n.w - 16} y={16} />}
      {node.findings?.length ? <Findings count={node.findings.length} worst={worst} x={n.w - 10} y={n.h - 22} /> : null}
      {isChanged && <ChangedPill x={n.w - 70} y={-9} />}
      {sel}{ring}
    </g>
  );
});

// ---------------- groups ----------------

export const GroupView = React.memo(function GroupView({ g, live, dim }: { g: SceneGroup; live: boolean; dim: boolean }) {
  const tone = TONE_HEX[g.group.tone ?? GROUP_TONE[g.group.kind]];
  const host = g.group.kind === 'host';
  const label = g.group.label.toUpperCase();
  const labelW = label.length * 7.4;
  return (
    <g data-group-id={g.id} data-group-kind={g.group.kind} className={dim ? 'dg-dim' : undefined}>
      <rect x={g.x} y={g.y} width={g.w} height={g.h} rx={14} fill={host ? 'var(--dg-sub)' : tone} fillOpacity={host ? 0.03 : 0.04} stroke={host ? 'var(--dg-border)' : tone} strokeOpacity={host ? 1 : 0.7} strokeWidth={host ? 1.2 : 1.3} strokeDasharray={host ? undefined : '7 5'} />
      <Glyph kind={g.group.kind} x={g.x + 14} y={g.y + 14} size={16} color={host ? 'var(--dg-sub)' : tone} />
      <g className="dg-t">
        <text x={g.x + 38} y={g.y + 27} fontSize={11} fontWeight={700} letterSpacing=".08em" fill={host ? 'var(--dg-sub)' : tone}>{fit(label, g.w - 90, 7.4)}</text>
        {g.group.subtitle && labelW + 60 < g.w - 40 && <text x={g.x + 38 + labelW + 10} y={g.y + 27} fontSize={11} fill="var(--dg-muted)">{fit(g.group.subtitle, g.w - labelW - 88, 6.1)}</text>}
      </g>
      {live && (
        <g className="dg-gbtn" data-collapse={g.id} role="button" aria-label={`Collapse ${g.group.label}`}>
          <rect x={g.x + g.w - 30} y={g.y + 10} width={20} height={20} rx={5} fill="transparent" />
          <path d={`M${g.x + g.w - 25} ${g.y + 22}l5 -5l5 5`} fill="none" stroke="var(--dg-muted)" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
        </g>
      )}
    </g>
  );
});

// ---------------- edges ----------------

export const EdgeView = React.memo(function EdgeView({ e, hot, dim, isNew, live, selected }: { e: SceneEdge; hot: boolean; dim: boolean; isNew: boolean; live: boolean; selected: boolean }) {
  const d = roundedPath(e.points);
  const er = !!e.edge.cardinality;
  const cls = `dg-edge${e.edge.async ? ' async' : ''}${hot || selected ? ' hot' : isNew ? ' new' : ''}`;
  const marker = er ? undefined : hot || selected ? 'url(#dg-arrow-hot)' : isNew ? 'url(#dg-arrow-new)' : 'url(#dg-arrow)';
  return (
    <g data-edge-id={e.id} className={`dg-e${dim ? ' dg-dim' : ''}`}>
      <path className={cls} d={d} markerEnd={marker} />
      {er && <Cardinality points={e.points} card={e.edge.cardinality!} />}
      {live && <path className="dg-hit" d={d} />}
    </g>
  );
});

function Cardinality({ points, card }: { points: number[]; card: string }) {
  const [a, b] = card.split(':') as [string, string];
  const end = (atStart: boolean) => {
    const p = pointAt(points, atStart ? 0 : 1);
    const ux = atStart ? p.dx : -p.dx; const uy = atStart ? p.dy : -p.dy;
    return { x: p.x + ux * 12 - uy * 9, y: p.y + uy * 12 + ux * 9 + 3.5 };
  };
  const s = end(true); const t = end(false);
  return <g className="dg-t" fontSize={10.5} fontWeight={700} fill="var(--dg-sub)"><text x={s.x} y={s.y} textAnchor="middle">{a === 'n' ? 'n' : a}</text><text x={t.x} y={t.y} textAnchor="middle">{b === 'n' || b === 'm' ? b : b}</text></g>;
}

export const LabelView = React.memo(function LabelView({ e, dim, hot }: { e: SceneEdge; dim: boolean; hot: boolean }) {
  const l = e.label;
  if (!l) return null;
  return (
    <g data-edge-label={e.id} className={`dg-t${dim ? ' dg-dim' : ''}`}>
      <rect className="dg-pill" x={l.x} y={l.y} width={l.w} height={l.h} rx={l.h / 2} stroke={hot ? 'var(--dg-accent)' : undefined} />
      <text className="dg-pill-t" x={l.x + l.w / 2} y={l.y + l.h / 2 + 3.6} textAnchor="middle">{fit(l.text, l.w - 10, 6.1)}</text>
    </g>
  );
});

// ---------------- the flow being played ----------------

export interface FlowDraw { steps: Array<{ key: string; index: number; points: number[]; label: string; current: boolean }>; drawMs: number }

function FlowLayer({ flow }: { flow: FlowDraw }) {
  return (
    <g data-flow-layer="" pointerEvents="none">
      {flow.steps.map((s) => {
        const d = roundedPath(s.points);
        return (
          <g key={s.key} data-flow-step={s.index} data-current={s.current ? '1' : '0'}>
            <path className="dg-trail" d={d} />
            {s.current ? <path key={`draw-${s.key}`} className="dg-draw" d={d} pathLength={1} style={{ ['--dg-draw' as string]: `${flow.drawMs}ms` }} /> : null}
            <path className="dg-march" d={d} markerEnd="url(#dg-arrow-hot)" />
          </g>
        );
      })}
      {flow.steps.filter((s) => s.current).map((s) => {
        const mid = pointAt(s.points, 0.5);
        const text = `${s.index + 1}. ${s.label}`;
        const w = Math.min(320, text.length * 6.6 + 20);
        return (
          <g key={`label-${s.key}`} data-flow-label={s.index}>
            <rect className="dg-step" x={mid.x - w / 2} y={mid.y - 12} width={w} height={24} rx={12} />
            <text className="dg-step-t" x={mid.x} y={mid.y + 4} textAnchor="middle">{fit(text, w - 14, 6.6)}</text>
          </g>
        );
      })}
    </g>
  );
}

// ---------------- the whole drawing ----------------

export interface DrawState {
  selected?: { type: 'node' | 'edge'; id: string } | null;
  /** Nodes kept bright (everything else dims); null: all bright. */
  bright?: ReadonlySet<string> | null;
  brightEdges?: ReadonlySet<string> | null;
  changed?: ReadonlySet<string>;
  changedEdges?: ReadonlySet<string>;
  matches?: ReadonlySet<string>;
  flow?: FlowDraw | null;
}

export interface DrawingProps {
  scene: Scene;
  view: DiagramView;
  state?: DrawState;
  live?: boolean;
  /** The group panning and zooming move (the canvas sets its transform directly). */
  cameraRef?: React.Ref<SVGGElement>;
  svgRef?: React.Ref<SVGSVGElement>;
  /** Static: a viewBox around the drawing, scaled to the width it is given. */
  fitToBox?: boolean;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
  lod?: 'low' | 'high';
}

const NONE: ReadonlySet<string> = new Set();
export const PAD = 28;

export function Drawing({ scene, view, state = {}, live = false, cameraRef, svgRef, fitToBox, className, style, title, lod }: DrawingProps): React.ReactElement {
  const groupTone = React.useMemo(() => { const m = new Map(scene.groups.map((g) => [g.id, g.group.tone ?? GROUP_TONE[g.group.kind]])); return (id: string) => m.get(id); }, [scene]);
  const sel = state.selected ?? null;
  const bright = state.bright ?? null;
  const brightEdges = state.brightEdges ?? null;
  const changed = state.changed ?? NONE;
  const changedEdges = state.changedEdges ?? NONE;
  const matches = state.matches ?? NONE;
  const selNode = sel?.type === 'node' ? sel.id : null;
  const brightGroups = React.useMemo(() => {
    if (!bright) return null;
    const parentOf = new Map(scene.groups.map((g) => [g.id, g.group.parent]));
    const out = new Set<string>();
    for (const n of scene.nodes) if (bright.has(n.id)) for (let g = n.parent; g && !out.has(g); g = parentOf.get(g)) out.add(g);
    return out;
  }, [scene, bright]);
  const b = scene.bounds;
  const vb = `${b.x - PAD} ${b.y - PAD} ${b.w + PAD * 2} ${b.h + PAD * 2}`;
  return (
    <svg
      ref={svgRef}
      xmlns="http://www.w3.org/2000/svg"
      className={`hx-dg${live ? ' live' : ''} ${className ?? ''}`}
      data-diagram-svg=""
      data-lod={lod ?? 'high'}
      {...(fitToBox ? { viewBox: vb, width: '100%', preserveAspectRatio: 'xMidYMin meet' } : { width: '100%', height: '100%' })}
      style={style}
      role="img"
      aria-label={title ?? 'Diagram'}
    >
      <style>{DIAGRAM_CSS}</style>
      <defs>
        {(['dg-arrow', 'dg-arrow-hot', 'dg-arrow-new'] as const).map((id) => (
          <marker key={id} id={id} viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse" markerUnits="userSpaceOnUse">
            <path d="M0 0.8 L9.5 5 L0 9.2 Z" fill={id === 'dg-arrow' ? 'var(--dg-line)' : id === 'dg-arrow-hot' ? 'var(--dg-accent)' : 'var(--dg-amber)'} />
          </marker>
        ))}
      </defs>
      <g ref={cameraRef} data-camera="">
        <g data-layer="groups">{scene.groups.map((g) => <GroupView key={g.id} g={g} live={live} dim={!!brightGroups && !brightGroups.has(g.id)} />)}</g>
        <g data-layer="edges">
          {scene.edges.map((e) => {
            const hot = !!selNode && (e.from === selNode || e.to === selNode);
            const dim = !!(brightEdges ? !brightEdges.has(e.id) : bright && !(bright.has(e.from) && bright.has(e.to)));
            return <EdgeView key={e.id} e={e} hot={hot} dim={dim} isNew={e.ids.some((id) => changedEdges.has(id))} live={live} selected={sel?.type === 'edge' && sel.id === e.id} />;
          })}
        </g>
        <g data-layer="labels">
          {scene.edges.map((e) => <LabelView key={e.id} e={e} hot={(!!selNode && (e.from === selNode || e.to === selNode)) || (sel?.type === 'edge' && sel.id === e.id)} dim={!!(brightEdges ? !brightEdges.has(e.id) : bright && !(bright.has(e.from) && bright.has(e.to)))} />)}
        </g>
        <g data-layer="nodes">
          {scene.nodes.map((n) => (
            <NodeView key={n.id} n={n} tone={toneOf(n, groupTone, view)} selected={selNode === n.id} dim={!!bright && !bright.has(n.id)} changed={changed.has(n.id)} match={matches.has(n.id)} live={live} />
          ))}
        </g>
        {state.flow && <FlowLayer flow={state.flow} />}
      </g>
    </svg>
  );
}
