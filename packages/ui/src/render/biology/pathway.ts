/**
 * Pathways and biological networks: ```pathway blocks of JSON
 *   {"title": "Insulin signalling", "direction": "TB",
 *    "nodes": [{"id": "INS", "label": "Insulin", "type": "protein"}, {"id": "PIP3", "type": "metabolite"}],
 *    "edges": [{"from": "INS", "to": "INSR", "type": "binding"}, {"from": "AKT", "to": "GSK3B", "type": "inhibition"}]}
 * Node types: gene, protein, metabolite, complex, phenotype, drug. Edge types: activation,
 * inhibition, binding, conversion, catalysis. Drawn with simplified SBGN-like glyphs and laid out
 * by Graphviz (the wasm build the ```dot renderer already loads). The DOT is generated here: ids
 * are ours (n0, n1...), labels are escaped, so nothing in the spec reaches Graphviz as syntax. Pure.
 */

import { LIMITS, checkSize, isObj, parseJson, text, tooLarge } from './common.ts';

export const NODE_TYPES = ['gene', 'protein', 'metabolite', 'complex', 'phenotype', 'drug'] as const;
export const EDGE_TYPES = ['activation', 'inhibition', 'binding', 'conversion', 'catalysis'] as const;
export type NodeType = typeof NODE_TYPES[number];
export type EdgeType = typeof EDGE_TYPES[number];
export interface PathwayNode { id: string; label: string; type: NodeType }
export interface PathwayEdge { from: string; to: string; type: EdgeType; label: string }
export interface Pathway { title: string; direction: 'TB' | 'LR'; nodes: PathwayNode[]; edges: PathwayEdge[]; notes: string[] }

const NODE_ALIAS: Record<string, NodeType> = { gene: 'gene', dna: 'gene', rna: 'gene', mrna: 'gene', protein: 'protein', enzyme: 'protein', receptor: 'protein', kinase: 'protein', macromolecule: 'protein', metabolite: 'metabolite', compound: 'metabolite', 'small molecule': 'metabolite', chemical: 'metabolite', complex: 'complex', phenotype: 'phenotype', process: 'phenotype', drug: 'drug', inhibitor: 'drug' };
const EDGE_ALIAS: Record<string, EdgeType> = { activation: 'activation', activates: 'activation', stimulation: 'activation', 'positive': 'activation', inhibition: 'inhibition', inhibits: 'inhibition', repression: 'inhibition', negative: 'inhibition', binding: 'binding', binds: 'binding', association: 'binding', conversion: 'conversion', converts: 'conversion', production: 'conversion', reaction: 'conversion', catalysis: 'catalysis', catalyses: 'catalysis', catalyzes: 'catalysis' };

export function parsePathway(source: string): Pathway {
  checkSize(source, 'pathway');
  const j = parseJson(source.trim(), 'pathway');
  if (!isObj(j) || !Array.isArray(j.nodes)) throw new Error('a pathway is {"nodes": [{"id", "label", "type"}], "edges": [{"from", "to", "type"}]}');
  const notes: string[] = [];
  if (j.nodes.length > LIMITS.pathwayNodes) notes.push(tooLarge(LIMITS.pathwayNodes, j.nodes.length, 'nodes'));
  const nodes: PathwayNode[] = []; const ids = new Set<string>();
  j.nodes.slice(0, LIMITS.pathwayNodes).forEach((n, i) => {
    const o = isObj(n) ? n : typeof n === 'string' ? { id: n } : null;
    if (!o) throw new Error(`node ${i + 1} is not an object`);
    const id = text(o.id ?? o.name ?? o.label, 60);
    if (!id) throw new Error(`node ${i + 1} needs an "id"`);
    if (ids.has(id)) throw new Error(`two nodes have the id "${id}"`);
    ids.add(id);
    const t = String(o.type ?? 'protein').toLowerCase();
    nodes.push({ id, label: text(o.label ?? o.name ?? id, 40) || id, type: NODE_ALIAS[t] ?? 'protein' });
  });
  const rawEdges = Array.isArray(j.edges) ? j.edges : [];
  if (rawEdges.length > LIMITS.pathwayEdges) notes.push(tooLarge(LIMITS.pathwayEdges, rawEdges.length, 'edges'));
  const edges: PathwayEdge[] = [];
  rawEdges.slice(0, LIMITS.pathwayEdges).forEach((e, i) => {
    if (!isObj(e)) throw new Error(`edge ${i + 1} is not an object`);
    const from = text(e.from ?? e.source, 60); const to = text(e.to ?? e.target, 60);
    // Edges to nodes cut by the limit are dropped quietly (the note says so); unknown ids are an error.
    if (!ids.has(from) || !ids.has(to)) {
      if (nodes.length < (j.nodes as unknown[]).length) return;
      throw new Error(`edge ${i + 1} (${from || '?'} -> ${to || '?'}) names a node that is not in "nodes"`);
    }
    edges.push({ from, to, type: EDGE_ALIAS[String(e.type ?? 'activation').toLowerCase()] ?? 'activation', label: text(e.label ?? '', 30) });
  });
  return { title: text(j.title ?? '', 80), direction: String(j.direction ?? j.rankdir ?? 'TB').toUpperCase() === 'LR' ? 'LR' : 'TB', nodes, edges, notes };
}

/** A quoted DOT string: backslashes and quotes escaped; `image=` and the like (which checkDot refuses as file access) broken with a zero-width joiner. */
export const dotString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ').replace(/\b(image|shapefile|fontpath|imagepath|fontnames)(\s*)=/gi, '$1$2\u200d=')}"`;

export interface PathwayTheme { ink: string; muted: string; fills: Record<NodeType, string>; edges: Record<EdgeType, string> }
export function pathwayTheme(dark: boolean): PathwayTheme {
  return dark
    ? { ink: '#e6e6e6', muted: '#9a9a9a', fills: { gene: '#1f3b5c', protein: '#1d4433', metabolite: '#4a3a12', complex: '#3a2a55', phenotype: '#4d2330', drug: '#2b3a44' }, edges: { activation: '#4cc38a', inhibition: '#ff6b6b', binding: '#9aa5b1', conversion: '#e6e6e6', catalysis: '#6aa9de' } }
    : { ink: '#1f1e1c', muted: '#6b6a66', fills: { gene: '#dbe9fb', protein: '#d9f2e4', metabolite: '#fdf0cf', complex: '#ebe1f7', phenotype: '#fbe1e6', drug: '#e3edf2' }, edges: { activation: '#188c4c', inhibition: '#c43030', binding: '#7b8794', conversion: '#1f1e1c', catalysis: '#2876a0' } };
}

const SHAPE: Record<NodeType, string> = {
  gene: 'shape=cds', // a gene glyph: a box with an arrow end
  protein: 'shape=box, style="rounded,filled"',
  metabolite: 'shape=ellipse',
  complex: 'shape=octagon', // SBGN's cut-corner complex
  phenotype: 'shape=hexagon',
  drug: 'shape=diamond',
};
const ARROW: Record<EdgeType, string> = {
  activation: 'arrowhead=empty', // SBGN stimulation: an open triangle
  inhibition: 'arrowhead=tee',
  binding: 'arrowhead=none, style=dashed',
  conversion: 'arrowhead=normal', // production: a filled triangle
  catalysis: 'arrowhead=odot', // an open circle
};

export function pathwayDot(p: Pathway, dark = false): string {
  const th = pathwayTheme(dark);
  const id = new Map(p.nodes.map((n, i) => [n.id, `n${i}`]));
  const out = [
    'digraph pathway {',
    `  graph [rankdir=${p.direction}, bgcolor="transparent", nodesep=0.35, ranksep=0.45, pad=0.15, fontname="Helvetica"];`,
    `  node [style=filled, fontname="Helvetica", fontsize=11, color="${th.muted}", fontcolor="${th.ink}", penwidth=1.1, margin="0.12,0.05", height=0.36];`,
    '  edge [fontname="Helvetica", fontsize=9, penwidth=1.3, arrowsize=0.8];',
  ];
  for (const n of p.nodes) {
    out.push(`  ${id.get(n.id)} [label=${dotString(n.label)}, tooltip=${dotString(`${n.label} (${n.type})`)}, ${SHAPE[n.type]}, fillcolor="${th.fills[n.type]}"];`);
  }
  for (const e of p.edges) {
    out.push(`  ${id.get(e.from)} -> ${id.get(e.to)} [${ARROW[e.type]}, color="${th.edges[e.type]}", tooltip=${dotString(`${e.from} ${e.type} ${e.to}`)}${e.label ? `, label=${dotString(e.label)}, fontcolor="${th.muted}"` : ''}];`);
  }
  out.push('}');
  return out.join('\n');
}
