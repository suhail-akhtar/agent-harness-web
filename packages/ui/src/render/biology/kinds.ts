/**
 * The biology fence languages, their kinds, the component each loads (from Biology.tsx, on first
 * use), its title in the block frame and its download extension. Read by fences.ts (the shared
 * table) and Markdown.tsx (the lazy dispatch). No imports: fences.ts imports this.
 */

export type BioKind = 'sequence' | 'msa' | 'phylo' | 'plasmid' | 'tracks' | 'protein-features' | 'pathway' | 'volcano' | 'ma' | 'kaplan-meier' | 'manhattan' | 'heatmap';

export const BIO_BY_LANG: Record<string, BioKind> = {
  fasta: 'sequence', fa: 'sequence', sequence: 'sequence', seq: 'sequence',
  msa: 'msa', clustal: 'msa', aln: 'msa', stockholm: 'msa',
  newick: 'phylo', nwk: 'phylo', phyloxml: 'phylo',
  plasmid: 'plasmid',
  bed: 'tracks', gff: 'tracks', gff3: 'tracks', gtf: 'tracks', tracks: 'tracks',
  uniprot: 'protein-features', 'protein-features': 'protein-features',
  pathway: 'pathway',
  volcano: 'volcano',
  ma: 'ma', 'ma-plot': 'ma',
  'kaplan-meier': 'kaplan-meier', km: 'kaplan-meier', survival: 'kaplan-meier',
  manhattan: 'manhattan', gwas: 'manhattan',
  heatmap: 'heatmap', clustermap: 'heatmap',
};

export const BIO_KINDS = [...new Set(Object.values(BIO_BY_LANG))] as BioKind[];

/** One name per kind for the client declaration (kept short: it is in every request's cached prefix). */
export const BIO_DECLARED = ['fasta', 'msa', 'newick', 'plasmid', 'gff', 'bed', 'tracks', 'uniprot', 'pathway', 'volcano', 'ma', 'heatmap', 'kaplan-meier', 'manhattan'] as const;

type Entry = { component: 'SequenceView' | 'MsaView' | 'TreeView' | 'PlasmidView' | 'TracksView' | 'ProteinFeaturesView' | 'PathwayView' | 'BioPlotView' | 'HeatmapView' | 'Protein3D'; title: string; ext: string };
const ENTRY: Record<BioKind, Entry> = {
  sequence: { component: 'SequenceView', title: 'Sequence', ext: 'fasta' },
  msa: { component: 'MsaView', title: 'Alignment', ext: 'aln' },
  phylo: { component: 'TreeView', title: 'Tree', ext: 'nwk' },
  plasmid: { component: 'PlasmidView', title: 'Plasmid map', ext: 'json' },
  tracks: { component: 'TracksView', title: 'Genome tracks', ext: 'txt' },
  'protein-features': { component: 'ProteinFeaturesView', title: 'Protein features', ext: 'json' },
  pathway: { component: 'PathwayView', title: 'Pathway', ext: 'json' },
  volcano: { component: 'BioPlotView', title: 'Volcano plot', ext: 'json' },
  ma: { component: 'BioPlotView', title: 'MA plot', ext: 'json' },
  'kaplan-meier': { component: 'BioPlotView', title: 'Survival curve', ext: 'json' },
  manhattan: { component: 'BioPlotView', title: 'Manhattan plot', ext: 'json' },
  heatmap: { component: 'HeatmapView', title: 'Heatmap', ext: 'json' },
};

export const isBioKind = (k: string): k is BioKind => typeof k === 'string' && Object.hasOwn(ENTRY, k);

/**
 * The block to draw for a fence kind and language, or undefined when it is not a biology block.
 * pdb / cif (kind `molecule` in the shared table) get the protein 3D view.
 */
export function bioBlock(kind: string, lang: string): (Entry & { kind: BioKind | 'protein-3d' }) | undefined {
  const l = lang.trim().toLowerCase();
  if (kind === 'molecule' && (l === 'pdb' || l === 'cif' || l === 'mmcif')) return { component: 'Protein3D', title: '3D structure', ext: l === 'pdb' ? 'pdb' : 'cif', kind: 'protein-3d' };
  if (!isBioKind(kind)) return undefined;
  const e = ENTRY[kind];
  return { ...e, ext: kind === 'tracks' ? (['bed', 'gtf', 'gff3', 'gff'].includes(l) ? l : 'json') : e.ext, kind };
}
