// Resizable panes: the pure half (bounds, clamping to the window, drags that collapse and expand,
// the handle's keys, reset), the stores that keep the sizes (localStorage, the desktop's prefs and
// their file), the handle drawn (a focusable separator with its value) and the desktop's layout
// command that agents call. The real drags, in Electron: test/desktop-layout-e2e.test.ts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import {
  clampPane, cleanPaneState, collapseBelowOf, describePane, dragPane, keyPane, memoryPaneStore, paneBounds, paneDefault, paneShown,
  type PaneSpec,
} from '../packages/ui/src/components/panes.ts';
import { DEFAULT_PREFS, mergePrefs } from '../apps/desktop/shared/prefs.ts';
import { loadUi } from './fixtures/desktop/load-ui.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vp = { width: 1280, height: 800 };
const sidebar: PaneSpec = { id: 'sidebar', title: 'sidebar', default: 272, min: 200, max: (v) => Math.min(480, v.width - 416), collapsible: true, collapsedSize: 56, collapseBelow: 140 };
const panel: PaneSpec = { id: 'side-panel', title: 'side panel', default: (v) => Math.round(Math.min(520, v.width * 0.42)), min: 280, max: (v) => v.width - 272 - 360 };
const keys = { grow: 'ArrowRight', shrink: 'ArrowLeft' };

test('panes: bounds and clamping follow the window, and a tiny window still shows the minimum', () => {
  assert.deepEqual(paneBounds(sidebar, vp), { min: 200, max: 480 });
  assert.deepEqual(paneBounds(sidebar, { width: 800, height: 600 }), { min: 200, max: 384 }, 'the main content keeps its room');
  assert.deepEqual(paneBounds(sidebar, { width: 400, height: 600 }), { min: 200, max: 200 }, 'max never below min');
  assert.equal(clampPane(sidebar, 9999, vp), 480);
  assert.equal(clampPane(sidebar, 10, vp), 200);
  assert.equal(clampPane(sidebar, Number.NaN, vp), 200);
  assert.equal(clampPane(sidebar, 300.6, vp), 301, 'whole pixels');
  assert.equal(paneDefault(panel, vp), 520);
  assert.equal(paneDefault(panel, { width: 1000, height: 700 }), 368, 'a default may follow the window, and is clamped too');
  // No max: the window's own extent.
  assert.deepEqual(paneBounds({ id: 'x', title: 'x', default: 100, min: 50 }, vp), { min: 50, max: 1279 });
  assert.deepEqual(paneBounds({ id: 'y', title: 'y', axis: 'y', default: 100, min: 50 }, vp), { min: 50, max: 799 });
  // A pane inside a page leaves its container `keep` px for what is beside it.
  const list: PaneSpec = { id: 'list', title: 'list', default: 256, min: 180, max: 480, keep: 320 };
  assert.deepEqual(paneBounds(list, vp), { min: 180, max: 480 }, 'no container measured yet: its own max');
  assert.deepEqual(paneBounds(list, { ...vp, box: 1000 }), { min: 180, max: 480 });
  assert.deepEqual(paneBounds(list, { ...vp, box: 600 }), { min: 180, max: 280 }, 'a narrow container');
  assert.deepEqual(paneBounds(list, { ...vp, box: 300 }), { min: 180, max: 180 });
  assert.deepEqual(paneShown(list, { size: 400 }, { ...vp, box: 600 }), { size: 280, collapsed: false });
  assert.deepEqual(dragPane(list, { size: 256, collapsed: false }, 200, { ...vp, box: 600 }), { size: 280, collapsed: false });
});

test('panes: what shows is the saved size clamped to the window, and the saved size survives a small window', () => {
  assert.deepEqual(paneShown(sidebar, undefined, vp), { size: 272, collapsed: false }, 'nothing saved: the default');
  assert.deepEqual(paneShown(sidebar, { size: 450 }, vp), { size: 450, collapsed: false });
  assert.deepEqual(paneShown(sidebar, { size: 450 }, { width: 800, height: 600 }), { size: 384, collapsed: false }, 'clamped in a small window');
  assert.deepEqual(paneShown(sidebar, { size: 450 }, vp), { size: 450, collapsed: false }, 'back at full size when the window grows again');
  assert.deepEqual(paneShown(sidebar, { size: 300, collapsed: true }, vp), { size: 300, collapsed: true });
  assert.deepEqual(paneShown(panel, { collapsed: true }, vp), { size: 520, collapsed: false }, 'a pane that does not collapse never is');
});

test('panes: a drag resizes within the bounds, collapses below the threshold and expands when dragged out again', () => {
  const start = { size: 272, collapsed: false };
  assert.deepEqual(dragPane(sidebar, start, 50, vp), { size: 322, collapsed: false });
  assert.deepEqual(dragPane(sidebar, start, 900, vp), { size: 480, collapsed: false }, 'stops at max');
  assert.deepEqual(dragPane(sidebar, start, -100, vp), { size: 200, collapsed: false }, 'stops at min above the threshold');
  assert.equal(collapseBelowOf(sidebar), 140);
  assert.deepEqual(dragPane(sidebar, start, -140, vp), { size: 272, collapsed: true }, 'below the threshold: collapsed, the size kept for later');
  const rail = { size: 272, collapsed: true };
  assert.deepEqual(dragPane(sidebar, rail, 40, vp), { size: 272, collapsed: true }, 'a small pull on the rail stays collapsed');
  assert.deepEqual(dragPane(sidebar, rail, 120, vp), { size: 200, collapsed: false }, 'out past the threshold: expanded at least to min');
  assert.deepEqual(dragPane(sidebar, rail, 300, vp), { size: 356, collapsed: false });
  // A pane that does not collapse only clamps; the default threshold is half the min.
  assert.deepEqual(dragPane(panel, { size: 400, collapsed: false }, -390, vp), { size: 280, collapsed: false });
  assert.equal(collapseBelowOf(panel), 140);
});

test('panes: the handle keys (arrows, Shift, Home, End, Enter) and reset', () => {
  const cur = { size: 272, collapsed: false };
  assert.deepEqual(keyPane(sidebar, cur, 'ArrowRight', keys, vp), { size: 288, collapsed: false });
  assert.deepEqual(keyPane(sidebar, cur, 'ArrowLeft', keys, vp), { size: 256, collapsed: false });
  assert.deepEqual(keyPane(sidebar, cur, 'ArrowRight', { ...keys, shift: true }, vp), { size: 336, collapsed: false }, 'Shift: four steps');
  assert.deepEqual(keyPane(sidebar, { size: 476, collapsed: false }, 'ArrowRight', keys, vp), { size: 480, collapsed: false }, 'clamped');
  assert.deepEqual(keyPane(sidebar, cur, 'Home', keys, vp), { size: 200, collapsed: false });
  assert.deepEqual(keyPane(sidebar, cur, 'End', keys, vp), { size: 480, collapsed: false });
  assert.deepEqual(keyPane(sidebar, cur, 'Enter', keys, vp), { size: 272, collapsed: true }, 'Enter collapses');
  assert.deepEqual(keyPane(sidebar, { size: 272, collapsed: true }, 'Enter', keys, vp), { size: 272, collapsed: false }, 'and expands');
  assert.deepEqual(keyPane(sidebar, { size: 272, collapsed: true }, 'ArrowRight', keys, vp), { size: 272, collapsed: false }, 'growing a collapsed pane expands it');
  assert.equal(keyPane(panel, { size: 400, collapsed: false }, 'Enter', keys, vp), null, 'Enter is not a key of a pane that does not collapse');
  assert.equal(keyPane(sidebar, cur, 'a', keys, vp), null);
  // A handle on the pane's left edge (the side panel): ArrowLeft grows it.
  assert.deepEqual(keyPane(panel, { size: 400, collapsed: false }, 'ArrowLeft', { grow: 'ArrowLeft', shrink: 'ArrowRight' }, vp), { size: 416, collapsed: false });
  assert.deepEqual(keyPane({ ...panel, step: 32 }, { size: 400, collapsed: false }, 'ArrowRight', { grow: 'ArrowLeft', shrink: 'ArrowRight' }, vp), { size: 368, collapsed: false }, 'its own step');
});

test('panes: the stores keep a clean state, persist it and reset it', () => {
  assert.deepEqual(cleanPaneState({ size: 300.4, collapsed: true, extra: 1 }), { size: 300, collapsed: true });
  assert.equal(cleanPaneState({ size: 'big' }), null);
  assert.equal(cleanPaneState({ size: -5 }), null);
  assert.equal(cleanPaneState(null), null);
  const backing = new Map<string, string>();
  const ls = { getItem: (k: string) => backing.get(k) ?? null, setItem: (k: string, v: string) => { backing.set(k, v); } };
  const s = memoryPaneStore(ls);
  let calls = 0;
  const un = s.subscribe(() => calls++);
  s.set('a', { size: 300 });
  s.set('a', { collapsed: true });
  assert.deepEqual(s.get('a'), { size: 300, collapsed: true }, 'a patch merges');
  assert.equal(calls, 2);
  assert.deepEqual(memoryPaneStore(ls).get('a'), { size: 300, collapsed: true }, 'kept across a reload');
  s.set('a', null);
  assert.equal(s.get('a'), undefined, 'reset forgets it');
  assert.equal(memoryPaneStore(ls).get('a'), undefined);
  un();
  s.set('b', { size: 1 });
  assert.equal(calls, 3, 'unsubscribed');
  // A broken store file is ignored.
  assert.equal(memoryPaneStore({ getItem: () => '{bad', setItem: () => {} }).get('a'), undefined);
});

test('panes: the desktop prefs keep them (the file and patches are cleaned; null forgets one)', () => {
  assert.deepEqual(DEFAULT_PREFS.panes, {});
  let p = mergePrefs(DEFAULT_PREFS, { panes: { 'side-panel': { size: 610 }, split: { size: 500.7, collapsed: false } } });
  assert.deepEqual(p.panes, { 'side-panel': { size: 610 }, split: { size: 501, collapsed: false } });
  p = mergePrefs(p, { panes: { 'side-panel': null, 'dashboards.inspector': { size: 400 } } });
  assert.deepEqual(p.panes, { split: { size: 501, collapsed: false }, 'dashboards.inspector': { size: 400 } }, 'null forgets a pane; the others stay');
  p = mergePrefs(p, { panes: { 'bad id!': { size: 3 }, x: { size: 'wide' }, y: 'nope', z: { size: 1e9 } } });
  assert.deepEqual(Object.keys(p.panes).sort(), ['dashboards.inspector', 'split'], 'bad ids and values are dropped');
  assert.equal(mergePrefs(DEFAULT_PREFS, { sidebar: { width: 9000 } }).sidebar.width, 480, 'the sidebar clamps as before');
});

test('panes: the handle is a focusable separator with its value, bounds, label and the pane it controls', async () => {
  const { ui, React, server } = await loadUi();
  const spec = { id: 'demo.list', title: 'list', default: 250, min: 180, max: 500 };
  const html = server.renderToString(React.createElement(ui.ResizablePane, { spec, edge: 'end', 'data-demo': '1', handle: { 'data-extra': 'x' } }, 'content'));
  assert.match(html, /role="separator"/);
  assert.match(html, /tabindex="0"/i);
  assert.match(html, /aria-orientation="vertical"/);
  assert.match(html, /aria-valuenow="250"/);
  assert.match(html, /aria-valuemin="180"/);
  assert.match(html, /aria-valuemax="500"/);
  assert.match(html, /aria-label="Resize the list"/);
  assert.match(html, /aria-controls="hx-pane-demo\.list"|aria-controls="hx-pane-demo-list"/);
  assert.match(html, /id="hx-pane-demo-list"/);
  assert.match(html, /data-resize-handle="demo.list"/);
  assert.match(html, /data-extra="x"/);
  assert.match(html, /data-demo="1"/);
  assert.match(html, /style="width:250px"/);
  assert.match(html, /double-click to reset/);
  // Saved in the store (here the default: localStorage-less memory), the pane draws its saved size; disabled, no handle.
  ui.paneStore().set('demo.list', { size: 333 });
  assert.match(server.renderToString(React.createElement(ui.ResizablePane, { spec, edge: 'end' }, 'c')), /style="width:333px"/);
  assert.doesNotMatch(server.renderToString(React.createElement(ui.ResizablePane, { spec, edge: 'end', disabled: true }, 'c')), /role="separator"/);
  // A row-resize pane.
  const y = server.renderToString(React.createElement(ui.ResizablePane, { spec: { id: 'demo.bottom', title: 'bottom panel', axis: 'y', default: 200, min: 100, max: 400 }, edge: 'start' }, 'c'));
  assert.match(y, /aria-orientation="horizontal"/);
  assert.match(y, /style="height:200px"/);
  assert.match(y, /data-axis="y"/);
  // Known to agents once registered.
  assert.ok(ui.paneSpecs().some((s: PaneSpec) => s.id === 'diagram.details'), 'the diagram details pane registers itself');
  ui.registerPane(spec);
  const d = ui.describePane(spec, vp);
  assert.deepEqual(d, { id: 'demo.list', title: 'list', axis: 'x', size: 333, min: 180, max: 500, default: 250, collapsible: false, onScreen: false });
  assert.equal(describePane(sidebar, vp).collapsed, false);
});

test('panes: the layout command lists, sets (clamped), resets, collapses and expands, over the prefs', async () => {
  // The desktop's layout module in Node: bundled with its aliases; the app store stands in for the window.
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hx-layout-')), 'layout.mjs');
  await build({
    stdin: { contents: "export * from './apps/desktop/renderer/src/state/layout.ts'; export { useApp } from './apps/desktop/renderer/src/state/app.ts';", resolveDir: root, loader: 'ts' },
    outfile: out, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', logLevel: 'silent', absWorkingDir: root,
    alias: { '@harness/ui': path.join(root, 'packages/ui/src/index.ts'), '@harness/plugin-ui': path.join(root, 'packages/plugin-ui/src/index.ts'), '@harness/client': path.join(root, 'packages/client/src/index.ts'), '@desk/prefs': path.join(root, 'apps/desktop/shared/prefs.ts'), '@desk/product': path.join(root, 'apps/desktop/shared/product.ts'), '@desk/grants': path.join(root, 'apps/desktop/shared/grants.ts') },
    external: ['react', 'react-dom', 'react/*', 'react-dom/*', 'zustand', 'zustand/*', 'mermaid', 'echarts', 'vega-embed', 'vega-interpreter', 'smiles-drawer', '@hpcc-js/wasm-graphviz', '3dmol'],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
  const local = path.join(root, 'node_modules', '.cache', `hx-layout-test-${process.pid}.mjs`);
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.copyFileSync(out, local);
  try {
    const m = await import(pathToFileURL(local).href);
    const app = m.useApp;
    const patches: unknown[] = [];
    // setPrefs as the window does it, without main: merged like main merges.
    app.setState({ setPrefs: (patch: Record<string, unknown>) => { patches.push(patch); app.setState({ prefs: mergePrefs(app.getState().prefs, patch) }); } });
    const list = m.layoutCommand({ action: 'list' }, vp) as { panes: Array<{ id: string; size: number; min: number; max: number; collapsible: boolean }> };
    const ids = list.panes.map((p) => p.id);
    for (const id of ['sidebar', 'side-panel', 'split', 'dashboards.inspector', 'dashboards.datasets', 'diagram.details']) assert.ok(ids.includes(id), `${id} is listed`);
    const sb = list.panes.find((p) => p.id === 'sidebar')!;
    assert.deepEqual([sb.size, sb.min, sb.max, sb.collapsible], [272, 200, 480, true]);
    assert.match(String(m.layoutCommand({ action: 'set', pane: 'side-panel', size: 600 }, vp)), /600px/);
    assert.deepEqual(app.getState().prefs.panes['side-panel'], { size: 600 });
    assert.match(String(m.layoutCommand({ action: 'set', pane: 'side-panel', size: 5000 }, vp)), /bounds in this window are 280-/, 'clamped, and says so');
    assert.equal(app.getState().prefs.panes['side-panel'].size, 1280 - 272 - 360);
    m.layoutCommand({ action: 'set', pane: 'sidebar', size: 333 }, vp);
    assert.equal(app.getState().prefs.sidebar.width, 333, 'the sidebar keeps its own prefs');
    m.layoutCommand({ action: 'collapse', pane: 'sidebar' }, vp);
    assert.equal(app.getState().prefs.sidebar.collapsed, true);
    m.layoutCommand({ action: 'expand', pane: 'sidebar' }, vp);
    assert.equal(app.getState().prefs.sidebar.collapsed, false);
    assert.equal(app.getState().prefs.sidebar.width, 333, 'expanding keeps the width');
    assert.throws(() => m.layoutCommand({ action: 'collapse', pane: 'side-panel' }, vp), /does not collapse/);
    assert.throws(() => m.layoutCommand({ action: 'set', pane: 'nope', size: 3 }, vp), /No pane "nope"\. Panes: .*\bsidebar, side-panel, split\b/);
    assert.throws(() => m.layoutCommand({ action: 'set', pane: 'split' }, vp), /needs size/);
    m.layoutCommand({ action: 'reset', pane: 'side-panel' }, vp);
    assert.equal(app.getState().prefs.panes['side-panel'], undefined, 'reset forgets it');
    m.layoutCommand({ action: 'set', pane: 'split', size: 500 }, vp);
    m.layoutCommand({ action: 'reset' }, vp);
    assert.deepEqual(app.getState().prefs.panes, {}, 'reset with no pane: all of them');
    assert.equal(app.getState().prefs.sidebar.width, 272);
    // The store follows the prefs.
    let seen = 0;
    const un = m.layoutStore.subscribe(() => seen++);
    m.layoutStore.set('dashboards.inspector', { size: 410 });
    assert.equal(seen, 1);
    assert.deepEqual(m.layoutStore.get('dashboards.inspector'), { size: 410 });
    un();
    assert.ok(patches.length > 5);
  } finally { try { fs.rmSync(local); } catch { /* gone */ } }
});
