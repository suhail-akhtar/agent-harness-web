// The sprite renderer: a sprite is a list of parts (rectangles, rounded rectangles,
// ellipses, polygons), each with a material (a shade ramp) and a way to shade it (sphere,
// cylinder, bevelled flat, or a single tone). Parts are sampled at pixel centres after
// their group's transform for the frame (offset, rotation about a pivot, scale), so the
// same parts animate by moving groups. Then a selective outline and an optional palette.

import { darken, parseColor, ramp } from '../raster/color.mjs';
import { bayer, Image, pointInPolygon } from '../raster/image.mjs';

/** Default materials: base colours (ramps are made from them) and whether they shine. */
export const MATERIALS = {
  skin: { base: '#e8b48a' }, hair: { base: '#5a3a22' }, shirt: { base: '#3d7fd0' }, pants: { base: '#4a4f6a' }, boots: { base: '#5b3b24' },
  belt: { base: '#3b2a1e' }, cloth: { base: '#b8434a' }, leather: { base: '#8a5a32' }, wood: { base: '#9a6a3c' }, darkwood: { base: '#6a4426' },
  metal: { base: '#a8b4c4', gloss: true }, iron: { base: '#7a8494', gloss: true }, gold: { base: '#f2c042', gloss: true }, silver: { base: '#c8d0dc', gloss: true },
  steel: { base: '#c4ccd8', gloss: true }, bone: { base: '#e6dfc8' }, slime: { base: '#5cc85a', gloss: true }, leaf: { base: '#4f9d3a' }, bark: { base: '#7a5232' },
  stone: { base: '#8a8a94' }, moss: { base: '#6a8a3a' }, glass: { base: '#bfe6f2', gloss: true }, liquid: { base: '#d0405a', gloss: true },
  gem: { base: '#3ab0e8', gloss: true }, eye: { base: '#ffffff' }, pupil: { base: '#1a1428' }, mouth: { base: '#7a2a3a' }, fur: { base: '#6a4a8a' },
  ghost: { base: '#dde6f4' }, shadow: { base: '#000000' }, fire: { base: '#ff9a2a' }, dark: { base: '#2a2238' }, white: { base: '#f4f4f4' },
};

const LIGHT = (() => { const v = [-0.55, -0.75, 0.62]; const l = Math.hypot(...v); return v.map((x) => x / l); })();
const FRONT = LIGHT[2];

/** Materials with their ramps; overrides map a material to a colour (or { base, gloss }). */
export function materials(overrides = {}) {
  const out = {};
  const all = { ...MATERIALS };
  for (const [k, v] of Object.entries(overrides ?? {})) all[k] = typeof v === 'object' && !Array.isArray(v) ? { ...all[k], ...v } : { ...all[k], base: v };
  for (const [k, m] of Object.entries(all)) out[k] = { ...m, ramp: m.ramp ? m.ramp.map((c) => parseColor(c)) : ramp(m.base, 5) };
  return out;
}

const rad = (d) => (d * Math.PI) / 180;

/** Inverse of a group transform: from sprite space back to the part's own space. */
function inverse(t) {
  if (!t) return null;
  const { dx = 0, dy = 0, rot = 0, sx = 1, sy = 1, pivot = [0, 0] } = t;
  const c = Math.cos(-rad(rot)), s = Math.sin(-rad(rot));
  return (x, y) => {
    let px = x - dx - pivot[0], py = y - dy - pivot[1];
    [px, py] = [px * c - py * s, px * s + py * c];
    return [px / sx + pivot[0], py / sy + pivot[1]];
  };
}

/** Whether a point (in the part's space) is inside, and the shape's local normal there. */
function sample(p, x, y) {
  switch (p.shape) {
    case 'ellipse': {
      const nx = (x - p.cx) / p.rx, ny = (y - p.cy) / p.ry, d = nx * nx + ny * ny;
      return d <= 1 ? { nx, ny, edge: 1 - Math.sqrt(d) } : null;
    }
    case 'rect':
    case 'rrect': {
      if (x < p.x || y < p.y || x > p.x + p.w || y > p.y + p.h) return null;
      const r = p.shape === 'rrect' ? Math.min(p.r ?? 2, p.w / 2, p.h / 2) : 0;
      if (r) {
        const cx = Math.min(Math.max(x, p.x + r), p.x + p.w - r), cy = Math.min(Math.max(y, p.y + r), p.y + p.h - r);
        if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return null;
      }
      return { nx: ((x - p.x) / p.w) * 2 - 1, ny: ((y - p.y) / p.h) * 2 - 1, edge: Math.min(x - p.x, y - p.y, p.x + p.w - x, p.y + p.h - y) };
    }
    case 'poly': {
      if (!pointInPolygon(p.points, x, y)) return null;
      const b = p._b ?? (p._b = bbox(p.points));
      return { nx: ((x - b.x) / (b.w || 1)) * 2 - 1, ny: ((y - b.y) / (b.h || 1)) * 2 - 1, edge: 1 };
    }
    default: throw new Error(`unknown part shape ${p.shape}`);
  }
}

function bbox(pts) {
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** The ramp index (fractional) a part gets at a point, from its shading model. */
function tone(p, s, x, y, n) {
  const mode = p.shade ?? 'sphere';
  if (typeof p.tone === 'number') return p.tone;
  let N;
  if (mode === 'none') return (n - 1) / 2;
  if (mode === 'cylinder') { const nx = Math.max(-1, Math.min(1, s.nx)); N = [nx, -0.25, Math.sqrt(Math.max(0, 1 - nx * nx))]; }
  else if (mode === 'flat') {
    // A bevel: the lit edges (top, left) one shade up, the far edges one down.
    const b = p.bevel ?? 1.2;
    const lx = x - (p.x ?? x), ly = y - (p.y ?? y), rx = (p.x ?? x) + (p.w ?? 0) - x, ry = (p.y ?? y) + (p.h ?? 0) - y;
    const mid = (n - 1) / 2;
    if (p.shape === 'rect' || p.shape === 'rrect') {
      if (ly < b || lx < b * 0.8) return mid + 1;
      if (ry < b || rx < b * 0.8) return mid - 1;
    }
    return mid + (p.lift ?? 0);
  } else {
    const nx = s.nx, ny = s.ny, d = Math.min(1, nx * nx + ny * ny);
    N = [nx * 0.9, ny * 0.9, Math.sqrt(Math.max(0, 1 - d * 0.81))];
  }
  const I = N[0] * LIGHT[0] + N[1] * LIGHT[1] + N[2] * LIGHT[2];
  const t = Math.max(0, Math.min(1, 0.5 + (I - FRONT) * (p.contrast ?? 1.25) + (p.lift ?? 0) * 0.2));
  return t * (n - 1);
}

/**
 * Renders parts into a width x height image. transforms: { group: { dx, dy, rot, sx, sy, pivot } }.
 * Options: outline ('auto' | colour | 'none'), dither (ordered shading), tint (a colour mixed in).
 */
export function renderParts(parts, mats, { width, height, transforms = {}, outline = 'auto', dither = false, tint, tintAmount = 0.6, alpha = 255 } = {}) {
  const img = new Image(width, height);
  const owner = new Int16Array(width * height).fill(-1);
  // A frame may move a group in front of or behind others (transforms[group].z).
  const zOf = (p) => transforms[p.group]?.z ?? p.z ?? 0;
  const order = parts.map((p, i) => [p, i]).sort((a, b) => zOf(a[0]) - zOf(b[0]) || a[1] - b[1]);
  const inv = new Map();
  for (const [p] of order) {
    const t = transforms[p.group];
    if (t && !inv.has(p.group)) inv.set(p.group, inverse({ ...t, pivot: t.pivot ?? p.pivot ?? [0, 0] }));
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let k = order.length - 1; k >= 0; k--) {
        const [p, i] = order[k];
        if (p.hidden) continue;
        let [px, py] = [x + 0.5, y + 0.5];
        // A part's own pivot wins over its group's (two legs rotate about their own hips).
        const t = transforms[p.group];
        if (t) [px, py] = (p.pivot && !t.pivot ? inverse({ ...t, pivot: p.pivot }) : inv.get(p.group))(px, py);
        if (p.offset) { px -= p.offset[0]; py -= p.offset[1]; }
        const s = sample(p, px, py);
        if (!s) continue;
        if (p.hole) break; // a hole shows what is behind the whole sprite: nothing
        const m = mats[p.mat] ?? mats.cloth;
        const n = m.ramp.length;
        let ti = tone(p, s, px, py, n);
        ti = dither && p.dither !== false ? Math.floor(ti + bayer(x, y)) : Math.round(ti);
        ti = Math.max(0, Math.min(n - 1, ti));
        let c = [...m.ramp[ti]];
        // Glossy materials get a specular pixel near the light.
        if (m.gloss && p.shade !== 'none' && p.shade !== 'flat' && s.nx < -0.25 && s.ny < -0.25 && s.nx > -0.75 && s.ny > -0.75 && (s.nx + 0.5) ** 2 + (s.ny + 0.5) ** 2 < (p.spec ?? 0.045)) c = [255, 255, 245, 255];
        c[3] = p.alpha ?? (m.alpha ?? alpha);
        img.set(x, y, c);
        owner[y * width + x] = i;
        break;
      }
    }
  }
  // Contrast lines: a part marked line gets its darkest shade where it lies over a part behind it.
  if (parts.some((p) => p.line) && width >= 24) {
    const base = img.clone();
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = owner[y * width + x];
      if (i < 0 || !parts[i].line) continue;
      const behind = [[1, 0], [-1, 0], [0, 1]].some(([dx, dy]) => {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= width || Y >= height) return false;
        const j = owner[Y * width + X];
        return j >= 0 && j !== i && parts[j].group !== parts[i].group && zOf(parts[j]) < zOf(parts[i]) && parts[j].mat === parts[i].mat;
      });
      if (behind) { const c = (mats[parts[i].mat] ?? mats.cloth).ramp[0]; img.set(x, y, [c[0], c[1], c[2], base.alpha(x, y)]); }
    }
  }
  if (tint) {
    const tc = parseColor(tint);
    for (let i = 0; i < width * height; i++) if (img.data[i * 4 + 3]) for (let k = 0; k < 3; k++) img.data[i * 4 + k] += (tc[k] - img.data[i * 4 + k]) * tintAmount;
  }
  if (outline && outline !== 'none') {
    const out = img.clone();
    const fixed = outline === 'auto' ? null : parseColor(outline);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (img.alpha(x, y) > 0) continue;
      let nb = -1;
      for (const [dx, dy] of [[0, 1], [1, 0], [-1, 0], [0, -1]]) {
        const X = x + dx, Y = y + dy;
        if (X >= 0 && Y >= 0 && X < width && Y < height && owner[Y * width + X] >= 0 && parts[owner[Y * width + X]].outline !== false) { nb = owner[Y * width + X]; break; }
      }
      if (nb < 0) continue;
      // Selective outline: the darkest shade of the part it borders, darker still.
      out.set(x, y, fixed ?? darken((mats[parts[nb].mat] ?? mats.cloth).ramp[0], 0.45));
    }
    return { image: out, owner };
  }
  return { image: img, owner };
}

/** Scales a part list designed in a `from`-pixel box to a `to`-pixel box. */
export function scaleParts(parts, k) {
  if (k === 1) return parts;
  return parts.map((p) => {
    const q = { ...p };
    for (const key of ['x', 'y', 'w', 'h', 'cx', 'cy', 'rx', 'ry', 'r']) if (typeof q[key] === 'number') q[key] *= k;
    if (q.points) q.points = q.points.map(([x, y]) => [x * k, y * k]);
    if (q.pivot) q.pivot = q.pivot.map((v) => v * k);
    if (q.offset) q.offset = q.offset.map((v) => v * k);
    delete q._b;
    return q;
  });
}

export function scaleTransforms(tr, k) {
  const out = {};
  for (const [g, t] of Object.entries(tr)) out[g] = { ...t, dx: (t.dx ?? 0) * k, dy: (t.dy ?? 0) * k, ...(t.pivot ? { pivot: t.pivot.map((v) => v * k) } : {}) };
  return out;
}
