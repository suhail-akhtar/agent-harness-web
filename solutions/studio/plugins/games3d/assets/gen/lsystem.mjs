// L-systems: string rewriting (with stochastic rules) and turtles that draw the result:
// 2D for sprites and backgrounds, 3D branch segments for Blender trees and plants.
//
// Symbols: F draw forward, f move, + - turn (yaw), & ^ pitch, \ / roll, | turn around,
// [ ] push and pop, ! thinner, L a leaf, anything else is ignored by the turtle.

import { parseColor } from '../raster/color.mjs';
import { Image } from '../raster/image.mjs';
import { rng } from '../util/rng.mjs';

export const PRESETS = {
  tree: { axiom: 'FA', rules: { A: [{ to: '!F[&FLA]/////[&FLA]///////[&FLA]', weight: 1 }, { to: '!F[&FLA]//////[&FLA]', weight: 0.5 }], F: [{ to: 'F', weight: 0.7 }, { to: 'FF', weight: 0.3 }] }, iterations: 5, angle: 32, step: 0.7, width: 0.2, shrink: 0.8, taper: 0.74, leafSize: 0.4 },
  bush: { axiom: 'A', rules: { A: '[&FLA]/////[&FLA]///////[&FLA]', F: 'S/////F', S: 'FL' }, iterations: 4, angle: 28, step: 0.18, width: 0.05, shrink: 0.85, taper: 0.7 },
  pine: { axiom: 'FFFA', rules: { A: 'F[&&B]////[&&B]////[&&B]////[&&B]A', B: 'F[-FL][+FL]B' }, iterations: 5, angle: 30, step: 0.4, width: 0.16, shrink: 0.86, taper: 0.8 },
  fern: { axiom: 'X', rules: { X: 'F+[[X]-X]-F[-FX]+X', F: 'FF' }, iterations: 5, angle: 25, step: 0.05, width: 0.012, shrink: 0.9, taper: 0.85, flat: true },
  weed: { axiom: 'F', rules: { F: [{ to: 'F[+F]F[-F]F', weight: 1 }, { to: 'F[+F]F', weight: 0.5 }, { to: 'F[-F]F', weight: 0.5 }] }, iterations: 4, angle: 25.7, step: 0.04, width: 0.01, shrink: 0.95, taper: 0.9, flat: true },
};

/** Rewrites the axiom `iterations` times. Rules map a symbol to a string or [{ to, weight }]. */
export function expand({ axiom, rules, iterations = 4, seed = 0, maxLength = 200000 }) {
  const r = rng(seed);
  let s = String(axiom);
  for (let i = 0; i < iterations; i++) {
    let out = '';
    for (const ch of s) {
      const rule = rules[ch];
      out += rule === undefined ? ch : typeof rule === 'string' ? rule : r.weighted(rule.map((x) => x.to), rule.map((x) => x.weight ?? 1));
      if (out.length > maxLength) throw new Error(`the L-system grew past ${maxLength} symbols: use fewer iterations`);
    }
    s = out;
  }
  return s;
}

const rad = (d) => (d * Math.PI) / 180;

/**
 * The 3D turtle: segments { a, b, r0, r1, depth } in metres (Z up, the trunk along +Z) and
 * leaves { p, dir, size }. jitter randomizes angles a little so branches look grown.
 */
export function turtle3d(str, { angle = 25, step = 0.5, width = 0.15, shrink = 0.85, taper = 0.75, seed = 0, jitter = 0.25, leafSize = 0.25 } = {}) {
  const r = rng(`${seed}:turtle`);
  // The turtle's frame: heading H, left L, up U.
  let st = { p: [0, 0, 0], H: [0, 0, 1], L: [-1, 0, 0], U: [0, 1, 0], w: width, s: step, depth: 0 };
  const stack = [];
  const segments = [], leaves = [];
  const rot = (v, axis, a) => {
    const [x, y, z] = axis, c = Math.cos(a), s = Math.sin(a), d = v[0] * x + v[1] * y + v[2] * z;
    const cr = [y * v[2] - z * v[1], z * v[0] - x * v[2], x * v[1] - y * v[0]];
    return [0, 1, 2].map((k) => v[k] * c + cr[k] * s + axis[k] * d * (1 - c));
  };
  const turn = (axisName, a) => {
    const j = a * (1 + (r.next() - 0.5) * 2 * jitter);
    const axis = st[axisName];
    const others = { U: ['H', 'L'], L: ['H', 'U'], H: ['L', 'U'] }[axisName];
    for (const o of others) st[o] = rot(st[o], axis, j);
  };
  for (const ch of str) {
    if (ch === 'F' || ch === 'f') {
      const b = st.p.map((v, k) => v + st.H[k] * st.s);
      if (ch === 'F') segments.push({ a: st.p, b, r0: st.w, r1: st.w * taper ** 0.25, depth: st.depth });
      st = { ...st, p: b };
    } else if (ch === '+') turn('U', rad(angle));
    else if (ch === '-') turn('U', -rad(angle));
    else if (ch === '&') turn('L', rad(angle));
    else if (ch === '^') turn('L', -rad(angle));
    else if (ch === '\\') turn('H', rad(angle));
    else if (ch === '/') turn('H', -rad(angle));
    else if (ch === '|') turn('U', Math.PI);
    else if (ch === '[') { stack.push(st); st = { ...st, depth: st.depth + 1 }; }
    else if (ch === ']') st = stack.pop() ?? st;
    else if (ch === '!') st = { ...st, w: st.w * taper, s: st.s * shrink };
    else if (ch === 'L') leaves.push({ p: st.p, dir: st.H, size: leafSize * (0.7 + r.next() * 0.6) });
    // A slight pull upward (phototropism) keeps trees from sprawling.
    if (ch === 'F') { st.H = normalize(st.H.map((v, k) => v + [0, 0, 0.08][k])); }
  }
  return { segments, leaves };
}

const normalize = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };

/** A 2D drawing of an L-system (projected from the side) as a sprite with leaves; opts are the turtle's, size the image's. */
export function drawLsystem(str, opts = {}, { width = 64, height = 64 } = {}) {
  const { trunk = '#6b4a2f', leaf = '#4f9d3a', leafDark = '#2f6b2a', angle = 25, seed = 0, flat = false } = opts;
  const { segments, leaves } = flat ? turtle2d(str, opts) : turtle3d(str, { ...opts, seed });
  const pts = [...segments.flatMap((s) => [s.a, s.b]), ...leaves.map((l) => l.p)];
  if (!pts.length) return new Image(width, height);
  const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[2]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
  // Room for the leaves' radius and the outline, so the corners stay clear.
  const leafR = Math.max(0, ...leaves.map((l) => l.size));
  const spanX = (maxX - minX) + 2 * leafR, spanZ = (maxZ - minZ) + leafR;
  const scale = Math.min((width - 4) / (spanX || 1), (height - 3) / (spanZ || 1));
  const px = (p) => [(p[0] - (minX + maxX) / 2) * scale + width / 2, height - 2 - (p[2] - minZ) * scale];
  const img = new Image(width, height);
  const tc = parseColor(trunk), lc = parseColor(leaf), ld = parseColor(leafDark);
  for (const s of segments.sort((a, b) => a.depth - b.depth)) {
    const [x0, y0] = px(s.a), [x1, y1] = px(s.b);
    img.line(x0, y0, x1, y1, tc, Math.max(1, s.r0 * scale * 1.6));
  }
  const lr = rng(`${seed}:leaves`);
  for (const l of leaves) {
    const [x, y] = px(l.p);
    const rr = Math.max(1, l.size * scale * 0.9);
    img.circle(x + 0.5, y + 0.5, rr, ld);
    img.circle(x - rr * 0.25 + 0.5, y - rr * 0.3 + 0.5, rr * 0.75, lr.chance(0.5) ? lc : ld);
  }
  void angle;
  return img;
}

/** The classic flat turtle (fern, weed): +/- turn in the picture plane. */
function turtle2d(str, { angle = 25, step = 0.05, width = 0.01, taper = 0.9 } = {}) {
  let st = { x: 0, z: 0, a: rad(90 - 5), w: width, depth: 0 };
  const stack = [], segments = [], leaves = [];
  for (const ch of str) {
    if (ch === 'F' || ch === 'f') {
      const nx = st.x + Math.cos(st.a) * step, nz = st.z + Math.sin(st.a) * step;
      if (ch === 'F') segments.push({ a: [st.x, 0, st.z], b: [nx, 0, nz], r0: st.w, r1: st.w, depth: st.depth });
      st = { ...st, x: nx, z: nz };
    } else if (ch === '+') st = { ...st, a: st.a + rad(angle) };
    else if (ch === '-') st = { ...st, a: st.a - rad(angle) };
    else if (ch === '[') { stack.push(st); st = { ...st, depth: st.depth + 1, w: st.w * taper }; }
    else if (ch === ']') { leaves.push({ p: [st.x, 0, st.z], size: width * 1.5 }); st = stack.pop() ?? st; }
  }
  return { segments, leaves };
}
