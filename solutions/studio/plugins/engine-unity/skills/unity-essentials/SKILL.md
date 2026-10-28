---
name: unity-essentials
description: Making and checking Unity 6 games with the unity tool - detect, project.create from a template (3D URP, 2.5D, 2D URP, built-in 3D), the project layout, levels from grid layouts, scripts headless or live in the open editor, captures you look at, and the order to verify things in. Use whenever the user wants a Unity game or project, or the workspace has a Unity project (Packages/manifest.json beside Assets/).
---
# Unity essentials

Unity runs on the host where Unity Hub is (a server folder session, or the companion on the person's computer), never in a sandbox. Everything goes through the `unity` tool. Heavy runs (opening, building, testing, playing) take one at a time and can take minutes: the first open of a new project imports everything and takes longest.

## First: detect

`{"action": "detect"}` lists the Hub, the editors (version, build modules, IL2CPP), the licence and the **gaps**. Gaps are the person's to fix in Unity Hub; say them plainly and do not try to work around them:

| Gap | What the person does |
|---|---|
| Unity Hub found, no editor installed | Unity Hub > Installs > Install Editor > a Unity 6 LTS (6000.x), with **Windows Build Support** (Mono; IL2CPP optional) and **WebGL Build Support** |
| license not activated | Unity Hub > sign in > Preferences > Licenses > Add (Personal is free) |
| no WebGL / Windows Build Support | Installs > the editor > Add modules |

Never install an editor, accept a EULA or sign in for them. Until an editor and a licence are there, `project.create` still writes the project files (and says it could not open them) and `describe` reads the files.

## Make a project

```json
{"action": "project.create", "project": "Game", "template": "3d-urp", "name": "Coin Escape", "genre": "collect-and-escape"}
```

Templates: `3d-urp` (the editor's Universal 3D template), `2.5d-urp` (the same, for an isometric orthographic camera), `2d-urp` (Universal 2D: the 2D renderer, sprites, tilemaps, the 2D packages), `3d-builtin` (built-in render pipeline). It also writes:

- `Packages/com.harness.bridge/`: the harness package (batch entry points, the live bridge, the runtime: `HarnessInput`, `HarnessState`, playback). Never edit it; it is reinstalled when it changes.
- `Assets/Tests/EditMode` and `Assets/Tests/PlayMode`: test assemblies with one passing test each (the unity-tests gate runs them). Add tests there.
- `.studio/project.json` (engine `unity`, the dimension, budgets), `.gitignore` (Library/, Temp/, Builds/ stay out).

Then it opens the project once headless (import, compile, product name, input handling set to Both, the main scene in the build).

Layout of a project:
```
Game/
  Assets/Scenes/          scenes (.unity); the first scene in the build is the one a player starts in
  Assets/Scripts/         game code (Assembly-CSharp), MonoBehaviours one per file, file name = class name
  Assets/Editor/          editor-only code; Assets/Editor/Harness/ holds scripts the unity tool runs
  Assets/Prefabs, Art, Models, Audio
  Assets/Harness/Generated/   materials, sprites and tiles the level builder makes
  Packages/manifest.json  the packages; Packages/com.harness.bridge the harness package
  ProjectSettings/        settings (ProjectVersion.txt names the editor version)
  Library/ Temp/ Logs/    Unity's caches: never edit, never commit
```

## Build a level from a layout (2D, 2.5D, 3D)

```json
{"action": "level.build", "layout": {
  "name": "Level1", "dimension": "3d", "cell": 2,
  "grid": [
    "##########",
    "#P..C...E#",
    "#.##.##..#",
    "#C..H..C.#",
    "##########"],
  "camera": {"mode": "follow"},
  "rules": {"timeLimitS": 120}
}}
```

Cells: `#` wall, `.` floor, `P` player, `C` collectible, `E` exit, `H` hazard, `=` platform, `S` spawn marker, space nothing. Extra things go in `objects`: `{"type": "prefab", "prefab": "Assets/Prefabs/Door.prefab", "position": [4, 0, 2]}`, `{"type": "light", "light": "point", "position": [..], "color": "#ffcc88"}`, `{"type": "sprite", "sprite": "Assets/Art/tree.png", "position": [3, 1]}`, `{"type": "primitive", "primitive": "Cylinder", ...}`, or any cell kind with a position. Camera modes: `follow` (3D, behind and above), `isometric` (2.5D: orthographic at 30/45 degrees, follows), `orthographic` (top-down), `perspective` (a fixed view of the whole level). In 2D the walls and platforms are a Tilemap with a TilemapCollider2D, the player a Rigidbody2D platformer (`HarnessPlayerController2D`, set `topDown` for top-down).

The scene comes with the rules (`HarnessGameRules`): pick up every collectible, then reach the exit (it turns green when open); hazards and falling send the player back. It publishes `score`, `collected`, `total`, `exitOpen`, `won`, `lost`, `player` (position) and events (`pickup`, `exit-open`, `win`, `hit`) that `play` and the AI player read. The level becomes the first scene in the build, and a capture of it comes back: **look at it**. Is the player visible, are the walls where the grid says, is it lit?

## Look at what you made

- `{"action": "capture", "scene": "Assets/Scenes/Level1.unity"}`: the game camera. `"view": "overview" | "iso" | "top" | "front" | "side"` frames the whole scene from an angle; `position`/`lookAt` place a camera. A blank frame is reported: fix the camera or the lights.
- `{"action": "render", "preset": "turntable", "frames": 12}` or `"preset": "views"`: a set of frames.
- `{"action": "describe"}`: settings, packages, the scenes in the build, assets by type, the hierarchy. `"offline": true` reads the files only.

## Scripts

`{"action": "script", "name": "AddTorches", "code": "..."}` writes C# into `Assets/Editor/Harness/AddTorches.cs` and runs `Harness.Scripts.AddTorches.Run()` (a body is wrapped for you, with the usual usings; `return` a value to see it). A whole file with a class works too. Compile errors come back with file and line; fix them and run again. Game code (MonoBehaviours) belongs in `Assets/Scripts/` (write it with the file tools), then `project.open` compiles it. See unity-csharp.

## Live, in the editor the person has open

When the person has the project open in Unity, the harness package starts a bridge on 127.0.0.1 (token in `Library/HarnessBridge/bridge.json`). `{"action": "bridge.connect"}` checks it; then every action works in that editor (`"live": false` forces headless, which fails anyway while the editor holds the project). The live ops through `{"action": "bridge.call", "op": ..., "args": {...}}`: `status`, `scene.hierarchy`, `scene.open/new/save`, `object.get/create/modify/delete`, `component.add/remove/get/set`, `prefab.create/instantiate`, `selection.get/set`, `assets.refresh`, `compile.status`, `script.invoke`, `layout.build`, `capture`, `console.read/clear`, `play.enter/exit/status/run/step/observe/state`, `tests.run`, `build`, `describe`. Every edit is on Undo (the person can Ctrl+Z it). The bridge refuses to throw away unsaved changes (save first, or pass `discard: true` when the person agreed).

## The order to verify things

1. `project.open` (compiles, errors with file and line) - the **unity-project** gate.
2. `capture` and look.
3. `test` (EditMode and PlayMode) - the **unity-tests** gate. See unity-build-test.
4. `play` with an input timeline: frames, fps, events, `won`.
5. `build` for win64 (and webgl) - the **unity-build** gate.

Nothing is done until it compiles, the tests pass, a play shows the goal reached, and it builds.
