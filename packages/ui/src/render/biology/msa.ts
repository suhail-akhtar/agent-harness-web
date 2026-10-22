/**
 * Multiple sequence alignments: ```msa / ```clustal / ```aln blocks in aligned FASTA, CLUSTAL or
 * Stockholm. Every row has the same number of columns (gaps as - or .). Conservation per column,
 * a consensus row and the colour of each cell under a few schemes. Pure; tested.
 */

import { LIMITS, checkSize, isObj, parseJson, text, tooLarge } from './common.ts';
import { detectType, type SeqType } from './seq.ts';

export interface Alignment { names: string[]; rows: string[]; type: SeqType; columns: number; notes: string[] }
export type MsaScheme = 'auto' | 'clustal' | 'nucleotide' | 'identity' | 'none';

const LETTERS = /^[A-Za-z*.\-~?]*$/;

export function parseAlignment(source: string): Alignment {
  checkSize(source, 'alignment');
  const src = source.trim();
  const pairs: Array<[string, string]> = [];
  const add = (name: string, chunk: string) => {
    const last = pairs.find((p) => p[0] === name);
    if (last) last[1] += chunk; else pairs.push([name, chunk]);
  };
  if (src.startsWith('{') || src.startsWith('[')) {
    const j = parseJson(src, 'alignment');
    const list = Array.isArray(j) ? j : isObj(j) && Array.isArray(j.sequences) ? j.sequences : null;
    if (!list) throw new Error('the alignment JSON is {"sequences": [{"name", "sequence"}]}');
    list.forEach((r, i) => { if (!isObj(r) || typeof (r.sequence ?? r.seq) !== 'string') throw new Error(`row ${i + 1} needs a "sequence"`); pairs.push([text(r.name ?? r.id ?? `seq${i + 1}`, 40), String(r.sequence ?? r.seq)]); });
  } else if (src.startsWith('>')) {
    let name = '';
    for (const line of src.split(/\r?\n/)) {
      if (line.startsWith('>')) { name = text(line.slice(1).trim().split(/\s+/)[0] || `seq${pairs.length + 1}`, 40); pairs.push([name, '']); }
      else if (name) pairs[pairs.length - 1]![1] += line.trim();
    }
  } else {
    // CLUSTAL / MUSCLE / Stockholm: "name  residues [count]" lines in blocks; headers, comments and conservation lines skipped.
    for (const line of src.split(/\r?\n/)) {
      if (!line.trim() || /^(CLUSTAL|MUSCLE|PROBCONS|T-COFFEE|#|\/\/)/i.test(line.trim()) || /^\s/.test(line)) continue;
      const m = /^(\S+)\s+(\S+)(\s+\d+)?\s*$/.exec(line);
      if (!m) throw new Error(`cannot read this alignment line: "${text(line, 60)}" (expected "name residues")`);
      add(text(m[1], 40), m[2]!);
    }
  }
  if (pairs.length < 2) throw new Error('an alignment needs at least two sequences (aligned FASTA, CLUSTAL or Stockholm)');
  const notes: string[] = [];
  for (const [n, s] of pairs) if (!LETTERS.test(s)) { const i = s.search(/[^A-Za-z*.\-~?]/); throw new Error(`${n}: "${text(s[i], 4)}" at column ${i + 1} is not a residue or a gap`); }
  const width = pairs[0]![1].length;
  const odd = pairs.find((p) => p[1].length !== width);
  if (odd) throw new Error(`${odd[0]} has ${odd[1].length} columns and ${pairs[0]![0]} has ${width}: every row of an alignment has the same length (pad with -)`);
  let rows = pairs;
  if (rows.length > LIMITS.msaRows) { notes.push(tooLarge(LIMITS.msaRows, rows.length, 'sequences')); rows = rows.slice(0, LIMITS.msaRows); }
  let columns = width;
  if (columns > LIMITS.msaCols) { notes.push(tooLarge(LIMITS.msaCols, columns, 'columns')); columns = LIMITS.msaCols; }
  const seqs = rows.map((p) => p[1].slice(0, columns).toUpperCase().replace(/[.~?]/g, '-'));
  return { names: rows.map((p) => p[0]), rows: seqs, columns, type: detectType(seqs.join('').replace(/-/g, '')), notes };
}

export interface Column { consensus: string; identity: number; conserved: boolean; gaps: number }

/** Per column: the most common residue, the share of rows that have it (gaps count against), fully conserved or not. */
export function columnStats(a: Alignment): Column[] {
  const out: Column[] = [];
  for (let c = 0; c < a.columns; c++) {
    const counts = new Map<string, number>(); let gaps = 0;
    for (const r of a.rows) { const ch = r[c]!; if (ch === '-') gaps++; else counts.set(ch, (counts.get(ch) ?? 0) + 1); }
    let best = '-'; let n = 0;
    for (const [k, v] of counts) if (v > n || (v === n && k < best)) { best = k; n = v; }
    const identity = n / a.rows.length;
    out.push({ consensus: gaps === a.rows.length ? '-' : identity >= 0.5 ? best : best.toLowerCase(), identity, conserved: identity === 1, gaps });
  }
  return out;
}

// ClustalX-like groups, simplified.
const CLUSTAL: Record<string, string> = {};
for (const c of 'AILMFWVC') CLUSTAL[c] = 'rgba(47, 128, 237, 0.34)';
for (const c of 'KR') CLUSTAL[c] = 'rgba(214, 39, 40, 0.32)';
for (const c of 'DE') CLUSTAL[c] = 'rgba(190, 60, 190, 0.32)';
for (const c of 'STNQ') CLUSTAL[c] = 'rgba(46, 160, 67, 0.32)';
for (const c of 'HY') CLUSTAL[c] = 'rgba(20, 163, 163, 0.34)';
CLUSTAL.G = 'rgba(230, 140, 0, 0.36)'; CLUSTAL.P = 'rgba(200, 180, 0, 0.40)';
const NUCLEOTIDE: Record<string, string> = { A: 'rgba(46, 160, 67, 0.32)', C: 'rgba(47, 128, 237, 0.32)', G: 'rgba(230, 160, 0, 0.36)', T: 'rgba(214, 39, 40, 0.30)', U: 'rgba(214, 39, 40, 0.30)' };

export function schemeFor(a: Alignment, s: MsaScheme): Exclude<MsaScheme, 'auto'> { return s === 'auto' ? (a.type === 'protein' ? 'clustal' : 'nucleotide') : s; }

/** The background of one cell, or '' for none. */
export function cellColor(ch: string, col: Column, scheme: Exclude<MsaScheme, 'auto'>): string {
  if (ch === '-' || scheme === 'none') return '';
  if (scheme === 'identity') return ch === col.consensus.toUpperCase() && col.identity >= 0.5 ? `rgba(100, 110, 125, ${(0.15 + col.identity * 0.45).toFixed(2)})` : '';
  return (scheme === 'nucleotide' ? NUCLEOTIDE : CLUSTAL)[ch] ?? '';
}

/** A row split into runs of one colour (so a long alignment is a few spans, not one per cell). */
export function colourRuns(row: string, cols: Column[], scheme: Exclude<MsaScheme, 'auto'>): Array<{ text: string; color: string }> {
  const out: Array<{ text: string; color: string }> = [];
  for (let i = 0; i < row.length; i++) {
    const color = cellColor(row[i]!, cols[i]!, scheme);
    const last = out[out.length - 1];
    if (last && last.color === color) last.text += row[i]; else out.push({ text: row[i]!, color });
  }
  return out;
}
