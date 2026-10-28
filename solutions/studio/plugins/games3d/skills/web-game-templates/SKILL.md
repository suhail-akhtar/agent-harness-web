---
name: web-game-templates
description: Studio's seven web game templates (platformer-2d, topdown-2d, puzzle-2d, iso-2.5d, sidescroller-2.5d, thirdperson-3d, firstperson-3d) - creating one with studio_template, its files, game.json (assets, levels, tuning, controls), the shared engine (scenes, input map, assets, sound, platformer physics, grid paths, the 3D kit), the window.__game hook the bots read, and building it. Use when making or changing a browser game.
---
# Web game templates

## Create

`studio_template {"action": "list"}`, then `studio_template {"action": "create", "template": "platformer-2d", "title": "Coin Hop"}`. It writes, in the workspace root (or `project`):

- `index.html`: a canvas (`data-webgl` for 3D, with an import map for vendor/three) and `src/main.js`;
- `game.json`: the game's settings (below);
- `src/main.js`: the gameplay, one file;
- `src/engine/`: the shared engine (do not fork it per game);
- `vendor/three/` for the Three.js templates (offline);
- `.studio/project.json` (engine web, template, entry index.html);
- the template's Studio assets, built with studio_sprite, studio_procgen and studio_audio, under the ids game.json names. Ids that exist already are kept, so assets made from an asset plan win.

| Template | Dimension | Play | Levels |
|---|---|---|---|
| platformer-2d | 2D | run, jump, coins, walkers, spikes, pits, exit | studio_procgen platformer (solver-proven) |
| topdown-2d | 2D | explore, sword, monsters, chests, stairs | dungeon, cave, maze |
| puzzle-2d | 2D | grid steps, gems, keys and doors, boulders into holes, undo | rows in game.json, mazes |
| iso-2.5d | 2.5D | isometric overworld with height, chests, slimes, portal | topdown maps |
| sidescroller-2.5d | 2.5D | the platformer in Three.js with 3D layers | platformer |
| thirdperson-3d | 3D | courtyards, coins, spike balls, exit door, follow camera | rows, dungeons, caves, mazes |
| firstperson-3d | 3D | halls, mouse look, coins, drones to zap, exit | rows, mazes |

## game.json

```json
{
  "title": "Coin Hop", "template": "platformer-2d", "dimension": "2d", "genre": "platformer",
  "help": "Arrows/WASD move - Space jumps",
  "controls": { "jump": ["Space", "KeyZ"] },
  "assets": { "player": "asset:hero-sheet", "sounds": { "jump": "asset:sfx-jump" }, "music": "asset:music-loop" },
  "levels": ["asset:level-1", "asset:level-2"],
  "physics": { "jumpHeight": 3.2, "runSpeed": 6, "gravity": 40 },
  "tuning": { "lives": 0, "coinScore": 10 }
}
```

- `"asset:<id>"` is `.studio/assets/<id>/`, read through its asset.json. A plain path is a file in the game's folder. A missing asset is a console warning and a drawn fallback; the web-game gate fails on it.
- `levels`: level assets, in order; win after the last one. Platformer levels carry their physics (the solver's), and `physics` overrides them for the whole game.
- `lives: 0` means unlimited retries from a checkpoint: the bots never meet a game over. Set lives for a classic game over.

## The engine (src/engine/)

- `core.js`: the Game (a fixed 60 Hz update, drawing every frame), scenes (`standardScenes`: loading, title, play, paused, won, gameover), `emit(type, detail)` events, `expose(fn)` → window.__game, the seeded `game.random`, and the `?seed=`, `?autostart=1` and `?level=` query options.
- `input.js`: the InputMap (actions → KeyboardEvent.code; held, pressed, released, axis; the mouse with movement). `input.botOrder` sets the keys the bots may press.
- `assets.js`: loadSheet (sheet.png + frames JSON) and the Animator, loadLevel (level.json rows, or a Tiled .tmj), loadImage, loadParallax, loadModel; `missing` lists what did not load.
- `audio.js`: Sound (WebAudio; play, startMusic, toggleMute; silent where there is no audio).
- `draw.js`: text, card, hud, Shake, Particles, drawParallax, drawTile.
- `platformer.js`: tile physics matching studio_procgen's solver (stepBody, hazard, stepWalker).
- `grid.js`: Grid (rows), path and reachable (BFS), waypoint (where to head next), moveCircle (sliding collision).
- `three-kit.js`: renderer, DOM overlay, buildGridWorld (walls, platforms, coins, hazards, exit), moveCharacter, tileTexture, model (glTF).

## The hook the player reads

window.__game: state (loading, title, play, paused, won, gameover), player {x, y[, z]}, score, lives, coins or collected and total, `targets` (one point: where to head next, a waypoint on the shortest path, or the next coin), exitOpen, won, lost, level, levels, flags, events, inputs (the bot's keys), controls. Keep it true when you change the gameplay: bots, playtests and gates read it.

## Change a template

1. Change game.json (title, tuning, levels, controls, assets).
2. Change src/main.js: the play scene's update and draw, and the expose() fields.
3. Play it: game_bot {"mode": "goal"} must reach the goal, and game_play frames must look right.
4. Gates: web-game, game-starts, no-softlock, then game_playtest for playtest-pass.

## Build

`studio_template {"action": "build"}` → build/web/ (only the assets game.json names) and build/<title>-web.zip, recorded in .studio/project.json builds; the web-build gate boots it offline. To let the person play it: `studio_template {"action": "play"}` gives a link (served on this computer); never a file:// path, and no server of your own.
