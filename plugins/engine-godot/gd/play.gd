extends Node
# Written by the harness (engine-godot) into .godot/harness/: drives a game for the godot
# tool, from /root beside the project's autoloads.
#   play      N frames with a scripted input timeline; a frame saved every k frames; metrics.
#   step      the same a step at a time: one JSON command per line on stdin, one
#             "HARNESS_STEP {...}" line back (the frame, the state) after each step.
#   describe  the scene tree (and the project's settings) after a few frames.
# A frame boundary is the start of an engine iteration, before the game's physics: inputs
# for frame f are applied there, so the game sees them in frame f. Safe to delete.

var cfg: Dictionary = {}
var mode := "play"
var frame := -1
var last_iteration := -1
var inputs: Array = []
var next_input := 0
var times := PackedFloat64Array()
var last_us := 0
var start_us := 0
var mem_peak := 0.0
var draws_max := 0
var captures: Array = []
var out_dir := ""
var every := 0
var total := 600
var step_until := 1
var step_no := 0
var no_frames := false
var done := false

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	process_priority = -100000
	process_physics_priority = -100000
	cfg = get_meta("config", {})
	mode = String(cfg.get("mode", "play"))
	out_dir = String(cfg.get("out", ""))
	every = int(cfg.get("every", 0))
	total = max(1, int(cfg.get("frames", 2 if mode == "describe" else 600)))
	inputs = _sorted(cfg.get("inputs", []), 0)
	# Headless draws nothing: no frames to save.
	no_frames = DisplayServer.get_name() == "headless"
	if out_dir != "" and not no_frames:
		DirAccess.make_dir_recursive_absolute(out_dir)

func _physics_process(_delta: float) -> void:
	_boundary()

func _process(_delta: float) -> void:
	# A frame without a physics tick still has a boundary.
	_boundary()

func _in_game() -> bool:
	var s := get_tree().current_scene
	return s != null and s.name != "HarnessBoot"

func _boundary() -> void:
	if done or not _in_game():
		return
	var it := Engine.get_process_frames()
	if it == last_iteration:
		return
	last_iteration = it
	frame += 1
	var now := Time.get_ticks_usec()
	if frame == 0:
		start_us = now
	else:
		times.append((now - last_us) / 1000.0)
	last_us = now
	_sample()
	if mode == "describe" or mode == "gltf":
		if frame >= total:
			if mode == "describe":
				_finish_describe()
			else:
				_finish_gltf()
		return
	if mode == "step":
		if frame >= step_until:
			_step_reply()
			if done:
				return
			last_us = Time.get_ticks_usec()
	elif every > 0 and frame > 0 and frame % every == 0:
		_capture(frame)
	if mode == "play" and frame >= total:
		_finish_play()
		return
	_apply_inputs()

func _sample() -> void:
	mem_peak = max(mem_peak, Performance.get_monitor(Performance.MEMORY_STATIC))
	draws_max = max(draws_max, int(Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME)))

# ---------- inputs ----------

## Entries {f, action | key | button/x/y, down}; f is relative to `base`.
func _sorted(list, base: int) -> Array:
	var out: Array = []
	if list is Array:
		for e in list:
			if e is Dictionary:
				var c: Dictionary = e.duplicate()
				c["f"] = base + int(e.get("f", 0))
				out.append(c)
	out.sort_custom(func(a, b): return int(a["f"]) < int(b["f"]))
	return out

func _apply_inputs() -> void:
	var any := false
	while next_input < inputs.size() and int(inputs[next_input]["f"]) <= frame:
		_apply(inputs[next_input])
		next_input += 1
		any = true
	if any:
		Input.flush_buffered_events()

func _apply(e: Dictionary) -> void:
	var down := bool(e.get("down", true))
	if e.has("action"):
		var a := StringName(String(e["action"]))
		if not InputMap.has_action(a):
			push_warning("harness: no input action named %s" % a)
			return
		var ev := InputEventAction.new()
		ev.action = a
		ev.pressed = down
		ev.strength = 1.0 if down else 0.0
		Input.parse_input_event(ev)
	elif e.has("key"):
		var code := OS.find_keycode_from_string(String(e["key"]))
		if code == KEY_NONE:
			push_warning("harness: unknown key %s" % e["key"])
			return
		var k := InputEventKey.new()
		k.keycode = code
		k.physical_keycode = code
		k.pressed = down
		Input.parse_input_event(k)
	else:
		var pos := Vector2(float(e.get("x", 0)), float(e.get("y", 0)))
		if e.has("x") or e.has("y"):
			var m := InputEventMouseMotion.new()
			m.position = pos
			m.global_position = pos
			Input.parse_input_event(m)
		if e.has("button"):
			var b := InputEventMouseButton.new()
			b.button_index = int(e["button"]) as MouseButton
			b.pressed = down
			b.position = pos
			b.global_position = pos
			Input.parse_input_event(b)

# ---------- frames and state ----------

## The last frame drawn, saved as a PNG; "" when nothing is drawn (headless).
func _capture(n: int) -> String:
	if no_frames or out_dir == "":
		return ""
	var tex := get_viewport().get_texture()
	var img: Image = tex.get_image() if tex else null
	if img == null or img.is_empty():
		no_frames = true
		return ""
	var file := out_dir.path_join("frame_%05d.png" % n)
	if img.save_png(file) != OK:
		push_error("harness: could not save " + file)
		return ""
	captures.append({"frame": n, "file": file, "state": _state()})
	return file

func _state() -> Dictionary:
	var s := {"frame": frame}
	var scene := get_tree().current_scene
	if scene:
		s["scene"] = scene.scene_file_path
	var hook := get_node_or_null("/root/StudioHook")
	if hook and hook.has_method("state"):
		s["game"] = _plain(hook.state())
	else:
		var players := get_tree().get_nodes_in_group("player")
		if players.size() and (players[0] is Node2D or players[0] is Node3D):
			s["player"] = _plain(players[0].global_position)
	return s

func _events() -> Array:
	var hook := get_node_or_null("/root/StudioHook")
	if hook and "events" in hook:
		return _plain(hook.events)
	return []

## Values JSON can carry: vectors and colours as arrays.
static func _plain(v):
	if v is Vector2 or v is Vector2i:
		return [v.x, v.y]
	if v is Vector3 or v is Vector3i:
		return [v.x, v.y, v.z]
	if v is Color:
		return [v.r, v.g, v.b, v.a]
	if v is Dictionary:
		var d := {}
		for k in v:
			d[String(k)] = _plain(v[k])
		return d
	if v is Array:
		var a: Array = []
		for x in v:
			a.append(_plain(x))
		return a
	if v is Object:
		return str(v)
	return v

func _metrics() -> Dictionary:
	var real_s := (Time.get_ticks_usec() - start_us) / 1000000.0
	var sorted := times.duplicate()
	sorted.sort()
	var avg := 0.0
	for t in sorted:
		avg += t
	avg = avg / max(1, sorted.size())
	var p95: float = sorted[int(min(sorted.size() - 1, floor(sorted.size() * 0.95)))] if sorted.size() else 0.0
	return {
		"frames": frame,
		"gameSeconds": snappedf(frame / float(cfg.get("fps", 60)), 0.001),
		"realSeconds": snappedf(real_s, 0.001),
		"fps": snappedf(frame / max(real_s, 0.000001), 0.1),
		"frameMsAvg": snappedf(avg, 0.01),
		"frameMsP95": snappedf(p95, 0.01),
		"frameMsMax": snappedf(sorted[sorted.size() - 1] if sorted.size() else 0.0, 0.01),
		"memoryMb": snappedf(Performance.get_monitor(Performance.MEMORY_STATIC) / 1048576.0, 0.1),
		"memoryPeakMb": snappedf(mem_peak / 1048576.0, 0.1),
		"drawCalls": draws_max,
		"objects": int(Performance.get_monitor(Performance.OBJECT_COUNT)),
		"nodes": int(Performance.get_monitor(Performance.OBJECT_NODE_COUNT)),
	}

func _write(data: Dictionary) -> void:
	var path := String(cfg.get("report", ""))
	if path == "":
		print("HARNESS_REPORT ", JSON.stringify(data))
		return
	var f := FileAccess.open(path, FileAccess.WRITE)
	if f == null:
		push_error("harness: could not write " + path)
		return
	f.store_string(JSON.stringify(data))
	f.close()

func _finish_play() -> void:
	done = true
	if every > 0 and (captures.is_empty() or int(captures[-1]["frame"]) != frame):
		_capture(frame)
	_write({"mode": "play", "metrics": _metrics(), "captures": captures, "events": _events(), "state": _state(), "noFrames": no_frames or out_dir == "" or every == 0, "applied": next_input, "inputs": inputs.size()})
	print("HARNESS_PLAY_DONE ", frame)
	get_tree().quit()

# ---------- step mode ----------

func _step_reply() -> void:
	var file := _capture(frame) if bool(cfg.get("capture", true)) else ""
	_say({"ok": true, "step": step_no, "frame": frame, "file": file, "state": _state(), "events": _events(), "metrics": _metrics()})
	while true:
		var line := _read_line()
		if line == "":
			_quit_step("stdin closed")
			return
		var cmd = JSON.parse_string(line)
		if not (cmd is Dictionary):
			_say({"ok": false, "error": "not a JSON object: " + line.left(200)})
			continue
		var c := String(cmd.get("cmd", "step"))
		if c == "quit":
			_quit_step("asked")
			return
		if c == "state":
			_say({"ok": true, "step": step_no, "frame": frame, "file": "", "state": _state(), "events": _events(), "metrics": _metrics()})
			continue
		step_no += 1
		var more := _sorted(cmd.get("inputs", []), frame)
		inputs = inputs.slice(next_input) + more
		inputs.sort_custom(func(a, b): return int(a["f"]) < int(b["f"]))
		next_input = 0
		cfg["capture"] = bool(cmd.get("capture", true))
		step_until = frame + max(1, int(cmd.get("frames", 1)))
		return

func _say(d: Dictionary) -> void:
	print("HARNESS_STEP ", JSON.stringify(d))

func _quit_step(why: String) -> void:
	done = true
	_write({"mode": "step", "metrics": _metrics(), "steps": step_no, "why": why, "events": _events(), "state": _state()})
	get_tree().quit()

## One line from stdin (blocking: the game waits for the next command).
static func _read_line() -> String:
	var bytes := PackedByteArray()
	while true:
		var b := OS.read_buffer_from_stdin(1)
		if b.is_empty():
			break
		if b[0] == 10:
			break
		bytes.append(b[0])
	return bytes.get_string_from_utf8().strip_edges()

# ---------- the running scene as glTF ----------

func _finish_gltf() -> void:
	done = true
	var file := String(cfg.get("file", ""))
	var doc := GLTFDocument.new()
	var state := GLTFState.new()
	var err := doc.append_from_scene(get_tree().current_scene, state)
	if err == OK:
		err = doc.write_to_filesystem(state, file)
	_write({"mode": "gltf", "error": err, "file": file, "meshes": state.get_meshes().size(), "nodes": state.get_nodes().size()})
	print("HARNESS_GLTF ", err)
	get_tree().quit()

# ---------- describe ----------

func _finish_describe() -> void:
	done = true
	var count := [0]
	var tree: Array = []
	for child in get_tree().root.get_children():
		if child == self:
			continue
		tree.append(_node(child, 0, count, int(cfg.get("depth", 12))))
	var actions := {}
	for a in InputMap.get_actions():
		if String(a).begins_with("ui_"):
			continue
		var evs: Array = []
		for ev in InputMap.action_get_events(a):
			evs.append(ev.as_text())
		actions[String(a)] = evs
	var autoloads := {}
	for p in ProjectSettings.get_property_list():
		var n := String(p["name"])
		if n.begins_with("autoload/"):
			autoloads[n.substr(9)] = String(ProjectSettings.get_setting(n)).trim_prefix("*")
	_write({
		"mode": "describe",
		"project": {
			"name": ProjectSettings.get_setting("application/config/name", ""),
			"mainScene": ProjectSettings.get_setting("application/run/main_scene", ""),
			"renderer": ProjectSettings.get_setting("rendering/renderer/rendering_method", ""),
			"viewport": [ProjectSettings.get_setting("display/window/size/viewport_width", 0), ProjectSettings.get_setting("display/window/size/viewport_height", 0)],
			"physicsTicks": Engine.physics_ticks_per_second,
			"autoloads": autoloads,
			"actions": actions,
		},
		"scene": get_tree().current_scene.scene_file_path if get_tree().current_scene else "",
		"nodes": count[0],
		"truncated": count[0] >= 400,
		"tree": tree,
		"state": _state(),
	})
	print("HARNESS_DESCRIBED ", count[0])
	get_tree().quit()

func _node(n: Node, depth: int, count: Array, max_depth: int) -> Dictionary:
	count[0] += 1
	var d := {"name": String(n.name), "type": n.get_class()}
	var s = n.get_script()
	if s:
		d["script"] = s.resource_path
	if n.scene_file_path != "":
		d["scene"] = n.scene_file_path
	if n is Node2D:
		d["position"] = _plain(n.position.round())
	elif n is Node3D:
		d["position"] = _plain(n.position.snapped(Vector3.ONE * 0.01))
	if n is CanvasItem or n is Node3D:
		if not n.visible:
			d["visible"] = false
	if n is Label or n is Button:
		d["text"] = n.text
	if n is Camera3D:
		d["projection"] = ["perspective", "orthogonal", "frustum"][n.projection]
	if n is TileMapLayer:
		d["cells"] = n.get_used_cells().size()
	if n is AnimatedSprite2D or n is AnimatedSprite3D:
		d["animation"] = String(n.animation)
		d["playing"] = n.is_playing()
	var groups: Array = []
	for g in n.get_groups():
		if not String(g).begins_with("_"):
			groups.append(String(g))
	if groups.size():
		d["groups"] = groups
	if depth < max_depth and count[0] < 400:
		var kids: Array = []
		for c in n.get_children():
			if count[0] >= 400:
				break
			kids.append(_node(c, depth + 1, count, max_depth))
		if kids.size():
			d["children"] = kids
	elif n.get_child_count():
		d["more"] = n.get_child_count()
	return d
