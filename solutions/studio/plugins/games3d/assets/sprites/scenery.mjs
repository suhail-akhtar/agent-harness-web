// Scenery: parallax backgrounds (sky, far and near mountains, hills, clouds, a tree line),
// each layer tiling horizontally; isometric 2:1 tiles and blocks for 2.5D; and particle
// textures (soft dots, sparks, smoke, flames, rings, stars).

import { mix, parseColor, ramp } from '../raster/color.mjs';
import { bayer, gradientAt, Image } from '../raster/image.mjs';
import { createNoise } from '../gen/noise.mjs';
import { rng } from '../util/rng.mjs';
import { terrainTexture } from './tiles.mjs';

const THEMES = {
  day: { sky: ['#5a9ae8', '#a8d8f8'], far: '#8aa8d0', mid: '#6a88b0', hills: '#5a9a4a', trees: '#3a6a3a', cloud: '#ffffff', sun: '#fff2b0' },
  dusk: { sky: ['#3a2a6a', '#e8806a'], far: '#8a5a8a', mid: '#5a3a6a', hills: '#3a2a4a', trees: '#2a1a34', cloud: '#f8b0a0', sun: '#ffd080' },
  night: { sky: ['#0a0a2a', '#2a3a6a'], far: '#2a3a5a', mid: '#1a2a44', hills: '#14203a', trees: '#0a1424', cloud: '#5a6a8a', sun: '#f0f0ff' },
  desert: { sky: ['#e8a85a', '#f8e0a8'], far: '#d8a878', mid: '#c08858', hills: '#d8b070', trees: '#a87848', cloud: '#fff0d8', sun: '#fff8e0' },
  snow: { sky: ['#9ab8d8', '#e0ecf8'], far: '#c8d8ec', mid: '#a8bcd8', hills: '#e8f0f8', trees: '#4a6a7a', cloud: '#ffffff', sun: '#ffffff' },
};

/** A horizon line that wraps: heights per column from periodic noise (period = width). */
function ridge(width, seed, { scale = 4, octaves = 4, sharp = false } = {}) {
  const n = createNoise(seed);
  const out = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    let v = 0, amp = 1, norm = 0;
    for (let o = 0; o < octaves; o++) {
      const per = scale * 2 ** o;
      let s = n.perlin((x / width) * per, o * 7.3, per, 0);
      if (sharp) s = 1 - Math.abs(s) * 2;
      v += s * amp; norm += amp; amp *= 0.5;
    }
    out[x] = v / norm;
  }
  return out;
}

/**
 * Parallax layers for a side-scroller, back to front: sky, far mountains, near mountains,
 * hills, clouds and a tree line. Every layer is width x height and tiles horizontally.
 * factor is the suggested scroll speed relative to the camera.
 */
export function parallax({ width = 384, height = 216, theme = 'day', seed = 0, steps = 6 } = {}) {
  const T = THEMES[theme] ?? THEMES.day;
  const r = rng(`${seed}:parallax`);
  const layers = [];
  const sky = new Image(width, height);
  sky.linearGradient(0, 0, 0, height * 0.85, [[0, T.sky[0]], [1, T.sky[1]]], { steps });
  if (theme === 'night') for (let i = 0; i < width * height / 220; i++) sky.set(r.int(0, width - 1), r.int(0, Math.floor(height * 0.7)), r.chance(0.2) ? [255, 255, 255, 255] : [180, 190, 230, 255]);
  const sx = r.int(width * 0.15, width * 0.8), sy = Math.round(height * (theme === 'dusk' ? 0.62 : 0.22)), sr = Math.round(height * 0.07);
  sky.radialGradient(sx, sy, sr * 3, [[0, [...parseColor(T.sun).slice(0, 3), 120]], [1, [...parseColor(T.sun).slice(0, 3), 0]]], { steps: 4 });
  sky.circle(sx, sy, sr, T.sun);
  layers.push({ name: 'sky', image: sky, factor: 0 });

  const mountains = (name, color, base, amp, scale, sharp, factor, hazeT) => {
    const img = new Image(width, height);
    const hgt = ridge(width, `${seed}:${name}`, { scale, sharp });
    const R = ramp(mix(parseColor(color), parseColor(T.sky[1]), hazeT), 5);
    const tops = Array.from({ length: width }, (_, x) => Math.round(height * (base - amp * hgt[x])));
    // Peaks: the highest point within 6 px either side. Each one lights its left face, and a
    // wedge of light runs down its right face from the summit (light from the upper left).
    const peaks = [];
    for (let x = 0; x < width; x++) {
      let best = true;
      for (let d = 1; d <= 6 && best; d++) if (tops[(x + d) % width] < tops[x] || tops[(x - d + width) % width] <= tops[x]) best = false;
      if (best) peaks.push(x);
    }
    const peakLeft = (x) => { let b = null; for (const p of peaks) { const d = (x - p + width) % width; if (b === null || d < b.d) b = { p, d }; } return b; };
    for (let x = 0; x < width; x++) {
      const top = tops[x];
      const pl = peakLeft(x);
      // Rising to the right over a 9 px window (a single-column wiggle does not flip the face).
      let rise = 0;
      for (let d = 1; d <= 4; d++) rise += tops[(x - d + width) % width] - tops[(x + d) % width];
      const rising = rise > 0;
      for (let y = Math.max(0, top); y < height; y++) {
        const depth = (y - top) / (height - top + 1);
        const wedge = pl && pl.d < (y - tops[pl.p]) * 0.45;
        let c = rising || wedge ? R[3] : R[1];
        if (!rising && !wedge && pl && pl.d < (y - tops[pl.p]) * 0.7) c = R[2];
        if (sharp && y - top < 3 && theme !== 'desert') c = mix(c, [255, 255, 255, 255], name === 'far' ? 0.6 : 0.3);
        if (depth > 0.45 + bayer(x, y) * 0.15) c = R[1];
        img.set(x, y, c);
      }
    }
    layers.push({ name, image: img, factor });
  };
  mountains('far', T.far, 0.62, 0.32, 3, true, 0.15, 0.45);
  mountains('mid', T.mid, 0.72, 0.24, 4, true, 0.3, 0.2);

  // Clouds: puffs of overlapping circles, flat-shaded, wrapping at the edges.
  const clouds = new Image(width, height);
  const C = ramp(T.cloud, 5);
  for (let i = 0; i < Math.max(3, Math.round(width / 90)); i++) {
    const cx = r.int(0, width - 1), cy = r.int(Math.round(height * 0.08), Math.round(height * 0.4)), w = r.int(20, 44);
    // Puffs above a flat base line, shaded on their undersides.
    const puffs = Array.from({ length: 6 }, () => [cx + r.int(-w / 2, w / 2), cy + r.int(-5, 1), r.int(5, 10)]);
    const baseY = cy + 4;
    for (const ox of [-width, 0, width]) {
      clouds.paint((x, y) => {
        if (y > baseY) return null;
        const inside = puffs.some(([px, py, pr]) => (x + 0.5 - px - ox) ** 2 + (y + 0.5 - py) ** 2 <= pr * pr);
        if (!inside) return null;
        const lit = puffs.some(([px, py, pr]) => (x + 1.5 - px - ox) ** 2 + (y + 2.5 - py) ** 2 <= (pr - 1) * (pr - 1));
        return y >= baseY - 1 || !lit ? C[1] : C[3];
      }, { x0: cx - w / 2 - 12 + ox, x1: cx + w / 2 + 12 + ox, y0: cy - 16, y1: baseY + 1 });
    }
  }
  layers.push({ name: 'clouds', image: clouds, factor: 0.2, drift: 4 });

  const hills = new Image(width, height);
  const hh = ridge(width, `${seed}:hills`, { scale: 3, octaves: 3 });
  const H = ramp(T.hills, 5);
  for (let x = 0; x < width; x++) {
    const top = Math.round(height * (0.8 - 0.12 * hh[x]));
    for (let y = top; y < height; y++) hills.set(x, y, y - top < 2 ? H[3] : (y - top) / (height - top) > 0.5 + bayer(x, y) * 0.2 ? H[1] : H[2]);
  }
  layers.push({ name: 'hills', image: hills, factor: 0.5 });

  const trees = new Image(width, height);
  const TR = ramp(T.trees, 5);
  const ground = Math.round(height * 0.9);
  for (let x = 0; x < width; x++) for (let y = ground; y < height; y++) trees.set(x, y, TR[1]);
  for (let i = 0; i < width / 9; i++) {
    const x = r.int(0, width - 1), h = r.int(14, 34), w = Math.round(h * 0.35);
    for (const ox of [-width, 0, width]) {
      if (r.chance(0.5)) trees.polygon([[x - w + ox, ground + 1], [x + ox, ground - h], [x + w + ox, ground + 1]], TR[2]);
      else { trees.circle(x + ox, ground - h * 0.6, w, TR[2]); trees.rect(x - 1 + ox, ground - h * 0.4, 2, h * 0.4 + 1, TR[0]); }
    }
  }
  layers.push({ name: 'trees', image: trees, factor: 0.8 });

  const composite = new Image(width, height);
  for (const l of layers) composite.draw(l.image, 0, 0);
  return { layers, composite, width, height, theme };
}

// ---------- isometric ----------

const ISO_TOPS = { grass: ['grass', 'dirt'], dirt: ['dirt', 'dirt'], stone: ['stone', 'stone'], sand: ['sand', 'sand'], snow: ['snow', 'dirt'], water: ['water', 'water'], brick: ['brick', 'brick'], wood: ['wood', 'wood'], lava: ['lava', 'stone'] };

/**
 * An isometric block (2:1): a diamond top w x w/2 over two side faces `depth` px tall, the
 * left side darker than the right, a 1 px outline. depth 0 gives a flat floor tile.
 */
export function isoTile(type = 'grass', { width = 32, depth = 16, seed = 0, outline = true } = {}) {
  const [topT, sideT] = ISO_TOPS[type] ?? [type, type];
  const hw = width / 2, hh = width / 4;
  const img = new Image(width, hh * 2 + depth);
  const top = terrainTexture(topT, 32, { seed });
  const side = terrainTexture(sideT, 32, { seed: `${seed}s` });
  for (let y = 0; y < img.height; y++) for (let x = 0; x < width; x++) {
    const px = x + 0.5, py = y + 0.5;
    // Inside the top diamond?
    const dx = Math.abs(px - hw) / hw, dy = Math.abs(py - hh) / hh;
    if (dx + dy <= 1) {
      // Texture coordinates: undo the isometric projection.
      const u = (px / hw + py / hh) / 2 - 0.5, v = (py / hh - px / hw) / 2 + 0.5;
      img.set(x, y, top.get(Math.floor(u * 31.99 + 32) % 32, Math.floor(v * 31.99 + 32) % 32));
      continue;
    }
    if (!depth || py < hh) continue;
    // Side faces: below the lower edges of the diamond, down `depth` px.
    const leftEdge = hh + (px / hw) * hh, rightEdge = hh + ((width - px) / hw) * hh;
    const edgeY = px < hw ? leftEdge : rightEdge;
    if (py > edgeY && py <= edgeY + depth) {
      const c = side.get(Math.floor(px) % 32, Math.floor(py - edgeY) % 32);
      const k = px < hw ? 0.62 : 0.8;
      img.set(x, y, type === 'grass' && py - edgeY < 3 ? mix(top.get(x % 32, 0), [0, 0, 0, 255], px < hw ? 0.3 : 0.15) : [c[0] * k, c[1] * k, c[2] * k, 255]);
    }
  }
  if (type === 'water') for (let i = 3; i < img.data.length; i += 4) if (img.data[i]) img.data[i] = 220;
  return outline ? img.outline([24, 20, 32, 255]) : img;
}

/** Draws a height grid of iso blocks (rows of type names or chars mapped by legend) as a preview. */
export function isoScene(grid, { width = 32, depth = 16, legend = {}, heights } = {}) {
  const rows = grid.length, cols = grid[0].length;
  const hw = width / 2, hh = width / 4;
  const maxH = heights ? Math.max(...heights.flat()) : 0;
  const img = new Image((rows + cols) * hw + 4, (rows + cols) * hh + depth * (maxH + 2) + 4);
  const cache = new Map();
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const t = legend[grid[y][x]] ?? grid[y][x];
    if (!t || t === ' ' || t === '.') continue;
    const key = `${t}`;
    if (!cache.has(key)) cache.set(key, isoTile(t, { width, depth }));
    const tile = cache.get(key);
    const h = heights?.[y]?.[x] ?? 0;
    for (let k = 0; k <= h; k++) img.draw(tile, (x - y) * hw + rows * hw - hw + 2, (x + y) * hh + depth * (maxH + 1) - k * depth + 2);
  }
  return img;
}

// ---------- particles ----------

export const PARTICLES = ['soft', 'spark', 'smoke', 'flame', 'ring', 'star', 'square', 'magic'];

/** A particle texture (white or tinted, alpha carries the shape), or frames for flames. */
export function particle(kind = 'soft', { size = 16, color = '#ffffff', seed = 0, frames = 1 } = {}) {
  const c = parseColor(color);
  const out = [];
  for (let f = 0; f < frames; f++) {
    const img = new Image(size, size);
    const h = size / 2;
    const n = createNoise(`${seed}:${kind}:${f}`);
    img.paint((x, y) => {
      const dx = (x + 0.5 - h) / h, dy = (y + 0.5 - h) / h, d = Math.hypot(dx, dy);
      let a = 0;
      if (kind === 'soft') a = Math.max(0, 1 - d) ** 2;
      else if (kind === 'spark') a = Math.max(0, 1 - Math.abs(dx) * 8) * Math.max(0, 1 - Math.abs(dy)) + Math.max(0, 1 - Math.abs(dy) * 8) * Math.max(0, 1 - Math.abs(dx)) + Math.max(0, 1 - d * 3) * 0.8;
      else if (kind === 'smoke') a = Math.max(0, 1 - d) * (0.55 + 0.45 * n.perlin(x / 4, y / 4)) * 1.3;
      else if (kind === 'ring') a = Math.max(0, 1 - Math.abs(d - 0.7) * 7);
      else if (kind === 'star') a = Math.sqrt(Math.abs(dx)) + Math.sqrt(Math.abs(dy)) < 0.95 ? 1 - d * 0.5 : 0;
      else if (kind === 'square') a = Math.abs(dx) < 0.6 && Math.abs(dy) < 0.6 ? 1 : 0;
      else if (kind === 'magic') a = (Math.max(0, 1 - d * 1.6) + Math.max(0, 1 - Math.abs(dx) * 10) * Math.max(0, 1 - Math.abs(dy) * 1.2) * 0.8 + Math.max(0, 1 - Math.abs(dy) * 10) * Math.max(0, 1 - Math.abs(dx) * 1.2) * 0.8);
      else if (kind === 'flame') {
        const t = f / Math.max(1, frames);
        const fy = (y + 0.5) / size, wob = n.perlin(x / 3, y / 3 + t * 4) * 0.25;
        const w = (1 - fy) * 0.15 + fy * 0.55 + wob * 0.3;
        a = Math.abs(dx) < w * (fy < 0.25 ? fy * 4 : 1) && fy > 0.05 ? 1 : 0;
        const heat = fy * (1 - Math.abs(dx) / (w || 1));
        const col = gradientAt([[0, '#c02a10'], [0.4, '#f8781a'], [0.75, '#ffd84a'], [1, '#fff8d0']], Math.max(0, Math.min(1, heat * 1.3)));
        return a ? [col[0], col[1], col[2], 255] : null;
      } else throw new Error(`unknown particle ${kind}: one of ${PARTICLES.join(', ')}`);
      a = Math.max(0, Math.min(1, a));
      return a > 0.02 ? [c[0], c[1], c[2], Math.round(a * 255)] : null;
    }, { blend: false });
    out.push(img);
  }
  return out;
}
