---
name: asset-pipeline
description: Studio's asset pipeline - 3D props, kits, buildings, terrain, trees, a rigged animated character, vehicles and baked PBR materials made in Blender with studio_model; asset folders with manifests (source, licence, hashes) and the shared library (studio_library); outside models and CC0 downloads cleaned up and gated; budgets, formats per engine, units and axes; the asset gates. Use whenever assets go into a game, come from outside, or need checking.
---
# The asset pipeline

## Where assets live

Every asset is a folder `.studio/assets/<id>/` in the project (the folder with `.studio/project.json`) holding its files and `asset.json`:
`{ id, name, kind, dimension, files: [{path, role}], source, license, hashes, tags, style, meta, checks, engines }`.
- `kind`: model, sprite, spritesheet, tileset, texture, material, audio, music, font, ui, level, heightmap, background, particles, icon, pack.
- `source.type`: procedural (generator, seed, params: it can be made again), import, library (provider, url), generated (provider, model, prompt, cost).
- `license.id`: CC0-1.0 for everything Studio makes and for Poly Haven, ambientCG and Kenney; the provider's terms for generated assets; whatever the person says for imports. No licence, no asset.
- Roles: `main` (the file an engine imports), `preview` (to look at), `lod1`.., `fbx`, `godot`, `tiled`, `data`, `frame`...

Every studio_* builder writes this; `export: "<folder>"` also copies the files into an engine project. `studio_library` lists, searches (kind, tags, style, text, licence), shows, imports workspace files (with a licence), publishes to the shared library `~/.harness/assets` (every project of this harness), copies from it (hashes checked), verifies, and rehashes after a deliberate edit.

## 3D in Blender (studio_model)

`{"action":"status"}` says whether Blender is there (else how to get it; the 2D tools still work). `{"action":"generators"}` lists parameters.

```json
{"action":"build","generator":"barrel","seed":4,"params":{"height":1.0,"wood":"#7a4a2a"},"fbx":true,"lods":[0.5,0.25]}
{"action":"build","generator":"kit","params":{"grid":2,"wallHeight":3,"pieces":["floor","wall","corner","door","stairs"]}}
{"action":"build","generator":"character","seed":7,"params":{"shirt":"#c83a3a"},"sprites":{"directions":8,"size":64,"actions":["idle","walk"],"frames":8}}
{"action":"build","generator":"terrain","params":{"heightmap":"heightmap-257-3","size":128,"heightM":24}}
{"action":"build","generator":"material","params":{"preset":"brick","size":1024}}
{"action":"cleanup","file":"downloads/statue.glb","targetHeight":1.8,"maxTriangles":8000,"license":{"id":"CC-BY-4.0","author":"Jane Doe","url":"..."}}
```
- Props: barrel, crate, chest, coin, gem, lamp, table, chair, fence, rock, bush, grass (crossed cards with an alpha texture). World: tree (the L-system of studio_procgen, as tubes and leaf clumps), kit (one glb per piece, origins on the grid), building, terrain, vehicle (wheels are separate nodes: wheel_FL, wheel_FR, wheel_RL, wheel_RR). Character: 15 bones (hips, spine, chest, neck, head, upper_arm/forearm .L/.R, thigh/shin/foot .L/.R), rigid skinning, actions idle, walk, run, jump (glTF animations by those names). Material: base colour, roughness and normal maps baked from procedural nodes, on a sphere glb.
- `bake: true` bakes AO and a normal map from a subdivided copy (new UVs), and writes `<name>_baked.glb`.
- `sprites` renders N directions (orthographic, 30 degrees down, transparent) of every frame of the actions: `sprites.png` (rows action_direction, columns frames) with Aseprite JSON: 2.5D games from 3D models. `{"action":"sprites","id":"model-barrel-4","directions":4}` does it for an asset already made.
- Every result is checked at once (valid glTF, normals, UVs, degenerate triangles) and shows a preview render: look at it ("does this read as a wooden barrel?").

## Units, axes, formats per engine

- Metres. Blender is Z up with the front at -Y; glTF is Y up with the front at +Z (the exporter converts). Origins sit at the base centre (kit pieces on the grid), so assets stand on the floor where they are placed.
- Godot: import the `.glb` (it keeps materials, skins, animations; AnimationPlayer gets idle/walk/run/jump). Sprite sheets: `sheet.tres` (SpriteFrames). Tilesets: `tiles.tres` (TileSet with terrains). Levels: `level.tmj` with a Tiled importer, or read `level.json`.
- Unreal: the `.fbx` (`fbx: true`): FBX_SCALE_ALL, no leaf bones, smoothing by face; import as Static Mesh, or Skeletal Mesh with animations for the character. Unreal is Z up and centimetres: the FBX carries the unit scale.
- Unity: the `.fbx` or `.glb` (with glTFast); heightmaps as 16-bit PNG (convert to RAW for Terrain).
- Web (Three.js): the `.glb` (GLTFLoader); textures power of two.

## Budgets and gates

The project's `.studio/project.json` `budgets`: `trianglesPerAsset` (20000), `textureMax` (2048), `assetMb` (64), `powerOfTwo` (true: textures and materials). The gates (run them before handing assets to a game; workflows can name them):
- `asset-manifest`: asset.json complete, licence recorded, files there, hashes match.
- `asset-budget`: triangles per model (LODs never above the main mesh), texture sizes, power-of-two textures, total size.
- `asset-3d`: glTF valid, plausible size (0.01-500 m, and as recorded), normals and UVs on every mesh, under 1% degenerate triangles.
- `asset-2d`: PNGs decode, sheets' frames inside the image at the recorded size, transparent backgrounds for sprites/sheets/icons/particles, palette limits, whole tiles.
- `audio-valid`: WAVs parse, not silent, not clipped, the recorded length.
- `level-playable`: every level can be finished (the platformer solver with the level's physics, or a path from S to E).

A failing gate names the asset and the problem: fix the asset (rebuild with other params, `cleanup` with a lower `maxTriangles`, a smaller texture), never the gate.

## Outside sources (studio_source)

Off unless the operator turned them on (`{"action":"status"}`). CC0 libraries: `{"action":"search","source":"polyhaven","type":"models","query":"barrel"}` then `{"action":"download","source":"polyhaven","id":"...","resolution":"1k"}`; ambientCG materials (`"resolution":"1K-PNG"`), Kenney packs (`"id":"tiny-dungeon"`, `include` a file regex). Licence and source are recorded. Paid generators (OpenAI images, Meshy and Tripo text-to-3D) are costed and capped per workspace and project (USD 0.50 each by default): prefer procedural assets, generate only what procedure cannot make, at low quality first. A text-to-3D model is cleaned in Blender and gated like any other.
