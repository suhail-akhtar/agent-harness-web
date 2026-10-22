/**
 * Builds the dashboard viewer for published pages and static exports into <repo>/dist/bi-viewer:
 * viewer.js (+ chunks, loaded on demand) and viewer.css, from the same packages/ui renderers and
 * Tailwind tokens as the desktop, so a published dashboard looks and works as it does in the app.
 *
 *   node apps/desktop/scripts/build-viewer.mjs [--out <dir>] [--dev]
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const repo = path.resolve(desktop, '..', '..');
const args = process.argv.slice(2);
const out = path.resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(repo, 'dist', 'bi-viewer'));
const dev = args.includes('--dev');
const require = createRequire(path.join(repo, 'package.json'));
const pkg = (name) => path.dirname(require.resolve(`${name}/package.json`));

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

await build({
  entryPoints: { viewer: path.join(repo, 'packages/ui/src/render/dashboard/viewer.tsx') },
  outdir: out, bundle: true, splitting: true, format: 'esm', target: 'es2022', minify: !dev, sourcemap: false, legalComments: 'none',
  chunkNames: 'chunk-[hash]', jsx: 'automatic', logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"production"' },
  alias: { '@harness/plugin-ui': path.join(repo, 'packages/plugin-ui/src/index.ts'), react: pkg('react'), 'react-dom': pkg('react-dom') },
  loader: { '.wasm': 'file', '.css': 'empty' },
});

// The styles: the design tokens, KaTeX, and the Tailwind utilities the renderers use.
const postcss = require('postcss');
const tailwind = require('tailwindcss');
const autoprefixer = require('autoprefixer');
const config = (await import(pathToFileURL(path.join(desktop, 'renderer/tailwind.config.js')).href)).default;
const katex = pkg('katex');
const input = [
  fs.readFileSync(path.join(repo, 'packages/ui/src/styles.css'), 'utf8'),
  fs.readFileSync(path.join(katex, 'dist/katex.min.css'), 'utf8'),
  '@tailwind base;\n@tailwind components;\n@tailwind utilities;',
  'html, body, #root { height: 100%; width: 100%; margin: 0; } body { font-family: var(--hx-font); font-size: 14px; background: var(--hx-bg); color: var(--hx-text-primary); -webkit-font-smoothing: antialiased; }',
  ':focus-visible { outline: 2px solid var(--hx-focus); outline-offset: 1px; }',
  '@media print { [data-bi-toolbar] { display: none !important; } [data-bi-canvas] { overflow: visible !important; } [data-visual] { break-inside: avoid; } thead { display: table-header-group; } tfoot { display: table-footer-group; } }',
].join('\n');
const tw = { ...config, content: { relative: false, files: [path.join(repo, 'packages/ui/src/**/*.{ts,tsx}').replace(/\\/g, '/')] } };
const css = await postcss([tailwind(tw), autoprefixer]).process(input, { from: path.join(repo, 'packages/ui/src/viewer.css') });
fs.writeFileSync(path.join(out, 'viewer.css'), css.css);
// KaTeX's fonts, next to the CSS that refers to them.
fs.cpSync(path.join(katex, 'dist/fonts'), path.join(out, 'fonts'), { recursive: true });
// The asset route serves one folder level: chunks and fonts are flattened into it.
for (const f of fs.readdirSync(path.join(out, 'fonts'))) fs.renameSync(path.join(out, 'fonts', f), path.join(out, f));
fs.rmSync(path.join(out, 'fonts'), { recursive: true, force: true });
fs.writeFileSync(path.join(out, 'viewer.css'), fs.readFileSync(path.join(out, 'viewer.css'), 'utf8').replace(/url\(fonts\//g, 'url('));
const files = fs.readdirSync(out);
console.log(`built the dashboard viewer into ${path.relative(repo, out)} (${files.length} files, ${Math.round(files.reduce((n, f) => n + fs.statSync(path.join(out, f)).size, 0) / 1024)} KB)`);
