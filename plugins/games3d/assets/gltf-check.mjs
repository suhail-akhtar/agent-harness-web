// A deeper glTF check than lib-gltf's inspection: reads the vertex data itself, so the
// asset-3d gate can say whether every mesh has normals and UVs, and how many of its
// triangles are degenerate (zero area or repeated corners).

import fsp from 'node:fs/promises';
import path from 'node:path';

const SIZES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

/** The JSON and binary buffers of a .glb or .gltf (bytes, and its path for external buffers). */
export async function loadGltf(bytes, file = 'model.glb') {
  const buf = Buffer.from(bytes);
  let json, bin = null;
  if (buf.readUInt32LE(0) === 0x46546c67) {
    const jl = buf.readUInt32LE(12);
    json = JSON.parse(buf.subarray(20, 20 + jl).toString('utf8'));
    const o = 20 + jl;
    if (o + 8 <= buf.length && buf.readUInt32LE(o + 4) === 0x004e4942) bin = buf.subarray(o + 8, o + 8 + buf.readUInt32LE(o));
  } else json = JSON.parse(buf.toString('utf8'));
  const buffers = [];
  for (const [i, b] of (json.buffers ?? []).entries()) {
    if (!b.uri) buffers.push(i === 0 ? bin : null);
    else if (b.uri.startsWith('data:')) buffers.push(Buffer.from(b.uri.split(',')[1], 'base64'));
    else buffers.push(await fsp.readFile(path.join(path.dirname(file), decodeURIComponent(b.uri))).catch(() => null));
  }
  return { json, buffers };
}

/** An accessor's values as an array of tuples (or null when its buffer is missing). */
export function readAccessor(g, index) {
  const a = g.json.accessors?.[index];
  if (!a) return null;
  const n = COUNT[a.type], size = SIZES[a.componentType];
  if (a.bufferView === undefined) return Array.from({ length: a.count }, () => new Array(n).fill(0));
  const bv = g.json.bufferViews[a.bufferView];
  const data = g.buffers[bv.buffer];
  if (!data) return null;
  const stride = bv.byteStride || n * size;
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const read = (o) => {
    switch (a.componentType) {
      case 5126: return data.readFloatLE(o);
      case 5125: return data.readUInt32LE(o);
      case 5123: return data.readUInt16LE(o);
      case 5122: return data.readInt16LE(o);
      case 5121: return data[o];
      default: return data.readInt8(o);
    }
  };
  const out = [];
  for (let i = 0; i < a.count; i++) {
    const t = [];
    for (let k = 0; k < n; k++) t.push(read(base + i * stride + k * size));
    out.push(t);
  }
  return out;
}

/**
 * Per primitive: attributes present, triangle count, degenerate triangles; plus totals and
 * the problems an asset gate reports (no normals, no UVs, degenerate share above 1%).
 */
export async function checkGltf(bytes, file) {
  const g = await loadGltf(bytes, file);
  const prims = [];
  let triangles = 0, degenerate = 0;
  const problems = [];
  (g.json.meshes ?? []).forEach((mesh, mi) => (mesh.primitives ?? []).forEach((p, pi) => {
    const name = `${mesh.name ?? `mesh ${mi}`}${mesh.primitives.length > 1 ? ` #${pi}` : ''}`;
    const attrs = Object.keys(p.attributes ?? {});
    const pos = readAccessor(g, p.attributes?.POSITION);
    const mode = p.mode ?? 4;
    let tris = 0, degen = 0;
    if (pos && mode === 4) {
      const idx = p.indices !== undefined ? readAccessor(g, p.indices)?.map((t) => t[0]) : pos.map((_, i) => i);
      for (let t = 0; idx && t + 2 < idx.length; t += 3) {
        tris++;
        const [i0, i1, i2] = [idx[t], idx[t + 1], idx[t + 2]];
        if (i0 === i1 || i1 === i2 || i0 === i2) { degen++; continue; }
        const [a, b, c] = [pos[i0], pos[i1], pos[i2]];
        if (!a || !b || !c) { degen++; continue; }
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const cr = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        if (Math.hypot(...cr) < 1e-10) degen++;
      }
    }
    triangles += tris; degenerate += degen;
    prims.push({ name, attributes: attrs, triangles: tris, degenerate: degen, material: p.material });
    if (!attrs.includes('NORMAL')) problems.push(`${name}: no normals (NORMAL)`);
    if (!attrs.includes('TEXCOORD_0')) problems.push(`${name}: no UVs (TEXCOORD_0): textures cannot be mapped`);
    if (!pos) problems.push(`${name}: its vertex data could not be read`);
  }));
  if (!prims.length) problems.push('no meshes');
  if (triangles && degenerate / triangles > 0.01) problems.push(`${degenerate} of ${triangles} triangles are degenerate (zero area or repeated corners)`);
  return { primitives: prims, triangles, degenerate, skins: (g.json.skins ?? []).length, animations: (g.json.animations ?? []).map((a) => a.name ?? 'unnamed'), images: (g.json.images ?? []).length, problems };
}
