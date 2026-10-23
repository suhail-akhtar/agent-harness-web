// Colours as [r, g, b, a] arrays (0-255): parsing, conversions, mixing, and the
// hue-shifted shade ramps pixel art uses (shadows cooler, highlights warmer).

const NAMES = {
  transparent: [0, 0, 0, 0], black: [0, 0, 0, 255], white: [255, 255, 255, 255], red: [220, 40, 40, 255], green: [60, 170, 60, 255],
  blue: [50, 90, 220, 255], yellow: [250, 210, 60, 255], orange: [240, 140, 40, 255], purple: [140, 70, 190, 255], gray: [128, 128, 128, 255],
  grey: [128, 128, 128, 255], brown: [130, 85, 50, 255], pink: [240, 130, 170, 255], cyan: [60, 200, 220, 255], gold: [240, 190, 50, 255],
};

/** A colour from '#rgb', '#rrggbb', '#rrggbbaa', a name, [r,g,b(,a)] or 0xRRGGBB. */
export function parseColor(c, fallback = [0, 0, 0, 255]) {
  if (c === undefined || c === null || c === '') return fallback;
  if (Array.isArray(c)) return [c[0] | 0, c[1] | 0, c[2] | 0, c[3] === undefined ? 255 : c[3] | 0];
  if (typeof c === 'number') return [(c >> 16) & 255, (c >> 8) & 255, c & 255, 255];
  const s = String(c).trim().toLowerCase();
  if (NAMES[s]) return [...NAMES[s]];
  const m = /^#?([0-9a-f]{3,8})$/.exec(s);
  if (!m) throw new Error(`not a colour: ${c}`);
  let h = m[1];
  if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join('');
  if (h.length !== 6 && h.length !== 8) throw new Error(`not a colour: ${c}`);
  const n = (i) => parseInt(h.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), h.length === 8 ? n(6) : 255];
}

export const toHex = (c, alpha = false) => `#${c.slice(0, alpha ? 4 : 3).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

export function rgbToHsv([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, max ? d / max : 0, max];
}

export function hsvToRgb(h, s, v, a = 255) {
  h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(1, s)); v = Math.max(0, Math.min(1, v));
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255), a];
}

export const mix = (a, b, t) => a.map((v, i) => Math.round(v + ((b[i] ?? 255) - v) * t));

/** Moves a hue toward a target hue by up to `amount` degrees (the short way round). */
function hueToward(h, target, amount) {
  const d = ((target - h + 540) % 360) - 180;
  return h + Math.sign(d) * Math.min(Math.abs(d), amount);
}

/**
 * A shade ramp around a base colour: `n` colours from darkest to lightest, the base in the
 * middle. Shadows shift toward blue-purple and lose value, highlights toward yellow and lose
 * saturation: how pixel artists shade, so ramps from different bases still sit together.
 */
export function ramp(base, n = 5, { shift = 1 } = {}) {
  const c = parseColor(base);
  const [h, s, v] = rgbToHsv(c);
  const mid = (n - 1) / 2;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = (i - mid) / (mid || 1); // -1 darkest .. +1 lightest
    if (t === 0) { out.push([...c]); continue; }
    const hh = t < 0 ? hueToward(h, 250, 22 * -t * shift) : hueToward(h, 55, 16 * t * shift);
    const ss = t < 0 ? Math.min(1, s * (1 + 0.15 * -t) + 0.04 * -t) : s * (1 - 0.45 * t);
    const vv = t < 0 ? v * (1 - 0.48 * -t) : v + (1 - v) * 0.6 * t + 0.06 * t;
    out.push(hsvToRgb(hh, ss, Math.min(1, vv), c[3]));
  }
  return out;
}

/** Perceptual-ish distance (redmean): good enough to map colours to a palette. */
export function colorDist(a, b) {
  const rm = (a[0] + b[0]) / 2;
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
}

export const luminance = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** A darker, more saturated version (outlines that take the colour they surround). */
export function darken(c, amount = 0.5) {
  const [h, s, v] = rgbToHsv(c);
  return hsvToRgb(hueToward(h, 250, 20 * amount), Math.min(1, s + 0.2 * amount), v * (1 - amount), c[3]);
}
