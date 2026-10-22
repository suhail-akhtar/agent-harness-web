/**
 * Shared pieces of the biology renderers: input limits, number and text coercion, the "too large"
 * notice and the feature palette. Pure; every parser in this folder uses these, so hostile or huge
 * input is bounded the same way everywhere (an Error with a readable message, or a truncation note).
 */

/** Sources above this are refused outright (a readable error, nothing parsed). */
export const MAX_SOURCE = 5_000_000;

/** How much of each kind is drawn; past these the renderer shows the first N and says so. */
export const LIMITS = {
  sequence: 1_000_000, // residues kept for statistics
  seqView: 12_000, // residues drawn in the viewer
  records: 50,
  msaRows: 150,
  msaCols: 3_000,
  treeLeaves: 1_500,
  treeDepth: 1_000,
  plasmidFeatures: 300,
  sites: 120,
  trackItems: 5_000,
  pathwayNodes: 300,
  pathwayEdges: 1_000,
  points: 6_000,
  manhattan: 20_000,
  heatmapRows: 300,
  heatmapCols: 120,
  subjects: 10_000,
  proteinFeatures: 1_000,
} as const;

export const fmt = (n: number): string => n.toLocaleString('en-US');

/** "Too large: showing the first 1,500 of 20,000 leaves." */
export function tooLarge(shown: number, total: number, what: string): string {
  return `Too large: showing the first ${fmt(shown)} of ${fmt(total)} ${what}.`;
}

export function checkSize(source: string, what: string): void {
  if (!source.trim()) throw new Error(`the ${what} is empty`);
  if (source.length > MAX_SOURCE) throw new Error(`the ${what} is too large to draw (${fmt(source.length)} characters; at most ${fmt(MAX_SOURCE)})`);
}

/** JSON.parse with a message a person can act on. */
export function parseJson(source: string, what: string): unknown {
  try { return JSON.parse(source); } catch (e) { throw new Error(`the ${what} is not valid JSON: ${(e as Error).message}`); }
}

export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A finite number from a number or a numeric string, else undefined. */
export function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** The first of several keys that holds a number (models write `log2fc`, `log2FoldChange`, `logFC`...). */
export function pick(o: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const k of keys) { const v = num(o[k]); if (v !== undefined) return v; }
  const lower = new Map(Object.keys(o).map((k) => [k.toLowerCase(), k]));
  for (const k of keys) { const real = lower.get(k.toLowerCase()); if (real) { const v = num(o[real]); if (v !== undefined) return v; } }
  return undefined;
}
export function pickText(o: Record<string, unknown>, keys: readonly string[], max = 60): string {
  for (const k of keys) if (typeof o[k] === 'string' || typeof o[k] === 'number') return text(o[k], max);
  return '';
}

/** Display text: control characters out, clipped. Always rendered as text (React escapes it). */
export function text(v: unknown, max = 80): string {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  const s = String(v).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A colour the spec asked for: hex only (never url(), never an expression). */
export function hexColor(v: unknown): string | undefined {
  return typeof v === 'string' && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v.trim()) ? v.trim() : undefined;
}

export type Strand = 1 | -1 | 0;
export function strandOf(v: unknown): Strand {
  if (v === 1 || v === '+' || v === '1' || v === 'forward' || v === 'fwd') return 1;
  if (v === -1 || v === '-' || v === '-1' || v === 'reverse' || v === 'rev' || v === 'complement') return -1;
  return 0;
}

/**
 * Feature colours by type. Mid-tone hues that read on the light and the dark surface alike (fills
 * at full strength, text beside them in the theme's ink).
 */
const BY_TYPE: Array<[RegExp, string]> = [
  [/^(cds|gene|orf|coding)/i, '#3b7dd8'],
  [/promoter|tss/i, '#1a9e5c'],
  [/terminator|polya/i, '#d1453b'],
  [/origin|rep_origin|\bori\b/i, '#d69a1c'],
  [/marker|resist|amp|kan|cm|tet|neo/i, '#8a55c7'],
  [/primer|primer_bind/i, '#7b8794'],
  [/enhancer|operator|protein_bind|cap|regulat|binding/i, '#14a3a3'],
  [/signal|sig_peptide|transit/i, '#e06aa5'],
  [/utr/i, '#9aa5b1'],
  [/exon/i, '#3b7dd8'],
  [/mcs|cloning|polylinker|misc/i, '#b07d2b'],
  [/repeat|ltr|tir/i, '#6b8e23'],
];
const FALLBACK = ['#3b7dd8', '#1a9e5c', '#d69a1c', '#8a55c7', '#d1453b', '#14a3a3', '#e06aa5', '#6b8e23'];
export function featureColor(type: string, i = 0, explicit?: string): string {
  if (explicit) return explicit;
  for (const [re, c] of BY_TYPE) if (re.test(type)) return c;
  return FALLBACK[i % FALLBACK.length]!;
}

/** Nice round ticks between a and b (about n of them). */
export function niceTicks(a: number, b: number, n = 6): number[] {
  if (!(b > a)) return [a];
  const raw = (b - a) / n;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let t = Math.ceil(a / step) * step; t <= b + step * 1e-9 && out.length < 50; t += step) out.push(Math.round(t * 1e6) / 1e6);
  return out;
}

/** A length: 7,000 -> "7,000 bp", 12,345 -> "12.3 kb", 2,500,000 -> "2.5 Mb". */
export function bp(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 1 : 2).replace(/\.?0+$/, '')} Mb`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')} kb`;
  return `${fmt(Math.round(n))} bp`;
}

/** A coordinate on an axis whose ticks are `step` apart, with just enough precision to tell ticks apart. */
export function axisLabel(t: number, step: number): string {
  const dec = (unit: number) => { const s = step / unit; return s >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(s) - 1e-9)); };
  if (step >= 1e5) return `${(t / 1e6).toFixed(dec(1e6))} Mb`;
  if (step >= 100) return `${fmt(Number((t / 1e3).toFixed(dec(1e3))))} kb`;
  return fmt(Math.round(t));
}
