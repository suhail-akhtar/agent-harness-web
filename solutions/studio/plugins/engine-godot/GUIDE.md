---
name: engine-godot-guide
description: Godot 4 for Studio - install it, make 2D, 2.5D and 3D games from templates, test, play with inputs, step a live game for the AI player, build for Windows and the Web, and work in an open editor.
---

# Godot (engine-godot)

## What it is for

Godot 4 games in the workspace, end to end: a project from a template, the code, tests that prove
the rules, play-throughs with scripted inputs and frames, metrics, and builds the person can run.
Use it when the person asks for a Godot game or project, a 2D or 2.5D game, or the workspace has a
project.godot. It is part of Studio (the games3d plugin) and works with engine-blender for art.

## How work runs

- **One tool, `godot`, with an `action`.** Everything runs where the session's commands run (the
  server folder, a sandbox, a companion), on a project folder with project.godot.
- **Look first:** `detect` (version, export templates, gaps), `describe` (scene tree, input map,
  autoloads), `check`.
- **Make:** `project.create` (`template`: 2d, 2.5d, 3d), then edit `scripts/main.gd`; `script`
  (GDScript headless); `asset.import` (models and Studio assets), `asset.export` (.glb).
- **Prove:** `test` (tests/test_*.gd and test scenes, structured results; `selftest: true` adds
  the game's own self-test), `play` (seconds, an input timeline, frames every k frames, fps, frame
  times, memory, errors, the game's state and events), `capture`, `render`.
- **For the AI player:** `step.start`, then `step` with inputs and a frame count (the next frame
  and the state come back), `step.state`, `step.stop`. One live Godot per session.
- **Ship:** `build` (`platform`: windows, web, linux), `package` (a zip), `export` (a preset).
- **Heavy jobs** (install, build, package, play, test, render) run one at a time: `jobs`,
  `job.cancel`.
- **Install** (`install`) downloads the official Godot 4 build and its Windows, Web and Linux export
  templates from Godot's GitHub releases into the harness's engines folder, checking SHA-512 sums.
  It is a command the person is asked about. Nothing else downloaded is ever run.
- **The person's editor:** `bridge.install` puts the Harness Bridge EditorPlugin in the project;
  once it is on in their editor, `describe`, `script` and `capture` with `live: true`, and
  `bridge.call` (tree, add_node, set, remove, run, save, open, play, stop, capture). Local only
  (127.0.0.1, a token).
- **Gates:** `godot-project` (imports, loads, runs 30 frames), `godot-selftest` (SELFTEST PASS),
  `godot-export` (each preset builds).
- **Agent:** godot-engineer. **Skills:** godot-essentials, godot-2d, godot-gdscript-testing.

## Worked examples

**"Make a small top-down 2D game in Godot where you collect coins"**: `detect`; if Godot is
missing, ask and `install`; `project.create` with template 2d; change `scripts/main.gd`; `test`;
`play` 5 seconds holding move_right and look at the frames; `build` for windows and web.

**"Is my Godot game running well?"**: `describe`, then `play` 10 seconds with typical inputs and
`uncapped: true`; report fps, frame time p95, memory and errors against `.studio/project.json`
budgets, with the frames that show problems.

**"Play the game and tell me if the level can be finished"**: `step.start`, then `step` with
inputs and 10-30 frames at a time, reading the frame and `state` after each step, until the goal
or a dead end; `step.stop`.

**"Use the robot from Blender as the player in my isometric game"**: in Blender (engine-blender)
`sprites` with 8 directions; then `asset.import` with the asset id; load it with
`SpriteSheet.load_frames` on an AnimatedSprite3D (godot-2d).
