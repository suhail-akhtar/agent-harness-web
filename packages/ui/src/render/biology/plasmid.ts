/**
 * Plasmid and circular genome maps: ```plasmid blocks of JSON
 *   {"name": "pUC19", "length": 2686, "features": [{"start": 1626, "end": 2486, "label": "AmpR", "type": "CDS", "strand": -1}],
 *    "sites": [{"position": 396, "label": "EcoRI"}], "sequence": "optional; unique cutters are found when no sites are given"}
 * Coordinates are 1-based; a feature whose start is past its end crosses the origin. The geometry
 * (arcs with arrowheads, labels pushed apart, linear lanes) is computed here. Pure; tested.
 */

import { LIMITS, checkSize, featureColor, hexColor, isObj, num, parseJson, strandOf, text, tooLarge, type Strand } from './common.ts';
import { packLanes, reverseComplement } from './seq.ts';

export interface PlasmidFeature { start: number; end: number; label: string; type: string; strand: Strand; color: string }
export interface Site { position: number; label: string }
export interface Plasmid { name: string; length: number; features: PlasmidFeature[]; sites: Site[]; notes: string[]; circular: boolean }

/** Common enzymes (recognition sequences, 5'->3'). Unique cutters are what a map shows. */
export const ENZYMES: Record<string, string> = {
  EcoRI: 'GAATTC', BamHI: 'GGATCC', HindIII: 'AAGCTT', XbaI: 'TCTAGA', SalI: 'GTCGAC', PstI: 'CTGCAG', SphI: 'GCATGC', KpnI: 'GGTACC',
  SacI: 'GAGCTC', SmaI: 'CCCGGG', NotI: 'GCGGCCGC', XhoI: 'CTCGAG', NdeI: 'CATATG', NcoI: 'CCATGG', BglII: 'AGATCT', EcoRV: 'GATATC',
  ApaI: 'GGGCCC', NheI: 'GCTAGC', AatII: 'GACGTC', ScaI: 'AGTACT', ClaI: 'ATCGAT', SpeI: 'ACTAGT', PvuI: 'CGATCG', AflIII: 'ACRYGT',
  BsaI: 'GGTCTC', BsmBI: 'CGTCTC', MluI: 'ACGCGT', AgeI: 'ACCGGT', AvrII: 'CCTAGG', PacI: 'TTAATTAA', SwaI: 'ATTTAAAT', AscI: 'GGCGCGCC',
};
const IUPAC: Record<string, string> = { A: 'A', C: 'C', G: 'G', T: 'T', R: '[AG]', Y: '[CT]', S: '[CG]', W: '[AT]', K: '[GT]', M: '[AC]', N: '.' };

/** Every position (1-based, both strands, across the origin when circular) where an enzyme's site starts. */
export function findSites(seq: string, enzymes: Record<string, string> = ENZYMES, circular = true, uniqueOnly = true): Site[] {
  const s = seq.toUpperCase().replace(/U/g, 'T');
  const out: Site[] = [];
  for (const [name, site] of Object.entries(enzymes)) {
    const pattern = site.split('').map((c) => IUPAC[c] ?? c).join('');
    const rc = reverseComplement(site);
    const hay = circular ? s + s.slice(0, site.length - 1) : s;
    const hits = new Set<number>();
    for (const p of rc === site ? [pattern] : [pattern, rc.split('').map((c) => IUPAC[c] ?? c).join('')]) {
      const re = new RegExp(`(?=${p})`, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(hay)) && hits.size < 50) { if (m.index < s.length) hits.add(m.index + 1); re.lastIndex = m.index + 1; }
    }
    if (uniqueOnly ? hits.size === 1 : hits.size > 0) for (const h of hits) out.push({ position: h, label: name });
  }
  return out.sort((a, b) => a.position - b.position);
}

export function parsePlasmid(source: string): Plasmid {
  checkSize(source, 'plasmid map');
  const j = parseJson(source.trim(), 'plasmid map');
  if (!isObj(j)) throw new Error('a plasmid map is {"name", "length", "features": [{"start", "end", "label", "type", "strand"}]}');
  const seq = typeof j.sequence === 'string' ? j.sequence.replace(/[\s\d]/g, '') : '';
  if (seq && !/^[ACGTUNRYKMSWBDHV]*$/i.test(seq)) throw new Error('"sequence" may hold only nucleotide letters');
  const length = Math.round(num(j.length ?? j.size) ?? seq.length);
  if (!(length > 0)) throw new Error('the plasmid map needs "length" in base pairs (or a "sequence")');
  if (length > 50_000_000) throw new Error('"length" is more than 50 Mb: not a plasmid or a small genome');
  const notes: string[] = [];
  const rawF = j.features ?? [];
  if (!Array.isArray(rawF)) throw new Error('"features" is a list of {start, end, label, type, strand}');
  if (rawF.length > LIMITS.plasmidFeatures) notes.push(tooLarge(LIMITS.plasmidFeatures, rawF.length, 'features'));
  const clamp = (v: number) => Math.max(1, Math.min(length, Math.round(v)));
  const features = rawF.slice(0, LIMITS.plasmidFeatures).map((f, i): PlasmidFeature => {
    if (!isObj(f)) throw new Error(`feature ${i + 1} is not an object`);
    const s = num(f.start ?? f.from); const e = num(f.end ?? f.to);
    if (s === undefined || e === undefined) throw new Error(`feature ${i + 1} ("${text(f.label ?? f.name, 30)}") needs numeric "start" and "end"`);
    if (s > length || e > length) throw new Error(`feature ${i + 1} ("${text(f.label ?? f.name, 30)}") ends past the plasmid's ${length} bp`);
    const type = text(f.type ?? 'misc_feature', 30) || 'misc_feature';
    return { start: clamp(s), end: clamp(e), label: text(f.label ?? f.name ?? type, 40), type, strand: strandOf(f.strand), color: featureColor(type, i, hexColor(f.color)) };
  });
  let sites: Site[] = [];
  if (Array.isArray(j.sites)) {
    if (j.sites.length > LIMITS.sites) notes.push(tooLarge(LIMITS.sites, j.sites.length, 'sites'));
    sites = j.sites.slice(0, LIMITS.sites).flatMap((x) => { if (!isObj(x)) return []; const p = num(x.position ?? x.pos ?? x.start); return p === undefined ? [] : [{ position: clamp(p), label: text(x.label ?? x.name ?? x.enzyme, 24) }]; });
  } else if (seq) {
    let enz = ENZYMES;
    if (Array.isArray(j.enzymes)) enz = Object.fromEntries(Object.entries(ENZYMES).filter(([k]) => (j.enzymes as unknown[]).includes(k)));
    sites = findSites(seq.slice(0, 2_000_000), enz, j.circular !== false).slice(0, LIMITS.sites);
  }
  return { name: text(j.name ?? j.title ?? 'plasmid', 40), length, features, sites, notes, circular: j.circular !== false };
}

// ---------- geometry ----------

/** Angle (radians, 0 at 12 o'clock, clockwise) of a 1-based position. */
export const angleOf = (pos: number, len: number) => ((pos - 1) / len) * Math.PI * 2 - Math.PI / 2;
const P = (cx: number, cy: number, r: number, a: number) => `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;

/** The span of a feature in bases (across the origin when start > end). */
export const spanOf = (f: { start: number; end: number }, len: number) => (f.end >= f.start ? f.end - f.start + 1 : len - f.start + 1 + f.end);

/** A feature as a thick arc on the ring with an arrowhead at its 3' end (none for strand 0). */
export function arcPath(f: PlasmidFeature, len: number, cx: number, cy: number, r: number, w: number): string {
  const a0 = angleOf(f.start, len); let a1 = angleOf(f.end + 1, len);
  if (a1 <= a0) a1 += Math.PI * 2;
  const ro = r + w / 2; const ri = r - w / 2;
  const head = Math.min((a1 - a0) * 0.45, 9 / r);
  const large = (x: number) => (x > Math.PI ? 1 : 0);
  if (f.strand === 1) {
    const b = a1 - head;
    return `M${P(cx, cy, ro, a0)}A${ro},${ro} 0 ${large(b - a0)} 1 ${P(cx, cy, ro, b)}L${P(cx, cy, r, a1)}L${P(cx, cy, ri, b)}A${ri},${ri} 0 ${large(b - a0)} 0 ${P(cx, cy, ri, a0)}Z`;
  }
  if (f.strand === -1) {
    const b = a0 + head;
    return `M${P(cx, cy, r, a0)}L${P(cx, cy, ro, b)}A${ro},${ro} 0 ${large(a1 - b)} 1 ${P(cx, cy, ro, a1)}L${P(cx, cy, ri, a1)}A${ri},${ri} 0 ${large(a1 - b)} 0 ${P(cx, cy, ri, b)}Z`;
  }
  return `M${P(cx, cy, ro, a0)}A${ro},${ro} 0 ${large(a1 - a0)} 1 ${P(cx, cy, ro, a1)}L${P(cx, cy, ri, a1)}A${ri},${ri} 0 ${large(a1 - a0)} 0 ${P(cx, cy, ri, a0)}Z`;
}

export interface PlacedLabel { x: number; y: number; ax: number; ay: number; anchor: 'start' | 'end'; text: string; kind: 'feature' | 'site'; index: number }

/**
 * Labels around the ring: each wants to sit at its angle; on each side they are sorted by height and
 * pushed apart so none overlap, then joined to their arc by a leader line.
 */
export function placeLabels(items: Array<{ angle: number; text: string; kind: 'feature' | 'site'; index: number; r: number }>, cx: number, cy: number, rLabel: number, gap = 14, height = 2 * cx): PlacedLabel[] {
  const out: PlacedLabel[] = [];
  for (const side of [1, -1]) {
    const mine = items.filter((it) => (Math.cos(it.angle) >= 0 ? 1 : -1) === side).map((it) => ({ it, y: cy + rLabel * Math.sin(it.angle) })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < mine.length; i++) if (mine[i]!.y < mine[i - 1]!.y + gap) mine[i]!.y = mine[i - 1]!.y + gap;
    const overflow = mine.length ? mine[mine.length - 1]!.y - (height - 8) : 0;
    if (overflow > 0) for (const m of mine) m.y -= overflow;
    for (let i = mine.length - 2; i >= 0; i--) if (mine[i]!.y > mine[i + 1]!.y - gap) mine[i]!.y = mine[i + 1]!.y - gap;
    for (const { it, y } of mine) {
      const dy = Math.max(-rLabel, Math.min(rLabel, y - cy));
      const x = cx + side * Math.sqrt(Math.max(0, rLabel * rLabel - dy * dy)) + side * 6;
      out.push({ x, y, ax: cx + it.r * Math.cos(it.angle), ay: cy + it.r * Math.sin(it.angle), anchor: side === 1 ? 'start' : 'end', text: it.text, kind: it.kind, index: it.index });
    }
  }
  return out;
}

/** Linear view: features in lanes (one wrapped feature becomes two pieces). */
export function linearLanes(p: Plasmid): Array<{ f: PlasmidFeature; index: number; lane: number; start: number; end: number }> {
  const pieces = p.features.flatMap((f, index) => (f.end >= f.start ? [{ f, index, start: f.start, end: f.end }] : [{ f, index, start: f.start, end: p.length }, { f, index, start: 1, end: f.end }]));
  return packLanes(pieces, p.length * 0.01).map(({ item, lane }) => ({ ...item, lane }));
}
