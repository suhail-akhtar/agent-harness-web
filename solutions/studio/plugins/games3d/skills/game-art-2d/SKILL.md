---
name: game-art-2d
description: Pixel art and 2D game assets with Studio's builders - sprites and animated sprite sheets (characters, enemies, items, props), seamless tiles and autotile sets (16-corner, 47-blob) with Tiled and Godot files, UI kits, parallax backgrounds, isometric tiles, particles, pixel fonts, and processing PNGs (palettes, background removal, slicing). Use for any 2D or 2.5D game art, and to keep a set of assets in one consistent style.
---
# 2D game art (studio_sprite, studio_image)

Everything here is plain JS (no programs to install), deterministic by `seed` (same seed, same pixels) and saved as a Studio asset: `.studio/assets/<id>/` with the files, `asset.json` (kind, source, CC0 licence, hashes, meta) and a preview you see in the result. `export: "godot/assets/player"` also copies the files into the engine project.

## Sprites and sheets

- `{"action":"kinds"}` lists kinds, their animations, terrains, particles, icons and palettes.
- Kinds: `character`, `goblin`, `skeleton` (humanoids: idle, walk, jump, attack, hurt), `slime`, `bat`, `ghost` (enemies), `coin` (spin), `gem` (sparkle), `chest` (open), `potion`, `sword`, `key`, `heart`, `shield`, `bomb`, `tree`, `rock`, `bush`.
- Humanoids take `view: "side"` (platformers, facing right: flip for left) or `"front"` (top-down), and `options`: `hat` none|cap|wizard|helmet|hood, `hairStyle` short|long|spiky|bald|ponytail, `weapon` none|sword|staff|axe.
- `colors` overrides materials: `{"shirt":"#c04040","hair":"#e8d080","skin":"#d49a6a"}` (others: pants, boots, belt, cloth, leaf, bark, gold, gem, slime, fur, wood, stone, metal).
- `size` is the frame side: characters are designed at 32, items at 16; 16, 24, 48 and 64 work.

```json
{"action":"sheet","kind":"character","seed":12,"anims":["idle","walk","jump","attack"],"options":{"hat":"helmet","weapon":"sword"},"colors":{"shirt":"#3e9a4a"},"id":"hero","export":"godot/assets/hero"}
```
writes `sheet.png` (one row per animation), `sheet.aseprite.json` (Aseprite hash format with frameTags: Phaser, Unity importers, LibGDX), `sheet.frames.json` (frame rects per animation, fps, loop) and `sheet.tres` (a Godot 4 SpriteFrames: give `godotPath` the `res://` path the PNG will have). Use `AnimatedSprite2D` with it in Godot.

## A consistent set

Pick one `palette` (pico8, db16, db32, endesga32, sweetie16, gameboy, or a list of colours) and one size, and pass them to every call; `outline: "auto"` (selective, the default) or one colour for all. Vary only `seed`, `colors` and `options`. The shading ramps shift shadows toward blue and highlights toward yellow, so different base colours still sit together. Record the style: `style: "pixel-32-db32"` on every asset, so `studio_library {"action":"search","style":"pixel-32-db32"}` finds the set.

## Tiles and autotiling

- One seamless tile: `{"action":"tileset","mode":"texture","terrain":"grass","size":16}` (grass, dirt, sand, stone, brick, water, wood, lava, snow, wall, path, darkgrass; `frames: 4` animates water).
- Transitions between two terrains, `a` drawn over `b`:
  - `mode: "blob"`: the 47-tile set. For a cell of terrain A, add the bits of its 8 neighbours that are A (N 1, NE 2, E 4, SE 8, S 16, SW 32, W 64, NW 128); `rules.json` `lookup[mask]` is the tile. B cells use tile 47. Also `tiles.tsj` (a Tiled wangset, "mixed") and `tiles.tres` (a Godot 4 TileSet: terrain set 0 in "match corners and sides" mode, so Godot's terrain painting works at once).
  - `mode: "corner"`: the 16-tile marching-squares set: per tile, bits of the corners that are A (NW 1, NE 2, SW 4, SE 8). Terrain lives on the grid's vertices.
- The preview shows a demo map autotiled with the set: look at it for seams.

## UI, backgrounds, 2.5D, effects

- `{"action":"ui","color":"#3d7fd0","accent":"#f2c042","label":"START","scales":[1,2,4]}`: buttons (normal, hover, pressed, disabled), nine-slice panels (margins in `kit.json`: in Godot a NinePatchRect with those patch margins), bars (frame + fill: crop the fill to the value), icons as PNG at each scale and SVG.
- `{"action":"parallax","theme":"dusk","width":384,"height":216}`: sky, far and near mountains, clouds, hills and trees as layers that tile horizontally; `parallax.json` gives each layer's scroll factor (Godot: ParallaxBackground + ParallaxLayer motion_scale).
- `{"action":"iso","types":["grass","stone","water"],"width":32}`: 2:1 blocks; draw at screen x = (col - row) * w/2, y = (col + row) * w/4 - height * depth.
- `{"action":"particles","types":["soft","spark","smoke","flame"]}`: white textures to tint in the particle system.
- `{"action":"icon","name":"gear","scales":[1,2,4]}` and `studio_image {"action":"font","scale":2,"outline":"#000000"}` (a BMFont .fnt Godot imports as a font).

## Processing PNGs (studio_image)

`process` runs ops in order. Make a generated or downloaded image game-ready:
```json
{"action":"process","input":"art/raw_slime.png","ops":[{"op":"colorKey","color":"auto","tolerance":40},{"op":"trim","pad":1},{"op":"square","bottom":true},{"op":"resize","width":32,"height":32},{"op":"hardAlpha"},{"op":"quantize","palette":"db32"},{"op":"outline","color":"auto"}],"id":"slime-art","kind":"sprite"}
```
Other ops: scale (nearest for pixel art), pot, crop, blur, flip, rotate, normalMap (from brightness), tileable, slice {cols, rows} (a sheet into frames). `draw` makes an image from shapes (rect, ellipse, circle, line, polygon, text, gradient with `steps` for dithered bands, noise). `info` reports size, colours and transparent bounds.

## Check before you hand it over

Run the gates `asset-manifest` (files, licence, hashes) and `asset-2d` (sheet frames match the JSON, transparent backgrounds, palette limits; set `meta.maxColors` by building with a `palette`). Look at every preview: shapes read at 1x, outlines closed, no stray pixels on transparent edges, animations loop without a pop.
