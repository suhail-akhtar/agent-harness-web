// Heightmaps: fBm terrain (optionally ridged, warped, an island), a little thermal erosion,
// then a 16-bit PNG, a shaded colour preview and splat masks (sand, grass, rock, snow by
// height and slope) that terrain shaders and engine terrain layers take.

import { gradientAt, Image } from '../raster/image.mjs';
import { noiseField } from './noise.mjs';

/**
 * Heights in [0, 1]. size: square side (2^n + 1 suits Unity and Unreal: 257, 513, 1025).
 * ridges in [0, 1] mixes ridged noise in (mountain chains); island pulls the edges down.
 */
export function heightmap({ size = 257, seed = 0, scale, octaves = 6, ridges = 0.3, warp = 0.6, island = false, erosion = 20, tileable = false } = {}) {
  const sc = scale ?? size / 3;
  const base = noiseField({ width: size, height: size, type: 'perlin', scale: sc, octaves, seed, warp, tileable });
  const ridge = ridges > 0 ? noiseField({ width: size, height: size, type: 'ridged', scale: sc * 1.3, octaves: Math.max(3, octaves - 1), seed: `${seed}:ridge`, tileable }) : null;
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      let v = base[i];
      if (ridge) v = v * (1 - ridges) + ridge[i] * ridge[i] * ridges * 1.1;
      if (island) {
        const dx = (x / (size - 1)) * 2 - 1, dy = (y / (size - 1)) * 2 - 1;
        const d = Math.min(1, Math.hypot(dx, dy) / 0.95);
        v = v * (1 - d ** 2.2) - 0.08 * d;
      }
      h[i] = v;
    }
  }
  if (erosion > 0) thermalErosion(h, size, erosion, tileable);
  return normalize(h);
}

function normalize(h) {
  let lo = Infinity, hi = -Infinity;
  for (const v of h) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const s = hi - lo || 1;
  for (let i = 0; i < h.length; i++) h[i] = (h[i] - lo) / s;
  return h;
}

/** Moves material down slopes steeper than a talus angle: softer, more natural terrain. */
export function thermalErosion(h, size, iterations = 20, wrap = false, talus = 4 / size) {
  const at = (x, y) => (wrap ? ((y + size) % size) * size + ((x + size) % size) : y * size + x);
  for (let it = 0; it < iterations; it++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        let maxD = 0, mi = -1;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (!wrap && (nx < 0 || ny < 0 || nx >= size || ny >= size)) continue;
          const j = at(nx, ny), d = h[i] - h[j];
          if (d > maxD) { maxD = d; mi = j; }
        }
        if (mi >= 0 && maxD > talus) { const m = (maxD - talus) * 0.25; h[i] -= m; h[mi] += m; }
      }
    }
  }
}

/** The slope at each point (0 flat .. 1 very steep) for heights spanning `heightScale` cells. */
export function slopes(h, size, heightScale = size / 4) {
  const s = new Float32Array(size * size);
  const at = (x, y) => h[Math.min(size - 1, Math.max(0, y)) * size + Math.min(size - 1, Math.max(0, x))];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * heightScale / 2, dy = (at(x, y + 1) - at(x, y - 1)) * heightScale / 2;
    s[y * size + x] = Math.min(1, Math.hypot(dx, dy) / 1.5);
  }
  return s;
}

const TERRAIN = [[0, '#2b4d8f'], [0.2, '#3f6fb5'], [0.27, '#d8c890'], [0.32, '#7fb04a'], [0.55, '#4d8a3a'], [0.7, '#7a6a55'], [0.85, '#9a9590'], [0.93, '#f2f4f7'], [1, '#ffffff']];

/** A colour preview with hillshading (light from the north-west). */
export function heightPreview(h, size, { water = 0.25, stops = TERRAIN } = {}) {
  const img = new Image(size, size);
  const at = (x, y) => h[Math.min(size - 1, Math.max(0, y)) * size + Math.min(size - 1, Math.max(0, x))];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const v = at(x, y);
    const nx = (at(x - 1, y) - at(x + 1, y)) * size * 0.25, ny = (at(x, y - 1) - at(x, y + 1)) * size * 0.25;
    const shade = Math.max(0.35, Math.min(1.25, 0.85 + (nx + ny) * 0.5));
    const t = v < water ? (v / water) * 0.22 : 0.22 + ((v - water) / (1 - water)) * 0.78;
    const c = gradientAt(stops, t);
    const k = v < water ? 1 : shade;
    img.set(x, y, [c[0] * k, c[1] * k, c[2] * k, 255]);
  }
  return img;
}

/**
 * Splat weights as RGBA: R sand (low), G grass, B rock (steep or high), A snow (highest).
 * They sum to 255 at every pixel, as terrain layer blends expect.
 */
export function splatMap(h, size, { water = 0.25, snow = 0.82, rockSlope = 0.45 } = {}) {
  const sl = slopes(h, size);
  const img = new Image(size, size);
  const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  for (let i = 0; i < size * size; i++) {
    const v = h[i], s = sl[i];
    let sand = 1 - smooth(water + 0.02, water + 0.08, v);
    let snowW = smooth(snow - 0.04, snow + 0.04, v);
    let rock = Math.max(smooth(rockSlope - 0.1, rockSlope + 0.1, s), smooth(snow - 0.2, snow - 0.05, v) * 0.6) * (1 - snowW * 0.7);
    let grass = Math.max(0, 1 - sand - rock - snowW);
    const sum = sand + grass + rock + snowW || 1;
    const q = [sand, grass, rock, snowW].map((w) => Math.round((w / sum) * 255));
    q[q.indexOf(Math.max(...q))] += 255 - q.reduce((a, b) => a + b, 0);
    img.data.set(q, i * 4);
  }
  return img;
}
