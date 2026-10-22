/**
 * Genome browser tracks: ```bed, ```gff / ```gff3, ```gtf and ```tracks (JSON). Transcripts with
 * exons, introns, CDS and strand; plain features; signal tracks (bars). Everything is converted to
 * 1-based inclusive coordinates (BED starts are 0-based). Pure; tested.
 *
 *   {"region": {"chrom": "chr11", "start": 2150000, "end": 2170000},
 *    "tracks": [{"name": "Genes", "type": "genes", "features": [{"name": "INS", "chrom": "chr11", "start": 2159779, "end": 2161209, "strand": "-", "exons": [[2159779, 2160220], ...], "cds": [2159843, 2161065]}]},
 *               {"name": "H3K27ac", "type": "signal", "values": [{"start": 2158000, "end": 2158500, "value": 12.5}]}]}
 */

import { LIMITS, checkSize, isObj, num, parseJson, strandOf, text, tooLarge, type Strand } from './common.ts';
import { packLanes } from './seq.ts';

export interface Transcript { id: string; name: string; chrom: string; start: number; end: number; strand: Strand; exons: Array<[number, number]>; cds?: [number, number]; type: string; info: Array<[string, string]> }
export interface SignalBin { chrom: string; start: number; end: number; value: number }
export interface Track { name: string; kind: 'genes' | 'signal'; items: Transcript[]; bins: SignalBin[] }
export interface TrackSet { tracks: Track[]; chroms: string[]; region?: { chrom: string; start: number; end: number }; notes: string[] }

export type TrackFormat = 'bed' | 'gff' | 'gtf' | 'json';
export function formatOf(lang: string, source: string): TrackFormat {
  const s = source.trimStart();
  if (s.startsWith('{') || s.startsWith('[')) return 'json';
  const l = lang.toLowerCase();
  if (l === 'gtf') return 'gtf';
  if (l === 'gff' || l === 'gff3' || /^##gff-version/.test(s)) return /\tgene_id\s+"/.test(s) ? 'gtf' : 'gff';
  if (l === 'bed') return 'bed';
  // ```tracks with text: guess from the attribute column.
  return /\tgene_id\s+"/.test(s) ? 'gtf' : /\t[^\t\n]*=[^\t\n]*$/m.test(s) && s.split('\t').length > 8 ? 'gff' : 'bed';
}

const lines = (src: string, notes: string[]): string[] => {
  const all = src.split(/\r?\n/).filter((l) => l.trim() && !/^(#|track\b|browser\b)/.test(l));
  if (all.length > LIMITS.trackItems * 4) { notes.push(tooLarge(LIMITS.trackItems * 4, all.length, 'lines')); return all.slice(0, LIMITS.trackItems * 4); }
  return all;
};
const cols = (l: string) => (l.includes('\t') ? l.split('\t') : l.trim().split(/\s+/));

export function parseBed(src: string, notes: string[]): Transcript[] {
  return lines(src, notes).map((l, i) => {
    const c = cols(l);
    if (c.length < 3) throw new Error(`BED line ${i + 1} needs chrom, start and end: "${text(l, 60)}"`);
    const s0 = num(c[1]); const e = num(c[2]);
    if (s0 === undefined || e === undefined || e < s0) throw new Error(`BED line ${i + 1}: start and end are numbers with start <= end`);
    const start = s0 + 1;
    const t: Transcript = { id: `bed${i}`, name: text(c[3] ?? `${c[0]}:${start}`, 40), chrom: text(c[0], 30), start, end: e, strand: strandOf(c[5]), exons: [[start, e]], type: 'bed', info: [] };
    const ts = num(c[6]); const te = num(c[7]);
    if (ts !== undefined && te !== undefined && te > ts) t.cds = [ts + 1, te];
    const n = num(c[9]);
    if (n && c[10] && c[11]) {
      const sizes = c[10].split(',').filter(Boolean).map(Number); const starts = c[11].split(',').filter(Boolean).map(Number);
      if (sizes.length === n && starts.length === n && sizes.every(Number.isFinite) && starts.every(Number.isFinite)) t.exons = starts.map((b, k) => [s0 + b + 1, s0 + b + sizes[k]!] as [number, number]);
    }
    if (c[4] && num(c[4]) !== undefined) t.info.push(['score', c[4]]);
    return t;
  });
}

const decode = (v: string) => { try { return decodeURIComponent(v); } catch { return v; } };

/** GFF3 (key=value attributes) and GTF (key "value"; attributes): transcripts gathered from their exons and CDS. */
export function parseGff(src: string, gtf: boolean, notes: string[]): Transcript[] {
  interface Row { chrom: string; type: string; start: number; end: number; strand: Strand; attrs: Record<string, string> }
  const rows: Row[] = lines(src, notes).map((l, i) => {
    const c = l.split('\t').length >= 9 ? l.split('\t') : l.trim().split(/\s+/);
    if (c.length < 8) throw new Error(`${gtf ? 'GTF' : 'GFF'} line ${i + 1} needs 9 tab-separated columns: "${text(l, 60)}"`);
    const start = num(c[3]); const end = num(c[4]);
    if (start === undefined || end === undefined || end < start) throw new Error(`${gtf ? 'GTF' : 'GFF'} line ${i + 1}: columns 4 and 5 are start <= end`);
    const raw = c.slice(8).join(c.length > 9 && !l.includes('\t') ? ' ' : '\t');
    const attrs: Record<string, string> = {};
    if (gtf) for (const m of raw.matchAll(/(\w+)\s+"([^"]*)"/g)) attrs[m[1]!] ??= text(m[2], 80);
    else for (const kv of raw.split(';')) { const k = kv.indexOf('='); if (k > 0) attrs[kv.slice(0, k).trim()] = text(decode(kv.slice(k + 1)), 80); }
    return { chrom: text(c[0], 30), type: c[2]!.toLowerCase(), start, end, strand: strandOf(c[6]), attrs };
  });
  const byId = new Map<string, Transcript>(); const genes = new Map<string, Row>();
  const PARTS = new Set(['exon', 'cds', 'five_prime_utr', 'three_prime_utr', '5utr', '3utr', 'utr', 'start_codon', 'stop_codon']);
  const tx = (id: string, r: Row): Transcript => {
    let t = byId.get(id);
    if (!t) { t = { id, name: id, chrom: r.chrom, start: r.start, end: r.end, strand: r.strand, exons: [], type: 'transcript', info: [] }; byId.set(id, t); }
    t.start = Math.min(t.start, r.start); t.end = Math.max(t.end, r.end);
    return t;
  };
  const parents = new Set<string>();
  for (const r of rows) if (r.type === 'gene') genes.set(r.attrs.ID ?? r.attrs.gene_id ?? '', r);
  for (const r of rows) {
    if (r.attrs.Parent) parents.add(r.attrs.Parent.split(',')[0]!);
    if (gtf && r.attrs.gene_id && r.attrs.transcript_id) parents.add(r.attrs.gene_id);
    if (r.type === 'gene') continue;
    const parent = gtf ? r.attrs.transcript_id : r.attrs.Parent?.split(',')[0];
    if (PARTS.has(r.type) && parent) {
      const t = tx(parent, r);
      if (r.type === 'exon') t.exons.push([r.start, r.end]);
      if (r.type === 'cds') t.cds = t.cds ? [Math.min(t.cds[0], r.start), Math.max(t.cds[1], r.end)] : [r.start, r.end];
      if (gtf && (r.attrs.gene_name || t.name === parent)) { t.name = r.attrs.gene_name ?? r.attrs.transcript_name ?? r.attrs.gene_id ?? parent; if (r.attrs.gene_id) t.info = [['gene_id', r.attrs.gene_id], ['transcript_id', parent]]; }
      continue;
    }
    // A transcript (mRNA, ncRNA, ...) or a stand-alone feature.
    const id = r.attrs.ID ?? r.attrs.transcript_id ?? `${r.type}:${r.start}`;
    const t = tx(id, r);
    const gene = genes.get(r.attrs.Parent ?? '');
    // A transcript reads as its gene (with its own name after it); a stand-alone feature by its name.
    const geneName = gene?.attrs.Name ?? r.attrs.gene ?? r.attrs.gene_name;
    const own = r.attrs.Name ?? r.attrs.transcript_name;
    t.name = geneName && own && own !== geneName ? `${geneName} (${own})` : geneName ?? own ?? id;
    t.type = r.type; t.strand = r.strand;
    t.info = Object.entries(r.attrs).filter(([k]) => !['ID', 'Parent'].includes(k)).slice(0, 6);
  }
  // Genes with nothing under them are drawn as one block.
  for (const [id, g] of genes) if (!parents.has(id) && !byId.has(id)) byId.set(id, { id, name: g.attrs.Name ?? id, chrom: g.chrom, start: g.start, end: g.end, strand: g.strand, exons: [[g.start, g.end]], type: 'gene', info: [] });
  return [...byId.values()].map((t) => {
    if (!t.exons.length) t.exons = t.cds ? [t.cds] : [[t.start, t.end]];
    t.exons.sort((a, b) => a[0] - b[0]);
    return t;
  });
}

export function parseTracks(source: string, lang: string): TrackSet {
  checkSize(source, 'track file');
  const notes: string[] = [];
  const f = formatOf(lang, source);
  let tracks: Track[];
  let region: TrackSet['region'];
  if (f === 'json') {
    const j = parseJson(source.trim(), 'tracks');
    const list = isObj(j) && Array.isArray(j.tracks) ? j.tracks : Array.isArray(j) ? j : null;
    if (!list) throw new Error('```tracks JSON is {"region"?, "tracks": [{"name", "type": "genes"|"signal", "features"|"values"}]}');
    if (isObj(j) && isObj(j.region)) { const s = num(j.region.start); const e = num(j.region.end); if (s !== undefined && e !== undefined && e > s) region = { chrom: text(j.region.chrom, 30), start: s, end: e }; }
    tracks = list.slice(0, 20).map((t, ti) => {
      if (!isObj(t)) throw new Error(`track ${ti + 1} is not an object`);
      const name = text(t.name ?? `track ${ti + 1}`, 40);
      if (t.type === 'signal' || Array.isArray(t.values)) {
        const vals = Array.isArray(t.values) ? t.values : [];
        return { name, kind: 'signal' as const, items: [], bins: vals.slice(0, LIMITS.trackItems).flatMap((v) => { if (!isObj(v)) return []; const s = num(v.start); const e = num(v.end) ?? s; const val = num(v.value); return s === undefined || e === undefined || val === undefined ? [] : [{ chrom: text(v.chrom ?? region?.chrom ?? '', 30), start: s, end: e, value: val }]; }) };
      }
      const feats = Array.isArray(t.features) ? t.features : [];
      if (feats.length > LIMITS.trackItems) notes.push(`${name}: ${tooLarge(LIMITS.trackItems, feats.length, 'features')}`);
      return { name, kind: 'genes' as const, bins: [], items: feats.slice(0, LIMITS.trackItems).map((x, i): Transcript => {
        if (!isObj(x)) throw new Error(`${name}: feature ${i + 1} is not an object`);
        const s = num(x.start); const e = num(x.end);
        if (s === undefined || e === undefined || e < s) throw new Error(`${name}: feature ${i + 1} needs numeric "start" <= "end"`);
        const exons = Array.isArray(x.exons) ? x.exons.flatMap((p) => (Array.isArray(p) && num(p[0]) !== undefined && num(p[1]) !== undefined ? [[num(p[0])!, num(p[1])!] as [number, number]] : [])) : [];
        const cds = Array.isArray(x.cds) && num(x.cds[0]) !== undefined && num(x.cds[1]) !== undefined ? [num(x.cds[0])!, num(x.cds[1])!] as [number, number] : undefined;
        return { id: `${ti}:${i}`, name: text(x.name ?? x.label ?? x.id ?? '', 40), chrom: text(x.chrom ?? region?.chrom ?? '', 30), start: s, end: e, strand: strandOf(x.strand), exons: exons.length ? exons.sort((a, b) => a[0] - b[0]) : [[s, e]], ...(cds ? { cds } : {}), type: text(x.type ?? 'feature', 24), info: [] };
      }) };
    });
  } else {
    const items = f === 'bed' ? parseBed(source, notes) : parseGff(source, f === 'gtf', notes);
    if (items.length > LIMITS.trackItems) notes.push(tooLarge(LIMITS.trackItems, items.length, 'features'));
    tracks = [{ name: f === 'bed' ? 'BED' : f === 'gtf' ? 'GTF' : 'GFF', kind: 'genes', items: items.slice(0, LIMITS.trackItems), bins: [] }];
  }
  if (!tracks.some((t) => t.items.length || t.bins.length)) throw new Error('no features to draw');
  const count = new Map<string, number>();
  for (const t of tracks) for (const x of [...t.items, ...t.bins]) count.set(x.chrom, (count.get(x.chrom) ?? 0) + 1);
  const chroms = [...count.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  if (region && !chroms.includes(region.chrom)) chroms.unshift(region.chrom);
  return { tracks, chroms, ...(region ? { region } : {}), notes };
}

/** The span to show first: the region asked for, else all features of the chromosome with a margin. */
export function initialView(set: TrackSet, chrom: string): [number, number] {
  if (set.region && set.region.chrom === chrom) return [set.region.start, set.region.end];
  let lo = Infinity; let hi = -Infinity;
  for (const t of set.tracks) for (const x of [...t.items, ...t.bins]) if (x.chrom === chrom) { lo = Math.min(lo, x.start); hi = Math.max(hi, x.end); }
  if (!Number.isFinite(lo)) return [1, 1000];
  const pad = Math.max(50, (hi - lo) * 0.04);
  return [Math.max(1, Math.floor(lo - pad)), Math.ceil(hi + pad)];
}

/** Lanes for a chromosome's items; a label (about 6.2 px a character on a 700 px track) reserves its width too. */
export function laneItems(items: Transcript[], chrom: string, span: number): Array<{ item: Transcript; lane: number }> {
  const bpPerChar = (span / 700) * 6.2;
  return packLanes(items.filter((t) => t.chrom === chrom).map((item) => ({ item, start: item.start, end: Math.max(item.end, item.start + (item.name.length + 3) * bpPerChar) })), span * 0.015)
    .map(({ item, lane }) => ({ item: item.item, lane }));
}
