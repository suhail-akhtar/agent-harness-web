import assert from 'node:assert/strict';
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
// @ts-expect-error plain JS module
const { inspectGltf } = await import('../plugins/games3d/lib-gltf.mjs');
// @ts-expect-error plain JS module
const { chromiumPath } = await import('../plugins/visual/lib/browser.mjs');
const hasChromium = await import('playwright-core').then(() => true, () => false) && !!chromiumPath();

/** A minimal GLB: one 1x1x1 triangle mesh used by two nodes, one rotated 90 degrees about Z and stretched along X. */
async function glb(file: string) {
  const pos = new Float32Array([0, 0, 0, 2, 0, 0, 0, 1, 0]);
  const bin = Buffer.from(pos.buffer);
  const s = Math.SQRT1_2;
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ children: [1, 2] }, { mesh: 0 }, { mesh: 0, translation: [0, 0, 5], rotation: [0, 0, s, s] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [2, 1, 0] }],
    bufferViews: [{ buffer: 0, byteLength: bin.length }], buffers: [{ byteLength: bin.length }],
  };
  let j = Buffer.from(JSON.stringify(json));
  j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + j.length + 8 + bin.length, 8);
  const ch = (len: number, type: number) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
  await fs.writeFile(file, Buffer.concat([head, ch(j.length, 0x4e4f534a), j, ch(bin.length, 0x004e4942), bin]));
}

test('glTF inspection: transforms (rotation included) set the size; shared meshes count per instance', async () => {
  const dir = await tempDir();
  await glb(path.join(dir, 'm.glb'));
  const g = await inspectGltf(path.join(dir, 'm.glb'));
  assert.equal(g.meshes, 1);
  assert.equal(g.triangles, 2, 'one mesh placed twice');
  // Node 1 spans x 0..2, y 0..1; node 2 is rotated 90 degrees: x -1..0, y 0..2, at z 5.
  assert.deepEqual(g.size, [3, 2, 5]);
  await fs.writeFile(path.join(dir, 'bad.glb'), 'not a model');
  await assert.rejects(inspectGltf(path.join(dir, 'bad.glb')), /bad magic/);
});

test('gltf-valid fails on a broken model and passes on a good one', async () => {
  const h = await createHarness({ dataDir: await tempDir(), plugins: [path.join(here, '..', 'plugins')] });
  const root = await tempDir();
  const host = new LocalHost(root);
  await glb(path.join(root, 'good.glb'));
  let [g] = await runGates(h.registry, host, ['gltf-valid'], new AbortController().signal);
  assert.equal(g!.pass, true, g!.details ?? '');
  await fs.writeFile(path.join(root, 'broken.glb'), Buffer.alloc(40));
  [g] = await runGates(h.registry, host, ['gltf-valid'], new AbortController().signal);
  assert.equal(g!.pass, false);
  assert.match(g!.details ?? '', /broken\.glb: not a GLB file/);
  await h.close();
});

test('a model built in the browser is exported to .glb with browser save, inside the workspace only', { skip: !hasChromium && 'no Chromium' }, async () => {
  const h = await createHarness({ dataDir: await tempDir(), plugins: [path.join(here, '..', 'plugins')] });
  const root = await tempDir();
  const ctx = { host: new LocalHost(root), signal: new AbortController().signal, readFiles: new Map(), todos: [], setTodos() {}, emit() {} } as unknown as ToolContext;
  const tool = (n: string) => h.registry.tools.get(n)!;
  await tool('add_library').run({ name: 'three' }, ctx);
  await fs.writeFile(path.join(root, 'index.html'), `<script type="importmap">{"imports":{"three":"./vendor/three/build/three.module.js","three/addons/":"./vendor/three/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
const box = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 0.5), new THREE.MeshStandardMaterial({ name: 'Paint' }));
box.position.y = 1;
const g = new THREE.Group(); g.add(box);
window.exportGLB = () => new GLTFExporter().parseAsync(g, { binary: true });
</script>`);
  const r = await tool('browser').run({ screenshot: false, save: { path: 'out/box.glb', js: 'window.exportGLB()' } }, ctx);
  assert.match(r.content, /Saved out\/box\.glb: \d+ bytes/);
  const info = await tool('model_info').run({ path: 'out/box.glb' }, ctx);
  assert.match(info.content, /1 mesh\(es\), 12 triangles, 1 material\(s\), about 1 x 2 x 0\.5 m/);
  const outside = await tool('browser').run({ screenshot: false, save: { path: '../escape.glb', js: '"x"' } }, ctx).catch((e: Error) => ({ content: e.message }));
  assert.match(outside.content, /outside the workspace/);
  await h.close();
});
