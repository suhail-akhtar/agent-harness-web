---
name: unreal-packaging
description: Packaging an Unreal Engine 5.8 Blueprint project for Win64 without a C++ compiler (RunUAT BuildCookRun with the precompiled game), what makes it fail (runtime plugins, editor-only plugin content), Development versus Shipping, sizes and times, and proving the build with scripted plays. Use before package or when a build fails.
---
# Packaging (Win64, Blueprint only)

`{"action": "package"}` runs `RunUAT BuildCookRun -platform=Win64 -clientconfig=Development -cook -stage -pak -archive` into `<studio>/Builds/b<n>/` as a heavy job (`jobs` shows the stage and cook progress) and records the build in `.studio/project.json`. No `-build`: a content-only project runs on the engine's precompiled `UnrealGame`, so no compiler is needed. `{"action": "build"}` only cooks (a quick check that content cooks).

Measured on this machine (5.8.4, a third-person project with a small level, warm shared DDC): about 1.7-3 min, 913 MB archived (Development), 570 cooked packages. The first cook on a machine compiles shaders into the shared DDC and takes longer.

## Why a Blueprint project fails to package

- **"X.uproject is has no code, but is being treated as a code-based project ... because: P plugin is enabled."** A plugin that is not on by default and has runtime modules makes UBT build a game target, which needs a compiler. The tool's projects limit Python, Remote Control, Editor Scripting, Movie Render Queue and the template's `GameplayStateTree` to `"TargetAllowList": ["Editor"]` in the .uproject. Do the same for any plugin you enable that the game does not need at run time; a plugin the game needs at run time means C++ (or a precompiled plugin).
- **"Failed to cook /MovieRenderPipeline/... imports type ... in a module that is not available"**: editor-only plugin content. Projects get `+DirectoriesToNeverCook=(Path="/MovieRenderPipeline")` in `DefaultGame.ini`; add other editor plugin mount points the same way.
- A level or Blueprint that does not compile fails the cook: run the `unreal-project` gate first.
- Template variants with AI (StateTree) keep `GameplayStateTree` on for the game: they need a toolchain.

## Development or Shipping

- Development: logs, the console, `PrintString` on screen, the CSV profiler, Enhanced Input's `Input.+key` cheat commands. **Scripted plays need Development** (`play` uses them).
- Shipping: smaller and faster, no console, no logs, no cheats: package it last for release.

## Proving the build

```json
{"action": "play", "seconds": 12, "inputs": [{"at": 300, "key": "W", "ms": 9500}], "captureEveryMs": 1500, "expect": ["win"]}
```

The packaged game starts with `-HarnessTimeline="<ms>|<console command>;..."`; the play driver in the default level (put there by `package`) runs it: `Input.+key W` / `Input.-key W` hold keys through Enhanced Input, `HighResShot` takes frames into `Saved/Screenshots`, `CsvProfile Start/Stop` profiles, `quit` ends it. The driver ignores mouse look while scripted, so the real mouse over the window cannot turn the player. The report has fps (average and the 1% low, which includes the frames a capture stalls), frame ms p95, memory, errors, and the game's `HARNESS_EVENT` events. Measured: the packaged coin game started in 2.7 s, collected 10 coins and won in 9.2 s, 73.7 fps average, 1518 MB.

The `unreal-package` gate passes when the latest build exists and no content changed after it.
