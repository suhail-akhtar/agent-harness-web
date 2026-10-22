/**
 * ```fasta / ```sequence: a sequence viewer (residue colours, ruler, wrapping, drag to select,
 * features as tracks, GC, length, weight, reverse complement, three-frame translation), and
 * ```msa / ```clustal: an alignment grid with conservation bars and a consensus row.
 */

import React, { useMemo, useRef, useState } from 'react';
import { IconButton, Select } from '../../components/primitives.tsx';
import { copyText } from '../download.ts';
import { LIMITS, fmt, niceTicks, tooLarge } from './common.ts';
import { LEGEND, RESIDUE_TINT, gcContent, molecularWeight, packLanes, parseSequences, residueClass, reverseComplement, translate, type SeqFeature, type SeqRecord } from './seq.ts';
import { colourRuns, columnStats, parseAlignment, schemeFor, type MsaScheme } from './msa.ts';
import { Arriving, Notes, Seg, Stat, Toggle, useParsed } from './ui.tsx';

const LINE = 60;
const kda = (d: number) => (d >= 10_000 ? `${(d / 1000).toFixed(1)} kDa` : `${d.toFixed(1)} Da`);

export function SequenceView({ source, streaming }: { source: string; streaming?: boolean }): React.ReactElement {
  const parsed = useParsed(() => parseSequences(source), [source]);
  if (parsed.error) { if (streaming) return <Arriving what="Sequence" />; throw new Error(parsed.error); }
  const { records, notes } = parsed.value!;
  return <SequenceRecords records={records} notes={notes} />;
}

function SequenceRecords({ records, notes }: { records: SeqRecord[]; notes: string[] }) {
  const [idx, setIdx] = useState(0);
  const rec = records[Math.min(idx, records.length - 1)]!;
  return (
    <div data-sequence={rec.type} className="space-y-2">
      <Notes notes={notes} />
      {records.length > 1 && (
        <div className="flex items-center gap-2 text-[12px] text-hx-muted">
          <span>{records.length} sequences</span>
          <Select aria-label="Sequence" className="w-64" value={String(idx)} onChange={(v) => setIdx(Number(v))} options={records.map((r, i) => ({ value: String(i), label: `${r.name} (${fmt(r.seq.length)})` }))} />
        </div>
      )}
      <OneSequence key={idx} rec={rec} />
    </div>
  );
}

function OneSequence({ rec }: { rec: SeqRecord }) {
  const nucleic = rec.type !== 'protein';
  const [rc, setRc] = useState(false);
  const [frames, setFrames] = useState(false);
  const [sel, setSel] = useState<[number, number] | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const anchor = useRef<number | null>(null);
  const len = rec.seq.length;
  const seq = useMemo(() => (rc ? reverseComplement(rec.seq, rec.type) : rec.seq), [rc, rec]);
  const shown = seq.slice(0, LIMITS.seqView);
  // Features in the displayed orientation (reverse complement flips coordinates and strands).
  const feats = useMemo(() => (rc ? rec.features.map((f) => ({ ...f, start: len - f.end + 1, end: len - f.start + 1, strand: (-f.strand) as SeqFeature['strand'] })) : rec.features), [rc, rec, len]);
  const stats = useMemo(() => ({ gc: nucleic ? gcContent(rec.seq) : undefined, mw: molecularWeight(rec.seq, rec.type) }), [rec, nucleic]);
  const tx = useMemo(() => (frames && nucleic ? ([0, 1, 2] as const).map((f) => translate(shown, f)) : null), [frames, nucleic, shown]);
  const lo = sel ? Math.min(sel[0], sel[1]) : -1; const hi = sel ? Math.max(sel[0], sel[1]) : -1;
  const selected = sel ? seq.slice(lo, hi + 1) : '';
  const at = (e: React.PointerEvent | React.MouseEvent) => { const i = Number((e.target as HTMLElement).dataset?.i); return Number.isInteger(i) ? i : null; };
  const lines: number[] = [];
  for (let s = 0; s < shown.length; s += LINE) lines.push(s);
  const featAt = (i: number) => feats.filter((f) => f.start <= i + 1 && i + 1 <= f.end).map((f) => f.label).join(', ');
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[13px] font-semibold text-hx-primary">{rec.name}</span>
        {rec.description && <span className="mr-1 truncate text-[12px] text-hx-muted">{rec.description}</span>}
        <Stat label={rec.type === 'protein' ? 'protein' : rec.type.toUpperCase()} value={`${fmt(len)} ${nucleic ? (rec.type === 'rna' ? 'nt' : 'bp') : 'aa'}`} />
        {stats.gc !== undefined && <Stat label="GC" value={`${(stats.gc * 100).toFixed(1)}%`} />}
        <Stat label="MW" value={kda(stats.mw)} />
        {rec.features.length > 0 && <Stat label="features" value={rec.features.length} />}
        <span className="flex-1" />
        {nucleic && <Toggle on={rc} onChange={(v) => { setRc(v); setSel(null); }}>Reverse complement</Toggle>}
        {nucleic && <Toggle on={frames} onChange={setFrames}>Translate (3 frames)</Toggle>}
      </div>
      <SeqMap len={len} feats={feats} sel={sel ? [lo, hi] : null} onPick={(f) => setSel([f.start - 1, f.end - 1])} />
      {seq.length > LIMITS.seqView && <Notes notes={[tooLarge(LIMITS.seqView, seq.length, 'residues (statistics use all of them)')]} />}
      <div
        data-seq-body
        className="max-h-[420px] select-none overflow-auto rounded-lg bg-hx-code px-2 py-1.5 font-mono text-[12.5px] leading-[19px] text-hx-primary"
        onPointerDown={(e) => { const i = at(e); if (i === null) { setSel(null); return; } anchor.current = i; setSel([i, i]); }}
        onPointerOver={(e) => { const i = at(e); setHover(i); if (i !== null && anchor.current !== null && e.buttons === 1) setSel([anchor.current, i]); }}
        onPointerUp={() => { anchor.current = null; }}
        onPointerLeave={() => { setHover(null); }}
      >
        {lines.map((s) => (
          <div key={s} className="flex whitespace-pre">
            <span className="mr-2 inline-block w-[7ch] shrink-0 text-right text-hx-muted">{s + 1}</span>
            <span className="inline-block">
              <span className="block text-[10px] leading-[12px] text-hx-muted">{Array.from({ length: Math.ceil(Math.min(LINE, shown.length - s) / 10) }, (_, g) => <span key={g} className="inline-block w-[10ch] text-right" style={{ marginRight: g < 5 ? '1ch' : 0 }}>{s + g * 10 + 10 <= shown.length ? s + g * 10 + 10 : ''}</span>)}</span>
              <span className="block">
                {shown.slice(s, s + LINE).split('').map((c, k) => {
                  const i = s + k; const inSel = i >= lo && i <= hi;
                  return <span key={k} data-i={i} style={{ background: inSel ? 'var(--hx-accent-soft)' : RESIDUE_TINT[residueClass(c, rec.type)], boxShadow: inSel ? 'inset 0 -2px var(--hx-accent)' : undefined, marginRight: k % 10 === 9 && k < LINE - 1 ? '1ch' : 0 }}>{c}</span>;
                })}
              </span>
              {tx && tx.map((p, f) => (
                <span key={f} data-frame={f + 1} className="block text-hx-secondary">
                  {shown.slice(s, s + LINE).split('').map((_, k) => {
                    const i = s + k; const codonIdx = (i - f - 1) / 3; const aa = Number.isInteger(codonIdx) && codonIdx >= 0 ? p[codonIdx] : undefined;
                    return <span key={k} style={{ marginRight: k % 10 === 9 && k < LINE - 1 ? '1ch' : 0, color: aa === '*' ? 'var(--hx-danger)' : aa === 'M' ? 'var(--hx-success)' : undefined, fontWeight: aa === 'M' || aa === '*' ? 600 : undefined }}>{aa ?? ' '}</span>;
                  })}
                  <span className="ml-2 text-[10px] text-hx-muted">+{f + 1}</span>
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
      <div className="flex min-h-[22px] flex-wrap items-center gap-2 text-[11.5px] text-hx-secondary">
        {sel ? (
          <>
            <span data-seq-selection>Selected {fmt(lo + 1)}–{fmt(hi + 1)} ({fmt(hi - lo + 1)} {nucleic ? 'bp' : 'aa'}){nucleic ? ` · GC ${(gcContent(selected) * 100).toFixed(1)}%` : ''}{nucleic && selected.length >= 3 ? ` · ${translate(selected).slice(0, 24)}${selected.length > 72 ? '…' : ''}` : ''}</span>
            <IconButton size="xs" icon="copy" label="Copy the selection" onClick={() => void copyText(selected)} />
            <button type="button" className="text-hx-muted underline" onClick={() => setSel(null)}>clear</button>
          </>
        ) : hover !== null ? (
          <span>Position {fmt(hover + 1)} · {seq[hover]}{featAt(hover) ? ` · ${featAt(hover)}` : ''}</span>
        ) : <span className="text-hx-muted">Drag across residues to select; click a feature to select it.</span>}
        <span className="flex-1" />
        {LEGEND[nucleic ? 'nucleotide' : 'protein'].map(([l, c]) => <span key={l} className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: RESIDUE_TINT[c] }} />{l}</span>)}
      </div>
    </div>
  );
}

/** The whole sequence at a glance: a ruler, features as arrows in lanes (click one to select it), the selection window. */
function SeqMap({ len, feats, sel, onPick }: { len: number; feats: SeqFeature[]; sel: [number, number] | null; onPick: (f: SeqFeature) => void }) {
  const W = 720; const L = 8; const R = 8; const lanes = packLanes(feats, len * 0.004);
  const nl = Math.max(0, ...lanes.map((l) => l.lane + 1));
  const H = 26 + nl * 20;
  const x = (p: number) => L + ((p - 1) / Math.max(1, len)) * (W - L - R);
  return (
    <svg data-seq-map viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Sequence map">
      <line x1={L} x2={W - R} y1={10} y2={10} stroke="var(--hx-text-muted)" />
      {niceTicks(1, len, 8).map((t) => <g key={t}><line x1={x(t)} x2={x(t)} y1={6} y2={14} stroke="var(--hx-text-muted)" /><text x={x(t)} y={24} fontSize={9.5} textAnchor="middle" fill="var(--hx-text-muted)">{fmt(t)}</text></g>)}
      {sel && <rect x={x(sel[0] + 1)} width={Math.max(2, x(sel[1] + 2) - x(sel[0] + 1))} y={2} height={H - 4} fill="var(--hx-accent-soft)" stroke="var(--hx-accent)" strokeWidth={0.8} />}
      {lanes.map(({ item: f, lane }, i) => {
        const y = 30 + lane * 20; const x0 = x(f.start); const x1 = Math.max(x0 + 3, x(f.end + 1)); const h = 11; const tip = Math.min(6, (x1 - x0) / 2);
        const d = f.strand === 1 ? `M${x0},${y}H${x1 - tip}L${x1},${y + h / 2}L${x1 - tip},${y + h}H${x0}Z` : f.strand === -1 ? `M${x1},${y}H${x0 + tip}L${x0},${y + h / 2}L${x0 + tip},${y + h}H${x1}Z` : `M${x0},${y}H${x1}V${y + h}H${x0}Z`;
        return (
          <g key={i} data-feature={f.type} className="cursor-pointer" onClick={() => onPick(f)}>
            <path d={d} fill={f.color} opacity={0.85}><title>{`${f.label} · ${f.type} · ${fmt(f.start)}–${fmt(f.end)}${f.strand ? (f.strand === 1 ? ' (+)' : ' (−)') : ''}`}</title></path>
            {x1 - x0 > f.label.length * 5.6 + 6 ? <text x={(x0 + x1) / 2} y={y + 8.6} fontSize={9.5} textAnchor="middle" fill="#fff" fontWeight={600} pointerEvents="none">{f.label}</text>
              : <text x={x1 + 3} y={y + 8.6} fontSize={9.5} fill="var(--hx-text-secondary)" pointerEvents="none">{f.label}</text>}
          </g>
        );
      })}
    </svg>
  );
}

// ---------- alignment ----------

export function MsaView({ source, streaming }: { source: string; streaming?: boolean }): React.ReactElement {
  const parsed = useParsed(() => parseAlignment(source), [source]);
  const [scheme, setScheme] = useState<MsaScheme>('auto');
  const [hover, setHover] = useState<number | null>(null);
  if (parsed.error) { if (streaming) return <Arriving what="Alignment" />; throw new Error(parsed.error); }
  const a = parsed.value!;
  return <MsaGrid a={a} scheme={scheme} setScheme={setScheme} hover={hover} setHover={setHover} />;
}

function MsaGrid({ a, scheme, setScheme, hover, setHover }: { a: ReturnType<typeof parseAlignment>; scheme: MsaScheme; setScheme: (s: MsaScheme) => void; hover: number | null; setHover: (n: number | null) => void }) {
  const cols = useMemo(() => columnStats(a), [a]);
  const sch = schemeFor(a, scheme);
  const runs = useMemo(() => a.rows.map((r) => colourRuns(r, cols, sch)), [a, cols, sch]);
  const ruler = useMemo(() => { const chars = Array<string>(a.columns).fill(' '); for (let c = 10; c <= a.columns; c += 10) { const s = String(c); for (let k = 0; k < s.length; k++) chars[c - s.length + k] = s[k]!; } return chars.join(''); }, [a.columns]);
  const conserved = cols.filter((c) => c.conserved).length;
  const nameW = Math.min(18, Math.max(12, ...a.names.map((n) => n.length))) + 1;
  const colAt = (e: React.MouseEvent) => {
    const el = e.currentTarget as HTMLElement; const r = el.getBoundingClientRect();
    const ch = (el.scrollWidth || r.width) / Math.max(1, a.columns); const c = Math.floor((e.clientX - r.left + el.scrollLeft - 8) / ch);
    return c >= 0 && c < a.columns ? c : null;
  };
  return (
    <div data-msa={a.rows.length} className="space-y-1.5">
      <Notes notes={a.notes} />
      <div className="flex flex-wrap items-center gap-1.5">
        <Stat label="sequences" value={a.rows.length} />
        <Stat label="columns" value={fmt(a.columns)} />
        <Stat label="identical columns" value={`${((conserved / Math.max(1, a.columns)) * 100).toFixed(0)}%`} />
        <Stat label="type" value={a.type === 'protein' ? 'protein' : a.type.toUpperCase()} />
        <span className="flex-1" />
        <Seg label="Colour scheme" value={scheme} onChange={setScheme} options={[['auto', 'Auto'], ['clustal', 'Clustal'], ['nucleotide', 'Nucleotide'], ['identity', 'Identity'], ['none', 'None']]} />
      </div>
      <div className="flex rounded-lg bg-hx-code font-mono text-[12.5px] leading-[18px]">
        <div className="shrink-0 whitespace-nowrap border-r border-hx-border-subtle py-1.5 pl-2 pr-1 text-hx-secondary" style={{ width: `${nameW + 1}ch` }}>
          <div className="text-[10px] text-hx-muted">&nbsp;</div>
          {a.names.map((n, i) => <div key={i} className="truncate" title={n}>{n}</div>)}
          <div className="font-semibold text-hx-muted">consensus</div>
          <div className="h-[28px] text-[10px] text-hx-muted">conservation</div>
        </div>
        <div data-msa-scroll className="min-w-0 flex-1 overflow-x-auto py-1.5 pl-2 pr-2" onMouseMove={(e) => setHover(colAt(e))} onMouseLeave={() => setHover(null)}>
          <div className="w-max whitespace-pre">
            <div className="text-[10px] text-hx-muted">{ruler}</div>
            {runs.map((row, i) => <div key={i} data-msa-row={i}>{row.map((r, k) => <span key={k} style={r.color ? { background: r.color } : undefined}>{r.text}</span>)}</div>)}
            <div data-msa-consensus className="font-semibold text-hx-primary">{cols.map((c) => c.consensus).join('')}</div>
            <svg data-msa-conservation viewBox={`0 0 ${a.columns} 1`} preserveAspectRatio="none" style={{ width: `${a.columns}ch`, height: 28, display: 'block' }} aria-label="Conservation per column">
              {cols.map((c, i) => <rect key={i} x={i + 0.08} width={0.84} y={1 - c.identity} height={c.identity} fill={c.conserved ? 'var(--hx-accent)' : 'var(--hx-text-muted)'} opacity={c.conserved ? 0.9 : 0.55} />)}
            </svg>
          </div>
        </div>
      </div>
      <div className="min-h-[18px] text-[11.5px] text-hx-secondary">
        {hover !== null && cols[hover] ? `Column ${hover + 1}: ${cols[hover].consensus.toUpperCase()} in ${Math.round(cols[hover].identity * 100)}% of rows${cols[hover].gaps ? ` · ${cols[hover].gaps} gap${cols[hover].gaps === 1 ? '' : 's'}` : ''}${cols[hover].conserved ? ' · fully conserved' : ''}` : <span className="text-hx-muted">Scroll sideways for more columns; hover for a column's consensus.</span>}
      </div>
    </div>
  );
}
