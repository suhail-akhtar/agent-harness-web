// The 2D tools: studio_image (raster operations, drawing, fonts, normal maps) and
// studio_sprite (sprites, animated sheets, tilesets with autotile rules, UI kits,
// parallax backgrounds, isometric tiles, particles).

import { relIn, writeIn } from '../lib-engines.mjs';
import { guarded, int, num, preview, readImage, save, seedIn, unknownAction } from './common.mjs';
import { parseColor, toHex } from './raster/color.mjs';
import { drawText, fontAtlas } from './raster/font.mjs';
import { gradientAt, Image, normalMap } from './raster/image.mjs';
import { medianCut, PALETTES, paletteHex, paletteOf, quantize } from './raster/palette.mjs';
import { encodePNG } from './raster/png.mjs';
import { KINDS, template } from './sprites/kinds.mjs';
import { isoScene, isoTile, parallax, particle, PARTICLES } from './sprites/scenery.mjs';
import { asepriteJson, framesJson, godotSpriteFrames, packSheet } from './sprites/sheet.mjs';
import { renderSprite } from './sprites/sprite.mjs';
import { autotileBlob, blobTileset, cornerTileset, godotBlobTileset, terrainTexture, TERRAINS } from './sprites/tiles.mjs';
import { ICONS, icon, iconSvg, uiKit } from './sprites/ui.mjs';
import { toTilesetJson } from './gen/tiled.mjs';
import { noiseField } from './gen/noise.mjs';

const nextPot = (n) => 2 ** Math.ceil(Math.log2(Math.max(1, n)));

/** Applies image operations in order; slice returns extra frames. */
export function applyOps(img, ops = []) {
  const extra = [];
  for (const op of ops) {
    const o = typeof op === 'string' ? { op } : op;
    switch (o.op) {
      case 'resize': img = img.scale(int(o.width, img.width, 1, 8192), int(o.height ?? Math.round((o.width / img.width) * img.height), img.height, 1, 8192), o.method ?? 'bilinear'); break;
      case 'scale': img = img.scale(img.width * num(o.factor, 2, 0.01, 64), img.height * num(o.factor, 2, 0.01, 64), o.method ?? (o.factor >= 1 ? 'nearest' : 'bilinear')); break;
      case 'pot': img = img.scale(nextPot(img.width), nextPot(img.height), o.method ?? 'bilinear'); break;
      case 'crop': img = img.crop(int(o.x, 0), int(o.y, 0), int(o.w ?? o.width, img.width), int(o.h ?? o.height, img.height)); break;
      case 'trim': { const b = img.bounds(o.threshold ?? 8); if (b) img = img.crop(b.x - (o.pad ?? 0), b.y - (o.pad ?? 0), b.w + 2 * (o.pad ?? 0), b.h + 2 * (o.pad ?? 0)); break; }
      case 'square': { const s = Math.max(img.width, img.height); const out = new Image(s, s); out.draw(img, (s - img.width) / 2, o.bottom ? s - img.height : (s - img.height) / 2); img = out; break; }
      case 'quantize': {
        const pal = o.palette ? paletteOf(o.palette) : medianCut(img, int(o.colors, 16, 2, 256));
        img = quantize(img, pal, { dither: o.dither ?? 'none', strength: num(o.strength, 1, 0, 2) });
        break;
      }
      case 'colorKey': img = img.colorKey(o.color === undefined || o.color === 'auto' ? img.borderColor() : o.color, { tolerance: num(o.tolerance, 40, 0, 255), flood: o.flood !== false, feather: num(o.feather, 0, 0, 4) }); break;
      case 'hardAlpha': img = img.hardAlpha(int(o.threshold, 128, 1, 255)); break;
      case 'outline': img = img.outline(o.color ?? 'auto', { corners: !!o.corners }); break;
      case 'blur': img = img.blur(num(o.radius, 1, 0, 64), { wrap: !!o.wrap }); break;
      case 'flip': img = o.axis === 'y' ? img.flipY() : img.flipX(); break;
      case 'rotate': for (let i = 0; i < ((int(o.degrees, 90) / 90) & 3); i++) img = img.rotate90(); break;
      case 'normalMap': img = normalMap(img.heights(o.channel ?? 'luma'), img.width, img.height, { strength: num(o.strength, 2, 0, 50), convention: o.convention ?? 'opengl', wrap: o.wrap !== false }); break;
      case 'tileable': {
        // Seamless: the last `band` pixels are cross-faded into the first ones, so the (smaller)
        // image continues from its right edge into its left (and bottom into top); then it is
        // scaled back to its size. Only the band is blended: no ghosting over the whole image.
        const w = img.width, h = img.height, b = Math.max(2, Math.round(Math.min(w, h) * num(o.band, 0.12, 0.02, 0.4)));
        const horiz = new Image(w - b, h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w - b; x++) {
          const c = img.get(x, y);
          if (x >= b) { horiz.set(x, y, c); continue; }
          const t = x / b, d = img.get(x + w - b, y);
          horiz.set(x, y, c.map((v, i) => d[i] * (1 - t) + v * t));
        }
        const both = new Image(w - b, h - b);
        for (let y = 0; y < h - b; y++) for (let x = 0; x < w - b; x++) {
          const c = horiz.get(x, y);
          if (y >= b) { both.set(x, y, c); continue; }
          const t = y / b, d = horiz.get(x, y + h - b);
          both.set(x, y, c.map((v, i) => d[i] * (1 - t) + v * t));
        }
        img = both.scale(w, h, 'bilinear');
        break;
      }
      case 'slice': {
        const cols = int(o.cols, 1, 1, 256), rows = int(o.rows, 1, 1, 256), fw = Math.floor(img.width / cols), fh = Math.floor(img.height / rows);
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) extra.push(img.crop(c * fw, r * fh, fw, fh));
        break;
      }
      default: throw new Error(`unknown image op ${o.op}: resize, scale, pot, crop, trim, square, quantize, colorKey, hardAlpha, outline, blur, flip, rotate, normalMap, tileable, slice`);
    }
  }
  return { img, extra };
}

/** Draws shapes onto a canvas: rect, ellipse, circle, line, polygon, text, gradient, noise. */
export function drawShapes(img, shapes = []) {
  for (const s of shapes) {
    const c = s.color ?? '#ffffff';
    switch (s.type) {
      case 'rect': img.rect(num(s.x, 0), num(s.y, 0), num(s.w ?? s.width, 1), num(s.h ?? s.height, 1), c, { fill: s.fill !== false }); break;
      case 'ellipse': img.ellipse(num(s.cx, 0), num(s.cy, 0), num(s.rx, 1), num(s.ry ?? s.rx, 1), c, { fill: s.fill !== false, aa: !!s.aa }); break;
      case 'circle': img.circle(num(s.cx, 0), num(s.cy, 0), num(s.r, 1), c, { fill: s.fill !== false, aa: !!s.aa }); break;
      case 'line': img.line(num(s.x0, 0), num(s.y0, 0), num(s.x1, 0), num(s.y1, 0), c, num(s.width, 1, 1, 64)); break;
      case 'polygon': img.polygon(s.points ?? [], c, { aa: !!s.aa }); break;
      case 'text': drawText(img, String(s.text ?? ''), num(s.x, 0), num(s.y, 0), c, { scale: int(s.scale, 1, 1, 16), shadow: s.shadow, outline: s.outline }); break;
      case 'gradient': {
        const stops = s.stops ?? [[0, s.from ?? '#000000'], [1, s.to ?? '#ffffff']];
        if (s.radial) img.radialGradient(num(s.cx, img.width / 2), num(s.cy, img.height / 2), num(s.r, img.width / 2), stops, { steps: int(s.steps, 0, 0, 64) });
        else img.linearGradient(num(s.x0, 0), num(s.y0, 0), num(s.x1, 0), num(s.y1, img.height), stops, { steps: int(s.steps, 0, 0, 64), rect: s.rect });
        break;
      }
      case 'noise': {
        const n = noiseField({ width: img.width, height: img.height, type: s.noise ?? 'perlin', scale: num(s.scale, 32, 1), octaves: int(s.octaves, 4, 1, 10), seed: s.seed ?? 1, tileable: !!s.tileable });
        const stops = s.stops ?? [[0, '#000000'], [1, '#ffffff']];
        img.paint((x, y) => gradientAt(stops, n[y * img.width + x]));
        break;
      }
      default: throw new Error(`unknown shape ${s.type}: rect, ellipse, circle, line, polygon, text, gradient, noise`);
    }
  }
  return img;
}

/** Writes an image to a workspace path, or saves it as an asset (id). */
async function output(ctx, input, img, { kind = 'texture', name, extra = [], meta = {}, source }) {
  if (input.output) {
    const rel = await relIn(ctx.host, String(input.output));
    await writeIn(ctx.host, rel, encodePNG(img), ctx.signal);
    const lines = [`Wrote ${rel} (${img.width}x${img.height}).`];
    for (const [i, f] of extra.entries()) { const p = rel.replace(/\.png$/i, `_${i}.png`); await writeIn(ctx.host, p, encodePNG(f), ctx.signal); }
    if (extra.length) lines.push(`and ${extra.length} slices ${rel.replace(/\.png$/i, '_N.png')}`);
    return { content: lines.join('\n'), images: [preview(img)] };
  }
  const files = [{ path: 'image.png', role: 'main', image: img }, ...extra.map((f, i) => ({ path: `slice_${String(i).padStart(3, '0')}.png`, role: 'frame', image: f }))];
  const s = await save(ctx, input, { id: input.id ?? `${kind}-${name ?? 'image'}`, name: name ?? 'image', kind, files, meta: { size: [img.width, img.height], ...meta }, source });
  return { content: s.lines.join('\n'), images: [preview(img)] };
}

const IMAGE_ACTIONS = ['info', 'process', 'draw', 'normalmap', 'palettes', 'font'];

export const imageTool = {
  name: 'studio_image',
  description: 'Pure-JS raster work on PNGs (no external programs). action: "info" (size, colours, transparent bounds); "process" a PNG through ops in order: resize {width,height,method:nearest|bilinear}, scale {factor}, pot (next power of two), crop, trim, square, quantize {palette (pico8, db16, db32, endesga32, sweetie16, gameboy, or a colour list) | colors:N, dither:none|ordered|floyd}, colorKey {color|"auto", tolerance} (background removal), hardAlpha, outline {color|"auto"}, blur {radius}, flip, rotate, normalMap {strength, convention:opengl|directx}, tileable, slice {cols,rows}; "draw" shapes on a new canvas (rect, ellipse, circle, line, polygon, text, gradient {steps for dithered bands}, noise); "normalmap" from a height/colour PNG; "palettes" lists the named palettes; "font" exports the 5x7 pixel font as an atlas PNG + BMFont .fnt + JSON. Results go to `output` (a workspace PNG) or become a Studio asset (`id`). You see a preview.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: IMAGE_ACTIONS },
      input: { type: 'string', description: 'process/normalmap/info: a PNG in the workspace' },
      path: { type: 'string', description: 'info: the PNG (same as input)' },
      ops: { type: 'array', items: { type: 'object' }, description: 'process: [{ "op": "colorKey", "color": "auto" }, { "op": "quantize", "palette": "db32" }, ...]' },
      width: { type: 'number' }, height: { type: 'number' },
      background: { type: 'string', description: 'draw: canvas colour (default transparent)' },
      shapes: { type: 'array', items: { type: 'object' }, description: 'draw: [{ "type": "rect", "x":0, "y":0, "w":8, "h":8, "color":"#ff0000" }, { "type": "text", "text": "HI", "x":2, "y":2 }, ...]' },
      strength: { type: 'number' }, convention: { type: 'string', enum: ['opengl', 'directx'] },
      scale: { type: 'number', description: 'font: pixel scale' }, color: { type: 'string' }, outline: { type: 'string' }, shadow: { type: 'string' },
      output: { type: 'string', description: 'A workspace PNG path to write (else the result is saved as an asset)' },
      id: { type: 'string', description: 'The asset id when saving as an asset' },
      kind: { type: 'string', description: 'The asset kind (texture, sprite, ui, icon...)' },
      project: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, export: { type: 'string', description: 'Also copy the files into this workspace folder' },
    },
    required: ['action'],
  },
  kind: 'edit',
  sendsOut: false,
  summarize: (i) => `${i.action} ${i.input ?? i.path ?? i.output ?? i.id ?? ''}`,
  run: guarded('studio_image', async (input, ctx) => {
    const a = String(input.action ?? '');
    if (a === 'palettes') return Object.entries(PALETTES).map(([k, v]) => `${k} (${v.length}): ${v.join(' ')}`).join('\n');
    if (a === 'info') {
      const img = await readImage(ctx.host, input.path ?? input.input, ctx.signal);
      const b = img.bounds();
      const cols = img.colors();
      return { content: `${img.width}x${img.height}, ${cols.size} opaque colours${cols.size <= 32 ? ` (${[...cols].map((c) => `#${c.toString(16).padStart(6, '0')}`).join(' ')})` : ''}, ${b ? `content at ${b.x},${b.y} ${b.w}x${b.h}` : 'fully transparent'}; border colour ${toHex(img.borderColor())}`, images: [preview(img)] };
    }
    if (a === 'process' || a === 'normalmap') {
      const img = await readImage(ctx.host, input.input, ctx.signal);
      const ops = a === 'normalmap' ? [{ op: 'normalMap', strength: input.strength, convention: input.convention }] : input.ops;
      const r = applyOps(img, ops);
      return output(ctx, input, r.img, { kind: input.kind ?? 'texture', name: String(input.id ?? 'processed'), extra: r.extra, source: { type: 'procedural', generator: 'studio_image:process', params: { from: input.input, ops } } });
    }
    if (a === 'draw') {
      const img = new Image(int(input.width, 64, 1, 4096), int(input.height, 64, 1, 4096), input.background ?? undefined);
      drawShapes(img, input.shapes);
      return output(ctx, input, img, { kind: input.kind ?? 'sprite', name: String(input.id ?? 'drawing'), source: { type: 'procedural', generator: 'studio_image:draw', params: { shapes: input.shapes } } });
    }
    if (a === 'font') {
      const f = fontAtlas({ scale: int(input.scale, 1, 1, 8), color: input.color ?? '#ffffff', outline: input.outline, shadow: input.shadow, file: 'font.png' });
      const s = await save(ctx, input, { id: input.id ?? `font-pixel5x7-x${int(input.scale, 1, 1, 8)}`, name: 'Pixel 5x7 font', kind: 'font', files: [{ path: 'font.png', role: 'main', image: f.image }, { path: 'font.fnt', role: 'bmfont', data: f.fnt }, { path: 'font.json', role: 'data', data: JSON.stringify(f.json, null, 1) }], meta: { lineHeight: f.json.lineHeight, glyphs: f.json.chars.length }, source: { type: 'procedural', generator: 'studio:font5x7', params: { scale: input.scale, color: input.color, outline: input.outline } }, tags: ['font', 'pixel'] });
      return { content: `${s.lines.join('\n')}\nBMFont text format (.fnt): Godot imports it as a FontFile; Unity, Phaser and LibGDX read it too.`, images: [preview(f.image)] };
    }
    return unknownAction('studio_image', a, IMAGE_ACTIONS);
  }),
};

// ---------- sprites ----------

const SPRITE_ACTIONS = ['kinds', 'sprite', 'sheet', 'tileset', 'ui', 'parallax', 'iso', 'particles', 'icon'];

const specOf = (input) => ({ kind: input.kind ?? 'character', seed: seedIn(input), size: input.size, view: input.view, colors: input.colors, palette: input.palette, outline: input.outline, dither: input.dither, anims: input.anims, fps: input.fps, ...(input.options ?? {}) });

/** A sheet preview: every frame scaled up on a checker so transparency shows. */
function sheetPreview(sheet) {
  const img = sheet.image;
  const bg = new Image(img.width, img.height);
  bg.paint((x, y) => (((x >> 2) + (y >> 2)) % 2 ? [70, 76, 92, 255] : [86, 92, 108, 255]));
  bg.draw(img, 0, 0);
  return bg;
}

export const spriteTool = {
  name: 'studio_sprite',
  description: 'Pixel-art 2D asset builders, deterministic by seed (same seed, same art), each saved as a Studio asset with its manifest and a preview you see. action: "kinds" lists sprite kinds, animations and terrains; "sprite" one image of a kind (character, goblin, skeleton, slime, bat, ghost, coin, gem, chest, potion, sword, key, heart, shield, bomb, tree, rock, bush) with size, view (side|front for humanoids), colors (material overrides: skin, hair, shirt, pants, leaf, gem, gold...), palette (a named palette to map onto), outline ("auto" | colour | "none"); "sheet" an animated sprite sheet (anims: idle, walk, jump, attack, hurt, spin, open... per kind) with Aseprite JSON, a Godot 4 SpriteFrames .tres and a frames JSON; "tileset" terrain tiles: mode "texture" (one seamless tile of terrain), "corner" (16-tile marching-squares set between terrains a and b) or "blob" (47-tile 8-neighbour autotile set) with rules JSON, a Tiled .tsj with a wangset, and (blob) a Godot TileSet .tres; "ui" a UI kit (buttons in 4 states, nine-slice panels, bars, icons, at scales 1x/2x/4x, SVG icons); "parallax" layered backgrounds (theme day|dusk|night|desert|snow) that tile horizontally; "iso" isometric 2:1 tiles and blocks; "particles" particle textures; "icon" one icon at several scales.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: SPRITE_ACTIONS },
      kind: { type: 'string', description: 'sprite/sheet: the sprite kind' },
      seed: { type: ['number', 'string'], description: 'Same seed, same result (default 1)' },
      size: { type: 'number', description: 'Frame or tile size in px (sprites 32, items 16 by default; tiles 16)' },
      view: { type: 'string', enum: ['side', 'front'] },
      anims: { type: 'array', items: { type: 'string' }, description: 'sheet: animations to include (default all of the kind)' },
      fps: { type: 'number' },
      colors: { type: 'object', description: 'Material colours, e.g. {"shirt":"#c04040","hair":"#e8d080"}' },
      palette: { type: ['string', 'array'], description: 'Map the result onto a named palette or a colour list' },
      outline: { type: 'string' },
      options: { type: 'object', description: 'Kind-specific: hat (none|cap|wizard|helmet|hood), hairStyle, weapon (none|sword|staff|axe), cut (gem), style (tree: round|pine|bushy), metal (coin)...' },
      mode: { type: 'string', enum: ['texture', 'corner', 'blob'], description: 'tileset' },
      terrain: { type: 'string', description: 'tileset texture: grass, dirt, sand, stone, brick, water, wood, lava, snow, wall, path, darkgrass' },
      a: { type: 'string', description: 'tileset corner/blob: the upper terrain (drawn over b)' },
      b: { type: 'string' },
      frames: { type: 'number', description: 'tileset texture water/particles flame: animation frames' },
      godotPath: { type: 'string', description: 'sheet/tileset: res:// path the texture will have in the Godot project' },
      theme: { type: 'string', enum: ['day', 'dusk', 'night', 'desert', 'snow'] },
      width: { type: 'number' }, height: { type: 'number' }, depth: { type: 'number', description: 'iso: block side height in px' },
      types: { type: 'array', items: { type: 'string' }, description: 'iso: terrain types; particles: particle kinds' },
      color: { type: 'string' }, panelColor: { type: 'string' }, accent: { type: 'string' }, label: { type: 'string' },
      scales: { type: 'array', items: { type: 'number' } }, icons: { type: 'array', items: { type: 'string' } }, name: { type: 'string', description: 'icon: its name' },
      padding: { type: 'number', description: 'sheet: px between frames' },
      id: { type: 'string', description: 'Asset id (default from kind and seed)' },
      project: { type: 'string', description: 'Project folder (with .studio/project.json); default found' },
      tags: { type: 'array', items: { type: 'string' } }, style: { type: 'string', description: 'A style label for the library (e.g. "pixel-16")' },
      export: { type: 'string', description: 'Also copy the files into this workspace folder (an engine project\'s assets)' },
    },
    required: ['action'],
  },
  kind: 'edit',
  sendsOut: false,
  summarize: (i) => `${i.action} ${i.kind ?? i.terrain ?? i.theme ?? ''} ${i.seed ?? ''}`.trim(),
  run: guarded('studio_sprite', async (input, ctx) => {
    const a = String(input.action ?? '');
    const seed = seedIn(input);
    if (a === 'kinds') {
      const lines = Object.keys(KINDS).map((k) => { const t = template(k, 1); return `${k}: ${t.size}px, anims ${Object.keys(t.anims).join(', ')}`; });
      return `Sprite kinds:\n${lines.join('\n')}\nTerrains: ${Object.keys(TERRAINS).join(', ')}\nParticles: ${PARTICLES.join(', ')}\nIcons: ${ICONS.join(', ')}\nPalettes: ${Object.keys(PALETTES).join(', ')}`;
    }
    if (a === 'sprite') {
      const s = renderSprite({ ...specOf(input), anims: input.anims ?? undefined });
      const anim = input.anims?.[0] ?? Object.keys(s.frames)[0];
      const img = s.frames[anim][0];
      const r = await save(ctx, input, { id: `sprite-${s.kind}-${seed}`, name: `${s.kind} ${seed}`, kind: 'sprite', files: [{ path: 'sprite.png', role: 'main', image: img }], meta: { frameSize: [img.width, img.height], frames: 1, ...(input.palette ? { palette: paletteHex(paletteOf(input.palette)) } : {}), ...s.info }, source: { type: 'procedural', generator: `studio:sprite:${s.kind}`, seed, params: specOf(input) }, tags: [s.kind, 'pixel-art'], style: `pixel-${img.width}` });
      return { content: `${r.lines.join('\n')}\n${s.kind} ${img.width}x${img.height}; ${JSON.stringify(s.info)}`, images: [preview(img)] };
    }
    if (a === 'sheet') {
      const s = renderSprite(specOf(input));
      const sheet = packSheet(s.frames, { padding: int(input.padding, 0, 0, 16), fps: num(input.fps, s.fps, 1, 60) });
      const id = input.id ?? `sheet-${s.kind}-${seed}`;
      const gp = input.godotPath ?? `res://assets/${id}/sheet.png`;
      const r = await save(ctx, input, {
        id, name: `${s.kind} ${seed} animations`, kind: 'spritesheet',
        files: [
          { path: 'sheet.png', role: 'main', image: sheet.image },
          { path: 'sheet.aseprite.json', role: 'data', data: JSON.stringify(asepriteJson(sheet, { image: 'sheet.png' }), null, 1) },
          { path: 'sheet.frames.json', role: 'data', data: JSON.stringify(framesJson(sheet, { image: 'sheet.png' }), null, 1) },
          { path: 'sheet.tres', role: 'godot', data: godotSpriteFrames(sheet, { texturePath: gp }) },
        ],
        meta: { frameSize: [sheet.frameWidth, sheet.frameHeight], frames: sheet.frames.length, fps: sheet.fps, padding: int(input.padding, 0, 0, 16), anims: Object.fromEntries(sheet.tags.map((t) => [t.name, t.to - t.from + 1])), ...(input.palette ? { palette: paletteHex(paletteOf(input.palette)) } : {}), ...s.info },
        source: { type: 'procedural', generator: `studio:sprite:${s.kind}`, seed, params: specOf(input) }, tags: [s.kind, 'animated', 'pixel-art'], style: `pixel-${sheet.frameWidth}`,
      });
      return { content: `${r.lines.join('\n')}\n${sheet.frames.length} frames of ${sheet.frameWidth}x${sheet.frameHeight} at ${sheet.fps} fps; rows: ${sheet.tags.map((t) => `${t.name} (${t.to - t.from + 1})`).join(', ')}. sheet.tres expects the texture at ${gp}.`, images: [preview(sheetPreview(sheet))] };
    }
    if (a === 'tileset') {
      const size = int(input.size, 16, 4, 128);
      const mode = input.mode ?? (input.a || input.b ? 'blob' : 'texture');
      if (mode === 'texture') {
        const terrain = input.terrain ?? 'grass';
        const frames = int(input.frames, 1, 1, 16);
        const imgs = Array.from({ length: frames }, (_, f) => terrainTexture(terrain, size, { seed, color: input.color, frame: f }));
        const strip = new Image(size * frames, size);
        imgs.forEach((im, i) => strip.draw(im, i * size, 0, { mode: 'replace' }));
        const tiled = new Image(size * 4, size * 3);
        for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) tiled.draw(imgs[0], x * size, y * size);
        const r = await save(ctx, input, { id: `tile-${terrain}-${size}-${seed}`, name: `${terrain} tile`, kind: 'tileset', files: [{ path: 'tile.png', role: 'main', image: strip }, { path: 'preview.png', role: 'preview', image: tiled }], meta: { tile: size, frames, seamless: true }, source: { type: 'procedural', generator: `studio:terrain:${terrain}`, seed, params: { size, frames, color: input.color } }, tags: [terrain, 'tile', 'seamless'], style: `pixel-${size}` });
        return { content: `${r.lines.join('\n')}\nSeamless ${size}px ${terrain}${frames > 1 ? `, ${frames} frames in a strip` : ''}. Preview: 4x3 repeats.`, images: [preview(tiled)] };
      }
      const ta = input.a ?? 'grass', tb = input.b ?? 'dirt';
      const set = mode === 'corner' ? cornerTileset({ a: ta, b: tb, size, seed }) : blobTileset({ a: ta, b: tb, size, seed });
      const id = input.id ?? `tileset-${ta}-${tb}-${mode}-${size}`;
      const tsj = toTilesetJson({ image: 'tiles.png', tileSize: size, count: set.count, columns: set.columns, name: `${ta}-${tb}`, wangsets: [set.wangset] });
      // A demo map from noise, autotiled, shows the set at work.
      const W = 20, H = 12;
      const n = noiseField({ width: W + 1, height: H + 1, scale: 5, octaves: 2, seed });
      const demo = new Image(W * size, H * size);
      if (mode === 'blob') {
        const grid = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => n[y * (W + 1) + x] > 0.45));
        autotileBlob(grid).forEach((row, y) => row.forEach((t, x) => demo.draw(set.tiles[t], x * size, y * size, { mode: 'replace' })));
      } else {
        const v = (x, y) => n[y * (W + 1) + x] > 0.45;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) demo.draw(set.tiles[(v(x, y) ? 1 : 0) | (v(x + 1, y) ? 2 : 0) | (v(x, y + 1) ? 4 : 0) | (v(x + 1, y + 1) ? 8 : 0)], x * size, y * size, { mode: 'replace' });
      }
      const files = [{ path: 'tiles.png', role: 'main', image: set.image }, { path: 'rules.json', role: 'data', data: JSON.stringify(set.rules, null, 1) }, { path: 'tiles.tsj', role: 'tiled', data: JSON.stringify(tsj, null, 1) }, { path: 'preview.png', role: 'preview', image: demo }];
      if (mode === 'blob') files.push({ path: 'tiles.tres', role: 'godot', data: godotBlobTileset(set, { texturePath: input.godotPath ?? `res://assets/${id}/tiles.png` }) });
      const r = await save(ctx, input, { id, name: `${ta} over ${tb} (${mode})`, kind: 'tileset', files, meta: { tile: size, tiles: set.count, columns: set.columns, rules: set.rules.kind, terrains: [ta, tb] }, source: { type: 'procedural', generator: `studio:autotile:${mode}`, seed, params: { a: ta, b: tb, size } }, tags: [ta, tb, 'autotile', mode], style: `pixel-${size}` });
      return { content: `${r.lines.join('\n')}\n${set.count} tiles (${set.rules.kind}); ${set.rules.meaning}. tiles.tsj has a Tiled wangset${mode === 'blob' ? '; tiles.tres is a Godot 4 TileSet with terrain peering bits' : ''}. Preview: a demo map autotiled with it.`, images: [preview(demo)] };
    }
    if (a === 'ui') {
      const k = uiKit({ color: input.color ?? '#3d7fd0', panelColor: input.panelColor ?? '#6a4a8a', accent: input.accent ?? '#f2c042', scales: input.scales ?? [1, 2, 4], icons: input.icons ?? ICONS, label: input.label ?? 'PLAY', seed });
      const pv = k.files.find((f) => f.path === 'preview.png');
      const files = [...k.files.map((f) => ({ path: f.path, role: f.role ?? (f.text ? 'svg' : 'image'), ...(f.image ? { image: f.image } : { data: f.text }) })), { path: 'kit.json', role: 'data', data: JSON.stringify(k.kit, null, 1) }];
      const r = await save(ctx, input, { id: input.id ?? `ui-kit-${seed}`, name: 'UI kit', kind: 'ui', files, meta: { scales: k.kit.scales, buttons: Object.keys(k.kit.buttons).length, icons: Object.keys(k.kit.icons).length }, source: { type: 'procedural', generator: 'studio:ui-kit', seed, params: { color: input.color, accent: input.accent } }, tags: ['ui', 'pixel-art'] });
      return { content: `${r.lines.join('\n')}\n${files.length} files: buttons (normal, hover, pressed, disabled), panels (nine-slice margins in kit.json), bars (frame + fill), ${Object.keys(k.kit.icons).length} icons, at ${k.kit.scales.join('x, ')}x.`, images: [preview(pv.image, { max: 900 })] };
    }
    if (a === 'parallax') {
      const p = parallax({ width: int(input.width, 384, 64, 4096), height: int(input.height, 216, 64, 2160), theme: input.theme ?? 'day', seed });
      const json = { width: p.width, height: p.height, theme: p.theme, layers: p.layers.map((l, i) => ({ file: `${i}_${l.name}.png`, name: l.name, factor: l.factor, ...(l.drift ? { driftPxPerSecond: l.drift } : {}) })), note: 'back to front; factor is the scroll speed relative to the camera (0 fixed sky, 1 the playfield); every layer tiles horizontally' };
      const r = await save(ctx, input, { id: input.id ?? `parallax-${p.theme}-${seed}`, name: `${p.theme} parallax`, kind: 'background', files: [...p.layers.map((l, i) => ({ path: `${i}_${l.name}.png`, role: i ? 'layer' : 'main', image: l.image })), { path: 'parallax.json', role: 'data', data: JSON.stringify(json, null, 1) }, { path: 'preview.png', role: 'preview', image: p.composite }], meta: { size: [p.width, p.height], layers: p.layers.length, tileable: 'x' }, source: { type: 'procedural', generator: 'studio:parallax', seed, params: { theme: p.theme } }, tags: ['background', 'parallax', p.theme] });
      return { content: `${r.lines.join('\n')}\nLayers: ${json.layers.map((l) => `${l.name} x${l.factor}`).join(', ')}.`, images: [preview(p.composite)] };
    }
    if (a === 'iso') {
      const types = input.types ?? ['grass', 'dirt', 'stone', 'sand', 'water', 'snow'];
      const width = int(input.width, 32, 8, 256), depth = int(input.depth, width / 2, 0, 256);
      const tiles = types.map((t) => isoTile(t, { width, depth, seed }));
      const sheet = new Image(width * tiles.length, tiles[0].height);
      tiles.forEach((t, i) => sheet.draw(t, i * width, 0));
      const g = [[0, 0, 1, 1], [0, 2, 2, 1], [4, 4, 3, 1], [4, 4, 3, 2]].map((r) => r.map((i) => types[i % types.length]));
      const scene = isoScene(g, { width, depth, heights: [[1, 1, 0, 0], [1, 0, 0, 0], [0, 0, 1, 2], [0, 0, 1, 3]] });
      const r = await save(ctx, input, { id: input.id ?? `iso-${width}-${seed}`, name: 'isometric tiles', kind: 'tileset', files: [{ path: 'iso.png', role: 'main', image: sheet }, ...tiles.map((t, i) => ({ path: `${types[i]}.png`, role: 'tile', image: t })), { path: 'preview.png', role: 'preview', image: scene }], meta: { tileWidth: width, tileHeight: tiles[0].height, diamond: [width, width / 2], blockDepth: depth, types }, source: { type: 'procedural', generator: 'studio:iso', seed, params: { types, width, depth } }, tags: ['isometric', '2.5d'] });
      return { content: `${r.lines.join('\n')}\n2:1 isometric: a ${width}x${width / 2} diamond top over ${depth}px sides; place blocks at screen x = (col - row) * ${width / 2}, y = (col + row) * ${width / 4} - height * ${depth}.`, images: [preview(scene)] };
    }
    if (a === 'particles') {
      const kinds = input.types ?? PARTICLES;
      const size = int(input.size, 16, 4, 256);
      const files = [];
      const strip = new Image(size * kinds.length, size);
      kinds.forEach((k, i) => {
        const fr = particle(k, { size, color: input.color ?? '#ffffff', seed, frames: k === 'flame' ? int(input.frames, 4, 1, 16) : 1 });
        strip.draw(fr[0], i * size, 0);
        if (fr.length > 1) { const s = new Image(size * fr.length, size); fr.forEach((f, j) => s.draw(f, j * size, 0)); files.push({ path: `${k}_strip.png`, role: 'frames', image: s }); }
        files.push({ path: `${k}.png`, role: 'particle', image: fr[0] });
      });
      const bg = new Image(strip.width, strip.height, '#1e1e2a'); bg.draw(strip, 0, 0);
      const r = await save(ctx, input, { id: input.id ?? `particles-${size}-${seed}`, name: 'particle textures', kind: 'particles', files: [{ path: 'particles.png', role: 'main', image: strip }, ...files], meta: { frameSize: [size, size], frames: kinds.length, kinds }, source: { type: 'procedural', generator: 'studio:particles', seed, params: { kinds, color: input.color } }, tags: ['particles', 'vfx'] });
      return { content: `${r.lines.join('\n')}\nWhite by default (tint them in the particle system); alpha carries the shape.`, images: [preview(bg)] };
    }
    if (a === 'icon') {
      const name = String(input.name ?? 'star');
      const img = icon(name, { color: input.accent ?? input.color ?? '#f2c042', seed });
      const scales = input.scales ?? [1, 2, 4];
      const files = scales.map((s, i) => ({ path: s === 1 ? 'icon.png' : `icon@${s}x.png`, role: i ? 'scaled' : 'main', image: s === 1 ? img : img.scale(16 * s, 16 * s) }));
      const svg = iconSvg(name, { color: input.accent ?? input.color ?? '#f2c042' });
      if (svg) files.push({ path: 'icon.svg', role: 'svg', data: svg });
      if (!files.some((f) => f.role === 'main')) files.unshift({ path: 'icon.png', role: 'main', image: img });
      const r = await save(ctx, input, { id: input.id ?? `icon-${name}`, name: `${name} icon`, kind: 'icon', files, meta: { frameSize: [16, 16], frames: 1 }, source: { type: 'procedural', generator: `studio:icon:${name}`, seed }, tags: ['icon', name] });
      return { content: r.lines.join('\n'), images: [preview(img)] };
    }
    return unknownAction('studio_sprite', a, SPRITE_ACTIONS);
  }),
};

export { parseColor };
