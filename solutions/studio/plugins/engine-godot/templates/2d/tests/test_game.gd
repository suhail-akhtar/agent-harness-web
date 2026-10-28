extends "res://addons/harness_test/test_case.gd"
## Tests for the 2D template, run by the godot tool's test action (godot-gdscript-testing).

var main: Node

func before_each() -> void:
	main = add_scene("res://scenes/main.tscn")
	await wait_physics(2)

func test_starts_with_no_score() -> void:
	assert_eq(main.score, 0)
	assert_eq(main.coins.size(), 5, "five coins to collect")

func test_level_has_tiles_and_walls() -> void:
	var tiles: TileMapLayer = main.tiles
	assert_eq(tiles.get_used_cells().size(), 40 * 22, "a 40 x 22 tile level")
	assert_eq(tiles.get_cell_atlas_coords(Vector2i(0, 0)), Vector2i(2, 0), "the border is stone")

func test_move_right_moves_the_player() -> void:
	var x0: float = main.player.position.x
	press("move_right")
	await wait_physics(30)
	release("move_right")
	assert_gt(main.player.position.x, x0 + 20.0)
	assert_eq(main.sprite.animation, &"walk")

func test_a_coin_scores() -> void:
	main.player.position = main.coins[0].position
	await wait_physics(4)
	assert_eq(main.score, 1)
