---
name: godot-essentials
description: A working Godot 4 project written as text files - project.godot, a one-node scene, GDScript that builds the scene, input, importing a .glb from Blender - and how to verify it headless with the godot tool (check, run with a self-test, screenshot, export). Use when the user asks for a Godot game or project.
---
# Godot 4 essentials

The `godot` tool runs Godot where the session's commands run (in a sandbox, the 3D image has Godot 4.7). If it says Godot is not installed, say so, and offer the browser path (game-architecture) instead.

| Action | What it does |
|---|---|
| `{"action": "check", "project": "game"}` | Imports the project, then loads every script and scene: parse errors, type errors, missing resources. Run after every change. |
| `{"action": "run", "project": "game", "frames": 120, "args": ["--selftest"]}` | Plays 120 frames headless at a fixed 60 per second (deterministic physics, faster than real time). Reports every `SCRIPT ERROR` and `push_error`. |
| `{"action": "screenshot", "project": "game", "frames": 60, "out": "shots/start.png"}` | Draws the frames with OpenGL (on the CPU in the sandbox) and saves the last one. You see it. |
| `{"action": "export", "project": "game", "preset": "Linux", "output": "build/linux/game.x86_64"}` | Builds with a preset from `export_presets.cfg`. Needs Godot's export templates (in a sandbox: the `harness-sandbox-3d:export` image, Linux and Web); without them it says so. Check, run and screenshot do not. |
| `{"action": "export", "project": "game", "createPreset": "web"}` | When `export_presets.cfg` has no such preset, writes a minimal one first (`"linux"`: x86_64, the .pck beside the binary, default output `build/linux/game.x86_64`; `"web"`: no threads, so any static server can host it, default `build/web/index.html`). Without `createPreset` a missing preset is an error that lists the ones there. |

The `godot-project` gate runs check plus 30 frames on every project.godot in the workspace. The `godot-selftest` gate runs each project with `-- --selftest` for up to 600 frames: it passes only when the game prints `SELFTEST PASS` and reports no errors (the `build-game` workflow with `engine=godot` runs both).

## Layout
```
game/
  project.godot          settings (text, INI-like)
  scenes/main.tscn       the main scene
  scripts/main.gd        builds the scene
  assets/model.glb       models (from the blender tool), textures, sounds
  .godot/                Godot's import cache: generated, never edit or commit
```
Godot 4.4+ writes a `*.uid` file beside each script: keep them. Paths inside the project are `res://...`.

## The template (tested headless: check, run --selftest, screenshot)
`project.godot` (gl_compatibility renders on any machine, the sandbox's CPU renderer included, and on the web):
```ini
; Godot 4 project file. Keep config_version=5.
config_version=5

[application]

config/name="Stool Viewer"
run/main_scene="res://scenes/main.tscn"

[display]

window/size/viewport_width=1280
window/size/viewport_height=720

[rendering]

renderer/rendering_method="gl_compatibility"
renderer/rendering_method.mobile="gl_compatibility"
```

`scenes/main.tscn` - one node with a script. Writing big .tscn files by hand is error-prone (ids, sub-resources); build the scene in code instead:
```
[gd_scene format=3]

[ext_resource type="Script" path="res://scripts/main.gd" id="1"]

[node name="Main" type="Node3D"]
script = ExtResource("1")
```

`scripts/main.gd` (GDScript indents with tabs):
```gdscript
extends Node3D
## The whole scene is built here, so the .tscn stays one line long: camera,
## light, environment, floor, a model from Blender, and a player you move.

const MODEL := "res://assets/stool.glb"  # any .glb in the project; Godot imports it

var player: CharacterBody3D
var selftest := "--selftest" in OS.get_cmdline_user_args()
var ticks := 0

func _ready() -> void:
	_add_key("left", KEY_LEFT)
	_add_key("right", KEY_RIGHT)
	_add_key("forward", KEY_UP)
	_add_key("back", KEY_DOWN)
	if selftest:
		Input.action_press("right")  # hold a key through the real input path

	var env := WorldEnvironment.new()
	env.environment = Environment.new()
	env.environment.background_mode = Environment.BG_COLOR
	env.environment.background_color = Color(0.55, 0.65, 0.8)
	env.environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.environment.ambient_light_color = Color(0.6, 0.6, 0.6)
	add_child(env)

	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-50, 30, 0)
	sun.shadow_enabled = true
	add_child(sun)

	var cam := Camera3D.new()
	cam.position = Vector3(0.6, 0.6, 1.0)
	add_child(cam)
	cam.look_at(Vector3(0, 0.3, 0))

	var ground := MeshInstance3D.new()
	var plane := PlaneMesh.new()
	plane.size = Vector2(4, 4)
	ground.mesh = plane
	add_child(ground)

	if ResourceLoader.exists(MODEL):
		var model: Node3D = load(MODEL).instantiate()
		model.name = "Model"
		add_child(model)
	else:
		push_error("missing model " + MODEL)  # an error the godot tool and gate report

	player = CharacterBody3D.new()
	player.name = "Player"
	var body := MeshInstance3D.new()
	var cube := BoxMesh.new()
	cube.size = Vector3(0.12, 0.12, 0.12)
	body.mesh = cube
	var mat := StandardMaterial3D.new()
	mat.albedo_color = Color(0.9, 0.3, 0.2)
	body.material_override = mat
	player.add_child(body)
	var shape := CollisionShape3D.new()
	shape.shape = BoxShape3D.new()
	shape.shape.size = cube.size
	player.add_child(shape)
	player.position = Vector3(-0.35, 0.06, 0.2)
	add_child(player)

func _physics_process(delta: float) -> void:
	var dir := Input.get_vector("left", "right", "forward", "back")
	player.velocity = Vector3(dir.x, 0, dir.y) * 1.5
	player.move_and_slide()
	player.rotate_y(delta * 2.0)
	ticks += 1
	if selftest and ticks == 30:
		# A failed check is push_error: the godot tool and the godot-project gate report it.
		if player.position.x < 0.0:
			push_error("selftest: holding right did not move the player (x = %.2f)" % player.position.x)
		else:
			print("SELFTEST PASS x = %.2f" % player.position.x)

## Input actions in code: no hand-written [input] section in project.godot.
func _add_key(action: String, key: Key) -> void:
	if not InputMap.has_action(action):
		InputMap.add_action(action)
	var ev := InputEventKey.new()
	ev.physical_keycode = key
	InputMap.action_add_event(action, ev)
```
For 2D: `extends Node2D`, `Camera2D`, `Sprite2D` / `_draw()` with `draw_rect`, `CharacterBody2D` with `move_and_slide()`, `Vector2` positions in pixels (y down).

## GDScript in brief
- Typed: `var speed: float = 4.0`, `var hits := 0` (inferred), `func hit(amount: int) -> void:`. Types catch mistakes at check time.
- `@export var speed := 4.0` shows in the inspector; `@onready var label: Label = $UI/Score` resolves a child when ready.
- Callbacks: `_ready()` once, `_process(delta)` every frame, `_physics_process(delta)` at the physics rate (move bodies here), `_unhandled_input(event)` for discrete key presses.
- Signals: `signal died(score: int)`, `died.emit(score)`, `enemy.died.connect(_on_enemy_died)`; timers: `await get_tree().create_timer(1.0).timeout`.
- Scenes: `var s := preload("res://scenes/enemy.tscn")`, `add_child(s.instantiate())`; groups: `add_to_group("enemies")`, `get_tree().get_nodes_in_group("enemies")`.
- Pause and restart: `get_tree().paused = true`, `get_tree().reload_current_scene()`.
- `print()` goes to the run output; `push_error()` is an error the tool and gate count; `assert()` too (debug runs).

## Models from Blender
- Export `.glb` (blender-scripting skill: metres, front -Y in Blender = +Z in glTF). Put it under `assets/`; the godot tool imports it before running. `load("res://assets/x.glb").instantiate()` gives a `Node3D` with the meshes and materials.
- Godot's forward is -Z. A glTF model's front (+Z) faces a camera placed in front of it at +Z; for a character that walks forward (-Z), turn it with `rotation_degrees.y = 180`.
- Metals look black in a plain environment (nothing to reflect): add a sky (`Environment.BG_SKY` with a `ProceduralSkyMaterial`) or lower metallic.

## Export
`export_presets.cfg` sits beside project.godot. A minimal Linux preset (what `createPreset: "linux"` writes; for the Web: `platform="Web"` with `variant/thread_support=false` under its options):
```ini
[preset.0]

name="Linux"
platform="Linux"
runnable=true
export_filter="all_resources"
export_path="../build/linux/game.x86_64"

[preset.0.options]

binary_format/embed_pck=false
binary_format/architecture="x86_64"
```
The Linux build is the binary plus `game.pck` beside it (`./game.x86_64 --headless --quit-after 60` runs it without a display); the Web build is `index.html` with its `.js`, `.wasm` and `.pck`, served by any static server.

## Verify before you finish
1. `check` until it reports no problems.
2. `run` with `args: ["--selftest"]`: the game drives itself (hold keys with `Input.action_press`, wait N physics ticks) and checks its own state with `push_error` on failure. Cover the core loop: move, score, lose, restart. Print `SELFTEST PASS` only after the last check held, within 600 frames (it may `get_tree().quit()` then); that line is what the `godot-selftest` gate waits for.
3. `screenshot` at the start and after a self-test (`args` work here too) and look: is the player visible, is the camera framing right, is the UI readable?
4. Run the `quality_gates` tool: `godot-project` must pass, and `godot-selftest` when the game has a `--selftest` mode.
