---
name: games3d-guide
description: Studio: games and 3D from brief to tested build: projects with stages, assets, the 3D and 2D viewers, builds, playtests, the job queue and the engines (Blender, Godot, Unreal, Unity, web).
---

# Studio (games3d)

## What it is for

Making games (2D, 2.5D and 3D) and 3D content end to end: a brief and a design, a prototype, the
content (models, sprites, tilesets, levels, sounds), builds, and playtests that prove the game works.
Use Studio when the person asks for a game, a level, a model, a sprite sheet, a texture or a sound,
asks to see one, asks what an engine can do here, or wants a build or a playtest looked at.

Studio is the module; the work is done by tools. Studio's own tools (`model_info`, `blender`,
`godot`) and its workflows and agents are in the reference below. The engine plugins
(`engine-blender`, `engine-godot`, `engine-unreal`, `engine-unity`) each add their engine's tool
with actions (detect, install, project, script, asset import and export, capture, render, build,
test, play, the live bridge); the asset builders and the AI player add theirs. Use whichever of
them this session has, and keep their results in the files below so Studio's pages show them.

## What the person sees

- **Home** (`desktop_open {"target":"view","id":"games3d"}`): recent projects with their stage,
  the job queue, the engines on this machine with their gaps, recent assets and playtests, and the
  quick starts (a 2D platformer, a 3D third-person game, a model, a sprite sheet, a level).
- **Projects** (`games3d:projects`): every folder with `.studio/project.json`. A project's page
  (params `{"project": <folder or id>}`) has its stages, where the person approves, asks for
  changes or comments (their comments are for you: read them in project.json), the design
  document, budgets, builds, playtests and assets. A project whose engine plugin is off opens
  read-only with "Made with <engine>, which is off".
- **Assets** (`games3d:assets`): a grid with previews of every project's assets and the shared
  library, filtered by kind, dimension, style, license and source; an asset's page (params
  `{"asset": <id>, "project": <folder>}` or `{"asset": "library:<id>"}`) shows its provenance
  (source, generator, prompt, seed), license, checks, details and files.
- **3D viewer** (`games3d:viewer`): a .glb or .gltf with orbit, shaded, wireframe, normals and UV
  checker modes, normal lines, grid and axes, front/side/top views, a turntable, the asset's LODs,
  the animation player (clips, play, scrub, speed, loop) and the numbers (triangles, vertices,
  meshes, materials, textures, size in metres, file size).
- **2D viewer** (`games3d:sprites`): sprites and sprite sheets (the sheet with its frame grid and
  the animation at its frame rate, nearest-neighbour zoom), tilesets (the tile grid) and levels
  (params `"mode": "level"`: a Tiled .tmj or a level JSON drawn with its tileset, layer switches,
  objects).
- **Audio player** (`games3d:audio`): a .wav, .mp3 or .ogg with its waveform, play, seek, loop.
- **Scenes** (`games3d:scenes`): Godot .tscn (with the node outline), Unreal .umap, Unity .unity,
  .blend, glTF scenes in scenes/ or levels/, level JSON.
- **Renders** (`games3d:renders`): images in renders/, previews/, captures/, screenshots/ (and
  Unreal's MovieRenders), newest first, two side by side to compare.
- **Builds** (`games3d:builds`): each project's builds; a build (params `{"project", "id"}`) shows
  its status, artifact, log, and the problems in the log linked to the source lines.
- **Playtests** (`games3d:playtests`): reports; one (params `{"project", "id"}`) has the timeline
  of events with the frames, the metrics against the project's budgets (charts), issues with their
  evidence frames, the verdicts, and the recording.
- **Jobs** (`games3d:jobs`): the heavy-job queue (renders, builds, cooks, bakes, long plays: one
  per engine at a time) with cancel. The menu's Jobs badge counts what runs or waits.
- **Engines** (`games3d:engines`): Blender, Godot, Unreal, Unity and the web on this machine:
  installed, version, path, toolchain gaps, install buttons (they ask first).

Every button is an operation you can call too: the commands in the reference (desktop_command,
the person is asked first). Open pages with desktop_open or the `open-*` commands; pass a
project's folder as `project` (its absolute path, the folder holding `.studio`) and absolute or
project-relative paths.

## Showing things in the conversation

Write a fenced block whose language is one of these, with a JSON object in it, and the app draws
a card (where Studio is off, the JSON shows as it is):

~~~
```studio-model
{"path": "assets/barrel.glb", "project": "E:/games/coin-escape"}
```
~~~

- `studio-model` `{"path", "project"}`: a thumbnail, triangles and size, "Open in 3D viewer".
  The results of `model_info` get this card on their own, and so do the asset builders' results
  (`studio_sprite`, `studio_image`, `studio_audio`, `studio_procgen`: an asset card of its kind,
  a sprite sheet playing) and `game_playtest`'s (a playtest card).
- `studio-sprite` `{"path", "project", "frameWidth", "frameHeight", "frames", "fps"}`: the
  animation playing, "Open in 2D viewer".
- `studio-playtest` `{"project", "id"}`: result, metrics, an event strip, the top issues.
- `studio-build` `{"project", "id"}`: status, errors, the first problems.

`project` is the project's folder (absolute); `path` may instead be absolute on its own. Images a
tool returns show in the conversation as they are.

## The files Studio reads

All in the project folder, the one holding `.studio/project.json` (plugins/games3d/sdk/FORMATS.md
has every field; a field may be added, never removed):

- `.studio/project.json`: name, engine (web, godot, unreal, unity, blender), dimension (2d, 2.5d,
  3d), genre, engineProject, design (the design document's path), budgets (fps, frameMs, memoryMb,
  trianglesPerAsset, textureMax), stages `[{id, title, status, note}]` (status pending, active,
  review, done, approved, changes-requested; set "review" when the person should look; Studio adds
  approvedAt, approvedBy and comments), builds `[{id, platform, path, status, at, log}]` (log: the
  build log's path, so the Builds page can show it and link its problems), playtests (ids).
- `.studio/assets/<id>/asset.json`: id, name, kind (model, sprite, spritesheet, tileset, texture,
  material, audio, music, font, ui, level, heightmap), dimension, files `[{path, role}]` (roles:
  main, preview, lod1, lod2...; paths relative to the asset folder), source (procedural with
  generator and seed, import, library with provider and url, generated with provider, model and
  prompt), license (id, author, url), hashes, tags, style, meta (triangles, sizeM, frames, frameSize,
  fps, animations, tile, durationS), checks `[{gate, pass, summary, at}]`, engines (where it was
  imported). The shared library is `~/.harness/assets/<id>/` with the same layout. Give every asset
  a preview (a PNG, role preview) when you can: the grid and the cards show it.
- `.studio/playtests/<id>/report.json`: engine, build, player, goal, result (pass, fail, crash,
  timeout), durationS, steps, events `[{t, type, detail, frame?}]`, metrics (fpsAvg, fpsMin,
  frameMsP95, memoryMb, errors), optional series `{"fps": [[t, v], ...]}` for the charts, frames
  (paths in the playtest folder, in time order), recording (a GIF), issues `[{severity, title,
  detail, evidence, t}]`, verdicts `[{by, claim, pass, evidence}]`.
- Renders: PNG/JPG files in `renders/`, `previews/`, `captures/` or `screenshots/`.

## The engines, and how to choose one

Look at Studio > Engines (or `desktop_command {"command":"games3d:detect-engines"}`) before you
choose; run the engine tool's `detect` action for the full report.

- **Web** (Canvas 2D or Three.js, always there): quick 2D games and light 3D that play anywhere,
  checked in the headless browser. The default for a first version.
- **Godot 4**: 2D, 2.5D and mid-size 3D games with small exports (Linux, Windows, web). Headless
  check, run, screenshot, export; a `--selftest` mode proves the rules. Install it with the Godot
  engine tool's install action (it asks).
- **Unreal Engine**: high-end 3D (levels, Blueprints, editor Python, Movie Render Queue,
  BuildCookRun for Win64). Without the MSVC toolchain it is Blueprints and Python only (Engines
  says so): never plan C++ then. The person installs it and accepts its EULA.
- **Unity**: C# games (batch mode, the Test Framework, BuildPipeline); the person activates its
  license in Unity Hub, never you.
- **Blender**: models, materials, rigging, animation and renders, and the hub every asset goes
  through (scale and axes, glTF/FBX export). Not a game engine.

Heavy work (renders, builds, cooks, bakes) goes through the job queue: one per engine at a time,
with a timeout and a cancel. Tell the person it is queued, and point at Jobs.

## Typical flows

**A 2D game** (platformer, top-down, puzzle): pick web (Canvas) or Godot. Write
`.studio/project.json` (dimension 2d, budgets, stages brief, design, prototype, vertical-slice,
content, polish, package, playtest), the design document, then build. Make the sprites, sprite
sheets and tilesets as assets with their frame sizes and fps, the levels as level JSON or Tiled
.tmj with their tileset, sounds as audio assets. Show them (studio-sprite cards, `open-sprite`,
`open-level`). Build, record the build in project.json, playtest, write the report.

**A 2.5D game** (a 3D world on a 2D plane, side-on or isometric): web with Three.js and an
orthographic camera, or Godot 3D with movement locked to a plane. dimension "2.5d"; models as
glTF assets with LODs where they are many.

**A 3D game** (third person, first person): web Three.js for something small, Godot for a full
small game, Unreal for high-end visuals (Blueprints and Python unless MSVC is there). Models from
Blender (procedural scripts) or the asset builders, checked by the gates (triangle budgets, UVs,
normals, scale in metres), imported into the engine (record it in asset.json engines).

**Assets**: one folder per asset under `.studio/assets/<id>/` with asset.json, a preview, the
source and the license (CC0 libraries record author and url; generated assets record provider,
model and prompt). Run the checks and record them. Show the result: a studio-model or
studio-sprite card, or the asset page.

**A playtest**: run the AI player or a bot on the build; it writes
`.studio/playtests/<id>/report.json` with frames and events. Add its id to project.json
playtests, then show it (`open-playtest`, or a studio-playtest card). Fix the major issues and
play again. Nothing is done without a passing build and a playtest.

**Stages**: when a stage is ready for the person, set its status "review" and tell them; they
approve or ask for changes in Studio (or say so to you: then `approve-stage`,
`request-changes`, `comment-stage`). Read the comments before the next stage.

## Worked examples

**"What can Studio do here?"**: summarise from this guide, call `games3d:detect-engines` (or
open `games3d:engines`), and say which engines are ready and their gaps (for example Unreal 5.8
without MSVC: Blueprints and Python only).

**"Show me the barrel model"**: find its asset (`.studio/assets/barrel-wood-01/asset.json`),
then `desktop_command {"command":"games3d:open-model","args":{"path":"barrel.glb","project":"<project folder>","asset":"barrel-wood-01"}}`,
or answer with a studio-model block.

**"Make a 2D platformer"**: `games3d:new-2d-platformer` opens the build-game workflow for the
person to confirm; or build it yourself in the flow above, keeping project.json current.

**"Why did the build fail?"**: open it (`games3d:open-build {"project","id"}`), read the log
(its path is in project.json), fix each error at its file and line, build again, record it.

**"How did the playtest go?"**: `games3d:open-playtest {"project","id"}`, then summarise the
result, the metrics against the budgets and the major issues with their evidence frames.

**"Cancel the render"**: `games3d:open-jobs`, then `games3d:cancel-job {"id":"job-N"}` once the
person agrees.

<!-- generated -->
