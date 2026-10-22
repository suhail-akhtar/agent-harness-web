import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { carryFilters, drillQuery, drillStep, type DrillState, type HierarchySpec, type QueryResult } from '../packages/plugin-ui/src/bi.ts';
import { DataService } from '../src/data/service.ts';
import { applyOps, type Actor } from '../src/data/ops.ts';
import { visualData } from '../src/data/analytics.ts';
import { GEO_LEVELS, grainOf, type Sale, sumBy, writeRetail } from './fixtures/dashboards/retail.ts';
import { tempDir } from './helpers.ts';
import { OPERATOR, setupServer } from './multi-helpers.ts';

// Drill five levels deep (a calendar and a geography), every level's numbers against sums computed
// here without the engine: down, up, next level, expand all, back to a breadcrumb; time intelligence
// and cross-filtering at each level; drill-through from any level carrying the filters and the path;
// linked dashboards (the context carried into another dashboard, read through a published link).

const ME: Actor = { kind: 'person', label: 'person:test' };
const GRAINS = ['year', 'quarter', 'month', 'week', 'day'] as const;
const CAL: HierarchySpec = { name: 'Calendar', levels: GRAINS.map((g) => `sales.day:${g}`) };
const GEO: HierarchySpec = { name: 'Geography', levels: GEO_LEVELS.map((l) => `geo.${l}`) };

async function fixture() {
  const data = await tempDir();
  const files = path.join(data, 'files');
  await fs.mkdir(files);
  const r = await writeRetail(files);
  const svc = new DataService({ dataDir: data, rootsFor: () => [files], today: () => '2024-12-31' });
  const home = svc.home(undefined);
  const ops = (o: unknown[]) => applyOps(svc, home, o as never, ME);
  await ops([
    { op: 'add_source', source: { id: 'src-s', name: 'Sales', type: 'file', path: path.join(files, 'retail_sales.csv') } },
    { op: 'add_source', source: { id: 'src-g', name: 'Stores', type: 'file', path: path.join(files, 'retail_stores.csv') } },
    { op: 'define', dataset: { name: 'sales', source: 'src-s' } },
    { op: 'define', dataset: { name: 'geo', source: 'src-g' } },
    { op: 'add_model', model: { id: 'retail', name: 'Retail' } },
    { op: 'set_table', model: 'retail', table: { name: 'sales', dataset: 'sales' } },
    { op: 'set_table', model: 'retail', table: { name: 'geo', dataset: 'geo' } },
    { op: 'set_relationship', model: 'retail', relationship: { from: 'sales.store', to: 'geo.store' } },
    { op: 'set_model', model: 'retail', patch: { date: 'sales.day' } },
    { op: 'set_measure', model: 'retail', measure: { name: 'Revenue', expr: 'sum(sales.amount)' } },
    { op: 'set_measure', model: 'retail', measure: { name: 'Units', expr: 'sum(sales.qty)' } },
    { op: 'set_measure', model: 'retail', measure: { name: 'Revenue PY', base: 'Revenue', calc: 'prev_year' } },
    { op: 'set_hierarchy', model: 'retail', hierarchy: CAL },
    { op: 'set_hierarchy', model: 'retail', hierarchy: GEO },
    { op: 'create', doc: { type: 'dashboard', title: 'Retail', model: 'retail' } },
    { op: 'add_visual', doc: '$new', visual: { id: 'v-geo', type: 'column', title: 'Revenue by place', query: { dims: ['geo.region'], measures: ['Revenue'] }, options: { hierarchy: 'Geography', drillMode: true } } },
    { op: 'add_visual', doc: '$new', visual: { id: 'v-cal', type: 'column', title: 'Revenue by period', query: { dims: ['sales.day:year'], measures: ['Revenue', 'Revenue PY'] }, options: { hierarchy: 'Calendar' } } },
    { op: 'add_visual', doc: '$new', visual: { id: 'v-tot', type: 'card', title: 'Revenue', query: { measures: ['Revenue'] } } },
    { op: 'add_page', doc: '$new', page: { name: 'Store detail', kind: 'drillthrough', drillFields: ['geo.city', 'geo.store'] } },
    { op: 'add_visual', doc: '$new', page: 'Store detail', visual: { id: 'v-stores', type: 'table', title: 'Stores', query: { dims: ['geo.store'], measures: ['Revenue'] } } },
  ]);
  const doc = (await home.docs())[0]!.id;
  const geoOf = new Map(r.stores.map((s) => [s.store, s]));
  return { svc, home, ops, doc, r, geoOf, files, data };
}

const key = (v: unknown) => (/^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).slice(0, 10) : String(v));
/** Member -> value of a result (subtotal rows of a table left out). */
const rows = (r: QueryResult, at = 0) => { const lv = r.columns.findIndex((c) => c.role === 'level'); return new Map(r.rows.filter((x) => lv < 0 || x[lv] === 0).map((x) => [key(x[at]), Number(x[r.columns.findIndex((c) => c.role === 'measure')])])); };
const near = (a: Map<string, number>, b: Map<string, number>, what: string) => {
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort(), `${what}: the same members`);
  for (const [k, v] of b) assert.ok(Math.abs((a.get(k) ?? NaN) - v) < 0.005, `${what} ${k}: ${a.get(k)} != ${v}`);
};

test('drill state: down, up, next level, expand all, back to a level; the dims and filters each state means', () => {
  let s: DrillState | undefined;
  s = drillStep(GEO, s, { action: 'down', value: 'EMEA' });
  assert.deepEqual(s, { level: 1, path: ['EMEA'] });
  s = drillStep(GEO, s, { action: 'down', value: 'France' });
  s = drillStep(GEO, s, { action: 'next' });
  assert.deepEqual(s, { level: 3, path: ['EMEA', 'France', null], skip: [2] });
  assert.deepEqual(drillQuery(GEO, s), { dims: ['geo.city'], filters: [{ field: 'geo.region', op: 'eq', value: 'EMEA' }, { field: 'geo.country', op: 'eq', value: 'France' }] });
  s = drillStep(GEO, s, { action: 'down', value: 'Fra-1-City1' });
  s = drillStep(GEO, s, { action: 'down', value: 'S99' }); // at the last level: nothing to go down to
  assert.equal(s.level, 4);
  s = drillStep(GEO, s, { action: 'to', level: 1 });
  assert.deepEqual(s, { level: 1, path: ['EMEA'] });
  s = drillStep(GEO, s, { action: 'expand' });
  assert.deepEqual(drillQuery(GEO, s), { dims: ['geo.country', 'geo.state'], filters: [{ field: 'geo.region', op: 'eq', value: 'EMEA' }] });
  s = drillStep(GEO, s, { action: 'expand' });
  assert.deepEqual(drillQuery(GEO, s).dims, ['geo.country', 'geo.state', 'geo.city']);
  // A point of an expanded view carries a value per level shown.
  const d = drillStep(GEO, s, { action: 'down', values: ['France', 'Fra-State1', 'Fra-1-City1'] });
  assert.deepEqual(d, { level: 4, path: ['EMEA', 'France', 'Fra-State1', 'Fra-1-City1'] });
  s = drillStep(GEO, s, { action: 'up' });
  assert.equal(s.mode, 'expand'); assert.equal(s.level, 2);
  s = drillStep(GEO, s, { action: 'up' });
  assert.deepEqual(s, { level: 1, path: ['EMEA'] });
  assert.deepEqual(drillStep(GEO, s, { action: 'reset' }), { level: 0, path: [] });
  // Carried context: later wins per field; only the named fields when a link asks.
  assert.deepEqual(carryFilters([[{ field: 'geo.region', op: 'eq', value: 'AMER' }], [{ field: 'geo.region', op: 'eq', value: 'EMEA' }, { field: 'geo.city', op: 'eq', value: 'X' }]], ['geo.region']), [{ field: 'geo.region', op: 'eq', value: 'EMEA' }]);
});

test('five levels of a geography and a calendar: every level\'s numbers equal sums computed without the engine; time intelligence and cross-filter at each level', async () => {
  const f = await fixture();
  const { sales } = f.r;
  const g = (s: Sale, l: number) => f.geoOf.get(s.store)![GEO_LEVELS[l]!];
  const drill = async (visual: string, state: Record<string, unknown>, action: Record<string, unknown>) => {
    const r = await f.ops([{ op: 'drill', doc: f.doc, visual, state, ...action }]);
    return r.results[0]!.data as { state: DrillState; result: QueryResult };
  };
  // Geography: down a path of the first member at each level.
  let st: DrillState | undefined;
  const path: string[] = [];
  for (let level = 0; level < 5; level++) {
    const out = await drill('v-geo', { drill: st ? { 'v-geo': st } : {} }, level === 0 ? { action: 'reset' } : { action: 'down', value: path[level - 1] });
    st = out.state;
    assert.equal(st.level, level);
    assert.equal(out.result.columns[0]!.field, `geo.${GEO_LEVELS[level]}`);
    const truth = sumBy(sales, (s) => g(s, level), (s) => s.amount, (s) => path.every((v, i) => g(s, i) === v));
    near(rows(out.result), truth, `geo level ${level + 1}`);
    // Cross-filter: a selection of this level's first member filters the card to that member (and the path).
    const member = [...truth.keys()].sort()[0]!;
    const doc = (await f.home.doc(f.doc)).spec;
    const card = await visualData(f.svc, f.home, doc, doc.pages[0]!.visuals.find((v) => v.id === 'v-tot')!, { selection: { visual: 'v-geo', filters: [{ field: `geo.${GEO_LEVELS[level]}`, op: 'eq', value: member }] } });
    assert.ok(Math.abs(Number(card.rows[0]![0]) - truth.get(member)!) < 0.005, `cross-filter at level ${level + 1}`);
    path.push(member);
  }
  // Up two, then the breadcrumb back to the top level, then next level (all countries).
  let out = await drill('v-geo', { drill: { 'v-geo': st } }, { action: 'up' });
  out = await drill('v-geo', { drill: { 'v-geo': out.state } }, { action: 'up' });
  near(rows(out.result), sumBy(sales, (s) => g(s, 2), (s) => s.amount, (s) => g(s, 0) === path[0] && g(s, 1) === path[1]), 'after two ups');
  out = await drill('v-geo', { drill: { 'v-geo': out.state } }, { action: 'to', level: 0 });
  out = await drill('v-geo', { drill: { 'v-geo': out.state } }, { action: 'next' });
  near(rows(out.result), sumBy(sales, (s) => g(s, 1), (s) => s.amount), 'next level: every country');
  // Expand all from the top: region and country together, one axis of both.
  out = await drill('v-geo', {}, { action: 'expand' });
  assert.equal(out.result.extra?.expand, 2);
  const both = new Map(out.result.rows.map((x) => [`${x[0]}|${x[1]}`, Number(x[2])]));
  near(both, sumBy(sales, (s) => `${g(s, 0)}|${g(s, 1)}`, (s) => s.amount), 'expanded region and country');

  // Calendar: year > quarter > month > week > day, with last year's revenue at each level.
  let cs: DrillState | undefined;
  const cpath: string[] = [];
  for (let level = 0; level < 5; level++) {
    const o = await drill('v-cal', { drill: cs ? { 'v-cal': cs } : {} }, level === 0 ? { action: 'reset' } : { action: 'down', value: cpath[level - 1] });
    cs = o.state;
    const grain = GRAINS[level]!;
    const inPath = (s: Sale) => cpath.every((v, i) => grainOf(s.day, GRAINS[i]!) === v);
    near(rows(o.result), sumBy(sales, (s) => grainOf(s.day, grain), (s) => s.amount, inPath), `calendar ${grain}`);
    // Last year's value of each period shown: the rows a year earlier, at the same grain.
    const py = new Map(o.result.rows.map((x) => [key(x[0]), x[2] === null ? null : Number(x[2])]));
    for (const [period, v] of py) {
      const shift = (s: Sale) => { const d = new Date(`${s.day}T00:00:00Z`); d.setUTCFullYear(d.getUTCFullYear() + 1); return grainOf(d.toISOString().slice(0, 10), grain); };
      const expect = sales.filter((s) => shift(s) === period).reduce((a, s) => a + s.amount, 0);
      assert.ok(expect === 0 ? v === null || v === 0 : Math.abs((v ?? NaN) - expect) < 0.005, `${grain} ${period} PY ${v} != ${expect}`);
    }
    const members = [...rows(o.result).keys()].sort();
    // Go down through the second year (its periods have a previous year).
    cpath.push(members.find((m) => m >= '2024') ?? members[0]!);
  }
});

test('drill-through from any level carries the filters and the drilled path; a link opens another dashboard with them (and only the fields it names)', async () => {
  const f = await fixture();
  const { sales } = f.r;
  const g = (s: Sale, l: number) => f.geoOf.get(s.store)![GEO_LEVELS[l]!];
  const first = (l: number, keep: (s: Sale) => boolean) => [...new Set(sales.filter(keep).map((s) => g(s, l)))].sort()[0]!;
  const region = first(0, () => true); const country = first(1, (s) => g(s, 0) === region); const state = first(2, (s) => g(s, 1) === country);
  const city = first(3, (s) => g(s, 2) === state);
  const drillState = { 'v-geo': { level: 3, path: [region, country, state] } };
  const r = await f.ops([{ op: 'drillthrough', doc: f.doc, visual: 'v-geo', state: { drill: drillState, filters: [{ field: 'sales.day:year', op: 'eq', value: '2024-01-01' }] }, point: { 'geo.city': city }, to: { page: 'Store detail' } }]);
  const out = r.results[0]!.data as { state: { drillthrough: Array<{ field: string }> }; results: Record<string, QueryResult> };
  assert.deepEqual(out.state.drillthrough.map((x) => x.field).sort(), ['geo.city', 'geo.country', 'geo.region', 'geo.state', 'sales.day:year']);
  near(rows(out.results['v-stores']!), sumBy(sales, (s) => s.store, (s) => s.amount, (s) => g(s, 3) === city && s.day.startsWith('2024')), 'drill-through: stores of the city in 2024');

  // Linked dashboard: B shows stores; a link from A's chart carries the context.
  await f.ops([
    { op: 'create', doc: { type: 'dashboard', title: 'Store ranking', model: 'retail' } },
    { op: 'add_visual', doc: '$new', visual: { id: 'v-b-tot', type: 'card', title: 'Revenue', query: { measures: ['Revenue'] } } },
    { op: 'add_visual', doc: '$new', visual: { id: 'v-b-stores', type: 'bar', title: 'Stores', query: { dims: ['geo.store'], measures: ['Revenue'] } } },
  ]);
  const b = (await f.home.docs()).find((d) => d.id !== f.doc)!.id;
  await assert.rejects(f.ops([{ op: 'add_link', doc: f.doc, visual: 'v-geo', link: { label: 'Nowhere', doc: 'dash-none' } }]), /no dashboard dash-none/);
  const l = await f.ops([{ op: 'add_link', doc: f.doc, visual: 'v-geo', link: { label: 'Store ranking', doc: b } }]);
  const lid = (l.results[0]!.data as { id: string }).id;
  const viaLink = await f.ops([{ op: 'drillthrough', doc: f.doc, visual: 'v-geo', state: { drill: { 'v-geo': { level: 2, path: [region, country] } } }, point: { 'geo.state': state }, link: lid }]);
  const vl = viaLink.results[0]!.data as { doc: string; results: Record<string, QueryResult> };
  assert.equal(vl.doc, b);
  const inState = (s: Sale) => g(s, 2) === state;
  assert.ok(Math.abs(Number(vl.results['v-b-tot']!.rows[0]![0]) - sales.filter(inState).reduce((a, s) => a + s.amount, 0)) < 0.005, 'B\'s total is the state\'s');
  near(rows(vl.results['v-b-stores']!), sumBy(sales, (s) => s.store, (s) => s.amount, inState), 'B\'s stores are the state\'s');
  // A link that carries only the country.
  const narrow = await f.ops([{ op: 'add_link', doc: f.doc, visual: 'v-geo', link: { label: 'Country only', doc: b, fields: ['geo.country'] } }]);
  const nl = await f.ops([{ op: 'drillthrough', doc: f.doc, visual: 'v-geo', state: { drill: { 'v-geo': { level: 2, path: [region, country] } } }, point: { 'geo.state': state }, link: (narrow.results[0]!.data as { id: string }).id }]);
  const ns = (nl.results[0]!.data as { state: { filters: Array<{ field: string }> }; results: Record<string, QueryResult> });
  assert.deepEqual(ns.state.filters.map((x) => x.field), ['geo.country']);
  assert.ok(Math.abs(Number(ns.results['v-b-tot']!.rows[0]![0]) - sales.filter((s) => g(s, 1) === country).reduce((a, s) => a + s.amount, 0)) < 0.005);
  // Sync groups are checked; a link is removed by id.
  await assert.rejects(f.ops([{ op: 'sync_slicer', doc: f.doc, visual: 'v-geo', group: 'region' }]), /not a slicer/);
  await f.ops([{ op: 'add_visual', doc: f.doc, visual: { id: 'v-sl', type: 'slicer', options: { slicer: { field: 'geo.region' } } } }, { op: 'sync_slicer', doc: f.doc, visual: 'v-sl', group: 'region' }]);
  assert.equal((await f.home.doc(f.doc)).spec.pages[0]!.visuals.find((v) => v.id === 'v-sl')!.options!.slicer!.sync, 'region');
  await f.ops([{ op: 'remove_link', doc: f.doc, visual: 'v-geo', link: lid }]);
  assert.equal((await f.home.doc(f.doc)).spec.pages[0]!.visuals.find((v) => v.id === 'v-geo')!.options!.links!.length, 1);
  // A hierarchy is two to five levels.
  await assert.rejects(f.ops([{ op: 'set_hierarchy', model: 'retail', hierarchy: { name: 'Too deep', levels: ['geo.region', 'geo.country', 'geo.state', 'geo.city', 'geo.store', 'sales.day:year'] } }]), /two to 5 fields/);
});

test('published: a linked dashboard is read through the published link (and only a linked one), with the carried filters', async () => {
  const t = await setupServer();
  try {
    const files = await tempDir();
    const r = await writeRetail(files);
    await t.harness.data.grantRoot(t.harness.data.home(undefined), files);
    const ops = async (o: unknown[]) => { const x = await t.call(OPERATOR, 'POST', '/api/data/ops', { ops: o }); assert.equal(x.status, 200, JSON.stringify(x.body)); return x.body; };
    await ops([
      { op: 'add_source', source: { id: 'src-s', name: 'Sales', type: 'file', path: path.join(files, 'retail_sales.csv') } },
      { op: 'add_source', source: { id: 'src-g', name: 'Stores', type: 'file', path: path.join(files, 'retail_stores.csv') } },
      { op: 'define', dataset: { name: 'sales', source: 'src-s' } }, { op: 'define', dataset: { name: 'geo', source: 'src-g' } },
      { op: 'add_model', model: { id: 'retail', name: 'Retail' } },
      { op: 'set_table', model: 'retail', table: { name: 'sales', dataset: 'sales' } }, { op: 'set_table', model: 'retail', table: { name: 'geo', dataset: 'geo' } },
      { op: 'set_relationship', model: 'retail', relationship: { from: 'sales.store', to: 'geo.store' } },
      { op: 'set_measure', model: 'retail', measure: { name: 'Revenue', expr: 'sum(sales.amount)' } },
      { op: 'create', doc: { type: 'dashboard', title: 'Countries', model: 'retail' } },
      { op: 'add_visual', doc: '$new', visual: { id: 'v-c', type: 'column', query: { dims: ['geo.country'], measures: ['Revenue'] } } },
      { op: 'create', doc: { type: 'dashboard', title: 'Stores', model: 'retail' } },
      { op: 'add_visual', doc: '$new', visual: { id: 'v-s', type: 'bar', query: { dims: ['geo.store'], measures: ['Revenue'] } } },
      { op: 'add_visual', doc: '$new', visual: { id: 'v-sl', type: 'slicer', options: { slicer: { field: 'geo.country', sync: 'country' } } } },
      { op: 'create', doc: { type: 'dashboard', title: 'Private', model: 'retail' } },
    ]);
    const docs = (await t.call(OPERATOR, 'GET', '/api/data/docs')).body as Array<{ id: string; title: string }>;
    const A = docs.find((d) => d.title === 'Countries')!.id; const B = docs.find((d) => d.title === 'Stores')!.id; const C = docs.find((d) => d.title === 'Private')!.id;
    await ops([{ op: 'add_link', doc: A, visual: 'v-c', link: { label: 'Stores', doc: B } }]);
    const pub = (await ops([{ op: 'publish', doc: A, access: 'token' }])).results[0].data as { slug: string; token: string };
    const h = { 'x-harness-share': pub.token, 'content-type': 'application/json' };
    const linked = await fetch(`${t.base}/p/${pub.slug}/api/doc?linked=${B}`, { headers: h });
    assert.equal(linked.status, 200);
    const lb = await linked.json() as { doc: { title: string }; fields: string[] };
    assert.equal(lb.doc.title, 'Stores'); assert.ok(lb.fields.includes('geo.country'));
    assert.equal((await fetch(`${t.base}/p/${pub.slug}/api/doc?linked=${C}`, { headers: h })).status, 404, 'a dashboard the published one does not link to stays private');
    assert.equal((await fetch(`${t.base}/p/${pub.slug}/api/doc?linked=${B}`)).status, 401, 'the link\'s token is needed');
    const v = await fetch(`${t.base}/p/${pub.slug}/api/visual`, { method: 'POST', headers: h, body: JSON.stringify({ visual: 'v-s', linked: B, state: { filters: [{ field: 'geo.country', op: 'eq', value: 'France' }] } }) });
    assert.equal(v.status, 200);
    const res = await v.json() as QueryResult;
    const fr = new Set(r.stores.filter((s) => s.country === 'France').map((s) => s.store));
    const truth = sumBy(r.sales, (s) => s.store, (s) => s.amount, (s) => fr.has(s.store));
    near(new Map(res.rows.map((x) => [String(x[0]), Number(x[1])])), truth, 'the linked page with the carried country');
  } finally { await t.close(); }
});
