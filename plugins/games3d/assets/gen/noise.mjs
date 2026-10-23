// Seeded 2D noise: value, Perlin (gradient), simplex and Worley (cellular), with fBm,
// ridged and domain-warped variants. Value, Perlin and Worley take a period (in lattice
// cells) and then tile seamlessly: textures, tiles and parallax layers that repeat.

import { rng } from '../util/rng.mjs';

const mod = (a, n) => ((a % n) + n) % n;
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;

/** The noise functions for one seed. Each returns about [-1, 1] (worley: a distance, [0, ~1.2]). */
export function createNoise(seed = 0) {
  const r = rng(seed);
  const perm = new Uint16Array(512);
  const p = r.shuffle([...Array(256).keys()]);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const grads = Array.from({ length: 256 }, (_, i) => { const a = (i / 256) * Math.PI * 2 + r.range(0, 0.02); return [Math.cos(a), Math.sin(a)]; });
  const h = (x, y) => perm[perm[x & 255] + (y & 255)];

  const wrap = (i, period) => (period ? mod(i, period) : i);

  function value(x, y, px = 0, py = px) {
    const xi = Math.floor(x), yi = Math.floor(y), tx = fade(x - xi), ty = fade(y - yi);
    const v = (i, j) => h(wrap(xi + i, px), wrap(yi + j, py)) / 127.5 - 1;
    return lerp(lerp(v(0, 0), v(1, 0), tx), lerp(v(0, 1), v(1, 1), tx), ty);
  }

  function perlin(x, y, px = 0, py = px) {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const g = (i, j) => { const gr = grads[h(wrap(xi + i, px), wrap(yi + j, py))]; return gr[0] * (fx - i) + gr[1] * (fy - j); };
    const u = fade(fx), v = fade(fy);
    return lerp(lerp(g(0, 0), g(1, 0), u), lerp(g(0, 1), g(1, 1), u), v) * 1.414;
  }

  const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
  function simplex(x, y) {
    const s = (x + y) * F2, i = Math.floor(x + s), j = Math.floor(y + s);
    const t = (i + j) * G2, x0 = x - (i - t), y0 = y - (j - t);
    const [i1, j1] = x0 > y0 ? [1, 0] : [0, 1];
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const c = (gx, gy, dx, dy) => { let tt = 0.5 - dx * dx - dy * dy; if (tt < 0) return 0; tt *= tt; const gr = grads[h(gx, gy)]; return tt * tt * (gr[0] * dx + gr[1] * dy); };
    return 70 * (c(i, j, x0, y0) + c(i + i1, j + j1, x1, y1) + c(i + 1, j + 1, x2, y2));
  }

  /** Distances to the nearest feature points: f1, f2, or f2 - f1 (cell edges). */
  function worley(x, y, px = 0, py = px, mode = 'f1') {
    const xi = Math.floor(x), yi = Math.floor(y);
    let d1 = Infinity, d2 = Infinity;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const cx = xi + i, cy = yi + j, k = h(wrap(cx, px), wrap(cy, py));
        const fx = cx + (perm[k] / 255), fy = cy + (perm[k + 1] / 255);
        const d = Math.hypot(fx - x, fy - y);
        if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
      }
    }
    return mode === 'f2' ? d2 : mode === 'f2-f1' ? d2 - d1 : d1;
  }

  return { value, perlin, simplex, worley };
}

/**
 * A noise field: width x height values in [0, 1]. type value | perlin | simplex | worley |
 * ridged; scale is the feature size in pixels; tileable wraps both axes (not simplex: it
 * falls back to Perlin). warp > 0 displaces the samples by another noise (domain warp).
 */
export function noiseField({ width = 256, height = 256, type = 'perlin', scale = 64, octaves = 4, lacunarity = 2, gain = 0.5, seed = 0, tileable = false, warp = 0, worley = 'f1' } = {}) {
  const n = createNoise(seed);
  const wn = warp ? createNoise(`${seed}:warp`) : null;
  const kind = tileable && type === 'simplex' ? 'perlin' : type;
  // A tileable field needs whole lattice cells across: the scale is rounded to fit.
  const cellsX = Math.max(1, Math.round(width / scale)), cellsY = Math.max(1, Math.round(height / scale));
  const fx = tileable ? cellsX / width : 1 / scale, fy = tileable ? cellsY / height : 1 / scale;
  const lac = tileable ? Math.max(2, Math.round(lacunarity)) : lacunarity;
  const base = (x, y, o) => {
    const px = tileable ? cellsX * lac ** o : 0, py = tileable ? cellsY * lac ** o : 0;
    if (kind === 'value') return n.value(x, y, px, py);
    if (kind === 'simplex') return n.simplex(x, y);
    if (kind === 'worley') return 1 - Math.min(1, n.worley(x, y, px, py, worley)) * 2;
    if (kind === 'ridged') return 1 - Math.abs(n.perlin(x, y, px, py)) * 2;
    return n.perlin(x, y, px, py);
  };
  const out = new Float32Array(width * height);
  let lo = Infinity, hi = -Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sx = x * fx, sy = y * fy;
      if (wn) {
        const px = tileable ? cellsX : 0, py = tileable ? cellsY : 0;
        const wx = warp * wn.perlin(sx, sy, px, py), wy = warp * wn.perlin(sx + 17, sy + 31, px, py);
        sx += wx; sy += wy;
      }
      let sum = 0, amp = 1, norm = 0, f = 1;
      for (let o = 0; o < octaves; o++) {
        sum += amp * base(sx * f, sy * f, o);
        norm += amp; amp *= gain; f *= lac;
      }
      const v = sum / norm;
      out[y * width + x] = v;
      if (v < lo) lo = v; if (v > hi) hi = v;
    }
  }
  const span = hi - lo || 1;
  for (let i = 0; i < out.length; i++) out[i] = Math.min(1, Math.max(0, (out[i] - lo) / span));
  return out;
}
