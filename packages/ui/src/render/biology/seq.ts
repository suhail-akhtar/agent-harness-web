/**
 * Sequences: ```fasta / ```sequence blocks. FASTA text, bare letters, or JSON with features:
 *   {"name": "INS", "type": "dna", "sequence": "ATG...", "features": [{"start": 1, "end": 72, "label": "signal peptide", "type": "sig_peptide", "strand": 1}]}
 * Coordinates are 1-based and inclusive. DNA, RNA or protein is detected from the letters unless
 * `type` says. Statistics (GC, molecular weight), the reverse complement and translation in three
 * frames are computed here. Pure; tested.
 */

import { LIMITS, checkSize, featureColor, hexColor, isObj, num, parseJson, strandOf, text, tooLarge, type Strand } from './common.ts';

export type SeqType = 'dna' | 'rna' | 'protein';
export interface SeqFeature { start: number; end: number; label: string; type: string; strand: Strand; color: string }
export interface SeqRecord { name: string; description: string; seq: string; type: SeqType; features: SeqFeature[]; circular: boolean }
export interface Parsed { records: SeqRecord[]; notes: string[] }

const NUC = /[ACGTUN]/g;
const ALLOWED = /^[A-Za-z*.\-]*$/;

export function detectType(seq: string): SeqType {
  const letters = seq.replace(/[^A-Za-z]/g, '').toUpperCase();
  if (!letters) return 'dna';
  const nuc = (letters.match(NUC) ?? []).length;
  if (nuc / letters.length < 0.9) return 'protein';
  return letters.includes('U') && !letters.includes('T') ? 'rna' : 'dna';
}

const clean = (s: string, name: string): string => {
  const c = s.replace(/[\s\d/]+/g, '');
  if (!ALLOWED.test(c)) {
    const i = c.search(/[^A-Za-z*.\-]/);
    throw new Error(`${name}: "${text(c[i], 4)}" at position ${i + 1} is not a residue letter`);
  }
  return c.toUpperCase();
};

function normFeatures(raw: unknown, len: number, circular: boolean, name: string): SeqFeature[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${name}: "features" is a list of {start, end, label, type, strand}`);
  const out: SeqFeature[] = [];
  raw.slice(0, 500).forEach((f, i) => {
    if (!isObj(f)) throw new Error(`${name}: feature ${i + 1} is not an object`);
    let s = num(f.start ?? f.from ?? f.begin); let e = num(f.end ?? f.to ?? f.stop);
    if (s === undefined || e === undefined) throw new Error(`${name}: feature ${i + 1} needs numeric "start" and "end" (1-based)`);
    s = Math.round(s); e = Math.round(e);
    if (s > e && !circular) [s, e] = [e, s];
    s = Math.max(1, Math.min(len, s)); e = Math.max(1, Math.min(len, e));
    const type = text(f.type ?? 'feature', 30) || 'feature';
    out.push({ start: s, end: e, label: text(f.label ?? f.name ?? type, 60), type, strand: strandOf(f.strand), color: featureColor(type, i, hexColor(f.color)) });
  });
  return out;
}

function record(name: string, description: string, seqText: string, opts: { type?: unknown; features?: unknown; circular?: unknown }, notes: string[]): SeqRecord {
  let seq = clean(seqText, name || 'the sequence');
  if (!seq) throw new Error(`${name || 'the sequence'} has no residues`);
  if (seq.length > LIMITS.sequence) { notes.push(`${name}: ${tooLarge(LIMITS.sequence, seq.length, 'residues')}`); seq = seq.slice(0, LIMITS.sequence); }
  const t = typeof opts.type === 'string' ? opts.type.toLowerCase() : '';
  const type: SeqType = t === 'dna' || t === 'rna' || t === 'protein' ? t : t === 'aa' || t === 'peptide' ? 'protein' : detectType(seq);
  const circular = opts.circular === true;
  return { name: name || 'sequence', description, seq, type, circular, features: normFeatures(opts.features, seq.length, circular, name || 'the sequence') };
}

export function parseSequences(source: string): Parsed {
  checkSize(source, 'sequence');
  const src = source.trim();
  const notes: string[] = [];
  const records: SeqRecord[] = [];
  if (src.startsWith('{') || src.startsWith('[')) {
    const j = parseJson(src, 'sequence');
    const list = Array.isArray(j) ? j : isObj(j) && Array.isArray(j.records) ? j.records : [j];
    if (list.length > LIMITS.records) notes.push(tooLarge(LIMITS.records, list.length, 'sequences'));
    list.slice(0, LIMITS.records).forEach((r, i) => {
      if (!isObj(r)) throw new Error(`sequence ${i + 1} is not an object`);
      const s = r.sequence ?? r.seq;
      if (typeof s !== 'string') throw new Error(`sequence ${i + 1} needs a "sequence" string`);
      records.push(record(text(r.name ?? r.id ?? r.title ?? `sequence ${i + 1}`, 60), text(r.description ?? '', 120), s, r, notes));
    });
  } else if (src.startsWith('>') || src.startsWith(';')) {
    let cur: { name: string; desc: string; lines: string[] } | null = null;
    let total = 0;
    const flush = () => { if (cur && ++total <= LIMITS.records) records.push(record(cur.name, cur.desc, cur.lines.join(''), {}, notes)); };
    for (const line of src.split(/\r?\n/)) {
      if (line.startsWith('>')) { flush(); const h = line.slice(1).trim(); const sp = h.search(/\s/); cur = { name: text(sp < 0 ? h : h.slice(0, sp), 60) || `sequence ${total + 1}`, desc: text(sp < 0 ? '' : h.slice(sp + 1), 120), lines: [] }; }
      else if (line.startsWith(';')) continue;
      else if (cur && total < LIMITS.records) cur.lines.push(line);
    }
    flush();
    if (total > LIMITS.records) notes.push(tooLarge(LIMITS.records, total, 'sequences'));
  } else {
    records.push(record('sequence', '', src, {}, notes));
  }
  if (!records.length) throw new Error('no sequence found: give FASTA (">name" then letters), bare letters, or {"sequence": "..."}');
  return { records, notes };
}

// ---------- statistics ----------

export function gcContent(seq: string): number {
  let gc = 0; let all = 0;
  for (const c of seq) { if (c === 'G' || c === 'C' || c === 'S') { gc++; all++; } else if (c === 'A' || c === 'T' || c === 'U' || c === 'W') all++; }
  return all ? gc / all : 0;
}

const AA_MASS: Record<string, number> = { A: 71.0788, R: 156.1875, N: 114.1038, D: 115.0886, C: 103.1388, E: 129.1155, Q: 128.1307, G: 57.0519, H: 137.1411, I: 113.1594, L: 113.1594, K: 128.1741, M: 131.1926, F: 147.1766, P: 97.1167, S: 87.0782, T: 101.1051, W: 186.2132, Y: 163.176, V: 99.1326, U: 150.0388, O: 237.3018 };
const DNA_MASS: Record<string, number> = { A: 313.21, C: 289.18, G: 329.21, T: 304.2 };
const RNA_MASS: Record<string, number> = { A: 329.21, C: 305.18, G: 345.21, U: 306.17 };

/** Average molecular weight in daltons (single strand for nucleic acids; ambiguous letters at the mean). */
export function molecularWeight(seq: string, type: SeqType): number {
  const table = type === 'protein' ? AA_MASS : type === 'rna' ? RNA_MASS : DNA_MASS;
  const mean = Object.values(table).reduce((a, b) => a + b, 0) / Object.values(table).length;
  let m = 0; let n = 0;
  for (const c of seq) { if (c === '-' || c === '.' || c === '*') continue; m += table[c] ?? (type === 'protein' ? 110 : mean); n++; }
  if (!n) return 0;
  return type === 'protein' ? m + 18.015 : type === 'rna' ? m + 159 : m - 61.96;
}

const COMP: Record<string, string> = { A: 'T', T: 'A', U: 'A', G: 'C', C: 'G', R: 'Y', Y: 'R', K: 'M', M: 'K', S: 'S', W: 'W', B: 'V', V: 'B', D: 'H', H: 'D', N: 'N', '-': '-', '.': '.' };
export function reverseComplement(seq: string, type: SeqType = 'dna'): string {
  let out = '';
  for (let i = seq.length - 1; i >= 0; i--) { const c = COMP[seq[i]!] ?? 'N'; out += type === 'rna' && c === 'T' ? 'U' : c; }
  return out;
}

const BASES = 'TCAG';
const CODE = 'FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG';
/** The amino acid for a codon (the standard code); X for anything ambiguous. */
export function codon(c: string): string {
  const s = c.replace(/U/g, 'T');
  const i = BASES.indexOf(s[0]!); const j = BASES.indexOf(s[1]!); const k = BASES.indexOf(s[2]!);
  return i < 0 || j < 0 || k < 0 ? 'X' : CODE[i * 16 + j * 4 + k]!;
}
/** Translation of one reading frame (0, 1, 2) from the first base. */
export function translate(seq: string, frame: 0 | 1 | 2 = 0): string {
  let out = '';
  for (let i = frame; i + 3 <= seq.length; i += 3) out += codon(seq.slice(i, i + 3));
  return out;
}

// ---------- colours ----------

export type ResidueClass = 'A' | 'C' | 'G' | 'T' | 'N' | 'hydrophobic' | 'polar' | 'positive' | 'negative' | 'special' | 'stop' | 'gap' | 'other';
const AA_CLASS: Record<string, ResidueClass> = {};
for (const c of 'AVLIMFW') AA_CLASS[c] = 'hydrophobic';
for (const c of 'STNQYC') AA_CLASS[c] = 'polar';
for (const c of 'KRH') AA_CLASS[c] = 'positive';
for (const c of 'DE') AA_CLASS[c] = 'negative';
for (const c of 'GP') AA_CLASS[c] = 'special';
AA_CLASS['*'] = 'stop';

export function residueClass(c: string, type: SeqType): ResidueClass {
  if (c === '-' || c === '.') return 'gap';
  if (type !== 'protein') return c === 'A' || c === 'C' || c === 'G' ? c : c === 'T' || c === 'U' ? 'T' : 'N';
  return AA_CLASS[c] ?? 'other';
}

/** Tints (with alpha) that read under the theme's ink in light and dark alike. */
export const RESIDUE_TINT: Record<ResidueClass, string> = {
  A: 'rgba(46, 160, 67, 0.30)', C: 'rgba(47, 128, 237, 0.30)', G: 'rgba(230, 160, 0, 0.34)', T: 'rgba(214, 39, 40, 0.28)', N: 'rgba(128, 128, 128, 0.18)',
  hydrophobic: 'rgba(230, 160, 0, 0.32)', polar: 'rgba(46, 160, 67, 0.28)', positive: 'rgba(47, 128, 237, 0.30)', negative: 'rgba(214, 39, 40, 0.28)',
  special: 'rgba(148, 103, 189, 0.32)', stop: 'rgba(214, 39, 40, 0.55)', gap: 'transparent', other: 'rgba(128, 128, 128, 0.18)',
};
export const LEGEND: Record<'nucleotide' | 'protein', Array<[string, ResidueClass]>> = {
  nucleotide: [['A', 'A'], ['C', 'C'], ['G', 'G'], ['T/U', 'T'], ['other', 'N']],
  protein: [['hydrophobic', 'hydrophobic'], ['polar', 'polar'], ['positive', 'positive'], ['negative', 'negative'], ['G, P', 'special']],
};

/** Packs features into lanes so none overlap (each lane's last end before the next start). */
export function packLanes<T extends { start: number; end: number }>(items: T[], gap = 0): Array<{ item: T; lane: number }> {
  const ends: number[] = [];
  return [...items].sort((a, b) => a.start - b.start || b.end - a.end).map((item) => {
    let lane = ends.findIndex((e) => e + gap < item.start);
    if (lane < 0) { lane = ends.length; ends.push(item.end); } else ends[lane] = item.end;
    return { item, lane };
  });
}
