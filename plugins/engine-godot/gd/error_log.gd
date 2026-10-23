extends Logger
# Written by the harness (engine-godot) into .godot/harness/: collects the errors printed
# while a test runs, so a script error or push_error fails that test. Safe to delete.

var _lock := Mutex.new()
var _errors: Array = []

func _log_error(function: String, file: String, line: int, code: String, rationale: String, _editor_notify: bool, error_type: int, script_backtraces: Array[ScriptBacktrace]) -> void:
	if error_type == ERROR_TYPE_WARNING:
		return
	var where := {"file": file, "line": line}
	# A push_error's own location is Godot's C++: the script's frame says where it came from.
	for bt in script_backtraces:
		if bt.get_frame_count() > 0:
			where = {"file": bt.get_frame_file(0), "line": bt.get_frame_line(0)}
			break
	var text := rationale if rationale != "" else code
	_lock.lock()
	_errors.append({"message": "error: %s%s" % [text, " (in %s)" % function if function != "" else ""], "file": where["file"], "line": where["line"]})
	_lock.unlock()

func _log_message(_message: String, _error: bool) -> void:
	pass

func take() -> Array:
	_lock.lock()
	var out := _errors
	_errors = []
	_lock.unlock()
	return out
