---
name: rich-output
description: Exact formats of the app's biology fences (fasta, msa, newick, plasmid, gff/bed/tracks, pdb, uniprot, pathway, volcano, ma, heatmap, kaplan-meier, manhattan). Load before writing one.
---

# Biology fences

Each block is a fenced code block whose language is the name below; the app draws it (and shows a
readable error if it is malformed). Coordinates are 1-based and inclusive unless the file format
says otherwise (BED is 0-based). Keep data inline and compact; very large inputs are cut to the first
N items with a note, so summarise big tables rather than pasting them whole.

## Sequences: `fasta` (or `sequence`)

FASTA text, bare letters, or JSON with features (drawn as tracks; click selects). DNA, RNA or protein
is detected; the viewer shows GC, weight, a reverse complement and 3-frame translation.

```fasta
>INS_CDS Homo sapiens preproinsulin
ATGGCCCTGTGGATGCGCCTCCTGCCCCTGCTGGCGCTGCTGGCCCTCTGGGGACCTGACCCAGCC
```
```sequence
{"name": "INS", "type": "dna", "sequence": "ATGGCC...", "features": [{"start": 1, "end": 72, "label": "signal peptide", "type": "sig_peptide", "strand": 1}]}
```

## Alignments: `msa` (or `clustal`)

Aligned FASTA (every row the same length, gaps as `-`) or CLUSTAL text.

```msa
>Human
FVNQHLCGSHLVEALYLVCGERGFFYTPKT
>Chicken
AANQHLCGSHLVEALYLVCGERGFFYSPKA
```

## Trees: `newick` (or `phyloxml`)

Branch lengths after `:`; numeric internal labels are support values. Underscores read as spaces.

```newick
(((Homo_sapiens:0.0067,Pan_troglodytes:0.0072)100:0.0024,Gorilla_gorilla:0.0089)100:0.0097,Pongo_abelii:0.0183);
```

## Plasmid maps: `plasmid`

`strand`: 1, -1 or 0. A feature with start > end crosses the origin. `sites` are restriction sites;
without them, unique cutters are found when `sequence` is given. `type` picks the colour (CDS,
promoter, terminator, rep_origin, primer_bind, protein_bind, misc_feature...).

```plasmid
{"name": "pUC19", "length": 2686, "features": [{"start": 1626, "end": 2486, "label": "AmpR", "type": "CDS", "strand": -1}, {"start": 853, "end": 1441, "label": "ori", "type": "rep_origin", "strand": -1}], "sites": [{"position": 396, "label": "EcoRI"}, {"position": 447, "label": "HindIII"}]}
```

## Genome tracks: `gff` / `gtf` / `bed`, or `tracks` JSON

GFF3, GTF and BED (BED12 blocks become exons; thickStart/thickEnd the CDS) as the files are. The
JSON adds signal tracks:

```tracks
{"region": {"chrom": "chr11", "start": 2156000, "end": 2163000}, "tracks": [
 {"name": "Genes", "type": "genes", "features": [{"name": "INS", "chrom": "chr11", "start": 2159779, "end": 2161209, "strand": "-", "exons": [[2159779, 2160215], [2160394, 2160597], [2161168, 2161209]], "cds": [2160061, 2160571]}]},
 {"name": "H3K27ac", "type": "signal", "values": [{"start": 2158000, "end": 2158500, "value": 12.5}]}]}
```

## Proteins: `pdb` / `cif` (3D) and `uniprot` (feature tracks)

`pdb`/`cif`: the file text; drawn as a cartoon by secondary structure with chain colours, ligands
and a residue picker. `uniprot`: features by UniProt type (Domain, Region, Site, Binding site, Active
site, Modified residue, Disulfide bond, Signal, Transmembrane, Helix, Strand...).

```uniprot
{"name": "Ubiquitin", "accession": "P0CG48", "sequence": "MQIFVKTLTGKTITLEVEPSDTIENVKAKIQDKEGIPPDQQRLIFAGKQLEDGRTLSDYNIQKESTLHLVLRLRGG", "features": [{"type": "Domain", "start": 1, "end": 76, "description": "Ubiquitin-like"}, {"type": "Cross-link", "start": 48, "end": 48, "description": "K48 isopeptide"}]}
```

## Pathways: `pathway`

Node `type`: gene, protein, metabolite, complex, phenotype, drug. Edge `type`: activation,
inhibition, binding, conversion, catalysis (optional `label`). `direction`: TB or LR.

```pathway
{"title": "PI3K-AKT", "nodes": [{"id": "PIP2", "type": "metabolite"}, {"id": "PIP3", "type": "metabolite"}, {"id": "PI3K", "type": "protein"}, {"id": "AKT", "type": "protein"}, {"id": "PTEN", "type": "protein"}],
 "edges": [{"from": "PIP2", "to": "PIP3", "type": "conversion"}, {"from": "PI3K", "to": "PIP3", "type": "catalysis"}, {"from": "PTEN", "to": "PIP3", "type": "inhibition"}, {"from": "PIP3", "to": "AKT", "type": "activation"}]}
```

## Statistics: `volcano`, `ma`, `heatmap`, `kaplan-meier`, `manhattan`

```volcano
{"title": "Hypoxia vs normoxia", "fc": 1, "p": 0.05, "labels": 10, "points": [{"gene": "VEGFA", "log2fc": 3.2, "padj": 1e-20}, {"gene": "MKI67", "log2fc": -1.8, "padj": 1e-6}]}
```
`ma`: the same points with `"baseMean"` (mean expression) instead of needing p.

```heatmap
{"title": "Expression", "rows": ["VEGFA", "CA9", "MKI67"], "cols": ["N1", "N2", "H1", "H2"], "values": [[6.1, 6.3, 9.0, 9.2], [5.0, 5.2, 8.8, 8.5], [8.0, 7.9, 6.1, 6.0]], "scale": "row", "cluster": "both"}
```
`scale`: row (z-score), col or none; `cluster`: both, rows, cols or none.

```kaplan-meier
{"title": "Overall survival", "timeUnit": "months", "groups": [{"name": "High", "time": [5, 8, 12, 20], "event": [1, 1, 0, 1]}, {"name": "Low", "time": [10, 25, 30, 41], "event": [0, 1, 0, 0]}]}
```
`event`: 1 = event, 0 = censored. A log-rank p value is computed.

```manhattan
{"title": "T2D GWAS", "threshold": 5e-8, "suggestive": 1e-5, "snps": [{"chr": "10", "pos": 112998590, "p": 1e-30, "id": "rs7903146", "gene": "TCF7L2"}]}
```
