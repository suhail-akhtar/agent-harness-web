---
name: godot-gdscript-testing
description: Testing a Godot 4 game with the godot tool - GDScript test files (GUT-style asserts, before_each, awaiting frames), test scenes, the game's --selftest through StudioHook, scripted play-throughs with an input timeline as regression tests, and reading the structured results. Use when adding tests to a Godot project, fixing a failing test, or proving a rule of the game holds.
---
# Testing Godot games

Three layers, cheapest first. All of them run headless with `--fixed-fps 60`: deterministic, faster than real time.

## 1. Test files: `{"action": "test", "project": "game"}`
Files named `res://tests/test_*.gd` (or `*_test.gd`) that extend the base class the tool ships (it adds `addons/harness_test/test_case.gd` when a project lacks it; the templates have it):
```gdscript
extends "res://addons/harness_test/test_case.gd"

var main: Node

func before_each() -> void:
	main = add_scene("res://scenes/main.tscn")   # freed after each test
	await wait_physics(2)                        # let _ready and the first physics run

func test_move_right_moves_the_player() -> void:
	var x0: float = main.player.position.x
	press("move_right")                          # through the real input path
	await wait_physics(30)
	release("move_right")
	assert_gt(main.player.position.x, x0 + 20.0, "holding move_right moves the player")

func test_a_coin_scores() -> void:
	main.player.position = main.coins[0].position
	await wait_physics(4)
	assert_eq(main.score, 1)
```
- Every `test_*` method is a test; `before_all`, `before_each`, `after_each`, `after_all` around them.
- Asserts: `assert_true`, `assert_false`, `assert_eq(got, want)`, `assert_ne`, `assert_almost_eq(got, want, eps)` (numbers and vectors), `assert_gt`, `assert_lt`, `assert_null`, `assert_not_null`, `assert_has(container, value)`, `fail(msg)`, `pending(why)` (skipped).
- Waiting: `await wait_frames(n)`, `await wait_physics(n)`, `await wait_seconds(s)`. Physics moves bodies, so wait physics ticks after pressing.
- `press(action)` / `release(action)` go through `Input.parse_input_event` like a real key. Press, then wait at least one physics tick before checking.
- The project's autoloads (StudioHook...) are there, as in the game.
- A script error or `push_error` during a test fails it (with the file and line).
- `filter` runs only tests whose name or file contains it; `dir` changes the folder.

Results come back as data: one entry per test with `status` (passed, failed, skipped), `failures` ({message, file, line}), `asserts` and `ms`, plus a summary. Fix the first failure, run again.

## 2. Test scenes
`res://tests/test_*.tscn` whose root has `signal test_finished(passed: bool, message: String)`: the runner adds the scene, waits up to 600 frames (`sceneFrames`) for the signal, and records it. Use one for a whole situation (a level loads, an enemy reaches the player) that is easier to set up in a scene than in code.

## 3. The game's self-test: `-- --selftest`
The game drives itself and checks its rules with StudioHook (godot-essentials): `StudioHook.expect([...])`, `StudioHook.check(name, ok, detail)`, then `SELFTEST PASS`. It runs in the gate `godot-selftest`, in `{"action": "test", "selftest": true}` as one more result, and inside an exported build (`game.exe --headless --quit-after 600 -- --selftest`), which proves the build too. Cover the core loop: move, the main mechanic, score, lose, win, restart.

## Play-throughs as regression tests
`{"action": "play", "seconds": 8, "headless": true, "inputs": [{"t": 0, "action": "move_right", "hold": 2}, {"t": 2.2, "action": "jump"}]}` returns the final `state` (from `StudioHook.set_state`) and the `events`; with frames (no `headless`) it also saves screenshots to look at. Keep important timelines in the repository (e.g. `tests/playthroughs/level1.json`) and compare the end state with what the design says ("score 5, won true"). With fixed fps the same inputs give the same result every time: a changed outcome is a real change.

## Writing testable game code
- Keep game state in plain variables on the main node or a small model object (`score`, `coins`, `player`), so tests and StudioHook can read them.
- No `randomize()` in tests: seed with `seed(1234)` under `--selftest` and in `before_each`.
- Keep scene building in `_ready` (the templates do): `add_scene()` then gives the whole level.
- Report problems with `push_error`, not `print`: tools, gates and tests count errors.
