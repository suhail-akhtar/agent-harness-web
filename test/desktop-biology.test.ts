// Biology renderers of packages/ui, in Node: sequences, alignments, trees, plasmid maps, genome
// tracks, protein features and 3D, pathways (the real Graphviz wasm), and the statistics plots (the
// Vega-Lite specs compiled and rendered to SVG with Vega's expression interpreter, as in the app).
// Each with hostile input: markup in labels stays text, malformed input is a readable error, huge
// input is bounded with a "too large" note. (Interaction and the 3D frame are checked in the e2e test.)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Graphviz } from '@hpcc-js/wasm-graphviz';
import { loadUi, renderAll } from './fixtures/desktop/load-ui.ts';
import { BIO, BIO_HOSTILE, BIO_KITCHEN_SINK, INS_CDS, PREPROINSULIN, UBIQUITIN, coiledCoilPdb } from './fixtures/desktop/biology.ts';

const body = (text: string, lang: string) => text.split(`\`\`\`${lang}\n`)[1]!.split('\n```')[0]!;
const bio = async () => { const { ui, React } = await loadUi(); return { ui, React, b: await ui.loadBiology() }; };
const fenced = async (lang: string, source: string) => { const { ui, React } = await loadUi(); return renderAll(React.createElement(ui.FencedBlock, { lang, source })); };
// A live tag or an event-handler attribute inside a real tag (escaped text like &lt;img onerror=...&gt; is fine).
// (React's own streaming script, <script>requestAnimationFrame..., is not content.)
// Attributes are walked one by one (quoted values skipped), so escaped text inside a value does not count.
const NO_LIVE_MARKUP = /<script[^>]*>[^<]*alert|<img\b|<[a-z][\w:-]*(?:\s+[\w:-]+(?:="[^"]*")?)*\s+on[a-z]+\s*=/i;

test('fences: every biology language has its renderer, lazily; the client declaration stays short', async () => {
  const { ui } = await loadUi();
  const kinds: Record<string, string> = { fasta: 'sequence', sequence: 'sequence', msa: 'msa', clustal: 'msa', aln: 'msa', newick: 'phylo', nwk: 'phylo', phyloxml: 'phylo', plasmid: 'plasmid', bed: 'tracks', gff: 'tracks', gff3: 'tracks', gtf: 'tracks', tracks: 'tracks', uniprot: 'protein-features', pathway: 'pathway', volcano: 'volcano', ma: 'ma', 'kaplan-meier': 'kaplan-meier', km: 'kaplan-meier', manhattan: 'manhattan', heatmap: 'heatmap', pdb: 'molecule', cif: 'molecule' };
  for (const [lang, kind] of Object.entries(kinds)) assert.equal(ui.fenceKind(lang), kind, lang);
  assert.equal(ui.bioBlock(ui.fenceKind('constructor'), 'constructor'), undefined, 'no prototype keys');
  assert.equal(ui.bioBlock('molecule', 'pdb').component, 'Protein3D', 'pdb and cif get the protein view');
  assert.equal(ui.bioBlock('molecule', 'sdf'), undefined, 'small molecules keep the science view');
  assert.equal(ui.extensionFor('tracks', 'gtf'), 'gtf');
  const declared = (ui.DECLARED_FENCES as string[]).join(',');
  assert.ok(declared.length < 400, `the declaration stays well under 150 tokens (${declared.length} chars)`);
  for (const l of ['fasta', 'msa', 'newick', 'plasmid', 'gff', 'pathway', 'volcano', 'heatmap', 'kaplan-meier', 'manhattan', 'uniprot']) assert.ok(declared.split(',').includes(l), l);
});

test('sequences: FASTA, JSON and bare letters; type, GC, weight, reverse complement and translation', async () => {
  const { b, ui, React } = await bio();
  const ins = b.parseSequences(body(BIO.sequence!, 'sequence')).records[0];
  assert.equal(ins.type, 'dna');
  assert.equal(ins.seq.length, 333);
  assert.equal(b.translate(INS_CDS), `${PREPROINSULIN}*`, 'the coding sequence translates to preproinsulin');
  assert.equal(b.translate(INS_CDS, 1).length, 110);
  assert.equal(b.gcContent(INS_CDS), 215 / 333);
  assert.equal(b.reverseComplement('ATGCRYN'), 'NRYGCAT');
  assert.equal(b.reverseComplement('AUGC', 'rna'), 'GCAU');
  const ub = b.parseSequences(body(BIO.protein!, 'fasta')).records[0];
  assert.equal(ub.name, 'sp|P0CG48|UBC_HUMAN');
  assert.equal(ub.type, 'protein');
  assert.equal(ub.seq, UBIQUITIN);
  assert.ok(Math.abs(b.molecularWeight(ub.seq, 'protein') - 8565) < 2, `ubiquitin is about 8,565 Da (${b.molecularWeight(ub.seq, 'protein')})`);
  assert.equal(b.parseSequences('ACGU ACGU\nACGU').records[0].type, 'rna');
  assert.equal(b.parseSequences('>a\nAC\n>b\nGT').records.length, 2);
  const { html, errors } = await renderAll(React.createElement(ui.Markdown, { text: BIO.sequence }));
  assert.deepEqual(errors, []);
  assert.match(html, /data-widget="Sequence"/);
  assert.match(html, /data-sequence="dna"/);
  assert.match(html, /data-seq-map/);
  assert.equal((html.match(/data-feature="/g) ?? []).length, 4, 'four features as tracks');
  assert.match(html, />Reverse complement</);
  assert.match(html, />Translate \(3 frames\)</);
  assert.match(html, />64\.6%</);
  assert.equal((html.match(/data-i="/g) ?? []).length, 333, 'every residue drawn');
});

test('sequences: hostile labels stay text; bad letters and huge input are bounded', async () => {
  const { b } = await bio();
  for (const src of [BIO_HOSTILE.fastaLabel, BIO_HOSTILE.seqFeature]) {
    const { html, errors } = await fenced('fasta', src);
    assert.deepEqual(errors, []);
    assert.doesNotMatch(html, NO_LIVE_MARKUP);
    assert.match(html, /&lt;(script|img|b)/);
  }
  assert.doesNotMatch((await fenced('fasta', BIO_HOSTILE.seqFeature)).html, /javascript/, 'a colour is hex or the default');
  assert.throws(() => b.parseSequences(BIO_HOSTILE.seqBadChars), /"<" at position 5 is not a residue letter/);
  assert.throws(() => b.parseSequences('{"sequence": 5}'), /needs a "sequence" string/);
  assert.throws(() => b.parseSequences('{oops'), /not valid JSON/);
  const huge = b.parseSequences(BIO_HOSTILE.seqHuge);
  assert.match(huge.notes.join(), /Too large: showing the first 1,000,000 of 1,600,000 residues/);
  const { html, errors } = await fenced('fasta', BIO_HOSTILE.seqHuge);
  assert.deepEqual(errors, []);
  assert.match(html, /data-bio-truncated/);
  assert.equal((html.match(/data-i="/g) ?? []).length, 12_000, 'the viewer draws the first 12,000');
  assert.throws(() => b.parseSequences('x'.repeat(5_000_001)), /too large to draw/);
});

test('alignments: aligned FASTA and CLUSTAL, conservation and consensus, colour runs; hostile input', async () => {
  const { b } = await bio();
  const a = b.parseAlignment(body(BIO.msa!, 'msa'));
  assert.equal(a.rows.length, 6);
  assert.equal(a.columns, 30);
  assert.equal(a.type, 'protein');
  const cols = b.columnStats(a);
  assert.equal(cols[5].consensus, 'L');
  assert.ok(cols[5].conserved, 'the B-chain leucine is conserved');
  assert.equal(cols[0].consensus, 'F');
  assert.ok(cols[0].identity < 1);
  const c = b.parseAlignment(body(BIO.clustal!, 'clustal'));
  assert.deepEqual(c.names, ['Human', 'Bovine', 'Rat_Ins1', 'Chicken']);
  assert.equal(c.columns, 30);
  const runs = b.colourRuns('LLLKK', [...Array(5)].map(() => ({ consensus: 'L', identity: 1, conserved: true, gaps: 0 })), 'clustal');
  assert.equal(runs.length, 2, 'cells of one colour merge into one span');
  const { html, errors } = await fenced('msa', body(BIO.msa!, 'msa'));
  assert.deepEqual(errors, []);
  assert.match(html, /data-msa="6"/);
  assert.match(html, /data-msa-conservation/);
  assert.match(html, /data-msa-consensus/);
  assert.match(html, /overflow-x-auto/, 'scrolls sideways inside its box');
  assert.throws(() => b.parseAlignment(BIO_HOSTILE.msaUneven), /b has 3 columns and a has 5/);
  assert.throws(() => b.parseAlignment('>a\nACGT'), /at least two sequences/);
  const bad = await fenced('msa', BIO_HOSTILE.msaLabel);
  assert.deepEqual(bad.errors, []);
  assert.doesNotMatch(bad.html, NO_LIVE_MARKUP);
  const big = b.parseAlignment(Array.from({ length: 200 }, (_, i) => `>s${i}\n${'ACGT'.repeat(1000)}`).join('\n'));
  assert.match(big.notes.join(' '), /showing the first 150 of 200 sequences.*showing the first 3,000 of 4,000 columns/);
});

test('trees: Newick with lengths and support, phyloXML; rectangular and circular layouts; collapsing; hostile trees', async () => {
  const { b, ui, React } = await bio();
  const t = b.parseTree(body(BIO.newick!, 'newick'));
  assert.equal(t.leaves, 7);
  assert.ok(t.hasLengths && t.hasSupport);
  const rect = b.layoutTree(t, { mode: 'rectangular' });
  const leaves = rect.nodes.filter((n: { leaf: boolean }) => n.leaf).map((n: { name: string }) => n.name);
  assert.deepEqual(leaves.slice(0, 3), ['Homo sapiens', 'Pan troglodytes', 'Gorilla gorilla']);
  const human = rect.nodes.find((n: { name: string }) => n.name === 'Homo sapiens'); const chimp = rect.nodes.find((n: { name: string }) => n.name === 'Pan troglodytes');
  assert.ok(chimp.x > human.x, 'branch lengths set the x position');
  assert.ok(rect.scale, 'a scale bar for branch lengths');
  const circ = b.layoutTree(t, { mode: 'circular' });
  assert.ok(circ.nodes.every((n: { angle?: number }) => typeof n.angle === 'number'));
  const apes = rect.nodes.find((n: { leaf: boolean; support?: number }) => !n.leaf && n.support === 98);
  const folded = b.layoutTree(t, { mode: 'rectangular', collapsed: new Set([apes.id]) });
  assert.equal(folded.nodes.find((n: { id: number }) => n.id === apes.id).collapsed, 5, 'a collapsed clade counts its leaves');
  assert.ok(folded.nodes.length < rect.nodes.length);
  const clado = b.parseTree('((A,B),(C,(D,E)));');
  assert.equal(clado.hasLengths, false);
  const px = b.parseTree(BIO_HOSTILE.phyloxml, 'phyloxml');
  assert.equal(px.leaves, 3);
  assert.ok(px.hasSupport);
  const { html, errors } = await fenced('newick', body(BIO.newick!, 'newick'));
  assert.deepEqual(errors, []);
  assert.match(html, /data-tree="rectangular"/);
  assert.match(html, />Homo sapiens</);
  assert.match(html, />98</, 'support values drawn');
  assert.match(html, /data-collapse=/);
  for (const [src, lang] of [[BIO_HOSTILE.newickLabel, 'newick'], [BIO_HOSTILE.phyloxml, 'phyloxml']] as const) {
    const r = await renderAll(React.createElement(ui.FencedBlock, { lang, source: src }));
    assert.deepEqual(r.errors, []);
    assert.doesNotMatch(r.html, NO_LIVE_MARKUP);
    assert.match(r.html, /&lt;script&gt;/);
  }
  assert.throws(() => b.parseTree(BIO_HOSTILE.newickDeep), /nested too deeply/);
  assert.throws(() => b.parseTree(BIO_HOSTILE.newickUnbalanced), /not closed/);
  assert.throws(() => b.parseTree('(A);'), /at least two leaves/);
  const huge = b.parseTree(BIO_HOSTILE.newickHuge);
  assert.equal(huge.leaves, 1500);
  assert.match(huge.notes.join(), /Too large: showing the first 1,500 of 3,000 leaves/);
});

test('plasmids: pUC19 as arcs with arrows, labels that do not overlap, restriction sites found in a sequence; hostile maps', async () => {
  const { b } = await bio();
  const p = b.parsePlasmid(body(BIO.plasmid!, 'plasmid'));
  assert.equal(p.length, 2686);
  assert.equal(p.features.length, 8);
  assert.equal(p.sites.length, 9);
  const amp = p.features.find((f: { label: string }) => f.label === 'AmpR');
  assert.equal(amp.strand, -1);
  assert.match(b.arcPath(amp, p.length, 360, 280, 165, 16), /^M[\d.]+,[\d.]+L[\d.]+,[\d.]+A173,173 /, 'a reverse feature starts with its arrowhead');
  const wrap = b.arcPath({ start: 2600, end: 100, strand: 1, label: 'x', type: 'x', color: '#000' }, 2686, 0, 0, 100, 10);
  assert.match(wrap, /A105,105 0 0 1/, 'a feature across the origin is one short arc');
  assert.equal(b.spanOf({ start: 2600, end: 100 }, 2686), 187);
  const labels = b.placeLabels(p.sites.map((s: { position: number; label: string }, i: number) => ({ angle: b.angleOf(s.position, p.length), text: s.label, kind: 'site', index: i, r: 180 })), 360, 280, 230, 13.5, 560);
  const right = labels.filter((l: { anchor: string }) => l.anchor === 'start').map((l: { y: number }) => l.y).sort((x: number, y: number) => x - y);
  for (let i = 1; i < right.length; i++) assert.ok(right[i] - right[i - 1] >= 13.4, 'labels on one side are at least a line apart');
  const mcs = 'GAATTCGAGCTCGGTACCCGGGGATCCTCTAGAGTCGACCTGCAGGCATGCAAGCTT';
  const found = b.findSites(`${'T'.repeat(30)}${mcs}${'T'.repeat(30)}`, undefined, true);
  assert.deepEqual(found.filter((s: { label: string }) => ['EcoRI', 'BamHI', 'HindIII'].includes(s.label)).map((s: { label: string; position: number }) => `${s.label}@${s.position}`), ['EcoRI@31', 'BamHI@52', 'HindIII@82']);
  assert.ok(b.parsePlasmid(JSON.stringify({ name: 'mini', sequence: `${'A'.repeat(20)}GGATCC${'A'.repeat(20)}`, features: [] })).sites.some((s: { label: string }) => s.label === 'BamHI'), 'sites from a sequence when none are given');
  const { html, errors } = await fenced('plasmid', body(BIO.plasmid!, 'plasmid'));
  assert.deepEqual(errors, []);
  assert.match(html, /data-plasmid-map="circular"/);
  assert.equal((html.match(/data-site="/g) ?? []).length, 9);
  assert.match(html, />2,686 bp</);
  const bad = await fenced('plasmid', BIO_HOSTILE.plasmidLabel);
  assert.deepEqual(bad.errors, []);
  assert.doesNotMatch(bad.html, NO_LIVE_MARKUP);
  assert.doesNotMatch(bad.html, /javascript|background:url/);
  assert.throws(() => b.parsePlasmid(BIO_HOSTILE.plasmidPast), /ends past the plasmid's 100 bp/);
  assert.throws(() => b.parsePlasmid(BIO_HOSTILE.plasmidNotJson), /not valid JSON/);
  assert.throws(() => b.parsePlasmid('{"name": "x"}'), /needs "length"/);
});

test('genome tracks: GFF3 transcripts with exons and CDS, BED12 blocks, GTF, a tracks JSON with a signal; hostile files', async () => {
  const { b } = await bio();
  const gff = b.parseTracks(body(BIO.gff!, 'gff'), 'gff');
  const items = gff.tracks[0].items;
  const ins = items.find((t: { name: string }) => t.name === 'NM_000207.3');
  assert.ok(ins, `the INS transcript (${items.map((t: { name: string }) => t.name).join(', ')})`);
  assert.equal(ins.exons.length, 3);
  assert.deepEqual(ins.cds, [2160061, 2160571]);
  assert.equal(ins.strand, -1);
  assert.equal(items.find((t: { name: string }) => t.name === 'NM_199292.3').exons.length, 10);
  assert.ok(items.some((t: { type: string }) => t.type === 'enhancer'), 'stand-alone features are drawn too');
  assert.ok(!items.some((t: { type: string }) => t.type === 'gene'), 'a gene with a transcript is not drawn twice');
  const bed = b.parseTracks(body(BIO.bed!, 'bed'), 'bed');
  const tp53 = bed.tracks[0].items[0];
  assert.equal(tp53.name, 'TP53');
  assert.equal(tp53.exons.length, 11);
  assert.deepEqual(tp53.exons[0], [7668402, 7669690], 'BED starts become 1-based');
  assert.deepEqual(tp53.cds, [7669609, 7676594]);
  const gtf = b.parseTracks('chr1\tx\texon\t100\t200\t.\t+\t.\tgene_id "G1"; transcript_id "T1"; gene_name "ABC";\nchr1\tx\texon\t300\t400\t.\t+\t.\tgene_id "G1"; transcript_id "T1"; gene_name "ABC";\nchr1\tx\tCDS\t150\t350\t.\t+\t0\tgene_id "G1"; transcript_id "T1";', 'gtf');
  assert.equal(gtf.tracks[0].items[0].name, 'ABC');
  assert.equal(gtf.tracks[0].items[0].exons.length, 2);
  const tj = b.parseTracks(body(BIO.tracks!, 'tracks'), 'tracks');
  assert.equal(tj.tracks[1].kind, 'signal');
  assert.equal(tj.tracks[1].bins.length, 70);
  assert.deepEqual(b.initialView(tj, 'chr11'), [2156000, 2163000]);
  for (const [lang, src] of [['gff', body(BIO.gff!, 'gff')], ['bed', body(BIO.bed!, 'bed')], ['tracks', body(BIO.tracks!, 'tracks')]] as const) {
    const { html, errors } = await fenced(lang, src);
    assert.deepEqual(errors, [], lang);
    assert.match(html, /data-genome-tracks/, lang);
    assert.match(html, /aria-label="Zoom in"/, lang);
  }
  const bad = await fenced('gff', BIO_HOSTILE.gffLabel);
  assert.deepEqual(bad.errors, []);
  assert.doesNotMatch(bad.html, NO_LIVE_MARKUP);
  assert.match(bad.html, /&lt;script&gt;alert/);
  assert.throws(() => b.parseTracks(BIO_HOSTILE.bedBad, 'bed'), /BED line 1: start and end/);
  assert.throws(() => b.parseTracks('chr1\t1', 'bed'), /needs chrom, start and end/);
  const many = b.parseTracks(Array.from({ length: 6000 }, (_, i) => `chr1\t${i * 10}\t${i * 10 + 5}\tf${i}`).join('\n'), 'bed');
  assert.match(many.notes.join(), /Too large: showing the first 5,000 of 6,000 features/);
});

test('proteins: UniProt-style feature tracks; the 3D view (cartoon, chains, ligands, residue picker) framed without same-origin', async () => {
  const { b } = await bio();
  const p = b.parseProteinFeatures(body(BIO.uniprot!, 'uniprot'));
  assert.equal(p.length, 76);
  assert.equal(p.features.filter((f: { category: string }) => f.category === 'PTMs').length, 8);
  assert.equal(p.features.filter((f: { category: string }) => f.category === 'Structure').length, 7);
  const rest = b.parseProteinFeatures(JSON.stringify({ primaryAccession: 'P0CG48', sequence: { value: UBIQUITIN, length: 76 }, features: [{ type: 'Domain', location: { start: { value: 1 }, end: { value: 76 } }, description: 'Ubiquitin-like' }] }));
  assert.equal(rest.accession, 'P0CG48');
  assert.equal(rest.features[0].end, 76, "UniProt's own JSON is read too");
  const { html, errors } = await fenced('uniprot', body(BIO.uniprot!, 'uniprot'));
  assert.deepEqual(errors, []);
  assert.match(html, /data-protein-tracks/);
  assert.match(html, /data-category="PTMs"/);
  const bad = await fenced('uniprot', BIO_HOSTILE.uniprotLabel);
  assert.deepEqual(bad.errors, []);
  assert.doesNotMatch(bad.html, NO_LIVE_MARKUP);
  assert.throws(() => b.parseProteinFeatures('{"features": []}'), /give "sequence" or "length"/);
  // 3D: the file travels base64 into a no-network page; markup in it never reaches the document.
  const doc = b.proteinDocument(BIO_HOSTILE.pdbScript, 'pdb', 'harness://preview/runtime/artifact-runtime.js', true);
  assert.match(doc, /<script src="harness:\/\/preview\/runtime\/3Dmol-min.js"><\/script>/);
  assert.match(doc, /connect-src 'none'/);
  assert.doesNotMatch(doc, /xss-pdb3d/);
  assert.match(doc, /colorscheme:'ssJmol'/, 'secondary structure by default');
  assert.match(doc, /colorscheme:'chain'/);
  assert.match(doc, /hetflag:true,not:\{resn:\['HOH','WAT'\]\}/, 'ligands without water');
  assert.match(doc, /aria-label','Residue'/, 'a residue picker');
  assert.match(doc, /background:#16181d/, 'dark theme');
  const b64 = /data-b64="([^"]+)"/.exec(doc)![1]!;
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), BIO_HOSTILE.pdbScript);
  const pdb = coiledCoilPdb();
  assert.equal((pdb.match(/^ATOM/gm) ?? []).length, 264);
  assert.match(pdb, /^HELIX {4}1 {3}1 ARG A {4}1 {2}ARG A {3}33/m);
  const three = await fenced('pdb', pdb);
  assert.deepEqual(three.errors, []);
  assert.match(three.html, /data-widget="3D structure"/);
  assert.match(three.html, /data-artifact-frame="molecule"/);
  assert.match(three.html, /sandbox="allow-scripts"/);
  assert.doesNotMatch(three.html, /allow-same-origin/);
  assert.match((await fenced('pdb', BIO_HOSTILE.pdbEmpty)).errors.join(), /no ATOM or HETATM records/);
});

test('pathways: typed glyphs and arrowheads laid out by the real Graphviz; labels can never become DOT syntax', async () => {
  const { b, ui } = await bio();
  const p = b.parsePathway(body(BIO.pathway!, 'pathway'));
  assert.equal(p.nodes.length, 13);
  assert.equal(p.edges.length, 12);
  const dot = b.pathwayDot(p);
  assert.equal(ui.checkDot(dot), undefined);
  for (const k of ['shape=cds', 'shape=octagon', 'shape=ellipse', 'shape=hexagon', 'shape=diamond', 'arrowhead=tee', 'arrowhead=empty', 'arrowhead=odot', 'style=dashed']) assert.ok(dot.includes(k), k);
  const gv = await Graphviz.load();
  const svg = ui.cleanGraphSvg(gv.dot(dot, 'svg'));
  assert.equal((svg.match(/class="node"/g) ?? []).length, 13);
  assert.equal((svg.match(/class="edge"/g) ?? []).length, 12);
  assert.match(svg, />GLUT4 \(SLC2A4\)</);
  const hostile = b.parsePathway(BIO_HOSTILE.pathwayLabel);
  const hdot = b.pathwayDot(hostile, true);
  assert.equal(ui.checkDot(hdot), undefined, 'a label that mentions image= is not refused as a file');
  const hsvg = ui.cleanGraphSvg(gv.dot(hdot, 'svg'));
  assert.equal((hsvg.match(/class="node"/g) ?? []).length, 2, 'an edge label cannot add a node');
  assert.doesNotMatch(hsvg, NO_LIVE_MARKUP);
  assert.match(hsvg, /&lt;img src=x/);
  assert.throws(() => b.parsePathway(BIO_HOSTILE.pathwayMissing), /edge 1 \(a -> ghost\) names a node that is not in "nodes"/);
  assert.throws(() => b.parsePathway('{"nodes": [{"id": "a"}, {"id": "a"}]}'), /two nodes have the id "a"/);
  const { html, errors } = await fenced('pathway', body(BIO.pathway!, 'pathway'));
  assert.deepEqual(errors, []);
  assert.match(html, /data-pathway="13"/);
  assert.match(html, /data-pathway-legend/);
  const big = b.parsePathway(JSON.stringify({ nodes: Array.from({ length: 400 }, (_, i) => ({ id: `n${i}` })), edges: [{ from: 'n0', to: 'n399' }] }));
  assert.match(big.notes.join(), /showing the first 300 of 400 nodes/);
  assert.equal(big.edges.length, 0, 'edges to nodes past the limit are dropped');
});

/** Compiles a Vega-Lite spec and renders it to SVG with the expression interpreter (no eval), as the app does. */
async function vegaSvg(spec: Record<string, unknown>): Promise<string> {
  const vl = await import('vega-lite'); const vega = await import('vega'); const { expressionInterpreter } = await import('vega-interpreter');
  const compiled = vl.compile({ ...spec, width: 600 } as never).spec;
  const view = new vega.View(vega.parse(compiled, undefined, { ast: true }), { renderer: 'none', expr: expressionInterpreter } as never);
  return view.toSVG();
}

test('statistics: volcano, MA, Kaplan-Meier (with a log-rank test) and Manhattan as Vega-Lite; all render to SVG through the interpreter', async () => {
  const { b, ui } = await bio();
  const v = b.parseBioPlot('volcano', body(BIO.volcano!, 'volcano'));
  assert.match(v.summary, /^398 genes · \d+ up · \d+ down/);
  for (const g of ['VEGFA', 'CA9', 'MKI67']) assert.ok(v.spec.layer[3].data.values.some((x: { gene: string }) => x.gene === g), `${g} is labelled`);
  assert.equal(ui.parseVizSpec(JSON.stringify(v.spec)).error, undefined, 'passes the figure checks (inline data, safe expressions)');
  const vs = await vegaSvg(v.spec);
  assert.match(vs, />VEGFA</);
  assert.match(vs, /Hypoxia vs normoxia/);
  const ma = b.parseBioPlot('ma', body(BIO.ma!, 'ma'));
  assert.match(await vegaSvg(ma.spec), /mean expression \(log scale\)/);
  // Gehan's 6-MP leukaemia data: the textbook Kaplan-Meier and log-rank results.
  const sixMp = { name: '6-MP', time: [6, 6, 6, 7, 10, 13, 16, 22, 23, 6, 9, 10, 11, 17, 19, 20, 25, 32, 32, 34, 35], event: [1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0].map(Boolean) };
  const placebo = { name: 'placebo', time: [1, 1, 2, 2, 3, 4, 4, 5, 5, 8, 8, 8, 8, 11, 11, 12, 12, 15, 17, 22, 23], event: Array(21).fill(true) };
  const km = b.kmCurve(sixMp);
  assert.deepEqual(km.steps.slice(1, 8).map((s: { s: number }) => Math.round(s.s * 1000) / 1000), [0.857, 0.807, 0.753, 0.69, 0.627, 0.538, 0.448]);
  assert.equal(km.median, 23);
  assert.equal(km.censored.length, 12);
  const lr = b.logRank([sixMp, placebo]);
  assert.ok(Math.abs(lr.chi2 - 16.79) < 0.05, `chi2 ${lr.chi2}`);
  assert.ok(lr.p < 5e-5 && lr.p > 3e-5, `p ${lr.p}`);
  assert.ok(Math.abs(b.chiSquareSf(3.841, 1) - 0.05) < 1e-3);
  const kmPlot = b.parseBioPlot('kaplan-meier', body(BIO.km!, 'kaplan-meier'));
  assert.match(kmPlot.summary, /2 groups · 80 subjects · log-rank p = /);
  assert.match(await vegaSvg(kmPlot.spec), /CA9 high \(n=40/);
  const mh = b.parseBioPlot('manhattan', body(BIO.manhattan!, 'manhattan'));
  assert.match(mh.summary, /22 chromosomes · \d+ genome-wide significant/);
  const ms = await vegaSvg(mh.spec);
  assert.match(ms, />TCF7L2</);
  assert.match(ms, />22</, 'chromosome names on the axis (labelExpr through the interpreter)');
  for (const [k, src, re] of [['volcano', BIO_HOSTILE.volcanoEmpty, /no point has a log2 fold change/], ['manhattan', BIO_HOSTILE.manhattanChr, /is not a chromosome name/], ['kaplan-meier', BIO_HOSTILE.kmMismatch, /same length/], ['volcano', '[1,', /not valid JSON/]] as const) {
    assert.throws(() => b.parseBioPlot(k, src), re, k);
  }
  const huge = b.parseBioPlot('volcano', BIO_HOSTILE.volcanoHuge);
  assert.match(huge.notes.join(), /Too large: showing the first 6,000 of 20,000 points/);
  const hostile = b.parseBioPlot('volcano', BIO_HOSTILE.volcanoLabel);
  const hs = await vegaSvg(hostile.spec);
  assert.doesNotMatch(hs, /<script/);
  assert.match(hs, /&lt;script&gt;alert/);
  const { html, errors } = await fenced('volcano', body(BIO.volcano!, 'volcano'));
  assert.deepEqual(errors, []);
  assert.match(html, /data-bioplot="volcano"/);
  assert.match(html, /data-chart="vega"/);
});

test('heatmap: z-scores, average-linkage clustering that groups the hypoxia genes, dendrograms; hostile matrices', async () => {
  const { b } = await bio();
  const h = b.parseHeatmap(body(BIO.heatmap!, 'heatmap'));
  assert.equal(h.scale, 'row');
  assert.ok(h.rowTree && h.colTree);
  const order = h.rowOrder.map((i: number) => h.rows[i]);
  const hyp = ['VEGFA', 'CA9', 'EGLN3', 'BNIP3', 'PGK1', 'LDHA'].map((g) => order.indexOf(g)).sort((x, y) => x - y);
  assert.equal(hyp[5]! - hyp[0]!, 5, `the six hypoxia genes cluster together (${order.join(', ')})`);
  const cols = h.colOrder.map((i: number) => h.cols[i]);
  assert.deepEqual([...cols.slice(0, 3)].sort().join() === 'Hyp 1,Hyp 2,Hyp 3' || [...cols.slice(0, 3)].sort().join() === 'Norm 1,Norm 2,Norm 3', true, `samples split by condition (${cols.join(', ')})`);
  const d = b.hclust([[0], [1], [10], [11]]);
  assert.deepEqual(d.merges.map((m: { height: number }) => m.height), [1, 1, 10]);
  const seg = b.dendrogramSegments(d);
  assert.equal(seg.segs.length, 9);
  assert.equal(seg.maxH, 10);
  const { html, errors } = await fenced('heatmap', body(BIO.heatmap!, 'heatmap'));
  assert.deepEqual(errors, []);
  assert.match(html, /data-heatmap="12x6"/);
  assert.match(html, /data-dendrogram="rows"/);
  assert.match(html, /data-dendrogram="cols"/);
  assert.throws(() => b.parseHeatmap(BIO_HOSTILE.heatmapRagged), /every row of "values" needs 2 numbers/);
  const bad = await fenced('heatmap', BIO_HOSTILE.heatmapLabel);
  assert.deepEqual(bad.errors, []);
  assert.doesNotMatch(bad.html, NO_LIVE_MARKUP);
  const big = b.parseHeatmap(JSON.stringify({ values: Array.from({ length: 320 }, (_, i) => [i, i + 1]), cluster: 'none' }));
  assert.match(big.notes.join(), /showing the first 300 of 320 rows/);
});

test('malformed biology blocks show a readable error in the block frame, never a crash; arriving blocks wait', async () => {
  const { ui, React } = await loadUi();
  const md = (lang: string, src: string) => renderAll(React.createElement(ui.Markdown, { text: `Before.\n\n\`\`\`${lang}\n${src}\n\`\`\`\n\nAfter.` }));
  for (const [lang, src, re] of [['plasmid', BIO_HOSTILE.plasmidNotJson, /not valid JSON/], ['newick', BIO_HOSTILE.newickUnbalanced, /not closed/], ['msa', BIO_HOSTILE.msaUneven, /columns/], ['heatmap', BIO_HOSTILE.heatmapRagged, /numbers/]] as const) {
    const r = await md(lang, src);
    assert.match(r.errors.join(), re, lang);
    assert.match(r.html, /After\./, `${lang}: the rest of the reply still renders`);
  }
  const arriving = await renderAll(React.createElement(ui.FencedBlock, { lang: 'plasmid', source: '{"name": "pUC', streaming: true }));
  assert.deepEqual(arriving.errors, []);
  assert.match(arriving.html, /Plasmid map(<!-- -->)? arriving…/);
});

test('biology kitchen sink: every block renders through Markdown, lazily, without an error', async () => {
  const { ui, React } = await loadUi();
  const { html, errors } = await renderAll(React.createElement(ui.Markdown, { text: BIO_KITCHEN_SINK }));
  assert.deepEqual(errors, []);
  for (const marker of ['data-widget="Sequence"', 'data-widget="Alignment"', 'data-widget="Tree"', 'data-widget="Plasmid map"', 'data-widget="Genome tracks"', 'data-widget="3D structure"', 'data-widget="Protein features"', 'data-widget="Pathway"', 'data-widget="Volcano plot"', 'data-widget="MA plot"', 'data-widget="Heatmap"', 'data-widget="Survival curve"', 'data-widget="Manhattan plot"', 'data-seq-map', 'data-msa-conservation', 'data-tree=', 'data-plasmid-map', 'data-genome-tracks', 'data-protein-tracks', 'data-pathway-legend', 'data-heatmap-svg', 'data-artifact-frame="molecule"']) {
    assert.ok(html.includes(marker), `kitchen sink has ${marker}`);
  }
  assert.equal((html.match(/data-widget="Genome tracks"/g) ?? []).length, 3);
  assert.equal((html.match(/data-widget="Sequence"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /data-render-error/);
});
