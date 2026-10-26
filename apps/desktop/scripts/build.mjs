/**
 * Builds Harness Desktop into apps/desktop/dist:
 *   dist/main.cjs, dist/preload.cjs   Electron main and preload (esbuild, CommonJS)
 *   dist/renderer/                    the interface (Vite) and artifact-runtime.js (React + sucrase for previews)
 *   dist/sdk/plugin-ui.js             the plugin SDK frames load (window.HarnessPluginUI.connect, .ui)
 *   dist/sdk/plugin-ui.css            the UI kit's stylesheet for plugin pages
 *
 *   node scripts/build.mjs [--no-renderer] [--dev]
 * The engine is not bundled: it runs the harness server from source (see package.mjs).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const repo = path.resolve(desktop, '..', '..');
const dist = path.join(desktop, 'dist');
const args = new Set(process.argv.slice(2));
const dev = args.has('--dev');
fs.mkdirSync(dist, { recursive: true });

const alias = { '@harness/plugin-ui': path.join(repo, 'packages/plugin-ui/src/index.ts') };
await build({ entryPoints: [path.join(desktop, 'electron/main.ts')], outfile: path.join(dist, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], alias, sourcemap: 'linked', logLevel: 'warning' });
await build({ entryPoints: [path.join(desktop, 'electron/preload.ts')], outfile: path.join(dist, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], logLevel: 'warning' });
// The SDK as a classic script (frames are opaque origins: a module script would need CORS).
await build({ entryPoints: [path.join(repo, 'packages/plugin-ui/src/sdk.ts')], outfile: path.join(dist, 'sdk/plugin-ui.js'), bundle: true, format: 'iife', globalName: 'HarnessPluginUI', target: 'es2020', minify: !dev, logLevel: 'warning' });
// The UI kit's stylesheet (harness://app/sdk/plugin-ui.css): the app's look for plugin pages (HarnessPluginUI.ui builds the markup).
fs.copyFileSync(path.join(repo, 'packages/plugin-ui/src/kit.css'), path.join(dist, 'sdk/plugin-ui.css'));

if (!args.has('--no-renderer')) {
  const { build: viteBuild } = await import('vite');
  if (dev) process.env.HARNESS_NO_MINIFY = '1';
  await viteBuild({ configFile: path.join(desktop, 'renderer/vite.config.ts'), logLevel: 'warn', mode: dev ? 'development' : 'production' });
}
// After Vite (which empties dist/renderer): the React runtime for artifact previews.
await build({ entryPoints: [path.join(desktop, 'renderer/artifact-runtime.ts')], outfile: path.join(dist, 'renderer/artifact-runtime.js'), bundle: true, format: 'iife', target: 'es2020', minify: !dev, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning' });
// The 3D molecule viewer for ```pdb / ```sdf blocks, served next to it (harness://preview/runtime/3Dmol-min.js).
const threeDmol = [repo, path.join(repo, 'packages/ui')].map((d) => path.join(d, 'node_modules/3dmol/build/3Dmol-min.js')).find((f) => fs.existsSync(f));
if (threeDmol) fs.copyFileSync(threeDmol, path.join(dist, 'renderer/3Dmol-min.js'));
else console.warn('3dmol is not installed: 3D structures will show an error');
fs.writeFileSync(path.join(dist, 'package.json'), JSON.stringify({ type: 'commonjs' }));
console.log(`built Harness Desktop into ${path.relative(repo, dist)}`);
