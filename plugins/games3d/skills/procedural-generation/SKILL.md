---
name: procedural-generation
description: Procedural content with studio_procgen - noise textures, terrain heightmaps with splat masks, dungeons (BSP rooms and corridors), cellular-automata caves, mazes, platformer levels proven finishable by a physics solver, top-down overworld maps, Wave Function Collapse (tiled and overlapping), L-system plants and names; every level saved as JSON rows, a Tiled .tmj map and a preview, deterministic by seed. Use for levels, terrain, maps and anything a seed should vary.
---
# Procedural generation (studio_procgen)

Every action takes a `seed` (number or text); the same seed always gives the same result, so record it and regenerate rather than hand-edit. Levels are saved as Studio assets of kind `level`:

- `level.json`: `{ type, width, height, rows: ["#..S..", ...], legend, start, exit, physics?, proof }` (row 0 is the top; one character per tile),
- `level.tmj` + `tiles.tsj` + `tiles.png`: a Tiled map (a tile layer, and an object layer with start, exit, coins, enemies, chests as points) that Godot (Tiled importer), Phaser, Defold and others load,
- `preview.png`: the level drawn with tiles (look at it).

## Levels

| action | what | legend |
|---|---|---|
| `dungeon` | BSP rooms joined by L corridors, doors, chests, monsters; start and exit in the rooms farthest apart | `#` wall `.` floor `+` door `S` `E` `$` chest `m` monster |
| `cave` | cellular automata (fill, 5 smoothing steps); every pocket tunnelled to the main cave | `#` rock `.` floor |
| `maze` | `algorithm` backtracker (long corridors), prim (many dead ends), kruskal (uniform), binary (biased); `braid` 0-1 adds loops | `#` wall `.` path |
| `topdown` | height and moisture noise into biomes, towns, roads by A* | `~` deep `w` water `s` sand `g` grass `f` forest `h` hills `M` mountain `*` snow `=` road `T` town |
| `platformer` | side-scroller built from the physics and proven by the solver | `#` ground `X` block `-` one-way `^` spikes `o` coin `e` enemy |

Every level is checked before it is saved: start reaches exit (and, for dungeons, caves and mazes, all the floor is reachable). `showPath: true` draws the path on the preview.

## Platformers that can be finished

The player's physics come in tiles and seconds: `jumpHeight` (3.2), `runSpeed` (6 tiles/s), `gravity` (40 tiles/s^2); the player box is 0.8 x 1.8 tiles. The generator only builds gaps, steps and platforms within reach (`difficulty` 0-1 makes them tighter), and the solver proves it: a search over every standing place, trying walks, falls off ledges, and jumps at seven horizontal speeds from three spots on each tile, simulated at 120 Hz against the tiles (walls stop you, ceilings bump you, one-way platforms carry you from above, spikes kill). `proof.moves` lists one way through.

```json
{"action":"platformer","seed":"world-1-1","length":160,"difficulty":0.6,"jumpHeight":3.5,"runSpeed":7,"gravity":45}
```
Use the same numbers in the game's controller (jump velocity = sqrt(2 * gravity * jumpHeight) tiles/s), or the level's proof does not hold. To check a level you edited: `{"action":"solve","level":".studio/assets/level-platformer-world-1-1/level.json"}` or pass `rows`. The `level-playable` gate re-solves every level asset.

## Terrain

`{"action":"heightmap","size":513,"seed":3,"ridges":0.4,"island":true,"erosion":30,"heightM":120}` writes `height16.png` (16-bit greyscale, black lowest; 2^n+1 sizes suit Unity and Unreal), `splat.png` (R sand, G grass, B rock by slope, A snow; they sum to 255), a shaded preview and `heightmap.json`. `studio_model {"action":"build","generator":"terrain","params":{"heightmap":"heightmap-513-3","size":200,"heightM":40}}` turns it into a mesh with vertex colours.

## Noise

`{"action":"noise","type":"perlin","size":256,"scale":32,"octaves":5,"tileable":true,"warp":0.8,"stops":[[0,"#203040"],[0.6,"#6a8a4a"],[1,"#f0f0e0"]]}`. Types: value, perlin, simplex (not tileable), worley (cells), ridged (mountain crests). `tileable` wraps both edges (the scale is rounded to whole lattice cells).

## Wave Function Collapse

- Tiled model: `{"action":"wfc","tiles":"coast","width":30,"height":20,"seed":5}` (built-in sets `roads` and `coast`), or your tiles: `[{"name":"grass","sockets":["ggg","ggg","ggg","ggg"],"weight":5},{"name":"road","sockets":["grg","ggg","grg","ggg"],"rotate":true}]`. Sockets are read clockwise along each edge (north left to right, east top to bottom, south right to left, west bottom to top); two tiles fit where one edge is the other reversed. `rotate` adds the 90/180/270 copies (`name@90`).
- Overlapping model: `{"action":"wfc","model":"overlapping","sample":["....",".##.","...."],"n":3,"width":40,"height":24}` learns every NxN window (with rotations and reflections, `symmetry` 1-8) and makes a grid where every window is one it saw. A contradiction retries from derived seeds; if it keeps failing, use a smaller `n` or a larger sample.

## Plants and names

- `{"action":"lsystem","preset":"tree","seed":2}` (tree, bush, pine, fern, weed) or your `axiom` and `rules` (`{"F":"FF","X":"F[+X][-X]FX"}`, or stochastic `[{"to":"F[+F]F","weight":2},...]`), `iterations`, `angle`. Symbols: F draw, f move, + - yaw, & ^ pitch, \ / roll, [ ] branch, ! thinner, L leaf. It saves a sprite and the 3D branch segments; `studio_model build tree` grows the same plant in Blender.
- `{"action":"names","style":"dwarven","count":12,"seed":1}`: fantasy, elven, dwarven, orcish, scifi, place, tavern, item.

## Habits

Keep generation reproducible: the asset's `source.seed` and `params` say how to make it again. Generate many seeds, look at the previews, keep the good ones. Hand edits to a level go back through `solve` and the `level-playable` gate.
