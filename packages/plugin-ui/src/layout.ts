/**
 * Dashboard layouts and templates (pure, shared by the server's ops, the renderers and plugins).
 *
 * - reflow: a page moved to another layout type keeps every widget, re-arranged sensibly
 *   (grid units <-> canvas pixels, sections and tabs by kind, slicers into a sidebar, one column for
 *   story and print, a TV screen that fits).
 * - pack: close a grid's gaps upwards or leftwards.
 * - templates: pre-arranged pages for purposes, with placeholders ($m1, $date:month, $cat1,
 *   $entity) filled from a model's measures and fields; and a blank page of each layout type.
 */

import type { LayoutSpec, LayoutType, PageSpec, VisualSpec } from './bi.ts';

type Box = { x: number; y: number; w: number; h: number; z?: number };
const KPI = new Set(['card', 'kpi', 'gauge', 'multicard']);
const CONTROL = new Set(['slicer', 'button']);
const TABLE = new Set(['table', 'matrix']);
export const GRID_COLUMNS = 12;
export const ROW = 40;
export const GAP = 8;
/** Canvas pixels for one grid unit, at the reference width (1200 px for 12 columns). */
const CW = 100; const RH = ROW + GAP;

const order = (vs: VisualSpec[]) => [...vs].sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x);
const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Moves widgets up (or left) to the first free place, in reading order: a grid without gaps. */
export function pack(vs: VisualSpec[], dir: 'up' | 'left' = 'up', cols = GRID_COLUMNS): VisualSpec[] {
  const placed: VisualSpec[] = [];
  for (const v of order(vs)) {
    const l = { ...v.layout, w: Math.min(cols, v.layout.w), x: Math.min(v.layout.x, cols - Math.min(cols, v.layout.w)) };
    if (dir === 'up') { while (l.y > 0 && !placed.some((p) => overlap({ ...l, y: l.y - 1 }, p.layout))) l.y--; }
    else { while (l.x > 0 && !placed.some((p) => overlap({ ...l, x: l.x - 1 }, p.layout))) l.x--; }
    // Never on top of another (a widget moved left may still collide): push it down.
    while (placed.some((p) => overlap(l, p.layout))) l.y++;
    placed.push({ ...v, layout: l });
  }
  return vs.map((v) => placed.find((p) => p.id === v.id)!);
}

/** Widgets one after another in rows of `cols` (their widths kept), packed up: a flow arrangement. */
export function flow(vs: VisualSpec[], cols = GRID_COLUMNS, widen?: (v: VisualSpec) => number): VisualSpec[] {
  let x = 0; let y = 0; let rowH = 0;
  return order(vs).map((v) => {
    const w = Math.min(cols, Math.max(1, widen ? widen(v) : v.layout.w));
    if (x + w > cols) { x = 0; y += rowH; rowH = 0; }
    const out = { ...v, layout: { ...v.layout, x, y, w } };
    x += w; rowH = Math.max(rowH, v.layout.h);
    return out;
  });
}

/** The arrangement for medium widths: each widget twice as wide, packed up (unless set by hand). */
export function mediumLayout(vs: VisualSpec[], cols = GRID_COLUMNS): Map<string, Box> {
  const auto = pack(flow(vs, cols, (v) => Math.min(cols, Math.max(v.layout.w * 2, KPI.has(v.type) ? 6 : 12))), 'up', cols);
  return new Map(vs.map((v) => [v.id, v.layouts?.medium ?? auto.find((a) => a.id === v.id)!.layout]));
}

const toCanvas = (l: Box): Box => ({ x: l.x * CW, y: l.y * RH, w: l.w * CW - GAP, h: l.h * RH - GAP });
const toGrid = (l: Box): Box => ({ x: Math.max(0, Math.min(11, Math.round(l.x / CW))), y: Math.max(0, Math.round(l.y / RH)), w: Math.max(1, Math.min(12, Math.round((l.w + GAP) / CW))), h: Math.max(2, Math.round((l.h + GAP) / RH)) });

/**
 * A page in another layout type: every widget kept; positions converted or re-flowed; sections,
 * tabs and the sidebar assigned by kind (KPIs, controls, charts, tables). Pure: the op writes it.
 */
export function reflow(page: PageSpec, to: LayoutSpec): PageSpec {
  const from: LayoutType = page.layout?.type ?? 'grid';
  // Everything in grid units first.
  let vs = page.visuals.map((v) => ({ ...v, layout: from === 'canvas' ? { ...toGrid(v.layout) } : { x: v.layout.x, y: v.layout.y, w: v.layout.w, h: v.layout.h } }));
  vs = pack(vs, 'up');
  const strip = (v: VisualSpec): VisualSpec => { const { section: _s, locked: _l, group: _g, ...rest } = v; return rest as VisualSpec; };
  let layout: LayoutSpec = { ...to };
  switch (to.type) {
    case 'canvas':
      vs = order(vs).map((v, i) => { const { section: _s, ...rest } = v; return { ...rest, layout: { ...toCanvas(v.layout), z: i + 1 } } as VisualSpec; });
      layout = { snap: 8, width: 1200, ...layout };
      break;
    case 'sections': case 'tabs': {
      const groups: Array<{ id: string; title: string; pick: (v: VisualSpec) => boolean }> = to.type === 'sections'
        ? [{ id: 's-summary', title: 'Summary', pick: (v) => KPI.has(v.type) || CONTROL.has(v.type) }, { id: 's-trends', title: 'Trends and breakdowns', pick: (v) => !TABLE.has(v.type) && !KPI.has(v.type) && !CONTROL.has(v.type) }, { id: 's-details', title: 'Details', pick: (v) => TABLE.has(v.type) }]
        : [{ id: 't-summary', title: 'Summary', pick: (v) => KPI.has(v.type) || CONTROL.has(v.type) }, { id: 't-charts', title: 'Charts', pick: (v) => !TABLE.has(v.type) && !KPI.has(v.type) && !CONTROL.has(v.type) }, { id: 't-tables', title: 'Tables', pick: (v) => TABLE.has(v.type) }];
      const given = to.sections?.length ? to.sections : page.layout?.sections?.length && (from === 'sections' || from === 'tabs') ? page.layout.sections : undefined;
      if (given) {
        const ids = new Set(given.map((s) => s.id));
        vs = vs.map((v) => ({ ...v, section: v.section && ids.has(v.section) ? v.section : given[0]!.id }));
        layout = { ...layout, sections: given };
      } else {
        const used = groups.filter((g) => vs.some(g.pick));
        vs = vs.map((v) => ({ ...v, section: (groups.find((g) => g.pick(v)) ?? groups[1]!).id }));
        layout = { ...layout, sections: (used.length ? used : [groups[1]!]).map(({ id, title }) => ({ id, title })) };
      }
      // Each section's grid packed on its own.
      vs = layout.sections!.flatMap((s) => pack(vs.filter((v) => v.section === s.id).map((v) => ({ ...v, layout: { ...v.layout, y: v.layout.y } })), 'up'));
      return { ...page, layout, visuals: page.visuals.map((v) => vs.find((x) => x.id === v.id)!) };
    }
    case 'sidebar': {
      // Slicers and buttons in the sidebar (else the KPI cards); the rest in the grid, packed.
      const side = vs.some((v) => CONTROL.has(v.type)) ? (v: VisualSpec) => CONTROL.has(v.type) : (v: VisualSpec) => KPI.has(v.type);
      vs = [...flow(vs.filter(side).map((v) => ({ ...strip(v), section: 'sidebar' })), 1, () => 1), ...pack(vs.filter((v) => !side(v)).map(strip), 'up')];
      layout = { sidebar: { side: 'left', width: 260 }, ...layout };
      break;
    }
    case 'masonry':
      vs = flow(vs.map(strip), GRID_COLUMNS);
      layout = { cardWidth: 320, ...layout };
      break;
    case 'story': case 'print':
      // One column: KPIs side by side in strips, everything else full width.
      vs = flow(vs.map(strip), GRID_COLUMNS, (v) => (KPI.has(v.type) ? Math.max(3, v.layout.w) : 12));
      if (to.type === 'print') layout = { paper: 'A4', orientation: 'landscape', margins: 12, ...layout };
      break;
    case 'tv': {
      // A screen that fits: rows scaled so the page's height is the screen's.
      layout = { aspect: '16:9', rotate: 30, scale: 1.25, responsive: false, ...layout };
      const rows = Math.floor((1200 * (layout.aspect === '21:9' ? 9 / 21 : 9 / 16)) / RH);
      vs = pack(vs.map(strip), 'up');
      const bottom = Math.max(1, ...vs.map((v) => v.layout.y + v.layout.h));
      if (bottom > rows) { const k = rows / bottom; vs = pack(vs.map((v) => ({ ...v, layout: { ...v.layout, y: Math.floor(v.layout.y * k), h: Math.max(2, Math.floor(v.layout.h * k)) } })), 'up'); }
      break;
    }
    case 'grid':
      vs = pack(vs.map(strip), to.compact === 'left' ? 'left' : 'up');
      break;
  }
  return { ...page, layout, visuals: page.visuals.map((v) => vs.find((x) => x.id === v.id)!) };
}

// ---------------- templates ----------------

export interface TemplateSpec {
  id: string;
  title: string;
  purpose: string;
  description: string;
  /** Pages with placeholders: $m1..$m6 measures, $date (the model's date) with a grain, $cat1..$cat3 (fields with few values), $entity (many values), $num1/$num2 (numeric fields). */
  pages: Array<{ name: string; layout?: LayoutSpec; visuals: Array<Omit<VisualSpec, 'id' | 'layout'> & { layout?: VisualSpec['layout'] }> }>;
  /** A plugin's template: which plugin. */
  plugin?: string;
}

const T = (type: VisualSpec['type'], title: string, q: VisualSpec['query'] | undefined, o: VisualSpec['options'] = {}, layout?: VisualSpec['layout'], extra: Partial<VisualSpec> = {}) => ({ type, title, ...(q ? { query: q } : {}), ...(Object.keys(o).length ? { options: o } : {}), ...(layout ? { layout } : {}), ...extra });
const L = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

export const BUILTIN_TEMPLATES: TemplateSpec[] = [
  { id: 'executive', title: 'Executive overview', purpose: 'Leadership: the few numbers that matter, their trend, and what drives them', description: 'A KPI strip with targets and trends, the main measure over time with a forecast, the top 10 and the mix.',
    pages: [{ name: 'Overview', layout: { type: 'grid', compact: 'up' }, visuals: [
      T('kpi', '$m1', { measures: ['$m1'] }, { trend: '$date:month' }, L(0, 0, 3, 4)), T('kpi', '$m2', { measures: ['$m2'] }, { trend: '$date:month' }, L(3, 0, 3, 4)), T('kpi', '$m3', { measures: ['$m3'] }, { trend: '$date:month' }, L(6, 0, 3, 4)), T('card', '$m4', { measures: ['$m4'] }, {}, L(9, 0, 3, 4)),
      T('line', '$m1 by month', { dims: ['$date:month'], measures: ['$m1'] }, { forecast: { periods: 3 }, anomalies: true }, L(0, 4, 8, 8)), T('donut', '$m1 by $cat1', { dims: ['$cat1'], measures: ['$m1'] }, {}, L(8, 4, 4, 8)),
      T('bar', 'Top 10 $entity', { dims: ['$entity'], measures: ['$m1'], filters: [{ field: '$entity', op: 'top', n: 10, by: '$m1' }] }, {}, L(0, 12, 6, 9)), T('column', '$m1 by $cat2 and quarter', { dims: ['$date:quarter', '$cat2'], measures: ['$m1'] }, { stack: 'stacked' }, L(6, 12, 6, 9)),
    ] }] },
  { id: 'noc', title: 'Operations monitoring (NOC)', purpose: 'A wall for the operations room: status at a glance, alerts, live charts', description: 'TV-ready: status tiles, gauges, live trends by hour, the worst offenders; pages rotate.',
    pages: [{ name: 'Live', layout: { type: 'tv', aspect: '16:9', rotate: 30, scale: 1.3 }, visuals: [
      T('card', '$m1', { measures: ['$m1'] }, { conditional: [{ field: '$m1', kind: 'rules', rules: [{ op: 'lt', value: 0, color: '#c43030' }] }] }, L(0, 0, 3, 4)), T('card', '$m2', { measures: ['$m2'] }, {}, L(3, 0, 3, 4)), T('gauge', '$m3', { measures: ['$m3'] }, {}, L(6, 0, 3, 6)), T('multicard', '$m1 by $cat1', { dims: ['$cat1'], measures: ['$m1'] }, {}, L(9, 0, 3, 6)),
      T('line', '$m1 by day', { dims: ['$date:day'], measures: ['$m1'] }, { anomalies: true }, L(0, 4, 9, 8)), T('bar', 'Worst $entity', { dims: ['$entity'], measures: ['$m1'], filters: [{ field: '$entity', op: 'bottom', n: 8, by: '$m1' }] }, {}, L(9, 6, 3, 9)),
    ] }] },
  { id: 'sales', title: 'Sales and finance', purpose: 'Revenue against targets, what made the margin, by region and period', description: 'KPIs against last year, a waterfall of the contribution, a matrix by period with subtotals, a combo of value and rate.',
    pages: [{ name: 'Sales', layout: { type: 'grid' }, visuals: [
      T('kpi', '$m1', { measures: ['$m1'] }, { trend: '$date:month' }, L(0, 0, 4, 4)), T('kpi', '$m2', { measures: ['$m2'] }, { trend: '$date:month' }, L(4, 0, 4, 4)), T('card', '$m3', { measures: ['$m3'] }, {}, L(8, 0, 4, 4)),
      T('waterfall', '$m1 by $cat1', { dims: ['$cat1'], measures: ['$m1'] }, { labels: true }, L(0, 4, 5, 8)), T('combo', '$m1 and $m2 by quarter', { dims: ['$date:quarter'], measures: ['$m1', '$m2'] }, { lines: ['$m2'] }, L(5, 4, 7, 8)),
      T('matrix', '$m1 by $cat1, $cat2 and year', { dims: ['$cat1', '$cat2', '$date:year'], measures: ['$m1'] }, { rows: 2, conditional: [{ field: '$m1', kind: 'scale', colors: ['#f4f8fd', '#2a78d6'] }] }, L(0, 12, 12, 10)),
    ] }] },
  { id: 'funnel', title: 'Marketing funnel', purpose: 'Where people drop out, by channel and over time', description: 'The funnel by stage, conversion by channel, stages over time.',
    pages: [{ name: 'Funnel', layout: { type: 'grid' }, visuals: [
      T('funnel', '$m1 by $cat1', { dims: ['$cat1'], measures: ['$m1'] }, {}, L(0, 0, 5, 10)), T('bar', '$m1 by $cat2', { dims: ['$cat2'], measures: ['$m1'] }, { labels: true }, L(5, 0, 7, 5)),
      T('area', '$m1 by month and $cat1', { dims: ['$date:month', '$cat1'], measures: ['$m1'] }, { stack: 'stacked' }, L(5, 5, 7, 5)), T('table', 'By $cat2', { dims: ['$cat2'], measures: ['$m1', '$m2'] }, { conditional: [{ field: '$m1', kind: 'bars' }] }, L(0, 10, 12, 7)),
    ] }] },
  { id: 'product', title: 'Product analytics', purpose: 'Usage by cohort and how it holds up over time', description: 'A cohort grid (first period by later period, coloured), the trend by segment, segments compared.',
    pages: [{ name: 'Cohorts', layout: { type: 'grid' }, visuals: [
      T('matrix', 'Cohort grid: $m1 by month and $cat1', { dims: ['$date:month', '$cat1'], measures: ['$m1'] }, { rows: 1, conditional: [{ field: '$m1', kind: 'scale', colors: ['#fdf1ec', '#d95926'] }] }, L(0, 0, 12, 10)),
      T('line', '$m1 by month and $cat1', { dims: ['$date:month', '$cat1'], measures: ['$m1'] }, {}, L(0, 10, 7, 8)), T('drivers', 'What moves $m2', { measures: ['$m2'] }, { dims: ['$cat1', '$cat2'] }, L(7, 10, 5, 8)),
    ] }] },
  { id: 'delivery', title: 'Project and delivery tracker', purpose: 'Work by status and owner, what is late, the trend', description: 'Status tiles, work by status over time, the list of items.',
    pages: [{ name: 'Delivery', layout: { type: 'sections', sections: [{ id: 's-status', title: 'Status' }, { id: 's-flow', title: 'Flow' }, { id: 's-items', title: 'Items' }] }, visuals: [
      T('multicard', '$m1 by $cat1', { dims: ['$cat1'], measures: ['$m1'] }, {}, L(0, 0, 12, 4), { section: 's-status' }),
      T('column', '$m1 by week and $cat1', { dims: ['$date:week', '$cat1'], measures: ['$m1'] }, { stack: 'stacked' }, L(0, 0, 12, 8), { section: 's-flow' }),
      T('table', 'Items', { dims: ['$entity', '$cat1'], measures: ['$m1'] }, {}, L(0, 0, 12, 9), { section: 's-items' }),
    ] }] },
  { id: 'sre', title: 'Incidents and SRE', purpose: 'Objectives, error budgets and latency', description: 'Objective gauges, the budget left, trends with anomaly marks, the incidents.',
    pages: [{ name: 'Reliability', layout: { type: 'sidebar', sidebar: { side: 'left', width: 240 } }, visuals: [
      T('slicer', '$cat1', undefined, { slicer: { field: '$cat1', style: 'list' } }, L(0, 0, 1, 6), { section: 'sidebar' }),
      T('gauge', '$m1', { measures: ['$m1'] }, {}, L(0, 0, 4, 6)), T('card', '$m2', { measures: ['$m2'] }, {}, L(4, 0, 4, 6)), T('card', '$m3', { measures: ['$m3'] }, {}, L(8, 0, 4, 6)),
      T('line', '$m1 by day', { dims: ['$date:day'], measures: ['$m1'] }, { anomalies: true, forecast: { periods: 7 } }, L(0, 6, 12, 8)), T('table', 'By $entity', { dims: ['$entity'], measures: ['$m1', '$m2'] }, {}, L(0, 14, 12, 8)),
    ] }] },
  { id: 'lab', title: 'Scientific and lab results', purpose: 'Measurements, their relation, the compound or structure behind them', description: 'A scatter of two measurements by sample, a structure, results by group, the table.',
    pages: [{ name: 'Results', layout: { type: 'grid' }, visuals: [
      T('scatter', '$m2 against $m1', { dims: ['$entity'], measures: ['$m1', '$m2'] }, {}, L(0, 0, 7, 9)), T('fence', 'Structure', undefined, { fence: { lang: 'smiles', source: 'CC(=O)Oc1ccccc1C(=O)O' } }, L(7, 0, 5, 9)),
      T('column', '$m1 by $cat1', { dims: ['$cat1'], measures: ['$m1'] }, {}, L(0, 9, 6, 8)), T('table', 'Results', { dims: ['$entity', '$cat1'], measures: ['$m1', '$m2'] }, { conditional: [{ field: '$m1', kind: 'scale' }] }, L(6, 9, 6, 8)),
    ] }] },
  { id: 'quality', title: 'Data quality and profiling', purpose: 'How complete and fresh the data is', description: 'Rows, completeness of each field, rows over time, values by group (the measures are made from the fields).',
    pages: [{ name: 'Quality', layout: { type: 'masonry', cardWidth: 300 }, visuals: [
      T('card', 'Rows', { measures: ['$rows'] }, {}, L(0, 0, 3, 4)), T('multicard', 'Completeness by field', { measures: ['$complete'] }, { formats: {} }, L(3, 0, 9, 6)),
      T('column', 'Rows by month', { dims: ['$date:month'], measures: ['$rows'] }, {}, L(0, 6, 6, 7)), T('bar', 'Rows by $cat1', { dims: ['$cat1'], measures: ['$rows'] }, {}, L(6, 6, 6, 7)),
    ] }] },
  ...(['grid', 'canvas', 'sections', 'tabs', 'sidebar', 'masonry', 'story', 'tv', 'print'] as const).map((type) => ({
    id: `blank-${type}`, title: `Blank: ${type}`, purpose: 'Start from an empty page of this layout', description: ({ grid: 'A responsive 12-column grid', canvas: 'Free positions, layers and guides', sections: 'Collapsible bands', tabs: 'Tabbed panels', sidebar: 'Filters in a column beside the content', masonry: 'Cards flowing by height', story: 'A narrative, top to bottom', tv: 'A full-screen wall, 16:9, rotating', print: 'Paper pages with headers and footers' } as Record<string, string>)[type]!,
    pages: [{ name: 'Page', layout: { type, ...(type === 'sections' || type === 'tabs' ? { sections: [{ id: 's-1', title: type === 'tabs' ? 'Tab 1' : 'Section 1' }] } : {}) }, visuals: [] }],
  } satisfies TemplateSpec)),
];

export interface TemplateFields { measures: string[]; date?: string; categories: string[]; entities: string[]; numbers: string[]; table?: string; columns?: Array<{ table: string; name: string }> }

/**
 * Fills a template's placeholders from a model: measures in order, the date field, fields with
 * few values (categories), with many (entities). A widget whose placeholder has nothing to fill is
 * left out (and named), never invented.
 */
export function fillTemplate(t: TemplateSpec, f: TemplateFields): { pages: TemplateSpec['pages']; skipped: string[] } {
  const skipped: string[] = [];
  const resolve = (s: string): string | undefined | (string | Record<string, unknown>)[] => {
    const m = /^\$(m(\d)|date(?::(\w+))?|cat(\d)|entity|num(\d)|rows|complete)$/.exec(s);
    if (!m) return s.replace(/\$(m\d|cat\d|entity)/g, (x) => { const r = resolve(x); return typeof r === 'string' ? r.split('.').pop()!.replace(/:.*/, '') : x; });
    if (m[2]) return f.measures[Number(m[2]) - 1];
    if (s.startsWith('$date')) return f.date ? `${f.date.replace(/:.*$/, '')}${m[3] ? `:${m[3]}` : ''}` : undefined;
    if (m[4]) return f.categories[Number(m[4]) - 1];
    if (s === '$entity') return f.entities[0] ?? f.categories.at(-1);
    if (m[5]) return f.numbers[Number(m[5]) - 1];
    if (s === '$rows') return f.table ? JSON.stringify({ name: 'Rows', expr: 'count(*)', table: f.table }) : undefined;
    if (s === '$complete') return f.columns?.length ? JSON.stringify(f.columns.slice(0, 12).map((c) => ({ name: `${c.name} filled`, expr: `count(${c.table}."${c.name.replace(/"/g, '""')}") / count(*)`, format: 'percent:1' }))) : undefined;
    return undefined;
  };
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') { if (!x.includes('$')) return x; const r = resolve(x); if (r === undefined) throw new Error(x); return typeof r === 'string' && /^[[{]/.test(r) && x.startsWith('$') && (x === '$rows' || x === '$complete') ? JSON.parse(r) : r; }
    if (Array.isArray(x)) return x.flatMap((y) => { const r = walk(y); return Array.isArray(r) && typeof y === 'string' && y === '$complete' ? r : [r]; });
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [walk(k) as string, walk(v)]));
    return x;
  };
  const pages = t.pages.map((p) => ({ ...p, visuals: p.visuals.flatMap((v) => { try { return [walk(v) as typeof v]; } catch (e) { skipped.push(`${v.title} (nothing for ${(e as Error).message})`); return []; } }) }));
  return { pages, skipped };
}
