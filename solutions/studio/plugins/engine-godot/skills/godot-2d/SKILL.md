---
name: godot-2d
description: 2D and 2.5D games in Godot 4 - Node2D scenes, TileMapLayer levels and TileSets built in code, AnimatedSprite2D and SpriteFrames from sprite sheets in Studio's asset layout, cameras, pixel art, depth sorting, isometric maps, and 2.5D as 3D with an orthographic camera and billboard sprites (sheets rendered from Blender). Use for any 2D, top-down, platformer, isometric or 2.5D Godot game.
---
# 2D and 2.5D in Godot 4

Start from `{"action": "project.create", "template": "2d"}` (top-down tiles, an animated hero, coins) or `"2.5d"` (an isometric 3D level with a billboard hero), then change `scripts/main.gd`. Load godot-essentials for the tool and the self-test.

## Coordinates and nodes
- Pixels, y down. `Node2D` for things in the world, `Control` for UI (inside a `CanvasLayer` so it ignores the camera).
- Bodies: `CharacterBody2D` (`velocity`, `move_and_slide()`; `motion_mode = MOTION_MODE_FLOATING` for top-down, the default for platformers with `is_on_floor()`), `StaticBody2D`, `Area2D` (`body_entered` for pickups and triggers), shapes in `CollisionShape2D`.
- `Camera2D` as a child of the player follows it; set `limit_*` to the level's size. `position_smoothing_enabled = true` for a soft follow.

## Pixel art
In project.godot: `textures/canvas_textures/default_texture_filter=0` (nearest), a small viewport (`window/size/viewport_width=640`, `height=360`) scaled up (`window_width_override=1280`, `window/stretch/mode="canvas_items"`). Keep sprite positions whole (`position.round()`) if pixels shimmer.

## Sprite sheets (Studio's asset layout)
A sheet lives in a folder with its asset.json: `assets/<id>/asset.json` beside `<id>.png` (FORMATS.md: kind `spritesheet`). `meta` says how to cut it:
```json
{"frames": 32, "frameSize": [64, 64], "columns": 4, "rows": 8, "fps": 10,
 "animations": {"walk_s": {"row": 0, "from": 0, "count": 4, "loop": true}, "idle": {"row": 0, "from": 0, "count": 1}}}
```
`harness/sprite_sheet.gd` (in the templates) turns it into SpriteFrames, one animation per entry:
```gdscript
const SpriteSheet := preload("res://harness/sprite_sheet.gd")
sprite.sprite_frames = SpriteSheet.load_frames("res://assets/hero")
sprite.play("walk")
```
Sheets from Blender (`blender` action `sprites`, blender-sprites skill) are written straight into `.studio/assets/<id>/` with that asset.json; bring one into the project with `{"action": "asset.import", "asset": "<id>"}`. Their animations are named `<animation>_<direction>` (`walk_s`, `walk_sw`, ... counter-clockwise from the front): pick the row from the movement direction:
```gdscript
const DIRS := ["s", "sw", "w", "nw", "n", "ne", "e", "se"]
func _dir_name(v: Vector2) -> String:  # v in screen space, y down
	var a := fposmod(atan2(-v.x, v.y), TAU)  # 0 = down the screen (south), counter-clockwise
	return DIRS[int(round(a / (TAU / 8))) % 8]
```
The exported presets include `assets/*.json`: keep that include filter in new presets, or the sheets do not load in a build.

## Tile maps: TileMapLayer
Godot 4.3+ uses one `TileMapLayer` node per layer (the old TileMap is deprecated). Build the TileSet in code, as the 2D template does:
```gdscript
var ts := TileSet.new()
ts.tile_size = Vector2i(16, 16)
ts.add_physics_layer()
var src := TileSetAtlasSource.new()
src.texture = load("res://assets/tiles/tiles.png")
src.texture_region_size = Vector2i(16, 16)
for x in 3:
	src.create_tile(Vector2i(x, 0))
ts.add_source(src, 0)                      # add the source before editing its tiles' physics
var wall := src.get_tile_data(Vector2i(2, 0), 0)
wall.add_collision_polygon(0)
wall.set_collision_polygon_points(0, 0, PackedVector2Array([Vector2(-8, -8), Vector2(8, -8), Vector2(8, 8), Vector2(-8, 8)]))
var layer := TileMapLayer.new()
layer.tile_set = ts
add_child(layer)
layer.set_cell(Vector2i(x, y), 0, Vector2i(2, 0))   # cell, source id, atlas coords
```
`get_used_cells()`, `get_cell_atlas_coords(cell)`, `local_to_map(pos)` and `map_to_local(cell)` read it back. Levels from a generator: fill cells in a loop from a grid (an array of strings is fine).

## Depth sorting (top-down, 2.5D in 2D)
- `y_sort_enabled = true` on the parent (and on the TileMapLayer for tall tiles): children draw in order of their y, so a character walks behind a tree. Put each sprite's origin at its feet (`offset.y = -height / 2` on the sprite).
- `z_index` for fixed layers (ground -1, effects +10).
- Isometric tiles: `ts.tile_shape = TileSet.TILE_SHAPE_ISOMETRIC`, `ts.tile_layout = TileSet.TILE_LAYOUT_DIAMOND_DOWN`, tile size 2:1 (e.g. 64x32), with y-sort on the layer.

## 2.5D as 3D with an orthographic camera (the 2.5d template)
- `Camera3D.projection = PROJECTION_ORTHOGONAL`, `size` = how many metres fit vertically, `rotation_degrees = Vector3(-35.264, 45, 0)` (true isometric; -30 for the "2:1 pixel" look). Follow the player: `cam.position = player.position + cam.basis.z * 20`.
- Move along the screen, not the world axes: right is `cam.basis.x` flattened, up the screen is `-cam.basis.z` flattened.
- Characters as billboards: `AnimatedSprite3D` with `billboard = BaseMaterial3D.BILLBOARD_FIXED_Y`, `pixel_size = 1.0 / pixels_per_metre`, `texture_filter = TEXTURE_FILTER_NEAREST`, `alpha_cut = SpriteBase3D.ALPHA_CUT_DISCARD` (correct depth with the 3D world), `shaded = false` for flat sprites.
- Many floor tiles: one `MultiMeshInstance3D` (one draw call), as the template does, not hundreds of MeshInstance3D.

## Checks for 2D games
- `describe` shows TileMapLayer cell counts and AnimatedSprite animations: confirm the level and the animations exist.
- `play` with inputs and look at the frames: sprites the right way round (`flip_h`), the camera inside the level, the UI readable at the real window size.
- Self-test: movement, an animation playing while moving, walls that stop the player, a pickup that scores (the 2D template's checks).
