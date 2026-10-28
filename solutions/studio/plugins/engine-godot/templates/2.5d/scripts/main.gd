extends Node3D
## The 2.5D template (engine-godot): an isometric level - 3D blocks seen through an
## orthographic camera at the classic angle - with a billboard hero animated from the
## sprite sheet in assets/hero (an AnimatedSprite3D; the same sheet a 2D game uses, or one
## rendered from a 3D model by Blender's sprites action), coins, a score and a win.
## Movement follows the screen: up moves up the screen. `-- --selftest` checks: isometric,
## moves, animates, collects.

const SpriteSheet := preload("res://harness/sprite_sheet.gd")
const SIZE := 12
const SPEED := 3.0

var player: CharacterBody3D
var sprite: AnimatedSprite3D
var cam: Camera3D
var coins: Array[Area3D] = []
var score := 0
var won := false
var label: Label
var ticks := 0
var start := Vector3.ZERO
var gravity: float = ProjectSettings.get_setting("physics/3d/default_gravity", 9.8)

func _ready() -> void:
	var env := WorldEnvironment.new()
	env.environment = Environment.new()
	env.environment.background_mode = Environment.BG_COLOR
	env.environment.background_color = Color(0.16, 0.18, 0.24)
	env.environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.environment.ambient_light_color = Color(0.55, 0.55, 0.6)
	add_child(env)
	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-55, -30, 0)
	sun.shadow_enabled = true
	add_child(sun)

	_build_floor()
	for p in [Vector3(-3, 0.5, -2), Vector3(2, 0.5, 3), Vector3(4, 0.5, -4)]:
		_add_block(p)
	_build_player(Vector3(0, 0.6, 0))
	for p in [Vector3(3, 0.4, 0), Vector3(-4, 0.4, 3), Vector3(-2, 0.4, -5), Vector3(5, 0.4, 5)]:
		_add_coin(p)

	cam = Camera3D.new()
	cam.name = "Camera"
	cam.projection = Camera3D.PROJECTION_ORTHOGONAL
	cam.size = 14.0
	cam.rotation_degrees = Vector3(-35.264, 45, 0)  # true isometric
	add_child(cam)
	_follow()

	var ui := CanvasLayer.new()
	add_child(ui)
	label = Label.new()
	label.position = Vector2(12, 8)
	ui.add_child(label)
	_update_ui()
	StudioHook.expect(["isometric", "moves", "animates", "collects"])

func _material(c: Color) -> StandardMaterial3D:
	var m := StandardMaterial3D.new()
	m.albedo_color = c
	return m

func _build_floor() -> void:
	var body := StaticBody3D.new()
	body.name = "Floor"
	var shape := CollisionShape3D.new()
	var box := BoxShape3D.new()
	box.size = Vector3(SIZE * 2, 0.2, SIZE * 2)
	shape.shape = box
	shape.position.y = -0.1
	body.add_child(shape)
	# One MultiMesh for every floor tile: one draw call, a colour per tile.
	var tile := BoxMesh.new()
	tile.size = Vector3(1, 0.2, 1)
	var mat := StandardMaterial3D.new()
	mat.vertex_color_use_as_albedo = true
	tile.material = mat
	var mm := MultiMesh.new()
	mm.transform_format = MultiMesh.TRANSFORM_3D
	mm.use_colors = true
	mm.mesh = tile
	mm.instance_count = SIZE * SIZE * 4
	var i := 0
	for x in range(-SIZE, SIZE):
		for z in range(-SIZE, SIZE):
			mm.set_instance_transform(i, Transform3D(Basis(), Vector3(x + 0.5, -0.1, z + 0.5)))
			mm.set_instance_color(i, Color(0.45, 0.62, 0.42) if (x + z) % 2 == 0 else Color(0.38, 0.55, 0.36))
			i += 1
	var tiles := MultiMeshInstance3D.new()
	tiles.name = "Tiles"
	tiles.multimesh = mm
	body.add_child(tiles)
	add_child(body)

func _add_block(at: Vector3) -> void:
	var body := StaticBody3D.new()
	body.position = at
	var shape := CollisionShape3D.new()
	shape.shape = BoxShape3D.new()
	body.add_child(shape)
	var mesh := MeshInstance3D.new()
	mesh.mesh = BoxMesh.new()
	mesh.material_override = _material(Color(0.6, 0.55, 0.5))
	body.add_child(mesh)
	add_child(body)

func _build_player(at: Vector3) -> void:
	player = CharacterBody3D.new()
	player.name = "Player"
	player.position = at
	player.add_to_group("player")
	var shape := CollisionShape3D.new()
	var capsule := CapsuleShape3D.new()
	capsule.radius = 0.3
	capsule.height = 1.0
	shape.shape = capsule
	player.add_child(shape)
	sprite = AnimatedSprite3D.new()
	sprite.name = "Sprite"
	sprite.sprite_frames = SpriteSheet.load_frames("res://assets/hero")
	sprite.billboard = BaseMaterial3D.BILLBOARD_FIXED_Y
	sprite.texture_filter = BaseMaterial3D.TEXTURE_FILTER_NEAREST
	sprite.pixel_size = 1.0 / 24.0
	sprite.shaded = false
	sprite.alpha_cut = SpriteBase3D.ALPHA_CUT_DISCARD
	sprite.position.y = 0.2
	sprite.play("idle")
	player.add_child(sprite)
	add_child(player)

func _add_coin(at: Vector3) -> void:
	var coin := Area3D.new()
	coin.name = "Coin%d" % coins.size()
	coin.position = at
	coin.add_to_group("coins")
	var shape := CollisionShape3D.new()
	var sphere := SphereShape3D.new()
	sphere.radius = 0.35
	shape.shape = sphere
	coin.add_child(shape)
	var mesh := MeshInstance3D.new()
	var ball := SphereMesh.new()
	ball.radius = 0.2
	ball.height = 0.4
	mesh.mesh = ball
	mesh.material_override = _material(Color(1, 0.8, 0.2))
	coin.add_child(mesh)
	coin.body_entered.connect(_on_coin.bind(coin))
	add_child(coin)
	coins.append(coin)

func _on_coin(body: Node, coin: Area3D) -> void:
	if body != player or not coins.has(coin):
		return
	coins.erase(coin)
	coin.queue_free()
	score += 1
	StudioHook.emit_event("pickup", "coin %d of %d" % [score, score + coins.size()])
	if coins.is_empty():
		won = true
		StudioHook.emit_event("win", "every coin collected")
	_update_ui()

func _update_ui() -> void:
	label.text = "Coins: %d%s" % [score, "   You win!" if won else ""]

func _follow() -> void:
	cam.position = player.position + cam.basis.z * 20.0

## The screen's directions on the ground: right, and up the screen.
func _screen_dirs() -> Array[Vector3]:
	var right := Vector3(cam.basis.x.x, 0, cam.basis.x.z).normalized()
	var up := Vector3(-cam.basis.z.x, 0, -cam.basis.z.z).normalized()
	return [right, up]

func _physics_process(delta: float) -> void:
	var v := Input.get_vector("move_left", "move_right", "move_down", "move_up")
	var dirs := _screen_dirs()
	var dir := dirs[0] * v.x + dirs[1] * v.y
	player.velocity.x = dir.x * SPEED
	player.velocity.z = dir.z * SPEED
	if not player.is_on_floor():
		player.velocity.y -= gravity * delta
	player.move_and_slide()
	if v != Vector2.ZERO:
		sprite.play("walk")
		sprite.flip_h = v.x < 0
	else:
		sprite.play("idle")
	_follow()
	StudioHook.set_state("player", [snappedf(player.position.x, 0.01), snappedf(player.position.y, 0.01), snappedf(player.position.z, 0.01)])
	StudioHook.set_state("score", score)
	StudioHook.set_state("coinsLeft", coins.size())
	StudioHook.set_state("won", won)
	# Where the AI player's bots should head: the coins still there.
	StudioHook.set_state("targets", coins.map(func(c): return [c.position.x, c.position.y, c.position.z]))
	ticks += 1
	if StudioHook.selftest:
		_selftest()

func _selftest() -> void:
	match ticks:
		1:
			StudioHook.check("isometric", cam.projection == Camera3D.PROJECTION_ORTHOGONAL and absf(cam.rotation_degrees.y - 45) < 0.1)
			start = player.position
			Input.action_press("move_up")
		41:
			var moved := Vector2(player.position.x - start.x, player.position.z - start.z)
			# Up the screen is away from the camera: -x and -z at this angle.
			StudioHook.check("moves", moved.length() > 1.0 and moved.x < 0 and moved.y < 0, "moved %s" % moved)
			StudioHook.check("animates", sprite.animation == "walk" and sprite.is_playing())
			Input.action_release("move_up")
			player.position = coins[0].position + Vector3(0, 0.2, 0)
		50:
			StudioHook.check("collects", score == 1, "score %d" % score)
