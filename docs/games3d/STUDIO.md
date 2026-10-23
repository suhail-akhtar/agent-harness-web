# Studio: games and 3D, end to end (plan)

Status: **planned, not started.** Built in phases, each closing with tests and a live check.

Studio is the module for 3D and games: modeling, materials, rigging and animation, rendering, levels, gameplay code, builds, playtests and packaging, across Blender, Godot, Unreal Engine, Unity and the web (Three.js). Agents drive every bit of it through typed operations, the same ones the person's UI calls. It grows out of `plugins/games3d`, which already has:

- **Tools:** `blender` (bpy scripts, headless renders, .blend, glTF/FBX export), `godot` (check, run, screenshot, export, self-test), `model_info`.
- **Gates:** `gltf-valid`, `model-preview`, `blender-file`, `godot-project`, `godot-selftest`.
- **Workflows:** `build-game` (Canvas/Three.js; `engine=godot`), `model-3d` (`engine=blender`).
- **Agents:** game-designer, game-engineer, 3d-artist, art-director, playtester. Skills for each engine. A 3D sandbox image (`docker/Dockerfile.sandbox-3d`).

## What is on this machine (2026-10-23)

| Engine | Found | Notes |
|---|---|---|
| Unreal Engine 5.8 | `D:\UnrealEngine\UE_5.8` | PythonScriptPlugin and RemoteControl ship with it. **No Visual Studio C++ toolchain**, so C++ projects cannot compile yet. Blueprint and Python projects work. C++ needs VS 2022 with the "Game development with C++" workload (the person installs it). |
| Blender 4.2 | `C:\Program Files\Blender Foundation\Blender 4.2` | Used today, headless. |
| Godot 4 | not on PATH | The sandbox image has it; a host install or a download into `~/.harness/engines` (with permission). |
| Unity | not yet | The person is installing it. Phase 3. |

## Shape: one module, engines as plugins

Everything stays a plugin and can be switched off.

- **`games3d` (Studio core):** projects, the asset library, the pipeline, gates, agents, workflows, the desktop module (menu, home, guide, viewers). It holds no engine code. It talks to engines through one contract.
- **Engine plugins:** `engine-blender`, `engine-godot`, `engine-unreal`, `engine-unity`, `engine-web`. Each one implements the contract, brings its own skills, gates and agent guide, and can be off without breaking the others. A project names its engine. With that engine off, the project opens read-only with the note "Made with Unreal, which is off" (the plugin-off rules).

### The engine contract (`EngineAdapter`)

```
detect()          -> installs, versions, toolchain gaps (e.g. "no MSVC")
project.create(template, name) / open / describe   (scene tree, assets, settings)
script.run(code | file, { live?: boolean })        (headless or in the open editor)
asset.import(file, options) / asset.export(id, format)
scene.capture({ camera?, size })                   -> PNG (viewport or rendered)
render({ preset, frames? })                        -> images or video
build({ config, platform }) / package(...)         -> artifact + log
test.run({ filter })                               -> structured results
play({ inputs, seconds })                          -> frames, logs, metrics (fps, memory)
bridge.connect() / status() / events               (live editor link)
```

Every call has a timeout, a log the person can open, and a structured result agents can read. Heavy work (render, build, cook, bake) goes through one **GPU/CPU job queue** with progress, cancel and a concurrency of one per engine by default.

### Two ways into each engine

1. **Headless (first, always works):** command-line runs that open the project, do the work, save it and exit. This is reproducible and testable in CI.
2. **Live bridge (second):** a small add-on inside the running editor, so the agent works in the editor the person is looking at. The person sees changes as they happen, and the agent sees the selection and the viewport.

| Engine | Headless | Live bridge | Build and test |
|---|---|---|---|
| Blender | `blender -b -P script.py` (exists) | an add-on with a local socket server that runs operators and streams the viewport | renders via Cycles/EEVEE; checks in Python |
| Godot 4 | `godot --headless` (exists) | an EditorPlugin with a WebSocket server: scene tree, nodes, GDScript, play-in-editor | `--export-release`; GUT or self-test scenes |
| Unreal 5.8 | `UnrealEditor-Cmd.exe -run=pythonscript` with the `unreal` Python API (assets, levels, actors, Blueprints, materials) | the Remote Control API (HTTP/WebSocket) plus editor Python: actors, properties, functions, presets, live viewport | `RunUAT BuildCookRun`; Automation tests (`-ExecCmds="Automation RunTests …"`); Movie Render Queue; Unreal Insights traces |
| Unity | `Unity.exe -batchmode -projectPath … -executeMethod …` | a UPM package with an editor-side server: scene, GameObjects, components, C# scripts, play mode | `BuildPipeline`; Unity Test Framework (edit and play mode) |
| Web | Vite + Three.js (exists) | the desktop preview pane | headless browser self-test (exists) |

Unreal C++ uses UBT and Live Coding once the MSVC toolchain is present. Until then, the adapter reports the gap and stays on Blueprints and Python.

## Asset pipeline

- **Library:** `~/.harness/assets` (shared) plus each project's own folder. Every asset has a manifest: source, license, author, generator and prompt, hashes, and the engines it was imported into.
- **Sources:**
  - procedural (Blender and Geometry Nodes scripts);
  - imports (glTF, FBX, OBJ, USD, textures, audio);
  - CC0 libraries the person enables (Poly Haven, ambientCG, Kenney), with licenses recorded;
  - optional generator plugins for image, texture, 3D and audio, as providers the person switches on. Nothing is generated or downloaded without its plugin and permission.
- **Processing:** Blender is the conversion hub. The steps are:
  - scale and axis normalization (meters, Z-up versus Y-up per engine);
  - naming;
  - UV and normal checks;
  - LODs and decimation;
  - texture baking (normal, AO, ORM);
  - power-of-two resize;
  - compression (KTX2/Basis, Draco or meshopt for the web).
- **Gates:**
  - poly and texture budgets per target;
  - manifold and normals checks;
  - UVs present;
  - PBR channel sanity;
  - consistent scale;
  - a preview turntable rendered and looked at by a vision model ("does this look like a wooden barrel?");
  - import into the target engine without errors.

## Rendering

- Turntables, beauty shots and look-dev presets (studio, outdoor, night) in Blender (Cycles and EEVEE), Unreal (Movie Render Queue) and Godot.
- Render jobs run through the queue. Results land in the project and in artifacts.
- The desktop gallery compares renders side by side.

## Building a game end to end

**The studio workflow (`make-game`):**

1. Brief
2. Game design document (mechanics, loop, controls, art direction, scope)
3. Prototype (graybox level and core mechanic)
4. Vertical slice (one level, final-quality look)
5. Content (levels, assets, audio, UI)
6. Polish (juice, performance budget)
7. Package (Win64 first)
8. Playtest report

Every step has gates and a checkpoint where the person approves, comments or redirects.

**Agents:**

| Role | Agents |
|---|---|
| Leads | producer (plan, scope, budget) and game designer |
| Level and art | level designer, art director, technical artist (shaders, materials, the pipeline), 3D artist, animator (Rigify, retargeting) |
| Engineering | gameplay engineer, plus one specialist per engine (`unreal-engineer`, `godot-engineer`, `unity-engineer`, `blender-artist`) that knows its APIs |
| Audio, UI and builds | audio designer, UI designer, build engineer |
| Testing | QA and playtester |

Agents can use different providers when the person allows it (the multi-agent rules that already exist).

**Other workflows:**

- `model-3d`, `asset-pack` (a consistent set: a style guide, then N assets), `level-blockout`, `render-shot`;
- `port-game` (for example, Godot to Unreal, reusing assets and redoing the code);
- `playtest-loop`, which plays, finds issues, fixes them and plays again.

**Playtesting with proof:**

- Scripted input playback and bots run the game for N seconds.
- Frames are captured and judged by a vision model against the design ("the player reaches the door").
- Logs and crash dumps are parsed, and fps, frame time, memory and draw calls are checked against budgets.
- Nothing is called done without a passing build, passing tests and a playtest.

## Desktop module

- **Menu:** Studio > Projects, Assets, Scenes, Renders, Builds, Playtests, Engines.
- **Home page:** recent projects, running jobs, engine status and toolchain gaps, "start a game" and "make a model".
- **Viewers, rendered in chat and artifacts:**
  - an interactive 3D viewer for glTF (orbit, wireframe, UV and normals views, LOD switch);
  - a turntable player and a render gallery;
  - the scene outline as a tree, and the live editor viewport (frames from the bridge);
  - build logs with errors linked to files;
  - the playtest timeline with frames, events and metrics charts;
  - a design-document page.
- Everything has a typed operation (`studio.project.create`, `studio.asset.import`, `studio.render`, `studio.build`, `studio.play` and so on), listed in the module guide, so agents know what exists and how to use it.

## Safety and cost

- **Permissions:** engines run on the host (Unreal and Unity have no sandbox image), behind permission rules: project folders only, no shell outside the adapter, and no installs or downloads without asking.
- **People's own steps:** EULAs, Unity license activation and store accounts are always the person's to accept. The agent never accepts them.
- **Disk:** Unreal projects are large. Studio shows sizes, keeps the DDC and intermediates in known places, and offers cleanups (never deletes on its own).
- **Jobs:** one heavy job per engine at a time, with timeouts and cancel. A crashed editor is detected and restarted, and the work resumes from the last saved step.
- **Spend:** vision checks run on frames sampled by budget; the existing spend caps apply.

## Phases

### Phase 1: the contract, Unreal, and the Studio module

- Split out the `EngineAdapter` contract. Move the existing Blender, Godot and web code into `engine-blender`, `engine-godot` and `engine-web` without changing behaviour, and re-test them on this machine. This is the "more tested and verified" step for what already exists.
- `engine-unreal`, covering:
  - detection (5.8, toolchain gaps);
  - project from a template (Blueprint third-person or first-person);
  - editor Python (levels, actors, assets, materials, Blueprint graph edits through the Python APIs);
  - importing FBX and glTF from Blender;
  - captures and Movie Render Queue shots;
  - Automation tests;
  - `BuildCookRun` packaging for Win64;
  - the Remote Control live bridge to the open editor.
- The asset library v1 (manifest, licenses, Blender to Unreal and Godot), with the procedural source and the CC0 library sources.
- The Studio desktop module: home, Projects, Assets with the 3D viewer, Builds and Engines.
- **Done means:**
  - From one prompt, an agent team makes a small Unreal game: a third-person level, collectibles, a score UI and a win condition, with Blender-made assets. It packages for Win64, then plays it, and the playtest passes.
  - The same brief works in Godot.
  - Unit tests run with fake engines; real-engine tests run behind `HARNESS_REAL_UNREAL=1` and `HARNESS_REAL_BLENDER=1`.
  - There is an Electron e2e test, and a live run with Sonnet 5.5 and DeepSeek flash.

### Phase 2: live editors and the full pipeline

- The Blender and Godot live bridges.
- The full asset processing (LODs, bakes, compression), all the gates, the CC0 library sources and the optional generator plugins.
- The rendering presets and the gallery.
- The animation basics (Rigify, retargeting to the Unreal and Godot skeletons).
- **Done means:** a 10-asset consistent pack is made, validated and imported into Unreal, Godot and the web, and a cinematic shot is rendered in Blender and in Unreal.

### Phase 3: Unity and porting

- `engine-unity`: Hub detection, batch mode, the UPM bridge package, C# scripts, tests and builds.
- The `port-game` workflow.
- Audio and UI systems across the engines.
- **Done means:** the Phase 1 game is ported to Unity, and the Godot version is ported to Unreal.

### Phase 4: production studio

- The full `make-game` workflow with checkpoints.
- Vision playtesting with budgets, and profiling (Unreal Insights, the Godot profiler, the Unity Profiler).
- Multi-platform packaging where the toolchains exist.
- C++ in Unreal once MSVC is installed.
- A live eval suite (`evals/games3d`) scored by hidden checks.
- **Done means:** a multi-level game goes from brief to package, with a playtest report, under a stated spend.

## Decisions (2026-10-23)

1. **First game (Phase 1):** a third-person collect-and-escape game. One level, collectibles, a score UI, a win condition and an exit door, with Blender-made props. Built in Unreal and in Godot.
2. **Unreal:** Blueprints and Python first. C++ (VS 2022, Live Coding) comes in Phase 4, or as soon as the toolchain is installed.
3. **Godot:** the adapter downloads the official Godot 4 build into `~/.harness/engines` after asking once.
4. **Asset sources: all of them, each an optional plugin:**
   - procedural (Blender and Geometry Nodes scripts) as the default;
   - CC0 libraries (Poly Haven, ambientCG, Kenney) with licences recorded;
   - image and texture generation;
   - text-to-3D generation (drafts, cleaned up in Blender and checked by the gates).

   The pipeline wiring and the procedural and CC0 sources are Phase 1. The generator providers are Phase 2.
