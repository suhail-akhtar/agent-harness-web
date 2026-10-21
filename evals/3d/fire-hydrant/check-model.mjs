// Hidden check: the exported hydrant is about the right size and within budget.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const { inspectGltf, describeGltf } = await import(pathToFileURL(path.join(here, '..', '..', '..', 'plugins', 'games3d', 'lib-gltf.mjs')).href);
const g = await inspectGltf(path.resolve(process.argv[2] ?? 'model.glb'));
console.log(describeGltf(process.argv[2] ?? 'model.glb', g));
const problems = [];
if (!g.size) problems.push('no size');
else {
  if (g.size[1] < 0.55 || g.size[1] > 1.0) problems.push(`height ${g.size[1]} m, expected about 0.75 (Y up)`);
  if (Math.max(g.size[0], g.size[2]) > 0.8) problems.push(`footprint ${g.size[0]} x ${g.size[2]} m is too wide for a hydrant`);
}
if (g.triangles > 200_000) problems.push(`${g.triangles} triangles, budget 200k`);
if (g.materials < 2) problems.push('one material: paint, metal and bolts should differ');
if (problems.length) { console.log(problems.join('\n')); process.exit(1); }
