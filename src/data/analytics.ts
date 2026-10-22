import { validateDashboard } from '../../packages/plugin-ui/src/dashboard.ts';
import { type CatalogSpec, DATA_VISUALS, type DocSpec, type FilterSpec, formatValue, type InlineMeasure, type ModelSpec, OPS, type PageSpec, parseField, type QueryResult, type QuerySpec, type Scalar, type ViewState, type VisualSpec, visualSummary } from '../../packages/plugin-ui/src/bi.ts';
import { DataError, qid, rowsHash } from './engine.ts';
import { CATALOG_ID, type DataHome, newId } from './home.ts';
import { type Actor, type Op, type OpOutcome, type Tx } from './ops.ts';
import { compileQuery } from './semantic.ts';
import { publicSource, testSource } from './sources.ts';
import { type DataService, OWNER, type Viewer } from './service.ts';

// What visuals compute beyond a plain query (decomposition, key drivers, forecasts and anomaly
// marks, narratives), the runtime state of a dashboard (slicers, cross-filter and highlight, drill,
// drill-through), and the read ops agents and the app use (describe, verify, suggest, history ...).
// Statistics run in SQL in the engine, with the method stated next to the result.

export type { ViewState };

const DEFAULT_HIGHLIGHT = new Set(['bar', 'column', 'pie', 'donut', 'treemap', 'funnel']);

/** The query a visual runs in this state, and the selection it highlights (if any). */
export function visualQuery(doc: DocSpec, page: PageSpec, v: VisualSpec, state: ViewState, model?: ModelSpec): { query?: QuerySpec; highlight?: FilterSpec[] } {
  const filters: FilterSpec[] = [...(doc.filters ?? []), ...(page.filters ?? []), ...(state.drillthrough && page.kind === 'drillthrough' ? state.drillthrough : [])];
  const own = v.type === 'slicer' ? v.options?.slicer?.field : undefined;
  for (const f of state.filters ?? []) if (f.field !== own) filters.push(f);
  let q: QuerySpec | undefined = v.query ? { ...v.query, model: v.query.model ?? doc.model } : undefined;
  if (v.type === 'slicer' && v.options?.slicer) q = { model: doc.model, dims: [v.options.slicer.field], sort: [{ by: v.options.slicer.field }], limit: 500 };
  // A narrative needs no query of its own: its placeholders are measures of the document's model.
  if (!q && v.type === 'narrative' && doc.model) q = { model: doc.model };
  if (!q) return {};
  const o = v.options ?? {};
  // A KPI against a target: the variance is a measure too, computed in SQL like the others.
  if (v.type === 'kpi' && typeof o.target === 'string' && q.measures?.length) {
    const m = typeof q.measures[0] === 'string' ? q.measures[0] : q.measures[0]!.name;
    if (!q.measures.some((x) => (typeof x === 'string' ? x : x.name) === o.target)) q = { ...q, measures: [...q.measures, o.target] };
    if (typeof q.measures?.[0] === 'string') q = { ...q, measures: [...q.measures!, { name: 'vs target', expr: `([${m}] - [${o.target}]) / NULLIF([${o.target}], 0)`, format: 'percent:1' }] };
  }
  if (v.type === 'waterfall' && !q.totals) q = { ...q, totals: { rows: 1 } };
  if ((v.type === 'table' || v.type === 'matrix') && q.dims?.length && q.measures?.length && v.options?.subtotals !== false && !q.totals) q = { ...q, totals: { rows: v.type === 'matrix' ? Math.max(1, Math.min(q.dims.length, o.rows ?? 1)) : q.dims.length, ...(v.type === 'matrix' ? {} : { columns: 0 }) } };
  for (const extra of [o.play, o.geo?.lat, o.geo?.lon]) if (extra && !q.dims?.includes(extra)) q = { ...q, dims: [...(q.dims ?? []), extra] };
  // Hierarchy drill: the level's field instead of the first dim, filtered by the path taken.
  const h = v.options?.hierarchy ? model?.hierarchies.find((x) => x.name === v.options!.hierarchy) : undefined;
  const dr = state.drill?.[v.id];
  if (h && dr && q.dims?.length) {
    const level = Math.max(0, Math.min(h.levels.length - 1, dr.level));
    q = { ...q, dims: [h.levels[level]!, ...q.dims.slice(1)] };
    dr.path.slice(0, level).forEach((val, i) => filters.push({ field: h.levels[i]!, op: 'eq', value: val }));
  }
  let highlight: FilterSpec[] | undefined;
  const sel = state.selection;
  if (sel && sel.visual !== v.id && page.visuals.some((x) => x.id === sel.visual)) {
    const src = page.visuals.find((x) => x.id === sel.visual)!;
    const mode = src.interactions?.[v.id] ?? (DEFAULT_HIGHLIGHT.has(v.type) && q.dims?.length ? 'highlight' : 'filter');
    if (mode === 'filter') filters.push(...sel.filters);
    else if (mode === 'highlight') highlight = sel.filters;
  }
  return { query: { ...q, filters: [...filters, ...(q.filters ?? [])] }, ...(highlight ? { highlight } : {}) };
}

/** A visual's data in a state: its query (with highlight), or what its analysis computes. */
export async function visualData(svc: DataService, home: DataHome, doc: DocSpec, v: VisualSpec, state: ViewState, viewer: Viewer = OWNER, o: { signal?: AbortSignal; catalog?: CatalogSpec } = {}): Promise<QueryResult> {
  const page = doc.pages.find((p) => p.visuals.some((x) => x.id === v.id)) ?? doc.pages[0]!;
  const cat = o.catalog ?? (await home.catalog()).spec;
  const model = doc.model ? svc.model(cat, doc.model) : undefined;
  if (doc.snapshot?.results[v.id] && !state.filters?.length && !state.selection) return doc.snapshot.results[v.id]!;
  const { query, highlight } = visualQuery(doc, page, v, state, model);
  if (!query) return { columns: [], rows: [], rowCount: 0, hash: rowsHash([]), ms: 0, at: Date.now(), lineage: { datasets: [] } };
  if (v.type === 'decomp') return decomposition(svc, home, v, query, state.decomp?.[v.id] ?? [], viewer, cat);
  if (v.type === 'drivers') return drivers(svc, home, v, query, viewer, cat);
  if (v.type === 'narrative') return narrative(svc, home, v, query, viewer, cat);
  if (v.type === 'kpi' && v.options?.trend) {
    // The KPI's value, its target and the trend behind it. A target that is a time calculation
    // (last year's value) is compared period by period: the KPI shows the latest period of the trend.
    const trend = v.options.trend;
    const target = typeof v.options.target === 'string' ? model?.measures.find((m) => m.name === v.options!.target) : undefined;
    const byPeriod = !!target?.calc && !['pct_of_total', 'rank'].includes(target.calc);
    const r = await svc.query(home, byPeriod ? { ...query, dims: [trend], sort: [{ by: trend, desc: true }], limit: 1 } : query, viewer, { signal: o.signal, catalog: cat, params: state.params });
    const t = await svc.query(home, { ...query, measures: query.measures!.slice(0, 1), dims: [trend], sort: [{ by: trend }] }, viewer, { catalog: cat, params: state.params });
    return { ...r, extra: { ...r.extra, trend: t.rows.map((x) => [x[0]!, x[1]!]) } };
  }
  const r = await svc.query(home, query, viewer, { signal: o.signal, highlight, catalog: cat, params: state.params });
  if ((v.type === 'line' || v.type === 'area' || v.type === 'combo') && (v.options?.forecast || v.options?.anomalies)) return { ...r, ...(await forecast(svc, home, v, query, viewer, cat)) };
  return r;
}

// ---------------- statistics in SQL ----------------

/** Runs SQL over a compiled query's result (named r) in the engine. */
async function over(svc: DataService, home: DataHome, q: QuerySpec, viewer: Viewer, cat: CatalogSpec, sql: (r: string) => string): Promise<{ columns: Array<{ name: string; type: string }>; rows: Scalar[][] }> {
  const state = await home.state();
  const model = svc.model(cat, q.model);
  const c = compileQuery(q, { model, columnsOf: (ds) => state.datasets[cat.datasets.find((d) => d.name === ds)?.id ?? '']?.columns, roles: viewer.owner ? undefined : viewer.roles ?? [], user: viewer.user, today: svc.deps.today?.() });
  const plan = await svc.plan(home, cat, c.datasets);
  return svc.engine.run({ files: plan.files, views: plan.views, vars: plan.vars, sql: `WITH r AS (${c.sql})\n${sql('r')}` });
}

async function forecast(svc: DataService, home: DataHome, v: VisualSpec, q: QuerySpec, viewer: Viewer, cat: CatalogSpec): Promise<Partial<QueryResult>> {
  const d = q.dims!.find((x) => parseField(x)?.grain)!;
  const g = parseField(d)!.grain!;
  const m = typeof q.measures![0] === 'string' ? q.measures![0] as string : (q.measures![0] as InlineMeasure).name;
  const series = q.dims!.find((x) => x !== d);
  const z = typeof v.options?.anomalies === 'object' ? v.options.anomalies.z ?? 2.5 : 2.5;
  const periods = Math.min(60, Math.max(1, Math.floor(v.options?.forecast?.periods ?? 0)));
  const part = series ? `${qid(series)}` : 'NULL';
  const step = g === 'quarter' ? 'INTERVAL 3 MONTH' : `INTERVAL 1 ${g.toUpperCase()}`;
  // Ordinary least squares on the period index, per series; residual standard error s; a 95%
  // prediction interval yhat +- 1.96 s sqrt(1 + 1/n + (x - mean x)^2 / Sxx); anomalies where the
  // residual is more than z standard errors.
  const base = `pts AS (SELECT ${part} AS s, ${qid(d)} AS d, CAST(${qid(m)} AS DOUBLE) AS y, row_number() OVER (PARTITION BY ${part} ORDER BY ${qid(d)}) AS x FROM r WHERE ${qid(m)} IS NOT NULL),
fit AS (SELECT s, regr_slope(y, x) AS b, regr_intercept(y, x) AS a, count(*) AS n, regr_avgx(y, x) AS mx, regr_sxx(y, x) AS sxx,
  sqrt(greatest(regr_syy(y, x) - regr_slope(y, x) * regr_sxy(y, x), 0) / greatest(count(*) - 2, 1)) AS se, max(x) AS lastx, max(d) AS lastd FROM pts GROUP BY s)`;
  const anomalies = v.options?.anomalies ? (await over(svc, home, q, viewer, cat, (r) => `, ${base}\nSELECT pts.s, pts.d, pts.y, (pts.y - (fit.a + fit.b * pts.x)) / NULLIF(fit.se, 0) AS z FROM pts JOIN fit ON pts.s IS NOT DISTINCT FROM fit.s WHERE fit.n >= 4 AND abs((pts.y - (fit.a + fit.b * pts.x)) / NULLIF(fit.se, 0)) > ${z} ORDER BY pts.d`).catch(() => undefined)) : undefined;
  const fc = periods && v.options?.forecast ? await over(svc, home, q, viewer, cat, () => `, ${base}\nSELECT fit.s, CAST(fit.lastd + k * ${step} AS DATE) AS d, fit.a + fit.b * (fit.lastx + k) AS yhat,
  fit.a + fit.b * (fit.lastx + k) - 1.96 * fit.se * sqrt(1 + 1.0 / fit.n + power(fit.lastx + k - fit.mx, 2) / NULLIF(fit.sxx, 0)) AS lo,
  fit.a + fit.b * (fit.lastx + k) + 1.96 * fit.se * sqrt(1 + 1.0 / fit.n + power(fit.lastx + k - fit.mx, 2) / NULLIF(fit.sxx, 0)) AS hi
FROM fit, range(1, ${periods + 1}) AS t(k) WHERE fit.n >= 3 ORDER BY 1, 2`) : undefined;
  return {
    extra: { ...(fc ? { forecast: fc.rows } : {}), ...(anomalies ? { anomalies: anomalies.rows } : {}) },
    method: `${fc ? `Forecast: a straight line fitted by least squares to ${m} over the ${g}s shown${series ? ` (per ${series})` : ''}, with a 95% prediction interval (±1.96 × residual standard error × √(1 + 1/n + (x − x̄)²/Sxx)); needs 3+ points. ` : ''}${anomalies ? `Anomalies: points whose residual from that line is more than ${z} residual standard errors (4+ points).` : ''}`.trim(),
  };
}

async function decomposition(svc: DataService, home: DataHome, v: VisualSpec, q: QuerySpec, path: Array<{ dim: string; value: Scalar }>, viewer: Viewer, cat: CatalogSpec): Promise<QueryResult> {
  const m = (q.measures ?? [])[0];
  if (!m) throw new DataError('a decomposition tree needs a measure');
  const dims = v.options?.dims ?? q.dims ?? [];
  const filters = [...(q.filters ?? []), ...path.map((p) => ({ field: p.dim, op: 'eq' as const, value: p.value }))];
  const total = await svc.query(home, { model: q.model, measures: [m], filters }, viewer, { catalog: cat });
  const left = dims.filter((d) => !path.some((p) => p.dim === d));
  // The suggested next split: the dimension whose values spread the measure most (population variance, in SQL).
  const spread: Array<{ dim: string; variance: number | null; groups: number }> = [];
  for (const d of left) {
    const r = await over(svc, home, { model: q.model, dims: [d], measures: [m], filters }, viewer, cat, (x) => `SELECT var_pop(CAST(${qid(typeof m === 'string' ? m : m.name)} AS DOUBLE)), count(*) FROM ${x}`);
    spread.push({ dim: d, variance: r.rows[0]?.[0] === null ? null : Number(r.rows[0]?.[0]), groups: Number(r.rows[0]?.[1] ?? 0) });
  }
  spread.sort((a, b) => (b.variance ?? -1) - (a.variance ?? -1));
  const next = spread[0]?.dim;
  const children = next ? await svc.query(home, { model: q.model, dims: [next], measures: [m], filters }, viewer, { catalog: cat }) : undefined;
  return { ...(children ?? total), extra: { total: total.rows[0]?.[0] ?? null, path, next: next ?? null, spread, remaining: left }, method: 'Next split: the dimension whose groups differ most in the measure (population variance of the group values), computed in SQL.' };
}

async function drivers(svc: DataService, home: DataHome, v: VisualSpec, q: QuerySpec, viewer: Viewer, cat: CatalogSpec): Promise<QueryResult> {
  const m = (q.measures ?? [])[0];
  if (!m) throw new DataError('key drivers need a measure (the metric to explain)');
  const name = typeof m === 'string' ? m : m.name;
  const factors = v.options?.dims ?? q.dims ?? [];
  if (!factors.length) throw new DataError('key drivers need factors (options.dims)');
  const overall = await svc.query(home, { model: q.model, measures: [m], filters: q.filters }, viewer, { catalog: cat });
  const base = Number(overall.rows[0]?.[0] ?? 0);
  const rows: Scalar[][] = [];
  for (const f of factors) {
    // Each segment's metric, its row count, and its ratio to the overall value; small segments left out.
    const r = await over(svc, home, { model: q.model, dims: [f], measures: [m, { name: '__rows', expr: 'count(*)' }], filters: q.filters }, viewer, cat, (x) => `SELECT ${qid(f)}, ${qid(name)}, __rows, sum(__rows) OVER () AS total FROM ${x}`);
    for (const row of r.rows) {
      const n = Number(row[2]); const total = Number(row[3]);
      if (n < Math.max(5, total * 0.02)) continue;
      const val = row[1] === null ? null : Number(row[1]);
      rows.push([f, row[0]!, val, n, base ? (val ?? 0) / base : null]);
    }
  }
  rows.sort((a, b) => Math.abs(Number(b[4] ?? 1) - 1) * Math.sqrt(Number(b[3])) - Math.abs(Number(a[4] ?? 1) - 1) * Math.sqrt(Number(a[3])));
  return { columns: [{ name: 'factor', label: 'Factor', type: 'VARCHAR', role: 'dim' }, { name: 'value', label: 'Value', type: 'VARCHAR', role: 'dim' }, { name: name, label: name, type: 'DOUBLE', role: 'measure' }, { name: 'rows', label: 'Rows', type: 'BIGINT', role: 'measure', format: 'integer' }, { name: 'ratio', label: `× overall`, type: 'DOUBLE', role: 'measure', format: 'number:2' }], rows: rows.slice(0, 20), rowCount: Math.min(20, rows.length), hash: rowsHash(rows), ms: 0, at: Date.now(), lineage: overall.lineage, extra: { overall: base }, method: `Each factor's segments compared with the overall ${name} (${formatValue(base)}): ratio = segment ÷ overall; segments with fewer than 5 rows or 2% of rows are left out; ranked by |ratio − 1| × √rows. Computed in SQL; it shows association, not cause.` };
}

// ---------------- narratives ----------------

const PLACEHOLDER = /\{\{\s*([^{}[\]|]+?)\s*(?:\[([^\]]*)\])?\s*\}\}/g;
function placeholderFilters(spec: string | undefined): FilterSpec[] {
  if (!spec?.trim()) return [];
  return spec.split(/[;,](?![^"]*")/).map((p) => p.trim()).filter(Boolean).map((p) => {
    const m = /^([A-Za-z_]\w*\.[^=]+?)\s*=\s*"?(.*?)"?$/.exec(p);
    if (!m) throw new DataError(`narrative filter "${p}" is field=value`);
    const v = m[2]!;
    return { field: m[1]!.trim(), op: 'eq' as const, value: /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v };
  });
}
/** Fills {{Measure}} and {{Measure[field=value]}} with computed values (formatted as the measure is). */
async function fill(svc: DataService, home: DataHome, q: QuerySpec, text: string, viewer: Viewer, cat: CatalogSpec): Promise<{ text: string; refs: Array<{ ref: string; measure: string; value: Scalar; formatted: string; filters: FilterSpec[] }> }> {
  const refs: Array<{ ref: string; measure: string; value: Scalar; formatted: string; filters: FilterSpec[] }> = [];
  for (const m of text.matchAll(PLACEHOLDER)) {
    const measure = m[1]!.trim();
    const filters = placeholderFilters(m[2]);
    const r = await svc.query(home, { model: q.model, measures: [measure], filters: [...(q.filters ?? []), ...filters] }, viewer, { catalog: cat });
    const value = r.rows[0]?.[0] ?? null;
    refs.push({ ref: m[0], measure, value, formatted: formatValue(value, r.columns[0]?.format), filters });
  }
  let i = 0;
  return { text: text.replace(PLACEHOLDER, () => refs[i++]!.formatted), refs };
}
async function narrative(svc: DataService, home: DataHome, v: VisualSpec, q: QuerySpec, viewer: Viewer, cat: CatalogSpec): Promise<QueryResult> {
  const f = await fill(svc, home, q, v.options?.text ?? '', viewer, cat);
  return { columns: [{ name: 'measure', label: 'Measure', type: 'VARCHAR', role: 'dim' }, { name: 'value', label: 'Value', type: 'DOUBLE', role: 'measure' }], rows: f.refs.map((r) => [r.measure, r.value]), rowCount: f.refs.length, hash: rowsHash(f.refs.map((r) => [r.measure, r.value])), ms: 0, at: Date.now(), lineage: { datasets: [] }, extra: { text: f.text, refs: f.refs.map((r) => ({ ref: r.ref, measure: r.measure, formatted: r.formatted, filters: r.filters })) } };
}

/**
 * Refuses a narrative with a number that no computed result backs: numbers belong in
 * placeholders ({{Revenue[regions.region=EU]}}), or must equal a value the visual's query or a
 * placeholder computed (years and quarter names aside).
 */
export async function checkNarrative(svc: DataService, home: DataHome, v: VisualSpec, text: string, cat: CatalogSpec): Promise<void> {
  const q: QuerySpec = { ...v.query, model: v.query?.model };
  const f = await fill(svc, home, q, text, OWNER, cat);
  const known: number[] = f.refs.map((r) => Number(r.value)).filter(Number.isFinite);
  const labels = new Set<string>();
  if (v.query?.dims?.length || v.query?.measures?.length) {
    const r = await svc.query(home, q, OWNER, { catalog: cat });
    for (const row of r.rows) row.forEach((x, i) => { if (typeof x === 'number' && r.columns[i]?.role === 'measure') known.push(x); else if (x !== null) labels.add(String(x)); });
  }
  const outside = text.replace(PLACEHOLDER, ' ');
  for (const m of outside.matchAll(/(?<![\w.])-?\d[\d,]*(?:\.\d+)?\s*(%|[kKmMbB]n?\b)?/g)) {
    const raw = m[0].trim();
    if (/^(19|20)\d\d$/.test(raw) || [...labels].some((l) => l.includes(raw))) continue;
    const prev = outside.slice(Math.max(0, (m.index ?? 0) - 1), m.index);
    if (/[QHqh]/.test(prev) && /^[1-4]$/.test(raw)) continue;
    let n = Number(raw.replace(/[,%kKmMbBn\s]/g, ''));
    if (/%$/.test(raw)) n /= 100;
    if (/[kK]$/.test(raw)) n *= 1e3; else if (/[mM]$/.test(raw)) n *= 1e6; else if (/[bB]n?$/.test(raw)) n *= 1e9;
    const backed = known.some((k) => k === n || (k !== 0 && Math.abs(k - n) / Math.abs(k) < 0.005) || Math.abs(k * 100 - n * 100) < 0.051 || (Math.abs(k) >= 1000 && Math.abs(k - n) / Math.abs(k) < 0.05 && /[kKmMbB]/.test(raw)));
    if (!backed) throw new DataError(`the narrative says ${raw}, which no computed result backs. Write numbers as placeholders ({{Measure}} or {{Measure[table.field=value]}}) so they are computed, or use a value the visual's query returned`);
  }
}

// ---------------- pinning ----------------

const colName = (s: unknown, i: number) => (String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, 60) || `value${i + 1}`);
/** A rendered block (chart, figure, table, KPIs) from a conversation into a document: its numbers become a static dataset marked as model-typed. */
export async function pinBlock(tx: Tx, a: Op): Promise<OpOutcome> {
  const block = (a.block ?? {}) as { lang?: string; source?: string };
  const lang = String(block.lang ?? '').toLowerCase();
  const src = String(block.source ?? '');
  let docId = typeof a.doc === 'string' ? a.doc : '';
  if (!docId) docId = await createDoc(tx, String(a.title ?? 'Pinned'));
  const doc = await tx.doc(docId);
  const added: string[] = [];
  const addStatic = (columns: string[], rows: Scalar[][], title: string) => {
    const name = `pinned_${tx.catalog.datasets.filter((d) => d.name.startsWith('pinned_')).length + 1}`;
    const sid = newId('src');
    tx.catalog.sources.push({ id: sid, name: `Pinned: ${title}`.slice(0, 80), type: 'static', columns, rows, origin: 'model', description: `Typed by a model in a conversation${tx.actor.session ? ` (${tx.actor.session})` : ''}. Bind a real source to trust these numbers.` });
    tx.catalog.datasets.push({ id: newId('ds'), name, source: sid, description: 'Static data from a pinned chart (model-typed)' });
    tx.touch();
    tx.checks.push(async () => { await tx.probeDataset(name); });
    return name;
  };
  const addVisual = async (v: Partial<VisualSpec>) => {
    const r = await (await import('./ops.ts')).applyHandler(tx, { op: 'add_visual', doc: docId, ...(a.page ? { page: a.page } : {}), visual: { ...v, ...(v.query ? { query: { ...v.query, model: '' } } : {}) } as Record<string, unknown> }); // model '': the pinned data's own tables, whatever model the document has
    added.push(r.message);
  };
  const m = (ds: string, col: string, agg = 'sum'): InlineMeasure => ({ name: col, expr: `${agg}(${ds}.${qid(col)})` });
  const chartToVisuals = async (spec: Record<string, unknown>, title?: string) => {
    const xa = (Array.isArray(spec.xAxis) ? spec.xAxis[0] : spec.xAxis) as { type?: string; data?: unknown[]; name?: string } | undefined;
    const ya = (Array.isArray(spec.yAxis) ? spec.yAxis[0] : spec.yAxis) as { type?: string; data?: unknown[]; name?: string } | undefined;
    const series = (Array.isArray(spec.series) ? spec.series : spec.series ? [spec.series] : []) as Array<{ name?: string; type?: string; data?: unknown[]; stack?: string; areaStyle?: unknown; radius?: unknown }>;
    if (!series.length) throw new DataError('the chart has no series to pin');
    const t = title ?? ((spec.title as { text?: string })?.text) ?? 'Pinned chart';
    const s0 = series[0]!;
    if (s0.type === 'pie' || s0.type === 'funnel') {
      const rows = (s0.data ?? []).map((d) => { const o = d as { name?: unknown; value?: unknown }; return [String(o.name ?? ''), Number(o.value)] as Scalar[]; });
      const ds = addStatic(['name', 'value'], rows, t);
      return addVisual({ type: s0.type === 'funnel' ? 'funnel' : Array.isArray(s0.radius) ? 'donut' : 'pie', title: t, query: { dims: [`${ds}.name`], measures: [m(ds, 'value')] } });
    }
    if (s0.type === 'scatter') {
      const rows = (s0.data ?? []).map((d) => (Array.isArray(d) ? d.slice(0, 2) : [d, null]) as Scalar[]).map((r, i) => [i + 1, ...r]);
      const ds = addStatic(['point', xa?.name || 'x', ya?.name || 'y'], rows, t);
      return addVisual({ type: 'scatter', title: t, query: { dims: [`${ds}.point`], measures: [m(ds, xa?.name || 'x'), m(ds, ya?.name || 'y')] } });
    }
    const horizontal = ya?.type === 'category';
    const cats = (horizontal ? ya?.data : xa?.data) ?? (s0.data ?? []).map((_, i) => `${i + 1}`);
    const names = series.map((s, i) => colName(s.name, i));
    const catCol = colName((horizontal ? ya?.name : xa?.name) || 'category', 0);
    const rows = cats.map((c, i) => [String(c), ...series.map((s) => { const v = s.data?.[i]; const n = Array.isArray(v) ? v[1] : typeof v === 'object' && v ? (v as { value?: unknown }).value : v; return n === null || n === undefined || n === '' ? null : Number(n); })] as Scalar[]);
    const ds = addStatic([catCol, ...names], rows, t);
    const kind = s0.type === 'line' ? (s0.areaStyle ? 'area' : 'line') : horizontal ? 'bar' : 'column';
    const mixed = new Set(series.map((s) => s.type)).size > 1;
    return addVisual({ type: mixed ? 'combo' : kind, title: t, query: { dims: [`${ds}.${catCol}`], measures: names.map((n) => m(ds, n)), sort: [{ by: `${ds}.${catCol}` }] }, options: { ...(series.some((s) => s.stack) ? { stack: 'stacked' as const } : {}), ...(mixed ? { lines: series.filter((s) => s.type === 'line').map((s, i) => colName(s.name, series.indexOf(s) ?? i)) } : {}) } });
  };
  const vizToVisuals = async (spec: Record<string, unknown>, title?: string) => {
    const vals = ((spec.data as { values?: unknown[] })?.values ?? []) as Array<Record<string, unknown>>;
    if (!vals.length) throw new DataError('the figure has no inline data (data.values) to pin');
    const columns = [...new Set(vals.flatMap((r) => Object.keys(r)))];
    const ds = addStatic(columns.map((c, i) => colName(c, i)), vals.map((r) => columns.map((c) => (r[c] ?? null) as Scalar)), title ?? String(spec.title ?? 'Pinned figure'));
    const enc = (spec.encoding ?? {}) as Record<string, { field?: string; type?: string; aggregate?: string }>;
    const mark = String(typeof spec.mark === 'object' ? (spec.mark as { type?: string }).type : spec.mark ?? 'bar');
    const isQ = (e?: { type?: string }) => e?.type === 'quantitative';
    const meas = [enc.y, enc.x, enc.theta, enc.size].filter((e) => isQ(e) && e?.field);
    const dims = [enc.x, enc.y, enc.color, enc.column].filter((e) => e?.field && !isQ(e));
    const agg = (e?: { aggregate?: string }) => (['mean', 'average'].includes(e?.aggregate ?? '') ? 'avg' : ['sum', 'min', 'max', 'count', 'median'].includes(e?.aggregate ?? '') ? e!.aggregate! : 'sum');
    const type = mark === 'line' ? 'line' : mark === 'area' ? 'area' : mark === 'arc' ? 'pie' : mark === 'point' || mark === 'circle' ? 'scatter' : isQ(enc.x) ? 'bar' : 'column';
    if (!meas.length) return addVisual({ type: 'table', title: title ?? 'Pinned figure', query: { columns: columns.map((c, i) => `${ds}.${colName(c, i)}`) } });
    return addVisual({ type, title: title ?? String(spec.title ?? 'Pinned figure'), query: { dims: dims.map((e) => `${ds}.${e!.field}`), measures: meas.map((e) => m(ds, e!.field!, agg(e))) } });
  };
  const tableToVisual = async (columns: string[], rows: Scalar[][], title: string) => {
    const ds = addStatic(columns, rows, title);
    return addVisual({ type: 'table', title, query: { columns: columns.map((c) => `${ds}.${c}`) } });
  };
  const parseDelimited = (text: string, sep: string) => {
    const lines = text.trim().split(/\r?\n/).filter(Boolean);
    const split = (l: string) => l.split(sep).map((x) => x.trim().replace(/^"(.*)"$/, '$1'));
    const head = split(lines[0] ?? '').map(colName);
    return { columns: head, rows: lines.slice(1).map((l) => split(l).map((x) => (x === '' ? null : /^-?\d+(\.\d+)?$/.test(x) ? Number(x) : x)) as Scalar[]) };
  };
  try {
    if (['chart', 'echarts'].includes(lang)) await chartToVisuals(JSON.parse(src) as Record<string, unknown>, a.title as string | undefined);
    else if (['vega-lite', 'vegalite', 'vega', 'viz'].includes(lang)) await vizToVisuals(JSON.parse(src) as Record<string, unknown>, a.title as string | undefined);
    else if (lang === 'csv' || lang === 'tsv') { const t = parseDelimited(src, lang === 'csv' ? ',' : '\t'); await tableToVisual(t.columns, t.rows, String(a.title ?? 'Pinned table')); }
    else if (lang === 'table' || lang === 'json') {
      const j = JSON.parse(src) as { columns?: unknown[]; rows?: unknown[] } | unknown[];
      const { jsonTable } = await import('./sources.ts');
      const t = jsonTable(j);
      await tableToVisual(t.columns.map(colName), t.rows as Scalar[][], String(a.title ?? 'Pinned table'));
    } else if (lang === 'dashboard') {
      const { spec, error } = validateDashboard(JSON.parse(src));
      if (!spec) throw new DataError(error ?? 'not a dashboard');
      if (spec.kpis?.length) {
        const ds = addStatic(['label', 'value', 'unit'], spec.kpis.map((k) => [k.label, typeof k.value === 'number' ? k.value : Number(String(k.value).replace(/[^\d.-]/g, '')) || null, k.unit ?? null]), spec.title ?? 'KPIs');
        for (const k of spec.kpis) await addVisual({ type: 'card', title: k.label, query: { measures: [{ name: k.label, expr: `sum(${ds}.value)`, filter: `${ds}.label = '${k.label.replace(/'/g, "''")}'` }] } });
      }
      for (const p of spec.panels) {
        const s = typeof p.spec === 'string' ? JSON.parse(p.spec) : p.spec;
        if (p.kind === 'chart') await chartToVisuals(s as Record<string, unknown>, p.title);
        else if (p.kind === 'viz') await vizToVisuals(s as Record<string, unknown>, p.title);
        else if (p.kind === 'table') { const { jsonTable } = await import('./sources.ts'); const t = jsonTable(s); await tableToVisual(t.columns.map(colName), t.rows as Scalar[][], p.title ?? 'Table'); }
        else if (p.kind === 'markdown') await addVisual({ type: 'text', title: p.title, options: { markdown: String(p.spec) } });
      }
    } else throw new DataError(`a ${lang || 'block'} cannot be pinned: pin a chart, vega-lite figure, table, csv or dashboard`);
  } catch (e) { if (e instanceof DataError) throw e; throw new DataError(`the block could not be read: ${(e as Error).message}`); }
  return { op: 'pin', message: `pinned into ${docId}: ${added.join('; ')} (static, model-typed data: bind a real source with "bind")`, data: { doc: docId, visuals: added } };
}
async function createDoc(tx: Tx, title: string): Promise<string> {
  const r = await (await import('./ops.ts')).applyHandler(tx, { op: 'create', doc: { type: 'dashboard', title } });
  return (r.data as { id: string }).id;
}

// ---------------- describing ----------------

export function describeModel(m: ModelSpec, columnsOf: (dataset: string) => Array<{ name: string; type: string }> | undefined): string {
  const lines = [`model ${m.id} "${m.name}"${m.date ? ` date ${m.date}` : ''}`];
  for (const t of m.tables) {
    const cols = columnsOf(t.dataset)?.filter((c) => c.name !== '__rn').map((c) => `${c.name} ${c.type}`) ?? ['(not read yet)'];
    lines.push(`table ${t.name} (dataset ${t.dataset}): ${[...cols, ...(t.columns ?? []).map((c) => `${c.name} = ${c.expr}`)].join(', ')}`);
  }
  for (const r of m.relationships) lines.push(`relationship ${r.from} -> ${r.to} ${r.cardinality ?? 'n:1'}${r.crossFilter === 'both' ? ' both' : ''}${r.active === false ? ' inactive' : ''}`);
  for (const x of m.measures) lines.push(`measure "${x.name}" = ${x.expr ?? `${x.calc}(${x.base})`}${x.filter ? ` where ${x.filter}` : ''}${x.format ? ` [${x.format}]` : ''}`);
  for (const h of m.hierarchies) lines.push(`hierarchy ${h.name}: ${h.levels.join(' > ')}`);
  for (const r of m.roles) lines.push(`role ${r.name} (${r.members.length} members): ${Object.entries(r.filters).map(([t, p]) => `${t}: ${p}`).join('; ')}`);
  return lines.join('\n');
}
export function describeDoc(id: string, d: DocSpec, version: number): string {
  const lines = [`${id} v${version} ${d.type} "${d.title}"${d.model ? ` model ${d.model}` : ''}${d.theme ? ` theme ${typeof d.theme === 'string' ? d.theme : d.theme.name}` : ''}${d.refresh ? ` refresh ${d.refresh.mode}${d.refresh.every ? ` ${d.refresh.every}s` : d.refresh.cron ? ` ${d.refresh.cron}` : ''}` : ''}`];
  const fl = (fs?: FilterSpec[]) => (fs ?? []).map((f) => `${f.field} ${f.op} ${JSON.stringify(f.values ?? f.value ?? f.n ?? '')}`).join('; ');
  if (d.filters?.length) lines.push(`filters: ${fl(d.filters)}`);
  for (const p of d.pages) {
    lines.push(`page ${p.id} "${p.name}"${p.kind ? ` ${p.kind}` : ''}${p.drillFields ? ` drill ${p.drillFields.join(',')}` : ''}${p.filters?.length ? ` filters ${fl(p.filters)}` : ''}`);
    for (const v of p.visuals) lines.push(`  ${v.id} ${visualSummary(v)} @${v.layout.x},${v.layout.y} ${v.layout.w}x${v.layout.h}${v.query?.filters?.length ? ` filters ${fl(v.query.filters)}` : ''}${Object.keys(v.options ?? {}).length ? ` options ${JSON.stringify(v.options).slice(0, 160)}` : ''}${v.interactions ? ` interactions ${JSON.stringify(v.interactions)}` : ''}`);
  }
  for (const b of d.bookmarks ?? []) lines.push(`bookmark ${b.id} "${b.name}" page ${b.page}`);
  for (const a of d.alerts ?? []) lines.push(`alert ${a.id} "${a.name}": ${a.measure} ${a.op} ${a.value}`);
  for (const s of d.subscriptions ?? []) lines.push(`subscription ${s.id}: ${s.format} ${s.cron} ${s.deliver}`);
  if (d.snapshot) lines.push(`snapshot at ${new Date(d.snapshot.at).toISOString()}`);
  return lines.join('\n');
}

/** A result as a short table for an agent (never every row). */
export function summarize(r: QueryResult, max = 20): string {
  const head = r.columns.map((c) => c.name);
  const fmt = (row: Scalar[]) => row.map((v, i) => (typeof v === 'number' ? formatValue(v, r.columns[i]?.format) : v === null ? 'null' : String(v).slice(0, 40))).join(' | ');
  const lines = [head.join(' | '), ...r.rows.slice(0, max).map(fmt)];
  if (r.rows.length > max) lines.push(`... ${r.rows.length - max} more rows${r.truncated ? ' (and more: capped)' : ''}`);
  const ds = r.lineage.datasets.map((d) => `${d.name}${d.static ? ' (static' + (d.origin === 'model' ? ', model-typed' : '') + ')' : ''}${d.refreshedAt ? ` @${new Date(d.refreshedAt).toISOString().slice(0, 16)}` : ''}`).join(', ');
  return `${lines.join('\n')}\n(${r.rowCount} rows; hash ${r.hash.slice(0, 12)}; from ${ds || 'no dataset'})`;
}

// ---------------- verify and suggest ----------------

export async function verifyDoc(svc: DataService, home: DataHome, id: string): Promise<{ ok: boolean; text: string; visuals: Array<Record<string, unknown>> }> {
  const { spec: doc } = await home.doc(id);
  const cat = (await home.catalog()).spec;
  const out: Array<Record<string, unknown>> = [];
  const totals = new Map<string, number | null>();
  let ok = true;
  for (const p of doc.pages) for (const v of p.visuals) {
    if (!DATA_VISUALS.has(v.type)) continue;
    try {
      const r = await visualData(svc, home, { ...doc, snapshot: undefined }, v, { page: p.id }, OWNER, { catalog: cat });
      const ms = r.columns.map((c, i) => [c, i] as const).filter(([c]) => c.role === 'measure');
      const nulls = ms.reduce((n, [, i]) => n + r.rows.filter((row) => row[i] === null).length, 0);
      const sums: Record<string, number> = {};
      const level = r.columns.findIndex((c) => c.role === 'level');
      for (const [c, i] of ms) sums[c.name] = r.rows.filter((row) => level < 0 || row[level] === 0).reduce((s, row) => s + (typeof row[i] === 'number' ? row[i] as number : 0), 0);
      const reconcile: string[] = [];
      for (const [c] of ms) {
        if (!(v.query?.dims?.length) || r.truncated || v.query.limit || (v.query.filters ?? []).some((f) => f.op === 'top' || f.op === 'bottom')) continue;
        const qm = (v.query.measures ?? []).find((x) => (typeof x === 'string' ? x : x.name) === c.name);
        if (!qm) continue;
        if (!totals.has(c.name + JSON.stringify(v.query.filters ?? []))) {
          const t = await svc.query(home, { model: v.query.model ?? doc.model, measures: [qm], filters: [...(doc.filters ?? []), ...(p.filters ?? []), ...(v.query.filters ?? [])] }, OWNER, { catalog: cat }).catch(() => undefined);
          totals.set(c.name + JSON.stringify(v.query.filters ?? []), t ? Number(t.rows[0]?.[0] ?? null) : null);
        }
        const total = totals.get(c.name + JSON.stringify(v.query.filters ?? []));
        if (total !== null && total !== undefined) {
          const diff = Math.abs(sums[c.name]! - total);
          reconcile.push(diff <= Math.max(1e-6, Math.abs(total) * 1e-9) ? `${c.name} rows add up to the total ${formatValue(total, c.format)}` : `${c.name} rows add up to ${formatValue(sums[c.name]!, c.format)}, the total is ${formatValue(total, c.format)} (fine for a non-additive measure such as an average or a distinct count; check otherwise)`);
        }
      }
      const statics = r.lineage.datasets.filter((d) => d.static && d.origin === 'model').map((d) => d.name);
      const warnings = ((r.extra?.warnings as string[] | undefined) ?? []);
      const empty = !r.rows.length && v.type !== 'narrative';
      if (empty || statics.length || warnings.length) ok = false;
      out.push({ visual: v.id, title: v.title, type: v.type, rows: r.rowCount, nulls, sums, reconcile, ...(statics.length ? { static: statics } : {}), ...(warnings.length ? { warnings } : {}), ...(empty ? { empty: true } : {}) });
    } catch (e) { ok = false; out.push({ visual: v.id, title: v.title, type: v.type, error: (e as Error).message }); }
  }
  const text = out.map((x) => `${x.visual} ${x.type}${x.title ? ` "${x.title}"` : ''}: ${x.error ? `ERROR ${x.error}` : `${x.rows} rows, ${x.nulls} null values${(x.reconcile as string[]).length ? `; ${(x.reconcile as string[]).join('; ')}` : ''}${x.static ? `; STATIC model-typed data (${(x.static as string[]).join(', ')}): bind a real source` : ''}${x.warnings ? `; WARNING ${(x.warnings as string[]).join('; ')}` : ''}${x.empty ? '; EMPTY' : ''}`}`).join('\n');
  return { ok, text: `${ok ? 'verified: every visual ran' : 'problems found'}\n${text}`, visuals: out };
}

/** Profiles datasets and proposes a model: relationships where values match, measures for numbers, a calendar. As ops to apply. */
export async function suggestModel(svc: DataService, home: DataHome, names: string[] | undefined): Promise<{ text: string; ops: Op[] }> {
  const cat = (await home.catalog()).spec;
  const ds = (names?.length ? names : cat.datasets.map((d) => d.name)).map((n) => svc.dataset(cat, n));
  const cols = new Map<string, Array<{ name: string; type: string }>>();
  const rows = new Map<string, number>();
  for (const d of ds) {
    const plan = await svc.plan(home, cat, [d.name]);
    cols.set(d.name, (await svc.engine.describe({ files: plan.files, views: plan.views, vars: plan.vars, sql: `SELECT * FROM ${qid(d.name)}` })));
    rows.set(d.name, Number((await svc.engine.run({ files: plan.files, views: plan.views, vars: plan.vars, sql: `SELECT count(*) FROM ${qid(d.name)}` })).rows[0]![0]));
  }
  const ops: Op[] = [];
  const modelId = 'model';
  ops.push({ op: 'add_model', model: { id: modelId, name: 'Model' } });
  for (const d of ds) ops.push({ op: 'set_table', model: modelId, table: { name: d.name, dataset: d.name } });
  const isNum = (t: string) => /INT|DOUBLE|DECIMAL|FLOAT|REAL/.test(t);
  const notes: string[] = [];
  // Relationships: a column of A whose values all appear in a unique column of B.
  for (const a of ds) for (const b of ds) {
    if (a === b) continue;
    for (const ca of cols.get(a.name)!) for (const cb of cols.get(b.name)!) {
      const named = ca.name.toLowerCase() === cb.name.toLowerCase() || ca.name.toLowerCase() === `${b.name.toLowerCase().replace(/s$/, '')}_${cb.name.toLowerCase()}` || ca.name.toLowerCase() === `${b.name.toLowerCase().replace(/s$/, '')}${cb.name.toLowerCase()}`;
      if (!named || isNum(ca.type) !== isNum(cb.type) || (rows.get(a.name)! < rows.get(b.name)!)) continue;
      const plan = await svc.plan(home, cat, [a.name, b.name]);
      const r = await svc.engine.run({ files: plan.files, views: plan.views, vars: plan.vars, sql: `SELECT (SELECT count(*) - count(DISTINCT ${qid(cb.name)}) FROM ${qid(b.name)}) AS dup, (SELECT count(*) FROM ${qid(a.name)} WHERE ${qid(ca.name)} IS NOT NULL AND ${qid(ca.name)} NOT IN (SELECT ${qid(cb.name)} FROM ${qid(b.name)} WHERE ${qid(cb.name)} IS NOT NULL)) AS orphans, (SELECT count(*) FROM ${qid(a.name)}) AS n` });
      const [dup, orphans, n] = r.rows[0]!.map(Number);
      if (dup === 0 && orphans! <= n! * 0.05) { ops.push({ op: 'set_relationship', model: modelId, relationship: { from: `${a.name}.${ca.name}`, to: `${b.name}.${cb.name}` } }); notes.push(`${a.name}.${ca.name} -> ${b.name}.${cb.name} (${orphans} of ${n} rows without a match)`); }
    }
  }
  const facts = ds.filter((d) => ops.some((o) => o.op === 'set_relationship' && String((o.relationship as { from: string }).from).startsWith(`${d.name}.`)));
  for (const f of facts.length ? facts : ds.slice(0, 1)) {
    for (const c of cols.get(f.name)!) if (isNum(c.type) && !/(^id$|_id$|id$|code|year|month|zip|phone)/i.test(c.name)) ops.push({ op: 'set_measure', model: modelId, measure: { name: `Total ${c.name}`, expr: `sum(${f.name}.${qid(c.name)})`, format: /amount|revenue|sales|price|cost|profit/i.test(c.name) ? 'currency:USD' : 'number:2' } });
    ops.push({ op: 'set_measure', model: modelId, measure: { name: `${f.name} rows`, expr: `count(*)`, table: f.name, format: 'integer' } });
    const date = cols.get(f.name)!.find((c) => /^(DATE|TIMESTAMP)/.test(c.type));
    if (date) {
      ops.push({ op: 'set_model', model: modelId, patch: { date: `${f.name}.${date.name}` } });
      ops.push({ op: 'set_hierarchy', model: modelId, hierarchy: { name: 'Calendar', levels: ['year', 'quarter', 'month', 'day'].map((g) => `${f.name}.${date.name}:${g}`) } });
    }
  }
  return { ops, text: `Proposed model (apply the ops to accept; review the measures' names and formats):\n${notes.map((n) => `relationship ${n}`).join('\n')}\n${ops.filter((o) => o.op === 'set_measure').map((o) => `measure ${(o.measure as { name: string; expr: string }).name} = ${(o.measure as { expr: string }).expr}`).join('\n')}` };
}

// ---------------- reads and actions ----------------

const isOutside = (r: QueryResult) => r.lineage.datasets.some((d) => d.sourceType === 'http' || d.sourceType === 'plugin' || !!d.provenance?.length);

/** The ops that read or act (refresh, publish, export, undo ...): run after a batch's changes are written. */
export async function reads(svc: DataService, home: DataHome, a: Op, actor: Actor, _tx?: Tx): Promise<OpOutcome & { untrusted?: boolean }> {
  const cat = (await home.catalog()).spec;
  const state = await home.state();
  const colsOf = (ds: string) => state.datasets[cat.datasets.find((d) => d.name === ds)?.id ?? '']?.columns;
  const docRef = async () => { const id = String(a.doc ?? ''); const d = await home.doc(id); return { id, ...d }; };
  switch (a.op) {
    case 'list_sources': return { op: a.op, message: cat.sources.map((s) => `${s.id} "${s.name}" ${s.type}${s.path ? ` ${s.path}` : ''}${s.url ? ` ${s.url}` : ''}${s.secret ? ` secret:${s.secret}` : ''}${s.origin === 'model' ? ' (model-typed)' : ''} used by ${cat.datasets.filter((d) => d.source === s.id).map((d) => d.name).join(', ') || 'nothing'}`).join('\n') || 'no sources yet', data: cat.sources.map(publicSource) };
    case 'test_source': {
      const s = cat.sources.find((x) => x.id === a.id || x.name === a.id);
      if (!s) throw new DataError(`no source "${String(a.id)}"`);
      const r = await testSource(s, await svc.sourceContext(home));
      return { op: a.op, message: `${s.name}: ${r.note}; tables: ${r.tables.slice(0, 50).join(', ')}`, data: r };
    }
    case 'list_datasets': return { op: a.op, message: cat.datasets.map((d) => { const st = state.datasets[d.id]; return `${d.name}${d.certified ? ' [certified]' : d.promoted ? ' [promoted]' : ''} from ${cat.sources.find((s) => s.id === d.source)?.name ?? 'SQL'}${d.steps?.length ? `, ${d.steps.length} steps` : ''}: ${st?.error ? `ERROR ${st.error}` : st?.at ? `${st.rows ?? '?'} rows @${new Date(st.at).toISOString().slice(0, 16)}` : 'not read yet'}${st?.columns ? `; columns ${st.columns.map((c) => `${c.name} ${c.type}`).join(', ')}` : ''}${d.refresh ? `; refresh ${d.refresh.mode}` : ''}`; }).join('\n') || 'no datasets yet', data: cat.datasets.map((d) => ({ ...d, state: state.datasets[d.id] ?? {} })) };
    case 'query': {
      const r = await svc.sql(home, String(a.sql ?? ''), { limit: Math.min(Number(a.limit ?? 1000) || 1000, 5000) });
      return { op: a.op, message: summarize(r, Number(a.show ?? 20)), data: r, ...(isOutside(r) ? { untrusted: true } : {}) };
    }
    case 'preview': {
      const r = await svc.preview(home, String(a.dataset ?? ''), { step: a.step === undefined ? undefined : Number(a.step), limit: Number(a.limit ?? 200) });
      return { op: a.op, message: summarize(r, 15), data: r, ...(isOutside(r) ? { untrusted: true } : {}) };
    }
    case 'profile': {
      const p = await svc.profile(home, String(a.dataset ?? ''), { step: a.step === undefined ? undefined : Number(a.step) });
      return { op: a.op, message: `${p.rows} rows\n${p.columns.map((c) => `${c.name} ${c.type}: ${c.nulls} null, ${c.distinct} distinct, ${c.min ?? ''}..${c.max ?? ''}${c.mean !== null ? `, mean ${formatValue(c.mean)}` : ''}; top ${c.top.map(([v, n]) => `${v}(${n})`).join(', ')}`).join('\n')}`, data: p };
    }
    case 'refresh': {
      if (a.doc) { const r = await svc.refreshDoc(home, String(a.doc), `by ${actor.label}`); return { op: a.op, message: r.datasets.map((d) => `${d.name}: ${d.ok ? `${d.rows} rows` : `FAILED ${d.error}`}`).join('\n') || 'nothing to refresh', data: r }; }
      const st = await svc.refresh(home, String(a.dataset ?? ''), `by ${actor.label}`);
      return { op: a.op, message: `${String(a.dataset)}: ${st.rows ?? '-'} rows, columns ${(st.columns ?? []).map((c) => c.name).join(', ')}`, data: st };
    }
    case 'describe_model': { const m = svc.model(cat, String(a.model ?? '')); return { op: a.op, message: describeModel(m, colsOf), data: m }; }
    case 'model_query': {
      const q = (a.query ?? {}) as QuerySpec;
      const r = await svc.query(home, q, OWNER, { limit: 5000 });
      return { op: a.op, message: `${summarize(r)}\nSQL:\n${r.lineage.sql}${r.extra?.warnings ? `\nWARNINGS: ${(r.extra.warnings as string[]).join('; ')}` : ''}`, data: r, ...(isOutside(r) ? { untrusted: true } : {}) };
    }
    case 'suggest': { const s = await suggestModel(svc, home, a.datasets as string[] | undefined); return { op: a.op, message: s.text, data: s }; }
    case 'list_docs': {
      const usage = await home.usage();
      const pub = await svc.published();
      const docs = await Promise.all((await home.docs()).map(async (m) => { const d = (await home.doc(m.id)).spec; return { id: m.id, type: d.type, title: d.title, version: m.version, updatedAt: m.updatedAt, pages: d.pages.length, visuals: d.pages.reduce((n, p) => n + p.visuals.length, 0), model: d.model, views: usage[m.id]?.views ?? 0, published: pub.some((p) => p.owner === home.owner && p.doc === m.id), refresh: d.refresh?.mode ?? 'manual' }; }));
      return { op: a.op, message: docs.map((d) => `${d.id} ${d.type} "${d.title}" v${d.version}: ${d.pages} pages, ${d.visuals} visuals${d.published ? ', published' : ''}`).join('\n') || 'no dashboards or reports yet', data: docs };
    }
    case 'describe': {
      const d = await docRef();
      const m = d.spec.model ? cat.models.find((x) => x.id === d.spec.model) : undefined;
      void home.countView(d.id, 'app').catch(() => {});
      return { op: a.op, message: `${describeDoc(d.id, d.spec, d.version)}${m ? `\n${describeModel(m, colsOf)}` : `\ndatasets: ${cat.datasets.map((x) => `${x.name}(${(colsOf(x.name) ?? []).map((c) => c.name).join(', ')})`).join('; ')}`}`, data: { id: d.id, version: d.version, doc: d.spec } };
    }
    case 'verify': { const v = await verifyDoc(svc, home, String(a.doc ?? '')); return { op: a.op, message: v.text, data: v }; }
    case 'history': {
      const target = String(a.doc ?? a.target ?? CATALOG_ID);
      const meta = await home.store.meta(target);
      if (!meta) throw new DataError(`no ${target}`, 404);
      const log = (await home.log()).filter((e) => e.target === target);
      const rows = meta.versions.map((v) => { const e = log.find((x) => x.to === v.n); return { version: v.n, at: v.at, by: e?.by ?? '', session: e?.session, ops: e?.ops ?? [], kind: e?.kind ?? v.action }; });
      return { op: a.op, message: rows.slice(-30).map((r) => `v${r.version} ${new Date(r.at).toISOString().slice(0, 16)} ${r.by} ${r.kind}${r.ops.length ? ` ${r.ops.join(',')}` : ''}${r.session ? ` (session ${r.session})` : ''}`).join('\n'), data: rows };
    }
    case 'undo': case 'redo': case 'restore': return undoRedo(svc, home, a, actor);
    case 'publish': {
      const d = await docRef();
      if (a.remote && typeof a.remote === 'object') {
        // To another harness server: its rows, document and model, pushed with that server's token (a vault entry here).
        const rm = a.remote as { url: string; secret: string; access?: 'token' | 'signed-in' };
        if (!rm.url || !rm.secret) throw new DataError('remote is {url, secret: a key vault entry holding that server\'s token}');
        const { pushRemote } = await import('./remote.ts');
        const r = await pushRemote(svc, home, d.id, rm, true);
        await svc.addRemote(home.owner, d.id, { url: rm.url, secret: rm.secret, id: r.id, slug: r.slug, by: actor.label });
        return { op: a.op, message: `published ${d.id} on ${new URL(rm.url).host}: ${r.url} (its rows are pushed again after every refresh here; unpublish takes it down there too)`, data: { ...r, remote: rm.url } };
      }
      const access = a.access === 'signed-in' ? 'signed-in' : 'token';
      const accounts = Array.isArray(a.accounts) ? (a.accounts as string[]) : undefined;
      if (a.role) { const m = d.spec.model ? cat.models.find((x) => x.id === d.spec.model) : undefined; if (!m?.roles.some((r) => r.name === a.role)) throw new DataError(`no role ${String(a.role)} in the model`); }
      const r = await svc.publish(home.owner, d.id, { access, accounts, role: a.role as string | undefined, showSql: a.showSql === true, by: actor.label });
      const base = (process.env.HARNESS_PUBLIC_URL ?? '').replace(/\/+$/, '');
      const url = `${base}/p/${r.entry.slug}${r.token ? `#t=${r.token}` : ''}`;
      const rlsNote = access === 'token' && !a.role && cat.models.find((x) => x.id === d.spec.model)?.roles.length ? ' NOTE: the model has row-level security roles and this link has none, so it shows every row; publish with role to restrict it.' : '';
      return { op: a.op, message: `published ${d.id} at ${url}${access === 'signed-in' ? ` (signed-in ${accounts?.join(', ') ?? 'accounts'})` : ' (anyone with the link)'}${r.entry.role ? `, role ${r.entry.role}` : ''}.${rlsNote} Embed: <iframe src="${url}" style="border:0;width:100%;height:720px"></iframe>`, data: { slug: r.entry.slug, url, ...(r.token ? { token: r.token } : {}), access } };
    }
    case 'unpublish': { const ok = await svc.unpublish(home.owner, String(a.doc ?? '')); return { op: a.op, message: ok ? `unpublished ${String(a.doc)}: its link stopped working` : `${String(a.doc)} was not published` }; }
    case 'export': { const { exportDoc } = await import('./export.ts'); const r = await exportDoc(svc, home, String(a.doc ?? ''), String(a.format ?? 'xlsx') as 'xlsx'); return { op: a.op, message: `exported ${r.file} (${r.bytes} bytes)`, data: r }; }
    case 'snapshot': return snapshot(svc, home, String(a.doc ?? ''), actor);
    case 'list_templates': {
      const { templates } = await import('./ops.ts');
      const list = templates({ svc });
      return { op: a.op, message: list.map((t) => `${t.id}${t.plugin ? ` (${t.plugin})` : ''}: ${t.title} - ${t.purpose} [${t.pages.map((p) => p.layout?.type ?? 'grid').join(', ')}]`).join('\n'), data: list };
    }
  }
  throw new DataError(`${a.op} is not a read op`);
}

async function undoRedo(svc: DataService, home: DataHome, a: Op, actor: Actor): Promise<OpOutcome> {
  const target = String(a.doc ?? a.target ?? CATALOG_ID);
  const log = (await home.log()).filter((e) => e.target === target);
  let content: string; let kind: 'undo' | 'redo' | 'restore'; let of: number | undefined;
  const cur = await home.versionOf(target);
  if (!cur) throw new DataError(`no ${target}`, 404);
  if (a.op === 'restore') {
    const v = Number(a.version);
    content = await home.content(target, v).catch(() => { throw new DataError(`${target} has no version ${v} (or it was dropped: the newest ${300} are kept)`, 404); });
    kind = 'restore';
  } else {
    // The undo stack: changes not yet undone (latest first); redo takes back the latest undo since the last change.
    const undone = new Set(log.filter((e) => e.kind === 'undo').map((e) => e.of));
    const redone = new Set(log.filter((e) => e.kind === 'redo').map((e) => e.of));
    if (a.op === 'undo') {
      const e = [...log].reverse().find((x) => (x.kind === 'ops' || x.kind === 'redo' || x.kind === 'restore') && !undone.has(x.seq));
      if (!e) throw new DataError(`nothing to undo in ${target}`);
      if (!e.from) throw new DataError(`${target} was created by that change: delete it instead`);
      content = await home.content(target, e.from); kind = 'undo'; of = e.seq;
    } else {
      const lastChange = [...log].reverse().find((x) => x.kind === 'ops' || x.kind === 'restore');
      const u = [...log].reverse().find((x) => x.kind === 'undo' && !redone.has(x.seq) && (!lastChange || x.seq > lastChange.seq));
      if (!u) throw new DataError(`nothing to redo in ${target}`);
      const orig = log.find((x) => x.seq === u.of)!;
      content = await home.content(target, orig.to); kind = 'redo'; of = u.seq;
    }
  }
  const before = await home.content(target, cur);
  const title = target === CATALOG_ID ? 'Data catalog' : (JSON.parse(content) as DocSpec).title;
  const v = await home.write(target, JSON.parse(content), title);
  await home.append({ target, from: cur, to: v, by: actor.label, ...(actor.session ? { session: actor.session } : {}), ops: [a.op], kind, ...(of ? { of } : {}) });
  svc.emit(home.owner, { type: target === CATALOG_ID ? 'catalog_changed' : 'doc_changed', doc: target, version: v, by: actor.label });
  const { diffCatalog, diffDoc } = await import('./ops.ts');
  const diff = target === CATALOG_ID ? diffCatalog(JSON.parse(before), JSON.parse(content)) : diffDoc(JSON.parse(before), JSON.parse(content));
  return { op: a.op, message: `${kind} ${target}: now v${v}${diff.length ? `\n${diff.join('\n')}` : ''}`, data: { target, version: v, diff } };
}

/** Refresh, then freeze every visual's numbers with a timestamp (a report's "refresh and snapshot" run). */
async function snapshot(svc: DataService, home: DataHome, id: string, actor: Actor): Promise<OpOutcome> {
  await svc.refreshDoc(home, id, `snapshot by ${actor.label}`);
  const { spec, version } = await home.doc(id);
  const cat = (await home.catalog()).spec;
  const results: Record<string, QueryResult> = {};
  for (const p of spec.pages) for (const v of p.visuals) if (DATA_VISUALS.has(v.type)) results[v.id] = await visualData(svc, home, { ...spec, snapshot: undefined }, v, { page: p.id }, OWNER, { catalog: cat });
  const next: DocSpec = { ...spec, snapshot: { at: Date.now(), results } };
  const v = await home.write(id, next, spec.title);
  await home.append({ target: id, from: version, to: v, by: actor.label, ...(actor.session ? { session: actor.session } : {}), ops: ['snapshot'], kind: 'ops' });
  svc.emit(home.owner, { type: 'doc_changed', doc: id, version: v, by: actor.label });
  return { op: 'snapshot', message: `snapshot of ${id} at ${new Date(next.snapshot!.at).toISOString()}: ${Object.keys(results).length} visuals frozen (v${v})`, data: { version: v, at: next.snapshot!.at } };
}

export { OPS };
