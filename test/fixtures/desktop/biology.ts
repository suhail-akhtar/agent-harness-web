// Biology fixtures: one message per renderer with realistic data (the human insulin coding
// sequence, ubiquitin, insulin B chains across species, a primate phylogeny, pUC19's main features,
// the INS and TP53 loci, a GCN4-like coiled coil, insulin signalling, a hypoxia expression study,
// survival curves and a GWAS), a kitchen sink using them all, and hostile inputs that must come out
// inert (an error card or plain text) or bounded (a "too large" note). Coordinates of loci and
// plasmid features follow public annotations closely but are for display, not for analysis.

const fence = (lang: string, body: string) => `\`\`\`${lang}\n${body}\n\`\`\``;
const json = (v: unknown) => JSON.stringify(v);

/** A small deterministic random source (mulberry32), so fixtures are the same on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());

/** Human preproinsulin coding sequence (INS, NM_000207), 333 nt with the stop codon. */
export const INS_CDS = 'ATGGCCCTGTGGATGCGCCTCCTGCCCCTGCTGGCGCTGCTGGCCCTCTGGGGACCTGACCCAGCCGCAGCCTTTGTGAACCAACACCTGTGCGGCTCACACCTGGTGGAAGCTCTCTACCTAGTGTGCGGGGAACGAGGCTTCTTCTACACACCCAAGACCCGCCGGGAGGCAGAGGACCTGCAGGTGGGGCAGGTGGAGCTGGGCGGGGGCCCTGGTGCAGGCAGCCTGCAGCCCTTGGCCCTGGAGGGGTCCCTGCAGAAGCGTGGCATTGTGGAACAATGCTGTACCAGCATCTGCTCCCTCTACCAGCTGGAGAACTACTGCAACTAG';
export const PREPROINSULIN = 'MALWMRLLPLLALLALWGPDPAAAFVNQHLCGSHLVEALYLVCGERGFFYTPKTRREAEDLQVGQVELGGGPGAGSLQPLALEGSLQKRGIVEQCCTSICSLYQLENYCN';
export const UBIQUITIN = 'MQIFVKTLTGKTITLEVEPSDTIENVKAKIQDKEGIPPDQQRLIFAGKQLEDGRTLSDYNIQKESTLHLVLRLRGG';
const GCN4 = 'RMKQLEDKVEELLSKNYHLENEVARLKKLVGER';

/** A PDB ATOM/HETATM record with its fixed columns. */
function atom(kind: 'ATOM' | 'HETATM', serial: number, name: string, res: string, chain: string, seq: number, x: number, y: number, z: number, el: string): string {
  return `${kind.padEnd(6)}${String(serial).padStart(5)} ${name.padEnd(4)} ${res} ${chain}${String(seq).padStart(4)}    ${x.toFixed(3).padStart(8)}${y.toFixed(3).padStart(8)}${z.toFixed(3).padStart(8)}  1.00 20.00          ${el.padStart(2)}`;
}
const THREE: Record<string, string> = { A: 'ALA', R: 'ARG', N: 'ASN', D: 'ASP', C: 'CYS', E: 'GLU', Q: 'GLN', G: 'GLY', H: 'HIS', I: 'ILE', L: 'LEU', K: 'LYS', M: 'MET', F: 'PHE', P: 'PRO', S: 'SER', T: 'THR', W: 'TRP', Y: 'TYR', V: 'VAL' };

/**
 * A parallel two-helix coiled coil with the GCN4 leucine-zipper sequence: ideal alpha-helix backbones
 * (100 degrees and 1.5 A per residue, CA on a 2.3 A radius), HELIX records, an acetate ligand between
 * the helices and three waters. Idealised coordinates, real sequence.
 */
export function coiledCoilPdb(): string {
  const lines = ['HEADER    COILED COIL (IDEALISED)                 22-OCT-26   XXXX', 'TITLE     GCN4-LIKE LEUCINE ZIPPER, TWO PARALLEL HELICES'];
  const n = GCN4.length;
  lines.push(`HELIX    1   1 ${THREE[GCN4[0]!]} A    1  ${THREE[GCN4[n - 1]!]} A ${String(n).padStart(4)}  1${' '.repeat(30)}${String(n).padStart(5)}`);
  lines.push(`HELIX    2   2 ${THREE[GCN4[0]!]} B    1  ${THREE[GCN4[n - 1]!]} B ${String(n).padStart(4)}  1${' '.repeat(30)}${String(n).padStart(5)}`);
  let serial = 1;
  for (const [chain, ox, phase] of [['A', 0, 0], ['B', 9.8, Math.PI]] as const) {
    const ca = (i: number) => { const a = phase + (i * 100 * Math.PI) / 180; return [ox + 2.3 * Math.cos(a), 2.3 * Math.sin(a), i * 1.5] as const; };
    for (let i = 0; i < n; i++) {
      const p = ca(i); const q = ca(i + 1); const o = ca(i - 1);
      const lerp = (a: readonly number[], b: readonly number[], t: number) => a.map((v, k) => v + (b[k]! - v) * t);
      const N = lerp(p, o, 0.38); const C = lerp(p, q, 0.4); const O = [C[0]!, C[1]!, C[2]! + 1.23];
      const res = THREE[GCN4[i]!]!;
      lines.push(atom('ATOM', serial++, ' N', res, chain, i + 1, N[0]!, N[1]!, N[2]!, 'N'));
      lines.push(atom('ATOM', serial++, ' CA', res, chain, i + 1, p[0], p[1], p[2], 'C'));
      lines.push(atom('ATOM', serial++, ' C', res, chain, i + 1, C[0]!, C[1]!, C[2]!, 'C'));
      lines.push(atom('ATOM', serial++, ' O', res, chain, i + 1, O[0]!, O[1]!, O[2]!, 'O'));
    }
    lines.push(`TER   ${String(serial++).padStart(5)}      ${THREE[GCN4[n - 1]!]} ${chain}${String(n).padStart(4)}`);
  }
  for (const [name, x, y, z, el] of [[' C1', 4.9, 0.0, 24.0, 'C'], [' C2', 4.9, 1.5, 24.3, 'C'], [' O1', 3.9, -0.6, 23.6, 'O'], [' O2', 6.0, -0.6, 24.1, 'O']] as const) lines.push(atom('HETATM', serial++, name, 'ACT', 'A', 101, x, y, z, el));
  for (const [k, x, y, z] of [[1, 4.9, 6.0, 10.0], [2, 4.9, -6.0, 30.0], [3, 12.0, 5.0, 40.0]] as const) lines.push(atom('HETATM', serial++, ' O', 'HOH', 'A', 200 + k, x, y, z, 'O'));
  lines.push('END');
  return lines.join('\n');
}

/** TP53 (NM_000546) as BED12 on GRCh38, minus strand, eleven exons. */
function tp53Bed(): string {
  const start = 7668401; const end = 7687550;
  const exons = [[7668401, 7669690], [7670608, 7670715], [7673534, 7673608], [7673700, 7673837], [7674180, 7674290], [7674858, 7674971], [7675052, 7675236], [7675993, 7676272], [7676381, 7676403], [7676520, 7676622], [7687376, 7687550]];
  return ['track name="RefSeq" description="TP53 and WRAP53"',
    ['chr17', start, end, 'TP53', 1000, '-', 7669608, 7676594, '0,0,0', exons.length, exons.map(([a, b]) => b! - a!).join(',') + ',', exons.map(([a]) => a! - start).join(',') + ','].join('\t'),
    ['chr17', 7686070, 7703502, 'WRAP53', 1000, '+', 7686330, 7701980, '0,0,0', 4, '420,180,210,1522,', '0,9800,12400,15910,'].join('\t'),
  ].join('\n');
}

/** The INS locus (and TH next to it) as GFF3, GRCh38 chr11, minus strand. */
const INS_GFF = [
  '##gff-version 3',
  '##sequence-region chr11 2150000 2175000',
  'chr11\tRefSeq\tgene\t2159779\t2161209\t.\t-\t.\tID=gene-INS;Name=INS;description=insulin',
  'chr11\tRefSeq\tmRNA\t2159779\t2161209\t.\t-\t.\tID=rna-INS;Parent=gene-INS;Name=NM_000207.3;gene=INS',
  'chr11\tRefSeq\texon\t2161168\t2161209\t.\t-\t.\tParent=rna-INS',
  'chr11\tRefSeq\texon\t2160394\t2160597\t.\t-\t.\tParent=rna-INS',
  'chr11\tRefSeq\texon\t2159779\t2160215\t.\t-\t.\tParent=rna-INS',
  'chr11\tRefSeq\tCDS\t2160394\t2160571\t.\t-\t0\tParent=rna-INS',
  'chr11\tRefSeq\tCDS\t2160061\t2160215\t.\t-\t2\tParent=rna-INS',
  'chr11\tRefSeq\tgene\t2163929\t2171815\t.\t-\t.\tID=gene-TH;Name=TH;description=tyrosine hydroxylase',
  'chr11\tRefSeq\tmRNA\t2163929\t2171815\t.\t-\t.\tID=rna-TH;Parent=gene-TH;Name=NM_199292.3;gene=TH',
  ...[[2171640, 2171815], [2169410, 2169562], [2168850, 2168971], [2167530, 2167664], [2166980, 2167114], [2166020, 2166180], [2165380, 2165466], [2164710, 2164865], [2164020, 2164140], [2163929, 2163985]].map(([a, b]) => `chr11\tRefSeq\texon\t${a}\t${b}\t.\t-\t.\tParent=rna-TH`),
  'chr11\tRefSeq\tCDS\t2163970\t2171780\t.\t-\t0\tParent=rna-TH',
  'chr11\tENCODE\tenhancer\t2157200\t2158100\t.\t.\t.\tID=enh1;Name=INS enhancer (illustrative)',
].join('\n');

function volcanoData() {
  const r = rng(7);
  const up = ['VEGFA', 'CA9', 'EGLN3', 'BNIP3', 'PGK1', 'LDHA', 'SLC2A1', 'ADM', 'ANKRD37', 'NDRG1', 'PDK1', 'P4HA1'];
  const down = ['MKI67', 'CCNB1', 'E2F1', 'PCNA', 'MCM2', 'TOP2A'];
  const points: Array<{ gene: string; log2fc: number; padj: number; baseMean: number }> = [];
  up.forEach((g, i) => points.push({ gene: g, log2fc: +(2 + r() * 3.5).toFixed(2), padj: Number((10 ** -(20 - i * 1.4 + r())).toPrecision(3)), baseMean: Math.round(200 + r() * 8000) }));
  down.forEach((g, i) => points.push({ gene: g, log2fc: -(1.3 + r() * 2).toFixed(2), padj: Number((10 ** -(12 - i * 1.5 + r())).toPrecision(3)), baseMean: Math.round(300 + r() * 5000) }));
  for (let i = 0; i < 380; i++) { const fc = gauss(r) * 0.6; points.push({ gene: `G${String(i + 1).padStart(4, '0')}`, log2fc: +fc.toFixed(2), padj: Number(Math.min(1, 0.002 + r()).toPrecision(3)), baseMean: Math.round(10 ** (1 + r() * 3.5)) }); }
  return points;
}

function survivalData() {
  const r = rng(11);
  const group = (n: number, scale: number) => {
    const time: number[] = []; const event: number[] = [];
    for (let i = 0; i < n; i++) { const t = -Math.log(1 - r()) * scale; const c = 6 + r() * 60; time.push(+Math.min(t, c).toFixed(1)); event.push(t <= c ? 1 : 0); }
    return { time, event };
  };
  return { title: 'Overall survival by CA9 expression', timeUnit: 'months', groups: [{ name: 'CA9 high', ...group(40, 18) }, { name: 'CA9 low', ...group(40, 42) }] };
}

function gwasData() {
  const r = rng(23);
  // GRCh38 chromosome lengths (Mb), rounded.
  const len = [248, 242, 198, 190, 181, 171, 159, 145, 138, 134, 135, 133, 114, 107, 102, 90, 83, 80, 59, 64, 47, 51];
  const snps: Array<{ chr: string; pos: number; p: number; id: string; gene?: string }> = [];
  len.forEach((mb, c) => { for (let k = 0; k < 55; k++) snps.push({ chr: String(c + 1), pos: Math.round(r() * mb * 1e6), p: Number(Math.max(1e-300, r()).toPrecision(3)), id: `rs${100000 + c * 1000 + k}` }); });
  const peak = (chr: string, centre: number, best: number, gene: string, id: string) => { for (let k = 0; k < 9; k++) snps.push({ chr, pos: centre + Math.round((k - 4) * 60_000), p: Number((10 ** -(best * (1 - Math.abs(k - 4) / 6))).toPrecision(3)), id: k === 4 ? id : `rs${900000 + snps.length}`, ...(k === 4 ? { gene } : {}) }); };
  peak('10', 112_998_590, 30, 'TCF7L2', 'rs7903146');
  peak('16', 53_786_615, 12, 'FTO', 'rs9939609');
  peak('6', 20_686_573, 9, 'CDKAL1', 'rs7756992');
  peak('3', 12_351_626, 6.5, 'PPARG', 'rs1801282');
  return { title: 'Type 2 diabetes GWAS (simulated around known loci)', snps };
}

function heatmapData() {
  const r = rng(5);
  const genes = ['VEGFA', 'CA9', 'EGLN3', 'BNIP3', 'PGK1', 'LDHA', 'MKI67', 'CCNB1', 'E2F1', 'PCNA', 'ACTB', 'GAPDH'];
  const samples = ['Norm 1', 'Norm 2', 'Norm 3', 'Hyp 1', 'Hyp 2', 'Hyp 3'];
  const values = genes.map((g, gi) => samples.map((_, si) => { const hyp = si >= 3; const base = 6 + (gi % 4); const effect = gi < 6 ? (hyp ? 3 : 0) : gi < 10 ? (hyp ? -2 : 0) : 0; return +(base + effect + gauss(r) * 0.4).toFixed(2); }));
  return { title: 'Hypoxia response (log2 expression)', rows: genes, cols: samples, values, scale: 'row', cluster: 'both' };
}

export const BIO: Record<string, string> = {
  sequence: `The human insulin coding sequence with its processing features:

${fence('sequence', json({ name: 'INS', description: 'Homo sapiens preproinsulin CDS (NM_000207)', type: 'dna', sequence: INS_CDS, features: [
    { start: 1, end: 72, label: 'signal peptide', type: 'sig_peptide', strand: 1 },
    { start: 73, end: 162, label: 'B chain', type: 'CDS', strand: 1 },
    { start: 169, end: 261, label: 'C peptide', type: 'propeptide', strand: 1 },
    { start: 268, end: 330, label: 'A chain', type: 'CDS', strand: 1 },
  ] }))}`,
  protein: `Ubiquitin as FASTA:

${fence('fasta', `>sp|P0CG48|UBC_HUMAN Ubiquitin (one repeat)\n${UBIQUITIN.match(/.{1,60}/g)!.join('\n')}`)}`,
  msa: `Insulin B chains across species:

${fence('msa', ['>Human', 'FVNQHLCGSHLVEALYLVCGERGFFYTPKT', '>Bovine', 'FVNQHLCGSHLVEALYLVCGERGFFYTPKA', '>Pig', 'FVNQHLCGSHLVEALYLVCGERGFFYTPKA', '>Rat_Ins1', 'FVKQHLCGPHLVEALYLVCGERGFFYTPKS', '>Chicken', 'AANQHLCGSHLVEALYLVCGERGFFYSPKA', '>Hagfish', 'RTTGHLCGKDLVNALYIACGVRGFFYDPTK'].join('\n'))}`,
  clustal: `The same chains in CLUSTAL form (first four):

${fence('clustal', ['CLUSTAL W (1.83) multiple sequence alignment', '', 'Human      FVNQHLCGSHLVEALYLVCGERGFFYTPKT', 'Bovine     FVNQHLCGSHLVEALYLVCGERGFFYTPKA', 'Rat_Ins1   FVKQHLCGPHLVEALYLVCGERGFFYTPKS', 'Chicken    AANQHLCGSHLVEALYLVCGERGFFYSPKA', '             .****** **********************.*.'].join('\n'))}`,
  newick: `A small primate phylogeny (substitutions per site, bootstrap support):

${fence('newick', '(((((Homo_sapiens:0.0067,Pan_troglodytes:0.0072)100:0.0024,Gorilla_gorilla:0.0089)100:0.0097,Pongo_abelii:0.0183)100:0.0143,Hylobates_lar:0.0221)98:0.0205,(Macaca_mulatta:0.0074,Papio_anubis:0.0071)100:0.0335);')}`,
  plasmid: `pUC19 and its main features:

${fence('plasmid', json({ name: 'pUC19', length: 2686, features: [
    { start: 146, end: 469, label: 'lacZα', type: 'CDS', strand: -1 },
    { start: 397, end: 453, label: 'MCS', type: 'misc_feature', strand: 0 },
    { start: 477, end: 493, label: 'lac operator', type: 'protein_bind', strand: -1 },
    { start: 501, end: 531, label: 'lac promoter', type: 'promoter', strand: -1 },
    { start: 546, end: 567, label: 'CAP site', type: 'protein_bind', strand: -1 },
    { start: 853, end: 1441, label: 'ori', type: 'rep_origin', strand: -1 },
    { start: 1626, end: 2486, label: 'AmpR', type: 'CDS', strand: -1 },
    { start: 2487, end: 2591, label: 'AmpR promoter', type: 'promoter', strand: -1 },
  ], sites: [{ position: 183, label: 'NdeI' }, { position: 396, label: 'EcoRI' }, { position: 412, label: 'SmaI' }, { position: 417, label: 'BamHI' }, { position: 423, label: 'XbaI' }, { position: 429, label: 'SalI' }, { position: 435, label: 'PstI' }, { position: 447, label: 'HindIII' }, { position: 2617, label: 'AatII' }] }))}`,
  gff: `The insulin locus on chr11 (GFF3):

${fence('gff', INS_GFF)}`,
  bed: `TP53 and WRAP53 (BED12):

${fence('bed', tp53Bed())}`,
  tracks: `A genes track with a signal track over the INS promoter:

${fence('tracks', json({ region: { chrom: 'chr11', start: 2156000, end: 2163000 }, tracks: [
    { name: 'Genes', type: 'genes', features: [{ name: 'INS', chrom: 'chr11', start: 2159779, end: 2161209, strand: '-', exons: [[2159779, 2160215], [2160394, 2160597], [2161168, 2161209]], cds: [2160061, 2160571] }] },
    { name: 'H3K27ac (islets)', type: 'signal', values: Array.from({ length: 70 }, (_, i) => ({ start: 2156000 + i * 100, end: 2156099 + i * 100, value: +(2 + 18 * Math.exp(-(((i - 52) / 6) ** 2)) + 6 * Math.exp(-(((i - 14) / 4) ** 2))).toFixed(1) })) },
  ] }))}`,
  pdb: `A GCN4-like coiled coil (two chains, a ligand):

${fence('pdb', coiledCoilPdb())}`,
  uniprot: `Ubiquitin's features:

${fence('uniprot', json({ name: 'Ubiquitin', accession: 'P0CG48', sequence: UBIQUITIN, features: [
    { type: 'Domain', start: 1, end: 76, description: 'Ubiquitin-like' },
    { type: 'Region', start: 8, end: 70, description: 'Ile44 hydrophobic patch (L8, I44, V70)' },
    ...[6, 11, 27, 29, 33, 48, 63].map((k) => ({ type: 'Cross-link', start: k, end: k, description: `K${k}: glycyl lysine isopeptide (polyubiquitin chains)` })),
    { type: 'Site', start: 44, end: 44, description: 'Ile44' },
    { type: 'Modified residue', start: 65, end: 65, description: 'Phosphoserine (PINK1)' },
    { type: 'Strand', start: 1, end: 7 }, { type: 'Strand', start: 10, end: 17 }, { type: 'Helix', start: 23, end: 34 }, { type: 'Strand', start: 40, end: 45 }, { type: 'Strand', start: 48, end: 49 }, { type: 'Helix', start: 56, end: 59 }, { type: 'Strand', start: 66, end: 72 },
  ] }))}`,
  pathway: `Insulin signalling, simplified:

${fence('pathway', json({ title: 'Insulin signalling (PI3K-AKT)', direction: 'TB', nodes: [
    { id: 'INS', label: 'Insulin', type: 'protein' }, { id: 'INSR', label: 'INSR', type: 'protein' }, { id: 'INS:INSR', label: 'INS:INSR', type: 'complex' },
    { id: 'IRS1', type: 'protein' }, { id: 'PI3K', label: 'PI3K', type: 'protein' }, { id: 'PIP2', type: 'metabolite' }, { id: 'PIP3', type: 'metabolite' },
    { id: 'PTEN', type: 'protein' }, { id: 'AKT', label: 'AKT1', type: 'protein' }, { id: 'GSK3B', type: 'protein' }, { id: 'SLC2A4', label: 'GLUT4 (SLC2A4)', type: 'gene' },
    { id: 'uptake', label: 'glucose uptake', type: 'phenotype' }, { id: 'wortmannin', type: 'drug' },
  ], edges: [
    { from: 'INS', to: 'INS:INSR', type: 'binding' }, { from: 'INSR', to: 'INS:INSR', type: 'binding' }, { from: 'INS:INSR', to: 'IRS1', type: 'activation', label: 'pY' },
    { from: 'IRS1', to: 'PI3K', type: 'activation' }, { from: 'PIP2', to: 'PIP3', type: 'conversion' }, { from: 'PI3K', to: 'PIP3', type: 'catalysis' },
    { from: 'PTEN', to: 'PIP3', type: 'inhibition' }, { from: 'PIP3', to: 'AKT', type: 'activation' }, { from: 'AKT', to: 'GSK3B', type: 'inhibition' },
    { from: 'AKT', to: 'SLC2A4', type: 'activation' }, { from: 'SLC2A4', to: 'uptake', type: 'activation' }, { from: 'wortmannin', to: 'PI3K', type: 'inhibition' },
  ] }))}`,
  volcano: `Hypoxia versus normoxia (DESeq2-style results):

${fence('volcano', json({ title: 'Hypoxia vs normoxia', fc: 1, p: 0.05, labels: 10, points: volcanoData().map(({ gene, log2fc, padj }) => ({ gene, log2fc, padj })) }))}`,
  ma: `The same genes as an MA plot:

${fence('ma', json({ title: 'Hypoxia vs normoxia (MA)', fc: 1, points: volcanoData().map(({ gene, log2fc, padj, baseMean }) => ({ gene, baseMean, log2fc, padj })) }))}`,
  heatmap: `Clustered expression:

${fence('heatmap', json(heatmapData()))}`,
  km: `Survival by CA9 expression:

${fence('kaplan-meier', json(survivalData()))}`,
  manhattan: `A GWAS:

${fence('manhattan', json(gwasData()))}`,
};

export const BIO_KITCHEN_SINK = [
  '# Biology kitchen sink',
  'Every biology renderer, in one reply.',
  BIO.sequence, BIO.protein, BIO.msa, BIO.clustal, BIO.newick, BIO.plasmid, BIO.gff, BIO.bed, BIO.tracks, BIO.pdb, BIO.uniprot, BIO.pathway, BIO.volcano, BIO.ma, BIO.heatmap, BIO.km, BIO.manhattan,
  '**End of the biology sink.**',
].join('\n\n');

/** Hostile input per renderer: markup in labels (must stay text), malformed input (a readable error), huge input (bounded with a note). */
export const BIO_HOSTILE = {
  fastaLabel: `>evil<script>alert("xss-fasta")</script> <img src=x onerror=alert(1)>\nACGTACGTAC`,
  seqFeature: json({ name: '<b onmouseover=alert(1)>x</b>', sequence: 'ATGAAATAG', features: [{ start: 1, end: 9, label: '<img src=x onerror=alert("xss-seq")>', type: 'CDS', strand: 1, color: 'url(javascript:alert(1))' }] }),
  seqBadChars: 'ACGT<script>alert(1)</script>',
  seqHuge: `>huge\n${'ACGT'.repeat(400_000)}`,
  msaUneven: '>a\nACGT-\n>b\nACG',
  msaLabel: `>x<script>alert("xss-msa")</script>\nAC-GT\n>y\nACAGT`,
  newickLabel: `('<script>alert("xss-tree")</script>':0.1,'<img src=x onerror=alert(1)>':0.2,C:0.3);`,
  newickDeep: `${'('.repeat(5000)}A,B${')'.repeat(5000)};`,
  newickUnbalanced: '((A,B),C;',
  newickHuge: `(${Array.from({ length: 3000 }, (_, i) => `L${i}:0.1`).join(',')});`,
  phyloxml: `<phyloxml><phylogeny rooted="true"><clade><clade branch_length="0.1"><name>&lt;script&gt;alert("xss-pxml")&lt;/script&gt;</name><confidence type="bootstrap">90</confidence><clade><name>A</name></clade><clade><name>B</name></clade></clade><clade branch_length="0.3"><name>C</name></clade></clade></phylogeny></phyloxml>`,
  plasmidLabel: json({ name: '<svg onload=alert(1)>', length: 1000, features: [{ start: 10, end: 300, label: '<script>alert("xss-plasmid")</script>', type: 'CDS', strand: 1, color: 'red;background:url(javascript:alert(1))' }], sites: [{ position: 50, label: '<img onerror=alert(1)>' }] }),
  plasmidPast: json({ name: 'p', length: 100, features: [{ start: 10, end: 500, label: 'too far' }] }),
  plasmidNotJson: '{name: pUC19, length: 2686',
  gffLabel: 'chr1\tx\tgene\t100\t900\t.\t+\t.\tID=g1;Name=%3Cscript%3Ealert(%22xss-gff%22)%3C%2Fscript%3E',
  bedBad: 'chr1\t500\t100\tbackwards',
  pathwayLabel: json({ nodes: [{ id: 'a', label: '<img src=x onerror=alert("xss-path")>', type: 'protein' }, { id: 'b', label: 'image="C:/Windows/win.ini" "quoted" \\ back', type: 'gene' }], edges: [{ from: 'a', to: 'b', type: 'inhibition', label: '"];evil[label="' }] }),
  pathwayMissing: json({ nodes: [{ id: 'a' }], edges: [{ from: 'a', to: 'ghost' }] }),
  volcanoLabel: json({ points: [{ gene: '<script>alert("xss-volcano")</script>', log2fc: 3, p: 1e-9 }, { gene: 'constructor', log2fc: -2, p: 1e-5 }] }),
  volcanoHuge: json({ points: Array.from({ length: 20_000 }, (_, i) => ({ gene: `g${i}`, log2fc: ((i % 200) - 100) / 25, p: ((i % 997) + 1) / 1000 })) }),
  volcanoEmpty: json({ points: [{ gene: 'x' }] }),
  manhattanChr: json({ snps: [{ chr: "1' ? alert(1) : '", pos: 1, p: 0.01 }] }),
  heatmapRagged: json({ rows: ['a', 'b'], cols: ['x', 'y'], values: [[1, 2], [3]] }),
  heatmapLabel: json({ rows: ['<script>alert("xss-heat")</script>', 'b', 'c'], cols: ['x', 'y', 'z'], values: [[1, 2, 3], [3, 2, 1], [2, 2, 2]] }),
  kmMismatch: json({ groups: [{ name: 'a', time: [1, 2, 3], event: [1, 0] }] }),
  uniprotLabel: json({ name: 'p', length: 50, features: [{ type: '<script>alert("xss-uniprot")</script>', start: 2, end: 9, description: '<img src=x onerror=alert(1)>' }] }),
  pdbScript: `${coiledCoilPdb()}\n</script><script>alert("xss-pdb3d")</script>`,
  pdbEmpty: 'HEADER nothing here\nEND',
};
