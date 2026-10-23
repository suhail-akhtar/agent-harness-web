// UI kits in pixel art: buttons in four states, nine-slice panels, bars (frame and fill),
// and icons, at several integer scales, with SVG versions of the vector icons.

import { darken, hsvToRgb, parseColor, ramp, rgbToHsv, toHex } from '../raster/color.mjs';
import { drawText, measureText } from '../raster/font.mjs';
import { Image } from '../raster/image.mjs';
import { materials, renderParts } from './parts.mjs';
import { renderSprite } from './sprite.mjs';

const desat = (c) => { const [h, s, v] = rgbToHsv(c); return hsvToRgb(h, s * 0.15, v * 0.8, c[3]); };

/** A rounded pixel rectangle: is (x, y) inside a w x h box with corner cut r? */
const inBox = (x, y, w, h, r) => {
  if (x < 0 || y < 0 || x >= w || y >= h) return false;
  const cx = x < r ? r - x : x >= w - r ? x - (w - 1 - r) : 0, cy = y < r ? r - y : y >= h - r ? y - (h - 1 - r) : 0;
  return cx + cy <= r;
};

/** A button: normal | hover | pressed | disabled, with an optional label in the pixel font. */
export function button(w, h, { color = '#3d7fd0', state = 'normal', label, radius = 2, textColor = '#ffffff' } = {}) {
  let base = parseColor(color);
  if (state === 'hover') base = ramp(base, 5)[3];
  if (state === 'disabled') base = desat(base);
  const R = ramp(base, 5);
  const img = new Image(w, h);
  const press = state === 'pressed' ? 1 : 0;
  const depth = press ? 1 : 2;
  const outline = darken(R[0], 0.5);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!inBox(x, y - press, w, h - press, radius)) continue;
    const bodyH = h - press - depth;
    const onEdge = !inBox(x - 1, y - press, w, h - press, radius) || !inBox(x + 1, y - press, w, h - press, radius) || !inBox(x, y - 1 - press, w, h - press, radius) || !inBox(x, y + 1 - press, w, h - press, radius);
    let c;
    if (onEdge) c = outline;
    else if (y - press >= bodyH) c = R[0];
    else if (y - press <= 1) c = R[4];
    else if (y - press === 2) c = R[3];
    else if (y - press >= bodyH - 1) c = R[1];
    else c = R[2];
    img.set(x, y, c);
  }
  if (label) {
    const m = measureText(label);
    const tx = Math.round((w - m.width) / 2), ty = Math.round((h - depth - press - m.height) / 2) + press;
    drawText(img, label, tx, ty, state === 'disabled' ? desat(parseColor(textColor)) : textColor, { shadow: toHex(R[0]) });
  }
  return img;
}

/** A nine-slice panel: w x h with a border of `border` px; margins say how to slice it. */
export function panel(w, h, { color = '#6a4a8a', style = 'bevel', border = 4 } = {}) {
  const R = ramp(color, 5);
  const img = new Image(w, h);
  const outline = darken(R[0], 0.5);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!inBox(x, y, w, h, 2)) continue;
    const edge = !inBox(x - 1, y, w, h, 2) || !inBox(x + 1, y, w, h, 2) || !inBox(x, y - 1, w, h, 2) || !inBox(x, y + 1, w, h, 2);
    const d = Math.min(x, y, w - 1 - x, h - 1 - y);
    let c;
    if (edge) c = outline;
    else if (d < border - 1) c = style === 'flat' ? R[1] : (x - y > w - h ? R[1] : y < h / 2 || x < w / 2 ? R[3] : R[1]);
    else if (d === border - 1) c = R[0];
    else c = style === 'wood' ? R[(Math.floor(y / 4) % 2) ? 2 : 1] : R[2];
    if (style === 'bevel' && d < border - 1 && !edge) c = (y < x && y < w - 1 - x) || (x < y && x < h - 1 - y) ? R[3] : R[1];
    img.set(x, y, c);
  }
  return { image: img, slice: { left: border, top: border, right: border, bottom: border } };
}

/** A bar: the frame (with a transparent well) and a fill strip to stretch or crop. */
export function bar(w, h, { fill = '#e8403a', back = '#2a2238', frame = '#c8c0d8' } = {}) {
  const F = ramp(frame, 5), C = ramp(fill, 5);
  const fr = new Image(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!inBox(x, y, w, h, 1)) continue;
    const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
    const inner = x >= 2 && y >= 2 && x < w - 2 && y < h - 2;
    fr.set(x, y, edge ? darken(F[0], 0.5) : inner ? parseColor(back) : y === 1 ? F[4] : F[2]);
  }
  const fillImg = new Image(w - 4, h - 4);
  fillImg.paint((x, y) => (y === 0 ? C[4] : y === 1 ? C[3] : y >= h - 5 ? C[1] : C[2]));
  const at = (frac) => { const o = fr.clone(); o.draw(fillImg.crop(0, 0, Math.max(0, Math.round((w - 4) * frac)), h - 4), 2, 2); return o; };
  return { frame: fr, fill: fillImg, at };
}

// Vector icons: polygons and circles in a 16-unit box (a shape list each).
const star = (cx, cy, r1, r2, n = 5) => Array.from({ length: n * 2 }, (_, i) => { const a = -Math.PI / 2 + (i * Math.PI) / n; const r = i % 2 ? r2 : r1; return [cx + Math.cos(a) * r, cy + Math.sin(a) * r]; });
const VECTOR = {
  star: [{ poly: star(8, 8.6, 7.2, 3.2) }],
  check: [{ poly: [[1.5, 8.5], [4, 6], [6.5, 8.5], [12, 3], [14.5, 5.5], [6.5, 13.5]] }],
  cross: [{ poly: [[2, 4.5], [4.5, 2], [8, 5.5], [11.5, 2], [14, 4.5], [10.5, 8], [14, 11.5], [11.5, 14], [8, 10.5], [4.5, 14], [2, 11.5], [5.5, 8]] }],
  play: [{ poly: [[4, 2], [13.5, 8], [4, 14]] }],
  pause: [{ poly: [[3, 2], [6.5, 2], [6.5, 14], [3, 14]] }, { poly: [[9.5, 2], [13, 2], [13, 14], [9.5, 14]] }],
  'arrow-right': [{ poly: [[1.5, 6], [8, 6], [8, 2], [14.5, 8], [8, 14], [8, 10], [1.5, 10]] }],
  'arrow-left': [{ poly: [[14.5, 6], [8, 6], [8, 2], [1.5, 8], [8, 14], [8, 10], [14.5, 10]] }],
  'arrow-up': [{ poly: [[6, 14.5], [6, 8], [2, 8], [8, 1.5], [14, 8], [10, 8], [10, 14.5]] }],
  'arrow-down': [{ poly: [[6, 1.5], [6, 8], [2, 8], [8, 14.5], [14, 8], [10, 8], [10, 1.5]] }],
  home: [{ poly: [[1.5, 8], [8, 1.5], [14.5, 8], [12.5, 8], [12.5, 14], [9.5, 14], [9.5, 10], [6.5, 10], [6.5, 14], [3.5, 14], [3.5, 8]] }],
  lock: [{ poly: [[2.5, 7.5], [13.5, 7.5], [13.5, 14.5], [2.5, 14.5]] }, { ring: [8, 5.5, 4, 1.4] }, { poly: [[4, 5.5], [5.4, 5.5], [5.4, 8], [4, 8]] }, { poly: [[10.6, 5.5], [12, 5.5], [12, 8], [10.6, 8]] }, { hole: [8, 10.5, 1.2] }],
  gear: [{ poly: Array.from({ length: 16 }, (_, i) => { const a = (i / 16) * Math.PI * 2; const r = i % 2 ? 5 : 7; return [8 + Math.cos(a) * r, 8 + Math.sin(a) * r]; }) }, { hole: [8, 8, 2.2] }],
  music: [{ poly: [[5, 3.5], [13.5, 1.5], [13.5, 11], [12, 11], [12, 4.5], [6.5, 5.8], [6.5, 12.5], [5, 12.5]] }, { circle: [4.3, 12.5, 2.4] }, { circle: [11.3, 11.2, 2.4] }],
  sound: [{ poly: [[1.5, 6], [4.5, 6], [8.5, 2], [8.5, 14], [4.5, 10], [1.5, 10]] }, { ring: [8.5, 8, 4.5, 1.2, 'right'] }, { ring: [8.5, 8, 7, 1.2, 'right'] }],
  plus: [{ poly: [[6, 2], [10, 2], [10, 6], [14, 6], [14, 10], [10, 10], [10, 14], [6, 14], [6, 10], [2, 10], [2, 6], [6, 6]] }],
  minus: [{ poly: [[2, 6], [14, 6], [14, 10], [2, 10]] }],
};

/** A vector icon as parts for the sprite renderer (one material). */
function iconParts(name, mat) {
  const parts = [];
  for (const s of VECTOR[name]) {
    if (s.poly) parts.push({ shape: 'poly', points: s.poly, mat, shade: 'sphere', contrast: 0.9, z: 1 });
    if (s.circle) parts.push({ shape: 'ellipse', cx: s.circle[0], cy: s.circle[1], rx: s.circle[2], ry: s.circle[2], mat, z: 1 });
    if (s.hole) parts.push({ shape: 'ellipse', cx: s.hole[0], cy: s.hole[1], rx: s.hole[2], ry: s.hole[2], mat, hole: true, z: 5 });
    if (s.ring) {
      const [cx, cy, r, t, side] = s.ring;
      const n = 20, outer = [], inner = [];
      for (let i = 0; i <= n; i++) {
        const a = side === 'right' ? -Math.PI / 3 + (i / n) * (2 * Math.PI / 3) : Math.PI + (i / n) * Math.PI;
        outer.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
        inner.push([cx + Math.cos(a) * (r - t), cy + Math.sin(a) * (r - t)]);
      }
      parts.push({ shape: 'poly', points: [...outer, ...inner.reverse()], mat, shade: 'flat', z: 1 });
    }
  }
  return parts;
}

export const ICONS = [...Object.keys(VECTOR), 'heart', 'coin', 'gem', 'sword', 'shield', 'potion', 'key', 'bomb'];

/** An icon at 16 x 16: vector ones in `color`, item ones from the sprite builder. */
export function icon(name, { color = '#f2c042', seed = 1 } = {}) {
  if (VECTOR[name]) return renderParts(iconParts(name, 'icon'), materials({ icon: color }), { width: 16, height: 16, outline: 'auto' }).image;
  if (ICONS.includes(name)) return Object.values(renderSprite({ kind: name, seed, size: 16 }).frames)[0][0];
  throw new Error(`unknown icon ${name}: one of ${ICONS.join(', ')}`);
}

/** A vector icon as SVG (scalable; the colour as a flat fill with a dark stroke). */
export function iconSvg(name, { color = '#f2c042', size = 64 } = {}) {
  if (!VECTOR[name]) return null;
  const stroke = toHex(darken(parseColor(color), 0.55));
  const body = VECTOR[name].map((s) => {
    if (s.poly) return `<polygon points="${s.poly.map((p) => p.map((v) => +v.toFixed(2)).join(',')).join(' ')}"/>`;
    if (s.circle) return `<circle cx="${s.circle[0]}" cy="${s.circle[1]}" r="${s.circle[2]}"/>`;
    if (s.hole) return `<circle cx="${s.hole[0]}" cy="${s.hole[1]}" r="${s.hole[2]}" fill="#00000000" stroke="none"/>`;
    if (s.ring) { const [cx, cy, r, t, side] = s.ring; const a0 = side === 'right' ? -Math.PI / 3 : Math.PI, a1 = side === 'right' ? Math.PI / 3 : 2 * Math.PI; const rr = r - t / 2; return `<path d="M${(cx + Math.cos(a0) * rr).toFixed(2)},${(cy + Math.sin(a0) * rr).toFixed(2)} A${rr},${rr} 0 0 1 ${(cx + Math.cos(a1) * rr).toFixed(2)},${(cy + Math.sin(a1) * rr).toFixed(2)}" fill="none" stroke="${color}" stroke-width="${t}"/>`; }
    return '';
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16"><g fill="${color}" stroke="${stroke}" stroke-width="0.6" stroke-linejoin="round">${body}</g></svg>\n`;
}

/**
 * A whole kit: { files: [{ path, image | text }], kit (the JSON) }, each image at every
 * scale (name@2x.png...), so it reads crisp in engines that do not scale pixel art well.
 */
export function uiKit({ color = '#3d7fd0', panelColor = '#6a4a8a', accent = '#f2c042', scales = [1, 2, 4], icons = ICONS, label = 'PLAY', seed = 1 } = {}) {
  const files = [];
  const kit = { scales, buttons: {}, panels: {}, bars: {}, icons: {} };
  const add = (name, img, extra = {}) => {
    for (const s of scales) {
      const p = s === 1 ? `${name}.png` : `${name}@${s}x.png`;
      files.push({ path: p, image: s === 1 ? img : img.scale(img.width * s, img.height * s) });
    }
    return { file: `${name}.png`, width: img.width, height: img.height, ...extra };
  };
  for (const state of ['normal', 'hover', 'pressed', 'disabled']) {
    kit.buttons[state] = add(`button_${state}`, button(48, 16, { color, state, label }), { slice: { left: 4, top: 4, right: 4, bottom: 5 } });
    kit.buttons[`${state}_blank`] = add(`button_${state}_blank`, button(24, 16, { color, state }), { slice: { left: 4, top: 4, right: 4, bottom: 5 } });
  }
  for (const style of ['bevel', 'flat', 'wood']) {
    const p = panel(48, 48, { color: style === 'wood' ? '#8a5a32' : panelColor, style });
    kit.panels[style] = add(`panel_${style}`, p.image, { slice: p.slice });
  }
  for (const [name, fill] of [['health', '#e8403a'], ['mana', '#3a6ae8'], ['stamina', '#4ac84a'], ['xp', accent]]) {
    const b = bar(48, 8, { fill });
    kit.bars[name] = { frame: add(`bar_${name}_frame`, b.frame), fill: add(`bar_${name}_fill`, b.fill, { offset: [2, 2] }), half: add(`bar_${name}_half`, b.at(0.5)) };
  }
  for (const name of icons) {
    const img = icon(name, { color: accent, seed });
    kit.icons[name] = add(`icon_${name}`, img);
    const svg = iconSvg(name, { color: accent });
    if (svg) { files.push({ path: `icon_${name}.svg`, text: svg }); kit.icons[name].svg = `icon_${name}.svg`; }
  }
  // A preview of the kit at 2x.
  const pv = new Image(220, 150, '#2a2a38');
  let x = 4;
  for (const st of ['normal', 'hover', 'pressed', 'disabled']) { pv.draw(button(48, 16, { color, state: st, label }), x, 4); x += 52; }
  ['bevel', 'flat', 'wood'].forEach((st, i) => pv.draw(panel(48, 48, { color: st === 'wood' ? '#8a5a32' : panelColor, style: st }).image, 4 + i * 52, 26));
  [['#e8403a', 0.8], ['#3a6ae8', 0.5], ['#4ac84a', 0.3], [accent, 1]].forEach(([c, f], i) => pv.draw(bar(48, 8, { fill: c }).at(f), 162, 26 + i * 12));
  icons.forEach((n, i) => pv.draw(icon(n, { color: accent, seed }), 4 + (i % 12) * 18, 80 + Math.floor(i / 12) * 18));
  files.push({ path: 'preview.png', image: pv.scale(pv.width * 2, pv.height * 2), role: 'preview' });
  return { files, kit };
}
