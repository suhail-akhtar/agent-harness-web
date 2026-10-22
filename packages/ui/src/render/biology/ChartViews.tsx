/**
 * ```pathway (Graphviz layout, SBGN-like glyphs), the statistics plots (```volcano, ```ma,
 * ```kaplan-meier, ```manhattan as Vega-Lite through the shared figure renderer) and ```heatmap
 * (SVG with clustering dendrograms).
 */

import React, { useId, useMemo, useRef, useState } from 'react';
import { Viz } from '../Charts.tsx';
import { GraphvizView } from '../science/Science.tsx';
import { fmt } from './common.ts';
import { parsePathway, pathwayDot, pathwayTheme, EDGE_TYPES, NODE_TYPES, type EdgeType, type NodeType } from './pathway.ts';
import { dendrogramSegments, parseBioPlot, parseHeatmap, type BioPlotKind, type Heatmap } from './stats.ts';
import { Arriving, Notes, Stat, mix, useDark, useParsed } from './ui.tsx';

// ---------- pathway ----------

function NodeGlyph({ type, fill, stroke }: { type: NodeType; fill: string; stroke: string }) {
  const p = { fill, stroke, strokeWidth: 1 };
  switch (type) {
    case 'gene': return <path d="M1,2H15L19,7L15,12H1Z" {...p} />;
    case 'protein': return <rect x={1} y={2} width={18} height={10} rx={4} {...p} />;
    case 'metabolite': return <ellipse cx={10} cy={7} rx={8} ry={5} {...p} />;
    case 'complex': return <path d="M4,2H16L19,5V9L16,12H4L1,9V5Z" {...p} />;
    case 'phenotype': return <path d="M4,2H16L19,7L16,12H4L1,7Z" {...p} />;
    case 'drug': return <path d="M10,1L19,7L10,13L1,7Z" {...p} />;
  }
}
function EdgeGlyph({ type, color }: { type: EdgeType; color: string }) {
  const line = <line x1={1} x2={type === 'inhibition' ? 17 : 14} y1={7} y2={7} stroke={color} strokeWidth={1.4} strokeDasharray={type === 'binding' ? '3 2' : undefined} />;
  const head = type === 'activation' ? <path d="M13,3L19,7L13,11Z" fill="none" stroke={color} strokeWidth={1.2} />
    : type === 'conversion' ? <path d="M13,3L19,7L13,11Z" fill={color} />
    : type === 'inhibition' ? <line x1={18} x2={18} y1={2} y2={12} stroke={color} strokeWidth={1.8} />
    : type === 'catalysis' ? <circle cx={16} cy={7} r={3} fill="none" stroke={color} strokeWidth={1.3} /> : null;
  return <>{line}{head}</>;
}

export function PathwayView({ source, streaming }: { source: string; streaming?: boolean }): React.ReactElement {
  const dark = useDark();
  const parsed = useParsed(() => parsePathway(source), [source]);
  const dot = useMemo(() => (parsed.value ? pathwayDot(parsed.value, dark) : ''), [parsed, dark]);
  if (parsed.error) { if (streaming) return <Arriving what="Pathway" />; throw new Error(parsed.error); }
  const p = parsed.value!; const th = pathwayTheme(dark);
  const usedN = NODE_TYPES.filter((t) => p.nodes.some((n) => n.type === t));
  const usedE = EDGE_TYPES.filter((t) => p.edges.some((e) => e.type === t));
  return (
    <div data-pathway={p.nodes.length} className="space-y-1.5">
      <Notes notes={p.notes} />
      <div className="flex flex-wrap items-center gap-1.5">
        {p.title && <span className="mr-1 text-[13px] font-semibold text-hx-primary">{p.title}</span>}
        <Stat label="nodes" value={p.nodes.length} />
        <Stat label="interactions" value={p.edges.length} />
      </div>
      <GraphvizView source={dot} streaming={streaming} />
      <div data-pathway-legend className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-hx-secondary">
        {usedN.map((t) => <span key={t} className="inline-flex items-center gap-1"><svg width={20} height={14} aria-hidden><NodeGlyph type={t} fill={th.fills[t]} stroke={th.muted} /></svg>{t}</span>)}
        {usedE.map((t) => <span key={t} className="inline-flex items-center gap-1"><svg width={20} height={14} aria-hidden><EdgeGlyph type={t} color={th.edges[t]} /></svg>{t}</span>)}
      </div>
    </div>
  );
}

// ---------- statistics plots ----------

const PLOT_KIND: Record<string, BioPlotKind> = { volcano: 'volcano', ma: 'ma', 'ma-plot': 'ma', 'kaplan-meier': 'kaplan-meier', km: 'kaplan-meier', survival: 'kaplan-meier', manhattan: 'manhattan', gwas: 'manhattan' };

export function BioPlotView({ source, streaming, format }: { source: string; streaming?: boolean; format?: string }): React.ReactElement {
  const dark = useDark();
  const kind = PLOT_KIND[(format ?? '').toLowerCase()] ?? 'volcano';
  const parsed = useParsed(() => parseBioPlot(kind, source), [kind, source]);
  const spec = useMemo(() => (parsed.value ? JSON.stringify(parsed.value.spec) : ''), [parsed]);
  if (parsed.error) { if (streaming) return <Arriving what="Plot" />; throw new Error(parsed.error); }
  const p = parsed.value!;
  return (
    <div data-bioplot={kind} className="space-y-1">
      <Notes notes={p.notes} />
      <Viz key={dark ? 'd' : 'l'} source={spec} streaming={streaming} />
      <div className="text-[11.5px] text-hx-muted">{p.summary}</div>
    </div>
  );
}

// ---------- heatmap ----------

export function HeatmapView({ source, streaming }: { source: string; streaming?: boolean }): React.ReactElement {
  const parsed = useParsed(() => parseHeatmap(source), [source]);
  if (parsed.error) { if (streaming) return <Arriving what="Heatmap" />; throw new Error(parsed.error); }
  return <HeatmapSvg h={parsed.value!} />;
}

function HeatmapSvg({ h }: { h: Heatmap }) {
  const dark = useDark();
  const [hover, setHover] = useState<[number, number] | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const grad = `hx-heat-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const lo = dark ? '#2f80c9' : '#2a6fc0'; const hi = dark ? '#e0674a' : '#c8452b'; const mid = dark ? '#2a2c31' : '#f6f5f2';
  const seqLo = dark ? '#1b2330' : '#eef4fb'; const seqHi = dark ? '#7fb6ea' : '#18538f';
  const m = Math.max(Math.abs(h.min), Math.abs(h.max)) || 1;
  const color = (v: number | null) => {
    if (v === null) return 'transparent';
    if (h.diverging) return v < 0 ? mix(mid, lo, -v / m) : mix(mid, hi, v / m);
    return mix(seqLo, seqHi, (v - h.min) / ((h.max - h.min) || 1));
  };
  const nr = h.rows.length; const nc = h.cols.length;
  const rowDen = h.rowTree ? 64 : 0; const colDen = h.colTree ? 48 : 0;
  const labelW = Math.min(130, 8 + 6.2 * Math.max(...h.rows.map((r) => r.length)));
  const colLabelH = Math.min(90, 10 + 5 * Math.max(...h.cols.map((c) => c.length)));
  const W = 720; const top = (h.title ? 20 : 4) + colDen;
  const cw = Math.max(4, Math.min(36, (W - rowDen - labelW - 8) / nc)); const ch = Math.max(4, Math.min(20, 420 / nr));
  const gx = rowDen + 4; const H = top + nr * ch + colLabelH + 40;
  const rows = useMemo(() => (h.rowTree ? dendrogramSegments(h.rowTree) : null), [h]);
  const cols = useMemo(() => (h.colTree ? dendrogramSegments(h.colTree) : null), [h]);
  const showRowLabels = ch >= 7; const showColLabels = cw >= 7;
  const hv = hover ? h.values[h.rowOrder[hover[0]]!]![h.colOrder[hover[1]]!] : null;
  const hs = hover ? h.scaled[h.rowOrder[hover[0]]!]![h.colOrder[hover[1]]!] : null;
  const legendY = top + nr * ch + colLabelH + 8;
  return (
    <div data-heatmap={`${nr}x${nc}`} className="space-y-1">
      <Notes notes={h.notes} />
      <svg ref={svgRef} data-heatmap-svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Heatmap of ${nr} rows by ${nc} columns`} onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = svgRef.current?.getBoundingClientRect(); if (!r || !r.width) return;
          const ux = ((e.clientX - r.left) * W) / r.width; const uy = ((e.clientY - r.top) * H) / r.height;
          const j = Math.floor((ux - gx) / cw); const i = Math.floor((uy - top) / ch);
          setHover(i >= 0 && i < nr && j >= 0 && j < nc ? [i, j] : null);
        }}>
        {h.title && <text x={4} y={14} fontSize={13} fontWeight={600} fill="var(--hx-text-primary)">{h.title}</text>}
        {rows && <path data-dendrogram="rows" d={rows.segs.map(([x0, y0, x1, y1]) => `M${(rowDen - (y0 / rows.maxH) * (rowDen - 4)).toFixed(1)},${(top + (x0 + 0.5) * ch).toFixed(1)}L${(rowDen - (y1 / rows.maxH) * (rowDen - 4)).toFixed(1)},${(top + (x1 + 0.5) * ch).toFixed(1)}`).join('')} fill="none" stroke="var(--hx-text-secondary)" strokeWidth={1} />}
        {cols && <path data-dendrogram="cols" d={cols.segs.map(([x0, y0, x1, y1]) => `M${(gx + (x0 + 0.5) * cw).toFixed(1)},${(top - 2 - (y0 / cols.maxH) * (colDen - 6)).toFixed(1)}L${(gx + (x1 + 0.5) * cw).toFixed(1)},${(top - 2 - (y1 / cols.maxH) * (colDen - 6)).toFixed(1)}`).join('')} fill="none" stroke="var(--hx-text-secondary)" strokeWidth={1} />}
        {h.rowOrder.map((ri, i) => h.colOrder.map((ci, j) => (
          <rect key={`${i}-${j}`} x={gx + j * cw} y={top + i * ch} width={cw + 0.3} height={ch + 0.3} fill={color(h.scaled[ri]![ci]!)} />
        )))}
        {hover && <rect x={gx + hover[1] * cw} y={top + hover[0] * ch} width={cw} height={ch} fill="none" stroke="var(--hx-text-primary)" strokeWidth={1.4} pointerEvents="none" />}
        {showRowLabels && h.rowOrder.map((ri, i) => <text key={ri} x={gx + nc * cw + 5} y={top + i * ch + ch / 2 + 3.5} fontSize={Math.min(11, ch - 1)} fill="var(--hx-text-primary)" fontStyle="italic">{h.rows[ri]}</text>)}
        {showColLabels && h.colOrder.map((ci, j) => { const x = gx + j * cw + cw / 2; const y = top + nr * ch + 6; return <text key={ci} x={x} y={y} fontSize={Math.min(11, cw - 1)} textAnchor="end" fill="var(--hx-text-secondary)" transform={`rotate(-45 ${x} ${y})`}>{h.cols[ci]}</text>; })}
        <defs><linearGradient id={grad}>{(h.diverging ? [[0, lo], [0.5, mid], [1, hi]] : [[0, seqLo], [1, seqHi]]).map(([o, c]) => <stop key={String(o)} offset={String(o)} stopColor={String(c)} />)}</linearGradient></defs>
        <rect x={gx} y={legendY} width={160} height={9} rx={2} fill={`url(#${grad})`} stroke="var(--hx-border)" />
        <text x={gx} y={legendY + 21} fontSize={9.5} fill="var(--hx-text-muted)">{h.diverging ? (-m).toFixed(2) : h.min.toFixed(2)}</text>
        <text x={gx + 160} y={legendY + 21} fontSize={9.5} textAnchor="end" fill="var(--hx-text-muted)">{h.diverging ? m.toFixed(2) : h.max.toFixed(2)}</text>
        <text x={gx + 170} y={legendY + 8} fontSize={10} fill="var(--hx-text-secondary)">{h.scale === 'row' ? 'row z-score' : h.scale === 'col' ? 'column z-score' : 'value'}</text>
      </svg>
      <div className="min-h-[18px] text-[11.5px] text-hx-secondary">
        {hover ? `${h.rows[h.rowOrder[hover[0]]!]} × ${h.cols[h.colOrder[hover[1]]!]}: ${hv ?? 'missing'}${h.scale !== 'none' && hs !== null ? ` (z ${hs})` : ''}`
          : <span className="text-hx-muted">{fmt(nr)} rows × {fmt(nc)} columns{h.rowTree || h.colTree ? ` · clustered (${[h.rowTree && 'rows', h.colTree && 'columns'].filter(Boolean).join(' and ')}, average linkage, Euclidean)` : ''}</span>}
      </div>
    </div>
  );
}
