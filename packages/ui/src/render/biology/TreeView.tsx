/** ```newick / ```nwk / ```phyloxml: a phylogenetic tree, rectangular or circular, with branch lengths, support values and collapsible clades. */

import React, { useMemo, useState } from 'react';
import { ZoomPan } from '../ZoomPan.tsx';
import { layoutTree, parseTree } from './tree.ts';
import { Arriving, Notes, Seg, Stat, Toggle, useParsed } from './ui.tsx';

export function TreeView({ source, streaming, format }: { source: string; streaming?: boolean; format?: string }): React.ReactElement {
  const parsed = useParsed(() => parseTree(source, format === 'phyloxml' ? 'phyloxml' : 'newick'), [source, format]);
  const [mode, setMode] = useState<'rectangular' | 'circular'>('rectangular');
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set());
  const [support, setSupport] = useState(true);
  const lay = useMemo(() => (parsed.value ? layoutTree(parsed.value, { mode, collapsed }) : null), [parsed, mode, collapsed]);
  if (parsed.error) { if (streaming) return <Arriving what="Tree" />; throw new Error(parsed.error); }
  const t = parsed.value!; const L = lay!;
  const toggle = (id: number) => setCollapsed((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const tall = mode === 'rectangular' && L.height > 520;
  const svg = (
    <svg data-tree={mode} viewBox={`0 0 ${L.width} ${L.height}`} className="w-full" style={tall ? { height: L.height } : { maxHeight: mode === 'circular' ? 520 : undefined }} role="img" aria-label={`Phylogenetic tree of ${t.leaves} leaves`}>
      <path d={L.paths.join('')} fill="none" stroke="var(--hx-text-secondary)" strokeWidth={1.4} strokeLinecap="square" />
      {L.nodes.map((n) => {
        const circ = mode === 'circular' && n.angle !== undefined;
        const deg = circ ? (n.angle! * 180) / Math.PI : 0; const flip = circ && Math.cos(n.angle!) < 0;
        const lx = n.tipX ?? n.x; const ly = n.tipY ?? n.y;
        const label = n.collapsed ? `${n.name ? `${n.name} ` : ''}(${n.collapsed} leaves)` : n.name;
        return (
          <g key={n.id} data-node={n.leaf ? 'leaf' : 'internal'}>
            {n.tipX !== undefined && <line x1={n.x} y1={n.y} x2={lx} y2={ly} stroke="var(--hx-border)" strokeDasharray="2 3" />}
            {n.collapsed !== undefined && (circ
              ? <circle cx={n.x} cy={n.y} r={6} fill="var(--hx-accent-soft)" stroke="var(--hx-accent)" className="cursor-pointer" onClick={() => toggle(n.id)}><title>Expand this clade</title></circle>
              : <path d={`M${n.x},${n.y}L${n.x + 22},${n.y - 7}V${n.y + 7}Z`} fill="var(--hx-accent-soft)" stroke="var(--hx-accent)" className="cursor-pointer" onClick={() => toggle(n.id)}><title>Expand this clade</title></path>)}
            {n.leaf && label && (circ
              ? <text x={lx} y={ly} dy={3.5} fontSize={11} fill="var(--hx-text-primary)" textAnchor={flip ? 'end' : 'start'} transform={`rotate(${flip ? deg + 180 : deg} ${lx} ${ly}) translate(${flip ? -6 : 6} 0)`}>{label}</text>
              : <text x={lx + (n.collapsed !== undefined ? 27 : 5)} y={ly} dy={3.8} fontSize={11.5} fill="var(--hx-text-primary)" fontStyle={n.collapsed !== undefined ? undefined : 'italic'}>{label}</text>)}
            {!n.leaf && (
              <circle data-collapse={n.id} cx={n.x} cy={n.y} r={3.6} fill="var(--hx-bg)" stroke="var(--hx-accent)" strokeWidth={1.3} className="cursor-pointer" onClick={() => toggle(n.id)}>
                <title>{`Collapse this clade${n.name ? ` (${n.name})` : ''}${n.support !== undefined ? ` · support ${n.support}` : ''}`}</title>
              </circle>
            )}
            {!n.leaf && support && n.support !== undefined && <text x={n.x - 4} y={n.y - 5} fontSize={9.5} textAnchor="end" fill="var(--hx-text-muted)">{n.support}</text>}
          </g>
        );
      })}
      {L.scale && <g data-scale><line x1={L.scale.x} x2={L.scale.x + L.scale.len} y1={L.scale.y} y2={L.scale.y} stroke="var(--hx-text-primary)" strokeWidth={1.4} /><text x={L.scale.x + L.scale.len / 2} y={L.scale.y - 4} fontSize={10} textAnchor="middle" fill="var(--hx-text-secondary)">{L.scale.label}</text></g>}
    </svg>
  );
  return (
    <div data-phylo={t.leaves} className="space-y-1.5">
      <Notes notes={t.notes} />
      <div className="flex flex-wrap items-center gap-1.5">
        <Stat label="leaves" value={t.leaves} />
        <Stat label="branch lengths" value={t.hasLengths ? 'yes' : 'no (cladogram)'} />
        {collapsed.size > 0 && <button type="button" className="text-[11.5px] text-hx-muted underline" onClick={() => setCollapsed(new Set())}>expand all</button>}
        <span className="flex-1" />
        {t.hasSupport && <Toggle on={support} onChange={setSupport}>Support values</Toggle>}
        <Seg label="Layout" value={mode} onChange={setMode} options={[['rectangular', 'Rectangular'], ['circular', 'Circular']]} />
      </div>
      {tall ? <div className="max-h-[520px] overflow-y-auto">{svg}</div> : <ZoomPan>{svg}</ZoomPan>}
      <p className="text-[11px] text-hx-muted">Click a node to collapse or expand its clade.</p>
    </div>
  );
}
