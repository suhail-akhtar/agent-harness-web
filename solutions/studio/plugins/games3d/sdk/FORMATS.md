# Studio file formats

Studio's parts and the engine plugins share these files. They all live in the workspace, so agents, gates and the desktop read the same thing. Paths are relative to the project folder, which is the folder holding `.studio/project.json`. A field may be added later; a field is never removed. The examples are JSON with `//` comments (test/studio-production.test.ts parses every one).

## `.studio/project.json`

```json
{
  "name": "Coin Escape",
  "engine": "unreal",            // "web" | "godot" | "unreal" | "unity" | "blender" (asset-only)
  "dimension": "3d",             // "2d" | "2.5d" | "3d"
  "genre": "third-person collect-and-escape",
  "created": "2026-10-23T10:00:00Z",
  "engineProject": "Game/CoinEscape.uproject",   // the engine's own project file (web: index.html)
  "entry": "index.html",         // web games: the page to play (the player and the gates read it)
  "template": "thirdperson-3d",  // web games: the studio_template it started from
  "design": "design/GDD.md",
  "budgets": { "fps": 60, "frameMs": 16.7, "memoryMb": 2048, "trianglesPerAsset": 20000, "textureMax": 2048 },
  "stages": [{ "id": "prototype", "title": "Prototype", "status": "done", "approvedAt": "...", "comments": [] }],
                                 // status: pending | active | review | done | approved | changes-requested | failed | skipped
  "builds": [{ "id": "b1", "platform": "win64", "path": "Builds/b1/CoinEscape.exe", "status": "ok", "at": "...", "engine": "unreal", "log": "...", "zip": "build/coin-escape-web.zip" }],
  "playtests": ["pt-20261023-1"],
  "playtest": { "bootSeconds": 5, "softlockSeconds": 30 }   // optional: the game-starts and no-softlock gates' times
}
```

## `.studio/assets/<id>/asset.json` (one folder per asset)

```json
{
  "id": "barrel-wood-01",
  "name": "Wooden barrel",
  "kind": "model",               // model | sprite | spritesheet | tileset | texture | material | audio | music | font | ui | level | heightmap | background | particles | icon | pack
  "dimension": "3d",             // 2d | 3d
  "files": [{ "path": "barrel.glb", "role": "main" }, { "path": "barrel_lod1.glb", "role": "lod1" }, { "path": "preview.png", "role": "preview" }],
                                 // roles: main, preview, lod1..., data (JSON), godot (.tres), tiled (.tmj/.tsj), level, tiles, layer, tile, variant, svg, splat
  "source": { "type": "procedural", "generator": "blender:barrel", "seed": 42, "params": {} },
                                 // type: procedural | import | library (provider, url, id) | generated (provider, model, prompt)
  "license": { "id": "CC0-1.0", "author": "Poly Haven", "url": "https://polyhaven.com/a/..." },
  "hashes": { "barrel.glb": "sha256:..." },
  "tags": ["prop", "wood"],
  "style": "stylized-lowpoly",
  "meta": { "triangles": 812, "sizeM": [0.6, 0.6, 0.9], "frames": 8, "frameSize": [32, 32], "tile": 16, "durationS": 0.4 },
  "checks": [{ "gate": "asset-budget", "pass": true, "summary": "812 tris <= 20000", "at": "..." }],
  "engines": { "unreal": { "path": "/Game/Assets/Barrel", "importedAt": "..." }, "godot": { "path": "res://assets/barrel.glb" } },
  "created": "...", "updated": "..."
}
```

A shared library lives in `~/.harness/assets/<id>/` with the same layout. An asset is copied into a project when it is used.

### Sprite sheet `meta`

A `spritesheet` is a grid of `frameSize` cells. Its frames are described by a frames JSON beside it (`sheet.frames.json`, below) and, from studio_sprite, an Aseprite JSON and a Godot SpriteFrames `.tres` too. The meta:

```json
{
  "frameSize": [32, 32],         // one cell, px
  "frames": 20,                  // cells used
  "columns": 6, "rows": 5,       // the grid (default: from the image size)
  "fps": 8,                      // the default rate
  "padding": 0,                  // px between cells
  "anims": { "idle": 4, "walk": 6 },          // studio_sprite: frames per row, one row per animation, in order
  "animations": { "walk_s": { "row": 0, "from": 0, "count": 8, "fps": 12, "loop": true } },
                                 // named runs of cells (what Godot's SpriteSheet.load_frames and the web Animator read)
  "directions": 8,               // sheets rendered from a model (studio_model sprites, blender sprites): views around it
  "directionNames": ["s", "sw", "w", "nw", "n", "ne", "e", "se"],
  "cellMetres": 1.6,             // world metres one cell spans (orthographic scale), for 2.5D placement
  "elevation": 30                // the camera's angle above the ground, degrees
}
```

`sheet.frames.json`: `{"image": "sheet.png", "width": 192, "height": 160, "frameWidth": 32, "frameHeight": 32, "animations": {"walk": {"fps": 8, "loop": true, "frames": [{"x": 0, "y": 32, "w": 32, "h": 32, "durationMs": 125}]}}}`.

### Other kinds' `meta`

- `tileset`: `tile` (px), `tiles`, `columns`, `rules` (autotile kind), `terrains`; iso tiles: `tileWidth`, `tileHeight`, `diamond`, `blockDepth`, `types`.
- `level`: `levelType` (platformer, dungeon, cave, maze, topdown, wfc), `width`, `height`, `tile`, and for platformers `physics` {jumpHeight, runSpeed, gravity}, `solvable`, `moves`, `coins`. The level.json has `rows` (characters; the legend in it), `start` and `exit` [x, y], and a `proof` (the solver's moves, or the path length).
- `background` (parallax): `size`, `layers`, `tileable`; parallax.json lists `layers` [{file, name, factor, driftPxPerSecond?}] back to front.
- `particles`: `frameSize`, `frames`, `kinds`. `icon`: `frameSize`, scaled copies and an SVG. `pack`: the ids of the assets in the pack.
- `audio` and `music`: `durationS`, `sampleRate`, `lufs`, `variants`; music `bpm`, `bars`, `chords`, `key`, `scale`, `loop`.

## `.studio/playtests/<id>/report.json`

```json
{
  "id": "pt-20261023-1",
  "engine": "web", "build": "b1", "game": "index.html", "query": "", "seed": 1,
  "player": "ai",                // ai | bot:random | bot:explore | bot:goal | bot:monkey | bot:scripted | person
  "players": ["bot:goal", "bot:explore", "ai"],
  "goal": "collect all coins and reach the exit",
  "goalReached": true, "goalReachedBy": "bot:goal",
  "result": "pass",               // pass | fail | crash | timeout
  "durationS": 94.2,
  "steps": 312,
  "events": [{ "t": 3.2, "type": "pickup", "detail": "coin 1/10", "segment": "bot:goal", "frame": "frames/0003.png" }, { "t": 40.1, "type": "stuck", "detail": "no progress for 8s" }],
  "metrics": { "fpsAvg": 59.8, "fpsMin": 41, "frameMsP95": 18.2, "cpuFrameMsAvg": 0.4, "memoryMb": 640, "errors": 0, "consoleErrors": 0, "fpsBudget": 60 },
  "series": { "fps": [[0, 60], [1, 59]] },
  "frames": ["frames/0000.png"], "recording": "playthrough.gif",
  "segments": [{ "player": "bot:goal", "mode": "goal", "clock": "fixed", "durationS": 31.2, "steps": 120, "coverage": 40, "goalReached": true, "crashed": false, "softlocks": 0, "stuck": 0, "recording": "inputs-2.json" }],
  "crashes": [], "stuck": [],
  "issues": [{ "severity": "major", "title": "Player can fall through floor at x=12", "evidence": "frames/0120.png", "replay": "inputs-2.json", "segment": "bot:explore" }],
                                 // severity: blocker | major | minor
  "verdicts": [{ "by": "vision", "claim": "the exit door opens after the last coin", "pass": true, "evidence": "frames/0301.png" }],
                                 // by: state (a check) | vision (an agent's judgement) | model (the vision judge) | regression
  "errors": [], "timedOut": false, "created": "...", "tookS": 41.3
}
```

`inputs-<n>.json` beside it is the segment's recording (below); `frames/` holds the evidence and sample frames; `playthrough.gif` the bot segments.

## Recordings (`.studio/recordings/<id>.json`)

game_play stop and game_bot save a run as `{summary, recording}`; game_bot mode scripted replays it exactly (the clock fixed, the same seed).

```json
{
  "summary": { "id": "bot-goal-x1", "player": "bot:goal", "engine": "web", "game": "index.html", "durationS": 31.2, "steps": 120, "goalReached": true, "crashed": false, "events": [], "errors": [], "coverage": { "cells": 40, "grid": 1.8 }, "metrics": {} },
  "recording": {
    "version": 1, "engine": "web", "game": "index.html", "query": "", "seed": 1, "clock": "fixed",
    "viewport": { "width": 960, "height": 600 }, "bootMs": 500, "durationMs": 31200,
    "events": [{ "t": 516.67, "type": "down", "key": "ArrowRight" }, { "t": 666.67, "type": "up", "key": "ArrowRight" }, { "t": 900, "type": "mousedown", "x": 120, "y": 80, "button": "left" }]
                                 // web: low-level events at game times (ms); type down | up | move | mousedown | mouseup
  }
}
```

An engine session (Godot, Unreal, Unity drivers) records steps instead of events: `{"version": 1, "engine": "godot", "game": "game", "project": "game", "seed": 1, "clock": "engine", "durationMs": 8300, "steps": [{"t": 500, "inputs": [{"key": "ArrowRight", "ms": 150}], "ms": 150}]}`.

Inputs everywhere: `{"key": "ArrowRight", "ms": 400}` holds a key (web key codes: ArrowLeft, KeyA, Space, Enter), `{"key": "Space"}` taps it, `{"key": "KeyX", "down": true}` / `{"up": true}`, `{"action": "jump"}` uses a named control (an input-map action in Godot), `{"mouse": [x, y], "click": true}` in the last frame's pixels, `"at": ms` delays one input within a step.

## Regressions (`.studio/regressions/<name>.json`)

game_bot with `saveAs` writes one; game_playtest (action regress, and every run) and the playtest-regressions gate replay them all.

```json
{
  "version": 1, "note": "softlock after the third coin", "created": "...",
  "recording": { "version": 1, "engine": "web", "game": "index.html", "seed": 1, "clock": "fixed", "durationMs": 9000, "events": [] },
  "expect": [
    { "path": "$softlocks", "op": ">", "value": 0, "when": "never", "claim": "$softlocks > 0 (never)" },
    { "path": "coins", "op": ">=", "value": 4, "when": "ever" }
  ]
}
```

A check is `{path, op, value, when, claim?}`: `path` dotted into the game's state ("player.x", "targets.length") or one of the run's own `$errors`, `$crashed`, `$softlocks`, `$stuck`, `$goal`, `$t`; `op` one of `== != > >= < <= truthy falsy exists includes`; `when` one of `ever` (default), `end`, `always`, `never`. The no-softlock gate saves its failures as `.studio/gates/no-softlock-<stamp>.json` in the same shape.

## The game's state (what the player reads)

Web games expose `window.__game`; engine drivers return the same fields (Godot: StudioHook.set_state, flattened, vectors as {x, y, z}): `state` | `mode` | `scene` (title, play, paused, won, gameover...), `player` {x, y, z?}, `score`, `lives`, `coins` | `collected` | `items` and `total`, `targets` [{x, y, z?}] (where to head next) or `target`, `exitOpen`, `won` | `done` | `complete`, `gameOver` | `lost`, `level`, `inputs` (the keys a bot may press), `controls` {action: key}, `events` [{type, detail}] (drained as it grows), `ready: false` or state "loading" while files load (the web driver waits for it).

## Web games: `game.json`

The Studio web templates (plugins/games3d/templates/web, studio_template) read it; the web-game gate checks it.

```json
{
  "title": "Coin Hop", "template": "platformer-2d", "dimension": "2d", "genre": "platformer",
  "help": "Arrows/WASD move - Space jumps",
  "controls": { "jump": ["Space", "KeyZ"] },   // an action's keys (KeyboardEvent.code), replacing the template's
  "assets": { "player": "asset:hero-sheet", "sounds": { "jump": "asset:sfx-jump" }, "music": "asset:music-loop" },
                                 // "asset:<id>" is .studio/assets/<id>/; other strings are paths in the game's folder
  "levels": ["asset:level-1", { "rows": ["#####", "#@*E#", "#####"] }],
  "physics": { "jumpHeight": 3.2, "runSpeed": 6, "gravity": 40 },
  "tuning": { "lives": 0, "coinScore": 10 }   // lives 0: unlimited retries from a checkpoint
}
```

## Production files (make-game)

- `design/GDD.md`: the design document (the studio-project gate checks its sections: pitch, core loop, controls, rules, scope).
- `design/production-plan.md`, `design/style-guide.md`.
- `design/asset-plan.json` (the asset-plan gate checks that every entry exists with its kind):

```json
{
  "style": "16-px pixel art, dark outline, warm light from the top left",
  "palette": ["#1e1e2a", "#f2c042", "#3d7fd0", "#c84a3a"],
  "assets": [
    { "id": "hero-sheet", "kind": "spritesheet", "tool": "studio_sprite", "input": { "action": "sheet", "kind": "character", "view": "side", "seed": 1 }, "purpose": "the player" },
    { "id": "level-1", "kind": "level", "tool": "studio_procgen", "input": { "action": "platformer", "seed": 3, "length": 48 }, "purpose": "the first level" }
  ]
}
```

- `build/web/` (studio_template build) with `build.json` `{builtAt, title, template, assets, missing, files}`.

## Jobs

`sdk/jobs.mjs` keeps them in memory: `listJobs()` returns `{ id, engine, title, status, queuedAt, startedAt?, endedAt? }`.
