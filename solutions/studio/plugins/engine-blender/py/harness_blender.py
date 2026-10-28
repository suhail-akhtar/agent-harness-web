# Blender for the harness (engine-blender): what the blender tool's actions run, headless
# (blender -b [file] --python harness_blender.py -- config.json) and in the Harness Bridge
# add-on. One JSON config in, one JSON report out (config["report"]).
#   describe  the scene's objects, materials, cameras, lights, animation, as data
#   import    files (glb, gltf, fbx, obj, stl, ply, usd, abc) into the scene, optionally normalised, saved as .blend
#   export    the scene (or named objects) to glb, gltf, fbx, obj, stl, usd, for an engine's axes
#   capture   one quick view (Workbench), framed on the scene
#   render    a look-dev preset (studio, outdoor, night) with Cycles, EEVEE or Workbench; a turntable of N frames
#   sprites   a sprite sheet: N directions x M frames, orthographic, transparent, plus asset.json (Studio's layout)

import json
import math
import os
import sys

import bpy
from mathutils import Vector

ENGINES = {"cycles": "CYCLES", "workbench": "BLENDER_WORKBENCH"}
DIRECTION_NAMES = {4: ["s", "w", "n", "e"], 8: ["s", "sw", "w", "nw", "n", "ne", "e", "se"], 16: ["s", "ssw", "sw", "wsw", "w", "wnw", "nw", "nnw", "n", "nne", "ne", "ene", "e", "ese", "se", "sse"]}


def engine_id(name):
    """The render engine's id in this Blender (EEVEE is BLENDER_EEVEE_NEXT in 4.2, BLENDER_EEVEE elsewhere)."""
    name = (name or "cycles").lower()
    if name in ENGINES:
        return ENGINES[name]
    items = [i.identifier for i in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
    for cand in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
        if cand in items:
            return cand
    return "CYCLES"


def r3(v):
    return [round(float(x), 4) for x in v]


def mesh_objects(scene=None):
    scene = scene or bpy.context.scene
    return [o for o in scene.objects if o.type == "MESH" and o.visible_get()]


def bounds(objs):
    """World-space bounds of these objects: (lo, hi) or None."""
    pts = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
    if not pts:
        return None
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


def triangles(obj):
    me = obj.data
    return sum(max(len(p.vertices) - 2, 0) for p in me.polygons)


def describe(limit=400):
    scene = bpy.context.scene
    objs = []
    tris = 0
    for o in list(scene.objects)[:limit]:
        d = {"name": o.name, "type": o.type, "location": r3(o.location), "rotationDeg": r3([math.degrees(a) for a in o.rotation_euler]), "scale": r3(o.scale), "dimensions": r3(o.dimensions)}
        if o.parent:
            d["parent"] = o.parent.name
        cols = [c.name for c in o.users_collection]
        if cols and cols != ["Scene Collection"]:
            d["collections"] = cols
        if not o.visible_get():
            d["hidden"] = True
        if o.type == "MESH":
            t = triangles(o)
            tris += t
            d["mesh"] = {"vertices": len(o.data.vertices), "faces": len(o.data.polygons), "triangles": t, "uvLayers": len(o.data.uv_layers)}
            d["materials"] = [m.name for m in o.data.materials if m]
        if o.modifiers:
            d["modifiers"] = [f"{m.name} ({m.type})" for m in o.modifiers]
        if o.type == "ARMATURE":
            d["bones"] = len(o.data.bones)
        if o.animation_data and o.animation_data.action:
            a = o.animation_data.action
            d["action"] = {"name": a.name, "frames": r3(a.frame_range)}
        if o.type == "CAMERA":
            d["camera"] = {"type": o.data.type, "lens": round(o.data.lens, 2), "orthoScale": round(o.data.ortho_scale, 3)}
        if o.type == "LIGHT":
            d["light"] = {"type": o.data.type, "energy": round(o.data.energy, 3)}
        objs.append(d)
    b = bounds(mesh_objects(scene))
    return {
        "file": bpy.data.filepath,
        "blender": bpy.app.version_string,
        "scene": scene.name,
        "frames": [scene.frame_start, scene.frame_end],
        "fps": scene.render.fps,
        "engine": scene.render.engine,
        "resolution": [scene.render.resolution_x, scene.render.resolution_y],
        "unitScale": scene.unit_settings.scale_length,
        "camera": scene.camera.name if scene.camera else None,
        "objects": objs,
        "count": len(scene.objects),
        "truncated": len(scene.objects) > limit,
        "triangles": tris,
        "materials": [m.name for m in bpy.data.materials if m.users],
        "actions": [a.name for a in bpy.data.actions],
        "images": [i.name for i in bpy.data.images if i.users and i.name not in ("Render Result", "Viewer Node")],
        "bounds": {"min": r3(b[0]), "max": r3(b[1]), "size": r3(b[1] - b[0])} if b else None,
    }


# ---------- import and export ----------

def import_file(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=path)
    elif ext == ".stl":
        bpy.ops.wm.stl_import(filepath=path)
    elif ext == ".ply":
        bpy.ops.wm.ply_import(filepath=path)
    elif ext in (".usd", ".usda", ".usdc", ".usdz"):
        bpy.ops.wm.usd_import(filepath=path)
    elif ext == ".abc":
        bpy.ops.wm.alembic_import(filepath=path)
    elif ext == ".blend":
        with bpy.data.libraries.load(path) as (src, dst):
            dst.objects = src.objects
        for o in dst.objects:
            if o:
                bpy.context.scene.collection.objects.link(o)
    else:
        raise SystemExit(f"cannot import {ext} (glb, gltf, fbx, obj, stl, ply, usd, abc, blend)")


def normalise(objs, origin_to_base=True, apply_scale=True, size=None):
    """Scale applied, the whole set resting on z = 0 and centred in x and y; scaled to `size` metres tall if given."""
    roots = [o for o in objs if o.parent is None]
    b = bounds([o for o in objs if o.type == "MESH"])
    if not b or not roots:
        return
    lo, hi = b
    if size:
        k = float(size) / max(hi.z - lo.z, 1e-6)
        for o in roots:
            o.scale = o.scale * k
            o.location = o.location * k
        bpy.context.view_layer.update()
        lo, hi = bounds([o for o in objs if o.type == "MESH"])
    if origin_to_base:
        shift = Vector(((lo.x + hi.x) / -2, (lo.y + hi.y) / -2, -lo.z))
        for o in roots:
            o.location += shift
    if apply_scale:
        bpy.ops.object.select_all(action="DESELECT")
        for o in objs:
            if o.type in ("MESH", "EMPTY", "CURVE"):
                o.select_set(True)
        if bpy.context.selected_objects:
            bpy.context.view_layer.objects.active = bpy.context.selected_objects[0]
            bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)


# Axes per target: glTF is Y up (Godot, the web); Unreal and Unity take FBX.
TARGETS = {
    "godot": {"gltf": {"export_yup": True}},
    "web": {"gltf": {"export_yup": True}},
    "unreal": {"fbx": {"apply_scale_options": "FBX_SCALE_UNITS", "axis_forward": "-Y", "axis_up": "Z"}},
    "unity": {"fbx": {"apply_scale_options": "FBX_SCALE_UNITS", "axis_forward": "-Z", "axis_up": "Y", "apply_unit_scale": True, "bake_space_transform": True}},
}


def export_file(out, objects=None, target=None, apply_modifiers=True):
    out = os.path.abspath(out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    ext = os.path.splitext(out)[1].lower()
    sel = bool(objects)
    if sel:
        bpy.ops.object.select_all(action="DESELECT")
        missing = [n for n in objects if n not in bpy.data.objects]
        if missing:
            raise SystemExit(f"no object named {', '.join(missing)}")
        for n in objects:
            bpy.data.objects[n].select_set(True)
    t = TARGETS.get(target or "", {})
    if ext in (".glb", ".gltf"):
        bpy.ops.export_scene.gltf(filepath=out, export_format="GLB" if ext == ".glb" else "GLTF_SEPARATE", use_selection=sel, export_apply=apply_modifiers, **t.get("gltf", {"export_yup": True}))
    elif ext == ".fbx":
        opts = t.get("fbx", {"apply_scale_options": "FBX_SCALE_UNITS", "axis_forward": "-Z", "axis_up": "Y"})
        bpy.ops.export_scene.fbx(filepath=out, use_selection=sel, use_mesh_modifiers=apply_modifiers, **opts)
    elif ext == ".obj":
        bpy.ops.wm.obj_export(filepath=out, export_selected_objects=sel, forward_axis="NEGATIVE_Z", up_axis="Y", apply_modifiers=apply_modifiers, export_materials=True)
    elif ext == ".stl":
        bpy.ops.wm.stl_export(filepath=out, export_selected_objects=sel, apply_modifiers=apply_modifiers)
    elif ext in (".usd", ".usda", ".usdc", ".usdz"):
        bpy.ops.wm.usd_export(filepath=out, selected_objects_only=sel)
    else:
        raise SystemExit(f"cannot export {ext} (glb, gltf, fbx, obj, stl, usd)")
    return {"file": out, "bytes": os.path.getsize(out)}


# ---------- cameras, lights, rendering ----------

VIEWS = {"front": (0, -1, 0.15), "back": (0, 1, 0.15), "side": (1, 0, 0.15), "left": (-1, 0, 0.15), "top": (0, -0.001, 1), "three-quarter": (1, -1.4, 0.8)}


def frame_camera(cam, objs, direction, margin=1.25, ortho=False):
    """Points the camera along `direction` at the objects' bounds so they fill the frame."""
    b = bounds(objs)
    lo, hi = b if b else (Vector((-1, -1, 0)), Vector((1, 1, 2)))
    center = (lo + hi) / 2
    radius = max((hi - lo).length / 2, 0.01)
    d = Vector(direction).normalized()
    scene = bpy.context.scene
    aspect = scene.render.resolution_x / scene.render.resolution_y
    # The sensor (and the ortho scale) spans the frame's longer side: fit the shorter one.
    if ortho:
        cam.data.type = "ORTHO"
        cam.data.ortho_scale = radius * 2 * margin * max(aspect, 1 / aspect)
        dist = radius * 4
    else:
        cam.data.type = "PERSP"
        half = math.atan(math.tan(math.atan(cam.data.sensor_width / (2 * cam.data.lens))) * min(aspect, 1 / aspect))
        dist = radius * margin / math.sin(half)
    cam.location = center + d * dist
    cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
    cam.data.clip_end = max(1000, dist * 4)
    cam.data.clip_start = max(0.001, dist / 1000)
    return center, radius


def harness_camera(name="HarnessCamera"):
    scene = bpy.context.scene
    cam = bpy.data.objects.get(name)
    if cam is None:
        cam = bpy.data.objects.new(name, bpy.data.cameras.new(name))
        scene.collection.objects.link(cam)
    scene.camera = cam
    return cam


def light_rig(preset, center, radius):
    """A look-dev light set: studio (key, fill, rim and a grey world), outdoor (sun and sky), night (moonlight)."""
    scene = bpy.context.scene
    for o in [o for o in scene.objects if o.name.startswith("HarnessLight")]:
        bpy.data.objects.remove(o, do_unlink=True)
    world = bpy.data.worlds.get("HarnessWorld") or bpy.data.worlds.new("HarnessWorld")
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    scene.world = world

    def add(kind, name, energy, loc, color=(1, 1, 1), size=None):
        data = bpy.data.lights.new(name, kind)
        data.energy = energy
        data.color = color
        if size is not None and hasattr(data, "size"):
            data.size = size
        o = bpy.data.objects.new(name, data)
        scene.collection.objects.link(o)
        o.location = center + Vector(loc) * radius
        o.rotation_euler = (center - o.location).to_track_quat("-Z", "Y").to_euler()
        return o

    r2 = max(radius, 0.1) ** 2
    if preset == "studio":
        add("AREA", "HarnessLightKey", 220 * r2, (2.5, -2.5, 3), size=radius * 2)
        add("AREA", "HarnessLightFill", 70 * r2, (-3, -1.5, 1.5), size=radius * 3)
        add("AREA", "HarnessLightRim", 140 * r2, (0, 3, 2.5), size=radius)
        bg.inputs["Color"].default_value = (0.5, 0.5, 0.52, 1)
        bg.inputs["Strength"].default_value = 0.45
    elif preset == "outdoor":
        sun = add("SUN", "HarnessLightSun", 4.0, (1.5, -1, 2.5), color=(1, 0.96, 0.9))
        sun.data.angle = math.radians(2)
        bg.inputs["Color"].default_value = (0.45, 0.6, 0.9, 1)
        bg.inputs["Strength"].default_value = 1.0
    elif preset == "night":
        add("SUN", "HarnessLightMoon", 0.6, (-1, 1.5, 2), color=(0.6, 0.7, 1.0))
        add("POINT", "HarnessLightLamp", 60 * r2, (1.2, -1.2, 1.2), color=(1.0, 0.7, 0.4))
        bg.inputs["Color"].default_value = (0.02, 0.025, 0.05, 1)
        bg.inputs["Strength"].default_value = 1.0


def set_engine(engine, samples=None, transparent=False):
    scene = bpy.context.scene
    scene.render.engine = engine_id(engine)
    scene.render.film_transparent = bool(transparent)
    if scene.render.engine == "CYCLES":
        scene.cycles.device = "CPU" if os.environ.get("HARNESS_BLENDER_GPU") != "1" else "GPU"
        scene.cycles.samples = int(samples or 32)
        scene.cycles.use_denoising = False
    elif scene.render.engine.startswith("BLENDER_EEVEE"):
        try:
            scene.eevee.taa_render_samples = int(samples or 32)
        except AttributeError:
            pass
    else:
        scene.display.shading.light = "STUDIO"
        scene.display.shading.color_type = "MATERIAL"
        scene.display.render_aa = "8"


def render_still(path):
    scene = bpy.context.scene
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA" if scene.render.film_transparent else "RGB"
    scene.render.filepath = os.path.abspath(path)
    os.makedirs(os.path.dirname(scene.render.filepath), exist_ok=True)
    bpy.ops.render.render(write_still=True)
    return scene.render.filepath


def capture(cfg):
    scene = bpy.context.scene
    size = cfg.get("size") or [640, 480]
    scene.render.resolution_x, scene.render.resolution_y = int(size[0]), int(size[1])
    scene.render.resolution_percentage = 100
    objs = mesh_objects()
    view = cfg.get("view") or "three-quarter"
    if view != "camera" or scene.camera is None:
        frame_camera(harness_camera(), objs, VIEWS.get(view, VIEWS["three-quarter"]), ortho=bool(cfg.get("ortho")))
    set_engine(cfg.get("engine") or "workbench", cfg.get("samples"), cfg.get("transparent"))
    return {"file": render_still(cfg["output"]), "view": view, "engine": scene.render.engine}


def render(cfg):
    scene = bpy.context.scene
    size = cfg.get("size") or [960, 720]
    scene.render.resolution_x, scene.render.resolution_y = int(size[0]), int(size[1])
    scene.render.resolution_percentage = 100
    objs = mesh_objects()
    preset = cfg.get("preset") or "studio"
    view = cfg.get("view") or "three-quarter"
    own_camera = view == "camera" and scene.camera is not None
    cam = scene.camera if own_camera else harness_camera()
    center, radius = frame_camera(cam, objs, VIEWS.get(view, VIEWS["three-quarter"])) if not own_camera else (Vector((0, 0, 0)), 1)
    if preset != "none":
        light_rig(preset, center, radius)
    set_engine(cfg.get("engine") or "cycles", cfg.get("samples"), cfg.get("transparent"))
    frames = int(cfg.get("turntable") or 0)
    out = cfg["output"]
    files = []
    if frames > 0:
        # A turntable: the camera circles the model once in N frames (the model stays as it is).
        d = VIEWS.get(view, VIEWS["three-quarter"])
        base = math.atan2(d[1], d[0])
        for i in range(frames):
            a = base + 2 * math.pi * i / frames
            frame_camera(cam, objs, (math.cos(a) * math.hypot(d[0], d[1]), math.sin(a) * math.hypot(d[0], d[1]), d[2]))
            files.append(render_still(os.path.join(out, f"turntable_{i + 1:04d}.png")))
    else:
        files.append(render_still(out if out.lower().endswith(".png") else os.path.join(out, "render.png")))
    return {"files": files, "engine": scene.render.engine, "preset": preset, "size": [scene.render.resolution_x, scene.render.resolution_y]}


# ---------- sprite sheets ----------

def sprites(cfg):
    """N directions x M frames of the scene, orthographic and transparent, in one sheet."""
    scene = bpy.context.scene
    dirs = int(cfg.get("directions") or 8)
    frames = int(cfg.get("frames") or 1)
    size = int(cfg.get("size") or 64)
    elevation = math.radians(float(cfg.get("elevation", 30)))
    scene.render.resolution_x = scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    objs = mesh_objects()
    if not objs:
        raise SystemExit("nothing to render: the scene has no visible mesh")
    preset = cfg.get("preset") or "studio"
    b = bounds(objs)
    center, radius = (b[0] + b[1]) / 2, max((b[1] - b[0]).length / 2, 0.01)
    if preset != "none":
        light_rig(preset, center, radius)
    set_engine(cfg.get("engine") or "eevee", cfg.get("samples") or 16, True)
    if cfg.get("pixelArt"):
        scene.render.filter_size = 0.01
    # The animation frames to sample: the action's range when there is one, else the scene's.
    start, end = scene.frame_start, scene.frame_end
    acts = [o.animation_data.action for o in scene.objects if o.animation_data and o.animation_data.action]
    if acts:
        start, end = int(min(a.frame_range[0] for a in acts)), int(max(a.frame_range[1] for a in acts))
    picks = [start] if frames == 1 else [round(start + (end - start) * i / frames) for i in range(frames)]
    # One framing for every view, so the sprite does not change size as it turns: the largest extent of all.
    cam = harness_camera()
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = radius * 2 * float(cfg.get("margin", 1.1))
    cam.data.clip_start, cam.data.clip_end = 0.001, radius * 20
    tmp = os.path.join(os.path.abspath(cfg["output"]), ".cells")
    os.makedirs(tmp, exist_ok=True)
    cells = []
    for r in range(dirs):
        # Row r: the model seen from direction r, counter-clockwise from the front (south: the camera on -Y).
        a = -math.pi / 2 + 2 * math.pi * r / dirs
        d = Vector((math.cos(a) * math.cos(elevation), math.sin(a) * math.cos(elevation), math.sin(elevation)))
        cam.location = center + d * radius * 6
        cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
        for c, f in enumerate(picks):
            scene.frame_set(f)
            cells.append((r, c, render_still(os.path.join(tmp, f"cell_{r:02d}_{c:02d}.png"))))
    # The sheet: columns are frames, rows are directions; pixels pasted with numpy.
    import numpy as np
    sheet = np.zeros((dirs * size, frames * size, 4), dtype=np.float32)
    for r, c, path in cells:
        img = bpy.data.images.load(path)
        px = np.array(img.pixels[:], dtype=np.float32).reshape(size, size, 4)
        # Blender's pixels start at the bottom row; the sheet's row 0 is the top.
        top = (dirs - 1 - r) * size
        sheet[top:top + size, c * size:(c + 1) * size] = px
        bpy.data.images.remove(img)
        os.remove(path)
    os.rmdir(tmp)
    ident = cfg.get("id") or "sprite"
    out_png = os.path.join(os.path.abspath(cfg["output"]), f"{ident}.png")
    img = bpy.data.images.new(ident, width=frames * size, height=dirs * size, alpha=True)
    img.pixels.foreach_set(sheet.ravel())
    img.filepath_raw = out_png
    img.file_format = "PNG"
    img.save()
    names = DIRECTION_NAMES.get(dirs) or [f"d{i}" for i in range(dirs)]
    anim = cfg.get("animation") or ("walk" if frames > 1 else "idle")
    animations = {f"{anim}_{names[r]}": {"row": r, "from": 0, "count": frames, "loop": True} for r in range(dirs)}
    tris = sum(triangles(o) for o in objs)
    return {
        "file": out_png, "frames": dirs * frames, "frameSize": [size, size], "columns": frames, "rows": dirs,
        "directions": dirs, "directionNames": names, "animations": animations, "sampled": picks, "engine": scene.render.engine, "triangles": tris,
        "cellMetres": round(cam.data.ortho_scale, 4),
    }


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    with open(argv[0], encoding="utf8") as f:
        cfg = json.load(f)
    cmd = cfg.get("cmd")
    if cfg.get("empty"):
        bpy.ops.wm.read_factory_settings(use_empty=True)
    out = {"cmd": cmd}
    if cmd == "describe":
        out.update(describe())
    elif cmd == "import":
        before = set(bpy.data.objects)
        for p in cfg["files"]:
            import_file(p)
        new = [o for o in bpy.data.objects if o not in before]
        if cfg.get("normalise"):
            normalise(new, size=cfg.get("height"))
        out["imported"] = [o.name for o in new]
        if cfg.get("blend"):
            os.makedirs(os.path.dirname(os.path.abspath(cfg["blend"])), exist_ok=True)
            bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(cfg["blend"]))
        for p in cfg.get("exports") or []:
            export_file(p, target=cfg.get("target"))
        out["scene"] = describe()
    elif cmd == "export":
        out.update(export_file(cfg["output"], cfg.get("objects"), cfg.get("target"), cfg.get("applyModifiers", True)))
        out["scene"] = describe()
    elif cmd == "capture":
        out.update(capture(cfg))
    elif cmd == "render":
        out.update(render(cfg))
    elif cmd == "sprites":
        out.update(sprites(cfg))
    else:
        raise SystemExit(f"unknown command {cmd}")
    with open(cfg["report"], "w", encoding="utf8") as f:
        json.dump(out, f)
    print("HARNESS_BLENDER_DONE", cmd)


if __name__ == "__main__":
    main()
