// Hidden checks for the board deck: slide count and the numbers that must appear.
// Reads the PDF with pdf.js (installed with the harness), so it needs no poppler and
// runs the same on Linux, macOS and Windows.
//   node check-deck.mjs [deck.pdf]   (run in the workspace)
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '..', '..', '..', 'package.json'));
const pdfjs = await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
const file = path.resolve(process.argv[2] ?? 'deck.pdf');
let pages = 0;
let text = '';
try {
  const task = pdfjs.getDocument({ data: new Uint8Array(await fs.readFile(file)), isEvalSupported: false, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  pages = doc.numPages;
  for (let n = 1; n <= pages; n++) text += ' ' + (await (await doc.getPage(n)).getTextContent()).items.map((it) => ('str' in it ? it.str : '')).join(' ');
  await task.destroy();
} catch (e) { console.log(`cannot read ${path.basename(file)}: ${e.message}`); process.exit(1); }
text = text.replace(/\s+/g, ' ');
let fail = false;
if (!(pages >= 8 && pages <= 12)) { console.log(`slide count ${pages}, expected 8-12`); fail = true; }
for (const n of ['4.2', '16.8', '3.0M', '4.8', '38%', '112%', '77%', '2.1%']) {
  if (!text.includes(n)) { console.log(`missing ${n}`); fail = true; }
}
if (!fail) console.log(`${pages} slides; all key numbers present`);
process.exit(fail ? 1 : 0);
