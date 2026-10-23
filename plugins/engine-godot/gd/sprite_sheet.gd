extends RefCounted
## SpriteFrames from a sprite sheet asset in Studio's layout (assets/<id>/asset.json beside its
## PNG; see the godot-2d skill). The sheet is a grid of meta.frameSize cells; meta.animations
## names runs of cells: {"walk_s": {"row": 0, "from": 0, "count": 8, "fps": 12, "loop": true}}.
## Without animations, every cell in order is one "default" animation.
##     var frames := SpriteSheet.load_frames("res://assets/hero")
##     $AnimatedSprite2D.sprite_frames = frames

static func read_asset(dir: String) -> Dictionary:
	var text := FileAccess.get_file_as_string(dir.path_join("asset.json"))
	var a = JSON.parse_string(text) if text != "" else null
	if not (a is Dictionary):
		push_error("sprite sheet: no readable asset.json in " + dir)
		return {}
	return a

static func sheet_path(dir: String, asset: Dictionary) -> String:
	for f in asset.get("files", []):
		if String(f.get("role", "")) == "main":
			return dir.path_join(String(f["path"]))
	return dir.path_join(String(asset.get("id", "sheet")) + ".png")

static func load_frames(dir: String) -> SpriteFrames:
	var asset := read_asset(dir)
	var frames := SpriteFrames.new()
	if asset.is_empty():
		return frames
	var tex: Texture2D = load(sheet_path(dir, asset))
	if tex == null:
		push_error("sprite sheet: the image of %s did not load" % dir)
		return frames
	var meta: Dictionary = asset.get("meta", {})
	var size: Array = meta.get("frameSize", [tex.get_width(), tex.get_height()])
	var w := int(size[0])
	var h := int(size[1])
	var columns := int(meta.get("columns", tex.get_width() / w))
	var total := int(meta.get("frames", columns * int(tex.get_height() / h)))
	var fps := float(meta.get("fps", 8))
	var anims: Dictionary = meta.get("animations", {})
	if anims.is_empty():
		anims = {"default": {"row": 0, "from": 0, "count": total}}
	frames.remove_animation("default")
	for name in anims:
		var a: Dictionary = anims[name]
		frames.add_animation(name)
		frames.set_animation_speed(name, float(a.get("fps", fps)))
		frames.set_animation_loop(name, bool(a.get("loop", true)))
		var start := int(a.get("row", 0)) * columns + int(a.get("from", 0))
		for i in int(a.get("count", 1)):
			var cell := start + i
			var region := AtlasTexture.new()
			region.atlas = tex
			region.region = Rect2((cell % columns) * w, (cell / columns) * h, w, h)
			frames.add_frame(name, region)
	return frames
