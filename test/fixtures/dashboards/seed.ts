// The showcase: a sales model and a three-page dashboard built only from ops (the same ones the app
// and the agents apply). Used by the tests, the e2e, the screenshots and the live run's checks.

export function modelOps(paths: { xlsx: string; csv: string }): Array<Record<string, unknown>> {
  return [
    { op: 'add_source', source: { id: 'src-sales', name: 'Sales workbook', type: 'file', path: paths.xlsx } },
    { op: 'add_source', source: { id: 'src-countries', name: 'Countries', type: 'file', path: paths.csv } },
    { op: 'define', dataset: { name: 'orders', source: 'src-sales', from: 'Orders', description: 'One row per order line', steps: [{ op: 'add', name: 'margin', expr: 'revenue - cost' }] } },
    { op: 'define', dataset: { name: 'products', source: 'src-sales', from: 'Products' } },
    { op: 'define', dataset: { name: 'countries', source: 'src-countries' } },
    { op: 'certify', dataset: 'orders', certified: true },
    { op: 'add_model', model: { id: 'sales', name: 'Sales' } },
    { op: 'set_table', model: 'sales', table: { name: 'orders', dataset: 'orders' } },
    { op: 'set_table', model: 'sales', table: { name: 'products', dataset: 'products' } },
    { op: 'set_table', model: 'sales', table: { name: 'countries', dataset: 'countries' } },
    { op: 'set_relationship', model: 'sales', relationship: { from: 'orders.product_code', to: 'products.product_code' } },
    { op: 'set_relationship', model: 'sales', relationship: { from: 'orders.country', to: 'countries.country' } },
    { op: 'set_model', model: 'sales', patch: { date: 'orders.order_date' } },
    { op: 'set_measure', model: 'sales', measure: { name: 'Revenue', expr: 'sum(orders.revenue)', format: 'currency:USD:0' } },
    { op: 'set_measure', model: 'sales', measure: { name: 'Cost', expr: 'sum(orders.cost)', format: 'currency:USD:0' } },
    { op: 'set_measure', model: 'sales', measure: { name: 'Margin', expr: '[Revenue] - [Cost]', format: 'currency:USD:0' } },
    { op: 'set_measure', model: 'sales', measure: { name: 'Margin %', expr: '([Revenue] - [Cost]) / [Revenue]', format: 'percent:1' } },
    { op: 'set_measure', model: 'sales', measure: { name: 'Orders', expr: 'count(DISTINCT orders.order_id)', format: 'integer' } },
    { op: 'set_measure', model: 'sales', measure: { name: 'Units', expr: 'sum(orders.units)', format: 'integer' } },
    { op: 'set_measure', model: 'sales', measure: { name: 'Avg order', expr: '[Revenue] / [Orders]', format: 'currency:USD:0' } },
    { op: 'set_measure', model: 'sales', measure: { name: 'Revenue PY', base: 'Revenue', calc: 'prev_year' } },
    { op: 'set_measure', model: 'sales', measure: { name: 'Revenue YoY %', base: 'Revenue', calc: 'yoy_pct' } },
    { op: 'set_measure', model: 'sales', measure: { name: 'Revenue YTD', base: 'Revenue', calc: 'ytd' } },
    { op: 'set_hierarchy', model: 'sales', hierarchy: { name: 'Calendar', levels: ['orders.order_date:year', 'orders.order_date:quarter', 'orders.order_date:month'] } },
    { op: 'set_hierarchy', model: 'sales', hierarchy: { name: 'Geography', levels: ['countries.region', 'countries.country', 'orders.city'] } },
    { op: 'set_role', model: 'sales', role: { name: 'Region managers', members: ['*'], filters: { countries: 'manager = {user}' } } },
  ];
}

export function dashboardOps(title = 'Sales overview'): Array<Record<string, unknown>> {
  const q = (dims: string[], measures: unknown[], extra: Record<string, unknown> = {}) => ({ dims, measures, ...extra });
  return [
    { op: 'create', doc: { type: 'dashboard', title, model: 'sales', description: 'Revenue, margin and orders by region, product and month' } },
    { op: 'add_page', doc: '$new', page: { name: 'Country detail', kind: 'drillthrough', drillFields: ['countries.country'] } },
    { op: 'add_page', doc: '$new', page: { name: 'Country tip', kind: 'tooltip' } },
    { op: 'update_page', doc: '$new', page: 'p-1', patch: { name: 'Overview' } },
    { op: 'add_visual', doc: '$new', page: 'p-1', visual: { id: 'v-rev', type: 'kpi', title: 'Revenue', query: { measures: ['Revenue'] }, options: { target: 'Revenue PY', trend: 'orders.order_date:month' }, layout: { x: 0, y: 0, w: 3, h: 4 } } },
    { op: 'add_visual', doc: '$new', page: 'p-1', visual: { id: 'v-margin', type: 'card', title: 'Margin %', query: { measures: ['Margin %'] }, layout: { x: 3, y: 0, w: 3, h: 4 } } },
    { op: 'add_visual', doc: '$new', page: 'p-1', visual: { id: 'v-orders', type: 'card', title: 'Orders', query: { measures: ['Orders', 'Avg order'] }, layout: { x: 6, y: 0, w: 3, h: 4 } } },
    { op: 'add_visual', doc: '$new', page: 'p-1', visual: { id: 'v-region-slicer', type: 'slicer', title: 'Region', options: { slicer: { field: 'countries.region', style: 'buttons' } }, layout: { x: 9, y: 0, w: 3, h: 4 } } },
    { op: 'add_visual', doc: '$new', page: 'p-1', visual: { id: 'v-month', type: 'column', title: 'Revenue by month and channel', query: q(['orders.order_date:year', 'orders.channel'], ['Revenue']), options: { stack: 'stacked', hierarchy: 'Calendar' }, layout: { x: 0, y: 4, w: 8, h: 8 } } },
    { op: 'add_visual', doc: '$new', page: 'p-1', visual: { id: 'v-cat', type: 'donut', title: 'Revenue by category', query: q(['products.category'], ['Revenue']), layout: { x: 8, y: 4, w: 4, h: 8 } } },
    { op: 'add_visual', doc: '$new', page: 'p-1', visual: { id: 'v-country', type: 'bar', title: 'Top countries', query: q(['countries.country'], ['Revenue'], { filters: [{ field: 'countries.country', op: 'top', n: 6, by: 'Revenue' }] }), layout: { x: 0, y: 12, w: 5, h: 8 } } },
    { op: 'add_visual', doc: '$new', page: 'p-1', visual: { id: 'v-trend', type: 'line', title: 'Monthly revenue with forecast', query: q(['orders.order_date:month'], ['Revenue']), options: { forecast: { periods: 6 }, anomalies: true }, layout: { x: 5, y: 12, w: 7, h: 8 } } },
    { op: 'add_visual', doc: '$new', page: 'p-1', visual: { id: 'v-table', type: 'table', title: 'Products', query: q(['products.product', 'products.category'], ['Revenue', 'Units', 'Margin %']), options: { conditional: [{ field: 'Margin %', kind: 'scale' }, { field: 'Revenue', kind: 'bars' }] }, layout: { x: 0, y: 20, w: 12, h: 8 } } },
  ];
}

/** Second-wave ops (the visual ids above exist; the tooltip page id is looked up by the caller). */
export function detailOps(doc: string, pages: { drill: string; tip: string }): Array<Record<string, unknown>> {
  return [
    { op: 'update_visual', doc, visual: 'v-country', patch: { tooltip: pages.tip } },
    { op: 'add_visual', doc, page: pages.tip, visual: { id: 'v-tip-cat', type: 'column', title: 'By category', query: { dims: ['products.category'], measures: ['Revenue'] }, layout: { x: 0, y: 0, w: 12, h: 5 } } },
    { op: 'add_page', doc, page: { name: 'Details' } },
    { op: 'add_page', doc, page: { name: 'Insights' } },
    { op: 'add_visual', doc, page: pages.drill, visual: { id: 'v-dt-kpi', type: 'card', title: 'Revenue', query: { measures: ['Revenue', 'Orders'] }, layout: { x: 0, y: 0, w: 4, h: 4 } } },
    { op: 'add_visual', doc, page: pages.drill, visual: { id: 'v-dt-city', type: 'column', title: 'By city', query: { dims: ['orders.city'], measures: ['Revenue'] }, layout: { x: 4, y: 0, w: 8, h: 8 } } },
    { op: 'add_bookmark', doc, bookmark: { name: 'EMEA online', page: 'p-1', filters: [{ field: 'countries.region', op: 'in', values: ['EMEA'] }, { field: 'orders.channel', op: 'in', values: ['Online'] }] } },
    { op: 'set_interaction', doc, from: 'v-cat', to: 'v-table', mode: 'filter' },
  ];
}

export function morePagesOps(doc: string, pages: { details: string; insights: string }): Array<Record<string, unknown>> {
  return [
    { op: 'add_visual', doc, page: pages.details, visual: { id: 'v-matrix', type: 'matrix', title: 'Region and country by year', query: { dims: ['countries.region', 'countries.country', 'orders.order_date:year'], measures: ['Revenue'] }, options: { rows: 2, conditional: [{ field: 'Revenue', kind: 'scale', colors: ['#f4f8fd', '#2a78d6'] }] }, layout: { x: 0, y: 0, w: 7, h: 10 } } },
    { op: 'add_visual', doc, page: pages.details, visual: { id: 'v-scatter', type: 'scatter', title: 'Units and revenue by country (play: year)', query: { dims: ['countries.country'], measures: ['Units', 'Revenue', 'Orders'] }, options: { play: 'orders.order_date:year' }, layout: { x: 7, y: 0, w: 5, h: 10 } } },
    { op: 'add_visual', doc, page: pages.details, visual: { id: 'v-tree', type: 'treemap', title: 'Revenue by category and product', query: { dims: ['products.category', 'products.product'], measures: ['Revenue'] }, layout: { x: 0, y: 10, w: 4, h: 8 } } },
    { op: 'add_visual', doc, page: pages.details, visual: { id: 'v-water', type: 'waterfall', title: 'Margin by region', query: { dims: ['countries.region'], measures: ['Margin'] }, layout: { x: 4, y: 10, w: 4, h: 8 } } },
    { op: 'add_visual', doc, page: pages.details, visual: { id: 'v-gauge', type: 'gauge', title: 'Margin % vs 40%', query: { measures: ['Margin %'] }, options: { target: 0.4, max: 1 }, layout: { x: 8, y: 10, w: 4, h: 8 } } },
    { op: 'add_visual', doc, page: pages.details, visual: { id: 'v-combo', type: 'combo', title: 'Revenue and margin % by quarter', query: { dims: ['orders.order_date:quarter'], measures: ['Revenue', 'Margin %'] }, options: { lines: ['Margin %'] }, layout: { x: 0, y: 18, w: 8, h: 8 } } },
    { op: 'add_visual', doc, page: pages.details, visual: { id: 'v-funnel', type: 'funnel', title: 'Units by channel', query: { dims: ['orders.channel'], measures: ['Units'] }, layout: { x: 8, y: 18, w: 4, h: 8 } } },
    { op: 'add_visual', doc, page: pages.insights, visual: { id: 'v-decomp', type: 'decomp', title: 'Where revenue comes from', query: { measures: ['Revenue'] }, options: { dims: ['countries.region', 'orders.channel', 'products.category'] }, layout: { x: 0, y: 0, w: 6, h: 9 } } },
    { op: 'add_visual', doc, page: pages.insights, visual: { id: 'v-drivers', type: 'drivers', title: 'What moves the average order', query: { measures: ['Avg order'] }, options: { dims: ['orders.channel', 'countries.region', 'products.category'] }, layout: { x: 6, y: 0, w: 6, h: 9 } } },
    { op: 'add_visual', doc, page: pages.insights, visual: { id: 'v-narr', type: 'narrative', title: 'Summary', query: { dims: ['countries.region'], measures: ['Revenue'] }, layout: { x: 0, y: 9, w: 12, h: 4 } } },
  ];
}
