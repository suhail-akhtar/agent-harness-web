# Studio's Blender entry: blender -b --factory-startup --python studio.py -- job.json
# The job names a generator (or an import to clean up), its params and seed, and what to
# write: a .glb (and .fbx for Unreal), a preview render, LODs, baked AO and normal maps,
# sprites rendered from N directions. It ends with report.json in the output folder.
#
# job: { "generator": "barrel", "params": {}, "seed": 1, "out": "<abs dir>", "name": "barrel",
#        "fbx": false, "preview": true, "lods": [0.5, 0.25], "bake": false,
#        "sprites": { "directions": 8, "size": 64, "actions": ["walk"], "frames": 8 },
#        "import": "<abs path>", "targetHeight": 1.0, "maxTriangles": 20000 }

import json
import math
import os
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402

import gen_character  # noqa: E402
import gen_material  # noqa: E402
import gen_props  # noqa: E402
import gen_world  # noqa: E402
from util import apply_transforms, bounds, ensure_uvs, join, origin_to_base, reset_scene, select_only, smart_uv, triangles  # noqa: E402

GENERATORS = {**gen_props.GENERATORS, **gen_world.GENERATORS, **gen_character.GENERATORS}
# Kinds whose parts stay separate objects (pieces of a kit export one file each; a car keeps its wheels).
SEPARATE = {'kit'}
KEEP_PARTS = {'vehicle', 'character', 'tree'}


def log(*a):
    print('STUDIO', *a, flush=True)


def meshes():
    return [o for o in bpy.context.scene.objects if o.type == 'MESH']


def export_glb(path, objs, animations=False):
    select_only(objs)
    for o in objs:
        for c in o.children_recursive:
            c.select_set(True)
    kw = dict(filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True, export_materials='EXPORT', export_image_format='AUTO')
    if animations:
        kw.update(export_animations=True, export_animation_mode='ACTIONS', export_skins=True, export_force_sampling=True)
    else:
        kw.update(export_animations=False)
    bpy.ops.export_scene.gltf(**kw)


def export_fbx(path, objs, animations=False):
    select_only(objs)
    for o in objs:
        for c in o.children_recursive:
            c.select_set(True)
    bpy.ops.export_scene.fbx(filepath=path, use_selection=True, apply_scale_options='FBX_SCALE_ALL', object_types={'MESH', 'ARMATURE', 'EMPTY'},
                             add_leaf_bones=False, mesh_smooth_type='FACE', use_tspace=True, bake_anim=animations, bake_anim_use_all_actions=animations, bake_anim_use_nla_strips=False)


def setup_render(size, samples, transparent):
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = samples
    scene.cycles.use_denoising = samples >= 16
    scene.render.resolution_x = scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = transparent
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.view_settings.view_transform = 'Standard'
    world = bpy.data.worlds.new('studio')
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes['Background']
    bg.inputs['Color'].default_value = (0.42, 0.47, 0.55, 1)
    bg.inputs['Strength'].default_value = 0.7


def lights(target, radius):
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 3.2
    sun.data.angle = math.radians(8)
    sun.rotation_euler = (math.radians(50), 0, math.radians(-35))
    bpy.context.scene.collection.objects.link(sun)
    fill = bpy.data.objects.new('fill', bpy.data.lights.new('fill', 'AREA'))
    # Light falls off with the square of the distance: the fill scales with the model.
    fill.data.energy = 40 * (radius * 3.5) ** 2
    fill.data.size = radius * 3
    fill.location = target + Vector((radius * 2.5, radius * 2, radius * 1.5))
    fill.rotation_euler = (math.radians(60), 0, math.radians(130))
    bpy.context.scene.collection.objects.link(fill)


def camera(target, radius, az=-35, el=22, ortho=None):
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    bpy.context.scene.collection.objects.link(cam)
    bpy.context.scene.camera = cam
    d = radius * 3.2
    a, e = math.radians(az), math.radians(el)
    # Front is -Y: the camera sits in front (negative y), turned by az.
    cam.location = target + Vector((math.sin(a) * math.cos(e) * d, -math.cos(a) * math.cos(e) * d, math.sin(e) * d))
    cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
    if ortho:
        cam.data.type = 'ORTHO'
        cam.data.ortho_scale = ortho
    else:
        cam.data.lens = 50
        cam.data.sensor_width = 36
        # Fit: the bounding sphere inside the view.
        fov = 2 * math.atan(18 / 50)
        cam.location = target + (cam.location - target).normalized() * (radius / math.sin(fov / 2) * 1.08)
    cam.data.clip_end = radius * 50
    return cam


def ground(z, radius):
    import bmesh
    from util import material, mesh_object
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=radius * 6)
    g = mesh_object('ground', bm, material('ground', '#9aa0a8', 0.9))
    g.location.z = z
    g['studio_helper'] = True
    return g


def render_preview(path, objs, size=512):
    mn, mx = bounds(objs)
    target = (mn + mx) / 2
    radius = max(0.05, (mx - mn).length / 2)
    setup_render(size, 24, False)
    g = ground(mn.z, radius)
    lights(target, radius)
    cam = camera(target, radius)
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    for o in (g, cam):
        bpy.data.objects.remove(o)


def render_sprites(out_dir, objs, rig, opts):
    """Renders the model from N directions (orthographic, 30 degrees down), every frame of each action asked."""
    n = int(opts.get('directions', 8))
    size = int(opts.get('size', 64))
    frames = int(opts.get('frames', 8))
    actions = [a for a in (opts.get('actions') or []) if a in bpy.data.actions] if rig else []
    setup_render(size, int(opts.get('samples', 12)), True)
    pivot = bpy.data.objects.new('turn', None)
    bpy.context.scene.collection.objects.link(pivot)
    for o in objs + ([rig] if rig else []):
        if o.parent is None:
            o.parent = pivot
    mn, mx = bounds(objs)
    ext = max(mx.x - mn.x, mx.y - mn.y, mx.z - mn.z)
    target = Vector((0, 0, (mn.z + mx.z) / 2))
    lights(target, ext / 2)
    cam = camera(target, ext / 2 + 0.2, az=0, el=float(opts.get('elevation', 30)), ortho=ext * float(opts.get('fit', 1.25)))
    written = []
    jobs = [(a, f) for a in actions for f in range(frames)] if actions else [(None, 0)]
    for d in range(n):
        pivot.rotation_euler = (0, 0, 2 * math.pi * d / n)
        for act, f in jobs:
            if act:
                rig.animation_data.action = bpy.data.actions[act]
                start, end = bpy.data.actions[act].frame_range
                span = end - start if act != 'jump' else end - start + 1
                bpy.context.scene.frame_set(int(round(start + span * f / frames)))
            path = os.path.join(out_dir, 'sprites', f"{act or 'static'}_d{d}_f{f}.png")
            bpy.context.scene.render.filepath = path
            bpy.ops.render.render(write_still=True)
            written.append({'file': path, 'direction': d, 'action': act or 'static', 'frame': f})
    bpy.data.objects.remove(cam)
    return {'directions': n, 'size': size, 'frames': frames if actions else 1, 'actions': actions or ['static'], 'files': written}


def make_lods(name, obj, ratios, out_dir):
    out = []
    for i, r in enumerate(ratios, 1):
        dup = obj.copy()
        dup.data = obj.data.copy()
        bpy.context.scene.collection.objects.link(dup)
        mod = dup.modifiers.new('lod', 'DECIMATE')
        mod.ratio = max(0.01, min(1.0, float(r)))
        select_only([dup])
        bpy.ops.object.modifier_apply(modifier='lod')
        path = os.path.join(out_dir, f'{name}_lod{i}.glb')
        export_glb(path, [dup])
        out.append({'file': path, 'ratio': r, 'triangles': triangles([dup])})
        bpy.data.objects.remove(dup)
    return out


def bake_maps(name, obj, out_dir, size=512):
    """AO and a normal map from a smoothed, subdivided copy onto the model's own UVs (made unique first)."""
    smart_uv(obj)
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 16
    high = obj.copy()
    high.data = obj.data.copy()
    scene.collection.objects.link(high)
    sub = high.modifiers.new('sub', 'SUBSURF')
    sub.levels = sub.render_levels = 2
    files = {}
    for label, kind in (('normal', 'NORMAL'), ('ao', 'AO')):
        img = bpy.data.images.new(f'{name}_{label}', size, size)
        img.colorspace_settings.name = 'Non-Color'
        nodes = []
        for m in obj.data.materials:
            n = m.node_tree.nodes.new('ShaderNodeTexImage')
            n.image = img
            m.node_tree.nodes.active = n
            nodes.append((m, n))
        if kind == 'NORMAL':
            select_only([high, obj])
            bpy.context.view_layer.objects.active = obj
            bpy.ops.object.bake(type='NORMAL', use_selected_to_active=True, cage_extrusion=0.02, margin=4)
        else:
            select_only([obj])
            bpy.ops.object.bake(type='AO', margin=4)
        path = os.path.join(out_dir, f'{name}_{label}.png')
        img.filepath_raw = path
        img.file_format = 'PNG'
        img.save()
        files[label] = path
        for m, n in nodes:
            m.node_tree.nodes.remove(n)
    bpy.data.objects.remove(high)
    # The baked normal map goes onto the materials for the _baked.glb.
    img = bpy.data.images.load(files['normal'])
    img.colorspace_settings.name = 'Non-Color'
    for m in obj.data.materials:
        nt = m.node_tree
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = img
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nt.links.new(t.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], nt.nodes['Principled BSDF'].inputs['Normal'])
    path = os.path.join(out_dir, f'{name}_baked.glb')
    export_glb(path, [obj])
    files['glb'] = path
    return files


def import_model(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in ('.glb', '.gltf'):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == '.fbx':
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext == '.obj':
        bpy.ops.wm.obj_import(filepath=path)
    else:
        raise RuntimeError(f'cannot import {ext}: glb, gltf, fbx or obj')


def cleanup(job):
    """An outside model (a text-to-3D draft, a download): one mesh, transforms applied, doubles merged,
    normals outward, scaled to targetHeight, origin at the base, decimated to maxTriangles, UVs."""
    import_model(job['import'])
    ms = meshes()
    if not ms:
        raise RuntimeError('the file has no meshes')
    for o in ms:
        o.parent = None
    for o in [o for o in bpy.context.scene.objects if o.type not in ('MESH',)]:
        bpy.data.objects.remove(o)
    obj = join(ms, job.get('name', 'model')) if len(ms) > 1 else ms[0]
    apply_transforms(obj)
    select_only([obj])
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.remove_doubles(threshold=0.0001)
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.mesh.delete_loose()
    bpy.ops.object.mode_set(mode='OBJECT')
    mn, mx = bounds([obj])
    h = mx.z - mn.z
    want = job.get('targetHeight')
    if want and h > 0:
        k = float(want) / h
        obj.scale = (k, k, k)
        apply_transforms(obj)
    origin_to_base(obj)
    tri = triangles([obj])
    cap = int(job.get('maxTriangles') or 0)
    if cap and tri > cap:
        mod = obj.modifiers.new('cap', 'DECIMATE')
        mod.ratio = cap / tri * 0.98
        select_only([obj])
        bpy.ops.object.modifier_apply(modifier='cap')
    ensure_uvs(obj)
    obj.name = job.get('name', 'model')
    return [obj], {'importedTriangles': tri}


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    job = json.load(open(argv[0], encoding='utf8'))
    out = job['out']
    os.makedirs(out, exist_ok=True)
    name = job.get('name') or job.get('generator') or 'model'
    report = {'name': name, 'files': [], 'warnings': []}
    t0 = time.time()
    reset_scene()
    gen = job.get('generator')
    rig = None
    extra = {}
    if job.get('import'):
        objs, extra = cleanup(job)
    elif gen == 'material':
        objs, files, info = gen_material.bake(job.get('params', {}), job.get('seed', 1), out, name)
        report['textures'] = files
        report['material'] = info
    else:
        if gen not in GENERATORS:
            raise RuntimeError(f'unknown generator {gen}: one of {", ".join(sorted(list(GENERATORS) + ["material"]))}')
        objs = GENERATORS[gen](job.get('params', {}), int(job.get('seed', 1)))
        rig = next((o for o in objs if o.type == 'ARMATURE'), None)
        mesh_objs = [o for o in objs if o.type == 'MESH']
        if gen in SEPARATE:
            pass
        elif gen in KEEP_PARTS:
            for o in mesh_objs:
                ensure_uvs(o)
        else:
            one = join(mesh_objs, name) if len(mesh_objs) > 1 else mesh_objs[0]
            one.name = name
            origin_to_base(one)
            objs = [one]
    mesh_objs = [o for o in objs if o.type == 'MESH']
    for o in mesh_objs:
        ensure_uvs(o)
    animated = rig is not None
    export_roots = ([rig] if rig else []) + [o for o in mesh_objs if o.parent is None]
    if gen in SEPARATE:
        # One file per piece, its origin where the generator put it (on the grid).
        report['pieces'] = []
        for o in mesh_objs:
            p = os.path.join(out, f"{o.get('studio_piece', o.name)}.glb")
            export_glb(p, [o])
            mn, mx = bounds([o])
            report['pieces'].append({'file': p, 'piece': o.get('studio_piece', o.name), 'triangles': triangles([o]), 'size': [round(v, 3) for v in (mx - mn)]})
            report['files'].append(p)
        # For the preview, the pieces on a grid, four to a row.
        step = max(max((bounds([o])[1] - bounds([o])[0])[:2]) for o in mesh_objs) + 0.8
        for i, o in enumerate(mesh_objs):
            o.location.x += (i % 4) * step
            o.location.y += (i // 4) * step
        bpy.context.view_layer.update()
    else:
        glb = os.path.join(out, f'{name}.glb')
        export_glb(glb, export_roots, animations=animated)
        report['files'].append(glb)
        if job.get('fbx'):
            fbx = os.path.join(out, f'{name}.fbx')
            export_fbx(fbx, export_roots, animations=animated)
            report['files'].append(fbx)
    mn, mx = bounds(mesh_objs)
    report.update({
        'triangles': triangles(mesh_objs), 'size': [round(v, 3) for v in (mx - mn)], 'materials': sorted({m.name for o in mesh_objs for m in o.data.materials if m}),
        'objects': [o.name for o in mesh_objs], 'bones': len(rig.data.bones) if rig else 0,
        'actions': [a.name for a in bpy.data.actions] if rig else [], **extra,
    })
    if job.get('lods') and len(mesh_objs) == 1 and gen not in SEPARATE and not rig:
        report['lods'] = make_lods(name, mesh_objs[0], job['lods'], out)
    if job.get('bake') and len(mesh_objs) == 1 and not rig:
        try:
            report['baked'] = bake_maps(name, mesh_objs[0], out, int(job.get('bakeSize', 512)))
        except Exception as e:  # a bake that fails is reported, the model still stands
            report['warnings'].append(f'bake failed: {e}')
    if job.get('preview', True):
        p = os.path.join(out, 'preview.png')
        if rig:
            bpy.context.scene.frame_set(1)
        render_preview(p, mesh_objs, int(job.get('previewSize', 512)))
        report['preview'] = p
    if job.get('sprites'):
        for o in [o for o in bpy.context.scene.objects if o.get('studio_helper') or o.type in ('LIGHT', 'CAMERA')]:
            bpy.data.objects.remove(o)
        report['sprites'] = render_sprites(out, mesh_objs, rig, job['sprites'])
    report['seconds'] = round(time.time() - t0, 1)
    json.dump(report, open(os.path.join(out, 'report.json'), 'w', encoding='utf8'), indent=1)
    log('DONE', json.dumps({k: report[k] for k in ('triangles', 'size', 'seconds')}))


try:
    main()
except Exception:
    traceback.print_exc()
    sys.exit(1)
