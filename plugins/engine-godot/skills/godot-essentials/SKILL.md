---
name: godot-essentials
description: Godot 4 with the godot tool - detect and install Godot, start from a 2D, 2.5D or 3D template, the project as text files (project.godot, scenes built in code, GDScript, the input map, the StudioHook autoload), models from Blender, and proving it works headless (check, test, play with inputs, self-test) and building it for Windows and the Web. Use when the user asks for a Godot game or project, or the workspace has project.godot.
---
# Godot 4 essentials

The `godot` tool runs Godot where the session's commands run. Start with `{"action": "detect"}`: the version, where it is, whether export templates are there, and the gaps. If Godot is missing, `{"action": "install"}` downloads the official Godot 4 build and its export templates from Godot's GitHub releases into the harness's engines folder, checking every file against the release's SHA512-SUMS.txt (it asks the person first). Without Godot, say so and offer the browser path (game-architecture).

## Start from a template
`{"action": "project.create", "template": "2d" | "2.5d" | "3d", "project": "game", "name": "Coin Run"}` writes a runnable project and checks it (import plus its self-test):

| Template | What it is |
|---|---|
| `2d` | top-down level on a TileMapLayer with stone walls, a player animated from a sprite sheet (AnimatedSprite2D), coins, a score, a win. Pixel-art settings. See godot-2d. |
| `2.5d` | an isometric level: 3D blocks, an orthographic camera at the true isometric angle, a billboard sprite hero (AnimatedSprite3D) from the same sheet. See godot-2d. |
| `3d` | third-person collect-and-escape: sky, sun with shadows, floor, a capsule player that runs and jumps, coins, an exit that opens. |

Every template has: `project.godot` with an `[input]` map (move_left/right/up/down on WASD and the arrows, jump on Space, action on E/Enter), `scenes/main.tscn` (one node; the scene is built in `scripts/main.gd`), the `StudioHook` autoload (`harness/studio_hook.gd`), `tests/test_game.gd`, `export_presets.cfg` (Windows Desktop, Web, Linux) and `.gitignore`. It writes `.studio/project.json` when the workspace has none. Build the game by changing `scripts/main.gd`, not by starting over.

## The actions
| Action | Use |
|---|---|
| `check` | import, then load every script and scene: parse errors, type errors, missing resources. After every change. |
| `run` | N frames headless (`frames`, `args`): script errors. |
| `describe` | the scene tree after a few frames (code-built nodes included), the input actions, the autoloads, as data. |
| `script` | GDScript headless: lines run in `_initialize` with `root`, or a whole `extends SceneTree` script. Call `quit()` in a whole script. |
| `test` | the GDScript tests in `tests/` (godot-gdscript-testing); `selftest: true` adds the `--selftest` run. Structured results. |
| `play` | N `seconds` with an input timeline; a frame saved every `every` frames (you see some); metrics: fps, frame times, memory, draw calls, errors; the game's state and events from StudioHook. |
| `step.start`, `step`, `step.state`, `step.stop` | a live game advanced N frames at a time: send inputs, get the frame and the state back. For playing it yourself. |
| `capture` | one rendered frame you see (after N frames, optional inputs). `screenshot` does the same with Godot's movie writer. |
| `render` | N frames as PNGs, or an `.avi`. |
| `build` | `{"platform": "windows" \| "web" \| "linux"}` with the preset in export_presets.cfg (`createPreset: true` writes a missing one). `package` also zips it. `export` is the same with a preset name. |
| `asset.import` | a workspace file or a Studio asset (`.studio/assets/<id>`) into `assets/`, imported. |
| `asset.export` | the running scene as `.glb`. |
| `bridge.*` | the person's open editor (below). |

Inputs for `play`, `capture` and `step` are `[{t: seconds, action: "move_right", hold: 1.0}, {t: 2, key: "Space"}, {t: 3, key: "Space", up: true}, {t: 1, button: 1, x: 320, y: 200}]`: `down` (the default), `up`, or `hold` seconds. An action goes through `Input.parse_input_event`, exactly as a key bound to it would; a key goes through the input map. Time is game time at a fixed 60 frames per second (`realtime: true` for wall-clock).

Frames need a window: on Windows and macOS Godot opens one; in a Linux sandbox it draws on Xvfb (the 3D image has it). `headless: true` plays without frames, much faster, state only.

## StudioHook: the game's side of the contract
An autoload the templates have; add it to any project (copy `harness/studio_hook.gd`, register it under `[autoload]`).
```gdscript
StudioHook.set_state("score", score)          # what play/step report as the game's state
StudioHook.emit_event("pickup", "coin 3 of 5") # timed events for playtest reports
StudioHook.expect(["moves", "collects"])      # the self-test's checks
StudioHook.check("moves", player.position.x > start_x, "x = %.1f" % player.position.x)
if StudioHook.selftest: ...                    # true under `-- --selftest`
```
Keep `state` small and meaningful (positions, score, health, what is on screen): the AI player reads it every step.

## The self-test
Under `-- --selftest` the game drives itself through the real input path (`Input.action_press`, then wait physics ticks) and calls `StudioHook.check` for each rule. When every expected check passed it prints `SELFTEST PASS` and quits; a failed check is a `push_error`; unfinished after 590 frames is an error. Press actions at the **start** of `_physics_process`, before reading input, so `is_action_just_pressed` sees them that tick. The `godot-selftest` gate runs it; the `godot-project` gate runs check plus 30 frames; `godot-export` builds each preset.

## Writing the project as text
- `project.godot` is INI-like: keep `config_version=5`. Write the `[input]` section in Godot's own format (copy a template's), or add actions in code with `InputMap.add_action` and `InputMap.action_add_event`.
- Build scenes in code (`Node3D.new()`, `add_child`); a hand-written `.tscn` with sub-resources and ids is error-prone. Keep `main.tscn` one node with a script.
- GDScript indents with tabs. Type everything: `var speed: float = 4.0`, `var hits := 0`, `func hit(n: int) -> void:`.
- Callbacks: `_ready`, `_process(delta)`, `_physics_process(delta)` (move bodies here), `_unhandled_input(event)`.
- Signals: `signal died(score: int)`, `died.emit(score)`, `x.died.connect(_on_died)`; `await get_tree().create_timer(1.0).timeout`.
- `print()` goes to the output; `push_error()` is an error the tools and gates count.
- `.godot/` is Godot's cache (and the harness's scratch in `.godot/harness/`): never edit or commit it. Godot 4.4+ writes `*.uid` files beside scripts: keep them.
- Use `gl_compatibility` (the templates do) unless the game needs Forward+: it runs on every machine, the sandbox's CPU renderer and the web.

## Models from Blender
- Export `.glb` (blender-scripting: metres, the front on -Y in Blender becomes +Z in glTF), then `{"action": "asset.import", "file": "out/barrel.glb"}` or, for a Studio asset, `{"asset": "barrel-wood-01"}` (it records the res:// path in the asset.json).
- `load("res://assets/barrel.glb").instantiate()` gives a Node3D. Godot's forward is -Z: turn a character that walks forward with `rotation_degrees.y = 180`.
- Metals look black without something to reflect: a sky (`ProceduralSkyMaterial`) or lower metallic.

## Build
- `{"action": "build", "platform": "windows"}` writes `build/windows/game.exe` plus `game.pck`; `"web"` writes `build/web/index.html` with its `.js`, `.wasm` and `.pck` (no threads: any static server can host it); `"linux"` writes `build/linux/game.x86_64`. Builds need export templates for that Godot version (`install` brings Windows, Web and Linux ones; detect lists them).
- The presets keep `include_filter="assets/*.json"`: asset.json files are not resources, and the sprite loader needs them in the build.
- Each build is recorded in `.studio/project.json` (builds). Check a build by running it: `game.exe --headless --quit-after 600 -- --selftest`.

## The editor bridge
When the person has the project open in the Godot editor: `bridge.install` copies the Harness Bridge EditorPlugin into `addons/harness_bridge` and enables it; the person enables it in the open editor (Project > Project Settings > Plugins) or reopens the project. Then `bridge.status`, and `describe`, `script` (the body of `run(root, editor)`; return a value) and `capture` with `live: true`, or `bridge.call` with `tree`, `add_node` ({parent, type, name, props}), `set` ({path, props}), `remove`, `save`, `open`, `play`, `stop`. Changes go through the editor's undo; save with `save`. It listens on 127.0.0.1 only, with a token.

## Verify before you finish
1. `check` reports no problems.
2. `test` passes (add tests for each new rule; godot-gdscript-testing) and the self-test covers the core loop.
3. `play` a few seconds with the inputs a player would use and look at the frames: is the player visible, the camera right, the UI readable? Read the metrics against the budgets in `.studio/project.json`.
4. `build` for the targets asked for.
5. The `quality_gates` tool: `godot-project`, `godot-selftest` and `godot-export` must pass.
