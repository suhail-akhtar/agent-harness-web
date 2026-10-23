---
name: playtesting
description: What to test in a game and how to prove it with Studio's playtest tools - per genre (platformer, top-down, puzzle, shooter, racing) and per dimension (2D, 2.5D, 3D) - plus the state a game should expose, writing state checks, turning bugs into regressions, and reading a playtest report. Use when playtesting, doing QA, or making a game testable.
---
# Playtesting

## Make the game testable (ask the engineer for this)
`window.__game` (web) or the engine driver's state, all optional but each one unlocks a check:
- `state` ('title' | 'playing' | 'paused' | 'gameover' | 'won'), `player: {x, y, z?}`, `score`, `lives`, counters (`coins`, `gems`...) with `total`
- `targets: [{x, y, z?}]` (what to go to next: pickups, then the exit) - the goal bot follows them
- `won: true` when the goal is reached - playtests and the playtest-pass gate need it
- `inputs: ['ArrowLeft', ...]` the keys used (bots try exactly these), `controls: {jump: 'Space'}` named actions
- `events: [{type, detail}]` the game's own log (pickups, deaths, level changes)
- `?seed=N` and `?autostart=1` (Math.random is seeded by the player either way)

## The proof, in order
1. `game_playtest {"goal": "...", "checks": [...]}` - boot on the real clock (fps, errors, blank screen), then the goal, explore and monkey bots on the fixed clock, regressions, checks. Result pass / fail / crash, issues with evidence frames, a GIF, and `inputs-N.json` per bot that replays exactly.
2. Play it yourself with game_play (game-playing skill) and judge what bots cannot see; record verdicts.
3. Bugs become regressions: `game_bot {"mode": "scripted", "recording": ".studio/playtests/<id>/inputs-2.json", "saveAs": "coin-3-freeze", "expect": [{"path": "$softlocks", "op": ">", "value": 0, "when": "never"}]}`.
4. Gates: `game-starts`, `no-softlock`, `playtest-pass` (the latest report), `playtest-regressions`.

## Checks
`{"path": "coins", "op": ">=", "value": 5, "when": "ever"}` - ops `== != > >= < <= truthy falsy exists includes`; when `ever` (default), `end`, `always`, `never`. Run-level paths: `$errors`, `$crashed`, `$softlocks`, `$stuck`, `$goal`, `$t`. Examples: lives never below 0 (`{"path": "lives", "op": "<", "value": 0, "when": "never"}`), the player stays in the world (`{"path": "player.y", "op": "<", "value": 2000, "when": "always"}`).

## Per genre
- **Platformer:** every platform and pickup reachable (goal bot); jump height and run speed feel (play it); no falling through floors at speed (monkey, long runs); death and respawn; the camera keeps the player and the next ledge in view; coyote time / input buffering if jumps feel eaten.
- **Top-down / maze / RPG:** every room reachable (explore coverage); no sticking on corners (stuck events); doors and keys in either order; enemies that cannot trap the player in a corner forever.
- **Puzzle:** every level solvable (a scripted solution per level as a regression); undo/restart always works; no state where the puzzle is unsolvable without a restart unless the game says so; win detection is exact.
- **Shooter:** hit detection both ways; the fire rate; enemies spawn where they can be seen; a frame-rate check with many bullets (monkey for a while, then the fps in the report); score and ammo counters.
- **Racing:** a lap can be completed (goal bot on checkpoints as targets); no shortcut through walls; wrong-way detection; the timer; collisions at top speed.
- **Any genre:** title -> play -> lose -> restart -> win, pause and resume, every control does something, keys during game over, the window size, no console errors, the first ten seconds explain the goal.

## Per dimension
- **2D:** pixel positions; y down; frames are cheap - small frames are enough.
- **2.5D:** gameplay on a plane, art in 3D: test the plane's bounds, depth sorting (things drawn in the right order), and that the camera never hides the player.
- **3D:** positions in metres (x, z the ground plane); the camera (can the player see where to go; does it clip into walls); falling off the world (a `player.y` check); WebGL frames take longer - give bots fewer seconds or fewer frames; fps budgets matter more (the boot segment measures the real clock; headless rendering uses SwiftShader, slower than a GPU, so treat its fps as a floor).

## Reading a report
`.studio/playtests/<id>/report.json`: `result`, `goalReached` (and by whom), `metrics` (fpsAvg, fpsMin, frameMsP95 on the real clock; cpuFrameMs* on the fixed clock; errors), `events`, `crashes`, `stuck`, `issues` (severity, title, evidence frame, replay file), `verdicts` (state, vision, model, regression), `segments` (each player and its recording), `playthrough.gif`. A crash or softlock comes with the frame of the moment and the exact inputs that lead to it.
