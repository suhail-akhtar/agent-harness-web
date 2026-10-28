extends Node
# Written by the harness (engine-godot) into .godot/harness/: the godot tool's test action.
# Runs every test file (res://tests/**/test_*.gd or *_test.gd, each extending
# res://addons/harness_test/test_case.gd) and every test scene (res://tests/**/test_*.tscn,
# whose root emits test_finished(passed: bool, message: String)), with the project's
# autoloads loaded as in the game. One "HARNESS_TEST {...}" line per test, then
# "HARNESS_TESTS_DONE {...}". Safe to delete.

var cfg: Dictionary = {}
var results: Array = []
var errors = null

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	cfg = get_meta("config", {})
	# Errors while a test runs (a script error, push_error) fail it: Godot 4.5+ has loggers.
	if ClassDB.class_exists("Logger"):
		errors = load("res://.godot/harness/error_log.gd").new()
		OS.call("add_logger", errors)
	_run.call_deferred()

func _logged() -> Array:
	return errors.take() if errors else []

func _run() -> void:
	var root := String(cfg.get("dir", "res://tests"))
	var filter := String(cfg.get("filter", ""))
	var files: Array[String] = []
	_walk(root, files)
	files.sort()
	var t0 := Time.get_ticks_msec()
	for f in files:
		if f.get_extension() == "gd":
			await _suite(f, filter)
		else:
			await _scene(f, filter)
	var passed := results.filter(func(r): return r["status"] == "passed").size()
	var failed := results.filter(func(r): return r["status"] == "failed").size()
	var skipped := results.filter(func(r): return r["status"] == "skipped").size()
	var summary := {"files": files.size(), "tests": results.size(), "passed": passed, "failed": failed, "skipped": skipped, "ms": Time.get_ticks_msec() - t0}
	print("HARNESS_TESTS_DONE ", JSON.stringify(summary))
	get_tree().quit(1 if failed else 0)

func _walk(dir: String, out: Array[String]) -> void:
	if not DirAccess.dir_exists_absolute(dir):
		return
	for d in DirAccess.get_directories_at(dir):
		if not d.begins_with("."):
			_walk(dir.path_join(d), out)
	for f in DirAccess.get_files_at(dir):
		var base := f.get_basename()
		if (f.get_extension() == "gd" and (base.begins_with("test_") or base.ends_with("_test"))) or (f.get_extension() == "tscn" and base.begins_with("test_")):
			out.append(dir.path_join(f))

func _report(r: Dictionary) -> void:
	results.append(r)
	print("HARNESS_TEST ", JSON.stringify(r))

func _suite(path: String, filter: String) -> void:
	var script = load(path)
	if script == null or not (script is GDScript) or not script.can_instantiate():
		_report({"suite": path, "name": "(load)", "status": "failed", "failures": [{"message": "the test file did not load (a parse error: run the check action)", "file": path}], "asserts": 0, "ms": 0})
		return
	var t = script.new()
	if not t.has_method("_begin"):
		_report({"suite": path, "name": "(load)", "status": "failed", "failures": [{"message": "a test file must extend res://addons/harness_test/test_case.gd", "file": path}], "asserts": 0, "ms": 0})
		if t is Node:
			t.free()
		return
	t.name = path.get_file().get_basename()
	add_child(t)
	var names: Array[String] = []
	for m in script.get_script_method_list():
		var n := String(m["name"])
		if n.begins_with("test_") and not names.has(n) and (filter == "" or n.contains(filter) or path.contains(filter)):
			names.append(n)
	if names.size():
		await t.before_all()
	for n in names:
		t._begin()
		_logged()
		var t0 := Time.get_ticks_usec()
		await t.before_each()
		await t.call(n)
		await t.after_each()
		t._end()
		t._failures.append_array(_logged())
		var status := "skipped" if t._skipped != "" else ("failed" if t._failures.size() else "passed")
		var r := {"suite": path, "name": n, "status": status, "failures": t._failures, "asserts": t._asserts, "ms": snappedf((Time.get_ticks_usec() - t0) / 1000.0, 0.1)}
		if t._skipped != "":
			r["skipped"] = t._skipped
		_report(r)
	if names.size():
		await t.after_all()
	t.queue_free()

func _scene(path: String, filter: String) -> void:
	if filter != "" and not path.contains(filter):
		return
	var packed: PackedScene = load(path)
	var t0 := Time.get_ticks_usec()
	if packed == null:
		_report({"suite": path, "name": path.get_file(), "status": "failed", "failures": [{"message": "the test scene did not load", "file": path}], "asserts": 0, "ms": 0})
		return
	var n := packed.instantiate()
	if not n.has_signal("test_finished"):
		_report({"suite": path, "name": path.get_file(), "status": "failed", "failures": [{"message": "a test scene's root must have signal test_finished(passed: bool, message: String)", "file": path}], "asserts": 0, "ms": 0})
		n.free()
		return
	var outcome := {"done": false, "passed": false, "message": ""}
	n.test_finished.connect(func(p, m = ""): outcome["done"] = true; outcome["passed"] = bool(p); outcome["message"] = String(m))
	add_child(n)
	var limit := int(cfg.get("sceneFrames", 600))
	var frames := 0
	while not outcome["done"] and frames < limit:
		await get_tree().process_frame
		frames += 1
	var logged := _logged()
	var ok: bool = outcome["passed"] and logged.is_empty()
	var r := {"suite": path, "name": path.get_file(), "status": "passed" if ok else "failed", "failures": logged, "asserts": 1, "ms": snappedf((Time.get_ticks_usec() - t0) / 1000.0, 0.1), "frames": frames}
	if not outcome["done"]:
		r["failures"].append({"message": "the scene did not emit test_finished in %d frames" % limit, "file": path})
	elif not outcome["passed"]:
		r["failures"] = [{"message": outcome["message"] if outcome["message"] != "" else "the scene reported a failure", "file": path}]
	_report(r)
	n.queue_free()
