// Libraries the agent can put into a workspace without the network (a sandbox
// is offline): copied from the server's own install, at pinned versions.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

/** The installed package folder (through Node's lookup paths: some packages do not export package.json). */
function pkgDir(name) {
  // Paths of a neutral name: for a name that is also a built-in (e.g. the "https" package) Node returns none.
  for (const base of require.resolve.paths('harness-probe') ?? []) {
    const dir = path.join(base, ...name.split('/'));
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
  }
  return null;
}

/** A package and everything it depends on at runtime (type packages left out). */
async function closure(name, seen = new Map()) {
  if (seen.has(name) || name.startsWith('@types/') || name === 'undici-types') return seen;
  const dir = pkgDir(name);
  if (!dir) throw new Error(`${name} is not installed on the server`);
  const pkg = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8'));
  seen.set(name, { dir, version: pkg.version });
  for (const d of Object.keys(pkg.dependencies ?? {})) await closure(d, seen);
  return seen;
}

export const LIBRARIES = {
  three: {
    description: 'Three.js (3D, WebGL) as ES modules for the browser, with its addons (controls, loaders, GLTFExporter, ...).',
    async install(root) {
      const dir = pkgDir('three');
      if (!dir) throw new Error('three is not installed on the server');
      const version = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8')).version;
      const dest = path.join(root, 'vendor', 'three');
      await fsp.mkdir(path.join(dest, 'build'), { recursive: true });
      for (const f of ['three.module.js', 'three.core.js']) await fsp.copyFile(path.join(dir, 'build', f), path.join(dest, 'build', f));
      await fsp.cp(path.join(dir, 'examples', 'jsm'), path.join(dest, 'examples', 'jsm'), { recursive: true });
      await fsp.copyFile(path.join(dir, 'LICENSE'), path.join(dest, 'LICENSE')).catch(() => {});
      return {
        version,
        files: 'vendor/three/',
        usage: [
          'In index.html, before your module script:',
          '<script type="importmap">{"imports":{"three":"./vendor/three/build/three.module.js","three/addons/":"./vendor/three/examples/jsm/"}}</script>',
          'Then: import * as THREE from "three"; import { OrbitControls } from "three/addons/controls/OrbitControls.js";',
          'For screenshots of WebGL: new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }).',
        ].join('\n'),
      };
    },
  },
  pptxgenjs: { description: 'PptxGenJS: write PowerPoint (.pptx) files from Node.', node: true },
  docx: { description: 'docx: write Word (.docx) files from Node.', node: true },
  jszip: { description: 'JSZip: read and write zip files (and the OOXML inside .docx/.pptx/.xlsx).', node: true },
};

/** Copies a Node library and its dependencies into node_modules and records it in package.json. */
async function installNode(root, name) {
  const pkgs = await closure(name);
  for (const [n, { dir }] of pkgs) {
    const dest = path.join(root, 'node_modules', ...n.split('/'));
    if (await fsp.stat(path.join(dest, 'package.json')).catch(() => null)) continue;
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.cp(dir, dest, { recursive: true });
  }
  const version = pkgs.get(name).version;
  const pj = path.join(root, 'package.json');
  const raw = await fsp.readFile(pj, 'utf8').catch(() => null);
  const pkg = raw ? JSON.parse(raw) : { name: path.basename(root).toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'workspace', private: true, type: 'module' };
  pkg.dependencies = { ...(pkg.dependencies ?? {}), [name]: version };
  await fsp.writeFile(pj, JSON.stringify(pkg, null, 2) + '\n');
  return { version, files: `node_modules/${name} (+${pkgs.size - 1} dependencies)`, usage: `import ... from '${name}' in Node; ${raw ? 'added to' : 'created'} package.json dependencies.` };
}

export async function addLibrary(root, name) {
  const lib = LIBRARIES[name];
  if (!lib) throw new Error(`Unknown library "${name}". Available: ${Object.keys(LIBRARIES).join(', ')}`);
  return lib.node ? installNode(root, name) : lib.install(root);
}
