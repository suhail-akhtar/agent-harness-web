// Sprite sheets: frames packed in a grid (one row per animation), described three ways:
// Aseprite's JSON (hash format, with frameTags; Phaser, Unity importers, LibGDX read it),
// Godot 4's SpriteFrames resource (.tres), and a plain frames JSON.

import { Image } from '../raster/image.mjs';

/**
 * Packs { anim: [Image, ...] } into one image. Each animation is a row; frames are fw x fh
 * with `padding` px between cells (and `extrude` px of repeated edge pixels, against bleeding).
 */
export function packSheet(anims, { padding = 0, extrude = 0, fps = 8, durations = {} } = {}) {
  const names = Object.keys(anims).filter((a) => anims[a]?.length);
  if (!names.length) throw new Error('no frames to pack');
  const fw = anims[names[0]][0].width, fh = anims[names[0]][0].height;
  const cols = Math.max(...names.map((a) => anims[a].length));
  const cw = fw + padding + 2 * extrude, ch = fh + padding + 2 * extrude;
  const img = new Image(cols * cw - padding, names.length * ch - padding);
  const frames = [], tags = [];
  let n = 0;
  names.forEach((a, row) => {
    const from = n;
    anims[a].forEach((f, i) => {
      if (f.width !== fw || f.height !== fh) throw new Error(`frame ${a} ${i} is ${f.width}x${f.height}, not ${fw}x${fh}`);
      const x = i * cw + extrude, y = row * ch + extrude;
      img.draw(f, x, y, { mode: 'replace' });
      for (let e = 1; e <= extrude; e++) {
        for (let k = 0; k < fw; k++) { img.set(x + k, y - e, f.get(k, 0)); img.set(x + k, y + fh - 1 + e, f.get(k, fh - 1)); }
        for (let k = -e; k < fh + e; k++) { img.set(x - e, y + k, f.get(0, Math.max(0, Math.min(fh - 1, k)))); img.set(x + fw - 1 + e, y + k, f.get(fw - 1, Math.max(0, Math.min(fh - 1, k)))); }
      }
      frames.push({ name: `${a} ${i}`, anim: a, index: i, x, y, w: fw, h: fh, duration: Math.round(durations[a] ?? 1000 / fps) });
      n++;
    });
    tags.push({ name: a, from, to: n - 1, direction: 'forward' });
  });
  return { image: img, frames, tags, frameWidth: fw, frameHeight: fh, fps };
}

/** Aseprite's JSON export (hash), as `aseprite -b --sheet ... --data ... --format json-hash` writes it. */
export function asepriteJson(sheet, { image = 'sheet.png' } = {}) {
  const frames = {};
  for (const f of sheet.frames) {
    frames[`${f.name}.aseprite`] = { frame: { x: f.x, y: f.y, w: f.w, h: f.h }, rotated: false, trimmed: false, spriteSourceSize: { x: 0, y: 0, w: f.w, h: f.h }, sourceSize: { w: f.w, h: f.h }, duration: f.duration };
  }
  return {
    frames,
    meta: {
      app: 'https://www.aseprite.org/', version: '1.3.x (written by Studio)', image, format: 'RGBA8888', size: { w: sheet.image.width, h: sheet.image.height }, scale: '1',
      frameTags: sheet.tags.map((t) => ({ ...t, color: '#000000ff' })), layers: [{ name: 'sprite', opacity: 255, blendMode: 'normal' }], slices: [],
    },
  };
}

/** A Godot 4 SpriteFrames resource: one animation per row, AtlasTexture regions of the sheet. */
export function godotSpriteFrames(sheet, { texturePath = 'res://sheet.png', loops = {} } = {}) {
  const subs = sheet.frames.map((f, i) => `[sub_resource type="AtlasTexture" id="AtlasTexture_${i}"]\natlas = ExtResource("1_sheet")\nregion = Rect2(${f.x}, ${f.y}, ${f.w}, ${f.h})\n`);
  const anims = sheet.tags.map((t) => {
    const frames = sheet.frames.slice(t.from, t.to + 1).map((f, k) => `{\n"duration": 1.0,\n"texture": SubResource("AtlasTexture_${t.from + k}")\n}`);
    const loop = loops[t.name] ?? !['attack', 'jump', 'hurt', 'open', 'die'].includes(t.name);
    return `{\n"frames": [${frames.join(', ')}],\n"loop": ${loop},\n"name": &"${t.name}",\n"speed": ${Number(sheet.fps).toFixed(1)}\n}`;
  });
  return [
    `[gd_resource type="SpriteFrames" load_steps=${subs.length + 2} format=3]`, '',
    `[ext_resource type="Texture2D" path="${texturePath}" id="1_sheet"]`, '',
    ...subs,
    '[resource]',
    `animations = [${anims.join(', ')}]`, '',
  ].join('\n');
}

/** The plain description: frame size, and per animation its frames, fps and whether it loops. */
export function framesJson(sheet, { image = 'sheet.png' } = {}) {
  const animations = {};
  for (const t of sheet.tags) {
    animations[t.name] = { fps: sheet.fps, loop: !['attack', 'jump', 'hurt', 'open', 'die'].includes(t.name), frames: sheet.frames.slice(t.from, t.to + 1).map(({ x, y, w, h, duration }) => ({ x, y, w, h, durationMs: duration })) };
  }
  return { image, width: sheet.image.width, height: sheet.image.height, frameWidth: sheet.frameWidth, frameHeight: sheet.frameHeight, animations };
}

/**
 * Checks a sheet description (any of the three JSONs) against its image size and the frame
 * size it should have: every frame inside the image, of that size, and no two overlapping.
 */
export function checkSheet(json, { width, height }, frameSize) {
  const list = [];
  if (json?.frames && !Array.isArray(json.frames)) for (const [name, f] of Object.entries(json.frames)) list.push({ name, ...f.frame });
  else if (Array.isArray(json?.frames)) for (const f of json.frames) list.push({ name: f.filename ?? f.name, ...(f.frame ?? f) });
  else if (json?.animations) for (const [a, v] of Object.entries(json.animations)) v.frames.forEach((f, i) => list.push({ name: `${a} ${i}`, ...f }));
  const problems = [];
  if (!list.length) problems.push('no frames in the description');
  for (const f of list) {
    if (f.x < 0 || f.y < 0 || f.x + f.w > width || f.y + f.h > height) problems.push(`frame "${f.name}" (${f.x},${f.y} ${f.w}x${f.h}) is outside the ${width}x${height} image`);
    if (frameSize && (f.w !== frameSize[0] || f.h !== frameSize[1])) problems.push(`frame "${f.name}" is ${f.w}x${f.h}, the asset says ${frameSize[0]}x${frameSize[1]}`);
  }
  for (let i = 0; i < list.length && problems.length < 20; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) { problems.push(`frames "${a.name}" and "${b.name}" overlap`); break; }
  }
  return { frames: list.length, problems };
}
