extends "res://addons/harness_test/test_case.gd"
## Tests for the 3D template, run by the godot tool's test action (godot-gdscript-testing).

var main: Node

func before_each() -> void:
	main = add_scene("res://scenes/main.tscn")
	await wait_physics(20)

func test_player_stands_on_the_floor() -> void:
	assert_true(main.player.is_on_floor(), "after falling for a moment the player stands")

func test_jump_leaves_the_floor() -> void:
	var y0: float = main.player.position.y
	press("jump")
	await wait_physics(10)
	release("jump")
	assert_gt(main.player.position.y, y0 + 0.3)

func test_exit_opens_only_after_every_coin() -> void:
	main.player.position = main.exit_door.position
	await wait_physics(4)
	assert_false(main.won, "the exit is shut while coins are left")
