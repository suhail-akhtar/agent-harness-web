/**
 * What a fenced block becomes, by its language. One table, read by the Markdown renderer (to pick
 * a component) and by the tests (to check every kind renders). A plugin renderer for a fence
 * language replaces the default for that language (the host passes `renderFence`).
 */

export type FenceKind = 'chart' | 'viz' | 'mermaid' | 'diagram' | 'math' | 'table' | 'csv' | 'tsv' | 'json' | 'html' | 'svg' | 'react' | 'diff'
  | 'plot' | 'graphviz' | 'smiles' | 'molecule' | 'geojson' | 'notebook' | 'dashboard' | 'code';

const BY_LANG: Record<string, FenceKind> = {
  chart: 'chart', echarts: 'chart',
  viz: 'viz', vega: 'viz', vegalite: 'viz', 'vega-lite': 'viz',
  mermaid: 'mermaid',
  // Reserved for the interactive architecture and flow diagrams (DESIGN section 16, the core.diagrams plugin).
  diagram: 'diagram',
  math: 'math', latex: 'math', tex: 'math', katex: 'math',
  table: 'table', datatable: 'table',
  csv: 'csv', tsv: 'tsv',
  json: 'json', jsonc: 'json',
  html: 'html', htm: 'html',
  svg: 'svg',
  jsx: 'react', tsx: 'react', react: 'react',
  diff: 'diff', patch: 'diff',
  plot: 'plot', 'function-plot': 'plot',
  dot: 'graphviz', graphviz: 'graphviz', gv: 'graphviz',
  smiles: 'smiles',
  pdb: 'molecule', sdf: 'molecule', mol: 'molecule', mol2: 'molecule', xyz: 'molecule', cif: 'molecule',
  geojson: 'geojson',
  ipynb: 'notebook', notebook: 'notebook',
  dashboard: 'dashboard',
};

/** Every fence language with a renderer of its own (for the client descriptor a session is told about). */
export function fenceLanguages(): string[] { return Object.keys(BY_LANG); }

/** The kind for a fence language (`code` for plain highlighted code). */
export function fenceKind(lang: string, source = ''): FenceKind {
  const l = lang.trim().toLowerCase();
  const k = BY_LANG[l];
  if (k === 'react') {
    // A JSX snippet is code unless it is a component to mount (an artifact).
    return /export\s+default\b/.test(source) ? 'react' : 'code';
  }
  if (k === 'json') {
    // Small JSON reads better as code; large or nested JSON gets the tree.
    return source.length > 160 || /\n\s{2,}[{["]/.test(source) ? 'json' : 'code';
  }
  return k ?? 'code';
}

/** The kinds drawn inside the shared widget frame (copy, download, expand, hide, error state). */
export const FRAMED: ReadonlySet<FenceKind> = new Set(['chart', 'viz', 'mermaid', 'math', 'table', 'csv', 'tsv', 'json', 'plot', 'graphviz', 'smiles', 'molecule', 'geojson', 'notebook', 'dashboard']);

/** The short list a session is told about: one name per kind (the client declaration stays small). */
export const DECLARED_FENCES = ['mermaid', 'chart', 'vega-lite', 'math', 'table', 'csv', 'json', 'html', 'svg', 'jsx', 'diff', 'diagram', 'plot', 'dot', 'smiles', 'pdb', 'sdf', 'geojson', 'ipynb', 'dashboard'] as const;

/** File extension for a kind's download. */
export function extensionFor(kind: FenceKind, lang: string): string {
  switch (kind) {
    case 'chart': case 'viz': case 'table': case 'json': return 'json';
    case 'mermaid': return 'mmd';
    case 'diagram': return 'json';
    case 'math': return 'tex';
    case 'csv': return 'csv';
    case 'tsv': return 'tsv';
    case 'html': return 'html';
    case 'svg': return 'svg';
    case 'react': return lang === 'tsx' ? 'tsx' : 'jsx';
    case 'diff': return 'diff';
    case 'plot': case 'dashboard': return 'json';
    case 'graphviz': return 'dot';
    case 'smiles': return 'smi';
    case 'molecule': return ['pdb', 'sdf', 'mol', 'mol2', 'xyz', 'cif'].includes(lang.toLowerCase()) ? lang.toLowerCase() : 'pdb';
    case 'geojson': return 'geojson';
    case 'notebook': return 'ipynb';
    default: return lang || 'txt';
  }
}
