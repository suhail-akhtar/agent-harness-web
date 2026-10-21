---
name: blender-scripting
description: Blender from Python (bpy) with the blender tool, headless - build models procedurally (bmesh, modifiers, materials), export glTF/FBX/OBJ with the right units and axes, open .blend files, and render a PNG preview without a GPU. Use when the user asks for Blender, a .blend file, FBX/OBJ, or a model that needs Blender's modelling tools.
---
# Blender scripting (headless)

The `blender` tool runs `blender -b [file.blend] --factory-startup --python script -- args` where the session's commands run (in a sandbox, the 3D image has Blender 4.2 LTS). If it says Blender is not installed, use the Three.js path (procedural-3d-modeling) instead and say why.

- `{"script": "tools/stool.py", "args": ["out/stool.glb", "out/stool.png"], "show": ["out/stool.png"]}` runs a file; `{"code": "..."}` runs Python given inline.
- `{"file": "art/ship.blend", "script": "tools/convert.py", "args": ["out/ship.glb"]}` opens a .blend first.
- `show` returns the images the script wrote (look at your preview render). A Python error fails the call with the traceback at the end of the output.
- The working folder is the workspace root. Make every output path absolute with `os.path.abspath` (a relative render path is not resolved against the working folder; on Windows it lands in `C:\`) and create its folder (`os.makedirs`): exporters do not.

## Units and axes
- 1 Blender unit = 1 metre = 1 glTF unit. Keep `scene.unit_settings.scale_length = 1.0`; model at real size.
- Blender is **Z up**; glTF, Three.js and Godot are **Y up**. The glTF exporter converts (`export_yup=True`, the default). Model with the front facing **-Y** in Blender: it becomes **+Z** in glTF.
- Origin at the base of the object (z = 0 on the floor), centred in X and Y.
- Apply scale before modifiers that depend on it (`bpy.ops.object.transform_apply(scale=True)` on the selected object), and export with `export_apply=True` so modifiers are baked in.

## A complete recipe: model, export, preview
Run as is, then change the parts. It starts from an empty scene, builds with bmesh and an operator, shares one mesh between copies, exports a .glb and renders a preview on the CPU.

```python
# tools/stool.py - run: blender {"script": "tools/stool.py", "args": ["out/stool.glb", "out/stool.png"], "show": ["out/stool.png"]}
import bpy, bmesh, math, os, sys
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
GLB = os.path.abspath(argv[0] if argv else 'out/model.glb')
PNG = os.path.abspath(argv[1] if len(argv) > 1 else 'out/preview.png')
os.makedirs(os.path.dirname(GLB), exist_ok=True)
os.makedirs(os.path.dirname(PNG), exist_ok=True)

# An empty scene: nothing from the startup file (no default cube, camera or light).
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'
scene.unit_settings.scale_length = 1.0  # 1 Blender unit = 1 metre = 1 glTF unit

def material(name, color, metallic=0.0, roughness=0.6):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (*color, 1.0)
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = roughness
    return m

def link(obj, mat=None):
    scene.collection.objects.link(obj)
    if mat:
        obj.data.materials.append(mat)
    return obj

wood = material('Oak', (0.45, 0.28, 0.14), roughness=0.55)
steel = material('Steel', (0.75, 0.76, 0.78), metallic=1.0, roughness=0.3)

# Seat: a cylinder from bmesh (radius 0.18 m, 0.04 m thick, top at 0.68 m), bevelled edges, smooth shading.
mesh = bpy.data.meshes.new('Seat')
bm = bmesh.new()
bmesh.ops.create_cone(bm, cap_ends=True, segments=48, radius1=0.18, radius2=0.18, depth=0.04)
bm.to_mesh(mesh)
bm.free()
seat = link(bpy.data.objects.new('Seat', mesh), wood)
seat.location = (0, 0, 0.66)
bevel = seat.modifiers.new('Bevel', 'BEVEL')
bevel.width = 0.008
bevel.segments = 3
bevel.limit_method = 'ANGLE'
mesh.shade_smooth()

# Legs: one tapered cylinder, four linked copies splayed outwards (rotation about the base).
leg_mesh = bpy.data.meshes.new('Leg')
bm = bmesh.new()
bmesh.ops.create_cone(bm, cap_ends=True, segments=24, radius1=0.018, radius2=0.014, depth=0.64)
bmesh.ops.translate(bm, verts=bm.verts, vec=(0, 0, 0.32))  # origin at the foot
bm.to_mesh(leg_mesh)
bm.free()
leg_mesh.shade_smooth()
leg_mesh.materials.append(wood)  # on the shared mesh: every copy gets it
for sx, sy in [(1, 1), (-1, 1), (1, -1), (-1, -1)]:
    leg = link(bpy.data.objects.new('Leg', leg_mesh))
    leg.location = (sx * 0.13, sy * 0.13, 0)
    leg.rotation_euler = (math.radians(4 * sy), math.radians(-4 * sx), 0)  # tops lean in, feet out

# Footrest: a torus ring at 0.25 m.
bpy.ops.mesh.primitive_torus_add(major_radius=0.155, minor_radius=0.008, location=(0, 0, 0.25), major_segments=64, minor_segments=12)
ring = bpy.context.active_object
ring.name = 'Footrest'
ring.data.materials.append(steel)
ring.data.shade_smooth()

# Export glTF: Y up (glTF's convention; Blender is Z up), modifiers applied, one .glb file.
# Blender's front is -Y: it becomes +Z in glTF (the front in Three.js and Godot).
bpy.ops.export_scene.gltf(filepath=GLB, export_format='GLB', export_yup=True, export_apply=True)

# Preview: frame the whole model from a three-quarter view, sun plus a light grey world.
objs = [o for o in scene.objects if o.type == 'MESH']
pts = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
center, size = (lo + hi) / 2, max(hi - lo)
print('SIZE m', [round(v, 3) for v in (hi - lo)])

cam = link(bpy.data.objects.new('Camera', bpy.data.cameras.new('Camera')))
cam.location = center + Vector((1.0, -1.4, 0.8)).normalized() * size * 2.6
cam.rotation_euler = (center - cam.location).to_track_quat('-Z', 'Y').to_euler()
scene.camera = cam
sun = link(bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN')))
sun.rotation_euler = (math.radians(50), 0, math.radians(30))
sun.data.energy = 3.0
scene.world = bpy.data.worlds.new('World')
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.8, 0.8, 0.8, 1)

scene.render.engine = 'CYCLES'  # CPU path tracing works headless; Eevee needs a GPU
scene.cycles.device = 'CPU'
scene.cycles.samples = 16
scene.render.resolution_x, scene.render.resolution_y = 640, 480
scene.render.filepath = PNG  # absolute: Blender does not resolve render paths against the working folder
bpy.ops.render.render(write_still=True)
print('WROTE', GLB, PNG)
```

Then: `model_info` on the .glb (size in metres, triangles, materials), look at the preview, fix, run again. The `gltf-valid` gate checks every .glb; `blender-file` checks that every .blend opens.

## Building blocks
| Want | Use |
|---|---|
| A primitive you then edit | `bmesh.ops.create_cube / create_cone / create_uvsphere / create_circle`, then `bmesh.ops.translate / scale / rotate`, `bm.to_mesh(mesh)` |
| A quick object | `bpy.ops.mesh.primitive_*_add(...)` then `bpy.context.active_object` (operators need no selection set-up in a fresh scene) |
| Round edges | `BEVEL` modifier (width 1-3% of the part, 2-3 segments, `limit_method='ANGLE'`) |
| Symmetry | `MIRROR` modifier (`use_axis`, `use_bisect_axis`, `use_clip`) |
| Repeats | `ARRAY` modifier (`count`, `relative_offset_displace`) or linked copies: `bpy.data.objects.new(name, shared_mesh)` |
| Thickness for a shell | `SOLIDIFY` modifier |
| Smooth organic surface | `SUBSURF` modifier (levels 1-2) plus `mesh.shade_smooth()` |
| Sharp-edged smooth shading | `bpy.ops.object.shade_smooth_by_angle(angle=math.radians(30))` on the active object (Blender 4.1+; there is no auto smooth any more) |
| Join parts into one mesh | select them, set one active, `bpy.ops.object.join()` |

Materials: the Principled BSDF's Base Color, Metallic, Roughness, Emission and Alpha go to glTF as they are. Image textures need UVs (`bpy.ops.uv.smart_project()` in edit mode) and an Image Texture node into Base Color. Name materials and objects: the names travel to glTF.

## Open a .blend and export
```python
# tools/convert.py - run: blender {"file": "art/ship.blend", "script": "tools/convert.py", "args": ["out/ship.glb", "out/ship.fbx"]}
import bpy, os, sys

argv = sys.argv[sys.argv.index('--') + 1:]
for arg in argv:
    out = os.path.abspath(arg)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    ext = os.path.splitext(out)[1].lower()
    if ext in ('.glb', '.gltf'):
        bpy.ops.export_scene.gltf(filepath=out, export_format='GLB' if ext == '.glb' else 'GLTF_SEPARATE', export_yup=True, export_apply=True)
    elif ext == '.fbx':
        # Unity and Unreal: metres with the unit scale applied, Y up, -Z forward.
        bpy.ops.export_scene.fbx(filepath=out, apply_scale_options='FBX_SCALE_UNITS', axis_forward='-Z', axis_up='Y', use_mesh_modifiers=True)
    elif ext == '.obj':
        bpy.ops.wm.obj_export(filepath=out, forward_axis='NEGATIVE_Z', up_axis='Y', apply_modifiers=True, export_materials=True)
    else:
        raise SystemExit(f'unknown format: {ext}')
    print('EXPORTED', out, os.path.getsize(out), 'bytes')
```
Only the selected objects: `use_selection=True` (glTF/FBX) or `export_selected_objects=True` (OBJ). Save the scene with `bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath('art/model.blend'))` when the user wants the .blend.

## Preview renders without a GPU
- **Cycles on the CPU** (above): 8-32 samples at 640x480 takes seconds. Add `scene.cycles.use_denoising = False` if it is slow.
- **Workbench**: `scene.render.engine = 'BLENDER_WORKBENCH'` and `scene.display.shading.color_type = 'MATERIAL'`: flat, instant, good for checking shape and proportions.
- **Eevee** needs a GPU: do not use it headless.
- Light it: a sun at 40-60 degrees plus a light world colour; a black world and a sun straight down give a black picture. Metals look black without something to reflect: a light world fixes that.
- Render front, side and three-quarter views for a review: move the camera, change `scene.render.filepath`, render again.

## Checks before you finish
- `SIZE` printed and `model_info` agree with the plan (metres).
- No stray objects: start from `read_factory_settings(use_empty=True)`; the default cube is not part of the model.
- Normals point out (`bmesh.ops.recalc_face_normals(bm, faces=bm.faces)` after building faces by hand).
- The preview looks right from more than one view; the .glb passes `gltf-valid`; a .blend you deliver passes `blender-file`.
