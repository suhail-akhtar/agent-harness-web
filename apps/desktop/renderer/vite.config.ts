/**
 * The desktop renderer: React + Tailwind, with the shared packages compiled from source.
 * Built into dist/renderer and served from harness://app/ by main (protocol.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const repo = path.resolve(desktop, '..', '..');
const version = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8')).version as string;

export default defineConfig({
  root: here,
  base: './',
  plugins: [react()],
  define: { __DESKTOP_VERSION__: JSON.stringify(version) },
  resolve: {
    alias: [
      { find: /^@harness\/plugin-ui$/, replacement: path.join(repo, 'packages/plugin-ui/src/index.ts') },
      { find: /^@harness\/plugin-ui\/sdk$/, replacement: path.join(repo, 'packages/plugin-ui/src/sdk.ts') },
      { find: /^@harness\/client$/, replacement: path.join(repo, 'packages/client/src/index.ts') },
      { find: /^@harness\/ui$/, replacement: path.join(repo, 'packages/ui/src/index.ts') },
      { find: /^@harness\/ui\/styles\.css$/, replacement: path.join(repo, 'packages/ui/src/styles.css') },
      { find: /^@desk\//, replacement: `${path.join(desktop, 'shared')}/` },
      { find: /^@\//, replacement: `${path.join(here, 'src')}/` },
    ],
    dedupe: ['react', 'react-dom'],
  },
  build: {
    outDir: path.join(desktop, 'dist/renderer'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'chrome140',
    chunkSizeWarningLimit: 8000,
    minify: process.env.HARNESS_NO_MINIFY ? false : 'esbuild',
  },
  worker: { format: 'es' },
});
