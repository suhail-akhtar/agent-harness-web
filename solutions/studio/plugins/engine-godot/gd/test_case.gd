extends Node
## Base for the tests the godot tool's test action runs (GUT-style; engine-godot ships it to
## addons/harness_test/). A test file is res://tests/**/test_*.gd that starts with
##     extends "res://addons/harness_test/test_case.gd"
## Every method named test_* is one test; before_all, before_each, after_each and after_all
## run around them. A test may await (wait_frames, wait_physics, wait_seconds): the game's
## scene tree runs while it waits. add_scene() instances a scene under the test and frees
## it after the test.

var _failures: Array = []
var _asserts := 0
var _skipped := ""
var _owned: Array = []

func before_all() -> void: pass
func before_each() -> void: pass
func after_each() -> void: pass
func after_all() -> void: pass

# ---------- asserts ----------

func assert_true(v, msg := "") -> void:
	_check(bool(v), "expected true, got %s" % _show(v), msg)

func assert_false(v, msg := "") -> void:
	_check(not bool(v), "expected false, got %s" % _show(v), msg)

func assert_eq(got, want, msg := "") -> void:
	_check(typeof(got) == typeof(want) and got == want or (_numeric(got) and _numeric(want) and got == want), "expected %s, got %s" % [_show(want), _show(got)], msg)

func assert_ne(got, other, msg := "") -> void:
	_check(not (typeof(got) == typeof(other) and got == other), "expected anything but %s" % _show(other), msg)

func assert_almost_eq(got, want, eps = 0.001, msg := "") -> void:
	var ok := false
	if got is Vector2 or got is Vector3:
		ok = (got - want).length() <= float(eps)
	elif _numeric(got) and _numeric(want):
		ok = absf(float(got) - float(want)) <= float(eps)
	_check(ok, "expected %s within %s, got %s" % [_show(want), _show(eps), _show(got)], msg)

func assert_gt(got, than, msg := "") -> void:
	_check(_numeric(got) and got > than, "expected more than %s, got %s" % [_show(than), _show(got)], msg)

func assert_lt(got, than, msg := "") -> void:
	_check(_numeric(got) and got < than, "expected less than %s, got %s" % [_show(than), _show(got)], msg)

func assert_null(v, msg := "") -> void:
	_check(v == null, "expected null, got %s" % _show(v), msg)

func assert_not_null(v, msg := "") -> void:
	_check(v != null, "expected a value, got null", msg)

func assert_has(container, v, msg := "") -> void:
	var ok: bool = (container is Array or container is Dictionary or container is String or container is PackedStringArray) and container.has(v)
	_check(ok, "expected %s to contain %s" % [_show(container), _show(v)], msg)

func fail(msg := "failed") -> void:
	_check(false, msg, "")

## Marks the test as skipped (it does not count as passed or failed).
func pending(why := "pending") -> void:
	_skipped = why

# ---------- waiting and scenes ----------

func wait_frames(n := 1) -> void:
	for i in n:
		await get_tree().process_frame

func wait_physics(n := 1) -> void:
	for i in n:
		await get_tree().physics_frame

func wait_seconds(s: float) -> void:
	await get_tree().create_timer(s).timeout

## Instances a scene (res://...) under this test; it is freed after the test.
func add_scene(path: String) -> Node:
	var packed: PackedScene = load(path)
	if packed == null:
		fail("could not load " + path)
		return null
	var n := packed.instantiate()
	add_child(n)
	_owned.append(n)
	return n

## Holds an input action down (or releases it), through the real input path.
func press(action: String, down := true) -> void:
	var ev := InputEventAction.new()
	ev.action = StringName(action)
	ev.pressed = down
	ev.strength = 1.0 if down else 0.0
	Input.parse_input_event(ev)
	Input.flush_buffered_events()

func release(action: String) -> void:
	press(action, false)

# ---------- for the runner ----------

func _begin() -> void:
	_failures = []
	_asserts = 0
	_skipped = ""

func _end() -> void:
	# Out of the tree at once (its bodies must not meet the next test's), freed at the frame's end.
	for n in _owned:
		if is_instance_valid(n):
			if n.get_parent():
				n.get_parent().remove_child(n)
			n.queue_free()
	_owned = []

func _check(ok: bool, what: String, msg: String) -> void:
	_asserts += 1
	if ok:
		return
	var f := {"message": (msg + ": " if msg != "" else "") + what}
	var where := _where()
	if where.size():
		f.merge(where)
	_failures.append(f)

## The test file's line that failed, from the script backtrace (Godot 4.5+).
func _where() -> Dictionary:
	if not Engine.has_method("capture_script_backtraces"):
		return {}
	for bt in Engine.call("capture_script_backtraces"):
		for i in bt.get_frame_count():
			var file: String = bt.get_frame_file(i)
			if file != get_script().get_base_script().resource_path and file.begins_with("res://"):
				return {"file": file, "line": bt.get_frame_line(i)}
	return {}

static func _numeric(v) -> bool:
	return typeof(v) == TYPE_INT or typeof(v) == TYPE_FLOAT

static func _show(v) -> String:
	if v is String:
		return '"%s"' % v
	return var_to_str(v).left(200)
