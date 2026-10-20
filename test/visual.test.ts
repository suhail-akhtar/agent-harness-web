import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runGates } from '../src/gates/gates.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { LocalHost } from '../src/runtime/host.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir } from './helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const plugins = path.join(here, '..', 'plugins');
// @ts-expect-error plain JS module
const { chromiumPath, serveDir } = await import('../plugins/visual/lib/browser.mjs');
const hasChromium = await import('playwright-core').then(() => true, () => false) && !!chromiumPath();
const hasOffice = (() => { try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 20_000 }); return true; } catch { return false; } })();

// A tiny canvas game: state on window.__game, Enter starts, ArrowRight moves.
const GAME = `<!doctype html><title>Dot</title><canvas id=c width=320 height=200></canvas><script>
const g = window.__game = { state: 'title', player: { x: 20 } };
const keys = new Set();
addEventListener('keydown', (e) => { keys.add(e.key); if (e.key === 'Enter') g.state = 'playing'; });
addEventListener('keyup', (e) => keys.delete(e.key));
const ctx = document.getElementById('c').getContext('2d');
function frame() {
  if (g.state === 'playing' && keys.has('ArrowRight')) g.player.x += 4;
  ctx.fillStyle = '#123'; ctx.fillRect(0, 0, 320, 200);
  ctx.fillStyle = '#fc0'; ctx.fillRect(g.player.x, 90, 20, 20);
  requestAnimationFrame(frame);
}
frame();
</script>`;

async function setup() {
  const h = await createHarness({ dataDir: await tempDir(), plugins: [plugins] });
  const root = await tempDir();
  const host = new LocalHost(root);
  const ctx = { host, signal: new AbortController().signal, readFiles: new Map(), todos: [], setTodos() {}, emit() {} } as unknown as ToolContext;
  const tool = (name: string) => h.registry.tools.get(name)!;
  return { h, root, host, ctx, tool };
}

test('the visual plugin registers its tools, gates and skill', async () => {
  const { h, tool } = await setup();
  for (const t of ['render', 'browser', 'add_library']) assert.ok(tool(t), t);
  for (const g of ['documents-render', 'web-console', 'playtest']) assert.ok(h.registry.gates.has(g), g);
  assert.equal(tool('browser').kind, 'exec');
  await h.close();
});

test('the page server stays inside the workspace, symlinks included', async () => {
  const outside = await tempDir();
  const root = path.join(outside, 'ws');
  await fs.mkdir(root);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
  await fs.writeFile(path.join(root, 'ok.txt'), 'ok');
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
  const s = await serveDir(root);
  try {
    assert.equal(await (await fetch(`${s.origin}/ok.txt`)).text(), 'ok');
    assert.equal((await fetch(`${s.origin}/link.txt`)).status, 404);
    assert.equal((await fetch(`${s.origin}/%2e%2e/secret.txt`)).status, 404);
    assert.equal((await fetch(`${s.origin}/..%2fsecret.txt`)).status, 404);
  } finally { await s.close(); }
});

test('browser drives a page offline: input, state, screenshot; network blocked; errors reported', { skip: !hasChromium && 'no Chromium' }, async () => {
  const { h, root, ctx, tool } = await setup();
  await fs.writeFile(path.join(root, 'index.html'), GAME);
  const r = await tool('browser').run({ actions: [{ press: 'Enter' }, { press: 'ArrowRight', hold: 400 }, { eval: 'window.__game.state' }], eval: 'window.__game.player.x' }, ctx);
  assert.match(r.content, /No uncaught errors/);
  assert.match(r.content, /window\.__game\.state => "playing"/);
  const x = Number(/Result: (\d+)/.exec(r.content)?.[1]);
  assert.ok(x > 20, `player moved (x=${x})`);
  assert.equal(r.images?.length, 1);
  assert.doesNotMatch(r.content, /BLANK/);

  await fs.writeFile(path.join(root, 'bad.html'), `<script src="https://cdn.example.com/lib.js"></script><script src="missing.js"></script><script>null.boom</script>`);
  const bad = await tool('browser').run({ path: 'bad.html' }, ctx);
  assert.match(bad.content, /Blocked[\s\S]*cdn\.example\.com/);
  assert.match(bad.content, /Missing files:[\s\S]*404 \/missing\.js/);
  assert.match(bad.content, /Uncaught errors \(1\)/);
  assert.match(bad.content, /BLANK/);
  await h.close();
});

test('web-console and playtest gates judge a game', { skip: !hasChromium && 'no Chromium' }, async () => {
  const { h, root, host } = await setup();
  await fs.writeFile(path.join(root, 'index.html'), GAME);
  await fs.writeFile(path.join(root, 'playtest.json'), JSON.stringify({
    viewport: { width: 400, height: 300 },
    scenarios: [
      { name: 'title first', expect: [{ eval: 'window.__game.state', op: '==', value: 'title' }] },
      { name: 'moves right', steps: [{ press: 'Enter' }, { press: 'ArrowRight', hold: 300 }], expect: [{ eval: 'window.__game.player.x', op: 'increased' }] },
      { name: 'moves left (not built)', steps: [{ press: 'Enter' }, { press: 'ArrowLeft', hold: 300 }], expect: [{ eval: 'window.__game.player.x', op: 'decreased' }] },
    ],
  }));
  const res = await runGates(h.registry, host, ['web-console', 'playtest'], new AbortController().signal);
  const by = Object.fromEntries(res.map((g) => [g.name, g]));
  assert.equal(by['web-console']!.pass, true, by['web-console']!.details ?? '');
  assert.equal(by.playtest!.pass, false);
  assert.match(by.playtest!.summary, /1 of 3/);
  assert.match(by.playtest!.details ?? '', /moves left[\s\S]*decreased \(before: 20\), got 20/);

  await fs.writeFile(path.join(root, 'index.html'), '<script src="https://unpkg.com/three"></script><canvas></canvas>');
  const [wc] = await runGates(h.registry, host, ['web-console'], new AbortController().signal);
  assert.equal(wc!.pass, false);
  assert.match(wc!.details ?? '', /needs the network: https:\/\/unpkg\.com\/three[\s\S]*blank/);
  await h.close();
});

test('add_library vendors Node and browser libraries offline', async () => {
  const { h, root, ctx, tool } = await setup();
  const r = await tool('add_library').run({ name: 'pptxgenjs' }, ctx);
  assert.match(r.content, /Added pptxgenjs 4\.0\.1/);
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies.pptxgenjs, '4.0.1');
  const out = execFileSync('node', ['-e', "const P=require('pptxgenjs'); const p=new P(); p.addSlide().addText('hi',{x:1,y:1}); p.write({outputType:'nodebuffer'}).then(b=>console.log(b.length>1000?'ok':'small'))"], { cwd: root, encoding: 'utf8' });
  assert.equal(out.trim(), 'ok');
  const t = await tool('add_library').run({ name: 'three' }, ctx);
  assert.match(t.content, /importmap/);
  await fs.access(path.join(root, 'vendor/three/build/three.module.js'));
  await fs.access(path.join(root, 'vendor/three/examples/jsm/controls/OrbitControls.js'));
  await h.close();
});

test('render shows slides and catches text that does not fit; the gate fails on it', { skip: (!hasOffice || !hasChromium) && 'no LibreOffice' }, async () => {
  const { h, root, host, ctx, tool } = await setup();
  await tool('add_library').run({ name: 'pptxgenjs' }, ctx);
  execFileSync('node', ['-e', `
    const P = require('pptxgenjs'); const p = new P(); p.layout = 'LAYOUT_WIDE';
    p.addSlide().addText('Quarterly results', { x: 0.5, y: 0.5, w: 12, h: 1, fontSize: 36 });
    p.addSlide().addText('Far too much text for one small box. '.repeat(60), { x: 0.5, y: 0.5, w: 5, h: 1, fontSize: 18, fit: 'none' });
    p.addSlide().addText('Shrunk until it fits. '.repeat(40), { x: 0.5, y: 0.5, w: 4, h: 1.5, fontSize: 18, fit: 'shrink' });
    p.writeFile({ fileName: 'deck.pptx' });`], { cwd: root });
  const r = await tool('render').run({ path: 'deck.pptx', export: 'pdf' }, ctx);
  assert.match(r.content, /deck\.pptx: 3 page\(s\)/);
  assert.match(r.content, /page 2: TEXT DOES NOT FIT/);
  assert.match(r.content, /page 3: TEXT TOO SMALL/, 'autofit shrink passes the fit check but not the size check');
  assert.doesNotMatch(r.content, /page 1: TEXT/);
  assert.equal(r.images?.length, 3);
  assert.match(r.content, /exported deck\.pdf/);
  await fs.access(path.join(root, 'deck.pdf'));
  await fs.access(path.join(root, '.harness/render/deck.pptx/page-1.png'));
  const [g] = await runGates(h.registry, host, ['documents-render'], new AbortController().signal);
  assert.equal(g!.pass, false);
  assert.match(g!.details ?? '', /deck\.pptx: slide 2: text does not fit[\s\S]*slide 3: text too small/);
  await h.close();
});

test('a long Markdown file renders as pages, never one giant image', { skip: !hasChromium && 'no Chromium' }, async () => {
  const { h, root, ctx, tool } = await setup();
  await fs.writeFile(path.join(root, 'plan.md'), `# Plan\n\n${Array.from({ length: 120 }, (_, i) => `${i + 1}. A line of the plan that takes some room on the page.`).join('\n')}\n`);
  const r = await tool('render').run({ path: 'plan.md', width: 800 }, ctx);
  const pages = Number(/plan\.md: (\d+) page/.exec(r.content)?.[1]);
  assert.ok(pages >= 3, `${pages} pages`);
  assert.equal(r.images?.length, Math.min(pages, 4));
  for (const img of r.images!) {
    const png = Buffer.from(img.data, 'base64');
    assert.equal(png.readUInt32BE(16), 800);
    assert.ok(png.readUInt32BE(20) <= Math.round(800 * 1.414), `page height ${png.readUInt32BE(20)}`);
  }
  await h.close();
});

test('a waitFor that times out fails the scenario and does not shift the checks after it', { skip: !hasChromium && 'no Chromium' }, async () => {
  const { h, root, host } = await setup();
  await fs.writeFile(path.join(root, 'index.html'), GAME);
  await fs.writeFile(path.join(root, 'playtest.json'), JSON.stringify({
    viewport: { width: 400, height: 300 },
    scenarios: [{
      name: 'starts, after waiting for something that never happens',
      steps: [{ waitFor: 'window.__game.never === true', timeout: 300 }, { press: 'Enter' }, { eval: 'window.__game.state' }],
      expect: [{ eval: 'window.__game.state', op: '==', value: 'playing' }],
    }],
  }));
  const [g] = await runGates(h.registry, host, ['playtest'], new AbortController().signal);
  assert.equal(g!.pass, false);
  assert.match(g!.details ?? '', /waited for window\.__game\.never === true, which never became true/);
  assert.doesNotMatch(g!.details ?? '', /expected window\.__game\.state == "playing"/, 'the state check read its own value, not the timeout');
  await h.close();
});

/** A one-page PDF with given text lines (Helvetica at the given sizes), built by hand. */
function tinyPdf(lines: [string, number][]): Buffer {
  const content = lines.map(([t, size], i) => `BT /F1 ${size} Tf 72 ${700 - i * 40} Td (${t}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('PDF and Markdown render with Chromium alone: no poppler, no pandoc', { skip: !hasChromium && 'no Chromium' }, async () => {
  // @ts-expect-error plain JS module
  const { renderFile } = await import('../plugins/visual/lib/render.mjs');
  const saved = { ...process.env };
  // Point every poppler and pandoc binary at nothing: any use of them would fail.
  for (const b of ['PDFTOPPM', 'PDFTOTEXT', 'PDFINFO', 'PANDOC']) process.env[`HARNESS_${b}`] = '/nonexistent/' + b.toLowerCase();
  try {
    const root = await tempDir();
    await fs.writeFile(path.join(root, 'doc.pdf'), tinyPdf([['Quarterly results', 24], ['tiny footnote text here', 8]]));
    const r = await renderFile({ root, rel: 'doc.pdf', width: 600 });
    assert.equal(r.pages, 1);
    assert.equal(r.size, '612 x 792 pt');
    assert.deepEqual(r.facts[0], { page: 1, words: 6, smallestPt: 8 });
    assert.equal(r.images.length, 1);
    assert.equal(r.images[0].data.readUInt32BE(16), 600, 'a PNG 600 pixels wide');
    await fs.writeFile(path.join(root, 'notes.md'), '# Title\n\nSome *text* and a table:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
    const m = await renderFile({ root, rel: 'notes.md', width: 800 });
    assert.equal(m.pages, 1);
    assert.equal(m.images.length, 1);
    const html = await fs.readFile(path.join(root, '.harness', 'render', '_md', 'notes.md.html'), 'utf8');
    assert.match(html, /<h1[^>]*>Title<\/h1>/);
    assert.match(html, /<table>/);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  }
});
