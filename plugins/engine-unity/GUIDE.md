---
name: engine-unity-guide
description: Unity 6 games for Studio - projects from templates, levels, C# headless or in the open editor, assets, captures, tests, play with inputs, Windows and WebGL builds.
---

# Unity (engine-unity)

## What it is for

Making and proving Unity games (2D, 2.5D, 3D) from the harness: everything the Studio engine
contract offers, through one tool, `unity`. Use it when the person asks for a Unity game, when a
Studio project's engine is `unity` (`.studio/project.json`), or when the workspace has a Unity
project (`Packages/manifest.json` beside `Assets/`). Load the `unity-essentials` skill first; the
`unity-engineer` agent does whole jobs.

## Where Unity runs, and what the person does

Unity runs on the host where Unity Hub is: a session on a server folder, or the companion on the
person's computer. It never runs in a sandbox (no Linux image, and it needs the person's licence).
The person installs and activates; the harness never does:

1. Unity Hub > Installs > Install Editor: the newest **Unity 6 LTS (6000.x)**, with the modules
   **Windows Build Support (Mono)** (IL2CPP optional; it also needs Visual Studio's C++ workload)
   and **WebGL Build Support**.
2. Unity Hub > sign in > Preferences > Licenses > **Add** (Personal is free).

`{"action": "detect"}` says what is missing (the gaps) and what is there: the Hub, each editor's
version, modules, IL2CPP, templates, and the licence status.

## The actions

| Action | What it does |
|---|---|
| `detect`, `install` | Find Unity; `install` only says what to install in the Hub |
| `project.create` | A project from the editor's template (`3d-urp`, `2.5d-urp`, `2d-urp`, `3d-builtin`) or a minimal one, the bridge package, test assemblies, `.gitignore`, `.studio/project.json`; opened once headless |
| `project.open` | Import and compile: errors with file and line |
| `describe` | Settings, packages, build scenes, assets by type, the hierarchy (`offline: true` from the files) |
| `script` | C# into `Assets/Editor/Harness/` and run (headless, or live) |
| `asset.import` / `asset.export` | Files into `Assets/` with import settings (sprites, slicing, models, glTF through glTFast, audio); export unitypackage, prefab, FBX, glTF |
| `capture`, `render` | A PNG (the game camera, or framed views); a turntable or views; the Unity Recorder in play mode when installed |
| `level.build` | A scene from a grid layout with collect-and-escape rules (2D tilemaps, 2.5D isometric, 3D) |
| `test` | EditMode and PlayMode tests: counts and failures with file and line |
| `build`, `package` | Win64 or WebGL players with the build report; `package` adds a zip; recorded in `.studio/project.json` |
| `play` | N seconds with an input timeline: frames, fps, memory, draw calls, events, the game's state; a Studio playtest |
| `bridge.connect`, `bridge.status`, `bridge.call` | The live editor |

Heavy work (opening, building, testing, playing) goes through Studio's job queue, one Unity at a
time; each run's log is kept in `.harness/unity/runs/<id>/unity.log` (named in the result).

## The bridge package (com.harness.bridge)

Installed into the project's `Packages/` folder (an embedded package; stable `.meta` GUIDs).

- **Batch entry points** (`-executeMethod Harness.Bridge.Batch.<Name> -harnessArgs a.json -harnessResult r.json`):
  `Check`, `ConfigureProject`, `BuildLevelFromLayout`, `ImportAssets`, `ExportAssets`, `Capture`,
  `Render`, `RunTests`, `Build`, `Describe`, `RunScript`, `Play`, `AddPackages`.
- **The live bridge**: when the editor opens the project, a server starts on 127.0.0.1 only, with
  a random token in `Library/HarnessBridge/bridge.json` (the project's own Library folder, which is
  never committed). It accepts a fixed menu of typed operations (scene, objects, components,
  prefabs, selection, compile status, play mode, captures, the console, tests, builds); code runs
  only as scripts written into `Assets/`, compiled like any other. Edits are on Undo; unsaved
  changes are never discarded without `discard: true`.
- **The runtime** (in players too, inert unless the harness starts it): `HarnessInput` (keys and
  axes the harness can drive, beside the real devices and the Input System), `HarnessState`
  (values and events the game publishes), `HarnessPlayback` (timelines with frames and metrics; the
  step mode), and the collect-and-escape components the level builder uses. A player starts the
  runtime bridge only when launched with `-harnessBridgeFile` (localhost, token from that file).

## The AI player

`plugins/engine-unity/driver.mjs`: `createDriver(host, { project, mode: 'player' | 'editor', build })`
gives `start`, `step({ keys, press, axes, frames })`, `act`, `observe` and `stop`; each answer has
the frame (PNG), the state and the events. The game is paused between steps.

## Gates

`unity-project` (compiles), `unity-tests` (EditMode and PlayMode pass), `unity-build` (a player
builds). Without an editor or a licence they report "not checked" instead of failing.
