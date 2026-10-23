// Sprite templates: a shape grammar per kind (characters, enemies, items, coins, gems,
// chests, trees, rocks...) that a seed varies (colours, proportions, hair, hats, weapons,
// cuts, shapes), with animations as per-frame group transforms. Designed in a 32 px box
// (items in 16) and scaled to the size asked.

import { hsvToRgb, rgbToHsv, toHex } from '../raster/color.mjs';
import { rng } from '../util/rng.mjs';

const pick = (r, a) => r.pick(a);
const SKIN = ['#f2c9a0', '#e8b48a', '#d49a6a', '#b07850', '#8a5a3a', '#6a4430'];
const HAIR = ['#2a1e18', '#5a3a22', '#8a5a2a', '#d0a050', '#e8d080', '#a03020', '#606070', '#e8e8f0', '#3a4aa0', '#c05090'];
const CLOTH = ['#3d7fd0', '#c8423e', '#3e9a4a', '#8a4ab0', '#d08a2a', '#2a8a8a', '#c04a8a', '#4a5ac0', '#7a7a2a', '#a05a3a'];

/** A colour a seed picks near a base hue family. */
const vary = (r, hex, dh = 12, ds = 0.1, dv = 0.08) => {
  const n = parseInt(hex.slice(1), 16);
  const [h, s, v] = rgbToHsv([(n >> 16) & 255, (n >> 8) & 255, n & 255]);
  return toHex(hsvToRgb(h + r.range(-dh, dh), s + r.range(-ds, ds), v + r.range(-dv, dv)));
};

// ---------- geometry helpers ----------

/** A part turned by deg about a point (rectangles become polygons; ellipses move their centre). */
function rotatePart(p, [ox, oy], deg) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const rot = ([x, y]) => [ox + (x - ox) * c - (y - oy) * s, oy + (x - ox) * s + (y - oy) * c];
  if (p.shape === 'ellipse') { const [cx, cy] = rot([p.cx, p.cy]); return { ...p, cx, cy }; }
  if (p.shape === 'rect' || p.shape === 'rrect') {
    const { x, y, w, h, ...rest } = p;
    return { ...rest, shape: 'poly', points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(rot) };
  }
  return { ...p, points: p.points.map(rot) };
}

/** Parts scaled by k about a point (the feet, so a figure shrinks toward the ground). */
function shrink(parts, k, [ox, oy]) {
  const sx = (x) => ox + (x - ox) * k, sy = (y) => oy + (y - oy) * k;
  return parts.map((p) => {
    const q = { ...p };
    if (q.x !== undefined) { q.x = sx(q.x); q.w *= k; }
    if (q.y !== undefined) { q.y = sy(q.y); q.h *= k; }
    if (q.cx !== undefined) { q.cx = sx(q.cx); q.rx *= k; }
    if (q.cy !== undefined) { q.cy = sy(q.cy); q.ry *= k; }
    if (q.r !== undefined) q.r *= k;
    if (q.points) q.points = q.points.map(([x, y]) => [sx(x), sy(y)]);
    if (q.pivot) q.pivot = [sx(q.pivot[0]), sy(q.pivot[1])];
    return q;
  });
}

// ---------- humanoids ----------

function humanoid(r, o = {}) {
  const skin = o.skin ?? pick(r, SKIN), hair = o.hair ?? pick(r, HAIR), shirt = o.shirt ?? pick(r, CLOTH), pants = o.pants ?? vary(r, pick(r, ['#4a4f6a', '#5a4030', '#3a3a48', '#2a4a6a', '#6a5a4a']));
  let hairStyle = o.hairStyle ?? pick(r, ['short', 'short', 'long', 'spiky', 'bald', 'ponytail']);
  const hat = o.hat ?? pick(r, ['none', 'none', 'none', 'cap', 'wizard', 'helmet', 'hood']);
  // Spikes and a ponytail's knot would poke through a hat.
  if (hat !== 'none' && (hairStyle === 'spiky' || hairStyle === 'ponytail')) hairStyle = 'short';
  const weapon = o.weapon ?? pick(r, ['none', 'sword', 'sword', 'staff', 'axe']);
  const view = o.view ?? 'side';
  const colors = { skin, hair, shirt, pants, boots: o.boots ?? vary(r, '#5b3b24'), belt: o.belt ?? '#3b2a1e', cloth: o.hatColor ?? vary(r, pick(r, CLOTH)), ...(o.colors ?? {}) };
  const P = [];
  const add = (p) => { P.push(p); return p; };
  const headW = 14 + (o.headSize ?? r.int(-1, 1)), bodyW = 10 + (o.bodyWidth ?? r.int(0, 2));
  if (view === 'front') {
    const cx = 16, hx = cx - headW / 2;
    add({ shape: 'rect', x: cx - 4.5, y: 22, w: 4, h: 7.5, mat: 'pants', shade: 'cylinder', group: 'legL', pivot: [cx - 2.5, 22], z: 1 });
    add({ shape: 'rrect', x: cx - 5, y: 28.5, w: 4.5, h: 3.5, r: 1.2, mat: 'boots', shade: 'flat', group: 'legL', z: 1 });
    add({ shape: 'rect', x: cx + 0.5, y: 22, w: 4, h: 7.5, mat: 'pants', shade: 'cylinder', group: 'legR', pivot: [cx + 2.5, 22], z: 1 });
    add({ shape: 'rrect', x: cx + 0.5, y: 28.5, w: 4.5, h: 3.5, r: 1.2, mat: 'boots', shade: 'flat', group: 'legR', z: 1 });
    add({ shape: 'rrect', x: cx - bodyW / 2, y: 13, w: bodyW, h: 11, r: 3, mat: 'shirt', shade: 'cylinder', group: 'body', z: 2 });
    add({ shape: 'rect', x: cx - bodyW / 2, y: 21, w: bodyW, h: 2, mat: 'belt', shade: 'flat', group: 'body', z: 3 });
    for (const side of [-1, 1]) {
      const ax = side < 0 ? cx - bodyW / 2 - 3 : cx + bodyW / 2 - 0.5;
      add({ shape: 'rrect', x: ax, y: 14, w: 3.5, h: 8, r: 1.5, mat: 'shirt', shade: 'cylinder', lift: -0.5, group: side < 0 ? 'armL' : 'armR', pivot: [ax + 1.75, 15], z: 3, line: true });
      add({ shape: 'ellipse', cx: ax + 1.75, cy: 22.5, rx: 1.9, ry: 1.9, mat: 'skin', group: side < 0 ? 'armL' : 'armR', z: 3 });
    }
    add({ shape: 'rrect', x: hx, y: 1.5, w: headW, h: 12.5, r: 5, mat: 'skin', group: 'head', z: 5 });
    for (const ex of [cx - 3.5, cx + 1.5]) {
      add({ shape: 'rect', x: ex, y: 7, w: 2, h: 3, mat: 'pupil', shade: 'none', group: 'head', z: 7 });
      add({ shape: 'rect', x: ex, y: 7, w: 1, h: 1, mat: 'eye', shade: 'none', tone: 4, group: 'head', z: 8 });
    }
    hairParts(add, hairStyle, hx, headW, 'front');
    hatParts(add, hat, hx, headW, 'front');
    if (weapon !== 'none') weaponParts(add, weapon, cx + bodyW / 2 + 1.2, 22.5, 'armR', 35);
    return { parts: shrink(P, 0.86, [16, 32]), colors, info: { hairStyle, hat, weapon, view } };
  }
  // Side view, facing right (3/4: both eyes show).
  const hx = 9.5 + (14 - headW) / 2, bx = 16.5 - bodyW / 2;
  add({ shape: 'rect', x: 13, y: 22, w: 4, h: 7.5, mat: 'pants', shade: 'cylinder', lift: -0.6, group: 'legB', pivot: [15, 22.5], z: 0 });
  add({ shape: 'rrect', x: 12.5, y: 28.5, w: 6, h: 3.5, r: 1.2, mat: 'boots', shade: 'flat', lift: -0.5, group: 'legB', pivot: [15, 22.5], z: 0 });
  add({ shape: 'rrect', x: 12, y: 14, w: 3.5, h: 8, r: 1.5, mat: 'shirt', shade: 'cylinder', lift: -0.8, group: 'armB', pivot: [13.75, 15], z: 1 });
  add({ shape: 'ellipse', cx: 13.75, cy: 22.4, rx: 1.9, ry: 1.9, mat: 'skin', lift: -0.5, group: 'armB', pivot: [13.75, 15], z: 1 });
  add({ shape: 'rrect', x: bx, y: 13, w: bodyW, h: 11, r: 3, mat: 'shirt', shade: 'cylinder', group: 'body', z: 2 });
  add({ shape: 'rect', x: bx, y: 21, w: bodyW, h: 2, mat: 'belt', shade: 'flat', group: 'body', z: 3 });
  add({ shape: 'rect', x: 16.5, y: 22, w: 4, h: 7.5, mat: 'pants', shade: 'cylinder', group: 'legF', pivot: [18.5, 22.5], z: 3 });
  add({ shape: 'rrect', x: 16, y: 28.5, w: 6, h: 3.5, r: 1.2, mat: 'boots', shade: 'flat', group: 'legF', pivot: [18.5, 22.5], z: 3 });
  add({ shape: 'rrect', x: hx, y: 1.5, w: headW, h: 12.5, r: 5, mat: 'skin', group: 'head', pivot: [16, 13], z: 5 });
  for (const ex of [hx + headW - 9.5, hx + headW - 4.5]) {
    add({ shape: 'rect', x: ex, y: 7, w: 2, h: 3, mat: 'pupil', shade: 'none', group: 'head', pivot: [16, 13], z: 7 });
    add({ shape: 'rect', x: ex, y: 7, w: 1, h: 1, mat: 'eye', shade: 'none', tone: 4, group: 'head', pivot: [16, 13], z: 8 });
  }
  hairParts(add, hairStyle, hx, headW, 'side');
  hatParts(add, hat, hx, headW, 'side');
  if (weapon !== 'none') weaponParts(add, weapon, 19.75, 22.5, 'armF', 55);
  add({ shape: 'rrect', x: 18, y: 14.5, w: 3.5, h: 8, r: 1.5, mat: 'shirt', shade: 'cylinder', lift: 0.2, group: 'armF', pivot: [19.75, 15.5], z: 9, line: true });
  add({ shape: 'ellipse', cx: 19.75, cy: 22.6, rx: 1.9, ry: 1.9, mat: 'skin', group: 'armF', pivot: [19.75, 15.5], z: 9 });
  // Room above the head for hats and jumps: the figure stands about 27 px tall in 32.
  return { parts: shrink(P, 0.86, [16, 32]), colors, info: { hairStyle, hat, weapon, view } };
}

function hairParts(add, style, hx, hw, view) {
  const g = { group: 'head', pivot: [16, 13], mat: 'hair' };
  if (style === 'bald') return;
  if (view === 'front') {
    add({ ...g, shape: 'rrect', x: hx - 0.5, y: 0.5, w: hw + 1, h: 5.5, r: 4, z: 6 });
    if (style === 'long') { add({ ...g, shape: 'rrect', x: hx - 1, y: 2, w: 3, h: 13, r: 1.5, z: 4 }); add({ ...g, shape: 'rrect', x: hx + hw - 2, y: 2, w: 3, h: 13, r: 1.5, z: 4 }); }
    if (style === 'spiky') add({ ...g, shape: 'poly', points: [[hx, 4], [hx + 2, -1], [hx + 4.5, 3], [hx + 7, -1.5], [hx + 9.5, 3], [hx + 12, -1], [hx + hw, 4]], z: 6 });
    if (style === 'ponytail') add({ ...g, shape: 'ellipse', cx: hx + hw / 2, cy: 0.8, rx: 2.5, ry: 2, z: 6 });
    return;
  }
  // Side: a cap of hair over the top and down the back (left), a fringe at the front.
  add({ ...g, shape: 'rrect', x: hx - 0.5, y: 0.5, w: hw + 0.5, h: 5, r: 4, z: 6 });
  add({ ...g, shape: 'rrect', x: hx - 0.5, y: 2, w: 5, h: style === 'long' ? 14 : 8, r: 2, z: 6 });
  if (style === 'spiky') add({ ...g, shape: 'poly', points: [[hx - 1, 4], [hx - 2, -1], [hx + 3, 2], [hx + 4, -2.5], [hx + 7.5, 1.5], [hx + 9.5, -2], [hx + 11, 2], [hx + hw + 1, 1], [hx + hw, 5]], z: 6 });
  if (style === 'ponytail') add({ ...g, shape: 'rrect', x: hx - 4, y: 4, w: 4.5, h: 9, r: 2, z: 4 });
  add({ ...g, shape: 'poly', points: [[hx + hw - 7, 4.5], [hx + hw, 4], [hx + hw + 0.5, 6.5], [hx + hw - 3, 5.5]], z: 6 });
}

function hatParts(add, hat, hx, hw, view) {
  const g = { group: 'head', pivot: [16, 13] };
  if (hat === 'cap') {
    add({ ...g, shape: 'rrect', x: hx - 0.5, y: 0, w: hw + 1, h: 5, r: 3.5, mat: 'cloth', z: 10 });
    if (view === 'side') add({ ...g, shape: 'rrect', x: hx + hw - 3, y: 3.5, w: 7, h: 2, r: 1, mat: 'cloth', shade: 'flat', lift: -1, z: 10 });
    else add({ ...g, shape: 'rect', x: hx - 1, y: 4, w: hw + 2, h: 1.5, mat: 'cloth', shade: 'flat', lift: -1, z: 10 });
  } else if (hat === 'wizard') {
    const tip = view === 'side' ? [hx + 1, -4.5] : [hx + hw / 2, -5];
    add({ ...g, shape: 'poly', points: [[hx + 1.5, 3], [hx + hw * 0.35, -1.5], tip, [hx + hw * 0.6, -0.5], [hx + hw - 1.5, 3]], mat: 'cloth', z: 10 });
    add({ ...g, shape: 'rrect', x: hx - 3, y: 2.5, w: hw + 6, h: 2.5, r: 1.2, mat: 'cloth', shade: 'flat', lift: -0.6, z: 11 });
  } else if (hat === 'helmet') {
    add({ ...g, shape: 'rrect', x: hx - 1, y: -0.5, w: hw + 2, h: 6.5, r: 4.5, mat: 'metal', z: 10 });
    add({ ...g, shape: 'rect', x: hx - 1, y: 4.5, w: hw + 2, h: 1.5, mat: 'metal', shade: 'flat', lift: -1, z: 11 });
  } else if (hat === 'hood') {
    add({ ...g, shape: 'rrect', x: hx - 1.5, y: -0.5, w: hw + 3, h: 15, r: 6, mat: 'cloth', z: 4 });
    add({ ...g, shape: 'rrect', x: hx - 1.5, y: -0.5, w: hw + 3, h: 5.5, r: 5, mat: 'cloth', z: 10 });
    add({ ...g, shape: 'rrect', x: hx - 1.5, y: 1, w: view === 'side' ? 5.5 : 2.5, h: 13, r: 2, mat: 'cloth', z: 10 });
    if (view === 'front') add({ ...g, shape: 'rrect', x: hx + hw - 1, y: 1, w: 2.5, h: 13, r: 2, mat: 'cloth', z: 10 });
  }
}

function weaponParts(push, weapon, hx, hy, group, angle = 0) {
  const g = { group, pivot: group === 'armF' ? [19.75, 15.5] : undefined };
  // Drawn pointing up from the hand, then turned forward by `angle`.
  const add = (p) => push(angle ? rotatePart(p, [hx, hy], angle) : p);
  if (weapon === 'sword') {
    add({ ...g, shape: 'poly', points: [[hx - 1, hy - 1.5], [hx - 1, hy - 12], [hx, hy - 13.5], [hx + 1, hy - 12], [hx + 1, hy - 1.5]], mat: 'steel', shade: 'cylinder', z: 8 });
    add({ ...g, shape: 'rect', x: hx - 3, y: hy - 2.5, w: 6, h: 1.6, mat: 'gold', shade: 'flat', z: 8 });
    add({ ...g, shape: 'rect', x: hx - 0.8, y: hy - 1, w: 1.6, h: 3, mat: 'leather', shade: 'none', z: 8 });
  } else if (weapon === 'staff') {
    add({ ...g, shape: 'rect', x: hx - 0.9, y: hy - 16, w: 1.8, h: 22, mat: 'wood', shade: 'cylinder', z: 8 });
    add({ ...g, shape: 'ellipse', cx: hx, cy: hy - 17, rx: 2.4, ry: 2.4, mat: 'gem', z: 8 });
  } else if (weapon === 'axe') {
    add({ ...g, shape: 'rect', x: hx - 0.8, y: hy - 11, w: 1.6, h: 14, mat: 'wood', shade: 'cylinder', z: 8 });
    add({ ...g, shape: 'poly', points: [[hx + 0.5, hy - 11], [hx + 5.5, hy - 13], [hx + 6.5, hy - 9], [hx + 5.5, hy - 5], [hx + 0.5, hy - 7]], mat: 'iron', z: 8 });
  }
}

// ---------- animations ----------

const sin = (a) => Math.sin(a), cos = (a) => Math.cos(a), TAU = Math.PI * 2;

/** Per-frame group transforms for humanoids, side or front view. */
function humanoidAnims(view) {
  const upper = ['body', 'head', 'armF', 'armB', 'armL', 'armR'];
  const lift = (dy) => Object.fromEntries(upper.map((g) => [g, { dy }]));
  if (view === 'front') {
    return {
      idle: [0, 0, 1, 1].map((dy) => lift(dy)),
      walk: [0, 1, 2, 3].map((i) => ({ ...lift(i % 2 ? -1 : 0), legL: { dy: i === 1 ? -1.5 : 0 }, legR: { dy: i === 3 ? -1.5 : 0 }, armL: { dy: i % 2 ? -1 : 0, rot: i === 1 ? -15 : i === 3 ? 15 : 0 }, armR: { dy: i % 2 ? -1 : 0, rot: i === 1 ? -15 : i === 3 ? 15 : 0 } })),
      jump: [{ ...lift(2), legL: { dy: 1 }, legR: { dy: 1 } }, { ...lift(-3), legL: { dy: -3 }, legR: { dy: -3 }, armL: { dy: -3, rot: 120 }, armR: { dy: -3, rot: -120 } }, { ...lift(-4), legL: { dy: -4 }, legR: { dy: -4 }, armL: { dy: -4, rot: 60 }, armR: { dy: -4, rot: -60 } }, { ...lift(-1), legL: { dy: -1 }, legR: { dy: -1 } }],
      attack: [-140, -60, 30, 0].map((rot) => ({ armR: { rot } })),
    };
  }
  return {
    idle: [0, 0, 1, 1].map((dy, i) => ({ ...lift(dy), armF: { dy, rot: i > 1 ? 3 : 0 }, armB: { dy, rot: i > 1 ? -3 : 0 } })),
    walk: Array.from({ length: 6 }, (_, i) => {
      const a = (i / 6) * TAU, s = sin(a);
      const bob = -Math.round(Math.abs(cos(a)) * 1);
      return { ...lift(bob), legF: { rot: -s * 32, dy: 0 }, legB: { rot: s * 32 }, armF: { dy: bob, rot: s * 28 }, armB: { dy: bob, rot: -s * 28 } };
    }),
    jump: [
      { ...lift(2), legF: { rot: -20, dy: 1 }, legB: { rot: 15, dy: 1 }, armF: { dy: 2, rot: 25 }, armB: { dy: 2, rot: 20 } },
      { ...lift(-2), legF: { rot: -40, dy: -3 }, legB: { rot: 25, dy: -2 }, armF: { dy: -2, rot: -150 }, armB: { dy: -2, rot: -120 } },
      { ...lift(-3), legF: { rot: -55, dy: -4 }, legB: { rot: 35, dy: -3 }, armF: { dy: -3, rot: -100 }, armB: { dy: -3, rot: -80 } },
      { ...lift(-1), legF: { rot: 10, dy: -1 }, legB: { rot: -10, dy: -1 }, armF: { dy: -1, rot: -40 }, armB: { dy: -1, rot: -30 } },
    ],
    attack: [
      { armF: { rot: -150, z: 4 }, body: { dx: -0.5 }, head: { dx: -0.5 } },
      { armF: { rot: -100, z: 4 }, body: { dx: 0 } },
      { armF: { rot: 15 }, body: { dx: 1 }, head: { dx: 1 }, legF: { rot: -12 } },
      { armF: { rot: 50 }, body: { dx: 1 }, head: { dx: 1 }, legF: { rot: -12 } },
    ],
    hurt: [{ ...lift(0), body: { dx: -1 }, head: { dx: -2, rot: -10 }, armF: { rot: -40 }, armB: { rot: -40 } }, { ...lift(1), body: { dx: -1 }, head: { dx: -1 } }],
  };
}

// ---------- creatures ----------

/** A gumdrop: a rounded top on a flat bottom (cx, bottom y, half width, height). */
function dome(cx, by, hw, h) {
  const pts = [];
  for (let i = 0; i <= 16; i++) {
    const t = (i / 16) * Math.PI;
    const c = Math.cos(t), sn = Math.sin(t);
    pts.push([cx - hw * Math.sign(c) * Math.abs(c) ** 0.8, by - 2 - h * 0.85 * sn ** 0.9]);
  }
  pts.push([cx + hw - 1, by], [cx - hw + 1, by]);
  return pts;
}

function slime(r) {
  const color = vary(r, pick(r, ['#5cc85a', '#5aa8e8', '#e85a7a', '#b05ae8', '#e8b83a']), 8);
  const P = [
    { shape: 'poly', points: dome(16, 32, 13, 16), mat: 'slime', group: 'body', pivot: [16, 31.5], z: 1, spec: 0.08 },
    { shape: 'rect', x: 10.5, y: 18, w: 2.5, h: 4, mat: 'pupil', shade: 'none', group: 'body', pivot: [16, 31.5], z: 3 },
    { shape: 'rect', x: 18.5, y: 18, w: 2.5, h: 4, mat: 'pupil', shade: 'none', group: 'body', pivot: [16, 31.5], z: 3 },
    { shape: 'rect', x: 10.5, y: 18, w: 1, h: 1.2, mat: 'eye', shade: 'none', tone: 4, group: 'body', pivot: [16, 31.5], z: 4 },
    { shape: 'rect', x: 18.5, y: 18, w: 1, h: 1.2, mat: 'eye', shade: 'none', tone: 4, group: 'body', pivot: [16, 31.5], z: 4 },
    { shape: 'rect', x: 14.5, y: 24, w: 3, h: 1, mat: 'pupil', shade: 'none', group: 'body', pivot: [16, 31.5], z: 3 },
  ];
  const squash = (sx, sy, dy = 0) => ({ body: { sx, sy, dy } });
  return {
    parts: P, colors: { slime: color },
    anims: {
      idle: [squash(1, 1), squash(1.04, 0.96), squash(1.08, 0.9), squash(1.04, 0.96)],
      walk: [squash(1.1, 0.85), squash(0.9, 1.12, -3), squash(0.95, 1.05, -6), squash(1, 1, -3), squash(1.15, 0.8)],
      jump: [squash(1.15, 0.8), squash(0.85, 1.2, -6), squash(0.95, 1.05, -10), squash(1, 1, -4)],
      attack: [squash(1.2, 0.75), squash(0.8, 1.25, -2), squash(1.3, 0.85), squash(1, 1)],
      hurt: [{ body: { sx: 1.1, sy: 0.9, dx: -2 } }, squash(1, 1)],
    },
    info: { color },
  };
}

function bat(r) {
  const fur = vary(r, pick(r, ['#5a4a7a', '#3a3448', '#7a3a4a', '#4a5a6a']), 8);
  const wing = (side) => {
    const s = side;
    const px = 16 + s * 4;
    return { shape: 'poly', points: [[px, 13], [16 + s * 15, 7], [16 + s * 14, 14], [16 + s * 11, 13], [16 + s * 9.5, 18], [16 + s * 7, 15.5], [px, 18]], mat: 'fur', shade: 'flat', lift: -0.4, group: s < 0 ? 'wingL' : 'wingR', pivot: [px, 15], z: 0 };
  };
  const P = [
    wing(-1), wing(1),
    { shape: 'ellipse', cx: 16, cy: 16, rx: 5.5, ry: 6, mat: 'fur', group: 'body', z: 2 },
    { shape: 'poly', points: [[12, 12], [12.5, 6.5], [15, 10.5]], mat: 'fur', shade: 'flat', group: 'body', z: 2 },
    { shape: 'poly', points: [[20, 12], [19.5, 6.5], [17, 10.5]], mat: 'fur', shade: 'flat', group: 'body', z: 2 },
    { shape: 'rect', x: 13, y: 14, w: 2, h: 2, mat: 'gold', shade: 'none', tone: 3, group: 'body', z: 3 },
    { shape: 'rect', x: 17, y: 14, w: 2, h: 2, mat: 'gold', shade: 'none', tone: 3, group: 'body', z: 3 },
    { shape: 'rect', x: 14.5, y: 18.5, w: 1, h: 1.5, mat: 'white', shade: 'none', tone: 4, group: 'body', z: 3 },
    { shape: 'rect', x: 16.5, y: 18.5, w: 1, h: 1.5, mat: 'white', shade: 'none', tone: 4, group: 'body', z: 3 },
  ];
  const flap = (a, dy) => ({ wingL: { rot: a, dy }, wingR: { rot: -a, dy }, body: { dy } });
  return {
    parts: P, colors: { fur },
    anims: { idle: [flap(0, 0), flap(-35, -1), flap(-55, -1), flap(-30, 0), flap(20, 1), flap(10, 0)], walk: [flap(0, 0), flap(-45, -1), flap(-60, -2), flap(20, 1)], attack: [flap(-60, -2), flap(30, 2), flap(10, 1), flap(0, 0)], hurt: [flap(40, 0), flap(0, 0)] },
    info: { fur },
  };
}

function ghost(r) {
  const tint = vary(r, '#dde6f4', 30, 0.15, 0.04);
  const body = (phase) => {
    const pts = [[6, 16]];
    for (let i = 0; i <= 8; i++) { const a = (i / 8) * Math.PI; pts.push([16 - 10 * Math.cos(a), 16 - 12 * Math.sin(a)]); }
    pts.push([26, 16]);
    for (let i = 0; i <= 10; i++) { const x = 26 - i * 2; pts.push([x, 28 + (i % 2 ? -2.5 : 0) + Math.sin(phase + i) * 0.8]); }
    return pts;
  };
  const P = [
    { shape: 'poly', points: body(0), mat: 'ghost', shade: 'sphere', group: 'body', z: 1, alpha: 225 },
    { shape: 'ellipse', cx: 12.5, cy: 13, rx: 1.8, ry: 2.6, mat: 'pupil', shade: 'none', group: 'body', z: 2 },
    { shape: 'ellipse', cx: 19.5, cy: 13, rx: 1.8, ry: 2.6, mat: 'pupil', shade: 'none', group: 'body', z: 2 },
    { shape: 'ellipse', cx: 16, cy: 19, rx: 2.2, ry: 1.6, mat: 'pupil', shade: 'none', group: 'body', z: 2 },
  ];
  return {
    parts: P, colors: { ghost: tint },
    anims: { idle: [0, -1, -2, -1].map((dy) => ({ body: { dy } })), walk: [0, -1, -2, -1].map((dy, i) => ({ body: { dy, dx: i % 2 } })), attack: [{ body: { sx: 1.1, sy: 1.1, pivot: [16, 20] } }, { body: { sx: 1.25, sy: 1.25, pivot: [16, 20] } }, { body: {} }], hurt: [{ body: { dx: -2 } }, { body: {} }] },
    info: { tint },
  };
}

// ---------- items and props ----------

function coin(r, o) {
  const metal = o.metal ?? pick(r, ['gold', 'gold', 'silver']);
  const P = [
    { shape: 'ellipse', cx: 8, cy: 8, rx: 6.5, ry: 6.5, mat: metal, group: 'coin', pivot: [8, 8], z: 0, spec: 0.06 },
    { shape: 'ellipse', cx: 8, cy: 8, rx: 4.6, ry: 4.6, mat: metal, shade: 'none', tone: 1.4, group: 'coin', pivot: [8, 8], z: 1 },
    { shape: 'ellipse', cx: 8.3, cy: 8.3, rx: 3.7, ry: 3.7, mat: metal, shade: 'none', tone: 2.6, group: 'coin', pivot: [8, 8], z: 2 },
    { shape: 'rect', x: 7.2, y: 5.5, w: 1.6, h: 5, mat: metal, shade: 'none', tone: 4, group: 'coin', pivot: [8, 8], z: 3 },
  ];
  const spin = [1, 0.75, 0.35, 0.12, 0.35, 0.75];
  return { parts: P, size: 16, anims: { idle: spin.map((sx) => ({ coin: { sx } })), spin: spin.map((sx) => ({ coin: { sx } })) }, info: { metal } };
}

function gem(r, o) {
  const color = o.color ?? pick(r, ['#3ab0e8', '#e84a6a', '#4ae86a', '#b85ae8', '#f2c042', '#e8e8f8']);
  const cut = o.cut ?? pick(r, ['round', 'diamond', 'emerald']);
  let outer, facets;
  if (cut === 'diamond') {
    outer = [[3, 6], [6, 2.5], [10, 2.5], [13, 6], [8, 14]];
    facets = [{ points: [[3, 6], [6, 2.5], [10, 2.5], [13, 6]], tone: 3.6 }, { points: [[3, 6], [8, 14], [6.5, 6]], tone: 1.4 }, { points: [[13, 6], [8, 14], [9.5, 6]], tone: 0.6 }, { points: [[6.5, 6], [9.5, 6], [8, 14]], tone: 2.4 }];
  } else if (cut === 'emerald') {
    outer = [[4, 3], [12, 3], [14, 5], [14, 11], [12, 13], [4, 13], [2, 11], [2, 5]];
    facets = [{ points: [[4, 3], [12, 3], [10.5, 5], [5.5, 5]], tone: 3.8 }, { points: [[2, 5], [5.5, 5], [5.5, 11], [2, 11]], tone: 3 }, { points: [[14, 5], [10.5, 5], [10.5, 11], [14, 11]], tone: 1 }, { points: [[4, 13], [12, 13], [10.5, 11], [5.5, 11]], tone: 0.4 }, { points: [[5.5, 5], [10.5, 5], [10.5, 11], [5.5, 11]], tone: 2.2 }];
  } else {
    outer = Array.from({ length: 8 }, (_, i) => { const a = (i / 8) * Math.PI * 2 + Math.PI / 8; return [8 + Math.cos(a) * 6.5, 8 + Math.sin(a) * 6.5]; });
    const inner = Array.from({ length: 8 }, (_, i) => { const a = (i / 8) * Math.PI * 2 + Math.PI / 8; return [7.6 + Math.cos(a) * 3.1, 7.6 + Math.sin(a) * 3.1]; });
    // Facets lit from the top left: the lower right ones darkest.
    facets = outer.map((p, i) => ({ points: [p, outer[(i + 1) % 8], inner[(i + 1) % 8], inner[i]], tone: [1.2, 0.4, 0.2, 1, 2, 3.4, 4, 2.6][i] }));
    facets.push({ points: inner, tone: 3 });
  }
  const P = [{ shape: 'poly', points: outer, mat: 'gem', shade: 'none', group: 'gem', z: 0 }, ...facets.map((f, i) => ({ shape: 'poly', points: f.points, mat: 'gem', shade: 'none', tone: f.tone, group: 'gem', z: 1 + i * 0.01 }))];
  const spark = (on, s) => (on ? [{ shape: 'rect', x: 4, y: 3.5 - s, w: 1, h: 1 + 2 * s, mat: 'white', shade: 'none', tone: 4, group: 'spark', z: 5, outline: false }, { shape: 'rect', x: 3.5 - s, y: 4, w: 1 + 2 * s, h: 1, mat: 'white', shade: 'none', tone: 4, group: 'spark', z: 5, outline: false }] : []);
  return { parts: P, size: 16, colors: { gem: color }, frameParts: { idle: [spark(false, 0), spark(true, 0), spark(true, 1), spark(true, 0), spark(false, 0), spark(false, 0)] }, anims: { idle: Array(6).fill({}) }, info: { color, cut } };
}

function chest(r, o) {
  const band = o.band ?? pick(r, ['gold', 'iron', 'iron']);
  const P = [
    { shape: 'rrect', x: 2, y: 13, w: 28, h: 15, r: 1.5, mat: 'wood', shade: 'flat', group: 'base', z: 1 },
    { shape: 'rect', x: 2, y: 18.5, w: 28, h: 1, mat: 'darkwood', shade: 'none', group: 'base', z: 2 },
    { shape: 'rect', x: 2, y: 23.5, w: 28, h: 1, mat: 'darkwood', shade: 'none', group: 'base', z: 2 },
    { shape: 'rect', x: 4, y: 13, w: 2.5, h: 15, mat: band, shade: 'cylinder', group: 'base', z: 3 },
    { shape: 'rect', x: 25.5, y: 13, w: 2.5, h: 15, mat: band, shade: 'cylinder', group: 'base', z: 3 },
    { shape: 'rrect', x: 1.5, y: 4, w: 29, h: 10, r: 4.5, mat: 'wood', shade: 'sphere', contrast: 0.7, group: 'lid', z: 4 },
    { shape: 'rect', x: 4, y: 4, w: 2.5, h: 10, mat: band, shade: 'flat', group: 'lid', z: 5 },
    { shape: 'rect', x: 25.5, y: 4, w: 2.5, h: 10, mat: band, shade: 'flat', group: 'lid', z: 5 },
    { shape: 'rrect', x: 13.5, y: 11, w: 5, h: 6, r: 1, mat: band, shade: 'flat', group: 'base', z: 6 },
    { shape: 'rect', x: 15.5, y: 13.5, w: 1, h: 2, mat: 'dark', shade: 'none', group: 'base', z: 7 },
  ];
  const inside = { shape: 'rect', x: 3, y: 12, w: 26, h: 3, mat: 'dark', shade: 'none', group: 'inside', z: 0.5 };
  const glow = { shape: 'ellipse', cx: 16, cy: 11, rx: 9, ry: 3, mat: 'gold', shade: 'none', tone: 4, group: 'inside', z: 0.6, alpha: 200 };
  return {
    parts: P, colors: { wood: vary(r, '#8a5530', 8), darkwood: '#4a2a1a' },
    // Opening: the lid tips back about its hinge, so its front face shrinks upward.
    frameParts: { idle: [[]], open: [[], [inside], [inside, glow], [inside, glow]] },
    anims: { idle: [{}], open: [{}, { lid: { sy: 0.7, dy: -1, pivot: [16, 4] } }, { lid: { sy: 0.45, dy: -2, pivot: [16, 4] } }, { lid: { sy: 0.4, dy: -2.5, pivot: [16, 4] } }] },
    info: { band },
  };
}

function potion(r, o) {
  const liquid = o.color ?? pick(r, ['#d0405a', '#4060e0', '#40c060', '#c060e0', '#e8b030']);
  return {
    size: 16, colors: { liquid },
    parts: [
      { shape: 'ellipse', cx: 8, cy: 10.5, rx: 5.5, ry: 5, mat: 'glass', z: 0, alpha: 200 },
      { shape: 'rect', x: 6, y: 2.5, w: 4, h: 4, mat: 'glass', shade: 'cylinder', z: 0, alpha: 200 },
      { shape: 'ellipse', cx: 8, cy: 11, rx: 4.4, ry: 3.9, mat: 'liquid', z: 1, spec: 0.08 },
      { shape: 'rect', x: 6.5, y: 1, w: 3, h: 2.5, mat: 'leather', shade: 'flat', z: 2 },
      { shape: 'rect', x: 4.5, y: 8, w: 1, h: 2, mat: 'white', shade: 'none', tone: 4, z: 3, outline: false },
    ],
    anims: { idle: [{}] }, info: { liquid },
  };
}

function swordItem(r) {
  return {
    size: 16, colors: { gold: pick(r, ['#f2c042', '#c8d0dc', '#c87a3a']) },
    parts: [
      { shape: 'poly', points: [[3, 12], [11.5, 3.5], [13.5, 2.5], [12.5, 4.5], [4, 13]], mat: 'steel', shade: 'flat', z: 1 },
      { shape: 'poly', points: [[3.5, 12.5], [12.5, 3.5], [13.5, 2.5]], mat: 'white', shade: 'none', tone: 3, z: 2, outline: false },
      { shape: 'poly', points: [[1.5, 10.5], [2.5, 9.5], [6.5, 13.5], [5.5, 14.5]], mat: 'gold', shade: 'flat', z: 3 },
      { shape: 'poly', points: [[1, 14], [3, 12], [4, 13], [2, 15]], mat: 'leather', shade: 'none', z: 3 },
    ],
    anims: { idle: [{}] }, info: {},
  };
}

function keyItem(r) {
  return {
    size: 16, colors: { gold: pick(r, ['#f2c042', '#c8d0dc']) },
    parts: [
      { shape: 'ellipse', cx: 5, cy: 5, rx: 3.6, ry: 3.6, mat: 'gold', z: 1 },
      { shape: 'ellipse', cx: 5, cy: 5, rx: 1.5, ry: 1.5, mat: 'dark', shade: 'none', z: 2, hole: true },
      { shape: 'poly', points: [[6.5, 7.5], [8, 6], [14.5, 12.5], [13, 14]], mat: 'gold', shade: 'flat', z: 1 },
      { shape: 'poly', points: [[10.5, 11.5], [11.5, 10.5], [13, 12], [12, 13]], mat: 'gold', shade: 'flat', lift: -1, z: 0 },
      { shape: 'rect', x: 9, y: 11, w: 2, h: 2, mat: 'gold', shade: 'flat', z: 0 },
    ],
    anims: { idle: [{}] }, info: {},
  };
}

function heart() {
  return {
    size: 16, colors: { cloth: '#e83a4a' },
    parts: [
      { shape: 'ellipse', cx: 5.2, cy: 6, rx: 3.8, ry: 3.6, mat: 'cloth', group: 'h', z: 1 },
      { shape: 'ellipse', cx: 10.8, cy: 6, rx: 3.8, ry: 3.6, mat: 'cloth', group: 'h', z: 1 },
      { shape: 'poly', points: [[1.6, 7], [14.4, 7], [8, 14]], mat: 'cloth', shade: 'sphere', group: 'h', z: 1 },
      { shape: 'rect', x: 3.5, y: 4, w: 1.5, h: 1.5, mat: 'white', shade: 'none', tone: 4, group: 'h', z: 2, outline: false },
    ],
    anims: { idle: [{}, { h: { sx: 1.1, sy: 1.1, pivot: [8, 9] } }, {}] }, info: {},
  };
}

function shield(r) {
  const c = pick(r, CLOTH);
  return {
    size: 16, colors: { cloth: c },
    parts: [
      { shape: 'poly', points: [[2, 2.5], [14, 2.5], [14, 8], [8, 15], [2, 8]], mat: 'iron', shade: 'sphere', z: 0 },
      { shape: 'poly', points: [[3.5, 4], [12.5, 4], [12.5, 8], [8, 13], [3.5, 8]], mat: 'cloth', z: 1 },
      { shape: 'rect', x: 7.2, y: 4, w: 1.6, h: 8.5, mat: 'gold', shade: 'flat', z: 2 },
      { shape: 'rect', x: 3.5, y: 6.5, w: 9, h: 1.6, mat: 'gold', shade: 'flat', z: 2 },
    ],
    anims: { idle: [{}] }, info: { color: c },
  };
}

function bomb() {
  return {
    size: 16,
    parts: [
      { shape: 'ellipse', cx: 7.5, cy: 9.5, rx: 5.5, ry: 5.5, mat: 'dark', z: 1, spec: 0.06 },
      { shape: 'rect', x: 6.5, y: 3, w: 3, h: 2.5, mat: 'iron', shade: 'cylinder', z: 2 },
      { shape: 'poly', points: [[8.5, 3.5], [10.5, 1], [12, 1.5], [9.5, 4]], mat: 'leather', shade: 'none', z: 2 },
    ],
    frameParts: { idle: [[{ shape: 'ellipse', cx: 12, cy: 1.5, rx: 1.5, ry: 1.5, mat: 'fire', shade: 'none', tone: 4, z: 3, outline: false }], [{ shape: 'ellipse', cx: 12, cy: 1.5, rx: 1, ry: 1, mat: 'fire', shade: 'none', tone: 2, z: 3, outline: false }]] },
    anims: { idle: [{}, {}] }, info: {},
  };
}

function tree(r, o) {
  const style = o.style ?? pick(r, ['round', 'round', 'pine', 'bushy']);
  const leaf = o.leaf ?? vary(r, pick(r, ['#4f9d3a', '#3f8a4a', '#6aa83a', '#2f7a4a', '#c8803a']), 6);
  const P = [];
  const trunkH = style === 'pine' ? 10 : 14;
  P.push({ shape: 'poly', points: [[13, 32], [14, 31 - trunkH], [18, 31 - trunkH], [19, 32]], mat: 'bark', shade: 'cylinder', z: 0 });
  if (style === 'pine') {
    for (let i = 0; i < 4; i++) {
      const y = 25 - i * 6.5, w = 14 - i * 2.8;
      P.push({ shape: 'poly', points: [[16 - w, y], [16, y - 10], [16 + w, y]], mat: 'leaf', shade: 'sphere', contrast: 1, z: 1 + i, wobble: true });
    }
  } else {
    const blobs = style === 'bushy' ? 7 : 5;
    const cy = style === 'bushy' ? 15 : 12;
    P.push({ shape: 'ellipse', cx: 16, cy, rx: 11.5, ry: style === 'bushy' ? 8.5 : 10, mat: 'leaf', z: 1, lift: -0.5 });
    for (let i = 0; i < blobs; i++) {
      const a = (i / blobs) * Math.PI * 2 + r.range(0, 0.6);
      const rr = r.range(4.5, 6.5);
      P.push({ shape: 'ellipse', cx: 16 + Math.cos(a) * 6.5, cy: cy + Math.sin(a) * 5, rx: rr, ry: rr * 0.9, mat: 'leaf', z: 2 + (Math.sin(a) < 0 ? 0 : 1) });
    }
    P.push({ shape: 'ellipse', cx: 14, cy: cy - 3, rx: 6, ry: 5, mat: 'leaf', z: 5, lift: 0.4 });
    if (o.fruit ?? r.chance(0.3)) for (let i = 0; i < 4; i++) P.push({ shape: 'rect', x: r.int(8, 23), y: r.int(cy - 5, cy + 6), w: 2, h: 2, mat: 'cloth', shade: 'none', tone: 3, z: 6, outline: false });
  }
  const sway = (rot) => Object.fromEntries(P.filter((p) => p.mat === 'leaf').map((_, i) => [`l${i}`, { rot, pivot: [16, 32] }]));
  P.forEach((p, i) => { if (p.mat === 'leaf') p.group = `l${P.slice(0, i).filter((q) => q.mat === 'leaf').length}`; });
  return { parts: P, colors: { leaf, bark: vary(r, '#7a5232', 6) }, anims: { idle: [sway(0), sway(1.5), sway(2.5), sway(1.5), sway(0), sway(-1)] }, info: { style, leaf } };
}

function rock(r, o) {
  // A boulder: a lumpy dome (jittered radius, a flat base) with a lit top face and a crack.
  const n = r.int(12, 15);
  const rx = r.range(12, 14), ry = r.range(14, 18);
  const pts = Array.from({ length: n }, (_, i) => {
    const a = Math.PI + (i / (n - 1)) * Math.PI;
    const rr = i === 0 || i === n - 1 ? 1 : r.range(0.88, 1.04);
    return [16 + Math.cos(a) * rx * rr, 30 + Math.sin(a) * ry * rr * (Math.abs(Math.cos(a)) < 0.5 ? 0.92 : 1)];
  });
  const top = 30 - ry * 0.9;
  const P = [
    { shape: 'poly', points: [...pts, [16 + rx, 32], [16 - rx, 32]], mat: 'stone', shade: 'sphere', contrast: 1.3, z: 0 },
    { shape: 'poly', points: [[16 - rx * 0.55, top + ry * 0.35], [16 - rx * 0.2, top + 1], [16 + rx * 0.35, top + 1.5], [16 + rx * 0.45, top + ry * 0.3], [16, top + ry * 0.42]], mat: 'stone', shade: 'none', tone: 3.3, z: 1 },
    { shape: 'poly', points: [[16 + rx * 0.3, top + ry * 0.5], [16 + rx * 0.42, top + ry * 0.62], [16 + rx * 0.28, top + ry * 0.85], [16 + rx * 0.2, top + ry * 0.66]], mat: 'stone', shade: 'none', tone: 0.6, z: 1 },
  ];
  if (o.moss ?? r.chance(0.4)) P.push({ shape: 'ellipse', cx: 16 - rx * 0.25, cy: top + 2, rx: rx * 0.45, ry: 2.2, mat: 'moss', z: 2 });
  return { parts: P, colors: { stone: vary(r, pick(r, ['#8a8a94', '#9a8a7a', '#7a8490', '#a09a8a']), 8) }, anims: { idle: [{}] }, info: {} };
}

function bushSprite(r) {
  const leaf = vary(r, '#4f9d3a', 10);
  const P = [];
  // Clumps along a low dome, the middle ones higher and in front; a dark base where it meets the ground.
  for (let i = 0; i < 6; i++) {
    const cx = 5 + i * 4.4 + r.range(-0.8, 0.8), lift = Math.sin((i / 5) * Math.PI) * 6;
    P.push({ shape: 'ellipse', cx, cy: 25 - lift + r.range(-1, 1), rx: r.range(4.5, 6), ry: r.range(4.5, 5.5), mat: 'leaf', z: 1 + (i % 2) });
  }
  P.push({ shape: 'ellipse', cx: 16, cy: 28, rx: 14, ry: 4, mat: 'leaf', lift: -0.9, z: 0 });
  P.push({ shape: 'rect', x: 2, y: 28, w: 28, h: 4, mat: 'leaf', shade: 'none', tone: 1, z: 0.5 });
  return { parts: P, colors: { leaf }, anims: { idle: [{}] }, info: {} };
}

/** Every kind with how it is built: (rng, options) -> { parts, colors, anims, size?, frameParts?, info }. */
export const KINDS = {
  character: (r, o) => { const h = humanoid(r, o); return { ...h, anims: humanoidAnims(h.info.view) }; },
  goblin: (r, o) => { const h = humanoid(r, { skin: vary(r, '#7ab04a', 10), hair: '#2a2a1a', hairStyle: 'bald', hat: pick(r, ['none', 'hood', 'cap']), hatColor: vary(r, '#5a3a4a', 20), weapon: pick(r, ['axe', 'sword']), shirt: vary(r, '#7a5a3a'), ...o }); return { ...h, anims: humanoidAnims(h.info.view) }; },
  skeleton: (r, o) => { const h = humanoid(r, { skin: '#e6dfc8', hairStyle: 'bald', hat: pick(r, ['none', 'helmet']), shirt: '#d8d0b8', pants: '#c8c0a8', boots: '#a8a090', belt: '#6a5a4a', weapon: 'sword', ...o }); return { ...h, anims: humanoidAnims(h.info.view) }; },
  slime, bat, ghost, coin, gem, chest, potion, sword: swordItem, key: keyItem, heart, shield, bomb, tree, rock, bush: bushSprite,
};

export const ENEMIES = ['slime', 'bat', 'ghost', 'goblin', 'skeleton'];

/** The template for a spec: parts, materials' colours, animations and the box it was designed in. */
export function template(kind, seed, options = {}) {
  const fn = KINDS[kind];
  if (!fn) throw new Error(`unknown sprite kind ${kind}: one of ${Object.keys(KINDS).join(', ')} (tiles: use the tileset action)`);
  const r = rng(`${seed}:${kind}`);
  const t = fn(r, options);
  return { size: 32, ...t, colors: { ...(t.colors ?? {}), ...(options.colors ?? {}) } };
}
