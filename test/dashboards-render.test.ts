import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatValue, type QueryResult, THEMES, type VisualSpec } from '../packages/plugin-ui/src/bi.ts';
import { loadUi } from './fixtures/desktop/load-ui.ts';

// The dashboard renderers: the ECharts options built from computed results (nothing aggregated in
// the browser; layout only), clicks turned into selections, and the HTML visuals (cards, KPIs,
// tables and matrices with the engine's subtotals, conditional formatting, slicers, narratives).

const r = (columns: QueryResult['columns'], rows: QueryResult['rows'], extra: Partial<QueryResult> = {}): QueryResult => ({ columns, rows, rowCount: rows.length, hash: 'h', ms: 1, at: 0, lineage: { datasets: [] }, ...extra });
const dim = (name: string, extra = {}) => ({ name, label: name.split('.').pop()!, type: 'VARCHAR', role: 'dim' as const, field: name, ...extra });
const ms = (name: string, format?: string) => ({ name, label: name, type: 'DOUBLE', role: 'measure' as const, ...(format ? { format } : {}) });
const V = (type: VisualSpec['type'], options: VisualSpec['options'] = {}): VisualSpec => ({ id: 'v', type, layout: { x: 0, y: 0, w: 6, h: 8 }, options });
const ctx = { theme: THEMES[0]!, dark: false, static: true };

test('formats: currency, percent, compact, integer, dates by grain (quarters too); values are never rounded in the data', () => {
  assert.equal(formatValue(1234.5, 'currency:USD'), '$1,234.50');
  assert.equal(formatValue(1234.5, 'currency:EUR:0'), '€1,235');
  assert.equal(formatValue(0.1234, 'percent:1'), '12.3%');
  assert.equal(formatValue(1520000, 'compact'), '1.5M');
  assert.equal(formatValue('2024-04-01', undefined, 'quarter'), '2024 Q2');
  assert.equal(formatValue('2024-04-01', undefined, 'month'), 'Apr 2024');
  assert.equal(formatValue(null), '');
});

test('chart options: a second dim becomes series; stacked and 100%; a highlight overlays the selected part; combo on two axes; a click is a selection', async () => {
  const { ui } = await loadUi();
  const res = r([dim('r.region'), dim('o.channel'), ms('Revenue', 'currency:USD')], [['EU', 'Web', 10], ['EU', 'Shop', 30], ['US', 'Web', 20]]);
  const s = ui.shape(res);
  assert.deepEqual(s.categories, ['EU', 'US']);
  assert.deepEqual(s.series.map((x: { name: string; values: unknown[] }) => [x.name, x.values]), [['Web', [10, 20]], ['Shop', [30, null]]]);
  const o = ui.visualOption(V('column', { stack: 'percent' }), res, ctx);
  assert.deepEqual(o.series.map((x: { data: Array<{ value: number }> }) => x.data.map((d) => d.value)), [[0.25, 1], [0.75, null]], '100%: shares of each category (layout only); a missing value stays missing');
  assert.ok(o.series.every((x: { stack?: string }) => x.stack === 'total'));
  const hl = ui.visualOption(V('bar'), r([dim('r.region'), ms('Revenue')], [['EU', 40], ['US', 20]], { highlight: [[15], [null]] }), ctx);
  assert.equal(hl.series.length, 2);
  assert.equal(hl.series[0].itemStyle.opacity, 0.3);
  assert.equal(hl.series[1].barGap, '-100%');
  assert.deepEqual(hl.series[1].data.map((d: { value: number }) => d.value), [15, null]);
  assert.equal(hl.yAxis.type, 'category', 'bar is horizontal');
  const combo = ui.visualOption(V('combo', { lines: ['Margin %'] }), r([dim('d.q'), ms('Revenue'), ms('Margin %', 'percent:1')], [['Q1', 10, 0.2]]), ctx);
  assert.equal(combo.yAxis.length, 2);
  assert.equal(combo.series[1].type, 'line'); assert.equal(combo.series[1].yAxisIndex, 1);
  assert.deepEqual(ui.clickFilters(res, { data: { raw: 'EU', key: 'Web' } }), [{ field: 'r.region', op: 'eq', value: 'EU' }, { field: 'o.channel', op: 'eq', value: 'Web' }]);
  assert.deepEqual(ui.clickFilters(res, { data: { raw: null } }), [{ field: 'r.region', op: 'is_null' }]);
});

test('waterfall total is the engine\'s total row; forecast and anomalies draw from the result\'s extra; pie, treemap, gauge, scatter with a play axis', async () => {
  const { ui } = await loadUi();
  const w = ui.visualOption(V('waterfall'), r([dim('r.region'), ms('Margin'), { name: '__level', label: 'level', type: 'INTEGER', role: 'level' }], [['A', 10, 0], ['B', -4, 0], [null, 6, 1]]), ctx);
  assert.deepEqual(w.xAxis.data, ['A', 'B', 'Total']);
  assert.equal(w.series[1].data[2].value, 6);
  const f = ui.visualOption(V('line', { forecast: { periods: 2 } }), r([dim('d.m', { grain: 'month' }), ms('Revenue')], [['2024-01-01', 10], ['2024-02-01', 12]], { extra: { forecast: [[null, '2024-03-01', 14, 11, 17], [null, '2024-04-01', 16, 12, 20]], anomalies: [[null, '2024-02-01', 12, 3.1]] } }), ctx);
  assert.deepEqual(f.xAxis.data, ['Jan 2024', 'Feb 2024', 'Mar 2024', 'Apr 2024']);
  assert.ok(f.series.some((x: { name: string }) => x.name === 'Forecast'));
  assert.equal(f.series[0].markPoint.data.length, 1);
  const pie = ui.visualOption(V('donut'), r([dim('p.cat'), ms('Revenue')], [['A', 3], ['B', 1]]), ctx);
  assert.deepEqual(pie.series[0].radius, ['42%', '72%']);
  const tree = ui.visualOption(V('treemap'), r([dim('p.cat'), dim('p.name'), ms('Revenue')], [['A', 'x', 1], ['A', 'y', 2], ['B', 'z', 3]]), ctx);
  assert.equal(tree.series[0].data.length, 2);
  const g = ui.visualOption(V('gauge', { target: 0.4, max: 1 }), r([ms('Margin %', 'percent:1')], [[0.38]]), ctx);
  assert.equal(g.series[0].data[0].value, 0.38); assert.equal(g.series[1].data[0].value, 0.4);
  const sc = ui.visualOption(V('scatter', { play: 'd.y:year' }), r([dim('c.country'), dim('d.y:year', { grain: 'year' }), ms('Units'), ms('Revenue')], [['FR', '2024-01-01', 1, 2], ['FR', '2025-01-01', 3, 4]]), ctx);
  assert.equal(sc.baseOption.timeline.data.length, 2);
  assert.equal(sc.options.length, 2);
});

test('HTML visuals: card, KPI against its target, table with the engine\'s total and conditional formatting, matrix with subtotals, slicer, narrative with its sources', async () => {
  const { ui, React, server } = await loadUi();
  const html = (v: VisualSpec, res: QueryResult) => (server.renderToString(React.createElement(ui.BiVisual, { v, result: res, theme: THEMES[0], dark: false, static: true })) as string).replace(/<!-- -->/g, '');
  assert.match(html(V('card'), r([ms('Revenue', 'currency:USD:0')], [[4719535.2]])), /data-card-value="4719535.2"[^>]*>\$4,719,535</);
  const kpi = html({ ...V('kpi', { target: 'PY' }) }, r([ms('Revenue', 'currency:USD:0'), ms('PY', 'currency:USD:0'), ms('vs target', 'percent:1')], [[120, 100, 0.2]]));
  assert.match(kpi, /Target \$100/); assert.match(kpi, /▲ 20\.0%/);
  const t = html(V('table', { conditional: [{ field: 'Revenue', kind: 'bars' }, { field: 'Margin', kind: 'rules', rules: [{ op: 'lt', value: 0, color: '#c43030' }] }] }), r([dim('p.name'), ms('Revenue'), ms('Margin'), { name: '__level', label: 'level', type: 'INTEGER', role: 'level' }], [['a', 10, -1, 0], ['b', 30, 5, 0], [null, 40, 4, 1]]));
  assert.match(t, /Total/); assert.match(t, />40</);
  assert.match(t, /width:100%/, 'a data bar at the maximum');
  assert.match(t, /color:#c43030/, 'a rule colours a negative margin');
  const m = html(V('matrix', { rows: 1 }), r([dim('r.region'), dim('d.y'), ms('Revenue'), { name: '__level', label: 'level', type: 'INTEGER', role: 'level' }], [['EU', '2024', 1, 0], ['EU', '2025', 2, 0], ['EU', null, 3, 1], ['US', '2024', 4, 0], ['US', null, 4, 1], [null, '2024', 5, 2], [null, '2025', 2, 2], [null, null, 7, 3]]));
  assert.match(m, /data-bi-matrix/); assert.match(m, />2024</); assert.match(m, />Total</); assert.match(m, />7</);
  assert.match(html(V('slicer', { slicer: { field: 'r.region', style: 'buttons' } }), r([dim('r.region')], [['EU'], ['US']])), /data-slicer="buttons"[\s\S]*EU[\s\S]*US/);
  const n = html(V('narrative'), r([dim('measure'), ms('value')], [['Revenue', 10]], { extra: { text: 'Revenue was $10.00.', refs: [{ measure: 'Revenue', formatted: '$10.00', filters: [] }] } }));
  assert.match(n, /Revenue was \$10\.00\./); assert.match(n, /\$10\.00 = Revenue/);
});
