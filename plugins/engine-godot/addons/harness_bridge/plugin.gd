@tool
extends EditorPlugin
## Harness Bridge (engine-godot): the harness's agents work in this open editor. A WebSocket
## server on 127.0.0.1 only (never another interface), on the first free port from 47610.
## The port and a random token are written to res://.godot/harness_bridge.json while the
## plugin is on; every connection must send that token first. Messages are JSON:
##   {"id": 1, "token": "...", "cmd": "tree", "params": {}}  ->  {"id": 1, "ok": true, "result": ...}
## Commands: ping, tree, add_node, set, remove, run (GDScript), save, open, play, stop,
## capture (the 2D or 3D viewport as a PNG). Switch it off in Project Settings > Plugins.

const FIRST_PORT := 47610
const INFO := "res://.godot/harness_bridge.json"

var server := TCPServer.new()
var port := 0
var token := ""
var peers: Array = []

func _enter_tree() -> void:
	var bytes := Crypto.new().generate_random_bytes(24)
	token = bytes.hex_encode()
	for p in range(FIRST_PORT, FIRST_PORT + 40):
		if server.listen(p, "127.0.0.1") == OK:
			port = p
			break
	if port == 0:
		push_error("Harness Bridge: no free port from %d" % FIRST_PORT)
		return
	var f := FileAccess.open(INFO, FileAccess.WRITE)
	if f:
		f.store_string(JSON.stringify({"port": port, "token": token, "pid": OS.get_process_id(), "godot": Engine.get_version_info()["string"], "project": ProjectSettings.get_setting("application/config/name", "")}))
		f.close()
	print("Harness Bridge: listening on 127.0.0.1:%d" % port)
	set_process(true)

func _exit_tree() -> void:
	for p in peers:
		p["ws"].close()
	peers.clear()
	server.stop()
	if FileAccess.file_exists(INFO):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(INFO))

var busy := false

func _process(_delta: float) -> void:
	# One request at a time: a run may await, and the next waits for it.
	if busy:
		return
	busy = true
	await _serve()
	busy = false

func _serve() -> void:
	while server.is_connection_available():
		var ws := WebSocketPeer.new()
		ws.inbound_buffer_size = 1 << 22
		ws.outbound_buffer_size = 1 << 24
		ws.max_queued_packets = 64
		if ws.accept_stream(server.take_connection()) == OK:
			peers.append({"ws": ws, "authed": false})
	for p in peers.duplicate():
		var ws: WebSocketPeer = p["ws"]
		ws.poll()
		var st := ws.get_ready_state()
		if st == WebSocketPeer.STATE_CLOSED:
			peers.erase(p)
			continue
		if st != WebSocketPeer.STATE_OPEN:
			continue
		while ws.get_available_packet_count() > 0:
			var text := ws.get_packet().get_string_from_utf8()
			var msg = JSON.parse_string(text)
			if not (msg is Dictionary):
				ws.send_text(JSON.stringify({"ok": false, "error": "not a JSON object"}))
				continue
			if not p["authed"]:
				if String(msg.get("token", "")) != token:
					ws.send_text(JSON.stringify({"id": msg.get("id"), "ok": false, "error": "bad token"}))
					ws.close(4001, "bad token")
					break
				p["authed"] = true
			var reply := {"id": msg.get("id")}
			var r = await _handle(String(msg.get("cmd", "ping")), msg.get("params", {}) if msg.get("params") is Dictionary else {})
			if r is Dictionary and r.has("error"):
				reply["ok"] = false
				reply["error"] = r["error"]
			else:
				reply["ok"] = true
				reply["result"] = r
			ws.send_text(JSON.stringify(reply))

func _root() -> Node:
	return EditorInterface.get_edited_scene_root()

func _find(path: String) -> Node:
	var root := _root()
	if root == null:
		return null
	if path == "" or path == "." or path == String(root.name):
		return root
	return root.get_node_or_null(NodePath(path))

func _handle(cmd: String, params: Dictionary):
	match cmd:
		"ping":
			var root := _root()
			return {"godot": Engine.get_version_info()["string"], "project": ProjectSettings.get_setting("application/config/name", ""), "scene": root.scene_file_path if root else "", "playing": EditorInterface.is_playing_scene()}
		"tree":
			var root := _root()
			if root == null:
				return {"error": "no scene is open in the editor"}
			return {"scene": root.scene_file_path, "tree": _node(root, root, 0, int(params.get("depth", 12)))}
		"add_node":
			var parent := _find(String(params.get("parent", ".")))
			if parent == null:
				return {"error": "no node %s in the open scene" % params.get("parent", ".")}
			var type := String(params.get("type", "Node"))
			if not ClassDB.class_exists(type) or not ClassDB.can_instantiate(type) or not ClassDB.is_parent_class(type, "Node"):
				return {"error": "%s is not a node type" % type}
			var n: Node = ClassDB.instantiate(type)
			n.name = String(params.get("name", type))
			var bad := _set_props(n, params.get("props", {}))
			if bad != "":
				n.free()
				return {"error": bad}
			var ur := get_undo_redo()
			ur.create_action("Harness: add %s" % n.name)
			ur.add_do_method(parent, "add_child", n, true)
			ur.add_do_method(n, "set_owner", _root())
			ur.add_do_reference(n)
			ur.add_undo_method(parent, "remove_child", n)
			ur.commit_action()
			return {"path": String(_root().get_path_to(n)), "name": String(n.name)}
		"set":
			var n := _find(String(params.get("path", "")))
			if n == null:
				return {"error": "no node %s in the open scene" % params.get("path", "")}
			var props: Dictionary = params.get("props", {})
			for k in props:
				if not (String(k) in n):
					return {"error": "%s has no property %s" % [n.get_class(), k]}
			var ur := get_undo_redo()
			ur.create_action("Harness: set %s" % n.name)
			for k in props:
				ur.add_do_property(n, String(k), _value(props[k]))
				ur.add_undo_property(n, String(k), n.get(String(k)))
			ur.commit_action()
			return {"path": String(_root().get_path_to(n))}
		"remove":
			var n := _find(String(params.get("path", "")))
			if n == null or n == _root():
				return {"error": "no removable node %s" % params.get("path", "")}
			var parent := n.get_parent()
			var ur := get_undo_redo()
			ur.create_action("Harness: remove %s" % n.name)
			ur.add_do_method(parent, "remove_child", n)
			ur.add_undo_method(parent, "add_child", n, true)
			ur.add_undo_method(n, "set_owner", _root())
			ur.add_undo_reference(n)
			ur.commit_action()
			return {"removed": String(n.name)}
		"run":
			return await _run(String(params.get("code", "")))
		"save":
			if _root() == null:
				return {"error": "no scene is open"}
			EditorInterface.save_scene()
			return {"saved": _root().scene_file_path}
		"open":
			var scene := String(params.get("scene", ""))
			if not ResourceLoader.exists(scene):
				return {"error": "no scene " + scene}
			EditorInterface.open_scene_from_path(scene)
			return {"opened": scene}
		"play":
			var scene := String(params.get("scene", ""))
			if scene == "":
				EditorInterface.play_main_scene()
			else:
				EditorInterface.play_custom_scene(scene)
			return {"playing": true}
		"stop":
			EditorInterface.stop_playing_scene()
			return {"playing": false}
		"capture":
			var which := String(params.get("viewport", "3d"))
			if DisplayServer.get_name() == "headless":
				return {"error": "no %s viewport image (a headless editor draws nothing)" % which}
			var vp: Viewport = EditorInterface.get_editor_viewport_3d(0) if which == "3d" else EditorInterface.get_editor_viewport_2d()
			var tex := vp.get_texture() if vp else null
			var img: Image = tex.get_image() if tex else null
			if img == null or img.is_empty():
				return {"error": "no %s viewport image (a headless editor draws nothing)" % which}
			return {"png": Marshalls.raw_to_base64(img.save_png_to_buffer()), "size": [img.get_width(), img.get_height()]}
		_:
			return {"error": "unknown command %s (ping, tree, add_node, set, remove, run, save, open, play, stop, capture)" % cmd}

## Runs GDScript in the editor: the code is the body of run(root, editor) and may return a value.
func _run(code: String):
	if code.strip_edges() == "":
		return {"error": "no code"}
	var src := "@tool\nextends RefCounted\n\nfunc run(root: Node, editor) -> Variant:\n"
	for line in code.split("\n"):
		src += "\t" + line + "\n"
	src += "\treturn null\n"
	var s := GDScript.new()
	s.source_code = src
	var err := s.reload()
	if err != OK:
		return {"error": "the code does not compile (error %d); it is the body of func run(root, editor)" % err}
	var obj = s.new()
	var value = await obj.run(_root(), EditorInterface)
	return {"value": var_to_str(value) if value != null else null}

func _value(v):
	# "Vector3(1, 2, 3)" and other Godot literals become values; JSON numbers, strings and bools stay.
	if v is String and v.contains("(") and v.ends_with(")"):
		var parsed = str_to_var(v)
		if parsed != null:
			return parsed
	return v

func _set_props(n: Node, props) -> String:
	if not (props is Dictionary):
		return ""
	for k in props:
		if not (String(k) in n):
			return "%s has no property %s" % [n.get_class(), k]
		n.set(String(k), _value(props[k]))
	return ""

func _node(n: Node, root: Node, depth: int, max_depth: int) -> Dictionary:
	var d := {"name": String(n.name), "type": n.get_class(), "path": String(root.get_path_to(n))}
	var s = n.get_script()
	if s:
		d["script"] = s.resource_path
	if n is Node2D or n is Node3D:
		d["position"] = var_to_str(n.position)
	if depth < max_depth:
		var kids: Array = []
		for c in n.get_children():
			if c.owner == root or c.owner == null:
				kids.append(_node(c, root, depth + 1, max_depth))
		if kids.size():
			d["children"] = kids
	return d
