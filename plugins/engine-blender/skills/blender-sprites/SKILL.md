---
name: blender-sprites
description: Turning 3D models into 2D sprite sheets with Blender for 2D and 2.5D games - the blender tool's sprites action (N directions x M animation frames, orthographic, transparent), choosing the angle, cell size and frames, animating the model first, the asset.json it writes in Studio's layout, and using the sheet in Godot (AnimatedSprite2D or a billboard AnimatedSprite3D). Use when a 2D, isometric or 2.5D game needs characters, props or effects from a 3D model.
---
# Sprite sheets from 3D models

Pre-rendered sprites give a 2D or 2.5D game a consistent look from a model you can change and render again. The `blender` tool's `sprites` action does the whole job:
```json
{"action": "sprites", "file": "art/knight.blend", "id": "knight", "name": "Knight", "directions": 8, "frames": 6, "cell": 64, "elevation": 30, "animation": "walk"}
```
It renders the model from `directions` angles (counter-clockwise from the front) and, for each, `frames` frames spread over its animation, with an orthographic camera, a transparent background and the same framing for every cell (so the sprite never changes size as it turns). Then it pastes them into one sheet and writes, by default into `.studio/assets/<id>/`:
- `<id>.png`: rows are directions, columns are frames;
- `asset.json` (Studio's FORMATS.md layout): kind `spritesheet`, `meta.frameSize`, `columns`, `rows`, `fps`, `directions`, `directionNames`, `cellMetres` (the metres one cell spans), `elevation`, and `animations` named `<animation>_<direction>` (`walk_s`, `walk_sw`, `walk_w`, `walk_nw`, `walk_n`, `walk_ne`, `walk_e`, `walk_se` for 8), each `{row, from, count, loop}`.

## Choosing the settings
| Setting | Guide |
|---|---|
| `directions` | 1 (a prop), 4 (grid movement), 8 (free movement, the usual), 16 (smooth turning). Rows grow with it. |
| `frames` | 1 for a still; 4-8 for a walk cycle; the frames are sampled evenly over the action's frame range (the scene's range when there is no action). |
| `cell` | the pixel size of each cell: 32-64 for pixel art, 128-256 for HD 2D. The sheet is `frames x cell` wide and `directions x cell` tall. |
| `elevation` | the camera's angle above the ground: 30 for the classic isometric look (match a 2.5D camera at -30 or -35.264), 45 for top-down-ish, 0 for side view (platformers), 90 for straight down. |
| `engine` | `eevee` (the default: fast, needs a GPU; the first frame compiles shaders), `cycles` (CPU, nicer light, slower: lower `samples`), `workbench` (flat, instant: for checking poses). |
| `preset` | studio lights by default; `none` keeps the scene's own lights. |
| `pixelArt` | crisp edges (no filtering): pair with a small `cell` and Godot's nearest filter. |

## Prepare the model
- Face the front along -Y (Blender's front view), stand it on z = 0, real size in metres (`asset.import` with `normalise` does this for an imported model).
- An animation: keyframes on the objects or an armature's action (`describe` lists the actions and their frame ranges). A walk cycle loops when its first and last poses match: render `frames` that leave out the duplicate last pose (6 frames of a 1-24 cycle sample 1, 5, 9, 13, 17, 21).
- Several animations (idle, walk, attack): one run each with `animation` set and its own `id` (`knight-walk`, `knight-idle`), or merge sheets later.
- Materials: strong, simple colours read better at small sizes; a darker outline (Solidify modifier with flipped normals and a black material) helps.

## Look at it
The result shows the sheet. Check: every row turns the same amount, the model fills its cells without being cut off, the animation moves (compare columns), the background is transparent. Fix the model or the settings and run again.

## Use it in Godot
1. `{"action": "asset.import", "asset": "knight", "project": "game"}` (godot tool) copies the folder into `game/assets/knight/` and records the res:// path in both asset.json files.
2. `sprite.sprite_frames = SpriteSheet.load_frames("res://assets/knight")` (`harness/sprite_sheet.gd`, in every template) and `sprite.play("walk_" + dir)` with the direction from the movement (godot-2d has `_dir_name`).
3. 2D: an `AnimatedSprite2D`. 2.5D: an `AnimatedSprite3D` with `billboard = BILLBOARD_FIXED_Y` and `pixel_size = meta.cellMetres / meta.frameSize[0]` (asset.json records how many metres a cell spans), so one metre in the sheet is one metre in the world.
