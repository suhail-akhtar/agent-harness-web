---
name: pptxgenjs-recipes
description: Working PptxGenJS code for decks - theme, master slide, title, bullets, two columns, native charts with readable labels, tables, notes - and how to size text boxes so nothing overflows or shrinks. Use when building a .pptx.
---
# PptxGenJS recipes

`add_library pptxgenjs` if `node_modules/pptxgenjs` is missing. Build with a script (`node build-deck.mjs`) and re-run it after every change.

```js
// build-deck.mjs
import PptxGenJS from 'pptxgenjs';

const T = { // theme: one place for every colour, font and position
  dark: '0B1F3A', text: '1F2937', muted: '6B7280', light: 'F5F7FA', accent: '2563EB', accent2: '10B981', line: 'D1D5DB',
  font: 'Arial', m: 0.6, W: 13.33, H: 7.5,
};
const pptx = new PptxGenJS();
pptx.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in
pptx.title = 'Q3 Board Update';

pptx.defineSlideMaster({
  title: 'BODY',
  background: { color: 'FFFFFF' },
  objects: [
    { line: { x: T.m, y: 7.0, w: T.W - 2 * T.m, h: 0, line: { color: T.line, width: 0.75 } } },
    { text: { text: 'Acme Inc. | Confidential', options: { x: T.m, y: 7.05, w: 6, h: 0.3, fontFace: T.font, fontSize: 10, color: T.muted } } },
  ],
  slideNumber: { x: T.W - T.m - 0.6, y: 7.05, w: 0.6, h: 0.3, fontFace: T.font, fontSize: 10, color: T.muted, align: 'right' },
});

function titled(title) {
  const s = pptx.addSlide({ masterName: 'BODY' });
  s.addText(title, { x: T.m, y: 0.35, w: T.W - 2 * T.m, h: 0.9, fontFace: T.font, fontSize: 28, bold: true, color: T.dark, valign: 'top', fit: 'none' });
  return s;
}
const bullets = (items) => items.map((t) => ({ text: t, options: { bullet: { indent: 18 }, paraSpaceAfter: 8 } }));

// Title slide
const cover = pptx.addSlide();
cover.background = { color: T.dark };
cover.addText('Q3 2026 Board Update', { x: T.m, y: 2.4, w: 12, h: 1.2, fontFace: T.font, fontSize: 40, bold: true, color: 'FFFFFF' });
cover.addText('Revenue up 18%, churn down, cash runway 26 months', { x: T.m, y: 3.6, w: 12, h: 0.6, fontFace: T.font, fontSize: 20, color: 'CBD5E1' });

// Bullets + chart, two columns
const s = titled('Revenue grew 18% quarter on quarter to $4.2M');
s.addText(bullets(['Enterprise deals drove 70% of new ARR', 'Net revenue retention reached 112%', 'Pricing change lifted average deal size 9%']),
  { x: T.m, y: 1.5, w: 5.4, h: 4.8, fontFace: T.font, fontSize: 18, color: T.text, valign: 'top' });
s.addChart(pptx.charts.BAR, [{ name: 'Revenue ($M)', labels: ['Q4 25', 'Q1 26', 'Q2 26', 'Q3 26'], values: [2.9, 3.2, 3.56, 4.2] }], {
  x: 6.4, y: 1.5, w: 6.3, h: 5.1, barDir: 'col', chartColors: [T.accent],
  showValue: true, dataLabelFormatCode: '$0.0"M"', dataLabelFontSize: 12, dataLabelColor: T.text, dataLabelPosition: 'outEnd',
  valAxisLabelFormatCode: '$0.0', valAxisMinVal: 0, valAxisLabelFontSize: 11, catAxisLabelFontSize: 12,
  valGridLine: { color: 'E5E7EB', size: 0.5 }, showLegend: false,
  showTitle: true, title: 'Quarterly revenue ($M)', titleFontSize: 14, titleColor: T.text,
});
s.addText('Source: finance close, 30 Sep 2026', { x: T.m, y: 6.65, w: 8, h: 0.3, fontFace: T.font, fontSize: 10, color: T.muted });
s.addNotes('Lead with the 18%; enterprise is the driver.');

// Table
const t = titled('Unit economics improved on every measure');
const head = (x, align = 'left') => ({ text: x, options: { bold: true, color: 'FFFFFF', fill: { color: T.dark }, align } });
const num = (x, o = {}) => ({ text: x, options: { align: 'right', ...o } }); // numbers right-aligned
const good = (x) => num(x, { color: T.accent2, bold: true });
t.addTable([
  [head('Metric'), head('Q2', 'right'), head('Q3', 'right'), head('Change', 'right')],
  ['Gross margin', num('74%'), num('77%'), good('+3 pts')],
  ['CAC payback (months)', num('16'), num('13'), good('-3')],
  ['Monthly churn', num('2.6%'), num('2.1%'), good('-0.5 pts')],
], { x: T.m, y: 1.6, w: 9, colW: [4.2, 1.6, 1.6, 1.6], fontFace: T.font, fontSize: 16, color: T.text,
     border: { type: 'solid', pt: 0.5, color: T.line }, align: 'left', valign: 'middle', rowH: 0.55, autoPage: false });

await pptx.writeFile({ fileName: 'deck.pptx' });
console.log('wrote deck.pptx');
```

## Sizing text so it fits (no auto-shrink)
- Average character width is about half the font size. Characters per line = `w_in * 72 / (0.5 * pt)`; lines = characters / that; height needed = `lines * pt * 1.3 / 72` in, plus 0.1.
  Example: 18 pt in a 5.4 in box holds ~43 characters per line; 5 bullets of ~60 characters = 10 lines = 3.3 in.
- If it does not fit: cut words, split the slide, or widen the box. Never `fit: 'shrink'` (render reports it as TEXT TOO SMALL).
- Keep titles to one line at 28 pt (~65 characters on a full-width title) or two lines at most.

## Charts
- Types: `pptx.charts.BAR` (with `barDir: 'col'|'bar'`), `LINE`, `PIE`, `DOUGHNUT`, `AREA`, `SCATTER`. Several series = several objects in the data array.
- **Set number formats**: `dataLabelFormatCode` and `valAxisLabelFormatCode` (e.g. `'0.0'`, `'0%'`, `'#,##0'`, `'$0.0"M"'`). Without them labels round to whole numbers (2.9 shows as "3").
- Highlight one bar: one series per colour, or `chartColors` with one entry per point and `varyColors: true` (pie/doughnut).
- Pie/doughnut: `showPercent: true`, `showLegend: true`, `legendPos: 'r'`; at most 5 slices.

## Images
`s.addImage({ path: 'assets/photo.png', x, y, w, h })` (path in the workspace) or `{ data: 'image/png;base64,...' }`. No URLs (the build runs offline).
