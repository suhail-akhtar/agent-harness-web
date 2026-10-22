/**
 * What a fenced block becomes, by its language. One table, read by the Markdown renderer (to pick
 * a component) and by the tests (to check every kind renders). A plugin renderer for a fence
 * language replaces the default for that language (the host passes `renderFence`).
 */

export type FenceKind = 'chart' | 'viz' | 'diagram' | 'math' | 'table' | 'csv' | 'tsv' | 'json' | 'html' | 'svg' | 'react' | 'diff' | 'code';

const BY_LANG: Record<string, FenceKind> = {
  chart: 'chart', echarts: 'chart',
  viz: 'viz', vega: 'viz', vegalite: 'viz', 'vega-lite': 'viz',
  mermaid: 'diagram', diagram: 'diagram',
  math: 'math', latex: 'math', tex: 'math', katex: 'math',
  table: 'table', datatable: 'table',
  csv: 'csv', tsv: 'tsv',
  json: 'json', jsonc: 'json',
  html: 'html', htm: 'html',
  svg: 'svg',
  jsx: 'react', tsx: 'react', react: 'react',
  diff: 'diff', patch: 'diff',
};

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
export const FRAMED: ReadonlySet<FenceKind> = new Set(['chart', 'viz', 'diagram', 'math', 'table', 'csv', 'tsv', 'json']);

/** File extension for a kind's download. */
export function extensionFor(kind: FenceKind, lang: string): string {
  switch (kind) {
    case 'chart': case 'viz': case 'table': case 'json': return 'json';
    case 'diagram': return 'mmd';
    case 'math': return 'tex';
    case 'csv': return 'csv';
    case 'tsv': return 'tsv';
    case 'html': return 'html';
    case 'svg': return 'svg';
    case 'react': return lang === 'tsx' ? 'tsx' : 'jsx';
    case 'diff': return 'diff';
    default: return lang || 'txt';
  }
}
