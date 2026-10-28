extends "res://addons/harness_test/test_case.gd"
## Tests for the 2.5D template, run by the godot tool's test action (godot-gdscript-testing).

var main: Node

func before_each() -> void:
	main = add_scene("res://scenes/main.tscn")
	await wait_physics(2)

func test_camera_is_isometric() -> void:
	assert_eq(main.cam.projection, Camera3D.PROJECTION_ORTHOGONAL)
	assert_almost_eq(main.cam.rotation_degrees.y, 45.0, 0.01)

func test_hero_is_a_billboard_sprite() -> void:
	assert_true(main.sprite is AnimatedSprite3D)
	assert_has(main.sprite.sprite_frames.get_animation_names(), "walk")

func test_up_moves_up_the_screen() -> void:
	var p0: Vector3 = main.player.position
	press("move_up")
	await wait_physics(30)
	release("move_up")
	assert_lt(main.player.position.x, p0.x - 0.3)
	assert_lt(main.player.position.z, p0.z - 0.3)
