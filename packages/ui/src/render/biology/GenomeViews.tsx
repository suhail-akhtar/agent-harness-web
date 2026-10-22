/**
 * Maps over coordinates: ```plasmid (circular and linear), ```bed / ```gff / ```gtf / ```tracks
 * (a small genome browser), ```uniprot (feature tracks over a protein) and the 3D view of
 * ```pdb / ```cif (3Dmol in a sandboxed frame).
 */

import React, { useMemo, useState } from 'react';
import { Select } from '../../components/primitives.tsx';
import { SandboxFrame, artifactHost } from '../Artifact.tsx';
import { bp, fmt, niceTicks } from './common.ts';
import { angleOf, arcPath, linearLanes, parsePlasmid, placeLabels, spanOf, type Plasmid } from './plasmid.ts';
import { initialView, laneItems, parseTracks, type Transcript, type TrackSet } from './tracks.ts';
import { CATEGORY_COLOR, CATEGORY_ORDER, parseProteinFeatures, proteinDocument, type ProteinFeature, type ProteinTracks } from './protein.ts';
import { RESIDUE_TINT, packLanes, residueClass } from './seq.ts';
import { Arriving, Notes, Seg, Stat, ZoomButtons, useDark, useParsed, useRange, useRangeGestures } from './ui.tsx';

const strandText = (s: number) => (s === 1 ? 'forward' : s === -1 ? 'reverse' : 'no strand');

// ---------- plasmid ----------

export function PlasmidView({ source, streaming }: { source: string; streaming?: boolean }): React.ReactElement {
  const parsed = useParsed(() => parsePlasmid(source), [source]);
  const [view, setView] = useState<'circular' | 'linear'>('circular');
  const [picked, setPicked] = useState<number | null>(null);
  if (parsed.error) { if (streaming) return <Arriving what="Plasmid map" />; throw new Error(parsed.error); }
  const p = parsed.value!;
  const f = picked !== null ? p.features[picked] : undefined;
  return (
    <div data-plasmid={p.features.length} className="space-y-1.5">
      <Notes notes={p.notes} />
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[13px] font-semibold text-hx-primary">{p.name}</span>
        <Stat label="length" value={`${fmt(p.length)} bp`} />
        <Stat label="features" value={p.features.length} />
        {p.sites.length > 0 && <Stat label="sites" value={p.sites.length} />}
        <span className="flex-1" />
        <Seg label="View" value={view} onChange={setView} options={[['circular', 'Circular'], ['linear', 'Linear']]} />
      </div>
      {view === 'circular' ? <CircularMap p={p} picked={picked} onPick={setPicked} /> : <LinearMap p={p} picked={picked} onPick={setPicked} />}
      <div className="min-h-[18px] text-[11.5px] text-hx-secondary" data-plasmid-detail>
        {f ? `${f.label} · ${f.type} · ${fmt(f.start)}–${fmt(f.end)} (${fmt(spanOf(f, p.length))} bp${f.start > f.end ? ', across the origin' : ''}) · ${strandText(f.strand)}` : <span className="text-hx-muted">Click a feature for its details.</span>}
      </div>
    </div>
  );
}

function CircularMap({ p, picked, onPick }: { p: Plasmid; picked: number | null; onPick: (i: number | null) => void }) {
  const W = 720; const H = 560; const cx = W / 2; const cy = H / 2; const r = 165; const w = 16;
  const labels = useMemo(() => placeLabels([
    ...p.features.map((f, index) => { const a0 = angleOf(f.start, p.length); let a1 = angleOf(f.end + 1, p.length); if (a1 <= a0) a1 += Math.PI * 2; return { angle: (a0 + a1) / 2, text: f.label, kind: 'feature' as const, index, r: r + w / 2 }; }),
    ...p.sites.map((s, index) => ({ angle: angleOf(s.position, p.length), text: `${s.label} (${fmt(s.position)})`, kind: 'site' as const, index, r: r + 20 })),
  ], cx, cy, r + 58, 13.5, H), [p]);
  return (
    <svg data-plasmid-map="circular" viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Map of ${p.name}`}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--hx-text-muted)" strokeWidth={1.4} />
      <circle cx={cx} cy={cy} r={r - 3} fill="none" stroke="var(--hx-text-muted)" strokeWidth={0.6} />
      {niceTicks(0, p.length, 12).filter((t) => t < p.length).map((t) => { const a = angleOf(t + 1, p.length); return <g key={t}><line x1={cx + (r - 6) * Math.cos(a)} y1={cy + (r - 6) * Math.sin(a)} x2={cx + (r - 12) * Math.cos(a)} y2={cy + (r - 12) * Math.sin(a)} stroke="var(--hx-text-muted)" /><text x={cx + (r - 24) * Math.cos(a)} y={cy + (r - 24) * Math.sin(a) + 3} fontSize={9} textAnchor="middle" fill="var(--hx-text-muted)">{t === 0 ? '1' : bp(t)}</text></g>; })}
      {p.features.map((f, i) => (
        <path key={i} data-feature={f.type} d={arcPath(f, p.length, cx, cy, r, w)} fill={f.color} opacity={picked === null || picked === i ? 0.9 : 0.35} stroke={picked === i ? 'var(--hx-text-primary)' : 'none'} strokeWidth={1.2} className="cursor-pointer" onClick={() => onPick(picked === i ? null : i)}>
          <title>{`${f.label} · ${f.type} · ${fmt(f.start)}–${fmt(f.end)} · ${strandText(f.strand)}`}</title>
        </path>
      ))}
      {p.sites.map((s, i) => { const a = angleOf(s.position, p.length); return <line key={i} data-site={s.label} x1={cx + (r + 9) * Math.cos(a)} y1={cy + (r + 9) * Math.sin(a)} x2={cx + (r + 20) * Math.cos(a)} y2={cy + (r + 20) * Math.sin(a)} stroke="var(--hx-text-secondary)" strokeWidth={1.2} />; })}
      {labels.map((l, i) => (
        <g key={i} className={l.kind === 'feature' ? 'cursor-pointer' : undefined} onClick={l.kind === 'feature' ? () => onPick(picked === l.index ? null : l.index) : undefined}>
          <polyline points={`${l.ax.toFixed(1)},${l.ay.toFixed(1)} ${(l.x - (l.anchor === 'start' ? 4 : -4)).toFixed(1)},${l.y.toFixed(1)}`} fill="none" stroke="var(--hx-border)" />
          <text x={l.x} y={l.y + 3.5} fontSize={l.kind === 'feature' ? 11.5 : 10} fontWeight={l.kind === 'feature' ? 600 : 400} textAnchor={l.anchor} fill={l.kind === 'feature' ? (picked === l.index ? 'var(--hx-accent-text)' : 'var(--hx-text-primary)') : 'var(--hx-text-muted)'}>{l.text}</text>
        </g>
      ))}
      <text x={cx} y={cy - 4} fontSize={16} fontWeight={700} textAnchor="middle" fill="var(--hx-text-primary)">{p.name}</text>
      <text x={cx} y={cy + 15} fontSize={12} textAnchor="middle" fill="var(--hx-text-muted)">{fmt(p.length)} bp</text>
    </svg>
  );
}

function LinearMap({ p, picked, onPick }: { p: Plasmid; picked: number | null; onPick: (i: number | null) => void }) {
  const W = 720; const L = 12; const R = 12; const pieces = useMemo(() => linearLanes(p), [p]);
  const nl = Math.max(1, ...pieces.map((x) => x.lane + 1));
  const siteRows = Math.min(4, p.sites.length);
  const top = 14 + siteRows * 12; const axisY = top + 14; const H = axisY + 24 + nl * 26;
  const x = (pos: number) => L + ((pos - 1) / p.length) * (W - L - R);
  return (
    <svg data-plasmid-map="linear" viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Linear map of ${p.name}`}>
      {p.sites.map((s, i) => <g key={i} data-site={s.label}><line x1={x(s.position)} x2={x(s.position)} y1={top + 2} y2={axisY} stroke="var(--hx-text-muted)" /><text x={x(s.position)} y={10 + (i % Math.max(1, siteRows)) * 12} fontSize={9.5} textAnchor="middle" fill="var(--hx-text-muted)">{s.label}</text></g>)}
      <line x1={L} x2={W - R} y1={axisY} y2={axisY} stroke="var(--hx-text-secondary)" strokeWidth={1.5} />
      {niceTicks(1, p.length, 10).map((t) => <g key={t}><line x1={x(t)} x2={x(t)} y1={axisY} y2={axisY + 5} stroke="var(--hx-text-muted)" /><text x={x(t)} y={axisY + 15} fontSize={9.5} textAnchor="middle" fill="var(--hx-text-muted)">{bp(t)}</text></g>)}
      {pieces.map(({ f, index, lane, start, end }, k) => {
        const y = axisY + 24 + lane * 26; const x0 = x(start); const x1 = Math.max(x0 + 3, x(end + 1)); const h = 13; const tip = Math.min(7, (x1 - x0) / 2);
        const d = f.strand === 1 && end === f.end ? `M${x0},${y}H${x1 - tip}L${x1},${y + h / 2}L${x1 - tip},${y + h}H${x0}Z` : f.strand === -1 && start === f.start ? `M${x1},${y}H${x0 + tip}L${x0},${y + h / 2}L${x0 + tip},${y + h}H${x1}Z` : `M${x0},${y}H${x1}V${y + h}H${x0}Z`;
        return (
          <g key={k} data-feature={f.type} className="cursor-pointer" onClick={() => onPick(picked === index ? null : index)}>
            <path d={d} fill={f.color} opacity={picked === null || picked === index ? 0.9 : 0.35} stroke={picked === index ? 'var(--hx-text-primary)' : 'none'}><title>{`${f.label} · ${fmt(f.start)}–${fmt(f.end)}`}</title></path>
            {x1 - x0 > f.label.length * 6 + 6 ? <text x={(x0 + x1) / 2} y={y + 9.8} fontSize={10} fontWeight={600} textAnchor="middle" fill="#fff" pointerEvents="none">{f.label}</text>
              : <text x={x1 + 3} y={y + 9.8} fontSize={10} fill="var(--hx-text-secondary)" pointerEvents="none">{f.label}</text>}
          </g>
        );
      })}
    </svg>
  );
}

// ---------- genome tracks ----------

export function TracksView({ source, streaming, format }: { source: string; streaming?: boolean; format?: string }): React.ReactElement {
  const parsed = useParsed(() => parseTracks(source, format ?? 'tracks'), [source, format]);
  if (parsed.error) { if (streaming) return <Arriving what="Tracks" />; throw new Error(parsed.error); }
  return <Browser set={parsed.value!} />;
}

function Browser({ set }: { set: TrackSet }) {
  const [chrom, setChrom] = useState(set.region?.chrom ?? set.chroms[0] ?? '');
  const full = useMemo(() => initialView(set, chrom), [set, chrom]);
  const r = useRange(full, 20);
  const W = 720; const L = 10; const R = 10;
  const g = useRangeGestures(r, { width: W, plotLeft: L, plotRight: W - R });
  const [hover, setHover] = useState<Transcript | null>(null);
  const [s, e] = r.view; const span = e - s;
  const x = (pos: number) => L + ((pos - s) / span) * (W - L - R);
  const laid = useMemo(() => set.tracks.map((t) => (t.kind === 'genes' ? laneItems(t.items, chrom, full[1] - full[0]) : [])), [set, chrom, full]);
  let y = 30;
  const blocks = set.tracks.map((t, ti) => {
    const top = y;
    if (t.kind === 'signal') {
      const bins = t.bins.filter((b) => (!b.chrom || b.chrom === chrom) && b.end >= s && b.start <= e);
      const max = Math.max(1e-9, ...t.bins.map((b) => b.value));
      y += 64;
      return (
        <g key={ti} data-track="signal">
          <text x={L} y={top + 10} fontSize={10.5} fontWeight={600} fill="var(--hx-text-secondary)">{t.name}</text>
          <line x1={L} x2={W - R} y1={top + 56} y2={top + 56} stroke="var(--hx-border)" />
          {bins.map((b, i) => { const x0 = Math.max(L, x(b.start)); const x1 = Math.min(W - R, x(b.end + 1)); const h = (b.value / max) * 40; return <rect key={i} x={x0} width={Math.max(0.8, x1 - x0)} y={top + 56 - h} height={h} fill="var(--hx-info)" opacity={0.75}><title>{`${fmt(b.start)}–${fmt(b.end)}: ${b.value}`}</title></rect>; })}
        </g>
      );
    }
    const items = laid[ti]!;
    const lanes = Math.max(1, ...items.map((it) => it.lane + 1));
    y += 18 + lanes * 30;
    return (
      <g key={ti} data-track="genes">
        <text x={L} y={top + 10} fontSize={10.5} fontWeight={600} fill="var(--hx-text-secondary)">{t.name}</text>
        {items.filter(({ item }) => item.end >= s && item.start <= e).map(({ item: tx, lane }) => {
          const ly = top + 18 + lane * 30; const mid = ly + 17;
          const x0 = x(tx.start); const x1 = x(tx.end + 1);
          const cx0 = Math.max(L, x0); const cx1 = Math.min(W - R, x1);
          const chevrons: React.ReactNode[] = [];
          if (tx.strand && cx1 - cx0 > 24) for (let cxp = cx0 + 10; cxp < cx1 - 6; cxp += 26) chevrons.push(<path key={cxp} d={tx.strand === 1 ? `M${cxp - 2.5},${mid - 3}L${cxp + 1},${mid}L${cxp - 2.5},${mid + 3}` : `M${cxp + 2.5},${mid - 3}L${cxp - 1},${mid}L${cxp + 2.5},${mid + 3}`} fill="none" stroke="var(--hx-text-secondary)" strokeWidth={1} />);
          return (
            <g key={tx.id} data-transcript={tx.name} className="cursor-pointer" onMouseEnter={() => setHover(tx)} onMouseLeave={() => setHover(null)} onDoubleClick={() => r.set(tx.start - (tx.end - tx.start) * 0.05, tx.end + (tx.end - tx.start) * 0.05)}>
              <title>{`${tx.name} · ${tx.chrom}:${fmt(tx.start)}-${fmt(tx.end)} · ${strandText(tx.strand)} · ${tx.exons.length} exon${tx.exons.length === 1 ? '' : 's'}`}</title>
              <rect x={cx0} width={Math.max(1, cx1 - cx0)} y={ly + 8} height={18} fill="transparent" />
              <line x1={cx0} x2={cx1} y1={mid} y2={mid} stroke="var(--hx-text-secondary)" strokeWidth={1.2} />
              {chevrons}
              {tx.exons.map(([a, b], k) => {
                const ex0 = Math.max(L, x(a)); const ex1 = Math.min(W - R, x(b + 1)); if (ex1 < L || ex0 > W - R) return null;
                const parts: React.ReactNode[] = [<rect key="u" x={ex0} width={Math.max(1, ex1 - ex0)} y={mid - 4} height={8} fill="#3b7dd8" opacity={tx.cds ? 0.55 : 0.9} />];
                if (tx.cds) { const c0 = Math.max(a, tx.cds[0]); const c1 = Math.min(b, tx.cds[1]); if (c1 >= c0) { const q0 = Math.max(L, x(c0)); const q1 = Math.min(W - R, x(c1 + 1)); parts.push(<rect key="c" x={q0} width={Math.max(1, q1 - q0)} y={mid - 7} height={14} fill="#3b7dd8" />); } }
                return <g key={k}>{parts}</g>;
              })}
              <text x={Math.min(Math.max(cx0, L + 2), W - R - 60)} y={ly + 6} fontSize={10.5} fill="var(--hx-text-primary)" fontStyle="italic">{tx.name}{tx.strand ? (tx.strand === 1 ? ' →' : ' ←') : ''}</text>
            </g>
          );
        })}
      </g>
    );
  });
  const H = y + 6;
  return (
    <div data-tracks={set.tracks.length} className="space-y-1.5">
      <Notes notes={set.notes} />
      <div className="flex flex-wrap items-center gap-1.5">
        {set.chroms.length > 1 ? <Select aria-label="Chromosome" className="w-40" value={chrom} onChange={setChrom} options={set.chroms.map((c) => ({ value: c, label: c || '(no chromosome)' }))} /> : <Stat label="chrom" value={chrom || '—'} />}
        <Stat label="view" value={`${fmt(Math.round(s))}–${fmt(Math.round(e))} (${bp(span)})`} />
        <span className="flex-1" />
        <ZoomButtons r={r} />
      </div>
      <svg ref={g.ref} {...g.handlers} data-genome-tracks viewBox={`0 0 ${W} ${H}`} className="w-full touch-none select-none" style={{ cursor: 'grab' }} role="img" aria-label="Genome tracks">
        <line x1={L} x2={W - R} y1={16} y2={16} stroke="var(--hx-text-muted)" />
        {niceTicks(s, e, 7).map((t) => <g key={t}><line x1={x(t)} x2={x(t)} y1={12} y2={20} stroke="var(--hx-text-muted)" /><text x={x(t)} y={9} fontSize={9.5} textAnchor="middle" fill="var(--hx-text-muted)">{bp(t)}</text></g>)}
        {blocks}
      </svg>
      <div className="min-h-[18px] text-[11.5px] text-hx-secondary" data-track-detail>
        {hover ? `${hover.name} · ${hover.type} · ${hover.chrom}:${fmt(hover.start)}-${fmt(hover.end)} (${bp(hover.end - hover.start + 1)}) · ${strandText(hover.strand)} · ${hover.exons.length} exon${hover.exons.length === 1 ? '' : 's'}${hover.cds ? ` · CDS ${fmt(hover.cds[0])}-${fmt(hover.cds[1])}` : ''}${hover.info.length ? ` · ${hover.info.map(([k, v]) => `${k}=${v}`).join(' ')}` : ''}`
          : <span className="text-hx-muted">Drag to pan, Ctrl+wheel or the buttons to zoom, double-click a gene to fit it.</span>}
      </div>
    </div>
  );
}

// ---------- protein feature tracks ----------

export function ProteinFeaturesView({ source, streaming }: { source: string; streaming?: boolean }): React.ReactElement {
  const parsed = useParsed(() => parseProteinFeatures(source), [source]);
  if (parsed.error) { if (streaming) return <Arriving what="Protein features" />; throw new Error(parsed.error); }
  return <ProteinTracksView p={parsed.value!} />;
}

function ProteinTracksView({ p }: { p: ProteinTracks }) {
  const full = useMemo((): [number, number] => [1, p.length + 1], [p]);
  const r = useRange(full, 12);
  const W = 720; const LW = 128; const R = 10;
  const g = useRangeGestures(r, { width: W, plotLeft: LW, plotRight: W - R });
  const [hover, setHover] = useState<ProteinFeature | null>(null);
  const [s, e] = r.view; const x = (pos: number) => LW + ((pos - s) / (e - s)) * (W - LW - R);
  const cats = CATEGORY_ORDER.map((c) => ({ c, lanes: packLanes(p.features.filter((f) => f.category === c), 0) })).filter((c) => c.lanes.length);
  let y = 28;
  const rows = cats.map(({ c, lanes }) => {
    const top = y; const n = Math.max(1, ...lanes.map((l) => l.lane + 1)); y += n * 18 + 8;
    return (
      <g key={c} data-category={c}>
        <text x={6} y={top + 12} fontSize={10.5} fontWeight={600} fill="var(--hx-text-secondary)">{c}</text>
        <line x1={LW} x2={W - R} y1={top + n * 18 + 3} y2={top + n * 18 + 3} stroke="var(--hx-border-subtle)" />
        {lanes.filter(({ item }) => item.end + 1 >= s && item.start <= e).map(({ item: f, lane }, i) => {
          const fy = top + lane * 18 + 3; const x0 = Math.max(LW, x(f.start)); const x1 = Math.min(W - R, x(f.end + 1)); const col = CATEGORY_COLOR[f.category];
          const single = f.end === f.start;
          const disulfide = /disulfide/i.test(f.type) && f.end > f.start;
          return (
            <g key={i} data-feature={f.type} onMouseEnter={() => setHover(f)} onMouseLeave={() => setHover(null)} className="cursor-pointer">
              <title>{`${f.type}${f.description ? `: ${f.description}` : ''} · ${f.start}${f.end !== f.start ? `–${f.end}` : ''}`}</title>
              {disulfide ? <path d={`M${x(f.start + 0.5)},${fy + 13}V${fy + 3}H${x(f.end + 0.5)}V${fy + 13}`} fill="none" stroke={col} strokeWidth={1.6} />
                : single ? <path d={`M${x(f.start + 0.5)},${fy + 1}l5,6l-5,6l-5,-6Z`} fill={col} />
                : <rect x={x0} width={Math.max(2, x1 - x0)} y={fy + 1} height={12} rx={3} fill={col} opacity={0.85} />}
              {!single && !disulfide && x1 - x0 > (f.description || f.type).length * 5.6 + 8 && <text x={(x0 + x1) / 2} y={fy + 10.5} fontSize={9.5} textAnchor="middle" fill="#fff" fontWeight={600} pointerEvents="none">{f.description || f.type}</text>}
            </g>
          );
        })}
      </g>
    );
  });
  const seqTop = y + 2; const visible = Math.ceil(e - s);
  const showLetters = p.sequence && visible <= 90; const showBars = p.sequence && !showLetters && visible <= 2500;
  const H = seqTop + (p.sequence ? 22 : 0) + 4;
  const residues: React.ReactNode[] = [];
  if (showLetters || showBars) for (let i = Math.max(1, Math.floor(s)); i < Math.min(p.length + 1, Math.ceil(e)); i++) {
    const c = p.sequence[i - 1] ?? 'X'; const x0 = x(i); const w = x(i + 1) - x0;
    residues.push(showLetters
      ? <g key={i}><rect x={x0} width={w} y={seqTop} height={16} fill={RESIDUE_TINT[residueClass(c, 'protein')]} /><text x={x0 + w / 2} y={seqTop + 12} fontSize={10.5} fontFamily="var(--hx-font-mono)" textAnchor="middle" fill="var(--hx-text-primary)">{c}</text></g>
      : <rect key={i} x={x0} width={Math.max(0.6, w)} y={seqTop} height={10} fill={RESIDUE_TINT[residueClass(c, 'protein')]} />);
  }
  return (
    <div data-protein-features={p.features.length} className="space-y-1.5">
      <Notes notes={p.notes} />
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[13px] font-semibold text-hx-primary">{p.name}</span>
        {p.accession && <Stat label="UniProt" value={p.accession} />}
        <Stat label="length" value={`${fmt(p.length)} aa`} />
        <Stat label="features" value={p.features.length} />
        <span className="flex-1" />
        <ZoomButtons r={r} />
      </div>
      <svg ref={g.ref} {...g.handlers} data-protein-tracks viewBox={`0 0 ${W} ${H}`} className="w-full touch-none select-none" role="img" aria-label={`Features of ${p.name}`}>
        <line x1={LW} x2={W - R} y1={16} y2={16} stroke="var(--hx-text-muted)" />
        {niceTicks(s, e, 8).filter((t) => t >= 1).map((t) => <g key={t}><line x1={x(t)} x2={x(t)} y1={12} y2={20} stroke="var(--hx-text-muted)" /><text x={x(t)} y={9} fontSize={9.5} textAnchor="middle" fill="var(--hx-text-muted)">{fmt(Math.round(t))}</text></g>)}
        {rows}
        {p.sequence && <text x={6} y={seqTop + 11} fontSize={10.5} fontWeight={600} fill="var(--hx-text-secondary)">Sequence</text>}
        {residues}
      </svg>
      <div className="min-h-[18px] text-[11.5px] text-hx-secondary">
        {hover ? `${hover.type}${hover.description ? ` · ${hover.description}` : ''} · ${hover.start}${hover.end !== hover.start ? `–${hover.end} (${hover.end - hover.start + 1} aa)` : ''}${p.sequence ? ` · ${p.sequence.slice(hover.start - 1, Math.min(hover.end, hover.start + 19))}${hover.end - hover.start >= 20 ? '…' : ''}` : ''}`
          : <span className="text-hx-muted">Hover a feature; zoom in to read the residues.</span>}
        {' '}
        {cats.map(({ c }) => <span key={c} className="ml-2 inline-flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: CATEGORY_COLOR[c] }} />{c}</span>)}
      </div>
    </div>
  );
}

// ---------- 3D protein ----------

/** ```pdb / ```cif: cartoon by secondary structure, chain colours, ligands and a residue picker, in a sandboxed frame. */
export function Protein3D({ source, format, streaming }: { source: string; format?: string; streaming?: boolean }): React.ReactElement {
  const dark = useDark();
  const doc = useMemo(() => proteinDocument(source, (format ?? 'pdb').toLowerCase(), artifactHost().runtimeUrl, dark), [source, format, dark]);
  if (streaming) return <Arriving what="Structure" />;
  if (!/^\s*\S/.test(source) || source.length > 3_000_000) throw new Error('the structure is empty or too large');
  if (!/^(ATOM|HETATM)/m.test(source) && !/_atom_site\./.test(source)) throw new Error('no ATOM or HETATM records (a PDB file) and no _atom_site loop (an mmCIF file)');
  return <SandboxFrame key={dark ? 'd' : 'l'} doc={doc} scripted label="3D protein structure" marker="molecule" initialHeight={380} fixedHeight />;
}
