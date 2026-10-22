/**
 * Biology statistics from compact JSON: ```volcano, ```ma, ```kaplan-meier and ```manhattan become
 * Vega-Lite specs (drawn by the same chart stack as ```vega-lite, so they share its theme, its
 * interpreter and its no-network loader); ```heatmap is drawn as SVG here with hierarchical
 * clustering (average linkage) and dendrograms. Pure; tested.
 */

import { LIMITS, checkSize, fmt, isObj, num, parseJson, pick, pickText, text, tooLarge } from './common.ts';

export type BioPlotKind = 'volcano' | 'ma' | 'kaplan-meier' | 'manhattan';
export interface BioPlot { spec: Record<string, unknown>; notes: string[]; summary: string }

const UP = '#d1453b'; const DOWN = '#3b7dd8'; const NS = '#9aa5b1'; const RULE = '#8c8a85';
const GENE = ['gene', 'name', 'id', 'symbol', 'label', 'feature'] as const;
const FC = ['log2fc', 'log2FoldChange', 'logFC', 'lfc', 'fc', 'M'] as const;
const PV = ['padj', 'qvalue', 'q', 'fdr', 'p', 'pvalue', 'pval', 'p_value', 'P'] as const;
const MEAN = ['mean', 'baseMean', 'A', 'avgExpr', 'AveExpr', 'expression', 'mean_expression'] as const;
const SCHEMA = 'https://vega.github.io/schema/vega-lite/v6.json';

const rowsOf = (j: unknown, keys: string[], what: string): Record<string, unknown>[] => {
  const list = Array.isArray(j) ? j : isObj(j) ? keys.map((k) => j[k]).find(Array.isArray) : undefined;
  if (!list) throw new Error(`the ${what} needs a list of points: {"${keys[0]}": [{...}, ...]}`);
  return list.filter(isObj);
};
const opt = (j: unknown, k: string, d: number) => (isObj(j) ? num(j[k]) ?? d : d);
const title = (j: unknown, fallback: string) => (isObj(j) ? text(j.title, 80) : '') || fallback;
const nlog = (p: number) => -Math.log10(p);
const round = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

export function parseBioPlot(kind: BioPlotKind, source: string): BioPlot {
  checkSize(source, `${kind} plot`);
  const j = parseJson(source.trim(), `${kind} plot`);
  switch (kind) {
    case 'volcano': return volcano(j);
    case 'ma': return maPlot(j);
    case 'kaplan-meier': return kaplanMeier(j);
    case 'manhattan': return manhattan(j);
  }
}

function capped<T>(rows: T[], max: number, what: string, notes: string[]): T[] {
  if (rows.length > max) { notes.push(tooLarge(max, rows.length, what)); return rows.slice(0, max); }
  return rows;
}

export function volcano(j: unknown): BioPlot {
  const notes: string[] = [];
  const fcT = opt(j, 'fc', opt(j, 'fcThreshold', 1)); const pT = opt(j, 'p', opt(j, 'pThreshold', 0.05)); const nLabels = Math.max(0, Math.min(40, opt(j, 'labels', 10)));
  const raw = capped(rowsOf(j, ['points', 'genes', 'data', 'rows'], 'volcano plot'), LIMITS.points, 'points', notes);
  const pts = raw.flatMap((r, i) => {
    const fc = pick(r, FC); const p = pick(r, PV);
    if (fc === undefined || p === undefined || p < 0 || p > 1) return [];
    return [{ gene: pickText(r, GENE, 30) || `#${i + 1}`, log2fc: round(fc), p, nlp: p > 0 ? nlog(p) : Infinity }];
  });
  if (!pts.length) throw new Error('no point has a log2 fold change and a p value (keys like "log2fc" and "p"/"padj", p between 0 and 1)');
  const finite = pts.filter((x) => Number.isFinite(x.nlp)).map((x) => x.nlp);
  const top = Math.max(1, ...finite) + 1;
  const rows = pts.map((x) => ({ ...x, nlp: round(Number.isFinite(x.nlp) ? x.nlp : top, 3), class: x.p < pT && x.log2fc >= fcT ? 'up' : x.p < pT && x.log2fc <= -fcT ? 'down' : 'not significant' }));
  const up = rows.filter((r) => r.class === 'up').length; const down = rows.filter((r) => r.class === 'down').length;
  const labels = rows.filter((r) => r.class !== 'not significant').sort((a, b) => a.p - b.p || Math.abs(b.log2fc) - Math.abs(a.log2fc)).slice(0, nLabels);
  const x = { field: 'log2fc', type: 'quantitative', title: 'log2 fold change' };
  const y = { field: 'nlp', type: 'quantitative', title: '-log10 p' };
  return {
    notes, summary: `${fmt(rows.length)} genes · ${up} up · ${down} down (|log2FC| ≥ ${fcT}, p < ${pT})`,
    spec: {
      $schema: SCHEMA, title: { text: title(j, 'Volcano plot'), subtitle: `${up} up, ${down} down at |log2FC| ≥ ${fcT} and p < ${pT}` }, height: 300, data: { values: rows },
      layer: [
        { mark: { type: 'point', filled: true, size: 26, opacity: 0.75 }, encoding: { x, y, color: { field: 'class', type: 'nominal', scale: { domain: ['up', 'down', 'not significant'], range: [UP, DOWN, NS] }, legend: { title: null, orient: 'top' } }, tooltip: [{ field: 'gene', title: 'gene' }, { field: 'log2fc', title: 'log2FC' }, { field: 'p', title: 'p', format: '.2e' }] } },
        { data: { values: [{ v: -fcT }, { v: fcT }] }, mark: { type: 'rule', strokeDash: [4, 4], color: RULE }, encoding: { x: { field: 'v', type: 'quantitative' } } },
        { data: { values: [{ v: round(nlog(pT), 3) }] }, mark: { type: 'rule', strokeDash: [4, 4], color: RULE }, encoding: { y: { field: 'v', type: 'quantitative' } } },
        { data: { values: labels }, mark: { type: 'text', dy: -8, fontSize: 10, fontWeight: 600 }, encoding: { x, y, text: { field: 'gene' } } },
      ],
    },
  };
}

export function maPlot(j: unknown): BioPlot {
  const notes: string[] = [];
  const fcT = opt(j, 'fc', 1); const pT = opt(j, 'p', 0.05); const nLabels = Math.max(0, Math.min(40, opt(j, 'labels', 8)));
  const raw = capped(rowsOf(j, ['points', 'genes', 'data', 'rows'], 'MA plot'), LIMITS.points, 'points', notes);
  const pts = raw.flatMap((r, i) => {
    const m = pick(r, MEAN); const fc = pick(r, FC); const p = pick(r, PV);
    if (m === undefined || fc === undefined || m <= 0) return [];
    const sig = (p === undefined || p < pT) && Math.abs(fc) >= fcT;
    return [{ gene: pickText(r, GENE, 30) || `#${i + 1}`, mean: round(m, 3), log2fc: round(fc), class: sig ? (fc > 0 ? 'up' : 'down') : 'not significant' }];
  });
  if (!pts.length) throw new Error('no point has a positive mean expression and a log2 fold change (keys like "mean"/"baseMean" and "log2fc")');
  const labels = pts.filter((r) => r.class !== 'not significant').sort((a, b) => Math.abs(b.log2fc) - Math.abs(a.log2fc)).slice(0, nLabels);
  const x = { field: 'mean', type: 'quantitative', scale: { type: 'log' }, title: 'mean expression (log scale)' };
  const y = { field: 'log2fc', type: 'quantitative', title: 'log2 fold change' };
  const up = pts.filter((r) => r.class === 'up').length; const down = pts.filter((r) => r.class === 'down').length;
  return {
    notes, summary: `${fmt(pts.length)} genes · ${up} up · ${down} down`,
    spec: {
      $schema: SCHEMA, title: { text: title(j, 'MA plot'), subtitle: `${up} up, ${down} down at |log2FC| ≥ ${fcT}` }, height: 300, data: { values: pts },
      layer: [
        { mark: { type: 'point', filled: true, size: 22, opacity: 0.7 }, encoding: { x, y, color: { field: 'class', type: 'nominal', scale: { domain: ['up', 'down', 'not significant'], range: [UP, DOWN, NS] }, legend: { title: null, orient: 'top' } }, tooltip: [{ field: 'gene' }, { field: 'mean' }, { field: 'log2fc', title: 'log2FC' }] } },
        { data: { values: [{ v: 0 }] }, mark: { type: 'rule', color: RULE }, encoding: { y: { field: 'v', type: 'quantitative' } } },
        { data: { values: [{ v: -fcT }, { v: fcT }] }, mark: { type: 'rule', strokeDash: [4, 4], color: RULE }, encoding: { y: { field: 'v', type: 'quantitative' } } },
        { data: { values: labels }, mark: { type: 'text', dy: -8, fontSize: 10, fontWeight: 600 }, encoding: { x, y, text: { field: 'gene' } } },
      ],
    },
  };
}

// ---------- Kaplan-Meier ----------

export interface KmGroup { name: string; time: number[]; event: boolean[] }
export interface KmCurve { name: string; n: number; events: number; median?: number; steps: Array<{ t: number; s: number }>; censored: Array<{ t: number; s: number }> }

export function kmGroups(j: unknown): KmGroup[] {
  const ev = (v: unknown) => v === true || v === 1 || v === '1' || v === 'event' || v === 'dead' || v === 'death';
  const out: KmGroup[] = [];
  const add = (name: string, t: unknown, e: unknown) => {
    if (!Array.isArray(t) || !Array.isArray(e) || t.length !== e.length) throw new Error(`group "${name}": "time" and "event" are lists of the same length`);
    const time: number[] = []; const event: boolean[] = [];
    t.forEach((x, i) => { const v = num(x); if (v !== undefined && v >= 0) { time.push(v); event.push(ev(e[i])); } });
    out.push({ name: text(name, 40), time, event });
  };
  if (isObj(j) && Array.isArray(j.groups)) j.groups.forEach((g, i) => { if (!isObj(g)) throw new Error(`group ${i + 1} is not an object`); add(text(g.name ?? `group ${i + 1}`, 40), g.time ?? g.times, g.event ?? g.events ?? g.status); });
  else if (isObj(j) && isObj(j.groups)) for (const [k, g] of Object.entries(j.groups)) { if (isObj(g)) add(k, g.time ?? g.times, g.event ?? g.events ?? g.status); }
  else {
    const rows = rowsOf(j, ['data', 'subjects', 'rows'], 'survival curve');
    const by = new Map<string, { t: unknown[]; e: unknown[] }>();
    for (const r of rows) { const g = text(r.group ?? r.arm ?? r.strata ?? 'all', 40) || 'all'; const b = by.get(g) ?? { t: [], e: [] }; b.t.push(r.time ?? r.t); b.e.push(r.event ?? r.status ?? r.e); by.set(g, b); }
    for (const [g, b] of by) add(g, b.t, b.e);
  }
  if (!out.length || out.every((g) => !g.time.length)) throw new Error('no subjects: give {"groups": [{"name", "time": [...], "event": [1, 0, ...]}]}');
  return out.slice(0, 12);
}

export function kmCurve(g: KmGroup): KmCurve {
  const idx = g.time.map((_, i) => i).sort((a, b) => g.time[a]! - g.time[b]! || Number(g.event[b]) - Number(g.event[a]));
  let atRisk = idx.length; let s = 1; let median: number | undefined;
  const steps = [{ t: 0, s: 1 }]; const censored: Array<{ t: number; s: number }> = [];
  for (let k = 0; k < idx.length;) {
    const t = g.time[idx[k]!]!; let d = 0; let c = 0;
    while (k < idx.length && g.time[idx[k]!] === t) { if (g.event[idx[k]!]) d++; else c++; k++; }
    if (d) { s *= 1 - d / atRisk; steps.push({ t, s: round(s, 5) }); if (median === undefined && s <= 0.5) median = t; }
    for (let i = 0; i < c; i++) censored.push({ t, s: round(s, 5) });
    atRisk -= d + c;
  }
  const last = Math.max(0, ...g.time);
  if (steps[steps.length - 1]!.t < last) steps.push({ t: last, s: steps[steps.length - 1]!.s });
  return { name: g.name, n: g.time.length, events: g.event.filter(Boolean).length, ...(median !== undefined ? { median } : {}), steps, censored };
}

/** Log-rank test across groups: chi-square with k-1 degrees of freedom, and its p value. */
export function logRank(groups: KmGroup[]): { chi2: number; df: number; p: number } | undefined {
  const k = groups.length; if (k < 2) return undefined;
  const times = [...new Set(groups.flatMap((g) => g.time.filter((_, i) => g.event[i])))].sort((a, b) => a - b);
  const O = new Array(k).fill(0); const E = new Array(k).fill(0); const V = Array.from({ length: k }, () => new Array(k).fill(0));
  for (const t of times) {
    const n = groups.map((g) => g.time.filter((x) => x >= t).length); const d = groups.map((g) => g.time.filter((x, i) => x === t && g.event[i]).length);
    const N = n.reduce((a, b) => a + b, 0); const D = d.reduce((a, b) => a + b, 0);
    if (N < 1) continue;
    for (let a = 0; a < k; a++) {
      O[a] += d[a]!; E[a] += (D * n[a]!) / N;
      if (N > 1) for (let b = 0; b < k; b++) V[a]![b] += (D * (n[a]! / N) * ((a === b ? 1 : 0) - n[b]! / N) * (N - D)) / (N - 1);
    }
  }
  const m = k - 1; const diff = O.slice(0, m).map((o, i) => o - E[i]!);
  const A = V.slice(0, m).map((r, i) => [...r.slice(0, m), diff[i]!]);
  // Solve V x = diff (Gaussian elimination); chi2 = diff . x
  for (let c = 0; c < m; c++) {
    let p = c; for (let r = c + 1; r < m; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[p]![c]!)) p = r;
    if (Math.abs(A[p]![c]!) < 1e-12) return undefined;
    [A[c], A[p]] = [A[p]!, A[c]!];
    for (let r = 0; r < m; r++) if (r !== c) { const f = A[r]![c]! / A[c]![c]!; for (let q = c; q <= m; q++) A[r]![q] -= f * A[c]![q]!; }
  }
  const chi2 = diff.reduce((acc, dv, i) => acc + dv * (A[i]![m]! / A[i]![i]!), 0);
  return { chi2, df: m, p: chiSquareSf(chi2, m) };
}

/** P(X > x) for a chi-square with df degrees of freedom (the regularized upper incomplete gamma). */
export function chiSquareSf(x: number, df: number): number {
  if (!(x > 0)) return 1;
  const a = df / 2; const z = x / 2;
  const lnG = lgamma(a);
  if (z < a + 1) { let sum = 1 / a; let term = sum; for (let n = 1; n < 500; n++) { term *= z / (a + n); sum += term; if (term < sum * 1e-14) break; } return Math.max(0, 1 - sum * Math.exp(-z + a * Math.log(z) - lnG)); }
  let b = z + 1 - a; let c = 1e300; let d = 1 / b; let h = d;
  for (let i = 1; i < 500; i++) { const an = -i * (i - a); b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300; c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300; d = 1 / d; const del = d * c; h *= del; if (Math.abs(del - 1) < 1e-14) break; }
  return Math.min(1, Math.exp(-z + a * Math.log(z) - lnG) * h);
}
function lgamma(x: number): number {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x; const t = x + 5.5 - (x + 0.5) * Math.log(x + 5.5); let s = 1.000000000190015;
  for (const c of g) s += c / ++y;
  return -t + Math.log((2.5066282746310005 * s) / x);
}

export function kaplanMeier(j: unknown): BioPlot {
  const notes: string[] = [];
  const groups = kmGroups(j).map((g) => (g.time.length > LIMITS.subjects ? (notes.push(`${g.name}: ${tooLarge(LIMITS.subjects, g.time.length, 'subjects')}`), { ...g, time: g.time.slice(0, LIMITS.subjects), event: g.event.slice(0, LIMITS.subjects) }) : g));
  const curves = groups.map(kmCurve);
  const lr = logRank(groups);
  const label = (c: KmCurve) => `${c.name} (n=${c.n}${c.median !== undefined ? `, median ${round(c.median, 2)}` : ''})`;
  const steps = curves.flatMap((c) => c.steps.map((p) => ({ group: label(c), t: p.t, s: p.s })));
  const cens = curves.flatMap((c) => c.censored.map((p) => ({ group: label(c), t: p.t, s: p.s })));
  const unit = isObj(j) ? text(j.timeUnit ?? j.unit ?? '', 20) : '';
  const x = { field: 't', type: 'quantitative', title: isObj(j) && typeof j.xTitle === 'string' ? text(j.xTitle, 40) : `time${unit ? ` (${unit})` : ''}` };
  const y = { field: 's', type: 'quantitative', title: 'survival probability', scale: { domain: [0, 1] } };
  const color = { field: 'group', type: 'nominal', legend: { title: null, orient: 'top', labelLimit: 260 } };
  const p = lr ? (lr.p < 1e-4 ? lr.p.toExponential(1) : lr.p.toFixed(4)) : '';
  return {
    notes, summary: `${curves.length} group${curves.length === 1 ? '' : 's'} · ${fmt(curves.reduce((a, c) => a + c.n, 0))} subjects${lr ? ` · log-rank p = ${p}` : ''}`,
    spec: {
      $schema: SCHEMA, title: { text: title(j, 'Survival'), ...(lr ? { subtitle: `log-rank χ² = ${round(lr.chi2, 2)} (df ${lr.df}), p = ${p}` } : {}) }, height: 280, data: { values: steps },
      layer: [
        { mark: { type: 'line', interpolate: 'step-after', strokeWidth: 2 }, encoding: { x, y, color, tooltip: [{ field: 'group' }, { field: 't', title: 'time' }, { field: 's', title: 'survival', format: '.3f' }] } },
        { data: { values: cens }, mark: { type: 'point', shape: 'M0,-1L0,1', size: 70, strokeWidth: 1.6, filled: false, opacity: 1 }, encoding: { x, y, color, tooltip: [{ field: 'group' }, { field: 't', title: 'censored at' }] } },
      ],
    },
  };
}

// ---------- Manhattan ----------

const CHR = /^(chr)?([0-9]{1,2}|X|Y|MT|M|[A-Za-z0-9_]{1,10})$/i;
export function chromOrder(c: string): number {
  const n = Number(c); if (Number.isInteger(n)) return n;
  return ({ X: 1000, Y: 1001, M: 1002, MT: 1002 } as Record<string, number>)[c.toUpperCase()] ?? 2000;
}

export function manhattan(j: unknown): BioPlot {
  const notes: string[] = [];
  const thr = opt(j, 'threshold', 5e-8); const sug = opt(j, 'suggestive', 1e-5); const nLabels = Math.max(0, Math.min(30, opt(j, 'labels', 8)));
  const raw = capped(rowsOf(j, ['snps', 'points', 'variants', 'data', 'rows'], 'Manhattan plot'), LIMITS.manhattan, 'variants', notes);
  const pts = raw.flatMap((r, i) => {
    const chrRaw = String(r.chr ?? r.chrom ?? r.chromosome ?? r.CHR ?? '').trim();
    const m = CHR.exec(chrRaw);
    if (!m) { if (chrRaw) throw new Error(`variant ${i + 1}: "${text(chrRaw, 20)}" is not a chromosome name`); return []; }
    const pos = pick(r, ['pos', 'position', 'bp', 'BP', 'start']); const p = pick(r, ['p', 'pvalue', 'P', 'pval', 'p_value']);
    if (pos === undefined || p === undefined || p <= 0 || p > 1) return [];
    return [{ chr: m[2]!.toUpperCase() === 'M' ? 'MT' : m[2]!.toUpperCase(), pos, p, id: pickText(r, ['id', 'rsid', 'snp', 'SNP', 'variant'], 24) || `#${i + 1}`, gene: pickText(r, ['gene', 'nearest_gene', 'locus'], 24) }];
  });
  if (!pts.length) throw new Error('no variant has a chromosome, a position and a p value between 0 and 1');
  const chroms = [...new Set(pts.map((x) => x.chr))].sort((a, b) => chromOrder(a) - chromOrder(b) || a.localeCompare(b));
  const maxPos = new Map<string, number>();
  for (const x of pts) maxPos.set(x.chr, Math.max(maxPos.get(x.chr) ?? 0, x.pos));
  const total = [...maxPos.values()].reduce((a, b) => a + b, 0);
  const offset = new Map<string, number>(); let acc = 0;
  for (const c of chroms) { offset.set(c, acc); acc += maxPos.get(c)! + total * 0.004; }
  const rows = pts.map((x) => ({ ...x, x: Math.round(offset.get(x.chr)! + x.pos), nlp: round(nlog(x.p), 3), band: chroms.indexOf(x.chr) % 2 ? 'b' : 'a' }));
  const centres = chroms.map((c) => ({ c, v: Math.round(offset.get(c)! + maxPos.get(c)! / 2) }));
  // Chromosome names are [A-Za-z0-9_] only (checked above), so this expression is data, not code.
  const labelExpr = centres.length <= 40 ? centres.map(({ c, v }) => `datum.value == ${v} ? '${c}' : `).join('') + "''" : "''";
  const best = new Map<string, typeof rows[number]>();
  for (const r of rows) if (r.p < thr && (!best.has(r.chr) || r.p < best.get(r.chr)!.p)) best.set(r.chr, r);
  const labels = [...best.values()].sort((a, b) => a.p - b.p).slice(0, nLabels).map((r) => ({ ...r, label: r.gene || r.id }));
  const x = { field: 'x', type: 'quantitative', title: 'chromosome', scale: { domain: [0, Math.round(acc)], nice: false }, axis: { values: centres.map((c) => c.v), tickCount: centres.length, labelExpr, grid: false, labelFontSize: 9, labelOverlap: false, tickSize: 3 } };
  const y = { field: 'nlp', type: 'quantitative', title: '-log10 p' };
  return {
    notes, summary: `${fmt(rows.length)} variants · ${chroms.length} chromosomes · ${rows.filter((r) => r.p < thr).length} genome-wide significant`,
    spec: {
      $schema: SCHEMA, title: { text: title(j, 'Manhattan plot'), subtitle: `${rows.filter((r) => r.p < thr).length} variants below p = ${thr} (genome-wide), suggestive at ${sug}` }, height: 280, data: { values: rows },
      layer: [
        { mark: { type: 'point', filled: true, size: 14, opacity: 0.85 }, encoding: { x, y, color: { field: 'band', type: 'nominal', scale: { domain: ['a', 'b'], range: ['#3b7dd8', '#14a3a3'] }, legend: null }, tooltip: [{ field: 'id', title: 'variant' }, { field: 'chr' }, { field: 'pos', title: 'position' }, { field: 'p', format: '.2e' }] } },
        { data: { values: [{ v: round(nlog(thr), 3) }] }, mark: { type: 'rule', color: UP, strokeDash: [4, 4] }, encoding: { y: { field: 'v', type: 'quantitative' } } },
        { data: { values: [{ v: round(nlog(sug), 3) }] }, mark: { type: 'rule', color: NS, strokeDash: [2, 3] }, encoding: { y: { field: 'v', type: 'quantitative' } } },
        { data: { values: labels }, mark: { type: 'text', dy: -8, fontSize: 10, fontWeight: 600 }, encoding: { x: { field: 'x', type: 'quantitative' }, y, text: { field: 'label' } } },
      ],
    },
  };
}

// ---------- heatmap with clustering ----------

export interface Heatmap { title: string; rows: string[]; cols: string[]; values: Array<Array<number | null>>; scaled: Array<Array<number | null>>; scale: 'row' | 'col' | 'none'; rowTree?: Dendrogram; colTree?: Dendrogram; rowOrder: number[]; colOrder: number[]; min: number; max: number; diverging: boolean; notes: string[] }
export interface Dendrogram { merges: Array<{ a: number; b: number; height: number }>; order: number[] }

export function parseHeatmap(source: string): Heatmap {
  checkSize(source, 'heatmap');
  const j = parseJson(source.trim(), 'heatmap');
  if (!isObj(j)) throw new Error('a heatmap is {"rows": [...], "cols": [...], "values": [[...], ...]}');
  const notes: string[] = [];
  let rows: string[]; let cols: string[]; let values: Array<Array<number | null>>;
  const matrix = j.values ?? j.matrix ?? j.data;
  if (Array.isArray(matrix) && matrix.every(Array.isArray)) {
    values = (matrix as unknown[][]).map((r) => r.map((v) => num(v) ?? null));
    const w = Math.max(0, ...values.map((r) => r.length));
    rows = Array.isArray(j.rows) ? j.rows.map((r) => text(r, 30)) : values.map((_, i) => `row ${i + 1}`);
    cols = Array.isArray(j.cols ?? j.columns) ? ((j.cols ?? j.columns) as unknown[]).map((c) => text(c, 30)) : Array.from({ length: w }, (_, i) => `col ${i + 1}`);
    if (rows.length !== values.length) throw new Error(`"rows" names ${rows.length} rows but "values" has ${values.length}`);
    if (values.some((r) => r.length !== cols.length)) throw new Error(`every row of "values" needs ${cols.length} numbers (one per column)`);
  } else if (Array.isArray(matrix)) {
    // Long form: [{"row", "col", "value"}].
    const r = new Map<string, number>(); const c = new Map<string, number>(); const cells: Array<[number, number, number | null]> = [];
    for (const x of matrix) { if (!isObj(x)) continue; const rn = text(x.row ?? x.gene ?? x.y, 30); const cn = text(x.col ?? x.sample ?? x.x, 30); if (!r.has(rn)) r.set(rn, r.size); if (!c.has(cn)) c.set(cn, c.size); cells.push([r.get(rn)!, c.get(cn)!, num(x.value ?? x.v) ?? null]); }
    rows = [...r.keys()]; cols = [...c.keys()];
    values = rows.map(() => cols.map(() => null));
    for (const [a, b, v] of cells) values[a]![b] = v;
  } else throw new Error('a heatmap needs "values" (a matrix) with "rows" and "cols", or "data" as [{"row", "col", "value"}]');
  if (!values.length || !cols.length) throw new Error('the heatmap has no cells');
  if (values.length > LIMITS.heatmapRows) { notes.push(tooLarge(LIMITS.heatmapRows, values.length, 'rows')); values = values.slice(0, LIMITS.heatmapRows); rows = rows.slice(0, LIMITS.heatmapRows); }
  if (cols.length > LIMITS.heatmapCols) { notes.push(tooLarge(LIMITS.heatmapCols, cols.length, 'columns')); values = values.map((r) => r.slice(0, LIMITS.heatmapCols)); cols = cols.slice(0, LIMITS.heatmapCols); }
  const scale = j.scale === 'row' || j.scale === 'col' ? j.scale : 'none';
  const scaled = scale === 'row' ? values.map(zscore) : scale === 'col' ? transpose(transpose(values).map(zscore)) : values;
  const cluster = typeof j.cluster === 'string' ? j.cluster : j.cluster === false ? 'none' : 'both';
  const rowTree = (cluster === 'both' || cluster === 'rows') && rows.length > 2 ? hclust(scaled) : undefined;
  const colTree = (cluster === 'both' || cluster === 'cols' || cluster === 'columns') && cols.length > 2 ? hclust(transpose(scaled)) : undefined;
  const flat = scaled.flat().filter((v): v is number => v !== null);
  if (!flat.length) throw new Error('the heatmap has no numbers');
  const min = Math.min(...flat); const max = Math.max(...flat);
  return { title: text(j.title, 80), rows, cols, values, scaled, scale, ...(rowTree ? { rowTree } : {}), ...(colTree ? { colTree } : {}), rowOrder: rowTree?.order ?? rows.map((_, i) => i), colOrder: colTree?.order ?? cols.map((_, i) => i), min, max, diverging: scale !== 'none' || (min < 0 && max > 0), notes };
}

const transpose = <T>(m: T[][]): T[][] => (m[0] ?? []).map((_, c) => m.map((r) => r[c]!));
function zscore(r: Array<number | null>): Array<number | null> {
  const v = r.filter((x): x is number => x !== null); if (v.length < 2) return r.map((x) => (x === null ? null : 0));
  const mu = v.reduce((a, b) => a + b, 0) / v.length; const sd = Math.sqrt(v.reduce((a, b) => a + (b - mu) ** 2, 0) / (v.length - 1)) || 1;
  return r.map((x) => (x === null ? null : round((x - mu) / sd, 4)));
}
function dist(a: Array<number | null>, b: Array<number | null>): number {
  let s = 0; let n = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i]; const y = b[i]; if (x !== null && x !== undefined && y !== null && y !== undefined) { s += (x - y) ** 2; n++; } }
  return n ? Math.sqrt((s * a.length) / n) : 0;
}

/** Average-linkage (UPGMA) clustering on Euclidean distance; leaves numbered 0..n-1, merges n.. in order. */
export function hclust(m: Array<Array<number | null>>): Dendrogram {
  const n = m.length; const D = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let k = i + 1; k < n; k++) { const d = dist(m[i]!, m[k]!); D[i * n + k] = d; D[k * n + i] = d; }
  const active = Array.from({ length: n }, (_, i) => i); const size = new Array(n).fill(1); const node = Array.from({ length: n }, (_, i) => i);
  const merges: Dendrogram['merges'] = [];
  while (active.length > 1) {
    let bi = 0; let bk = 1; let best = Infinity;
    for (let x = 0; x < active.length; x++) for (let y = x + 1; y < active.length; y++) { const d = D[active[x]! * n + active[y]!]!; if (d < best) { best = d; bi = x; bk = y; } }
    const i = active[bi]!; const k = active[bk]!;
    merges.push({ a: node[i]!, b: node[k]!, height: best });
    for (const o of active) if (o !== i && o !== k) { const d = (size[i]! * D[o * n + i]! + size[k]! * D[o * n + k]!) / (size[i]! + size[k]!); D[o * n + i] = d; D[i * n + o] = d; }
    size[i] += size[k]!; node[i] = n + merges.length - 1; active.splice(bk, 1);
  }
  const order: number[] = [];
  const stack = [n + merges.length - 1];
  while (stack.length) { const x = stack.pop()!; if (x < n) order.push(x); else { const mg = merges[x - n]!; stack.push(mg.b, mg.a); } }
  return { merges, order: n === 1 ? [0] : order };
}

/** Dendrogram segments in (leaf slot, height) units: x from 0..n-1 by the order, y from 0 (leaves) to max height. */
export function dendrogramSegments(t: Dendrogram): { segs: Array<[number, number, number, number]>; maxH: number } {
  const n = t.order.length; const pos = new Map<number, number>(); t.order.forEach((leaf, i) => pos.set(leaf, i));
  const h = new Map<number, number>(); const segs: Array<[number, number, number, number]> = [];
  let maxH = 0;
  t.merges.forEach((mg, i) => {
    const id = n + i; const xa = pos.get(mg.a)!; const xb = pos.get(mg.b)!; const ha = h.get(mg.a) ?? 0; const hb = h.get(mg.b) ?? 0;
    segs.push([xa, ha, xa, mg.height], [xb, hb, xb, mg.height], [xa, mg.height, xb, mg.height]);
    pos.set(id, (xa + xb) / 2); h.set(id, mg.height); maxH = Math.max(maxH, mg.height);
  });
  return { segs, maxH: maxH || 1 };
}
