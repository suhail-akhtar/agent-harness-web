---
name: game-production
description: Producing a game with Studio from a brief to a packaged, playtested build - the make-game workflow's stages, gates and approvals, scope control, budgets, the asset plan, engine choice (web, Godot, Unreal), and the other production workflows (asset-pack, level-blockout, render-shot, port-game, playtest-loop). Use when planning or running a game production.
---
# Game production with Studio

## The make-game workflow

`make-game` {brief, engine: web | godot | unreal, dimension: 2d | 2.5d | 3d, genre, budget, sources, approval}. Unity is not covered yet.

| Stage | Who | Makes | Gate (loops back with the evidence) |
|---|---|---|---|
| plan | producer | .studio/project.json, design/production-plan.md | - |
| concept | game-designer | design/GDD.md | studio-project; the person approves |
| art | art-director | design/style-guide.md, design/asset-plan.json | the person approves |
| assets | technical-artist + audio-designer | .studio/assets/<id> | asset-plan, asset-manifest, asset-budget, asset-2d, asset-3d, audio-valid, level-playable |
| prototype | game-engineer | the graybox game | web: web-game, game-starts, no-softlock; godot: godot-project, godot-selftest, game-starts, no-softlock; unreal: unreal-project, unreal-automation |
| playtest | playtester | a bot playtest | playtest-pass |
| vertical-slice | game-engineer | one level at final look | the engine's gates; the person approves |
| content | level-designer, ui-designer | levels, screens, sound wiring | level-playable + the engine's gates |
| polish | game-engineer | juice, performance | the engine's gates + playtest-pass |
| build | build-engineer | the package | web-build, godot-export, unreal-package |
| full-playtest | playtester | bots + the AI player on the build | playtest-pass, playtest-regressions; the person approves |
| report | producer | docs/studio-report.md | - |

Each gate has an attempt limit (3); a stage that keeps failing ends the run "failed" with the evidence. `approval: "auto"` skips the person's checkpoints (evals, unattended runs).

## Scope control

- One core loop, one level type, three levels for a first version. Everything else goes on the cut list in design/production-plan.md.
- Start from a template: web `studio_template` (platformer-2d, topdown-2d, puzzle-2d, iso-2.5d, sidescroller-2.5d, thirdperson-3d, firstperson-3d); Godot `godot project.create` (2d, 2.5d, 3d); Unreal `unreal project.create` (third person, first person, top down, side-scroller).
- Retire the biggest risk first: the prototype stage proves the core mechanic with a bot before any art is final.
- A stage is done when its gate passes, not when its agent says so.

## Budgets

- Performance: .studio/project.json budgets (fps 60, frameMs 16.7, memoryMb, trianglesPerAsset, textureMax); the asset-budget gate and playtest metrics check them.
- Spend: procedural assets cost nothing; CC0 sources cost nothing but need the operator to enable them; paid generators (studio_source image, text3d) have spend caps. The `sources` input says what is allowed.
- Time: Unreal packaging takes minutes, a first Godot export a minute; plan one build per stage at most.

## Engine choice

- web: quickest, plays anywhere, every template has bots that win; Canvas for 2D and iso, Three.js for 2.5D and 3D.
- godot: full small games, 2D to mid 3D, small exports (Windows, Web, Linux); its driver lets the bots play it.
- unreal: high-end 3D, Blueprints and Python (no C++ without the MSVC toolchain), Blender models; its driver plays packaged builds.

## The other workflows

- `asset-pack` {brief, count, dimension, style, engine}: a consistent set from one style guide, reviewed as a set.
- `level-blockout` {brief, engine, kind}: a beat sheet, a level proven finishable, wired in, finished by a bot.
- `render-shot` {subject, engine, frames}: a planned shot rendered in Blender, Godot or Unreal and reviewed.
- `port-game` {target}: the same game in another engine, reusing the assets and the bots' checks.
- `playtest-loop` {goal}: play, file, fix, replay until it passes (three rounds at most).
- `build-game` and `model-3d`: the short paths (a game from an idea; a model from a description).

## Files Studio keeps

plugins/games3d/sdk/FORMATS.md has every field: .studio/project.json (stages, builds, playtests), .studio/assets/<id>/asset.json, .studio/playtests/<id>/report.json, .studio/recordings and .studio/regressions.
