// Science and BI fixtures: one message per renderer (maths, chemistry 2D and 3D, function plots,
// Graphviz, statistics figures, dashboards, tables, notebooks, maps), a kitchen sink using them all,
// and hostile inputs for each that must come out inert.
import { PNG_SMALL } from './rich.ts';

const fence = (lang: string, body: string) => `\`\`\`${lang}\n${body}\n\`\`\``;
const json = (v: unknown) => JSON.stringify(v);

/** A PDB ATOM record with its fixed columns. */
function atom(serial: number, name: string, res: string, seq: number, x: number, y: number, z: number, el: string): string {
  return `ATOM  ${String(serial).padStart(5)} ${name.padEnd(4)} ${res} A${String(seq).padStart(4)}    ${x.toFixed(3).padStart(8)}${y.toFixed(3).padStart(8)}${z.toFixed(3).padStart(8)}  1.00  0.00          ${el.padStart(2)}`;
}
/** Glycyl-alanine, roughly: a dipeptide small enough to draw as balls and sticks. */
export const PDB_GLY_ALA = [
  'HEADER    PEPTIDE                                 GLY-ALA',
  atom(1, ' N', 'GLY', 1, -1.195, 0.383, 0.000, 'N'),
  atom(2, ' CA', 'GLY', 1, 0.000, 1.207, 0.000, 'C'),
  atom(3, ' C', 'GLY', 1, 1.287, 0.398, 0.000, 'C'),
  atom(4, ' O', 'GLY', 1, 1.287, -0.832, 0.000, 'O'),
  atom(5, ' N', 'ALA', 2, 2.418, 1.096, 0.000, 'N'),
  atom(6, ' CA', 'ALA', 2, 3.737, 0.476, 0.000, 'C'),
  atom(7, ' C', 'ALA', 2, 4.811, 1.554, 0.000, 'C'),
  atom(8, ' O', 'ALA', 2, 4.544, 2.752, 0.000, 'O'),
  atom(9, ' CB', 'ALA', 2, 3.890, -0.380, 1.258, 'C'),
  atom(10, ' OXT', 'ALA', 2, 5.990, 1.183, 0.000, 'O'),
  'END',
].join('\n');

export const SDF_ETHANOL = `ethanol
  harness

  3  2  0  0  0  0  0  0  0  0999 V2000
    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    1.5200    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    2.0300    1.3400    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0
  1  2  1  0
  2  3  1  0
M  END
$$$$`;

const HIST_VALUES = [3.1, 4.2, 4.8, 5.0, 5.3, 5.5, 5.6, 5.9, 6.1, 6.2, 6.4, 6.6, 6.7, 7.0, 7.2, 7.5, 7.9, 8.4, 9.1, 9.8].map((v) => ({ v }));
const GROUPS = ['A', 'B', 'C'].flatMap((g, gi) => [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => ({ g, v: Math.round((10 + gi * 4 + Math.sin(i * (gi + 1)) * 3 + (i % 3)) * 10) / 10 })));
const SERIES = Array.from({ length: 24 }, (_, i) => ({ date: `2026-${String(Math.floor(i / 2) + 1).padStart(2, '0')}-${i % 2 ? '15' : '01'}`, value: Math.round(100 + i * 6 + Math.sin(i / 2) * 18) }));

export const SCIENCE: Record<string, string> = {
  maths: String.raw`Maxwell, a matrix, cases and an aligned derivation:

${fence('math', String.raw`\begin{aligned}
\nabla \cdot \boldsymbol{E} &= \frac{\rho}{\varepsilon_0} \\
\nabla \times \boldsymbol{B} &= \mu_0 \boldsymbol{J} + \mu_0 \varepsilon_0 \pdv{\boldsymbol{E}}{t}
\end{aligned}`)}

${fence('math', String.raw`A = \begin{pmatrix} 1 & 2 \\ 3 & 4 \end{pmatrix}, \quad \operatorname{tr}(A) = 5, \quad f(x) = \begin{cases} x^2 & x \ge 0 \\ -x & x < 0 \end{cases}`)}

Quantum and units: $\braket{\psi}{\phi}$, $\bra{0}H\ket{1}$, $\vb{F} = m\vb{a}$, $\dv{y}{x}$, $g = \SI{9.81}{m/s^2}$.

Chemistry: $\ce{2H2 + O2 -> 2H2O}$, $\ce{CO2 + H2O <=> H2CO3}$, $\ce{SO4^2-}$ and $\pu{25 mol/L}$.`,

  smiles: `Caffeine and aspirin:

${fence('smiles', 'CN1C=NC2=C1C(=O)N(C(=O)N2C)C caffeine\nCC(=O)OC1=CC=CC=C1C(=O)O aspirin')}`,

  molecule: `A dipeptide in 3D:

${fence('pdb', PDB_GLY_ALA)}

And ethanol from a molfile:

${fence('sdf', SDF_ETHANOL)}`,

  plot: `A damped oscillation and its envelope (drag to pan, Ctrl+wheel to zoom):

${fence('plot', json({ title: 'Damped oscillation', fns: [{ fn: 'exp(-x/4)*cos(2x)', label: 'e^(-x/4) cos 2x' }, { fn: 'exp(-x/4)', label: 'envelope' }, { fn: '-exp(-x/4)', label: '-envelope' }], domain: [0, 12] }))}

${fence('function-plot', 'tan(x)')}`,

  graphviz: `The build pipeline:

${fence('dot', `digraph pipeline {
  rankdir=LR; node [shape=box, style=rounded];
  subgraph cluster_ci { label="CI"; lint; test; build; }
  source -> lint -> test -> build -> deploy;
  test -> report [style=dashed];
}`)}`,

  stats: `A histogram, a violin, a regression and an annotated time series (Vega-Lite):

${fence('vega-lite', json({ title: 'Response times', data: { values: HIST_VALUES }, mark: 'bar', encoding: { x: { bin: { maxbins: 8 }, field: 'v', title: 'seconds' }, y: { aggregate: 'count', title: 'requests' } } }))}

${fence('vega-lite', json({ title: 'By group (violin)', data: { values: GROUPS }, transform: [{ density: 'v', groupby: ['g'], as: ['value', 'density'] }], mark: { type: 'area', orient: 'horizontal' }, width: 90, encoding: { column: { field: 'g', type: 'nominal' }, y: { field: 'value', type: 'quantitative' }, x: { field: 'density', type: 'quantitative', stack: 'center', axis: null }, color: { field: 'g', type: 'nominal', legend: null } } }))}

${fence('vega-lite', json({ title: 'Trend', data: { values: GROUPS.map((d, i) => ({ x: i, y: d.v })) }, layer: [{ mark: 'point', encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' } } }, { mark: { type: 'line', color: '#e34948' }, transform: [{ regression: 'y', on: 'x' }], encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' } } }] }))}

${fence('vega-lite', json({ title: 'Weekly active (annotated)', data: { values: SERIES }, layer: [{ mark: 'line', encoding: { x: { field: 'date', type: 'temporal' }, y: { field: 'value', type: 'quantitative' } } }, { data: { values: [{ date: '2026-06-01', note: 'v2 launch' }] }, layer: [{ mark: { type: 'rule', strokeDash: [4, 3] }, encoding: { x: { field: 'date', type: 'temporal' } } }, { mark: { type: 'text', dy: -110, align: 'left', dx: 4 }, encoding: { x: { field: 'date', type: 'temporal' }, text: { field: 'note' } } }] }] }))}

A box plot and a heatmap (ECharts):

${fence('chart', json({ title: { text: 'Latency by region' }, xAxis: { type: 'category', data: ['eu', 'us', 'ap'] }, yAxis: { type: 'value' }, series: [{ type: 'boxplot', data: [[120, 180, 210, 260, 340], [90, 150, 190, 230, 300], [140, 220, 260, 310, 420]] }] }))}

${fence('chart', json({ title: { text: 'Errors by hour' }, tooltip: {}, grid: { top: 40, bottom: 80 }, xAxis: { type: 'category', data: ['00', '04', '08', '12', '16', '20'] }, yAxis: { type: 'category', data: ['Mon', 'Tue', 'Wed'] }, visualMap: { min: 0, max: 10, calculable: true, orient: 'horizontal', left: 'center', bottom: 0 }, series: [{ type: 'heatmap', data: [[0, 0, 1], [1, 0, 3], [2, 0, 7], [3, 0, 9], [4, 0, 4], [5, 0, 2], [0, 1, 0], [1, 1, 2], [2, 1, 5], [3, 1, 8], [4, 1, 6], [5, 1, 1], [0, 2, 2], [1, 2, 1], [2, 2, 4], [3, 2, 10], [4, 2, 5], [5, 2, 3]] }] }))}`,

  table: `The orders (filter, sort, stats, pivot, export):

${fence('csv', `region,product,units,revenue
eu,widget,12,1440
eu,gadget,5,1250
us,widget,20,2400
us,gadget,9,2250
us,gizmo,3,1350
ap,widget,8,960
ap,gizmo,6,2700
eu,gizmo,2,900
ap,gadget,4,1000
us,widget,15,1800`)}`,

  dashboard: `The quarter at a glance:

${fence('dashboard', json({
    title: 'Q3 overview', subtitle: 'All regions, July to September', columns: 2,
    kpis: [
      { label: 'Revenue', value: '$1.24M', delta: '+17.8%', direction: 'up', series: [80, 92, 88, 101, 110, 124] },
      { label: 'Active users', value: 48210, delta: '+6.1%', direction: 'up', series: [40, 41, 43, 44, 46, 48] },
      { label: 'Churn', value: '2.1', unit: '%', delta: '-0.4 pt', direction: 'down', good: 'down' },
      { label: 'Tickets', value: 312, delta: 'flat', direction: 'flat' },
    ],
    panels: [
      { title: 'Revenue by month', kind: 'chart', spec: { xAxis: { type: 'category', data: ['Jul', 'Aug', 'Sep'] }, yAxis: { type: 'value' }, series: [{ type: 'bar', data: [380, 410, 450] }] } },
      { title: 'Signups trend', kind: 'viz', spec: { data: { values: SERIES.slice(0, 12) }, mark: 'area', encoding: { x: { field: 'date', type: 'temporal' }, y: { field: 'value', type: 'quantitative' } } } },
      { title: 'Top accounts', kind: 'table', spec: { columns: ['account', 'region', 'revenue'], rows: [['Acme', 'us', 120000], ['Globex', 'eu', 98000], ['Initech', 'ap', 87000]] } },
      { title: 'Notes', kind: 'markdown', spec: '- Revenue up in **every** region\n- Churn below target for the 2nd quarter' },
      { title: 'Forecast', kind: 'plot', spec: { fn: '1.24*exp(0.05x)', domain: [0, 12] }, note: 'Model: 5% monthly growth' },
      { title: 'Offices', kind: 'map', spec: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'London' }, geometry: { type: 'Point', coordinates: [-0.12, 51.5] } }, { type: 'Feature', properties: { name: 'New York' }, geometry: { type: 'Point', coordinates: [-74, 40.7] } }, { type: 'Feature', properties: { name: 'Singapore' }, geometry: { type: 'Point', coordinates: [103.8, 1.35] } }] } },
    ],
  }, ))}`,

  notebook: `The analysis notebook:

${fence('ipynb', json({
    nbformat: 4, nbformat_minor: 5, metadata: { language_info: { name: 'python' } },
    cells: [
      { cell_type: 'markdown', metadata: {}, source: ['# Sales analysis\n', 'Load the data and **summarise** it.'] },
      { cell_type: 'code', execution_count: 1, metadata: {}, source: ['import pandas as pd\n', 'df = pd.read_csv("orders.csv")\n', 'print(len(df))'], outputs: [{ output_type: 'stream', name: 'stdout', text: ['10\n'] }] },
      { cell_type: 'code', execution_count: 2, metadata: {}, source: ['df.groupby("region").revenue.sum()'], outputs: [{ output_type: 'execute_result', execution_count: 2, metadata: {}, data: { 'text/html': ['<table><tr><th>region</th><th>revenue</th></tr><tr><td>eu</td><td>3590</td></tr><tr><td>us</td><td>7800</td></tr></table>'], 'text/plain': ['region\neu 3590\nus 7800'] } }] },
      { cell_type: 'code', execution_count: 3, metadata: {}, source: ['df.plot()'], outputs: [{ output_type: 'display_data', metadata: {}, data: { 'image/png': PNG_SMALL } }] },
      { cell_type: 'code', execution_count: 4, metadata: {}, source: ['1 / 0'], outputs: [{ output_type: 'error', ename: 'ZeroDivisionError', evalue: 'division by zero', traceback: ['\u001b[31mZeroDivisionError\u001b[0m: division by zero'] }] },
    ],
  }))}`,

  geojson: `Where the routes run:

${fence('geojson', json({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { name: 'Service area', fill: '#2a78d633' }, geometry: { type: 'Polygon', coordinates: [[[-5, 50], [2, 50], [2, 55], [-5, 55], [-5, 50]]] } },
      { type: 'Feature', properties: { name: 'Route 1', stroke: '#eb6834' }, geometry: { type: 'LineString', coordinates: [[-3, 51], [-1, 52.5], [0.5, 53.5], [1.2, 54.5]] } },
      { type: 'Feature', properties: { name: 'Depot' }, geometry: { type: 'Point', coordinates: [-3, 51] } },
      { type: 'Feature', properties: { name: 'Hub' }, geometry: { type: 'Point', coordinates: [1.2, 54.5] } },
    ],
  }))}`,

  diagram: `The architecture (interactive diagrams come with a plugin):

${fence('diagram', json({ title: 'Checkout service', nodes: [{ id: 'web', label: 'Web' }, { id: 'api', label: 'API' }, { id: 'db', label: 'Postgres' }], edges: [{ from: 'web', to: 'api' }, { from: 'api', to: 'db' }] }))}`,
};

export const SCIENCE_KITCHEN_SINK = [
  '# Science & BI kitchen sink',
  'Every science and BI renderer, in one reply.',
  SCIENCE.maths, SCIENCE.smiles, SCIENCE.molecule, SCIENCE.plot, SCIENCE.graphviz, SCIENCE.stats, SCIENCE.table, SCIENCE.dashboard, SCIENCE.notebook, SCIENCE.geojson, SCIENCE.diagram,
  '**End of the sink.**',
].join('\n\n');

/** Hostile input per renderer: every one must come out inert (an error state or plain text). */
export const SCIENCE_HOSTILE: Record<string, string> = {
  smiles: 'C1CC<script>alert("xss-smiles")</script>',
  vegaUrl: json({ data: { url: 'https://evil.example/data.json' }, mark: 'point' }),
  vegaExpr: json({ data: { values: [{ a: 1 }] }, transform: [{ calculate: "constructor.constructor('alert(1)')()", as: 'b' }], mark: 'point' }),
  plotCode: json({ fn: "constructor.constructor('alert(\"xss-plot\")')()" }),
  plotGlobal: 'window.alert(1)',
  dotImage: 'digraph { a [image="C:/Windows/win.ini"]; a -> b }',
  dotLink: 'digraph { a [URL="javascript:alert(\'xss-dot\')", label="click"]; a -> b }',
  geojson: json({ type: 'Feature', properties: { name: '<img src=x onerror=alert("xss-geo")>', fill: 'url(javascript:alert(1))' }, geometry: { type: 'Point', coordinates: [0, 0] } }),
  notebook: json({ nbformat: 4, metadata: {}, cells: [{ cell_type: 'markdown', source: '<script>alert("xss-nb-md")</script> [x](javascript:alert(1))' }, { cell_type: 'code', source: 'x', outputs: [{ output_type: 'display_data', data: { 'text/html': '<script>parent.alert("xss-nb-html")</script><b>bold</b>', 'application/javascript': 'alert("xss-nb-js")' } }] }] }),
  pdb: `${PDB_GLY_ALA}\n</script><script>alert("xss-pdb")</script>`,
  dashboard: json({ panels: [{ kind: 'html', spec: '<script>alert(1)</script>' }] }),
  diagram: '{"title":"<img src=x onerror=alert(\'xss-diagram\')>","nodes":[]}',
};
