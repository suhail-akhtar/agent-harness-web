// The rich renderers of packages/ui, rendered to HTML in Node: each kind of block draws the structure
// it should, and hostile input comes out inert. (Mermaid, ECharts, Vega and live artifacts need a
// browser; the desktop e2e test checks those in Electron.)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { ESCAPE_ARTIFACT, HOSTILE, KITCHEN_SINK, RICH, STREAM_TEXT } from './fixtures/desktop/rich.ts';
import { ICON_NAMES } from '../packages/plugin-ui/src/index.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Typed loosely: the package is TSX (the root type check has no JSX); its own tsconfig checks it.
type UI = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let ui: UI;
let React: typeof import('react');
let server: typeof import('react-dom/server');

async function load() {
  if (ui) return;
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hx-ui-')), 'ui.mjs');
  // React stays external (one copy); the heavy browser-only libraries load lazily and never run here.
  await build({ entryPoints: [path.join(root, 'packages/ui/src/index.ts')], outfile: out, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', external: ['react', 'react-dom', 'react/*', 'react-dom/*', 'mermaid', 'echarts', 'vega-embed', 'vega-interpreter', 'smiles-drawer', '@hpcc-js/wasm-graphviz', '3dmol'], banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" }, logLevel: 'silent', absWorkingDir: root });
  // Resolve its imports from the repository (copy next to node_modules).
  const local = path.join(root, 'node_modules', '.cache', `hx-ui-test-${process.pid}.mjs`);
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.copyFileSync(out, local);
  process.once('exit', () => { try { fs.rmSync(local); } catch { /* gone */ } });
  ui = await import(pathToFileURL(local).href) as UI;
  React = await import('react');
  server = await import('react-dom/server');
}

const md = (text: string) => server.renderToStaticMarkup(React.createElement(ui.Markdown, { text }));

test('markdown: GFM tables with alignment, task lists, footnotes, strikethrough, autolinks, nested lists, quotes, heading anchors', async () => {
  await load();
  const h = md(RICH.markdown!);
  assert.match(h, /<table>/);
  assert.match(h, /<th style="text-align:center">Owner<\/th>/);
  assert.match(h, /<td style="text-align:right">1.25<\/td>/);
  assert.match(h, /<input type="checkbox"[^>]*disabled=""[^>]*checked=""/);
  assert.match(h, /<del>yesterday<\/del>/);
  assert.match(h, /<blockquote>/);
  assert.match(h, /<ul[^>]*>[\s\S]*<ul>/, 'a nested list');
  assert.match(h, /href="https:\/\/example.com\/releases" target="_blank" rel="noopener noreferrer"/);
  assert.match(h, /class="footnotes"/);
  assert.match(h, /<h2 id="m[^"]*-release-checklist">/);
  assert.match(h, /class="heading-anchor"/);
});

test('code: highlighted with a label, copy and wrap; long blocks fold; inline code stays inline', async () => {
  await load();
  const h = md(RICH.code!);
  assert.match(h, /data-block="code" data-lang="python"/);
  assert.match(h, /data-block="code" data-lang="ts"/);
  assert.match(h, /var\(--hx-tok-keyword\)/, 'tokens coloured from theme variables');
  assert.match(h, /aria-label="Copy code"/);
  assert.match(h, /Wrap long lines/);
  assert.match(h, /Show all 40 lines/);
  assert.match(h, /<code>fetch_with_retry\(lambda: client.get\(url\)\)<\/code>/);
});

test('maths: KaTeX inline and display; a ```math block in the frame; prices stay prices', async () => {
  await load();
  const h = md(RICH.math!);
  assert.ok((h.match(/class="katex"/g) ?? []).length >= 2);
  assert.match(h, /katex-display/);
  assert.ok((h.match(/katex-display/g) ?? []).length >= 2, "a ```math block is display maths too");
  assert.match(h, /\$240.00/);
});

test('fenced kinds dispatch to their renderers: diagrams, charts, artifacts, data, diffs, images, citations', async () => {
  await load();
  assert.equal((md(RICH.mermaid!).match(/data-widget="Diagram"/g) ?? []).length, 2);
  const c = md(RICH.chart!);
  assert.match(c, /data-widget="Chart"/);
  assert.match(c, /data-widget="Figure"/);
  const a = md(RICH.artifact!);
  assert.match(a, /data-artifact="html"/);
  assert.match(a, /data-artifact="svg"/);
  assert.match(a, /data-artifact="react"/);
  for (const m of a.matchAll(/<iframe[^>]*>/g)) assert.doesNotMatch(m[0], /allow-same-origin/);
  assert.match(a, /sandbox="allow-scripts"/);
  assert.match(a, /sandbox=""/, 'an SVG runs no script at all');
  const d = md(RICH.data!);
  assert.match(d, /data-widget="CSV"/);
  assert.match(d, /data-table/);
  assert.match(d, /Lisbon/);
  assert.match(d, /data-widget="JSON"/);
  assert.match(d, /data-json/);
  assert.match(d, /data-widget="Table"/);
  assert.match(d, /aria-sort="none"/);
  const diff = md(RICH.diff!);
  assert.match(diff, /data-block="diff"/);
  assert.match(diff, /src\/retry.ts/);
  assert.equal((diff.match(/diff-row diff-add/g) ?? []).length, 2);
  assert.equal((diff.match(/diff-row diff-del/g) ?? []).length, 1);
  assert.match(md(RICH.image!), /<img src="data:image\/png;base64,[^"]+" alt="A small chart"/);
  const cit = md(RICH.citations!);
  assert.match(cit, /data-citation="1"/);
  assert.match(cit, /data-citation="2"/);
  const sink = md(KITCHEN_SINK);
  for (const marker of ['data-block="code"', 'class="katex"', 'data-widget="Diagram"', 'data-widget="Chart"', 'data-artifact="html"', 'data-table', 'data-json', 'data-block="diff"', 'data-citation', 'class="footnotes"']) assert.ok(sink.includes(marker), `kitchen sink has ${marker}`);
});

test('streaming: an unfinished fence waits instead of failing; finished blocks are split for incremental parsing', async () => {
  await load();
  const partial = '# Title\n\nSome text.\n\n```mermaid\nflowchart LR\n  A --> ';
  const h = server.renderToStaticMarkup(React.createElement(ui.Markdown, { text: partial, streaming: true }));
  assert.match(h, /Diagram arriving/);
  assert.doesNotMatch(h, /did not render/);
  assert.deepEqual(ui.splitBlocks('a\n\nb\n\n```js\nx\n\ny\n```\n\n- 1\n\n- 2'), ['a', 'b', '```js\nx\n\ny\n```', '- 1\n\n- 2']);
  assert.ok(ui.isOpenBlock('```js\nx'));
  assert.ok(!ui.isOpenBlock('```js\nx\n```'));
  assert.deepEqual(ui.splitBlocks('x [^1]\n\n[^1]: y'), ['x [^1]', '[^1]: y'], 'footnotes no longer keep the reply whole');
});

test('streaming: a block once complete keeps its key and its text as text is appended', async () => {
  await load();
  const texts = [STREAM_TEXT, KITCHEN_SINK, '- a\n\n- b\n\n1. c\n\n12. d\n\npara\n\n* e\n\n+ f\n\n    code\n\n> q\n\n$$\nx\n\ny\n$$\n\n~~~\nz\n\n~~~\n\nend'];
  for (const full of texts) {
    const final = ui.splitBlocks(full) as string[];
    const finalPlan = new Map((ui.planBlocks(full) as { blocks: Array<{ key: string; text: string }> }).blocks.map((b) => [b.key, b.text]));
    const seen = new Map<string, Set<string>>();
    for (let n = 1; n <= full.length; n++) {
      const prefix = full.slice(0, n);
      // The raw split: every block but the last is final.
      const blocks = ui.splitBlocks(ui.settledText(prefix)) as string[];
      for (let i = 0; i < blocks.length - 1; i++) assert.equal(blocks[i], final[i], `block ${i} of a ${n}-character prefix is final`);
      // What is rendered: keyed by position; a block that is not the tail changes only when a definition it uses arrives.
      const plan = ui.planBlocks(prefix, { streaming: true }) as { blocks: Array<{ key: string; text: string; open: boolean }> };
      plan.blocks.forEach((b, i) => {
        if (i === plan.blocks.length - 1) return;
        assert.ok(finalPlan.has(b.key), `${b.key} is still there at the end`);
        const own = (s: string) => s.replace(/\n\n\[[^\n]*\]:[\s\S]*$/, '');
        if (b.text !== finalPlan.get(b.key)) assert.equal(own(b.text), own(finalPlan.get(b.key)!), `${b.key} changes only for a definition it refers to`);
        assert.ok(!b.open, 'only the tail can be open');
        seen.set(b.key, (seen.get(b.key) ?? new Set()).add(b.text));
      });
    }
    for (const [key, set] of seen) assert.ok(set.size <= 2, `${key} rendered at most twice once complete (${set.size})`);
  }
});

test('streaming: an undecided last line is held back; footnotes and link references work across blocks', async () => {
  await load();
  assert.equal(ui.settledText('- a\n\n-'), '- a\n\n', 'a "-" under a list after a blank line waits');
  assert.equal(ui.settledText('- a\n\n12.'), '- a\n\n');
  assert.equal(ui.settledText('- a\n\n- b'), '- a\n\n- b');
  assert.equal(ui.settledText('para\n\n-'), 'para\n\n-', 'not under a list: it starts a block either way');
  assert.equal(ui.settledText('- a\n- b'), '- a\n- b');
  assert.equal(ui.settledText('- a\n1'), '- a\n1', 'no blank line: it is in the block already');
  assert.equal(ui.settledText('```\n- a\n\n-'), '```\n- a\n\n-', 'inside a fence');
  assert.equal(ui.settledText('- [ ] Notes reviewed\n  -'), '- [ ] Notes reviewed\n', 'a "-" under a line of text may underline it as a heading');
  assert.equal(ui.settledText('Title\n=='), 'Title\n');
  assert.equal(ui.settledText('Text.\n\n[^1'), 'Text.\n\n', 'a definition may be starting');
  assert.equal(ui.settledText('Text.\n\n[^1]: Note'), 'Text.\n\n[^1]: Note');
  // An open ```math or $$ at the tail waits (no half-formula drawn as an error); the blocks before it are drawn.
  for (const open of ['Energy $E$ is:\n\n```math\n\\frac{1}{', 'Energy $E$ is:\n\n$$\n\\frac{1}{']) {
    const h = server.renderToStaticMarkup(React.createElement(ui.Markdown, { text: open, streaming: true }));
    assert.match(h, /Formula arriving/);
    assert.doesNotMatch(h, /katex-error/);
    assert.match(h, /class="katex"/, 'inline maths in a finished block');
  }
  // Streaming, a reference is numbered before its definition arrives, so it does not change width when it does.
  const early = ui.planBlocks('See this.[^1]\n\nMore', { streaming: true });
  assert.equal(early.blocks[0].text, 'See this.[^1]\n\n[^1]: …');
  assert.deepEqual(early.footnotes, ['1']);
  // The reply's footnotes: one section after the last block, numbered in the order of their first reference.
  const text = 'One.[^b]\n\nTwo.[^a] See [the docs].\n\n[^a]: First.\n\n[^b]: Second.\n\n[the docs]: https://example.com/docs';
  const p = ui.planBlocks(text);
  assert.deepEqual(p.blocks.map((b: { key: string }) => b.key), ['b0', 'b1'], 'definitions render nothing themselves; keys keep their positions');
  assert.match(p.blocks[0].text, /\[\^b\]: Second\./);
  assert.doesNotMatch(p.blocks[0].text, /\[\^a\]:/, 'only the definitions a block uses');
  assert.match(p.blocks[1].text, /\[the docs\]: https:/);
  assert.deepEqual(p.footnotes, ['b', 'a']);
  const h = md(text);
  assert.equal((h.match(/class="footnotes"/g) ?? []).length, 1, 'one footnotes section');
  assert.match(h, /data-footnote-ref="true"[^>]*>1<\/a>[\s\S]*data-footnote-ref="true"[^>]*>2<\/a>/, 'numbered across the reply');
  assert.match(h, /<li id="m[^"]*-fn-b">[\s\S]*Second[\s\S]*<li id="m[^"]*-fn-a">[\s\S]*First/);
  assert.match(h, /<a href="https:\/\/example.com\/docs"/, 'a link reference resolves in another block');
  // While streaming no footnotes section is drawn (it would come and go), and the reply is split all the same.
  const s = server.renderToStaticMarkup(React.createElement(ui.Markdown, { text: STREAM_TEXT, streaming: true }));
  assert.doesNotMatch(s, /class="footnotes"/);
  assert.equal((md(STREAM_TEXT).match(/class="footnotes"/g) ?? []).length, 1);
  assert.ok(ui.planBlocks(STREAM_TEXT).blocks.length > 10, 'a reply with footnotes is still split');
});

test('hostile input is neutralised: no script, no handlers, no javascript: links, KaTeX refuses \\href, SVG is scrubbed', async () => {
  await load();
  const h = md(HOSTILE);
  assert.doesNotMatch(h, /<script/i);
  assert.doesNotMatch(h, /<img[^>]*onerror/i);
  assert.doesNotMatch(h, /<a[^>]*onclick/i);
  assert.doesNotMatch(h, /href="\s*javascript:/i);
  assert.doesNotMatch(h, /src="javascript:/i);
  assert.match(h, /&lt;script&gt;alert/, 'raw HTML shows as text');
  assert.match(h, /Link removed/);
  assert.doesNotMatch(h, /href="javascript:alert\(&#x27;xss-katex/);
  // The ```svg block is an artifact in a script-less sandbox.
  assert.match(h, /data-artifact="svg"/);
  const scrubbed = ui.scrubSvg('<svg onload="alert(1)"><script>alert(2)</script><foreignObject><img src=x onerror=alert(3)></foreignObject><a xlink:href="javascript:alert(4)"><text>t</text></a><set attributeName="href" to="javascript:alert(5)"/></svg>');
  assert.doesNotMatch(scrubbed, /onload|<script|foreignObject|javascript:|<set/i);
  assert.match(scrubbed, /<text>t<\/text>/);
  assert.equal(ui.safeHref('java\tscript:alert(1)'), undefined);
  assert.equal(ui.safeHref('https://ok.example/x'), 'https://ok.example/x');
  assert.equal(ui.safeImageSrc('data:text/html,<script>'), undefined);
  assert.ok(ui.safeImageSrc('data:image/png;base64,AAAA'));
  // An artifact page is fenced in: its own CSP has no network, and the frame never gets same-origin.
  const doc = ui.artifactDocument('html', '<p>x</p>');
  assert.match(doc, /connect-src 'none'/);
  assert.match(doc, /form-action 'none'/);
  assert.equal(ui.artifactSandbox('html'), 'allow-scripts');
  assert.equal(ui.artifactSandbox('svg'), '');
  const esc = md(ESCAPE_ARTIFACT);
  assert.match(esc, /sandbox="allow-scripts"/);
  assert.doesNotMatch(esc, /allow-same-origin/);
  const react = ui.artifactDocument('react', 'export default function A(){return <b>x</b>}', { runtimeUrl: 'harness://preview/runtime/artifact-runtime.js' });
  assert.match(react, /script-src 'unsafe-inline' harness:\/\/preview\/runtime\//);
  assert.doesNotMatch(react, /<\/script>[^<]*export default/, 'the code travels base64-encoded, never as markup');
});

test('data and diff helpers', async () => {
  await load();
  assert.deepEqual(ui.parseDelimited('a,"b,c"\n1,"say ""hi"""\n'), { columns: ['a', 'b,c'], rows: [['1', 'say "hi"']] });
  assert.equal(ui.sniffDelimiter('a\tb\n1\t2'), '\t');
  assert.equal(ui.numericValue('$1,024'), 1024);
  assert.equal(ui.numericValue('92%'), 92);
  assert.equal(ui.numericValue('n/a'), undefined);
  assert.equal(ui.parseVizSpec('{"mark":"bar","data":{"url":"https://evil.example/x.csv"}}').error?.includes('URL'), true, 'figures may not fetch');
  assert.match(ui.parseChartSpec('{"xAxis":{}}').error!, /series/);
  assert.match(ui.parseTableSpec('{"columns":["a"],"rows":[[1,2]]}').error!, /row 1 has 2 cells/);
  const ops = ui.diffLines('a\nb\nc', 'a\nB\nc\nd');
  assert.deepEqual(ui.stats(ops), { added: 2, removed: 1 });
  assert.deepEqual(ui.splitRows(ops).map((r: { left?: { s: string }; right?: { s: string } }) => [r.left?.s ?? '', r.right?.s ?? '']), [['a', 'a'], ['b', 'B'], ['c', 'c'], ['', 'd']]);
  const many = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n');
  const h = ui.hunks(ui.diffLines(many, many.replace('l15', 'X')));
  assert.equal(h.length, 1);
  assert.equal(h[0]!.skippedBefore, 12);
  assert.deepEqual(ui.parseUnifiedDiff(RICH.diff!.split('```diff\n')[1]!.split('```')[0]!).map((f: { path: string; ops: unknown[] }) => [f.path, ui.stats(f.ops).added]), [['src/retry.ts', 2]]);
});

test('icons: every name a manifest may use is drawn', async () => {
  await load();
  const missing = ICON_NAMES.filter((n) => !ui.hasIcon(n));
  assert.deepEqual(missing, []);
});
