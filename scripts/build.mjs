import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'ui', 'dist');
await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });

await build({
  entryPoints: [path.join(root, 'ui', 'src', 'main.tsx')],
  outfile: path.join(out, 'app.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  minify: true,
  sourcemap: true,
  legalComments: 'none',
});
await fs.copyFile(path.join(root, 'ui', 'index.html'), path.join(out, 'index.html'));
await fs.copyFile(path.join(root, 'ui', 'styles.css'), path.join(out, 'styles.css'));

// The companion ships as one file that runs on Node 18+, no install needed.
await build({
  entryPoints: [path.join(root, 'src', 'companion', 'main.ts')],
  outfile: path.join(root, 'dist', 'companion.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  // Bundled CommonJS (undici) calls require() for Node's own modules; an ES module has none of its own.
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __harnessRequire } from 'node:module';\nconst require = __harnessRequire(import.meta.url);" },
});
console.log('built ui/dist and dist/companion.mjs');
