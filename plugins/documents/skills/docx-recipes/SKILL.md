---
name: docx-recipes
description: Working code for Word documents with the docx library - styles, title block, headings, bullets, tables with header rows, captions, header/footer with page numbers, page breaks. Use when building a .docx.
---
# docx recipes

`add_library docx` if `node_modules/docx` is missing. Build with a script (`node build-doc.mjs`) and re-run it after every change.

```js
// build-doc.mjs
import fs from 'node:fs';
import { AlignmentType, BorderStyle, Document, Footer, Header, HeadingLevel, LevelFormat, Packer, PageBreak, PageNumber,
  Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';

const C = { text: '1F2937', muted: '6B7280', accent: '1D4ED8', head: 'E8EEF9', line: 'CBD5E1', font: 'Calibri' };

const p = (text, o = {}) => new Paragraph({ spacing: { after: 120 }, ...o, children: [new TextRun({ text, ...(o.run ?? {}) })] });
const h1 = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_1 });
const h2 = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_2 });
const bullet = (text) => new Paragraph({ text, numbering: { reference: 'bullets', level: 0 }, spacing: { after: 60 } });
const caption = (text) => p(text, { run: { italics: true, color: C.muted, size: 18 } });

function table(header, rows, widths) {
  const border = { style: BorderStyle.SINGLE, size: 4, color: C.line };
  const borders = { top: border, bottom: border, left: border, right: border };
  const cell = (text, i, isHead) => new TableCell({
    width: { size: widths[i], type: WidthType.PERCENTAGE }, borders,
    shading: isHead ? { type: ShadingType.CLEAR, color: 'auto', fill: C.head } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({ alignment: i > 0 && /^[-+$\d.,% ]+$/.test(text) ? AlignmentType.RIGHT : AlignmentType.LEFT,
      children: [new TextRun({ text, bold: isHead })] })],
  });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({ tableHeader: true, children: header.map((t, i) => cell(t, i, true)) }),
      ...rows.map((r) => new TableRow({ cantSplit: true, children: r.map((t, i) => cell(t, i, false)) }))],
  });
}

const doc = new Document({
  creator: 'Acme Strategy', title: 'Market Entry Assessment',
  styles: {
    default: { document: { run: { font: C.font, size: 22, color: C.text }, paragraph: { spacing: { line: 288 } } } }, // 11 pt, 1.2 lines
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 32, bold: true, color: C.accent }, paragraph: { spacing: { before: 360, after: 120 }, keepNext: true } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 26, bold: true, color: C.text }, paragraph: { spacing: { before: 240, after: 80 }, keepNext: true } },
    ],
  },
  numbering: { config: [{ reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: 360, hanging: 260 } } } }] }] },
  sections: [{
    properties: { page: { margin: { top: 1300, bottom: 1300, left: 1300, right: 1300 } } }, // twips (1440 = 1 in)
    headers: { default: new Header({ children: [p('Market Entry Assessment', { alignment: AlignmentType.RIGHT, run: { color: C.muted, size: 18 } })] }) },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER,
      children: [new TextRun({ children: ['Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES], size: 18, color: C.muted })] })] }) },
    children: [
      p('Market Entry Assessment', { run: { size: 48, bold: true, color: C.accent }, spacing: { before: 2400, after: 200 } }),
      p('Germany, mid-market logistics software', { run: { size: 28, color: C.muted } }),
      p('Prepared for the Executive Committee | 20 October 2026 | v1.0', { run: { size: 20, color: C.muted }, spacing: { after: 600 } }),
      new Paragraph({ children: [new PageBreak()] }),
      h1('1. Executive summary'),
      p('We recommend entering Germany in Q2 2027 through a partner-led model. The addressable market is EUR 410M, growing 9% a year.'),
      bullet('Demand: 1,900 target firms; 31% plan to replace their current system within two years.'),
      bullet('Fit: our routing module covers 80% of the requirements in the top three tenders.'),
      h1('2. Market'),
      h2('2.1 Size and growth'),
      table(['Segment', 'Firms', 'Spend (EUR M)', 'Growth'], [['Freight forwarders', '820', '190', '11%'], ['3PL providers', '640', '150', '8%'], ['Shippers', '440', '70', '6%']], [40, 20, 22, 18]),
      caption('Table 1: Addressable market by segment, 2026 (source: Destatis, company research).'),
    ],
  }],
});

fs.writeFileSync('report.docx', await Packer.toBuffer(doc));
console.log('wrote report.docx');
```

## Notes
- Sizes are half-points (`size: 22` = 11 pt); spacing and margins are twips (1440 = 1 inch, 567 = 1 cm).
- Headings must use `heading: HeadingLevel.HEADING_1` (real styles) so the outline and navigation work. `keepNext: true` keeps a heading with its paragraph.
- A table of contents (`new TableOfContents(...)`) is a field Word fills in when the file is opened; renderers show it empty. For a short document write the contents list as text, or leave it out.
- Images: `new ImageRun({ type: 'png', data: fs.readFileSync('chart.png'), transformation: { width: 600, height: 340 } })` inside a Paragraph. Make charts as PNG files first (e.g. an SVG you render, or a chart drawn to canvas in the browser tool).
