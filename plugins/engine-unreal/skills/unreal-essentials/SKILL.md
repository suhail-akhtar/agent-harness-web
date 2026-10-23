---
name: unreal-essentials
description: How to make and prove an Unreal Engine 5 game with the unreal tool, Blueprint and Python first - detect, project.create from a Blueprint template, describe, editor Python, capture, test, package for Win64, play with scripted inputs or the step server, and the live bridge. Use whenever the work is in Unreal Engine (a .uproject, "Unreal", "UE5").
---
# Unreal Engine essentials

The `unreal` tool runs Unreal Engine on this machine (there is no sandbox image for it). Start with `{"action": "detect"}`: it says the version, where it is, and the gaps. On this kind of machine the usual gap is **no MSVC**: C++ cannot compile, so work in **Blueprints and Python** (the editor's Python drives everything; Blueprint graphs are built from Python with the 5.8 graph API). Never touch an editor or a project you did not start or make; the tool launches its own processes.

## The loop

| Step | Call | Notes |
|---|---|---|
| Project | `{"action": "project.create", "name": "CoinEscape", "template": "TP_ThirdPersonBP"}` | Templates: `TP_ThirdPersonBP`, `TP_FirstPersonBP`, `TP_TopDownBP`, `TP_BlankBP`. 2.5D: `"setup": "sidescroller"` (orthographic side camera, movement locked to the X-Z plane); 2D top-down view: `"setup": "topdown-2d"`. Makes `<dir>/Game/<Name>.uproject` and `<dir>/.studio/project.json`. Python, Remote Control and Movie Render Queue are on for the editor only (see unreal-packaging). Copying is instant; the first editor run of a project takes 30-90 s (shaders). |
| Look | `{"action": "describe"}` | Levels, the open level's actors (class, transform), assets by class, Blueprints (parent, variables with types and defaults, functions, components), the default map and game mode. The full JSON is written to the file it names. |
| Change | `{"action": "script", "code": "import harness_ue as h\n..."}` | Editor Python, headless (`-nullrhi`), 20-40 s per run. Put many changes in one script. `h.result("tag", data)` hands data back. A Python error fails the run with the file and line. Load **unreal-python**, **unreal-levels**, **unreal-blueprints**. |
| See | `{"action": "capture", "at": [-2600, -1700, 1300], "target": [0, 0, 0]}` | A rendered frame you see. `view: "game"` (default) is the game as played (HUD included), from `at`/`target` or the player's own view; `view: "editor"` is a scene capture of the level without play. Look at it: is the thing you made where you think, lit, the right size? |
| Prove | `{"action": "test", "filter": "Project.Functional Tests", "checks": "h.check('ten coins', len(h.find_actors(cls='/Game/CoinKit/BP_Coin')) == 10)"}` | Automation tests (structured from the JSON report) plus Python checks. |
| Ship | `{"action": "package"}` | RunUAT BuildCookRun for Win64 (Development; `config: "Shipping"` for a release): 2-5 min warm, longer the first time. Records the build in `.studio/project.json`. Load **unreal-packaging**. |
| Play | `{"action": "play", "seconds": 12, "inputs": [{"at": 300, "key": "W", "ms": 9500}], "captureEveryMs": 1500, "expect": ["win"]}` | Runs the latest build (or `"editor": true` for the editor's -game mode) with keys held on a timeline, frames, a CSV profile (fps, frame ms, memory), the log's errors and the game's `HARNESS_EVENT` lines; writes `.studio/playtests/<id>/report.json`. |
| AI player | `play.start`, then `play.step {"keys": ["W"], "ms": 500}` ... `play.stop` | The game waits paused between steps; each step returns a frame and the state (pawn location, velocity, game mode Score/Total, counts of watched classes). |
| Live | `bridge.connect`, `bridge.python {code}`, `bridge.call`, `bridge.property`, `bridge.disconnect` | Remote Control on an editor the tool launches (off screen by default, ports of its own, 127.0.0.1 only). `script` with `live: true` runs in it. Attaching to someone's own editor (`port`) only when they ask. |

## Rules that save time

- Units are centimetres, Z up; a character is about 180 cm tall, walks 500-600 cm/s and jumps about 120 cm. The engine cube (`/Engine/BasicShapes/Cube`) is 100 cm.
- Every level needs a PlayerStart, light (sun, sky light, sky atmosphere) and a floor; `h.build_level` adds them.
- Game events print `HARNESS_EVENT <type> <detail>` (PrintString to the log): plays and step sessions read them. The coin kit prints `score` and `win`.
- `play` and `package` put a **play driver** (`/Game/Harness/BP_HarnessDriver`) and a `HarnessCamera` in the default level. It is inert unless the game is started with `-HarnessTimeline`. Leave them there.
- Heavy work (package, render, long plays, tests) runs one at a time; `{"action": "jobs"}` shows the queue and the cook progress.
- When a call fails, read its Problems (with file and line) and the log file it names before retrying.
