extends Node2D
## The 2D template (engine-godot): a top-down level on a TileMapLayer with stone walls, a
## player animated from the hero sprite sheet (assets/hero, an AnimatedSprite2D), coins to
## collect, a score and a win. The scene file is one node: everything is built here.
## Run with `-- --selftest` and the game drives itself through the real input path and checks
## its rules (StudioHook.check): moves, animates, walls, collects.

const SpriteSheet := preload("res://harness/sprite_sheet.gd")
const TILE := 16
const W := 40
const H := 22
const SPEED := 120.0

var player: CharacterBody2D
var sprite: AnimatedSprite2D
var tiles: TileMapLayer
var coins: Array[Area2D] = []
var score := 0
var won := false
var label: Label
var ticks := 0
var start_x := 0.0

func _ready() -> void:
	_build_tiles()
	_build_player(Vector2(6 * TILE, 11 * TILE))
	for i in 5:
		_add_coin(Vector2((12 + i * 5) * TILE, (5 + (i % 3) * 5) * TILE))
	var ui := CanvasLayer.new()
	add_child(ui)
	label = Label.new()
	label.position = Vector2(8, 4)
	ui.add_child(label)
	_update_ui()
	StudioHook.expect(["moves", "animates", "walls", "collects"])

func _build_tiles() -> void:
	var ts := TileSet.new()
	ts.tile_size = Vector2i(TILE, TILE)
	ts.add_physics_layer()
	var src := TileSetAtlasSource.new()
	src.texture = load("res://assets/tiles/tiles.png")
	src.texture_region_size = Vector2i(TILE, TILE)
	for x in 3:
		src.create_tile(Vector2i(x, 0))
	ts.add_source(src, 0)
	# The stone tile (2, 0) blocks: a square collision polygon on physics layer 0.
	var stone := src.get_tile_data(Vector2i(2, 0), 0)
	stone.add_collision_polygon(0)
	stone.set_collision_polygon_points(0, 0, PackedVector2Array([Vector2(-8, -8), Vector2(8, -8), Vector2(8, 8), Vector2(-8, 8)]))
	tiles = TileMapLayer.new()
	tiles.name = "Tiles"
	tiles.tile_set = ts
	add_child(tiles)
	for y in H:
		for x in W:
			var edge := x == 0 or y == 0 or x == W - 1 or y == H - 1
			var cell := Vector2i(2, 0) if edge else (Vector2i(1, 0) if y == 11 else Vector2i(0, 0))
			tiles.set_cell(Vector2i(x, y), 0, cell)

func _build_player(at: Vector2) -> void:
	player = CharacterBody2D.new()
	player.name = "Player"
	player.position = at
	player.motion_mode = CharacterBody2D.MOTION_MODE_FLOATING
	player.add_to_group("player")
	sprite = AnimatedSprite2D.new()
	sprite.name = "Sprite"
	sprite.sprite_frames = SpriteSheet.load_frames("res://assets/hero")
	sprite.play("idle")
	player.add_child(sprite)
	var shape := CollisionShape2D.new()
	var box := RectangleShape2D.new()
	box.size = Vector2(12, 12)
	shape.shape = box
	player.add_child(shape)
	add_child(player)
	var cam := Camera2D.new()
	cam.limit_left = 0
	cam.limit_top = 0
	cam.limit_right = W * TILE
	cam.limit_bottom = H * TILE
	player.add_child(cam)

func _add_coin(at: Vector2) -> void:
	var coin := Area2D.new()
	coin.name = "Coin%d" % coins.size()
	coin.position = at
	coin.add_to_group("coins")
	var shape := CollisionShape2D.new()
	var circle := CircleShape2D.new()
	circle.radius = 6
	shape.shape = circle
	coin.add_child(shape)
	var disc := Polygon2D.new()
	var pts := PackedVector2Array()
	for i in 16:
		pts.append(Vector2.from_angle(TAU * i / 16.0) * 6.0)
	disc.polygon = pts
	disc.color = Color(1, 0.8, 0.2)
	coin.add_child(disc)
	coin.body_entered.connect(_on_coin.bind(coin))
	add_child(coin)
	coins.append(coin)

func _on_coin(body: Node, coin: Area2D) -> void:
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

func _physics_process(_delta: float) -> void:
	var dir := Input.get_vector("move_left", "move_right", "move_up", "move_down")
	player.velocity = dir * SPEED
	player.move_and_slide()
	if dir != Vector2.ZERO:
		sprite.play("walk")
		sprite.flip_h = dir.x < 0
	else:
		sprite.play("idle")
	StudioHook.set_state("player", [roundf(player.position.x), roundf(player.position.y)])
	StudioHook.set_state("score", score)
	StudioHook.set_state("coinsLeft", coins.size())
	StudioHook.set_state("won", won)
	# Where the AI player's bots should head: the coins still there (positions in pixels).
	StudioHook.set_state("targets", coins.map(func(c): return [c.position.x, c.position.y]))
	ticks += 1
	if StudioHook.selftest:
		_selftest()

## The self-test: real inputs, then a check of what they did.
func _selftest() -> void:
	match ticks:
		1:
			start_x = player.position.x
			Input.action_press("move_right")
		31:
			StudioHook.check("moves", player.position.x > start_x + 20, "x went from %.0f to %.0f" % [start_x, player.position.x])
			StudioHook.check("animates", sprite.animation == "walk" and sprite.is_playing(), "animation %s" % sprite.animation)
			Input.action_release("move_right")
			Input.action_press("move_left")
		181:
			# Three seconds left into the wall: the stone tiles stop the player.
			StudioHook.check("walls", player.position.x >= TILE + 5, "x = %.1f" % player.position.x)
			Input.action_release("move_left")
			player.position = coins[0].position
		190:
			StudioHook.check("collects", score == 1, "score %d" % score)
