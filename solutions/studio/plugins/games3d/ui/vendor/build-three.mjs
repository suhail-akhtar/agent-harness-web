// Builds three-studio.js: a pinned copy of Three.js with the loader, controls and helpers the 3D
// viewer uses, as one classic script (window.StudioThree). Plugin frames run offline under a CSP
// with no network and no workers, so nothing is fetched at run time. The bundle is committed;
// run this only to move to another three version (the one installed in node_modules):
//
//   node plugins/games3d/ui/vendor/build-three.mjs
//
// It writes three-studio.js and THREE-LICENSE (MIT) next to this file.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// three does not export its package.json: found through Node's lookup paths.
const pkgDir = (require.resolve.paths('three') ?? []).map((b) => path.join(b, 'three')).find((d) => fs.existsSync(path.join(d, 'package.json')));
if (!pkgDir) throw new Error('three is not installed (npm install)');
const version = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;

const entry = `
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { VertexNormalsHelper } from 'three/examples/jsm/helpers/VertexNormalsHelper.js';
window.StudioThree = { THREE, GLTFLoader, OrbitControls, VertexNormalsHelper, version: ${JSON.stringify(version)} };
`;

await build({
  stdin: { contents: entry, resolveDir: here, loader: 'js' },
  outfile: path.join(here, 'three-studio.js'),
  bundle: true, format: 'iife', target: 'es2020', minify: true, legalComments: 'none', logLevel: 'warning',
  banner: { js: `/* three.js r${version.split('.')[1]} (${version}) with GLTFLoader, OrbitControls, VertexNormalsHelper. MIT License, Copyright 2010-2026 three.js authors (see THREE-LICENSE). Built by build-three.mjs. */` },
});
fs.copyFileSync(path.join(pkgDir, 'LICENSE'), path.join(here, 'THREE-LICENSE'));
console.log(`three-studio.js: three ${version}, ${(fs.statSync(path.join(here, 'three-studio.js')).size / 1024).toFixed(0)} KB`);
