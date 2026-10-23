extends Node
## StudioHook (an autoload): how the harness and its AI player see this game.
##  - state: what the game is doing (player position, score...), for play reports and the
##    step mode. The game calls set_state(key, value) as things change.
##  - events: what happened (pickup, win, death), with the time, for playtest reports.
##  - the self-test: run with `-- --selftest`, the game drives itself and calls
##    check(name, ok); once every name in expect() passed it prints SELFTEST PASS and quits.
##    A failed check is a push_error (the godot tool and the godot-selftest gate report it).
## It does nothing else, so it can stay in a shipped game.

signal game_event(type: String, detail: String)

var selftest := "--selftest" in OS.get_cmdline_user_args()
var events: Array = []
var _state := {}
var _expected: Array = []
var _passed := {}
var _failed := false
var _frames := 0
## Frames the self-test may take before it fails as unfinished.
var selftest_frames := 590

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS

func _process(_delta: float) -> void:
	_frames += 1
	if selftest and not _failed and _frames == selftest_frames:
		var missing := _expected.filter(func(n): return not _passed.has(n))
		if missing.size():
			_failed = true
			push_error("selftest: did not finish in %d frames; never checked: %s" % [selftest_frames, ", ".join(missing)])

func set_state(key: String, value) -> void:
	_state[key] = value

func state() -> Dictionary:
	return _state.duplicate(true)

func emit_event(type: String, detail := "") -> void:
	events.append({"t": snappedf(_frames / 60.0, 0.01), "type": type, "detail": detail})
	game_event.emit(type, detail)

## The checks the self-test must pass before it prints SELFTEST PASS.
func expect(names: Array) -> void:
	_expected = names.duplicate()

func check(name: String, ok: bool, detail := "") -> void:
	if not selftest or _failed:
		return
	if not ok:
		_failed = true
		push_error("selftest: %s failed%s" % [name, (": " + detail) if detail != "" else ""])
		return
	if _passed.has(name):
		return
	_passed[name] = true
	print("SELFTEST ok %s%s" % [name, (" (" + detail + ")") if detail != "" else ""])
	if _expected.all(func(n): return _passed.has(n)):
		print("SELFTEST PASS")
		get_tree().quit()
