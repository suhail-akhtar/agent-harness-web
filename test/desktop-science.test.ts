// Science and BI renderers of packages/ui, in Node: maths (KaTeX with mhchem and physics macros),
// function plots, Graphviz (the real wasm build), SMILES, 3D molecules, maps, notebooks, dashboards,
// tables with stats, pivot and CSV export, and the reserved `diagram` kind. Each with hostile input.
// (WebGL, smiles-drawer and the live figures need a browser: the desktop e2e test checks those.)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import katex from 'katex';
import 'katex/contrib/mhchem';
import { Graphviz } from '@hpcc-js/wasm-graphviz';
import { loadUi, renderAll } from './fixtures/desktop/load-ui.ts';
import { SCIENCE, SCIENCE_HOSTILE, SCIENCE_KITCHEN_SINK, PDB_GLY_ALA } from './fixtures/desktop/science.ts';
import { validateDashboard } from '../packages/plugin-ui/src/index.ts';

const fenceBody = (text: string, lang: string) => text.split(`\`\`\`${lang}\n`)[1]!.split('\n```')[0]!;

test('fences: every science and BI language has its renderer; the declaration a session gets is short', async () => {
  const { ui } = await loadUi();
  const kinds: Record<string, string> = { plot: 'plot', 'function-plot': 'plot', dot: 'graphviz', graphviz: 'graphviz', smiles: 'smiles', pdb: 'molecule', sdf: 'molecule', mol: 'molecule', xyz: 'molecule', geojson: 'geojson', ipynb: 'notebook', dashboard: 'dashboard', mermaid: 'mermaid', diagram: 'diagram' };
  for (const [lang, kind] of Object.entries(kinds)) assert.equal(ui.fenceKind(lang), kind, lang);
  const declared = (ui.DECLARED_FENCES as string[]).join(',');
  assert.ok(declared.length < 400, `the fence list stays well under 150 tokens (${declared.length} chars)`);
  for (const l of ['plot', 'dot', 'smiles', 'pdb', 'geojson', 'ipynb', 'dashboard', 'diagram']) assert.ok(declared.split(',').includes(l), l);
});

test('maths: environments, \\operatorname, \\boldsymbol, mhchem \\ce and \\pu, physics macros all set without an error', async () => {
  const { ui, React } = await loadUi();
  const opts = { displayMode: true, throwOnError: true, strict: false, trust: false, macros: { ...ui.KATEX_MACROS } };
  for (const tex of [
    String.raw`\begin{aligned} a &= b \\ c &= d \end{aligned}`, String.raw`\begin{pmatrix} 1 & 2 \\ 3 & 4 \end{pmatrix}`, String.raw`\begin{cases} x & x>0 \\ 0 & \text{else} \end{cases}`,
    String.raw`\operatorname{tr}(A)`, String.raw`\boldsymbol{E}`, String.raw`\ce{2H2 + O2 -> 2H2O}`, String.raw`\ce{SO4^2-}`, String.raw`\pu{25 mol/L}`,
    String.raw`\braket{\psi}{\phi}`, String.raw`\bra{0}H\ket{1}`, String.raw`\vb{F}`, String.raw`\dv{y}{x}`, String.raw`\pdv{f}{t}`, String.raw`\SI{9.81}{m/s^2}`, String.raw`\vec{v}`,
  ]) assert.doesNotThrow(() => katex.renderToString(tex, opts), tex);
  assert.match(katex.renderToString(String.raw`\ce{H2O}`, opts), /mord/);
  // Inline maths in prose goes through rehype-katex with the same macros and mhchem.
  const { html, errors } = await renderAll(React.createElement(ui.Markdown, { text: SCIENCE.maths }));
  assert.deepEqual(errors, []);
  assert.ok((html.match(/class="katex"/g) ?? []).length >= 8);
  assert.doesNotMatch(html, /katex-error/, 'every inline formula parsed (\\ce, \\pu, \\braket, \\vb, \\dv, \\SI)');
  // trust: false: no URL or HTML from a formula.
  assert.doesNotMatch(katex.renderToString(String.raw`\href{https://example.com}{x}`, opts), /<a\b/, 'no links at all from a formula');
  assert.doesNotMatch(katex.renderToString(String.raw`\href{javascript:alert(1)}{x}`, { ...opts, throwOnError: false }), /href="javascript/);
});

test('function plots: a safe expression language (no code), sampling across asymptotes, the plot drawn as SVG', async () => {
  const { ui, React } = await loadUi();
  const e = ui.parseExpr('2x^2 + 3sin(x) - e');
  assert.ok(Math.abs(ui.evaluate(e, 1) - (2 + 3 * Math.sin(1) - Math.E)) < 1e-9);
  assert.equal(ui.evaluate(ui.parseExpr('(x+1)(x-1)'), 3), 8, 'implicit multiplication');
  assert.equal(ui.evaluate(ui.parseExpr('-2^2'), 0), -4);
  const tan = ui.sample(ui.parseExpr('tan(x)'), [-5, 5], 400);
  assert.ok(tan.length >= 3, 'tan breaks at its asymptotes');
  for (const bad of [SCIENCE_HOSTILE.plotCode!, SCIENCE_HOSTILE.plotGlobal!, '{"fn":"x.constructor"}', '{"fn":"process.exit(1)"}', '{"fn":"[].map"}']) {
    assert.ok(ui.parsePlotSpec(bad).error, `refused: ${bad}`);
  }
  const { html, errors } = await renderAll(React.createElement(ui.FunctionPlot, { source: fenceBody(SCIENCE.plot!, 'plot') }));
  assert.deepEqual(errors, []);
  assert.match(html, /data-fplot/);
  assert.equal(new Set([...html.matchAll(/data-fn="(\d)"/g)].map((m) => m[1])).size, 3, 'three functions drawn');
  assert.match(html, /Damped oscillation/);
  assert.match(html, /aria-label="Zoom in"/);
  const bad = await renderAll(React.createElement(ui.FunctionPlot, { source: SCIENCE_HOSTILE.plotCode }));
  assert.ok(bad.errors.length, 'a hostile plot is an error, not a drawing');
});

test('graphviz: the wasm build lays the graph out; files are refused; links and scripts are scrubbed', async () => {
  const { ui } = await loadUi();
  const gv = await Graphviz.load();
  const svg = ui.cleanGraphSvg(gv.dot(fenceBody(SCIENCE.graphviz!, 'dot'), 'svg'));
  assert.match(svg, /^<svg/);
  assert.match(svg, /cluster_ci/);
  assert.match(svg, />deploy</);
  assert.match(ui.checkDot(SCIENCE_HOSTILE.dotImage), /not allowed/);
  assert.equal(ui.checkDot(SCIENCE_HOSTILE.dotLink), undefined);
  const linked = ui.cleanGraphSvg(gv.dot(SCIENCE_HOSTILE.dotLink!, 'svg'));
  assert.doesNotMatch(linked, /javascript:|href=/i);
  assert.match(linked, />click</);
  assert.doesNotMatch(ui.cleanGraphSvg('<svg><script>alert(1)</script><g onclick="alert(2)"><text>x</text></g></svg>'), /script|onclick/);
});

test('SMILES: a strict alphabet; hostile strings are an error, never markup', async () => {
  const { ui, React } = await loadUi();
  assert.ok(ui.SMILES.test('CN1C=NC2=C1C(=O)N(C(=O)N2C)C'));
  assert.ok(ui.SMILES.test('C[C@@H](N)C(=O)O'));
  assert.ok(!ui.SMILES.test(SCIENCE_HOSTILE.smiles));
  const ok = await renderAll(React.createElement(ui.SmilesView, { source: fenceBody(SCIENCE.smiles!, 'smiles') }));
  assert.deepEqual(ok.errors, []);
  assert.equal((ok.html.match(/<figure/g) ?? []).length, 2);
  assert.match(ok.html, /aria-label="Structure of caffeine"/);
  const bad = await renderAll(React.createElement(ui.SmilesView, { source: SCIENCE_HOSTILE.smiles }));
  assert.match(bad.errors.join(), /not a SMILES string/);
  assert.doesNotMatch(bad.html, /<script/);
});

test('3D molecules: the structure travels base64 into a no-network page, framed without same-origin', async () => {
  const { ui, React } = await loadUi();
  const doc = ui.moleculeDocument(SCIENCE_HOSTILE.pdb, 'pdb', 'harness://preview/runtime/artifact-runtime.js');
  assert.match(doc, /<script src="harness:\/\/preview\/runtime\/3Dmol-min.js"><\/script>/);
  assert.match(doc, /connect-src 'none'/);
  assert.doesNotMatch(doc, /xss-pdb/, 'the file never appears as markup');
  const b64 = /data-b64="([^"]+)"/.exec(doc)![1]!;
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), SCIENCE_HOSTILE.pdb);
  assert.match(ui.moleculeDocument(PDB_GLY_ALA, '<img>'), /data-format="pdb"/, 'an unknown format falls back to pdb');
  const { html, errors } = await renderAll(React.createElement(ui.Molecule3D, { source: PDB_GLY_ALA, format: 'pdb' }));
  assert.deepEqual(errors, []);
  assert.match(html, /data-artifact-frame="molecule"/);
  assert.match(html, /sandbox="allow-scripts"/);
  assert.doesNotMatch(html, /allow-same-origin/);
});

test('GeoJSON maps: projected to SVG with no tiles; names are text, colours only hex', async () => {
  const { ui, React } = await loadUi();
  const parsed = ui.parseGeoJson(fenceBody(SCIENCE.geojson!, 'geojson'));
  const m = ui.layoutMap(parsed.features, 640, 380);
  assert.equal(m.features, 4);
  assert.equal(m.shapes.length, 2);
  assert.equal(m.points.length, 2);
  for (const p of m.points) assert.ok(p.x >= 0 && p.x <= 640 && p.y >= 0 && p.y <= 380);
  assert.match(ui.parseGeoJson('{"type":"Nope"}').error, /no features/);
  const { html, errors } = await renderAll(React.createElement(ui.GeoMap, { source: SCIENCE_HOSTILE.geojson }));
  assert.deepEqual(errors, []);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror/);
  assert.doesNotMatch(html, /(fill|stroke|href)="[^"]*javascript/, 'a colour is hex or nothing');
  assert.doesNotMatch(html, /tile|openstreetmap/i, 'no map tiles');
});

test('notebooks: cells and outputs; HTML outputs in a script-less frame; markdown stays inert', async () => {
  const { ui, React } = await loadUi();
  const nb = ui.parseNotebook(fenceBody(SCIENCE.notebook!, 'ipynb')).nb;
  assert.equal(nb.language, 'python');
  assert.deepEqual(nb.cells.map((c: { kind: string }) => c.kind), ['markdown', 'code', 'code', 'code', 'code']);
  assert.deepEqual(nb.cells.flatMap((c: { outputs: Array<{ kind: string }> }) => c.outputs.map((o) => o.kind)), ['text', 'html', 'image', 'error']);
  assert.doesNotMatch(nb.cells[4].outputs[0].traceback, /\u001b/, 'ANSI codes stripped');
  const md = (t: string) => React.createElement(ui.Markdown, { text: t });
  const ok = await renderAll(React.createElement(ui.NotebookView, { source: fenceBody(SCIENCE.notebook!, 'ipynb'), renderMarkdown: md }));
  assert.deepEqual(ok.errors, []);
  assert.match(ok.html, /data-notebook="5"/);
  assert.match(ok.html, /\[1\]/);
  assert.match(ok.html, /ZeroDivisionError/);
  assert.match(ok.html, /<img src="data:image\/png;base64,/);
  const bad = await renderAll(React.createElement(ui.NotebookView, { source: SCIENCE_HOSTILE.notebook, renderMarkdown: md }));
  assert.deepEqual(bad.errors, []);
  assert.doesNotMatch(bad.html, /<script/i, 'no live script anywhere in the transcript');
  assert.match(bad.html, /&lt;script&gt;alert\(&quot;xss-nb-md/, 'a markdown cell shows raw HTML as text');
  assert.doesNotMatch(bad.html, /xss-nb-js/, 'JavaScript outputs are dropped');
  // HTML outputs are sanitized into the page (it sizes itself; no frame to measure): the table stays, the script goes.
  assert.match(ok.html, /data-notebook-html[^>]*><table><tr><th>region<\/th>/);
  assert.doesNotMatch(bad.html, /xss-nb-html/, 'a script in an HTML output is dropped with its content');
  assert.match(bad.html, /data-notebook-html[^>]*><b>bold<\/b>/);
  assert.equal(/<iframe[^>]*notebook-html/.test(bad.html), false, 'no frame for notebook HTML');
});

test('the HTML sanitizer: allowlisted tags and attributes rebuilt, everything active dropped', async () => {
  const { ui } = await loadUi();
  const s = ui.sanitizeHtml as (h: string) => string;
  assert.equal(s('<table border="1" class="dataframe"><thead><tr style="text-align: right;"><th>a</th></tr></thead><tbody><tr><td colspan="2">1 &amp; 2</td></tr></tbody></table>'), '<table border="1"><thead><tr><th>a</th></tr></thead><tbody><tr><td colspan="2">1 &amp; 2</td></tr></tbody></table>');
  assert.equal(s('<b onclick="alert(1)">x</b><img src="javascript:alert(1)" onerror="alert(2)"><img src="data:image/png;base64,AAAA" alt="ok">'), '<b>x</b><img><img src="data:image/png;base64,AAAA" alt="ok">');
  assert.equal(s('<style>body{display:none}</style><script>alert(1)</script><svg onload=alert(1)><circle/></svg>after'), 'after');
  assert.equal(s('<a href="javascript:alert(1)">link</a> <iframe src="x"></iframe><p>a < b</p>'), 'link <p>a &lt; b</p>');
  assert.equal(s('<div><span>open'), '<div><span>open</span></div>', 'what is left open is closed');
  assert.equal(s('<td>"q" <x>'), '<td>&quot;q&quot; </td>');
  assert.equal(s('<scr<script>ipt>alert(1)</script>ok'), '&lt;scrok');
  assert.equal(s('<!-- c --><p title="x">t</p>'), '<p>t</p>');
});

test('Graphviz SVG takes the theme: a transparent page, lines and text in the text colour, filled nodes kept readable', async () => {
  const { ui } = await loadUi();
  const svg = '<svg><g id="graph0" class="graph"><title>G</title><polygon fill="white" stroke="none" points="0,0"/><g id="node1" class="node"><title>a</title><ellipse fill="none" stroke="black" cx="1"/><text text-anchor="middle">a</text></g><g id="node2" class="node"><title>b</title><polygon fill="lightblue" stroke="black" points="0,0"/><text text-anchor="middle">b</text></g><g id="edge1" class="edge"><title>a->b</title><path fill="none" stroke="black" d="M0,0"/><polygon fill="black" stroke="black" points="0,0"/></g><text>label</text></g></svg>';
  const out = ui.themeGraphSvg(svg) as string;
  assert.match(out, /class="graph"><title>G<\/title><polygon fill="none"/, 'the page is transparent');
  assert.doesNotMatch(out, /"black"/, 'no black left');
  assert.match(out, /<ellipse fill="none" stroke="currentColor"[^>]*\/><text fill="currentColor"/, 'an unfilled node: text in the theme colour');
  assert.match(out, /<polygon fill="lightblue" stroke="currentColor"[^>]*\/><text fill="#1f1e1c" text-anchor/, 'a node the graph filled keeps dark text');
  assert.match(out, /<polygon fill="currentColor" stroke="currentColor"/, 'arrowheads');
  assert.match(out, /<text fill="currentColor">label/, 'graph labels');
});

test('dashboards: the shared spec validates with exact errors; KPIs and every panel kind are laid out', async () => {
  const { ui, React } = await loadUi();
  const spec = JSON.parse(fenceBody(SCIENCE.dashboard!, 'dashboard'));
  assert.ok(validateDashboard(spec).spec);
  assert.match(validateDashboard(JSON.parse(SCIENCE_HOSTILE.dashboard!)).error!, /kind "html": use one of chart, viz, table, markdown, plot, map/);
  assert.match(validateDashboard({ panels: [] }).error!, /no "panels"/);
  assert.match(validateDashboard({ panels: [{ kind: 'chart' }] }).error!, /no "spec"/);
  assert.match(validateDashboard({ kpis: [{ label: 'x' }], panels: [{ kind: 'markdown', spec: 'x' }] }).error!, /KPI 1 needs/);
  const { html, errors } = await renderAll(React.createElement(ui.Dashboard, { source: JSON.stringify(spec), renderMarkdown: (t: string) => React.createElement(ui.Markdown, { text: t }) }));
  assert.deepEqual(errors, []);
  assert.equal((html.match(/data-kpi/g) ?? []).length, 4);
  for (const k of ['chart', 'viz', 'table', 'markdown', 'plot', 'map']) assert.match(html, new RegExp(`data-panel="${k}"`), k);
  assert.match(html, /Q3 overview/);
  assert.match(html, /<strong>every<\/strong>/);
  assert.match(html, /text-hx-success/, 'churn down is good');
});

test('tables: filter, median and std, pivot, CSV export without formula injection', async () => {
  const { ui, React } = await loadUi();
  const spec = ui.parseDelimited(fenceBody(SCIENCE.table!, 'csv'));
  assert.equal(ui.filterRows(spec, 'gizmo').length, 3);
  assert.equal(ui.filterRows(spec, 'EU', 0).length, 3);
  const s = ui.summarise(spec, 2);
  assert.equal(s.count, 10);
  assert.equal(s.median, 7);
  assert.ok(Math.abs(s.std - 5.758) < 0.01, `sample std ${s.std}`);
  const p = ui.pivot(spec, { rows: 0, cols: 1, values: 3, aggregate: 'sum' });
  assert.deepEqual(p.columns, ['region', 'gadget', 'gizmo', 'widget']);
  assert.deepEqual(p.rows.find((r: unknown[]) => r[0] === 'us'), ['us', 2250, 1350, 4200]);
  assert.deepEqual(ui.pivot(spec, { rows: 0, aggregate: 'count' }).rows, [['ap', 3], ['eu', 3], ['us', 4]]);
  const csv = ui.toCsv({ columns: ['a', 'b'], rows: [['=HYPERLINK("x")', -5], ['say "hi", ok', '+1'], ['@SUM(A1)', null]] });
  assert.equal(csv, `a,b\r\n"'=HYPERLINK(""x"")",-5\r\n"say ""hi"", ok",+1\r\n'@SUM(A1),`);
  const { html, errors } = await renderAll(React.createElement(ui.DataTable, { source: fenceBody(SCIENCE.table!, 'csv'), format: 'csv' }));
  assert.deepEqual(errors, []);
  assert.match(html, /data-table-filter/);
  assert.match(html, />Stats</);
  assert.match(html, />Pivot</);
  assert.match(html, />Export CSV</);
});

test('diagram: drawn (a static picture with "Open interactive"); a plugin renderer for the kind replaces it', async () => {
  const { ui, React } = await loadUi();
  const { html, errors } = await renderAll(React.createElement(ui.Markdown, { text: SCIENCE.diagram }));
  assert.deepEqual(errors, []);
  assert.match(html, /data-artifact="diagram"/);
  assert.match(html, /data-diagram-block="container"/);
  assert.match(html, /data-diagram-svg/);
  assert.match(html, /Open interactive/);
  assert.match(html, /Checkout service/);
  const bad = await renderAll(React.createElement(ui.Markdown, { text: `\`\`\`diagram\n${SCIENCE_HOSTILE.diagram}\n\`\`\`` }));
  assert.doesNotMatch(bad.html, /<img/);
  // A host renderer for the artifact kind replaces the placeholder (what the plugin will contribute).
  ui.setArtifactHost({ useRenderer: () => (kind: string, source: string) => (kind === 'diagram' ? React.createElement('div', { 'data-custom-diagram': JSON.parse(source).nodes.length }) : undefined) });
  try {
    const custom = await renderAll(React.createElement(ui.Markdown, { text: SCIENCE.diagram }));
    assert.match(custom.html, /data-custom-diagram="3"/);
    assert.doesNotMatch(custom.html, /data-diagram-svg/);
  } finally { ui.setArtifactHost({}); }
});

test('science & BI kitchen sink: every block renders through Markdown, lazily, without an error', async () => {
  const { ui, React } = await loadUi();
  const { html, errors } = await renderAll(React.createElement(ui.Markdown, { text: SCIENCE_KITCHEN_SINK }));
  assert.deepEqual(errors, []);
  for (const marker of ['class="katex"', 'data-widget="Structure"', 'data-widget="3D structure"', 'data-widget="Plot"', 'data-widget="Graph"', 'data-widget="Figure"', 'data-widget="Chart"', 'data-widget="CSV"', 'data-widget="Dashboard"', 'data-widget="Notebook"', 'data-widget="Map"', 'data-artifact="diagram"', 'data-fplot', 'data-dashboard', 'data-notebook', 'data-geomap', 'data-smiles', 'data-artifact-frame="molecule"']) {
    assert.ok(html.includes(marker), `kitchen sink has ${marker}`);
  }
  assert.doesNotMatch(html, /data-render-error/);
});
