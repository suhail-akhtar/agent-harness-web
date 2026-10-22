import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { BUILTIN_TEMPLATES, LAYOUT_TYPES, pack, reflow, type PageSpec, type VisualSpec } from '../packages/plugin-ui/src/index.ts';
import { validateUiManifest } from '../packages/plugin-ui/src/manifest.ts';
import { visualData } from '../src/data/analytics.ts';
import { applyOps, type Actor } from '../src/data/ops.ts';
import { DataService } from '../src/data/service.ts';
import { tempDir } from './helpers.ts';
import { writeSalesFiles } from './fixtures/dashboards/sales.ts';
import { dashboardOps, modelOps } from './fixtures/dashboards/seed.ts';

// Layouts and templates as ops: every layout type keeps every widget when a page switches to it
// (and Undo brings the old one back), gaps pack, canvas layers, locks, groups and alignment,
// sections and tabs, the sidebar; templates filled from a real model run every widget they make.

const ME: Actor = { kind: 'person', label: 'person:t' };

async function setup() {
  const data = await tempDir();
  const files = path.join(data, 'files');
  const paths = await writeSalesFiles(files, 600);
  const svc = new DataService({ dataDir: data, rootsFor: () => [files] });
  const home = svc.home(undefined);
  const ops = (o: unknown[]) => applyOps(svc, home, o as never, ME);
  await ops(modelOps(paths));
  const r = await ops(dashboardOps());
  const doc = (r.results[0]!.data as { id: string }).id;
  return { svc, home, ops, doc };
}

const overlaps = (vs: VisualSpec[]) => vs.some((a, i) => vs.some((b, j) => j > i && (a.section ?? '') === (b.section ?? '') && a.layout.x < b.layout.x + b.layout.w && b.layout.x < a.layout.x + a.layout.w && a.layout.y < b.layout.y + b.layout.h && b.layout.y < a.layout.y + a.layout.h));

test('pack and reflow (pure): gaps close without overlaps; every layout type keeps every widget', () => {
  const v = (id: string, x: number, y: number, w: number, h: number, type: VisualSpec['type'] = 'column'): VisualSpec => ({ id, type, layout: { x, y, w, h } });
  const gappy = [v('a', 0, 5, 6, 4), v('b', 6, 9, 6, 4), v('c', 0, 20, 12, 3)];
  const up = pack(gappy);
  assert.deepEqual(up.map((x) => [x.layout.x, x.layout.y]), [[0, 0], [6, 0], [0, 4]]);
  assert.ok(!overlaps(up));
  const page: PageSpec = { id: 'p', name: 'P', visuals: [v('k1', 0, 0, 3, 4, 'kpi'), v('k2', 3, 0, 3, 4, 'card'), v('s', 6, 0, 3, 6, 'slicer'), v('c', 0, 4, 8, 8), v('t', 0, 12, 12, 8, 'table')] };
  for (const type of LAYOUT_TYPES) {
    const r = reflow(page, { type });
    assert.deepEqual(r.visuals.map((x) => x.id), page.visuals.map((x) => x.id), `${type}: same widgets`);
    assert.equal(r.layout!.type, type);
    if (type !== 'canvas') assert.ok(r.visuals.every((x) => x.layout.x + x.layout.w <= 12), `${type}: within 12 columns`);
    if (!['canvas', 'masonry', 'story', 'print'].includes(type)) assert.ok(!overlaps(r.visuals), `${type}: no overlaps`);
  }
  const canvas = reflow(page, { type: 'canvas' });
  assert.deepEqual(canvas.visuals[3]!.layout, { x: 0, y: 6 * 48, w: 792, h: 8 * 48 - 8, z: 4 }, 'grid units to pixels (packed under the slicer), a layer each');
  assert.deepEqual(reflow(canvas, { type: 'grid' }).visuals.map((x) => [x.layout.x, x.layout.w]), page.visuals.map((x) => [x.layout.x, x.layout.w]), 'and back to the grid where they were');
  const side = reflow(page, { type: 'sidebar' });
  assert.deepEqual(side.visuals.filter((x) => x.section === 'sidebar').map((x) => x.id), ['s'], 'slicers into the sidebar');
  const tabs = reflow(page, { type: 'tabs' });
  assert.deepEqual(tabs.layout!.sections!.map((s) => s.title), ['Summary', 'Charts', 'Tables']);
  const tv = reflow({ ...page, visuals: [...page.visuals, v('long', 0, 40, 12, 30)] }, { type: 'tv' });
  assert.ok(Math.max(...tv.visuals.map((x) => x.layout.y + x.layout.h)) <= 14, 'a TV page fits its screen');
});

test('set_layout through ops: switching keeps the widgets and checks them; undo restores the layout; drag, resize, layers, locks, groups, alignment, sections', async () => {
  const { home, ops, doc } = await setup();
  const before = (await home.doc(doc)).spec.pages[0]!;
  for (const type of [...LAYOUT_TYPES.slice(1), 'grid']) {
    const r = await ops([{ op: 'set_layout', doc, page: 'p-1', layout: { type } }]);
    assert.match(r.results[0]!.message, new RegExp(`now a ${type} layout \\(${before.visuals.length} widgets`));
    const p = (await home.doc(doc)).spec.pages[0]!;
    assert.deepEqual(p.visuals.map((x) => x.id).sort(), before.visuals.map((x) => x.id).sort());
  }
  await ops([{ op: 'undo', doc }]);
  assert.equal((await home.doc(doc)).spec.pages[0]!.layout?.type, 'print', 'undo: back to the layout before the grid');
  // Canvas: pixels, layers, a lock, a group that moves together, alignment.
  await ops([{ op: 'set_layout', doc, page: 'p-1', layout: { type: 'canvas' } }]);
  await ops([{ op: 'move_widget', doc, visual: 'v-rev', x: 40, y: 16 }, { op: 'resize_widget', doc, visual: 'v-rev', w: 300, h: 180 }, { op: 'arrange', doc, visual: 'v-rev', z: 'front' }]);
  let p = (await home.doc(doc)).spec.pages[0]!;
  const rev = p.visuals.find((x) => x.id === 'v-rev')!;
  assert.deepEqual([rev.layout.x, rev.layout.y, rev.layout.w, rev.layout.h], [40, 16, 300, 180]);
  assert.equal(rev.layout.z, Math.max(...p.visuals.map((x) => x.layout.z ?? 0)));
  await ops([{ op: 'arrange', doc, visual: 'v-rev', lock: true }]);
  await assert.rejects(ops([{ op: 'move_widget', doc, visual: 'v-rev', x: 0 }]), /locked/);
  await ops([{ op: 'arrange', doc, visual: 'v-margin', group: 'top' }, { op: 'arrange', doc, visual: 'v-orders', group: 'top' }]);
  const o0 = p.visuals.find((x) => x.id === 'v-orders')!.layout;
  await ops([{ op: 'move_widget', doc, visual: 'v-margin', x: 500, y: 0, dx: 100, dy: 0 }]);
  p = (await home.doc(doc)).spec.pages[0]!;
  assert.equal(p.visuals.find((x) => x.id === 'v-orders')!.layout.x, o0.x + 100, 'the group moved together');
  await ops([{ op: 'align', doc, visuals: ['v-margin', 'v-orders', 'v-cat'], edge: 'top' }]);
  p = (await home.doc(doc)).spec.pages[0]!;
  assert.equal(new Set(['v-margin', 'v-orders', 'v-cat'].map((id) => p.visuals.find((x) => x.id === id)!.layout.y)).size, 1);
  // Sections and tabs.
  await ops([{ op: 'set_layout', doc, page: 'p-1', layout: { type: 'sections' } }]);
  const s = await ops([{ op: 'add_section', doc, page: 'p-1', section: { title: 'Later' } }]);
  const sid = (s.results[0]!.data as { id: string }).id;
  await ops([{ op: 'move_widget', doc, visual: 'v-table', section: sid }, { op: 'update_section', doc, page: 'p-1', section: sid, patch: { collapsed: true, to: 0 } }]);
  p = (await home.doc(doc)).spec.pages[0]!;
  assert.equal(p.layout!.sections![0]!.id, sid); assert.equal(p.layout!.sections![0]!.collapsed, true);
  assert.equal(p.visuals.find((x) => x.id === 'v-table')!.section, sid);
  await assert.rejects(ops([{ op: 'move_widget', doc, visual: 'v-table', section: 'nope' }]), /no section "nope"/);
  await ops([{ op: 'remove_section', doc, page: 'p-1', section: sid }]);
  p = (await home.doc(doc)).spec.pages[0]!;
  assert.notEqual(p.visuals.find((x) => x.id === 'v-table')!.section, sid);
  // Sections straight to a canvas: the section ids go, every widget stays.
  await ops([{ op: 'set_layout', doc, page: 'p-1', layout: { type: 'canvas' } }]);
  p = (await home.doc(doc)).spec.pages[0]!;
  assert.ok(p.visuals.every((x) => !x.section), 'no section ids on a canvas');
  // A grid with gaps packs; a medium arrangement of its own.
  await ops([{ op: 'set_layout', doc, page: 'p-1', layout: { type: 'grid' } }, { op: 'move_widget', doc, visual: 'v-table', y: 60 }]);
  await ops([{ op: 'pack', doc, page: 'p-1', direction: 'up' }]);
  p = (await home.doc(doc)).spec.pages[0]!;
  assert.ok(p.visuals.find((x) => x.id === 'v-table')!.layout.y < 60);
  await ops([{ op: 'move_widget', doc, visual: 'v-rev', x: 0, y: 30, breakpoint: 'medium' }]);
  assert.deepEqual((await home.doc(doc)).spec.pages[0]!.visuals.find((x) => x.id === 'v-rev')!.layouts!.medium!.y, 30);
  // Bad layouts are refused with the choices.
  await assert.rejects(ops([{ op: 'set_layout', doc, page: 'p-1', layout: { type: 'carousel' } }]), /grid, canvas, sections/);
  await assert.rejects(ops([{ op: 'set_layout', doc, page: 'p-1', layout: { type: 'tv', aspect: '4:3' } }]), /16:9 or 21:9/);
});

test('templates filled from a real model: every widget made runs; nothing invented when a field is missing; plugins contribute templates', async () => {
  const { svc, home, ops } = await setup();
  const list = (await ops([{ op: 'list_templates' }])).results[0]!.data as Array<{ id: string }>;
  assert.ok(list.length >= 18);
  for (const t of BUILTIN_TEMPLATES.filter((x) => !x.id.startsWith('blank'))) {
    const r = await ops([{ op: 'apply_template', template: t.id, model: 'sales' }]);
    const out = r.results[0]!.data as { id: string; skipped: string[] };
    const { spec } = await home.doc(out.id);
    const visuals = spec.pages.flatMap((p) => p.visuals);
    assert.ok(visuals.length >= 3, `${t.id}: ${visuals.length} widgets (left out: ${out.skipped.join('; ')})`);
    assert.equal(spec.pages[0]!.layout?.type ?? 'grid', t.pages[0]!.layout?.type ?? 'grid');
    for (const v of visuals) {
      if (['text', 'image', 'button'].includes(v.type) || (v.type === 'fence' && v.options?.fence?.source)) continue;
      const res = await visualData(svc, home, spec, v, {});
      assert.ok(res.rows.length > 0 || v.type === 'narrative', `${t.id}/${v.title}: rows`);
    }
  }
  // Without a model, a template with placeholders is refused (blank ones are fine).
  await assert.rejects(ops([{ op: 'apply_template', template: 'executive' }]), /fills its widgets from a model/);
  const blank = await ops([{ op: 'apply_template', template: 'blank-print' }]);
  const b = await home.doc((blank.results[0]!.data as { id: string }).id);
  assert.equal(b.spec.type, 'report'); assert.equal(b.spec.pages[0]!.layout?.type, 'print');
  // The contribution point validates.
  const ui = validateUiManifest({ contributes: { dashboardTemplates: [{ id: 'oncall', title: 'On-call', pages: [{ name: 'Now', layout: { type: 'tv' }, visuals: [{ type: 'card', title: '$m1', query: { measures: ['$m1'] } }] }] }] } });
  assert.equal(ui.contributes.dashboardTemplates[0]!.id, 'oncall');
  assert.throws(() => validateUiManifest({ contributes: { dashboardTemplates: [{ id: 'x', title: 'X', pages: [{ name: 'a', layout: { type: 'carousel' }, visuals: [] }] }] } }), /layout type "carousel"/);
});
