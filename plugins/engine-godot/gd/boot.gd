extends Node
# Written by the harness (engine-godot) into .godot/harness/: the scene the godot tool's
# play, step, describe and test actions start instead of the main scene. It adds the
# harness controller under /root (beside the project's autoloads, which load as usual)
# and then hands over to the game's scene. Safe to delete.

func _ready() -> void:
	var cfg := _config()
	var mode := String(cfg.get("mode", "play"))
	var node: Node
	if mode == "test":
		node = load("res://.godot/harness/test_runner.gd").new()
		node.name = "HarnessTests"
	else:
		node = load("res://.godot/harness/play.gd").new()
		node.name = "HarnessPlay"
	node.set_meta("config", cfg)
	get_tree().root.add_child.call_deferred(node)
	if mode == "test":
		return
	var scene := String(cfg.get("scene", ""))
	if scene == "":
		scene = String(ProjectSettings.get_setting("application/run/main_scene", ""))
	if scene == "":
		push_error("harness: the project has no main scene (application/run/main_scene) and none was given")
		get_tree().quit(2)
		return
	get_tree().change_scene_to_file.call_deferred(scene)

static func _config() -> Dictionary:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--harness="):
			var text := FileAccess.get_file_as_string(a.substr(10))
			var parsed = JSON.parse_string(text)
			if parsed is Dictionary:
				return parsed
			push_error("harness: could not read the config " + a.substr(10))
	return {}
