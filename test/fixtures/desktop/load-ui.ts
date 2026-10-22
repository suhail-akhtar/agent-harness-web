// Loads packages/ui (TSX) in Node for the render tests: bundled with esbuild, React external (one
// copy), the heavy browser-only libraries external too (they load lazily and never run here).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// Typed loosely: the package is TSX (the root type check has no JSX); its own tsconfig checks it.
export type UI = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let loaded: Promise<{ ui: UI; React: typeof import('react'); server: typeof import('react-dom/server') }> | null = null;

export function loadUi(): Promise<{ ui: UI; React: typeof import('react'); server: typeof import('react-dom/server') }> {
  return (loaded ??= (async () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hx-ui-')), 'ui.mjs');
    await build({
      entryPoints: [path.join(root, 'packages/ui/src/index.ts')], outfile: out, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic',
      external: ['react', 'react-dom', 'react/*', 'react-dom/*', 'mermaid', 'echarts', 'vega-embed', 'vega-interpreter', 'smiles-drawer', '@hpcc-js/wasm-graphviz', '3dmol'],
      banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" }, logLevel: 'silent', absWorkingDir: root,
    });
    // Resolve its imports from the repository (copy next to node_modules).
    const local = path.join(root, 'node_modules', '.cache', `hx-ui-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}.mjs`);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.copyFileSync(out, local);
    process.once('exit', () => { try { fs.rmSync(local); } catch { /* gone */ } });
    const ui = await import(pathToFileURL(local).href) as UI;
    return { ui, React: await import('react'), server: await import('react-dom/server') };
  })());
}

/**
 * Renders to HTML after every lazy component and Suspense boundary has resolved. Errors a component
 * throws are collected (on the server React leaves them to the client's error boundaries).
 */
export async function renderAll(el: unknown): Promise<{ html: string; errors: string[] }> {
  const { server, React } = await loadUi();
  const errors: string[] = [];
  // Inside a boundary, so a component that throws is reported (onError) rather than failing the shell.
  el = React.createElement(React.Suspense, { fallback: React.createElement('div', { 'data-render-failed': '' }) }, el as React.ReactElement);
  return new Promise((resolve, reject) => {
    let html = '';
    const sink = new Writable({ write(chunk, _enc, done) { html += String(chunk); done(); }, final(done) { done(); resolve({ html, errors }); } });
    const s = server.renderToPipeableStream(el as React.ReactElement, { onAllReady() { s.pipe(sink); }, onShellError: reject, onError(e) { errors.push(e instanceof Error ? e.message : String(e)); } });
  });
}
