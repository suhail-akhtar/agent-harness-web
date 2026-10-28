---
name: engine-blender-guide
description: Blender for Studio - procedural models in Python, imports and exports for every engine, look-dev renders and turntables, sprite sheets for 2D and 2.5D games, and work in an open Blender.
---

# Blender (engine-blender)

## What it is for

3D assets made and checked with Blender: models built in Python at real scale, outside models
cleaned up, exports for Godot, Unreal, Unity and the web, preview and look-dev renders, turntables,
and 2D sprite sheets rendered from 3D models for 2D and 2.5D games. Use it when the person asks for
Blender, a .blend, FBX or OBJ, renders of a model, or sprites from a model. It is part of Studio
(the games3d plugin) and feeds engine-godot and the other engines.

## How work runs

- **One tool, `blender`.** Without an action it runs a bpy script headless (`script` or `code`,
  optionally on a `.blend` `file`, `show` to see images it wrote), as it always has.
- **Look:** `detect` (version, gaps), `describe` (a .blend's objects, sizes, triangles,
  materials, animation, bounds as data), `capture` (a quick framed view you see).
- **Move assets:** `asset.import` (glb, gltf, fbx, obj, stl, ply, usd, abc into a scene;
  normalise to a real height; save a .blend; export), `asset.export` (with `target` godot,
  unreal, unity or web for the axes).
- **Render** (a heavy job, one at a time): `render` with a look-dev preset (studio, outdoor,
  night, none), an engine (cycles, eevee, workbench) and `turntable: N` for a full turn.
- **Sprites** (a heavy job): `sprites` renders N directions x M animation frames orthographic and
  transparent into one sheet plus an asset.json in Studio's layout (`.studio/assets/<id>`), ready
  for the godot tool's `asset.import`.
- **The person's Blender:** `bridge.install` copies the Harness Bridge add-on into their add-ons
  folder (only when they ask); once they enable it, `script`, `describe` and `capture` with
  `live: true`, and `bridge.call` (ping, scene, exec, operator, capture, save). Local only
  (127.0.0.1, a token).
- **Gate:** `blender-file` (every .blend opens). With games3d: `gltf-valid`, `model-preview`.
- **Agent:** blender-artist. **Skills:** blender-scripting, blender-sprites.

## Worked examples

**"Make a wooden barrel in Blender for my Godot game"**: a bpy script in tools/barrel.py (real
size, the origin on the floor), run it; `capture` front and three-quarter and look; fix; `render`
studio; `asset.export` to out/barrel.glb with target godot; then godot `asset.import`.

**"Render a turntable of art/ship.blend"**: `describe` it (size, triangles), then `render` with
preset studio, engine eevee (or cycles where there is no GPU) and turntable 36; show three frames.

**"Turn the knight model into 8-direction walking sprites"**: `describe` (its walk action and
frame range); `sprites` with directions 8, frames 6, cell 64, elevation 30, animation walk; look at
the sheet; the asset is in .studio/assets/<id>.
