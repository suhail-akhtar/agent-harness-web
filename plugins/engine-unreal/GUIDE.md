---
name: engine-unreal-guide
description: Unreal Engine 5 for Studio, Blueprint and Python first - projects, editor Python, captures, tests, Win64 packaging, scripted and AI-driven playtests, and a live Remote Control bridge.
---

# Unreal Engine (engine-unreal)

## What it is for

Making and proving games and levels in Unreal Engine 5 on this machine: a project from Epic's
Blueprint templates (third person, first person, top down, blank, or a 2.5D side-scroller and a
2D top-down setup), levels and Blueprint logic built from editor Python, imported models from
Blender, rendered frames and turntables, Automation tests, a packaged Win64 build, and playtests
of that build with scripted inputs or an AI player stepping through it. Use it whenever a task
names Unreal or the workspace has a `.uproject`.

It works without a C++ compiler: Blueprint projects package with the engine's precompiled game
binary, and Blueprint graphs are wired from Python with Unreal 5.8's graph API.

## How work runs

- **Tool `unreal`**, one action per call:
  - `detect`: installs, version, gaps.
  - `project.create`, `describe`.
  - `script`: editor Python with `import harness_ue as h`.
  - `capture`: a PNG the agent sees. `render`: a Movie Render Queue turntable.
  - `test`: Automation and Python checks.
  - `build`, `package`: RunUAT BuildCookRun for Win64.
  - `play`: a scripted run with frames, fps, memory and a playtest report.
  - `play.start`, `play.step`, `play.state`, `play.stop`: the paused step server for an AI player.
  - `bridge.*`: Remote Control on an editor the tool launches.
  - `asset.import`, `asset.export`, `jobs`.
- **Heavy work** (package, render, long plays, tests) goes through Studio's job queue: one at a
  time, with cancel and generous timeouts (a first cook can take a long time).
- **Agent**: unreal-engineer.
- **Skills**: unreal-essentials (load first), unreal-python, unreal-blueprints, unreal-levels,
  unreal-packaging.
- **Gates**:
  - `unreal-project`: levels load, Blueprints compile.
  - `unreal-package`: a current packaged build exists.
  - `unreal-automation`: the project's Automation tests pass.

## Where things go

A project made by the tool:

- `<dir>/.studio/project.json`: Studio's project file. The builds and playtests are recorded in it.
- `<dir>/Game/<Name>.uproject`: the Unreal project.
- `<dir>/Builds/b<n>/Windows/<Name>.exe`: packaged builds.
- `<dir>/.studio/playtests/<id>/`: `report.json`, `frames/`, `profile.csv` and `game.log`.

Run logs, captures and renders go to `.harness/unreal/<kind>/<id>/`.

The helpers `harness_ue.py`, `harness_step.py` and `harness_capture_game.py` are copied into the
project's `Content/Python`, so `import harness_ue` also works in the editor's own Python console.

`play` and `package` put a `BP_HarnessDriver` and a `HarnessCamera` in the default level. Both are
inert unless the game starts with `-HarnessTimeline`.

## Safety

- Unreal runs on this machine, outside any sandbox (there is no sandbox image for it).
- The tool only starts its own processes, on projects in the workspace. It never closes, attaches
  to or changes an editor the person opened, unless they ask and give its port to
  `bridge.connect`.
- Remote Control on a launched editor binds to 127.0.0.1, on ports of its own.
- Games and the bridge editor open windows (the bridge renders off screen by default).

## Worked examples

**"Make a small third-person game: collect 10 coins, then reach the exit"**:

1. `project.create {name: "CoinEscape"}`.
2. A `script` that calls `h.coin_game_kit()` and `h.build_level({...})` with the coins on a route
   (unreal-levels), then `h.set_default_maps(...)`.
3. `capture` from above, and look at the frame.
4. `test` with checks for the counts.
5. `package`.
6. `play {seconds: 12, inputs: [{at: 300, key: "W", ms: 9500}], expect: ["win"]}`.
7. Report the build, the fps, the memory and the frames.

**"Use the crate I modelled in Blender"**: `asset.import {files: ["assets/crate.glb"], dest:
"/Game/Imported/Crate"}`, then a script that spawns StaticMeshActors with the imported mesh, then
`capture`.

**"Let the AI player try the level"**: `play.start {watch: ["/Game/CoinKit/BP_Coin.BP_Coin_C"]}`.
Then repeat `play.step {keys: ["W"], ms: 500}`, looking at each frame and state, then `play.stop`.

<!-- generated -->
