extends Node3D
## The 3D template (engine-godot): a third-person collect-and-escape level - a sky, a sun with
## shadows, a floor, a capsule player that runs and jumps, coins, and an exit that opens when
## every coin is collected - with a follow camera and a score. Models from Blender go in
## assets/ (load("res://assets/x.glb").instantiate()). `-- --selftest` checks: moves,
## jumps, lands, collects, exit.

const SPEED := 5.0
const JUMP := 4.5

var player: CharacterBody3D
var cam: Camera3D
var exit_door: Area3D
var exit_mat: StandardMaterial3D
var coins: Array[Area3D] = []
var score := 0
var won := false
var label: Label
var ticks := 0
var start := Vector3.ZERO
var peak := 0.0
var gravity: float = ProjectSettings.get_setting("physics/3d/default_gravity", 9.8)

func _ready() -> void:
	var sky_mat := ProceduralSkyMaterial.new()
	var sky := Sky.new()
	sky.sky_material = sky_mat
	var env := WorldEnvironment.new()
	env.environment = Environment.new()
	env.environment.background_mode = Environment.BG_SKY
	env.environment.sky = sky
	env.environment.ambient_light_source = Environment.AMBIENT_SOURCE_SKY
	add_child(env)
	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-50, 30, 0)
	sun.shadow_enabled = true
	add_child(sun)

	var ground := StaticBody3D.new()
	ground.name = "Floor"
	var shape := CollisionShape3D.new()
	var box := BoxShape3D.new()
	box.size = Vector3(40, 1, 40)
	shape.shape = box
	shape.position.y = -0.5
	ground.add_child(shape)
	var mesh := MeshInstance3D.new()
	var plane := PlaneMesh.new()
	plane.size = Vector2(40, 40)
	mesh.mesh = plane
	mesh.material_override = _material(Color(0.35, 0.5, 0.3))
	ground.add_child(mesh)
	add_child(ground)

	player = CharacterBody3D.new()
	player.name = "Player"
	player.position = Vector3(0, 1, 0)
	player.add_to_group("player")
	var body := MeshInstance3D.new()
	body.mesh = CapsuleMesh.new()
	body.material_override = _material(Color(0.9, 0.3, 0.2))
	player.add_child(body)
	var col := CollisionShape3D.new()
	col.shape = CapsuleShape3D.new()
	player.add_child(col)
	add_child(player)

	for p in [Vector3(4, 0.8, -4), Vector3(-5, 0.8, -8), Vector3(6, 0.8, -12)]:
		_add_coin(p)
	exit_door = Area3D.new()
	exit_door.name = "Exit"
	exit_door.position = Vector3(0, 1, -16)
	var ecol := CollisionShape3D.new()
	var ebox := BoxShape3D.new()
	ebox.size = Vector3(2, 2, 0.5)
	ecol.shape = ebox
	exit_door.add_child(ecol)
	var emesh := MeshInstance3D.new()
	var door := BoxMesh.new()
	door.size = ebox.size
	emesh.mesh = door
	exit_mat = _material(Color(0.6, 0.15, 0.15))
	emesh.material_override = exit_mat
	exit_door.add_child(emesh)
	exit_door.body_entered.connect(_on_exit)
	add_child(exit_door)

	cam = Camera3D.new()
	cam.name = "Camera"
	add_child(cam)
	_follow()

	var ui := CanvasLayer.new()
	add_child(ui)
	label = Label.new()
	label.position = Vector2(12, 8)
	ui.add_child(label)
	_update_ui()
	StudioHook.expect(["moves", "jumps", "lands", "collects", "exit"])

func _material(c: Color) -> StandardMaterial3D:
	var m := StandardMaterial3D.new()
	m.albedo_color = c
	return m

func _add_coin(at: Vector3) -> void:
	var coin := Area3D.new()
	coin.name = "Coin%d" % coins.size()
	coin.position = at
	coin.add_to_group("coins")
	var shape := CollisionShape3D.new()
	var sphere := SphereShape3D.new()
	sphere.radius = 0.6
	shape.shape = sphere
	coin.add_child(shape)
	var mesh := MeshInstance3D.new()
	var disc := CylinderMesh.new()
	disc.top_radius = 0.4
	disc.bottom_radius = 0.4
	disc.height = 0.08
	mesh.mesh = disc
	mesh.rotation_degrees.x = 90
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
		exit_mat.albedo_color = Color(0.2, 0.8, 0.3)
		StudioHook.emit_event("exit-open", "")
	_update_ui()

func _on_exit(body: Node) -> void:
	if body == player and coins.is_empty() and not won:
		won = true
		StudioHook.emit_event("win", "reached the exit")
		_update_ui()

func _update_ui() -> void:
	label.text = "Coins: %d of %d%s" % [score, score + coins.size(), "   You escaped!" if won else ("   The exit is open" if coins.is_empty() else "")]

func _follow() -> void:
	cam.position = player.position + Vector3(0, 4, 7)
	cam.look_at(player.position + Vector3(0, 1, 0))

func _physics_process(delta: float) -> void:
	# The self-test first: an action it presses is "just pressed" in this same tick.
	ticks += 1
	if StudioHook.selftest:
		_selftest()
	var v := Input.get_vector("move_left", "move_right", "move_up", "move_down")
	player.velocity.x = v.x * SPEED
	player.velocity.z = v.y * SPEED
	if player.is_on_floor():
		if Input.is_action_just_pressed("jump"):
			player.velocity.y = JUMP
	else:
		player.velocity.y -= gravity * delta
	player.move_and_slide()
	for c in coins:
		c.rotate_y(delta * 2.0)
	_follow()
	StudioHook.set_state("player", [snappedf(player.position.x, 0.01), snappedf(player.position.y, 0.01), snappedf(player.position.z, 0.01)])
	StudioHook.set_state("onFloor", player.is_on_floor())
	StudioHook.set_state("score", score)
	StudioHook.set_state("coinsLeft", coins.size())
	StudioHook.set_state("won", won)
	peak = maxf(peak, player.position.y)

func _selftest() -> void:
	match ticks:
		30:
			start = player.position
			Input.action_press("move_up")
		60:
			StudioHook.check("moves", player.position.z < start.z - 1.5, "z went from %.2f to %.2f" % [start.z, player.position.z])
			Input.action_release("move_up")
			peak = player.position.y
			Input.action_press("jump")
		62:
			Input.action_release("jump")
		90:
			StudioHook.check("jumps", peak > start.y + 0.5, "peak %.2f" % peak)
		150:
			StudioHook.check("lands", player.is_on_floor(), "y %.2f" % player.position.y)
			player.position = coins[0].position
		156:
			player.position = coins[0].position
		162:
			player.position = coins[0].position
		168:
			StudioHook.check("collects", score == 3, "score %d" % score)
			player.position = exit_door.position
		176:
			StudioHook.check("exit", won, "won %s" % won)
