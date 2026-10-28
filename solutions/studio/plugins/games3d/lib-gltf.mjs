// Reads a glTF 2.0 file (.glb or .gltf) far enough to prove it is a usable
// model: valid container, meshes present, and its size, triangles and materials.

import fsp from 'node:fs/promises';
import path from 'node:path';

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

// 4x4 matrices, column-major as glTF stores them.
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function trs(t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) {
  const [x, y, z, w] = q;
  return [
    (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
    2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
    2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

export async function inspectGltf(file) {
  const buf = await fsp.readFile(file);
  let json;
  if (path.extname(file).toLowerCase() === '.glb') {
    if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB file (bad magic)');
    const version = buf.readUInt32LE(4);
    if (version !== 2) throw new Error(`GLB version ${version}, expected 2`);
    const length = buf.readUInt32LE(8);
    if (length !== buf.length) throw new Error(`GLB header says ${length} bytes, file has ${buf.length}`);
    const chunkLen = buf.readUInt32LE(12);
    if (buf.readUInt32LE(16) !== 0x4e4f534a) throw new Error('first GLB chunk is not JSON');
    json = JSON.parse(buf.subarray(20, 20 + chunkLen).toString('utf8'));
  } else {
    json = JSON.parse(buf.toString('utf8'));
    for (const b of json.buffers ?? []) {
      if (b.uri && !b.uri.startsWith('data:')) await fsp.access(path.join(path.dirname(file), decodeURIComponent(b.uri))).catch(() => { throw new Error(`missing buffer file ${b.uri}`); });
    }
  }
  if (json.asset?.version !== '2.0') throw new Error(`asset.version is ${json.asset?.version ?? 'missing'}, expected 2.0`);
  const meshes = json.meshes ?? [];
  const acc = json.accessors ?? [];
  let triangles = 0;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  // World size: compose each node's transform (matrix, or translation/rotation/scale)
  // down the tree and transform the corners of every primitive's POSITION bounds.
  const nodes = json.nodes ?? [];
  const visit = (i, parent, depth = 0) => {
    const n = nodes[i];
    if (!n || depth > 64) return;
    const m = mul(parent, n.matrix ?? trs(n.translation, n.rotation, n.scale));
    if (n.mesh !== undefined) {
      for (const p of meshes[n.mesh]?.primitives ?? []) {
        // Triangles per placed instance: shared meshes count once per node that uses them.
        if ((p.mode ?? 4) === 4) triangles += Math.floor(((p.indices !== undefined ? acc[p.indices]?.count : acc[p.attributes?.POSITION]?.count) ?? 0) / 3);
        const pos = acc[p.attributes?.POSITION];
        if (!pos?.min || !pos?.max) continue;
        for (let c = 0; c < 8; c++) {
          const v = [c & 1 ? pos.max[0] : pos.min[0], c & 2 ? pos.max[1] : pos.min[1], c & 4 ? pos.max[2] : pos.min[2]];
          for (let k = 0; k < 3; k++) {
            const w = m[k] * v[0] + m[4 + k] * v[1] + m[8 + k] * v[2] + m[12 + k];
            min[k] = Math.min(min[k], w); max[k] = Math.max(max[k], w);
          }
        }
      }
    }
    for (const ch of n.children ?? []) visit(ch, m, depth + 1);
  };
  const scene = json.scenes?.[json.scene ?? 0];
  for (const r of scene?.nodes ?? nodes.map((_, i) => i)) visit(r, IDENTITY);
  for (const a of acc) if (!COMPONENTS[a.type]) throw new Error(`accessor of unknown type ${a.type}`);
  const size = Number.isFinite(min[0]) ? max.map((v, k) => Math.round((v - min[k]) * 1000) / 1000) : null;
  return { meshes: meshes.length, nodes: nodes.length, materials: (json.materials ?? []).length, textures: (json.textures ?? []).length, animations: (json.animations ?? []).length, triangles, size, bytes: buf.length };
}

export function describeGltf(rel, g) {
  return `${rel}: ${g.meshes} mesh(es), ${g.triangles.toLocaleString('en')} triangles, ${g.materials} material(s)${g.textures ? `, ${g.textures} texture(s)` : ''}${g.animations ? `, ${g.animations} animation(s)` : ''}${g.size ? `, about ${g.size.join(' x ')} m` : ''}, ${(g.bytes / 1024).toFixed(0)} KB`;
}
